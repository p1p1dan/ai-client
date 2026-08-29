import {
  effectivePolicy,
  type PermissionPolicySnapshot,
  type PolicyScope,
  type PolicyScopeId,
} from '@shared/piPermissionPolicy';
import { describe, expect, it } from 'vitest';
import {
  deriveRuleTables,
  deriveScopeRows,
  deriveSurfaceControls,
  INHERIT_OPTION,
  isDangerousChoice,
  RULE_TABLES,
  readActionChoice,
  rulePatch,
  SURFACE_DEFINITIONS,
  surfacePatch,
  validateNewRule,
  WRITABLE_SCOPE,
} from '../permissionPolicyView';

/**
 * T08-c slice 2 — the panel's judgement calls, pinned.
 *
 * The two that would not show up anywhere else if they broke:
 *
 *  - which choices are DANGEROUS. A surface that quietly stopped being flagged
 *    would drop its second confirmation, and the control would still look and
 *    behave exactly the same.
 *  - which rules the panel may DELETE. Offering a delete button on a rule from
 *    the shipped default would produce a button that cannot work — the file is
 *    inside our own read-only artifact.
 */

function scope(id: PolicyScopeId, config: PolicyScope['config'], extra: Partial<PolicyScope> = {}) {
  return { id, path: `/fake/${id}.json`, present: true, config, ...extra } satisfies PolicyScope;
}

function snapshot(
  scopes: PolicyScope[],
  overrides: Partial<PermissionPolicySnapshot> = {}
): PermissionPolicySnapshot {
  return {
    route: 'managed',
    agentDir: '/fake/agent',
    editable: true,
    scopes,
    effective: effectivePolicy(scopes),
    ...overrides,
  };
}

const SHIPPED = scope('bundled', {
  yoloMode: false,
  permission: {
    '*': 'ask',
    read: 'allow',
    write: 'ask',
    edit: 'ask',
    path: { '*': 'allow', '*.env': 'deny' },
    bash: { '*': 'ask', 'ls *': 'allow' },
    external_directory: { '*': 'ask' },
  },
});

describe('deriveScopeRows', () => {
  it('marks a scope that is present and read as active', () => {
    const [row] = deriveScopeRows([SHIPPED]);
    expect(row).toMatchObject({ id: 'bundled', status: 'active', writable: false });
  });

  it('marks the writable scope as writable and nothing else', () => {
    const rows = deriveScopeRows([SHIPPED, scope('global', {}), scope('project', {})]);
    expect(rows.filter((row) => row.writable).map((row) => row.id)).toEqual([WRITABLE_SCOPE]);
  });

  it('explains a missing file rather than hiding the scope', () => {
    const [row] = deriveScopeRows([scope('global', {}, { present: false })]);
    expect(row.status).toBe('missing');
    expect(row.detail).toContain('不存在');
  });

  it('reports a broken file with the parser’s own words', () => {
    const [row] = deriveScopeRows([scope('global', {}, { parseError: 'Unexpected token }' })]);
    expect(row).toMatchObject({ status: 'invalid', detail: 'Unexpected token }' });
  });

  /**
   * The row this panel exists for: a repository ships a policy, the managed
   * route ignores it, and nothing anywhere else would say so.
   */
  it('shows a withheld project scope as ignored, with the reason', () => {
    const [row] = deriveScopeRows([
      scope('project', { permission: { write: 'allow' } }, { withheldReason: '受管模式忽略' }),
    ]);
    expect(row).toMatchObject({ status: 'ignored', detail: '受管模式忽略' });
  });

  /** Ignored is the operative fact, but the syntax error must not vanish. */
  it('keeps a parse error visible on a scope that is also ignored', () => {
    const [row] = deriveScopeRows([
      scope('project', {}, { withheldReason: '受管模式忽略', parseError: 'bad json' }),
    ]);
    expect(row.status).toBe('ignored');
    expect(row.detail).toContain('bad json');
  });
});

