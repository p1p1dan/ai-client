/**
 * 批次 4 点验：中文界面里还剩多少硬编码英文。
 *
 * 为什么用合成 transcript 而不是跑一个真实回合：要查的是「这些词有没有翻」，
 * 不是「模型答得对不对」。真实回合要等模型、要配凭据、还未必一次就把权限卡和
 * 各种工具动词都凑齐；直接往 store 里塞一段包含全部形态的对话，一屏就能看完，
 * 而且每次都一样。这台机器 2 核 / 3.3 GB，少起一次 Electron 是实打实的。
 *
 *   node scripts/run-batch4-language-probe.mjs
 *
 * 输出：截图 + 整屏文本里挑出来的 ASCII 片段（剩余英文的嫌疑名单）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  Cdp,
  clickByText,
  devLogTail,
  ENTER_MAIN_SURFACE,
  repoRoot,
  sleep,
  startDevApp,
  stopDevApp,
} from './h21-cdp.mjs';

const outDir = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-evolution/evidence/chinese-ui-residue'
);

/** 兜底；真正用的是界面当前选中的那个会话，见 SEED。 */
const FALLBACK_SESSION_ID = 'session-live';

/** 一段覆盖各种行形态的合成对话：工具动词、思考行、权限卡、审批记录。 */
const SEED = `(async () => {
  const [chat, settings] = await Promise.all([
    import(/* @vite-ignore */ '/stores/chatSessions.ts'),
    import(/* @vite-ignore */ '/stores/settings/index.ts'),
  ]);
  settings.useSettingsStore.setState({ language: 'zh' });
  document.documentElement.lang = 'zh-CN';

  // 用界面当前选中的会话，而不是硬写一个 id：侧栏里已经有一堆真实会话，
  // 改 activeSessionId 会被会话恢复逻辑盖回去，塞进去的对话就永远不显示。
  const sid = chat.useChatSessionsStore.getState().activeSessionId ?? ${JSON.stringify(FALLBACK_SESSION_ID)};
  const call = (id, name, input) => ({ id, type: 'tool_call', toolCallId: id, toolName: name, toolInput: input });
  const result = (id, text) => ({ id: id + '-r', type: 'tool_result', toolCallId: id, toolOk: true, text });

  chat.useChatSessionsStore.setState((prev) => ({
    messages: {
      ...prev.messages,
      [sid]: [
        { id: 'u1', sessionId: sid, role: 'user', blocks: [{ id: 'u1b', type: 'text', text: '看一下这个仓库' }] },
        {
          id: 'a1',
          sessionId: sid,
          role: 'assistant',
          blocks: [
            { id: 'th1', type: 'thinking', text: '先读一遍再说' },
            call('c1', 'Bash', { command: 'pnpm test' }), result('c1', 'ok'),
            call('c2', 'Grep', { pattern: 'TODO' }), result('c2', 'src/a.ts:1'),
            call('c3', 'Read', { file_path: '/repo/src/a.ts' }), result('c3', 'file body'),
            call('c4', 'Edit', { file_path: '/repo/src/a.ts' }),
            {
              id: 'pa1',
              type: 'permission_activity',
              permissionActivity: { requestId: 'pa1', surface: 'bash', value: 'rm -rf /tmp/x', result: 'deny' },
            },
            {
              id: 'pa2',
              type: 'permission_activity',
              permissionActivity: {
                requestId: 'pa2', surface: 'read', value: '/repo/src/a.ts',
                result: 'allow', resolution: 'policy_allow', matchedPattern: 'src/**',
              },
            },
            {
              id: 'perm1',
              type: 'permission_request',
              permissionId: 'perm1',
              toolName: 'write',
              toolDescription: '写入 notes.md',
              permissionKind: 'file_change',
              permissionDecisions: ['allow', 'allow_session', 'deny', 'cancel'],
              toolInput: { content: 'hello world', contentLabel: 'Content', workspace: '/repo' },
            },
          ],
        },
      ],
    },
    pendingPermissions: [{ sessionId: sid, permissionId: 'perm1' }],
  }));
  return sid;
})()`;

/**
 * 整屏文本里的 ASCII 片段。
 *
 * 不是「有英文就算漏」——路径、命令、工具名、模型 ID 本来就该是原文。所以这里
 * 只是把嫌疑列出来给人看，不做自动判定：能自动判的那部分已经由
 * chineseChatSurface / toolVocabulary 两个测试守住了。
 */
const ASCII_RUNS = `(() => {
  const text = document.getElementById('root')?.innerText ?? '';
  const hits = text.match(/[A-Za-z][A-Za-z '’\\-]{3,}/g) ?? [];
  const counts = new Map();
  for (const h of hits) {
    const k = h.trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => n + '× ' + k);
})()`;

const PLACEHOLDER = `(() => {
  const ta = document.querySelector('textarea');
  return ta ? ta.getAttribute('placeholder') : null;
})()`;

const MODEL_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => (n.getAttribute('aria-label') ?? '').includes('思考强度') || (n.getAttribute('aria-label') ?? '').includes('reasoning effort'));
  return b ? { label: b.getAttribute('aria-label'), title: b.getAttribute('title') } : null;
})()`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  stopDevApp();
  startDevApp();
  const cdp = await Cdp.attach();
  cdp.collectRendererProblems();
  try {
    await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
      timeoutMs: 180_000,
      label: 'renderer painted',
    });
    // 起始页挡在前面：先按「使用本机已有配置」进到主界面，再塞对话。
    // 这一步失败不算致命 —— 如果这台机器上已经引导过，按钮本来就不在。
    try {
      await cdp.evaluate(ENTER_MAIN_SURFACE);
      await sleep(2500);
    } catch {
      /* 已经引导过了 */
    }
    await cdp.waitFor(`document.querySelector('textarea') !== null`, {
      timeoutMs: 60_000,
      label: 'composer mounted',
    });
    // 迁移提示（H/21 P1）和启动公告都是异步算出来才弹的，比输入框晚，而且会
    // 盖住整屏。所以放在这儿轮询，不是开头点一下就算。
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
    await cdp.evaluate(SEED);
    await sleep(2000);

    const shotData = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shot = path.join(outDir, 'batch4-transcript-zh.png');
    fs.writeFileSync(shot, Buffer.from(shotData.data, 'base64'));

    const report = {
      screenshot: path.relative(repoRoot, shot),
      placeholder: await cdp.evaluate(PLACEHOLDER),
      modelButton: await cdp.evaluate(MODEL_BUTTON),
      asciiRuns: await cdp.evaluate(ASCII_RUNS),
      rendererProblems: cdp.problems,
    };
    fs.writeFileSync(path.join(outDir, 'batch4-report.json'), JSON.stringify(report, null, 2));
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
