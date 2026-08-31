import { describe, expect, it } from 'vitest';
import { ExtensionUiRouter } from '../extensionUiRouting';

/**
 * Two windows, one blocking dialog.
 *
 * The failure being prevented: `extensionUi.request` is a question the Host is
 * BLOCKED on, and broadcasting it puts the same permission prompt in front of
 * two windows. Both race to answer, the Host accepts the first and refuses the
 * second, and the person who pressed second watches their click do nothing.
 */

const WIN_A = 11;
const WIN_B = 22;

function router(alive: number[] = [WIN_A, WIN_B]) {
  const living = new Set(alive);
  const instance = new ExtensionUiRouter({ isWindowAlive: (id) => living.has(id) });
  return { instance, kill: (id: number) => living.delete(id) };
}

function request(uiRequestId: string, sessionId?: string, method = 'select') {
  return {
    type: 'extensionUi.request',
    ...(sessionId ? { sessionId } : {}),
    payload: { runtimeId: 'rt-1', uiRequestId, method, args: {} },
  };
}

function cancelled(uiRequestIds: string[]) {
  return {
    type: 'extensionUi.cancelled',
    payload: { runtimeId: 'rt-1', uiRequestIds, reason: 'aborted' },
  };
}

describe('ExtensionUiRouter', () => {
  it('sends a session dialog only to the window that drove the session', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.claimSession('s2', WIN_B);

    expect(instance.targetsFor(request('u1', 's1'))).toEqual([WIN_A]);
    expect(instance.targetsFor(request('u2', 's2'))).toEqual([WIN_B]);
  });

  /** Ownership follows the most recent driver — a session picked up elsewhere moves. */
  it('moves ownership when another window drives the same session', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.claimSession('s1', WIN_B);
    expect(instance.targetsFor(request('u1', 's1'))).toEqual([WIN_B]);
  });

  /**
   * An extension asking during INIT belongs to no chat. Every window is as
   * correct as any other, and suppressing it entirely would hide a dialog the
   * Host is blocked on.
   */
  it('broadcasts a dialog with no session', () => {
    const { instance } = router();
    expect(instance.targetsFor(request('u1'))).toBeUndefined();
  });

  it('broadcasts when the owning window is gone', () => {
    const { instance, kill } = router();
    instance.claimSession('s1', WIN_A);
    kill(WIN_A);
    expect(instance.targetsFor(request('u1', 's1'))).toBeUndefined();
  });

  it('broadcasts for a session nobody has claimed', () => {
    const { instance } = router();
    expect(instance.targetsFor(request('u1', 'never-claimed'))).toBeUndefined();
  });

  /**
   * Routed by REMEMBERED target, not recomputed: a cancellation that misses its
   * window leaves a modal on screen that can never be answered, and ownership
   * may legitimately have moved between the request and the cancellation.
   */
  it('sends a cancellation to whichever window got the request', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.targetsFor(request('u1', 's1'));
    instance.claimSession('s1', WIN_B);

    expect(instance.targetsFor(cancelled(['u1']))).toEqual([WIN_A]);
  });

  it('broadcasts a cancellation for an id it never routed', () => {
    const { instance } = router();
    expect(instance.targetsFor(cancelled(['unknown']))).toBeUndefined();
  });

  it('broadcasts when a batch mixes a routed id with an unknown one', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.targetsFor(request('u1', 's1'));
    expect(instance.targetsFor(cancelled(['u1', 'unknown']))).toBeUndefined();
  });

  it('broadcasts a cancellation whose target window has closed', () => {
    const { instance, kill } = router();
    instance.claimSession('s1', WIN_A);
    instance.targetsFor(request('u1', 's1'));
    kill(WIN_A);
    expect(instance.targetsFor(cancelled(['u1']))).toBeUndefined();
  });

  it('leaves every other event on the broadcast path', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    for (const type of ['message.delta', 'tool.completed', 'permission.activity']) {
      expect(instance.targetsFor({ type, sessionId: 's1' })).toBeUndefined();
    }
  });

  it('routes fire-and-forget methods to one owner without retaining request state', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    for (const method of ['notify', 'setStatus', 'setWidget', 'unsupported']) {
      expect(instance.targetsFor(request(`u-${method}`, 's1', method))).toEqual([WIN_A]);
    }
    expect(instance.pendingRequestCount()).toBe(0);
  });

  it('broadcasts fire-and-forget state only when no live owner is known', () => {
    const { instance } = router();
    expect(instance.targetsFor(request('u-notify', 'unclaimed', 'notify'))).toBeUndefined();
  });

  /** Both settle paths must free the entry, or the map grows per prompt forever. */
  it('forgets a routed request once it is settled', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);

    instance.targetsFor(request('u1', 's1'));
    expect(instance.pendingRequestCount()).toBe(1);
    instance.targetsFor(cancelled(['u1']));
    expect(instance.pendingRequestCount()).toBe(0);

    instance.targetsFor(request('u2', 's1'));
    instance.forgetRequest('u2');
    expect(instance.pendingRequestCount()).toBe(0);
  });

  it('drops a closed window’s claims and parked requests', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.targetsFor(request('u1', 's1'));
    instance.releaseWindow(WIN_A);

    expect(instance.pendingRequestCount()).toBe(0);
    expect(instance.targetsFor(request('u2', 's1'))).toBeUndefined();
  });

  it('drops the claim when the session is closed', () => {
    const { instance } = router();
    instance.claimSession('s1', WIN_A);
    instance.releaseSession('s1');
    expect(instance.targetsFor(request('u1', 's1'))).toBeUndefined();
  });
});
