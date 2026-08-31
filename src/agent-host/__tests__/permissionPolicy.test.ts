import { describe, expect, it } from 'vitest';
// Relative, not `@shared/…`: the agent-host tsconfig has no path aliases — the
// Host is compiled on its own and must resolve without the renderer's mapping.
import { APP_STATE_DIR } from '../../shared/defaultPaths.ts';
import {
  AICLIENT_DEFAULT_PERMISSION_POLICY as POLICY,
  serializeDefaultPermissionPolicy,
} from '../permissionPolicy.mjs';

/**
 * T08-c — the policy this app ships with (D-Q9, 2026-08-29).
 *
 * These are not style checks. Each one pins a decision whose loss would not
 * show up anywhere else: a policy that has quietly become permissive still
 * parses, still loads, and still produces a session that looks entirely normal
 * — right up until something runs that nobody approved.
 *
 * The ordering assertions matter as much as the values. Patterns are
 * LAST-MATCH-WINS, so `{ "*.env": "deny", "*": "allow" }` allows `.env`. Key
 * order in this object literal IS the policy; a reformat that sorts the keys
 * would be a security change.
 */

type Rules = Record<string, unknown>;

const permission = POLICY.permission as Record<string, unknown>;
const path = permission.path as Rules;
const bash = permission.bash as Rules;

/** Index of a key in insertion order — the order the plugin evaluates in. */
function orderOf(rules: Rules, key: string): number {
  return Object.keys(rules).indexOf(key);
}

describe('shipped permission policy — the fallbacks', () => {
  it('asks for anything no rule names', () => {
    // Covers every surface the policy does not mention, including extension
    // tools that do not exist yet.
    expect(permission['*']).toBe('ask');
  });

  it('states bash outright instead of letting it inherit', () => {
    // The plugin warns about exactly this: a config with a permissive top-level
    // `*` and no bash rule lets every command inherit it.
    expect(bash['*']).toBe('ask');
  });

  it('never ships yolo mode on', () => {
    // Yolo re-permits even the wrapper floors (`sudo`, `bash -c`, `xargs`).
    expect(POLICY.yoloMode).toBe(false);
  });

  it('keeps the approval audit log on', () => {
    expect(POLICY.permissionReviewLog).toBe(true);
  });
});

describe('shipped permission policy — the path approval/deny face (D11 rev.2)', () => {
  it('starts permissive and narrows, because the last match wins', () => {
    expect(orderOf(path, '*')).toBe(0);
  });

  it('denies env files but keeps the example template readable', () => {
    expect(path['*.env']).toBe('deny');
    expect(path['*.env.*']).toBe('deny');
    expect(path['*.env.example']).toBe('allow');
    // The carve-out is only a carve-out if it comes AFTER what it carves.
    expect(orderOf(path, '*.env.example')).toBeGreaterThan(orderOf(path, '*.env.*'));
    expect(orderOf(path, '*.env.example')).toBeGreaterThan(orderOf(path, '*.env'));
  });

  it('denies private keys wherever they are spelled', () => {
    for (const pattern of ['~/.ssh/*', '*.pem', '*.key', 'id_rsa*', '~/.aws/credentials']) {
      expect(path[pattern]).toBe('deny');
    }
  });

  it('asks for ordinary app-state access but keeps narrower secrets denied', () => {
    const appStatePattern = `~/${APP_STATE_DIR}/*`;
    expect(path[appStatePattern]).toBe('ask');
    for (const sensitive of ['*.env', '*.env.*', '~/.ssh/*', '*.pem', '*.key']) {
      expect(orderOf(path, sensitive)).toBeGreaterThan(orderOf(path, appStatePattern));
    }
  });
});

describe('shipped permission policy — 务实档 (D-Q9 decision 1)', () => {
  it('lets the agent read and search without asking', () => {
    for (const surface of ['read', 'grep', 'find', 'ls']) {
      expect(permission[surface]).toBe('allow');
    }
  });

  /**
   * `ask`, not `deny`. The plugin's own example config denies both, which for a
   * coding agent means it cannot do the thing it exists to do; and not `allow`,
   * because a confirmation is the last point at which a wrong edit is catchable.
   */
  it('confirms every change to the tree', () => {
    expect(permission.write).toBe('ask');
    expect(permission.edit).toBe('ask');
  });

  it('allows only read-only shell commands', () => {
    const allowed = Object.entries(bash)
      .filter(([, action]) => action === 'allow')
      .map(([pattern]) => pattern);
    expect(allowed.length).toBeGreaterThan(0);

    // Nothing that writes, moves, deletes, installs, or reaches the network.
    const forbidden = /^(rm|mv|cp|chmod|chown|npm|pnpm|yarn|pip|curl|wget|ssh|scp|dd|sudo)\b/;
    for (const pattern of allowed) {
      expect(pattern).not.toMatch(forbidden);
    }
    // `git` is allowed only per read-only subcommand, never wholesale.
    expect(allowed).not.toContain('git *');
    expect(allowed).toContain('git status *');
  });

  it('spells every allowed command so the bare form is covered too', () => {
    // The plugin's rule: a trailing ` *` also matches the command with no
    // arguments. Without it `git status *` would miss a bare `git status`.
    for (const [pattern, action] of Object.entries(bash)) {
      if (action !== 'allow') continue;
      expect(pattern.endsWith(' *')).toBe(true);
    }
  });

  it('allows only the MCP calls that reveal what is connected', () => {
    const mcp = permission.mcp as Rules;
    expect(mcp['*']).toBe('ask');
    for (const target of ['mcp_status', 'mcp_list', 'mcp_search', 'mcp_describe']) {
      expect(mcp[target]).toBe('allow');
    }
    // Nothing that actually invokes a server tool.
    const allowed = Object.entries(mcp).filter(([, action]) => action === 'allow');
    expect(allowed).toHaveLength(4);
  });

  it('asks before running any skill', () => {
    expect((permission.skill as Rules)['*']).toBe('ask');
  });

  it('asks before ordinary external access and avoids a duplicate `.pilab` prompt', () => {
    const external = permission.external_directory as Rules;
    expect(external['*']).toBe('ask');
    expect(external[`~/${APP_STATE_DIR}/*`]).toBe('allow');
    expect(orderOf(external, `~/${APP_STATE_DIR}/*`)).toBeGreaterThan(orderOf(external, '*'));
  });
});

describe('serializeDefaultPermissionPolicy', () => {
  it('emits parseable JSON that round-trips to the same policy', () => {
    const text = serializeDefaultPermissionPolicy();
    expect(JSON.parse(text)).toEqual(POLICY);
    // Trailing newline: the file is read by humans and diffed by git.
    expect(text.endsWith('\n')).toBe(true);
  });

  it('preserves key order through serialization', () => {
    // JSON.stringify keeps insertion order, and insertion order IS the policy.
    const reparsed = JSON.parse(serializeDefaultPermissionPolicy()) as typeof POLICY;
    expect(Object.keys(reparsed.permission.path)).toEqual(Object.keys(path));
  });

  /** The plugin refuses trailing commas and falls back to ask-everything. */
  it('emits nothing the plugin would reject', () => {
    expect(serializeDefaultPermissionPolicy()).not.toMatch(/,\s*[}\]]/);
  });
});
