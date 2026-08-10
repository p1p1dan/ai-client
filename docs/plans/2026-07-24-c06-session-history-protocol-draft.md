# C-06 `session.history` 协议（CP4 已定稿）

> 状态：**定稿** — fresh-fable 对抗评审（GO-WITH-CHANGES，12 findings 全采纳，§10）→ 用户 CP4 确认（2026-07-24）
> 本文档即 T-03 的接口契约；后续变更须走协议变更纪律（总台账记行 + 通知团队）
> 权威依据：ARD D11（Host 读 CC JSONL，重放成 Runtime Events；本地只存索引；快照兜底后置）
> 关联：C-07 SessionIndexService（已落地 `f6807c9`）、T-02/T-03（消费方）、T-11⑤（加密机 JSONL 可读验证）

## 0. 变更总览

| 层 | 变更 | 性质 |
|---|---|---|
| `shared/types/sessionHistory.ts`（新） | `HistoryMessage` / `HistoryBlock` / `HistorySessionSummary` | 新增 |
| `shared/types/runtimeEvents.ts` | 新事件 `session.history`、`session.historyListed`、`session.updated`；`host.ready.payload` 增 `capabilities` | 纯增量 |
| `shared/types/agentHost.ts` | 新命令 `session.listHistory` | 纯增量 |
| Host `src/agent-host/historyReader.ts`（新） | JSONL 定位 + 宽容解析 + 消化成 `HistoryMessage[]`（流式裁剪） | 新增 |
| Host `claudeRuntime.ts` / `sessionRegistry.ts` | resume 时序插入 history（异步不阻塞命令循环）；**running 会话拒绝 resume**；registry.resume 改 merge 语义；ingest 发现身份变化发 `session.updated` | 行为增强 |
| Main `AgentHostManager` | `requestAndWait`（requestId 关联查询，Host 退出即 reject）；IPC `chat:listHistory` | 新增 |
| Main `SessionIndexService` | 消费 `session.updated` 富化 runtimeIdentity | 增强 |
| Renderer `chatSessions.ts` | reducer 新分支 `session.history`：按 `h:` 前缀幂等替换灌入 | 新增（Claude 所有权） |

**协议版本**：所有变更为纯增量（新事件 / 新命令 / host.ready 新可选字段；旧字段零改动），**不 bump** `AGENT_HOST_PROTOCOL_VERSION`（维持 1）。兼容性已双向核实：旧 Host 收未知命令回 `not_implemented`；旧 Renderer 对未知事件走 `default: {}`；`session.historyListed` 无 sessionId，reducer 早退忽略。新 Main 区分新旧 Host 依 `host.ready.capabilities`（§3.4），不依赖超时探测。

## 1. 地形事实（设计输入；含评审修正）

