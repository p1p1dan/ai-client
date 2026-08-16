# D47 S5 施工规格 — 登录态、门禁收回与失效信号（rev.2 评审合取版）

> 2026-08-15。母规格 §3.D/§4/§7 S5 行；S0~S4 已落；U2 拍板 = S5 收回旁路门禁。
> **rev.2 = rev.1 结构性重写**：双盲评审合取——A 轨 Opus（状态机与 UI，8B/13M/9m，判「blocker 单改也不够，
> 三节全重写」）+ B 轨 Codex（证据，6B/4M/4m，判「rev.1 不可开工」），原文归档
> [reviews/](./2026-08-15-d47-s5-reviews/)。本版四个结构裁定：**双轨下沉 Main / 门禁决策抽共享纯函数 /
> 初始快照走 argv 投递 / probe 独立定时**。字段名全仓统一 **`status`**（S1 as-built，禁 `kind`）。

## §0 评审实锤的三个现役缺陷（本片必修，与新功能同批）

1. **UsageService cookie 载体 bug**（B 轨 B3）：`loginForActionsSession` 拿到的 `auth-token` cookie 值被当
   Bearer 塞回 `Authorization` 头（`UsageService.ts:224`），E5 真机判据下该重试**永远 401**；现测试
   `UsageService.test.ts:268` 把错协议钉死。修法：重试臂发 `Cookie: auth-token=<v>`（或 cookie jar +
   `credentials`），改写既有测试断言「重试不含 Authorization/含 Cookie」。
2. **cookie jar 遮蔽 401 链**（A 轨 B6）：`postAction` 全请求 `credentials:'include'` + 登录 cookie 7 天
   → direct 臂长期 200，401→login 分支不再走。修法：direct 臂改 `credentials:'omit'`（显式 Cookie 只在
   重试臂），负控钉死。
3. **logout 浅合并抹 email**（A 轨 B5-2，调查 03 已记）：flag-off 预填依赖 `onboarding.email`——logout 的
   `mergeSettingsPatch({onboarding:{registered:false}})` 改为显式拼回 `email`。

## §1 核心结构（四裁定，rev.1 对应节全部作废）

### 1.1 AuthState DTO（唯一权威，`src/shared/types/auth.ts`）

```ts
type AuthState =
  | { status:'unknown' }                                    // 仅 renderer 首帧兜底，Main 不产生
  | { status:'signed_out';          lastEmail: string|null }
  | { status:'authenticated';       email: string; remoteHealth:'unknown'|'valid' }
  | { status:'credentials_invalid'; reason:'rejected'|'corrupt'|'decrypt_failed'; lastEmail: string|null };
```
- `email` 来自 vault payload（authenticated 时必有）；`lastEmail` 来自 envelope 明文层。
- **Vault 扩展（可立即动工件）**：`markInvalidated(iso)`（只改明文层、payload 字节原样、串行原子 0600——
  A 轨 B4：`save()` 需明文 payload 在 locked 下不可用，故必须专用方法）；`read()` 新增 **`rejected` 臂**
  （`invalidatedAt` 非空 → `{status:'rejected', lastEmail}`，优先于 ok）与 **`cleared` 臂**
  （`payload:null` → `{status:'cleared', lastEmail}`，替代 S1 的 absent 折叠——lastEmail 取回即此，
  S1 as-built 偏差 3 的欠账）；`readLastEmail()` 不另设（cleared/rejected 臂已带出）。
- `locked`/`unsupported` → **`authenticated` 不可得但也绝不踢人**：折算为
  `{status:'signed_out', lastEmail}` 是 rev.1 的错（A 轨 d-③：keyring 未解锁=强制重登，与 S2 locked
  保字节精神冲突）。改为折算 `{status:'unknown'}`？——Main 不产生 unknown。**裁定**：新增
  `credentials_locked` 不进 DTO，Main 对 locked 返回 `authenticated` 吗？不可（email 需解密）。
  **最终口径**：locked → `{status:'signed_out', lastEmail}` **但 Root 对 locked 特判不可行**（DTO 无此位）
  ——因此 DTO 增第五臂 `{ status:'locked'; lastEmail: string|null }`：Root 渲染 LoadingShell + 重试
  （升格后 refresh 自然转 authenticated）；spawn 门禁对 locked 拒绝但文案区分。20 格矩阵见 §4。

