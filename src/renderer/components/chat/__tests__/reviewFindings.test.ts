import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { flattenTurnItems, segmentTurnBody } from '../chatTurn';
import {
  FINDING_LABEL_MAX_CHARS,
  FINDING_OUTCOME_LABEL,
  FINDING_VERDICT_LABEL,
  findingLabel,
  findingOpensAtFirst,
  findingTarget,
  isReviewFindingsGroup,
  REPORT_FINDINGS_TOOL,
  REVIEW_LEVEL_LABEL,
  readReviewFindings,
} from '../reviewFindings';
import {
  deriveToolRowView,
  groupTimeline,
  type ToolRun,
  toolIconKind,
  toolVerb,
} from '../toolCard';
import { splitTurnWorkGroup } from '../turnProcessFold';

// Route B S-6 feedback 1: ReportFindings, drawn as the review card.

const REPORT = {
  level: 'high',
  findings: [
    {
      file: 'src/pager.ts',
      line: 42,
      summary: 'The last page is dropped when the total is an exact multiple of the page size.',
      short_summary: 'Last page dropped on exact multiples',
      failure_scenario: 'total=20, pageSize=10: pages() returns 1 instead of 2.',
      category: 'correctness',
      verdict: 'CONFIRMED',
      outcome: 'fixed',
    },
    {
      file: 'src/cache.ts',
      summary: 'The session cache survives a logout.',
      failure_scenario: 'Log out, log in as another user: the first user’s data is served.',
    },
    {
      file: 'src/a.ts',
      line: 1,
      summary: 'Third.',
      failure_scenario: 'x',
      outcome: 'no_change_needed',
    },
  ],
};

function run(input: unknown, overrides: Partial<ToolRun> = {}): ToolRun {
  return {
    toolCallId: 'call-rf',
    blockIndex: 0,
    blockId: 'block-rf',
    toolName: REPORT_FINDINGS_TOOL,
    input,
    status: 'ok',
    output: '3 findings reported.',
    ...overrides,
  };
}

describe('readReviewFindings', () => {
  it('keeps the findings in the order the model gave them, and the level', () => {
    const report = readReviewFindings(REPORT);
    expect(report?.level).toBe('high');
    expect(report?.findings.map((f) => f.file)).toEqual([
      'src/pager.ts',
      'src/cache.ts',
      'src/a.ts',
    ]);
    expect(report?.findings[0]).toEqual({
      file: 'src/pager.ts',
      line: 42,
      summary: REPORT.findings[0].summary,
      shortSummary: 'Last page dropped on exact multiples',
      failureScenario: REPORT.findings[0].failure_scenario,
      category: 'correctness',
      verdict: 'CONFIRMED',
      outcome: 'fixed',
    });
  });

  it('an empty report is a report with no findings', () => {
    expect(readReviewFindings({ findings: [] })).toEqual({ findings: [] });
  });

  it('leaves out the optional fields a finding does not carry', () => {
    const finding = readReviewFindings(REPORT)?.findings[1];
    expect(finding).toEqual({
      file: 'src/cache.ts',
      summary: 'The session cache survives a logout.',
      failureScenario: REPORT.findings[1].failure_scenario,
    });
  });

  it('drops values outside the schema instead of showing them', () => {
    const report = readReviewFindings({
      level: 'extreme',
      findings: [
        { file: 'a.ts', line: 0, summary: 's', failure_scenario: 'f', verdict: 'MAYBE' },
        'not a finding',
        { file: 'b.ts', line: 2.5, summary: 's', failure_scenario: 'f', outcome: 'done' },
      ],
    });
    expect(report).toEqual({
      findings: [
        { file: 'a.ts', summary: 's', failureScenario: 'f' },
        { file: 'b.ts', summary: 's', failureScenario: 'f' },
      ],
    });
  });

  it('is nothing while the input streams, or for an input that is not a report', () => {
    expect(readReviewFindings({ __streaming: { bytes: 10, lines: 1 } })).toBeUndefined();
    expect(readReviewFindings({ findings: 'x' })).toBeUndefined();
    expect(readReviewFindings(undefined)).toBeUndefined();
  });
});

describe('a finding row', () => {
  const [first, second] = readReviewFindings(REPORT)?.findings ?? [];

  it('is labelled by its short summary, else by the summary cut to the same budget', () => {
    expect(findingLabel(first)).toBe('Last page dropped on exact multiples');
    expect(findingLabel(second)).toBe('The session cache survives a logout.');
    const long = { ...second, summary: 'word '.repeat(40) };
    expect([...findingLabel(long)]).toHaveLength(FINDING_LABEL_MAX_CHARS);
    expect(findingLabel(long).endsWith('…')).toBe(true);
  });

  it('points at its file and line, or its file alone', () => {
    expect(findingTarget(first)).toEqual({ path: 'src/pager.ts', line: 42 });
    expect(findingTarget(second)).toEqual({ path: 'src/cache.ts' });
    expect(findingTarget({ ...second, file: ' ' })).toBeUndefined();
  });

  it('a report of three opens whole; a longer one opens its first finding only', () => {
    expect([0, 1, 2].map((i) => findingOpensAtFirst(i, 3))).toEqual([true, true, true]);
    expect([0, 1, 2, 3].map((i) => findingOpensAtFirst(i, 4))).toEqual([true, false, false, false]);
  });

  it('says its level, verdict and outcome in the catalog’s words', () => {
    const words = [
      ...Object.values(REVIEW_LEVEL_LABEL),
      ...Object.values(FINDING_VERDICT_LABEL),
      ...Object.values(FINDING_OUTCOME_LABEL),
      'Reported review findings',
      'Reporting review findings',
      'Report review findings',
    ];
    expect(words.filter((word) => !(word in zhTranslations))).toEqual([]);
    expect(zhTranslations[FINDING_OUTCOME_LABEL.fixed]).toBe('已修复');
    expect(zhTranslations[FINDING_OUTCOME_LABEL.skipped]).toBe('已跳过');
    expect(zhTranslations[FINDING_OUTCOME_LABEL.no_change_needed]).toBe('无需修改');
  });
});

