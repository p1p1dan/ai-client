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

| ID | 任务 | 要点 | 验证 |
|---|---|---|---|
| S-0 | 移植原型 | 从 `proto/claude-agent-sdk-engine` 移入 `src/claude-sdk-host/`（不含 `tools/enc-kit/` 里的 Cometix 部分）与 Main 侧接线（`ClaudeSdkProcessTransport`、`claudeSdkEngine`、`WorkerManager` 改动）、假网关 `claude-sdk` 计划；按 main 现状解决冲突 | 两套 tsc、宿主单测、`host-probe.ts` 全场景对假网关通过 |
| S-1 | 引擎选择与开关 | 新会话按模型选引擎；会话桩固定引擎；设置开关（默认开），关掉后 Claude 新会话走 DSH | 单测；GUI 点验两种模型各开新会话、重启后续聊 |
| S-2 | 五档权限 | 渲染层：引擎是 SDK 时显示五档；`default`/`acceptEdits`/`plan`/`auto`/`bypassPermissions` 映射；中途切换；Plan 档与计划审阅卡衔接；Auto 档实测它额外发的安全检查请求能否经网关正常完成 | 每档一个探针场景；真实网关上 Auto 档跑通一个会触发检查的回合 |
| S-3 | 项目级配置 | `settingSources: ['project','local']`；去掉 `managedSettings` 对 hooks 与 allow 的锁定；`CLAUDE.md` 进上下文 | 探针：带 `.claude/settings.json`（allow + hook）与 `CLAUDE.md` 的测试仓库，断言 allow 生效、hook 执行、`CLAUDE.md` 被引用 |
| S-4 | 打包 | 宿主构建（esbuild，参照 DSH 宿主）；`claude.exe` 进 extraResources（只带目标平台），`pathToClaudeCodeExecutable` 指向它；体积门禁（安装后增量 ≤ 0.6 GB）；`DISABLE_AUTOUPDATER` | 打包后冒烟：从安装目录拉起宿主 → 假网关一个回合；体积门禁 |
| S-5 | 回归与证据 | 探针场景进回归集；录制 SDK 事件序列做门禁；真实网关复跑 T1；GUI 点验清单 | 回归绿；证据写进 `evidence/` |
| S-6 | 测试包与加密机复核 | 出测试包；加密机上装正式安装包，从开始菜单启动 PiLab，跑一个读写加对话的回合；核对安装包落盘的 `claude.exe` 未被加密 | 用户配合上机，结果脱敏入库 |

顺序：S-0 → S-1 → S-2、S-3（可并行）→ S-4 → S-5 → S-6。推送与发版需用户确认。

## 5 已知限制（写进说明）

- 加密机上，yml、rb、php、ps1、cmd、sql、scss、docx、pptx、exe、dll 这 11 类文件 Claude 会话读不出内容（加密策略不放行，与现有 DSH 引擎看到的是同一批）。
- docx、xlsx、pptx、pdf 等二进制，CLI 按扩展名拒读，与加密无关。
- 每个活动 Claude 会话常驻约 250 MB（宿主 node 约 80 MB，`claude.exe` 约 170 MB）。

## 6 风险

- SDK 发版很频繁（10-07 至 10-14 发了 6 版）：钉版本，升级时跑录制回归。
- Auto 档会额外发安全检查请求：网关要能正常处理，S-2 验证。
- 项目 hooks 会执行仓库里的命令（裁决 5 接受）：在说明里提示。
