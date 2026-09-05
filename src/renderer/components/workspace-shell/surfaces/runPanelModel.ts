/**
 * U06-a: pure data layer for the Run surface — "what is this conversation
 * doing right now", built only from facts the renderer already has
 * (`session.status`, the message bucket, the in-flight turn snapshot, the
 * resolved model / thinking level).
 *
 * Deliberately NOT here (Q04 取证, [evidence-q04-runtime-fields]): context
 * occupancy, the usage row and tokens-per-second. Pi's worker never emits
 * `usage.updated` and the model catalog strips `contextWindow`, so every one of
 * those numbers would have to be invented. They belong to U06-b, which waits on
 * the Pi plan's T38 — until then this module has no usage shape at all, which
 * is what keeps the panel from growing an empty shell for them.
 *
 * React/electronAPI-free so it runs under the repo's node-env vitest, same as
 * `contextSurfaceModel.ts`.
 */

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
  /** True when this session has nothing to report yet at all. */
  empty: boolean;
}

const NO_TOOLS: RunToolFacts = { activeTool: null, calls: 0, failed: 0 };

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
export function deriveRunTools(messages: readonly ChatMessage[]): RunToolFacts {
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
  for (const block of lastAssistant.blocks) {
    if (block.type !== 'tool_call' || !block.toolCallId) continue;
    calls += 1;
    // Last unsettled call wins: tools run one after another in a turn, so the
    // most recent open one is what the agent is inside of right now.
    if (!settled.has(block.toolCallId)) {
      activeTool = block.toolName ?? null;
    }
  }
  return { activeTool, calls, failed };
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
  const tools = input.sessionId ? deriveRunTools(input.messages) : NO_TOOLS;
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
    // "Nothing to report" is narrower than "idle": an idle session that has
    // already run a turn still has a model, a clock and a tool count to show.
    empty:
      !input.sessionId ||
      (model === null && elapsedLabel === null && tools.calls === 0 && status === 'idle'),
  };
}
