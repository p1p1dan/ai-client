# 决策 095：失败后「继续」保留决策 028 的隐藏续跑提示（总原则下的例外）

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [决策 028](028-retry-via-hidden-continuation-prompt.md)（用户 2026-09-28 已批准）；
- runtime-hardening [决策 045](../../runtime-hardening/decisions/045-failure-card-continue-retries-last-turn.md)（T135）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-3；
- `dsh-llm-retry/README.md:12,50,58`；`dsh-agent-loop/lib/index.js:963-965`。

## 规则

1. 保留决策 028 的全部规则：
   - 只在会话空闲、最后一个 `turn/end` 是 `error`、`interrupted` 或 `aborted` 时受理，否则在发出任何事件之前抛 `WORKER_RETRY_UNAVAILABLE`；
   - 受理后 followup 一条 `source.kind: 'aiclient-retry'` 的续跑提示，模型看得到，用户看不到；
   - 不分叉，不回显。
   投影隐藏这条提示的规则已随 P1-4a 落地（`src/shared/dshHistory/projection.ts:469-472`）。
2. 这是总原则下的例外，理由写在这里：
   - DSH **没有**「失败后由用户手动重跑上一轮」的做法。`dsh-llm-retry` 只在同一回合内自动重跑临时错误：normal 模式对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 重试 5 次（`dsh-llm-retry/README.md:50`）。
   - 重试用尽，或者遇到鉴权、额度这类非临时错误，回合就以 `error` 结束，此后没有重跑的接口；开新回合至少要一条消息（`dsh-agent-loop/lib/index.js:963-965`）。
   - 去掉这一项，失败卡的「继续」只能退回 T135 之前「把原提示再发一遍」的做法。那样模型会收到两条相同的指令，确定性输出下会复现同一次失败（`src/renderer/components/chat/retryLastTurn.ts` 文件头）。
3. 自动重试的策略归 P1-5c（决策 040 第 3 条）；重试横幅由 P1-4d 映射 `llm/retry`（决策 099）。
4. P1-1 点验的 D5（「继续」之后的提示文案与真实原因不符）随之消失。

## 取舍

- **跟随 DSH 的两种写法都不比保留更省**：
  - 让失败卡的「继续」发一条可见的「继续」：模型看到的与本决策几乎一样（多一条很短的 user 消息），只是用户多看到一个气泡，渲染层还要改重试路径（不画乐观气泡、以 `running` 作接纳证据）。
  - 直接去掉按钮：回到 T135 的问题。
- **代价**：维持决策 028 对 045 字面的偏离，模型多看到一条隐藏提示。工作量约 1 人日，渲染层不改。
- 用户无感，所以不需拍板。但它是「为与 1.0.x 一致而保留的自研」，审批时请留意。

## 影响

- **测试**：`src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts` 的「refuses a retry instead of sending an empty message」改为受理规则用例：error、interrupted、aborted 受理；completed、blocked、max-tokens 拒绝，且不发事件。
- **金样本**：新增 `fail-retry` 场景（假网关先失败一次再成功）；`fail` 场景不变。
- 决策 081 第 3 条（防空转插件按 `aiclient-retry` 判断新纪元）照旧成立。
