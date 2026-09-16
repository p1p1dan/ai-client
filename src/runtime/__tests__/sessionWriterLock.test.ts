import { fork } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostIoService } from '../contracts.ts';
import { prepareSessionConfig } from '../plugins/session/legacy.ts';
import {
  acquireWriterLock,
  releaseWriterLock,
  type WriterLock,
} from '../plugins/session/writerLock.ts';
import { neverAsked } from './fixtures/approval.ts';

let dir: string;
const live = new Set<RuntimeHandle>();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'writer-lock-'));
});
afterEach(async () => {
  for (const handle of live) await handle.dispose().catch(() => {});
  live.clear();
  await rm(dir, { recursive: true, force: true });
});

const file = () => join(dir, 'session.jsonl');
const lockPath = () => `${file()}.writer.lock`;

async function runtime(
  mode: 'create' | 'resume' = 'create',
  options: Partial<RuntimeBootstrapOptions> = {}
) {
  const faux = fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', contextWindow: 32_000, maxTokens: 4096 }],
  });
  const handle = await createRuntime({
    providers: [faux.provider],
    env: {},
    traceDir: null,
    tools: { cwd: dir },
    session: { file: file(), cwd: dir, mode },
    ...options,
    permissions: { approve: neverAsked, ...options.permissions },
  });
  live.add(handle);
  return handle;
}
async function close(handle: RuntimeHandle) {
  live.delete(handle);
  await handle.dispose();
}

/**
 * A pid nothing is running under.
 *
 * Probed rather than hard-coded: any fixed number can be a live process on the
 * machine running the suite, which would silently invert what these tests
 * assert (a "stale" lock that is actually held).
 */
function vacantPid(): number {
  for (let pid = 60_000; pid > 1; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no vacant pid to test with');
}

/** Leave a lock behind the way a crash does: the file stays, its writer does not. */
async function strandLock(owner: Record<string, unknown> | string): Promise<void> {
  await writeFile(lockPath(), typeof owner === 'string' ? owner : JSON.stringify(owner));
}

/** A runtime with no session of its own, borrowed for its host IO. */
async function hostIo(): Promise<RuntimeHostIoService> {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const handle = await createRuntime({ env: {}, providers: [faux.provider] });
  live.add(handle);
  return handle.hostIo;
}

/**
 * Host IO that runs `hook` once, right after the first read completes.
 *
 * That instant is the takeover race: the caller has the owner record in hand
 * and has not yet acted on it, which is exactly where a second process gets to
 * finish the same takeover.
 */
function afterFirstRead(io: RuntimeHostIoService, hook: () => Promise<void>): RuntimeHostIoService {
  let pending: (() => Promise<void>) | undefined = hook;
  return new Proxy(io, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      const method = value.bind(target) as (...args: unknown[]) => unknown;
      if (key !== 'readFile') return method;
      return async (...args: unknown[]) => {
        const result = await method(...args);
        const once = pending;
        pending = undefined;
        await once?.();
        return result;
      };
    },
  });
}

async function seededSession(): Promise<void> {
  const handle = await runtime();
  await handle.session?.appendMessage({ role: 'user', content: 'kept', timestamp: Date.now() });
  await close(handle);
}

