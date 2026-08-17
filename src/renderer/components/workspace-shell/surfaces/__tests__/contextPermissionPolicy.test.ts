import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionPermissionPolicy } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  type ContextRuntimeFacts,
  deriveContextGroups,
  initialSessionRuntimeFacts,
  reduceSessionRuntimeFacts,
  type SessionRuntimeFactsState,
} from '../contextSurfaceModel';

/**
 * D48 S3 §5.7 — the read side of the permission chain, C1 through C6.
 *
 * The failure this suite exists for is not a crash: it is a Codex session whose
 * Permission policy row silently disappears (today's behaviour) or, worse, one
 * whose row reports a Claude tier it is not in. Both are the panel lying about
 * what a session may do, which is the one thing a security-posture row must
 * never do.
 */

const CODEX_POLICY: SessionPermissionPolicy = {
  agent: 'codex',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  networkAccess: false,
};

const CLAUDE_POLICY: SessionPermissionPolicy = {
  agent: 'claude-code',
  permissionMode: 'plan',
};

function created(sessionId: string, payload: Record<string, unknown>) {
  return { type: 'session.created', sessionId, payload };
}

function runtimeFacts(overrides: Partial<ContextRuntimeFacts> = {}): ContextRuntimeFacts {
  return {
    configuredModel: null,
    actualModel: null,
    effortSelection: undefined,
    permissionMode: undefined,
    host: { state: 'ready', pid: undefined, driver: undefined, version: undefined },
    ...overrides,
  };
}

function permissionRow(facts: ContextRuntimeFacts) {
  const groups = deriveContextGroups({
    workspace: null,
    runtime: facts,
    session: null,
    stderr: null,
  });
  return groups
    .find((group) => group.id === 'runtime')
    ?.rows.find((row) => row.id === 'permission-policy');
}

