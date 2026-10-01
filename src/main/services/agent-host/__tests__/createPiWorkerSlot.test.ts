import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcRequest } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import { createPiWorkerSlot } from '../createPiWorkerSlot';
import { dshHostSupervisor } from '../DshHostSupervisor';
import type { WorkerTransport, WorkerTransportExit } from '../WorkerTransport';

/**
 * dsh-rebase P1-1: the default transport is the DSH host, in every build (the
 * native worker launcher itself was deleted in P1-12 step 1). `electron` is
 * stubbed so either `isPackaged` can be set; the choice must not
 * depend on it. P1-3a: the default is a channel on the one shared host, opened
 * through its supervisor (stubbed: no host is ever started here).
 */
const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../DshHostSupervisor', () => ({ dshHostSupervisor: { openChannel: vi.fn() } }));

class LoopbackTransport implements WorkerTransport {
  readonly pid = 4321;
  readonly requests: WorkerRpcRequest[] = [];
  readonly kill = vi.fn(() => true);
  private messageListeners = new Set<(message: unknown) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private exitListeners = new Set<(exit: WorkerTransportExit) => void>();
  private stderrListeners = new Set<(chunk: string) => void>();

  postMessage(message: WorkerRpcRequest): void {
    this.requests.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onExit(listener: (exit: WorkerTransportExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  respond(request: WorkerRpcRequest, result: unknown): void {
    for (const listener of this.messageListeners) {
      listener({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'response',
        generation: request.generation,
        requestId: request.requestId,
        ok: true,
        result,
      });
    }
  }

  exit(): void {
    for (const listener of this.exitListeners) listener({ code: 0, signal: null });
  }
}

const BOOTSTRAP_ACK = {
  bootstrapped: true,
  logicalSessionId: 'logical-1',
  piSessionId: 'aiclient-logical-1',
  cwd: '/repo',
  agentDir: '/dsh-home',
  sessionFile: '/dsh-home/aiclient-sessions/aiclient-logical-1.dsh.json',
  leaf: { activeEntryId: null, fileTailEntryId: null },
  projectTrusted: true,
  permissionGate: 'bundled',
};

/** A workspace that exists on every test machine. */
const WORKSPACE = tmpdir();

describe('createPiWorkerSlot', () => {
  it.each([
    false,
    true,
  ])('[P1-1] opens a channel on the shared DSH host, never the native worker (isPackaged=%s)', async (packaged) => {
    electronApp.isPackaged = packaged;
    const transport = new LoopbackTransport();
    vi.mocked(dshHostSupervisor.openChannel).mockReset();
    vi.mocked(dshHostSupervisor.openChannel).mockResolvedValue(transport as never);
    const creating = createPiWorkerSlot({
      slotKey: `workspace:${WORKSPACE}`,
      logicalSessionId: 'logical-1',
      cwd: WORKSPACE,
      generation: 3,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(dshHostSupervisor.openChannel).toHaveBeenCalledTimes(1);
    // A crash restart is not the user's: it may not revive a failed host.
    expect(dshHostSupervisor.openChannel).toHaveBeenCalledWith({ userInitiated: false });
    expect(transport.requests[0]).toMatchObject({
      type: 'worker.bootstrap',
      generation: 3,
      payload: { cwd: WORKSPACE },
    });
    transport.respond(transport.requests[0], BOOTSTRAP_ACK);
    await expect(creating).resolves.toMatchObject({
      bootstrap: { sessionFile: BOOTSTRAP_ACK.sessionFile },
    });
  });

  it('[P1-3a] lets a user-initiated open retry a failed host', async () => {
    const transport = new LoopbackTransport();
    vi.mocked(dshHostSupervisor.openChannel).mockReset();
    vi.mocked(dshHostSupervisor.openChannel).mockResolvedValue(transport as never);
    void createPiWorkerSlot({
      slotKey: `workspace:${WORKSPACE}`,
      logicalSessionId: 'logical-1',
      cwd: WORKSPACE,
      userInitiated: true,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(dshHostSupervisor.openChannel).toHaveBeenCalledWith({ userInitiated: true });
  });

  it('[P1-3a] refuses a vanished workspace before the host is asked for anything', async () => {
    vi.mocked(dshHostSupervisor.openChannel).mockReset();
    await expect(
      createPiWorkerSlot({
        slotKey: 'workspace:/gone',
        logicalSessionId: 'logical-1',
        cwd: join(WORKSPACE, 'aiclient-no-such-workspace-p1-3a'),
      })
    ).rejects.toThrow(/WORKER_WORKSPACE_MISSING: .*aiclient-no-such-workspace-p1-3a/);
    expect(dshHostSupervisor.openChannel).not.toHaveBeenCalled();
  });

  it('[P1-3a] fails without a slot when the host cannot open a channel', async () => {
    vi.mocked(dshHostSupervisor.openChannel).mockReset();
    vi.mocked(dshHostSupervisor.openChannel).mockRejectedValue(
      new Error('DSH_HOST_START_FAILED: the DSH host exited before ready')
    );
    const onSlotCreated = vi.fn();
    await expect(
      createPiWorkerSlot({
        slotKey: `workspace:${WORKSPACE}`,
        logicalSessionId: 'logical-1',
        cwd: WORKSPACE,
        onSlotCreated,
      })
    ).rejects.toThrow(/DSH_HOST_START_FAILED/);
    expect(onSlotCreated).not.toHaveBeenCalled();
  });

  it('accepts a transport factory that resolves asynchronously', async () => {
    const transport = new LoopbackTransport();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: async () => transport,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    transport.respond(transport.requests[0], BOOTSTRAP_ACK);
    await expect(creating).resolves.toMatchObject({ bootstrap: { bootstrapped: true } });
  });

  it('exposes process ownership before bootstrap acknowledgement', async () => {
    const transport = new LoopbackTransport();
    const onSlotCreated = vi.fn();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => transport,
      onSlotCreated,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(onSlotCreated).toHaveBeenCalledTimes(1);
    expect(onSlotCreated.mock.calls[0][0].pid).toBe(4321);
    transport.respond(transport.requests[0], {
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'pi-1',
      cwd: '/repo',
      agentDir: '/managed/pi-agent',
      sessionFile: '/managed/pi-agent/sessions/one.jsonl',
      leaf: { activeEntryId: null, fileTailEntryId: null },
      projectTrusted: false,
      permissionGate: 'bundled',
    });
    await creating;
  });

  it('returns a slot only after one valid bootstrap acknowledgement', async () => {
    const transport = new LoopbackTransport();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      generation: 2,
      model: 'pilab/company-model',
      effort: 'high',
      createTransport: () => transport,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(transport.requests[0]).toMatchObject({
      type: 'worker.bootstrap',
      generation: 2,
      payload: {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        model: 'pilab/company-model',
        effort: 'high',
      },
    });
    transport.respond(transport.requests[0], {
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'pi-1',
      cwd: '/repo',
      agentDir: '/managed/pi-agent',
      sessionFile: '/managed/pi-agent/sessions/one.jsonl',
      leaf: { activeEntryId: null, fileTailEntryId: null },
      model: 'pilab/company-model',
      effort: 'high',
      projectTrusted: false,
      permissionGate: 'bundled',
    });

    const created = await creating;
    expect(created.slot.state).toBe('running');
    expect(created.slot.generation).toBe(2);
    expect(created.bootstrap.sessionFile).toContain('one.jsonl');
  });

  /**
   * dsh-rebase P1-1 (P1-5 WM-01). A chat slot is a DSH host, which never reads
   * a model catalog, and the host's RPC server keeps the whole bootstrap
   * payload for the life of the session — so a catalog here would park the
   * user's plaintext provider keys in that process for nothing. The options
   * type no longer admits the field; this pins the payload even for a caller
   * that gets one past the type.
   */
  it('never sends a model catalog in the bootstrap, even when a caller supplies one', async () => {
    const transport = new LoopbackTransport();
    const smuggled = {
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      modelCatalog: {
        models: { providers: { gw: { api: 'anthropic-messages', models: [{ id: 'm' }] } } },
        auth: { gw: { type: 'api_key', key: 'sk-canary' } },
      },
      createTransport: () => transport,
    } as Parameters<typeof createPiWorkerSlot>[0];
    void createPiWorkerSlot(smuggled);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(transport.requests[0].type).toBe('worker.bootstrap');
    expect(transport.requests[0].payload).not.toHaveProperty('modelCatalog');
    expect(JSON.stringify(transport.requests[0])).not.toContain('sk-canary');
  });

  /**
   * Same absence rule for the two prompt cache TTLs: the worker applies the
   * shipped defaults when neither key travels, so an install on the defaults
   * must not start sending fields `sameBootstrap` would then have to compare.
   */
  it('carries the prompt cache TTLs when set, and omits them otherwise', async () => {
    const chosen = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      promptCacheTtl: '1h',
      subagentPromptCacheTtl: '5m',
      createTransport: () => chosen,
    });
    await vi.waitFor(() => expect(chosen.requests).toHaveLength(1));
    expect(chosen.requests[0].payload).toMatchObject({
      promptCacheTtl: '1h',
      subagentPromptCacheTtl: '5m',
    });

    const untouched = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => untouched,
    });
    await vi.waitFor(() => expect(untouched.requests).toHaveLength(1));
    expect(untouched.requests[0].payload).not.toHaveProperty('promptCacheTtl');
    expect(untouched.requests[0].payload).not.toHaveProperty('subagentPromptCacheTtl');
  });

  /**
   * The 2026-09-05 startup defect: bootstrap shared `WorkerSlot`'s 10s warm-RPC
   * budget, so a cold start that ran long failed `chat:resumeSession` with
   * `worker.bootstrap timed out after 10000ms` and left the session unopenable.
   * Asserted through the message the user actually saw, since that string is
   * what the timeout is measured in.
   */
  it('gives bootstrap a cold-start budget instead of the warm request timeout', async () => {
    vi.useFakeTimers();
    try {
      const transport = new LoopbackTransport();
      const creating = createPiWorkerSlot({
        slotKey: 'workspace:/repo',
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        createTransport: () => transport,
        // The warm budget the defect used. Bootstrap must not adopt it.
        requestTimeoutMs: 10_000,
        disposeTimeoutMs: 100,
        exitTimeoutMs: 100,
      });
      const rejection = expect(creating).rejects.toThrow(
        /worker\.bootstrap timed out after 60000ms/
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(transport.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(50_000);
      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the process when bootstrap acknowledgement is invalid', async () => {
    const transport = new LoopbackTransport();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => transport,
      disposeTimeoutMs: 100,
      exitTimeoutMs: 100,
    });
    const rejection = expect(creating).rejects.toThrow(/invalid bootstrap acknowledgement/);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    transport.respond(transport.requests[0], { bootstrapped: false });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(transport.requests[1].type).toBe('worker.dispose');
    transport.respond(transport.requests[1], { disposed: true });
    transport.exit();

    await rejection;
    expect(transport.kill).toHaveBeenCalledTimes(1);
  });
});
