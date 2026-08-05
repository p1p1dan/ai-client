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

### 2. 三条能力缺失（与 ACP 无关，独立可排；归属可平移主线）

按性价比排序，依据见 [acp-decision](./topics/acp-decision.md) 末表：

1. **网络重试横幅** —— 最便宜。数据已在 `chatSessions.ts:85` 的 `retry`，只差 UI。
   用户能立刻感知「不是卡死了，在重试」。
2. **子 agent 实况** —— 三条里唯一有真正产品价值增量的。开 `forwardSubagentText`（`sdk.d.ts:1619`）
   + 协议加可选字段透传 `parent_tool_use_id` + UI 嵌套渲染。
   **真正的工作量只在「显示」**：Task 工具行下怎么挂子 agent 的文本/思考/工具、折叠还是展开。
   已有基础：`toolCard.ts` 已在渲染 Task 行。**三处不打包票见 topic**（未实测消息流 / 事件量 / 历史重放会塌）。
3. **stderr 进 UI** —— 诊断向，平时用不到，出事时省很多时间。

> 这三条严格说属主线能力缺口，因与本 plan 同源于 2026-08-04 那轮讨论故暂存此处；
> 若主线先收口，可整块平移进主线 roadmap，不需重新论证。

## Deferred

- **多 agent 协同工作** —— 用户 2026-08-04 明示「先放一放」。codeg 有此能力（`src-tauri/src/acp/delegation/`），
  作为远期参照保留，本阶段不评估。
- **第 3 个及以后的 agent**（Gemini / Cursor / OpenCode / …）—— 它是否存在正是 ACP 判据本身
  （见 [open-questions #1](./open-questions.md)），不作为承诺。
- **扩 git 能力对齐 codeg** —— 用户表达了偏好但未指明具体点，且同轮裁定本阶段 git 维持最小集
  （见 [open-questions #4](./open-questions.md)）。
