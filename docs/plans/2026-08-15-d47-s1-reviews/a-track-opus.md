> D47 S1 规格 rev.1 双盲对抗评审 · A 轨（deep-reasoner/Opus，时序与所有权镜头，2026-08-15）。原文归档。

评审完毕。规格本文、母规格 §1/§3.C/§7、E6 spike、以及仓内 11 个声称事实点全部逐条核过。下面按三档给结论。

---

# BLOCKER（写码前必须改规格）

### B1. Vault 路径若在模块加载期解析，dev `AICLIENT_PROFILE` 隔离直接失效
- **规格位置**：§2.1 第 22 行「路径：`path.join(app.getPath('userData'), 'credentials', 'vault.json')`」——没写**何时**解析。
- **仓内证据**：`/home/dan/projects/ai-client/src/main/index.ts:132-135` 的 `app.setPath('userData', …)` 是**模块体可执行语句**，而 `/home/dan/projects/ai-client/src/main/index.ts:55`（`import { onboardingService } from './services/onboarding'`）和 `:35-40`（`./ipc`）是**静态 import**，ESM 语义下被提升到模块体之前求值。S1 §1.4 要把 `vault` 接进 `OnboardingService`，于是 `CredentialVault` 模块必然在 `setPath` 之前被求值。若照 `export const onboardingService = new OnboardingService()`（`OnboardingService.ts:651`）的既有写法做模块级单例并在构造里解析路径，dev 各 profile 会共用、并写进打包版的 userData。
- **仓内已有正确范式**：`/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:64-66` 的 `getStatePath()` 是**每次调用才解析**的函数。
- **改法**：规格里写死「vault 目录/文件路径必须惰性解析（首次读写时才调 `app.getPath('userData')`），禁止模块级常量捕获；单例创建走 `getCredentialVault()` 懒工厂」，并在 §3 增一条测试：模拟 `setPath` 后调用，路径跟随。

### B2. 「升格前读到密文」被折算成 `corrupt`，会把健康用户误判成 `credentials_invalid`
- **规格位置**：§2.1 第 34 行「读到损坏/解密失败：返回 `{status:'corrupt'}` … 由 AuthStateService 折算 `credentials_invalid`」+ §2.1 第 31-33 行「之前的读写走 `enc:"none"`」。
- **问题**：这两句合起来定义了一个错误状态机。文件里 `enc:"safeStorage"` 而当前 crypto 适配器是 none（升格前），payload 是 base64 串而非对象 —— 按现规格只能返回 `corrupt` → 母规格 §4 判定表把它打成 `credentials_invalid`（`docs/plans/2026-08-15-login-management-design-spec.md:121-126`）→ 触发重登。同一漏洞的第二个入口：Linux keyring 本次会话未解锁 / `isEncryptionAvailable()` 本次为 false，文件仍是上次加密的 —— 这不是「密文损坏」，是「暂时解不开」。
- **改法**：状态多加一枚可重试态，例如 `{status:'locked'}`（或 `'crypto_unavailable'`），规则写死：**`enc==='safeStorage'` 且 crypto 不可用 → 必须 `locked`，永不 `corrupt`**；只有 crypto 可用而 `decrypt` 抛错才是 `decrypt_failed`。AuthStateService 对 `locked` 不得推 `credentials_invalid`。变异验证补一对（enc:safeStorage + none 适配器 → 断言不是 corrupt）。

### B3. 升格前的 `save()` 会把已加密 vault 静默降级为明文
- **规格位置**：§2.1 第 31-33 行「之前的读写走 `enc:"none"`」+ §4 第 84 行「升格前发生 encrypt 请求 → 记 warn 并走 none」。
- **问题**：规格**明文祝福**了降级写。在 safeStorage 可用的机器上，任何一次窗前写入都会把 `vault.json` 从密文覆盖成明文，且只留一行 warn。这与母规格 §3.C「safeStorage 可用即加密」和 I1 的安全档位声明直接冲突；而且降级是**不可逆的**（下次读到明文，`enc:"none"` 就成了既成事实）。
- **改法**：改成 fail-safe：**升格前的 `save()` 一律拒绝**（记 warn + 返回 `{ok:false, reason:'crypto_not_ready'}`）。S1 里 vault 是影子写（§4 第 88 行自己承认），拒写零副作用；`clear()` 可放行（它只删不写密）。变异验证补一对：造一个升格前写入的实现，断言变红。

