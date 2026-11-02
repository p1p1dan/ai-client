import { describe, expect, it } from 'vitest';
import { APPROVAL_DIFF_MAX_ROWS, approvalFileDiff, literalEditsOf } from '../approvalDiff';

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
const FILE = `${lines(30)}\n`;

describe('[PILAB-R2-APPROVAL-DIFF] approvalFileDiff', () => {
  it('an edit is diffed against the file, with its real line numbers', () => {
    const edits = literalEditsOf({ old_string: 'line 15', new_string: 'changed' });
    const result = approvalFileDiff(
      'a.ts',
      { tool: 'edit', edits: edits ?? [] },
      { kind: 'text', text: FILE }
    );
    expect(result?.note).toBeUndefined();
    expect(result?.diff).toContain(
      '@@ -12,7 +12,7 @@\n line 12\n line 13\n line 14\n-line 15\n+changed\n'
    );
  });

  it('replace_all counts every match and shows each', () => {
    const text = 'a x\nb\nc x\n';
    const edits = literalEditsOf({ old_string: 'x', new_string: 'y', replace_all: true }) ?? [];
    const result = approvalFileDiff('a.ts', { tool: 'edit', edits }, { kind: 'text', text });
    expect(result?.replacements).toBe(2);
    expect(result?.diff).toContain('@@ -1,3 +1,3 @@\n-a x\n+a y\n b\n-c x\n+c y\n');
  });

  it('a MultiEdit applies its edits in order', () => {
    const edits =
      literalEditsOf({
        edits: [
          { old_string: 'line 2\n', new_string: 'two\n' },
          { old_string: 'line 29', new_string: 'twenty-nine' },
        ],
      }) ?? [];
    const result = approvalFileDiff('a.ts', { tool: 'edit', edits }, { kind: 'text', text: FILE });
    expect(result?.diff.match(/^@@ /gm)).toHaveLength(2);
    expect(result?.diff).toContain('+two\n');
    expect(result?.diff).toContain('+twenty-nine\n');
  });

  it('CRLF in the file or the arguments still matches, as the tools match', () => {
    const edits = literalEditsOf({ old_string: 'b\r\nc', new_string: 'B\r\nC' }) ?? [];
    const result = approvalFileDiff(
      'a.ts',
      { tool: 'edit', edits },
      { kind: 'text', text: 'a\r\nb\r\nc\r\n' }
    );
    expect(result?.note).toBeUndefined();
    expect(result?.diff).toContain('-b\n-c\n+B\n+C\n');
  });

  it('text not in the file falls back to the snippets, marked not-found', () => {
    const edits = literalEditsOf({ old_string: 'nope', new_string: 'yes' }) ?? [];
    const result = approvalFileDiff('a.ts', { tool: 'edit', edits }, { kind: 'text', text: FILE });
    expect(result).toEqual({
      diff: '--- a/a.ts\n+++ b/a.ts\n@@\n-nope\n+yes\n',
      note: 'not-found',
    });
  });

  it('two matches without replace_all is ambiguous, as the tools refuse it', () => {
    const edits = literalEditsOf({ old_string: 'x', new_string: 'y' }) ?? [];
    const result = approvalFileDiff(
      'a.ts',
      { tool: 'edit', edits },
      { kind: 'text', text: 'x\nx\n' }
    );
    expect(result?.note).toBe('ambiguous');
  });

  it('an unreadable or encrypted file falls back to the snippets, never to not-found', () => {
    const edits = literalEditsOf({ old_string: 'line 15', new_string: 'x' }) ?? [];
    for (const file of [
      { kind: 'unreadable' as const },
      { kind: 'text' as const, text: '%TSD-Header-###%\u0001\u0002' },
    ]) {
      expect(approvalFileDiff('a.ts', { tool: 'edit', edits }, file)?.note).toBe('unreadable');
    }
  });

  it('an edit of a missing file is no-file; an uncountable replace_all says so', () => {
    const edits = literalEditsOf({ old_string: 'a', new_string: 'b', replace_all: true }) ?? [];
    expect(approvalFileDiff('a.ts', { tool: 'edit', edits }, { kind: 'missing' })).toEqual({
      diff: '--- a/a.ts\n+++ b/a.ts\n@@\n-a\n+b\n',
      note: 'no-file',
      replaceAll: true,
    });
  });

  it('a write to a missing file creates it; over an existing one it is a diff', () => {
    const created = approvalFileDiff(
      'n.ts',
      { tool: 'write', content: 'a\nb\n' },
      { kind: 'missing' }
    );
    expect(created).toEqual({
      diff: '--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
      created: true,
    });
    const over = approvalFileDiff(
      'a.ts',
      { tool: 'write', content: FILE.replace('line 3\n', '') },
      { kind: 'text', text: FILE }
    );
    expect(over?.created).toBeUndefined();
    expect(over?.diff).toContain('-line 3\n');
  });

  it("Claude's Edit with an empty old_string on a missing file creates it", () => {
    const edits = literalEditsOf({ old_string: '', new_string: 'hello\n' }) ?? [];
    expect(approvalFileDiff('n.ts', { tool: 'edit', edits }, { kind: 'missing' })?.created).toBe(
      true
    );
  });

  it('a huge change keeps the first rows and says so', () => {
    const result = approvalFileDiff(
      'n.ts',
      { tool: 'write', content: `${lines(1000)}\n` },
      { kind: 'missing' }
    );
    expect(result?.truncated).toBe(true);
    expect(
      result?.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    ).toHaveLength(APPROVAL_DIFF_MAX_ROWS);
  });

  it('a write that changes nothing has no diff', () => {
    expect(
      approvalFileDiff('a.ts', { tool: 'write', content: FILE }, { kind: 'text', text: FILE })
    ).toBeUndefined();
  });
});

describe('[PILAB-R2-APPROVAL-DIFF] literalEditsOf', () => {
  it('reads one pair, a MultiEdit, and refuses incomplete pairs', () => {
    expect(literalEditsOf({ old_string: 'a', new_string: 'b' })).toEqual([
      { oldString: 'a', newString: 'b', replaceAll: false },
    ]);
    expect(
      literalEditsOf({ edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] })
    ).toEqual([{ oldString: 'a', newString: 'b', replaceAll: true }]);
    expect(literalEditsOf({ old_string: 'a' })).toBeNull();
    expect(literalEditsOf('x')).toBeNull();
  });
});
