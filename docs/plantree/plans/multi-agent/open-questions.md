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

## #2 Codex 侧提问是什么形状

**状态**：**部分推进（2026-08-06 S1 spike）—— 契约已拿到，真实报文仍未实测；维持未闭合**

S1 实测拿到直连侧 `item/tool/requestUserInput` 的完整契约，与我方 `QuestionItem` **结构同构**
（差异只有 answers key 用问题原文 vs question id，外加 `isSecret` / `isOther` 两个位）→ **薄适配估 40–80 行**。
**但这是 schema 比对推出的判断，不是实测**——本轮 9 个真实回合零命中提问。
补测代价见 [spike 报告 §5 U1](../../../plans/2026-08-06-s1-acp-codex-spike-report.md)（4–8 回合，
且「诱发实验」额度损耗率实测约 50–75%）。详见
[reuse-boundary「未验的一处」](./topics/reuse-boundary.md)。

<details><summary>原始条目（2026-08-04）</summary>

codeg 为它写了 `classify_elicitation` 分类器，说明形态不止一种（提问式 / 审批式 / 链接式）。
这直接决定「薄适配」到底多薄——我们上层问答卡已 agent 无关（[reuse-boundary](./topics/reuse-boundary.md)），
但如果 Codex 的提问形状与 `question.requested` 差得远，薄适配就不薄了。

→ 属 S1 spike 第 3 项产出。

</details>

## #3 会话 ↔ agent 绑定的持久化口径

**状态**：**待设计（S1 已把落点测准，2026-08-06 升为下一步首要设计项）**

S1 实测把落点从 1 处放大到 **4 处**，并发现一个原先不知道的硬约束：
**`session-index.json` 是裸数组，无 `schemaVersion`、无字段校验、无 migration**
（`SessionIndexService.ts:172-188`，`ensureLoaded` 仅 `JSON.parse` + 灌 Map、失败即 warn 空表启动）
→ **「已有会话 undefined 视作 claude」必须在读侧显式实现**，指望迁移机制是没有的。
四处落点与协议惯例（可只加可选字段、不升 `AGENT_HOST_PROTOCOL_VERSION`）见
[reuse-boundary 第 2 行](./topics/reuse-boundary.md)。

<details><summary>原始条目（2026-08-05）</summary>

`chatSessions.ts` 是**红线 store**，加字段走加法纪律。要定的：

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

**状态**：**枚举已实测齐（2026-08-06），「怎么表达」待设计**

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
