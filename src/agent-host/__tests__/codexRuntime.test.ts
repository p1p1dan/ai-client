import { describe, expect, it } from 'vitest';
import { CODEX_AGENT } from '../../shared/types/agentWire.ts';
import {
  type CodexConnectFactory,
  type CodexConnectionCore,
  createCodexConnection,
} from '../codexConnection.ts';
import type { CodexEntryResolution, CodexLaunchPlan } from '../codexNodeEntry.ts';
import {
  buildInitializeParams,
  buildThreadStartParams,
  CODEX_CLIENT_NAME,
  CODEX_CLIENT_TITLE,
  CODEX_PERMISSION_DEFAULT,
  CodexRuntime,
  type CodexRuntimeOptions,
  compareSandboxEcho,
} from '../codexRuntime.ts';
import { JSONRPC_METHOD_NOT_FOUND } from '../codexWire.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * S3 slice 2a — the Codex runtime shell.
 *
 * The gate item lives in the first describe: the posture that reaches
 * `thread/start` and the posture `session.created` advertises are compared TO
 * EACH OTHER, never to a literal (paradigm from
 * `claudeRuntimeOptions.test.ts:151-219`). A literal on both sides passes while
 * the two drift apart; comparing the captures cannot.
 *
 * Everything runs against an in-memory transport driving the real
 * `createCodexConnection` core, so no process is spawned and no quota is spent.
 */

const HOME_DIR = '/tmp/aiclient-codex-home';

const PLAN: CodexLaunchPlan = {
  nodeExecPath: '/opt/node24/bin/node',
  codexJsPath: '/opt/codex/lib/node_modules/@openai/codex/bin/codex.js',
  args: ['/opt/codex/lib/node_modules/@openai/codex/bin/codex.js', 'app-server'],
  source: 'node_sibling',
};

/**
 * CONSTRUCTED, not recorded: the only real echo we hold is the read-only one in
 * `fixtures/codex/codex-thread-start-echo.partial.json`. The camel-case spelling
 * here is a plausible shape used to exercise the comparison, and the test that
 * asserts a `match` against REAL bytes uses that fixture's values instead.
 */
const THREAD_START_RESULT = {
  threadId: 'thr-0001',
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', networkAccess: false },
};

interface OutboundFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface Harness {
  runtime: CodexRuntime;
  registry: SessionRegistry;
  events: Array<Record<string, unknown>>;
  logs: string[];
  /** Ordered transport transcript: `write:<method>` / `reply:<id>` / `kill:<reason>`. */
  ops: string[];
  connectInputs: Array<Parameters<CodexConnectFactory>[0]>;
  /** Our outbound requests, parsed. */
  requestFor(method: string): OutboundFrame;
  replies(): OutboundFrame[];
  event(type: string): Record<string, unknown> | undefined;
  eventsOf(type: string): Array<Record<string, unknown>>;
  /** Feed one inbound frame from "codex". */
  push(frame: Record<string, unknown>): void;
  /** Kill the "process" the way a crash would — through the real connection core. */
  exit(info: { code: number | null; signal: string | null }): void;
  waitFor(check: () => boolean, what: string): Promise<void>;
  waitForEvent(type: string): Promise<Record<string, unknown>>;
}

