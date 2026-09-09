import { describe, expect, it } from 'vitest';
import { branchEntries, decodeSession } from '../plugins/session/codec.ts';

const header = { kind: 'header', version: 4, id: 'session', cwd: '/repo', createdAt: 1 };
const entry = (seq: number, id: string, parentId: string | null, lane = 'main') => ({
  kind: 'entry',
  type: 'message',
  seq,
  id,
  parentId,
  lane,
  timestamp: seq,
  message: { role: 'user', content: id, timestamp: seq },
});
const jsonl = (...rows: unknown[]) =>
  `${[header, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`;

describe('Pi v4 codec invariants', () => {
  it('follows the main lane without including another branch', () => {
    const doc = decodeSession(
      jsonl(
        entry(1, 'root', null),
        { kind: 'lane', seq: 2, lane: 'other', leafId: 'root' },
        entry(3, 'alternate', 'root', 'other'),
        { kind: 'fact', seq: 4, fact: 'name', name: 'kept name' },
        entry(5, 'main-next', 'root')
      )
    );
    expect(doc.seq).toBe(5);
    expect(doc.entries).toHaveLength(3);
    expect(branchEntries(doc).map((entry) => entry.id)).toEqual(['root', 'main-next']);
  });

  it.each([
    [entry(2, 'gap', null)],
    [entry(1, 'one', null), entry(2, 'one', 'one')],
    [entry(1, 'one', 'missing')],
    [entry(1, 'one', null, 'unknown')],
    [entry(1, 'one', null), { kind: 'lane', seq: 2, lane: 'main', leafId: 'missing' }],
  ])('rejects corrupt sequence, identities or branch edges: %j', (...rows) => {
    expect(() => decodeSession(jsonl(...rows))).toThrow();
  });

  it('retains completed SDK operation records but rejects unfinished operation recovery', () => {
    const start = {
      kind: 'record',
      type: 'operation_started',
      lane: 'main',
      seq: 1,
      id: 'op',
      timestamp: 1,
      sourceLeafId: null,
      intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
    };
    expect(() => decodeSession(jsonl(start))).toThrow(/unfinished SDK operations/);
    const finish = {
      kind: 'record',
      type: 'operation_finished',
      lane: 'main',
      seq: 2,
      id: 'end',
      runId: 'op',
      timestamp: 2,
      outcome: 'completed',
    };
    expect(decodeSession(jsonl(start, finish)).seq).toBe(2);
  });

  it('repairs the separator after a complete final line without losing that entry', () => {
    const content = jsonl(entry(1, 'one', null)).trimEnd();
    const doc = decodeSession(content);
    expect(doc.entries).toHaveLength(1);
    expect(doc.repair).toBe(`${content}\n`);
  });
});
