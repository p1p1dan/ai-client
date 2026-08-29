/**
 * T08-c slice 2 — the pure model behind Settings' "Permission policy" panel.
 *
 * ## What this module is
 *
 * A faithful, dependency-free re-implementation of how
 * `@gotgenes/pi-permission-system` combines its configuration scopes, so the app
 * can SHOW the user the policy that is actually in force and let them edit the
 * one scope we are allowed to write.
 *
 * It is a mirror, not a wrapper. The plugin's own loader is TypeScript inside
 * `node_modules` and Node refuses to strip types there
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing it is not an
 * option. Every rule below is therefore paired with the plugin source it copies,
 * and the tests assert the copied behaviour rather than a convenient one — a
 * viewer that merges differently from the enforcer is worse than no viewer,
 * because it is confidently wrong about what an agent may do.
 *
 * ## The two semantics that everything here turns on
 *
 * 1. **Patterns are LAST-MATCH-WINS** (`rule.ts`). `{ "*.env": "deny", "*":
 *    "allow" }` ALLOWS `.env`. Key order in a rule table IS the policy, so this
 *    module never sorts, and an added rule is appended so that it wins.
 * 2. **Scopes merge shallowly per table** (`permission-merge.ts`:
 *    `{ ...base, ...override }`). A key the base already has keeps the BASE's
 *    position and takes the OVERRIDE's value; a key only the override has is
 *    appended. That asymmetry is why `attributeRules` tracks position and origin
 *    separately — re-stating an existing pattern does not move it later in the
 *    evaluation order, which is exactly the surprise a user needs shown.
 *
 * ## Why it lives in `shared`
 *
 * Main reads the files and writes the one editable scope; the renderer renders
 * the result. Both need the same answer to "what does this actually mean", and
 * a second copy of last-match-wins would be a security bug waiting for a
 * refactor.
 */

// ─── vocabulary ───

export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function isPermissionAction(value: unknown): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly unknown[]).includes(value);
}

/** A pattern table: pattern → action, evaluated LAST-MATCH-WINS. */
export type PermissionRules = Record<string, PermissionAction>;

/** One surface: either a single action, or a pattern table. */
export type PermissionEntry = PermissionAction | PermissionRules;

export interface PiPermissionConfig {
  debugLog?: boolean;
  permissionReviewLog?: boolean;
  yoloMode?: boolean;
  permission?: Record<string, PermissionEntry>;
}

/**
 * The plugin's own fallbacks, for surfaces and flags no scope mentions.
 *
 * `unmatched: 'ask'` is `rule.ts`'s `defaultAction ?? "ask"` plus its explicit
 * `origin: "fail-closed"` arm; the two booleans are `extension-config.ts`'s
 * `DEFAULT_EXTENSION_CONFIG`. Stated here so the panel can distinguish "nobody
 * configured this" from "someone configured this to the same value" — they look
 * identical on screen and behave identically until a scope changes.
 */
export const PLUGIN_FALLBACKS = {
  unmatched: 'ask',
  permissionReviewLog: true,
  yoloMode: false,
  debugLog: false,
} as const;

// ─── JSON, kept honest ───

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a config document into the narrow shape above, reporting what it had to
 * ignore instead of throwing.
 *
 * A single bad rule must not blank the whole panel: the plugin itself keeps
 * loading a config with issues (`loadUnifiedConfig` returns `{ config, issues }`),
 * and a viewer that showed nothing where the enforcer sees something would hide
 * the very rules the user came to check.
 */
