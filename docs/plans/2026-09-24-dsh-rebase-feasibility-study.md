# DSH 二开可行性调研：以 DeepSeek Harness 为底座重建 ai-client（含 goal 模式对照）

> 日期：2026-09-24 · 触发：用户先提出做 goal 模式并「全面向 DSH 看齐」，当天把范围扩大为「整个产品在 DSH 上二开：完全兼容 DSH 生态，同时保留我方功能」。这推翻了 [08-18 调研档](2026-08-18-deepseek-harness-study.md) §1 的结论「不存在『引入 dsh 重构』这条路」。另加两条硬约束：①加密机是真实部署环境，读不到明文的路线直接不可行；②v1.0.2 已正式在内部使用并进入维护期，只能渐进迁移，旧会话和设置要迁过去。
>
> 取证方式：
> - DSH：`git clone --depth 1` 到 `/tmp/dsh-latest`，再 `fetch --shallow-since=2026-08-17` 补历史，通读 README、文档和源码。
> - npm registry 与 GitHub API 实时查询。
> - Claude Code：官方文档和 CHANGELOG。
> - Codex：`openai/codex` 的 `rust-v0.157.0` 标签源码和 release notes。
> - PI-Desktop：本地检出。
> - 我方：只读工作区。
>
> 编排器抽查（2026-09-24）：MIT 许可、`CONTRIBUTING.md` 不收外部 PR、GitHub 235k star / 创建于 08-13、桌面端宿主用 `process.execPath`（Electron 自身）、`tool-goal` 的 peer 依赖，均与本档一致。
>
> 参照版本：
> - **DSH 最新**：master `477b4f42`（2026-09-24 21:39 +0800，tag `dsh-v0.1.7-rc.2`）。
> - **DSH 基线**：`c1eac0ba`（2026-08-18 22:13 +0800，当天 master 最后一个 first-parent 提交）。08-18 调研档没记哈希，这个基线是按日期推定的。
> - **Claude Code**：文档页截至 2026-09-24。
> - **Codex CLI**：`rust-v0.157.0`（2026-09-25 发布）。
> - **PI-Desktop**：`ea6b9936`（2026-09-10）。
> - **ai-client**：工作区 HEAD `324581ac`（1.0.3-test.1）。
>
> 引用约定：
> - DSH 引用写成 clone 内的相对路径（仓库根为 `/tmp/dsh-latest`）。
> - PI-Desktop 引用以 `PI-Desktop/` 开头。
> - 我方引用写成 `file:line`。
> - Claude Code 和 Codex 的论断一律附 URL。
> - 查不到一手来源的地方直接写「未证实」。

## 0. 结论先行

1. **08-18 的结论该推翻，因为前提变了。**
   - 08-18 时 DSH 还只是 runtime 框架。现在它是完整产品：
     - 有 Electron 桌面端（`apps/desktop`，08-31 加入，提交 `19444907f`），带插件管理页和自动更新。
     - npm 上有 323 个 `@deepseek-ai/*` 包。
     - 社区生态很大：社区目录 `dsh-plugin-catalog` 收录 4258 个插件，GitHub topic `dsh-plugin` 下有 16071 个仓库。
   - 我方在 09-08～09-13 已把自己换成「Cordis + pi-ai」（`src/runtime/package.json:12-14`），和 DSH 的 `llm-pi-ai` 同源。
   - ARD 当初也把路线写成了「ai-client → PI-Desktop 形态 → DSH 形态」（`docs/plans/2026-09-08-runtime-evolution-ard.md:8`）。
2. **「完全兼容」要拆成几个等级，否则没法验收：**
   - L0：格式级，即技能、MCP、AGENTS.md、Claude Code hooks。
   - L1：宿主插件能装能跑。
   - L2：客户端界面插件能显示。
   - L3：和官方 DSH 共用 profile 与会话。

   L1 只有跑真正的 DSH 核心才能做到。L2 只有跑 DSH Web 客户端才能做到。社区最热门的插件多是 L2（界面）类，见 §1.3。
3. **推荐 B 路线：DSH 宿主做 worker 引擎，我方外壳和渲染层保留。**
   - 做法：写一个我方 bundle（叠在 `dsh-base` 之上，和 DSH 自己的 `sdk-app` / `web-app` 同一种形态），由现有 WorkerManager 用随包 `node.exe` 拉起。再写一个 bridge 插件，把 DSH 会话事件翻成现有的 RuntimeEvent。
   - 这样界面不用改，加密机载体沿用现场已验证的那个，也能用双引擎开关渐进切换。
   - 估算：P0～P2 约 10～14 人周，拿到 L1 和部分 L3。
   - L2 另立可选的 P3（8～12 人周），在 P2 之后根据插件需求再决定。
4. **不推荐 A（直接 fork DSH 桌面端）：**
   - 量级 16～24 人周，而且对用户是一次性大切换：聊天界面、审批模型都要换。
   - 官方桌面端的宿主跑在 Electron 自身上（`apps/desktop/src/main.ts:149`），按 ARD D11 推断在加密机上读到的是密文。
   - 上游 5 周内合入 829 个提交，而且不接受外部 PR（`CONTRIBUTING.md:9`），fork 的维护成本长期背着。
5. **C（在我方 runtime 里兼容加载 DSH 插件）不成立。**
   - DSH 插件的 peer 依赖是 `@deepseek-ai/cordis` 4.0.x（DSH 自己维护的 fork）和 `dsh-agent`、`dsh-tools`、`dsh-session` 等核心包。
   - 要兼容就得把 DSH 核心重写一遍并持续追版，最后等于 B，却多一层自研。
6. **第一个里程碑（P0）：**
   - DSH 官方 goal 四件套（`dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver`，外加 `dsh-tool-todo` / `dsh-tool-jobs`）原样跑在我方应用里。
   - 在加密机上确认 DSH 宿主经 `node.exe` 读写的是明文。
   - 装一个官方 DSH Desktop 作对照组，验证第 4 条里的推断。
7. **在飞任务：**
   - D1（读图）：保留（本档原建议另开 `read_image`，编排器改为 read 内置图片分支，见 §6）。
   - D3（bash 流式）和 D4（后台 bash）：暂停，改从 DSH jobs 获得。
   - T125（中止回复用量记 0）：保留，是小修。
   - T138 / T8（goal 模式）：并入 P0 / P1。

## 1. DSH 生态现状

### 1.1 官方包与组装方式

