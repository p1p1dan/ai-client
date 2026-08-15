# D47 S5 施工规格 — 登录态、门禁收回与失效信号（rev.1 待评审）

> 2026-08-15。母规格 §3.D/§4/§7 S5 行；S0~S4 已落。拍板输入：**U2 = S5 收回 `SKIP_ONBOARDING_GATE`**；
> 移交输入：S34 A-M5（Main 侧凭据门禁）、S34 A-M1（I9 七步全序）、S2 已知限制（App 内失效不路由）。
> 证据：调查 03（Root 门禁四 query/UserProfileCard 用量链/logout 事件总线/浅合并坑）+ E5（auth-probe
> 双臂判据：`/api/auth/login` valid=200+cookie / invalid=401+`KEY_INVALID`；**业务端点只认 cookie，
> valid bearer 也 401**——业务 401 是常态非失效信号）+ E1-lite（重登同 key）。

## §1 范围与交付物

### S5a（Main 侧）

- `src/main/services/auth/AuthStateService.ts`（扩展 S1 版）——真正接线：
  ① `refresh()` 挂三触发点（登录成功/登出/收编导入——S6 预留），推导含 `remoteHealth`；
  ② **auth-probe**：新 `probeCredential(key)` 调 `POST {vault.cchBaseUrl}/api/auth/login`——
  `401+KEY_INVALID` → `markRejected()`（vault 写 `invalidatedAt` + 状态转 `credentials_invalid:rejected`）；
  网络错/超时/5xx/非 KEY_INVALID 形状 → 保持 `authenticated` 降 `remoteHealth:'unknown'`（I6，E5 判据字节）；
  ③ probe 触发源 = UsageService 报告（见下），**不自建轮询**（复用既有 5 分钟 usage 心跳）。
- `src/main/services/usage/UsageService.ts` — ① key 来源改 **Vault**（flag on；flag off 维持读
  `~/.codex/auth.json`——过渡兼容）；② 其「bearer 401 → cookie login 重试」链上：**cookie login 也被拒
  且形状为 KEY_INVALID** 时上报 AuthStateService（唯一失效信号源；业务 401 本身绝不上报——E5 实证 valid
  bearer 也 401）；③ `/api/actions` 弃用债不动（ideas 已记）。
- **IPC**：`auth.getState`（拉，脱敏快照：kind/email/remoteHealth/reason——**无 key**）+
  `auth.stateChanged`（推）。`ONBOARDING_LIVE_CREDENTIALS_STATUS` 一次性推送退役。
  `checkCredentialsHealth` IPC 保留但 flag-on 分支改由 AuthStateService 折算（renderer 契约不变，S6 后清理）。
- **登出 I9 七步全序**（收编 S34 屏障成果）：`main/ipc/onboarding.ts` LOGOUT handler 重排为：
  ①关 spawn gate（新：AuthStateService.beginLogout() 置位，见门禁）→ ②terminateAllSessions（已有）→
  ③host shutdown await（S34 已有）→ ④vault.clear 留 lastEmail（await 化——S1 fire-and-forget 在此升级）→
  ⑤regenerate 两 home 无凭据版（S2/S34 已有）→ ⑥clearServerAuthCookie（已有）→ ⑦广播 `signed_out`。
  顺序断言测试（S1 曾列 I9 调用序断言，此处落地）。
- **Main 侧 spawn 门禁（S34 A-M5 移交）**：`CHAT_CREATE_SESSION`/`CHAT_RESUME_SESSION`/`SessionManager.create`
  本地分支（S2 trust 钩子同位）：flag on 且 `getState().kind !== 'authenticated'` → 拒绝（具名错误码
  `auth_required`，renderer 有既有报错卡通道）；flag off 零改动。logout 进行中（gate 置位）同拒。
- `src/shared/`：`AUTH_OPEN_ONBOARDING_EVENT` 常量（收敛 `aiclient:onboarding:open` 两处硬编码）+
  `authState` 类型 + queryKey 常量。

### S5b（renderer 侧）

- `Root.tsx` — 四 query 收敛：`onboardingState`+`onboardingCredentialsHealth` → 单 `authState`
  （flag on 走 `auth.getState` + `auth.stateChanged` 订阅失效即路由；flag off 走既有两 query——**门控双轨**）；
  `cliStatus`/`claudeRuntimeStatus` 保留。`credentials_invalid` → OnboardingShell(`register-email`) 且
  新 prop `reason:'expired'` 换文案（「登录已失效，请重新验证邮箱」）+ **预填 `lastEmail`**；
  `signed_out` → 常规登录文案。
