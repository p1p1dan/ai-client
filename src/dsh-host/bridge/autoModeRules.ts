/**
 * Decision 192 §3.2: the auto-mode rules, read from the bundled Claude CLI
 * (`claude auto-mode defaults`) once per CLI version and cached under
 * `$DSH_HOME`, so a host start only spawns the CLI after an upgrade.
 *
 * Read by the host itself, on the bundled Node, the same carrier that starts
 * the CLI for the SDK engine; the cache is only ever read back by this host.
 * Any failure answers undefined, which the reviewer reports as `unavailable`
 * and the gate turns into its ordinary card.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type AutoModeRules,
  parseAutoModeRules,
} from '../../shared/permissions/autoReview/rules.ts';

const RUN_TIMEOUT_MS = 30_000;
/** After a failed read, the next review tries again no sooner than this. */
const RETRY_AFTER_MS = 60_000;

export type RunCli = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<string>;

export interface AutoModeRulesSourceOptions {
  /** The CLI binary (`claude` / `claude.exe`), or a `.js`/`.mjs` stand-in run on this Node. */
  cli: string;
  /** Where the cache and the CLI's own config directory live. */
  cacheDir: string;
  log?: (...args: unknown[]) => void;
  run?: RunCli;
  now?: () => number;
}

const runCli: RunCli = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

/** The platform package's version beside the binary, else its size and mtime. */
function versionKey(cli: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version) return `v${pkg.version}`;
  } catch {
    // No package.json beside it (a dev override): fall back to the file itself.
  }
  const stat = statSync(cli);
  return `${basename(cli)}-${stat.size}-${Math.trunc(stat.mtimeMs)}`;
}

export class AutoModeRulesSource {
  private readonly options: AutoModeRulesSourceOptions;
  private pending: Promise<AutoModeRules | undefined> | null = null;
  private failedAt: number | null = null;

  constructor(options: AutoModeRulesSourceOptions) {
    this.options = options;
  }

  /** The rules, or undefined when the CLI cannot give them now. */
  rules(): Promise<AutoModeRules | undefined> {
    const now = this.options.now?.() ?? Date.now();
    if (this.failedAt !== null && now - this.failedAt < RETRY_AFTER_MS) {
      return Promise.resolve(undefined);
    }
    if (!this.pending) {
      this.pending = this.load().then((rules) => {
        if (!rules) {
          this.failedAt = this.options.now?.() ?? Date.now();
          this.pending = null;
        }
        return rules;
      });
    }
    return this.pending;
  }

  private async load(): Promise<AutoModeRules | undefined> {
    const { cli, cacheDir } = this.options;
    let key: string;
    try {
      key = versionKey(cli);
    } catch (error) {
      this.options.log?.(`[auto-review] no Claude CLI at ${cli}`, error);
      return undefined;
    }
    const cacheFile = join(cacheDir, `auto-mode-rules-${key.replace(/[^\w.-]/g, '_')}.json`);
    try {
      const cached = parseAutoModeRules(readFileSync(cacheFile, 'utf8'));
      if (cached) return cached;
    } catch {
      // Not cached yet for this version.
    }
    const viaNode = /\.[cm]?js$/i.test(cli);
    let stdout: string;
    try {
      mkdirSync(cacheDir, { recursive: true });
      stdout = await (this.options.run ?? runCli)(
        viaNode ? process.execPath : cli,
        [...(viaNode ? [cli] : []), 'auto-mode', 'defaults'],
        {
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: join(cacheDir, 'claude-config'),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          timeoutMs: RUN_TIMEOUT_MS,
        }
      );
    } catch (error) {
      this.options.log?.(
        '[auto-review] reading the auto-mode rules from the Claude CLI failed',
        error
      );
      return undefined;
    }
    const rules = parseAutoModeRules(stdout);
    if (!rules) {
      this.options.log?.(
        '[auto-review] the Claude CLI printed no auto-mode rules this host can read'
      );
      return undefined;
    }
    try {
      const temp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(temp, stdout, { mode: 0o600 });
      renameSync(temp, cacheFile);
    } catch (error) {
      this.options.log?.('[auto-review] the auto-mode rules were read but not cached', error);
    }
    this.options.log?.(`[auto-review] auto-mode rules read from the Claude CLI (${key})`);
    return rules;
  }
}
