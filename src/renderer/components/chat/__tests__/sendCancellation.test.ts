import { describe, expect, it, vi } from 'vitest';
import { createSendCancellation, SEND_CANCELLED } from '../sendCancellation';

/**
 * Decision 046 rule 2 (H3b): Stop must release a send that is parked on a
 * handshake IPC at once, and whatever that IPC does afterwards must not reach
 * the attempt that no longer exists.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSendCancellation', () => {
  it('passes the work result through while not cancelled', async () => {
    const cancellation = createSendCancellation();
    await expect(cancellation.race(Promise.resolve('ok'))).resolves.toBe('ok');
    expect(cancellation.cancelled).toBe(false);
  });

  it('propagates a rejection that happens before the cancel', async () => {
    const cancellation = createSendCancellation();
    await expect(cancellation.race(Promise.reject(new Error('host down')))).rejects.toThrow(
      'host down'
    );
  });

  it('settles a pending race the moment cancel() runs, and drops the late result', async () => {
    const cancellation = createSendCancellation();
    const ipc = deferred<string>();
    const raced = cancellation.race(ipc.promise);
    cancellation.cancel();
    await expect(raced).resolves.toBe(SEND_CANCELLED);
    ipc.resolve('late');
    await expect(raced).resolves.toBe(SEND_CANCELLED);
    expect(cancellation.cancelled).toBe(true);
  });

  it('observes a late rejection so it is never unhandled, and never surfaces it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const cancellation = createSendCancellation();
      const ipc = deferred<string>();
      const raced = cancellation.race(ipc.promise);
      cancellation.cancel();
      ipc.reject(new Error('late failure'));
      await expect(raced).resolves.toBe(SEND_CANCELLED);
      // Let any unhandled-rejection bookkeeping run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('answers SEND_CANCELLED at once for a race started after the cancel', async () => {
    const cancellation = createSendCancellation();
    cancellation.cancel();
    const never = new Promise<string>(() => {});
    await expect(cancellation.race(never)).resolves.toBe(SEND_CANCELLED);
  });

  it('wakes every pending race, and cancel() is idempotent', async () => {
    const cancellation = createSendCancellation();
    const a = cancellation.race(new Promise<number>(() => {}));
    const b = cancellation.race(new Promise<string>(() => {}));
    cancellation.cancel();
    cancellation.cancel();
    await expect(Promise.all([a, b])).resolves.toEqual([SEND_CANCELLED, SEND_CANCELLED]);
  });
});
