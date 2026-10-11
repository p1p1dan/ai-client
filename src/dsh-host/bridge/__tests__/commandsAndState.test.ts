import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_INSTRUCTIONS_NOTE_KEY } from '../../../shared/compactInstructions.ts';
import {
  AICLIENT_COMPACT_TIMEOUT_REASON,
  DSH_COMPACT_CANCELLED_KEY,
  DSH_COMPACT_TIMEOUT_KEY,
} from '../../../shared/dshHistory/types.ts';
import {
  WORKER_COMMAND_TIMEOUT,
  WORKER_COMMAND_UNKNOWN,
  WORKER_COMPACT_BUDGET_MS,
  WORKER_COMPACT_CANCELLED,
  WORKER_COMPACT_INSTRUCTIONS_TOO_LONG,
  WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED,
  WORKER_COMPACT_REQUEST_TIMEOUT_MS,
  WORKER_COMPACT_SETTLE_MS,
} from '../../../shared/types/workerRpc.ts';
import type { BridgeSessionRuntimeOptions } from '../bridgeRpcServer.ts';
import type { DshCommandResult, DshSkillSummary } from '../commands.ts';
import { compactInstructionsPrompt } from '../compactInstructions.ts';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  DshSessionRuntime,
  dshSessionIdFor,
} from '../dshSessionRuntime.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase P1-4d2 (decisions 099 rules 9-12, 113) — commands and state
 * against a fake Cordis context: the menu, command sends, `worker.compact`,
 * `session.projection` and the capability inventory. The real engine runs
 * under tools/bridge-record.ts (`compact`) and tools/bridge-smoke.ts (host H).
 */

const CWD = '/repo';
const LOGICAL = 'session-1';
const DSH_ID = dshSessionIdFor(LOGICAL);

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-bridge-4d2-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Emitted {
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

type Handler = (
  rawInput: string,
  signal: AbortSignal,
  /** The pairing id DSH minted for this run (`command/run`), which its compaction names. */
  commandId?: string
) => DshCommandResult | Promise<DshCommandResult>;

/** A Cordis context narrowed to what the bridge reads, with the optional services set per test. */
function fakeHost() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const followups: unknown[] = [];
  const agent = {
    id: DSH_ID,
    status: 'idle',
    session: { header: { cwd: CWD } },
    followup: (message: unknown) => followups.push(message),
    steer: vi.fn(),
    cancel: vi.fn(),
    runMaintenance: vi.fn(),
  };
  const handle = { agent, dispose: async () => undefined };
  const services: Record<string, unknown> = {};
  let seq = 0;
  /** One durable event of this session, as DSH's `session/event` delivers it. */
  const append = (type: string, data: Record<string, unknown>) => {
    const event = { type, seq, time: 1_790_000_000_000 + seq, data };
    seq += 1;
    listeners.get('session/event')?.({ id: DSH_ID }, event);
    return event;
  };
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    agents: { create: vi.fn(async () => handle), resume: vi.fn(async () => handle) },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'aiclient-gateway', model: 'fake-1' }),
    },
    sessions: { flush: vi.fn(async () => true) },
    sessionQuery: {
      observeSession: vi.fn(async () => ({
        events: [],
        cursor: -1,
        [Symbol.dispose]: () => undefined,
      })),
    },
    aiclientPermissions: testPermissionHost().api,
    // Prompts go through admission; the fake keeps every part as it came.
    attachments: {
      admitPromptContent: vi.fn(async (parts: unknown[]) => parts),
      saveFile: vi.fn(async (input: { name?: string }) => ({
        attachmentId: 'sha256:file',
        name: input.name ?? 'file',
        bytes: 2,
      })),
      isAttachmentError: () => false,
    },
    get: (name: string) => services[name],
  } as unknown as DshBridgeContext;
  /** A host event (`goal/activation-changed`, P1-7a) to whoever of this runtime listens. */
  const fire = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args);
  return { ctx, agent, followups, append, services, fire };
}

/**
 * `ctx.commands` over a table of handlers, logging as dsh-commands does:
 * `command/run` before the handler (synchronously, at the call), and
 * `command/done` at settlement; an unknown line resolves undefined, logging nothing.
 */
