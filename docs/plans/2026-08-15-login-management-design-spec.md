# 用户登录管理（D47）设计规格 — rev.2（双轨合取 + 拍板收口版）

> 2026-08-15。立项拍板 = 总台账 **D47**（范围/验证码登录/服务端最小改/单账号/app 托管落盘五点）。
> **本文来源**：四份规格前调查（[01~04](./2026-08-15-login-mgmt-investigation/)）→ 双轨双盲设计
> （A 轨 Opus [05](./2026-08-15-login-mgmt-investigation/05-design-track-opus.md) /
> B 轨 Codex [06](./2026-08-15-login-mgmt-investigation/06-design-track-codex.md)，同一任务书、互不见对方）→ 编排者合取。
> 分歧裁定记录见 §9（哪轨哪点被采/被否，全部留痕）。
> **状态**：**rev.2 已拍板收口（2026-08-15 当场问答 U1~U4，结果见 §8）**；幂等假定已由服务端代码定论（§5），S7 删除。下一步 = S0（余五 spike）→ S1 施工。

## §0 范围与输入

- 内部员工工具：邮箱+验证码登录（后缀白名单不变），员工零感知 claude/codex 凭证；单账号。
- 服务端：cch 网关（固定业务代码）不动；onboard 服务可小改（目标零新接口，见 §5）。
- 本文只锁设计；每片施工前仍按惯例走规格细化 + 评审。

## §1 不变量（全程有效，测试以此为纲）

| # | 不变量 |
|---|---|
| I1 | 凭据唯一权威 = **CredentialVault**（`<userData>/credentials/vault.json`）。托管 claude-home 的 `settings.json` 是**唯一授权的第二份落盘**（0600、app 生成、登出即再生成无凭据版），此外任何位置不得出现明文 key |
| I2 | 明文 key 永不进 renderer / IPC 返回值 / 日志 / trace。`verify-and-register` 的全量响应（含 key）**止步 Main**，renderer 只收 `{ok, account, authState}`（现状是全量穿到 renderer——B 轨抓出的 blocker，`shared/types/onboarding.ts:44` + `preload/index.ts:768`）。建统一 redactor（拦 `authToken/apiKey/OPENAI_API_KEY/ANTHROPIC_*/AICLIENT_CODEX_API_KEY/auth-token/cookie`） |
| I3 | flag on（S6 中和后）：不写真实 `~/.claude/settings.json`、`~/.claude.json`、`~/.codex/*`；静态扫描断言生产源码不再拼 `homedir() + '.claude'` |
| I4 | codex 生成 config 不含 key；`<userData>/codex-home` 下**不存在 auth.json** |
| I5 | **Host 进程生命周期 == 凭据纪元**：登录/登出/失效必 `agentHostManager.shutdown()`，下次 `ensureStarted` 重建（解 `ensureRuntime` 永久缓存与 registry 单飞记忆的凭据不刷新，`agent-host/index.ts:130-131`、`agentSupport.ts:132-137`） |
| I6 | 网络故障 ≠ 凭据失效。业务请求 401/403 只触发一次 `POST {cch}/api/auth/login {key}` auth-probe；**probe 明确拒绝**才是失效终局证据（防离线/5xx 触发验证码风暴，防业务权限 403 误判） |
| I7 | Vault 不被 flag-off 触碰；S6 中和后**禁止任何 vault → 真实 home 的反向导出** |
| I8 | 远程 SSH 本轮显式排除：vault 凭据不进 `getRemoteServerSource()` 模板、不推远端；远程会话维持现状（吃远程机自己的配置） |
| I9 | 登出七步序（防竞态，B 轨 R14）：**关 spawn gate** → 终止全部会话/PTY → host shutdown → 清 vault（留 `lastEmail`）→ 再生成无凭据版两个 home → 清 cch cookie → 广播 `signed_out` |
| I10 | 登录态单一真源 = Main 的 **AuthStateService**；Root 与 `MainWindow.isAppMountedFor()` 读同一快照（收敛现有双镜像，`MainWindow.ts:28-35`） |

