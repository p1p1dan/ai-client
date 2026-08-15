> D47 S3+S4 规格 rev.1 双盲对抗评审 · A 轨（deep-reasoner/Opus，协议与运行时时序镜头，2026-08-15）。原文归档。

仓内逐点核对完毕（含真机 `~/.codex/config.toml` 与 `<userData>/codex-home/` 实况）。规格 rev.1 有 **5 个 blocker**，其中一个是「按规格实现就会在默认 flag 组合下把终端 codex 打死」。

---

# BLOCKER

### B1 — 终端注入 `CODEX_HOME`，但没有任何人保证这个目录被物化；默认 flag 组合下必然是空目录

**规格位置**：§1 S3b「`options.env` 注入 `CODEX_HOME=<userData>/codex-home`」

**事实链**：
- `codex-home` 的唯一写手是 agent-host 进程：`src/agent-host/codexRuntime.ts:1357`（`openConnection`，create/resume/revive 共用）与 `src/agent-host/index.ts` 的 `prepareCodexHome()`（registry 构建时）。Main 侧**零写手**。
- agent-host 只在 renderer 调 `AGENT_HOST_START` / 发 session 命令时才起（`src/main/ipc/agentHost.ts:26`，`AgentHostManager.ts:94`），开机不自起。
- `prepareCodexHome()` 只在 `resolveCodexEnabled(env)===true` 时才被调到（`agentSupport.ts:99-105`），而 `AICLIENT_AGENT_CODEX` 严格判 `'1'`（`agentSupport.ts:42`），`hostEnv.ts:24-27` 明确**不注入**它，`scripts/dev.js` 也不设它。

**后果**：`AICLIENT_MANAGED_CREDENTIALS=1` + `AICLIENT_AGENT_CODEX` 未设（= 今天的默认组合）时，S3b 会把 `CODEX_HOME` 指到一个从未被创建过的目录。终端 codex 于是拿到「空 home」——正是 `codexHome.ts:16-24` 模块抬头亲手写过的那个不可实现态：无 `model_provider`、无 `base_url`、无凭据，且 `env_key` 未配置所以 `AICLIENT_CODEX_API_KEY` 根本不会被读。终端 codex 从「今天能用（吃 `~/.codex`）」变成「完全不能用」，而这是 S3 交付物里唯一面向员工的可见承诺（母规格 §7 S3 行：「终端 `claude`/`codex` 免向导直接可用」）。

**改法**（择一，必须在写码前拍板）：
1. 把生成器搬到 Main（`services/auth/codexHome.ts` 新模块 + `managedFileWriter` 原子写），Main 在 `activateManagedClaudeHome()` 之后的启动相里物化 codex-home；agent-host 侧生成模式退化为「读已存在的文件，不写」。这条同时解 B2/M4/M8，且与 S2「Main 拥有托管 home」的既有形状同构。
2. 保持 Host 生成，但 `SessionManager` 注入前先 `existsSync(join(codexHome,'config.toml'))`，不存在则**两键都不注**（退回 `~/.codex`）。廉价，但把「终端能不能用」绑在「用户是否开过 app codex 会话」上，属于隐性状态耦合，不推荐。

---

### B2 — 存量 `<userData>/codex-home/auth.json` 无人删除：I4 在每台已升级机器上开局即假，且登出不吊销

**规格位置**：§1 S4a「生成模式下拷贝链**不执行**且断言 codex-home 无 auth.json（I4）」

**真机实证**（本机，非推演）：
```
/home/dan/.config/jyw-ai-client-dev/codex-home/auth.json   -rw------- 62 bytes  (存在)
/home/dan/.config/jyw-ai-client-dev/codex-home/config.toml  投影模式产物，requires_openai_auth = true，无 env_key
```
`codexHome.ts:621-636` 只增量拷贝，从不删除；模块抬头 `codexHome.ts:84-91` 明写「Who cleans this directory up: NOBODY」。`OnboardingService.removeCodexConfig()`（`:634-647`）只删 `~/.codex` 两个文件，**碰不到 codex-home**。

