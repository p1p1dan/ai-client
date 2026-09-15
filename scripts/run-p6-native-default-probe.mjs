/**
 * P6-1 / H/20 点验：默认后端切到 native 之后，真实应用里跑一趟。
 *
 * 这个探针要回答的是三个只有真实应用能回答的问题：
 *
 *   1. **默认真的是 native 了吗。** 判据不是读代码，是看审批界面长什么样：native 是
 *      结构化中文权限卡，legacy 是 pi 插件自己的英文 `ui.select` 弹窗。两张不是同一张
 *      卡（2026-09-11 PERM-1 点验实测过），所以它是后端的可靠指纹。P6-5 之后引擎只剩一个，
 *      连同 `AICLIENT_RUNTIME_BACKEND` 一起删了（T028 把探针里记录该变量的那行也清掉），
 *      所以这里跑出来的就是「什么都不配时用户会得到什么」。
 *   2. **一整回合还能跑通吗**（成功标准第 4 条在开发机这一半）：发一条要用 bash 的
 *      指令、等权限卡、放行、看命令输出有没有回到时间线。
 *   3. **H/20 在真实应用里生效了吗**：把这次会话真正写到磁盘的那个文件捡起来，头一行
 *      必须同时带 v4 的 `kind:"header"` 与 v3 的 `type:"session"`；再用 pi CLI 自己的
 *      `SessionManager` 打开它——那正是 `pi --session` 背后的解析器。
 *
 *   node scripts/run-p6-native-default-probe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  Cdp,
  clickByText,
  devLogTail,
  repoRoot,
  sleep,
  startDevApp,
  stopDevApp,
} from './h21-cdp.mjs';

const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p6');
fs.mkdirSync(outDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  steps: {},
  screenshots: {},
};

/**
 * 两种审批界面，一次都认出来。
 *
 * native：结构化权限卡（中文，带高风险徽标与倒计时）。
 * legacy：pi permission-system 插件用 `ui.select` 提的英文问题，经扩展 UI 通道渲染。
 */
const APPROVAL_SURFACE = `(() => {
  const text = (node) => (node?.innerText ?? '').trim();
  const card = [...document.querySelectorAll('[data-permission-request], [data-testid*="permission"]')]
    .find((n) => n.offsetParent !== null);
  if (card) {
    return {
      kind: 'native-card',
      text: text(card).slice(0, 800),
      buttons: [...card.querySelectorAll('button')].map((b) => text(b)).filter(Boolean),
    };
  }
  const root = document.getElementById('root');
  const body = text(root);
  if (/允许|权限/.test(body) && /(直接允许|本次允许|始终允许)/.test(body)) {
    const holder = [...document.querySelectorAll('div,section,article')]
      .filter((n) => n.offsetParent !== null && /(直接允许|本次允许|始终允许)/.test(text(n)))
      .at(-1);
    return {
      kind: 'native-card',
      text: text(holder).slice(0, 800),
      buttons: [...(holder?.querySelectorAll('button') ?? [])].map((b) => text(b)).filter(Boolean),
    };
  }
  const select = [...document.querySelectorAll('div,section,article')]
    .filter((n) => n.offsetParent !== null && /\\bYes\\b/.test(text(n)) && /\\bNo\\b/.test(text(n)))
    .at(-1);
  if (select) {
    return {
      kind: 'legacy-ui-select',
      text: text(select).slice(0, 800),
      buttons: [...select.querySelectorAll('button')].map((b) => text(b)).filter(Boolean),
    };
  }
  return null;
})()`;