## §2 总架构

```
邮箱+验证码 → onboard 服务（send-code / verify-and-register，语义=登录即换取既有 key）
      │（全量响应止步 Main）
      ▼
CredentialVault  <userData>/credentials/vault.json（0600 原子写；safeStorage 可用则加密，
      │           不可用降级 enc:"none" + 诊断位；解密失败 → reauth_required，绝不崩溃）
      ├─ ClaudeHomeGenerator → <userData>/claude-home/{settings.json(env 三键+model+
      │      autoUpdates:false+skipWebFetchPreflight+生成抬头), .claude.json(信任标志)}
      │      Main 启动早期一次性 process.env.CLAUDE_CONFIG_DIR=<claude-home> 并剥离继承的
      │      ANTHROPIC_*（dev.js 剥离逻辑的生产版）：
      │        ├─ Main 五个读者（HookManager/IdeBridge/ProviderManager/…）自动跟随
      │        ├─ agent-host 继承 → claudeSettings.ts 读托管文件 → SDK options.env（零改动）
      │        └─ PTY 终端继承 → 手敲 claude 可用，token 不进 shell env
      ├─ CodexHomeGenerator → <userData>/codex-home/config.toml（生成非投影，无 auth.json）
      │      Main 注入 AICLIENT_CODEX_API_KEY → codexRuntime env（env_key 路径）
      │      终端 PTY 注入 CODEX_HOME + AICLIENT_CODEX_API_KEY（Main 侧填，不经 renderer）
      ├─ UsageService 改读 Vault（退役读 ~/.codex/auth.json）；401/403 → auth-probe → 失效信号
      └─ AuthStateService（三态状态机 §4）→ IPC auth.getState / auth.stateChanged（推送）
             ├─ Root 门禁（四 query 收敛为 authState + cliStatus/runtime 两类）
             └─ MainWindow.isAppMountedFor()
```

## §3 各轴裁定摘要

### A. Claude 侧（合取：A 轨机制为主干）

- **托管 claude-home + 进程级 `CLAUDE_CONFIG_DIR` 重定向**；凭据由生成的 `settings.json` 携带（非 shell env）。
  一箭四雕：hooks 门禁 `isClaudeInstalled()`（目录存在性）恒真、IDE bridge lockfile 跟随、`.claude.json`
  信任标志隔离、终端零额外改动且 `printenv` 不见 token。`skipWebFetchPreflight` 等文件键（无 env 等价物）保留。
- 硬编码写手同步清理：`ClaudeRuntimeConfig.disableClaudeAutoUpdates`（折进生成器后删）、
  `mergeClaudeEnvSettings` + IPC `CLAUDE_RUNTIME_REGISTER_ENV`（renderer 零调用死码，且是第二权威后门，删）、
  `McpManager.ts:15` 硬编码 `~/.claude.json`（B 轨补充，改走 `CLAUDE_CONFIG_DIR` 口径）、
  `OnboardingService` 四处（被生成器取代）。
- **Provider 面板**：托管模式下写路径退役（`CLAUDE_PROVIDER_APPLY`/watcher 删），只读回显降级为
  不含明文的诊断形状（现状 `extractProviderFromSettings` 把明文 authToken 推 renderer，与
  `ClaudeSettingsDiagnostics` 口径冲突）；`SessionBar`/`ActionPanel` 的 provider 快捷入口同步关闭（B 轨）。
  **S2 前置排查**：定位该面板 renderer 消费者（调查标 [未证实]），无消费者则整模块删。
- **历史双源**：`listSessionHistory` 扩为「托管 home + 传统 `~/.claude`（只读）」合并（老历史不消失、不搬运、可逆）；
  `resolveClaudeConfigDirForResumeSession` 加托管候选；`~/.aiclient/claude-null` 死路径本轮判死。

### B. Codex 侧（两轨一致）

