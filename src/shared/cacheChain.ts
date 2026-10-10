/**
 * The prompt-cache chain of one DSH session log (issue #9).
 *
 * A provider prompt cache (Anthropic's) is a prefix cache: a request reads the
 * longest prefix an earlier request cached and writes the rest. A session only
 * ever appends, so every step should read about what the step before it cached
 * (that step's prompt less its uncached input). In issue #9 a gateway spread
 * one session's requests over upstream backends with separate caches: steps
 * kept rebuilding, or read what some older step had cached, and nothing on our
 * side said why.
 *
 * This fold reads the usage DSH records on each `assistant/message` and gives
 * every step a verdict (`CacheStepKind`): did it reuse the step before's
 * cache, and if not, did a local event since then explain it (`CacheCause`)?
 * A notable step (`isNotableVerdict`) without one is unexplained: that is what
 * logs and alerts report. Explained ones are still shown.
 *
 * Pure, deterministic and incremental, like `DshHistoryFold`
 * (`dshHistory/projection.ts`): events go in log order, one at a time, and
 * `applyCacheChain` updates the state in place (the history fold's `push`
 * style), returning the verdict of the step the event recorded. A verdict or
 * view handed out is never mutated afterwards. Unlike the history fold, the
 * state is plain JSON (no class, Map or function), so it can sit beside a
 * history cache and come back through `restoreCacheChain`. No imports: the DSH
 * host bundles this module and the renderer loads it.
 */

// ---- thresholds ------------------------------------------------------------------

/** A step that lost fewer cached tokens than this is never a rebuild. */
export const MIN_LOST = 1024;
/** Losing at least this many cached tokens is a rebuild, however long the prompt... */
export const REBUILD_ABS = 50_000;
/** ...and so is losing at least this share of the step before's prompt. */
export const REBUILD_RATIO = 0.2;
/** A prompt shorter than the step before's by more than this many tokens... */
export const SHRINK_ABS = 256;
/** ...and by more than this share of it (providers' counting noise) shrank. */
export const SHRINK_RATIO = 0.005;
/** A read matches a step's cached size within this many tokens... */
export const MATCH_ABS = 8;
/** ...or within this share of the read, when larger. */
export const MATCH_RATIO = 0.0005;
/** How many recent cache-active steps a read is matched against. */
export const MATCH_WINDOW = 32;
/** Cache lifetime of a route `ttlMsFor` does not know: Anthropic's default entry. */
export const DEFAULT_TTL_MS = 5 * 60_000;
/** Verdicts the state keeps (the newest); the totals count every step. */
export const MAX_KEPT_VERDICTS = 500;
/** The state's format; `restoreCacheChain` refuses any other, and the caller folds afresh. */
export const CACHE_CHAIN_STATE_VERSION = 1;

// ---- vocabulary ------------------------------------------------------------------

/**
 * Local events that can explain a lost cache, collected since the step before:
 *   system-prompt   a `system/message` after the log's first: the prompt changed
 *   plan-mode       a `plan/mode` toggle
 *   resume          a `request/header` of a new loop over the log (restart, fork)
 *   series          a header that starts a new message series
 *   model           a header naming another provider or model (caches are per model)
 *   effort          a header with another reasoning effort
 *   tools           a header with another tool set
 *   header          a `change` header that differs in none of those
 *   route           a `request/context` naming another route or context window
 *   compaction      `compaction/*` or `image/offload`: earlier content rewritten
 *   seed            `session/end-seed`: restored or inherited history
 *   ttl-expired     a judged step's request started longer after the step
 *                   before's than the route's cache lives (`gapMs`)
 */
export const CACHE_CAUSES = [
  'system-prompt',
  'plan-mode',
  'resume',
  'series',
  'model',
  'effort',
  'tools',
  'header',
  'route',
  'compaction',
  'seed',
  'ttl-expired',
] as const;
export type CacheCause = (typeof CACHE_CAUSES)[number];

/**
 * What became of a step's cache:
 *   untracked     a route `cacheAware` declines: recorded, never judged
 *   cold          nothing to compare with: the first followed step, or the
 *                 step before cached nothing
 *   warm          read about what the step before cached
 *   rebuild       lost a large part of it (`MIN_LOST`, `REBUILD_ABS`, `REBUILD_RATIO`)
 *   shrink        the prompt got shorter (`SHRINK_ABS`, `SHRINK_RATIO`), which
 *                 appending alone never does
 *   turn-shrink   the same at a turn's first step, where a provider may drop
 *                 earlier turns' thinking: shown, not counted as a shrink
 */
