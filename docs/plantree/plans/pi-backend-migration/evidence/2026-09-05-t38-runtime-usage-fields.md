# Evidence — T38 runtime 补字段 + U06-b Run 面板占用

> 2026-09-05。范围：Pi 计划 [T38](../roadmap.md)（a/b/c 三条）与 UI 计划 U06-b（Run 面板占用 donut + usage 行、
> Composer 底栏占用 chip）。两者同批落地，因为 T38 的三个生产者各自只有一个消费者，
> 分两次落会留下「有字段没人读」的中间态。
>
> **不触及**：packaging、permission、session 文件所有权语义；T37 发版门禁未重开。

## 一、开工前取证改变了 T38 的形状

计划原文（[D03 决定二](../../pix-ui-alignment/decisions/003-sidebar-density-and-runtime-field-ownership.md)、
[evidence-q04](../../pix-ui-alignment/topics/evidence-q04-runtime-fields.md)）假设占用百分比要
**渲染层自己算**：拿 usage 的 token 数除以目录里的 `contextWindow`。

读 SDK 后这条不成立，而且有更好的答案：

| 事实 | 位置 | 影响 |
|---|---|---|
| `AgentSession.getContextUsage()` 直接返回 `{ tokens, contextWindow, percent }` | `pi-coding-agent/dist/core/agent-session.d.ts:646`，实现 `agent-session.js:2700` | 占用**不需要渲染层计算**；worker 直接报 |
| 它按「最近一次 compaction 之后有没有 assistant usage」判定，没有就返回 `tokens: null` | `agent-session.js:2712-2732` | `null` 是**真答案**（压缩后、下次回复前确实不知道），不是缺数据 |
| `turn_end` 事件带 `message: AgentMessage`，usage 挂在上面 | `pi-agent-core/dist/types.d.ts:383` | 生产者挂 `turn_end`，与 pi-app 同一处 |
| `tool_execution_update` 带 `partialResult` | `pi-agent-core/dist/types.d.ts:402-406` | T38-c 有真实数据源 |

**因此偏离计划两处，都写进代码注释**：

1. **占用由 worker 报，不由渲染层算**。渲染层若自己除，会把「配置的模型」的窗口套到
   「实际回答的模型」的 token 数上——这两者本仓允许不一致（`RunSurfaceView` 的 `Model (actual)` /
   `Model (configured)` 两个标签就是为这件事存在的）。
2. **`agent_end` 不做第二个生产者**（计划原文写的是 `turn_end` / `agent_end`）。`agent_end` 带的是整份
   message 列表，其中最后一条 assistant 正是上一个 `turn_end` 已经报过的那条；两处都发会把每个 run
   的最后一回合算两遍。pi-app 也只用 `turn_end`。有测试守着（见下）。

## 二、T38-b 的取证结论：链路只断在一处

`contextWindow` 在 managed 配置里**一路都在**（`configValidation.ts:93` 校验并保留），
只在 `piModelOption`（`shared/piModelConfig.ts`）构造 `AgentModelOption` 时被丢掉。
本地 `models.json` 那条路径则是 `readLocalModelOptions` 从来没读过这个字段。两处都补了。

补的时候加了范围判断：`0`、负数、非数字一律**不带出去**，因为它只会作为分母使用，
一个 0 会让每个消费者都得自己防除零。测试逐条覆盖（未声明 / `0` / `'128k'` 三种写法）。

## 三、落地形态

### T38-a — `usage.updated` 生产者

- 新增 `src/shared/piUsage.ts`：`buildPiUsagePayload`（worker 侧写）/ `readPiUsagePayload`（渲染层读）。
  **一份 key 定义、一份测试**。理由写在文件头：这个事件的 `payload` 是 `Record<string, unknown>`，
  类型对 key 一无所知，两端各手写一遍就是本仓已经踩过的漂移（渲染层至今还在折 Claude 时代的
  `interim` / `turn_output_tokens_display`，pi 从不发）。
- `piWorkerSession.ts` 新增 `turn_end` 分支：取 `message.usage` + `getContextUsage()`，发一条
  `usage.updated`。`getContextUsage` 包了 try/catch——它在事件回调里伸进 SDK，抛了只该让这一回合
  少一个占用数字，旁边的 token 总数照发。
- **一回合一条**，不累加。pi 的 usage 是「这一回合的账」，带工具的 run 会结算好几回合；
  求和会打印出一个没人收过的费。UI 上标成「上一回合」。

### T38-b — `contextWindow` 出目录

`AgentModelOption.contextWindow?: number` → `piModelOption` 带出 → `readLocalModelOptions` 读入。

### T38-c — `tool.updated` 状态行

