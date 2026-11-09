# 决策 212：子代理在对话里只占一行，和其他步骤对齐

日期：2026-11-09（北京时间）。

**状态**：方向由用户 2026-11-09 的要求定下（第 1 节），写法照 Claude Code 终端版的代码（第 2 节）。第 4 节标「自主」的各条待用户审批。

**代码**：main `7b74dac6`，和[决策 211](211-turn-live-status-once.md) 同一个提交；2026-11-09 推送，进 v1.2.3（没出测试包）。

**修订关系**：

- [决策 208](208-chat-transcript-styles.md)「子代理、审查结果、待办这类特殊行照旧画」：子代理不再是特殊行，在主对话区画成一行步骤。审查结论、待办清单照旧。
- dsh-rebase P1-7b 的委派泳道（委派行下面列出子代理的每一步）：主对话区不再展开。子代理对话窗、旁问这些用经典样式的地方照旧。

## 1 现象

用户 2026-11-09 附了一张截图（终端式），原话：「还有页面里这个子代理，怎么还显示图标，然后点击后展开一大堆。这个需要优化，看看 claude 怎么做的。右侧已经有子代理侧栏了，对话中是不是显示一行就可以了，然后风格跟其他行对齐？」

截图里，`∴ Thought for 14s` 之后是一个 `Agent Explore Map calib/sim/UI code` 的块：

- 下面是十几行带图标的 `Bash …`、`Read …`，块内可以滚动，旁边还有「转到后台」；
- 块下面又有一行 `● Map calib/sim/UI code… (2 分 3 秒 · esc 中断)`，说的还是这个子代理。

右侧会话栏的「子代理」卡片里，已经有这个子代理的名字、类型、当前在做什么、用时，以及「查看对话」。

## 2 查证

Claude Code 2.1.273 拆包（`F:\projects\tmp\claude-cli-research\extracted\readable`，子代理核对）：

- **标题行**：和其他工具一样，在跑时圆点闪烁。工具名是子代理的类型，general-purpose 写作 `Agent`，没有类型也写 `Agent`（`Lrn`）；括号里是任务说明。
  - 例：`⏺ Explore(Map calib code)`、`⏺ Agent(Find auth handlers)`。
- **运行中**（`n1e`）：
  - 还没调工具：`⎿ Initializing…`；
  - 否则列出最近 3 次工具调用，写成 `Read(src/x.ts)` 这样的步骤，不带圆点；更早的写 `… +5 tool uses (ctrl+o to expand)`；
  - 行上没有自己的用时，底部动画行照常在跑。
- **结束**（`vsr`）：整列收成一行 `⎿ Done (12 tool uses · 45.2k tokens · 1m 3s)`，下面一行 `(ctrl+o to expand)`。按 ctrl+o 才在主对话里展开它的提示词、每一步和回答。
- **转后台的**：只有一行 `⎿ Backgrounded agent (↓ to manage · ctrl+o to expand)`，到底部任务列表里管理；结束时再追加一行 `⏺ Agent "…" finished · 1m 3s`。
- **同一条消息里并行的几个**：合成一棵树，`Running 3 Explore agents…`，每个子代理两行。

桌面版的参考（open-claude-ui）没有讲对话里的子代理怎么画，只有协作看板。我们右侧的「子代理」卡片就是照着它的 `CoworkAgentCanvas` 成员行做的（决策 207 §8 第 3 条）。

## 3 改法

### 3.1 终端式

一个子代理是一步，样子和别的步骤一样：

```
● Explore(Map calib/sim/UI code)
  ⎿ Read(package.json) · 12 tool uses
```

- 标题行：类型作工具名（general-purpose 写 `Agent`），括号里是任务说明；没有图标。
- `⎿` 只有一行：
  - 还没调工具：`Initializing…`；
  - 运行中：它正在调的那一步，后面写一共调了几次；
  - 等你批准它的某一步：「等你确认：Bash」；
  - 结束：`Done (12 tool uses · 45.2k tokens · 1m 3s)`；
  - 失败：返回内容的第一行，红色；
  - 被停：`Interrupted`。
- 转后台的：标题行尾写「· 后台运行中」，`⎿` 写它当前那一步。
- 点这一行，打开子代理自己的对话，和右边「子代理」卡片的「查看对话」是同一个窗口。引擎还没给出子代理的编号之前，这一行不能点。
- 子代理在前台占着回合时，照[决策 211](211-turn-live-status-once.md) 挂上回合状态：`✻ Explore(Map calib/sim/UI code) (2m 3s · esc 中断)`。底下不会再有一行重复说它。

