import { describe, expect, it } from 'vitest';
import type { SessionLivenessNote } from '../../shared/types/runtimeEvents.ts';
import {
  type CodexConnectFactory,
  type CodexConnectionCore,
  createCodexConnection,
} from '../codexConnection.ts';
import type { CodexLaunchPlan } from '../codexNodeEntry.ts';
import {
  CODEX_IGNORED_NOTIFICATIONS,
  CODEX_NORMALIZER_METHODS,
  CODEX_PRODUCTIVE_METHODS,
} from '../codexNormalizer.ts';
import {
  CODEX_STALL_TIMEOUT_ENV,
  CODEX_STALL_TIMEOUT_MS,
  CODEX_TTFT_TIMEOUT_ENV,
  CODEX_TTFT_TIMEOUT_MS,
  CODEX_TURN_START_TIMEOUT_MS,
  CodexRuntime,
  type CodexRuntimeOptions,
  decideCodexWatchdogAction,
  resolveCodexStallTimeoutMs,
  resolveCodexTtftTimeoutMs,
} from '../codexRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * F2 S4 — the Codex axis watchdogs (spec
 * `docs/plans/2026-08-18-f2-watchdog-redesign-spec.md` §7).
 *
 * Two halves, deliberately kept apart:
 *
 *  - the VOCABULARY and the EXPIRY DECISION are pure ([X-1]~[X-4]), so the
 *    three-layer table of §7.3 and the turnId fork of §7.4 can be pinned
 *    without a session, a process or a clock;
 *  - the WIRING ([X-5]/[X-6]) runs the real `createCodexConnection` core over
 *    an in-memory transport, the same paradigm `codexRuntime.test.ts` uses, so
 *    "which timer got armed, and what did the frame that arrived do to it" is
 *    observed rather than asserted about a mock.
 *
 * No process is spawned, no quota is spent, and real time never advances: every
 * deadline is the injected `startTimeout` seam, fired by hand.
 */

const HOME_DIR = '/tmp/aiclient-codex-home';

const PLAN: CodexLaunchPlan = {
  nodeExecPath: '/opt/node24/bin/node',
  codexJsPath: '/opt/codex/lib/node_modules/@openai/codex/bin/codex.js',
  args: ['/opt/codex/lib/node_modules/@openai/codex/bin/codex.js', 'app-server'],
  source: 'node_sibling',
};

const THREAD = 'thr-watchdog-0001';
const TURN = 'turn-watchdog-0001';
const PROMPT = 'watch this turn';

/**
 * The five methods that are NOT productive, written out rather than derived.
 *
 * This literal is the whole point of [X-3]: deriving it (union minus productive)
 * would make the assertion a tautology, and a codex upgrade that adds a
 * notification would slip into whichever side the derivation happened to put it
 * on. Written down, a new method lands in NEITHER list and the partition check
 * goes red — which is the only way "an upstream addition was silently misjudged"
 * becomes visible.
 */
const EXPECTED_TRANSPORT_METHODS = [
  'account/rateLimits/updated',
  'thread/status/changed',
  'serverRequest/resolved',
  'thread/settings/updated',
  'thread/started',
];

interface OutboundFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface FakeTimer {
  ms: number;
  /** Run the callback, unless the runtime has already stopped this timer. */
  fire(): void;
  unrefs: number;
  stops: number;
}

function collectTimers(into: FakeTimer[]) {
  return (fire: () => void, ms: number) => {
    const entry: FakeTimer = {
      ms,
      fire: () => {
        if (entry.stops === 0) fire();
      },
      unrefs: 0,
      stops: 0,
    };
    into.push(entry);
    return {
      unref: () => {
        entry.unrefs += 1;
      },
      stop: () => {
        entry.stops += 1;
      },
    };
  };
}

