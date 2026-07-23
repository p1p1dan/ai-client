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
});