export function parsePermissionConfig(raw: unknown): {
  config: PiPermissionConfig;
  issues: string[];
} {
  const issues: string[] = [];
  if (!isJsonObject(raw)) {
    return { config: {}, issues: ['the config is not a JSON object'] };
  }
  const config: PiPermissionConfig = {};
  for (const key of ['debugLog', 'permissionReviewLog', 'yoloMode'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') config[key] = value;
    else issues.push(`${key} must be true or false`);
  }
  const permission = raw.permission;
  if (permission !== undefined) {
    if (!isJsonObject(permission)) {
      issues.push('permission must be an object');
    } else {
      config.permission = readSurfaces(permission, issues);
    }
  }
  return { config, issues };
}

function readSurfaces(raw: JsonObject, issues: string[]): Record<string, PermissionEntry> {
  const surfaces: Record<string, PermissionEntry> = {};
  for (const [surface, value] of Object.entries(raw)) {
    if (isPermissionAction(value)) {
      surfaces[surface] = value;
      continue;
    }
    if (isJsonObject(value)) {
      const rules: PermissionRules = {};
      for (const [pattern, action] of Object.entries(value)) {
        if (isPermissionAction(action)) rules[pattern] = action;
        else issues.push(`permission.${surface}["${pattern}"] is not allow/ask/deny`);
      }
      surfaces[surface] = rules;
      continue;
    }
    issues.push(`permission.${surface} is neither an action nor a rule table`);
  }
  return surfaces;
}

// ─── scopes ───

/**
 * The three scopes this app can see, in the order the plugin merges them.
 *
 * `bundled` is `<extensionRoot>/config.json` — the policy we ship (D11). The
 * plugin calls it legacy but still reads it, ahead of everything else.
 * `global` is `<agentDir>/extensions/pi-permission-system/config.json`.
 * `project` is `<cwd>/.pi/extensions/pi-permission-system/config.json`.
 *
 * The plugin also reads two `pi-permissions.jsonc` legacy policy files. They are
 * deliberately absent here: this app never writes them, and a user who has one
 * is told about it by the plugin's own warning rather than by a control that
 * pretends to manage it.
 */
export const POLICY_SCOPE_ORDER = ['bundled', 'global', 'project'] as const;
export type PolicyScopeId = (typeof POLICY_SCOPE_ORDER)[number];

export interface PolicyScope {
  id: PolicyScopeId;
  /** Absolute path, shown to the user so "where does this come from" is answerable. */
  path: string;
  /** The file exists. A scope can exist and still contribute nothing. */
  present: boolean;
  config: PiPermissionConfig;
  /** The file exists but could not be read or parsed. */
  parseError?: string;
  /** Non-fatal complaints from {@link parsePermissionConfig}. */
  issues?: string[];
  /**
   * Set when the scope is deliberately NOT consulted — today only the untrusted
   * project scope (D11 decision 4). A withheld scope is still shown, because
   * "your repo has a policy file and it is being ignored" is information.
   */
  withheldReason?: string;
}

/** Does this scope actually feed the merge? */
export function scopeContributes(scope: PolicyScope): boolean {
  return scope.present && !scope.parseError && !scope.withheldReason;
}

// ─── merge ───

/**
 * Merge the contributing scopes exactly as `config-loader.ts` does.
 *
 * Scalars: the later scope replaces the earlier one when it defines the key
 * (`mergeUnifiedConfigs`). Surfaces: `mergeFlatPermissions`' deep-shallow rule —
 * two tables are spread together, anything else is replaced outright. The
 * replacement arm matters: a scope that sets `bash: "allow"` does not merge with
 * an earlier `bash` TABLE, it deletes every pattern in it.
 */
export function mergePermissionScopes(scopes: readonly PolicyScope[]): PiPermissionConfig {
  let merged: PiPermissionConfig = {};
  for (const scope of scopes) {
    if (!scopeContributes(scope)) continue;
    merged = mergeTwo(merged, scope.config);
  }
  return merged;
}

function mergeTwo(base: PiPermissionConfig, override: PiPermissionConfig): PiPermissionConfig {
  const merged: PiPermissionConfig = {};
  for (const key of ['debugLog', 'permissionReviewLog', 'yoloMode'] as const) {
    const value = override[key] ?? base[key];
    if (value !== undefined) merged[key] = value;
  }
  const basePermission = base.permission;
  const overridePermission = override.permission;
  if (basePermission && overridePermission) {
    const surfaces: Record<string, PermissionEntry> = { ...basePermission };
    for (const [surface, entry] of Object.entries(overridePermission)) {
      const existing = surfaces[surface];
      surfaces[surface] =
        typeof existing === 'object' && typeof entry === 'object'
          ? { ...existing, ...entry }
          : entry;
    }
    merged.permission = surfaces;
  } else if (basePermission ?? overridePermission) {
    merged.permission = overridePermission ?? basePermission;
  }
  return merged;
}

// ─── the effective view, with attribution ───

export interface EffectiveRule {
  pattern: string;
  action: PermissionAction;
  /** The last scope that set this pattern. */
  origin: PolicyScopeId;
  /**
   * True when an earlier scope already had this pattern, so the override took
   * the value but kept the ORIGINAL position in the evaluation order. This is
   * the one merge behaviour that reliably surprises people: re-stating `"*.env":
   * "allow"` does not move it past the `"*.env.*": "deny"` that follows it.
   */
  repositioned?: boolean;
}

export interface EffectiveSurface {
  surface: string;
  /** Set when the surface resolves to a single action. */
  action?: PermissionAction;
  /** Set when the surface is a pattern table, in evaluation order. */
  rules?: EffectiveRule[];
  /** The last scope that touched this surface at all. */
  origin: PolicyScopeId;
}

export interface EffectiveFlag<T> {
  value: T;
  /** Absent = no scope sets it and {@link PLUGIN_FALLBACKS} applies. */
  origin?: PolicyScopeId;
}

export interface EffectivePolicy {
  surfaces: EffectiveSurface[];
  yoloMode: EffectiveFlag<boolean>;
  permissionReviewLog: EffectiveFlag<boolean>;
  debugLog: EffectiveFlag<boolean>;
}

/**
 * Fold the scopes into what the enforcer will see, remembering where each piece
 * came from.
 *
 * Attribution is not decoration. The panel's job is to answer "why is my agent
 * asking about this", and the three plausible answers — we ship it, you set it,
 * your repo set it — lead to three different fixes.
 */
export function effectivePolicy(scopes: readonly PolicyScope[]): EffectivePolicy {
  const active = scopes.filter(scopeContributes);
  return {
    surfaces: attributeSurfaces(active),
    yoloMode: attributeFlag(active, 'yoloMode', PLUGIN_FALLBACKS.yoloMode),
    permissionReviewLog: attributeFlag(
      active,
      'permissionReviewLog',
      PLUGIN_FALLBACKS.permissionReviewLog
    ),
    debugLog: attributeFlag(active, 'debugLog', PLUGIN_FALLBACKS.debugLog),
  };
}

function attributeFlag(
  active: readonly PolicyScope[],
  key: 'debugLog' | 'permissionReviewLog' | 'yoloMode',
  fallback: boolean
): EffectiveFlag<boolean> {
  let result: EffectiveFlag<boolean> = { value: fallback };
  for (const scope of active) {
    const value = scope.config[key];
    if (value !== undefined) result = { value, origin: scope.id };
  }
  return result;
}

interface SurfaceAccumulator {
  origin: PolicyScopeId;
  action?: PermissionAction;
  /** Insertion-ordered; the map preserves the position semantics of a spread. */
  rules?: Map<string, EffectiveRule>;
}

function attributeSurfaces(active: readonly PolicyScope[]): EffectiveSurface[] {
  const accumulated = new Map<string, SurfaceAccumulator>();
  for (const scope of active) {
    for (const [surface, entry] of Object.entries(scope.config.permission ?? {})) {
      accumulated.set(surface, foldSurface(accumulated.get(surface), entry, scope.id));
    }
  }
  return [...accumulated.entries()].map(([surface, value]) => ({
    surface,
    origin: value.origin,
    ...(value.action !== undefined ? { action: value.action } : {}),
    ...(value.rules ? { rules: [...value.rules.values()] } : {}),
  }));
}

function foldSurface(
  previous: SurfaceAccumulator | undefined,
  entry: PermissionEntry,
  origin: PolicyScopeId
): SurfaceAccumulator {
  // A scalar replaces whatever was there, table included — see `mergeTwo`.
  if (typeof entry === 'string') return { origin, action: entry };
  // A table onto a scalar also replaces: `mergeFlatPermissions` only spreads
  // when BOTH sides are objects.
  const rules = previous?.rules ? new Map(previous.rules) : new Map<string, EffectiveRule>();
  for (const [pattern, action] of Object.entries(entry)) {
    const existing = rules.get(pattern);
    // `{ ...base, ...override }` keeps the base's slot for a repeated key, so a
    // re-stated pattern must NOT be re-inserted at the end.
    rules.set(pattern, {
      pattern,
      action,
      origin,
      ...(existing ? { repositioned: true } : {}),
    });
  }
  return { origin, rules };
}

/**
 * The action a pattern table yields for `candidate`, by the plugin's own
 * last-match-wins scan.
 *
 * Only the glob shapes the shipped policy uses are supported (`*` anywhere in
 * the pattern); this is a preview aid for the panel, not a second enforcer, and
 * the caller is expected to label it as such.
 */
export function previewRuleMatch(
  rules: readonly EffectiveRule[],
  candidate: string
): EffectiveRule | undefined {
  let matched: EffectiveRule | undefined;
  for (const rule of rules) {
    if (globMatches(rule.pattern, candidate)) matched = rule;
  }
  return matched;
}

function globMatches(pattern: string, candidate: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(candidate);
}

// ─── editing the one scope we may write ───

/**
 * One change to the editable scope. `action: null` REMOVES the override so the
 * lower scope shows through again — "back to default" has to be expressible, or
 * every experiment is permanent.
 */
export type PolicyPatchEntry =
  | { surface: string; pattern?: undefined; action: PermissionAction | null }
  | { surface: string; pattern: string; action: PermissionAction | null };

export interface PolicyPatch {
  entries?: readonly PolicyPatchEntry[];
  permissionReviewLog?: boolean | null;
  debugLog?: boolean | null;
}

/**
 * Apply a patch to the RAW document of the editable scope.
 *
 * Raw, not the parsed shape, and that is the whole point: the plugin accepts
 * keys this app has never heard of (`forwardingTimeoutMs`, `shellTools`,
 * `authorizerChain`, `$schema`). Round-tripping through
 * {@link parsePermissionConfig} would silently delete a user's tuning the first
 * time they moved an unrelated dropdown.
 *
 * A new pattern is APPENDED, which under last-match-wins is what makes it take
 * effect. An existing pattern is updated in place, which under the same rule is
 * what stops a re-stated pattern from jumping the queue.
 */
export function applyPolicyPatch(document: JsonObject, patch: PolicyPatch): JsonObject {
  const next: JsonObject = { ...document };
  for (const key of ['permissionReviewLog', 'debugLog'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (!patch.entries?.length) return prunePermission(next);

  const permission: JsonObject = isJsonObject(next.permission) ? { ...next.permission } : {};
  for (const entry of patch.entries) {
    if (entry.pattern === undefined) {
      if (entry.action === null) delete permission[entry.surface];
      else permission[entry.surface] = entry.action;
      continue;
    }
    const existing = permission[entry.surface];
    const table: JsonObject = isJsonObject(existing) ? { ...existing } : {};
    if (entry.action === null) delete table[entry.pattern];
    else table[entry.pattern] = entry.action;
    // An emptied table is removed rather than left as `{}`: an empty object
    // still counts as "this scope defines this surface" in the merge, which
    // would keep replacing a lower scope's scalar with nothing.
    if (Object.keys(table).length === 0) delete permission[entry.surface];
    else permission[entry.surface] = table;
  }
  next.permission = permission;
  return prunePermission(next);
}

function prunePermission(document: JsonObject): JsonObject {
  if (isJsonObject(document.permission) && Object.keys(document.permission).length === 0) {
    const { permission: _dropped, ...rest } = document;
    return rest;
  }
  return document;
}

// ─── what crosses IPC ───

/** Which credential route this app is on, which is what decides writability. */
export type PermissionPolicyRoute = 'managed' | 'local';

export interface PermissionPolicySnapshot {
  route: PermissionPolicyRoute;
  /** The agent directory whose global scope is in play, shown so the paths make sense. */
  agentDir: string;
  /** True when this app may write the global scope. */
  editable: boolean;
  /**
   * Why the policy is read-only, in words a user can act on. On the local route
   * this is the T08-a red line: the global scope IS their own `~/.pi`, and this
   * app will not edit a directory that belongs to their `pi` CLI.
   */
  readOnlyReason?: string;
  scopes: PolicyScope[];
  effective: EffectivePolicy;
}

export interface PermissionPolicyRequest {
  /** The repository whose project scope to include; omitted = no project scope. */
  repoPath?: string;
}

export interface UpdatePermissionPolicyRequest extends PermissionPolicyRequest {
  patch: PolicyPatch;
}

/** The bytes written back: two-space indent and a trailing newline, like the shipped default. */
export function serializePolicyDocument(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Is this document empty enough that keeping the file would only be noise?
 *
 * Used by "reset to default": clearing every control should leave no file, not
 * an empty one — an empty `{}` is indistinguishable from a config the user
 * meant to write, and it makes the panel claim a scope that says nothing.
 */
export function isEmptyPolicyDocument(document: JsonObject): boolean {
  return Object.keys(document).every((key) => key === '$schema');
}
