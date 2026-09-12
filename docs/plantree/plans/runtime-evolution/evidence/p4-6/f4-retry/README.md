# F4 重试 · 真实 HTTP 上的四条路

Role: evidence。日期：2026-09-11。对应[执行顺序](../../../README.md#执行顺序)第 5 批（P4-6 收口）第 3 项，
以及[现场缺陷与修复](../../../README.md#现场缺陷与修复)里的 F4 行。

现场（test.11，加密 Windows）交回的原话是「503 不重试直接失败」。
[定性](../../../../2026-09-09-gui-defect-decisions.md#f4--503-不重试直接失败)是**漏搬**：
native runtime 当时根本没有自有重试层，所谓「不重试」只是 SDK 默认值的结果。
重试层已于 2026-09-09 落地（`27d4b7be`），但任务树上一直挂着「现场未触发」——
代码在，没人见过它真的跑起来。这份记录补的就是这一项。

## 退避节奏（用户 2026-09-11 定）

**失败 → 等 3s → 等 10s → 等 30s**，三次重试、四次尝试，持续故障时用户总共等 43 秒。

改之前是两套倍增公式（网关故障 1s/2s/4s/8s，限流从 2s 起加抖动），首次失败后一秒就
再打过去——用户的原话是「不要太频繁」。现在两条预算共用一条写死的阶梯
（`PROVIDER_RETRY_DELAYS_MS`），读代码不用再心算 `initial * 2 ** n`，改节奏就是改三个数。

两条预算仍然**各记各的次数**：一次 429 风暴不会把后面遇到网关故障时的额度吃掉。
限流那条保留正抖动（429 会同时打到所有会话，不抖就会整齐地一起回来、把风暴复现一次），
网关故障那条不抖。服务端给了 `Retry-After` 时一律听服务端的，上限 30 秒。

## 为什么不能拿现成的单测交差

`src/runtime/__tests__/agentLoop.test.ts` 里确实有一条重试用例，但它用 pi-ai 的
`fauxProvider` 抛一个 `new Error('503: service unavailable')`。那证明了「流还没开始
就失败时会重来一次」，可它走的是**按异常文本分类**那条路。

真实网关交回来的是一个带状态码和响应头的 HTTP 响应，`classifyProviderFailure`
读的是 status 和 `Retry-After`——是另一段代码。现场那条失败就发生在真实 HTTP 上，
所以点验也得发生在真实 HTTP 上。

## 做法

`node scripts/run-f4-retry-probe.mjs`（需要 Node 24：`out-node-runtime/node --experimental-strip-types`）。

起一个本地 HTTP 服务假扮 Anthropic Messages 网关，按剧本逐次返回 503 / 429 / 正常
SSE；再用**真的** `createRuntime` 指过去——临时 agent 目录里放一份 `models.json` +
`auth.json`，走的是 `readPiCatalog` 那条真路径，和应用读用户模型配置是同一段代码。

不起 Electron。要验的是 runtime 这一层，而这台机器上少起一次 Electron 是实打实的。

**判据同时看两处**：trace 里的 `provider_retry` 备注，以及假网关自己数到的请求次数。
只看 trace 的话，一个「记了日志但请求根本没发出去」的重试和一个真发出去又失败的
重试长得一模一样。

## 结果：四条路全部通过

原始输出 [f4-retry-report.json](f4-retry-report.json)。

| 场景 | 网关剧本 | 实到请求 | trace 里的重试 | 结局 | 耗时 |
|---|---|---|---|---|---|
| 重试后成功 | 503 → 503 → 200 | 3 | `PROVIDER_ERROR` 第 1 次等 3s、第 2 次等 10s | 成功，正文 `recovered` | 13.1s |
| 预算耗尽 | 一直 503 | 4 | 3 条，3s → 10s → 30s | 失败，`stopReason: error`，报错带网关原文 | 43.0s |
| 429 限流 | 429（`Retry-After: 1`）→ 200 | 2 | 1 条 `PROVIDER_RATE_LIMITED`，等 **1s** | 成功，正文 `after rate limit` | 1.0s |
| 退避中取消 | 一直 503，第 400ms 时 abort | 1 | 1 条（记下了本来要等 3s） | `stopReason: aborted`，错误码 `aborted` | 0.4s |

三处值得单独点出来：

- **两条预算是分开的**，不是一条。429 走 `PROVIDER_RATE_LIMITED`，网络/网关故障走
  `PROVIDER_ERROR`，一次 429 风暴不会把后面遇到网关故障时的额度吃掉。
- **429 那一次等的是 1 秒，不是 3 秒**。阶梯第一档是 3s，实际等了 1s，正是服务端
  `Retry-After: 1` 的值——说明服务端节奏确实被采纳，而不是我们自己那把尺子。
- **取消是立刻生效的，不是等梯子走完**。第 400ms 取消，整轮 401ms 结束，网关只收到
  1 个请求。如果 abort 没能打断退避里的 `sleep`，这一格会是 43 秒。

## 边界：这一层管到哪为止

只接管**流开始之前**的失败。已经 `start` 的流原样透传——中途换掉一条半流完的
assistant 消息属于 mid-stream 恢复，需要 loop 的消息状态，参考实现（PI-Desktop）
同样把它留在这一层外面。所以「回答写到一半断了」不在本次四条路里，也不该拿这份
记录去回答它。

## 还没验的

- **没在 GUI 里看一眼用户侧长什么样**：重试期间界面显示什么、预算耗尽后错误卡的
  文案是否可读。这份记录只到 runtime 边界为止。
- **没在加密 Windows 上复测**。按用户 2026-09-11 的规矩，能在开发机做完的先做完；
  F4 的加密机复测并入最后一次上机。
- **F7d「GPT 渠道耗时极长」**的关联未验证。定性时怀疑它源于 SDK 自带阶梯，而本层
  已把内层流固定成 `maxRetries: 0`，但那条用的是 openai-responses 渠道，本探针用的
  是 anthropic-messages，不能互相替代。
