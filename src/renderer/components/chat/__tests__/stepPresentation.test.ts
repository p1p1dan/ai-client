import { translate, zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { TurnItem } from '../chatTurn';
import { PERMISSION_DENIED } from '../questionCardModel';
import {
  deriveTerminalStepResult,
  isRefusedStep,
  isSpecialStepRow,
  stepBulletStatus,
  stepLabel,
  terminalItemGutter,
  terminalSuppressedTails,
} from '../stepPresentation';
import type { ToolRowView } from '../toolCard';

/**
 * Decision 208, terminal style: the bullet, the English tool name and the `⎿`
 * lines, as pure functions of a step row (user ruling 2026-11-03).
 */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

function row(fields: Partial<ToolRowView>): ToolRowView {
  return { key: 'k1', verb: 'Ran', running: false, failed: false, expandable: true, ...fields };
}

const bash = (fields: Partial<ToolRowView> = {}) =>
  row({ toolName: 'bash', iconKind: 'terminal', arg: '检查三个 worktree 的未提交改动', ...fields });

describe('stepLabel: the tool in its own English name', () => {
  it('a shell call reads the same running, done and refused (the 终端 / 运行 split)', () => {
    expect(stepLabel(bash({ running: true, verb: 'Running' }))).toBe('Bash');
    expect(stepLabel(bash())).toBe('Bash');
    expect(stepLabel(bash({ verb: 'Run', outcome: 'refused' }))).toBe('Bash');
  });

  it.each([
    ['Bash', 'terminal', 'Bash'],
    ['pwsh', 'terminal', 'PowerShell'],
    ['PowerShell', 'tool', 'PowerShell'],
    ['Read', 'read', 'Read'],
    ['read', 'read', 'Read'],
    ['Grep', 'search', 'Search'],
    ['glob', 'search', 'Search'],
    ['ls', 'list', 'List'],
    ['Edit', 'edit', 'Edit'],
    ['edit', 'edit', 'Edit'],
    ['MultiEdit', 'edit', 'Edit'],
    ['Write', 'edit', 'Write'],
    ['WebFetch', 'web', 'Fetch'],
    ['WebSearch', 'web', 'Web Search'],
    ['mcp__github__create_issue', 'mcp', 'MCP'],
    ['word_read', 'read', 'Read'],
    ['job_output', 'job', 'job_output'],
  ] as const)('%s → %s', (toolName, iconKind, label) => {
    expect(stepLabel(row({ toolName, iconKind }))).toBe(label);
  });

  it('a merged step or a plugin title prints its own title', () => {
    expect(stepLabel(row({ title: '搜索了 2 处，读取了 5 个文件', verb: '' }))).toBe(
      '搜索了 2 处，读取了 5 个文件'
    );
  });

  it('is English for every kind a step can have (the caller must not translate it)', () => {
    for (const toolName of ['Bash', 'pwsh', 'read', 'Grep', 'ls', 'edit', 'Write', 'web_fetch']) {
      expect(stepLabel(row({ toolName }))).toMatch(/^[A-Za-z ]+$/);
    }
  });
});

describe('stepBulletStatus', () => {
  it.each([
    ['running', bash({ running: true }), 'running'],
    ['done', bash(), 'success'],
    ['failed', bash({ failed: true }), 'failed'],
    ['runtime refusal', bash({ outcome: 'refused' }), 'failed'],
    ['denied on the card', bash({ permissionVerb: PERMISSION_DENIED }), 'failed'],
    ['denied by the review', bash({ reviewDenied: true }), 'failed'],
    ['non-zero exit', bash({ exitCode: 1 }), 'failed'],
    ['zero exit', bash({ exitCode: 0 }), 'success'],
    ['not run', bash({ outcome: 'notStarted' }), 'stopped'],
    ['stopped', bash({ outcome: 'stopped' }), 'stopped'],
    ['outcome unknown', bash({ outcome: 'outcomeUnknown' }), 'stopped'],
  ] as const)('%s → %s', (_name, view, status) => {
    expect(stepBulletStatus(view)).toBe(status);
  });

  it('a refusal is refused, whichever gate said no', () => {
    expect(isRefusedStep(bash({ outcome: 'refused' }))).toBe(true);
    expect(isRefusedStep(bash({ reviewDenied: true }))).toBe(true);
    expect(isRefusedStep(bash({ permissionVerb: 'Denied, turn stopped' }))).toBe(true);
    expect(isRefusedStep(bash({ permissionVerb: 'Allowed' }))).toBe(false);
  });
});

describe('deriveTerminalStepResult', () => {
  const output = ['line 1', '', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');

  it('a settled command shows its last three lines and counts the rest', () => {
    expect(deriveTerminalStepResult(bash({ output }), zh)).toEqual({
      lines: ['line 3', 'line 4', 'line 5'],
      tone: 'muted',
      hidden: 2,
    });
  });

  it("leaves out Claude Code's cwd-reset note, which says nothing about the result", () => {
    const withNote = `${output}\nShell cwd was reset to C:\\work\\repo`;
    expect(deriveTerminalStepResult(bash({ output: withNote }), zh)).toEqual({
      lines: ['line 3', 'line 4', 'line 5'],
      tone: 'muted',
      hidden: 2,
    });
  });

  it('a non-zero exit turns the lines red', () => {
    expect(deriveTerminalStepResult(bash({ output, exitCode: 1 }), zh)?.tone).toBe('bad');
  });

  it('a failure shows the first lines of what it said, red', () => {
    expect(deriveTerminalStepResult(bash({ output, failed: true }), zh)).toEqual({
      lines: ['line 1', 'line 2', 'line 3'],
      tone: 'bad',
      hidden: 2,
    });
  });

  it('a refusal is one red line: the decision word and why', () => {
    expect(
      deriveTerminalStepResult(
        bash({ outcome: 'refused', reviewDenied: true, reviewNote: '安全审查服务出错' }),
        zh
      )
    ).toEqual({ lines: ['已拒绝 · 安全审查服务出错'], tone: 'bad', hidden: 0 });
    expect(
      deriveTerminalStepResult(bash({ permissionVerb: PERMISSION_DENIED }), zh)?.lines
    ).toEqual([zhTranslations[PERMISSION_DENIED]]);
  });

  it('running, not run and stopped calls get no line; an unknown outcome gets the warning', () => {
    expect(deriveTerminalStepResult(bash({ running: true, output }), zh)).toBeNull();
    expect(deriveTerminalStepResult(bash({ outcome: 'notStarted' }), zh)).toBeNull();
    expect(deriveTerminalStepResult(bash({ outcome: 'stopped', output }), zh)).toBeNull();
    expect(deriveTerminalStepResult(bash({ outcome: 'outcomeUnknown' }), zh)?.tone).toBe('unknown');
  });

  it('only commands preview output; a read or an edit has no line', () => {
    expect(
      deriveTerminalStepResult(row({ toolName: 'Read', iconKind: 'read', output }), zh)
    ).toBeNull();
  });

  it('a very long line is clipped', () => {
    const long = 'x'.repeat(1000);
    const [line] = deriveTerminalStepResult(bash({ output: long }), zh)?.lines ?? [];
    expect(line?.length).toBeLessThanOrEqual(400);
  });
});

describe('terminalSuppressedTails', () => {
  it('a refused step does not repeat its word on the step line', () => {
    expect(terminalSuppressedTails(bash({ outcome: 'refused', reviewDenied: true }))).toEqual({
      permission: true,
      outcome: true,
      review: true,
    });
    expect(terminalSuppressedTails(bash({ outcome: 'stopped' }))).toEqual({
      permission: false,
      outcome: false,
      review: false,
    });
  });
});

describe('isSpecialStepRow', () => {
  it('findings, a delegation lane and a todo list keep their own drawing', () => {
    expect(isSpecialStepRow(row({ findings: { findings: [] } as never }))).toBe(true);
    expect(isSpecialStepRow(row({ toolName: 'Task', toolCallId: 'c1' }))).toBe(true);
    expect(isSpecialStepRow(row({ iconKind: 'todo' }))).toBe(true);
    expect(isSpecialStepRow(bash())).toBe(false);
  });
});

describe('terminalItemGutter', () => {
  const text = {
    kind: 'text',
    block: { id: 'b', type: 'text', text: 'hi' },
    messageId: 'm',
  } as TurnItem;

  it('prose gets the text bullet; a tool group draws its own', () => {
    expect(terminalItemGutter(text)).toBe('text');
    expect(
      terminalItemGutter({ kind: 'toolGroup', entries: [], blockIndex: 0, messageId: 'm' })
    ).toBeNull();
  });

  it('an item that renders nothing here gets no wrapper', () => {
    const pending = {
      kind: 'permission',
      block: { id: 'p', type: 'permission', resolved: false },
      messageId: 'm',
    } as unknown as TurnItem;
    expect(terminalItemGutter(pending)).toBeNull();
  });
});