- `src/shared/devFlags.ts` — **`SKIP_ONBOARDING_GATE` 收回（U2）**：常量退役，改
  `resolveSkipAuthGate(env)`：仅 dev（`import.meta.env.DEV`/主进程 `!app.isPackaged`）且
  `AICLIENT_SKIP_AUTH_GATE==='1'` 才旁路；**打包版负控断言**（打包条件下恒 false 的单测 +
  `shellSwitchStatic.test.ts:86` 的字面量断言同步改锚新形状）。`MainWindow.isAppMountedFor` 同源改读
  AuthStateService 快照（flag on）/维持现状（flag off）。
- `UserProfileCard.tsx` — 三态芯片：已登录（email）/ **失效可点重登**（destructive，点击发
  `AUTH_OPEN_ONBOARDING_EVENT`）/ 未登录可点登录；usage 报错不再一律「暂不可用」。
- `OnboardingView.tsx` — `reason` prop（客户端枚举，不进服务端错误码——S1 判别联合不动）+ 邮箱预填
  （初值来自 `auth.getState().lastEmail`，flag off 沿用旧 `onboarding.check` email）。
- `App.tsx` — `ONBOARDING_LIVE_CREDENTIALS_STATUS` 消费改订 `auth.stateChanged`（flag on）：
  `credentials_invalid` 即 dispatch 事件路由回登录（解「只弹 toast 不路由」）。

### 不做（本片）

收编导入与停双写（S6）；`checkCredentialsHealth` 物理清理（S6）；组件 render 级测试（D44 基建后补，
沿用纯数据形状测试惯例）；win/mac（test.4）。

## §2 关键契约

- **失效判定唯一权威**（I6 + E5 双臂 fixture）：`/api/auth/login` 响应 `401` 且 body `errorCode==='KEY_INVALID'`
  才是 rejected；其它一切（网络/5xx/404 HTML/307/业务 401）→ `remoteHealth:'unknown'` 不改 kind。
  probe **单飞**（in-flight 去重）+ 失败退避（同一 unknown 期不重复打）。
- **flag-off 等价**：renderer 双轨门控（flag off 走旧链零改动）；`SKIP_ONBOARDING_GATE` 收回是**无 flag**
  改动（dev 逃生舱语义与今天硬编码 true 的差异 = dev 默认要登录——U2 拍板知情；打包版今天该常量本就
  该是 false 的语义，收回即修正）。**注意**：off 轮「逐字节一致」对 renderer 门禁不成立（gate 收回无 flag），
  口径 = 「flag-off 且 `AICLIENT_SKIP_AUTH_GATE=1` 时行为与今天一致」；GUI 点验用真实登录轮。
- **登录态-门禁一致性**：`MainWindow.isAppMountedFor` 与 Root 读同一 Main 快照（测试：换服务两处同变）。
- **GUI 点验（开轮方式，本片执行）**：dev 起 app（不设 `AICLIENT_SKIP_AUTH_GATE`）→ 真实邮箱验证码登录
  （用测试邮箱 danyuan@jcdz.cc，码由用户转发）→ 验证：登录进入主界面 / claude 会话出字 / 终端 claude
  免向导 / codex 会话可创建 / UserProfileCard 用量 / 登出回登录页且托管 home 无 secret / 重登预填邮箱。
  CDP 驱动照 cdp-gui-verification-method 工法。

## §3 验证要点

1. AuthState 扩展：remoteHealth 迁移表 + probe 双臂 fixture（E5 字节）+ 单飞/退避 + markRejected 落盘
   `invalidatedAt`。
2. UsageService：flag on 读 vault（fs spy 断 `~/.codex` 零读）/ flag off 现状；失效上报仅在 cookie-login
   拒且 KEY_INVALID（负控：业务 401+login 200 不上报——E5 实测常态）。
3. I9 顺序断言 + spawn 门禁四臂（authenticated 放行 / invalid 拒 / logout 中拒 / flag off 零改动）。
4. Root 双轨：flag on 三态路由 + 预填；flag off 旧链测试零改动。
5. 门禁收回：打包恒 false 负控 + dev 逃生舱矩阵 + `shellSwitchStatic` 改锚。
6. 变异 ≥8 对（必含：probe 把网络错判 rejected / 业务 401 直接上报 / I9 序反转 / spawn 门禁漏 resume 臂 /
   打包版逃生舱放行 / 预填漏 lastEmail）。

## §4 需评审重点攻击的自设裁定

a) 失效信号只挂 usage 心跳不自建轮询（5 分钟粒度换实现简单）；
b) `checkCredentialsHealth` IPC 保留兼容（renderer 契约不动，S6 清）；
c) spawn 门禁只拦三入口（与 S2 trust 同位）不拦 agent-host 内部路径；
d) 门禁收回无 flag（U2 语义）而 Root 收敛有 flag——两层不同步的过渡态是否自洽；
e) GUI 点验清单七项是否足以充当 D47 全链首次真跑验收。