describe('the ReportFindings row view', () => {
  it('carries the report once the input is whole, live or settled', () => {
    expect(deriveToolRowView(run(REPORT)).findings?.findings).toHaveLength(3);
    expect(deriveToolRowView(run(REPORT, { status: 'running' })).findings).toBeDefined();
  });

  it('while the input streams it is a placeholder row: the verb, no argument, no body', () => {
    const view = deriveToolRowView(
      run({ __streaming: { bytes: 0, lines: 0 } }, { status: 'running', output: undefined })
    );
    expect(view.findings).toBeUndefined();
    expect(view.verb).toBe('Reporting review findings');
    expect(view.arg).toBeUndefined();
    expect(view.expandable).toBe(false);
    expect(view.iconKind).toBe('review');
  });

  it('a failed call stays an ordinary row with its error', () => {
    const view = deriveToolRowView(
      run(REPORT, { status: 'failed', errorText: 'InputValidationError', output: 'bad' })
    );
    expect(view.findings).toBeUndefined();
    expect(view.failed).toBe(true);
    expect(view.arg).toBe('3 found');
  });

  it('has verbs of its own and says how many it found', () => {
    expect(toolVerb(REPORT_FINDINGS_TOOL, 'done')).toBe('Reported review findings');
    expect(toolIconKind(REPORT_FINDINGS_TOOL)).toBe('review');
    expect(deriveToolRowView(run({ findings: [] })).arg).toBe('No issues found');
  });
});

let seq = 0;
function message(blocks: ChatBlock[]): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, sessionId: 's1', role: 'assistant', blocks };
}
function call(toolName: string, input: unknown, ok: boolean | null = true): ChatBlock[] {
  seq += 1;
  const id = `tc${seq}`;
  const blocks: ChatBlock[] = [
    { id: `${id}-call`, type: 'tool_call', toolCallId: id, toolName, toolInput: input },
  ];
  if (ok !== null) {
    blocks.push({ id: `${id}-result`, type: 'tool_result', toolCallId: id, toolOk: ok });
  }
  return blocks;
}
const text = (value: string): ChatBlock => {
  seq += 1;
  return { id: `t${seq}`, type: 'text', text: value };
};

describe('the review card in its turn', () => {
  it('a report is a tool group of its own, even between calls of the same message', () => {
    const items = groupTimeline(
      message([...call('Read', {}), ...call(REPORT_FINDINGS_TOOL, REPORT), ...call('Grep', {})])
    );
    expect(items.map((item) => (item.kind === 'toolGroup' ? item.entries.length : 0))).toEqual([
      1, 1, 1,
    ]);
    expect(items.map((item) => isReviewFindingsGroup(item))).toEqual([false, true, false]);
  });

  it('is never merged into the calls around it, and sits with the answer', () => {
    const body = [
      message([...call('Read', {})]),
      message([...call(REPORT_FINDINGS_TOOL, REPORT)]),
      message([...call('Grep', {})]),
    ];
    const items = flattenTurnItems({ id: 'u', user: null, body });
    expect(items).toHaveLength(3);
    expect(segmentTurnBody(items).map((s) => s.kind)).toEqual(['process', 'answer', 'process']);
  });

  it('once the turn settles, the card and the closing words are the final output', () => {
    const body = [
      message([text('Reviewing.'), ...call('Read', {}), ...call('Grep', {})]),
      message([...call(REPORT_FINDINGS_TOOL, REPORT)]),
      message([text('Three findings, above.')]),
    ];
    const segments = segmentTurnBody(flattenTurnItems({ id: 'u', user: null, body }));
    const sections = splitTurnWorkGroup(segments, true);
    expect(sections.map((s) => s.kind)).toEqual(['processGroup', 'finalAnswer']);
    const final = sections[1];
    expect(final.kind === 'finalAnswer' && final.segment.items.map((i) => i.kind)).toEqual([
      'toolGroup',
      'text',
    ]);
  });

  it('a failed report folds with the work like any failed call', () => {
    const body = [message([...call('Read', {}), ...call(REPORT_FINDINGS_TOOL, REPORT, false)])];
    const items = flattenTurnItems({ id: 'u', user: null, body });
    expect(items).toHaveLength(1);
    expect(segmentTurnBody(items).map((s) => s.kind)).toEqual(['process']);
  });
});