| 项 | 事实 | 出处 |
|---|---|---|
| 官方 npm 包 | 仓库里有 325 个 `package.json`，其中 323 个是公开包，逐个查 registry 均返回 200；只有 `dsh-desktop` 和 `dsh-desktop-host` 标了 `private` | `packages/*/*/package.json`、`vendor/*`、`apps/*`（逐个请求 registry） |
| 维护者 | npm maintainers 是 `imccyu` 和 `tianyicui-deepseek`，由 GitHub Actions 发布 | `https://registry.npmjs.org/@deepseek-ai%2Fdsh` |
| 发版节奏 | `@deepseek-ai/dsh` 从 2026-08-10 到 09-24 共发了 27 个版本；dist-tag 为 `latest=0.1.5-rc.3`、`next=0.1.7-rc.2`、`alpha=0.1.7-alpha.2`，也就是 `latest` 落后 | 同上 |
| 内核 | vendored `@deepseek-ai/cordis@4.0.4`，基于上游 `cordis 4.0.0-rc.7`，带本地生命周期补丁（fiber 重入释放等） | `vendor/README.md` Manifest 与 Local modifications 第 6 条；`vendor/cordis/package.json` |
| 我方内核 | 上游 `cordis@4.0.0-rc.9`，另一个包 | `src/runtime/package.json:14` |
| 包清单字段 | `dsh.client` 70 个（界面插件）；`dsh.bundle` 12 个：`dsh-base`、`web-app`、`headless`、`sdk-app`、`sdk-minimal`、`acp-app`、4 个实验性、`subagent-claude-code`、`subagent-codex`；`dsh.sessionFormatMigration` 4 个 | 扫描 `packages/*/*/package.json` |
| 组装 | profile 放在 `$DSH_HOME/profiles/<name>`，由 `package.json` 的 `dsh.profile.bundles` 决定 bundle 顺序，用户覆盖写在 `cordis.patch.yml` | `apps/cli/README.md` Entry modes；`packages/boot/plugin-manager/README.md` |
| 插件管理 | 用 pnpm 安装；安装前按 DSH peer 版本拒绝不兼容的包；可在 `compatibility.json` 里做逐版本豁免；支持镜像回落（默认 npmmirror）；Web 端有 Plugins 页，模型侧有 `plugin_manager` 工具 | `packages/boot/plugin-manager/README.md` 的 Version compatibility、Configuration 两节 |
| 产品形态 | `apps/cli`（`dsh --profile web/acp/sdk/headless`）、`apps/web`、`apps/desktop`（Electron 44 + electron-updater + Windows EV 签名 + 强制更新） | `apps/cli/README.md`；`apps/desktop/package.json`；`apps/desktop/README.md:385` |
| 宿主和客户端的连接 | Typert：`@Remote` 生成 Client 方法，走 `/api` 和 `/api/remote.mux` WebSocket；客户端插件由宿主以 `/plugins/<id>/client.js` 下发 | `docs/api-gateway.md`；08-18 调研档 §2 |
| 能力接缝 | 约 90 个 `ctx.*` 服务/接缝，每个都登记了定义方、提供方和消费方 | `docs/capability-seams.md:570-660` |
| 会话日志 | 自有的事件溯源格式，写入版本 **v4**（基线时为 v0），带 v0→v1→v2→v3→v4 迁移链；JSONL 默认用 zstd 帧压缩 | `packages/core/session/src/types.ts:89`；`docs/session-format-status.md`；`packages/session/session-persistence-jsonl/README.md` |
| 遥测 | `dsh-base` 默认挂 `session-telemetry-otel`（FEEDBACK_ONLY 模式，只在用户明确反馈后上传会话日志前缀，目标 `harness-telemetry.deepseeksvc.com`），带匿名用户 ID，可用 `DSH_TELEMETRY_DISABLED` 关闭 | `packages/bundle/base/cordis.patch.yml:188-210` |

### 1.2 社区生态（第三方）

| 项 | 事实 | 出处 |
|---|---|---|
| 仓库热度 | 235,232 star、28,296 fork，创建于 2026-08-13 | `https://api.github.com/repos/deepseek-ai/deepseek-harness`（2026-09-24 查询） |
| topic 规模 | GitHub topic `dsh-plugin` 下有 16,071 个仓库 | `https://api.github.com/search/repositories?q=topic:dsh-plugin` |
| 社区目录 | `dsh-plugin-catalog@2026.924.4355` 收录 4258 条，由 awesome-dsh-plugin 维护。分类：ui 726、tools 563、dev 312、session 281、workflow 257、usage 226、model 203、memory 199、skill 169、git 105……下载量中位数 80.5，≥1000 下载的 866 个，≥10 star 的 667 个 | npm `dsh-plugin-catalog` 的 tarball `package/plugins.json` |
| 下载量前列 | `dshmarket`（插件市场）、`dsh-better-sidebar`（带文件编辑、终端、Git、子代理的侧栏工作台）、`@linxin666/dsh-remote-web-ui`、`dsh-client-ui-git-graph`、`billion-context`（压缩）、`dsh-context`、`dsh-cost-meter` 等 | 同上 |
| 第三方前端 | `@deepseek-harness-tui/dsh-tui@0.11.0`、`@openma/deepseek-harness-acp` 等 | npm search `deepseek-harness` |
| 插件的依赖形态 | `dsh-better-sidebar@0.21.1` 的 peer 依赖是 `@deepseek-ai/cordis ^4.0.4` 加上 `dsh-agent/tools/session/settings/subagent ^0.1.7-rc.1` 和一批 `dsh-client-ui-*`；`dsh-context` 依赖 `dsh-session >=0.1.5-rc.1` 与 `client-ui-primitives`；`billion-context` 只有 bundle | `https://registry.npmjs.org/<name>/latest` |

### 1.3 「完全兼容」应该指什么

| 等级 | 含义 | 需要什么 | 价值 |
|---|---|---|---|
| L0 格式级 | SKILL.md / AGENTS.md / MCP / Claude Code hooks 可以直接复用 | 格式对齐即可 | 已基本具备，只缺 hooks |
| L1 宿主插件 | 社区和官方的工具、提示词、模型、记忆、压缩类插件能原样装、原样跑 | 真正的 DSH 核心：`@deepseek-ai/cordis` 加 `dsh-agent/session/tools/llm/...` | 高，能接住 tools/model/memory/session 等类别 |
| L2 客户端插件 | 带 `dsh.client` 的界面能显示（ui 是最大的类别） | DSH Web 客户端运行时（React 18 + `client/modules` + `ui-slots`）；我方渲染层是 React 19 + @coss/ui，无法原地承载 | 高，但代价也最高 |
| L3 数据互通 | 和官方 DSH 共用 profile 与会话，可以互相打开 | 采用 DSH 会话格式 v4 和 profile 布局 | 中，主要换来用户数据的可迁移性 |

建议的验收口径：P2 结束时达到 L0 + L1 + L3（会话格式）；L2 由 §9 的拍板点决定是否排 P3。

### 1.4 08-18 → 最新：变化了什么

- **规模**：first-parent 合并 829 个；包从 221 个增加到 312 个（新增 110，删除或改名 19）；版本从 `0.1.0-rc.7` 到 `0.1.7-rc.2`；会话格式从 v0 到 v4。`packages/core` 共变更 154 个文件，+14.4k / −5.8k 行。
  - 取证命令：`git diff --stat c1eac0ba HEAD -- packages/core`，以及对 `packages/*/*` 的 `ls-tree` 做对比。
