# PROGRESS — fix/recentBug 总任务台账

> 分支：`fix/recentBug` ｜ 最后更新：2026-07-15（#5/#12 已验收，#11 已完成待验收）
> 数据权威：**git 提交**（提交即检查点）。vflow 提案台账 `.vflow/proposals/` 仅旁证且**已滞后**（时间戳停在 07-03，P-002/P-004 已完成却仍在 active 目录未归档，勿信其 `lifecycle_status`）。

## 状态总览（12 项）

| # | 需求 | 状态 | 提案 | 依据提交 |
|---|------|------|------|----------|
| 1 | 需求2：Root.tsx 状态机抖动收敛为单一状态源（消除 vscode/cli 分支跳变） | ✅ 已验收 | P-003 | `ab7aa64` `0a82753` |
| 2 | 需求3：onboarding UI 指引不足、禁用按钮无解释、流程简化 | ✅ 已验收 | P-005 | `0a82753` `93679ef` |
| 3 | 需求4：install/init/login 脱离 GUI 的 headless 可接管化改造 | ⬜ 待办 | P-007 | — |
| 4 | 测试旁路：admin@jcdz.cc → 固定验证码 123456（仅 dev 构建生效） | ✅ 已验收 | P-006 | `f0e752e` |
| 5 | 临时关闭 client 内置 vflow 及相关功能 | ✅ 已验收（改为彻底移除） | — | `923be69` |
| 6 | IME 按 Shift 切中英时组合文本丢失 | ✅ 已完成 | P-004 | `680026c` |
| 7 | 外观默认：同步终端 / 字号14 / 通用默认树状+集成模式+列表 | ✅ 已完成 | P-008,P-011 | `15c18f2` `ce5edde` |
| 8 | 非 git 目录初始化失败（"暂无 worktree"） | ✅ 已完成·已验收 | P-002 | `471029d` `974e6c6` |
| 9 | worktree add 分支名反斜杠非法（`fix\recentBug`） | ✅ 已完成 | P-002 | `61550b3` `675b946` |
| 10 | 文件重命名回车后文件消失（数据丢失级） | ✅ 已完成 | P-001 | `c09d60e` |
| 11 | agent 全关后除"暂无Agent/新建"外应显示历史聊天记录 | ✅ 已完成·待验收 | — | `75615bd` |
| 12 | bun 版本检测提示应改为每次启动都提示一次 | ✅ 已验收 | — | `e02bd15` |

进度：**已完成 11 / 12**（10 项已验收，#11 待验收），待办 1（#3 已立项）。

## 待办项明细

### 已立项（提案已写，代码未动）
- **#3 P-007**：install/init/login 的 headless 可接管化（架构级，最大块，唯一剩余待办）。