describe('deriveSurfaceControls', () => {
  it('shows what the enforcer will do, and which scope decided it', () => {
    const controls = deriveSurfaceControls(
      snapshot([SHIPPED, scope('global', { permission: { write: 'allow' } })])
    );
    const byId = new Map(controls.map((control) => [control.surface, control]));
    expect(byId.get('write')).toMatchObject({
      value: 'allow',
      origin: 'global',
      overridden: true,
    });
    expect(byId.get('read')).toMatchObject({
      value: 'allow',
      origin: 'bundled',
      overridden: false,
    });
  });

  it('reads a table control from that table’s catch-all', () => {
    const controls = deriveSurfaceControls(
      snapshot([SHIPPED, scope('global', { permission: { bash: { '*': 'allow' } } })])
    );
    const bash = controls.find((control) => control.surface === 'bash');
    expect(bash).toMatchObject({ value: 'allow', origin: 'global', overridden: true });
  });

  /** A control with nothing behind it must still show the plugin's own answer. */
  it('falls back to ask when no scope mentions the surface', () => {
    const controls = deriveSurfaceControls(snapshot([scope('bundled', {})]));
    for (const control of controls) {
      expect(control.value).toBe('ask');
      expect(control.origin).toBeUndefined();
      expect(control.overridden).toBe(false);
    }
  });

  /**
   * `overridden` drives the "restore default" affordance, so it has to mean
   * "the writable scope sets THIS", not "the writable scope sets something on
   * this surface".
   */
  it('does not call a table surface overridden when only a sibling rule was added', () => {
    const controls = deriveSurfaceControls(
      snapshot([SHIPPED, scope('global', { permission: { bash: { 'npm test *': 'allow' } } })])
    );
    const bash = controls.find((control) => control.surface === 'bash');
    expect(bash).toMatchObject({ value: 'ask', origin: 'bundled', overridden: false });
  });
});

