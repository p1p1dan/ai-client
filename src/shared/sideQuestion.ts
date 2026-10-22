/**
 * Layout 5f (ui-cohesion ruling L6): the prompt of a side question on the DSH
 * engine — one tool-free model call that reads the conversation so far and
 * writes nothing back (`worker.sideQuestion`). The Claude engine asks the
 * CLI's own side question instead and does not use this file.
 *
 * Pure, and loaded by the DSH bridge as source under Node's type stripping:
 * value imports keep their `.ts` suffix.
 */

import { isDshSummaryRow } from './dshHistory/types.ts';
import type { HistoryMessage } from './types/sessionHistory.ts';
import type { WorkerSideQuestionTurn } from './types/workerRpc.ts';

export const SIDE_QUESTION_SYSTEM_PROMPT = [
  'You answer a quick side question the user asks about their conversation with an AI coding agent.',
  'The conversation so far is shown inside <conversation>. The agent keeps working there; your answer appears only in a side panel and never becomes part of that conversation.',
  'You have no tools. Answer from the conversation and from general knowledge. Be concise and direct.',
  'If the conversation does not contain what the question needs, say so briefly instead of guessing.',
].join('\n');

/** The newest part of the conversation the prompt keeps (UTF-16 code units). */
export const SIDE_QUESTION_TRANSCRIPT_MAX_CHARS = 120_000;
/** One tool call's input, and one tool result's output, as the transcript quotes them. */
const TOOL_INPUT_MAX_CHARS = 400;
const TOOL_OUTPUT_MAX_CHARS = 600;
const OMITTED_NOTE = '[Earlier parts of the conversation are omitted.]';

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function inputText(input: unknown): string {
  if (input === undefined) return '';
  try {
    return clip(JSON.stringify(input) ?? '', TOOL_INPUT_MAX_CHARS);
  } catch {
    return '';
  }
}

/** One message as transcript lines; empty when it says nothing. */
function messageLines(message: HistoryMessage): string[] {
  if (isDshSummaryRow(message)) {
    const text = message.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();
    return text ? [`[Context summary]\n${text}`] : [];
  }
  if (message.role === 'system') return [];
  const lines: string[] = [];
  const speaker = message.role === 'user' ? 'User' : 'Assistant';
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text': {
        if (block.notice) break;
        const text = block.text.trim();
        if (text) lines.push(`${speaker}: ${text}`);
        break;
      }
      case 'tool_call': {
        const input = inputText(block.input);
        lines.push(`[Tool call: ${block.name}${input ? ` ${input}` : ''}]`);
        break;
      }
      case 'tool_result': {
        const body = (block.ok ? block.output : (block.error ?? block.output))?.trim() ?? '';
        const head = block.ok ? '[Tool result]' : '[Tool result: failed]';
        lines.push(body ? `${head} ${clip(body, TOOL_OUTPUT_MAX_CHARS)}` : head);
        break;
      }
      default:
        // Thinking stays out: it is the agent's scratch work, not what it said.
        break;
    }
  }
  return lines;
}

/**
 * The conversation as plain text, newest part kept when it is longer than
 * `maxChars` (whole messages only; a note says something was left out).
 */
export function buildSideQuestionTranscript(
  messages: readonly HistoryMessage[],
  maxChars = SIDE_QUESTION_TRANSCRIPT_MAX_CHARS
): string {
  const parts: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const text = messageLines(message).join('\n');
    if (!text) continue;
    if (used + text.length + 1 > maxChars) {
      parts.push(OMITTED_NOTE);
      break;
    }
    parts.push(text);
    used += text.length + 1;
  }
  return parts.reverse().join('\n');
}

/** The one user message of the call: the conversation, earlier side questions, the question. */
export function buildSideQuestionPrompt(input: {
  transcript: string;
  history?: readonly WorkerSideQuestionTurn[];
  question: string;
}): string {
  const sections = [
    `<conversation>\n${input.transcript.trim() || '(nothing has been said yet)'}\n</conversation>`,
  ];
  const earlier = (input.history ?? []).filter((turn) => turn.question.trim());
  if (earlier.length > 0) {
    const turns = earlier
      .map((turn) => `Question: ${turn.question.trim()}\nYour answer: ${turn.answer.trim()}`)
      .join('\n\n');
    sections.push(`<earlier_side_questions>\n${turns}\n</earlier_side_questions>`);
  }
  sections.push(`Side question: ${input.question.trim()}`);
  return sections.join('\n\n');
}
