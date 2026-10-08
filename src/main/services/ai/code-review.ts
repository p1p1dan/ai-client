import type { CommonAICompletionOptions } from '@shared/types/ai';
import {
  type DshCompletionService,
  dshCompletionService,
} from '../agent-host/DshCompletionService';
import { isGitExitError, probeGitExitCode, readGit } from '../git/gitReadFallback';

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

/**
 * `git <args>` in `cwd` through the F3 lost-output fallback (`readGit`): on the
 * encrypted Windows host the stdout of a git Main spawns is lost, and the
 * review used to be asked about an empty diff. A non-zero exit is git's own
 * answer and reads as '' as before; a read that could not finish rejects.
 */
async function runGit(
  cwd: string,
  args: string[],
  lostWhen: 'empty' | 'never' | ((stdout: string) => boolean),
  okExitCodes?: readonly number[]
): Promise<string> {
  try {
    const { stdout } = await readGit({
      what: args[0] ?? 'git',
      workdir: cwd,
      args,
      lostWhen,
      ...(okExitCodes ? { okExitCodes } : {}),
    });
    return stdout.trim();
  } catch (error) {
    if (isGitExitError(error)) return '';
    throw error;
  }
}

/** The working tree differs from HEAD, by exit code (survives lost stdout). */
async function hasChangesAgainstHead(cwd: string): Promise<boolean> {
  try {
    return (await probeGitExitCode(cwd, ['diff', 'HEAD', '--quiet'])) === 1;
  } catch {
    return false;
  }
}

async function getDefaultBranch(workdir: string): Promise<string> {
  // Exit 1: origin/HEAD is not set. Exit 0 always prints the target.
  const ref = await runGit(
    workdir,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    'empty',
    [1]
  );
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
  let gitDiff: string;
  let gitLog: string;
  try {
    const changed = await hasChangesAgainstHead(workdir);
    gitDiff = await runGit(
      workdir,
      ['diff', 'HEAD', '--submodule=diff'],
      (out) => changed && out.trim() === ''
    );
    const defaultBranch = await getDefaultBranch(workdir);
    // No commits ahead of the default branch is a real (empty) answer.
    gitLog = await runGit(workdir, ['log', `origin/${defaultBranch}..HEAD`, '--oneline'], 'never');
    // Exit 0 always lists HEAD at least.
    if (!gitLog) gitLog = await runGit(workdir, ['log', '-10', '--oneline'], 'empty');
  } catch (error) {
    onError(
      `Could not read the changes to review: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
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