**三重后果**：
- I4 是「断言」不是「动作」——按规格写完，测试断言的是新代码不拷贝，而磁盘上的旧凭据照旧躺着，不变量在生产上为假。
- 登出后 `<userData>/codex-home/auth.json` 仍是有效 key。叠加 B1 的 `CODEX_HOME` 注入，**登出态的终端 codex 会用陈旧 key 继续认证成功**——直接推翻 §2.4-5「登出态缺席」和 §1「登出态终端跑 codex 报 Missing env」。
- `requires_openai_auth=false` + `env_key` 与**同目录存在 auth.json** 的优先级 [未证实]：E4 fixture 明写「隔离 CODEX_HOME 目录下没有 auth.json」（e4 文档 §隔离 config.toml 段），从没测过共存。若 auth.json 优先，`credentials_missing` 这条腿在存量机器上永远走不到，且 vault 换 key 后会静默用旧 key。

**改法**：生成模式入口处 `unlinkSync(join(homeDir,'auth.json'))`（幂等、吞 ENOENT），并把「删除后 `existsSync===false`」作为过程断言；同时补一次 5 分钟 spike 确认 auth.json 与 env_key 共存时的优先级（复用 e4-driver 形状，只加一个 auth.json 臂），把结论写进规格而不是留给实现者猜。

---

### B3 — 「两键不注入」≠「两键缺席」：子进程 env 是 `{...process.env, ...options.env}`，模式信号可被外部污染

**规格位置**：§1 S3b「vault 非 `ok` → 两键不注入」；§2.3「flag off（Main 不注两键）→ agent-host 全链今天行为」

**事实链**：
- `src/main/services/agent-host/AgentHostProcess.ts:47-52`：`env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: undefined }`。`buildAgentHostEnv` 省略某键 ⇒ 该键**继承 Main 的 `process.env`**，不是缺席。
- `PtyManager.ts:377-386`：`finalEnv = {...process.env, ...getProxyEnvVars(), ...options.env, TERM, ...}`，同理。
- 谁会污染：`scripts/credential-env-keys.mjs:18-29` 的剥离清单只有 `ANTHROPIC_*` + 7 个具名键，**`AICLIENT_CODEX_*` 两个都不在内**；`stripInheritedCredentialEnv()`（`managedClaudeHomeStartup.ts:49-55`）因此不剥，且它本身只在 flag on 时跑。所以：用户 shell 里 `export AICLIENT_CODEX_BASE_URL=...` 后从终端拉起 app ⇒ **flag off 也进生成模式**，§2.3 的 flag-off 逐字节等价性当场失效。

**改法**：
- `buildAgentHostEnv` **恒返回两个键**，值为 `string | undefined`（照抄同文件已有的 `ELECTRON_RUN_AS_NODE: undefined` 先例；Node `spawn` 丢弃 undefined 值键）。附带好处：`hostEnv.test.ts:16` 的 `toEqual` 断言无需改动（vitest `toEqual` 忽略 undefined 属性），旧键集不变的断言天然成立。
- `SessionManager` 同款：两键恒出现在 Main 构造的 env 对象里，非 ok 时为 `undefined`。
- 把 `AICLIENT_CODEX_BASE_URL` / `AICLIENT_CODEX_API_KEY` 加进 `credential-env-keys.mjs`（单一真源，dev.js 与 Main 同步跟随）。
- 负控用例：预置一个被污染的 `process.env`，断言 flag-off 轮子进程里两键仍缺席。这条不加，§2.3 就是不可验证的。

---

### B4 — 「切片 6 的 protocolErrors 双臂模块」不存在；真实落点是 `codexNormalizer`，且那里现在就有一个把错误显示成 `[object Object]` 的既有 bug

**规格位置**：§1 S4a 最后一条 bullet

**事实链**：
- 仓内只有 `src/agent-host/__tests__/protocolErrors.test.ts`——一个 spawn 真 Host 的**集成测试**，没有对应的 `protocolErrors.ts` 模块，更没有「双臂结构」。施工员按规格去找模块会扑空。
- turn 级终态的真实处理点是 `src/agent-host/codexNormalizer.ts:504-521`：
  ```ts
  const error = turn && turn.error != null ? String(turn.error) : null;
  ```
  E4 实测 `turn.error` 是**对象** `{message, codexErrorInfo, additionalDetails}`（e4 文档 §逐帧 fixture / turn/completed），`String(对象)` ⇒ `"[object Object]"`。也就是说今天缺 env_key 的 turn 呈现给用户的是 `session.failed { error: "[object Object]" }`——不加 pattern 也已经是缺陷。
- `method:"error"` 这条通知（E4 的 *** THE ERROR FRAME ***）既不在 `CODEX_NORMALIZER_METHODS`（`codexNormalizer.ts:52-66`）也不在 `CODEX_IGNORED_NOTIFICATIONS`（`:77-85`），落进 `unknownNotifications` 计数并按「codex 升级了、我们需要知道」记日志。

