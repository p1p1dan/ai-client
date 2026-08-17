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
