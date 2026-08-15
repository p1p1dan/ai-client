> D47「用户登录管理」规格前调查报告（2026-08-15，四路并行调查员产出，编排者未改写正文）。
> 角色：设计规格的事实底稿；所有 file:line 以调查当日工作树为准。

# Codex 侧接缝盘点（open-q #9 / D47 ⑤ 前调查）

## 1. `codexHome.ts` 现状全流程

**触发时机**：`ensureCodexHome` 只有一个真实调用面——`CodexRuntime.openConnection`（`src/agent-host/codexRuntime.ts:1357-1365`），被 `createSession`（`:1280`）、`resumeSession`（`:2660`，未展开但同函数）、`reviveSweptSession`（`:2407`）三处共用（B3：resume/revive 是 create 的同配方）。此外 `src/agent-host/index.ts:195-205`（`prepareCodexHome`）在 `HostAgentRegistry` 构建时也调一次，纯为探测可用性，不落会话。即**每次 session.create/resume/revive 都会重跑一次**（幂等：字节不变则不重写，见 `codexHome.ts:617`）。

**隔离目录**：由 Main 注入的 `AICLIENT_CODEX_HOME` 决定，Host 侧零默认值——`homeDir` 为空直接 `throw`（`codexHome.ts:604-609`）。Main 侧计算处：`src/main/services/agent-host/hostEnv.ts:43`，`AICLIENT_CODEX_HOME: input.codexHomeDir`，值形如 `<userData>/codex-home`（`codexHome.ts:100-101` 注释）。

**config.toml 投影白名单**（`codexHome.ts:106-119`）：
- Root 精确匹配：仅 `model`、`model_provider`（`CODEX_CONFIG_ROOT_ALLOWLIST`）
- Table 前缀：仅 `model_providers`（`CODEX_CONFIG_TABLE_ALLOWLIST`），即 `model_providers.<id>.*` 全部键（`base_url`/`wire_api`/`env_key`/…）整表放行
- 强制写入（不是投影，是 codexHome 自己拼的）：`approval_policy` / `sandbox_mode` 两行（`codexHome.ts:147-176`，`renderPermissionPosture`），来自调用方传入的 `permission`（`CODEX_PERMISSION_DEFAULT`，见 `codexRuntime.ts:133-143`）
- 其余一律丢弃（含 `developer_instructions`/`mcp_servers`/`notify`/`profiles`/`projects`/`history`），多行值（triple-quote）无条件拒绝（`codexHome.ts:250-290`）

**auth.json copy**：`copyFileSync`（非读写，credential 不进程内存），源→目标 mtime 比对增量刷新（`codexHome.ts:621-636`）。缺源文件不是错误，只记 `authCopied:false`（`:625-626`，caller 目前**不读**这个返回值，见下方 Q4/风险）。

**来源文件路径**：`resolveSourceCodexHome`（`codexHome.ts:529-536`）——`CODEX_HOME` 环境变量优先，否则 `~/.codex`；source config = `<sourceHome>/config.toml`，source auth = `<sourceHome>/auth.json`（`codexHome.ts:614,621`）。

## 2. `codexRuntime.ts` spawn 时 env / CODEX_HOME

`openConnection`（`codexRuntime.ts:1335-1420` 区间）：
```
const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: homeDir };   // :1389
```
**整个 `process.env` 原样继承，只覆盖 `CODEX_HOME` 一个键**——`:1380-1388` 注释明确承认这是有意的：Claude 会话跑过后 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 已经挂在 Host 进程 env 上（`index.ts:148-152` `ensureRuntime` 写入），会顺带传给 codex 子进程；不过滤的理由是用户的 `model_providers.<id>.env_key` 可能就指向这类变量名，过滤会导致「丢认证报难懂错误」。此约束在 open-q #6 已被用户 2026-08-09 答复关闭（claude/codex 共用同一把 key，只是 URL 不同），但**代码本身没变**，仍是"整体继承"。

`connect({ plan, env, cwd: workspacePath, handlers })`（`:1402-1420`）调用 `spawnCodexConnection`（`codexConnection.ts:444-505`），`spawn(plan.nodeExecPath, [...plan.args], { cwd, env, stdio, windowsHide })`（`:449-454`）——env 原样传给 `child_process.spawn`，**不设 shell，不做 PATH 查找**。

