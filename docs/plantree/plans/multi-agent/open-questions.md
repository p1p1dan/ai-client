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