**改法**：规格必须改写这条为三件事而不是一件：(a) `onTurnCompleted` 读 `turn.error.message`（兼容旧的字符串形态）；(b) 决定 `method:"error"` 是进 handled 集合还是进 ignore 表并写明理由（`willRetry:true` 的重试臂必须**不**升级为终态——E4 present 组已证 `Reconnecting... 1/5` 也走同一帧）；(c) 在 (a) 的结果上做 `Missing environment variable` 子串匹配 → `codex_credentials_missing`。断言按 e4 fixture 的逐字报文（含反引号）。

---

### B5 — `credentials_missing` 的判据缺「生成模式」前置条件，且 §1 与 §2.1 自相矛盾

**规格位置**：§1 S4a「短路序 `flag_off → credentials_missing → entry_missing → home_prepare_failed`」 vs §1 S3b「vault 非 `ok` → 两键不注入 → Host 侧自然 `credentials_missing`/回退」 vs §2.1「缺席 → 投影回退模式」

**矛盾**：按 §2.1，vault 非 ok ⇒ 无 base ⇒ **回退模式**，`credentials_missing` 不该触发；按 §1 S3b 的「`credentials_missing`/回退」写法，实现者完全可能写成「无 key 即 credentials_missing」。后者一旦落地，flag-off 机器（也无 key）会被判 `credentials_missing`、codex 从 `capabilities.agents` 消失——§2.3 的 flag-off 等价性直接崩。§1 的短路序列表逐字读也是「无模式守卫」的。

**改法**：把判据写成不可误读的一行并作为过程断言：
```
credentials_missing  ⟺  generationMode(env) === true  ∧  !env.AICLIENT_CODEX_API_KEY
generationMode(env)  ⟺  非空 env.AICLIENT_CODEX_BASE_URL
```
配一条负控：`{flag:'1', 无 base, 无 key}` ⇒ 期望 `available:true`（回退模式），**不是** `credentials_missing`。同时把「§1 S3b 的 `/回退` 斜杠」改写清楚：vault 非 ok = 回退模式（凭 `~/.codex`），不是 credentials_missing。

---

# MAJOR

**M1 · I5 纪元链是竞态，不是保证。** `OnboardingService.ts:206`（登录）与 `:232`（登出）都是 `void this.shutdownAgentHostAfterRegenerate()`，不 await；`AgentHostManager.ensureStarted()`（`:96`）在 `state==='ready' && process.isRunning` 时**立即返回**。重登场景（母规格 §4 `credentials_invalid` → 重登）下，renderer 拿到 login 成功后立刻发的第一个 codex 会话，可能仍由旧 Host 服务 ⇒ 新 key 不生效。登出侧更弱：`clearVaultShadowCopy()`（`:308`）在 shutdown 链**之后**才同步入队，两者之间无 happens-before 边——今天靠「regenerate 是真 fs 写、clear 是同步任务」的时序巧合成立，没有任何断言钉住。**改法**：`ensureStarted` 加 shutdown-in-flight 闸（或 epoch 计数），登出把 vault.clear 提到 regenerate 之前并 await；补一条调用序断言（S5 的 I9 七步序正是为此，S3b 不能只引用不加固）。

**M2 · 终端共用托管 home 的行为差远超「强制 posture」，规格只承认了 posture 一项。** 本机 `~/.codex/config.toml` 实况：`model = "gpt-5.6-sol"`、`model_reasoning_effort/summary/verbosity`、`developer_instructions`、`status_line`(9 段)、`service_tier`、`tool_output_token_limit`、`[features] shell_tool = true`、`approvals_reviewer`、`sandbox_mode = "danger-full-access"`。生成模式只写 6 个键，**以上全部消失**，且沙箱从 `danger-full-access` 降到 `workspace-write`。母规格 §8 设计者默认只覆盖了 posture 一项。**改法**：规格 §1 S3b 增一节「终端行为差清单」逐条列出并登记为已知限制（或按 R3 口径合并），并在 UI/文档给出逃生舱口径（`CODEX_HOME=~/.codex codex`，比 `codex --config` 更贴合本设计）。

