import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T08-c slice 2 — which scopes are read, and which single one may be written.
 *
 * The assertion that carries the security weight is that `~/.pi/agent` is
 * NEVER the file being written. That was the T08-a red line, and before H/19
 * it was kept by refusing to write anything at all on the local route, because
 * the local route's global scope WAS the user's own directory. H/19 moved every
 * session onto this app's directory, so the red line is now kept by the
 * directory resolver — and the panel is editable in both modes, because the
 * file behind it is ours in both.
 */

let root: string;
let managed: boolean;

const workerEntry = () => join(root, 'worker', 'worker.js');
const appAgentDir = () => join(root, 'app-agent');
/** The user's own directory — still resolvable, and still never written. */
const localAgentDir = () => join(root, 'user-home', '.pi', 'agent');

vi.mock('../../agent-host/PiWorkerProcess', () => ({
  resolveCurrentPiWorkerEntryPath: () => workerEntry(),
}));
vi.mock('../../auth/credentialMode', () => ({
  resolveManagedCredentialsEnabled: () => managed,
}));
vi.mock('../../piModelConfig', () => ({
  getAppPiAgentDir: () => appAgentDir(),
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
  it('reads the bundled policy from beside the Pi worker entry', async () => {
    const { resolveScopeLocations } = await service();
    const [bundled] = resolveScopeLocations('managed', appAgentDir());
    expect(bundled?.path).toBe(
      join(root, 'worker', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json')
    );
  });

  /** Scope order IS the policy: a later scope overrides an earlier one. */
  it('lists the scopes in the order the plugin merges them', async () => {
    const { resolveScopeLocations } = await service();
    const locations = resolveScopeLocations('managed', appAgentDir(), '/repo');
    expect(locations.map((entry) => entry.id)).toEqual(['bundled', 'global', 'project']);
  });

  it('omits the project scope when no repository is open', async () => {
    const { resolveScopeLocations } = await service();
    const locations = resolveScopeLocations('managed', appAgentDir());
    expect(locations.map((entry) => entry.id)).toEqual(['bundled', 'global']);
  });

  it('withholds the project scope on the managed route only', async () => {
    const { resolveScopeLocations, PROJECT_SCOPE_WITHHELD } = await service();
    const asManaged = resolveScopeLocations('managed', appAgentDir(), '/repo');
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
      join(root, 'worker', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json'),
      { permission: { write: 'ask', read: 'allow' } }
    );
    writeJson(getGlobalPolicyPath(appAgentDir()), { permission: { write: 'deny' } });

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

  it('reports the local route as editable, against this app’s own directory', async () => {
    managed = false;
    const { readPermissionPolicy } = await service();
    const snapshot = readPermissionPolicy();
    expect(snapshot).toMatchObject({
      route: 'local',
      editable: true,
      // The point of the assertion: the local route's policy file is OURS, not
      // the one the user's own pi CLI reads.
      agentDir: appAgentDir(),
    });
    expect(snapshot.agentDir).not.toBe(localAgentDir());
    expect(snapshot.readOnlyReason).toBeUndefined();
  });
});

describe('updatePermissionPolicy', () => {
  it('writes the managed scope and returns the policy as it now stands', async () => {
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    const snapshot = updatePermissionPolicy({
      entries: [{ surface: 'write', action: 'deny' }],
    });
    expect(existsSync(getGlobalPolicyPath(appAgentDir()))).toBe(true);
    expect(snapshot.effective.surfaces.find((entry) => entry.surface === 'write')).toMatchObject({
      action: 'deny',
      origin: 'global',
    });
  });

  it('keeps keys it does not model when it rewrites the file', async () => {
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    const path = getGlobalPolicyPath(appAgentDir());
    writeJson(path, { forwardingTimeoutMs: 5000, permission: { read: 'allow' } });

    updatePermissionPolicy({ entries: [{ surface: 'write', action: 'deny' }] });
    const { readRawDocument } = await import('../policyStore');
    expect(readRawDocument(path).forwardingTimeoutMs).toBe(5000);
  });

  /**
   * The red line, as it stands after H/19: a local-route write LANDS, and it
   * lands in this app's directory. The old test asserted a refusal; asserting
   * only that now would pass for a build that had quietly started writing
   * `~/.pi` and then refused, so both halves are checked.
   */
  it('writes the local route into this app’s directory, never the user’s own', async () => {
    managed = false;
    const { updatePermissionPolicy, getGlobalPolicyPath } = await service();
    updatePermissionPolicy({ entries: [{ surface: 'write', action: 'allow' }] });
    expect(existsSync(getGlobalPolicyPath(appAgentDir()))).toBe(true);
    expect(existsSync(getGlobalPolicyPath(localAgentDir()))).toBe(false);
  });

  it('resets the local route without touching the user’s own ~/.pi', async () => {
    managed = false;
    const { resetPermissionPolicy, getGlobalPolicyPath } = await service();
    writeJson(getGlobalPolicyPath(appAgentDir()), { permission: { write: 'allow' } });
    resetPermissionPolicy();
    expect(existsSync(getGlobalPolicyPath(appAgentDir()))).toBe(false);
    expect(existsSync(getGlobalPolicyPath(localAgentDir()))).toBe(false);
  });
});

describe('resetPermissionPolicy', () => {
  it('removes the managed scope entirely, leaving the shipped default', async () => {
    const { resetPermissionPolicy, getGlobalPolicyPath } = await service();
    const path = getGlobalPolicyPath(appAgentDir());
    writeJson(
      join(root, 'worker', 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json'),
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
