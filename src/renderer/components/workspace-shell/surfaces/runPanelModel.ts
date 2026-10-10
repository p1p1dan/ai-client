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
 * Issue #9 (decision 173 §4.5) adds the 「逐步缓存」 group and the session's
 * cache alert: every settled step of the turn on screen, what became of its
 * prompt cache (the host's verdict, `PiUsagePayload.cache`), and a warning
 * when rebuilds nothing local explains pile up. The verdicts are the host's;
 * nothing here re-judges a step from its numbers.
 *
 * React/electronAPI-free so it runs under the repo's node-env vitest, same as
 * `contextSurfaceModel.ts`.
 */

import type { CacheCause } from '@shared/cacheChain';
import { englishTranslate, type Translate } from '@shared/i18n';
import { deriveDelegatedShare, type PiSessionUsage } from '@shared/piTurnRollup';
import {
  type ContextOccupancy,
  deriveCacheHitRate,
  deriveContextOccupancy,
  type PiTurnUsage,
  type PiUsageCacheSession,
  type PiUsageCacheStep,
  type PiUsagePayload,
  readPiUsagePayload,
} from '@shared/piUsage';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { MessageMetadata } from '@/components/chat/messageMetadata';
import { toolDisplayName } from '@/components/chat/piToolNames';
import { toolRunOutcome } from '@/components/chat/toolCard';
import type { ChatMessage } from '@/stores/chatSessions';
import type { CacheStepsGroupPreference } from '@/stores/runPanelPreferences';

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
  /**
   * Of those, the ones that came back `ok: false` — minus the refused, never
   * started and stopped ones (`toolRunOutcome`), which did not fail.
   */
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
  /**
   * Token/cost totals of the last settled step (one model request; issue #9
   * renamed its rows from 「上一回合」 to 「最后一步」), or `null`. Also `null`
   * when `usageUnreported` is set: those numbers are not a bill.
   */
  usage: PiTurnUsage | null;
  /**
   * T125 — the last step was cut after its stream started and the provider
   * never reported its cost (`PiUsagePayload.unreported`). The view says
   * "unknown" where the rows would be; the session totals are untouched.
   */
  usageUnreported: boolean;
  /**
   * A1: `cacheRead / (input + cacheRead + cacheWrite)` — the share of that
   * same step's whole prompt served from cache (issue #9 put the writes in the
   * base) — already rounded to a whole percent. `null` means the rate is
   * unknown (no prompt tokens, or an unreported count) and the view prints no
   * row at all — never `0%`, which would claim a miss that was not measured.
   */
  cacheHitRate: number | null;
  /**
   * A2: what this conversation has spent in total, or `null` before anything
   * has settled. A SEPARATE figure from `usage` above, which is the last step's
   * own bill — the view must label the two apart and must never add them.
   */
  sessionUsage: PiSessionUsage | null;
  /**
   * decision 005 — how much of `sessionUsage` a subagent ran up.
   *
   * `null` when no delegate has settled, which is not "0%": a conversation
   * that never delegated and one whose figures have not arrived are different
   * states, and only the first would be honestly printed as zero.
   */
  delegatedShare: ReturnType<typeof deriveDelegatedShare>;
  /** The delegated tokens and cost themselves, for the row beside the share. */
  delegatedUsage: PiTurnUsage | null;
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
    // A call that was refused, never started or stopped (N5 / T130) settles
    // `ok: false` without the tool having failed — the timeline row is not red
    // for it, so the panel does not count it either.
    if (block.toolOk === false && !toolRunOutcome({ result: block.toolOutput })) failed += 1;
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
      // chat-tool-05 — the chip is read next to the timeline row for the same
      // call, so it has to use the same name for it: an MCP tool's wire id
      // (`mcp__<server>__<tool>`) is not what the row says.
      activeTool = block.toolName ? toolDisplayName(block.toolName) : null;
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
  // T125: a cut turn's zeros are what pi started from, not what was billed.
  const usageUnreported = usage?.unreported === true;
  const turnUsage: PiTurnUsage | null =
    usage && !usageUnreported
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
    usageUnreported,
    cacheHitRate: deriveCacheHitRate(turnUsage),
    sessionUsage: usage?.session ?? null,
    delegatedShare: deriveDelegatedShare(usage?.session, usage?.delegated),
    delegatedUsage: usage?.delegated ?? null,
    // "Nothing to report" is narrower than "idle": an idle session that has
    // already run a turn still has a model, a clock and a tool count to show.
    empty:
      !input.sessionId ||
      (model === null &&
        elapsedLabel === null &&
        tools.calls === 0 &&
        turnUsage === null &&
        !usageUnreported &&
        status === 'idle'),
  };
}

