import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BRIDGE_ENTRIES,
  binaryFormat,
  binaryMatchesTarget,
  bridgeBuildOptions,
  checkBridgeMetafile,
  checkHostMetafile,
  collectLicenses,
  DSH_HOST_LICENSES,
  DSH_HOST_MANIFEST,
  executablePaths,
  fixExecutableBits,
  hostBuildOptions,
  isDocumentationMarkdown,
  isLicenseFileName,
  LICENSE_FILE_REQUIRED,
  materializeLinks,
  npmCiArgs,
  preflightDshHost,
  pruneReason,
  pruneTree,
  requiredFiles,
  requiredNatives,
  unknownBundleFiles,
  verifyDshArtifact,
} from '../dsh-host-build-lib.mjs';

/**
 * dsh-rebase P1-2 — the DSH host artifact rules (decisions 011, 013, 014).
 *
 * The pruning rules are deletion rules, so the dangerous answer is "delete" to
 * a directory that holds something the host loads. Every package directory the
 * host needs is asked about AS A DIRECTORY here (the walker asks directories
 * first and never looks inside one it deleted), and the full fixture walk below
 * proves the must-haves survive a real prune — the inverse of the agent-host
 * allowlist trap, where answering only file paths skipped whole packages while
 * the tests stayed green.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = path.join(repoRoot, 'src', 'dsh-host');
const LINUX = { platform: 'linux', arch: 'x64' };
const WIN = { platform: 'win32', arch: 'x64' };
const MAC = { platform: 'darwin', arch: 'arm64' };

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-artifact-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file, content = 'x', mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Header bytes the format sniffer reads, for a binary of `target`. */
function nativeBytes(target) {
  const bytes = Buffer.alloc(256);
  if (target.platform === 'win32') {
    bytes.write('MZ', 0, 'latin1');
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write('PE\0\0', 0x80, 'latin1');
    bytes.writeUInt16LE(target.arch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
    bytes.writeUInt16LE(0x20b, 0x80 + 24);
  } else if (target.platform === 'linux') {
    bytes.write('\x7fELF', 0, 'latin1');
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(target.arch === 'arm64' ? 183 : 62, 18);
  } else {
    bytes.writeUInt32BE(0xcffaedfe, 0);
    bytes.writeUInt32LE(target.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  }
  return bytes;
}

/** Paths of every native `requiredNatives(target)` asks for. */
function nativePaths(target) {
  const key = `${target.platform}-${target.arch}`;
  const narb = { linux: `${key}-gnu`, win32: `${key}-msvc`, darwin: key }[target.platform];
  const paths = [
    `node_modules/node-addon-require-builtin-${narb}/prebuilt/${narb}-napi-v9.node`,
    `node_modules/@koromix/koffi-${key}/${key.replace('-', '_')}/koffi.node`,
    `node_modules/@vscode/ripgrep-${key}/bin/rg${target.platform === 'win32' ? '.exe' : ''}`,
    `node_modules/@img/sharp-${key}/lib/sharp-${key}-0.35.4.node`,
  ];
  if (target.platform === 'win32') {
    return [
      ...paths,
      `node_modules/node-pty/prebuilds/${key}/conpty.node`,
      `node_modules/node-pty/prebuilds/${key}/conpty_console_list.node`,
      `node_modules/node-pty/prebuilds/${key}/conpty/OpenConsole.exe`,
      `node_modules/node-pty/prebuilds/${key}/conpty/conpty.dll`,
      `node_modules/@img/sharp-${key}/lib/libvips-42.dll`,
    ];
  }
  paths.push(
    `node_modules/node-pty/prebuilds/${key}/pty.node`,
    `node_modules/@deepseek-ai/node-addon-system-${key}/bin/${target.platform === 'linux' ? 'glibc/' : ''}system.node`
  );
  if (target.platform === 'linux') {
    return [
      ...paths,
      `node_modules/@deepseek-ai/node-addon-system-${key}/bin/landlock-run`,
      `node_modules/@img/sharp-libvips-${key}/lib/libvips-cpp.so.8.18.6`,
    ];
  }
  return [
    ...paths,
    `node_modules/node-pty/prebuilds/${key}/spawn-helper`,
    `node_modules/@img/sharp-libvips-${key}/lib/libvips-cpp.8.18.6.dylib`,
  ];
}

const pkg = (name, extra = {}) => ({ name, version: '1.0.0', license: 'MIT', ...extra });

/** A minimal artifact for `target` that passes verification, before any pruning noise. */
function buildArtifact(root, target) {
  write(path.join(root, 'host.js'), '// host\n');
  writeJson(path.join(root, 'package.json'), pkg('@aiclient/dsh-host'));
  for (const rel of requiredFiles(target)) {
    if (rel === 'host.js' || rel === 'package.json' || rel === DSH_HOST_LICENSES) continue;
    const file = path.join(root, ...rel.split('/'));
    if (rel.endsWith('/package.json')) writeJson(file, pkg(rel.split('/').slice(1, -1).join('/')));
    else write(file, `// ${rel}\n`);
  }
  const app = path.join(root, 'node_modules', '@aiclient', 'dsh-app');
  write(
    path.join(app, 'cordis.patch.yml'),
    "- insert:\n    - id: aiclient-bridge\n      name: '@aiclient/dsh-app/bridge'\n"
  );
  for (const item of BRIDGE_ENTRIES) {
    write(path.join(app, 'lib', path.basename(item.out)), `export const name = '${item.row}';\n`);
  }
  for (const name of LICENSE_FILE_REQUIRED) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    writeJson(path.join(dir, 'package.json'), pkg(name));
    write(path.join(dir, 'LICENSE'), 'MIT License\n');
  }
  for (const rel of nativePaths(target)) {
    write(path.join(root, ...rel.split('/')), nativeBytes(target), 0o755);
  }
  const key = `${target.platform}-${target.arch}`;
  for (const name of [
    `@koromix/koffi-${key}`,
    `@vscode/ripgrep-${key}`,
    `@img/sharp-${key}`,
    'node-pty',
    ...(target.platform === 'win32'
      ? []
      : [`@img/sharp-libvips-${key}`, `@deepseek-ai/node-addon-system-${key}`]),
    `node-addon-require-builtin-${{ linux: `${key}-gnu`, win32: `${key}-msvc`, darwin: key }[target.platform]}`,
  ]) {
    writeJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), pkg(name));
  }
  writeLicenses(root);
}

