/**
 * The optional second layer (docs/agent-project-engineering.md §5): an LLM
 * scores what the deterministic checks cannot. It is kept clean: a fixed,
 * versioned prompt; it sees the task, the case's rubric, the final reply and
 * the diff, never which client produced them nor how the harness works; and
 * it scores and lists issues, it does not hand down pass or fail.
 */

import type { CaseJudge, JudgeResult } from './types.ts';

export const JUDGE_VERSION = 'ab-eval-judge/1';

const DEFAULT_DIMENSIONS = ['correctness', 'completeness', 'code_quality', 'instruction_following'];

/** The marker lets the fake gateway answer judge requests (plan `ab-eval`). */
const SYSTEM = `AB-EVAL-JUDGE ${JUDGE_VERSION}
You grade the outcome of one coding task that an AI coding agent carried out in a git repository.
You see the task, the grading rubric, the agent's final reply and the diff of everything it changed.
You do not know, and must not guess, which agent or tool produced the result.
Score every listed dimension from 0 (unacceptable) to 10 (excellent), give an overall score from 0 to 10,
and list concrete issues, each as one short sentence. Do not decide pass or fail.
Reply with exactly one JSON object and nothing else:
{"score": <number>, "dimensions": {"<dimension>": <number>}, "issues": ["<issue>"]}`;

export interface JudgeEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]`
    : text;
}

export function judgePrompt(input: {
  prompt: string;
  judge: CaseJudge;
  answer: string;
  patch: string;
}): string {
  const dimensions = input.judge.dimensions ?? DEFAULT_DIMENSIONS;
  return [
    '## Task',
    input.prompt,
    '',
    '## Rubric',
    input.judge.rubric,
    '',
    '## Dimensions',
    ...dimensions.map((name) => `- ${name}`),
    '',
    "## The agent's final reply",
    clip(input.answer || '(empty)', 8_000),
    '',
    '## Diff against the starting commit',
    '```diff',
    clip(input.patch || '(no changes)', 40_000),
    '```',
  ].join('\n');
}

/** Text of an Anthropic Messages reply, streamed (SSE) or not. */
export function replyText(body: string): string {
  if (body.trimStart().startsWith('{')) {
    const message = JSON.parse(body) as { content?: Array<{ type?: string; text?: string }> };
    return (message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5)) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text ?? '';
      }
    } catch {
      // Keep-alive or a partial line.
    }
  }
  return text;
}

/** The judge's JSON, checked: an overall score in 0..10, numeric dimensions, string issues. */
export function parseVerdict(text: string): Pick<JudgeResult, 'score' | 'dimensions' | 'issues'> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply');
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const score = raw.score;
  if (typeof score !== 'number' || score < 0 || score > 10)
    throw new Error('score must be a number in 0..10');
  const dimensions: Record<string, number> = {};
  if (raw.dimensions && typeof raw.dimensions === 'object') {
    for (const [name, value] of Object.entries(raw.dimensions)) {
      if (typeof value === 'number') dimensions[name] = value;
    }
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.map(String) : [];
  return { score, dimensions, issues };
}

export async function runJudge(
  endpoint: JudgeEndpoint,
  input: { prompt: string; judge: CaseJudge; answer: string; patch: string }
): Promise<JudgeResult> {
  const base = { model: endpoint.model, version: JUDGE_VERSION };
  try {
    const response = await fetch(`${endpoint.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': endpoint.apiKey,
      },
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{ role: 'user', content: judgePrompt(input) }],
        stream: true,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.text();
    if (!response.ok) return { ...base, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    return { ...base, ...parseVerdict(replyText(body)) };
  } catch (error) {
    return { ...base, error: String(error instanceof Error ? error.message : error) };
  }
}
