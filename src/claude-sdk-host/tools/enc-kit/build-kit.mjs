/**
 * Build the route-B encrypted-machine kit (prototype doc §5.2, on branch
 * proto/claude-agent-sdk-engine only; see docs/plantree/plans/claude-sdk-engine/README.md §0) on the Windows
 * dev machine.
 *
 *   node src/claude-sdk-host/tools/enc-kit/build-kit.mjs [--out <dir>]
 *
 * Field fact behind the delivery rules (2026-10-15): files unpacked from a foreign zip on the
 * encrypted machine get encrypted, and the bundled node then reads `sdk.mjs` as TSD
 * ciphertext. Files written locally stay plaintext. P1-13b: node decrypts encrypted `.js`,
 * `.ts`, `.md`, `.txt` and friends, not `.mjs`.
 *
 *   ccsdk-enc-kit-npm      the tester's delivery rules: the real stack (official SDK and its
 *                          claude.exe) installed on the machine by `npm ci`, host sources as
 *                          `.ts`, every scaffold (runner, probe, fake gateway, sample plan,
 *                          kit-tools) as a `.txt` whose header names its target; restored
 *                          locally by a one-line command in README.txt.
 *
 * The prototype's second flavor (host + SDK bundled into host.js, CLI swapped for the Cometix
 * Node.js rebuild) was dropped by the 2026-10-16 ruling: the official claude.exe only.
 *
 * Output in <dir> (default <repo>/out/ccsdk-enc-kit/): ccsdk-enc-kit-npm.zip, README-npm.txt,
 * SHA256SUMS. The kit carries no node: it runs on the installed app's
 * resources\node-runtime\node.exe.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const outRoot = resolve(option('out', join(repoRoot, 'out', 'ccsdk-enc-kit')));
if (!basename(outRoot).includes('ccsdk-enc-kit')) {
  throw new Error(
    `refusing to clear ${outRoot}: the output directory name must contain "ccsdk-enc-kit"`
  );
}

const log = (message) => process.stderr.write(`[ccsdk build-kit] ${message}\n`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const rel = (file) => relative(repoRoot, file).replaceAll('\\', '/');

/** UTF-8 with BOM and CRLF: what Windows PowerShell 5.1 and Notepad read without guessing. */
const windowsText = (text) =>
  Buffer.from(
    `\uFEFF${text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\r\n')}`,
    'utf8'
  );

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// Relative runtime imports (type-only imports are erased by node and need no file).
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function closure(entries) {
  const seen = new Set();
  const bare = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      if (match[1]) continue;
      const spec = match[2] ?? match[3];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`${rel(file)} imports ${spec}, which does not resolve to a file`);
      }
      visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return { files: [...seen], bare: [...bare] };
}

const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, entry) => n + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1),
    0
  );

