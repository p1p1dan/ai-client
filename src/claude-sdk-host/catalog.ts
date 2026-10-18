/**
 * dsh-rebase decision 194 Q1 (user, 2026-10-18: A): the slash menu of a folder no SDK chat
 * runs in yet — the home page with an Anthropic-protocol model, a chat not started. Main
 * starts this host in catalog mode (`AICLIENT_CLAUDE_SDK_CATALOG_CWD`), which starts the
 * CLI as a chat's would, asks it for its commands (`initializationResult`), answers Main
 * and exits. Nothing is sent: no model request, no session.
 *
 * Measured on CLI 2.1.300 (`tools/slash-inventory.ts`): starting the CLI runs the project's
 * SessionStart hooks even with no message; `disableAllHooks` in the flag tier stops that
 * and leaves the list as it was. A trusted project's plugin marketplaces are fetched as
 * they are for a chat (ruling 18); the plugins they bring are listed from the CLI's second
 * start on.
 */

import { homedir } from 'node:os';
import { type Options, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerCommandsResult } from '../shared/types/workerRpc.ts';
import { isUserHomeDir, launchSettingSources, type SdkHostConfig } from './sdkSessionRuntime.ts';
import { cliSlashCommands, sdkSlashCommandRows } from './slashCommands.ts';

/** The IPC message a catalog host sends Main, once. */
export const CLAUDE_SDK_CATALOG_RESULT = 'claude-sdk.catalog';

export interface ClaudeSdkCatalogResult {
  type: typeof CLAUDE_SDK_CATALOG_RESULT;
  ok: boolean;
  result?: WorkerCommandsResult;
  error?: string;
  ms: number;
}

export interface CatalogInput {
  /** The folder whose project layer counts; its project layer only when `projectTrusted`. */
  cwd: string;
  projectTrusted: boolean;
  configDir: string;
  settingSources: SdkHostConfig['settingSources'];
  /** The CLI's environment (`buildCliEnvironment`); no request is made with it. */
  cliEnv: Record<string, string>;
  cliPath?: string;
  timeoutMs: number;
}

/** The CLI's own options for a listing: a chat's, less everything a turn needs, hooks off. */
export function catalogOptions(input: CatalogInput): Options {
  const projectTrusted = input.projectTrusted && !isUserHomeDir(input.cwd, [homedir()]);
  return {
    cwd: input.cwd,
    env: input.cliEnv,
    settings: { disableAllHooks: true, attribution: false } as Options['settings'],
    settingSources: launchSettingSources(input.settingSources, projectTrusted),
    ...(projectTrusted
      ? ({ workspaceTrust: { accepted: true, directory: input.cwd } } as Partial<Options>)
      : {}),
    strictMcpConfig: true,
    permissionMode: 'default',
    ...(input.cliPath
      ? { pathToClaudeCodeExecutable: input.cliPath, executable: process.execPath as 'node' }
      : {}),
  };
}

/** Start the CLI, read its list, close it. Rejects on a CLI that does not answer in time. */
export async function listCliCommands(
  input: CatalogInput,
  log: (...args: unknown[]) => void
): Promise<WorkerCommandsResult> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Streaming input that ends without a message once the listing is read: the CLI
  // initializes and waits until then.
  const nothing: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => held.then(() => ({ done: true as const, value: undefined })),
    }),
  };
  const q = query({
    prompt: nothing,
    options: { ...catalogOptions(input), stderr: (line: string) => log('[cli]', line.trimEnd()) },
  });
  const drained = (async () => {
    try {
      for await (const _message of q) {
        // A listing reads no message.
      }
    } catch (error) {
      log('catalog CLI ended with an error', error);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timeout: the CLI did not list its commands')),
          input.timeoutMs
        );
      }),
    ]);
    return sdkSlashCommandRows(
      cliSlashCommands((init as { commands?: unknown } | undefined)?.commands)
    );
  } finally {
    clearTimeout(timer);
    release();
    try {
      q.close();
    } catch (error) {
      log('catalog CLI close failed', error);
    }
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
}
