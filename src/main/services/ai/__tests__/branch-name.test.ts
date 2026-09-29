import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A model wrapping its answer in a ``` fence is a common output shape, and
 * left in place the fence characters land verbatim in a git branch name.
 * `commit-message.ts` already strips it (`stripCodeFence`); this pins that
 * `branch-name.ts` does the same rather than only `.trim()`-ing.
 *
 * dsh-rebase P1-15 (decision 125): the completion runs on the shared DSH host
 * through `dshCompletionService`, never the native utility worker.
 */

const complete = vi.fn();

vi.mock('../../agent-host/DshCompletionService', () => ({
  dshCompletionService: { complete },
}));

describe('generateBranchName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the DSH host for a branch-name completion with the prompt, model, effort and 120 s', async () => {
    complete.mockResolvedValueOnce({ text: 'feat/add-thing' });
    const { generateBranchName } = await import('../branch-name');

    await generateBranchName({
      workdir: '/repo',
      prompt: 'name a branch',
      model: 'gw/m1',
      effort: 'low',
    });

    expect(complete).toHaveBeenCalledWith({
      purpose: 'branch-name',
      prompt: 'name a branch',
      model: 'gw/m1',
      effort: 'low',
      timeoutMs: 120_000,
    });
  });

  it('strips a fenced completion down to the bare branch name', async () => {
    complete.mockResolvedValueOnce({ text: '```\nfeat/add-thing\n```' });
    const { generateBranchName } = await import('../branch-name');

    const result = await generateBranchName({ workdir: '/repo', prompt: 'name a branch' });

    expect(result).toEqual({ success: true, branchName: 'feat/add-thing' });
    expect(result.branchName).not.toContain('`');
  });

  it('strips a fence that also carries a language tag', async () => {
    complete.mockResolvedValueOnce({ text: '```text\nfix/thing\n```' });
    const { generateBranchName } = await import('../branch-name');

    const result = await generateBranchName({ workdir: '/repo', prompt: 'name a branch' });

    expect(result).toEqual({ success: true, branchName: 'fix/thing' });
  });

  it('leaves an unfenced completion unchanged apart from trimming', async () => {
    complete.mockResolvedValueOnce({ text: '  feat/add-thing  \n' });
    const { generateBranchName } = await import('../branch-name');

    const result = await generateBranchName({ workdir: '/repo', prompt: 'name a branch' });

    expect(result).toEqual({ success: true, branchName: 'feat/add-thing' });
  });

  it('reports failure when the completion call rejects', async () => {
    complete.mockRejectedValueOnce(new Error('boom'));
    const { generateBranchName } = await import('../branch-name');

    const result = await generateBranchName({ workdir: '/repo', prompt: 'name a branch' });

    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('reports a timeout as `timeout`, which the dialog shows as "Generation timed out"', async () => {
    // What DshCompletionService rejects with at its deadline.
    complete.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'COMPLETION_TIMEOUT' })
    );
    const { generateBranchName } = await import('../branch-name');

    const result = await generateBranchName({ workdir: '/repo', prompt: 'name a branch' });

    expect(result).toEqual({ success: false, error: 'timeout' });
  });
});
