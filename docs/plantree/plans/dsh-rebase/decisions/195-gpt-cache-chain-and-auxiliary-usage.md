# 决策 195：缓存断链检测扩到 openai-responses；「本会话累计」计入压缩摘要与审核请求

日期：2026-10-18（北京时间）。**状态：按[决策 193](193-user-rulings-2026-10-18.md) 第 9、10 条实现；标「自主」的是实现时的自主决定，待用户审批（第 5 节汇总）。** 分支从 `claude/s6-feedback`（`89d82245`）切出，本地提交，未推送。起因见 [GPT 用量核对](../evidence/gpt-usage-check-2026-10-18.md)。

编号说明：194 已被另外两个会话各用了一次（`194-engine-outbound-proxy.md`、`194-slash-menu-plugin-skills-and-sdk-commands.md`，都还没合到这条分支），这份接 195。

## 1 两件事的结论

- **第 9 条**：openai-responses 路线的每一步现在也判「首次缓存 / 复用 / 重建 / 变短」，有没有本地原因照旧；宿主的前缀检查也读 Responses 的请求体。Run 面板对 GPT 的步骤用 OpenAI 的说法（「首次缓存」「未命中约 N」），日志照旧写 `cache-chain:` 与 `prefix-watch:` 两种行。
- **第 10 条**：本会话累计加上了压缩摘要请求和全自动档的审核请求；步数一栏写成「10 + 1 次辅助请求」，下面的说明随之改成「本会话的数字是把每一次模型请求（包括压缩摘要等辅助请求）累加起来的结果……」。费用仍不显示。

## 2 缓存断链检测扩到 openai-responses（第 9 条）

### 2.1 OpenAI 的用量口径

- 网关回 `input_tokens`（整个提示）与 `input_tokens_details.cached_tokens`（命中部分）；没有缓存写入。pi-ai 换算成 `inputTokens = input − cached`、`cacheReadTokens = cached`、`cacheWriteTokens = 0`（pi-ai 也读 `cache_write_tokens`，只有显式缓存模式的服务商会给）。
- 缓存是自动的：提示词满 1,024 token 才缓存，按 128 token 一块，下次请求命中最长的相同前缀。
- 保留时间：路线的 `cacheRetention` 是 `long`（设置里「1 小时」，默认）时 pi-ai 发 `prompt_cache_retention: '24h'`，模型 compat 写了 `supportsLongCacheRetention: false` 就不发；`short` 不发，走 OpenAI 的内存缓存（无活动 5～10 分钟淘汰，最长 1 小时）。

### 2.2 判定怎么改（`src/shared/cacheChain.ts`）

- 新的路线属性「隐式缓存」（`CacheChainOptions.implicitCache`）。每一步记下它**留下的缓存**（`cachedOf`）：
  - Anthropic：读 + 写，和以前一样；
  - OpenAI：提示词按 128 向下取整，不到 1,024 为 0；服务商报了写入（显式模式）时仍按读 + 写。
- 比较的基准从「上一步读 + 写 > 0」改成「上一步留下了缓存」，所以 GPT 会话**第二步就能判**（第一步读 0、写 0，但已经被自动缓存了）。
- 「重建 / 变短 / 复用」的阈值不变：丢失量仍是「上一步提示词 − 这一步读到的」，正常复用时 128 块的零头最多 127，远小于重建门槛 1,024。
- **「重写」量（自主）**：Anthropic 是 min(丢失, 写入)；OpenAI 没有写入，改按 min(丢失, 未缓存输入 + 写入)，即本该读缓存、却按未命中计费的部分。会话提醒的门槛（2 次无法解释的重建，或重写 10 万 token）不变，GPT 的「重写」就按这个量算。
- 「读到较早某步的前缀」照旧比对缓存大小，GPT 的步骤用 `cachedOf` 的块大小比。
- 折叠状态的版本 2 → 3（每步多存 `cached`，判定的语义变了）；旧版本的存档被拒绝、从日志重折，宿主本来每次读都重折。

### 2.3 保留时间（`cacheChainReport.ts`，自主）

| 路线 | `cacheRetention` | 按多久算过期 |
|---|---|---|
| anthropic-messages | long / short | 1 小时 / 5 分钟（不变） |
| openai-responses | long | 24 小时；模型（或路线）compat 写 `supportsLongCacheRetention: false` 时 5 分钟 |
| openai-responses | short | 5 分钟（内存缓存按短的算：过期能解释的空闲越多，误报越少） |

### 2.4 前缀检查读 Responses 请求体（`requestPrefix.ts`、`requestTap.ts`）

- 认请求：POST、路径以 `/responses` 结尾、请求体是字符串（OpenAI SDK 就这么发）。
- 拆成和 Messages 同样的单元：
  - 配置：顶层字段，除了 `input`、`instructions`、`tools`、`metadata`、`max_output_tokens`、`stream`、`temperature`；`model`、`prompt_cache_key`、`prompt_cache_retention`、`store`、`reasoning` 都算；
  - 每个工具；
  - `instructions` 当系统提示（没有就是空）；
  - `input` 的每一项当一条消息，日志里的角色取 `role`，没有就取 `type`（如 `function_call_output`）；
  - 字符串 `content` 按它等价的 `input_text` / `output_text` 片段求哈希，同一段文字换了形式单独报 `message-form`（照决策 182）；字符串 `input` 当一条用户消息。
