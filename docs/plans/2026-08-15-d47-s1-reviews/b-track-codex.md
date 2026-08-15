> D47 S1 规格 rev.1 双盲对抗评审 · B 轨（Codex，证据与可验证性镜头，2026-08-15）。原文归档。

## 1. blocker（会导致返工或测试假绿的问题，必须在动工前修复）

### 1.1 `[规格与仓库不一致 + 规格设计缺陷]` 拟议的 Client Response 类型无法表示真实的验证码失败响应

- 规格原文位置：S1 §2.3 第 51–58 行把 Client Response 固定为 `data?: { user:{id,name}, attemptsLeft?:number }`，同时要求保留错误路径的 `data.attemptsLeft`；§4 第 86 行却仍把 `attemptsLeft` 的位置列为“施工时核对”的开放点。
- 仓内证据（file:line）：真实位置已经可以确定：全量类型把 `attemptsLeft` 放在 [`OnboardingRegisterResponse.data.attemptsLeft`](/home/dan/projects/ai-client/src/shared/types/onboarding.ts:45)，其中 `data.user/apiKey/config` 当前均为必填（第 48–56 行）；但既有测试明确构造 `{ok:false,error:'CODE_INVALID',data:{attemptsLeft:4}}`，没有 `user/apiKey/config`（[`OnboardingService.test.ts:338`](/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingService.test.ts:338)）；服务在失败时原样返回该对象（[`OnboardingService.ts:127`](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:127)），renderer 直接读取 `result.data?.attemptsLeft`（[`OnboardingView.tsx:322`](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:322)）。这说明当前全量类型本身已经不严谨，而拟议 Client 类型仍然重复了同一问题。
- 建议改法：施工规格先把 Main-only 与 Client Response 都改成判别联合，例如成功臂 `{ok:true; data:{user:{id,name}}}`，失败臂 `{ok:false; error?; data?:{attemptsLeft?:number}}`；IPC sanitizer 必须分别处理两臂。删除 §4 第 86 行的开放措辞，明确 `attemptsLeft` 就在失败响应的 `data` 顶层，并加入“仅有 attemptsLeft、没有 user”的失败 fixture 作为正控。

### 1.2 `[规格设计缺陷]` IPC 消毒负控没有可导入的真实生产接缝，按现规格很容易测试到“规则副本”而不是 handler

- 规格原文位置：S1 §3 第 68–75 行要求 node 环境测试“只 import 纯模块、不 import electron”，同时要求“全量响应进→裁剪版出”以及“把 handler 换成透传实现，断言测试变红”。
- 仓内证据（file:line）：真实 handler 内联在 [`registerOnboardingHandlers()`](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:47) 的闭包里，并于第 59–63 行直接返回 `onboardingService.verifyAndRegister(...)`；该模块第 7 行静态 import `electron`，还静态 import 多个主进程单例，因此不能同时满足“测试真实 handler”和“不 import electron”。仓内既有纪律明确指出：带模块级运行副作用的入口不能被 Vitest 直接 import，应把可测生产逻辑拆成纯模块并注入依赖（[`agentSupport.ts:5`](/home/dan/projects/ai-client/src/agent-host/agentSupport.ts:5)），对应测试只 import 拆出的纯模块（[`agentSupport.test.ts:13`](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:13)）。
- 建议改法：规格必须要求新增独立纯模块，例如 `createVerifyAndRegisterHandler(service)`，其真实实现执行 `sanitize(await service.verifyAndRegister(...))`；`main/ipc/onboarding.ts` 只负责把该返回函数注册给 `ipcMain.handle`。Vitest 用含完整 `apiKey/config/user/attemptsLeft` 的 fake service 调用这个生产 factory，并断言 `data.config`、顶层 `data.apiKey` 深度不存在且 `user/attemptsLeft` 保留；变异时只把生产 factory 改为 `return service.verifyAndRegister(...)`，同一测试必须失败。不能在测试中另写一个裁剪函数、先裁剪 fixture 再断言，也不能 mock sanitizer 返回已经安全的对象——这些写法即使真实 handler 继续透传也会恒绿。

### 1.3 `[规格设计缺陷]` “不 import electron”的 Vault 注入方案只注入了 crypto，没有注入 `app.getPath('userData')`

