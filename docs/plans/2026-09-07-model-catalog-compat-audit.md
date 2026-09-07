# 模型目录 compat 全量排查 — 2026-09-07

**范围**：`/api/v1/models-config` 返回的四个渠道（claude / gpt / grok / china）共 10 个模型。
**上游**：全部经公司网关 `https://cch-jyw.pipidan.qzz.io/v1`（渠道 `baseUrl` 继承自登录）。
**参照实现**：`@earendil-works/pi-coding-agent@0.84.3` 的 `dist/` 反编译。
**前一轮**：`2026-09-07-field-test-feedback-triage.md` §四 只给 Anthropic 系补了
`forceAdaptiveThinking`，并留了「建议先在一台机器上验一次再全量推」。本轮把那句话做完，
并把 compat 从"只修 china"扩到四个渠道。

---

## 一、根因：pi 的自动探测对本目录的每个渠道都失效

pi 的 `openai-completions` 适配器用 `detectCompat(model)` 猜兼容性，判据只有
`model.provider`（渠道 id）与 `model.baseUrl`：

```js
isDeepSeek = provider==="deepseek" || baseUrl.toLowerCase().includes("deepseek.com")
isZai      = provider==="zai" || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn")
isGrok     = provider==="xai" || baseUrl.includes("api.x.ai")
```

本目录的渠道 id 是 `claude` / `gpt` / `grok` / `china`，`baseUrl` 又统一是网关地址，
**没有一条规则命中**，于是每个 openai-completions 渠道都拿到"标准 OpenAI"默认值 ——
其中 `supportsDeveloperRole: true` 会把系统提示发成 `role: "developer"`。
这不是 china 独有的缺陷，是渠道 id 与 baseUrl 双双不可识别的结构性后果。

`compat` 的合并语义（`dist/core/provider-composer.js`）：
`mergeCompat(providerConfig.compat, definition.compat)` —— 浅合并，模型级覆盖渠道级同名键。

## 二、实测：50 个真实请求

每个模型跑 5 个场景（普通/流式、`effort=high`、`effort=max`、带工具、声明的 `maxTokens`），
请求体按 pi 0.84.3 的 `buildParams` 逐字复刻（含 `stream_options`、`store`、
`prompt_cache_key`、`eager_input_streaming`、`cache_control` 等）。

### 唯一的硬失败：`developer` role

对 china 的三个模型逐个 flag 翻转，结果高度一致：

| 翻转的 flag | deepseek-flash | deepseek-pro | glm-5.2 |
|---|---|---|---|
| 当前默认 | 503 | 503 | 503 |
| `supportsStore:false` | 503 | 503 | 503 |
| **`supportsDeveloperRole:false`** | **200** | **200** | **200** |
| `maxTokensField:"max_tokens"` | 503 | 503 | 503 |
| `supportsStrictMode:false` | 503 | 503 | 503 |

GLM 的报错点名了原因：

```
The parameter `***.role` specified in the request are not valid:
invalid value: `developer`, supported values are: `system`, `assistant`, `user`, `tool`.
```

即：**`supportsDeveloperRole: false` 是充分且必要的修复**，`store` / `maxTokensField` /
`strictMode` / `thinkingFormat` 全部与故障无关，按"不确定的能力不要声明"原则一律不写。

### 其余渠道实测通过，无需修复

- **grok-4.6**：`developer` role、`store:false`、`reasoning_effort`（含 `xhigh`）、工具、
  `maxTokens:500000` 全部 200，且每次都回 `reasoning_content`。
- **gpt-5.6-\***：`/responses` 上 `developer` role、`store:false`、
  effort `high`/`max`/`xhigh`、工具、`max_output_tokens:128000` 全部 200。
- **claude-\***：见下条。

### 网关不校验请求体（claude 侧的错配是静默的）

