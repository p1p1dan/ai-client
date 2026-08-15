> D47 双轨双盲设计案 · B 轨（Codex gpt-5.4，session 01a005a5，2026-08-15）。原文归档，未经编排者改写。
> 与 A 轨（Opus）互为盲评；合取结果见 2026-08-15-login-management-design-spec.md。

§1 总架构

结论：D47 应落成一个由 Electron 主进程独占的“登录态与凭据域”，Renderer、Claude/Codex 运行时、内置终端都只能消费主进程发布的状态或临时注入的环境变量，不再直接读写用户真实的 `~/.claude`、`~/.codex`，也不再让敏感 key 穿过 Renderer IPC。

整体关系如下：

```text
邮箱 + 验证码
    │
    ▼
Onboard 服务
send-code / verify-and-register
    │
    │ 返回员工既有 key 与 Claude/Codex 网关配置
    ▼
AuthSessionService（Main，唯一真源）
    ├── CredentialStore
    │     └── <userData>/auth/credentials.v1.json
    │
    ├── AuthStateSnapshot
    │     └── signed_out / signed_in / reauth_required
    │
    ├── ClaudeRuntimeEnvFactory
    │     ├── SDK agent-host：凭据 env
    │     └── 内置终端：凭据 env + CLAUDE_CONFIG_DIR
    │
    ├── CodexRuntimeEnvFactory
    │     ├── app-server：专用 env_key + CODEX_HOME
    │     └── 内置终端：专用 env_key + CODEX_HOME
    │
    └── Sanitized IPC
          └── Renderer 只看到账号、状态、原因，不看到 key
```

核心组件职责建议如下。

| 组件 | 进程 | 职责 |
|---|---|---|
| `AuthSessionService` | Main | 登录、登出、三态状态机、在线失效判定、状态事件、子进程启动授权 |
| `CredentialStore` | Main | `<userData>` 下的凭据原子读写、权限控制、可选 `safeStorage` 封装 |
| `OnboardClient` | Main | `send-code`、`verify-and-register` 或 fallback 登录接口 |
| `ManagedClaudeHome` | Main/Host | 生成 `<userData>/claude-home`，保存非敏感设置、hooks、history、IDE lock、trust 状态 |
| `ManagedCodexHome` | Host | 生成 `<userData>/codex-home/config.toml`，保留 Codex history，但不生成 `auth.json` |
| `RuntimeEnvFactory` | Main/Host | 按 Claude、Codex、终端分别构造最小必要环境变量，禁止跨 provider 凭据泄漏 |
| `AuthGate` | Renderer | 只渲染主进程发布的三态；不自行读取文件或从 usage 请求反推状态 |
| `AuthStateSnapshot` | Main | 同步内存快照，供 Renderer IPC 与 `MainWindow.isAppMountedFor()` 共用 |

建议的凭据文件逻辑格式：

```json
{
  "version": 1,
  "protection": "safe-storage-v1",
  "payload": "<base64 ciphertext>"
}
```

解密后的 payload：

```json
{
  "account": {
    "userId": 123,
    "email": "employee@jcdz.cc"
  },
  "onboardServiceUrl": "https://onboarding.example",
  "cchBaseUrl": "https://cch.example",
  "claude": {
    "baseUrl": "https://cch.example/v1",
    "authToken": "[SECRET]"
  },
  "codex": {
    "baseUrl": "https://cch.example/v1",
    "apiKey": "[SECRET]"
  },
  "receivedAt": "2026-08-15T00:00:00.000Z",
  "contractVersion": 1
}
```

如果本机不能提供真正的 OS 密钥后端，则：

```json
{
  "version": 1,
  "protection": "local-file-v1",
  "payload": {
    "...": "plaintext payload"
  }
}
```

目录必须为 `0700`，凭据文件必须为 `0600`，采用临时文件、`fsync`/关闭、原子 rename 的写入顺序。现有 onboarding 写入凭据时已有 `0700/0600` 的先例，但目标仍是用户真实 home：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:242)、[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:335)。

关键不变量：

1. key 只在 Main、agent-host、目标子进程和必要的远程 helper 进程内存中短暂出现。
2. key 不进入 Renderer、React state、DevTools、普通 IPC 返回值、日志或 trace。
3. `<userData>/claude-home/settings.json` 和 `<userData>/codex-home/config.toml` 都不包含 key。
4. 不写 `~/.claude/settings.json`、`~/.claude.json`、`~/.codex/auth.json`、`~/.codex/config.toml`。
5. `~/.aiclient` 继续用于共享设置/会话状态，不承载凭据；当前该目录还被 SSH helper 共用，不适合作为本机私密凭据权威：[SharedSessionState.ts](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:33)、[RemoteHelperSource.ts](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:35)。
6. 登录成功 IPC 返回 `account/status`，不返回服务端原始 credential payload。当前共享类型会把 Claude/Codex key 放在成功响应中，等于会经过 preload/Renderer，D47 必须切断这一面：[onboarding.ts](/home/dan/projects/ai-client/src/shared/types/onboarding.ts:44)、[index.ts](/home/dan/projects/ai-client/src/preload/index.ts:768)。

---

§2 各轴裁定（A–G，每轴：结论 + 依据 + 被否方案的否决理由）

### A. Claude 侧注入机制

#### 结论

采用“app 私有 Claude home + 凭据纯 env”的混合模式：

- SDK 会话：
  - `CLAUDE_CONFIG_DIR=<userData>/claude-home`
  - `ANTHROPIC_BASE_URL=<managed baseUrl>`
  - `ANTHROPIC_AUTH_TOKEN=<managed key>`
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
  - 凭据通过 SDK `options.env` 注入。
  - `settings.json` 不保存 `env` 凭据。

- 内置终端：
  - 注入同样的 Claude 凭据 env。
  - 注入 `CLAUDE_CONFIG_DIR=<userData>/claude-home`。
  - 因而用户在内置终端运行 `claude` 时，history、hooks、IDE lock、trust 状态进入 app 私有目录，但 key 仍只来自该终端进程的环境变量。

- app 私有 Claude home 负责：
  - `settings.json`：只存 hooks、状态栏、非敏感 Claude 配置。
  - `.claude.json`：首次使用和 workspace trust 标志。
  - `projects/`：会话 history。
  - `ide/`：IDE Bridge lock。
  - plugin、prompt、completion 等 app 自己要管理的 Claude 状态。

- 手动 Claude Provider：
  - D47 flag 开启时移除“创建、编辑、切换 provider”的交互面。
  - 可保留只读状态：“公司托管”“当前员工邮箱”“网关可用/不可用”，不得显示或返回 token。
  - flag 关闭时暂时保留旧面板，供第一轮回归比较。
  - `SessionBar`、`ActionPanel` 的 provider 快捷切换也必须在 managed-login 模式下关闭。

#### 依据

1. SDK 运行时明确配置了 `settingSources: []`，并将 `mergedEnv` 直接交给 SDK，因此 SDK 凭据必须是实际环境变量，不能只写进 `settings.json`：[claudeRuntime.ts](/home/dan/projects/ai-client/src/agent-host/claudeRuntime.ts:554)、[claudeRuntime.ts](/home/dan/projects/ai-client/src/agent-host/claudeRuntime.ts:741)。