function writeLicenses(root) {
  writeJson(path.join(root, DSH_HOST_LICENSES), { schema: 1, packages: collectLicenses(root) });
}

/** What npm leaves that B-tier pruning must take out, for `target` (a linux-x64 tree here). */
function addPruneNoise(root) {
  const nm = (rel, content = 'x') =>
    write(path.join(root, 'node_modules', ...rel.split('/')), content);
  nm('.bin/tsc');
  nm('.package-lock.json', '{}');
  nm('node-pty/prebuilds/darwin-arm64/pty.node', nativeBytes(MAC));
  nm('node-pty/prebuilds/win32-x64/conpty.pdb');
  nm('node-pty/third_party/conpty/1.25/win10-x64/OpenConsole.exe', nativeBytes(WIN));
  nm('node-pty/src/unix/pty.cc');
  nm('@img/sharp-wasm32/lib/sharp-wasm32.node.wasm');
  nm('@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node', nativeBytes(LINUX));
  nm('@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.6', nativeBytes(LINUX));
  nm('@emnapi/runtime/package.json', JSON.stringify(pkg('@emnapi/runtime')));
  nm('@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node', nativeBytes(LINUX));
  nm('@koromix/koffi-linux-x64/musl_x64/koffi.node', nativeBytes(LINUX));
  nm(
    'pnpm/dist/node_modules/@reflink/reflink-darwin-arm64/reflink.darwin-arm64.node',
    nativeBytes(MAC)
  );
  nm('pnpm/dist/vendor/fastlist-0.3.0-x64.exe', nativeBytes(WIN));
  nm('pnpm/dist/node_modules/node-gyp/src/win_delay_load_hook.cc');
  nm('@deepseek-ai/dsh-base/lib/index.js.map');
  nm('@deepseek-ai/dsh-base/lib/types/index.d.ts');
  nm('@deepseek-ai/dsh-spill-policy/lib/types/notice.d.ts');
  nm('@deepseek-ai/dsh-base/README.md');
  nm('@deepseek-ai/dsh-base/README.zh.md');
  nm('undici/docs/docs/api/Agent.md');
  nm('koffi/src/koffi/src/call.cc');
  nm('koffi/src/koffi/index.js', 'export {};\n');
}

