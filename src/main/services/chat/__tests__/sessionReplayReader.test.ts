import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paginatePiSessionHistory } from '../../../../agent-host/piSessionTimeline';
import type {
  RuntimeFileInfo,
  RuntimeFileKind,
  RuntimeHostIoService,
  RuntimeReadOptions,
  RuntimeReadResult,
  RuntimeWriteOptions,
} from '../../../../runtime/contracts';
import { interopHeader } from '../../../../runtime/plugins/session/codec';
import { prepareSessionConfig } from '../../../../runtime/plugins/session/legacy';
import { JsonlSessionStore } from '../../../../runtime/plugins/session/store';
import { readSessionReplayPage, SESSION_REPLAY_UNAVAILABLE } from '../SessionReplayReader';

/**
 * T102 (decision 030) — the read-only history path, against the writing one.
 *
 * Two questions, and the second is the one that matters:
 *
 *  1. Does reading a session leave the file and its directory untouched? The
 *     whole reason this path exists rather than a second `JsonlSessionStore` is
 *     that the store takes the advisory writer lock unconditionally and writes
 *     repairs back. A reader that did either would be a second writer on a file
 *     a worker may be about to open.
 *  2. Does it produce the SAME transcript the worker produces? A cheaper reader
 *     that quietly renders a different conversation is worse than no reader, so
 *     the pages are compared against `JsonlSessionStore.history()` on the very
 *     same file — the call the worker's history RPC makes.
 *
 * The fixtures are built here rather than checked in: a session file is a chain
 * of ids and `seq` numbers the codec validates, and a hand-edited copy drifts
 * out of shape the first time either rule changes. Both formats a user can
 * actually have are covered — native v4, and the legacy v3 a `pi` CLI writes.
 */

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'session-replay-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * `RuntimeHostIoService` over `node:fs`, for the worker-side half of the
 * comparison only.
 *
 * The runtime's real implementation is a cordis `Service`, and cordis lives in
 * `src/runtime`'s own `node_modules` — not resolvable from a Main test file.
 * Only the calls `JsonlSessionStore.open` and `prepareSessionConfig` make are
 * implemented; nothing here is used by the code under test, which reads the
 * file with plain `node:fs` and no service at all.
 */
const hostIo: RuntimeHostIoService = {
  async readFile(path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult> {
    const bytes = await readFile(path);
    if (bytes.length > options.maxBytes) {
      if (options.overflow === 'error') throw new Error(`io_limit: ${path}`);
      return { bytes: bytes.subarray(0, options.maxBytes), truncated: true, source: 'direct' };
    }
    return { bytes, truncated: false, source: 'direct' };
  },
  async writeFile(path: string, bytes: Uint8Array, options?: RuntimeWriteOptions): Promise<void> {
    const handle = await open(path, options?.createOnly ? 'wx' : 'w', options?.mode);
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  },
  async appendFile(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void> {
    const handle = await open(path, 'a', options?.mode);
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  },
  async stat(path: string): Promise<RuntimeFileInfo> {
    const info = await stat(path);
    const kind: RuntimeFileKind = info.isDirectory()
      ? 'directory'
      : info.isFile()
        ? 'file'
        : 'other';
    return { kind, size: info.size, mtimeMs: info.mtimeMs };
  },
  realpath,
  async *readDirectory(path: string) {
    for (const item of await readdir(path, { withFileTypes: true }))
      yield {
        name: item.name,
        kind: (item.isDirectory() ? 'directory' : 'file') as RuntimeFileKind,
      };
  },
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await mkdir(path, { recursive: options?.recursive ?? false, mode: options?.mode });
  },
  rename,
  link,
  unlink,
  rmdir,
};

const CREATED_AT = Date.parse('2026-09-19T00:00:00.000Z');
const at = (offset: number) => CREATED_AT + offset * 1_000;

/** The message rows both fixtures carry, so the two formats are comparable. */
const TRANSCRIPT = [
  { id: 'u1', message: { role: 'user', content: 'find the bug' } },
  {
    id: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking at the file.' },
        { type: 'toolCall', id: 'call-1', name: 'Read', arguments: { path: 'a.ts' } },
      ],
      stopReason: 'toolUse',
    },
  },
  {
    id: 't1',
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'Read',
      isError: false,
      content: [{ type: 'text', text: 'export const a = 1;' }],
    },
  },
  {
    id: 'a2',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Found it.' }],
      stopReason: 'endTurn',
    },
  },
  { id: 'u2', message: { role: 'user', content: 'fix it' } },
  {
    id: 'a3',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      stopReason: 'endTurn',
    },
  },
];