1. **resume 现状只恢复身份**：`claudeRuntime.resumeSession()` 仅登记 registry 并发 `session.resumed` + `status idle`；`options.resume = runtimeIdentity` 在下一次 send 才传给 SDK。历史重放为净新增。
2. **JSONL 基名即 runtimeIdentity**：`~/.claude/projects/<munged-cwd>/<uuid>.jsonl`。实测 12/12 文件 `sessionId` 字段与 basename 全等 → resume 路径可按文件名定位，**不依赖 munge 正确性**。
3. **正向 munge**：逐字符将非字母数字替换为 `-`（3 个真实目录验证吻合）。规则**大小写敏感**——win32 下 workspacePath 大小写漂移（`d:\…` vs `D:\…`）是候选目录 miss 的首要原因，定位与 cwd 校验必须大小写不敏感 + 分隔符归一（§5.1）。中文路径折叠成连串 `-`，碰撞概率高，靠 cwd 校验 + resume 文件名兜底闭环（CC 对 CJK 的实际 munge 无样本，未验证假设）。
4. **加密机**（评审修正）：D11 选择 Host 读是**架构决策**而非唯一可行路径（Main 今天via spawn 白名单 node 也能读，见 `tsdSafeRead.ts`）。白名单以**具体二进制**为准——Host 的 node 来自五源解析（env/nvm/fnm/volta/path），是否在 TEC 白名单属未验证假设。**若 Host 不在白名单，fs 读到密文 → 全行解析失败 → 若无防护将静默返回空历史**。因此 historyReader 必须做 TSD magic 探测显性报错（§5.5），并入 T-11⑤ 验收。
5. **store reducer 顺序敏感**：`message.delta` / `tool.*` 对未知 messageId 直接丢弃 → 批量事件一次灌入是正解（执行计划已定向）。
6. **身份缺口（评审独立复核为真）**：SDK 真实 session_id 在首次 send 的流中才被发现，当前只写 Host registry（`claudeRuntime.ts:209`），无事件回传 Main；`session.created` payload 为空 + 索引无 identity 早退 → 应用内新建会话在 C-07 索引里 runtimeIdentity 恒空，重启后无法 resume。`session.updated` 为前置正确性修复。**主场景是首次发现**；resume 分叉为防御性覆盖——本项目不传 `forkSession`（SDK 默认 false，续写同一 session id 同一文件），分叉行为未被真实数据验证（§3.3 回归钉子）。
7. **传输可行性**：Main 用 `node:readline` 逐行读 Host stdout，无行长上限；批量 payload 单行 NDJSON 可行，上限自设（§5.4）。
8. **真实体量**（评审修正）：本机最大会话 **3.97MB / 1293 行**（非草案初版误记的 241KB/66 行）；重度 CLI 用户数十 MB 单会话可预期 → 输入侧必须设防（§5.4）。消化后消息条数极少（最大会话 38 条——一个 agentic turn 合并 1 条）。
9. **Host 命令循环串行**：主循环 `await handleCommand`，仅 `session.send` fire-and-forget → resume/listHistory 的读盘若同步 await，会阻塞其他会话的 `session.stop` / `permission.respond`。历史读取必须异步化（§5.5）。

## 2. 共享类型（新文件 `src/shared/types/sessionHistory.ts`）

```ts
/** One digested history block. Ids are stable across re-reads (derived from JSONL uuids). */
export type HistoryBlock =
  | { type: 'text'; id: string; text: string; truncated?: boolean }
  | { type: 'thinking'; id: string; text: string; truncated?: boolean }
  | { type: 'tool_call'; id: string; toolCallId: string; name: string; input?: unknown; truncated?: boolean }
  | {
      type: 'tool_result';
      id: string;
      toolCallId: string;
      ok: boolean;
      output?: string;
      error?: string;
      truncated?: boolean;
    };

export interface HistoryMessage {
  /** Stable id: `h:<first-jsonl-uuid>`. Prefix `h:` is contract (§7 replace semantics). */
  id: string;
  role: 'user' | 'assistant';
  /** Epoch ms from JSONL timestamp when parseable. */
  timestamp?: number;
  /** Assistant messages: message.model of the first merged line. */
  model?: string;
  blocks: HistoryBlock[];
}

/** Summary row for session.listHistory. */
export interface HistorySessionSummary {
  /** JSONL basename == CC session id == our runtimeIdentity. */
  runtimeIdentity: string;
  workspacePath: string;
  /** From `ai-title` control line when present (CLI sessions carry it). */
  title: string | null;
  /** First user message preview (system tags stripped, ≤80 chars) or `/command` label. */
  firstMessage: string | null;
  createdAt: number | null;
  lastMessageAt: number | null;
  /** From first assistant line's message.model (system:init absent in real data). */
  model: string | null;
}
```

要点：