- 生成模式取代投影：root 只写 `model_provider`/`model`/`approval_policy`/`sandbox_mode`（posture 两键
  必须保留——`verifyResumePosture` H9 layer2 硬校验）；provider 表 `name/base_url("/v1")/wire_api="responses"/
  requires_openai_auth=false/env_key="AICLIENT_CODEX_API_KEY"`。带 GENERATED 抬头。
- **`model_context_window`/`model_auto_compact_token_limit` 本轮不写**（实测证明写错层级从未生效 →
  行为中性=不写；且现值 9M>1M 语义可疑——数值定夺另立开放问题 O4，A 轨裁定 + B 轨疑点合并）。
- 认证 = env_key 自定义变量（否 `OPENAI_API_KEY`：会被第三方工具捡走错投；否 app 内 auth.json：第二份落盘 +
  拷贝链复杂度）。删投影白名单、`AUTH_BASENAME`、`authCopied` 整段（净减）。
- **codex child env 收窄**（B 轨采纳）：投影退役后用户 `env_key` 顾虑消失，spawn codex 时剥离 `ANTHROPIC_*`，
  只带 `CODEX_HOME` + `AICLIENT_CODEX_API_KEY` + 常规变量。
- 无登录态：`HostAgentAvailabilityReason` 加第四枚 **`credentials_missing`**（codex 专用；三子串互不包含
  纪律延续）；Main 侧 session/PTY 创建入口同时检查 AuthStateService（纵深，不只靠 renderer 门禁）。
  Claude 侧维持 `available:true`（App 级门禁是正门），凭据态走既有 `hasAuthToken` 诊断位。

### C. 存储（两轨一致）

- `<userData>/credentials/vault.json`；否 `~/.aiclient`（远程 helper 共用命名约定 + umask 权限弱 + 无 profile
  隔离）；否复用 SharedSessionState（浅合并坑 + 防抖写语义不符）。
- schema：`{version, enc, lastEmail, identity{email,userId}, cchBaseUrl, claude{baseUrl,authToken},
  codex{baseUrl,apiKey}, invalidatedAt}`；`deriveCchBaseUrl` 结果落库不重算。
- safeStorage：可用即加密；Linux `basic_text`/不可用 → `enc:"none"` + 0600 + 诊断位，**不阻断登录**；
  解密失败 → `reauth_required`（重登 30 秒）。〔设计者默认，不上拍板〕
- 安全档位声明：防偶然泄露（备份同步捞走、0644 他人可读、误发日志），不防同 OS 用户恶意进程——key 本来
  就要交给子进程与员工 shell，该威胁模型结构性无解。卸载留存维持现状（`deleteAppDataOnUninstall:false` 不动）。
- dev/prod：dev.js 维持 D42 现状，但 `buildChildEnv` 强制 `AICLIENT_MANAGED_CREDENTIALS=0`（防 Main 全局
  `CLAUDE_CONFIG_DIR` 盖掉 dev 隔离目录）。

### D. 登录态与 UI（合取：B 轨状态机细化 + A 轨复用清单）

三态：`signed_out`（reason: never/logout）｜ `authenticated`（`remoteHealth: valid|unknown`；离线/5xx 保持
本态只降 unknown）｜ `credentials_invalid`（auth-probe 明确拒绝 / vault 损坏 / 解密失败，带 reason 枚举）。
UsageService 既有 5 分钟轮询 + `/api/auth/login` 重试链 = 零新增契约的失效心跳。

- Root 四 query → `authState` + 运行时两 query；`ONBOARDING_LIVE_CREDENTIALS_STATUS` 一次性推送退役，
  `auth.stateChanged` 持续推送取代（解「App 内只弹 toast 不路由」）。
- `SKIP_ONBOARDING_GATE` 于 S5 收回 → dev 逃生舱 `AICLIENT_SKIP_AUTH_GATE=1`；打包版加负控断言禁绕过（B 轨）。
- UserProfileCard 三态芯片（已登录/失效可点重登/未登录）；重登复用 `initialStep='register-email'` +
  客户端 `reason` prop 换文案（不污染服务端错误码枚举）；预填 `lastEmail`。