**凭据经过的手**（当前链路，写死 `~/.codex` 版本）：
1. Onboarding 服务器响应体 → `OnboardingService.verifyAndRegister` JS 内存（`OnboardingService.ts:121,136`，Main 进程）
2. 写盘 `~/.codex/auth.json`（`OnboardingService.ts:355-360`，Main 进程，`writeCodexConfig`）
3. `ensureCodexHome` 用 `copyFileSync` 拷到 `<userData>/codex-home/auth.json`（`codexHome.ts:632`，Host 进程，**不经 JS 内存**）
4. codex 子进程自己按 `CODEX_HOME` 直接读盘（不经 AiClient 任何进程内存）
5. 旁路二次读取：`UsageService.readCodexApiKey()`（`src/main/services/usage/UsageService.ts:63-79`）为打点/用量登录再读一次同一个 `~/.codex/auth.json`
6. 旁路三次读取：`OnboardingService.checkCredentialsHealth()`（`OnboardingService.ts:606-621`）读 `OPENAI_API_KEY` 字段做整机健康门禁（`main/index.ts:424-425` → `Root.tsx:403` 全屏拦截）

**resume 的额外一层（H9 layer 2）**：`thread/resume` 会**从 config.toml 重新派生**posture（不是 thread/start 传的参数决定），所以 `approval_policy`/`sandbox_mode` 必须被写死在 codexHome 的 config.toml 里（见上），`verifyResumePosture`（`codexRuntime.ts:711-733`）在 resume 后校验 echo，不一致直接 throw `CodexResumePostureError`（`:747-751`，H9 layer2 是硬失败不是警告）。

## 3. `OnboardingService.writeCodexConfig` 写死键集 vs. codex 真实 schema

**当前写入**（`OnboardingService.ts:391-406`，`upsertCodexConfigToml`）：
- Root：`model_provider = "jyw"`（force）
- `[model_providers.jyw]`：`name`（ifMissing）、`base_url`（force）、`wire_api="responses"`（ifMissing）、`requires_openai_auth=true`（ifMissing）、`model_context_window=1000000`（ifMissing）、`model_auto_compact_token_limit=9000000`（ifMissing）
- auth.json：`{ ...existingAuth, OPENAI_API_KEY: apiKey }`（`:356`）

**[实测] 用本机 codex-cli 0.145.0 二进制核对（`/home/dan/.nvm/.../codex-linux-x64/.../bin/codex`，与本仓 fixture 同版本）**：

1. `ModelProviderInfo`（`model_providers.<id>` 表）真实字段集，从二进制 serde 符号读出（strings 命中，`env_key`/`env_key_instructions`/`experimental_bearer_token`/`aws`/`query_params`/`http_headers`/`request_max_retries`/`stream_max_retries`/`stream_idle_timeout_ms`/`websocket_connect_timeout_ms`/`requires_openai_auth`/`supports_websockets` 连续出现同一符号簇）——**没有 `model_context_window` / `model_auto_compact_token_limit`**。
2. **[实测 codex --strict-config exec]**：把 `model_context_window`/`model_auto_compact_token_limit` 放进 `[model_providers.jyw]` 下，`--strict-config` 直接报错 `unknown configuration field 'model_providers.jyw.model_context_window'`；同样两个键放到 **root 层**（跟 `model`/`model_provider` 同级）时 `--strict-config` 通过、正常进入 exec 流程。
   → **`OnboardingService.writeCodexConfig` 现在把这两个键写错了 section**：默认（无 `--strict-config`）下 codex 静默丢弃，等于这两行从未生效过。生成模式重写时若要它们生效，必须放 root，不是 `[model_providers.<id>]`。
3. `wire_api` 合法值只有 `chat`/`responses`（源码枚举，未在此机验证第三值，标 [未证实] 但 `responses` 与 fixture 一致可信）。

**「由托管凭据生成 config.toml」模式的最小完整形状**（综合 codexHome 强制键 + codex 真实 schema + open-q #9 已定方向 `docs/plantree/plans/multi-agent/open-questions.md:72-73`）：

