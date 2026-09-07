/**
 * T08-c slice 2 — the pure model behind Settings → 权限策略.
 *
 * Split out of the component for this repo's usual reason: the node-env vitest
 * cannot render React, so anything that must be true has to live in a function a
 * test can call. Here that includes which choices are dangerous and which rules
 * the panel is allowed to delete — two questions a reviewer should not have to
 * answer by reading JSX.
 *
 * Nothing in this module talks to `window.electronAPI`. It turns a snapshot into
 * rows and turns a control movement into a patch; the component owns the IPC.
 */

import { type Locale, translate } from '@shared/i18n';
import {
  type EffectiveRule,
  type EffectiveSurface,
  isPermissionAction,
  type PermissionAction,
  type PermissionPolicySnapshot,
  type PolicyPatch,
  type PolicyScope,
  type PolicyScopeId,
} from '@shared/piPermissionPolicy';

/** The scope this app is allowed to write. See `services/piPermissionPolicy`. */
export const WRITABLE_SCOPE: PolicyScopeId = 'global';

// ─── scopes ───

export type ScopeStatus = 'active' | 'missing' | 'ignored' | 'invalid';

export interface ScopeRow {
  id: PolicyScopeId;
  label: string;
  /** What this scope is for, in one line. */
  summary: string;
  path: string;
  status: ScopeStatus;
  /** The reason behind a non-active status, when there is one to give. */
  detail?: string;
  /** True for the one scope the panel's controls write. */
  writable: boolean;
}

const SCOPE_COPY: Record<PolicyScopeId, { label: string; summary: string }> = {
  bundled: {
    label: 'Bundled defaults',
    summary: 'Bundled policy with the lowest priority; your settings override it',
  },
  global: {
    label: 'My settings',
    summary: 'Account-specific Pi directory where your changes are saved',
  },
  project: {
    label: 'Project configuration',
    summary: 'Repository .pi configuration with the highest priority',
  },
};

/**
 * One row per scope, including the ones contributing nothing.
 *
 * A scope that exists and is ignored is the single most useful thing this panel
 * can show: without it, "my repo has a permissions file and the agent still asks
 * about everything" is an afternoon of debugging.
 *
 * `ignored` outranks `invalid` when both apply, because "it is not being read"
 * is the operative fact — but the parse error still travels in `detail`, so a
 * user who later switches routes is not surprised by it.
 */
export function deriveScopeRows(scopes: readonly PolicyScope[], locale: Locale = 'en'): ScopeRow[] {
  return scopes.map((scope) => {
    const copy = SCOPE_COPY[scope.id];
    const base = {
      id: scope.id,
      label: copy.label,
      summary: copy.summary,
      path: scope.path,
      writable: scope.id === WRITABLE_SCOPE,
    };
    if (scope.withheldReason) {
      const detail = scope.parseError
        ? translate(locale, '{{reason}} (syntax error: {{error}})', {
            reason: scope.withheldReason,
            error: scope.parseError,
          })
        : scope.withheldReason;
      return { ...base, status: 'ignored' as const, detail };
    }
    if (scope.parseError) {
      return { ...base, status: 'invalid' as const, detail: scope.parseError };
    }
    if (!scope.present) {
      return {
        ...base,
        status: 'missing' as const,
        detail: translate(locale, 'File does not exist; this layer contributes no rules'),
      };
    }
    return {
      ...base,
      status: 'active' as const,
      ...(scope.issues?.length ? { detail: scope.issues.join('；') } : {}),
    };
  });
}

// ─── the controls ───

/**
 * The surfaces this panel offers a control for.
 *
 * Deliberately a curated list rather than "whatever the config happens to
 * contain". Two reasons, and the second is the important one:
 *
 *  - A surface that appears only because someone hand-wrote it would get a
 *    control that looks official, on a key the plugin may not even read.
 *  - `dangerous` has to be decided per surface by a human. Generating controls
 *    from data would generate that judgement too, and it would be wrong the
 *    first time a new surface appeared.
 *
 * `pattern: '*'` means the surface is a rule TABLE and the control edits its
 * catch-all — the entry the plugin falls back to when nothing else matches.
 */
export interface SurfaceDefinition {
  surface: string;
  pattern?: '*';
  label: string;
  description: string;
  /**
   * True when `allow` here removes a limit that nothing else replaces, so the
   * panel asks a second time before storing it.
   */
  dangerous: boolean;
}

