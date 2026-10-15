# 原型结论：PiLab 的 Claude 模型改由官方 Claude Agent SDK 驱动（路线 B，2026-10-14）

Role: study（原型结论，非决策）。分支 `proto/claude-agent-sdk-engine`，基于 `726fb441`（main `79f81cdb` 加差距调研），未推送。SDK 用 `@anthropic-ai/claude-agent-sdk@0.3.300`（10-14 发布），内置 Claude Code `2.1.300` 原生二进制。开发机：Windows 10 19043，Node 24.12，Git for Windows 装在非默认盘符。

模型请求只发到本机假网关（`src/dsh-host/tools/fake-gateway.mjs --plan claude-sdk`），没有接真实网关；没有读写本机任何账户信息（PiLab 凭据库、Claude Code 登录都没碰）。

上位：[差距调研](2026-10-14-pilab-vs-claude-code-gap-study.md) §4、§7 第 12 项；[SDK 引擎调研](2026-09-26-claude-sdk-engine-study.md)。

## 0 结论

1. **可行，而且接缝比 09-26 调研估计的小。**
   - 开发机 GUI 上跑通了要求的整条链路：发消息 → 流式正文与思考 → 工具行 → 审批卡 → 停止。
   - 另外也跑通了：提问卡、计划审阅卡、Ctrl+Enter 插话、重启应用后重开续聊、`/compact`。
   - 同一个应用里，Claude 模型的新对话走 SDK 引擎，GLM 模型的新对话照旧走 DSH（网关日志的 UA 分别是 `claude-cli/2.1.300 (… sdk-ts …)` 和 `claude-cli-pilab/…`）。
   - 宿主复用 DSH bridge 的 `BridgeRpcServer`，只新写一个 `BridgeSessionRuntime`。Main 侧只在 `spawnForEntry` 换一个 transport。渲染层一行没改。
2. **Windows 上实测到两个坑，原型里已解决（§5）。**
   - Git 不在默认位置时，CLI 找不到 Git Bash，会退回 PowerShell 工具。现在由宿主自己找 Git Bash。
   - 停止后，Bash 工具起的 Git Bash 子进程会成为孤儿，CLI 退出后仍在运行。现在由宿主按 MSYS 进程组清理，2 s 内清零。
3. **体积与资源（§6）。**
   - Windows 安装包约 +90 MB：LZMA 实测 89.2 MB，现在的安装包约 182～198 MB。安装后 +271 MB。Linux 相当。
   - 每个活动会话常驻约 250 MB：宿主 node 约 80 MB，claude.exe 约 170 MB（工作集）。
4. **加密机未测，是最大的未知项（§5.2）。**
   - 读写矩阵工具已写好，开发机上空跑通过；上机约半天到一天。
   - 原生二进制读不出明文时，有一条实测可行的备选：用 `toolAliases` 让模型照用原生 `Read`，执行落到随包 node.exe 里。
5. **工作量修订（§8）。**
   - 最小可用版 3.5～4.5 人周，不含加密机；加密机另加 1～3 人周。
   - 功能对等版 9.5～12.5 人周。
   - 09-26 的估计分别是 5～7 和 10～15 人周。
6. **建议有条件立项（§9）。**
   - 先花约 1 人周做三项 Go/No-Go：真实网关透传检查、T2 三方对照、加密机读写矩阵。
   - 三项都过，再按最小可用版立项。
   - 原型本身已经证明「能接上」，还没证明「更好」。

## 1 原型做了什么

| 部分 | 文件 | 说明 |
|---|---|---|
| 宿主入口 | [host.ts](../../src/claude-sdk-host/host.ts) | 每个会话一个 Node 进程（随包 node，开发时可用 `AICLIENT_DSH_NODE` 指定），走 IPC，套 `BridgeRpcServer` |
| 会话 runtime | [sdkSessionRuntime.ts](../../src/claude-sdk-host/sdkSessionRuntime.ts) | 一个常驻 `query()`，流式输入：发送和插话推进输入队列，停止用 `interrupt()`，审批停在 `canUseTool`。SDK 消息映射成与 DSH bridge 相同的运行时事件 |
| CLI 环境 | [cliEnvironment.ts](../../src/claude-sdk-host/cliEnvironment.ts) | 环境变量白名单加注入，不继承任何 `ANTHROPIC_*` / `CLAUDE_*`；自带 Git Bash 查找 |
| 会话桩 | [sessionStub.ts](../../src/claude-sdk-host/sessionStub.ts) | `<CLAUDE_CONFIG_DIR>/aiclient-sessions/<CC 会话 id>.ccsdk.json`，作为 Main 的 `sessionFile` |
| Windows 进程清理 | [processTree.ts](../../src/claude-sdk-host/processTree.ts) | 停止前快照、停止后清孤儿（§5.1） |
| Main 传输 | [ClaudeSdkProcessTransport.ts](../../src/main/services/agent-host/ClaudeSdkProcessTransport.ts) | `WorkerTransport` 的子进程实现；kill 在 Windows 上用 `taskkill /T` 整树 |
| 引擎开关 | [claudeSdkEngine.ts](../../src/main/services/agent-host/claudeSdkEngine.ts) | 见下 |
| 接缝 | [WorkerManager.ts](../../src/main/services/agent-host/WorkerManager.ts) | `ManagedSlot.engine`（338），新建时按模型定（1089），重开时按桩文件后缀定（1357），`spawnForEntry` 换 transport（3069），SDK 槽不当成 DSH 宿主故障（3926、4250） |
| 假网关 | [fake-gateway.mjs](../../src/dsh-host/tools/fake-gateway.mjs) | 新增 `--plan claude-sdk`，单独一段：按 `CC-TEXT/TOOLS/ASK/SLOW/PLAN/AGENT/STEER/SEARCH/ENC` 标记回 Claude Code 工具名的分步脚本 |
| 探针 | [tools/](../../src/claude-sdk-host/tools/) | `host-probe.ts`：像 WorkerSlot 一样经 IPC 驱动宿主，含加密机读写矩阵场景 `enc`（§5.2）。`gui-probe.mjs`：隔离 profile 的开发版 GUI 点验。`sdk-spike.ts`、`alias-spike.ts`：单点实验 |

