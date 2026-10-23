import type {
  PermissionRequestedEvent,
  QuestionRequestedEvent,
  RuntimeEvent,
  SessionRuntimeStatus,
} from './runtimeEvents.ts';

/** One journalled runtime event and its cursor (issue #25, `SessionLiveJournal`). */
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