- 事件名 `aiclient:onboarding:open` 与 queryKey 先提 shared 常量（防三态逻辑散布遗漏）。
- 登出 = I9 七步；不做服务端 revoke（会踢掉员工其他机器）。

### E~F. 服务端契约 / 迁移回退 → §5 / §6

## §4 登录态判定表

| 输入 | 状态 |
|---|---|
| 无 vault / 已清除 / 解密失败 | `signed_out` 或 `credentials_invalid`（曾登录过则后者，预填邮箱） |
| vault 完好，未在线验证 | `authenticated + remoteHealth:unknown` |
| auth-probe（`/api/auth/login`）成功 | `authenticated + remoteHealth:valid` |
| 网络错误/超时/5xx | 保持 `authenticated`，降 `unknown`，**不重登** |
| 业务 401/403 → auth-probe 亦拒 | `credentials_invalid: rejected` |

## §5 服务端契约

**首选零新接口**：`verify-and-register` 实证并固化为「验证码 → 回发该员工既有 key」的幂等语义。

**幂等假定已定论（2026-08-15，用户授权后直接核服务端代码，仓库 `jc-dannauy/jyw-cch-onboarding`）**：
`src/routes/verify-and-register.ts:86-120`——已存在用户走 `findUserByName → getKeys → 回发首个 enabled
未过期既有 key`，**不轮换不新建**；仅当既有 key 全部失效/过期才 `addKey` 补发（恢复语义）。`send-code.ts`
对已注册邮箱不拒发（仅限流/冷却）。同一把 `apiKey` 同时作 claude authToken 与 codex apiKey，
codexBaseUrl = base + `/v1`（`verify-and-register.ts:127-139`）——与 D47 口径逐字吻合。
**登录 = 原两接口重跑，零新接口，S7 删除。**

残余细节（登记不阻断）：① 新用户并发首注册存在 `findUserByName→addUser` 竞窗（已注册用户=登录场景为只读，
无竞态）；② cch 侧禁用旧 key 后，下次登录自动补发新 key——「换 key」恢复路径天然存在，连带后果见 §6 已知限制；
③ 验证码单次使用（`markUsed` 原子），并发同码 verify 一胜一 `CODE_USED`。
S0 保留一次**轻量部署一致性实打**（一封验证码走全程，确认线上实例与仓库行为一致），取代原八步 spike。

## §6 迁移与回退

- **收编（adopt）**：flag on 且无 vault 时一次性从旧三处导入（凭据 + email/serverUrl），写 marker——
  **升级员工免重登**。守卫（B 轨）：仅当 baseUrl 匹配公司网关才静默导入；不明来源（员工个人 provider）
  不导入 → `credentials_invalid: migration_incomplete` 预填邮箱重登。导入后打一次 auth-probe 验真。
- **双写过渡（A 轨裁定胜出）**：S1~S5 期间登录同时写 vault + 旧文件（=旧写手继续跑），任意时刻 flag off
  即回今天行为，**回退分支必须退到安全态**；S6 停双写。B 轨「禁反向导出」保留为停双写后不变量 I7。
- **旧文件处置（用户拍板 U1）：收编但永不清理**——外科中和整段取消，存量 `~/.claude`/`~/.codex` 留置原样，
  系统终端（app 外）用法不断。已知限制（诚实登记）：(a) 旧文件 key 可能过时（cch 禁旧 key → app 重登自动拿
  新 key，但旧文件不更新，app 外终端将 401 直到人工处理）；(b) **新装机器** flag on 后 app 从不写旧位置 →
  app 外系统终端无凭据（app 内终端不受影响）；如成真实痛点另行拍板。
- **仍随本轮修的既有 bug**：flag-off 登出路径的 `removeCodexConfig` `rmSync` 整删两文件（会毁用户自有 codex
  配置）——改外科式只删 app 键（`OPENAI_API_KEY` 字段 / `[model_providers.jyw]` 表）。