async function screenshot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `p6-native-default-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return path.relative(repoRoot, file);
}

/**
 * 本次点验开始之后被写过的会话文件里最新的那个。
 *
 * 找的是**应用自己的** agent 目录，不是 dev.env 里的 `PI_CODING_AGENT_DIR`：H/19 之后
 * 两种模式一律在应用 profile 下跑（`~/.pilab/<profile>/pi-agent/sessions`），dev.env 那个
 * 只是本地模式读配置的来源。第一版探针找错了地方，报告里这一格于是空着。
 */
function newestSessionFile(since) {
  const home = process.env.HOME ?? '';
  const root = path.join(home, '.pilab');
  if (!fs.existsSync(root)) return null;
  const found = [];
  for (const profile of fs.readdirSync(root)) {
    const dir = path.join(root, profile, 'pi-agent', 'sessions');
    if (!fs.existsSync(dir)) continue;
    const walk = (current) => {
      for (const name of fs.readdirSync(current)) {
        const entry = path.join(current, name);
        const stat = fs.statSync(entry);
        if (stat.isDirectory()) walk(entry);
        else if (name.endsWith('.jsonl') && stat.mtimeMs >= since)
          found.push({ file: entry, mtime: stat.mtimeMs });
      }
    };
    walk(dir);
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}

const startedAtMs = Date.now();
startDevApp();
let cdp;
try {
  cdp = await Cdp.attach();
  cdp.collectRendererProblems?.();
  await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
    timeoutMs: 240_000,
    label: 'renderer painted',
  });
  // 起始页挡在前面：本地模式那条路用 dev.env 的 PI_CODING_AGENT_DIR，正是点验要的。
  try {
    await cdp.evaluate(clickByText('使用本机已有配置'));
    report.steps.onboarding = 'clicked';
    await sleep(2500);
  } catch {
    report.steps.onboarding = 'already-past';
  }
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 180_000,
    label: 'composer mounted',
  });
  // 启动公告/迁移提示是异步算出来才弹的，比输入框晚；先等一下再关掉挡路的东西。
  await sleep(4000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dismissed = await cdp.evaluate(`(() => {
      let hit = 0;
      for (const button of document.querySelectorAll('button')) {
        const label = (button.textContent ?? '').trim();
        if (/^(知道了|关闭|稍后|以后再说|不再提示)$/.test(label) && button.offsetParent !== null) {
          button.click();
          hit += 1;
        }
      }
      return hit;
    })()`);
    if (!dismissed) break;
    await sleep(800);
  }
  report.screenshots.start = await screenshot(cdp, 'start');

  await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) throw new Error('no composer');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用 bash 运行这条命令：echo p6-native-default-ok。只运行，不要解释。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);

  let card = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    card = await cdp.evaluate(APPROVAL_SURFACE);
    if (card) break;
    await sleep(1500);
  }
  report.steps.approvalSurface = card;
  if (card) {
    report.screenshots.approval = await screenshot(cdp, 'approval');
    const allow = card.buttons.find((b) => /直接允许|本次允许/.test(b)) ?? 'Yes';
    report.steps.allowLabel = allow;
    await cdp.evaluate(clickByText(allow));
  }

  // 命令输出回到时间线，才算这一趟真的跑完了。
  let sawOutput = false;
  const outputDeadline = Date.now() + 180_000;
  while (Date.now() < outputDeadline) {
    sawOutput = await cdp.evaluate(
      `(document.getElementById('root')?.innerText ?? '').includes('p6-native-default-ok')`
    );
    if (sawOutput) break;
    await sleep(2000);
  }
  report.steps.sawCommandOutput = sawOutput;
  report.screenshots.afterTurn = await screenshot(cdp, 'after-turn');

  // ── H/20 在真实应用里的最后一格：把这条 native 会话交给内嵌 Pi 终端 ──────
  //
  // 走的是 preload 暴露的真 IPC，而不是点右上角那个 GUI/TUI 开关：合成点击和真鼠标
  // 事件都没能让那个分段控件切过去（`aria-pressed` 始终是 GUI），那是探针驱动不了
  // 这个控件，不是应用拒绝。而这里要验的本来就是下面这条链——入口守卫放不放行、
  // node-pty 起不起得来、`pi --session` 认不认这个文件——IPC 打的是同一条。
  try {
    const liveFile = newestSessionFile(startedAtMs);
    report.steps.tuiSessionFile = liveFile ? path.relative(repoRoot, liveFile) : null;
    if (!liveFile) throw new Error('no session file to hand the terminal');
    await cdp.evaluate(`(() => {
      window.__p6 = { data: [] };
      const api = window.electronAPI?.piTui;
      if (!api) throw new Error('no piTui bridge');
      window.__p6.off = api.onData((event) => window.__p6.data.push(event.data ?? ''));
      api.sessionSupport(${JSON.stringify(liveFile)}).then(
        (value) => { window.__p6.support = value; },
        (error) => { window.__p6.support = { error: String(error?.message ?? error) }; }
      );
      return true;
    })()`);
    await cdp.waitFor(`window.__p6?.support !== undefined`, {
      timeoutMs: 30_000,
      label: 'sessionSupport answered',
    });
    report.steps.tuiSupport = await cdp.evaluate(`window.__p6.support`);

    await cdp.evaluate(`(() => {
      window.electronAPI.piTui
        .open({ terminalId: 'p6-probe-terminal', cwd: ${JSON.stringify(repoRoot)}, sessionFile: ${JSON.stringify(liveFile)}, cols: 120, rows: 30 })
        .then(
          (value) => { window.__p6.open = value ?? { ok: true }; },
          (error) => { window.__p6.open = { error: String(error?.message ?? error) }; }
        );
      return true;
    })()`);
    await cdp.waitFor(`window.__p6?.open !== undefined`, {
      timeoutMs: 60_000,
      label: 'terminal open answered',
    });
    await sleep(15_000);
    report.steps.tui = await cdp.evaluate(`(() => {
      const text = (window.__p6.data ?? []).join('');
      return {
        open: window.__p6.open,
        bytes: text.length,
        refused: /not a valid pi session|older native format|无法打开/i.test(text),
        // pi 的 TUI 把历史画出来之后，这句用户消息应当在屏幕缓冲里。
        showsConversation: text.includes('p6-native-default-ok'),
        tail: text.slice(-1200),
      };
    })()`);
    report.screenshots.tui = await screenshot(cdp, 'tui');
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.dispose('p6-probe-terminal'); return true; })()`
    );
  } catch (error) {
    report.steps.tui = { error: String(error?.message ?? error) };
  }
  report.rendererProblems = cdp.problems;
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  try {
    cdp?.close();
  } catch {}
  stopDevApp();
  await sleep(1500);
}

