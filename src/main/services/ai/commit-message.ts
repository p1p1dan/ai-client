import type { CommonAICompletionOptions } from '@shared/types/ai';
import {
  type DshCompletionService,
  dshCompletionService,
} from '../agent-host/DshCompletionService';
import {
  isGitExitError,
  isGitOutputTooLarge,
  probeGitExitCode,
  readGit,
} from '../git/gitReadFallback';
import { stripCodeFence } from './providers';

export interface CommitMessageOptions extends CommonAICompletionOptions {
  workdir: string;
  maxDiffLines: number;
  timeout: number;
  prompt?: string; // Custom prompt template
}

export interface CommitMessageResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * `git <args>` in `cwd` through the F3 lost-output fallback (`readGit`): on the
 * encrypted Windows host the stdout of a git Main spawns is lost, and the
 * staged diff used to arrive empty, so the model wrote a message for "(no
 * staged changes detected)".
 *
 * A non-zero exit is git's own answer (no commits yet) and reads as '' as
 * before; a read that could not finish (lost output on both paths, a runner
 * that failed, a timeout) rejects, so the caller can say so.
 */
async function runGit(
  cwd: string,
  args: string[],
  lostWhen: 'empty' | 'never' | ((stdout: string) => boolean),
  maxBytes?: number
): Promise<string> {
  try {
    const { stdout } = await readGit({
      what: args[0] ?? 'git',
      workdir: cwd,
      args,
      lostWhen,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    return stdout.trim();
  } catch (error) {
    if (isGitExitError(error)) return '';
    throw error;
  }
}

/**
 * The last five subjects, newest first. `%h %s`, not `%s`: a commit made with
 * `--allow-empty-message` has an empty subject, and five of them printed only
 * newlines, which read as a lost answer. With the hash every line has text, so
 * an empty answer is still a loss (no commits exits non-zero instead).
 */
async function readRecentSubjects(cwd: string): Promise<string> {
  const lines = await runGit(cwd, ['log', '-5', '--format=%h %s'], 'empty');
  return lines
    .split('\n')
    .map((line) => line.replace(/^\S+ ?/, ''))
    .join('\n')
    .trim();
}

/**
 * Cap on the staged diff. The prompt keeps only its first `maxDiffLines`
 * lines, but the whole diff used to be read into Main: staging a file of a few
 * hundred MB grew Main by as much (and the runner refused past its 32 MB
 * buffer). Past the cap the message is written from the `--stat` summary.
 */
export const STAGED_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/** Stands in for the diff in the prompt when it is over the cap. */
export const STAGED_DIFF_TOO_LARGE_NOTE =
  '(staged diff over 8 MB, not included; see the change summary)';

/** The staged diff, or `null` when it is over `STAGED_DIFF_MAX_BYTES`. */
async function readStagedDiff(
  cwd: string,
  lostWhen: (stdout: string) => boolean
): Promise<string | null> {
  try {
    return await runGit(cwd, ['diff', '--cached'], lostWhen, STAGED_DIFF_MAX_BYTES);
  } catch (error) {
    if (isGitOutputTooLarge(error)) return null;
    throw error;
  }
}

/**
 * Whether anything is staged, by exit code (`--quiet` exits 1 when the index
 * differs from HEAD), which survives where stdout is lost. An empty staged diff
 * is a real answer only when this says nothing is staged.
 */
async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    return (await probeGitExitCode(cwd, ['diff', '--cached', '--quiet'])) === 1;
  } catch {
    return false;
  }
}

/**
 * dsh-rebase P1-15 (decision 125): the completion runs on the shared DSH host
 * (`service`, the app's own by default); the prompt and the fence stripping
 * are unchanged.
 */
export async function generateCommitMessage(
  options: CommitMessageOptions,
  service: Pick<DshCompletionService, 'complete'> = dshCompletionService
): Promise<CommitMessageResult> {
  const { workdir, maxDiffLines, timeout, model, effort, prompt: customPrompt } = options;

  let recentCommits: string;
  let stagedStat: string;
  let stagedDiff: string | null;
  try {
    const staged = await hasStagedChanges(workdir);
    const lostWhenStaged = (out: string) => staged && out.trim() === '';
    // Settled, not `all`: a failure is reported once every read has finished,
    // so none is left running behind the answer.
    const reads = await Promise.allSettled([
      readRecentSubjects(workdir),
      runGit(workdir, ['diff', '--cached', '--stat'], lostWhenStaged),
      readStagedDiff(workdir, lostWhenStaged),
    ]);
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed) throw failed.reason;
    const [recent, stat, diff] = reads;
    recentCommits = recent.status === 'fulfilled' ? recent.value : '';
    stagedStat = stat.status === 'fulfilled' ? stat.value : '';
    stagedDiff = diff.status === 'fulfilled' ? diff.value : '';
  } catch (error) {
    return {
      success: false,
      error: `Could not read the staged changes: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const truncatedDiff =
    stagedDiff === null
      ? STAGED_DIFF_TOO_LARGE_NOTE
      : stagedDiff.split('\n').slice(0, maxDiffLines).join('\n') || '(no staged changes detected)';

  // Build prompt - use custom template or default
  // Use single-pass replacement to avoid injection from git content containing placeholders
  const variables: Record<string, string> = {
    '{recent_commits}': recentCommits || '(no recent commits)',
    '{staged_stat}': stagedStat || '(no stats)',
    '{staged_diff}': truncatedDiff,
  };

  const prompt = customPrompt
    ? customPrompt.replace(
        /\{recent_commits\}|\{staged_stat\}|\{staged_diff\}/g,
        (match) => variables[match] ?? match
      )
    : `你无法调用任何工具，我消息里已经包含了所有你需要的信息，无需解释，直接返回一句简短的 commit message。

参考风格：
${recentCommits || '(no recent commits)'}

变更摘要：
${stagedStat || '(no stats)'}

变更详情：
${truncatedDiff}`;

  try {
    const completion = await service.complete({
      purpose: 'commit-message',
      prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      timeoutMs: timeout * 1000,
    });
    return { success: true, message: stripCodeFence(completion.text) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
