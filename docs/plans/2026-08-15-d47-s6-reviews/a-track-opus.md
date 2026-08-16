> D47 S6 规格 rev.1 双盲对抗评审 · A 轨（deep-reasoner/Opus，迁移语义与状态机镜头 + 真机取证，2026-08-15）。原文归档。

仓内逐点核对完毕（含真机 legacy 现场取样）。结论先行：**这一片按 rev.1 原文开工会翻车**，主因不是设计方向错，而是「收编源矩阵」与本仓/本机实况脱节、守卫锚点选错、验真步骤按字面不可实现。

---

# BLOCKER

## B1 收编四源里两源在真机上不存在／形状不同，硬要就等于收编必败

规格位置：§1.1「源：…`~/.codex/auth.json` OPENAI_API_KEY + `~/.codex/config.toml` `[model_providers.jyw].base_url`」＋守卫「codex key 必须与 claude token 相等」。

实测本机（= 唯一的存量收编源机器）`~/.codex/config.toml`：顶层 `model_provider = "OpenAI"`，provider 表是 **`[model_providers.OpenAI]`**，`base_url = "https://cch-jyw.pipidan.qzz.io/v1"`；**没有 `[model_providers.jyw]` 表**。原因就在 GUI 报告附记（`docs/plans/2026-08-15-d47-gui-checklist.md:50-56`）：`rmSync` 整删后靠 `.bak` 复原，复原回来的是用户自己手改的版本（200+ 行 developer_instructions／features／projects 信任表／mcp_servers）。

同理 `~/.codex/auth.json` 的 `OPENAI_API_KEY` 在任何一台"顺手配过个人 OpenAI"的机器上都可能≠claude token；`codex login`（ChatGPT OAuth）形态的 auth.json 甚至根本没有这个字段。

后果：按字面实现，"jyw 表缺失"或"codex key 不等"任一成立即不收编 → 目标人群整片重登，本片存在意义归零。更隐蔽的一层：`getManagedCchProbeTarget` 用的是 **codex.apiKey**（`src/main/services/auth/probeTarget.ts:16-25`），收编若把一把无关的个人 key 塞进 `codex.apiKey`，"一次 probe 验真"直接变哑弹（target 拿到的是错 key，401 但 errorCode 不是 KEY_INVALID → 判 unknown）。

改法：硬源收缩为 **claude 两键 + legacy registered** 两项；`codex.baseUrl` 缺省由 claude baseUrl 推（§5 已代码定论同 base+`/v1`）；`codex.apiKey` 按同 key 口径取 claude token，`~/.codex/auth.json` 仅作旁证（相等→记一条 diagnostic；不等→**不是**否决项，或明确裁定否决并写进已知限制人群）。`[model_providers.jyw]` 降为可选旁证，不得作为必需源。

## B2 host 守卫锚点选错，对 2026-04-27 之前的老机器系统性误杀（正是要救的人）

规格位置：§1.1 守卫「claude baseUrl 的 host 必须与 legacy `onboarding.serverUrl` 的 host 一致」；§1.1 源里把 `onboarding.serverUrl` 当 `cchBaseUrl` 来源。

commit `2354a6b`（2026-04-27）之前，`onboarding.serverUrl` 存的是 **onboarding 服务地址**；该 commit 才改存 `deriveCchBaseUrl()` 推出的 **cch 网关**（`src/main/services/onboarding/OnboardingService.ts:169-179` 与 `:748-754`）。于是老机器上：`ANTHROPIC_BASE_URL=https://cch-jyw.…/v1`，`onboarding.serverUrl=https://onboarding-jyw.…` → **host 不等 → 守卫拒收编**。越老的装机（最典型的"存量员工"）越必被误杀。反向也坏：万一放行，收编进 vault 的 `cchBaseUrl` 就是 onboarding host → probe POST 到不存在的 `/api/auth/login`（404 HTML → 判 `unknown`，`AuthProbeScheduler.ts:38-56`），§1.4 迁过去的用量卡也一起废。

