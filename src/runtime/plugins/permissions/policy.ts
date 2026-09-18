import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { AICLIENT_DEFAULT_PERMISSION_POLICY } from '../../../agent-host/permissionPolicy.mjs';
import {
  isJsonObject,
  mergePermissionScopes,
  type PermissionAction,
  type PermissionEntry,
  type PiPermissionConfig,
  type PolicyScope,
  parsePermissionConfig,
} from '../../../shared/piPermissionPolicy.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import { resolveSettingSources, type SettingSource } from '../../settingSources.ts';

export interface RuntimePermissionPolicy {
  config: PiPermissionConfig;
  sources: readonly string[];
  notes: readonly string[];
}

/**
 * decision 008 — the bundled policy is always the base scope.
 *
 * Two halves of clause 3, and only one of them is implemented here. "Always
 * loaded, whatever `settingSources` says" is: the scope below is built before
 * the switch is consulted at all. "Highest priority" is NOT, because
 * `mergePermissionScopes` is last-wins and the shipped policy documents the
 * opposite order in as many words — `agent-host/permissionPolicy.mjs` says
 * "随包默认 < 用户 / 受管 agentDir 配置 < 项目 .pi 配置" and "the user always
 * wins", which is D-Q9 from 2026-08-29. Moving `bundled` to the end would let
 * the shipped table delete every rule a user wrote, which is a different
 * product, not a merge-order tweak. What is genuinely un-overridable already
 * exists and is not a config file at all: `pathPolicy` in `permissions/index.ts`
 * denies secrets before any scope is consulted.
 */
