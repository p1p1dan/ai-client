/**
 * Build the P1-13b encryption-matrix kit (dsh-rebase plan) on a Linux box.
 *
 *   node src/dsh-host/tools/p1-13b/build-kit.mjs [--out <dir>]
 *
 * Output in <dir> (default /var/tmp/aiclient-p1-13b-kit/):
 *   aiclient-p1-13b-kit.zip               aiclient-p1-13b-kit/ with run-p1-13b.ps1 (UTF-8 BOM +
 *                                         CRLF for Windows PowerShell 5.1), matrix-probe.mjs,
 *                                         README.txt and kit-manifest.json
 *   README.txt                            the same Chinese README, next to the zip
 *   p1-13b-encryption-matrix-runbook.md   the runbook, for the person who hands the kit over
 *   SHA256SUMS
 *
 * The kit carries no node: it runs on the installed app's
 * resources\node-runtime\node.exe, which is the process the policy sees.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const runbook = join(
  repoRoot,
  'docs',
  'plantree',
  'plans',
  'dsh-rebase',
  'topics',
  'p1-13b-encryption-matrix-runbook.md'
);

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const outRoot = resolve(option('out', '/var/tmp/aiclient-p1-13b-kit'));
if (!basename(outRoot).includes('p1-13b')) {
  throw new Error(`refusing to clear ${outRoot}: the output directory name must contain "p1-13b"`);
}
const kitName = 'aiclient-p1-13b-kit';
const kit = join(outRoot, kitName);
const log = (message) => process.stderr.write(`[p1-13b build-kit] ${message}\n`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** UTF-8 with BOM and CRLF: what Notepad and Windows PowerShell 5.1 read without guessing. */
const windowsText = (text) =>
  Buffer.from(
    `\uFEFF${text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\r\n')}`,
    'utf8'
  );