另有两处归一化漏洞：只比 `host` 会让 `http://` 与 `https://` 同 host 放行（明文降级）；`new URL()` 对无 scheme 的手改值直接抛，规格没写兜底。

改法：① `cchBaseUrl` **一律由 claude baseUrl 去 `/v1` 推**（复用 `deriveCchBaseUrl`），legacy serverUrl 只作旁证；② 守卫锚点改成「公司网关集合」＝ `__ONBOARDING_SERVICE_URL__` 的可注册域（`pipidan.qzz.io`）∪ legacy serverUrl 的 host，母规格 §6 原话就是"匹配公司网关"，规格把它窄化成"与 legacy serverUrl 一致"是改了裁定；③ 比 **origin**（scheme+host+port）不比 host；④ parse 抛错＝不收编。

## B3 验真步骤按字面不可实现，且把网络串进启动链

规格位置：§1.1「→ `refresh()` → **一次 auth-probe 验真**（拒绝 → `markRejected` …）→ 写 marker」，§4 裁定 a。

三个硬事实：
1. `AuthProbeScheduler.probeOnce(): Promise<void>` **不回传分类**，`markRejected()` 在 `actOnClassification` 里是 `void` 出去的（`src/main/services/auth/AuthProbeScheduler.ts:207-217`）——await 它既拿不到"拒/未拒"，也不保证 `markInvalidated` 已落盘。规格链条无对应 API。
2. 这一发 probe **本来就会自动打**：收编里的 `refresh()` → `authenticated` → `onChange` 桥（`src/main/ipc/auth.ts:53-60`）→ `handleAuthStateChange` 进态即 `probeOnce()`（`AuthProbeScheduler.ts:126-136`）。规格是在重复造轮子。
3. 插入点（`src/main/index.ts:744` `openLocalWindow` 与 `:750` `regenerateFromVault` 之间）时窗口已构造、renderer 已在加载，而 `auth.getGateSnapshot` 是同步 handler（`src/main/ipc/auth.ts:75-97`）：收编未完成时它按 `absent` 算出 `signed_out/lastEmail:null` → `resolveGateDecision` 走 **first_run + cli-check**（`src/shared/authGate.ts:78-80`）→ 用户看到"首次运行 CLI 检查"页并触发 detectCli，收编完成后才被 `stateChanged` 拉回（`src/renderer/Root.tsx:164-170`）。离线机器上 `net.fetch` 无超时，这个闪现能挂到 Chromium 连接超时为止。

改法（同时解掉 a 的自洽性）：收编 = **guards + `save()` + marker**，无网络、无自建 regenerate、无自建 probe；`regenerate` 交回既有 `index.ts:750`，`refresh()` 交回 `:761`，验真交回 S5 既有 probe 链；`auth.getGateSnapshot` handler 前置 `await` 一个收编 latch（handler 本就是 async），消掉闪现。并显式写死一条：**probe 拒绝后绝不回滚已写入的 vault**（回滚＝vault 回到 `absent` + 无 marker ＝ 每次开机重收编重拒的真死循环；按现设计没有该循环，正是因为收编后 vault 是 `ok`/`rejected` 而非 `absent`，这一点必须写进规格，否则实施者"清理失败残留"就把它造出来）。

## B4 §1.5 描述的东西在仓里不存在，且把 S5 点名交办的"清"改成"保留"未登记

规格位置：§1.5「`checkCredentialsHealth` 的 flag-on 折算分支保留（renderer 契约不动），本片只加注记」。

`OnboardingService.checkCredentialsHealth()`（`OnboardingService.ts:769-819`）**没有任何 flag 分支**，纯读 `~/.claude/settings.json` + `~/.codex/auth.json`；折算在 `src/main/ipc/auth.ts:27-37` 的 `deriveLegacyAuthState`，且只在 `!managed` 臂被调用（`auth.ts:78-85`）。而 S5 规格白纸黑字："`checkCredentialsHealth` IPC 兼容折算**至 S6 清**"（`2026-08-15-d47-s5-authstate-spec.md:136-137`）。

