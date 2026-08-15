> D47 双轨双盲设计案 · A 轨（deep-reasoner / Opus，2026-08-15）。原文归档，未经编排者改写。
> 与 B 轨（Codex）互为盲评；合取结果见 2026-08-15-login-management-design-spec.md。

# 用户登录管理（D47）技术设计案

> 输入证据：四份前调查报告（agent-0/1/2/3）+ 本轮直接核对的仓库源码。凡新引入的假设标 `[假设]`，凡需要实测才能定的标 `[实测]`。

---

## §1 总架构

**一句话**：把今天散在三处的"凭据权威"（`~/.claude/settings.json`、`~/.codex/{config.toml,auth.json}`、`~/.aiclient/settings.json.onboarding`）收敛成 Main 进程独占的一个 **CredentialVault**，其余所有位置降级为**由 Vault 生成的投影**（app 私有 claude-home / codex-home 配置文件）或**进程启动时注入的 env**；登录态由 Main 侧单一 `AuthStateService` 判定，Root 门禁与 MainWindow 镜像都改读它。

**数据流**（登录后一次会话的完整链路）：

```
onboard 服务 /verify-and-register
        │ (Main 进程内存，从不进 renderer)
        ▼
CredentialVault  <userData>/credentials/vault.json   ← 唯一权威，0600 + safeStorage(可用时)
        │
        ├─(A) ClaudeHomeGenerator ─► <userData>/claude-home/{settings.json,.claude.json}
        │        └─ Main 启动时一次性 process.env.CLAUDE_CONFIG_DIR = <claude-home>
        │             ├─ Main 自己的 5 个读者（HookManager / IdeBridge / ProviderManager…）自动跟随
        │             ├─ agent-host 子进程继承 → claudeSettings.ts:31 读到托管 settings.json
        │             │     → ensureRuntime 写回 host process.env (index.ts:148-152)
        │             │     → mergedEnv (claudeRuntime.ts:554-559) → SDK options.env (:756) → claude CLI 子进程
        │             └─ PTY 终端继承（PtyManager.ts:378 `{...process.env}`）→ 用户手敲 claude 也认
        │
        ├─(B) CodexHomeGenerator ─► <userData>/codex-home/config.toml（生成，非投影；无 auth.json）
        │        └─ Main 经 buildAgentHostEnv 注入 AICLIENT_CODEX_API_KEY
        │             → codexRuntime.ts:1389 env → codex app-server 子进程（env_key 路径）
        │             └─ SessionManager 侧把 CODEX_HOME + AICLIENT_CODEX_API_KEY 加进 PTY options.env
        │
        ├─(C) UsageService 直接读 Vault（替代 UsageService.ts:63-79 读 ~/.codex/auth.json）
        │        └─ cch 401/403 → 反哺 AuthStateService「凭据失效」
        │
        └─(D) AuthStateService（Main 单一真源）
                 ├─ IPC auth.getState（拉）+ auth.stateChanged（推）
                 ├─ Root 门禁（4 query → 2）
                 └─ MainWindow.isAppMountedFor()（MainWindow.ts:28-35 改读同一服务）
```

**三条贯穿原则**（都是从仓内既有约定继承来的，不是新发明）：

1. **谁拥有路径谁传，接收方不猜**——`hostEnv.ts:19-22`、`codexHome.ts:604-609` 已经把这条写成模块契约（"a missing path is an explicit error, not a guess"）。凭据同理：Main 拥有 Vault，Host/PTY 侧一律无 fallback。
2. **生成文件带"不要编辑"抬头**——沿用 `CODEX_CONFIG_HEADER`（`codexHome.ts:122-139`）的做法，claude-home 的 `settings.json` 同样加抬头，杜绝"用户改了但下次被覆盖"的困惑。
3. **一个仓一个默认字面量**（`codexHome.ts:103`）——`CLAUDE_CONFIG_DIR` 就是那个变量，**不新造 `AICLIENT_CLAUDE_HOME`**（详见 §2.A 否决理由）。

---

## §2 各轴裁定

### A. Claude 侧注入机制

**裁定：A3 混合 = 「app 私有 claude-home + 进程级 `CLAUDE_CONFIG_DIR` 重定向」为主干，SDK 会话不再额外造 env 通道。**

具体形状：

| 项 | 决定 |
|---|---|
| 私有 home | `<userData>/claude-home`（与 `codex-home` 同级，沿用 `AgentHostManager.ts:429` 的先例） |
| 生成物 | `settings.json`（`env` 三键 + `model` + `autoUpdates:false` + `skipWebFetchPreflight:true` + 生成抬头）、`.claude.json`（`hasCompletedOnboarding:true` + 逐工作区 `hasTrustDialogAccepted:true`，配方抄 `scripts/dev.js:135-171`） |
| 重定向方式 | Main 在 `src/main/index.ts:130-135`（`app.setPath('userData')` 之后、任何服务构造之前）**一次性**设 `process.env.CLAUDE_CONFIG_DIR`，同时剥离继承来的 `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`（`scripts/dev.js:91-100` 的生产版移植） |
| agent-host | **零改动**。`claudeSettings.ts:29-34` 已读 `CLAUDE_CONFIG_DIR`，`AgentHostProcess.ts:48-53` 已透传 `process.env` |
| 内置终端 | **零额外改动**（`PtyManager.ts:377-386` 起手就是 `{...process.env}`），token 不进 shell env |

**为什么这条能一箭多雕**（关键论证）：

- **hooks 四写手 + IDE bridge 门禁自动解决**。`isClaudeInstalled()` = `fs.existsSync(getClaudeConfigDir())`（`ClaudeHookManager.ts:353-356`），而 `getClaudeConfigDir()` 读的就是 `CLAUDE_CONFIG_DIR`（`:71-80`）。app 自己创建了托管目录 ⇒ 门禁恒为 true，四个 `ensureXHook` 与 `ClaudeIdeBridge.getIdeDir()`（`:92-96`）全部跟着搬进托管 home。**agent-0 §③ 提出的"hooks 全部装不上"这个最大风险，在这条方案下不需要任何专门处理**。纯 env 方案（A1）反而必须额外发明一个 `isClaudeInstalled` 新判据。
- **多写手竞态自然收敛**。`OnboardingService.writeClaudeConfig` 的重试+读回校验（`OnboardingService.ts:254-330`）与 `writeSettingsWithEnvGuard`（`ClaudeHookManager.ts:88-137`）都是给"三个写手抢一个文件"打的补丁。改后：`env` 块由生成器独占，hooks 写手只碰 `hooks`/`statusLine` 字段，且文件在 app 私有目录里没有第三方（用户/官方 CLI 首启向导）掺和。`writeSettingsWithEnvGuard` 从"报警补丁"降级为可保留的低成本断言。
- **托管文件天然压过被污染的 shell env**。`claudeSettings.ts:62-66` 是"文件值覆盖 process.env"，正是我们要的优先级：员工 `~/.zshrc` 里自己的 `ANTHROPIC_API_KEY` 不可能顶掉托管凭据（何况 `:67-69` 还会在 AUTH_TOKEN 存在时删掉 API_KEY）。纯 env 方案要靠"注入顺序"保证同样效果，脆弱得多。
- **`skipWebFetchPreflight` 有处可放**。这是 `settings.json` 顶层键（`OnboardingService.ts:303`），**没有 env 等价物** `[假设]`。纯 env 方案会直接丢掉这个为 JYW 代理打的补丁，WebFetch 回归失效。这一条单独就足以否决 A1。

