/**
 * D47 S5 §3 — spawn-gate rejection detection for the chat timeline's error
 * surfaces.
 *
 * `chatSessions.ts` is a red-line file (S5b brief): its `sendMessage` catch
 * block already turns any thrown `createSession`/`send` rejection into a flat
 * string (`lastError`, and a `role:'error'` message block carrying the same
 * text) via `err instanceof Error ? err.message : String(err)`. Rather than
 * touching that control flow to special-case the spawn gate's structured
 * envelope (`resolveSpawnGateDecision`, @shared/authGate:
 * `{ok:false, error:{code:'auth_required', message}}`), this module
 * pattern-matches the resulting string and lets the timeline (MessageTimeline.tsx)
 * swap in mapped Chinese copy + a re-login action — a presentational wrapper,
 * not a change to how the store records the failure.
 *
 * The match is intentionally redundant across two signals, since the
 * `main/ipc/chat.ts` handler that will actually throw this across the IPC
 * boundary was not yet written at the time this module was: Electron's
 * `ipcRenderer.invoke` rejection only reliably preserves a thrown Error's
 * `.message` text, not extra fields like `.error.code` on a custom object.
 *  - the `auth_required` error code, in case the thrown Error's message
 *    happens to carry it (e.g. `` `auth_required: ${message}` ``);
 *  - either of `resolveSpawnGateDecision`'s two fixed English messages
 *    (@shared/authGate) — fixed today, and much more likely to survive
 *    verbatim as an Error's `.message` than a separately-serialized code.
 */

/** The spawn gate's structured error code (`resolveSpawnGateDecision`, @shared/authGate). */
export const AUTH_REQUIRED_CODE_TOKEN = 'auth_required';

/**
 * `resolveSpawnGateDecision`'s two fixed rejection messages (@shared/authGate,
 * as landed at the time this module was written). Matched as substrings
 * rather than full equality — IPC/Error wrapping tends to prefix text
 * ("Error invoking remote method '...': Error: <message>") without altering
 * the original message itself.
 */
const SPAWN_GATE_MESSAGE_NEEDLES = [
  'Sign-in required before starting an agent session.',
  'Credentials are still unlocking',
] as const;

/** True when `text` looks like it originated from a spawn-gate rejection. */
export function isAuthRequiredError(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.includes(AUTH_REQUIRED_CODE_TOKEN)) return true;
  return SPAWN_GATE_MESSAGE_NEEDLES.some((needle) => text.includes(needle));
}

export interface AuthRequiredErrorView {
  title: string;
  message: string;
  actionLabel: string;
}

/** Chinese copy + re-login action for a detected spawn-gate rejection. */
export const AUTH_REQUIRED_ERROR_VIEW: AuthRequiredErrorView = {
  title: '需要重新登录',
  message: '登录状态已失效，请重新登录后再试。',
  actionLabel: '重新登录',
};
