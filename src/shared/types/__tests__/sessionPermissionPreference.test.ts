import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  claudePermissionPreference,
  codexPermissionPreference,
  DANGEROUS_CODEX_SANDBOX_MODE,
  DANGEROUS_PERMISSION_MODE,
  isDangerousPermissionPreference,
  permissionChangeNeedsConfirmation,
  readSessionPermissionPreference,
  SESSION_PERMISSION_MODES,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';

const CLAUDE_CODE_AGENT = 'claude-code' as const;
const CODEX_AGENT = 'codex' as const;

/**
 * D48 S3 §5.4 — the REQUEST half of the permission pair, at the protocol
 * boundary.
 *
 * This value decides what a session may do without asking, and it arrives as
 * untrusted JSON (renderer → Main → Host over NDJSON, and also off app settings
 * on disk, which a user can edit). Every assertion below is about a way the
 * value can be wrong; the C-series ids are §5.7's.
 */

/**
 * The two agent names travel INTO the guard (they cannot live in
 * `runtimeEvents.ts` — see its header). Every call below goes through this
 * helper so the suite reads like the real callers do.
 */
const AGENTS = { claudeCode: CLAUDE_CODE_AGENT, codex: CODEX_AGENT } as const;

const isSessionPermissionPreference = (value: unknown): boolean =>
  readSessionPermissionPreference(value, AGENTS) !== undefined;

const CLAUDE_PLAN: SessionPermissionPreference = {
  agent: CLAUDE_CODE_AGENT,
  permissionMode: 'plan',
} as SessionPermissionPreference;

const CODEX_UNTRUSTED: SessionPermissionPreference = {
  agent: CODEX_AGENT,
  approvalPolicy: 'untrusted',
  sandboxMode: 'read-only',
} as SessionPermissionPreference;

describe('isSessionPermissionPreference — the accepted vocabulary', () => {
  it('accepts every Claude mode the SDK itself accepts', () => {
    // Five, not four: the frozen union is exactly SDK 0.3.218's own
    // `PermissionMode` [实测 sdk.d.ts:1720]. A guard that knew fewer would
    // refuse a tier the settings panel can produce.
    expect(SESSION_PERMISSION_MODES).toHaveLength(5);
    for (const permissionMode of SESSION_PERMISSION_MODES) {
      expect(isSessionPermissionPreference({ agent: CLAUDE_CODE_AGENT, permissionMode })).toBe(
        true
      );
    }
  });

  it('accepts every Codex approval × sandbox combination', () => {
    for (const approvalPolicy of CODEX_APPROVAL_POLICIES) {
      for (const sandboxMode of CODEX_SANDBOX_MODES) {
        expect(
          isSessionPermissionPreference({ agent: CODEX_AGENT, approvalPolicy, sandboxMode })
        ).toBe(true);
      }
    }
  });

  it('refuses a mode from the other agent, an unknown agent, and a widened string', () => {
    // Cross-arm keys are the failure that types alone do not catch: JSON has no
    // discriminant enforcement, so `{codex + permissionMode}` is a shape a
    // renderer bug can really produce.
    expect(isSessionPermissionPreference({ agent: CODEX_AGENT, permissionMode: 'plan' })).toBe(
      false
    );
    expect(
      isSessionPermissionPreference({
        agent: CLAUDE_CODE_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
      })
    ).toBe(false);
    expect(isSessionPermissionPreference({ agent: 'gemini', permissionMode: 'plan' })).toBe(false);
    expect(
      isSessionPermissionPreference({ agent: CLAUDE_CODE_AGENT, permissionMode: 'Plan' })
    ).toBe(false);
    expect(
      isSessionPermissionPreference({ agent: CODEX_AGENT, approvalPolicy: 'on_request' } as unknown)
    ).toBe(false);
  });

  it('refuses non-objects, arrays and a missing discriminant', () => {
    for (const value of [undefined, null, 'plan', 42, [], {}, { permissionMode: 'plan' }]) {
      expect(isSessionPermissionPreference(value)).toBe(false);
    }
  });

  /**
   * C8 negative control, and the one deliberate strictness in an otherwise
   * additive guard. `networkAccess` is a FACT the runtime reports, never a
   * request field — accepting an object that carries one would let a caller
   * believe a dimension was configured while nothing configured it (§5.5).
   */
  it('C8 — refuses a Codex preference that claims to set networkAccess', () => {
    expect(
      isSessionPermissionPreference({
        agent: CODEX_AGENT,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        networkAccess: true,
      })
    ).toBe(false);
    // Even `false` is refused: the objection is to the KEY (a claim of control),
    // not to the value it carries.
    expect(
      isSessionPermissionPreference({
        agent: CODEX_AGENT,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        networkAccess: false,
      })
    ).toBe(false);
  });

  it('C8 — the Preference type itself has no networkAccess key on either arm', () => {
    // Type-level half of the same control: the runtime guard could be relaxed
    // by someone who "fixed" the type, so the type is pinned too. `keyof` on the
    // union yields only the keys COMMON to both arms, so each arm is listed.
    const claudeKeys = Object.keys(CLAUDE_PLAN).sort();
    const codexKeys = Object.keys(CODEX_UNTRUSTED).sort();
    expect(claudeKeys).toEqual(['agent', 'permissionMode']);
    expect(codexKeys).toEqual(['agent', 'approvalPolicy', 'sandboxMode'].sort());
  });

  it('tolerates an unknown extra key (protocol additivity)', () => {
    // A NEWER renderer must not be refused by an older Host: the one exception
    // is `networkAccess` above, because that key is a claim rather than data.
    expect(
      isSessionPermissionPreference({
        agent: CLAUDE_CODE_AGENT,
        permissionMode: 'plan',
        somethingFromTheFuture: 1,
      })
    ).toBe(true);
  });
});

