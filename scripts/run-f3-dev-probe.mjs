/**
 * F3 开发机侧取证：Electron 主进程派生的 git 会不会丢 stdout。
 *
 * 为什么非要起应用：F3 的现场症状是「Electron 主进程 spawn('git') 拿到空输出，
 * 但 stderr 正常」。普通 Node 进程里跑同一段代码是通的（见同名的 vitest 探针），
 * 所以能区分这两种情况的只有真的走一遍 Main→Git 这条链。
 *
 * 这台机器没有加密驱动，因此本探针只能回答两件事之一：
 *  - 开发机上也丢 → 不是加密驱动的事，是我们自己的启动链有问题，当场就该修；
 *  - 开发机上正常 → F3 确认为加密机专属，按用户 2026-09-11 的决定推到最后一次
 *    上机；同时「F/13 目录行变更量」不再被 F3 卡住，可以在开发机验收。
 *
 *   node scripts/run-f3-dev-probe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  Cdp,
  clickByText,
  DEBUG_PORT,
  devLogTail,
  ENTER_MAIN_SURFACE,
  repoRoot,
  sleep,
  startDevApp,
  stopDevApp,
} from './h21-cdp.mjs';

const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/f3-dev-probe');

/**
 * 走渲染层暴露的 git IPC，也就是 GUI 面板自己用的那条路。
 *
 * `awaitPromise` 不能用（见 h21-cdp 的说明），所以把结果挂到 window 上，另一次
 * evaluate 再取。
 */
const CALL_GIT = `(() => {
  window.__f3 = { done: false };
  const repo = ${JSON.stringify(repoRoot)};
  Promise.resolve()
    .then(async () => {
      const api = window.electronAPI.git;
      const branches = await api.getBranches(repo);
      const status = await api.getStatus(repo);
      const log = await api.getLog(repo, 3);
      return {
        branchCount: Array.isArray(branches) ? branches.length : null,
        branchSample: Array.isArray(branches) ? branches.slice(0, 3).map((b) => b.name) : null,
        currentBranch: status?.current ?? null,
        logCount: Array.isArray(log) ? log.length : null,
      };
    })
    .then((value) => {
      window.__f3 = { done: true, ok: true, value };
    })
    .catch((error) => {
      // Q7 的判据：健康仓库拿不到分支时抛「output was lost」，就是 F3 复现了。
      window.__f3 = { done: true, ok: false, error: String(error?.message ?? error) };
    });
  return true;
})()`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  stopDevApp();
  startDevApp();
  // 15 分钟，不是默认的 4 分钟：2026-09-11 重启并调整内存之后，这台机器上开发版
  // 应用从拉起到 CDP 能应答实测约 9 分钟，默认值会在还没起来的时候就报
  // `CDP target never appeared`，看着像通道坏了。
  const cdp = await Cdp.attach(DEBUG_PORT, 900_000);
  cdp.collectRendererProblems();
  try {
    await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
      timeoutMs: 240_000,
      label: 'renderer painted',
    });
    // 起始页挡在前面时先进主界面；已引导过则按钮不存在，属正常。
    try {
      await cdp.evaluate(ENTER_MAIN_SURFACE);
      await sleep(2500);
    } catch {
      /* 已经引导过了 */
    }
    await cdp.waitFor(`window.electronAPI?.git != null`, {
      timeoutMs: 60_000,
      label: 'git IPC exposed',
    });

    await cdp.evaluate(CALL_GIT);
    const result = await cdp.waitFor(`window.__f3.done ? window.__f3 : null`, {
      timeoutMs: 60_000,
      label: 'git IPC answered',
    });

    const report = { repo: repoRoot, result, rendererProblems: cdp.problems };
    fs.writeFileSync(path.join(outDir, 'f3-dev-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('probe failed:', error?.message ?? error);
    console.error(devLogTail(60));
    process.exitCode = 1;
  } finally {
    cdp.close();
    stopDevApp();
  }
}

await main();
