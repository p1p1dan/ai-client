import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_ERROR_METHOD,
  CODEX_IGNORED_NOTIFICATIONS,
  CODEX_NORMALIZER_METHODS,
  CODEX_TOOL_PROGRESS_MAX_PER_ITEM,
  CodexNormalizer,
  classifyCodexTurnError,
} from '../codexNormalizer.ts';
import { kindOfServerMethod } from '../codexPending.ts';

/**
 * The turn loop, verified against the one complete recorded turn we have.
 *
 * The single most valuable test in this file is the 19-frame replay: eighteen
 * isolated unit tests can all pass while the class still cannot carry one real
 * turn end to end, because the failures that matter here are ORDERING and
 * OWNERSHIP failures — a tool row that never settles, a status event emitted by
 * the wrong module, a turn's state leaking into the next one.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'codex');

interface MethodContract {
  serverNotification: string[];
}

const contract = JSON.parse(
  readFileSync(path.join(FIXTURES, 'codex-method-contract.json'), 'utf8')
) as MethodContract;

interface Envelope {
  dir: string;
  tMs: number | null;
  raw: { method?: string; params?: Record<string, unknown>; id?: number };
}

function loadFrames(file: string): Envelope[] {
  return readFileSync(path.join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

interface Emitted {
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

function harness(threadId?: string): {
  events: Emitted[];
  logs: unknown[][];
  normalizer: CodexNormalizer;
} {
  const events: Emitted[] = [];
  const logs: unknown[][] = [];
  const normalizer = new CodexNormalizer({
    sessionId: 's1',
    emit: (event) => events.push(event as unknown as Emitted),
    log: (...args) => logs.push(args),
    ...(threadId ? { threadId } : {}),
  });
  return { events, logs, normalizer };
}

const THREAD = '019fd82d-ae7f-7b91-955b-0b1d5b5af4e2';
const FILECHANGE_ITEM = 'exec-f5ec3f09-0b15-4ba7-ab1b-13bcfaa79ccf';

/**
 * Feed a recorded turn the way `codexRuntime` routes it: server REQUESTS go to
 * the pending table (slices 3/4), notifications go here. Replaying the approval
 * request through `ingest` would misrepresent production wiring and would make
 * the unknown-notification counter lie.
 */
function replay(normalizer: CodexNormalizer, file: string): string[] {
  const routed: string[] = [];
  for (const frame of loadFrames(file)) {
    const method = frame.raw.method;
    if (frame.dir !== '<-' || !method) continue;
    if (kindOfServerMethod(method)) continue;
    routed.push(method);
    normalizer.ingest(method, frame.raw.params);
  }
  return routed;
}

describe('the status event stays owned by codexStatus', () => {
  it('never appears in this module s source', () => {
    // A static scan, not a behavioural one: a behavioural test only covers the
    // paths it exercises, while C10 rule 3 is a whole-file prohibition. If a
    // future edit adds a "helpful" idle emission on turn/completed, this fails
    // even if no test drives that branch.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'codexNormalizer.ts'),
      'utf8'
    );
    expect(source.includes('session.status')).toBe(false);
  });

  it('emits none of it while replaying a whole turn, including the idle frame', () => {
    const { events, normalizer } = harness();
    replay(normalizer, 'codex-filechange-approval-turn.jsonl');
    expect(events.filter((e) => e.type === 'session.status')).toEqual([]);
  });
});

describe('every method name is read off the generated contract', () => {
  it.each(Object.values(CODEX_NORMALIZER_METHODS))('handles %s, which codex declares', (method) => {
    // A guessed notification name is silence, not an error: the handler simply
    // never runs and the turn renders half of what happened.
    expect(contract.serverNotification).toContain(method);
  });

  it.each(
    Object.keys(CODEX_IGNORED_NOTIFICATIONS)
  )('ignores %s, which codex declares', (method) => {
    expect(contract.serverNotification).toContain(method);
  });

  it('states a reason for every deliberate drop', () => {
    for (const [method, reason] of Object.entries(CODEX_IGNORED_NOTIFICATIONS)) {
      expect(reason.length, `${method} needs a reason`).toBeGreaterThan(10);
    }
  });
});

