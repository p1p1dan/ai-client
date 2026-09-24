// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A running tool row's live "elapsed / limit" tail, through the path the app
 * actually uses: Runtime Event -> `useTurnTiming` -> `MessageTimeline` ->
 * `ChatTurn` -> `ToolGroupItem` -> `deriveToolGroupRows` -> `ToolRows`.
 *
 * Review 2026-09-24 found two defects on that path that no unit test saw:
 *
 *  - `deriveToolGroupRows` destructured the clock inputs out of its options
 *    and never passed them on, so no row in the timeline ever showed the tail
 *    while the `deriveToolRowView` tests stayed green ([ROW-CLOCK-1]);
 *  - the tick and the tool events reached tool group derivations they had no
 *    business with — the clock was a `useMemo` dependency of the running
 *    turn's groups ([ROW-CLOCK-2]), and the tool-start lookup changed identity
 *    on every tool event for EVERY turn ([ROW-CLOCK-3]). Both are counted
 *    through a spy on the derivation.
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
const { listeners } = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
vi.mock('@/stores/runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));
// Count the heavy derivation without changing what it returns.
vi.mock('../toolCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolCard')>();
  return { ...actual, deriveToolGroupRows: vi.fn(actual.deriveToolGroupRows) };
});

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';
import { deriveToolGroupRows, type ToolGroupEntry } from '../toolCard';

const NOW = Date.UTC(2026, 8, 24, 9, 0, 0);
const deriveSpy = vi.mocked(deriveToolGroupRows);

const call = (id: string, toolName: string, toolInput: unknown, done = true) => [
  // Live, the store mints the `tool_call` block with id = toolCallId.
  { id, type: 'tool_call' as const, toolCallId: id, toolName, toolInput },
  ...(done
    ? [
        {
          id: `${id}:r`,
          type: 'tool_result' as const,
          toolCallId: id,
          toolOk: true,
          toolOutput: 'ok',
        },
      ]
    : []),
];

/** A finished turn with a folded two-call group, then the running turn. */
const MESSAGES: ChatMessage[] = [
  { id: 'u1', sessionId: 's', role: 'user', blocks: [{ id: 'u1:t', type: 'text', text: 'Look' }] },
  {
    id: 'a1',
    sessionId: 's',
    role: 'assistant',
    blocks: [
      ...call('old-1', 'Read', { file_path: '/repo/a.ts' }),
      ...call('old-2', 'Bash', { command: 'ls' }),
      { id: 'a1:t', type: 'text', text: 'Done looking.' },
    ],
  },
  { id: 'u2', sessionId: 's', role: 'user', blocks: [{ id: 'u2:t', type: 'text', text: 'Build' }] },
  {
    id: 'a2',
    sessionId: 's',
    role: 'assistant',
    blocks: call('live-1', 'Bash', { command: 'pnpm build', timeoutSeconds: 1800 }, false),
  },
];

let unmount: (() => Promise<void>) | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Only the clock: Base UI and React schedule on real timers.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  listeners.clear();
  deriveSpy.mockClear();
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderRunning() {
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'running', updatedAt: 0 },
    ],
    messages: { s: MESSAGES },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  } as never);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's', status: 'running', thinkingEnabled: true })
      )
    )
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  return container;
}

async function emit(event: Record<string, unknown>) {
  await act(async () => {
    for (const listener of listeners) listener({ sessionId: 's', ...event });
  });
}

async function tick(ms = 1000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Tool-call ids of every group the spy derived since the last clear. */
function derivedCallIds(): string[] {
  return deriveSpy.mock.calls.flatMap(([entries]) =>
    (entries as readonly ToolGroupEntry[]).flatMap((entry) =>
      entry.kind === 'run' ? [entry.run.toolCallId] : []
    )
  );
}

it('[ROW-CLOCK-1] a running row in the timeline shows elapsed / limit, and it ticks', async () => {
  const container = await renderRunning();
  await emit({ type: 'tool.started', timestamp: NOW - 32_000, payload: { toolCallId: 'live-1' } });
  // The derivation ran for the live row — the tail below comes out of it.
  expect(derivedCallIds()).toContain('live-1');
  expect(container.textContent).toContain('· 32s / 30m');
  await tick();
  expect(container.textContent).toContain('· 33s / 30m');
  // The finished turn's rows never carry a clock.
  expect(container.textContent?.match(/ \/ 30m/g)).toHaveLength(1);
});

it('[ROW-CLOCK-2] a tick re-derives no tool group, while the running tail still moves', async () => {
  const container = await renderRunning();
  // Non-vacuity: the spy sees both turns' groups at mount.
  expect(derivedCallIds()).toEqual(expect.arrayContaining(['old-1', 'old-2', 'live-1']));
  await emit({ type: 'tool.started', timestamp: NOW - 5_000, payload: { toolCallId: 'live-1' } });

  // NOT ONE group is derived again on a tick — the clock reaches the row
  // through context, below the memoized group. Asserted before the text so a
  // missing tail cannot mask a re-derivation.
  deriveSpy.mockClear();
  await tick();
  expect(deriveSpy, 'a tick must not re-run deriveToolGroupRows').not.toHaveBeenCalled();
  await tick(10_000);
  expect(deriveSpy).not.toHaveBeenCalled();
  expect(container.textContent).toContain('· 16s / 30m');
});

it('[ROW-CLOCK-3] a tool event re-derives the running turn only, never a finished one', async () => {
  await renderRunning();
  expect(derivedCallIds()).toEqual(expect.arrayContaining(['old-1', 'old-2', 'live-1']));

  // Each tool event changes the registry, and with it the start lookup. Only
  // the running turn holds that lookup; the finished turn keeps its rows.
  deriveSpy.mockClear();
  await emit({ type: 'tool.started', timestamp: NOW, payload: { toolCallId: 'live-1' } });
  await emit({ type: 'tool.completed', timestamp: NOW, payload: { toolCallId: 'old-2' } });
  await emit({ type: 'tool.started', timestamp: NOW, payload: { toolCallId: 'elsewhere' } });
  const rederived = derivedCallIds();
  // The running turn does re-derive (its rows read the new lookup)...
  expect(rederived).toContain('live-1');
  // ...and the finished one does not.
  expect(rederived, 'the finished turn was re-derived by a tool event').not.toContain('old-1');
  expect(rederived).not.toContain('old-2');
});
