/**
 * The Claude Code release this app pins every install it performs to.
 *
 * ⚠️ Still live, and still resting on the same assumption the retired
 * `bun-incompatible` banner rested on: that 2.1.113+ ships as a Bun binary
 * outside the TEC OCular Agent whitelist. `AgentInstaller` installs THIS
 * version, so if the assumption has expired, every install we perform is
 * an outdated CLI — a bigger problem than the banner that was retired, and a
 * separate decision because unpinning could break the locked-down machine
 * nobody here can test against.
 */
export const LAST_NODE_CLAUDE_VERSION = '2.1.112';

/**
 * `bun-incompatible` retired 2026-08-26 (user decision): the version-threshold
 * detection behind it was stale — newer Claude Code builds bundle Node again —
 * and a banner that fires on a rule nobody has re-checked is worse than no
 * banner. Nothing replaced it: the ruling was "retire, no detection".
 *
 * `node-compatible` went with it, renamed to `installed`. With the
 * classification gone we no longer know which runtime a CLI is, and keeping a
 * name that claims we do would have been the same stale assertion wearing a
 * different label — including on a user's own pre-existing Bun install, which
 * we would have gone on calling node-compatible.
 */
export type ClaudeRuntimeKind =
  | 'not-installed'
  | 'vscode-extension-only'
  | 'installed'
  | 'detection-failed';

export interface VsCodeExtensionInfo {
  path: string;
  version: string;
}

export interface ClaudeRuntimeStatus {
  kind: ClaudeRuntimeKind;
  cliVersion?: string;
  vscodeExtension?: VsCodeExtensionInfo;
  // Populated only when `kind === 'detection-failed'`. Surfaces the underlying
  // probe error so the renderer can show it instead of silently treating the
  // user as "not installed".
  error?: string;
}
