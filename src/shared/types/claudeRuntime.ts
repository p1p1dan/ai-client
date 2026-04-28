export const LAST_NODE_CLAUDE_VERSION = '2.1.112';

export type ClaudeRuntimeKind =
  | 'not-installed'
  | 'vscode-extension-only'
  | 'node-compatible'
  | 'bun-incompatible'
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
