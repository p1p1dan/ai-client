// @vitest-environment happy-dom
/**
 * decision 040 — the renderer half of the turn-ceiling pause.
 *
 * The runtime now ends a run that reaches the ceiling as `session.completed`
 * with `stopCause: 'turn_limit'`, after a tool-less wrap-up turn. What this file
 * pins is that the page says so without calling it a failure:
 *
 * - the store keeps the cause from that completion until the next run starts;
 * - the timeline draws the neutral notice (not the red failed card) while idle;
 * - its Continue asks the composer to CARRY ON — a plain "continue" — and never
 *   to resend the original prompt, which would restart the whole task.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { englishTranslate, zhTranslations } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { useContinueIntentStore } from '@/stores/continueIntent';
import { MessageTimeline } from '../MessageTimeline';
import { stripComments } from './stripComments';

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

const NOTICE_TITLE = 'Paused at the turn ceiling';

/** Push a real event through the real reducer. */
function push(event: RuntimeEvent) {
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), event),
  }));
}

const completed = (payload: { stopCause?: 'turn_limit' } = {}): RuntimeEvent => ({
  type: 'session.completed',
  seq: 1,
  timestamp: 1,
  sessionId: 's1',
  payload,
});

const stopCause = () =>
  useChatSessionsStore.getState().sessions.find((session) => session.id === 's1')?.stopCause;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', window);
  useContinueIntentStore.getState().clearContinue();
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
          blocks: [{ id: 'u', type: 'text', text: 'REFACTOR-EVERYTHING' }],
        },
        {
          id: 'asst-1',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ id: 'a', type: 'text', text: 'SUMMARY: halfway there.' }],
        },
      ],
    },
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the store keeps the cause of a paused completion', () => {
  it('records turn_limit from session.completed, and nothing from a plain one', () => {
    push(completed());
    expect(stopCause()).toBeUndefined();
    push(completed({ stopCause: 'turn_limit' }));
    expect(stopCause()).toBe('turn_limit');
  });

  it('clears it as soon as the next run starts', () => {
    push(completed({ stopCause: 'turn_limit' }));
    push({
      type: 'session.status',
      seq: 2,
      timestamp: 2,
      sessionId: 's1',
      payload: { status: 'starting' },
    });
    expect(stopCause()).toBeUndefined();
  });

  it('clears it on a failure or a Stop', () => {
    for (const type of ['session.failed', 'session.stopped'] as const) {
      push(completed({ stopCause: 'turn_limit' }));
      push({ type, seq: 3, timestamp: 3, sessionId: 's1', payload: {} });
      expect(stopCause(), type).toBeUndefined();
    }
  });
});

describe('the timeline draws a pause, not a failure', () => {
  async function render(status: 'idle' | 'running') {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient();
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, { sessionId: 's1', status, thinkingEnabled: false })
        )
      )
    );
    return { container, root };
  }

  it('shows the neutral notice while idle, and its Continue carries on instead of resending', async () => {
    push(completed({ stopCause: 'turn_limit' }));
    const { container, root } = await render('idle');
    expect(container.textContent).toContain(NOTICE_TITLE);
    // Not the failed card, in either of its spellings.
    expect(container.textContent).not.toContain('Stopped at the tool-call ceiling');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.closest('[role="status"]') && candidate.textContent === 'Continue'
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    // Carry on — not `resend` of `user-1`, which would restart the task.
    expect(useContinueIntentStore.getState().pending).toEqual({
      kind: 'carry-on',
      sessionId: 's1',
    });
    await act(async () => root.unmount());
  });

  it('draws nothing while a run is going, or after a plain completion', async () => {
    push(completed({ stopCause: 'turn_limit' }));
    const running = await render('running');
    expect(running.container.textContent).not.toContain(NOTICE_TITLE);
    await act(async () => running.root.unmount());

    push(completed());
    const idle = await render('idle');
    expect(idle.container.textContent).not.toContain(NOTICE_TITLE);
    await act(async () => idle.root.unmount());
  });

  it('has Chinese for every sentence the notice shows', () => {
    expect(zhTranslations[NOTICE_TITLE]).toBeTruthy();
    expect(
      zhTranslations[
        'This run reached the turn ceiling for one request, so the assistant summarised its progress and paused. The work so far is kept.'
      ]
    ).toBeTruthy();
  });
});

describe('the composer honours a carry-on intent', () => {
  const composer = stripComments(
    readFileSync(path.resolve(__dirname, '../ChatComposer.tsx'), 'utf8'),
    'ChatComposer.tsx'
  );

  it('sends a plain "continue" and returns before looking up any message to resend', () => {
    const branch = composer.indexOf("if (continueIntent.kind === 'carry-on') {");
    const send = composer.indexOf("runSend(t('Continue'), [], { origin: 'retry' });", branch);
    const lookup = composer.indexOf('continueIntent.messageId');
    expect(branch).toBeGreaterThan(0);
    // The session guard and the one-shot clear both run first.
    expect(composer.indexOf('continueIntent.sessionId !== activeSessionId')).toBeLessThan(branch);
    expect(
      composer.indexOf('clearContinue();', composer.indexOf('continueIntent.sessionId'))
    ).toBeLessThan(branch);
    expect(send).toBeGreaterThan(branch);
    // The resend lookup only exists after the carry-on branch has returned.
    expect(lookup).toBeGreaterThan(send);
  });
});
