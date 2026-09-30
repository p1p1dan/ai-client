import type {
  DshGoalActivation,
  DshGoalProjection,
  DshJobSummary,
  DshSubagentCatalogEntry,
  DshTodoItem,
  RuntimeEvent,
  SessionProjectionKey,
  SessionProjectionPayload,
} from '@shared/types/runtimeEvents';

/**
 * dsh-rebase P1-7a (decisions 068 as revised by 109, 072, 113, 118): the pure
 * half of the goal bar and the todo card above the composer.
 *
 * The data is DSH's own: the `todos`, `goal` and `subagentCatalog` session
 * projections and the bridge's `goalActivation`, which arrive as
 * `session.projection` events (a later value of a key replaces the earlier
 * one) and, for a renderer that missed them, as one `worker.panels` answer.
 * This module folds both per session and derives what the two strips show;
 * `stores/sessionPanels.ts` is the zustand shell around it, and nothing here
 * touches the red-line `chatSessions.ts`.
 *
 * ## Why a rehydration answer can lose to an event
 *
 * The answer to `worker.panels` travels on the invoke reply, the events on the
 * event channel; nothing orders the two. An answer read before a change can
 * land after it. So each key counts the live events it has had, the caller
 * takes that count when it asks, and the answer fills only the keys no event
 * reached since — an event is never older than an answer that arrived later.
 */

/** One session's panels; `undefined` for a key nothing has said anything about. */
export interface SessionPanels {
  todos?: DshTodoItem[] | null;
  goal?: DshGoalProjection | null;
  goalActivation?: DshGoalActivation | null;
  subagentCatalog?: DshSubagentCatalogEntry[];
  /** P1-7b: the session's background jobs (the bridge's `jobs`); the jobs window reads them. */
  jobs?: DshJobSummary[];
  /**
   * P1-7e (problem 17, decision 142): the jobs a worker that went away still
   * listed, kept by this window so the rows stay after the next worker's list
   * replaces `jobs` — until the user removes them. Window-local, never sent.
   */
  formerJobs?: FormerJob[];
  /**
   * How many of this session's workers went away while this window watched.
   * DSH numbers jobs per worker (`bash-2` comes back after a restart), so a
   * job is told apart by the worker it ran on (`jobHideKey`).
   */
  workerEpoch?: number;
  /**
   * P1-7e (problem 5, decision 142): the goal revision a resume produced.
   * DSH arms every goal it resumes and says so in a separate activation
   * edge right after the goal's own change; until that edge is here, the
   * activation this window holds is the one from before the resume.
   */
  resumedGoal?: { goalId: string; revision: number };
  /**
   * A live worker spoke for this session: an event came in, or a rehydration
   * answered with something. Cleared when the session's connection goes. The
   * strips offer their buttons only while it holds — a command needs a worker
   * — and an active goal with no live worker is one nothing continues.
   */
  live: boolean;
  /** Live events per key, for the ordering rule in the header. */
  seq: Partial<Record<SessionProjectionKey, number>>;
}

/** A job the session's previous worker listed, and which worker that was. */
export interface FormerJob extends DshJobSummary {
  epoch: number;
}

/** How many former jobs a session keeps (the bridge keeps the newest 8 ended jobs too). */
export const FORMER_JOBS_KEPT = 8;

/**
 * The key the jobs window's 「移除」 remembers a job by: its id on the first
 * worker (what it always was), `<epoch>:<id>` on a later one, so hiding a job
 * never hides another worker's job of the same number.
 */
export function jobHideKey(epoch: number, jobId: string): string {
  return epoch === 0 ? jobId : `${epoch}:${jobId}`;
}

export interface SessionPanelsState {
  bySession: Record<string, SessionPanels>;
}

export const initialSessionPanels: SessionPanelsState = { bySession: {} };

const EMPTY_PANELS: SessionPanels = { live: false, seq: {} };

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);
const GOAL_PHASES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'complete']);

function readTodos(view: unknown): DshTodoItem[] | null | undefined {
  if (view === null) return null;
  if (!Array.isArray(view)) return undefined;
  return view.filter(
    (item): item is DshTodoItem =>
      isRecord(item) && typeof item.content === 'string' && TODO_STATUSES.has(String(item.status))
  );
}

