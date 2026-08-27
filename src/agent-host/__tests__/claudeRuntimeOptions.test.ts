import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeRuntime,
  normalizeEffort,
  PRODUCTIVE_EVENT_TYPES,
  resolveHostPartialMessagesEnabled,
  resolveSubagentActivityEnabled,
} from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';
import { STDERR_FORWARD_MAX_LINES_PER_TURN } from '../stderrRedaction.ts';

/**
 * #8 behavior lock: the exact `thinking` / `effort` options ClaudeRuntime hands
 * to the Agent SDK query().
 *
 * Why assert options rather than output: `pnpm typecheck` excludes
 * src/agent-host/, and the two defects behind #8 were both silent — a wrong
 * `thinking` shape is a runtime 400, and a missing `display` yields thinking
 * blocks with empty text and no error at all. Neither surfaces in a type check
 * or in a smoke that only asserts "a turn completed", so the option payload is
 * pinned here deterministically (standard #4, assert the process first).
 *
 * Shapes verified live by spikes/c16-thinking-shape-probe.ts against the CCH
 * gateway on claude-opus-4-8[1m] (SDK 0.3.218): {type:'adaptive'} alone yields
 * thinkingTextLen 0, while adding display:'summarized' yields 408.
 */

type CapturedOptions = Record<string, unknown>;

/** Minimal fake query() that records options and closes the turn immediately. */
function makeCapturingQueryFn(captured: CapturedOptions[]) {
  return (params: { prompt: string | AsyncIterable<unknown>; options?: CapturedOptions }) => {
    captured.push(params.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'rt-opts' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', result: 'ok' };
      },
      close() {
        /* nothing to tear down */
      },
    };
  };
}

function makeRuntime(captured: CapturedOptions[]): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: () => undefined,
    log: () => undefined,
    registry: new SessionRegistry(),
    queryFn: makeCapturingQueryFn(captured),
  });
}

/**
 * The settings cascade (取证档 `docs/plans/2026-08-27-settingsources-spike/`).
 *
 * `settingSources` was `[]` until this slice, and `[]` loads NOTHING — no
 * CLAUDE.md, no env, no hooks, no model preference [实测 spike §A①]. Opening it
 * is what puts both CLAUDE.md files back into the model's context.
 *
 * Nothing accompanies it. A `managedSettings: { permissions: { ask: ['*'] } }`
 * was written alongside — it forces every tool back through `canUseTool` even
 * when a settings file pre-approved it [实测 spike §D4] — and then removed by
 * ruling (2026-08-27, 「完全照配置办」): it could not tell the user's own file
 * from the repo's, so protecting against the repo meant overriding the user.
 * See `claudeRuntime.ts` at this option for the full reasoning.
 */
describe('claudeRuntime query options — settings cascade', () => {
  it("loads the user's and the project's settings, which is what restores CLAUDE.md", async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured).toHaveLength(1);
    expect(captured[0].settingSources).toEqual(['user', 'project']);
  });

  /**
   * `[]` is the one spelling that must never come back by accident: it is the
   * regression this slice exists to undo, and it is silent — nothing fails, the
   * model simply never sees the instructions the user wrote for it.
   */
  it('never falls back to loading no settings at all', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured[0].settingSources).not.toEqual([]);
  });

  /**
   * The removed override, pinned as an absence.
   *
   * Without this the option could drift back in as a "safety improvement" and
   * look like one — while quietly overriding what a user wrote in their own
   * `~/.claude/settings.json`, which is the thing the ruling said not to do.
   */
  it('does not override the permission decisions those settings express', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured[0].managedSettings).toBeUndefined();
  });
});

describe('claudeRuntime query options — thinking shape (#8)', () => {
  it('sends adaptive thinking with summarized display', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured).toHaveLength(1);
    // display is the load-bearing half: without it thinking text is empty.
    expect(captured[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('never sends the removed fixed-budget thinking shape', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's2', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's2', text: 'hi' });

    const thinking = captured[0].thinking as Record<string, unknown>;
    // `{type:'enabled', budgetTokens}` is deprecated on Opus 4.6/Sonnet 4.6 and
    // removed on Opus 4.8/4.7, Sonnet 5, Fable 5 — a latent 400.
    expect(thinking.type).not.toBe('enabled');
    expect(thinking).not.toHaveProperty('budgetTokens');
  });

  it('omits effort entirely when none is configured', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's3', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's3', text: 'hi' });

    // Absent (not undefined) so the model default applies.
    expect(captured[0]).not.toHaveProperty('effort');
  });
});

describe('claudeRuntime query options — effort threading (T-20 base, F3 per-turn contract)', () => {
  // F3 (2026-08-17 inspection): a send's effort is a per-turn STATEMENT, not
  // an override with a registry fallback. The renderer re-states an explicit
  // pick on every send (T-20 toWireEffort); an omitted key IS the composer's
  // "Default" state, so the registry record must never leak into query().
  it('a send with an explicit effort threads it as a top-level option', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's5', workspacePath: process.cwd(), effort: 'low' });
    await rt.send({ sessionId: 's5', text: 'hi', effort: 'xhigh' });

    // Top-level option — NOT output_config.effort (SDK 0.3.218 Options.effort).
    expect(captured[0].effort).toBe('xhigh');
    expect(captured[0]).not.toHaveProperty('output_config');
  });

  it('an omitted send effort omits the key even when create configured one (F3)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's6', workspacePath: process.cwd(), effort: 'medium' });
    await rt.send({ sessionId: 's6', text: 'hi' });

    expect(captured[0]).not.toHaveProperty('effort');
  });

  it('explicit effort on turn N does not leak into an omitting turn N+1 (F3)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's4', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's4', text: 'first', effort: 'high' });
    await rt.send({ sessionId: 's4', text: 'second' });

    expect(captured[0].effort).toBe('high');
    expect(captured[1]).not.toHaveProperty('effort');
  });

  it('drops an unknown effort value instead of forwarding it to the API', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    // Raw NDJSON from Main is untrusted; a bogus level must not reach query().
    rt.createSession({ sessionId: 's7', workspacePath: process.cwd(), effort: 'ludicrous' });
    await rt.send({ sessionId: 's7', text: 'hi', effort: 42 });

    expect(captured[0]).not.toHaveProperty('effort');
  });

  it('an invalid per-send effort is dropped, not replaced by the registry record (F3)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's8', workspacePath: process.cwd(), effort: 'high' });
    await rt.send({ sessionId: 's8', text: 'hi', effort: 'turbo' });

    expect(captured[0]).not.toHaveProperty('effort');
  });
});

