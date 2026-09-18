// @vitest-environment happy-dom
/**
 * 2026-09-18 — the permission card is a floating single card above the
 * composer, and there is exactly ONE of it.
 *
 * The user's report was about the old arrangement: several requests in one turn
 * rendered as a column of cards in the message list, all answerable at once
 * (「顺序输出在页面上显示全部授权卡片」). The ruling was one card at a time,
 * docked above the input, carrying the gate's own progress.
 *
 * This file covers the renderer half. It deliberately spans two components,
 * because the defect class the move introduces is a RELATIONSHIP rather than a
 * behaviour of either one:
 *
 *  - the dock draws the card, and
 *  - the timeline must have stopped drawing an answerable copy of it.
 *
 * Each half passes on its own while the pair is broken in both directions — two
 * answerable cards on screen (the bug the move exists to remove) or none at all
 * (the far worse one: authorization is this app's only Allow/Deny surface, so a
 * turn parked on a gate with no card is a turn that looks frozen with no way
 * out but Stop). `[RED-LINE]` below is the assertion for the second.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { englishTranslate } from '@shared/i18n';
import type { PermissionDecisionId, RuntimeEvent } from '@shared/types/runtimeEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';
import { PendingPermissionDock } from '../PendingPermissionDock';
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

const respondPermission = vi.fn(async () => ({ handled: true }));

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  return { container, root: createRoot(container) };
}

/** Every `<button>` currently on screen, by visible text. */
function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text)
  );
}

/** Push a real `permission.requested` through the real reducer. */
function askPermission(
  permissionId: string,
  over: {
    sessionId?: string;
    toolName?: string;
    description?: string;
    decisions?: PermissionDecisionId[];
    queuePosition?: number;
    queueDepth?: number;
  } = {}
) {
  const { sessionId = 's1', toolName = 'Bash', description, ...rest } = over;
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), {
      type: 'permission.requested',
      seq: 1,
      timestamp: 1,
      sessionId,
      payload: {
        permissionId,
        toolName,
        ...(description === undefined ? {} : { description }),
        ...rest,
      },
    } satisfies RuntimeEvent),
  }));
}

/** Push a real `permission.resolved` through the real reducer. */
function resolvePermission(permissionId: string, allow: boolean, sessionId = 's1') {
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), {
      type: 'permission.resolved',
      seq: 2,
      timestamp: 2,
      sessionId,
      payload: { permissionId, allow, decision: allow ? 'allow' : 'deny' },
    } satisfies RuntimeEvent),
  }));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', window);
  respondPermission.mockClear();
  respondPermission.mockImplementation(async () => ({ handled: true }));
  (window as any).electronAPI = { chat: { respondPermission } };
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
    messages: { s1: [{ id: 'asst-1', sessionId: 's1', role: 'assistant', blocks: [] }] },
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('renders nothing until a permission is parked for THIS session', async () => {
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  expect(container.textContent).toBe('');

  await act(async () => askPermission('perm-1', { description: 'run ls' }));
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  expect(container.textContent).toContain('run ls');

  // Another chat's approval must never appear over this one — answering it here
  // would send this session's id with that session's permissionId.
  const other = mount();
  await act(async () =>
    other.root.render(createElement(PendingPermissionDock, { sessionId: 's2' }))
  );
  expect(other.container.textContent).toBe('');
  await act(async () => {
    root.unmount();
    other.root.unmount();
  });
});

/**
 * The shape the user actually complained about. The runtime gate serializes
 * these now, so in production only one ever reaches the store — but the
 * renderer must not DEPEND on that to show one card, or the first worker that
 * skips the queue (a legacy backend, a replayed burst) puts the column of cards
 * straight back.
 */
it('three parked requests draw ONE card, and it is the oldest', async () => {
  askPermission('perm-1', { description: 'run ls' });
  askPermission('perm-2', { description: 'run rm' });
  askPermission('perm-3', { description: 'run curl' });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));

  expect(container.textContent).toContain('run ls');
  expect(container.textContent).not.toContain('run rm');
  expect(container.textContent).not.toContain('run curl');
  // One card, not three stacked inside the dock.
  expect(buttonNamed(container, 'Allow')).toBeDefined();
  expect(
    [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Allow')
  ).toHaveLength(1);
  await act(async () => root.unmount());
});

it('draws the gate progress in the corner when more than one request is queued', async () => {
  askPermission('perm-1', { description: 'run ls', queuePosition: 2, queueDepth: 5 });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  expect(container.textContent).toContain('2/5');
  await act(async () => root.unmount());
});

