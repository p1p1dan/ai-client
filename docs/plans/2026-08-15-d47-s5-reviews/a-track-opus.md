> D47 S5 规格 rev.1 双盲对抗评审 · A 轨（deep-reasoner/Opus，状态机与 UI 行为镜头，2026-08-15）。原文归档。

仓内逐点核对完毕（Root/devFlags/静态测试/MainWindow/UsageService/onboarding IPC/AuthStateService/CredentialVault/UserProfileCard/WindowTitleBar/OnboardingView/useManagedMode/SessionManager/dev.js/vite config 全部读了源码，不信规格转述）。结论：**rev.1 不可整片开工**。

---

# 一、BLOCKER（8 条，写码前必须改规格）

## B1 三触发点漏了「启动」——`getState()` 在生产里恒 `signed_out`

规格 §1 S5a ①：`refresh()` 挂「登录成功/登出/收编导入」三触发点。仓内实况：`AuthStateService.ts:43,71` 初值 `SIGNED_OUT_NEVER`，`getState()`（:80-82）纯读缓存永不 IO，`refresh()`（:89-97）是唯一重算入口；`src/main/services/auth/index.ts:54-58` 的 `getAuthStateService()` **今天全仓零 `refresh()` 调用者**。

后果：flag-on 冷启动 → Root 拉 `auth.getState` → `signed_out` → 每次开机都进登录页，即使 vault 完好。

更毒的一层时序：`main/index.ts:717-719` 的 promotion latch 挂在 `browser-window-created`，而 `openLocalWindow()` 在 `:782`、`regenerateFromVault()` 在 `:787`。**任何在开窗前发生的 vault 读都必然 `locked`**（`CredentialVault.ts:214-218` 用 inert adapter 的 `available()===false`）。

改法：①明确第四触发点「首窗创建后、`regenerateFromVault()` 之后 `refresh()`」（`main/index.ts:787` 之后）；②`auth.getState` IPC handler 加惰性闩（`computedAt===null` 则先 refresh 再返回）——handler 是 async 且只能窗后发起，符合 S1「getState 不做同步 IO」的原意；③断言写成「在任何显式 refresh 之前调用 `auth.getState`，不得返回 signed_out（vault ok 时）」。

## B2 三态无「未判定」态 → 每次启动闪一次登录页 + App 挂载/卸载/再挂载

即使补了 B1，Main 的 startup refresh 与 renderer 的首个 `auth.getState` 之间没有屏障。Root 拿到 `signed_out` → 渲染 `OnboardingShell` → `auth.stateChanged` 推 `authenticated` → 换回 `AppShell`。`AppShell`（`Root.tsx:31-42`）里 `App` 是 `lazy()`（:16），一次挂载会跑 session restore/worktree hydration 全套；挂了再卸再挂是实打实的副作用重放，不是「闪一帧」。

改法二选一（规格必须选死）：
- **推荐**：照 `src/shared/windowTheme.ts:46-59` + `MainWindow.ts:175` 的 `additionalArguments` 先例，把初始 auth 快照（脱敏）同步投进 renderer argv，preload 首帧即可读 → 零闪烁、零新增 loading 态；
- 或者三态扩成四态，加 `unknown/initializing` 渲染 `LoadingShell`（Root.tsx:20-29），并明确「unknown 期不得渲染 OnboardingShell 也不得渲染 AppShell」。

## B3 `AICLIENT_SKIP_AUTH_GATE` 到 renderer 的通道未定义；两个 dev 判据必然分叉