**M3 · 模式漂移未定义。** 生成/回退由**运行时 env** 决定，而 codex-home 是**持久**目录（含 `sessions/`、四个 sqlite、`skills/`）。vault ok 的一次启动写生成态 config（`model_provider="jyw"`、`requires_openai_auth=false`），下一次 locked 启动**重写为投影态**（本机会变成 `model_provider="OpenAI"`、`requires_openai_auth=true`）。H9 `verifyResumePosture`（`codexRuntime.ts:711-733`）只校 approvalPolicy + sandbox.type，两态都写 posture 两键，所以**校验照过**——但线程恢复时的 provider / 认证方式与创建时不同，静默换轨。§2.2 提到 sidecar `.aiclient-generated 记来源` 却从未定义写/读语义。**改法**：sidecar 落实为真文件（模式 + 来源 + 生成时间戳），启动比对；模式翻转时至少记一条 Host 日志，并决定是否要拒绝跨模式 resume。

**M4 · 裁定 c「无需队列」与既有登记风险 R7 冲突，且写不是原子的。** `codexHome.ts:617-619` 是 `writeFileSync`（截断后写）。生成模式给这个文件新增了一个**跨进程读者**（终端 codex）。登录 regenerate 恰好是「Host 重写 config」与「用户在终端敲 codex」概率最高的重合点，读到半截 TOML = parse 失败。母规格 §10 已登记 R7「codex home 并发（低）」，规格 c 直接宣称「无需队列」而不引用 R7。**改法**：tmp + `renameSync`（S2 的 `managedFileWriter` 已是同款形状），或按 B1 方案 1 直接复用它。

**M5 · 母规格 §3.B 的「Main 侧 session/PTY 创建入口同时检查 AuthStateService（纵深，不只靠 renderer 门禁）」被静默丢弃。** S34 只做「vault ok 就注入」，没有任何 Main 侧凭据门禁。规格必须显式声明这条移交 S5（并在 §1「不做」列表里点名），否则它会随 S3b 收口一起从视野消失。

**M6 · 裁定 b 偏离母规格且后果未申报。** 母规格 §3.B 白纸黑字「root 只写 `model_provider`/`model`/`approval_policy`/`sandbox_mode`」。不写 `model` 的真实后果不是「走 D40 会话协议」——`buildThreadStartParams`（`codexRuntime.ts:210-223`）只在 caller 传了 model 时才带；**终端 codex 根本没有 D40 通道**。E4 实测无 `model` 键时 codex 自选 `gpt-5.6-sol`（e4 文档 thread/start 响应），也就是把模型钉死成 **codex 二进制版本的内置默认**，codex 升级即静默换模型。本机投影模式今天携带的正是 `model = "gpt-5.6-sol"`，所以「行为中性」在 0.145.0 上是巧合。**改法**：要么写 `model`（值来源另裁），要么把「模型 = codex 内置默认」写成显式裁定 + 对 e4 fixture 的版本 pin 测试，并登记终端侧回归。

**M7 · 剥离清单另立一套。** §1 S4a 只剥 `ANTHROPIC_*`；仓内已有单一真源 `scripts/credential-env-keys.mjs`（`isCredentialEnvKey`，含 `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` / `AWS_BEARER_TOKEN_BEDROCK` / `GOOGLE_APPLICATION_CREDENTIALS` 等），且 `credential-env-keys.test.mjs` 专门防两处漂移。注意剥离**确实必要**：`src/agent-host/index.ts` 的 `ensureRuntime()`（约 `:148-152`）会把托管 settings 的 env 写回 Host 自己的 `process.env`。**改法**：复用 `isCredentialEnvKey`；但先验 `pnpm typecheck:agent-host`——`src/agent-host/tsconfig.json` 有独立 rootDir，跨 `scripts/` 引入 `.mjs` 可能过不了（`managedClaudeHomeStartup.ts:21` 那条相对路径引入在 Main 侧可行不代表 Host 侧可行）。过不了就在 `src/shared/` 落一份并让 `.mjs` 反向引用。

**M8 · 模式信号有 4 个独立读者，规格一个都没命名。** `index.ts:prepareCodexHome`、`codexRuntime.openConnection`（`:1357`）、registry 的凭据判定、spawn env 拼装。§2.2 的 `generateCodexConfig({baseUrl, permission})` 把 baseUrl 作参数 ⇒ 每个 caller 各自读 env。这与本仓「一个仓一处默认字面量 / Host 不猜」的既有纪律直接冲突。**改法**：`agentSupport.ts` 导出 `resolveCodexCredentialMode(env = process.env): {mode:'generate'|'project'; baseUrl?; hasKey:boolean}`，四处只准调它；配一条静态扫描断言 `AICLIENT_CODEX_BASE_URL` 字面量全仓只出现在这一个函数 + hostEnv.ts。

