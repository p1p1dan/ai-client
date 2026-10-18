import { describe, expect, it, vi } from 'vitest';
import {
  resumeIdentityForActivation,
  runSessionActivation,
  type SessionActivationEffects,
} from '../activateSessionStart';

/**
 * The rule behind "clicking a session starts it", stated where a test can read
 * it (`useActivateSession` itself reaches for the store and a React hook).
 *
 * T092 is why the third clause matters now: a conversation the user ended keeps
 * its transcript, so "has a timeline in memory" is no longer a synonym for "was
 * never detached". Anyone tempted to rewrite this as "start whenever the host
 * binding is gone" should read the reclamation case below first.
 */

const RESTORED = {
  runtimeIdentity: '/sessions/s1.jsonl',
  hasWorkspace: true,
  unbound: false,
  hasTimeline: false,
};

describe('resumeIdentityForActivation', () => {
  it('starts a worker for a restored session with no timeline in memory', () => {
    // The everyday case: the row came back from the persisted index after a
    // restart, so there is a file to resume and nothing on screen yet.
    expect(resumeIdentityForActivation(RESTORED)).toBe('/sessions/s1.jsonl');
  });

  it('starts a temporary chat too, which has a runtime but never a workspace', () => {
    // U13: gate on the workspace alone and a temporary chat opens empty forever.
    expect(resumeIdentityForActivation({ ...RESTORED, hasWorkspace: false, unbound: true })).toBe(
      '/sessions/s1.jsonl'
    );
  });

  it('does not start a worker for an ended session whose timeline is still in memory', () => {
    // T092: ending detaches the runtime but keeps the transcript. Clicking the
    // row now just shows it; the runtime comes back on the next SEND.
    expect(resumeIdentityForActivation({ ...RESTORED, hasTimeline: true })).toBeNull();
  });

  it('does not start a worker for a capacity-reclaimed session', () => {
    // Same shape, different cause: the pool took the worker back while the user
    // kept reading. Starting one per click is the pressure reclamation exists
    // to relieve, so the click must stay free.
    expect(resumeIdentityForActivation({ ...RESTORED, hasTimeline: true })).toBeNull();
  });

  it('refuses to start when the session carries no runtime identity', () => {
    // A brand-new chat has no session file yet — its first send creates one.
    expect(resumeIdentityForActivation({ ...RESTORED, runtimeIdentity: undefined })).toBeNull();
  });

  it('refuses to start when there is nowhere to run it', () => {
    expect(
      resumeIdentityForActivation({ ...RESTORED, hasWorkspace: false, unbound: false })
    ).toBeNull();
  });
});

/**
 * T102 (decision 030) — the same gate, but what it triggers changed.
 *
 * The user's report was "after I end a conversation I cannot even SEE its
 * history"; behind it, every click on a stored chat spawned a worker, and with
 * the pool full the click could be refused outright. So a session with no
 * worker is now previewed — Main reads its file and publishes one history
 * event — and the worker waits for the first send.
 */
