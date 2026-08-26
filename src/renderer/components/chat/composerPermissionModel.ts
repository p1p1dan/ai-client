/**
 * D48 S4 §6.3 — the Composer's LIVE permission control, as a pure model.
 *
 * ## The two layers, and which one this is
 *
 * Settings' "Chat agent defaults" (S3) is the TEMPLATE layer: where a NEW chat
 * starts. This is the LIVE layer: what THIS chat runs under from here on. They
 * offer the same tiers from the same table (`@shared/models/permissionTiers`)
 * and they route through the same dangerous-tier gate, and they touch different
 * storage on purpose — a mid-session change updates this session's snapshot and
 * leaves the template byte-identical (D11). Turning one chat up must not turn
 * every future chat up; that is the silent-privilege-expansion path R18 names.
 *
 * ## Its gate is NOT the agent picker's
 *
 * `agentBindingLocked` does not appear in this file and must not (D13). An
 * agent binds on the first send and is then fixed for the life of the chat
 * (changing it means starting another chat); a permission tier is the opposite —
 * changing it mid-conversation IS the requirement (§8.0-Q1). Reusing the lock
 * here would implement the feature away. The gate is `busy || sending`, the Host
 * being ready, and a request not already in flight.
 *
 * ## What the chip DISPLAYS is the echo, never the request
 *
 * The value shown is derived from the runtime facts — `session.created` /
 * `session.resumed` on the Claude axis, `session.settingsEcho` (one mapping of
 * codex's `thread/settings/updated`) on the Codex axis. Never from what was just
 * sent: codex answers `thread/settings/update` with an EMPTY body [实测
 * 06-probes P3], so "the call returned" is not "the thread runs under it", and a
 * control that painted the request would report a posture on the strength of a
 * response that says nothing (D7). A change that has been accepted but is not
 * yet in the facts is shown as an explicit pending marker beside the current
 * tier — labelled, never substituted.
 *
 * Consequence worth stating: with no echo there is no control. A draft that has
 * never been sent has no posture to change (its starting tier comes from the
 * template, resolved at first send), and rendering a control over nothing would
 * offer a change the Host would refuse for want of a session.
 *
 * Pure (no React, no store, no IPC) — on `pureModuleImports`'s target list, and
 * every branch below is truth-tabled under the node-env vitest that can never
 * render the `.tsx` beside it.
 */

