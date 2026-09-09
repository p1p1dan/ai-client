/**
 * Session-file ownership for the embedded Pi TUI (Q17).
 *
 * Portions adapted from pix. Copyright (c) 2026 Num Scope.
 * See THIRD_PARTY_NOTICES.md for the MIT license text.
 *
 * Ported from pix (`apps/desktop/src/main/pi-tui-session.ts`), which solved the
 * same problem: a terminal opened for a chat session runs `pi --session <file>`
 * on the SAME durable JSONL the GUI worker writes. Two writers on one file is
 * the hazard, so interactive ownership is a lock.
 *
 * One owner, not one per session — GUI and TUI are mutually exclusive here.
 * `presentationMode` is a single app-wide setting, so entering terminal mode
 * takes the whole chat surface with it; there is no state where session A shows
 * a terminal while session B takes GUI prompts. A per-session map would model
 * a situation the UI cannot produce.
 *
 * No PTY or Electron imports: unit-tested without native modules, same as its
 * pix counterpart.
 */

import type { PiTuiSessionSupport } from '@shared/types';

/**
 * Normalize a session path for equality, ownership and dispose lookups.
 *
 * macOS `/var` is a symlink to `/private/var`, and index rows, worker snapshots
 * and `realpath` may disagree about which one they report. pix hit exactly this:
 * the first terminal opened fine and every later switch failed to match the
 * parked PTY, because guard and controller keys had drifted apart.
 */
export function normalizeSessionKey(sessionPath: string): string {
  let p = sessionPath.replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();
  if (!p) return '';
  // Collapse the Apple firmlink prefix so /var/... === /private/var/...
  if (p.startsWith('/private/')) p = p.slice('/private'.length);
  return p;
}

/** True when two session paths name the same JSONL (slash / case / /private drift). */
export function sessionKeysMatch(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return normalizeSessionKey(a) === normalizeSessionKey(b);
}

/**
 * Argv for an interactive Pi TUI.
 *
 * With a session file this is `pi --session <path>` — the same command a user
 * would type in their own terminal to reattach to that conversation. Without
 * one the TUI starts a fresh session, which is what a terminal opened from a
 * repo (rather than from a chat) should do.
 */
export function buildPiTuiArgs(cliPath: string, sessionFile?: string | null): string[] {
  const file = sessionFile?.trim();
  return file ? [cliPath, '--session', file] : [cliPath];
}

/**
 * Interactive ownership of a chat session's JSONL.
 *
 * Held while terminal mode is up. The GUI send path must dispose the terminal
 * and release this before starting a turn — a running TUI otherwise keeps
 * appending to the file the worker is about to write.
 */
export class PiTuiExclusiveGuard {
  #ownerKey: string | null = null;

  ownerKey(): string | null {
    return this.#ownerKey;
  }

  isActive(): boolean {
    return this.#ownerKey !== null;
  }

  owns(sessionKey: string): boolean {
    const key = normalizeSessionKey(sessionKey);
    return key !== '' && this.#ownerKey === key;
  }

  /**
   * Take interactive ownership of `sessionKey`.
   *
   * Deliberately a transfer, not a test-and-set. pix shipped `tryAcquire`-only
   * first and had to change it: once guard and controller keys desynced (macOS
   * firmlink drift, or a suspend/cancel race), the stale owner key refused
   * every later open and the UI could not start any terminal at all. Switching
   * sessions must always be able to take ownership; the writer conflict is
   * prevented by disposing the previous terminal, not by refusing the new one.
   */
  transferTo(sessionKey: string): { ok: true } | { ok: false; reason: string } {
    const key = normalizeSessionKey(sessionKey);
    if (!key) return { ok: false, reason: 'Invalid session key' };
    this.#ownerKey = key;
    return { ok: true };
  }

  release(sessionKey?: string): void {
    if (this.#ownerKey === null) return;
    if (sessionKey === undefined || this.#ownerKey === normalizeSessionKey(sessionKey)) {
      this.#ownerKey = null;
    }
  }

  /**
   * Gate for the GUI send path. Throws while terminal mode owns a session, so a
   * caller that skipped the dispose fails loudly instead of quietly becoming a
   * second writer on the same file.
   */
  assertHostPromptAllowed(): void {
    if (this.#ownerKey === null) return;
    throw new Error(
      'Terminal mode owns this session; close the Pi terminal before sending from the chat view'
    );
  }
}

/**
 * TUI-1: can the bundled `pi` CLI open this chat's JSONL at all?
 *
 * The native runtime writes pi-agent-core's v4 session format
 * (`{"kind":"header","version":4,...}`), but `pi --session <file>` parses with
 * pi-coding-agent's own SessionManager, which requires the first entry to be
 * `{"type":"session",...}` and returns nothing otherwise — the CLI then reports
 * `Session file is not a valid pi session` and the terminal dies on open.
 * Checked on 0.85.1 as well as the pinned 0.84.4: the CLI's session version is
 * still 3, so this is a format boundary between two packages, not a version lag.
 *
 * Until the two formats are reconciled, the honest answer is to refuse at the
 * entry point with the reason rather than let the user walk into the CLI error.
 * Only a POSITIVE v4 identification refuses: an unreadable or unparsable head
 * (an encrypted container, a truncated file) stays allowed, because guessing
 * "unsupported" from a failed read would take the TUI away from sessions that
 * work today.
 */
export const PI_TUI_NATIVE_SESSION_REASON =
  'This chat runs on the native runtime, whose session format the Pi TUI cannot open yet.';

export async function inspectPiTuiSessionSupport(
  sessionFile: string | undefined | null,
  readHead: (file: string) => Promise<string> = readSessionHead
): Promise<PiTuiSessionSupport> {
  const file = sessionFile?.trim();
  // No file means "start a fresh pi session", which never touches our format.
  if (!file) return { supported: true };
  let head: string;
  try {
    head = await readHead(file);
  } catch {
    return { supported: true };
  }
  const firstLine = head.split('\n', 1)[0]?.trim();
  if (!firstLine) return { supported: true };
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return { supported: true };
  }
  const record =
    typeof header === 'object' && header !== null ? (header as Record<string, unknown>) : null;
  if (record?.kind === 'header' && record.version === 4) {
    return { supported: false, reason: PI_TUI_NATIVE_SESSION_REASON };
  }
  return { supported: true };
}

/** First chunk of a session file — enough for the header line, never the whole log. */
async function readSessionHead(file: string): Promise<string> {
  const { open } = await import('node:fs/promises');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