**必须同步改的硬编码写手（不改则 D47 目标不成立）**：

- `src/main/services/cli/ClaudeRuntimeConfig.ts:5-7,31-38`（`disableClaudeAutoUpdates`）—— 硬编码 `os.homedir()/.claude`。**处理：删除该函数，`autoUpdates:false` 折进生成器**（生成文件本就是全量重写，没必要保留一个只为改一个键的独立写手）。调用点 `AgentInstaller.ts:380` 与 IPC `claudeRuntime.ts:50` 同步清理。
- `src/main/services/cli/ClaudeRuntimeConfig.ts:49-73`（`mergeClaudeEnvSettings`）+ IPC `CLAUDE_RUNTIME_REGISTER_ENV`（`main/ipc/claudeRuntime.ts:60-76`）—— agent-0 判为疑似死代码（preload 暴露、renderer 零调用）。**处理：删除**。它是一个能任意写 `ANTHROPIC_AUTH_TOKEN` 的后门，与"凭据权威收敛"直接冲突，留着就是第二权威。
- `OnboardingService.ts:243-244,337,453,473` 四处硬编码 homedir —— 整体被 Vault + 生成器取代（见 §2.F 迁移）。

**手动 Provider 面板（`ClaudeProviderManager`）去留**：

**裁定：写路径退役，读路径降级为不含明文的诊断。**
- `applyProvider`/`applyProviderToClaudeSettings`（`:242-318`）整份覆写 `ANTHROPIC_AUTH_TOKEN` 等 —— 重定向后它会写进托管 home，然后被下一次生成覆盖，形成"设置面板改了但下次启动丢失"的静默数据丢失。**删除 IPC `CLAUDE_PROVIDER_APPLY` 与写函数**。
- `watchClaudeSettings`（`:52-172`）监听 + 推送 —— 文件已变成生成物，监听自己写的文件没有意义。**删除**。
- `extractProviderFromSettings`（`:229-235`）**通过 IPC 把明文 `authToken` 送到 renderer**，与 `ClaudeSettingsDiagnostics`（`claudeSettings.ts:10-21`，"从不含明文"）的口径直接冲突。若保留只读回显，必须改成与 `ClaudeSettingsDiagnostics` 同构（`hasAuthToken`/`baseHost`）。
- ⚠️ **agent-0 标注该面板的 renderer 消费组件 `[未证实]`**——施工前必须定位，若确认无 UI 消费者则整个模块删除（净减代码）。列为 S2 的前置排查项。

**historyReader 与会话历史**：
- `historyReader.ts:37,241` 跟随 `CLAUDE_CONFIG_DIR` ⇒ 新历史落在托管 home 的 `projects/`，**老用户的 `~/.claude/projects` 历史会从列表里消失**——这是可感知的用户损失。
- **裁定：只读双源合并**，不搬运数据。`listSessionHistory` 的签名已接受 `claudeConfigDir` 参数（`:37`），扩成"托管 home + 传统 `~/.claude`（只读）"两路列举后按 mtime 合并。
- 续接老会话：`resolveClaudeConfigDirForResumeSession`（`App.tsx:122-151`）本就是"多候选 home 择一"的现成机制，把托管 home 加进候选列表即可；`AgentTerminal.tsx:364-366` 的透传链原样复用。
  - 顺带清理：`~/.aiclient/claude-null` 这个**只有读者没有写手**的候选路径（agent-0 §② `[未证实]`）应在本轮判死或补写手，不能继续悬着。
- **否决"一次性拷贝历史到托管 home"**：`.jsonl` 转录体积不可控，拷贝是不可逆的数据移动，且 flag 回退后两边都有半份历史。只读双源是可逆的。

**被否方案**：

| 方案 | 否决理由 |
|---|---|
| **A1 纯 env 注入**（`ANTHROPIC_AUTH_TOKEN`/`BASE_URL` 直塞 host env 与 shell env） | ① `skipWebFetchPreflight` 是文件键，无 env 等价物，丢掉即 WebFetch 回归；② `isClaudeInstalled()` 目录存在性门禁（`ClaudeHookManager.ts:353-356`）失守，四个 hook + IDE bridge 全线停摆，得另发明判据；③ `.claude.json` 首启信任向导仍会弹（违背"员工零感知"）；④ token 进 shell env ⇒ 终端里 `printenv` 明文可见、且泄漏给该 shell 的所有子进程 |
| **新造 `AICLIENT_CLAUDE_HOME` 环境变量**（对称 `AICLIENT_CODEX_HOME`） | 与 `CLAUDE_CONFIG_DIR` 是同一个问题的两个答案——正是 `hostEnv.ts:21-22` 明文反对的"second source of truth"。且 `CLAUDE_CONFIG_DIR` 已有仓内五个读者 + CLI 官方语义，新变量要逐个改读者，净负 |
| **按调用点逐个精确注入 `CLAUDE_CONFIG_DIR`**（不设进程全局） | N 个注入点 ⇒ 漏掉任何一个就静默写回 `~/.claude`，而且漏了没人发现（正是今天 `ClaudeRuntimeConfig`/`OnboardingService` 两个写手不跟随的翻版）。进程全局是"AiClient 进程树内 Claude home 就是它"的正确语义 |

---

### B. Codex 侧生成模式

**B1 config.toml 精确形状**（生成，非投影）：

```toml
# GENERATED FILE — DO NOT EDIT.  (抬头沿用 CODEX_CONFIG_HEADER 风格)
model_provider = "jyw"
model = "<可选，来自设置>"
approval_policy = "<CODEX_PERMISSION_DEFAULT>"     # codexHome.ts:147-176 强制，H9 layer1
sandbox_mode    = "<CODEX_PERMISSION_DEFAULT>"

[model_providers.jyw]
name = "jyw"
base_url = "<vault.codex.baseUrl>"
wire_api = "responses"
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```

