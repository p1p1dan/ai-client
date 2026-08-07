# Open Questions — 多 Agent 接入

> 只放未决问题。已定的进 [topics/](./topics/)，已排的进 [roadmap](./roadmap.md)。

## ~~#1 接 ACP 还是直连 Codex~~ —— ✅ **2026-08-06 关闭**

**状态**：**已关闭**。裁定：**不接 ACP，直连 `codex app-server`。**
**关闭依据**：用户判据答复 + [S1 spike](../../../plans/2026-08-06-s1-acp-codex-spike-report.md) 实测数据（§4 / §8.2）。

**判据**（原文保留）：三个月内打不打算加**第 3 个 agent**（Gemini / Cursor / OpenCode / …）——
打算加 → 接 ACP（第一次多花的成本从第 3 个开始摊回来）；不打算 → 直连更省事。
**用户 2026-08-06 答复：**

> **「不打算，就 Claude + Codex 两个。」**

### 三条支撑（缺一条都不足以定）

1. **判据侧**：不加第 3 个 agent → ACP 的全部价值（省解析器、从第 3 个起摊平）不成立。
2. **成本侧**：**复核条款未触发**——原设的推翻情形是「直连远超 ACP」，实测**方向相反**：
   直连 **540–740 行 / 2.5–5.0 人日**，ACP **670–1090 行 / 3.0–7.0 人日**，直连**反而更便宜**。
   两条路的 JSON-RPC 客户端都是 ~120 行、归一化器净新增同为 300–420 行
   → acp-decision 那句「写第一个解析器的成本 ≈ 写 ACP 客户端的成本」**被实测坐实**。
3. **可行性侧 —— 推翻了本问题的一个隐含前提**：原先认定「万一直连不可行（例如 Codex 没有可编程的
   审批回调通道），ACP 是唯一退路」。实测 `codex app-server` 的 11 个服务端→客户端回调中，
   **命令审批（`item/commandExecution/requestApproval`）与补丁审批（`item/fileChange/requestApproval`）
   两类已在真实回合中捕获原始报文** → **退路条件不成立，ACP 的「保险」价值归零**。
   本问题由此从「可行性未定的二选一」降为「纯成本的二选一」。

### 记入账的代价（两侧都写下来）

**选 ACP 会一直付的三条**（不随 agent 数量摊销，故不进摊销模型）：
权限表达力有损（丢 `applyNetworkPolicyAmendment` / `granular` / `approvalsReviewer` 路由）·
341M 重复二进制（与 PATH 上同版 codex 0.145.0）+ 3 级进程链 ·
审批关键数据落在**无 schema 的 `_meta.codex`**（上游改字段，类型系统与 CI 都抓不到）。

**选直连的已知代价**：`codex app-server` 标 `[experimental]`；v1/v2 双协议 + legacy/v2 双审批方言都要写；
将来若改主意加第 3 个 agent，每个 ≈ **420–540 行**新驱动，**且该 agent 必须自带可编程双向通道**
（反例已在手边：`codex exec` 结构上没有回传通道，`codex mcp-server` 只暴露 2 个工具）。
→ 触发条件明确，届时按 [spike 报告 §8.3](../../../plans/2026-08-06-s1-acp-codex-spike-report.md) 重估即可。

**本结论待升格为编号决策**（与「Claude 线不走 ACP」一并——两者是同一判断的两面）。

<details><summary>原始条目与推导过程（2026-08-04 立、2026-08-05 补落库）</summary>

**为什么只剩这一个判据**：ACP 省的是「解析器」，而写第一个解析器的成本 ≈ 写 ACP 客户端的成本，
所以对第 1、2 个 agent 不省钱。完整推导见 [topics/acp-decision.md](./topics/acp-decision.md)。

**隐性成本别漏算**：codeg 的 `registry.rs` 里带着一串适配器版本坑注释
（`claude-agent-acp` 0.64.0 `injected` 不可靠 / `codex-acp` 从 Rust 二进制迁 npm / 1.1.5 收紧 MCP 过滤）——
接 ACP = 把这些上游版本风险一并接进来。
> S1 实测把这条**加重**了：全仓 `acp/*.rs` 的 workaround/regression 类关键词命中 **83 处**；
> 且 codeg 为 ACP 子进程管理另写了 5 个模块共 **5106 行**（preflight 766 / binary_cache 902 /
> idle_sweep 98 / stderr_tail 1013 / background_watch 2327）。