- 规格原文位置：S1 §2.1 第 22 行规定路径来自 `app.getPath('userData')`；第 31–33 行只定义 `crypto: VaultCrypto` 注入；§3 第 68–69 行却声称 Vault 对 `electron.app` 和 `safeStorage` 的依赖“全部走注入”。
- 仓内证据（file:line）：仓内现有直接取 Electron 路径的模式会静态 import `app`（[`SharedSessionState.ts:4`](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:4)），并在路径函数中调用 `app.getPath(...)`（第 33–35 行）；这正是新 Vault 测试若要“完全不 import electron”必须避免的模式。当前 Vitest 全局环境只有 node，未配置 Electron runtime 或全局 Electron mock（[`vitest.config.ts:11`](/home/dan/projects/ai-client/vitest.config.ts:11)）。此外，搜索 `src/main/services/auth/**` 未找到任何现存文件或可复用注入层。
- 建议改法：明确 Vault 构造依赖至少为 `{ userDataDir: string, crypto: VaultCrypto, fs?: VaultFs }`，或注入已经算好的 `vaultPath`；只有 Main composition root 调用一次 `app.getPath('userData')` 后传入。测试使用 `mkdtemp` 的绝对路径，纯 Vault 模块不得 import `electron`。如果需要验证文件调用而不是实际权限，可再注入最小 fs port，但不要为了测试重写 Node `fs` 的完整接口。

### 1.4 `[规格与母规格不一致]` S1 声称沿用母规格 schema v1，实际字段布局完全不同

- 规格原文位置：S1 §2.1 第 24–30 行称 schema v1 来自“母规格 §3.C”，定义为 `{version,enc,lastEmail,payload}`，解密后 payload 含 `identity/cchBaseUrl/claude/codex/receivedAt`。
- 仓内证据（file:line）：母规格 §3.C 实际定义的是扁平结构 `{version,enc,lastEmail,identity,cchBaseUrl,claude,codex,invalidatedAt}`，没有 `payload` 和 `receivedAt`（[`2026-08-15-login-management-design-spec.md:88`](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:88)，具体字段在第 90–94 行）。S1 既没有声明这是对母规格的修订，也没有规定 `enc:'safeStorage'` 与 `enc:'none'` 两种布局如何共享版本、如何校验、后续 S2–S6 应读取哪一种形状。
- 建议改法：动工前选定唯一权威 schema。若采用 envelope，应把母规格同步改为明确的 `VaultDocumentV1 = {version,enc,lastEmail,payload}`，分别定义 encrypted payload 与 plaintext payload 的判别联合，并说明 `receivedAt/invalidatedAt` 的最终字段；若继续采用母规格扁平形状，则 S1 必须删除 envelope 描述。还要给出一份逐字段 fixture，作为 S1 写入测试和后续切片读取测试的共享契约，避免各片自行解释。

### 1.5 `[规格设计缺陷]` Vault 把解密失败吞成 `corrupt`，导致 `AuthState.reason:'decrypt_failed'` 永远不可达

- 规格原文位置：S1 §2.1 第 34 行规定“损坏/解密失败均返回 `{status:'corrupt'}`”；§2.2 第 39–46 行却定义 `credentials_invalid.reason` 包含独立的 `'corrupt'|'decrypt_failed'|'rejected'`；§3 第 71–73 行又明确要求“decrypt 失败→corrupt”。
- 仓内证据（file:line）：母规格明确把“vault 损坏”和“解密失败”作为需要进入失效状态的不同来源（[`2026-08-15-login-management-design-spec.md:103`](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:103)，第 105–107 行；状态表第 121–127 行）。当前 `src/main/services/auth/**` 尚不存在，因此仓内未找到任何额外映射逻辑可以在 Vault 已丢失失败原因后重新区分两者。
- 建议改法：定义可携带原因的 Vault 读取结果，例如 `{status:'invalid'; reason:'malformed_json'|'schema_invalid'|'decrypt_failed'; lastEmail?}`，由 `AuthStateService` 将前两者折算为 `corrupt`、将后者折算为 `decrypt_failed`；或者从 AuthState 联合中删除 `decrypt_failed`，但必须与母规格同步。对应测试必须分别写畸形 JSON 和让 fake crypto 抛错，断言两个状态原因不同。

