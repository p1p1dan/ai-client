/**
 * Host-side delta coalescer (partial-messages batch, 片 1e).
 *
 * WHY THIS EXISTS: with `includePartialMessages` on, the spike measured
 * 340~570 events per 1k output tokens — extrapolating to 1.3~2.2万 events for
 * a single long turn (spike §5). Every one of those crosses a structured-clone
 * IPC hop (`src/main/ipc/chat.ts`) and lands in a renderer store that appends
 * text. The spike's own recommendation ("Host 侧 40~60 ms 合并作为备选方案不要
 * 删", §5) is landed here as an always-on component of the partial path, so the
 * D33③ "default ON" decision survives the write-amplification review blocker.
 *
 * WHAT IT IS NOT: a reordering buffer. Ordering is strict — any event that is
 * not a continuation of the buffered run flushes the buffer BEFORE it is
 * passed through, so a `delta → tool.started → delta` sequence keeps its
 * relative order. Only consecutive same-block text deltas ever merge.
 *
 * The class is deliberately free of normalizer state: it is constructed with a
 * sink and driven entirely through `emit`/`flushAll`/`setEnabled`, which makes
 * it unit-testable on its own (`__tests__/coalescingEmitter.test.ts`).
 */

export type CoalescedSinkFn = (event: Record<string, unknown>) => void;

/**
 * Merge window. 45ms sits inside the spike's 40~60ms recommendation and below
 * one 60fps frame budget's worth of perceptible latency, while covering the
 * measured peak burst rate (26~54 events/s).
 */
export const COALESCE_WINDOW_MS = 45;

/** The only two event types that carry appendable text on a stable blockId. */
const COALESCABLE_TYPES = new Set(['message.delta', 'thinking.delta']);

interface BufferedRun {
  /** The first event of the run — supplies every field except `text`. */
  head: Record<string, unknown>;
  headPayload: Record<string, unknown>;
  key: string;
  text: string;
  openedAtMs: number;
}

/**
 * Identity of a coalescable run. Anything that differs — a new block, a new
 * message, a different requestId — starts a new run rather than merging.
 * Returns `undefined` for events that must never be merged.
 */
function coalesceKey(event: Record<string, unknown>): string | undefined {
  const type = event.type;
  if (typeof type !== 'string' || !COALESCABLE_TYPES.has(type)) return undefined;
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== 'string') return undefined;
  if (typeof p.blockId !== 'string' || typeof p.messageId !== 'string') return undefined;
  return [type, String(event.sessionId), String(event.requestId), p.messageId, p.blockId].join(
    '\u0000'
  );
}

export class CoalescingEmitter {
  private readonly sink: CoalescedSinkFn;
  private readonly windowMs: number;
  private buffered: BufferedRun | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;

  constructor(sink: CoalescedSinkFn, windowMs: number = COALESCE_WINDOW_MS) {
    this.sink = sink;
    this.windowMs = windowMs;
  }

  /**
   * Turn merging on/off. OFF is a total bypass — `emit` becomes a direct call
   * to the sink — which is what keeps the control position (and any ON-position
   * turn the gateway never honours) byte-for-byte identical to the pre-batch
   * behavior. Switching off flushes first so nothing is stranded.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    if (!enabled) this.flushAll();
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  emit(event: Record<string, unknown>): void {
    if (!this.enabled) {
      // Nothing can be buffered while disabled (setEnabled flushes on the way
      // out), so this is a plain passthrough.
      this.sink(event);
      return;
    }

    const key = coalesceKey(event);
    if (key === undefined) {
      // Strict ordering: the buffered run happened FIRST and must leave first.
      this.flushAll();
      this.sink(event);
      return;
    }

    const text = (event.payload as Record<string, unknown>).text as string;
    const run = this.buffered;
    if (run && run.key === key && Date.now() - run.openedAtMs < this.windowMs) {
      run.text += text;
      return;
    }

    this.flushAll();
    this.buffered = {
      head: event,
      headPayload: event.payload as Record<string, unknown>,
      key,
      text,
      openedAtMs: Date.now(),
    };
    // Backstop: a run that never sees a follow-up event (turn goes quiet mid
    // block) must still reach the UI within the window, not on the next event.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.windowMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Emit whatever is buffered and disarm the backstop. Called on every foreign
   * event, on the window expiry, and on every turn terminal
   * (`result` / `session.failed` / `session.stopped` / `finishTurn`).
   */
  flushAll(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.buffered;
    if (!run) return;
    this.buffered = null;
    this.sink({ ...run.head, payload: { ...run.headPayload, text: run.text } });
  }
}
