# 决策 173：长会话 prompt cache 反复重建——根因在网关上游分摊；客户端补会话标识、前缀探针、诊断日志与每步缓存视图（GitHub issue #9）

日期：2026-10-10。**状态：§3、§4.5 的十条取舍为用户裁决（2026-10-10）；其余 §4 为自主决定，待用户审批。D、B1、B2、A、C 都已落地（§7）。**

来源：GitHub issue #9（dssaiy，`1.1.0-dsh.8`，Windows 11，claude-opus-5-5 max 档，经公司网关）。一个计划模式长回合约 2.5 小时、89 个模型请求，花了 $86.65，其中缓存写入占 74%。issue 把主因归到「`dsh-compaction-tool-result-pruner` 的修剪视图在请求间不稳定」，建议在客户端保证修剪单调、对齐辅助请求视图、把 goal 移出系统提示词、大文本改走文件，并在界面暴露每步缓存读写。

证据包（会话日志、网关用量 CSV、应用日志）含客户数据，**只留在开发机本地，不入库**。本决策只引用脱敏后的数字。测试夹具 `src/shared/__tests__/fixtures/cacheChain/issue-9.sanitized.json` 只保留事件类型、相对时间、回合 / 步号、每步 token 数、provider / model 名、工具名和内容摘要。

## 1 根因（逐条核实）

所有数字都来自会话日志：每个 `assistant/message` 自带该步 usage，与网关 CSV 的 89 行逐条一致。

1. **修剪插件从没运行过**：会话日志 1308 个事件里没有任何 `compaction/*`。DSH 的修剪本来就是落盘式替换（`compaction/prune` 加替换用的 `tool/result`），即使运行也是单调的。issue 里的「修剪视图 / 全量视图来回翻转」不成立。
2. **89 个请求分成两条互不相通的缓存链**：α 71 个，β 18 个。
   - 每条链内部很稳定：64 次命中都恰好等于同链上一个请求的提示词长度减 2（最后 2 个 token 不进缓存）。
   - 两条链对同一份内容计数不同：
     - 第 2 步请求只有 24,115，比第 1 步的 43,975 还小，可第 2 步的内容严格包含第 1 步；
     - 系统段（工具定义加系统提示词）α 记 36,848，β 记 11,489。
   - **同一个后端不可能这样计数**。
3. **三个只能来自上游的特征**：
   - 思考摘要：α 的回复一次都没有（53/53 为空），β 多数有（14/18）。
   - 思考签名的版本字节：签名 protobuf `[2,1,1]` 字段，α 全是 18，β 多为 17。
   - TTL：我们每个请求只有两个断点（system 末尾、最后一条 user 消息），pi-ai 给两处用的是同一个 `cacheControl` 对象，都是 `ttl: 1h`。可 β 的重建里出现了 5m 写入。
4. **α 会丢弃旧思考块**：
   - 例：第 61→63 步提示词少了 73K，正好是第 59 步那段约 77K 的思考；第 59 步比按追加算的应有长度少了约 89K（净减 36K），正好是第 56～58 步的思考。
   - 后果：每次 β 插进来一步，或 α 丢一次思考，α 都要从系统段之后整段重写；读量回落到 36,848，或第 1 步的 43,973。
   - β 的提示词长度始终单调增长，说明我们每次都发了完整历史（含全部思考块和签名）。
5. **另外有不在网关日志里的请求写过缓存**：第 53 步读到 411,324，第 62 步读到 529,525，都比此前任何一个有记录的请求还大。
6. **成本归因**（$86.65）：

   | 来源 | 金额 |
   |---|---|
   | β 请求 | $23.3 |
   | β 之后 α 的整段重写 | $32.1 |
   | α 丢思考后的重写 | $5.8 |
   | 退出计划模式 | $3.95 |
   | 健康步骤与冷启动 | $21.5 |

   与上游相关的前三项约占 71%。

### 1.1 公司网关（claude-code-hub）为什么会这样

网关是公开的 claude-code-hub（本次读的是 v0.9.7）。