停双写后，这个方法在 flag-on 机器上会恒定报 degraded（legacy 永不再写），任何新消费者都会被误导。改法：二选一并写清——退役 `ONBOARDING_CHECK_CREDENTIALS_HEALTH` 通道（连带 `src/preload/index.ts:781-782`），或在方法体加 flag 分支并定义返回口径。停在"加注记"是把 S5 的交办丢了。

## B5 停双写让 S1 §3-1g 承重断言变成不可满足，§3 没有处置 → 实施者最省事的绿灯是删掉它

`src/main/services/auth/__tests__/vaultIntegration.test.ts:91-119`：flag-on 跑真 `verifyAndRegister` 后读 `~/.claude/settings.json`、`~/.codex/config.toml`、`~/.aiclient/settings.json` 与 vault 逐字段比对——停双写后前两个文件不存在，`readFileSync` 直接抛。这是仓内**唯一**"vault 推导 == legacy 推导"的交叉证明。

同文件 §3-5a 的 token 不入日志证据（`:120-152`）会因 `writeClaudeConfig` 的 redact 日志（`OnboardingService.ts:439-443`）不再执行而**丢掉发射半边**（本仓变异纪律：pin 必须仍会在变异下变红）。

改法：§3 增两行处置——§3-1g 改锚为「vault payload ↔ `generateClaudeSettings()` / `generateManagedCodexConfigToml()` 纯生成物」比对；§3-5a 补一轮 flag-off 保住发射半边。

---

# MAJOR

**M1 「守卫不过 → 走登录页（预填 legacy email）」不可达，且与母规格 §6 冲突。** `absent` 映射死给 `lastEmail: null`（`AuthStateService.ts:75-76`），`deriveOnboardingEntry` 于是走 `first_run` + `cli-check` + 空预填（`shared/authGate.ts:78-80`）——被守卫拦下的老员工看到的是"首次运行装 CLI"，比重登更糟。母规格 §6 要求的是 `credentials_invalid: migration_incomplete` + 预填，而 `AuthState` 的 reason 只有 `rejected|corrupt|decrypt_failed`（`src/shared/types/auth.ts`）。改法：加第四 reason（三 reason 已被统一折成 `'expired'`，`authGate.ts:74-90`，加一臂零成本），或在 IPC 层用 legacy email 兜底预填；无论哪种都要登记为对母规格的修订。

**M2 c 裁定必须把 `~/.aiclient/settings.json` 切出去。** `performLogoutSequence` 无条件调 `onboardingService.logout()` 且用它的布尔当返回值（`src/main/ipc/onboarding.ts:113-119`），而 `logout()` 干三件事：`removeClaudeCredentials` / `removeCodexConfig` / `mergeSettingsPatch({registered:false})`（`OnboardingService.ts:347-359`）。flag-on 只该跳过前两件：`registered:false` 是**收编触发器的第二道闩**（§1.1 要求 `registered===true`），也是 flag-off 回退的门禁信号（`ipc/auth.ts:27-37`）。若连它也跳过，则"登出后 userData 丢失/换 profile 首启"会被静默收编回已登录——§2 自称的第一承重线（登出优先）就此失守。§1.2 现在的"不再碰 legacy 文件"必被读成连 `~/.aiclient` 一起跳，必须改写。

**M3 §1.4 的前提是错的。** `saveOnboardingState`（`OnboardingService.ts:174-182, 720-727`）不在 §1.2 点名的三写手内，停双写后 `onboarding.serverUrl` **仍然每次登录被写**。动作（flag-on 走 `vault.cchBaseUrl`）仍对，理由要改；且 §1.4 漏了准入门：`UsageService.getStats` 开头 `if (!onboarding.registered || !onboarding.serverUrl)`（`src/main/services/usage/UsageService.ts:205-208`）flag-on 也走这条 legacy 门，要么同迁到 AuthState，要么明确保留并说明。

