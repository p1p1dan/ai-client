# 决策 182：Anthropic 请求里的用户消息一律以文本块发出（DA-3）

日期：2026-10-11。**状态：第 1 节为用户裁决，第 2 节起自主决定，待用户审批。**

代码：尚未提交（工作树，HEAD `4e1b8733`）。

来源：[修复后真实网关复测与缓存对比](../evidence/cache-compare-real-gateway-2026-10-11.md) 第 3、5 节（DA-3「每轮第 2 步缓存重写」的触发点）；[dsh.11 验收](../evidence/dsh11-acceptance-real-gateway-2026-10-11.md) 的 DA-3。

修订关系：

- [决策 173](173-prompt-cache-upstream-split.md)（issue #9）的请求钩子（`src/dsh-host/lib/requestTap.ts`）：
  - 在 D（`metadata.user_id`）、B1（前缀监视）之外新增第三部分 U：用户消息一律以文本块发出（第 3 节）；
  - 「一次性请求、作用域外的请求原样发出」改为「只做 U」；
  - 新增应急开关 `AICLIENT_RUNTIME_USER_CONTENT_BLOCKS=0`；三个开关都关时才不包装 `fetch`；
  - B1 的规范化规则改了：字符串与它代表的文本块在**内容**上仍视为相同，但写法变化单列为一类分叉（第 4 节）。
- [决策 181](181-summary-request-reasoning-level.md)：摘要请求同样经过 U，与对话请求写法一致，「摘要请求复用对话缓存」的前提更完整。

## 1 用户裁决

用户要求拿官方 SDK 做对照，查清 DA-3「回合第 2 步缓存重写」从哪里来。对照实验见证据第 2～5 节，结论：

- 触发点在我们的请求字节。同一网关会话、同一上游里：
  - B（官方 SDK 逐字重放应用的请求）：恰在每轮第 2 步丢 323～1,054 token；
  - Bn（只把用户消息固定成块形式）：一个不丢；
  - C1（Claude Code 写法）：一个不丢。

修法本身（第 2 节起）是自主决定。

## 2 机理（逐条核实，pi-ai 随宿主安装的版本）

| 环节 | 位置 | 事实 |
|---|---|---|
| 较早的用户消息 | `@earendil-works/pi-ai/dist/api/anthropic-messages.js:935-940` `convertMessages` | 字符串内容原样以字符串发出（空白串丢弃） |
| 最后一条用户消息 | 同文件 `:1066-1085` | 带 `cache_control` 时，字符串改成 `[{type:'text', text, cache_control}]` |
| 结果 | — | 本回合的用户输入第 1 步是带断点的块，第 2 步起（第一个工具结果之后）变回字符串；每个回合的第 2 步都是「上一请求最后一条第一次不再是最后一条」 |
| 上游行为（推断，见证据 Bn） | — | 上游计算前缀时把两种写法视为相同（Bn 首步读到了 B 写的缓存），但**写在块上**的缓存，在这个块变成字符串之后再也找不到 |
| 官方要求 | https://code.claude.com/docs/en/llm-gateway-protocol | 网关「不要把块形式的内容转成字符串」；Claude Code 每个请求都保持块形式，只移动断点 |
| 监视盲点 | `src/dsh-host/lib/requestPrefix.ts`（决策 173 B1） | 规范化时把字符串当成它代表的文本块，于是一直报「纯追加」 |

## 3 修法：宿主请求钩子统一写法（U）

### 3.1 做什么

- 新增 `src/dsh-host/lib/userContentBlocks.ts` 的 `withUserContentBlocks(body)`，是纯函数：
  - 只改 `role: "user"` 且 `content` 是字符串的消息，改成 `[{type: "text", text: <同一字符串>}]`；
  - 消息的其余键、键序、其它消息、所有 `cache_control` 都不动。不动的还有 assistant / `tool_result` 的内容，以及 pi-ai 注入的 `{role: "system", content: [], output_config}` 条目；
  - 空串和全空白串不动（API 拒绝没有文本的文本块；pi-ai 本来也不发）；
  - 没有可改的消息时返回 `undefined`，调用方原样发出。对自己的结果再调用一次也是 `undefined`（幂等）。
- `src/dsh-host/lib/requestTap.ts` 的处理顺序：
  1. 解析请求体；
  2. U；
  3. B1 比较**实际发出的**请求体；
  4. D 在新文本上追加 `metadata.user_id`。
- 适用范围是钩子认得的每个 anthropic-messages 请求：POST 到 `…/messages`，带 `anthropic-version` 头，判断沿用 `isAnthropicMessagesRequest`。
  - 网关的 Claude 路由与自定义的 Anthropic 兼容服务商都包括在内；
  - 所有用途都包括：对话的每一步、摘要、会话标题、单次补全，以及不在任何请求作用域里的请求；
  - OpenAI Responses / Chat 等协议的请求不经过这里。
