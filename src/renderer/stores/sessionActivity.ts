import type { RuntimeEvent, SessionRetryInfo } from '@shared/types/runtimeEvents';

export interface SessionActivity {
  phase:
    | 'waiting'
    | 'thinking'
    | 'output'
    | 'tool'
    | 'confirmation'
    | 'retry'
    | 'failed'
    | 'stopping';
  since: number;
  tool?: string;
  retry?: SessionRetryInfo;
  error?: string;
}

export function nextSessionActivity(
  previous: SessionActivity | undefined,
  event: RuntimeEvent
): SessionActivity | undefined {
  const at = event.timestamp;
  const phase = (value: SessionActivity['phase'], tool?: string): SessionActivity =>
    previous?.phase === value && previous.tool === tool
      ? previous
      : { phase: value, since: at, ...(tool ? { tool } : {}) };
  switch (event.type) {
    case 'session.created':
    case 'session.resumed':
    case 'session.completed':
    case 'session.stopped':
      return undefined;
    case 'session.failed':
      return { phase: 'failed', since: at, error: event.payload?.error ?? 'Session failed' };
    case 'session.status': {
      if (event.payload.retry) return { phase: 'retry', since: at, retry: event.payload.retry };
      switch (event.payload.status) {
        case 'starting':
          return phase('waiting');
        case 'running':
          return previous && !['failed', 'retry', 'confirmation'].includes(previous.phase)
            ? previous
            : phase('waiting');
        case 'waiting_permission':
        case 'waiting_question':
          return phase('confirmation');
        case 'stopping':
          return phase('stopping');
        case 'failed':
          return phase('failed');
        case 'idle':
          return undefined;
      }
      return previous;
    }
    case 'message.started':
      return event.payload.role === 'user' ? phase('waiting') : previous;
    case 'message.delta':
      return phase('output');
    case 'thinking.started':
    case 'thinking.delta':
      return phase('thinking');
    case 'tool.started': {
      const input = event.payload.input;
      const detail =
        input && typeof input === 'object'
          ? 'path' in input
            ? input.path
            : 'command' in input
              ? input.command
              : undefined
          : undefined;
      return phase(
        'tool',
        event.payload.name + (typeof detail === 'string' ? ` · ${detail.slice(0, 100)}` : '')
      );
    }
    case 'thinking.completed':
    case 'tool.completed':
      return phase('waiting');
    case 'permission.requested':
    case 'question.requested':
      return phase('confirmation');
    default:
      return previous;
  }
}

export function isRecoveryEvent(event: RuntimeEvent): boolean {
  return (
    (event.type === 'session.status' && event.payload.status === 'starting') ||
    (event.type === 'message.started' && event.payload.role === 'user') ||
    event.type === 'message.delta' ||
    event.type === 'thinking.delta' ||
    event.type === 'tool.started' ||
    event.type === 'tool.completed' ||
    event.type === 'session.completed' ||
    event.type === 'session.stopped'
  );
}