describe('the recorded 19-frame turn replays end to end', () => {
  const { events, normalizer } = harness(THREAD);
  const routed = replay(normalizer, 'codex-filechange-approval-turn.jsonl');
  const types = events.map((e) => e.type);

  it('routes 18 of the 19 frames, the 19th being the approval request', () => {
    expect(routed).toHaveLength(18);
    expect(routed).not.toContain('item/fileChange/requestApproval');
  });

  it('opens with the user turn echo', () => {
    // Codex has no client-side beginTurn: the user echo IS the observable start
    // of the turn, and it must precede anything the assistant did.
    expect(events[0]).toMatchObject({
      type: 'message.started',
      payload: { role: 'user', messageId: 'codex-user-019fd82d-aece-75f2-86e9-d04e245aa1f1' },
    });
    expect(events[1]?.payload?.text).toContain('probe_b.txt');
    expect(types[2]).toBe('message.completed');
  });

  it('counts exactly one turn started and one completed', () => {
    const stats = normalizer.stats();
    expect(stats.turnsStarted).toBe(1);
    expect(stats.turnsCompleted).toBe(1);
    // The turn carried no turn/started frame — the loop synthesized the turn
    // from the first turn-scoped item, which is what makes a mid-turn attach
    // (or a fixture like this one) survivable.
    expect(routed).not.toContain('turn/started');
  });

  it('streams the reasoning as thinking and closes the block', () => {
    expect(types).toContain('thinking.started');
    const thinking = events.filter((e) => e.type === 'thinking.delta');
    expect(thinking.length).toBeGreaterThanOrEqual(2);
    expect(thinking[0]?.payload?.text).toContain('Implementing apply_patch');
    expect(types.filter((t) => t === 'thinking.completed')).toHaveLength(2);
  });

  it('renders the fileChange as a tool row that settles as declined', () => {
    const started = events.find((e) => e.type === 'tool.started');
    expect(started?.payload).toMatchObject({ toolCallId: FILECHANGE_ITEM, name: 'apply_patch' });
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed?.payload).toMatchObject({
      toolCallId: FILECHANGE_ITEM,
      ok: false,
      error: 'declined',
    });
    // Exactly one of each: item/started and item/completed both carry the whole
    // item, so a mapper without de-duplication would draw the row twice.
    expect(types.filter((t) => t === 'tool.started')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool.completed')).toHaveLength(1);
  });

  it('caches the patch that arrived before the approval request', () => {
    const detail = normalizer.getFileChangeDetail(FILECHANGE_ITEM);
    expect(detail).toEqual({
      kind: 'file_change',
      changes: [{ path: expect.stringContaining('probe_b.txt'), change: 'add', diff: 'hi\n' }],
    });
  });

  it('emits both assistant messages before ending the turn', () => {
    const deltas = events.filter(
      (e) => e.type === 'message.delta' && e.payload?.messageId !== undefined
    );
    const assistantText = deltas
      .filter((e) => String(e.payload?.messageId).startsWith('codex-asst-'))
      .map((e) => String(e.payload?.text));
    expect(assistantText[0]).toContain('我现在创建该文件');
    expect(assistantText[1]).toContain('无法创建');
  });

  it('closes the turn with message.completed then session.completed', () => {
    expect(types.slice(-2)).toEqual(['message.completed', 'session.completed']);
  });

  it('leaves nothing unaccounted for', () => {
    const stats = normalizer.stats();
    expect(stats.unknownNotifications).toBe(0);
    expect(stats.unknownItems).toBe(0);
    expect(stats.malformedItems).toBe(0);
    expect(stats.foreignThreadFrames).toBe(0);
    // 4 status frames + 1 serverRequest/resolved, all owned by other modules.
    expect(stats.ignoredNotifications).toBe(5);
  });
});