function makeHarness(
  options: {
    threadStartResult?: unknown;
    threadStartError?: { code: number; message: string };
    resolveLaunch?: () => CodexEntryResolution;
    ensureHome?: CodexRuntimeOptions['ensureHome'];
    appVersion?: string;
    codexHomeDir?: string;
  } = {}
): Harness {
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const ops: string[] = [];
  const written: OutboundFrame[] = [];
  const connectInputs: Array<Parameters<CodexConnectFactory>[0]> = [];
  let core: CodexConnectionCore | null = null;

  function answer(frame: OutboundFrame): void {
    if (!core || frame.id === undefined) return;
    if (frame.method === 'initialize') {
      core.pushStdout(`${JSON.stringify({ id: frame.id, result: { codexHome: HOME_DIR } })}\n`);
      return;
    }
    if (frame.method === 'thread/start') {
      const body = options.threadStartError
        ? { id: frame.id, error: options.threadStartError }
        : { id: frame.id, result: options.threadStartResult ?? THREAD_START_RESULT };
      core.pushStdout(`${JSON.stringify(body)}\n`);
    }
  }

  const connect: CodexConnectFactory = (input) => {
    connectInputs.push(input);
    const created = createCodexConnection({
      transport: {
        pid: 4242,
        write: (line) => {
          const frame = JSON.parse(line) as OutboundFrame;
          written.push(frame);
          ops.push(frame.method ? `write:${frame.method}` : `reply:${String(frame.id)}`);
          // A real process never answers inside the write call; a microtask
          // keeps the ordering realistic without a timer.
          if (frame.method !== undefined && frame.id !== undefined)
            queueMicrotask(() => answer(frame));
        },
        kill: (reason) => ops.push(`kill:${reason}`),
      },
      handlers: input.handlers,
      log: (...args) =>
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    });
    core = created;
    return created.connection;
  };

  const registry = new SessionRegistry();
  const runtime = new CodexRuntime({
    emit: (event) => events.push(event),
    log: (...args) =>
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    registry,
    codexHomeDir: options.codexHomeDir ?? HOME_DIR,
    appVersion: options.appVersion ?? '9.9.9-test',
    connect,
    resolveLaunch: options.resolveLaunch ?? (() => ({ ok: true, plan: PLAN })),
    ensureHome:
      options.ensureHome ??
      ((input) => ({
        homeDir: input.homeDir,
        projection: { toml: '', kept: [], dropped: [] },
        authCopied: false,
      })),
  });

  const harness: Harness = {
    runtime,
    registry,
    events,
    logs,
    ops,
    connectInputs,
    requestFor: (method) => {
      const frame = written.find((f) => f.method === method);
      if (!frame) throw new Error(`no outbound request for ${method}; saw ${ops.join(', ')}`);
      return frame;
    },
    replies: () => written.filter((f) => f.method === undefined),
    event: (type) => events.find((e) => e.type === type),
    eventsOf: (type) => events.filter((e) => e.type === type),
    push: (frame) => core?.pushStdout(`${JSON.stringify(frame)}\n`),
    exit: (info) => core?.handleExit(info),
    waitFor: async (check, what) => {
      for (let i = 0; i < 200; i += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    waitForEvent: async (type) => {
      await harness.waitFor(() => events.some((e) => e.type === type), `event ${type}`);
      return events.find((e) => e.type === type) as Record<string, unknown>;
    },
  };
  return harness;
}

type Payload = Record<string, unknown>;

function payload(event: Record<string, unknown> | undefined): Payload {
  return (event?.payload ?? {}) as Payload;
}

async function startedSession(sessionId = 's1'): Promise<Harness> {
  const h = makeHarness();
  h.runtime.createSession({ sessionId, workspacePath: '/work/repo', requestId: 'req-create' });
  await h.waitForEvent('session.created');
  return h;
}

describe('codexRuntime — permission posture has a single source (gate item)', () => {
  it('sends thread/start exactly the posture session.created reports', async () => {
    const h = await startedSession();

    const start = h.requestFor('thread/start');
    const created = payload(h.event('session.created'));
    const advertised = created.permissionPolicy as {
      approvalPolicy: string;
      sandboxMode: string;
      agent: string;
    };

    // Two CAPTURES compared to each other. A literal on both sides would pass
    // while the constant that feeds them changed under one of them.
    expect(start.params?.approvalPolicy).toBe(advertised.approvalPolicy);
    expect(start.params?.sandbox).toBe(advertised.sandboxMode);
    expect(advertised.agent).toBe(created.agent);
  });

  it('never puts networkAccess into the request, anywhere in the params', async () => {
    // `thread/start` takes `sandbox` as a STRING; networkAccess exists only in
    // the RESULT. Sending it is the "we configured something we cannot
    // configure" failure — the serialized check also catches it nested inside
    // an object-shaped sandbox somebody added later.
    const h = await startedSession();
    const start = h.requestFor('thread/start');

    expect(start.params).not.toHaveProperty('networkAccess');
    expect(JSON.stringify(start.params)).not.toContain('networkAccess');
    expect(typeof start.params?.sandbox).toBe('string');
  });

  it('reports the same agent on the event and on the registry entry', async () => {
    const h = await startedSession();
    const created = payload(h.event('session.created'));

    expect(created.agent).toBe(h.registry.get('s1')?.agent);
    expect(h.registry.get('s1')?.agent).toBe(CODEX_AGENT);
  });

  it('pins the posture discriminant to the shared agent constant', () => {
    // The discriminant must be spelled as a literal (its type is `'codex'`, not
    // `AgentWireName`), and the repo-wide literal scan cannot cover `'codex'`
    // because the terminal axis owns that same value. This is the substitute.
    expect(CODEX_PERMISSION_DEFAULT.agent).toBe(CODEX_AGENT);
    expect(CODEX_PERMISSION_DEFAULT.approvalPolicy).toBe('on-request');
    expect(CODEX_PERMISSION_DEFAULT.sandboxMode).toBe('workspace-write');
  });

  it('carries the thread id from thread/start into session.created as runtimeIdentity', async () => {
    const h = await startedSession();
    const created = payload(h.event('session.created'));

    expect(created.runtimeIdentity).toBe(THREAD_START_RESULT.threadId);
    expect(h.registry.get('s1')?.runtimeIdentity).toBe(created.runtimeIdentity);
  });

  it('emits created then an idle status, both correlated to the create request', async () => {
    const h = await startedSession();
    const order = h.events.map((e) => e.type);

    expect(order).toEqual(['session.created', 'session.status']);
    expect(h.event('session.created')?.requestId).toBe('req-create');
    expect(payload(h.event('session.status')).status).toBe('idle');
  });
});

describe('codexRuntime — handshake identity and isolation', () => {
  it('introduces itself with the product name, never a wire slug', async () => {
    // `clientInfo.name` is folded into the User-Agent codex sends to OpenAI
    // [实测], so this is an external identity: publishing `AgentWireName`'s
    // value there would weld an internal protocol constant to a third party.
    const h = await startedSession();
    const init = h.requestFor('initialize');
    const clientInfo = (init.params?.clientInfo ?? {}) as Record<string, string>;

    expect(clientInfo.name).toBe(CODEX_CLIENT_NAME);
    expect(clientInfo.name).not.toBe(CODEX_AGENT);
    expect(clientInfo.version).toBe('9.9.9-test');
  });

  it('keeps workspace information out of the client title', async () => {
    // No local evidence says `title` stays on this machine (C-g), so it is
    // treated as if it leaves: a fixed product name and nothing derived from
    // what the user is working on.
    const h = await startedSession();
    const clientInfo = (h.requestFor('initialize').params?.clientInfo ?? {}) as Record<
      string,
      string
    >;

    expect(clientInfo.title).toBe(CODEX_CLIENT_TITLE);
    expect(clientInfo.title).not.toContain('/work');
    expect(JSON.stringify(h.requestFor('initialize').params)).not.toContain('/work/repo');
  });

  it('substitutes a placeholder version rather than sending an empty one', () => {
    expect(buildInitializeParams('').clientInfo.version).toBe('0.0.0-unknown');
    expect(buildInitializeParams(' 1.2.3 ').clientInfo.version).toBe('1.2.3');
  });

  it('spawns with CODEX_HOME pointing at the isolated directory', async () => {
    // The projection in `codexHome.ts` is only half the isolation; without this
    // env var codex reads `~/.codex` and every dropped key comes back.
    const h = await startedSession();
    const input = h.connectInputs[0];

    expect(input.env.CODEX_HOME).toBe(HOME_DIR);
    expect(input.cwd).toBe('/work/repo');
    expect(input.plan.codexJsPath.endsWith('codex.js')).toBe(true);
  });

  it('sends the initialized notification after the initialize response', async () => {
    const h = await startedSession();

    expect(h.ops.slice(0, 3)).toEqual([
      'write:initialize',
      'write:initialized',
      'write:thread/start',
    ]);
  });

  it('warns, without failing, when codex reports a home other than the one injected', async () => {
    // "codex read ~/.codex after all" is the single most useful line in a report
    // about a session that inherited `developer_instructions` — and it is only
    // a WARN, because by then the session is already usable.
    const quiet = await startedSession();
    expect(quiet.logs.some((line) => line.includes('different CODEX_HOME'))).toBe(false);

    // Same fake codex (it answers with HOME_DIR), different injected home.
    const loud = makeHarness({ codexHomeDir: '/some/other/home' });
    loud.runtime.createSession({ sessionId: 's-home', workspacePath: '/work/repo' });
    await loud.waitForEvent('session.created');

    expect(loud.logs.some((line) => line.includes('different CODEX_HOME'))).toBe(true);
    expect(loud.event('host.error')).toBeUndefined();
  });

  it('omits model from thread/start when the session has none, and sends it when it does', () => {
    expect(buildThreadStartParams({ cwd: '/w' })).not.toHaveProperty('model');
    expect(buildThreadStartParams({ cwd: '/w', model: 'gpt-5.4' }).model).toBe('gpt-5.4');
    expect(buildThreadStartParams({ cwd: '/w', model: '  ' })).not.toHaveProperty('model');
  });
});

describe('codexRuntime — create failures leave nothing behind', () => {
  it('refuses with agent_unsupported when no codex.js can be resolved', async () => {
    const h = makeHarness({
      resolveLaunch: () => ({
        ok: false,
        code: 'codex_entry_unresolved',
        message: 'Codex entry not found: none of the 3 inspected path(s) is an @openai/codex bin.',
        inspected: [{ path: '/home/someone/.nvm/bin/codex', reason: 'not-a-js-entry' }],
      }),
    });
    h.runtime.createSession({ sessionId: 's-bad', workspacePath: '/work', requestId: 'req-9' });

    const error = h.event('host.error');
    expect(payload(error).code).toBe('agent_unsupported');
    expect(payload(error).fatal).toBe(false);
    // Correlated BOTH ways, exactly like index.ts's refusal: requestId fails the
    // pending command, sessionId scopes the message to this Composer.
    expect(error?.requestId).toBe('req-9');
    expect(error?.sessionId).toBe('s-bad');
    // Nothing was created and no process was started.
    expect(h.registry.get('s-bad')).toBeUndefined();
    expect(h.connectInputs).toHaveLength(0);
  });

  it('keeps the user machine layout out of the event and in the log', async () => {
    // The inspected paths are the most useful line in a support log and the
    // worst thing to push into a UI toast.
    const h = makeHarness({
      resolveLaunch: () => ({
        ok: false,
        code: 'codex_entry_unresolved',
        message: 'Codex entry not found.',
        inspected: [{ path: '/home/someone/secret-project/codex.js', reason: 'not-found' }],
      }),
    });
    h.runtime.createSession({ sessionId: 's-bad2', workspacePath: '/work' });

    expect(JSON.stringify(h.events)).not.toContain('secret-project');
    expect(h.logs.some((line) => line.includes('secret-project'))).toBe(true);
  });

  it('reports a failed handshake, tears the process down and unregisters the session', async () => {
    const h = makeHarness({
      threadStartError: { code: -32602, message: 'invalid params' },
    });
    h.runtime.createSession({ sessionId: 's-fail', workspacePath: '/work', requestId: 'req-f' });
    await h.waitFor(() => h.events.some((e) => e.type === 'host.error'), 'host.error');

    const error = h.event('host.error');
    expect(payload(error).code).toBe('session_create_failed');
    expect(error?.sessionId).toBe('s-fail');
    expect(error?.requestId).toBe('req-f');
    // No half-open session: no created event, no registry row, process killed.
    expect(h.event('session.created')).toBeUndefined();
    expect(h.registry.get('s-fail')).toBeUndefined();
    expect(h.ops.some((op) => op.startsWith('kill:'))).toBe(true);
  });

  it('fails the create when thread/start answers without a thread id', async () => {
    // Without it no turn can ever be addressed, so a "successful" create would
    // hand back a session that is dead on arrival.
    const h = makeHarness({ threadStartResult: { approvalPolicy: 'on-request' } });
    h.runtime.createSession({ sessionId: 's-noid', workspacePath: '/work' });
    await h.waitFor(() => h.events.some((e) => e.type === 'host.error'), 'host.error');

    expect(payload(h.event('host.error')).message).toContain('thread id');
    expect(h.event('session.created')).toBeUndefined();
  });

  it('refuses a duplicate sessionId without touching the existing session', async () => {
    const h = await startedSession();
    h.events.length = 0;
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/work/repo' });

    expect(payload(h.event('host.error')).code).toBe('session_create_failed');
    expect(h.connectInputs).toHaveLength(1);
  });

  it('reports a CODEX_HOME that cannot be prepared instead of running unisolated', async () => {
    // Falsifies "seed failed, carry on": a session that starts without the
    // projection inherits developer_instructions and danger-full-access.
    const h = makeHarness({
      ensureHome: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    h.runtime.createSession({ sessionId: 's-home-fail', workspacePath: '/work' });

    expect(payload(h.event('host.error')).code).toBe('session_create_failed');
    expect(payload(h.event('host.error')).message).toContain('CODEX_HOME');
    expect(h.connectInputs).toHaveLength(0);
  });
});

describe('codexRuntime — thread/status/changed is the only status source', () => {
  it('maps an active frame with no flags to running', async () => {
    const h = await startedSession();
    h.events.length = 0;
    h.push({
      method: 'thread/status/changed',
      params: {
        threadId: THREAD_START_RESULT.threadId,
        status: { type: 'active', activeFlags: [] },
      },
    });

    expect(payload(h.event('session.status')).status).toBe('running');
    expect(h.registry.get('s1')?.status).toBe('running');
  });

  it('prefers waiting_permission when both flags are set', async () => {
    // Constructed case — no real frame carries both flags (arbitration doc
    // §4.5). An approval blocks execution and carries destructive consequences,
    // so it is the state worth showing.
    const h = await startedSession();
    h.events.length = 0;
    h.push({
      method: 'thread/status/changed',
      params: {
        status: { type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] },
      },
    });

    expect(payload(h.event('session.status')).status).toBe('waiting_permission');
  });

  it('handles the idle frame, which has NO activeFlags key at all', async () => {
    // A mapper that reads `status.activeFlags.includes(...)` first throws a
    // TypeError at the exact moment a turn ends.
    const h = await startedSession();
    h.events.length = 0;
    expect(() =>
      h.push({ method: 'thread/status/changed', params: { status: { type: 'idle' } } })
    ).not.toThrow();

    expect(payload(h.event('session.status')).status).toBe('idle');
  });

  it('says nothing on a malformed status instead of guessing', async () => {
    const h = await startedSession();
    h.events.length = 0;
    h.push({ method: 'thread/status/changed', params: { status: { type: 'quantum' } } });

    // No opinion keeps the previous state; guessing `running` would overwrite a
    // live waiting state and strand a card.
    expect(h.eventsOf('session.status')).toHaveLength(0);
  });

  it('warns about unknown flags but still emits the reading', async () => {
    const h = await startedSession();
    h.events.length = 0;
    h.push({
      method: 'thread/status/changed',
      params: {
        status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnTeaBreak'] },
      },
    });

    expect(payload(h.event('session.status')).status).toBe('waiting_permission');
    expect(h.logs.some((line) => line.includes('unknown flags'))).toBe(true);
  });

  it('drops a status that belongs to another thread', async () => {
    // One session ≡ one thread (C12, fork banned). Projecting a foreign
    // thread's state onto this session would mislabel it.
    const h = await startedSession();
    h.events.length = 0;
    h.push({
      method: 'thread/status/changed',
      params: { threadId: 'someone-elses-thread', status: { type: 'active', activeFlags: [] } },
    });

    expect(h.eventsOf('session.status')).toHaveLength(0);
    expect(h.logs.some((line) => line.includes('foreign thread'))).toBe(true);
  });
});

describe('codexRuntime — server requests and the pending table', () => {
  const approval = (id: number) => ({
    id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD_START_RESULT.threadId, command: 'rm -rf /' },
  });

  it('answers an unknown server method with method-not-found instead of registering it', async () => {
    const h = await startedSession();
    h.push({ id: 5, method: 'item/telepathy/request', params: {} });

    const reply = h.replies().at(-1) as { id?: number; error?: { code: number } } | undefined;
    expect(reply?.id).toBe(5);
    expect(reply?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });

  it('drains a registered request on close — one reply, with a refusal body, then the kill', async () => {
    // The two halves of the invariant: the table ends empty AND every entry got
    // exactly one frame. Clearing without replying passes a naive `size === 0`
    // check while codex waits on `waitingOnApproval` forever.
    const h = await startedSession();
    h.push(approval(0));
    h.runtime.close({ sessionId: 's1', requestId: 'req-close' });

    const replies = h.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: 0, result: { decision: 'cancel' } });
    // ORDER: the refusal frame is written BEFORE the process is killed. Reverse
    // them and the write lands on a dead stdin — silently dropped.
    expect(h.ops.indexOf('reply:0')).toBeLessThan(h.ops.indexOf('kill:session closed'));
    expect(payload(h.eventsOf('session.status').at(-1)).status).toBe('disconnected');
    expect(h.registry.get('s1')).toBeUndefined();
  });

  it('drains on stop with the aborted reason and keeps the connection alive', async () => {
    const h = await startedSession();
    h.push(approval(0));
    h.events.length = 0;
    h.runtime.stop({ sessionId: 's1', requestId: 'req-stop' });

    expect(h.replies()).toHaveLength(1);
    expect(h.ops.some((op) => op.startsWith('kill:'))).toBe(false);
    // Stop is not close: the session survives it.
    expect(h.registry.get('s1')).toBeDefined();
    expect(h.event('session.status')?.requestId).toBe('req-stop');
  });

  it('answers a second, unrelated request too — the drain is not first-only', async () => {
    const h = await startedSession();
    h.push(approval(0));
    h.push({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [] } });
    h.runtime.close({ sessionId: 's1' });

    const replies = h.replies();
    expect(replies.map((r) => r.id)).toEqual([0, 1]);
    // Per-kind fail-safe bodies: a cancelled approval and an empty answer map,
    // neither of which can be read as consent.
    expect(replies[0].result).toEqual({ decision: 'cancel' });
    expect(replies[1].result).toEqual({ answers: {} });
  });

  it('drains everything when the process dies on its own, and reports the session failed', async () => {
    const h = await startedSession();
    h.push(approval(0));
    h.events.length = 0;
    // A crash, through the real connection core — not a close we initiated.
    h.exit({ code: 1, signal: null });

    // The entry IS settled (the card resolves), but the frame cannot be
    // delivered: the process is already gone. That asymmetry is exactly why the
    // close path above must drain BEFORE it disposes — there, the frame lands.
    expect(h.logs.some((line) => line.includes('codex pending drained'))).toBe(true);
    expect(h.logs.some((line) => line.includes('"reason":"aborted"'))).toBe(true);
    expect(h.replies()).toHaveLength(0);
    expect(payload(h.event('session.failed')).error).toContain('exited');
    expect(h.registry.get('s1')?.status).toBe('disconnected');
  });

  it('drains and disposes every session on host shutdown', async () => {
    const h = await startedSession();
    h.push(approval(0));
    h.runtime.dispose();

    expect(h.replies()).toHaveLength(1);
    expect(h.ops.some((op) => op === 'kill:host shutting down')).toBe(true);
    // Idempotent: a close arriving after shutdown must not drain twice.
    h.runtime.close({ sessionId: 's1' });
    expect(h.replies()).toHaveLength(1);
  });

  it('closes a session that has no live connection without throwing', async () => {
    const h = await startedSession();
    h.exit({ code: 1, signal: null });
    h.events.length = 0;
    h.runtime.close({ sessionId: 's1' });

    expect(payload(h.event('session.status')).status).toBe('disconnected');
    expect(h.registry.get('s1')).toBeUndefined();
  });
});

