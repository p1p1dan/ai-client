# D47 S2 施工规格 — 托管 claude-home 与全局重定向（rev.1 待评审）

> 2026-08-15。母规格 = [D47 设计规格 rev.2](./2026-08-15-login-management-design-spec.md) §3.A/§7 S2 行；
> S1 已落地 `a53d130`（Vault/AuthState/消毒/双写）。前置排查 =（本轮 Explore，要点录§0）。
> flag = `AICLIENT_MANAGED_CREDENTIALS`（S1 的 `resolveManagedCredentialsEnabled`，只在 Main 读）。
> **两个施工子批 S2a/S2b 文件集不相交，可并行施工**（照切片 6 三员先例）。

## §0 前置排查要点（改设计的三事实）

1. **历史 UI 真链 = `ClaudeSessionScanner`**（`ClaudeSessionScanner.ts:27`，已跟随 `CLAUDE_CONFIG_DIR`，
   经 `claude:listProjects`/`claude:getProjectSessions` 供给 `App.tsx:1163` resume）。母规格 §3.A 写的
   `listSessionHistory` 双源是**零渲染消费者死链**（`chat.listHistory` 全仓无调用点，与切片 5 spec 互证）——
   **双源合并改锚 Scanner，死链本片不动只登记**。
2. **硬编码 `homedir+'.claude'` 共 6 文件 12 处**（比原调查多一倍）：McpManager / PluginsManager /
   PromptsManager / ClaudeRuntimeConfig / RemoteHelperSource:2092（**远程模板段，按 I8 豁免不改**）/
   OnboardingService ×4（**legacy 双写本体，有意保留至 S6**）。
3. **Provider 消费面 = 3 查询/变更点 + 2 订阅点**：设置页 `ProviderList`（+`ProviderDialog` 明文回显）、
   `SessionBar.tsx:485/500` 快捷切换、`ActionPanel.tsx:231/243` 命令面板组；订阅 `ProviderList.tsx:211`（不受
   开关门控）与 `useClaudeProviderListener`（受 `enableProviderWatcher` 门控）；主进程 watcher **无视开关恒跑**。

## §1 范围与交付物

### S2a（Main 侧：托管 home + 重定向 + 写手清理）——flag 门控

**新文件**：
- `src/main/services/auth/claudeHome.ts` — **纯模块**（注入 `{ homeDir, vaultDoc|null }`）：
  `generateClaudeSettings()` / `generateClaudeJson()` / `ensureManagedClaudeHome()`（写盘编排）+
  `ensureWorkspaceTrusted(homeDir, workspacePath)`（运行时给 `.claude.json` 补 `projects[ws].hasTrustDialogAccepted`）。
- `src/main/services/auth/__tests__/claudeHome.test.ts`。

**改动**：
- `src/main/index.ts` — `app.setPath('userData')` 之后、任何服务动作之前：flag on ⇒
  `process.env.CLAUDE_CONFIG_DIR = <userData>/claude-home`（**无条件覆盖**，含 dev.js 已设值——dev 显式开
  flag 即意在验证托管链）+ **剥离继承的 `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN`**（`scripts/dev.js:91-100`
  STRIPPED 清单的生产版，防员工 shell 变量顶穿托管凭据）；flag off ⇒ **一个字节都不动**（不设不剥）。
- `src/main/services/auth/index.ts` — 挂 `ensureManagedClaudeHome` 的 electron 绑定与调用编排。
- `src/main/services/onboarding/OnboardingService.ts` — 登录成功（vault.save 后）与 `logout()`（vault.clear 后）
  flag on 时 regenerate 托管 home（登出=无凭据版，**不删目录**——历史/信任标志保留，母规格 I9）。
- 硬编码写手改口径（`CLAUDE_CONFIG_DIR ?? homedir+'.claude'`，flag-off 行为逐字节不变）：
  `McpManager.ts:14-15`、`PluginsManager.ts:7-12`、`PromptsManager.ts:5-6,59`、
  `ClaudeRuntimeConfig.disableClaudeAutoUpdates`（**改口径而非删除**——flag-off 的 `AgentInstaller.ts:380`
  链路仍需它；生成器亦写 `autoUpdates:false`，flag-on 双写同值幂等，母规格「删除」裁定推迟到 S12 退役批）。
- **删除**（死码，无 flag）：`mergeClaudeEnvSettings` + IPC `CLAUDE_RUNTIME_REGISTER_ENV` + preload `registerEnv`
  （renderer 零调用，第二权威后门）。
- **静态扫描测试**：生产源码（`src/main`+`src/agent-host`）禁新增 `homedir` 与 `'.claude'` 拼接；白名单豁免
  `OnboardingService.ts`（注释标 legacy-until-S6）与 `RemoteHelperSource.ts`（注释标 remote-side semantics）。

**有意保留**：`OnboardingService` 四处硬编码（legacy 双写本体 + `checkCredentialsHealth` legacy 门禁读者，
S5 换 AuthState、S6 停双写时分别退役）。

### S2b（renderer/scanner 侧：Provider 退役 + 历史双源 + resume 候选）——flag 门控

- **Provider 写路径退役（flag on）**：`CLAUDE_PROVIDER_APPLY` handler flag-on 拒绝（`{ok:false,
  reason:'managed'}`）；`ProviderList` 区块 flag-on 渲染「公司托管」只读卡（显示 baseHost + 登录邮箱占位，
  **不含明文**）；`SessionBar` 快捷切换与 `ActionPanel` 分组 flag-on 隐藏；主进程 watcher flag-on 不启动。
  renderer 如何知道 flag：新 IPC 只读查询 `auth.managedMode`（bool，非 secret——S1「不注册 auth IPC」约束在
  本片按此**显式放宽一条**，仍禁 AuthState 全量出 renderer）。flag off：现状 UI 与明文回显**原样保留**
  （已知泄漏面随 S12 终清，登记）。