/**
 * T-14 §4: `permissionMode` must have exactly one source
 * (`CHAT_PERMISSION_MODE` in claudeRuntime.ts) feeding both the query()
 * option and the session.created/session.resumed event payloads — asserted
 * by comparing the two captures to EACH OTHER rather than to a hardcoded
 * literal, so a future change to the constant cannot silently desync them
 * without failing this test.
 */
describe('claudeRuntime query options — permissionMode single source of truth (T-14)', () => {
  it('sends the SDK the same permissionMode session.created reports', async () => {
    const captured: CapturedOptions[] = [];
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeCapturingQueryFn(captured),
    });
    rt.createSession({ sessionId: 's24', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's24', text: 'hi' });

    const created = events.find((e) => e.type === 'session.created') as
      | { payload?: { permissionMode?: unknown; agent?: unknown } }
      | undefined;
    expect(created?.payload?.permissionMode).toBeDefined();
    expect(captured[0].permissionMode).toBe(created?.payload?.permissionMode);
    // S2 (b) producer-side lock, on the same object. `session.created` is the
    // ONLY place a brand-new Claude session states its binding (there is no
    // runtimeIdentity yet), and Main writes exactly what lands here into
    // `session-index.json`. The literal is deliberate: the value is an ABI —
    // rows already on disk carry it — so this fails both when the field is
    // dropped and when `CLAUDE_CODE_AGENT` is retyped. Every other test that
    // touches the binding synthesizes its own event and cannot see either.
    expect(created?.payload?.agent).toBe('claude-code');
  });

  it('sends the SDK the same permissionMode session.resumed reports', async () => {
    const captured: CapturedOptions[] = [];
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeCapturingQueryFn(captured),
    });
    rt.resumeSession({
      sessionId: 's25',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-25',
    });
    await rt.send({ sessionId: 's25', text: 'hi' });

    const resumed = events.find((e) => e.type === 'session.resumed') as
      | { payload?: { permissionMode?: unknown; agent?: unknown } }
      | undefined;
    expect(resumed?.payload?.permissionMode).toBeDefined();
    expect(captured[0].permissionMode).toBe(resumed?.payload?.permissionMode);
    // Resume states the binding too: a row that predates the field gets it
    // written on the first resume rather than staying blank forever.
    expect(resumed?.payload?.agent).toBe('claude-code');
  });

  it('pins the interactive default mode — never a bypass', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's26', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's26', text: 'hi' });

    expect(captured[0].permissionMode).toBe('default');
  });
});

/**
 * S2 (b): "the runtime states which agent it is."
 *
 * Main persists the binding from `session.created` / `session.resumed` and
 * never infers it from which adapter it happened to call. That makes this
 * runtime the PRODUCER of a value that ends up on disk — and the producer was
 * the one link with no test: `SessionIndexService.test.ts` and
 * `agentBindingMerge.test.ts` both synthesize their own events, so deleting
 * `agent: session.agent` here left all of them green.
 */
describe('claudeRuntime — self-reported agent (S2 b, producer side)', () => {
  function makeReportingRuntime(events: Record<string, unknown>[], registry: SessionRegistry) {
    return new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry,
      queryFn: makeCapturingQueryFn([]),
    });
  }

  it('stamps the registry entry and the created event from the same value', () => {
    const events: Record<string, unknown>[] = [];
    const registry = new SessionRegistry();
    makeReportingRuntime(events, registry).createSession({
      sessionId: 's-agent-1',
      workspacePath: process.cwd(),
    });

    const created = events.find((e) => e.type === 'session.created') as
      | { payload?: { agent?: unknown } }
      | undefined;
    // Compared to EACH OTHER (like permissionMode above), so the event cannot
    // start reporting something the registry does not hold — that divergence
    // is exactly what a second runtime would introduce.
    expect(created?.payload?.agent).toBe(registry.get('s-agent-1')?.agent);
    expect(registry.get('s-agent-1')?.agent).toBe('claude-code');
  });

  it('stamps the registry entry and the resumed event from the same value', () => {
    const events: Record<string, unknown>[] = [];
    const registry = new SessionRegistry();
    makeReportingRuntime(events, registry).resumeSession({
      sessionId: 's-agent-2',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-agent-2',
    });

    const resumed = events.find((e) => e.type === 'session.resumed') as
      | { payload?: { agent?: unknown } }
      | undefined;
    expect(resumed?.payload?.agent).toBe(registry.get('s-agent-2')?.agent);
    expect(registry.get('s-agent-2')?.agent).toBe('claude-code');
  });
});

