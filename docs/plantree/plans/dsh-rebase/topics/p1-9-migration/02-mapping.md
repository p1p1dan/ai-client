# P1-9 分片 02 · 映射全表（pi → DSH、导入 → DSH、设置）

Role: detail shard。上位：[P1-9 方案](../p1-9-migration.md)。回答调研问题 2、5、6。pi 侧事实见[分片 01](01-pi-format.md)，DSH 侧事实与出处见[分片 03](03-dsh-facts.md)。本分片是设计，没有实现和运行过；「保真」一列是设计目标，要靠分片 05 的金样本与实验验证。

## 0 总原则

- **输入**：活动分支上的条目（D3 A），按文件顺序。旧格式先在内存里 `convertLegacySession`，缺 id 的行用（源 sha256，行号）派生确定 id。
- **输出**：一串从 seq 0 连续的 DSH 事件（种子），外加：待入库的图片清单、授权 sidecar 内容、`legacyPermissions`、迁移报告。
- **纯函数**：同一份源字节加同一版转换器，种子逐字节相同。时间一律取条目自己的 `timestamp`，不取当前时间。
- **模型可见内容与 1.0.x 一致**，唯一例外是 D6（被 Stop 的半截回复）。只供展示或留档的数据走 `ignorable` 事件（D4），不进模型上下文。
- **消息 id 复用 pi 条目 id**（D7）。合成的消息用「条目 id + 后缀」，例如 `<id>:sys0`、`<id>:unknown-result:<callId>`。

## 1 pi 条目 → DSH 事件

