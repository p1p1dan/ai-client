/**
 * Decision 173 (GitHub issue #9), D: DSH's anonymous install id, which the
 * request tap hashes into the `device_id` of `metadata.user_id`
 * (`deviceIdFrom` in sessionMetadata.ts).
 *
 * The same file DSH's own telemetry, feedback and DeepSeek routes use
 * (`@deepseek-ai/dsh-anonymous-user-id`, which the host does not depend on):
 * `.anonymous-user-id` in the DSH home, a random UUID and a line feed, read
 * when it holds a UUID once trimmed, else written. A first write never
 * replaces a file (`wx`): when two processes race, the loser takes the
 * winner's id. When the file is there but holds no UUID, or cannot be
 * written, it is written over as best it can be, and the new id serves this
 * process either way. Unlike DSH's, a file made here is readable by its owner
 * only.
 *
 * The DSH home is found as `@deepseek-ai/dsh-home-paths`' `resolveDshHome`
 * finds it with no configured path: `$DSH_HOME` unless blank, else `~/.dsh`; a
 * leading `~` expanded; made absolute. The host always runs with the
 * `DSH_HOME` Main sets (`<app state>/dsh-home`).
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The file in the DSH home (`ANONYMOUS_USER_ID_FILE_NAME`). */
export const ANONYMOUS_ID_FILE = '.anonymous-user-id';

/** DSH's own pattern: any letter case. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `~`, `~/x` or `~\x` against the OS home (`expandHomePath`); anything else as it is. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/** The DSH home `env` names, as `resolveDshHome(undefined, env)` resolves it. */
export function dshHomeFrom(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.DSH_HOME;
  const chosen =
    fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh');
  return resolve(expandHome(chosen));
}

/** The file system calls made here; tests stand in for them. */
export interface AnonymousIdFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag?: string; mode?: number }
  ): void;
  mkdirSync(path: string, options: { recursive: true; mode?: number }): unknown;
}

const nodeFs: AnonymousIdFs = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

export interface AnonymousIdOptions {
  fs?: AnonymousIdFs;
  randomUUID?: () => string;
}

/** The id the file holds, trimmed; undefined when it is missing, unreadable or no UUID. */
function readPersisted(fs: AnonymousIdFs, file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const value = text.trim();
  return UUID_PATTERN.test(value) ? value : undefined;
}

/** The anonymous install id of the DSH home `home`, made and saved on first use. */
export function readOrCreateAnonymousId(home: string, options: AnonymousIdOptions = {}): string {
  const fs = options.fs ?? nodeFs;
  const file = join(home, ANONYMOUS_ID_FILE);
  const persisted = readPersisted(fs, file);
  if (persisted !== undefined) return persisted;
  const created = (options.randomUUID ?? randomUUID)();
  try {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return created;
  } catch {
    // Another process wrote it first: take its id.
    const winner = readPersisted(fs, file);
    if (winner !== undefined) return winner;
    try {
      fs.writeFileSync(file, `${created}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Not saved: this process still has an id.
    }
    return created;
  }
}