describe('claudeRuntime query options — resume identity + F3 per-turn model/effort', () => {
  // History handoff. The 2026-07-29 cache probe caught a live silent model
  // switch + full prompt-cache rewrite when a resume-era send omitted the
  // model, and the Host grew a registry fallback to compensate. That was the
  // pre-D48 world: the renderer stated a model only at create/resume. Since
  // D48 S2 the renderer re-states the pick on EVERY send (resolveResumeModel
  // is the single formula for create, resume, and send), so cache continuity
  // is owned by the renderer — and the Host fallback flipped from protective
  // to harmful: it resurrected picks the composer had already cleared back to
  // Automatic (F3, 2026-08-17 inspection). An omitted key now stays omitted.
  it('threads resume identity, and a send states its own model/effort', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.resumeSession({
      sessionId: 's9',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-9',
      model: 'sonnet',
      effort: 'high',
    });
    await rt.send({ sessionId: 's9', text: 'hi', model: 'sonnet', effort: 'high' });

    expect(captured[0].model).toBe('sonnet');
    expect(captured[0].effort).toBe('high');
    expect(captured[0].resume).toBe('rt-uuid-9');
  });

  it('a resume-carried model does not leak into an omitting send (F3 Automatic)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's10', workspacePath: process.cwd() });
    rt.resumeSession({
      sessionId: 's10',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-10',
      model: 'opus',
      effort: 'medium',
    });
    await rt.send({ sessionId: 's10', text: 'hi' });

    expect(captured[0]).not.toHaveProperty('model');
    expect(captured[0]).not.toHaveProperty('effort');
    expect(captured[0].resume).toBe('rt-uuid-10');
  });

  it('drops an invalid effort at the resume boundary; a later explicit send works', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.resumeSession({
      sessionId: 's11',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-11',
      model: 'sonnet',
      effort: 'turbo',
    });
    await rt.send({ sessionId: 's11', text: 'hi' });
    await rt.send({ sessionId: 's11', text: 'again', effort: 'high' });

    expect(captured[0]).not.toHaveProperty('effort');
    expect(captured[1].effort).toBe('high');
  });
});

describe('claudeRuntime query options — per-send model override (round-2 P0 model pass-through)', () => {
  it('lets a per-send model override the session default set at create time', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's12', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's12', text: 'hi', model: 'opus' });

    expect(captured[0].model).toBe('opus');
  });

  it('applies a per-send model when the session was created/resumed with none', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's13', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's13', text: 'hi', model: 'haiku' });

    expect(captured[0].model).toBe('haiku');
  });

  it('an omitted send model omits the key even when create configured one (F3 Automatic)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's14', workspacePath: process.cwd(), model: 'opus' });
    await rt.send({ sessionId: 's14', text: 'hi' });

    expect(captured[0]).not.toHaveProperty('model');
  });

  // THE F3 regression (2026-08-17 inspection): explicit pick on turn N, back
  // to Automatic on turn N+1 within one live Host process. The pre-F3 re-pin
  // kept sending turn N's model while the trigger showed "Automatic".
  it('an explicit model on turn N does not leak into an omitting turn N+1 (F3)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's15', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's15', text: 'first', model: 'opus' });
    await rt.send({ sessionId: 's15', text: 'second' });

    expect(captured[0].model).toBe('opus');
    expect(captured[1]).not.toHaveProperty('model');
  });

  it('a non-string model is dropped, not replaced by the registry record (F3)', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's16', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's16', text: 'hi', model: 42 });

    expect(captured[0]).not.toHaveProperty('model');
  });

  it('omits model entirely when neither the session nor the send configured one', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's17', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's17', text: 'hi' });

    expect(captured[0]).not.toHaveProperty('model');
  });
});

describe('claudeRuntime query options — stderr forwarding (a2)', () => {
  it('passes a stderr callback to query() — SDK only forwards CLI stderr when this is set', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's18', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's18', text: 'hi' });

    expect(typeof captured[0].stderr).toBe('function');
  });

  it('forwards a stderr line to the runtime log with the [cli-stderr] prefix', async () => {
    const captured: CapturedOptions[] = [];
    const logs: unknown[][] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: () => undefined,
      log: (...args) => logs.push(args),
      registry: new SessionRegistry(),
      queryFn: makeCapturingQueryFn(captured),
    });
    rt.createSession({ sessionId: 's19', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's19', text: 'hi' });

    const stderrFn = captured[0].stderr as (line: string) => void;
    stderrFn('No conversation found with session ID: abc');

    expect(
      logs.some(
        (args) => args[0] === '[cli-stderr]' && String(args[1]).includes('No conversation found')
      )
    ).toBe(true);
  });
});

describe('claudeRuntime stderr → session.stderr events (T-35)', () => {
  function makeForwardingHarness() {
    const captured: CapturedOptions[] = [];
    const logs: unknown[][] = [];
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (event) => events.push(event),
      log: (...args) => logs.push(args),
      registry: new SessionRegistry(),
      queryFn: makeCapturingQueryFn(captured),
    });
    const stderrEvents = () => events.filter((event) => event.type === 'session.stderr');
    return { captured, logs, rt, stderrEvents };
  }

  it('emits one redacted session.stderr per line while the Host log keeps the raw line', async () => {
    const { captured, logs, rt, stderrEvents } = makeForwardingHarness();
    rt.createSession({ sessionId: 's20', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's20', text: 'hi', requestId: 'req-20' });

    const stderrFn = captured[0].stderr as (line: string) => void;
    stderrFn('auth failed for sk-ant-api03-secret at /home/dan/.claude');

    const forwarded = stderrEvents();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].sessionId).toBe('s20');
    expect(forwarded[0].requestId).toBe('req-20');
    // Redaction happens HOST-side, before the event exists — the Main bridge
    // is a content-agnostic passthrough (T-35 risk list).
    expect(forwarded[0].payload).toEqual({
      line: 'auth failed for [redacted] at ~/.claude',
    });
    // The raw line still reaches the Host log untouched — the complete record.
    expect(
      logs.some((args) => args[0] === '[cli-stderr]' && String(args[1]).includes('sk-ant-api03'))
    ).toBe(true);
  });

  it(`caps forwarding at ${STDERR_FORWARD_MAX_LINES_PER_TURN} lines per turn, marker last, log uncapped`, async () => {
    const { captured, logs, rt, stderrEvents } = makeForwardingHarness();
    rt.createSession({ sessionId: 's21', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's21', text: 'hi' });

    const stderrFn = captured[0].stderr as (line: string) => void;
    const total = STDERR_FORWARD_MAX_LINES_PER_TURN + 25;
    for (let n = 1; n <= total; n += 1) stderrFn(`retry chatter ${n}`);

    const forwarded = stderrEvents();
    expect(forwarded).toHaveLength(STDERR_FORWARD_MAX_LINES_PER_TURN);
    const last = forwarded[forwarded.length - 1].payload as { line: string };
    expect(last.line).toContain(`capped at ${STDERR_FORWARD_MAX_LINES_PER_TURN} lines`);
    expect(logs.filter((args) => args[0] === '[cli-stderr]')).toHaveLength(total);
  });
});

