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
  resolveClaudePermissionMode,
  sessionPermissionMode,
} from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * D48 S3 §5.5 — `CHAT_PERMISSION_MODE` became a session value, and the header it
 * carried ("change this constant, not either call site") became an invariant
 * that has to be asserted rather than trusted.
 *
 * The failure being pinned: the mode reaches the SDK through `query()` options
 * while the SAME mode is reported to the renderer on `session.created` /
 * `session.resumed` (06-probes P2, item 2, names all three sites). Feed one of the
 * three from the constant and the Context surface reports a posture the SDK
 * never received — silently, because both values are individually plausible.
 * Every assertion below therefore compares CAPTURES to each other, never a
 * capture to a literal.
 */

type CapturedOptions = Record<string, unknown>;

function makeCapturingQueryFn(captured: CapturedOptions[]) {
  return (params: { prompt: string | AsyncIterable<unknown>; options?: CapturedOptions }) => {
    captured.push(params.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'rt-perm' };
        yield { type: 'result', subtype: 'success', result: 'ok' };
      },
      close() {
        /* nothing to tear down */
      },
    };
  };
}

interface Rig {
  runtime: ClaudeRuntime;
  registry: SessionRegistry;
  captured: CapturedOptions[];
  events: Array<Record<string, unknown>>;
  payloadOf: (type: string) => Record<string, unknown>;
}

function makeRig(): Rig {
  const captured: CapturedOptions[] = [];
  const events: Array<Record<string, unknown>> = [];
  const registry = new SessionRegistry();
  const runtime = new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: (e) => events.push(e as Record<string, unknown>),
    log: () => undefined,
    registry,
    queryFn: makeCapturingQueryFn(captured),
  });
  return {
    runtime,
    registry,
    captured,
    events,
    payloadOf: (type) =>
      ((events.find((e) => e.type === type) as { payload?: Record<string, unknown> } | undefined)
        ?.payload ?? {}) as Record<string, unknown>,
  };
}

const claudePreference = (permissionMode: string): SessionPermissionPreference =>
  ({ agent: CLAUDE_CODE_AGENT, permissionMode }) as SessionPermissionPreference;

describe('resolveClaudePermissionMode — the fallback arm (C13/C14)', () => {
  it('falls back to the constant for absent, malformed and cross-agent input', () => {
    expect(resolveClaudePermissionMode(undefined)).toBe(CHAT_PERMISSION_MODE);
    expect(
      resolveClaudePermissionMode({
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      } as SessionPermissionPreference)
    ).toBe(CHAT_PERMISSION_MODE);
    // A Codex arm has no `permissionMode` at all: without the arm check this
    // would put `undefined` into the options, which the SDK reads as "nothing
    // was requested" rather than as an error.
    expect(sessionPermissionMode(undefined)).toBe(CHAT_PERMISSION_MODE);
  });

  it('C13 — the fallback constant is not a dangerous tier', () => {
    // This constant IS the degradation arm for every malformed input above, so
    // §5.4-4 ("绝不做默认值") is about exactly this value.
    expect(CHAT_PERMISSION_MODE).not.toBe(DANGEROUS_PERMISSION_MODE);
    expect(SESSION_PERMISSION_MODES).toContain(CHAT_PERMISSION_MODE);
  });
});

