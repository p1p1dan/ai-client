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
   * Gate for the GUI write paths. Throws while terminal mode owns a session, so
   * a caller that skipped the dispose fails loudly instead of quietly becoming
   * a second writer on the same file.
   *
   * cutover-04 — scoped to the chat about to be written when a key is given.
   * Ownership is not a statement about the whole app: leaving terminal mode
   * SUSPENDS the terminal rather than disposing it, so a warm terminal keeps
   * chat A's file while the user sends in chat B, and that send is legitimate.
   * "Is any terminal alive" would refuse it; "does a terminal hold the file I
   * am about to write" is the question this gate exists to ask.
   */
  assertHostPromptAllowed(sessionKey?: string): void {
    if (this.#ownerKey === null) return;
    if (sessionKey !== undefined && !this.owns(sessionKey)) return;
    throw new Error(
      'Terminal mode owns this session; close the Pi terminal before sending from the chat view'
    );
  }
}

/**
 * D18 — the sentence shown when a second window asks for a chat a first window
 * already has open in a terminal.
 *
 * An English sentence used as a DICTIONARY KEY (`zhTranslations` in
 * `@shared/i18n`), the way the other cross-process reasons here are: Main has
 * no translator, and the renderer that displays it does.
 */
export const PI_TUI_SESSION_BUSY_REASON =
  'This chat is already open in a terminal in another window';

export type PiTuiSessionClaim = { ok: true } | { ok: false; reason: string };

/**
 * D18 — one window at a time may run `pi --session` on a given JSONL.
 *
 * `PiTuiExclusiveGuard` above answers a different question ("is a terminal
 * holding the file the GUI is about to write") and answers it for the whole
 * process with a single owner key that TRANSFERS rather than refuses. That is
 * right for its job and useless for this one: the real-machine point check
 * (DEV-16) opened the same chat in two windows, and both `pi --session` on one
 * file, each reading the tree once at open and then hanging its own turn off
 * the same leaf — one JSONL silently forked into two branches, with no prompt,
 * no refusal and no read-only fallback anywhere in the UI. The writer lock does
 * not help: it belongs to the GUI worker and the pi CLI never takes it.
 *
 * Keyed by session file, valued by the window that claimed it, because the
 * controllers that own the PTYs are per-window (`ipc/piTui.ts`) and therefore
 * cannot see each other's terminals. Within ONE window the claim is re-keyed
 * rather than refused: the existing terminal-03 mismatch guard already stops a
 * warm PTY from serving another chat, and refusing here would break the
 * legitimate case where a chat's terminal died and the renderer minted a new id
 * for it.
 */
export class PiTuiWindowSessionGuard {
  #owners = new Map<string, { windowId: number; terminalIds: Set<string> }>();

  /** The window running a terminal on this file, or null when it is free. */
  ownerWindowId(sessionFile: string): number | null {
    const key = normalizeSessionKey(sessionFile);
    if (!key) return null;
    return this.#owners.get(key)?.windowId ?? null;
  }

  /**
   * Can `windowId` open a terminal on this file? Asked without claiming, for
   * the renderer's pre-flight — the claim below is what actually protects the
   * file.
   */
  check(sessionFile: string, windowId: number): PiTuiSessionClaim {
    const owner = this.ownerWindowId(sessionFile);
    if (owner !== null && owner !== windowId) {
      return { ok: false, reason: PI_TUI_SESSION_BUSY_REASON };
    }
    return { ok: true };
  }

  /**
   * Take the file for `windowId`, or refuse because another window has it.
   *
   * A terminal with no session file (a TUI opened from a repo rather than from
   * a chat) claims nothing: it starts its own conversation and contests no
   * existing JSONL.
   */
  claim(sessionFile: string, windowId: number, terminalId: string): PiTuiSessionClaim {
    const key = normalizeSessionKey(sessionFile);
    if (!key) return { ok: true };
    const existing = this.#owners.get(key);
    if (existing && existing.windowId !== windowId) {
      return { ok: false, reason: PI_TUI_SESSION_BUSY_REASON };
    }
    if (existing) existing.terminalIds.add(terminalId);
    else this.#owners.set(key, { windowId, terminalIds: new Set([terminalId]) });
    return { ok: true };
  }

