import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { ToolRowView } from '../toolCard';
import {
  deriveStepResult,
  deriveStepRows,
  lookupSummary,
  thoughtForText,
  thoughtWords,
} from '../turnSteps';

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

/**
 * Decision 208 (user ruling 2026-11-03): the terminal style merges only calls
 * next to each other, as the CLI and the comparison mockup's ① do, and thinking
 * is drawn where it happened — inside a merged step when it sat between two of
 * its calls, as the CLI's collapsed group takes it.
 */
describe('[D208-ADJACENT] the terminal style merges adjacent calls only', () => {
  const thought = (key: string, thoughtMs?: number) =>
    row(key, 'thinking', { verb: 'Thought', ...(thoughtMs === undefined ? {} : { thoughtMs }) });

  it('merges reads in a row, and a command between two reads keeps them apart', () => {
    const rows = [
      row('r1', 'read'),
      row('s1', 'search'),
      row('t1', 'terminal', { output: 'ok' }),
      row('r2', 'read'),
    ];
    const steps = deriveStepRows(rows, t, { merge: 'adjacent' });
    expect(steps.map((step) => step.key)).toEqual(['lookup:r1', 't1', 'r2']);
    expect(steps[0].title).toBe('Searched 1 pattern, read 1 file');
    // The stretch-wide rule (the desktop style's) would have taken r2 too.
    expect(deriveStepRows(rows, t).map((step) => step.key)).toEqual(['lookup:r1', 't1']);
  });

  it('merges edits in a row the same way, with their change summed', () => {
    const rows = [
      row('e1', 'edit', { arg: 'a.ts', changeStat: { added: 2, removed: 1 } }),
      row('e2', 'edit', { arg: 'b.ts', changeStat: { added: 3, removed: 0 } }),
      row('r1', 'read'),
      row('e3', 'edit', { arg: 'c.ts' }),
    ];
    const steps = deriveStepRows(rows, t, { merge: 'adjacent' });
    expect(steps.map((step) => step.key)).toEqual(['edits:e1', 'r1', 'e3']);
    expect(steps[0].title).toBe('Edited 2 files');
    expect(steps[0].changeStat).toEqual({ added: 5, removed: 1 });
  });

  it('takes the thinking between two reads into the step, and says it first', () => {
    const rows = [
      thought('th0', 2_000),
      row('r1', 'read'),
      thought('th1', 3_000),
      row('r2', 'read'),
      thought('th2', 4_000),
      row('t1', 'terminal', { output: 'ok' }),
    ];
    const steps = deriveStepRows(rows, t, { merge: 'adjacent' });
    // Before the first read and after the last: lines of their own.
    expect(steps.map((step) => step.key)).toEqual(['th0', 'lookup:r1', 'th2', 't1']);
    expect(steps[1].detail?.map((detail) => detail.key)).toEqual(['r1', 'th1', 'r2']);
    // The lead stays English (user ruling 2026-11-03), set apart from the counts.
    expect(steps[1].title).toBe('Thought for 3s · Read 2 files');
  });

  it('leaves the thinking unsaid in the title when nothing measured it', () => {
    const rows = [row('r1', 'read'), thought('th1'), row('r2', 'read')];
    const [step] = deriveStepRows(rows, t, { merge: 'adjacent' });
    expect(step.title).toBe('Read 2 files');
    expect(step.detail?.map((detail) => detail.key)).toEqual(['r1', 'th1', 'r2']);
  });

  it('keeps a lone read and the thinking after it as they are', () => {
    const rows = [row('r1', 'read'), thought('th1', 1_000), row('t1', 'terminal')];
    const steps = deriveStepRows(rows, t, { merge: 'adjacent' });
    expect(steps.map((step) => step.key)).toEqual(['r1', 'th1', 't1']);
  });
});

/**
 * User ruling 2026-11-03: a thought's words are English and never translated,
 * as the tool names are — `Thought for 12s`, as the CLI and the desktop app say.
 */
describe('[D208-THOUGHT] a thought row’s words', () => {
  it('says how long it thought, `Thinking…` while it does, and `Thought` when unmeasured', () => {
    expect(thoughtForText(12_400)).toBe('Thought for 12s');
    expect(thoughtForText(65_000)).toBe('Thought for 1m 5s');
    // Under a second still reads one, as the CLI's `Math.max(1, …)`.
    expect(thoughtForText(200)).toBe('Thought for 1s');
    expect(thoughtForText(undefined)).toBeNull();
    const base = row('th', 'thinking', { verb: 'Thought' });
    expect(thoughtWords({ ...base, thoughtMs: 3_000 })).toBe('Thought for 3s');
    expect(thoughtWords({ ...base, running: true })).toBe('Thinking…');
    expect(thoughtWords(base)).toBe('Thought');
  });

  it('sets the English lead apart from counts in the reader’s language', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    expect(lookupSummary({ search: 1, read: 2, list: 0 }, false, zh, 'Thought for 3s')).toBe(
      'Thought for 3s · 搜索了 1 处，读取了 2 个文件'
    );
  });
});
