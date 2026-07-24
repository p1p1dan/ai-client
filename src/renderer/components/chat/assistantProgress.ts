export interface ProgressEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export type AssistantProgressSignal = 'assistant' | 'ignore';

function readStringField(payload: unknown, field: string): string {
  if (payload && typeof payload === 'object' && field in payload) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function classifyAssistantProgress(
  event: ProgressEvent,
  assistantMessageIds: Set<string>
): AssistantProgressSignal {
  switch (event.type) {
    case 'message.started': {
      const role = readStringField(event.payload, 'role');
      const messageId = readStringField(event.payload, 'messageId');
      if (role === 'assistant' && messageId) {
        assistantMessageIds.add(messageId);
        return 'assistant';
      }
      return 'ignore';
    }
    case 'message.delta':
    case 'message.completed': {
      const messageId = readStringField(event.payload, 'messageId');
      if (messageId && assistantMessageIds.has(messageId)) {
        return 'assistant';
      }
      return 'ignore';
    }
    case 'thinking.started':
    case 'thinking.delta':
    case 'thinking.completed':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
    case 'permission.requested':
    case 'question.requested':
      return 'assistant';
    default:
      return 'ignore';
  }
}