describe('the patch is cached before the approval request needs it', () => {
  it('is available the moment the item/started frame has been ingested', () => {
    // The 1ms that this whole cache exists for: item/started at 11235ms carries
    // the diff, item/fileChange/requestApproval at 11236ms carries none.
    const { normalizer } = harness(THREAD);
    const frames = loadFrames('codex-filechange-approval-turn.jsonl');
    const approvalIndex = frames.findIndex(
      (f) => f.raw.method === 'item/fileChange/requestApproval'
    );
    expect(approvalIndex).toBeGreaterThan(0);
    for (const frame of frames.slice(0, approvalIndex)) {
      const method = frame.raw.method;
      if (!method || kindOfServerMethod(method)) continue;
      normalizer.ingest(method, frame.raw.params);
    }
    expect(normalizer.getFileChangeDetail(FILECHANGE_ITEM)?.kind).toBe('file_change');
  });
});

describe('turn isolation', () => {
  const started = (turnId: string, itemId: string) => ({
    threadId: THREAD,
    turnId,
    item: { type: 'agentMessage', id: itemId, text: '' },
  });

  it('gives each turn its own assistant envelope', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('item/started', started('turn-a', 'msg-a'));
    normalizer.ingest('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'msg-a', delta: 'A' });
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-a', status: 'completed', error: null },
    });
    normalizer.ingest('item/started', started('turn-b', 'msg-b'));
    normalizer.ingest('item/agentMessage/delta', { turnId: 'turn-b', itemId: 'msg-b', delta: 'B' });

    const ids = events
      .filter((e) => e.type === 'message.started')
      .map((e) => String(e.payload?.messageId));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(normalizer.stats().turnsStarted).toBe(2);
  });

  it('closes a turn that was superseded without a completion frame', () => {
    // Interrupts and errors both produce this: without the close, the renderer
    // shows the abandoned message as still streaming, forever.
    const { events, normalizer } = harness();
    normalizer.ingest('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'm1', delta: 'A' });
    normalizer.ingest('item/agentMessage/delta', { turnId: 'turn-b', itemId: 'm2', delta: 'B' });
    const closes = events.filter((e) => e.type === 'message.completed');
    expect(closes).toHaveLength(1);
    expect(String(closes[0]?.payload?.messageId)).toContain('turn-a');
  });

  it('lets a frame without a turnId join the open turn', () => {
    // `item/started` for a plan item carries only `item` [实测] — treating that
    // as a new turn would reset state mid-turn.
    const { normalizer } = harness();
    normalizer.ingest('item/started', started('turn-a', 'msg-a'));
    normalizer.ingest('item/started', { item: { type: 'plan', id: 'p1', text: '' } });
    expect(normalizer.currentTurnId()).toBe('turn-a');
    expect(normalizer.stats().turnsStarted).toBe(1);
    expect(normalizer.stats().skippedItems).toBe(1);
  });

  it('closeTurn settles an aborted turn from outside the stream', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'm1', delta: 'A' });
    normalizer.closeTurn('stopped', 'user interrupt');
    expect(events.map((e) => e.type).slice(-2)).toEqual(['message.completed', 'session.stopped']);
    expect(events.at(-1)?.payload).toEqual({ error: 'user interrupt' });
  });

  it('reports a failed turn as failed', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: { id: 't', status: 'failed', error: 'model exploded' },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'session.failed',
      payload: { error: 'model exploded' },
    });
  });
});