- **只读不改**：Responses 请求一个字节都不动（`metadata.user_id` 与「用户消息转块」只对 Anthropic；pi-ai 已经把会话 id 放在 `prompt_cache_key`）。请求体的解析放在请求发出之后。
- 同一会话、同一用途还是一条链，不分协议：会话里从 Claude 换到 GPT 会报一次 `diverged at=config`，这一步的缓存判定本来就有「换了模型」这个本地原因。
- 前缀检查的证据照旧挂到对应步骤上：实测里 GPT 那一步的 `cache-chain:` 行带 `prefix=append`，说明客户端只是在末尾追加。

### 2.5 开关（§6 要求新能力可关）

- `AICLIENT_RUNTIME_RESPONSES_CACHE_WATCH=0`：openai-responses 回到「记录、不判定」，前缀检查也不读 Responses 请求；Anthropic 不受影响。`AICLIENT_RUNTIME_CACHE_CHAIN=0`、`AICLIENT_RUNTIME_PREFIX_WATCH=0` 照旧整个关掉。
- 宿主启动日志那一行只在这个开关关掉时多一段「, openai-responses watch off」，默认一字不变（`request-prefix-probe.ts` 与集成测试按整行比对）。

### 2.6 界面（`runPanelModel.ts`、`RunCacheSteps.tsx`）

- 缓存信息块多一个 `implicit` 标记，渲染端据此换说法：
  - 首步：「首次缓存」（灰色），悬停「还没有可用的缓存。服务商会自动缓存这一步的提示词，不单独收缓存写入的费用。」。**自主**：首步本来只在有写入时发，GPT 永远写 0，不发的话健康的 GPT 会话一个徽标都没有，「首次写入之后，每一步都复用了上一步的缓存」这句脚注也永远出不来。现在 GPT 首步提示词满 1,024 就发。
  - 重建：「无法解释 · 未命中约 N」，悬停「上一步提示词 X，这一步只读到 Y，约 N 按未命中计费。……」；复制诊断里写「无法解释，未命中 N」。
  - 无法解释时标橙的数字：Anthropic 是「缓存写」列，GPT 是「缓存读」列（写入恒为 0，掉下来的是读）。
- 变短、本地原因、会话提醒的文案不变：「重新写入缓存」对 OpenAI 也成立，只是自动写、不另收费。

### 2.7 没做的

- openai-completions（DeepSeek、GLM 等）仍不判定：各家报缓存的字段不统一，pi-ai 的换算也不一样。
- 假网关按完整单元（instructions、tools、每个 input 项）比前缀，真 OpenAI 是逐 token 的。判定只看用量数字，不受影响；前缀检查本来就是按单元比的。

## 3 「本会话累计」计入辅助请求（第 10 条）

### 3.1 盘点：一个会话的模型请求有哪些

| 请求 | 现在有没有 | 计不计 | 依据 |
|---|---|---|---|
| 主循环每一步（含失败重试） | 有 | 已计 | dsh-token-meter 的 `tokenUsage` 只累加 `assistant/message` 与 `assistant/attempt` |
| 压缩摘要（自动压缩与 `/compact`） | 有 | **计** | DSH 在 `compaction/summary` 里记了这次请求的 `usage` |
| 全自动档的审核（决策 192） | 全自动档且管理员配了审核模型时有 | **计（自主）** | 每次快审、细审都是一次请求，不写日志 |
| 会话标题 | **没有**模型请求 | — | DSH 的 `session-title-llm` 在 `bundle/cordis.patch.yml` 里关着；客户端用第一句话起标题（`deriveSessionTitleFromFirstMessage`） |
| 一次性补全（提交信息、分支名、代码审查） | 有 | 不计 | 不属于任何会话 |
| 子代理 | 有 | 没动 | 子代理是独立的 DSH 会话，用量记在它自己的日志里；DSH 宿主现在没给本会话累计送「委派」那一份，另说（第 6 节） |
| 失败或作废的摘要请求 | 有 | 不计 | DSH 不记它们的用量 |

### 3.2 做法