**M4 marker 三处含糊。** ① "成功"未定义：probe 拒绝算不算？§1.1 括注"不算收编失败"与末条"失败…不写 marker"互殴 → 钉死为「`save()` 返回 ok 即写」，与网络结果解耦。② 位置：放 `<userData>/credentials/` 与 vault 同生共死，而 §2 宣称它覆盖"vault 后来被清"——`clear()` 留壳产出的是 `cleared` 不是 `absent`（`CredentialVault.ts:389-426, 228-234`），根本走不到收编分支；真正需要 marker 的是"人工删 vault.json"，而同一次操作会连 marker 一起删 → 移到 `<userData>/.adopted-v1`。③ userData 是 profile 化的（`src/main/index.ts:139`），marker/vault 随 profile 走而 legacy 文件全局唯一：A profile 登出，B profile 首启照收——必须登记。

**M5 §1.3 外科删除以字面 `jyw` 为锚，在真机上是空操作，且删 `model_provider` 行的后果未裁。** 本机表名是 `OpenAI`（见 B1），app 写手只认 `jyw`（`OnboardingService.ts:582-598`）。断言矩阵必须覆盖"表名非 jyw"这一格。另：删掉 `model_provider = "jyw"` 行 → codex 静默回落 api.openai.com（GUI 事故里 401 的那条路）；留行删表 → 硬报错。二者选一并写进已知限制。建议：只摘表；仅当 `model_provider` 恰为 `"jyw"` 时才删该行；`auth.json` 只删 `OPENAI_API_KEY` 保留文件与其余字段（这条规格已对）。

**M6 keyring 锁定时收编会静默落明文 vault。** `save()` 在 `isCryptoAvailable()===false` 时静默写 `enc:'none'`（`CredentialVault.ts:304-321`），调用方无从得知。真实登录发生在有人在场的时刻，收编发生在**无人值守的开机瞬间**——恰是 keyring 最可能未解锁的时刻，而 S1 的信条是"拒绝写明文优于静默降级"（`CredentialVault.ts:10-19`）。规格未裁。至少要：收编前拿到 crypto 可用性（需要给 vault 加一个只读能力查询），不可用时**不写 marker、下次再来**（Linux 永久不可用的机器按母规格 U-默认接受明文，需在规格里分平台写清）。

**M7 flag-off 登出等价性破坏的申报面没点名具体桩。** `src/main/services/onboarding/__tests__/OnboardingService.test.ts:286-287` 明确断言登出后 `~/.codex/config.toml` 与 `auth.json` **不存在**。§1.3 说了"登记非等价"却没说要改哪条、改成什么。新断言应含：文件仍在 + `OPENAI_API_KEY` 消失 + 用户自有键/表逐字节不变 + 非 jyw 表零触碰。

**M8 分发纪律解除的证据门槛太低，且本机已不具备做证据的条件。** baseline 写的解除条件是"S6 收编落地并在 as-built 记录解除"（`docs/plantree/baseline/test-and-release-gates.md:79`）。但收编是一次性不可逆迁移，而 D47 的现成教训正是"3874 例单测 + 变异 10/10 都没抓到接线缺席"（`gui-checklist.md:30-34`）。应把解除条件加一条真机证据：带真实 legacy 凭据的机器 flag-on 冷启动零重登。**注意**：本机现在做不了这个证据——实测 `~/.aiclient/settings.json` 的 onboarding 只剩 `{registered:false, email}`（serverUrl 已被浅合并抹掉），`~/.claude/settings.json` 的 `env` 是空对象 `{}`（GUI 登出实测留下的），`~/.codex/config.toml` 无 jyw 表。要先做一次 flag-off 登录把 legacy 状态造回来，§3 里没有这一步。

---

# MINOR