// ---- issue #9: the per-step cache view ---------------------------------------------

/** A DSH step's message id (`liveEvents.ts`): `dsh-<session>-t<turn>-s<step>`. */
const DSH_STEP_MESSAGE_ID = /^(dsh-.+)-t(\d+)-s(\d+)$/;

/** Rows listed before the older ones fold behind 「查看更早的 N 步」. */
export const CACHE_ROWS_SHOWN = 20;
/** The session alert shows at this many rebuilds and shrinks with no local cause... */
export const CACHE_ALERT_MIN_REBUILDS = 2;
/** ...or once they wrote this many cached tokens again. */
export const CACHE_ALERT_MIN_REWRITE_TOKENS = 100_000;

/** One settled model request of a chat, as the message metadata registry filed it. */
export interface RunSettledStep {
  messageId: string;
  /** The id less its coordinates: the steps of one DSH session share it. */
  chain: string;
  turn: number;
  step: number;
  /** Epoch ms the step's request started (its `message.started`), else when it settled. */
  at: number | null;
  /** From the previous settled step's start to this one's, when both are known. */
  gapMs: number | null;
  /** The model the host said answered (`message.started`), to tell routes apart. */
  model: string | null;
  usage: PiUsagePayload;
}

/**
 * The chat's settled steps, oldest first: every DSH step message whose bill
 * arrived (`usageSettledAt`). A step whose request is still running is not
 * here, nor one cut before the provider reported anything (`unreported`): it
 * has no numbers to list. The registry keeps entries in the order their
 * `message.started` arrived, which is the order the steps ran.
 */
export function collectSettledSteps(
  byMessage: Readonly<Record<string, MessageMetadata>>
): RunSettledStep[] {
  const steps: RunSettledStep[] = [];
  const lastStart = new Map<string, number>();
  for (const [messageId, meta] of Object.entries(byMessage)) {
    const match = DSH_STEP_MESSAGE_ID.exec(messageId);
    if (!match || meta.usageSettledAt === undefined) continue;
    const usage = readPiUsagePayload(meta.usage);
    if (!usage || usage.unreported) continue;
    const chain = match[1] ?? '';
    const startedAt = typeof meta.startedAt === 'number' ? meta.startedAt : null;
    const previous = lastStart.get(chain);
    if (startedAt !== null) lastStart.set(chain, startedAt);
    steps.push({
      messageId,
      chain,
      turn: Number(match[2]),
      step: Number(match[3]),
      at: startedAt ?? meta.usageSettledAt ?? null,
      gapMs:
        startedAt !== null && previous !== undefined ? Math.max(0, startedAt - previous) : null,
      model: meta.reportedModel ?? null,
      usage,
    });
  }
  return steps;
}

export type RunCacheTone = 'secondary' | 'info' | 'warning';

export interface RunCacheBadge {
  tone: RunCacheTone;
  text: string;
  /** The hover, one paragraph per entry: on an explained step, every cause in order. */
  tips: string[];
}

export interface RunCacheRow {
  turn: number;
  step: number;
  at: number | null;
  /** input + read + write of the settled bill. */
  prompt: number;
  read: number;
  write: number;
  badge: RunCacheBadge | null;
  /** Nothing local explains the step: its badge and its write figure are orange. */
  warning: boolean;
  /** Exact figures, for the hover on the numbers. */
  title: string;
  /** Plain text for the copied diagnostics; '' when the step reused the cache. */
  verdict: string;
}