describe('reduceSessionRuntimeFacts — the policy half (C1/C2/C4)', () => {
  it('C1 — a Codex session.created writes permissionPolicy, with no permissionMode anywhere in sight', () => {
    const next = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { agent: 'codex', permissionPolicy: CODEX_POLICY })
    );
    expect(next.s1?.permissionPolicy).toEqual(CODEX_POLICY);
    // The legacy field stays absent: the Codex payload never had one, and
    // synthesizing a Claude tier for it is mutation ⑥'s failure.
    expect(next.s1?.permissionMode).toBeUndefined();
  });

  /**
   * C2 — the N4 ordering pin, and the reason this test looks unusual.
   *
   * The bug it guards is a REORDERING, not a wrong value: putting the
   * `permissionPolicy` read after `isSessionPermissionMode`'s guard makes C1
   * pass through a `return prev` and produce exactly the empty state a
   * Host-that-never-reported would. A payload with a valid policy and NO
   * permissionMode key is the only input that can tell the two apart, so it is
   * asserted here explicitly rather than left implicit in C1.
   *
   * The static half below is what survives someone "simplifying" the reducer:
   * it reads the source and requires the policy read to appear before the
   * guard's early return, so the order is pinned by the file and not only by
   * the behaviour that happens to depend on it today.
   */
  it('C2 — the policy is read BEFORE the permissionMode guard, in behaviour and in source order', () => {
    const payloadWithoutMode = { agent: 'codex', permissionPolicy: CODEX_POLICY };
    expect('permissionMode' in payloadWithoutMode).toBe(false);
    const next = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', payloadWithoutMode)
    );
    expect(next).not.toBe(initialSessionRuntimeFacts);
    expect(next.s1?.permissionPolicy).toEqual(CODEX_POLICY);

    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../contextSurfaceModel.ts'),
      'utf8'
    );
    const reducerBody = source.slice(source.indexOf('export function reduceSessionRuntimeFacts'));
    const policyRead = reducerBody.indexOf('isSessionPermissionPolicy(payload?.permissionPolicy)');
    const modeGuard = reducerBody.indexOf('isSessionPermissionMode(rawMode)');
    expect(policyRead).toBeGreaterThan(-1);
    expect(modeGuard).toBeGreaterThan(-1);
    expect(policyRead).toBeLessThan(modeGuard);
  });

  it('C4 — a payload carrying both keeps both, and neither erases the other', () => {
    const withBoth = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { permissionMode: 'acceptEdits', permissionPolicy: CLAUDE_POLICY })
    );
    expect(withBoth.s1).toEqual({
      permissionPolicy: CLAUDE_POLICY,
      permissionMode: 'acceptEdits',
    });
  });

  it('C4 — a later payload with a missing or invalid policy does not overwrite a known one', () => {
    const first = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { permissionPolicy: CODEX_POLICY })
    );
    const noPolicy = reduceSessionRuntimeFacts(first, created('s1', { permissionMode: 'plan' }));
    expect(noPolicy.s1?.permissionPolicy).toEqual(CODEX_POLICY);

    const garbage = reduceSessionRuntimeFacts(
      noPolicy,
      created('s1', { permissionPolicy: { agent: 'codex', approvalPolicy: 'yolo' } })
    );
    expect(garbage.s1?.permissionPolicy).toEqual(CODEX_POLICY);
    expect(garbage).toBe(noPolicy);
  });

  it('C4 — session A never touches session B', () => {
    const withA = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('a', { permissionPolicy: CODEX_POLICY })
    );
    const withB = reduceSessionRuntimeFacts(
      withA,
      created('b', { permissionPolicy: CLAUDE_POLICY })
    );
    expect(withB.a?.permissionPolicy).toEqual(CODEX_POLICY);
    expect(withB.b?.permissionPolicy).toEqual(CLAUDE_POLICY);
  });

  it('returns the SAME state object when nothing changed (zustand short-circuits on identity)', () => {
    const first = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { permissionPolicy: CODEX_POLICY })
    );
    const again = reduceSessionRuntimeFacts(
      first,
      created('s1', { permissionPolicy: { ...CODEX_POLICY } })
    );
    expect(again).toBe(first);
  });

  // The PRODUCER for this shape is pinned on the Host side, in
  // `codexRuntime.test.ts` ("C11 resume — session.resumed carries the VERIFIED
  // posture"): a reducer arm with no producer is an assertion about a payload
  // nobody sends, which is exactly what this pair looked like until the S3
  // terminal check found `emitResumed` omitting the field unconditionally.
  it('a session.resumed carries the policy on the same path as session.created', () => {
    const next = reduceSessionRuntimeFacts(initialSessionRuntimeFacts, {
      type: 'session.resumed',
      sessionId: 's1',
      payload: { permissionPolicy: CODEX_POLICY },
    });
    expect(next.s1?.permissionPolicy).toEqual(CODEX_POLICY);
  });
});

