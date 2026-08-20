import { describe, expect, it } from 'vitest';

import {
  BUNDLED_NODE_RUNTIME_BINARIES,
  bundledNodeRuntimeBinaryFor,
} from '../../src/shared/agentHost/nodeRuntimePin';
import { CODEX_SHIPPED_PLATFORMS } from '../codex-platform.mjs';
import {
  NODE_RUNTIME_PINS,
  NODE_RUNTIME_VERSION,
  nodeRuntimePinFor,
} from '../node-runtime-pin.mjs';

/**
 * Packaging spec C1 / C2 / C9 + the second half of A2c.
 *
 * Three tables have to agree or the packaged app is incoherent:
 *   - scripts/node-runtime-pin.mjs          which platforms get a bundled Node
 *   - scripts/codex-platform.mjs            which platforms get a bundled codex
 *   - src/shared/agentHost/nodeRuntimePin   what Main looks for at runtime
 *
 * A platform shipping codex but no Node has an agent host with nothing to run
 * it; a platform whose Main looks for the wrong binary name silently falls back
 * to machine Node. Neither shows up as a build failure, so it is pinned here.
 *
 * Lives under scripts/__tests__ rather than next to the Main-side module on
 * purpose: it imports untyped .mjs, which vitest resolves happily but tsc
 * rejects for anything inside src/ (packaging spec §9).
 */

describe('bundled Node runtime table (C9)', () => {
  it('lists exactly the platforms this build ships a runtime for', () => {
    expect(Object.keys(BUNDLED_NODE_RUNTIME_BINARIES).sort()).toEqual(['linux-x64', 'win32-x64']);
  });

  it('agrees key-for-key with the build-side pin table', () => {
    expect(Object.keys(BUNDLED_NODE_RUNTIME_BINARIES).sort()).toEqual(
      Object.keys(NODE_RUNTIME_PINS).sort()
    );
  });

  it('agrees with the build-side table on every binary name', () => {
    // Main looking for node.exe where afterPack wrote node is the exact failure
    // this pins: the resolver just skips the missing candidate and falls back
    // to machine Node, so nothing visibly breaks.
    for (const [key, outName] of Object.entries(BUNDLED_NODE_RUNTIME_BINARIES)) {
      expect(NODE_RUNTIME_PINS[key].outName).toBe(outName);
    }
  });

  it('resolves per platform and returns undefined for unbundled ones', () => {
    expect(bundledNodeRuntimeBinaryFor('win32', 'x64')).toBe('node.exe');
    expect(bundledNodeRuntimeBinaryFor('linux', 'x64')).toBe('node');
    expect(bundledNodeRuntimeBinaryFor('darwin', 'arm64')).toBeUndefined();
    expect(bundledNodeRuntimeBinaryFor('darwin', 'x64')).toBeUndefined();
    expect(bundledNodeRuntimeBinaryFor('linux', 'arm64')).toBeUndefined();
  });
});

describe('Node runtime pins vs codex ship whitelist (A2c second half, C9)', () => {
  it('has identical key sets — codex and Node ship together or not at all', () => {
    expect(Object.keys(NODE_RUNTIME_PINS).sort()).toEqual([...CODEX_SHIPPED_PLATFORMS].sort());
  });

  it('pins one shared version across every platform', () => {
    for (const pin of Object.values(NODE_RUNTIME_PINS)) {
      expect(pin.archiveName).toContain(NODE_RUNTIME_VERSION);
    }
  });

  it('C2: every sha256 is a 64-char hex digest and archives match the version', () => {
    // Shape only — never the content. A hash asserted against a literal copied
    // from the same file would assert nothing.
    for (const [key, pin] of Object.entries(NODE_RUNTIME_PINS)) {
      expect(pin.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.archiveName, key).toMatch(
        new RegExp(`^node-v${NODE_RUNTIME_VERSION.replace(/\./g, '\\.')}-`)
      );
      expect(pin.urls.length, key).toBeGreaterThanOrEqual(1);
      for (const url of pin.urls) expect(url, key).toContain(pin.archiveName);
    }
  });

  it('C1: nodeRuntimePinFor truth table', () => {
    expect(nodeRuntimePinFor('win32', 'x64').platformKey).toBe('win32-x64');
    expect(nodeRuntimePinFor('linux', 'x64').platformKey).toBe('linux-x64');
    expect(nodeRuntimePinFor('darwin', 'arm64')).toBeUndefined();
  });
});