- **id 稳定性**：block/message id 派生自 JSONL `uuid`（`h:<uuid>` / `h:<uuid>:<n>`），重复 resume 幂等、React key 稳定，与运行时 id 空间（`user-*` / `asst-*`）不冲突。**`h:` 前缀本身是契约**——store 替换语义依赖它（§7）。
- `tool_result.output` 取 `message.content[].tool_result.content` 字符串化文本；结构化 `toolUseResult` sidecar 不进协议（体积大、MVP 无消费方）。
- thinking 进协议（评审强烈同意：真实 CLI 会话 thinking 密度极高——最大会话 278 thinking vs 44 text 块；且运行时已禁 thinking，历史是 UI 唯一 thinking 来源）。渲染归 C-05/T-04（`ChatBlockType` 届时扩 `thinking`）。
- 无 `system` role：MVP 不重放 system 行（实测 82 条全为运维噪声；`compact_boundary` 分隔线后续纯增量可补）。

## 3. 事件增量（`runtimeEvents.ts`）

### 3.1 `session.history`（核心批量事件）

```ts
export interface SessionHistoryEvent extends RuntimeEventBase {
  type: 'session.history';
  sessionId: string; // AiClient sessionId
  requestId: string; // correlates to the session.resume command
  payload: {
    runtimeIdentity: string;
    workspacePath: string;
    messages: HistoryMessage[]; // chronological
    /** True when messages were dropped by caps (§5.4). */
    truncated: boolean;
    omittedCount: number;
    /** Non-fatal read failure: empty messages + code; session remains usable. */
    error?: { code: 'jsonl_not_found' | 'encrypted_unreadable' | 'read_failed'; message: string };
    /** Diagnostics: control lines are NOT bad lines. */
    parseStats?: { totalLines: number; controlLines: number; badLines: number };
  };
}
```

**时序（会话内保证，读盘异步不阻塞命令循环）**：

```text
session.resumed { runtimeIdentity }
  → session.history { messages[...] }        ← 新增
  → session.status { status: 'idle' }
```

- **running 会话拒绝 resume**（BLOCKER 修复）：Host 侧 `session.resume` 检查会话 running 态，是则回 `host.error { code: 'session_busy' }` 且**不覆盖 registry**；`registry.resume` 改 merge 语义（存在则保留 `abort`/`running`/runtimeIdentity 等运行时字段，仅更新登记信息）。否则重入会孤儿化正在进行的 turn（旧流失去 abort 句柄、busy 检查失效可并发 query）。
- history 读失败**非致命**：照发 `session.history`（`messages: []` + `error`），随后照发 `idle`——会话仍可继续对话。`encrypted_unreadable` 显性区分「Host 不被透明解密」与「文件缺失/损坏」（§5.5）。
- 重试历史 = 对**非 running** 会话再次 `session.resume`。注意并非零副作用（`recordResumed` 会 bump 索引 updatedAt、事件重放），store 灌入本身幂等（§7）。
- `session.create` 不发 history。

### 3.2 `session.historyListed`（listHistory 的响应事件）

```ts
export interface SessionHistoryListedEvent extends RuntimeEventBase {
  type: 'session.historyListed';
  requestId: string; // correlates to session.listHistory
  payload: {
    workspacePath: string;
    sessions: HistorySessionSummary[]; // lastMessageAt desc
    error?: { code: 'encrypted_unreadable' | 'read_failed'; message: string };
  };
}
```

无 `sessionId`（非会话作用域）。Renderer store 忽略；Main 由 `requestAndWait` 捕获转 IPC 返回值（§6）。

### 3.3 `session.updated`（身份富化，补 §1.6 缺口）

```ts
export interface SessionUpdatedEvent extends RuntimeEventBase {
  type: 'session.updated';
  sessionId: string;
  payload: { runtimeIdentity: string };
}
```

