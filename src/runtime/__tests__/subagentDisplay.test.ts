/**
 * P5-2-6 gate — what the runtime publishes for the delegation panel, and what
 * a reopened session gets back.
 *
 * The contract forbids closing this node on the grounds that a subagent panel
 * already exists, and going through it line by line is what these cases record.
 * Three of them are regressions the walkthrough found:
 *
 * - reasoning was never projected at all, so a delegate that spent a minute
 *   thinking showed an empty panel;
 * - tool rows carried no arguments, so every row read "Reading" with no file;
 * - delegation RECORDS were reaching the renderer as `custom.entry`, which
 *   turns each one into a system message in the PARENT's timeline — the exact
 *   thing the custom-entry isolation was supposed to prevent.
 */

import { describe, expect, it } from 'vitest';
import { INTERNAL_CUSTOM_ENTRIES } from '../plugins/session/legacy.ts';
import {
  activityForEvent,
  SUBAGENT_ENTRY,
  subagentHistorySummaries,
} from '../plugins/subagent/records.ts';

const BASE = { parentToolCallId: 'toolu_1', agentId: 'delegation-1' };

function assistant(content: unknown[]) {
  return { type: 'message_end' as const, message: { role: 'assistant', content } } as never;
}

describe('P5-2-6 · the live projection carries what the panel renders', () => {
  it('publishes reasoning as its own row, before the prose of the same message', () => {
    const payloads = activityForEvent(
      assistant([
        { type: 'thinking', thinking: 'the config is probably in src' },
        { type: 'text', text: 'Checking src/config.' },
      ]),
      BASE
    );
    expect(payloads.map((payload) => payload.kind)).toEqual(['thinking', 'text']);
    expect(payloads[0]).toMatchObject({ text: 'the config is probably in src' });
    expect(payloads[1]).toMatchObject({ text: 'Checking src/config.' });
    // Distinct ids: the lane's ring drops a duplicate id, so sharing one would
    // silently lose whichever arrived second.
    expect((payloads[0] as { id: string }).id).not.toBe((payloads[1] as { id: string }).id);
  });

  it('publishes nothing for an empty or non-assistant message', () => {
    expect(activityForEvent(assistant([{ type: 'text', text: '   ' }]), BASE)).toEqual([]);
    expect(
      activityForEvent(
        { type: 'message_end', message: { role: 'user', content: [] } } as never,
        BASE
      )
    ).toEqual([]);
  });

  it('carries the arguments a tool row shows, in our own tool vocabulary', () => {
    const [payload] = activityForEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'read',
        args: { path: '/work/src/config.ts', offset: 10, limit: 40 },
      } as never,
      BASE
    );
    expect(payload).toMatchObject({
      kind: 'tool.started',
      name: 'read',
      input: { path: '/work/src/config.ts', offset: 10, limit: 40 },
    });
  });

  it('never lets a file body onto the channel', () => {
    // The negative is the point of a whitelist. `write` shows WHICH file; the
    // content stays in the record.
    const [payload] = activityForEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'write',
        args: { path: '/work/a.txt', content: 'x'.repeat(10_000) },
      } as never,
      BASE
    );
    expect(payload).toMatchObject({ input: { path: '/work/a.txt' } });
    expect(JSON.stringify(payload)).not.toContain('xxxxx');
  });

  it('clamps a long argument instead of shipping it whole', () => {
    const [payload] = activityForEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { command: 'echo '.repeat(400) },
      } as never,
      BASE
    );
    const command = (payload as unknown as { input: { command: string } }).input.command;
    expect(command.length).toBeLessThan(300);
    expect(command.endsWith('…')).toBe(true);
  });

  it('says nothing about a tool it has no whitelist for', () => {
    const [payload] = activityForEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'some_future_tool',
        args: { secret: 'value' },
      } as never,
      BASE
    );
    // The row still appears — the model DID call something — it just carries no
    // arguments rather than guessing which of them are safe.
    expect(payload).toMatchObject({ kind: 'tool.started', name: 'some_future_tool' });
    expect(payload).not.toHaveProperty('input');
  });

  it('reports a failed tool with a reason and no output body', () => {
    const [payload] = activityForEvent(
      {
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'ENOENT: /etc/shadow' }] },
        isError: true,
      } as never,
      BASE
    );
    expect(payload).toMatchObject({ kind: 'tool.completed', ok: false });
    expect(JSON.stringify(payload)).not.toContain('shadow');
  });
});

describe('P5-2-6 · delegation records stay out of the parent timeline', () => {
  it('keeps the record type off the wire', () => {
    // A `custom.entry` becomes a SYSTEM MESSAGE in the parent's conversation.
    // With delegation records on the wire, every delegate message appeared
    // there as a row of raw JSON — both a privacy leak into the visible
    // transcript and the exact isolation the entry type exists to provide.
    expect(INTERNAL_CUSTOM_ENTRIES).toContain(SUBAGENT_ENTRY);
  });
});

describe('P5-2-6 · a reopened session rebuilds its delegations', () => {
  const started = {
    type: 'custom',
    customType: SUBAGENT_ENTRY,
    data: {
      kind: 'started',
      delegationId: 'd1',
      agentName: 'explorer',
      parentToolCallId: 'toolu_1',
      runId: 'run-1',
      task: 'look around',
      label: 'survey the repo',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      startedAt: 1000,
    },
  };
  const settled = {
    type: 'custom',
    customType: SUBAGENT_ENTRY,
    data: {
      kind: 'settled',
      delegationId: 'd1',
      agentName: 'explorer',
      parentToolCallId: 'toolu_1',
      runId: 'run-1',
      status: 'completed',
      turns: 4,
      toolCalls: 7,
      report: 'Found three config files.',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      completedAt: 4000,
    },
  };

  it('summarises a finished delegation with its attribution and report', () => {
    const [summary] = subagentHistorySummaries([started, settled]);
    expect(summary).toMatchObject({
      delegationId: 'd1',
      parentToolCallId: 'toolu_1',
      agentName: 'explorer',
      label: 'survey the repo',
      status: 'completed',
      startedAt: 1000,
      completedAt: 4000,
      turns: 4,
      toolCalls: 7,
      totalTokens: 30,
      report: 'Found three config files.',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('reports a delegation that never settled as interrupted, not as running', () => {
    // This is what a hard exit leaves behind. Showing it as running would be a
    // reopened session claiming work is in flight that nothing is doing.
    const [summary] = subagentHistorySummaries([started]);
    expect(summary.status).toBe('interrupted');
    expect(summary.report).toBeUndefined();
  });

  it('clamps a huge report for transport without losing the delegation', () => {
    const huge = {
      ...settled,
      data: { ...settled.data, report: 'x'.repeat(20_000) },
    };
    const [summary] = subagentHistorySummaries([started, huge]);
    expect(summary.report?.length).toBeLessThan(5_000);
    expect(summary.status).toBe('completed');
  });

  it('ignores entries that are not delegation records', () => {
    expect(
      subagentHistorySummaries([
        { type: 'message', data: { role: 'user' } },
        { type: 'custom', customType: 'aiclient.permissions', data: { gear: 'ask' } },
      ])
    ).toEqual([]);
  });
});
