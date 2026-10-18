/**
 * Decision 193 §10: the model requests of a DSH session outside its agent
 * loop, so the Run panel's session total counts every request it was billed
 * for.
 *
 * dsh-token-meter's `tokenUsage`, the total the bridge reports, sums the
 * agent loop's `assistant/message` and `assistant/attempt` usage only. Two
 * other kinds of request serve a session:
 *   - a compaction summary: DSH logs its usage on `compaction/summary`
 *     (`usage`, the same `TokenUsage` a step carries), so it is folded from
 *     the log here, like the token meter's total, and survives a reopen. A
 *     summary that failed or was thrown away logs no usage and is not counted;
 *   - a review of the auto gear (decision 192): a one-shot request that writes
 *     nothing to the log, which the session runtime adds as it settles
 *     (`addAuxiliaryUsage`). It counts from the runtime's start only.
 * Session titles cost no request: DSH's title plugin is off
 * (`bundle/cordis.patch.yml`) and the app names a chat after its first
 * message.
 *
 * Plain JSON and in place, like the cache chain's state; no imports, so the
 * host and the renderer can both load it.
 */

/** Auxiliary requests counted, and their tokens in the token meter's buckets. */
export interface AuxiliaryUsage {
  requests: number;
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyAuxiliaryUsage(): AuxiliaryUsage {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Adds one request's provider-reported `TokenUsage` (`inputTokens`,
 * `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) to `total`, in
 * place. False, and nothing added, when `usage` is not an object: a request
 * that reported nothing is not counted.
 */
export function addAuxiliaryUsage(total: AuxiliaryUsage, usage: unknown): boolean {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return false;
  const row = usage as Record<string, unknown>;
  total.requests += 1;
  total.input += countOf(row.inputTokens);
  total.output += countOf(row.outputTokens);
  total.cacheRead += countOf(row.cacheReadTokens);
  total.cacheWrite += countOf(row.cacheWriteTokens);
  return true;
}

/** Folds one log event into `total`, in place: a `compaction/summary` that carries usage. */
export function applyAuxiliaryUsage(
  total: AuxiliaryUsage,
  event: { readonly type: string; readonly data?: unknown }
): void {
  if (event?.type !== 'compaction/summary') return;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  addAuxiliaryUsage(total, (data as Record<string, unknown>).usage);
}

/** The auxiliary usage a whole log records. */
export function foldAuxiliaryUsage(
  events: Iterable<{ readonly type: string; readonly data?: unknown }>
): AuxiliaryUsage {
  const total = emptyAuxiliaryUsage();
  for (const event of events) applyAuxiliaryUsage(total, event);
  return total;
}

/** Both totals together, as a new object. */
export function sumAuxiliaryUsage(a: AuxiliaryUsage, b: AuxiliaryUsage): AuxiliaryUsage {
  return {
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}
