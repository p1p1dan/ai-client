/**
 * D48 S3 §5.4 — the pure model behind Settings' "Chat agent defaults"
 * permission cards.
 *
 * ## What this layer is, and what it deliberately is not
 *
 * It is the TEMPLATE layer: the tier a NEW draft starts from. It is not the
 * live posture of any session — that one is captured into the session snapshot
 * at first send and replayed on resume, so editing a template here can never
 * reach back into a chat that already ran (§5.5-2). Nothing in this module
 * touches a session, and nothing in it may import `window.electronAPI`: a
 * settings edit that mutated a running session is exactly the failure C12
 * pins, and keeping the module free of that import is what makes the
 * assertion structural rather than a promise.
 *
 * Split out of the component for the usual reason in this repo: the node-env
 * vitest cannot render React, so every rule that matters has to live in a
 * function a test can call.
 *
 * ## The two dangerous tiers
 *
 * `bypassPermissions` and `danger-full-access` are SELECTABLE (§8.0-Q3: not
 * offering them is deciding for the user, and the tool they are switching from
 * offers them). The five hard rules that come with that decision are:
 * a control, a permanent warning, a second confirmation, never a default —
 * and, on the Claude side, the SDK's own extra key, which the Host owns.
 * This module implements the middle three; `runtimeEvents.ts`'s
 * `isDangerousPermissionPreference` is the one table all of them read.
 */

