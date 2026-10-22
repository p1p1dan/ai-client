import { SessionLiveJournal } from './sessionLiveJournal';

export type { JournalCatchUp, JournalEntry, SessionLiveSnapshot } from './sessionLiveJournal';

/** The one journal of this process, fed from app start (`ipc/remoteAccess.ts`). */
export const sessionLiveJournal = new SessionLiveJournal();