**复核条款（唯一能推翻本判据的情形，已检验未触发）**：spike 若测出两条路的**首次接入成本差距
远大于原假设的「≈相等」**——例如直连要写的归一化器远超 ACP 客户端 + 映射层的总和——则判据本身失效。

**当时写下的「为什么还要跑完 spike」**：判据只回答了「值不值」，没回答「行不行」；
剩下四项数据直连路线一样要用。→ 事后看这个决定是对的：正是这四项数据推翻了上面第 3 条的退路前提。

</details>

## ~~#2 Codex 侧提问是什么形状~~ —— ✅ **2026-08-06 关闭（S2-a 实测）**

**状态**：**已关闭**。抓到 **4 条真实 `item/tool/requestUserInput` 报文 / 10 颗问题**，答复走通、回合续跑。
证据：`src/agent-host/spikes/s2-codex-question-probe.ts` + scratchpad `s2-u1/u1-question-raw.jsonl`。
设计落点见 [S2 设计档](../../../plans/2026-08-06-s2-codex-integration-design.md)。

### 形状定案（字段取值域有实测支撑）

`params = {threadId, turnId, itemId, questions[], autoResolutionMs}`；
`question = {id, header, question, isOther, isSecret, options[]}`；`option = {label, description}`（**description 必填**）。
实测常量：`isOther` 恒 true(10/10) · `isSecret` 恒 false(10/10) · `autoResolutionMs` 恒 null(4/4) ·
**`options` 从不为空**（二进制里有服务端强校验 `request_user_input requires non-empty options for every question`
——**schema 的 nullable 是假的，不要按 null 写分支**）。

### 「薄适配」结论：方向对，数字偏乐观约 2 倍

S1 估的 **40–80 行**校正为 **Host 侧 100–150 行 + 共享类型 ~12 行 + 渲染端 0 行**，
另加一次性骨架成本（pending 表 + status mapper + 生命周期回收 ≈60–80 行）记在切片 2。
**仍属「薄」**——报文自包含、无需 item 关联、无需像 codeg 的 `classify_elicitation` 把通用表单反解成类型
（那是 ACP 侧才有的成本）。

三条把成本压下来的实测：
1. **提问是自包含报文，不需要 itemId 关联逻辑**——`params.itemId`（形如 `call_XXX`）在整回合 13 个 item 中一次未出现。
   与 `item/fileChange/requestApproval` **正相反**（后者 diff 必须按 itemId 关联另一条 item）。
2. **`isOther` 我方零改动即满足**——渲染端已无条件追加 `Other…` 行（`questionCardModel.ts:104-124`），
   正是 Codex 工具描述要求的客户端行为。
3. **`{answers:{}}` 是干净取消**（模型不重问、回合正常收尾）——**与 Claude 侧行为相反**：
   `questionBridge.ts:8-10` 记录的「bare allow 会被 cli.js 静默丢弃并重问」在 Codex 侧不成立，
   照搬那条防呆会把 cancel 做死。（这也是否决「抽公共 settler 基类」的决定性理由。）

### S1 那条线索被证伪（记下来免得再走弯路）

编排者曾据 `codex features list` 判断 `default_mode_request_user_input`（under development / 默认 false）
是 S1 九回合零命中的原因。**实测证伪**：该 flag 连同 `collaborationMode=plan`、
`[tools.experimental_request_user_input].enabled` 三者任意组合，**外发请求体逐字节相同**。
真因是**模型走了散文后门**——Codex 出厂提示词写着「in rare cases … you may ask it directly without the tool」，
`gpt-5.6-sol` 每次都走后门。**唯一有效杠杆是提示词**：点名 `request_user_input` 工具 +
声明散文通道无效（「my client renders ONLY structured tool questions」）+ 预指定 question ids，一次命中、同回合出 4 条。

### 副产物：零额度看工具表的方法（后续全线可用）

把 `model_providers.<p>.base_url` 指向本地 sinkhole（记请求体、回 400、retries=0），
codex 在拿到任何 token 之前就把完整请求（含工具表）发出来了。
**坑**：`gpt-5.6-sol` 是 `tool_mode:"code_mode_only"` + `use_responses_lite:true`，
请求体**没有顶层 `tools` 数组**，工具表在 `input[0] = {type:"additional_tools", role:"developer", tools:[…]}` 里
——读 `body.tools` 会得到空表并误判。
该方法已用于取得 **U4 的负结果**：`request_permissions` 在 5 个变体下从不出现在工具表里
→ 本机 build/模型上 `item/permissions/requestApproval` **无法用真实回合诱发**，S2-c 只能按 schema 设计。