- Claude 请求的会话号**只**从请求体的 `metadata.user_id`（Claude Code ≥2.1.78 的 JSON 串 `{"device_id","account_uuid","session_id"}`，或 legacy `user_<x>_account__session_<id>`）或 `metadata.session_id` 取，请求头一概不看。
- 我们的请求不带这个字段，网关就退回到「前 3 条消息文本的哈希」。这条 Redis 记录 300 秒、创建后不续期（网关代码自己的注释也写着这种做法不可靠），所以会话号至少每 5 分钟换一次，CSV 里 2.5 小时换了 14 次。网关还把这个 `sess_<时间>_<hex>`（不是 UUID）注入转给上游的 `user_id`。
- 客户端自己带了 `user_id` 时，网关不覆盖、直接用作会话号，并按滑动窗口续期。
- 用户实测：官方 Claude CLI 经同一网关缓存完全正常。Claude CLI 恰好每个请求都带固定的 `metadata.user_id`，`session_id` 是 UUID。这和上面的推断一致：上游按会话标识做账号粘性，我们没给标识，就退化成逐请求分配。

## 2 issue 根因分析逐条核对

| issue 的判断 | 核实结果 |
|---|---|
| 主因是修剪插件视图不稳定（约 $50+） | 不成立：修剪从没运行。主因是上游分摊（§1.2～1.4） |
| 辅助 / 重放请求没对齐主视图、两次全量翻转用了 5m TTL | 不成立：没有任何辅助请求（89 个都是主线步骤）。「全量视图」是 β 计入了全部历史思考；5m 来自上游 |
| goal 文本写进系统提示词尾部，审批即全量重建 | 部分成立：重建是真的，但原因是退出计划模式时 DSH 去掉了系统提示词里的计划模式段（`dsh-plan-mode` README 写明了这个 KV cache 代价），goal 文本不在系统提示词里 |
| exit_plan_mode 单步输出 77,659 token | 不成立：77,659 与 67,287 是第 59、63 步的思考（当步调用是 pwsh / grep）；exit_plan_mode 在第 68 步，24,409 token，其中约 15.5K 字符是计划正文 |
| 网关偶发切换上游账号，列为存疑 | 是主因，见 §1.1 |

## 3 用户裁决（2026-10-10）

1. 本轮客户端做三项：前缀稳定探针、生产诊断日志、界面每步缓存读写加告警（界面先出原型）。
2. 网关是公开服务，只拉官方最新版本，**不改 claude-code-hub**；非侵入式的可以，但尽量不动。官方 Claude CLI 配合网关一切正常。
3. 推送、发版、回复 issue 都先经用户同意。

## 4 决定（自主，待审批）

### 4.1 D：按会话发固定的 `metadata.user_id`（主修复）

- **注入方式**：宿主 fetch 层给每个 anthropic-messages 请求追加 `metadata.user_id`，不改 DSH 与 pi-ai。只在请求体没有 `metadata` 时追加，原有字节一个不动。
- **取值**：`{"device_id": sha256("aiclient-device:" + DSH 匿名安装 ID), "account_uuid": "", "session_id": uuidV5(会话键)}`，格式与 Claude Code ≥2.1.78 相同。
- **会话键**：DSH 会话号去掉回退 / 迁移后缀。回退后仍落在同一网关会话；fork 和子代理各自独立；压缩请求也注入。
- **为什么在 fetch 层**：DSH 的 agent loop 会把 `sessionId` 传给 pi-ai，但 pi-ai 只拿它发 `x-session-affinity` 请求头，而且这个开关被 DSH 扣住、不让配置。网关又不看请求头。
- **会话归属怎么到达 fetch**：在 `llm/stream` 瀑布最外层用 AsyncLocalStorage 包住 adapter 的迭代。
- **应急开关**：`AICLIENT_RUNTIME_SESSION_METADATA=0`。不做设置项（理由同 Claude CLI：这是协议字段，不含内容）。
- **实现**：
  - 会话归属：`src/dsh-host/lib/requestScope.ts`。`host.ts` 的 boot 回调在任何插件行加载之前，`provide` 服务 `aiclientRequestScope`，并以 `{ global: true, prepend: true }` 注册 `llm/stream` 监听。
  - fetch 包装：`src/dsh-host/lib/requestTap.ts`，装在 UA 中继之后、第一个 DSH import 之前。
  - 纯函数：`sessionMetadata.ts`。
  - 匿名 ID：`anonymousId.ts`。
  - 开关：Main 的 `FORWARDED_ENV` 透传三个开关。