三条实测事实：
1. `src/renderer` 全目录 **零 `process.env`、零 `import.meta.env`** 命中（grep 已跑）；`electron.vite.config.ts:97-100` renderer 段只 `define` 了 `__ONBOARDING_SERVICE_URL__`，没有 `envPrefix`。renderer 现在**根本读不到任何环境变量**。
2. `@shared/devFlags` 被 **main 与 renderer 同时 import**（`MainWindow.ts:6`、`Root.tsx:1`）。规格写「`import.meta.env.DEV`/主进程 `!app.isPackaged`」= 同一个共享模块里两套判据。二者会分叉：production 模式的 renderer bundle 跑在未打包的 main 下（`electron-vite preview`/`electron .`），main 判 dev=true 放行、renderer 判 dev=false 拦住 → **`isAppMountedFor()` 说 App 已挂载而 Root 在渲染登录页**，正是 I10 声称要消灭的双镜像分叉原地复活。
3. 若走 vite `define` 把 env 烘进 bundle：构建机上残留一个 `AICLIENT_SKIP_AUTH_GATE=1` 就会产出一个**打包版旁路门禁**的正式包，「打包版负控断言」形同虚设（断言的是源码常量，不是构建产物）。

改法：Main 单点计算 `skipAuthGate = !app.isPackaged && env.AICLIENT_SKIP_AUTH_GATE==='1'`，经 `additionalArguments` 同步投递（shared 出 `buildSkipAuthGateArg/parseSkipAuthGateArg` 纯函数对，两侧同源断言，范式照 `windowTheme.ts`）。`resolveSkipAuthGate(env)` 保留为 Main 侧纯函数（可 stub 测「isPackaged=true 恒 false」）。renderer 侧只读 parse 结果，不做第二次 dev 判定。

## B4 `credentials_invalid:rejected` 不可持久化，`markRejected()` 没有可用写入路径

`CredentialVault.read()`（:176-262）**从头到尾不看 `invalidatedAt`**——:240/:257 只是把它原样塞进 `doc`。所以 probe 写了 `invalidatedAt` 之后：进程内 in-memory 转 `credentials_invalid` 有效，**重启即失忆**，`read()` 返回 `ok` → `authenticated` → 员工带着已被网关吊销的 key 重新进主界面。

同时 `AuthState` 的 reason 联合（`AuthStateService.ts:26`）只有 `'corrupt'|'decrypt_failed'`，没有 `'rejected'`；`save()`（:264-303）会**重写整个 envelope 并重新加密 payload**，需要明文 payload——`locked` 时根本拿不到，所以不能拿 `save()` 当 markRejected 用。

改法：①Vault 新增 `markInvalidated(iso)`：只改明文层、`payload` 字节原样搬运、复用 `runSerialized` + tmp+rename+0600；②`read()` 增加判定：`invalidatedAt` 非空 → `{status:'rejected', lastEmail}`（新臂，不要混进 `invalid`——语义不同、UI 文案不同）；③`CredentialsInvalidReason` 扩 `'rejected'`（并给 S6 的 `'migration_incomplete'` 预留位）；④变异对补一条「markInvalidated 写完 payload 丢失/被降级为明文」。

## B5 lastEmail 预填两轨全断，且 OnboardingView 的初值 prop 会静默失效

三处独立的断点，规格一处都没写：

1. **flag-on**：`CredentialVault.ts:207-211`——`clear()` 后 `payload===null`，`read()` 直接返回 `{status:'absent'}`，**lastEmail 被丢掉**（S1 as-built 偏差 3 已自认「留待 S5 专用 accessor」）。而 `AuthState` 三个臂**没有任何 email 字段**。规格 §1 写「初值来自 `auth.getState().lastEmail`」——这个字段今天不存在，取值路径也不存在。
2. **flag-off**：规格写「沿用旧 `onboarding.check` email」。`OnboardingService.ts:361` `mergeSettingsPatch({ onboarding: { registered: false } })` 是**浅合并**（调查 03 §3 已证），登出即抹掉 `email/serverUrl`。flag-off 登出后 `onboarding.check().email` 恒空 → 预填必失败。
3. **组件**：`OnboardingView.tsx:169` `const [email, setEmail] = useState('')` 是一次性初值。加 `initialEmail` prop 后，只要 Root 在 lastEmail 到达前先渲染了 OnboardingShell（B2 的首帧场景 100% 命中），后到的值**不会生效且不报错**——典型静默失败。