- **`model_context_window` / `model_auto_compact_token_limit` 本轮一律不写。** 依据：agent-1 §3 [实测] 证明它们今天写在 `[model_providers.jyw]` 下被 codex 静默丢弃，**上线至今从未生效**；把它们挪到 root 让其"第一次真正生效"= 在改凭据管道的同一片里改模型行为，两个变量一起动，违反规范 §10 的可对比性。**当前生效行为 = 不存在**，所以行为中性的做法就是不写。是否启用另立开放问题（§4-3）。
- 强制 posture 两行必须保留在 config.toml：`thread/resume` 从 config 重新派生 posture 并由 `verifyResumePosture`（`codexRuntime.ts:711-733`）硬校验，缺失 ⇒ `CodexResumePostureError`。
- `CODEX_CONFIG_ROOT_ALLOWLIST` / `CODEX_CONFIG_TABLE_ALLOWLIST`（`codexHome.ts:107-119`）与 `projectCodexConfig` 整段**随投影退役一并删除**——生成模式是直接拼串，不经白名单。agent-1 风险 #5（"两套模式共存期白名单要不要加键"）因此不成立：不共存，flag 一翻整段换实现。

**B2 认证路径：裁定路径 A（`requires_openai_auth=false` + `env_key` 自定义变量 `AICLIENT_CODEX_API_KEY`）。**

依据：agent-1 §4 [实测] 本机 codex 0.145.0 已验证 `codex doctor` 报 `provider auth env var AICLIENT_TEST_KEY (present)`、`codex exec` 正常起会话；缺变量时报 `Missing environment variable: 'AICLIENT_CODEX_API_KEY'`（可读的定位信息）。与 open-q #9 已记录方向一致。

| 被否路径 | 否决理由 |
|---|---|
| **B：`requires_openai_auth=true` + 标准 `OPENAI_API_KEY`** | 内置终端里这个变量会被**所有**读 `OPENAI_API_KEY` 的第三方工具捡走（aider / openai SDK / 各种脚本），把 JYW 网关的 key 发到 `api.openai.com` 或别处，是实打实的凭据错投；反过来员工自己的 OpenAI key 与我们的语义撞名。agent-1 风险 #6 也点出冲突面在 B 不在 A |
| **C：在 app codex-home 内落 `auth.json`** | 违背"退役第二份磁盘拷贝"的初衷；保留 `copyFileSync` + mtime 刷新 + `authCopied` 哑返回值（agent-1 风险 #3 指出无人读取）整套逻辑；且 codex 自身在某些流程会回写 auth.json，制造第二写手。切 A 是**净减代码**：`AUTH_BASENAME`、`copyFileSync/chmodSync/mtimeOrNull` 分支、`EnsureCodexHomeResult.authCopied` 全部可删（`codexHome.ts:203-207,621-636`） |

**B3 内置终端里跑 codex CLI**：裁定 **复用同一个 `<userData>/codex-home`**，PTY `options.env` 注入 `CODEX_HOME` + `AICLIENT_CODEX_API_KEY`（Main 侧填充，见 §2.D 的"secret 不过 renderer"）。

- 代价（已登记）：终端里的 codex 会吃到 app 强制的 `approval_policy`/`sandbox_mode`，用户失去自选权；且 app 会话与终端会话共享 thread history 目录。
- 收益：一份凭据、一份配置、一份历史，app 与终端可互相 resume。
- 否决"再开一个 `codex-home-cli`"：两个生成目录 = 两份历史 + 两处必须同步的生成逻辑，为一个"内部工具里没人会去改 approval_policy"的自由度付双倍维护费。逃生舱：用户可自己 `codex --config approval_policy=...`。

**B4 无登录态降级 + `agent_unsupported` 是否加凭据维**：裁定 **加第四个 reason `credentials_missing`**（只对 codex）。

- 位置：`HostAgentAvailabilityReason`（`agentSupport.ts:52`）加一枚；`BuildHostAgentRegistryInput` 加 `probeCredentials: () => boolean`（与 `probeEntry`/`prepareHome` 同构的注入，保持 F14"叶子模块不 import fs 模块"）；`describeHostAgentReason`（`:151-160`）加第四个**互不包含的子串**（该函数注释明写"Three distinct substrings on purpose"）。
- 短路顺序：`flag_off → credentials_missing → entry_missing → home_prepare_failed`（凭据检查在 entry 探测之前，因为它更便宜且更常见）。
- **否决"复用 `home_prepare_failed`（让生成器在无凭据时 throw）"**：零新增 wire 面确实诱人，但支持日志里"isolated Codex home could not be prepared"对"没登录"是误导性归因，正是那三个 distinct 子串存在的理由。四行代码换一条正确的归因，值。
- **Claude 侧不动 `available:true`**（`agentSupport.ts:97`）。理由：把 Claude 变成可不可用会波及所有假定"Claude 恒在"的 renderer 路径，blast radius 与本轮不成比例；Claude 的凭据态改由 `host.ready.payload.settings`（`index.ts:349-358` → `HostStatusBanner.tsx:86-93` / `contextSurfaceModel.ts:185-211`）已有的 `hasAuthToken`/`authTokenType` 诊断位表达。App 级门禁（§2.D）才是登出的正门，Host 级是纵深防御。
- **注册表记忆化与凭据轮换的耦合**：`ensureHostAgentRegistry` 是进程级单飞记忆（`agentSupport.ts:132-137`，F1 不变量"广播列表与执行列表永不漂移"）。因此**「Host 进程生命周期 == 凭据纪元」**成为一条显式不变量：任何登录/登出/凭据失效都必须 `agentHostManager.shutdown()`（`AgentHostManager.ts:301-308`），下次 `ensureStarted` 重建。这条同时解掉 `ensureRuntime()` 永久缓存 runtime（`index.ts:130-131`）导致的凭据不刷新问题。
- **需要 [实测]**：app-server（非 `codex exec`）在缺 `env_key` 时的具体报错帧形状——agent-1 风险 #7 明确标为未证实。列入 S0 spike（E4）。

---

### C. 凭据存储选址与格式

**裁定：`<userData>/credentials/vault.json`，0600 + 原子写，单写手 `CredentialVault`（Main），safeStorage 可用时加密、不可用时明文降级并上报诊断位。**

Vault schema（`[假设]` 字段集，施工时以实际响应体为准）：
```jsonc
{
  "version": 1,
  "enc": "safeStorage" | "none",
  "lastEmail": "x@jcdz.cc",          // 登出后保留（非机密）
  "identity": { "email": "...", "userId": 123, "issuedAt": "ISO" },
  "cchBaseUrl": "https://...",        // deriveCchBaseUrl 的结果，落库不重算
  "claude": { "baseUrl": "https://.../v1", "authToken": "..." },
  "codex":  { "baseUrl": "https://.../v1", "apiKey": "..." },
  "invalidatedAt": null               // 服务端 401/403 判失效时打戳
}
```

**为什么 `userData` 而不是 `~/.aiclient`**：

