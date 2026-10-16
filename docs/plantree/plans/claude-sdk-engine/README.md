# 路线 B 立项：Claude 模型改由官方 Claude Agent SDK 驱动（最小可用版）

Role: plan（立项方案，2026-10-16 用户裁决后起草）。分支 `feat/claude-sdk-engine`，从 main `79f81cdb` 开出。

## 0 依据

- **原型与结论**：分支 `proto/claude-agent-sdk-engine`（未推送）。原型文档 `docs/plans/2026-10-14-claude-agent-sdk-prototype.md` 只在该分支上，用 `git show proto/claude-agent-sdk-engine:docs/plans/2026-10-14-claude-agent-sdk-prototype.md` 读。
- **Go/No-Go 三项均已通过**：
  1. 真实网关透传：SDK 引擎的请求原样到达，计费与发送量相符（`a48d1935`，分支 `docs/quality-gap-study`）；
  2. T2 三方对照：PiLab+SDK 与 Claude Code 每个用例步数相同，计费比 PiLab（DSH）少约 68%，成功率三方都是 6/6（`f4b30286`）；
  3. 加密机读写矩阵：官方 `claude.exe` 由随包 node 拉起即可用（原型文档 §5.2，`2a1b2f42`）。
- **工作量**：最小可用版 3.5～4.5 人周（原型文档 §8）。

## 1 用户裁决（2026-10-16）

| # | 事项 | 裁决 |
|---|---|---|
| 1 | 随包分发 `claude.exe` | 内部工具，不涉及对外分发与商用，**正常随包** |
| 2 | 正式安装包上的加密机复核 | 要做：出第一个测试包后上机复核 |
| 3 | 加密策略不放行的 11 类（yml、rb、php、ps1、cmd、sql、scss、docx、pptx、exe、dll） | **选 A**：首版不做额外处理，作为已知限制写进说明 |
| 4 | 开发网关 | 沿用 T1/T2 用的网关 |
| 5 | 项目级配置 | 项目的 `CLAUDE.md`、hooks、allow 规则**都生效**（不再锁仓库的 hooks 与 allow） |
| 6 | 权限档位 | Claude 会话用 Claude 自己的五档：Manual、Edit automatically、Plan、Auto、Bypass permissions |
| 7 | 体积 | 安装后增量 0.6 GB 以内可接受（实测 `claude.exe` 约 271 MB，宿主与 SDK 约 20 MB） |
| 8 | CLI | 用官方 `claude.exe`（随 SDK 平台包），**不用 Cometix** |

## 2 硬约束

1. **宿主跑在随包 `node.exe` 上，`claude.exe` 由宿主经 SDK 拉起**（`pathToClaudeCodeExecutable` 指向随包路径）。加密机上放行是给 `node.exe` 的，并会传给它的子进程；`claude.exe` 和 `PiLabAi.exe` 自己不在白名单。不能改成由 Electron 主进程或别的载体直接拉起 CLI。
2. **只用 API key**：不提供 claude.ai 登录，不读本机的 Claude Code 登录；独立的 `CLAUDE_CONFIG_DIR`；环境变量白名单（不继承 `ANTHROPIC_*`、`CLAUDE_*`）。
3. **CLI 不自更新**：`DISABLE_AUTOUPDATER=1`；SDK 与 `claude.exe` 版本由 `package-lock.json` 钉死，同步升级。
4. **产品界面不叫 Claude Code**；提交与 PR 的署名保持关闭（`attribution: false`）。
5. **其他模型不受影响**：GLM 等模型照旧走 DSH。
6. 只做 Windows 与 Linux（决策 090），macOS 不做。

## 3 范围

