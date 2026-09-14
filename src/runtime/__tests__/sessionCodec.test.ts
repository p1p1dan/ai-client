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
/** A row `pi --session` appended: no `kind`, no `seq`, an ISO timestamp. */
const cliRow = (id: string, parentId: string | null) => ({
  type: 'message',
  id,
  parentId,
  timestamp: new Date(2).toISOString(),
  message: { role: 'user', content: id, timestamp: 2 },
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

  describe('session-01 · CLI rows are outside our sequence', () => {
    it('numbers our rows only, so a row written while the CLI appended still fits', () => {
      const doc = decodeSession(
        jsonl(entry(1, 'one', null), cliRow('cli', 'one'), entry(2, 'two', 'one'))
      );
      expect(doc.seq).toBe(2);
      expect(doc.entries.map((item) => item.id)).toEqual(['one', 'cli', 'two']);
      // Our row hung off the leaf we held before the CLI wrote: a branch, and
      // the branch the CLI itself reads back, since it walks from the last row.
      expect(branchEntries(doc).map((item) => item.id)).toEqual(['one', 'two']);
    });

    it('still accepts a file written before that, where CLI rows were counted', () => {
      // Refusing these would brick exactly the sessions this fix is for.
      const doc = decodeSession(
        jsonl(entry(1, 'one', null), cliRow('cli', 'one'), entry(3, 'two', 'cli'))
      );
      expect(doc.seq).toBe(3);
      expect(branchEntries(doc).map((item) => item.id)).toEqual(['one', 'cli', 'two']);
    });

    it('refuses a jump larger than the CLI rows that could explain it', () => {
      expect(() =>
        decodeSession(jsonl(entry(1, 'one', null), cliRow('cli', 'one'), entry(4, 'two', 'cli')))
      ).toThrow(/non-consecutive seq/);
    });

    it('refuses a branch edge the CLI cannot explain', () => {
      // One row after the CLI's is forgiven; the lane is ours again after it.
      expect(() =>
        decodeSession(
          jsonl(
            entry(1, 'one', null),
            cliRow('cli', 'one'),
            entry(2, 'two', 'one'),
            entry(3, 'three', 'cli')
          )
        )
      ).toThrow(/entry does not chain to lane/);
    });
  });

  describe('session-02 · a torn tail the CLI has already completed', () => {
    const torn = (line: string) => `${jsonl(entry(1, 'one', null))}${line}`;

    it('truncates a fragment even once the CLI has added the newline it lacked', () => {
      const doc = decodeSession(`${torn('{"kind":"entry","seq":')}\n`);
      expect(doc.entries).toHaveLength(1);
      expect(doc.repair).toBe(jsonl(entry(1, 'one', null)));
    });

    it('refuses a complete final line that is simply invalid', () => {
      // Shape is the whole distinction: a line that ends in `}` is a row
      // somebody finished writing, and dropping it would be data loss.
      expect(() => decodeSession(`${torn('{"kind":"entry" "seq":2}')}\n`)).toThrow(
        /invalid JSON at line 3/
      );
    });
  });
});
