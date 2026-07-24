/** Persisted chat session index entry (Main-side, survives restart). */
export interface SessionIndexEntry {
  sessionId: string;
  /** Claude runtime session id once known (enables resume). */
  runtimeIdentity?: string;
  workspacePath: string;
  title: string;
  model?: string;
  /** Epoch ms of last meaningful activity (create/resume/turn end/rename/archive). */
  updatedAt: number;
  archived: boolean;
}
