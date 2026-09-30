// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7b (decisions 069, 109, 119; prototype scenes C and D): the
 * background jobs and subagents windows mounted for real — what they list,
 * that their controls reach the three new IPC calls (a continuable subagent
 * interrupted, never killed), that a closed window is not drawn, and a
 * running command's live output inside its row.
 *
 * The `electronAPI` stub is hoisted: zustand's persisted stores rehydrate at
 * import and read `settings`, and a stub installed later hangs the suite.
 */

import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { useToolLiveOutputStore } from '@/stores/toolLiveOutput';
import { LiveToolOutput } from '../LiveToolOutput';
import { SessionSubwindows } from '../SessionSubwindows';
import { reduceSessionPanels, type SessionPanelsState } from '../sessionPanelsModel';
import type { SubagentLane } from '../subagentActivityModel';

const api = vi.hoisted(() => {
  const chat = {
    onRuntimeEvent: () => () => undefined,
    getSessionPanels: async () => ({ projections: [] }),
    killSessionJob: async (_payload: unknown) => ({ outcome: 'requested' as const }),
    readSessionJob: async (_payload: unknown) => ({
      text: 'VITE ready in 812 ms\n',
      from: 0,
      next: 21,
      omittedBytes: 0,
      lossy: false,
    }),
    interruptSubagent: async (_payload: unknown) => ({ interrupted: true }),
  };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat,
  } as unknown as typeof window.electronAPI;
  return { chat };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));

function lane(extra: Partial<SubagentLane> & { parentToolCallId: string }): SubagentLane {
  return {
    sessionId: 's1',
    agentId: null,
    agentType: null,
    description: null,
    status: 'running',
    taskType: 'subagent',
    startedAt: Date.now() - 151_000,
    endedAt: null,
    rows: [],
    droppedRows: 0,
    progress: null,
    usage: null,
    report: null,
    pendingPermission: null,
    capped: false,
    ordinal: 0,
    ...extra,
  };
}

function seed(open: { jobs: boolean; agents: boolean }) {
  useSessionSubwindowsStore.setState({ open, positions: {}, hiddenJobs: {}, expanded: {} });
  useSessionPanelsStore.setState({
    bySession: {
      s1: {
        live: true,
        seq: { jobs: 1 },
        jobs: [
          { id: 'bash-2', kind: 'bash', label: 'npm run dev', status: 'running', startedAt: 1 },
          {
            id: 'bash-6',
            kind: 'bash',
            label: 'npm run build',
            status: 'running',
            startedAt: 1,
            promoted: true,
          },
          {
            id: 'bash-4',
            kind: 'bash',
            label: 'npm run lint',
            status: 'failed',
            detail: 'exit code: 1',
            startedAt: 1,
            finishedAt: 18_001,
          },
        ],
        subagentCatalog: [
          { id: 'kid-1', createdAt: 1, mode: 'continuable', label: 'Probe the goal projection' },
          { id: 'kid-2', createdAt: 2, mode: 'one-shot', label: 'Review the plan' },
        ],
      },
    },
    open: {},
    dismissed: {},
    commandPending: {},
  });
  useSubagentActivityStore.setState({
    lanes: {
      'call-1': lane({
        parentToolCallId: 'call-1',
        agentId: 'kid-1',
        description: 'Probe the goal projection',
        usage: { totalTokens: 45_000, toolUses: 12 },
      }),
      'call-2': lane({
        parentToolCallId: 'call-2',
        agentId: 'kid-2',
        description: 'Review the plan',
        taskType: 'subagent_fork',
        status: 'completed',
        startedAt: 0,
        endedAt: 48_000,
        ordinal: 1,
      }),
    },
    agentIndex: {},
    permissionOrigin: {},
    nextOrdinal: 2,
  });
}

let root: Root | undefined;
let container: HTMLDivElement;

