import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_AGENT } from '../../shared/types/agentWire.ts';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexSandboxMode,
} from '../../shared/types/runtimeEvents.ts';
import { CODEX_PERMISSION_DEFAULT } from '../codexRuntime.ts';
import {
  buildThreadSettingsUpdateParams,
  fromSandboxPolicyType,
  readThreadSettings,
  THREAD_SETTINGS_UPDATE_KEYS,
  toSandboxPolicy,
} from '../codexSettingsUpdate.ts';

/**
 * D48 S4 §6.2 — the parameter layer of the zero-turn permission channel.
 *
 * The defect these assertions exist for is unusual and is the reason the module
 * is whitelist-shaped rather than merely careful: `thread/settings/update`
 * ACCEPTS UNKNOWN FIELDS SILENTLY [实测 06-probes P1 严格性观察 — unknown key
 * returns `{}`, broadcasts nothing, changes nothing], while a bad enum and a
 * missing `threadId` are both `-32600`. So a misspelled or mis-shaped field
 * produces no error at runtime and no failure in any test that checks "the call
 * succeeded". Every assertion below therefore reads the FRAME, not the outcome.
 */

const settingsSchema = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, 'fixtures', 'codex', 'codex-settings-schema.json'),
    'utf8'
  )
) as {
  codexVersion: string;
  ThreadSettingsUpdateParams: {
    required: string[];
    propertyNames: string[];
    permissionsDescription: string;
  };
  SandboxPolicy: { variants: Array<{ type: string; propertyNames: string[] }> };
  AskForApproval: { stringVariants: string[] };
  ThreadSettings: { required: string[]; propertyNames: string[] };
};

const THREAD = '01a00d97-78c5-7b91-955b-0b1d5b5af4e2';

/** The full 13-field frame P3 recorded, minus the gateway name. */
function recordedSettingsFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: THREAD,
    threadSettings: {
      cwd: '/tmp/d48-probe/ws2',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: true, writableRoots: [] },
      activePermissionProfile: null,
      model: 'gpt-5.5',
      modelProvider: 'gateway',
      serviceTier: 'priority',
      effort: 'low',
      summary: 'detailed',
      collaborationMode: { mode: 'default' },
      multiAgentMode: 'explicitRequestOnly',
      personality: 'pragmatic',
      ...overrides,
    },
  };
}

