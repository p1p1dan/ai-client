/**
 * H/19 验证案例 4 与案例 5 的界面半边，在真实应用里点。
 *
 * 案例 4「安装一个 npm 插件后会话里真的可用；卸载后文件与配置都消失；安装失败
 * 有明确原因」。2026-09-10 已经对真实 pi CLI 跑过一次装/关/开/卸的闭环，但那是
 * 直接调服务，绕开了界面，也没回答「会话里真的可用」——那句话的判据不在磁盘上，
 * 在会话加载的扩展清单里。所以这一轮：
 *
 *  - 装和卸都走真实控件（原生 setter 触发 React 的 onChange，再点真按钮），
 *    不调 `window.electronAPI.piPlugins.install`；
 *  - 「会话里真的可用」这一问，2026-09-15 起已经没有肯定的答案：P6-5 退役了会
 *    加载 pi 扩展的引擎，`chat.listSessionExtensions` 随之被
 *    `chat.listSessionCapabilities` 取代（cutover-03）。这一步现在读的是会话自
 *    己的能力清单（MCP / 技能 / 子代理），用来记录「装的扩展不在里面」这个事实
 *    ——扩展只对内嵌 Pi 终端生效，验它得去终端那条路；
 *  - 失败路径用一个确实不存在的包名，判据是界面上出现 npm 自己的报错文本。
 *
 * 案例 5 这里只验界面那一半（托管模式下说明文案出现、且始终没有项目级入口）。
 * 「项目级插件到底生不生效」是机制问题，由 run-h19-project-scope-probe.mjs 用
 * pi 自己的 SettingsManager 做差分回答。
 *
 *   node scripts/run-h19-plugin-gui-probe.mjs
 *
 * 默认接管已经在跑的开发版应用（这台机器冷启动约 9 分钟）。要自己起一份：
 *   H19_FRESH=1 node scripts/run-h19-plugin-gui-probe.mjs
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

const outDir = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-evolution/evidence/unified-agent-directory'
);

const PACKAGE = 'npm:pi-jingle';
/** 一个确定不存在的名字，用来看失败路径说不说人话。 */
const MISSING_PACKAGE = 'npm:aiclient-h19-no-such-package-9f3c1';

const FRESH = process.env.H19_FRESH === '1';

/**
 * 往受控 input 里真的「打字」。
 *
 * React 给 value 装了自己的 setter，直接赋值不会触发 onChange，按钮就一直是
 * disabled。拿原型上的原生 setter 写，再派发 input 事件，才是 React 认的那条路。
 */
const typeInto = (ariaLabel, value) => `(() => {
  const input = [...document.querySelectorAll('input')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)});
  if (!input) throw new Error('no input labelled ' + ${JSON.stringify(ariaLabel)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`;

/**
 * 插件区那个 DOM 节点。
 *
 * 不按标题文字找：「插件」两个字在 Pi 设置页里不止一处（Pi 资源那段也提到它）。
 * 判据改成「这块里有那个 aria-label 为『包来源』的输入框」——整页只有插件区有它。
 */
const SECTION = `(() => {
  const input = [...document.querySelectorAll('input')]
    .find((n) => n.getAttribute('aria-label') === '包来源');
  return input ? input.closest('div.space-y-4') : null;
})()`;

/** 插件区当前在界面上的样子，全部从 DOM 读。 */
const READ_SECTION = `(() => {
  const section = ${SECTION};
  const text = section?.innerText ?? '';
  const rows = [...(section?.querySelectorAll('li') ?? [])].map((li) => ({
    text: li.innerText.replace(/\\n+/g, ' | '),
    hasSwitch: li.querySelector('[role="switch"], button[aria-label="已启用"]') !== null,
    hasRemove: [...li.querySelectorAll('button')]
      .some((b) => (b.getAttribute('aria-label') ?? '').includes('移除')
        || (b.getAttribute('aria-label') ?? '').includes('删除')),
  }));
  const error = section?.querySelector('pre')?.innerText ?? null;
  return { found: section !== null, text, rows, error };
})()`;

/**
 * 「项目级」入口有没有出现在插件区里。
 *
 * 判据是控件，不是文字：托管模式下那句说明本身就含「项目级」三个字，只按文字找
 * 会把说明当成入口。所以只看可交互元素的可见文本与 aria-label。
 */