2. 当前 agent-host 会读取 `CLAUDE_CONFIG_DIR/settings.json`，再把读取到的 env 写进整个 host 的 `process.env`：[claudeSettings.ts](/home/dan/projects/ai-client/src/agent-host/claudeSettings.ts:29)、[index.ts](/home/dan/projects/ai-client/src/agent-host/index.ts:133)。D47 应停止“从设置文件加载凭据”和“污染 host 全局环境”的旧路径，改成由 managed credential 显式生成每个 runtime 的 child env。

3. history reader 已支持显式 `claudeConfigDir`，其次才回退 `process.env.CLAUDE_CONFIG_DIR` 或 `~/.claude`，适合直接切向私有 home：[historyReader.ts](/home/dan/projects/ai-client/src/agent-host/historyReader.ts:240)。

4. 内置终端已经有 `SessionCreateOptions.env` 到 PTY 的透传链：
   - 类型：[session.ts](/home/dan/projects/ai-client/src/shared/types/session.ts:4)
   - Renderer 的 Claude config-dir 注入先例：[AgentTerminal.tsx](/home/dan/projects/ai-client/src/renderer/components/chat/AgentTerminal.tsx:362)
   - Main 最终合并进 PTY env：[PtyManager.ts](/home/dan/projects/ai-client/src/main/services/terminal/PtyManager.ts:377)。

5. hooks 的安装门禁目前把“Claude 已安装”错误等同于“配置目录存在”；私有目录如果没有提前创建，hooks 和 IDE Bridge 会被跳过：[ClaudeHookManager.ts](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:348)、[ClaudeIdeBridge.ts](/home/dan/projects/ai-client/src/main/services/claude/ClaudeIdeBridge.ts:680)。D47 必须将二者拆开：
   - CLI 是否安装：使用 CLI detector。
   - managed home 是否存在：AuthSessionService 初始化时主动创建。
   - hooks 是否应安装：由 managed-login 状态和功能设置决定。

6. IDE Bridge 已经尊重 `CLAUDE_CONFIG_DIR`，lock 文件可自然进入 `<userData>/claude-home/ide`：[ClaudeIdeBridge.ts](/home/dan/projects/ai-client/src/main/services/claude/ClaudeIdeBridge.ts:92)。其中 lock 文件的 `authToken` 是 IDE 握手 token，不是 Claude/CCH key。

7. 现存至少两处直接写用户真实 home：
   - onboarding 写 `~/.claude/settings.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:242)
   - onboarding 写 `~/.claude.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:451)
   - MCP manager 也固定操作 `~/.claude.json`：[McpManager.ts](/home/dan/projects/ai-client/src/main/services/claude/McpManager.ts:15)。

   D47 施工时必须引入一个 Main 拥有的 `ManagedClaudePaths`，消除各模块自行拼 `homedir()` 的路径权威。

8. Provider 面板当前会把 `authToken` 放入 React state、回显并经 IPC 提交：[ProviderDialog.tsx](/home/dan/projects/ai-client/src/renderer/components/settings/claude-provider/ProviderDialog.tsx:41)、[ProviderDialog.tsx](/home/dan/projects/ai-client/src/renderer/components/settings/claude-provider/ProviderDialog.tsx:149)。这与“员工零感知、app 凭据权威”直接冲突。

#### 被否方案的否决理由

- 否决“纯 env、没有私有 Claude home”：
  - history、hooks、IDE lock、trust、插件等仍会落回真实 `~/.claude`。
  - 不能满足“不再写 `~/.claude`”。
  - 也无法给 history reader 一个稳定的 app 私有来源。

- 否决“只建私有 Claude home，把 key 写进私有 settings.json”：
  - SDK 当前 `settingSources: []`，不会依赖该文件加载凭据。
  - key 会形成第二个可读配置文件副本。
  - 内置终端和 SDK 会出现两套认证路径。

- 否决“继续保留可编辑 Provider 面板”：
  - Renderer 将继续接触明文 key。
  - 用户能把 app 托管状态改成任意 token/provider，破坏 D47 的单一凭据权威。
  - provider 匹配逻辑目前直接比较 `authToken`：[claudeProvider.ts](/home/dan/projects/ai-client/src/renderer/lib/claudeProvider.ts:25)。

#### 证据强度

- SDK `settingSources: []`、env 注入、history 路径、hooks/IDE 门禁：`confirmed`。
- `CLAUDE_CONFIG_DIR` 下 `.claude.json` 的实际 Claude CLI 解析位置：`inferred`，有测试 spike 参照，但必须在 D47 spike 中用当前 Claude/Cometix 版本实测；现有 spike 会在临时 config dir 写 `.claude.json`：[testCredentials.ts](/home/dan/projects/ai-client/src/agent-host/spikes/testCredentials.ts:27)。
- “只对用户明确打开的 workspace 写 trust 标志”是本方案的安全策略，属于设计裁定，不是现有事实。

---

### B. Codex 侧生成模式

#### 结论

1. 退役“从真实 `~/.codex/config.toml` 投影 + 复制 `auth.json`”模式。
2. `<userData>/codex-home/config.toml` 完全由 app 根据托管账号、固定 provider 描述和 Codex 安全姿态生成。
3. 认证选择：

```toml
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```

子进程环境只注入：

```text
CODEX_HOME=<userData>/codex-home
AICLIENT_CODEX_API_KEY=<managed key>
```

不生成 `<userData>/codex-home/auth.json`，也不写 `~/.codex/auth.json`。

4. 推荐的配置形状：

```toml
# GENERATED FILE — DO NOT EDIT.
# Managed by AiClient.

approval_policy = "on-request"
sandbox_mode = "workspace-write"

model_provider = "jyw"

# [假设] 初始值仍需结合实际模型能力确认。
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[model_providers.jyw]
name = "jyw"
base_url = "https://<managed-cch-host>/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```

5. `model_context_window`、`model_auto_compact_token_limit`、`approval_policy`、`sandbox_mode` 必须在 root 层，不能位于 `[model_providers.jyw]` 下。

6. 内置终端运行 `codex` 时注入相同的 `CODEX_HOME` 和 `AICLIENT_CODEX_API_KEY`，确保终端 CLI 与 app-server 使用同一生成配置和认证方式。

7. 无登录态时：
   - Root 不挂载主 App。
   - Main 的 session/terminal 创建入口也必须检查 `AuthSessionService`，不能只依赖 Renderer 门禁。
   - agent-host registry 不应把 Codex 标成“可用但稍后认证失败”；推荐新增认证不可用原因，或在 Main 根本不启动 managed host。
   - 已启动会话在 `reauth_required` 转换时立即终止。

#### 依据

1. 当前 Codex home 只允许投影 root `model`、`model_provider`，并放行整个 `model_providers.*` 表：[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:106)。这不适合 D47 的固定生成模式，也不能正确表达新增 root 上下文字段。