- **新增（和我们相关的部分）**：
  - `apps/desktop`（Electron）。
  - `api/{session,workspace,terminal,settings,account,job}-controller`。
  - `boot/{plugin-manager,config-editor,hmr}`，以及 `client/ui-plugin-manager`。
  - `client/ui-{chat,session,approval,schedule,sidebar-files,sidebar-terminal,sidebar-browser,sidebar-documentpreview,settings-agent-loop,settings-subagent,settings-web-search}`。
  - `compaction/compaction-image-offload`。
  - `credentials/{authorization,deepseek-account,deepseek-account-platform}`，即 DeepSeek 账号登录。
  - `deliverables/{tool-present,workspace-changes}`。
  - `document/office-to-pdf`、`skill/{skill-office,tool-workspace-dependencies}`，桌面端还捆绑了 Python、Node 和 pnpm（`apps/desktop/README.md:51`）。
  - `browser-use`、`computer-use`、`ptc-runtime`（程序化工具调用）。
  - `ssh/{fs-ssh,subprocess-ssh,sandbox-ssh}`、`webhook`。
  - `session/{session-format*,session-turn-outline}`。
  - 实验性的 `agent-team`、`auto-review`、语音输入。
- **删除或改名**：
  - `e2b/*`、`examples/*`、`host/apiproxy`、`settings/settings-file`、`session/session-persistence-sqlite`、`subagent/tool-subagent-report`、`workflow/workflow-worker-thread` 被删除。
  - `code-runtime/*` 改为 `ptc-runtime/*`。
  - `preset/agent-presets` 拆成 `agent-preset` 和 `agent-preset-registry`。
  - `experimental/team` 改为 `agent-team`。
- **08-18 就有但当时没记的**：goal 四件套、`plan-mode`、`tool-todo`、`jobs`、`schedule`、`tool-ralph`、`tool-workflow`、`web/tool-web`、`tool-subagent-control`、`guard/repeat-tool-reminder`、`hooks-claude-code`、`permission-presets`、`tool-lsp`、`tool-session-query`。取证：这些路径都在基线的 `ls-tree` 里。
- **08-18 指出的两个缺口还在**：
  - SDK JSON-RPC 仍然没有 per-prompt cancel 和 close（`packages/sdk/server/README.md:125`）。
  - ACP 仍然不发原始 delta（`packages/acp/acp/README.md:92`）。

  所以全保真的通道只有 Web gateway（Typert）一条。B 路线因此选择「宿主内置 bridge 插件」，而不是走这两条外部通道。

## 2. 许可与治理

| 项 | 事实 | 出处 | 含义 |
|---|---|---|---|
| 许可 | 仓库 `LICENSE` 是 MIT；HEAD 上全部 `package.json` 都写 MIT。npm 上最早的 `0.0.1-rc.1～rc.5`（08-10～08-12）是 BSD-3-Clause，从 `0.1.0-rc.2` 起改为 MIT | `LICENSE:1`；registry `versions[*].license` | 可以 fork、二开、闭源内部使用；只需保留版权声明 |
| 贡献 | 「cannot accept external pull requests at the moment」 | `CONTRIBUTING.md:9` | 修复进不了上游，只能自己带补丁或写插件 |
| 稳定性 | developer preview，「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」 | `README.md:13` | 必须钉版本，按节奏升级 |
| 破坏性变化实例 | 会话格式 5 周内从 v0 升到 v4；删改 19 个包；核心代码大量变动（见 §1.4） | §1.4 | 插件 API 不稳定，社区插件也在逐版本追赶（peer 写 `^0.1.7-rc.1`） |
| 兼容机制 | 安装时做 peer 版本检查，另有逐版本的豁免文件 | `packages/boot/plugin-manager/README.md` Version compatibility | 每次升级 DSH 都可能让一批插件被拒 |
| 打补丁的先例 | DSH 自己在根目录维护 `patches/`（pnpm patch），vendor 目录下的 cordis 也带本地修改日志 | `patches/`；`vendor/README.md` | 给依赖打补丁在这个生态里是正常做法 |

**结论：采用「钉版本消费 npm 包 + 插件优先」，不 fork 整个仓库。**
- 我方代码全部写成插件，外加一个我方 bundle。
- DSH 包用精确版本引用；迫不得已时才用 pnpm patch，并登记补丁清单。
- 升级节奏由我们定，建议每 2～4 周一次，以回归夹具作门禁。
- 只有 B 路线能这样做。A 路线要改 `apps/desktop` 的源码，必然变成 fork 并长期跟踪上游。

## 3. 我方功能清单与落点

「B 落点」指推荐路线下代码放在哪里：「外壳」是 Electron Main 或渲染层，基本不动；「宿主插件」是 DSH 宿主内的我方插件；「bridge」是 §4 的桥接插件。

