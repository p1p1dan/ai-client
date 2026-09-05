/**
 * U06-a: pure data layer for the Run surface — "what is this conversation
 * doing right now", built only from facts the renderer already has
 * (`session.status`, the message bucket, the in-flight turn snapshot, the
 * resolved model / thinking level).
 *
 * U06-b adds the two things that used to be missing: the context-occupancy
 * figures and the usage row. Both now arrive as runtime facts rather than
 * derivations — Pi's worker emits `usage.updated` on every `turn_end` (T38-a)
 * and the model catalog carries `contextWindow` (T38-b). Nothing in this module
 * estimates tokens from characters; when the runtime has not reported a number,
 * the view says so and the ring does not render.
 *
 * React/electronAPI-free so it runs under the repo's node-env vitest, same as
 * `contextSurfaceModel.ts`.
 */

import {
  type ContextOccupancy,
  deriveContextOccupancy,
  type PiTurnUsage,
  type PiUsagePayload,
} from '@shared/piUsage';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { ChatMessage } from '@/stores/chatSessions';

/**
 * How the panel paints a status. Four tones rather than nine colours: the
 * exact state is always spelled out in words next to it, so the colour only
 * has to answer "is anything happening, and should I look".
 */
export type RunTone = 'idle' | 'active' | 'attention' | 'error';

export interface RunStatusPresentation {
  /** English source string = i18n key (see src/shared/i18n.ts). */
  headline: string;
  tone: RunTone;
}

/**
 * Total map over `SessionRuntimeStatus` (acceptance ①). A `Record` and not a
 * switch with a default: when a tenth runtime status is added, this fails to
 * compile instead of silently rendering the new state as "Idle".
 */
const STATUS_PRESENTATION: Record<SessionRuntimeStatus, RunStatusPresentation> = {
  idle: { headline: 'Idle', tone: 'idle' },
  starting: { headline: 'Starting', tone: 'active' },
  running: { headline: 'Running', tone: 'active' },
  waiting_permission: { headline: 'Waiting for approval', tone: 'attention' },
  waiting_question: { headline: 'Waiting for an answer', tone: 'attention' },
  stopping: { headline: 'Stopping', tone: 'active' },
  completed: { headline: 'Completed', tone: 'idle' },
  failed: { headline: 'Failed', tone: 'error' },
  disconnected: { headline: 'Disconnected', tone: 'attention' },
};

/**
 * What the agent is doing INSIDE a `running` status — the one refinement the
 * raw status cannot express. `null` while it is producing an answer, or
 * whenever the session is not running at all.
 */
export type RunActivity = 'tool' | 'thinking' | null;

/** Running + a tool in flight / a thinking block open gets its own headline. */
const ACTIVITY_HEADLINE: Record<'tool' | 'thinking', string> = {
  tool: 'Running a tool',
  thinking: 'Thinking',
};

export interface RunToolFacts {
  /** Tool call with no result yet — the one the agent is inside of. */
  activeTool: string | null;
  /**
   * T38-c: that tool's own latest progress line, `null` when it published none.
   * Reported by the runtime, never derived from the tool's output body.
   */
  activeToolStatus: string | null;
  /** Tool calls in the last assistant turn. */
  calls: number;
  /** Of those, the ones that came back `ok: false`. */
  failed: number;
}

export interface RunTurnSendFacts {
  /**
   * Which session this snapshot belongs to. `turnSendStatus` is a single slot,
   * not a per-session map, so the model drops a snapshot from another session
   * rather than painting this one's panel with someone else's clock
   * (acceptance ③ — same guard `ContextSurfaceView` applies).
   */
  sessionId: string;
  phase: string;
  elapsedSeconds: number;
}

export interface RunPanelInput {
  /** `null` = no active session; the view renders its empty state. */
  sessionId: string | null;
  status: SessionRuntimeStatus | null;
  /** Messages of THIS session only (the store buckets them by session). */
  messages: readonly ChatMessage[];
  turnSend: RunTurnSendFacts | null;
  /** Model the runtime actually echoed for the last assistant turn. */
  actualModel: string | null;
  /** Model this session is configured to send; `null` = Automatic. */
  configuredModel: string | null;
  /** Already-labelled thinking level, or `null` when no session/none stored. */
  effortLabel: string | null;
  /** Latency of the last completed assistant turn, in ms. */
  lastTurnMs: number | null;
  /**
   * U06-b: the last settled `usage.updated` for this session, or `null` before
   * the first turn settles (which includes a freshly reopened conversation).
   */
  usage: PiUsagePayload | null;
  /** T38-c: the running tool's progress line, from `sessionRuntimeFacts`. */
  toolStatus: { toolCallId: string; status: string } | null;
  /**
   * T38-b: the context window the CONFIGURED model declares in the catalog.
   * Used only as a standalone fact when the runtime has reported no occupancy
   * — never as a denominator under runtime token counts, because the configured
   * model and the model that actually answered are allowed to differ.
   */
  configuredContextWindow: number | null;
}