改法：①`AuthState` 加 `lastEmail: string|null`（三臂都带）或 IPC 快照层单列；②Vault 加 `readLastEmail()` accessor（或 B4 的 `rejected`/新 `cleared` 臂带出 lastEmail）；③flag-off 轨改 `mergeSettingsPatch({onboarding:{registered:false, email: prev.email}})`（显式拼回，不改浅合并语义）；④OnboardingShell 挂 `key={`${reason}:${initialEmail}`}` 或 OnboardingView 用同步 effect，二选一写死在规格里。

## B6 失效信号被 cookie 会话遮蔽——「唯一信号源」可能长达 7 天不触发

`UsageService.ts:124-129` 的 `postAction` 对**所有**请求带 `credentials: 'include'`；`onboarding.ts:35-42` 的 `clearServerAuthCookie` 从 `session.defaultSession.cookies` 删 `auth-token`——这行代码本身就证明这些请求共用默认 session 的 cookie jar。E5 valid 臂实测：登录成功签发 `auth-token; Max-Age=604800; HttpOnly`（7 天）。

于是真实运行时序是：首次 getStats 走 bearer 401 → login → 拿 cookie → 之后 **direct 臂自带 cookie，很可能直接 200**，`direct.status===401` 分支（:218）不再进入 → `loginForActionsSession` 不再被调用 → **probe 永不触发**。E5 观察到的「valid bearer 也 401」是 curl 无 cookie 的形态，不能直接搬进 app 运行时。

后果：key 被吊销后，失效发现延迟不是「5 分钟」，而是「cookie 过期或 app 清 cookie」——最长 7 天。整个 §1③「不自建轮询、复用 usage 心跳」的地基塌了。

改法（先做一次 5 分钟实测定论，E1-lite 已有真 cch + 真 key）：`direct` 臂改 `credentials:'omit'`（让 401→login 链每轮必走），**或**把 probe 从 usage 链上摘下来做独立轻量定时（见裁定 a）。二者必须择一写进规格并配负控（「direct 臂带 cookie 也不得吞掉 login 分支」）。

## B7 renderer 侧双轨的 flag 判据默认反向 → flag-off 也会闪登录页

`useManagedMode.ts:16` `DEFAULT_MANAGED_MODE = { managed: true }`——S2b 为了 Provider 面板首帧不泄露而**故意默认托管**。Root 若拿它做双轨分叉，flag-off 首帧会走 flag-on 分支（authState 未 refresh → `signed_out`）→ flag-off 也闪登录页，§2「flag-off 等价」当场破。

改法（推荐，同时解 B2/B3 一半）：**把双轨放进 Main**——`auth.getState` 在 flag-off 时内部走旧链（`checkRegistration` + `checkCredentialsHealth`）折算成同一个三态返回，renderer 只有一条路径、零 flag 感知、零首帧竞态。规格现在的「renderer 双轨门控」是把 flag 判定、状态判定、渲染判定三件事塞进一个没有测试基建的组件里，风险收益比最差。

## B8 Root 门禁决策零测试基建，而 §3-6 要求的两条变异对无法咬合

仓内无 RTL/renderHook 基建（S2 as-built 偏差 6 明写），`src/renderer` 下无任何 Root 测试。§1「不做」把 render 级测试推给 D44，但 §3-6 变异清单里「预填漏 lastEmail」「（隐含）三态路由错」两对**没有任何测试能杀**——违反本仓「变异验证咬合力」纪律（发射半边必须打得中）。而这恰恰是本片最危险的逻辑：谁被锁在门外、谁被放进无凭据主界面。

改法：抽纯函数
`resolveGateDecision({authState, cliStatus, runtimeStatus, skipGate, registered}) → {shell:'loading'|'app'|'onboarding'|'vscode-only'|'detection-failed', props:{initialStep?, reason?, alreadyRegistered?, initialEmail?}}`
落 `src/shared/`，Root 与 `MainWindow.isAppMountedFor()` **同吃这一个函数**（`isAppMountedFor = decision.shell==='app'`）。这一步同时：把「换服务两处同变」从不可测变可测（§2 现在这条断言没有任何写法）、把过渡态组合矩阵变成一张表驱动单测、给两条变异对提供承重行。**这是本片投入产出比最高的结构改动，建议列为开工前置。**