describe('streaming vs completion never double-render', () => {
  it('drops the completed body when deltas already streamed it', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('item/started', {
      turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: '' },
    });
    normalizer.ingest('item/agentMessage/delta', { turnId: 't1', itemId: 'm1', delta: 'hello ' });
    normalizer.ingest('item/agentMessage/delta', { turnId: 't1', itemId: 'm1', delta: 'world' });
    normalizer.ingest('item/completed', {
      turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: 'hello world' },
    });
    const texts = events
      .filter((e) => e.type === 'message.delta')
      .map((e) => String(e.payload?.text));
    expect(texts).toEqual(['hello ', 'world']);
  });

  it('falls back to the completed body when no delta ever arrived', () => {
    // Exactly the recorded turn's shape: no agentMessage delta was captured,
    // the whole text landed on item/completed.
    const { events, normalizer } = harness();
    normalizer.ingest('item/completed', {
      turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: 'only body' },
    });
    expect(events.filter((e) => e.type === 'message.delta').map((e) => e.payload?.text)).toEqual([
      'only body',
    ]);
  });

  it('separates reasoning summary parts so they do not run together', () => {
    const { events, normalizer } = harness();
    const base = { turnId: 't1', itemId: 'r1' };
    normalizer.ingest('item/reasoning/summaryPartAdded', { ...base, summaryIndex: 0 });
    normalizer.ingest('item/reasoning/summaryTextDelta', { ...base, delta: 'first' });
    normalizer.ingest('item/reasoning/summaryPartAdded', { ...base, summaryIndex: 1 });
    normalizer.ingest('item/reasoning/summaryTextDelta', { ...base, delta: 'second' });
    const texts = events
      .filter((e) => e.type === 'thinking.delta')
      .map((e) => String(e.payload?.text));
    expect(texts).toEqual(['first', '\n\n', 'second']);
  });
});

describe('tool progress', () => {
  const startTool = (normalizer: CodexNormalizer) =>
    normalizer.ingest('item/started', {
      turnId: 't1',
      item: { type: 'commandExecution', id: 'exec-1', command: 'ls', status: 'inProgress' },
    });

  it('forwards a bodyless ping, because the protocol has no field for the body', () => {
    const { events, normalizer } = harness();
    startTool(normalizer);
    normalizer.ingest('item/commandExecution/outputDelta', {
      turnId: 't1',
      itemId: 'exec-1',
      delta: 'line\n',
    });
    const ping = events.find((e) => e.type === 'tool.updated');
    expect(ping?.payload).toMatchObject({ toolCallId: 'exec-1' });
    expect(ping?.payload).not.toHaveProperty('output');
  });

  it('caps the pings per item so a chatty command cannot flood IPC', () => {
    const { events, normalizer } = harness();
    startTool(normalizer);
    for (let i = 0; i < CODEX_TOOL_PROGRESS_MAX_PER_ITEM + 10; i += 1) {
      normalizer.ingest('item/commandExecution/outputDelta', {
        turnId: 't1',
        itemId: 'exec-1',
        delta: `${i}`,
      });
    }
    expect(events.filter((e) => e.type === 'tool.updated')).toHaveLength(
      CODEX_TOOL_PROGRESS_MAX_PER_ITEM
    );
  });
});

describe('usage passthrough', () => {
  it('forwards token usage verbatim, keeping all six-times-denser fields', () => {
    const { events, normalizer } = harness();
    const params = {
      threadId: THREAD,
      usage: { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 3 } },
      modelContextWindow: 272000,
    };
    normalizer.ingest('thread/tokenUsage/updated', params);
    expect(events).toEqual([
      { type: 'usage.updated', sessionId: 's1', payload: expect.objectContaining(params) },
    ]);
  });

  it('namespaces rate limits so an all-null body cannot be rendered as usage', () => {
    // Measured on this machine: every field null (third-party proxy + API key).
    const frame = loadFrames('codex-command-approval.jsonl').find(
      (f) => f.raw.method === 'account/rateLimits/updated'
    );
    expect(frame).toBeDefined();
    const { events, normalizer } = harness();
    normalizer.ingest('account/rateLimits/updated', frame?.raw.params);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('usage.updated');
    expect(events[0]?.payload).toHaveProperty('codexRateLimits');
    // Not merged into the token-usage key space, where a consumer would read it.
    expect(events[0]?.payload).not.toHaveProperty('usage');
  });
});