| 功能 | 我方证据 | B 落点 | A 落点 | DSH 是否有同类 | 备注 |
|---|---|---|---|---|---|
| 登录托管凭据与密钥库 | `src/shared/credentialMode.ts:67`（`AICLIENT_MANAGED_CREDENTIALS`）；`src/main/services/auth/CredentialVault.ts:2`；`managedCredentialsStartup.ts:55` | 外壳保留（safeStorage 只能在 Electron 里用）；另写宿主插件提供 `ctx.credentials`，密钥经 IPC 下发 | 需要改 fork 的 Main | 有 `credentials` 接缝和 `deepseek-account`，但只支持 DeepSeek 账号（`docs/capability-seams.md:605-607`） | 接缝可以替换 |
| 托管模型目录与网关 | `src/main/services/piModelConfig/nativeCatalog.ts:17`；ARD D15 | 宿主插件：把 Main 在内存里拼好的目录转成 `llm-pi-ai` routes | 同左 | `llm-pi-ai` 支持纯配置声明路由（`packages/llm/llm-pi-ai/README.md`），依赖 pi-ai `^0.85.1`，我方是 0.84.4 | 同源，迁移成本低 |
| 周额度 | `src/shared/weeklyQuota.ts:50`；`src/main/services/usage/UsageService.ts` | 外壳保留 | 要重写成客户端插件 | 无（社区有 `dsh-cost-meter`） | — |
| 公告铃铛 | `src/renderer/components/announcements/AnnouncementBell.tsx:39`；`AnnouncementService.ts:14` | 外壳保留 | 要重写成客户端插件 | 无 | — |
| 审批卡与四档权限（决策 023 / 026） | `src/shared/types/runtimePermission.ts:2,16`；`src/runtime/plugins/permissions/index.ts:318,541`；`grants.ts:48`；`PendingPermissionDock.tsx:45` | 卡片留在外壳；策略（档位、授权记忆、bash AST、拒绝清单）移植成宿主插件，挂在 `user-approval` 的 answerer 和工具执行前的拦截上 | 卡片和策略都要重写 | DSH 是「沙箱 + 逐次审批」模型，**只有一次性授权**，没有授权记忆（`packages/interaction/user-approval/README.md:155`）；预设是 sandbox + approval 的组合（`permission-presets`） | **两种模型冲突，需要拍板（§9-3）** |
| pi 会话兼容与 GUI/TUI 互通 | `src/runtime/README.md:74,79-80`（树、导航、回退、fork，pi v1～v3 迁移）；`src/main/services/terminal/PiTuiPty.ts:203` | 宿主插件：打开旧会话时按需转换成 DSH v4 事件（只复制、不改原文件）；内嵌 pi TUI 的去留见 §9-5 | 同左 | DSH 只有按事件序号 fork（`packages/api/session-controller/README.md:55`），没有同文件内分支和回退；官方没有 TUI | 分支语义会降级 |
| Claude Code / Codex 历史导入 | `src/main/services/legacyImport/LegacyImportService.ts:62` 及同目录的扫描器 | 外壳保留，输出格式改成 DSH v4 | 同左 | 无（只能兼容 CC 和 Codex 的 hooks 配置） | 是我方差异化能力 |
| Electron 打包、自动更新、Windows 与加密机支持 | `src/main/services/updater/AutoUpdater.ts:21`；`scripts/afterPack.mjs:21,66`（随包 node-runtime）；`src/main/utils/tsdSafeRead.ts:15`；`src/shared/windowsCodePage.ts` | 外壳保留；DSH 运行时像 agent-host 一样由 afterPack 放到 asar 之外 | 要改 fork 的 electron-builder 配置和宿主载体 | 有完整的桌面端和更新机制，但宿主跑在 Electron 自身 | 见 §4 加密机表 |
| Git 面板、分支栏、worktree | `src/main/services/git/GitService.ts:74`；`WorktreeService.ts:79`；`src/renderer/components/chat/BranchColumn.tsx:38` | 外壳保留 | 要重写成客户端插件 | 只有「本轮改了哪些文件」卡片（`packages/deliverables/workspace-changes/README.md`） | 社区有 git-graph 插件 |
| 文件树与 Monaco 编辑器 | `src/renderer/components/files/EditorArea.tsx:1`（Monaco）；`src/renderer/components/files/` 约 8k 行 | 外壳保留 | 要重写 | 只有文件侧栏和只读预览（`client/ui-sidebar-files`） | — |
| 终端 | `src/main/services/terminal/PtyManager.ts:351` | 外壳保留 | 可以改用 DSH `ui-sidebar-terminal` | 有（`api/terminal-controller`） | — |
| 中文界面 | `src/shared/i18n.ts:3` | 外壳保留 | DSH 自带中英文 | 有（`client/locale`） | — |
| 子代理与防空转（决策 042） | `src/runtime/plugins/subagent/index.ts:96-99,209`；`agent-loop/delegationLoopGuard.ts:36` | 改用 DSH 的 subagent 工具；我方四个内置角色迁成 DSH 的子代理定义；「流式阶段掐断」写成宿主插件包在 `ctx.llm` 外层 | 同左 | 有，而且能力更全：一次性或可续跑、后台运行、`send_message` / `interrupt_agent`、子代理浏览器；防循环只有提醒（第 3/5/8 次，`guard/repeat-tool-reminder`） | 模型看到的工具名会变 |
| Ctrl+Enter 插话（决策 041） | `src/runtime/plugins/agent-loop/index.ts:311,349` | bridge 把插话映射成 DSH 的 `Agent.steer()` 和队列 | 同左 | 有 steer 和 Queue 卡片（`packages/goal/tool-goal/README.md` Design；`client/ui-goal/README.md:28`） | steer 在哪个时机交付**未核实** |
| 500 轮上限与收尾轮（决策 040） | `agent-loop/index.ts:216`；`src/shared/internalMessage.ts:38` | 写成宿主插件（监听 `agent/pre-step`） | 同左 | 未见主会话轮次上限（**未全面核实**） | — |
| 远程 SSH | `src/main/services/remote/RemoteConnectionManager.ts:115` | 外壳保留；以后可对接 DSH 的 `ssh/*` 接缝 | — | 有 `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` | — |
| 临时工作区（决策 018 / 020） | `src/main/services/agent-host/TempWorkspaceService.ts:64` | 外壳保留 | — | 无 | — |
| AI 生成提交信息、代码审查、分支名 | `src/main/services/ai/commit-message.ts:7` | 外壳保留 | — | 无 | — |
| 搜索面板、代理、自定义 provider、引导流程 | `src/main/services/search/SearchService.ts`、`proxy/ProxyConfig.ts`、`userProviders/UserProviderService.ts`、`onboarding/` | 外壳保留；自定义 provider 转成 llm routes | — | 部分有（`ui-settings-models`、`util/http-proxy`） | — |
| pi 插件管理 | `src/main/services/piPlugins/PiPluginService.ts:42` | 由 DSH 插件管理取代（§9-2） | 同左 | 有 | 旧的 pi 插件要下线 |
| 时间线交互规范（决策 021～045：过程折叠、回合计时、失败卡等） | `src/renderer/components/chat/`，约 3.4 万行 | 外壳保留 | 要全部重写成客户端插件 | DSH 另有一套 `ui-chat` | A 路线最大的重写项 |

补充：我方渲染层 chat 部分约 3.4 万行，stores 约 0.9 万行，renderer 合计约 10 万行；Main 约 4.7 万行，runtime 约 2.7 万行（去掉测试后 `wc -l` 统计）。

## 4. 迁移方案对比与推荐

### 4.1 加密机：每条路线逐项回答

背景事实：
- TEC 加密驱动按**进程**放行明文。打包后的 Electron exe 及其派生的子进程读到的是密文；目前只有随包 `resources/node-runtime/node.exe` 在白名单里（ARD D11，`docs/plans/2026-09-08-runtime-evolution-ard.md:215-255`；§8 现场记录 `:523-531`）。
- Main 读用户文件一律走 `tsdSafeRead`（D13，`:266-292`）。
- bash 载体至今未签收：R2、R3 没过（`docs/plans/2026-09-09-bash-carrier-decision.md` §6）。

| 问题 | A：fork DSH 桌面端 | B：DSH 宿主当 worker 引擎（推荐） | C：我方 runtime 兼容加载 DSH 插件 |
|---|---|---|---|
| DSH 宿主由哪个进程运行 | 官方做法是 Electron exe 加 `ELECTRON_RUN_AS_NODE=1`（`apps/desktop/src/main.ts:149`、`src/node-environment.ts:15`、`README.md:64`）。**推断**加密机上读到密文，与我们 09-08 utilityProcess 载体失败、PI-Desktop Rust 宿主失败属同一类（ARD `:523,:525`），**未实测**。fork 后要把宿主改成 node.exe | 现有 `PiWorkerProcess` 用随包 node.exe 拉起（`src/main/services/agent-host/PiWorkerProcess.ts:86`；载体 `bundled-node`，见 `src/runtime/contracts.ts:378`、`src/runtime/host/worker.ts:71`），入口换成我方 bundle 的 boot | 不变（随包 node.exe） |
| 能否跑在随包 node.exe 上 | 能，但要改三处：宿主可执行文件；`app.asar/dsh` 移出 asar（`apps/desktop/README.md:65`，原生 Node 不能读 asar）；runtime 描述文件里绑定的是 Electron 的 Node 版本 | 大概率能，P0 要验证：DSH 要求 `node ^22.19 \|\| >=24`（根 `package.json:8-9`），我方是 v24.18；`node:sqlite` 是内置模块；`native/system` 在 Windows 上不加载（`native/system/README.md` Support）；**待探针**：`subprocess-local` 依赖的 `node-pty@1.2.0-beta.15` 预编译是否兼容 Node ABI，以及 `--expose-internals`（`apps/desktop/src/host-process.ts:190`）是否必需 | 能 |
| `fs/*` 和 `tools/*` 能否换成我方的载体感知实现 | 接缝可以换：`ctx.fs`（已有 fs-local / fs-sandbox / fs-ssh 先例，`docs/capability-seams.md:643`）、`ctx.subprocess`（`:634`）、`ctx.shell`（`:635`）。**但光换接缝不够**：有 64 个 DSH 包直接调 `node:fs`（如 `tool-fs-search`、`skill-filesystem`、`agent-instructions`、`session-persistence-jsonl`、`attachment-local`、`workspace-changes`），所以**宿主进程本身必须在白名单里** | 同左。我方 `HostIo` 在遇到 TSD 容器时回落到 node 帮手进程（`src/runtime/host/io.ts:30,85`），可以移植成 `fs-aiclient` 作兜底，但不是必需 | 不涉及 |
| Web 客户端或 Typert 架构会不会引入读用户文件的白名单外进程 | 会，有几处：①Composer 上传附件时是页面读 Blob（`packages/client/file-upload/README.md`），实际读文件的是 Chromium 进程，会读到密文，需改成路径引用（`__DSH_HOST_PATHS__`，`apps/desktop/src/preload-app.ts:81`）；②侧栏浏览器 `<webview>` 打开本地文件，**未核实**；③宿主派生的 Python 运行时 / office 技能 / LibreOffice（`office-to-pdf`）/ Windows ACL 沙箱降权子进程（`sandbox-windows-acl`）/ bash、pwsh，**都没验证过** | P1～P2 不加载 Web 客户端和 webserver，不会新增这类进程；附件本来就是传路径给 worker 读（`src/main/services/files/PickedAttachmentAccess.ts:99`）。宿主派生的子进程问题和 A 相同（bash 与现状一样悬而未决）。P3 如果接入 Web 客户端，就回到 A 的①② | 不涉及 |
| 可行性 | 改完 fork 后**有条件可行** | **可行**，载体就是现场已验证的那个 | 可行，但没有兼容价值 |