/** A native v4 file with the dual header the store writes, so no open repairs it. */
async function writeNativeSession(file: string): Promise<void> {
  const header = interopHeader({
    kind: 'header',
    version: 4,
    id: 'replay-session',
    cwd: dir,
    createdAt: CREATED_AT,
  } as Parameters<typeof interopHeader>[0]);
  const rows: unknown[] = [header];
  let parentId: string | null = null;
  TRANSCRIPT.forEach((row, index) => {
    rows.push({
      kind: 'entry',
      type: 'message',
      seq: index + 1,
      id: row.id,
      parentId,
      lane: 'main',
      timestamp: at(index),
      message: { ...row.message, timestamp: at(index) },
    });
    parentId = row.id;
  });
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

/** The v3 shape `pi --session` writes: `type:"session"` header, no `kind`/`seq`. */
async function writeLegacySession(file: string): Promise<void> {
  const rows: unknown[] = [
    {
      type: 'session',
      version: 3,
      id: 'legacy-replay-session',
      timestamp: new Date(CREATED_AT).toISOString(),
      cwd: dir,
    },
  ];
  let parentId: string | null = null;
  TRANSCRIPT.forEach((row, index) => {
    rows.push({
      type: 'message',
      id: row.id,
      parentId,
      timestamp: new Date(at(index)).toISOString(),
      message: { ...row.message, timestamp: at(index) },
    });
    parentId = row.id;
  });
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

/** The worker's own answer for a native file: open, project, close, unlock. */
async function workerProjection(file: string, offset?: number, limit?: number) {
  const store = await JsonlSessionStore.open(hostIo, { file, cwd: dir, mode: 'resume' });
  try {
    return paginatePiSessionHistory(store.history(), offset, limit);
  } finally {
    await store.close();
  }
}

describe('SessionReplayReader — history without a worker (T102)', () => {
  it('replays a v4 session without taking the writer lock', async () => {
    const file = join(dir, 'native.jsonl');
    await writeNativeSession(file);
    const before = await stat(file);

    const page = await readSessionReplayPage({ sessionFile: file });

    expect(page.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(page.totalCount).toBe(5);
    expect(page.hasMore).toBe(false);
    // The point of the case: no sidecar of any kind, and the file itself
    // untouched. `.writer.lock` is the name `writerLock.ts` derives.
    expect(await readdir(dir)).toEqual(['native.jsonl']);
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('converts a v3 session in memory and never writes it back', async () => {
    const file = join(dir, 'legacy.jsonl');
    await writeLegacySession(file);
    const before = await readFile(file, 'utf8');
    const beforeStat = await stat(file);

    const page = await readSessionReplayPage({ sessionFile: file });

    expect(page.messages.map((message) => message.entryId)).toEqual(['u1', 'a1', 'a2', 'u2', 'a3']);
    // `prepareSessionConfig` would have left a `<file>.native-v4.jsonl` sibling
    // and its lock here. The read-only path converts into a string and drops it.
    expect(await readdir(dir)).toEqual(['legacy.jsonl']);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('pages match the worker-side projection for the same file', async () => {
    const native = join(dir, 'native.jsonl');
    await writeNativeSession(native);
    // Newest page, an older page, and a page size the pagination has to clamp —
    // the three shapes `chat:loadHistoryPage` can ask for.
    for (const [offset, limit] of [
      [undefined, undefined],
      [0, 2],
      [2, 2],
      [0, 500],
    ] as const) {
      expect(await readSessionReplayPage({ sessionFile: native, offset, limit })).toEqual(
        await workerProjection(native, offset, limit)
      );
    }

    // The legacy format travels a different route on each side: the worker
    // converts it to a `.native-v4.jsonl` sibling on disk and opens that, the
    // reader converts the same bytes in memory. The transcript must not notice.
    const legacy = join(dir, 'legacy.jsonl');
    await writeLegacySession(legacy);
    const replayed = await readSessionReplayPage({ sessionFile: legacy, limit: 500 });
    const converted = await prepareSessionConfig(hostIo, {
      file: legacy,
      cwd: dir,
      mode: 'resume',
    });
    expect(converted.file).not.toBe(legacy);
    expect(replayed).toEqual(await workerProjection(converted.file, 0, 500));
  });

  it('reports session_replay_unavailable for a session with an unfinished operation', async () => {
    const file = join(dir, 'unfinished.jsonl');
    await writeNativeSession(file);
    const started = {
      kind: 'record',
      type: 'operation_started',
      lane: 'main',
      seq: TRANSCRIPT.length + 1,
      id: 'op-1',
      timestamp: at(TRANSCRIPT.length),
      sourceLeafId: null,
      intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
    };
    await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify(started)}\n`);

    await expect(readSessionReplayPage({ sessionFile: file })).rejects.toMatchObject({
      code: SESSION_REPLAY_UNAVAILABLE,
      cause: 'session_operation_unfinished',
    });
    // Still a read: a refusal must not leave a lock behind either.
    expect(await readdir(dir)).toEqual(['unfinished.jsonl']);
  });

  it('reports session_replay_unavailable for a file that is not a session', async () => {
    const file = join(dir, 'notes.jsonl');
    await writeFile(file, '{"hello":"world"}\n');
    await expect(readSessionReplayPage({ sessionFile: file })).rejects.toMatchObject({
      code: SESSION_REPLAY_UNAVAILABLE,
    });
    await expect(
      readSessionReplayPage({ sessionFile: join(dir, 'missing.jsonl') })
    ).rejects.toMatchObject({ code: SESSION_REPLAY_UNAVAILABLE, cause: 'ENOENT' });
  });
});

// `dirname` is imported for the legacy-conversion fallback path's contract
// (the reader defaults an absent header cwd to the file's directory); asserting
// it here keeps the import honest rather than leaving an unused symbol.
describe('SessionReplayReader — legacy files with no recorded cwd', () => {
  it('converts using the indexed workspace when the header names no cwd', async () => {
    const file = join(dir, 'no-cwd.jsonl');
    const rows: unknown[] = [
      {
        type: 'session',
        version: 3,
        id: 'no-cwd-session',
        timestamp: new Date(CREATED_AT).toISOString(),
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: new Date(at(0)).toISOString(),
        message: { role: 'user', content: 'hello', timestamp: at(0) },
      },
    ];
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const page = await readSessionReplayPage({ sessionFile: file, workspacePath: dirname(file) });
    expect(page.messages).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['no-cwd.jsonl']);
  });
});
