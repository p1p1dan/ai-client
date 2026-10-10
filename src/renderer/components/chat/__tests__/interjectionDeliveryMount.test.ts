// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * GitHub issue #8 (dsh-rebase decision 172): what a Ctrl+Enter message does to
 * the running turn while DSH has not taken it in yet, read off the DOM of a
 * real `MessageTimeline`.
 *
 * DSH takes a steered message in at the running turn's NEXT step boundary
 * (decision 093): the step that is running — a long command, a long thought —
 * finishes first, and only then does the echo arrive. The reported defect was
 * the timeline treating the bubble itself as that boundary: the running turn
 * folded into "Worked for 2m 24s" the moment Ctrl+Enter was pressed, while
 * its last step was still running, and a second "Working" spinner opened
 * under the bubble.
 *
 * The order these tests drive is the real one (`stream.steer.json`): command
 * running → interjection published → command result → echo carrying the
 * attempt id → the next step's output.
 */
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
// Issue #8 §4: the withdrawal's light notices, observed rather than drawn.
const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock('@/components/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toast')>()),
  toastManager: { add: toastAdd },
}));

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { resetComposerDraftsForTests, useComposerDraftsStore } from '@/stores/composerDrafts';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { MessageTimeline } from '../MessageTimeline';

type Blocks = ChatMessage['blocks'];
type Status = 'running' | 'idle';

const user = (id: string, text: string): ChatMessage => ({
  id,
  sessionId: 's',
  role: 'user',
  blocks: [{ id: `${id}:t`, type: 'text', text }],
});

const assistant = (id: string, blocks: Blocks, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  blocks,
  ...extra,
});

const call = (id: string, command: string): Blocks[number] => ({
  id,
  type: 'tool_call',
  toolCallId: id,
  toolName: 'Bash',
  toolInput: { command },
});

const result = (id: string): Blocks[number] => ({
  id: `${id}:r`,
  type: 'tool_result',
  toolCallId: id,
  toolOk: true,
  toolOutput: 'ok',
});

const PROMPT = user('u1', 'Run the checks');
/** Step 1: a thought and a finished command. */
const STEP_1 = assistant('a1', [
  { id: 'th1', type: 'thinking', text: 'Build first.' },
  call('c1', 'pnpm build'),
  result('c1'),
]);
/** Step 2 while its command still runs: no result yet. */
const STEP_2_RUNNING = assistant('a2', [call('c2', 'sleep 120; pnpm test')]);
const STEP_2_DONE = assistant('a2', [call('c2', 'sleep 120; pnpm test'), result('c2')]);

const INTERJECTION = 'Also run lint.';
const ATTEMPT = 'interject-1';
/** The echo DSH sends once step 3 takes the message in. */
const ECHO = user('dsh-user-9', INTERJECTION);
const STEP_3 = assistant('a3', [{ id: 'th3', type: 'thinking', text: 'Lint next.' }]);

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  usePendingUserMessagesStore.setState({ bySession: {} });
  resetComposerDraftsForTests();
  toastAdd.mockReset();
  Reflect.deleteProperty(window, 'electronAPI');
  vi.unstubAllGlobals();
});

async function mount(messages: ChatMessage[], status: Status) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  usePendingUserMessagesStore.setState({ bySession: {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  /** The store and the prop move together, as `ChatWorkspace` hands them over. */
  const show = (next: ChatMessage[], nextStatus: Status) =>
    act(async () => {
      useChatSessionsStore.setState({
        activeSessionId: 's',
        sessions: [
          {
            id: 's',
            title: 's',
            projectId: 'p',
            workspaceId: 'w',
            status: nextStatus,
            updatedAt: 0,
          },
        ],
        messages: { s: next },
        lastError: null,
        pendingPermissions: [],
        pendingQuestions: [],
      } as never);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, {
            sessionId: 's',
            status: nextStatus,
            thinkingEnabled: true,
          })
        )
      );
    });
  await show(messages, status);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  const sections = () =>
    [...container.querySelectorAll('section[data-turn-id]')].map((section) =>
      section.getAttribute('data-turn-id')
    );
  const head = (turnId: string) => {
    const details = container.querySelector<HTMLDetailsElement>(
      `section[data-turn-id="${turnId}"] details`
    );
    expect(details, `turn ${turnId} has a process head`).not.toBeNull();
    const summary = details?.querySelector('summary')?.textContent ?? '';
    return { open: details?.open, summary };
  };
  const awaiting = () => [...container.querySelectorAll('[data-awaiting-delivery]')];
  return { container, show, sections, head, awaiting };
}

