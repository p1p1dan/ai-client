# Topic — 现有代码的 agent 无关面 vs Claude 专属面

> **状态：Historical replacement input。** 旧 agent-neutral/Claude-specific 分类可供 T28/T35 使用，但不能据此恢复多 runtime 产品方向。
>
> 这张边界决定 Codex 接入的真实成本。结论产生于 2026-08-04 会话（当轮实测），2026-08-05 补落库。

## 问答卡：只有最底下 303 行是 Claude 专属

```
QuestionCard.tsx / PendingQuestionDock / questionCardModel   ← 零 Claude 耦合（当轮实测）
        ↑
chatSessions store 的 question.requested 处理                ← 通用，只认 questionId + questions[]
        ↑
IPC chat:respondQuestion + RuntimeEvent 协议                 ← 通用
        ↑
questionBridge.ts（✅ 复核 303 行，钩 Claude SDK 的 canUseTool） ← 只有这一层是 Claude 专属
```

**上面的 UI、协议、store 全部 agent 无关。** 这不是巧合，是 **D2「自建协议不拷别人 store」**的红利。

**推论**：Codex 接进来要做的不是「再写一套问答卡」，而是**一个薄适配**——
把 Codex 那侧的提问接住转成我们的 `question.requested`，把用户答案转回去。
卡片长什么样、怎么点、怎么存，一行都不用改。

### 一个曾经的错判，已收回

2026-08-04 中途曾建议照 codeg 那样自建统一伴生进程（方案 B），**当轮即收回**。
codeg 需要它是因为要撑 12 个 agent、其中多数**没有结构化提问能力**，需要一个「塞进去就能用」的统一机制；
我们只有 Claude 和 Codex，两个都自带提问通道——它的理由在我们这里不成立。

### 未验的一处 —— 2026-08-06 部分推进，**仍未闭合**

**Codex 侧的提问长什么形状，S1 spike 拿到了契约但没拿到真实报文。**

- **拿到的**：直连侧 `item/tool/requestUserInput`（标 EXPERIMENTAL）契约全文——
  `params = {threadId, turnId, itemId, questions[], autoResolutionMs?}`，
  `question = {id, header, question, options?:[{label,description}], isOther, isSecret}`，
  响应 `{answers: {[qid]: {answers: string[]}}}`，**一次多问、每问多答**。
  与我方 `QuestionItem`（`runtimeEvents.ts:254-282`）**结构同构**，差异只有两处：
  ① 我方 `question.respond` 的 answers **以问题原文逐字为 key**（`:299-312`），Codex 用 question id；
  ② `isSecret` / `isOther` 两个位我方没有。→ **薄适配估 40–80 行**。
- **仍缺的**：**两条路都没有在真实回合中诱发出一次提问**（本轮 9 个真实回合零命中）。
  上面那句「薄适配 40–80 行」是**由 schema 比对推出的判断，不是实测**。
- **ACP 侧反而更厚**（codeg 实证）：`classify_elicitation`（`question.rs:834` 起，另有 11 个单测钉死分支）
  必须先把 codex 的 **form elicitation** 分 Approval / Questions 两大类，再按 5 种
  `ElicitationFieldKind` 定型 → **ACP 把类型化提问压成通用表单，客户端要再解一次型；直连拿到的是类型化原件**。