### 1.2 双轨下沉 Main（A 轨 B7 + B 轨 M1 合取）

- 新 IPC **`auth.getGateSnapshot()`**（落新文件 `src/main/ipc/auth.ts`，顺迁 S2b 寄生在 claudeRuntime 的
  `AUTH_MANAGED_MODE`——A 轨 m1）：返回 `{ managed: boolean, state: AuthState, skipAuthGate: boolean }`
  单次原子判定。**flag-off 时 Main 内部走旧链**（`checkRegistration`+`checkCredentialsHealth` 折算进同一
  DTO；折算只在 IPC handler 层，不改 OnboardingService 方法体——A 轨 M6/b 条件）。renderer 单路径零 flag
  感知；`useManagedMode` 不用于门禁（仅 Provider UI 留用）。
- `auth.stateChanged` 推送：**值变才广播**（同步修 S1「refresh→onChange 恰一次」断言为「值变恰一次」——
  A 轨 M7）；多窗口照 `broadcastRuntimeEvent` 范式；**失效集合不含 `usageStats`**（防正反馈环）；
  `credentials_invalid` 期间 probe 与 usage 轮询一并停。

### 1.3 初始快照与逃生舱投递（A 轨 B2/B3，windowTheme argv 先例）

- Main 单点计算 `skipAuthGate = !app.isPackaged && env.AICLIENT_SKIP_AUTH_GATE==='1'`（纯函数
  `resolveSkipAuthGate({env,isPackaged})`，矩阵测试含 packaged 恒 false）；与**初始 AuthState 快照**（脱敏）
  一起经 `additionalArguments` 投进 renderer（shared 出 build/parse 纯函数对 + 同源断言）。
  renderer 首帧即有 `{skipAuthGate, initialState}`——**零闪烁**，`unknown` 臂只在 argv 缺失兜底。
- 启动触发点补齐（A 轨 B1）：`main/index.ts` 在 `regenerateFromVault()` 之后 `await authStateService.refresh()`
  再开窗？——开窗在前（升格依赖窗）。**顺序裁定**：开窗 → 升格闩 → regenerate → refresh → 此时 renderer
  尚在加载（lazy React），argv 已含「locked 或 refresh 前快照」…… argv 在 `new BrowserWindow` 时冻结，
  必然早于升格。**因此 argv 快照允许 `locked`**，Root 对 locked/unknown 渲染 LoadingShell 并在
  `auth.stateChanged`（refresh 后必推）到达时定轨——闪烁面收敛为「Loading→终态」单向，无 Onboarding↔App
  往返（B2 的副作用重放被消除）。`auth.getGateSnapshot` handler 加惰性闩（`computedAt===null` 先 refresh）。
- `SKIP_ONBOARDING_GATE` 常量退役；`shellSwitchStatic` 改锚：token 换新符号 + **扫描非空断言**（A 轨 M10
  防 vacuous green）；`not.toContain('useSettingsStore')` 半边原样保留；逃生舱分支仍断言返回
  `SkippedOnboardingApp`。dev.js 补 `AICLIENT_SKIP_AUTH_GATE` 解析值日志（A 轨 m2，点验证据）。

### 1.4 门禁决策共享纯函数（A 轨 B8，开工前置）

`src/shared/authGate.ts`：
```ts
resolveGateDecision({state, managed, skipAuthGate, cliStatus, runtimeStatus, legacyRegistered})
  → { shell:'loading'|'app'|'onboarding'|'vscode-only'|'detection-failed',
      onboarding?: { initialStep, reason:'first_run'|'expired'|'signed_out', initialEmail } }
```
- Root 与 `MainWindow.isAppMountedFor`（= `decision.shell==='app'`）**同吃此函数**——「换服务两处同变」
  从口号变可测；cliStatus 分叉（A 轨 M4 指出的真分叉项）一并收敛；close-confirm 对
  `credentials_invalid` 时 App 未卸载的脏文件确认不跳过（M4 丢数据风险：invalid 时 shell 已非 app，
  但 Main 侧判定需以「renderer 已确认卸载」事件为准——实现按既有 30s 会话确认语义，测试钉）。
