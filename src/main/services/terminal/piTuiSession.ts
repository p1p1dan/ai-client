/**
 * Session-file ownership for the embedded Pi TUI (Q17).
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