interface HarnessOptions {
  /** `false` = codex never answers `turn/start`, so the ack promise stays open. */
  answerTurnStart?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface Harness {
  runtime: CodexRuntime;
  registry: SessionRegistry;
  events: Array<Record<string, unknown>>;
  logs: string[];
  ops: string[];
  written: OutboundFrame[];
  deadlines: FakeTimer[];
  push(frame: Record<string, unknown>): void;
  eventsOf(type: string): Array<Record<string, unknown>>;
  waitFor(check: () => boolean, what: string): Promise<void>;
  waitForEvent(type: string): Promise<Record<string, unknown>>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const ops: string[] = [];
  const written: OutboundFrame[] = [];
  const deadlines: FakeTimer[] = [];
  const intervals: FakeTimer[] = [];
  const pushes: Array<(frame: Record<string, unknown>) => void> = [];

  function answer(frame: OutboundFrame, core: CodexConnectionCore): void {
    if (frame.id === undefined) return;
    if (frame.method === 'initialize') {
      core.pushStdout(`${JSON.stringify({ id: frame.id, result: { codexHome: HOME_DIR } })}\n`);
      return;
    }
    if (frame.method === 'thread/start') {
      core.pushStdout(
        `${JSON.stringify({
          id: frame.id,
          result: {
            threadId: THREAD,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite', networkAccess: false },
          },
        })}\n`
      );
      return;
    }
    if (frame.method === 'turn/start') {
      // Silence is a real posture: whether codex answers `turn/start` at turn
      // START or at turn END is [未测], which is exactly the ambiguity §7.4's
      // turnId fork exists for.
      if (options.answerTurnStart === false) return;
      core.pushStdout(
        `${JSON.stringify({
          id: frame.id,
          result: { turn: { id: TURN, items: [], status: 'inProgress' } },
        })}\n`
      );
      return;
    }
    if (frame.method === 'turn/interrupt') {
      core.pushStdout(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
    }
  }

  const connect: CodexConnectFactory = (input) => {
    let self: CodexConnectionCore | null = null;
    const created = createCodexConnection({
      transport: {
        pid: 4242,
        write: (line) => {
          const frame = JSON.parse(line) as OutboundFrame;
          written.push(frame);
          ops.push(frame.method ? `write:${frame.method}` : `reply:${String(frame.id)}`);
          if (frame.method !== undefined && frame.id !== undefined) {
            queueMicrotask(() => {
              if (self) answer(frame, self);
            });
          }
        },
        kill: (reason) => {
          ops.push(`kill:${reason}`);
        },
      },
      handlers: input.handlers,
      log: (...args) =>
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    });
    self = created;
    pushes.push((frame) => created.pushStdout(`${JSON.stringify(frame)}\n`));
    return created.connection;
  };

  const registry = new SessionRegistry();
  const runtime = new CodexRuntime({
    emit: (event) => events.push(event as Record<string, unknown>),
    log: (...args) =>
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    registry,
    codexHomeDir: HOME_DIR,
    appVersion: '9.9.9-test',
    now: () => 1_700_000_000_000,
    env: options.env ?? {},
    startInterval: collectTimers(intervals),
    startTimeout: collectTimers(deadlines),
    connect,
    resolveLaunch: () => ({ ok: true, plan: PLAN }),
    ensureHome: (seen: Parameters<NonNullable<CodexRuntimeOptions['ensureHome']>>[0]) => ({
      mode: 'projected' as const,
      homeDir: seen.homeDir,
      projection: { toml: '', kept: [], dropped: [] },
      authCopied: false,
    }),
  });

  const harness: Harness = {
    runtime,
    registry,
    events,
    logs,
    ops,
    written,
    deadlines,
    push: (frame) => pushes[pushes.length - 1]?.(frame),
    eventsOf: (type) => events.filter((e) => e.type === type),
    waitFor: async (check, what) => {
      for (let i = 0; i < 200; i += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`timed out waiting for ${what}; ops=${ops.join(', ')}`);
    },
    waitForEvent: async (type) => {
      await harness.waitFor(() => events.some((e) => e.type === type), `event ${type}`);
      return events.find((e) => e.type === type) as Record<string, unknown>;
    },
  };
  return harness;
}

/**
 * A session with one turn in flight, and both watchdogs armed.
 *
 * `send()` is only awaited when the fake codex answers the ack: with the ack
 * outstanding that promise does not settle until the turn ends, which is the
 * very posture [X-6] is about. The watchdogs are armed BEFORE the request is
 * written either way, so waiting for the `turn/start` frame is enough to know
 * they exist.
 */
async function turnInFlight(options: HarnessOptions = {}): Promise<Harness> {
  const h = makeHarness(options);
  h.runtime.createSession({
    sessionId: 's1',
    workspacePath: '/work/repo',
    requestId: 'req-create',
  });
  await h.waitForEvent('session.created');
  const sent = h.runtime.send({ sessionId: 's1', text: PROMPT, requestId: 'req-send' });
  if (options.answerTurnStart === false) {
    await h.waitFor(
      () => h.written.some((frame) => frame.method === 'turn/start'),
      'the turn/start frame to be written'
    );
    return h;
  }
  await sent;
  return h;
}

const TERMINALS = new Set(['session.completed', 'session.failed', 'session.stopped']);

function terminalsOf(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => String(e.type)).filter((type) => TERMINALS.has(type));
}

function deadlinesOfBudget(h: Harness, ms: number): FakeTimer[] {
  return h.deadlines.filter((timer) => timer.ms === ms);
}

function latestDeadline(h: Harness, ms: number): FakeTimer {
  const found = deadlinesOfBudget(h, ms);
  if (found.length === 0) throw new Error(`no deadline was armed for ${ms}ms`);
  return found[found.length - 1];
}

function livenessNotes(h: Harness): SessionLivenessNote[] {
  return h
    .eventsOf('session.status')
    .map((event) => (event.payload as { liveness?: SessionLivenessNote }).liveness)
    .filter((note): note is SessionLivenessNote => note !== undefined);
}

function productiveFrame(): Record<string, unknown> {
  return {
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD, turnId: TURN, itemId: 'msg-1', delta: 'hello' },
  };
}

