import { describe, expect, it, vi } from 'vitest';
import { TOOL_CALL_REPETITION } from '../constants.ts';
import type { DshStreamChunk } from '../dshTypes.ts';
import {
  delegationCallSignature,
  describeRepetition,
  guardReplyStream,
  ReplyRepetitionTracker,
} from '../repetition.ts';

/**
 * Rule B (decision 065): 1.0.x's `subagentLoopGuard.test.ts` rules, with DSH's
 * tool names and DSH's chunk protocol.
 */

const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  arguments: JSON.stringify(args),
});

/** One complete tool-call block as llm-pi-ai streams it. */
function toolBlock(index: number, name: string, args: Record<string, unknown>): DshStreamChunk[] {
  const json = JSON.stringify(args);
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: `t${index}`, name, argumentsDelta: json },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: `t${index}`, name, arguments: json },
    },
  ];
}

const finishOk: DshStreamChunk = { type: 'finish', reason: { kind: 'tool-use' } };

/** A source that records how far it was read and whether it was closed. */
function source(chunks: DshStreamChunk[]) {
  const state = { pulled: 0, returned: false };
  const iterable: AsyncIterable<DshStreamChunk> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (state.returned || index >= chunks.length) return { done: true, value: undefined };
          state.pulled += 1;
          return { done: false, value: chunks[index++] as DshStreamChunk };
        },
        async return() {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, state };
}

