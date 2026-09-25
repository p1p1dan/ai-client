import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';

/**
 * T130 — a tool call the user's Stop cut short is not a success.
 *
 * `bash` resolves (it does not throw) when its command is aborted, because the
 * partial output and the `[exit=null; aborted]` tail are worth handing to the
 * model; pi then marks every non-throwing result `isError: false`, which the
 * timeline and the session file both read as "completed". The tool says what
 * happened in `details.stopped`, and this hook turns that into the error flag.
 *
 * Flipping the flag here, rather than throwing from the tool, is deliberate:
 * pi's thrown-error result replaces `details` with `{}`, so the structured
 * marker the projector and the replay read would be lost (N5: never decide by
 * matching the text).
 *
 * Strictly `=== true`: `TaskStop` already reports `details.stopped` as the
 * list of delegations it stopped, and that call did succeed.
 */
export function stoppedToolOutcome(
  context: Pick<AfterToolCallContext, 'result' | 'isError'>
): (AfterToolCallResult & { isError: true }) | undefined {
  if (context.isError) return undefined;
  const details: unknown = context.result?.details;
  if (!details || typeof details !== 'object') return undefined;
  return (details as { stopped?: unknown }).stopped === true ? { isError: true } : undefined;
}
