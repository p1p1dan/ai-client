import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

export type CompactionFamily = 'fresh_window' | 'summary';
export interface NewContextOptions {
  family: CompactionFamily;
  request: () => void;
}
const REPLIES: Record<CompactionFamily, string> = {
  fresh_window: 'A new context window will start without summarizing conversation history.',
  summary: 'A new context window will start with a summary of the conversation history.',
};

// Adapted from PI-Desktop's buildContextCompactionTool: P2 owns the pending
// intent and consumes it at a turn boundary. Construction alone registers nothing.
export function newContextTool(options: NewContextOptions) {
  const parameters = Type.Object({}, { additionalProperties: false });
  return {
    name: 'new_context',
    label: 'New Context',
    description:
      'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
    parameters,
    execute: async () => {
      options.request();
      return {
        content: [{ type: 'text', text: REPLIES[options.family] }],
        details: { queued: true },
      };
    },
  } satisfies AgentTool<typeof parameters, { queued: boolean }>;
}
