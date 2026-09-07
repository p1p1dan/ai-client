import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANNOUNCEMENTS_MAX_BYTES } from '@shared/announcements';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AnnouncementFetch, AnnouncementService } from '../AnnouncementService';

const PAYLOAD = {
  version: 1,
  announcements: [
    { id: 'rel-040', title: 'Release 0.4.0', body: 'New model menu.', severity: 'info' },
    { id: 'maint', title: 'Maintenance', body: 'Sunday 02:00.', severity: 'warning' },
  ],
};

const ok: AnnouncementFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(PAYLOAD),
});

describe('AnnouncementService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'announcements-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(fetchFn: AnnouncementFetch, now = 1000): AnnouncementService {
    return new AnnouncementService({
      stateDir: dir,
      endpointUrl: 'https://onboard.example/api/v1/announcements',
      fetchFn,
      now: () => now,
    });
  }

  it('fetches, caches and reports where the list came from', async () => {
    const result = await service(ok).refresh();
    expect(result.source).toBe('remote');
    expect(result.fetchedAt).toBe(1000);
    expect(result.announcements.map((entry) => entry.id)).toEqual(['rel-040', 'maint']);
    expect(
      JSON.parse(readFileSync(join(dir, 'announcements.json'), 'utf8')).announcements
    ).toHaveLength(2);
  });

  it('sends no Authorization header — the endpoint is public by ruling', async () => {
    let seen: Record<string, string> | null = null;
    await service(async (_url, init) => {
      seen = init.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify(PAYLOAD) };
    }).refresh();
    expect(seen).toEqual({ Accept: 'application/json' });
  });

  it('falls back to the cache when the service is unreachable', async () => {
    await service(ok, 1000).refresh();
    const offline = await service(async () => {
      throw new Error('connection refused');
    }, 2000).refresh();
    expect(offline.source).toBe('cache');
    expect(offline.fetchedAt).toBe(1000);
    expect(offline.announcements).toHaveLength(2);
    expect(offline.error).toContain('connection refused');
  });

  it('reports unavailable rather than throwing when there is nothing at all', async () => {
    const result = await service(async () => {
      throw new Error('offline');
    }).refresh();
    expect(result).toMatchObject({ source: 'unavailable', announcements: [], fetchedAt: null });
    expect(result.error).toContain('offline');
  });

  it('treats an HTTP error and an oversized body as failures, not as content', async () => {
    const http = await service(async () => ({
      ok: false,
      status: 503,
      text: async () => 'down',
    })).refresh();
    expect(http.source).toBe('unavailable');

    const huge = 'x'.repeat(ANNOUNCEMENTS_MAX_BYTES + 10);
    const oversized = await service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ announcements: [{ id: 'a', title: huge }] }),
    })).refresh();
    expect(oversized.source).toBe('unavailable');
  });

  it('survives a corrupt cache file instead of failing to start', async () => {
    writeFileSync(join(dir, 'announcements.json'), '{ not json');
    expect(service(ok).snapshot()).toMatchObject({ source: 'unavailable', announcements: [] });
  });

  it('answers from disk with no network call', async () => {
    await service(ok).refresh();
    let calls = 0;
    const offline = service(async () => {
      calls += 1;
      throw new Error('should not be called');
    });
    expect(offline.snapshot().announcements).toHaveLength(2);
    expect(calls).toBe(0);
  });

  it('records read ids and prunes ones the service stopped serving', async () => {
    const live = service(ok);
    await live.refresh();
    expect(live.markRead(['rel-040', 'ghost']).sort()).toEqual(['rel-040']);
    expect(live.snapshot().readIds).toEqual(['rel-040']);

    // The service drops `rel-040` and keeps `maint`.
    const shrunk = service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ announcements: [PAYLOAD.announcements[1]] }),
    }));
    expect((await shrunk.refresh()).readIds).toEqual([]);
  });

  it('clears read state on request, so the next account starts from zero', async () => {
    const live = service(ok);
    await live.refresh();
    live.markRead(['rel-040']);
    live.clearReadState();
    expect(live.snapshot().readIds).toEqual([]);
  });

  it('single-flights concurrent refreshes', async () => {
    let calls = 0;
    const counted = service(async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(PAYLOAD) };
    });
    await Promise.all([counted.refresh(), counted.refresh(), counted.refresh()]);
    expect(calls).toBe(1);
  });
});