---

# 二、MAJOR（13 条）

**M1 spawn 门禁与 dev 逃生舱不同步（规格 §4-d 的具体死角）。** 规格 §1「Main 侧 spawn 门禁：flag on 且 `kind!=='authenticated'` → 拒绝」，未提逃生舱豁免。组合 `flag-on + AICLIENT_SKIP_AUTH_GATE=1 + 无 vault`（= 开发者调托管凭据又不想真登录的**唯一**姿势）→ Root 放行进主界面，Main 逐个拒绝会话创建，逃生舱等于废掉。规格必须给这格明确行为（建议：逃生舱同时豁免 Main 门禁，且只在 `!app.isPackaged` 下成立，负控断言 packaged 时豁免恒不生效）。

**M2 spawn 门禁误伤普通终端。** `SessionManager.create`（`SessionManager.ts:127-141`）是**所有本地 PTY 的咽喉**（`kind` 默认 `'terminal'`，`createLocal:429`），两个 IPC 入口 `SESSION_CREATE`（`session.ts:28`）与 `TERMINAL_CREATE`（`:65-67`）都汇于此。在此按 `kind!=='authenticated'` 拒绝 = **凭据失效时连开个 shell 跑 git 都不行**。且 `attach`（`session.ts:32`、`SessionManager.ts:150`）未被门禁覆盖——持久化会话重连可绕过。规格要么按 `kind`/`agent` 收窄（只拦 agent 会话与 codex 终端），要么显式接受并写进已知限制 + 进 GUI 点验清单。

**M3 `auth_required` 在 renderer 是裸串，不是「既有报错卡通道」。** 实况：chat 路径 `chatSessions.ts:1060-1081` 把 `err.message` 原样塞进 `role:'error'` 气泡 → 用户看到 `Error invoking remote method 'chat:createSession': Error: auth_required`；终端路径 `useXterm.ts:735-747` 往 xterm 写红字 `Failed to start terminal. / Error: ...`。**没有任何按错误码分支的通道，也不路由回登录。** 规格 §1 的「renderer 有既有报错卡通道」这句是失实转述。改法：要么加码→文案映射 + dispatch `AUTH_OPEN_ONBOARDING_EVENT`，要么把门禁降格申报为「纵深防御，正常路径不可达」并在 §3 加负控「正常路径下 auth_required 出现次数=0」。

**M4 `isAppMountedFor` 换真源不解决真正的分叉项，且新增丢数据风险。** `MainWindow.ts:28-35` 的三项判定里，与 Root 真正分叉的是 **cliStatus/claudeInstalled**（Root.tsx:376-389 会因 CLI 缺失渲染 OnboardingShell，Main 侧完全不知情 → `:460` 判 true → 关闭时 30s 卡死）。只把 `registered` 换成 auth 快照，这个分叉原样留着。反向风险更严重：auth 快照转 `credentials_invalid` 而 App 尚未卸载时，`:460-463` 直接 `return`，**跳过脏文件确认，未保存的编辑器内容静默丢失**。改法见 B8（共享 `resolveGateDecision`）。

**M5 I9 顺序断言与 S2-B2 / S34 as-built 冲突。** 实况 `OnboardingService.ts:340-367`：`removeClaudeCredentials()` → 建 regenerate promise（⑤，S2 A轨 B2 明确裁定「不得链在 vault clear 之后，因为 fire-and-forget clear 没有『clear 后』时点」）→ `removeCodexConfig()` → `mergeSettingsPatch` → `clearVaultShadowCopy()`（④，末尾）。即**当前④在⑤之后**，且 S2 已论证二者顺序无关（logout regenerate 从不读 vault）。规格写「①…④vault.clear→⑤regenerate」并要「顺序断言测试」，会逼施工员重构一段已定论的架构。改法：断言写在**可观测完成检查点**上（gate 置位早于任何 kill；host shutdown 完成早于 IPC resolve；vault payload 归零 + 两 home 无 secret 均早于 `signed_out` 广播），并在规格里注明④⑤按构造顺序无关。另：`clear` 的 await 化只能落在 IPC handler（照 `onboarding.ts:130` 的 `awaitPendingLogoutRegenerate` 先例），`logout(): boolean` 同步签名是 S34 的既有契约。

