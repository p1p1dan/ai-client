// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { SDK_PLAN_REVIEW_CHOICES } from '@shared/planReview';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { PlanReviewCard } from '../PlanReviewCard';
import { SDK_PLAN_REVIEW_BYPASS_CONFIRM, SDK_PLAN_REVIEW_BYPASS_WARNING } from '../planReviewModel';

/**
 * Route B, S-2 (topic s2-permission-modes.md A-7, §3.1 item 12): the review
 * card of a chat on the Claude Agent SDK engine, mounted with the real zh
 * translator. It shows the choices the card names (the modes to continue in, no
 * goals), starts on Edit automatically, and confirms Bypass permissions once
 * more in the engine's words.
 */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const block: ChatBlock = {
  id: 'q1',
  type: 'question',
  questionId: 'q1',
  resolved: false,
  questions: [{ id: 'plan-review', question: 'Ship CSV export', options: [] }],
  planReview: {
    kind: 'plan',
    source: 'exit_plan_mode',
    title: 'Ship CSV export',
    plan: '# Ship CSV export\n\n1. Write the exporter',
    callId: 'call-1',
    goalObjective: 'Ship CSV export',
    choices: [...SDK_PLAN_REVIEW_CHOICES],
  },
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(goal: Record<string, unknown> | null = null) {
  const respond = vi.fn(async () => true);
  await act(async () =>
    root.render(createElement(PlanReviewCard, { block, goal: goal as never, onRespond: respond }))
  );
  return respond;
}
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text
  ) as HTMLButtonElement;
const radio = (choice: string) =>
  container.querySelector<HTMLElement>(`[data-choice="${choice}"] [role="radio"]`) as HTMLElement;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};

describe('the plan review card of an SDK chat', () => {
  it('lists the modes to continue in, Edit automatically first, and no goal', async () => {
    const respond = await mount();
    const order = [...container.querySelectorAll('[data-choice]')].map((row) =>
      row.getAttribute('data-choice')
    );
    expect(order).toEqual([...SDK_PLAN_REVIEW_CHOICES]);
    expect(radio('run:accept-edits').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-choice="goal:auto"]')).toBeNull();
    expect(container.textContent).not.toContain(zh('Goal it would set'));
    expect(container.textContent).toContain('批准，用自动编辑继续');
    await click(button(zh('Confirm')));
    expect(respond).toHaveBeenCalledWith({ answers: { 'plan-review': 'run:accept-edits' } });
  });

  it('confirms Bypass permissions once more, in the engine words', async () => {
    const respond = await mount();
    await click(radio('run:bypass'));
    await click(button(zh('Confirm')));
    expect(respond).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"] p')?.textContent ?? '';
    expect(alert).toBe(zh(SDK_PLAN_REVIEW_BYPASS_WARNING));
    expect(alert).not.toContain('拒绝规则');
    await click(button(zh(SDK_PLAN_REVIEW_BYPASS_CONFIRM)));
    expect(respond).toHaveBeenCalledWith({ answers: { 'plan-review': 'run:bypass' } });
  });

  it('a goal on the goal bar takes nothing away: this card sets none', async () => {
    await mount({ state: 'paused', objective: 'x' });
    for (const row of container.querySelectorAll('[data-choice]')) {
      expect(row.getAttribute('data-disabled')).toBeNull();
    }
    expect(radio('run:accept-edits').getAttribute('aria-checked')).toBe('true');
  });
});
