import { englishTranslate, translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { partitionStepRuns, summarizeStepRun } from '../stepRuns';
import type { ToolRowView } from '../toolCard';

/**
 * Decision 208, desktop style: each run of steps between two paragraphs is one
 * line that opens to the rows (user ruling 2026-11-03).
 */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

let seq = 0;
function row(fields: Partial<ToolRowView>): ToolRowView {
  seq += 1;
  return {
    key: `k${seq}`,
    verb: 'Ran',
    running: false,
    failed: false,
    expandable: true,
    ...fields,
  };
}
const bash = (fields: Partial<ToolRowView> = {}) =>
  row({ toolName: 'bash', iconKind: 'terminal', arg: '运行测试', ...fields });
const read = (path: string) => row({ toolName: 'Read', iconKind: 'read', arg: path });
const grep = () => row({ toolName: 'Grep', iconKind: 'search', arg: 'TODO' });
const edit = (path: string, added: number, removed: number) =>
  row({
    toolName: 'Edit',
    iconKind: 'edit',
    arg: path,
    link: { path },
    changeStat: { added, removed },
  });

describe('partitionStepRuns', () => {
  it('a special row cuts the run in two and stays outside', () => {
    const a = bash();
    const lane = row({ toolName: 'Task', toolCallId: 'c1', iconKind: 'delegate' });
    const b = bash();
    const entries = partitionStepRuns([a, lane, b]);
    expect(entries.map((entry) => entry.kind)).toEqual(['run', 'special', 'run']);
  });

  it('a run keeps its key when its first lookup is later merged', () => {
    const first = read('a.ts');
    const before = partitionStepRuns([first]);
    const merged: ToolRowView = {
      ...first,
      key: `lookup:${first.key}`,
      title: '读取了 2 个文件',
      detail: [first, read('b.ts')],
    };
    const after = partitionStepRuns([merged]);
    expect(after[0]?.kind === 'run' && after[0].key).toBe(
      before[0]?.kind === 'run' && before[0].key
    );
  });
});

describe('summarizeStepRun', () => {
  it('words a mixed run in the order commands, reads, searches, edits, tools', () => {
    const rows = [
      bash(),
      bash(),
      bash(),
      read('a.ts'),
      read('b.ts'),
      grep(),
      row({ toolName: 'mcp__x__y', iconKind: 'mcp' }),
    ];
    expect(summarizeStepRun(rows, zh).text).toBe(
      '运行了 3 条命令，读取了 2 个文件，搜索了 1 处，调用了 1 个工具'
    );
    expect(summarizeStepRun(rows, englishTranslate).text).toBe(
      'Ran 3 commands, read 2 files, searched 1 pattern, called 1 tool'
    );
  });

  it('counts the calls inside a merged step, and edits by file with their total change', () => {
    const one = read('a.ts');
    const two = read('b.ts');
    const merged: ToolRowView = {
      ...one,
      key: `lookup:${one.key}`,
      title: 'x',
      detail: [one, two],
    };
    const summary = summarizeStepRun(
      [merged, edit('a.ts', 3, 1), edit('a.ts', 2, 0), edit('b.ts', 1, 1)],
      zh
    );
    expect(summary.text).toBe('读取了 2 个文件，修改了 2 个文件');
    expect(summary.change).toEqual({ added: 6, removed: 2 });
  });

  it('one call is its own label and description', () => {
    const summary = summarizeStepRun([bash({ arg: '查看当前分支列表' })], zh);
    expect(summary.single).toEqual({ label: 'Bash', description: '查看当前分支列表' });
  });

  it('counts refusals and failures apart, and names the newest running call', () => {
    const running = bash({ running: true, arg: '删除残留目录' });
    const summary = summarizeStepRun(
      [bash({ outcome: 'refused' }), bash({ reviewDenied: true }), bash({ exitCode: 1 }), running],
      zh
    );
    expect(summary.refused).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.running).toBe(running);
    expect(translate('zh', '{{count}} refused', { count: 2 })).toBe('2 条被拒');
  });
});

/**
 * Decision 208 (user ruling 2026-11-03): thinking sits in its run, where it
 * happened. The run says it first, as the CLI's collapsed group does
 * (「Thought for 4s, read 2 files」); a run of only thinking is the desktop
 * app's 「思考了 N 秒 ›」.
 */
describe('summarizeStepRun with thinking', () => {
  const thought = (fields: Partial<ToolRowView> = {}) =>
    row({ verb: 'Thought', iconKind: 'thinking', body: 'thinking', output: '想一想', ...fields });

  it('says the thinking first, and counts no thought as a call', () => {
    const summary = summarizeStepRun(
      [thought({ thoughtMs: 3_000 }), bash(), thought({ thoughtMs: 1_000 }), read('a.ts')],
      zh
    );
    expect(summary.text).toBe('思考了 4 秒，运行了 1 条命令，读取了 1 个文件');
    expect(summary.thoughtOnly).toBeUndefined();
    expect(summary.single).toBeUndefined();
  });

  it('leaves unmeasured thinking unsaid beside calls (a reopened turn)', () => {
    expect(summarizeStepRun([thought(), bash()], zh).text).toBe('运行了 1 条命令');
  });

  it('a run of only thinking says so, measured or not', () => {
    const measured = summarizeStepRun([thought({ thoughtMs: 5_000 })], zh);
    expect(measured.text).toBe('思考了 5 秒');
    expect(measured.thoughtOnly).toBe(true);
    expect(summarizeStepRun([thought()], zh).text).toBe('思考');
    expect(summarizeStepRun([thought()], englishTranslate).text).toBe('Thought');
  });

  it('a thought still streaming is the run’s running step', () => {
    const live = thought({ running: true });
    const summary = summarizeStepRun([read('a.ts'), live], zh);
    expect(summary.running).toBe(live);
  });
});
