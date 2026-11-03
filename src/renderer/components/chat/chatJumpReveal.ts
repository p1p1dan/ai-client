/**
 * Chat search (docs/plantree/plans/chat-search, stage 4): bring one message
 * of the open chat into view.
 *
 * Three steps, each reusing what the timeline already does:
 *  1. `ensureChatMessageLoaded` pages older history through the timeline's
 *     own "load earlier messages" path (`loadOlderHistoryPage`) until the
 *     message is in the session's bucket, or there is nothing older;
 *  2. `revealChatMessage` finds its `data-message-id` anchor, opens a closed
 *     `<details>` around it the way `locateToolRow` does (decision 208: only
 *     a desktop-style run is one, and prose never sits inside a run), and
 *     scrolls only the timeline's viewport by geometry (as `PromptNavRail.jumpTo`);
 *  3. it marks the anchor `data-located` for a moment, which the anchor's
 *     class shows as the selection colour.
 */
import { statusForNextTurn, useChatSessionsStore } from '@/stores/chatSessions';
import { useHistoryLoadingStore } from '@/stores/historyLoading';
import { loadOlderHistoryPage } from './historyPageRequest';
import { LOCATE_MARK_MS } from './locateToolRow';

/** The attribute every user message and assistant text carries in the timeline. */
export const MESSAGE_ANCHOR_ATTRIBUTE = 'data-message-id';

/** The anchor's class: `data-located` (a jump's mark) shows the selection colour. */
export const MESSAGE_ANCHOR_CLASS =
  'rounded-md transition-colors duration-250 data-[located]:bg-fill-ghost-selected';

/** Page size of a jump's older-history reads, the same as the timeline's button. */
const PAGE_LIMIT = 80;
/** A jump that has not found its message by then gives up quietly. */
const LOAD_DEADLINE_MS = 20_000;
/** How long to wait for a first page before concluding none is coming. */
const FIRST_PAGE_GRACE_MS = 3_000;

function escapeAttribute(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export function findMessageAnchor(root: ParentNode, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[${MESSAGE_ANCHOR_ATTRIBUTE}="${escapeAttribute(messageId)}"]`
  );
}

function sessionHasMessage(sessionId: string, messageId: string): boolean {
  const bucket = useChatSessionsStore.getState().messages[sessionId];
  return bucket?.some((message) => message.id === messageId) ?? false;
}

/**
 * Resolve once `predicate` holds (checked on every chat-session or
 * history-loading store change), or with false at `timeoutMs` / on abort.
 */
function waitForStores(
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offSessions();
      offLoading();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const check = () => {
      if (predicate()) finish(true);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const offSessions = useChatSessionsStore.subscribe(check);
    const offLoading = useHistoryLoadingStore.subscribe(check);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Page older history until `messageId` is in the session's bucket. True when
 * it is; false when the history ran out, a read failed, the deadline passed
 * or the jump was superseded (`signal`).
 *
 * Paging waits for the chat to be idle, as the timeline's own button does.
 */
export async function ensureChatMessageLoaded(
  sessionId: string,
  messageId: string,
  options: { signal?: AbortSignal; deadlineMs?: number } = {}
): Promise<boolean> {
  const { signal } = options;
  const deadline = Date.now() + (options.deadlineMs ?? LOAD_DEADLINE_MS);
  const remaining = () => deadline - Date.now();
  const has = () => sessionHasMessage(sessionId, messageId);
  const pagination = () => useChatSessionsStore.getState().historyPagination?.[sessionId];

  while (!signal?.aborted) {
    if (has()) return true;
    const page = pagination();
    if (!page) {
      // The first page is on its way (the activation just asked for it), or
      // this chat has no history to page at all. Wake when loading starts or
      // stops too, so a load that begins after this check gets its full time.
      const isLoading = () => useHistoryLoadingStore.getState().loading[sessionId] !== undefined;
      const wasLoading = isLoading();
      const grace = wasLoading ? remaining() : Math.min(remaining(), FIRST_PAGE_GRACE_MS);
      const woke = await waitForStores(
        () => has() || pagination() !== undefined || isLoading() !== wasLoading,
        grace,
        signal
      );
      if (!woke || (!isLoading() && pagination() === undefined && !has())) return false;
      continue;
    }
    if (!page.hasMore) return false;
    const idle = () => {
      const session = useChatSessionsStore.getState().sessions.find((s) => s.id === sessionId);
      return statusForNextTurn(session) === 'idle';
    };
    if (!idle()) {
      if (!(await waitForStores(() => has() || idle(), remaining(), signal))) return false;
      continue;
    }
    const offset = page.nextOffset;
    try {
      await loadOlderHistoryPage({
        sessionId,
        offset,
        limit: PAGE_LIMIT,
        hostBound: useChatSessionsStore.getState().hostBoundSessionIds.includes(sessionId),
      });
    } catch {
      return false;
    }
    // The page lands as a `session.history` event, which moves the offset.
    const moved = await waitForStores(
      () => has() || pagination()?.nextOffset !== offset,
      remaining(),
      signal
    );
    if (!moved || pagination()?.nextOffset === offset) return has();
  }
  return false;
}

/**
 * Scroll the timeline's viewport so the message sits a third of the way down,
 * opening the folded work group it may be in, and mark it for a moment.
 * False when the anchor is not in the DOM.
 */
export function revealChatMessage(
  root: HTMLElement,
  messageId: string,
  options: { onBeforeScroll?: () => void } = {}
): boolean {
  const target = findMessageAnchor(root, messageId);
  if (!target) return false;
  revealAnchor(root, target, options);
  return true;
}

/**
 * The fallback for a chat that ran live in this window and has not been
 * replayed since: its timeline renders live ids (`user-*` / `asst-*`), never
 * the `h:*` keys the index returns. Picks the `index`-th rendered message
 * whose text contains `query` (case-insensitive, wrapping), so the find bar
 * still steps through something. Null when no rendered message contains it.
 */
export function findMessageAnchorByText(
  root: ParentNode,
  query: string,
  index: number
): HTMLElement | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const seen = new Set<string>();
  const matches: HTMLElement[] = [];
  for (const anchor of root.querySelectorAll<HTMLElement>(`[${MESSAGE_ANCHOR_ATTRIBUTE}]`)) {
    const id = anchor.getAttribute(MESSAGE_ANCHOR_ATTRIBUTE) ?? '';
    // One message can render several text anchors; count it once.
    if (seen.has(id) || !(anchor.textContent ?? '').toLowerCase().includes(needle)) continue;
    seen.add(id);
    matches.push(anchor);
  }
  if (matches.length === 0) return null;
  return matches[((index % matches.length) + matches.length) % matches.length] ?? null;
}

export function revealAnchor(
  root: HTMLElement,
  target: HTMLElement,
  options: { onBeforeScroll?: () => void } = {}
): void {
  const group = target.closest('details');
  if (group && !group.open) group.querySelector<HTMLElement>(':scope > summary')?.click();
  const scroll = () => {
    const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    options.onBeforeScroll?.();
    const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + delta - viewport.clientHeight / 3) });
  };
  // An opened group lays out on the next frame; measure after it.
  if (group && typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll);
  else scroll();
  target.setAttribute('data-located', '');
  setTimeout(() => target.removeAttribute('data-located'), LOCATE_MARK_MS);
}