**M9 · `EnsureCodexHomeResult` 在生成模式下的形状未定义。** `codexHome.ts:203-207` 的 `projection: CodexConfigProjection`（`kept`/`dropped`）与 `authCopied` 在生成模式下都无意义，而 `:642-649` 的日志行照读 `projection.kept/dropped`。规格必须给出生成模式的返回形状（判别联合 or `kept:[] dropped:[] authCopied:false`）与对应日志口径，否则实现者会随手塞空数组，把「投影审计」和「生成」两种语义混在一个字段里。

**M10 · §2.4-5 与 §1 S3b 对登出态终端的描述与事实相反。** 「登出态终端跑 codex 报 Missing env，可读」不成立：两键缺席 ⇒ 终端回落 `~/.codex`；而 U1 裁定「收编但永不清理」+ 过渡期双写意味着 `~/.codex/auth.json` 在登出前一直有效——登出时 `removeCodexConfig()` 确实删了它，但**再叠加 B2 的 codex-home 陈旧 auth.json，观测到的多半是「照常能用」**。规格的员工体验叙事需要按实际三态（vault ok / vault 非 ok / 登出）重写，每态给出可观测判据。

---

# MINOR

- **m1** §1 S4a 称四子串「两两互不包含（既有纪律）」——`agentSupport.test.ts:157-169` 实际只断言 `Set(...).size === 3`（互异）+ 三个 `toContain`，**没有**成对不包含断言。别当既有纪律引用，这条要新写。
- **m2** `hostEnv.test.ts:16` 用 `toEqual` 钉死五键对象；采用 B3 的「显式 undefined」写法后该断言天然仍绿，请在规格里点明，免得施工员误改成 `toMatchObject`。
- **m3** `CODEX_CONFIG_HEADER`（`codexHome.ts:122-139`）整段文案是投影语义（「deny-by-default projection of your own Codex config」「edit your real config … and restart」），生成模式沿用即是错误说明。§2.2 只给了一行注释，但测试钉的是这个导出常量——需要第二个导出常量 + 两套快照。
- **m4** 母规格 §3.B 承诺「删投影白名单、`AUTH_BASENAME`、`authCopied` 整段（净减）」，S34 改为「保留为回退分支」。这是合理的过渡期取舍，但规格必须点名删除动作归属哪一片（S6 停双写？），否则这段净减会成孤儿。
- **m5** `codexHome.ts` 抬头自称 `projectCodexConfig` 是「No fs, no env, no clock」的纯函数。生成模式若在模块内直读 `process.env` 会破坏这条；照 `resolveSourceCodexHome(env = process.env)`（`:529`）的既有形状留注入缝。
- **m6** 终端起的 codex 线程会写进共享的 `<userData>/codex-home/sessions/`，从而出现在 app 的 `session.listHistory` / `codexHistoryReader` 结果里（本机该目录已有 `sessions/` + 四个 sqlite）。裁定 e 只谈了并发，没谈历史混入。登记。
- **m7** 登出只影响**新建**终端；已在跑的 PTY 进程 env 里的 key 继续存活到用户关窗（I9 的「终止全部会话/PTY」在 S5）。窗口期需登记。
- **m8** 回退模式与生成模式的 provider id 不同（本机回退是 `OpenAI`，生成是 `jyw`），`thread/start` 结果里的 `modelProvider` 会随模式翻转——与 M3 同源，测试里应作为模式漂移的可观测量。
- **m9** §2.4-1 要求「`--strict-config` 实跑通过」。注意现有证据只覆盖到 app-server 起会话（e4）与 `codex doctor`（02-seams §4 路径 A），`--strict-config` 对 `requires_openai_auth=false`+`env_key` 这组合没跑过；作为施工首个门禁跑一次即可，但别在规格里写成已证。

---

# §3 自设裁定 a~f 判定

