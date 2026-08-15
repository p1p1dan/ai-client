# D47 S3+S4 施工规格 — Codex 生成模式与终端注入（rev.1 待评审）

> 2026-08-15。母规格 = [D47 设计规格 rev.2](./2026-08-15-login-management-design-spec.md) §3.B/§7 S3/S4 行；
> 证据 = [02-codex-side-seams](./2026-08-15-login-mgmt-investigation/02-codex-side-seams.md)（env-only 双路径实测、
> 层级 bug）+ [S0-E4](./2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md)（缺 env_key 帧 fixture）。
> S1/S2 已落（Vault + 托管 claude-home + managedFileWriter + `auth.managedMode`）。
> **合并理由**：S3 的 claude 终端侧已随 S2 全局重定向天然覆盖（PTY 继承 `process.env`），两片剩余作业均以
> codex 为中心。两施工子批 S4a（agent-host）/ S3b（Main/PTY）文件集不相交可并行。

## §1 范围与交付物

### S4a（agent-host 侧：生成模式取代投影）——模式信号见 §2.1

**改动**：
- `src/agent-host/codexHome.ts` — 新增**生成模式**：`generateCodexConfig({baseUrl, permission})` 直接拼
  config.toml（形状见 §2.2），取代投影；投影模式整链（`projectCodexConfig`、`CODEX_CONFIG_ROOT_ALLOWLIST`/
  `CODEX_CONFIG_TABLE_ALLOWLIST`、auth.json 拷贝链 `AUTH_BASENAME`/`copyFileSync`/`authCopied`/mtime 比对）
  **保留为回退分支**（模式信号缺席时走现状——flag-off 等价性），生成模式下拷贝链**不执行**且断言
  codex-home 无 auth.json（I4）。
- `src/agent-host/codexRuntime.ts` — spawn env（`:1389` 一带）：生成模式下
  `{...restEnv, CODEX_HOME, AICLIENT_CODEX_API_KEY}`，其中 `restEnv` = process.env **剥离 `ANTHROPIC_*`**
  （母规格 §3.B child env 收窄：投影退役后用户 `env_key` 顾虑消失）；回退模式维持现状全继承。
- `src/agent-host/agentSupport.ts` — `HostAgentAvailabilityReason` 增第四枚 **`credentials_missing`**：
  生成模式且 `AICLIENT_CODEX_API_KEY` 缺席 → codex 不可用；`describeHostAgentReason` 第四条子串与既有三条
  **两两互不包含**（既有纪律）；短路序 `flag_off → credentials_missing → entry_missing → home_prepare_failed`。
- codex turn 级错误映射（切片 6 的 protocolErrors 双臂模块）——新增 pattern：
  `Missing environment variable` → 具名错误码 `codex_credentials_missing`（帧形状照 E4 fixture 断言；
  这是纵深第二道，registry 前置判定是正门——E4 已证 initialize/thread/turn-start RPC 全成功）。

### S3b（Main/PTY 侧：终端注入 + claude 侧 pin）——flag 门控

**改动**：
- `src/main/services/agent-host/hostEnv.ts` — `buildAgentHostEnv` 契约加两键（flag on 且 vault 可读时）：
  `AICLIENT_CODEX_API_KEY`、`AICLIENT_CODEX_BASE_URL`（值出自 Vault；**注入即模式信号**，见 §2.1）。
  既有键与 flag-off 行为零改动（hostEnv 测试断言旧键集不变）。
- `src/main/services/agent-host/AgentHostManager.ts` — 启动时从 Vault 取值填上述两键（读取走 S1 懒工厂；
  vault 非 `ok` → 两键不注入 → Host 侧自然 `credentials_missing`/回退）。I5 已由 S2 接线
  （登录/登出 regenerate 后 shutdown → 下次 ensureStarted 重建即拿新值）。
- `src/main/services/session/SessionManager.ts` — 本地 PTY 分支（S2 trust 钩子同处）：flag on ⇒
  `options.env` 注入 `CODEX_HOME=<userData>/codex-home` + `AICLIENT_CODEX_API_KEY=<vault>`（**Main 侧填充，
  不经 renderer**——IPC payload 无 secret 断言沿用 S1 口径）；vault 非 `ok` ⇒ 两键缺席（登出态终端
  跑 codex 报 Missing env，可读）；remote 分支不注入（I8）。claude 侧零代码（PTY `{...process.env}` 继承
  S2 全局 `CLAUDE_CONFIG_DIR`），**补 pin 测试**：flag on 时 PTY finalEnv 含 `CLAUDE_CONFIG_DIR=托管 home`，
  flag off 缺席。

