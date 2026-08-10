# Open Questions — 多 Agent 接入

> 只放未决问题。已定的进 [topics/](./topics/)，已排的进 [roadmap](./roadmap.md)。
> 2026-08-08 归档：已关闭条目的结项推导原文见 [history 快照](./history/2026-0808-registry-openq-archive.md)。

## 已关闭（存根）

- ~~#1 接 ACP 还是直连 Codex~~ —— ✅ 2026-08-06 关闭：**不接 ACP，直连 `codex app-server`**。依据 = 用户判据答复（「不打算加第 3 个 agent，就 Claude + Codex 两个」）+ [S1 spike 实测](../../../plans/2026-08-06-s1-acp-codex-spike-report.md)（直连反而更便宜；审批报文已捕获，ACP 退路价值归零）。将来若加第 3 个 agent，按 spike 报告 §8.3 重估。**待升格为编号决策**（与「Claude 线不走 ACP」一并）。
- ~~#2 Codex 侧提问形状~~ —— ✅ 2026-08-06 关闭（S2-a 实测）：4 条真实 `item/tool/requestUserInput` 报文定形；`{answers:{}}` 是干净取消（与 Claude 侧相反，勿照搬防呆）；`options` 从不为空（服务端强校验）。形状定案与「薄适配」校正值见 [S2 设计档](../../../plans/2026-08-06-s2-codex-integration-design.md)。
- ~~#3 会话 ↔ agent 绑定持久化口径~~ —— ✅ 2026-08-06 关闭（S2-b 双轨 + 用户裁定）：wire 名 `'claude-code'/'codex'`（不可逆）· 字段 `agent` 只落 session 层 · 唯一回落点 renderer `mergeSessionIndex` · 不补顶层 `schemaVersion` · 三轴不互转。已随 S3 切片 0/1 落地 `0314216`；设计见 [S2 设计档 §0.5/§1/§2](../../../plans/2026-08-06-s2-codex-integration-design.md)。

## #4 扩 git 能力要对齐 codeg 的哪几项

**状态**：缺参照点
用户 2026-08-05 说「codeg 右侧的 git 功能以及展示形式我都很喜欢」，但未指明具体点；
**同轮又裁定本阶段 git 维持当前最小集**。两者不矛盾（远期偏好 vs 本阶段范围），
但要动 git 能力前必须先取回具体参照点（截图或点名），否则只能猜。

参照面提示：A08 曾规划 branch / pr / sync / stash 全套，按最小集纪律砍掉——
用户喜欢的可能正是这批。

## #5 Codex 的模型目录与权限语义如何统一表达

**状态**：**权限半边已定（2026-08-06 S2-c，要点存根如下）；模型目录半边仍待设计**

**权限半边（关闭）**：设计权威 = [S2 设计档](../../../plans/2026-08-06-s2-codex-integration-design.md) §1 C4/C10/C11 与 §2 #6/#9/#10/#11。
要点：`SessionPermissionMode` 冻结不动，新增并列 `SessionPermissionPolicy` 判别联合（判别位 `agent`）·
审批卡收敛一张，未知 decision id 一律 deny（fail-safe）· fileChange 的 diff 与审批分帧（`approvalCorrelator`，绝不因等 diff 延迟回复）·
默认档 `on-request` + `workspace-write` + `networkAccess:false`，**绝不继承本机 `~/.codex/config.toml`**（实测是 `danger-full-access`，继承 = 静默关掉全部审批）。
推导原文见 history 快照。

**模型目录半边（仍开）**：三套目录（`codex debug models` 8 条含 6 档 reasoning / `model/list` 5 条 / ACP 25 档位）
已实测齐，但「UI 怎么表达」未设计。直连下 model 与 effort 是**两个独立字段**（ACP 才合成单 id），
故「统一抽象 + 各自枚举」是自然选择。**未解空洞**：目录是本地静态内置表**不查第三方代理**
→ 代理真实支持哪些模型答不出，必须自建校验。

## ~~#6 Anthropic 凭据会进 codex 子进程~~ —— ✅ **2026-08-09 用户答复后基本关闭，转出一条新约束**

