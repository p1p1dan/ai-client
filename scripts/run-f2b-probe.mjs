/**
 * F2-b 取证：临时（unbound）会话在删除前 / 不重启的删除后 / 重启后三个时点，
 * session-index.json 与临时目录分别是什么样。
 *
 * 现场报过「旧 TEMP 删除异常」。任务树上的要求写得很具体，也写明了不许怎么推断：
 * **不能凭 UI 消失推断文件被物理删除**。所以每个时点都从两侧各取一份——索引文件
 * 直接读磁盘，目录直接 `ls`——而不是问界面。
 *
 * 界面上一行临时对话有三个入口，语义完全不同，这份记录要把它们分开：
 *   - **关闭**（`Close session`）：`chat:closeSession`，只解绑 worker 并把行从侧栏移掉
 *   - **归档**（`Archive session`）：`chat:archiveSession`，写索引 `archived:true`，
 *     unbound 会话还会顺带 `scratchWorkspaceService.release()`
 *   - **删除**（临时行才有的第三个按钮）：走 `temp:workspace:*` 那条确认+删除链
 *
 * 另外有一条与三个入口都无关、但会决定第三个时点的事实：`ScratchWorkspaceService`
 * 在**应用启动和退出时都会 `wipeAll()`**，整个 scratch 根目录连锅端。本探针要把它测出来。
 *
 *   node scripts/run-f2b-probe.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
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

const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p4-6/f2b');

/** 与 `SessionIndexService` / `ScratchWorkspaceService` 落盘位置一致。 */
const INDEX_PATH = '/home/ai/.config/jyw-ai-client-dev/session-index.json';
const SCRATCH_ROOT = path.join(os.homedir(), 'JYWAI/temporary/unbound-sessions');

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.entries ?? Object.values(parsed));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** 只留本轮关心的那几列，否则一份 90 行的索引会把记录淹掉。 */
function rowOf(sessionId) {
  const rows = readIndex();
  if (!Array.isArray(rows)) return rows;
  const row = rows.find((r) => r.sessionId === sessionId);
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    workspacePath: row.workspacePath ?? null,
    runtimeIdentity: row.runtimeIdentity ?? null,
    unbound: row.unbound ?? false,
    archived: row.archived ?? false,
    title: row.title ?? '',
  };
}

function scratchListing() {
  try {
    return fs.readdirSync(SCRATCH_ROOT).sort();
  } catch (error) {
    return { missing: true, code: error?.code ?? String(error) };
  }
}

function snapshot(label, sessions) {
  return {
    label,
    at: new Date().toISOString(),
    scratchRoot: { path: SCRATCH_ROOT, entries: scratchListing() },
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([name, id]) => {
        const row = rowOf(id);
        const dir = row?.workspacePath ?? null;
        return [
          name,
          {
            sessionId: id,
            indexRow: row,
            workspaceDirExists: dir ? fs.existsSync(dir) : null,
            workspaceDirEntries:
              dir && fs.existsSync(dir) ? fs.readdirSync(dir).sort().slice(0, 20) : null,
          },
        ];
      })
    ),
  };
}

/**
 * 侧栏里某条会话那一行上的按钮。
 *
 * 侧栏行没有 `data-session-id` 之类的钩子，所以按**行文本**定位：每条探针会话发的
 * 第一句都带一个独一无二的记号，而侧栏用第一句当标题。找到的必须是「同时含这个记号
 * 且自己带着行内按钮」的那个节点——直接按记号找会命中时间线里的那条消息。
 *
 * 按钮要 hover 才显示（`group-hover:flex`），但 DOM 里一直在，`click()` 照样生效。
 */
