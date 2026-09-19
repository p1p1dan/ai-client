/**
 * H/19 验证案例 5 的最后一格：托管模式下插件页说的那句话。
 *
 * 为什么要单独起一份应用，而不是在跑着的那份里切模式：`resolveCredentialMode`
 * 在未打包构建里让环境变量压过设置文件（`shared/credentialMode.ts` 的优先级 1），
 * 而 `dev.js` 会把 `dev.env` 里的 `AICLIENT_MANAGED_CREDENTIALS` 一路带到子进程。
 * 开发机的 dev.env 写的是 `0`。所以在应用内调 `auth.enterApp('managed')` 只会把
 * 选择写进 settings.json，`getCredentialMode()` 读出来仍然是 local——界面当然不变。
 * 这不是缺陷，是这条优先级的直接后果，但它足以让一次点验得出相反的结论。
 *
 * 于是这里换一份 dev.env（`AICLIENT_DEV_ENV_FILE` 指过去），把托管打开、顺便关掉
 * 登录门（托管模式没登录会被挡在主界面之外，根本点不到设置）。
 *
 *   node scripts/run-h19-managed-notice-probe.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '..');

const source = path.join(repoRoot, 'dev.env');
if (!fs.existsSync(source)) {
  console.error(`missing ${source}`);
  process.exit(1);
}
const managedEnvFile = path.join(os.tmpdir(), 'h19-dev-managed.env');
fs.writeFileSync(
  managedEnvFile,
  `${fs
    .readFileSync(source, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*AICLIENT_MANAGED_CREDENTIALS\s*=/.test(line))
    .join('\n')}\nAICLIENT_MANAGED_CREDENTIALS=1\nAICLIENT_SKIP_AUTH_GATE=1\n`
);
// startDevApp 把自己的 process.env 原样传给子进程，所以在 import 之前设好。
process.env.AICLIENT_DEV_ENV_FILE = managedEnvFile;

const {
  Cdp,
  clickByText,
  DEBUG_PORT,
  devLogTail,
  ENTER_MAIN_SURFACE,
  sleep,
  startDevApp,
  stopDevApp,
} = await import('./h21-cdp.mjs');

const outDir = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-evolution/evidence/unified-agent-directory'
);

const SECTION = `(() => {
  const input = [...document.querySelectorAll('input')]
    .find((n) => n.getAttribute('aria-label') === '包来源');
  return input ? input.closest('div.space-y-4') : null;
})()`;

/** 只看可交互元素：那句说明本身就含「项目级」，按文字找会把说明当成入口。 */
const PROJECT_SCOPE_CONTROLS = `(() => {
  const section = ${SECTION};
  if (!section) return null;
  return [...section.querySelectorAll('button, input, select, [role="switch"], [role="radio"], [role="tab"], [role="checkbox"]')]
    .map((n) => ({
      tag: n.tagName.toLowerCase(),
      label: (n.getAttribute('aria-label') ?? '').trim(),
      text: (n.innerText ?? '').trim(),
      placeholder: n.getAttribute('placeholder') ?? '',
    }))
    .filter((c) => /项目|project|-l\\b|本地安装/i.test(c.label + ' ' + c.text + ' ' + c.placeholder));
})()`;

async function openPiSettings(cdp) {
  const navReady = `document.querySelector('nav[aria-label="设置"]') !== null`;
  if (!(await cdp.evaluate(navReady))) {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => (n.getAttribute('aria-label') ?? '').startsWith('设置'));
      if (!button) throw new Error('no settings button in the title bar');
      button.click();
      return true;
    })()`);
    await cdp.waitFor(navReady, { timeoutMs: 30_000, label: 'settings dialog open' });
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
  stopDevApp();
  startDevApp();
  const cdp = await Cdp.attach(DEBUG_PORT, 900_000);
  cdp.collectRendererProblems();
  const report = { devEnvFile: managedEnvFile };
  try {
    await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
      timeoutMs: 240_000,
      label: 'renderer painted',
    });
    try {
      await cdp.evaluate(ENTER_MAIN_SURFACE);
      await sleep(2500);
    } catch {
      /* 门已经跳过了 */
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

    await openPiSettings(cdp);
    await sleep(1500);

    report.sectionText = await cdp.evaluate(`${SECTION}?.innerText ?? null`);
    report.noticeShown = await cdp.evaluate(
      `(() => ${SECTION}?.innerText.includes('登录模式下项目级插件不会生效') ?? null)()`
    );
    report.projectScopeControls = await cdp.evaluate(PROJECT_SCOPE_CONTROLS);

    await cdp.waitFor(
      `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
      { timeoutMs: 60_000, label: 'window painted' }
    );
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shot = path.join(outDir, 'h19-managed-project-scope-notice.png');
    fs.writeFileSync(shot, Buffer.from(data, 'base64'));
    report.screenshot = path.relative(repoRoot, shot);
    report.rendererProblems = cdp.problems;
    report.verdict = {
      noticeShown: report.noticeShown === true,
      noProjectScopeControl: (report.projectScopeControls ?? []).length === 0,
    };
    report.verdict.pass = report.verdict.noticeShown && report.verdict.noProjectScopeControl;

    fs.writeFileSync(path.join(outDir, 'h19-managed-notice.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.verdict.pass) process.exitCode = 1;
  } catch (error) {
    console.error('probe failed:', error?.message ?? error);
    console.error(devLogTail(60));
    fs.writeFileSync(
      path.join(outDir, 'h19-managed-notice.json'),
      JSON.stringify({ ...report, failure: String(error?.message ?? error) }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    cdp.close();
    // 一定要停掉：这份应用跑在托管模式下，留着会让后面的点验都在错的模式里跑。
    stopDevApp();
  }
}

await main();
