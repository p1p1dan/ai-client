# 决策 039：主会话移除 64 轮工具调用上限

> **状态：规则 1 已被[决策 040](040-main-session-turn-ceiling-with-wrap-up.md)替代**（2026-09-23）：主会话恢复 500 轮上限，触顶改为收尾后暂停。规则 2–5 仍有效。

日期：2026-09-23。来源：用户报告长任务频繁触发「tool loop exceeded 64 assistant turns」，拍板对齐 PI-Desktop。

## 背景

- `AgentLoopPlugin` 曾对多轮会话设 64 个 assistant turn 的硬上限（P1-1 验收标准），触顶且末轮 stopReason 为 `toolUse` 时报 `turn_limit`。
- 取证（2026-09-23，本地源码）：pi 本体（pi-coding-agent 0.84.4 `dist/core/sdk.js`）构造 Agent 时**不传** `shouldStopAfterTurn`——交互会话无轮次上限；pi-agent-core 内核只提供该可选回调，不内置上限；PI-Desktop 主会话的 `shouldStopAfterTurn` 仅用于优雅停止（`packages/agent-runtime/src/runtime.ts:1469`），同样不设轮次上限，靠用户 Stop 与 300s 空闲 + 6h 时长看门狗兜底。
  - **更正（2026-09-23 复审）**：上一句的「看门狗兜底」不成立。300s 空闲 / 6h 时长看门狗只挂在 PI-Desktop 的**子代理**上，且已被其 D328 撤除（`subagent.ts` 的 `startWatchdogs()` 为空函数）；PI-Desktop 主会话没有任何上限或计时器。本仓同样没有会中止主会话回合的看门狗。详见决策 040。
- 即：64 上限是本仓自定标准，非 pi 移植语义。长任务（大重构、批量文件操作）被它误伤。

## 规则

1. 多轮会话（`singleTurn: false`）不再设轮次上限：`shouldStopAfterTurn` 不注册，模型跑到自然结束或用户/看门狗中止。
2. `singleTurn`（P0 无工具单轮探针）保留：答完一轮即停。
3. 子代理 `maxTurns` 机制不变（内置角色默认 60/50/40/80，`none`/`0`/未声明 = 无限轮；触顶报 `truncated`）——与 PI-Desktop 子代理「1–80，留空不限制」同型。
4. 不新增「单工具循环检测」：生态无先例（pi、PI-Desktop 均未做），参数微变可绕过、长任务中同工具合法连续调用会误报。
5. 渲染层 `sessionFailure.ts` 的 `turn_limit` 条目保留，供决策前的旧会话重放仍渲染原卡片，而非落到 unknown 兜底。

## 替代关系

- 替代 P1-1 验收标准中「启用 tools 时默认多轮，最多 64 个 assistant turn」的上限部分；P1-1 其余条款（无工具时单轮、plan 模式工具裁剪）不变。
- 顺手消除审计 [loop-model-13]（64 字面量两处重复、改一处即错配）：两处 64 已随本决策一并删除。

## 实现与验证入口

- `src/runtime/plugins/agent-loop/index.ts`：`shouldStopAfterTurn` 改为仅 singleTurn 注册；`turnCount` 与 `turn_limit` 报错分支删除。
- `src/renderer/components/chat/sessionFailure.ts`：`turn_limit` 条目标注 legacy。
- 验证：agent-loop 相关 Vitest 小批次 + `sessionFailure.test.ts`。