**M6 `checkCredentialsHealth` flag-on 折算会污染启动期一次性推送。** `main/index.ts:428-461`：`detectCredentialFilesAvailable()` 内部调 `checkCredentialsHealth()`，而这段跑在 **`openLocalWindow()`（:782）之前** = promotion 之前 = vault 必 `locked` = 折算必 `signed_out` → 每次 flag-on 启动都推 `available:false` → `App.tsx:171-178` 弹一次「AI tools temporarily unavailable」警告 toast。规格必须钉死：折算只发生在 IPC handler 层（不改 `OnboardingService` 方法体），或同步处理这段启动推送的归属（见 m9）。

**M7 `refresh()` 无差别广播 + 可能的正反馈环。** `AuthStateService.ts:92-96` 每次 refresh 都通知全部 listener（S1 测试还钉了「refresh→onChange 恰一次」）。接上 IPC 推送后：probe 上报 → refresh → `stateChanged` → Root/App 失效 query → 若失效集合含 `usageStats`（`Root.tsx:231-240` 现在就一次性失效四个 query，`UserProfileCard.tsx:134` 登出也失效 usageStats）→ 立刻重取 → 再 probe → 再 refresh…… 规格必须写死三条：①值变才广播（并同步改 S1 那条「恰一次」断言）；②`stateChanged` 不得失效 `usageStats`；③`kind==='credentials_invalid'` 期间 probe 与 usage 一并停（否则登录页上还在拿死 key 打网关）。

**M8 IPC 快照契约与 S1 as-built 形状不兼容。** 规格通篇写 `getState().kind`，as-built 是 `status`（`AuthStateService.ts:29-32`）；快照要求「kind/email/remoteHealth/reason」，而 `AuthState` 今天**没有 email**、`remoteHealth` 只在 authenticated 臂、`reason` 三臂语义各异。另 `signed_out.reason='logout'` **没有产生路径**（as-built 偏差 4 自认「不可由 vault 读结果推导」）——若 UI 要区分「主动登出」与「从未登录」，需要显式 `markSignedOut('logout')` API。规格 §2 必须给出完整 IPC DTO（含判别字段名、每臂字段、脱敏保证），不能只列四个词。

**M9 S5 落地 / S6 未落 = flag-on 对存量员工是强制重登。** 母规格 §6 把「收编（adopt）：flag on 且无 vault 时从旧三处导入——升级员工免重登」放在 S6。S5 一旦把 Root 门禁切到 authState，S5→S6 之间任何打开 flag 的构建，**存量员工开机即被踢回登录页**（他们的 legacy 凭据完好、昨天还能用）。规格必须二选一：明写「S6 前 flag 不得在分发版打开」（并进门禁清单），或把 adopt 的最小片提前到 S5。

**M10 `shellSwitchStatic` 改锚会静默失去保护目的。** 该文件有两处涉及：
- `:43-57`（测试 1）扫描「同时包含 `SKIP_ONBOARDING_GATE` 与 `useOpenChamberShell`」的文件。常量退役后**全仓零命中 → 永远绿 → 保护静默消失**（典型 vacuous green）。改锚必须：换 token 为新符号（`resolveSkipAuthGate`/`AICLIENT_SKIP_AUTH_GATE`）**并加「扫描非空」断言**（含该 token 的文件数 > 0，照 S2「比较文件数>0」的既有手法）。
- `:84-88`（测试 3）承重的半边是 `expect(root).not.toContain('useSettingsStore')`（T-16 回归：门禁旁路路径不许碰 settings store），必须原样保留；只有 `if (SKIP_ONBOARDING_GATE) { return <SkippedOnboardingApp />; }` 这句字面量需要改锚，且新形状若因 B2/B7 变成非早返回结构，改锚要保持同等具体度（断言逃生舱分支仍返回 `<SkippedOnboardingApp />`）。

