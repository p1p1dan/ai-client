import { describe, expect, it } from 'vitest';
import { REQUIRED_NODE_MAJOR, resolveNode24Runtime } from '../NodeRuntimeResolver';

describe('resolveNode24Runtime', () => {
  it('requires major version 24', () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24);
  });

  it('rejects missing explicit path and reports candidates', async () => {
    const result = await resolveNode24Runtime({
      explicitPath: 'D:\\definitely-not-a-node\\node.exe',
      pathEnv: '',
      homeDir: 'D:\\no-home-for-nvm',
      platform: 'win32',
      extraCandidates: [],
      useProcessEnv: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Node 24/);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.some((c) => c.reason === 'not-found')).toBe(true);
  });

  it('accepts a real Node 24 binary when present on this machine', async () => {
    // Dev machine may or may not have Node 24; skip soft-fail if absent.
    const result = await resolveNode24Runtime();
    if (!result.ok) {
      expect(result.error).toBeTruthy();
      return;
    }
    expect(result.runtime?.major).toBe(24);
    expect(result.runtime?.version).toMatch(/^v24\./);
    expect(result.runtime?.execPath.length).toBeGreaterThan(0);
  });

  it('probes bundledPath ahead of machine discovery, below explicit', async () => {
    // All candidates are nonexistent — assert ordering via the inspected list.
    const result = await resolveNode24Runtime({
      explicitPath: 'D:\\no-such\\explicit\\node.exe',
      bundledPath: 'D:\\no-such\\resources\\node-runtime\\node.exe',
      pathEnv: 'D:\\no-such-path-dir',
      homeDir: 'D:\\no-home-for-nvm',
      platform: 'win32',
      useProcessEnv: false,
    });
    expect(result.ok).toBe(false);
    const order = result.candidates.map((c) => c.path);
    const explicitIdx = order.findIndex((p) => p.includes('explicit'));
    const bundledIdx = order.findIndex((p) => p.includes('node-runtime'));
    const pathIdx = order.findIndex((p) => p.includes('no-such-path-dir'));
    expect(explicitIdx).toBeGreaterThanOrEqual(0);
    expect(bundledIdx).toBeGreaterThan(explicitIdx);
    expect(pathIdx).toBeGreaterThan(bundledIdx);
  });

  it('resolves a valid bundledPath with source bundled', async () => {
    // Use this machine's own Node binary as a stand-in bundled runtime; the
    // assertion is conditional on it actually being a v24 (soft elsewhere).
    const result = await resolveNode24Runtime({
      bundledPath: process.execPath,
      pathEnv: '',
      homeDir: 'D:\\no-home-for-nvm',
      platform: 'win32',
      useProcessEnv: false,
    });
    if (result.ok) {
      expect(result.runtime?.source).toBe('bundled');
      expect(result.runtime?.major).toBe(24);
    } else {
      // Machine node is not v24 — the bundled candidate must still have been probed.
      expect(result.candidates.some((c) => c.reason.startsWith('major-'))).toBe(true);
    }
  });
});
