import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-3e (decision 151): the probe bundle's stuck row, which holds a
 * tool call past its abort so Stop ladder B can be reached on a real host. It
 * is test-only: off unless its variable is set, and never in the product
 * bundle (decision 015).
 */

const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = join(HOST_DIR, 'tools', 'probe-bundle');
const ENV = 'AICLIENT_DSH_PROBE_STUCK_TOOL';

type Listener = (exec: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>;

interface StuckRow {
  name: string;
  STUCK_TOOL_ENV: string;
  apply(ctx: unknown): void;
}

// A runtime path: the probe bundle is plain JS outside this package's type check.
const loadRow = async () =>
  (await import(pathToFileURL(join(PROBE_DIR, 'lib', 'stuck.js')).href)) as StuckRow;

function fakeCtx() {
  const listeners = new Map<string, Listener>();
  const warnings: string[] = [];
  const ctx = {
    logger: (_name: string) => ({ warn: (message: string) => warnings.push(message) }),
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  return { ctx, listeners, warnings };
}

/** 'pending' when `promise` has not settled after a few macrotasks. */
async function stateOf(promise: Promise<unknown>): Promise<'pending' | 'settled'> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let tick = 0; tick < 5; tick += 1) await new Promise((done) => setTimeout(done, 0));
  return settled ? 'settled' : 'pending';
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('aiclient-probe-stuck (P1-3e)', () => {
  it('is a probe bundle row, off unless its variable is set, and absent from the product bundle', () => {
    const patch = readFileSync(join(PROBE_DIR, 'cordis.patch.yml'), 'utf8');
    const row = patch.slice(patch.indexOf('- id: aiclient-probe-stuck'));
    expect(row).toMatch(/^- id: aiclient-probe-stuck\n\s+name: '@aiclient\/dsh-probe\/stuck'\n/);
    expect(row).toContain(`disabled: !!js "!process.env.${ENV}"`);
    const manifest = JSON.parse(readFileSync(join(PROBE_DIR, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['./stuck']).toBe('./lib/stuck.js');
    const product = readFileSync(join(HOST_DIR, 'bundle', 'cordis.patch.yml'), 'utf8');
    expect(product).not.toMatch(/aiclient-probe|dsh-probe|PROBE_STUCK/);
  });

  it('registers nothing without the variable', async () => {
    const row = await loadRow();
    expect(row.name).toBe('aiclient-probe-stuck');
    expect(row.STUCK_TOOL_ENV).toBe(ENV);
    vi.stubEnv(ENV, '');
    const { ctx, listeners, warnings } = fakeCtx();
    row.apply(ctx);
    expect(listeners.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('passes every other call through', async () => {
    vi.stubEnv(ENV, 'NEEDLE-1');
    const { ctx, listeners } = fakeCtx();
    (await loadRow()).apply(ctx);
    const listener = listeners.get('tools/execute');
    expect(listener).toBeDefined();
    const next = vi.fn(async () => 'ran');
    await expect(
      listener?.(
        {
          name: 'bash',
          callId: 'c0',
          arguments: { command: 'ls' },
          signal: new AbortController().signal,
        },
        next
      )
    ).resolves.toBe('ran');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('holds a matching call past its abort, without running it', async () => {
    vi.stubEnv(ENV, 'NEEDLE-1');
    const { ctx, listeners, warnings } = fakeCtx();
    (await loadRow()).apply(ctx);
    const listener = listeners.get('tools/execute') as Listener;
    const next = vi.fn(async () => 'ran');
    const abort = new AbortController();
    const held = listener(
      {
        name: 'bash',
        callId: 'c1',
        arguments: { command: 'echo NEEDLE-1; sleep 60' },
        signal: abort.signal,
      },
      next
    );
    expect(await stateOf(held)).toBe('pending');
    abort.abort({ kind: 'user' });
    expect(await stateOf(held)).toBe('pending');
    expect(next).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      'armed: a tool call whose arguments contain "NEEDLE-1" is held',
      'holding bash call c1; its abort will be ignored',
      'abort ignored: bash call c1',
    ]);

    // A call that arrives already aborted is held all the same.
    const late = new AbortController();
    late.abort();
    const second = listener(
      { name: 'bash', callId: 'c2', arguments: { command: 'NEEDLE-1' }, signal: late.signal },
      next
    );
    expect(await stateOf(second)).toBe('pending');
    expect(warnings.slice(3)).toEqual([
      'holding bash call c2; its abort will be ignored',
      'abort ignored: bash call c2',
    ]);
  });
});
