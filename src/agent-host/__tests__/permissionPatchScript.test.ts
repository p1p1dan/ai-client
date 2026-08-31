import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve('src/agent-host/node_modules/@gotgenes/pi-permission-system');
const patchScript = path.resolve('scripts/patch-pi-permission-system.mjs');

describe('permission package patch script', () => {
  it('is version-guarded and idempotent on an installed package copy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiclient-permission-patch-'));
    const copy = path.join(root, 'pi-permission-system');
    cpSync(packageRoot, copy, { recursive: true });
    try {
      const env = { ...process.env, AICLIENT_PI_PERMISSION_PACKAGE_ROOT: copy };
      const first = execFileSync(process.execPath, [patchScript], { env, encoding: 'utf8' });
      const second = execFileSync(process.execPath, [patchScript], { env, encoding: 'utf8' });
      expect(first).toContain('already applied');
      expect(second).toContain('already applied');

      const manager = readFileSync(path.join(copy, 'src', 'permission-manager.ts'), 'utf8');
      expect(manager).toContain('["bundled", bundledConfig]');
      expect(manager).toContain('failClosedScopes.push("bundled")');
      expect(manager).toContain('failClosedScopes.push("global")');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
