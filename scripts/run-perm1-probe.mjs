/**
 * PERM-1 与权限链复验，在真实应用里点。
 *
 * PERM-1 现场报过两次「权限档弹层关不掉」。修法（`1e1e4469`）是把关闭交还给 Base UI
 * 自己的按下通道：选完即关，不再 await 一次 IPC——`closeOnClick={false}` 那一版让
 * 弹层的去留挂在 worker 回执上，worker 慢或拒绝时弹层就留着不走，而 pending 又把
 * 触发器 disable 了，正是现场那个症状。`auto` 是唯一保持打开的一档，因为选它的下一步
 * 是确认面板而不是应用。
 *
 * 「worker 永不回执时也必须关」由单测钉住（那种情况没法在真实应用里造）。这里验的是
 * 真实点击下的三件事：
 *   1. 选普通档 → 弹层立刻消失，触发器标签跟着变
 *   2. 选「全自动」→ 弹层**留着**并换成确认面板
 *   3. 取消后回到档位列表，什么都没被应用
 *
 * 权限链那一半走真实回合：让模型跑一条命令，等权限卡弹出来，把整张卡读回来（第 4 批
 * 刚把这张卡的文案接进词典，顺带回归），点「直接允许」，确认命令真的执行了。
 *
 *   node scripts/run-perm1-probe.mjs
 *
 * 默认自己起一份应用；接管已经在跑的那份：PERM1_ATTACH=1 node scripts/run-perm1-probe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  Cdp,
  clickByText,
  DEBUG_PORT,
  devLogTail,
  repoRoot,
  sleep,
  startDevApp,
  stopDevApp,
} from './h21-cdp.mjs';

const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1');
const ATTACH = process.env.PERM1_ATTACH === '1';
/**
 * Report and screenshot names.
 *
 * T028 deleted the `PERM1_NATIVE=1` variant. It used to rewrite `dev.env` so the
 * app started on the native engine and then filed its output under a separate
 * name; P6-5 retired the other engine and `AICLIENT_RUNTIME_BACKEND` with it, so
 * the rewrite was a self-declared no-op and the two name sets described one and
 * the same run. The old command line still works, it just files under the one
 * name now.
 */
const REPORT_NAME = 'perm1-report.json';
const SHOT_PREFIX = 'perm1';

/** 输入框旁边那个权限档触发器。标签形如「执行 · 每次询问」。 */
const TRIGGER = `(() => {
  return [...document.querySelectorAll('button[aria-label]')]
    .find((b) => /(执行|规划)\\s·\\s(每次询问|自动接受编辑|全自动)/.test(b.getAttribute('aria-label') ?? ''))
    ?? null;
})()`;

const TRIGGER_LABEL = `(() => ${TRIGGER}?.innerText.trim() ?? null)()`;

/**
 * Base UI 的菜单弹层，**且处于打开状态**。
 *
 * `data-open` 这个条件是必须的，不是讲究：Base UI 关闭弹层之后节点还留在 DOM 里，
 * 只是把 `data-open` 换成 `data-closed`，而且 `display` 仍是 `flex`。只按
 * `querySelector('[role="menu"]')` 判断的话，量到的是「卸载」而不是「关闭」——
 * 卸载受退场动画和上一轮的残留节点影响，本探针第一版就因此把一次正常的关闭读成了
 * 「2.5 秒没关掉」。实测：点完档位后 100ms 内节点连同属性一起消失。
 */
const POPUP = `(() => document.querySelector('[data-slot="menu-popup"][data-open], [role="menu"][data-open]'))()`;

const POPUP_STATE = `(() => {
  const popup = ${POPUP};
  if (!popup) return null;
  return {
    text: popup.innerText,
    items: [...popup.querySelectorAll('[role="menuitemradio"]')].map((n) => ({
      text: n.innerText.replace(/\\n+/g, ' | '),
      checked: n.getAttribute('aria-checked'),
    })),
    buttons: [...popup.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
  };
})()`;

/** 点弹层里的某一档。按可见文字的首行匹配，因为每一档下面还有一行说明。 */
const clickRadio = (label) => `(() => {
  const popup = ${POPUP};
  if (!popup) throw new Error('permission popup is not open');
  const item = [...popup.querySelectorAll('[role="menuitemradio"]')]
    .find((n) => n.innerText.split('\\n')[0].trim() === ${JSON.stringify(label)});
  if (!item) throw new Error('no permission option ' + ${JSON.stringify(label)});
  item.click();
  return true;
})()`;

