import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T08-c slice 2 — which scopes are read, and which single one may be written.
 *
 * The assertion that carries the security weight is the LOCAL-ROUTE REFUSAL.
 * On "use my own setup", the global scope is the user's own `~/.pi/agent` — the
 * directory their `pi` CLI reads — and writing it to make this app behave would
 * change a tool we do not own (the T08-a red line). A silent no-op would be
 * worse than the write: the panel would report success and the user would
 * believe a policy they do not have.
 */

let root: string;
let managed: boolean;

const hostEntry = () => join(root, 'host', 'index.js');
const managedAgentDir = () => join(root, 'managed-agent');
const localAgentDir = () => join(root, 'user-home', '.pi', 'agent');

vi.mock('../../agent-host/AgentHostManager', () => ({
  resolveHostEntryPath: () => hostEntry(),
}));
vi.mock('../../auth/credentialMode', () => ({
  resolveManagedCredentialsEnabled: () => managed,
}));
vi.mock('../../piModelConfig', () => ({
  getManagedPiAgentDir: () => managedAgentDir(),
  getLocalPiAgentDir: () => localAgentDir(),
}));

async function service() {
  return import('../index');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiclient-policy-svc-'));
  managed = true;
  vi.resetModules();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scope locations', () => {
  it('reads the bundled policy from beside the Host entry, where the Host injects it', async () => {
    const { resolveScopeLocations } = await service();
    const [bundled] = resolveScopeLocations('managed', managedAgentDir());
    expect(bundled?.path).toBe(
      join(root, 'host', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json')
    );
  });

  /** Scope order IS the policy: a later scope overrides an earlier one. */
  it('lists the scopes in the order the plugin merges them', async () => {
    const { resolveScopeLocations } = await service();
    const locations = resolveScopeLocations('managed', managedAgentDir(), '/repo');
    expect(locations.map((entry) => entry.id)).toEqual(['bundled', 'global', 'project']);
  });

  it('omits the project scope when no repository is open', async () => {
    const { resolveScopeLocations } = await service();
    const locations = resolveScopeLocations('managed', managedAgentDir());
    expect(locations.map((entry) => entry.id)).toEqual(['bundled', 'global']);
  });

  it('withholds the project scope on the managed route only', async () => {
    const { resolveScopeLocations, PROJECT_SCOPE_WITHHELD } = await service();
    const asManaged = resolveScopeLocations('managed', managedAgentDir(), '/repo');
    const asLocal = resolveScopeLocations('local', localAgentDir(), '/repo');
    expect(asManaged.at(-1)?.withheldReason).toBe(PROJECT_SCOPE_WITHHELD);
    expect(asLocal.at(-1)?.withheldReason).toBeUndefined();
  });

  it('points the global scope at the plugin’s own config location', async () => {
    const { getGlobalPolicyPath, getProjectPolicyPath } = await service();
    expect(getGlobalPolicyPath('/agent')).toBe(
      join('/agent', 'extensions', 'pi-permission-system', 'config.json')
    );
    expect(getProjectPolicyPath('/repo')).toBe(
      join('/repo', '.pi', 'extensions', 'pi-permission-system', 'config.json')
    );
  });
});