describe('Codex productive vocabulary (§7.3, §2.3)', () => {
  it('[X-1] counts the three deliberately-unrendered plan/diff notifications as productive', () => {
    // A_track's positive judgement: CODEX_IGNORED_NOTIFICATIONS is a RENDERING
    // decision table, not a liveness table. These three are real model output we
    // simply do not draw, and reading the ignore list as "not alive" would kill a
    // turn that is busy writing a plan.
    expect(CODEX_PRODUCTIVE_METHODS.has('turn/plan/updated')).toBe(true);
    expect(CODEX_PRODUCTIVE_METHODS.has('item/plan/delta')).toBe(true);
    expect(CODEX_PRODUCTIVE_METHODS.has('turn/diff/updated')).toBe(true);
  });

  it('[X-2] keeps rate-limit chatter and status frames OUT of the productive set', () => {
    // `account/rateLimits/updated` is the Codex analogue of Claude's `api_retry`:
    // the link talking about itself. Admitting it would let a wedged turn re-arm
    // its own watchdog forever — the C-14 shape, on the other axis.
    expect(CODEX_PRODUCTIVE_METHODS.has('account/rateLimits/updated')).toBe(false);
    expect(CODEX_PRODUCTIVE_METHODS.has('thread/status/changed')).toBe(false);
  });

  it('[X-3] partitions every known notification into productive or transport', () => {
    const known = new Set<string>([
      ...Object.values(CODEX_NORMALIZER_METHODS),
      ...Object.keys(CODEX_IGNORED_NOTIFICATIONS),
    ]);
    // Half one: nothing in the productive set is a spelling nobody has ever
    // received. A guessed method name is not a compile error and not a runtime
    // error — it is silence.
    const invented = [...CODEX_PRODUCTIVE_METHODS].filter((method) => !known.has(method));
    expect(invented).toEqual([]);
    // Half two: the complement is EXACTLY the five transport methods. A codex
    // upgrade that adds a notification lands in neither list and fails here.
    const complement = [...known].filter((method) => !CODEX_PRODUCTIVE_METHODS.has(method)).sort();
    expect(complement).toEqual([...EXPECTED_TRANSPORT_METHODS].sort());
    expect(CODEX_PRODUCTIVE_METHODS.size).toBe(known.size - EXPECTED_TRANSPORT_METHODS.length);
  });
});

