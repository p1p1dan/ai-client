/**
 * Build the P0-4 encrypted-machine kit (dsh-rebase plan) on a Linux box.
 *
 *   node src/dsh-host/p0-4/build-kit.mjs [--platform win32|linux] [--out <dir>] [--no-zip]
 *
 * Layout of `<out>/aiclient-p0-4-kit/`:
 *   run-p0-4.ps1          one-click script (UTF-8 BOM + CRLF for Windows PowerShell 5.1)
 *   kit-manifest.json     versions, native binaries (format + sha256), sizes
 *   host/                 src/dsh-host sources + node_modules for the target platform
 *   gateway/              the local fake model gateway
 *
 * The dependency tree comes from `npm ci` against src/dsh-host/package-lock.json
 * with `--os/--cpu` set to the target, `--install-links` (the file: bundle is
 * copied, not symlinked) and `--ignore-scripts` (every native binary used
 * ships prebuilt in an npm package; no install script may run for a foreign
 * platform). Other-platform prebuilds, `.bin` links, source maps and type
 * declarations are pruned, then every .node / .dll / .exe is checked to be the
 * target format (PE32+ x86-64 for win32, ELF64 x86-64 for linux). Any
 * mismatch, symlink or missing native module fails the build.
 * `--platform linux` builds the same kit for a Linux dry run.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hostSrc = resolve(here, '..');
const repoRoot = resolve(hostSrc, '..', '..');
const gatewaySrc = join(
  repoRoot,
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
);

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const platform = option('platform', 'win32');
if (platform !== 'win32' && platform !== 'linux')
  throw new Error('--platform must be win32 or linux');
const outRoot = resolve(option('out', `/var/tmp/aiclient-p0-4-kit-${platform}`));
const kitName = 'aiclient-p0-4-kit';
const kit = join(outRoot, kitName);
const host = join(kit, 'host');
const log = (message) => process.stderr.write(`[build-kit] ${message}\n`);

function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(path);
    else if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 'PE32+ x86-64', 'PE32 i386', 'ELF64 x86-64', ... read from the header bytes. */
function binaryFormat(file) {
  const bytes = readFileSync(file);
  if (bytes.length > 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') return 'MZ without PE';
    const machine = bytes.readUInt16LE(pe + 4);
    const magic = bytes.readUInt16LE(pe + 24);
    const arch =
      { 34404: 'x86-64', 332: 'i386', 43620: 'arm64' }[machine] ?? `0x${machine.toString(16)}`;
    return `${magic === 0x20b ? 'PE32+' : 'PE32'} ${arch}`;
  }
  if (bytes.length > 20 && bytes.toString('latin1', 0, 4) === '\x7fELF') {
    const machine = bytes.readUInt16LE(18);
    const arch = { 62: 'x86-64', 183: 'arm64' }[machine] ?? `0x${machine.toString(16)}`;
    return `${bytes[4] === 2 ? 'ELF64' : 'ELF32'} ${arch}`;
  }
  if (bytes.length > 4 && [0xfeedfacf, 0xcffaedfe].includes(bytes.readUInt32BE(0))) return 'Mach-O';
  return 'unknown';
}

// ---- stage -----------------------------------------------------------------
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(host, { recursive: true });
for (const file of [
  'package.json',
  'package-lock.json',
  'host.ts',
  'p0-4-probe.ts',
  'p0-4-report.ts',
]) {
  cpSync(join(hostSrc, file), join(host, file));
}
for (const file of ['kit.ts', 'probe-hooks.mjs'])
  cpSync(join(hostSrc, 'lib', file), join(host, 'lib', file));