- **实现取舍**：
  1. **匿名 ID 不加依赖**：`@deepseek-ai/dsh-anonymous-user-id` 只是间接依赖，也不在 `HOST_EXTERNALS` 里。所以照它的约定自己读写 `<DSH home>/.anonymous-user-id`，home 的解析与 `dsh-home-paths` 的 `resolveDshHome` 逐条一致（测试里与真包互读同一文件）。新建文件用 0600 权限。
  2. **purpose 不识别时按 oneshot 处理**：不注入，也不算 agent 请求。
  3. **三个开关都关时**：fetch 不包装，`llm/stream` 监听也不注册，服务照常提供。
  4. **会话键的后缀规则**：
     - 去掉的：回退 `_r<n>`（含旧格式 `.r<n>`）、迁移 `_m<n>`，依据是 `bridge/lineage.ts` 与 `seedSession.ts`；只去一层，因为后缀不会叠加。
     - 保留的：fork（`aiclient-session-fork-<uuid>`）、导入、`_pi` 旧行、子代理（裸 UUID）。
  5. **命名空间常量**：`AICLIENT_GATEWAY_SESSION_NAMESPACE = 767f5ffc-25b7-46e9-892c-9403bedca6e9`，测试钉住。改它等于让每个对话换一个网关会话。

### 4.2 B1：请求前缀指纹

- 同一个 fetch 包装、在关键路径之外计算。按会话把 config / tools / system / 每条消息各取哈希（去掉 `cache_control`，字符串 content 规范成文本块），判断本请求是不是同一会话上一个请求的追加。
- 只在分叉时写一行日志，不含内容和哈希。
- 应急开关：`AICLIENT_RUNTIME_PREFIX_WATCH=0`。
- 日志格式：`[dsh-host] prefix-watch: session=<dsh 会话号> purpose=<agent|compaction|session-title> req=<n> verdict=diverged at=<config field=X | tools index=N | system | messages index=I/N role=R truncated=…>`。
- 实现取舍：
  - 按（会话, purpose）分链，最多 64 条，空闲 2 小时遗忘；
  - 请求体超过 16 MB、超过 64 MB 或解析失败时，该链重置，下一个请求判 `first`；
  - 重试得到的 `same` 不覆盖已有证据；
  - 一次性告警按种类各说一次，从不带请求体或 `error.message`（V8 的 JSON 解析错误会引用输入）。

### 4.3 B2：每步用量链检测

- 纯函数 `src/shared/cacheChain.ts`，判定标准：
  - `lost = 上一步提示词 − 本步读量`，`lost ≥ 1,024` 且（≥ 50,000 或 ≥ 上一步提示词的 20%）算重建；
  - 提示词变短算 shrink；
  - 读量恰好等于更早某一步的缓存长度，算两条链交替的证据。
- 本地原因：系统提示词变化（计划模式切换）、请求头 resume / series / change（模型、推理强度、工具集）、路由变化、压缩、会话续接、闲置超过 TTL。
- 只对 anthropic-messages 路由告警。
- 无本地原因的重建写进应用日志，并随 settled 用量交给界面。
- 应急开关：`AICLIENT_RUNTIME_CACHE_CHAIN=0`。
- **实现取舍**：
  1. **状态放在 bridge 的 `DshHistoryCache`，不放进 `DshHistoryFold`**：缓存与会话同寿命，重开时从日志整份重折叠，所以实时路径和重开共用一条链。`DshHistoryFold` 是共享纯库，还有别的使用方。链出错只丢链，时间线不受影响。
  2. **TTL 间隔按两步「开始」之差计**：失败重试的步，起点挪到最后一次尝试。Anthropic 的缓存从读写它的那个请求开始时起算，长思考的生成时间也算在内。
  3. **request/header 的比较**：
     - 每个请求头都和上一个比 provider / model、推理强度、工具集，所以 `resume` 时换了模型会得到 `['resume', 'model']`；
     - `startsSeries` 也算 `series`；
     - `image/offload` 算 `compaction`。
  4. **settled `usage.updated` 的 `cache` 字段**：只在值得注意时附带（rebuild、shrink，或读到别的链）。除约定字段外，多带 `turn`、`step`、`prevPrompt`，省得界面解析 messageId。cold、warm、turn-shrink 不发。
  5. **前缀证据归属**：证据的 `at` 落在本步「`step/start` 到 `assistant/message`」窗口内，并且不是上一步用过的那条，才算本步的。没有证据表示「不知道」，不表示「没问题」。
  6. **日志**：经 runtime 日志写出，带通道前缀，即 `[aiclient-bridge] [<ch>] cache-chain: …`。另有自检行 `cache-chain: client request diverged without a logged cause …`。
  7. **事件夹具**：按事故日志的脱敏数列钉住总数：219 步，评估 87 步，rebuild 7，shrink 17，无法解释 27，无法解释的丢失 5,305,920 token。只有第 69 步（退出计划模式）判为有本地原因。