## #5 落地备忘（彻底移除 vflow）
- 用户拍板：非临时关闭，彻底移除（实测 vflow 不如原版 claude code cli）→ `923be69`（23 文件，-1310 行）。
- 移除 5 个运行入口：VflowService 自动植入、session.create 钩子、App toast、AgentInstaller 安装步骤（含 GitHub registry + 离线 tgz 回退）、CliDetector 探测。
- 类型收缩：BuiltinAgentId / InstallAgentId / InstallStepId 去 vflow；删 shared/types/vflow.ts、VFLOW_PROJECT_INITIALIZED 通道、preload vflow API。
- 构建链：删 scripts/*vflow*（3 脚本+2 测试+fixture tgz）、package.json prepare:vflow/assert:vflow、electron-builder.yml vflow/vflow-pkg 资源。
- 仓库根 `.vflow/`（开发流程台账）不属于 client 功能，未动。
- 附带收益：AgentInstaller.test 的 2 个 tsc 预存报错随 vflow 测试删除而消失，现在全仓 tsc 干净。
- 验证：pnpm test 25 文件 211 用例全绿；CDP 实测注册链路+主界面+session.create（pty 正常）无回归。**2026-07-15 已验收**

## #12 落地备忘（bun 提示改标题栏软提示）
- 用户拍板方案 2（标题栏软提示）+吐槽原黄色通栏横幅丑 → `e02bd15`。
- 新增 `ClaudeRuntimeIndicator`（layout/）：bun-incompatible 时标题栏显示 text-warning 盾牌图标，点击 Popover 展示说明+一键降级；降级中转 spinner，成功后自动消失。
- 删 `ClaudeRuntimeBanner` 及 dismissed-version localStorage 持久化——提示每次启动常驻，不可永久关闭（原需求）。
- CDP 实测：无横幅、图标常驻、Popover 开合正常、旧 localStorage dismiss 键失效。**2026-07-15 已验收**（一键降级动作本身未实测——会真改本机 Claude 安装，属破坏性路径，用户验收时自行确认）。

## #11 落地备忘（AgentPanel 空态展示历史会话）
- 用户拍板三点边界：①触发条件=现有空态条件不变（当前 worktree 无活跃 session）；②数据源=直接复用 `SessionManagerView` 已用的 `~/.claude/projects/` 扫描；③交互形态由老王定。
- 方案先过 plan mode 批准，再落地 → `75615bd`（6 文件，+261/-49）。
- 新增 `WorktreeSessionHistory`（chat/）：`pathsEqual(project.path, cwd)` 精确匹配当前 worktree 的 Claude project，展示最近 6 条历史（复用 `SessionItem`），无匹配返回 null 不占位。
- 抽取共享 util `claudeSessionResume.ts`：从 `App.tsx` 内联函数提取为自包含（`resolveClaudeConfigDirForSession`），Home 恢复与 AgentPanel 新恢复共享同一份诊断文案（DRY）。
- `AgentPanel` 恢复跳过 `handleAddLocalRepository`/`setActiveWorktree`（用户已站在这个 worktree 上），直接调用 store 的 `resumeClaudeSession`。
- 新增单测 5 例（claude-null 命中/真实.claude命中/两者皆无/HOME缺失/Windows路径分隔符），`pnpm test` 26 文件 216 用例全绿，tsc 干净。
- CDP 实测：`fix/recentBug` worktree 空态正确显示历史列表（首条即本次对话自身）、点击恢复后 store 记录精确指向该 worktree（未误触发仓库添加）、真实终端成功以正确 `CLAUDE_CONFIG_DIR` 拉起 `--resume`；全新无历史目录空态保持原样无残留。**待验收**
- 验证副作用：resume 会拉起真实 `claude.exe` 子进程，父 electron 进程被杀后可能不随之退出，需手动确认清理（本次验证已发现一个孤儿进程，因权限分类器拦截未能自动清理，已如实告知用户处理）。

## 附带已完成（不在 12 项内）
- P-009 新建/粘贴落仓库根（Windows 反斜杠）：`d4fcc29`
- P-010 持久化层最小回归测试：`4007f9e`
- AgentPanel 改用 selector 订阅 worktreeActivity（避免无谓重渲染）：`46ca2f8`（2026-07-08 已验收）
- dev 注入开关（TEST_LOGIN_DRY_RUN / TEST_CLI_MISSING / TEST_RUNTIME_KIND，#4 测试配套，均 !app.isPackaged 收口）：`7ad3217`

## 建议推进次序
1. ~~#4（成本低、方向已定）✅ f0e752e~~ → 2. ~~#1 + #2（耦合，一起做）✅ ab7aa64 + 0a82753~~ → 3. ~~#5 彻底移除 vflow ✅ 923be69~~ → 4. ~~#12 标题栏软提示 ✅ e02bd15~~ → 5. ~~#11 空态历史会话 ✅ 75615bd，待验收~~ → **6. #3 headless（架构级，唯一剩余，下一步）**

## #1+#2 落地备忘（register-first 重构）
- 方案经用户确认，设计文档：`docs/plans/2026-07-09-onboarding-register-first.md`。
- #1：Root.tsx 500+ 行 → 169 行，门控编排与派生全收进 `useGateStatus.ts`（单一状态源，决策树 9 步 → 8 步）；`refetchInterval`/`vscode-only` 分支已清除。
- #2：以 register-first 形态落地——独立欢迎屏（btn-flow 引导）→ 邮箱 → 验证码 → 完成岔口屏（进入 AiClient / 退出），缺 CLI 先确认再装；删 ClaudeVsCodeOnlyShell 独立壳。
- ⚠️ `ab7aa64` 是中间态提交（tsc 不过），`0a82753` 补齐后恢复。
- **2026-07-14 验收记录（CDP 实测，三链路+探针全过）**：正常链路欢迎→邮箱→验证码→岔口→主界面；TEST_CLI_MISSING 下点【进入】先弹确认不静默装、取消可回退；TEST_RUNTIME_KIND=vscode-extension-only 下显示"可返回 VSCode"提示。探针：非白名单邮箱按钮禁用、错码报"验证码错误"、dry-run 重启回欢迎屏、全程零写盘（真实配置 md5 前后一致）、缺 token 走非 dry-run 旁路响亮报错不写文件。
- 验收追加（用户拍板"用 VSCode 还是 AiClient 由用户选，提示都显示"）：`93679ef` register 变体透传 vscodeExtension，注册当场的完成屏即显示"可返回 VSCode"提示（原先只有重入 cli-missing 分支才显示）。
- 已知小瑕疵（不拦验收，后续可修）：注册完成瞬间 gate 从 register 切 cli-missing 变体会 remount OnboardingShell，若用户恰在此窗口点【进入 AiClient】，确认弹窗被重置吞掉，需点第二次（竞态窗口数秒）。

## #4 落地备忘（测试旁路）
- 仅 `!app.isPackaged` 的 dev 构建生效；固定账号 `admin@jcdz.cc` + 码 `123456`。
- 4 个构建期注入变量：`TEST_CLAUDE_TOKEN/KEY`（缺则报错不写文件）、`TEST_CLAUDE_BASE_URL`/`TEST_CODEX_BASE_URL`（缺则回退 CCH 网关 `https://cch-jyw.pipidan.qzz.io/v1`）。
- 生产打包 isPackaged=true 旁路不执行；CI 不注入凭证故产物无真实密钥。19 单测全绿。

## 备忘
- 死循环根因（#8）：App.tsx 占位 effect（过期 `isGitRepo=false` + 严格 `!==` 路径比较）⇄ useWorktreeSync（斜杠不敏感比较）互相覆盖 activeWorktree，Windows 特有。
- 环境噪音：`pnpm test` 有 3 个既有无关失败；`tsc` 有 2 个 `AgentInstaller.test.ts` 既有报错；biome 整文件 CRLF 报错为本机 checkout 现象，均可忽略。
- vflow 台账归档滞后（P-002/P-004 待归档），如需整理另行指派。