/** Whether the client's requests are cleared by the host's prefix watch (decision 173 §4.2). */
export type RunCachePrefixCheck = 'verified' | 'diverged' | 'unknown';

export interface RunCacheGroupView {
  /** DSH's number of the turn listed; `null` when nothing is listed. */
  turn: number | null;
  rows: RunCacheRow[];
  /** Rows nothing local explains. */
  anomalies: number;
  /** The header's right-hand note: 「本回合 N 步」, or 「暂无明细」. */
  summary: string;
  /** The line under the rows, or the reopened chat's muted line when there are none. */
  note: string | null;
}

export interface RunCacheAlertView {
  title: string;
  body: string;
}

export interface RunCacheView {
  /** `null` = the panel shows no group (nothing settled, and no history from before this run). */
  group: RunCacheGroupView | null;
  /** `null` = below the thresholds, dismissed for this chat, or nothing reported. */
  alert: RunCacheAlertView | null;
  /** The latest `cache.session` this chat received, alert or not. */
  session: PiUsageCacheSession | null;
  prefix: RunCachePrefixCheck;
}

export interface RunCacheInput {
  /** `collectSettledSteps` of this chat. */
  steps: readonly RunSettledStep[];
  /**
   * The chat shows assistant rows the registry never saw: history from before
   * this run, which has no per-step bills (decision 173 §4.5).
   */
  hasUnlistedHistory: boolean;
  /** The user closed this chat's alert. */
  alertDismissed: boolean;
}

/** `169,778`: an exact token count, for hovers and sentences. */
export function formatExactTokens(count: number): string {
  return Math.round(count).toLocaleString('en-US');
}

/** `133k` / `1.21M`: a rounded count, for text that already says 「约」 or 「−」. */
export function formatApproxTokens(count: number): string {
  const tokens = Math.max(0, Math.round(count));
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/** Items as one localized list: 「15、17、20」 / `15, 17, 20`. */
export function joinCacheList(items: readonly string[], t: Translate = englishTranslate): string {
  return items.reduce((list, item) => (list ? t('{{list}}, {{item}}', { list, item }) : item), '');
}

/**
 * Order of the causes an explained step can carry: the badge shows the first,
 * the hover lists them all in this order (issue #9 approval, item 8). A
 * `Record` so a new `CacheCause` fails to compile until it is ranked.
 */
const CAUSE_RANK: Record<CacheCause, number> = {
  'plan-mode': 0,
  'system-prompt': 1,
  model: 2,
  compaction: 3,
  resume: 4,
  series: 5,
  seed: 6,
  'ttl-expired': 7,
  effort: 8,
  tools: 9,
  route: 10,
  header: 11,
};

/** Causes in display order, each once. */
export function orderCacheCauses(causes: readonly CacheCause[]): CacheCause[] {
  return [...new Set(causes)].sort((a, b) => CAUSE_RANK[a] - CAUSE_RANK[b]);
}

/** 「1 小时 12 分」 / 「45 分钟」: how long the chat sat idle. */
function idleDuration(ms: number, t: Translate): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t('{{minutes}} min', { minutes });
  if (minutes === 0) return t('{{hours}} h', { hours });
  return t('{{hours}} h {{minutes}} min', { hours, minutes });
}

function causeLabel(cause: CacheCause, gapMs: number | null, t: Translate): string {
  switch (cause) {
    case 'plan-mode':
      return t('Plan mode switched');
    case 'system-prompt':
      return t('System prompt changed');
    case 'model':
      return t('Model switched');
    case 'compaction':
      return t('Context compacted');
    case 'resume':
      return t('Chat resumed');
    case 'series':
      return t('New request series');
    case 'seed':
      return t('History restored');
    case 'ttl-expired':
      return gapMs !== null
        ? t('Idle {{duration}}, cache expired', { duration: idleDuration(gapMs, t) })
        : t('Idle past the cache lifetime');
    case 'effort':
      return t('Effort switched');
    case 'tools':
      return t('Tools changed');
    case 'route':
      return t('Route switched');
    case 'header':
      return t('Request settings changed');
  }
}

