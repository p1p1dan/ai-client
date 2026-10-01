# 决策 146：P1-5 真实网关验证的顺手修（GW-2、GW-4、GW-6、GW-8、GW-18，GW-16 调查）

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-5 真实网关验证证据](../evidence/p1-5-real-gateway-2026-09-30.md) 的 GW-2、GW-4、GW-6、GW-8、GW-13、GW-16、GW-17、GW-18；
- 用户裁决（2026-09-30，经编排者转达）：GW-1（China 组 503）是网关上游问题，不改客户端；worktree 先留着，不动 GW-7；其余几条顺手修；
- [决策 140](140-p1-7e-e2b-choices.md)（流闸门的重试否决、失败 / 停止回合的注记）、[决策 090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）、T092（时间线已在内存里的对话点开不重读历史，`activateSessionStart.ts`）。

改动留在工作区，由编排者复跑后提交。没有起 Electron、没有连真实网关；模型请求只发往本地假网关。**第 2、3、9、15 条请重点审批。**

## 落地了什么

- 共享：`shared/dshFailureCodes.ts`（新码 `GATEWAY_NO_UPSTREAM`，按文字认出）、`shared/dshModelPlan/build.ts`、`tables.ts`、`types.ts`（`maxTokens` 上限、诊断原因 `max_tokens_clamped` 与 `detail`）、`shared/dshHistory/projection.ts`（停止占位行带直播 id）、`shared/i18n.ts`（文末一块 3 条中英）。
- 宿主：`dsh-host/bridge/retryVeto.ts`（只改注释，否决条件来自共享函数）；验证工具 `tools/fake-gateway.mjs`（新脚本 `P1-NOUP`；每条请求日志新增 `cacheControl` 计数）、`tools/loop-guard-smoke.ts`（宿主 A 新增 `e1NoUpstreamNotRetried`）。
- Main：`services/piModelConfig/dshModelPlan.ts`（「left out of the plan」日志打印 `detail`）。
- 渲染层：`components/chat/sessionFailure.ts`（新卡片）、`components/source-control/CodeReviewModal.tsx`、`components/workspace-shell/useSyncChatWorkspaceTree.ts`、`surfaces/GitSurfaceView.tsx`、`hooks/useGitRepoAppearance.ts`（新）、`hooks/gitRepoQueryKey.ts`（新）、`stores/chatSessions.ts`。
- 没有改 `@deepseek-ai/`、`@earendil-works/` 的包文件，没有改用户的 models.json，没有改金样本。

## 规则

### GW-2：网关明确说「没有可用上游」时不自动重试

1. **对照 1.0.x**（`origin/main` 的 `src/runtime/plugins/agent-loop/providerErrors.ts`、`providerRetry.ts`，只读）：所有 ≥ 500 的状态都归为可重试的 `PROVIDER_ERROR`，按 3 / 10 / 30 秒重试 3 次，对 `no_available_providers` 没有任何特判。也就是说 1.0.x 同样会重试，而且等得更久（约 43 秒）。本条是在 DSH 的重试上新加一个否决，不是回到 1.0.x 的做法。
2. **判定依据（只认网关自己说的话，三种标记任一，不分大小写）**：
   - `no_available_providers`（网关错误体的 type / code，整词）；
   - 英文句 `No available providers`（整词）；
   - 中文句「所有供应商不可用」或「所有供应商暂时不可用」。
   前两种表示网关在这一次请求里就把全部上游过滤掉了（R2 原文：17 个上游里 7 个 disabled、6 个 format_type_mismatch、4 个 model_not_allowed，`totalAttempts: 1`），几秒后重试面对的还是同一份配置。第三种表示网关在这一次请求里已经把全部供应商轮换过一遍，客户端再按退避重试 3 次只会把网关流量放大到 4 倍（R8 那次 Grok 4.6 一共等了 43.5 秒）。
3. **边界：普通 5xx 照旧重试。** 只有 503、只有 `service_unavailable_error`、只有「Service Unavailable」「upstream timed out」，都不算，仍按 `SERVER` 由 DSH 自动重试。三种标记都不是 DSH 自己会写的词。同一段文字里同时出现流闸门标记时，流闸门优先。
4. **为什么要认英文句**：第一版只认 `no_available_providers`，用真宿主冒烟一跑，网关只收到这一种 503 却被重试了 225 次（宿主 A 的路由是 `always` 模式，200 毫秒退避，90 秒内）。原因是 Anthropic SDK 遇到顶层带 `message` 的错误体时只保留 `message`，`type` 字段丢了，失败文字只剩 `503 No available providers (…)`。在 openai-completions 路由上（R2 的 China 组）原文是整段 JSON，token 还在。补上英文句后：1 次请求、0 次重试、32 毫秒收尾。
5. **失败卡**：新码 `GATEWAY_NO_UPSTREAM`。
   - 标题：「公司网关目前没有可用的模型服务」。
   - 原因：「公司网关答复：它后面的模型服务目前都无法处理这个请求，请求没有送到模型。」
   - 提示：「马上重试只会得到同样的答复，所以没有自动重试。请换一个模型或稍后再试；如果一直这样，请把错误详情转给网关管理员。」
   - 动作与流闸门的卡一样：保留按钮，但按钮写「仍然继续」，提示句和按钮同时显示。稍后再试可能就好了，所以按钮有用；但旁边必须说清立刻重试多半还是失败。
   - 重开会话后的注记沿用决策 140：「这一轮没有完成：公司网关目前没有可用的模型服务，没有保存任何回复。」
6. **详情保留原文，包括 `cch_session_id`。** 卡片提示用户把详情转给网关管理员，这个会话标识正是管理员在网关日志里查这次请求要用的。它只显示在本机界面上（DSH 会话日志本来就记了原文），不进仓库。仓库里的测试与假网关只用编造的值。
7. 否决仍挂在 `agent/request-error` 的最前面（决策 140 第 25 条），管住宿主里的每一个 agent，子 agent 也在内。

### GW-4：模型计划给 `maxTokens` 设上限

8. **DSH 压缩怎么用这两个值**（`dsh-compaction-basic` 的 `resolveCompactSpec`）：
   - 消息预算 = `contextWindow` − 预留的回复 token（取请求头的 `maxTokens`，没有就取计划里声明的 `maxTokens`，都没声明就是 0）；
   - 压力预算 = 消息预算 − 余量（默认 65536）；
   - 触发阈值 = min(0.8 × 窗口, 压力预算)；
   - 保留尾部 = 0.16 × 消息预算，必须小于触发阈值。
   `maxTokens` 等于窗口时消息预算是 0，DSH 直接报错，不再自动压缩（GW-4 原文）。
9. **规则**：计划里某一行同时声明了 `contextWindow` 和 `maxTokens`，并且 `maxTokens` 大于窗口的一半时，计划改发窗口的四分之一（向下取整），同时记一条诊断：`grok/grok-4.7 maxTokens: max_tokens_clamped (500000 -> 125000)`。诊断原因是新增的 `max_tokens_clamped`，字段级诊断新增可选的 `detail`，Main 的「left out of the plan」日志会把它打出来。不改 models.json。
10. **为什么是「超过一半」和「四分之一」**：
    - pi-ai 自带目录有 1354 行。主流供应商的真实输出上限大多不超过窗口的一半（o3 是 100k / 200k，GPT-5.4 是 128k / 272k）。超过一半的有 337 行，其中 176 行 `maxTokens` 大于或等于窗口（xai 的 grok-4.5 / 4.6、mistral、moonshot 等），这是目录把窗口抄进了 `maxTokens`。另外 161 行在一半到一倍之间，例如 zai 的 glm-4.7（131072 / 204800）；这类行按 DSH 的默认余量算，保留尾部不小于触发阈值，压缩同样不合法。
    - 被判为这种错误时，四分之一取自 DSH 自家参考路由的比例（DeepSeek：1M 窗口预留 256k）。
    - 500k 的 Grok 夹到 125k 以后，压缩阈值约 309k，保留尾部约 60k。
11. **对请求的影响**：这个值也是请求的 `max_tokens`。pi-ai 本来就会把它夹到「窗口 − 当前上下文 − 4096」，所以原来的 500000 也不会真按这个数发出；夹到 125000 后，单次回复上限是 125k，够用。
12. **未覆盖**：
    - 没声明 `contextWindow` 的行不判。DSH 可能从 pi-ai 自带目录里取到窗口，计划这一层看不到。
    - 不到一半但窗口很小的行（例如 128k 窗口配 64k），DSH 的压缩照样算不出预算。这是 DSH 默认余量 65536 本身的限制，跟随 DSH，不处理。

### GW-6：自动模式下的代码审查标题

13. 自动模式不存模型 id，标题原来显示「代码审查()」，括号是空的。现在显示「代码审查(自动)」：「自动」是 AI 设置页对同一选项的叫法（已有词条 `Automatic`）。括号保留，和指定模型时「代码审查(claude/claude-sonnet-5-5)」的格式一致。指定模型时仍显示原始 id（GW-6 的后半句），本次没改，列为遗留。

### GW-8：`git init` 之后 Git 面板及时刷新，worktree 日志不再刷屏

14. **根因（证实）**：
    - 「这个目录是不是 Git 仓库」是 React Query 的缓存（`folder:checkType`，staleTime 30 秒）。`git init` 之后没有任何东西重新问一遍，只有窗口重新获得焦点（refetchOnWindowFocus）或网络恢复时才会重取。
    - 日志重复：`useWorktreeListMultiple` 每次渲染都重建 `errorsMap`，派生树的 `diagnostics` 也随之每次新建。两处 `useEffect` 依赖的是对象引用，所以每渲染一次就打一遍。
15. **改法**：
    - Git 面板正在显示、而且显示的是「不是 Git 仓库」时，每 5 秒重问一次同一个缓存键（`gitRepoQueryKey`，工作区树和面板共用）。节奏与面板其他轮询相同，窗口空闲时停。
    - 答「是」以后，工作区立即变成 Git 工作区，面板跟着切换，并刷新这个仓库之前失败的 worktree 列表，让分支也显示出来。
    - 面板隐藏或判定已变时不再问。最迟 5 秒刷新。
    - 不做 `.git` 文件监视，理由与 `useGitHeadSignature.ts` 相同：不新增主进程生命周期。
16. **日志**：两处都按内容签名去重。同一个失败只打一次，内容变了（换了错误、换了仓库）才再打。

### GW-18（连带 GW-13）：被打断的那一轮重开后按「已停止」收尾

17. **根因（证实：读代码，并用测试复现）**：
    - 直播的 Stop（包括登出时 Main 自己发的 `forced`）只给那条空的 assistant 消息打上 `stopCause`，不产生注记。注记只在历史回放时产生（决策 140 第 2 条）。
    - 时间线已在内存里的对话，点开时按 T092 不重读历史。所以重新登录后切回去，看到的仍是直播留下的空消息，只剩「已工作 1 秒」。
    - **与 GW-13 无关**：bridge 的历史缓存读的是会话日志本身（`observeSession(…, { projectionMode: 'none' })`），不读 DSH 的投影缓存。
    - 回放后还有一个缺口：历史的停止占位行不带 `liveMessageId`，直播那条空消息又没有可比对的文字，合并时两条都会留下。回合末尾就不是注记，「完成于」会重新出现。
18. **改法**：
    - **直播**：收到 `session.stopped`（`no_active_turn` 除外）时，如果最新一条用户消息之后的 assistant 消息全是空的，就把最后一条空消息原地改成回放会产出的同一行：system、`turnEnd: stopped`、incomplete、`stopReason: aborted`、`stopCause: user_stop`，块里放英文兜底句。时间线于是立刻显示「这一轮已停止，没有保存任何回复。」，不写「完成于」；切走再切回也一样。回合里已经保存过内容的，照旧只打 `stopCause`，历史那边也不会加注记。
    - **投影**：停止占位行带上本回合最后一次 `assistant/attempt` 的直播 id（`dsh-<会话>-t<回合>-s<步>`，也就是 bridge 为那次请求打开的那条消息）。之后任何一次回放都按 id 用历史行取代直播那一条，不会出现两条注记。
19. **这条对普通 Stop 也生效**：首字之前点 Stop，直播时也会立刻显示「这一轮已停止」，不再只有「已工作 N 秒」。这与重开后看到的一致（决策 145 处理问题 43 时定的「重开前后读起来一样」）。请重点审批。
20. **没有选的做法**：
    - 点开 disconnected 会话时重读历史：违背 T092；而且 preview 走 `branch` 模式整桶替换，会丢掉只在直播里有的东西（Stop 留下的输出尾部、「· 已允许」尾注）；每次点开还要拉起宿主。
    - 改宿主关停顺序。
21. **GW-13 不修，理由**：
    - 这是 DSH 宿主关停时的通用现象。本次 bridge-smoke 每次优雅关停，都会对早已空闲的会话报同一条警告（`turn/end write … flush on a closed handle`），不只是登出时。
    - 写缓存失败在 DSH 的设计里是 fail-soft 的：缓存「只会过期、不会错」，下次冷读会把缓存之后的事件补折叠并写回。本仓读历史也不经过这份缓存。
    - 要消掉这条警告，得在 `fiber.dispose()` 之前先收掉所有会话并等缓存写完（改宿主关停顺序，会拖慢登出），或者等上游调整关停顺序。列为遗留。
22. **未覆盖**：
    - 请求还没发出（没有 `assistant/attempt`，直播也没有 assistant 消息）就被停的回合，直播仍只显示「已工作 N 秒」，要到回放后才有注记（不会重复）。
    - 失败回合有同样的 id 缺口：直播已经打开空消息，回放后会和失败注记并存。不在本次范围，记为新问题。

### GW-16：`cache_control` 数量（调查，不改代码）

23. **结论（证实）**：我们的 anthropic-messages 请求最多带 3 个 `cache_control`，数量与对话长短、工具调用、图片、技能、插件、子 agent、压缩都无关：
    - system 1 个：DSH 把所有系统段拼成一个字符串（`dsh-system-prompt` 的 `renderPrompt`），pi-ai 只发一个 system 块；
    - tools 1 个：最后一个工具；
    - messages 1 个：最后一条 user 消息的最后一个块。
    一次性补全没有工具，是 2 个。TTL：`promptCacheTtl` 默认 1h，对应 `cacheRetention: long`，即 `ttl: 1h`。DSH 自己不加任何缓存标记。
24. **实测**：假网关的每条请求日志新增 `cacheControl` 计数（只记数量和位置，不记内容）。bridge-smoke 一共 43 次请求：40 次是 system 1 + tools 1 + messages 1 = 3，3 次补全是 2，最多 3，顶层 0。
25. **唯一的例外**：key 含 `sk-ant-oat`（OAuth）时，pi-ai 走 Claude Code 身份分支，system 分成两块、各带一个，合计 4，仍不超过 Anthropic 的上限。公司网关的 key 是不是这种格式，我们没读（不读凭据）。
26. **推断**：`cache_limit` 不是 Anthropic 的原生错误（原生是 `invalid_request_error` 加 "A maximum of 4 blocks with cache_control…"），而是网关自己的校验。同一模型、同样结构的请求，R2 成功、R8 失败，说明结果不只由请求体决定。可能的原因：网关不同上游的阈值不同，网关自己注入了断点，或者按账号 / 会话累计计数。
27. **本仓不改**：我们的请求在 Anthropic 上限之内。可选的降级办法（待用户决定）：在计划里给 claude 路由设 `compat.supportsCacheControlOnTools: false`（白名单已开放），去掉 tools 上那一个，降到 2 个。system 的断点已经覆盖 tools 前缀（Anthropic 的缓存前缀顺序是 tools → system → messages），代价很小。但网关的阈值不明，这样做可能没用。建议把 GW-16 连同 GW-17 带给网关管理员，确认 `cache_limit` 的阈值与计数口径，以及网关会不会注入断点。

## 测试

- 新增文件：
  - `source-control/__tests__/codeReviewModalTitle.test.ts`（挂载，3）
  - `hooks/__tests__/gitRepoAppearanceWatch.test.ts`（挂载，3）
  - `workspace-shell/__tests__/workspaceTreeLogOnce.test.ts`（挂载，2）
  - `chat/__tests__/turnStoppedLiveNote.test.ts`（挂载，1）
- 追加：
  - `shared/__tests__/dshFailureCodes.test.ts` 4 条
  - `bridge/__tests__/retryVeto.test.ts` 1 条
  - `chat/__tests__/sessionFailure.test.ts` 1 条
  - `chat/__tests__/failureCardProviderText.test.ts` 1 条（挂载）
  - `shared/dshModelPlan/__tests__/dshModelPlan.test.ts` 2 条
  - `shared/dshHistory/__tests__/projection.test.ts` 2 条
  - `stores/__tests__/chatSessionsHistory.test.ts` 5 条
- 改写：
  - `sessionFailure.test.ts` 两条「每个码都有文案 / 都有中文」的码表加入新码；
  - `main/.../dshModelPlan.test.ts` 的日志用例多一条断言（随包快照里 grok-4.6 的 `max_tokens_clamped`）。
- 真宿主：`loop-guard-smoke.ts` 宿主 A 新增 `e1NoUpstreamNotRetried`，33 项全过。

## 金样本

- `bridge-record --check`：28 个场景无差异。录制里没有「请求发出后、首字前被停」的回合，投影的改动碰不到它们。
- **需要编排者重录一份**：`src/main/services/piModelConfig/__tests__/fixtures/dshModelPlan.snapshot.json`。MP-01 在重录前会失败，差异全部是本决策的预期结果：
  - 随包快照里 grok-4.6 也是 500000 / 500000，计划里变成 125000；
  - `dropped` 多一条 `max_tokens_clamped`（detail `500000 -> 125000`）；
  - `revision` 随之变化。

## 用户审批

待审批。