export const CACHE_STEP_KINDS = [
  'untracked',
  'cold',
  'warm',
  'rebuild',
  'shrink',
  'turn-shrink',
] as const;
export type CacheStepKind = (typeof CACHE_STEP_KINDS)[number];

/** The slice of a DSH log event this fold reads (`DshLogEvent`, the bridge's live events). */
export interface CacheChainEvent {
  readonly type: string;
  readonly seq?: number;
  /** Unix epoch milliseconds. */
  readonly time?: number;
  readonly data?: unknown;
}

/** What the caller knows of routes; asked per step, never stored. */
export interface CacheChainOptions {
  /** The route's cache lifetime in ms; undefined for `DEFAULT_TTL_MS`. */
  ttlMsFor(provider?: string, model?: string): number | undefined;
  /** Whether the route reports a prefix cache this fold can follow; false records the step unjudged. */
  cacheAware(provider?: string, model?: string): boolean;
}

/** A step by DSH's coordinates. */
export interface CacheStepRef {
  readonly turn: number;
  readonly step: number;
}

/** One `assistant/message` that carried usage. */
export interface CacheStepVerdict extends CacheStepRef {
  readonly provider?: string;
  readonly model?: string;
  /** input + read + write. */
  readonly prompt: number;
  readonly read: number;
  readonly write: number;
  /** Uncached input. */
  readonly input: number;
  /** The step before's prompt, on a judged step. */
  readonly prevPrompt?: number;
  /** max(0, prevPrompt - read): cached tokens processed again; 0 on an unjudged step. */
  readonly lost: number;
  readonly kind: CacheStepKind;
  /** `causes` is not empty. */
  readonly explained: boolean;
  readonly causes: readonly CacheCause[];
  /** A judged step read what an older step (not the one before) cached: requests alternate between caches. */
  readonly matched?: CacheStepRef;
  /**
   * From the step before's request start to this one's: each step's
   * `step/start`, moved past any failed `assistant/attempt`, else its
   * `assistant/message`. Start to start, not idle time: an entry lives from
   * the start of the request that last read or wrote it, so generation counts.
   */
  readonly gapMs?: number;
}

export interface CacheChainTotals {
  /** Steps recorded, judged or not. */
  steps: number;
  /** Steps compared with the step before (warm, rebuild, shrink, turn-shrink). */
  evaluated: number;
  rebuilds: number;
  shrinks: number;
  /** Notable steps with no local cause. */
  unexplained: number;
  /** `lost` over rebuilds and shrinks. */
  lostTokens: number;
  /** The same over the unexplained ones. */
  unexplainedLostTokens: number;
}

export interface CacheChainView {
  readonly totals: Readonly<CacheChainTotals>;
  /** The kept verdicts, oldest first. */
  readonly verdicts: readonly CacheStepVerdict[];
}

/** A recorded step, as the next one is compared with it. */
interface ChainStep {
  turn: number;
  step: number;
  prompt: number;
  read: number;
  write: number;
  aware: boolean;
  startedAt?: number;
}

/** A cache-active step's cached size (prompt less input), for `matched`. */
interface CachedSize {
  turn: number;
  step: number;
  cached: number;
}

/**
 * The fold's state: plain JSON, kept and restored as is. Read it through
 * `viewCacheChain` and `lastStepVerdict`; its fields are this module's business.
 */
export interface CacheChainState {
  version: typeof CACHE_CHAIN_STATE_VERSION;
  /** Seq of the last event applied, -1 before any; an event at or below it is skipped. */
  cursor: number;
  /** The last recorded step: what the next one is compared with. */
  last?: ChainStep;
  /** The newest `MATCH_WINDOW` cache-active steps of followed routes, oldest first. */
  window: CachedSize[];
  /** Causes seen since the last recorded step, in order of first sight. */
  causes: CacheCause[];
  /** The step whose request is in flight, and when it (or its latest retry) started. */
  request?: { turn: number; step: number; startedAt?: number };
  /** A `system/message` was seen: any later one changes the prompt. */
  systemPrompt: boolean;
  /** The last `request/header`, reduced to what is compared (`tools` is a fingerprint). */
  header?: { provider?: string; model?: string; effort?: string; tools: string };
  /** The last `request/context`. */
  route?: { provider?: string; model?: string; contextWindow?: number };
  verdicts: CacheStepVerdict[];
  totals: CacheChainTotals;
}

// ---- helpers ---------------------------------------------------------------------

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A token count: absent (a zero cache field is left out) or malformed reads as 0. */
function countOf(value: unknown): number {
  const count = numberOf(value);
  return count !== undefined && count > 0 ? count : 0;
}