- **m1** §3 写"收编五守卫矩阵（absent/cleared/marker/registered/host）"，但 §1.1 自己列了第六条（codex key 相等）；变异 ③ 也只咬 host。矩阵与守卫数对不上。
- **m2** 裁定 d 里的"或 adopt 后首次 probe 200 时回填 id"不可实现：probe 只读 status/bodyText 做分类（`AuthProbeScheduler.ts:191-204`），不解析 user id → 删掉这个"或"。另：`identity.userId` **全仓零消费者**（只有 `identity.email` 被读，`AuthStateService.ts:72`），`validateEnvelopeShape` 也不校验 payload 内部（`CredentialVault.ts:101-129`）——"schema 允许？"可以当场定论为"纯 TS 类型放宽，零运行时/零迁移成本"，不该留问号。
- **m3** 必须写清收编读的是 **OS home 的 `~/.claude`**，不是 `$CLAUDE_CONFIG_DIR`——后者在相 ① 已被改写成托管 home（`managedClaudeHomeStartup.ts:70-73`），dev 下还被 `scripts/dev.js` 指到隔离目录。实施者复用任何 env-aware helper 就会"自我收编"（把 dev seed 生成的托管 settings 当 legacy 收编回 vault）。
- **m4** 收编入口应放在 `managedClaudeHomeStartup.ts` 的同一 flag 闩之后（或自带 `resolveManagedCredentialsEnabled()` 前置），否则 flag-off 会多出对 `~/.aiclient`/`~/.claude` 的读 IO，破坏 S5「flag off 短路在 `vault.read()` 之前、零 FS IO」的同款纪律（`AuthStateService.ts:157-161`）。
- **m5** §1.5 的"兼容清理"可顺手清真死面：`ONBOARDING_LIVE_CREDENTIALS_STATUS` 主侧已退役（`src/renderer/App.tsx:169` 注释），但 `src/preload/index.ts:801-802` 与 `src/shared/types/ipc.ts:359` 仍在。
- **m6** 收编取值要按"缺 `env` 键／`env` 为空对象／值为空串"三态判——真机现状就是 `env: {}` 且同文件里满是用户自有键（hooks/statusLine/enabledPlugins…）。
- **m7** S5 §0-3 的浅合并修复只补了 email，`serverUrl`/`registeredAt` 仍被登出抹掉（`OnboardingService.ts:354`；`mergeSettingsPatch` 是 `{...base,...patch}` 顶层浅合并，`src/main/ipc/settings.ts:69-75`；本机实测已只剩两键）。本片既然要动 logout，顺手补齐 re-paste。
- **m8** 裁定 e 的连带改判点不止一处：S34 规格 `:44`、`:91`、`:142`、`:164` 四处 + 母规格 §7 的 S4 行都把"删投影链"记在 S6/S4；§1.5 只说"修正 S34 的归属注记"（单数）。且"退役批"目前不是注册项，需给 D 号/roadmap 行，否则成孤儿欠账。
- **m9** c 裁定带来的用户可感语义：flag-on 登出后公司 token 仍留在 `~/.claude/settings.json`，app 外终端照常可用。这是 U1 拍板的结果，但登出 UI 文案应当明说，否则在共用/丢失机器场景是"以为登出了"的安全惊喜。

---

# §4 自设裁定 a~e 判定

