# 决策 181：摘要请求沿用对话最近一次请求的思考档位（DA-1）

日期：2026-10-11。**状态：自主决定，待用户审批。**

代码：尚未提交（工作树，HEAD `acc398fc`）。

来源：dsh.11 出包前的真实网关验收 [dsh11-acceptance-real-gateway-2026-10-11](../evidence/dsh11-acceptance-real-gateway-2026-10-11.md) 的 DA-1（GPT 6.1 Sol 的 `/compact` 4.8 s 失败，上游 400 `unsupported_value: 'none' is not supported with the 'gpt-6.1-sol' model`）；编排者的修法要求：摘要请求沿用这个对话最近一次 agent 请求的思考档位（同模型、同档位），既不再落到 `off` / `none`，也让 Anthropic 的提示缓存在摘要请求上真正可复用。

修订关系：

- [决策 179](179-compact-instructions.md)：摘要钩子的包装从「只在有说明的 `/compact` 时改请求」扩展为「每个摘要请求都改」——手动、步间压力、超窗恢复三条路都经过它。试跑的判定拆成两类（第 6 节）：钩子本身不对（不是恰好一次摘要请求）时照旧不包装；只是消息形状不对时**改为仍然包装**（只补档位），说明照旧拒绝。§4 的 DSH 升级核对清单加上第 8 节的三条。
- [决策 177](177-auto-compaction-policy-per-model.md)、179 依赖「摘要请求复用对话前缀，提供方的提示缓存可复用」：在 Anthropic 的思考行上，这个前提在本决策之前并不成立（第 5 节）。
- [决策 141](141-model-plan-adaptive-thinking-hardening.md)（只支持 adaptive 的 Claude 行不下发 `off`）：兜底档位沿用它，不会选 `off`。
- [决策 035](035-keep-our-model-ids.md) / [040](040-default-effort-and-settings-mapping.md)（会话模式未选档位时发 `medium`，单次补全不发）：不变；本决策不设路由默认档（第 3.3 节）。

## 1 现象（验收 DA-1）

- GPT 6.1 Sol 会话三轮读文件后 `/compact`：4.8 s 失败，`compaction/end.error` 为 `unsupported_value: Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.`，`command/done` 只说「没能生成有用的摘要」（DA-2，见[决策 180](180-manual-compact-in-timeline-and-timeout.md) 第 13 节）。
- 手动、自动（步间压力）、超窗恢复都走同一个摘要请求，所以这个模型的**所有压缩**都会这样失败。上一轮取证里同一模型两次 45 s 超时（CG-1）也可能是它。

## 2 机理（逐条核实，dsh 0.1.7-rc.2、pi-ai 随宿主安装的版本）

