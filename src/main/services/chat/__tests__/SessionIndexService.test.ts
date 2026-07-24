import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('enriches an entry with runtimeIdentity on session.resumed runtime events', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });

    const event: RuntimeEvent = {
      type: 'session.resumed',
      seq: 1,
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { runtimeIdentity: 'claude-runtime-1' },
    };
    service.handleRuntimeEvent(event);

    // Poll the persisted file (not just the in-memory list) so this test only completes
    // once the fire-and-forget event handler's flush has fully settled. Otherwise the
    // pending write can land after this test's temp dir is torn down and pollute the
    // next test with a stray ENOENT warning.
    await vi.waitFor(() => {
      const raw = readFileSync(join(userDataDir, 'session-index.json'), 'utf8');
      const parsed = JSON.parse(raw) as SessionIndexEntry[];
      expect(parsed[0]?.runtimeIdentity).toBe('claude-runtime-1');
    });
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
});
