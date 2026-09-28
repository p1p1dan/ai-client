import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiWorkerRuntimeOptions } from '../../../agent-host/piWorkerRpcServer.ts';
import { WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED } from '../../../shared/types/workerRpc.ts';
import type { DshCommandResult, DshSkillSummary } from '../commands.ts';
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
  signal: AbortSignal
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
  return { ctx, agent, followups, append, services };
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
            signal
          );
          host.append('command/done', { commandId, ...result });
          return { commandId, result };
        } catch (error) {
          host.append('command/done', { commandId, kind: 'error', text: String(error) });
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
  options: Partial<PiWorkerRuntimeOptions> = {}
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

  it('[D2-COMPACT-INSTRUCTIONS] refuses instructions with its own code before anything runs', async () => {
    const host = fakeHost();
    const commands = fakeCommands(host, { compact: { description: 'compact' } });
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();

    const error = await refusal(
      bridge.compact({ logicalSessionId: LOGICAL, instructions: 'keep the API decisions' })
    );

    expect(error.code).toBe(WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED);
    expect(commands.execute).not.toHaveBeenCalled();
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