`thinking:{type:"enabled",budget_tokens:16384}`（真实 Anthropic API 在 Sonnet 5 / Opus 5 上
必 400）与 `max_tokens: 200000`（超 128K 上限）在网关上都返回 **200**。
所以 Anthropic 系的错配不会报错，只会静默不生效 —— 与上一轮现场反馈"好像不生效"吻合。
`forceAdaptiveThinking: true` 因此保留：它是按规范正确的形状，且在网关哪天不再兜底时是唯一能活的那个。

## 三、落地的 compat（全部在渠道级，无模型级覆盖）

| 渠道 | compat | 依据 |
|---|---|---|
| `claude` | `{"forceAdaptiveThinking": true, "supportsToolReferences": false}` | 前者规范正确、网关静默兜底；后者钉住当前生效值（`provider !== "anthropic"` 时 pi 本就推 false），防止将来改 id 时被悄悄打开 |
| `gpt` | `{"supportsDeveloperRole": true}` | 实测 `/responses` 接受；与 pi 默认一致，显式声明记录意图 |
| `grok` | `{"supportsDeveloperRole": true, "supportsReasoningEffort": true}` | 两项均实测接受；显式声明是为了防止改 id 为 `xai` 后被 pi 推成 false |
| `china` | `{"supportsDeveloperRole": false, "supportsReasoningEffort": true}` | 前者是实测出的唯一修复；后者实测接受（pi 若按 `zai` 推会是 false） |

三个 claude 模型的模型级 `forceAdaptiveThinking` 已上收到渠道级并清空，避免两处同源。
`api` / `baseUrl` / `authHeader` / `credentials` / `thinkingLevelMap` / `contextWindow` /
`maxTokens` / 模型 id 与名称全部未动（admin 前后 diff 仅 compat 与 updatedAt 两列）。

## 四、渠道 id 对齐：实测结论是**不做**

把渠道 id 改成 pi 认识的名字，本意是让 `detectCompat` 自动出正确值。逐个核对后：

| 对齐方案 | pi 会自动推出什么 | 判定 |
|---|---|---|
| `china` → `deepseek` | `supportsDeveloperRole:false` ✅，外加 store / max_tokens / `thinkingFormat:"deepseek"` / `requiresReasoningContentOnAssistantMessages` 四项未经验证的改动 | 收益仅一项，代价是四项盲改 |
| `china` → `zai`（GLM） | `supportsDeveloperRole:false` ✅，但同时 `supportsReasoningEffort:false` ❌（实测网关接受且 GLM 会回 `reasoning_content`），且 `thinkingFormat:"zai"` 会**无条件**发 `thinking:{type:"disabled"}` —— 本轮唯一一次偶发 503 正是这个形状 | **有害** |
| `grok` → `xai` | `supportsReasoningEffort:false` ❌、`supportsDeveloperRole:false`（实测两者网关都接受） | **有害** |
| `claude` → `anthropic` | 打开 `supportsToolReferences`（三个模型都满足 `major>4 \|\| (major===4 && minor>=5)`），改变多轮工具回放的消息形状 | **实测无害**，见 §四补测；但收益为零 |
| `gpt` → `openai` | 无变化（`sessionAffinityFormat` 本就是 `"openai"`） | 无收益 |

**结论**：网关做了归一化，它的真实行为与 pi 内建的"真上游"假设并不一致，所以显式 compat
比对齐 id 更准，而且不破坏已存会话里的 `provider/modelId` 引用与用户默认模型设置。

`china` 拆成两个渠道在组织上完全合理（DeepSeek 与 GLM 是两个上游），但对 compat 没有收益 ——
两个模型需要的恰好是同一条渠道级设置；若拆成 `zai`，反而要额外写 compat 去抵消 pi 的 zai 假设。
拆分建议按目录整洁度单独决策，不与本次修复绑定。

### §四补测：`supportsToolReferences` 打开后到底发生什么

打开后 pi 会把「本轮由某个 tool_result 动态加载进来、且还没被调用过」的工具标记
`defer_loading: true`，并把那条 tool_result 的 **content 换成** `[{type:"tool_reference",tool_name:…}]`，
原本的工具输出移到**同一条 user 消息里紧随其后的 sibling 文本块**
（`params.push({role:"user",content:[...toolResults,...siblingContent]})`）。

