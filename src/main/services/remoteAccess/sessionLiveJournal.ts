import type {
  PermissionRequestedEvent,
  QuestionRequestedEvent,
  RuntimeEvent,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';

/**
 * Issue #25 — what a client that connects late, or reconnects, needs in order
 * to show a session at the same point as the window already watching it.
 *
 * Two views over the one event stream the windows receive:
 * - per session: the prompts still waiting for an answer, and every event
 *   since the session last settled (the turn in flight). A late joiner reads
 *   the history first, then replays these; history rows name the live message
 *   they correspond to (`liveMessageId`), so the two merge without duplicates.
 * - across sessions: a bounded log keyed by a cursor, so a client that dropped
 *   for a moment asks for what it missed instead of reloading everything.
 *
 * Pure and process-local: nothing here survives a restart, and nothing needs
 * to — after a restart the sessions are not running either.
 */

export interface JournalEntry {
  cursor: number;
  event: RuntimeEvent;
}

export interface SessionLiveSnapshot {
  status: SessionRuntimeStatus | undefined;
  /** Asked and not yet answered, oldest first. */
  pendingPermissions: PermissionRequestedEvent[];
  pendingQuestions: QuestionRequestedEvent[];
  /** Every event since the session last settled, oldest first. */
  turn: JournalEntry[];
  /** The turn outgrew its buffer; replaying `turn` alone would leave a hole. */
  turnTruncated: boolean;
}

export type JournalCatchUp = { entries: JournalEntry[] } | { gap: true };

export interface SessionLiveJournalOptions {
  /** Entries the cross-session log keeps. */
  logCapacity?: number;
  /** Entries one session's turn buffer keeps. */
  turnCapacity?: number;
}

const DEFAULT_LOG_CAPACITY = 5000;
const DEFAULT_TURN_CAPACITY = 3000;

/**
 * Not journalled: a history page answers one client's request and is large;
 * a client that missed one asks again. Stderr lines are diagnostics.
 */
const UNJOURNALLED = new Set<RuntimeEvent['type']>(['session.history', 'session.stderr']);

/** Statuses at which the turn in flight is over and its events are history. */
const SETTLED = new Set<SessionRuntimeStatus>(['idle', 'completed', 'failed', 'disconnected']);

interface SessionState {
  status: SessionRuntimeStatus | undefined;
  permissions: Map<string, PermissionRequestedEvent>;
  questions: Map<string, QuestionRequestedEvent>;
  turn: JournalEntry[];
  turnTruncated: boolean;
}

export class SessionLiveJournal {
  private readonly logCapacity: number;
  private readonly turnCapacity: number;
  private readonly log: JournalEntry[] = [];
  private readonly sessions = new Map<string, SessionState>();
  private lastCursor = 0;

  constructor(options: SessionLiveJournalOptions = {}) {
    this.logCapacity = options.logCapacity ?? DEFAULT_LOG_CAPACITY;
    this.turnCapacity = options.turnCapacity ?? DEFAULT_TURN_CAPACITY;
  }

  /** The cursor of the newest entry; 0 before the first. */
  get cursor(): number {
    return this.lastCursor;
  }

  /** Journal one event; returns its cursor, or `undefined` when it is not journalled. */
  record(event: RuntimeEvent): number | undefined {
    if (UNJOURNALLED.has(event.type)) return undefined;
    this.lastCursor += 1;
    const entry: JournalEntry = { cursor: this.lastCursor, event };
    this.log.push(entry);
    if (this.log.length > this.logCapacity) this.log.splice(0, this.log.length - this.logCapacity);
    if (event.sessionId) this.recordForSession(event.sessionId, entry);
    return entry.cursor;
  }

  /** Everything after `cursor`, or `gap` when part of it has been dropped. */
  since(cursor: number): JournalCatchUp {
    if (cursor >= this.lastCursor) return { entries: [] };
    const oldest = this.log[0]?.cursor;
    if (oldest === undefined || cursor < oldest - 1) return { gap: true };
    return { entries: this.log.slice(cursor - oldest + 1) };
  }

  snapshot(sessionId: string): SessionLiveSnapshot {
    const state = this.sessions.get(sessionId);
    return {
      status: state?.status,
      pendingPermissions: state ? [...state.permissions.values()] : [],
      pendingQuestions: state ? [...state.questions.values()] : [],
      turn: state ? [...state.turn] : [],
      turnTruncated: state?.turnTruncated ?? false,
    };
  }

  /** Drop a session's state (closed or archived); the cross-session log keeps its entries. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private recordForSession(sessionId: string, entry: JournalEntry): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        status: undefined,
        permissions: new Map(),
        questions: new Map(),
        turn: [],
        turnTruncated: false,
      };
      this.sessions.set(sessionId, state);
    }
    const { event } = entry;
    switch (event.type) {
      case 'permission.requested':
        state.permissions.set(event.payload.permissionId, event);
        break;
      case 'permission.resolved':
        state.permissions.delete(event.payload.permissionId);
        break;
      case 'question.requested':
        state.questions.set(event.payload.questionId, event);
        break;
      case 'question.resolved':
        state.questions.delete(event.payload.questionId);
        break;
      default:
        break;
    }
    if (event.type === 'session.status' && SETTLED.has(event.payload.status)) {
      // The turn is over: what it said is in the history now, and a prompt
      // nobody answered went with it.
      state.status = event.payload.status;
      state.turn = [];
      state.turnTruncated = false;
      state.permissions.clear();
      state.questions.clear();
      return;
    }
    if (event.type === 'session.status') state.status = event.payload.status;
    if (state.turn.length >= this.turnCapacity) {
      state.turnTruncated = true;
      return;
    }
    state.turn.push(entry);
  }
}
