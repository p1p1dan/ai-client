// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { QuestionCard } from '../QuestionCard';
import { QuestionPrompt } from '../QuestionPrompt';

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
const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!
  .set!;

type Handler = () => Promise<boolean>;

function renderPrompt(
  target: ChatBlock,
  handlers: {
    onSubmit?: (payload: { answers: Record<string, string> }) => Promise<boolean>;
    onChatAbout?: (payload: { response: string }) => Promise<boolean>;
    onSkip?: Handler;
  } = {}
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    block: target,
    onSubmit: handlers.onSubmit ?? (async () => true),
    onChatAbout: handlers.onChatAbout ?? (async () => true),
    onSkip: handlers.onSkip ?? (async () => true),
  };
  return {
    container,
    mount: () => act(async () => root.render(createElement(QuestionPrompt, props))),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

const buttons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
const buttonWith = (container: HTMLElement, text: string) =>
  buttons(container).find((button) => button.textContent?.includes(text));
const tabs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const selectedTab = (container: HTMLElement) =>
  tabs(container).findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
const click = (el: HTMLElement | undefined) => act(async () => el?.click());

it('picks without moving on; the primary button walks next → review → submit', async () => {
  let finish: (value: boolean) => void = () => undefined;
  const onSubmit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
  );
  const view = renderPrompt(block, { onSubmit });
  const { container } = view;
  try {
    await view.mount();
    expect(buttonWith(container, 'Next question')?.disabled).toBe(true);
    const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    await click(radios[1]);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    // Picking does not move the card.
    expect(selectedTab(container)).toBe(0);
    expect(tabs(container)[0].querySelector('.lucide-check')).not.toBeNull();
    await click(buttonWith(container, 'Next question'));
    expect(selectedTab(container)).toBe(1);

    // Last question: the button leads to the confirmation page, not to submit.
    expect(buttonWith(container, 'Review answers')?.disabled).toBe(true);
    const checks = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    await click(checks[0]);
    await click(checks[2]);
    const other = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      textareaSetter.call(other, 'Extra answer');
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Shift+Enter is a newline; plain Enter presses the primary button.
    await act(async () => {
      other.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
      );
    });
    expect(selectedTab(container)).toBe(1);
    await act(async () => {
      other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(selectedTab(container)).toBe(2);
    expect(container.textContent).toContain('Check your answers');
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('One、Other: Extra answer');

    // A confirmation row goes back to its question.
    await click(buttons(container).find((button) => button.textContent?.startsWith('Q1Long')));
    expect(selectedTab(container)).toBe(0);
    await click(tabs(container)[2]);

    const submit = buttonWith(container, 'Submit')!;
    await click(submit);
    await click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      answers: { [block.questions![0].question]: 'Beta', 'Choose many': 'One, Extra answer' },
    });
    expect(container.textContent).toContain('Submitting');
    await act(async () => finish(false));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(submit.disabled).toBe(true);
  } finally {
    await view.cleanup();
  }
});

it('a single question has no tabs, submits directly, and letter keys pick options', async () => {
  const onSubmit = vi.fn(async () => true);
  const single: ChatBlock = {
    id: 'one',
    type: 'question',
    questionId: 'one',
    questions: [{ question: 'Pick', options: [{ label: 'Red' }, { label: 'Blue' }] }],
  };
  const view = renderPrompt(single, { onSubmit });
  const { container } = view;
  try {
    await view.mount();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    const card = container.querySelector<HTMLElement>('[data-testid="question-prompt"]')!;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    expect(container.querySelectorAll('[role="radio"]')[1].getAttribute('aria-checked')).toBe(
      'true'
    );
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith({ answers: { Pick: 'Blue' } });
  } finally {
    await view.cleanup();
  }
});

it('Chat about this sends the discuss sentence from any page; Skip all sends a cancel', async () => {
  const onChatAbout = vi.fn(async () => true);
  const view = renderPrompt(block, { onChatAbout });
  try {
    await view.mount();
    await click(tabs(view.container)[2]);
    await click(buttonWith(view.container, 'Chat about this'));
    expect(onChatAbout).toHaveBeenCalledWith({ response: 'Further discuss these issues' });
  } finally {
    await view.cleanup();
  }
  const onSkip = vi.fn(async () => true);
  const again = renderPrompt(block, { onSkip });
  try {
    await again.mount();
    await click(buttonWith(again.container, 'Skip all'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  } finally {
    await again.cleanup();
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
        createElement(QuestionPrompt, {
          block: headerBlock,
          onSubmit: async () => true,
          onChatAbout: async () => true,
          onSkip: async () => true,
        })
      )
    );
    // D22 — the chip exists, as its own element rather than glued to the text.
    const chip = spansWith('Storage')[0];
    expect(chip).toBeDefined();
    expect(chip.className).toContain('text-meta');
    expect(chip.textContent).toBe('Storage');

    // D23 — the question title. The chip shares its line, so the title is
    // its own span.
    const questionTitle = spansWith('Which store should the cache use?')[0];
    expect(questionTitle?.className).toContain('font-semibold');
    expect(questionTitle?.className).not.toContain('font-medium');

    // D23 — the option description drops the button base class's 500.
    const description = spansWith('Relational, already deployed')[0];
    expect(description?.className).toContain('font-normal');

    // Option rows are body text, not the title tier.
    const radio = container.querySelector<HTMLButtonElement>('[role="radio"]');
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
