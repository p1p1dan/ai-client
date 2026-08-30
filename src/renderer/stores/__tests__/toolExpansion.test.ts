import { beforeEach, describe, expect, it } from 'vitest';
import { deriveToolGroupRows, type ToolGroupEntry, type ToolRun } from '@/components/chat/toolCard';
import {
  EMPTY_TOOL_EXPAND_MEMORY,
  readToolExpandMemory,
  rememberToolExpansion,
  resolveToolRowOpen,
  useToolExpansionStore,
} from '../toolExpansion';

/**
 * T12-d — the tool-row expand memory.
 *
 * Two layers are asserted, and the second is not optional: the truth table
 * below can be entirely green while the rule it encodes never fires on a real
 * timeline, because the rows it is fed are hand-written. The final block
 * therefore drives `deriveToolGroupRows` — the actual derivation, with pi's
 * lowercase tool names — through the resolver and asserts on THAT.
 */

describe('resolveToolRowOpen — precedence', () => {
  it('an explicit remembered choice wins in both directions', () => {
    expect(resolveToolRowOpen({ key: 'a' }, { a: true })).toBe(true);
    // Against a `defaultOpen` that would otherwise open it: the live subagent
    // panel the user closed on purpose stays closed.
    expect(resolveToolRowOpen({ key: 'a', defaultOpen: true }, { a: false })).toBe(false);
  });

  it('falls back to defaultOpen when nothing is remembered', () => {
    expect(resolveToolRowOpen({ key: 'a', defaultOpen: true }, EMPTY_TOOL_EXPAND_MEMORY)).toBe(
      true
    );
    expect(resolveToolRowOpen({ key: 'a' }, EMPTY_TOOL_EXPAND_MEMORY)).toBe(false);
    // A memory belonging to OTHER rows must not leak into this one.
    expect(resolveToolRowOpen({ key: 'a' }, { b: true })).toBe(false);
  });

  it('opens a row that swallowed a child the user had open', () => {
    expect(
      resolveToolRowOpen({ key: 'agg', detail: [{ key: 'x' }, { key: 'y' }] }, { y: true })
    ).toBe(true);
  });

  it('a child the user CLOSED never forces its parent open', () => {
    // `=== true` and not truthiness: `false` is a recorded decision, not the
    // absence of one, and it must not read as "the user was interested".
    expect(resolveToolRowOpen({ key: 'agg', detail: [{ key: 'x' }] }, { x: false })).toBe(false);
  });

  it('closing the aggregate itself outranks its children', () => {
    // Otherwise the row could never be closed while a child stayed marked
    // open: it would spring back open on its next mount, forever.
    expect(
      resolveToolRowOpen({ key: 'agg', detail: [{ key: 'x' }] }, { agg: false, x: true })
    ).toBe(false);
  });

  it('is idempotent under its own output — reading twice cannot drift', () => {
    const target = { key: 'a', detail: [{ key: 'x' }] };
    const memory = { x: true };
    expect(resolveToolRowOpen(target, memory)).toBe(resolveToolRowOpen(target, memory));
  });
});

describe('rememberToolExpansion', () => {
  it('records without mutating the previous map', () => {
    const before = { a: true };
    const after = rememberToolExpansion(before, 'b', false);
    expect(after).toEqual({ a: true, b: false });
    expect(before).toEqual({ a: true });
  });

  it('overwrites an earlier answer for the same row', () => {
    expect(rememberToolExpansion({ a: true }, 'a', false)).toEqual({ a: false });
  });
});

