// Moved from src/runtime/plugins/permissions/policy.ts (dsh-rebase P1-6a)

import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import {
  isJsonObject,
  mergePermissionScopes,
  type PermissionAction,
  type PermissionEntry,
  type PiPermissionConfig,
  type PolicyScope,
  parsePermissionConfig,
} from '../piPermissionPolicy.ts';
import { createPermissionError, errorCode, type PermissionErrorFactory } from './errors.ts';
import { AICLIENT_DEFAULT_PERMISSION_POLICY } from './permissionPolicy.mjs';

export interface RuntimePermissionPolicy {
  config: PiPermissionConfig;
  sources: readonly string[];
  notes: readonly string[];
}

/**
 * How the loader reads a policy file; the host's filesystem, injected.
 *
 * A missing file rejects with `code: 'ENOENT'` and is skipped; any other
 * rejection fails the load. The runtime's `RuntimeHostIoService` fits as is.
 */
export interface PermissionPolicyFiles {
  readFile(
    path: string,
    options: { maxBytes: number; overflow: 'error' }
  ): Promise<{ bytes: Uint8Array }>;
}

/**
 * Which on-disk layers the loader may read (decision 008), already resolved:
 * the caller folds `settingSources` and project trust into these three
 * booleans (`resolveSettingSources` in the runtime).
 */
export interface PermissionPolicySources {
  user: boolean;
  project: boolean;
  local: boolean;
}

/** The `path` of the bundled scope: an in-memory table, not a file on disk. */
export const BUNDLED_POLICY_SCOPE_PATH = 'bundled';

/**
 * The bundled scope, built from the shipped policy table in memory.
 *
 * One builder for both readers (dsh-rebase P1-12 step 1, decision 147): the
 * host's loader below and Main's settings page, which used to read the same
 * table back from a `config.json` the native worker artifact carried.
 */
export function bundledPolicyScope(): PolicyScope {
  return {
    id: 'bundled',
    path: BUNDLED_POLICY_SCOPE_PATH,
    present: true,
    config: parsePermissionConfig(AICLIENT_DEFAULT_PERMISSION_POLICY).config,
  };
}

/**
 * decision 008 — the bundled policy is always the base scope.
 *
 * Two halves of clause 3, and only one of them is implemented here. "Always
 * loaded, whatever `settingSources` says" is: the scope below is built before
 * the switch is consulted at all. "Highest priority" is NOT, because
 * `mergePermissionScopes` is last-wins and the shipped policy documents the
 * opposite order in as many words — `permissionPolicy.mjs` says
 * "bundled defaults < user / managed agentDir config < project .pi config" and "the user always
 * wins", which is D-Q9 from 2026-08-29. Moving `bundled` to the end would let
 * the shipped table delete every rule a user wrote, which is a different
 * product, not a merge-order tweak. What is genuinely un-overridable already
 * exists and is not a config file at all: `pathPolicy` in `pathPolicy.ts`
 * denies secrets before any scope is consulted.
 */
export async function loadPermissionPolicy(
  io: PermissionPolicyFiles,
  options: {
    cwd: string;
    agentDir?: string | null;
    sources: PermissionPolicySources;
    createError?: PermissionErrorFactory;
  }
): Promise<RuntimePermissionPolicy> {
  const createError = options.createError ?? createPermissionError;
  const scopes: PolicyScope[] = [bundledPolicyScope()];
  const sources: string[] = [];
  const notes: string[] = [];
  const enabled = options.sources;
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
      throw createError('permission_policy_invalid', `Invalid policy JSON: ${location.path}`, {
        cause,
      });
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
      throw createError('permission_policy_invalid', `${location.path}: ${issues.join('; ')}`);
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