describe('Codex watchdog expiry decision (§7.3 interactive layer, §7.4 fork)', () => {
  const base = {
    budgetMs: CODEX_STALL_TIMEOUT_MS,
    pendingServerRequests: 0,
    status: 'running' as const,
    openTools: false,
    turnId: TURN as string | null,
  };

  it('[X-4] aborts WITHOUT an interrupt while the turn id is unknown', () => {
    // §7.4 + 拍板 D4: both ids are required by the schema, so a one-id interrupt
    // is an interrupt that never interrupts while the log claims we sent one.
    // The turn is retired locally and the residue (codex may still be running it)
    // is an accepted, registered limit.
    const action = decideCodexWatchdogAction({ ...base, source: 'stall', turnId: null });
    expect(action).toEqual({ kind: 'abort', interrupt: false });
  });

  it('[X-4] aborts WITH an interrupt once the turn has named itself', () => {
    const action = decideCodexWatchdogAction({ ...base, source: 'stall' });
    expect(action).toEqual({ kind: 'abort', interrupt: true });
  });

  it('[X-4] pauses on a parked server request instead of aborting', () => {
    const parked = decideCodexWatchdogAction({
      ...base,
      source: 'stall',
      pendingServerRequests: 1,
    });
    expect(parked).toEqual({
      kind: 'pause',
      note: {
        source: 'stall',
        budgetMs: CODEX_STALL_TIMEOUT_MS,
        reason: 'awaiting_user',
        degraded: false,
      },
    });
    // The status flags are the SECOND route into the same branch: codex reports
    // waitingOnApproval / waitingOnUserInput even when the request itself was
    // settled by a bridge that keeps no row in our table.
    for (const status of ['waiting_permission', 'waiting_question'] as const) {
      const byStatus = decideCodexWatchdogAction({ ...base, source: 'stall', status });
      expect(byStatus.kind).toBe('pause');
    }
  });

  it('[X-4] pauses on a running local tool, and names THAT branch', () => {
    const action = decideCodexWatchdogAction({ ...base, source: 'stall', openTools: true });
    expect(action).toEqual({
      kind: 'pause',
      note: {
        source: 'stall',
        budgetMs: CODEX_STALL_TIMEOUT_MS,
        reason: 'tool_running',
        degraded: false,
      },
    });
  });

  it('[X-4] degrades rather than aborts when the TTFT budget expires bare', () => {
    // §7.2: on this axis a bare TTFT expiry is a DIAGNOSTIC, never a verdict —
    // 32s vs 45s only moves when the first frame is emitted. The stall dog is
    // the only aborter.
    const action = decideCodexWatchdogAction({
      ...base,
      source: 'ttft',
      budgetMs: CODEX_TTFT_TIMEOUT_MS,
      turnId: null,
    });
    expect(action).toEqual({
      kind: 'degrade',
      note: {
        source: 'ttft',
        budgetMs: CODEX_TTFT_TIMEOUT_MS,
        reason: 'insufficient_evidence',
        degraded: true,
      },
    });
  });
});

