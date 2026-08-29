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
  bundled: { label: '随包默认', summary: '本应用出厂策略，优先级最低，你的设置永远压得过它' },
  global: { label: '我的设置', summary: '按帐号隔离的 pi 目录，本面板的改动写在这里' },
  project: { label: '项目配置', summary: '仓库自带的 .pi 配置，优先级最高' },
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
export function deriveScopeRows(scopes: readonly PolicyScope[]): ScopeRow[] {
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
        ? `${scope.withheldReason}（该文件另有语法错误：${scope.parseError}）`
        : scope.withheldReason;
      return { ...base, status: 'ignored' as const, detail };
    }
    if (scope.parseError) {
      return { ...base, status: 'invalid' as const, detail: scope.parseError };
    }
    if (!scope.present) {
      return { ...base, status: 'missing' as const, detail: '文件不存在，本层不产生任何规则' };
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
    label: '读取文件',
    description: '打开单个文件。仍受下方“文件路径”规则约束。',
    dangerous: false,
  },
  {
    surface: 'grep',
    label: '搜索内容',
    description: '在文件里按内容搜索。',
    dangerous: false,
  },
  {
    surface: 'ls',
    label: '列目录',
    description: '列出目录内容。',
    dangerous: false,
  },
  {
    surface: 'find',
    label: '查找文件',
    description: '按文件名查找。',
    dangerous: false,
  },
  {
    surface: 'write',
    label: '写入文件',
    description: '新建或覆盖文件。设为“直接允许”后，写错的文件没有任何一步可以拦下。',
    dangerous: true,
  },
  {
    surface: 'edit',
    label: '修改文件',
    description: '改动已有文件。设为“直接允许”后，改错的地方没有任何一步可以拦下。',
    dangerous: true,
  },
  {
    surface: 'bash',
    pattern: '*',
    label: '终端命令（默认）',
    description: '没有被下方白名单命中的命令走这里。设为“直接允许”等于让 agent 可以执行任意命令。',
    dangerous: true,
  },
  {
    surface: 'external_directory',
    pattern: '*',
    label: '访问工作目录之外',
    description: '离开当前仓库去读写别处。这是阻止一个仓库的会话动到另一个仓库的那道闸。',
    dangerous: true,
  },
  {
    surface: 'mcp',
    pattern: '*',
    label: 'MCP 工具调用',
    description: '调用外部 MCP 服务器提供的工具。',
    dangerous: true,
  },
  {
    surface: 'skill',
    pattern: '*',
    label: '技能（Skill）',
    description: '运行打包好的技能。技能内部可以再调工具。',
    dangerous: true,
  },
  {
    surface: '*',
    label: '其它一切（兜底）',
    description: '上面没有提到的任何工具，包括这个版本还没见过的扩展工具。',
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
    label: '文件路径',
    description:
      '横切所有工具，先于其它规则判定，且这里的“拒绝”不能被单个工具的“允许”覆盖——这就是 cat 可以放行而 cat .env 仍被拒的原因。',
  },
  {
    surface: 'bash',
    label: '终端命令白名单',
    description: '命中的命令不再弹窗。越靠后的规则优先级越高。',
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

export function validateNewRule(rules: readonly EffectiveRule[], pattern: string): RuleValidation {
  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, error: '规则不能为空' };
  // Internal spaces are legal and load-bearing — `git status *` is a bash
  // pattern — so only leading/trailing space is rejected. It is always a typo,
  // and the plugin matches literally, so it would silently never match.
  if (trimmed !== pattern) return { ok: false, error: '规则首尾不能有空格' };
  const existing = rules.find((rule) => rule.pattern === trimmed);
  if (!existing) return { ok: true };
  const later = rules.slice(rules.indexOf(existing) + 1);
  if (later.length === 0) return { ok: true, warning: '该规则已存在，将被覆盖为新的动作' };
  return {
    ok: true,
    warning: `该规则已存在于第 ${rules.indexOf(existing) + 1} 条，改动会保留它原来的位置——它后面还有 ${later.length} 条规则，命中时以后面的为准`,
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
