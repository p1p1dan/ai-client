import type { RuntimeEventDraft } from './runtimeEvents';
import type { HistoryMessage, PiLeafCheckpoint } from './sessionHistory';

/** Main control surface; a worker RPC adapter maps cancellation without importing Pi. */
export interface NativeSessionMetadata {
  id: string;
  file: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt: number;
  sourceFile?: string;
  leaf: PiLeafCheckpoint;
}
export interface NativeIndexedRunRequest {
  prompt: string;
  systemPrompt?: string;
  // T025 removed `targetPath`. It mirrored `RuntimeRunRequest.targetPath`, which
  // decision 007 deleted along with the root→leaf instruction walk it fed; the
  // adapter only ever spread this object through, so nothing set it and nothing
  // read it. The identically named field on the subagent migration preview
  // (`src/shared/subagentMigration.ts`) is a real destination path — different
  // thing, still in use.
  model?: { provider: string; id: string };
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  runId?: string;
  logicalSessionId?: string;
  signal?: AbortSignal;
}
export interface NativeSessionIndexClient {
  run(
    request: NativeIndexedRunRequest
  ): Promise<{ runId: string; success: boolean; error?: { code: string; message: string } }>;
  events: { subscribe(listener: (event: RuntimeEventDraft) => void): () => void };
  session?: {
    metadata(): NativeSessionMetadata;
    history(): HistoryMessage[];
    rewind(
      entryId: string,
      confirmed: boolean
    ): Promise<NativeSessionMetadata & { editorText?: string }>;
    fork(file: string, entryId: string): Promise<NativeSessionMetadata>;
    discardFork(file: string, id: string): Promise<void>;
    acceptFork(file: string): void;
    rename(name: string | undefined): Promise<void>;
    navigate(entryId: string | null): Promise<unknown>;
  };
}