### B4. 「升格挂在哪个事件」没写，而最像的候选 `ready-to-show` 在本仓有实证会不触发
- **规格位置**：§2.1 第 32 行「Main 在 `MainWindow` 首窗 ready 后才把真 safeStorage 适配器升格进去」——「ready」是哪个事件未定。
- **仓内证据**：`/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:211-242` 有三重兜底（`ready-to-show` / `did-finish-load` / 5s timeout），注释 `:219-224` 明写「`ready-to-show` never fired 是这段防的那个 failure（BUG-2026-07-29-no-window）」。挂 `ready-to-show` = 在那类机器上**永不升格**，vault 终身明文且无诊断。
- **E6 证据只支持更弱的前提**：`docs/plans/2026-08-15-d47-s0-spikes/e6-safestorage-linux.md:125-134`，`probe-with-window.js` 是 `new BrowserWindow({show:false})` **构造之后**立刻调用即秒回 —— 需要的是「窗口已构造」，不是「已 ready」。
- **同时被漏掉的一半**：E6 结论 4（`:25`）建议「或补一个超时兜底」，规格全删了。而 `isEncryptionAvailable()` 是**同步**调用，挂死时无法在进程内加超时——只能结构性规避。
- **改法**：规格写死两件事：①升格闩挂 `app.on('browser-window-created')`（`/home/dan/projects/ai-client/src/main/index.ts:698` 已在 `openLocalWindow`（`:757`）之前注册），一次性、幂等、进程级单向闩；②升格**只安装适配器，不调用 `isEncryptionAvailable()`**；`available()` 在**首次 vault 实际用到时**惰性调用并缓存 —— 这样窗前挂死结构性不可能，也不拖慢启动。附justification：`window-all-closed → app.quit()`（`index.ts:829-831`）使零窗口态是终局，单向闩安全，不必做「窗口消失后降级」。

### B5. 照抄 `SharedSessionState.atomicWriteJson` 拿不到 0600/0700，且并发会互相踩
- **规格位置**：§2.1 第 22-23 行「写入 = tmp + rename 原子（参照 `SharedSessionState.atomicWriteJson` 但**显式传 mode**）」。
- **仓内证据**：`/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:48-53` —— tmp 名是**固定的** `${targetPath}.tmp`；`ensureDir` 用 `mkdirSync(dir,{recursive:true})` 不传 mode。
- **「显式传 mode」不够**：Node 语义下 `writeFileSync(path,data,{mode})` 的 mode **只在文件被创建时生效**；一次崩溃留下的 0644 `vault.json.tmp` 会被下次写入复用，mode 被静默忽略，rename 后 `vault.json` 就是 0644 —— 而 §3 测试 1 的「0600 断言」在干净临时目录里照样绿。`mkdirSync(mode:0o700)` 同理，对**已存在**的 `credentials/` 目录不改权限（`OnboardingService.ts:261` 已有同款隐患）。
- **改法**：规格写死：唯一 tmp 名（`vault.json.<pid>.<rand>.tmp`）+ 写后 `chmodSync(0o600)` 显式生效 + 目录 `mkdir` 后显式 `chmodSync(0o700)`；进程内所有 `save/clear` 串到一条 Promise 队列（防两窗同时登出/登录交叉）。测试补「预置一个 0644 的残留 tmp，再写，断言最终 0600」。

### B6. §2.3 的新响应类型在错误路径上根本不成立
- **规格位置**：§2.3 第 54 行 `OnboardingRegisterResponse = { ok, error?, data?: { user:{id,name}, attemptsLeft?:number } }` —— `user` 在 `data` 里是**必填**。
- **仓内证据**：`/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:127-129` 错误路径 `return result` 原样回服务端 body，此时 `data` 只有 `attemptsLeft` 没有 `user`；现有测试 `/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingService.test.ts:343` 就构造了 `data: { attemptsLeft: 4 }`；渲染层在 `/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:322` 正是从这条路径读 `attemptsLeft`。
- **改法**：改成判别联合 `{ok:true; data:{user:{id;name}}} | {ok:false; error; data?:{attemptsLeft?:number}}`，或把 `user` 标可选并在 §3 加一条「错误响应裁剪后仍带 attemptsLeft、不带 user」的用例。

