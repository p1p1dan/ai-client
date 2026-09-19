import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { EVENTS_SERVICE } from '../contracts.ts';
import { RuntimeEventProjector, type UserTurnEcho } from './projector.ts';

export interface EventsConfig {
  /**
   * T101 / {@link STREAM_TOOL_ROWS_ENV} — open a tool row while its arguments
   * are still streaming. Read from the flags once at bootstrap and held for the
   * process, so every run of a session projects the same way.
   */
  streamToolRows?: boolean;
}

export class EventsPlugin extends Service {
  private readonly listeners = new Set<(event: RuntimeEventDraft) => void>();
  private active?: { sessionId: string; requestId: string };
  private readonly config: EventsConfig;
  constructor(ctx: Context, config: EventsConfig = {}) {
    super(ctx, EVENTS_SERVICE);
    this.config = config;
    ctx.effect(() => () => this.listeners.clear());
  }
  subscribe(listener: (event: RuntimeEventDraft) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: RuntimeEventDraft): void {
    const projected = this.active ? { ...event, ...this.active } : event;
    if (event.type === 'session.status' && event.payload.status === 'idle') this.active = undefined;
    // Snapshot, and isolate each delivery. A sink that throws — a closed RPC
    // port is the realistic one — must not cut the rest of the subscribers out
    // of this event, and must not travel back up to the emitter, which is the
    // agent loop mid-turn: the turn would end with an error about the transport
    // instead of the model.
    for (const listener of [...this.listeners]) {
      try {
        listener(projected);
      } catch (error) {
        console.error(`[runtime-events] subscriber failed on ${event.type}`, error);
      }
    }
  }
  startRun(
    sessionId: string,
    requestId: string,
    history: readonly AgentMessage[],
    contextWindow?: number,
    userTurn?: UserTurnEcho
  ) {
    this.active = { sessionId, requestId };
    const projector = new RuntimeEventProjector(
      { sessionId, emit: (event) => this.emit(event) },
      requestId,
      history,
      contextWindow,
      userTurn,
      {
        ...(this.config.streamToolRows === undefined
          ? {}
          : { streamToolRows: this.config.streamToolRows }),
      }
    );
    projector.start();
    return projector;
  }
}
