import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import type { HistoryMessage } from '../../../shared/types/sessionHistory.ts';
import type { DshSessionQuery } from '../historyCache.ts';
import {
  DshRetiredHistory,
  retiredSessionIds,
  rewindSessionId,
  treeOnlyMessage,
} from '../lineage.ts';
import {
  grantsSidecarFor,
  isSessionStub,
  readStub,
  type SessionLineageEntry,
  stubLineage,
} from '../stub.ts';

/**
 * dsh-rebase P1-4b — the stub's lineage (version 2), the ids a rewind mints,
 * and the retired sessions' timelines the tree merges (decisions 026, 027).
 */

const entry = (dshSessionId: string, reason: SessionLineageEntry['reason'] = 'rewind') => ({
  dshSessionId,
  reason,
  at: 1,
});

describe('stub version 2', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-stub-v2-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const base = {
    engine: 'dsh',
    dshSessionId: 'aiclient-s.r2',
    logicalSessionId: 's',
    cwd: '/repo',
    createdAt: 5,
  };

  it('reads version 1 as a lineage of one, created when the stub was', () => {
    const file = join(home, 'v1.dsh.json');
    writeFileSync(file, JSON.stringify({ ...base, version: 1, dshSessionId: 'aiclient-s' }));
    expect(stubLineage(readStub(file))).toEqual([
      { dshSessionId: 'aiclient-s', reason: 'create', at: 5 },
    ]);
  });

  it('reads the lineage of version 2', () => {
    const lineage = [entry('aiclient-s', 'create'), entry('aiclient-s.r2')];
    const file = join(home, 'v2.dsh.json');
    writeFileSync(file, JSON.stringify({ ...base, version: 2, lineage }));
    expect(stubLineage(readStub(file))).toEqual(lineage);
  });

  it.each([
    ['a lineage not ending at the current session', [entry('aiclient-s', 'create')]],
    ['an empty lineage', []],
    ['an unsafe id', [entry('../x', 'create'), entry('aiclient-s.r2')]],
    ['an unknown reason', [{ ...entry('aiclient-s.r2'), reason: 'merge' }]],
    ['a negative cut', [{ ...entry('aiclient-s.r2'), cutSeq: -1 }]],
  ])('refuses %s', (_label, lineage) => {
    expect(isSessionStub({ ...base, version: 2, lineage })).toBe(false);
  });

  it('refuses a version it does not know', () => {
    expect(isSessionStub({ ...base, version: 3 })).toBe(false);
  });

  it('reads a migrated chat’s origin opaquely beyond its kind (P1-9c)', () => {
    const lineage = [entry('aiclient-s.r2', 'create')];
    const stub = { ...base, version: 2, lineage };
    expect(isSessionStub({ ...stub, origin: { kind: 'pi-session', converterVersion: 2 } })).toBe(
      true
    );
    // A newer build's origin must not make the chat unopenable.
    expect(isSessionStub({ ...stub, origin: { kind: 'imported-conversation', extra: [1] } })).toBe(
      true
    );
    for (const origin of [null, 'pi', [], { converterVersion: 2 }]) {
      expect(isSessionStub({ ...stub, origin }), JSON.stringify(origin)).toBe(false);
    }
  });

  it('names the grants sidecar after the stub file, whatever the stub names (decision 043)', () => {
    expect(grantsSidecarFor('/h/aiclient-sessions/aiclient-s.dsh.json')).toBe(
      '/h/aiclient-sessions/aiclient-s.dsh.grants.json'
    );
  });
});

