# Roadmap — 统一凭据目录与托管凭据转默认

> 状态：**In Progress** —— S1 已落地（`APP_STATE_DIR` 单一常量）；四项方向已拍板（[D59](../../../plans/openchamber-chat-refactor-ledger.md)），
> 但 S2/S3 仍被一条未决项挡住（存量 `~/.claude` 非凭据配置如何衔接）。见 [open-questions](./open-questions.md)。

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

- **2026-08-26 立项与起点摸底** —— 实测确认「用户设想的东西大部分已存在」：
  `~/.aiclient/settings.json` 已在用、vault 已按 agent 分存 url+key、`adoption.ts` 已能免重登收编存量。
  缺的是合并 + 改名 + 打开三件事。详见 [README 起点认知](./README.md)。

## Next（按依赖序）

### S2 — 目录改名 `.aiclient` → `.pilab` + 凭据迁入

改常量值，并把 vault 从 `<userData>/credentials/vault.json` 迁到新目录。

**必须同批处理的三件事**：
1. **本机迁移**：旧目录存在则搬运（设置 / session-state / remote-* / 迁移标记），幂等、可重入。
2. **远端孤儿**：已连过的机器留下 `~/.aiclient/`，远端设置回默认 + runtime 重下一次。要么接受并写进发布说明，要么远端也做一次搬运。
3. **dev/prod 共用**：凭据脱离 `<userData>` 后，`jyw-ai-client` 与 `jyw-ai-client-dev` 会**共用同一份凭据**（今天靠 userData 后缀隔离）。**这是 open-q #1，未决。**

### S3 — `AICLIENT_MANAGED_CREDENTIALS` 转默认开

退役 flag，让托管凭据成为唯一路径 —— 与 [D58](../../../plans/openchamber-chat-refactor-ledger.md) 对 codex flag 做的事同型。

**比 D58 重的地方**：一开，Claude 的 `CLAUDE_CONFIG_DIR` 就从用户真实 `~/.claude` 切到
`<userData>/claude-home`，`settings.json` 由 Main 从 vault **重写（不是合并）**。
`adoption.ts` 覆盖了「凭据免重登」这一半，但**用户自己在 `~/.claude/settings.json` 里的其它配置怎么办**是 open-q #2。

**验收**：零 env 起 app，claude 与 codex 都用 vault 里的 key 起会话（真机）· 存量机器不被要求重新登录 ·
`adoption.ts` 的 `flag_off` 早退分支连带复核。

### S4 — 为 pi 预留 vault arm

`VaultPayload` 加第三个 arm 的形状与迁移（vault 有 `SCHEMA_VERSION`，加字段要走版本位）。
**不做 pi 接入本身**，只保证加家不需要动架构。排在 pi 立项之后或与之合并。

## Deferred

- **明文 `auth.json`**：用户拍板保留 safeStorage 加密（D59 ③）。理由记在 D59：加密防的是误泄不是被盗，
  但代码已有、删掉是净损失。⚠️ 已知缩水：Linux 无 keyring 时 Chromium 退到固定密钥后端，
  而 `isEncryptionAvailable()` 仍返回 true ⇒ 我们照旧标 `enc:'safeStorage'`，实际防护接近装饰。
  **不据此依赖它作安全底线。**
