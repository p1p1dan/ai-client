import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPermissionManagerProbe } from '../../../scripts/permission-policy-probe.mjs';
import { serializeDefaultPermissionPolicy } from '../permissionPolicy.mjs';

type CheckResult = {
  state: 'allow' | 'ask' | 'deny';
  origin?: string;
  matchedPattern?: string;
};

type PermissionManagerInstance = {
  configureForCwd: (cwd: string) => void;
  check: (intent: unknown, sessionRules?: unknown[]) => CheckResult;
  getConfigIssues: () => string[];
};

type PermissionManagerConstructor = new (options: {
  agentDir: string;
  bundledConfigPath: string;
}) => PermissionManagerInstance;

type AccessPathInstance = {
  matchValues: () => string[];
  boundaryValue: () => string;
  value: () => string;
  resolvedAlias: () => string | undefined;
};
type AccessPathConstructor = {
  forPath: (pathValue: string, options: { cwd: string; flavor: unknown }) => AccessPathInstance;
};

let PermissionManager: PermissionManagerConstructor;
let AccessPath: AccessPathConstructor;
let posixPathFlavor: unknown;
let cleanupProbe: () => void;
const hostRoot = path.resolve('src/agent-host');
const policyRoot = mkdtempSync(path.join(tmpdir(), 'aiclient-bundled-permission-policy-'));
const bundledConfigPath = path.join(policyRoot, 'config.json');

beforeAll(async () => {
  // npm's published package intentionally has no root config.json. Production
  // writes the distributor policy while building the worker artifact; tests
  // create the same policy explicitly so a stale local node_modules file cannot
  // make them pass while a clean CI install falls back to builtin ask.
  writeFileSync(bundledConfigPath, serializeDefaultPermissionPolicy());
  const probe = await loadPermissionManagerProbe(hostRoot);
  PermissionManager = probe.PermissionManager as PermissionManagerConstructor;
  AccessPath = probe.AccessPath as AccessPathConstructor;
  posixPathFlavor = probe.posixPathFlavor;
  cleanupProbe = probe.cleanup;
});

afterAll(() => {
  cleanupProbe?.();
  rmSync(policyRoot, { recursive: true, force: true });
});

