import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { EVENTS_SERVICE } from '../contracts.ts';
import { RuntimeEventProjector } from './projector.ts';

export class EventsPlugin extends Service {
  private readonly listeners = new Set<(event: RuntimeEventDraft) => void>();
  private active?: { sessionId: string; requestId: string };
  constructor(ctx: Context) {
    super(ctx, EVENTS_SERVICE);
    ctx.effect(() => () => this.listeners.clear());
  }
  subscribe(listener: (event: RuntimeEventDraft) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: RuntimeEventDraft): void {
    const projected = this.active ? { ...event, ...this.active } : event;
    if (event.type === 'session.status' && event.payload.status === 'idle') this.active = undefined;
    for (const listener of this.listeners) listener(projected);
  }
  startRun(
    sessionId: string,
    requestId: string,
    history: readonly AgentMessage[],
    contextWindow?: number
  ) {
    this.active = { sessionId, requestId };
    const projector = new RuntimeEventProjector(
      { sessionId, emit: (event) => this.emit(event) },
      requestId,
      history,
      contextWindow
    );
    projector.start();
    return projector;
  }
}
