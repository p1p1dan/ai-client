/**
 * decision 040 — the interactive turn ceiling is a PAUSE with a written ending.
 *
 * The 64-turn cap decision 039 removed stopped the run straight after a tool
 * batch: the model never got to say anything, the page ended on a tool row,
 * and the renderer drew a red failure card for what was really a pause. These
 * cases pin the replacement end to end, through the real loop, real tools and
 * the real projector:
 *
 * - below the ceiling nothing changes;
 * - at the ceiling the loop asks the model ONCE more, tool-less, for a summary,
 *   and the run completes with `stopCause: 'turn_limit'`;
 * - a tool call in that wrap-up turn is refused, not run, and ends the run;
 * - a delegate still running at the ceiling is waited for, and its report
 *   reaches the wrap-up turn instead of buying the parent another turn.
 *
 * The ceiling is injected as a handful of turns; production uses
 * `DEFAULT_TURN_CEILING`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { DEFAULT_TURN_CEILING } from '../plugins/agent-loop/index.ts';
import { SUBAGENT_TOOL_NAME } from '../plugins/subagent/index.ts';
import { neverAsked } from './fixtures/approval.ts';

type ScriptStep = (context: PiContext) => AssistantMessage | Promise<AssistantMessage>;

/** Parent and delegate answered from separate scripts, routed by system prompt. */
function scriptedProvider(script: { parent: ScriptStep[]; delegate: ScriptStep[] }) {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-ceiling', name: 'Ceiling' }],
  });
  const requests = { parent: [] as PiContext[], delegate: [] as PiContext[] };
  const route = async (context: PiContext) => {
    const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
    const seen = isDelegate ? requests.delegate : requests.parent;
    const steps = isDelegate ? script.delegate : script.parent;
    const step = steps[seen.length];
    seen.push(context);
    if (!step) throw new Error(`no scripted ${isDelegate ? 'delegate' : 'parent'} response`);
    return step(context);
  };
  // The faux provider shifts one entry per request; the router decides.
  handle.setResponses(Array.from({ length: 32 }, () => route));
  return { handle, requests };
}

/** The last message of a request, as plain text. */
function lastMessageText(context: PiContext): string {
  const content = (context.messages.at(-1) as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((block) =>
      (block as { type?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''
    )
    .join('');
}

const readCall = (id: string) =>
  fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id })], {
    stopReason: 'toolUse',
  });

