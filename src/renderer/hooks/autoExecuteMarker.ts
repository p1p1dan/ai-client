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