### 4.4 A：前缀稳定探针（issue 验收第 1 条）

假网关落盘原始请求体，真宿主跑以下场景：
- 多步带思考的工具循环（含插话、第二轮、压缩）；
- 计划模式审阅转目标；
- 模拟两个上游；
- 重启后重开会话。

逐请求断言只在末尾追加，只允许压缩后和退出计划模式这两处分叉；同时断言 `user_id` 正确且按会话稳定。接进 `dsh-bridge-gate.yml` 作为硬门槛。

实现：
- `tools/request-prefix-probe.ts` 与 `tools/lib/prefixChain.ts`。
- `tools/lib/experiment-host.ts` 新增会话驱动助手。
- 假网关新增：
  - `--capture <dir>`；
  - 日志字段 `userIdFormat`、`userIdSession`、`metadataKeys`；
  - 脚本 `P1-CHAIN`（工具步带三种思考形态，第 2 步输出超过 8,192 字符）；
  - `cacheSim`（单上游，或每 4 个请求有 1 个落到另一个 0.55 倍计数的上游）；
  - 自测 `tools/fake-gateway-chain-selftest.mjs`。

顺带修了两处：
1. **假网关请求体按 UTF-8 解码**（`req.setEncoding('utf8')`）：原来逐块拼字符串，跨 TCP 分块的中文会解成 U+FFFD，探针会因此误报前缀分叉。对照 HEAD 版网关，52 个回复逐字节一致。
2. **experiment-host 的退出等待**：`stopWithin` 不清理 sleep 定时器，每次结束都要空等约 15 秒。改成会清定时器的等待，语义不变。

### 4.5 C：运行面板每步缓存视图

- 先出原型（`evidence/cache-chain-2026-10/`），用户认可后再实现。
- 本轮不做重开会话后的逐步明细：需要新 RPC，重开后只显示本次打开之后的步骤。

**用户裁决（2026-10-10，看过原型后回复「按推荐」）**，覆盖原型里不一致的地方：
1. 「（上一回合）」改称「（最后一步）」，「回合数（本会话）」改称「步数（本会话）」（这几行本来就是最后一个模型请求和请求数）。
2. 缓存命中率改为「缓存读 ÷ 整个提示词」（输入 + 缓存读 + 缓存写）。重建那一步不再显示 100%；全部是写入时显示 0%，不再显示未知。
3. 会话提示：找不到本地原因的重建累计 ≥ 2 次，或累计重写 ≥ 100k 才出现；可以关掉，只对当前会话有效（只存内存）。
4. 长回合只列最近 20 步，更早的收进「查看更早的 N 步」。
5. 分组默认状态：本回合没有异常时收起，有异常时展开；用户手动切换后记住这个选择，对所有会话生效。
6. 复制的诊断信息带每步时刻，不含对话内容。
7. 正常的新回合（turn-shrink）不出徽标。
8. 一步有多个原因时，徽标写主因，悬停列出全部，按「计划模式 > 换模型 > 压缩 > 恢复会话 > 闲置过期 > 其他」排序。
9. 步骤结算后才出行。
10. 本会话组新增「缓存写入（本会话累计）」。

