import { describe, expect, it, vi } from 'vitest';
import { createDshHostWarmup, DSH_HOST_WARMUP_INTERVAL_MS } from '../dshHostWarmup';

// S-6 feedback 11c (user, 2026-10-17): the DSH host starts again as the user types.
describe('createDshHostWarmup', () => {
  function setup() {
    let now = 1_000;
    const warm = vi.fn(async () => undefined);
    const hook = createDshHostWarmup({ warm, now: () => now });
    const advance = (ms: number) => {
      now += ms;
    };
    return { hook, warm, advance };
  }

  it('asks Main once for a DSH draft, then at most once a minute however much is typed', () => {
    const { hook, warm, advance } = setup();
    expect(hook({ text: 'h', engine: 'dsh' })).toBe(true);
    expect(hook({ text: 'he', engine: 'dsh' })).toBe(false);
    advance(DSH_HOST_WARMUP_INTERVAL_MS - 1);
    expect(hook({ text: 'hel', engine: 'dsh' })).toBe(false);
    advance(1);
    expect(hook({ text: 'hell', engine: 'dsh' })).toBe(true);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it('never asks for an Agent SDK chat, nor for an empty or blank draft', () => {
    const { hook, warm } = setup();
    expect(hook({ text: 'hello', engine: 'claude-sdk' })).toBe(false);
    expect(hook({ text: '', engine: 'dsh' })).toBe(false);
    expect(hook({ text: '   \n', engine: 'dsh' })).toBe(false);
    expect(warm).not.toHaveBeenCalled();
  });

  it('swallows a failed or missing warm-up: the send starts the host as before', async () => {
    let now = 0;
    const failing = createDshHostWarmup({
      warm: () => Promise.reject(new Error('no host')),
      now: () => now,
    });
    expect(failing({ text: 'x', engine: 'dsh' })).toBe(true);
    const missing = createDshHostWarmup({ warm: () => undefined, now: () => now });
    expect(missing({ text: 'x', engine: 'dsh' })).toBe(true);
    const throwing = createDshHostWarmup({
      warm: () => {
        throw new Error('ipc gone');
      },
      now: () => now,
    });
    expect(() => throwing({ text: 'x', engine: 'dsh' })).not.toThrow();
    now += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
