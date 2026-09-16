import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * concurrency-09 — the import worker is a process nobody counted.
 *
 * `WorkerManager` sizes itself by `entriesBySession`, and an import fork never
 * enters that map, so the real process peak is `capacity + 1` while the
 * application still reports it is inside its limit. These cases pin the rule at
 * the place the fork happens: one import worker at a time, and a seat that is
 * given back when the process is gone however it went.
 */
vi.mock('../../agent-host/PiWorkerProcess', () => ({ forkPiWorkerProcess: vi.fn() }));
vi.mock('../../agent-host/WorkerSlot', () => ({ WorkerSlot: vi.fn() }));

import { forkPiWorkerProcess } from '../../agent-host/PiWorkerProcess';
import { WorkerSlot } from '../../agent-host/WorkerSlot';
import { importWorkerCount, inspectPiImport, MAX_IMPORT_WORKERS } from '../PiImportProcess';

interface Stage {
  exit: () => void;
  request: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function stage(options: { disposeFails?: boolean } = {}): Stage {
  const exits: (() => void)[] = [];
  const kill = vi.fn(() => true);
  vi.mocked(forkPiWorkerProcess).mockReturnValue({
    process: {} as never,
    transport: {
      pid: 4242,
      postMessage: () => undefined,
      onMessage: () => () => undefined,
      onError: () => () => undefined,
      onExit: (listener: (exit: { code: number | null; signal: string | null }) => void) => {
        exits.push(() => listener({ code: 0, signal: null }));
        return () => undefined;
      },
      onStderr: () => () => undefined,
      kill,
    },
  });
  const request = vi.fn(async () => ({ sessionFiles: ['/tmp/a.jsonl'] }));
  const dispose = vi.fn(async () => {
    if (options.disposeFails) throw new Error('dispose failed');
  });
  vi.mocked(WorkerSlot).mockImplementation(
    () => ({ request, dispose, pid: 4242, state: 'running' }) as never
  );
  return {
    exit: () => {
      for (const listener of exits) listener();
    },
    request,
    dispose,
    kill,
  };
}

const payload = { logicalSessionId: 'session-1', workspacePath: '/work' } as never;

describe('import worker accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds exactly one seat while the import runs and gives it back after', async () => {
    const live = stage();
    expect(importWorkerCount()).toBe(0);
    live.request.mockImplementation(async () => {
      expect(importWorkerCount()).toBe(MAX_IMPORT_WORKERS);
      return { sessionFiles: ['/tmp/a.jsonl'] };
    });
    await expect(inspectPiImport(payload)).resolves.toMatchObject({
      sessionFiles: ['/tmp/a.jsonl'],
    });
    expect(importWorkerCount()).toBe(0);
  });

  it('refuses a second import worker before it forks one', async () => {
    const live = stage();
    let release: () => void = () => undefined;
    live.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sessionFiles: ['/tmp/a.jsonl'] } as never);
        })
    );
    const first = inspectPiImport(payload);
    await expect(inspectPiImport(payload)).rejects.toThrow(/already running/);
    // The point of refusing at the fork site: no second process was created.
    expect(vi.mocked(forkPiWorkerProcess)).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(importWorkerCount()).toBe(0);
  });

  it('gives the seat back when the worker exits, even though dispose failed', async () => {
    // Without the exit subscription the seat would be stranded here — `release`
    // sits after the `dispose` that threw — and every later import in this app
    // session would be refused.
    const live = stage({ disposeFails: true });
    await expect(inspectPiImport(payload)).rejects.toThrow('dispose failed');
    expect(importWorkerCount()).toBe(MAX_IMPORT_WORKERS);
    live.exit();
    expect(importWorkerCount()).toBe(0);
  });

  it('gives the seat back when the fork itself throws', async () => {
    // The third way an import ends, and the one neither dispose nor the exit
    // subscription can cover: `forkPiWorkerProcess` throws before any process
    // exists — a workspace directory that is gone, or a packaged Windows build
    // with no bundled node runtime. Nothing downstream is left to release the
    // seat, so holding it here would refuse every later import in this app.
    stage();
    vi.mocked(forkPiWorkerProcess).mockImplementation(() => {
      throw new Error('WORKER_WORKSPACE_MISSING: Pi worker working directory is missing: /work');
    });
    await expect(inspectPiImport(payload)).rejects.toThrow(/WORKER_WORKSPACE_MISSING/);
    expect(importWorkerCount()).toBe(0);

    stage();
    await expect(inspectPiImport(payload)).resolves.toMatchObject({
      sessionFiles: ['/tmp/a.jsonl'],
    });
    expect(importWorkerCount()).toBe(0);
  });

  it('kills the forked process and frees the seat when slot setup throws', async () => {
    // Here a process DID get created, so releasing the seat alone would leave a
    // worker nobody holds a handle to. Kill it, then release.
    const live = stage();
    vi.mocked(WorkerSlot).mockImplementation(() => {
      throw new Error('slot setup failed');
    });
    await expect(inspectPiImport(payload)).rejects.toThrow('slot setup failed');
    expect(importWorkerCount()).toBe(0);
    expect(live.kill).toHaveBeenCalledTimes(1);
  });
});