const interject = () =>
  act(async () =>
    usePendingUserMessagesStore.getState().publish({
      attemptId: ATTEMPT,
      sessionId: 's',
      text: INTERJECTION,
      attachments: [],
      startedAt: 0,
      awaitingDelivery: true,
    })
  );

/** What the store's flush does with the echo: pair it, then retire the bubble. */
const deliver = () =>
  act(async () => {
    const pending = usePendingUserMessagesStore.getState();
    pending.acknowledgeAttempt('s', ATTEMPT, ECHO.id);
    pending.clear(ATTEMPT);
  });

it('[I8-1] while the interjection waits, the running turn stays open and working', async () => {
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  expect(view.head('u1')).toEqual({ open: true, summary: expect.stringContaining('Working') });

  await interject();

  // The bubble is drawn, at the end of the timeline, as awaiting delivery, its
  // words greyed until the turn takes it in…
  const bubbles = view.awaiting();
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]?.textContent).toContain(INTERJECTION);
  expect(bubbles[0]?.textContent).toContain('Awaiting delivery');
  expect(bubbles[0]?.querySelector('p')?.className).toContain('text-muted-foreground');
  const turn = view.container.querySelector('section[data-turn-id="u1"]');
  expect(
    turn?.compareDocumentPosition(bubbles[0] as Node) ?? 0,
    'the bubble comes after the running turn'
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  // …but it opens no turn of its own: no second spinner, no second clock.
  expect(view.sections()).toEqual(['u1']);
  // The turn it waits to join is still running: open, "Working", never "Worked".
  const head = view.head('u1');
  expect(head.open).toBe(true);
  expect(head.summary).toContain('Working');
  expect(head.summary).not.toContain('Worked');
  expect(view.container.textContent).not.toContain('Worked');

  // The command finishes; DSH has not opened the next step yet. Still running.
  await view.show([PROMPT, STEP_1, STEP_2_DONE], 'running');
  expect(view.sections()).toEqual(['u1']);
  expect(view.head('u1').open).toBe(true);
  expect(view.head('u1').summary).not.toContain('Worked');
  expect(view.awaiting()).toHaveLength(1);
});

it('[I8-2] once DSH takes it in, the old group folds and the message opens the new turn', async () => {
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  await interject();
  await view.show([PROMPT, STEP_1, STEP_2_DONE], 'running');

  // The echo lands where DSH took the message in, and the next step answers it.
  await view.show([PROMPT, STEP_1, STEP_2_DONE, ECHO, STEP_3], 'running');
  await deliver();

  expect(view.awaiting()).toHaveLength(0);
  expect(view.sections()).toEqual(['u1', ECHO.id]);
  // The step it waited for is done: the group folds as any finished turn's does.
  const old = view.head('u1');
  expect(old.open).toBe(false);
  expect(old.summary).toContain('Worked');
  // The new turn: an ordinary bubble, and the turn is the one working now.
  const next = view.container.querySelector(`section[data-turn-id="${ECHO.id}"]`);
  expect(next?.textContent).toContain(INTERJECTION);
  expect(next?.querySelector('[data-awaiting-delivery]')).toBeNull();
  expect(next?.querySelector('p')?.className).toContain('text-foreground');
  expect(next?.querySelector('p')?.className).not.toContain('text-muted-foreground');
  expect(next?.textContent).toContain('Working');
  expect(next?.textContent).not.toContain('Worked');
});