/** Fake queryFn that never yields anything until the abort signal fires, then throws (mirrors the real SDK's aborted-query behavior). */
function makeHangingQueryFn() {
  return (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const abort = params.options?.abortController as AbortController;
    const iterable = (async function* () {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('AbortError: aborted');
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

/**
 * F2 (2026-08-18 watchdog redesign) §3.4: a watchdog window that elapsed
 * WITHOUT the watchdog committing to abort rides on `session.status` as an
 * optional `liveness` note. Collector used by the [E-*] cases below.
 */
type LivenessNote = {
  source: string;
  budgetMs: number;
  reason: string;
  degraded: boolean;
};

function livenessNotes(events: Record<string, unknown>[]): LivenessNote[] {
  const notes: LivenessNote[] = [];
  for (const event of events) {
    if (event.type !== 'session.status') continue;
    const note = (event.payload as { liveness?: LivenessNote } | undefined)?.liveness;
    if (note) notes.push(note);
  }
  return notes;
}

/** The status a liveness note rode on — proves the note never clobbers a parked state. */
function livenessNoteStatuses(events: Record<string, unknown>[]): string[] {
  const statuses: string[] = [];
  for (const event of events) {
    if (event.type !== 'session.status') continue;
    const payload = event.payload as { status?: string; liveness?: LivenessNote } | undefined;
    if (payload?.liveness) statuses.push(String(payload.status));
  }
  return statuses;
}

function failedMessage(events: Record<string, unknown>[]): string {
  const failed = events.find((e) => e.type === 'session.failed');
  return String((failed?.payload as { error?: string } | undefined)?.error ?? '');
}

/** Fake queryFn: one productive event immediately, then a result after `delayMs`. */
function makeDelayedResultQueryFn(delayMs: number) {
  return (_params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const iterable = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { type: 'result', result: 'done' };
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

/** Fake queryFn: reacts to the abort signal, but only unwinds
 * `unwindDelayAfterAbortMs` AFTER it fires — models a child process that
 * is slow to actually exit once asked to (the abort() call itself does
 * not instantly resolve the stream). Module-level (S6, round-2 iteration-3
 * review) so both the TTFT describe block below and the dedicated stall
 * watchdog describe block further down can share it. */
function makeSlowToUnwindQueryFn(unwindDelayAfterAbortMs: number) {
  return (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const abort = params.options?.abortController as AbortController;
    const iterable = (async function* () {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, unwindDelayAfterAbortMs));
      throw new Error('AbortError: aborted');
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

describe('claudeRuntime TTFT watchdog (a4)', () => {
  const savedTtft = process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
  const savedStall = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
  const savedLivenessNote = process.env.AICLIENT_HOST_LIVENESS_NOTE;

  afterEach(() => {
    if (savedTtft === undefined) delete process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = savedTtft;
    if (savedStall === undefined) delete process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = savedStall;
    if (savedLivenessNote === undefined) delete process.env.AICLIENT_HOST_LIVENESS_NOTE;
    else process.env.AICLIENT_HOST_LIVENESS_NOTE = savedLivenessNote;
  });

  it('[E-0] total silence fails with its own message — but only on the SECOND window (F2 §3.3)', async () => {
    // F2 (2026-08-18) §3.3: `!sawAnySdkEvent` (not even `system/init` arrived)
    // stays real evidence of a dead spawn / auth failure, but it is demoted to
    // SECOND-window evidence: a cold start (first `npx` fetch, slow disk, AV
    // scan) can legitimately push the CLI child's first frame past one budget,
    // and killing it there makes Retry a deterministic failure loop. The first
    // window declines with a diagnostic note and re-arms — the ONE re-arm this
    // branch is allowed — and the second window commits.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '40';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeHangingQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-1', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-1', text: 'hi' });

    // Exactly one declined window stands between the send and the abort.
    const notes = livenessNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      source: 'ttft',
      budgetMs: 40,
      reason: 'insufficient_evidence',
      // the silent-spawn shape re-arms rather than closing the table — the
      // second window is where the evidence becomes sufficient.
      degraded: false,
    });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    // F14 minor m7: the message itself (not a wall-clock race against the
    // 5000ms stall timeout, which is flaky under load) proves TTFT — not
    // stall — fired.
    expect(failedMessage(events)).toContain('TTFT watchdog');
  });

  it('never fires once a productive event has arrived, even past the TTFT budget', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeDelayedResultQueryFn(200),
    });
    rt.createSession({ sessionId: 'ttft-2', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-2', text: 'hi' });

    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
  });

  /** Fake queryFn: `system/init` only, then a single productive assistant
   * event after `delayMs` — no incremental `stream_event`s in between. Models
   * the F1/B1 scenario: a healthy turn whose only "first productive event" is
   * one big adaptive-thinking response, arriving well past the TTFT budget. */
  function makeSlowHealthyQueryFn(delayMs: number) {
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const iterable = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'rt-slow-healthy' };
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'finally' }] } };
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('F1: never fires on a healthy turn that is merely slow to its first productive event (init arrived, no retry, past TTFT budget)', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeSlowHealthyQueryFn(220),
    });
    rt.createSession({ sessionId: 'ttft-3', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-3', text: 'hi' });

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  });

  /** Fake queryFn: init, one api_retry carrying exactly `retryFields`, then
   * hangs until aborted — a transport retry loop with no productive event ever
   * arriving. `retryFields` is spread RAW (snake_case, like the SDK's own
   * event) so a frame can also be modelled with the fields MISSING. */
  function makeRetryLoopQueryFn(retryFields: Record<string, unknown>) {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'rt-retry-loop' };
        yield {
          type: 'system',
          subtype: 'api_retry',
          error: 'upstream 529',
          ...retryFields,
        };
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('AbortError: aborted');
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  function makeRetryRuntime(
    events: Record<string, unknown>[],
    retryFields: Record<string, unknown>
  ) {
    return new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeRetryLoopQueryFn(retryFields),
    });
  }

  it('[E-1 boundary] fires once the SDK itself has given up — attempt === maxRetries (F2 §2.5)', async () => {
    // F2 §2.5 / decision D3: a BARE `sawApiRetry` is not evidence — it killed
    // turns that would have succeeded on attempt 2. The replacement carries its
    // own proof and costs no new constant: the SDK's own retry budget is
    // exhausted. `attempt === maxRetries` is the first qualifying value, so it
    // is the boundary that must fire.
    // The stall budget is deliberately short but still 4x the TTFT one: the
    // message discriminates WHICH watchdog spoke (F14 minor m7 — never a
    // wall-clock race), and a gate that failed to fire here would end up in
    // the stall's arms instead of hanging the suite for its whole timeout.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '200';
    const events: Record<string, unknown>[] = [];
    const rt = makeRetryRuntime(events, { attempt: 10, max_retries: 10 });
    rt.createSession({ sessionId: 'ttft-4', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-4', text: 'hi' });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    expect(failedMessage(events)).toContain('TTFT watchdog');
    expect(failedMessage(events)).not.toContain('stall watchdog');
  });

  it('[E-1] a single api_retry (1/10) is NOT abort evidence — the turn is left to the stall watchdog', async () => {
    // The incident sample [I-1] (spec §0.4) in one assertion: the CLI is
    // actively retrying, the turn is alive, and the old gate killed it anyway.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '30';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '200';
    const events: Record<string, unknown>[] = [];
    const rt = makeRetryRuntime(events, { attempt: 1, max_retries: 10 });
    rt.createSession({ sessionId: 'ttft-4b', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-4b', text: 'hi' });

    const message = failedMessage(events);
    expect(message).toContain('stall watchdog');
    expect(message).not.toContain('TTFT watchdog');
    // exactly one degrade note, then silence — the TTFT table closed itself
    // instead of re-arming every window (F2 §3.2, no heartbeat).
    expect(livenessNotes(events)).toHaveLength(1);
    expect(livenessNotes(events)[0]).toMatchObject({
      reason: 'insufficient_evidence',
      degraded: true,
    });
  });

  it('[E-1b] an api_retry frame MISSING attempt/max_retries is not evidence either (no 0 >= 0)', async () => {
    // F2 §2.5 trap: the NORMALIZED wire payload bottoms both fields out to `0`
    // (eventNormalizer.ts's `typeof msg.attempt === 'number' ? msg.attempt : 0`).
    // A gate keyed on that projection would read `0 >= 0` and abort on the
    // FIRST retry — worse than the behavior being fixed. The gate must key on
    // the RAW SDK event and treat a missing field as "no evidence", never as 0.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '30';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '200';
    const events: Record<string, unknown>[] = [];
    const rt = makeRetryRuntime(events, {});
    rt.createSession({ sessionId: 'ttft-4c', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-4c', text: 'hi' });

    const message = failedMessage(events);
    expect(message).toContain('stall watchdog');
    expect(message).not.toContain('TTFT watchdog');
  });

  /** Fake queryFn: parks on canUseTool (Bash) before any productive event,
   * only proceeding once the permission is answered. */
  function makePermissionParkedQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const canUseTool = params.options?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<{ behavior?: string }>;
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        const result = await canUseTool(
          'Bash',
          {},
          { signal: abort.signal, toolUseID: 'perm-parked-1' }
        );
        if (result.behavior !== 'allow') {
          throw new Error('denied');
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'after permission' }] },
        };
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('F1: never fires while a permission is parked before the first productive event', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makePermissionParkedQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-5', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'ttft-5', text: 'hi' });
    // Give the TTFT timer several windows to fire (and re-arm) while the
    // permission sits unanswered — this is the regression this test pins.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);

    const requested = events.find((e) => e.type === 'permission.requested');
    expect(requested).toBeTruthy();
    const permissionId = (requested?.payload as { permissionId?: string } | undefined)
      ?.permissionId as string;
    rt.respondPermission({ sessionId: 'ttft-5', permissionId, allow: true });

    await sendPromise;
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  });

  it('[E-2] a window that elapses while parked on a permission reports awaiting_user and does NOT degrade the table', async () => {
    // F2 §2.3 / §3.2 branch B: parking on a prompt is a LEGAL pause, not
    // missing evidence. It re-arms (so later windows still speak) and it must
    // never carry `degraded: true` — only the insufficient-evidence branch
    // closes the table. Guards mutation M19 (reason hard-wired to
    // 'insufficient_evidence').
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '30';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makePermissionParkedQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-7', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'ttft-7', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const notes = livenessNotes(events);
    // Several windows elapsed while the prompt sat unanswered: more than one
    // note is itself the proof that this branch re-armed instead of degrading.
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect(note.source).toBe('ttft');
      expect(note.reason).toBe('awaiting_user');
      expect(note.degraded).toBe(false);
      expect(note.budgetMs).toBe(30);
    }
    // The note rides on the session's CURRENT status: announcing a bare
    // 'running' here would clobber the renderer's parked state (the bridges
    // emit 'waiting_permission' without ever writing HostSession.status — see
    // resolveCompensationStatus's R14 note).
    expect(new Set(livenessNoteStatuses(events))).toEqual(new Set(['waiting_permission']));
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);

    const requested = events.find((e) => e.type === 'permission.requested');
    const permissionId = (requested?.payload as { permissionId?: string } | undefined)
      ?.permissionId as string;
    rt.respondPermission({ sessionId: 'ttft-7', permissionId, allow: true });

    await sendPromise;
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  });

  /** Fake queryFn: `system/init` lands, then the stream goes silent forever —
   * the R9 shape. `sawAnySdkEvent` is true, so total-silence evidence never
   * applies; nothing ever produces, so the stall watchdog is the real
   * terminator. */
  function makeSilentAfterInitQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'rt-r9' };
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('AbortError: aborted');
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('[E-4] R9: init then permanent silence degrades ONCE and dies as an honest STALL — never with the TTFT wording', async () => {
    // F2 §3.1 + new finding 4 (P0). The R9 shape is deliberately handed to the
    // stall watchdog; the TTFT table closes after one window. The honesty half:
    // markDegraded() also clears firedFlag, so the 195s failure is reported as
    // a stall — a message claiming "no first response within 30ms" arriving
    // 200ms later would be less honest than the behavior being fixed.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '30';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '200';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeSilentAfterInitQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-8', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-8', text: 'hi' });

    const notes = livenessNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({
      source: 'ttft',
      budgetMs: 30,
      reason: 'insufficient_evidence',
      degraded: true,
    });

    expect(events.some((e) => e.type === 'session.failed')).toBe(true);
    const message = failedMessage(events);
    expect(message).toContain('stall watchdog');
    expect(message).not.toContain('no first response within');
  });

  it('[E-3] AICLIENT_HOST_LIVENESS_NOTE=0 emits no note at all and changes no verdict', async () => {
    // F2 §9.2: the env bit is a QUIET switch (a test seam / ops knob), not a
    // product rollout gate — it stops paying for a frame nobody consumes, and
    // the judgement path is byte-for-byte the same.
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '30';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '200';
    process.env.AICLIENT_HOST_LIVENESS_NOTE = '0';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeSilentAfterInitQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-9', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-9', text: 'hi' });

    expect(livenessNotes(events)).toHaveLength(0);
    // Same verdict as [E-4] with the note on: stall, not TTFT.
    const message = failedMessage(events);
    expect(message).toContain('stall watchdog');
    expect(message).not.toContain('no first response within');
  });

  it('R7 + S6 (round-2 iteration-3 review): an early Stop before the TTFT deadline, with a stream slow enough to also outlive the stall deadline, still ends as an honest session.stopped — neither watchdog may relabel an already-aborted turn as a failure', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '20';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '60';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Abort fires at t≈5ms (below); the stream only actually unwinds
      // 60ms later — well after BOTH the 20ms TTFT deadline and the 60ms
      // stall deadline fire once each, on an already-aborted turn. Before
      // S6, the stall timer had no `abort.signal.aborted` guard, so it set
      // `stalled = true` and relabeled this Stop as a stall FAILURE.
      queryFn: makeSlowToUnwindQueryFn(60),
    });
    rt.createSession({ sessionId: 'ttft-6', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'ttft-6', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Explicit Stop, well before the 20ms TTFT deadline — when that timer
    // fires it must see `abort.signal.aborted` and reset `firedFlag` (R7)
    // instead of firing; the stall timer at 60ms must see the same signal
    // (S6) and return without setting `stalled`, instead of re-relabeling
    // this Stop as a watchdog failure.
    rt.stop({ sessionId: 'ttft-6' });

    await sendPromise;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    const stopped = events.find((e) => e.type === 'session.stopped');
    expect(stopped).toBeTruthy();
  });
});