describe('unknown and malformed input keeps the turn alive', () => {
  it('counts an unknown notification, logs it once, and emits nothing', () => {
    const { events, logs, normalizer } = harness();
    normalizer.ingest('item/quantumFlux/delta', { turnId: 't1' });
    normalizer.ingest('item/quantumFlux/delta', { turnId: 't1' });
    expect(events).toEqual([]);
    expect(normalizer.stats().unknownNotifications).toBe(2);
    // One WARN per NAME: a per-frame WARN on a chatty new delta drowns the log.
    expect(logs.filter((l) => String(l[0]).startsWith('WARN'))).toHaveLength(1);
  });

  it('separates deliberate drops from unknown ones in the counters', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
    normalizer.ingest('turn/plan/updated', { threadId: THREAD });
    expect(events).toEqual([]);
    expect(normalizer.stats().ignoredNotifications).toBe(2);
    expect(normalizer.stats().unknownNotifications).toBe(0);
  });

  it.each(Object.values(CODEX_NORMALIZER_METHODS))('survives garbage params on %s', (method) => {
    const { events, normalizer } = harness();
    for (const junk of [null, undefined, 'string', 42, [], {}, { item: 'not an item' }]) {
      expect(() => normalizer.ingest(method, junk)).not.toThrow();
    }
    expect(events.filter((e) => e.type === 'host.error')).toEqual([]);
  });

  // CODEX_ERROR_METHOD ('error') is routed OUTSIDE CODEX_NORMALIZER_METHODS
  // (see that constant's docstring), so it needs its own garbage-params case —
  // the parameterized one above never reaches it.
  it('survives garbage params on the error method too', () => {
    const { events, normalizer } = harness();
    for (const junk of [null, undefined, 'string', 42, [], {}, { error: 'not an object' }]) {
      expect(() => normalizer.ingest(CODEX_ERROR_METHOD, junk)).not.toThrow();
    }
    expect(events.filter((e) => e.type === 'host.error')).toEqual([]);
  });

  it('counts an unknown item type instead of dropping it silently', () => {
    const { normalizer } = harness();
    normalizer.ingest('item/completed', {
      turnId: 't1',
      item: { type: 'quantumThought', id: 'q1' },
    });
    expect(normalizer.stats().unknownItems).toBe(1);
  });
});

describe('one session is one thread', () => {
  it('drops a frame belonging to another thread', () => {
    const { events, normalizer } = harness(THREAD);
    normalizer.ingest('item/completed', {
      threadId: 'someone-elses-thread',
      turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: 'leak' },
    });
    expect(events).toEqual([]);
    expect(normalizer.stats().foreignThreadFrames).toBe(1);
  });

  it('accepts a frame that carries no threadId at all', () => {
    const { normalizer } = harness(THREAD);
    normalizer.ingest('item/started', { item: { type: 'plan', id: 'p1', text: '' } });
    expect(normalizer.stats().foreignThreadFrames).toBe(0);
  });
});

/**
 * D47 S4a point ① — the existing `[object Object]` bug at the old `:504-521`:
 * `turn.error` is an OBJECT on the wire (E4 [实测]), and the old
 * `String(turnError)` produced the literal text `[object Object]` instead of
 * anything readable.
 */
describe('turn.error object shape (D47 S4a point ①)', () => {
  it('reads .message off an object-shaped turn.error instead of stringifying the object', () => {
    const { events, normalizer } = harness();
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: {
        id: 't',
        status: 'failed',
        error: {
          message: 'Missing environment variable: `AICLIENT_CODEX_API_KEY`.',
          codexErrorInfo: 'other',
          additionalDetails: null,
        },
      },
    });
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed' });
    expect(String(failed?.payload?.error)).not.toContain('[object Object]');
    expect(failed?.payload?.error).toBe('Missing environment variable: `AICLIENT_CODEX_API_KEY`.');
  });

  it('still accepts the plain-string turn.error shape (backward compatibility)', () => {
    // The existing "reports a failed turn as failed" case above already pins
    // this; repeated here as the explicit before/after pair for point ①.
    const { events, normalizer } = harness();
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: { id: 't', status: 'failed', error: 'model exploded' },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'session.failed',
      payload: { error: 'model exploded' },
    });
  });

  it('falls back to the generic turn-status text when the error object has no .message', () => {
    // Presence, not readability, decides `failed` — an unreadable error object
    // must still fail the turn, just without a fabricated "[object Object]".
    const { events, normalizer } = harness();
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: { id: 't', status: 'failed', error: { codexErrorInfo: 'other' } },
    });
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed' });
    expect(failed?.payload?.error).toBe('turn failed');
    expect(String(failed?.payload?.error)).not.toContain('[object Object]');
  });
});

