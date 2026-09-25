// @vitest-environment happy-dom
/**
 * T135 / decision 045 — the failure card's 「继续」, rendered.
 *
 * - it asks the composer to RETRY the failed turn (the intent names the
 *   prompt only as the fallback), never to resend it;
 * - it stays disabled until the failure has settled — the run's closing
 *   `idle` after `session.failed` — and says why, because until then the worker
 *   may still hold the turn and a retry would be refused;
 * - it is disabled again while a send for this session is in flight;
 * - a click that passes through the disabled button (it is
 *   `pointer-events: none`) must not become another action (decision 046
 *   rule 4). happy-dom applies no stylesheet, so the pass-through is
 *   reproduced by clicking the element under the button.
 */

import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { useContinueIntentStore } from '@/stores/continueIntent';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { FailureContinueButton } from '../FailureContinueButton';
import { MessageTimeline } from '../MessageTimeline';
import { CONTINUE_BLOCKED_IN_FLIGHT, CONTINUE_BLOCKED_UNSETTLED } from '../retryLastTurn';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

let seq = 0;
function push(event: Omit<RuntimeEvent, 'seq' | 'timestamp'>) {
  seq += 1;
  const stamped = { ...event, seq, timestamp: seq } as RuntimeEvent;
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), stamped),
  }));
}

const failed = () =>
  push({
    type: 'session.failed',
    sessionId: 's1',
    requestId: 'send-1',
    payload: { error: '503: gateway dropped the stream', errorCode: 'stop_error' },
  } as Omit<RuntimeEvent, 'seq' | 'timestamp'>);
const idle = () =>
  push({
    type: 'session.status',
    sessionId: 's1',
    requestId: 'send-1',
    payload: { status: 'idle' },
  } as Omit<RuntimeEvent, 'seq' | 'timestamp'>);

let root: Root | undefined;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  const status = () =>
    useChatSessionsStore.getState().sessions.find((session) => session.id === 's1')?.status ??
    'idle';
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, {
          sessionId: 's1',
          status: status(),
          thinkingEnabled: false,
        })
      )
    )
  );
}

function continueButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('[role="alert"] button')].find(
    (candidate) => candidate.textContent === 'Continue'
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', window);
  useContinueIntentStore.getState().clearContinue();
  useTurnSendStatusStore.setState({ status: null });
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 's1',
        status: 'running',
        updatedAt: 0,
      },
    ],
    messages: {
      s1: [
        {
          id: 'user-1',
          sessionId: 's1',
          role: 'user',
          blocks: [{ id: 'u', type: 'text', text: 'READ-THE-NOTES' }],
        },
        {
          id: 'asst-1',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ id: 'a', type: 'text', text: 'half an ans' }],
        },
      ],
    },
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the failure card’s Continue retries the failed turn (T135)', () => {
  it('is disabled until the failure has settled, and says why', async () => {
    failed();
    await render();
    const button = continueButton();
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    const wrapper = container.querySelector('[data-testid="failure-continue"]');
    expect(wrapper?.getAttribute('title')).toBe(CONTINUE_BLOCKED_UNSETTLED);

    // The click a real browser delivers under a `pointer-events: none` button.
    await act(async () => (wrapper as HTMLElement).click());
    expect(useContinueIntentStore.getState().pending).toBeNull();
  });

  it('once settled, publishes a retry naming the failed prompt — not a resend', async () => {
    failed();
    idle();
    // The card survives its closing idle (D1) — that is what it retries.
    expect(useChatSessionsStore.getState().sessions[0]).toMatchObject({
      status: 'failed',
      failureSettled: true,
    });
    await render();
    const button = continueButton();
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(useContinueIntentStore.getState().pending).toEqual({
      kind: 'retry',
      sessionId: 's1',
      messageId: 'user-1',
    });
  });

  it('is disabled again while a send for this session is in flight', async () => {
    failed();
    idle();
    useTurnSendStatusStore.getState().begin(
      {
        sessionId: 's1',
        phase: 'handshake',
        elapsedSeconds: 0,
        turnStartedAtMs: 0,
        budgetMs: 1000,
        attachmentCount: 0,
        attachmentBytes: 0,
        promptChars: 0,
      },
      'asst-1'
    );
    await render();
    expect(continueButton()?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="failure-continue"]')?.getAttribute('title')).toBe(
      CONTINUE_BLOCKED_IN_FLIGHT
    );
  });
});

describe('FailureContinueButton on its own', () => {
  it('keeps a click on a disabled button from reaching the card around it', async () => {
    const onContinue = vi.fn();
    const onCard = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(
          'div',
          { onClick: onCard },
          createElement(FailureContinueButton, {
            blockedReason: CONTINUE_BLOCKED_UNSETTLED,
            onContinue,
          })
        )
      )
    );
    const wrapper = container.querySelector('[data-testid="failure-continue"]') as HTMLElement;
    await act(async () => wrapper.click());
    await act(async () => (wrapper.querySelector('button') as HTMLButtonElement).click());
    expect(onContinue).not.toHaveBeenCalled();
    expect(onCard).not.toHaveBeenCalled();

    await act(async () =>
      root?.render(
        createElement(
          'div',
          { onClick: onCard },
          createElement(FailureContinueButton, { blockedReason: null, onContinue })
        )
      )
    );
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onCard).not.toHaveBeenCalled();
  });
});