describe('session writer lock — takeover of a dead owner', () => {
  it('reopens a session whose writer died and keeps its history', async () => {
    await seededSession();
    const dead = vacantPid();
    await strandLock({ pid: dead, host: hostname(), token: 'stale', acquiredAt: Date.now() });

    const handle = await runtime('resume');
    const entries = handle.session?.snapshot().entries ?? [];
    expect(entries.filter((entry) => entry.type === 'message')).toHaveLength(1);

    const held = JSON.parse(await readFile(lockPath(), 'utf8'));
    expect(held).toMatchObject({ pid: process.pid, host: hostname() });
    expect(held.token).not.toBe('stale');
  });

  it('leaves no stale sidecar behind and releases the lock on dispose', async () => {
    await seededSession();
    await strandLock({ pid: vacantPid(), host: hostname(), token: 'stale' });

    const handle = await runtime('resume');
    expect((await readdir(dir)).filter((name) => name.endsWith('.stale'))).toEqual([]);
    await close(handle);
    expect(await readdir(dir)).toEqual(['session.jsonl']);
  });

  it('takes over a lock left torn by the crash that stranded it', async () => {
    await seededSession();
    await strandLock('{"pid":12');

    const handle = await runtime('resume');
    expect(handle.session?.snapshot().entries).toHaveLength(1);
  });

  it('takes over a pre-host lock format by checking its pid locally', async () => {
    await seededSession();
    await strandLock({ pid: vacantPid(), token: 'legacy-format' });

    const handle = await runtime('resume');
    expect(handle.session?.snapshot().entries).toHaveLength(1);
  });

  it('clears a stale lock on the legacy migration path too', async () => {
    const source = join(dir, 'old.jsonl');
    await writeFile(
      source,
      `${JSON.stringify({ type: 'session', version: 3, id: 'old', timestamp: '2026-09-09T00:00:00Z', cwd: dir })}\n`
    );
    const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    const handle = await createRuntime({ env: {}, providers: [faux.provider] });
    live.add(handle);
    await writeFile(
      `${source}.native-v4.jsonl.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );

    const config = await prepareSessionConfig(handle.hostIo, {
      file: source,
      cwd: dir,
      mode: 'resume',
    });
    expect(config.mode).toBe('resume');
    expect(config.file).toBe(`${source}.native-v4.jsonl`);
    expect((await readdir(dir)).filter((name) => name.endsWith('.writer.lock'))).toEqual([]);
  });
});

describe('session writer lock — a live writer still wins', () => {
  it('refuses a session held by a process that is running', async () => {
    await seededSession();
    await strandLock({ pid: process.pid, host: hostname(), token: 'live' });

    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).toBe('live');
  });

  it('never steals a lock recorded on another machine', async () => {
    await seededSession();
    await strandLock({ pid: vacantPid(), host: `${hostname()}-elsewhere`, token: 'remote' });

    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).toBe('remote');
  });
});

describe('session writer lock — release is by ownership', () => {
  it('leaves a lock that is no longer ours where it is', async () => {
    const io = await hostIo();
    const target = join(dir, 'owned.jsonl');
    const lock = await acquireWriterLock(io, target);
    // What a takeover race, or a hand cleanup and a new writer, leaves behind.
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else' })
    );

    expect(await releaseWriterLock(io, lock)).toBe(false);
    expect(JSON.parse(await readFile(`${target}.writer.lock`, 'utf8')).token).toBe('someone-else');
  });

  it('releases the lock it does own', async () => {
    const io = await hostIo();
    const target = join(dir, 'owned.jsonl');
    const lock = await acquireWriterLock(io, target);

    expect(await releaseWriterLock(io, lock)).toBe(true);
    expect((await readdir(dir)).filter((name) => name.endsWith('.writer.lock'))).toEqual([]);
    // Releasing twice is not an error; the second call simply owns nothing.
    expect(await releaseWriterLock(io, lock)).toBe(false);
  });
});

describe('session writer lock — two takeovers of one stale lock', () => {
  it('refuses the slow claimant instead of displacing the winner', async () => {
    const io = await hostIo();
    const target = join(dir, 'raced.jsonl');
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );
    // The fast process completes the whole takeover inside the slow one's
    // window between reading the stale owner and acting on it.
    let winner: WriterLock | undefined;
    const slow = afterFirstRead(io, async () => {
      winner = await acquireWriterLock(io, target);
    });

    await expect(acquireWriterLock(slow, target)).rejects.toMatchObject({
      code: 'session_locked',
    });
    expect(winner).toBeDefined();
    expect(JSON.parse(await readFile(`${target}.writer.lock`, 'utf8')).token).toBe(winner?.token);
    expect((await readdir(dir)).filter((name) => name.endsWith('.stale'))).toEqual([]);
  });

  it('lets exactly one of two concurrent claimants take the lock', async () => {
    const io = await hostIo();
    const target = join(dir, 'raced.jsonl');
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );

    const outcomes = await Promise.allSettled([
      acquireWriterLock(io, target),
      acquireWriterLock(io, target),
    ]);
    const held = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    );
    expect(held).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: 'session_locked' });
    expect(JSON.parse(await readFile(`${target}.writer.lock`, 'utf8')).token).toBe(held[0]?.token);
    expect((await readdir(dir)).filter((name) => name.endsWith('.stale'))).toEqual([]);
  });
});

/** Epoch ms this machine last booted; pid numbers only mean anything after it. */
function bootedAt(): number {
  return Date.now() - Math.round(uptime() * 1000);
}

/** Epoch ms THIS process started, the way the lock records it. */
function processStartedAt(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * Host IO that stages the three-party takeover race of concurrency-01.
 *
 * `afterFirstRead` runs once, at the instant the claimant has the owner record
 * in hand and has not yet acted on it — where a second process gets to finish
 * the same takeover. `afterEachWrite` runs after every call that changes a name
 * on disk, which is where a THIRD claimant gets to try: whatever the takeover
 * does to the lock name, that name must never be free at any of those points.
 */
function stagedTakeover(
  io: RuntimeHostIoService,
  hooks: { afterFirstRead: () => Promise<void>; afterEachWrite: () => Promise<void> }
): RuntimeHostIoService {
  let firstRead: (() => Promise<void>) | undefined = hooks.afterFirstRead;
  return new Proxy(io, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      const method = value.bind(target) as (...args: unknown[]) => unknown;
      if (key !== 'readFile' && key !== 'writeFile' && key !== 'rename') return method;
      return async (...args: unknown[]) => {
        // Only a call that SUCCEEDED changed anything; a rejected create is
        // the claimant discovering the lock, not opening a window in it.
        const result = await method(...args);
        if (key === 'readFile') {
          const once = firstRead;
          firstRead = undefined;
          await once?.();
        } else {
          await hooks.afterEachWrite();
        }
        return result;
      };
    },
  });
}

describe('session writer lock — a third claimant during a takeover', () => {
  it('never leaves the lock name free while a takeover is in flight', async () => {
    const io = await hostIo();
    const target = join(dir, 'raced.jsonl');
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );

    const held: WriterLock[] = [];
    const staged = stagedTakeover(io, {
      // The winner completes the entire takeover while the slow claimant is
      // still holding the owner record it read.
      afterFirstRead: async () => {
        held.push(await acquireWriterLock(io, target));
      },
      // concurrency-01 — a third claimant, at every point the takeover touches
      // a name. It must be refused at all of them: the winner is alive and its
      // lock is on disk under the one name that matters.
      afterEachWrite: async () => {
        await acquireWriterLock(io, target).then(
          (lock) => held.push(lock),
          () => undefined
        );
      },
    });

    await expect(acquireWriterLock(staged, target)).rejects.toMatchObject({
      code: 'session_locked',
    });
    expect(held).toHaveLength(1);
    expect(JSON.parse(await readFile(`${target}.writer.lock`, 'utf8')).token).toBe(held[0]?.token);
    // No sidecar debris: neither the aside copy of someone's lock nor a
    // half-finished claim is left for the next open to read.
    expect((await readdir(dir)).filter((name) => !name.endsWith('.writer.lock'))).toEqual([]);
  });

  it('holds every other claimant off across the whole replacement', async () => {
    const io = await hostIo();
    const target = join(dir, 'replaced.jsonl');
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );

    // Nobody else finishes the takeover this time, so it runs to the end — and
    // an intruder tries at every step of it. concurrency-01: replacing the lock
    // by freeing the name and creating a new one hands the session to whichever
    // of these lands in between.
    const intruders: WriterLock[] = [];
    const staged = stagedTakeover(io, {
      afterFirstRead: async () => undefined,
      afterEachWrite: async () => {
        await acquireWriterLock(io, target).then(
          (lock) => intruders.push(lock),
          () => undefined
        );
      },
    });

    const lock = await acquireWriterLock(staged, target);
    expect(intruders).toEqual([]);
    expect(JSON.parse(await readFile(`${target}.writer.lock`, 'utf8')).token).toBe(lock.token);
    expect((await readdir(dir)).filter((name) => !name.endsWith('.writer.lock'))).toEqual([]);
  });

  it('takes over after a crash that stranded a takeover sentinel', async () => {
    await seededSession();
    await strandLock({ pid: vacantPid(), host: hostname(), token: 'stale' });
    await writeFile(
      `${lockPath()}.takeover`,
      JSON.stringify({
        pid: vacantPid(),
        host: hostname(),
        token: 'stranded',
        acquiredAt: Date.now() - 600_000,
      })
    );

    const handle = await runtime('resume');
    expect(handle.session?.snapshot().entries).toHaveLength(1);
    expect((await readdir(dir)).filter((name) => name.includes('takeover'))).toEqual([]);
  });

  it('refuses instead of racing a takeover another process is already running', async () => {
    await seededSession();
    await strandLock({ pid: vacantPid(), host: hostname(), token: 'stale' });
    await writeFile(
      `${lockPath()}.takeover`,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: 'in-flight',
        acquiredAt: Date.now(),
      })
    );

    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });
    // The other takeover's sentinel is left exactly as found.
    expect(JSON.parse(await readFile(`${lockPath()}.takeover`, 'utf8')).token).toBe('in-flight');
  });
});

describe('session writer lock — staleness is more than "the pid exists"', () => {
  it('takes over a lock that predates this boot even though its pid is alive', async () => {
    await seededSession();
    // windows-06 / concurrency-02 — pid numbers are handed out again after a
    // reboot, so this record cannot belong to the process running under it.
    await strandLock({
      pid: process.pid,
      host: hostname(),
      token: 'recycled',
      acquiredAt: bootedAt() - 3_600_000,
    });

    const handle = await runtime('resume');
    expect(handle.session?.snapshot().entries).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).not.toBe('recycled');
  });

  it('takes over a lock whose pid is ours but whose process is not', async () => {
    await seededSession();
    await strandLock({
      pid: process.pid,
      host: hostname(),
      token: 'recycled',
      acquiredAt: Date.now(),
      // Epoch-1: a start time no live process on this machine can have, and
      // certainly not ours.
      startedAt: 1,
    });

    const handle = await runtime('resume');
    expect(handle.session?.snapshot().entries).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).not.toBe('recycled');
  });

  it('still refuses a lock this very process wrote a moment ago', async () => {
    await seededSession();
    await strandLock({
      pid: process.pid,
      host: hostname(),
      token: 'live',
      acquiredAt: Date.now(),
      startedAt: processStartedAt(),
    });

    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).toBe('live');
  });
});

describe('session writer lock — the forced takeover', () => {
  it('hands the session over when the caller forces it', async () => {
    await seededSession();
    await strandLock({
      pid: process.pid,
      host: hostname(),
      token: 'live',
      acquiredAt: Date.now(),
      startedAt: processStartedAt(),
    });
    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });

    const handle = await runtime('resume', {
      session: { file: file(), cwd: dir, mode: 'resume', forceTakeover: true },
    });
    expect(handle.session?.snapshot().entries).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).not.toBe('live');
  });

  it('names the holder and the remedy when it refuses', async () => {
    await seededSession();
    await strandLock({
      pid: process.pid,
      host: hostname(),
      token: 'live',
      acquiredAt: Date.now() - 7_200_000,
      startedAt: processStartedAt(),
    });

    const error = await runtime('resume').then(
      () => undefined,
      (reason: unknown) => reason as Error
    );
    expect(error?.message).toContain(`pid ${process.pid}`);
    expect(error?.message).toContain(hostname());
    // The age is what tells a user whether the holder can still be real, and
    // the remedy is what the UI offers next to it.
    expect(error?.message).toMatch(/held for 2h/);
    expect(error?.message).toMatch(/force/i);
  });
});

describe('session writer lock — separate processes race for one stale lock', () => {
  it('lets exactly one of three processes take over, and the sidecar says which', async () => {
    const target = join(dir, 'processes.jsonl');
    await writeFile(
      `${target}.writer.lock`,
      JSON.stringify({ pid: vacantPid(), host: hostname(), token: 'stale' })
    );

    const outcomes = await raceForLock(target, 3);
    const winners = outcomes.filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);
    for (const loser of outcomes.filter((outcome) => !outcome.ok))
      expect(loser.code).toBe('session_locked');
    const sidecar = JSON.parse(await readFile(`${target}.writer.lock`, 'utf8'));
    expect(sidecar.token).toBe(winners[0]?.token);
    expect(sidecar.pid).toBe(winners[0]?.pid);
    // The losers cleaned up after themselves: no sentinel, no aside copy, no
    // half-written claim left in the session directory.
    expect((await readdir(dir)).filter((name) => !name.endsWith('.writer.lock'))).toEqual([]);
  }, 60_000);
});

interface RaceOutcome {
  ok: boolean;
  pid: number;
  token?: string;
  code?: string;
}

/**
 * Run `count` real claimants against `target`, started together.
 *
 * Each child boots its own runtime and reports `ready`; only once every one of
 * them is waiting does the parent release them, so the attempts overlap instead
 * of queueing behind each other's startup.
 */
async function raceForLock(target: string, count: number): Promise<RaceOutcome[]> {
  const script = fileURLToPath(new URL('./fixtures/writerLockRace.ts', import.meta.url));
  const children = Array.from({ length: count }, () =>
    // Started the way this repo starts any `.ts` child, in tests and in the dev
    // worker path alike: type stripping, no build step.
    fork(script, [target], { execArgv: ['--experimental-strip-types'], stdio: 'inherit' })
  );
  const outcomes: RaceOutcome[] = [];
  try {
    const results = children.map(
      (child) =>
        new Promise<RaceOutcome>((resolve, reject) => {
          let ready = false;
          child.on('message', (message: unknown) => {
            if (message === 'ready') {
              ready = true;
              return;
            }
            resolve(message as RaceOutcome);
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            reject(new Error(`claimant exited (ready=${ready}, code=${code})`))
          );
        })
    );
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on('message', (message: unknown) => {
              if (message === 'ready') resolve();
            });
          })
      )
    );
    for (const child of children) child.send('go');
    outcomes.push(...(await Promise.all(results)));
  } finally {
    for (const child of children) {
      child.removeAllListeners('exit');
      child.send('stop');
    }
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
          })
      )
    );
  }
  return outcomes;
}