import {
  CLAUDE_PERMISSION_TIERS,
  CODEX_APPROVAL_TIERS,
  CODEX_SANDBOX_TIERS,
  type PermissionTierOption,
  permissionTierLabel,
} from '@shared/models/permissionTiers';
import { type AgentWireName, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexApprovalPolicy,
  type CodexPermissionPreference,
  type CodexSandboxMode,
  isDangerousPermissionPreference,
  type PermissionUpdateEffective,
  SESSION_PERMISSION_MODES,
  type SessionPermissionMode,
  type SessionPermissionPolicy,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import type { HostStatus } from './hostStatus';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The two axes get two sentences, and they are deliberately NOT interchangeable
 * (§6.3 / D2).
 *
 * Claude's tier is a `query()` option and every send opens a new `query()`
 * [实测 06-probes P2], so a change lands on the NEXT turn and the turn already
 * in flight keeps the tier it started with. Codex's `thread/settings/update` is
 * zero-turn and the open thread takes it right away [实测 06-probes P3].
 * Softening Claude's wording into "immediately" would tell a user their session
 * is restricted at a moment it is not — which is the one direction a permission
 * control must never be wrong in.
 */
export const PERMISSION_SCOPE_HINT_CLAUDE =
  'Applies from your next message — a turn already running keeps the tier it started with.';
export const PERMISSION_SCOPE_HINT_CODEX = 'Applies immediately, to this thread.';

/**
 * The draft's sentence, and it is a third one on purpose.
 *
 * Neither of the two above is true before a chat starts: nothing is "already
 * running" to keep a tier, and nothing applies "immediately" because there is no
 * thread. What a draft change actually does is decide what the FIRST message
 * opens under — and, just as importantly, what it does not do is touch the
 * default for other chats, which is the only way to say this before the draft
 * control existed (change the template, change everything).
 */
export const PERMISSION_SCOPE_HINT_DRAFT =
  'Applies when you send the first message in this chat. The default for new chats is untouched.';

export function permissionScopeHint(agent: AgentWireName, draft = false): string {
  if (draft) return PERMISSION_SCOPE_HINT_DRAFT;
  return agent === CODEX_AGENT ? PERMISSION_SCOPE_HINT_CODEX : PERMISSION_SCOPE_HINT_CLAUDE;
}

/**
 * What the chip reads when a draft has neither a pick nor a template.
 *
 * A real state, and deliberately not a synthesized tier: the runtime's own
 * constant lives in `agent-host`, a separate program this bundle cannot import,
 * and inventing a second copy of it here is exactly the drift
 * `RUNTIME_DEFAULT_OPTION` was introduced to avoid on the settings side. The
 * chip says "whatever the runtime starts with" because that is all this side
 * honestly knows.
 */
export const PERMISSION_RUNTIME_DEFAULT_LABEL = 'Default';

/**
 * The live layer's permanent warning — present whether or not a dangerous tier
 * is currently selected, for the same reason the template layer's is.
 *
 * It is a DIFFERENT sentence from the template layer's, because it describes a
 * different blast radius: that one is about every chat started from here on,
 * this one is about the chat in front of you, which already has a workspace, a
 * transcript and a task in progress. Sharing one sentence would make one of the
 * two wrong.
 */
export const LIVE_DANGEROUS_TIER_WARNING =
  'Bypass permissions and danger-full-access remove the approval and sandbox limits on THIS chat. From the moment they apply, the agent can read and change anything this machine can, with no prompt to stop it.';

export const LIVE_DANGEROUS_CONFIRM_TITLE = 'Remove the limits on this chat?';
export const LIVE_DANGEROUS_CONFIRM_BODY =
  'This tier has not been applied. Confirm to run this chat without approval prompts or a sandbox; cancel to stay on the current tier. Only this chat changes — the default for new chats is untouched.';

/** Inline failure copy. A refused change leaves the chat on the tier it had. */
export const PERMISSION_UPDATE_FAILED_TITLE = 'Permission tier unchanged';

/** Menu section headings — the same words the Settings cards use for the rows. */
export const PERMISSION_SECTION_LABELS = {
  permissionMode: 'Permission mode',
  approvalPolicy: 'Approval policy',
  sandboxMode: 'Sandbox mode',
} as const;

/**
 * Every remaining string this control can put on screen, as a translation KEY —
 * including the ones that read like a sentence assembled at runtime.
 *
 * This module is pure and knows nothing about the locale, so it cannot compose
 * "Permission tier: Plan — applies from your next message" itself: a string
 * concatenated here would arrive at the DOM already in English, and `t()` cannot
 * translate a sentence whose halves were glued together before it saw them. That
 * is precisely how a Chinese menu ends up with an English tooltip beside it. So
 * the view hands the component a TEMPLATE key plus its parts, and the component
 * runs both through `t()` (asserted: every string the trigger renders comes from
 * a `t()` call).
 *
 * The four disabled reasons are whole sentences rather than templates because
 * they have no moving parts, and the tier labels are keys of their own from
 * `@shared/models/permissionTiers` — the codex ones deliberately stay untouched
 * in every locale (`on-request`, `danger-full-access` … are protocol tokens the
 * user will also read in codex's own output; translating them would invent a
 * second vocabulary for one thing).
 */
export const PERMISSION_DISABLED_NO_TARGET = 'This chat has nowhere to run right now.';
export const PERMISSION_DISABLED_HOST_NOT_READY = 'The Agent Host is not ready.';
export const PERMISSION_DISABLED_TURN_RUNNING =
  'A turn is running — the tier is fixed for the turn already in flight.';
export const PERMISSION_DISABLED_IN_FLIGHT = 'A permission change is already on its way.';

/** `{{tier}}` = the composed tier label; the applying form names no tier at all. */
export const PERMISSION_PENDING_APPLYING = 'applying…';
export const PERMISSION_PENDING_NEXT_TURN = '{{tier}} from your next message';
export const PERMISSION_PENDING_IMMEDIATE = '{{tier}} pending';

export const PERMISSION_TITLE_ENABLED = 'Permissions: {{tier}} — click to change ({{scope}})';
export const PERMISSION_TITLE_DISABLED = 'Permissions: {{tier}} — {{reason}}';
export const PERMISSION_SPOKEN = 'Permission tier: {{tier}} — {{scope}}';
export const PERMISSION_SPOKEN_PENDING = 'Permission tier: {{tier}} ({{pending}}) — {{scope}}';

// ---------------------------------------------------------------------------
// Echo projection: runtime facts → the tier this session is actually on
// ---------------------------------------------------------------------------

/** The slice of `SessionRuntimeFacts` this control reads. Structural, not imported. */
export interface ComposerPermissionFacts {
  permissionMode?: SessionPermissionMode;
  permissionPolicy?: SessionPermissionPolicy;
}

/**
 * Facts → the preference-shaped value the control shows and edits.
 *
 * Preference-shaped rather than policy-shaped on purpose: `networkAccess` is
 * part of the FACT and has no place in a request (§5.7-C8), so projecting into
 * the request type is what structurally prevents the control from ever offering
 * it. The projection is per agent because the two axes echo on different
 * carriers — Claude on the legacy `permissionMode` (S3 left that path
 * byte-unchanged), Codex on `permissionPolicy`.
 *
 * `undefined` = this session has not reported a posture this build can name.
 * That is a real state (a Host that predates the field, a resume whose posture
 * verification failed and therefore broadcast nothing) and it is the state in
 * which no control is offered — there is nothing to show and nothing to change
 * from.
 */
export function projectEchoedPreference(
  agent: AgentWireName,
  facts: ComposerPermissionFacts | undefined
): SessionPermissionPreference | undefined {
  if (!facts) return undefined;
  const policy = facts.permissionPolicy;
  // Narrowed by KEY throughout, not by the `agent` discriminant: the exported
  // agent constants are typed as the wide `AgentWireName` (they have exactly one
  // home and this file is not it), and a wide comparison cannot narrow a
  // discriminated union. Same spelling the shared guards use.
  if (agent === CODEX_AGENT) {
    // Only the codex arm can describe a codex session. A Claude-armed policy on
    // a codex session is a Host bug, and rendering it would put a Claude tier on
    // a runtime that has no such concept.
    if (!policy || 'permissionMode' in policy) return undefined;
    return {
      agent: CODEX_AGENT,
      approvalPolicy: policy.approvalPolicy,
      sandboxMode: policy.sandboxMode,
    } as CodexPermissionPreference;
  }
  // `networkAccess` is dropped here and can never come back: the projection
  // targets the REQUEST type, whose codex arm structurally has no such key
  // (§5.7-C8). A dimension the runtime only reports cannot become a dimension
  // the control appears to set.
  const mode = policy && 'permissionMode' in policy ? policy.permissionMode : facts.permissionMode;
  return mode
    ? ({ agent: CLAUDE_CODE_AGENT, permissionMode: mode } as SessionPermissionPreference)
    : undefined;
}

/** Value equality over the request union — used to tell "the echo caught up" from "it has not". */
export function samePermissionPreference(
  a: SessionPermissionPreference | undefined,
  b: SessionPermissionPreference | undefined
): boolean {
  if (!a || !b) return a === b;
  if ('permissionMode' in a) {
    return 'permissionMode' in b && a.permissionMode === b.permissionMode;
  }
  return (
    !('permissionMode' in b) &&
    a.approvalPolicy === b.approvalPolicy &&
    a.sandboxMode === b.sandboxMode
  );
}

// ---------------------------------------------------------------------------
// The change gate
// ---------------------------------------------------------------------------

/**
 * The gate between "the user moved a radio item" and "an IPC is sent".
 *
 * `'apply'` sends now. `'confirm'` sends NOTHING — the caller holds the value
 * aside and only sends it if the confirmation comes back positive, with
 * `dangerousConfirmed: true`. There is no third state, and a cancel writes
 * nothing at all: the chip's value is derived from the runtime facts rather than
 * from local state, so it is already showing the tier the session is on and has
 * nothing to snap back from (D12).
 *
 * Structurally identical to the template layer's `decidePermissionTemplateAction`
 * and asserted to agree with it tier for tier. It is a separate function rather
 * than an import because this module is on the purity scan's target list, which
 * forbids reaching into `@/components/settings` at all — and because the live
 * layer has no "runtime default" sentinel to model: a running session is already
 * running under something, and there is no request that means "un-choose".
 */
export type LivePermissionAction =
  | { kind: 'apply'; preference: SessionPermissionPreference }
  | { kind: 'confirm'; preference: SessionPermissionPreference };

export function decideLivePermissionAction(
  preference: SessionPermissionPreference
): LivePermissionAction {
  return isDangerousPermissionPreference(preference)
    ? { kind: 'confirm', preference }
    : { kind: 'apply', preference };
}

/**
 * Current tier + one menu pick → the tier to request. `undefined` = refuse.
 *
 * The companion dimension of a codex pair comes from the CURRENT tier, which is
 * the echo, i.e. what the thread is running right now — not from a constant this
 * layer invented. That has a consequence worth stating out loud: changing the
 * approval policy of a chat that is already on `danger-full-access` produces a
 * dangerous preference, and therefore asks for confirmation again. That is the
 * intended reading — the gate looks at the posture being requested, not at which
 * dimension the finger moved.
 *
 * An unrecognized value is refused rather than coerced: the only way to get one
 * is a build mismatch, and quietly substituting a tier is how a user ends up
 * believing they restricted a chat they did not.
 */
export function nextLivePreference(
  current: SessionPermissionPreference,
  patch: { permissionMode?: string; approvalPolicy?: string; sandboxMode?: string }
): SessionPermissionPreference | undefined {
  if ('permissionMode' in current) {
    if (patch.approvalPolicy !== undefined || patch.sandboxMode !== undefined) return undefined;
    const mode = patch.permissionMode;
    return mode !== undefined && (SESSION_PERMISSION_MODES as readonly string[]).includes(mode)
      ? ({
          agent: CLAUDE_CODE_AGENT,
          permissionMode: mode as SessionPermissionMode,
        } as SessionPermissionPreference)
      : undefined;
  }
  if (patch.permissionMode !== undefined) return undefined;
  let approvalPolicy: CodexApprovalPolicy = current.approvalPolicy;
  let sandboxMode: CodexSandboxMode = current.sandboxMode;
  if (patch.approvalPolicy !== undefined) {
    if (!(CODEX_APPROVAL_POLICIES as readonly string[]).includes(patch.approvalPolicy)) {
      return undefined;
    }
    approvalPolicy = patch.approvalPolicy as CodexApprovalPolicy;
  }
  if (patch.sandboxMode !== undefined) {
    if (!(CODEX_SANDBOX_MODES as readonly string[]).includes(patch.sandboxMode)) return undefined;
    sandboxMode = patch.sandboxMode as CodexSandboxMode;
  }
  return { agent: CODEX_AGENT, approvalPolicy, sandboxMode } as CodexPermissionPreference;
}

/**
 * §5.4-4 / D12 as data rather than as a review habit: every value this layer can
 * produce WITHOUT an explicit user pick. The assertion walks the list and
 * requires each entry to be non-dangerous.
 *
 * They are all `undefined`, and that is the point: the live layer has no
 * defaults to get wrong. It never invents a tier — with no echo it renders
 * nothing, with an unreadable pick it refuses, and a cancelled confirmation
 * leaves the chip showing the runtime's own fact. An edit that introduced a
 * fallback tier here would have to add an entry, and the assertion would meet it.
 */
export const NON_USER_CHOSEN_LIVE_ARMS: ReadonlyArray<{
  arm: string;
  preference: SessionPermissionPreference | undefined;
}> = [
  { arm: 'no echo yet — the control is not rendered at all', preference: undefined },
  {
    arm: 'claude menu → unrecognized value',
    preference: nextLivePreference(
      { agent: CLAUDE_CODE_AGENT, permissionMode: 'default' } as SessionPermissionPreference,
      { permissionMode: 'totally-unknown' }
    ),
  },
  {
    arm: 'codex menu → unrecognized approval value',
    preference: nextLivePreference(
      {
        agent: CODEX_AGENT,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
      } as CodexPermissionPreference,
      { approvalPolicy: 'totally-unknown' }
    ),
  },
  {
    arm: 'codex menu → unrecognized sandbox value',
    preference: nextLivePreference(
      {
        agent: CODEX_AGENT,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
      } as CodexPermissionPreference,
      { sandboxMode: 'totally-unknown' }
    ),
  },
  {
    arm: 'cross-arm patch (a codex pick routed at a claude session)',
    preference: nextLivePreference(
      { agent: CLAUDE_CODE_AGENT, permissionMode: 'default' } as SessionPermissionPreference,
      { sandboxMode: 'danger-full-access' }
    ),
  },
];

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

/** An accepted-but-not-yet-echoed change. Keyed by session: one chip serves them all. */
export interface PendingPermissionChange {
  sessionId: string;
  preference: SessionPermissionPreference;
  effective: PermissionUpdateEffective;
}

export interface ComposerPermissionMenuItem {
  id: string;
  label: string;
  description: string;
  dangerous: boolean;
  selected: boolean;
}

export interface ComposerPermissionMenuSection {
  id: keyof typeof PERMISSION_SECTION_LABELS;
  label: string;
  items: readonly ComposerPermissionMenuItem[];
}

export interface ComposerPermissionInput {
  sessionId: string;
  /** `sessionAgent(session)` — the same value the picker and the model trigger read. */
  agent: AgentWireName;
  /** `hostStatus.capabilities?.permissionPolicy` — `undefined` = a Host that predates S3. */
  capabilityPermissionPolicy: boolean | undefined;
  hostState: HostStatus['state'];
  facts: ComposerPermissionFacts | undefined;
  pending: PendingPermissionChange | null;
  /** An IPC is out and no answer has come back. */
  inFlight: boolean;
  busy: boolean;
  sending: boolean;
  /** The composer's own "there is nowhere to put this" kill switch. */
  disabled: boolean;
  /**
   * The zero-turn draft's own posture: what the user picked for THIS chat before
   * it had a runtime, falling back to the agent template. `undefined` means
   * neither exists, which is a real state — the chat will start on the runtime's
   * own constant, a value this side deliberately does not know.
   *
   * Only consulted when there is NO echo. Once the runtime has spoken, its facts
   * are the posture and this is stale by definition.
   */
  draftPreference?: SessionPermissionPreference | undefined;
}

/**
 * An accepted-but-unechoed change, as the chip's suffix: a template key and the
 * tier keys that fill it. `tierKeys` is empty for `applying…`, which names none.
 */
export interface ComposerPermissionPendingLabel {
  template: string;
  tierKeys: readonly string[];
}

export interface ComposerPermissionView {
  rendered: boolean;
  /** Why not, when `rendered` is false — for assertions, not for the UI. */
  hiddenReason: 'capability_absent' | 'no_echo' | null;
  /**
   * The control is standing in for a chat that has not started: a change is
   * recorded locally and materialised by the first send, NOT sent to a Host.
   *
   * The caller branches its handler on this. It also changes what the chip is
   * claiming — "this is what the runtime says" versus "this is what it will
   * start under" — which is why `scopeHint` differs too.
   */
  draft: boolean;
  /** The tier the runtime says this session is on. Absent whenever `rendered` is false. */
  current: SessionPermissionPreference | null;
  disabled: boolean;
  /** A whole-sentence translation key, or `null` when the control is usable. */
  disabledReason: string | null;
  /** The tier the chip shows — the ECHO, never the request — as translation keys. */
  labelKeys: readonly string[];
  /** Set only while an accepted change has not reached the facts. Beside the label, never instead of it. */
  pendingLabel: ComposerPermissionPendingLabel | null;
  dangerousActive: boolean;
  scopeHint: string;
  /** Template keys; the component fills `{{tier}}` / `{{scope}}` / `{{reason}}` / `{{pending}}`. */
  titleTemplate: string;
  spokenTemplate: string;
  sections: readonly ComposerPermissionMenuSection[];
}

function tierItems<T extends string>(
  tiers: ReadonlyArray<PermissionTierOption<T>>,
  selected: string
): ComposerPermissionMenuItem[] {
  return tiers.map((tier) => ({
    id: tier.value,
    label: tier.label,
    description: tier.description,
    dangerous: tier.dangerous,
    selected: tier.value === selected,
  }));
}

/**
 * The chip's own text, as KEYS: one tier on Claude, the pair on Codex.
 *
 * A list rather than a joined string, so the caller translates each part and
 * joins the results. Joining first would freeze the English labels into the
 * chip — see `PERMISSION_TITLE_ENABLED`'s header.
 */
export const PERMISSION_TIER_JOINER = ' · ';

export function permissionTierLabelKeys(
  preference: SessionPermissionPreference
): readonly string[] {
  return 'permissionMode' in preference
    ? [permissionTierLabel(CLAUDE_PERMISSION_TIERS, preference.permissionMode)]
    : [
        permissionTierLabel(CODEX_APPROVAL_TIERS, preference.approvalPolicy),
        permissionTierLabel(CODEX_SANDBOX_TIERS, preference.sandboxMode),
      ];
}

/**
 * Has the echo caught up with the change we were told was accepted?
 *
 * The caller drops its pending marker when this goes true. It compares against
 * the FACTS, so on the Codex axis it flips when `thread/settings/updated`
 * arrives and on the Claude axis when the next turn's `session.created` /
 * `session.resumed` restates the tier — in both cases on evidence from the
 * runtime, never on the reply to our own request.
 */
export function permissionChangeSettled(
  agent: AgentWireName,
  facts: ComposerPermissionFacts | undefined,
  pending: PendingPermissionChange | null
): boolean {
  if (!pending) return false;
  return samePermissionPreference(projectEchoedPreference(agent, facts), pending.preference);
}

export function deriveComposerPermission(input: ComposerPermissionInput): ComposerPermissionView {
  const hidden = (
    hiddenReason: ComposerPermissionView['hiddenReason']
  ): ComposerPermissionView => ({
    rendered: false,
    hiddenReason,
    current: null,
    disabled: true,
    disabledReason: null,
    labelKeys: [],
    pendingLabel: null,
    dangerousActive: false,
    draft: false,
    scopeHint: permissionScopeHint(input.agent),
    titleTemplate: '',
    spokenTemplate: '',
    sections: [],
  });

  // D15: an old Host does not have the command at all, so the control is not
  // rendered — not rendered-and-disabled. A disabled control says "this exists
  // and is unavailable right now"; the honest statement here is that this build
  // of the Host cannot do it, and a permanently dead chip in the toolbar is the
  // "control for a capability we do not have" that `composerModel.ts` calls a
  // lie about the product. (Not in tension with the agent picker's greyed-out
  // Codex segment: that capability EXISTS and is unavailable today.)
  if (input.capabilityPermissionPolicy !== true) return hidden('capability_absent');

  /**
   * Two layers, in one order: the runtime's echo, then the draft's own intent.
   *
   * The echo wins whenever it exists, and that is the whole safety argument —
   * once a chat is running, what the chip claims is what the Host said, never
   * what someone typed into a draft that has since been sent (a stale intent
   * outranking a mid-session change is the silent-privilege swap R18 names).
   *
   * The draft layer exists because "no echo" used to mean "no control", and the
   * consequence was that a chat could only START under the per-agent template:
   * to open one chat under bypass you had to change what EVERY future chat opens
   * under, or send a turn under the wrong posture and switch afterwards. Neither
   * is a thing to ask of someone.
   */
  const echoed = projectEchoedPreference(input.agent, input.facts);
  const draft = !echoed;
  const current = echoed ?? input.draftPreference ?? null;

  // A draft with no pick and no template is still a control worth rendering: the
  // chat starts on the runtime's own constant, and the user's whole reason for
  // opening this menu is to choose something else. `current === null` there is
  // read as the runtime-default sentinel, not as "nothing to show".
  if (!draft && !current) return hidden('no_echo');

  const labelKeys = current ? permissionTierLabelKeys(current) : [PERMISSION_RUNTIME_DEFAULT_LABEL];
  const scopeHint = permissionScopeHint(input.agent, draft);

  // Order matters only in that the FIRST true reason is the one shown, and the
  // running turn is the one a user is most likely to be looking at.
  let disabledReason: string | null = null;
  if (input.disabled) {
    disabledReason = PERMISSION_DISABLED_NO_TARGET;
  } else if (input.hostState !== 'ready') {
    disabledReason = PERMISSION_DISABLED_HOST_NOT_READY;
  } else if (input.busy || input.sending) {
    // 实测 06-probes P3: an update sent 1ms after `turn/start` landed behind
    // that turn's context — "I changed it and this turn ignored me". The runtime
    // refuses too; this is the courtesy half.
    disabledReason = PERMISSION_DISABLED_TURN_RUNNING;
  } else if (input.inFlight) {
    disabledReason = PERMISSION_DISABLED_IN_FLIGHT;
  }

  const pending =
    input.pending && input.pending.sessionId === input.sessionId ? input.pending : null;
  const pendingUnsettled =
    pending && !samePermissionPreference(current ?? undefined, pending.preference) ? pending : null;
  const pendingLabel: ComposerPermissionPendingLabel | null = input.inFlight
    ? { template: PERMISSION_PENDING_APPLYING, tierKeys: [] }
    : pendingUnsettled
      ? {
          template:
            pendingUnsettled.effective === 'next_turn'
              ? PERMISSION_PENDING_NEXT_TURN
              : PERMISSION_PENDING_IMMEDIATE,
          tierKeys: permissionTierLabelKeys(pendingUnsettled.preference),
        }
      : null;

  // With no current posture (a draft on the runtime constant) nothing is
  // selected — the menu still offers every tier, it just does not claim one of
  // them is in force. `''` matches no tier value, which is exactly the intent.
  const claudeSelected = current && 'permissionMode' in current ? current.permissionMode : '';
  const codexSelected =
    current && 'approvalPolicy' in current
      ? { approvalPolicy: current.approvalPolicy, sandboxMode: current.sandboxMode }
      : { approvalPolicy: '', sandboxMode: '' };
  const sections: ComposerPermissionMenuSection[] =
    input.agent === CODEX_AGENT
      ? [
          {
            id: 'approvalPolicy',
            label: PERMISSION_SECTION_LABELS.approvalPolicy,
            items: tierItems(CODEX_APPROVAL_TIERS, codexSelected.approvalPolicy),
          },
          {
            id: 'sandboxMode',
            label: PERMISSION_SECTION_LABELS.sandboxMode,
            items: tierItems(CODEX_SANDBOX_TIERS, codexSelected.sandboxMode),
          },
        ]
      : [
          {
            id: 'permissionMode',
            label: PERMISSION_SECTION_LABELS.permissionMode,
            items: tierItems(CLAUDE_PERMISSION_TIERS, claudeSelected),
          },
        ];

  return {
    rendered: true,
    hiddenReason: null,
    current,
    draft,
    disabled: disabledReason !== null,
    disabledReason,
    labelKeys,
    pendingLabel,
    // Widened to the ACCEPTED-but-unechoed tier as well, and only this bit is.
    //
    // Not an optimistic write, and the distinction is the whole point: `label`
    // still states only what the runtime reported, so the chip never claims a
    // tier is in force before it is (D7). This flag answers a different
    // question — "is a dangerous tier in play on this chat" — and from the
    // moment the runtime ACCEPTED one, the honest answer is yes. Leaving it on
    // the echo alone would paint the chip in its calm colour through the entire
    // window between the confirmation and the echo, and on the Claude axis that
    // window is at least a full turn. Under-reporting danger is the one
    // direction this control must never be wrong in.
    dangerousActive:
      isDangerousPermissionPreference(current ?? undefined) ||
      isDangerousPermissionPreference(pendingUnsettled?.preference),
    scopeHint,
    titleTemplate: disabledReason ? PERMISSION_TITLE_DISABLED : PERMISSION_TITLE_ENABLED,
    spokenTemplate: pendingLabel ? PERMISSION_SPOKEN_PENDING : PERMISSION_SPOKEN,
    sections,
  };
}