function fakeCommands(
  host: ReturnType<typeof fakeHost>,
  table: Record<string, { description: string; handler?: Handler }>
) {
  let minted = 0;
  const service = {
    list: vi.fn((_agent: unknown) =>
      Object.keys(table)
        .sort()
        .map((name) => ({ name, description: table[name]?.description ?? '' }))
    ),
    find: vi.fn((_agent: unknown, name: string) => table[name]),
    execute: vi.fn(
      async (
        _agent: unknown,
        line: string,
        _attachments: readonly unknown[],
        signal: AbortSignal
      ) => {
        const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
        const command = match ? table[match[1] ?? ''] : undefined;
        if (!match || !command) return undefined;
        minted += 1;
        const commandId = `cmd-test-${minted}`;
        const args = line.slice(match[0].length);
        host.append('command/run', { commandId, name: match[1], args, source: { kind: 'user' } });
        try {
          const result = await (command.handler ?? (() => ({ kind: 'success' as const })))(
            args,
            signal,
            commandId
          );
          host.append('command/done', { commandId, ...result });
          return { commandId, result };
        } catch (error) {
          // As dsh-commands' `settleThrown`: the error's message.
          host.append('command/done', {
            commandId,
            kind: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    ),
  };
  host.services.commands = service;
  return service;
}

/** `ctx.sessionProjections`: fixed values, and the change feed a test drives. */
function fakeProjections(host: ReturnType<typeof fakeHost>, values: Record<string, unknown>) {
  let listener: ((session: { id: string }, key: string, value: unknown) => void) | undefined;
  const snapshot = vi.fn((_session: unknown, keys?: readonly string[]) => ({
    values: Object.fromEntries(
      Object.entries(values).filter(([key]) => keys === undefined || keys.includes(key))
    ),
  }));
  host.services.sessionProjections = {
    snapshot,
    onChanged: (next: typeof listener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    snapshot,
    change: (key: string, value: unknown, sessionId = DSH_ID) =>
      listener?.({ id: sessionId }, key, value),
  };
}

function skill(name: string, userInvocable = true, source = 'user-agents'): DshSkillSummary {
  return {
    name,
    description: `${name} skill`,
    path: `/skills/${name}/SKILL.md`,
    source,
    invocation: { modelInvocable: true, userInvocable },
  };
}

const deps: DshBridgeDeps = {
  createUserMessage: vi.fn(() => ({ id: 'user-message-1' })),
  now: () => 1_700_000_000_000,
  modelPlan: () => TEST_PLAN,
};

function runtime(
  ctx: DshBridgeContext,
  emitted: Emitted[],
  extra: Partial<DshBridgeDeps> = {},
  options: Partial<BridgeSessionRuntimeOptions> = {}
): DshSessionRuntime {
  return new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: CWD,
      projectTrusted: true,
      emit: (event) => emitted.push(event as Emitted),
      ...options,
    },
    { ...deps, home, ...extra }
  );
}

const send = (requestId: string, text: string, extra: Record<string, unknown> = {}) => ({
  logicalSessionId: LOGICAL,
  requestId,
  attemptId: `attempt-${requestId}`,
  text,
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

/** Types, and the requestId where it matters, of what went out. */
const shape = (events: Emitted[]) =>
  events.map((event) => `${event.type}${event.requestId ? `@${event.requestId}` : ''}`);

describe('DshSessionRuntime — the slash menu (P1-4d2, decisions 047, 099 rule 9, 101, 113)', () => {
  it('[D2-MENU] lists DSH commands but the hidden and window-owned ones, then the user-invocable skills', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      compact: { description: 'Compact older conversation history' },
      feedback: { description: 'Record feedback' },
      goal: { description: 'Set or view the goal' },
      plan: { description: 'Enter plan mode' },
    });
    const list = vi.fn(async () => [
      skill('goal'),
      skill('compact'),
      skill('plan'),
      skill('review', true, 'project-dsh'),
      skill('model-only', false),
    ]);
    host.services.skills = { list };
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const result = await bridge.commands({ logicalSessionId: LOGICAL });

    expect(result).toEqual({
      commands: [
        { name: 'goal', description: 'Set or view the goal', source: 'command' },
        // `/plan` is hidden, so a line-start `/plan` goes to the model and reaches this skill.
        {
          name: 'plan',
          description: 'plan skill',
          source: 'skill',
          path: '/skills/plan/SKILL.md',
          scope: 'user-agents',
        },
        {
          name: 'review',
          description: 'review skill',
          source: 'skill',
          path: '/skills/review/SKILL.md',
          scope: 'project-dsh',
        },
      ],
      truncated: false,
    });
    // The skill lookup dsh-tool-skill makes: the agent's workspace and scope.
    expect(list).toHaveBeenCalledWith({ cwd: CWD, scope: host.agent });
    // Nothing is spelled the 1.0.x way.
    expect(JSON.stringify(result)).not.toContain('skill:');
  });

  it('[D2-MENU-NONE] answers an empty menu without a session or services; a failed skill read keeps the commands', async () => {
    const host = fakeHost();
    const bridge = runtime(host.ctx, []);
    expect(await bridge.commands({ logicalSessionId: LOGICAL })).toEqual({
      commands: [],
      truncated: false,
    });
    await bridge.bootstrap();
    expect(await bridge.commands({ logicalSessionId: LOGICAL })).toEqual({
      commands: [],
      truncated: false,
    });
    fakeCommands(host, { goal: { description: 'Set or view the goal' } });
    host.services.skills = {
      list: async () => {
        throw new Error('skill root unreadable');
      },
    };
    expect((await bridge.commands({ logicalSessionId: LOGICAL })).commands).toEqual([
      { name: 'goal', description: 'Set or view the goal', source: 'command' },
    ]);
  });
});

describe('DshSessionRuntime — command sends (P1-4d2, decisions 099 rule 9, 113)', () => {
  it('[D2-CMD-SEND] runs a known command line through ctx.commands.execute: no model turn', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      goal: { description: 'goal', handler: () => ({ kind: 'success', text: 'Goal created' }) },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    const accepted = await bridge.startSend(send('turn-GOAL', '/goal fix CI'));

    expect(accepted).toEqual({ accepted: true, requestId: 'turn-GOAL' });
    expect(commands.execute).toHaveBeenCalledWith(
      host.agent,
      '/goal fix CI',
      [],
      expect.any(AbortSignal)
    );
    await vi.waitFor(() => expect(emitted.at(-1)?.payload?.status).toBe('idle'));
    expect(host.followups).toEqual([]);
    expect(shape(emitted)).toEqual([
      'session.status@turn-GOAL',
      'message.started@turn-GOAL',
      'message.delta@turn-GOAL',
      'message.completed@turn-GOAL',
      'custom.message@turn-GOAL',
      'session.completed@turn-GOAL',
      'session.status@turn-GOAL',
    ]);
    expect(emitted[1]?.payload).toMatchObject({ role: 'user', attemptId: 'attempt-turn-GOAL' });
    expect(emitted[2]?.payload?.text).toBe('/goal fix CI');
    expect(emitted[4]?.payload).toMatchObject({
      customType: 'dsh:command',
      content: 'Goal created',
    });
    expect(bridge.busy).toBe(false);
  });

  it('[D2-CMD-PROMPT] anything else is a prompt: unknown, hidden, a path, or a command with attachments', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      goal: { description: 'goal' },
      plan: { description: 'plan' },
    });
    host.services.skills = { list: async () => [] };
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    const texts = ['/nope do it', '/plan the work', '/usr/bin/env ls', '/Goal upper', 'see /goal'];
    for (const [index, text] of texts.entries()) {
      await bridge.startSend(send(`turn-${index}`, text));
      host.append('turn/start', { turn: index + 1 });
      host.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } });
    }
    await bridge.startSend(
      send('turn-attached', '/goal look at this', {
        attachments: [{ kind: 'text', mediaType: 'text/plain', data: 'aGk=', name: 'a.txt' }],
      })
    );
    expect(commands.execute).not.toHaveBeenCalled();
    expect(host.followups).toHaveLength(texts.length + 1);
  });

  it('[D2-CMD-VANISHED] a command gone from the registry before it ran is sent as a prompt', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, { goal: { description: 'goal' } });
    commands.execute.mockResolvedValueOnce(undefined);
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    await bridge.startSend(send('turn-1', '/goal'));

    expect(host.followups).toHaveLength(1);
    expect(shape(emitted)).toEqual(['session.status@turn-1']);
  });

  it('[D2-CMD-BUSY] a command still running makes a second send busy; Stop cancels it', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: (_input, signal) =>
          new Promise<DshCommandResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Compaction cancelled.')));
          }),
      },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    await bridge.startSend(send('turn-C', '/compact'));
    expect(bridge.busy).toBe(true);
    expect((await refusal(bridge.startSend(send('turn-2', 'hello')))).code).toBe(
      'WORKER_SESSION_BUSY'
    );
    expect((await refusal(bridge.compact({ logicalSessionId: LOGICAL }))).code).toBe(
      'WORKER_SESSION_BUSY'
    );

    expect(await bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' } as never)).toEqual({
      stopped: true,
    });
    await vi.waitFor(() => expect(emitted.at(-1)?.payload?.status).toBe('idle'));
    const notice = emitted.find((event) => event.type === 'custom.message');
    expect(notice?.payload).toMatchObject({ customType: 'dsh:command-error' });
    expect(String(notice?.payload?.content)).toContain('Compaction cancelled.');
    expect(shape(emitted).slice(-2)).toEqual(['session.completed@turn-C', 'session.status@turn-C']);
    expect(bridge.busy).toBe(false);
  });

  it('[D2-CMD-GOAL-ROUND] a turn DSH starts while the command settles keeps the session running', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      goal: {
        description: 'goal',
        handler: () => {
          // The goal round driver opens a round of its own.
          host.agent.status = 'running';
          host.append('turn/start', { turn: 1 });
          return { kind: 'success', text: 'Goal created' };
        },
      },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    await bridge.startSend(send('turn-GOAL', '/goal ship it'));
    await vi.waitFor(() => expect(shape(emitted)).toContain('session.completed@turn-GOAL'));

    const round = `dsh-turn-${DSH_ID}-1`;
    const after = shape(emitted).slice(shape(emitted).indexOf('session.completed@turn-GOAL'));
    expect(after).toEqual(['session.completed@turn-GOAL', `session.status@${round}`]);
    expect(emitted.at(-1)?.payload?.status).toBe('running');
    expect(
      emitted.some((event) => event.requestId === 'turn-GOAL' && event.payload?.status === 'idle')
    ).toBe(false);
  });
});

