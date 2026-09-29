import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-15 (decision 125): the commit message is a one-shot completion
 * on the shared DSH host (`dshCompletionService`). The repository reads, the
 * prompt and the fence stripping are what they were; only the engine changed.
 */

const complete = vi.fn();
const execSync = vi.fn();

vi.mock('../../agent-host/DshCompletionService', () => ({
  dshCompletionService: { complete },
}));

vi.mock('node:child_process', () => ({ execSync }));

vi.mock('../../git/runtime', () => ({
  isWslGitRepository: () => false,
  spawnGit: vi.fn(() => {
    throw new Error('no WSL repository in these tests');
  }),
}));

const DIFF = ['diff --git a/a.ts b/a.ts', '+one', '+two', '+three'].join('\n');

function answerGit(): void {
  execSync.mockImplementation((command: string) => {
    if (command.includes('log -5')) return 'feat: earlier\nfix: before\n';
    if (command.includes('--stat')) return ' a.ts | 3 +++\n';
    if (command.includes('diff --cached')) return `${DIFF}\n`;
    return '';
  });
}

describe('generateCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answerGit();
  });

  it('asks the DSH host for a commit-message completion built from the staged diff', async () => {
    complete.mockResolvedValueOnce({ text: '```\nfeat: add three lines\n```', model: 'gw/m1' });
    const { generateCommitMessage } = await import('../commit-message');

    const result = await generateCommitMessage({
      workdir: '/repo',
      maxDiffLines: 2,
      timeout: 45,
      model: 'gw/m1',
      effort: 'off',
    });

    expect(result).toEqual({ success: true, message: 'feat: add three lines' });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      purpose: 'commit-message',
      model: 'gw/m1',
      effort: 'off',
      timeoutMs: 45_000,
    });
    expect(Object.keys(request).sort()).toEqual([
      'effort',
      'model',
      'prompt',
      'purpose',
      'timeoutMs',
    ]);
    // The 1.0.x prompt: the recent subjects, the stat, the diff cut to maxDiffLines.
    expect(request.prompt).toContain('feat: earlier\nfix: before');
    expect(request.prompt).toContain('a.ts | 3 +++');
    expect(request.prompt).toContain('diff --git a/a.ts b/a.ts\n+one');
    expect(request.prompt).not.toContain('+two');
  });

  it('fills a custom template once, without re-reading placeholders from the diff', async () => {
    execSync.mockImplementation((command: string) =>
      command.includes('diff --cached') && !command.includes('--stat') ? '+{recent_commits}' : ''
    );
    complete.mockResolvedValueOnce({ text: 'chore: x' });
    const { generateCommitMessage } = await import('../commit-message');

    await generateCommitMessage(
      {
        workdir: '/repo',
        maxDiffLines: 10,
        timeout: 30,
        prompt: 'P: {staged_diff} | {recent_commits}',
      },
      { complete }
    );

    expect(complete.mock.calls[0]?.[0].prompt).toBe('P: +{recent_commits} | (no recent commits)');
  });

  it('reports a timeout as `timeout`, which the commit box shows as "Generation timed out"', async () => {
    complete.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'COMPLETION_TIMEOUT' })
    );
    const { generateCommitMessage } = await import('../commit-message');

    const result = await generateCommitMessage({ workdir: '/repo', maxDiffLines: 10, timeout: 1 });

    expect(result).toEqual({ success: false, error: 'timeout' });
  });

  it('reports the engine’s failure as its coded sentence', async () => {
    complete.mockRejectedValueOnce(
      new Error('DSH_HOST_UNAVAILABLE: the DSH host went down 4 times within 5 min')
    );
    const { generateCommitMessage } = await import('../commit-message');

    const result = await generateCommitMessage({ workdir: '/repo', maxDiffLines: 10, timeout: 1 });

    expect(result).toEqual({
      success: false,
      error: 'DSH_HOST_UNAVAILABLE: the DSH host went down 4 times within 5 min',
    });
  });
});