function causeTip(cause: CacheCause, gapMs: number | null, t: Translate): string {
  switch (cause) {
    case 'plan-mode':
      return t(
        'Entering or leaving plan mode changes the system prompt, so what follows is written to the cache again.'
      );
    case 'system-prompt':
      return t('The system prompt changed, so what follows is written to the cache again.');
    case 'model':
      return t(
        'The model changed. A cache is not shared across models, so the prompt is written again.'
      );
    case 'compaction':
      return t(
        'After a compaction the earlier conversation is replaced by a summary: the prompt gets shorter and what follows is written to the cache again.'
      );
    case 'resume':
      return t(
        'The first step after the engine restarted or the chat was reopened could not reuse the earlier cache, so the prompt is written again.'
      );
    case 'series':
      return t(
        'The engine started a new series of requests and could not reuse the earlier cache, so the prompt is written again.'
      );
    case 'seed':
      return t(
        'History was restored or carried over (a rewind or a fork), so the prompt is written to the cache again.'
      );
    case 'ttl-expired':
      return gapMs !== null
        ? t(
            'It had been {{duration}} since the step before, longer than the cache is kept: the cache had expired, so this step writes it again.',
            { duration: idleDuration(gapMs, t) }
          )
        : t(
            'More time passed since the step before than the cache is kept: the cache had expired, so this step writes it again.'
          );
    case 'effort':
      return t('The reasoning effort changed, so what follows is written to the cache again.');
    case 'tools':
      return t(
        'The available tools changed. Their definitions open the prompt, so it is written to the cache again.'
      );
    case 'route':
      return t(
        'The request went through another route or context window and could not reuse the earlier cache, so the prompt is written again.'
      );
    case 'header':
      return t('The request settings changed, so what follows is written to the cache again.');
  }
}

/** Every cause's sentence in order; plan mode's already says the system prompt changed. */
function causeTips(causes: readonly CacheCause[], gapMs: number | null, t: Translate): string[] {
  const planMode = causes.includes('plan-mode');
  return causes
    .filter((cause) => !(planMode && cause === 'system-prompt'))
    .map((cause) => causeTip(cause, gapMs, t));
}

/** The badge of a step that read an older step's cache, by where that step is. */
function matchedLabel(cache: PiUsageCacheStep, t: Translate): string {
  const matched = cache.matched;
  if (!matched || matched.turn !== cache.turn) return t('Read an earlier turn’s prefix');
  return t('Read step {{step}}’s prefix', { step: matched.step });
}

function matchedTip(cache: PiUsageCacheStep, t: Translate): string {
  const matched = cache.matched;
  const read = formatExactTokens(cache.read);
  if (!matched || matched.turn !== cache.turn) {
    return t(
      'The cache this step read ({{read}}) is exactly the length of a step in an earlier turn: requests are switching between two caches, most likely because the gateway sends them to different upstreams.',
      { read }
    );
  }
  return t(
    'The cache this step read ({{read}}) is exactly step {{step}}’s length: requests are switching between two caches, most likely because the gateway sends them to different upstreams.',
    { read, step: matched.step }
  );
}

/** What a rebuild or a shrink wrote again: the host's `rewrite`, else min(lost, write). */
function rewriteOfCache(cache: PiUsageCacheStep): number {
  return cache.rewrite ?? Math.max(0, Math.min(cache.lost ?? 0, cache.write));
}

/** How much shorter a shrink's prompt is than the step before's. */
function shrinkOf(cache: PiUsageCacheStep): number {
  return Math.max(0, (cache.prevPrompt ?? cache.prompt) - cache.prompt);
}

/**
 * The step's badge, from the host's verdict (`PiUsageCacheStep`): grey for the
 * first write, blue for a local cause, orange when nothing local explains it.
 * No `cache` (the step reused the step before's cache, or its route is not
 * followed) and a turn-shrink (never sent) carry no badge.
 */