| 否决项 | 理由（带证据） |
|---|---|
| `~/.aiclient/` | ① 它是**本机 Electron + 远程 SSH helper 共用的命名约定**（`RemoteHelperSource.ts:35-36` 硬编码 `.aiclient/settings.json`），凭据放进去迟早有人为"远程也要看到登录态"把它塞进 `getRemoteServerSource()` 的字符串模板——agent-3 §2.5 已预警；② 它的写手 `atomicWriteJson`（`SharedSessionState.ts:49-54`）**不传 `mode`**，落盘吃 umask（Linux 常见 0644），比 `OnboardingService.ts:305-308` 现有的 0600 先例还弱；③ 无 profile 隔离，dev 构建与 packaged 构建抢同一份凭据；④ 模块级缓存无跨进程失效（`clearSharedStateCache` 全仓零调用点） |
| 复用 `SharedSessionState` 的 settings.json | 浅合并（`main/ipc/settings.ts:69-75`）已经造成登出抹除 email 的既有坑（`OnboardingService.ts:183`，agent-2 §3）；500ms 防抖 + 5s flush（`settings.ts:10-17`）对凭据这种"写完必须立刻可读"的数据是错误的写语义 |

**safeStorage 裁定：接入，但降级路径必须显式。**
- `isEncryptionAvailable()` 为 false（Linux 无 libsecret/kwallet 的场景）⇒ `enc:"none"` + 0600 + 在支持诊断里打一个 `credentialEncryption: 'unavailable'` 位。这就是今天的安全档位，不比现状差。
- 解密失败（Windows DPAPI 换机/换系统账户、macOS keychain 拒绝）⇒ **一律判为"已登出"，绝不崩溃**。重登成本 = 邮箱+验证码约 30 秒，对内部工具完全可接受。
- 收益：Windows/macOS 上零成本拿到真加密；代价：一个分支 + 一次轮换迁移。

**务实安全档位声明（写进规格，避免后续争论）**：
> 本方案防的是**偶然泄露**（误发的日志/截图、备份与同步工具捞走明文、其他登录用户读到 0644 文件、卸载残留），**不防**本机恶意软件与有本机权限的攻击者。理由是结构性的：这把 key 的用途就是被交给 `claude`/`codex` 子进程和员工自己的 shell，任何"本机攻击者"威胁模型在设计上就已经输了。因此不追求 keychain-only、不追求进程内存保护，追求的是"只有一个地方有明文、权限最小、不会被顺手同步走"。

**其余存储裁定**：
- **dev/prod 三套路径分裂**：`scripts/dev.js` 维持现状（D42 已定），但 **dev.js 在设置自己的 `CLAUDE_CONFIG_DIR` 时必须同时强制 `AICLIENT_MANAGED_CREDENTIALS=0`**，否则 Main 的全局赋值会盖掉 dev 隔离目录。一行，写进 `buildChildEnv`（`dev.js:173-224`）。想在 dev 里演练托管路径就不给 `dev.env`、走真实登录。
- **卸载留存**：`electron-builder.yml` `nsis.deleteAppDataOnUninstall:false` ⇒ 凭据在卸载后仍留在 `%APPDATA%\AiClient`。**不改这个开关**（改了会连带删除 todo.db、窗口状态、codex/claude 历史）。改为：把"登出"定为清除凭据的正规手段，并在 §3 登记该残留。
- **远程 SSH 明确排除**：本方案**不向远程主机推送任何凭据**。远程会话里的 `claude`/`codex` 继续吃远程机自己的 `~/.claude` / `~/.codex`。这条要写进规格的显式排除声明，位置紧挨 `RemoteHelperSource.ts` 的引用。

---

### D. 登录态模型与 UI

**D1 三态与真源**

| 态 | 判定 | 真源 |
|---|---|---|
| `signed_out` | Vault 不存在 / 已清除 / 解密失败 | **纯本地**，确定性 |
| `authenticated` | Vault 存在且结构完好，且最近一次服务端交互未被拒 | 本地 + 服务端否决权 |
| `credentials_invalid` | Vault 存在，但服务端明确拒绝（cch 401/403），或结构损坏 | **服务端为准** |

**关键论证**：今天 `checkCredentialsHealth()`（`OnboardingService.ts:578-628`）只做文件形状检查，**结构上不可能发现被吊销的 key**——这正是 `Root.tsx:399-404` 注释里那个 0.2.56 事故（"settings.json 存在但 env 被剥掉"）的成因，也是用户会在终端里撞上"无法调用 API"的原因。改成 Vault 之后，文件形状检查变成恒真（文件是我们自己写的），**唯一有意义的失效信号只能来自服务端**。

**服务端信号的现成载体：`UsageService`。** `UsageService.getStats()` 已经在 5 分钟轮询（`useUsageStats.ts`）、已经直连 bearer、已经在 401/403 时降级走 `POST {cch}/api/auth/login` 换 cookie 重试（`UsageService.ts:206-249, 85-108`）。**当 bearer 401/403 且 login 重试也失败 ⇒ 这把 key 已经不被 cch 认了**——这是一个零新增服务端契约、已经在跑的心跳。裁定：把这个判定接出来喂给 `AuthStateService`。

第二信号源（后置切片）：agent-host 侧网关 401 的错误帧——形状待 [实测]（S0 spike E5）。

**D2 门禁双镜像收敛**

- 新 `AuthStateService`（Main）暴露 `getState(): AuthState` 同步方法 + `onChange` 事件。
- `Root.tsx` 的四个 query：`onboardingState` + `onboardingCredentialsHealth` **合并成一个 `authState`**（`Root.tsx:138-142,160-165`），`cliStatus`/`claudeRuntimeStatus` 保留（它们查的是运行时能力不是登录态）。
- `MainWindow.isAppMountedFor()`（`MainWindow.ts:28-35`）改成 `authStateService.getState().status === 'authenticated' && APP_MOUNTABLE_RUNTIME_KINDS.has(...)`——**同一个服务，不再是两份判定逻辑**。
- 推送替代轮询：新增 `auth.stateChanged` 推送通道。这直接解掉 agent-2 §4 指出的"`App.tsx:162-176` 只弹 toast 不路由、用户对着失效终端干等到下次 Root 求值"的洞——收到 `credentials_invalid` 推送即路由。
- 一次性推送 `ONBOARDING_LIVE_CREDENTIALS_STATUS`（`main/index.ts:428-439`，`credentialStatusSent` 只发一次）**退役**，由持续的 `auth.stateChanged` 取代。

**D3 `SKIP_ONBOARDING_GATE` 收回时机**

`devFlags.ts:10` 硬编码 `true`，其注释自己写着"ONLY flip to false when explicitly validating the onboarding/login feature itself"——**D47 就是那个 feature**。裁定：在 S5（门禁切片）**把常量换成 env 可控的 dev 逃生舱**：

```ts
// AICLIENT_SKIP_AUTH_GATE=1 → 保留今天的旁路（团队线点验用）
// 默认：门禁生效
```

这会让每次 dev 启动都需要登录（除非设 env），属于影响全队工作流的改变 ⇒ 进 §4 用户拍板项。

**D4 UserProfileCard / 重新登录入口**

