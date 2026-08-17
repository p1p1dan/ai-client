/**
 * D48 S4 §6.2 — the `thread/settings/update` parameter layer, pure and zero IO.
 *
 * This module exists because of one measured property of the server: it accepts
 * UNKNOWN FIELDS SILENTLY. A misspelled key returns `{}`, broadcasts no
 * notification and has no effect [实测 06-probes P1 严格性观察] — while a bad
 * ENUM and a missing `threadId` are both refused with `-32600`. So the failure
 * this module is built against is not "the request was rejected", it is "the
 * request was accepted and changed nothing", which is invisible at runtime and
 * invisible in any test that only checks the call returned.
 *
 * Three rules follow, and all three are structural rather than defensive:
 *
 *  1. Parameters are BUILT from named arguments against a whitelist, never
 *     spread from a caller's object. A key outside the whitelist is not
 *     expressible, so it cannot reach the wire to be swallowed (D4).
 *  2. The sandbox shape is MAPPED, never copied. `thread/start` takes `sandbox`
 *     as a kebab-case string; `turn/start` and `thread/settings/update` take
 *     `sandboxPolicy` as a camelCase discriminated object. Three call sites, two
 *     spellings [实测 06-probes §0.2] — and the wrong one is, again, silently
 *     swallowed (D5).
 *  3. `permissions` and `sandboxPolicy` are mutually exclusive ("Cannot be
 *     combined with `sandboxPolicy`", schema's own words). The server does not
 *     enforce it audibly either, so the builder refuses and emits nothing (D6).
 *
 * The reader half lives here too, next to the writer, because they are the two
 * directions of ONE mapping: the notification spells the sandbox `workspaceWrite`
 * and our own vocabulary spells it `workspace-write`, and a second copy of that
 * correspondence is how a posture reads back as a different posture than it was
 * set to.
 */

import { isSessionEffortLevel, type SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from '../shared/types/runtimeEvents.ts';
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from '../shared/types/runtimeEvents.ts';

/**
 * The camelCase discriminated object `sandboxPolicy` takes.
 *
 * Only the discriminant is modelled. The three tiers we send also declare
 * `networkAccess`, `writableRoots`, `excludeSlashTmp` and `excludeTmpdirEnvVar`
 * [实测 `fixtures/codex/codex-settings-schema.json`], and NONE of them is sent:
 * `networkAccess` is a fact this build reads and never states (see
 * `CODEX_PERMISSION_DEFAULT`'s header — the preference type structurally has no
 * such key), and the other three have no UI, no default we could defend and no
 * measured behaviour. Sending a tier bare is the same thing `thread/start` does
 * with its string form, so the server's own default for the tier applies in both
 * places rather than in one.
 */
export interface CodexSandboxPolicy {
  type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' | 'externalSandbox';
}

/**
 * The mapping, written once, in the direction we SEND.
 *
 * `externalSandbox` has no counterpart in `CodexSandboxMode` and deliberately
 * gets none: `thread/start`'s `SandboxMode` enum is three-wide [实测], so a
 * fourth tier here could only ever be produced by inventing one, and it would be
 * a tier this build cannot ask for on create and cannot verify on resume.
 */
const SANDBOX_POLICY_BY_MODE: Readonly<Record<CodexSandboxMode, CodexSandboxPolicy['type']>> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
};

/** `CodexSandboxMode` (our vocabulary, `thread/start`'s) → the object form. */
export function toSandboxPolicy(mode: CodexSandboxMode): CodexSandboxPolicy {
  return { type: SANDBOX_POLICY_BY_MODE[mode] };
}

/**
 * The same mapping read backwards, for the notification.
 *
 * Derived from the table above rather than written out a second time: two hand
 * written tables are two chances for `workspaceWrite` to come back as
 * `read-only`, and that particular disagreement would report a session as more
 * constrained than it is.
 */
export function fromSandboxPolicyType(type: unknown): CodexSandboxMode | undefined {
  if (typeof type !== 'string') return undefined;
  for (const mode of CODEX_SANDBOX_MODES) {
    if (SANDBOX_POLICY_BY_MODE[mode] === type) return mode;
  }
  return undefined;
}

/**
 * Every key this build is allowed to put in a `thread/settings/update` frame.
 *
 * `ThreadSettingsUpdateParams` declares thirteen [实测 codex-settings-schema.json];
 * these four are the ones with a real source in this app. The rest (`cwd`,
 * `personality`, `serviceTier`, `summary`, `collaborationMode`,
 * `approvalsReviewer`, `multiAgentMode`, `permissions`) have no UI and no
 * measured behaviour here, and "send it and see" is not available on a server
 * that answers unknown and unsupported input the same way it answers correct
 * input.
 *
 * `model` and `effort` are on the list but NOT sent by the permission path — S2
 * puts them on `turn/start`, which is sticky and therefore already the thread
 * default [实测 06-probes P1]. They are listed so the whitelist describes the
 * channel rather than one caller of it, and the builder still requires each
 * value to be passed explicitly.
 */
export const THREAD_SETTINGS_UPDATE_KEYS = [
  'threadId',
  'approvalPolicy',
  'sandboxPolicy',
  'model',
  'effort',
] as const;

export type ThreadSettingsUpdateKey = (typeof THREAD_SETTINGS_UPDATE_KEYS)[number];

