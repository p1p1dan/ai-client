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

  it('does neither when the three-part rule says this click starts nothing', async () => {
    const run = effects();
    await expect(runSessionActivation({ ...ACTIVATION, hasTimeline: true }, run)).resolves.toBe(
      'idle'
    );
    expect(run.preview).not.toHaveBeenCalled();
    expect(run.resume).not.toHaveBeenCalled();
  });
});
