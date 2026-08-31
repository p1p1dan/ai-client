import type { SessionAttachment, SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT } from '@shared/types/agentWire';
import type {
  ExtensionUiResponse,
  RuntimeEvent,
  RuntimeEventDraft,
} from '@shared/types/runtimeEvents';
import {
  isWorkerExtensionUiResponseResult,
  isWorkerSendResult,
  isWorkerStopResult,
  type WorkerExtensionUiResponsePayload,
  type WorkerExtensionUiResponseResult,
  type WorkerRpcEvent,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
} from '@shared/types/workerRpc';
import { type CreatedPiWorkerSlot, createPiWorkerSlot } from './createPiWorkerSlot';
import type { WorkerSlotLifecycleEvent } from './WorkerSlot';

export type PiSingleSlotState = 'stopped' | 'ready' | 'error';

interface CurrentSlot extends CreatedPiWorkerSlot {
  logicalSessionId: string;
  activeRequestId: string | null;
  acceptEvents: boolean;
}

export interface PiSingleSlotRuntimeOptions {
  createSlot?: typeof createPiWorkerSlot;
  onEvent?: (event: RuntimeEvent) => void;
  log?: (...args: unknown[]) => void;
}

let commandSequence = 0;
function nextRequestId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${Date.now()}-${commandSequence}`;
}

/** T29-c single-slot Main authority. Pool/remap/eviction remain T30. */
export class PiSingleSlotRuntime {
  private readonly createSlot: typeof createPiWorkerSlot;
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
  private readonly log: (...args: unknown[]) => void;
  private current: CurrentSlot | null = null;
  private state: PiSingleSlotState = 'stopped';
  private lastError: string | null = null;
  private eventSequence = 0;
  private lifecycleChain: Promise<void> = Promise.resolve();

  constructor(options: PiSingleSlotRuntimeOptions = {}) {
    this.createSlot = options.createSlot ?? createPiWorkerSlot;
    this.log = options.log ?? (() => undefined);
    if (options.onEvent) this.handlers.add(options.onEvent);
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async ensureReady(): Promise<void> {
    if (this.state !== 'error') this.state = 'ready';
  }

  getStatus(): {
    state: PiSingleSlotState;
    pid?: number;
    driver: 'agent-sdk';
    cometixVersion: string;
    settings: null;
    capabilities: { history: false; thinking: true; permissionPolicy: true; agents: ['pi'] };
    error?: string;
  } {
    return {
      state: this.state,
      ...(this.current?.slot.pid ? { pid: this.current.slot.pid } : {}),
      driver: 'agent-sdk',
      cometixVersion: 'pi-worker',
      settings: null,
      capabilities: { history: false, thinking: true, permissionPolicy: true, agents: ['pi'] },
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    effort?: SessionEffortLevel;
  }): Promise<string> {
    const requestId = nextRequestId('create');
    return this.serialize(async () => {
      if (this.current?.logicalSessionId === input.sessionId) return;
      await this.disposeCurrent('slot-replace');
      this.state = 'ready';
      this.lastError = null;

      let expected: CurrentSlot | null = null;
      try {
        const created = await this.createSlot({
          slotKey: `workspace:${input.workspacePath}`,
          logicalSessionId: input.sessionId,
          cwd: input.workspacePath,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          onEvent: (event) => {
            if (expected && this.current === expected) this.handleWorkerEvent(expected, event);
          },
          onLifecycle: (event) => {
            if (expected && this.current === expected) this.handleLifecycle(expected, event);
          },
          onStderr: (chunk) => this.log('[pi-worker:stderr]', chunk),
        });
        expected = {
          ...created,
          logicalSessionId: input.sessionId,
          activeRequestId: null,
          acceptEvents: true,
        };
        this.current = expected;
        this.dispatch({
          type: 'session.created',
          sessionId: input.sessionId,
          requestId,
          payload: {
            agent: PI_AGENT,
            ...(created.bootstrap.sessionFile
              ? { runtimeIdentity: created.bootstrap.sessionFile }
              : {}),
          },
        });
        this.dispatch({
          type: 'session.status',
          sessionId: input.sessionId,
          requestId,
          payload: { status: 'idle' },
        });
      } catch (error) {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }).then(() => requestId);
  }

  async send(input: {
    sessionId: string;
    text: string;
    attachments?: SessionAttachment[];
    model?: string;
    effort?: SessionEffortLevel;
  }): Promise<string> {
    const current = this.requireSession(input.sessionId);
    if (current.activeRequestId) {
      throw new Error(
        `session_busy: session ${input.sessionId} already has active turn ${current.activeRequestId}`
      );
    }
    const requestId = nextRequestId('send');
    const payload: WorkerSendPayload = {
      logicalSessionId: input.sessionId,
      requestId,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    };
    current.activeRequestId = requestId;
    try {
      const result = await current.slot.request<WorkerSendResult, WorkerSendPayload>(
        'worker.send',
        payload
      );
      if (!isWorkerSendResult(result) || result.requestId !== requestId) {
        throw new Error('Pi worker returned an invalid send acknowledgement');
      }
      return requestId;
    } catch (error) {
      if (current.activeRequestId === requestId) current.activeRequestId = null;
      throw error;
    }
  }

  async stop(sessionId: string): Promise<string> {
    const requestId = nextRequestId('stop');
    const current = this.current;
    if (!current || current.logicalSessionId !== sessionId) return requestId;
    const payload: WorkerStopPayload = { logicalSessionId: sessionId, reason: 'user' };
    const result = await current.slot.request<WorkerStopResult, WorkerStopPayload>(
      'worker.stop',
      payload
    );
    if (!isWorkerStopResult(result))
      throw new Error('Pi worker returned an invalid stop acknowledgement');
    return requestId;
  }

  async respondExtensionUi(response: ExtensionUiResponse): Promise<string> {
    const requestId = nextRequestId('extui');
    const current = this.current;
    if (!current) return requestId;
    const payload: WorkerExtensionUiResponsePayload = {
      logicalSessionId: current.logicalSessionId,
      response,
    };
    const result = await current.slot.request<
      WorkerExtensionUiResponseResult,
      WorkerExtensionUiResponsePayload
    >('worker.extensionUi.respond', payload);
    if (!isWorkerExtensionUiResponseResult(result)) {
      throw new Error('Pi worker returned an invalid Extension UI acknowledgement');
    }
    return requestId;
  }

  closeSession(sessionId: string): Promise<string> {
    const requestId = nextRequestId('close');
    return this.serialize(async () => {
      if (this.current?.logicalSessionId !== sessionId) return;
      await this.disposeCurrent('slot-dispose');
    }).then(() => requestId);
  }

  disposeAll(reason: 'app-shutdown' | 'slot-dispose' = 'app-shutdown'): Promise<void> {
    return this.serialize(() => this.disposeCurrent(reason));
  }

  forceKillAllNow(): void {
    const current = this.current;
    this.current = null;
    this.state = 'stopped';
    current?.slot.forceKillNow();
  }

  private requireSession(sessionId: string): CurrentSlot {
    const current = this.current;
    if (!current || current.logicalSessionId !== sessionId) {
      throw new Error(`session_not_found: no Pi WorkerSlot for ${sessionId}`);
    }
    return current;
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycleChain.then(work);
    this.lifecycleChain = run.catch(() => undefined);
    return run;
  }

  private async disposeCurrent(
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): Promise<void> {
    const current = this.current;
    if (!current) {
      this.state = 'stopped';
      return;
    }
    // Stop forwarding immediately, but retain process ownership until graceful
    // disposal finishes so the global deadline/signal path can still force-kill.
    current.acceptEvents = false;
    try {
      await current.slot.dispose(reason);
    } finally {
      if (this.current === current) this.current = null;
      this.state = 'stopped';
    }
  }

  private handleWorkerEvent(current: CurrentSlot, message: WorkerRpcEvent): void {
    if (!current.acceptEvents || message.type !== 'runtime.event') return;
    const event = message.payload as RuntimeEvent;
    if (!event || typeof event.type !== 'string') return;
    if (event.sessionId && event.sessionId !== current.logicalSessionId) return;
    if (
      event.type === 'session.completed' ||
      event.type === 'session.failed' ||
      event.type === 'session.stopped'
    ) {
      current.activeRequestId = null;
    }
    this.dispatch({ ...event, sessionId: event.sessionId ?? current.logicalSessionId });
  }

  private handleLifecycle(current: CurrentSlot, event: WorkerSlotLifecycleEvent): void {
    if (event.type !== 'crashed' || this.current !== current || !current.acceptEvents) return;
    this.current = null;
    this.state = 'error';
    this.lastError = event.error.message;
    if (current.activeRequestId) {
      this.dispatch({
        type: 'session.status',
        sessionId: current.logicalSessionId,
        requestId: current.activeRequestId,
        payload: { status: 'disconnected' },
      });
      this.dispatch({
        type: 'session.failed',
        sessionId: current.logicalSessionId,
        requestId: current.activeRequestId,
        payload: { error: event.error.message },
      });
    }
  }

  private dispatch(event: RuntimeEventDraft): void {
    const stamped = {
      ...event,
      seq: ++this.eventSequence,
      timestamp: Date.now(),
    } as RuntimeEvent;
    for (const handler of this.handlers) handler(stamped);
  }
}

export const piSingleSlotRuntime = new PiSingleSlotRuntime();
