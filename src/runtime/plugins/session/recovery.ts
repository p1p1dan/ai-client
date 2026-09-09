import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';

// Restored tool intents are never executed automatically: the tool may have
// changed files before the process died, even if its result was not persisted.
export function interruptedToolResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content)
        if (block.type === 'toolCall') pending.set(block.id, block);
    } else if (message.role === 'toolResult') pending.delete(message.toolCallId);
  }
  return [...pending.values()].map((call) => ({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    content: [
      {
        type: 'text',
        text: 'The previous run ended before this tool result was recorded. Its effects are unknown; inspect the environment before deciding whether to repeat it.',
      },
    ],
    timestamp: Date.now(),
  }));
}
