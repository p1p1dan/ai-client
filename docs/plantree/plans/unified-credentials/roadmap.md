# Roadmap — 统一凭据目录与托管凭据转默认

> 状态：**In Progress** —— S1 与 **S0' Claude 侧**已落地。
> **2026-08-26 [D60](../../../plans/openchamber-chat-refactor-ledger.md) 重塑了 S2 之后的形状**：
> 隔离 home 降级为「只隔离凭据」，取消 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 整体重定向。
> 连带 open-q #2 关闭、#5 修法定案；新增前置切片 **S0'**。未决项见 [open-questions](./open-questions.md)。

## Done

- **2026-08-26 S1 目录字面量收敛 ✅ 已落地** —— `.aiclient` 收敛为 `defaultPaths.ts` 的
  `APP_STATE_DIR` 单一常量，7 处改为 import。**实际是 7 处不是立项时估的 5 处** ——
  多出的 `OnboardingService.ts:110` 与 `adoption.ts:48` 是**静态扫描断言抓出来的**，
  人工 grep 漏了；这条断言的价值当场兑现。
  **零行为变更已实证**：生成的远端 helper 脚本前后**逐字节相同**（89,307 B），
  中途一版用 `JSON.stringify` 插值导致引号从 `'` 变 `"`（语义等价但非逐字节），已改直接插值消掉。
  静态扫描收紧过一次：`claudeHome.ts` 的 `.aiclient-generated` 是**文件名**不是目录名，
  前缀匹配会误报，改为要求后随 `'` 或 `/`。
  变异 2/2 咬红（还原一处裸字面量 → 扫描红；改常量值 → 兜底断言红）。
  四门：typecheck 0（含 agent-host）· biome 995 文件 0 · **vitest 247 文件 5005 例**。
  ⚠️ **刻意未动**：`i18n.ts` 与 `RemoteSettings.tsx` 里两条含 `~/.aiclient/...` 的**占位示例文案** ——
  它们的英文原文同时是 i18n 查找键，改动即改键，超出「零行为变更」范围。
  已在扫描断言里**显式列出而非静默跳过**，S2 改名批不得遗漏。