**引擎开关（只在原型分支）**：
- 未打包构建里设 `AICLIENT_CLAUDE_SDK_ENGINE=1` 后，模型 id 是 `claude-*` 的**新**对话走 SDK。正式版应按路由协议 `anthropic-messages` 判断。
- 重开的对话跟随创建时的引擎：桩文件以 `.ccsdk.json` 结尾就走 SDK。
- 网关地址与 key 只从 Main 的环境变量 `AICLIENT_CLAUDE_SDK_BASE_URL` / `AICLIENT_CLAUDE_SDK_API_KEY` 读，经宿主变成 CLI 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`，不落盘。
- 线名沿用 `dsh`，这样 `chat.ts` 的门禁不用改。代价见 §3 的只读预览。

**传给 SDK 的关键选项**：
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: <四行 PiLab 说明> }`；
- `tools` 用官方预设，去掉 PiLab 没有宿主面的定时、跨会话消息、worktree 切换、审阅面板、Workflow 等 10 个，模型看到 15 个：Agent、AskUserQuestion、Bash、Edit、EnterPlanMode、ExitPlanMode、Glob、Grep、NotebookEdit、Read、Skill、TaskStop、WebFetch、WebSearch、Write；
- `includePartialMessages`；
- `thinking: adaptive + display: summarized`，否则看不到思考正文；
- `permissionMode` 按档位映射；
- `settings: { attribution: false }`；
- `managedSettings` 锁住仓库的 allow 规则与 hooks，`strictMcpConfig`（§4）；
- 首次用 `sessionId`、之后用 `resume`。

**原型刻意没做的**：
- rewind / fork / 会话树、后台任务窗口、目标；
- 失败重试、子代理泳道；
- 侧栏只读预览、成本、打包。

## 2 验证（全部只用本机假网关）

**宿主探针**：`host-probe.ts` 经 IPC 跑了 11 个场景，全部通过。完整套件跑两遍，结果一致。

| 场景 | 结果 |
|---|---|
| 正文 + 思考 | 事件序列与 DSH 录制样本（`stream.think/tool.json`）同形：`session.status running` → 用户回显（带 attemptId）→ 每个模型步一条 `message.started` → `thinking.*` / `message.delta` → `usage.updated`（pending + settled）→ `message.completed` → `session.completed` → `idle` |
| Bash + Write + Read | Bash 只读命令由 CLI 自己放行；Write 弹卡，`permissionId` 等于 toolUseID；Read 结果是 `cat -n` 格式 |
| 提问卡 | 答案以问题原文为键，模型收到 "Your questions have been answered…" |
| 停止（bypass 档下正在运行的 `sleep 97 & sleep 97; wait`） | 0.5～1 s 收到 `session.stopped`；工具行 `stopped`；孤儿 2 s 内清零 |
| 停止（审批卡未答） | `permission.resolved{autoReason:'aborted'}`，工具行 `notStarted` |
| 计划模式 + ExitPlanMode | 审阅卡带计划正文；批准后发 `session.permissions{plan-approved}`，CLI 切档 |
| Ctrl+Enter | CLI 在下一步把插话作为会话中的 system 消息并入（抓包确认）；宿主按 `user_message_uuids` 补发用户回显 |
| 子代理（Agent 工具） | 2.1.300 的子代理默认**异步**：立即返回 "Async agent launched"，完成时经 `task_notification` 通知。CLI 自己起的回合按 DSH 的「引擎自起回合」映射（带 `origin`） |
| Grep / Glob | Windows 上可用，ripgrep 内置在原生二进制里 |
| `/compact` | 发 `/compact` 文本，1.4 s 完成（compact_boundary + 摘要） |
| 重开续聊 | 新进程读同一个桩文件，`initialHistory` 由 `getSessionMessages` 投影，`resume` 续写 |

另有加密机读写矩阵场景 `enc`，开发机上只能空跑，见 §5.2。