describe('DshSessionRuntime — worker.compact (P1-4d2, decisions 099 rule 10, 113)', () => {
  it('[D2-COMPACT] runs DSH /compact without arguments; compacted when DSH names its summary', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: () => ({ kind: 'success', text: 'Compacted 4 history items', sourceEventSeq: 9 }),
      },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    expect(await bridge.compact({ logicalSessionId: LOGICAL })).toEqual({ compacted: true });
    // Blank instructions are no instructions.
    expect(await bridge.compact({ logicalSessionId: LOGICAL, instructions: '  ' })).toEqual({
      compacted: true,
    });
    expect(commands.execute).toHaveBeenCalledWith(
      host.agent,
      '/compact',
      [],
      expect.any(AbortSignal)
    );
    // worker.compact is not a send: nothing is echoed live.
    expect(emitted).toEqual([]);
  });

  it('[E2B-COMPACT-SUMMARY] hands back the context-summary row the command wrote (decision 140)', async () => {
    const host = fakeHost();
    let runs = 0;
    let writes = true;
    fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: () => {
          runs += 1;
          // DSH names a summary the cache never saw (it read the log elsewhere).
          if (!writes)
            return { kind: 'success', text: 'Compacted 2 history items', sourceEventSeq: 99 };
          const event = host.append('user/message', {
            id: `c${runs}`,
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'This is an automatically generated checkpoint ...\n\n<compacted-summary>',
              },
              { type: 'text', text: `## Current Work\n- round ${runs}` },
              { type: 'text', text: '</compacted-summary>' },
            ],
            source: { kind: 'compact-checkpoint', compactionId: `x${runs}` },
          });
          return { kind: 'success', text: 'Compacted 4 history items', sourceEventSeq: event.seq };
        },
      },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    // The row exactly as the history shows it on the next reopen (same `h:` id).
    const first = await bridge.compact({ logicalSessionId: LOGICAL });
    expect(first).toEqual({
      compacted: true,
      summary: {
        id: 'h:c1',
        entryId: 'c1',
        role: 'system',
        timestamp: 1_790_000_000_001,
        blocks: [
          {
            type: 'text',
            id: 'h:c1:summary:0',
            text: 'Context summary\n\n## Current Work\n- round 1',
          },
        ],
      },
    });
    const { page } = await bridge.history({ logicalSessionId: LOGICAL, offset: 0, limit: 50 });
    expect(page.messages.find((message) => message.id === 'h:c1')).toEqual(first.summary);
    // A run whose row the cache does not hold hands back none: the old row is not this one's.
    writes = false;
    expect(await bridge.compact({ logicalSessionId: LOGICAL })).toEqual({ compacted: true });
    // Still not a send: nothing is echoed live (decision 113 rule 8).
    expect(emitted).toEqual([]);
  });

  it("[D2-COMPACT-REFUSALS] DSH's answers in our codes: nothing to compact, a failure, no command", async () => {
    const host = fakeHost();
    const outcomes: DshCommandResult[] = [
      { kind: 'success', text: 'No compactable history yet.' },
      { kind: 'error', text: 'Compaction could not produce a useful summary.' },
    ];
    fakeCommands(host, {
      compact: { description: 'compact', handler: () => outcomes.shift() ?? { kind: 'success' } },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    expect(await refusal(bridge.compact({ logicalSessionId: LOGICAL }))).toMatchObject({
      code: 'WORKER_COMPACT_UNAVAILABLE',
      message: 'No compactable history yet.',
    });
    expect(await refusal(bridge.compact({ logicalSessionId: LOGICAL }))).toMatchObject({
      code: 'WORKER_COMPACT_FAILED',
      message: 'Compaction could not produce a useful summary.',
    });
    host.services.commands = undefined;
    expect((await refusal(bridge.compact({ logicalSessionId: LOGICAL }))).code).toBe(
      'WORKER_COMPACT_UNAVAILABLE'
    );
  });

  it('[D2-COMPACT-TIMEOUT] cancels a summary past its budget and says so, retryable', async () => {
    const host = fakeHost();
    const signals: AbortSignal[] = [];
    fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: (_input, signal) => {
          signals.push(signal);
          return new Promise<DshCommandResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('command aborted')));
          });
        },
      },
    });
    const bridge = runtime(host.ctx, [], { compactTimeoutMs: 20 });
    await bridge.bootstrap();

    const error = (await refusal(bridge.compact({ logicalSessionId: LOGICAL }))) as {
      code?: string;
      retryable?: boolean;
    };

    expect(error).toMatchObject({ code: 'WORKER_COMPACT_TIMEOUT', retryable: true });
    expect(signals[0]?.aborted).toBe(true);
  });

  it('[D2-COMPACT-BUSY] refuses while a turn runs', async () => {
    const host = fakeHost();
    fakeCommands(host, { compact: { description: 'compact' } });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'hello'));
    expect((await refusal(bridge.compact({ logicalSessionId: LOGICAL }))).code).toBe(
      'WORKER_SESSION_BUSY'
    );
  });
});