### B7. 落库的 baseUrl 用哪一份没定，直接决定 S2 生成的 settings.json 会不会跟今天不一样
- **规格位置**：§2.1 第 30 行 payload `claude:{baseUrl,authToken}, codex:{baseUrl,apiKey}` ——未说是服务端原值还是归一化值。
- **仓内证据**：今天写进 `~/.claude/settings.json` 的是 `buildApiBaseUrl(...)` 的输出（`OnboardingService.ts:214-215` → `:542-555`），不是 `data.config.claude.baseUrl` 原值；`cchBaseUrl` 另有 `deriveCchBaseUrl`（`:557-563`，母规格 §3.C 已要求「落库不重算」）。三个值互不相同。
- **风险**：若 vault 存原值，S2 的 ClaudeHomeGenerator 生成出来的 `ANTHROPIC_BASE_URL` 与今天 legacy 文件不一致 → 员工路由改变，且这属于「双写期两份真相」的第二个漂移源。
- **改法**：规格写死「vault 存 `buildApiBaseUrl` 归一化后的 claude/codex baseUrl + `deriveCchBaseUrl` 的 cchBaseUrl」，并在 §3 加断言：同一次登录，vault 里的三个 URL 与写进 legacy 文件的字节一致。

### B8. flag-off 时登出不清 vault → 登出后密钥继续留盘（跨 flag 翻转的所有权空洞）
- **规格位置**：§1 第 13 行「`logout()` **flag on 时**追加 `vault.clear(...)`」。
- **场景**：flag on 登录（vault 已写）→ 重启为 flag off → 用户登出（legacy 清干净、cookie 清掉、UI 显示已登出）→ **vault 里的 authToken/apiKey 原样留在磁盘**。再翻回 on，AuthStateService 会读出 `authenticated`，而 legacy 说未注册（`OnboardingService.checkRegistration()`，`:29-45`），两份真相直接对撞。
- **对照**：母规格 I7「Vault 不被 flag-off 触碰」（`login-management-design-spec.md:26`）与 §6「回退分支必须退到安全态」（`:148-150`）在这里互相打架 ——「留着密钥」不是安全态。
- **改法**：当场裁定并写进规格。建议：**`clear()` 与 IPC 消毒同档，无 flag**（它属于「纯泄漏移除」方向，不会让 off 轮行为变差），I7 的措辞相应改为「flag-off 不得**写入/读取**vault，但登出必须清」。若维持 flag 门控，则必须把「off 轮登出留密钥」写进已知限制并加断言。

### B9. schema 缺 version 升级路径，且母规格的 `invalidatedAt` / 诊断位被悄悄换成 `receivedAt`
- **规格位置**：§2.1 第 26-30 行 schema。
- **对照母规格**：`login-management-design-spec.md:92-94` 的 schema 是 `{version, enc, lastEmail, identity{}, cchBaseUrl, claude{}, codex{}, invalidatedAt}` + 「`enc:"none"` + 0600 + **诊断位**」。S1 版丢了 `invalidatedAt`、丢了诊断位、多了 `receivedAt`，无一句说明。
- **要害**：`markRejected()` 在 §2.2 第 46 行被列为「预留接口（S5 调用）」，但 schema 没有可落盘的失效位 → S5 必然要 bump version，而 **version≠1 时怎么办规格没写**。默认实现多半会走「解析失败 → corrupt → 覆盖写」，等于用户回滚版本一次就丢凭据。
- **改法**：①补 `invalidatedAt` 与 `encReason`（`unavailable` / backend 名）诊断位；②写死版本规则：`version > 当前支持` → 返回 `{status:'unsupported'}`，**只读、禁止覆盖写**；`version` 缺失/非数 → `corrupt`；③变异验证补一对（未知 version 被覆盖写 → 断言变红）。