cpSync(join(hostSrc, 'bundle'), join(host, 'bundle'), {
  recursive: true,
  filter: (source) => !source.includes('node_modules'),
});
mkdirSync(join(kit, 'gateway'));
cpSync(gatewaySrc, join(kit, 'gateway', 'fake-gateway.mjs'));
// Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
let script = readFileSync(join(here, 'run-p0-4.ps1'));
if (!(script[0] === 0xef && script[1] === 0xbb && script[2] === 0xbf)) {
  script = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), script]);
}
writeFileSync(
  join(kit, 'run-p0-4.ps1'),
  Buffer.from(script.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8')
);

// ---- install ---------------------------------------------------------------
run(
  'npm',
  [
    'ci',
    ...(platform === 'win32' ? ['--os=win32', '--cpu=x64'] : []),
    '--install-links',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ],
  host
);

// ---- materialize linked packages ---------------------------------------------
// The lockfile records the file: bundle as `link: true`. npm 10 copies it under
// --install-links; npm 11 (bundled with Node 24) keeps it a symlink. Replace any
// top-level link into the staged host tree with a real copy, whichever npm ran.
const modules = join(host, 'node_modules');
for (const entry of readdirSync(modules)) {
  const names = entry.startsWith('@')
    ? readdirSync(join(modules, entry)).map((name) => join(entry, name))
    : [entry];
  for (const name of names) {
    const path = join(modules, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = realpathSync(path);
    if (!target.startsWith(`${realpathSync(host)}${sep}`)) continue;
    unlinkSync(path);
    cpSync(target, path, {
      recursive: true,
      filter: (source) => !relative(target, source).split(sep).includes('node_modules'),
    });
    log(`materialized linked package ${name} from ${relative(host, target)}`);
  }
}

// ---- prune -----------------------------------------------------------------
const target = platform === 'win32' ? 'win32-x64' : 'linux-x64';
const prune = [join(modules, '.bin')];
for (const dir of readdirSync(join(modules, 'node-pty', 'prebuilds'))) {
  if (dir !== target) prune.push(join(modules, 'node-pty', 'prebuilds', dir));
}
const conpty = join(modules, 'node-pty', 'third_party', 'conpty');
if (platform !== 'win32') prune.push(join(modules, 'node-pty', 'third_party'));
else if (existsSync(conpty)) {
  for (const version of readdirSync(conpty)) {
    for (const dir of readdirSync(join(conpty, version))) {
      if (dir !== 'win10-x64') prune.push(join(conpty, version, dir));
    }
  }
}
const reflink = join(modules, 'pnpm', 'dist', 'node_modules', '@reflink');
if (existsSync(reflink)) {
  for (const dir of readdirSync(reflink)) {
    const keep = platform === 'win32' ? /win32-x64/ : /linux-x64/;
    if (/^reflink-/.test(dir) && !keep.test(dir)) prune.push(join(reflink, dir));
  }
}
const vendor = join(modules, 'pnpm', 'dist', 'vendor');
if (existsSync(vendor)) {
  for (const file of readdirSync(vendor)) {
    if (platform !== 'win32' || /x86\.exe$/.test(file)) prune.push(join(vendor, file));
  }
}
for (const path of prune) rmSync(path, { recursive: true, force: true });
let prunedFiles = 0;
for (const file of walk(modules)) {
  if (/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(file)) {
    rmSync(file, { force: true });
    prunedFiles += 1;
  }
}
log(`pruned ${prune.length} directories and ${prunedFiles} map / declaration files`);

// ---- verify ----------------------------------------------------------------
const files = walk(kit);
const symlinks = files.filter((file) => lstatSync(file).isSymbolicLink());
if (symlinks.length > 0)
  throw new Error(`symlinks left in the kit: ${symlinks.slice(0, 5).join(', ')}`);
const expected = platform === 'win32' ? 'PE32+ x86-64' : 'ELF64 x86-64';
const natives = files
  .filter((file) => /\.(node|dll|exe)$/i.test(file) || /[\\/]bin[\\/]rg$/.test(file))
  .map((file) => ({
    file: relative(kit, file),
    format: binaryFormat(file),
    bytes: statSync(file).size,
    sha256: sha256(file),
  }));
const wrong = natives.filter((item) => item.format !== expected);
if (wrong.length > 0) throw new Error(`wrong binary format: ${JSON.stringify(wrong, null, 2)}`);
const need =
  platform === 'win32'
    ? [
        /node-addon-require-builtin-win32-x64-msvc[\\/].*\.node$/,
        /koffi-win32-x64[\\/].*koffi\.node$/,
        /node-pty[\\/]prebuilds[\\/]win32-x64[\\/]conpty\.node$/,
        /ripgrep-win32-x64[\\/]bin[\\/]rg\.exe$/,
      ]
    : [
        /node-addon-require-builtin-linux-x64-gnu[\\/].*\.node$/,
        /koffi-linux-x64[\\/].*koffi\.node$/,
        /node-pty[\\/]prebuilds[\\/]linux-x64[\\/]pty\.node$/,
        /node-addon-system-linux-x64[\\/].*system\.node$/,
      ];
const missing = need.filter((pattern) => !natives.some((item) => pattern.test(item.file)));
if (missing.length > 0) throw new Error(`native modules missing: ${missing.join(', ')}`);
const longest = files.reduce((max, file) => Math.max(max, relative(outRoot, file).length), 0);

const versionOf = (name) => {
  try {
    return JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
};
const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
const manifest = {
  kit: 'dsh-rebase P0-4 encrypted-machine kit',
  builtAt: new Date().toISOString(),
  platform: `${platform}-x64`,
  builtWith: { node: process.version, host: `${process.platform}-${process.arch}` },
  expectedNode: 'v24.18.0 (resources\\node-runtime\\node.exe of the installed app)',
  source: Object.fromEntries(
    ['host.ts', 'p0-4-probe.ts', 'p0-4-report.ts', 'package-lock.json'].map((file) => [
      file,
      sha256(join(host, file)),
    ])
  ),
  versions: Object.fromEntries(
    [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/cordis',
      'koffi',
      'node-pty',
      '@vscode/ripgrep',
      'node-addon-require-builtin',
      'pnpm',
    ].map((name) => [name, versionOf(name)])
  ),
  files: files.length,
  bytes,
  longestRelativePath: longest,
  natives,
};
writeFileSync(join(kit, 'kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
log(
  `${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB unpacked, longest path ${longest} chars`
);
for (const item of natives) log(`  ${item.format.padEnd(13)} ${item.file}`);

// ---- archive ---------------------------------------------------------------
if (!argv.includes('--no-zip')) {
  const zip = join(outRoot, `${kitName}-${platform}-x64.zip`);
  run('zip', ['-qr', '-X', zip, kitName], outRoot);
  const zipBytes = statSync(zip).size;
  writeFileSync(`${zip}.sha256`, `${sha256(zip)}  ${kitName}-${platform}-x64.zip\n`);
  log(`archive ${zip}: ${(zipBytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256(zip)}`);
}