| pi 来源 | DSH 事件 | 保真 | 说明 |
|---|---|---|---|
| 头 `cwd` | `agents.create` 的 `meta.cwd` | 无损 | DSH 头里的 cwd 以后不能改；必须与索引行的 `workspacePath` 一致 |
| 头 `createdAt` | 无法设置（`meta` 不收 `createdAt`） | 有损 | DSH 头是迁移时间；原值记进桩 `origin.sourceCreatedAt`。侧栏看索引，不受影响 |
| 头 `id`、`metadata.importedFrom` / `sourceSha256` | 桩 `origin` | 换载体 | `legacyHeader`、`parentSessionId` 丢弃 |
| （合成）第一回合的开头 | `turn/start{1}`、`step/start{1,1}`、`system/message{content:[]}` | 合成 | 空的系统节点占住 0 号位，恢复后第一步原地换成 DSH 提示词 |
| user（人类） | `user/message {id, role:'user', content, source:{kind:'user'}}`，`surfaceOp:'append'` | 无损 | 字符串 content 转成一个 text 块 |
| user / 工具结果里的 image 块 | 先经 `ctx.attachments` 入库，得到 `{type:'image', attachment}`；`aiclientName` 作显示名 | 可能有损 | 超过 2048² 像素、4 MiB 或非「干净」格式会被重编码；入库失败换成文本占位 `[image not migrated: <mediaType>]`，计数 |
| user（`aiclientInternal`） | `user/message`，`source:{kind:'aiclient-pi-internal', origin}` | 无损 | 模型照旧可见，界面照旧隐藏（P1-4 投影「其他来源 → 隐藏」） |
| assistant（stop / toolUse / length） | `assistant/message {turn, step, message:{id, role:'assistant', content, source:{kind:'model', provider, model, replayState}}, usage, stream:[]}` | 无损（流时序除外） | 块：`text`→`text`，`thinking`→`reasoning`，`toolCall`→`tool-call`（`arguments` 为 `JSON.stringify` 结果）；助手侧 image 块丢弃（pi-ai 适配器也不收）。`usage` 按 `mapUsage`；`cost` 丢弃（1.0.x 恒为 0） |
| 同上的 `replayState` | `{response:{kind:'pi-ai', version:2, api, provider, model, responseId?, providerThinkingLevel?, stopReason}, blocks:[…签名]}` | 无损 | 与 DSH 的 `toPiReplayState` 同形；块不能一一对应（丢过块）时省略，适配器降级为普通历史 |
| 助手消息里的 toolCall 块 | 每个一条 `tool/call {turn, step, callId, name, arguments}`，紧跟 `assistant/message` | 无损 | 与 loop 的派发时机一致 |
| toolResult | `tool/result {turn, step, message:{id, role:'tool', content, source:{kind:'tool', callId}, toolCallId, isError}, meta:{aiclient:{piDetails}}}` | 无损 | `toolName` 由调用块推出；`details`（`patch`、`refused`、`stopped`、fs 预览）放进 `meta`，投影读它恢复标志 |
| 崩溃后补的结果（`recovery.ts:22` 那段固定文本） | 同上，再加 `error:{name:'LegacyInterrupted', code:'TOOL_OUTCOME_UNKNOWN'}` | 无损 | 投影据此显示 `outcomeUnknown` |
| 回合结束时仍悬空的调用 | 合成 `tool/result`，文本用 DSH 的 `TOOL_OUTCOME_UNKNOWN` 说法，`isError:true` | 合成 | 与 DSH 恢复时的修补一致；否则下一次请求会带着没有结果的工具调用 |
| 与调用对不上的孤儿结果 | `aiclient/pi-entry`（ignorable） | 有损（模型） | 1.0.x 的上下文里有它，迁移后没有；界面照 1.0.x 显示成独立工具行需要投影规则；罕见，计数 |
| assistant aborted，有正文 | `assistant/message {interrupted:true}`，去掉 toolCall 块 | 语义变化（D6） | DSH 自己 Stop 时就这样落盘，模型之后看得到这段前缀；1.0.x 看不到 |
| assistant aborted，无正文 | `assistant/attempt {stream:[]}` | 无损 | 「aborted 回合没有 assistant/message」在 DSH 里就表示没流出可见内容 |
| assistant error | `assistant/attempt {stream:[]}`；回合以 `error` 收尾，`message` 取 `errorMessage` | 部分有损 | 失败回复若有半截正文，界面不再显示（计数） |
| assistant deferred | `assistant/attempt` | 无损 | pi 同样不进上下文 |
| compaction | `user/message {id:<条目 id>, content:[DSH 检查点框住的摘要], source:{kind:'compact-checkpoint', compactionId:<条目 id>}}`，`surfaceOp:{op:'replace', startSeq, endSeq}`，`sourceEventSeqs` = 被遮住的全部节点 | 近似无损 | 区间从第一个非系统节点开始，到保留尾之前为止；保留尾按（role，timestamp）在活动分支上定位，与 `store.ts:339-349` 同法。定位到时保留原件（比 pi 截断过的副本略大）；定位不到就遮到压缩点为止，只留摘要（与 CLI 的降级一致）。`tokensBefore` 丢弃 |
| branch_summary | `user/message`，`source:{kind:'aiclient-pi-branch-summary'}`，正文为 pi 的前缀 + 摘要 + 后缀 | 无损 | 界面照 1.0.x 显示为「Context summary」，要一条投影规则 |
| custom 角色消息 | `user/message`，`source:{kind:'aiclient-pi-custom', customType}` | 无损 | 模型可见、界面隐藏，都与 1.0.x 一致 |
| bashExecution | `user/message`，`source:{kind:'aiclient-pi-bash'}`，正文为 `bashExecutionToText` | 无损 | `excludeFromContext` 的不转，计数 |
| `model_change`、`thinking_level_change`、`active_tools_change` | 不转 | 有损（簿记） | 历史助手消息自带 provider / model；首次真实请求会记 `request/header` |
| `aiclient.runStop` | 决定 `turn/end` 原因（§2） | 无损 | — |
| `aiclient.permissions` | 迁移结果里的 `legacyPermissions` | 换载体 | 见 §4 |
| `aiclient.permissionGrants` | 授权 sidecar | 换载体 | `restoredGrants(活动分支)` → `encodeGrants`（v2）；空集不写文件 |
| `aiclient.subagent` | `aiclient/pi-subagent`（ignorable，原样） | 数据无损 | 迁移后委派面板暂不恢复，要不要渲染归 P1-7 |
| `aiclient.loopGuard`、`legacy:*`、不认识的 custom | `aiclient/pi-entry {customType, data, entryId}`（ignorable） | 数据无损 | 只留档，不显示 |
| `aiclient.legacy-import.provenance` / `.display` | `aiclient/legacy-provenance` / `aiclient/legacy-display`（ignorable） | 界面无损 | 投影照 1.0.x 渲染（`piSessionTimeline.ts:208-288` 的两段规则搬过去） |
| `aiclient.v4`、`pi-cli:*` 簿记行 | 不转 | — | 纯结构 |
| `fact name` | 不转 | 有损（无影响） | 以索引标题为准 |
| `fact label` | `aiclient/pi-label {targetMessageId, label}`（ignorable） | 数据无损 | 树对话框暂不显示标签 |
| 非活动分支上的条目 | 不转（D3 A） | 有损 | 计数：旁支叶子数、条目数；原文件里还在，回装可见 |
| `record` 行 | 不转 | — | 只用来判断「最后一次运行崩溃了」 |