function cacheBadgeOf(step: RunSettledStep, t: Translate): RunCacheBadge | null {
  const cache = step.usage.cache;
  if (!cache) return null;
  // A first write is grey unless a local event (a model or route switch, a
  // resume) explains why there was nothing to build on: then it is blue.
  if (cache.kind === 'cold' && !cache.causes?.length) {
    return {
      tone: 'secondary',
      text: t('First write'),
      tips: [t('No cache to build on yet, so this step’s whole prompt is written to the cache.')],
    };
  }
  if (cache.explained || cache.kind === 'cold') {
    const causes = orderCacheCauses(cache.causes ?? []);
    const main = causes[0];
    if (!main) return null;
    return {
      tone: 'info',
      text: causeLabel(main, step.gapMs, t),
      tips: causeTips(causes, step.gapMs, t),
    };
  }
  const diverged = cache.prefix === 'diverged';
  const verified = cache.prefix === 'append' || cache.prefix === 'same';
  const tips: string[] = [];
  let text: string;
  if (cache.kind === 'rebuild') {
    const rewrite = rewriteOfCache(cache);
    const params = {
      prev: formatExactTokens(cache.prevPrompt ?? cache.read + (cache.lost ?? 0)),
      read: formatExactTokens(cache.read),
      rewrite: formatApproxTokens(rewrite),
    };
    text = t('Unexplained · about {{tokens}} rewritten', { tokens: formatApproxTokens(rewrite) });
    tips.push(
      diverged
        ? t(
            'The step before had a prompt of {{prev}}; this step read only {{read}}, so about {{rewrite}} is written again.',
            params
          )
        : t(
            'The step before had a prompt of {{prev}}; this step read only {{read}}, so about {{rewrite}} is written again. Nothing local explains it: most likely the request went to another upstream.',
            params
          )
    );
  } else if (cache.kind === 'shrink') {
    const shorter = shrinkOf(cache);
    const params = { tokens: formatExactTokens(shorter) };
    text = t('Prompt shorter · −{{tokens}}', { tokens: formatApproxTokens(shorter) });
    tips.push(
      verified
        ? t(
            'This step’s prompt is {{tokens}} shorter than the step before’s. The client only appends (verified), so the upstream dropped part of the history and what follows is written to the cache again.',
            params
          )
        : diverged
          ? t(
              'This step’s prompt is {{tokens}} shorter than the step before’s, so what follows is written to the cache again.',
              params
            )
          : t(
              'This step’s prompt is {{tokens}} shorter than the step before’s. The client only appends, so most likely the upstream dropped part of the history; what follows is written to the cache again.',
              params
            )
    );
  } else {
    text = matchedLabel(cache, t);
    tips.push(matchedTip(cache, t));
  }
  if (cache.matched && cache.kind !== 'warm') tips.push(matchedTip(cache, t));
  if (diverged) {
    tips.push(
      t('This step’s request did not extend the request before it, so the client may be the cause.')
    );
  }
  return { tone: 'warning', text, tips };
}

/** The verdict column of the copied diagnostics: numbers in full, no hover prose. */
function cacheVerdictOf(step: RunSettledStep, t: Translate): string {
  const cache = step.usage.cache;
  if (!cache) return '';
  if (cache.kind === 'cold' && !cache.causes?.length) return t('First write');
  if (cache.explained || cache.kind === 'cold') {
    return joinCacheList(
      orderCacheCauses(cache.causes ?? []).map((cause) => causeLabel(cause, step.gapMs, t)),
      t
    );
  }
  const parts: string[] = [];
  if (cache.kind === 'rebuild') {
    parts.push(t('Unexplained, rewrote {{tokens}}', { tokens: rewriteOfCache(cache) }));
  } else if (cache.kind === 'shrink') {
    parts.push(t('Prompt shorter −{{tokens}}', { tokens: shrinkOf(cache) }));
  }
  const matched = cache.matched;
  if (matched) {
    parts.push(
      matched.turn === cache.turn
        ? t('Read step {{step}}’s prefix', { step: matched.step })
        : t('Read the prefix of turn {{turn}}, step {{step}}', {
            turn: matched.turn,
            step: matched.step,
          })
    );
  }
  const verdict = joinCacheList(parts, t);
  return cache.prefix === 'diverged' ? t('{{verdict}} (prefix diverged)', { verdict }) : verdict;
}