**M11 失效判据两份文档打架，照 E5 伪码写会误杀。** 规格 §2 写「401 且 `errorCode==='KEY_INVALID'`」；E5 报告的判据伪码（e5 报告 §「判据伪码」）写的是 `body.errorCode == "KEY_INVALID" **or** body.ok == false` —— 而 `ok:false` 恰恰是**业务端点**（`/api/actions/*`）的错误体形状（E5 fixture c）。施工员照伪码实现 = 业务 401 被判成失效 = 直接踩中规格自己列的第 2 条变异（业务 401 直接上报）。规格必须钉死：判据只对 `/api/auth/login` 的响应生效，且只认 `errorCode==='KEY_INVALID'`；E5 伪码那条 `ok:false` 分支明确作废并注明理由。
配套：`loginForActionsSession`（`UsageService.ts:81-109`）当前返回 `{ok:false, error:string}`，**丢掉了 status 与 errorCode**（`extractErrorMessage` 只取 `error`/`message` 文案）。规格要显式列出这个返回形状的契约变更，否则判据无处取值。

**M12 usage 心跳的真实可用性远低于「5 分钟」。** ①`enabled: isRegistered`（`WindowTitleBar.tsx:57`）/`enabled: Boolean(email)`（`UserProfileCard.tsx:68`）；②`useUsageStats` 未设 `refetchIntervalInBackground`（默认 false）→ **窗口最小化/隐藏时定时刷新暂停**；③`isRegistered` 来自 legacy `registered` 标志，S6 停双写后归属未定。所以「5 分钟粒度」= 「前台且已注册的 5 分钟」。规格若坚持裁定 a，必须把这三条写成已知限制并给出员工体验上界。

**M13 GUI 点验七项全是 happy path，缺最危险的四条臂。** 缺：`credentials_invalid` 真跑（本片最新的路径，零覆盖）、vault `locked` 臂（Linux keyring 未解锁 = 现设计下直接踢回登录页，见下 m 项）、flag-off 轮、关闭确认（`isAppMountedFor` 两个方向）。且**没有可复现的失效注入手段**——不可能临时让网关吊销 key。改法：加 dev-only 注入（强制 `markInvalidated` 的 dev IPC，或把 `cchBaseUrl` 指向本地 stub 返回 `401 KEY_INVALID`），否则失效臂只能靠祈祷。另：清单第 7 项「重登预填邮箱」在当前设计下**必然当场红**（B5）。

---

# 三、MINOR（9 条）

- **m1** 新 `auth.getState`/`auth.stateChanged` 落点未定。既有 `AUTH_MANAGED_MODE` handler 寄生在 `src/main/ipc/claudeRuntime.ts:65`（S2b 的将就），S5 应新建 `src/main/ipc/auth.ts` 收拢三个通道，顺手把 managedMode 迁过去。
- **m2** `scripts/dev.js` 不打印 `AICLIENT_SKIP_AUTH_GATE` 解析值。该键**不在** `STRIPPED_KEYS`（`dev.js:102-103`）里，shell 或 `dev.env` 残留会静默旁路门禁——直接破坏 §2「GUI 点验：不设该变量」的前提。照 `dev.js:247` 的既有 log 补一行，并把该行输出计入点验证据。
- **m3** macOS 上 `WindowTitleBar` 直接 `return null`（`WindowTitleBar.tsx:83`）→ `UserProfileCard` 是它的**唯一**挂载点（:143，全仓 grep 确认）→ 三态芯片、重登入口、登出按钮在 mac 全部不存在。三态 UI 的唯一 affordance 在 mac 缺席，随 test.4 登记。
- **m4** `UsageService.getStats()` 的 `serverUrl` 仍取 legacy `checkRegistration().serverUrl`（:144-154）。flag-on 下 I1 权威是 `vault.cchBaseUrl`；至少登记 S6 移交，否则 S6 停双写后 usage 整条链断。
- **m5** probe「单飞 + 退避」粒度未定义：单飞作用域（进程内单例？跨窗口？）、退避时长、unknown 期多久允许重试、`remoteHealth` 从 unknown 回 valid 的路径。§2 只有一句话。
- **m6** `reason='expired'` 重登进 `register-email` 后，「返回」按钮（`OnboardingView.tsx:600` → `handleReturnToInstall:354-360`）会把用户扔回 `cli-check` —— 失效重登语境下这是个死胡同。reason 存在时应隐藏或改文案。
- **m7** `SkippedOnboardingApp`（`Root.tsx:53-60`）不挂 `ClaudeRuntimeBanner`，而 `AppShell`（:418-429）挂。门禁收回后逃生舱成为 dev 常用路径，bun-incompatible 警告在 dev 看不见，建议对齐。
- **m8** `auth.stateChanged` 的多窗口广播未定义。范式可照 `chat.ts` 的 `broadcastRuntimeEvent`（遍历 `BrowserWindow.getAllWindows()` + `isDestroyed` 守卫）。
- **m9** `ONBOARDING_LIVE_CREDENTIALS_STATUS` 退役后，`main/index.ts:424-461` 整段（`credentialStatusSent`/`windowFinishedLoading`/`maybeSendLiveCredentialsStatus` 编排）成死码，规格未点名清理归属（S5 还是 S6）。