- `deriveOnboardingEntry(state)`（预填/文案）与 `deriveUserProfilePresentation(state)`（三态芯片）同落
  shared 纯函数（B 轨 B6/M3 的可测性方案）；静态接线断言 Root/OnboardingShell/OnboardingView/
  WindowTitleBar/UserProfileCard 消费生产 helper（**OnboardingShell 与 WindowTitleBar 列入改动清单**——
  B 轨 M3 漏项）；OnboardingShell 以 `key={reason+initialEmail}` 重挂载（B5-3 静默失效防御）。

## §2 失效信号（probe 独立化——A 轨 a-裁定改判采纳）

- **probe 独立于 usage 链**：`AuthProbeScheduler`（Main）——启动 refresh 后一次 + 5 分钟定时（仅
  authenticated 期）+ 登录成功后一次；usage 链的 KEY_INVALID 报告为**附加**触发源。判据纯函数
  `classifyAuthLoginResponse(status, bodyText)`：**仅** `/api/auth/login` 响应、**仅** `401 +
  errorCode==='KEY_INVALID'` → rejected；其余（网络/超时/5xx/404 HTML/307/`ok:false` 无 errorCode）→
  `unknown` 不改臂（**E5 伪码的 `body.ok===false` 分支明确作废**——两轨同判会误杀业务 401）。
  单飞 + unknown 期退避（10 分钟内不重打）；`remoteHealth` unknown→valid 由下次 probe 200 恢复。
- **E5 机器 fixture**（B 轨 B4）：`src/main/services/auth/__tests__/fixtures/e5-*.json`
  （login-valid / login-key-invalid / actions-401-no-cookie / actions-cookie-200 四份，
  `{request:{endpoint,authMode}, response:{status,headers,bodyText}}` schema，README 记 E5 溯源）；
  测试 readFileSync 驱动生产 classify 与 login 接缝，非空断言。
- **`markRejected()` 编排**（B 轨 B5）：`vault.markInvalidated` → **`await agentHostManager.shutdown()`**
  （消灭 codex swept-revive 内部路径——`codexRuntime.ts:2313` 的 send-时静默重开进程；I5 母规格逐字
  要求）→ 值变广播。测试：可 revive 的 swept 会话 + 失效 → send → 断言无新连接 + 用户可见错误。
- UsageService：key 来源 flag-on 走 vault（`serverUrl` 仍 legacy，S6 移交登记——A 轨 m4）；
  `loginForActionsSession` 返回判别联合 `{ok:true}|{ok:false,rejection:'key_invalid'|'unknown',error}`
  （B 轨 m4：现形状丢 status/errorCode 无处取值）；§0 两 bug 同批修。

## §3 登出 I9 与 spawn 门禁

- **I9 编排重构**（B 轨 B2：现 shutdown 嵌在 regenerate 链尾、clear 是 fire-and-forget——「handler 重排」
  不可实现）：新 `performLogoutSequence()`（Main 编排纯入口，IPC handler await 它；`logout():boolean`
  同步签名保留为其中一步）：①`beginLogout()` 同步置 spawn gate → ②terminateAllSessions →
  ③`await agentHostManager.shutdown()`（从 regenerate 链尾**摘出**，链尾旧调用移除）→
  ④`await vault.clear({keepLastEmail:true})`（升级为可等待；失败捕获不改返回值）→
  ⑤regenerate 两 home 无凭据版（与④顺序**登记为构造无关**——logout regenerate 不读 vault，S2-B2 已定论；
  断言不钉④⑤相对序）→ ⑥clearServerAuthCookie → ⑦值变广播 signed_out。
  顺序断言 = **可观测完成检查点**（A 轨 M5 口径）：gate 早于任何 kill；shutdown 完成早于 IPC resolve；
  payload 归零 + 两 home 无 secret 早于广播；deferred-promise 证跨 await 屏障（B 轨 B2 测试形态）。