- **2026-08-26 S0' Claude 侧 ✅ 已落地（`77ff5dd4`）** —— `CLAUDE_CONFIG_DIR` 重定向取消，凭据改经 env 直送。
  用户的 `~/.claude`（CLAUDE.md · commands · skills · plugins · hooks）在 GUI 与运行时**全部回来**。

  **通路替换**：Main 每次 spawn 现读 vault → `AICLIENT_CLAUDE_BASE_URL` / `AICLIENT_CLAUDE_AUTH_TOKEN`
  两个 env 键（`hostEnv.ts`，照抄 codex 的 `AICLIENT_CODEX_API_KEY` 通路）→ Host 侧
  `claudeSettings.ts` 以「**vault 优先于用户 settings.json**」的规则合并进 `options.env`。
  终端 pty 走同一份 vault，直接注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`。
  **这条优先级规则是整个方案对目录控制的唯一替代品**，7 个断言专门守它。

  **下线的东西**：托管 claude-home 目录整体（skeleton / settings.json 生成 / `.aiclient-generated` sidecar /
  空 commands+skills 目录 / CLAUDE.md 一次性收养）· `generateClaudeSettings` · `getManagedClaudeHomeDir` ·
  登录与登出的 claude-home regenerate 分支 · 会话历史的 dual-root（回落单根，天然跟随用户的 `CLAUDE_CONFIG_DIR`）。
  文件更名 `managedClaudeHomeStartup.ts` → `managedCredentialsStartup.ts`（名字里的 ClaudeHome 已不存在）。

  **仍然写的唯一用户文件**：`~/.claude.json` 的 onboarding 与 workspace trust —— **merge 不是重写**
  （`{...我们的默认, ...用户现有}`，用户已有键恒赢），且正是 claude CLI 自己接受 trust 对话框时写的同一条目。
  没有这一步，第一次用我们 GUI 的用户会卡在 CLI 的主题/信任向导里（D47 S0 [E2](../../../plans/2026-08-15-d47-s0-spikes/e2-claude-json-trust.md) 实证）。

  **施工中抓到的两个真缺陷**（都由新断言先咬红，不是事后发现）：
  ① `stripInheritedCredentialEnv()` 会连用户自己设的 `CLAUDE_CONFIG_DIR` 一起删 ——
  旧设计下无害（删完立刻设回自己的值），D60 后就是**删掉用户的深思熟虑**。
  修法：`CLAUDE_CONFIG_DIR` 移出共享凭据列表（它是路径不是凭据），`scripts/dev.js` 本地追加它
  （dev.js 紧接着要设自己的隔离目录，清场是它自己的事）。
  ② 旧 vault 文档没有 `claude` 分支时解构会抛 —— 改 `?.` 并降级为「无托管凭据」。

  **变异 5/5 咬红**：恢复重定向 / 优先级反转（settings.json 赢）/ 两个 claude 键改成 omit-when-undefined
  （污染防御失效）/ pty 不注入 / 重新创建托管目录 —— 每个都至少打红一条断言。
  四门：typecheck 0（含 agent-host）· biome 995 文件 0 · **vitest 247 文件 5012 例**。

  ⚠️ **本批只动 flag-on 路径**：`AICLIENT_MANAGED_CREDENTIALS` 仍在（退役归 S3），flag-off 保持零变异契约。
  ⚠️ **codex 侧未施工**：[E1](../../../plans/2026-08-26-s0-spikes/e1-codex-no-home.md) 已证可行，但改造不在本批。

- **2026-08-26 立项与起点摸底** —— 实测确认「用户设想的东西大部分已存在」：
  `~/.aiclient/settings.json` 已在用、vault 已按 agent 分存 url+key、`adoption.ts` 已能免重登收编存量。
  缺的是合并 + 改名 + 打开三件事。详见 [README 起点认知](./README.md)。

## Next（按依赖序）

### S0' — 取消隔离 home，凭据改经 env 直送（D60 主体）· **Claude 侧 ✅ 已落地，codex 侧待施工**

**排最前的理由**：codex 侧的配置树丢失**今天已经在影响用户**（`ensureCodexHome` 不受托管 flag 控制），
且 S3 的形状完全取决于本切片的结果。

**Claude 侧** —— ✅ 已落地，见上方 Done 条目。

**codex 侧 —— ✅ E1 取证已完成（2026-08-26），结论 = 是，退化分支已关闭**

证据：[e1-codex-no-home.md](../../../plans/2026-08-26-s0-spikes/e1-codex-no-home.md)（11 个用例，离线，未改产品代码）。

`codex app-server` 支持 `-c key=value`（TOML 覆盖），凭据 / provider / posture **三样都能不落文件**注入
⇒ `CODEX_HOME` 可以就是用户自己的 `~/.codex`，**软链投影 / 直写用户目录两个退化方案都不需要了**。

1. `CODEX_HOME` 不再指向 `<userData>/codex-home`，就用 `~/.codex`
   ⇒ 用户全局 `AGENTS.md` + `agents`/`hooks`/`skills`/`plugins` 整棵树**结构性恢复**，无需投影无需收养。
2. provider + 凭据经 `-c model_providers.<id>.env_key=…` + 一个 env 变量注入（R2/R3 实测）。
3. posture 经 `-c approval_policy` / `-c sandbox_mode` 强制，与今天写进 config.toml 等价（R5 实测：
   用户 config 写死 `never`/`danger-full-access` 也被盖住）。
4. `ensureCodexHome` 的 projection 写盘、`config.toml` 生成、`auth.json` 删除**三件事全部下线** ——
   R6/R7 实测用户 `auth.json` 里的 `OPENAI_API_KEY` **不会遮蔽** env_key，也**不是静默兜底**，
   「删 auth.json 防遮蔽」这一步在新方案下失去理由。

**施工时必须补的两发**（E1 已标注，不阻塞立项）：
- **跨进程 resume 的 posture**：`-c` 是进程级参数，同进程内 resume 自然带着；
  `codexHome.ts` 注释称 resume 从 config 文件重新推导 posture —— **跨进程未测**。
- **`developer_instructions` / `notify` / `profiles` 是否随 `mcp_servers` 一并生效**：
  同文件同路径，按机制推断会，**但是推断不是实测**。

**⚠️ E1 带出的新策略问题（[open-q #7](./open-questions.md)，S0' 施工前须拍）**：取消隔离后，
今天 projection 刻意丢弃的用户 `mcp_servers` / `developer_instructions` **会流回来生效**（R8 实测用户 MCP 被真实拉起）。
posture 那半 `-c` 补得回来，这半补不回来：`-c mcp_servers={}` 整表清空**无效**（R9），
只有逐条 `-c mcp_servers.<name>.enabled=false` 有效（R10）—— 而逐条压制**需要先读用户 config 枚举名字**。

**验收**：真机零 env 起 app —— ① 用户 `~/.claude/CLAUDE.md`、`commands/`、`skills/`、plugins 在 GUI 与运行时**都在**；
② 用户 `~/.codex/AGENTS.md` 与配置树生效；③ claude 与 codex 都用 vault 里的 key 起会话；
④ 用户自设 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 仍被尊重；
⑤ 存量机器不被要求重新登录（`adoption.ts` 的 `flag_off` 早退分支连带复核）。

### S2 — 目录改名 `.aiclient` → `.pilab` + 凭据迁入

**不受 D60 影响**（这是我们自己的目录，与 agent 配置树无关）。

**目标形态**（用户 2026-08-26 当场指定并确认目录名仍取 `.pilab`）：

```
~/.pilab/
  jyw-ai-client/              ← profile 层（正式版）
    settings.json
    session-state.json
    credentials/vault.json    ← 从 <userData>/credentials/ 迁入
    remote-auth/
    remote-runtime/
  jyw-ai-client-dev/          ← profile 层（开发版）
    ...