- 触发点：`claudeRuntime` send 循环中 `normalizer.ingest` 返回的 runtimeId 与 session 当前值**不同**时发一次（同值不重发）。主场景 = 首次发现（应用内新建会话）；分叉 = 防御性覆盖。
- 消费方：`SessionIndexService.handleRuntimeEvent` 增 case（与 created/resumed 富化同构）；renderer reducer 同步写 session 行 runtimeIdentity。
- **回归钉子（评审要求）**：若升级 Cometix/SDK 后在 resume 会话上观测到 `session.updated`（身份漂移 = 出现了分叉），必须先验证新 JSONL 含全量拷贝历史，才可继续信任单文件读取；否则历史读取需按链合并，届时立项。

### 3.4 `host.ready.capabilities`（能力宣告）

`host.ready.payload` 增可选字段：

```ts
capabilities?: { history?: boolean /* C-05/C-10 后续扩 thinking、effort 等 */ };
```

本次 Host 置 `history: true`。Main/T-03 据此对旧 Host 降级（隐藏历史功能），不依赖超时探测。与执行计划 C-05「`host.ready.payload.capabilities.thinking`」的既定方向合流，对象形态可扩展。

## 4. 命令增量（`agentHost.ts`）

```ts
export interface SessionListHistoryCommand extends AgentHostCommandBase {
  type: 'session.listHistory';
  payload: { workspacePath: string };
}
```

用途：按 workspacePath 列出 `~/.claude/projects/` 下历史会话摘要（含 CLI 等应用外创建的会话）。T-02/T-03 将两源合并：C-07 索引有应用内 title/archived；listHistory 有 CLI 会话（含其 `ai-title` 标题，§2）。

## 5. Host 读取方案（新模块 `src/agent-host/historyReader.ts`）

### 5.1 文件定位