**做**：
- Claude 模型的新会话走 SDK 引擎；重开会话时，按会话桩固定当初的引擎。
- 原型已跑通的全部能力：流式正文与思考、工具行、审批卡、提问卡、计划审阅卡、Ctrl+Enter 插话、停止（含 Windows 上 Bash 孤儿进程清理）、用量、重开续聊、`/compact`。
- 五档权限：界面上随时切换，会话中途经 `setPermissionMode` 生效。
- 项目级配置：`settingSources` 取 `project` 与 `local`，hooks、allow 规则照官方行为生效。
- 打包：宿主与 SDK 随包（与 DSH 宿主同样的落盘方式），`claude.exe` 随包（win32-x64、linux-x64、linux-arm64）。
- 开关：设置里可以关掉 SDK 引擎，让 Claude 模型退回 DSH（规范第 6 条）。

**不做（首版）**：
- 对加密策略不放行的类型做任何额外处理（裁决 3）；
- 读用户级 `~/.claude`（技能、用户 `CLAUDE.md`）——首版只读项目级，按反馈再定；
- macOS；
- 1.0.x 历史会话改走 SDK 引擎。

## 4 任务

| ID | 任务 | 要点 | 验证 | 状态 |
|---|---|---|---|---|
| S-0 | 移植原型 | 从 `proto/claude-agent-sdk-engine` 移入 `src/claude-sdk-host/`（不含 `tools/enc-kit/` 里的 Cometix 部分）与 Main 侧接线（`ClaudeSdkProcessTransport`、`claudeSdkEngine`、`WorkerManager` 改动）、假网关 `claude-sdk` 计划；按 main 现状解决冲突 | 两套 tsc、宿主单测、`host-probe.ts` 全场景对假网关通过 | **完成**（2026-10-16，见 §7） |
| S-1 | 引擎选择与开关 | 新会话按模型选引擎；会话桩固定引擎；设置开关（默认开），关掉后 Claude 新会话走 DSH | 单测；GUI 点验两种模型各开新会话、重启后续聊 | 待做 |
| S-2 | 五档权限 | 渲染层：引擎是 SDK 时显示五档；`default`/`acceptEdits`/`plan`/`auto`/`bypassPermissions` 映射；中途切换；Plan 档与计划审阅卡衔接；Auto 档实测它额外发的安全检查请求能否经网关正常完成 | 每档一个探针场景；真实网关上 Auto 档跑通一个会触发检查的回合 | 待做 |
| S-3 | 项目级配置 | `settingSources: ['project','local']`；去掉 `managedSettings` 对 hooks 与 allow 的锁定；`CLAUDE.md` 进上下文 | 探针：带 `.claude/settings.json`（allow + hook）与 `CLAUDE.md` 的测试仓库，断言 allow 生效、hook 执行、`CLAUDE.md` 被引用 | 待做 |
| S-4 | 打包 | 宿主构建（esbuild，参照 DSH 宿主）；`claude.exe` 进 extraResources（只带目标平台），`pathToClaudeCodeExecutable` 指向它；体积门禁（安装后增量 ≤ 0.6 GB）；`DISABLE_AUTOUPDATER` | 打包后冒烟：从安装目录拉起宿主 → 假网关一个回合；体积门禁 | 待做 |
| S-5 | 回归与证据 | 探针场景进回归集；录制 SDK 事件序列做门禁；真实网关复跑 T1；GUI 点验清单 | 回归绿；证据写进 `evidence/` | 待做 |
| S-6 | 测试包与加密机复核 | 出测试包；加密机上装正式安装包，从开始菜单启动 PiLab，跑一个读写加对话的回合；核对安装包落盘的 `claude.exe` 未被加密 | 用户配合上机，结果脱敏入库 | 待做 |

顺序：S-0 → S-1 → S-2、S-3（可并行）→ S-4 → S-5 → S-6。推送与发版需用户确认。

## 5 已知限制（写进说明）

- 加密机上，yml、rb、php、ps1、cmd、sql、scss、docx、pptx、exe、dll 这 11 类文件 Claude 会话读不出内容（加密策略不放行，与现有 DSH 引擎看到的是同一批）。
- docx、xlsx、pptx、pdf 等二进制，CLI 按扩展名拒读，与加密无关。
- 每个活动 Claude 会话常驻约 250 MB（宿主 node 约 80 MB，`claude.exe` 约 170 MB）。