- 停双写后 flag off = 存量机器靠留置旧文件即时可用；全新机器需一次重登（旧路径会重写旧文件）；vault 不受
  flag 影响，翻回 on 即时恢复。
- flag：`AICLIENT_MANAGED_CREDENTIALS`（严格 `'1'` 判 on，沿用 `resolveCodexEnabled` 读法）。

## §7 施工切片

> 每片：Happy Path → 过程断言 → 用例 → flag → 逻辑；门禁逐门串行；变异验证咬合。

| 片 | 内容 | 关键断言（摘） |
|---|---|---|
| **S0** | 六 spike，不动产品代码：E1 部署一致性轻量实打（幂等已代码定论，§5）· E2 `$CLAUDE_CONFIG_DIR/.claude.json` 信任标志实测 · E3 SDK `settingSources:[]` + 无 `~/.claude` 全会话 · E4 app-server（非 exec）缺 env_key 报错帧 · E5 cch 401/403 可区分性（业务 403 vs auth 拒）· E6 safeStorage 三平台矩阵 | trace + fixture 落库；E2/E3 定 §3.A 主干成立性 |
| **S1** | Vault + AuthStateService + **IPC 消毒**（I2，含 verify 响应裁剪）+ 双写开始 | 0600；`clear` 留 lastEmail；日志无 secret 子串；off 轮不写 vault；renderer 收不到 key（负控：造违规返回断言变红） |
| **S2** | ClaudeHomeGenerator + 全局 `CLAUDE_CONFIG_DIR` + 剥离继承 ANTHROPIC_* + 硬编码写手清理（§3.A 四组）+ Provider 写路径退役 + historyReader 双源 | 一次 SDK 会话期间 `~/.claude*` 写调用数=0（fs 打桩）；hooks/IDE lockfile 落托管 home；历史含新旧两源；生成文件含 skipWebFetchPreflight |
| **S3** | 终端注入：claude 自动继承；codex 由 Main 在 `SessionManager.createLocal` 填 `CODEX_HOME`+key；resume 候选扩托管 home | session-create IPC payload 无 secret；登出态两键缺席；终端 `claude`/`codex` 免向导直接可用 |
| **S4** | Codex 生成模式 + env_key + 删投影/auth 拷贝链 + `credentials_missing` + child env 剥离 ANTHROPIC_* | 生成 toml root 无上下文两键、表有 env_key；codex-home 无 auth.json；`--strict-config` 过；四 reason 子串互异；报错帧匹配 E4 fixture |
| **S5** | 三态/推送/Root 收敛/MainWindow 同源/门禁收回（逃生舱+打包负控）/UserProfileCard/登出七步/Usage 改读 vault | Root 与 MainWindow 同一服务（换服务两处同变）；离线不重登（负控：403+probe 成功不转失效）；登出后托管 home secret 字节=0、调用序断言 |
| **S6** | 收编 + 停双写 + marker + 修 flag-off 登出 rmSync bug（外科中和随 U1 取消） | marker 单次；收编仅在 baseUrl 匹配公司网关时静默；无凭据机器 no-op；停双写后一次登录对旧位置写调用数=0 |
| ~~S7~~ | **已删除**（幂等已代码定论，零新接口，见 §5） | — |

**通用负控**（B 轨，每片附带）：造「key 进 IPC 返回」「key 写进生成 config」「空进程列表通过终止断言」
「provider 段塞错层级字段」等违规实现，断言测试变红——对齐本仓变异验证纪律。

## §8 拍板结果（2026-08-15 当场问答，rev.1 → rev.2）