**GUI 点验**：`gui-probe.mjs` 用开发版应用和隔离 profile（HOME/USERPROFILE 指向临时目录，`AICLIENT_PROFILE`）。在设置里加一个指向假网关的自定义服务（假 key），选 `claude-opus-5-5`。依次确认：
- 流式正文与「思考 1 秒」；
- 终端 / 编辑 / 读取三类工具行，「已允许」并入行内；
- 审批卡显示「Write — 写入工作区文件」、内容与路径；
- 提问卡（A/B/C 加其他、聊聊这个），提交后续答；
- 「停止当前回合」后，行尾显示「已允许 · 已停止」；
- 计划审阅卡，批准后档位芯片变为「全自动」；
- Ctrl+Enter 插话气泡出现在两步之间；
- 上下文占用显示 1%；
- 重启应用后点开旧对话，历史在，续发仍走 SDK。

截图只留在本机临时目录，含本机路径，不入库。

**单测与门禁**：
- 根 tsc、宿主 tsc（`pnpm exec tsc -p src/claude-sdk-host/tsconfig.json`）、biome 全过；
- `WorkerManager`、`chatEngineDshOnly`、`t31PiOnlyAbsence`、`chatPiWorkerRouting` 等 7 个文件共 308 个测试照旧通过；
- `cliEnvironment` 共 10 个测试，含随包 rg 目录与 PATH 拼接。

**复现**：

```
node src/dsh-host/tools/fake-gateway.mjs --port 18932 --plan claude-sdk --reset --model-id claude-opus-5-5
cd src/claude-sdk-host && npm ci
node tools/host-probe.ts http://127.0.0.1:18932 <空工作区> text tools ask stop plan steer agent search compact history
node tools/host-probe.ts http://127.0.0.1:18932 <空工作区> enc
```

最后一行是加密机矩阵的空跑；要用随包 rg，先设 `AICLIENT_CLAUDE_SDK_RG_DIR`（§5.2）。

## 3 功能映射

可直接用：SDK / CLI 自带，原型已接通。要移植：要写映射或补 UI。首版没有：建议首版不做。

| 功能 | 判定 | 说明 |
|---|---|---|
| 流式正文、思考、工具行 | 可直接用 | 渲染层原有的 Claude Code 词汇表生效（Bash→终端、Write/Edit→编辑、Read→读取、Agent→委派）。Edit/Write 的 diff 审阅细节（`details.review`）未接 |
| 审批卡（改动前确认） | 可直接用 | `canUseTool` → `permission.requested`。只读命令与工作区内读文件由 CLI 自己放行 |
| 本会话允许 | 可直接用 | 采纳 CLI 的 `suggestions`，目的地强制改成 `session`，不写任何 settings 文件 |
| 其他档位 | 要移植（小） | 计划→`plan`，自动编辑→`acceptEdits`，完全放行→`bypassPermissions`。全自动在原型里是「CLI 问到的一律放行」，正式版要定是否用 CLI 的 `auto`（分类器，多一次模型调用）。拒绝清单要用 managed 规则或 PreToolUse hook 实现 |
| 提问卡 | 可直接用 | |
| 计划模式与审阅卡 | 可直接用，「设为目标」两项除外 | CLI 的计划模式用会话中 system 消息与中途改工具，不改系统提示词，正好避开差距调研 §3.3 的思考失效问题。目标是 DSH 专有，回报 `goal{set:false}` |
| Ctrl+Enter 插话 | 可直接用 | 撤回用 CLI 的 `cancelAsyncMessage`（在 sdk.mjs 里，类型声明没有）；bridge 接口是同步的，与并入竞态时先答 `withdrawn`，正式版改成异步 |
| 停止 | 可直接用，Windows 要补清理 | §5.1 |
| 用量与上下文 | 可直接用 | 每步 pending + settled。上下文窗口取自 `result.modelUsage`，第一轮之后才有。成本未接，DSH 也是 0 |
| `/compact` | 可直接用 | 摘要卡与 `session.compaction` 事件未接 |
| 重开续聊、历史 | 可直接用 | 历史投影已滤掉 CLI 的记账行（中断标记、本地命令回显）。压缩前的内容能否完整显示要再核 |
| 侧栏只读预览（未打开的会话） | 要移植 | `chat:readSessionPage` 走 DSH 宿主，会报 "Not a DSH session identity"。Main 侧可用 SDK 的 `getSessionMessages` 直接读 |
| 子代理泳道 | 要移植 | 由 `task_started/progress/notification` 和带 `parent_tool_use_id` 的消息映射成 `subagent.activity`。CLI 的「立即返回 id、完成后通知」与 DSH 0.2.1 的新语义一致 |
| 后台任务窗口、命令实时输出 | 要移植 / 首版没有 | SDK 没有 Bash 输出流，只有 `tool_progress` 计时；后台任务可用 `stopTask` / `getTaskOutput` 控制 |
| rewind / fork / 会话树 | 首版没有 | SDK 有 `resumeSessionAt` / `forkSession` / `rewindFiles`，可以做 |
| 失败重试（旁支） | 首版没有 | 现在答 `WORKER_RETRY_UNAVAILABLE` |
| 目标 `/goal` | 首版没有 | DSH 专有 |
| 斜杠命令菜单 | 要移植（小） | 原型列出 CLI 的 44 个命令，含不适用的，要筛选 |
| 中途换模型、思考强度 | 可直接用 | `setModel` / `applyFlagSettings`。换到非 Claude 模型要在 UI 拦住，引擎按会话固定 |
| 图片附件 | 要移植（验证） | 代码按 image block 发，未实测 |
| MCP、技能 | 要定取舍 | 原型不读仓库 `.mcp.json`；技能走 CLI 自己的发现（项目 `.claude/skills`） |