- **spawn 门禁（收窄版——A 轨 M2 + B 轨 c 合取）**：只拦 **agent 会话面**：`CHAT_CREATE_SESSION`/
  `CHAT_RESUME_SESSION` + `SessionManager.create` 中 `kind==='agent'`（或带 agentCommand）的臂；
  **普通终端 shell 不拦**（凭据失效也要能跑 git）；`attach` 臂显式登记不拦（已存在会话的重连，
  进程内凭据本就存活——A 轨 m7 同类窗口）。拒绝返回**结构化 envelope**
  `{ok:false, error:{code:'auth_required', message}}`（B 轨 M4：现通道只有裸 message）；renderer 映射：
  错误卡中文文案 + 「重新登录」动作 dispatch `AUTH_OPEN_ONBOARDING_EVENT`。逃生舱豁免：`skipAuthGate=true`
  时 Main 门禁同豁免（A 轨 M1 死角格）。矩阵 = 入口(3) × 状态(5)（B 轨 B6 假绿整改）。

## §4 过渡态矩阵与分发纪律

- **20 格矩阵**（flag(on/off) × gate(on/off) × vault(ok/cleared/rejected/locked/invalid)）随施工落成
  表驱动单测（`resolveGateDecision` 一张表全覆盖）。三个已裁死角：flag-on+gate-on ⇒ shell=app 且
  spawn 门禁**同豁免**；flag-off 首帧 ⇒ argv 快照走旧链折算（无 useManagedMode 参与）；
  flag-on+locked ⇒ LoadingShell 等升格，**不踢登录页**。
- **分发纪律（A 轨 M9，进门禁清单）**：S6（收编）落地前，**分发构建不得开 `AICLIENT_MANAGED_CREDENTIALS`**
  ——否则存量员工被强制重登。写入 baseline 门禁文档 + 本规格验收行。
- `ONBOARDING_LIVE_CREDENTIALS_STATUS` 一次性推送整段（`main/index.ts:424-461`）**本片退役清理**（A 轨
  m9 归属：S5）；`checkCredentialsHealth` IPC 兼容折算至 S6 清。

## §5 验证与变异

承重面：DTO/Vault 新臂 · gate 决策 20 格表 · probe 判据 fixture 四份 · I9 检查点序 · 门禁 3×5 矩阵 ·
§0 三 bug 各带回归 · argv 投递同源断言 · shellSwitchStatic 非空改锚 · flag-off 等价（argv 旧链折算轨）。

**变异 ≥10 对（每对四列：正确态输入/生产变异/唯一红断言/非空证明——B 轨 B6 格式）**：
① probe 网络错判 rejected（断言 authenticated+unknown 保持 + markInvalidated 0 次 + invalidatedAt 字节不变）
② 业务 401 直接上报（fixture 驱动，login 200 → markRejected 0 次）③ I9 gate 晚于 kill（deferred 屏障）
④ 门禁漏 resume 臂（3×5 矩阵行）⑤ packaged 逃生舱放行（isPackaged 显式参数）⑥ 预填漏 lastEmail
（`deriveOnboardingEntry` 纯函数 + 静态接线）⑦ markInvalidated 丢 payload 字节 ⑧ cookie 重试带
Authorization（§0-1 回归）⑨ direct 臂 include 吞 login 分支（§0-2 负控）⑩ 值变广播退化为每次广播
（S1 断言改锚后的两态）。

**GUI 点验（扩充版，A 轨 M13/e）**：七项 happy path + ⑧失效臂（**dev-only 注入 IPC**：强制
`markInvalidated`，仅 `!app.isPackaged` 注册）→ 断言路由回登录且旧 host 关闭 ⑨locked 臂（keyring 锁定
模拟或 adapter 注入）→ LoadingShell 不踢人 ⑩flag-off 轮 ⑪close-confirm 双向 ⑫app 内终端
`printenv | grep -i anthropic` 为空 + 登出后两托管 home secret 字节=0。失效重登页隐藏「返回 CLI 检查」
死胡同按钮（A 轨 m6）。mac 的 UserProfileCard 缺席（唯一挂载点 WindowTitleBar 在 mac return null）
登记 test.4（A 轨 m3）。

