import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeDefaultPermissionPolicy } from '../permissionPolicy.mjs';

/**
 * The distributor patch, and the one thing it must no longer do.
 *
 * T028 deleted the patch group that exempted `aiclient-session-tier` from
 * upstream's bounded-delegation envelope. It was unreachable: the link was
 * registered by an inline pi extension the retired engine loaded, and T025 took
 * the `authorizerChain` line out of the shipped policy. The second case ties
 * those two facts together, because they can only be true together — a policy
 * that names a chain again needs the exemption question reopened, and the test
 * is where that question gets asked.
 */

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
      // The bundled scope is the reason the patch is still here: it is what
      // lets `permissionPolicyIntegration.test.ts` load the file we ship as
      // policy rather than as a runtime knob.
      expect(readFileSync(path.join(copy, 'src', 'rule.ts'), 'utf8')).toContain('"bundled"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships no authorizer chain, which is why the envelope exemption is gone', () => {
    // Both halves of one fact. If a future policy declares a chain again, the
    // link would run enveloped — `allow` on path / external_directory capped to
    // `defer` — and somebody has to decide whether that is what they want.
    const policy = serializeDefaultPermissionPolicy();
    expect(policy).not.toContain('authorizerChain');
    const script = readFileSync(patchScript, 'utf8');
    expect(script).not.toContain('const AICLIENT_UNENVELOPED_LINK');
    expect(script).not.toContain('encloseInDelegationEnvelope(authorize)');
  });
});