2. 当前 `ensureCodexHome` 会从真实 `CODEX_HOME`/`~/.codex` 读配置并复制 `auth.json` 到私有 home：[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:524)、[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:621)。D47 已明确要求投影退役和 key 只归 app 托管，因此 source home、auth copy、`authCopied` 都应退出生产路径。

3. 当前 app 已由 Main 决定 `<userData>/codex-home`，并显式注入 agent-host：[AgentHostManager.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts:425)、[hostEnv.ts](/home/dan/projects/ai-client/src/main/services/agent-host/hostEnv.ts:37)。这条路径可延续。

4. `codexRuntime` 当前把整个 `process.env` 复制给 Codex child，仅额外设置 `CODEX_HOME`：[codexRuntime.ts](/home/dan/projects/ai-client/src/agent-host/codexRuntime.ts:1374)。由于 Claude 凭据当前会进入 host `process.env`，这会把 Claude secret 一并传给 Codex。D47 应改为 provider-specific child env：
   - 保留运行需要的 PATH、代理、locale 等普通变量。
   - 显式剔除 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等非本 runtime 凭据。
   - 只加入 `AICLIENT_CODEX_API_KEY`。

5. Codex child spawn 会原样使用传入 env，不经过 shell，适合精确控制：[codexConnection.ts](/home/dan/projects/ai-client/src/agent-host/codexConnection.ts:444)。

6. 当前 onboarding 把上下文字段写在 provider 段：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:391)。调查报告对 Codex CLI 0.145.0 的 `--strict-config` 实测表明：
   - provider 段下报 unknown field。
   - root 层可以通过。
   - 默认非严格模式会静默忽略错误字段。

   证据见 [agent-1.md](</tmp/claude-1000/-home-dan-projects-ai-client/8139279c-c4ed-416e-b915-6d3470238954/scratchpad/login-mgmt-investigation/agent-1.md:41>)。

7. 同一调查还实测了 Codex 0.145.0 的 env-only 路径：
   - 无 `auth.json`。
   - `requires_openai_auth=false + env_key` 可通过认证检查。
   - 缺 env 时明确报 `Missing environment variable`。
   - `requires_openai_auth=true + OPENAI_API_KEY` 也能工作。

   证据见 [agent-1.md](</tmp/claude-1000/-home-dan-projects-ai-client/8139279c-c4ed-416e-b915-6d3470238954/scratchpad/login-mgmt-investigation/agent-1.md:71>)。

#### 被否方案的否决理由

- 否决 app 私有 `auth.json`：
  - 形成第二个落盘 secret。
  - 与 D47“进程注入”方向冲突。
  - 当前 `authCopied` 调用结果本身无人消费，继续保留只有复杂度，没有产品价值。

- 否决标准 `OPENAI_API_KEY`：
  - 容易被普通 shell、第三方工具或未来其他 provider 误消费。
  - 当前 host 全局 env 继承模型会放大撞名风险。
  - 自定义 `env_key` 能把凭据与 D47 固定 provider 明确绑定。

- 否决继续投影真实 `~/.codex/config.toml`：
  - D47 已要求 provider 段由托管凭据生成、投影退役。
  - 用户真实配置可能含 MCP、通知、developer instructions、危险 sandbox posture，继续投影仍需维护复杂的 allowlist。
  - 新的 root 字段与现有 allowlist不兼容。

- 否决“未登录仍把 Codex 标成 supported”：
  - 会把应用级认证问题延迟成 turn 级错误。
  - 用户会进入主界面后才看到 Codex 报缺 env，违反正式登录门禁语义。

#### 证据强度

- Codex 0.145.0 env-only 和 root 层字段：`confirmed: 调查实测`。
- `model_auto_compact_token_limit=900000`：`[假设]`。当前代码是 `9000000`，但大于 `model_context_window=1000000`，明显需要独立模型能力 spike；不能在没有实证时把本方案推荐值当成既定事实。

---

### C. 凭据存储选址与格式

#### 结论

选址：

```text
<userData>/auth/credentials.v1.json
```

不使用：

```text
~/.aiclient/credentials.json
~/.claude/*
~/.codex/*
```

安全档位采用“真实 OS 后端优先、文件权限兜底”：

1. 如果 `safeStorage` 已 ready、加密可用，且 Linux 后端不是 `basic_text`/`unknown`：
   - 整个 secret payload 用 `safeStorage.encryptString()` 加密。
   - 文件只存 scheme、版本和 ciphertext。
2. 如果 Linux 只有 `basic_text`，或 safe storage 不可用：
   - 明确降级为 `local-file-v1`。
   - 使用 `0700` 目录、`0600` 文件、原子写入。
   - 状态页可显示“本机凭据保护：文件权限”，但不弹阻断性警告。
3. 解密失败、ciphertext 损坏或系统 keyring 更换：
   - 不尝试读旧 `~/.claude`/`~/.codex`。
   - 状态进入 `reauth_required`。
4. 不把 key 拆成多个 Claude/Codex 文件；一个事务性 payload 保证二者一起提交、一起失效。

这是内部员工工具的务实安全档位：防止普通误读和跨应用配置污染，但不宣称能抵抗同一 OS 用户权限下的恶意进程。内置终端本身按 D47 要求获得 env，因此对“同一员工账户下的本机进程”无法提供硬隔离。

#### 依据

1. `~/.aiclient` 已经是共享设置和 session-state 目录：[SharedSessionState.ts](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:33)。其当前目录创建和 JSON 写入也没有显式 `0700/0600`：[SharedSessionState.ts](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:17)、[SharedSessionState.ts](/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts:49)。

2. SSH helper 也使用 `.aiclient/settings.json` 和 `.aiclient/session-state.json` 命名：[RemoteHelperSource.ts](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:35)。把凭据放进去会增加被远程同步、复制或错误序列化的风险。

3. `<userData>` 已经是 app 私有状态的常用根：
   - Codex home：[AgentHostManager.ts](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts:429)
   - 窗口状态：[MainWindow.ts](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:64)
   - Session index：[SessionIndexService.ts](/home/dan/projects/ai-client/src/main/services/chat/SessionIndexService.ts:30)。

4. dev 模式会根据 `AICLIENT_PROFILE` 使用独立 userData，生产则使用 Electron 正常 userData：[index.ts](/home/dan/projects/ai-client/src/main/index.ts:129)。D47 应接受这个分裂：
   - dev、测试 profile 不读取生产凭据。
   - 不提供跨 profile 自动复制。
   - 开发者首次进入不同 profile 时重新登录。

5. 本机安装的 Electron 类型确认：
   - `safeStorage.encryptString/decryptString`
   - Linux `getSelectedStorageBackend()`
   - `basic_text`、`gnome_libsecret`、KWallet 等后端
   - `isEncryptionAvailable()`

   见 [electron.d.ts](/home/dan/projects/ai-client/node_modules/electron/electron.d.ts:11436)。

6. Windows NSIS 当前明确 `deleteAppDataOnUninstall: false`，卸载不会自动清除 userData：[electron-builder.yml](/home/dan/projects/ai-client/electron-builder.yml:201)。

