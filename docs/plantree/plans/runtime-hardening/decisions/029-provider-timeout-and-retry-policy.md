# 决策 029：模型请求超时与重试策略——对齐 pi 官方 CLI 的超时、保留本仓的 3 次固定梯子

日期：2026-09-19 · 拍板人：用户（「就按你推荐的来」）· 状态：已决 · 任务：T093

## 问题

用户反馈（批次 I #5）：grok 渠道反复错误重试，一条消息七八分钟。只读调查（[Q030](../open-questions.md)）查明：本仓退避梯子跑满只有 43 秒（3 / 10 / 30 秒；限流另一份预算最多 86 秒），七八分钟花在「每次尝试本身」——主聊天链路不设自己的请求超时，落到 OpenAI / Anthropic 官方 SDK 默认的 600 秒墙钟；无首字节 / 空闲超时、无整条消息总时长上限；未知错误兜底可重试；父循环不接管流中断（只有子代理做）；横幅倒计时静态；无「立即放弃」。理论最坏一条消息 40 分钟且前几分钟无任何提示。

三方对照（`/home/ai/code/PI-Desktop`、本仓 `node_modules/@earendil-works/pi-coding-agent`、Anthropic SDK 与 Claude Code 文档）：PI-Desktop 在超时上与本仓一样空白；pi 官方 CLI 用 undici 全局 dispatcher 设 `headersTimeout`（首字节）与 `bodyTimeout`（流中空闲）默认 300 秒并把同一个数显式传给 SDK 的 `timeout`；Claude SDK 默认重试 2 次、超时 10 分钟，Claude Code 响应已开始后再断线不重试；PI-Desktop 流中断与请求阶段共用同一份预算；pi CLI 退避期间 Esc 可取消。

## 决定

按建议全部采纳：

1. **加首字节 + 流中空闲超时**：进程启动时装 undici 全局 dispatcher，`headersTimeout` 与 `bodyTimeout` 同一个值，**默认 120 秒**（pi 默认 300），做成设置项可调（30s / 1m / 2m / 5m / 关闭）。超时抛网络类错误，进现有 `NETWORK_ERROR` 重试预算。
2. **单次请求显式传 `timeoutMs`**，与上面同一个数、同一处配置。SDK 把 `0` 当「立即超时」，关闭要传超大值（pi 用 `2147483647`）。
3. **倒计时活起来 + 「立即放弃」**：`SessionRetryInfo` 带绝对时间戳 `retryAt`，横幅每秒重算、到点切「正在重试…」；横幅上加「立即放弃」走现有 abort（Stop 已能秒断退避）。
4. **父循环补流中断恢复**，与请求阶段共用同一份 3 次预算（PI-Desktop 做法）；子代理已有的恢复逻辑提成共用能力。**推翻**此前「父循环只接管流开始前的失败」的文档取舍（roadmap Deferred 表「父循环流中失败恢复」条目随之删除）。
5. **未知错误兜底收紧**：带 4xx 状态码但未分类的错误直接失败；没有状态码的（多半是网络）才重试。对齐 Claude SDK 与 pi CLI 的白名单思路。
6. **次数保持 3、梯子保持 3 / 10 / 30 秒**（用户 2026-09-11 裁定），不学 PI-Desktop 的 10 次。
7. **不加整条消息硬性总时长上限**（三方都没有，会误杀正常长回合）。
8. 不需拍板的三项一并落地：子代理重试可见（给 delegate 预算传 `onRetry` / `onRetrySettled`，带 delegationId）、每次尝试记一行日志（`attempt n started` / `failed after Xms`）、清掉审计遗留 loop-model-03 / -11。

改完后的最坏情况：网关每次都挂满 120 秒 → 约 8.7 分钟判死，但全程横幅可见、可随时放弃。

## 影响

- T093 可以开工；改动集中在 `src/runtime/plugins/agent-loop/providerRetry.ts`、`providerErrors.ts`、`agent-loop/index.ts`、`plugins/subagent/run.ts`、`events/projector.ts`、`src/shared/types/runtimeEvents.ts`、`src/renderer/components/chat/retryBanner.ts` 与 `MessageTimeline.tsx` 横幅处、设置页新增一项。
- T087（网关对 claude 模型 503 / 超时 142 秒零输出）同族，随 T093 一并复验。
- 本机没有用户那次 grok 事件的日志（当天只跑过 claude 会话），时间线还原仍需用户提供测试机 `logs/aiclient-2026-09-19.log` 中 `provider retry` / `turn failed` 行。
