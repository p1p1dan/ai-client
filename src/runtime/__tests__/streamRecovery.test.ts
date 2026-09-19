import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRetryBudget,
  createProviderRetryStream,
  PROVIDER_TRANSIENT_MAX_RETRIES,
} from '../plugins/agent-loop/providerRetry.ts';
import {
  claimStreamRetry,
  type RecoverableAgent,
  recoverPendingStream,
} from '../plugins/agent-loop/streamRecovery.ts';

/**
 * T093 / decision 029 clause 4 — the stream phase and the request phase are two
 * halves of ONE allowance.
 *
 * The recovery itself used to be a private method on `SubagentRun`, so the main
 * conversation could not survive a cut stream at all. These cases pin the two
 * properties that make the shared version safe: it rewinds exactly one message,
 * and it spends the same budget the request phase does — PI-Desktop's rule, and
 * the one that stops a turn from quietly getting six retries instead of three.
 */

const model = {
  id: 'model',
  api: 'openai-completions',
  provider: 'provider',
  name: 'Model',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
  baseUrl: 'https://provider.invalid/v1',
} as never;

const context = { messages: [], tools: [] } as never;

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'provider',
    model: 'model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: '503: service unavailable',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** A setup failure: the request never produced a `start` event. */
function failedStream() {
  const stream = createAssistantMessageEventStream();
  const error = assistantMessage();
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error });
    stream.end(error);
  });
  return stream;
}

/** Spend `count` retries in the REQUEST phase, the way a dead gateway does. */
async function spendRequestPhase(
  controller: ReturnType<typeof createProviderRetryBudget>['controller'],
  count: number
): Promise<void> {
  let attempts = 0;
  const stream = createProviderRetryStream(
    model,
    context,
    {},
    () => {
      attempts += 1;
      return failedStream();
    },
    {
      ...controller,
      // Stop the wrapper after `count` failures so the rest of the budget is
      // left for the stream phase below.
      claim: (error) => (attempts > count ? undefined : controller.claim(error)),
    }
  );
  await stream.result();
}

function fakeAgent(messages: AgentMessage[]): RecoverableAgent & {
  continued: number;
} {
  return {
    state: { messages },
    continued: 0,
    async continue() {
      this.continued += 1;
    },
    async waitForIdle() {},
  };
}

describe('stream-phase recovery', () => {
  it('does not reset the budget between the request phase and the stream phase', async () => {
    const created = createProviderRetryBudget({ sleep: async () => {} });
    // Two failures before any stream opened.
    await spendRequestPhase(created.controller, 2);

    // A third failure, this time from a stream that HAD started.
    // The stream phase only claims for a failure the PROVIDER reported; a
    // local throw wearing pi's `stopReason: "error"` must never spend a retry.
    created.controller.noteProviderStreamFailure();
    const third = claimStreamRetry(assistantMessage(), created.controller);
    expect(third.pending?.attempt).toBe(PROVIDER_TRANSIENT_MAX_RETRIES);
    expect(third.failure).toBeUndefined();

    // ...and that is the whole allowance. Not three more, and not six in total.
    created.controller.noteProviderStreamFailure();
    const fourth = claimStreamRetry(assistantMessage(), created.controller);
    expect(fourth.pending).toBeUndefined();
    expect(fourth.failure).toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('does not re-ask when the failure came from us rather than from the provider', async () => {
    // pi's `Agent` turns EVERY throw inside its loop into an assistant message
    // with `stopReason: "error"` — a session append that failed, a compaction
    // checkpoint that could not be persisted, a listener that threw. Those wear
    // a provider failure's clothes, and spending the 3 + 10 + 30 second ladder
    // on a full disk would be 43 seconds of a banner promising recovery from
    // something a second attempt cannot fix.
    const created = createProviderRetryBudget({ sleep: async () => {} });
    const verdict = claimStreamRetry(
      assistantMessage({ errorMessage: 'checkpoint write failed' }),
      created.controller
    );
    expect(verdict.pending).toBeUndefined();
    // Reported, not swallowed: the turn still fails, and it says why.
    expect(verdict.failure).toMatchObject({ message: 'checkpoint write failed' });
    // ...and the budget is untouched, so a genuine provider failure later in
    // the same run still has its full allowance.
    created.controller.noteProviderStreamFailure();
    expect(claimStreamRetry(assistantMessage(), created.controller).pending?.attempt).toBe(1);
  });

  it('retries a stream that died mid-way from that same budget', async () => {
    const created = createProviderRetryBudget({ sleep: async () => {} });
    created.controller.noteProviderStreamFailure();
    const verdict = claimStreamRetry(assistantMessage(), created.controller);
    expect(verdict.pending).toBeDefined();

    const tool: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'the answer is 42' }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const agent = fakeAgent([tool, assistantMessage() as unknown as AgentMessage]);
    const rewound = vi.fn();

    const outcome = await recoverPendingStream({
      agent,
      pending: verdict.pending!,
      controller: created.controller,
      onRewind: rewound,
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.failure).toBeUndefined();
    expect(agent.continued).toBe(1);
    // Exactly one message dropped, and the tool result that already ran stays:
    // this is a retry, not a restart. Re-running the tool is what "restart"
    // would cost — for a delegate that writes files, twice.
    expect(rewound).toHaveBeenCalledTimes(1);
    expect(agent.state.messages).toEqual([tool]);
  });

  it('announces the wait and takes it back down around the re-ask', async () => {
    const order: string[] = [];
    const created = createProviderRetryBudget({
      sleep: async () => {
        order.push('slept');
      },
      onRetry: () => order.push('banner up'),
      onRetrySettled: () => order.push('banner down'),
    });
    created.controller.noteProviderStreamFailure();
    const verdict = claimStreamRetry(assistantMessage(), created.controller);
    const agent = fakeAgent([assistantMessage() as unknown as AgentMessage]);
    await recoverPendingStream({
      agent,
      pending: verdict.pending!,
      controller: created.controller,
    });
    // The banner must not come down before the wait it announced is over.
    expect(order).toEqual(['banner up', 'slept', 'banner down']);
  });

  it('refuses to guess when the transcript is not in the shape it rewinds', async () => {
    const created = createProviderRetryBudget({ sleep: async () => {} });
    created.controller.noteProviderStreamFailure();
    const verdict = claimStreamRetry(assistantMessage(), created.controller);
    const user = { role: 'user', content: 'hi', timestamp: Date.now() } as unknown as AgentMessage;
    const agent = fakeAgent([user]);
    const outcome = await recoverPendingStream({
      agent,
      pending: verdict.pending!,
      controller: created.controller,
    });
    expect(outcome.attempted).toBe(false);
    expect(outcome.failure).toMatchObject({ code: 'PROVIDER_ERROR' });
    // Nothing was dropped and nothing was re-asked.
    expect(agent.state.messages).toEqual([user]);
    expect(agent.continued).toBe(0);
  });

  it('never re-asks a request the user just cancelled', async () => {
    const created = createProviderRetryBudget({ sleep: async () => {} });
    created.controller.noteProviderStreamFailure();
    const verdict = claimStreamRetry(assistantMessage(), created.controller);
    const abort = new AbortController();
    abort.abort();
    const agent = fakeAgent([assistantMessage() as unknown as AgentMessage]);
    const outcome = await recoverPendingStream({
      agent,
      pending: verdict.pending!,
      controller: created.controller,
      signal: abort.signal,
    });
    expect(outcome.attempted).toBe(false);
    expect(agent.continued).toBe(0);
  });
});
