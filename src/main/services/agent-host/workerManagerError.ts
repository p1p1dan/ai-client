/**
 * The error `WorkerManager` refuses with: `code` is what the renderer branches
 * on (`chat.ts` carries it across IPC as `<code>: <message>`).
 *
 * Its own module so the engine seams (`claudeSdkEngine.ts`) can throw it
 * without importing the manager; `WorkerManager.ts` re-exports it.
 */
export class WorkerManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'WorkerManagerError';
  }
}