/**
 * D47 S4a point ② — `classifyCodexTurnError` is pure and unit-tested directly
 * against the E4-measured shapes (both arms) plus the generic-"other" arm the
 * spec's three required test arms name explicitly.
 */
describe('classifyCodexTurnError (D47 S4a point ②, pure function)', () => {
  const MISSING_ENVKEY_ERROR = {
    message: 'Missing environment variable: `AICLIENT_CODEX_API_KEY`.',
    codexErrorInfo: 'other',
    additionalDetails: null,
  };

  it('classifies the E4 missing-envkey shape as codex_credentials_missing', () => {
    expect(classifyCodexTurnError(MISSING_ENVKEY_ERROR)).toBe('codex_credentials_missing');
  });

  it('does not misclassify the E4 present-group network-retry shape (codexErrorInfo is an object, not "other")', () => {
    expect(
      classifyCodexTurnError({
        message: 'Reconnecting... 1/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: 'stream disconnected before completion',
      })
    ).toBeNull();
  });

  it('does not misclassify a generic "other" error with an unrelated message', () => {
    expect(
      classifyCodexTurnError({ message: 'model produced invalid output', codexErrorInfo: 'other' })
    ).toBeNull();
  });

  it('requires BOTH message substrings, not just "Missing environment variable"', () => {
    // A missing variable with a DIFFERENT name is a real misconfiguration —
    // must not be papered over as "our" credentials_missing case.
    expect(
      classifyCodexTurnError({
        message: 'Missing environment variable: `SOME_OTHER_KEY`.',
        codexErrorInfo: 'other',
      })
    ).toBeNull();
  });

  it('requires AICLIENT_CODEX_API_KEY even when codexErrorInfo is "other" and the message is close', () => {
    expect(
      classifyCodexTurnError({
        message: 'AICLIENT_CODEX_API_KEY is set but invalid',
        codexErrorInfo: 'other',
      })
    ).toBeNull();
  });

  it('returns null for non-object / message-less input instead of throwing', () => {
    for (const junk of [null, undefined, 'string', 42, [], {}, { codexErrorInfo: 'other' }]) {
      expect(() => classifyCodexTurnError(junk)).not.toThrow();
      expect(classifyCodexTurnError(junk)).toBeNull();
    }
  });

  it('classifies codexErrorInfo:"contextWindowExceeded" as codex_context_window_exceeded', () => {
    expect(
      classifyCodexTurnError({
        codexErrorInfo: 'contextWindowExceeded',
        message: 'context window exceeded',
      })
    ).toBe('codex_context_window_exceeded');
  });

  it('contextWindowExceeded is recognised regardless of message content', () => {
    expect(classifyCodexTurnError({ codexErrorInfo: 'contextWindowExceeded' })).toBe(
      'codex_context_window_exceeded'
    );
  });

  it('contextWindowExceeded does not fall through to the credentials_missing path', () => {
    // codexErrorInfo:'contextWindowExceeded' must be caught BEFORE the 'other' guard.
    const result = classifyCodexTurnError({
      codexErrorInfo: 'contextWindowExceeded',
      message: 'Missing environment variable: `AICLIENT_CODEX_API_KEY`.',
    });
    expect(result).toBe('codex_context_window_exceeded');
    expect(result).not.toBe('codex_credentials_missing');
  });
});

