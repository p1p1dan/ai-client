import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '../../shared/types/agentWire.ts';
import {
  DANGEROUS_PERMISSION_MODE,
  SESSION_PERMISSION_MODES,
  type SessionPermissionPreference,
} from '../../shared/types/runtimeEvents.ts';
import {
  CHAT_PERMISSION_MODE,
  ClaudeRuntime,
  claudePermissionPolicy,
  sessionPermissionMode,
} from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * D48 S4 §6.1 — changing the permission tier of a Claude session that is already
 * running.
 *
 * The channel is per-turn `query()` options, measured rather than designed:
 * every send opens a NEW query (`ensureSdk` caches the function, the stream is
 * built inside `send()`), and `permissionMode` is an option on it
 * [实测 06-probes P2]. So the whole change is one field on the session, and the
 * assertions here are about the two things that field must never do — drift
 * apart from what the surface reports (D1), and move a turn that is already in
 * flight (D2).
 *
 * Rig is `claudeRuntimePermissionPreference.test.ts`'s, deliberately: the same
 * capture-the-options fake is what makes "what the SDK got" observable, and a
 * second one would be a second answer to that question.
 */

type CapturedOptions = Record<string, unknown>;

interface StreamControl {
  release: () => void;
}

function makeCapturingQueryFn(captured: CapturedOptions[], control: { hold: boolean }) {
  const gates: Array<() => void> = [];
  const fn = (params: { prompt: string | AsyncIterable<unknown>; options?: CapturedOptions }) => {
    captured.push(params.options ?? {});
    const held = control.hold;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'rt-update' };
        if (held) {
          // A turn that stays open until the test lets it finish — the only way
          // to ask "what happens to an in-flight turn" of a runtime whose turns
          // otherwise complete synchronously.
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
        }
        yield { type: 'result', subtype: 'success', result: 'ok' };
      },
      close() {
        /* nothing to tear down */
      },
    };
  };
  const control2: StreamControl = {
    release: () => {
      for (const gate of gates.splice(0)) gate();
    },
  };
  return { fn, control: control2 };
}

interface Rig {
  runtime: ClaudeRuntime;
  registry: SessionRegistry;
  captured: CapturedOptions[];
  events: Array<Record<string, unknown>>;
  hold: { hold: boolean };
  release: () => void;
  eventsOf: (type: string) => Array<Record<string, unknown>>;
  payloadOf: (type: string) => Record<string, unknown>;
}

function makeRig(): Rig {
  const captured: CapturedOptions[] = [];
  const events: Array<Record<string, unknown>> = [];
  const registry = new SessionRegistry();
  const hold = { hold: false };
  const { fn, control } = makeCapturingQueryFn(captured, hold);
  const runtime = new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: (e) => events.push(e as Record<string, unknown>),
    log: () => undefined,
    registry,
    queryFn: fn,
  });
  return {
    runtime,
    registry,
    captured,
    events,
    hold,
    release: control.release,
    eventsOf: (type) => events.filter((e) => e.type === type),
    payloadOf: (type) =>
      ((events.find((e) => e.type === type) as { payload?: Record<string, unknown> } | undefined)
        ?.payload ?? {}) as Record<string, unknown>,
  };
}

const claudePreference = (permissionMode: string): SessionPermissionPreference =>
  ({ agent: CLAUDE_CODE_AGENT, permissionMode }) as SessionPermissionPreference;