| | 裁定 | 判 | 依据 |
|---|---|---|---|
| **a** | 模式信号 = `AICLIENT_CODEX_BASE_URL` 存在性 | **不成立（可修复）** | 「缺席」在两条 spawn 链上不可达成（B3）；信号有 4 个未命名读者（M8）；两处剥离清单都不含它（`credential-env-keys.mjs:18-29`）。修法：恒发两键（值可 undefined）+ 单一 resolver + 加进剥离清单。修完形状本身可用。 |
| **b** | 生成模式不写 `model` | **不成立（申报缺失）** | 偏离母规格 §3.B 逐字条款；真实后果是把模型钉成 codex 二进制内置默认（E4: `gpt-5.6-sol`@0.145.0），终端侧无 D40 通道兜底，本机今天投影携带的正是同一值 ⇒「行为中性」是版本巧合（M6）。 |
| **c** | posture 每会话重生成、跨进程写手唯一、无需队列 | **不成立** | `writeFileSync` 非原子（`codexHome.ts:618`）；生成模式给同一文件新增跨进程**读者**；母规格 §10 已登记 R7 而裁定未引用（M4）。 |
| **d** | 剥 `ANTHROPIC_*` 只在生成模式 | **成立（清单来源需改）** | 方向正确且必要——Host 会把托管凭据写回自身 `process.env`（`index.ts:ensureRuntime`）；回退模式保留全继承也对（用户 `env_key` 顾虑仍在，`codexRuntime.ts:1380-1388` 注释即此）。仅需改用 `isCredentialEnvKey` 单一真源（M7）。 |
| **e** | 终端与 app 共用 codex-home | **部分成立** | 并发论证站得住（codex 对 `~/.codex` 原生多进程同构，WAL sqlite）；但它同时是 B1/B2/M4 的成因，且配置差（M2）与历史混入（m6）未申报。裁定本身保留，申报面必须补全。 |
| **f** | turn 级错误用 message 子串匹配 | **成立（落点错）** | E4 已证 `codexErrorInfo:"other"` 无结构化码可依，子串是唯一可行判据。但落点不是「protocolErrors 双臂模块」（不存在），而是 `codexNormalizer.ts:504-521`，且那里 `String(turn.error)` 现在就产出 `[object Object]`；另需为 `method:"error"` 通知定归属并区分 `willRetry` 两臂（B4）。 |

---

# 「只改 blocker 能否开工」判语

**不能整片开工；建议拆三段。**

- **B4 / B5 / B3 / B2 是编辑级修正**（改判据措辞、改落点文件名、加 `undefined` 语义、加一次 unlink + 一次 5 分钟 spike）。这四条改完，**S4a（agent-host 侧）可以开工**，风险可控。
- **B1 不是编辑级的**——它要一次架构裁定：codex-home 的物化归 Main 还是归 Host。选 Main（推荐）会连带改动 S3b 的文件集、与 S4a 产生文件重叠（`codexHome.ts` 双向），「两子批文件集不相交可并行」这个前提随之作废；选 Host 则要接受「终端能否用 codex 取决于用户是否开过 app 会话」这个隐性耦合。**S3b 的 codex 腿在这条拍板前不能动工。**
- **S3b 的 claude 腿（`CLAUDE_CONFIG_DIR` pin 测试）零代码零风险，现在就能落**——已核实 `managedClaudeHomeStartup.ts:72` 写 `process.env.CLAUDE_CONFIG_DIR`、`PtyManager.ts:378` 展开 `...process.env`，链路成立。

另外三条虽列 major 但**建议提到开工前**一并落规格（成本低、返工代价高）：M5（S5 移交声明）、M8（单一 resolver，决定四处调用形状）、M9（`EnsureCodexHomeResult` 生成态形状，决定函数签名）。M1 可以留到 S5 与 I9 七步序一起收，但要在本规格「已知窗口」里登记，不能继续当作「S2 已接线、无需再管」。

**读过的关键文件**：`/home/dan/projects/ai-client/src/agent-host/codexHome.ts`、`codexRuntime.ts`、`agentSupport.ts`、`codexNormalizer.ts`、`index.ts`；`/home/dan/projects/ai-client/src/main/services/agent-host/{hostEnv.ts,AgentHostManager.ts,AgentHostProcess.ts}`；`/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts`；`/home/dan/projects/ai-client/src/main/services/terminal/PtyManager.ts`；`/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts`；`/home/dan/projects/ai-client/src/main/services/auth/{CredentialVault.ts,index.ts,managedClaudeHomeStartup.ts,redact.ts}`；`/home/dan/projects/ai-client/src/main/ipc/session.ts`；`/home/dan/projects/ai-client/scripts/credential-env-keys.mjs`；`/home/dan/projects/ai-client/src/agent-host/__tests__/{agentSupport.test.ts,protocolErrors.test.ts}`；`/home/dan/projects/ai-client/src/main/services/agent-host/__tests__/hostEnv.test.ts`。