const hostDir = join(repoRoot, 'src', 'claude-sdk-host');
const nodeModules = join(hostDir, 'node_modules');
const sdkPackage = JSON.parse(
  readFileSync(join(nodeModules, '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')
);
const claudeExe = join(nodeModules, '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
if (!existsSync(claudeExe)) {
  throw new Error(
    `${rel(claudeExe)} is missing: run npm ci in src/claude-sdk-host on Windows first`
  );
}
const dirty = git([
  'status',
  '--porcelain',
  '--',
  'src/claude-sdk-host',
  'src/dsh-host/tools',
  'src/shared',
]);
const commit = `${git(['rev-parse', '--short', 'HEAD'])}${dirty ? '+dirty' : ''}`;

const hostEntry = join(hostDir, 'host.ts');
const { files: hostFiles, bare } = closure([hostEntry]);
const unexpected = bare.filter((name) => name !== '@anthropic-ai/claude-agent-sdk');
if (unexpected.length > 0) {
  throw new Error(`unexpected package imports (not in the kit): ${unexpected.join(', ')}`);
}

const here_ = (name) => join(here, name);
const SCAFFOLDS = [
  {
    source: here_('run-ccsdk-enc.ps1'),
    target: 'run-ccsdk-enc.ps1',
    comment: '#',
    bom: true,
    role: '一键上机脚本（Windows PowerShell 5.1）',
    deps: '还原后的其余四个脚手架；app\\ 下的宿主源码；app\\src\\claude-sdk-host\\node_modules（npm ci 装）',
  },
  {
    source: here_('kit-tools.mjs'),
    target: 'kit-tools.mjs',
    comment: '//',
    role: '小工具：文件头分类、第 0 步自检、抓包统计、矩阵摘要、用 node 读文件、在 PiLab 主程序下起子进程',
    deps: '无（只用 node 内置模块）',
  },
  {
    source: join(repoRoot, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs'),
    target: 'app/src/dsh-host/tools/fake-gateway.mjs',
    comment: '//',
    role: '本机假网关（127.0.0.1，按脚本扮演模型）',
    deps: '无（只用 node 内置模块）',
  },
  {
    source: join(repoRoot, 'src', 'dsh-host', 'tools', 'p1-13b', 'matrix-probe.mjs'),
    target: 'app/src/dsh-host/tools/p1-13b/matrix-probe.mjs',
    comment: '//',
    role: 'P1-13b 样本清单生成器（脚本只用它的 plan 子命令）',
    deps: '无（只用 node 内置模块）',
  },
  {
    source: join(hostDir, 'tools', 'host-probe.ts'),
    target: 'app/src/claude-sdk-host/tools/host-probe.ts',
    comment: '//',
    role: '探针：像 PiLab 主进程那样经 IPC 驱动宿主，跑流程与读写矩阵',
    deps: '..\\host.ts（宿主入口，随包原样发来）',
  },
];

/** A scaffold as a .txt: header comments naming its target, then the source verbatim. */
function scaffoldText(scaffold) {
  const c = scaffold.comment;
  let body = readFileSync(scaffold.source, 'utf8').replace(/^\uFEFF/, '');
  // A shebang is only valid as the very first line; the header goes first, so drop it.
  if (body.startsWith('#!')) body = body.slice(body.indexOf('\n') + 1);
  const targetWin = scaffold.target.replaceAll('/', '\\');
  const cut = targetWin.lastIndexOf('\\');
  const dir = cut > 0 ? `<工具包目录>\\${targetWin.slice(0, cut)}\\` : '<工具包目录>\\（根目录）';
  const header = [
    `${c} CCSDK-KIT TARGET: ${scaffold.target}`,
    `${c} 目标文件名：${basename(scaffold.target)}`,
    `${c} 放置目录：${dir}`,
    `${c} 作用：${scaffold.role}`,
    `${c} 依赖的同包文件：${scaffold.deps}`,
    `${c} 还原：把本文件全文（含这几行注释）在本机另存为上面的目标路径，${scaffold.bom ? 'UTF-8 带 BOM（PowerShell 5.1 要靠 BOM 认中文）' : 'UTF-8 无 BOM'}。`,
    `${c} 来源：${rel(scaffold.source)}（提交 ${commit}，SHA256 ${sha256(scaffold.source)}）`,
    '',
  ].join('\n');
  return `${header}${body}`;
}

const MODULE_STUB = `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`;

function zipKit(kitName) {
  const zip = join(outRoot, `${kitName}.zip`);
  const zipped =
    process.platform === 'win32'
      ? spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), [
          '-a',
          '-c',
          '-f',
          zip,
          '-C',
          outRoot,
          kitName,
        ])
      : spawnSync('zip', ['-qr', zip, kitName], { cwd: outRoot });
  if (zipped.status !== 0) throw new Error(`zip failed: ${String(zipped.stderr ?? zipped.error)}`);
  return zip;
}

const KIT_NAME = 'ccsdk-enc-kit-npm';

function buildNpmKit() {
  const kit = join(outRoot, KIT_NAME);
  const app = join(kit, 'app');
  mkdirSync(app, { recursive: true });

  const copied = [];
  const copy = (file, target) => {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
    copied.push({ path: rel(file), sha256: sha256(file) });
  };
  for (const file of hostFiles) copy(file, join(app, relative(repoRoot, file)));
  copy(join(hostDir, 'package.json'), join(app, 'src', 'claude-sdk-host', 'package.json'));
  copy(
    join(hostDir, 'package-lock.json'),
    join(app, 'src', 'claude-sdk-host', 'package-lock.json')
  );
  // `.ts` files are ES modules by the nearest package.json, as in the repo.
  writeFileSync(join(app, 'package.json'), MODULE_STUB);
  writeFileSync(join(app, 'src', 'dsh-host', 'package.json'), MODULE_STUB);

  const scaffoldDir = join(kit, 'scaffold');
  mkdirSync(scaffoldDir, { recursive: true });
  const scaffolds = [];
  for (const scaffold of SCAFFOLDS) {
    const name = `${basename(scaffold.target)}.txt`;
    const text = scaffoldText(scaffold);
    writeFileSync(
      join(scaffoldDir, name),
      scaffold.bom ? windowsText(text) : text.replace(/\r\n/g, '\n')
    );
    scaffolds.push({
      txt: `scaffold/${name}`,
      target: scaffold.target,
      source: rel(scaffold.source),
    });
  }

  cpSync(here_('HANDOFF.md'), join(kit, 'HANDOFF.md'));
  const readme = readFileSync(here_('README-npm.txt'), 'utf8');
  writeFileSync(join(kit, 'README.txt'), windowsText(readme));
  writeFileSync(join(outRoot, 'README-npm.txt'), windowsText(readme));

  const manifest = {
    kit: KIT_NAME,
    flavor: 'npm',
    builtAt: new Date().toISOString(),
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    sdkVersion: sdkPackage.version,
    cli: `claude.exe ${sdkPackage.claudeCodeVersion ?? ''}（npm ci 安装）`.trim(),
    // What npm ci should reproduce on the machine (same lockfile, same platform package).
    expectedClaudeExe: { sha256: sha256(claudeExe), bytes: statSync(claudeExe).size },
    scaffolds,
    files: copied,
  };
  writeFileSync(join(kit, 'kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = zipKit(KIT_NAME);
  log(
    `npm kit: ${kit} (${countFiles(kit)} files), zip ${(statSync(zip).size / 1024).toFixed(0)} KiB`
  );
  return zip;
}

rmSync(join(outRoot, KIT_NAME), { recursive: true, force: true });
rmSync(join(outRoot, `${KIT_NAME}.zip`), { force: true });
mkdirSync(outRoot, { recursive: true });
const zip = buildNpmKit();
const sums = `${sha256(zip)}  ${basename(zip)}`;
writeFileSync(join(outRoot, 'SHA256SUMS'), `${sums}\n`);
log(`commit ${commit}; SHA256SUMS:\n${sums}`);