**现状**：Claude 会话跑过之后，`ensureRuntime()` 已把 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`
写到 Host 的 `process.env` 上；`codexRuntime` spawn codex 子进程时**整体继承 env**，于是这两个值
也进了 codex 进程。

**为什么施工时没有直接过滤掉**（这是有理由的克制，不是疏忽）：`codexHome` 的白名单投影保留
`model_providers.<id>.env_key`，用户的 codex provider 完全可能就指向这类变量名；无差别过滤会让
那种配置**丢认证并报一个难懂的错**。

**用户 2026-08-09 答复，本条据此关闭**：

> 「后续接入用户登录管理后，claude 和 codex 实际上使用的 key 是相同的，只不过两者的 url 可能不同，
> claude 是 `xxx.com`，codex 是 `xxx.com/v1`。」

→ 同一把密钥、两个 URL ⇒ codex 子进程拿到 `ANTHROPIC_AUTH_TOKEN` **不是跨凭据泄漏**，
而是它本来就有权拿的同一个秘密。**按「维持现状」关闭**，无需过滤。

**但转出一条更要紧的新约束（见 #9）**：`codexHome` 现在是**从用户已有的 `~/.codex/config.toml` 投影**，
这在有了登录管理之后是错的。

## #9 登录管理落地后，codex provider 段必须由 app 生成而非投影用户文件（2026-08-09 由 #6 转出）

**约束来源**：用户口径「同一把 key，两个 URL（claude `xxx.com` / codex `xxx.com/v1`）」。

**现状**：`codexHome.projectCodexConfig` 的输入是用户的 `~/.codex/config.toml`，白名单投影出
`model` / `model_provider` / `model_providers.*`。也就是说**provider 的权威在用户的文件里**。

**为什么必须改**：登录管理一旦成为凭据权威，用户在 app 里换了 key，codex 仍会用它自己文件里的旧
provider 段——**表现为「换了 key 但 codex 还在用旧的」，且不会报错**。这与 S2 §0.5 早已裁定的
「绝不继承本机 `~/.codex/config.toml`」是同一条纪律的延伸：本轮只挡住了 approval/sandbox/
developer_instructions，provider 段是**有意保留的例外**（否则没凭据没法跑），而登录管理正是那个例外消失的时刻。

**方向**（待设计，不在 2a/2c）：`codexHome` 增加「由托管凭据直接生成 provider 段」的模式——
`base_url` 用 `/v1` 变体、key 走 `env_key` 指向我们注入的环境变量；投影模式降级为「无登录管理时的回退」。
**决定点在 2b 或 6 之前**，因为它同时决定 onboarding 要不要再写 `~/.codex`。


## #7 `capabilities.agents` 只由 flag 决定，与 §2.1 的裁定有出入（2026-08-09）

仲裁档 §2.1 采纳了 Codex 轨的主张：codex 可用性不只取决于 flag，还取决于 Main 解析出的 entry
与隔离 home 的准备结果，故应在 initialize 时建 `HostAgentRegistry`。**切片 2a 实际落的是「flag 单独决定」**
（模块加载时算一次）。

**当下后果**：一台没装 codex 的机器上，渲染端仍会提供 Codex 选项，用户要到 create 时才由
correlated `agent_unsupported` 得知。属**诚实降级**（不是静默失败），但 §2.1 想闭合的那个环没闭合。

**连带**：C-c 那条（Main/renderer 会丢掉 `capabilities.agents`，`AgentHostManager.getStatus()` 只存 settings、
`hostStatus.ts` 只折叠 thinking）**本片未动**，仍开着。两条一并归切片 6 收口，或另立。

## #8 每个会话一个 app-server 进程（2026-08-09）

**实测代价（2026-08-09 编排者亲量，此前的「296MiB」是磁盘文件大小、不是内存，属误读风险，已更正）**：
一个 app-server 进程树 **RSS 124 MiB**（node 壳 49 + 原生 codex 75）。原生二进制是 mmap 的，
只有触碰到的页才驻留，所以 296MiB 的磁盘体积不等于内存占用。

**参照物同构**：codeg 的 `SpawnDedupKey = {agent_type, working_dir, session_id}`
（`src-tauri/src/acp/manager.rs:125-129`）——**它也是每会话一个进程**，12 个 agent 皆然。
即「一会话一进程」不是我们走偏了。

**真正的缺口是回收，不是模型**：codeg 另有 `idle_sweep.rs`——180s 空闲即断开、每 60s 扫一次，
注释明写是「防止长命进程泄漏 ACP 子进程、文件句柄与内存」。**我们没有这个回收器**，
开了会话就不回收。

**共享连接技术上可行但不做**：codex 契约有 `thread/list` / `thread/loaded/list`，每条通知带 `threadId`，
一个 app-server 托多 thread 是原生支持的。但共享要求每条入站帧按 threadId 路由，且**把故障域焊在一起**
（一个进程崩了所有会话一起没），收益只有几十 MiB——量级不值。

**裁定**：补 idle sweep（照 codeg 形状），**不做共享连接**。归切片 6 收口。

## #10 提问坞是全局单槽：两会话并发提问必丢一张卡（2026-08-10 切片 3 评审发现）

**状态**：已确认的**既有缺陷，与 agent 无关**；切片 3 只修了其中一半，改形状需另立任务。

**现状** [读码]：`chatSessions.ts` 的 `pendingQuestion` 是**一个槽**，每来一条 `question.requested`
就整体覆盖；`PendingQuestionDock` 只渲染这一个槽。

**失败链**：会话 A 挂着提问 → 会话 B 也提问 → A 的槽被顶掉 → 用户切回 A：坞里空、卡片留在时间线未 resolved、
`waiting_question` 使 `isBusyStatus` 恒真 → **A 永久不能发消息，也永远答不了那张卡**。
两个 Claude 会话同样触发，不是 Codex 引入的；但 Codex 一个回合就发了 4 次提问 [实测]，会显著抬高命中率。

**切片 3 做了什么**：只补了「误清」半边——`question.resolved` 现在仅在 sessionId 与 questionId 都匹配时才清空
（`4b468f4`，红线加法 + 3 例断言）。**覆盖那半边没动**。

**要改什么**：`pendingQuestion` 改成 `Record<sessionId, …>`，连带 `PendingQuestionDock` 与
`selectPendingQuestionBlock`。属红线 store 的形状变更 + 自己的测试，应在主线立任务而不是塞进 S3 切片。
