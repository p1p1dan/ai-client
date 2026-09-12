// @vitest-environment happy-dom
/**
 * F5 gate — the answerable card actually reaches the screen and its answer
 * actually reaches the worker.
 *
 * This is the hop nothing covered. `questionCardInteraction.test.ts` proves the
 * card turns clicks into an `onSubmit` payload, and the store test proves the
 * reducers handle `question.requested` / `question.resolved` — but between them
 * sat a component that did not exist, so a question could be docked in the
 * store and simply never be rendered. That is a silent failure in the worst
 * way: the session sits in `waiting_question` with nothing on screen to answer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { PendingQuestionDock } from '../PendingQuestionDock';
import { stripComments } from './stripComments';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));

const QUESTIONS = [
  {
    id: 'call-1-0',
    question: 'Which database?',
    header: 'Storage',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  },
];

const respondQuestion = vi.fn(async () => ({ handled: true }));

function dock() {
  const container = document.createElement('div');
  document.body.append(container);
  return { container, root: createRoot(container) };
}

/** Push a real `question.requested` through the real reducer. */
function askInStore(sessionId = 's1') {
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), {
      type: 'question.requested',
      seq: 1,
      timestamp: 1,
      sessionId,
      payload: { questionId: 'call-1', questions: QUESTIONS },
    } as any),
  }));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', window);
  respondQuestion.mockClear();
  (window as any).electronAPI = { chat: { respondQuestion } };
  useChatSessionsStore.setState({
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    messages: { s1: [{ id: 'asst-1', sessionId: 's1', role: 'assistant', blocks: [] }] },
    pendingQuestion: null,
    lastError: null,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('renders nothing until a question is docked for THIS session', async () => {
  const { container, root } = dock();
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  expect(container.textContent).toBe('');

  await act(async () => askInStore('s1'));
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  expect(container.textContent).toContain('Which database?');

  // A question belonging to another chat must not appear over this one.
  const other = dock();
  await act(async () => other.root.render(createElement(PendingQuestionDock, { sessionId: 's2' })));
  expect(other.container.textContent).toBe('');
  await act(async () => {
    root.unmount();
    other.root.unmount();
  });
});

it('sends the answer to the worker keyed by the question id', async () => {
  askInStore('s1');
  const { container, root } = dock();
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  const option = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Postgres')
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
  const submit = [...container.querySelectorAll('button')].find((button) =>
    /continue/i.test(button.textContent ?? '')
  );
  expect(submit).toBeDefined();
  await act(async () => submit?.click());

  expect(respondQuestion).toHaveBeenCalledTimes(1);
  expect(respondQuestion).toHaveBeenCalledWith({
    sessionId: 's1',
    questionId: 'call-1',
    // Keyed by the id the runtime assigned, not by the question text: two
    // identically worded questions in one call would collide on the text.
    answers: { 'call-1-0': 'Postgres' },
  });
  await act(async () => root.unmount());
});

it('sends Skip as a cancel rather than as an empty answer', async () => {
  askInStore('s1');
  const { container, root } = dock();
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  const skip = [...container.querySelectorAll('button')].find((button) =>
    /skip/i.test(button.textContent ?? '')
  );
  expect(skip).toBeDefined();
  await act(async () => skip?.click());
  expect(respondQuestion).toHaveBeenCalledWith({
    sessionId: 's1',
    questionId: 'call-1',
    cancel: true,
  });
  await act(async () => root.unmount());
});

it('disappears when the worker resolves the question, not when the click lands', async () => {
  askInStore('s1');
  const { container, root } = dock();
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  expect(container.textContent).toContain('Which database?');

  await act(async () => {
    useChatSessionsStore.setState((state) => ({
      ...state,
      ...applyRuntimeEvent(useChatSessionsStore.getState(), {
        type: 'question.resolved',
        seq: 2,
        timestamp: 2,
        sessionId: 's1',
        payload: { questionId: 'call-1', outcome: 'answered', answers: { 'call-1-0': 'Postgres' } },
      } as any),
    }));
  });
  await act(async () => root.render(createElement(PendingQuestionDock, { sessionId: 's1' })));
  expect(container.textContent).toBe('');
  await act(async () => root.unmount());
});

/**
 * The mount itself, which the render tests above cannot reach.
 *
 * Everything in this file passes with the dock unmounted — the component works,
 * and nobody draws it. That is exactly the state F5 was in before this batch:
 * a fully implemented `QuestionCard` whose `interactive` variant had no call
 * site anywhere in the repo. Comments are stripped first so the scan cannot be
 * satisfied by the prose that explains it.
 */
it('is mounted in the chat column, above the composer', () => {
  const source = stripComments(
    readFileSync(path.join(__dirname, '..', 'ChatWorkspace.tsx'), 'utf8'),
    'ChatWorkspace.tsx'
  );
  expect(source).toContain('<PendingQuestionDock sessionId={activeSessionId} />');
  // Above the composer, not below it: a card under the input box is a card the
  // user scrolls past.
  expect(source.indexOf('<PendingQuestionDock')).toBeLessThan(source.indexOf('<ChatComposer'));
});
