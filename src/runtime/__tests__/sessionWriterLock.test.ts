import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { prepareSessionConfig } from '../plugins/session/legacy.ts';

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