/** DSH's checkpoint template, as far as these tests need it. */
const TEMPLATE = 'You are now acting as a compaction engine for this AI coding assistant.';

/**
 * `ctx.compaction` with the shape of dsh-compaction-basic's summary hook: the
 * conversation, then the template, streamed through `this.ctx.llm`. Every
 * request it streamed is kept.
 */
function fakeCompaction(host: ReturnType<typeof fakeHost>) {
  const requests: { messages: { role: string; content: { text?: string }[] }[] }[] = [];
  const engine = {
    ctx: {
      llm: {
        stream(options: (typeof requests)[number]) {
          requests.push(options);
        },
      },
    },
    async summarize(
      this: { ctx: { llm: { stream(options: unknown): void } } },
      input: { messages: unknown[] },
      agent: { session: { id: string } }
    ) {
      this.ctx.llm.stream({
        messages: [
          ...input.messages,
          { role: 'user', content: [{ type: 'text', text: TEMPLATE }] },
        ],
        purpose: 'compaction',
        sessionId: agent.session.id,
      });
      return { summary: [{ type: 'text', text: '## Current Work\n- (none)' }] };
    },
  };
  host.services.compaction = engine;
  return { engine, requests };
}

/**
 * DSH's `/compact` as far as the bridge sees it: the summary hook called for
 * this session (unless `hook: false`), then `compaction/summary` and the
 * checkpoint it precedes, answered with the summary's seq.
 */
