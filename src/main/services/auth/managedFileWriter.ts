/**
 * D47 S2a §1/§2 — the single write path for every managed claude-home JSON
 * file (`settings.json`, `.claude.json`). Generalizes S1's
 * `CredentialVault` write shape (per-path serialized queue + read-latest +
 * atomic tmp-rename + explicit `chmod 0600`) into a reusable primitive so
 * every settings.json/.claude.json writer in this slice (`claudeHome.ts`
 * generators, `McpManager`, `PluginsManager`, `PromptsManager`,
 * `ClaudeRuntimeConfig`) goes through the same read-modify-write cycle
 * instead of racing each other with independent `readFileSync`/`writeFileSync`
 * pairs.
 *
 * Pure module: zero `electron` import. Every root is passed in by the caller.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type JsonRecord = Record<string, unknown>;

/**
 * Receives the freshly-read on-disk JSON (or `{}` when the file is absent
 * OR was corrupt — see `writeSettingsFile` below) and returns the full next
 * content to write. Mutators are responsible for preserving whatever keys
 * they don't own (spread `current` first), which is what keeps concurrent
 * writers from stomping each other's sentinels.
 */
export type SettingsMutator = (current: JsonRecord) => JsonRecord;

/** Per-absolute-path serialization — a Promise chain, not a lock file (mirrors `CredentialVault.writeQueue`). */
const writeQueues = new Map<string, Promise<unknown>>();

/** Random-enough, mockable (via `Math.random`) tmp-file suffix. */
function randomTmpSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

type ReadOutcome = { kind: 'ok'; value: JsonRecord } | { kind: 'corrupt'; raw: string };

function readJsonRecord(path: string): ReadOutcome {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // Absent (or unreadable) — treated as "start fresh", same as a corrupt
    // file: the mutator is handed `{}` and is expected to produce whatever
    // shape a brand-new managed file should have.
    return { kind: 'ok', value: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'ok', value: parsed as JsonRecord };
    }
    return { kind: 'corrupt', raw };
  } catch {
    return { kind: 'corrupt', raw };
  }
}

function backupCorruptFile(path: string, raw: string): void {
  try {
    const backupPath = `${path}.corrupt-${Date.now()}`;
    writeFileSync(backupPath, raw, 'utf-8');
    console.warn(
      `[managedFileWriter] corrupt JSON at ${path}; backed up to ${backupPath} and rebuilding a minimal managed file`
    );
  } catch (error) {
    console.warn(`[managedFileWriter] failed to back up corrupt file at ${path}:`, error);
  }
}

/** `writeFileSync`'s `mode` option only applies on file CREATION — a stale tmp left by a crashed prior write would silently keep its old permissions without this explicit chmod (mirrors `CredentialVault`, S1 A-track B5). */
function writeJsonAtomic(path: string, value: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });

  const tmpPath = `${path}.${process.pid}.${randomTmpSuffix()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  writeFileSync(tmpPath, serialized, { encoding: 'utf-8' });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function writeSettingsFileInternal(path: string, mutator: SettingsMutator): void {
  const outcome = readJsonRecord(path);
  let current: JsonRecord;
  if (outcome.kind === 'ok') {
    current = outcome.value;
  } else {
    // Corrupt JSON: back up the original bytes, then rebuild from `{}` — the
    // only scenario where foreign keys are allowed to be lost (D47 S2a §2).
    backupCorruptFile(path, outcome.raw);
    current = {};
  }

  const next = mutator(current);
  writeJsonAtomic(path, next);
}

/**
 * The only write path for managed-home JSON files (D47 S2a §1). Serializes
 * concurrent calls for the SAME path through a per-path Promise queue: each
 * queued task re-reads the file from disk when its turn comes (not a value
 * captured at enqueue time), so a task that runs after an earlier one
 * commits sees that earlier write rather than a stale snapshot — this is
 * what keeps a concurrent generator-write + hook-write from losing either
 * side's sentinel (D47 S2a spec §3-1 "并发交错").
 */
export function writeSettingsFile(path: string, mutator: SettingsMutator): Promise<void> {
  const key = resolve(path);
  const previous = writeQueues.get(key) ?? Promise.resolve();

  const task = previous.then(
    () => writeSettingsFileInternal(key, mutator),
    () => writeSettingsFileInternal(key, mutator)
  );

  // Chain-continuation for queue bookkeeping only — never reject, or every
  // later write to this path would join a permanently-rejected chain. The
  // real error (if any) is on the `task` promise this function returns.
  writeQueues.set(
    key,
    task.then(
      () => undefined,
      () => undefined
    )
  );

  return task;
}

/** Test-only: drop queued state between test cases (mirrors `resetAuthSingletonsForTests`). */
export function resetManagedFileWriterQueuesForTests(): void {
  writeQueues.clear();
}
