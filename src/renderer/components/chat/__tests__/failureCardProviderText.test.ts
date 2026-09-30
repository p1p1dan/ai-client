// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e (decision 140), rendered: the two provider failures the
 * bridge reads off their text.
 *
 * - a company gateway's stream gate (`stream_gate_precommit` /
 *   `prebuffer_overflow`): its own card, the raw text kept as the detail, and
 *   a Continue that says it is a long shot — 「仍然继续」 beside the hint that
 *   retrying the same request usually fails again;
 * - a parameter the model does not take (`… is not supported for this
 *   model`): a card that sends the user to the model's thinking settings, the
 *   raw text kept, and no Continue (resending fails the same way).
 */

import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { useContinueIntentStore } from '@/stores/continueIntent';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { MessageTimeline } from '../MessageTimeline';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
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

const GATE =
  '502 {"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow","family":"anthropic"}}';
const SETTING = '400 "thinking.type.disabled" is not supported for this model';

let seq = 0;
function push(event: Omit<RuntimeEvent, 'seq' | 'timestamp'>) {
  seq += 1;
  const stamped = { ...event, seq, timestamp: seq } as RuntimeEvent;
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), stamped),
  }));
}

function fail(error: string, errorCode: string) {
  push({
    type: 'session.failed',
    sessionId: 's1',
    requestId: 'send-1',
    payload: { error, errorCode },
  } as Omit<RuntimeEvent, 'seq' | 'timestamp'>);
  push({
    type: 'session.status',
    sessionId: 's1',
    requestId: 'send-1',
    payload: { status: 'idle' },
  } as Omit<RuntimeEvent, 'seq' | 'timestamp'>);
}

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
        createElement(MessageTimeline, {
          sessionId: 's1',
          status: 'failed',
          thinkingEnabled: false,
        })
      )
    )
  );
  const card = container.querySelector<HTMLElement>('[role="alert"]');
  expect(card, 'the failure card').not.toBeNull();
  return card as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
          blocks: [{ id: 'u', type: 'text', text: 'hello' }],
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

it('[E2B-CARD-GATE-DOM] the stream gate: its own card, the raw text, and a Continue that warns', async () => {
  fail(GATE, 'GATEWAY_STREAM_GATE');
  const card = await render();
  const text = card.textContent ?? '';
  expect(text).toContain('公司网关中断了这次回复');
  expect(text).toContain('公司网关在模型开始回答之前中断了这次回复。');
  expect(text).toContain(
    '重试同一请求通常还会失败。请换一个模型或调低思考档位，并把错误详情转给网关管理员。'
  );
  // The detail the gateway administrator needs, as the gateway wrote it.
  expect(text).toContain('stream_gate_precommit');
  expect(text).toContain('prebuffer_overflow');
  const buttons = [...card.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).toContain('仍然继续');
  expect(buttons).not.toContain('继续');
  const button = [...card.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === '仍然继续'
  );
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(useContinueIntentStore.getState().pending).toMatchObject({
    kind: 'retry',
    sessionId: 's1',
  });
});

it('[E2B-CARD-SETTING-DOM] a refused model setting: points at the thinking settings, no Continue', async () => {
  fail(SETTING, 'MODEL_SETTING_UNSUPPORTED');
  const card = await render();
  const text = card.textContent ?? '';
  expect(text).toContain('模型设置与该模型不兼容');
  expect(text).toContain('请在模型设置里检查这个模型的思考相关配置，改好后再发一次消息。');
  expect(text).toContain('is not supported for this model');
  expect(card.querySelector('[data-testid="failure-continue"]')).toBeNull();
});