- 头像旁加状态芯片三态：`已登录 <email>` / `凭据已失效 · 点击重新登录`（可点，destructive 色）/ `未登录 · 点击登录`。今天的问题是所有 usage 报错一律落到"暂不可用"文案（`UserProfileCard.tsx:85-119`），对用户零区分度。
- 复用现成事件总线 `aiclient:onboarding:open`（`UserProfileCard.tsx:137` → `Root.tsx:231-240`），但**先把两处硬编码的事件名与两处 `queryKey:['onboardingState']`（`Root.tsx:139` / `WindowTitleBar.tsx:46`）提到 shared 常量**——agent-2 明确点名这是三态逻辑散布的遗漏源。
- 重新登录复用 `OnboardingView` 的 `initialStep='register-email'`（`OnboardingView.tsx:123-143`），新增一个**客户端** prop `reason: 'first_run' | 'expired' | 'signed_out'` 用于换文案（"登录已过期，请重新验证邮箱" vs "请登录"）。
  - **不往 `OnboardingErrorCode`（`shared/types/onboarding.ts:9-22`）加"会话过期"**：那是**服务端错误码契约**，客户端自己的状态原因不该混进去。
- 用量卡片鉴权源从 `readCodexApiKey()`（`UsageService.ts:63-79` 读 `~/.codex/auth.json`）改读 Vault，否则退役 `~/.codex` 后用量链直接失效（agent-1 风险 #1）。

**D5 登出语义**

```
logout() =
  1. terminateAllSessions()            （已有，onboarding.ts:14-36；顺带销毁所有本地 PTY —— 这正是回收"已注入 shell env 的 codex key"的唯一手段）
  2. agentHostManager.shutdown()       （新增，AgentHostManager.ts:301-308 —— 把凭据从 host 进程 env 里带走）
  3. vault.clear({ keepLastEmail: true })
  4. 重新生成 claude-home / codex-home 的空凭据版配置（不是删目录：历史与信任标志要留）
  5. clearServerAuthCookie(cchBaseUrl) （已有，onboarding.ts:38-45）
  6. 推 auth.stateChanged('signed_out')
```
- **保留邮箱记忆**：Vault 自有 `lastEmail` 字段，`clear()` 显式保留。这绕开了 `mergeSettingsPatch` 浅合并抹除 `onboarding.email` 的既有坑（`OnboardingService.ts:183` + `settings.ts:69-75`）——不是去改深/浅合并语义，而是把这个状态搬出那个容器。
- **不做服务端 revoke**：单账号内部工具，登出是本机行为；服务端吊销会把员工的其他机器一起踢下线。作为被否选项登记。

---

### E. 服务端契约

**E1 对 onboard 服务的最小接口要求清单**

| # | 要求 | 状态 |
|---|---|---|
| 1 | `POST /api/onboarding/send-code {email}` 对**已注册**邮箱同样发码，不因"已注册"拒绝 | 需实证 |
| 2 | `POST /api/onboarding/verify-and-register {email, code}` 对**已注册**邮箱**幂等**：返回**同一把** `data.apiKey` / `config.claude.authToken` / `config.codex.apiKey` | **需实证（D47 ③ 的核心假定）** |
| 3 | 上述调用**不得轮换/吊销**该员工先前发出的 key（否则一台机器登录会把另一台踢下线，且 cch 侧映射断裂） | **需实证** |
| 4 | 响应体形状不变（`shared/types/onboarding.ts:45-58`），`user.id` 稳定 | 需实证 |
| 5 | 错误码集合不变（`OnboardingErrorCode`，`:9-22`） | 已知 |

**E2 幂等假定的实证方法（S0 spike E1，必须先于 S1 施工）**

对一个**白名单内的测试邮箱**（`@jcdz.cc`/`@wuhanjingce.com`，`OnboardingService.ts:16`）跑：

1. 首次 `send-code` + `verify-and-register` → 记 `K1 = {apiKey, claude.authToken, codex.apiKey, user.id}`，落 trace（规范 §2）。
2. 隔 ≥1 分钟，再次 `send-code` + `verify-and-register` → 记 `K2`。
3. 断言 `K1 === K2`（逐字段）。
4. **反向验证吊销**：用 `K1.apiKey` 打 `POST {cch}/api/auth/login {key}`（`UsageService.ts:85-108` 的现成端点）→ `ok:true` 说明旧 key 仍有效，未被第 2 步轮换。
5. 变体：第 2 步与第 1 步**用不同的机器/IP** 各跑一次，验证服务端没有做 device binding。

若无法拿测试账号，退路：向 onboard 服务负责人索取该 handler 的 upsert 逻辑（"已存在则读取 vs 已存在则重新签发"一句话即可定论）。**这属于要跟外部团队打交道，进 §4 用户拍板项。**

**E3 假定不成立时的 fallback 接口形状（最小改）**

```
POST /api/onboarding/login-verify
  body: { email, code }
  200 { ok:true, data:{ user:{id,name}, apiKey,
                        config:{ claude:{baseUrl,authToken}, codex:{baseUrl,apiKey} } } }
  4xx { ok:false, error:'USER_NOT_FOUND' | 'CODE_INVALID' | 'CODE_EXPIRED' | ... }
```
语义硬约束：**只校验验证码 + 回发该员工既有 key；绝不创建账号、绝不轮换 key**。响应体与 `verify-and-register` **同构**，因此客户端只需换 URL，`getCredentialWriteInputs`/Vault 写入逻辑完全复用。

客户端端点选择：
```
已知 lastEmail 或 vault.identity 存在 → /login-verify
                                        ↳ USER_NOT_FOUND → 回落 /verify-and-register（覆盖服务端账号被清的情况）
否则（首次安装）                        → /verify-and-register
```
`OnboardingErrorCode` 增补 `USER_NOT_FOUND`（`shared/types/onboarding.ts:9-22`），`describeOnboardingError`（`OnboardingView.tsx:39-75`）加中文映射。

**E4 顺带固化的契约细节**：`deriveCchBaseUrl`（`OnboardingService.ts:557-563`，剥 `/v1` 后缀）的结果必须**落进 Vault 的 `cchBaseUrl`**，不要在 UsageService / 失效探测里各算一遍——今天 `OnboardingState.serverUrl` 就是它，改后由 Vault 承载。

---

### F. 存量迁移与兼容

**F1 迁移策略：一次性「收编（adopt）→ 中和（neutralize）」，非破坏性，分两片走。**

存量机器上有：`~/.claude/settings.json`（app 写的 3 键 + hooks + statusLine + 可能有用户自己的键）、`.bak`、`~/.claude.json`、`~/.codex/{config.toml,auth.json}`（+`.bak`）、`~/.aiclient/settings.json.onboarding`。

