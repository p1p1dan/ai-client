import type { CommonAICompletionOptions } from '@shared/types/ai';
import { piUtilityService } from '../agent-host/PiUtilityService';
import { stripCodeFence } from './providers';

export interface TodoPolishOptions extends CommonAICompletionOptions {
  text: string; // Raw requirement text to polish
  timeout: number; // in seconds
  prompt?: string; // Custom prompt template (with {text} placeholder)
}

export interface TodoPolishResult {
  success: boolean;
  title?: string;
  description?: string;
  error?: string;
}

/** Parse JSON output from AI (expects { title, description } format) */
function parsePolishOutput(raw: string): { title: string; description: string } | null {
  const cleaned = stripCodeFence(raw);

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.title === 'string' && typeof parsed.description === 'string') {
      return { title: parsed.title.trim(), description: parsed.description.trim() };
    }
  } catch {
    // Try extracting JSON from text
    const jsonMatch = cleaned.match(/\{[\s\S]*?"title"[\s\S]*?"description"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.title === 'string' && typeof parsed.description === 'string') {
          return { title: parsed.title.trim(), description: parsed.description.trim() };
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

export async function polishTodoTask(options: TodoPolishOptions): Promise<TodoPolishResult> {
  const { text, timeout, model, effort, prompt: customPrompt } = options;

  const defaultPrompt = `You are a task management assistant. Convert the following raw requirement text into a structured todo task.

Output a JSON object with exactly two fields:
- "title": A concise, action-oriented title (max 60 characters)
- "description": A clear, detailed description that is AI-agent-friendly. Include context, acceptance criteria, and any technical details from the input. Write it so an AI coding agent can understand and execute the task directly.

Important: Output ONLY the JSON object, no explanation, no markdown fences.

Raw requirement:
{text}`;

  const promptTemplate = customPrompt || defaultPrompt;
  const prompt = promptTemplate.replace(/\{text\}/g, () => text);

  try {
    const completion = await piUtilityService.complete({
      cwd: process.cwd(),
      prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      timeoutMs: timeout * 1000,
    });
    const parsed = parsePolishOutput(completion.text);
    return parsed
      ? { success: true, title: parsed.title, description: parsed.description }
      : { success: false, error: 'Failed to parse AI output as JSON' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