import { agentDefaultPermission, type ChatAgentDefaults } from '@shared/models/chatAgentDefaults';
import {
  CLAUDE_PERMISSION_TIERS,
  CODEX_APPROVAL_TIERS,
  CODEX_SANDBOX_TIERS,
  MOST_RESTRICTIVE_APPROVAL,
  MOST_RESTRICTIVE_SANDBOX,
  type PermissionTierOption,
} from '@shared/models/permissionTiers';
import { type AgentWireName, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import {
  type ClaudePermissionPreference,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexApprovalPolicy,
  type CodexPermissionPreference,
  type CodexSandboxMode,
  isDangerousPermissionPreference,
  SESSION_PERMISSION_MODES,
  type SessionPermissionMode,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';

/**
 * The sentinel a Select carries for "no template — let the runtime's own safe
 * constant apply". It is a real, selectable choice and NOT a synthesized
 * posture: the renderer deliberately does not know the value of
 * `CHAT_PERMISSION_MODE` / `CODEX_PERMISSION_DEFAULT`, so a second copy of
 * either cannot drift from the Host's.
 */
export const RUNTIME_DEFAULT_OPTION = '__runtime_default__';

/**
 * The tier vocabulary is `@shared/models/permissionTiers`'s, not this file's.
 *
 * D48 S4 added the LIVE layer (the Composer chip), and the two layers have to
 * agree tier for tier — including which two are dangerous (§5.4 "模板层与实时
 * 层逐条同口径"). They agree because they read one table, not because two
 * tables were kept in step. The names are re-exported under this module's
 * original spellings so the S3 panel and its truth tables keep importing from
 * where they always did.
 */
export type PermissionOption<T extends string> = PermissionTierOption<T>;
export const CLAUDE_PERMISSION_OPTIONS = CLAUDE_PERMISSION_TIERS;
export const CODEX_APPROVAL_OPTIONS = CODEX_APPROVAL_TIERS;
export const CODEX_SANDBOX_OPTIONS = CODEX_SANDBOX_TIERS;

/** The scope sentence §5.4 requires verbatim, so both cards state the same thing. */
export const CHAT_PERMISSION_SCOPE_NOTE =
  'Applies to new chat sessions. Existing and active sessions keep the permission posture captured when they were first sent.';

/**
 * The permanent warning. Present whether or not a dangerous tier is currently
 * selected — a risk the user only learns about after picking is a risk they
 * picked blind. It does not promise reversibility: turning the template back
 * does nothing for a session that already captured the dangerous posture.
 */
export const DANGEROUS_TIER_WARNING =
  'Bypass permissions and danger-full-access remove the approval and sandbox limits that keep an agent inside this workspace. New sessions started under them can read and change anything this machine can, with no prompt to stop it.';

/** The dialog copy for the second confirmation, by agent arm. */
export const DANGEROUS_CONFIRM_TITLE = 'Make this the default for new sessions?';
export const DANGEROUS_CONFIRM_BODY =
  'This tier is not applied yet. Confirm to store it as the starting posture for every new chat on this agent; cancel to keep the current one.';

/**
 * The Codex `networkAccess` row: reported, never requested.
 *
 * `SessionPermissionPreference`'s Codex arm structurally has no such key
 * (§5.7-C8), and this is the view-model half of the same negative control —
 * the panel shows the dimension so the user is not left guessing, and marks it
 * unwritable so no control can grow on it by accident. It is not settable from
 * here at all: it is not a `thread/start` request field, only an echo, and the
 * one thing that does move it is the isolated config.toml the Host writes.
 */
export const CODEX_NETWORK_ROW = {
  label: 'Network access',
  value: 'Reported by runtime',
  writable: false,
} as const;

/** What the Claude Select shows: a stored mode, or the runtime-default sentinel. */
export function claudeTemplateSelection(
  defaults: ChatAgentDefaults | undefined
): SessionPermissionMode | typeof RUNTIME_DEFAULT_OPTION {
  const stored = agentDefaultPermission(defaults, CLAUDE_CODE_AGENT);
  return stored && 'permissionMode' in stored ? stored.permissionMode : RUNTIME_DEFAULT_OPTION;
}

/** What the two Codex Selects show. Both sentinel unless a pair is stored. */
export function codexTemplateSelection(defaults: ChatAgentDefaults | undefined): {
  approvalPolicy: CodexApprovalPolicy | typeof RUNTIME_DEFAULT_OPTION;
  sandboxMode: CodexSandboxMode | typeof RUNTIME_DEFAULT_OPTION;
} {
  const stored = storedCodexPreference(defaults);
  if (!stored) {
    return { approvalPolicy: RUNTIME_DEFAULT_OPTION, sandboxMode: RUNTIME_DEFAULT_OPTION };
  }
  return { approvalPolicy: stored.approvalPolicy, sandboxMode: stored.sandboxMode };
}

function storedCodexPreference(
  defaults: ChatAgentDefaults | undefined
): CodexPermissionPreference | undefined {
  const stored = agentDefaultPermission(defaults, CODEX_AGENT);
  return stored && !('permissionMode' in stored) ? stored : undefined;
}

/**
 * Select value → the template this agent would then carry. `undefined` = the
 * sentinel was picked, i.e. clear the template back to the runtime constant.
 *
 * An unrecognized string yields `undefined` rather than being coerced: the only
 * way to get one is a build mismatch, and clearing is the safe reading of "this
 * value means nothing to me".
 */
export function nextClaudeTemplate(value: string): SessionPermissionPreference | undefined {
  // The `as` is the honest spelling, same as the shared guards': the exported
  // agent constants are typed as the WIDE `AgentWireName` (they have exactly one
  // home, and this file is not it), which cannot narrow a discriminated union.
  return (SESSION_PERMISSION_MODES as readonly string[]).includes(value)
    ? ({
        agent: CLAUDE_CODE_AGENT,
        permissionMode: value as SessionPermissionMode,
      } as ClaudePermissionPreference)
    : undefined;
}

export function nextCodexTemplate(
  defaults: ChatAgentDefaults | undefined,
  patch: { approvalPolicy?: string; sandboxMode?: string }
): SessionPermissionPreference | undefined {
  const stored = storedCodexPreference(defaults);
  let approvalPolicy = stored?.approvalPolicy;
  let sandboxMode = stored?.sandboxMode;
  // The sentinel — and any value this build does not recognize — drops the
  // whole override: half a pair is not a posture, and the runtime constant is
  // a pair. Clearing is also the safe reading of "this means nothing to me".
  if (patch.approvalPolicy !== undefined) {
    const parsed = readCodexApproval(patch.approvalPolicy);
    if (!parsed) return undefined;
    approvalPolicy = parsed;
  }
  if (patch.sandboxMode !== undefined) {
    const parsed = readCodexSandbox(patch.sandboxMode);
    if (!parsed) return undefined;
    sandboxMode = parsed;
  }
  // Same `as` as the Claude arm above, for the same reason.
  return {
    agent: CODEX_AGENT,
    // The companion dimension, when the user has never chosen one — see
    // `MOST_RESTRICTIVE_*` in `@shared/models/permissionTiers` for why it is the
    // strictest value and not the Host's constant.
    approvalPolicy: approvalPolicy ?? MOST_RESTRICTIVE_APPROVAL,
    sandboxMode: sandboxMode ?? MOST_RESTRICTIVE_SANDBOX,
  } as CodexPermissionPreference;
}

function readCodexApproval(value: string | undefined): CodexApprovalPolicy | undefined {
  return value !== undefined && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value)
    ? (value as CodexApprovalPolicy)
    : undefined;
}

function readCodexSandbox(value: string | undefined): CodexSandboxMode | undefined {
  return value !== undefined && (CODEX_SANDBOX_MODES as readonly string[]).includes(value)
    ? (value as CodexSandboxMode)
    : undefined;
}

/**
 * The gate between "the user moved a Select" and "app settings changed".
 *
 * `'apply'` writes immediately. `'confirm'` writes NOTHING yet — the caller
 * holds the value aside and only writes it if the confirmation comes back
 * positive. There is no third state: a cancel leaves app settings exactly as
 * they were, and because every Select's value is derived from app settings
 * (never from local state), the control snaps back to the previous tier on its
 * own. That is the "no unsaved dangerous state" half of C16, and it is
 * structural rather than a cleanup someone has to remember.
 */
export type PermissionTemplateAction =
  | { kind: 'apply'; preference: SessionPermissionPreference | undefined }
  | { kind: 'confirm'; preference: SessionPermissionPreference };

export function decidePermissionTemplateAction(
  preference: SessionPermissionPreference | undefined
): PermissionTemplateAction {
  if (preference && isDangerousPermissionPreference(preference)) {
    return { kind: 'confirm', preference };
  }
  return { kind: 'apply', preference };
}

/**
 * Whether the STORED template for this agent is a dangerous tier — drives the
 * always-visible "this is currently on" banner, distinct from the permanent
 * warning that names the risk before anything is picked.
 */
export function isDangerousTemplate(
  defaults: ChatAgentDefaults | undefined,
  agent: AgentWireName
): boolean {
  return isDangerousPermissionPreference(agentDefaultPermission(defaults, agent));
}

/**
 * §5.4-4 / C13, as data rather than as a review habit: every arm this module
 * can produce WITHOUT an explicit user pick. The assertion walks this list and
 * requires each entry to be non-dangerous, so a future edit that made any
 * fallback land on a dangerous tier fails a test instead of shipping.
 *
 * `undefined` entries are the honest majority: "no template" is the normal
 * state, and it means the Host's own safe constant applies.
 */
export const NON_USER_CHOSEN_TEMPLATE_ARMS: ReadonlyArray<{
  arm: string;
  preference: SessionPermissionPreference | undefined;
}> = [
  { arm: 'factory settings (no chatAgentDefaults at all)', preference: undefined },
  {
    arm: 'claude select → runtime-default sentinel',
    preference: nextClaudeTemplate(RUNTIME_DEFAULT_OPTION),
  },
  { arm: 'claude select → unrecognized value', preference: nextClaudeTemplate('totally-unknown') },
  {
    arm: 'codex select → runtime-default sentinel (approval)',
    preference: nextCodexTemplate(undefined, { approvalPolicy: RUNTIME_DEFAULT_OPTION }),
  },
  {
    arm: 'codex select → runtime-default sentinel (sandbox)',
    preference: nextCodexTemplate(undefined, { sandboxMode: RUNTIME_DEFAULT_OPTION }),
  },
  {
    arm: 'codex companion dimension, never chosen (approval picked first)',
    preference: nextCodexTemplate(undefined, { approvalPolicy: 'never' }),
  },
  {
    arm: 'codex companion dimension, never chosen (sandbox picked first)',
    preference: nextCodexTemplate(undefined, { sandboxMode: 'workspace-write' }),
  },
];