const PROJECT_SCOPE_CONTROLS = `(() => {
  const section = ${SECTION};
  if (!section) return null;
  const controls = [...section.querySelectorAll('button, input, select, [role="switch"], [role="radio"], [role="tab"], [role="checkbox"]')];
  return controls
    .map((n) => ({
      tag: n.tagName.toLowerCase(),
      label: (n.getAttribute('aria-label') ?? '').trim(),
      text: (n.innerText ?? '').trim(),
      placeholder: n.getAttribute('placeholder') ?? '',
    }))
    .filter((c) => /项目|project|-l\\b|本地安装/i.test(c.label + ' ' + c.text + ' ' + c.placeholder));
})()`;

/**
 * 点插件区里的按钮，而不是整页里第一个长这样的按钮。
 *
 * Pi 设置页上「安装」「移除」这种词在别的段落里也有（迁移、模型管理），不限定
 * 范围就可能点到别人家的按钮，而且点中了也一样返回 true。
 */
const clickInSection = ({ text, label }) => `(() => {
  const section = ${SECTION};
  if (!section) throw new Error('plugin section not mounted');
  const buttons = [...section.querySelectorAll('button')];
  const button = buttons.find((b) =>
    ${text === undefined ? 'false' : `(b.textContent ?? '').trim() === ${JSON.stringify(text)}`} ||
    ${label === undefined ? 'false' : `(b.getAttribute('aria-label') ?? '').includes(${JSON.stringify(label)})`}
  );
  if (!button) throw new Error('no plugin-section button for ' + ${JSON.stringify(text ?? label)});
  if (button.disabled) throw new Error('button is disabled: ' + ${JSON.stringify(text ?? label)});
  button.click();
  return true;
})()`;

/**
 * 磁盘那一侧，探针自己读。
 *
 * 界面与磁盘是两个独立的证据源，用界面自己的 IPC 去读磁盘会让它们塌成一个。
 * 路径不是猜的：来自页面上显示给用户的那一行 `settingsPath`。
 */
function diskSnapshot(settingsPath) {
  const dir = path.dirname(settingsPath);
  const modulesDir = path.join(dir, 'npm/node_modules');
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = null;
  }
  return {
    settingsPath,
    packages: Array.isArray(settings?.packages) ? settings.packages : [],
    nodeModules: fs.existsSync(modulesDir)
      ? fs.readdirSync(modulesDir).filter((name) => !name.startsWith('.'))
      : [],
  };
}

/** 等到界面上的忙碌态散掉：安装要走 npm，按钮在此期间是 disabled。 */
async function waitIdle(cdp, timeoutMs) {
  await cdp.waitFor(
    `(() => {
      const section = ${SECTION};
      if (!section) return false;
      // 安装期间按钮文案是「安装中...」，列表与磁盘都还没定下来。
      return !section.innerText.includes('安装中');
    })()`,
    { timeoutMs, label: 'plugin section idle' }
  );
}

/**
 * 截图落到本节点自己的证据目录。
 *
 * `Cdp.screenshot` 写的是 h21-cdp 里写死的 H/21 目录，那是另一个节点的证据。
 */
async function screenshot(cdp, name) {
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 60_000, label: 'window painted' }
  );
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return path.relative(repoRoot, file);
}

/**
 * 打开设置并停在 Pi 那一页。
 *
 * 走标题栏那个真按钮，不走 `settingsIntent` 那条内部通道：点验要证明的是用户点得
 * 到，而且中途出岔子时也看得出来是哪一步没响应。弹层已经开着就只切分类。
 */
