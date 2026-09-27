// Thin re-export (dsh-rebase P1-9a): the history projection lives in src/shared/legacyPiSession/timeline.ts.
export {
  type PiHistorySessionManager,
  paginatePiSessionHistory,
  projectPiSessionHistory,
  readPiSessionHistoryPage,
} from '../shared/legacyPiSession/timeline.ts';
