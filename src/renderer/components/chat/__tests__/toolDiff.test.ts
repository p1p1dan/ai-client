import { describe, expect, it } from 'vitest';
import { deriveToolRowView, PI_TOOL_NAMES, type ToolRun } from '../toolCard';
import { deriveToolDiff, lineDiffRows } from '../toolDiff';

/**
 * T12-b slice 2 — the diff behind an `edit`/`write` row.
 *
 * Before this, expanding the one tool call that CHANGES the user's files
 * showed the raw argument JSON: `oldText` and `newText` as escaped blobs.
 */

function kinds(rows: ReturnType<typeof lineDiffRows>) {
  return rows.map((row) => `${row.kind}:${row.text}`);
}

describe('lineDiffRows', () => {
  it('reports no change as all context', () => {
    expect(kinds(lineDiffRows('a\nb', 'a\nb'))).toEqual(['same:a', 'same:b']);
  });

  it('keeps an insertion an insertion instead of rewriting everything after it', () => {
    // The reason this is not a positional compare. A naive line-i-vs-line-i
    // diff calls EVERY line changed here; only one line was added.
    expect(kinds(lineDiffRows('a\nb\nc', 'x\na\nb\nc'))).toEqual([
      'add:x',
      'same:a',
      'same:b',
      'same:c',
    ]);
  });

  it('puts the deletion before the insertion in a replacement', () => {
    // So the pair reads "was X / now Y" rather than the reverse.
    expect(kinds(lineDiffRows('a\nOLD\nc', 'a\nNEW\nc'))).toEqual([
      'same:a',
      'del:OLD',
      'add:NEW',
      'same:c',
    ]);
  });

  it('treats an empty side as no lines, not as one blank line', () => {
    // `''.split('\n')` is `['']`, which would put a phantom blank line at the
    // top of every new file.
    expect(kinds(lineDiffRows('', 'a'))).toEqual(['add:a']);
    expect(kinds(lineDiffRows('a', ''))).toEqual(['del:a']);
    expect(lineDiffRows('', '')).toEqual([]);
  });

  it('handles a deletion in the middle', () => {
    expect(kinds(lineDiffRows('a\nb\nc', 'a\nc'))).toEqual(['same:a', 'del:b', 'same:c']);
  });
});

describe('deriveToolDiff', () => {
  function run(toolName: string, input: unknown) {
    return { toolName, input };
  }

  it('builds a diff from an edit call’s own arguments', () => {
    const diff = deriveToolDiff(
      run(PI_TOOL_NAMES.edit, {
        path: 'src/foo.ts',
        edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
      })
    );
    expect(diff?.path).toBe('src/foo.ts');
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
    expect(kinds(diff?.rows ?? [])).toEqual(['del:const a = 1;', 'add:const a = 2;']);
  });

  it('works before the tool has returned anything', () => {
    // Derived from arguments, not output — so a running call, and a DENIED
    // one, both still show what was going to happen.
    const diff = deriveToolDiff(
      run(PI_TOOL_NAMES.edit, { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })
    );
    expect(diff).not.toBeNull();
  });

  it('concatenates multiple hunks', () => {
    const diff = deriveToolDiff(
      run(PI_TOOL_NAMES.edit, {
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'b', newText: 'B' },
        ],
      })
    );
    expect(diff?.added).toBe(2);
    expect(diff?.removed).toBe(2);
  });

  it('accepts Claude’s field spelling too', () => {
    // An unrecognised spelling would render an all-insertions diff, which
    // looks like a plausible answer rather than a failure — so it would never
    // get reported.
    const diff = deriveToolDiff(
      run('Edit', { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] })
    );
    expect(diff?.removed).toBe(1);
    expect(diff?.added).toBe(1);
  });

  it('renders a write as all insertions', () => {
    const diff = deriveToolDiff(run(PI_TOOL_NAMES.write, { path: 'new.ts', content: 'a\nb' }));
    expect(diff?.removed).toBe(0);
    expect(kinds(diff?.rows ?? [])).toEqual(['add:a', 'add:b']);
  });

  it('returns null for tools that do not change files', () => {
    // `null` means "no better view than the default"; the row keeps its
    // existing raw body rather than showing an empty diff panel.
    expect(deriveToolDiff(run(PI_TOOL_NAMES.read, { path: 'a.ts' }))).toBeNull();
    expect(deriveToolDiff(run(PI_TOOL_NAMES.bash, { command: 'ls' }))).toBeNull();
    expect(deriveToolDiff(run(PI_TOOL_NAMES.grep, { pattern: 'x' }))).toBeNull();
  });

  it('returns null rather than an empty panel when the arguments are unusable', () => {
    expect(deriveToolDiff(run(PI_TOOL_NAMES.edit, { path: 'a.ts' }))).toBeNull();
    expect(deriveToolDiff(run(PI_TOOL_NAMES.edit, { edits: [] }))).toBeNull();
    expect(deriveToolDiff(run(PI_TOOL_NAMES.write, { path: 'a.ts' }))).toBeNull();
    expect(deriveToolDiff(run(PI_TOOL_NAMES.edit, 'not an object'))).toBeNull();
  });
});

/**
 * The row view has to actually carry the diff. Without these, the whole model
 * above could be correct and unreachable — nothing would render.
 */
describe('the tool row view carries the diff', () => {
  function editRun(overrides: Partial<ToolRun> = {}): ToolRun {
    return {
      toolCallId: 't1',
      blockIndex: 0,
      blockId: 'b1',
      toolName: PI_TOOL_NAMES.edit,
      input: { path: 'src/foo.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      status: 'ok',
      ...overrides,
    };
  }

  it('attaches the diff to a settled edit row', () => {
    expect(deriveToolRowView(editRun()).diff?.added).toBe(1);
  });

  it('drops the raw argument body when a diff is shown', () => {
    // They carry the same bytes. Showing both puts an escaped `oldText` blob
    // directly underneath the readable rendering of itself.
    const view = deriveToolRowView(editRun());
    expect(view.diff).toBeDefined();
    expect(view.input).toBeUndefined();
    expect(view.inputMaxHeightClass).toBeUndefined();
  });

  it('makes a diff-only row expandable', () => {
    // An `edit` whose call has no output would otherwise have nothing to
    // expand into, and the chevron would disappear along with the diff.
    const view = deriveToolRowView(editRun({ output: undefined }));
    expect(view.expandable).toBe(true);
  });

  it('withholds the diff while the call is still running', () => {
    // Same reason the raw input segment waits: arguments can still change, and
    // a diff that redraws mid-call reads as the file being edited twice.
    expect(deriveToolRowView(editRun({ status: 'running' })).diff).toBeUndefined();
  });

  it('leaves non-file tools with their ordinary body', () => {
    const view = deriveToolRowView(
      editRun({ toolName: PI_TOOL_NAMES.bash, input: { command: 'ls' }, output: 'a.ts' })
    );
    expect(view.diff).toBeUndefined();
    expect(view.body).toBe('output');
  });
});