describe('Codex watchdog budgets (§7.2)', () => {
  it('[X-7] defaults to the Claude axis values and disables on <= 0', () => {
    expect(CODEX_TTFT_TIMEOUT_MS).toBe(32_000);
    expect(CODEX_STALL_TIMEOUT_MS).toBe(195_000);
    expect(CODEX_TTFT_TIMEOUT_MS).toBeLessThan(CODEX_STALL_TIMEOUT_MS);
    expect(resolveCodexTtftTimeoutMs({})).toBe(CODEX_TTFT_TIMEOUT_MS);
    expect(resolveCodexStallTimeoutMs({})).toBe(CODEX_STALL_TIMEOUT_MS);
    // Empty is "not configured", not "0" — `Number('')` is 0, which would
    // silently turn a safety net off.
    expect(resolveCodexStallTimeoutMs({ [CODEX_STALL_TIMEOUT_ENV]: '' })).toBe(
      CODEX_STALL_TIMEOUT_MS
    );
    expect(resolveCodexTtftTimeoutMs({ [CODEX_TTFT_TIMEOUT_ENV]: 'abc' })).toBe(
      CODEX_TTFT_TIMEOUT_MS
    );
    expect(resolveCodexStallTimeoutMs({ [CODEX_STALL_TIMEOUT_ENV]: '0' })).toBe(0);
    expect(resolveCodexTtftTimeoutMs({ [CODEX_TTFT_TIMEOUT_ENV]: '-5' })).toBeLessThanOrEqual(0);
    expect(resolveCodexStallTimeoutMs({ [CODEX_STALL_TIMEOUT_ENV]: '40' })).toBe(40);
  });

  it('[X-7] arms nothing at all when both budgets are disabled (today behaviour)', async () => {
    const h = await turnInFlight({
      env: { [CODEX_STALL_TIMEOUT_ENV]: '0', [CODEX_TTFT_TIMEOUT_ENV]: '0' },
    });
    expect(h.deadlines).toEqual([]);
    expect(terminalsOf(h.events)).toEqual([]);
  });
});

describe('Codex turn-activity vs connection-activity (§7.3 B_track negative control)', () => {
  it('[X-5] still stalls when only transport frames arrive', async () => {
    const h = await turnInFlight({ env: { [CODEX_STALL_TIMEOUT_ENV]: '40' } });
    expect(deadlinesOfBudget(h, 40)).toHaveLength(1);

    // Frames the CONNECTION counts as activity (its hook counts both directions
    // and its own header says it cannot tell them apart) but the TURN must not.
    h.push({
      method: 'account/rateLimits/updated',
      params: { threadId: THREAD, rateLimits: { primary: null, secondary: null } },
    });
    h.push({
      method: 'thread/status/changed',
      params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } },
    });
    await h.waitFor(() => h.eventsOf('session.status').length > 0, 'a status projection');

    // The load-bearing count: transport traffic re-armed NOTHING.
    expect(deadlinesOfBudget(h, 40)).toHaveLength(1);
    latestDeadline(h, 40).fire();
    await h.waitForEvent('session.failed');
    expect(terminalsOf(h.events)).toEqual(['session.failed']);
  });

  it('[X-5] positive control: a productive frame DOES re-arm the stall budget', async () => {
    const h = await turnInFlight({ env: { [CODEX_STALL_TIMEOUT_ENV]: '40' } });
    expect(deadlinesOfBudget(h, 40)).toHaveLength(1);
    h.push(productiveFrame());
    await h.waitFor(() => deadlinesOfBudget(h, 40).length === 2, 'the stall budget to re-arm');
    // The superseded timer is stopped, not merely forgotten.
    expect(deadlinesOfBudget(h, 40)[0].stops).toBeGreaterThan(0);
    expect(terminalsOf(h.events)).toEqual([]);
  });

  it('[X-8] a parked approval pauses the kill instead of firing it', async () => {
    const h = await turnInFlight({ env: { [CODEX_STALL_TIMEOUT_ENV]: '40' } });
    h.push({
      method: 'thread/status/changed',
      params: { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
    });
    await h.waitFor(
      () => h.eventsOf('session.status').length > 0,
      'the waiting_permission projection'
    );
    latestDeadline(h, 40).fire();

    expect(terminalsOf(h.events)).toEqual([]);
    const notes = livenessNotes(h);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      source: 'stall',
      budgetMs: 40,
      reason: 'awaiting_user',
      degraded: false,
    });
    // Paused, not closed: the next window must still be able to speak.
    expect(deadlinesOfBudget(h, 40)).toHaveLength(2);
  });

  it('[X-8] a bare TTFT expiry emits exactly one degraded note and no verdict', async () => {
    const h = await turnInFlight({
      env: { [CODEX_TTFT_TIMEOUT_ENV]: '20', [CODEX_STALL_TIMEOUT_ENV]: '40' },
    });
    latestDeadline(h, 20).fire();
    expect(terminalsOf(h.events)).toEqual([]);
    const notes = livenessNotes(h);
    expect(notes).toEqual([
      { source: 'ttft', budgetMs: 20, reason: 'insufficient_evidence', degraded: true },
    ]);
    // The TTFT table is closed for good — no second window, no heartbeat.
    expect(deadlinesOfBudget(h, 20)).toHaveLength(1);
    // ...and the stall dog is still the observer that will speak.
    latestDeadline(h, 40).fire();
    await h.waitForEvent('session.failed');
    expect(livenessNotes(h)).toHaveLength(1);
  });
});

