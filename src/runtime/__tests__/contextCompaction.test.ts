/**
 * The P1-9 ∥ P2-8 pair, end to end: the tool the model calls, the reminder that
 * tells it the tool exists, and the turn boundary where the intent turns into a
 * new context window.
 *
 * The pair is what these tests are really about. `budget.ts` and
 * `compaction.ts` are pure and tested on their own; the failure this file
 * exists to prevent is the half-landed version — a tool that queues an intent
 * nobody consumes, or a reminder that names a tool the model cannot call.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { contextBudget, reminderThreshold } from '../plugins/context/budget.ts';
import {
  CHECKPOINT_TRUNCATION_MARKER,
  CONTEXT_ROLLOVER_SUMMARY,
} from '../plugins/context/compaction.ts';
import type { CompactionFamily } from '../plugins/tools/new-context.ts';

const WINDOW = { contextWindow: 32_000, maxTokens: 4_096 };

let dir: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-context-'));
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

function provider(models: { contextWindow?: number; maxTokens?: number } = {}) {
  return fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', ...WINDOW, ...models }],
  });
}

async function runtime(
  options: Partial<RuntimeBootstrapOptions> & { faux?: ReturnType<typeof fauxProvider> } = {}
) {
  const faux = options.faux ?? provider();
  const { faux: _ignored, ...rest } = options;
  const handle = await createRuntime({
    providers: [faux.provider],
    env: {},
    host: standaloneHost({ PATH: process.env.PATH }),
    ...rest,
  });
  runtimes.push(handle);
  return { handle, faux };
}

/** The active model, so every threshold in a test comes from the same window. */
function activeModel(handle: RuntimeHandle): Model<Api> {
  const ref = handle.model.defaultRef();
  if (!ref) throw new Error('faux catalog is empty');
  return handle.model.resolve(ref).model;
}

function models(handle: RuntimeHandle) {
  const ref = handle.model.defaultRef();
  if (!ref) throw new Error('faux catalog is empty');
  return handle.model.resolve(ref).models;
}

/** A user message whose char-based estimate is the requested token count. */
function sized(tokens: number, marker = 'x'): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: marker.repeat(Math.max(1, tokens) * 4) }],
    timestamp: Date.now(),
  };
}

function text(message: AgentMessage): string {
  // A checkpoint message carries its text in `summary`, not `content`; the
  // provider only sees the `content` form after `convertToLlm`.
  if (message.role === 'compactionSummary') return message.summary;
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        (block as { type?: string }).type === 'text'
    )
    .map((block) => block.text)
    .join('');
}

async function prepare(
  handle: RuntimeHandle,
  messages: AgentMessage[],
  extra: { retention?: 'active_turn' | 'completed_turn' } = {}
) {
  const service = handle.context;
  if (!service) throw new Error('the context service is not registered');
  return service.prepareTurn({
    messages,
    model: activeModel(handle),
    models: models(handle),
    ...extra,
  });
}

