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
 *   model`, decision 165's `… requires adaptive thinking`): a card that sends
 *   the user to the per-model thinking switches, the raw text kept, and no
 *   Continue (resending fails the same way).
 */

import { dshFailureErrorCode } from '@shared/dshFailureCodes';
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
const SETTING_HINT_ZH =
  '如果是你自己添加的 AI 服务，请在「设置 · 模型 · AI 服务」里编辑该服务，在「模型设置」中选中该模型：Claude Opus 4.6 / Sonnet 4.6 及之后的模型要打开「自适应思考」（接口风格为 Anthropic Messages），更早的模型要关闭它；也可以关掉这个模型的「推理」。如果是管理员提供的模型，请把错误详情转给管理员。改好后再发一次消息。';

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

it('[E2B-CARD-SETTING-DOM] a refused model setting: points at the per-model switches, no Continue', async () => {
  fail(SETTING, 'MODEL_SETTING_UNSUPPORTED');
  const card = await render();
  const text = card.textContent ?? '';
  expect(text).toContain('模型设置与该模型不兼容');
  expect(text).toContain(SETTING_HINT_ZH);
  expect(text).toContain('is not supported for this model');
  expect(card.querySelector('[data-testid="failure-continue"]')).toBeNull();
});

/** Decision 165: issue #4's own text, classified the way the bridge does it. */
const REQUIRES_ADAPTIVE =
  '400 {"error":{"type":"<nil>","message":"claude-opus-5-5 requires adaptive thinking; omit thinking or use ***.type=adaptive and output_config.effort (request id: x)"}}';

it('[AT-CARD-DOM] an adaptive-only model sent budget thinking: the settings card, no Continue', async () => {
  const errorCode = dshFailureErrorCode({ message: REQUIRES_ADAPTIVE, code: 'INVALID_REQUEST' });
  expect(errorCode).toBe('MODEL_SETTING_UNSUPPORTED');
  fail(REQUIRES_ADAPTIVE, errorCode ?? '');
  const card = await render();
  const text = card.textContent ?? '';
  expect(text).toContain('模型设置与该模型不兼容');
  expect(text).toContain(SETTING_HINT_ZH);
  expect(text).toContain('requires adaptive thinking');
  const buttons = [...card.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).not.toContain('继续');
  expect(buttons).not.toContain('仍然继续');
  expect(card.querySelector('[data-testid="failure-continue"]')).toBeNull();
});

/** Decision 146 (GW-2): the gateway has no upstream left for this model. */
const NO_UPSTREAM =
  '503: {"message":"No available providers (cch_session_id: s-1)","type":"no_available_providers","code":"no_available_providers"}';

it('[GW2-CARD-DOM] a gateway with no upstream left: its own card, the raw text, a Continue that warns', async () => {
  fail(NO_UPSTREAM, 'GATEWAY_NO_UPSTREAM');
  const card = await render();
  const text = card.textContent ?? '';
  expect(text).toContain('公司网关目前没有可用的模型服务');
  expect(text).toContain('马上重试只会得到同样的答复，所以没有自动重试。');
  // Kept as the gateway wrote it: its session marker is what the administrator looks up.
  expect(text).toContain('no_available_providers');
  expect(text).toContain('cch_session_id: s-1');
  const buttons = [...card.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).toContain('仍然继续');
  expect(buttons).not.toContain('继续');
});