## 4 配置隔离与 `settingSources` 的取舍

- **`CLAUDE_CONFIG_DIR`**：指向 `~/.pilab/<profile>/claude-sdk-home`。CLI 的 transcript、`.claude.json`、桩文件都在这里，不读用户的 `~/.claude`，包括登录凭据和设置。
- **环境**：白名单只放 PATH、系统目录、代理等，再注入网关、key、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`CLAUDE_AGENT_SDK_CLIENT_APP`、`CLAUDE_CODE_GIT_BASH_PATH`。
  - 另外单独设 `DISABLE_AUTOUPDATER=1`：加密机的白名单若按哈希放行，随包二进制不能自己更新。
  - 可选 `AICLIENT_CLAUDE_SDK_RG_DIR`：把该目录放到 PATH 最前，并设 `USE_BUILTIN_RIPGREP=0`，让 CLI 改用 PiLab 随包的 rg（§5.2）。
  - 本机 Claude Code 会话带着几十个 `CLAUDE_*` 变量和一个 `ANTHROPIC_BASE_URL`，全部挡在外面，单测覆盖。
  - 关掉非必要流量后，整个会话只有 `/v1/messages` 一种请求：没有遥测、更新检查、标题生成。
- **`settingSources: ['project']`**（推荐）：
  - 读项目 `CLAUDE.md`：实测以 system-reminder 注入首条用户消息，措辞是「必须严格遵守、优先于默认行为」，与 Claude Code 一致。这正是差距调研 §2 指出 PiLab 吃亏的地方。
  - 也读项目 `.claude/` 下的命令、技能、子代理定义。
- **不取 `local`**：`.claude/settings.local.json` 是个人的允许规则，会让操作不经审批卡直接执行。
- **不取 `user`**：因为 `CLAUDE_CONFIG_DIR` 已隔离，这一层其实是 PiLab 自己的私有目录。正式版可以用它放 PiLab 级的设置。
- **仓库自带的 hooks 与 allow 规则**：用 `managedSettings`（父进程策略层）的 `allowManagedPermissionRulesOnly` + `allowManagedHooksOnly` 锁住。
  - 实测：不锁时，仓库的 PreToolUse hook 会执行（建出了标记文件）；锁后不执行。
  - 仓库的 `permissions.allow: ["Write"]` 在两种情况下都没绕过审批卡，原因未查。
  - 风险：机器上若有 IT 下发的 Claude Code 托管设置，这一层默认会被丢弃，除非管理员开 `parentSettingsBehavior: 'merge'`。
- **`strictMcpConfig: true`**：不加载仓库的 `.mcp.json`。

## 5 Windows 与加密机

### 5.1 普通 Windows（实测）

- **Bash 走 Git Bash**：
  - CLI 自己只在默认位置找 Git。Git 装在 G 盘时，工具表里是 `PowerShell` 而不是 `Bash`。
  - 宿主从 PATH 推导出 `bash.exe`，经 `CLAUDE_CODE_GIT_BASH_PATH` 传给 CLI 后恢复成 `Bash`（`uname` 为 MINGW64）。
  - 没装 Git 时就是 PowerShell 工具，`CLAUDE_CODE_USE_POWERSHELL_TOOL` 默认开。
- **ripgrep**：内置在原生二进制里（CLI 以 argv0 `rg` 运行自身），Grep / Glob 实测可用，不需要随包 rg。可选的 `AICLIENT_CLAUDE_SDK_RG_DIR` 能改用 PiLab 随包的 `@vscode/ripgrep`，已验证生效，留给加密机做对照（§5.2）。
- **停止与子进程树**：
  - `interrupt()` 后 0.5～1 s 收尾。CLI 杀掉了 `bash.exe`，但 `sleep 97 & sleep 97; wait` 起的两个 `sleep.exe` 继续运行；CLI 进程退出后它们仍在，12 s 后还在。
  - 原因：MSYS 用新的 Windows 进程模拟 fork/exec，运行中的 `sleep.exe` 的 Windows 父进程号早已失效，按 Windows 进程树找不到它们。
  - 宿主的做法：停止前用 Git Bash 自带的 `usr\bin\ps.exe` 读 MSYS 进程表（含 WINPID），记下 CLI 所起 shell 的进程组；停止 1.5 s 后清掉残留。实测 2 s 内清零。dispose 时同样清理。
  - 代价：停止要多等一次进程快照，约 1 s。正式版可以换成 Job Object。
  - 应用退出时 Main 对 SDK 槽 forceKill，走 `taskkill /T` 整树。
