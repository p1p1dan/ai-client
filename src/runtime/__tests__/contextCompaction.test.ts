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
import type { AgentMessage, CompactionEntry } from '@earendil-works/pi-agent-core';
import {
  createCompactionSummaryMessage,
  estimateContextTokens,
} from '@earendil-works/pi-agent-core';
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
  extra: { retention?: 'active_turn' | 'completed_turn'; additionalTokens?: number } = {}
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

/**
 * T014 — the failure modes the P2-3 suite above could not see, because each one
 * needs a SECOND pass over the same window: a second `prompt()` in one run, a
 * second compaction over an imported checkpoint, a second run in one session.
 */
describe('T014 · compaction across a second pass', () => {
  it('re-prompts the same run on the compacted context, not the history it replaced', async () => {
    // context-prompt-01, and the acceptance case on the T014 roadmap row. The
    // boundary hook only replaced the LOOP's context; `agent.state.messages`
    // kept the full history, and `prompt()` rebuilds from that — so the
    // delegation report below started a request carrying everything the
    // compaction had just bought back.
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', ...WINDOW }],
    });
    let parentTurn = 0;
    const resumed: AgentMessage[][] = [];
    const route = async (context: { systemPrompt?: string; messages: unknown[] }) => {
      if (/You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return fauxAssistantMessage('EXPLORER-REPORT: it is at src/app.ts');
      }
      parentTurn += 1;
      if (parentTurn === 1) {
        return fauxAssistantMessage(
          [
            fauxToolCall('Task', { agent: 'explorer', task: 'look around' }, { id: 't1' }),
            fauxToolCall('new_context', {}, { id: 't2' }),
          ],
          { stopReason: 'toolUse' }
        );
      }
      if (parentTurn === 2) return fauxAssistantMessage('started the explorer');
      resumed.push([...(context.messages as AgentMessage[])]);
      return fauxAssistantMessage('integrated the report');
    };
    faux.setResponses(Array.from({ length: 16 }, () => route));
    const { handle } = await runtime({
      faux,
      tools: { cwd: dir },
      permissions: { gear: 'auto' },
      subagents: { home: join(dir, 'home') },
      loop: { singleTurn: false, defaultThinkingLevel: 'medium' },
      context: { family: 'fresh_window' },
    });
    const result = await handle.run({ prompt: 'find the thing', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(resumed).toHaveLength(1);
    // The provider sees the checkpoint already converted to a user message, so
    // the head is identified by its text rather than by `role`.
    const request = resumed[0];
    expect(text(request[0])).toContain(CONTEXT_ROLLOVER_SUMMARY);
    // The tool calls and their results went with the history they belonged to.
    expect(request.some((message) => message.role === 'toolResult')).toBe(false);
    expect(request.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(text(request.at(-1) as AgentMessage)).toContain('EXPLORER-REPORT');
  });

  it('records the files a merged retained tail touched in the checkpoint details', async () => {
    // context-prompt-02. pi derives `fileOps` from the messages before its own
    // cut point; everything after it was supposed to stay in the context. This
    // runtime merges that tail into the summarized range instead, so an edit
    // made in the last few thousand tokens disappeared from the checkpoint and
    // the model was told, right after editing, that it had touched nothing.
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    faux.setResponses([fauxAssistantMessage('a summary of the work so far')]);
    handle.context?.requestNewWindow();
    const edited = fauxAssistantMessage(
      [fauxToolCall('edit', { path: 'src/b.ts' }, { id: 'e1' })],
      {
        stopReason: 'toolUse',
      }
    ) as unknown as AgentMessage;
    const prepared = await prepare(handle, [sized(50, 'u'), edited]);
    expect(prepared.compaction).toBeDefined();
    const summary = text(prepared.messages[0]);
    expect(summary).toContain('<modified-files>');
    expect(summary).toContain('src/b.ts');
  });

  it('sheds the previous checkpoint tail when there is nothing new to compact', async () => {
    // context-prompt-04. Right after a `/compact` or a resume the context IS a
    // checkpoint, so pi has nothing to compact and used to end the run with
    // "there is nothing between the last checkpoint and now" — a message that
    // names neither the real cause nor anything the user can act on.
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    handle.context?.requestNewWindow();
    const first = await prepare(handle, [sized(budget.hardLimit)], { retention: 'active_turn' });
    expect(first.compaction?.retained).toBe(1);
    const second = await prepare(handle, first.messages, {
      additionalTokens: budget.hardLimit - 2_000,
    });
    expect(second.compaction).toMatchObject({
      reason: 'hard_limit',
      retained: 0,
      shedRetainedTail: true,
    });
    expect(second.messages).toHaveLength(1);
  });

  it('blames the pending input, not compaction, when shedding the tail is not enough', async () => {
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    handle.context?.requestNewWindow();
    const first = await prepare(handle, [sized(budget.hardLimit)], { retention: 'active_turn' });
    await expect(
      prepare(handle, first.messages, { additionalTokens: budget.hardLimit + 1_000 })
    ).rejects.toMatchObject({ code: 'context_too_large' });
  });

  it('holds the summarization request itself inside the model window', async () => {
    // context-prompt-05. pi caps the summary's OUTPUT and truncates each tool
    // result to 2000 characters, but user text, assistant text and tool-call
    // ARGUMENTS are serialized verbatim — so a turn that overshoots the limit
    // produces the one request that can buy the window back in a size the
    // provider will refuse, and at the hard limit there is no second try.
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    const asked: AgentMessage[][] = [];
    faux.setResponses([
      (context) => {
        asked.push([...(context.messages as AgentMessage[])]);
        return fauxAssistantMessage('a bounded summary');
      },
    ]);
    const budget = contextBudget(WINDOW, 0);
    const prepared = await prepare(handle, [sized(20_000, 'a'), sized(20_000, 'b')]);
    expect(prepared.compaction?.reason).toBe('hard_limit');
    // The oldest message did not fit and is reported rather than dropped silently.
    expect(prepared.compaction?.summaryInputDropped).toBe(1);
    expect(asked).toHaveLength(1);
    const tokens = estimateContextTokens(asked[0]).tokens;
    expect(tokens).toBeLessThan(WINDOW.contextWindow);
    // The output pi reserves rides on top of the input; both have to fit.
    expect(tokens + Math.floor(0.8 * budget.requestHeadroom)).toBeLessThan(WINDOW.contextWindow);
    expect(text(asked[0][0])).toContain('did not fit this summarization request');
  });

  it('keeps the message after an imported checkpoint whose tail lost a filtered entry', async () => {
    // context-prompt-08. `snapshot.messages` is filtered for failed assistant
    // messages; `checkpoint.retainedTail` is not. A pi CLI session where the
    // user interrupted a turn leaves exactly that mismatch, and counting the
    // stored length ate the first real message after the checkpoint — which
    // then reached neither the summary nor the retained tail.
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push((context.messages as AgentMessage[]).map(text).join('\n'));
        return fauxAssistantMessage('a second summary');
      },
    ]);
    const summary = createCompactionSummaryMessage('earlier work', 1_000, 1);
    const ghost: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'INTERRUPTED_TURN' }],
      timestamp: 1,
    };
    const kept: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'KEPT_TAIL' }],
      timestamp: 2,
    };
    const after: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'AFTER_CHECKPOINT_MARKER' }],
      timestamp: 3,
    };
    const checkpoint: CompactionEntry = {
      type: 'compaction',
      id: 'c0',
      seq: 0,
      parentId: null,
      timestamp: 1,
      summary: 'earlier work',
      retainedTail: [ghost, kept],
      tokensBefore: 1_000,
    };
    const carried = [summary, kept, after];
    handle.context?.beginRun({ messages: carried, checkpoint });
    handle.context?.requestNewWindow();
    const prepared = await prepare(handle, carried);
    // Not the "nothing to compact" path: there IS something after the checkpoint.
    expect(prepared.skipped).toBeUndefined();
    expect(prepared.compaction?.shedRetainedTail).toBeUndefined();
    expect(prompts.join('\n')).toContain('AFTER_CHECKPOINT_MARKER');
  });

  it('claims each reminder tier once per session, not once per run', async () => {
    // context-prompt-10. `beginRun` runs on every user message and every
    // `/compact`, so clearing the claims there told a conversation parked in
    // the reminder band to "start closing out" on every single message.
    const { handle } = await runtime({ tools: { cwd: dir }, context: { family: 'fresh_window' } });
    const budget = contextBudget(WINDOW, 0);
    const inTier = budget.hardLimit - reminderThreshold(budget) + 500;
    expect((await prepare(handle, [sized(inTier)])).reminder?.tier).toBe('approaching');
    handle.context?.beginRun();
    expect((await prepare(handle, [sized(inTier)])).reminder).toBeUndefined();
    // A compaction moves the window, which is the one event that makes "you are
    // running out of room" false again.
    handle.context?.requestNewWindow();
    expect((await prepare(handle, [sized(inTier)])).compaction).toBeDefined();
    expect((await prepare(handle, [sized(inTier)])).reminder?.tier).toBe('approaching');
  });

  it('writes the pre-run reminder into the trace, not only into the request', async () => {
    // context-prompt-11. The pre-run path traced compactions only, so a
    // reminder it put into `agent.state.messages` — where it then rode every
    // later request of that run — left nothing in `runs.jsonl` to explain the
    // extra message, and a compaction it asked for and did not get left nothing
    // at all.
    const faux = provider();
    const file = join(dir, 'session.jsonl');
    const { handle } = await runtime({
      faux,
      tools: { cwd: dir },
      session: { file, cwd: dir, mode: 'create' },
      context: { family: 'fresh_window' },
    });
    const budget = contextBudget(WINDOW, 0);
    faux.setResponses([fauxAssistantMessage('noted'), fauxAssistantMessage('noted again')]);
    await handle.run({
      prompt: 'x'.repeat((budget.hardLimit - reminderThreshold(budget) + 500) * 4),
      systemPrompt: 'probe',
    });
    const second = await handle.run({ prompt: 'a short follow-up', systemPrompt: 'probe' });
    expect(second.success).toBe(true);
    const reminder = second.trace.steps.find(
      (step) => step.detail.event === 'context_reminder'
    )?.detail;
    expect(reminder).toMatchObject({ tier: 'approaching' });
  });

  it('skips rather than fails when the new checkpoint is itself over budget', async () => {
    // context-prompt-12. `TurnPreparation.skipped` promises that a compaction
    // which cannot be completed below the hard limit leaves the run alone; this
    // branch threw without looking at the reason, so a runaway summary turned
    // a courtesy `new_context` into a failed run.
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    const budget = contextBudget(WINDOW, 0);
    faux.setResponses([fauxAssistantMessage('S'.repeat(budget.hardLimit * 4 + 4_000))]);
    handle.context?.requestNewWindow();
    const messages = [sized(200)];
    const prepared = await prepare(handle, messages);
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.skipped?.code).toBe('compaction_over_budget');
    expect(prepared.messages).toEqual(messages);
  });

  it('still fails the turn when the same oversized checkpoint lands at the hard limit', async () => {
    const faux = provider();
    const { handle } = await runtime({ faux, tools: { cwd: dir }, context: { family: 'summary' } });
    const budget = contextBudget(WINDOW, 0);
    faux.setResponses([fauxAssistantMessage('S'.repeat(budget.hardLimit * 4 + 4_000))]);
    await expect(prepare(handle, [sized(budget.hardLimit + 1_000)])).rejects.toMatchObject({
      code: 'context_compaction_failed',
    });
  });
});