describe('claudeRuntime PRODUCTIVE_EVENT_TYPES — frozen vocabulary (F2 §2.4)', () => {
  it('[E-5] is EXACTLY the five model-productive SDK top-level types', () => {
    // Membership is a judgement, not a list: every member re-arms the stall
    // watchdog and satisfies TTFT. Adding `system` would destroy the C-14
    // detector outright — an invalid model streams `api_retry` forever, and a
    // hang that re-arms its own watchdog is undetectable. `toEqual` on the set
    // (not `.has()` probes) is what makes an ADDITION red too.
    expect(PRODUCTIVE_EVENT_TYPES).toEqual(
      new Set(['assistant', 'user', 'result', 'tool_progress', 'stream_event'])
    );
  });
});

describe('claudeRuntime stall watchdog (C-14) — abort guard (S6, round-2 iteration-3 review)', () => {
  const savedTtft = process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
  const savedStall = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;

  afterEach(() => {
    if (savedTtft === undefined) delete process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = savedTtft;
    if (savedStall === undefined) delete process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = savedStall;
  });

  it('a Stop whose stream is slow to unwind past the stall deadline ends as session.stopped, not a stall failure — isolated from the TTFT watchdog (disabled here)', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '0'; // disabled — isolates this to the stall watchdog alone
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '20';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Abort fires at t≈5ms; the stream only unwinds 40ms later — well
      // after the 20ms stall deadline fires once, on an already-aborted turn.
      queryFn: makeSlowToUnwindQueryFn(40),
    });
    rt.createSession({ sessionId: 'stall-abort-1', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'stall-abort-1', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    rt.stop({ sessionId: 'stall-abort-1' });

    await sendPromise;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    const stopped = events.find((e) => e.type === 'session.stopped');
    expect(stopped).toBeTruthy();
  });

  /** Fake queryFn: one productive event immediately, then total silence
   * forever — no Stop, no further events — until the caller's own abort
   * fires (the stall watchdog's), at which point it unwinds like the real
   * SDK does on an aborted query. */
  function makeStallThenHangQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('AbortError: aborted');
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  // Iteration-4 fix: the test above only pins the NEGATIVE case (an already-
  // aborted turn must not be relabeled a stall). Nothing previously asserted
  // the POSITIVE case — that a genuine, un-aborted stall still fires. If a
  // future edit widens the `onStall` abort guard (e.g. to
  // `if (abort.signal.aborted || !session.running) return;`), every stall
  // watchdog would silently stop firing and hung turns would hang forever
  // with no `session.failed` — and the suite would stay green, because the
  // only stall-watchdog assertions were "must NOT fail".
  it('a genuine mid-turn stall — no Stop, no abort from the caller — still ends as an honest stall session.failed', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '0'; // disabled — isolates this to the stall watchdog alone
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '40';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeStallThenHangQueryFn(),
    });
    rt.createSession({ sessionId: 'stall-abort-2', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'stall-abort-2', text: 'hi' });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    const message = String((failed?.payload as { error?: string } | undefined)?.error ?? '');
    expect(message).toContain('Host stall watchdog');
    expect(events.some((e) => e.type === 'session.stopped')).toBe(false);
  });
});