function withManager(
  run: (manager: PermissionManagerInstance, cwd: string, agentDir: string) => void
) {
  const root = mkdtempSync(path.join(tmpdir(), 'aiclient-permission-integration-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  try {
    const manager = new PermissionManager({ agentDir, bundledConfigPath });
    manager.configureForCwd(cwd);
    run(manager, cwd, agentDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function tool(manager: PermissionManagerInstance, surface: string, input: unknown): CheckResult {
  return manager.check({ kind: 'tool', surface, input });
}

function paths(
  manager: PermissionManagerInstance,
  surface: 'path' | 'external_directory',
  values: string[]
): CheckResult {
  return manager.check({ kind: 'path-values', surface, values });
}

describe('real pi-permission-system distributor policy integration', () => {
  it('allows relative and absolute repository reads from the bundled scope', () => {
    withManager((manager, cwd) => {
      for (const filePath of ['README.md', path.join(cwd, 'README.md')]) {
        expect(tool(manager, 'read', { path: filePath })).toMatchObject({
          state: 'allow',
          origin: 'bundled',
          matchedPattern: '*',
        });
        const accessPath = AccessPath.forPath(filePath, { cwd, flavor: posixPathFlavor });
        expect(paths(manager, 'path', accessPath.matchValues())).toMatchObject({
          state: 'allow',
          origin: 'bundled',
          matchedPattern: '*',
        });
        expect(accessPath.boundaryValue()).toBe(path.join(cwd, 'README.md'));
      }
    });
  });

  it('asks for ordinary .pilab paths while narrower secrets remain denied', () => {
    withManager((manager) => {
      const settings = path.join(homedir(), '.pilab', 'default', 'settings.json');
      expect(paths(manager, 'path', [settings, '~/.pilab/default/settings.json'])).toMatchObject({
        state: 'ask',
        origin: 'bundled',
        matchedPattern: '~/.pilab/*',
      });

      const envFile = path.join(homedir(), '.pilab', 'default', '.env');
      expect(paths(manager, 'path', [envFile, '~/.pilab/default/.env'])).toMatchObject({
        state: 'deny',
        origin: 'bundled',
        matchedPattern: '*.env',
      });
    });
  });

  it('canonicalizes symlinks before the external-directory boundary decision', () => {
    withManager((_manager, cwd) => {
      const outside = path.join(path.dirname(cwd), 'outside');
      mkdirSync(outside);
      const outsideFile = path.join(outside, 'note.txt');
      writeFileSync(outsideFile, 'outside');
      const linked = path.join(cwd, 'linked-note.txt');
      symlinkSync(outsideFile, linked);

      const accessPath = AccessPath.forPath('linked-note.txt', {
        cwd,
        flavor: posixPathFlavor,
      });
      expect(accessPath.value()).toBe(linked);
      expect(accessPath.boundaryValue()).toBe(realpathSync(outsideFile));
      expect(accessPath.resolvedAlias()).toBe(realpathSync(outsideFile));
      expect(accessPath.matchValues()).toEqual(
        expect.arrayContaining(['linked-note.txt', linked, realpathSync(outsideFile)])
      );
      expect(accessPath.boundaryValue().startsWith(`${cwd}${path.sep}`)).toBe(false);
    });
  });

  it('asks for ordinary external paths but does not add a second .pilab prompt', () => {
    withManager((manager) => {
      expect(paths(manager, 'external_directory', ['/tmp/outside.txt'])).toMatchObject({
        state: 'ask',
        origin: 'bundled',
        matchedPattern: '*',
      });
      expect(
        paths(manager, 'external_directory', [
          path.join(homedir(), '.pilab', 'default', 'settings.json'),
          '~/.pilab/default/settings.json',
        ])
      ).toMatchObject({
        state: 'allow',
        origin: 'bundled',
        matchedPattern: '~/.pilab/*',
      });
    });
  });

  it('keeps a session approval above bundled ask without persisting it', () => {
    withManager((manager) => {
      expect(tool(manager, 'write', { path: 'a.ts' })).toMatchObject({
        state: 'ask',
        origin: 'bundled',
        matchedPattern: '*',
      });
      expect(
        manager.check({ kind: 'tool', surface: 'write', input: { path: 'a.ts' } }, [
          {
            surface: 'write',
            pattern: '*',
            action: 'allow',
            layer: 'session',
            origin: 'session',
          },
        ])
      ).toMatchObject({ state: 'allow', origin: 'session', matchedPattern: '*' });
      expect(tool(manager, 'write', { path: 'a.ts' })).toMatchObject({
        state: 'ask',
        origin: 'bundled',
      });
    });
  });

  it('keeps user/global policy above the bundled baseline', () => {
    withManager((manager, cwd, agentDir) => {
      const globalDir = path.join(agentDir, 'extensions', 'pi-permission-system');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        path.join(globalDir, 'config.json'),
        `${JSON.stringify({ permission: { read: 'ask' } }, null, 2)}\n`
      );
      manager.configureForCwd(cwd);
      expect(tool(manager, 'read', { path: 'README.md' })).toMatchObject({
        state: 'ask',
        origin: 'global',
        matchedPattern: '*',
      });
    });
  });

  it('fails closed when a malformed global policy would otherwise inherit bundled allow', () => {
    withManager((manager, cwd, agentDir) => {
      const globalDir = path.join(agentDir, 'extensions', 'pi-permission-system');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(path.join(globalDir, 'config.json'), '{ malformed json');
      manager.configureForCwd(cwd);

      expect(tool(manager, 'read', { path: 'README.md' })).toMatchObject({
        state: 'ask',
        origin: 'fail-closed',
        matchedPattern: '*',
      });
      expect(manager.getConfigIssues().join('\n')).toContain('global configuration');
    });
  });

  it('falls back to builtin ask when the distributor policy is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiclient-permission-missing-bundle-'));
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    mkdirSync(cwd);
    mkdirSync(agentDir);
    try {
      const manager = new PermissionManager({
        agentDir,
        bundledConfigPath: path.join(root, 'missing-config.json'),
      });
      manager.configureForCwd(cwd);
      expect(tool(manager, 'read', { path: 'README.md' })).toMatchObject({
        state: 'ask',
        origin: 'builtin',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