describe('decision 040 · the interactive turn ceiling', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ceiling-'));
    await writeFile(join(workspace, 'notes.txt'), 'NOTES-CONTENT');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(script: { parent: ScriptStep[]; delegate?: ScriptStep[] }, ceiling: number) {
    const scripted = scriptedProvider({ parent: script.parent, delegate: script.delegate ?? [] });
    runtime = await createRuntime({
      env: {},
      providers: [scripted.handle.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      subagents: { home: join(workspace, 'home') },
      loop: { singleTurn: false, turnCeiling: ceiling },
    });
    const events: RuntimeEventDraft[] = [];
    runtime.events.subscribe((event) => events.push(event));
    return { runtime, requests: scripted.requests, events };
  }

  it('is set high enough that real long tasks never meet it', () => {
    expect(DEFAULT_TURN_CEILING).toBe(500);
  });

  it('changes nothing for a run that finishes below the ceiling', async () => {
    const { runtime, requests, events } = await build(
      { parent: [() => readCall('r1'), () => readCall('r2'), () => fauxAssistantMessage('done')] },
      5
    );
    const result = await runtime.run({ prompt: 'work' });
    expect(result.success).toBe(true);
    expect(result.stopCause).toBeUndefined();
    expect(requests.parent).toHaveLength(3);
    const completed = events.find((event) => event.type === 'session.completed');
    expect(completed?.payload).not.toHaveProperty('stopCause');
  });

  it('pauses at the ceiling with one tool-less wrap-up turn that writes the ending', async () => {
    const { runtime, requests, events } = await build(
      {
        parent: [
          () => readCall('r1'),
          () => readCall('r2'),
          () => readCall('r3'),
          () => fauxAssistantMessage('SUMMARY: read notes three times, nothing left.'),
        ],
      },
      3
    );
    const result = await runtime.run({ prompt: 'work' });

    // Exactly one request past the ceiling, and it is the wrap-up request.
    expect(requests.parent).toHaveLength(4);
    const wrapUp = lastMessageText(requests.parent[3]);
    expect(wrapUp).toContain("this app's ceiling for one run");
    expect(wrapUp).toContain('do not call any tool');
    // A pause, not a failure: the run completes, on the model's own words.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.stopCause).toBe('turn_limit');
    expect(result.text).toContain('SUMMARY: read notes three times');
    expect(events.some((event) => event.type === 'session.failed')).toBe(false);
    const completed = events.find((event) => event.type === 'session.completed');
    expect(completed?.payload).toMatchObject({ stopCause: 'turn_limit' });
  });

  it('skips the wrap-up when Ctrl+Enter lands after the ceiling, and reports the interjection', async () => {
    // The user's next message is already queued: a summary written for a
    // "say continue" pause would answer a question nobody asked.
    const { runtime, requests, events } = await build(
      {
        parent: [
          () => readCall('r1'),
          () => readCall('r2'),
          () => readCall('r3'),
          () => fauxAssistantMessage('the wrap-up the interjection prevented'),
        ],
      },
      3
    );
    const result = await runtime.run({
      prompt: 'work',
      onEvent: (event: AgentEvent) => {
        if (event.type === 'agent_end') runtime.loop.interject();
      },
    });

    expect(requests.parent).toHaveLength(3);
    expect(result.success).toBe(true);
    expect(result.stopCause).toBe('interjected');
    const completed = events.find((event) => event.type === 'session.completed');
    expect(completed?.payload).toMatchObject({ stopCause: 'interjected' });
  });

  it('refuses a tool call in the wrap-up turn instead of running it, and ends there', async () => {
    const toolResults: { id: string; isError: boolean; text: string }[] = [];
    const { runtime, requests } = await build(
      { parent: [() => readCall('r1'), () => readCall('r2'), () => readCall('r3-wrap')] },
      2
    );
    const result = await runtime.run({
      prompt: 'work',
      onEvent: (event: AgentEvent) => {
        if (event.type !== 'tool_execution_end') return;
        const content = (event.result as { content?: { type: string; text?: string }[] })?.content;
        toolResults.push({
          id: event.toolCallId,
          isError: event.isError,
          text: (content ?? []).map((block) => block.text ?? '').join(''),
        });
      },
    });

    // No fourth request: the refusal carries `terminate`, so pi does not go
    // back to the model with it.
    expect(requests.parent).toHaveLength(3);
    const refused = toolResults.find((entry) => entry.id === 'r3-wrap');
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain('reached its turn ceiling');
    expect(refused?.text).not.toContain('NOTES-CONTENT');
    // The calls before the ceiling really ran.
    expect(toolResults.find((entry) => entry.id === 'r1')?.text).toContain('NOTES-CONTENT');
    expect(result.success).toBe(true);
    expect(result.stopCause).toBe('turn_limit');
  });

  it('waits for a delegate still running at the ceiling and folds its report into the wrap-up', async () => {
    const { runtime, requests } = await build(
      {
        parent: [
          // Turn 1 starts a delegate and reaches the ceiling of one.
          () =>
            fauxAssistantMessage(
              [fauxToolCall(SUBAGENT_TOOL_NAME, { agent: 'explorer', task: 'look around' })],
              { stopReason: 'toolUse' }
            ),
          () => fauxAssistantMessage('SUMMARY with the explorer finding.'),
        ],
        delegate: [
          async () => {
            // Long enough that the parent has certainly stopped first.
            await new Promise((resolve) => setTimeout(resolve, 60));
            return fauxAssistantMessage('EXPLORER-REPORT: found it at src/app.ts:42');
          },
        ],
      },
      1
    );
    const result = await runtime.run({ prompt: 'find the thing' });

    // The delegate was waited for, not stopped...
    const records = runtime.ctx.runtimeSubagents.registry.all();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    // ...and its report reached the ONE wrap-up request, ahead of the
    // instruction that overrides its "continue the task".
    expect(requests.parent).toHaveLength(2);
    const wrapUp = lastMessageText(requests.parent[1]);
    expect(wrapUp).toContain('EXPLORER-REPORT');
    expect(wrapUp.indexOf('EXPLORER-REPORT')).toBeLessThan(
      wrapUp.indexOf("this app's ceiling for one run")
    );
    expect(result.success).toBe(true);
    expect(result.stopCause).toBe('turn_limit');
    expect(result.text).toContain('SUMMARY with the explorer finding.');
  });
});