## 6 风险

- SDK 发版很频繁（10-07 至 10-14 发了 6 版）：钉版本，升级时跑录制回归。
- Auto 档会额外发安全检查请求：网关要能正常处理，S-2 验证。
- 项目 hooks 会执行仓库里的命令（裁决 5 接受）：在说明里提示。

## 7 S-0 记录（2026-10-16）

### 7.1 移植了什么

- `src/claude-sdk-host/`：宿主入口、会话 runtime、CLI 环境、会话桩、Windows 进程清理、单测，以及工具 `host-probe.ts`、`gui-probe.mjs`、`sdk-spike.ts`、`alias-spike.ts`、`enc-kit/`（只留 npm 包）。SDK 钉 `@anthropic-ai/claude-agent-sdk@0.3.300`（内置 CLI 2.1.300），独立 `package-lock.json`。
- Main：`ClaudeSdkProcessTransport.ts`、`claudeSdkEngine.ts`、`WorkerManager.ts` 的引擎接缝，原样移入；根 `tsconfig.json` 排除宿主目录。引擎仍只由开发开关 `AICLIENT_CLAUDE_SDK_ENGINE=1` 打开（未打包构建），开关没开时所有会话与 main 相同。
- 假网关 `--plan claude-sdk`。
- main 仍是原型的分叉点 `79f81cdb`，没有文本冲突。
- 没带：原型分支上的文档（原型结论、差距调研、证据），仍按 §0 用 `git show` 读，代码注释里的引用改指本文 §0；T2 分支给评测加的两个启动变量（`AICLIENT_CLAUDE_SDK_MESSAGE_LOG`、`AICLIENT_CLAUDE_SDK_MAX_TURNS`），因为评测框架不在 main 上。

### 7.2 在原型基础上改了什么

1. **enc-kit 去掉 Cometix**：不带 `cometix-tree.mjs`、`README-bundle.txt`；`build-kit.mjs` 只出 npm 包；`run-ccsdk-enc.ps1`、`HANDOFF.md`、`README-npm.txt` 删去 bundle 包；`.ps1` 改存为带 BOM（同 p0-4、p1-13b 的上机脚本），摘要里带出探针的失败断言。
2. **`host-probe.ts` 能自己判定通过与否**：每个场景末尾加确定性断言（`[check]` 行），有一条不过、宿主中途退出或抛错，都以退出码 1 结束。agent 场景等子代理通知那一回合结束再往下走：2.1.300 的子代理是异步的，原来会与下一个场景抢回合（S-0 第一遍跑时 search 场景因此没有调到 Grep/Glob，而退出码仍是 0）。正文类断言只算助手消息，不算宿主回显的用户原文。
3. **`sdkSessionRuntime.ts` 两处**：子代理通知回合的 `origin` 按 `task_id` 判定（原型里 `task_notification` 不带任务类型，把 `task_started` 设的标记冲掉，永远报成 `job`）；运行时自己的失败文案不再写 Claude Code（§2 第 4 条）。
4. **`processTree.ts`**：`reap` 的杀进程函数可注入（工程规范附录 B1），新增 `processTree.test.ts`，测试里 `taskkill` 与 `process.kill` 都被替换。
5. 新增 `pnpm typecheck:claude-sdk-host`（CI 还没跑它，见 7.4）。

### 7.3 验证（全部只用本机假网关）