按 pi 的完整形状实测（claude-sonnet-5，工具输出是哨兵串 `BANANA-42`）：

| 形状 | HTTP | 模型回答 |
|---|---|---|
| OFF：tool_result 装真实输出 | 200 | `The file says BANANA-42.` ✅ |
| ON：tool_result=`[tool_reference]` **+ sibling 文本**（pi 的真实形状） | 200 | `The file reads: BANANA-42` ✅ |
| 对照：同上但**丢掉 sibling** | 200 | `The file contains the text "bash".` ❌ |

第三行是我第一次漏放 sibling 的错误构造，不是 pi 的行为。
**结论修正**：`tool_reference` 在本网关上能正确往返，不丢工具输出；
`claude` → `anthropic` 对齐并没有实测到的危害，只是**没有任何收益**。
渠道级仍显式写 `supportsToolReferences: false` —— 那是今天已经生效的值，
钉住它只是不让一次改名悄悄改变线上请求的消息形状，属于保守钉桩，不是修 bug。

## 五、遗留风险：网关把上游 400 包装成 503，pi 会重试它

网关**从不返回 4xx**。请求体非法（`developer` role）、参数不支持（`thinking.type: disabled`）、
模型不存在，一律：

```
HTTP 503 {"error":{"message":"…","type":"service_unavailable_error","code":"service_unavailable_error"}}
HTTP 503 {"error":{"message":"No available providers …","type":"no_available_providers"}}
```

响应头没有 `retry-after` / `x-should-retry`。这会同时踩中 pi 的两层重试：

1. SDK 层 `retryProviderRequest`（`chunk-XNGRGP62.js`）：
   `isRetryableProviderError` 判 `status >= 500` → 重试。
2. 会话层 `_prepareRetry` → `isRetryableAssistantError`：**只对错误消息做正则匹配，不看状态码**。
   用 pi 包内原文正则实测：

   ```
   RETRIED  <- "…max_tokens: 500000 is greater than…"   [matched: '500']
   RETRIED  <- "…\"type\":\"internal_error\"…"           [matched: 'internal_error']
   RETRIED  <- "upstream request timeout"                [matched: 'timeout']
   ```
   `503` 与 `service_unavailable` 同样在 `RETRYABLE_PROVIDER_ERROR_PATTERN` 里。

于是一个**永久性**的配置错误会被按退避反复重发，用户看到的就是不断刷新的
"Upstream error 503 — retrying n/10, the turn is still running"。
本次把请求形状改对，等于把这条路径的触发源掐掉；但**根治要在网关侧**：
上游返回 4xx 时应透传 4xx，而不是统一改写成 503。这一条不在本仓，也不在 onboard 服务，
已知需要 `cch` 侧处理。

顺带：`grok-4.6` 的 `maxTokens: 500000` 等于它的 `contextWindow`，语义上不可能是输出上限；
网关不校验所以现在不报错，但一旦某天报错、错误里回显这个数字，就会命中上面那条 `/500/`。
建议单独压到真实输出上限（本次按"保留现有 maxTokens"的要求未动）。

## 六、门禁

- 目录写入：`GET /api/admin/model-config` 备份 → 逐条 `PUT` → 再 `GET` 做前后 diff，
  确认只有 compat 与 updatedAt 变化。备份留在 `/tmp/admin-before.json`。
- 链路贯通：拉线上 `/api/v1/models-config` → 过本仓 `validatePiManagedModelsConfig` +
  `toPiModelsJson` → 用 pi 自己的 `dist/core/model-config.js` 加载生成的 `models.json`
  → 打印 `mergeCompat` 后的逐模型 effectiveCompat。两侧校验均 OK，compat 双层无损。
- 回归：10 模型 × 5 场景 = 50 个真实请求，全部 200。
- **本仓代码未改动**，因此未跑 lint / typecheck / test（本机资源受限且无 `node_modules`）；
  本轮改的是线上目录数据与本文件。
