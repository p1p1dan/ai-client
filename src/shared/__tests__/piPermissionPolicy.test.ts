import { describe, expect, it } from 'vitest';
import {
  applyPolicyPatch,
  effectivePolicy,
  isEmptyPolicyDocument,
  type JsonObject,
  mergePermissionScopes,
  type PermissionAction,
  PLUGIN_FALLBACKS,
  type PolicyScope,
  type PolicyScopeId,
  parsePermissionConfig,
  previewRuleMatch,
  scopeContributes,
  serializePolicyDocument,
} from '../piPermissionPolicy';

/**
 * T08-c slice 2 — the viewer must agree with the enforcer.
 *
 * Every assertion here is a claim about `@gotgenes/pi-permission-system`'s own
 * behaviour, taken from its source: `config-loader.ts` (scope order and scalar
 * override), `permission-merge.ts` (the `{ ...base, ...override }` spread) and
 * `rule.ts` (last-match-wins, `defaultAction ?? "ask"`). If the plugin is
 * upgraded and one of these stops being true, the panel starts telling users
 * something false about what their agent may do — which is worse than showing
 * them nothing, because they would act on it.
 */

function scope(id: PolicyScopeId, config: PolicyScope['config'], extra: Partial<PolicyScope> = {}) {
  return { id, path: `/fake/${id}.json`, present: true, config, ...extra } satisfies PolicyScope;
}

describe('parsePermissionConfig', () => {
  it('reads the shape the plugin accepts', () => {
    const { config, issues } = parsePermissionConfig({
      yoloMode: false,
      permissionReviewLog: true,
      permission: { '*': 'ask', read: 'allow', bash: { '*': 'ask', 'ls *': 'allow' } },
    });
    expect(issues).toEqual([]);
    expect(config.permission?.read).toBe('allow');
    expect(config.permission?.bash).toEqual({ '*': 'ask', 'ls *': 'allow' });
  });

  /** A bad rule must not blank the panel — the enforcer keeps loading too. */
  it('drops what it cannot read and keeps the rest', () => {
    const { config, issues } = parsePermissionConfig({
      yoloMode: 'yes',
      permission: { read: 'allow', bash: { 'ls *': 'maybe' }, weird: 42 },
    });
    expect(config.permission?.read).toBe('allow');
    expect(config.permission?.bash).toEqual({});
    expect(config.permission?.weird).toBeUndefined();
    expect(issues).toHaveLength(3);
  });

  it('reports a non-object document instead of throwing', () => {
    expect(parsePermissionConfig('nope')).toEqual({
      config: {},
      issues: ['the config is not a JSON object'],
    });
  });
});

describe('mergePermissionScopes — mirroring config-loader.ts', () => {
  it('lets a later scope replace a scalar flag', () => {
    const merged = mergePermissionScopes([
      scope('bundled', { yoloMode: false, permissionReviewLog: true }),
      scope('global', { yoloMode: true }),
    ]);
    expect(merged.yoloMode).toBe(true);
    // Untouched keys survive rather than being reset by the later scope.
    expect(merged.permissionReviewLog).toBe(true);
  });

  it('spreads two rule tables instead of replacing one', () => {
    const merged = mergePermissionScopes([
      scope('bundled', { permission: { bash: { '*': 'ask', 'ls *': 'allow' } } }),
      scope('global', { permission: { bash: { 'git status *': 'allow' } } }),
    ]);
    expect(merged.permission?.bash).toEqual({
      '*': 'ask',
      'ls *': 'allow',
      'git status *': 'allow',
    });
  });

  /**
   * The dangerous arm of `mergeFlatPermissions`: the spread only happens when
   * BOTH sides are objects. A scalar wipes the table, every pattern in it gone.
   */
  it('lets a scalar delete an entire table', () => {
    const merged = mergePermissionScopes([
      scope('bundled', { permission: { bash: { '*': 'ask', 'ls *': 'allow' } } }),
      scope('global', { permission: { bash: 'allow' } }),
    ]);
    expect(merged.permission?.bash).toBe('allow');
  });

  it('skips a scope that is present but withheld', () => {
    const merged = mergePermissionScopes([
      scope('bundled', { permission: { write: 'ask' } }),
      scope('project', { permission: { write: 'allow' } }, { withheldReason: 'untrusted' }),
    ]);
    expect(merged.permission?.write).toBe('ask');
  });

  it('skips a scope that failed to parse', () => {
    const merged = mergePermissionScopes([
      scope('bundled', { permission: { write: 'ask' } }),
      scope('global', { permission: { write: 'allow' } }, { parseError: 'trailing comma' }),
    ]);
    expect(merged.permission?.write).toBe('ask');
  });

  it('skips a scope whose file is absent', () => {
    expect(scopeContributes(scope('global', {}, { present: false }))).toBe(false);
  });
});