### 1.6 `[规格设计缺陷]` 保留 `tokenPreview` 与“日志中无任何 secret 子串”直接冲突，拟议 redactor 也遮不住它

- 规格原文位置：母规格 I2 要求明文 key 永不进入日志或 trace（[`2026-08-15-login-management-design-spec.md:20`](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:20)）；S1 §2.4 第 62–64 行却要求接入 redactor 后仍“保留 tokenPreview 逻辑”，§7 S1 验收又要求“日志无 secret 子串”（母规格第 168–170 行）。
- 仓内证据（file:line）：现实现把 token 前 6 个字符拼进日志：`authToken.slice(0,6)`（[`OnboardingService.ts:246`](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:246)），随后以字段名 `token=` 输出（第 249–252 行）。S1 拟议敏感键列表没有 `token`，而被截短为六字符加省略号的值也未必满足“长 `sk-` 串”兜底，因此即使对该字符串调用 `redactSecrets`，前六字符仍可能原样落日志。与此同时，现有多个日志以第二参数直接传 `Error` 对象，例如写 Claude 配置异常（第 327–329 行）、Codex 写入异常（第 363–365 行）、登出异常（第 179–186 行）；仅有 `redactSecrets(input:string)` 无法覆盖这些额外参数中的 message/stack。
- 建议改法：删除 tokenPreview，日志只输出固定的 `token=<REDACTED>` 或 `tokenPresent=true`；不要把“部分秘密”当作安全日志。规格还应定义统一的日志参数清洗入口，逐个处理 string、Error.message、Error.stack 和可序列化对象，再调用 `console.*`；测试必须给 token 放入一个在首 6 字符内即可识别的唯一哨兵，并断言完整 token、首 6 字符及 Error.message 中的 token 都不出现在捕获日志中。

### 1.7 `[规格与母规格不一致]` `dev.js` 强制关 managed credentials 的要求没有进入 S1 范围，开发态可能被继承环境意外打开

- 规格原文位置：S1 开头第 5 行规定 `AICLIENT_MANAGED_CREDENTIALS` 仅严格等于 `'1'` 时开启，但“做”清单和测试计划都没有修改/验证 `scripts/dev.js`；母规格 §3.C 明确要求 `buildChildEnv` 强制 `AICLIENT_MANAGED_CREDENTIALS=0`（[`2026-08-15-login-management-design-spec.md:100`](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:100)），并在 §6 第 160 行再次锁定严格 `'1'`。
- 仓内证据（file:line）：当前 `buildChildEnv` 从完整 `process.env` 克隆环境（[`scripts/dev.js:173`](/home/dan/projects/ai-client/scripts/dev.js:173)）；清理列表只包含 `ANTHROPIC_*` 和若干 Claude/AWS/Google 变量，没有 managed-credentials flag（[`scripts/dev.js:90`](/home/dan/projects/ai-client/scripts/dev.js:90)）；随后 `Object.assign(env, vars)` 会继续允许 `dev.env` 注入该变量（第 199–209 行）。更危险的是 `--allow-local-credentials` 分支直接返回原始 `process.env`（第 184–188 行）。对 `src/` 的完整搜索未找到任何 `AICLIENT_MANAGED_CREDENTIALS` 生产代码使用点，说明严格读取函数和 dev 强制覆盖目前都不存在。
- 建议改法：把 `scripts/dev.js` 明确纳入 S1 范围；重构 `buildChildEnv`，保证所有返回路径最终执行 `env.AICLIENT_MANAGED_CREDENTIALS = '0'`，包括 `--allow-local-credentials` 分支，并确保该赋值发生在 `Object.assign(env, vars)` 之后。生产侧提取纯函数 `resolveManagedCredentialsEnabled(env) => env[...] === '1'`；测试至少覆盖缺失、`''`、`'0'`、`'true'`、`'True'`、`'yes'`、`' 1'`、`'1 '` 全为 false，只有精确 `'1'` 为 true，同时给 `buildChildEnv` 增加“继承环境为 1、dev.env 为 1，最终仍为 0”的负控。