it('[I8-3] a Stop before delivery leaves the bubble waiting, and still no turn of its own', async () => {
  // Decision 094: the message stays in DSH's inbox for the next turn.
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  await interject();
  await view.show([PROMPT, STEP_1, { ...STEP_2_RUNNING, stopCause: 'user_stop' }], 'idle');

  expect(view.sections()).toEqual(['u1']);
  expect(view.awaiting()).toHaveLength(1);
  // The stopped turn says "Worked" once — on its own head, not under the bubble.
  expect(view.head('u1').summary).toContain('Worked');
  expect(view.container.textContent?.split('Worked').length).toBe(2);
});

// ---- issue #8 §4: 「撤回」 on the awaiting bubble ----------------------------------

/** The engine's answer to `chat.withdrawInterjection`, stubbed on the preload bridge. */
function engineAnswers(outcome: 'withdrawn' | 'delivered' | 'not_found') {
  const withdrawInterjection = vi.fn(async () => ({ outcome }));
  Object.assign(window, { electronAPI: { chat: { withdrawInterjection } } });
  return withdrawInterjection;
}

const withdrawButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Withdraw this message"]');

it('[I8-4] the awaiting bubble offers a named, keyboard-reachable withdraw; it hands the words back', async () => {
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  await interject();
  const button = withdrawButton(view.container);
  expect(button, 'a real button, read aloud as "Withdraw this message"').not.toBeNull();
  expect(button?.textContent).toContain('Withdraw');
  expect(button?.disabled).toBe(false);
  // Not a hover reveal: on screen and in the tab order as soon as the bubble is.
  expect(button?.tabIndex).toBe(0);
  expect(view.awaiting()[0]?.contains(button as Node)).toBe(true);

  const ask = engineAnswers('withdrawn');
  await act(async () => button?.click());

  expect(ask).toHaveBeenCalledWith({ sessionId: 's', attemptId: ATTEMPT });
  expect(view.awaiting()).toHaveLength(0);
  expect(useComposerDraftsStore.getState().offered).toEqual({ s: INTERJECTION });
  // The turn it never joined runs on, untouched.
  expect(view.sections()).toEqual(['u1']);
  expect(view.head('u1')).toEqual({ open: true, summary: expect.stringContaining('Working') });
  expect(toastAdd).not.toHaveBeenCalled();
});

it('[I8-5] too late: delivered keeps the bubble for its echo, with a light notice', async () => {
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  await interject();
  engineAnswers('delivered');
  await act(async () => withdrawButton(view.container)?.click());

  expect(view.awaiting()).toHaveLength(1);
  expect(withdrawButton(view.container)).toBeNull();
  const note = view
    .awaiting()[0]
    ?.querySelector('[title="Already delivered; it can no longer be withdrawn"]');
  expect(note?.textContent).toBe('Cannot withdraw');
  expect(toastAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'info',
      title: 'Already delivered; it can no longer be withdrawn',
    })
  );
  expect(useComposerDraftsStore.getState().offered).toEqual({});
});

it('[I8-6] a lost engine connection turns the button into a reason, before any press', async () => {
  const view = await mount([PROMPT, STEP_1, STEP_2_RUNNING], 'running');
  await interject();
  expect(withdrawButton(view.container)).not.toBeNull();

  await act(async () => usePendingUserMessagesStore.getState().markWithdrawalsUnavailable('s'));

  expect(withdrawButton(view.container)).toBeNull();
  const note = view.awaiting()[0]?.querySelector('span[title]:last-child');
  expect(note?.textContent).toBe('Cannot withdraw');
  expect(note?.getAttribute('title')).toContain('The engine can no longer find it');
  // Still awaiting delivery: it may yet go out with a later turn.
  expect(view.awaiting()[0]?.textContent).toContain('Awaiting delivery');
});