**实现取舍（自主，待审批）**：
- **数据侧**：
  - 结算用量的 `cache` 字段在值得注意的步之外，也发「上一步没缓存、这一步写了缓存」的 cold 步（`write > 0`）。cold 可能带原因，例如换路由之后，这时显示蓝色主因。
  - 新增每步 `rewrite = min(lost, write)`，会话合计新增 `unexplainedRebuilds`、`unexplainedRewriteTokens`。会话提示只看这两项：只读到别的链、没丢缓存的步出橙色徽标，但不算重建。
  - 开启会话标识时带 `gatewaySession`（即发给网关的 `session_id`），供复制诊断用。
  - 缓存链状态版本升到 2。事故夹具新钉 `unexplainedRebuilds` 23、`unexplainedRewriteTokens` 3,792,292。
- **turn-shrink 一律只作说明**：即使带 matched，也不算值得注意、不计数、不写 `upstream cache inconsistency` 日志。原因是上游在新的用户回合剥掉上一轮思考是正常行为，否则健康的上游也会被误报。
- **金样本**：录制场景 `usage` 的第 2 步因此多出 cold 块，`stream.usage.json` 由编排者重录这一份（只多这一块，数字已归一成 0），其余 30 个场景不变。
- **界面**：
  - 逐步数据取自消息元数据注册表（各步按 `dsh-<sid>-t<turn>-s<step>` 归档），只收已结算的步。「当前回合」取最新一个已结算步所在的回合。
  - 闲置时长由相邻两步的开始时刻相减，算不出来时写「闲置超过缓存保留时间」。
  - 分组偏好存在 `aiclient-run-panel`（zustand persist），提示关闭状态只存内存。
  - 提示标题：2 次及以上写「这个会话的缓存多次被重建」；只有 1 次、因为 ≥ 100k 才出现时，写「这个会话的缓存被大段重建」。
  - 「（已校验）」只在每个计入的重建都有 append / same 前缀证据时才写；有 diverged 时改用中性说法。
  - 复制内容用产品名「PiLab Ai」，列出本次运行见过的全部回合，时刻带 UTC 偏移。

## 5 不做

- **修剪单调性、辅助请求对齐**：前提不成立。
- **把计划模式段移出系统提示词**：这是 DSH 的既定设计，按决策 090 默认跟随 DSH。issue 验收第 3 条「goal 创建后首个请求读量不低于上一步」因此做不到；B2 会把这次重建标成本地原因。
- **「大文本改走文件」**：大输出是思考，不是工具参数。max 档在探索阶段很费钱，回复里提醒用户可以用 high。
- **改 claude-code-hub**：见 §3 第 2 条。

## 6 风险

1. **ALS 传播依赖 DSH 内部结构**：DSH 以后如果在 `llm/stream` 和 adapter 之间加了队列，会话归属就会丢。探针在 CI 里能抓到；生产日志里「没有会话归属」会告警一次。
2. **第三方 Anthropic 兼容服务拒收 `metadata.user_id`**：可能性低，Claude CLI 到处都发这个字段。有应急开关；真要按路由关，再用决策 171 的中继头机制。
3. **device_id 是每个 DSH home 的稳定化名**：会发给所有 anthropic-messages 服务，与 Claude CLI 的做法相同。
4. **宿主主线程开销**：一次 JSON 解析加哈希，1 MB 请求体约 10～30 ms。哈希放在关键路径之外，用 contention-regression 观察。
5. **D 修不了网关自身的分流**：比如 endpoint 池轮选、首字节竞速。B2 的日志与「复制诊断信息」给排查留证据。

## 7 验证（2026-10-10，开发机，一次一个进程）

实现代理的定向测试都已通过：
- 第一波库 72 项、构建清单 55 项；
- 请求作用域 22 项，Node 22 下 async_hooks 与 `--experimental-async-context-frame` 两种模式都跑过；
- 请求改写 36 项、匿名 ID 15 项、hostStatic 50 项、DshHostProcess 30 项；
- 缓存链 27 项、piUsage 64 项、historyCache 16 项、cacheChainReport 16 项、liveEvents 38 项、dshSessionRuntime 68 项；
- 假网关自测 21 项。

编排者收口复跑：