**额外风险（三条路线都有）**：
- DSH 在 Windows 上默认用 `sandbox-windows-acl`，对子进程降为低完整性令牌加能力 SID。加密驱动会不会认这类进程**完全未知**。P0 要单独测，不行就关沙箱，退回我方的审批模型。

### 4.2 综合对比

「人周」按上一次换芯的节奏粗估（ARD 09-08 → 09-13 默认切换 → 09-23 发 1.0.2），包含代理协作，不含等待上机的时间。

| 维度 | A：fork DSH 桌面端 | B：DSH 宿主当 worker 引擎 | C：兼容层 | B + P3（L2） |
|---|---|---|---|---|
| 到默认切换的工作量 | 16～24 人周 | **10～14 人周** | 无法封顶（要持续追 DSH 核心） | 在 B 之后再加 8～12 人周 |
| 1.0.x 用户保留什么 | 会话要转换；设置大多要重新映射；聊天界面、Git 面板、Monaco 要等移植完才有 | 界面、设置、登录、额度、公告、Git、编辑器、终端**全部保留**；会话按需转换 | 全部保留 | 聊天面会换成 DSH 客户端 |
| 用户失去什么 | 决策 021～045 定下的时间线规范、逐次审批与授权记忆（除非移植）、pi TUI 互通、同文件分支 | pi TUI 互通（§9-5）；会话树降级为 fork；模型侧工具名变化 | 基本不失去，也得不到生态 | 同 B，另加聊天 UI 惯例 |
| 增量性 | 低：两套外壳要并行到一次性切换 | **高**：双引擎开关，1.0.x 照常维护，和 P4～P6 同样打法 | 高 | 中 |
| 生态兼容 | L1 + L2 + L3 | L1 + L3（格式） | 名义上 L1，实际做不到 | L1 + L2 + L3 |
| 长期维护 | fork 要跟上游：5 周 829 个合并，且不收外部 PR | 钉 npm 版本，插件优先 | 自己维护一份 DSH 核心 | 同 B |
| 加密机 | 需要改 fork | 沿用已验证的载体 | 沿用 | 另需验证 Blob 与 webview |

**C 为什么会退化成 B**：社区插件的 peer 依赖钉在 `@deepseek-ai/cordis ^4.0.x` 和 `dsh-agent/session/tools/llm/...` 上（§1.2）；官方插件也一样，例如 `packages/goal/tool-goal/package.json:29-35`。它们要求的约 90 个 `ctx.*` 服务和会话事件语义（`docs/capability-seams.md:570-660`）只有 DSH 核心包本身能提供。让我方 runtime 去「加载」它们，最终就是把这些核心包装进 worker，也就是 B。

**推荐 B，并把 P3（L2）留作以后可选的一步。** B 宿主形态的要点：
- 我方写一个 `@aiclient/dsh-app` bundle，叠在 `dsh-base` 上，和官方 `sdk-app` / `web-app` / `acp-app` 同形（`packages/bundle/*`）。
- bundle 里做四件事：
  1. 关掉 `host/webserver`、`frontend-static`、`session-telemetry-otel`（`DSH_TELEMETRY_DISABLED`）、`deepseek-account`。
  2. 挂上我方插件：`aiclient-bridge`、`aiclient-permissions`、`aiclient-models`、`aiclient-credentials`、`aiclient-loop-guard`、`aiclient-turn-ceiling`、`aiclient-session-import`。
  3. 用 `dsh-app-boot` 启动（`packages/boot/app-boot/README.md` 写明该库可供底层嵌入方使用）。
  4. `aiclient-bridge` 替代现在的 `nativeWorkerRuntime.ts`（1077 行）和 `events/projector.ts`（862 行），对外仍说现有的 worker RPC 协议，输出约 30 种 RuntimeEvent（`src/shared/types/runtimeEvents.ts`）。审批和提问分别注册为 `user-approval` 的 answerer 和 `user-questions` 的「当前人类前端」（`packages/interaction/user-approval/README.md:12`）。

## 5. 分期计划（B 路线）

1.0.x 维护期间，原生 runtime 仍是默认引擎。DSH 引擎放在开关后面，直到 P2。

| 阶段 | 内容 | 量级 | 退出标准 |
|---|---|---|---|
| **P0 探针** | ①在 Linux 开发机的 WorkerSlot 里，用随包 node 启动原样的 `dsh-base` 加一个最小 bundle，测常驻内存和启动时间（开发机只有 2 核 / 3.3GB，决定一会话一宿主还是共享宿主）。②原样挂上 goal 四件套、`dsh-tool-todo`、`dsh-tool-jobs`，再加一个社区宿主插件，在 P0 从目录里挑一个纯宿主、无 `dsh.client` 的。③最小 bridge：文本、工具行、一张审批卡能来回走通。④**加密机上机**：DSH 宿主经 node.exe 执行 read/write/edit/grep/glob，bash 与 pwsh 分别测，会话写入后回读；ACL 沙箱开和关各测一次；另装官方 DSH Desktop 0.1.7 当对照组。 | 1.5 人周 + 1 次上机 | 读写都是明文；goal 能自动续跑并能完成、阻塞、暂停；审批来回无误；内存在预算内。有任一项不过，回到 §9 重新决策 |
| **P1 双引擎** | bridge 做到和 RuntimeEvent 完全对等，用录制的事件流 `src/shared/__tests__/fixtures/nativeGuiEventStream.json` 做回归门禁（D5 先例）；权限移植（§9-3）；模型目录和凭据接缝；旧会话按需转换，只复制不改原文件，沿用 `.native-v4.jsonl` 的先例（`src/runtime/README.md:79`）；渲染层补上 goal 条、todo 卡、jobs 面板、子代理面板，把 D7 / D8 一并做掉；把防空转和 500 轮上限写成宿主插件 | 6～8 人周 | 开发机点验清单全过；夹具回放和原生引擎等价（有差异要登记） |
| **P2 默认切换** | 默认引擎改为 DSH；CC / Codex 导入改为输出 DSH 格式；处理 pi TUI 的去留；原生 runtime 冻结，建议**保留一个版本**作回退，吸取 D8 立即退役的教训；定下 DSH 升级节奏 | 3～4 人周 + 1 次上机 | 加密机按载体矩阵签收（D11 第 6 条）；旧会话和设置迁移验收 |
| **P3（可选）L2** | 聊天区换成宿主提供的 DSH Web 客户端，放在 WebContentsView 里，只监听回环地址；外壳其余部分保留；插件管理页配合白名单；把我方时间线规范重写成客户端插件，或者接受 DSH 的界面 | 8～12 人周 | 附件全部走路径引用；webview 与 Blob 在加密机上复测 |