describe('per-arm extractors — a runtime never gets the other agent half', () => {
  it('hands each runtime its own arm and undefined for the other', () => {
    expect(claudePermissionPreference(CLAUDE_PLAN, CLAUDE_CODE_AGENT)).toEqual(CLAUDE_PLAN);
    expect(claudePermissionPreference(CODEX_UNTRUSTED, CLAUDE_CODE_AGENT)).toBeUndefined();
    expect(codexPermissionPreference(CODEX_UNTRUSTED, CODEX_AGENT)).toEqual(CODEX_UNTRUSTED);
    expect(codexPermissionPreference(CLAUDE_PLAN, CODEX_AGENT)).toBeUndefined();
    // …and asking for one arm while naming the OTHER agent yields nothing: the
    // discriminant is checked, not assumed from which function was called.
    expect(claudePermissionPreference(CLAUDE_PLAN, CODEX_AGENT)).toBeUndefined();
    expect(codexPermissionPreference(CODEX_UNTRUSTED, CLAUDE_CODE_AGENT)).toBeUndefined();
  });

  it('never adapts, completes or half-applies a malformed value', () => {
    for (const value of [undefined, null, {}, { agent: CODEX_AGENT }, 'plan']) {
      expect(claudePermissionPreference(value, CLAUDE_CODE_AGENT)).toBeUndefined();
      expect(codexPermissionPreference(value, CODEX_AGENT)).toBeUndefined();
    }
  });
});

describe('isDangerousPermissionPreference (C13/C16 input)', () => {
  it('names exactly the two tiers the §8.0-Q3 decision calls dangerous', () => {
    expect(
      isDangerousPermissionPreference({
        agent: CLAUDE_CODE_AGENT,
        permissionMode: DANGEROUS_PERMISSION_MODE,
      } as SessionPermissionPreference)
    ).toBe(true);
    expect(
      isDangerousPermissionPreference({
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: DANGEROUS_CODEX_SANDBOX_MODE,
      } as SessionPermissionPreference)
    ).toBe(true);
  });

  it('does not call the merely permissive tiers dangerous', () => {
    // `never` approvals with a workspace sandbox is permissive, not dangerous:
    // conflating the two would put a second-confirmation dialog in front of a
    // tier the user is expected to pick, and users click through those.
    expect(
      isDangerousPermissionPreference({
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
      } as SessionPermissionPreference)
    ).toBe(false);
    for (const permissionMode of SESSION_PERMISSION_MODES) {
      if (permissionMode === DANGEROUS_PERMISSION_MODE) continue;
      expect(
        isDangerousPermissionPreference({
          agent: CLAUDE_CODE_AGENT,
          permissionMode,
        } as SessionPermissionPreference)
      ).toBe(false);
    }
    expect(isDangerousPermissionPreference(undefined)).toBe(false);
  });
});

/**
 * D48 S4 / R18 — the legacy second-confirmation predicate vocabulary.
 *
 * T30 deleted the executable NDJSON Host wall. These pure contract tests remain
 * until T31/T35 removes the legacy Claude/Codex permission DTO itself.
 */
describe('permissionChangeNeedsConfirmation — one gate, two walls (R18)', () => {
  const DANGEROUS = [
    { agent: CLAUDE_CODE_AGENT, permissionMode: DANGEROUS_PERMISSION_MODE },
    { agent: CODEX_AGENT, approvalPolicy: 'never', sandboxMode: DANGEROUS_CODEX_SANDBOX_MODE },
  ] as SessionPermissionPreference[];
  const SAFE = [
    { agent: CLAUDE_CODE_AGENT, permissionMode: 'plan' },
    { agent: CODEX_AGENT, approvalPolicy: 'untrusted', sandboxMode: 'read-only' },
  ] as SessionPermissionPreference[];

  it('holds every dangerous tier until the confirmation is the BOOLEAN true', () => {
    for (const preference of DANGEROUS) {
      // Everything that is not `true` means the caller did not state what this
      // asks. `"true"` and `1` are what an untrusted JSON payload looks like
      // when somebody tried, and expanding privilege gets no benefit of the doubt.
      for (const confirmed of [undefined, null, false, 0, 1, 'true', 'yes', {}, []]) {
        expect(permissionChangeNeedsConfirmation(preference, confirmed)).toBe(true);
      }
      expect(permissionChangeNeedsConfirmation(preference, true)).toBe(false);
    }
  });

  it('never asks for a confirmation on a tier that is not dangerous (negative half)', () => {
    // A gate that fired on safe tiers too would train the user to click through
    // it, which is how the dialog stops being a decision.
    for (const preference of SAFE) {
      for (const confirmed of [undefined, false, true]) {
        expect(permissionChangeNeedsConfirmation(preference, confirmed)).toBe(false);
      }
    }
    expect(permissionChangeNeedsConfirmation(undefined, undefined)).toBe(false);
  });
});
