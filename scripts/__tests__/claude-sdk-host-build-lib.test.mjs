import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildManifest,
  CLAUDE_SDK_HOST_LICENSES,
  CLAUDE_SDK_HOST_MANIFEST,
  checkHostMetafile,
  checkLockedSdk,
  checkSdkEntry,
  cliBinaryRel,
  cliPackageName,
  keptPackages,
  licenseReferences,
  npmCiArgs,
  pruneReason,
  pruneTree,
  SDK_PACKAGE,
  sdkEntryOf,
  topLevelPackages,
  verifyClaudeSdkHostArtifact,
} from '../claude-sdk-host-build-lib.mjs';
import {
  CLAUDE_SDK_HOST_ARTIFACT_MAX_BYTES,
  CLAUDE_SDK_HOST_ARTIFACT_MAX_FILES,
  CLAUDE_SDK_HOST_ARTIFACT_TARGET_BYTES,
  evaluateClaudeSdkHostArtifact,
} from '../packaging-budget.mjs';

/**
 * Route B S-4 (topic s4-packaging.md B-2, B-3, B-7, B-8): the Claude Agent SDK
 * host artifact. The pruning keeps exactly the SDK and the target's CLI; the
 * verifier is what afterPack and verify-packaged-app run on every copy.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINUX = { platform: 'linux', arch: 'x64' };
const WIN = { platform: 'win32', arch: 'x64' };

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sdk-host-artifact-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel, content = 'x', root = tmp) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** The header of an executable for `target` (what `binaryFormat` reads). */
function nativeBytes(target) {
  const bytes = Buffer.alloc(256);
  if (target.platform === 'win32') {
    bytes.write('MZ', 0, 'latin1');
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write('PE\0\0', 0x80, 'latin1');
    bytes.writeUInt16LE(0x8664, 0x84);
    bytes.writeUInt16LE(0x20b, 0x80 + 24);
  } else {
    bytes.write('\x7fELF', 0, 'latin1');
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(62, 18);
  }
  return bytes;
}

/** A minimal artifact for `target`, as the build leaves it before the manifest. */
function artifact(target, root = tmp) {
  write('host.js', 'export {};', root);
  write('package.json', '{"type":"module"}', root);
  write(`node_modules/${SDK_PACKAGE}/package.json`, '{"name":"sdk","version":"0.3.300"}', root);
  write(`node_modules/${SDK_PACKAGE}/sdk.mjs`, 'export {};', root);
  const cli = write(cliBinaryRel(target), nativeBytes(target), root);
  if (target.platform !== 'win32') fs.chmodSync(cli, 0o755);
  return root;
}

describe('the CLI package (B-3, B-4)', () => {
  it('names one package and binary per target, glibc on Linux', () => {
    expect(cliPackageName(WIN)).toBe('@anthropic-ai/claude-agent-sdk-win32-x64');
    expect(cliBinaryRel(WIN)).toBe(
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
    );
    expect(cliBinaryRel(LINUX)).toBe(
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
    );
    expect(keptPackages(LINUX)).toEqual([SDK_PACKAGE, '@anthropic-ai/claude-agent-sdk-linux-x64']);
  });
});

describe('npmCiArgs', () => {
  it('omits peers, never the optional CLI, and names a foreign target only', () => {
    const own = npmCiArgs(WIN, WIN);
    expect(own).toContain('--omit=peer');
    expect(own.join(' ')).not.toContain('--omit=optional');
    expect(own.some((arg) => arg.startsWith('--os'))).toBe(false);
    expect(npmCiArgs(LINUX, WIN)).toEqual(expect.arrayContaining(['--os=linux', '--cpu=x64']));
  });
});