#### 被否方案的否决理由

- 否决 `~/.aiclient`：
  - 它是共享状态和远程 helper 命名空间，不是私密 credential vault。
  - dev/prod 也会意外共用同一 home 下的凭据，破坏 profile 隔离。
  - 当前权限控制不满足凭据文件要求。

- 否决仅靠 `safeStorage`、不可用就禁止登录：
  - Linux 桌面、SSH、无 keyring 环境存在可用性风险。
  - 内部工具的主目标是可靠登录；无法提供 OS vault 时，`0600` 明文是诚实且可操作的降级。
  - 不能把 `basic_text` 包装成“安全加密”。

- 否决只用明文、不尝试 `safeStorage`：
  - Windows DPAPI、macOS Keychain、Linux libsecret/KWallet 可用时没有理由放弃现成保护。
  - 实现成本主要集中在单个 CredentialStore 内，可控。

#### 证据强度

- userData、`.aiclient`、dev profile、卸载行为：`confirmed`。
- “`basic_text` 不应被视为真正的静态加密保护”：`inferred`，依据是本机 Electron 类型将其明确列为基本文本后端；正式施工前仍应运行 packaged Linux spike，记录实际 backend 和重启后的可解密性。
- 官方网页查询本轮因网络服务 503 未成功，因此 safeStorage 设计以仓库当前安装的 Electron 类型声明为准。

---

### D. 登录态模型与 UI

#### 结论

三态由 Main 的 `AuthSessionService` 唯一判定：

```ts
type AuthState =
  | {
      kind: 'signed_out'
      reason: 'never_logged_in' | 'explicit_logout'
    }
  | {
      kind: 'signed_in'
      account: { userId: number; email: string }
      localHealth: 'healthy'
      remoteHealth: 'valid' | 'unknown'
      degradedReason?: 'offline' | 'server_unavailable'
    }
  | {
      kind: 'reauth_required'
      account?: { userId?: number; email: string }
      reason:
        | 'credential_missing'
        | 'credential_corrupt'
        | 'decrypt_failed'
        | 'credential_rejected'
        | 'migration_incomplete'
    }
```

判定规则：

| 输入 | 状态 |
|---|---|
| 从未登录、无账号元数据、无凭据 | `signed_out` |
| 用户主动登出 | `signed_out` |
| 凭据文件存在、可解密、字段完整，尚未在线验证 | `signed_in + remoteHealth=unknown` |
| cch `/api/auth/login` 成功 | `signed_in + remoteHealth=valid` |
| 网络错误、超时、DNS、5xx | 保持 `signed_in`，标记 `remoteHealth=unknown`，不强迫重新登录 |
| cch 返回 401/403，且用 key 换 session 的一次重试仍被拒绝 | `reauth_required: credential_rejected` |
| 已知曾登录，但文件缺失、损坏或无法解密 | `reauth_required` |

这里要严格区分：

- 本地健康：能否读出结构完整的 managed credential。
- 服务端有效：cch 是否明确接受该 key。
- 网络不可用：不是凭据失效，不能把员工赶回验证码页。

Root 收敛：

- Renderer 只调用 `auth.getState()` 并订阅 `auth.stateChanged`。
- Root 不再自行组合 `onboardingState + cliStatus + credential file health` 来定义账号状态。
- CLI/runtime 探测仍可作为登录后的第二层 capability gate，但不能反过来定义账号是否登录。

MainWindow 收敛：

```text
AuthSessionService.getSnapshot()
        │
        ├── Renderer Root
        └── MainWindow.isAppMountedFor()
```

`MainWindow.isAppMountedFor()` 只读同一个同步内存快照：

```text
auth.kind === signed_in
AND runtime.kind in node-compatible / bun-incompatible
```

不再自行调用 `checkRegistration()` 推导另一套答案。

`SKIP_ONBOARDING_GATE`：

- 收回当前硬编码 `true` 的生产路径。当前常量确实完全绕过登录门禁：[devFlags.ts](/home/dan/projects/ai-client/src/shared/devFlags.ts:1)、[Root.tsx](/home/dan/projects/ai-client/src/renderer/Root.tsx:127)。
- 测试需要绕过时，改用测试 harness/依赖注入或仅开发构建可用的启动参数。
- packaged build 必须有静态断言：不存在可让普通用户绕过 D47 登录的 flag。
- D47 feature flag 与测试绕过不能是同一个概念。

UI：

1. `signed_out`
   - 邮箱输入。
   - 发送验证码。
   - 验证码输入。
   - 登录。
   - 不再使用“注册”作为主文案。

2. `reauth_required`
   - 显示“登录已失效，请重新验证邮箱”。
   - 预填已知邮箱，可允许修改。
   - 明确区分“本地登录数据损坏”和“服务端拒绝凭据”，但不暴露 key 或内部错误体。

3. `signed_in`
   - 主界面。
   - 头像菜单显示邮箱、用量、重新登录、登出。
   - “重新登录”保留现有会话数据，但重新换取并替换 key。
   - Provider 面板只显示公司托管状态。

登出语义：

1. 先禁止新 session/PTY 创建。
2. 终止所有带凭据 env 的本地及远程会话。
3. 停止 agent-host。
4. 清除 cch `auth-token` cookie。
5. 删除 managed credential 文件。
6. 清除 Main 内存中的 key。
7. 状态转换为 `signed_out`，广播一次状态事件。
8. 不调用 cch 撤销 key，除非服务端未来提供单独的“设备登出/撤销 session”契约。
9. Claude/Codex history 默认保留，但不得在未登录 UI 展示；不同邮箱重新登录时必须进行账号隔离处理，见 §3/§4。

#### 依据

1. 当前 Root 有三套独立 query，其中凭据健康仅检查旧文件内容，并且失败就返回注册邮箱页：[Root.tsx](/home/dan/projects/ai-client/src/renderer/Root.tsx:138)、[Root.tsx](/home/dan/projects/ai-client/src/renderer/Root.tsx:391)。

2. 当前 `checkCredentialsHealth()` 只检查：
   - `~/.claude/settings.json` 中 base URL/token 非空。
   - `~/.codex/auth.json` 中 `OPENAI_API_KEY` 非空。

   它不访问 cch，因此过期或撤销 key 会得到假健康：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:565)。

3. 当前 UsageService 已有无需修改 cch 的在线有效性信号：
   - `POST /api/auth/login { key }`
   - Actions API 401/403 后换 session 并重试
   - session cookie 名为 `auth-token`

   见 [UsageService.ts](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:81)、[UsageService.ts](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:205)。

4. 当前 MainWindow 只检查本地 `registered` 和 runtime cache，不检查凭据健康，因此和 Root 存在双镜像分叉：[MainWindow.ts](/home/dan/projects/ai-client/src/main/windows/MainWindow.ts:28)。

5. 当前 live credential status 只是向已挂载 App 发 toast；`available=false` 不会驱动 Root 登录态转换：[App.tsx](/home/dan/projects/ai-client/src/renderer/App.tsx:162)。