---

# MAJOR（应改）

**M1. §5 行「off 轮行为与今天逐字节一致」被自家 §2.3 证伪。** IPC 消毒无 flag（§1.3 / §2.3），renderer 收到的 payload 当场变窄 —— 这是**有意的单向收窄**，回退靠 revert 不靠 flag。断言口径要改写为「off 轮**磁盘写入与 legacy 文件字节**与今天一致」，并显式声明消毒不受 flag 保护、回退路径是 revert。母规格 §7 S1 行（`:167`）同处也要跟着改。

**M2. AuthStateService 的重算触发点缺失，`onChange` 无法实现。** §2.2 第 45 行只说「由 Vault 读取结果推导快照 + `getState()` + `onChange(cb)`」，但 S1 里没有任何东西通知它「vault 变了」。`getState()` 是每次读盘（S5 接进 Root 就是每帧同步 IO）还是缓存？测试 2「onChange 每迁移恰一次」现在没有可驱动的入口。**改法**：明确 `refresh()`/`recomputeFrom(vaultResult)` 由登录/登出路径显式调用（或 Vault 发 change 事件），并规定 `getState()` 只读缓存；`onChange` 返回退订函数。

**M3. I1「凭据唯一权威」在双写期的裁决没写。** §1 第 10 行称 Vault 是「凭据唯一权威的读写层」，但 §4 第 88 行又说「vault 是影子写」。真相是：S1 里 **legacy 仍是唯一读者**（`Root.tsx:140/162`、`MainWindow.ts:31`、`UsageService.ts:74-75` 全读旧文件），vault 零读者，AuthStateService 零消费者。这句要写死，并把它变成断言：**S1 不注册任何 auth IPC 通道、renderer 不得 import AuthStateService**（照 `/home/dan/projects/ai-client/src/renderer/App/__tests__/shellSwitchStatic.test.ts` 的静态扫描范式写）。否则「两份真相谁裁决」会在施工时被临场发明。

**M4. 单例所有权 + §1 交付清单漏文件。** 谁 `new` Vault、谁注入 crypto、谁执行升格，规格一句没写；而升格必然要改 `/home/dan/projects/ai-client/src/main/index.ts`，§1 的「做」清单里没有这个文件。**改法**：§1 补 `src/main/index.ts`（升格闩）与 `src/main/services/auth/index.ts`（electron-bound 单例工厂）两项；写死 Vault 是进程级单例、写操作串行化。

**M5. 「测试不 import electron」不可执行，真正的约束是文件切分。** §3 第 68-69 行的措辞管不住实现：如果 `CredentialVault.ts` 同文件里 `export const credentialVault = new CredentialVault({...})` 并 `import { app } from 'electron'`，测试 import 这个类就会连带求值 electron。另外仓内先例 `/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingService.test.ts:9-20` 是 `vi.mock('electron')` 跑通的，所以「不能 import electron」这句本身也不准确。**改法**：规格写死文件切分 —— `CredentialVault.ts`（纯模块，零 electron import，构造参数含 `baseDir` 与 `crypto`）/ `index.ts`（唯一 electron 绑定处，惰性工厂 + 升格 API），测试只 import 前者。

**M6. 裁剪必须是白名单构造 + 可导出纯函数。** §2.3 第 56 行只说「裁剪再回」。delete 式实现能通过 §3 测试 3 的「无 apiKey/config 键，深查」，却对服务端未来新增的 `data.token` 照漏；且若裁剪逻辑写在 `ipcMain.handle` 闭包里（`/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:59-64`），§3 测试 3 的负控（「把 handler 换成透传」）根本无法在单测里驱动。**改法**：规定导出纯函数 `toRendererRegisterResponse(full)`，**显式构造新对象**（白名单），handler 只调它；测试补一条「输入含未知额外字段 → 输出不含」。