describe('codexRuntime — the deliberate holes are explicit refusals', () => {
  it('refuses send with not_implemented rather than pretending a turn ran', async () => {
    const h = await startedSession();
    h.events.length = 0;
    await h.runtime.send({ sessionId: 's1', requestId: 'req-send' });

    const error = h.event('host.error');
    expect(payload(error).code).toBe('not_implemented');
    expect(payload(error).fatal).toBe(false);
    expect(error?.sessionId).toBe('s1');
    expect(error?.requestId).toBe('req-send');
    expect(String(payload(error).message)).toContain('normalizer');
  });

  it('refuses resume with agent_unsupported and explains why', async () => {
    // A Codex resume that emitted only `session.resumed` would leave the
    // renderer on a blank transcript with no error at all — history replay is
    // slice 5a.
    const h = makeHarness();
    h.runtime.resumeSession({ sessionId: 's-resume', requestId: 'req-resume' });

    const error = h.event('host.error');
    expect(payload(error).code).toBe('agent_unsupported');
    expect(payload(error).fatal).toBe(false);
    expect(error?.sessionId).toBe('s-resume');
    expect(String(payload(error).message)).toContain('later slice');
    // Nothing registered, nothing spawned.
    expect(h.registry.get('s-resume')).toBeUndefined();
    expect(h.connectInputs).toHaveLength(0);
  });

  it('refuses both respond commands, correlated to the session', async () => {
    const h = await startedSession();
    h.events.length = 0;
    h.runtime.respondPermission({ sessionId: 's1', requestId: 'req-p' });
    h.runtime.respondQuestion({ sessionId: 's1', requestId: 'req-q' });

    expect(h.eventsOf('host.error').map((e) => payload(e).code)).toEqual([
      'not_implemented',
      'not_implemented',
    ]);
  });

  it('reports an unknown session on stop the way the Claude runtime does', async () => {
    const h = makeHarness();
    h.runtime.stop({ sessionId: 'nope', requestId: 'req-stop' });

    expect(payload(h.event('host.error')).code).toBe('session_not_found');
  });
});