function compactHandler(
  host: ReturnType<typeof fakeHost>,
  engine: ReturnType<typeof fakeCompaction>['engine'],
  options: { hook?: boolean; result?: () => DshCommandResult } = {}
): Handler {
  let runs = 0;
  return async () => {
    runs += 1;
    if (options.hook !== false) {
      await engine.summarize(
        { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
        { session: { id: DSH_ID } }
      );
    }
    if (options.result) return options.result();
    const summary = host.append('compaction/summary', { compactionId: `k${runs}` });
    host.append('user/message', {
      id: `c${runs}`,
      role: 'user',
      content: [
        { type: 'text', text: 'checkpoint ...\n\n<compacted-summary>' },
        { type: 'text', text: `## Current Work\n- round ${runs}` },
        { type: 'text', text: '</compacted-summary>' },
      ],
      source: { kind: 'compact-checkpoint', compactionId: `k${runs}`, sourceCommandId: 'cmd' },
    });
    return { kind: 'success', text: 'Compacted 2 history items', sourceEventSeq: summary.seq };
  };
}

/** The text DSH's last summary request ended with. */
const lastInstruction = (requests: ReturnType<typeof fakeCompaction>['requests']) =>
  requests.at(-1)?.messages.at(-1)?.content[0]?.text;

describe('DshSessionRuntime — /compact with instructions (decision 179)', () => {
  it('[179-B-01] leased to this summary request, under the summary row, beside the stub', async () => {
    const host = fakeHost();
    const { engine, requests } = fakeCompaction(host);
    const commands = fakeCommands(host, {
      compact: { description: 'compact', handler: compactHandler(host, engine) },
    });
    const bridge = runtime(host.ctx, []);
    const boot = await bridge.bootstrap();

    const result = await bridge.compact({
      logicalSessionId: LOGICAL,
      instructions: '  保留未完成的任务\r\n和失败经验  ',
    });

    // Still DSH's /compact, with no argument.
    expect(commands.execute).toHaveBeenCalledWith(
      host.agent,
      '/compact',
      [],
      expect.any(AbortSignal)
    );
    expect(lastInstruction(requests)).toBe(
      `${TEMPLATE}\n\n${compactInstructionsPrompt('保留未完成的任务\n和失败经验')}`
    );
    expect(result.instructionsApplied).toBe(true);
    expect(result.summary?.blocks).toEqual([
      { type: 'text', id: 'h:c1:summary:0', text: 'Context summary\n\n## Current Work\n- round 1' },
      {
        type: 'text',
        id: 'h:c1:compact-instructions:0',
        text: 'Instructions for this summary: 保留未完成的任务\n和失败经验',
        notice: {
          key: COMPACT_INSTRUCTIONS_NOTE_KEY,
          params: { instructions: '保留未完成的任务\n和失败经验' },
        },
      },
    ]);
    const stub = JSON.parse(readFileSync(String(boot.sessionFile), 'utf8'));
    expect(stub.compactInstructions).toEqual([
      { compactionId: 'k1', instructions: '保留未完成的任务\n和失败经验', at: 1_700_000_000_000 },
    ]);

    // Over: `/compact` alone is DSH's own request again, and its row has no line.
    const plain = await bridge.compact({ logicalSessionId: LOGICAL });
    expect(lastInstruction(requests)).toBe(TEMPLATE);
    expect(plain.instructionsApplied).toBeUndefined();
    expect(plain.summary?.blocks).toHaveLength(1);
  });

  it('[179-B-02] released however it ends: DSH refused, timed out', async () => {
    const host = fakeHost();
    const { engine, requests } = fakeCompaction(host);
    let mode: 'error' | 'hang' | 'ok' = 'error';
    const handler = compactHandler(host, engine, {
      result: () => ({ kind: 'error', text: 'Compaction could not produce a useful summary.' }),
    });
    const succeeds = compactHandler(host, engine);
    fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: async (input, signal) => {
          if (mode === 'error') return handler(input, signal);
          if (mode === 'ok') return succeeds(input, signal);
          return new Promise<DshCommandResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      },
    });
    const bridge = runtime(host.ctx, [], { compactTimeoutMs: 20 });
    await bridge.bootstrap();

    expect(
      await refusal(bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep it' }))
    ).toMatchObject({ code: 'WORKER_COMPACT_FAILED' });
    mode = 'hang';
    expect(
      (await refusal(bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep it' }))).code
    ).toBe('WORKER_COMPACT_TIMEOUT');
    // Neither left a lease behind: the next summary is DSH's own, and kept no line.
    mode = 'ok';
    const plain = await bridge.compact({ logicalSessionId: LOGICAL });
    expect(lastInstruction(requests)).toBe(TEMPLATE);
    expect(plain.summary?.blocks).toHaveLength(1);
  });

  it('[179-B-03] too long, or an engine that cannot carry them: refused before anything runs', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: () => ({ kind: 'success', text: 'Compacted 4 history items', sourceEventSeq: 9 }),
      },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const long = await refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: '字'.repeat(2001) })
    );
    expect(long).toMatchObject({ code: WORKER_COMPACT_INSTRUCTIONS_TOO_LONG });
    expect(long.message).toMatch(
      /2001 characters, more than the 2000 taken; nothing was compacted/
    );
    // No compaction service on this host.
    const unsupported = await refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep it' })
    );
    expect(unsupported).toMatchObject({ code: WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED });
    expect(unsupported.message).toMatch(
      /this host has no compaction service.*nothing was compacted/
    );
    expect(commands.execute).not.toHaveBeenCalled();
    // Blank is no instructions: `/compact` alone.
    expect(
      (await bridge.compact({ logicalSessionId: LOGICAL, instructions: ' \n\t ' })).compacted
    ).toBe(true);
    expect(commands.execute).toHaveBeenCalledTimes(1);
  });

  it('[179-B-04] a summary request the hook cannot extend: not sent, said as unsupported', async () => {
    const host = fakeHost();
    const { engine, requests } = fakeCompaction(host);
    // The hook a later DSH might have: right on its dry run, then a request
    // with no `purpose` and an empty instruction.
    const original = engine.summarize;
    let calls = 0;
    engine.summarize = async function (this: typeof engine, input, agent) {
      calls += 1;
      if (calls === 1) return original.call(this, input, agent);
      (this.ctx.llm.stream as (options: unknown) => void)({
        messages: [...input.messages, { role: 'user', content: [] }],
      });
      return { summary: [] };
    };
    fakeCommands(host, {
      compact: {
        description: 'compact',
        // DSH's transaction: a hook that throws is a summary that failed.
        handler: async () => {
          try {
            await engine.summarize({ messages: [] }, { session: { id: DSH_ID } });
          } catch {
            return { kind: 'error', text: 'Compaction could not produce a useful summary.' };
          }
          return { kind: 'success', sourceEventSeq: 1 };
        },
      },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const error = await refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep it' })
    );
    expect(error).toMatchObject({ code: WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED });
    expect(error.message).toMatch(/not the summary request.*nothing was compacted/);
    expect(requests).toEqual([]);
    // Known now: the next request is refused up front.
    expect(
      (await refusal(bridge.compact({ logicalSessionId: LOGICAL, instructions: 'again' }))).code
    ).toBe(WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED);
    expect(calls).toBe(2);
  });

  it('[179-B-05] a summary written without the hook is said (instructionsApplied: false)', async () => {
    const host = fakeHost();
    const { engine } = fakeCompaction(host);
    fakeCommands(host, {
      compact: { description: 'compact', handler: compactHandler(host, engine, { hook: false }) },
    });
    const bridge = runtime(host.ctx, []);
    const boot = await bridge.bootstrap();

    const result = await bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep it' });

    expect(result).toMatchObject({ compacted: true, instructionsApplied: false });
    expect(result.summary?.blocks).toHaveLength(1);
    expect(JSON.parse(readFileSync(String(boot.sessionFile), 'utf8')).compactInstructions).toBe(
      undefined
    );
    expect(
      (await refusal(bridge.compact({ logicalSessionId: LOGICAL, instructions: 'again' }))).code
    ).toBe(WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED);
  });

  it('[179-B-06] two at once: the second is busy, the first keeps its lease', async () => {
    const host = fakeHost();
    const { engine, requests } = fakeCompaction(host);
    const succeed = compactHandler(host, engine);
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeCommands(host, {
      compact: {
        description: 'compact',
        handler: async (input, signal) => {
          entered = true;
          await gate;
          return succeed(input, signal);
        },
      },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const first = bridge.compact({ logicalSessionId: LOGICAL, instructions: 'first' });
    await vi.waitFor(() => expect(entered).toBe(true));
    const second = await refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: 'second' })
    );
    expect(second).toMatchObject({ code: 'WORKER_SESSION_BUSY' });
    release();
    expect((await first).instructionsApplied).toBe(true);
    expect(lastInstruction(requests)).toContain('first');
    expect(lastInstruction(requests)).not.toContain('second');
  });

  it('[179-B-07] reopened: the summary row carries its instructions from the stub', async () => {
    const host = fakeHost();
    const stubFile = join(home, 'aiclient-sessions', `${DSH_ID}.dsh.json`);
    mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
    writeFileSync(
      stubFile,
      JSON.stringify({
        engine: 'dsh',
        version: 2,
        dshSessionId: DSH_ID,
        logicalSessionId: LOGICAL,
        cwd: CWD,
        createdAt: 1,
        lineage: [{ dshSessionId: DSH_ID, reason: 'create', at: 1 }],
        compactInstructions: [
          { compactionId: 'k7', instructions: 'keep the failing tests', at: 2 },
          { compactionId: 42, instructions: 'malformed, skipped' },
        ],
      })
    );
    const checkpoint = (id: string, compactionId: string, seq: number) => ({
      type: 'user/message',
      seq,
      time: 1_790_000_000_000 + seq,
      data: {
        id,
        role: 'user',
        content: [
          { type: 'text', text: '<compacted-summary>## Current Work\n- x</compacted-summary>' },
        ],
        source: { kind: 'compact-checkpoint', compactionId },
      },
    });
    (host.ctx.sessionQuery.observeSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [checkpoint('c7', 'k7', 0), checkpoint('c8', 'k8', 1)],
      cursor: 1,
      [Symbol.dispose]: () => undefined,
    });
    const bridge = runtime(host.ctx, [], {}, { sessionFile: stubFile });
    await bridge.bootstrap();

    const { page } = await bridge.history({ logicalSessionId: LOGICAL, offset: 0, limit: 50 });
    expect(page.messages.map((message) => message.blocks.map((block) => block.id))).toEqual([
      ['h:c7:summary:0', 'h:c7:compact-instructions:0'],
      ['h:c8:summary:0'],
    ]);
  });
});