- ignorable 事件统一形如 `{type:'aiclient/<名>', seq, time, data, ignorable:true}`，只出现在种子里。投影同时认 `plugin:aiclient/<名>`：DSH 的格式迁移会给不认识的 ignorable 事件加 `plugin:` 前缀（分片 03 §4）。
- 种子末尾由构造器自动补一个不带标记的 `session/end-seed`，标出「迁移来的历史」与之后的实时回合的分界。

## 2 回合与步的切分，以及结束原因

**切分**

- 新回合从这些消息开始：人类 user 消息；`aiclientInternal:'subagent-report'`（1.0.x 的自动续跑本来就是一次新运行）。`project-instructions`、`turn-ceiling` 不开新回合，进下一步的输入。
- 每条助手消息一个 step：`step/start` → 本步输入的 user 消息 → `assistant/message`（或 `assistant/attempt`）→ 全部 `tool/call` → 陆续的 `tool/result` → `step/end`。
- 工具结果并进它所属的 step，即使中间隔着 custom 条目；下一条助手消息或下一回合开始时才关闭这一步。
- 回合开头没有 user 消息、直接是助手消息的（极少见，比如旧导入）：照样开回合，不补 user 消息，计数。

**`turn/end` 原因**

| 1.0.x 的情形 | DSH 原因 |
|---|---|
| 最后一条助手消息正常结束 | `completed` |
| 有 `length` | `max-tokens` |
| `aiclient.runStop` 为 `user_stop` | `aborted{reason:{kind:'user'}}` |
| `aiclient.runStop` 为 `interjected` | `aborted{reason:{kind:'hook', reason:'aiclient-interject'}}`（与 P1-4 D4 一致） |
| 助手消息 aborted，但没有 runStop 记录 | `aborted{reason:{kind:'legacy'}}` |
| 助手消息 error | `error{error:{message:errorMessage 或 'Legacy run failed', code:'UNKNOWN'}}` |
| 运行中途断掉（悬空调用、未完成的 record、文件在回合中间结束） | `interrupted` |

## 3 CC / Codex 导入 → DSH（D8）

输入是 Main 现成的 `ImportedConversation`（`shared/types/legacyImport.ts:73-119`），扫描与清洗不变。

| 导入条目 | DSH 事件 | 说明 |
|---|---|---|
| 会话级来源信息 | seq 0 处一条 `aiclient/legacy-provenance`（ignorable），字段同 `nativeImport.ts:113-128`；桩 `origin` 另记一份 | 界面照 1.0.x 显示来源说明 |
| `user` | 开新回合；`user/message`（text） | 附件诊断本来就是 display 行 |
| `assistant` | 一个 step；`text`、`thinking`、`tool_call` 块同 §1；`source:{provider:'legacy-import', model:entry.model 或 conversation.model 或 sourceKind}`；不带 `usage`、不带 `replayState` | 1.0.x 写的是全 0 用量，这里直接不写，会话累计只算本应用花的 |
| `tool_result` | `tool/result` | 与上一步的调用配对；配不上的转 display |
| `display` | `aiclient/legacy-display`（ignorable），数据同 `nativeImport.ts:93-109` 的 v1 形状 | 只供展示，不进模型上下文，由构造保证 |
| 回合收尾 | `turn/end completed` | 导入源没有失败信息 |