async function render(
  element: ReactElement = createElement(SessionSubwindows, { sessionId: 's1' })
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

function buttonNamed(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the background jobs and subagents windows (P1-7b)', () => {
  it('[P7B-MOUNT-CLOSED] nothing is drawn while both windows are closed', async () => {
    seed({ jobs: false, agents: false });
    await render();
    expect(container.querySelector('[data-testid="session-subwindows"]')).toBeNull();
  });

  it('[P7B-MOUNT-C] scene C: commands, the promoted tag, the exit code, and the running continuable child', async () => {
    seed({ jobs: true, agents: false });
    await render();
    const window = container.querySelector('[data-testid="subwindow-jobs"]') as HTMLElement;
    expect(window).not.toBeNull();
    expect(window.textContent).toContain('Background tasks');
    expect(window.textContent).toContain('3 running · 1 ended');
    const rows = [...window.querySelectorAll('[data-testid="job-row"]')];
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
      'running',
      'running',
      'failed',
      'running',
    ]);
    expect(rows[1]?.textContent).toContain('Timed out into the background');
    expect(rows[2]?.textContent).toContain('Exit code 1');
    expect(rows[3]?.textContent).toContain('Probe the goal projection');

    // A command is killed; the continuable child is interrupted (decision 069).
    const kill = vi.spyOn(api.chat, 'killSessionJob');
    const interrupt = vi.spyOn(api.chat, 'interruptSubagent');
    await act(async () => buttonNamed(rows[0] as HTMLElement, 'Stop')?.click());
    expect(kill).toHaveBeenCalledWith({ sessionId: 's1', jobId: 'bash-2' });
    await act(async () => buttonNamed(rows[3] as HTMLElement, 'Interrupt')?.click());
    expect(interrupt).toHaveBeenCalledWith({ sessionId: 's1', childId: 'kid-1' });

    // An ended row is put away, in this window only.
    await act(async () => buttonNamed(rows[2] as HTMLElement, 'Remove')?.click());
    expect(useSessionSubwindowsStore.getState().hiddenJobs.s1).toEqual(['bash-4']);
    expect(window.querySelectorAll('[data-testid="job-row"]')).toHaveLength(3);
  });

  it('[P7B-MOUNT-OUTPUT] opening a command’s output reads it through the window’s IPC', async () => {
    seed({ jobs: true, agents: false });
    const read = vi.spyOn(api.chat, 'readSessionJob');
    await render();
    const row = container.querySelector('[data-testid="job-row"]') as HTMLElement;
    await act(async () => buttonNamed(row, 'Output')?.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="job-output"]')?.textContent).toContain(
        'VITE ready in 812 ms'
      )
    );
    expect(read).toHaveBeenCalledWith({ sessionId: 's1', jobId: 'bash-2' });
  });

  it('[P7B-MOUNT-D] scene D: each child with its tool’s name, its time and counts; interrupt only the running continuable one', async () => {
    seed({ jobs: false, agents: true });
    await render();
    const window = container.querySelector('[data-testid="subwindow-agents"]') as HTMLElement;
    expect(window.textContent).toContain('2 in all');
    const rows = [...window.querySelectorAll('[data-testid="subagent-row"]')];
    expect(rows[0]?.textContent).toContain('Delegated subagent');
    expect(rows[0]?.textContent).toContain('45k tokens');
    expect(rows[0]?.textContent).toContain('12 calls');
    expect(rows[0]?.textContent).toMatch(/2:3\d/);
    expect(rows[1]?.textContent).toContain('Fork');
    expect(rows[1]?.textContent).toContain('0:48');
    expect(buttonNamed(rows[0] as HTMLElement, 'Interrupt')).toBeDefined();
    expect(buttonNamed(rows[1] as HTMLElement, 'Interrupt')).toBeUndefined();
    expect(buttonNamed(rows[1] as HTMLElement, 'Locate')).toBeDefined();

    // Close hides it.
    await act(async () => buttonNamed(window, 'Close')?.click());
    expect(useSessionSubwindowsStore.getState().open.agents).toBe(false);
  });

  it('[P7B-MOUNT-LIVE] a running command’s row shows its live tail; nothing without one', async () => {
    useToolLiveOutputStore.setState({
      byCall: {
        'call-9': {
          sessionId: 's1',
          jobId: 'bash-9',
          text: 'tick 1\ntick 2\n',
          omittedBytes: 2048,
          totalBytes: 2062,
        },
      },
      order: ['call-9'],
    });
    await render(createElement(LiveToolOutput, { toolCallId: 'call-9' }));
    const pane = container.querySelector('[data-testid="live-tool-output"]') as HTMLElement;
    expect(pane.textContent).toContain('tick 2');
    expect(pane.textContent).toContain('Earlier 2 KB not shown');
    await act(async () => root?.render(createElement(LiveToolOutput, { toolCallId: 'other' })));
    expect(container.querySelector('[data-testid="live-tool-output"]')).toBeNull();
  });
});

