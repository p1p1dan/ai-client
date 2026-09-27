// Moved from src/runtime/plugins/permissions/index.ts (pathPolicy) (dsh-rebase P1-6a)

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { AICLIENT_DEFAULT_PERMISSION_POLICY } from '../../agent-host/permissionPolicy.mjs';
import type { PermissionAction } from './gate.ts';
import { normalizeWindowsPathForm } from './windowsPaths.ts';

/**
 * Where the path rules are evaluated. Injectable so the Windows spelling rules
 * can be exercised on a Linux box: on a real host both fields already describe
 * the machine the runtime runs on (windows-01).
 */
export interface PathPolicyEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
}

export function pathPolicy(
  path: string,
  environment: PathPolicyEnvironment = {}
): PermissionAction {
  const platform = environment.platform ?? process.platform;
  const windows = platform === 'win32';
  // The rules are written with the target platform's separators and home, so
  // the expansion has to use that platform's path algebra, not the build box's.
  const paths = windows ? win32 : posix;
  const home = environment.home ?? homedir();
  let action: PermissionAction = 'allow';
  // windows-01 — fold `/c/...`, `/cygdrive/c/...` and `\\?\C:\...` onto the
  // native spelling first, or a deny that names a directory is decided on a
  // string the rule cannot match.
  const normalized = normalizeWindowsPathForm(path, platform);
  const candidate = normalized.replaceAll('\\', '/');
  for (const rule of pathPolicyRules(platform, home)) {
    if (
      rule.expression.test(candidate) ||
      (rule.bare && rule.expression.test(paths.basename(normalized)))
    )
      action = rule.action;
  }
  return action;
}
/**
 * The bundled path table, compiled once per (platform, home) pair (tools-20).
 *
 * Same rules, same order, same last-match-wins result; what changes is that a
 * recursive search no longer rebuilds ten regular expressions for every file it
 * walks past. `home` is part of the key because the `~/` patterns expand
 * against it, and a test may point HOME elsewhere mid-process.
 */
interface CompiledPathRule {
  expression: RegExp;
  /** A pattern with no separator also matches a bare file name at any depth. */
  bare: boolean;
  action: PermissionAction;
}
const PATH_RULES = new Map<string, readonly CompiledPathRule[]>();
function pathPolicyRules(platform: NodeJS.Platform, home: string): readonly CompiledPathRule[] {
  const key = `${platform} ${home}`;
  const cached = PATH_RULES.get(key);
  if (cached) return cached;
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  const rules: CompiledPathRule[] = [];
  for (const [pattern, value] of Object.entries(
    AICLIENT_DEFAULT_PERMISSION_POLICY.permission.path
  )) {
    if (value !== 'allow' && value !== 'ask' && value !== 'deny') continue;
    const expanded = pattern.startsWith('~/')
      ? paths.resolve(home, pattern.slice(2)).replaceAll('\\', '/')
      : pattern;
    const expression = expanded
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    rules.push({
      // No `g` or `y` flag, so a shared instance carries no lastIndex.
      expression: new RegExp(`^${expression}$`, windows ? 'i' : ''),
      bare: !expanded.includes('/'),
      action: value,
    });
  }
  PATH_RULES.set(key, rules);
  return rules;
}