describe('runSessionActivation', () => {
  const ACTIVATION = { ...RESTORED, sessionId: 's1', hostBound: false };

  function effects(
    overrides: Partial<SessionActivationEffects> = {}
  ): SessionActivationEffects & { preview: ReturnType<typeof vi.fn> } {
    return {
      preview: vi.fn(async () => undefined),
      resume: vi.fn(async () => true),
      ...overrides,
    } as SessionActivationEffects & { preview: ReturnType<typeof vi.fn> };
  }

  it('previews read-only instead of resuming when no worker is alive', async () => {
    const run = effects();
    await expect(runSessionActivation(ACTIVATION, run)).resolves.toBe('previewed');
    expect(run.preview).toHaveBeenCalledWith({
      sessionId: 's1',
      runtimeIdentity: '/sessions/s1.jsonl',
    });
    expect(run.resume).not.toHaveBeenCalled();
  });

  it('a previewed session is not marked host-bound', async () => {
    // `hostBoundSessionIds` is written by the `session.resumed` event, which
    // only the resume effect can produce. So "not host-bound" is exactly "the
    // resume effect was never reached" — the next send still sees a session
    // with no worker and starts one, instead of addressing a worker that was
    // never spawned.
    const run = effects();
    await runSessionActivation(ACTIVATION, run);
    expect(run.resume).not.toHaveBeenCalled();
  });

  it('falls back to resume when the read-only preview is unavailable', async () => {
    // Everything a replay can refuse with — an unfinished SDK operation, a
    // corrupt file, a worker that came up since the renderer last looked —
    // means the same thing here: do what this code did before T102. The resume
    // path reports its own failures through `historyErrors`.
    for (const refusal of ['session_replay_unavailable: cannot decode', 'worker_active']) {
      const run = effects({ preview: vi.fn(async () => Promise.reject(new Error(refusal))) });
      await expect(runSessionActivation(ACTIVATION, run)).resolves.toBe('resumed');
      expect(run.resume).toHaveBeenCalledWith({
        sessionId: 's1',
        runtimeIdentity: '/sessions/s1.jsonl',
      });
    }
  });

  it('resumes straight away for a session that already has a worker', async () => {
    // The worker's in-memory branch is the authority while it exists and its
    // file may lag, so the preview channel would only answer `worker_active`.
    const run = effects();
    await expect(runSessionActivation({ ...ACTIVATION, hostBound: true }, run)).resolves.toBe(
      'resumed'
    );
    expect(run.preview).not.toHaveBeenCalled();
  });

  it('resumes an Agent SDK chat straight away, with no preview to be refused (decision 197)', async () => {
    // Main refuses every SDK preview (only the chat's own host reads the CLI's
    // transcript), so asking would only add a round trip and an error in its log.
    const stub = 'C:\\app-state\\claude\\aiclient-sessions\\cc1.ccsdk.json';
    const run = effects();
    await expect(runSessionActivation({ ...ACTIVATION, runtimeIdentity: stub }, run)).resolves.toBe(
      'resumed'
    );
    expect(run.preview).not.toHaveBeenCalled();
    expect(run.resume).toHaveBeenCalledWith({ sessionId: 's1', runtimeIdentity: stub });
  });

  it('still previews a DSH chat, whose stub the shared host reads (decision 030)', async () => {
    const stub = 'C:\\dsh-home\\aiclient-sessions\\aiclient-s1.dsh.json';
    const run = effects();
    await expect(runSessionActivation({ ...ACTIVATION, runtimeIdentity: stub }, run)).resolves.toBe(
      'previewed'
    );
    expect(run.resume).not.toHaveBeenCalled();
  });

  it('does neither when the three-part rule says this click starts nothing', async () => {
    const run = effects();
    await expect(runSessionActivation({ ...ACTIVATION, hasTimeline: true }, run)).resolves.toBe(
      'idle'
    );
    expect(run.preview).not.toHaveBeenCalled();
    expect(run.resume).not.toHaveBeenCalled();
  });
});

/**
 * The marker the timeline reads instead of saying 「还没有消息」 (`historyLoading.ts`).
 *
 * It has to be set from inside the branches that actually load, not once at the
 * top of the call: an activation that starts nothing loads no transcript, and a
 * spinner on a chat whose history is already on screen would be a new lie in
 * place of the old one.
 */
describe('runSessionActivation onLoad', () => {
  const ACTIVATION = { ...RESTORED, sessionId: 's1', hostBound: false };

  function effects(overrides: Partial<SessionActivationEffects> = {}) {
    return {
      preview: vi.fn(async () => undefined),
      resume: vi.fn(async () => true),
      onLoad: vi.fn(),
      ...overrides,
    } satisfies SessionActivationEffects;
  }

  it('[ASO-01] announces the load before asking for the preview', async () => {
    const order: string[] = [];
    const run = effects({
      preview: vi.fn(async () => {
        order.push('preview');
      }),
      onLoad: vi.fn(() => {
        order.push('onLoad');
      }),
    });
    // The preview is the path most sidebar clicks take, so it is the one the
    // reported 「还没有消息」 came from. Announced first, so the timeline never
    // renders a frame of the empty-chat copy while the request is in flight.
    await runSessionActivation(ACTIVATION, run);
    expect(order).toEqual(['onLoad', 'preview']);
    expect(run.onLoad).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('[ASO-02] announces it once for a preview that falls back to a resume', async () => {
    // Both branches load the same transcript, so the marker is set once and
    // its clock belongs to the call the user actually triggered.
    const run = effects({
      preview: vi.fn(async () => Promise.reject(new Error('session_replay_unavailable'))),
    });
    await expect(runSessionActivation(ACTIVATION, run)).resolves.toBe('resumed');
    expect(run.onLoad).toHaveBeenCalledTimes(1);
  });

  it('[ASO-03] announces it for a host-bound session, which resumes directly', async () => {
    const run = effects();
    await runSessionActivation({ ...ACTIVATION, hostBound: true }, run);
    expect(run.onLoad).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('[ASO-04] stays silent when the click starts nothing', async () => {
    // The T092 case: ended or reclaimed, with its transcript still on screen.
    // Nothing is loading, so nothing may claim to be.
    for (const activation of [
      { ...ACTIVATION, hasTimeline: true },
      { ...ACTIVATION, runtimeIdentity: undefined },
      { ...ACTIVATION, hasWorkspace: false, unbound: false },
    ]) {
      const run = effects();
      await expect(runSessionActivation(activation, run)).resolves.toBe('idle');
      expect(run.onLoad).not.toHaveBeenCalled();
    }
  });

  it('[ASO-05] tolerates a caller with no timeline to paint', async () => {
    const run = effects({ onLoad: undefined });
    await expect(runSessionActivation(ACTIVATION, run)).resolves.toBe('previewed');
  });
});