### 1.8 `[规格设计缺陷]` 六组 mutation 中只有四组具备明确两态；IPC 裁剪和 flag 放宽两组仍可假绿

- 规格原文位置：S1 §3 第 71–80 行列出六组 mutation：去掉 0600、clear 不留 lastEmail、裁剪漏 config、corrupt 时 throw、放宽 flag、漏 `sk-`；但只笼统写“每对断言先红后绿”，没有逐组给出触发输入和必须翻转的断言。
- 仓内证据（file:line）：仓内已有严格 flag 测试展示了正确做法：不仅测 `'1'`，还逐个把 `'true'/'yes'/' 1'/'1 '` 等伪真值钉为 false（[`agentSupport.test.ts:21`](/home/dan/projects/ai-client/src/agent-host/__tests__/agentSupport.test.ts:21)，具体矩阵在第 26–35 行）。反之，如果 S1 的“flag off”测试只使用缺失值或 `'0'`，把实现变异为“`'true'` 也开启”仍然不会被触发。IPC 一组则受 1.2 所述无真实 handler 接缝影响：只测试一个独立 sanitizer，不会发现注册 handler 绕过 sanitizer。
- 建议改法：把六组写成可直接实现的断言清单：① 文件与目录分别断言 `(mode & 0o777) === 0o600/0o700`，改成 0644/0755 必红；② 先保存带哨兵 secret 和 lastEmail，clear 后断言邮箱仍在且序列化结果递归不含哨兵；③ 调用真实纯 handler factory，断言嵌套 `data.config` 和顶层 `data.apiKey` 均不存在，identity mutation 必红；④ `await expect(vault.read()).resolves.toMatchObject({status:'invalid',reason:'malformed_json'})`，任何 throw 必红；⑤ 输入精确 `'true'`，断言 `signed_out` 且 fs read/save 调用数均为 0，并另有 `'1'` 正控；⑥ 输入超过阈值的唯一 `sk-` 哨兵，断言输出含 `<REDACTED>` 且不含完整哨兵，删除兜底规则必红。施工 PR 必实际运行这六个单点变异并记录红灯输出，不能只提交“理论上会红”的测试。

## 2. major（严重但不一定阻塞动工的问题）

### 2.1 `[规格设计缺陷]` safeStorage“首窗 ready 后升格”没有明确的 composition root、事件或一次性状态约束

- 规格原文位置：S1 §2.1 第 31–33 行规定首个 BrowserWindow 创建后才能调用 safeStorage，并写成“Main 在 MainWindow 首窗 ready 后才把真适配器升格进去”；§4 第 84–85 行只补充了升格前 encrypt 请求记录 warning 后走明文。
- 仓内证据（file:line）：当前启动过程中 `init()` 先注册所有 IPC handler（[`src/main/index.ts:355`](/home/dan/projects/ai-client/src/main/index.ts:355)，第 380–384 行），之后才在第 749–757 行创建窗口；`createMainWindow` 在 [`MainWindow.ts:146`](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:146) 同步执行 `new BrowserWindow`，`ready-to-show` 与 `did-finish-load` 分别在第 232–238 行，另有 5 秒显示 fallback（第 240–242 行），但三条路径均没有 Vault 升格 hook。`OnboardingService` 当前还是模块级单例（[`OnboardingService.ts:651`](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:651)）。S0-E6 的实际硬条件只是“创建过 BrowserWindow”，不是等待 renderer ready（[`e6-safestorage-linux.md:17`](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e6-safestorage-linux.md:17)）。
- 建议改法：规格明确唯一接线位置：`openLocalWindow()` 返回后、也就是 `new BrowserWindow` 已完成的 [`index.ts:757`](/home/dan/projects/ai-client/src/main/index.ts:757) 下一行，立即执行一次 `credentialVault.promoteCrypto(createSafeStorageAdapter())`；不要依赖可能不触发或延迟的 `ready-to-show`。规定升格只能 `none → safeStorage`、重复调用幂等、不得降级；增加“IPC 已注册但窗口尚未创建时不得调用 available/encrypt/decrypt”与“窗口构造后升格只发生一次”的调用序测试。

### 2.2 `[规格设计缺陷]` 权限断言没有区分“传入 mode 参数”和“真实文件系统最终 mode”，也没有跨平台策略

