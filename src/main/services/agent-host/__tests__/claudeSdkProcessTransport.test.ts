import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClaudeSdkProcessTransport } from '../ClaudeSdkProcessTransport';

/**
 * Route B S-3 (topic s3-project-config.md K-5): Main hands the SDK host the
 * gateway key as the first IPC message, never in its environment. A real child
 * (this test's own node) reports what it got first and whether the key is
 * anywhere in its environment.
 */

const KEY = 'sk-fake-transport-test-key';
const CHILD = `
process.once('message', (first) => {
  const envHasKey = Object.values(process.env).some((value) => value === first.apiKey);
  process.send({ first, envHasKey }, () => process.exit(0));
});
`;

describe('ClaudeSdkProcessTransport', () => {
  it('sends the key as the first message and never in the environment', async () => {
    const transport = new ClaudeSdkProcessTransport({
      command: process.execPath,
      args: ['-e', CHILD],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      apiKey: KEY,
    });
    const report = await new Promise<unknown>((resolve) => transport.onMessage(resolve));
    expect(report).toEqual({ first: { type: 'host.secret', apiKey: KEY }, envHasKey: false });
    await new Promise<void>((resolve) => transport.onExit(() => resolve()));
  });
});

/**
 * Dsh-rebase decision 195: the product proxy goes with the key, never in the
 * environment, and every later change follows while the host lives.
 */
describe('ClaudeSdkProcessTransport and the product proxy (decision 195)', () => {
  const PROXY = { url: 'http://pi:pr0xy-secret-word@proxy.corp:8080', noProxy: 'localhost' };
  /** Echoes every message, says whether the proxy URL is in its environment, exits on `bye`. */
  const ECHO = `
process.on('message', (message) => {
  if (message === 'bye') return process.exit(0);
  const envHasProxy = Object.values(process.env).some((value) => String(value).includes('pr0xy-secret-word'));
  process.send({ message, envHasProxy });
});
`;

  function source(current: typeof PROXY | null | undefined) {
    const listeners = new Set<(setting: typeof PROXY | null) => void>();
    return {
      current: () => current,
      subscribe: (listener: (setting: typeof PROXY | null) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      announce: (setting: typeof PROXY | null) => {
        for (const listener of listeners) listener(setting);
      },
      listeners,
    };
  }

  function start(proxy: ReturnType<typeof source>) {
    const transport = new ClaudeSdkProcessTransport({
      command: process.execPath,
      args: ['-e', ECHO],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      apiKey: KEY,
      proxy,
    });
    const received: unknown[] = [];
    let wake: (() => void) | undefined;
    transport.onMessage((report) => {
      received.push(report);
      wake?.();
    });
    const next = async (count: number) => {
      while (received.length < count) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return received[count - 1];
    };
    return { transport, next };
  }

  it('sends the proxy with the key, then each change, and stops listening when the host exits', async () => {
    const proxy = source(PROXY);
    const { transport, next } = start(proxy);
    expect(await next(1)).toEqual({
      message: { type: 'host.secret', apiKey: KEY, proxy: PROXY },
      envHasProxy: false,
    });
    proxy.announce(null);
    expect(await next(2)).toEqual({
      message: { type: 'host.proxy', proxy: null },
      envHasProxy: false,
    });
    const exited = new Promise<void>((resolve) => transport.onExit(() => resolve()));
    (transport as unknown as { child: { send(m: unknown): void } }).child.send('bye');
    await exited;
    expect(proxy.listeners.size).toBe(0);
  });

  it('sends no proxy at all while Main keeps the engines off it', async () => {
    const proxy = source(undefined);
    const { transport, next } = start(proxy);
    expect(await next(1)).toEqual({
      message: { type: 'host.secret', apiKey: KEY },
      envHasProxy: false,
    });
    expect(proxy.listeners.size).toBe(0);
    transport.kill();
  });
});