describe('pruneReason keeps every package directory the host loads', () => {
  const keptDirs = [
    'node_modules/@deepseek-ai',
    'node_modules/@deepseek-ai/dsh-base',
    'node_modules/@deepseek-ai/dsh-skill-badge/assets',
    'node_modules/@aiclient/dsh-app',
    'node_modules/@aiclient/dsh-app/lib',
    'node_modules/koffi',
    'node_modules/koffi/src',
    'node_modules/koffi/src/koffi',
    'node_modules/node-pty',
    'node_modules/node-pty/lib',
    'node_modules/node-pty/prebuilds',
    'node_modules/pnpm',
    'node_modules/pnpm/dist',
    'node_modules/pnpm/dist/node_modules',
    'node_modules/pnpm/dist/node_modules/@reflink',
    'node_modules/@img',
    'node_modules/@img/colour',
    'node_modules/sharp',
    'node_modules/sharp/src',
    'node_modules/@vscode',
    'node_modules/@koromix',
  ];

  for (const target of [LINUX, WIN, MAC]) {
    const key = `${target.platform}-${target.arch}`;
    it(`answers null for every needed directory on ${key}`, () => {
      const own = [
        `node_modules/node-pty/prebuilds/${key}`,
        `node_modules/@img/sharp-${key}`,
        `node_modules/@koromix/koffi-${key}`,
        `node_modules/@vscode/ripgrep-${key}`,
        `node_modules/@vscode/ripgrep-${key}/bin`,
        ...(target.platform === 'win32'
          ? [
              'node_modules/node-pty/third_party',
              'node_modules/node-pty/third_party/conpty/1.25/win10-x64',
              'node_modules/pnpm/dist/vendor',
            ]
          : [
              `node_modules/@img/sharp-libvips-${key}`,
              `node_modules/@deepseek-ai/node-addon-system-${key}/bin`,
            ]),
      ];
      for (const rel of [...keptDirs, ...own]) {
        expect(pruneReason(rel, 'dir', target), rel).toBeNull();
      }
    });
  }

  it('keeps the linux glibc builds while dropping musl', () => {
    expect(
      pruneReason('node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc', 'dir', LINUX)
    ).toBeNull();
    expect(pruneReason('node_modules/@koromix/koffi-linux-x64/linux_x64', 'dir', LINUX)).toBeNull();
    expect(
      pruneReason('node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl', 'dir', LINUX)
    ).not.toBeNull();
    expect(
      pruneReason('node_modules/@koromix/koffi-linux-x64/musl_x64', 'dir', LINUX)
    ).not.toBeNull();
  });

  it('never deletes a whole package through a file-shaped rule', () => {
    // A directory named like a documentation or source file must stay a directory question.
    expect(pruneReason('node_modules/readme.md', 'dir', LINUX)).toBeNull();
    expect(pruneReason('node_modules/foo.map', 'dir', LINUX)).toBeNull();
    expect(pruneReason('node_modules/@scope/lib.d.ts', 'dir', LINUX)).toBeNull();
  });

  it('only rules on node_modules', () => {
    for (const rel of ['host.js', 'package.json', 'README.md', 'x.map']) {
      expect(pruneReason(rel, 'file', LINUX)).toBeNull();
    }
  });
});