## §6 评审合取记录

| 项 | 裁定 |
|---|---|
| 独立同判（DTO 字段矛盾 B1≡B1 / I9 不可实现 B2≡M5 / usage 心跳不可靠 B3+B6 / E5 fixture 缺 B4≡B4 / revive 绕门禁 B5≡c-伪 / 变异不可判 B6≡B8） | 全采 |
| 四结构裁定 | 双轨下沉 Main（A-B7）· `resolveGateDecision` 共享（A-B8）· argv 投递（A-B2/B3，windowTheme 先例）· probe 独立定时（A-a 改判，B6 的 cookie 遮蔽随 §0-2 修复后 usage 降为附加源） |
| rev.1 裁定 a~e | a 伪（独立 probe）；b 真附条件（折算限 IPC 层）；c 半真（kind 收窄 + attach 登记 + markRejected shutdown 前置）；d 伪（矩阵 + 三死角逐格裁）；e 伪（点验扩至 12 项 + dev 注入手段） |
| 新增第五臂 `locked` | rev.2 自裁：locked 不踢人（与 S2 保字节精神对齐），LoadingShell 等升格 |
| 现役缺陷三条 | §0 收编本片（cookie 载体/cookie 遮蔽/浅合并抹 email） |
| 母规格连带 | §4 判定表加 locked 行；S5 行断言更新；分发纪律入 baseline 门禁 |

## §7 as-built（2026-08-15 施工收口，commit `5e8b494`）

三员施工（S5a Main/shared / S5b renderer 并行零混面【接口自发对齐零冲突，S5a 中途按 S5b 的 preload 消费端
补 `legacyRegistered` 字段】+ 收尾员对账/四门/变异批）。中途一次会话限额中断（两员探查期终止，零残留重发）。
门禁串行：lint 0 / typecheck 0 / typecheck:agent-host 0 / **vitest 205 文件 3874 例 0 红**（S3+S4 3727 → +147）。
**变异 10/10 零存活**，记录 [reviews/mutations.log](./2026-08-15-d47-s5-reviews/mutations.log)。

对账四项：spawn 门禁实为 throw（`spawnGate.assertAgentSpawnAllowed`），S5b 双保险匹配成立无静默吞错，
补端到端形状测试；i18n 补 4 key；IPC 三通道三处一致；LoadingShell 死锁修复（`enabled:Boolean(gateQuery.data)`）
+ 矩阵外组合用例钉死。

规格偏差（均不改契约）：
1. `getGateSnapshot` 返回加 `legacyRegistered`（resolveGateDecision 需要，rev.2 契约漏列）。
2. argv 快照**只用于 skipAuthGate**，不作 gate 决策种子（flag-off 分支需要 argv 不携带的
   managed/legacyRegistered——「多等一帧 Loading」优于「错误态先渲染再纠正」，Root 注释记录）。
3. `resolveGateDecision.cliStatus` 参数「可选仅加严」（isAppMountedFor 无廉价同步来源）。
4. close-confirm 的 credentials_invalid 脏文件确认握手**未实现**（沿用原跳过逻辑），按评审 A-M4 登记
   已知风险非新功能。
5. 新增 `probeTarget.ts`/`spawnGate.ts` 两个同域小助手（防四文件重复逻辑）。
6. `deriveUserProfilePresentation` 只回 tone+email 不回文案（i18n 归渲染层）。
7. 变异⑥（预填漏 lastEmail）由源码静态扫描钉住而非运行时挂载断言（仓内无 OnboardingView 挂载测试基建
   ——D44 组件层落地后补强，登记）。

欠账登记：**GUI 点验 12 项（§5）未跑**——D47 全链首次真跑，需真实验证码，见 plantree 下一步；
mac 的 UserProfileCard 缺席与 win/mac 权限位随 test.4。