`ToolUpdatedEvent.payload.status?: string`。取 `partialResult` 的**最后一条非空行**，clamp 120 字符。

两处与 pi-app 不同，都有理由：
- pi-app 取整段文本再截断，进度型工具会永远显示开场横幅；取最后一行才是「现在在干什么」。
- 结构化但没有文本的 `partialResult`（如 `{ details: {...} }`）返回 `null`，**不 JSON.stringify**。
  序列化对象不是进度报告。`readToolOutput`（正文用）仍照旧序列化，两者刻意分开。

### U06-b — 消费端

| 面 | 落点 | 无数据时 |
|---|---|---|
| Run 面板占用环 | `RunSurfaceView` 的 `OccupancyRing` + used/free/window 图例 | 整块不渲染 |
| Run 面板 usage 行 | 输入/输出/缓存读写/费用，全部标「上一回合」 | 整块不渲染 |
| Run 面板窗口行 | 只有窗口没有占用时的纯事实行（用 T38-b 的目录值） | 不渲染 |
| Composer 底栏 chip | `ComposerUsageChip`，只显示 `68%`，tooltip 给绝对值 | 返回 `null`，槽位塌陷 |
| 活动工具状态行 | 工具名下方第二行 | 只显示工具名 |

**环形图只有 used/free 两段，没有按角色分色**（pi-app 有）。pi-app 的角色份额是字符数除以 4 估出来的；
照抄会把「实测总量」和「估算切分」放进同一个环，读者无从分辨哪一半是真的。按角色的视图留在
Context 页原有的构成图里，那张图的单位是**字符**，标注明确。同理，Context 页的构成图**没有**改成
按 token 算分母——已把那里原本写的「T38 落地后本图获得真实分母」注释改成这条决定的说明。

## 四、门禁

```
pnpm typecheck                 pass
pnpm typecheck:agent-host      pass
npx biome check <21 changed>   pass（本批文件；仓库既有 legacy HTML error 与本批无关）
npx vitest run                 274 files / 4210 tests pass
```

对比基线：本批开工前同一条命令为 274 files / 4192 tests。新增 18 条断言分布：
`piUsage` 10、`piWorkerSession` 5（T38-a/c）、`PiModelConfigService` 1（T38-b）、
`runPanelModel` +7 / `contextSurfaceModel` +11（U06-b，含替换掉的旧断言）。

## 五、被改写的既有断言（三条，都必须改）

1. `runPanelModel.test.ts` 的 `exposes no usage/context-occupancy fields at all until T38 lands` —
   这条断言的**前提**（T38 未落）刚刚失效。改写成同一条验收的新形态：
   「runtime 没说话之前，`occupancy` / `contextWindowOnly` / `usage` 三者都是 `null`」。
   U06-a 的「不放空壳」规则一字未改，改的只是「什么时候有数据」。
2. `deriveRunTools` 的两条全等断言 — 返回结构多了 `activeToolStatus`，补字段。

## 六、一次真实的守卫判红

`ComposerUsageChip` 第一版从 `components/workspace-shell/surfaces/runPanelModel` 导入占用推导，
被 `composerTargetGuards.test.ts` 的「`components/chat` 不得 import `components/workspace-shell`」判红。

**修法不是加豁免，是搬家**：把 `deriveContextOccupancy` 挪到 `shared/piUsage.ts`，与 payload 定义同处。
这也是更对的位置——底栏 chip 和 Run 面板必须给出**同一个百分比**，一份推导才保证它们不会打架。

## 七、已知欠项（不在本批修）

1. **重开会话在首次回复前没有占用环**。pi 在 `turn_end` 才报，重开一个旧会话要等它下次回答才有分母。
   目前退化为「只显示上下文窗口」那一行（走 T38-b 的目录值）。
   若要即时显示，得在 `bootstrap()` 里补发一条 context-only 的 `usage.updated`——那是**新的事件时序**
   （bootstrap 期间当前一条事件都不发，Main 侧没有测过），本批不做。
2. ~~**`turnTokensDisplay` 是死路**~~ — **已关闭**（同日，用户拍板整条删除）。
   取证补充：pi 的 11 种事件里只有 `turn_end` / `agent_end` 带 usage，流式的 `message_update`
   没有 token 字段，所以「实时」在 pi 后端下**没有数据源**，不是「生产者还没接」。
   删除范围与保留项见
   [D11](../../pix-ui-alignment/decisions/011-retire-the-live-output-token-counter.md) 与
   [D11 evidence](../../pix-ui-alignment/evidence/2026-09-05-retire-live-token-counter.md)。
3. **GUI 点验**：与 UI 计划累计的那一次一起做（用户拍板）。本批全部改动只有单测证据，
   没有真实窗口截图。