describe('pruneReason', () => {
  it('keeps the SDK and the target CLI, drops other CLIs and peer leftovers', () => {
    expect(pruneReason(`node_modules/${SDK_PACKAGE}`, 'dir', LINUX)).toBeNull();
    expect(
      pruneReason('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', 'dir', LINUX)
    ).toBeNull();
    expect(
      pruneReason('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl', 'dir', LINUX)
    ).toMatch(/another platform or libc/);
    expect(
      pruneReason('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64', 'dir', LINUX)
    ).toMatch(/another platform/);
    expect(pruneReason('node_modules/express', 'dir', WIN)).toMatch(/not used at run time/);
    expect(pruneReason('node_modules/@hono/node-server', 'dir', WIN)).toMatch(
      /not used at run time/
    );
    expect(pruneReason('node_modules/.bin', 'dir', WIN)).toMatch(/bin links/);
    expect(pruneReason('node_modules/.package-lock.json', 'file', WIN)).toMatch(/hidden lockfile/);
  });

  it('drops declarations, maps and docs, keeps licences and the files a licence field names', () => {
    const sdk = `node_modules/${SDK_PACKAGE}`;
    expect(pruneReason(`${sdk}/sdk.d.ts`, 'file', WIN)).toMatch(/declaration/);
    expect(pruneReason(`${sdk}/sdk.mjs.map`, 'file', WIN)).toMatch(/source map/);
    expect(pruneReason(`${sdk}/README.md`, 'file', WIN)).toBe('documentation');
    expect(pruneReason(`${sdk}/LICENSE.md`, 'file', WIN)).toBeNull();
    expect(pruneReason(`${sdk}/sdk.mjs`, 'file', WIN)).toBeNull();
    expect(pruneReason(`${sdk}/README.md`, 'file', WIN, new Set([`${sdk}/README.md`]))).toBeNull();
    // Outside node_modules nothing is pruned.
    expect(pruneReason('host.js', 'file', WIN)).toBeNull();
  });
});