const openTrigger = `(() => {
  const trigger = ${TRIGGER};
  if (!trigger) throw new Error('no permission trigger in the composer');
  if (trigger.disabled) throw new Error('permission trigger is disabled');
  trigger.click();
  return true;
})()`;

/**
 * 这一轮的审批界面，不管它是哪一种。
 *
 * 正常只有一种：**native** 结构化权限卡，标题「权限」，按钮是词典里的「直接允许 /
 * 本会话内允许 / 直接拒绝 / 拒绝并停止」。
 *
 * 英文兜底那一支留着，但含义变了。它原本抓的是 pi permission-system 插件自己用
 * `ui.select` 提的英文问句——那条通道（扩展 UI）已于决策 012 整链退役，本应用再也
 * 渲染不出它。所以现在抓到英文弹窗只说明「弹了一张不认识的」，要当异常看，不是
 * 第二种正常形态；只找「权限」两个字会把它读成「压根没弹审批」，那是个会误导人的结论。
 */
const APPROVAL_SURFACE = `(() => {
  const read = (node, kind) => node ? {
    kind,
    text: node.innerText,
    buttons: [...node.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
  } : null;
  const zh = [...document.querySelectorAll('*')]
    .find((n) => n.children.length === 0 && n.textContent.trim() === '权限');
  const native = zh?.closest('div[class*="rounded"]') ?? null;
  if (native) return read(native, 'native-card');
  const en = [...document.querySelectorAll('*')]
    .find((n) => n.children.length === 0 && n.textContent.trim() === 'Permission Required');
  const legacy = en?.closest('div[class*="rounded"]') ?? en?.parentElement?.parentElement ?? null;
  return read(legacy, 'unexpected-english-dialog');
})()`;

async function screenshot(cdp, name) {
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 60_000, label: 'window painted' }
  );
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${SHOT_PREFIX}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return path.relative(repoRoot, file);
}