const rowButton = (needle, ariaLabel) =>
  `(() => {
  const rows = [...document.querySelectorAll('*')].filter((n) =>
    (n.innerText ?? '').includes(${JSON.stringify('NEEDLE')}) &&
    [...n.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '') === 'Close session')
  );
  // 最深的那个：祖先链上每一层都含这段文字，只有最里面那个才是行本身。
  const row = rows[rows.length - 1];
  if (!row) throw new Error('no sidebar row containing ' + ${JSON.stringify('NEEDLE')});
  const button = [...row.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify('ARIA')});
  if (!button) throw new Error('no ' + ${JSON.stringify('ARIA')} + ' button on that row');
  button.click();
  return true;
})()`
    .replaceAll('"NEEDLE"', JSON.stringify(needle))
    .replaceAll('"ARIA"', JSON.stringify(ariaLabel));

/**
 * 标题就用那个记号。
 *
 * 侧栏行的标题一开始是创建时给的名字，等第一条回复落盘之后会换成第一句话。两种
 * 情况下都要能按同一个记号找到这一行，所以标题和第一句都以它开头——第一版只把记号
 * 放在消息里，第二条会话的回合还没落盘、标题还是默认值，行就找不到了。
 */
const createUnbound = (title) =>
  `(() => {
  window.__f2b = null;
  import('/stores/chatSessionActions.ts').then((m) => {
    window.__f2b = { done: true, id: m.createUnboundChatSession(${JSON.stringify('T')}) };
  }).catch((e) => { window.__f2b = { done: true, error: String(e?.message ?? e) }; });
  return true;
})()`.replace('"T"', JSON.stringify(title));