/**
 * Both suppression rules, on the surface that shows them. The pure rule is
 * truth-tabled in `questionCardModel.test.ts` (`derivePermissionQueueProgress`);
 * what this adds is that the card actually consults it — a card wired directly
 * to the two raw fields passes every one of those and still prints `1/1` on the
 * single-approval case, which is the one users see most.
 */
it('says nothing about progress for a lone request, and survives a worker that reports none', async () => {
  askPermission('perm-1', { description: 'run ls', queuePosition: 1, queueDepth: 1 });
  const lone = mount();
  await act(async () =>
    lone.root.render(createElement(PendingPermissionDock, { sessionId: 's1' }))
  );
  expect(lone.container.textContent).toContain('run ls');
  expect(lone.container.textContent).not.toContain('1/1');
  await act(async () => lone.root.unmount());

  useChatSessionsStore.setState({
    messages: { s1: [{ id: 'asst-1', sessionId: 's1', role: 'assistant', blocks: [] }] },
    pendingPermissions: [],
  });
  askPermission('perm-2', { description: 'run rm' });
  const silent = mount();
  await act(async () =>
    silent.root.render(createElement(PendingPermissionDock, { sessionId: 's1' }))
  );
  expect(silent.container.textContent).toContain('run rm');
  // The failure this pins is literal: an unguarded `${position}/${depth}`.
  expect(silent.container.textContent).not.toContain('undefined');
  expect(silent.container.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  await act(async () => silent.root.unmount());
});

it('sends the decision the pressed button carries, keyed by the permission id', async () => {
  askPermission('perm-1', { description: 'run ls' });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  await act(async () => buttonNamed(container, 'Allow')?.click());

  expect(respondPermission).toHaveBeenCalledTimes(1);
  expect(respondPermission).toHaveBeenCalledWith({
    sessionId: 's1',
    decision: 'allow',
    permissionId: 'perm-1',
  });
  await act(async () => root.unmount());
});

/**
 * S3 slice 4 (§3.2), relocated from `messageTimelineWiring.test.ts` when the
 * card moved out of the timeline — and upgraded from a source scan to a real
 * press. `Deny and stop` is not a synonym for Deny (it also interrupts the
 * turn) and `Allow for session` is not a synonym for Allow (it grants for the
 * rest of the session), so a dock that collapsed either into the two-button
 * answer would silently change what the user agreed to.
 */
it('forwards the richer decisions verbatim rather than degrading them to allow/deny', async () => {
  askPermission('perm-1', {
    description: 'run ls',
    decisions: ['allow', 'allow_session', 'deny', 'cancel'],
  });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  await act(async () => buttonNamed(container, 'Allow for session')?.click());
  expect(respondPermission).toHaveBeenCalledWith({
    sessionId: 's1',
    decision: 'allow_session',
    permissionId: 'perm-1',
  });
  await act(async () => root.unmount());

  respondPermission.mockClear();
  const second = mount();
  await act(async () =>
    second.root.render(createElement(PendingPermissionDock, { sessionId: 's1' }))
  );
  await act(async () => buttonNamed(second.container, 'Deny and stop')?.click());
  expect(respondPermission).toHaveBeenCalledWith({
    sessionId: 's1',
    decision: 'cancel',
    permissionId: 'perm-1',
  });
  await act(async () => second.root.unmount());
});

/**
 * The `false` contract `useRespondPermission` exists to keep. A card that
 * locked itself on a rejected IPC would leave the user staring at a dead card
 * with a live gate behind it.
 */
it('stays answerable when the IPC call fails', async () => {
  respondPermission.mockImplementation(async () => {
    throw new Error('host is gone');
  });
  askPermission('perm-1', { description: 'run ls' });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  await act(async () => buttonNamed(container, 'Allow')?.click());

  const allow = buttonNamed(container, 'Allow');
  expect(allow).toBeDefined();
  expect(allow?.disabled).toBe(false);
  await act(async () => root.unmount());
});

it('retires the card on the worker’s resolve, and the next request takes its place', async () => {
  askPermission('perm-1', { description: 'run ls' });
  askPermission('perm-2', { description: 'run rm' });
  const { container, root } = mount();
  await act(async () => root.render(createElement(PendingPermissionDock, { sessionId: 's1' })));
  expect(container.textContent).toContain('run ls');

  // The click does not retire it — `permission.resolved` does, so a decision
  // made in one window is reflected in every other view of the same session.
  await act(async () => buttonNamed(container, 'Allow')?.click());
  expect(container.textContent).toContain('run ls');

  await act(async () => resolvePermission('perm-1', true));
  expect(container.textContent).not.toContain('run ls');
  expect(container.textContent).toContain('run rm');
  expect(buttonNamed(container, 'Allow')).toBeDefined();
  await act(async () => root.unmount());
});

// ---- The two-surface invariant ----

async function renderTimeline(container: HTMLElement, client: QueryClient) {
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, {
          sessionId: 's1',
          status: 'waiting_permission',
          thinkingEnabled: false,
        })
      )
    )
  );
  return root;
}