describe('claudeRuntime — the requested tier reaches all four places (C11)', () => {
  it('create: query options, session.created and the registry all read one value', async () => {
    const rig = makeRig();
    rig.runtime.createSession({
      sessionId: 's-pref-create',
      workspacePath: process.cwd(),
      permissionPreference: claudePreference('plan'),
    });
    await rig.runtime.send({ sessionId: 's-pref-create', text: 'hi' });

    const created = rig.payloadOf('session.created');
    // Three captures, compared to each other and then to the registry — the
    // fourth place. A literal on any side would pass while the wiring rotted.
    expect(rig.captured[0].permissionMode).toBe(created.permissionMode);
    expect(created.permissionMode).toBe(sessionPermissionMode(rig.registry.get('s-pref-create')));
    // And it is the tier that was asked for, not the constant.
    expect(created.permissionMode).toBe('plan');
    expect(created.permissionMode).not.toBe(CHAT_PERMISSION_MODE);
  });

  it('resume: the same three readers, on the resume half of the pair', async () => {
    const rig = makeRig();
    rig.runtime.resumeSession({
      sessionId: 's-pref-resume',
      workspacePath: process.cwd(),
      runtimeIdentity: 'claude-session-id',
      permissionPreference: claudePreference('acceptEdits'),
    });
    await rig.runtime.send({ sessionId: 's-pref-resume', text: 'hi' });

    const resumed = rig.payloadOf('session.resumed');
    expect(rig.captured[0].permissionMode).toBe(resumed.permissionMode);
    expect(resumed.permissionMode).toBe(sessionPermissionMode(rig.registry.get('s-pref-resume')));
    expect(resumed.permissionMode).toBe('acceptEdits');
  });

  it('C14 — a create with no preference behaves exactly as it did before D48', async () => {
    const rig = makeRig();
    rig.runtime.createSession({ sessionId: 's-legacy', workspacePath: process.cwd() });
    await rig.runtime.send({ sessionId: 's-legacy', text: 'hi' });

    expect(rig.payloadOf('session.created').permissionMode).toBe(CHAT_PERMISSION_MODE);
    expect(rig.captured[0].permissionMode).toBe(CHAT_PERMISSION_MODE);
    expect(rig.registry.get('s-legacy')?.permissionPreference).toBeUndefined();
  });

  it('a preference for the other agent is dropped, never adapted', async () => {
    const rig = makeRig();
    rig.runtime.createSession({
      sessionId: 's-cross',
      workspacePath: process.cwd(),
      permissionPreference: {
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      },
    });
    await rig.runtime.send({ sessionId: 's-cross', text: 'hi' });

    // The Host refuses this upstream (C10); the runtime is the second wall, and
    // "degrade to the safe constant" is the only acceptable second answer.
    expect(rig.registry.get('s-cross')?.permissionPreference).toBeUndefined();
    expect(rig.captured[0].permissionMode).toBe(CHAT_PERMISSION_MODE);
  });

  it('a later send keeps the session tier — there is no per-turn reset', async () => {
    const rig = makeRig();
    rig.runtime.createSession({
      sessionId: 's-two-turns',
      workspacePath: process.cwd(),
      permissionPreference: claudePreference('dontAsk'),
    });
    await rig.runtime.send({ sessionId: 's-two-turns', text: 'one' });
    await rig.runtime.send({ sessionId: 's-two-turns', text: 'two' });

    expect(rig.captured).toHaveLength(2);
    expect(rig.captured[1].permissionMode).toBe('dontAsk');
  });
});

describe('claudeRuntime — the bypass tier carries its own key, the others must not (C16)', () => {
  it('sends allowDangerouslySkipPermissions with bypassPermissions', async () => {
    const rig = makeRig();
    rig.runtime.createSession({
      sessionId: 's-bypass',
      workspacePath: process.cwd(),
      permissionPreference: claudePreference(DANGEROUS_PERMISSION_MODE),
    });
    await rig.runtime.send({ sessionId: 's-bypass', text: 'hi' });

    // SDK 0.3.218 refuses the mode outright without this key [实测 sdk.d.ts:1729],
    // so a tier that shipped without it would be a control that never works.
    expect(rig.captured[0].permissionMode).toBe(DANGEROUS_PERMISSION_MODE);
    expect(rig.captured[0].allowDangerouslySkipPermissions).toBe(true);
  });

  it('omits the key entirely for every other tier (negative half)', async () => {
    for (const permissionMode of SESSION_PERMISSION_MODES) {
      if (permissionMode === DANGEROUS_PERMISSION_MODE) continue;
      const rig = makeRig();
      rig.runtime.createSession({
        sessionId: `s-${permissionMode}`,
        workspacePath: process.cwd(),
        permissionPreference: claudePreference(permissionMode),
      });
      await rig.runtime.send({ sessionId: `s-${permissionMode}`, text: 'hi' });

      expect(rig.captured[0].permissionMode).toBe(permissionMode);
      // `in`, not `=== undefined`: a build that sent `false` everywhere would
      // pass the value check while widening what it declares to the SDK.
      expect('allowDangerouslySkipPermissions' in rig.captured[0]).toBe(false);
    }
  });

  it('the default session (no preference at all) never carries the key', async () => {
    const rig = makeRig();
    rig.runtime.createSession({ sessionId: 's-default-key', workspacePath: process.cwd() });
    await rig.runtime.send({ sessionId: 's-default-key', text: 'hi' });

    expect('allowDangerouslySkipPermissions' in rig.captured[0]).toBe(false);
  });
});