---

# 四、§4 自设裁定 a~e 逐条判真伪

| # | 裁定 | 判定 | 依据 |
|---|---|---|---|
| **a** | 失效信号只挂 usage 心跳不自建轮询，5 分钟粒度换实现简单 | **伪** | 5 分钟不是真实上界。B6：cookie jar 使 direct 臂长期 200，login 分支根本不走，上界≈cookie 7 天；M12：最小化即停、未注册即停、无窗口即停。「实现简单」也不成立——为了从 `loginForActionsSession` 里取出 status+errorCode 要改它的返回契约（M11），并不比一个独立 probe 定时器简单。**改判建议**：probe 独立于 usage 链（启动后一次 + N 分钟定时 + 会话创建前一次），usage 只作为**附加**触发源；或最低限度把 direct 臂改 `credentials:'omit'` 并补负控 |
| **b** | `checkCredentialsHealth` IPC 保留兼容，renderer 契约不动，S6 清 | **真，但有条件** | renderer 契约确实不动（消费点只有 `Root.tsx:160-165`，flag-on 下不再走）。条件：折算**只能落在 IPC handler 层**，不能改 `OnboardingService.checkCredentialsHealth()` 方法体——否则连带污染 `main/index.ts:432-438` 的启动推送（M6）。规格必须补这句限定 |
| **c** | spawn 门禁只拦三入口（与 S2 trust 同位），不拦 agent-host 内部路径 | **半真** | 「与 trust 同位」的选点是对的（`chat.ts` 两处 + `SessionManager.create`）。但两处描述失实：①`SessionManager.create` 不是「三入口之一」，它是**所有本地终端**的共同咽喉（M2），拦它 = 拦普通 shell；②`attach`/持久化会话重连臂未列（`session.ts:32`），可绕过。裁定应改写为「按会话 kind 收窄 + 显式声明 attach 臂的处置」 |
| **d** | 门禁收回无 flag 而 Root 收敛有 flag，两层不同步的过渡态是否自洽 | **不自洽（伪）** | 至少两格死角：①`flag-on + skip-gate=1` → Root 放行、Main 门禁照拒 = 进得去开不了会话（M1）；②`flag-off` 首帧 `useManagedMode` 默认 `managed:true` → 走 flag-on 分支 + 未 refresh 的 `signed_out` = flag-off 也闪登录页（B7）。另 ③`flag-on + vault locked` → `signed_out`（`AuthStateService.ts:52-59` 把 locked 折成 signed_out）→ **一次 keyring 未解锁 = 完整重登**，而 S2 花大力气保护过「locked 不得抹凭据文件」，S5 却在同一情形下把用户踢出门。**必须在 §2 补一张 `flag(2) × gate(2) × vault 五态` 的 20 格矩阵，每格写明 shell + 能否 spawn + 关闭确认行为**；三个已知死角逐格给行为 |
| **e** | GUI 点验七项是否足以充当 D47 全链首次真跑验收 | **不足（伪）** | 七项全 happy path。缺失效臂/locked 臂/flag-off 臂/关闭确认臂（M13），且无可复现的失效注入手段；第 7 项「重登预填邮箱」在当前设计下必然红（B5）。另建议补两项零成本证据：`printenv | grep -i anthropic` 在 app 内终端为空（I1/§3.A 的一箭四雕主张）、登出后 `<userData>/claude-home/settings.json` 与 `codex-home/` 的 secret 字节扫描 |