describe('D4 — the parameter whitelist is the schema, and nothing outside it is expressible', () => {
  it('every whitelisted key is a declared ThreadSettingsUpdateParams property', () => {
    // The other direction is deliberately NOT asserted: the schema declares
    // thirteen properties and this build has a real source for five of them.
    // Requiring parity would force us to invent values for `personality` and
    // `serviceTier` in order to stay green.
    for (const key of THREAD_SETTINGS_UPDATE_KEYS) {
      expect(settingsSchema.ThreadSettingsUpdateParams.propertyNames).toContain(key);
    }
  });

  it('threadId is the only required field, and the builder refuses a blank one', () => {
    expect(settingsSchema.ThreadSettingsUpdateParams.required).toEqual(['threadId']);
    expect(buildThreadSettingsUpdateParams({ threadId: '   ' })).toEqual({
      ok: false,
      reason: expect.stringContaining('threadId'),
    });
  });

  it('a built frame carries ONLY whitelisted keys, on the wire as well as in the type', () => {
    const build = buildThreadSettingsUpdateParams({
      threadId: THREAD,
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    // Through JSON, because that is what the connection writes: a key added by
    // a spread of some caller's object would survive the type system's notice
    // and show up here.
    const onWire = JSON.parse(JSON.stringify(build.params)) as Record<string, unknown>;
    for (const key of Object.keys(onWire)) {
      expect(THREAD_SETTINGS_UPDATE_KEYS).toContain(key);
    }
    expect(Object.keys(onWire).sort()).toEqual(['approvalPolicy', 'sandboxPolicy', 'threadId']);
  });

  it('omission is unchanged, and is spelled by the key being ABSENT rather than null', () => {
    // `null` means CLEAR on this API [实测 06-probes §0.2], so sending it for
    // "I did not touch this" would erase a thread setting nobody asked to erase.
    const build = buildThreadSettingsUpdateParams({ threadId: THREAD, approvalPolicy: 'never' });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.changed).toEqual(['approvalPolicy']);
    expect('sandboxPolicy' in build.params).toBe(false);
    expect('model' in build.params).toBe(false);
    expect(JSON.stringify(build.params)).not.toContain('null');
  });

  it('a change of nothing produces a frame with nothing in it but the address', () => {
    const build = buildThreadSettingsUpdateParams({ threadId: THREAD });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    // The caller reads `changed` to decide whether to write at all — a frame
    // that says only "this thread" would be a round trip with no question in it.
    expect(build.changed).toEqual([]);
    expect(build.params).toEqual({ threadId: THREAD });
  });
});

describe('D5 — the sandbox shape is mapped, and the three call sites do not share a spelling', () => {
  it('every mode maps to a declared SandboxPolicy variant', () => {
    const declared = settingsSchema.SandboxPolicy.variants.map((v) => v.type);
    for (const mode of CODEX_SANDBOX_MODES) {
      expect(declared).toContain(toSandboxPolicy(mode).type);
    }
  });

  it('maps each tier by name, in both directions, with no tier left over', () => {
    const pairs: Array<[CodexSandboxMode, string]> = [
      ['read-only', 'readOnly'],
      ['workspace-write', 'workspaceWrite'],
      ['danger-full-access', 'dangerFullAccess'],
    ];
    for (const [mode, type] of pairs) {
      expect(toSandboxPolicy(mode)).toEqual({ type });
      expect(fromSandboxPolicyType(type)).toBe(mode);
    }
    // Round trip over the whole vocabulary: a table that gained an entry on one
    // side only would report a posture as a different posture.
    for (const mode of CODEX_SANDBOX_MODES) {
      expect(fromSandboxPolicyType(toSandboxPolicy(mode).type)).toBe(mode);
    }
  });

  it('externalSandbox is declared by the binary and deliberately unmapped', () => {
    // Present in the schema, absent from `CodexSandboxMode` — `thread/start`'s
    // enum is three wide, so a fourth tier here could only be invented, and it
    // would be one this build can neither request on create nor verify on resume.
    expect(settingsSchema.SandboxPolicy.variants.map((v) => v.type)).toContain('externalSandbox');
    expect(fromSandboxPolicyType('externalSandbox')).toBeUndefined();
    expect(CODEX_SANDBOX_MODES).not.toContain('externalSandbox');
  });

  it('the thread/start spelling never appears in a settings frame (the copy-paste defect)', () => {
    // `CODEX_PERMISSION_DEFAULT.sandboxMode` is `workspace-write`, a kebab STRING
    // that `thread/start` takes verbatim. Feeding it to `sandboxPolicy` is an
    // unknown-shaped field, i.e. accepted and ignored — the posture would read
    // as changed and would not be.
    const build = buildThreadSettingsUpdateParams({
      threadId: THREAD,
      sandboxMode: CODEX_PERMISSION_DEFAULT.sandboxMode,
    });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    const json = JSON.stringify(build.params);
    for (const kebab of CODEX_SANDBOX_MODES) {
      expect(json).not.toContain(kebab);
    }
    expect(build.params.sandboxPolicy).toEqual({ type: 'workspaceWrite' });
  });

  it('the tier goes out bare — no networkAccess is ever stated', () => {
    // The schema lets us set it; the preference type structurally cannot carry
    // it (§5.4), and this is where that stays true on the wire. Stating it would
    // make a fact into a request, which is the pair S3 exists to keep apart.
    for (const mode of CODEX_SANDBOX_MODES) {
      const build = buildThreadSettingsUpdateParams({ threadId: THREAD, sandboxMode: mode });
      expect(build.ok).toBe(true);
      if (!build.ok) return;
      expect(build.params.sandboxPolicy && Object.keys(build.params.sandboxPolicy)).toEqual([
        'type',
      ]);
    }
    expect(
      settingsSchema.SandboxPolicy.variants.find((v) => v.type === 'workspaceWrite')?.propertyNames
    ).toContain('networkAccess');
  });

  it("the approval vocabulary is the binary's own three strings", () => {
    expect([...CODEX_APPROVAL_POLICIES]).toEqual(settingsSchema.AskForApproval.stringVariants);
  });
});

describe('D6 — permissions and sandboxPolicy are mutually exclusive, and the server will not say so', () => {
  it('refuses the combination and emits no frame at all', () => {
    expect(settingsSchema.ThreadSettingsUpdateParams.permissionsDescription).toContain(
      'Cannot be combined with `sandboxPolicy`'
    );
    const build = buildThreadSettingsUpdateParams({
      threadId: THREAD,
      permissions: 'some-profile',
      sandboxMode: 'read-only',
    });
    expect(build.ok).toBe(false);
    if (build.ok) return;
    // WHICH rule refused, not merely that something did. Both inputs are
    // independently refusable in this build (§9.1 implements no named profile),
    // so `ok === false` alone stays green when the exclusivity check is deleted
    // — the profile check underneath it catches the same call for a different
    // reason, and the rule that has to survive a future profile picker would be
    // gone with nothing red. [变异 ⑥ 首轮存活，本条是补的咬合力]
    expect(build.reason).toContain('sandboxPolicy');
    expect(build.reason).toContain('permissions');
    // No half-built params on the failure arm: dropping one of the two would be
    // the same silent substitution the whole module exists to prevent.
    expect(build).not.toHaveProperty('params');
  });

  it('refuses a named profile even on its own (D48 §9.1 does not implement them)', () => {
    const build = buildThreadSettingsUpdateParams({ threadId: THREAD, permissions: 'p' });
    expect(build.ok).toBe(false);
    if (build.ok) return;
    expect(build.reason).toMatch(/not implemented/);
  });
});

describe('D7 reader — one frame, one mapping, and unmodelled shapes read as silence', () => {
  it('reads the recorded P3 frame into every dimension it carries', () => {
    expect(readThreadSettings(recordedSettingsFrame())).toEqual({
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      networkAccess: true,
      model: 'gpt-5.5',
      effort: 'low',
    });
  });

  it('a granular approval object is not folded into one of the three strings', () => {
    // Declared upstream and unmodelled here. Reporting it as `on-request`
    // because that is the closest word would put a posture on the panel that
    // nobody selected.
    const reading = readThreadSettings(
      recordedSettingsFrame({
        approvalPolicy: {
          granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
        },
      })
    );
    expect(reading.approvalPolicy).toBeUndefined();
    // The other dimensions are still read: one unreadable field is not a
    // reason to discard a frame.
    expect(reading.sandboxMode).toBe('workspace-write');
  });

  it('an unmapped sandbox variant reads as absent, and its networkAccess still does not', () => {
    const reading = readThreadSettings(
      recordedSettingsFrame({
        sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
      })
    );
    expect(reading.sandboxMode).toBeUndefined();
    // `'enabled'` is not a boolean: the network dimension is a three-state fact
    // (on / off / not reported) and a non-boolean is the third state, never `true`.
    expect(reading.networkAccess).toBeUndefined();
  });

  it('a frame that reports no network dimension leaves it unset, not false', () => {
    const reading = readThreadSettings(
      recordedSettingsFrame({ sandboxPolicy: { type: 'readOnly' } })
    );
    expect(reading.sandboxMode).toBe('read-only');
    expect('networkAccess' in reading).toBe(false);
  });

  it('takes the notification params, and refuses the settings object handed to it bare', () => {
    // The unit that arrives is the frame; a reader that also accepted the inner
    // object would let a caller skip the thread-ownership check that guards it.
    const frame = recordedSettingsFrame();
    expect(readThreadSettings(frame.threadSettings)).toEqual({});
    expect(readThreadSettings(undefined)).toEqual({});
    expect(readThreadSettings({ threadSettings: null })).toEqual({});
    expect(readThreadSettings({ threadSettings: { model: '   ' } })).toEqual({});
  });

  it('never produces a Claude-shaped reading (negative control)', () => {
    const reading = readThreadSettings(
      recordedSettingsFrame({ permissionMode: 'plan', agent: CLAUDE_CODE_AGENT })
    ) as Record<string, unknown>;
    expect('permissionMode' in reading).toBe(false);
    expect('agent' in reading).toBe(false);
  });
});
