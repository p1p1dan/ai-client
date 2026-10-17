/**
 * Route B S-6 feedback 11c (user ruling 2026-10-17): start the DSH host while the
 * user types in a DSH chat. The host starts with the app, but stops after 10 minutes
 * with no session open (DSH decision 025); the first send after that paid the cold
 * start again (about 1.6 s on the dev box). Typing a message takes longer than that,
 * so asking for the host on the first keystrokes has it up by the send.
 *
 * Only for a chat whose next send goes to DSH (the Agent SDK engine is not warmed:
 * ruling, it keeps starting per chat), only for a draft with text in it, and at most
 * once a minute: Main's side is cheap when the host is already running, but a
 * keystroke is not a reason to cross the IPC boundary every time. Never throws.
 */

import type { ChatEngine } from '@shared/claudeSdkEngine';

/** At most one warm-up request per this long. */
export const DSH_HOST_WARMUP_INTERVAL_MS = 60_000;

export interface DshHostWarmupDeps {
  /** `window.electronAPI.chat.warmDshHost`. */
  warm: () => Promise<unknown> | undefined;
  now: () => number;
}

/** Returns the keystroke hook; it answers whether it asked Main this time. */
export function createDshHostWarmup(
  deps: DshHostWarmupDeps
): (input: { text: string; engine: ChatEngine }) => boolean {
  let lastAt = Number.NEGATIVE_INFINITY;
  return ({ text, engine }) => {
    if (engine !== 'dsh' || text.trim().length === 0) return false;
    const now = deps.now();
    if (now - lastAt < DSH_HOST_WARMUP_INTERVAL_MS) return false;
    lastAt = now;
    try {
      void deps.warm()?.catch(() => undefined);
    } catch {
      // A warm-up is an optimization: the send starts the host the way it always has.
    }
    return true;
  };
}

/** The composer's hook: one throttle for the whole window. */
export const warmDshHostWhileTyping = createDshHostWarmup({
  // Optional: a test stub of `electronAPI.chat` may not carry it.
  warm: () => window.electronAPI?.chat?.warmDshHost?.(),
  now: () => Date.now(),
});