### 3.2 桌面式

一行，样子同段落之间的折叠行：

- 结束后：名字、任务说明（浅灰）、`Done (…)`，行尾 `›`。点它打开子代理的对话。
- 占着回合时：行首转动图标，名字和说明带流光，行尾是回合计时（决策 211）。

## 4 自主决定（待审批）

1. 运行中只写一行：当前那一步，加上一共几次。终端版列最近 3 步再加 `… +N tool uses`，用户要求只占一行。
2. 点击打开子代理的对话窗。终端版用 ctrl+o 在主对话里展开；我们右侧已经有子代理卡片和对话窗，不在主对话里展开。
3. 用词照终端版的英文：`Initializing…`、`Done (…)`、`Interrupted`。等批准沿用已有的中文「等你确认：…」。
4. 名字规则照终端版：general-purpose 写 `Agent`。DSH 的 `subagent`、`subagent_fork` 在没有类型时也写 `Agent`。
5. 同一条消息里并行的几个子代理，不像终端版那样合成一棵树，各占一行。
6. token 数照终端版写成 `45.2k`，保留一位小数；右侧卡片仍写 `45k`。
7. 转后台的子代理：终端版写 `Backgrounded agent (↓ to manage)`。我们在标题行尾写「· 后台运行中」，`⎿` 写它当前那一步；要管理就去右侧卡片。

## 5 实现

- `delegationLine.ts`（新）：纯函数，输入这次调用的行和子代理的运行记录（lane），输出名字、说明、`⎿` 那一行、子代理编号，以及它是否在后台。名字规则在 `delegationName`，token 写法在 `compactTokens`。
- `ToolRows.tsx`：
  - `TerminalDelegationRow`、`DesktopDelegationRow` 是新的一行画法。
  - 对话窗按需加载（`React.lazy`）：它自己要用本文件的 `ToolGroup`，直接引用会形成循环。
  - 经典样式下的 `SubagentActivity` 泳道没动。
- `turnLiveStatus.tsx`：特殊行里，只有子代理可以挂回合状态（`carriesNoStatus`）。

## 6 测试与开发版实测

测试：

- `delegationLine.test.ts`（新，11 条）：名字规则、`Initializing…`、运行中、等批准、`Done (…)`、什么都没量到、失败、被停、转后台、token 写法。
- `delegationRowMount.test.ts`（新，6 条）：
  - 终端式只有一块，没有图标，也没有子代理自己的步骤；
  - 结束后能点开，引擎没给编号时不能点；
  - 占着回合时挂状态；
  - 桌面式一行，以及占着回合时的样子。
- 对话目录全部测试、根 `pnpm typecheck`、biome 通过。

## 7 开发版实测（2026-11-09）

用 `gui-probe.mjs` 起开发版，模型走本地假网关（Agent SDK 引擎），终端式。发一条 `CC-RUN`，让主对话派出一个 general-purpose 子代理。子代理的提示本身又是一段 `CC-RUN`，依次跑 `sleep 6 && ls`、`Read(package.json)`、`sleep 5 && echo ok`。

嵌套的那段要把连字符写成 JSON 转义，即 `CC\u002dRUN`。否则假网关把父消息里最后一个 `CC-RUN`，也就是嵌在提示里的那段，当成父消息的脚本，结果是 0 次调用。

结果：

- 这个引擎把子代理放到后台跑，主回合先结束了。运行中，对话里只有一行：
  - `● Agent(Map calib/sim/UI code) · 后台运行中`；
  - 下一行 `⎿ Bash(List the workspace)`。

  右侧「子代理」卡片同时显示「1 运行中 · general-purpose · 终端 List the workspace · 0:11」。
- 子代理结束后，这一行收成 `⎿ Done (3 tool uses · 5.2k tokens · 23s)`，没有图标，也没有展开的步骤。
- 点这一行，打开「Map calib/sim/UI code · 子代理对话」，里面是它的提示、三步和各自的输出、最后的回复。
- 前台子代理挂回合状态那种情况，这次的引擎走不到（它总是放到后台），由 `delegationRowMount.test.ts` 覆盖。