async function collect(stream: AsyncIterable<DshStreamChunk>): Promise<DshStreamChunk[]> {
  const out: DshStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('delegationCallSignature', () => {
  it('names control calls by their target only', () => {
    expect(delegationCallSignature('job_output', { job_id: 'j1', wait: true, timeout_ms: 5 })).toBe(
      delegationCallSignature('job_output', { job_id: ' j1 ' })
    );
    expect(delegationCallSignature('job_output', { job_id: 'j1' })).not.toBe(
      delegationCallSignature('job_output', { job_id: 'j2' })
    );
    expect(delegationCallSignature('job_kill', { job_id: 'j1', reason: 'a' })).toBe(
      delegationCallSignature('job_kill', { job_id: 'j1', reason: 'b' })
    );
    expect(delegationCallSignature('job_list', {})).toBe(
      delegationCallSignature('job_list', { unexpected: 1 })
    );
    expect(delegationCallSignature('list_agents', {})).toBe(
      delegationCallSignature('list_agents', { scope: 'children' })
    );
    expect(delegationCallSignature('interrupt_agent', { agent_id: 'a' })).toBe(
      'interrupt_agent {"agent_id":"a"}'
    );
  });

  it('names work by who is asked to do what, never by the display label', () => {
    const base = { description: 'Look', prompt: 'Read the tests', run_in_background: true };
    expect(delegationCallSignature('subagent', base)).toBe(
      delegationCallSignature('subagent', { ...base, description: 'Other label' })
    );
    expect(delegationCallSignature('subagent', base)).not.toBe(
      delegationCallSignature('subagent', { ...base, prompt: 'Read the docs' })
    );
    expect(delegationCallSignature('subagent', base)).not.toBe(
      delegationCallSignature('subagent', { ...base, model: 'm2', provider: 'p' })
    );
    expect(delegationCallSignature('delegate', { agent: 'reviewer', prompt: 'x' })).not.toBe(
      delegationCallSignature('delegate', { agent: 'explorer', prompt: 'x' })
    );
    expect(delegationCallSignature('send_message', { agent_id: 'a', message: 'go' })).toBe(
      'send_message {"agent_id":"a","message":"go"}'
    );
  });

  it('reads the raw JSON string DSH hands over, and survives a malformed one', () => {
    expect(delegationCallSignature('job_output', '{"job_id":"j1"}')).toBe(
      'job_output {"job_id":"j1"}'
    );
    expect(delegationCallSignature('job_output', '{"job_id":')).toBe('job_output {}');
    expect(delegationCallSignature('job_output', '[1]')).toBe('job_output {}');
  });
});

describe('ReplyRepetitionTracker', () => {
  it('trips on the third identical family call', () => {
    const tracker = new ReplyRepetitionTracker();
    expect(tracker.inspect(call('job_list'))).toBeUndefined();
    expect(tracker.inspect(call('job_list'))).toBeUndefined();
    const verdict = tracker.inspect(call('job_list'));
    expect(verdict).toMatchObject({
      rule: 'identical_call',
      occurrences: 3,
      delegationCalls: 3,
      signature: 'job_list {}',
    });
  });

  it('trips on the seventeenth family call whatever the arguments', () => {
    const tracker = new ReplyRepetitionTracker();
    for (let i = 0; i < 16; i += 1) {
      expect(tracker.inspect(call('job_output', { job_id: `j${i}` })), String(i)).toBeUndefined();
    }
    expect(tracker.inspect(call('job_output', { job_id: 'j16' }))).toMatchObject({
      rule: 'call_count',
      delegationCalls: 17,
      occurrences: 1,
    });
  });

  it('lets a ten-way fan-out, two careful repeats and any number of other tools through', () => {
    const tracker = new ReplyRepetitionTracker();
    for (let i = 0; i < 10; i += 1) {
      expect(
        tracker.inspect(call('subagent', { description: 'x', prompt: `Task ${i}` }))
      ).toBeUndefined();
    }
    expect(tracker.inspect(call('job_output', { job_id: 'j1' }))).toBeUndefined();
    expect(tracker.inspect(call('job_output', { job_id: 'j1', wait: true }))).toBeUndefined();
    for (let i = 0; i < 200; i += 1) {
      expect(tracker.inspect(call('bash', { command: 'ls' }))).toBeUndefined();
    }
  });
});

describe('describeRepetition (1.0.x wording)', () => {
  it('says what was cut and that nothing ran', () => {
    expect(
      describeRepetition({
        rule: 'identical_call',
        signature: 'job_list {}',
        occurrences: 3,
        delegationCalls: 3,
        toolCalls: 5,
      })
    ).toBe(
      'The model wrote the same subagent tool call 3 times in one reply (job_list {}), with 5 tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls.'
    );
    expect(
      describeRepetition({
        rule: 'call_count',
        signature: 'job_output {"job_id":"x"}',
        occurrences: 1,
        delegationCalls: 17,
        toolCalls: 17,
      })
    ).toBe(
      'The model wrote 17 subagent tool calls in one reply, more than the 16 this app allows, with 17 tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls.'
    );
  });
});

describe('guardReplyStream', () => {
  it('closes the source at the tripping block, then ends the reply with one error finish', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Checking.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking.' } },
      ...[1, 2, 3, 4, 5].flatMap((i) => toolBlock(i, 'job_list', {})),
      finishOk,
    ] as DshStreamChunk[];
    const upstream = source(chunks);
    const onTrip = vi.fn();
    const out = await collect(guardReplyStream(upstream.iterable, { onTrip }));

    // Text block + three tool blocks forwarded, the third one's block-end included.
    expect(out.slice(0, -1)).toEqual(chunks.slice(0, 3 + 9));
    expect(upstream.state.returned).toBe(true);
    expect(upstream.state.pulled).toBe(12);
    const finish = out.at(-1) as { type: string; reason: { kind: string; failure: unknown } };
    expect(finish.type).toBe('finish');
    expect(finish.reason.kind).toBe('error');
    expect(finish.reason.failure).toEqual({
      code: TOOL_CALL_REPETITION,
      message:
        'The model wrote the same subagent tool call 3 times in one reply (job_list {}), with 3 tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls.',
    });
    expect(out.filter((chunk) => chunk.type === 'finish')).toHaveLength(1);
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0]?.[0]).toMatchObject({ rule: 'identical_call', toolCalls: 3 });
  });

  it('counts every tool call started so far, not only the family ones', async () => {
    const chunks = [
      ...toolBlock(0, 'bash', { command: 'ls' }),
      ...toolBlock(1, 'job_list', {}),
      ...toolBlock(2, 'read', { file_path: 'a' }),
      ...toolBlock(3, 'job_list', {}),
      ...toolBlock(4, 'job_list', {}),
      finishOk,
    ];
    const onTrip = vi.fn();
    await collect(guardReplyStream(source(chunks).iterable, { onTrip }));
    expect(onTrip.mock.calls[0]?.[0]).toMatchObject({ delegationCalls: 3, toolCalls: 5 });
  });

  it('never judges a block that is still being dictated', async () => {
    const partial = [1, 2, 3, 4].flatMap((i) => toolBlock(i, 'job_list', {}).slice(0, 2));
    const chunks = [...partial, { type: 'finish', reason: { kind: 'max-tokens' } }];
    const upstream = source(chunks as DshStreamChunk[]);
    const out = await collect(guardReplyStream(upstream.iterable));
    expect(out).toEqual(chunks);
  });

  it('forwards a reply that never trips unchanged, provider errors included', async () => {
    const fanOut = [
      ...Array.from({ length: 10 }, (_, i) =>
        toolBlock(i, 'subagent', { description: 'd', prompt: `Task ${i}` })
      ).flat(),
      { type: 'usage', usage: { input: 1, output: 2 } },
      finishOk,
    ] as DshStreamChunk[];
    expect(await collect(guardReplyStream(source(fanOut).iterable))).toEqual(fanOut);
    const failed = [
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'x' } } },
    ] as DshStreamChunk[];
    expect(await collect(guardReplyStream(source(failed).iterable))).toEqual(failed);
  });

  it('closes the source when its consumer stops early (a user stop)', async () => {
    const upstream = source([...toolBlock(0, 'bash', {}), finishOk]);
    for await (const _chunk of guardReplyStream(upstream.iterable)) break;
    expect(upstream.state.returned).toBe(true);
  });

  it('still ends the reply when the source teardown or the trip listener throws', async () => {
    const chunks = [1, 2, 3].flatMap((i) => toolBlock(i, 'job_list', {}));
    const iterable: AsyncIterable<DshStreamChunk> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] as DshStreamChunk }
              : { done: true, value: undefined },
          return: async () => {
            throw new Error('teardown failed');
          },
        };
      },
    };
    const out = await collect(
      guardReplyStream(iterable, {
        onTrip: () => {
          throw new Error('listener failed');
        },
      })
    );
    expect(out.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } });
  });
});
