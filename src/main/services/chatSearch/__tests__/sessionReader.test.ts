import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paginateHistory } from '@shared/dshHistory/page';
import type { HistoryMessage, SessionHistoryPage } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionReplayPage } from '../../chat/SessionReplayReader';
import { indexableHistory } from '../extract';
import {
  engineOf,
  findClaudeTranscript,
  readSessionMessages,
  type SessionReaderDeps,
} from '../sessionReader';

/**
 * One session's searchable messages per engine, and the keys they carry: the
 * same `HistoryMessage.id` the timeline renders when the session is opened.
 */

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../shared/__tests__/fixtures/legacy-pi'
);

function entry(fields: Partial<SessionIndexEntry>): SessionIndexEntry {
  return {
    sessionId: 's1',
    workspacePath: '/repo',
    title: 'Chat',
    updatedAt: 1,
    archived: false,
    ...fields,
  };
}

function message(id: string, role: HistoryMessage['role'], text: string): HistoryMessage {
  return { id: `h:${id}`, entryId: id, role, blocks: [{ type: 'text', id: `${id}:t`, text }] };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-search-reader-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<SessionReaderDeps> = {}): SessionReaderDeps {
  return {
    readDshPage: vi.fn(async () => {
      throw new Error('unexpected DSH read');
    }),
    readLegacyPage: (request) => readSessionReplayPage(request),
    readFile: (file) => readFile(file),
    claudeConfigDir: join(dir, 'claude'),
    ...overrides,
  };
}

describe('engineOf', () => {
  it('follows the row binding as chat:readSessionPage does', () => {
    expect(engineOf(entry({ agent: 'pi', runtimeIdentity: '/x/a.jsonl' }))).toBe('legacy-pi');
    expect(engineOf(entry({ agent: 'dsh', runtimeIdentity: '/x/a.dsh.json' }))).toBe('dsh');
    expect(engineOf(entry({ agent: 'dsh', runtimeIdentity: '/x/a.ccsdk.json' }))).toBe(
      'claude-sdk'
    );
    expect(engineOf(entry({ agent: 'dsh' }))).toBeNull();
    expect(engineOf(entry({ agent: 'future', runtimeIdentity: '/x' }))).toBeNull();
  });
});

describe('DSH sessions', () => {
  it('pages the host read back to front and keeps the projected ids', async () => {
    const history: HistoryMessage[] = [];
    for (let i = 0; i < 1203; i += 1) {
      history.push(message(`m${i}`, i % 2 ? 'assistant' : 'user', `text ${i}`));
    }
    // A notice the app wrote and an engine-started head are not prose.
    history.push({
      id: 'h:n',
      role: 'system',
      blocks: [{ type: 'text', id: 'n:t', text: 'notice', notice: { key: 'k' } }],
    });
    history.push({ ...message('head', 'user', 'goal round'), origin: { kind: 'goal', round: 1 } });
    const readDshPage = vi.fn(
      async (request: { offset: number; limit: number }): Promise<SessionHistoryPage> =>
        paginateHistory(history, request.offset, request.limit)
    );
    const messages = await readSessionMessages(
      entry({ agent: 'dsh', runtimeIdentity: '/dsh/aiclient-sessions/x.dsh.json' }),
      deps({ readDshPage })
    );
    expect(readDshPage).toHaveBeenCalledTimes(3);
    expect(readDshPage.mock.calls[0]?.[0]).toMatchObject({
      stubFile: '/dsh/aiclient-sessions/x.dsh.json',
      logicalSessionId: 's1',
      offset: 0,
      limit: 500,
    });
    expect(messages).toHaveLength(1203);
    expect(messages[0]).toMatchObject({ key: 'h:m0', role: 'user', text: 'text 0' });
    expect(messages.at(-1)).toMatchObject({ key: 'h:m1202', text: 'text 1202' });
  });

  it('fails the read when the host does', async () => {
    await expect(
      readSessionMessages(
        entry({ agent: 'dsh', runtimeIdentity: '/x.dsh.json' }),
        deps({
          readDshPage: async () => {
            throw new Error('DSH_HOST_UNAVAILABLE');
          },
        })
      )
    ).rejects.toThrow('DSH_HOST_UNAVAILABLE');
  });
});

describe('legacy pi sessions', () => {
  it('reads the corpus file with the timeline ids its golden pins', async () => {
    const file = join(dir, 'v4-basic.jsonl');
    await writeFile(file, await readFile(join(CORPUS, 'v4-basic.jsonl')));
    const golden = JSON.parse(
      await readFile(join(CORPUS, 'golden', 'v4-basic.jsonl.golden.json'), 'utf8')
    ) as { history: HistoryMessage[] };
    const messages = await readSessionMessages(
      entry({ agent: 'pi', runtimeIdentity: file }),
      deps()
    );
    expect(messages.map((m) => m.key)).toEqual(indexableHistory(golden.history).map((m) => m.key));
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What do the notes say?'],
      ['assistant', 'Reading the notes.'],
      ['assistant', 'The notes say alpha and beta.'],
      ['user', 'What is in this picture?'],
      ['assistant', 'A single red pixel.'],
      ['user', 'Write a short summary file.'],
      ['assistant', 'Wrote out/summary.md.'],
    ]);
  });
});

describe('Claude Agent SDK sessions', () => {
  async function writeStub(fields: Record<string, unknown>): Promise<string> {
    const stubDir = join(dir, 'claude', 'aiclient-sessions');
    await mkdir(stubDir, { recursive: true });
    const file = join(stubDir, 'cc-1.ccsdk.json');
    await writeFile(
      file,
      JSON.stringify({ engine: 'claude-sdk', version: 1, ccSessionId: 'cc-1', ...fields })
    );
    return file;
  }

  async function writeTranscript(projectDir: string, text: string): Promise<string> {
    const target = join(dir, 'claude', 'projects', projectDir);
    await mkdir(target, { recursive: true });
    const file = join(target, 'cc-1.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: text },
      })}\n`
    );
    return file;
  }

  it('reads the transcript under the chat cwd, through the injected reader', async () => {
    const stub = await writeStub({ cwd: '/repo/app', started: true, logicalSessionId: 's1' });
    await writeTranscript('-other', 'from another copy');
    await writeTranscript('-repo-app', 'from the chat cwd');
    const read = vi.fn((file: string) => readFile(file));
    const messages = await readSessionMessages(
      entry({ agent: 'dsh', runtimeIdentity: stub }),
      deps({ readFile: read })
    );
    expect(messages).toEqual([{ key: 'h:u1', role: 'user', text: 'from the chat cwd' }]);
    expect(read).toHaveBeenCalledWith(stub);
  });

  it('falls back to the newest copy anywhere, and to nothing before the first send', async () => {
    const started = await writeStub({ cwd: '/elsewhere', started: true });
    await writeTranscript('-worktree', 'from the worktree copy');
    expect(
      (await readSessionMessages(entry({ agent: 'dsh', runtimeIdentity: started }), deps())).map(
        (m) => m.text
      )
    ).toEqual(['from the worktree copy']);
    expect(await findClaudeTranscript(join(dir, 'claude'), '../escape', '/x')).toBeNull();

    const fresh = await writeStub({ cwd: '/elsewhere', started: false });
    expect(
      await readSessionMessages(entry({ agent: 'dsh', runtimeIdentity: fresh }), deps())
    ).toEqual([]);
  });
});
