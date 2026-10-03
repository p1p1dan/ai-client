import { describe, expect, it } from 'vitest';
import { branchEntries, decodeSession } from '../codec.ts';
import { buildSessionContext } from '../context.ts';
import { LegacyPiSessionError } from '../errors.ts';
import { convertLegacySession } from '../legacy.ts';
import { buildPiSessionTreeSnapshot } from '../tree.ts';
import type { Entry } from '../types.ts';

/**
 * dsh-rebase P1-9a — what the shared decoder adds over the 1.0.x one it was
 * moved from: a decode that reads past an unfinished operation, a conversion
 * whose ids and time the caller supplies, and one error type of its own. The
 * 1.0.x behaviour itself is pinned by the tests moved over with the code
 * (`legacyPiCodec`, `legacyPiTimeline`, `legacyPiTree`) and by the v4 corpus
 * goldens (`legacyPiCorpus`); the runtime's own session tests and its thin
 * wrappers went with `src/runtime` in dsh-rebase P1-12 step 3.
 */

const header = { kind: 'header', version: 4, id: 'session', cwd: '/repo', createdAt: 1 };
const entry = (seq: number, id: string, parentId: string | null) => ({
  kind: 'entry',
  type: 'message',
  seq,
  id,
  parentId,
  lane: 'main',
  timestamp: seq,
  message: { role: 'user', content: id, timestamp: seq },
});
const operation = (seq: number, id: string, kind: string) => ({
  kind: 'record',
  type: 'operation_started',
  lane: 'main',
  seq,
  id,
  timestamp: seq,
  sourceLeafId: null,
  intent: { kind, originalPrompt: [], initialMessages: [] },
});
const finished = (seq: number, id: string, runId: string) => ({
  kind: 'record',
  type: 'operation_finished',
  lane: 'main',
  seq,
  id,
  runId,
  timestamp: seq,
  outcome: 'completed',
});
const jsonl = (...rows: unknown[]) =>
  `${[header, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('decodeSession · tolerateUnfinished', () => {
  const crashed = jsonl(
    entry(1, 'one', null),
    operation(2, 'op-done', 'compaction'),
    finished(3, 'op-done-end', 'op-done'),
    operation(4, 'op-run', 'run'),
    entry(5, 'two', 'one')
  );

  it('still refuses by default, with the 1.0.x code', () => {
    const error = thrown(() => decodeSession(crashed));
    expect(error).toBeInstanceOf(LegacyPiSessionError);
    expect(error).toMatchObject({ code: 'session_operation_unfinished' });
  });

  it('reads the conversation and reports what never finished', () => {
    const document = decodeSession(crashed, { tolerateUnfinished: true });
    expect(document.entries.map((item) => item.id)).toEqual(['one', 'two']);
    expect(branchEntries(document).map((item) => item.id)).toEqual(['one', 'two']);
    expect(document.seq).toBe(5);
    // The finished operation is not reported; the open one is, with its line.
    expect(document.unfinished).toEqual([{ id: 'op-run', line: 5, intent: 'run' }]);
  });

  it('changes nothing for a file with nothing unfinished', () => {
    const clean = jsonl(entry(1, 'one', null), operation(2, 'op', 'run'), finished(3, 'end', 'op'));
    expect(decodeSession(clean, { tolerateUnfinished: true })).toEqual(decodeSession(clean));
    expect(decodeSession(clean).unfinished).toBeUndefined();
  });

  it('does not relax any other check', () => {
    const broken = jsonl(entry(1, 'one', null), operation(2, 'op', 'run'), entry(4, 'gap', 'one'));
    expect(() => decodeSession(broken, { tolerateUnfinished: true })).toThrow(
      /non-consecutive seq/
    );
  });
});

describe('convertLegacySession · injected ids and time', () => {
  const stamp = '2026-09-09T00:00:00Z';
  const v2 = [
    { type: 'session', version: 2, id: 'old', timestamp: stamp, cwd: '/repo', tier: 'handsoff' },
    {
      type: 'message',
      id: 'u',
      parentId: null,
      timestamp: stamp,
      message: { role: 'user', content: 'hi', timestamp: 1 },
    },
    { type: 'session_info', id: 's', parentId: 'u', timestamp: stamp, name: 'renamed' },
    { type: 'label', id: 'l', parentId: 's', timestamp: stamp, targetId: 'u', label: 'first' },
    // No id: the converter has to make one up.
    { type: 'custom', parentId: 'l', timestamp: stamp, customType: 'note', data: {} },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');
  const inject = () => {
    let next = 0;
    return { newId: () => `id-${++next}`, now: () => 42 };
  };

  it('is a pure function of its input once ids and time are supplied', () => {
    const once = convertLegacySession(v2, '/repo', '/source/old.jsonl', false, inject());
    const again = convertLegacySession(v2, '/repo', '/source/old.jsonl', false, inject());
    expect(again).toBe(once);
    const document = decodeSession(once);
    expect(document.header.id).toBe('id-1');
    // Header, the id-less row, two fact rows, the permission record, the lane row.
    expect(new Set(once.match(/"id-\d+"/g))).toEqual(
      new Set(['"id-1"', '"id-2"', '"id-3"', '"id-4"', '"id-5"', '"id-6"'])
    );
    const permissions = document.entries.at(-1) as Entry & { customType?: string };
    expect(permissions).toMatchObject({ customType: 'aiclient.permissions', timestamp: 42 });
    expect(document.name).toBe('renamed');
    expect(document.labels).toEqual({ u: 'first' });
  });

  it('keeps minting fresh ids when nothing is injected, as 1.0.x did', () => {
    const one = decodeSession(convertLegacySession(v2, '/repo', '/source/old.jsonl'));
    const two = decodeSession(convertLegacySession(v2, '/repo', '/source/old.jsonl'));
    expect(one.header.id).not.toBe(two.header.id);
    expect(one.header.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses with its own error type and the 1.0.x codes', () => {
    expect(thrown(() => convertLegacySession(v2, '/elsewhere', '/source'))).toMatchObject({
      name: 'LegacyPiSessionError',
      code: 'session_cwd_mismatch',
    });
    expect(thrown(() => convertLegacySession('[]', '/repo', '/source'))).toMatchObject({
      code: 'session_legacy_invalid',
    });
    expect(thrown(() => decodeSession('{}\n'))).toMatchObject({
      code: 'session_format_unsupported',
    });
  });
});

describe('buildSessionContext (vendored subset)', () => {
  const base = { seq: 1, timestamp: 1 };
  const user = (id: string, parentId: string | null, text: string): Entry => ({
    ...base,
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: text, timestamp: 1 },
  });

  it('starts at the latest compaction and replays its retained tail', () => {
    const entries: Entry[] = [
      user('a', null, 'before'),
      {
        ...base,
        type: 'compaction',
        id: 'c',
        parentId: 'a',
        summary: 'S',
        tokensBefore: 10,
        retainedTail: [{ role: 'user', content: 'kept', timestamp: 2 }],
      },
      user('b', 'c', 'after'),
    ];
    expect(buildSessionContext(entries).messages).toEqual([
      { role: 'compactionSummary', summary: 'S', tokensBefore: 10, timestamp: 1 },
      { role: 'user', content: 'kept', timestamp: 2 },
      { role: 'user', content: 'after', timestamp: 1 },
    ]);
  });

  it('turns a branch summary into a message and leaves custom entries out', () => {
    const entries: Entry[] = [
      user('a', null, 'x'),
      { ...base, type: 'branch_summary', id: 'b', parentId: 'a', summary: 'B', fromId: 'z' },
      { ...base, type: 'custom', id: 'c', parentId: 'b', customType: 'aiclient.runStop', data: {} },
      { ...base, type: 'model_change', id: 'm', parentId: 'c', provider: 'p', modelId: 'm1' },
      { ...base, type: 'thinking_level_change', id: 't', parentId: 'm', thinkingLevel: 'high' },
    ];
    const context = buildSessionContext(entries);
    expect(context.messages.map((message) => message.role)).toEqual(['user', 'branchSummary']);
    expect(context.model).toEqual({ provider: 'p', modelId: 'm1' });
    expect(context.thinkingLevel).toBe('high');
    expect(context.activeToolNames).toBeNull();
  });
});

describe('buildPiSessionTreeSnapshot', () => {
  it('refuses a manager with no entries, with the worker code', () => {
    expect(
      thrown(() =>
        buildPiSessionTreeSnapshot({
          manager: {},
          logicalSessionId: 'l',
          sessionFile: 'f',
          workspacePath: '/repo',
        })
      )
    ).toMatchObject({ name: 'LegacyPiSessionError', code: 'WORKER_TREE_UNAVAILABLE' });
  });
});