- 规格原文位置：S1 §2.1 第 22–23 行要求目录 0700、文件 0600；§3 第 71–72 行把 0600/0700 列为通用 Vitest 断言，没有限定平台或断言层级。
- 仓内证据（file:line）：Vitest 只有统一 node project，没有平台 project、setupFiles 或专用 CI 条件（[`vitest.config.ts:4`](/home/dan/projects/ai-client/vitest.config.ts:4)）。S0 证据明确 Windows/macOS 尚未实测（[`e6-safestorage-linux.md:23`](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e6-safestorage-linux.md:23)，第 26 行及第 145–150 行）。参照实现 `SharedSessionState.atomicWriteJson` 的确不传 mode（[`SharedSessionState.ts:49`](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:49)），但它也说明仅检查写调用参数与检查真实落盘权限是两种不同测试。
- 建议改法：拆成两层：所有平台运行的纯单元测试通过 fake fs 断言 `mkdir(...,mode:0o700)`、tmp 写入 `mode:0o600`，且已有目录时执行 `chmod(0o700)`；POSIX 集成测试再用真实 `statSync` 与 `mode & 0o777` 断言最终权限。Windows 上跳过 POSIX mode-bit 集成断言，但仍运行 fake-fs 参数断言、原子 rename 和内容 roundtrip，避免 Windows CI 因 chmod 语义不同而红，也避免简单 `skip` 造成权限逻辑完全没有覆盖。

### 2.3 `[规格与母规格不一致 + 规格设计缺陷]` redactor 键名集合遗漏 `cookie`，同时加入裸 `key` 会造成高概率误伤

- 规格原文位置：母规格 I2 的统一 redactor 清单包含 `cookie`（[`2026-08-15-login-management-design-spec.md:21`](/home/dan/projects/ai-client/docs/plans/2026-08-15-login-management-design-spec.md:21)）；S1 §2.4 第 62–64 行遗漏 `cookie`，却新增了极宽的裸字段名 `key`。
- 仓内证据（file:line）：当前 onboarding IPC 确实操作名为 `auth-token` 的 cookie（[`src/main/ipc/onboarding.ts:38`](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:38)），虽然现代码没有读取 cookie 值，但母规格要求的是统一日志防线，不能因本片当前调用刚好不打印值而删除类别。仓内已有 redactor 的敏感赋值规则选择 `api[_-]?key`、`auth[_-]?token`、`password` 等有语义边界的名称，没有匹配裸 `key`（[`stderrRedaction.ts:62`](/home/dan/projects/ai-client/src/agent-host/stderrRedaction.ts:62)，第 65–74 行），并专门测试普通诊断词不能被吃掉（[`stderrRedaction.test.ts:95`](/home/dan/projects/ai-client/src/agent-host/__tests__/stderrRedaction.test.ts:95)）。
- 建议改法：键名集合至少与 I2 对齐，补 `cookie`、`set-cookie`、`authorization`；删除无条件裸 `key`，改为 `apiKey/api_key/api-key/x-api-key/accessKey/secretKey` 等限定名称。若确实要兜底 `key=...`，只在值符合已知 secret 形状或达到足够长度/熵时遮蔽。负控必须包括 `key=cache`、`key=ArrowUp`、`public key=ed25519`、`monkey=value`、`keyboard=true` 原样通过；正控包括 JSON 单/双引号、大小写、空白、冒号/等号和多行片段。

### 2.4 `[规格设计缺陷]` `redactSecrets(input:string)` 的匹配语法没有覆盖真实日志的全部形态