describe('isSessionPermissionPolicy, through the reducer (C6)', () => {
  /**
   * The guard is module-private (it lives next to its only consumer), so its
   * truth table is exercised where it is actually load-bearing: a value that
   * fails it must leave the facts map untouched.
   */
  const accepted: Array<[string, unknown]> = [
    ['claude arm', CLAUDE_POLICY],
    ['codex arm', CODEX_POLICY],
    ['codex arm with network on', { ...CODEX_POLICY, networkAccess: true }],
    [
      'codex arm, most restrictive',
      { ...CODEX_POLICY, approvalPolicy: 'untrusted', sandboxMode: 'read-only' },
    ],
    [
      'codex arm, the dangerous sandbox (reportable, just not defaultable)',
      { ...CODEX_POLICY, sandboxMode: 'danger-full-access' },
    ],
    [
      // S3 terminal check: the ONE optional dimension. Every `session.resumed`
      // omits it (`thread/resume` never echoes the key [实测]), and refusing
      // the payload would throw away the two dimensions the Host DID verify —
      // i.e. put the row back to "not reported" for every session that survived
      // an app restart.
      'codex arm with no networkAccess — the runtime did not report that dimension',
      { agent: 'codex', approvalPolicy: 'never', sandboxMode: 'read-only' },
    ],
  ];

  const refused: Array<[string, unknown]> = [
    ['unknown agent slug', { agent: 'gemini', permissionMode: 'plan' }],
    ['no discriminant at all', { permissionMode: 'plan' }],
    ['unknown claude mode', { agent: 'claude-code', permissionMode: 'yolo' }],
    ['unknown codex approval', { ...CODEX_POLICY, approvalPolicy: 'sometimes' }],
    ['unknown codex sandbox', { ...CODEX_POLICY, sandboxMode: 'full' }],
    // Optional is not "anything goes": a PRESENT key must still be a boolean,
    // or a widened `'false'` would render as `Network: on`.
    ['codex networkAccess as a string', { ...CODEX_POLICY, networkAccess: 'false' }],
    ['codex networkAccess as null', { ...CODEX_POLICY, networkAccess: null }],
    ['claude arm carrying codex keys', { ...CLAUDE_POLICY, approvalPolicy: 'never' }],
    ['codex arm carrying a claude mode', { ...CODEX_POLICY, permissionMode: 'plan' }],
    ['a widened string', 'workspace-write'],
    ['an array', [CODEX_POLICY]],
    ['null', null],
  ];

  for (const [label, value] of accepted) {
    it(`accepts ${label}`, () => {
      const next = reduceSessionRuntimeFacts(
        initialSessionRuntimeFacts,
        created('s1', { permissionPolicy: value })
      );
      expect(next.s1?.permissionPolicy).toEqual(value);
    });
  }

  for (const [label, value] of refused) {
    it(`refuses ${label} — the facts map is left exactly as it was`, () => {
      const prev: SessionRuntimeFactsState = initialSessionRuntimeFacts;
      const next = reduceSessionRuntimeFacts(prev, created('s1', { permissionPolicy: value }));
      expect(next).toBe(prev);
    });
  }
});

describe('the Permission policy row (C3/C5)', () => {
  it('C5 — a Codex policy renders all three dimensions, never a Claude enum', () => {
    const row = permissionRow(
      runtimeFacts({ permissionMode: null, permissionPolicy: CODEX_POLICY })
    );
    expect(row).toEqual({
      id: 'permission-policy',
      label: 'Permission policy',
      value: 'Approval: on-request · Sandbox: workspace-write · Network: off',
    });
  });

  it('C5 — networkAccess true and the dangerous sandbox are reported verbatim, not softened', () => {
    const row = permissionRow(
      runtimeFacts({
        permissionMode: null,
        permissionPolicy: {
          ...CODEX_POLICY,
          sandboxMode: 'danger-full-access',
          networkAccess: true,
        },
      })
    );
    expect(row?.value).toBe('Approval: on-request · Sandbox: danger-full-access · Network: on');
  });

  it('C5 — an unreported network dimension says so, it does not resolve to off', () => {
    // The shape every resumed Codex session arrives in. `off` here would be the
    // panel stating a limit nobody verified, on the row whose whole job is the
    // safety posture — and on `danger-full-access` it would be backwards.
    const row = permissionRow(
      runtimeFacts({
        permissionMode: null,
        permissionPolicy: {
          agent: 'codex',
          approvalPolicy: 'never',
          sandboxMode: 'danger-full-access',
        },
      })
    );
    expect(row?.value).toBe(
      'Approval: never · Sandbox: danger-full-access · Network: not reported'
    );
    // The two verified dimensions are still fully reported — an absent third
    // one must not cost the row the facts the Host did confirm.
    expect(row?.value).not.toContain('Network: off');
  });

  it('C3 — a legacy permissionMode-only session renders byte for byte what it renders today', () => {
    const row = permissionRow(runtimeFacts({ permissionMode: 'acceptEdits' }));
    expect(row).toEqual({
      id: 'permission-policy',
      label: 'Permission policy',
      value: 'Accept edits',
    });
  });

  it('C3 — a Claude POLICY renders the identical string a legacy mode does', () => {
    const viaPolicy = permissionRow(
      runtimeFacts({ permissionMode: null, permissionPolicy: CLAUDE_POLICY })
    );
    const viaLegacy = permissionRow(runtimeFacts({ permissionMode: 'plan' }));
    expect(viaPolicy?.value).toBe(viaLegacy?.value);
    expect(viaPolicy?.value).toBe('Plan');
  });

  it('C4 — the policy wins over the legacy field when both are present', () => {
    const row = permissionRow(
      runtimeFacts({ permissionMode: 'bypassPermissions', permissionPolicy: CLAUDE_POLICY })
    );
    expect(row?.value).toBe('Plan');
  });

  it('C5 — nothing reported stays the honest string, never a guessed default', () => {
    const row = permissionRow(runtimeFacts({ permissionMode: null, permissionPolicy: null }));
    expect(row?.value).toBe('Permission policy not reported');
  });

  it('C5 — no active session omits the row entirely (both carriers undefined)', () => {
    expect(permissionRow(runtimeFacts())).toBeUndefined();
  });

  it('C5 — a Codex session with only the policy still gets a row (the regression this slice closes)', () => {
    const row = permissionRow(runtimeFacts({ permissionPolicy: CODEX_POLICY }));
    expect(row?.value).toBe('Approval: on-request · Sandbox: workspace-write · Network: off');
  });
});