| 路径 | 策略 |
|---|---|
| resume（按 runtimeIdentity 找文件） | ① 正向 munge workspacePath → 候选目录（win32 下对 readdir 名单做**大小写不敏感**匹配），查 `<runtimeIdentity>.jsonl`；② miss 则遍历 `projects/` 各目录 readdir 找同名**文件**（`isFile()` 过滤——项目目录内实测存在子目录）；③ 仍 miss → `error: jsonl_not_found` |
| listHistory（按 workspacePath 列会话） | ① 同上取候选目录（大小写不敏感目录名匹配）；② 逐文件读头部（≤300 行）取真实 `cwd` 校验——**路径归一后比较**（win32：大小写不敏感 + `\`/`/` 归一），不符剔除（防 munge 碰撞）；③ 无候选目录 → 空表（不做全目录内容扫描，成本不可控；大小写匹配已消掉首要 miss 源） |

- 正向 munge：`cwd.replace(/[^a-zA-Z0-9]/g, '-')`（逐字符；3 真实目录验证）。
- 项目根：`CLAUDE_CONFIG_DIR || ~/.claude` + `/projects`；文件过滤 `*.jsonl` 且非 `agent-` 前缀（均与 Scanner 同规则）。

### 5.2 行分类（宽容解析，逐行 try/catch）

| JSONL 行 | 处理 | 计数 |
|---|---|---|
| `type: mode / permission-mode / last-prompt / file-history-snapshot / queue-operation / ai-title / file-history-delta / attribution-snapshot / summary` | 跳过（已知控制记录；`ai-title` 在 listHistory 路径另作标题源） | controlLines |
| 含 `attachment` 字段 | **2026-08-10 修订**：仍跳过、仍计 controlLines，但先过一道用户附件形状闸（`kind: image` / `text` 或带 media type）——命中者暂存为「待认领附件」，由相邻 `type: user` 行认领挂到 `HistoryMessage.attachments`（元数据降级 chip，不读字节不出缩略图）；认领不到即丢弃，绝不因附件问题丢整条消息 | controlLines |
| `isMeta: true` | 跳过 | controlLines |
| `isSidechain: true` | 跳过 | controlLines |
| `type: system` | 跳过（MVP） | controlLines |
| `type: user`，content 为字符串或 text[] | → user `text` block；剥系统标签（同 Scanner `stripSystemTags`）；剥后空但含 `<command-name>` → `/<command>` 文本；剥后全空 → 跳过（**仍断开 assistant 合并**，§5.3） | 正常 |
| `type: user`，content 含 `tool_result[]` | → 按 `tool_use_id` 配对注入（§5.3） | 正常 |
| `type: user`，content **混合** text[] + tool_result[] | tool_result 先配对注入，text 部分再作为独立 user 消息（并断开合并） | 正常 |
| `type: assistant`，content `text` / `thinking` / `tool_use` | → assistant blocks；thinking 仅收非空文本（`signature` 丢弃） | 正常 |
| 压缩续接（"This session is being continued…" user 行） | 按普通 user 文本重放 | 正常 |
| 未知 `type` / JSON.parse 失败 | 跳过 | **badLines** |

> **2026-08-10 变更（带图消息冷重启后 chip 丢失）**：冷重启无内存副本，消息全靠本管线重建，而管线结构性丢弃附件——9a6cc01 的 M1「替换折叠」只救得了同进程 resume。修法为「元数据降级 chip」（`HistoryMessage.attachments?: HistoryAttachment[]`，只有 kind/mediaType/name，无 data、不生成位图缩略图）。真实样本核查（本机全量 jsonl）改写了原设想的载体：**本应用自己发的附件不走 `attachment` 控制行**，而是 `claudeRuntime.buildPromptWithAttachments` 写进 user 行自身 `message.content` 的 `image` / `document` content block（载体 A，真正修好本 bug）；`attachment` 控制行实测 22 种子类型（task_reminder / skill_listing / file / directory / hook_success …）无一携带用户附件元数据，故载体 B 的形状闸对现网数据恒不命中，仅为兜底。另：user 行**只有附件没有文本**时现在也产出消息（blocks 为空 + attachments），此前整条 turn 直接消失。

### 5.3 合并与配对

- **连续 assistant 行合并**为一条 `HistoryMessage`。断开规则（评审收紧）：**任何非 tool_result 的 user 型行——无论其是否被跳过（剥后为空、isMeta 等）——都断开合并**；防止相邻两个 turn 的 assistant 错误并为一条（真实大文件有 18 行剥后为空的 user 行）。
- `tool_result` 依 `tool_use_id` 注入对应 `tool_call` 之后（同一合并消息内）；悬空 `tool_use` 保留无 result（渲染呈现「未完成」）；孤儿 `tool_result` 跳过计 badLines。（配对规则经真实数据模拟：0 孤儿 0 悬空，单条合并消息最多吸收 40 个 API message。）
- 顺序：信任文件行序。实测**可重放行（user/assistant）内时间戳单调**（全行序含控制行有倒序，但控制行全部跳过），不做 uuid/parentUuid 链重建。

### 5.4 裁剪策略（输入输出双侧设防，评审修订）

| 维度 | 上限 | 行为 |
|---|---|---|
| **输入文件大小** | 32 MB（对齐 Main 侧 TSD 缓冲上限先例） | 超限只读尾部 32MB（丢弃首个换行前残行），`payload.truncated = true` |
| 单 block 文本 | user text **64 KB**（压缩续接摘要实测 16-18KB，16KB 会拦腰截断）；其余（assistant text / thinking / tool input/output）16 KB | 头部保留 + block `truncated: true` |
| 消息条数 | 1000（实测最大会话消化后仅 38 条，极充裕） | **环形缓冲流式实现**（边读边裁，不得先堆全量再裁）；保最新，`truncated = true` + `omittedCount` |
| 整包估算预算 | 8 MB | 超预算继续从最旧丢消息 |

**澄清（写进验收）**：裁剪只影响 UI 展示；模型召回上下文由 CC 自己读全量 JSONL 供给，不受此处任何截断影响——验收 §9.1 的「追问召回」不因截断误判。

### 5.5 阻塞与容错

- **不阻塞命令循环**（评审修复）：resume 的 history 读取与 listHistory 处理均异步化（fire-and-forget，模式同 `session.send`）；会话内 resumed → history → idle 顺序由该异步任务内部保证。3.9MB 级读盘期间，其他会话的 stop / permission.respond 正常响应。
- **TSD magic 探测**（评审修复）：读前 peek 文件头 16 字节，命中 `%TSD-Header-###%` → 本 Host 进程不被透明解密 → `error: { code: 'encrypted_unreadable' }`，**绝不静默返回空历史**。该探测写入 T-11⑤ 验收项。
- 其余读取异常 → `error: read_failed` + 空 messages，不抛出、不影响会话注册。
- send 与 history 读盘竞态：由 store 的 `h:` 前缀替换语义兜底（§7）——实时流式消息不会被历史灌入吞掉。