| 环节 | 位置 | 事实 |
|---|---|---|
| 摘要请求不带档位 | `@deepseek-ai/dsh-compaction-basic/lib/index.js:292-322` `summarizeWithLlm` | `options` 只有 `provider`、`model`、`messages`、`toolHistory`、`tools`、`maxTokens`、`sessionId`、`purpose: 'compaction'`、`signal`；路由取 `config.summarizationProvider` → `agent.session.requestHeader()?.config` → `agent.options`，档位一律不带 |
| 缺省档位只来自路由默认档 | `@deepseek-ai/dsh-llm/lib/index.js:2169-2190` `resolveCallWithInfo` | 没带档位时用模型信息的 `reasoning.defaultEffort`；它来自路由 profile 的 `reasoning`（`dsh-llm-pi-ai` `describableReasoningLevel`），我们的计划不设，所以仍为空 |
| 空档位到 pi-ai | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1847` `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`；`:1670-1674` `profileOptions` | 结果为空，`reasoning` 不传给 pi-ai（`off` 也是不传） |
| OpenAI Responses 的回落 | `@earendil-works/pi-ai/dist/api/openai-responses.js:162-173`（`streamSimple`）、`:253-268` | 推理模型没有 `reasoningEffort` 时发 `reasoning: { effort: thinkingLevelMap.off ?? 'none' }`；托管目录给 gpt-6.1-sol 声明了「关闭」档，`off` 不是 `null`，于是发 `none`，上游 400 |
| Anthropic 的回落 | `@earendil-works/pi-ai/dist/api/anthropic-messages.js:655-666`、`:872-874` | 没有 `reasoning` 即 `thinkingEnabled: false`；`off` 未置空时发 `thinking: {type: 'disabled'}`，置空（决策 141 的 adaptive 行）时**什么思考参数都不发**。而对话的每一步发 `thinking: {type: 'adaptive'}` + `output_config.effort` |
| 对话请求的档位在哪 | `@deepseek-ai/dsh-agent-loop/lib/index.js:1148-1165` `prepareRequest`；我们的 `installModelSelection`（`bridge/modelRoute.ts`、`shared/dshModelPlan/route.ts:60-68`） | 每步的配置（含 `reasoningEffort`）写在 `request/header`，`session.requestHeader().config` 就是最近一次请求实际用的档位；会话模式未选档位且模型提供 `medium` 时为 `medium` |

## 3 修法

### 3.1 宿主层：摘要钩子的包装补上档位

- `src/dsh-host/bridge/compactInstructions.ts`（决策 179 的包装所在）：
  - `summaryReasoningEffort({request, latest, offered})`：第 4 节的规则，纯函数。
  - 包装后的 `summarize` 在把请求交给 `this.ctx.llm.stream` 之前（说明照旧追加在最后一条消息里），对 `purpose: 'compaction'` 的请求读 `agent.session.requestHeader()?.config`，按规则补 `reasoningEffort`，其余字段与消息对象一个不动（缓存前缀仍是同一批对象）。
  - 每个摘要请求写一行 bridge 日志：`[dsh-bridge] summary request of <DSH 会话> on <路由>/<模型>: reasoning effort <档位|none> (<conversation|lowest|none|request>)`，真实网关上可直接核对。
  - `installSummaryHook(service, {efforts, log})`：每个服务实例只装一次；`efforts` 读计划。
- `src/dsh-host/bridge/modelRoute.ts`：`DshModelRouter.efforts(provider, model)`，从计划的 `index` 找这条路由与模型提供的档位（与 DSH 的 `getSupportedThinkingLevels` 同一份，决策 033 R10）。
- `src/dsh-host/bridge/dshSessionRuntime.ts`：运行时每打开一个 agent（`setupAgent`：新建、重开、回退、分叉）就安装，赶在它的任何压缩之前；`/compact` 在问 DSH 之前再等一次安装完成。
- 不改 DSH / pi-ai 内核文件。

### 3.2 为什么放在摘要钩子上

- 三条压缩路径都经过同一个 `summarize`（决策 179 §2），在这里补一次，手动、压力、超窗恢复都生效；Main、渲染层、计划都不用动。
- 钩子拿得到 `agent`，`requestHeader()` 就是「这个对话最近一次请求」，不用另建会话 → 档位的映射。

### 3.3 为什么不设路由默认档（`profile.reasoning`）

路由默认档会改变**所有没带档位的请求**，不只是摘要：

- 单次补全（P1-15，`completion` 模式按决策 040 规则 2 对「关闭 / 未选」不发档位）会开始带思考，变慢变贵；
- DSH 的会话标题请求（`purpose: 'session-title'`）同样会带上；
- 会话模式下解析不出档位的模型（不提供 `medium` 又没选档位）的对话请求也会被改；
- 它是路由级的，一条路由上的每个模型都必须支持这个档位，否则 `describableReasoningLevel` 不描述、请求路径拒绝（`UNSUPPORTED_REASONING_EFFORT`）；
- 它给的是固定档位，不是这个对话的档位，修不了第 5 节的缓存问题。

## 4 规则（`summaryReasoningEffort`）

| 情形 | 摘要请求的档位 | 来源标记 |
|---|---|---|
| 请求本身已带档位（DSH 将来自己带上） | 不动 | `request` |
| 最近一次请求与摘要同路由同模型 | **原样沿用**它的档位，包括「没带」与 `off`（它们与对话的请求逐字相同） | `conversation` |
| 同上，但计划已不再提供那个档位（宿主换了计划后重开的旧会话） | 落到兜底 | `lowest` |
| 没有这个模型的请求：从未发过请求（导入的旧会话、种子会话）、最近请求在别的模型、行配置了 `summarizationProvider` 把摘要路由到别处 | 计划给该模型提供的**最低的非 `off` 档**（按升序：`minimal` → `low` → …） | `lowest` |
| 该模型不思考，或计划不服务这个模型 | 不带 | `none` |

- 「原样沿用 `off`」是有意的：在 `off` 可用的模型上（用户主动关了思考），摘要与对话同参数才复用缓存；在 `off` 不可用的模型上（gpt-6.1-sol 的「关闭」档），对话那一轮本身就已被同样拒绝，问题在目录（见第 9 节风险 3）。
- 兜底不选 `medium` 而选最低档：兜底时对话前缀在这个模型上本来就没有可复用的缓存（没有同模型的请求），档位越低越快越便宜，离 600 s 时限越远；Claude 的 adaptive 行没有 `off`（决策 141），兜底是 `low`；GPT 6.1 Sol 是 `low`。

## 5 对缓存的影响

- Anthropic 的提示缓存：`thinking` 或 `effort` 的变化一定使**消息层**缓存失效；在把思考配置渲染在工具与系统提示之前的模型上，工具层、系统层也失效（Claude API 文档「Invalidation hierarchy」）。
- 本决策之前，adaptive 的 Claude 行上，对话每步是 `thinking: {type: 'adaptive'}` + `output_config: {effort: 'medium'|…}`，摘要请求**没有任何思考参数**（第 2 节）：消息字节完全相同，缓存仍然整段重写。决策 177 / 179 说的「摘要请求复用对话前缀的缓存」在这些行上并没有兑现。真宿主测试的变异检查直接复现了这一点（第 7 节 `[181-I-3]`：去掉补档位后，摘要请求的 `thinking` 为空）。
- 本决策之后，摘要请求的 `thinking` 与 `output_config` 与上一条对话请求逐字相同，消息层缓存可读。代价：摘要本身按对话的档位思考（`high` / `xhigh` 会多出思考 token、更慢）；这是「同档位才复用缓存」的必然结果。
- OpenAI Responses：主要收益是不再 400；缓存方面同样保持请求参数一致。

## 6 失败安全（试跑判定拆分）

| 试跑结果 | 包装 | 档位 | `/compact` 说明 |
|---|---|---|---|
| 恰好一次 `purpose: 'compaction'` 的请求，形状符合 | 包装 | 补 | 可用 |
| 恰好一次摘要请求，但消息形状变了 | **包装**（决策 179 时不包装） | 补 | 拒绝（`unsupported`），bridge 日志写一行原因 |
| 没问模型 / 问了多次 / 抛错 / 超时 / 不是摘要请求 | 不包装，原样留给 DSH | DSH 自己的（可能是 `none`） | 拒绝；bridge 日志写一行 `summary hook left as DSH ships it …` |

DSH 升级时要核对的三条（补进决策 179 §4 的清单）：`summarizeWithLlm` 的 `options` 仍经 `this.ctx.llm.stream` 发出且带 `provider` / `model` / `purpose: 'compaction'`；`GenerateOptions.reasoningEffort` 仍是档位入口；`session.requestHeader().config` 仍是最近一次请求的配置。DSH 若自己开始给摘要请求带档位，规则第一行让它的为准（`request`）。

## 7 验证（2026-10-11，开发机，一次一个测试进程，先看 `free -m`）

- 单测 `compactInstructions.test.ts`：`[181-E-01]` 规则表（沿用、`off` 与「没带」原样、无计划时原样、换模型 / 换路由 / 档位下架落到最低非 off、`minimal` 优先、不思考的模型不带、请求自带不动）；`[181-E-02]` 自动压缩与带说明的 `/compact` 都按会话档位发出、前缀仍是同一批对象、每次一行日志；`[181-E-03]` 无同模型请求时取最低档、adaptive 行不取 `off`；`[181-E-04]` 钩子不对时不包装并写日志；`[181-H-10]` DSH 自己的 `summarize`（`BasicCompactionEngine.prototype`）包装后带上会话档位，行配置把摘要路由到别的模型时取那个模型的最低档；`[179-H-04]` 改写（形状不对时包装但拒绝说明）。
- 单测 `commandsAndState.test.ts`：`[181-B-01]` 运行时打开 agent 时就装好，自动压缩（不经 `/compact`）按会话档位、兜底、不思考的模型各一例，日志逐行核对；`[181-B-02]` `/compact` 问 DSH 之前已装好。
- 真宿主集成测试（新）`src/dsh-host/__tests__/summaryEffort.integration.test.ts`（`AICLIENT_DSH_INTEGRATION=1`，一个宿主、本地假网关、每个请求落盘核对）。假网关新增：`…/responses` 上 id 以 `-sol` 结尾的模型收到 `reasoning.effort: 'none'` 回 400 `unsupported_value`（仿 GPT 6.1 Sol）。
  - `[181-I-1]` fake-sol 两轮 `high` 后 `/compact`：摘要请求 `reasoning` 与对话请求相同（`{effort: 'high', summary: 'auto'}`），压缩成功，bridge 日志有 `reasoning effort high (conversation)`；
  - `[181-I-2]` 一轮 `high`、一轮 `off`（对话本身 400）后 `/compact`：摘要沿用 `off`，发出 `none`，同样被拒；时间线行与答复都写明 `HTTP 400 · unsupported_value: …`（DA-2）；
  - `[181-I-3]` adaptive Claude 行（64k）三轮 `high`，第三轮第一步自动压缩：摘要请求的 `thinking` 与 `output_config` 与对话请求逐字相同。
- 变异检查：去掉「补档位」一行，`[181-E-02]`、`[181-E-03]`、`[181-H-10]`、`[181-B-01]`、`[181-B-02]`、`[181-I-1]`（`/compact` 400，复现 DA-1）、`[181-I-3]`（摘要没有 `thinking`）共 7 项失败；用备份恢复，`cmp` 一致。
- 门禁（与决策 180 第 13 节同一轮）：两套 tsc 通过；改动文件 biome 无问题；`vitest run src/dsh-host` 52 个文件通过、4 个跳过（集成与 win32），1093 项；`bridge-smoke.ts` exit 0；`bridge-record.ts --check` 36 个场景 **0 差异**（录制模型 `fake-1` 不思考，摘要请求不变）。

## 8 金样本

不需要重录：录制用的 `fake-1` 是不思考的模型，摘要请求没有档位可补；`compaction/summary` 也不记档位。

## 9 风险与真实网关要复测的点

1. **GPT 6.1 Sol `/compact`**（Windows 测试包）：应成功；bridge 日志（Main 日志里的宿主 stderr）应有 `summary request … on <路由>/gpt-6.1-sol: reasoning effort <对话档位> (conversation)`；记录用时与输出 token（600 s 时限是否够，CG-1 的老问题）。
2. **Claude 的压缩缓存读**：Opus 5.5 会话手动压缩，摘要那一步的缓存读应接近上一步的提示量（之前应接近 0、整段写入）；运行面板的缓存链与会话日志 `usage` 对照。若仍整段写入，说明网关在 Claude 路由上的改写（DA-3）也作用于摘要请求，与本决策无关。
3. **菜单里 GPT 6.1 Sol 的「关闭」档**：对话本身发 `none`，同样 400；本决策按规则让摘要沿用 `off`（与对话一致）。根因是托管目录给这个模型声明了「关闭」档，应请管理员置空（或另立决策在计划层对这类模型撤下 `off`），本决策不处理。
4. **摘要变慢变贵**：对话在 `xhigh` / `max` 时摘要也在这个档位思考；长对话的摘要更可能逼近 600 s。若真实网关上不可接受，可另议「摘要档位上限」，但会牺牲 Anthropic 的缓存复用（第 5 节）。
5. **兜底档位不复用缓存**：没有同模型请求时的摘要本来就没有可复用的缓存，取最低档只影响质量与耗时。
6. **DSH 升级**：第 6 节的三条核对；试跑把钩子判为不对时，摘要回到 DSH 自己的（可能 `none`），会话照常，只是 GPT 6.1 Sol 这类模型的压缩会再次失败，bridge 日志有明确一行。

## 10 用户审批

- [ ] 第 3 节：在宿主层的摘要钩子包装上补档位，不设路由默认档、不改 DSH 内核
- [ ] 第 4 节规则：同模型原样沿用（含「没带」与 `off`）；否则取计划提供的最低非 `off` 档；不思考的模型不带
- [ ] 第 5 节：摘要按对话档位思考（为了缓存复用，接受多出的思考 token）
- [ ] 第 6 节：形状不对时仍包装补档位（与决策 179 的「不包装」不同），钩子不对时原样留给 DSH
- [ ] 第 7 节：假网关 `-sol` 模型拒绝 `none`；新真宿主集成测试
- [ ] 第 9 节风险 3：GPT 6.1 Sol 的「关闭」档留给目录 / 另一决策