// ── H/20：这次会话真正写到磁盘的那个文件 ─────────────────────────────────
const sessionFile = newestSessionFile(startedAtMs);
report.steps.sessionFile = sessionFile ? path.relative(repoRoot, sessionFile) : null;
if (sessionFile) {
  const header = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\n')[0]);
  report.steps.header = {
    kind: header.kind ?? null,
    version: header.version ?? null,
    type: header.type ?? null,
    hasIsoTimestamp: typeof header.timestamp === 'string',
  };
  try {
    const { SessionManager } = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
        )
      ).href
    );
    const manager = SessionManager.open(sessionFile);
    const messages = manager.buildSessionContext().messages;
    report.steps.cliRead = { ok: true, messageCount: messages.length };
  } catch (error) {
    report.steps.cliRead = { ok: false, error: String(error?.message ?? error) };
  }
}

report.verdict = {
  // native 的指纹：结构化中文权限卡。legacy 会是 `legacy-ui-select`。
  defaultBackendIsNative: report.steps.approvalSurface?.kind === 'native-card',
  turnCompleted: report.steps.sawCommandOutput === true,
  sessionHeaderIsDualFormat:
    report.steps.header?.kind === 'header' &&
    report.steps.header?.version === 4 &&
    report.steps.header?.type === 'session',
  piCliCanOpenThatFile: report.steps.cliRead?.ok === true,
  // H/20 的入口没有拒绝这条 native 会话，且终端真的挂起来了。
  // 入口没拒绝、终端起来了、而且 pi 真的把这段对话画了出来。
  tuiOpenedTheNativeSession:
    report.steps.tui && !report.steps.tui.error
      ? report.steps.tuiSupport?.supported === true &&
        report.steps.tui.refused === false &&
        report.steps.tui.showsConversation === true
      : null,
};
report.verdict.notMeasured = Object.entries(report.verdict)
  .filter(([, value]) => value === null)
  .map(([key]) => key);
report.verdict.pass = Object.entries(report.verdict)
  .filter(([key]) => key !== 'notMeasured')
  .every(([, value]) => value === true);
report.devLogTail = devLogTail(60);
fs.writeFileSync(
  path.join(outDir, 'p6-native-default-report.json'),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report.verdict, null, 2));
console.log('steps:', JSON.stringify(report.steps, null, 2).slice(0, 2000));
