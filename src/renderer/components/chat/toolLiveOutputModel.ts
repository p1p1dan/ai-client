import type { RuntimeEvent } from '@shared/types/runtimeEvents';

/**
 * dsh-rebase P1-7b (decisions 072 rule 5, 119; plan P1-7 shard 03 §4.1, the
 * bash plan's B6): the pure half of a running command's live output.
 *
 * The bridge sends `tool.output` — the WHOLE newest tail of one call's output,
 * at most four times a second — while the call runs. This module keeps the
 * latest tail per call, ready to draw: terminal escapes stripped, carriage
 * returns applied the way a terminal would (a progress bar redraws its line),
 * so the pane reads like the command's own output. Memory only: the settled
 * `tool.completed` output is the row's record, and the tail goes the moment
 * it arrives.
 */

export interface ToolLiveOutput {
  sessionId: string;
  jobId: string;
  /** The tail, cleaned for display. */
  text: string;
  /** Bytes written before the tail, not carried. */
  omittedBytes: number;
  totalBytes: number;
}

export interface ToolLiveOutputState {
  byCall: Readonly<Record<string, ToolLiveOutput>>;
  /** Calls in arrival order of their first tail, for the bound below. */
  order: readonly string[];
  /**
   * dsh-rebase P1-7e (problem 20, decision 140): the last tail of each call
   * Stop cut short, keyed by chat and call (`stoppedKey`: a call id is the
   * model's, and two chats may carry the same one). DSH records such a call
   * as the one sentence `Error: tool call aborted`, so this tail is the only
   * copy of what the command had printed; the settled row shows it in place
   * of that sentence. Memory only, like the tails: a restart has nothing left.
   */
  stopped: Readonly<Record<string, ToolLiveOutput>>;
  /** Keys of `stopped` in the order the calls stopped, for their own bound. */
  stoppedOrder: readonly string[];
}

export const initialToolLiveOutput: ToolLiveOutputState = {
  byCall: {},
  order: [],
  stopped: {},
  stoppedOrder: [],
};