6. 当前登出已经具备正确的前半段顺序：终止 session、清理本地状态、清 cookie：[onboarding.ts](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:115)。D47 应把“清旧 CLI 文件”替换成“删除 managed credential + 重启/停止 runtime”。

#### 被否方案的否决理由

- 否决“本地文件完整即已登录”：
  - 无法发现服务端撤销、员工离职、key 失效。
  - 当前实现已经存在这类 false-green。

- 否决“任何网络失败都重新登录”：
  - 离线、DNS、网关临时 5xx 会造成验证码风暴。
  - 只有明确的认证拒绝才能转 `reauth_required`。

- 否决 Renderer 自己维护 auth store：
  - Renderer 不应持有 key。
  - MainWindow、agent-host 和 PTY 创建都在 Main/Host，Renderer store 无法成为全局权威。
  - 页面刷新或窗口替换会制造状态分叉。

- 否决只在 Root 做门禁：
  - IPC/session 创建仍可能被脚本、旧 Renderer 或竞态调用。
  - 必须在 Main 的实际 spawn 边界再次检查 auth snapshot。

---

### E. 服务端契约

#### 结论

首选：保持现有两个接口不变，只把 `verify-and-register` 实证并固化为幂等“验证并取回员工既有 key”。

现有客户端接口：

```http
POST /api/onboarding/send-code
Content-Type: application/json

{
  "email": "employee@jcdz.cc"
}
```

```http
POST /api/onboarding/verify-and-register
Content-Type: application/json

{
  "email": "employee@jcdz.cc",
  "code": "123456"
}
```

客户端目前就是这样调用：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:72)、[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:102)。

服务端必须保证：

1. email 规范化为 `trim().toLowerCase()`。
2. 对已经注册的邮箱：
   - 不新建第二个 cch 用户。
   - 不新建第二个 active key。
   - 返回该用户既有 key。
3. 对未注册员工：
   - 创建一次员工/cch 账号。
   - 返回首次创建的 key。
4. 两个并发 verify 请求必须收敛到同一个 user/key。
5. 响应仍可保持当前配置形状，减少客户端和 onboard 改动：

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": 123,
      "name": "Employee"
    },
    "apiKey": "[SECRET]",
    "config": {
      "claude": {
        "baseUrl": "https://cch.example/v1",
        "authToken": "[SECRET]"
      },
      "codex": {
        "baseUrl": "https://cch.example/v1",
        "apiKey": "[SECRET]"
      }
    }
  }
}
```

但该原始响应只能停留在 Main。Renderer 只收到：

```json
{
  "ok": true,
  "account": {
    "userId": 123,
    "email": "employee@jcdz.cc"
  },
  "authState": "signed_in"
}
```

#### 幂等假定实证法

必须在改客户端前完成以下服务端 spike：

1. 准备一个已注册测试员工，记录：
   - onboard user id。
   - cch user id。
   - active key 的不可逆 fingerprint，例如 `SHA-256(key)`。
2. 用第一枚验证码调用 `verify-and-register`，记录返回 fingerprint。
3. 再发一枚验证码，对同一邮箱重新调用。
4. 使用不同大小写和首尾空格重复：
   - `User@JCDZ.CC`
   - ` user@jcdz.cc `
5. 对同一枚或两枚有效验证码并发发起两个 verify。
6. 通过 onboard 数据库或管理 API 验证：
   - user 数量仍为 1。
   - cch user 数量仍为 1。
   - active key 数量仍为 1。
   - 返回 fingerprint 始终等于基线。
7. 模拟 key revoked/disabled，确认服务端返回：
   - 同一个已恢复 key；
   - 或机器可识别的 `KEY_NOT_READY/CCH_FAILED`；
   - 不得暗中新建第二个身份。
8. 将上述测试落为 onboard 服务的集成回归，不依赖人工观察。

#### fallback 接口

如果 `verify-and-register` 对已注册邮箱不能幂等回发既有 key，推荐增加一个最小统一接口，而不是让客户端猜“这是注册还是登录”：

```http
POST /api/onboarding/verify-and-login
Content-Type: application/json

{
  "email": "employee@jcdz.cc",
  "code": "123456"
}
```

语义：

```text
验证 OTP
    ├── 邮箱已有员工记录 -> 查询并返回既有 key
    └── 邮箱不存在       -> 复用现有 register 流程创建一次并返回 key
```

响应形状与 `verify-and-register` 完全一致。这样客户端仍只有一条验证码提交路径，不需要：

- 先调用 register；
- 收到“已存在”；
- 再拿已经可能被消费的验证码调用 login。

建议新增错误码：

```text
ACCOUNT_DISABLED
EMPLOYEE_NOT_FOUND
KEY_REVOKED
KEY_NOT_READY
```

其中：

- `ACCOUNT_DISABLED`：直接进入不可重试的账号禁用说明，不循环发验证码。
- `KEY_REVOKED`：进入 `reauth_required`；如果 onboard 能恢复既有 key，则优先在服务端完成恢复。
- `KEY_NOT_READY`：可重试服务错误，不把本地登录态永久判坏。

#### 依据

- 当前成功响应已经包含 user、Claude/Codex 配置和 key：[onboarding.ts](/home/dan/projects/ai-client/src/shared/types/onboarding.ts:44)。
- 当前客户端会把 `ok=true` 但 credential 不完整视为错误：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:127)。
- 当前错误码已有 `CCH_FAILED`、`CCH_UNREACHABLE`、`KEY_NOT_READY`：[onboarding.ts](/home/dan/projects/ai-client/src/shared/types/onboarding.ts:8)。

#### 被否方案的否决理由

- 否决修改固定 cch 业务代码：
  - D47 已明确只能最小改 onboard。
  - cch 已有 key login 和 Actions session 能力，onboard 只需负责 OTP 到既有 key 的交换。

- 否决客户端根据本地 `registered` 决定调用 register 或 login：
  - 本地状态可能丢失、损坏或来自另一台机器。
  - 服务端才知道邮箱是否已有账号。
  - 会把服务端幂等责任错误推给不可信客户端状态。

- 否决登录时每次轮换新 key：
  - 与 D47“换取该员工既有 key”冲突。
  - 会造成旧设备、旧会话和审计关联失效。
  - 也扩大服务端改动。

#### 证据强度

- 客户端契约和响应形状：`confirmed`。
- `verify-and-register` 当前服务端是否幂等：`assumption`，尚未实证；这是 D47 最优先阻断性 spike。
- cch `/api/auth/login` 可作为 key 在线探针：`confirmed`，仓库已有生产调用。

---

### F. 存量迁移与兼容

#### 结论

采用“先导入、延迟清理、绝不反向导出”的迁移策略。

迁移状态建议：

```text
not_started
legacy_detected
imported_pending_cleanup
completed
reauth_required
```

升级路径：

1. D47 flag 首次开启。
2. 如果 managed credential 已存在：
   - 直接读取。
   - 不再查看旧 home。
3. 如果 managed credential 不存在，但旧 onboarding 状态显示 `registered=true`：
   - 检查旧 Claude/Codex 配置。
   - 只有同时满足以下条件才静默导入：
     - Claude base URL 与已知公司网关一致。
     - Claude token 非空。
     - Codex provider/base URL 与公司 `jyw` provider 一致。
     - Codex key 非空。
     - Claude/Codex key 一致，或服务端契约明确允许二者不同。
   - 导入完成后重新读回 managed store。
   - 用 cch `/api/auth/login` 验证。
   - 验证成功才标记 `imported_pending_cleanup`。
4. 如果旧配置不完整或来源不明确：
   - 不导入个人 Claude/Codex 凭据。
   - 进入 `reauth_required: migration_incomplete`。
   - 预填旧 onboarding email，要求邮箱验证码。
5. 在首个 D47 稳定版本中暂不立即清理真实 home，使 flag 回退仍有可能使用旧凭据。
6. 第二轮稳定后，执行一次性精确清理：
   - Claude：
     - 只有旧 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 与已导入值匹配时才删除。
     - 保留用户其他 env、hooks、MCP、settings。
   - Codex：
     - 只删除匹配的 `OPENAI_API_KEY` 字段。
     - 只移除 app 创建的 `model_providers.jyw` 和指向 `jyw` 的 root `model_provider`。
     - 保留用户其他 provider、MCP、projects、history 和自定义配置。
   - 私有 `<userData>/codex-home/auth.json` 如果来自旧 projection，删除它；保留 config/history。
   - app 已创建的 `.bak` 文件只有在能证明其中 secret 与已迁移 managed key 相同的情况下才清理。
7. 完成后写不含 secret 的 migration marker。

当前 logout 会删除整个 `~/.codex/config.toml` 和 `auth.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:489)。D47 迁移清理不能复用这个行为，因为它会删除用户自己的 Codex 配置。

