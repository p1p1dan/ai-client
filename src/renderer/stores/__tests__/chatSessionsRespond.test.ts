import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatSessionsStore } from '../chatSessions';

/**
 * T-05 adversarial-review fix #4: `respondPermission` / `respondQuestion`
 * now resolve `Promise<boolean>` — `true` on a successful IPC round-trip,
 * `false` (with `lastError` set) when the IPC call rejects — instead of
 * being fire-and-forget. `QuestionCard.tsx` awaits this to unlock a
 * submitting UI on failure rather than leaving Continue/Skip/Allow/Deny
 * stuck disabled forever.
 */
describe('respondPermission / respondQuestion resolve a success/failure boolean (T-05 adversarial fix #4)', () => {
  beforeEach(() => {
    useChatSessionsStore.setState({
      pendingPermission: { sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' },
      pendingQuestion: { sessionId: 's1', questionId: 'q1', messageId: 'm1' },
      lastError: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  function mockElectronAPI(overrides: {
    respondPermission?: () => Promise<unknown>;
    respondQuestion?: () => Promise<unknown>;
  }) {
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: {
          respondPermission:
            overrides.respondPermission ?? (() => Promise.resolve({ requestId: 'r1' })),
          respondQuestion:
            overrides.respondQuestion ?? (() => Promise.resolve({ requestId: 'r2' })),
        },
      },
    } as unknown as typeof globalThis.window;
  }

  it('respondPermission resolves true on a successful IPC round-trip', async () => {
    mockElectronAPI({});
    const result = await useChatSessionsStore.getState().respondPermission(true);
    expect(result).toBe(true);
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });

  it('respondPermission resolves false and sets lastError when the IPC call rejects', async () => {
    mockElectronAPI({ respondPermission: () => Promise.reject(new Error('boom')) });
    const result = await useChatSessionsStore.getState().respondPermission(true);
    expect(result).toBe(false);
    expect(useChatSessionsStore.getState().lastError).toBe('boom');
  });

  it('respondQuestion resolves true on a successful IPC round-trip', async () => {
    mockElectronAPI({});
    const result = await useChatSessionsStore.getState().respondQuestion({ answers: { q: 'a' } });
    expect(result).toBe(true);
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });

  it('respondQuestion resolves false and sets lastError when the IPC call rejects', async () => {
    mockElectronAPI({ respondQuestion: () => Promise.reject(new Error('nope')) });
    const result = await useChatSessionsStore.getState().respondQuestion({ cancel: true });
    expect(result).toBe(false);
    expect(useChatSessionsStore.getState().lastError).toBe('nope');
  });
});
