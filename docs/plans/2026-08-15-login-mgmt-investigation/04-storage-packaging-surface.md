> D47「用户登录管理」规格前调查报告（2026-08-15，四路并行调查员产出，编排者未改写正文）。
> 角色：设计规格的事实底稿；所有 file:line 以调查当日工作树为准。

# 存储与打包面盘点（D47 规格前调查）

## 1. app 现有本地存储机制盘点

### 1.1 SharedSessionState.ts 全貌
`src/main/services/SharedSessionState.ts`

- 落址：`getSharedRoot()` = `$HOME/.aiclient`（`src/main/services/SharedSessionState.ts:33-35`），**不是** electron `userData`，是固定 OS 家目录路径（`process.env.HOME || process.env.USERPROFILE || app.getPath('home')`）。
- 两个文件：`settings.json`（`:37-39`）、`session-state.json`（`:41-43`），外加三个迁移 marker 文件（`.local-settings-migrated` 等，`:10-12`）。
- 写入：`atomicWriteJson`（`:49-54`）——`writeFileSync` 到 `${target}.tmp` 再 `renameSync`，**无 `mode` 参数**（`writeFileSync(tempPath, ..., 'utf-8')`），落盘权限吃系统默认 umask（Linux 常见 `0o644`），`ensureDir`/`mkdirSync`（`:17-19`）同样**不传 `mode`**（默认约 `0o755`）。这与下文 OnboardingService 显式 `0o700`/`0o600` 形成对照。
- 并发：模块级内存缓存 `cachedSettings`/`cachedSessionState`（`:14-15`），一次读入后常驻，**只在本进程生命周期内有效、无跨进程失效机制**——`clearSharedStateCache()`（`:222-225`）在全仓搜索**零调用点**（仅测试可能用到），生产路径上外部改了这两个文件，本进程缓存不会感知。写路径无文件锁/无 `flock`，多写手场景下靠"先写 tmp 再 rename"保证不出现半写文件，但**后写者覆盖先写者**（last-writer-wins），无合并/冲突检测。
- `src/main/ipc/settings.ts:10-17` 在 IPC 层又叠了一层内存缓存 + 500ms 防抖（`DEBOUNCE_MS`）+ 5000ms 强制 flush（`MAX_WAIT_MS`），`mergeSettingsPatch`（`:69-75`）读写走的正是 `SharedSessionState` 的这两个函数。`OnboardingService.logout()`（`onboarding/OnboardingService.ts:183`）调用的就是这条链路（`mergeSettingsPatch({ onboarding: { registered: false } })`）。

### 1.2 safeStorage
全仓 `grep -rn "safeStorage"`（`--include=*.ts/*.tsx/*.js/*.md`，排除 node_modules/dist/out）**零命中**。electron 版本 `^39.2.7`（`package.json:101`），API 本身可用（`encryptString`/`decryptString`/`isEncryptionAvailable`），但代码里从未被引用，文档里也从未被提及——**[未使用，需从零接入]**。

### 1.3 其它秘密存储先例
真正的"凭据落盘"先例不在 `SharedSessionState`，而在 `OnboardingService`（这正是 D47 要改造的对象）：

