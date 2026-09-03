# Evidence — Q09 service_tier 注入点取证

> 2026-09-03，按 [D03](../decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定三派子代理取证。
> 读取对象：AiClient `feat/pi-primary-backend` + vendored `@earendil-works/pi-coding-agent`（含其自带 OpenAI SDK 6.40.0）。

## 结论

**有通道，但两条路都要付代价，且都不是「本仓改几行就完事」。**

Pi SDK 内部确实存在一条一路走到 HTTP 请求体的通用透传通道，链路已逐段核实：

```text
Model.samplingParams ──┐
                       ├─► buildBaseOptions() 合并（simple-options.js:10-13）
StreamOptions.samplingParams ─┘
   └─► Object.assign(params, options.samplingParams)（openai-completions.js:726-727 / openai-responses.js:262-263）
       └─► client.chat.completions.create(params)（openai-completions.js:185）
           └─► SDK 的 .create() 不做字段白名单过滤，body 原样 POST
```

并且 `service_tier` 在这版 OpenAI SDK 里是**货真价实的请求参数**，不是只出现在响应/用量类型里：
`resources/chat/completions/completions.d.ts:1431`（`ChatCompletionCreateParamsBase`）与
`resources/responses/responses.d.ts:6522` 都有它。

**但通道挂错了层。** `samplingParams` 属于「每个模型的静态默认值」这一层，存在 `models.json` 里；
而我们要的是「每次请求可切」。本仓唯一能触达 Pi 的公开 API——`prompt()`、`setModel()`、
`createAgentSessionFromServices()`——三处选项类型里**都没有**任何透传字段
（`agent-session.d.ts:154-170`、`agent-session-services.d.ts:43-57`）。

## `samplingParams` / `compat` 是不是死配置

**不是死配置，但也不是可用的控件。** 完整写入链路存在且 Pi 真的会读：
`configValidation.ts:100-105` 校验透传 → `toPiModelsJson()`（`:189-196`）序列化 →
`PiModelConfigService.ts:349` 原子写 `<agentDir>/models.json` → Pi SDK 从同一个 agentDir 读
（`piAgentSessionBootstrap.ts:216-217` 的注释明说）。

问题在两头：

1. **本仓从没往里填过值**——`PiModelManagementSettings.tsx` 对 `samplingParams` / `serviceTier` 全部零命中。
2. **内容治理权不在本仓**——`models.json` 的内容来自远端管理服务
   （`DEFAULT_PI_MODEL_MANAGEMENT_URL`，`piModelConfig.ts:8,29`），本仓只是把拉到的东西落盘。

**`compat` 不是透传袋**：它的 TypeBox schema 是已知字段的严格联合（`supportsStore` / `thinkingFormat` /
`openRouterRouting` / `cacheControlFormat` 等，`model-config.d.ts:60-170`），没有任意键，也没有 `service_tier`。

## 两条可行路径与各自的代价

**路径 A — 模型变体（静态、稳妥、但不是真正的「每条消息切换」）**
给同一底层模型配三份 managed model 定义，各自在 `samplingParams` 带 `{ service_tier: ... }`；
UI 的「优先级」实质变成「选模型变体」，复用现有 `setModel()`。
**代价**：模型清单来自远端服务，本仓改不了；要落地就得新增一层本地覆盖机制（目前不存在）。

**路径 B — 每次发送前改 Model 对象（动态、但依赖未公开的实现细节）**
在 `applySelectedModel()` 里浅拷贝 `Model` 并合并 `samplingParams`，再 `setModel(merged, { persist: false })`；
同时要放宽「模型不变就跳过 setModel」的判断（`piWorkerSession.ts:1066-1069`）。
**代价有三**：① 依赖 `setModel()`「传什么存什么、不校验」这一未写进文档的行为（`agent-session.js:1201-1216`），
Pi 升级后可能静默失效；② `setModel()` 内部会 `appendModelChange()`，每条消息切 tier 会在会话历史里
堆出大量「模型切换」记录；③ `openai-completions` 适配器没有为 `serviceTier` 建模，只能走通用兜底口。

两条路都**不需要**改 vendored 的 `node_modules`。

## 取证方自述的未确认项

- `agent.state.model` 在同一 turn 的多轮工具调用之间是否被重新读取（只影响路径 B 的「每条消息生效」粒度，
  不影响「每次新 `prompt()` 生效」）。
- 路径 B 改过的 `Model` 对象会不会被 Pi 的遥测 / 成本计算 / `modelsAreEqual()` 误判出副作用。
- 本仓 `PI_MODEL_APIS` 只允许四种 API（`piModelConfig.ts:31-36`），不含 `openai-codex-responses`；
  即使走 `openai-responses`，本仓类型也没有原生 `serviceTier` 字段，只能用通用兜底口。**未实跑抓包确认。**
- `compat` 对未知键是拒绝加载还是静默剥离（不影响本结论，因为不建议往 `compat` 塞）。