export const SURFACE_DEFINITIONS: readonly SurfaceDefinition[] = [
  {
    surface: 'read',
    label: 'Read files',
    description: 'Open individual files, subject to the file path rules below.',
    dangerous: false,
  },
  {
    surface: 'grep',
    label: 'Search content',
    description: 'Search file contents.',
    dangerous: false,
  },
  {
    surface: 'ls',
    label: 'List directories',
    description: 'List directory contents.',
    dangerous: false,
  },
  {
    surface: 'find',
    label: 'Find files',
    description: 'Find files by name.',
    dangerous: false,
  },
  {
    surface: 'write',
    label: 'Write files',
    description: 'Create or overwrite files. Allowing this skips approval before writing.',
    dangerous: true,
  },
  {
    surface: 'edit',
    label: 'Edit files',
    description: 'Edit existing files. Allowing this skips approval before editing.',
    dangerous: true,
  },
  {
    surface: 'bash',
    pattern: '*',
    label: 'Terminal commands (default)',
    description: 'Applies to commands not matched below. Allowing this permits arbitrary commands.',
    dangerous: true,
  },
  {
    surface: 'external_directory',
    pattern: '*',
    label: 'Access outside the working directory',
    description: 'Controls reading and writing outside the current repository.',
    dangerous: true,
  },
  {
    surface: 'mcp',
    pattern: '*',
    label: 'MCP tool calls',
    description: 'Call tools provided by external MCP servers.',
    dangerous: true,
  },
  {
    surface: 'skill',
    pattern: '*',
    label: 'Skills',
    description: 'Run packaged skills, which may call other tools.',
    dangerous: true,
  },
  {
    surface: '*',
    label: 'Other tools (fallback)',
    description: 'Any tool not listed above, including tools provided by new extensions.',
    dangerous: true,
  },
];

export interface SurfaceControl extends SurfaceDefinition {
  /** What the enforcer will do today. */
  value: PermissionAction;
  /** The scope that decided it; absent = nobody did, and the plugin's `ask` applies. */
  origin?: PolicyScopeId;
  /** True when the writable scope is the one that set it — i.e. "you changed this". */
  overridden: boolean;
}

/**
 * The plugin's own fall-through for anything no scope mentions
 * (`rule.ts`: `defaultAction ?? "ask"`), restated so a control always has a
 * value to show rather than an empty select.
 */
const UNMATCHED: PermissionAction = 'ask';

export function deriveSurfaceControls(snapshot: PermissionPolicySnapshot): SurfaceControl[] {
  const bySurface = new Map(snapshot.effective.surfaces.map((entry) => [entry.surface, entry]));
  const writable = snapshot.scopes.find((scope) => scope.id === WRITABLE_SCOPE);
  return SURFACE_DEFINITIONS.map((definition) => {
    const resolved = resolveSurface(bySurface.get(definition.surface), definition.pattern);
    return {
      ...definition,
      value: resolved?.action ?? UNMATCHED,
      ...(resolved?.origin ? { origin: resolved.origin } : {}),
      overridden: writableDefines(writable, definition),
    };
  });
}

function resolveSurface(
  entry: EffectiveSurface | undefined,
  pattern: '*' | undefined
): { action: PermissionAction; origin: PolicyScopeId } | undefined {
  if (!entry) return undefined;
  if (pattern === undefined) {
    // A table where a scalar was expected has no single answer to show; the
    // rule list below is the honest place for it.
    return entry.action !== undefined ? { action: entry.action, origin: entry.origin } : undefined;
  }
  const rule = entry.rules?.find((candidate) => candidate.pattern === pattern);
  return rule ? { action: rule.action, origin: rule.origin } : undefined;
}

function writableDefines(scope: PolicyScope | undefined, definition: SurfaceDefinition): boolean {
  const entry = scope?.config.permission?.[definition.surface];
  if (entry === undefined) return false;
  if (definition.pattern === undefined) return typeof entry === 'string';
  return typeof entry === 'object' && entry[definition.pattern] !== undefined;
}

/**
 * Does storing `next` need the second confirmation?
 *
 * Only when it LOOSENS a dangerous surface. Tightening never asks — a user
 * moving toward more prompts does not need to be talked out of it — and neither
 * does clearing an override, which can only move back toward what we ship.
 */
