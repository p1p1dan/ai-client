/**
 * Route B S-6 feedback 11c (user ruling 2026-10-17): start the DSH host with the app
 * instead of on the first send. The host is one process shared by every DSH chat and
 * took about 1.6 s of the first send of each app run (measured, dev box, fake gateway);
 * opening a session on a running host takes about 0.3 s.
 *
 * Fired from `chat:ensureHost`, which the chat surface calls as it mounts and every send
 * calls again (Agent SDK sends included). So it fires ONCE per app run: after that the
 * host follows its own rules (decision 025: stopped after 10 minutes with no session,
 * started again by the next DSH session), and an SDK send never restarts a DSH host
 * that idled out. Only once the spawn gate allows an agent session (signed in, or the
 * user's own setup): before that nothing starts and a later call tries again. Never
 * throws and never waits: a failed start is logged, and the first send starts the host
 * the way it always has. The Agent SDK engine is not warmed (ruling: it keeps starting
 * per chat).
 */

export interface DshHostPrewarmDeps {
  /** Throws while the spawn gate refuses an agent session (`assertAgentSpawnAllowed`). */
  assertSpawnAllowed: () => void;
  /** Starts the host, or joins a start already under way (`DshHostSupervisor.ensureHost`). */
  ensureHost: () => Promise<unknown>;
  log: (message: string, error?: unknown) => void;
}

/** True when a start was asked for; false when the gate kept it off. */
export function prewarmDshHost(deps: DshHostPrewarmDeps): boolean {
  try {
    deps.assertSpawnAllowed();
  } catch {
    return false;
  }
  void deps.ensureHost().catch((error) => deps.log('DSH host prewarm failed', error));
  return true;
}

/** `prewarmDshHost`, at most one start per app run; calls before the gate opens retry. */
export function createDshHostPrewarm(deps: DshHostPrewarmDeps): () => void {
  let started = false;
  return () => {
    if (!started) started = prewarmDshHost(deps);
  };
}
