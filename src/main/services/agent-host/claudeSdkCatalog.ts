import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  isWorkerCommandsResult,
  sanitizeWorkerCommandRows,
  type WorkerCommandsResult,
} from '@shared/types/workerRpc';
import { claudeSdkHostLaunch } from './claudeSdkEngine';

/**
 * dsh-rebase decision 194 Q1 (user, 2026-10-18: A): the slash menu of a Claude Agent SDK
 * chat before it runs — the home page with an Anthropic-protocol model, a chat not started.
 * The CLI is the one that knows its commands (its own, the user layer's, the project's,
 * the plugins'), so Main asks one: an SDK host in catalog mode (`src/claude-sdk-host/
 * catalog.ts`) lists them with every hook off and exits. About 0.6 s warm, a few seconds
 * cold (measured, dev box), and about 250 MB while it runs.
 *
 * Kept per folder: a menu shows the last list at once and a listing older than
 * `freshMs` is redone behind it, so a skill installed since shows on the next opening.
 * One listing per folder at a time.
 */

/** The IPC message type of `src/claude-sdk-host/catalog.ts` (not imported: the host is not bundled into Main). */
const CATALOG_RESULT = 'claude-sdk.catalog';

/** A catalog host that has not answered in this long is killed (its own CLI wait is 20 s). */
export const CLAUDE_SDK_CATALOG_TIMEOUT_MS = 25_000;

export interface ClaudeSdkCatalogRun {
  /** The folder, or null for no project (the user layer alone). */
  cwd: string | null;
}

/** Start one catalog host and read its answer. Rejects when it fails or does not answer. */
export function runClaudeSdkCatalogHost(
  input: ClaudeSdkCatalogRun,
  log: (message: string) => void = () => {}
): Promise<WorkerCommandsResult> {
  const launch = claudeSdkHostLaunch(0);
  Object.assign(launch.env, {
    // No project: the config dir stands in as the CLI's cwd, untrusted, so only the user
    // layer counts (it has no `.claude` of its own).
    AICLIENT_CLAUDE_SDK_CATALOG_CWD: input.cwd ?? launch.configDir,
    AICLIENT_CLAUDE_SDK_CATALOG_TRUSTED: input.cwd ? '1' : '0',
  });
  return new Promise<WorkerCommandsResult>((resolve, reject) => {
    const child = spawn(launch.node, [launch.entry], {
      cwd: launch.configDir,
      env: launch.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let settled = false;
    const stderr: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr.push(chunk);
      if (stderr.length > 40) stderr.shift();
    });
    const settle = (error: Error | null, result?: WorkerCommandsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        log(`[claude-sdk] catalog failed: ${error.message}\n${stderr.join('').slice(-2000)}`);
        if (child.exitCode === null) child.kill();
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };
    const timer = setTimeout(
      () => settle(new Error('the catalog host did not answer in time')),
      CLAUDE_SDK_CATALOG_TIMEOUT_MS
    );
    timer.unref?.();
    child.on('message', (message: unknown) => {
      const answer = message as { type?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      if (answer?.type !== CATALOG_RESULT) return;
      if (answer.ok === true && isWorkerCommandsResult(answer.result)) {
        settle(null, {
          commands: sanitizeWorkerCommandRows(answer.result.commands),
          truncated: answer.result.truncated === true,
        });
      } else {
        settle(new Error(`the catalog host failed: ${String(answer.error ?? 'no reason given')}`));
      }
    });
    child.on('error', (error) => settle(error));
    child.on('exit', (code) =>
      settle(new Error(`the catalog host exited (${code}) without a list`))
    );
  });
}

interface CatalogEntry {
  result?: WorkerCommandsResult;
  at: number;
  running?: Promise<WorkerCommandsResult>;
}

export interface ClaudeSdkCommandCatalogDeps {
  run: (input: ClaudeSdkCatalogRun) => Promise<WorkerCommandsResult>;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
  platform?: NodeJS.Platform;
}

/** How long a folder's list is shown without being redone behind it. */
export const CLAUDE_SDK_CATALOG_FRESH_MS = 30_000;

export class ClaudeSdkCommandCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly now: () => number;

  constructor(
    private readonly deps: ClaudeSdkCommandCatalogDeps,
    private readonly freshMs: number = CLAUDE_SDK_CATALOG_FRESH_MS
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The folder's menu: the last list at once (redone behind it when older than
   * `freshMs`), else a new listing. A failed first listing answers an empty menu.
   */
  async list(cwd: string | null): Promise<WorkerCommandsResult> {
    const key = this.key(cwd);
    const entry = this.entries.get(key);
    if (entry?.result) {
      if (this.now() - entry.at > this.freshMs && !entry.running) {
        void this.refresh(key, cwd).catch(() => undefined);
      }
      return entry.result;
    }
    try {
      return await (entry?.running ?? this.refresh(key, cwd));
    } catch (error) {
      this.deps.log?.('[slash-menu] the Agent SDK CLI could not list its commands', error);
      return { commands: [], truncated: false };
    }
  }

  private refresh(key: string, cwd: string | null): Promise<WorkerCommandsResult> {
    const entry = this.entries.get(key) ?? { at: 0 };
    this.entries.set(key, entry);
    const running = this.deps.run({ cwd }).then(
      (result) => {
        entry.result = result;
        entry.at = this.now();
        entry.running = undefined;
        return result;
      },
      (error: unknown) => {
        entry.running = undefined;
        throw error;
      }
    );
    entry.running = running;
    return running;
  }

  /** One spelling per folder: Windows folds case and separators. */
  private key(cwd: string | null): string {
    if (cwd === null) return '';
    const resolved = path.resolve(cwd);
    return (this.deps.platform ?? process.platform) === 'win32'
      ? resolved.replace(/\//g, '\\').toLowerCase()
      : resolved;
  }
}