Flag off 安全态：

- flag off 使用旧实现，但不得把 managed key 重新写回 `~/.claude`/`~/.codex`。
- 如果用户只有 managed credential、没有 legacy credential：
  - flag off 必须 fail closed，显示需要重新开启 managed login/重新登录。
  - 不能为了“无感回退”违反 D47，把 key 反向导出到真实 home。
- 第一轮导入用户由于暂时保留 legacy 字段，flag off 可恢复旧路径。
- 新登录用户的 flag off 回退只能是“功能暂不可用但 secret 不泄漏”，不能是无缝回退。

登出与历史：

- 登出删除 secret，不默认删除 Claude/Codex/session history。
- 主界面在未登录时不展示历史。
- 登录邮箱与 history 所属账号不一致时，必须隔离或要求用户清理，不能直接显示上一员工的聊天记录。

#### 依据

1. 当前 onboarding 状态存于 `~/.aiclient/settings.json`，包含 registered、email、serverUrl：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:24)、[onboarding.ts](/home/dan/projects/ai-client/src/shared/types/onboarding.ts:1)。

2. 当前旧路径确实写：
   - `~/.claude/settings.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:242)
   - `~/.codex/config.toml`、`auth.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:335)
   - `~/.claude.json`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:451)。

3. 当前 Codex home 还会保留第二份 auth copy，且注释明确没有自动 reaper，因为目录同时含历史：[codexHome.ts](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:84)。D47 删除 `auth.json` 时不能顺手删除整个 home。

#### 被否方案的否决理由

- 否决无条件导入旧 key：
  - 真实 `~/.claude`/`~/.codex` 可能是员工个人 provider。
  - D47 不能把个人 key误认成公司账号 key。

- 否决登录成功后立即删除全部旧配置：
  - 第一轮没有安全 rollback。
  - 可能删除用户 MCP、provider、history 和其他工具配置。
  - 当前 logout 的整文件删除已经是危险先例，不能延续。

- 否决双写：
  - D47 已明确 key 只存 app 私有目录。
  - 双写会无限延长旧权威，无法真正收敛。

- 否决 flag off 时从 managed store 导出旧文件：
  - secret 会重新扩散。
  - 回退路径变成新的写手，违反固定约束。

---

### G. 施工切法与验证

#### 结论

按工程规范执行：

```text
定义 Happy Path
→ 写确定性过程断言
→ 准备回归样本
→ 加 feature flag
→ 实现
→ flag off/on 双轮比较
```

这与工程标准明确要求一致：[agent-project-engineering.md](/home/dan/projects/ai-client/docs/agent-project-engineering.md:51)、[agent-project-engineering.md](/home/dan/projects/ai-client/docs/agent-project-engineering.md:57)、[agent-project-engineering.md](/home/dan/projects/ai-client/docs/agent-project-engineering.md:86)、[agent-project-engineering.md](/home/dan/projects/ai-client/docs/agent-project-engineering.md:168)。

Feature flag 建议：

```text
AICLIENT_MANAGED_LOGIN_V1
```

阶段：

- Round 1：默认 off，所有新模块存在但不接管生产路径。
- Round 2：默认 on，旧路径仅作受控回退。
- 稳定后：删除旧 credential writers、旧 provider token UI、Codex projection credential copy。
- `SKIP_ONBOARDING_GATE` 不得作为该 flag 的 off 值；它必须单独收回。

过程断言优先级：

1. key 未进入 Renderer。
2. key 未写入真实 home。
3. key 未出现在生成的 Claude/Codex config。
4. Claude child 只收到 Claude key。
5. Codex child 只收到 Codex专用 env key。
6. logout 后不能创建新 session，已有进程全部退出。
7. 网络错误不触发 reauth。
8. 401/403 的认证重试失败会触发 reauth。
9. MainWindow 和 Root 读取同一 auth snapshot。
10. flag off 不会把 managed key 导出到旧 home。

三层回归：

- Smoke：核心登录、启动 Claude、启动 Codex、启动终端、logout、401 失效。
- Main regression：迁移、dev profile、远程 helper、history、hooks、IDE bridge、Provider UI、窗口关闭、usage。
- Incident regression：
  - `settings.json` 只剩 hooks。
  - `auth.json` 缺失。
  - keyring 解密失败。
  - cch 401/403。
  - offline/5xx 不应重新登录。
  - flag off 不能反向导出 secret。
  - Codex root 字段错误 section。
  - logout 后旧 PTY 仍持有 key。
  - 不同邮箱看到上一员工 history。

工程标准要求的 Smoke/Main/Incident 分层见 [agent-project-engineering.md](/home/dan/projects/ai-client/docs/agent-project-engineering.md:99)。

#### 被否方案的否决理由

- 否决一次性改登录、Claude、Codex、迁移和 UI：
  - 无法定位回归来自 credential store、runtime env 还是门禁状态。
  - flag off/on 无法比较单一变量。

- 否决只做最终 UI 测试：
  - secret 是否写盘、是否进入错误 child env、是否残留进程，都不能靠 UI 判断。
  - 必须以 spawn 参数、文件树、IPC payload、状态转换作为过程断言。

- 否决只跑 typecheck/lint：
  - 它们无法发现“对空集通过”的 secret leak 和配置层级错误。
  - Codex strict-config、packaged safeStorage、真实 onboard 幂等都需要独立 spike/集成测试。