describe('compareSandboxEcho', () => {
  const sent = CODEX_PERMISSION_DEFAULT;

  it('matches the recorded read-only echo against a read-only policy', () => {
    // The one echo we actually hold [实测
    // fixtures/codex/codex-thread-start-echo.partial.json]: request-side
    // `read-only` versus result-side `readOnly`.
    const recorded = {
      approvalPolicy: 'untrusted',
      sandbox: { type: 'readOnly', networkAccess: false },
      activePermissionProfile: null,
    };
    const result = compareSandboxEcho(
      {
        agent: 'codex',
        approvalPolicy: 'untrusted',
        sandboxMode: 'read-only',
        networkAccess: false,
      },
      recorded
    );

    expect(result.verdict).toBe('match');
    expect(result.detail).toContain('approvalPolicy');
  });

  it('reports a mismatch when the server applied a different sandbox tier', () => {
    const result = compareSandboxEcho(sent, {
      approvalPolicy: 'on-request',
      sandbox: { type: 'dangerFullAccess', networkAccess: true },
    });

    expect(result.verdict).toBe('mismatch');
    expect(result.detail).toContain('sandbox');
  });

  it('names networkAccess as a server default, not a dropped request field', () => {
    // Anyone reading the WARN would otherwise hunt for a bug on the request
    // side, where the field does not exist at all.
    const result = compareSandboxEcho(sent, {
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspace-write', networkAccess: true },
    });

    expect(result.verdict).toBe('mismatch');
    expect(result.detail).toContain('never sent by us');
  });

  it('returns unverifiable — never match — when nothing comparable came back', () => {
    // The one reading this function must never produce: "we could not check"
    // presented as "we checked and agreed".
    for (const echo of [undefined, null, 42, 'ok', {}, { thread: { id: 'x' } }]) {
      expect(compareSandboxEcho(sent, echo).verdict).toBe('unverifiable');
    }
  });

  it('looks inside a thread wrapper, since the recorded fragment lost its parent', () => {
    const result = compareSandboxEcho(sent, {
      thread: { id: 't', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    });

    expect(result.verdict).toBe('match');
  });

  it('still counts partial verification as a match but says what was not echoed', () => {
    const result = compareSandboxEcho(sent, { approvalPolicy: 'on-request' });

    expect(result.verdict).toBe('match');
    expect(result.detail).toContain('not echoed: sandbox, networkAccess');
  });
});