/**
 * D47 S4a point ③ — E4 machine fixtures (`fixtures/codex/e4-{missing,present}-envkey.jsonl`,
 * readFileSync-driven, never parsed out of the docs markdown — spec B 轨 B4).
 * The three required test arms: missing group's dual carrier fires exactly
 * once / present group's network arm is never misjudged as terminal / a
 * generic "other" error (synthetic, since no real fixture) is not misjudged
 * either.
 */
describe('E4 fixture replay — exactly-once credential classification (D47 S4a point ③)', () => {
  it('missing group: the error notification and turn/completed carry the SAME error, but only one session.failed is emitted', () => {
    const { events, normalizer } = harness();
    replay(normalizer, 'e4-missing-envkey.jsonl');

    const failed = events.filter((e) => e.type === 'session.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload?.error).toBe(
      'Missing environment variable: `AICLIENT_CODEX_API_KEY`.'
    );
    expect(events.filter((e) => e.type === 'session.completed')).toEqual([]);
    // The turn observed exactly one completion frame, exactly-once bookkeeping
    // intact even though two frames carried terminal-shaped information.
    expect(normalizer.stats().turnsCompleted).toBe(1);
  });

  it('present group: the willRetry:true network-retry arm never escalates to a terminal event', () => {
    const { events, normalizer } = harness();
    replay(normalizer, 'e4-present-envkey.jsonl');

    expect(events.filter((e) => e.type === 'session.failed')).toEqual([]);
    expect(events.filter((e) => e.type === 'session.completed')).toEqual([]);
    // No turn/completed in this capture window (still retrying) — the counter
    // must not have been bumped by the willRetry:true error notification.
    expect(normalizer.stats().turnsCompleted).toBe(0);
  });

  it('a generic "other" error (synthetic — no real fixture) that does not match the substrings still fails the turn honestly, without a credentials_missing classification', () => {
    const { events, normalizer } = harness();
    normalizer.ingest(CODEX_ERROR_METHOD, {
      error: { message: 'internal model error', codexErrorInfo: 'other', additionalDetails: null },
      willRetry: false,
      threadId: THREAD,
      turnId: 't-other',
    });
    normalizer.ingest('turn/completed', {
      threadId: THREAD,
      turn: {
        id: 't-other',
        status: 'failed',
        error: {
          message: 'internal model error',
          codexErrorInfo: 'other',
          additionalDetails: null,
        },
      },
    });

    const failed = events.filter((e) => e.type === 'session.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload?.error).toBe('internal model error');
  });

  it('contextWindowExceeded surfaces a directed UI message instead of the raw wire text', () => {
    const { events, normalizer } = harness();
    normalizer.ingest(CODEX_ERROR_METHOD, {
      error: { codexErrorInfo: 'contextWindowExceeded', message: 'Context window size exceeded' },
      willRetry: false,
      threadId: THREAD,
      turnId: 't-ctx',
    });

    const failed = events.filter((e) => e.type === 'session.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload?.error).toBe(
      'context window exceeded — start a new session or compact the context'
    );
  });

  it('a named error followed by teardown (no turn/completed ever arrives) still emits exactly one terminal event', () => {
    // The process-exit race `closeTurn`'s `terminalEmitted` guard exists for:
    // an `error` notification already reported this turn, then the codex
    // process dies before `turn/completed` arrives, and `codexRuntime.ts`'s
    // exit handler calls `closeTurn` directly.
    const { events, normalizer } = harness();
    normalizer.ingest(CODEX_ERROR_METHOD, {
      error: {
        message: 'Missing environment variable: `AICLIENT_CODEX_API_KEY`.',
        codexErrorInfo: 'other',
        additionalDetails: null,
      },
      willRetry: false,
      threadId: THREAD,
      turnId: 't-crash',
    });
    normalizer.closeTurn('failed', 'codex app-server exited (code=null, signal=SIGKILL)');

    const failed = events.filter((e) => e.type === 'session.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload?.error).toBe(
      'Missing environment variable: `AICLIENT_CODEX_API_KEY`.'
    );
  });
});