- 消息 id：`imp-<dedupeKey 前 12 位>-<序号>`，确定性。
- 沿用 1.0.x 的两条校验：至少保留一条助手回复；展示行不进模型上下文（`nativeImport.ts:186-204`）。第二条在 DSH 下由「display 只写成 ignorable 事件」保证，仍然断言一次。

## 4 设置与按会话偏好（调研问题 5）

| 项 | 1.0.x 在哪 | DSH 构建 | P1-9 做什么 |
|---|---|---|---|
| 模型、effort | 索引行 `model`；localStorage `aiclient:chat:session-models` / `session-efforts`；设置 `chatAgentDefaults`（`sessionPreferenceStore.ts:12-26`） | 同一份，继续存我方 `provider/modelId`（决策 035） | 不迁移（D2 A 下逻辑 id 不变）。协议被过滤掉的模型由 P1-5 的菜单兜底，报告里计数 |
| mode / gear | localStorage `aiclient:chat:session-permissions`（旧键 `session-tiers`，`sessionPreferenceStore.ts:14,143-157`）；Main 内存；pi 文件 `aiclient.permissions` | P1-6：bootstrap 按 payload 播种 | 不迁移。迁移结果带回文件里最后一次的档位 `legacyPermissions`，只在渲染层没发档位时用。这与 1.0.x 的 `{...文件, ...payload}` 等价（`runtime/bootstrap.ts:371-379`；渲染层发 `会话值 ?? 默认值`，`useResumeSession.ts:50`） |
| 会话授权记忆 | pi 文件 `aiclient.permissionGrants`（v2，活动分支最后一条） | 桩旁 sidecar（决策 043） | 迁移：原子写 sidecar。授权里的 `tool` 取策略面词表（read / write / edit / bash…），与 P1-6 分类表一致；P1-6 若改词表，这里跟着映射 |
| 默认档位、默认模型、全局策略文件 | localStorage 默认键；设置；pi-agent 目录下的策略文件 | 不变；P1-6 经 `AICLIENT_PERMISSION_AGENT_DIR` 直接读 | 不迁移 |
| 缓存 TTL、空闲超时、重试 | 设置 | P1-5 在运行期翻译 | 不迁移；设置页加三条说明（`subagentPromptCacheTtl` 失效、空闲超时 0 的新含义、不受支持的协议），由 P1-5 转交 |
| 标题、归档、unbound、工作区 | 索引行 | 同 | 随行保留：改键的 pi 行、改绑的 DSH 行各一份 |
| 回装后的偏好 | — | — | 迁移时渲染层把上面四个 localStorage 键在旧 id 下的值复制到改键后的 pi 行 id 下（只增不删），回装后档位和模型还在 |
| skills、prompts、子代理定义、`mcp.json`、全局 `AGENTS.md`、pi 插件 | pi-agent 目录 | DSH 各有自己的机制 | 不在 P1-9 范围，roadmap 没人认领（方案 §8） |

## 5 报告里的计数类别

每个会话一行，全部是数字、枚举或哈希，不含正文、标题、路径、文件名：

- 源：格式代际；字节数；sha256（前 16 位）；条目数（按 type / role）；分支叶子数；被跳过的坏行数；是否有残尾 / 未完成操作。
- 结果：事件数（按 type）；回合数、步数；图片数（原样通过 / 重编码 / 失败）；ignorable 事件数（按名）；sidecar 授权条数；`legacyPermissions` 有无。
- 有损：非活动分支条目数；标签数；簿记条目数；error 回复被丢的正文条数；D6 影响的回复数；孤儿结果数；`excludeFromContext` 条数；压缩尾巴没找到锚点的次数；被过滤协议的模型。
- 失败：阶段（read / decode / build / admit / create / verify / sidecar / stub）加错误码。
- 性能：耗时、宿主 RSS 峰值增量。