describe('claudeRuntime result draining (round-2 F10: drain-with-deadline, not break-on-result)', () => {
  /** Fake queryFn: productive event, then result, then keeps the generator
   * alive for `postResultDelayMs` (simulating the CLI child still flushing
   * its own transcript) before finishing. */
  function makeDrainingQueryFn(postResultDelayMs: number) {
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', result: 'done' };
        await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('clears the admission gate at the result event, letting a new send land while the stream is still draining', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeDrainingQueryFn(200),
    });
    rt.createSession({ sessionId: 's20', workspacePath: process.cwd() });

    const firstSend = rt.send({ sessionId: 's20', text: 'first' });
    // Let the loop ingest assistant + result (near-instant) while the fake
    // stream's generator is still "draining" (asleep for 200ms afterward).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);

    // The admission gate is already clear well before the stream itself
    // finishes draining — a second send for the SAME session must not be
    // refused with session_busy.
    events.length = 0;
    await rt.send({ sessionId: 's20', text: 'second' });
    expect(
      events.some(
        (e) =>
          e.type === 'host.error' &&
          (e.payload as { code?: string } | undefined)?.code === 'session_busy'
      )
    ).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);

    await firstSend;
  });

  /** Fake queryFn: like `makeDrainingQueryFn`, but the post-result drain
   * itself reacts to the abort signal (as the real SDK's stream does) —
   * `makeDrainingQueryFn`'s fixed `setTimeout` ignores it entirely, which
   * would make a stop-during-drain test pass or fail on the WRONG mechanism
   * (this repo's own `DRAIN_AFTER_RESULT_MS` deadline, not the abort). */
  function makeAbortableDrainingQueryFn(postResultDelayMs: number) {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', result: 'done' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, postResultDelayMs);
          abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('AbortError: aborted'));
            },
            { once: true }
          );
        });
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('R6: stop() during the post-result drain window aborts the drain and emits an honest idle terminal, never echoing the stale "running" status', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Drains for 500ms after result unless aborted sooner — long enough
      // that a Stop landing just after `result` is clearly still inside the
      // drain window.
      queryFn: makeAbortableDrainingQueryFn(500),
    });
    rt.createSession({ sessionId: 's21', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 's21', text: 'hi' });
    // Let assistant + result land — `session.running` clears, but
    // `session.abort` stays alive for the rest of the 500ms drain.
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.length = 0;

    rt.stop({ sessionId: 's21' });

    // The old `!session.running || !session.abort` early return would have
    // echoed back the registry's still-stale `session.status` — 'running',
    // since that field is only corrected AFTER the drain loop exits — and
    // aborted nothing.
    const statusRightAfterStop = events.filter((e) => e.type === 'session.status');
    expect(
      statusRightAfterStop.some((e) => (e.payload as { status?: string })?.status === 'running')
    ).toBe(false);

    const start = Date.now();
    await sendPromise;
    const elapsed = Date.now() - start;

    // The drain was actually aborted, not left to hang out the full 500ms.
    expect(elapsed).toBeLessThan(400);
    expect(events.some((e) => e.type === 'session.stopped')).toBe(true);
    const finalStatus = events.filter((e) => e.type === 'session.status').pop();
    expect((finalStatus?.payload as { status?: string } | undefined)?.status).toBe('idle');
  });

  it('R8: a stream that hangs past DRAIN_AFTER_RESULT_MS after result hits the deadline branch and still tears down cleanly', async () => {
    const savedDrain = process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS;
    process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS = '30';
    try {
      const events: Record<string, unknown>[] = [];
      const rt = new ClaudeRuntime({
        driver: 'agent-sdk',
        cliPath: 'unused-in-fake',
        env: {},
        emit: (e) => events.push(e),
        log: () => undefined,
        registry: new SessionRegistry(),
        // Hangs far longer (5s) than the 30ms cap — only the deadline
        // branch (`Promise.race` against `drainDeadline`) can end this.
        queryFn: makeDrainingQueryFn(5_000),
      });
      rt.createSession({ sessionId: 's22', workspacePath: process.cwd() });

      const start = Date.now();
      await rt.send({ sessionId: 's22', text: 'hi' });
      const elapsed = Date.now() - start;

      // Must return once the 30ms drain deadline elapses, not wait out the
      // full 5s hang.
      expect(elapsed).toBeLessThan(1_000);
      expect(events.some((e) => e.type === 'session.completed')).toBe(true);
      expect(events.some((e) => e.type === 'session.failed')).toBe(false);

      // Clean teardown: a later send on the same session is not refused
      // with session_busy (registry.running/status both correctly settled).
      events.length = 0;
      await rt.send({ sessionId: 's22', text: 'again' });
      expect(
        events.some(
          (e) =>
            e.type === 'host.error' &&
            (e.payload as { code?: string } | undefined)?.code === 'session_busy'
        )
      ).toBe(false);
    } finally {
      if (savedDrain === undefined) delete process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS;
      else process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS = savedDrain;
    }
  });
});

