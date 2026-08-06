# Roadmap — 多 Agent 接入

> 状态：**In Progress — S1 已收口，等排 S2**（2026-08-06 解冻当日跑完 S1）。
>
> ✅ **解冻裁定（用户 2026-08-06）**：原话「multi-agent 支线解冻 开干」。
> 2026-08-05 的「后置」裁定（原话「先做 B，优先把现有 Claude 客户端任务大致完成后，再考虑 codex 支线」）
> 挂的条件已满足——主线开发线五任务 T-32 / T-16 / T-33 / T-35 / T-34 于 2026-08-06 第十二轮点验全部转 Done。
> **S1 spike 自即日进入执行。**

## Done

- **2026-08-06 S1 — ACP + Codex 可行性 spike ✅ 收口**（解冻当日跑完）——四路并发探针实测，
  产出 [S1 spike 报告](../../../plans/2026-08-06-s1-acp-codex-spike-report.md)（474 行，含编排者逐条回验记录）。
  **出口达成：[open-q #1](./open-questions.md) 关闭 → 裁定「不接 ACP，直连 `codex app-server`」。**
  三条支撑：① 用户答复不加第 3 个 agent → ACP 价值不成立；② 实测**直连反而更便宜**
  （直连 540–740 行 / 2.5–5.0 人日 vs ACP 670–1090 行 / 3.0–7.0 人日），复核条款未触发；
  ③ **推翻了 #1 的隐含前提**——`codex app-server` 的命令审批与补丁审批**已在真实回合捕获原始报文**，
  「直连不可行时 ACP 是唯一退路」不成立，ACP 的保险价值归零。
  头号实证：**ACP 只是把直连的 payload 原样塞进 `_meta.codex` 再转发一次**（两路并列逐字段比对坐实），
  并在此过程丢掉 `applyNetworkPolicyAmendment` / `granular` / `approvalsReviewer`；
  代价还有 **362M node_modules（341M 是与 PATH 同版 codex 0.145.0 的纯副本）+ 3 级进程链**。
  「接 ACP 就不用写解析器」被 codeg 实证证伪：它接了 ACP 仍用 **508 行** `emit_conversation_update` 装 13 个分支。
  **同轮校正 [reuse-boundary](./topics/reuse-boundary.md) 六行初判表**（3 行确认 / 2 行校正 / 1 行部分推翻 / 1 行未覆盖），
  另补两行新层。落码 `bc531c7`：`src/agent-host/spikes/s1-{acp-codex,codex-direct,target-contract}-probe.ts`（三门：lint ✅ / typecheck ✅ /
  test 3 例既有失败，已 `git stash -u` 退干净 HEAD 复验为**既有非本轮引入**）。
  **未闭合：open-q #2**（真实提问报文两条路都没诱发出来，9 个真实回合零命中）。
- **2026-08-04 ACP 路线调研**（会话 `a5273935-…`，2026-08-05 补落库）——产出三篇 topic：
  [acp-decision](./topics/acp-decision.md)（判断依据 + Claude 线不走 ACP 的证据链）·
  [reuse-boundary](./topics/reuse-boundary.md)（问答卡上层 agent 无关、仅 `questionBridge.ts` 303 行 Claude 专属）·
  [codeg-reference](./topics/codeg-reference.md)（参照事实 + 适配器版本 pin）。
  **无代码改动**。当轮一处错判（自建统一伴生进程）当场收回，一处口径纠正（子 agent 文本是收不到而非混入）已记入 topic。

## In Progress

（空 —— S1 已收口，S2 待用户排期）

## Next

### 1. S2 — 直连 Codex 接入设计（待用户排期）

裁定既定，下一件事是**设计**而非继续 spike。四项，前两项可并行：

| # | 事项 | 出口 | 说明 |
|---|---|---|---|
| a | **补 U1：真实提问报文** | 结 [#2](./open-questions.md) | 唯一出口；估 4–8 回合，「诱发实验」额度损耗率实测 50–75%。**不阻塞 b/c/d** |
| b | **会话 ↔ agent 绑定口径** | 结 [#3](./open-questions.md) | 落点已测准 4 处；硬约束：`session-index.json` 裸数组无迁移 → **「undefined 视作 claude」必须读侧显式实现** |
| c | **权限投影口径** | 结 [#5](./open-questions.md) 权限半 | Codex 4 维正交 → 我方 `permissionMode`；协议惯例支持只加可选字段不升版 |
| d | **历史跨 agent 的最小可接受降级** | —— | 全表**最大共同空洞**（三机制，见 reuse-boundary 末行）；两条路都没跑过 resume（U2）。短期大概率结论是「Codex 会话不支持 resume 历史」，但要**显式降级不是崩** |

**红线提醒**：b 要动 `stores/chatSessions.ts`（红线 store，走加法纪律），动工前回主线核对三处接缝。

### 2. ~~S1~~ —— **2026-08-06 已 Done**（见 Done 段）

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