**M7. redact 键名清单相对母规格 I2 已漂移，且签名包不住实际日志调用形态。** §2.4 第 62-63 行的清单**丢了 `cookie`**（母规格 I2，`login-management-design-spec.md:21` 明列）、**加了过宽的 `key`**（会误打 `sessionKey=` / `--key=` 这类调试信息）。另外 `redactSecrets(input: string)` 无法包住 `OnboardingService.ts:328` 的 `console.error(msg, error)`（第二参是对象）。**改法**：清单对齐母规格并对 `key` 加词边界或直接删；签名改 `(...args: unknown[]) => unknown[]` 或补一个 `redactArgs`。

**M8. dev.js 强制 `AICLIENT_MANAGED_CREDENTIALS=0` 会让 S1 在 dev 完全没法开轮验证，且注入点有一条早退路径会漏。** 母规格 §3.C（`:98-99`）要求 dev 强制 0，但那条的动机是防 S2 的全局 `CLAUDE_CONFIG_DIR` 盖掉 dev 隔离；S1 只写一个 vault 文件，无此风险。若 S1 就照做，flag-on 轮只能靠打包版验。另注意 `/home/dan/projects/ai-client/scripts/dev.js:184-189` 有一条 `return process.env;`（`dev.env` 缺失 + `--allow-local-credentials`）的早退，任何注入必须两条路径都覆盖。**改法**：dev.js 改成「缺省 `'0'`，允许 shell 显式覆盖」，并在 S2 再收紧；规格里写清 flag **只在 Main 进程读、renderer/preload 零感知**，读法照 `resolveCodexEnabled`（`/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:42-44`，**每次调用读 env、不在模块加载期捕获**）。

**M9. 本分支登录链在运行时不可达，消毒改动与双写无法 GUI 点验。** `/home/dan/projects/ai-client/src/shared/devFlags.ts:10` `SKIP_ONBOARDING_GATE = true`，`/home/dan/projects/ai-client/src/renderer/Root.tsx:129` 直接 `return <SkippedOnboardingApp />`，`RootWithOnboardingGate`（唯一挂载 `OnboardingView` 的分支）是死码；`MainWindow.ts:30` 同样短路。§3 的验证计划对此只字未提。**改法**：§3 补一节「开轮方式」：点验时临时把 `SKIP_ONBOARDING_GATE` 置 false（注意 `shellSwitchStatic.test.ts:86` 断言的是源码字面量，置 false 不会红），并说明点验后必须还原、还原本身进门禁清单。

**M10. 母规格 S1 行的两条断言在 §3 没有对应用例。** `login-management-design-spec.md:167` 要求「日志无 secret 子串」和「off 轮不写 vault」。§3 只有 redact 的单元用例（不等于端到端日志断言）和「现有 vitest 全量绿」（不等于「vault 文件不存在」）。**改法**：补两条 —— ①一次完整 `verifyAndRegister`（fake fetch 返回真形状 token）后，捕获的 console 输出里断言 token 明文子串出现 0 次；②flag off 跑一次 `verifyAndRegister`，断言 `<userData>/credentials/` 目录不存在。

**M11. `enc:"none"` 的诊断位被删。**（见 B9 第二半，若不并入 B9 则单列）没有 backend/原因字段，线上出现明文降级时无法归因。

**M12. 0600/0700 断言在 Windows 上必红。** §3 测试 1「0600/0700 断言」在 win32 上 `chmod` 语义不同（只映射只读位）。CI 目前不跑 vitest（`.github/workflows/build.yml` 只有 build），但本地门禁在 Windows 机上会红。**改法**：断言加 `process.platform !== 'win32'` 守卫，并在 §4 登记「Windows 的落盘保护依赖 userData ACL，本轮不额外加固」。

**M13. `clear()` 的顺序与失败语义未定。** §4 第 87-88 行只定义了 `save` 的顺序（legacy→vault）和失败语义，`clear` 没有。三个未定点：①顺序（建议与 save 对称：先 legacy 后 vault）；②vault 文件不存在时必须 no-op，**不得**创建一个只有 `lastEmail` 的空壳；③`clear` 抛错会让 `OnboardingService.logout()`（`:179-188` 的 try/catch）返回 false，进而 `/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:125-128` 打 warn 并把 false 回渲染层 —— 即 vault 的问题会污染 legacy 登出的成功语义。应规定 `clear` 失败只记日志、不改 `logout()` 返回值。

