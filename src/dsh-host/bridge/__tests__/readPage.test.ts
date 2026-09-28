import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import { DshHistoryCache, type DshSessionObservation } from '../historyCache.ts';
import { readSessionPage } from '../readPage.ts';
import { type SessionStub, stubPathFor, writeStubAtomically } from '../stub.ts';

/**
 * dsh-rebase P1-4a / decision 030 — the host half of Main's preview: read the
 * stub, check it names the session asked about, observe the DSH session and
 * page its projection. Against a fake `sessionQuery` fed a real DSH log (the
 * P1-4e crash recording, whose last turn DSH closed as interrupted); the real
 * cold read, lock-free and write-free, is `tools/bridge-smoke.ts` and the
 * shared-host integration test.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../shared/__tests__/fixtures/dsh/log.crash-resume.json'
);
const LOGICAL = 'chat-1';
const DSH_ID = `aiclient-${LOGICAL}`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-read-page-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function recordedEvents(): DshLogEvent[] {
  const log = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { events: DshLogEvent[] };
  return log.events.map((event) => ({ ...event, time: 1_790_000_000_000 + event.seq }));
}

function writeStub(stub: Partial<SessionStub> = {}): string {
  const file = stubPathFor(home, DSH_ID);
  writeStubAtomically(file, {
    engine: 'dsh',
    version: 1,
    dshSessionId: DSH_ID,
    logicalSessionId: LOGICAL,
    cwd: '/repo',
    createdAt: 1,
    ...stub,
  });
  return file;
}

function fakeQuery(events: DshLogEvent[] | Error) {
  const disposed: string[] = [];
  const observeSession = vi.fn(async (sessionId: string, _options?: unknown) => {
    if (events instanceof Error) throw events;
    const observation: DshSessionObservation = {
      events,
      cursor: events.at(-1)?.seq ?? -1,
      [Symbol.dispose]: () => disposed.push(sessionId),
    };
    return observation;
  });
  return { query: { observeSession }, disposed };
}

describe('readSessionPage', () => {
  it('observes the session the stub names, without projections, and releases the observation', async () => {
    const stubFile = writeStub();
    const { query, disposed } = fakeQuery(recordedEvents());
    const page = await readSessionPage(query, { stubFile, logicalSessionId: LOGICAL });
    expect(query.observeSession).toHaveBeenCalledWith(DSH_ID, { projectionMode: 'none' });
    expect(disposed).toEqual([DSH_ID]);
    // The recording's crash closer: a tool row whose outcome is unknown, then the note.
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'system']);
    expect(page.messages[1]?.blocks.at(-1)).toMatchObject({ outcomeUnknown: true });
  });

  it('gives the page the bridge’s own cache gives for the same log and range', async () => {
    const events = recordedEvents();
    const stubFile = writeStub();
    const cache = new DshHistoryCache(fakeQuery(events).query);
    cache.reset(DSH_ID);
    await cache.load();
    for (const [offset, limit] of [
      [undefined, undefined],
      [0, 80],
      [1, 1],
      [2, 500],
      [9, 3],
    ] as const) {
      const page = await readSessionPage(fakeQuery(events).query, {
        stubFile,
        logicalSessionId: LOGICAL,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      expect(page, `${offset}/${limit}`).toEqual(cache.page(offset, limit));
    }
  });

  it('refuses a stub that names another logical session, before reading anything', async () => {
    const stubFile = writeStub({ logicalSessionId: 'someone-else' });
    const { query } = fakeQuery(recordedEvents());
    await expect(
      readSessionPage(query, { stubFile, logicalSessionId: LOGICAL })
    ).rejects.toMatchObject({ code: 'session_invalid' });
    expect(query.observeSession).not.toHaveBeenCalled();
  });

  it('answers a missing stub dsh_session_missing and a file that is not one session_invalid', async () => {
    const { query } = fakeQuery(recordedEvents());
    await expect(
      readSessionPage(query, { stubFile: join(home, 'nope.dsh.json'), logicalSessionId: LOGICAL })
    ).rejects.toMatchObject({ code: 'dsh_session_missing' });
    const bogus = join(home, 'aiclient-sessions', 'bogus.dsh.json');
    mkdirSync(dirname(bogus), { recursive: true });
    writeFileSync(bogus, JSON.stringify({ engine: 'dsh', version: 1, dshSessionId: '../x' }));
    await expect(
      readSessionPage(query, { stubFile: bogus, logicalSessionId: LOGICAL })
    ).rejects.toMatchObject({ code: 'session_invalid' });
    expect(query.observeSession).not.toHaveBeenCalled();
  });

  it('maps a DSH session gone from disk to dsh_session_missing, and passes other failures through', async () => {
    const stubFile = writeStub();
    const notFound = Object.assign(new Error('no such session'), {
      name: 'SessionPersistenceNotFoundError',
    });
    await expect(
      readSessionPage(fakeQuery(notFound).query, { stubFile, logicalSessionId: LOGICAL })
    ).rejects.toMatchObject({ code: 'dsh_session_missing' });
    const other = new Error('disk on fire');
    await expect(
      readSessionPage(fakeQuery(other).query, { stubFile, logicalSessionId: LOGICAL })
    ).rejects.toBe(other);
  });
});
