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

export interface RuntimePermissionPolicy {
  config: PiPermissionConfig;
  sources: readonly string[];
  notes: readonly string[];
}

export async function loadPermissionPolicy(
  io: RuntimeHostIoService,
  options: { cwd: string; agentDir?: string | null; projectTrusted?: boolean }
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
  const locations: Array<{ id: 'global' | 'project'; path: string }> = [];
  if (options.agentDir)
    locations.push(
      { id: 'global', path: join(options.agentDir, 'pi-permissions.jsonc') },
      { id: 'global', path: join(options.agentDir, 'extensions/pi-permission-system/config.json') }
    );
  if (options.projectTrusted)
    locations.push(
      { id: 'project', path: join(options.cwd, '.pi/agent/pi-permissions.jsonc') },
      { id: 'project', path: join(options.cwd, '.pi/extensions/pi-permission-system/config.json') }
    );
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

// Same wildcard vocabulary as the old engine: * / ?, last matching pattern,
// and a trailing " *" also matches the bare command. Path matching folds Windows separators.
function matches(pattern: string, value: string, path: boolean): boolean {
  if (pattern === '~' || pattern.startsWith('~/')) pattern = `${homedir()}${pattern.slice(1)}`;
  if (path) {
    pattern = pattern.replaceAll('\\', '/');
    value = value.replaceAll('\\', '/');
  }
  let expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\?', '.'))
    .join('.*');
  if (expression.endsWith(' .*')) expression = `${expression.slice(0, -3)}( .*)?`;
  return new RegExp(`^${expression}$`, path && process.platform === 'win32' ? 'si' : 's').test(
    value
  );
}
function matchEntry(
  entry: PermissionEntry,
  values: readonly string[],
  path: boolean
): PermissionAction | undefined {
  if (typeof entry === 'string') return entry;
  let action: PermissionAction | undefined;
  for (const [pattern, rule] of Object.entries(entry))
    if (values.some((value) => matches(pattern, value, path))) action = rule;
  return action;
}
export function policyAction(
  policy: RuntimePermissionPolicy,
  surface: string,
  values: readonly string[],
  cwd: string
): PermissionAction {
  if (surface === 'glob') surface = 'find';
  const path = ['path', 'external_directory', 'read', 'write', 'edit', 'find', 'grep'].includes(
    surface
  );
  const candidates = path
    ? values.flatMap((value) => [value, relative(cwd, resolve(value)), basename(value)])
    : values;
  let action: PermissionAction = 'ask';
  for (const [name, entry] of Object.entries(policy.config.permission ?? {})) {
    if (matches(name, surface, false)) action = matchEntry(entry, candidates, path) ?? action;
  }
  return action;
}