describe('claudeRuntime post-result drain ownership (R5, round-2 iteration-2 review)', () => {
  /** Fake queryFn: first call yields assistant+result, drains for a bit,
   * then THROWS (simulating `ProcessTransport.getProcessExitError` rethrowing
   * after the terminal `result` message). Every subsequent call behaves
   * like an ordinary healthy turn. */
  function makeThrowDuringDrainThenNormalQueryFn(postResultDelayMs: number) {
    let callCount = 0;
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      callCount += 1;
      const isFirstCall = callCount === 1;
      const iterable = (async function* () {
        if (isFirstCall) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } };
          yield { type: 'result', result: 'done-1' };
          await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
          throw new Error('Claude Code process exited with code 1');
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } };
        yield { type: 'result', result: 'done-2' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('logs (does not report) a drain-phase throw from an OLD turn once a NEWER turn has taken over the session', async () => {
    const events: Record<string, unknown>[] = [];
    const logs: unknown[][] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: (...args) => logs.push(args),
      registry: new SessionRegistry(),
      queryFn: makeThrowDuringDrainThenNormalQueryFn(50),
    });
    rt.createSession({ sessionId: 's23', workspacePath: process.cwd() });

    const firstSend = rt.send({ sessionId: 's23', text: 'first' });
    // Let the first turn's assistant + result land — the admission gate
    // clears well before its 50ms drain-phase throw.
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.length = 0;

    // A second turn is admitted (and fully completes) WHILE the first is
    // still nominally "draining" — its own throw has not fired yet.
    await rt.send({ sessionId: 's23', text: 'second' });

    // The first turn's drain-phase throw fires only now (t≈50ms), well
    // after the second turn already owns `session.abort`.
    await firstSend;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.filter((e) => e.type === 'session.completed')).toHaveLength(1);
    expect(logs.some((args) => String(args.join(' ')).includes('no longer owns session'))).toBe(
      true
    );
  });
});

