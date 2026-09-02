import { execSync } from 'node:child_process';
import type { CommonAICompletionOptions } from '@shared/types/ai';
import { piUtilityService } from '../agent-host/PiUtilityService';
import { isWslGitRepository, spawnGit } from '../git/runtime';
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

function runGit(args: string[], cwd: string): Promise<string> {
  if (!isWslGitRepository(cwd)) {
    try {
      return Promise.resolve(
        execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
      );
    } catch {
      return Promise.resolve('');
    }
  }

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const proc = spawnGit(cwd, args);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
      resolve('');
    }, 5000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');
    });

    // Drain stderr to avoid child process blocking on full pipe buffer.
    proc.stderr.on('data', () => {});

    proc.on('error', () => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve('');
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve(code === 0 ? stdout.trim() : '');
    });
  });
}

export async function generateCommitMessage(
  options: CommitMessageOptions
): Promise<CommitMessageResult> {
  const { workdir, maxDiffLines, timeout, model, effort, prompt: customPrompt } = options;

  const [recentCommits, stagedStat, stagedDiff] = await Promise.all([
    runGit(['--no-pager', 'log', '-5', '--format=%s'], workdir),
    runGit(['--no-pager', 'diff', '--cached', '--stat'], workdir),
    runGit(['--no-pager', 'diff', '--cached'], workdir),
  ]);

  const truncatedDiff =
    stagedDiff.split('\n').slice(0, maxDiffLines).join('\n') || '(no staged changes detected)';

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
    const completion = await piUtilityService.complete({
      cwd: workdir,
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