/** 弹层消失了没有。给足动画时间，但不给「等 IPC」那么久。 */
async function popupGone(cdp, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cdp.evaluate(`${POPUP} === null`)) === true) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!ATTACH) {
    stopDevApp();
    startDevApp();
  }
  const cdp = await Cdp.attach(DEBUG_PORT, ATTACH ? 60_000 : 900_000);
  cdp.collectRendererProblems();
  const report = { steps: {} };
  try {
    await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
      timeoutMs: 240_000,
      label: 'renderer painted',
    });
    try {
      await cdp.evaluate(clickByText('使用本机已有配置'));
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
    await sleep(800);

    report.steps.initialLabel = await cdp.evaluate(TRIGGER_LABEL);

    // ── PERM-1 ①：选普通档，弹层必须立刻消失 ──────────────────────────────
    await cdp.evaluate(openTrigger);
    await cdp.waitFor(`${POPUP} !== null`, { timeoutMs: 15_000, label: 'popup open' });
    report.steps.popupContents = await cdp.evaluate(POPUP_STATE);
    report.screenshots = { popup: await screenshot(cdp, 'popup') };

    await cdp.evaluate(clickRadio('自动接受编辑'));
    report.steps.closedOnPlainGear = await popupGone(cdp);
    await sleep(1200);
    report.steps.labelAfterGear = await cdp.evaluate(TRIGGER_LABEL);

    // ── PERM-1 ②：选「全自动」，弹层必须留着并换成确认面板 ────────────────
    await cdp.evaluate(openTrigger);
    await cdp.waitFor(`${POPUP} !== null`, { timeoutMs: 15_000, label: 'popup open again' });
    await cdp.evaluate(clickRadio('全自动'));
    await sleep(900);
    report.steps.autoKeepsPopup = await cdp.evaluate(
      `(() => { const p = ${POPUP}; return p ? p.innerText.includes('启用全自动？') : false; })()`
    );
    report.screenshots.autoConfirm = await screenshot(cdp, 'auto-confirm');
    await cdp.evaluate(clickByText('取消'));
    await sleep(800);
    report.steps.labelAfterCancel = await cdp.evaluate(TRIGGER_LABEL);

    // ── PERM-1 ③：换模式，同样选完即关 ────────────────────────────────────
    if ((await cdp.evaluate(`${POPUP} === null`)) === true) {
      await cdp.evaluate(openTrigger);
      await cdp.waitFor(`${POPUP} !== null`, { timeoutMs: 15_000, label: 'popup open 3' });
    }
    await cdp.evaluate(clickRadio('规划'));
    report.steps.closedOnMode = await popupGone(cdp);
    await sleep(1200);
    report.steps.labelAfterMode = await cdp.evaluate(TRIGGER_LABEL);

    // 复位成「执行 · 每次询问」，否则下一步不会弹权限卡。
    await cdp.evaluate(openTrigger);
    await cdp.waitFor(`${POPUP} !== null`, { timeoutMs: 15_000, label: 'popup open 4' });
    await cdp.evaluate(clickRadio('执行'));
    await sleep(1200);
    await cdp.evaluate(openTrigger);
    await cdp.waitFor(`${POPUP} !== null`, { timeoutMs: 15_000, label: 'popup open 5' });
    await cdp.evaluate(clickRadio('每次询问'));
    await sleep(1500);
    report.steps.labelAfterReset = await cdp.evaluate(TRIGGER_LABEL);

    // ── 权限链：真实回合逼出一张权限卡 ────────────────────────────────────
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('no composer');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '用 bash 运行这条命令：echo perm-probe-ok。只运行，不要解释。');
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
    report.steps.permissionCard = card;
    if (card) {
      report.screenshots.card = await screenshot(cdp, 'approval-surface');
      // 允许那一下：native 卡上是「直接允许」；抓到别的弹窗时按英文 `Yes` 试一次。
      const allowLabel = card.kind === 'native-card' ? '直接允许' : 'Yes';
      report.steps.allowLabel = allowLabel;
      await cdp.evaluate(clickByText(allowLabel));
      await sleep(4000);
      report.steps.afterAllow = await cdp.evaluate(
        `(() => {
          const root = document.getElementById('root');
          return {
            stillPending: ${APPROVAL_SURFACE} !== null,
            sawOutput: (root?.innerText ?? '').includes('perm-probe-ok'),
          };
        })()`
      );
      report.screenshots.afterAllow = await screenshot(cdp, 'after-allow');
    }

    report.rendererProblems = cdp.problems;
    const s = report.steps;
    report.verdict = {
      popupHasAllFourGearsAndModes: (s.popupContents?.items ?? []).length === 5,
      closesOnPlainGear: s.closedOnPlainGear === true,
      labelFollowsGear: (s.labelAfterGear ?? '').includes('自动接受编辑'),
      autoKeepsPopupOpen: s.autoKeepsPopup === true,
      cancelAppliesNothing: (s.labelAfterCancel ?? '').includes('自动接受编辑'),
      closesOnModeChange: s.closedOnMode === true,
      labelFollowsMode: (s.labelAfterMode ?? '').includes('规划'),
      resetBackToAsk: (s.labelAfterReset ?? '').includes('执行 · 每次询问'),
      approvalSurfaceAppeared: card !== null,
      // 只有结构化中文卡算数；抓到别的弹窗这一格记为 null（没测到），不记为通过。
      nativeCardIsChinese:
        card?.kind === 'native-card'
          ? /权限/.test(card.text) && card.buttons.some((b) => b.includes('允许'))
          : null,
      allowClearedTheRequest: s.afterAllow ? s.afterAllow.stillPending === false : null,
    };
    // null = 这一格没测到。没测到不算通过，但也不该和「测到了、是坏的」混为一谈。
    report.verdict.notMeasured = Object.entries(report.verdict)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    report.verdict.pass = Object.entries(report.verdict)
      .filter(([k]) => k !== 'notMeasured')
      .every(([, v]) => v === true);

    fs.writeFileSync(path.join(outDir, REPORT_NAME), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.verdict.pass) process.exitCode = 1;
  } catch (error) {
    console.error('probe failed:', error?.message ?? error);
    console.error(devLogTail(60));
    fs.writeFileSync(
      path.join(outDir, REPORT_NAME),
      JSON.stringify({ ...report, failure: String(error?.message ?? error) }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

await main();