/** Microtask poll — no fake timers here, the runtime's own awaits are the clock. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startedSession(rig: Rig, sessionId: string): void {
  rig.runtime.createSession({ sessionId, workspacePath: process.cwd() });
}

describe('D1 — a mid-session change reaches all three consumption points, or none', () => {
  it('the next turn, the registry and a later resume echo all read the changed tier', async () => {
    const rig = makeRig();
    startedSession(rig, 's-update');
    await rig.runtime.send({ sessionId: 's-update', text: 'first' });
    // Before the change: the session runs the constant.
    expect(rig.captured[0].permissionMode).toBe(CHAT_PERMISSION_MODE);

    rig.runtime.updatePermission({
      sessionId: 's-update',
      permissionPreference: claudePreference('plan'),
      requestId: 'req-1',
    });
    await rig.runtime.send({ sessionId: 's-update', text: 'second' });

    // Point 1 — what the SDK was handed on the NEXT turn.
    expect(rig.captured[1].permissionMode).toBe('plan');
    // The registry, which is what every reader derives from.
    expect(sessionPermissionMode(rig.registry.get('s-update'))).toBe('plan');
    // Points 2 and 3 — the two echo payloads. Compared to the CAPTURE, never to
    // a literal: a literal on either side would pass while the wiring rotted.
    rig.runtime.resumeSession({
      sessionId: 's-update',
      workspacePath: process.cwd(),
      runtimeIdentity: 'claude-session-id',
    });
    expect(rig.payloadOf('session.resumed').permissionMode).toBe(rig.captured[1].permissionMode);
  });

  it('the ACK re-states the accepted preference and says when it applies', () => {
    const rig = makeRig();
    startedSession(rig, 's-ack');
    rig.runtime.updatePermission({
      sessionId: 's-ack',
      permissionPreference: claudePreference('acceptEdits'),
      requestId: 'req-ack',
    });

    const acks = rig.eventsOf('session.permissionUpdated');
    expect(acks).toHaveLength(1);
    expect(acks[0].requestId).toBe('req-ack');
    expect(acks[0].payload).toEqual({
      preference: claudePreference('acceptEdits'),
      effective: 'next_turn',
    });
  });

  it('the change becomes a FACT on the next send, without a resume (D7, the producer half)', async () => {
    // The defect this pins: `session.created` / `session.resumed` fire ONCE per
    // Host session — `decideSendPreamble` returns `direct` for anything already
    // host-bound — so within one app run they can never restate a tier that was
    // changed after the session was opened. With no other producer the Composer
    // chip and the Context row would report the tier the chat STARTED on for the
    // rest of its life, while it ran under another one.
    const rig = makeRig();
    startedSession(rig, 's-echo');
    await rig.runtime.send({ sessionId: 's-echo', text: 'first' });
    expect(rig.payloadOf('session.settingsEcho')).toEqual({
      permissionPolicy: { agent: CLAUDE_CODE_AGENT, permissionMode: CHAT_PERMISSION_MODE },
    });

    rig.runtime.updatePermission({
      sessionId: 's-echo',
      permissionPreference: claudePreference('plan'),
    });
    // The ACK alone changes no fact: nothing has been handed to the SDK yet.
    expect(rig.eventsOf('session.settingsEcho')).toHaveLength(1);

    await rig.runtime.send({ sessionId: 's-echo', text: 'second' });

    const echoes = rig.eventsOf('session.settingsEcho');
    expect(echoes).toHaveLength(2);
    // Compared against the CAPTURE, not a literal: this event exists to say what
    // the SDK was handed, and two literals could agree while the wiring rotted.
    expect(
      (echoes[1].payload as { permissionPolicy: { permissionMode: string } }).permissionPolicy
        .permissionMode
    ).toBe(rig.captured[1].permissionMode);
    expect(echoes[1].payload).toEqual({
      permissionPolicy: { agent: CLAUDE_CODE_AGENT, permissionMode: 'plan' },
    });
  });

  it('the policy arm names the same agent the wire constant does', () => {
    // `claudePermissionPolicy` spells the discriminant as a literal (the union is
    // typed with literals, the exported constant is the wider `AgentWireName`),
    // so the two are pinned equal here rather than trusted to stay so.
    expect(claudePermissionPolicy('plan').agent).toBe(CLAUDE_CODE_AGENT);
  });

  it('emits NO session.created / session.resumed of its own (facts are not synthesized)', () => {
    const rig = makeRig();
    startedSession(rig, 's-nofacts');
    const before = rig.eventsOf('session.created').length;
    rig.runtime.updatePermission({
      sessionId: 's-nofacts',
      permissionPreference: claudePreference('plan'),
    });
    // Those two carry what the Host HANDED the SDK. Nothing has been handed to
    // it yet, so producing one here would report a fact a turn later invents.
    expect(rig.eventsOf('session.created')).toHaveLength(before);
    expect(rig.eventsOf('session.resumed')).toHaveLength(0);
  });
});

describe('D2 — the change lands on the next turn, and never on the one in flight', () => {
  it('refuses while a turn is running, and the running turn keeps its options', async () => {
    const rig = makeRig();
    startedSession(rig, 's-inflight');
    rig.hold.hold = true;
    const turn = rig.runtime.send({ sessionId: 's-inflight', text: 'long one' });
    // `send()` awaits the SDK lookup before it builds the stream, so the turn is
    // only really in flight once the options have been captured. Asserting
    // against a turn that had not started yet would pass for the wrong reason.
    await waitFor(() => rig.captured.length === 1, 'the first turn to open');
    // The options object the SDK is holding for this turn, captured at build time.
    const inFlightOptions = { ...rig.captured[0] };

    rig.runtime.updatePermission({
      sessionId: 's-inflight',
      permissionPreference: claudePreference('plan'),
      requestId: 'req-busy',
    });

    // Refused, not queued: a queued posture change applies at a moment nobody
    // chose, which is worse than a refusal the user can see and repeat.
    const errors = rig.eventsOf('host.error');
    expect(errors).toHaveLength(1);
    expect((errors[0].payload as { code: string }).code).toBe('session_busy');
    expect(errors[0].requestId).toBe('req-busy');
    expect(rig.eventsOf('session.permissionUpdated')).toHaveLength(0);
    // Nothing about the live turn moved, and no second stream was built for it.
    expect(rig.captured[0]).toEqual(inFlightOptions);
    expect(rig.captured).toHaveLength(1);
    // And the session still runs what it ran.
    expect(sessionPermissionMode(rig.registry.get('s-inflight'))).toBe(CHAT_PERMISSION_MODE);

    rig.hold.hold = false;
    rig.release();
    await turn;
  });

  it('the same change succeeds once the turn has finished', async () => {
    const rig = makeRig();
    startedSession(rig, 's-after');
    await rig.runtime.send({ sessionId: 's-after', text: 'one' });

    rig.runtime.updatePermission({
      sessionId: 's-after',
      permissionPreference: claudePreference('plan'),
    });
    expect(rig.eventsOf('session.permissionUpdated')).toHaveLength(1);
    expect(rig.eventsOf('host.error')).toHaveLength(0);
  });

  it('the ACK never claims immediate effect on this axis', () => {
    const rig = makeRig();
    startedSession(rig, 's-copy');
    rig.runtime.updatePermission({
      sessionId: 's-copy',
      permissionPreference: claudePreference('dontAsk'),
    });
    // The Codex axis says `immediately`; saying it here would promise the user a
    // tier change that the turn they are about to send is the first to see.
    const ack = rig.eventsOf('session.permissionUpdated')[0].payload as { effective: string };
    expect(ack.effective).toBe('next_turn');
    expect(ack.effective).not.toBe('immediately');
  });
});

describe('D3 — the bypass tier carries its extra key on the changed turn too', () => {
  it('a mid-session switch to bypassPermissions sends allowDangerouslySkipPermissions', async () => {
    const rig = makeRig();
    startedSession(rig, 's-danger');
    await rig.runtime.send({ sessionId: 's-danger', text: 'before' });
    expect('allowDangerouslySkipPermissions' in rig.captured[0]).toBe(false);

    rig.runtime.updatePermission({
      sessionId: 's-danger',
      permissionPreference: claudePreference(DANGEROUS_PERMISSION_MODE),
    });
    await rig.runtime.send({ sessionId: 's-danger', text: 'after' });

    // SDK 0.3.218 refuses the mode without the key [实测 sdk.d.ts:1729], so a
    // tier reachable only through this path would be one that never works.
    expect(rig.captured[1].permissionMode).toBe(DANGEROUS_PERMISSION_MODE);
    expect(rig.captured[1].allowDangerouslySkipPermissions).toBe(true);
  });

  it('switching BACK drops the key entirely, rather than sending false', async () => {
    const rig = makeRig();
    startedSession(rig, 's-back');
    rig.runtime.updatePermission({
      sessionId: 's-back',
      permissionPreference: claudePreference(DANGEROUS_PERMISSION_MODE),
    });
    await rig.runtime.send({ sessionId: 's-back', text: 'danger' });
    rig.runtime.updatePermission({
      sessionId: 's-back',
      permissionPreference: claudePreference('plan'),
    });
    await rig.runtime.send({ sessionId: 's-back', text: 'safe' });

    // `in`, not a value check: "we never asked to skip permissions" is an absent
    // key, and a build that sent the key everywhere would widen every session
    // while looking correct to a `=== false` assertion.
    expect('allowDangerouslySkipPermissions' in rig.captured[1]).toBe(false);
    expect(rig.captured[1].permissionMode).toBe('plan');
  });

  it('the runtime applies a dangerous tier only because the walls above cleared it', () => {
    // The runtime is deliberately NOT the confirmation gate — Main and the Host
    // dispatch each refuse an unconfirmed dangerous tier. This pins the division:
    // the tier is in the vocabulary, and it is never the fallback.
    expect(SESSION_PERMISSION_MODES).toContain(DANGEROUS_PERMISSION_MODE);
    expect(CHAT_PERMISSION_MODE).not.toBe(DANGEROUS_PERMISSION_MODE);
  });
});

describe('a mid-session change is refused rather than degraded', () => {
  it('a Codex posture on a Claude session changes nothing and says so', () => {
    const rig = makeRig();
    startedSession(rig, 's-cross');
    rig.runtime.updatePermission({
      sessionId: 's-cross',
      permissionPreference: {
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      },
      requestId: 'req-cross',
    });

    // Degrading to the constant here would tell a caller that asked for one
    // thing that it got something else, silently — the create path degrades
    // because its question is "what does this session run under"; this one's is
    // "change it", and there is no safe second answer to that.
    const errors = rig.eventsOf('host.error');
    expect(errors).toHaveLength(1);
    expect((errors[0].payload as { code: string }).code).toBe('invalid_payload');
    expect(rig.registry.get('s-cross')?.permissionPreference).toBeUndefined();
    expect(rig.eventsOf('session.permissionUpdated')).toHaveLength(0);
  });

  it('an unknown session is an error, not a row created on the way past', () => {
    const rig = makeRig();
    rig.runtime.updatePermission({
      sessionId: 'never-existed',
      permissionPreference: claudePreference('plan'),
      requestId: 'req-ghost',
    });
    const errors = rig.eventsOf('host.error');
    expect(errors).toHaveLength(1);
    expect((errors[0].payload as { code: string }).code).toBe('session_not_found');
    expect(rig.registry.get('never-existed')).toBeUndefined();
  });
});