/** The rows of one turn's steps, in step order. */
export function buildCacheRows(
  steps: readonly RunSettledStep[],
  t: Translate = englishTranslate
): RunCacheRow[] {
  return [...steps]
    .sort((a, b) => a.step - b.step)
    .map((step) => {
      const { input, cacheRead, cacheWrite } = step.usage;
      const prompt = input + cacheRead + cacheWrite;
      const badge = cacheBadgeOf(step, t);
      return {
        turn: step.turn,
        step: step.step,
        at: step.at,
        prompt,
        read: cacheRead,
        write: cacheWrite,
        badge,
        warning: badge?.tone === 'warning',
        title: t('Step {{step}}: prompt {{prompt}} · read {{read}} · written {{write}}', {
          step: step.step,
          prompt: formatExactTokens(prompt),
          read: formatExactTokens(cacheRead),
          write: formatExactTokens(cacheWrite),
        }),
        verdict: cacheVerdictOf(step, t),
      };
    });
}

/** Every listed turn of the chat, oldest first, for the copied diagnostics. */
export function cacheTurnsOf(
  steps: readonly RunSettledStep[],
  t: Translate = englishTranslate
): { turn: number; rows: RunCacheRow[] }[] {
  const turns = new Map<string, { turn: number; steps: RunSettledStep[] }>();
  for (const step of steps) {
    const key = `${step.chain}\u0000${step.turn}`;
    const entry = turns.get(key) ?? { turn: step.turn, steps: [] };
    entry.steps.push(step);
    turns.set(key, entry);
  }
  return [...turns.values()].map((entry) => ({
    turn: entry.turn,
    rows: buildCacheRows(entry.steps, t),
  }));
}

/** The newest session totals a step carried: the alert's numbers. */
function latestCacheSession(steps: readonly RunSettledStep[]): PiUsageCacheSession | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const cache = steps[index]?.usage.cache;
    if (cache) return cache.session;
  }
  return null;
}

/**
 * 「（已校验）」 is earned only when every step this chat flagged without a
 * local cause has the host's word that its request extended the one before,
 * and the renderer has seen every rebuild and shrink the alert counts
 * (`session.unexplainedRebuilds`). Any diverged request says the client may be
 * at fault; anything short of both is unknown.
 */
function prefixCheckOf(
  steps: readonly RunSettledStep[],
  session: PiUsageCacheSession | null
): RunCachePrefixCheck {
  const unexplained = steps
    .map((step) => step.usage.cache)
    .filter(
      (cache): cache is PiUsageCacheStep => !!cache && cache.kind !== 'cold' && !cache.explained
    );
  if (unexplained.some((cache) => cache.prefix === 'diverged')) return 'diverged';
  const lossy = unexplained.filter((cache) => cache.kind === 'rebuild' || cache.kind === 'shrink');
  if (!session || lossy.length === 0 || lossy.length < session.unexplainedRebuilds) {
    return 'unknown';
  }
  return unexplained.every((cache) => cache.prefix === 'append' || cache.prefix === 'same')
    ? 'verified'
    : 'unknown';
}

/** The session alert (issue #9 approval, item 3), or `null` below its thresholds. */
function cacheAlertOf(
  session: PiUsageCacheSession | null,
  prefix: RunCachePrefixCheck,
  dismissed: boolean,
  t: Translate
): RunCacheAlertView | null {
  if (!session || dismissed) return null;
  if (
    session.unexplainedRebuilds < CACHE_ALERT_MIN_REBUILDS &&
    session.unexplainedRewriteTokens < CACHE_ALERT_MIN_REWRITE_TOKENS
  ) {
    return null;
  }
  const params = {
    count: session.unexplainedRebuilds,
    tokens: formatApproxTokens(session.unexplainedRewriteTokens),
  };
  return {
    title:
      session.unexplainedRebuilds >= CACHE_ALERT_MIN_REBUILDS
        ? t('This chat’s cache was rebuilt several times')
        : t('A large part of this chat’s cache was rebuilt'),
    body:
      prefix === 'verified'
        ? t(
            'Rebuilds with no local cause: {{count}}, about {{tokens}} tokens written again. Each request extended the one before it (verified), so most likely the gateway sent them to different upstreams.',
            params
          )
        : prefix === 'diverged'
          ? t(
              'Rebuilds with no local cause: {{count}}, about {{tokens}} tokens written again. Some requests did not extend the one before them, so the client may be the cause.',
              params
            )
          : t(
              'Rebuilds with no local cause: {{count}}, about {{tokens}} tokens written again. Most likely the gateway sent the requests to different upstreams.',
              params
            ),
  };
}