## 6. Main 侧

1. **`AgentHostManager.requestAndWait(command, eventType, timeoutMs = 10_000)`**：发命令，按 `requestId` 等待匹配事件或同 requestId 的 `host.error` → resolve/reject；**订阅 Host 进程 exit → 立即 reject**（不白等超时）；超时 reject（与 `waitForReady` 的「超时且活着则 resolve」哲学不同，此处是查询必须有答案）。旧 Host 回 `not_implemented` → reject 路径已核实成立。仅 `session.listHistory` 使用。
2. **IPC `chat:listHistory(workspacePath)`** + preload 透传 → 返回 `HistorySessionSummary[]`。
3. **`SessionIndexService`**：`handleRuntimeEvent` 增 `session.updated` case → upsert runtimeIdentity + `updatedAt`（fire-and-forget 不抛）。

## 7. Renderer store 灌入（`chatSessions.ts`，Claude 所有权）

reducer 新分支 `session.history`：

- **按前缀幂等替换**（BLOCKER 修复）：只删除该 sessionId 下 **id 以 `h:` 开头**的消息，再按 payload 顺序插入；运行时消息（`user-*`/`asst-*`）与错误消息一概保留。同时消除「history 灌入吞掉正在流式的回复」与 send/history 竞态。
- **不创建 session 行**（行创建归 T-02 listSessions hydrate；**契约前提：T-03 的 resume 入口默认行已存在**——发送依赖行+workspace 存在是现有实现约束）。行存在时 `updatedAt` 取**历史最后一条消息的 timestamp**（评审修正：不得用 `Date.now()`，否则仅查看历史就把会话顶到列表首位）。
- 历史读取 `error` 记入 **per-session** 字段（新增 `historyError?: Record<sessionId, string>` 之类），不占用全局 `lastError`（否则后台会话错误顶掉当前会话提示）；具体 UI 归 T-03。
- **权限卡挂靠规则修订**：`permission.requested` 挂「最后一条 assistant 消息」时**排除 `h:*` 历史消息**（否则 history 灌入后、新 turn 首个 assistant 事件前到达的权限卡会挂到历史消息上）。

## 8. 原开放问题裁定（对抗评审立场 + 主线裁定）

| # | 问题 | 裁定 |
|---|---|---|
| Q1 | system 行入时间线？ | **跳过**（实测 82 条全运维噪声）；`compact_boundary` 分隔线后续纯增量可补 |
| Q2 | listHistory munge miss 时全扫？ | **不做内容扫描**；补 readdir 目录名**大小写不敏感匹配**（miss 首因是大小写漂移而非规则漂移，成本近零） |
| Q3 | thinking 进 MVP？ | **协议携带**（历史是 UI 唯一 thinking 来源——运行时已禁）；渲染随 C-05/T-04 |
| Q4 | 截断数值？ | user text 64KB / 其余 16KB / 1000 条 / 输出 8MB / **输入 32MB tail**；流式裁剪；截断不影响模型召回（写进验收澄清） |
| Q5 | session.updated 并入？ | **并入**（缺口三处代码独立复核为真；不修则 ARD「重启后能找到历史 Session」对内建会话不成立） |
| Q6 | resume 重入语义？ | **「幂等替换安全」论证作废**（评审 BLOCKER）→ 契约层双保险：Host 对 running 会话拒绝（`session_busy`）+ store 按 `h:` 前缀替换；前端拦截仅是 T-03 体验优化 |

