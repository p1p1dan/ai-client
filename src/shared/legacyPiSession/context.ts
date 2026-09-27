// Vendored from @earendil-works/pi-agent-core 0.84.4 dist/harness/session/context.js and dist/harness/messages.js (dsh-rebase P1-9a)
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
 * `buildSessionContext` without its options: the message list pi derives from
 * one branch of entries.
 *
 * The subset the decode chain uses (a v3 compaction's retained tail is rebuilt
 * with it) plus the state fields, so the return value keeps pi's shape. Left
 * out are `entryTransforms` and `entryProjectors`, which no caller of this
 * library passes: without a projector a `custom` entry contributes nothing,
 * exactly as it does in pi with none registered. Logic and ordering are pi's,
 * transliterated to TypeScript over this library's structural types;
 * `src/runtime/__tests__/legacyPiSessionWrappers.test.ts` holds it to the
 * package while the runtime still ships one.
 */

import type {
  AgentMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  Entry,
} from './types.ts';

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  activeToolNames: string[] | null;
}

export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string | number
): BranchSummaryMessage {
  return {
    role: 'branchSummary',
    summary,
    fromId,
    timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime(),
  };
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string | number
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime(),
  };
}

function deriveSessionContextState(
  pathEntries: readonly Entry[]
): Omit<SessionContext, 'messages'> {
  let thinkingLevel = 'off';
  let model: SessionContext['model'] = null;
  let activeToolNames: string[] | null = null;
  for (const entry of pathEntries) {
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === 'model_change') {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === 'message' && entry.message.role === 'assistant') {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === 'active_tools_change') {
      activeToolNames = [...entry.activeToolNames];
    }
  }
  return { thinkingLevel, model, activeToolNames };
}

/** The latest compaction and everything after it, or the whole branch when there is none. */
export function defaultContextEntryTransform(pathEntries: readonly Entry[]): Entry[] {
  let compaction: Entry | undefined;
  let compactionIndex = -1;
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    const entry = pathEntries[index];
    if (entry.type === 'compaction') {
      compaction = entry;
      compactionIndex = index;
      break;
    }
  }
  return compaction === undefined
    ? [...pathEntries]
    : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

export function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
  if (entry.type === 'message') {
    if (entry.message.role === 'assistant' && entry.message.stopReason === 'deferred') return [];
    return [entry.message];
  }
  if (entry.type === 'compaction') {
    return [
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      ...entry.retainedTail,
    ];
  }
  if (entry.type === 'branch_summary' && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  }
  // A `custom` entry reaches the context only through a registered projector,
  // and this subset registers none.
  return [];
}

export function buildSessionContext(pathEntries: readonly Entry[]): SessionContext {
  const state = deriveSessionContextState(pathEntries);
  const messages = defaultContextEntryTransform(pathEntries).flatMap(sessionEntryToContextMessages);
  return { ...state, messages };
}
