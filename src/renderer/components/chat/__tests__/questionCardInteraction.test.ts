// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { QuestionCard } from '../QuestionCard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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
    const checks = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    await click(checks[0]);
    await click(checks[1]);
    await click(checks[2]);
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
    expect(container.querySelector('[role="timer"]')?.textContent).toBe(
      '若 3 秒内未响应将自动拒绝'
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
