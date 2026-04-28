export const LAST_NODE_CLAUDE_VERSION = '2.1.112';

export type ClaudeRuntimeKind =
  | 'not-installed'
  | 'vscode-extension-only'
  | 'node-compatible'
  | 'bun-incompatible';

export interface VsCodeExtensionInfo {
  path: string;
  version: string;
}

export interface ClaudeRuntimeStatus {
  kind: ClaudeRuntimeKind;
  cliVersion?: string;
  vscodeExtension?: VsCodeExtensionInfo;
}