---

# 五、开工判语

**「只改 blocker」不足以开工，且 blocker 也不该单独改。**

理由：B3/B7/B8 一旦按建议落地（Main 单点计算 + argv 同步投递、双轨下沉 Main、抽 `resolveGateDecision` 共享纯函数），**§1 的文件集、§2 的契约、§3 的验证形态三节全要重写**——不是补丁级修订。而 M1/M2/M3/M5/M11 直接决定施工员逐行写什么（拦哪些 kind、抛什么码、断言哪个顺序、判据取哪个字段），留到施工期再定必然返工。

可执行的推进方式（建议按此拆）：

- **立即可并行动工（与上述争议无交集，S5a 子集）**：
  1. `CredentialVault.markInvalidated()` + `read()` 的 `rejected` 臂（B4）——纯模块，测试基建齐全；
  2. `classifyAuthProbe()` 判据纯函数 + E5 双臂机器 fixture（M11 口径，照 S34 把 E4 转成 `__tests__/fixtures/` 的做法，禁在 vitest 里解析 markdown）；
  3. `AUTH_OPEN_ONBOARDING_EVENT` / queryKey / authState 类型三个 shared 常量（零风险净收敛）；
  4. `AuthStateService`「值变才广播」+ startup refresh 触发点（B1/M7）。
- **rev.2 必须先写死再动工的**：Root/UI 全部（S5b）、spawn 门禁的覆盖面与错误呈现、I9 顺序断言口径、逃生舱投递机制与组合矩阵、S5→S6 之间 flag 的分发纪律。
- **rev.2 前置的一次实测**（5 分钟，E1-lite 的真 cch + 真 key 还在）：带 `auth-token` cookie + 有效 bearer 打 `/api/actions/my-usage/getMyTodayStats`，看是否 200。这一条实测结果直接决定裁定 a 是保是废（B6），也决定 §1③ 整段怎么写。

相关文件（绝对路径）：
`/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md`、
`/home/dan/projects/ai-client/src/renderer/Root.tsx`、
`/home/dan/projects/ai-client/src/shared/devFlags.ts`、
`/home/dan/projects/ai-client/src/renderer/App/__tests__/shellSwitchStatic.test.ts`、
`/home/dan/projects/ai-client/src/main/windows/MainWindow.ts`、
`/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts`、
`/home/dan/projects/ai-client/src/main/ipc/onboarding.ts`、
`/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts`、
`/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts`、
`/home/dan/projects/ai-client/src/main/services/auth/index.ts`、
`/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts`、
`/home/dan/projects/ai-client/src/main/index.ts`、
`/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts`、
`/home/dan/projects/ai-client/src/main/ipc/session.ts`、
`/home/dan/projects/ai-client/src/renderer/components/user/UserProfileCard.tsx`、
`/home/dan/projects/ai-client/src/renderer/components/layout/WindowTitleBar.tsx`、
`/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx`、
`/home/dan/projects/ai-client/src/renderer/hooks/useUsageStats.ts`、
`/home/dan/projects/ai-client/src/renderer/hooks/useManagedMode.ts`、
`/home/dan/projects/ai-client/src/shared/windowTheme.ts`（B3 推荐范式）、
`/home/dan/projects/ai-client/scripts/dev.js`。

未改动任何文件。