**收编**（flag on 且 Vault 不存在时，一次）：
```
vault.claude ← ~/.claude/settings.json .env.{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}
vault.codex  ← ~/.codex/auth.json .OPENAI_API_KEY  +  config.toml [model_providers.jyw].base_url
vault.identity/lastEmail ← ~/.aiclient/settings.json .onboarding.{email, serverUrl, registeredAt}
写 marker <userData>/credentials/.migrated-v1（marker 约定沿用 SharedSessionState.ts:10-12）
```
→ **升级的员工不需要重新登录**。这条很重要：一次强制全员重登对内部工具是一次支持事件。

**中和**（外科式删键，绝不删文件）：
- Claude：只删 `env` 里 app 自己写的三个键 —— 与 `removeClaudeCredentials()`（`OnboardingService.ts:481-483`）的键集完全一致；`hooks`/`statusLine`/用户自有键**逐字节保留**；写前先 `.bak`（沿用 `:265` 的既有约定）。
- Codex：只删 `auth.json` 的 `OPENAI_API_KEY` 字段（**保留文件**，里面可能有 codex 自己的 ChatGPT 登录 token）；`config.toml` 只移除 `[model_providers.jyw]` 表 + 当 `model_provider == "jyw"` 时清掉该行。
- ⚠️ **今天的 `removeCodexConfig()`（`OnboardingService.ts:489-504`）是 `fs.rmSync` 整删两个文件**——对用户自有的 codex 配置是破坏性的，属既有 bug，本轮一并修掉，登出与迁移共用新的外科删除实现。
- `~/.claude.json`：只在其 `hasCompletedOnboarding` 是 app 写的（`:451-470`）时不动它——这个键无害且用户可能靠它，**留置**。托管 home 里另有一份自己的。

**F2 升级路径 & 回退安全态**

flag 采用 `AICLIENT_MANAGED_CREDENTIALS`（`'1'` 才是 on，严格读法照抄 `resolveCodexEnabled`，`agentSupport.ts:42-44` 的理由同样成立）。

| flag | 行为 |
|---|---|
| **off** | **与今天逐字节一致**：OnboardingService 写 `~/.claude`/`~/.codex`；Main 不设 `CLAUDE_CONFIG_DIR`；codexHome 走投影 + auth.json 拷贝；Root 走老四 query 门禁 |
| **on** | 全新链路 |

**回退安全态的诚实定义**（写进规格）：
> flag 关掉后代码路径回到今天；但若中和步骤已跑过，`~/.claude`/`~/.codex` 里已无凭据 ⇒ **回退需要一次重新登录**（约 30 秒，flag-off 的登录流程会重新写回旧文件）。Vault 本身不被 flag-off 触碰，所以再翻回 on 是即时恢复。

为了让**第一轮 on 完全无风险**，S1~S4 期间保持 **双写**（Vault + 旧文件同写），中和步骤推迟到 S6；S6 之前任何时刻 flag-off 都是零成本回退。

---

### G. 施工切法与验证

按规范 §12「先定验证、后改代码」，每片顺序恒为：Happy Path → 过程断言 → 用例 → flag → 逻辑。每片独立可落地、门禁绿（本机内存有限，门禁**逐门串行**跑）。

**回归三层**
- **Smoke**（每次提交，秒级、无网络）：Vault 读写/清除/降级、两个生成器的产物快照、`AuthState` 状态机迁移表、`describeHostAgentReason` 四子串互不包含。
- **主回归**（合并前，flag 双轮）：S2/S3/S4 的 Happy Path + 真起一次 agent-host、真开一个 PTY。
- **事故回归**（永久资产）：① 0.2.56「settings.json 只剩 hooks」（`Root.tsx:399-404` 注释所记）；② `model_context_window` 写错层级被静默丢弃（agent-1 §3 [实测]）；③ 「已登出但终端仍持有凭据」；④ safeStorage 在 Linux 不可用；⑤ 「App 层判未登录但 Host 层仍报 codex supported」的口径不一致（agent-1 风险 #2）。

失败分类标签（规范 §14）沿用并补三个本域标签：`cred_missing` / `cred_invalid` / `injection_miss`（凭据没到子进程）。

版本戳（规范 §15）：每次评测报告带 git commit + `AICLIENT_MANAGED_CREDENTIALS` 位置 + vault schema version + 生成器模板 hash。

（切片明细见 §5 表。）

---

## §3 风险与开放问题

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | **Claude CLI 是否真从 `$CLAUDE_CONFIG_DIR` 读 `.claude.json`**（信任/首启向导）——`scripts/dev.js:148-169` 的用法是强证据但非 packaged 条件下的实证 | 高（不成立则员工首启弹向导，违背"零感知"） | S0 spike E2；不成立则退回"仍写 `~/.claude.json`"并在规格里显式承认边界不含该文件 |
| R2 | **SDK `settingSources: []`（`claudeRuntime.ts:745`）语义**——是否连 `$CLAUDE_CONFIG_DIR/settings.json` 的 `env` 也一并忽略 | 中（忽略也无妨：agent-host 自己把文件读成 `options.env`，但要确认没有"CLI 内部另读一遍并覆盖"的行为） | S0 spike E3：在 `~/.claude` 不存在的环境跑一次完整会话 |
| R3 | **终端 env 可见性不对称**：Claude 走文件（shell 里看不到 token），Codex 走 `AICLIENT_CODEX_API_KEY`（`printenv` 可见、泄漏给该 shell 所有子进程） | 中 | 变量名自定义（不撞标准名）已消掉"错投给别的服务"的主要危害；登出销毁所有 PTY 回收；写进安全档位声明 |
| R4 | **会话历史双源**：老 `~/.claude/projects` 与托管 home 并存，排序/去重/续接需处理；`~/.aiclient/claude-null` 这个只有读者没有写手的候选路径悬着（agent-0 `[未证实]`） | 中 | 只读双源 + `resolveClaudeConfigDirForResumeSession`（`App.tsx:122-151`）扩候选；本轮判死 claude-null |
| R5 | **卸载残留凭据**（`nsis.deleteAppDataOnUninstall:false`） | 低 | 不改该开关（会连带删历史/todo.db）；登出为正规清除手段；登记 |
| R6 | **safeStorage Linux 退化为明文** | 低 | 显式 `enc:'none'` + 0600 + 诊断位；等同现状基线 |
| R7 | **codex 私有 home 被 app 会话与终端会话并发使用**（共享 thread history 目录） | 低 | 与 codex 对 `~/.codex` 的原生并发场景同构，不比 stock 差 |
| R8 | **`ClaudeProviderManager` 的 renderer 消费组件未定位**（agent-0 `[未证实]`）——不确认就删有回归风险 | 中 | S2 前置排查项；有消费者则降级为诊断只读，无则整模块删 |
| R9 | **Vault 的多实例竞争**：单实例锁（`main/index.ts:223`）覆盖同 userData 的并发；但 portable 版与安装版的 userData 是否同一路径未证实 | 低 | 登记；原子写 + last-writer-wins 已够 |
| R10 | **无服务端 key 轮换手段**：key 泄漏时只能在 cch 侧人工处理 | 低（内部工具） | 登记；不在本轮解 |
| R11 | **`model_context_window`/`auto_compact` 若启用会同时改变模型行为**，与凭据改造混在一片会破坏可对比性 | 中 | 本轮不写（行为中性），另立开放问题 |
| O1 | **开放**：onboard 服务是否幂等（D47 ③ 的核心假定）——**卡住 S1 之后所有片的形状** | — | S0 spike E1 |
| O2 | **开放**：app-server 层无凭据的报错帧形状（agent-1 风险 #7） | — | S0 spike E4 |
| O3 | **开放**：cch 401/403 的可区分性（是否能把"key 被吊销"与"网络/服务端错"分开） | — | S0 spike E5 |

