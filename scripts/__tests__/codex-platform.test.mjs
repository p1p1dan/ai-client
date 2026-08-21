import { describe, expect, it } from 'vitest';

import {
  CODEX_PLATFORM_DIRS,
  CODEX_SHIPPED_PLATFORMS,
  codexBinaryName,
  codexPlatformKey,
  codexPlatformPkgCandidates,
  codexPlatformPkgLeafName,
  codexTargetTriple,
  isCodexShippedPlatform,
  isForeignCodexPlatformPath,
} from '../codex-platform.mjs';

/**
 * Packaging spec §7.1 A1 / A2 / A2b / A2c.
 *
 * Assertion discipline (spec §3.2): every expectation below is a hand-written
 * literal. Deriving an expectation from the function under test would make the
 * double-scope class of defect (B-2) pass on both sides and assert nothing.
 */

describe('codex platform matrix (A1)', () => {
  it('maps all six platform keys to the upstream target triples verbatim', () => {
    // Source of truth: @openai/codex@0.145.0 bin/codex.js:16-23.
    expect(CODEX_PLATFORM_DIRS).toEqual({
      'linux-x64': 'x86_64-unknown-linux-musl',
      'linux-arm64': 'aarch64-unknown-linux-musl',
      'darwin-x64': 'x86_64-apple-darwin',
      'darwin-arm64': 'aarch64-apple-darwin',
      'win32-x64': 'x86_64-pc-windows-msvc',
      'win32-arm64': 'aarch64-pc-windows-msvc',
    });
  });

  it('derives platform keys, leaf names and triples per platform', () => {
    expect(codexPlatformKey('win32', 'x64')).toBe('win32-x64');
    expect(codexPlatformKey('linux', 'x64')).toBe('linux-x64');

    expect(codexPlatformPkgLeafName('win32', 'x64')).toBe('codex-win32-x64');
    expect(codexPlatformPkgLeafName('linux', 'x64')).toBe('codex-linux-x64');
    expect(codexPlatformPkgLeafName('darwin', 'arm64')).toBe('codex-darwin-arm64');

    expect(codexTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(codexTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(codexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
  });

  it('throws rather than guessing on an unknown platform key', () => {
    expect(() => codexTargetTriple('sunos', 'sparc')).toThrow(/unknown platform key "sunos-sparc"/);
  });

  it('names the binary codex.exe only on win32', () => {
    expect(codexBinaryName('win32')).toBe('codex.exe');
    expect(codexBinaryName('linux')).toBe('codex');
    expect(codexBinaryName('darwin')).toBe('codex');
  });
});

describe('ship whitelist (A2c)', () => {
  it('ships codex for exactly win32-x64 and linux-x64', () => {
    expect(CODEX_SHIPPED_PLATFORMS).toEqual(['win32-x64', 'linux-x64']);
  });

  it('excludes mac from the ship whitelist', () => {
    expect(isCodexShippedPlatform('win32', 'x64')).toBe(true);
    expect(isCodexShippedPlatform('linux', 'x64')).toBe(true);
    expect(isCodexShippedPlatform('darwin', 'arm64')).toBe(false);
    expect(isCodexShippedPlatform('darwin', 'x64')).toBe(false);
    expect(isCodexShippedPlatform('linux', 'arm64')).toBe(false);
    expect(isCodexShippedPlatform('win32', 'arm64')).toBe(false);
  });

  // The other half of A2c — key-set equality against NODE_RUNTIME_PINS — landed
  // with P3/D36 and lives in ./node-runtime-pin.test.mjs, where all three
  // tables (Node pins, codex whitelist, Main's runtime lookup) are pinned
  // against each other in one place (spec C9).
});

describe('codexPlatformPkgCandidates (A2b — kills the double-scope defect)', () => {
  it('returns the two candidate paths verbatim for win32-x64', () => {
    expect(codexPlatformPkgCandidates('win32', 'x64')).toEqual([
      '@openai/codex-win32-x64',
      '@openai/codex/node_modules/@openai/codex-win32-x64',
    ]);
  });

  it('returns the two candidate paths verbatim for linux-x64', () => {
    expect(codexPlatformPkgCandidates('linux', 'x64')).toEqual([
      '@openai/codex-linux-x64',
      '@openai/codex/node_modules/@openai/codex-linux-x64',
    ]);
  });

  it('never emits a doubled @openai scope', () => {
    for (const rel of codexPlatformPkgCandidates('win32', 'x64')) {
      expect(rel).not.toContain('@openai/@openai');
    }
  });
});

describe('isForeignCodexPlatformPath (A2)', () => {
  it('flags a foreign platform package in the hoisted layout', () => {
    expect(isForeignCodexPlatformPath('@openai/codex-darwin-arm64/vendor/x', 'win32', 'x64')).toBe(
      true
    );
  });

  it('flags a foreign platform package in the nested layout', () => {
    // topPackage() only reads the first two segments, so this is the arm that
    // catches the nested escape hatch (spec §3.4-1).
    expect(
      isForeignCodexPlatformPath(
        '@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/x',
        'win32',
        'x64'
      )
    ).toBe(true);
  });

  it('passes the current platform in both layouts', () => {
    expect(isForeignCodexPlatformPath('@openai/codex-win32-x64/vendor/x', 'win32', 'x64')).toBe(
      false
    );
    expect(
      isForeignCodexPlatformPath(
        '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x',
        'win32',
        'x64'
      )
    ).toBe(false);
  });

  it('passes the main package entry point', () => {
    expect(isForeignCodexPlatformPath('@openai/codex/bin/codex.js', 'win32', 'x64')).toBe(false);
  });

  it('does not match a lookalike package name', () => {
    expect(isForeignCodexPlatformPath('@openai/codexfoo/x', 'win32', 'x64')).toBe(false);
    expect(isForeignCodexPlatformPath('@openai/codex-nonsense/x', 'win32', 'x64')).toBe(false);
  });
});
