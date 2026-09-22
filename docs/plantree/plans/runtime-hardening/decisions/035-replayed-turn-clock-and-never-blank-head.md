# 决策 035：历史回合也有钟，折叠头永不空行

日期：2026-09-22 · 拍板人：用户 · 状态：已落地 · 任务：待排（本决策为落地依据）

## 问题

[决策 034](034-zcode-aligned-process-rows.md) 当日落地后，用户实机反馈：

> 上一轮提交修改的是不是有点问题，这个没实现，现在折叠头和尾栏都没了

「这个」指 034 的 D2——折叠头改报时长。**两件事同时发生，而且是同一个根因。**

## 根因

034 D2 让折叠头**只**说回合的钟，并删掉了原先无条件存在的「已处理 N 个步骤」。钟来自 `deriveTurnWorkZone`，它在「没测到时长」时返回 `null`，于是：

- 折叠头 `line === null` → **只剩一个 chevron，整行没有文字**；
- 尾栏 `{workZone && …}` → **整行不渲染**。

什么时候没测到时长：`MessageMetadata` 是 `useMessageMetadata` 里的**内存侧注册表**，由实时 RuntimeEvent 喂、不落盘、随挂载而生。它只装**这一次挂载亲眼看着跑完**的回合。重启应用、切走再切回、resume——历史回合**全部**无钟。所以用户看到的几乎全是空折叠头，也从来没机会看见 034 D2 做的那个头。

⚠️ **全量测试是绿的。** 这一元素的断言全在 `messageTimelineWiring.test.ts`，是**源码形状扫描**——代码形状对，屏幕是空的，两者同时成立。这条记在案上：形状扫描不能替代渲染断言。

## 决定

### D1 · 历史条目的时间戳接进回合钟

`session.history` 的每条消息本来就带 `timestamp`，但 `mapHistoryMessageToChatMessage` 把它丢了。现在透传到 `ChatMessage.timestamp`（可选字段追加，与 `attachments` 同一纪律；Pi 没能定日期的条目**不带这个 key**，不是 `0`）。

回合钟三处取值各自兜底：

| | 实时 | 回放兜底 |
|---|---|---|
| 起点 | user 消息的 `message.started` / 发送快照 / pending watch | **user 行的 `timestamp`**（第 4 顺位，最后） |
| 终点 | body 各消息的 `completedAt` | body 各行的 `timestamp`，**只当 `completedAt`** |
| 完成时刻 | 末条 assistant 的 `completedAt` | 末条 assistant 的 `timestamp` |

⚠️ **回放的 stamp 只能当 `completedAt`，不能当 `startedAt`。** Pi 是**写入条目时**打时间戳，assistant 行上那是完成时刻、没有配对的开始。若把它当 `startedAt`，`earliestTurnStartMs` 会拿首条 assistant 的**完成**当回合起点，一个 6 分钟的回合会报成几秒。

⚠️ **回放的钟比实时的粗，不可混为一谈**：它量的是「提问→回复」的墙上时间，不是 assistant 消息自己的跨度。思考时长历史里没有，按 A07 `:2399` 省略而非补零。

### D2 · 闩锁管的是「数字」，不是「分区」

034 D2 用 `zone={zoneClaimed ? null : workZone}` 实现「一个回合只有一个头拿到钟」。**这就是空行的另一半**：拿不到钟的头连 zone 都没有，也就没有任何可说的话。

改成两个 prop：`zone`（永远给）+ `clock`（只有第一个折叠的组为 true）。

- **每个头都知道回合处于什么状态**，这是它永远有的事实；
- **只有一个头知道状态有多少秒**。

T107「两个头印同一个时长」的红线原样保住，代价那一行消失了。

### D3 · 无钟时报状态词，不报名词，也不回退到步数

用户问：「不应该是显示 运行中/已运行 么？」——**对的，头应该报状态**。落地取的是既有词族的**光杆形式**：`Working`「工作中」（早就有）+ 新增 `Worked`「已工作」。

不用「运行中/已运行」，两条理由：

1. `Running`「运行中」是**会话状态**的 key，与 Run 面板、左栏共用（`runPanelModel.ts`、`LeftNav.tsx`）。借用它就是 034 D4 明令警惕的 T101 形状——一个 key 两个界面。
2. 「已运行」是 034 D4 当天刚从 `Ran` 换掉的旧工具动词（现为「终端」）。在头上重新启用这四个字，读起来像一条工具行。

带数字时是「已工作 6 分 41 秒」，不带数字时是「已工作」——**同一个动词**，头不会中途换词表。

### D4 · 「没有可说的」由各自的读者判断，不再由一个 `null` 代表

`deriveTurnWorkZone` 不再返回 `null`；「没测到」变成 zone 内部的 `worked: null`。两个读者各自决定沉默：

- 折叠头：印光杆状态词；
- 尾栏：**三个数字全为 null 时**才不渲染（否则会剩一个孤零零的「✻」）。

A07 `:2399` 一寸没动——没有任何地方捏造 `0`。变的是「未测量」现在**可以被表示**，而不是靠删掉整行来暗示。

## 回归资产

新增 `src/renderer/components/chat/__tests__/historyTurnClock.test.ts`，**读 DOM 而非扫源码**：

- `[HIST-CLOCK-1]` 回放回合的头印「已工作 6 分 41 秒」，尾栏印「完成于 … · 2 次调用」；
- `[HEAD-BLANK-1]` 任何折叠头都不是空行，**哪怕一个时间戳都没有**。

配套改写：`[WZ-4]`（不再断言 `null` 返回）、`[WG-WIRE-1b]`（第 4 顺位 + body 兜底）、`[WG-WIRE-5]`（完成时刻兜底）、`[WG-WIRE-7]`（闩锁改 `clock`，并断言 zone 永不被扣留）；store 侧加「时间戳透传」「未定日期不带 key」两例。

## 顺手修掉的 034 遗留

`tokenValues.test.ts` 的 `--tool-arg` 比例锁还停在 85%，而 034 已改成 62%——上一轮漏改，本轮补上。

## 未修（不在本次范围）

`i18nCoverage.test.ts` 报 `ProviderSetupDialog.tsx` 缺 6 个词条（Image / Input / Output limit / Per-model metadata / Reasoning / Text）。与本决策无关，早于 034 就已存在，留给设置面板那条线。
