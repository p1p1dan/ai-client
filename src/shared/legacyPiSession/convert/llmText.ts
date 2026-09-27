// Vendored from @earendil-works/pi-agent-core 0.84.4 dist/harness/messages.js (dsh-rebase P1-9b)
//
// Source: https://github.com/earendil-works/pi (packages/agent)
//
// MIT License
//
// Copyright (c) 2025 Mario Zechner
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * How pi turned its own message roles into the user text a model saw
 * (`convertToLlm` and the text it builds), so a migrated session sends the
 * model what 1.0.x sent. Logic and wording are pi's, transliterated to
 * TypeScript over this library's structural types; the `create*Message`
 * helpers of the same module are already in `../context.ts`.
 */

import type { AgentMessage, BashExecutionMessage, ImageContent, TextContent } from '../types.ts';

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += '(no output)';
  }
  if (msg.cancelled) {
    text += '\n\n(command cancelled)';
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/** A pi message as the model receives it: user, assistant or tool result. */
export type LlmMessage =
  | { role: 'user'; content: string | (TextContent | ImageContent)[]; timestamp: number }
  | Extract<AgentMessage, { role: 'assistant' | 'toolResult' }>;

export function convertToLlm(messages: readonly AgentMessage[]): LlmMessage[] {
  return messages
    .map((m): LlmMessage | undefined => {
      switch (m.role) {
        case 'bashExecution':
          if (m.excludeFromContext) {
            return undefined;
          }
          return {
            role: 'user',
            content: [{ type: 'text', text: bashExecutionToText(m) }],
            timestamp: m.timestamp,
          };
        case 'custom': {
          const content =
            typeof m.content === 'string'
              ? [{ type: 'text' as const, text: m.content }]
              : m.content;
          return {
            role: 'user',
            content,
            timestamp: m.timestamp,
          };
        }
        case 'branchSummary':
          return {
            role: 'user',
            content: [
              { type: 'text', text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX },
            ],
            timestamp: m.timestamp,
          };
        case 'compactionSummary':
          return {
            role: 'user',
            content: [
              {
                type: 'text',
                text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: m.timestamp,
          };
        case 'user':
        case 'assistant':
        case 'toolResult':
          return m;
        default:
          return undefined;
      }
    })
    .filter((m): m is LlmMessage => m !== undefined);
}
