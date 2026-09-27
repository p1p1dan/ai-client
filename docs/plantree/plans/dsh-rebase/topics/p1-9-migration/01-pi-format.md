# P1-9 分片 01 · pi 会话格式全貌与解码链容错

Role: detail shard。上位：[P1-9 方案](../p1-9-migration.md)。回答调研问题 1。行号指 worktree HEAD `130af7ba`；`src/runtime/`、`src/agent-host/` 的会话代码在 P1-0 之后没有改动。只读了仓库代码、测试与仓库内的基线夹具，没有读任何真实会话。

## 1 文件从哪来：五代格式

| 代际 | 谁写的 | 首行 | 1.0.x 怎么打开 | 依据 |
|---|---|---|---|---|
| pi v1 / v2 / v3 | pi CLI / `pi-coding-agent` 的 SessionManager：P6-1（2026-09-13）之前的 GUI 会话、内嵌 TUI 续聊或 `/new` 出来的「搁浅会话」 | `{"type":"session","version":1\|2\|3}` | 打开时在同目录复制出 `<file>.native-v4.jsonl`，头里记 `importedFrom` 与源 sha256；之后源变了就拒绝（`session_import_source_changed`）；Main 把索引行改绑到副本 | `legacy.ts:127-171,537-623`；`NativeSessionIndexAdapter.ts:64-83`；`piTuiStrandedSessions.ts:21-35`；`piTuiSession.ts:49-62` |
| PI-Desktop schema 1 | 旧 PI-Desktop 导出 | `{"type":"session","schema":1}` | 同上；块记录经 `desktopMessage` 翻成 pi 消息，子代理行变 `legacy:subagent` | `legacy.ts:144-147,235-240,428-510` |
| native v4 | 1.0.x 自有 runtime，写在 `~/.pilab/<profile>/pi-agent/sessions/<逻辑 id>.jsonl` | `{"kind":"header","version":4,…,"type":"session","timestamp":…}`（H/20 起双头） | 直接打开；H/20 之前只有 v4 头的文件，打开时就地升级头 | `nativeWorkerRuntime.ts:1160`；`codec.ts:88-106`；`store.ts:240-249` |
| v4 + CLI 行 | 内嵌 pi TUI 续聊了 GUI 会话，往同一文件追加 v3 行（没有 `kind` / `seq`） | 同上 | 内存里翻成 v4 条目，文件不动 | `codec.ts:291-362,465-483` |
| 导入会话 | CC / Codex 导入（native 写入器） | native v4 | 同 native v4，多两种 custom 条目 | `nativeImport.ts:113-139` |

- pi-agent-core 0.84.4 的 v4 还有 `record` 行（`operation_started`、`usage` 等 9 种），自有 runtime 不写，解码器认（`codec.ts:540-571`）。哪些真实文件里有，未核实（推断：只有 pi SDK 过渡期的文件）。
- 索引里 `runtimeIdentity` 可能指向：native v4 文件；已被 1.0.x 改绑过的 `.native-v4.jsonl` 副本；从没在 native 时代打开过的 v3 原件。第三种要按 1.0.x 的规则先找副本（§4）。

## 2 行与条目类型

**行（`kind`）**（`codec.ts:500-592`）

| kind | 含义 | 迁移关心的 |
|---|---|---|
| `header` | 会话头：`id`、`cwd`、`createdAt`、`metadata`（`importedFrom`、`sourceSha256`、`legacyHeader`、`permissions`）、`parentSessionId` | cwd、createdAt、metadata.permissions |
| `entry` | 条目，带 `id`、`parentId`、`seq`、`lane` | 全部 |
| `lane` | 移动 leaf（回退、重试、导航） | 决定活动分支 |
| `fact` | `name`（会话名）、`label`（条目标签） | 标签 |
| `record` | pi SDK 的运行记录 | 未完成的操作 = 崩溃过 |

**条目（`entry.type`）**（`codec.ts:194-230`）

