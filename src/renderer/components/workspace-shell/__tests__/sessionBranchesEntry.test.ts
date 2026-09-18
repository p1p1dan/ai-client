// @vitest-environment happy-dom
/**
 * 2026-09-18 — 「会话分支」 belongs on the session bar, not in the message list.
 *
 * The button opens `SessionTreeDialog`: the conversation's own message tree and
 * its rewind points. It has nothing to do with git branches — it only borrowed
 * the icon and the metaphor — and it used to render as the FIRST CHILD of the
 * scrolling timeline, right-aligned. That put a bar-shaped control inside the
 * content it is about: it looked like chrome, and it scrolled away the moment
 * the reader moved. The user's question was exactly that 「是不是显示错位置了」.
 *
 * Three things had to survive the move, and each is a separate way to get it
 * wrong:
 *
 *  1. the GATE — it exists only once the chat has a durable session on disk;
 *  2. the DISABLE rule — it is inert unless the session is idle;
 *  3. the COPY — it was a hardcoded English literal `Branches` that stayed
 *     English in a Chinese UI, and the catalog already had 「会话分支」 because
 *     the dialog's own title uses it.
 *
 * Rendered rather than scanned, with the real Chinese translator, because (3)
 * is precisely the class of defect a source scan cannot see: `t('…')` present
 * in the source says nothing about which string reaches the screen.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { translate } from '@shared/i18n';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';
import type { PresentationSwitch } from '@/components/chat/usePresentationSwitch';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { SessionBar } from '../SessionBar';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const BRANCHES = zh('Session branches');

const presentation: PresentationSwitch = {
  presentationMode: 'gui',
  openGui: () => undefined,
  openTui: () => undefined,
  handleTuiExit: () => undefined,
  tuiTerminalId: null,
  surfaceSwitching: false,
  effectiveCwd: '/repo',
};

function seed(over: { runtimeIdentity?: string; status?: SessionRuntimeStatus } = {}) {
  const { runtimeIdentity, status = 'idle' } = over;
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 's1',
        status,
        updatedAt: 0,
        ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
      },
    ],
    projects: [{ id: 'p1', name: 'proj' }],
    workspaces: [{ id: 'w1', projectId: 'p1', name: 'repo', kind: 'main', path: '/repo' }],
  });
}

async function renderBar() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SessionBar, { presentation })));
  return { container, root };
}

function branchesButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(BRANCHES)
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('is absent until the chat has a durable session on disk', async () => {
  seed();
  const { container, root } = await renderBar();
  // No `runtimeIdentity` means no JSONL to read a tree out of — the control is
  // dropped, not disabled, so there is no entry point that leads nowhere.
  expect(branchesButton(container)).toBeUndefined();
  await act(async () => root.unmount());
});

it('appears on the bar, in Chinese, once the session is durable', async () => {
  seed({ runtimeIdentity: '/sessions/s1.jsonl' });
  const { container, root } = await renderBar();
  const button = branchesButton(container);
  expect(button).toBeDefined();
  // The literal this replaced. A catalog key that never reaches `t()` renders
  // its own English spelling, which is what shipped for as long as the button
  // lived in the timeline.
  expect(container.textContent).not.toContain('Branches');
  expect(container.textContent).toContain('会话分支');
  await act(async () => root.unmount());
});

it('is disabled while the session is doing anything but idling', async () => {
  seed({ runtimeIdentity: '/sessions/s1.jsonl', status: 'idle' });
  const idle = await renderBar();
  expect(branchesButton(idle.container)?.disabled).toBe(false);
  await act(async () => idle.root.unmount());

  // `running` is the obvious one. `waiting_permission` is the one a narrower
  // rewrite loses: the bar's own busy dot is 「running / starting」 only, and
  // rewinding a session parked on an approval is exactly as unsafe as
  // rewinding one mid-stream.
  for (const status of ['running', 'starting', 'waiting_permission'] as const) {
    seed({ runtimeIdentity: '/sessions/s1.jsonl', status });
    const busy = await renderBar();
    expect(branchesButton(busy.container)?.disabled, status).toBe(true);
    await act(async () => busy.root.unmount());
  }
});

/**
 * The move is only finished when the old site is empty. A button left behind
 * would be a second entry point to the same dialog, gated by a second copy of
 * the same two conditions — the drift this consolidation exists to prevent.
 */
it('the timeline keeps no copy of the button, the dialog, or their gates', () => {
  const timeline = stripComments(
    readFileSync(
      path.join(process.cwd(), 'src/renderer/components/chat/MessageTimeline.tsx'),
      'utf8'
    ),
    'MessageTimeline.tsx'
  );
  expect(timeline).not.toContain('SessionTreeDialog');
  expect(timeline).not.toContain('GitBranch');
  expect(timeline).not.toContain('treeOpen');
  // The two signals are derived once, in the bar. Leaving either behind here is
  // how the two copies start disagreeing about when the tree is safe to open.
  expect(timeline).not.toContain('hasDurablePiSession');
  expect(timeline).not.toContain('runtimeIdentity');

  const bar = stripComments(
    readFileSync(
      path.join(process.cwd(), 'src/renderer/components/workspace-shell/SessionBar.tsx'),
      'utf8'
    ),
    'SessionBar.tsx'
  );
  expect(bar).toContain('SessionTreeDialog');
  expect(bar).toContain("t('Session branches')");
  // Same size tier as the bar's other controls (review / + / GUI / TUI): h-6
  // shell, size-3.5 icon. A control that sets its own height re-opens the
  // 「臃肿」 D07 spent a round removing.
  expect(bar).toContain('<GitBranch className="size-3.5" />');
});
