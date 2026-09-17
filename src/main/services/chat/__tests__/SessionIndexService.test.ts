import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PI_AGENT } from '@shared/types/agentWire';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

describe('SessionIndexService', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-session-index-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('recordCreated makes the entry available via list with expected fields', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', model: 'claude-x' });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: 's1',
      workspacePath: '/ws/a',
      model: 'claude-x',
      title: '',
      archived: false,
    });
    expect(typeof list[0].updatedAt).toBe('number');
  });

  it('awaits and persists WorkerManager runtime-identity binding', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

    await service.bindRuntimeIdentity('s1', '/sessions/s1.jsonl');

    expect((await service.get('s1'))?.runtimeIdentity).toBe('/sessions/s1.jsonl');
    const persisted = JSON.parse(
      readFileSync(join(userDataDir, 'session-index.json'), 'utf8')
    ) as SessionIndexEntry[];
    expect(persisted[0]?.runtimeIdentity).toBe('/sessions/s1.jsonl');
  });

  it('rolls back a failed binding before a queued mutation can persist it', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    let writes = 0;
    let releaseFailedWrite: (() => void) | undefined;
    const failedWriteGate = new Promise<void>((resolve) => {
      releaseFailedWrite = resolve;
    });
    const writeAtomically = vi.fn(async (targetPath: string, data: unknown) => {
      writes += 1;
      if (writes === 2) {
        await failedWriteGate;
        throw new Error('simulated identity write failure');
      }
      writeFileSync(targetPath, JSON.stringify(data, null, 2));
    });
    const service = new SessionIndexService({ writeAtomically });
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

    const binding = service.bindRuntimeIdentity('s1', '/sessions/rejected.jsonl');
    const rename = service.rename('s1', 'Concurrent rename');
    await vi.waitFor(() => expect(writeAtomically).toHaveBeenCalledTimes(2));
    releaseFailedWrite?.();

    await expect(binding).rejects.toThrow(/simulated identity write failure/);
    await expect(rename).resolves.toBe(true);
    expect(await service.get('s1')).toMatchObject({
      title: 'Concurrent rename',
      runtimeIdentity: undefined,
    });
    const persisted = JSON.parse(
      readFileSync(join(userDataDir, 'session-index.json'), 'utf8')
    ) as SessionIndexEntry[];
    expect(persisted[0]).toMatchObject({ title: 'Concurrent rename' });
    expect(persisted[0]?.runtimeIdentity).toBeUndefined();
  });

  it('persists Pi leaf checkpoints and one complete fork row', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 'source', workspacePath: '/ws/a', agent: 'pi' });
    await service.bindRuntimeIdentity('source', '/sessions/source.jsonl');

    await service.commitPiLeaf({
      sessionId: 'source',
      runtimeIdentity: '/sessions/source.jsonl',
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    });
    expect(await service.get('source')).toMatchObject({
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    });

    const forked = await service.createForked({
      sessionId: 'forked',
      runtimeIdentity: '/sessions/forked.jsonl',
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'a' },
      agent: 'pi',
      workspacePath: '/ws/a',
      title: 'Source (fork)',
      updatedAt: 42,
      archived: false,
    });
    expect(forked).toMatchObject({ sessionId: 'forked', title: 'Source (fork)' });
    expect(await service.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'source' }),
        expect.objectContaining({
          sessionId: 'forked',
          runtimeIdentity: '/sessions/forked.jsonl',
        }),
      ])
    );
    await expect(service.createForked(forked)).rejects.toThrow(/already exists/);
  });

  it('refuses to bind a runtime identity without an indexed logical session', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await expect(service.bindRuntimeIdentity('missing', '/sessions/missing.jsonl')).rejects.toThrow(
      /row not found/
    );
  });

  it('clears an unwritten runtime identity and persists the row without it', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: PI_AGENT });
    await service.bindRuntimeIdentity('s1', '/sessions/never-written.jsonl');

    await expect(
      service.clearUnwrittenRuntimeIdentity('s1', '/sessions/never-written.jsonl')
    ).resolves.toBe(true);

    // Dropped, not blanked: the row reads exactly like one that has never run.
    const [row] = await service.list();
    expect(row).not.toHaveProperty('runtimeIdentity');
    expect(row).toMatchObject({ sessionId: 's1', workspacePath: '/ws/a', agent: PI_AGENT });
    const persisted = JSON.parse(
      readFileSync(join(userDataDir, 'session-index.json'), 'utf8')
    ) as SessionIndexEntry[];
    expect(persisted[0]).not.toHaveProperty('runtimeIdentity');
  });

  it('refuses to clear an identity the row no longer holds', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: PI_AGENT });
    await service.bindRuntimeIdentity('s1', '/sessions/live.jsonl');

    // A repair racing a fresh binding must not unbind the winner.
    await expect(
      service.clearUnwrittenRuntimeIdentity('s1', '/sessions/stale.jsonl')
    ).resolves.toBe(false);
    await expect(service.clearUnwrittenRuntimeIdentity('missing', '/x.jsonl')).resolves.toBe(false);
    expect((await service.list())[0]).toMatchObject({
      runtimeIdentity: '/sessions/live.jsonl',
    });
  });

  it('persists across instances: recordCreated + rename in instance A survive in a fresh instance B', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const serviceA = new SessionIndexService();
    await serviceA.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    await serviceA.rename('s1', 'Renamed title');

    const serviceB = new SessionIndexService();
    const list = await serviceB.list();

    expect(list).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        workspacePath: '/ws/a',
        title: 'Renamed title',
        archived: false,
      }),
    ]);
  });

  it('does not persist session.resumed outside the awaited resume transaction', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

    service.handleRuntimeEvent({
      type: 'session.resumed',
      seq: 1,
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { runtimeIdentity: '/sessions/uncommitted.jsonl' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.list())[0]?.runtimeIdentity).toBeUndefined();
  });

  it('enriches an entry with runtimeIdentity and bumps updatedAt on session.updated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    const createdAt = (await service.list())[0].updatedAt;

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const event: RuntimeEvent = {
      type: 'session.updated',
      seq: 1,
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { runtimeIdentity: 'claude-runtime-updated' },
    };
    service.handleRuntimeEvent(event);

    // Poll the persisted file so this test only completes once the fire-and-forget
    // event handler's flush has fully settled (same pattern as the resumed-event test).
    await vi.waitFor(
      () => {
        const raw = readFileSync(join(userDataDir, 'session-index.json'), 'utf8');
        const parsed = JSON.parse(raw) as SessionIndexEntry[];
        expect(parsed[0]?.runtimeIdentity).toBe('claude-runtime-updated');
      },
      { timeout: 1000 }
    );

    const [entry] = await service.list();
    expect(entry.runtimeIdentity).toBe('claude-runtime-updated');
    expect(entry.updatedAt).toBeGreaterThan(createdAt);
  });

  it('drops session.updated for an unknown session instead of creating one', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    service.handleRuntimeEvent({
      type: 'session.updated',
      seq: 1,
      sessionId: 'unknown',
      timestamp: Date.now(),
      payload: { runtimeIdentity: 'ghost' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const list = await service.list();
    expect(list).toEqual([]);
  });

  it('ignores runtime events for unknown sessions and non session-lifecycle event types', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    // Unknown session: recordCreated never ran for it, so it must be dropped rather than created.
    service.handleRuntimeEvent({
      type: 'session.resumed',
      seq: 1,
      sessionId: 'unknown',
      timestamp: Date.now(),
      payload: { runtimeIdentity: 'ghost' },
    });

    // Irrelevant event type: must be ignored outright without touching the index.
    service.handleRuntimeEvent({
      type: 'usage.updated',
      seq: 2,
      timestamp: Date.now(),
      payload: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const list = await service.list();
    expect(list).toEqual([]);
  });

  it('rename and setArchived touch updatedAt and return false for unknown sessionId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    const createdAt = (await service.list())[0].updatedAt;

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    await expect(service.rename('s1', 'New title')).resolves.toBe(true);
    await expect(service.rename('missing', 'Nope')).resolves.toBe(false);

    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    await expect(service.setArchived('s1', true)).resolves.toBe(true);
    await expect(service.setArchived('missing', true)).resolves.toBe(false);

    const [entry] = await service.list();
    expect(entry.title).toBe('New title');
    expect(entry.archived).toBe(true);
    expect(entry.updatedAt).toBeGreaterThan(createdAt);
    expect(entry.updatedAt).toBe(new Date('2026-01-03T00:00:00.000Z').getTime());
  });

  /**
   * R5 D2: `chat:registerSession` calls `recordCreated` eagerly at chat
   * creation and the lazy first-send `chat:createSession` calls it again.
   * Both orders must converge on ONE entry that never loses a title, an
   * archived bit or a runtime identity earned in between.
   */
  it('recordCreated is idempotent: one entry, and title/archived/runtimeIdentity survive a re-record', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    await service.rename('s1', 'User title');
    await service.setArchived('s1', true);
    service.handleRuntimeEvent({
      type: 'session.created',
      seq: 1,
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { runtimeIdentity: 'rt-1' },
    });
    await vi.waitFor(async () => {
      expect((await service.list())[0]?.runtimeIdentity).toBe('rt-1');
    });

    // Second registration for the same session (the lazy send path).
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', model: 'claude-x' });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: 's1',
      workspacePath: '/ws/a',
      title: 'User title',
      archived: true,
      runtimeIdentity: 'rt-1',
      model: 'claude-x',
    });
  });

  it('setArchived on a never-recorded session returns false and creates nothing', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    await expect(service.setArchived('never-indexed', true)).resolves.toBe(false);
    await expect(service.list()).resolves.toEqual([]);

    // The renderer's ladder: register, then the retry sticks.
    await service.recordCreated({ sessionId: 'never-indexed', workspacePath: '/ws/a' });
    await expect(service.setArchived('never-indexed', true)).resolves.toBe(true);
    expect((await service.list())[0]?.archived).toBe(true);
  });

  it('lists sessions ordered by updatedAt descending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 'older', workspacePath: '/ws/older' });

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    await service.recordCreated({ sessionId: 'newer', workspacePath: '/ws/newer' });

    const list = await service.list();
    expect(list.map((entry) => entry.sessionId)).toEqual(['newer', 'older']);
  });

  it('starts with an empty index and does not crash when the persisted file is corrupted', async () => {
    writeFileSync(join(userDataDir, 'session-index.json'), 'not json{{', 'utf8');

    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();

    await expect(service.list()).resolves.toEqual([]);
  });

  it('leaves no leftover .tmp files after a flush', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    await service.rename('s1', 'Renamed');

    const filesAfter = readdirSync(userDataDir);
    expect(filesAfter.some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(existsSync(join(userDataDir, 'session-index.json'))).toBe(true);
  });

  /**
   * S2 slice 1 — the agent binding's return path onto disk.
   *
   * Getting it wrong is silent in both directions: a dropped `session.created`
   * payload leaves the row unbound forever (and resume after a restart has
   * nothing to dispatch on), while a field-by-field rebuild that forgets the
   * key erases the binding on the next send. Neither raises an error, so both
   * are asserted against the persisted FILE rather than the in-memory map.
   */
  describe('agent binding (S2 slice 1)', () => {
    function readIndexFile(): SessionIndexEntry[] {
      const raw = readFileSync(join(userDataDir, 'session-index.json'), 'utf8');
      return JSON.parse(raw) as SessionIndexEntry[];
    }

    it('records the agent on create and never drops it on a later re-record', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: 'codex' });
      expect((await service.list())[0]?.agent).toBe('codex');

      // The lazy first-send path calls recordCreated again. Both record*
      // methods rebuild the entry key by key, so a call that does not know the
      // binding must fall back to the stored one instead of writing undefined.
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', model: 'claude-x' });

      const list = await service.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ agent: 'codex', model: 'claude-x' });
    });

    it('commits a validated Pi resume without retargeting the durable identity', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: 'pi' });
      await service.bindRuntimeIdentity('s1', '/sessions/pi-1.jsonl');
      await service.commitResumed({
        sessionId: 's1',
        workspacePath: '/ws/a',
        runtimeIdentity: '/sessions/pi-1.jsonl',
      });

      expect((await service.list())[0]).toMatchObject({
        agent: 'pi',
        runtimeIdentity: '/sessions/pi-1.jsonl',
      });
      await expect(
        service.commitResumed({
          sessionId: 's1',
          workspacePath: '/ws/a',
          runtimeIdentity: '/sessions/other.jsonl',
        })
      ).rejects.toThrow(/identity mismatch/);
    });

    /**
     * The regression this slice hangs on. A brand-new Pi session's
     * `session.created` may carry no runtimeIdentity yet, so the old
     * `if (!runtimeIdentity) return` threw the event away wholesale. With
     * `agent` riding on it, that guard would discard the runtime binding.
     */
    it('writes and flushes a session.created that has an agent but no runtimeIdentity', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

      service.handleRuntimeEvent({
        type: 'session.created',
        seq: 1,
        sessionId: 's1',
        timestamp: Date.now(),
        payload: { agent: PI_AGENT },
      });

      await vi.waitFor(() => {
        const persisted = readIndexFile();
        expect(persisted[0]?.agent).toBe(PI_AGENT);
      });
      expect(readIndexFile()[0]?.runtimeIdentity).toBeUndefined();
    });

    /**
     * Drain the fire-and-forget handler's microtask chain.
     *
     * `applyRuntimeEvent` only awaits ALREADY-RESOLVED promises (`ensureLoaded`
     * short-circuits once loaded) before it would mutate the map, so a handful
     * of microtask turns is a sufficient — and timer-free — wait. A `setTimeout`
     * sleep would deadlock under the fake clock this test needs.
     */
    async function drainHandler(): Promise<void> {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
    }

    /**
     * The guard's own case. Asserted on a FAKE clock, a day per step: on the
     * real clock both `Date.now()` reads can land in the same millisecond, so
     * `updatedAt` was capable of proving nothing at all — and the companion
     * `agent` assertion is true whether or not the guard exists. Deleting
     * `if (!runtimeIdentity && !agent) return` has to turn this red, or the
     * relaxed guard is untested in the one direction that matters.
     */
    it('still ignores a session.created carrying neither field', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      vi.useFakeTimers();
      const CREATED_AT = new Date('2026-03-01T00:00:00.000Z').getTime();
      const EMPTY_AT = new Date('2026-03-02T00:00:00.000Z').getTime();
      const BOUND_AT = new Date('2026-03-03T00:00:00.000Z').getTime();

      vi.setSystemTime(CREATED_AT);
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
      expect((await service.list())[0].updatedAt).toBe(CREATED_AT);

      vi.setSystemTime(EMPTY_AT);
      service.handleRuntimeEvent({
        type: 'session.created',
        seq: 1,
        sessionId: 's1',
        timestamp: EMPTY_AT,
        payload: {},
      });
      await drainHandler();

      const [afterEmpty] = await service.list();
      expect(afterEmpty.agent).toBeUndefined();
      // The discriminating assertion: a day-old stamp cannot be an accidental
      // rewrite that happened to reproduce the same value.
      expect(afterEmpty.updatedAt).toBe(CREATED_AT);
      // …and nothing reached disk either.
      expect(readIndexFile()[0]?.updatedAt).toBe(CREATED_AT);

      // Positive control, same clock and same drain: an event that DOES carry
      // a field moves both. Without it, the assertions above could be passing
      // because the harness never observes any write at all.
      vi.setSystemTime(BOUND_AT);
      service.handleRuntimeEvent({
        type: 'session.created',
        seq: 2,
        sessionId: 's1',
        timestamp: BOUND_AT,
        payload: { agent: PI_AGENT },
      });
      await drainHandler();

      const [afterBound] = await service.list();
      expect(afterBound.agent).toBe(PI_AGENT);
      expect(afterBound.updatedAt).toBe(BOUND_AT);
      // Polled, not drained: this one really does write, and the write is fs
      // I/O rather than a microtask. Waiting for it here also keeps the flush
      // from landing after the temp dir is torn down.
      await vi.waitFor(() => {
        expect(readIndexFile()[0]?.updatedAt).toBe(BOUND_AT);
      });
    });

    it('an uncommitted resumed event cannot retarget an already-known Pi row', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: 'pi' });
      await service.bindRuntimeIdentity('s1', '/sessions/pi-1.jsonl');

      service.handleRuntimeEvent({
        type: 'session.resumed',
        seq: 1,
        sessionId: 's1',
        timestamp: Date.now(),
        payload: { runtimeIdentity: '/sessions/other.jsonl' },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readIndexFile()[0]).toMatchObject({
        runtimeIdentity: '/sessions/pi-1.jsonl',
        agent: 'pi',
      });
    });

    it('the file stays a bare top-level array once entries carry an agent', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: 'codex' });

      // An envelope here would make an OLDER build's `for-of` throw, warn,
      // start empty and write `[]` back — every session index silently gone.
      const parsed = JSON.parse(readFileSync(join(userDataDir, 'session-index.json'), 'utf8'));
      expect(Array.isArray(parsed)).toBe(true);

      // A legacy row (no agent) written by an older build must still load, and
      // loading it must not add the field on the way in.
      const legacy: SessionIndexEntry[] = [
        { sessionId: 'old', workspacePath: '/ws/b', title: '', updatedAt: 1, archived: false },
      ];
      writeFileSync(join(userDataDir, 'session-index.json'), JSON.stringify(legacy), 'utf8');
      const fresh = new SessionIndexService();
      const [loaded] = await fresh.list();
      expect(loaded).not.toHaveProperty('agent');
    });
  });

  /**
   * U13 (D04): the `unbound` marker is what keeps a temporary chat findable
   * after a restart, so the two ways of losing it — a re-record that does not
   * mention it, and a load that rewrites old rows — both get a test.
   */
  describe('unbound marker (U13)', () => {
    function readIndexFile(): SessionIndexEntry[] {
      const raw = readFileSync(join(userDataDir, 'session-index.json'), 'utf8');
      return JSON.parse(raw) as SessionIndexEntry[];
    }

    it('keeps the marker across a re-record that does not mention it', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await service.recordCreated({
        sessionId: 's1',
        workspacePath: '/tmp/unbound-sessions/abc',
        agent: PI_AGENT,
        unbound: true,
      });
      expect((await service.get('s1'))?.unbound).toBe(true);

      // recordCreated rebuilds every field: an older caller that knows nothing
      // about `unbound` must not silently un-mark the row (`agent` lost this
      // exact way once).
      await service.recordCreated({
        sessionId: 's1',
        workspacePath: '/tmp/unbound-sessions/abc',
        model: 'pi-x',
      });

      expect(await service.get('s1')).toMatchObject({ unbound: true, model: 'pi-x' });
      expect(readIndexFile()[0]?.unbound).toBe(true);
    });

    it('clears the marker when the same chat is re-recorded against a real folder', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await service.recordCreated({
        sessionId: 's1',
        workspacePath: '/tmp/unbound-sessions/abc',
        unbound: true,
      });
      // An explicit `false` is a statement, not a missing value: the caller
      // derived it from the path it is recording.
      await service.recordCreated({ sessionId: 's1', workspacePath: '/repo', unbound: false });

      expect(await service.get('s1')).not.toHaveProperty('unbound');
      expect(readIndexFile()[0]).not.toHaveProperty('unbound');
    });

    it('never writes the field on a bound row, and never backfills a legacy row', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/repo', unbound: false });

      const parsed = readIndexFile();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).not.toHaveProperty('unbound');

      // Rows written before U13 stay exactly as they are: normalizing on load
      // would turn a compatible read into an irreversible write migration.
      const legacy: SessionIndexEntry[] = [
        {
          sessionId: 'old',
          workspacePath: '/tmp/unbound-sessions/old',
          title: '',
          updatedAt: 1,
          archived: false,
        },
      ];
      writeFileSync(join(userDataDir, 'session-index.json'), JSON.stringify(legacy), 'utf8');
      const fresh = new SessionIndexService();
      const [loaded] = await fresh.list();
      expect(loaded).not.toHaveProperty('unbound');
    });
  });

  /**
   * D15 (2026-09-17 field run, DEV-4) — the row a failed spawn leaves behind.
   *
   * The create handler writes the row before the worker exists, so when
   * bootstrap times out the index keeps a `title: ''` shell that shows up as
   * "Session xxxxxx" in the sidebar on the next start. `removeUncommittedCreated`
   * is the take-back, and every guard below is there to make sure the take-back
   * can never reach a row that means something.
   */
  describe('uncommitted create rollback (D15)', () => {
    it('drops the shell row a failed create wrote, on disk as well as in memory', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a', agent: PI_AGENT });
      await service.recordCreated({ sessionId: 'keep', workspacePath: '/ws/b', agent: PI_AGENT });

      await expect(service.removeUncommittedCreated('s1', '/ws/a')).resolves.toBe(true);

      expect(await service.get('s1')).toBeUndefined();
      const persisted = JSON.parse(
        readFileSync(join(userDataDir, 'session-index.json'), 'utf8')
      ) as SessionIndexEntry[];
      expect(persisted.map((row) => row.sessionId)).toEqual(['keep']);
    });

    it('refuses every row that means something: identity, leaf, title, archive, import', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await service.recordCreated({ sessionId: 'bound', workspacePath: '/ws/a' });
      await service.bindRuntimeIdentity('bound', '/sessions/bound.jsonl');
      await expect(service.removeUncommittedCreated('bound', '/ws/a')).resolves.toBe(false);

      await service.recordCreated({ sessionId: 'named', workspacePath: '/ws/a' });
      await service.rename('named', 'Kept by its title');
      await expect(service.removeUncommittedCreated('named', '/ws/a')).resolves.toBe(false);

      await service.recordCreated({ sessionId: 'archived', workspacePath: '/ws/a' });
      await service.setArchived('archived', true);
      await expect(service.removeUncommittedCreated('archived', '/ws/a')).resolves.toBe(false);

      // A fork row (T040) is a complete, independently created session — it is
      // never this handler's to take back.
      await service.createForked({
        sessionId: 'forked',
        workspacePath: '/ws/a',
        runtimeIdentity: '/sessions/forked.jsonl',
        agent: PI_AGENT,
        title: 'Source (fork)',
        updatedAt: 1,
        archived: false,
      });
      await expect(service.removeUncommittedCreated('forked', '/ws/a')).resolves.toBe(false);

      expect((await service.list()).map((row) => row.sessionId).sort()).toEqual([
        'archived',
        'bound',
        'forked',
        'named',
      ]);
    });

    it('refuses an unknown session and a row whose workspace has moved', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

      await expect(service.removeUncommittedCreated('nobody', '/ws/a')).resolves.toBe(false);
      await expect(service.removeUncommittedCreated('s1', '/ws/elsewhere')).resolves.toBe(false);
      expect(await service.get('s1')).toBeDefined();
    });

    it('restores the row in memory when the flush fails (T038 rollback)', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      let writes = 0;
      const service = new SessionIndexService({
        writeAtomically: async () => {
          writes += 1;
          if (writes > 1) throw new Error('disk full');
        },
      });
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

      await expect(service.removeUncommittedCreated('s1', '/ws/a')).rejects.toThrow('disk full');
      expect(await service.get('s1')).toMatchObject({ sessionId: 's1', workspacePath: '/ws/a' });
    });
  });

  /**
   * T038 — the index's read/write safety net.
   *
   * Every one of these is about the same structural fact: `flush()` rewrites
   * the WHOLE table, so anything wrong with the in-memory view becomes the
   * file on the next write. That turns a read failure into data loss
   * (session-index-01), a rejected mutation into a delayed one
   * (session-index-05), and unbounded growth into a per-turn cost
   * (session-index-11).
   */
  describe('read/write safety net (T038)', () => {
    const indexPath = (): string => join(userDataDir, 'session-index.json');
    const backupFiles = (): string[] =>
      readdirSync(userDataDir).filter((name) => name.includes('.corrupt-'));

    it('session-index-01: a corrupt index is backed up before anything overwrites it', async () => {
      // Real bytes, real loader path: a half-written file is what a power cut
      // during the old (fsync-less) atomic write actually leaves behind.
      const corrupt =
        '[{"sessionId":"s1","workspacePath":"/ws/a","title":"Kept","updatedAt":1,"arc';
      writeFileSync(indexPath(), corrupt, 'utf8');

      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      await expect(service.list()).resolves.toEqual([]);
      const health = service.getHealth();
      expect(health.status).toBe('repaired');

      // The evidence survives the rebuild, byte for byte.
      const backups = backupFiles();
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(userDataDir, backups[0]), 'utf8')).toBe(corrupt);

      // Only now may the table be rewritten, and the old bytes are still there.
      await service.recordCreated({ sessionId: 'fresh', workspacePath: '/ws/b' });
      expect(JSON.parse(readFileSync(indexPath(), 'utf8'))).toHaveLength(1);
      expect(readFileSync(join(userDataDir, backups[0]), 'utf8')).toBe(corrupt);
    });

    it('session-index-01: an unreadable index refuses writes instead of replacing it', async () => {
      // A real non-ENOENT read failure (EISDIR) with no mocking: the rows are
      // presumed intact on disk, so this process must not write over them.
      mkdirSync(indexPath());

      const { SessionIndexService } = await import('../SessionIndexService');
      const writeAtomically = vi.fn(async () => {});
      const service = new SessionIndexService({ writeAtomically });

      await expect(service.list()).resolves.toEqual([]);
      expect(service.getHealth().status).toBe('unreadable');
      await expect(
        service.recordCreated({ sessionId: 'fresh', workspacePath: '/ws/b' })
      ).rejects.toThrow(/session index/i);
      expect(writeAtomically).not.toHaveBeenCalled();
      expect(backupFiles()).toEqual([]);
    });

    it('session-index-01: keeps the readable rows and drops only the broken ones', async () => {
      const rows = [
        { sessionId: 'good', workspacePath: '/ws/a', title: 'Good', updatedAt: 5, archived: false },
        null,
        { workspacePath: '/ws/b', title: 'No id', updatedAt: 6, archived: false },
      ];
      writeFileSync(indexPath(), JSON.stringify(rows), 'utf8');

      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();

      // The old loader threw on `null.sessionId` and lost the good row too.
      const listed = await service.list();
      expect(listed.map((entry) => entry.sessionId)).toEqual(['good']);
      const health = service.getHealth();
      expect(health.status).toBe('repaired');
      if (health.status === 'repaired') {
        expect(health.droppedRows).toBe(2);
      }
      expect(backupFiles()).toHaveLength(1);
    });

    it('session-index-05: a failed setArchived rolls back and never rides a later write to disk', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      let writes = 0;
      const writeAtomically = vi.fn(async (targetPath: string, data: unknown) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated archive write failure');
        writeFileSync(targetPath, JSON.stringify(data));
      });
      const service = new SessionIndexService({ writeAtomically });
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

      await expect(service.setArchived('s1', true)).rejects.toThrow(
        /simulated archive write failure/
      );
      expect((await service.get('s1'))?.archived).toBe(false);

      // The unrelated write that used to smuggle the failed archive onto disk.
      await service.rename('s1', 'Later, unrelated');
      expect((await service.get('s1'))?.archived).toBe(false);
      const persisted = JSON.parse(readFileSync(indexPath(), 'utf8')) as SessionIndexEntry[];
      expect(persisted[0]).toMatchObject({ title: 'Later, unrelated', archived: false });
    });

    it('session-index-05: a failed recordCreated leaves no phantom row behind', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      let writes = 0;
      const writeAtomically = vi.fn(async (targetPath: string, data: unknown) => {
        writes += 1;
        if (writes === 1) throw new Error('simulated create write failure');
        writeFileSync(targetPath, JSON.stringify(data));
      });
      const service = new SessionIndexService({ writeAtomically });

      await expect(
        service.recordCreated({ sessionId: 'ghost', workspacePath: '/ws/a' })
      ).rejects.toThrow(/simulated create write failure/);
      expect(await service.get('ghost')).toBeUndefined();

      await service.recordCreated({ sessionId: 'real', workspacePath: '/ws/b' });
      const persisted = JSON.parse(readFileSync(indexPath(), 'utf8')) as SessionIndexEntry[];
      expect(persisted.map((entry) => entry.sessionId)).toEqual(['real']);
    });

    it('session-index-05: every flush call site restores memory when the write fails', () => {
      // The class had two shapes for the same operation and only one of them
      // was correct. Keeping a bare `await this.flush()` out of the file is
      // cheaper than re-deriving the smuggling scenario for the next one.
      const source = readFileSync(join(__dirname, '..', 'SessionIndexService.ts'), 'utf8').split(
        '\n'
      );
      const unguarded = source
        .map((line, index) => ({ line: line.trim(), index }))
        .filter((entry) => entry.line === 'await this.flush();')
        .filter((entry) => source[entry.index - 1]?.trim() !== 'try {')
        .map((entry) => entry.index + 1);
      expect(unguarded).toEqual([]);
    });

    it('session-index-11: turn-end events stop rewriting the whole table every turn', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const { SessionIndexService } = await import('../SessionIndexService');
      const writeAtomically = vi.fn(async (targetPath: string, data: unknown) => {
        writeFileSync(targetPath, JSON.stringify(data));
      });
      const service = new SessionIndexService({ writeAtomically });
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
      expect(writeAtomically).toHaveBeenCalledTimes(1);

      const turnEnd = (): RuntimeEvent =>
        ({ type: 'session.completed', sessionId: 's1', payload: {} }) as unknown as RuntimeEvent;

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      service.handleRuntimeEvent(turnEnd());
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      service.handleRuntimeEvent(turnEnd());
      await service.list();
      expect(writeAtomically).toHaveBeenCalledTimes(1);
      // The bump is still visible in memory, it just is not worth a full
      // re-serialization of the table on the main thread.
      expect((await service.get('s1'))?.updatedAt).toBe(Date.parse('2026-01-01T00:00:02.000Z'));

      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      service.handleRuntimeEvent(turnEnd());
      await service.list();
      expect(writeAtomically).toHaveBeenCalledTimes(2);
      const persisted = JSON.parse(readFileSync(indexPath(), 'utf8')) as SessionIndexEntry[];
      expect(persisted[0]?.updatedAt).toBe(Date.parse('2026-01-01T00:01:00.000Z'));
    });

    it('session-index-11: the table has an upper bound and sheds archived rows first', async () => {
      const rows: SessionIndexEntry[] = [
        {
          sessionId: 'archived-old',
          workspacePath: '/ws/1',
          title: '',
          updatedAt: 1,
          archived: true,
        },
        { sessionId: 'live-old', workspacePath: '/ws/2', title: '', updatedAt: 2, archived: false },
        {
          sessionId: 'archived-new',
          workspacePath: '/ws/3',
          title: '',
          updatedAt: 3,
          archived: true,
        },
        { sessionId: 'live-new', workspacePath: '/ws/4', title: '', updatedAt: 4, archived: false },
      ];
      writeFileSync(indexPath(), JSON.stringify(rows), 'utf8');

      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService({ maxEntries: 3 });

      // One write takes the table from 5 rows (4 loaded + 1 new) down to the cap.
      await service.recordCreated({ sessionId: 'newest', workspacePath: '/ws/5' });

      const persisted = JSON.parse(readFileSync(indexPath(), 'utf8')) as SessionIndexEntry[];
      expect(persisted.map((entry) => entry.sessionId).sort()).toEqual([
        'live-new',
        'live-old',
        'newest',
      ]);
      // Memory and disk agree, otherwise the next flush puts the rows back.
      expect((await service.list()).map((entry) => entry.sessionId).sort()).toEqual([
        'live-new',
        'live-old',
        'newest',
      ]);
    });

    /**
     * T066 (D4) — the repair announces itself, and the announcement lands.
     *
     * T038 promised this line ("在日志与界面上说明"); the 2026-09-17 field pass
     * repaired a real index and found nothing in main.log, the daily log or the
     * dev-server output. The call was never the problem — `console.warn` IS
     * electron-log here — the file transport floor was, and it is pinned in
     * `main/utils/__tests__/logger.test.ts`. What is pinned here is that the
     * line exists at all, and that it does not carry a username.
     */
    it('T066: warns once about a repaired index, with the backup path redacted', async () => {
      const outer = userDataDir;
      const homeLike = join(outer, 'home', 'tester');
      mkdirSync(homeLike, { recursive: true });
      userDataDir = homeLike;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        writeFileSync(join(homeLike, 'session-index.json'), '[{"sessionId":"s1","work', 'utf8');
        const { SessionIndexService } = await import('../SessionIndexService');
        const service = new SessionIndexService();

        await expect(service.list()).resolves.toEqual([]);
        expect(service.getHealth().status).toBe('repaired');

        const lines = warn.mock.calls.map((call) => String(call[0]));
        const repair = lines.filter((line) => line.includes('Session index was damaged'));
        expect(repair).toHaveLength(1);
        expect(repair[0]).toContain('.corrupt-');
        expect(repair[0]).not.toContain('/home/tester');
      } finally {
        warn.mockRestore();
        userDataDir = outer;
      }
    });

    it('T066: says nothing when the index loads cleanly', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        writeFileSync(indexPath(), '[]', 'utf8');
        const { SessionIndexService } = await import('../SessionIndexService');
        const service = new SessionIndexService();

        await expect(service.list()).resolves.toEqual([]);

        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('session-index-11: an fsynced atomic write still leaves a bare array and no temp files', async () => {
      const { SessionIndexService } = await import('../SessionIndexService');
      const service = new SessionIndexService();
      await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

      const raw = readFileSync(indexPath(), 'utf8');
      expect(Array.isArray(JSON.parse(raw))).toBe(true);
      expect(readdirSync(userDataDir).some((name) => name.endsWith('.tmp'))).toBe(false);
    });
  });
});