/**
 * D48 S4 §6.2-6 / D7 — the mid-session echo, and the ACK that is NOT one.
 *
 * codex answers `thread/settings/update` with an EMPTY body [实测 06-probes P3].
 * So there are two events after a mid-session change and only one of them is
 * evidence: `session.permissionUpdated` says "the runtime accepted this
 * REQUEST", and `session.settingsEcho` (one mapping of the full 13-field
 * `thread/settings/updated` frame) says what the thread is actually running
 * under. This panel is a facts surface, so it may only ever move on the second.
 */
describe('reduceSessionRuntimeFacts — the mid-session echo (D48 S4, D7)', () => {
  const ECHOED: SessionPermissionPolicy = {
    agent: 'codex',
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
  };

  function echo(sessionId: string, payload: Record<string, unknown>) {
    return { type: 'session.settingsEcho', sessionId, payload };
  }

  it('an echo moves the row without any session.created in sight', () => {
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { agent: 'codex', permissionPolicy: CODEX_POLICY })
    );
    const next = reduceSessionRuntimeFacts(established, echo('s1', { permissionPolicy: ECHOED }));
    expect(next.s1?.permissionPolicy).toEqual(ECHOED);
    // The whole point of the slice: the tier changed with no new session and no
    // new turn, and the panel followed.
    expect(
      permissionRow(runtimeFacts({ permissionPolicy: next.s1?.permissionPolicy }))?.value
    ).toBe('Approval: never · Sandbox: read-only · Network: not reported');
  });

  it('the ACK is not a fact: session.permissionUpdated leaves the map byte-identical', () => {
    // The failure this forbids is mutation ⑧: treating the reply to our own
    // request as confirmation. On the Codex axis that reply is literally `null`,
    // so a panel that moved on it would be reporting a posture on the strength
    // of a message that states nothing.
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { agent: 'codex', permissionPolicy: CODEX_POLICY })
    );
    const after = reduceSessionRuntimeFacts(established, {
      type: 'session.permissionUpdated',
      sessionId: 's1',
      payload: {
        preference: { agent: 'codex', approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
        effective: 'immediately',
      },
    });
    expect(after).toBe(established);
  });

  it('the echo is read BEFORE the created/resumed narrowing, in behaviour and in source order', () => {
    // Same N4 shape C2 pins for the policy read: an echo branch placed after the
    // `session.created`/`session.resumed` check is a silent no-op, because an
    // echo is neither of those two types and would already have returned.
    const next = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      echo('s1', { permissionPolicy: ECHOED })
    );
    expect(next).not.toBe(initialSessionRuntimeFacts);
    expect(next.s1?.permissionPolicy).toEqual(ECHOED);

    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../contextSurfaceModel.ts'),
      'utf8'
    );
    const reducerBody = source.slice(source.indexOf('export function reduceSessionRuntimeFacts'));
    const echoBranch = reducerBody.indexOf("event.type === 'session.settingsEcho'");
    const narrowing = reducerBody.indexOf("event.type !== 'session.created'");
    expect(echoBranch).toBeGreaterThan(-1);
    expect(narrowing).toBeGreaterThan(-1);
    expect(echoBranch).toBeLessThan(narrowing);
  });

  it('an unreadable echo never erases a posture that WAS reported', () => {
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { agent: 'codex', permissionPolicy: CODEX_POLICY })
    );
    for (const payload of [
      {},
      { permissionPolicy: undefined },
      { permissionPolicy: { agent: 'codex', approvalPolicy: 'nope', sandboxMode: 'read-only' } },
      { permissionPolicy: { agent: 'codex', approvalPolicy: 'never' } },
      { permissionPolicy: { agent: 'martian', approvalPolicy: 'never', sandboxMode: 'read-only' } },
      // The model half of the frame is not this map's business, and a frame
      // carrying only a model must not blank the posture.
      { model: 'gpt-5.5' },
    ]) {
      expect(reduceSessionRuntimeFacts(established, echo('s1', payload))).toBe(established);
    }
  });

  it('an echo with no sessionId, and an echo for another session, are both inert here', () => {
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { agent: 'codex', permissionPolicy: CODEX_POLICY })
    );
    expect(
      reduceSessionRuntimeFacts(established, {
        type: 'session.settingsEcho',
        payload: { permissionPolicy: ECHOED },
      })
    ).toBe(established);
    const other = reduceSessionRuntimeFacts(established, echo('s2', { permissionPolicy: ECHOED }));
    expect(other.s1?.permissionPolicy).toEqual(CODEX_POLICY);
    expect(other.s2?.permissionPolicy).toEqual(ECHOED);
  });

  it('re-echoing the same posture returns the same object (zustand short-circuits on identity)', () => {
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      echo('s1', { permissionPolicy: ECHOED })
    );
    expect(reduceSessionRuntimeFacts(established, echo('s1', { permissionPolicy: ECHOED }))).toBe(
      established
    );
  });

  it('an echo never touches the legacy Claude carrier beside it', () => {
    const claude = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { permissionMode: 'acceptEdits' })
    );
    const next = reduceSessionRuntimeFacts(claude, echo('s1', { permissionPolicy: ECHOED }));
    expect(next.s1?.permissionMode).toBe('acceptEdits');
    expect(next.s1?.permissionPolicy).toEqual(ECHOED);
  });

  it('the CLAUDE axis produces this event too, and the same fold reads it', () => {
    // The Claude half of the mid-session echo (§6.3): its runtime emits one of
    // these at the moment `query()` is handed the tier, because
    // `session.created`/`session.resumed` fire once per Host session and cannot
    // restate a change made afterwards. No new consumer was added for it — the
    // fold already accepts the claude arm of the policy union, and this is the
    // assertion that keeps that true.
    const established = reduceSessionRuntimeFacts(
      initialSessionRuntimeFacts,
      created('s1', { permissionMode: 'default' })
    );
    const claudePolicy: SessionPermissionPolicy = {
      agent: 'claude-code',
      permissionMode: 'plan',
    };
    const next = reduceSessionRuntimeFacts(
      established,
      echo('s1', { permissionPolicy: claudePolicy })
    );
    expect(next.s1?.permissionPolicy).toEqual(claudePolicy);
    // C4's precedence still decides the row: the policy outranks the legacy
    // field, so the panel reports the tier the SDK was just handed.
    expect(
      permissionRow(
        runtimeFacts({
          permissionMode: next.s1?.permissionMode,
          permissionPolicy: next.s1?.permissionPolicy,
        })
      )?.value
    ).toBe('Plan');
  });
});
