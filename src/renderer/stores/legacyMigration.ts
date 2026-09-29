/**
 * dsh-rebase P1-9e (decisions 050, 122 rule 15, 123) — what this window knows
 * about a legacy chat being moved to the current engine.
 *
 * Main reports a migration through the one resume call that performs it: the
 * call is still pending while the migration runs, resolves with a summary when
 * it is done, and rejects with `legacy_migration_failed:<stage>/<code>` when it
 * failed. So "migrating" is exactly "this window has a resume in flight for a
 * chat that will migrate on it", and only the window that asked knows it
 * (decision 123 rule 5). Counted rather than flagged: two resumes of the same
 * chat can overlap (a Retry while a send's resume is pending), and Main joins
 * them into one migration — the first to settle must not clear the other.
 *
 * `postureRevisions` is how the composer's permission chip learns that a
 * migration brought the chat up on the posture its 1.0.x file recorded
 * (`legacyPermissionsApplied`): the chip reads its value from storage when its
 * session changes, and this revision is the second reason to read it again.
 *
 * Not persisted: both facts are about calls in flight in this run.
 */
import { create } from 'zustand';

interface LegacyMigrationState {
  /** Resumes in flight that migrate their chat, per session id. */
  migrating: Readonly<Record<string, number>>;
  /** Bumped when a migration wrote the session's permission posture. */
  postureRevisions: Readonly<Record<string, number>>;
  begin: (sessionId: string) => void;
  end: (sessionId: string) => void;
  notePostureSynced: (sessionId: string) => void;
}

export const useLegacyMigrationStore = create<LegacyMigrationState>((set) => ({
  migrating: {},
  postureRevisions: {},
  begin: (sessionId) =>
    set((state) => ({
      migrating: { ...state.migrating, [sessionId]: (state.migrating[sessionId] ?? 0) + 1 },
    })),
  end: (sessionId) =>
    set((state) => {
      const count = state.migrating[sessionId] ?? 0;
      if (count === 0) return state;
      const migrating = { ...state.migrating };
      if (count === 1) delete migrating[sessionId];
      else migrating[sessionId] = count - 1;
      return { migrating };
    }),
  notePostureSynced: (sessionId) =>
    set((state) => ({
      postureRevisions: {
        ...state.postureRevisions,
        [sessionId]: (state.postureRevisions[sessionId] ?? 0) + 1,
      },
    })),
}));

/** This window is moving the chat to the current engine right now. */
export function selectIsMigrating(
  state: Pick<LegacyMigrationState, 'migrating'>,
  sessionId: string | null | undefined
): boolean {
  return sessionId != null && (state.migrating[sessionId] ?? 0) > 0;
}