## 9. 验收标准（承执行计划 C-06 行）

1. 对真实历史会话 resume → 时间线完整恢复（user/assistant/tool 卡齐全、顺序正确）→ 追问可召回上下文（ORANGE-42 式验法：历史中埋独特事实，追问模型能答出）。**注**：UI 侧截断不影响此项——模型上下文由 CC 读全量 JSONL 供给。
2. 损坏行 / 缺文件 / 超大会话不崩：坏行计 badLines（与控制行分账）、缺文件 `jsonl_not_found` 非致命、TSD 密文 `encrypted_unreadable` 显性报错、超限流式裁剪有标记。
3. **running 会话 resume 被拒**（`session_busy`），运行中 turn 不受影响；history 灌入不吞实时流式消息（`h:` 前缀替换单测）。
4. 测试覆盖：historyReader 行分类（含 4 种新控制行型）/配对/合并断开（剥空 user 行断开、混合行）/双侧裁剪/坏行/TSD magic 单测（真实 JSONL 脱敏样本做 fixtures）；`session.updated` 富化链路单测；registry.resume merge 语义单测；store 前缀替换幂等单测。
5. 三绿（typecheck / lint / test）+ 台账落账 + 总台账协议变更行 + 通知团队。

## 10. 对抗评审落账（fresh-fable，2026-07-24）

裁定 **GO-WITH-CHANGES**，12 条 findings 全部采纳吸收：

| # | 级别 | 要点 | 吸收位置 |
|---|---|---|---|
| F-1 | BLOCKER | resume 重入孤儿化运行中 turn；整段替换吞流式消息 | §3.1 session_busy + registry merge；§7 `h:` 前缀替换 |
| F-2 | MAJOR | 分叉叙事失实（SDK forkSession 默认 false，本项目不传） | §1.6/§3.3 改「首次发现为主 + 分叉防御性覆盖 + 回归钉子」 |
| F-3 | MAJOR | 实测体量 3.97MB/1293 行（非 241KB/66）；缺输入侧防护；压缩摘要被 16KB 击穿 | §1.8/§5.4 双侧裁剪 + 流式实现 + user text 64KB |
| F-4 | MAJOR | Host 非白名单时静默空历史无错误码 | §5.5 TSD magic 探测 + `encrypted_unreadable` + T-11⑤ |
| F-5 | MAJOR | requestAndWait 缺 Host 退出路径；resume 读盘阻塞命令循环 | §6 exit 即 reject；§5.5 异步化 |
| F-6 | MINOR | 遗漏 4 种行型；skippedLines 被控制行污染；ai-title 弃用可惜 | §5.2 补全 + controlLines/badLines 分账；§2 summary.title |
| F-7 | MINOR | 合并断开对「剥空跳过的 user 行」「混合行」未定义 | §5.3/§5.2 收紧规则 |
| F-8 | MINOR | model 取 system:init 在真实数据恒 null | §2 改取首条 assistant 的 message.model |
| F-9 | MINOR | win32 大小写/分隔符归一缺失 | §5.1 大小写不敏感匹配与比较 |
| F-10 | MINOR | updatedAt 用 now 副作用；lastError 全局被顶；权限卡误挂历史消息 | §7 三处契约化 |
| F-11 | NIT | 行序单调性论据、seq 不可依赖、resume 重试非零副作用 | §5.3/§3.1 叙述修正 |
| F-12 | NIT | 新 Main 无法区分新旧 Host；readdir 需 isFile | §3.4 capabilities；§5.1 isFile |