describe('effectivePolicy — attribution', () => {
  const scopes = [
    scope('bundled', {
      yoloMode: false,
      permission: {
        '*': 'ask',
        write: 'ask',
        path: { '*': 'allow', '*.env': 'deny', '*.env.example': 'allow' },
      },
    }),
    scope('global', {
      permission: { write: 'allow', path: { '*.env': 'allow', '~/secrets/*': 'deny' } },
    }),
  ];

  it('names the scope that decided each surface', () => {
    const result = effectivePolicy(scopes);
    const bySurface = new Map(result.surfaces.map((entry) => [entry.surface, entry]));
    expect(bySurface.get('write')).toMatchObject({ action: 'allow', origin: 'global' });
    expect(bySurface.get('*')).toMatchObject({ action: 'ask', origin: 'bundled' });
  });

  /**
   * The surprise this panel exists to show. Re-stating `*.env` as `allow` does
   * NOT move it to the end — the spread keeps the base's slot — so the later
   * `*.env.example` still follows it and the user's edit does less than it
   * reads like it does.
   */
  it('keeps a re-stated pattern in its original slot and flags it', () => {
    const rules = effectivePolicy(scopes).surfaces.find((s) => s.surface === 'path')?.rules ?? [];
    expect(rules.map((rule) => rule.pattern)).toEqual([
      '*',
      '*.env',
      '*.env.example',
      '~/secrets/*',
    ]);
    const restated = rules.find((rule) => rule.pattern === '*.env');
    expect(restated).toMatchObject({ action: 'allow', origin: 'global', repositioned: true });
    // A genuinely new pattern is appended, and is not flagged.
    expect(rules.at(-1)).toMatchObject({ pattern: '~/secrets/*', origin: 'global' });
    expect(rules.at(-1)?.repositioned).toBeUndefined();
  });

  it('reports a flag nobody set as the plugin fallback, with no origin', () => {
    const result = effectivePolicy([scope('bundled', {})]);
    expect(result.permissionReviewLog).toEqual({ value: PLUGIN_FALLBACKS.permissionReviewLog });
    expect(result.yoloMode).toEqual({ value: false });
    expect(result.yoloMode.origin).toBeUndefined();
  });

  it('reports who turned yolo mode on', () => {
    const result = effectivePolicy([
      scope('bundled', { yoloMode: false }),
      scope('project', { yoloMode: true }),
    ]);
    expect(result.yoloMode).toEqual({ value: true, origin: 'project' });
  });
});

describe('previewRuleMatch — last match wins', () => {
  const rules = (table: Record<string, PermissionAction>) =>
    Object.entries(table).map(([pattern, action]) => ({
      pattern,
      action,
      origin: 'bundled' as const,
    }));

  it('takes the LAST matching rule, not the most specific one', () => {
    const table = rules({ '*.env': 'deny', '*': 'allow' });
    expect(previewRuleMatch(table, '.env')?.action).toBe('allow');
  });

  it('honours a carve-out that comes after the deny it carves', () => {
    const table = rules({ '*': 'allow', '*.env': 'deny', '*.env.example': 'allow' });
    expect(previewRuleMatch(table, 'app/.env')?.action).toBe('deny');
    expect(previewRuleMatch(table, 'app/.env.example')?.action).toBe('allow');
  });

  it('returns nothing when no pattern matches', () => {
    expect(previewRuleMatch(rules({ 'git status *': 'allow' }), 'npm install')).toBeUndefined();
  });

  it('does not let a pattern metacharacter act as a regexp', () => {
    expect(previewRuleMatch(rules({ 'a.b': 'deny' }), 'axb')).toBeUndefined();
  });
});

