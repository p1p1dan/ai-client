import { TASK_COMPLETION_MARKER } from '@shared/types/agent';

export function buildAutoExecutePrompt(title: string, description?: string): string {
  return `
${title}

${description || ''}

---
[AUTO-EXECUTE RULES - MUST FOLLOW]
1. When task is complete, output the following marker on a separate line at the end of your response: ${TASK_COMPLETION_MARKER}
2. Do NOT call AskUserQuestion tool. Do NOT ask user to choose options. Directly select and execute the best approach.
3. Solve problems autonomously. Do NOT interrupt the workflow to wait for user input.
`.trim();
}

export function hasCompletedAutoExecuteOutput(output: string): boolean {
  // The submitted prompt is rendered once by the TUI. Pi must emit the same
  // marker a second time at the end of its completed response.
  return output.split(TASK_COMPLETION_MARKER).length - 1 >= 2;
}

const MAX_TRACKED_OUTPUT_CHARS = 1_048_576;

export interface AutoExecuteCompletionTracker {
  /** Feeds one PTY chunk; true means this task just completed. */
  data: (sessionId: string, chunk: string) => boolean;
  /** Records the PTY exit; true means this task ended without completing. */
  exit: (sessionId: string) => boolean;
}

/**
 * Per-task completion bookkeeping for the auto-execute queue.
 *
 * The queue advances from inside its own listeners and leaves them subscribed,
 * so the output buffer and the "already settled" flag have to be keyed on the
 * running task's session. One flag shared across tasks settles on task #1 and
 * then silently swallows every event belonging to the tasks after it.
 */
export function createAutoExecuteCompletionTracker(): AutoExecuteCompletionTracker {
  let trackedSessionId: string | null = null;
  let output = '';
  let settled = false;

  const track = (sessionId: string): void => {
    if (trackedSessionId === sessionId) return;
    trackedSessionId = sessionId;
    output = '';
    settled = false;
  };

  return {
    data: (sessionId, chunk) => {
      track(sessionId);
      if (settled) return false;
      output = `${output}${chunk}`.slice(-MAX_TRACKED_OUTPUT_CHARS);
      if (!hasCompletedAutoExecuteOutput(output)) return false;
      settled = true;
      return true;
    },
    exit: (sessionId) => {
      track(sessionId);
      if (settled) return false;
      settled = true;
      return true;
    },
  };
}