describe('pruneReason removes the B-tier payload', () => {
  it('drops foreign and all-platform payloads per target', () => {
    expect(
      pruneReason('node_modules/node-pty/prebuilds/darwin-arm64', 'dir', LINUX)
    ).not.toBeNull();
    expect(pruneReason('node_modules/node-pty/prebuilds/linux-x64', 'dir', MAC)).not.toBeNull();
    expect(pruneReason('node_modules/node-pty/third_party', 'dir', LINUX)).not.toBeNull();
    expect(
      pruneReason('node_modules/node-pty/third_party/conpty/1.25/win10-arm64', 'dir', WIN)
    ).not.toBeNull();
    expect(pruneReason('node_modules/@img/sharp-wasm32', 'dir', WIN)).not.toBeNull();
    expect(pruneReason('node_modules/@img/sharp-linuxmusl-x64', 'dir', LINUX)).not.toBeNull();
    expect(
      pruneReason('node_modules/@img/sharp-libvips-linuxmusl-x64', 'dir', LINUX)
    ).not.toBeNull();
    expect(pruneReason('node_modules/@img/sharp-linux-x64', 'dir', MAC)).not.toBeNull();
    expect(pruneReason('node_modules/@emnapi', 'dir', LINUX)).not.toBeNull();
    expect(
      pruneReason('node_modules/pnpm/dist/node_modules/@reflink/reflink-darwin-arm64', 'dir', LINUX)
    ).not.toBeNull();
    expect(
      pruneReason('node_modules/pnpm/dist/node_modules/@reflink/reflink-darwin-arm64', 'dir', MAC)
    ).toBeNull();
    expect(
      pruneReason('node_modules/pnpm/dist/node_modules/@reflink/reflink-win32-x64-msvc', 'dir', WIN)
    ).toBeNull();
    expect(pruneReason('node_modules/pnpm/dist/vendor', 'dir', LINUX)).not.toBeNull();
    expect(
      pruneReason('node_modules/pnpm/dist/vendor/fastlist-0.3.0-x86.exe', 'file', WIN)
    ).not.toBeNull();
    expect(
      pruneReason('node_modules/pnpm/dist/vendor/fastlist-0.3.0-x64.exe', 'file', WIN)
    ).toBeNull();
    expect(pruneReason('node_modules/a/.bin', 'dir', LINUX)).not.toBeNull();
  });

  it("keeps the permission row's wasm and drops tree-sitter's native payload (P1-6b)", () => {
    for (const target of [LINUX, MAC, WIN]) {
      for (const rel of [
        'node_modules/tree-sitter-bash/prebuilds',
        'node_modules/tree-sitter-bash/src',
        'node_modules/web-tree-sitter/debug',
      ]) {
        expect(pruneReason(rel, 'dir', target), rel).not.toBeNull();
      }
      for (const rel of [
        'node_modules/web-tree-sitter/web-tree-sitter.wasm',
        'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
      ]) {
        expect(pruneReason(rel, 'file', target), rel).toBeNull();
      }
      expect(pruneReason('node_modules/tree-sitter-bash', 'dir', target)).toBeNull();
      expect(pruneReason('node_modules/web-tree-sitter', 'dir', target)).toBeNull();
    }
  });

  it('drops maps, declarations, debug symbols, documentation and native sources', () => {
    for (const rel of [
      'node_modules/a/index.js.map',
      'node_modules/a/index.d.ts',
      'node_modules/a/index.d.mts',
      'node_modules/a/tsconfig.tsbuildinfo',
      'node_modules/node-pty/prebuilds/win32-x64/conpty.pdb',
      'node_modules/a/README.md',
      'node_modules/a/README.zh.md',
      'node_modules/a/CHANGELOG.md',
      'node_modules/undici/docs/docs/api/Agent.md',
      'node_modules/koffi/doc/start.md',
      'node_modules/sharp/src/pipeline.cc',
      'node_modules/node-addon-api/napi.h',
      'node_modules/sharp/src/binding.gyp',
    ]) {
      expect(pruneReason(rel, 'file', LINUX), rel).not.toBeNull();
    }
  });

  it('keeps licences, runtime Markdown, the libvips README and code', () => {
    for (const rel of [
      'node_modules/a/LICENSE',
      'node_modules/a/LICENSE.md',
      'node_modules/a/license.txt',
      'node_modules/a/NOTICE',
      'node_modules/a/COPYING.LESSER',
      'node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md',
      'node_modules/@img/sharp-libvips-linux-x64/README.md',
      'node_modules/@img/sharp-libvips-linux-x64/versions.json',
      'node_modules/koffi/src/koffi/index.js',
      'node_modules/pnpm/dist/node_modules/node-gyp/src/win_delay_load_hook.cc',
      'node_modules/pnpm/dist/node_modules/node-gyp/addon.gypi',
    ]) {
      expect(pruneReason(rel, 'file', LINUX), rel).toBeNull();
    }
  });

  it('treats code named after a licence as code', () => {
    expect(isLicenseFileName('notice.d.ts')).toBe(false);
    expect(isLicenseFileName('license.js')).toBe(false);
    expect(isLicenseFileName('LICENSE-MIT')).toBe(true);
    expect(pruneReason('node_modules/x/lib/types/notice.d.ts', 'file', LINUX)).not.toBeNull();
    expect(isDocumentationMarkdown('node_modules/x/assets/prompt.md')).toBe(false);
  });
});