- `pnpm typecheck`、`pnpm typecheck:dsh-host`、`pnpm typecheck:claude-sdk-host`、biome：通过。
- 宿主单测 `pnpm exec vitest run src/claude-sdk-host`：17 个通过。
- `host-probe.ts` 10 个流程场景（text tools ask stop plan steer agent search compact history）：32 条断言全过，前后两遍一致；停止后约 0.5 s 收到 `session.stopped`，sleep 孤儿 2 s 内清零。
- 续聊（新进程读同一个桩，`history text history`）：9 → 12，与原型一致；抓包确认续聊请求从第一轮 `CC-TEXT hello` 开始，旧对话 25 条都在。
- 加密机矩阵空跑 `enc`：4 个样本 8 条断言全过，结果与原型记录逐格相同（docx 的 Read 是 CLI 按扩展名拒读）。
- 宿主进程中途退出：探针以 1 退出并给出原因（用假宿主验证）。
- 审查时对探针进程树抓了网络连接：CLI 只连本机假网关，没有遥测、更新检查等外连。
- 根目录全量 vitest：660 个文件中 25 个失败。同一批文件在 main `79f81cdb` 上同样失败，是本机环境问题（Windows 未开开发者模式时建符号链接 EPERM、git 类测试在负载下 5 s 超时，每次失败的用例不同），与移植无关；`WorkerManager`、`chatEngineDshOnly`、`t31PiOnlyAbsence`、`packaging-config` 等相关测试全过。

复现：

```
node src/dsh-host/tools/fake-gateway.mjs --port 18932 --plan claude-sdk --reset --model-id claude-opus-5-5
cd src/claude-sdk-host && npm ci
node tools/host-probe.ts http://127.0.0.1:18932 <空工作区> text tools ask stop plan steer agent search compact history
node tools/host-probe.ts http://127.0.0.1:18932 <空工作区> enc
```

续聊：用第一次输出末行的 `sessionFile`、`configDir` 设 `PROBE_SESSION_FILE`、`PROBE_CONFIG_DIR`，再跑 `history text history`。

### 7.4 审查发现与去向

S-0 做了一轮多维审查：移植保真、Main 侧接线、宿主运行时、验证工具四个维度各审一遍，每条发现再由独立复核员尝试推翻，只留下复核确认的（1～17）；最后一轮查漏补了 18～21（查漏员实测或读码确认，未另行复核）。S-0 范围内的问题已在 7.2 改掉；下表是原型本身的缺口，按任务归档。标“待定”的需要用户拍板。

