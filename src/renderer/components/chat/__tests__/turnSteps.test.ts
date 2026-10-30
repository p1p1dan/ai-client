import { describe, expect, it } from 'vitest';
import type { ToolRowView } from '../toolCard';
import { deriveStepResult, deriveStepRows, lookupSummary } from '../turnSteps';

const t = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));

function row(key: string, iconKind: string, extra: Partial<ToolRowView> = {}): ToolRowView {
  return {
    key,
    verb: 'Ran',
    iconKind: iconKind as ToolRowView['iconKind'],
    running: false,
    failed: false,
    expandable: false,
    ...extra,
  };
}

describe('[PILAB-R1-STEPS] the turn as steps (user ruling 2026-10-30)', () => {
  it('words lookups as Claude Code does, past and running', () => {
    expect(lookupSummary({ search: 2, read: 5, list: 0 }, false, t)).toBe(
      'Searched 2 patterns, read 5 files'
    );
    expect(lookupSummary({ search: 0, read: 1, list: 1 }, true, t)).toBe(
      'Reading 1 file, listing 1 directory…'
    );
  });

  it('merges a stretch’s lookups and edits even when interleaved, each at its first call', () => {
    const rows = [
      row('r1', 'read'),
      row('e1', 'edit', { arg: 'a.ts', diff: { added: 1, removed: 1 } as never }),
      row('r2', 'read'),
      row('t1', 'terminal', { output: 'ok' }),
      row('e2', 'edit', { arg: 'b.ts', changeStat: { added: 3, removed: 0 } }),
      row('s1', 'search'),
    ];
    const steps = deriveStepRows(rows, t);
    expect(steps.map((step) => step.key)).toEqual(['lookup:r1', 'edits:e1', 't1']);
    expect(steps[0].title).toBe('Searched 1 pattern, read 2 files');
    expect(steps[0].detail?.map((detail) => detail.key)).toEqual(['r1', 'r2', 's1']);
    expect(steps[1].title).toBe('Edited 2 files');
    expect(steps[1].changeStat).toEqual({ added: 4, removed: 1 });
  });

  it('keeps a call that needs its own line out of the merge', () => {
    const rows = [
      row('r1', 'read'),
      row('r2', 'read', { failed: true, output: 'ENOENT: no such file' }),
      row('r3', 'read', { permissionVerb: 'Denied' }),
      row('r4', 'read'),
    ];
    const steps = deriveStepRows(rows, t);
    expect(steps.map((step) => step.key)).toEqual(['lookup:r1', 'r2', 'r3']);
    expect(steps[1].resultLine).toEqual({ text: 'ENOENT: no such file', tone: 'bad' });
  });

  it('leaves a single lookup or a single edit as itself', () => {
    const steps = deriveStepRows([row('r1', 'read'), row('e1', 'edit')], t);
    expect(steps.map((step) => step.key)).toEqual(['r1', 'e1']);
  });

  it('gives a command its last output line, red on a non-zero exit, and drops placeholders', () => {
    expect(deriveStepResult(row('t', 'terminal', { output: 'a\n\n✓ 38 passed\n' }), t)).toEqual({
      text: '✓ 38 passed · {{count}} lines'.replace('{{count}}', '2'),
      tone: 'muted',
    });
    expect(deriveStepResult(row('t', 'terminal', { output: 'boom', exitCode: 1 }), t)?.tone).toBe(
      'bad'
    );
    expect(deriveStepResult(row('t', 'terminal', { output: '(no output)' }), t)).toBeNull();
    expect(
      deriveStepResult(row('t', 'terminal', { output: '(Omitted 14376 bytes. Full … /tmp/x)' }), t)
        ?.text
    ).toBe('Large output, open the step to see it');
  });

  it('says an unknown outcome as a warning, and nothing while running', () => {
    expect(deriveStepResult(row('t', 'terminal', { outcome: 'outcomeUnknown' }), t)?.tone).toBe(
      'unknown'
    );
    expect(deriveStepResult(row('t', 'terminal', { running: true, output: 'x' }), t)).toBeNull();
  });
});
