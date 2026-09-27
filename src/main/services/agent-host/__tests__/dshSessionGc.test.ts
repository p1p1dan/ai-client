import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimedDshSessionIds, DSH_SESSION_GC_GRACE_MS, readDshSessionStub } from '../dshSessionGc';

/**
 * dsh-rebase P1-3d — GC-01: the DSH sessions the session index still claims,
 * which the host's orphan collection never deletes (decision 024).
 */

const row = (sessionId: string, extra: Partial<SessionIndexEntry> = {}) =>
  ({ sessionId, ...extra }) as SessionIndexEntry;

describe('claimedDshSessionIds (GC-01)', () => {
  it('claims every row’s derived id, archived rows and pi-era rows included', async () => {
    const readStub = vi.fn(async () => undefined);
    const claimed = await claimedDshSessionIds(
      [
        row('s1', { archived: true } as Partial<SessionIndexEntry>),
        row('s2', { runtimeIdentity: '/home/u/.pi/sessions/s2.jsonl' }),
        row('s3'),
      ],
      readStub
    );
    expect(claimed.sort()).toEqual(['aiclient-s1', 'aiclient-s2', 'aiclient-s3']);
    // Only DSH identities are stubs worth reading.
    expect(readStub).not.toHaveBeenCalled();
  });

  it('adds the stub’s file name, its dshSessionId and its lineage in either shape', async () => {
    const stubs: Record<string, unknown> = {
      '/dsh/aiclient-sessions/aiclient-a.dsh.json': {
        dshSessionId: 'aiclient-a-fork2',
        lineage: ['aiclient-a', { dshSessionId: 'aiclient-a-fork1' }, 7, { other: true }],
      },
      '/dsh/aiclient-sessions/aiclient-b.dsh.json': { dshSessionId: 'aiclient-b' },
    };
    const claimed = await claimedDshSessionIds(
      [
        row('a', { runtimeIdentity: '/dsh/aiclient-sessions/aiclient-a.dsh.json' }),
        row('b', { runtimeIdentity: '/dsh/aiclient-sessions/aiclient-b.dsh.json' }),
      ],
      async (file) => stubs[file]
    );
    expect(claimed.sort()).toEqual([
      'aiclient-a',
      'aiclient-a-fork1',
      'aiclient-a-fork2',
      'aiclient-b',
    ]);
  });

  it('a stub that is gone or unreadable still claims what its row implies', async () => {
    const claimed = await claimedDshSessionIds(
      [
        row('lost', { runtimeIdentity: '/dsh/aiclient-sessions/aiclient-lost-x.dsh.json' }),
        row('garbled', { runtimeIdentity: '/dsh/aiclient-sessions/aiclient-garbled.dsh.json' }),
      ],
      async (file) => {
        if (file.includes('lost')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return 'not an object';
      }
    );
    expect(claimed.sort()).toEqual(['aiclient-garbled', 'aiclient-lost', 'aiclient-lost-x']);
  });

  it('holds a 24 h grace', () => {
    expect(DSH_SESSION_GC_GRACE_MS).toBe(24 * 60 * 60_000);
  });
});

describe('readDshSessionStub', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiclient-stub-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses a stub and refuses what is too large to be one', async () => {
    const stub = join(dir, 'aiclient-a.dsh.json');
    writeFileSync(stub, JSON.stringify({ dshSessionId: 'aiclient-a' }));
    await expect(readDshSessionStub(stub)).resolves.toEqual({ dshSessionId: 'aiclient-a' });
    const huge = join(dir, 'aiclient-b.dsh.json');
    writeFileSync(huge, `"${'x'.repeat(70 * 1024)}"`);
    await expect(readDshSessionStub(huge)).resolves.toBeUndefined();
    await expect(readDshSessionStub(join(dir, 'missing.dsh.json'))).rejects.toThrow();
  });
});