---

# MINOR（施工时注意）

- **m1.** §2.3 第 51 行引的 `OnboardingView.tsx:707` 是**守卫**（`registerResult.data?.user &&`），真实读取在 `:711` 且只用 `user.name`、不用 `user.id`。结论不变（`apiKey`/`config` 确实零消费者，全仓 grep 复核过：renderer 侧仅 `:180/:313-322/:686/:707-711` 触碰该响应），但引用行号建议写成 `707/711`。
- **m2.** 新类型的 `error?` 必须保留 `OnboardingErrorCode | string` 联合（`src/shared/types/onboarding.ts:47`），否则 `describeOnboardingError`（`OnboardingView.tsx:42-56`）签名对不上。
- **m3.** 「`OnboardingRegisterResponse` 改注释标 Main-only」是弱守卫 —— 它仍在 `src/shared/types/onboarding.ts:45` 且由 `@shared/types` 再导出，renderer 随时可 import。更硬的做法是把全量版**搬到 main 目录**（结构性不可达），shared 只留裁剪版。grep 测试要连 `src/preload`（`:777` 当前正引用它）一起扫，并排除测试文件自身；范式照 `src/renderer/App/__tests__/shellSwitchStatic.test.ts:26-55`。
- **m4.** `receivedAt` 与 legacy 的 `registeredAt`（`OnboardingService.ts:167`）命名漂移，S6 收编时会两边对不上，建议统一。
- **m5.** `lastEmail`（明文层）与 `identity.email`（密文层）双份：规格要写死「`save()` 必须同时覆盖 `lastEmail`」，并声明 S5 的「预填 lastEmail」读哪一份 —— 现在同一事实还有第三份（`~/.aiclient/settings.json` 的 `onboarding.email`，`OnboardingService.ts:163-168`）。
- **m6.** `onChange(cb)` 需返回退订函数（S5 接 Root 时不返回必漏）。
- **m7.** vitest 无需改：`/home/dan/projects/ai-client/vitest.config.ts:13` 的 `include: ['src/**/__tests__/**/*.test.ts']` 已覆盖 `src/main/services/auth/__tests__/`。建议把这句写进规格，免得施工时再查一遍。
- **m8.** 崩溃窗：legacy 写成功、进程在 vault.save 前挂掉 → 下次启动两边不一致。S1 里因 vault 零读者而惰性无害，登记为已知瞬态即可（S6 收编负责收口）。
- **m9.** E6 只覆盖 Linux（spike `:146-151` 自己登记 Windows/macOS 待测）。升格闩在 win/mac 上无害但同样未验，规格 §4 补一行。
- **m10.** 变异验证 6 对建议扩到 8 对：加「enc:safeStorage + 无 crypto 判成 corrupt」（咬 B2）和「升格前 save 放行」（咬 B3）；现有的「corrupt 时 throw」保留。
- **m11.** `autoStartHapi()`（`src/main/index.ts:752`）确实早于 `openLocalWindow()`（`:757`）执行，说明**窗前代码路径客观存在**；S1 里没有任何窗前 vault 读者只是巧合（IPC 只能由渲染层发起），不是保障 —— B4 的单向闩 + B3 的窗前拒写就是把这个巧合变成保障。

---

## 判语

**若只改 B1~B9，本规格可以开工** —— 九条 blocker 都是「一句话写死语义」级别的规格补丁，改完之后时序与所有权链是闭合的：路径惰性解析 → 窗后单向闩 + 惰性 `available()` → 窗前拒写 / 密文读回 `locked` → 唯一 tmp + 显式 chmod → 双写口径与失败语义钉死。

但要诚实提醒：**M5（测试文件切分）和 M9（本分支登录链不可达）会在施工第一天就卡住**——前者决定第一条 Vault 测试能不能写出来，后者决定消毒改动能不能被点验。建议这两条随 blocker 一起改，M2（AuthState 重算触发点）紧随其后，否则 §3 的测试 2 无法落地。