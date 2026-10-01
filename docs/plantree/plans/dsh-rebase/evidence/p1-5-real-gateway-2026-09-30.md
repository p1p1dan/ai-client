Role: evidence

# P1-5 真实网关验证 R1～R10（2026-09-30，Linux 开发机）

依据 [P1-5 分片 05 §4](../topics/p1-5-models-and-credentials/05-changes-and-tests.md#4-真实网关验证清单用户授权后执行) 的 R1～R10。用户授权见[决策 130](../decisions/130-user-rulings-2026-09-29-batch3.md)，2026-09-30 用户选择在本机做，并亲自在应用里登录了公司账号。逐项结果 JSON 与请求台账（`results/requests.jsonl`）含网关原始错误体与上游编号，按公开仓库规则只留在开发机本地，不入库，驱动脚本在 [tools/](p1-5-real-gateway-2026-09-30/tools/)。本次没有改 `src/`，没有截图（登录后侧栏一直显示账户邮箱，登出后注册页列出邮箱域名，页面文字都含 `@`，按规则不截）。

## 结论先行

| # | 结论 | 一句话 |
|---|---|---|
| R1 | ✅ | 来源 `remote`（渲染层目录 `managed`、非 stale），13 个模型、4 个 provider、3 种协议；菜单 4 组共 13 项，与目录一致；`unavailable` 为 0 |
| R2 | ⚠️ | 13 个模型都跑了：10 个 ✅；China 组 3 个（GLM 5.3、DeepSeek V4 Flash、DeepSeek V4 Pro）两次都是网关 503 `no_available_providers`（GW-1）；Opus 5.5 这次没有遇到流闸门 |
| R3 | ✅ | 三种协议各一次 `echo ok`：审批卡出现、点允许、工具行完成、回答 `ok`、回合收尾 |
| R4 | ✅ | 三种协议各一个推理模型，菜单里的每个档位都跑了（共 15 档 + 默认）；会话日志 `reasoningEffort` 与所选全部一致。GPT 6 Luna「关闭」首跑遇传输错误失败，重试一次成功（GW-3） |
| R5 | ✅ | 同一会话 Claude → GPT → Claude，暗号与轮数都答对 |
| R6 | ✅ | 三种协议各发一张纯色 PNG，红 / 蓝 / 绿都答对；Grok 另外调了一次 `read_image`，审批卡 120 秒超时后仍答对（GW-9） |
| R7 | ✅ | 提交信息、分支名、代码评审各跑「自动」与「指定模型」一次，结果都正常；评审中途停止生效。分支名生成在本构建没有界面入口（GW-7） |
| R8 | ⚠️ | 登出链路 ✅；在飞回合被登出打断 ✅（补验，GW-13：回合按「停止」收尾，不算失败）；重新登录后客户端侧（宿主冷启动、凭据分发、发送）✅ 正常，但两次尝试都在网关侧失败（`cache_limit` / 503），预算用尽，**没有验到一次完整拿到回答的回合**（GW-16、GW-17）；重开被打断的那一轮仍冻结显示「已工作 1 秒」，没有停止注记（GW-18，延伸 GW-13） |
| R9 | 📝 | 给网关管理员的说明草稿见 §R9，请用户转达 |
| R10 | ✅（近似） | 按形状扫描：凭据库以外没有任何形如 key / Bearer / JWT 的字符串；凭据库本身在本机是明文存放（无系统钥匙串，`enc: none`，设计如此），登出后已清空 |

- **请求计数：50 / 60**（每发一条消息、每跑一次补全算 1 次）。按凭据代理日志统计，实际发往网关的 HTTP 请求约 79 次：工具回合要两步，另有 25 次是客户端自动重试（GW-2、GW-3）。
- 没有读取或打印任何 key、token、Cookie、请求头；除 R10 扫描和下文注明的两处枚举字段外，没有读凭据文件。

## 环境

- 分支 `feat/dsh-p0-probe`，提交 `5e29f08d`；开发版 `scripts/dev.js`（应用版本 `1.1.0-dsh.2`），公司登录模式（`AICLIENT_MANAGED_CREDENTIALS=1`，dev.env 只有占位 token）。
- 隔离 HOME `/tmp/aiclient-real-gw/home`，工作区 `/tmp/aiclient-real-gw/workspace`，CDP 端口 9222。应用由用户启动并登录，全程没有重启。
- 宿主：一个共享 DSH 宿主（`src/dsh-host/host.ts`，g1），12:06 随第一条消息启动，12:57 随登出关停。
- 时间：本地 12:06～12:57（UTC 16:06～16:57）。机器时区 UTC-4。
- 驱动：只经应用界面发请求（输入框 + 发送按钮、模型菜单、Git 面板按钮）；分支名一项走界面同一个 preload 方法（见 R7）。没有直接调网关，没有用其他渠道，也没有起假网关。

## 请求计数

| 项 | 次数 | 说明 |
|---|---|---|
| R2 | 16 | 13 个模型各 1 次 + 3 个失败模型各重试 1 次 |
| R3 | 3 | 每种协议 1 次工具回合 |
| R4 | 16 | GPT 6 Luna 6 档 + Claude Sonnet 5.5 5 档 + Grok 4.7 4 档 + 「关闭」重试 1 次（「默认」档复用 R2） |
| R5 | 3 | 同一会话三轮 |
| R6 | 3 | 每种协议 1 张图 |
| R7 | 7 | 提交信息 2、分支名 2、代码评审 3（自动、指定、中途停止） |
| R8 | 2 | 第 1 次选择器没点到「退出登录」，回合正常结束；第 2 次登出成功 |
| 合计 | **50** | 上限 60 |

## R1 目录与计划

| provider | 协议 | 模型数 | 菜单分组 |
|---|---|---|---|
| claude | `anthropic-messages` | 3 | Claude：Sonnet 5.5、Opus 5.5、Opus 5 |
| gpt | `openai-responses` | 4 | GPT：6.1 Sol、6 Astra、5.6 Terra、6 Luna |
| grok | `openai-completions` | 2 | Grok：4.7、4.6 |
| china | `openai-completions` | 4 | China：GLM 5.3、DeepSeek V4 Flash、DeepSeek V4 Pro、GLM 5.2 |

- 同步状态（`piModels.getStatus`，只取枚举与计数，不取地址）：`managed: true`、`source: remote`、`modelCount 13`、`providerCount 4`、没有失败记录。渲染层目录（`chat.listPiModels`）：`source: managed`、`stale: false`、13 个模型、`unavailable: []`。
- 每个 provider 的协议：从 `pi-agent/models.json` 用白名单提取，只输出 `providers.*.api`（先与已知协议名比对）和模型数，其他字段一概不读出。china 有模型单独声明了 `openai-completions`，与 provider 一致。
- 菜单与计划一致：4 组 3 + 4 + 2 + 4 = 13 项，与目录逐项对上。各模型的档位（`efforts`，来自计划）：Claude 三个是 低～最高（Sonnet 5.5 / Opus 5.5 的「关闭」被计划去掉，原因 `adaptive_thinking_forced`，符合决策 141）；GPT 四个是 关闭～最高；Grok 4.7 是 低 / 中 / 高 / 最高，Grok 4.6 是 低～极高；China 四个是 低 / 中 / 高 / 最高，DeepSeek 两个与 GLM 5.2 另有「关闭」。
- 计划在 11:50 登录同步后记下的剔除字段（`[dsh-model-plan] left out of the plan`）：
  - 4 个 provider 的 `headers.User-Agent` 都被当作保留头去掉（`reserved_header`，决策 037），见 R9；
  - claude 的 `compat.supportsToolReferences`（provider 与 3 个模型）不在 DSH 提供的键里（`compat_not_offered`）。
- 结果：`r1-catalog.json`。

## R2 逐模型

每个模型新建会话，档位选「默认」，发「只回复 OK」。耗时从点发送到回合结束（store 连续三次空闲，已扣掉 0.75 秒读数）。「首字」是渲染层收到第一个非空 assistant 文本增量的时间；第 1～5 次的记录器把用户回显也算成了增量，数值作废，记 n/a。

| # | 模型 id | 协议 | 结果 | 错误码 | 耗时 | 首字 |
|---|---|---|---|---|---|---|
| 1 | `claude/claude-sonnet-5-5` | anthropic-messages | ✅ OK | — | 8.0 s | n/a |
| 13 | `claude/claude-opus-5-5` | anthropic-messages | ✅ OK（无流闸门） | — | 6.7 s | 6.8 s |
| 2 | `claude/claude-opus-5` | anthropic-messages | ✅ OK | — | 6.1 s | n/a |
| 3 | `gpt/gpt-6.1-sol` | openai-responses | ✅ OK | — | 8.8 s | n/a |
| 6 | `gpt/gpt-6-astra` | openai-responses | ✅ OK | — | 10.7 s | 9.5 s |
| 7 | `gpt/gpt-5.6-terra` | openai-responses | ✅ OK | — | 13.0 s | 11.5 s |
| 8 | `gpt/gpt-6-luna` | openai-responses | ✅ OK | — | 8.8 s | 8.1 s |
| 4 | `grok/grok-4.7` | openai-completions | ✅ OK | — | 5.4 s | n/a |
| 9 | `grok/grok-4.6` | openai-completions | ✅ OK | — | 5.3 s | 4.6 s |
| 12 | `china/glm-5.2` | openai-completions | ✅ OK | — | 6.2 s | 5.9 s |
| 5 / 45 | `china/glm-5.3` | openai-completions | ❌ 两次都失败 | `PROVIDER_ERROR`（HTTP 503 `no_available_providers`） | 31.1 s / 35.4 s | — |
| 10 / 46 | `china/deepseek-v4-flash-0731` | openai-completions | ❌ 两次都失败 | 同上 | 33.6 s / 34.4 s | — |
| 11 / 47 | `china/deepseek-v4-pro-0813` | openai-completions | ❌ 两次都失败 | 同上 | 31.5 s / 33.1 s | — |

- 13 个模型全跑，没有抽样（只比 12 多一个，预算够）。
- 回答只有「OK」，首字几乎就是回合结束；个别首字比耗时略大，是因为耗时扣掉了 0.75 s 的空闲读数。
- 「默认」档在会话日志里记为 `reasoningEffort: medium`（抽查 4 个会话），与菜单提示「中：没有选择档位时使用这一档」一致。
- 失败的 3 个：网关回 503，正文说明网关过滤了全部 17 个上游：7 个 `disabled`，6 个 `format_type_mismatch`，4 个 `model_not_allowed`。三个模型、六次失败完全一样。同一 provider、同一协议的 GLM 5.2 正常。归类为网关侧配置（这些模型没有可用的 chat-completions 上游），见 GW-1。每次失败前客户端都自动重试了 3 次，所以 30 多秒才失败（GW-2）。

## R3 工具回合

提示「请用 shell 工具执行命令 echo ok，然后只回复该命令的输出」，档位「默认」，权限挡位「执行 · 每次询问」。

| 协议 | 模型 | 结果 | 过程 |
|---|---|---|---|
| anthropic-messages | Claude Sonnet 5.5 | ✅ | 8.1 s 出审批卡 → 点「直接允许」→ `bash echo ok` 完成 → 回答 `ok`，共 12.2 s |
| openai-responses | GPT 6 Luna | ✅ | 7.4 s 出卡 → 允许 → 完成 → `ok`，共 14.0 s |
| openai-completions | Grok 4.7 | ✅ | 6.8 s 出卡 → 允许 → 完成 → `ok`，共 9.6 s |

三次都只调一次工具，结果非错误，回合正常收尾。

## R4 档位矩阵

每种协议一个推理模型、一个会话，按菜单顺序逐档切换后发「只回复 OK（档位：X）」。「默认」档复用 R2（日志为 `medium`）。日志列是 `effort-log.mjs` 从 `session.v4.jsonl.zstd` 的 `request/header` 事件里读出的 `header.config.reasoningEffort`，只读这一个字段。

| 协议 / 模型 | 默认 | 关闭 | 低 | 中 | 高 | 极高 | 最高 |
|---|---|---|---|---|---|---|---|
| openai-responses / GPT 6 Luna | ✅ medium | ❌ 传输错误 → 重试 ✅ `off` | ✅ `low`（48 s，重试 3 次） | ✅ `medium` | ✅ `high` | ✅ `xhigh` | ✅ `max`（30 s） |
| anthropic-messages / Claude Sonnet 5.5 | ✅ medium | 不提供 | ✅ `low` | ✅ `medium` | ✅ `high` | ✅ `xhigh` | ✅ `max` |
| openai-completions / Grok 4.7 | ✅ medium | 不提供 | ✅ `low` | ✅ `medium` | ✅ `high` | 不提供 | ✅ `max` |

- 每档一轮，日志里每次换档都有一条 `reason: change` 的 header，值与所选一一对应；「关闭」重试的会话首条 header 为 `off`。
- 耗时：Claude 各档 3～10 s，Grok 3～7 s，GPT 5.8～8.5 s；GPT「最高」30 s。
- GPT 6 Luna「关闭」首跑：4 次尝试都是 `TRANSPORT`（`Connection error.`），41 s 后失败，错误码 `NETWORK_ERROR`。紧接着的「低」也重试了 3 次才成功，「最高」重试 1 次。之后单独重试「关闭」一次，5.5 s 成功。所以不是「关闭」档本身的问题（GW-3）。
- 结果：`r4-responses-gpt-6-luna.json`、`r4-anthropic-claude-sonnet-5-5.json`、`r4-completions-grok-4-7.json`、`r4-retry-gpt-6-luna-off.json`。

## R5 同一会话换模型

| 轮 | 模型 | 发 | 回 |
|---|---|---|---|
| 1 | Claude Sonnet 5.5 | 记住暗号「蓝色长颈鹿 42」，只回复「记住了」 | 记住了 |
| 2 | GPT 6.1 Sol | 刚才的暗号是什么 | 蓝色长颈鹿 42 |
| 3 | Claude Sonnet 5.5 | 再说一遍暗号，并说这是第几轮提问 | 蓝色长颈鹿 42 / 3 |

✅ 跨协议来回，上下文连贯。日志里有 3 条 `request/header`（`initial`、`change`、`change`）。日志中没有名为 `model-selection` 的事件类型（IT-04 的说法与本版 DSH 不符，只作记录）。这三轮是「最高」档：R4 最后一次显式选档成了新会话的默认模板，属 §4.3 的设计。

## R6 图片

输入框里粘贴页面内画出的 64×64 纯色 PNG（281 字节，不是磁盘文件），问「这张图片是什么颜色？只回复颜色名称」。

| 协议 | 模型 | 颜色 | 回答 | 耗时 |
|---|---|---|---|---|
| anthropic-messages | Claude Sonnet 5.5 | 红 | 红色 ✅ | 13.7 s |
| openai-responses | GPT 6.1 Sol | 蓝 | 蓝色 ✅ | 11.0 s |
| openai-completions | Grok 4.7 | 绿 | 绿色 ✅ | 135.2 s |

- 附件都以 chip 出现（「移除 r6-solid.png」），用户消息里是 `text + attachment:image`，没有「模型不支持图片」的提示。
- Grok 那次先调了 `read_image`，路径是模型编的 `/home/workdir/attachments/image.png`，于是出了审批卡。驱动没有点允许，等了 120 秒，卡片按设计超时（`nobody answered the permission request in time`），模型随后直接答「绿色」。说明图片已经内联送到模型，耗时长只是在等审批（GW-9）。

## R7 一次性补全

测试仓库：在 `/tmp/aiclient-real-gw/workspace` 里 `git init`，提交 `README.md` 和 `calc.js`，再给 `calc.js` 加一个带下标错误的 `median`，并暂存。模型经设置 store 的 setter 设置（与「AI 功能」设置页调用的是同一个函数）。自动模型是计划的第一个模型，即 `claude/claude-sonnet-5-5`。

| 补全 | 自动 | 指定模型 |
|---|---|---|
| 提交信息（Git 面板「生成 commit 消息」） | ✅ 5.2 s：`feat(calc): 新增 median 中位数计算函数` + 正文 | ✅ Grok 4.7，10.6 s：`feat(calc): 新增中位数计算函数并导出` |
| 分支名（preload `git.generateBranchName`） | ✅ 8.3 s：`feat-20260930-calc-js-median` | ✅ GPT 6.1 Sol，10.1 s：`feat-20260930-calc-median-function` |
| 代码评审（Git 面板「开始代码审查」） | ✅ 14.8 s，首段内容 4.8 s，1568 字，指出了偶数长度下标错误和 `sort` 原地修改入参 | ✅ Claude Sonnet 5.5，8.1 s，1568 字 |
| 中途停止 | — | ✅ GPT 6.1 Sol：25 s 时出现首段（103 字），立即点「停止」；状态回到空闲、内容清空、弹窗关闭，4 秒内没有新内容 |

- 分支名：`CreateWorktreeDialog` 在本构建里没有挂载，界面上找不到入口（GW-7），分支名生成默认也是关的。所以用弹窗自己会调的 preload 方法、用它自己的提示词模板展开来跑。跑完已把三个补全的模型设回自动，分支名生成设回关闭。
- 两次评审（自动、指定 Claude Sonnet 5.5）实际是同一个模型，输出逐字相同，第二次没有流式阶段，内容一次到齐（GW-11）。
- 刚 `git init` 的工作区，Git 面板一直显示「不是 Git 仓库」，要触发一次窗口可见或联网事件才刷新（GW-8）。
- 结果：`r7-*.json`。

## R8 登出

| 步骤 | 观察 |
|---|---|
| 第 1 次（请求 49） | 账户资料卡本身是 `role=dialog` 的弹层，驱动把卡里的「退出登录」按钮排除了，没点到。回合正常结束，不算登出验证 |
| 第 2 次（请求 50） | 发出一个长回答请求后，在 5.07 s 点确认。确认框文案：「这会结束所有正在运行的 agent 与终端会话。要继续使用 AI 功能需要重新注册。」 |
| 在飞回合 | **没验到**：Claude Sonnet 5.5 在 3.5 s 就答完了（会话在确认前 1.5 s 已是 `completed`）。登出时没有在飞的回合 |
| 宿主 | ✅ 确认后 318 ms 进程消失；日志 `[dsh-host] stopped (ipc) in 36ms` |
| 会话 | 状态变为 `disconnected` |
| 界面 | ✅ 640 ms 内回到「注册」页（输入邮箱收验证码） |
| 凭据 | ✅ `credentials/vault.json` 缩到 135 字节，登出后扫描为零命中（R10） |
| 应用 | 仍在运行（dev.js 与 Electron 主进程都在），停在注册页。**没有尝试重新登录** |

还缺两件，需要用户重新登录后再验证：

1. 在飞的回合被登出打断时是否失败、界面怎么显示。建议先打开账户卡再发消息，用首字慢的模型（如 GPT 6.1 Sol「高」，首字约 25 s）。
2. 重新登录后能否正常使用。

### 补验（2026-09-30）

用户在本地 20:53 重新登录后补验第 1 件。本轮只发了 1 次请求（本轮单独记账，上限 3），累计 51 / 60。驱动是 [p1-5-r8b.mjs](p1-5-real-gateway-2026-09-30/tools/p1-5-r8b.mjs)，复用了 p1-5-gw 和 p1-5-items。结果目录用环境变量 `P15_RESULTS_DIR` 指到开发机本地，不入库；`P15_REQUEST_BUDGET=3`。没有截图：登录时侧栏显示邮箱，登出后注册页列出邮箱域名。

**做法**：新建会话，选 GPT 6.1 Sol、档位「高」，输入「请用三句话说明中位数和平均数的区别。不要使用任何工具。」。先打开账户卡，再点发送。会话进入 `running` 后等 1 秒，点卡里的「退出登录」，再在确认框点「退出登录」。点确认前会再读一次状态，如果回合已经结束就点「取消」、不登出。这次没有出现这种情况。

**结论：✅ 登出能打断在飞的回合。回合按「停止」收尾，不算「失败」。**

| 时点（相对点发送） | 观察 |
|---|---|
| 0 | 点发送。账户卡在发送后自己关了，进入 `running` 后又重新打开 |
| 9.9 s | 收到 `session.created`。登录后的第一条消息要冷启动新宿主（g2）。这 10 秒里会话状态一直是 `idle`，没有出现 `starting`（GW-14） |
| 10.1 s | 凭据代理日志记 1 次 `served` |
| 10.2 s | `session.status: running`，用户消息和一条空的 assistant 消息开始 |
| 12.0 s | 点卡里的「退出登录」。确认框比上一轮多了一行损失清单：「1 个会话正在跑回合，会被直接终止」 |
| 12.08 s（T0） | 点确认。这时会话仍是 `running`，assistant 消息有 0 个块（还没有首字） |
| T0 + 10 ms | 收到 `session.stopped`，`stopCause: forced` |
| T0 + 12 ms | 收到 `session.status: disconnected`，`disconnectReason: released`；宿主同时报一条警告（GW-13） |
| T0 + 52 ms | 宿主日志 `[dsh-host] stopped (ipc) in 38ms` |
| T0 + 601 ms | 宿主进程消失（每 100 ms 查一次；上一轮是 318 ms） |
| T0 + 631 ms | 凭据库写盘 |
| T0 + 1.2 s | 界面回到「注册」页（输入邮箱收验证码）。170 ms 时还在聊天界面，会话已经是 `disconnected` |

回合的结局：

- **没有失败卡，也没有错误码**：没有收到 `session.failed`，`lastError` 为空。按决策 046，渲染层把 `forced` 当作一次普通的「停止」：最后一条 assistant 消息记为 `stopCause: user_stop`，0 个块。会话状态是 `disconnected`，`hostBound` 由真变假，按决策 145 离开「正在活动」。
- **工具行**：没有。提示词禁止用工具，回合也没走到工具调用。
- **DSH 会话日志**（只读事件类型和枚举字段）：依次是 `turn/start`、`request/header`（`reasoningEffort: high`）、`assistant/attempt`（流为空）、`step/end`、`turn/end`，结束原因是 `{ kind: aborted, reason: { kind: disposed } }`。也就是说请求已经发出，在首字前被取消，DSH 记为中止。
- **时间线的界面显示没看到**：登出后页面已经回到注册页。重新登录后打开这个会话，才能看到回放的样子（见下）。

凭据库：只 stat 了文件，并读了顶层结构（键名、`enc` 枚举、条目数），没有读任何值。

- 登出前 708 字节，`payload` 有 6 个字段。
- 登出后 135 字节，`payload` 为空（null），也就是已清空。`enc: none` 和权限 0600 没变。
- `lastEmail` 字段保留着，这是设计：`cleared` 状态保留上次登录的邮箱。

应用仍在运行（dev.js 和 Electron 主进程都在），停在注册页。**没有尝试重新登录。**

新发现，编号接着上面：

| # | 严重 | 现象 | 初步定位 |
|---|---|---|---|
| GW-13 | 低 | 登出关停时，宿主报 `session-projection-cache: turn/end write … failed (cache stays stale): SessionHandleClosedError: … flush on a closed handle`。会话日志里已经写进了 `turn/end`，只是投影缓存没更新 | 释放会话时句柄先关了，投影缓存的 `turn/end` 才写。影响还要看：重新登录后打开这个会话，回放是不是显示为已停止，而不是仍在运行或空白 |
| GW-14 | 观察 | 重新登录后的第一条消息，从点发送到 `session.created` 约 9.9 s（宿主冷启动），这段时间会话状态一直是 `idle` | 开发版宿主冷启动。界面在这 10 秒里显示什么没看（没截图），用户点验时可以留意 |
| GW-15 | 观察 | 用户这次重新登录时，应用日志里 `legacy-import:listProjects` 报了两次 `OS-backed encryption is unavailable for the legacy import manifest` | Linux 上没有钥匙串，旧版导入清单拒绝工作。只是记录，没有深究 |

R8 还剩下的事：

- **请用户再登录一次，以验证重新登录后能正常使用**：发一条消息，看回合能否正常跑完。这次重新登录已经确认了几件事：模型目录重新同步成功（`remote`，13 个模型，4 个 provider，没有失败）；第一条消息能拉起新宿主、领到凭据、按所选档位（`high`）发出请求。还没确认的只有一件：重新登录后能完整跑完一个回合。
- 可选：登录后打开会话「请用三句话说明中位数和平均数的区别」，看被登出打断的那一轮显示成什么样（与 GW-13 有关）。

### 重新登录后（2026-09-30）

用户再次重新登录后补验上面剩下的两件事。本轮驱动沿用 `p1-5-items.mjs turn`，结果目录指到开发机本地 `contextFX/p1-5-real-gateway-2026-09-30-r8c`（不入库），单独记账、上限 2（台账 `P15_REQUEST_BUDGET=3`，累计到 54 为止；实际用了 2 次，累计 **53 / 60**）。开始前确认过宿主已完全退出（进程列表零命中），确认应用处于已登录状态（侧栏账户资料可见余额）。

**做法**：新建会话，Claude Sonnet 5.5、默认档位，发「只回复 OK」；失败后换 Grok 4.6（同样默认档位、首字也快）再试一次。

| # | 模型（协议） | 结果 | 进入 running 耗时 | 总耗时 | 网关错误 |
|---|---|---|---|---|---|
| 1 | Claude Sonnet 5.5（anthropic-messages，默认） | ❌ | 2.1 s | 9.4 s | `PROVIDER_ERROR` HTTP 400 `cache_limit`：「cache_control 块数量超过限制，请减少缓存块数量」|
| 2 | Grok 4.6（openai-completions，默认） | ❌ | 0.6 s | 43.5 s | `PROVIDER_ERROR` HTTP 503 `service_unavailable_error`：「所有供应商暂时不可用，请稍后重试」|

**结论：⚠️ 两次都没能完整跑完回合**——不是因为登录或客户端：

- 宿主冷启动确认：本轮开始前宿主进程为零；第 1 次请求把宿主重新拉起（新宿主 g3，首次 `[dsh-host:g3:stderr] … not on win32: nothing to wrap`），应用日志同时记了一次凭据正常发放（`served`，`0 unavailable, 0 refused`）；到会话进入 `running` 约 2.1 秒。第 2 次请求复用同一个宿主（g3），进入 `running` 只用 0.6 秒，期间又有一次凭据正常发放。
- 模型目录、模型菜单、档位选择、发送、状态流转（`idle → running → failed`）、把网关错误映射成失败卡，这些客户端环节本轮全部正常，和登录状态无关。
- 两次失败都是回合进入 `running` 后网关自己拒绝：第 1 次是 Claude 协议报 `cache_control` 块数量超限（具体原因未查，可能与当天这个网关账号已经在同一协议上积累了大量测试会话有关，归为新发现 GW-16，不一定是客户端缺陷）；第 2 次是 Grok 报 503「所有供应商暂时不可用」，与 R2 的 China 组 503（GW-1）性质类似，这次发生在 Grok 组，归为新发现 GW-17。
- 本轮预算已按任务要求用满（2/2），没有再试第三个模型。

**顺带看了一眼被打断的那一轮**：切到另一个会话再从侧栏点回「请用三句话说明中位数和平均数的区别」，重新走一遍「打开会话」的渲染路径（不只是读内存里的 store）。结果和登出时记录的一致：assistant 消息 0 个块、`stopCause: user_stop`，但界面仍然冻结显示「已工作 1 秒」，没有「已停止」一类的注记，也不是空白气泡；切走再切回现象不变。也就是说 GW-13 的下游症状在重新登录、重新打开后依然在：这个回合在界面上永久停在中断前最后一次渲染的「正在工作」文案，尽管底层会话已经是 `disconnected`。记为 GW-18。

新发现，编号接着上面：

| # | 严重 | 现象 | 初步定位 |
|---|---|---|---|
| GW-16 | 中 | 重新登录后第 1 次请求（Claude Sonnet 5.5，anthropic-messages）网关报 400 `cache_limit`：「cache_control 块数量超过限制，请减少缓存块数量」| 可能是当天同一网关账号在 anthropic-messages 协议上积累的 `cache_control` 块过多；需要网关侧或隔一段时间后复核，不确定是客户端问题 |
| GW-17 | 中 | 重新登录后第 2 次请求（Grok 4.6，openai-completions）网关报 503 `service_unavailable_error`：「所有供应商暂时不可用，请稍后重试」| 与 GW-1（China 组 503）性质类似，这次是 Grok 组；本轮预算已用尽没有复测，无法判断是偶发还是持续 |
| GW-18 | 低（延伸 GW-13） | 重新打开被登出强制中断的那一轮，界面仍冻结显示「已工作 1 秒」、没有停止注记；切走再切回现象不变 | 确认 GW-13 的下游症状：`turn/end` 没写进投影缓存的会话，重新打开时界面不会补一个「已停止」态，而是停留在中断前最后一次渲染的「进行中」文案 |

## R9 给网关管理员的说明（草稿，请用户转达）

> 您好，我们在 2026-09-30 UTC 16:06～16:57 用公司账号测试了 AI Client 的新聊天引擎（开发版 1.1.0-dsh.2）。这段时间共约 80 次请求，涉及 claude、gpt、grok、china 四个 provider。想请您帮忙在网关请求日志里看几件事：
>
> 1. **客户端识别**：新引擎发的 User-Agent 固定为 `deepseek-harness/0.1.7-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`，另带一个标识头 `X-Pilab-Client: <应用版本>`。管理后台给这四个 provider 配置的 User-Agent 头，新引擎不会再发。请看这段时间的请求是否被正确识别为 AI Client、是否有请求因为 UA 被拦截、限流或统计错类。如果网关依赖原来那个 UA，请告诉我们需要的值，我们改在客户端里补上。
> 2. **China 组三个模型不可用**：GLM 5.3、DeepSeek V4 Flash、DeepSeek V4 Pro 每次都返回 503 `no_available_providers`。过滤原因是 7 个上游 `disabled`、6 个 `format_type_mismatch`、4 个 `model_not_allowed`。同组的 GLM 5.2 正常，客户端用的是管理后台为 china 配置的 `openai-completions` 协议。请确认这三个模型目前有没有启用的 chat-completions 上游，或者 `format_type_mismatch` 是否说明应该换用别的协议。
> 3. **GPT 连接中断**：UTC 16:19～16:22，gpt 组（`openai-responses`）有几次连接在返回前被断开，客户端报 `Connection error`，重试后成功。请看网关这边是否有对应的超时或断连记录。
> 4. **相同请求的回放**：两次内容完全相同的代码评审请求（claude-sonnet-5-5），第二次的回答逐字相同，而且一次性到达、没有流式过程。请确认网关是否对相同请求做了缓存或回放。
>
> 以上不涉及任何 key 或个人信息，需要更多细节请告诉我们。

## R10 key 泄漏扫描（按形状近似）

本构建没有 Main 内的 `key-canary-scan`（设计中的 R10 要在 Main 里读出真 key 比对）。这里改用 [r10-shape-scan.mjs](p1-5-real-gateway-2026-09-30/tools/r10-shape-scan.mjs) 按形状扫描：`sk-` 长串、`Bearer ` 长串、JWT 形状，以及名为 key / token / secret / authorization 的字段带 20 位以上的值。`.zstd` 会话日志解压后也扫。脚本**只输出文件路径和各形状的命中数**，从不输出匹配到的值。这是近似扫描，不是拿真 key 精确比对。

扫描范围：`/tmp/aiclient-real-gw` 全部（隔离 HOME，含 DSH_HOME、会话日志、应用日志、Chromium 缓存和存储、`dev.log`、`dev.env`、工作区）；本次运行在系统临时目录留下的 `dsh-spill-*`、`dsh-subprocess-*`、`scoped_dir*`（都是空目录或 socket）；本证据目录本身。

| 时点 | 文件数 | 命中文件 | 命中 |
|---|---|---|---|
| 登出前 | 1780（35.5 MB） | 2 | `dev.env`：1 个占位 token（dev.js 要求的占位行）；`credentials/vault.json`：3 个 `sk-` 形状、3 个密钥字段 |
| 登出后 | 1792（35.5 MB） | 1 | 只剩 `dev.env` 的占位行 |

- 凭据库以外（`models.json`、`managed-models-source.json`、DSH 会话日志、宿主日志、应用日志、`dev.log`、Chromium 缓存和存储、本证据目录）**零命中**。✅
- 凭据库在这台机器上是明文：没有系统钥匙串，保险库走 `enc: "none"`（D47 的既有设计，不是本分支引入的；只读了这一个枚举字段）。文件权限 0600，目录 0700，登出后清空。这不算泄漏，但要知道：Linux 上没有钥匙串时，key 以明文落盘。
- 结果：`r10-scan-before-logout.json`、`r10-scan-after-logout.json`。

## 网关错误与归类

| 错误 | 次数（回合） | 客户端重试 | 归类 |
|---|---|---|---|
| HTTP 503 `no_available_providers`（`PROVIDER_ERROR`） | 6（China 3 个模型 × 2） | 每次 3 次 | 网关侧配置：没有可用上游（GW-1） |
| 传输中断 `Connection error.`（`NETWORK_ERROR` / `TRANSPORT`） | 1 次失败 + 2 次重试后成功（都在 GPT 6 Luna） | 3 + 3 + 1 | 网络或网关，间歇性（GW-3） |
| 流闸门 `stream_gate_precommit` / `prebuffer_overflow` | 0 | — | Opus 5.5 这次正常 |
| 401 / 403 / 限流 | 0 | — | — |

## 发现的问题

编号是本文件内的临时编号，归档进问题表时可以重编。

| # | 严重 | 现象 | 初步定位 |
|---|---|---|---|
| GW-1 | 中 | China 组 GLM 5.3、DeepSeek V4 Flash、DeepSeek V4 Pro 每次都返回 503 `no_available_providers`（上游 7 个 disabled、6 个 format_type_mismatch、4 个 model_not_allowed）；同组 GLM 5.2 正常 | 多半是网关配置：这些模型没有启用的 chat-completions 上游。也可能是目录协议与网关期望不一致。请管理员核对（R9 第 2 条）；最好再用 1.0.x 对同一账号试一次作对照 |
| GW-2 | 中 | 客户端把 503 `no_available_providers` 当作可重试，退避重试 3 次（约 3 + 6 + 12 s），用户要等 30 多秒才看到失败，网关流量是 4 倍 | DSH 重试策略（`DshRetryPolicy`，`maxRetries: 3`）对这类 503 也重试（日志 `provider retry n/3 … code=SERVER`）。可以把 `no_available_providers` 这类配置性错误排除在外；先对照 1.0.x 的行为再定 |
| GW-3 | 中 | `openai-responses`（GPT 6 Luna）间歇性传输中断：一回合 4 次尝试全断、41 s 失败，另两回合重试后成功（其中一回合 48 s）；其他两种协议没有出现 | 网络或网关对 responses 流的断连，需要网关日志（R9 第 3 条）。客户端侧行为正常（有重试，失败有明确错误码） |
| GW-4 | 中 | Grok 4.7 的 `maxTokens` 等于 `contextWindow`（500000）。DSH 压缩报 `reserves 500000 completion tokens of its 500000-token context window, leaving no message budget`，长会话无法自动压缩 | 计划原样透传目录的 `maxTokens`（`src/shared/dshModelPlan/build.ts:266`）。可以在计划里把 `maxTokens` 夹到 `contextWindow` 以下，或请管理员修目录 |
| GW-5 | 中（待 R9） | 管理后台给 4 个 provider 配的 User-Agent 全被计划去掉（`reserved_header`），实际发 `deepseek-harness/0.1.7-rc.2 (+…)` 加 `X-Pilab-Client`。本次除 GW-1 外没有看到拦截 | 决策 037 的已知取舍，等管理员答复再决定是否在宿主里改写 UA |
| GW-6 | 低 | 代码评审弹窗标题在自动模式下显示为「代码审查()」，指定模型时显示原始 id（如 `claude/claude-sonnet-5-5`） | `CodeReviewModal.tsx:303-306` 直接渲染 `codeReviewSettings.model` |
| GW-7 | 低 | 分支名生成在界面上没有入口：`CreateWorktreeDialog` 只在 `components/worktree/index.ts` 导出，没有任何地方渲染；设置默认也是关闭 | 需要确认是 P1-7 重做工作区外壳时有意去掉，还是遗漏 |
| GW-8 | 低 | 已打开的工作区里执行 `git init` 后，Git 面板一直显示「不是 Git 仓库」，要等窗口重新获得焦点或触发联网事件才刷新；这期间 `[workspace-tree] worktree query failed` 每次渲染都重复写日志（dev.log 里上百行） | `useWorktreeListMultiple` 缓存了失败结果，`useSyncChatWorkspaceTree.ts:441-445` 在 `errorsMap` 引用变化时重复打印 |
| GW-9 | 观察 | Grok 4.7 收到内联图片后，还去调 `read_image`，路径是编造的，因此出审批卡。卡片 120 秒超时后，模型照样答对 | 模型行为。可以查一下 DSH 附件注记里的路径文字是否在诱导模型这样做 |
| GW-10 | 观察 | 重试与失败日志的前缀仍是 `[pi-worker:session-…]` | 日志词汇残留 |
| GW-11 | 观察 | 两次相同的评审请求输出逐字相同，第二次没有流式过程 | 疑似网关缓存或回放，已写进 R9 第 4 条 |
| GW-12 | 观察 | 宿主多次报事件循环阻塞，最长 2.6 s（共 5 条） | 性能观察，未深究 |

## 需要用户做的事

1. ~~**重新登录**，补验 R8 的两件事~~ **已完成**：在飞回合被登出打断 ✅（GW-13）；重新登录后能否正常使用——客户端侧（宿主冷启动、凭据分发、发送）✅ 正常，但两次尝试都卡在网关侧（`cache_limit` / 503，GW-16、GW-17），预算用尽没有再测，建议找个网关状况更稳的时段再发一条消息复核一次。
2. **把 §R9 的说明转给网关管理员**，拿到答复后再定 GW-1、GW-3、GW-5；可以把 GW-16、GW-17 一并带上。
3. 可选：用 1.0.x 对同一账号试 China 组那三个模型，用来确认 GW-1 是网关问题还是新引擎的问题。

## 取证方式与隐私

- 驱动：[p1-5-gw.mjs](p1-5-real-gateway-2026-09-30/tools/p1-5-gw.mjs)（只附着 CDP、清洗输出、记请求台账，超过 60 次拒绝发送）、[p1-5-items.mjs](p1-5-real-gateway-2026-09-30/tools/p1-5-items.mjs)（R2～R6、R8）、[p1-5-r7.mjs](p1-5-real-gateway-2026-09-30/tools/p1-5-r7.mjs)（R7）、[effort-log.mjs](p1-5-real-gateway-2026-09-30/tools/effort-log.mjs)（只读 `reasoningEffort` 和事件类型计数）、[r10-shape-scan.mjs](p1-5-real-gateway-2026-09-30/tools/r10-shape-scan.mjs)。都能过 biome。
- 保存的结果统一清洗：邮箱和 `@域名`、非回环 URL、IP、key / Bearer / JWT 形状、请求 id、网关会话 id（`sess_…`）、真实家目录、主机名、用户名。清洗后检查过，结果里没有这些。
- 没有截图。登录后侧栏显示账户邮箱，登出后注册页列出允许的邮箱域名，页面文字都含 `@`。
- 读过的文件里，与凭据相邻的只有两处：`models.json`（白名单只取 `api` 枚举和模型数），以及 `vault.json` 的 `enc` 枚举。另外 R10 扫描读过全部文件，但只做计数。