describe('readPermissionPolicy', () => {
  it('merges the scopes it can read and says which one decided what', async () => {
    const { readPermissionPolicy, getGlobalPolicyPath } = await service();
    writeJson(
      join(root, 'host', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json'),
      { permission: { write: 'ask', read: 'allow' } }
    );
    writeJson(getGlobalPolicyPath(managedAgentDir()), { permission: { write: 'deny' } });

    const snapshot = readPermissionPolicy();
    const write = snapshot.effective.surfaces.find((entry) => entry.surface === 'write');
    expect(write).toMatchObject({ action: 'deny', origin: 'global' });
    expect(snapshot.editable).toBe(true);
    expect(snapshot.readOnlyReason).toBeUndefined();
  });

  it('reads a repository’s policy but keeps it out of the merge on the managed route', async () => {
    const { readPermissionPolicy } = await service();
    const repo = join(root, 'repo');
    writeJson(join(repo, '.pi', 'extensions', 'pi-permission-system', 'config.json'), {
      permission: { write: 'allow' },
    });

    const snapshot = readPermissionPolicy(repo);
    const project = snapshot.scopes.find((scope) => scope.id === 'project');
    expect(project?.present).toBe(true);
    expect(project?.withheldReason).toBeTruthy();
    // Read for display, absent from the answer.
    expect(snapshot.effective.surfaces.find((entry) => entry.surface === 'write')).toBeUndefined();
  });

  it('lets a repository’s policy through on the local route', async () => {
    managed = false;
    const { readPermissionPolicy } = await service();
    const repo = join(root, 'repo');
    writeJson(join(repo, '.pi', 'extensions', 'pi-permission-system', 'config.json'), {
      permission: { write: 'allow' },
    });

    const snapshot = readPermissionPolicy(repo);
    expect(snapshot.effective.surfaces.find((entry) => entry.surface === 'write')).toMatchObject({
      action: 'allow',
      origin: 'project',
    });
  });

  it('reports the local route as read-only, and says why', async () => {
    managed = false;
    const { readPermissionPolicy, LOCAL_ROUTE_READ_ONLY } = await service();
    const snapshot = readPermissionPolicy();
    expect(snapshot).toMatchObject({
      route: 'local',
      editable: false,
      readOnlyReason: LOCAL_ROUTE_READ_ONLY,
      agentDir: localAgentDir(),
    });
  });
});

describe('updatePermissionPolicy', () => {
  it('writes the managed scope and returns the policy as it now stands', async () => {
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    const snapshot = updatePermissionPolicy({
      entries: [{ surface: 'write', action: 'deny' }],
    });
    expect(existsSync(getGlobalPolicyPath(managedAgentDir()))).toBe(true);
    expect(snapshot.effective.surfaces.find((entry) => entry.surface === 'write')).toMatchObject({
      action: 'deny',
      origin: 'global',
    });
  });

  it('keeps keys it does not model when it rewrites the file', async () => {
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    const path = getGlobalPolicyPath(managedAgentDir());
    writeJson(path, { forwardingTimeoutMs: 5000, permission: { read: 'allow' } });

    updatePermissionPolicy({ entries: [{ surface: 'write', action: 'deny' }] });
    const { readRawDocument } = await import('../policyStore');
    expect(readRawDocument(path).forwardingTimeoutMs).toBe(5000);
  });

  /**
   * The red line. A rejection reaches the panel as an error the user reads; a
   * silent no-op reads as a save that worked.
   */
  it('refuses to write the user’s own ~/.pi on the local route', async () => {
    managed = false;
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    expect(() =>
      updatePermissionPolicy({ entries: [{ surface: 'write', action: 'allow' }] })
    ).toThrow(/Read-only/);
    expect(existsSync(getGlobalPolicyPath(localAgentDir()))).toBe(false);
  });

  it('refuses to reset the user’s own ~/.pi on the local route', async () => {
    managed = false;
    const { resetPermissionPolicy } = await service();
    expect(() => resetPermissionPolicy()).toThrow(/Read-only/);
  });
});

describe('resetPermissionPolicy', () => {
  it('removes the managed scope entirely, leaving the shipped default', async () => {
    const { resetPermissionPolicy, getGlobalPolicyPath } = await service();
    const path = getGlobalPolicyPath(managedAgentDir());
    writeJson(
      join(root, 'host', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json'),
      { permission: { write: 'ask' } }
    );
    writeJson(path, { permission: { write: 'allow' } });

    const snapshot = resetPermissionPolicy();
    // Deleted, not emptied: an empty file would still claim a scope.
    expect(existsSync(path)).toBe(false);
    expect(snapshot.effective.surfaces.find((entry) => entry.surface === 'write')).toMatchObject({
      action: 'ask',
      origin: 'bundled',
    });
  });
});