## 6. 在飞任务的去留

| 任务 | 建议 | 理由 |
|---|---|---|
| D1 读图 | **保留，控制在 S**。本档原建议新增独立工具 `read_image`，参数照 DSH 的 `{file_path}`（`docs/tool-catalog.md:1012-1031`），不给 `read` 加分支。**编排器注（2026-09-24）**：已按「read 内置图片分支」开工。现场的问题恰恰是模型对 png 调了 `read`，内置分支对 1.0.x 用户更稳；Claude Code 与 pi 的 read 也都能直接读图。切到 DSH 后换成它的工具即可，旧会话里的工具名不影响 | 1.0.x 用户现在就要用；读文件仍走我方 HostIo，加密机上是明文 |
| D3 bash 流式 | **暂停 runtime 侧的实现**。T120 已经做了「已耗时 / 超时上限」显示 | DSH 的做法是 jobs：输出持续留存，界面可以展开查看（`packages/jobs/jobs/README.md`、`client/ui-jobs`）；自研一套切换后就作废 |
| D4 后台 bash | **暂停**，P1 直接用 DSH 的 jobs：`run_in_background`、前台超时自动转后台、`job_output` / `job_list` / `job_kill`（`docs/tool-catalog.md:599-640,2147-2200`） | 语义完整，而且和子代理、终端共用同一套 jobs |
| T125 中止回复用量记 0 | **保留（S）** | 是 1.0.x 的维护修复，和 042 事故有关，与引擎无关。DSH 怎么记中止回复的用量**未核实**，P1 时复查 |
| T138 / T8 goal 模式 | **并入 P0 / P1**，原样使用 DSH 包 | 见 §7；如果 1.0.x 必须先有，按 §9-6 的备选做 |

## 7. goal 模式四方对照

### 7.1 对照表