/**
 * `[RED-LINE]` — an unanswered approval always has exactly one answerable card
 * on screen.
 *
 * Both halves are asserted in the same render because either alone is
 * satisfiable by the wrong fix: deleting the timeline branch passes "no
 * duplicate", deleting the dock passes nothing but would only be caught here.
 */
it('[RED-LINE] a parked approval is answerable exactly once: in the dock, never in the timeline', async () => {
  askPermission('perm-1', { description: 'run ls' });
  const client = new QueryClient();
  const timeline = document.createElement('div');
  document.body.append(timeline);
  const dockHost = mount();
  const timelineRoot = await renderTimeline(timeline, client);
  await act(async () =>
    dockHost.root.render(createElement(PendingPermissionDock, { sessionId: 's1' }))
  );

  try {
    // Answerable, once, in the dock.
    expect(buttonNamed(dockHost.container, 'Allow')).toBeDefined();
    expect(buttonNamed(dockHost.container, 'Deny')).toBeDefined();
    // And nowhere in the message list — not even as the old unanswerable
    // "Waiting" copy, which is what made the same request appear twice.
    expect(buttonNamed(timeline, 'Allow')).toBeUndefined();
    expect(timeline.textContent).not.toContain('run ls');
  } finally {
    await act(async () => {
      timelineRoot.unmount();
      dockHost.root.unmount();
    });
    timeline.remove();
    client.clear();
  }
});

/**
 * The other end of the same rule: once settled, the record belongs in the
 * transcript at the position the request happened (T-05 D-5 block order), and
 * the dock lets go of it.
 */
it('freezes into the timeline once resolved, and leaves the dock', async () => {
  askPermission('perm-1', { description: 'run ls' });
  resolvePermission('perm-1', true);
  const client = new QueryClient();
  const timeline = document.createElement('div');
  document.body.append(timeline);
  const dockHost = mount();
  const timelineRoot = await renderTimeline(timeline, client);
  await act(async () =>
    dockHost.root.render(createElement(PendingPermissionDock, { sessionId: 's1' }))
  );

  try {
    expect(dockHost.container.textContent).toBe('');
    expect(timeline.textContent).toContain('run ls');
    expect(timeline.textContent).toContain('Allowed');
    // Frozen means frozen: the settled copy offers no way to answer again.
    expect(buttonNamed(timeline, 'Deny')).toBeUndefined();
  } finally {
    await act(async () => {
      timelineRoot.unmount();
      dockHost.root.unmount();
    });
    timeline.remove();
    client.clear();
  }
});

// ---- Mount + wiring scans ----

/**
 * Everything above passes with the dock unmounted — the component works, and
 * nobody draws it. That is the exact state this app's question dock was in
 * before F5 built one. Comments are stripped first so the scan cannot be
 * satisfied by the prose explaining it.
 */
it('is mounted in the chat column, above the composer', () => {
  const source = stripComments(
    readFileSync(path.join(__dirname, '..', 'ChatWorkspace.tsx'), 'utf8'),
    'ChatWorkspace.tsx'
  );
  expect(source).toContain('<PendingPermissionDock sessionId={activeSessionId} />');
  expect(source.indexOf('<PendingPermissionDock')).toBeLessThan(source.indexOf('<ChatComposer'));
  // Questions and permissions are separate gates that can both be open; neither
  // dock may be made conditional on the other.
  expect(source).toContain('<PendingQuestionDock sessionId={activeSessionId} />');
});

/**
 * The half of S3-4 a render cannot reach: `respondPermission`'s second argument
 * is only consulted when no decision is supplied, so no assertion on the IPC
 * payload can tell whether it was derived correctly. A source pin is the honest
 * instrument here, and it is narrow — the two tokens must be ADJACENT, or a
 * bare `decision` would be satisfied by the lambda's own parameter list.
 */
it('derives allow from the decision in exactly one place', () => {
  const source = stripComments(
    readFileSync(path.join(__dirname, '..', 'PendingPermissionDock.tsx'), 'utf8'),
    'PendingPermissionDock.tsx'
  );
  expect(source).toContain('permissionDecisionAllows(decision), decision');
  // Through the shared hook, not a second private copy of the IPC call — two
  // copies would eventually disagree about what a failed call means.
  expect(source).toContain('useRespondPermission(sessionId)');
  expect(source).not.toContain('window.electronAPI');
});