/**
 * dsh-rebase P1-7e e3 (decision 142). Problem 14: a docked window dragged by
 * its title follows the whole drag — it used to be drawn in another branch
 * once it had a position, so the first move remounted it and the drag (and its
 * pointer capture) ended after one step. Problem 17: after the engine restarts,
 * the jobs the old worker listed stay in the window until the user removes them.
 */
describe('the sub-windows after P1-7e', () => {
  /** A layer of 800×600 at the origin, a 340×200 card wherever its style puts it. */
  function stubBoxes() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.testid === 'session-subwindows') {
        return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 } as DOMRect;
      }
      if (this.dataset.testid?.startsWith('subwindow-')) {
        const left = this.style.left ? Number.parseFloat(this.style.left) : 448;
        const top = this.style.top ? Number.parseFloat(this.style.top) : 8;
        return {
          left,
          top,
          width: 340,
          height: 200,
          right: left + 340,
          bottom: top + 200,
        } as DOMRect;
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } as DOMRect;
    });
  }

  function pointer(type: string, target: Element, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    Object.defineProperty(event, 'button', { value: 0 });
    target.dispatchEvent(event);
  }

  it('[P7E-DRAG] a docked window follows every step of one drag, and is never remounted', async () => {
    seed({ jobs: true, agents: false });
    stubBoxes();
    await render();
    const card = container.querySelector('[data-testid="subwindow-jobs"]') as HTMLElement;
    const handle = card.firstElementChild as HTMLElement;
    expect(card.getAttribute('data-dragged')).toBeNull();

    await act(async () => pointer('pointerdown', handle, 500, 20));
    await act(async () => pointer('pointermove', handle, 480, 30));
    await act(async () => pointer('pointermove', handle, 400, 90));
    await act(async () => pointer('pointermove', handle, 300, 160));
    await act(async () => pointer('pointerup', handle, 300, 160));

    // Same node: the window stayed in its place in the tree.
    expect(container.querySelector('[data-testid="subwindow-jobs"]')).toBe(card);
    expect(card.getAttribute('data-dragged')).toBe('true');
    // (-200, +140) from where it was docked (448, 8).
    expect(useSessionSubwindowsStore.getState().positions.jobs).toEqual({ left: 248, top: 148 });
    expect(card.style.left).toBe('248px');
    expect(card.style.top).toBe('148px');
  });

  it('[P7E-JOBS-KEPT] after an engine restart the old rows stay, without output or stop, until removed', async () => {
    seed({ jobs: true, agents: false });
    // The subagent-activity store settles its lanes on the same disconnect.
    useSubagentActivityStore.setState({ lanes: {}, agentIndex: {} });
    // The worker goes, the next one reports an empty list.
    useSessionPanelsStore.setState((state) => {
      let next: SessionPanelsState = { bySession: state.bySession };
      next = reduceSessionPanels(next, {
        type: 'session.status',
        sessionId: 's1',
        seq: 50,
        timestamp: 50,
        payload: { status: 'disconnected', disconnectReason: 'engine_restarted' },
      } as RuntimeEvent);
      next = reduceSessionPanels(next, {
        type: 'session.projection',
        sessionId: 's1',
        seq: 51,
        timestamp: 51,
        payload: { key: 'jobs', view: [] },
      } as RuntimeEvent);
      return { bySession: next.bySession };
    });
    await render();
    const window = container.querySelector('[data-testid="subwindow-jobs"]') as HTMLElement;
    const rows = [...window.querySelectorAll('[data-testid="job-row"]')];
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['lost', 'lost', 'failed']);
    expect(rows[0]?.textContent).toContain('Engine restarted; the task ended');
    expect(buttonNamed(rows[0] as HTMLElement, 'Output')).toBeUndefined();
    expect(buttonNamed(rows[0] as HTMLElement, 'Stop')).toBeUndefined();
    expect(window.textContent).toContain('0 running · 3 ended');

    await act(async () => buttonNamed(rows[0] as HTMLElement, 'Remove')?.click());
    expect(useSessionSubwindowsStore.getState().hiddenJobs.s1).toEqual(['bash-2']);
    expect(
      [...window.querySelectorAll('[data-testid="job-row"]')].map((row) =>
        row.getAttribute('data-status')
      )
    ).toEqual(['lost', 'failed']);
  });
});
