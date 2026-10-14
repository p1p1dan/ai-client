/**
 * dsh-rebase decision 169: something outside the composer hands it the
 * keyboard — the plan review card, once the user closes the review to type a
 * message. A window event rather than a store: there is nothing to keep, and
 * the composer that owns the chat on screen is the one that answers.
 */

const COMPOSER_FOCUS_EVENT = 'aiclient:composer-focus';

/**
 * Ask the composer of `sessionId` to take focus. `null` is the home page's
 * composer (decision 174: the session bar's 「＋」 there).
 */
export function requestComposerFocus(sessionId: string | null): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { sessionId } }));
}

/** The composer's side: `focus` runs for requests naming the chat it shows. */
export function onComposerFocusRequest(
  sessionId: () => string | null,
  focus: () => void
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
    if (detail?.sessionId === sessionId()) focus();
  };
  window.addEventListener(COMPOSER_FOCUS_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, listener);
}

const COMPOSER_STOP_EVENT = 'aiclient:composer-stop';

/**
 * Esc on a card that has taken the composer's place: interrupt the turn the way
 * the composer's own Stop does. The composer owns Stop's latches and watches,
 * so it runs the stop rather than the card calling the store directly.
 */
export function requestComposerStop(sessionId: string | null): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_STOP_EVENT, { detail: { sessionId } }));
}

/** The composer's side of {@link requestComposerStop}. */
export function onComposerStopRequest(
  sessionId: () => string | null,
  stop: () => void
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
    if (detail?.sessionId === sessionId()) stop();
  };
  window.addEventListener(COMPOSER_STOP_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_STOP_EVENT, listener);
}
