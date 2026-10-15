/**
 * The gateway key never reaches disk: every text the harness persists goes
 * through `redact`, and `scanForSecrets` proves it afterwards over a whole
 * directory (the T1 study's closing check, made mechanical).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const REDACTED = '[REDACTED]';

export type Redactor = (text: string) => string;

/** Replaces every secret (and its URL-encoded form) in a text. */
export function makeRedactor(secrets: readonly string[]): Redactor {
  const needles = [
    ...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret)])),
  ].filter((needle) => needle.length >= 6);
  return (text) => {
    let out = text;
    for (const needle of needles) out = out.split(needle).join(REDACTED);
    return out;
  };
}

/** Files under `dir` whose bytes contain any secret. Unreadable entries are skipped. */
export function scanForSecrets(dir: string, secrets: readonly string[]): string[] {
  const needles = secrets.filter((secret) => secret.length >= 6).map((s) => Buffer.from(s));
  const hits: string[] = [];
  const walk = (current: string) => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(path);
        continue;
      }
      try {
        const bytes = readFileSync(path);
        if (needles.some((needle) => bytes.includes(needle))) hits.push(path);
      } catch {
        // Locked or vanished; nothing to scan.
      }
    }
  };
  walk(dir);
  return hits;
}