describe('applyPolicyPatch — editing the writable scope', () => {
  it('sets a scalar surface', () => {
    const next = applyPolicyPatch({}, { entries: [{ surface: 'write', action: 'allow' }] });
    expect(next).toEqual({ permission: { write: 'allow' } });
  });

  /** "Back to default" has to be expressible or every experiment is permanent. */
  it('removes a surface when the action is null', () => {
    const next = applyPolicyPatch(
      { permission: { write: 'allow', read: 'allow' } },
      { entries: [{ surface: 'write', action: null }] }
    );
    expect(next).toEqual({ permission: { read: 'allow' } });
  });

  it('appends a new pattern so last-match-wins makes it take effect', () => {
    const next = applyPolicyPatch(
      { permission: { path: { '*.pem': 'deny' } } },
      { entries: [{ surface: 'path', pattern: '~/vault/*', action: 'deny' }] }
    );
    expect(Object.keys((next.permission as JsonObject).path as JsonObject)).toEqual([
      '*.pem',
      '~/vault/*',
    ]);
  });

  it('updates an existing pattern in place rather than moving it', () => {
    const next = applyPolicyPatch(
      { permission: { path: { '*.pem': 'deny', '*.key': 'deny' } } },
      { entries: [{ surface: 'path', pattern: '*.pem', action: 'ask' }] }
    );
    const table = (next.permission as JsonObject).path as JsonObject;
    expect(Object.keys(table)).toEqual(['*.pem', '*.key']);
    expect(table['*.pem']).toBe('ask');
  });

  /**
   * An empty `{}` still counts as "this scope defines this surface", so it would
   * keep replacing a lower scope's scalar with nothing at all.
   */
  it('drops a table that its last rule was removed from', () => {
    const next = applyPolicyPatch(
      { permission: { path: { '*.pem': 'deny' }, read: 'allow' } },
      { entries: [{ surface: 'path', pattern: '*.pem', action: null }] }
    );
    expect(next).toEqual({ permission: { read: 'allow' } });
  });

  it('drops the permission object once nothing is left in it', () => {
    const next = applyPolicyPatch(
      { $schema: 'x', permission: { read: 'allow' } },
      { entries: [{ surface: 'read', action: null }] }
    );
    expect(next).toEqual({ $schema: 'x' });
  });

  /**
   * The plugin accepts keys this app has never heard of. Rewriting the file
   * through our narrow shape would delete a user's tuning the first time they
   * touched an unrelated dropdown.
   */
  it('preserves keys this app does not model', () => {
    const next = applyPolicyPatch(
      { $schema: 'x', forwardingTimeoutMs: 5000, shellTools: { fish: 'bash' } },
      { entries: [{ surface: 'read', action: 'allow' }] }
    );
    expect(next.forwardingTimeoutMs).toBe(5000);
    expect(next.shellTools).toEqual({ fish: 'bash' });
    expect(next.$schema).toBe('x');
  });

  it('does not mutate the document it was given', () => {
    const original: JsonObject = { permission: { read: 'allow' } };
    applyPolicyPatch(original, { entries: [{ surface: 'read', action: 'deny' }] });
    expect(original).toEqual({ permission: { read: 'allow' } });
  });

  it('toggles the review log and can clear it back to the plugin default', () => {
    expect(applyPolicyPatch({}, { permissionReviewLog: false })).toEqual({
      permissionReviewLog: false,
    });
    expect(applyPolicyPatch({ permissionReviewLog: false }, { permissionReviewLog: null })).toEqual(
      {}
    );
  });
});

describe('document serialization', () => {
  it('emits indented JSON with a trailing newline', () => {
    expect(serializePolicyDocument({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('treats a document with nothing but $schema as empty', () => {
    expect(isEmptyPolicyDocument({ $schema: 'x' })).toBe(true);
    expect(isEmptyPolicyDocument({})).toBe(true);
    expect(isEmptyPolicyDocument({ $schema: 'x', permission: {} })).toBe(false);
  });
});
