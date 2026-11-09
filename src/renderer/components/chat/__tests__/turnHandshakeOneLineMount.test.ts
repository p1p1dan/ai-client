// @vitest-environment happy-dom
/**
 * S-6 feedback 11c (user, 2026-10-17): right after a send the turn shows ONE line,
 * verb first (`turnLiveHead.ts`): 「✻ 正在连接对话引擎… 1 秒」 while it connects,
 * then 「✻ 思考中 2 秒 · ↑ 5 字符」 until the first byte. Before, the clock line and a
 * status row under it both counted the same seconds (「✻ 工作中 2 秒」 over
 * 「正在连接对话引擎… · 2s」, then over 「思索中… · ↑ 5 字符 · 2s」).
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetHistoryLoadingForTests } from '@/stores/historyLoading';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { type OwnedTurnSendStatus, useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { MessageTimeline } from '../MessageTimeline';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
// Decision 208: the one line below is the desktop style's words; the terminal
// style's own line (`✻ Thinking… (2s · esc 中断)`, decision 211's words) has its
// twins at the end.
const settings = vi.hoisted(() => ({
  state: { showToolDiff: false, chatTranscriptStyle: 'desktop' as 'desktop' | 'terminal' },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof settings.state) => unknown) => selector(settings.state),
    { getState: () => settings.state }
  ),
}));
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => 'glm/glm-5' }));
vi.mock('../sessionIndex/useResumeSession', () => ({
  useResumeSession: () => ({ resume: async () => false }),
}));

// Decision 211 (user, 2026-11-09): the live words are the CLI's English verbs,
// the thought row's own `Thinking…`; 「正在连接对话引擎…」 / 「思考中」 are gone.
const CONNECTING = 'Connecting…';

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

function sendStatus(phase: OwnedTurnSendStatus['phase'], waitedSeconds = 2): OwnedTurnSendStatus {
  return {
    owner: 1,
    sessionId: 's1',
    phase,
    elapsedSeconds: waitedSeconds,
    turnStartedAtMs: Date.now() - waitedSeconds * 1_000,
    budgetMs: 60_000,
    attachmentCount: 0,
    attachmentBytes: 0,
    promptChars: 5,
  };
}

/**
 * The send's echo has landed: the turn exists, with nothing in its body yet. The
 * session is not reported running until the reply starts, so the timeline sees `idle`
 * (`running` hides the last turn's status row altogether). `echoed: false` is the
 * empty chat whose first send has no turn yet: the pending head speaks for it.
 */
async function sent(phase: OwnedTurnSendStatus['phase'], waitedSeconds = 2, echoed = true) {
  await act(async () => {
    useChatSessionsStore.setState((state) => ({
      messages: {
        ...state.messages,
        s1: echoed
          ? [
              {
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                blocks: [{ id: 'b', type: 'text', text: 'hi' }],
              },
            ]
          : [],
      },
    }));
    useTurnSendStatusStore.setState({
      status: sendStatus(phase, waitedSeconds),
      baseline: { sessionId: 's1', messageId: null },
    });
  });
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, {
          sessionId: 's1',
          status: 'idle',
          thinkingEnabled: false,
        })
      )
    )
  );
}

const text = () => container.textContent ?? '';
const count = (needle: string) => text().split(needle).length - 1;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  settings.state.chatTranscriptStyle = 'desktop';
  resetHistoryLoadingForTests();
  useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReplies: {} });
  usePendingUserMessagesStore.setState({ bySession: {} });
  useLegacyMigrationStore.setState({ migrating: {}, postureRevisions: {} });
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
        agent: 'dsh',
        runtimeIdentity: '/sessions/s1.jsonl',
      },
    ],
    messages: {},
    historyErrors: {},
    historyPagination: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
  client = new QueryClient();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  resetHistoryLoadingForTests();
  vi.unstubAllGlobals();
});

describe('a send still connecting, in the timeline', () => {
  it('[THS-01] the line says it is connecting, verb first; no second row counts the seconds', async () => {
    await sent('handshake');
    const lines = [...container.querySelectorAll('span[title]')]
      .map((node) => node.getAttribute('title') ?? '')
      .filter((title) => title.includes(CONNECTING));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Connecting… \d+s$/);
    expect(count(CONNECTING)).toBe(1);
    expect(text()).not.toContain(`${CONNECTING} · `);
  });

  it('[THS-02] once connected, it says it is thinking on the same one line (no ↑ count since 2026-10-19)', async () => {
    await sent('awaiting');
    expect(text()).not.toContain(CONNECTING);
    const lines = [...container.querySelectorAll('span[title]')]
      .map((node) => node.getAttribute('title') ?? '')
      .filter((title) => title.startsWith('Thinking'));
    expect(lines).toEqual([expect.stringMatching(/^Thinking… \d+s$/)]);
    // The status row that repeated the sent count and its own seconds is gone.
    // 2026-10-19 (user): the one line carries no ↑ count.
    expect(count('↑ 5 chars')).toBe(0);
  });

  it('[THS-03] a slow wait keeps its second row: the hint the one line cannot carry', async () => {
    await sent('awaiting', 50);
    expect(text()).toMatch(/Thinking… \d+s/);
    expect(text()).toContain('Still waiting · 50s');
    expect(text()).toContain('gateway latency varies');
  });

  it('[THS-04] the pending head of a first send says the same one line', async () => {
    await sent('awaiting', 2, false);
    expect(text()).toMatch(/Thinking… \d+s/);
    expect(container.querySelectorAll('[data-slot="turn-live-line"]')).toHaveLength(1);
    // 2026-10-19 (user): the one line carries no ↑ count.
    expect(count('↑ 5 chars')).toBe(0);
    expect(text()).not.toMatch(/ · \d+s$/);
    expect(text()).not.toContain('思考中');
  });
});

/**
 * Decision 208, terminal style (user ruling 2026-11-03, the comparison
 * mockup's ①): the same one line, in the CLI's words — what the turn is doing,
 * then how long and how to stop it. The star is a pseudo-element, not text.
 */
describe('a send still connecting, in the terminal style', () => {
  beforeEach(() => {
    settings.state.chatTranscriptStyle = 'terminal';
  });
  const liveLine = () => container.querySelector('[data-slot="turn-live-line"]')?.textContent ?? '';

  it('[THS-T1] connecting, on one line, with the clock and the stop key after it', async () => {
    await sent('handshake');
    expect(liveLine()).toMatch(/^Connecting… \(\d+s · esc to interrupt\)$/);
    expect(count(CONNECTING)).toBe(1);
  });

  it('[THS-T4] the pending head of a first send draws the very same line', async () => {
    await sent('awaiting', 2, false);
    expect(container.querySelectorAll('[data-slot="turn-live-line"]')).toHaveLength(1);
    expect(liveLine()).toMatch(/^Thinking… \(\d+s · esc to interrupt\)$/);
  });

  it('[THS-T2] then thinking, on the same line', async () => {
    await sent('awaiting');
    expect(text()).not.toContain(CONNECTING);
    expect(liveLine()).toMatch(/^Thinking… \(\d+s · esc to interrupt\)$/);
    expect(count('↑ 5 chars')).toBe(0);
  });

  it('[THS-T3] a slow wait still keeps its second row', async () => {
    await sent('awaiting', 50);
    expect(liveLine()).toMatch(/^Thinking… \(\d+s · esc to interrupt\)$/);
    expect(text()).toContain('Still waiting · 50s');
  });
});