/** The line under the rows: what the badges add up to. */
function cacheFootnote(
  rows: readonly RunCacheRow[],
  alertShown: boolean,
  tracked: boolean,
  t: Translate
): string | null {
  const warned = rows.filter((row) => row.warning).map((row) => String(row.step));
  if (warned.length > 0) {
    const steps = joinCacheList(warned, t);
    return alertShown
      ? t('No local cause found at step {{steps}}; see the notice at the top of the panel.', {
          steps,
        })
      : t('No local cause found at step {{steps}}.', { steps });
  }
  if (rows.some((row) => row.badge?.tone === 'info')) {
    return t('Every rebuild in this turn has a local cause; it is not the upstream.');
  }
  // A route the host does not follow sends no verdicts at all, so silence
  // there proves nothing: only a route seen sending one earns this line.
  if (!tracked || !rows.some((row) => row.badge === null)) return null;
  return rows.some((row) => row.badge !== null)
    ? t('After the first write, every step reused the cache of the step before.')
    : t('Every step reused the cache of the step before.');
}

/**
 * The 「逐步缓存」 group and the session alert, from the chat's settled steps.
 *
 * The group lists the turn of the newest settled step: while the next turn's
 * first step is still running, the list (like the usage rows above it) stays
 * on the turn that last settled. A chat whose steps are all from before this
 * run lists nothing and says so; one with nothing settled at all and no such
 * history shows no group.
 */
export function deriveRunCacheView(
  input: RunCacheInput,
  t: Translate = englishTranslate
): RunCacheView {
  const { steps } = input;
  const session = latestCacheSession(steps);
  const prefix = prefixCheckOf(steps, session);
  const alert = cacheAlertOf(session, prefix, input.alertDismissed, t);
  const last = steps.at(-1);
  if (!last) {
    return {
      group: input.hasUnlistedHistory
        ? {
            turn: null,
            rows: [],
            anomalies: 0,
            summary: t('No details yet'),
            note: t(
              'Steps from before the reopen are not itemized. Once the next message is sent, its steps are listed here.'
            ),
          }
        : null,
      alert,
      session,
      prefix,
    };
  }
  const rows = buildCacheRows(
    steps.filter((step) => step.chain === last.chain && step.turn === last.turn),
    t
  );
  const tracked = steps.some((step) => step.usage.cache !== undefined && step.model === last.model);
  return {
    group: {
      turn: last.turn,
      rows,
      anomalies: rows.filter((row) => row.warning).length,
      summary: t('{{count}} steps this turn', { count: rows.length }),
      note: cacheFootnote(rows, alert !== null, tracked, t),
    },
    alert,
    session,
    prefix,
  };
}

/** Open or closed: the user's choice once made, else open exactly when something is unexplained. */
export function resolveCacheGroupOpen(
  preference: CacheStepsGroupPreference,
  anomalies: number
): boolean {
  return preference === 'auto' ? anomalies > 0 : preference === 'open';
}

/** The newest `CACHE_ROWS_SHOWN` rows, unless the user asked for all of them. */
export function foldCacheRows<T>(
  rows: readonly T[],
  showAll: boolean
): { shown: readonly T[]; hidden: number } {
  if (showAll || rows.length <= CACHE_ROWS_SHOWN) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(-CACHE_ROWS_SHOWN), hidden: rows.length - CACHE_ROWS_SHOWN };
}