describe('DshSessionRuntime — session.projection (P1-4d2, decisions 031, 099 rule 11, 113)', () => {
  const todos = [{ content: 'write the tests', status: 'in_progress' }];

  it('[D2-PROJ-BASELINE] sends the three keys once, ahead of the first event after bootstrap', async () => {
    const host = fakeHost();
    const projections = fakeProjections(host, {
      todos,
      goal: null,
      subagentCatalog: [],
      plan: { mode: 'off' },
      permissions: { preset: 'x' },
    });
    fakeCommands(host, { goal: { description: 'goal' } });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);

    await bridge.bootstrap();
    // Main drops what a slot sends before it is ready: nothing goes out at bootstrap.
    expect(emitted).toEqual([]);
    expect(projections.snapshot).toHaveBeenCalledWith(expect.anything(), [
      'todos',
      'goal',
      'subagentCatalog',
    ]);

    await bridge.startSend(send('turn-GOAL', '/goal'));
    await vi.waitFor(() => expect(emitted.at(-1)?.payload?.status).toBe('idle'));
    expect(emitted.slice(0, 4)).toEqual([
      { sessionId: LOGICAL, type: 'session.projection', payload: { key: 'todos', view: todos } },
      { sessionId: LOGICAL, type: 'session.projection', payload: { key: 'goal', view: null } },
      {
        sessionId: LOGICAL,
        type: 'session.projection',
        payload: { key: 'subagentCatalog', view: [] },
      },
      {
        sessionId: LOGICAL,
        type: 'session.status',
        requestId: 'turn-GOAL',
        payload: { status: 'running' },
      },
    ]);
    expect(emitted.filter((event) => event.type === 'session.projection')).toHaveLength(3);
  });

  it('[D2-PROJ-CHANGE] forwards a change of this session’s three keys, nothing else', async () => {
    const host = fakeHost();
    const projections = fakeProjections(host, { todos: null, goal: null, subagentCatalog: [] });
    fakeCommands(host, { goal: { description: 'goal' } });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-GOAL', '/goal'));
    await vi.waitFor(() => expect(emitted.at(-1)?.payload?.status).toBe('idle'));
    emitted.length = 0;

    projections.change('todos', todos);
    projections.change('plan', { mode: 'on' });
    projections.change('todos', [], 'aiclient-subagent-child');
    const goal = { goal: { id: 'g1', revision: 1, objective: 'x', phase: 'active' } };
    projections.change('goal', goal);

    expect(emitted).toEqual([
      { sessionId: LOGICAL, type: 'session.projection', payload: { key: 'todos', view: todos } },
      { sessionId: LOGICAL, type: 'session.projection', payload: { key: 'goal', view: goal } },
    ]);
  });

  it('[D2-PROJ-FIRST-CHANGE] a change that finds the baseline waiting joins it and sends it once', async () => {
    const host = fakeHost();
    const projections = fakeProjections(host, { todos: null, goal: null });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    // Before the bootstrap finished nothing is forwarded: the baseline covers it.
    projections.change('todos', todos);
    await bridge.bootstrap();
    expect(emitted).toEqual([]);

    projections.change('todos', todos);

    expect(emitted.map((event) => event.payload)).toEqual([
      { key: 'todos', view: todos },
      { key: 'goal', view: null },
    ]);
  });

  it('[D2-PROJ-NONE] a host without projections sends none, and its sends go on', async () => {
    const host = fakeHost();
    fakeCommands(host, { goal: { description: 'goal' } });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-GOAL', '/goal'));
    await vi.waitFor(() => expect(emitted.at(-1)?.payload?.status).toBe('idle'));
    expect(emitted.some((event) => event.type === 'session.projection')).toBe(false);
  });
});

describe('DshSessionRuntime — capabilities (P1-4d2, decisions 099 rule 12, 113)', () => {
  it('[D2-CAPS] reports every skill the agent sees, and nothing else', async () => {
    const host = fakeHost();
    host.services.skills = {
      list: vi.fn(async () => [skill('review'), skill('model-only', false), skill('plan')]),
    };
    const result = await runtime(host.ctx, []).bootstrap();
    expect(result.capabilities).toEqual({ skills: 3 });
  });

  it('[D2-CAPS-NONE] no registry, or a failed read, is "not reported" and never a failed bootstrap', async () => {
    const bare = fakeHost();
    expect((await runtime(bare.ctx, []).bootstrap()).capabilities).toEqual({});
    const failing = fakeHost();
    failing.services.skills = {
      list: async () => {
        throw new Error('skill root unreadable');
      },
    };
    const result = await runtime(failing.ctx, []).bootstrap();
    expect(result.bootstrapped).toBe(true);
    expect(result.capabilities).toEqual({});
  });
});

/**
 * dsh-rebase P1-7a (decisions 072 rules 1-2, 113 rule 12, 118): the goal
 * bar's out-of-band command, the panels' rehydration and the bridge-made
 * `goalActivation` key, against the same fake context.
 */
describe('DshSessionRuntime — worker.command (P1-7a, decisions 072 rule 2, 118)', () => {
  it('[P7A-CMD] runs a known command out of band: no turn, no event, DSH’s text back', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      goal: {
        description: 'goal',
        handler: (input) =>
          input.trim() === 'pause'
            ? { kind: 'success', text: 'Goal paused' }
            : { kind: 'error', text: 'The goal command is not valid for the current state.' },
      },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    expect(await bridge.command({ logicalSessionId: LOGICAL, line: '/goal pause' })).toEqual({
      ok: true,
      output: 'Goal paused',
    });
    expect(await bridge.command({ logicalSessionId: LOGICAL, line: '/goal resume' })).toEqual({
      ok: false,
      error: 'The goal command is not valid for the current state.',
    });
    expect(commands.execute).toHaveBeenCalledWith(
      host.agent,
      '/goal pause',
      [],
      expect.any(AbortSignal)
    );
    // DSH logged both lifecycles; the live translation shows neither, and no turn opened.
    expect(emitted).toEqual([]);
    expect(host.followups).toEqual([]);
    expect(bridge.busy).toBe(false);
  });

  it('[P7A-CMD-RUNNING] a running turn does not refuse it, and its events go on untouched', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      goal: { description: 'goal', handler: () => ({ kind: 'success', text: 'Goal paused' }) },
    });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'work on it'));
    host.agent.status = 'running';
    host.append('turn/start', { turn: 1 });
    const before = shape(emitted);

    expect(await bridge.command({ logicalSessionId: LOGICAL, line: '/goal pause' })).toEqual({
      ok: true,
      output: 'Goal paused',
    });
    expect(shape(emitted)).toEqual(before);
  });

  it('[P7A-CMD-REFUSED] hidden, window-owned, unknown or no command at all: refused, nothing run', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, {
      compact: { description: 'compact' },
      goal: { description: 'goal' },
      plan: { description: 'plan' },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    for (const line of ['/plan', '/compact', '/nope', '/Goal pause', '/usr/bin/env']) {
      expect((await refusal(bridge.command({ logicalSessionId: LOGICAL, line }))).code).toBe(
        WORKER_COMMAND_UNKNOWN
      );
    }
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('[P7A-CMD-TIMEOUT] a command past its budget is cancelled, retryable', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      goal: {
        description: 'goal',
        handler: (_input, signal) =>
          new Promise<DshCommandResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')));
          }),
      },
    });
    const bridge = runtime(host.ctx, [], { commandTimeoutMs: 20 });
    await bridge.bootstrap();

    const refused = await refusal(bridge.command({ logicalSessionId: LOGICAL, line: '/goal' }));
    expect(refused.code).toBe(WORKER_COMMAND_TIMEOUT);
    expect((refused as { retryable?: boolean }).retryable).toBe(true);
  });
});

