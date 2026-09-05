# Evidence — 下线实时 `↓` 输出 token 计数器（D11）

> 2026-09-05。范围：删除 D33 遗留的实时输出 token 估算链路。
> 决定与理由见 [D11](../decisions/011-retire-the-live-output-token-counter.md)。
>
> **不触及**：settled usage（Run 面板 usage 行）、上下文占用（占用环与底栏 chip）、
> `↑ NNN chars` 提示计数、任何 worker / Main 侧代码。本次改动**全部在渲染层**。

## 一、取证：pi 没有回合中的 usage

| 事实 | 位置 |
|---|---|
| `AgentEvent` 共 11 种，带 usage 的只有 `turn_end`（`message: AgentMessage`）与 `agent_end`（`messages: AgentMessage[]`） | `@earendil-works/pi-agent-core/dist/types.d.ts:375-411` |
| 流式事件 `message_update` 只带 `message` + `assistantMessageEvent`，无 token 字段 | 同上 `:390` |
| pi-app 同样只在 `turn_end` 取 usage（`piUsageTotals(msg?.usage)`） | `pi-app/src/worker/worker-session-events.ts:160-166` |

结论：这不是「生产者还没接」，是 pi 后端下**没有可测量的实时输出 token**。
唯一凑法是字符数除以 4，与 U06-a/U06-b 的红线冲突。

## 二、删掉的东西（渲染层，8 个文件）

| 文件 | 删了什么 |
|---|---|
| `contextSurfaceModel.ts` | `SessionRuntimeFacts.turnTokensDisplay` 字段、`foldInterimTokensDisplay`、`clearTurnTokensDisplay`，以及 `usage.updated` / `session.status` / `message.completed` 三处的链式调用 |
| `MessageTimeline.tsx` | zustand 选择器、`isLastTurn` 门控的 prop、`ChatTurnProps` 字段、解构与转发，连带 `useSessionRuntimeFactsStore` 导入（已无其它用途） |
| `turnStatus.ts` | `TurnStatusInput.outputTokensDisplay`、streaming 分支的 `tokenSuffix`、`formatTokenCount` 的导入与再导出 |
| `attachments.ts` | `composerSendingLine` 的 `outputTokensDisplay` 参数与 `replyCount` 片段 |
| `countFormat.ts` | `formatTokenCount`（已无消费者）与共享的 `formatCount` helper（`formatCharCount` 内联同一逻辑） |
| 三份测试 | `contextSurfaceModel.test.ts` 的 D33 describe（10 条）、`turnStatus.test.ts` 的 5 条、`attachments.test.ts` 的 `↓` 断言 |

## 三、没删的三处，各有理由

1. **`readPiUsagePayload` 的 `interim === true` 拒绝分支**。上一批的 evidence 把它描述成
   「防止两个 reducer 抢事件」，那只是它当时最显眼的作用。它真正守的规则是
   **估算不得被记成账单**，与计数器存废无关，所以留下，测试也留下。
   （功能上它已被下面两行 `input`/`output` 数值校验覆盖，属显式冗余，非必要冗余。）
2. **`messageMetadata.ts` 的同名守卫**。那个 registry 的合并是累加式的
   （`{ ...existing.usage, ...payload }`），一旦被污染没有任何后续事件会清掉，
   而它没有渲染点能让人看见污染。注释里对 `turnTokensDisplay` 的指路已改写。
3. **`↑ NNN chars`**。渲染层自己从持有的文本数出来的精确值，不是估算——
   这也是它一直带单位词、而 `↓` 一直不带的原因。

## 四、改写而非删除的两条断言

| 原断言 | 现在 |
|---|---|
| `contextSurfaceModel.test.ts`：「忽略 interim tick，它写的是另一个字段」 | 「**整条丢弃** interim tick——估算不是账单」，并断言返回引用不变、不建 session 条目 |
| `messageTimelineWiring.test.ts`：D33 的三条接线检查 | 拆成两条：① `✽` 字形只在 `.tsx` 层加（原样保留）；② **反向守卫**：源码中不得出现 `turnTokensDisplay` / `outputTokensDisplay`，防止有人拿估算把计数器接回来 |

D33 describe 里那条「无关事件必须返回同一引用」的纪律守卫没有随块删掉，
改用 `session.stderr` 建初态后重跑，保留在新的 `unhandled events` describe 里。

## 五、门禁

```
pnpm typecheck                 pass
pnpm typecheck:agent-host      pass
npx biome check <10 changed>   pass
npx vitest run                 274 files / 4194 tests pass
git diff --check               clean
```

对比基线：本批开工前 274 files / **4210** tests。净 −16 = 删 20 条（D33 相关）、加 4 条
（反向守卫 2、interim 丢弃改写 1、unhandled-events 纪律 1）。

## 六、界面上的实际变化

- 回合进行中的状态行：`✽ 19m 55s · ↓ 38.5k` → `✽ 19m 55s`。
  **但这不是可见的退化**——`↓` 部分在 pi 后端下从 T35 起就没显示过。
- 等待中的 composer 行：`Thinking… · ↑ 428 chars · 12s`（`↑` 不受影响）。
- 每回合 token 与费用仍在 Run 面板 usage 行；上下文占用仍在占用环与底栏 chip。

## 七、欠项

**GUI 点验**：并入 UI 计划累计的那一次。本批只有单测证据。
点验时值得确认的是**不该出现的东西**：跑一个长回合，状态行只有 `✽` 加计时，没有第二个数字。