const sendInActive = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`;

const selectSession = (sessionId) => `(() => {
  window.__f2bsel = null;
  import('/stores/chatSessions.ts').then((m) => {
    m.useChatSessionsStore.setState({ activeSessionId: ${JSON.stringify(sessionId)} });
    window.__f2bsel = { done: true };
  }).catch((e) => { window.__f2bsel = { done: true, error: String(e?.message ?? e) }; });
  return true;
})()`;

async function bootUi(cdp) {
  await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
    timeoutMs: 240_000,
    label: 'renderer painted',
  });
  try {
    await cdp.evaluate(ENTER_MAIN_SURFACE);
    await sleep(2500);
  } catch {
    /* 已经引导过了 */
  }
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 120_000,
    label: 'composer mounted',
  });
  for (let i = 0; i < 20; i += 1) {
    let dismissed = false;
    for (const label of ['以后再说', '知道了']) {
      try {
        await cdp.evaluate(clickByText(label));
        dismissed = true;
        await sleep(500);
      } catch {
        /* 这一个没弹 */
      }
    }
    const blocked = await cdp.evaluate(
      `document.querySelector('[role="dialog"], [data-slot="dialog-popup"]') !== null`
    );
    if (!blocked) break;
    if (!dismissed) await sleep(700);
  }
  await cdp.evaluate(`(async () => {
    const s = await import(/* @vite-ignore */ '/stores/settings/index.ts');
    s.useSettingsStore.setState({ language: 'zh' });
    document.documentElement.lang = 'zh-CN';
    return true;
  })()`);
}

/** 新建一条临时对话并发一句，逼 Main 真的分配 scratch 目录。 */
async function makeUnbound(cdp, needle, text) {
  await cdp.evaluate(createUnbound(needle));
  const created = await cdp.waitFor(`window.__f2b?.done ? window.__f2b : null`, {
    timeoutMs: 30_000,
    label: 'unbound session created',
  });
  if (created.error) throw new Error(`createUnboundChatSession: ${created.error}`);
  await sleep(1200);
  await cdp.evaluate(sendInActive(text));
  // 目录是在第一次发送时分配的，所以判据是目录出现，不是回合结束。
  const sessionId = created.id;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = rowOf(sessionId);
    if (row?.workspacePath && fs.existsSync(row.workspacePath)) break;
    await sleep(1500);
  }
  return sessionId;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  stopDevApp();
  startDevApp();
  let cdp = await Cdp.attach(DEBUG_PORT, 900_000);
  cdp.collectRendererProblems();
  const report = { indexPath: INDEX_PATH, scratchRoot: SCRATCH_ROOT, snapshots: [] };
  try {
    await bootUi(cdp);

    const sessions = {};
    const needles = { closed: 'f2bCLOSE', archived: 'f2bARCHIVE' };
    sessions.closed = await makeUnbound(cdp, needles.closed, `${needles.closed} 回一个字：甲`);
    sessions.archived = await makeUnbound(
      cdp,
      needles.archived,
      `${needles.archived} 回一个字：乙`
    );
    report.needles = needles;
    report.snapshots.push(snapshot('T0 删除前', sessions));

    // 两个入口分别作用在两条会话上，这样一次重启就能把两条路都记全。
    await cdp.evaluate(selectSession(sessions.closed));
    await sleep(800);
    report.entryPoints = { closed: 'Close session（chat:closeSession）' };
    await cdp.evaluate(rowButton(needles.closed, 'Close session'));
    await sleep(2500);

    // 归档要确认：行上那个按钮只是把确认框打开（`requestArchive` → AlertDialog），
    // 点完就走会什么都没归档——本探针第一版就这么读出过一次「点了归档但索引没变」的
    // 假缺陷。确认框的主按钮文案是「归档」。
    await cdp.evaluate(rowButton(needles.archived, 'Archive session'));
    await sleep(1200);
    report.steps = report.steps ?? {};
    report.steps.archiveConfirmShown = await cdp.evaluate(
      `(() => document.body.innerText.includes('从侧栏移除') || document.body.innerText.includes('归档'))()`
    );
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="alertdialog"], [data-slot="alert-dialog-popup"]')
        ?? document.querySelector('[role="dialog"], [data-slot="dialog-popup"]');
      if (!dialog) throw new Error('archive confirmation did not open');
      const button = [...dialog.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').trim() === '归档');
      if (!button) throw new Error('no 归档 button in the confirmation');
      button.click();
      return true;
    })()`);
    report.entryPoints.archived =
      'Archive session（行内按钮 → 确认框「归档」→ chat:archiveSession + scratch release）';
    await sleep(3500);

    report.snapshots.push(snapshot('T1 删除后（未重启）', sessions));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'f2b-after-delete.png'), Buffer.from(data, 'base64'));

    // ── 重启 ────────────────────────────────────────────────────────────────
    cdp.close();
    stopDevApp();
    await sleep(6000);
    report.snapshots.push(snapshot('T1.5 应用已退出（重启前）', sessions));
    startDevApp();
    cdp = await Cdp.attach(DEBUG_PORT, 900_000);
    cdp.collectRendererProblems();
    await bootUi(cdp);
    await sleep(3000);
    report.snapshots.push(snapshot('T2 重启后', sessions));
    // 侧栏可见性从 store 读，不从整屏文本读：会话列表会滚动/折叠，
    // `innerText` 里没有不等于「这一行不存在」——而 F2-b 要分的正是这两种。
    await cdp.evaluate(`(() => {
      window.__f2bnav = null;
      import('/stores/chatSessions.ts').then((m) => {
        const list = m.useChatSessionsStore.getState().sessions ?? [];
        window.__f2bnav = {
          done: true,
          rows: list
            .filter((x) => (x.title ?? '').includes('f2b'))
            .map((x) => ({ id: x.id, title: x.title, archived: x.archived ?? null })),
          total: list.length,
        };
      }).catch((e) => { window.__f2bnav = { done: true, error: String(e?.message ?? e) }; });
      return true;
    })()`);
    report.sidebarAfterRestart = await cdp.waitFor(
      `window.__f2bnav?.done ? window.__f2bnav : null`,
      { timeoutMs: 30_000, label: 'sidebar rows after restart' }
    );
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'f2b-after-restart.png'), Buffer.from(shot2.data, 'base64'));

    report.rendererProblems = cdp.problems;
    fs.writeFileSync(path.join(outDir, 'f2b-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('probe failed:', error?.message ?? error);
    console.error(devLogTail(60));
    fs.writeFileSync(
      path.join(outDir, 'f2b-report.json'),
      JSON.stringify({ ...report, failure: String(error?.message ?? error) }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    cdp.close();
    stopDevApp();
  }
}

await main();