| type | 内容 | 进不进 pi 的模型上下文 |
|---|---|---|
| `message` | 见下表 | 成功的进；`error` / `aborted` / `deferred` 的助手消息不进（`codec.ts:626-628`、`store.ts:283-304`） |
| `compaction` | `summary`、`tokensBefore`、`retainedTail`（保留的消息副本，可能被截断）、可选 `firstKeptEntryId` | 进：摘要 + 保留尾 + 之后的条目（`pi-agent-core/dist/harness/session/context.js:22-60`） |
| `branch_summary` | `summary`、`fromId` | 进（带前缀的 user 文本，`pi-agent-core/dist/harness/messages.js:7-11,78-83`） |
| `model_change` / `thinking_level_change` / `active_tools_change` | 簿记 | 不进 |
| `custom` | `customType` + `data` | 不进（没有注册投影器） |

**消息角色（`message.role`）**（`codec.ts:153-184`）

| role | 字段 | 备注 |
|---|---|---|
| `user` | `content`（字符串或块：`text`、`image{data,mimeType,aiclientName?}`）、`timestamp` | `aiclientInternal` 标记内部消息：`subagent-report`、`project-instructions`、`turn-ceiling`（`shared/internalMessage.ts:38-61`）；`aiclientName` 是附件文件名（`shared/attachmentRider.ts:53-70`） |
| `assistant` | pi-ai 的 AssistantMessage 原样：`content`（`text{textSignature?}`、`thinking{thinkingSignature?,redacted?}`、`toolCall{id,name,arguments,thoughtSignature?}`）、`api`、`provider`、`model`、`responseId?`、`usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`、`stopReason`（stop / toolUse / length / error / aborted / deferred）、`errorMessage?` | 导入的助手消息 `provider:'legacy-import'`、用量全 0（`nativeImport.ts:73-82,149-173`） |
| `toolResult` | `toolCallId`、`toolName`、`content`（文本 / 图片块）、`isError`、`details?`（`patch`、`refused`、`stopped`、fs 预览） | 崩溃后补的结果文本固定（`recovery.ts:6-27`） |
| `custom` | pi 扩展消息：`customType`、`content`、`display` | 按 user 文本进上下文 |
| `bashExecution` | TUI 的 `!命令`：`command`、`output`、`exitCode`、`excludeFromContext?` | 按 user 文本进，除非 `excludeFromContext` |
| `compactionSummary` / `branchSummary` | 只在构造上下文时出现 | — |

**自有 custom 条目**

| customType | 写入方 | 数据 | 依据 |
|---|---|---|---|
| `aiclient.permissions` | 每次运行开始时档位变了就写 | `{mode, gear}`；旧档位值经 `migratedPermissions` 兼容 | `agent-loop/index.ts:1077-1088`；`legacy.ts:26,82-99` |
| `aiclient.permissionGrants` | 用户选「本会话允许」、换 mode 时写空集 | `{version:2, grants:[path/command/value]}`，活动分支上最后一条为准 | `permissions/index.ts:479-491`；`grants.ts:288-363` |
| `aiclient.runStop` | 用户 Stop 或 Ctrl+Enter 插话 | `{cause:'user_stop'\|'interjected', runId}` | `agent-loop/index.ts:1433-1449`；`sessionHistory.ts:139` |
| `aiclient.loopGuard` | 子代理防死循环留证 | 诊断数据 | `agent-loop/index.ts:1404-1419`；`sessionHistory.ts:152` |
| `aiclient.subagent` | 委派的开始、消息、结算 | `kind: started \| message \| settled`，委派记录总量上限 2 MiB | `subagent/records.ts:39-78`；`subagent/index.ts:166,686-700` |
| `aiclient.legacy-import.provenance` / `.display` | CC / Codex 导入 | 来源说明；只供展示的工具行、附件、诊断 | `legacyImport.ts:13-14`；`nativeImport.ts:113-139` |
| `aiclient.v4`、`pi-cli:*`、`legacy:*` | 与 CLI 共用文件时的簿记行；CLI 行里不认识的类型；旧格式转换的遗留 | 惰性条目 | `codec.ts:119-123,301-309`；`legacy.ts:343` |

`INTERNAL_CUSTOM_ENTRIES` 列出了哪些 custom 不上线也不显示（`legacy.ts:45-66`）。另外还有 `aiclient-session-tier`、`permission-tier` 两个旧档位条目，只在读取时兼容（`legacy.ts:76-80`）。

## 3 分支与 leaf