export interface RunPanelView {
  /** Raw status, never relabeled — same rule the Context surface follows. */
  status: SessionRuntimeStatus | null;
  headline: string;
  tone: RunTone;
  activity: RunActivity;
  /**
   * The clock: the in-flight turn's seconds while one is running, else the
   * last completed turn's duration, else `null` (the view shows a dash).
   */
  elapsedLabel: string | null;
  /** True while `elapsedLabel` describes a turn still in flight. */
  elapsedLive: boolean;
  /** In-flight phase (`handshake` / `awaiting`), for the sub-label. */
  phase: string | null;
  model: string | null;
  /** True when `model` is the runtime's own echo rather than the local pick. */
  modelReported: boolean;
  effortLabel: string | null;
  tools: RunToolFacts;
  /**
   * U06-b: occupancy the runtime measured, with a `used`/`free` split ready for
   * the ring. `null` whenever Pi has not reported tokens — after a compaction,
   * or before the session's first reply. Never synthesized from characters.
   */
  occupancy: ContextOccupancy | null;
  /**
   * The window with no occupancy against it: shown as a plain fact when
   * `occupancy` is `null` but a window size IS known. `null` = say nothing.
   */
  contextWindowOnly: number | null;
  /** Token/cost totals of the last settled turn, or `null`. */
  usage: PiTurnUsage | null;
  /** True when this session has nothing to report yet at all. */
  empty: boolean;
}

const NO_TOOLS: RunToolFacts = { activeTool: null, activeToolStatus: null, calls: 0, failed: 0 };

export function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

/**
 * Tool facts for the last assistant turn.
 *
 * Last turn, not the whole session: this panel describes the run in progress
 * (or the one that just ended), and a session-wide counter would keep climbing
 * across unrelated turns while claiming to describe this one.
 *
 * A `tool_call` block is "active" until a `tool_result` with the same
 * `toolCallId` arrives — that pairing is exactly how the store folds
 * `tool.started` / `tool.completed`.
 */
export function deriveRunTools(
  messages: readonly ChatMessage[],
  /** T38-c: the runtime's progress line, tied to the call that published it. */
  toolStatus?: { toolCallId: string; status: string } | null
): RunToolFacts {
  let lastAssistant: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      lastAssistant = messages[i];
      break;
    }
  }
  if (!lastAssistant) return NO_TOOLS;

  const settled = new Set<string>();
  let failed = 0;
  for (const block of lastAssistant.blocks) {
    if (block.type !== 'tool_result' || !block.toolCallId) continue;
    settled.add(block.toolCallId);
    if (block.toolOk === false) failed += 1;
  }

  let calls = 0;
  let activeTool: string | null = null;
  let activeToolCallId: string | null = null;
  for (const block of lastAssistant.blocks) {
    if (block.type !== 'tool_call' || !block.toolCallId) continue;
    calls += 1;
    // Last unsettled call wins: tools run one after another in a turn, so the
    // most recent open one is what the agent is inside of right now.
    if (!settled.has(block.toolCallId)) {
      activeTool = block.toolName ?? null;
      activeToolCallId = block.toolCallId;
    }
  }
  // The status is shown only against the call that published it. The store
  // clears it on completion anyway; this second check is what keeps a line from
  // appearing under the NEXT tool if those two events ever race.
  const activeToolStatus =
    toolStatus && activeToolCallId && toolStatus.toolCallId === activeToolCallId
      ? toolStatus.status
      : null;
  return { activeTool, activeToolStatus, calls, failed };
}

/** True when the last assistant turn's final block is an open thinking block. */
function isThinking(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    return message.blocks[message.blocks.length - 1]?.type === 'thinking';
  }
  return false;
}

export function deriveRunPanelView(input: RunPanelInput): RunPanelView {
  const status = input.sessionId ? input.status : null;
  const tools = input.sessionId ? deriveRunTools(input.messages, input.toolStatus) : NO_TOOLS;
  const activity: RunActivity =
    status === 'running'
      ? tools.activeTool
        ? 'tool'
        : isThinking(input.messages)
          ? 'thinking'
          : null
      : null;

  const presentation = status ? STATUS_PRESENTATION[status] : null;
  // A live snapshot from another session is not this panel's business.
  const turnSend =
    input.turnSend && input.turnSend.sessionId === input.sessionId ? input.turnSend : null;

  const elapsedLive = turnSend !== null;
  const elapsedLabel = turnSend
    ? formatRunDuration(turnSend.elapsedSeconds * 1000)
    : input.lastTurnMs !== null && input.lastTurnMs > 0
      ? formatRunDuration(input.lastTurnMs)
      : null;

  const model = input.actualModel ?? input.configuredModel;

  const usage = input.sessionId ? input.usage : null;
  const occupancy = deriveContextOccupancy(usage?.context);
  // Runtime window first: it belongs to the model that actually answered. The
  // catalog's is the configured model's, which is only the right answer while
  // nothing has answered yet.
  const knownWindow = usage?.context?.contextWindow ?? input.configuredContextWindow;
  const contextWindowOnly =
    occupancy === null && input.sessionId && knownWindow && knownWindow > 0 ? knownWindow : null;
  const turnUsage: PiTurnUsage | null = usage
    ? {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd,
      }
    : null;

  return {
    status,
    headline: activity ? ACTIVITY_HEADLINE[activity] : (presentation?.headline ?? 'No session'),
    tone: presentation?.tone ?? 'idle',
    activity,
    elapsedLabel,
    elapsedLive,
    phase: turnSend?.phase ?? null,
    model,
    modelReported: input.actualModel !== null,
    effortLabel: input.sessionId ? input.effortLabel : null,
    tools,
    occupancy,
    contextWindowOnly,
    usage: turnUsage,
    // "Nothing to report" is narrower than "idle": an idle session that has
    // already run a turn still has a model, a clock and a tool count to show.
    empty:
      !input.sessionId ||
      (model === null &&
        elapsedLabel === null &&
        tools.calls === 0 &&
        turnUsage === null &&
        status === 'idle'),
  };
}