describe('Codex ack deadline vs stall watchdog (§7.5 [X-6])', () => {
  it('[X-6] keeps the 30 minute turn/start deadline exactly where it was', () => {
    // §7.5: NOT to be shortened to 195s. Whether codex acks at turn start or at
    // turn end is [未测], and a short ack deadline would fail healthy long turns.
    expect(CODEX_TURN_START_TIMEOUT_MS).toBe(30 * 60_000);
    expect(CODEX_TURN_START_TIMEOUT_MS).toBeGreaterThan(CODEX_STALL_TIMEOUT_MS);
  });

  it('[X-6] watchdog first, then the ack rejection: one terminal', async () => {
    const h = await turnInFlight({
      answerTurnStart: false,
      env: { [CODEX_STALL_TIMEOUT_ENV]: '40' },
    });
    // The notification stream reliably beats the response, so the turn names
    // itself while its ack is still outstanding.
    h.push({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } });
    await h.waitFor(() => deadlinesOfBudget(h, 40).length === 2, 'the stall budget to re-arm');

    latestDeadline(h, 40).fire();
    await h.waitForEvent('session.failed');
    expect(h.ops).toContain('write:turn/interrupt');

    // Now the ack loses the race. The `state.turn !== turn` guard has to swallow
    // it: a second terminal here would fail a session that was already told.
    const ack = h.written.find((frame) => frame.method === 'turn/start');
    h.push({ id: ack?.id, error: { code: -32000, message: 'request timed out' } });
    await h.waitFor(
      () => h.logs.some((line) => line.includes('after the turn ended')),
      'the late ack rejection to be swallowed'
    );
    expect(terminalsOf(h.events)).toEqual(['session.failed']);
  });

  it('[X-6] ack rejection first, then the watchdog: one terminal', async () => {
    const h = await turnInFlight({
      answerTurnStart: false,
      env: { [CODEX_STALL_TIMEOUT_ENV]: '40' },
    });
    const stall = latestDeadline(h, 40);

    const ack = h.written.find((frame) => frame.method === 'turn/start');
    h.push({ id: ack?.id, error: { code: -32000, message: 'request timed out' } });
    await h.waitForEvent('session.failed');
    // The terminal disarmed both dogs; a watchdog left running past its turn is
    // how the second terminal gets written.
    expect(stall.stops).toBeGreaterThan(0);

    stall.fire();
    expect(terminalsOf(h.events)).toEqual(['session.failed']);
    expect(h.ops).not.toContain('write:turn/interrupt');
  });
});