```toml
# root
model_provider = "<id>"
model = "<model-name>"          # 可选，沿用现有 CODEX_CONFIG_ROOT_ALLOWLIST 语义
approval_policy = "on-request"  # codexHome 强制写，来自 CODEX_PERMISSION_DEFAULT
sandbox_mode = "workspace-write"
# model_context_window / model_auto_compact_token_limit 若要保留，须落在这一层，不是下面的表里

[model_providers.<id>]
name = "<id>"
base_url = "https://xxx.com/v1"        # D47 ⑤ 口径：codex 侧固定 /v1 变体
wire_api = "responses"
requires_openai_auth = true            # 或 false + env_key，见 Q4 两条可行路径
env_key = "<AICLIENT_INJECTED_VAR>"    # 仅当 requires_openai_auth=false 时必填；见 Q4
```

## 4. 无 `~/.codex/` 写盘时的 OPENAI_API_KEY 注入路径 + 无登录态表现

**[实测] codex 支持纯 env 注入，两条可行路径，均已用本机 0.145.0 二进制 + `codex doctor` / `codex exec` 验证（脚本与产物见 scratchpad `envkey_ctx.txt`、`exec_out.txt`）**：

**路径 A——`requires_openai_auth=false` + `env_key`**（open-q #9 原定方向）：
```toml
[model_providers.jyw]
env_key = "AICLIENT_TEST_KEY"
requires_openai_auth = false
```
`CODEX_HOME` 目录下**完全没有 `auth.json`**，仅设进程 env `AICLIENT_TEST_KEY=sk-...`：
```
✓ auth   auth is provided by the active model provider
    provider auth env var    AICLIENT_TEST_KEY (present)
```
`codex exec` 正常起会话；env 变量缺失时 `codex exec` 直接报 `ERROR: Missing environment variable: 'AICLIENT_TEST_KEY'.`（两行重复，无提示登录 UI）。

**路径 B——`requires_openai_auth=true` + 标准 `OPENAI_API_KEY` env**（更贴近现有 `jyw` provider 配置，改动更小）：
同样**无 `auth.json`**，只设 `OPENAI_API_KEY=sk-...`：
```
✓ auth   auth is provided by environment
    auth env vars present   OPENAI_API_KEY
```
`codex exec` 越过登录检查、直接尝试连 `base_url`（观测到 `ERROR: Reconnecting... 1/5` —— 已经在打网络请求，说明认证阶段已通过）。

两条路径都不需要写 `auth.json`；**A 更贴合 open-q #9 现记录的方向（`env_key` 指向 app 注入的自定义变量名，避免撞上标准变量语义），B 改动面更小（沿用现有 `requires_openai_auth=true`，只是把 auth.json 换成进程 env 里塞 `OPENAI_API_KEY`）**——具体选哪条留给规格轮裁定，本条只证明两条都可行。

落地到 `codexRuntime.ts:1389`，只需在拼 `env` 时多塞一个键：
```ts
const env = { ...process.env, CODEX_HOME: homeDir, OPENAI_API_KEY: managedKey };  // 路径 B
// 或 [ENV_KEY_NAME]: managedKey                                                   // 路径 A
```

**无登录态时现有降级链路**——**[实测代码路径，非猜测]**：今天的 `agent_unsupported` 三道闸门（`index.ts:181-253`）**完全不检查凭据**，只查：codex.js 入口是否存在（`probeCodexEntry`）、`AICLIENT_CODEX_HOME` 是否非空、`ensureCodexHome`（mkdir 层面）是否抛错。也就是说：**一台从未登录过 codex 的机器，`agent_unsupported` 门不会拦——** `HostAgentRegistry` 仍会把 `codex` 列进 `capabilities.agents`，`session.create` 会正常起进程、走完 `initialize` 握手（app-server 初始化不需要凭据），失败要等到实际的 `turn/start`/模型请求那一步才会在 codex 侧报错（[未证实] 具体报错帧形状——本次调查用 `codex exec` 验证了裸二进制行为，没有驱动 app-server JSON-RPC 走一遍真实 turn，需要规格轮补一次 app-server 层的 [实测]）。