- `writeClaudeConfig`（`onboarding/OnboardingService.ts:242-333`）：`claudeDir = ~/.claude`，`mkdirSync(claudeDir, { recursive: true, mode: 0o700 })`（`:261`）；写 `settings.json` 前先 `copyFileSync` 出 `.bak`（`:265`）；`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 写入 `env` 块，`writeFileSync(settingsPath, ..., { mode: 0o600 })`（`:305-308`）；写后**读回校验**（`:311-320`），失败重试一次。
- `writeCodexConfig`（`:335-367`）：`codexDir = ~/.codex`，同样 `mode: 0o700`；`config.toml`/`auth.json` 都 `mode: 0o600`（`:353`, `:357-360`），`OPENAI_API_KEY` 明文写入 `auth.json`。
- `ensureClaudeOnboardingComplete`（`:451-470`）额外写 `~/.claude.json`（`hasCompletedOnboarding: true`），`mode: 0o600`（`:461-464`）。
- `logout()`/`removeClaudeCredentials()`/`removeCodexConfig()`（`:179-188`, `:472-499`）负责清理，`~/.codex` 用 `fs.rmSync(configPath/authPath, { force: true })`（`:496`, `:499`）。
- 结论：**目前唯一的"加密/严格权限"先例就是这套 0o700/0o600 + 明文 JSON**，没有任何 OS keychain/DPAPI 接入；这套逻辑正是 D47 要求"不再写"的目标。

## 2. dev.env 隔离机制 与 D42、打包差异

### 2.1 `scripts/dev.js` 细节
- 剥离：`STRIPPED_PREFIX='ANTHROPIC_'` + `STRIPPED_KEYS`（`CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`/`AWS_BEARER_TOKEN_BEDROCK`/`GOOGLE_APPLICATION_CREDENTIALS`/`CLOUD_ML_REGION`，`scripts/dev.js:91-100`），`buildChildEnv`（`:173-224`）遍历 `process.env` 逐一 `delete`（`:176-182`）。
- 注入：从 `dev.env`（可被 `AICLIENT_DEV_ENV_FILE` 覆盖，`:90`）用极简 dotenv 解析（`:103-124`），`ANTHROPIC_AUTH_TOKEN` 优先于 `ANTHROPIC_API_KEY`（`:205`）。
- `CLAUDE_CONFIG_DIR` 用法（`seedIsolatedConfigDir`，`:135-171`）：目录固定在 `node_modules/.cache/aiclient-dev-credentials`（**不在 `~/.aiclient`，也不在 `userData`，是仓库内 build cache 路径**）；里面手写 `settings.json`（只塞 `ANTHROPIC_AUTH_TOKEN/API_KEY/BASE_URL/MODEL`，`:141-145`）和 `.claude.json`（预置 `hasCompletedOnboarding:true` + `projects[workspace].hasTrustDialogAccepted:true`，`:148-169`，**跳过首启信任弹窗**）。只有当 `dev.env` 没显式给 `CLAUDE_CONFIG_DIR` 时才会走这条隔离路径（`:208-210`）。
- 不给 `dev.env` 时默认**拒绝启动**（防止误用开发者本机 `~/.claude` 登录并算到私人账号，`:184-197`），要显式传 `--allow-local-credentials` 才放行落到 `process.env`（即真实 `~/.claude`）。
- 与 **D42**（`docs/plans/openchamber-chat-refactor-ledger.md:86`）现状对应：D42 拍板"维持主路径+约定，不下沉 Host"——即上述剥离/隔离逻辑**只存在于 `scripts/dev.js`（开发脚本层），从未进入 `src/agent-host` 或 `src/main` 生产代码**。这意味着：packaged 版本完全没有这套"剥离+隔离"逻辑，Claude 侧生产链路直接吃真实 `~/.claude`（见 2.3）。

### 2.2 Codex 侧例外：CODEX_HOME 已有生产级隔离
与 Claude 不同，**Codex 侧生产代码里已经有一套结构接近 D47 想要的东西**：
- `src/agent-host/codexHome.ts:1-104`（模块头注释）：app 私有 `CODEX_HOME` = `<userData>/codex-home`，由 Main 注入（`AICLIENT_CODEX_HOME`），Host 侧**无 fallback**（`:605-608`，"missing path is an explicit error, not a guess"）。
- `ensureCodexHome()`（`:589-632`）：`auth.json` 用 `copyFileSync`（不经进程内存，`:97-98`, `:630-632`）从真实 `sourceHomeDir`（默认 `~/.codex`）拷到隔离目录；`config.toml` 走 allowlist 投影（只保留 `model`/`model_provider`/`model_providers.*`，`:107-119`），写盘 `mode: CREDENTIAL_MODE = 0o600`（`:210`, `:618`）。
- 模块头明确写了取舍（`:84-91`, `:585-587`）：**这是用户凭据的"第二份磁盘拷贝"**，会随 `~/.codex/auth.json` 轮换而过期（靠 mtime 比对在下次会话启动时刷新），**没有清理器**（"who cleans this up: NOBODY"）。
- 注入点：`src/main/services/agent-host/hostEnv.ts:29-45`（`buildAgentHostEnv`）只把 `AICLIENT_CODEX_HOME` 塞进 Host 进程 env（`:43`），源头在 `src/main/services/agent-host/AgentHostManager.ts:429`：`codexHomeDir: path.join(app.getPath('userData'), 'codex-home')`——**`userData` 已经被用作"app 私有托管目录"的先例，且是生产代码，不是 dev 专用**。

### 2.3 Claude 侧无对应机制（关键缺口）
`src/agent-host/claudeRuntime.ts:556-559`：`mergedEnv = { ...this.opts.env, CLAUDE_AGENT_SDK_CLIENT_APP: ... }`，`this.opts.env` 只是 Host 进程被 spawn 时继承的 env（含 `process.env` 全量透传），**没有 `CLAUDE_CONFIG_DIR` 覆盖，没有隔离目录**。即：packaged 版本里 Claude Agent SDK 实际读的凭据来源就是 `OnboardingService.writeClaudeConfig` 落到的真实 `~/.claude/settings.json`（1.3 节）。**这正是 D47 第⑤点要拔掉的路径**，且目前**没有 Codex 那样的"CLAUDE_HOME 隔离 + env 注入"基建可直接复用，需要新建**（可参考 `codexHome.ts` 的投影/拷贝模式，以及 `scripts/dev.js:seedIsolatedConfigDir` 的 `settings.json`+`.claude.json` 双文件写法）。

### 2.4 打包版运行时路径 vs dev
- `src/main/index.ts:130-135`：只有 `isDev`（`!app.isPackaged`，`:77`）时才会 `app.setPath('userData', <appData>/${app.getName()}-${profile})`（`profile` 默认 `'dev'`，可用 `AICLIENT_PROFILE` 区分多开）。**packaged 版本走 Electron 默认 `userData`**（productName = `AiClient`，来自 `electron-builder.yml:3`；Linux 约 `~/.config/AiClient`，macOS `~/Library/Application Support/AiClient`，Windows `%APPDATA%\AiClient`，**[未证实的具体路径以实测为准，但是 Electron 标准行为]**）。
- `userData` 已在生产代码里被广泛使用：`AgentHostManager.ts:429`（codex-home）、`TodoService.ts:20`（`todo.db`）、`SessionIndexService.ts:31`、`ClaudeHookManager.ts:525/656`、`RemoteConnectionManager.ts:416`（`REMOTE_SETTINGS_PATH`）、`MainWindow.ts:65`（窗口状态）——**不是"没用过"，而是"当前没被用来存凭据"**。
- 反向证据（重要）：`src/main/index.ts:300-327`（`migrateLegacySettingsIfNeeded`）+ `:334-349`（todo 迁移）显示 `settings.json`/`todo.db` **历史上就放在 `userData`**，后来被**主动迁移出到 `~/.aiclient`**（commit `de57ef0` 提交信息「统一本机与远程共享状态存储」）。原因见 2.5：`~/.aiclient` 是一个跨"本机 Electron 主进程"与"远程 SSH 助手（纯 Node 脚本）"共用的路径约定，`userData` 做不到这点（远程助手没有 Electron `app` 对象）。

### 2.5 `~/.aiclient/` 是双重身份目录，需在选址前排除干扰
`src/main/services/remote/RemoteHelperSource.ts:35-36`：远程 SSH 主机上跑的**纯 Node 守护进程脚本**（`getRemoteServerSource()` 生成的字符串，整段被推到远端执行）里硬编码了 `REMOTE_SETTINGS_PATH='.aiclient/settings.json'`、`REMOTE_SESSION_STATE_PATH='.aiclient/session-state.json'`——这是**远程主机自己 `$HOME` 下的独立文件**，与本机 `~/.aiclient/settings.json` 物理隔离，目前**没有互相同步凭据的迹象**（脚本模板里没有把凭据插进去）。但这意味着 `~/.aiclient/` 这个目录名**已经是被"本机 Electron + 远程纯 Node helper"两套运行时共用的命名约定**，如果凭据落址选在这里，需要在规格里显式声明"不会被序列化进 `getRemoteServerSource()` 的字符串模板/不会被推送到远程机器"，避免后续有人为了'远程也要看到登录态'而顺手把凭据塞进通用 `settingsData`。

## 3. AgentInstaller / CliDetector：CLI 是装在用户机器上，不随包捆绑

- `electron-builder.yml` 明确排除：`!node_modules/@openai/codex/vendor/**`（"~326MB of pre-built binaries"）、`!node_modules/@anthropic-ai/claude-agent-sdk/vendor/**`、`.../cli.js`、`.../*.wasm`，注释写明「we use system-installed CLIs via custom spawn」（`electron-builder.yml` files 段，见上文引用）。**app 包里不带 `claude`/`codex` 可执行文件**。
- `src/main/services/cli/CliDetector.ts`：`BUILTIN_AGENT_CONFIGS`（`:27-77`）里 `command: 'claude'`/`command: 'codex'` 是**裸命令名**，靠 `execInPty`（`src/main/utils/shell.ts`，PTY 里跑用户默认 shell 解析 PATH）或 Windows 下 `cmd.exe` 直接 spawn（`runDirectWindowsDetection`，`:84-142`）解析——即**完全依赖用户机器 PATH/shell rc 文件**，不是任何 app 内置路径。
- `src/main/services/cli/AgentInstaller.ts:340-385`（`installAgent`）：真正"安装"动作是 `npm install -g @anthropic-ai/claude-code@<pinned>` 或 `npm install -g @openai/codex`（`:347-365`），装到**用户机器的全局 npm 前缀**，装完 `refreshPath()`（`:367`，Windows 上重读注册表 `Path`）+ 再跑一次 `cliDetector.detectOne` 校验。
- **影响 D47 落地位置**：既然 CLI 是用户机器上独立进程（`claude`/`codex` 二进制），"注入 env 启动 CLI"这件事**只能在 spawn 该子进程的那一层做**——即 `src/agent-host/claudeRuntime.ts:556`（`mergedEnv`）、`src/agent-host/codexRuntime.ts:1383-1389`（Codex 已经这么做了，`env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: homeDir }`）——**不可能通过替换 app 内置二进制实现**，必须走"进程环境变量注入"这一条路径，这也印证了 D47 第⑤点措辞"进程注入"是唯一可行方案，而非规格阶段可选项。

## 4. 候选选址对比表

| 候选 | 事实约束（本仓证据） | 多写手 | 备份 | Windows 行为 |
|---|---|---|---|---|
| **`~/.aiclient/` 明文 JSON**（复用 SharedSessionState 模式） | 无 `mode` 参数落盘（`SharedSessionState.ts:52`），默认 umask 权限（Linux 常见 `0o644`，**同目录内其它同类型用户可读**，弱于 OnboardingService 现有 0o600 先例）；模块级内存缓存无跨进程失效（`clearSharedStateCache` 零调用点）；`atomicWriteJson` 只保证不半写，不保证不被后写覆盖 | 目录名与**远程 SSH helper 脚本**共用约定（`RemoteHelperSource.ts:35-36`，见 2.5），需显式排除同步风险；同一 `$HOME` 下多个 profile/多份安装（portable + 安装版）会共享同一份文件——`userData` 有 profile 隔离而 `~/.aiclient` 没有 | 现状迁移历史显示 `.tmp` 文件可能因崩溃残留（`atomicWriteJson` 无清理失败 tmp 的逻辑） | POSIX `mode` 在 NTFS 上基本是 no-op（不提供有效访问控制），**[未证实的具体行为，但为 Windows/Node fs 常识]**——无论写不写 `mode: 0o600` 在 Windows 上实际保护力都弱 |
| **electron `userData`**（复用 `codexHomeDir` 模式） | 已有生产先例：`AgentHostManager.ts:429` 把 `codexHomeDir` 钉死在 `userData`；dev 模式下按 `AICLIENT_PROFILE` 隔离（`index.ts:130-135`），packaged 版本走 Electron 默认路径，**每次 electron-builder 打包/改 `productName` 都可能影响解析**（未观察到本仓改过 `productName`，风险低但非零） | 单实例锁（`index.ts:223`，`requestSingleInstanceLock`）保证同一 `userData` 目录同时只有一个 app 进程持有；但 dev/prod 走不同 `userData`（前者 `AiClient-dev`，后者 `AiClient`），**两边凭据不共享**（对"内部员工工具、零感知登录"这个目标来说，dev 环境需要单独走 `--allow-local-credentials` 或另建 dev.env 等价物，不会因为改了存址就自动解决） | 卸载行为受 electron-builder NSIS 配置影响：`electron-builder.yml` `nsis.deleteAppDataOnUninstall: false`（**卸载不删 userData**，即凭据在卸载后仍留存，需在规格里决定是否可接受） | 标准 Electron `app.getPath('userData')` 在 Windows 上落在 `%APPDATA%\AiClient`，**行为是 Electron 官方保证的跨平台一致行为**，比手写 `~/.aiclient` 更贴合"app 私有"语义 |
| **safeStorage 加密**（`encryptString`/`decryptString`，落盘位置仍需选上面二者之一作为容器） | **全仓零使用先例**（1.2 节），需要从零验证 `isEncryptionAvailable()` 分支与失败兜底；Electron 39 API 齐全 | 加密/解密本身是同步 API，不解决"文件被两个进程同时改"的问题——多写手约束仍由容器目录（`userData` 或 `~/.aiclient`）决定，safeStorage 只加了一层"读到明文前先解密" | 与容器目录的备份行为一致（safeStorage 只影响文件内容是否可读，不影响文件是否被用户手动备份/同步工具复制） | **[未证实，非本仓证据，行业常识补充]**：Windows 走 DPAPI（跟登录用户账户绑定，换机器/换系统账户后旧密文不可解）；macOS 走 Keychain；**Linux 依赖桌面环境的 libsecret/kwallet 后端**，无该后端时 Electron 可能退化为弱混淆而非真加密（`isEncryptionAvailable()` 会返回 false，需要代码显式处理该分支，否则等同明文） |

## 5. 与 dev.env / 打包链的相互作用要点

1. **D42 已经把开发态隔离限定在 `scripts/dev.js`**（`docs/plans/openchamber-chat-refactor-ledger.md:86`）；D47 若要在生产代码里加"app 私有托管 + 进程注入"，**不会与 D42 冲突**，但两者的隔离目录选择应该保持一致心智：dev.js 现在用 `node_modules/.cache/aiclient-dev-credentials`（仓库内、非 `userData`/`~/.aiclient`），如果生产侧选 `userData`，dev 与 prod 的凭据存储位置将是三套不同路径（dev cache 目录 / packaged userData / 如果误选还会有 `~/.aiclient`），规格里需要明确 dev 态是否要切到与生产一致的机制，还是维持现状分裂。
2. **Codex 已有的 `codexHome.ts` + `hostEnv.ts` 模式是最贴近 D47 目标的现成参照**：app 私有目录（`userData/codex-home`）+ Main 通过环境变量把路径显式注入 Host（`AICLIENT_CODEX_HOME`）+ Host 侧无 fallback、缺失即报错，这个"谁拥有路径谁传、拿路径的一方不猜"的架构原则可以直接套用在新的凭据存储上。
3. **Claude 侧目前无对应隔离**，`claudeRuntime.ts:556` 直接透传 `this.opts.env`，若 D47 落地"不再写 `~/.claude/settings.json`"，必须新增一条从 Main（拥有 `userData`/凭据源）到 `claudeRuntime.ts`（起 Claude Agent SDK 子进程/调用）的显式 env 注入链路（`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 等），当前代码里**没有这条链路的骨架**，需要新建，工作量上比 Codex 侧（只需替换凭据来源，骨架已在）更大。
4. `OnboardingService.ensureClaudeOnboardingComplete()`（`OnboardingService.ts:451-470`）写 `~/.claude.json` 的 `hasCompletedOnboarding` 标志**不是凭据但是 CLI 正常工作的前置条件**（跳过首启向导）；`scripts/dev.js:148-169` 已经证明这个标志可以在隔离目录里伪造（配合 `CLAUDE_CONFIG_DIR`）。D47 规格阶段需要决定：改用 `CLAUDE_CONFIG_DIR` 方案（连带把 `.claude.json` 一起隔离，复用 dev.js 现成写法）还是只改凭据文件、`.claude.json` 仍写真实 `~/.claude.json`（后者仍会在用户主目录留痕，与"不再写 `~/.claude/`"的表述有冲突，需要用户在规格阶段明确边界是否包含 `~/.claude.json`）。