→ [open-questions #2](../open-questions.md) **维持未闭合**；补测代价见
[spike 报告 §5 U1](../../../../plans/2026-08-06-s1-acp-codex-spike-report.md)（估 4–8 回合，
且「诱发实验」的额度损耗率实测约 50–75%）。

## 其余各层的判定（2026-08-06 已由 S1 spike 校正）

> ✅ **本表已校正**。原为「初判未实测」，2026-08-06 S1 spike 四路探针实测后逐行更新。
> 完整依据与 file:line 见 [S1 spike 报告 §3](../../../../plans/2026-08-06-s1-acp-codex-spike-report.md)。
> 下表「初判」列保留原文以便对照，**判定以「实测后」列为准**。

| 层 | 初判（2026-08-04） | **实测后判定（2026-08-06）** | 关键依据 |
|---|---|---|---|
| 侧栏「文件夹 → 会话」两级结构 | 已具备，缺的只是 CLI 维度 | **未校正——四路探针均未触及 `sidebarTree.ts`，维持初判但不得标为「已验证」** | 唯一新增依据：agent 归属字段有明确落点（见下行），chip 数据源可得 |
| 会话 ↔ agent 绑定 | 缺，需红线 store 加字段 + 持久化口径 | **确认，且落点从 1 处放大到 4 处；另发现无迁移机制** | ① `ChatSession` 无 agent 字段（`chatSessions.ts:70-86`，加在 `retry?` 后为同构可选加法）② `createSession` 只传 `{sessionId, workspacePath}`（`:912-932`）③ **`session-index.json` 是裸数组、无 `schemaVersion`、无字段校验、无 migration**（`SessionIndexService.ts:172-188`）→ **「undefined 视作 claude」必须在读侧显式实现** ④ `session.created` payload 今天只有 `runtimeIdentity + permissionMode`（`runtimeEvents.ts:330-334`），agent 归属要回流得扩 payload。协议惯例支持不升版（`AGENT_HOST_PROTOCOL_VERSION=1`） |
| 模型 / 推理档 | 单轨，现为 Claude 口径 | **校正：不是「单轨→多轨」，是「三套粒度不同的目录 + 一个两条路都不解决的空洞」** | 实测三套：`codex debug models` **8 条**（含 **6 档 reasoning**：low/medium/high/xhigh/max/ultra）· app-server `model/list` **5 条**（camelCase + 游标）· ACP `session/new` **25 档位**（`模型[effort]` 合成单 id）。我方 `SessionEffortLevel`（`agentHost.ts:48`）是 Claude 口径，**档位不同构**。**ACP 把 model+effort 合成一个 id，直连是两个独立字段** → 直连下「统一抽象 + 各自枚举」更自然。**预期偏差未发生**：`gpt-5.6-sol` 就在内置目录第 1 条。**新空洞**：目录是本地静态内置表**不查第三方代理** → 代理真实支持什么两条路都答不出，必须自建 |
| 权限模式 | 只读展示，无管理面 | **校正：现状描述成立，但优先级从「以后再说」升为「接 Codex 当天必须定投影口径」** | Codex 是 **4 维正交**：`approval_policy`（3 值 + `granular` 对象）· `sandbox_mode`（3 值 + `networkAccess` 子维）· `permissions` 命名档（3 个，与 sandbox **互斥**）· `approvalsReviewer`（user/auto_review/guardian_subagent）。**一个枚举装不下**。ACP 压成 3 档 `AgentMode` 且**完全覆盖 `~/.codex`** → 接 ACP = 接受有损投影 |
| 工具行渲染 | 大概率通用 | **部分推翻：协议层通用成立，渲染层不通用；落点在 renderer 不在协议** | 协议层 `tool.started.name` 是自由 string ✅；但 **`src/renderer/components/chat/toolCard.ts` 按 Claude 内置工具名硬编码**：`:551-553` TOOL_VERBS · `:653/682/691/704` case 表 · `:774` `BASH_TOOL_NAMES` · `:588` `DELEGATION_TOOL_NAMES`（**同一常量在 `src/agent-host/subagentProjection.ts:91` 另有副本，两处都要动**）。codeg 单一 ToolCall 分支 **145 行 / ≥7 处逐 agent 特判（codex 专属 3 处）**。新增两条形状成本：直连 fileChange 的 **diff 与审批分帧、必须按 itemId 关联**；ACP 即便 `terminal:false` 仍给 `{type:"terminal",terminalId}` |
| 历史重放 | 有协议缺口 | **确认并大幅加重：不是「有缺口」，是「跨 agent 必塌」，且塌法有三个独立机制** | ① 历史来源被 `runtimeIdentity` **单键绑死**且其物理含义是 **Claude JSONL basename**（`sessionHistory.ts:62`，读取器 `historyReader.ts:239-241` 直指 `~/.claude/projects`）→ Codex 会话只能落 `jsonl_not_found`，**错误码枚举里没有「本 agent 无历史」这一档**（`:46`）② `HistoryMessage.id` 的 `h:` 前缀是 **replay 合并的替换语义键**（`:33/36`），换 id 体系会误合或全量重复 ③ 协议里**没有任何位置能表达「这条历史消息属于哪个 agent」**。**另有既有缺口**：`HistoryBlock` 只有 4 型 vs 实时 `ChatBlockType` 6 型 → resume 后授权卡与问答卡永久消失。**两条路都有 resume 契约但都未实跑** → 历史是全表**最大的共同空洞** |

**spike 新增的两行**（初判表里原本没有）：

| 层 | 判定 | 依据 |
|---|---|---|
| `usage.updated` | **零成本填充，但两条路填充密度差 6 倍** | 结构完全开放（`Record<string, unknown>` 原样透传）。直连 `thread/tokenUsage/updated` 可填 **total+last × 6 字段 + modelContextWindow**；ACP `usage_update` 只有 **`{used, size}`** |
| `subagent.activity`（T-34） | **诚实降级，省 385 行** | 置 `capabilities.subagentActivity=false` 即可不做。**但 ACP 路不是「不做」而是「要写过滤」**——codex 会把 `subAgentActivity` 伪装成 `tool_call` 发过来，codeg 必须过滤 |