| 维度 | Claude Code `/goal` | OpenAI Codex `/goal` | DSH goal 四件套 | PI-Desktop Goal 模式 |
|---|---|---|---|---|
| 首发与状态 | 2.1.139 首发（[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) 中 `## 2.1.139` 条目） | 0.128.0 首发，2026-04-30（[release](https://github.com/openai/codex/releases/tag/rust-v0.128.0)）；0.157.0 时 `goals` 功能已是 Stable 且默认开启（[features/src/lib.rs](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/features/src/lib.rs)） | 08-18 基线已有；后续加了 resume 重新启用（#3485）、暂停即停当前回合（#3401）、`/goal` 带附件 | M6 里程碑已交付（`PI-Desktop/docs/project/BOARD.md:79-84,103`） |
| 入口 | `/goal <条件>`，设置后立即开始一轮（[文档](https://code.claude.com/docs/en/goal)） | `/goal <目标>`、`/goal`、`pause`、`resume`、`clear`（[OpenAI 用例页](https://learn.chatgpt.com/use-cases/follow-goals)）；app-server 另有 `ThreadGoalSet/Get/Clear` | `/goal`、`/goal <目标>`、`edit`、`pause`、`resume`、`clear`（`packages/goal/command-goal/README.md`），模型也可以用 `create_goal` 创建 | 在 Composer 里把模式切到 agent / plan / goal（`PI-Desktop/apps/desktop/src/components/Composer.tsx:440`；`packages/shared/src/types.ts:7`） |
| 目标形态 | 自由文本的完成条件，最长 4000 字符 | 目标文本，可附 `token_budget` | 目标文本加轮次上限（默认 256，`packages/goal/goal/README.md:41`） | **目标契约**：结果、可客观核验的验收标准、边界；由模型调用 `SubmitGoal` 写成 `.pi/goal/*.md`（`PI-Desktop/packages/agent-runtime/src/mode-prompts.ts:17-28`） |
| 谁来判定完成 | **另一个模型**：每轮结束后由小快模型（默认 Haiku）读对话，给出「未达成 / 达成 / 不可能」三种判定；它不调用工具（本质是基于提示词的 Stop hook） | **干活的模型自己判定**，但续跑提示词要求逐条做完成审计（[continuation.md](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/ext/goal/templates/goals/continuation.md)），然后调用 `update_goal(status: complete)` | **干活的模型自己判定**；独立评审明确写着以后再做（`packages/goal/goal/README.md:160`；`goal-round-driver/README.md:126`） | 模型自己逐条核验验收标准，最后按条出报告（`PI-Desktop/packages/agent-runtime/src/runtime.ts:5973-5989`） |
| 续跑机制 | 判定未达成就再开一轮；判定理由作为下一轮的指导 | 每轮结束注入 `continuation.md` | 空闲时由 driver 追加一条 `<goal_round>` 用户消息（`packages/goal/goal-round-driver/src/prompt.ts`）；先预留、写入后才计轮，有竞态保护 | **不续跑**：批准后注入一条 `<approved-goal-markdown>` 内部消息，切到 agent 模式跑一次自主运行（`runtime.ts:5936-6012`） |
| 预算与上限 | 没有内置预算；建议在条件里写「或 20 轮后停」；状态栏显示耗时、轮数、token | 可选 token 预算，用尽后状态变成 `budgetLimited`，注入 `budget_limit.md` 让模型收尾 | 只有轮次上限，不计 token、费用、时间（`goal/README.md:159`）；触顶后记为 `blocked`，代码 `round-limit` | 无 |
| 阻塞 | 判定「不可能」时清除 goal | 同一阻塞连续 3 轮才允许报 `blocked`（[spec.rs](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/ext/goal/src/spec.rs)） | 同样是连续 3 轮（可配置），由执行侧强制下限（`tool-goal/README.md:48,117`） | 边界挡住或无法核验时就停，并说明原因 |
| 状态集 | 进行中 / 已达成 / 已清除 | `active` / `paused` / `blocked` / `usageLimited` / `budgetLimited` / `complete`（[ThreadGoalStatus.ts](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalStatus.ts)） | `active` / `paused` / `blocked` / `complete`，外加只在当前进程有效的 armed / disarmed（`docs/subsystems/goal.md`） | 等待批准 / 已批准 / 排队 / 执行中……（`PI-Desktop/packages/i18n/src/locales/en/index.ts:499-520`） |
| 重启与恢复 | resume 时恢复 goal，但轮数、计时、token 重新计 | 按线程持久化（`codex-rs/state/goals_migrations/`） | 以事件溯源方式持久化；**resume 或 fork 之后自动续跑处于关闭状态，要人明确 resume 才恢复**（`goal-round-driver/README.md:55`） | 重启会中断，不重放（BOARD） |
| 错误处理 | 4 类需要人处理的错误会清除 goal；其余错误先自动重试，3 次后暂停；无进展检测会停下但保留 goal | `usageLimited` 状态 | 遇到 max-tokens、写入失败、取消就停；取消后在下一个空闲点暂停；**不自动重试异常**（`goal-round-driver/README.md:53,129`） | 走普通运行的恢复流程 |
| 后台任务 | 有子代理或后台 shell 在跑时推迟判定；30 分钟后开始 check-in，间隔指数退避，空闲时最多 3 次 | 续跑提示词里区分「已验证的等待」和「没有进展」 | 只在整个 agent 空闲时开新一轮；是否把 jobs 计入「空闲」**未核实** | — |
| 权限 | 不改权限模式；要无人值守得配合 auto 模式 | — | 不改权限；创建、编辑、暂停、恢复要求本轮有直接的人类消息，子代理不能改 goal | 批准时选择执行档：Ask（默认）/ Accept edits / Auto（BOARD；i18n `goal.approveAsk` 等） |
| 模型能否自行创建 | 只能由人设置 | 不能：「do not infer goals from ordinary tasks」（spec.rs） | **能**：可从人类请求中推断（`docs/tool-catalog.md` 中 `create_goal`） | 模式由人切换 |
| 界面 | `◎ /goal active` 指示、状态视图、Ctrl+O 看判定理由 | TUI 菜单和状态（`codex-rs/tui/src/chatwidget/goal_*.rs`） | 输入框上方的 goal 条（排在 Todo 之后、队列之前）；`/goal` 运行记录显示为「指令输入」气泡（`client/ui-goal/README.md:28`） | 审批条加工作面板里的契约文档 |

无法证实的说法：
- 第三方文章称 Claude 会「把 goal 拆成子任务」。官方文档只描述了完成条件加评审，所以不采信。
- 关于 Codex 的 `/goal` 需要 ChatGPT 登录还是 API key、是否支持 IDE 扩展，只有第三方说法，互相矛盾；OpenAI 用例页只列了桌面应用和 CLI。

### 7.2 我方现状与建议设计

- **现状**：没有 goal。
  - 模式枚举只有 `plan | agent`（`src/shared/types/runtimePermission.ts:2`）；ARD D14 写的是「goal 本轮不做，但模式做成了枚举」（ARD `:311-312`）。
  - 最接近的能力有：500 轮上限加收尾轮（`agent-loop/index.ts:216`，决策 040）、子代理后台运行、插话（041）、防空转（042）。
- **建议**：P0 / P1 直接原样使用 DSH goal 四件套。这是第一批跑起来的真正生态插件，本身就是 L1 的验收。我方只做下面这些适配，放在 bridge 或渲染层：
  1. `<goal_round>` 消息用内部消息标记，不画成用户气泡，沿用 `src/shared/internalMessage.ts:38` 的机制。
  2. 某一轮等审批时停下，不自动放行；这和 Claude Code 一致，不像 PI-Desktop 那样强制 Auto。
  3. 用户点 Stop 等于暂停 goal，DSH 本身就是这个语义。
  4. 插话走 steer，和 goal 回合并存。
  5. 500 轮上限按「单次发送」计，goal 回合各自单独计数。
  6. goal 条和状态进渲染层，与 D8 的 todo 卡一起做。
- **可以借鉴、DSH 没有的**：
  - Claude Code 的「独立评审模型」和「后台任务 check-in」。DSH 也把独立评审列为以后再做，建议等 DSH 做出来，不自研。
  - PI-Desktop 的「先谈契约再执行」。可以做成 `/goal` 的前置可选步骤：先在 plan 模式下谈出契约，再调用 `create_goal`。

## 8. 能力差距表（我方 runtime 对比 DSH 最新）

标记说明：【D1】【D3】【D4】【D7】【D8】【T7】【T8】是用户待办。「B 下获得方式」指推荐路线下这项能力从哪里来。

| 能力 | DSH 最新 | 我方 | 差距 | 量级（自研时） | B 下获得方式 | 优先级 |
|---|---|---|---|---|---|---|
| agent loop 与停止条件 | `core/agent-loop`（并行工具上限、取消后保留已流出的文本）+ `llm-retry` + `session-checkpoint-policy`（崩溃后可恢复）+ `timeout-policy` | pi-agent-core 循环 + provider 重试 + 500 轮上限 + 插话 + 防空转（`agent-loop/index.ts:216,311`；`delegationLoopGuard.ts:36`） | DSH 有持久检查点；我方有轮次上限和强制防空转 | — | DSH 原样；轮次上限与防空转写成我方插件 | P1 |
| 计划与 todo【D8】 | `tool-todo`（`todo_write`）+ todo 卡；`plan-mode`（`/plan`、`exit_plan_mode`、右栏审阅） | plan 模式只裁剪工具集（ARD D14）；没有 todo 工具，渲染层只残留 `TodoWrite` / `ExitPlanMode` 的标签（`toolCard.ts:1001,1183`） | 缺 todo 和计划审阅 | M | DSH 原样 + 我方渲染层 | P1 |
| goal【T8 / T138】 | 四件套（§7） | 无 | 整块缺失 | M（2～3 人周） | DSH 原样 | P0 |
| 子代理【D7】 | 多种后端（进程内 / ACP / SDK / Codex / CC）；一次性或可续跑；`send_message` / `interrupt_agent` / `list_agents`；子代理浏览器显示用量 | `Task` / `TaskWait` / `TaskList` / `TaskStop` 后台运行，4 个角色（`subagent/index.ts:96-99`）；时间线泳道；没有面板 | 缺面板和可续跑 | M | DSH 原样 + 面板进渲染层 | P1 |
| 后台任务【D4】 | `jobs` + `tool-jobs` + `ui-jobs`；bash `run_in_background`，前台超时转后台 | 无；bash 有超时上限（`tools/index.ts:436-460`） | 缺 | M | DSH 原样 | P1 |
| bash 流式【D3】 | jobs 实时输出，界面可展开 | 无（T120 只显示已耗时和超时上限） | 缺 | M | DSH 原样 + 渲染层 | P1 |
| 读取含图片【D1】 | `read` + `read_image`（自动缩放，要求路由支持图片）+ `compaction-image-offload` | 只读 UTF-8（`tools/index.ts:307-345`） | 缺图片 | S | 先自研（read 内置分支），切换后换成 DSH | 1.0.x |
| 写 / 编辑 | `write` / `edit` + 可选 `fs-observation-policy`（先读后写）+ `str_replace_editor` | `write` / `edit`（`tools/index.ts:351,384`） | 基本对等 | — | DSH 原样 | — |
| 搜索 | `glob` / `grep`，不依赖 rg，结果可溢出到文件 | `glob` / `grep`（`tools/index.ts:529,588`，决策 025） | 对等 | — | DSH 原样 | — |
| 联网【T7】 | `web_fetch` / `web_search`（deepseek / exa / perplexity） | 无 | 缺 | M | DSH 原样；搜索 provider 要看企业网络和合规 | P2 |
| LSP | `tool-lsp` | 无 | 缺 | M | DSH 原样（可选） | P3 |
| 终端工具 | `tool-terminal`（持久 PTY）、`bash-persistent` | 无（只有给用户用的终端） | 缺 | M | DSH 原样（可选） | P3 |
| 上下文压缩 | `compaction-basic`（超限后重试、`/compact`）+ `tool-result-pruner` + `image-offload` | `context/compaction.ts` + `budget.ts` + `/compact` | 缺工具结果裁剪和图片卸载 | S～M | DSH 原样 | P1 |
| 记忆 | 官方没有（社区 memory 类 199 个） | 无 | 双方都没有 | — | 社区插件（L1） | 暂不做 |
| 技能 | 多来源目录、模糊搜索、office 技能 | `SkillsPlugin`（`skills/index.ts:278`）+ 提示词模板 | 基本对等 | — | DSH 原样；技能目录要映射 | P1 |
| MCP | 工具 + 资源（list / read） | 只有工具（`mcp/index.ts:352`） | 缺资源 | S | DSH 原样 | P1 |
| hooks | 兼容 Claude Code 和 Codex 的 hooks | 无 | 缺 | M | DSH 原样 | P2 |
| 插件与扩展 | 插件管理 + 生态（§1） | 无（决策 012 推后） | 整块缺失 | L | 核心收益 | P1～P3 |
| 权限与审批 | 沙箱（Linux bwrap / landlock、Windows ACL）+ 一次性审批 + 预设 + 实验性自动审查 | 四档 + 会话级授权记忆 + bash AST + 拒绝清单（`permissions/index.ts:318`；`grants.ts:48`） | 两种模型冲突（DSH 没有授权记忆） | M（移植） | 我方插件（§9-3） | P1 |
| 会话与分支 | 事件溯源 v4、按序号 fork、回合大纲、会话查询工具、崩溃恢复 | pi 格式 v4 树、导航 / 回退 / fork（`session/store.ts:493,505`）、TUI 互通、旧格式导入 | DSH 没有同文件分支和回退；我方没有会话查询 | M（转换） | DSH 原样 + 我方转换插件 | P1 |
| 定时 | `schedule`（cron / daily / weekly） | 无 | 缺 | — | DSH 原样（可选） | P3 |
| 界面 | goal 条、todo 卡、队列、jobs、子代理浏览器、轨迹页、计划审阅、改动文件卡、文档预览 | 时间线（过程折叠、回合计时、失败卡）、审批停靠卡、分支栏、Git、Monaco、终端 | 各有所长 | — | B 下由渲染层补 goal、todo、jobs、子代理；L2 看 P3 | P1 / P3 |
| 桌面与更新 | Electron 44、强制更新、EV 签名、托盘 | Electron 39、AutoUpdater、随包 node、TSD | 对等；加密机支持是我方独有 | — | 外壳保留 | — |

## 9. 需要用户拍板的点

1. **主线**：是否批准 B（DSH 宿主当 worker 引擎，保留我方外壳和渲染层），先做 P0 探针（1.5 人周 + 1 次加密机上机）？**建议：批准。**
2. **兼容目标和插件来源**：
   - 目标定在 L1 + L3 格式就够，还是必须 L2（能显示社区界面插件，需另加 P3，8～12 人周）？
   - 第三方插件是只允许内部白名单和官方包，还是开放社区安装？ARD §6 的旧口径是「第三方插件市场：内部产品，安全风险不匹配」（`:482`）。

   **建议**：先做 L1 + L3；插件先走白名单，L2 等 P2 之后再议。
3. **权限模型**：保留我方的「逐次审批 + 四档 + 会话授权记忆」（决策 014 / 023 / 026，移植成 DSH 插件），还是改用 DSH 的「沙箱 + 越权审批」？**建议保留我方模型**。原因有二：用户已经适应了这套；DSH 在 Windows 上的 ACL 沙箱对加密机来说是未知数。
4. **进程拓扑**：所有会话共享一个 DSH 宿主（省内存，但失去「一会话一进程」的崩溃隔离，D4），还是一会话一宿主？**建议 P0 实测内存后再定**，默认倾向共享宿主。
5. **pi TUI 互通**：切换后放弃（或者改用社区的 `dsh-tui`），还是继续双写 pi 格式？**建议放弃双写**：pi 格式没有 DSH 的事件语义，双写成本高；内嵌终端以后改为启动 `dsh` 或社区 TUI。
6. **goal 模式的时间点**：等 P1 随 DSH 引擎一起上，还是先在自有 runtime 上按 DSH 同名、同参数、同提示词做一版（M，2～3 人周，切换后作废）？**建议等 P1**；如果 1.0.x 用户急需，再走备选。

## 溯源

- **DSH**：<https://github.com/deepseek-ai/deepseek-harness>，本地 `/tmp/dsh-latest`（HEAD `477b4f42`，基线 `c1eac0ba`）。
  - 关键文件：`docs/subsystems/goal.md`、`packages/goal/*/README.md`、`packages/goal/goal-round-driver/src/prompt.ts`、`packages/goal/tool-goal/src/wrapup.ts`、`docs/tool-catalog.md`、`docs/capability-seams.md`、`docs/session-format-status.md`、`apps/desktop/README.md`、`apps/desktop/src/{main,host-process,node-environment,preload-app}.ts`、`packages/boot/plugin-manager/README.md`、`packages/interaction/user-approval/README.md`、`packages/bundle/base/cordis.patch.yml`、`vendor/README.md`、`CONTRIBUTING.md`、`README.md`。
- **npm**：`https://registry.npmjs.org/@deepseek-ai%2Fdsh`、`…/@deepseek-ai%2Fdsh-goal`、`…/dsh-plugin-catalog`、`…/dsh-better-sidebar/latest`。
- **GitHub API**：`repos/deepseek-ai/deepseek-harness`、`search/repositories?q=topic:dsh-plugin`。
- **Claude Code**：<https://code.claude.com/docs/en/goal>、<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>。
- **Codex**：
  - <https://github.com/openai/codex/releases/tag/rust-v0.128.0>
  - <https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/ext/goal/templates/goals/continuation.md>
  - <https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/ext/goal/templates/goals/budget_limit.md>
  - <https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/ext/goal/src/spec.rs>
  - <https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalStatus.ts>
  - <https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/features/src/lib.rs>
  - <https://learn.chatgpt.com/use-cases/follow-goals>（由 developers.openai.com/codex/use-cases/follow-goals 308 重定向而来）
- **PI-Desktop**：`/home/ai/code/PI-Desktop` @ `ea6b9936`。
- **我方**：`docs/plans/2026-09-08-runtime-evolution-ard.md`（D4 / D5 / D11 / D13 / D14 / §6 / §8）、`docs/plans/2026-09-09-bash-carrier-decision.md`、`docs/plans/2026-08-18-deepseek-harness-study.md`、`docs/plantree/plans/runtime-hardening/decisions/{012,023,026,040,041,042}-*.md`、`docs/plantree/plans/runtime-hardening/roadmap.md`（T125、T138）。
- **状态提醒**：DSH 处于 developer preview，上面的判断随时可能失效。引用前请用本档记录的取证方法重新核对。