function addCause(causes: CacheCause[], cause: CacheCause): void {
  if (!causes.includes(cause)) causes.push(cause);
}

/** JSON with sorted keys, so equal tool sets compare equal whatever order their keys were written in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const row = recordOf(value);
  if (row) {
    const keys = Object.keys(row)
      .filter((key) => row[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A 53-bit hash (cyrb53): a tool set's schemas are too large to keep, a change only needs noticing. */
function fingerprintOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---- the fold ----------------------------------------------------------------------

export function initCacheChain(): CacheChainState {
  return {
    version: CACHE_CHAIN_STATE_VERSION,
    cursor: -1,
    window: [],
    causes: [],
    systemPrompt: false,
    verdicts: [],
    totals: {
      steps: 0,
      evaluated: 0,
      rebuilds: 0,
      shrinks: 0,
      unexplained: 0,
      lostTokens: 0,
      unexplainedLostTokens: 0,
    },
  };
}

/**
 * Folds one event into `state`, in place. Returns the verdict when the event
 * recorded a step (an `assistant/message` with usage), undefined otherwise.
 * An event at or below the state's cursor was applied already and is skipped;
 * one without a seq is always applied. Never throws on a malformed event: a
 * newer DSH vocabulary costs causes, never the fold.
 */
export function applyCacheChain(
  state: CacheChainState,
  event: CacheChainEvent,
  options: CacheChainOptions
): CacheStepVerdict | undefined {
  if (typeof event?.type !== 'string') return undefined;
  if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq)) {
    if (event.seq <= state.cursor) return undefined;
    state.cursor = event.seq;
  }
  const data = recordOf(event.data);
  const time = numberOf(event.time);
  switch (event.type) {
    case 'assistant/message':
      return recordStep(state, data, time, options);
    case 'step/start': {
      const turn = numberOf(data?.turn);
      const step = numberOf(data?.step);
      if (turn !== undefined && step !== undefined) {
        state.request = { turn, step, ...(time !== undefined ? { startedAt: time } : {}) };
      }
      return undefined;
    }
    case 'assistant/attempt': {
      // A failed attempt settled; the next one starts after it.
      const request = state.request;
      if (
        request &&
        time !== undefined &&
        request.turn === data?.turn &&
        request.step === data?.step
      )
        request.startedAt = time;
      return undefined;
    }
    case 'system/message':
      if (recordOf(recordOf(data?.message)?.source)?.kind === 'system-prompt') {
        if (state.systemPrompt) addCause(state.causes, 'system-prompt');
        state.systemPrompt = true;
      }
      return undefined;
    case 'plan/mode':
      addCause(state.causes, 'plan-mode');
      return undefined;
    case 'request/header':
      onHeader(state, data);
      return undefined;
    case 'request/context':
      onRoute(state, data);
      return undefined;
    case 'session/end-seed':
      addCause(state.causes, 'seed');
      return undefined;
    case 'image/offload':
      addCause(state.causes, 'compaction');
      return undefined;
    default:
      if (event.type.startsWith('compaction/')) addCause(state.causes, 'compaction');
      return undefined;
  }
}

/**
 * A header snapshot: what changed against the one before, and why DSH logged
 * it. A `change` (or a reason this build does not know) that differs in
 * nothing compared is still a cause, `header`.
 */
function onHeader(state: CacheChainState, data: Row | undefined): void {
  const header = recordOf(data?.header);
  if (!header) return;
  const config = recordOf(header.config);
  const provider = stringOf(config?.provider);
  const model = stringOf(config?.model);
  const effort = stringOf(config?.reasoningEffort);
  const next: NonNullable<CacheChainState['header']> = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    tools: fingerprintOf(stableJson(header.tools ?? null)),
  };
  const previous = state.header;
  const changes: CacheCause[] = [];
  if (previous) {
    if (previous.provider !== next.provider || previous.model !== next.model) changes.push('model');
    if (previous.effort !== next.effort) changes.push('effort');
    if (previous.tools !== next.tools) changes.push('tools');
  }
  const reason = data?.reason;
  if (reason === 'resume') addCause(state.causes, 'resume');
  if (reason === 'series' || data?.startsSeries === true) addCause(state.causes, 'series');
  for (const cause of changes) addCause(state.causes, cause);
  if (reason !== 'initial' && reason !== 'resume' && reason !== 'series' && changes.length === 0)
    addCause(state.causes, 'header');
  state.header = next;
}