- 规格原文位置：S1 §2.4 第 62–64 行仅承诺处理 `"k":"v"` 和 `k=v` 两类字符串，随后要求接入 `OnboardingService` 的“现有 console.* 调用点”。
- 仓内证据（file:line）：真实日志并不只有这两类：`console.error(prefix, error)` 是多参数调用（[`OnboardingService.ts:327`](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:327)）；JSON 读取失败会同时记录动态路径和 Error 对象（第 506–515 行）；credentials health 会把拼接后的自由文本 reason 作为第二参数（第 623–626 行）。仓内已有 redactor 为此至少覆盖了 `:` 与 `=`、单/双引号、大小写、Bearer/Basic、URL userinfo 和裸 token 形状（[`stderrRedaction.ts:35`](/home/dan/projects/ai-client/src/agent-host/stderrRedaction.ts:35)，第 40–82 行），其测试也证明 `"KEY":"value"`、带空格的引号值和 Header 形态都需要单独钉住（[`stderrRedaction.test.ts:42`](/home/dan/projects/ai-client/src/agent-host/__tests__/stderrRedaction.test.ts:42)）。
- 建议改法：规格不要把“接入 console 点”写成简单地给第一个字符串套函数；定义 `redactLogArgs(args:unknown[]):unknown[]` 或集中 logger adapter，逐参数处理 string、Error、对象和数组。正则至少覆盖 JSON quoted key、`:`/`=`、单/双引号、大小写、Header、URL userinfo；测试必须捕获真实 console 参数数组后再序列化搜索哨兵，不能只测试 `redactSecrets` 的单字符串返回值。

## 3. minor（打磨类问题）

### 3.1 `[规格事实表述不精确]` “322/707 两行、apiKey/config 零消费者”基本成立，但必须限定为 renderer/preload 消费面

- 规格原文位置：S1 §2.3 第 51–52 行称 renderer 仅消费 `data.user`（`:707`）和 `data.attemptsLeft`（`:322`），`apiKey/config` 零消费者。
- 仓内证据（file:line）：`attemptsLeft` 的唯一 renderer 业务消费确实在 [`OnboardingView.tsx:322`](/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx:322)；`data.user` 的存在判断在第 707 行，真正读取 `user.name` 在第 711 行，因此是一个语义消费点、两个代码访问点。Preload 只声明全量返回类型并透传 IPC（[`preload/index.ts:775`](/home/dan/projects/ai-client/src/preload/index.ts:775)），没有读取字段；renderer/preload 中确实没有 `data.apiKey` 或 `data.config` 消费。但 `config` 不是全仓零消费者：Main 的 `OnboardingService` 在 [`OnboardingService.ts:135`](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:135)、第 158–160 行及第 194–221 行读取并持久化它。
- 建议改法：把事实改成“renderer 只有两个语义消费点：错误臂 `attemptsLeft`，成功臂 `user.name`；preload 仅透传；renderer/preload 对 `apiKey/config` 均为零字段消费者。Main 内 `config` 仍是合法消费者，裁剪必须发生在 Main 完成 legacy/vault 写入之后、IPC 返回之前。”行号写成 `322` 与 `707–711`，不要把“全仓零消费者”和“renderer 零消费者”混为一谈。

### 3.2 `[测试计划可执行但约束未写全]` 新目录会被 Vitest 收集，但只有 `*.test.ts` 会进执行范围

- 规格原文位置：S1 §3 第 68 行只指定新增目录 `src/main/services/auth/__tests__/`，没有锁定测试文件后缀，也没有给出用于确认收集数量的命令或断言。
- 仓内证据（file:line）：Vitest include 精确为 `src/**/__tests__/**/*.test.ts`，不会收集同目录下的 `*.spec.ts`、`*.test.tsx` 或无后缀约定文件（[`vitest.config.ts:11`](/home/dan/projects/ai-client/vitest.config.ts:11)）；`pnpm test` 实际执行 `vitest run`（[`package.json:30`](/home/dan/projects/ai-client/package.json:30)）。环境确实是 node，所以目录位置本身可执行，不需要新增 workspace/project。
- 建议改法：规格明确所有新测试文件必须以 `.test.ts` 结尾，并在门禁中列出一次带文件路径的定向运行和一次全量 `pnpm test`；施工验收记录应包含该目录实际收集到的测试文件数与用例数，避免文件放对目录却因后缀错误形成“0 tests、全绿”。本次评审按只读约束未执行 Vitest，只核验了静态收集配置。

若只改 blocker 能否开工：**能，但必须先把以上全部 blocker 写回规格并锁定对应负控；在这些问题未修前不应开始写码。**

Codex session ID: 01a005f5-028d-7173-b450-23215385125c
Resume in Codex: codex resume 01a005f5-028d-7173-b450-23215385125c