describe('pruneTree over a whole fixture', () => {
  it('keeps every must-have and passes verification afterwards', () => {
    buildArtifact(tmp, LINUX);
    addPruneNoise(tmp);
    const pruned = pruneTree(tmp, LINUX);
    expect(pruned.removedFiles).toBeGreaterThan(15);
    for (const rel of [
      ...requiredFiles(LINUX),
      ...nativePaths(LINUX),
      'node_modules/koffi/src/koffi/index.js',
    ]) {
      expect(fs.existsSync(path.join(tmp, ...rel.split('/'))), rel).toBe(true);
    }
    for (const rel of [
      'node_modules/.bin',
      'node_modules/.package-lock.json',
      'node_modules/node-pty/prebuilds/darwin-arm64',
      'node_modules/node-pty/third_party',
      'node_modules/node-pty/src',
      'node_modules/@img/sharp-wasm32',
      'node_modules/@img/sharp-linuxmusl-x64',
      'node_modules/@emnapi',
      'node_modules/pnpm/dist/vendor',
      'node_modules/@deepseek-ai/dsh-spill-policy/lib/types/notice.d.ts',
    ]) {
      expect(fs.existsSync(path.join(tmp, ...rel.split('/'))), rel).toBe(false);
    }
    writeLicenses(tmp);
    expect(() => verifyDshArtifact({ outDir: tmp, target: LINUX })).not.toThrow();
  });

  it('prunes a darwin tree and restores spawn-helper', () => {
    buildArtifact(tmp, MAC);
    const helper = path.join(
      tmp,
      'node_modules',
      'node-pty',
      'prebuilds',
      'darwin-arm64',
      'spawn-helper'
    );
    fs.chmodSync(helper, 0o644);
    pruneTree(tmp, MAC);
    expect(fixExecutableBits(tmp, MAC)).toEqual([
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    ]);
    if (process.platform !== 'win32') expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
    expect(executablePaths(MAC)).toContain(
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
    );
    expect(() => verifyDshArtifact({ outDir: tmp, target: MAC })).not.toThrow();
  });

  it('passes a win32 tree', () => {
    buildArtifact(tmp, WIN);
    expect(() => verifyDshArtifact({ outDir: tmp, target: WIN })).not.toThrow();
  });
});

