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
/** Put a raw line into a finished file at `at` (1-based), as a crash would. */
const splice = (content: string, at: number, line: string) => {
  const lines = content.split('\n');
  lines.splice(at - 1, 0, line);
  return lines.join('\n');
};

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

  describe('session-02 · a row in the middle that no reader can parse', () => {
    const wrecked = '{"kind":"record","type":"usage"';

    it('drops it, keeps the conversation, and states what the rewrite removes', () => {
      // T034 / decision 006. Refusing this file cost the user every turn in it,
      // while `pi --session` opened the same file without complaint.
      const intact = jsonl(entry(1, 'one', null), entry(2, 'two', 'one'));
      const doc = decodeSession(splice(intact, 3, wrecked));
      expect(doc.entries.map((item) => item.id)).toEqual(['one', 'two']);
      expect(doc.skipped).toEqual([{ line: 3, preview: wrecked }]);
      // The rewrite is the file minus that line, so the next open reads back
      // exactly what this decode just produced.
      expect(doc.repair).toBe(intact);
    });

    it('forgives the one seq number a dropped row of ours took with it', () => {
      const doc = decodeSession(
        splice(jsonl(entry(1, 'one', null), entry(3, 'three', 'one')), 3, '{"kind":"entry","seq":2')
      );
      expect(doc.seq).toBe(3);
      expect(doc.entries.map((item) => item.id)).toEqual(['one', 'three']);
    });

    it('names the dropped line when the chain that line held together breaks', () => {
      // Deliberately still a refusal: pi treats an orphan as a root and just
      // truncates the branch there, but matching that would mean rewriting a
      // row we CAN read, and a heal that silently re-roots a conversation is a
      // worse trade than a refusal that says which line to look at.
      expect(() =>
        decodeSession(
          splice(
            jsonl(entry(1, 'one', null), entry(3, 'three', 'two')),
            3,
            '{"kind":"entry","seq":2,"id":"two"'
          )
        )
      ).toThrow(/missing parent; line 3 was skipped as unparseable/);
    });

    it('cuts a torn tail and a dropped middle row in the same rewrite', () => {
      // The two repairs share one output, so getting either one wrong shows up
      // as a file that does not read back the way this decode just did.
      const intact = jsonl(entry(1, 'one', null), entry(2, 'two', 'one'));
      const doc = decodeSession(splice(`${intact}{"kind":"entry","seq":`, 3, wrecked));
      expect(doc.entries.map((item) => item.id)).toEqual(['one', 'two']);
      expect(doc.skipped).toEqual([{ line: 3, preview: wrecked }]);
      expect(doc.repair).toBe(intact);
    });

    it('leaves the last row under the tail rule, dropped middle rows or not', () => {
      // Only the middle is salvaged this way. At the tail we are still the
      // writer who could be mid-append, and T003's shape check owns that call.
      expect(() =>
        decodeSession(
          splice(`${jsonl(entry(1, 'one', null))}{"kind":"entry" "seq":2}\n`, 3, wrecked)
        )
      ).toThrow(/invalid JSON at line 4/);
    });

    it('refuses a file that is damage all the way down, and leaves it alone', () => {
      // A bound, not a policy: a body that is not JSONL at all would otherwise
      // be "repaired" one line at a time, holding a preview of each in memory.
      const junk = Array.from({ length: 65 }, () => wrecked);
      expect(() =>
        decodeSession(
          `${JSON.stringify(header)}\n${junk.join('\n')}\n${JSON.stringify(entry(1, 'one', null))}\n`
        )
      ).toThrow(/more than 64 unparseable rows, first at line 2/);
    });

    it('passes over a blank line without calling the file damaged', () => {
      // Both readers ignore blank lines, so there is nothing to report and
      // nothing to rewrite — a repair notice here would be a false alarm.
      const doc = decodeSession(
        splice(jsonl(entry(1, 'one', null), entry(2, 'two', 'one')), 3, '')
      );
      expect(doc.entries).toHaveLength(2);
      expect(doc.skipped).toBeUndefined();
      expect(doc.repair).toBeUndefined();
    });

    it('drops a row that parses but fails validation only when it is unparseable', () => {
      // The boundary decision 006 draws: `pi --session` KEEPS a row that is
      // valid JSON, so dropping one would make the two readers disagree about a
      // line that is completely present on disk.
      expect(() =>
        decodeSession(
          splice(
            jsonl(entry(1, 'one', null), entry(2, 'two', 'one')),
            3,
            '{"kind":"entry","seq":2,"id":"","parentId":null,"timestamp":2}'
          )
        )
      ).toThrow(/invalid entry identity/);
    });
  });
});