export function isDangerousChoice(
  control: SurfaceDefinition,
  next: PermissionAction | null
): boolean {
  return control.dangerous && next === 'allow';
}

/**
 * The sentinel a Select carries for "no override of my own — show whatever the
 * lower scopes say". A real, selectable choice, and the only way back.
 */
export const INHERIT_OPTION = '__inherit__';

/**
 * Turn whatever a Select emitted into a decision.
 *
 * Three outcomes, and the third is the one worth having: `undefined` means
 * "this value means nothing to me, do nothing". A base-ui Select can emit
 * `null` on deselect, and `String(null)` is the string `"null"` — which is not
 * the sentinel, so a lenient reader would write `"null"` into the policy file
 * as if it were an action. The plugin would then fall through to `ask` for that
 * surface, so the SYMPTOM is extra prompts while the setting the user chose is
 * silently gone.
 */
export function readActionChoice(value: unknown): PermissionAction | null | undefined {
  if (value === INHERIT_OPTION) return null;
  return isPermissionAction(value) ? value : undefined;
}

/** The patch for one control movement. `null` clears the override. */
export function surfacePatch(
  control: SurfaceDefinition,
  next: PermissionAction | null
): PolicyPatch {
  return {
    entries: [
      control.pattern === undefined
        ? { surface: control.surface, action: next }
        : { surface: control.surface, pattern: control.pattern, action: next },
    ],
  };
}

// ─── the rule tables ───

/** The pattern tables the panel lists in full, in the order it lists them. */
export const RULE_TABLES: readonly { surface: string; label: string; description: string }[] = [
  {
    surface: 'path',
    label: 'File paths',
    description:
      'Applies before other rules across all tools. A path denial overrides a tool allowance.',
  },
  {
    surface: 'bash',
    label: 'Allowed terminal commands',
    description: 'Matching commands skip approval. Later rules take precedence.',
  },
];

export interface RuleTableView {
  surface: string;
  label: string;
  description: string;
  /** In evaluation order — first to last, last match wins. */
  rules: EffectiveRule[];
  /** Patterns this panel may edit or delete: the ones the writable scope set. */
  editablePatterns: string[];
}

export function deriveRuleTables(snapshot: PermissionPolicySnapshot): RuleTableView[] {
  const bySurface = new Map(snapshot.effective.surfaces.map((entry) => [entry.surface, entry]));
  return RULE_TABLES.map((table) => {
    const rules = bySurface.get(table.surface)?.rules ?? [];
    return {
      ...table,
      rules,
      editablePatterns: rules
        .filter((rule) => rule.origin === WRITABLE_SCOPE)
        .map((rule) => rule.pattern),
    };
  });
}

export interface RuleValidation {
  ok: boolean;
  error?: string;
  /**
   * A reason to hesitate that is not a reason to refuse. The one that matters:
   * re-stating an existing pattern keeps its ORIGINAL position in the
   * evaluation order, so the new rule may still be overridden by a rule that
   * follows it — which is not what "I just added this" feels like.
   */
  warning?: string;
}

export function validateNewRule(
  rules: readonly EffectiveRule[],
  pattern: string,
  locale: Locale = 'en'
): RuleValidation {
  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, error: translate(locale, 'A rule cannot be empty') };
  // Internal spaces are legal and load-bearing — `git status *` is a bash
  // pattern — so only leading/trailing space is rejected. It is always a typo,
  // and the plugin matches literally, so it would silently never match.
  if (trimmed !== pattern)
    return { ok: false, error: translate(locale, 'A rule cannot start or end with spaces') };
  const existing = rules.find((rule) => rule.pattern === trimmed);
  if (!existing) return { ok: true };
  const later = rules.slice(rules.indexOf(existing) + 1);
  if (later.length === 0)
    return {
      ok: true,
      warning: translate(locale, 'This rule exists and its action will be replaced'),
    };
  return {
    ok: true,
    warning: translate(
      locale,
      'This rule stays at position {{position}}. The {{count}} later rules take precedence.',
      { position: rules.indexOf(existing) + 1, count: later.length }
    ),
  };
}

/** The patch that adds or updates one rule in a table. */
export function rulePatch(
  surface: string,
  pattern: string,
  action: PermissionAction | null
): PolicyPatch {
  return { entries: [{ surface, pattern: pattern.trim(), action }] };
}