describe('pruneTree', () => {
  it('leaves the SDK, the CLI and the licence text the SDK points at', () => {
    artifact(WIN);
    write(
      `node_modules/${SDK_PACKAGE}/package.json`,
      JSON.stringify({ name: SDK_PACKAGE, version: '0.3.300', license: 'SEE LICENSE IN README.md' })
    );
    write(`node_modules/${SDK_PACKAGE}/README.md`, 'licence terms');
    write(`node_modules/${SDK_PACKAGE}/sdk.d.ts`, 'export {};');
    write('node_modules/express/index.js');
    write('node_modules/@hono/node-server/index.js');
    write('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    expect([...licenseReferences(tmp)]).toEqual([`node_modules/${SDK_PACKAGE}/README.md`]);
    const pruned = pruneTree(tmp, WIN);
    expect(topLevelPackages(tmp)).toEqual(keptPackages(WIN).sort());
    expect(fs.existsSync(path.join(tmp, 'node_modules', '@hono'))).toBe(false);
    expect(
      fs.existsSync(path.join(tmp, 'node_modules', ...SDK_PACKAGE.split('/'), 'README.md'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmp, 'node_modules', ...SDK_PACKAGE.split('/'), 'sdk.d.ts'))
    ).toBe(false);
    expect(pruned.removedDirectories.map((item) => item.rel).sort()).toEqual([
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
      'node_modules/@hono/node-server',
      'node_modules/express',
    ]);
  });
});

describe('checkHostMetafile (B-2)', () => {
  const metafile = (inputs, externals) => ({
    inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
    outputs: { 'host.js': { imports: externals.map((item) => ({ path: item, external: true })) } },
  });

  it('accepts the host, the shared libraries and the bridge, with the SDK and built-ins external', () => {
    const verdict = checkHostMetafile(
      metafile(
        [
          'src/claude-sdk-host/host.ts',
          'src/shared/planReview.ts',
          'src/dsh-host/bridge/bridgeRpcServer.ts',
        ],
        [SDK_PACKAGE, 'node:fs', 'fs', 'child_process']
      ),
      repoRoot
    );
    expect(verdict.failures).toEqual([]);
  });

  it('refuses tools, tests, other directories, npm sources and other run-time packages', () => {
    const verdict = checkHostMetafile(
      metafile(
        [
          'src/claude-sdk-host/tools/host-probe.ts',
          'src/claude-sdk-host/__tests__/x.test.ts',
          'src/main/index.ts',
          'src/shared/node_modules/zod/index.js',
        ],
        ['zod', '@anthropic-ai/sdk']
      ),
      repoRoot
    );
    expect(verdict.failures).toHaveLength(6);
  });

  it('the real bundle passes (23 inputs, the SDK external)', async () => {
    const { build } = await import('esbuild');
    const { hostBuildOptions } = await import('../claude-sdk-host-build-lib.mjs');
    const result = await build({ ...hostBuildOptions(repoRoot, tmp), write: false });
    const verdict = checkHostMetafile(result.metafile, repoRoot);
    expect(verdict.failures).toEqual([]);
    expect(verdict.externals.filter((item) => !item.startsWith('node:'))).toEqual([SDK_PACKAGE]);
  });
});

describe('the SDK entry (B-3)', () => {
  it('is what an import of the package loads', () => {
    expect(sdkEntryOf({ exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } } })).toBe(
      'sdk.mjs'
    );
    expect(sdkEntryOf({ exports: { '.': { import: './esm.mjs', require: './cjs.js' } } })).toBe(
      'esm.mjs'
    );
    expect(sdkEntryOf({ exports: './x.mjs' })).toBe('x.mjs');
    expect(sdkEntryOf({ main: 'main.js' })).toBe('main.js');
  });

  it('fails an entry that imports a package, through its own chunks too', async () => {
    const { default: esbuild } = await import('esbuild');
    const sdk = `node_modules/${SDK_PACKAGE}`;
    write(`${sdk}/package.json`, JSON.stringify({ exports: { '.': { default: './sdk.mjs' } } }));
    write(
      `${sdk}/sdk.mjs`,
      ["import fs from 'node:fs';", "export const a = () => import('./chunk.mjs');"].join('\n')
    );
    write(`${sdk}/chunk.mjs`, ["import { z } from 'zod/v4';", 'export const b = z;'].join('\n'));
    const verdict = await checkSdkEntry(tmp, esbuild);
    expect(verdict.failures).toEqual([
      `${SDK_PACKAGE}/sdk.mjs imports zod/v4 at run time; review B-3`,
    ]);
    write(`${sdk}/chunk.mjs`, ["import os from 'os';", 'export const b = os;'].join('\n'));
    expect((await checkSdkEntry(tmp, esbuild)).failures).toEqual([]);
  });
});

describe('checkLockedSdk', () => {
  const lock = (entry) => ({ packages: { [`node_modules/${SDK_PACKAGE}`]: entry } });

  it('wants the pin and no dependencies of the SDK itself', () => {
    expect(
      checkLockedSdk(lock({ version: '0.3.300', peerDependencies: { zod: '^4' } }), '0.3.300')
    ).toEqual([]);
    expect(checkLockedSdk(lock({ version: '0.3.299' }), '0.3.300')[0]).toMatch(/not 0\.3\.300/);
    expect(
      checkLockedSdk(lock({ version: '0.3.300', dependencies: { ws: '^8' } }), '0.3.300')[0]
    ).toMatch(/now depends on ws; review B-3/);
  });

  it('the committed lockfile passes', () => {
    const source = path.join(repoRoot, 'src', 'claude-sdk-host');
    const pin = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).dependencies[
      SDK_PACKAGE
    ];
    const committed = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
    expect(checkLockedSdk(committed, pin)).toEqual([]);
  });
});