- 会话是一棵条目树：`parentId` 连父，`lane` 行移动 leaf。活动分支 = 从 leaf 沿 `parentId` 回到根（`codec.ts:614-624`）。
- 分支的来源：
  - 重试上一轮（T135）：把 leaf 移回失败回复之前，失败回复留在旁支（`retry.ts:1-86`，`retryCut` 在 `:46`）；
  - 回退：目标是用户消息时，leaf 移到它的父节点（`store.ts:535-561`）；
  - TUI 与 GUI 交替写：CLI 行挂在 CLI 的尾巴上（`codec.ts:512-523`）。
- fork 是另一个文件、另一个索引行（`store.ts:594-645`），迁移时各自独立处理。
- 1.0.x 的历史只显示活动分支；树对话框显示全部分支与标签（`piSessionTree.ts`）。

## 4 已知损坏与截断形态，以及现有容错

| 形态 | 现有处理 | 迁移怎么办 |
|---|---|---|
| 残尾（追加被打断） | 最后一行解析失败且不以 `}` 结尾 → 截掉（`codec.ts:144-146,426-435`） | 内存里截掉，源文件不写；报告计数 |
| 中间行解析失败（崩溃留下的半行） | 最多丢 64 行，超过就拒绝（`codec.ts:50,436-462`） | 同上 |
| seq 跳号（CLI 行插进来） | 按 CLI 行数给余量（`codec.ts:484-498`） | 同上 |
| 头缺 v3 字段（H/20 之前） | 打开时就地升级（`store.ts:245-249`） | 不写，照读 |
| 未完成的 SDK 操作 | 拒绝：`session_operation_unfinished`（`codec.ts:595-599`） | 需要新选项：容忍，按「崩溃过」处理，最后一回合以 `interrupted` 收尾 |
| 重复 id、缺父、lane 指向不存在的条目、簿记别名成环 | 拒绝：`session_invalid`（`codec.ts:251-262,503-538`） | 迁移失败，报错误码，预览照旧（预览同样会失败） |
| 空文件 | `session_invalid`（`legacy.ts:512-535`） | 同上 |
| 超过 32 MiB | 所有路径都拒绝（`codec.ts:20`；`SessionReplayReader.ts:114-118`） | 沿用同一上限，报 `source_too_large` |
| 非法 UTF-8 | 解码失败（`SessionReplayReader.ts:125-134`） | 迁移失败 |
| 标签指向不存在的行 | 旧格式转换时丢掉（`legacy.ts:353-372`） | 丢掉，计数 |
| v3 原件在副本生成后又被改（TUI 续聊了原件） | 拒绝：`session_import_source_changed`（`legacy.ts:611-618`） | 迁移失败，报专门的错误码；两份各自保留 |

## 5 解码链与副作用

- 只读链（Main 预览用）：读字节 → 认首行 → 旧格式在内存里 `convertLegacySession` → `decodeSession` → `branchEntries` → `projectPiSessionHistory`（`SessionReplayReader.ts:14-31,157-207`）。不加锁，不写回，不碰 mtime。
- 会写文件的入口，迁移一律不能用：
  - `JsonlSessionStore.open`：取写锁（旁边建 `.lock`），写回修复、升级头（`store.ts:188-277`）；
  - `prepareSessionConfig`：写 `.native-v4.jsonl` 副本并加锁（`legacy.ts:537-623`）。
- 非确定性：`convertLegacySession` 用 `randomUUID()` 生成头 id、缺 id 的行、授权条目和 lane 行（`legacy.ts:184,219,383,395`）。迁移要换成由（源 sha256，行号）派生的确定 id，否则种子不是纯函数。
- 运行期依赖：`codec.ts`、`legacy.ts` 从 `@earendil-works/pi-agent-core` 取类型和 `buildSessionContext`（`codec.ts:1-6`；`legacy.ts:3`）。宿主包里只有 `pi-ai`，没有 `pi-agent-core`（`src/dsh-host/node_modules/@earendil-works/`）。`buildSessionContext` 只用到压缩与分支摘要的几十行逻辑（`pi-agent-core/dist/harness/session/context.js:22-66`），MIT 许可，可以 vendor。
- 仓库里现成的真实形状样本：`docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908/B01～B06/sessions/*.jsonl`，6 份 v3 记录，3.7～110 KB，含压缩（`sessionLegacy.test.ts:78-137` 已经在用）。它们是测试基线，不是用户数据。