---

§3 风险与开放问题

1. **Onboard 幂等性尚未实证，风险最高。**

   `[assumption]` 当前方案假定 `verify-and-register` 对已注册邮箱回发同一 key。必须先完成 §2E 的服务端 spike。若不成立，客户端设计仍可继续，但不能上线登录闭环。

2. **Claude `.claude.json` 在私有 `CLAUDE_CONFIG_DIR` 下的真实解析位置需要当前版本实测。**

   代码中 app 自己的多个写手固定使用真实 home，而测试 spike 使用 `<configDir>/.claude.json`。应分别验证：

   - CLI 首次启动是否读取该文件。
   - `hasCompletedOnboarding` 是否生效。
   - `projects[workspace].hasTrustDialogAccepted` 是否生效。
   - SDK 和裸 `claude` CLI 是否一致。

3. **Claude 配置路径写手较多，容易漏改。**

   除 onboarding 外，MCP、plugin、prompt、completion、session scanner、runtime config 等模块都有自己的路径解析。必须通过静态扫描断言 managed-login 模式下生产源码不再直接拼 `homedir(), '.claude'`。

4. **Codex 上下文值存在明显疑点。**

   当前：

   ```text
   model_context_window = 1,000,000
   model_auto_compact_token_limit = 9,000,000
   ```

   后者大于前者。字段层级已经被 0.145.0 实测确认必须在 root，但数值语义没有被确认。不能把“strict-config 能解析”当成“运行语义正确”。

5. **Codex 版本升级可能改变 config schema 或 env-only 行为。**

   应将当前测试固定到项目实际 Codex pin，并在升级时运行：

   ```text
   codex --strict-config
   codex doctor
   无 auth.json 的 env-only smoke
   app-server initialize + thread/start
   ```

6. **safeStorage Linux packaged 行为需要实机矩阵。**

   至少覆盖：

   - Ubuntu GNOME + libsecret 可用。
   - Ubuntu 无登录 keyring。
   - KDE/KWallet。
   - SSH/headless。
   - `basic_text`。
   - app 重启、系统重启后解密。
   - dev profile 与 packaged app 分离。

7. **凭据进入内置终端 env 是 D47 固定约束带来的安全边界。**

   员工可在终端中运行 `env` 看到 key，终端中任意子进程也会继承。必须明确这是“内部员工、同一 OS 用户信任域”的务实安全档位。若未来要提高安全级别，只能改为按命令 wrapper/credential helper，而不是整个 shell env 注入；这会改变已拍板约束，当前不做。

8. **远程 SSH helper 的 key 只允许进进程 env，绝不能进入 `.aiclient`。**

   远程 helper 当前会把 `options.env` 合入子进程环境：[RemoteHelperSource.ts](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:250)、[RemoteHelperSource.ts](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:1805)。因此可实现临时注入，但需验证：

   - RPC 日志不打印 options。
   - helper 崩溃日志不 dump env。
   - shell history 不包含带 key 的命令文本。
   - 断线后远程进程确实退出。

9. **不同员工在同一 OS profile 上重新登录会造成 history 越权风险。**

   D47 虽然不做多账号切换，但“登出后输入另一个邮箱”实际上形成账号变更。必须给 Claude/Codex history、session index 加 account binding，或禁止在保留旧数据时登录另一邮箱。

10. **旧 `.bak` 可能继续含 secret。**

    当前 onboarding 会对旧 Claude/Codex 配置创建 `.bak`：[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:263)、[OnboardingService.ts](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:343)。迁移只清主文件而不处理 app 自己生成的 backup，仍不满足“凭据权威收敛”。但无条件删 `.bak` 又可能删除用户备份，因此必须按 key fingerprint 精确识别。

11. **卸载后凭据默认留存。**

    当前 Windows installer 不删除 AppData。应明确：

    - 普通卸载是否保留账号以便重装免登录。
    - 是否增加“卸载时清除本机登录信息”选项。
    - Linux AppImage 删除应用文件本身也不会自动删除 userData。

12. **401/403 分类不能直接复用任意业务请求。**

    某个 Actions 接口的 403 也可能表示业务权限不足，而不是 key 无效。推荐以 `/api/auth/login { key }` 的明确拒绝作为最终 credential invalid 证据；普通业务 401/403 只触发一次 auth probe。

13. **Main/Host 日志和 structured trace 必须做字段级 secret redaction。**

    不允许依赖“开发者不打印整个对象”。应建立统一 redactor，拒绝或替换：

    ```text
    authorization
    cookie
    auth-token
    ANTHROPIC_AUTH_TOKEN
    ANTHROPIC_API_KEY
    OPENAI_API_KEY
    AICLIENT_CODEX_API_KEY
    apiKey
    authToken
    ```

14. **登出顺序存在竞态。**

    必须先关闭 spawn gate，再终止进程，最后删除 secret。否则在“终止现有会话”和“删除文件”之间仍可能创建一个携带旧 key 的新 PTY。

---

§4 需要用户拍板的点（附推荐）

D47 五项已视为不可推翻，不在这里重新讨论。仍建议用户拍板以下实施级选择：

1. **safeStorage 降级策略**

   推荐：真实 OS 后端时加密；Linux `basic_text`、unknown 或不可用时降级为 `0600` 明文，不阻断登录。

   备选：没有可靠 keyring 就禁止登录。

   推荐理由：内部员工工具首先要求可用性；禁用会使无 keyring、SSH、精简 Linux 环境完全不可用。UI 和文档必须诚实标明保护等级。

2. **Codex `model_auto_compact_token_limit` 初始值**

   推荐：先通过 spike 确认；在确认前采用 `900000`，而不是当前 `9000000`。

   推荐理由：当前值超过 1,000,000 context window，存在明显语义冲突。字段应放 root 已确定，但数值本身尚未确定。

3. **不同邮箱重新登录时的本地历史处理**

   推荐：本地数据绑定 `accountId`；如果新邮箱与旧账号不同，默认将旧历史隔离为不可见，不自动删除，并提供“清除上一账号本机数据”操作。

   备选：

   - 直接禁止另一邮箱登录，要求先清除本机数据。
   - 登录另一邮箱时自动删除旧历史。

   推荐理由：隔离兼顾隐私与可恢复性，也不等同于实现多账号切换 UI。

4. **卸载是否清除凭据**

   推荐：维持普通卸载保留 AppData，但新增清晰的“退出登录/清除本机登录数据”；后续 Windows installer 可加可选清理，不把 `deleteAppDataOnUninstall` 直接改为全删。

   推荐理由：全删会连 history、session index、设置一起删除，超出凭据管理范围；只留下 secret 又有安全顾虑，因此应由专门清理动作控制。

5. **远程 SSH 的 D47 首发范围**

   推荐：首发允许远程进程级临时 env 注入，但必须先完成“RPC/日志不泄漏、断线清理、无远端落盘”spike；若任一断言不成立，则 D47 flag on 时暂时禁用远程 Claude/Codex 启动，只保留普通无凭据远程 shell。

   推荐理由：仓库已有 `options.env` 透传基础，但 secret 传输与日志边界尚未完成专项验证。