- 改写后用 `JSON.stringify` 重新序列化。Anthropic SDK（pi-ai 用的 0.123.0）本来就是 `JSON.stringify(body)`，所以除了被改的 `content`，每个字节与原文相同，单测逐字核对过。
- 失败安全：
  - 请求自带 `Content-Length` 时 U 与 D 都不做，警告一次；
  - 超过 64 MB、不是 JSON、任何异常时，原样发出。
- 开关 `AICLIENT_RUNTIME_USER_CONTENT_BLOCKS=0`：Main 转发（`dshHostEnvironment.ts` 的 `FORWARDED_ENV`），用于对照实验或应急。
- 宿主启动行改为 `request tap: session metadata on, prefix watch on, user content blocks on`。

### 3.2 为什么放在宿主钩子，而不是给 pi-ai 打补丁

- 钩子已经在改写这个请求体（决策 173 的 `metadata.user_id`），失败安全、开关、单测、真宿主测试都现成。
- 没有对象层的正式钩子可用：
  - pi-ai 有 `onPayload`（`anthropic-messages.js:379`），但 `dsh-llm-pi-ai` 调 `streamSimple` 时只传 `temperature` / `maxTokens` / `sessionId` / `signal` / `headers`，见 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1877-1884`；
  - 要用它就得同时改 DSH 和 pi-ai 两层。
- 补丁要跟着 pi-ai / DSH 的每次升级重打，宿主的安装与打包流程里也没有现成的补丁机制。钩子只依赖 Anthropic 的线上协议，pi-ai 怎么改写法都不受影响。
- 代价：
  - 请求路径上多一次 `JSON.stringify`（几百 KB 级，毫秒量级）；
  - DSH 会话日志与遥测里记录的仍是 pi-ai 的写法。这不影响缓存，因为上游只看发出的字节。

### 3.3 为什么全部改成块，而不是让最后一条保持字符串

- 一条消息要在各个请求里写法不变，只有「全块」或「全字符串」两种选法。
- 「全字符串」做不到：断点（`cache_control`）只能挂在块上，pi-ai 必须把最后一条做成块。所以唯一能一以贯之的是全块。
- 这正是证据里 Bn 的写法（同一上游上一个不丢），也与 Claude Code 的写法（C1）和网关文档的要求一致。
- 块形式不额外计费：Bn 与 B 首步提示量相同（10,389）。
- 每个服务商本来就收块形式的用户内容：带断点时的最后一条、带图片的消息、工具结果都是块数组。所以不新增「服务商不认」的风险；万一有，用开关关掉。

## 4 前缀监视：写法变化单列

- `requestPrefix.ts`：
  - `PrefixUnits` 增加 `forms`（每条消息 `string` / `blocks`）与 `systemForm`；哈希规则不变，字符串仍按它代表的文本块计算。
  - `comparePrefix` 按前缀顺序报第一处变化：config → tools → system → **system 的写法**（`system-form`）→ 消息。在第一条内容变化的消息**之前**，若有消息内容相同、写法不同，报 `message-form`，带 `index`、`role`，以及现在的写法 `form`。
  - 只移动 `cache_control` 仍不算分叉。
- 共享类型 `ClientPrefixVerdict`（`src/shared/types/requestScope.ts`）的 `at` 增加 `system-form` / `message-form`，并增加 `form` 字段。
- 日志行：
  - `prefix-watch: … verdict=diverged at=message-form index=1/4 role=user form=string`；
  - B2 的 `cache-chain: client request diverged without a logged cause … at=message-form …`（`bridge/cacheChainReport.ts`）。
- 运行面板只收到分叉的种类（`diverged`），不用改。
- 取证工具共用同一套规则，旧抓包会显出写法变化：`tools/lib/prefixChain.ts`、`request-prefix-probe.ts`、`bridge-record.ts` 的 compact-instructions 场景。例如 10-11 证据的 A 组会是 6 次 `message-form`，不再是 20 次纯追加。
- U 打开时，宿主自己的链上不会再出现写法变化。所以一行 `message-form` 表示别处改了写法，可能是：
  - pi-ai 升级换了序列化；
  - U 被开关关掉；
  - 请求超过 64 MB，或自带 `Content-Length`，U 跳过了。
- system 也按同样规则处理，为了对称。pi-ai 的 system 一直是块，不会产生噪声。

## 5 对已有会话与缓存的影响

- 升级后已有会话的第一个请求：
  - 之前的请求里，较早的用户消息是字符串，现在是块。上游计算前缀时把两种写法视为相同（证据 Bn 第 1～5 步读到了 B 写的缓存），而上一请求的断点挂在最后一条上，那一条本来就是块。所以预期多半仍能读到。
  - 最坏情况是不容忍切换的上游：只这一次，退回到上一个仍可读的断点，重写一段；此后写法不再变，每步都是纯追加。
- 宿主重启后，前缀监视的链从 `first` 开始，不会误报 `message-form`。
- 如果那一步重写，B2 可能写一行 `upstream cache inconsistency … prefix=first`，只此一次。
- 之后：在 Y / Z 类上游上，每轮第 2 步不再丢缓存。Z 类首步多出的提示与约 32k 的回退在客户端之外，本决策不处理（证据第 4、5 节）。

## 6 验证（2026-10-11，开发机，一次一个测试进程，先看 `free -m`）

- 单测：
  - `src/dsh-host/lib/__tests__/userContentBlocks.test.ts`（新，7 项）：
    - 字符串改块且文本逐字相同；
    - 键序不动，序列化结果只多出块的外壳；
    - 空串与全空白串不动；
    - 已是块的不动（带断点、带图片）；
    - assistant、`{role:'system', content:[], output_config}`、未知角色不动；
    - 幂等；
    - 非请求体返回 `undefined`。
  - `requestTap.test.ts` 新增「U」一组：
    - pi-ai 的字符串发成块，再追加元数据；
    - 摘要、标题、单次补全、无会话、作用域外都改写；
    - **回合第 1 步 → 第 2 步：去掉 `cache_control` 后，第 2 步的请求体逐字以第 1 步（到其最后一条消息为止）开头**，监视判为 `append`；
    - 开关为 `0` 时原样发出，监视报 `message-form index=1/4 role=user form=string`；
    - 自带 `Content-Length` 时两者都不做；
    - 经 Node 自身 `fetch` 到本地服务器，长度正确。
  - `requestTap.test.ts` 原有用例：D / B1 的请求体改用块形式（U 无事可做），逐字核对照旧。
  - `requestPrefix.test.ts`：
    - 块形式下断点移动仍是 `append`；
    - pi-ai 原样的第 2 步报 `message-form`，反向（字符串→块）也报；
    - 前缀里先出现的那处变化胜出；
    - system 写法变化报 `system-form`；
    - 日志字段。
  - `cacheChainReport.test.ts` 新增两类的日志字段。
  - 开关名与转发：`requestScope.test.ts`、`DshHostProcess.test.ts`、`hostStatic.test.ts`。
- 变异检查：
  - 让 U 失效（`withUserContentBlocks` 的调用反置）、去掉写法比较各一处，`requestTap` / `requestPrefix` 共 7 项失败；
  - 用备份恢复，`cmp` 一致。
- 真宿主集成测试（新）`src/dsh-host/__tests__/userContentBlocks.integration.test.ts`（`AICLIENT_DSH_INTEGRATION=1`，本地假网关抓包，两个宿主先后跑）：
  - `[182-I-1]` 默认开：
    - 一轮工具回合（2 步）、一轮文本回合、`/compact`，共 4 个请求，没有一条字符串用户内容；
    - 工具回合第 2 步逐字以第 1 步开头（不计断点）；
    - 宿主自己的规则下各通道只有 `first` / `append`，宿主没有 `prefix-watch` 行。
  - `[182-I-2]` 开关为 `0`：
    - 抓到 pi-ai 原样的字符串；
    - 宿主写出 `prefix-watch: … req=2 verdict=diverged at=message-form … role=user form=string`，即本决策要修的现象在真宿主上复现，监视也认得出来。
- 门禁：
  - 两套 tsc 通过；
  - 改动文件 biome 无问题；
  - `bridge-record.ts --check` 36 个场景 **0 差异**（exit 0）；
  - `vitest run Static Scan Wiring` 见交付报告。

## 7 金样本

不需要重录：

- 录制只记 RuntimeEvent、DSH 会话事件与 RPC 答复，不记请求体。DSH 会话日志里仍是 pi-ai 的写法。
- compact-instructions 场景读抓包算前缀：U 打开后摘要请求与上一步写法一致，仍是 `append`。

## 8 风险与真实网关要复测的点

1. **复测 DA-3**：在 Opus 5.5 会话里做多轮工具调用，检查以下几点：
   - 每轮第 2 步只丢 2～4 token，B 那样的 323～1,054 不再出现；
   - 抓包里没有 `blocks→string`；
   - 宿主启动行带 `user content blocks on`；
   - Main 日志里没有 `at=message-form`。
2. **自定义 Anthropic 兼容服务商**：块形式是协议本身的写法，各服务商已在收（第 3.3 节）。若有服务商拒绝，先用开关确认，再另议按路由豁免。
3. **pi-ai / DSH 升级**：若 pi-ai 改了写法（例如自己也全用块），U 自然无事可做；若改出新的写法变化，监视会报 `message-form`。
4. **升级后的一次性重写**：第 5 节，最坏一次。
5. **Z 类上游**：首步多出的 1.2 万～2.7 万 token 与约 32k 回退，本决策不处理，仍待转网关管理员。

## 9 用户审批

- [ ] 第 3.1 节：在宿主请求钩子里统一写法；作用于所有 anthropic-messages 请求（含单次补全与作用域外的请求）；带开关
- [ ] 第 3.2 节：放在宿主钩子，不给 pi-ai / DSH 打补丁
- [ ] 第 3.3 节：全部用户消息改成块（不留最后一条为字符串）；空串与全空白串不动
- [ ] 第 4 节：前缀监视把写法变化单列为 `message-form` / `system-form`，system 一并处理
- [ ] 第 5 节：接受升级后已有会话最坏一次的缓存重写