- **其他**：
  - CLI 在 `%TEMP%\claude\<项目>` 写 shell 快照等临时文件，可以用 `CLAUDE_CODE_TMPDIR` 收到应用目录。
  - 冷启动：首次约 4 s 到 `system/init`，之后约 0.6 s。原型对新对话在 bootstrap 时就预启动 CLI，发送不等冷启动。

### 5.2 加密机（TSD，只放行随包 node.exe）：待测，矩阵工具已备好

**已知**：
- P1-13b 读：能否解密与读文件的进程名无关。随包 node.exe 读 51 类样本，42 类拿到明文、9 类拿到密文；9 类里有 6 类可以用 PowerShell 5.1 读回明文（P1-13c 的回退）。
- P1-13b 写：新建的文件会不会被加密，取决于写法和可执行文件名。node.exe 直接新建 22/51 被加密，先写临时文件再硬链接（DSH write）0/51；node.exe 改个名字，新建的 `.js` 就被加密了。
- 决策 090 推翻了决策 089：新建文件不加密对产品是好事，加密了反而读不出来。决策 135：编辑后文件变成明文，是可接受的既有语义。
- 2026-04：官方 2.1.113+ 的 Bun 二进制读不出加密的 JSONL。
- 所以 claude.exe 的读写必须实测，包括它以 `rg` 身份运行自身时的读。

**矩阵工具**（本分支已写好，开发机空跑通过）：`host-probe.ts` 的场景 `enc`，配合假网关 `--plan claude-sdk` 的 `CC-ENC` 脚本。每个样本一个回合，档位为完全放行，依次 8 次工具调用：

