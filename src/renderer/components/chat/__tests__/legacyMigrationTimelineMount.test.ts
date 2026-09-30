// @vitest-environment happy-dom
/**
 * dsh-rebase P1-9e (decisions 050, 122, 123): what the timeline shows about
 * moving a chat from the previous version to the current engine, mounted in
 * the real `MessageTimeline`:
 *
 * - while this window's resume moves the chat, a progress notice sits where
 *   the history card sits, and replaces the card of an earlier attempt;
 * - a failed move gets its own card, naming what stopped it and the code Main
 *   gave, with a Retry that re-runs the resume exactly when Main marked the
 *   failure retryable.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { encodePiResumeError } from '../historyError';
import { MessageTimeline } from '../MessageTimeline';

const resumeMock = vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
  return { resume: (() => Promise.resolve(false)) as (...args: unknown[]) => Promise<boolean> };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => 'glm/glm-5' }));
vi.mock('../sessionIndex/useResumeSession', () => ({
  useResumeSession: () => ({ resume: (...args: unknown[]) => resumeMock.resume(...args) }),
}));

const RETRYABLE =
  "Error invoking remote method 'chat:resumeSession': Error: legacy_migration_failed:read/source_busy: Session s1 could not be moved to the current chat engine (retryable)";
const FINAL =
  "Error invoking remote method 'chat:resumeSession': Error: legacy_migration_failed:read/source_missing: Session s1 could not be moved to the current chat engine";

let root: Root | undefined;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's1', status: 'idle', thinkingEnabled: false })
      )
    )
  );
}

function failWith(message: string) {
  useChatSessionsStore.setState({
    historyErrors: { s1: encodePiResumeError(new Error(message)).encoded },
  });
}

const buttons = () => [...container.querySelectorAll('button')];
const retryButton = () => buttons().find((button) => button.textContent?.trim() === 'Retry');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resumeMock.resume = vi.fn(async () => false);
  useTurnSendStatusStore.setState({ status: null });
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
        status: 'idle',
        updatedAt: 0,
        agent: 'pi',
        runtimeIdentity: '/profile/pi-agent/sessions/s1.jsonl',
      },
    ],
    messages: {
      s1: [
        {
          id: 'h:u1',
          sessionId: 's1',
          role: 'user',
          blocks: [{ id: 'u', type: 'text', text: 'OLD-QUESTION' }],
        },
        {
          id: 'h:a1',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ id: 'a', type: 'text', text: 'Old answer.' }],
        },
      ],
    },
    historyErrors: {},
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

describe('moving a legacy chat, in the timeline (P1-9e)', () => {
  it('[P9E-MOUNT-FAIL] a failed move names what stopped it and its code, and offers Retry when it may pass', async () => {
    failWith(RETRYABLE);
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('This chat could not be moved to the current engine');
    expect(text).toContain('Its file was being written by another program at the time.');
    expect(text).toContain('Error code: read/source_busy');
    // The history the preview loaded stays on screen under the card.
    expect(text).toContain('OLD-QUESTION');

    const retry = retryButton();
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(resumeMock.resume).toHaveBeenCalledWith('s1', { model: 'glm/glm-5' });
  });

  it('[P9E-MOUNT-FINAL] a move that fails the same way every time offers no Retry', async () => {
    failWith(FINAL);
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('The file this chat was saved in is no longer on disk.');
    expect(text).toContain('Error code: read/source_missing');
    expect(text).toContain('Start a new chat to carry on; this one stays viewable as it is.');
    expect(retryButton()).toBeUndefined();
  });

  it('[P9E-MOUNT-PROGRESS] the move in flight replaces the card, and the answer replaces the notice', async () => {
    failWith(RETRYABLE);
    await render();
    await act(async () => useLegacyMigrationStore.getState().begin('s1'));
    let text = container.textContent ?? '';
    expect(text).toContain('Moving this chat to the current engine…');
    expect(text).not.toContain('This chat could not be moved to the current engine');
    expect(retryButton()).toBeUndefined();
    expect(text).toContain('OLD-QUESTION');

    await act(async () => useLegacyMigrationStore.getState().end('s1'));
    text = container.textContent ?? '';
    expect(text).not.toContain('Moving this chat to the current engine…');
    expect(text).toContain('This chat could not be moved to the current engine');
  });

  it('[P9E-MOUNT-OTHER] another chat’s move shows nothing here', async () => {
    await render();
    await act(async () => useLegacyMigrationStore.getState().begin('s2'));
    expect(container.textContent ?? '').not.toContain('Moving this chat');
  });
});

/**
 * dsh-rebase P1-7e (problem 25, decision 139). Both notices used to be the
 * timeline's FIRST item: in a chat with history the user, who had just pressed
 * Send at the bottom, saw only their message bounce back into the composer —
 * the card saying why, and its Retry, were hundreds of pixels up. They now
 * come after the conversation, where the session-failed card is.
 */
describe('where the notices sit (P1-7e problem 25)', () => {
  /** The element whose own text is exactly `text`. */
  function elementWithText(text: string): Element {
    const found = [...container.querySelectorAll('*')].find(
      (element) => element.childElementCount === 0 && element.textContent?.trim() === text
    );
    if (!found) throw new Error(`no element reads ${text}`);
    return found;
  }

  const follows = (later: Element, earlier: Element) =>
    (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('[P7E-25-CARD] the failure card comes after the last turn', async () => {
    failWith(FINAL);
    await render();
    const card = container.querySelector('[role="alert"]');
    expect(card?.textContent).toContain('This chat could not be moved to the current engine');
    expect(follows(card as Element, elementWithText('Old answer.'))).toBe(true);
  });

  it('[P7E-25-PROGRESS] so does the notice while the move runs', async () => {
    await render();
    await act(async () => useLegacyMigrationStore.getState().begin('s1'));
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('Moving this chat to the current engine…');
    expect(follows(notice as Element, elementWithText('Old answer.'))).toBe(true);
  });
});

/**
 * P1-7e e6 (problem 38, decision 145): the `source_missing` card landed within
 * a layout of the send and the follower left it 46px short, its last lines and
 * 「详情」 behind the composer. The card's arrival now scrolls it into view by
 * itself. happy-dom lays nothing out, so the viewport's geometry is given.
 */
describe('a notice at the end brings itself into view (P1-7e e6, problem 38)', () => {
  function viewportWithGeometry(clientHeight: number) {
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) throw new Error('no timeline viewport');
    const geometry = { scrollHeight: 1000 };
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => geometry.scrollHeight,
    });
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
    return { viewport, geometry };
  }

  async function scrollTo(viewport: HTMLElement, top: number) {
    await act(async () => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event('scroll'));
    });
  }

  it('[E6-38-MOUNT] from the dead band the follower leaves (46px short), the card ends in view', async () => {
    await render();
    const { viewport, geometry } = viewportWithGeometry(500);
    // 46px from the bottom: past the follow threshold, short of the jump button.
    await scrollTo(viewport, 454);
    geometry.scrollHeight = 1200;
    await act(async () => failWith(FINAL));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(viewport.scrollTop).toBe(700);
  });

  it('[E6-38-MOUNT-AWAY] a reader scrolled well up keeps their place', async () => {
    await render();
    const { viewport, geometry } = viewportWithGeometry(500);
    await scrollTo(viewport, 100);
    geometry.scrollHeight = 1200;
    await act(async () => failWith(FINAL));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(viewport.scrollTop).toBe(100);
  });
});