---

## §4 需要用户拍板的点

> 只列真正属于用户（而非设计者）的决定。

**U1. 存量机器上 `~/.claude` / `~/.codex` 里的旧凭据：清除还是留置？**
- **我的推荐：清除（外科式删键，留 `.bak`，附一次性提示）。**
- 理由：D47 ⑤ 的表述是"不再写"，但只"不再写"而不清理，等于每台老机器上永远躺着一把可能已轮换的 key，凭据权威没有真正收敛；且它会让 flag 双轮的对比失真（off 轮靠旧文件也能跑通，掩盖 on 轮的注入缺陷）。
- **代价（这是需要您拍的部分）**：如果有员工习惯**在 AiClient 之外的系统终端里直接跑 `claude`/`codex`**，清除后他们那条路径会断（除非再去 AiClient 里开终端）。您比我更清楚有没有这种用法。

**U2. `SKIP_ONBOARDING_GATE` 何时收回？**
- **我的推荐：在 S5（门禁切片）收回，同时提供 `AICLIENT_SKIP_AUTH_GATE=1` 逃生舱给团队线点验。**
- 理由：`devFlags.ts:4-9` 的注释自己写着"只在验证登录功能本身时才翻"，D47 就是那个功能；不收回则新门禁的两轮 flag 验证没有任何意义（永远走旁路）。
- **代价**：收回后每次 dev 启动默认要登录，除非开发者记得设 env。影响全队日常工作流。

**U3. 是否允许对一个真实/测试员工账号跑「幂等实证」，以及是否能向 onboard 服务方提需求？**
- **我的推荐：允许（用白名单内的一次性测试邮箱），并预先跟 onboard 服务方打招呼备一个 `login-verify` 端点。**
- 理由：D47 ③ 整条设计压在"verify-and-register 对已注册邮箱幂等"这个**未经验证的假定**上。若不成立且不能改服务端，那么"登录"在无密码前提下就无法与"重新签发 key"分离——会反过来影响 ④单账号的语义（多机登录互踢）。这是整个方案的单点风险。
- **代价**：需要跟外部团队协调，可能有排期。

**U4. `model_context_window = 1000000` / `model_auto_compact_token_limit = 9000000` 是否要"第一次真正生效"？**
- **我的推荐：本轮不启用**（保持行为中性），单独立一个开放问题，用一次真实网关回合实测后再定。
- 理由：agent-1 [实测] 证明这两个键从上线至今写在 `[model_providers.jyw]` 下被 codex 静默丢弃 ⇒ **今天生效的行为就是"不存在"**。挪到 root 让它们生效，是在改凭据管道的同一片里改模型的上下文窗口和自动压缩阈值，两个变量一起动，一旦出问题无法归因。而且 `auto_compact_limit(9M) > context_window(1M)` 这个组合语义上等于"永不自动压缩"，值不值得开需要证据。
- **代价**：某人当初设这两个值的意图会继续悬空一段时间。

**U5.（可选，若您有偏好）内置终端里的 codex 接受 app 强制的 approval/sandbox posture 吗？**
- **我的推荐：接受（app 与终端共用一个 codex home）。**
- 理由见 §2.B3；若您认为终端里必须让用户自选权限档，我改成第二个生成 home（成本：两份历史 + 两处生成逻辑）。

---

## §5 施工切片表

