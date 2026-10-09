// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { FrozenPlanReview, PlanReviewCard } from '../PlanReviewCard';
import type { GoalBarView } from '../sessionPanelsModel';

/**
 * dsh-rebase decision 169 — the review card mounted: the plan collapsed to a
 * few lines and opened in place, the default goal on full auto, bypass
 * confirmed once more in place, keep planning only with feedback, the goal
 * choices off while a goal is unfinished, and closing hands the keyboard on.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));

const PLAN = '# Ship CSV export\n\n## Goal\n- CSV opens in Excel';
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
    plan: PLAN,
    callId: 'call-1',
    goalObjective: '# Ship CSV export\n\n## Goal\n- CSV opens in Excel',
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

async function mount(
  goal: GoalBarView | null = null,
  respond = vi.fn(async () => true),
  onClosed = vi.fn()
) {
  await act(async () =>
    root.render(createElement(PlanReviewCard, { block, goal, onRespond: respond, onClosed }))
  );
  return { respond, onClosed };
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

describe('the plan review card', () => {
  it('shows the plan collapsed, opens it in place, and approves the goal on full auto by default', async () => {
    const { respond } = await mount();
    const body = container.querySelector('[data-testid="plan-review-body"]');
    expect(body?.textContent).toContain('CSV opens in Excel');
    expect(body?.className).toContain('max-h-48');
    await click(button('Show the whole plan'));
    expect(body?.className).toContain('max-h-96');
    expect(radio('goal:auto').getAttribute('aria-checked')).toBe('true');
    await click(button('Confirm'));
    expect(respond).toHaveBeenCalledWith({ answers: { 'plan-review': 'goal:auto' } });
  });

  it('asks once more before bypass; Back returns to the choices', async () => {
    const { respond } = await mount();
    await click(radio('goal:bypass'));
    await click(button('Confirm'));
    expect(respond).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'nothing is asked again'
    );
    await click(button('Back'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click(button('Confirm'));
    await click(button('Confirm: run with all prompts bypassed'));
    expect(respond).toHaveBeenCalledWith({ answers: { 'plan-review': 'goal:bypass' } });
  });

  it('keeps planning only with feedback, and sends it', async () => {
    const { respond } = await mount();
    await click(radio('keep-planning'));
    expect(button('Confirm').disabled).toBe(true);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Split the parser first.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Confirm').disabled).toBe(false);
    await click(button('Confirm'));
    expect(respond).toHaveBeenCalledWith({
      answers: { 'plan-review': 'keep-planning' },
      response: 'Split the parser first.',
    });
  });

  it('turns the goal choices off while a goal is unfinished, and starts on running once', async () => {
    await mount({ state: 'paused' } as GoalBarView);
    expect(radio('goal:auto').hasAttribute('data-disabled')).toBe(true);
    expect(radio('goal:bypass').hasAttribute('data-disabled')).toBe(true);
    expect(radio('run:auto').hasAttribute('data-disabled')).toBe(false);
    expect(radio('run:auto').getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('This chat has an unfinished goal');
  });

  it('closing the review answers it with a cancel, then hands the keyboard on', async () => {
    const { respond, onClosed } = await mount();
    await click(button('Close the review and type a message'));
    expect(respond).toHaveBeenCalledWith({ cancel: true });
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('a failed answer unlocks the card again', async () => {
    const { respond, onClosed } = await mount(
      null,
      vi.fn(async () => false)
    );
    await click(button('Close the review and type a message'));
    expect(respond).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Could not send your answer');
    expect(button('Confirm').disabled).toBe(false);
  });

  it('frozen, it is one line saying what was chosen', async () => {
    await act(async () =>
      root.render(
        createElement(FrozenPlanReview, {
          block: {
            ...block,
            resolved: true,
            questionOutcome: 'answered',
            planReviewResult: { choice: 'goal:auto', goal: { set: false, reason: 'goal exists' } },
          },
        })
      )
    );
    expect(container.textContent).toContain('Plan review · approved: set as goal, full auto');
    expect(container.textContent).toContain('Goal not set: goal exists');
  });
});
