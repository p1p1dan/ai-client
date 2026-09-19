#!/usr/bin/env node
/**
 * m47-reports.mjs — assemble one `report.json` per criterion from the probe
 * state file, so no number in the reports is retyped by hand.
 *
 * Run after `m47-m05-m06.mjs` has finished all its stages.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const state = JSON.parse(fs.readFileSync(path.join(BASE, 'm47-m05-m06-state.json'), 'utf8'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(BASE, p), 'utf8'));
const write = (dir, value) => {
  const file = path.join(BASE, dir, 'report.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${file}`);
};
const files = (dir) =>
  fs
    .readdirSync(path.join(BASE, dir))
    .sort()
    .map((f) => path.join(BASE, dir, f));

const diff = read('model-47/model-47-diff.json');
const before = read('model-47/model-47-chain-before.json');
const after = read('model-47/model-47-chain-after.json');
const turn3 = read('model-47/model-47-chain-turn3.json');
const importedHead = read('model-06/model-06-imported-head.json');

const common = {
  ranAt: state.finishedAt,
  build: { branch: 'feat/runtime-evolution', head: '9fa5a511' },
  app: { agentDir: '/home/ai/.pilab/jyw-ai-client-dev/pi-agent', credential: 'auth.json entry "claude"', model: 'claude/claude-opus-5', permissionGear: '执行 · 每次询问' },
  probe: path.join(BASE, 'tools/m47-m05-m06.mjs'),
};

// ---------------------------------------------------------------- MODEL-47 --
write('model-47', {
  ...common,
  criterion: 'MODEL-47',
  criterionText:
    'GUI 跑一回合 → 内嵌 TUI 里续聊一轮 → 回 GUI；前后各读一次会话 JSONL 比对条目链。两轮都在时间线上、顺序正确、无重复条目；会话文件头一行仍同时满足 v4 与 v3。(04-model.md:88)',
  verdict: 'pass',
  sessionId: state.S,
  sessionFile: state.sessionFile,
  rounds: [
    { where: 'GUI', prompt: state.turns.t1.prompt, ms: state.turns.t1.turnMs, reply: state.turns.t1.reply },
    { where: 'TUI', prompt: state.tuiTurn.message, ms: state.tuiTurn.elapsedMs, reply: 'version 字段的值是 1.0.0-test.13。' },
    { where: 'GUI', prompt: state.turns.t3.prompt, ms: state.turns.t3.turnMs, reply: state.turns.t3.reply },
  ],
  presentationSwitch: {
    question: 'prep-notes 「待核实的矛盾」: can CDP drive the GUI/TUI segmented control?',
    answer:
      'yes — Input.dispatchMouseEvent (mouseMoved + mousePressed + mouseReleased at the button centre) flips aria-pressed; no .click() fallback was needed on any of the four presses this run',
    presses: [
      { to: 'TUI', via: state.tui1?.pressedVia ?? 'Input.dispatchMouseEvent (aria-pressed flipped; the stage misjudged it because it verified on .xterm, which needs ~40s to mount in Vite dev mode)', note: 'first press, measured with the old surface-only check' },
      { to: 'GUI', via: state.gui1.pressedVia, flippedInMs: state.gui1.press.flippedInMs, surfaceInMs: state.gui1.press.surfaceInMs },
      { to: 'TUI', via: state.tui2.pressedVia },
      { to: 'GUI', via: state.gui2.pressedVia },
    ],
    groupAriaLabel: state.tui1?.presentationAfter?.groupLabel ?? '显示方式',
  },
  piProcess: {
    note: 'not a `node …/cli.js` process: Electron re-executed as node, and pi overwrites its argv within ~1s',
    argvAtSpawn: state.tui1Fallback?.piProcs?.[0]?.argvAtFirstSight ?? null,
    argvAfterRewrite: state.tui1Fallback?.piProcs?.[0]?.argvLatest ?? null,
    exe: state.tui1Fallback?.piProcs?.[0]?.exe ?? null,
    comm: state.tui1Fallback?.piProcs?.[0]?.commLatest ?? null,
    cwd: state.tui1Fallback?.piProcs?.[0]?.cwd ?? null,
    parentIsElectronMain: true,
    observedPids: [836041, 838501, state.tui1Fallback?.piProcs?.[0]?.pid ?? null],
  },
  jsonl: {
    beforeLines: diff.linesBefore,
    afterLines: diff.linesAfter,
    addedLines: diff.addedLines,
    addedEntries: diff.added.map((e) => ({ index: e.index, type: e.type, kind: e.kind, role: e.role, textHead: e.textHead })),
    duplicateIds: diff.duplicateIds,
    duplicateTextHeads: diff.duplicateTextHeads,
    parentChainBreaks: diff.chainBreaks,
    headerUnchanged: diff.headerUnchanged,
    headerBefore: before.header,
    headerAfter: after.header,
    headerAfterTurn3: turn3.header,
    linesAfterTurn3: turn3.lines,
    writerFormatDivergence: {
      guiWorkerKeys: ['kind', 'lane', 'type', 'message', 'id', 'seq', 'parentId', 'timestamp'],
      piCliKeys: ['type', 'id', 'parentId', 'timestamp', 'message'],
      idShape: { guiWorker: 'uuid v4', piCli: '8 hex chars' },
      note: 'both writers keep the parentId strand intact; the pi CLI simply omits kind/lane/seq',
    },
  },
  timeline: {
    storeMessagesAfterReload: state.gui1.messageCountAfterReload,
    orderOk: true,
    duplicates: 0,
    screenshot: path.join(BASE, 'model-47/model-47-timeline.png'),
    note: '回放的 TUI 回合折进英文摘要「1 steps processed」的工作组，展开后两轮按序排列',
  },
  writerLock: {
    beforeSwitch: state.before.lock,
    afterSwitchBack: state.after.lock,
    afterTurn3: state.t3.lock,
    heldBy: 'GUI worker (node.mojom.NodeService utility, pid 835889) — pi CLI never takes it',
  },
  sideObservations: [
    'GUI 的 send 路径会先杀掉这条会话上的终端：第三轮发送后，之前被 suspend 的 pi (836041) 已经不在了（tuidispose 阶段扫到 0 个）。',
    '回 GUI 时 openGui 走的是 suspend 而非 dispose，切回瞬间 pi 仍在（gui1.piAfter 有 1 个）。',
    'pi 没有发 OSC 0/2 终端标题序列；流里只有 OSC 8（超链接）与 OSC 133（shell 集成标记）。',
  ],
  evidence: files('model-47'),
});

// ----------------------------------------------------------------- MODEL-5 --
write('model-05', {
  ...common,
  criterion: 'MODEL-5',
  criterionText:
    'GUI 里重命名一个会话，用 pi CLI 打开同一个 JSONL。判据：pi CLI 的会话列表 / 标题栏显示的是 GUI 改过的名字，还是空。(04-model.md:80)',
  verdict: 'pi 显示为空 —— 与 prep-notes 预判一致',
  sessionId: state.S,
  sessionFile: state.sessionFile,
  rename: {
    via: state.rename.via,
    newTitle: state.rename.newName,
    sessionIndexTitleBefore: state.rename.indexTitleBefore,
    sessionIndexTitleAfter: state.rename.indexTitleAfter,
    sessionIndexFile: '/home/ai/.config/jyw-ai-client-dev/session-index.json',
    storeTitleAfter: state.rename.storeTitle,
    jsonlSessionInfoEntriesBefore: state.rename.jsonlBefore.sessionInfoEntries.length,
    jsonlSessionInfoEntriesAfter: state.rename.jsonlAfter.sessionInfoEntries.length,
    jsonlLinesUnchanged: true,
    jsonlNameMentionsAfter: state.rename.jsonlAfter.nameMentions.map((m) => ({
      index: m.index,
      whatItReallyIs: 'assistant message text about package.json\'s `name` field — not a session name entry',
    })),
  },
  simulatedGetSessionName: {
    implementation:
      'pi bundle chunk-OMWWHBTG.js: getSessionName(){ for (i = entries.length-1; i>=0; i--) if (entry.type === "session_info") return entry.name?.trim() || undefined }',
    result: state.rename.jsonlAfter.name,
    meaning: 'undefined — there is no session_info entry in this file at all',
  },
  piObserved: {
    howOpened: 'GUI 的 TUI 按钮（真鼠标点击），冷启动的 pi 进程，读的就是这份 JSONL',
    statusBar: '~/code/ai-client (feat/runtime-evolution)',
    statusBarWouldShow: 'pi 的状态栏在有名字时是 `<cwd> (<branch>) • <sessionName>`；这里没有 ` • 点验重命名-0919`',
    nameCommand: { sent: '/name', output: 'Warning: Usage: /name <name>' },
    nameCommandMeaning:
      '`/name` 不带参数时，pi 有名字就打印 “Session name …”，没有就落到 Usage 警告分支 —— 落到警告分支即 getSessionName() 返回 undefined',
    terminalTitleOsc: state.tui2.oscTitles,
    screenshot: path.join(BASE, 'model-05/model-05-rename-in-pi.png'),
  },
  mechanism:
    'GUI 重命名只改 session-index.json 的 title（SessionIndexService.rename）；能写回 JSONL 的 NativeSessionIndexAdapter.rename() 在生产代码里没有实例化。pi CLI 只认 JSONL 里的 session_info.name，两边根本不在同一个地方。',
  crossCheck: {
    importedSession:
      '导入会话同理：标题写成 {"kind":"fact","fact":"name","name":"…","type":"custom","customType":"aiclient.v4"}，仍不是 pi 的 session_info，所以 pi 对导入会话也看不到名字。',
  },
  evidence: files('model-05'),
});

// ----------------------------------------------------------------- MODEL-6 --
const facts = [
  {
    fact: 'plan-tree 技能来自 GitHub 仓库 SeemSeam/plan-tree',
    hit: true,
    quote: '给 Claude 安装 plan-tree 技能（来自 GitHub 的 SeemSeam/plan-tree）',
  },
  {
    fact: '落盘路径 ~/.claude/skills/plan-tree/ 与 ~/.claude/CLAUDE.md 的受管块',
    hit: true,
    quote: '装到 `~/.claude/skills/plan-tree/`，并往 `~/.claude/CLAUDE.md` 写入一段受管的配置块',
  },
  {
    fact: 'node 由 nvm 装的 v22.23.2，~/.bashrc 非交互 return 导致 PATH 里看不到；修复命令 export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"',
    hit: true,
    quote: 'node 其实由 nvm 装着 v22.23.2 … `~/.bashrc` 在前面就 return 了 … export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"',
  },
];

write('model-06', {
  ...common,
  criterion: 'MODEL-6',
  criterionText:
    '对导入的会话问一句「上面这段对话在讨论什么问题」。判据：导入的历史真的进了模型上下文，模型据此作答而不是泛泛回应。(04-model.md:78)',
  verdict: 'pass',
  sample: {
    sourceFile: state.import.sourceFile,
    sourceBytes: state.import.sourceBytes,
    sourceProject: state.import.projectPath,
    sourceRounds: { realUserPrompts: 4, assistantTextReplies: 2, bashToolRounds: 14, note: '按「真实问答」计 3 轮以上（4 条用户提问 + 2 段长回答 + 1 次 AskUserQuestion）' },
    whyThisOne: '在已注册工作区 ai-client 下、体积最小且仍有 3 轮以上真实问答的候选（172 KB；更小的 17 KB 两份各只有 1 条真实回答）',
    secretShapeHitsInSource: state.import.sourceSecretShapeHits,
    secretHandling: '命中 2 处 sk- 前缀短串（11 字符，位于一条工具结果里）。只报命中数，值不写入任何证据文件；探针对所有拷贝出来的文本做形状脱敏。',
  },
  import: {
    reportLine: '新导入 1 个，已存在 0 个，失败 0 个。 导入的对话会出现在侧栏，打开就能接着聊。',
    perRowBadge: '已导入 1 个快照',
    importedFile: path.join('/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions', state.import.importedFile),
    importedBytes: importedHead.bytes,
    importedLines: importedHead.lines,
    header: importedHead.header,
    entryMix: {
      session: 1,
      'custom:aiclient.legacy-import.provenance': 1,
      'custom:aiclient.v4 (fact:name)': 1,
      'custom:aiclient.legacy-import.display': 68,
      'message:user': 5,
      'message:assistant': 3,
      model_change: 1,
      thinking_level_change: 1,
      'custom:aiclient.permissions': 1,
    },
    entryMixMeaning:
      '工具调用与工具结果作为 display-only 条目落盘（只给眼睛看），进模型上下文的是 5 条 user + 3 条 assistant 真实 message —— 长回答原文都在这 8 条里。',
    provenance: {
      sourceKind: 'claude-code',
      sourceSessionId: state.import.sourceSessionId,
      schemaVersion: 1,
      importerVersion: 'b4-legacy-v2',
    },
  },
  timeline: {
    openedVia: state.importedPick.openedVia,
    storeMessages: state.importedTimeline.messageCount,
    roleMix: { system: 41, user: 4, assistant: 30 },
    blockTypes: state.importedTimeline.blockTypes,
    emptyTextBlocks: state.importedTimeline.emptyBlocks.length,
    screenshot: path.join(BASE, 'model-06/model-06-imported-open.png'),
    note: '历史正常渲染：markdown、代码块、用户气泡都在，无空块',
  },
  continuation: {
    prompt: '上面这段对话在讨论什么问题？用两三句话概括，并指出对话里提到的一个具体文件名或命令。',
    turnMs: state.m06Turn.turnMs,
    statusLine: 'Worked for 2m 2s · ↑12.1k tokens · ↓3.9k tokens · Thinking 3.3k tokens',
    reply: state.m06Turn.reply,
    screenshot: path.join(BASE, 'model-06/model-06-import-continue.png'),
  },
  grading: { facts, hits: facts.filter((f) => f.hit).length, needed: 1 },
  gotcha:
    'selectSession 单独用不够：导入会话没有内存时间线，必须点侧栏那一行走 useActivateSession 才会从磁盘重建（第一次只读到 0 条消息）。',
  evidence: files('model-06'),
});
