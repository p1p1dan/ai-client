> D47「用户登录管理」规格前调查报告（2026-08-15，四路并行调查员产出，编排者未改写正文）。
> 角色：设计规格的事实底稿；所有 file:line 以调查当日工作树为准。

# 登录 UI 与 IPC 面盘点

## 1. OnboardingView 状态机 + Root/壳层门禁

**状态机**（`src/renderer/components/onboarding/OnboardingView.tsx:25-26`）
```ts
type Step = 'cli-check' | 'cli-install' | 'register-email' | 'register-code' | 'result';
type OnboardingMode = 'standard' | 'register-only' | 'vscode-extension';
```
五步单向流转（无「已登录」「凭据失效」态，只有一次性注册流程）：
- `cli-check`（默认初始步，onboarding.ts:186 `detectCli`，自动前进见 188-194）→ `cli-install`（189-260,一键安装+进度条,`onboarding.installAgents`/`onInstallProgress`）→ `register-email`（551-605,邮箱格式+域名白名单校验 `isValidEmailFormat` 77-81,仅 `@jcdz.cc`/`@wuhanjingce.com`,29 行）→ `register-code`（609-684,6 位数字倒计时重发,`resendCountdown` 178/223-227）→ `result`（686-755,依 mode 展示三种文案：standard/register-only/vscode-extension）。
- 错误态是**内联态**，不是独立 Step：`sendCodeError`（172）、`verifyError`（177）、`installError`（158）分别渲染在对应 Step 内的 destructive 卡片里，机器码→中文映射在 `describeOnboardingError`（39-75），覆盖 13 个 `OnboardingErrorCode`。
- `alreadyRegistered` prop（128-130）让视图跳过注册、只做 CLI 补装（Root 在“已注册但 CLI 缺失”场景传入，见下）。

**Root.tsx 门禁**（`src/renderer/Root.tsx`）
- 总开关：`SKIP_ONBOARDING_GATE`（`src/shared/devFlags.ts:10`，当前硬编码 `true`，注释写明“Dev phase default: TRUE”）。Root.tsx:128-133 命中即直接挂载 `<SkippedOnboardingApp>`（53-60），完全跳过检测/登录/环境改写——**当前主干登录门禁处于旁路状态**，加登录态管理前必须先确认这个 flag 何时收回。
- 未旁路时走 `RootWithOnboardingGate`（135-430），四条并行 react-query：`onboardingState`（138-142,`onboarding.check()`）、`onboardingCliStatus`（146-151,enabled=registered）、`onboardingCredentialsHealth`（160-165,enabled=registered,staleTime 30s）、`claudeRuntimeStatus`（171-176,`claudeRuntime.check(false)`）。四个 query 是**无条件 hook**（不在 if 分支里），意味着即使已挂载 `AppShell`，credentialsHealth 仍在后台持续存活，一旦下次 refetch（窗口聚焦/失效）变差会把整棵树从 AppShell 换回 OnboardingShell（自愈逻辑，见 399-416 注释）。
- 门禁判定顺序（242-429）：loading → `detection-failed`（255-266,`RuntimeDetectionFailedShell`）→ `vscode-extension-only`（279-351,见下）→ `!registered`（353-365,`OnboardingShell` 标准流程）→ cliStatus loading（369-371）→ `!claudeInstalled`（376-389,`alreadyRegistered` 模式重入 CLI 检查）→ credentialsHealth loading（395-397）→ `!claudeEnvOk || !codexAuthOk`（403-416,**自愈**：直接从 `register-email` 步重入,不经过 CLI 检查)→ 全部通过才 `AppShell`（418-429）。
- `ClaudeVsCodeOnlyShell`（`src/renderer/components/onboarding/ClaudeVsCodeOnlyShell.tsx`）是「检测到 VSCode Claude 扩展但本机无 Claude Code CLI」时的**替代主界面**（非登录相关，是运行时能力探测的分支，1-38 行注释说明因为 AiClient 主界面强依赖 CLI 驱动终端）；内部仍可触发注册（`onStartRegister`→`vscodeRegisterFlow`，Root.tsx:279-295）或安装（`onStartInstall`→`vscodeInstallFlow`，296-311），复用同一个 `OnboardingShell`/`OnboardingView`，只是 `initialMode='vscode-extension'` 换文案。
- 与 Root 平行的第二套门禁镜像：`src/main/windows/MainWindow.ts:28-35` `isAppMountedFor()`，用于关闭确认弹窗是否需要走 30s 会话确认；同样先判 `SKIP_ONBOARDING_GATE`（30），再判 `onboardingService.checkRegistration().registered`（31，**只查注册标志，不查 credentialsHealth**）+ runtime cache kind（32-34）。**这是一个已知的门禁复制点，加第三态时两处都要同步改，否则「已登出但主进程仍认为 App 已挂载」会导致关闭确认逻辑失真。**

