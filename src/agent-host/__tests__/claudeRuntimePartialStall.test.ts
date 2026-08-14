import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeRuntime } from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * 片 1c watchdog dependency, made explicit.
 *
 * The tool ledger deliberately stops emitting `tool.started` from the partial
 * stub, so during the window between `content_block_start(tool_use)` and the
 * whole message (930ms in the spike, tens of seconds for a large input)
 * `hasOpenTools()` is FALSE. Nothing pauses the C-14 stall watchdog in that
 * window — the turn survives it purely because `'stream_event'` is a member of
 * `PRODUCTIVE_EVENT_TYPES` and therefore re-arms the timer.
 *
 * That is an invisible coupling between two files, so it is pinned here with a
 * matched pair: a partial-only stream must NOT stall, and an equally long
 * non-productive (`system`) stream MUST — the second half is what proves the
 * first is not vacuously green because the watchdog was disarmed.
 *
 * Real timers on purpose: the watchdog lives inside `send()`'s own async loop,
 * so the timeouts are shortened via the documented env overrides instead.
 */

const STALL_MS = 40;
const GAP_MS = 15;
const EVENT_COUNT = 12;

const STALL_FLAG = 'AICLIENT_HOST_STALL_TIMEOUT_MS';
const TTFT_FLAG = 'AICLIENT_HOST_TTFT_TIMEOUT_MS';
const originalStall = process.env[STALL_FLAG];
const originalTtft = process.env[TTFT_FLAG];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRuntime(
  events: Record<string, unknown>[],
  stream: () => AsyncIterable<unknown>
): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: (event) => events.push(event as Record<string, unknown>),
    log: () => undefined,
    registry: new SessionRegistry(),
    queryFn: () => ({
      [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](),
      close() {
        /* nothing to tear down */
      },
    }),
  });
}

/** A partial-messages turn: nothing but `stream_event` for well past the stall budget. */
async function* partialOnlyStream(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'rt-stall' };
  yield {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_slow', name: 'Write', input: {} },
    },
  };
  for (let i = 0; i < EVENT_COUNT; i += 1) {
    await sleep(GAP_MS);
    yield {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: `"frag${i}",` },
      },
    };
  }
  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'rt-stall' };
}

/** The same duration spent on control-plane events only — the watchdog must fire. */
async function* systemOnlyStream(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'rt-stall' };
  for (let i = 0; i < EVENT_COUNT; i += 1) {
    await sleep(GAP_MS);
    yield {
      type: 'system',
      subtype: 'api_retry',
      session_id: 'rt-stall',
      attempt: i,
      max_retries: 99,
    };
  }
  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'rt-stall' };
}

describe('PRODUCTIVE_EVENT_TYPES keeps a partial-only stretch alive (片 1c)', () => {
  beforeEach(() => {
    process.env[STALL_FLAG] = String(STALL_MS);
    process.env[TTFT_FLAG] = '0';
  });

  afterEach(() => {
    if (originalStall === undefined) delete process.env[STALL_FLAG];
    else process.env[STALL_FLAG] = originalStall;
    if (originalTtft === undefined) delete process.env[TTFT_FLAG];
    else process.env[TTFT_FLAG] = originalTtft;
  });

  it('does not stall a turn whose only traffic is stream_event', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = makeRuntime(events, partialOnlyStream);
    rt.createSession({ sessionId: 'stall-partial', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'stall-partial', text: 'write a big file' });

    // The stream ran EVENT_COUNT * GAP_MS = 180ms with a 40ms stall budget —
    // only the re-arm on each `stream_event` keeps it alive.
    expect(events.filter((e) => e.type === 'session.failed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'session.completed')).toHaveLength(1);
  });

  it('still stalls when the same span carries only control-plane events', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = makeRuntime(events, systemOnlyStream);
    rt.createSession({ sessionId: 'stall-system', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'stall-system', text: 'invalid model' });

    expect(events.filter((e) => e.type === 'session.failed').length).toBeGreaterThanOrEqual(1);
  });
});