/** DSH logs route metadata when it changes; the log's first one is no change. */
function onRoute(state: CacheChainState, data: Row | undefined): void {
  if (!data) return;
  const provider = stringOf(data.provider);
  const model = stringOf(data.model);
  const contextWindow = numberOf(data.contextWindow);
  const previous = state.route;
  if (
    previous &&
    (previous.provider !== provider ||
      previous.model !== model ||
      previous.contextWindow !== contextWindow)
  )
    addCause(state.causes, 'route');
  state.route = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * The older step whose cache this read reproduces, when it is not the step
 * before's: the request was served from another chain's cache.
 */
function matchOf(
  window: readonly CachedSize[],
  before: ChainStep,
  read: number
): CacheStepRef | undefined {
  if (read <= 0) return undefined;
  const tolerance = Math.max(MATCH_ABS, MATCH_RATIO * read);
  const near = (cached: number) => Math.abs(cached - read) <= tolerance;
  if (near(before.read + before.write)) return undefined;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const entry = window[index];
    if (entry.turn === before.turn && entry.step === before.step) continue;
    if (near(entry.cached)) return { turn: entry.turn, step: entry.step };
  }
  return undefined;
}

function recordStep(
  state: CacheChainState,
  data: Row | undefined,
  time: number | undefined,
  options: CacheChainOptions
): CacheStepVerdict | undefined {
  const usage = recordOf(data?.usage);
  const turn = numberOf(data?.turn);
  const step = numberOf(data?.step);
  // No usage (a step Stop cut): nothing to judge, and the chain goes on past it.
  if (!usage || turn === undefined || step === undefined) return undefined;
  const source = recordOf(recordOf(data?.message)?.source);
  const provider = stringOf(source?.provider);
  const model = stringOf(source?.model);
  const input = countOf(usage.inputTokens);
  const read = countOf(usage.cacheReadTokens);
  const write = countOf(usage.cacheWriteTokens);
  const prompt = input + read + write;
  const aware = options.cacheAware(provider, model) === true;
  const request = state.request;
  const startedAt =
    request?.turn === turn && request.step === step && request.startedAt !== undefined
      ? request.startedAt
      : time;
  const before = state.last;
  const gapMs =
    before?.startedAt !== undefined && startedAt !== undefined
      ? Math.max(0, startedAt - before.startedAt)
      : undefined;
  const causes = state.causes;
  state.causes = [];

  // Judged only against a followed step that cached something.
  const baseline = aware && before?.aware && before.read + before.write > 0 ? before : undefined;
  let kind: CacheStepKind = aware ? 'cold' : 'untracked';
  let lost = 0;
  let matched: CacheStepRef | undefined;
  if (baseline) {
    const ttl = numberOf(options.ttlMsFor(provider, model));
    if (gapMs !== undefined && gapMs > (ttl !== undefined && ttl > 0 ? ttl : DEFAULT_TTL_MS))
      addCause(causes, 'ttl-expired');
    const prevPrompt = baseline.prompt;
    lost = Math.max(0, prevPrompt - read);
    if (prompt < prevPrompt - Math.max(SHRINK_ABS, SHRINK_RATIO * prevPrompt)) {
      kind = baseline.turn === turn ? 'shrink' : 'turn-shrink';
    } else if (lost >= MIN_LOST && (lost >= REBUILD_ABS || lost >= REBUILD_RATIO * prevPrompt)) {
      kind = 'rebuild';
    } else {
      kind = 'warm';
    }
    matched = matchOf(state.window, baseline, read);
  }

  const verdict: CacheStepVerdict = {
    turn,
    step,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    prompt,
    read,
    write,
    input,
    ...(baseline ? { prevPrompt: baseline.prompt } : {}),
    lost,
    kind,
    explained: causes.length > 0,
    causes,
    ...(matched ? { matched } : {}),
    ...(gapMs !== undefined ? { gapMs } : {}),
  };

  if (aware && read + write > 0) {
    state.window.push({ turn, step, cached: read + write });
    if (state.window.length > MATCH_WINDOW)
      state.window.splice(0, state.window.length - MATCH_WINDOW);
  }
  state.last = {
    turn,
    step,
    prompt,
    read,
    write,
    aware,
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
  state.verdicts.push(verdict);
  if (state.verdicts.length > MAX_KEPT_VERDICTS)
    state.verdicts.splice(0, state.verdicts.length - MAX_KEPT_VERDICTS);

  const totals = state.totals;
  const lossy = kind === 'rebuild' || kind === 'shrink';
  totals.steps += 1;
  if (baseline) totals.evaluated += 1;
  if (kind === 'rebuild') totals.rebuilds += 1;
  if (kind === 'shrink') totals.shrinks += 1;
  if (lossy) totals.lostTokens += lost;
  if (isUnexplainedVerdict(verdict)) {
    totals.unexplained += 1;
    if (lossy) totals.unexplainedLostTokens += lost;
  }
  return verdict;
}

/** The chain of a whole log (events in seq order), as a fresh state. */
export function foldCacheChain(
  events: Iterable<CacheChainEvent>,
  options: CacheChainOptions
): CacheChainState {
  const state = initCacheChain();
  for (const event of events) applyCacheChain(state, event, options);
  return state;
}

/** Totals and kept verdicts as of now; later applies do not change it. */
export function viewCacheChain(state: CacheChainState): CacheChainView {
  return { totals: { ...state.totals }, verdicts: state.verdicts.slice() };
}

/** The newest step's verdict, if any step was recorded. */
export function lastStepVerdict(state: CacheChainState): CacheStepVerdict | undefined {
  return state.verdicts.at(-1);
}

/** A rebuild, a shrink, or a read of another chain's cache: shown, explained or not. */
export function isNotableVerdict(verdict: CacheStepVerdict): boolean {
  return verdict.kind === 'rebuild' || verdict.kind === 'shrink' || verdict.matched !== undefined;
}

/** A notable step no local event explains: what logs and alerts report. */
export function isUnexplainedVerdict(verdict: CacheStepVerdict): boolean {
  return isNotableVerdict(verdict) && !verdict.explained;
}

// ---- restore -----------------------------------------------------------------------

const TOTAL_KEYS: readonly (keyof CacheChainTotals)[] = [
  'steps',
  'evaluated',
  'rebuilds',
  'shrinks',
  'unexplained',
  'lostTokens',
  'unexplainedLostTokens',
];

function isCount(value: unknown): boolean {
  const count = numberOf(value);
  return count !== undefined && count >= 0;
}

function isRef(value: unknown): boolean {
  const row = recordOf(value);
  return !!row && numberOf(row.turn) !== undefined && numberOf(row.step) !== undefined;
}

function isCauseList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((cause) => (CACHE_CAUSES as readonly unknown[]).includes(cause))
  );
}

