# D06 — 注册应答显式返回 `pi` 块，客户端保留 codex 推导作兼容

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：Claude 按常规判断执行并向用户明示，用户未反对
- **答复**：[Q02](../open-questions.md)

## 背景

onboard 的注册应答只有 `claude` 与 `codex` 两块
（`verify-and-register.ts:135-137`），ai-client 是从 `codex` 那份推出
`pi: { baseUrl, apiKey }` 的（`OnboardingService.saveVaultShadowCopy`，
另见 `piModelConfig/index.ts:64` 的三级回退 `pi → codex → cchBaseUrl + /v1`）。

模型配置要按渠道决定用不用「登录拿到的 pi 凭据」（见 [topic §一](../topics/wire-contract-and-constraints.md)），
让服务端显式声明比让客户端继续猜更稳。

## 决定

**onboard 注册应答的 `config` 增加 `pi: { baseUrl, apiKey }`；
客户端优先读它，读不到时保留现有的 codex 推导路径。**

这是加字段不是改字段，旧客户端读不到 `pi` 也照旧从 `codex` 推，行为不变。
`claude` 与 `codex` 两块原样保留。