describe('P1-9 ∥ P2-8: new_context and the boundary that honours it', () => {
  it.each([
    'summary',
    'fresh_window',
  ] as const)('keeps the real task when a budget reminder precedes %s compaction', async (family) => {
    const { handle, faux } = await runtime({ tools: { cwd: dir }, context: { family } });
    const budget = contextBudget(WINDOW, 0);
    const task = 'ORIGINAL_TASK: finish the requested change';
    const prompt = `${task}\n${'x'.repeat((budget.hardLimit - reminderThreshold(budget) + 500) * 4)}`;
    const requests: AgentMessage[][] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('glob', { pattern: '*' })], { stopReason: 'toolUse' }),
      (context) => {
        expect(context.messages.map(text).join('\n')).toContain('<context_budget>');
        return fauxAssistantMessage([fauxToolCall('new_context', {})], { stopReason: 'toolUse' });
      },
      ...(family === 'summary' ? [fauxAssistantMessage('checkpoint summary')] : []),
      (context) => {
        requests.push([...context.messages]);
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await handle.run({ prompt, systemPrompt: 'stable prefix' });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(text(requests[0].at(-1) as AgentMessage)).toContain(task);
    expect(text(requests[0].at(-1) as AgentMessage)).not.toContain('<context_budget>');
  });

  it('rejects an oversized first prompt before any provider request, preserving the trace', async () => {
    const { handle, faux } = await runtime({ context: { family: 'summary' } });
    faux.setResponses([]);
    const prompt = `OVERSIZED_TASK ${'x'.repeat(160_000)}`;
    const result = await handle.run({ prompt, systemPrompt: 'probe' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('context_too_large');
    expect(result.turns).toBe(0);
    expect(faux.state.callCount).toBe(0);
    expect(result.trace.input).toBe(prompt);
  });

  it('includes the system prompt in the first-request budget', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([]);
    const result = await handle.run({ prompt: 'hi', systemPrompt: 'x'.repeat(80_000) });
    expect(result.error?.code).toBe('context_too_large');
    expect(faux.state.callCount).toBe(0);
  });

  it('registers the tool with the consumer, and keeps it usable in plan mode', async () => {
    const { handle } = await runtime({
      tools: { cwd: dir },
      permissions: { mode: 'plan', gear: 'ask' },
      context: { family: 'summary' },
    });
    const tool = handle.ctx.runtimeTools.list().find((entry) => entry.name === 'new_context');
    expect(tool).toBeDefined();
    expect(handle.context?.compactionTool).toBe('new_context');
    // Read access: no approval, and plan mode does not strip it — read-only
    // exploration burns the window just as fast as editing does.
    expect(handle.context?.pendingNewWindow).toBe(false);
    await tool?.execute('call-1', {});
    expect(handle.context?.pendingNewWindow).toBe(true);
  });

  it('registers no tool when compaction is off, and then leaves the turn alone', async () => {
    const { handle } = await runtime({ tools: { cwd: dir }, context: { enabled: false } });
    expect(handle.ctx.runtimeTools.list().some((entry) => entry.name === 'new_context')).toBe(
      false
    );
    expect(handle.context?.compactionTool).toBeUndefined();
    const budget = contextBudget(WINDOW, 0);
    const prepared = await prepare(handle, [sized(budget.hardLimit + 1_000)]);
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.reminder).toBeUndefined();
    expect(prepared.messages).toHaveLength(1);
  });

  it('warns once per window, naming the tool it registered', async () => {
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    const inTier = budget.hardLimit - reminderThreshold(budget) + 500;
    const first = await prepare(handle, [sized(inTier)]);
    expect(first.reminder?.tier).toBe('approaching');
    expect(first.reminder?.text).toContain('new_context');
    // Carried as a trailing message: the system prompt is the cached prefix
    // ARD D9 gates on, so the reminder must not touch it.
    expect(first.messages).toHaveLength(2);
    expect(text(first.messages[1])).toContain('<context_budget>');
    const second = await prepare(handle, [sized(inTier)]);
    expect(second.reminder).toBeUndefined();
    expect(second.messages).toHaveLength(1);
  });

  it('says nothing about a tool it did not register', async () => {
    // No tools plugin, so nothing registered `new_context`; the wording has to
    // drop the sentence rather than promise a tool the model cannot call.
    const { handle } = await runtime({ context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    const prepared = await prepare(handle, [
      sized(budget.hardLimit - reminderThreshold(budget) + 500),
    ]);
    expect(prepared.reminder?.text).toContain('<context_budget>');
    expect(prepared.reminder?.text).not.toContain('new_context');
  });

  it('rolls the window over when the model asks, without a provider request', async () => {
    const { handle, faux } = await runtime({
      tools: { cwd: dir },
      context: { family: 'fresh_window' },
    });
    faux.setResponses([]);
    handle.context?.requestNewWindow();
    const prepared = await prepare(handle, [sized(100), sized(100, 'y')]);
    expect(prepared.compaction).toMatchObject({
      reason: 'model_requested',
      family: 'fresh_window',
    });
    // The rollover says why the context changed instead of leaving the model to
    // guess, and retains nothing: buying the window back is the point.
    expect(prepared.messages).toHaveLength(1);
    expect(text(prepared.messages[0])).toContain(CONTEXT_ROLLOVER_SUMMARY);
    expect(faux.state.callCount).toBe(0);
    // The intent is consumed, not sticky.
    expect(handle.context?.pendingNewWindow).toBe(false);
    const next = await prepare(handle, [...prepared.messages, sized(100, 'z')]);
    expect(next.compaction).toBeUndefined();
  });

  it('keeps the active user message across a mid-turn boundary, clamped', async () => {
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    handle.context?.requestNewWindow();
    const budget = contextBudget(WINDOW, 0);
    // Larger than the retained-user-message budget, so the clamp has to bite.
    const prepared = await prepare(handle, [sized(budget.hardLimit)], {
      retention: 'active_turn',
    });
    expect(prepared.compaction?.retained).toBe(1);
    expect(prepared.messages).toHaveLength(2);
    expect(text(prepared.messages[1])).toContain(CHECKPOINT_TRUNCATION_MARKER.trim());
  });

  it('compacts at the hard limit even when the model never asked', async () => {
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    const prepared = await prepare(handle, [sized(budget.hardLimit + 1_000)]);
    expect(prepared.compaction?.reason).toBe('hard_limit');
    expect(prepared.compaction?.tokensAfter).toBeLessThan(budget.hardLimit);
  });

  it('spends one provider request on the summary family and keeps its usage', async () => {
    const faux = provider();
    const { handle } = await runtime({
      faux,
      tools: { cwd: dir },
      context: { family: 'summary' },
    });
    faux.setResponses([fauxAssistantMessage('a structured summary of the work so far')]);
    handle.context?.requestNewWindow();
    const prepared = await prepare(handle, [sized(200)]);
    expect(faux.state.callCount).toBe(1);
    expect(prepared.compaction).toMatchObject({ reason: 'model_requested', family: 'summary' });
    expect(text(prepared.messages[0])).toContain('a structured summary of the work so far');
    expect(prepared.compaction?.usage).toBeDefined();
  });

  it('updates its own checkpoint on a second rotation instead of summarizing it again', async () => {
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.messages.map((message) => text(message as AgentMessage)).join('\n'));
        return fauxAssistantMessage('first summary');
      },
      (context) => {
        prompts.push(context.messages.map((message) => text(message as AgentMessage)).join('\n'));
        return fauxAssistantMessage('second summary');
      },
    ]);
    handle.context?.requestNewWindow();
    const first = await prepare(handle, [sized(200)]);
    handle.context?.requestNewWindow();
    const second = await prepare(handle, [...first.messages, sized(200, 'y')]);
    // pi is handed the previous checkpoint as a real compaction entry, so the
    // second pass updates that summary rather than summarizing the summary.
    expect(prompts[1]).toContain('<previous-summary>');
    expect(prompts[1]).toContain('first summary');
    expect(text(second.messages[0])).toContain('second summary');
  });

  it('carries on uncompacted when a requested summary fails below the limit', async () => {
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summarizer offline' }),
    ]);
    handle.context?.requestNewWindow();
    const messages = [sized(200)];
    const prepared = await prepare(handle, messages);
    // Nothing is over the boundary yet, so a failed courtesy compaction is not
    // worth ending the run over.
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.skipped?.code).toBe('compaction_summary_failed');
    expect(prepared.messages).toEqual(messages);
  });

  it('fails the turn when the same summary fails at the hard limit', async () => {
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summarizer offline' }),
    ]);
    const budget = contextBudget(WINDOW, 0);
    await expect(prepare(handle, [sized(budget.hardLimit + 1_000)])).rejects.toMatchObject({
      code: 'context_compaction_failed',
    });
  });

  it.each([
    'summary',
    'fresh_window',
  ] as const)('consumes the %s intent at the next turn boundary of a real run', async (family: CompactionFamily) => {
    const faux = provider();
    const { handle } = await runtime({
      faux,
      tools: { cwd: dir },
      permissions: { gear: 'auto' },
      context: { family },
    });
    const requests: { systemPrompt: string; messages: AgentMessage[] }[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('new_context', {}, { id: 'call-1' })], {
        stopReason: 'toolUse',
      }),
      ...(family === 'summary' ? [fauxAssistantMessage('summary of the run so far')] : []),
      (context) => {
        requests.push({
          systemPrompt: context.systemPrompt ?? '',
          messages: [...context.messages],
        });
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await handle.run({ prompt: 'work then rotate', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(result.text).toBe('done');
    const compaction = result.trace.steps.find((step) => step.detail.event === 'compaction');
    expect(compaction?.detail).toMatchObject({ reason: 'model_requested', family });
    // The next request runs on the checkpoint: the tool call and its result
    // are gone with the history they belonged to, so nothing reaches the
    // provider as an orphaned tool call.
    const last = requests.at(-1);
    expect(last?.systemPrompt).toBe('probe');
    expect(last?.messages.some((message) => message.role === 'toolResult')).toBe(false);
    expect(last?.messages.some((message) => message.role === 'assistant')).toBe(false);
    expect(text(last?.messages[0] as AgentMessage)).toContain(
      family === 'fresh_window' ? CONTEXT_ROLLOVER_SUMMARY : 'summary of the run so far'
    );
  });
});