  /**
   * Undo ONE claim: this window's terminal is no longer opening this chat.
   *
   * Separate from `releaseTerminal` below because the two answer different
   * questions, and the review of the first landing caught the difference the
   * hard way. `releaseTerminal` means "this PTY is gone" and therefore walks
   * every chat the window holds; using it to roll back a claim whose open then
   * failed also dropped the claim the SAME terminal id already held on another
   * chat — while that pi was still running on it. The next window asking for
   * that chat would have been let in, which is D18 itself.
   *
   * The path that reaches it: a warm terminal is asked for a second chat
   * (`PI_TUI_SESSION_MISMATCH_REASON`, terminal-03). The claim for the new chat
   * is already booked when the controller refuses, so exactly that one — and
   * nothing else — has to come back off.
   */
  releaseClaim(sessionFile: string, windowId: number, terminalId: string): void {
    const key = normalizeSessionKey(sessionFile);
    if (!key) return;
    const owner = this.#owners.get(key);
    if (!owner || owner.windowId !== windowId) return;
    owner.terminalIds.delete(terminalId);
    if (owner.terminalIds.size === 0) this.#owners.delete(key);
  }

  /**
   * One terminal stopped. Released on every way a terminal can end — its own
   * exit, an explicit dispose, a window teardown — because a claim that
   * outlives its PTY locks the chat out of terminal mode for the rest of the
   * run, which is the failure mode `PiTuiExclusiveGuard.transferTo` was
   * rewritten to avoid.
   *
   * Every chat this window's terminal held, because a dead PTY holds none of
   * them any more. A rollback wants `releaseClaim` above instead.
   */
  releaseTerminal(windowId: number, terminalId: string): void {
    for (const [key, owner] of [...this.#owners]) {
      if (owner.windowId !== windowId) continue;
      owner.terminalIds.delete(terminalId);
      if (owner.terminalIds.size === 0) this.#owners.delete(key);
    }
  }

  /** Every terminal in a window stopped (window closed, controller disposed). */
  releaseWindow(windowId: number): void {
    for (const [key, owner] of [...this.#owners]) {
      if (owner.windowId === windowId) this.#owners.delete(key);
    }
  }

  /** The GUI took this chat's JSONL back, so no terminal holds it any more. */
  releaseSession(sessionFile: string): void {
    const key = normalizeSessionKey(sessionFile);
    if (key) this.#owners.delete(key);
  }

  releaseAll(): void {
    this.#owners.clear();
  }
}

/**
 * TUI-1 / H/20: can the bundled `pi` CLI open this chat's JSONL at all?
 *
 * `pi --session <file>` parses with pi-coding-agent's own SessionManager, which
 * requires the first row to be `{"type":"session",...}` and returns nothing
 * otherwise — the CLI then reports `Session file is not a valid pi session` and
 * the terminal dies on open. Checked on 0.85.1 as well as the pinned 0.84.4:
 * the CLI's session version is still 3, so this is a format boundary between
 * two packages, not a version lag.
 *
 * Since H/20 the native runtime writes a header carrying BOTH formats, so those
 * sessions open in the TUI and this gate lets them through. What is left to
 * refuse is a v4 header written before that change and not yet reopened here:
 * the store upgrades the header the next time the app resumes the session, and
 * doing it from Main instead would make this process a second writer on a file
 * a worker may be holding.
 *
 * Only a POSITIVE identification refuses: an unreadable or unparsable head (an
 * encrypted container, a truncated file) stays allowed, because guessing
 * "unsupported" from a failed read would take the TUI away from sessions that
 * work today.
 */
export const PI_TUI_NATIVE_SESSION_REASON =
  'This chat was saved in an older native format. Open it in the app once to upgrade it, then the Pi terminal can open it.';

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
  if (record?.kind === 'header' && record.version === 4 && record.type !== 'session') {
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
