// Vendored from @deepseek-ai/dsh-token-meter 0.1.7-rc.2 lib/types/estimate.js (dsh-rebase P1-9c)

/**
 * DSH's fixed-density heuristic token price of a message: the estimator
 * `dsh-token-meter` prices surface nodes with, and so the one a compaction's
 * `shadowedTokenCount` is stated in (`dsh-compaction-basic` sums it over the
 * shadowed nodes; `dsh-compaction` types: "heuristic price of the shadowed
 * content under the token-meter's fixed estimator").
 *
 * Copied because this library may load no DSH package; the arithmetic is
 * DSH's, unchanged. `tokenEstimate.test.ts` compares it with the installed
 * `@deepseek-ai/dsh-token-meter/estimate` whenever src/dsh-host is installed.
 *
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { DshSeedEvent } from './types.ts';

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4;
/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4;

type Block = Record<string, unknown> & { type?: unknown };

/** Structural JSON price of a block outside the typed arms (image references included). */
function estimateStructuralBlock(block: Block): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block;
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN);
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}

function estimateContent(blocks: readonly Block[]): number {
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        tokens +=
          Math.ceil(String(block.name).length / CHARS_PER_TOKEN) +
          Math.ceil(String(block.arguments).length / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD;
        break;
      default:
        tokens += estimateStructuralBlock(block);
    }
  }
  return tokens;
}

function estimateSystemMessage(content: readonly Block[]): number {
  if (content.length === 0) return 0;
  let characters = 0;
  for (const block of content) {
    characters += block.type === 'text' ? String(block.text).length : JSON.stringify(block).length;
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}

/** `estimateMessage`: one model-visible message under the fixed heuristic. */
export function estimateMessageTokens(message: { role?: unknown; content?: unknown }): number {
  const content = Array.isArray(message.content) ? (message.content as Block[]) : [];
  if (message.role === 'system') return estimateSystemMessage(content);
  return estimateContent(content) + ROLE_OVERHEAD;
}

/** The message a surface event carries: the event data itself for a user message. */
function surfaceMessage(event: DshSeedEvent | undefined): { role?: unknown; content?: unknown } {
  const data = event?.data as Record<string, unknown> | undefined;
  if (!data) return {};
  if (event?.type === 'user/message') return data;
  const message = data.message;
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)
    : {};
}

/** A compaction's `shadowedTokenCount`: the summed price of the nodes it shadows. */
export function shadowedTokenCount(
  events: readonly DshSeedEvent[],
  shadowed: readonly number[]
): number {
  return shadowed.reduce(
    (total, seq) => total + estimateMessageTokens(surfaceMessage(events[seq])),
    0
  );
}
