// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { QuestionCard } from '../QuestionCard';

// The real English translator, not an identity stub: the card now passes
// params (`{{seconds}}`), and a stub that returned the key verbatim would make
// every interpolated assertion below vacuous.
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));
const block: ChatBlock = {
  id: 'q',
  type: 'question',
  questionId: 'q',
  questions: [
    {
      question: 'Long question '.repeat(20),
      options: [
        { label: 'Alpha '.repeat(25), description: 'Detailed description' },
        { label: 'Beta' },
      ],
    },
    { question: 'Choose many', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
  ],
};
it('supports selection, keyboard, multi-select, free input, failed submission and repeat protection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let finish: (value: boolean) => void = () => undefined;
  const submit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
  );
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'interactive',
          block,
          onSubmit: submit,
          onSkip: async () => true,
        })
      )
    );
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    await click(radios[0]);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      radios[0].focus();
      radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    // 2026-09-20: the card shows ONE question at a time behind a tab strip, so
    // the second question's rows are not in the DOM flow until its tab is
    // activated. Switching is by clicking the tab — the same path a user takes,
    // and the path that replaced the old `scrollIntoView` pager.
    const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs().length).toBe(2);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    // The ANSWERED question's tab carries its mark; the untouched one does not.
    expect(tabs()[0].querySelector('.lucide-check')).not.toBeNull();
    expect(tabs()[1].querySelector('.lucide-check')).toBeNull();
    expect(container.textContent).toContain('Unanswered: 1');
    await click(tabs()[1]);
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[0].getAttribute('aria-selected')).toBe('false');
    const checks = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    await click(checks[0]);
    await click(checks[1]);
    await click(checks[2]);
    // Both questions now hold an answer, and the two surfaces that report it
    // agree: the tab marks and the count beside the Continue button.
    expect(tabs()[0].querySelector('.lucide-check')).not.toBeNull();
    expect(tabs()[1].querySelector('.lucide-check')).not.toBeNull();
    expect(container.textContent).toContain('All questions answered');
    // Activating a tab moves focus to it, so the free-text input is reached the
    // way a keyboard user reaches it — after the tab that owns it.
    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Extra answer');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const continueButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Continue')
    )!;
    await click(continueButton);
    await click(continueButton);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Submitting');
    await act(async () => finish(false));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click(continueButton);
    expect(submit).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(continueButton.disabled).toBe(true);
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'frozen',
          block: {
            ...block,
            resolved: true,
            questionOutcome: 'answered',
            questionAnswers: { [block.questions![0].question]: 'Beta', 'Choose many': 'One, Two' },
          },
        })
      )
    );
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.textContent).toContain('Beta');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('counts down on the permission card and denies once at zero', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ now: 1_000_000 });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const respond = vi.fn(async () => true);
  const permission = {
    id: 'p',
    type: 'permission_request',
    permissionId: 'call-1',
    toolName: 'write',
    permissionKind: 'file_change',
    toolInput: { path: '/repo/a.txt', content: 'pong', workspace: '/repo' },
    permissionExpiresAt: 1_003_000,
  } as ChatBlock;
  try {
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'permission',
          block: permission,
          canRespond: true,
          onRespondPermission: respond,
        })
      )
    );
    // English because the test store carries no language; the Chinese wording
    // is the catalog's job now, and `i18nCoverage` is what holds the entry.
    expect(container.querySelector('[role="timer"]')?.textContent).toBe(
      'Denied automatically if unanswered within 3s'
    );
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(respond).toHaveBeenCalledExactlyOnceWith('deny');
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(respond).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

/**
 * D22 + D23 (batch E1 point-check, 2026-09-17).
 *
 * D22: `QuestionItem.header` is declared in the runtime contract and forwarded
 * by the `ask` tool, but no renderer drew it — a real run sent `header` and the
 * card showed nothing.
 *
 * D23: every title tier on both cards leaned on `font-medium` (500). Win10's
 * static Segoe UI family has no 500, and CSS Fonts 4 §5.2 falls DOWN to 400, so
 * the titles were pixel-identical to body text there. `docs/design-system.md`
 * assigns card / section titles to `font-semibold` and descriptions to
 * `font-normal`. Asserted as classes, not computed styles: happy-dom loads no
 * Tailwind stylesheet, so the class list is the only observable.
 */
it('renders the question header chip and words both cards in the semibold title tier', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const headerBlock: ChatBlock = {
    id: 'q-header',
    type: 'question',
    questionId: 'q-header',
    questions: [
      {
        question: 'Which store should the cache use?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'Relational, already deployed' },
          { label: 'SQLite' },
        ],
      },
    ],
  };
  const spansWith = (text: string) =>
    Array.from(container.querySelectorAll('span')).filter((el) => el.textContent === text);
  try {
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'interactive',
          block: headerBlock,
          onSubmit: async () => true,
          onSkip: async () => true,
        })
      )
    );
    // D22 — the chip exists, as its own element rather than glued to the text.
    const chip = spansWith('Storage')[0];
    expect(chip).toBeDefined();
    expect(chip.className).toContain('text-meta');
    expect(chip.textContent).toBe('Storage');

    // D23 — section head and question title.
    expect(spansWith('Questions')[0]?.className).toContain('font-semibold');
    const questionTitle = Array.from(container.querySelectorAll('div')).find(
      (el) => el.textContent === 'Which store should the cache use?'
    );
    expect(questionTitle?.className).toContain('font-semibold');
    expect(questionTitle?.className).not.toContain('font-medium');

    // D23 — the option description drops the button base class's 500.
    const description = spansWith('Relational, already deployed')[0];
    expect(description?.className).toContain('font-normal');

    // Reverse control: the fix is scoped. Option BUTTONS keep the button tier's
    // `font-medium` (design-system allows 500 on controls), so a global weight
    // sweep would fail here.
    const radio = container.querySelector<HTMLButtonElement>('[role="radio"]');
    expect(radio?.className).toContain('font-medium');
    expect(radio?.className).not.toContain('font-semibold');

    // Permission card — same two title tiers, different variant.
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'permission',
          block: {
            id: 'p-weight',
            type: 'permission_request',
            permissionId: 'call-weight',
            toolName: 'write',
            permissionKind: 'file_change',
            toolInput: { path: '/repo/a.txt', content: 'pong', workspace: '/repo' },
          } as ChatBlock,
          canRespond: true,
          onRespondPermission: async () => true,
        })
      )
    );
    expect(spansWith('Permission')[0]?.className).toContain('font-semibold');
    const permissionTitle = container.querySelector<HTMLParagraphElement>('p.text-ui');
    expect(permissionTitle).not.toBeNull();
    expect(permissionTitle?.className).toContain('font-semibold');
    expect(permissionTitle?.className).not.toContain('font-medium');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
