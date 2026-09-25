/**
 * T135 / decision 045 — where a retry resumes (`plugins/session/retry.ts`).
 *
 * The integration test drives the common shapes through a real worker; this
 * pins the edges of the walk: which trailing entries a retry may step over,
 * and which context it may re-ask from.
 */
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { LOOP_GUARD_CUSTOM_TYPE, RUN_STOP_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
import { PERMISSION_GRANTS_ENTRY } from '../plugins/session/legacy.ts';
import { isRetryableContext, retryCut } from '../plugins/session/retry.ts';

const user = (text: string) =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as AgentMessage;
const assistant = (stopReason: string, content: unknown[] = [{ type: 'text', text: 'x' }]) =>
  ({
    role: 'assistant',
    content,
    stopReason,
    api: 'faux',
    provider: 'faux',
    model: 'faux',
    usage: {},
    timestamp: 1,
  }) as unknown as AgentMessage;
const toolResult = (id: string) =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 1,
  }) as AgentMessage;

function chain(...items: Array<AgentMessage | { custom: string }>): Entry[] {
  return items.map((item, index) => {
    const base = { id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: 1 };
    return 'custom' in item
      ? ({ ...base, type: 'custom', customType: item.custom } as Entry)
      : ({ ...base, type: 'message', message: item } as Entry);
  });
}

describe('retryCut — how far back a retry moves the leaf', () => {
  it('steps over the failed reply and the run records after it', () => {
    const branch = chain(
      user('go'),
      assistant('toolUse', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
      toolResult('c1'),
      assistant('error'),
      { custom: LOOP_GUARD_CUSTOM_TYPE },
      { custom: RUN_STOP_CUSTOM_TYPE }
    );
    expect(retryCut(branch)).toEqual({ index: 2, abandoned: 1 });
  });

  it('stays put when nothing failed at the tail', () => {
    const branch = chain(user('go'), assistant('stop'), { custom: RUN_STOP_CUSTOM_TYPE });
    expect(retryCut(branch)).toEqual({ index: 2, abandoned: 0 });
  });

  it('does not abandon a record the user added after the failure', () => {
    // A permission change after the failure is the user's, not the attempt's.
    const branch = chain(user('go'), assistant('error'), { custom: PERMISSION_GRANTS_ENTRY });
    expect(retryCut(branch)).toEqual({ index: 2, abandoned: 0 });
  });
});

describe('isRetryableContext — whether there is a request to repeat', () => {
  it('re-asks from a prompt or a tool result', () => {
    expect(isRetryableContext([user('go')])).toBe(true);
    expect(
      isRetryableContext([
        user('go'),
        assistant('toolUse', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
        toolResult('c1'),
      ])
    ).toBe(true);
  });

  it('re-asks after a crash mid-tool, whose calls the run closes itself', () => {
    expect(
      isRetryableContext([
        user('go'),
        assistant('toolUse', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
      ])
    ).toBe(true);
  });

  it('has nothing to repeat after a completed turn, a bare summary, or nothing at all', () => {
    expect(isRetryableContext([user('go'), assistant('stop')])).toBe(false);
    expect(
      isRetryableContext([
        { role: 'compactionSummary', summary: 'earlier', timestamp: 1 } as unknown as AgentMessage,
      ])
    ).toBe(false);
    expect(isRetryableContext([])).toBe(false);
  });
});