| # | 发现 | 去向 |
|---|---|---|
| 1 | **仓库可改走网关**：被打开仓库的 `.claude/settings.json` 写 `env.ANTHROPIC_BASE_URL`，请求连同 key 就发到它指定的地址（两个假网关实测）。钉在 `managedSettings.env` 无效；钉在 SDK 的 `settings`（flag 层）`env` 里有效（实测）。同理应钉 `DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_GIT_BASH_PATH` | **待定**：建议提前到 S-1 钉住；项目 `env` 其余变量是否生效由 S-3 定。加探针场景 |
| 2 | **key 进子进程**：网关 key 在 `claude.exe` 的环境里，Bash 工具能读到（实测会随工具结果写进 transcript），S-3 之后仓库 hooks 也能读到。CLI 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 能清掉，但会把权限档强制成 default，与 S-2 冲突 | **待定**：S-2/S-3 一起定（`apiKeyHelper`、本机鉴权代理等）；S-5 加 key 金丝雀场景 |
| 3 | 网关在报错里回显 key 时，CLI 把它原样写进 transcript（`api_error` 记录，实测） | S-5 金丝雀场景；只能事后清理或写进已知限制 |
| 4 | **产品版的网关与 key 来源没有任务**：现在 Main 只从自己的环境变量读；原型 §8 列了"凭据：从托管目录或凭据库取，经宿主注入，不落盘"（0.5 人周）。引擎按模型 id 前缀 `claude-` 选，正式版应按路由协议 `anthropic-messages` | **待定**：建议并入 S-1 |
| 5 | **上游错误映射**：401 重试 10 次约 3 分钟；失败的 `errorCode` 是 `success`（取的是 result 的 subtype）；没设流空闲超时；`/compact` 遇到坏网关会堵住同一会话的停止与发送。CLI 自己的提示（如 "Fix external API key"）原样进失败卡。原型 §8 的"宿主硬化"（1～1.5 人周）在任务表里没有对应行 | **待定**：建议并入 S-5（或 S-1 先做 errorCode 映射） |
| 6 | 回合归属竞态（S-0 第一遍探针撞到）：发送与结果没有按 SDK 的 `user_message_uuid` 绑定；CLI 自起回合期间发送会被拒（DSH 是接受的） | S-5 |
| 7 | 跨引擎故障路径：DSH 宿主重启会给忙着的 SDK 会话发 dispose，回合被切断；SDK 会话不受“忙碌不回收”守卫保护（决策 025），后台子代理或 CLI 自起回合可能被空闲回收或容量淘汰关掉；回收批次里 SDK 与 DSH 混在一起时提前返回；杀不掉旧进程树时仍起新进程续写同一会话；退出应用时 SDK 会话不收 dispose；Linux 上只杀宿主进程 | S-1（DSH 宿主重启、忙碌不回收两条）、S-5（其余） |
| 8 | `ClaudeSdkProcessTransport`：`taskkill /T` 假阴性、进程已退出时 `kill()` 返回 false、spawn 失败不报 exit、stderr 按块解码 | S-5 |
| 9 | Windows 停止清理：会杀掉前几回合起的后台任务；会话空闲时关闭反而不清；`ps.exe` 路径推导对 `usr\bin\bash.exe` 不对 | S-5 |
| 10 | 新接缝没有单测；`chatEngineDshOnly.test.ts` 的前提（只有 DSH 一个引擎）已不成立但仍通过 | S-1 |
| 11 | CI 不跑宿主 tsc（宿主依赖 DSH bridge 与 `src/shared` 的类型，main 上改了不会被发现）。脚本已加，CI 步骤可用 `npm ci --omit=optional`（不下 `claude.exe`） | S-4 或 S-5 |
| 12 | 打包门禁：`packaging-config.test.mjs` 与 `t31PiOnlyAbsence.test.ts` 禁止 builder 配置与根依赖里出现 SDK 包 | S-4：照 DSH 宿主做法单独产出目录，由 afterPack 拷入 |
| 13 | 模型看到的身份是 Claude Code（SDK 预设提示词），PiLab 追加的说明里没有身份句 | **待定**：是否在追加说明里加身份句（界面文案已不出现 Claude Code） |
| 14 | CLI 内置的 `totalTokensReminder` 在每一步注入 `<total_tokens>15000000 tokens left</total_tokens>` | S-5 记录，评估要不要关 |
| 15 | `/compact` 后重开会话只见摘要（2 条），看不到压缩前的内容（原型 §3 写"要再核"，已确认） | 功能对等版（历史投影补全） |
| 16 | 探针：agent 场景没断言子代理结果到达模型 | S-5 |
| 17 | `run-ccsdk-enc.ps1` 的两个上机缺陷（原型 §5.2） | 下次用上机包前修 |
| 18 | **跨引擎换模型**：Claude 会话中途把模型换成 GLM 等，会经 Claude CLI 发到 Claude 网关（违反 §2 第 5 条，假网关实测） | **待定**：S-1 定界面怎么拦（模型列表只给同引擎的、发送时拒绝，或另开会话） |
| 19 | 换模型时宿主先记下新模型再等 CLI 校验，校验失败被吞掉，回合却标成新模型；假网关答不了 CLI 的模型校验请求，换模型目前无法用探针验证 | S-2（中途切换）/S-5 |
| 20 | 推送本分支不会触发任何 CI 门禁；DSH 录制回归 `bridge-record.ts --check`（Linux 工具）本地没跑。假网关改动是纯新增：自检 21/21，三个 DSH 计划与 main 版逐字节一致 | 合并前在分支上手动触发 `dsh-bridge-gate`（要推送，需用户同意） |
| 21 | `gui-probe.mjs stop` 按一个从不清理的 pid 文件执行 `taskkill /T /F` | S-5 |