| # | 问题 | 用户拍板 | 落点 |
|---|---|---|---|
| U1 | 存量旧凭据 | **收编但永不清理**（否决推荐项「延迟外科清理」） | §6 改写；S6 中和取消；已知限制 (a)/(b) 登记 |
| U2 | 门禁收回节奏 | **S5 收回**（推荐项） | S5 照案执行，逃生舱 `AICLIENT_SKIP_AUTH_GATE=1` + 打包负控 |
| U3 | 幂等实证方式 | **直接读服务端代码**（用户给出仓库 `jc-dannauy/jyw-cch-onboarding`） | §5 定论 CONFIRMED；S7 删除；S0-E1 降为轻量实打 |
| U4 | 换邮箱旧历史 | **不处理，接受现状**（内部一人一机，换绑罕见） | 越权面登记为已知限制（§10 R10'），不施工 |

设计者默认（拍板时一并知会，未被否）：safeStorage 降级明文 0600 不阻断；卸载留存不动；codex 上下文两键
本轮不写（O4 另立）；终端 codex 共用托管 home 接受强制 posture（`codex --config` 为逃生舱）。

## §9 双轨分歧裁定记录（traceability）

| # | 分歧 | 裁定 | 理由 |
|---|---|---|---|
| 1 | Claude 凭据载体：A=托管 settings.json 携带 env；B=纯 env 注入、文件零凭据 | **A** | B 方案终端侧 token 必进 shell env（printenv 可见 + 泄给全部子进程），比 0600 文件更暴露；A 零改动 agent-host。B 的批评「第二份落盘削弱 vault 加密」成立 → 收进 I1 限定与安全档位声明 |
| 2 | verify 响应明文穿 renderer | **B 独有发现，采纳为 I2** | blocker 级；A 轨漏判 |
| 3 | 回退安全态：A=双写过渡；B=拒双写、新用户 fail-closed | **A**（过渡期）+ B 的「禁反向导出」为中和后 I7 | 「回退分支必须退到安全态」是本仓既有裁定纪律；fail-closed 不是安全态 |
| 4 | fallback 端点：A=login-verify+客户端选端点；B=统一 verify-and-login | **B** | 本地状态不可信；验证码可能被首调烧掉；单路径更简 |
| 5 | 失效判定：A=401/403+login 重试失败；B=细化 remoteHealth+离线不判死+业务 403 需 auth-probe 确认 | **B 细化并入** | 互补，B 防误杀更完整（I6） |
| 6 | codex 上下文两键：A=本轮不写；B=root 写入修正值 | **A** | 行为中性优先；B 的数值疑点（9M>1M）并入 O4 |
| 7 | 换邮箱历史越权 | **B 独有，升拍板 U4** | A 轨漏判 |
| 8 | 远程 SSH：A=本轮排除；B=审计后允许注入 | **A** | 范围控制；B 审计清单登记为将来前置 spike（O5） |
| 9 | codex child env 剥离 ANTHROPIC_* | **B 采纳** | 投影退役后原保留理由（用户 env_key 引用）消失 |
| 10 | McpManager 硬编码写手 / SessionBar 快捷入口 / 登出 spawn-gate 竞态 | **B 补充事实全收** | 并入 §3.A / I9 |

## §10 风险与开放问题

R1 `.claude.json` 在 `$CLAUDE_CONFIG_DIR` 下的 CLI 实解（高，E2 定生死）· R2 `settingSources:[]` 语义（中，E3）·
R3 终端 codex env 可见性不对称（中，档位声明覆盖）· R4 历史双源排序/续接（中）· R5 Provider 面板消费者未定位（中，S2 前置）·
R6 safeStorage Linux 退化（低）· R7 codex home 并发（低）· R8 portable 与安装版 userData 同异未证（低）· R9'〔U1 后果〕旧文件 key 过时 / 新装机器 app 外终端无凭据（已知限制，§6）· R10'〔U4〕换邮箱可见旧历史（已知限制，不施工）。
**O1** ~~onboard 幂等~~（已关闭：代码级 CONFIRMED + S0 轻量实打复核）｜ **O2** app-server 无凭据错误帧（E4）｜ **O3** cch 401/403 语义细分（E5）｜
**O4** codex 上下文两键数值定夺（另立，需真实网关回合实测）｜ **O5** 远程 SSH 注入审计清单（B 轨 §3-8，将来启用前置）。