function git(args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ---- check -----------------------------------------------------------------------
const probeSrc = join(here, 'matrix-probe.mjs');
const scriptSrc = join(here, 'run-p1-13b.ps1');
const check = spawnSync(process.execPath, ['--check', probeSrc], { encoding: 'utf8' });
if (check.status !== 0) throw new Error(`matrix-probe.mjs does not parse: ${check.stderr}`);

// ---- stage -----------------------------------------------------------------------
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(kit, { recursive: true });
writeFileSync(join(kit, 'run-p1-13b.ps1'), windowsText(readFileSync(scriptSrc, 'utf8')));
copyFileSync(probeSrc, join(kit, 'matrix-probe.mjs'));

const commit = git(['rev-parse', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = git(['status', '--porcelain', '--', relative(repoRoot, here)]);
const builtAt = new Date().toISOString();
const source = `${branch ?? '?'} @ ${commit ? commit.slice(0, 8) : '?'}${dirty ? '（src/dsh-host/tools/p1-13b 有未提交的改动，按工作区内容构建）' : ''}`;

writeFileSync(join(kit, 'README.txt'), windowsText(readme({ builtAt, source })));
writeFileSync(
  join(kit, 'kit-manifest.json'),
  `${JSON.stringify(
    {
      kit: 'dsh-rebase P1-13b encryption matrix kit',
      builtAt,
      builtWith: { node: process.version, host: `${process.platform}-${process.arch}` },
      source: { branch, commit, uncommittedKitSources: Boolean(dirty) },
      expectedNode: 'resources\\node-runtime\\node.exe of the installed app (not shipped here)',
      files: Object.fromEntries(
        ['run-p1-13b.ps1', 'matrix-probe.mjs', 'README.txt'].map((file) => [
          file,
          sha256(join(kit, file)),
        ])
      ),
    },
    null,
    2
  )}\n`
);

// ---- archive -----------------------------------------------------------------------
const zipName = `${kitName}.zip`;
const zip = join(outRoot, zipName);
const zipRun = spawnSync('zip', ['-qr', '-X', zip, kitName], { cwd: outRoot, stdio: 'inherit' });
if (zipRun.status !== 0) throw new Error(`zip exited ${zipRun.status}`);
copyFileSync(join(kit, 'README.txt'), join(outRoot, 'README.txt'));
copyFileSync(runbook, join(outRoot, basename(runbook)));
rmSync(kit, { recursive: true, force: true });

const sums = [zipName, 'README.txt', basename(runbook)]
  .map((file) => `${sha256(join(outRoot, file))}  ${file}`)
  .join('\n');
writeFileSync(join(outRoot, 'SHA256SUMS'), `${sums}\n`);
log(`source ${source}`);
log(`${zip}: ${statSync(zip).size} bytes, sha256 ${sha256(zip)}`);
process.stdout.write(`${sums}\n`);

function readme({ builtAt, source }) {
  return `P1-13b 加密矩阵上机包（aiclient-p1-13b-kit）

构建：${builtAt}；源码 ${source}

一、这一轮要弄清什么
  1. 随包 node.exe 能解密哪些扩展名；
  2. node.exe 新建的文件为什么不加密（第一轮里 DSH write 新建的 .txt 没加密）；
  3. 加密策略是不是按进程名匹配（把 node.exe 复制一份改名后再读写，看结果是否一样）。
  只做本地文件读写：不起 DSH、不起网关、不联网、不调用任何模型。
  全程约 10～15 分钟，另加人工加密的时间。

二、准备
  1. 把 aiclient-p1-13b-kit.zip 和 SHA256SUMS 拷到不受加密策略的短路径，例如 C:\\p113b\\。
     校验：Get-FileHash C:\\p113b\\aiclient-p1-13b-kit.zip -Algorithm SHA256
     结果要与 SHA256SUMS 里 zip 那一行一致（不分大小写）。
  2. 解压：tar -xf C:\\p113b\\aiclient-p1-13b-kit.zip -C C:\\p113b
     得到 C:\\p113b\\aiclient-p1-13b-kit\\ 下的 run-p1-13b.ps1、matrix-probe.mjs、README.txt、kit-manifest.json。
  3. 加密目录：选一个受加密策略覆盖的已有目录作 -EncDir（第一轮用的是 C:\\Users\\JC\\p1-13-encrypted-test）。
     工具包目录不能在它里面。
  4. 应用目录：已装 PiLab Ai 的安装目录作 -AppDir（第一轮是 D:\\Program Files\\AiClient\\PiLabAi）。
     包里不带 node，用的是应用自带的 resources\\node-runtime\\node.exe。

三、运行（用 Windows PowerShell 5.1，也就是开始菜单里的「Windows PowerShell」，不要用 PowerShell 7）
  Set-ExecutionPolicy -Scope Process Bypass
  & 'C:\\p113b\\aiclient-p1-13b-kit\\run-p1-13b.ps1' -EncDir 'C:\\Users\\JC\\p1-13-encrypted-test' -AppDir 'D:\\Program Files\\AiClient\\PiLabAi' -ManualEncryption

  可选参数：
    -DelaySeconds 60      延迟复读距最后一次写入的秒数，默认 60
    -GitBash '<bash.exe>' Git Bash 不在默认位置时指定
    -RemoveWork           结束时删除 EncDir 下的工作目录（默认保留，便于人工查看）
  能用平时办公的普通账户就用普通账户；只能用管理员也可以，报告会记下权限。

四、人工加密（-ManualEncryption）
  1. 脚本在 EncDir\\p113b-<时间>\\in\\ 建好 51 个文件后暂停，窗口里列出文件名。
  2. 用加密客户端把整个 in 目录加密。客户端提示某些类型不能加密或被跳过的，记下来。
  3. 在 C:\\p113b\\aiclient-p1-13b-kit\\report-p113b-<时间>\\ 下新建 manual-encryption-confirmed.txt：
     第一行写 CONFIRMED；第二行起可以写备注（例如「pdf、docx 客户端提示未加密」）。保存后脚本自动继续。
     想放弃本轮，第一行写 ABORT。

五、跑完以后
  1. 窗口会打印摘要；完整结果在 report-p113b-<时间>\\summary.txt。
  2. 看 summary.txt 的「需要人工确认」一节。列出了文件类型的话，请用加密客户端
     （文件图标、右键属性或客户端自带的查看功能）查看 EncDir\\p113b-<时间>\\out-*\\ 下对应的文件是否加密，
     按「目录 → 哪些文件未加密」记下来。逐个看不过来时，至少看摘要里点名的那几个类型。
  3. 看完后工作目录可以手工删除。

六、发回什么
  - 整个 report-p113b-<时间>\\ 目录（matrix.json、summary.txt、probe.log、manual-encryption-*）；
  - 第五步的人工查看记录；
  - 过程中出现的弹窗、安全软件提示的截图。
  不要发回 EncDir 下的工作目录。报告里只有脚本自己写的随机标记串、本机路径和每个测试文件的前 64 字节。

七、注意事项
  - 脚本会把 node.exe 复制一份到 %TEMP%\\p113b-<时间>\\p113b-raw.exe 并运行它，用来检验策略是否按进程名匹配，
    结束时删除。安全软件可能对这个副本提示或拦截：允许或拦截都可以，拦截时报告里记「跳过」。
  - 脚本会以 ELECTRON_RUN_AS_NODE=1 运行应用主程序（PiLabAi.exe），只执行本包的脚本，不打开应用界面。
    万一弹出了应用界面，30 秒后脚本会按进程号把它关掉，并在报告里记「跳过」。
  - certutil 只用 -dump 读本地文件并输出到窗口，不写文件、不联网；个别安全软件会对 certutil 调用告警。
  - 只写三处：EncDir\\p113b-<时间>\\、%TEMP%\\p113b-<时间>\\、本目录下的 report-p113b-<时间>\\。
    不碰 ~\\.dsh、%APPDATA%、应用目录，不写注册表，不联网。
  - 子进程只按进程号管理，不会按名字结束任何进程。
  - 脚本一开头就报「随包 node.exe 跑不起 matrix-probe.mjs」时，多半是工具包目录受加密策略：换一个目录重新解压。
`;
}
