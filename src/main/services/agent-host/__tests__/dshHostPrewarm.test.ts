import { describe, expect, it, vi } from 'vitest';
import { createDshHostPrewarm, prewarmDshHost } from '../dshHostPrewarm';

// S-6 feedback 11c: the DSH host starts with the app, once the spawn gate allows it.
describe('prewarmDshHost', () => {
  it('starts the host once the spawn gate allows an agent session', () => {
    const ensureHost = vi.fn(async () => ({}));
    expect(prewarmDshHost({ assertSpawnAllowed: () => {}, ensureHost, log: vi.fn() })).toBe(true);
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });

  it('starts nothing before sign-in', () => {
    const ensureHost = vi.fn(async () => ({}));
    const gate = () => {
      throw new Error('auth_required: Sign-in required before starting an agent session.');
    };
    expect(prewarmDshHost({ assertSpawnAllowed: gate, ensureHost, log: vi.fn() })).toBe(false);
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('a failed start is logged, never thrown: the first send starts the host as before', async () => {
    const log = vi.fn();
    const failure = new Error('DSH_HOST_UNAVAILABLE');
    prewarmDshHost({
      assertSpawnAllowed: () => {},
      ensureHost: () => Promise.reject(failure),
      log,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledWith('DSH host prewarm failed', failure);
  });
});

describe('createDshHostPrewarm', () => {
  it('starts the host once per app run, however often the chat surface asks', () => {
    const ensureHost = vi.fn(async () => ({}));
    const prewarm = createDshHostPrewarm({
      assertSpawnAllowed: () => {},
      ensureHost,
      log: vi.fn(),
    });
    prewarm();
    prewarm();
    prewarm();
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });

  it('tries again after sign-in when the gate refused the first call', () => {
    const ensureHost = vi.fn(async () => ({}));
    let signedIn = false;
    const prewarm = createDshHostPrewarm({
      assertSpawnAllowed: () => {
        if (!signedIn) throw new Error('auth_required');
      },
      ensureHost,
      log: vi.fn(),
    });
    prewarm();
    expect(ensureHost).not.toHaveBeenCalled();
    signedIn = true;
    prewarm();
    prewarm();
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });
});