describe('useToolExpansionStore — session scoping', () => {
  beforeEach(() => {
    useToolExpansionStore.setState({ bySession: {} });
  });

  it('keeps one session’s choices out of another’s', () => {
    useToolExpansionStore.getState().setToolRowExpanded('s1', 'block-a', true);
    expect(readToolExpandMemory('s1')).toEqual({ 'block-a': true });
    expect(readToolExpandMemory('s2')).toEqual({});
  });

  it('survives a switch away and back', () => {
    const store = useToolExpansionStore.getState();
    store.setToolRowExpanded('s1', 'block-a', true);
    store.setToolRowExpanded('s2', 'block-b', true);
    expect(readToolExpandMemory('s1')).toEqual({ 'block-a': true });
  });

  it('reads as empty with no session — the QuestionCard row has nothing to remember', () => {
    expect(readToolExpandMemory(null)).toEqual({});
    expect(readToolExpandMemory(undefined)).toEqual({});
  });
});

/**
 * The absorption case, driven through the real derivation.
 *
 * Sequence: the agent reads `a.ts`, the user opens that row to look at the
 * output, then the agent reads `b.ts`. At that point `deriveToolGroupRows`
 * folds BOTH reads into one aggregate — the row the user opened stops existing
 * at top level — so without the child rule the output they were reading
 * silently disappears behind a collapsed `Explored 2 files`.
 */
describe('absorption — the aggregate inherits its children’s open state', () => {
  function readEntry(id: string, path: string): ToolGroupEntry {
    const toolRun: ToolRun = {
      toolCallId: `call-${id}`,
      blockIndex: 0,
      blockId: `block-${id}`,
      // pi's lowercase name: with Claude's `Read` this classifies as unknown
      // and never aggregates at all (T12-b).
      toolName: 'read',
      input: { path },
      status: 'ok',
      output: `contents of ${path}`,
    };
    return { kind: 'run', run: toolRun };
  }

  it('folds two completed reads into one aggregate row (the precondition)', () => {
    const before = deriveToolGroupRows([readEntry('a', 'a.ts')]);
    expect(before.map((row) => row.key)).toEqual(['block-a']);

    const after = deriveToolGroupRows([readEntry('a', 'a.ts'), readEntry('b', 'b.ts')]);
    expect(after.map((row) => row.key)).toEqual(['block-a~agg']);
    expect(after[0].arg).toBe('2 files');
    // The row the user had open now exists only as a child of the aggregate.
    expect((after[0].detail ?? []).map((row) => row.key)).toEqual(['block-a', 'block-b']);
  });

  it('the aggregate mounts OPEN when it swallowed the row the user was reading', () => {
    const memory = { 'block-a': true };
    const rows = deriveToolGroupRows([readEntry('a', 'a.ts'), readEntry('b', 'b.ts')]);

    expect(resolveToolRowOpen(rows[0], memory)).toBe(true);
    // …and the child inside it is open too, or the aggregate would open onto
    // two collapsed rows and the output would still be off screen.
    const child = (rows[0].detail ?? []).find((row) => row.key === 'block-a');
    expect(child).toBeDefined();
    expect(resolveToolRowOpen(child as { key: string }, memory)).toBe(true);
  });

  it('stays closed when the user never opened either read', () => {
    const rows = deriveToolGroupRows([readEntry('a', 'a.ts'), readEntry('b', 'b.ts')]);
    expect(resolveToolRowOpen(rows[0], EMPTY_TOOL_EXPAND_MEMORY)).toBe(false);
  });

  /**
   * The reference implementation auto-expands the last N tools of a running
   * turn (`timeline-tool-expand-policy.ts`). That was deliberately NOT ported:
   * it reverses the 2026-08-25 user decision recorded in `ToolRows.tsx`. This
   * pins the consequence rather than the prose — a resolver that starts
   * opening rows on its own accord fails here.
   */
  it('never opens a row on its own accord', () => {
    const rows = deriveToolGroupRows([
      readEntry('a', 'a.ts'),
      readEntry('b', 'b.ts'),
      readEntry('c', 'c.ts'),
    ]);
    const everyRow = [...rows, ...(rows[0].detail ?? [])];
    for (const row of everyRow) {
      expect(
        resolveToolRowOpen(row, EMPTY_TOOL_EXPAND_MEMORY),
        `row ${row.key} opened itself`
      ).toBe(false);
    }
  });
});