describe('verifyClaudeSdkHostArtifact', () => {
  const manifestFor = (target, cli) =>
    buildManifest({
      target,
      appVersion: '1.0.0',
      sdkVersion: '0.3.300',
      cliPackage: cliPackageName(target),
      cliVersion: '0.3.300',
      cli,
      gitCommit: 'abc',
      builtOn: {},
      builtAt: 'now',
      lockSha256: 'x',
      stats: { bytes: 1, files: 1, longestRelativePath: 1 },
      packages: 2,
      pruned: {},
    });

  it('passes a complete tree and returns the CLI digest', () => {
    artifact(WIN);
    const result = verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN });
    expect(result.cli.rel).toBe(cliBinaryRel(WIN));
    expect(result.cli.sha256).toMatch(/^[0-9a-f]{64}$/);
    write(CLAUDE_SDK_HOST_MANIFEST, JSON.stringify(manifestFor(WIN, result.cli)));
    write(CLAUDE_SDK_HOST_LICENSES, '{}');
    expect(() =>
      verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN, requireManifest: true })
    ).not.toThrow();
  });

  it('refuses a missing CLI, an extra package and a CLI for another platform', () => {
    artifact(WIN);
    write('node_modules/express/index.js');
    write(cliBinaryRel(WIN), nativeBytes(LINUX));
    expect(() => verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN })).toThrow(
      /node_modules holds .*express[\s\S]*claude\.exe is ELF64 x64, not for win32-x64/
    );
    fs.rmSync(path.join(tmp, ...cliBinaryRel(WIN).split('/')));
    expect(() => verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN })).toThrow(
      /missing node_modules\/@anthropic-ai\/claude-agent-sdk-win32-x64\/claude\.exe/
    );
  });

  it('refuses a manifest for another target or another CLI', () => {
    artifact(WIN);
    const { cli } = verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN });
    write(CLAUDE_SDK_HOST_LICENSES, '{}');
    write(CLAUDE_SDK_HOST_MANIFEST, JSON.stringify(manifestFor(LINUX, cli)));
    expect(() =>
      verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN, requireManifest: true })
    ).toThrow(/manifest names linux-x64, not win32-x64/);
    write(
      CLAUDE_SDK_HOST_MANIFEST,
      JSON.stringify(manifestFor(WIN, { ...cli, sha256: '0'.repeat(64) }))
    );
    expect(() =>
      verifyClaudeSdkHostArtifact({ outDir: tmp, target: WIN, requireManifest: true })
    ).toThrow(/does not match the manifest/);
  });

  it.runIf(process.platform !== 'win32')('refuses a Linux CLI without its execute bit', () => {
    artifact(LINUX);
    fs.chmodSync(path.join(tmp, ...cliBinaryRel(LINUX).split('/')), 0o644);
    expect(() => verifyClaudeSdkHostArtifact({ outDir: tmp, target: LINUX })).toThrow(
      /no execute bit/
    );
  });
});

describe('the size budget (B-7)', () => {
  it('passes one CLI, fails a second one or too many files, reports the target', () => {
    const mib = 1024 * 1024;
    expect(evaluateClaudeSdkHostArtifact({ bytes: 263 * mib, files: 19 }).status).toBe('ok');
    expect(evaluateClaudeSdkHostArtifact({ bytes: 263 * mib, files: 19 }).overTarget).toBe(false);
    // The musl CLI or another platform's beside this one.
    expect(evaluateClaudeSdkHostArtifact({ bytes: 520 * mib, files: 22 }).reasons).toEqual([
      'bytes',
    ]);
    // The peers' leftovers coming back (measured 2,786 files).
    expect(evaluateClaudeSdkHostArtifact({ bytes: 270 * mib, files: 2_800 }).reasons).toEqual([
      'files',
    ]);
    expect(CLAUDE_SDK_HOST_ARTIFACT_TARGET_BYTES).toBeLessThan(CLAUDE_SDK_HOST_ARTIFACT_MAX_BYTES);
    // Well under the plan's installed increment of 0.6 GB.
    expect(CLAUDE_SDK_HOST_ARTIFACT_MAX_BYTES).toBeLessThan(0.6 * 1024 * mib);
    expect(CLAUDE_SDK_HOST_ARTIFACT_MAX_FILES).toBeLessThan(2_800);
  });
});
