import type { CommonAICompletionOptions } from '@shared/types/ai';
import {
  type DshCompletionService,
  dshCompletionService,
} from '../agent-host/DshCompletionService';
import { spawnGit } from '../git/runtime';

export interface CodeReviewOptions extends CommonAICompletionOptions {
  workdir: string;
  language: string;
  reviewId: string;
  prompt?: string;
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

const activeReviewIds = new Set<string>();

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawnGit(cwd, args, { cwd });
    const timeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      resolve('');
    }, 10_000);
    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 ? stdout.trim() : '');
    });
  });
}

async function getDefaultBranch(workdir: string): Promise<string> {
  const ref = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], workdir);
  return ref.match(/refs\/remotes\/origin\/(.+)$/)?.[1] ?? 'main';
}

function buildPrompt(
  gitDiff: string,
  gitLog: string,
  language: string,
  customPrompt?: string
): string {
  if (customPrompt) {
    const noDiff = language === '中文' ? '(无可用差异)' : '(No diff available)';
    const noLog = language === '中文' ? '(无提交历史)' : '(No commit history available)';
    return customPrompt
      .replace(/\{language\}/g, language)
      .replace(/\{git_diff\}/g, gitDiff || noDiff)
      .replace(/\{git_log\}/g, gitLog || noLog);
  }
  return `Always reply in ${language}. You are performing a code review on the changes in the current branch.

## Code Review Instructions

The full diff and commit history are provided below. Do not use tools or request more repository information. Focus on correctness, edge cases, readability, performance, and missing tests. Present findings with line numbers, code, issue, and a potential solution. If no issues are found, state that briefly.

## Full Diff

${gitDiff || '(No diff available)'}

## Commit History

${gitLog || '(No commit history available)'}`;
}

/**
 * dsh-rebase P1-15 (decision 125): the review streams from the shared DSH host
 * (`service`, the app's own by default); the prompt, the repository reads and
 * the 10 min deadline are unchanged.
 */
export async function startCodeReview(
  options: CodeReviewOptions,
  service: Pick<DshCompletionService, 'complete'> = dshCompletionService
): Promise<void> {
  const {
    workdir,
    language,
    reviewId,
    model,
    effort,
    prompt: customPrompt,
    onChunk,
    onComplete,
    onError,
  } = options;
  const gitDiff = await runGit(['--no-pager', 'diff', 'HEAD', '--submodule=diff'], workdir);
  const defaultBranch = await getDefaultBranch(workdir);
  let gitLog = await runGit(
    ['--no-pager', 'log', `origin/${defaultBranch}..HEAD`, '--oneline'],
    workdir
  );
  if (!gitLog) gitLog = await runGit(['--no-pager', 'log', '-10', '--oneline'], workdir);
  if (!gitDiff && !gitLog && !customPrompt) {
    onError('No changes to review');
    return;
  }

  try {
    activeReviewIds.add(reviewId);
    await service.complete({
      operationId: reviewId,
      purpose: 'code-review',
      prompt: buildPrompt(gitDiff, gitLog, language, customPrompt),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      timeoutMs: 10 * 60_000,
      onDelta: onChunk,
    });
    onComplete();
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  } finally {
    activeReviewIds.delete(reviewId);
  }
}

export function stopCodeReview(
  reviewId: string,
  service: Pick<DshCompletionService, 'cancel'> = dshCompletionService
): void {
  service.cancel(reviewId);
}

export function stopAllCodeReviews(
  service: Pick<DshCompletionService, 'cancel'> = dshCompletionService
): void {
  for (const reviewId of activeReviewIds) service.cancel(reviewId);
}
