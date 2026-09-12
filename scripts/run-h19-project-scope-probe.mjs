/**
 * H/19 验证案例 5 的机制半边：托管模式下项目级插件到底生不生效。
 *
 * 界面那一半（不提供 `-l` 入口、托管模式下给出说明）在 GUI 探针里验。这里只回答
 * 一个纯机制问题，而且必须用 pi 自己的代码回答，不能用桩：
 *
 *   同一个装了项目级插件的目录，`SettingsManager.create(cwd, agentDir,
 *   { projectTrusted })` 在 true / false 两种取值下，`getProjectSettings()`
 *   分别看得见什么。
 *
 * 本应用在托管模式下发 `AICLIENT_PI_TRUST_PROJECT_CONFIG=0`，worker 把它读成
 * `projectTrusted: false` 再交给上面这个调用（`piAgentSessionBootstrap.ts`）。
 * 所以这条差分跑通，就等于跑通了「托管模式下项目级插件不生效」。
 *
 * 插件是真装的（`pi install -l` 走 npm），不是造出来的 settings.json —— 项目级
 * 配置的信任判定有可能落在包解析那一步而不是读文件那一步，手写文件验不到。
 *
 *   node scripts/run-h19-project-scope-probe.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-evolution/evidence/unified-agent-directory'
);

const NODE = path.join(repoRoot, 'out-node-runtime/node');
const CLI = path.join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
/**
 * SDK 走 `src/agent-host/node_modules`，不是仓库根。
 *
 * 根目录那棵树里 `pi-coding-agent@0.84.4` 底下嵌着一个过期的
 * `pi-tui@0.84.3`，Node 会先解析到它，于是 `import` 直接抛
 * `does not provide an export named 'setCapabilityOverrides'`。agent-host 那棵树
 * 两个包同为 0.84.3，是自洽的，也正是 worker 实际加载的那份。
 */
const SDK = path.join(
  repoRoot,
  'src/agent-host/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
);

const PACKAGE = 'npm:pi-jingle';

function run(args, cwd, env) {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [CLI, ...args],
      { cwd, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
        });
      }
    );
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `getProjectSettings()` 的形状按版本会变，只取本判定关心的那一维。 */
function packagesOf(settings) {
  const packages = settings && typeof settings === 'object' ? settings.packages : undefined;
  return Array.isArray(packages) ? packages : [];
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h19-scope-'));
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  // 让它像个真项目：pi 的项目级配置判定可能要求 cwd 是个仓库。
  fs.writeFileSync(path.join(project, 'README.md'), '# h19 project-scope probe\n');

  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.ELECTRON_RUN_AS_NODE;

  const report = { agentDir, project, steps: {} };

  // `--approve` = 这一条命令内信任项目级文件。没有它，装的动作本身就会被项目
  // 信任判定拦掉，后面两步就无从对比了。
  report.steps.install = await run(['install', PACKAGE, '-l', '--approve'], project, env);

  const projectSettingsFile = path.join(project, '.pi/settings.json');
  report.steps.projectSettingsFile = {
    path: projectSettingsFile,
    exists: fs.existsSync(projectSettingsFile),
    content: readJson(projectSettingsFile),
  };
  report.steps.agentSettingsFile = {
    path: path.join(agentDir, 'settings.json'),
    exists: fs.existsSync(path.join(agentDir, 'settings.json')),
    content: readJson(path.join(agentDir, 'settings.json')),
  };
  report.steps.projectNodeModules = {
    path: path.join(project, '.pi/npm/node_modules'),
    entries: fs.existsSync(path.join(project, '.pi/npm/node_modules'))
      ? fs.readdirSync(path.join(project, '.pi/npm/node_modules'))
      : [],
  };

  const sdk = await import(SDK);
  for (const projectTrusted of [true, false]) {
    const manager = sdk.SettingsManager.create(project, agentDir, { projectTrusted });
    const projectSettings = manager.getProjectSettings?.();
    const globalSettings = manager.getGlobalSettings?.();
    report.steps[`projectTrusted_${projectTrusted}`] = {
      projectPackages: packagesOf(projectSettings),
      globalPackages: packagesOf(globalSettings),
    };
  }

  const trusted = report.steps.projectTrusted_true.projectPackages;
  const untrusted = report.steps.projectTrusted_false.projectPackages;
  report.verdict = {
    installedAtProjectScope: report.steps.projectSettingsFile.exists,
    visibleWhenTrusted: trusted.length > 0,
    hiddenWhenUntrusted: untrusted.length === 0,
    pass: report.steps.projectSettingsFile.exists && trusted.length > 0 && untrusted.length === 0,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'h19-project-scope.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.verdict.pass) process.exitCode = 1;
}

await main();