| 格子 | 调用 | 测什么 |
|---|---|---|
| Read | `Read` 样本 | claude.exe 自己读 |
| Grep | `Grep` 标记串 | rg 读。默认 rg 是 claude.exe 自身（argv0 `rg`）；设了 `AICLIENT_CLAUDE_SDK_RG_DIR`，就是该目录里的 `rg.exe` |
| cat / sed | `Bash`：`cat … \| head -c 400`、`sed -n '1,5p' …` | Git Bash 工具链读 |
| Edit | `Edit`：标记串前加 `CCSDK-EDITED-` | claude.exe 改已加密的文件 |
| Read2 | 再 `Read` 样本 | 改完读得回来吗 |
| Write | `Write` 一个新文件：与样本同名，放在样本旁边新建的 `ccsdk-written-<毫秒>\` 里 | claude.exe 新建的文件会不会被加密 |
| Read3 | `Read` 这个新文件 | 自己写的读得回来吗 |

- 新文件放在样本旁边、文件名不变，是为了让加密策略看到同一个目录、同一个扩展名。用新目录，是为了 Write 不会碰上旧文件（CLI 要求先读后写）。
- 全部回合结束后，探针自己的 node 与 Windows PowerShell 5.1 各读一遍以下文件的前 256 字节：每个被改的样本、每个新文件、本会话的 transcript。这是 P1-13b 用过的两个读者，两者能看到密文的类型不同，可以互补。设了 `PROBE_ENC_RECHECK_S`，隔这么多秒再读一遍。

| 变量 | 作用 |
|---|---|
| `PROBE_ENC_DIR` | 样本目录，取其中所有文件（不递归） |
| `PROBE_ENC_FILES` | 另加的样本，绝对路径，`;` 分隔 |
| `PROBE_ENC_MARKER` | 样本里的标记串，默认 `P113B-MARKER-`（P1-13b 上机包生成的样本都带它） |
| `PROBE_ENC_RECHECK_S` | 延迟复读的秒数，建议 300。P1-13b 实测读者视图约 260 秒后才沉淀 |
| `AICLIENT_CLAUDE_SDK_RG_DIR` | 放 `rg.exe` 的目录。宿主把它放到 CLI 的 PATH 最前，并设 `USE_BUILTIN_RIPGREP=0`。目录里没有 `rg.exe` 时，CLI 不报错，静默改用内置 rg，宿主日志会打一行 warning |
| `PROBE_VERBOSE=1` | 显示宿主的 stderr，含 `rg=` 与 `gitBash=` |

两个样本变量都不给时是空跑：在工作区写 4 个明文样本（md、yml、docx、Makefile）。

**开发机空跑**（2026-10-15，假网关）：
- 内置 rg、随包 rg 各跑一遍：4 个样本、32 次调用，约 21 s。全部是 `plain` / `ok` / `plain-edited` / `plain-written`；落盘两个读者都看到 `edited` / `written`，transcript 是 `json`。
- `.docx` 的三次 Read 都是 `error`：CLI 按扩展名拒读二进制（"This tool cannot read binary files"），与内容无关。Grep、cat、sed、Edit、Write 照常。P1-13b 里 docx、xlsx、pptx、pdf 这类样本的 Read 格子要按这一点读。
- 随包 rg 确实生效：在该目录放一个替身 `rg.exe`，Grep 就返回 "No matches found"。换成空目录，宿主打 warning，Grep 回落到内置 rg，照常命中。
- 按这个速度，P1-13b 的 51 个样本一轮约 4～5 分钟，加上延迟复读再 5 分钟。

**上机步骤**（用户配合，约半天到一天，多数时间花在用加密客户端确认新文件）：

1. **准备**：在加密机上检出本分支，依赖照 [P1-13d 证据](../plantree/plans/dsh-rebase/evidence/p1-13d-encrypted-edit-2026-09-30.md) §0 装好，再在 `src/claude-sdk-host` 里 `npm ci`。这一步会装 SDK 与 `claude.exe` 原生包；访问不了 npm 源，就从开发机整份复制该目录的 `node_modules`。下面的 `node` 都用随包 node（PiLab 安装目录的 `resources\node-runtime\node.exe`），这样落盘检查里的 `node=` 就是产品自己的视角。
2. **起假网关**（PowerShell，仓库根）：
   ```
   node src/dsh-host/tools/fake-gateway.mjs --port 18932 --plan claude-sdk --reset --model-id claude-opus-5-5 --capture $env:TEMP\ccsdk-cap
   ```
3. **流程、停止与 transcript**（在 `src/claude-sdk-host` 里跑，工作区用一个空目录）：
   ```
   node tools/host-probe.ts http://127.0.0.1:18932 D:\ccsdk-ws text tools stop
   ```
   - 通过标准：`text`、`tools` 以 `session.completed` 结束，`tools` 出审批卡；`stop` 以 `session.stopped` 结束，`sleep processes` 一行在停止后几秒内降到 0（即 §5.1 的停止实验）。
   - 输出最后一行是 `sessionFile=…; configDir=…`，用这两个值续聊：
   ```
   $env:PROBE_CONFIG_DIR='<configDir>'; $env:PROBE_SESSION_FILE='<sessionFile>'
   node tools/host-probe.ts http://127.0.0.1:18932 D:\ccsdk-ws history text history
   ```
   - 通过标准：`text` 以 `session.completed` 结束，第二次 `history` 比第一次多 3 条（开发机是 9 → 12）；`--capture` 目录里编号最大的那份请求，`messages` 从第一轮的 `CC-TEXT hello` 开始（开发机共 5 条）。做不到，就是 claude.exe 读不回自己的 transcript（2026-04 现象），对应下面备选表的第 3 行。做完清掉这两个变量。
4. **读写矩阵**：
   - 样本：用资源管理器把 P1-13b 上机包的 `in` 目录复制一份到加密目录下，例如 `D:\Encrypted\ccsdk-enc-1`，再用加密客户端确认原来加密的仍是加密的。**矩阵会改动样本**（Edit），每一轮都要用新副本。
   - 内置 rg 跑一轮，随包 rg 跑一轮（第二轮换新副本 `ccsdk-enc-2`）：
   ```
   $env:PROBE_ENC_DIR='D:\Encrypted\ccsdk-enc-1'; $env:PROBE_ENC_RECHECK_S='300'
   node tools/host-probe.ts http://127.0.0.1:18932 D:\ccsdk-ws enc > enc-builtin-rg.txt
   $env:PROBE_ENC_DIR='D:\Encrypted\ccsdk-enc-2'
   $env:AICLIENT_CLAUDE_SDK_RG_DIR='<仓库根>\node_modules\@vscode\ripgrep\bin'
   node tools/host-probe.ts http://127.0.0.1:18932 D:\ccsdk-ws enc > enc-bundled-rg.txt
   ```
   - 安装版的 rg 在 `resources\app.asar.unpacked\node_modules\@vscode\ripgrep\bin`。
   - 新文件在每个副本的 `ccsdk-written-<毫秒>\` 里，留给加密客户端逐个确认，做法同 P1-13b 的写者目录。
5. **读输出**：
   - `=== ENC-MATRIX` 每个样本一行，记的是 CLI 看到了什么：
     - `plain`：看到了标记串，即明文；
     - `cipher`：看到了 `%TSD-Header`，即密文；
     - `error`：CLI 自己拒绝了这次调用；
     - `other`：两样都没看到。Grep 的 `other` 一般是 "No matches found"，说明 rg 读到的不是明文；
     - `Edit`、`Write` 记 `ok` / `failed`；`Read2=plain-edited`、`Read3=plain-written` 表示改的、写的都读得回来。
   - 两段 `=== on disk` 记落盘状态：`node=` / `ps51=` 的值是 `TSD`、`edited`、`written`、`json`、`other`、`missing` 之一。
     - **任一读者看到 `TSD`，就是已加密。**
     - 两个读者都没看到 `TSD` 时，以下类型可以判为未加密（以延迟复读那一段为准）：md、java、hpp、xlsx、pdf（加密后 PowerShell 读到密文）；yml、rb、php、ps1、cmd、sql、scss、docx、pptx（加密后 node 读到密文）。
     - 其余类型加密后两个读者都读到明文，要用加密客户端确认，同 P1-13b。
   - 对照 P1-13b 的 node.exe 两张表：读是 42 明文 / 9 密文，写是直接新建 22/51 加密。
6. **判读**（对应下面的备选表）：
   - **读**：在 node 读得出明文的类型上，claude.exe 的 Read、Grep、cat 也是 `plain`，就不比现状差。node 读得出、claude.exe 却是 `cipher` 或 `other`，走 `toolAliases`。
   - **改**：`Edit=ok` 且落盘不再是 `TSD`，与决策 135 的 DSH 语义一致（编辑后变明文，接受）。已加密的文件 `Edit=failed`，`toolAliases` 就要把 Edit 也接到 P1-13d 的回退上。
   - **新建**：claude.exe 新建的文件不加密，与 DSH 一致，按决策 090 是好事。**被加密反而是风险**：在 node 读成密文的 9 类上，宿主侧（历史预览、DSH 引擎）会读不出 claude.exe 写的文件，要记下是哪几类。
7. **入库**：原始输出（`enc-*.txt`、`--capture` 目录、截图）含机器路径和完整请求，只留在本地，`--capture` 目录用完就删。仓库里只放脱敏摘要：每类扩展名每个格子的结果与计数、两种 rg 的差别、transcript 与停止的结论，不写机器名、账号、路径。写法同 P1-13b、P1-13d 证据；仓库是公开的，见 `evidence/history-rewrite-2026-09-28.md`。

**备选方案**（按实测结果选）：

| 情形 | 方案 | 代价 |
|---|---|---|
| claude.exe 读写都正常 | 直接用 | 0 |
| claude.exe 读加密文件拿到密文 | `toolAliases` 把 `Read` / `Edit` / `Write`（以及 Grep / Glob 的内容读取）路由到宿主进程（随包 node.exe）里的 SDK MCP 工具，复用 `src/dsh-host/encryptedRead/` 的 PowerShell 回退。**实测**（`alias-spike.ts`）：模型看到的仍是 CC 原生的 `Read`（790 字说明），调用落到宿主里的 handler。要自己实现与 CC 一致的结果格式（`cat -n`、先读后改校验、编辑语义）。CLI 内部读文件（`CLAUDE.md`、@ 引用）仍在 claude.exe 里。被代理的 `mcp__pilab__Read` 也会出现在工具表 | 1.5～2.5 人周 |
| claude.exe 连自己的 transcript 都读不对（2026-04 现象） | `CLAUDE_CONFIG_DIR` 放到加密策略不覆盖的位置（需管理员确认），或用 SDK 的 `sessionStore`（alpha）把 transcript 镜像到宿主进程 | 0.5～1 人周 |
| 以上都不行 | 社区 Node 重建版 Cometix 跑在随包 node.exe 上（T-11 跑通过的老路）。最新 2.1.285 落后官方 15 个版本，有第三方供应链与许可风险；node.exe 读 9 类文件同样拿到密文，仍需上一行的回退 | 1 人周 + 风险 |

只请管理员把 claude.exe 加入白名单大概率无效，因为 P1-13b 说明解密与进程名无关；以实测为准。

## 6 体积

| 平台 | 原生二进制（解包） | npm 包（gzip） | 安装包增量（估） |
|---|---|---|---|
| win32-x64 | 270.9 MB | 122.6 MB | **约 +90 MB**（xz -6 实测 89.2 MB，NSIS `compression: maximum` 为 LZMA，同量级） |
| linux-x64 | 267.0 MB | 119.5 MB | 约 +90～120 MB（AppImage） |
| linux-arm64 | 266.3 MB | 119.8 MB | 同上 |
| darwin-arm64（暂不做） | 249.6 MB | 109.5 MB | — |

- 还要加上 SDK 主包 4.6 MB，以及它的运行依赖（MCP SDK、zod 等）约 14 MB 解包。
- 对比：现在 Windows 安装包 182～198 MB，所以增幅约 +50%。
- 每次 SDK 升版都要整个重下：10-07 至 10-14 发了 6 版，而且增量下载已关闭（`6e0fd213`）。

## 7 网关与条款

- **请求身份**：
  - UA 是 `claude-cli/2.1.300 (external, sdk-ts, agent-sdk/0.3.300, client-app/pilab/<版本>)`；
  - system 首块是计费头 `x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-ts;`；
  - 鉴权用 `x-api-key`；
  - `metadata.user_id` 是 Claude Code 的 JSON 格式（`device_id` / `account_uuid` / `session_id`）；
  - beta 头与 Claude Code CLI 相同。

  这就是供应商说的「官方调用方式」。会不会原样透传、走对通道，只能用真实网关验证（§10）。
- **只用 API key**：不提供 claude.ai 登录，也不读本机的 Claude Code 登录。
- **品牌**：
  - 预设提示词的身份句是 SDK 自带的（"…running within the Claude Agent SDK"），属于发给模型的内容。
  - 产品界面不能叫 Claude Code。
  - 提交与 PR 的 Claude Code 署名已关（`attribution: false`）。
- **许可**：SDK 与随附的二进制都写着 "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…"。随安装包分发 claude.exe 之前，请对照 Commercial Terms 确认（待拍板）。

## 8 工作量修订

09-26 的估计：最小可用版 5～7 人周，功能对等版 10～15 人周。原型做完后，接缝与事件映射都比预计简单，主要变量移到了加密机和打包。

**最小可用版**：Windows 与 Linux 上 Claude 模型可用，不含加密机。

| 项 | 人周 |
|---|---|
| 引擎接缝产品化：设置项、`claude-sdk` 线名与 `chat.ts` 门禁、侧栏只读预览、故障与回收路径、按会话固定引擎的 UI 约束 | 1 |
| 宿主硬化：鉴权失败、429、上游错误映射成渲染层认得的 `errorCode`；附件；事件录制回归门禁（仿 bridge-record）；单测 | 1～1.5 |
| 凭据：从托管目录或凭据库取网关与 key，经宿主注入，不落盘 | 0.5 |
| 打包：宿主打成 `host.js`，随包原生二进制，electron-builder 配置，体积预算与反向守卫测试 | 0.5～1 |
| 真实网关与 T2 对照（3～5 个用例） | 0.5 |
| **合计** | **3.5～4.5** |

**加密机**：读写矩阵工具已在本分支写好（原估的 0.5 天已花掉）。上机实测约半天到一天，约 0.1～0.2 人周，要用户配合。之后按 §5.2：直接可用为 0；需要 `toolAliases` 承载约 1.5～2.5 人周。

**功能对等版**：在最小可用版之外再加 6～8 人周：
- 子代理泳道 1；
- rewind / fork 1～1.5；
- 后台任务窗口 1；
- 压缩摘要卡 0.5；
- 插话撤回改异步 0.2；
- 失败重试 0.5；
- 历史投影补全（压缩前后、子代理）0.5～1；
- 权限各档精修（全自动语义、拒绝清单、会话授权持久化）1；
- 斜杠命令与技能、MCP 取舍 0.5。

合计约 **9.5～12.5 人周**，加密机另算。

## 9 是否建议正式立项

**有条件立项。** 技术上已经证明能接上，没有证明更好。条件是先花约 1 人周做三项 Go/No-Go，三项都过再按最小可用版立项：

1. **真实网关**：同一网关、同一 key，看 SDK 引擎的请求是否原样到达模型，并核对计费 token 与发送量是否相符。做法同 T1：问模型看到的身份、工具名和环境。
2. **T2 三方对照**：PiLab+DSH、PiLab+SDK、Claude Code CLI，同模型同档位、全自动，3～5 个现场任务。预期 PiLab+SDK 与 CLI 基本一致；若明显好于 PiLab+DSH，立项理由成立。
3. **加密机读写矩阵**（§5.2）：决定加密机走哪条路，以及要不要加 1.5～2.5 人周。

**不建议立项的情形**：
- 网关对 SDK 流量也改写；
- T2 里 SDK 与 DSH 没有明显差别（例如透传通道上 DSH 补完 P1 改进后差距消失）；
- 安装包 +90 MB、每会话 +250 MB 不可接受。

**长期成本**：
- 三引擎阶段（DSH、SDK、只读的 1.0.x 历史）的维护；
- SDK 几乎每天发版，CLI 行为随之变化，需要跟版节奏和录制回归门禁；
- Windows 孤儿进程这类平台问题要自己兜底。

**待拍板**：

1. 是否按 §9 先做 1 人周 Go/No-Go？网关用哪一个、由谁提供 key？
2. `settingSources` 取 `project`，加锁住仓库的 hooks 与 allow 规则（§4），是否同意？
3. 全自动档对应 CLI 的哪种模式（原型：问到即放行；可选：CLI 自带的 `auto` 分类器）？
4. 安装包 +约 90 MB、每活动会话约 250 MB，能否接受？
5. 随包分发 claude.exe 的许可，请法务确认。

## 10 拿到真实网关后的验证步骤

网关 URL 与 key 只在本会话里单独提供，只放进当前 shell 的环境变量，不写文件。

1. **透传检查**：
   - 跑 `SPIKE_API_KEY=<key> node src/claude-sdk-host/tools/sdk-spike.ts <网关根地址> <空工作区> "<让模型逐字列出它看到的工具名、身份句和环境段>"`。
   - 对照本机假网关抓到的请求（`--capture`）：工具名应为 §1 列出的 15 个原生名，身份句是 SDK 预设，环境是本机的 Windows 与 Git Bash；不应出现 `mcp__luban__*` 或他人的 macOS 环境。
   - 再看 `result.usage` 的计费 token 是否与发送量相符（差距调研 §4.1 的口径）。
2. **GUI**：用 `gui-probe.mjs` 的隔离 profile，把 `AICLIENT_CLAUDE_SDK_BASE_URL` / `AICLIENT_CLAUDE_SDK_API_KEY` 换成真实值，在本机临时工作区里跑一个改代码的小任务。
3. **T2**：
   - 在 A/B 评测框架（`src/dsh-host/tools/ab-eval/`，分支 `feat/ab-eval-harness`）加一个 `pilab-sdk` 臂。驱动方式照 `host-probe.ts`：经 IPC 起 `src/claude-sdk-host/host.ts`，网关取框架的 `AB_BASE_URL` / `AB_API_KEY`。
   - 挑 2～3 个用例，对比 PiLab+SDK 与 `claude -p` 的通过率、步数、工具调用分布、计费 token。
   - 两边差别只应来自 PiLab 追加的四行说明、禁用的 10 个宿主工具、关掉的提交署名和审批档位。
4. 测完确认临时目录里没有任何文件含该 key，然后删除临时目录。

加密机的读写矩阵（§5.2）不需要真实网关，全程用本机假网关。
