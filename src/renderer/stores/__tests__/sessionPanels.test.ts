import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialSessionPanels } from '@/components/chat/sessionPanelsModel';
import { resetRuntimeEventBus } from '../runtimeEventBus';
import { useSessionPanelsStore } from '../sessionPanels';

/**
 * dsh-rebase P1-7a: the shell around `sessionPanelsModel.ts` — the single
 * listener, the rehydration through `worker.panels` (on `session.resumed`,
 * and for a chat nothing is known about), and the goal command's in-flight
 * guard. The fold itself is `sessionPanelsModel.test.ts`'s.
 */
describe('useSessionPanelsStore (P1-7a)', () => {
  let captured: ((event: RuntimeEvent) => void) | null = null;
  const getSessionPanels = vi.fn();
  const runSessionCommand = vi.fn();

  function event(type: string, sessionId: string, payload: Record<string, unknown>): RuntimeEvent {
    return { type, sessionId, seq: 1, timestamp: 1, payload } as unknown as RuntimeEvent;
  }

  beforeEach(() => {
    resetRuntimeEventBus();
    captured = null;
    getSessionPanels.mockReset();
    runSessionCommand.mockReset();
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: {
          onRuntimeEvent: (callback: (event: RuntimeEvent) => void) => {
            captured = callback;
            return () => undefined;
          },
          getSessionPanels,
          runSessionCommand,
        },
      },
    } as unknown as typeof globalThis.window;
    useSessionPanelsStore.setState({
      ...initialSessionPanels,
      listening: false,
      open: {},
      dismissed: {},
      commandPending: {},
      commandStarting: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('[P7A-STORE-INIT] one listener; projections fold in; a second init is a no-op', () => {
    const stop = useSessionPanelsStore.getState().init();
    expect(useSessionPanelsStore.getState().init()).toBeTypeOf('function');
    captured?.(event('session.projection', 's1', { key: 'todos', view: [] }));
    expect(useSessionPanelsStore.getState().bySession.s1).toMatchObject({ live: true, todos: [] });
    stop();
    expect(useSessionPanelsStore.getState().listening).toBe(false);
  });

  it('[P7A-STORE-RESUMED] a resumed session is asked for its panels once', async () => {
    getSessionPanels.mockResolvedValue({
      projections: [{ key: 'todos', view: [{ content: 'a', status: 'in_progress' }] }],
    });
    useSessionPanelsStore.getState().init();
    captured?.(event('session.resumed', 's1', {}));
    await vi.waitFor(() =>
      expect(useSessionPanelsStore.getState().bySession.s1?.todos).toEqual([
        { content: 'a', status: 'in_progress' },
      ])
    );
    expect(getSessionPanels).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(getSessionPanels).toHaveBeenCalledTimes(1);
  });

  it('[P7A-STORE-ENSURE] a chat already heard from is not asked; a failed read costs nothing', async () => {
    getSessionPanels.mockRejectedValue(new Error('no slot'));
    useSessionPanelsStore.getState().init();
    captured?.(event('session.projection', 's1', { key: 'todos', view: null }));
    useSessionPanelsStore.getState().ensureHydrated('s1');
    expect(getSessionPanels).not.toHaveBeenCalled();
    useSessionPanelsStore.getState().ensureHydrated('s2');
    await vi.waitFor(() => expect(getSessionPanels).toHaveBeenCalledWith({ sessionId: 's2' }));
    expect(useSessionPanelsStore.getState().bySession.s2).toBeUndefined();
  });

  /** A conversation the engine runs: nothing to start. */
  const running = {
    start: vi.fn(async () => ({ kind: 'running' as const })),
    isRunning: () => true,
    forgetRunning: vi.fn(),
  };

  it('[P7A-STORE-CMD] a goal command in flight holds the session’s buttons; the answer comes back', async () => {
    let settle: (value: unknown) => void = () => undefined;
    runSessionCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const first = useSessionPanelsStore.getState().runGoalCommand('s1', '/goal pause', running);
    expect(useSessionPanelsStore.getState().commandPending.s1).toBe(true);
    await expect(
      useSessionPanelsStore.getState().runGoalCommand('s1', '/goal resume', running)
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(runSessionCommand).toHaveBeenCalledTimes(1));
    settle({ ok: true, output: 'Goal paused' });
    await expect(first).resolves.toEqual({
      kind: 'done',
      value: { ok: true, output: 'Goal paused' },
      started: false,
    });
    expect(useSessionPanelsStore.getState().commandPending.s1).toBeUndefined();
    expect(runSessionCommand).toHaveBeenCalledTimes(1);
    expect(runSessionCommand).toHaveBeenCalledWith({ sessionId: 's1', line: '/goal pause' });
    expect(running.start).not.toHaveBeenCalled();
  });

  it('[176-STORE-CMD] on a conversation not running: started first (the bar says so), then the command', async () => {
    let finishStart: () => void = () => undefined;
    const effects = {
      start: vi.fn(
        () =>
          new Promise<{ kind: 'started' }>((resolve) => {
            finishStart = () => resolve({ kind: 'started' });
          })
      ),
      isRunning: () => false,
      forgetRunning: vi.fn(),
    };
    runSessionCommand.mockResolvedValue({ ok: true });
    const pending = useSessionPanelsStore.getState().runGoalCommand('s1', '/goal resume', effects);
    expect(useSessionPanelsStore.getState().commandStarting.s1).toBe(true);
    expect(runSessionCommand).not.toHaveBeenCalled();
    finishStart();
    await expect(pending).resolves.toEqual({ kind: 'done', value: { ok: true }, started: true });
    expect(effects.start).toHaveBeenCalledWith('s1');
    expect(runSessionCommand).toHaveBeenCalledWith({ sessionId: 's1', line: '/goal resume' });
    expect(useSessionPanelsStore.getState().commandStarting.s1).toBeUndefined();
    expect(useSessionPanelsStore.getState().commandPending.s1).toBeUndefined();
  });

  it('[176-STORE-CMD-REFUSED] a start that did not happen runs nothing and says why', async () => {
    const effects = {
      start: vi.fn(async () => ({
        kind: 'failed' as const,
        code: 'session_cwd_mismatch' as const,
      })),
      isRunning: () => false,
      forgetRunning: vi.fn(),
    };
    await expect(
      useSessionPanelsStore.getState().runGoalCommand('s1', '/goal clear', effects)
    ).resolves.toEqual({
      kind: 'not-started',
      start: { kind: 'failed', code: 'session_cwd_mismatch' },
    });
    expect(runSessionCommand).not.toHaveBeenCalled();
    expect(useSessionPanelsStore.getState().commandStarting.s1).toBeUndefined();
  });

  it('[P7A-STORE-PRUNE] drops sessions no longer in the tree, strips state included', () => {
    useSessionPanelsStore.getState().init();
    captured?.(event('session.projection', 's1', { key: 'todos', view: null }));
    captured?.(event('session.projection', 's2', { key: 'todos', view: null }));
    useSessionPanelsStore.getState().setOpen('s1', 'goal', true);
    useSessionPanelsStore.getState().dismissGoal('s1', 'goal-1#2');
    const before = useSessionPanelsStore.getState();
    useSessionPanelsStore.getState().pruneSessions(['s1', 's2']);
    expect(useSessionPanelsStore.getState()).toBe(before);
    useSessionPanelsStore.getState().pruneSessions(['s2']);
    const after = useSessionPanelsStore.getState();
    expect(Object.keys(after.bySession)).toEqual(['s2']);
    expect(after.open).toEqual({});
    expect(after.dismissed).toEqual({});
  });
});
