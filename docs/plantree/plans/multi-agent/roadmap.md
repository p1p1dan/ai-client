# Roadmap — 多 Agent 接入

> 状态：**Planning · 暂缓**。本 plan 尚无代码落地，故无 `implementation-status.md`
> （plan-tree 规范：仅 In Progress 的 plan 需要该文件）。
>
> ⚠️ **排期裁定（用户 2026-08-05，同日修订前一裁定）**：原定「与主线并行、新线先做 ACP+Codex spike」
> **改为后置**——原话「先做 B，优先把现有 Claude 客户端任务大致完成后，再考虑 codex 支线」。
> 即：主线 [openchamber-chat-refactor](../openchamber-chat-refactor/README.md) 大致收口后本 plan 才启动，
> **S1 spike 不在当前排期内**。本 plan 的调研结论已全部落库，随时可接续，不会再丢。

## Done

- **2026-08-04 ACP 路线调研**（会话 `a5273935-…`，2026-08-05 补落库）——产出三篇 topic：
  [acp-decision](./topics/acp-decision.md)（判断依据 + Claude 线不走 ACP 的证据链）·
  [reuse-boundary](./topics/reuse-boundary.md)（问答卡上层 agent 无关、仅 `questionBridge.ts` 303 行 Claude 专属）·
  [codeg-reference](./topics/codeg-reference.md)（参照事实 + 适配器版本 pin）。
  **无代码改动**。当轮一处错判（自建统一伴生进程）当场收回，一处口径纠正（子 agent 文本是收不到而非混入）已记入 topic。

## In Progress

（空）

## Next

### 1. S1 — ACP + Codex 可行性 spike（用户 2026-08-05 指定的第一件事）

> 用户原话：「把 acp+codex 先做了，确定可行性后并入主线」。
> 目标是**用数据代替辩论**，不是做产品功能；spike 代码不进主线，落 `spikes/`（沿用 C-16 先例）。

必须产出的数据：

1. **通道可用性** —— `@agentclientprotocol/codex-acp@1.1.9` 能否在本机拉起并完成一个最小回合
   （注意它内嵌自己的 `@openai/codex`，不用 PATH 上的）。记录：装机体积、启动耗时、Node 版本要求。
2. **输出形状** —— ACP 侧事件流与我们 `RuntimeEvent` 协议的映射难度；
   对照面 = 自己直连 Codex CLI 解析的成本。**两条路都要估**，否则判据不成立。
3. **提问形状** —— Codex 侧提问有几种形态（codeg 为此写了 `classify_elicitation`），
   薄适配到底多薄 → 直接校正 [reuse-boundary](./topics/reuse-boundary.md) 的初判表。
4. **模型目录** —— Codex 模型列表怎么拿（codeg 走 `codex debug models --bundled` + 落盘缓存）。
5. **权限语义** —— Codex 的 sandbox / approval 与 Claude 的 `permissionMode` 如何统一表达。

出口：spike 报告 → 结 [open-questions #1](./open-questions.md) → 定「接 ACP / 直连」→ 才谈并入主线。

### 2. ~~三条能力缺失~~ —— **已于 2026-08-05 正式平移主线并分配任务节点**

不再挂在本 plan。三条各自成任务，定义与验收标准的权威在
[执行计划 §3](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md)：

| 任务 | 一行目标 | 估时 |
|---|---|---|
| **T-33** | 网络重试横幅——数据已在 `chatSessions.ts:85` 的 `retry`，只差 UI | 0.5d |
| **T-34** | 子 agent 实况——开 `forwardSubagentText` + 协议加可选字段 + **UI 嵌套渲染（真正的工作量）** | 1.5d |
| **T-35** | Host stderr 进 UI——`claudeRuntime.ts:677` 已有 `[cli-stderr]`，开事件 + 脱敏 | 0.5d |

**为什么归主线而不是本 plan**：三条都只用 Claude 直连链上已有的数据，与「接不接 ACP」这个
根问题（[#1](./open-questions.md)）**互不依赖**——把它们压在后置的本 plan 下会被一并冻住，
而它们本可以随时做。判断依据仍见 [acp-decision](./topics/acp-decision.md) 末表
（三条走 ACP 都只会更绕）。

**T-34 的已知限制**（与本 plan 相关，故在此留指针）：resume 重放的 `HistoryBlock` 无子 agent
归属概念，与 D20 问答卡是同一个协议缺口，根治须扩历史协议（C-17，后置）。

## Deferred

- **多 agent 协同工作** —— 用户 2026-08-04 明示「先放一放」。codeg 有此能力（`src-tauri/src/acp/delegation/`），
  作为远期参照保留，本阶段不评估。
- **第 3 个及以后的 agent**（Gemini / Cursor / OpenCode / …）—— 它是否存在正是 ACP 判据本身
  （见 [open-questions #1](./open-questions.md)），不作为承诺。
- **扩 git 能力对齐 codeg** —— 用户表达了偏好但未指明具体点，且同轮裁定本阶段 git 维持最小集
  （见 [open-questions #4](./open-questions.md)）。
