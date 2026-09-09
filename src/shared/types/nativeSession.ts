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
  targetPath?: string;
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
