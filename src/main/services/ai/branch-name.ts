import type { CommonAICompletionOptions } from '@shared/types/ai';
import {
  type DshCompletionService,
  dshCompletionService,
} from '../agent-host/DshCompletionService';
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

/**
 * dsh-rebase P1-15 (decision 125): the completion runs on the shared DSH host
 * (`service`, the app's own by default); `workdir` only scopes the IPC call
 * now, since the prompt is all the model gets.
 */
export async function generateBranchName(
  options: BranchNameOptions,
  service: Pick<DshCompletionService, 'complete'> = dshCompletionService
): Promise<BranchNameResult> {
  const { prompt, model, effort, timeout = 120 } = options;

  try {
    const completion = await service.complete({
      purpose: 'branch-name',
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