/** Running calls kept at once; past it the oldest goes (one agent runs one command at a time). */
export const TOOL_LIVE_OUTPUT_MAX_CALLS = 16;
/** Stopped calls whose last tail is kept; past it the oldest stop's goes. */
export const TOOL_STOPPED_OUTPUT_MAX_CALLS = 32;
/** What a pane holds at most, in characters (the bridge sends at most 16 KiB). */
export const TOOL_LIVE_OUTPUT_MAX_CHARS = 32_768;

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL | ESC \`), and two-character escapes.
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters a pane drops
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * A command's raw output as a terminal would leave it on screen, as far as
 * text can say: escapes dropped, `\r\n` a line end, a bare `\r` returning to
 * the line's start (what follows replaces what was there), other control
 * characters dropped.
 */
export function normalizeTerminalText(raw: string): string {
  const stripped = raw.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n');
  const lines = stripped.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    // Each `\r` starts the line over; a shorter redraw leaves the old tail.
    let screen = '';
    for (const segment of line.split('\r')) {
      screen = segment + screen.slice(segment.length);
    }
    return screen;
  });
  const text = lines.join('\n').replace(CONTROL_PATTERN, '');
  return text.length > TOOL_LIVE_OUTPUT_MAX_CHARS ? text.slice(-TOOL_LIVE_OUTPUT_MAX_CHARS) : text;
}

function without(state: ToolLiveOutputState, callIds: ReadonlySet<string>): ToolLiveOutputState {
  if (![...callIds].some((id) => id in state.byCall)) return state;
  const byCall: Record<string, ToolLiveOutput> = {};
  for (const [id, entry] of Object.entries(state.byCall)) if (!callIds.has(id)) byCall[id] = entry;
  return { ...state, byCall, order: state.order.filter((id) => !callIds.has(id)) };
}

/** Whether a `tool.completed` reports a call Stop cut short (`details.stopped`, decision 099 rule 5). */
function isStoppedCompletion(payload: unknown): boolean {
  const output = (payload as { output?: unknown } | null)?.output;
  if (typeof output !== 'object' || output === null) return false;
  const details = (output as { details?: unknown }).details;
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { stopped?: unknown }).stopped === true
  );
}

/** Where `stopped` keeps a call of a chat. */
function stoppedKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

/** The call's running tail, kept as what it printed before Stop cut it short. */
function keepStopped(
  state: ToolLiveOutputState,
  sessionId: string,
  toolCallId: string
): ToolLiveOutputState {
  const entry = state.byCall[toolCallId];
  // The tail under this id may be another chat's call with the same id.
  if (!entry || !entry.text || entry.sessionId !== sessionId) return state;
  const key = stoppedKey(entry.sessionId, toolCallId);
  let stoppedOrder = [...state.stoppedOrder.filter((id) => id !== key), key];
  let stopped: Record<string, ToolLiveOutput> = { ...state.stopped, [key]: entry };
  if (stoppedOrder.length > TOOL_STOPPED_OUTPUT_MAX_CALLS) {
    const dropped = new Set(
      stoppedOrder.slice(0, stoppedOrder.length - TOOL_STOPPED_OUTPUT_MAX_CALLS)
    );
    stoppedOrder = stoppedOrder.filter((id) => !dropped.has(id));
    stopped = Object.fromEntries(Object.entries(stopped).filter(([id]) => !dropped.has(id)));
  }
  return { ...state, stopped, stoppedOrder };
}

/**
 * The live fold: a `tool.output` replaces its call's tail; the call's
 * `tool.completed` ends it; a session's turn end or lost engine drops every
 * tail of that session. Anything else returns `state` itself.
 */
export function reduceToolLiveOutput(
  state: ToolLiveOutputState,
  event: RuntimeEvent
): ToolLiveOutputState {
  switch (event.type) {
    case 'tool.output': {
      const { toolCallId, jobId, tail, omittedBytes, totalBytes } = event.payload;
      if (typeof toolCallId !== 'string' || typeof tail !== 'string') return state;
      const entry: ToolLiveOutput = {
        sessionId: event.sessionId,
        jobId: String(jobId),
        text: normalizeTerminalText(tail),
        omittedBytes: Number(omittedBytes) || 0,
        totalBytes: Number(totalBytes) || 0,
      };
      const known = toolCallId in state.byCall;
      let order = known ? state.order : [...state.order, toolCallId];
      let byCall: Record<string, ToolLiveOutput> = { ...state.byCall, [toolCallId]: entry };
      if (order.length > TOOL_LIVE_OUTPUT_MAX_CALLS) {
        const dropped = order.slice(0, order.length - TOOL_LIVE_OUTPUT_MAX_CALLS);
        order = order.slice(-TOOL_LIVE_OUTPUT_MAX_CALLS);
        byCall = Object.fromEntries(Object.entries(byCall).filter(([id]) => !dropped.includes(id)));
      }
      return { ...state, byCall, order };
    }
    case 'tool.completed': {
      // P1-7e (problem 20): Stop's cut keeps what the command had printed.
      const toolCallId = event.payload.toolCallId;
      const kept = isStoppedCompletion(event.payload)
        ? keepStopped(state, event.sessionId, toolCallId)
        : state;
      return without(kept, new Set([toolCallId]));
    }
    case 'session.completed':
    case 'session.failed':
    case 'session.stopped':
      return dropSession(state, event.sessionId);
    case 'session.status':
      return event.payload.status === 'disconnected' ? dropSession(state, event.sessionId) : state;
    default:
      return state;
  }
}

function dropSession(
  state: ToolLiveOutputState,
  sessionId: string | undefined
): ToolLiveOutputState {
  if (!sessionId) return state;
  const calls = Object.entries(state.byCall)
    .filter(([, entry]) => entry.sessionId === sessionId)
    .map(([id]) => id);
  return calls.length === 0 ? state : without(state, new Set(calls));
}

export function pruneToolLiveOutput(
  state: ToolLiveOutputState,
  sessionIds: readonly string[]
): ToolLiveOutputState {
  const live = new Set(sessionIds);
  const gone = Object.entries(state.byCall)
    .filter(([, entry]) => !live.has(entry.sessionId))
    .map(([id]) => id);
  const pruned = gone.length === 0 ? state : without(state, new Set(gone));
  const goneStopped = new Set(
    Object.entries(pruned.stopped)
      .filter(([, entry]) => !live.has(entry.sessionId))
      .map(([id]) => id)
  );
  if (goneStopped.size === 0) return pruned;
  return {
    ...pruned,
    stopped: Object.fromEntries(
      Object.entries(pruned.stopped).filter(([id]) => !goneStopped.has(id))
    ),
    stoppedOrder: pruned.stoppedOrder.filter((id) => !goneStopped.has(id)),
  };
}

/** The kept output of a stopped call of `sessionId`, if its last tail is still held. */
export function stoppedToolOutput(
  state: Pick<ToolLiveOutputState, 'stopped'>,
  sessionId: string | undefined,
  toolCallId: string | undefined
): ToolLiveOutput | undefined {
  if (!sessionId || !toolCallId) return undefined;
  return state.stopped[stoppedKey(sessionId, toolCallId)];
}