function isVerdict(value: unknown): boolean {
  const row = recordOf(value);
  return (
    !!row &&
    isRef(row) &&
    ['prompt', 'read', 'write', 'input', 'lost'].every((key) => isCount(row[key])) &&
    (CACHE_STEP_KINDS as readonly unknown[]).includes(row.kind) &&
    typeof row.explained === 'boolean' &&
    isCauseList(row.causes) &&
    (row.matched === undefined || isRef(row.matched))
  );
}

function isTime(value: unknown): boolean {
  return value === undefined || numberOf(value) !== undefined;
}

function isChainStep(value: unknown): boolean {
  const row = recordOf(value);
  return (
    !!row &&
    isRef(row) &&
    ['prompt', 'read', 'write'].every((key) => isCount(row[key])) &&
    typeof row.aware === 'boolean' &&
    isTime(row.startedAt)
  );
}

/**
 * A state read back from storage, or undefined when it is not one this build
 * wrote (another version, a damaged copy): the caller then starts from
 * `initCacheChain()` and folds the log again. Adopts `raw` itself.
 */
export function restoreCacheChain(raw: unknown): CacheChainState | undefined {
  const state = recordOf(raw);
  if (!state || state.version !== CACHE_CHAIN_STATE_VERSION) return undefined;
  const totals = recordOf(state.totals);
  const valid =
    typeof state.cursor === 'number' &&
    Number.isSafeInteger(state.cursor) &&
    state.cursor >= -1 &&
    typeof state.systemPrompt === 'boolean' &&
    Array.isArray(state.window) &&
    state.window.every((entry) => isRef(entry) && isCount(recordOf(entry)?.cached)) &&
    isCauseList(state.causes) &&
    Array.isArray(state.verdicts) &&
    state.verdicts.every(isVerdict) &&
    !!totals &&
    TOTAL_KEYS.every((key) => isCount(totals[key])) &&
    (state.last === undefined || isChainStep(state.last)) &&
    (state.request === undefined ||
      (isRef(state.request) && isTime(recordOf(state.request)?.startedAt))) &&
    (state.header === undefined || typeof recordOf(state.header)?.tools === 'string') &&
    (state.route === undefined || recordOf(state.route) !== undefined);
  return valid ? (state as unknown as CacheChainState) : undefined;
}