function readGoal(view: unknown): DshGoalProjection | null | undefined {
  if (view === null) return null;
  if (!isRecord(view) || !isRecord(view.goal)) return undefined;
  const goal = view.goal;
  if (
    typeof goal.id !== 'string' ||
    typeof goal.revision !== 'number' ||
    typeof goal.objective !== 'string' ||
    !GOAL_PHASES.has(String(goal.phase)) ||
    typeof goal.maxGoalRounds !== 'number' ||
    typeof view.roundsStarted !== 'number'
  ) {
    return undefined;
  }
  return view as unknown as DshGoalProjection;
}

function readActivation(view: unknown): DshGoalActivation | null | undefined {
  if (view === null) return null;
  if (
    !isRecord(view) ||
    typeof view.goalId !== 'string' ||
    typeof view.revision !== 'number' ||
    (view.activation !== 'armed' && view.activation !== 'disarmed')
  ) {
    return undefined;
  }
  return view as unknown as DshGoalActivation;
}

const JOB_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'stopping',
  'completed',
  'killed',
  'failed',
]);

function readJobs(view: unknown): DshJobSummary[] | undefined {
  if (!Array.isArray(view)) return undefined;
  return view.filter(
    (job): job is DshJobSummary =>
      isRecord(job) &&
      typeof job.id === 'string' &&
      typeof job.kind === 'string' &&
      typeof job.label === 'string' &&
      JOB_STATUSES.has(String(job.status)) &&
      typeof job.startedAt === 'number'
  );
}

function readCatalog(view: unknown): DshSubagentCatalogEntry[] | undefined {
  if (!Array.isArray(view)) return undefined;
  return view.filter(
    (entry): entry is DshSubagentCatalogEntry => isRecord(entry) && typeof entry.id === 'string'
  );
}

/** The panels with one key replaced; the same object when the view is not one this key takes. */
function withProjection(panels: SessionPanels, payload: SessionProjectionPayload): SessionPanels {
  switch (payload.key) {
    case 'todos': {
      const todos = readTodos(payload.view);
      return todos === undefined ? panels : { ...panels, todos };
    }
    case 'goal': {
      const goal = readGoal(payload.view);
      if (goal === undefined) return panels;
      const resumedGoal = resumedGoalOf(panels.goal, goal);
      return resumedGoal ? { ...panels, goal, resumedGoal } : { ...panels, goal };
    }
    case 'goalActivation': {
      const goalActivation = readActivation(payload.view);
      return goalActivation === undefined ? panels : { ...panels, goalActivation };
    }
    case 'subagentCatalog': {
      const subagentCatalog = readCatalog(payload.view);
      return subagentCatalog === undefined ? panels : { ...panels, subagentCatalog };
    }
    case 'jobs': {
      const jobs = readJobs(payload.view);
      return jobs === undefined ? panels : { ...panels, jobs };
    }
    default:
      return panels;
  }
}

/**
 * P1-7e (problem 5, decision 142): a goal that went from paused or blocked to
 * active was resumed — DSH's only way back to `active` — and DSH arms every
 * resume (`GoalService.resume` commits `armed`). Its goal change and its
 * activation edge are two events; this marks the revision in between.
 */
function resumedGoalOf(
  previous: DshGoalProjection | null | undefined,
  next: DshGoalProjection | null
): SessionPanels['resumedGoal'] {
  if (!previous || !next) return undefined;
  const before = previous.goal;
  const after = next.goal;
  if (before.id !== after.id || after.revision <= before.revision) return undefined;
  if (after.phase !== 'active' || (before.phase !== 'paused' && before.phase !== 'blocked')) {
    return undefined;
  }
  return { goalId: after.id, revision: after.revision };
}

/**
 * P1-7e (problem 17, decision 142): the worker went away. What it listed moves
 * to `formerJobs`, stamped with the worker it ran on, and `jobs` is emptied for
 * the next worker's list. A running job is gone with its worker: its row reads
 * 「引擎重启，任务已结束」 until the user removes it.
 */
function withWorkerGone(panels: SessionPanels): SessionPanels {
  const epoch = panels.workerEpoch ?? 0;
  const carried = (panels.jobs ?? []).map((job) => ({ ...job, epoch }));
  return {
    ...panels,
    live: false,
    workerEpoch: epoch + 1,
    ...(carried.length > 0
      ? {
          jobs: [],
          formerJobs: [...(panels.formerJobs ?? []), ...carried].slice(-FORMER_JOBS_KEPT),
        }
      : {}),
  };
}