- **历史双源（flag on）**：`ClaudeSessionScanner` 构造改注入双根——主根 = `CLAUDE_CONFIG_DIR`（=托管 home），
  **附加只读根 = 真实 `~/.claude`**（去重按 projects/<slug>/<sessionId>，mtime 新者胜）；flag off 单根现状。
- **resume 候选**：`resolveClaudeConfigDirForResumeSession` 候选列表 flag-on 时前插托管 home；
  **`~/.aiclient/claude-null` 判死**——从候选与诊断文案删除（全仓仅 `App.tsx:131,1176` 两处，无写手悬空四周）。
- **登记不动**：`session.listHistory` 死链（另立小票或随 S12 清）。

## §2 关键契约

### 2.1 生成物（照 E2/E3 实证 + `scripts/dev.js:135-171` 配方）

`<userData>/claude-home/settings.json`（0600，GENERATED 抬头注释——JSON 无注释，抬头用 `"__generated__"`
键说明，或齐平 codexHome 的做法由施工定，as-built 记录）：
```jsonc
{ "env": { "ANTHROPIC_BASE_URL": <vault.claude.baseUrl>, "ANTHROPIC_AUTH_TOKEN": <vault.claude.authToken>,
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" },
  "autoUpdates": false, "skipWebFetchPreflight": true }
```
无凭据版 = 同形状但 `env` 为 `{}`（保留其余键——CLI 可启动只是无凭据）。`.claude.json`（0600）=
`{ "hasCompletedOnboarding": true, "projects": { <ws>: { "hasTrustDialogAccepted": true } } }`；
`ensureWorkspaceTrusted` 增量补 ws 条目（读-改-写，保留既有键；E2 已证此文件语义）。
**hooks/statusLine 键不由生成器管**——`ClaudeHookManager` 会跟随重定向自行写入托管 settings.json；
生成器 regenerate 时**必须保留非 managed 键**（env/autoUpdates/skipWebFetchPreflight 之外的一切原样保留，
防把 hooks 抹掉——写法照 `writeSettingsWithEnvGuard` 的读-合-写）。

### 2.2 时序

- 重定向必须发生在 `registerIpc`/服务构造/`AgentHostManager` 启动之前（`main/index.ts` 现有顺序核对后钉行位）。
- `ensureManagedClaudeHome` 触发点：启动（flag on，vault 可读或 absent 都要保证目录+`.claude.json` 存在——
  hooks 门禁 `isClaudeInstalled()` 靠目录存在性）→ 登录后 regenerate → 登出后 regenerate（无凭据版）。
- E2 注记落地：生成 `autoUpdates:false` 已覆盖「CLI 自动更新写 `$HOME/.npm`」问题——S2 测试补断言
  （生成物含该键即可，不做进程级验证）。

### 2.3 off 轮与回退

- flag off：不设 `CLAUDE_CONFIG_DIR`、不剥 env、不生成目录、Provider/Scanner/resume 全现状——
  off 轮 vitest 全量 + 「一次登录对 `~/.claude` 写调用与今天字节一致」维持 S1 口径。
- flag on→off 回退：托管 home 留在 userData（不清理，无害）；legacy 文件因双写始终在 ⇒ 回退即用。

## §3 测试与验证（施工时按 S1 范式细化，此处列必测面）

1. 生成器：有/无凭据两版快照 · regenerate 保留 hooks 等外来键 · `ensureWorkspaceTrusted` 增量与幂等 ·
   0600/0700（含残留 tmp 情形，复用 S1 写盘件或同款实现）。
2. 重定向时序：flag on 设值+剥离（含 dev.js 已设 CLAUDE_CONFIG_DIR 被覆盖）· flag off 零改动（env spy）。
3. 写手跟随：McpManager/PluginsManager/PromptsManager/ClaudeRuntimeConfig 在临时 `CLAUDE_CONFIG_DIR` 下读写
   落点正确；flag off 落 `~/.claude`（fake homedir）。
4. Provider：apply flag-on 拒绝 · 只读卡不含明文（深查）· SessionBar/ActionPanel flag-on 隐藏 ·
   watcher flag-on 不启动 · flag-off 全现状（既有测试 0 改动即绿）。
5. Scanner 双源：合并/去重/mtime 规则 · flag off 单根。
6. resume 候选：flag-on 前插托管 home · claude-null 移除后诊断文案更新。
7. 静态扫描：homedir+'.claude' 新增禁令（白名单两豁免）。
8. off 轮全量：vitest 门禁串行；变异验证 ≥8 对（施工时列谱，含「regenerate 抹外来键」「off 轮误设
   CLAUDE_CONFIG_DIR」「双源去重取旧」三个必选）。

## §4 需评审重点攻击的自设裁定（诚实清单）

a) `ClaudeRuntimeConfig.disableClaudeAutoUpdates` 改口径而非删除（偏离母规格「删除」——flag-off 依赖论证）；
b) renderer 感知 flag 的 `auth.managedMode` 只读 IPC（S1「不注册 auth IPC」的显式放宽一条）；
c) Main 无条件覆盖 dev.js 已设 `CLAUDE_CONFIG_DIR`；
d) regenerate 读-合-写保留外来键（与「生成文件勿编辑」抬头的语义张力）；
e) 双源去重键与 mtime 新者胜；
f) `PromptsManager`（全局 CLAUDE.md）跟随重定向后，员工既有 `~/.claude/CLAUDE.md` 在 flag-on 下不可见——
   接受 or 收编进生成器（当前裁定：接受，登记）。