## 2. UserProfileCard.tsx

`src/renderer/components/user/UserProfileCard.tsx`
- 展示：邮箱首字母头像（76-79）、今日/本月调用次数与费用四格（39-58,81-119,`UsageMetric`）、Logout 按钮（196-204,disabled when `!email`）。
- 挂载点：`WindowTitleBar.tsx:143`（`<UserProfileCard email={email} .../>`），`email` 来自 `WindowTitleBar.tsx:45-53` 自己的 `onboarding.check()` query（与 Root 共享同一 `queryKey:['onboardingState']` 缓存）。WindowTitleBar 在所有壳层（LoadingShell/OnboardingShell/AppShell/…）里都挂载，因此登录前 UserProfileCard 也存在，只是 `email=null` 显示「未登录」且 Logout 禁用。
- 用量数据链：`useUsageStats`（`src/renderer/hooks/useUsageStats.ts:1-19`，react-query，5 分钟轮询，`refetchOnWindowFocus:false`）→ `window.electronAPI.usage.getStats()`（preload:764）→ `IPC_CHANNELS.USAGE_GET_STATS`（`src/main/ipc/usage.ts:6-8`）→ `usageService.getStats()`（`src/main/services/usage/UsageService.ts:142-256`）。
  - **不是** onboard 服务（onboarding-jyw），而是 `onboarding.serverUrl`——即 verifyAndRegister 时 `deriveCchBaseUrl` 算出的 **cch/业务服务器**源（`OnboardingService.ts:557-563`，剥掉 `/v1` 后缀）。
  - 鉴权用的是 **Codex 的 OPENAI_API_KEY**（`UsageService.ts:63-79 readCodexApiKey()` 读 `~/.codex/auth.json`），不是 Claude token——用量卡片隐性依赖 Codex 凭据是否写盘成功。
  - 端点：`POST {serverUrl}/api/actions/my-usage/getMyTodayStats`、`getMyStatsSummary`（161-162），先直连 apiKey 当 bearer（206），401/403 则用 `POST {serverUrl}/api/auth/login`（85-108）换 `auth-token` cookie 重试（218-249）——**说明 cch 侧已有 cookie session 基础设施**，是三态管理里「凭据失效」判定可复用的现成信号源（可从 `getStats()` 的 401/403/login 失败反推 session 失效，而不必只靠本地文件健康检查）。
  - `pendingCredentials`/`metricsLoading`（72-74）：仅在 `usage.data.error === 'Credentials not available'`（对应 `UsageService.ts:151`，即 codex auth.json 缺失/空）时特殊处理为 loading，**没有单独的“凭据失效”UI态**，其余错误（网络/401/服务端错误）一律落到 `'暂不可用'` 文案（85-119），对用户无区分度。
- Logout 链路：`handleLogout`（121-147）→ `window.electronAPI.onboarding.logout()`（124）→ IPC `ONBOARDING_LOGOUT`（`src/main/ipc/onboarding.ts:115-135`：`terminateAllSessions()` 先杀掉所有远程 session 并等待本地 PTY 销毁完（14-36）→ `onboardingService.logout()`（125，见下）→ 若之前已注册则 `clearServerAuthCookie(serverUrl)` 清 cch origin 的 `auth-token` cookie（38-45,130-132））→ renderer 端成功后 `invalidateQueries(['usageStats'])`/`(['onboardingState'])`（134-135）→ `onRequestClose?.()`（136）→ `window.dispatchEvent(new CustomEvent('aiclient:onboarding:open'))`（137，事件名硬编码于两处：UserProfileCard.tsx:21 与 Root.tsx:18，**没有共享常量**）。Root.tsx 监听该事件（231-240）批量失效四个 query，从而把当前壳层从 `AppShell` 打回 `OnboardingShell`——**这是现成的“登出→回到登录界面”触发机制**，可直接复用为三态切换的信号通道，只需把硬编码事件名提到 shared 常量。

## 3. IPC 面清单

`IPC_CHANNELS`（`src/shared/types/ipc.ts:338-348`，共 10 个 onboarding 通道）：
```
ONBOARDING_CHECK / SEND_CODE / VERIFY_AND_REGISTER / DETECT_CLI /
ONBOARDING_CHECK_PREREQUISITES / INSTALL_AGENTS / INSTALL_PROGRESS(push) /
CANCEL_INSTALL / LOGOUT / LIVE_CREDENTIALS_STATUS(push) / CHECK_CREDENTIALS_HEALTH
```