/**
 * T-34: `forwardSubagentText` is the only reason a subagent's own text and
 * thinking reach the Host at all (sdk.d.ts: by default only tool_use /
 * tool_result blocks are forwarded). It is silent when wrong in exactly the
 * way #8's `display` was — no error, just a permanently empty half of the
 * feature — so the option payload is pinned here rather than inferred from a
 * live run.
 */
describe('claudeRuntime query options — subagent activity flag (T-34)', () => {
  const FLAG = 'AICLIENT_HOST_SUBAGENT_ACTIVITY';
  const original = process.env[FLAG];

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('asks the SDK to forward subagent text by default (flag unset)', async () => {
    delete process.env[FLAG];
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'sub-on', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'sub-on', text: 'hi' });

    expect(captured[0].forwardSubagentText).toBe(true);
  });

  it('omits the option entirely in the quiet position (flag = 0)', async () => {
    process.env[FLAG] = '0';
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'sub-off', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'sub-off', text: 'hi' });

    // Absent, not `false` — the quiet position stops PAYING for messages
    // nothing will render, rather than asking for them and dropping them.
    expect(captured[0]).not.toHaveProperty('forwardSubagentText');
  });

  it('treats any other value as on — only an explicit 0 is quiet', async () => {
    process.env[FLAG] = '1';
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'sub-1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'sub-1', text: 'hi' });

    expect(captured[0].forwardSubagentText).toBe(true);
  });
});

describe('resolveSubagentActivityEnabled', () => {
  const FLAG = 'AICLIENT_HOST_SUBAGENT_ACTIVITY';
  const original = process.env[FLAG];

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('defaults on, and only an explicit "0" turns it off', () => {
    delete process.env[FLAG];
    expect(resolveSubagentActivityEnabled()).toBe(true);
    process.env[FLAG] = '';
    expect(resolveSubagentActivityEnabled()).toBe(true);
    process.env[FLAG] = '1';
    expect(resolveSubagentActivityEnabled()).toBe(true);
    process.env[FLAG] = 'true';
    expect(resolveSubagentActivityEnabled()).toBe(true);
    process.env[FLAG] = '0';
    expect(resolveSubagentActivityEnabled()).toBe(false);
  });
});

/**
 * Partial-messages flag (片 1a, D33③).
 *
 * Same silent-when-wrong shape as `forwardSubagentText` above: a missing
 * `includePartialMessages` produces no error at all, just a turn with zero
 * `stream_event` — which the normalizer's fact-based gate then treats as a
 * perfectly healthy control turn. Nothing downstream would ever complain, so
 * the option payload is pinned here rather than inferred from a live run.
 */
describe('claudeRuntime query options — partial messages flag (片 1a)', () => {
  const FLAG = 'AICLIENT_HOST_PARTIAL_MESSAGES';
  const original = process.env[FLAG];

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('asks the SDK for partial messages by default (flag unset)', async () => {
    delete process.env[FLAG];
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'partial-on', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'partial-on', text: 'hi' });

    expect(captured[0].includePartialMessages).toBe(true);
  });

  it('omits the option entirely in the rollback position (flag = 0)', async () => {
    process.env[FLAG] = '0';
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'partial-off', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'partial-off', text: 'hi' });

    // Absent, not `false` — mirrors the forwardSubagentText precedent, and it
    // is what makes the rollback position identical to the pre-batch build.
    expect(captured[0]).not.toHaveProperty('includePartialMessages');
  });

  it('treats any other value as on — only an explicit 0 rolls back', async () => {
    process.env[FLAG] = '1';
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 'partial-1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 'partial-1', text: 'hi' });

    expect(captured[0].includePartialMessages).toBe(true);
  });
});

describe('resolveHostPartialMessagesEnabled', () => {
  const FLAG = 'AICLIENT_HOST_PARTIAL_MESSAGES';
  const original = process.env[FLAG];

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('defaults on, and only an explicit "0" turns it off', () => {
    delete process.env[FLAG];
    expect(resolveHostPartialMessagesEnabled()).toBe(true);
    process.env[FLAG] = '';
    expect(resolveHostPartialMessagesEnabled()).toBe(true);
    process.env[FLAG] = '1';
    expect(resolveHostPartialMessagesEnabled()).toBe(true);
    process.env[FLAG] = 'true';
    expect(resolveHostPartialMessagesEnabled()).toBe(true);
    process.env[FLAG] = '0';
    expect(resolveHostPartialMessagesEnabled()).toBe(false);
  });
});

describe('normalizeEffort', () => {
  it('accepts every level the SDK declares', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(normalizeEffort(level)).toBe(level);
    }
  });

  it('rejects unknown, empty, and non-string values', () => {
    for (const bad of ['', 'HIGH', 'ultra', 0, 1, null, undefined, {}, ['high'], true]) {
      expect(normalizeEffort(bad)).toBeUndefined();
    }
  });
});
