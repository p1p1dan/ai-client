// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { REPORT_FINDINGS_TOOL } from '../reviewFindings';
import { ToolGroup } from '../ToolRows';
import { deriveToolRowView, type ToolRun } from '../toolCard';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('zh', key, params),
  }),
}));

// Route B S-6 feedback 1: the review card a ReportFindings call is drawn as.

function finding(index: number, extra: Record<string, unknown> = {}) {
  return {
    file: `src/dir/file${index}.ts`,
    line: index + 10,
    summary: `Summary ${index}.`,
    failure_scenario: `Scenario ${index}.`,
    ...extra,
  };
}

function rows(input: unknown, status: ToolRun['status'] = 'ok') {
  return [
    deriveToolRowView({
      toolCallId: 'call-rf',
      blockIndex: 0,
      blockId: 'block-rf',
      toolName: REPORT_FINDINGS_TOOL,
      input,
      status,
    }),
  ];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (input: unknown, status?: ToolRun['status']) =>
  act(async () => root.render(createElement(ToolGroup, { rows: rows(input, status) })));
const card = () => container.querySelector('[data-testid="review-findings-card"]');
const findingRows = () => [...container.querySelectorAll('[data-slot="review-finding"]')];
const scenarios = () =>
  [...container.querySelectorAll('[data-slot="review-finding-scenario"]')].map(
    (node) => node.textContent
  );

describe('the review card', () => {
  it('replaces the tool row: a head with the count and depth, a row per finding', async () => {
    await render({
      level: 'high',
      findings: [
        finding(1, {
          short_summary: 'Short one',
          category: 'correctness',
          verdict: 'CONFIRMED',
          outcome: 'fixed',
        }),
        finding(2),
      ],
    });
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain('审查结果');
    expect(card()?.textContent).toContain('发现 2 项');
    expect(card()?.textContent).toContain('审查力度：高');
    expect(container.textContent).not.toContain('已报告审查结果');
    const [first, second] = findingRows();
    expect(first.textContent).toContain('Short one');
    expect(first.textContent).toContain('file1.ts:11');
    expect(first.textContent).toContain('correctness');
    expect(first.textContent).toContain('已核实');
    expect(first.textContent).toContain('已修复');
    // No short summary: the summary itself is the label.
    expect(second.textContent).toContain('Summary 2.');
  });

  it('says so when the review found nothing', async () => {
    await render({ findings: [] });
    expect(card()?.textContent).toContain('未发现问题');
    expect(findingRows()).toHaveLength(0);
  });

  it('a click on a finding’s place opens the file at its line', async () => {
    await render({ findings: [finding(1)] });
    const link = card()?.querySelector<HTMLButtonElement>('button[title="src/dir/file1.ts:11"]');
    await act(async () => link?.click());
    expect(useFileOpenIntentStore.getState().intent).toMatchObject({
      path: 'src/dir/file1.ts',
      line: 11,
      source: 'tool-row',
    });
  });

  it('a short report opens whole; a finding folds and opens on a click', async () => {
    await render({ findings: [finding(1), finding(2), finding(3)] });
    expect(scenarios()).toEqual([
      '出错场景 · Scenario 1.',
      '出错场景 · Scenario 2.',
      '出错场景 · Scenario 3.',
    ]);
    const trigger = () =>
      findingRows()[1].querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
    await act(async () => trigger()?.click());
    expect(scenarios()).toEqual(['出错场景 · Scenario 1.', '出错场景 · Scenario 3.']);
    await act(async () => trigger()?.click());
    expect(scenarios()).toHaveLength(3);
  });

  it('a longer report opens its first finding only', async () => {
    await render({ findings: [1, 2, 3, 4, 5].map((i) => finding(i)) });
    expect(findingRows()).toHaveLength(5);
    expect(scenarios()).toEqual(['出错场景 · Scenario 1.']);
    const last = findingRows()[4].querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
    await act(async () => last?.click());
    expect(scenarios()).toEqual(['出错场景 · Scenario 1.', '出错场景 · Scenario 5.']);
  });

  it('while the report streams, one placeholder row and no half-drawn card', async () => {
    await render({ __streaming: { bytes: 120, lines: 3 } }, 'running');
    expect(card()).toBeNull();
    expect(container.textContent).toBe('报告审查结果中');
  });
});
