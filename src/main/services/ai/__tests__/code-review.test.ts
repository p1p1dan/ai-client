import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-15 (decision 125): the code review streams from the shared
 * DSH host (`dshCompletionService`). The repository reads, the prompt, the
 * 10 min deadline, the chunk / complete / error callbacks and Stop are what
 * they were; only the engine changed.
 */

const complete = vi.fn();
const cancel = vi.fn(() => true);
const spawnGit = vi.fn();

vi.mock('../../agent-host/DshCompletionService', () => ({
  dshCompletionService: { complete, cancel },
}));

vi.mock('../../git/runtime', () => ({ spawnGit }));

/** A finished process whose stdout is `out` (exit 0), or that fails (exit 1). */
function gitProcess(out: string | null) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    killed: false,
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    if (out !== null) proc.stdout.emit('data', Buffer.from(out));
    proc.emit('close', out === null ? 1 : 0);
  });
  return proc;
}

function answerGit(repo: { diff: string | null; log: string | null }): void {
  spawnGit.mockImplementation((_cwd: string, args: string[]) => {
    if (args.includes('symbolic-ref')) return gitProcess('refs/remotes/origin/main');
    if (args.includes('diff')) return gitProcess(repo.diff);
    if (args.includes('log')) return gitProcess(repo.log);
    return gitProcess(null);
  });
}

function callbacks() {
  return { onChunk: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
}

describe('startCodeReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answerGit({ diff: 'diff --git a/x b/x\n+new line', log: 'abc123 feat: x' });
  });

  it('streams a code-review completion from the DSH host under the review id, then completes', async () => {
    complete.mockImplementationOnce(async (request: { onDelta: (text: string) => void }) => {
      request.onDelta('Looks ');
      request.onDelta('fine.');
      return { text: 'Looks fine.', model: 'gw/m1' };
    });
    const { startCodeReview } = await import('../code-review');
    const cb = callbacks();

    await startCodeReview({
      workdir: '/repo',
      language: 'English',
      reviewId: 'review-1',
      model: 'gw/m1',
      effort: 'medium',
      ...cb,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      operationId: 'review-1',
      purpose: 'code-review',
      model: 'gw/m1',
      effort: 'medium',
      timeoutMs: 600_000,
    });
    expect(request).not.toHaveProperty('cwd');
    expect(request.prompt).toContain('Always reply in English.');
    expect(request.prompt).toContain('diff --git a/x b/x\n+new line');
    expect(request.prompt).toContain('abc123 feat: x');
    expect(cb.onChunk.mock.calls).toEqual([['Looks '], ['fine.']]);
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('asks nothing when there is nothing to review', async () => {
    answerGit({ diff: null, log: null });
    const { startCodeReview } = await import('../code-review');
    const cb = callbacks();

    await startCodeReview({ workdir: '/repo', language: 'English', reviewId: 'r', ...cb });

    expect(cb.onError).toHaveBeenCalledWith('No changes to review');
    expect(complete).not.toHaveBeenCalled();
  });

  it('reports a failed or unreachable engine through onError, as the panel shows it', async () => {
    complete.mockRejectedValueOnce(
      new Error('CREDENTIALS_UNAVAILABLE: the engine asked for the key and got none')
    );
    const { startCodeReview } = await import('../code-review');
    const cb = callbacks();

    await startCodeReview({ workdir: '/repo', language: 'English', reviewId: 'r2', ...cb });

    expect(cb.onError).toHaveBeenCalledWith(
      'CREDENTIALS_UNAVAILABLE: the engine asked for the key and got none'
    );
    expect(cb.onComplete).not.toHaveBeenCalled();
  });

  it('Stop cancels the running review by its id, and quit cancels every running one', async () => {
    let release!: () => void;
    complete.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () =>
            reject(Object.assign(new Error('cancelled'), { code: 'COMPLETION_CANCELLED' }));
        })
    );
    const { startCodeReview, stopAllCodeReviews, stopCodeReview } = await import('../code-review');
    const cb = callbacks();

    const running = startCodeReview({
      workdir: '/repo',
      language: '中文',
      reviewId: 'review-9',
      ...cb,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    stopAllCodeReviews();
    expect(cancel).toHaveBeenCalledWith('review-9');
    stopCodeReview('review-9');
    expect(cancel).toHaveBeenCalledTimes(2);
    release();
    await running;
    expect(cb.onError).toHaveBeenCalledWith('cancelled');
    // Settled: nothing is left for quit to cancel.
    cancel.mockClear();
    stopAllCodeReviews();
    expect(cancel).not.toHaveBeenCalled();
  });
});