export async function loadPermissionPolicy(
  io: RuntimeHostIoService,
  options: {
    cwd: string;
    agentDir?: string | null;
    projectTrusted?: boolean;
    settingSources?: readonly SettingSource[];
  }
): Promise<RuntimePermissionPolicy> {
  const scopes: PolicyScope[] = [
    {
      id: 'bundled',
      path: 'bundled',
      present: true,
      config: parsePermissionConfig(AICLIENT_DEFAULT_PERMISSION_POLICY).config,
    },
  ];
  const sources: string[] = [];
  const notes: string[] = [];
  const enabled = resolveSettingSources(options);
  const locations: Array<{ id: 'global' | 'project'; path: string }> = [];
  if (options.agentDir && enabled.user)
    locations.push(
      { id: 'global', path: join(options.agentDir, 'pi-permissions.jsonc') },
      { id: 'global', path: join(options.agentDir, 'extensions/pi-permission-system/config.json') }
    );
  if (enabled.project)
    locations.push(
      { id: 'project', path: join(options.cwd, '.pi/agent/pi-permissions.jsonc') },
      { id: 'project', path: join(options.cwd, '.pi/extensions/pi-permission-system/config.json') }
    );
  // decision 008 — the local tier, after project so it wins on a shared key.
  // Carries `id: 'project'` rather than an id of its own: `PolicyScopeId` is
  // also the key type of the settings panel's `Record<PolicyScopeId, …>` label
  // tables in the renderer, so widening it here would break an exhaustive map
  // in a surface this task must not touch. The distinct `path` is what shows up
  // in `sources` and the trace, which is where provenance is actually read.
  if (enabled.local)
    locations.push({
      id: 'project',
      path: join(options.cwd, '.pi/agent/pi-permissions.local.jsonc'),
    });
  for (const location of locations) {
    let text: string;
    try {
      const read = await io.readFile(location.path, { maxBytes: 1024 * 1024, overflow: 'error' });
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    let raw: unknown;
    try {
      // Preserve quoted URLs and escaped quotes while removing JSONC comments.
      raw = JSON.parse(
        text.replace(
          /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
          (match, string: string | undefined) => string ?? match.replace(/[^\r\n]/g, ' ')
        )
      );
    } catch (cause) {
      throw new RuntimeHostError(
        'permission_policy_invalid',
        `Invalid policy JSON: ${location.path}`,
        { cause }
      );
    }
    if (isJsonObject(raw) && isJsonObject(raw.permission)) {
      for (const entry of Object.values(raw.permission)) {
        if (!isJsonObject(entry)) continue;
        for (const [pattern, action] of Object.entries(entry)) {
          if (isJsonObject(action) && action.action === 'deny') entry[pattern] = 'deny';
        }
      }
    }
    const { config, issues } = parsePermissionConfig(raw);
    if (issues.length)
      throw new RuntimeHostError(
        'permission_policy_invalid',
        `${location.path}: ${issues.join('; ')}`
      );
    if (config.yoloMode)
      notes.push(`${location.path}: yoloMode is superseded by the D14 permission gear`);
    scopes.push({ ...location, present: true, config });
    sources.push(location.path);
  }
  return { config: mergePermissionScopes(scopes), sources, notes };
}

/**
 * Compiled patterns, keyed by the pattern and the two things its translation
 * depends on (tools-20).
 *
 * The compilation is pure — same pattern, same regex — but it was being redone
 * for every rule of every surface on every call, which a recursive search makes
 * a hot loop: one `glob` over a 19 000-file tree rebuilt these tens of
 * thousands of times and spent most of its wall clock here. The cache changes
 * no decision; `~` is part of the key because `homedir()` is read at
 * translation time and a test may point HOME somewhere else mid-process.
 */
const EXPRESSIONS = new Map<string, RegExp>();
/** Enough for any policy table; cleared rather than evicted, since a miss only costs one compile. */
const EXPRESSION_CACHE_LIMIT = 4096;
function matcher(pattern: string, path: boolean): RegExp {
  const home = pattern.startsWith('~') ? homedir() : '';
  const key = `${path ? 'p' : 'c'}\u0000${home}\u0000${pattern}`;
  const cached = EXPRESSIONS.get(key);
  if (cached) return cached;
  if (pattern === '~' || pattern.startsWith('~/')) pattern = `${home}${pattern.slice(1)}`;
  if (path) pattern = pattern.replaceAll('\\', '/');
  let expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\?', '.'))
    .join('.*');
  if (expression.endsWith(' .*')) expression = `${expression.slice(0, -3)}( .*)?`;
  const compiled = new RegExp(`^${expression}$`, path && process.platform === 'win32' ? 'si' : 's');
  if (EXPRESSIONS.size >= EXPRESSION_CACHE_LIMIT) EXPRESSIONS.clear();
  EXPRESSIONS.set(key, compiled);
  return compiled;
}
// Same wildcard vocabulary as the old engine: * / ?, last matching pattern,
// and a trailing " *" also matches the bare command. Path matching folds Windows separators.
function matches(pattern: string, value: string, path: boolean): boolean {
  // No `g` or `y` flag, so the shared regex carries no lastIndex between calls.
  return matcher(pattern, path).test(path ? value.replaceAll('\\', '/') : value);
}
/**
 * `Object.entries` of a policy table, kept rather than rebuilt (tools-20).
 *
 * A policy object is immutable once merged, and the rule order is what decides
 * the outcome, so listing it once and reusing the list is the same evaluation
 * with one fewer array allocated per call — and a recursive search makes that
 * call per file walked. Weak, so a reconfigured session's old table is still
 * collected.
 */
const ENTRIES = new WeakMap<object, readonly (readonly [string, unknown])[]>();
function entriesOf<T>(table: object): readonly (readonly [string, T])[] {
  let listed = ENTRIES.get(table);
  if (!listed) {
    listed = Object.entries(table);
    ENTRIES.set(table, listed);
  }
  return listed as readonly (readonly [string, T])[];
}
function matchEntry(
  entry: PermissionEntry,
  values: readonly string[],
  path: boolean
): PermissionAction | undefined {
  if (typeof entry === 'string') return entry;
  let action: PermissionAction | undefined;
  for (const [pattern, rule] of entriesOf<PermissionAction>(entry))
    if (values.some((value) => matches(pattern, value, path))) action = rule;
  return action;
}
/** Surfaces whose values are paths rather than command lines or server names. */
const PATH_SURFACES = new Set([
  'path',
  'external_directory',
  'read',
  'write',
  'edit',
  'find',
  'grep',
]);
export function policyAction(
  policy: RuntimePermissionPolicy,
  surface: string,
  values: readonly string[],
  cwd: string
): PermissionAction {
  if (surface === 'glob') surface = 'find';
  const path = PATH_SURFACES.has(surface);
  const candidates = path
    ? values.flatMap((value) => [value, relative(cwd, resolve(value)), basename(value)])
    : values;
  let action: PermissionAction = 'ask';
  const permission = policy.config.permission;
  if (!permission) return action;
  for (const [name, entry] of entriesOf<PermissionEntry>(permission)) {
    if (matches(name, surface, false)) action = matchEntry(entry, candidates, path) ?? action;
  }
  return action;
}