```

用户原话：「应该是存到我们自己的应用文件夹，而不是 `<userData>/credentials`」。
这正是 [D59](../../../plans/openchamber-chat-refactor-ledger.md) ①「合并」的落地形态 ——
今天设置在 `~/.aiclient/`、凭据在 `<userData>/credentials/`，**分裂的两处合成一处**。

**profile 层不是可选的**（open-q #1 已拍板）：凭据一旦离开 `<userData>`，
正式版与开发版就会共用同一份凭据 —— 开发时的实验改动会写到用户真实账号上，
`cchBaseUrl` 也会在测试网关与真网关之间横跳。分层就是挡这个，
保住今天靠 `jyw-ai-client` / `jyw-ai-client-dev` 后缀取得的隔离性。

**必须同批处理的三件事**：
1. **常量改值**：`APP_STATE_DIR`（S1 已收敛成单一常量，这是它存在的理由）。
   ⚠️ S1 刻意未动的两条 i18n 占位文案（`i18n.ts` / `RemoteSettings.tsx` 里含 `~/.aiclient/...`）
   本批不得遗漏 —— 静态扫描断言里已显式列出。
2. **本机迁移**：旧目录存在则搬运（设置 / session-state / remote-* / 凭据 / 迁移标记），
   幂等、可重入。**存量用户不得被要求重新登录** —— 这是本切片的硬验收线。
3. **远端孤儿 ✅ 已拍板（[D62](../../../plans/openchamber-chat-refactor-ledger.md)）：接受，不做远端搬运。**
   已连过的机器留下 `~/.aiclient/`，远端设置回默认 + runtime 重下一次 —— 不会坏，只是观感像被重置。
   ⇒ **S2 多一条交付物：发布说明必须写明这一项**，否则用户会当成 bug 报上来。

**S2 的开工前置已全部出清**（#1 profile 分层 · #3 远端孤儿 · #4 目录名二次确认），可进 execute。

### S3 — `AICLIENT_MANAGED_CREDENTIALS` 转默认开（形状已被 D60 缩小）

退役 flag，让托管凭据成为唯一路径 —— 与 [D58](../../../plans/openchamber-chat-refactor-ledger.md) 对 codex flag 做的事同型。

**D60 之后它比原计划轻得多**：一开不再意味着「`CLAUDE_CONFIG_DIR` 切走 + settings.json 被重写」，
只意味着「凭据来源从用户 settings.json 换成 vault」。原先挡在这里的 open-q #2 已随之关闭。

**依赖**：S0' 落地后才有意义（否则退役 flag 等于把整体重定向转正）。

### S4 — 为 pi 预留 vault arm

`VaultPayload` 加第三个 arm 的形状与迁移（vault 有 `SCHEMA_VERSION`，加字段要走版本位）。
**不做 pi 接入本身**，只保证加家不需要动架构。排在 pi 立项之后或与之合并。
D60 之后这条更便宜：加一家 = 加一对 env 键，不再是加一棵投影树。

## Deferred

- **明文 `auth.json`**：用户拍板保留 safeStorage 加密（D59 ③）。理由记在 D59：加密防的是误泄不是被盗，
  但代码已有、删掉是净损失。⚠️ 已知缩水：Linux 无 keyring 时 Chromium 退到固定密钥后端，
  而 `isEncryptionAvailable()` 仍返回 true ⇒ 我们照旧标 `enc:'safeStorage'`，实际防护接近装饰。
  **不据此依赖它作安全底线。**

- **`settingSources: []` 与 CLAUDE.md 上下文**：D60 明确不在本 plan 内，见 [open-q #6](./open-questions.md)。