- 压缩摘要：宿主的历史缓存（`historyCache.ts`）和缓存链一样从日志折叠（`src/shared/dshAuxiliaryUsage.ts`），会话重开后也在。
- 审核：`AutoReviewer` 每次请求结束（失败也算）报一次流里最后的用量，会话 runtime 在内存里累加。**自主取舍**：审核不写日志，所以只从宿主这次运行起算，宿主重启或会话重开后，之前的审核不再计入。要持久化就得往 DSH 日志加我们自己的事件类型（动 DSH 的事件格式）或另存旁路文件，都不值；SDK 引擎的本会话累计整个都是内存里的，也是重启清零。
- 发送：结算每一步时，本会话累计 = token meter 的总量 + 辅助请求；`auxiliary` 字段写辅助请求的次数，为 0 时不带这个字段（所以没有辅助请求的会话，载荷与以前一字不差）。
- 显示：步数一栏「10 + 1 次辅助请求」；有辅助请求时说明文字换成新的一句，没有时（包括 SDK 引擎）保持原句。
- 刷新时机：本会话累计跟着每一步的用量一起发，手动 `/compact` 之后要等下一次发消息才看到。不为它单发一次用量：「最后一步」那几行会被当成摘要请求的数字。
- 录制：没有辅助请求时载荷不变；`bridge-record.ts` 的 `compact` 场景在压缩之后没有模型步骤，所以录制输出应该不变。Windows 上跑不完录制门禁，留给 CI 的 gate 验证。

## 4 验证

- 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`）0 错。宿主与 bridge 的打包输入检查（`checkHostMetafile`、`checkBridgeMetafile`）通过，新模块在允许的范围内。
- 单测（新增或改动）：`cacheChain.test.ts`（隐式缓存 8 条）、`cacheChainReport.test.ts`（路线与保留时间 3 条）、`requestPrefix.test.ts`（Responses 单元 5 条）、`requestTap.test.ts`（Responses 请求 5 条，状态多一项）、`liveEvents.test.ts`（累计 2 条）、`historyCache.test.ts`（压缩摘要 1 条）、`autoReview.test.ts`（审核用量 2 条）、`piUsage.test.ts`（2 条）、`runPanelCacheModel.test.ts`（2 条）、`runPanelModel.test.ts`（2 条）。shared、bridge、宿主 lib、workspace-shell 四组共 3,929 条，失败 7 条，都是这台 Windows 上本来就过不了的（`sessionGc` 按 `/` 比路径、`gearsAndTools` 建符号链接 EPERM、`workspaceSpellings` 要 8.3 短名），这几个文件没有引用任何改动过的模块，在基线 `89d82245` 上也是这 7 条失败。
- 去掉实现后单测会失败：13 处实现逐一去掉（隐式判定、隐式重写量、跟随 openai-responses、24 小时、读 Responses 请求、Responses 单元、累计加辅助、折叠压缩摘要、报审核用量、读回 `auxiliary`、隐式首步、步数文字、隐式徽标），每处都有对应的测试失败。
- 开发版实测（假网关 `fake-gateway.mjs`，openai-responses 服务 `gpt-fake-r`，权限「改动前确认」）：
  - 假网关的 GPT-LOOP 加了 `"evict": k`：在第 k 次调用前丢掉这个缓存键的模拟缓存，用来造一次无法解释的重建。
  - `GPT-LOOP {"tag":"a","steps":4,"tool":"read","file":"big.txt","evict":2}`：逐步缓存列出 5 步，第 1 步「首次缓存」，第 3 步「无法解释 · 未命中约 7k」、它的「缓存读」0 标橙，脚注「第 3 步找不到本地原因。」；应用日志一行 `cache-chain: upstream cache inconsistency … step=t1s3 kind=rebuild prompt=7376 prev=6782 read=0 write=0 lost=6782 matched=- prefix=append`。
  - 再 `/compact`、再发一轮：步数「10 + 1 次辅助请求」，输入 17.6k、输出 132、缓存读取 68.0k，与假网关 11 次请求逐条相加相同（未缓存输入 17,621、命中 67,968、输出 11×12），说明文字换成了新的一句。压缩后那一步的请求在 `messages` 第 1 项分叉（摘要换掉了历史），宿主照旧写了一行 `prefix-watch`，缓存判定由「压缩」解释，没有 `cache-chain:` 行。
- 没验证的：录制门禁（留给 CI）；真实 OpenAI 网关（没用）；审核请求计入累计只有单测，开发版没配审核模型。

## 5 待用户审批（自主决定）

1. OpenAI 的「重写」量按 min(丢失, 未缓存输入)，会话提醒的门槛对 GPT 不另设（2.2）。
2. openai-responses 的保留时间：long 按 24 小时，short 与 compat 拒绝时按 5 分钟（2.3）。
3. GPT 首步也发「首次缓存」徽标（2.6）。
4. 审核请求计入累计，但只在宿主这次运行内累加，重启或重开后不含之前的审核（3.2）。
5. 新开关 `AICLIENT_RUNTIME_RESPONSES_CACHE_WATCH`（2.5）。

## 6 顺带发现（没在本次处理）

- DSH 引擎的本会话累计不含子代理：DSH 宿主没送「委派」那一份（`liveEvents.ts` 的 `buildPiUsagePayload` 第四个参数恒为 `null`），子代理各自的用量只在自己的会话里。决策 005 的「会话总成本含子调用」在 DSH 上不成立。
- 开发版实测时，一次 `/compact` 之后时间线出现两行 `/compact` 和两条「上下文摘要」，前一条折叠为「已被后续的压缩取代」；假网关只收到一次摘要请求，本会话累计也只计了一次。issue #17 的修法假设每条摘要对应一次压缩，这里像是同一次压缩的实时行与历史行各出了一条，没有查。