describe('DshSessionRuntime — worker.panels and goalActivation (P1-7a, decisions 072 rule 1, 113 rule 12, 118)', () => {
  const GOAL = {
    goal: {
      id: 'goal-1',
      revision: 3,
      objective: 'Get CI green',
      phase: 'active',
      maxGoalRounds: 256,
    },
    roundsStarted: 3,
    createdAt: 1,
    updatedAt: 2,
  };

  it('[P7A-PANELS] answers the current values, `goalActivation` always; nothing before a bootstrap, no event', async () => {
    const host = fakeHost();
    fakeProjections(host, { todos: null, goal: null, subagentCatalog: [] });
    host.services.goals = { get: () => undefined };
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);

    expect(await bridge.panels({ logicalSessionId: LOGICAL })).toEqual({ projections: [] });
    await bridge.bootstrap();
    expect(await bridge.panels({ logicalSessionId: LOGICAL })).toEqual({
      projections: [
        { key: 'todos', view: null },
        { key: 'goal', view: null },
        { key: 'subagentCatalog', view: [] },
        { key: 'goalActivation', view: null },
      ],
    });
    expect(emitted).toEqual([]);
  });

  it('[P7A-ACT-BASELINE] the bootstrap snapshot carries the activation only while a goal is current', async () => {
    const host = fakeHost();
    fakeProjections(host, { todos: null, goal: GOAL, subagentCatalog: [] });
    host.services.goals = {
      get: () => ({ id: 'goal-1', revision: 3, activation: 'disarmed' }),
    };
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'hello'));

    const projections = emitted.filter((event) => event.type === 'session.projection');
    expect(projections.map((event) => event.payload?.key)).toEqual([
      'todos',
      'goal',
      'subagentCatalog',
      'goalActivation',
    ]);
    expect(projections[3]?.payload?.view).toEqual({
      goalId: 'goal-1',
      revision: 3,
      activation: 'disarmed',
    });

    // No goal: the three DSH keys alone, as before P1-7a.
    const plain = fakeHost();
    fakeProjections(plain, { todos: null, goal: null, subagentCatalog: [] });
    plain.services.goals = { get: () => undefined };
    const plainEmitted: Emitted[] = [];
    const plainBridge = runtime(plain.ctx, plainEmitted);
    await plainBridge.bootstrap();
    await plainBridge.startSend(send('turn-1', 'hello'));
    expect(
      plainEmitted
        .filter((event) => event.type === 'session.projection')
        .map((event) => event.payload?.key)
    ).toEqual(['todos', 'goal', 'subagentCatalog']);
  });

  it('[P7A-ACT-EDGE] forwards this session’s activation edges, a clear as null, nobody else’s', async () => {
    const host = fakeHost();
    fakeProjections(host, { todos: null, goal: null, subagentCatalog: [] });
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'hello'));
    const before = emitted.length;

    host.fire('goal/activation-changed', {
      sessionId: DSH_ID,
      goal: { id: 'goal-1', revision: 1, activation: 'armed' },
    });
    host.fire('goal/activation-changed', {
      sessionId: 'aiclient-someone-else',
      goal: { id: 'goal-9', revision: 1, activation: 'armed' },
    });
    host.fire('goal/activation-changed', { sessionId: DSH_ID });

    expect(emitted.slice(before)).toEqual([
      {
        sessionId: LOGICAL,
        requestId: 'turn-1',
        type: 'session.projection',
        payload: {
          key: 'goalActivation',
          view: { goalId: 'goal-1', revision: 1, activation: 'armed' },
        },
      },
      {
        sessionId: LOGICAL,
        requestId: 'turn-1',
        type: 'session.projection',
        payload: { key: 'goalActivation', view: null },
      },
    ]);
  });

  it('[P7A-ACT-NO-SERVICE] a host without ctx.goals reports no activation; the rest goes on', async () => {
    const host = fakeHost();
    fakeProjections(host, { todos: null, goal: GOAL, subagentCatalog: [] });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    const answer = await bridge.panels({ logicalSessionId: LOGICAL });
    expect(answer.projections.map((entry) => entry.key)).toEqual([
      'todos',
      'goal',
      'subagentCatalog',
    ]);
  });
});

/**
 * dsh-rebase decision 180: a `/compact` can run for ten minutes, and the user
 * can cut it short. The abort carries its reason, which DSH logs as the
 * command's answer; the answer waits (bounded) for DSH to close the
 * compaction; a summary that landed before the abort reached it is the
 * outcome; what was typed is kept beside the stub whatever the outcome.
 */