6. **Provider 设置入口**

   推荐：managed-login on 时删除 token/provider 编辑与切换，只保留只读“公司托管”状态；legacy flag off 才显示旧面板。

   推荐理由：这是实现“app 是凭据权威”的必要条件，不只是 UI 简化。

7. **旧凭据清理时机**

   推荐：D47 默认 on 的首个版本只导入、不清理；一个稳定发布周期后，再精确清理 app-owned 字段和匹配 backup。

   推荐理由：第一轮需要安全回退窗口；同时必须设定最终清理期限，避免旧权威永久存在。

---

§5 施工切片表

| 切片 | 目标与 flag 状态 | Happy Path | 关键过程断言 | 验证层级 |
|---|---|---|---|---|
| S0：阻断性 spikes | 不改生产路径；flag off | 已注册测试员工用两枚验证码重复登录，返回同一 key；Codex env-only、Claude private home、safeStorage packaged 均通过 | onboard 只有一个 user/key；Codex 无 auth.json；Claude trust/history 确实进入 private home；safeStorage backend 被记录但不打印 secret | Spike + Incident seed |
| S1：AuthSessionService 与 CredentialStore | flag off | 测试调用登录提交后，Main 原子写入 managed store，并发布 `signed_in` | 文件位于 `<userData>`；权限正确；Renderer IPC 返回中不含 key；损坏/解密失败进入 `reauth_required`；flag off 不读取新 store | Smoke |
| S2：登录 IPC 与 UI 三态 | flag off/on 双测 | 用户输入邮箱和验证码，进入主界面；重新登录可替换 managed key；错误码正确展示 | 验证码响应不穿透 credential payload；网络错误不转 reauth；明确认证拒绝才转 reauth；Root 只消费 auth snapshot | Smoke + Main |
| S3：Root/MainWindow 单真源 | flag on | `signed_in` 时 Root 与关闭确认都认为 App 已挂载；logout 后二者同时认为未挂载 | 删除双重判定；`isAppMountedFor()` 读取 AuthSessionService 同步 snapshot；状态事件只发一次；无 30 秒关闭等待竞态 | Smoke + Incident |
| S4：Claude managed home | flag on | 登录后创建 Claude 会话，hooks/IDE/history/trust 全进入 `<userData>/claude-home`，请求成功 | SDK options 含凭据 env 和 `CLAUDE_CONFIG_DIR`；`settings.json` 不含 key；真实 `~/.claude`/`~/.claude.json` mtime 不变；historyReader 指向 managed dir | Smoke + Main |
| S5：Codex 生成 home 与 env_key | flag on | 登录后生成 config，启动 app-server、创建 thread、完成一轮请求；终端中 `codex` 同样可运行 | 无 auth.json；config root 字段位置正确；`--strict-config` 通过；child env 有 `AICLIENT_CODEX_API_KEY`、无 Claude secret；resume posture 仍通过 | Smoke + Main |
| S6：内置终端与远程 helper | flag on | 本地终端运行 Claude/Codex；远程 helper 仅把 key 注入目标进程 | PTY 创建前检查 signed_in；未登录不能创建带 credential 的 agent terminal；secret 不进 session metadata、RPC log、shell command text、`.aiclient`；断线后远程进程退出 | Main + Incident |
| S7：Provider/Usage/健康检查收口 | flag on | 账号卡显示邮箱和用量；Provider 区显示“公司托管”；cch auth probe 正常更新状态 | Renderer 不再收到 authToken；UsageService 从 AuthSessionService 取 key，不读 `~/.codex/auth.json`；业务 403 先 auth probe，不直接 reauth | Main |
| S8：logout 与在线失效 | flag on | 用户登出，所有 agent/PTY 停止、cookie 和 managed secret 清除、回到登录页；cch 明确拒绝 key 时自动进入重新登录页 | spawn gate 先关闭；进程全退出后删 secret；Main 内存无 key；cookie 清除；history 不在未登录页展示；offline 不触发 logout | Smoke + Incident |
| S9：存量迁移 | flag on | 合法公司旧凭据静默导入并继续工作；不明确的旧凭据要求邮箱验证 | 不导入个人 provider；导入前后 key fingerprint 一致；首轮不清 legacy；不得双写；不同邮箱历史不可见 | Main + Incident |
| S10：延迟精确清理 | flag on 稳定一轮后 | 已迁移账号不再依赖真实 home，精确移除 app-owned legacy 字段 | 不删除整个 config；用户其他 env/provider/MCP/history 原样保留；匹配 backup 才删除；真实 home 中不再残留 managed key | Incident |
| S11：双轮发布比较 | Round 1 off；Round 2 on | 同一 case 集分别跑 legacy 与 managed login，输出新增失败、修复项和资源变化 | 记录 git commit、flag、Electron/Codex/Claude 版本、配置 hash；比较登录成功率、启动延迟、失败率、进程残留、secret leak 断言 | Smoke/Main/Incident 全量 |
| S12：旧路径退役 | managed login 稳定后 | 新安装和升级安装都只使用 managed store | 删除旧写手、Codex auth copy、token Provider UI、`SKIP_ONBOARDING_GATE` 生产绕过；静态扫描确认生产代码无 credential 写真实 home | 全量发布门禁 |

每个切片都应至少带以下通用负控：

- 构造一个含假 key 的违规 IPC 返回，断言测试会红。
- 构造一个把 key 写入 `settings.json`/`auth.json` 的实现，断言文件扫描会红。
- 构造一个空进程列表，确保“所有进程已终止”断言不是对空集通过。
- 构造 Codex provider 段错误字段，确保测试调用真实生成函数和 `--strict-config`，而不是复制一份规则。
- 构造 Usage API 403 但 `/api/auth/login` 成功，断言不会错误转 `reauth_required`。
- 构造网络超时，断言仍为 `signed_in + remoteHealth=unknown`。
- 构造 logout 与新 session 创建并发，断言新 session 被 Main 拒绝。
- 构造另一个员工邮箱登录，断言上一账号 history 不可见。

待补 spike 清单按阻断优先级排列：

1. onboard `verify-and-register` 幂等与并发实证。
2. Claude 当前生产版本对 private `CLAUDE_CONFIG_DIR/.claude.json`、trust、history、hooks 的实测。
3. Codex context/compact 数值语义实测。
4. packaged Linux safeStorage backend 与重启解密矩阵。
5. 远程 helper `options.env` 的日志、断线和无落盘审计。
6. cch `/api/auth/login` 对 revoked、disabled、expired key 的状态码和响应体。
7. 不同账号本地 history 隔离方案的最小数据模型。
8. 旧 `.bak` 可识别性和精确清理测试。
9. packaged build 中登录绕过 flag 的静态与运行时负控。

本轮仅进行了只读调查和设计；仓库工作树未被修改，未创建任何方案文件或代码。

Codex session ID: 01a005a5-49fd-7300-a702-ce85d256b137
Resume in Codex: codex resume 01a005a5-49fd-7300-a702-ce85d256b137