describe('verifyDshArtifact rejects', () => {
  const failsWith = (pattern) =>
    expect(() => verifyDshArtifact({ outDir: tmp, target: LINUX })).toThrow(pattern);

  beforeEach(() => buildArtifact(tmp, LINUX));

  it('a symbolic link', () => {
    fs.symlinkSync(path.join(tmp, 'host.js'), path.join(tmp, 'node_modules', 'link.js'));
    failsWith(/symbolic link: node_modules\/link\.js/);
  });

  it('a binary for another platform', () => {
    write(path.join(tmp, 'node_modules', 'x', 'x.node'), nativeBytes(WIN));
    failsWith(/x\.node is PE32\+ x64, not linux-x64/);
  });

  it('an extensionless executable for another platform', () => {
    write(path.join(tmp, 'node_modules', 'x', 'bin', 'tool'), nativeBytes(MAC));
    failsWith(/tool is Mach-O 64 arm64/);
  });

  it('debug symbols and source maps', () => {
    write(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.pdb'));
    failsWith(/must not ship node_modules\/node-pty\/prebuilds\/linux-x64\/pty\.pdb/);
  });

  it('a missing must-have native', () => {
    fs.rmSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'));
    failsWith(/missing node-pty native for linux-x64/);
  });

  it('a missing licence list', () => {
    fs.rmSync(path.join(tmp, DSH_HOST_LICENSES));
    failsWith(/missing THIRD_PARTY_LICENSES\.json/);
  });

  it('a licence list that misses a package', () => {
    writeJson(path.join(tmp, 'node_modules', 'late', 'package.json'), pkg('late'));
    failsWith(/misses 1 package\(s\): node_modules\/late/);
  });

  it('a package without a license field', () => {
    writeJson(path.join(tmp, 'node_modules', 'bare', 'package.json'), {
      name: 'bare',
      version: '1.0.0',
    });
    writeLicenses(tmp);
    failsWith(/node_modules\/bare has no license field/);
  });

  it('a required package without its licence text', () => {
    fs.rmSync(path.join(tmp, 'node_modules', 'pnpm', 'LICENSE'));
    writeLicenses(tmp);
    failsWith(/node_modules\/pnpm ships without a licence file/);
  });

  it('the probe row or the probe plugin in the product bundle (decision 015)', () => {
    const app = path.join(tmp, 'node_modules', '@aiclient', 'dsh-app');
    fs.appendFileSync(
      path.join(app, 'cordis.patch.yml'),
      "    - id: aiclient-probe\n      name: '@aiclient/dsh-app'\n"
    );
    write(path.join(app, 'lib', 'index.js'), "export const name = 'aiclient-probe';\n");
    failsWith(/aiclient-probe/);
  });

  it('a host.js that still loads its TypeScript lib (P1-3a)', () => {
    write(path.join(tmp, 'host.js'), "import { PRODUCT_BUNDLES } from './lib/hostProfile.ts';\n");
    failsWith(/host\.js still loads TypeScript sources/);
  });

  it('a bridge that still loads TypeScript sources', () => {
    write(
      path.join(tmp, 'node_modules', '@aiclient', 'dsh-app', 'lib', 'bridge.js'),
      "export * from '../../bridge/plugin.ts';\n"
    );
    failsWith(/bundle\/lib\/bridge\.js still loads TypeScript sources/);
  });

  it('a runtime asset lost to the Markdown sweep', () => {
    fs.rmSync(
      path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh-skill-badge', 'assets', 'dsh-badge.md')
    );
    failsWith(/missing node_modules\/@deepseek-ai\/dsh-skill-badge\/assets\/dsh-badge\.md/);
  });

  it.skipIf(process.platform === 'win32')('an executable without its exec bit', () => {
    fs.chmodSync(
      path.join(tmp, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg'),
      0o644
    );
    failsWith(/ripgrep-linux-x64\/bin\/rg is not executable/);
  });

  it('a packaged copy without its manifest, or built for another target', () => {
    expect(() => verifyDshArtifact({ outDir: tmp, target: LINUX, requireManifest: true })).toThrow(
      new RegExp(`missing ${DSH_HOST_MANIFEST}`)
    );
    writeJson(path.join(tmp, DSH_HOST_MANIFEST), {
      schema: 1,
      target: { platform: 'darwin', arch: 'arm64' },
    });
    expect(() => verifyDshArtifact({ outDir: tmp, target: LINUX, requireManifest: true })).toThrow(
      /manifest target darwin-arm64 is not linux-x64/
    );
  });
});

describe('binaryFormat', () => {
  it('reads PE, ELF, Mach-O and universal headers', () => {
    expect(binaryFormat(nativeBytes(WIN))).toEqual({ format: 'PE32+', arch: 'x64' });
    expect(binaryFormat(nativeBytes(LINUX))).toEqual({ format: 'ELF64', arch: 'x64' });
    expect(binaryFormat(nativeBytes(MAC))).toEqual({ format: 'Mach-O 64', arch: 'arm64' });
    const fat = Buffer.alloc(64);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8);
    fat.writeUInt32BE(0x0100000c, 28);
    const universal = binaryFormat(fat);
    expect(universal.format).toBe('Mach-O universal');
    expect(binaryMatchesTarget(universal, MAC)).toBe(true);
  });

  it('does not mistake a Java class or text for a binary', () => {
    const javaClass = Buffer.alloc(64);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt32BE(0x00000034, 4);
    expect(binaryFormat(javaClass)).toBeNull();
    expect(
      binaryFormat(
        Buffer.from('MZ is just text here, no PE header follows at all ................')
      )
    ).toBeNull();
  });

  it('matches only the target', () => {
    expect(binaryMatchesTarget(binaryFormat(nativeBytes(LINUX)), LINUX)).toBe(true);
    expect(binaryMatchesTarget(binaryFormat(nativeBytes(LINUX)), MAC)).toBe(false);
    expect(
      binaryMatchesTarget(binaryFormat(nativeBytes({ platform: 'linux', arch: 'arm64' })), LINUX)
    ).toBe(false);
    expect(binaryMatchesTarget(null, WIN)).toBe(false);
  });

  it('has a must-have list per supported target', () => {
    for (const target of [LINUX, WIN, MAC, { platform: 'darwin', arch: 'x64' }]) {
      expect(requiredNatives(target).length).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('install and staging', () => {
  it('never omits optional dependencies (decision 013)', () => {
    const native = npmCiArgs(LINUX, LINUX);
    expect(native).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    const rehearsal = npmCiArgs(WIN, LINUX);
    expect(rehearsal).toContain('--os=win32');
    expect(rehearsal).toContain('--cpu=x64');
    for (const args of [native, rehearsal]) {
      expect(args.some((arg) => arg.startsWith('--omit'))).toBe(false);
      expect(args).not.toContain('--install-links');
    }
  });

  it('materializes the file: bundle link and refuses one that leaves the stage', () => {
    write(path.join(tmp, 'stage', 'bundle', 'package.json'), '{}');
    fs.mkdirSync(path.join(tmp, 'stage', 'node_modules', '@aiclient'), { recursive: true });
    const link = path.join(tmp, 'stage', 'node_modules', '@aiclient', 'dsh-app');
    fs.symlinkSync(path.join(tmp, 'stage', 'bundle'), link, 'junction');
    expect(materializeLinks(path.join(tmp, 'stage'))).toEqual([
      { name: '@aiclient/dsh-app', from: 'bundle' },
    ]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(link, 'package.json'))).toBe(true);

    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(
      path.join(tmp, 'elsewhere'),
      path.join(tmp, 'stage', 'node_modules', 'outside'),
      'junction'
    );
    expect(() => materializeLinks(path.join(tmp, 'stage'))).toThrow(
      /links outside the staging directory/
    );
  });

  it('knows every file of the product bundle', () => {
    expect(unknownBundleFiles(sourceDir)).toEqual([]);
  });

  it('passes the preflight on the committed sources and refuses a range or a stale peer', () => {
    expect(preflightDshHost(sourceDir).dshPin).toMatch(/^\d+\.\d+\.\d+/);
    const copy = path.join(tmp, 'src');
    fs.mkdirSync(path.join(copy, 'bundle'), { recursive: true });
    for (const rel of ['package.json', 'package-lock.json', 'bundle/package.json']) {
      fs.copyFileSync(path.join(sourceDir, ...rel.split('/')), path.join(copy, ...rel.split('/')));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
    manifest.dependencies.pnpm = `^${manifest.dependencies.pnpm}`;
    writeJson(path.join(copy, 'package.json'), manifest);
    const bundle = JSON.parse(fs.readFileSync(path.join(copy, 'bundle', 'package.json'), 'utf8'));
    bundle.peerDependencies['@deepseek-ai/dsh-llm'] = '0.0.1';
    writeJson(path.join(copy, 'bundle', 'package.json'), bundle);
    expect(() => preflightDshHost(copy)).toThrow(/pnpm must be an exact version[\s\S]*bundle peer/);
  });
});

describe('the host bundle (P1-3a)', () => {
  it('takes in host.ts and its lib/ only, and leaves DSH to the artifact', async () => {
    const outDir = path.join(tmp, 'artifact');
    const result = await build(hostBuildOptions(sourceDir, outDir));
    const verdict = checkHostMetafile(result.metafile, repoRoot);
    expect(verdict.failures).toEqual([]);
    expect(verdict.inputs.sort()).toEqual([
      'src/dsh-host/host.ts',
      'src/dsh-host/lib/hostProfile.ts',
    ]);
    expect(verdict.externals.filter((name) => !name.startsWith('node:'))).toEqual([
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-launch-environment',
    ]);
    const text = fs.readFileSync(path.join(outDir, 'host.js'), 'utf8');
    expect(text).not.toMatch(/from\s+['"][^'"]+\.ts['"]/);
    expect(text).toContain('function reconcileProductBundles(');
  });

  it('flags a host bundle that took in anything else', () => {
    const { failures } = checkHostMetafile(
      {
        inputs: { 'src/dsh-host/host.ts': {}, 'src/shared/types/workerRpc.ts': {} },
        outputs: { 'host.js': { imports: [{ path: 'zod', external: true }] } },
      },
      repoRoot
    );
    expect(failures).toEqual([
      'host bundle took in src/shared/types/workerRpc.ts',
      'host bundle imports zod at run time',
    ]);
  });
});

describe('bridge bundles (decision 011)', () => {
  it('flags inputs from node_modules and unexpected run-time imports', () => {
    const { failures } = checkBridgeMetafile(
      {
        inputs: { 'src/dsh-host/bridge/plugin.ts': {}, 'node_modules/zod/index.js': {} },
        outputs: {
          'x.js': {
            imports: [
              { path: 'node:fs', external: true },
              { path: 'zod', external: true },
            ],
          },
        },
      },
      repoRoot
    );
    expect(failures).toEqual([
      'bridge bundle took in node_modules/zod/index.js',
      'bridge bundle imports zod at run time',
    ]);
  });

  /** What each row injects; anything else is a change to its contract with DSH. */
  const ROW_INJECT = {
    'aiclient-bridge': ['agents', 'agentDefaultModel', 'sessions', 'agentLoop', 'sessionQuery'],
    'aiclient-permissions': ['tools'],
  };

  it('flags a permission row bundle that imports anything but web-tree-sitter', () => {
    const permissions = BRIDGE_ENTRIES.find((item) => item.row === 'aiclient-permissions');
    const { failures } = checkBridgeMetafile(
      {
        inputs: {
          'src/dsh-host/permissions/plugin.ts': {},
          'src/shared/permissions/gate.ts': {},
          'src/agent-host/permissionPolicy.mjs': {},
          'src/dsh-host/bridge/plugin.ts': {},
        },
        outputs: {
          'x.js': {
            imports: [
              { path: 'web-tree-sitter', external: true },
              { path: '@deepseek-ai/dsh-llm', external: true },
            ],
          },
        },
      },
      repoRoot,
      permissions
    );
    expect(failures).toEqual([
      'bridge bundle took in src/dsh-host/bridge/plugin.ts',
      'bridge bundle imports @deepseek-ai/dsh-llm at run time',
    ]);
  });

  for (const item of BRIDGE_ENTRIES) {
    it(`builds ${item.out} that imports with only its npm externals present`, async () => {
      const outDir = path.join(tmp, 'artifact');
      const stubRoot = path.join(outDir, 'node_modules', '@deepseek-ai', 'dsh-llm');
      writeJson(path.join(stubRoot, 'package.json'), {
        name: '@deepseek-ai/dsh-llm',
        type: 'module',
        exports: './index.js',
      });
      write(
        path.join(stubRoot, 'index.js'),
        'export function createUserMessage(input) { return { id: "m1", ...input }; }\n'
      );
      const options = bridgeBuildOptions(sourceDir, outDir, item);
      // The artifact keeps it inside the materialized bundle package.
      options.outfile = path.join(
        outDir,
        'node_modules',
        '@aiclient',
        'dsh-app',
        'lib',
        path.basename(item.out)
      );
      const result = await build(options);
      expect(checkBridgeMetafile(result.metafile, repoRoot, item).failures).toEqual([]);
      const text = fs.readFileSync(options.outfile, 'utf8');
      expect(text).not.toMatch(/from\s+['"][^'"]+\.ts['"]/);
      const row = await import(pathToFileURL(options.outfile).href);
      expect(row.name).toBe(item.row);
      expect(row.inject).toEqual(ROW_INJECT[item.row]);
      expect(typeof row.apply).toBe('function');
    });
  }
});