**不做**：UsageService 改读 vault（S5——过渡期它读的 `~/.codex/auth.json` 因 U1 留置 + 双写仍有效）；
Root/UI 登录态（S5）；`session.listHistory` 死链（登记）。

## §2 关键契约

### 2.1 模式信号（「谁拥有谁传、接收方不猜」）

生成模式的判据 = **`AICLIENT_CODEX_BASE_URL` env 在 agent-host 进程存在**（Main 注入即选型；agent-host
不读 `AICLIENT_MANAGED_CREDENTIALS`——flag 语义只在 Main 消化，与 `AICLIENT_CODEX_HOME` 同款契约风格）。
缺席 → 投影回退模式（今天行为逐字节）。`AICLIENT_CODEX_API_KEY` 存在与否独立判凭据（都在生成模式内：
有 base 无 key = `credentials_missing`；这覆盖「登录过但 vault 清了/失效」的窗口）。

### 2.2 生成 config.toml 形状（实测钉死）

```toml
# managed by AiClient — regenerated per session; sidecar .aiclient-generated 记来源
model_provider = "jyw"
approval_policy = "<per-session permission>"   # 现有 renderPermissionPosture 逻辑原样复用（H9 硬校验依赖）
sandbox_mode    = "<per-session permission>"

[model_providers.jyw]
name = "jyw"
base_url = "<AICLIENT_CODEX_BASE_URL>"          # Vault 归一化值（含 /v1），不再自行拼接
wire_api = "responses"
requires_openai_auth = false
env_key = "AICLIENT_CODEX_API_KEY"
```
`model` root 键：投影模式来自用户文件；生成模式**不写**（模型选择走会话协议 D40 线，不进 config——
如评审认为需要保留用户偏好，改为可选注入并列 as-built）。`model_context_window`/`model_auto_compact_token_limit`
**不写**（O4 维持，行为中性——实测证明历史上从未生效）。posture 每会话重生成的既有节奏不变
（`ensureCodexHome` 每次 create/resume/revive 重跑，幂等字节比对跳写逻辑保留）。

### 2.3 flag-off / 回退等价性

flag off（Main 不注两键）→ agent-host 全链今天行为：投影 + auth 拷贝 + 全 env 继承 + 三 reason 口径。
off 轮 vitest 全量 + hostEnv 旧键集断言 + codexHome 既有测试零改动即绿。

### 2.4 验证要点（施工细化按 S1/S2 范式）

1. 生成器：形状快照（posture 两键 root / provider 表五键 / 无上下文两键 / 无 model）· `--strict-config`
   实跑通过（复用仓内 codex 0.145.0）· 幂等跳写 · codex-home 无 auth.json（生成模式）。
2. 模式信号：有 base → 生成；无 base → 投影回退（既有测试全绿）；有 base 无 key → registry
   `credentials_missing` + 四子串互异。
3. spawn env：生成模式剥 `ANTHROPIC_*` + 两键在；回退模式全继承（对照）。
4. hostEnv/AgentHostManager：flag on + vault ok 两键注入；vault locked/absent/invalid 不注入；flag off 契约零变。
5. PTY：flag on 本地含三键（CODEX_HOME/API_KEY/CLAUDE_CONFIG_DIR）、renderer payload 无 secret、
   登出态缺席、remote 不注入；flag off 全缺席。
6. E4 fixture 断言 turn 级映射。
7. 变异 ≥8 对（必含：模式信号误读 flag / 生成模式仍拷 auth.json / 上下文键写进 provider 表（历史 bug 复活）/
   剥 env 漏 ANTHROPIC_ / PTY 注入走 renderer payload / credentials_missing 子串包含既有子串）。

## §3 需评审重点攻击的自设裁定

a) 模式信号用 `AICLIENT_CODEX_BASE_URL` 存在性而非透传 flag——agent-host 零 flag 感知的代价是「误设该
   env 即误入生成模式」；
b) 生成模式不写 `model` root 键（用户模型偏好在托管模式下丢失，走 D40 会话协议线）；
c) posture 每会话重生成节奏保留（生成器接管后与 S2 managedFileWriter 无关——codex-home 在 agent-host
   进程内写，跨进程写手唯一，无需队列）；
d) 剥 `ANTHROPIC_*` 只在生成模式（回退模式维持全继承——开 #6 关闭时的原始顾虑仍适用于用户自有 env_key）；
e) 终端 codex 与 app 会话共用 codex-home（母规格已默认，跨进程并发 = codex 对 `~/.codex` 原生场景同构）；
f) turn 级错误映射用 message 子串匹配（`codexErrorInfo` 只有 `other`，无结构化码可依——E4 实证）。