/**
 * A built frame. Typed as an exact optional record over the whitelist, so a key
 * outside it is a compile error at the construction site rather than a silently
 * ignored field on the wire.
 */
export interface CodexThreadSettingsUpdateParams {
  threadId: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxPolicy?: CodexSandboxPolicy;
  model?: string;
  effort?: SessionEffortLevel;
}

export type ThreadSettingsUpdateBuild =
  | { ok: true; params: CodexThreadSettingsUpdateParams; changed: ThreadSettingsUpdateKey[] }
  | { ok: false; reason: string };

/**
 * Build one frame from named values — omitting everything the caller did not
 * name.
 *
 * ## Omission is the whole protocol here
 *
 * Every field but `threadId` is nullable, and the schema's own wording makes the
 * three states distinct: absent = unchanged, explicit `null` = cleared, a value =
 * set [实测 06-probes §0.2, `serviceTier`'s description]. So a caller that
 * "re-sends everything to be safe" would pin fields it has no truth for — the
 * thread's `cwd`, its personality, its service tier — to whatever the UI last
 * happened to think. This builder emits a key ONLY when it was given one, and
 * `changed` reports which, so the caller can assert on the frame it produced
 * rather than on the frame it intended.
 *
 * ## `permissions` is refused rather than modelled
 *
 * Named permission profiles are out of scope for D48 (§9.1), but the exclusivity
 * rule is not: the server silently swallows the conflict, so if this build ever
 * grows a profile picker the failure would be a posture that looks applied and
 * is not. Taking the argument and refusing it makes the rule enforceable NOW,
 * one release before anything can violate it — and `ok: false` means no frame is
 * written at all, not a frame with one of the two dropped.
 */
export function buildThreadSettingsUpdateParams(input: {
  threadId: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  model?: string;
  effort?: SessionEffortLevel;
  /** Out of scope (§9.1); present so the exclusivity guard has something to guard. */
  permissions?: string;
}): ThreadSettingsUpdateBuild {
  const threadId = input.threadId.trim();
  if (!threadId) {
    // The one REQUIRED field. Missing it is a `-32600` [实测 06-probes P1], i.e.
    // the server would catch this one — refusing locally still beats a round
    // trip that can only fail.
    return { ok: false, reason: 'thread/settings/update requires a threadId' };
  }
  if (input.permissions !== undefined && input.sandboxMode !== undefined) {
    return {
      ok: false,
      reason:
        'thread/settings/update cannot carry `permissions` and `sandboxPolicy` in one request ' +
        '(the schema forbids the combination and the server accepts it silently)',
    };
  }
  if (input.permissions !== undefined) {
    return {
      ok: false,
      reason: 'named permission profiles are not implemented in this build (D48 §9.1)',
    };
  }

  const params: CodexThreadSettingsUpdateParams = { threadId };
  const changed: ThreadSettingsUpdateKey[] = [];
  if (input.approvalPolicy !== undefined) {
    params.approvalPolicy = input.approvalPolicy;
    changed.push('approvalPolicy');
  }
  if (input.sandboxMode !== undefined) {
    params.sandboxPolicy = toSandboxPolicy(input.sandboxMode);
    changed.push('sandboxPolicy');
  }
  const model = input.model?.trim();
  if (model) {
    params.model = model;
    changed.push('model');
  }
  if (input.effort !== undefined) {
    params.effort = input.effort;
    changed.push('effort');
  }
  return { ok: true, params, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What ONE `thread/settings/updated` frame told us.
 *
 * Every field is optional and present only when the frame carried a value this
 * build can name. That is not politeness: `approvalPolicy` also has an object
 * (`granular`) form [实测 codex-settings-schema.json] which this build does not
 * model, and folding an unmodelled shape into one of the three strings would
 * report a posture nobody selected. Unreadable means absent, and absent means
 * the previous reading stands.
 */
export interface CodexThreadSettingsReading {
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  /** Sub-field of the sandbox object; the only place this dimension is ever learned. */
  networkAccess?: boolean;
  model?: string;
  effort?: SessionEffortLevel;
}

/**
 * `thread/settings/updated` params → a reading.
 *
 * Takes the NOTIFICATION params (`{threadId, threadSettings}`), not the settings
 * object, so the one caller cannot pass the wrong half — the frame is the unit
 * that arrives and the unit that is checked for thread ownership.
 */
export function readThreadSettings(params: unknown): CodexThreadSettingsReading {
  const settings = isRecord(params) ? params.threadSettings : undefined;
  if (!isRecord(settings)) return {};

  const reading: CodexThreadSettingsReading = {};

  if ((CODEX_APPROVAL_POLICIES as readonly unknown[]).includes(settings.approvalPolicy)) {
    reading.approvalPolicy = settings.approvalPolicy as CodexApprovalPolicy;
  }

  const sandbox = settings.sandboxPolicy;
  if (isRecord(sandbox)) {
    const mode = fromSandboxPolicyType(sandbox.type);
    if (mode) reading.sandboxMode = mode;
    if (typeof sandbox.networkAccess === 'boolean') reading.networkAccess = sandbox.networkAccess;
  }

  const model = typeof settings.model === 'string' ? settings.model.trim() : '';
  if (model) reading.model = model;
  if (isSessionEffortLevel(settings.effort)) reading.effort = settings.effort;

  return reading;
}