describe('the dangerous set', () => {
  /**
   * Not a style check. Each of these is a surface where `allow` removes a limit
   * with nothing behind it, and the confirmation is the only thing between a
   * misread dropdown and an agent that no longer asks.
   */
  it('flags exactly the surfaces where allow removes a real limit', () => {
    const dangerous = SURFACE_DEFINITIONS.filter((entry) => entry.dangerous).map(
      (entry) => entry.surface
    );
    expect(new Set(dangerous)).toEqual(
      new Set(['write', 'edit', 'bash', 'external_directory', 'mcp', 'skill', '*'])
    );
  });

  it('confirms only when loosening, never when tightening or clearing', () => {
    const write = SURFACE_DEFINITIONS.find((entry) => entry.surface === 'write');
    if (!write) throw new Error('the write surface must exist');
    expect(isDangerousChoice(write, 'allow')).toBe(true);
    expect(isDangerousChoice(write, 'ask')).toBe(false);
    expect(isDangerousChoice(write, 'deny')).toBe(false);
    expect(isDangerousChoice(write, null)).toBe(false);
  });

  it('never confirms on a read-only surface', () => {
    const read = SURFACE_DEFINITIONS.find((entry) => entry.surface === 'read');
    if (!read) throw new Error('the read surface must exist');
    expect(isDangerousChoice(read, 'allow')).toBe(false);
  });

  it('describes every surface it offers, so no control ships unexplained', () => {
    for (const definition of SURFACE_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });
});

describe('readActionChoice', () => {
  it('maps the three actions to themselves', () => {
    for (const action of ['allow', 'ask', 'deny'] as const) {
      expect(readActionChoice(action)).toBe(action);
    }
  });

  it('maps the sentinel to "clear my override"', () => {
    expect(readActionChoice(INHERIT_OPTION)).toBeNull();
  });

  /**
   * The failure this guard exists for. A base-ui Select can emit `null` on
   * deselect; a lenient reader would `String(null)` it into the policy file as
   * the action `"null"`. The plugin then falls through to `ask` for that
   * surface — so the symptom is extra prompts, while the setting the user chose
   * is silently gone.
   */
  it('refuses anything else, so nothing invalid can reach the policy file', () => {
    for (const value of [null, undefined, '', 'null', 'ALLOW', 'yes', 0, {}]) {
      expect(readActionChoice(value)).toBeUndefined();
    }
  });
});

describe('surfacePatch', () => {
  it('addresses a scalar surface by name', () => {
    const write = SURFACE_DEFINITIONS.find((entry) => entry.surface === 'write');
    if (!write) throw new Error('the write surface must exist');
    expect(surfacePatch(write, 'deny')).toEqual({
      entries: [{ surface: 'write', action: 'deny' }],
    });
  });

  it('addresses a table surface through its catch-all pattern', () => {
    const bash = SURFACE_DEFINITIONS.find((entry) => entry.surface === 'bash');
    if (!bash) throw new Error('the bash surface must exist');
    expect(surfacePatch(bash, null)).toEqual({
      entries: [{ surface: 'bash', pattern: '*', action: null }],
    });
  });
});

describe('deriveRuleTables', () => {
  it('lists the rules in evaluation order', () => {
    const [path] = deriveRuleTables(snapshot([SHIPPED]));
    expect(path?.surface).toBe('path');
    expect(path?.rules.map((rule) => rule.pattern)).toEqual(['*', '*.env']);
  });

  /** A delete button on a shipped rule would be a button that cannot work. */
  it('offers deletion only for rules the writable scope contributed', () => {
    const [path] = deriveRuleTables(
      snapshot([SHIPPED, scope('global', { permission: { path: { '~/vault/*': 'deny' } } })])
    );
    expect(path?.editablePatterns).toEqual(['~/vault/*']);
  });

  it('covers each declared table even when no scope defines it', () => {
    const tables = deriveRuleTables(snapshot([scope('bundled', {})]));
    expect(tables.map((table) => table.surface)).toEqual(RULE_TABLES.map((table) => table.surface));
    for (const table of tables) expect(table.rules).toEqual([]);
  });
});

describe('validateNewRule', () => {
  const rules = (patterns: string[]) =>
    patterns.map((pattern) => ({ pattern, action: 'deny' as const, origin: 'bundled' as const }));

  it('rejects an empty rule', () => {
    expect(validateNewRule([], '   ')).toMatchObject({ ok: false });
  });

  it('rejects leading or trailing space, which would silently never match', () => {
    expect(validateNewRule([], ' *.pem')).toMatchObject({ ok: false });
    expect(validateNewRule([], 'git status * ')).toMatchObject({ ok: false });
  });

  it('accepts internal spaces, because bash patterns need them', () => {
    expect(validateNewRule([], 'git status *')).toEqual({ ok: true });
  });

  /**
   * The warning that saves an afternoon: re-stating a pattern keeps its
   * ORIGINAL slot, so rules that already follow it still win.
   */
  it('warns that a duplicate keeps its old position when rules follow it', () => {
    const result = validateNewRule(rules(['*.env', '*.env.example']), '*.env');
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('第 1 条');
    expect(result.warning).toContain('后面的为准');
  });

  it('warns more mildly when nothing follows the duplicate', () => {
    const result = validateNewRule(rules(['*.env']), '*.env');
    expect(result.ok).toBe(true);
    expect(result.warning).toBe('该规则已存在，将被覆盖为新的动作');
  });
});

describe('rulePatch', () => {
  it('trims the pattern it stores', () => {
    expect(rulePatch('path', '  ~/vault/*  ', 'deny')).toEqual({
      entries: [{ surface: 'path', pattern: '~/vault/*', action: 'deny' }],
    });
  });

  it('expresses deletion as a null action', () => {
    expect(rulePatch('bash', 'npm test *', null)).toEqual({
      entries: [{ surface: 'bash', pattern: 'npm test *', action: null }],
    });
  });
});