function withSession(
  state: SessionPanelsState,
  sessionId: string,
  panels: SessionPanels
): SessionPanelsState {
  return { bySession: { ...state.bySession, [sessionId]: panels } };
}

/**
 * The live fold. `session.projection` replaces its key and marks the session
 * live; a `disconnected` status (the slot reclaimed, the engine restarted)
 * marks it not live. Every other event returns `state` itself.
 */
export function reduceSessionPanels(
  state: SessionPanelsState,
  event: RuntimeEvent
): SessionPanelsState {
  if (event.type === 'session.projection') {
    const current = state.bySession[event.sessionId] ?? EMPTY_PANELS;
    const key = event.payload.key;
    const next = withProjection(current, event.payload);
    return withSession(state, event.sessionId, {
      ...next,
      live: true,
      seq: { ...current.seq, [key]: (current.seq[key] ?? 0) + 1 },
    });
  }
  if (event.type === 'session.status' && event.payload.status === 'disconnected') {
    const current = state.bySession[event.sessionId];
    if (!current?.live) return state;
    return withSession(state, event.sessionId, withWorkerGone(current));
  }
  return state;
}

/** What a rehydration request carries back: each key's event count when it was asked. */
export type PanelsMark = Partial<Record<SessionProjectionKey, number>>;

export function panelsMark(state: SessionPanelsState, sessionId: string): PanelsMark {
  return { ...(state.bySession[sessionId]?.seq ?? {}) };
}

/**
 * A `worker.panels` answer: each key no event reached since `mark` is taken.
 * An answer with anything in it means a live worker holds the session; an
 * empty one (no running slot) leaves what is known and says nothing is live.
 */
export function applyPanelsSnapshot(
  state: SessionPanelsState,
  sessionId: string,
  projections: readonly SessionProjectionPayload[],
  mark: PanelsMark
): SessionPanelsState {
  const current = state.bySession[sessionId] ?? EMPTY_PANELS;
  // An event since the ask came from a live worker: an empty answer from
  // before it (a slot still starting) does not take that back.
  const heardSince = (Object.keys(current.seq) as SessionProjectionKey[]).some(
    (key) => (current.seq[key] ?? 0) !== (mark[key] ?? 0)
  );
  let next: SessionPanels = {
    ...current,
    live: projections.length > 0 || (heardSince && current.live),
  };
  for (const payload of projections) {
    if ((current.seq[payload.key] ?? 0) !== (mark[payload.key] ?? 0)) continue;
    next = withProjection(next, payload);
  }
  if (!state.bySession[sessionId] && projections.length === 0) return state;
  return withSession(state, sessionId, next);
}

export function pruneSessionPanels(
  state: SessionPanelsState,
  sessionIds: readonly string[]
): SessionPanelsState {
  const live = new Set(sessionIds);
  const kept = Object.entries(state.bySession).filter(([sessionId]) => live.has(sessionId));
  return kept.length === Object.keys(state.bySession).length
    ? state
    : { bySession: Object.fromEntries(kept) };
}

// ---- the goal bar -------------------------------------------------------------

/**
 * The goal bar's states (plan P1-7 shard 03 §2; the prototype draws four of
 * them — running, paused, suspended, round limit — in the look every state
 * shares). There is no "paused by an interjection": since decision 093 a
 * Ctrl+Enter message joins the running round and the goal carries on
 * (decision 111).
 */
export type GoalBarState =
  /** Active and armed, a turn in flight. */
  | 'running'
  /** Active and armed, between rounds: the engine starts the next one when idle. */
  | 'waiting'
  /** Active but disarmed: reopened, rewound, forked, stopped outside a round, or no live worker. */
  | 'suspended'
  | 'paused'
  /** Blocked for any reason but its round budget (`model-reported`, …). */
  | 'blocked'
  /** Blocked on its round budget (`round-limit`). */
  | 'roundLimit'
  | 'complete';

export type GoalBarAction = 'pause' | 'resume' | 'dismiss';

export interface GoalBarView {
  state: GoalBarState;
  goalId: string;
  revision: number;
  objective: string;
  /** Rounds admitted so far, and the budget. */
  round: number;
  maxRounds: number;
  /** The engine's reason, when blocked. */
  blockedMessage?: string;
  createdAt: number;
  updatedAt: number;
  /** The one button beside the menu; none on a goal no live worker holds. */
  action: GoalBarAction | null;
  /**
   * Resume is offered but cannot be taken: the round budget is spent (DSH
   * refuses a resume without room). The engine can raise it; a person can clear.
   */
  actionDisabled: boolean;
  /** A live worker holds the session: the menu's edit and clear can run. */
  controls: boolean;
}