| # | 判定 | 依据与收窄 |
|---|---|---|
| **a** 收编在 `regenerateFromVault` 之前跑 | **半真** | 位置对（必须在 `index.ts:744` 起窗之后——crypto 升格前提，且在 `:750` 之前），但"adopt→save→regenerate 一体"的理由与 §1.1 自带的链（自建 regenerate + refresh + probe）自相矛盾，会造成双重 regenerate（codex sidecar 连写两次 `source:'startup'`）。收窄为：收编只做 guards+save+marker，regenerate/refresh 交回既有 `:750`/`:761`；并给 gate 快照加等待 latch（B3）。 |
| **b** `cleared` 不收编 + marker 只成功后写 | **真但不充分** | `cleared/absent` 分家是对的、也确实是承重线（`CredentialVault.ts:228-234`、`AuthStateService.ts:75-78`）。但"marker 只成功后写"的"成功"未定义（M4①）；marker 位置与 vault 同生共死使 §2 的幂等承诺落空（M4②）；保护范围只到单个 profile（M4③）；且登出优先真正的第二道闩是 legacy `registered:false`，而 c 正要把它模糊掉（M2）。 |
| **c** flag-on 登出不再清 legacy | **半真，必须拆成两半** | 对 `~/.claude`/`~/.codex` 成立（U1 + GUI 真机事故实锤，`gui-checklist.md:50-56`）；对 `~/.aiclient/settings.json` 的 `registered:false` **不成立**，那是收编触发闩 + flag-off 回退门禁信号。落地形态：继续调 `onboardingService.logout()`（其返回值是 `performLogoutSequence` 的返回值，`ipc/onboarding.ts:116-119`），只把 `removeClaudeCredentials`/`removeCodexConfig` 两个私有方法加 flag 门控。与 I9 七步不冲突（⑤内部实现变更，⑥ 的 serverUrl 仍在 `:82-83` 提前捕获）；冲突只在测试桩：`OnboardingService.test.ts:286-287` 与 `OnboardingServiceManagedHome.test.ts:223` 需重写/补 flag-on 臂。 |
| **d** `identity.userId` 置 null 的 schema 放宽 | **真，且可以直接定论** | 零运行时校验触及 payload 内部（`CredentialVault.ts:101-129`），全仓零消费者（`AuthStateService.ts:72` 只读 email）。规格里的问号该改成结论；"或 probe 200 回填 id"分支不可实现，删除（m2）。 |
| **e** 投影链删除归属改判到退役批 | **真** | flag-off 回退确实仍走 fallback 投影链（`2026-08-15-d47-s34-codex-terminal-spec.md:39-44`），而本片 flag 默认仍 off，物理删除会拆掉回退目标，违反母规格裁定 #3「回退分支必须退到安全态」。但连带修订面被低估（m8），且退役批需注册。 |

---

# 开工判语

**不予开工，退回 rev.2。** 方向（收编＋停双写＋外科修复＋纪律解除）成立，但五条 blocker 里有三条会直接决定代码形状：收编源与守卫锚点（B1/B2）决定收编模块的输入契约，验真与插入点（B3）决定它是同步小函数还是异步网络链——这三条不定，写出来的就是返工件。

rev.2 必须补齐的最小集：
1. **收编输入契约表**：四源逐项标「必需/旁证/推导」，写清缺失与形状异常（`env:{}`、表名非 jyw、serverUrl 属旧口径、codex key 不等）各自的判定；`cchBaseUrl` 改由 claude baseUrl 推导。
2. **守卫锚点改为公司网关集合 + origin 比较**，并给出 URL 解析异常的兜底；守卫不过的落地状态显式选定（第四 reason 或 IPC 层兜底预填），并登记为对母规格 §6 的修订。
3. **收编 = guards + save + marker**，无网络；验真复用 S5 既有 probe 链；写死"probe 拒绝不回滚 vault"；`auth.getGateSnapshot` 等待收编 latch。
4. **c 裁定切开 `~/.aiclient`**；marker 移出 `credentials/` 且写入时机绑 `save()` ok；crypto 不可用时的收编策略分平台裁定。
5. **测试处置清单**：点名 `vaultIntegration.test.ts:91-119`（改锚）、`:120-152`（保发射半边）、`OnboardingService.test.ts:286-287`（外科断言重写）、`OnboardingServiceManagedHome.test.ts:223`（补 flag-on 臂）；守卫矩阵补第六条（codex key）与"表名非 jyw"格。
6. **分发纪律解除加一条真机证据门槛**，并在 §3 前置一步"用 flag-off 登录把本机 legacy 状态造回来"——当前本机的 legacy 现场已被 GUI 登出事故清空，没有这一步就没有收编 happy path 的任何真机证据。

（另附一条与本片无关但同源的既有缺陷：登出的浅合并仍在抹 `serverUrl`/`registeredAt`，`OnboardingService.ts:354` + `src/main/ipc/settings.ts:69-75`，实测本机已中招。既然要动 logout，建议一并补。）