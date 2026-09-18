import type { CommonAICompletionOptions } from '@shared/types/ai';
import { piUtilityService } from '../agent-host/PiUtilityService';
import { stripCodeFence } from './providers';

export interface BranchNameOptions extends CommonAICompletionOptions {
  workdir: string;
  prompt: string;
  timeout?: number;
}

export interface BranchNameResult {
  success: boolean;
  branchName?: string;
  error?: string;
}

export async function generateBranchName(options: BranchNameOptions): Promise<BranchNameResult> {
  const { workdir, prompt, model, effort, timeout = 120 } = options;

  try {
    const completion = await piUtilityService.complete({
      cwd: workdir,
      prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      timeoutMs: timeout * 1000,
    });
    // Models commonly wrap a short answer in a ``` fence; left in place it
    // would land verbatim in a git branch name (backticks and all).
    return { success: true, branchName: stripCodeFence(completion.text) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