async function openPiSettings(cdp) {
  const dialogOpen = `document.querySelector('nav[aria-label="设置"]') !== null`;
  if (!(await cdp.evaluate(dialogOpen))) {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => (n.getAttribute('aria-label') ?? '').startsWith('设置'));
      if (!button) throw new Error('no settings button in the title bar');
      button.click();
      return true;
    })()`);
    await cdp.waitFor(dialogOpen, { timeoutMs: 30_000, label: 'settings dialog open' });
  }
  await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="设置"]');
    const button = [...nav.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').trim() === 'Pi');
    if (!button) throw new Error('no Pi category in the settings nav');
    button.click();
    return true;
  })()`);
  await cdp.waitFor(`${SECTION} !== null`, {
    timeoutMs: 60_000,
    label: 'plugins section mounted',
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (FRESH) {
    stopDevApp();
    startDevApp();
  }
  const cdp = await Cdp.attach(DEBUG_PORT, FRESH ? 900_000 : 60_000);
  cdp.collectRendererProblems();
  const report = { attached: !FRESH, steps: {} };
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
    // 迁移提示与启动公告比输入框还晚，而且会盖住整屏。
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

    // 起点归一到本地模式。开发机 dev.env 的默认就是它，而这个探针自己会把模式
    // 切到托管再切回来——上一次中途失败就会把环境留在托管态，下一次的「切换前」
    // 读数于是变成托管的读数，两个模式的对比当场作废。
    await cdp.evaluate(`(() => {
      window.__h19init = null;
      window.electronAPI.auth.enterApp('local')
        .then((r) => { window.__h19init = { done: true, result: r }; })
        .catch((e) => { window.__h19init = { done: true, error: String(e?.message ?? e) }; });
      return true;
    })()`);
    report.steps.normalisedToLocal = await cdp.waitFor(
      `window.__h19init?.done ? window.__h19init : null`,
      { timeoutMs: 30_000, label: 'credential mode normalised to local' }
    );

    // 语言固定成中文：这批文案在第 4 批刚接过词典，点验顺带回归。
    await cdp.evaluate(`(async () => {
      const s = await import(/* @vite-ignore */ '/stores/settings/index.ts');
      s.useSettingsStore.setState({ language: 'zh' });
      document.documentElement.lang = 'zh-CN';
      return true;
    })()`);

    await openPiSettings(cdp);
    await waitIdle(cdp, 180_000);

    // agent 目录从界面显示的 settingsPath 拿：这条正是页面承诺给用户的那条路径，
    // 让探针另算一遍就等于在验一个不同的东西。
    const settingsPath = await cdp.waitFor(
      `(() => {
        const section = ${SECTION};
        const match = section?.innerText.match(/(\\/[^\\s]*settings\\.json)/);
        return match ? match[1] : null;
      })()`,
      { timeoutMs: 30_000, label: 'settings path shown' }
    );
    report.settingsPath = settingsPath;

    report.steps.before = {
      ui: await cdp.evaluate(READ_SECTION),
      disk: diskSnapshot(settingsPath),
    };

    // 案例 5 的界面半边（当前模式）。
    report.steps.projectScopeControls = await cdp.evaluate(PROJECT_SCOPE_CONTROLS);
    report.steps.modeNoticeBefore = await cdp.evaluate(
      `(() => {
        return ${SECTION}?.innerText.includes('登录模式下项目级插件不会生效') ?? null;
      })()`
    );

    // ---- 案例 4 ①：真装 ----
    await cdp.evaluate(typeInto('包来源', PACKAGE));
    await sleep(300);
    await cdp.evaluate(clickInSection({ text: '安装' }));
    await sleep(1000);
    await waitIdle(cdp, 300_000);
    await sleep(1500);
    report.steps.afterInstall = {
      ui: await cdp.evaluate(READ_SECTION),
      disk: diskSnapshot(settingsPath),
    };
    report.screenshots = { installed: await screenshot(cdp, 'h19-plugin-installed') };

    // ---- 案例 4 ②：会话自己的能力清单 ----
    // 装完 Main 会 invalidateAll，所以要一个装完之后才 bootstrap 的 worker。
    // 真发一轮，因为这份清单只在有活 worker 时才有答案。
    report.steps.sessionCapabilities = await sessionCapabilityCheck(cdp);

    // ---- 案例 4 ③：装一个不存在的包 ----
    await openPiSettings(cdp);
    await waitIdle(cdp, 180_000);
    await cdp.evaluate(typeInto('包来源', MISSING_PACKAGE));
    await sleep(300);
    await cdp.evaluate(clickInSection({ text: '安装' }));
    await sleep(1000);
    await waitIdle(cdp, 300_000);
    await sleep(1500);
    report.steps.afterFailedInstall = {
      ui: await cdp.evaluate(READ_SECTION),
      disk: diskSnapshot(settingsPath),
    };
    report.screenshots.failed = await screenshot(cdp, 'h19-plugin-install-failed');

    // ---- 案例 4 ④：卸载 ----
    await cdp.evaluate(clickInSection({ label: '移除' }));
    await sleep(1000);
    await waitIdle(cdp, 300_000);
    await sleep(1500);
    report.steps.afterRemove = {
      ui: await cdp.evaluate(READ_SECTION),
      disk: diskSnapshot(settingsPath),
    };

    // ---- 案例 5：托管模式下的说明文案 ----
    report.steps.managedNotice = await managedNoticeCheck(cdp);

    report.rendererProblems = cdp.problems;
    report.verdict = verdict(report);
    fs.writeFileSync(
      path.join(outDir, 'h19-plugin-gui-report.json'),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.verdict.pass) process.exitCode = 1;
  } catch (error) {
    console.error('probe failed:', error?.message ?? error);
    console.error(devLogTail(60));
    fs.writeFileSync(
      path.join(outDir, 'h19-plugin-gui-report.json'),
      JSON.stringify({ ...report, failure: String(error?.message ?? error) }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    cdp.close();
    if (FRESH) stopDevApp();
  }
}

/**
 * 发一轮真实对话，然后问这个会话加载了哪些扩展。
 *
 * 不用合成数据：合成的 store 里没有 worker，而这条判据的全部意义就在于「pi 真的
 * 把它加载进了会话」。回合内容无所谓，只要能让 worker bootstrap 一次。
 */
async function sessionCapabilityCheck(cdp) {
  await cdp.evaluate(`(() => {
    window.__h19ext = null;
    Promise.resolve().then(async () => {
      const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
      const store = chat.useChatSessionsStore.getState();
      const sid = store.activeSessionId;
      if (!sid) throw new Error('no active session');
      return sid;
    }).then(async (sid) => {
      // 先看有没有现成的活 worker；没有就发一轮把它拉起来。
      let list = await window.electronAPI.chat.listSessionCapabilities({ sessionId: sid });
      return { sid, before: list };
    }).then((value) => { window.__h19ext = { done: true, value }; })
     .catch((error) => { window.__h19ext = { done: true, error: String(error?.message ?? error) }; });
    return true;
  })()`);
  const probed = await cdp.waitFor(`window.__h19ext?.done ? window.__h19ext : null`, {
    timeoutMs: 60_000,
    label: 'session capabilities probed',
  });
  if (probed.error) return { error: probed.error };

  // 没有活 worker 就发一轮真实消息，等回合结束再问一次。
  if (probed.value.before === null) {
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('no composer');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '回一个字：好');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await sleep(3000);
  }

  const after = await cdp.waitFor(
    `(() => {
      window.__h19ext2 = window.__h19ext2 ?? null;
      if (!window.__h19ext2) {
        window.__h19ext2 = 'pending';
        Promise.resolve().then(async () => {
          const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
          const sid = chat.useChatSessionsStore.getState().activeSessionId;
          const list = await window.electronAPI.chat.listSessionCapabilities({ sessionId: sid });
          window.__h19ext2 = { done: true, sid, list };
        }).catch((e) => { window.__h19ext2 = { done: true, error: String(e?.message ?? e) }; });
      }
      const value = window.__h19ext2;
      if (value && value.done && value.list === null) { window.__h19ext2 = null; return null; }
      return value && value.done ? value : null;
    })()`,
    { timeoutMs: 240_000, label: 'session capabilities after turn' }
  );
  return after;
}

/**
 * 托管模式下那句说明。
 *
 * 开发机跑在本地模式（dev.env 里 `AICLIENT_MANAGED_CREDENTIALS=0`），所以要把
 * 模式切过去看一眼再切回来。`getPiPluginState` 每次都重新读模式、不缓存，因此
 * 不用重启应用。切回来之后再确认一次说明消失了，免得把环境留在托管态。
 *
 * 让插件页重新 list() 的办法是真点一下分类导航：`SettingsContent` 给内容区挂了
 * `key={activeCategory}`，换一个分类再换回来，整块会重新挂载。先前那版直接把
 * 弹层的 DOM 节点 remove 掉，React 的树和真实 DOM 当场对不上，页面再也回不来。
 */
async function managedNoticeCheck(cdp) {
  const flip = (mode) => `(() => {
    window.__h19mode = null;
    window.electronAPI.auth.enterApp(${JSON.stringify(mode)})
      .then((r) => { window.__h19mode = { done: true, result: r }; })
      .catch((e) => { window.__h19mode = { done: true, error: String(e?.message ?? e) }; });
    return true;
  })()`;
  const clickCategory = (label) => `(() => {
    const nav = document.querySelector('nav[aria-label="设置"]');
    if (!nav) throw new Error('settings nav not found');
    const button = [...nav.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!button) throw new Error('no settings category ' + ${JSON.stringify(label)});
    button.click();
    return true;
  })()`;
  const remount = async () => {
    await cdp.evaluate(clickCategory('通用'));
    await sleep(600);
    await cdp.evaluate(clickCategory('Pi'));
    await cdp.waitFor(`${SECTION} !== null`, {
      timeoutMs: 60_000,
      label: 'plugins section remounted',
    });
    await waitIdle(cdp, 180_000);
    await sleep(1200);
  };
  const noticeShown = () =>
    cdp.evaluate(
      `(() => ${SECTION}?.innerText.includes('登录模式下项目级插件不会生效') ?? null)()`
    );

  const out = {};
  await cdp.evaluate(flip('managed'));
  out.switchToManaged = await cdp.waitFor(`window.__h19mode?.done ? window.__h19mode : null`, {
    timeoutMs: 30_000,
    label: 'switched to managed',
  });
  await remount();
  out.managedNotice = await noticeShown();
  out.managedControls = await cdp.evaluate(PROJECT_SCOPE_CONTROLS);
  out.managedSectionText = await cdp.evaluate(`${SECTION}?.innerText ?? null`);
  out.screenshot = await screenshot(cdp, 'h19-managed-project-scope-notice');

  await cdp.evaluate(flip('local'));
  out.switchToLocal = await cdp.waitFor(`window.__h19mode?.done ? window.__h19mode : null`, {
    timeoutMs: 30_000,
    label: 'switched back to local',
  });
  await remount();
  out.localNotice = await noticeShown();
  return out;
}

function verdict(report) {
  const before = report.steps.before;
  const installed = report.steps.afterInstall;
  const failed = report.steps.afterFailedInstall;
  const removed = report.steps.afterRemove;
  const managed = report.steps.managedNotice ?? {};
  const extensions = report.steps.sessionExtensions?.list ?? null;
  const checks = {
    sectionFound: before?.ui?.found === true,
    installedRowShown: (installed?.ui?.rows ?? []).some((r) => r.text.includes('pi-jingle')),
    installedOnDisk:
      (installed?.disk?.packages ?? []).some((p) =>
        typeof p === 'string' ? p === PACKAGE : p?.source === PACKAGE
      ) && (installed?.disk?.nodeModules ?? []).includes('pi-jingle'),
    loadedInSession: Array.isArray(extensions)
      ? extensions.some((e) => (e.source ?? '') === PACKAGE || (e.name ?? '').includes('jingle'))
      : null,
    failureExplained: typeof failed?.ui?.error === 'string' && failed.ui.error.trim().length > 0,
    failureLeftNoTrace: !(failed?.disk?.nodeModules ?? []).some((n) =>
      n.includes('no-such-package')
    ),
    removedFromDisk:
      !(removed?.disk?.packages ?? []).some((p) =>
        typeof p === 'string' ? p === PACKAGE : p?.source === PACKAGE
      ) && !(removed?.disk?.nodeModules ?? []).includes('pi-jingle'),
    removedFromUi: !(removed?.ui?.rows ?? []).some((r) => r.text.includes('pi-jingle')),
    noProjectScopeControlLocal: (report.steps.projectScopeControls ?? []).length === 0,
    noProjectScopeControlManaged: (managed.managedControls ?? []).length === 0,
    managedNoticeShown: managed.managedNotice === true,
    localNoticeHidden: managed.localNotice === false,
  };
  // `loadedInSession` 为 null 表示这一条没测到（没拿到活 worker），按未通过报，
  // 不按通过。点验里「没测到」和「测到没问题」必须分得开。
  return { ...checks, pass: Object.values(checks).every((v) => v === true) };
}

await main();
