#!/usr/bin/env node
/**
 * fv-report.mjs — fold the three fix-verify probe outputs into one report.
 *
 * Assembled from the probes' own JSON rather than retyped, so every number in
 * the report is the number the page actually answered with.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/fix-verify';

const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const f12 = read('fv-f1-f2.json');
const f56 = read('fv-f5-f6-state.json');
const off = read('fv-off-effort.json');

const step = (label) => (f12.steps ?? []).find((s) => s.label === label) ?? null;
const shot = (name) => path.join(OUT, name);

const report = {
  probe: 'fix-verify (F1 / F2 / F5 / F6 + off level)',
  at: new Date().toISOString(),
  branch: 'feat/runtime-evolution',
  head: '6ea3fb2d',
  commitsUnderTest: {
    F1: '171d1369 fix(editor): 命中列表跳行在编辑器已打开其他文件时也生效',
    F2: '539cd754 fix(chat): 搜索命中列表弹层锚定到搜索行而不是视口左上角',
    F5: 'f059a8ae fix(runtime): 回合被中止或报错时不再把上下文占用清成 0%',
    F6: '6ea3fb2d fix(chat): 时间线审批行显示发起请求的子代理',
  },
  environment: {
    mode: 'electron-vite dev + CDP 9222',
    model: 'claude/claude-opus-5',
    credentials: "托管 auth.json 的 claude 条目（公司中转）；未用 cx2 / maxapi / vllmproxy / beehears / 真实 anthropic",
    permissionMode: '执行 · 每次询问',
    srcChanged: false,
    appRestarts: 3,
    realModelTurns: 5,
  },

  F1: {
    criterion:
      '编辑器已开着文件 A 时，点命中列表里另一个文件 B 的第 N 行：B 打开、Monaco 光标行 = N、pendingCursor 清空；再点回 A 的另一行也要跳',
    pass: f12.verdict?.f1?.pass === true && f12.verdict?.f1?.backToAPass === true,
    transcript: '合成（零模型回合）',
    sessionId: f12.sessionId ?? null,
    readings: [
      { step: 'step1 · 首次打开 A', ...(step('step1-open-A') ? {
        clicked: step('step1-open-A').clicked,
        activeTabPath: step('step1-open-A').after.activeTabPath,
        currentCursorLine: step('step1-open-A').after.currentCursorLine,
        pendingCursor: step('step1-open-A').after.pendingCursor,
        expect: step('step1-open-A').expect,
        pass: step('step1-open-A').pass,
      } : {}) },
      { step: 'step2 · 编辑器已开 A 时点 B（旧缺陷暴露点）', ...(step('step2-other-file-B') ? {
        clicked: step('step2-other-file-B').clicked,
        tabsBefore: step('step2-other-file-B').before.tabs,
        activeTabPath: step('step2-other-file-B').after.activeTabPath,
        currentCursorLine: step('step2-other-file-B').after.currentCursorLine,
        pendingCursor: step('step2-other-file-B').after.pendingCursor,
        expect: step('step2-other-file-B').expect,
        pass: step('step2-other-file-B').pass,
      } : {}) },
      { step: 'step3 · 再点回 A 的另一行', ...(step('step3-back-to-A') ? {
        clicked: step('step3-back-to-A').clicked,
        tabsBefore: step('step3-back-to-A').before.tabs,
        activeTabPath: step('step3-back-to-A').after.activeTabPath,
        currentCursorLine: step('step3-back-to-A').after.currentCursorLine,
        pendingCursor: step('step3-back-to-A').after.pendingCursor,
        expect: step('step3-back-to-A').expect,
        pass: step('step3-back-to-A').pass,
      } : {}) },
    ],
    before0919Morning:
      '倒序实验：第二次开文件不跳行，pendingCursor 挂着不被消费（model-11/model-11-jump-order.json）',
    screenshot: shot('fix-f1-second-file-jump.png'),
    rawProbeOutput: shot('fv-f1-f2.json'),
  },

  F2: {
    criterion: '悬停搜索行后弹层锚在触发元素附近（垂直相邻、水平重叠），不再是 [0, 4, …]',
    pass: f12.verdict?.f2?.pass === true,
    readings: {
      triggerDisplay: f12.verdict?.f2?.triggerDisplay ?? null,
      triggerClientRects: f12.verdict?.f2?.triggerClientRects ?? null,
      triggerRect_xywh: f12.verdict?.f2?.triggerRect ?? null,
      positionerRect_xywh: f12.verdict?.f2?.positionerRect ?? null,
      contentRect_xywh: f12.verdict?.f2?.contentRect ?? null,
      verticalGapPx: f12.verdict?.f2?.verticalGapPx ?? null,
      horizontalOverlapPx: f12.verdict?.f2?.horizontalOverlapPx ?? null,
      allHoverAnchors: f12.verdict?.f2?.allHoverAnchors ?? null,
    },
    before0919Morning: {
      triggerDisplay: 'contents',
      triggerRect_xywh: [0, 0, 0, 0],
      triggerClientRects: 0,
      positionerRect_xywh: [0, 4, 560, 122],
    },
    screenshot: shot('fix-f2-popover-anchor.png'),
    rawProbeOutput: shot('fv-f1-f2.json'),
  },

  F5: {
    criterion:
      'Task 回合中途 Stop：Stop 前后徽标文案一致且非 0%，store factsBySession[sid].usage.context.tokens 非 0',
    pass: f56.verdict?.f5?.pass === true,
    sessionId: f56.f5SessionId ?? null,
    prompt: f56.f5Prompt ?? null,
    timing: f56.f5Timing ?? null,
    readings: {
      chipOnEmptySession: f56.f5Initial?.chip ?? null,
      chipJustBeforeStop: f56.f5BeforeStop?.chip ?? null,
      chipAfterStop: f56.f5AfterStop?.chip ?? null,
      contextJustBeforeStop: f56.f5BeforeStop?.usage?.context ?? null,
      contextAfterStop: f56.f5AfterStop?.usage?.context ?? null,
      usageKeysAfterStop: f56.f5AfterStop?.usage?.keys ?? null,
      usageUpdatedAfterStopClick: f56.f5PostStopBroadcasts ?? null,
      subagentLaneAfterStop: f56.f5AfterStop?.lanes ?? null,
      permissionCardsAnswered: (f56.f5Lane?.drive?.cards ?? []).map((c) => ({
        decision: c.decision,
        clicked: c.clicked,
        cardHead: String(c.card?.text ?? '').replace(/\n/g, ' | ').slice(0, 160),
      })),
    },
    before0919Morning: {
      chip: '2% → 0%',
      contextAfterStop: { tokens: 0, contextWindow: 1000000, percent: 0 },
      note: 'Stop 后连发两条 usage.updated，context 被清成 0，session / delegated 仍是真实累计值',
    },
    screenshots: [shot('fix-f5-badge-after-stop.png'), shot('fix-f5-badge-before-stop.png')],
    rawProbeOutput: shot('fv-f5-f6-state.json'),
  },

  F6: {
    criterion:
      '子代理撞闸门被拒后，时间线审批行能读出是哪个子代理（li[data-tone="denied"] 文本含 explorer，store 记录 agentName）',
    pass: f56.verdict?.f6?.pass === true,
    roundUsed: f56.verdict?.f6?.round ?? null,
    readings: {
      paintedDeniedRows: f56.verdict?.f6?.deniedRows ?? null,
      scrolledRowText: f56.verdict?.f6?.scrolledRowText ?? null,
      storeAttributionFields: f56.verdict?.f6?.attributionFields ?? null,
      turnMs: f56.verdict?.f6?.turnMs ?? null,
    },
    rounds: ['f6', 'f6b', 'f6c'].map((key) => {
      const round = f56[key];
      if (!round) return { key, run: false };
      return {
        key,
        run: true,
        sessionId: round.sessionId,
        prompt: round.prompt,
        turnMs: round.turn?.totalMs ?? null,
        cardsAnswered: (round.turn?.cards ?? []).length,
        deniedRows: (round.after?.activityRows ?? []).filter((r) => r.tone === 'denied').map((r) => r.text),
        permissionActivityCount: (round.blocks?.permissionActivity ?? []).length,
        outcome:
          key === 'f6'
            ? '模型自拒，0 次工具调用、0 次委派 —— findings.md 观察段「危险味提示词模型会自拒」的又一例'
            : key === 'f6b'
              ? 'explorer 真的跑了 bash `cat .env`，被硬编码路径 deny 拦下（回执「shell operand is denied: …/.env」），零审批活动、零审计行 —— F7 未修，原样复现'
              : 'explorer 跑 bash `pwd` 触发 ask 卡，先截图再点「直接拒绝」，结算出一条带归因的审计行',
      };
    }),
    before0919Morning: {
      rowText: '已拒绝 bash pwd',
      storeRecord: {
        forwarded: null,
        requesterAgentName: null,
        delegationId: '1103083d-…',
        agentName: 'explorer',
      },
      note: '名字就在记录里，渲染层查的是永远为空的键',
    },
    screenshots: [shot('fix-f6-subagent-row.png'), shot('fix-f6-permission-card-f6c-1.png')],
    rawProbeOutput: shot('fv-f5-f6-state.json'),
  },

  offLevel: {
    criterion:
      '平台 off 档：强制刷新后本地目录 updatedAt 与 thinkingLevelMap.off；菜单是否出现「关闭」档；选中后跑一条短回合看 Thinking 计数与 usage.reasoning',
    pass:
      off.verdict?.offOfferedInMenu === true &&
      off.verdict?.offValues?.['claude/claude-opus-5'] === 'off',
    readings: {
      catalogUpdatedAtBeforeForcedSync: off.catalogBefore?.updatedAt ?? null,
      catalogUpdatedAtAfterForcedSync: off.catalogAfter?.updatedAt ?? null,
      forcedSyncResult: off.sync ?? null,
      thinkingLevelMapOff: off.verdict?.offValues ?? null,
      menuItems: (off.menu?.items ?? []).map((i) => i.text),
      offMenuLabel: off.verdict?.offMenuLabel ?? null,
      triggerAfterPick: off.verdict?.triggerAfterPick ?? null,
      triggerAriaLabelAfterPick: off.triggerAfter?.ariaLabel ?? null,
      turn: { prompt: off.prompt ?? null, totalMs: off.turn?.totalMs ?? null, trail: off.turn?.trail ?? null },
      thinkingClauseLines: off.verdict?.thinkingClausesOnTurn ?? null,
      thinkingBlockCount: off.verdict?.thinkingBlocks ?? null,
      usageReasoning: off.verdict?.usageReasoning ?? null,
      usageHasReasoningKey: off.verdict?.usageHasReasoningKey ?? null,
      blockTypeCounts: off.blocks?.blockTypeCounts ?? null,
      turnHeadLines: off.turnLine?.headLines ?? null,
    },
    notes: [
      '本地目录在本轮探针的强制刷新之前就已经是 10:55:45Z —— 应用这次启动时的常规同步已经把新目录拉下来了；强制刷新 ok:true / source:remote，updatedAt 不变，说明与远端一致。',
      '档位在菜单里仍写英文「Off」而不是词条里的「关闭」：i18n.ts:1243 有 Off: 关闭，但 composerModel.ts 的 effortItems 直接用 ChatEffort.label，没走 t() —— 09-19 上午记的 F4 文案项，未修，原样复现。',
    ],
    screenshots: [shot('fix-off-effort-menu.png'), shot('fix-off-turn.png')],
    rawProbeOutput: shot('fv-off-effort.json'),
  },

  incidents: [
    '第一次 F1/F2 跑到第三次开文件时渲染进程卡死（0% CPU、Runtime.evaluate 3 分钟无响应、swap 用到 1.8 GB），被外层 timeout 杀掉。重启应用后同一脚本 90 秒内三步全绿，判为 2 核 3.3 GB 机器的内存/换页问题，不是修复引入的。探针已改成每步落盘。',
    'F6 连跑三轮才拿到审计行：第一轮模型自拒（0 工具调用），第二轮 explorer 真去 cat .env 但撞的是硬编码路径 deny（F7 未修，闸门之前短路，零审计行），第三轮改成「让 explorer 跑 pwd、我在卡上点拒绝」才走完闸门。',
  ],

  probes: [
    shot('../tools/fv-f1-f2.mjs'),
    shot('../tools/fv-f5-f6.mjs'),
    shot('../tools/fv-off-effort.mjs'),
    shot('../tools/fv-stop-app.mjs'),
    shot('../tools/fv-report.mjs'),
  ].map((p) => path.normalize(p)),
};

const file = path.join(OUT, 'report.json');
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report → ${file}`);
console.log(
  JSON.stringify(
    {
      F1: report.F1.pass,
      F2: report.F2.pass,
      F5: report.F5.pass,
      F6: report.F6.pass,
      off: report.offLevel.pass,
    },
    null,
    1
  )
);
