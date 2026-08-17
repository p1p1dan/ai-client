/**
 * D48 S4 §6.3 — the permission TIER vocabulary, in one place, for the two
 * layers that offer it.
 *
 * ## Why this is not just a table in the Settings panel
 *
 * S3 shipped the template layer (Settings' "Chat agent defaults": where a NEW
 * chat starts) and S4 adds the live layer (the Composer chip: what THIS chat
 * runs under from here on). Both offer the same tiers, both must mark the same
 * two of them dangerous, and both must describe them the same way — a build
 * where `danger-full-access` is flagged in one list and plain in the other is a
 * build where the second confirmation depends on which control the user
 * happened to use. §5.4's "模板层与实时层逐条同口径" is exactly that rule, and
 * one table is how it holds without anyone remembering it.
 *
 * The `dangerous` bit here is a LABEL, not the decision: the decision reads
 * `isDangerousPermissionPreference` (`runtimeEvents.ts`), which both layers'
 * gates call, and which the Host and Main call as well. This flag exists so a
 * menu row can be styled and worded before anything is picked — a risk the user
 * only learns about at the confirmation dialog is a risk they picked blind.
 *
 * Pure (no React, no store, no IPC): both consumers are truth-tabled under the
 * node-env vitest, and one of them (`composerPermissionModel.ts`) is on the
 * purity scan's target list, which forbids it from reaching into
 * `@/components/settings` at all.
 */

import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  SessionPermissionMode,
} from '../types/runtimeEvents';

export interface PermissionTierOption<T extends string> {
  value: T;
  label: string;
  /** Rendered next to the option, not hidden behind a tooltip. */
  description: string;
  /** §8.0-Q3's two tiers — drives the warning and the second confirmation. */
  dangerous: boolean;
}

/**
 * Claude's five, in the SDK's own vocabulary (`SESSION_PERMISSION_MODES`).
 * Ordered least → most permissive so the dangerous one is last, where a
 * mis-click is least likely; `'auto'` is absent because SDK 0.3.218 has no such
 * value [实测 sdk.d.ts:1720, 06-probes P2(b)].
 */
export const CLAUDE_PERMISSION_TIERS: ReadonlyArray<PermissionTierOption<SessionPermissionMode>> = [
  {
    value: 'plan',
    label: 'Plan',
    description: 'Plan only — no edits, no commands.',
    dangerous: false,
  },
  {
    value: 'default',
    label: 'Default',
    description: 'Ask before every tool use.',
    dangerous: false,
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'File edits apply without asking; other tools still ask.',
    dangerous: false,
  },
  {
    value: 'dontAsk',
    label: "Don't ask",
    description: 'Approvals are answered for you; the sandbox still applies.',
    dangerous: false,
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'No approval prompts at all. Anything the agent decides to run, runs.',
    dangerous: true,
  },
];

export const CODEX_APPROVAL_TIERS: ReadonlyArray<PermissionTierOption<CodexApprovalPolicy>> = [
  {
    value: 'untrusted',
    label: 'untrusted',
    description: 'Only a trusted allow-list runs unattended.',
    dangerous: false,
  },
  {
    value: 'on-request',
    label: 'on-request',
    description: 'The agent asks when it wants to escalate.',
    dangerous: false,
  },
  {
    value: 'never',
    label: 'never',
    description: 'Never asks — the sandbox is the only remaining limit.',
    dangerous: false,
  },
];

export const CODEX_SANDBOX_TIERS: ReadonlyArray<PermissionTierOption<CodexSandboxMode>> = [
  { value: 'read-only', label: 'read-only', description: 'No writes at all.', dangerous: false },
  {
    value: 'workspace-write',
    label: 'workspace-write',
    description: 'Writes confined to the workspace.',
    dangerous: false,
  },
  {
    value: 'danger-full-access',
    label: 'danger-full-access',
    description: 'No sandbox. Full read and write access to this machine.',
    dangerous: true,
  },
];

/**
 * The most restrictive value of each Codex dimension.
 *
 * Codex's posture is a PAIR, but the UI is two controls, so picking one
 * dimension while the other has never been chosen has to complete the pair
 * somehow. It completes it with the most restrictive value rather than with the
 * runtime's constant (which the renderer must not know) — deliberately erring
 * toward less capability, and provably never toward a dangerous tier (C13/D12).
 */
export const MOST_RESTRICTIVE_APPROVAL: CodexApprovalPolicy = 'untrusted';
export const MOST_RESTRICTIVE_SANDBOX: CodexSandboxMode = 'read-only';

/** The tier label a control shows, or the raw value if this build cannot name it. */
export function permissionTierLabel<T extends string>(
  tiers: ReadonlyArray<PermissionTierOption<T>>,
  value: string
): string {
  return tiers.find((tier) => tier.value === value)?.label ?? value;
}