**现有的"未登录"UX 其实在更外层**：`checkCredentialsHealth()`（`OnboardingService.ts:578-628`）读 `~/.claude/settings.json` env + `~/.codex/auth.json` 的 `OPENAI_API_KEY`，任一为空则 `Root.tsx:403` **整个 App 不渲染**，退回 `OnboardingShell`（`register-email` 步骤）——这是一个**应用级全屏门禁**，不是会话级 `agent_unsupported` 降级。D47 落地后这个门禁的判据必须从"文件是否存在"改成"app 托管凭据是否存在"，否则退役了 `~/.codex/auth.json` 之后这个门禁会永远判定未登录。

## 风险清单

1. **`checkCredentialsHealth` / `UsageService.readCodexApiKey` 是 `~/.codex/auth.json` 的另外两个读者**（`OnboardingService.ts:606-621`、`UsageService.ts:63-79`），退役写盘后这两处必须同步改指向 app 私有store，否则一个继续拿旧文件误判"未登录"把全屏门禁焊死，一个用量上报直接失效。
2. **`agent_unsupported` 三道闸门不含凭据检查**（`index.ts:181-253`），D47 落地后如果只在 `OnboardingService`/`Root.tsx` 加门禁而不管 Host 侧，会出现"App 层挡住未登录用户，但 Host 侧 codex 仍被判定 supported"的口径不一致，需要规格轮决定是否要把凭据健康并入 `HostAgentRegistry` 的第四种 reason。
3. **`ensureCodexHome` 返回的 `authCopied` 无人读取**（调用点 `codexRuntime.ts:1357-1365` 只取 `home.homeDir`）——生成模式如果继续走"复制 auth.json"这条腿会保留这个哑返回值；如果切到纯 env 注入（Q4 路径 A/B），`authCopied`/`copyFileSync` 整段逻辑连带 `AUTH_BASENAME` 常量都要删，属于净减代码，不是净加分支。
4. **`OnboardingService.writeCodexConfig` 的 `model_context_window`/`model_auto_compact_token_limit` 当前写在错误的 TOML 层级**（`OnboardingService.ts:397-406`，见 Q3 [实测]），默认 parse 下被 codex 静默丢弃，等于从上线到现在这两个"上下文窗口/自动压缩阈值"配置从未真正生效过。生成模式重写这段时如果照抄现有 section 结构，会把这个既有 bug 一起搬进新实现；如果规格轮决定这两个值本来就不重要（本地静态目录已覆盖模型元数据),也应该明确决定"丢弃"而不是继续悄悄写错地方。
5. **`codexHome.ts` 当前的 root 白名单只放行 `model`/`model_provider`**（`:107-110`）。若生成模式要让 `model_context_window`/`model_auto_compact_token_limit` 真正生效（按 Q3 结论它们必须落 root），"投影退役"之后新的生成函数必须显式产出这两个 root 键，而不能依赖现有 `CODEX_CONFIG_ROOT_ALLOWLIST`（那是给"投影"模式用的白名单，生成模式是直接拼字符串，不经过 `projectCodexConfig`）——两套模式共存期间（回退路径）容易在"白名单要不要加这两个键"上产生分歧，需要规格轮显式裁定。
6. **`codexRuntime.ts:1389` 的"整体继承 process.env"注释已明确记录一个未解决的开放问题**（`:1380-1388`）：Claude 的 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 会顺带进 codex 子进程。open-q #6 已按"同一把 key"关闭这个顾虑，但生成模式如果改用**新的自定义 env 变量名**（Q4 路径 A 的 `env_key` 指向应用自定义变量），要注意这两个继承来的 Claude 变量不会跟新变量冲突，冲突面反而是路径 B（复用标准 `OPENAI_API_KEY`）——如果将来 Claude 侧 env 也不小心塞了同名变量会互相打架，需要在选路径时纳入考虑。
7. **[未证实]**：本次调查用 `codex exec`（非 app-server JSON-RPC）验证了 env-only 认证在裸二进制层面可行；没有驱动一次真实 `codex app-server` 的 `initialize`→`thread/start`→`turn/start` 流程来确认 app-server 模式下"无凭据"时具体在哪一帧报错、错误 code 是什么形状。规格轮如果要精确设计"无登录态时会话应表现为什么"的 UI 文案/错误分类，建议补一次 app-server 层 spike（可复用 `src/agent-host/spikes/s1-codex-direct-probe.ts` 的驱动方式）。