<details><summary>原始条目（2026-08-04）</summary>

codeg 为它写了 `classify_elicitation` 分类器，说明形态不止一种（提问式 / 审批式 / 链接式）。
这直接决定「薄适配」到底多薄——我们上层问答卡已 agent 无关（[reuse-boundary](./topics/reuse-boundary.md)），
但如果 Codex 的提问形状与 `question.requested` 差得远，薄适配就不薄了。

→ 属 S1 spike 第 3 项产出。

</details>

## ~~#3 会话 ↔ agent 绑定的持久化口径~~ —— ✅ **2026-08-06 关闭（S2-b 双轨 + 用户裁定）**

**状态**：**已关闭**。设计见 [S2 设计档 §0.5-①③ / §1 C1-C5 / §2](../../../plans/2026-08-06-s2-codex-integration-design.md)。

- **wire 名（不可逆，用户 2026-08-06 追认）**：`AGENT_WIRE_NAMES = ['claude-code','codex']`，
  新建叶子模块 `src/shared/types/agentWire.ts`。字段名统一 `agent`（否决 `agentType`：
  `runtimeEvents.ts:250/467` 的 `agentId?` 已被占用为 Claude 子代理 id，同屏会误读）。
- **层级**：只落 session 层，workspace 不放（双轨独立同判）。「新建聊天默认用谁」另放全局 settings。
- **唯一回落点**：renderer 的 `mergeSessionIndex`（`SessionIndexEntry[]→ChatSession[]` 唯一入口）。
  **否决 Main 侧 `ensureLoaded`**——`flush()` 写的是整张表，读侧规范化会导致**任何一次 flush
  都把 `agent` 写回磁盘上每一条老会话行**，即把兼容读取变成不可逆写迁移。
- **不补 `schemaVersion`**：顶层信封化会让老版本 `for-of` 抛错 → 空表启动 → 下次 flush 写回 `[]`
  → **全部会话索引静默清零**。要版本标记只能做成 per-entry 可选字段。
- **必踩的坑（双轨各自独立命中）**：`SessionIndexService.ts:139-142` 的
  `if (!runtimeIdentity) return` 早退——而 `claudeRuntime.ts:308-310` 新建会话的 `session.created`
  恰恰没有 runtimeIdentity。不放宽这个守卫，agent 归属永远进不了索引且不报错。
- **三轴不得互转**：`AgentWireName`（会话绑定）≠ `BuiltinAgentId`（终端能起哪个 CLI）≠ `AIProvider`
  （一次性助手供应商），由静态断言钉死。

<details><summary>原始条目（2026-08-05）与 S1 阶段补充</summary>

**S1 阶段（关闭前）的中间结论**：把落点从 1 处放大到 **4 处**，并发现一个原先不知道的硬约束：
**`session-index.json` 是裸数组，无 `schemaVersion`、无字段校验、无 migration**
（`SessionIndexService.ts:172-188`，`ensureLoaded` 仅 `JSON.parse` + 灌 Map、失败即 warn 空表启动）
→ **「已有会话 undefined 视作 claude」必须在读侧显式实现**，指望迁移机制是没有的。
四处落点与协议惯例（可只加可选字段、不升 `AGENT_HOST_PROTOCOL_VERSION`）见
[reuse-boundary 第 2 行](./topics/reuse-boundary.md)。

**最初条目（2026-08-05）**：`chatSessions.ts` 是**红线 store**，加字段走加法纪律。要定的：

- 字段落在 session 还是 workspace 层？（codeg 落在 conversation 行的 `agent_type`）
- 已有会话（无该字段）怎么迁移——默认回落 Claude 还是显式「未知」？
- wire 名一旦持久化就不能改（codeg 有专门的回归测试钉死 12 个 wire 名），我们的命名要一次定对
- resume 时 `HistoryBlock` 无 agent 归属概念（与 C-17 同一缺口）——跨 agent 的历史怎么读

</details>

## #4 扩 git 能力要对齐 codeg 的哪几项