describe('DshSessionRuntime — /compact cancelled, or past its limit (decision 180)', () => {
  /**
   * DSH's `/compact` as far as these tests need it: `compaction/start` with no
   * turn, then — on abort — the command rejects at once with the abort's
   * reason (`withAbort`) while the compaction closes a moment later with an
   * error; or, given `land`, the summary lands first.
   */
  function slowCompact(
    host: ReturnType<typeof fakeHost>,
    options: { land?: boolean; close?: boolean } = {}
  ): Handler {
    let runs = 0;
    return (_input, signal, commandId) => {
      runs += 1;
      const compactionId = `slow-${runs}`;
      host.append('compaction/start', { compactionId, sourceCommandId: commandId, turn: null });
      if (options.land) {
        host.append('compaction/summary', { compactionId });
        host.append('user/message', {
          id: `cp-${runs}`,
          role: 'user',
          content: [{ type: 'text', text: '<compacted-summary>landed</compacted-summary>' }],
          source: { kind: 'compact-checkpoint', compactionId },
        });
        host.append('compaction/end', { compactionId, sourceCommandId: commandId, turn: null });
      }
      return new Promise<DshCommandResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason);
          if (options.close === false || options.land) return;
          setTimeout(() => {
            host.append('compaction/end', {
              compactionId,
              sourceCommandId: commandId,
              turn: null,
              error: { message: String((signal.reason as Error).message) },
            });
          }, 5);
        });
      });
    };
  }
  const compactionEvents = (emitted: Emitted[]) =>
    emitted.filter((event) => event.type === 'session.compaction').map((event) => event.payload);

  it('[180-B-01] cancelled: aborted with its reason, answered once DSH let go, nothing compacted', async () => {
    const host = fakeHost();
    const emitted: Emitted[] = [];
    fakeCommands(host, { compact: { description: 'compact', handler: slowCompact(host) } });
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    const compacting = refusal(bridge.compact({ logicalSessionId: LOGICAL }));
    await vi.waitFor(() => expect(compactionEvents(emitted)).toHaveLength(1));
    expect(compactionEvents(emitted)[0]).toMatchObject({
      phase: 'started',
      trigger: 'manual',
      command: '/compact',
    });
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: true });
    // A second press is no second cancel.
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: false });

    const error = (await compacting) as { code?: string; retryable?: boolean; message: string };
    expect(error).toMatchObject({ code: WORKER_COMPACT_CANCELLED, retryable: false });
    expect(error.message).toMatch(/nothing was compacted/);
    // The answer came after DSH closed it, and the row said so first.
    expect(compactionEvents(emitted)[1]).toMatchObject({
      phase: 'failed',
      note: { key: DSH_COMPACT_CANCELLED_KEY },
    });
    // DSH logged the reason as the command's answer.
    expect(
      (await bridge.history({ logicalSessionId: LOGICAL })).page.messages.at(-1)
    ).toMatchObject({
      blocks: [{ notice: { key: DSH_COMPACT_CANCELLED_KEY } }],
    });
    // Nothing is running now: a cancel finds nothing.
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: false });
  });

  it('[180-B-02] the summary landed before the abort reached it: that is the outcome', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      compact: { description: 'compact', handler: slowCompact(host, { land: true }) },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const compacting = bridge.compact({ logicalSessionId: LOGICAL });
    await vi.waitFor(async () =>
      expect((await bridge.history({ logicalSessionId: LOGICAL })).page.messages).toHaveLength(2)
    );
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: true });
    const result = await compacting;
    expect(result.compacted).toBe(true);
    expect(result.summary?.blocks[0]).toMatchObject({ text: 'Context summary\n\nlanded' });
  });

  it('[180-B-03] past its limit: the timeout reason, retryable; ten minutes by default', async () => {
    expect(WORKER_COMPACT_BUDGET_MS).toBe(600_000);
    // Main waits longer than the worker, by more than the worker's settle.
    expect(WORKER_COMPACT_REQUEST_TIMEOUT_MS - WORKER_COMPACT_BUDGET_MS).toBeGreaterThan(
      WORKER_COMPACT_SETTLE_MS
    );
    const host = fakeHost();
    const emitted: Emitted[] = [];
    const commands = fakeCommands(host, {
      compact: { description: 'compact', handler: slowCompact(host) },
    });
    const bridge = runtime(host.ctx, emitted, { compactTimeoutMs: 20 });
    await bridge.bootstrap();

    const error = await refusal(bridge.compact({ logicalSessionId: LOGICAL }));
    expect(error).toMatchObject({ code: 'WORKER_COMPACT_TIMEOUT', retryable: true });
    const signal = commands.execute.mock.calls[0]?.[3] as AbortSignal;
    expect((signal.reason as Error).message).toBe(AICLIENT_COMPACT_TIMEOUT_REASON);
    expect(compactionEvents(emitted)[1]).toMatchObject({ note: { key: DSH_COMPACT_TIMEOUT_KEY } });
    // A cancel after the limit cut it is no cancel.
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: false });
  });

  it('[180-B-04] DSH never closes it: answered at the settle bound, not left waiting', async () => {
    const host = fakeHost();
    fakeCommands(host, {
      compact: { description: 'compact', handler: slowCompact(host, { close: false }) },
    });
    const lines: unknown[][] = [];
    const bridge = runtime(
      host.ctx,
      [],
      { compactSettleMs: 30 },
      { log: (...args) => lines.push(args) }
    );
    await bridge.bootstrap();
    const compacting = refusal(bridge.compact({ logicalSessionId: LOGICAL }));
    await vi.waitFor(() => expect(host.agent).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.cancelCompact({ logicalSessionId: LOGICAL });
    expect(await compacting).toMatchObject({ code: WORKER_COMPACT_CANCELLED });
    expect(lines.some((line) => String(line[0]).includes('did not close within 30ms'))).toBe(true);
  });

  it('[180-B-05] cancelled before DSH started it: nothing logged, still cancelled', async () => {
    const host = fakeHost();
    const { engine } = fakeCompaction(host);
    const commands = fakeCommands(host, {
      compact: { description: 'compact', handler: compactHandler(host, engine) },
    });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    // Instructions: the lease's first check runs before DSH is asked.
    const compacting = refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep the tests' })
    );
    expect(bridge.cancelCompact({ logicalSessionId: LOGICAL })).toEqual({ cancelled: true });
    expect(await compacting).toMatchObject({ code: WORKER_COMPACT_CANCELLED });
    // DSH was never asked.
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('[180-B-06] what was typed is kept for the command line, used or not', async () => {
    const host = fakeHost();
    fakeCompaction(host);
    fakeCommands(host, { compact: { description: 'compact', handler: slowCompact(host) } });
    const bridge = runtime(host.ctx, []);
    const boot = await bridge.bootstrap();

    const compacting = refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: '保留未完成的任务' })
    );
    await vi.waitFor(async () =>
      expect((await bridge.history({ logicalSessionId: LOGICAL })).page.messages).toHaveLength(1)
    );
    bridge.cancelCompact({ logicalSessionId: LOGICAL });
    await compacting;

    const stub = JSON.parse(readFileSync(String(boot.sessionFile), 'utf8'));
    expect(stub.compactInstructions).toEqual([
      {
        compactionId: 'slow-1',
        instructions: '保留未完成的任务',
        at: 1_700_000_000_000,
        unused: true,
      },
    ]);
    const rows = (await bridge.history({ logicalSessionId: LOGICAL })).page.messages;
    expect(rows.map((row) => row.blocks[0]?.id)).toEqual([
      'h:compact-command-slow-1:compact-command:0',
      'h:compaction-slow-1:compaction-failed:0',
    ]);
    expect(rows[0]?.blocks[0]).toMatchObject({ text: '/compact 保留未完成的任务' });
  });
});