**主进程 handler**（`src/main/ipc/onboarding.ts:47-136`，`registerOnboardingHandlers`）：9 个 `ipcMain.handle`——CHECK(48-50)、SEND_CODE(52-57)、VERIFY_AND_REGISTER(59-64)、DETECT_CLI(66-68)、CHECK_CREDENTIALS_HEALTH(70-72)、CHECK_PREREQUISITES(74-77，**渲染进程无调用点，preload 有绑定但死代码**）、INSTALL_AGENTS(79-104，`activeInstaller` 单例防并发,82-87)、CANCEL_INSTALL(106-113)、LOGOUT(115-135)。`INSTALL_PROGRESS`（95）与 `LIVE_CREDENTIALS_STATUS`（`src/main/index.ts:436`）是主进程主动 `send` 的推送通道，不在这个文件里注册 handle。

**preload 绑定**（`src/preload/index.ts:768-804`，`window.electronAPI.onboarding.*`）：`check/sendCode/verifyAndRegister/detectCli/checkCredentialsHealth/checkPrerequisites/installAgents/cancelInstall/onInstallProgress(event)/logout/onLiveCredentialsStatus(event)`——11 个绑定对齐 9 invoke + 2 push。

**renderer 调用点**：
- `Root.tsx:140,148,162`：check / detectCli / checkCredentialsHealth（门禁三 query）
- `OnboardingView.tsx:186,208,236,270,282,314`：detectCli / onInstallProgress / installAgents / cancelInstall / sendCode / verifyAndRegister
- `WindowTitleBar.tsx:48`：check（独立 query，用于头像/email 展示，与 Root 共享缓存 key）
- `UserProfileCard.tsx:124`：logout
- `App.tsx:163`：onLiveCredentialsStatus（**唯一一处消费一次性推送**，见 §4）

**onboarding 状态持久化链**（`~/.aiclient/settings.json` 的 `onboarding` 字段）：
- 写：`OnboardingService.saveOnboardingState`（`src/main/services/onboarding/OnboardingService.ts:529-536`）→ `mergeSettingsPatch({onboarding: state})`（`src/main/ipc/settings.ts:69-75`：`baseSettings ?? readSharedSettings()` 与 `patch` **浅合并**，因此 `patch.onboarding` 会整体替换旧 `onboarding` 对象，不是深合并）→ `writeSettingsNow`（62-67）→ `atomicWriteSettings`（41-49）→ `writeSharedSettings`（`src/main/services/SharedSessionState.ts:99-102`）→ `atomicWriteJson`（48-53，tmp 文件 + rename 原子写）→ 落盘路径 `getSharedRoot()+'settings.json'`（33-41，`HOME/.aiclient/settings.json`）。同时 `atomicWriteSettings` 还并行调用 `writeSharedSettingsToSession`（settings.ts:44，写入 session-state 缓存，非本任务重点）。
- 读：`OnboardingService.checkRegistration`（29-45）直接绕过 settings.ts 缓存，自己 `fs.readFileSync` + `JSON.parse` 同一路径（拼接逻辑独立重复一份，31 行），只有 `registered && email` 均真才算已注册。
- Logout 写：`OnboardingService.logout()`（179-188）→ `mergeSettingsPatch({onboarding:{registered:false}})`（183）——因浅合并特性，`email`/`serverUrl`/`registeredAt` 会随 `onboarding` 对象整体被替换清空（并非显式保留旧字段后只翻 `registered`），**这点在加“已登出但记住上次邮箱”之类需求时要注意，现状是登出即抹除邮箱记忆**。

## 4. checkCredentialsHealth 消费方

`OnboardingService.checkCredentialsHealth()`（`OnboardingService.ts:578-628`）读 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`（584-601）与 `~/.codex/auth.json` 的 `OPENAI_API_KEY`（606-621），返回 `{claudeEnvOk, codexAuthOk, reason?}`。

消费方三处：
1. **`Root.tsx:160-165`**（react-query，`enabled: registered`，`staleTime:30s`，无 `refetchInterval`，靠默认 `refetchOnWindowFocus` 隐性轮询）→ 失败时 `Root.tsx:403-416` 把渲染切回 `OnboardingShell(initialStep='register-email')`，**静默重入邮箱验证码流程**（跳过 CLI 检查），文案里没有告诉用户“为什么又要重新登录”——用户视角就是弹出邮箱输入框。这是当前**唯一**的“凭据失效→UI 引导”路径，且只在门禁重新求值（应用启动/窗口重新聚焦触发 refetch）时才生效，AppShell 挂载期间不会主动轮询。
2. **`src/main/index.ts:411-446`**：应用启动一次性调用（`detectCredentialFilesAvailable`，417-426），结果通过 `ONBOARDING_LIVE_CREDENTIALS_STATUS` 推给 renderer（428-439，`credentialStatusSent` 保证只发一次）。
3. **`App.tsx:162-176`** 消费该推送：`available:true` 时立即失效 `usageStats` query（166-167）；`available:false` 时**只弹一个 warning toast**（“AI tools temporarily unavailable / Claude/Codex credentials were not loaded”，170-174），**不触发任何回登录界面的动作**——App 已经挂载了，用户会停留在主界面里对着一个失效的终端会话，直到下次 Root 级 query 重新求值才会被踢回 OnboardingShell。

`MainWindow.ts:isAppMountedFor()`（28-35）**不调用** checkCredentialsHealth，只查 `checkRegistration()`，是另一处需要同步的门禁分身（见 §1 末尾）。

---

## 若加入「已登录 / 凭据失效 / 已登出」三态 + 重新登录

**现成可复用**
- 门禁骨架已支持“App 挂载中途被踢回登录界面”：Root 的四个 query 是无条件 hook，credentialsHealth 变差会自动把 AppShell 换回 OnboardingShell（Root.tsx:138-176,403-416）——三态里“凭据失效”态基本已经是现成行为，缺的只是**可感知的过渡 UI**（当前是无提示地整屏替换）。
- 登出→回登录的事件总线已存在：`aiclient:onboarding:open` 自定义事件（UserProfileCard.tsx:137 → Root.tsx:231-240），只需把它的失效范围复用到「凭据失效」「主动重新登录」两个新触发点。
- cch 侧已有真实 session/cookie 基础设施（`UsageService.ts:81-108` login-for-actions-session,`onboarding.ts:38-45` clearServerAuthCookie），可作为「凭据失效」的更可靠信号源（401/403），比目前只靠本地文件内容判断更贴近服务端真相。
- `OnboardingCredentialsHealth`/`OnboardingState` 类型（`src/shared/types/onboarding.ts:1-6,100-105`）结构已足够承载「registered/email/serverUrl」+「claudeEnvOk/codexAuthOk」，三态可以在此基础上派生一个联合类型，不必推翻。
- `alreadyRegistered`/`initialStep`/`initialMode` 三个 prop（OnboardingView.tsx:123-143）已经支持“重入某一步”，「重新登录」可以复用 `initialStep='register-email'` 而非新开一个视图。

**必须动的点**
- **凭据落盘目标整体替换**：`OnboardingService.writeClaudeConfig`（242-333）写 `~/.claude/settings.json`、`writeCodexConfig`（335-367）写 `~/.codex/config.toml`+`auth.json`，`checkCredentialsHealth`（578-628）也读这两处——D47 要求凭据权威收敛到 app 私有托管+进程注入，这一整条链路（含 `.bak` 备份/重试写逻辑）要重做，`checkCredentialsHealth` 的健康判定源也要跟着换。
- **`SKIP_ONBOARDING_GATE` 硬编码 true**（devFlags.ts:10）：加新登录态前必须先确认何时收回/是否需要给三态功能单独一条门禁验证路径（该 flag 目前让 Root.tsx:129 整个门禁失效，包括未来的三态判断）。
- **App.tsx 的一次性推送→只弹 toast，不路由**（163-176）：凭据失效态需要 App 内也能主动感知（而不是等 Root 级 query 下次刷新），要么让这里也 dispatch `aiclient:onboarding:open`，要么把 credentialsHealth 改成真轮询并统一由 Root 处理。
- **MainWindow.ts:isAppMountedFor()**（28-35）只查 registered 不查 health，是与 Root 门禁逻辑分叉的第二处判定，加状态后两处要同步或收敛成单一真源（比如都读同一个 IPC）。
- **mergeSettingsPatch 浅合并**（settings.ts:69-75）导致 logout 清空整个 `onboarding` 对象（OnboardingService.ts:183）——如果三态要求“已登出但保留上次邮箱做快速重登”，这里要么改深合并，要么 logout 时显式拼回 `email`。
- **UserProfileCard 无凭据失效专属态**（72-119）：目前 usage 报错统一落到「暂不可用」文案，三态 UI 至少要在 UserProfileCard/WindowTitleBar 层面加一个“凭据失效，点击重新登录”的可点击态，而不是纯文本。
- **事件名/查询 key 硬编码重复两处**（`ONBOARDING_OPEN_EVENT` 分别定义于 UserProfileCard.tsx:21 与 Root.tsx:18；`queryKey:['onboardingState']` 在 Root.tsx:139 与 WindowTitleBar.tsx:46 各写一遍）：建三态前建议先提到 shared 常量，避免三态逻辑散布导致遗漏同步点。
- **`OnboardingErrorCode`（onboarding.ts shared type:9-22）没有“会话过期/需要重新登录”这个语义码**，「已登出」如果需要区分“用户主动登出”vs“服务端判定过期”，需要新增错误码或状态字段。