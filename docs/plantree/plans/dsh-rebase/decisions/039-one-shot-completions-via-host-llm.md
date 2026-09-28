# 决策 039：P1-15 一次性补全经宿主的 LLM 服务直调

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-5 方案 §5 D7](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、[分片 04](../topics/p1-5-models-and-credentials/04-one-shot-completions.md)。

## 规则

1. bridge 新增 `DshUtilityRuntime`，用 `ctx.llm.stream` 实现现有的 `utility.*` RPC（提交信息、分支名、代码评审）：不开会话、没有工具、不落盘；`inject` 加 `llm`。
2. Main 的 `PiUtilityService` 只换 transport，改走宿主通道，不再下发 `modelCatalog`。容量、超时、取消、登出失效的语义都不变。
3. git diff 仍由 Main 取，与今天一样，所以对加密机的影响不变。

## 取舍

- 只有一条模型路径，不新增协议，P1-12 能把原生 runtime 删干净。
- 备选：宿主开临时会话（重）；Main 直接调网关（多一套协议实现和凭据路径）；保留一个极小的补全载体（P1-12 删不干净）。
- 代价：补全也依赖宿主（冷启动约 0.8 s，常驻约 180 MB），共享宿主崩溃时补全一起失败。