describe('rewind ids', () => {
  it('starts at _r2 and goes one past the highest in the lineage', () => {
    expect(rewindSessionId('aiclient-s', [entry('aiclient-s', 'create')])).toBe('aiclient-s_r2');
    expect(
      rewindSessionId('aiclient-s', [
        entry('aiclient-s', 'create'),
        entry('aiclient-s_r2'),
        entry('aiclient-s_r5'),
      ])
    ).toBe('aiclient-s_r6');
    // A fork's own base is not a rewind of this chat.
    expect(rewindSessionId('aiclient-s', [entry('aiclient-sx_r9', 'fork')])).toBe('aiclient-s_r2');
    expect(rewindSessionId('aiclient-s', [entry('aiclient-s', 'create')], 2)).toBe('aiclient-s_r4');
  });

  it('mints only ids DSH’s projection cache can key: letters, digits, _ and - (decision 121)', () => {
    const id = rewindSessionId('aiclient-4f1c9e2a-0b7d-4c55-9a3e-2d1f6b8c7e90', []);
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('counts the .r<n> rewinds of lineages written before, and continues past them', () => {
    expect(
      rewindSessionId('aiclient-s', [
        entry('aiclient-s', 'create'),
        entry('aiclient-s.r2'),
        entry('aiclient-s.r3'),
      ])
    ).toBe('aiclient-s_r4');
    expect(
      rewindSessionId('aiclient-s', [
        entry('aiclient-s', 'create'),
        entry('aiclient-s.r4'),
        entry('aiclient-s_r2'),
      ])
    ).toBe('aiclient-s_r5');
    // Not a number, or not ours: ignored.
    expect(rewindSessionId('aiclient-s', [entry('aiclient-s.rx'), entry('aiclient-s_r07')])).toBe(
      'aiclient-s_r2'
    );
  });

  it('lists the retired sessions oldest first, each once, never the current one', () => {
    expect(
      retiredSessionIds([entry('a', 'create'), entry('a.r2'), entry('a.r3'), entry('a.r2')], 'a.r3')
    ).toEqual(['a', 'a.r2']);
  });
});

describe('DshRetiredHistory', () => {
  const T = 1_790_000_000_000;
  const events: DshLogEvent[] = [
    { type: 'turn/start', seq: 0, time: T, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: T + 1,
      data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: T + 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          content: [
            { type: 'reasoning', text: 'thinking hard' },
            { type: 'text', text: 'x'.repeat(2_000) },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 3, time: T + 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  function query(failing = new Set<string>()) {
    const observeSession = vi.fn(async (id: string) => {
      if (failing.has(id)) throw new Error(`cannot read ${id}`);
      return { events, cursor: 3, [Symbol.dispose]: vi.fn() };
    });
    return { observeSession } as unknown as DshSessionQuery & {
      observeSession: typeof observeSession;
    };
  }

  it('reads a retired session once, cold, and keeps only what the tree shows', async () => {
    const q = query();
    const retired = new DshRetiredHistory(q);
    const [first] = await retired.chains(['aiclient-s']);
    await retired.chains(['aiclient-s']);
    expect(q.observeSession).toHaveBeenCalledTimes(1);
    expect(q.observeSession).toHaveBeenCalledWith('aiclient-s', { projectionMode: 'none' });
    expect(first?.messages.map((message) => message.id)).toEqual(['h:u1', 'h:a1']);
    const answer = first?.messages[1] as HistoryMessage;
    // Thinking and tool rows are not in a tree; the text is cut short.
    expect(answer.blocks.map((block) => block.type)).toEqual(['text']);
    expect((answer.blocks[0] as { text: string }).text).toHaveLength(400);
  });

  it('takes a session a rewind just retired as it was folded, without reading it', async () => {
    const q = query();
    const retired = new DshRetiredHistory(q);
    const message: HistoryMessage = {
      id: 'h:u9',
      entryId: 'u9',
      role: 'user',
      blocks: [{ type: 'text', id: 'h:u9:text:0', text: 'kept' }],
    };
    retired.remember('aiclient-s', [message]);
    expect(await retired.chains(['aiclient-s'])).toEqual([
      { dshSessionId: 'aiclient-s', messages: [treeOnlyMessage(message)] },
    ]);
    expect(q.observeSession).not.toHaveBeenCalled();
  });

  it('leaves out a session it cannot read, and tries it again next time', async () => {
    const failing = new Set(['aiclient-gone']);
    const q = query(failing);
    const log = vi.fn();
    const retired = new DshRetiredHistory(q, log);
    const chains = await retired.chains(['aiclient-gone', 'aiclient-s']);
    expect(chains.map((chain) => chain.dshSessionId)).toEqual(['aiclient-s']);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] retired session unreadable',
      'aiclient-gone',
      expect.any(Error)
    );
    failing.clear();
    expect((await retired.chains(['aiclient-gone'])).map((chain) => chain.dshSessionId)).toEqual([
      'aiclient-gone',
    ]);
  });
});