| 片 | 内容 | Happy Path（"跑对了应该怎么流"） | 关键过程断言（确定性优先） | flag 双轮 | 依赖 |
|---|---|---|---|---|---|
| **S0**<br>spike | 六项实证，**不动产品代码**：E1 onboard 幂等（§E2 五步）· E2 `$CLAUDE_CONFIG_DIR/.claude.json` 信任标志 · E3 SDK `settingSources:[]` + 无 `~/.claude` 完整会话 · E4 codex **app-server**（非 exec）缺 `env_key` 的报错帧形状（复用 `src/agent-host/spikes/s1-codex-direct-probe.ts` 驱动）· E5 cch 401/403 可区分性 · E6 三平台 `safeStorage.isEncryptionAvailable()` | 六份 trace + fixture 落 `docs/plans/`；E1 结论直接决定是否需要 S7 | 每项 spike 产出可回放的 JSON trace（规范 §2）；E4 的错误帧存成 fixture 供 S4 断言引用 | — | — |
| **S1**<br>Vault | `src/main/services/auth/CredentialVault.ts` + `AuthStateService`；登录流程**双写**（Vault + 旧文件），无消费者 | 邮箱+验证码登录成功 ⇒ Vault 文件生成（0600）且旧文件与今天逐字节一致；`getState().status==='authenticated'` | Vault 写恰好 1 次/登录；mode=0600；`clear({keepLastEmail:true})` 后 `lastEmail` 在、secret 字段消失；`enc:'none'` 分支产出诊断位；**捕获 logger 断言无任何日志行含 secret 子串**（沿用 `codexHome.ts:93-98` 的 T-35 口径） | on/off 均跑（off 时 Vault 不写） | S0-E1 |
| **S2**<br>Claude home | `ClaudeHomeGenerator` + Main 全局 `CLAUDE_CONFIG_DIR` + 剥离继承 `ANTHROPIC_*`；删 `ClaudeRuntimeConfig` 两写手 + `CLAUDE_PROVIDER_APPLY`/watcher；historyReader 双源；**前置：定位 ProviderManager 的 renderer 消费者** | flag on + 已登录 ⇒ 一次 Claude SDK 会话正常出字；`host.ready.settings.settingsPath` 指向托管 home 且 `hasAuthToken=true`；全程 `~/.claude/settings.json` 的 mtime 不变 | ① 一次会话期间对 `~/.claude*` 的写调用数 == 0（fs 写手打桩计数）；② `isClaudeInstalled()` 为 true 且四个 hook 落在托管 home；③ IDE bridge lockfile 落托管 `ide/`；④ 生成的 settings.json 含 `skipWebFetchPreflight`/`autoUpdates:false` 与生成抬头；⑤ 历史列表同时含新旧两源 | on：托管；off：写 `~/.claude`（今天行为） | S1, S0-E2/E3 |
| **S3**<br>终端注入 | PTY 注入：Claude 侧靠全局 `CLAUDE_CONFIG_DIR` 自动继承；Codex 侧 **Main 端**在 `SessionManager.createLocal`（`SessionManager.ts:374-381`）补 `CODEX_HOME` + `AICLIENT_CODEX_API_KEY`；`resolveClaudeConfigDirForResumeSession`（`App.tsx:122-151`）加托管候选 | 开一个内置终端 ⇒ 敲 `claude` 直接可用（无向导、无登录提示）；敲 `codex exec` 直接可用 | ① PTY spawn options 里两个 codex 键存在；② **session-create 的 IPC payload 不含任何 secret**（renderer 永不见明文——断言 payload 形状）；③ 登出态下两键缺席；④ `AgentTerminal.tsx:364-366` 的 renderer 侧 `CLAUDE_CONFIG_DIR` 不覆盖托管值（除非续接老会话） | on/off | S2 |
| **S4**<br>Codex 生成 | `generateCodexConfig()` 取代 `projectCodexConfig`；删 auth.json 拷贝链（`AUTH_BASENAME`/`authCopied`/mtime 分支）；`codexRuntime.ts:1389` env 加 key；`hostEnv.ts` 契约加 `codexApiKey`；`agentSupport.ts` 加 `credentials_missing` | flag on + 已登录 ⇒ codex 会话 `turn/start` 成功，且 `<userData>/codex-home` 下**不存在 auth.json**；登出 ⇒ `session.create` 收到 `agent_unsupported`，message 含 credentials 子串 | ① 生成 toml：root 有 posture 两键、**无** `model_context_window`；provider 表有 `env_key`+`requires_openai_auth=false`；② 目录内无 `auth.json`；③ 四个 `describeHostAgentReason` 子串两两互不包含；④ `hostEnv.test.ts` 断言新键在/旧四键不变；⑤ 无凭据时报错帧匹配 S0-E4 fixture | on：生成；off：投影+拷贝（今天行为） | S1, S0-E4 |
| **S5**<br>登录态与门禁 | `auth.getState`/`auth.stateChanged`；Root 四 query→二；`MainWindow.isAppMountedFor` 改读同服务；UsageService 401/403→失效信号 + 改读 Vault；UserProfileCard 三态；事件名/queryKey 提 shared；`SKIP_ONBOARDING_GATE`→`AICLIENT_SKIP_AUTH_GATE`；logout 六步 | ① 全新机器：启动→登录界面→登录→App 挂载；② 运行中 key 被服务端吊销：一个 usage 轮询周期内状态翻 `credentials_invalid`，UserProfileCard 变可点，点击进重新登录且**预填邮箱**；③ 登出：所有会话消失、agent-host 退出、托管 home 内无 secret、重登预填邮箱 | ① Root 与 MainWindow 两处判定**来自同一服务**（测试里替换该服务即同时改变两处）；② 每次状态迁移恰好推 1 次；③ 登出后扫描两个托管 home 的生成文件，secret 字节数 == 0；④ `logout` 调用序列断言（terminate→shutdown→clear→regen→cookie→push）；⑤ 失效态 UI 的 reason 文案与 `expired`/`signed_out` 一一对应 | on/off | S1~S4 |
| **S6**<br>迁移与中和 | 收编（adopt）+ 外科式中和 + marker；**停止双写**；修 `removeCodexConfig` 的 rmSync 破坏性删除 | 一台带旧凭据的机器升级后**直接进 App，无需重登**；`~/.claude/settings.json` 保留 hooks/statusLine/用户自有键、丢掉 3 个 app 键、旁边有 `.bak`；`~/.codex/config.toml` 保留非 jyw 表 | ① marker 保证只跑一次；② 中和前后 `hooks` 数组逐字节相同；③ 用户自有 env 键保留；④ `auth.json` 文件仍在、仅 `OPENAI_API_KEY` 消失；⑤ 无凭据的机器上迁移是 no-op | on：迁移；off：不迁移（回退安全态见 §2.F2） | S5 |
| **S7**<br>（条件） | **仅当 S0-E1 证伪幂等**：`login-verify` 端点对接 + 端点选择逻辑 + `USER_NOT_FOUND` 错误码 + 中文映射 | 已注册员工在新机器上登录 ⇒ 拿回**同一把** key，旧机器不掉线 | ① 已知邮箱走 `login-verify`、首次走 `verify-and-register`；② `USER_NOT_FOUND` 自动回落；③ 两条路径写入 Vault 的字段集相同 | on/off | S0-E1 结论 + 服务端排期 |

**关键路径**：S0-E1 是整条链的前置闸门（决定有没有 S7、决定"登录"语义能否与"注册"分离）；S0-E2/E3 决定 §2.A 主干是否成立（不成立要退回混合形态）。建议 S0 单独先跑，出结论后再冻结规格。

---

**引用到的仓库文件（绝对路径）**：
`/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts`、`/home/dan/projects/ai-client/src/agent-host/claudeSettings.ts`、`/home/dan/projects/ai-client/src/agent-host/index.ts`、`/home/dan/projects/ai-client/src/agent-host/agentSupport.ts`、`/home/dan/projects/ai-client/src/agent-host/codexHome.ts`、`/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts`、`/home/dan/projects/ai-client/src/agent-host/claudeRuntime.ts`、`/home/dan/projects/ai-client/src/agent-host/historyReader.ts`、`/home/dan/projects/ai-client/src/main/services/agent-host/hostEnv.ts`、`/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts`、`/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostProcess.ts`、`/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts`、`/home/dan/projects/ai-client/src/main/services/claude/ClaudeIdeBridge.ts`、`/home/dan/projects/ai-client/src/main/services/claude/ClaudeProviderManager.ts`、`/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts`、`/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts`、`/home/dan/projects/ai-client/src/main/services/terminal/PtyManager.ts`、`/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts`、`/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts`、`/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts`、`/home/dan/projects/ai-client/src/main/ipc/onboarding.ts`、`/home/dan/projects/ai-client/src/main/ipc/settings.ts`、`/home/dan/projects/ai-client/src/main/index.ts`、`/home/dan/projects/ai-client/src/main/windows/MainWindow.ts`、`/home/dan/projects/ai-client/src/renderer/Root.tsx`、`/home/dan/projects/ai-client/src/renderer/App.tsx`、`/home/dan/projects/ai-client/src/renderer/components/user/UserProfileCard.tsx`、`/home/dan/projects/ai-client/src/renderer/components/onboarding/OnboardingView.tsx`、`/home/dan/projects/ai-client/src/renderer/components/chat/AgentTerminal.tsx`、`/home/dan/projects/ai-client/src/shared/devFlags.ts`、`/home/dan/projects/ai-client/src/shared/types/onboarding.ts`、`/home/dan/projects/ai-client/scripts/dev.js`、`/home/dan/projects/ai-client/electron-builder.yml`、`/home/dan/projects/ai-client/docs/plans/openchamber-chat-refactor-ledger.md`（D47 原文在 :91）。