/**
 * What the goal bar shows for one session, or null for no bar. `turnInFlight`
 * is the session's own status (`isTurnInFlight`), the difference between
 * "running" and "waiting for the next round". `dismissedKey` is the complete
 * goal this window was told to put away (`goalDismissKey`): the bar comes back
 * with the next change of the goal.
 */
export function deriveGoalBarView(
  panels: SessionPanels | undefined,
  turnInFlight: boolean,
  dismissedKey?: string
): GoalBarView | null {
  const projection = panels?.goal;
  if (!panels || !projection) return null;
  const goal = projection.goal;
  const base = {
    goalId: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    round: projection.roundsStarted,
    maxRounds: goal.maxGoalRounds,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    controls: panels.live,
  };
  const live = panels.live;
  const noRoomLeft = projection.roundsStarted >= goal.maxGoalRounds;
  switch (goal.phase) {
    case 'active': {
      const held = panels.goalActivation?.goalId === goal.id ? panels.goalActivation : undefined;
      // P1-7e (problem 5): the goal was just resumed and the activation held
      // is still the one from before — DSH's armed edge is the next event.
      const resumed =
        panels.resumedGoal?.goalId === goal.id &&
        panels.resumedGoal.revision === goal.revision &&
        held !== undefined &&
        held.revision < goal.revision;
      const activation = resumed ? 'armed' : held?.activation;
      // Unknown activation on a live worker reads as armed: the bridge sends
      // it with every goal it reports, so "unknown" is only ever a moment.
      if (!live || activation === 'disarmed') {
        return {
          ...base,
          state: 'suspended',
          action: live ? 'resume' : null,
          actionDisabled: noRoomLeft,
        };
      }
      return {
        ...base,
        state: turnInFlight ? 'running' : 'waiting',
        action: 'pause',
        actionDisabled: false,
      };
    }
    case 'paused':
      return {
        ...base,
        state: 'paused',
        action: live ? 'resume' : null,
        actionDisabled: noRoomLeft,
      };
    case 'blocked': {
      const roundLimit = goal.blockedReason?.code === 'round-limit';
      return {
        ...base,
        state: roundLimit ? 'roundLimit' : 'blocked',
        ...(goal.blockedReason?.message ? { blockedMessage: goal.blockedReason.message } : {}),
        action: live ? 'resume' : null,
        actionDisabled: noRoomLeft,
      };
    }
    case 'complete':
      if (dismissedKey === goalDismissKey(goal.id, goal.revision)) return null;
      return { ...base, state: 'complete', action: 'dismiss', actionDisabled: false };
    default:
      return null;
  }
}

/** The key a dismissed complete goal is remembered by: its id and revision. */
export function goalDismissKey(goalId: string, revision: number): string {
  return `${goalId}#${revision}`;
}

/**
 * The `/goal` line each control runs through `worker.command` (DSH's own
 * grammar, `dsh-command-goal`). Editing takes the objective as typed; a
 * leading or trailing blank is DSH's to trim.
 */
export function goalCommandLine(
  action: 'pause' | 'resume' | 'clear' | 'edit',
  objective?: string
): string {
  return action === 'edit' ? `/goal edit ${objective ?? ''}` : `/goal ${action}`;
}

// ---- the todo card ------------------------------------------------------------

export interface TodoCardView {
  items: DshTodoItem[];
  done: number;
  total: number;
  /** What is in progress, in list order. */
  current: string[];
  /** The first item not started, when nothing is in progress. */
  next?: string;
  allDone: boolean;
}

/**
 * The todo card for one session, or null for no card: DSH clears the list
 * when a turn starts (`null`) and keeps a finished one until the next turn,
 * so an empty or cleared list shows nothing.
 */
export function deriveTodoCardView(panels: SessionPanels | undefined): TodoCardView | null {
  const items = panels?.todos;
  if (!items || items.length === 0) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  const current = items.filter((item) => item.status === 'in_progress').map((item) => item.content);
  const next =
    current.length === 0 ? items.find((item) => item.status === 'pending')?.content : undefined;
  return {
    items,
    done,
    total: items.length,
    current,
    ...(next !== undefined ? { next } : {}),
    allDone: done === items.length,
  };
}