| 项目 | 结果 |
|---|---|
| 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`） | 0 错误 |
| `vitest run src/dsh-host` | 50 个文件，1030 项通过，11 项跳过 |
| `vitest run src/shared` | 81 个文件，1820 项 |
| `vitest run Static Scan Wiring` | 79 个文件，819 项 |
| `vitest run scripts src/main/services/agent-host src/renderer/stores/__tests__/dshStreamReplay.test.ts` | 1001 项通过，41 项跳过 |
| `bridge-record.ts --check` | 31 个场景，0 差异，金样本不用重录（录制文件里的用量都是 0，`cache` 字段不出现） |
| `request-prefix-probe.ts`（真宿主） | 21/21 PASS |
| `loop-guard-smoke.ts` | 全部通过 |
| `contention-regression.ts` | 硬门槛全过；软告警 LC-1 RSS 中位 274.4 MB > 260 MB，dsh.5 时就是 318.2 MB，不是本次引入 |

探针（真宿主，42 个请求全部落盘）：
- **S1**（8 步带思考的循环、回合中插话、第二轮、压缩、第三轮）：agent 线 24 个请求是 1 first + 22 append + 1 diverged。唯一的分叉在压缩后第一个请求（`at=messages index=0/4`），宿主的 prefix-watch 同时记了一行。
- **S2**（计划模式 → 审阅「继续规划」 → 「设为目标 · 自动」 → 目标轮）：8 个请求，唯一的分叉在计划批准后的第一个请求（`at=system`），工具集没变。
- **S3**（模拟双上游）：B2 报了 4 行上游不一致，都带 `prefix=append`，其中 3 行带 `matched`。
- **S4**（重启宿主、重开 S1 再跑一轮）：重启后第一个请求就是 append。
- **`metadata.user_id`**：
  - 42 个请求都是 JSON 格式，`session_id` 都等于 `gatewaySessionUuid(该会话)`。这证明会话归属在 Node 24 上端到端到达了 fetch。
  - 跨重启不变；三个会话互不相同；全程只有一个 device_id。
- **其他**：没有「client request diverged without a logged cause」，也没有 request tap 告警；宿主都以 0 退出。
- **耗时与内存**：单次约 14 秒。宿主启动时 VmHWM 约 720 MB 的短时尖峰，比旧文档写的 200～350 MB 高，已写进探针文件头。
- **已知小问题**：报告里宿主 1 的「进程树 RSS 峰值」打印成 NaN。只影响展示，不影响检查，下一波顺手修。

事故复盘：issue #9 的 89 个请求如果当时就有 B2，会在第 2、3、4、6、8、9、10、11 步就报出上游不一致（详见 §4.3 第 7 条）。

### 7.1 界面一波（`233d2f30` 数据侧、`49bfaaf4` 界面）

实现代理的定向测试：
- 数据侧：缓存链 37 项、piUsage 73 项、cacheChainReport 16 项、liveEvents 40 项、historyCache 16 项、dshSessionRuntime 69 项、dshHistory 203 项、构建清单 56 项。
- 界面：渲染层 10 个文件 144 项，含 i18n 覆盖与禁写死中文；新增的模型测试 31 项、复制内容 5 项、挂载测试 9 项。

编排者收口复跑：

| 项目 | 结果 |
|---|---|
| 两套 tsc | 0 错误 |
| `vitest run src/dsh-host` | 1033 项通过 |
| `vitest run src/shared` | 1839 项 |
| `vitest run Static Scan Wiring` | 819 项 |
| `vitest run src/renderer/components/workspace-shell src/renderer/components/chat src/renderer/stores` | 275 个文件，5040 项 |
| `vitest run scripts src/main/services/agent-host` | 751 项通过，41 项跳过 |
| `bridge-record.ts --check` | 重录 `stream.usage.json` 之后 31 个场景 0 差异 |
| 真宿主探针 | 21/21；宿主进程树 RSS 峰值 294 / 283 MB，探针报告的 NaN 已修 |

没有起 Electron 做界面点验，界面效果在测试包里看。

## 8 网关侧（可选，不改 claude-code-hub）

只有升级后仍看到 `cache-chain` 告警时才需要。到时在网关管理界面核对：
- 这些请求的 provider chain（`endpointUrl`、有无 hedge / retry）；
- 该供应商所属 vendor 有几个 endpoint；
- `firstByteTimeoutStreamingMs`；
- provider / key 级的 `anthropicAdaptiveThinking`、`cacheTtlPreference`、请求过滤器。

以上都是配置项，不用改代码。

## 9 用户审批

待审批。