**状态**：缺参照点
用户 2026-08-05 说「codeg 右侧的 git 功能以及展示形式我都很喜欢」，但未指明具体点；
**同轮又裁定本阶段 git 维持当前最小集**。两者不矛盾（远期偏好 vs 本阶段范围），
但要动 git 能力前必须先取回具体参照点（截图或点名），否则只能猜。

参照面提示：A08 曾规划 branch / pr / sync / stash 全套，按最小集纪律砍掉——
用户喜欢的可能正是这批。

## #5 Codex 的模型目录与权限语义如何统一表达

**状态**：**权限半边已定（2026-08-06 S2-c）；模型目录半边仍待设计**

**权限半边（关闭）**：设计见 [S2 设计档](../../../plans/2026-08-06-s2-codex-integration-design.md) §1 C4/C10/C11 与 §2 #6/#9/#10/#11。
要点——① **`SessionPermissionMode` 冻结不动**（Claude 口径就让它是 Claude 口径），
新增并列的 `SessionPermissionPolicy` 判别联合（判别位 = `agent`）挂进 `session.created.payload`，
老 renderer 拿到 Codex 会话时 `isSessionPermissionMode` 返回 false → `return prev`，权限行不显示且不乱写；
② 审批卡收敛成一张，`decisions?` 缺省 = Allow/Deny 两行（既有测试已钉），
**未知 decision id 一律 deny（fail-safe）**；③ `availableDecisions` 实测是渲染提示非强校验，
故只渲染我们认识的选项 + 卡底显示 `omittedDecisionCount`；
④ **fileChange 的 diff 与审批分帧**，新增 `approvalCorrelator`（itemId→diff 缓存）关联，
**但绝不因等 diff 而延迟回复审批**（会把回合挂死在 `waitingOnApproval`）；
⑤ `item/permissions/requestApproval`（第三类 v2 审批）本机 build **诱发不出来**（工具表里从无 `request_permissions`），
本轮不实现，default 分支走自动拒绝而非崩；⑥ **默认档 `on-request` + `workspace-write` + `networkAccess:false`**，
**绝不继承本机 `~/.codex/config.toml`**（实测写的是 `danger-full-access`，继承 = 静默关掉全部审批）。

**模型目录半边（仍开）**：三套目录（`codex debug models` 8 条含 6 档 reasoning / `model/list` 5 条 / ACP 25 档位）
已实测齐，但「UI 怎么表达」未设计。直连下 model 与 effort 是**两个独立字段**（ACP 才合成单 id），
故「统一抽象 + 各自枚举」是自然选择。**未解空洞**：目录是本地静态内置表**不查第三方代理**
→ 代理真实支持哪些模型答不出，必须自建校验。

<details><summary>原始条目与 S1 阶段枚举</summary>


- **模型目录**：三套粒度——`codex debug models` **8 条**（含 **6 档 reasoning**：low/medium/high/xhigh/max/ultra）·
  app-server `model/list` **5 条** · ACP `session/new` **25 档位**。我方 `SessionEffortLevel`（`agentHost.ts:48`）是
  Claude 口径，**档位不同构**。**直连把 model 与 effort 保持为两个独立字段**（ACP 合成单 id `gpt-5.6-sol[medium]`）
  → 既已裁定直连，**「统一抽象 + 各自枚举」是自然选择**。
  **新发现的空洞**：目录是本地静态内置表**不查第三方代理** → 代理真实支持哪些模型，两条路都答不出，必须自建校验。
- **权限语义**：Codex 是 **4 维正交**，一个枚举装不下——
  `approval_policy`（`untrusted|on-request|never` + `granular` 对象）·
  `sandbox_mode`（`read-only|workspace-write|danger-full-access` + `networkAccess` 子维）·
  `permissions` 命名档（`:read-only|:workspace|:danger-full-access`，**与 sandbox 互斥**）·
  `approvalsReviewer`（`user|auto_review|guardian_subagent`，决定审批**路由给谁**）。
  审批响应还有**两套方言**（v2 三类 + legacy `ReviewDecision` 7 变体）都要写。
  实测彩蛋：**`availableDecisions` 是渲染提示而非强校验**（探针回了不在列表里的 `decline`，服务端照收）。

→ 枚举与原始报文见 [spike 报告 §1.4 / §1.5](../../../plans/2026-08-06-s1-acp-codex-spike-report.md)。
**剩下的是设计题**：我方 `permissionMode`（Claude 口径 `acceptEdits/dontAsk/bypassPermissions`）如何承载这 4 维。

</details>
