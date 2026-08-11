import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      pendingPermissions: [{ sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' }],
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
    const result = await useChatSessionsStore.getState().respondPermission('perm-1', true);
    expect(result).toBe(true);
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });

  it('respondPermission resolves false and sets lastError when the IPC call rejects', async () => {
    mockElectronAPI({ respondPermission: () => Promise.reject(new Error('boom')) });
    const result = await useChatSessionsStore.getState().respondPermission('perm-1', true);
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

/**
 * Design spec §1.6 / E2-E3: `respondPermission` must always answer the
 * specific card the user clicked, never "whichever permission was requested
 * last" (the pre-fix single-slot store's silent misattribution bug).
 */
describe('respondPermission answers the exact permissionId clicked, never a guess', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  function mockElectronAPI() {
    const respondPermission = vi.fn(() => Promise.resolve({ requestId: 'r1' }));
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: { respondPermission },
      },
    } as unknown as typeof globalThis.window;
    return respondPermission;
  }

  it('A1: with two queued entries, responding to the second sends exactly that permissionId (防错投主用例)', async () => {
    const respondPermission = mockElectronAPI();
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      pendingPermissions: [
        { sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' },
        { sessionId: 's1', permissionId: 'perm-2', messageId: 'm1' },
      ],
      lastError: null,
    });

    const result = await useChatSessionsStore.getState().respondPermission('perm-2', true);

    expect(result).toBe(true);
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith({
      sessionId: 's1',
      permissionId: 'perm-2',
      allow: true,
    });
  });

  it("A2: the IPC call carries the entry's own sessionId, not activeSessionId", async () => {
    const respondPermission = mockElectronAPI();
    useChatSessionsStore.setState({
      // The active session differs from the parked entry's session — a
      // background session can still have a card the user is answering.
      activeSessionId: 's-active',
      pendingPermissions: [{ sessionId: 's-background', permissionId: 'perm-1', messageId: 'm1' }],
      lastError: null,
    });

    await useChatSessionsStore.getState().respondPermission('perm-1', false);

    expect(respondPermission).toHaveBeenCalledWith({
      sessionId: 's-background',
      permissionId: 'perm-1',
      allow: false,
    });
  });

  it('A3: an id no longer in the queue returns false without calling IPC or touching lastError', async () => {
    const respondPermission = mockElectronAPI();
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      pendingPermissions: [{ sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' }],
      lastError: null,
    });

    const result = await useChatSessionsStore.getState().respondPermission('perm-stale', true);

    expect(result).toBe(false);
    expect(respondPermission).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });
});

/**
 * S3 slice 4 §3.2: the decision the user pressed reaches the Host as its own
 * payload key.
 *
 * `allow` cannot carry it. `allow_session` and `allow` both produce
 * `allow: true`, `cancel` and `deny` both produce `allow: false` — so dropping
 * `decision` from this payload turns "Allow for session" into a one-shot allow
 * and "Deny and stop" into an ordinary deny, with no error, no type failure and
 * nothing different on the card. These rows exist because that degradation is
 * invisible everywhere else.
 *
 * The key SET is asserted, not just the values: `toHaveBeenCalledWith` compares
 * with `toEqual` semantics, under which `{…, decision: undefined}` and `{…}` are
 * the same object — which is exactly the difference between "omitted" and "sent
 * as undefined" that the `...(decision ? {decision} : {})` spread exists to make.
 */
describe('respondPermission forwards the pressed decision (S3 slice 4)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  /** Typed so the recorded payload can be read back without a cast. */
  function mockElectronAPI() {
    const respondPermission = vi.fn((_payload: Record<string, unknown>) =>
      Promise.resolve({ requestId: 'r1' })
    );
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: { respondPermission },
      },
    } as unknown as typeof globalThis.window;
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      pendingPermissions: [{ sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' }],
      lastError: null,
    });
    return respondPermission;
  }

  it('A19 (store half): an allow_session click sends decision alongside allow:true', async () => {
    const respondPermission = mockElectronAPI();

    await useChatSessionsStore.getState().respondPermission('perm-1', true, 'allow_session');

    expect(respondPermission).toHaveBeenCalledTimes(1);
    const payload = respondPermission.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['allow', 'decision', 'permissionId', 'sessionId']);
    expect(payload).toEqual({
      sessionId: 's1',
      permissionId: 'perm-1',
      allow: true,
      decision: 'allow_session',
    });
  });

  it('A19 (store half): a cancel click sends decision:cancel alongside allow:false', async () => {
    const respondPermission = mockElectronAPI();

    await useChatSessionsStore.getState().respondPermission('perm-1', false, 'cancel');

    const payload = respondPermission.mock.calls[0][0];
    // Without this key the Host sees a plain deny and the turn is never
    // interrupted — the whole difference between Deny and "Deny and stop".
    expect(payload.decision).toBe('cancel');
    expect(payload.allow).toBe(false);
  });

  it('a two-argument call omits the key entirely (the Claude-side payload, byte for byte)', async () => {
    const respondPermission = mockElectronAPI();

    await useChatSessionsStore.getState().respondPermission('perm-1', true);

    const payload = respondPermission.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['allow', 'permissionId', 'sessionId']);
    // `in`, not a value check: `decision: undefined` would pass every
    // assertion above and still put an unexpected key on the wire.
    expect('decision' in payload).toBe(false);
  });
});
