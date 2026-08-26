# Open Questions — 统一凭据目录与托管凭据转默认

> 只放未决问题。已定的进 [README](./README.md) / [roadmap](./roadmap.md)，
> 已拍板的进总台账 [D59](../../../plans/openchamber-chat-refactor-ledger.md)。
> **#1 与 #2 是 S2/S3 的开工前置**，未决前不进入 execute。

## 已关闭（存根）

- ~~#1 凭据脱离 `<userData>` 后 dev 与 prod 要不要共用~~ —— ✅ 2026-08-26 关闭：**按 profile 分子目录**（用户拍板「可以按 profile 分子目录」）。
  即新目录下再按 profile 分层，保住今天靠 `jyw-ai-client` / `jyw-ai-client-dev` 后缀取得的隔离性 ——
  开发版的实验改动不会写到正式凭据上，`cchBaseUrl` 也不会在测试网关与真网关之间横跳。
  代价是与「一个目录」的直觉有一层落差，用户已知悉并接受。

## #2 存量用户 `~/.claude/settings.json` 里的**非凭据**配置怎么办

**状态**：待调查 + 拍板（阻塞 S3）

`adoption.ts` 解决的是**凭据**免重登。但 S3 一开，`CLAUDE_CONFIG_DIR` 切到 `<userData>/claude-home`，
而那份 `settings.json` 是 Main 从 vault **重写**的，不是合并 —— 用户原来在
`~/.claude/settings.json` 里的 hooks、permissions、statusLine、model 等**不会跟过去**。

已知仓内只做了一处收养：`CLAUDE.md` 一次性 copy（`managedClaudeHomeStartup.ts:99-105`）。

**需要先取证**：托管 `settings.json` 的生成器到底写哪些键、是否留了合并位、
`.aiclient-generated` sidecar 的语义是否可用于「哪些键是我们写的、哪些是用户的」。
**取证完再拍**：整体收养 / 只收养白名单键 / 不收养并在 UI 明示。

## #3 远端已连机器的 `~/.aiclient/` 孤儿：接受还是搬运

**状态**：待拍板（S2 内决定，风险低）

改名后已连过的远端机会留下旧目录 ⇒ 远端设置回默认 + runtime 缓存重下一次。
helper 是我们自己下发的，不是第三方契约，所以**不会坏**，只是观感像"远端配置被重置了"。

选项：① 接受 + 写进发布说明；② 远端也做一次搬运（helper 里加迁移逻辑，多一份要维护的代码）。
**倾向**：①，因为远端 runtime 本就是缓存、设置面也小。

## #4 目录名最终是不是 `.pilab`

**状态**：已拍板取 `.pilab`，但登记一条提醒

用户 2026-08-26 拍板改叫 `.pilab`。登记此条只为提醒：**改名要趁早**（用户基数越大迁移越贵），
且与产品名 / `appId: com.aiclient.app` / `productName: AiClient` / package `jyw-ai-client` 四者
现在已经四不像。若将来要统一品牌口径，`.pilab` 会是第五个名字 —— 值得在改名同批把口径一起定了。

## #5 隔离 home 丢掉的**不止**凭据：codex 的 `AGENTS.md` 与整棵配置树

**状态**：已取证，待定修法（与 #2 同源，建议并批）

用户 2026-08-26 追问「难道 claude/codex 不会自己从 `~/.claude`、`~/.codex` 读 CLAUDE.md / AGENTS.md 吗」——
**会，而且我们漏了。**

`strings` 扫随包 codex 0.149.1 二进制，实测命中：

```
Failed to read global AGENTS.md instructions from `
.codex/config.toml   .codex/agents   .codex/hooks   .agents   .agents/skills
```

⇒ codex 从 `CODEX_HOME` 读**全局 `AGENTS.md`**，另有 `agents/` / `hooks/` / `skills/` / `plugins/` 一整棵树。
而 `ensureCodexHome`（`src/agent-host/codexHome.ts:652-672`）只搬 **`config.toml` + `auth.json` 两个文件** ——
隔离 home 一启用，用户的全局 AGENTS.md 与这棵树**静默消失，无任何提示**。

Claude 侧同源但已补了一小半：`managedClaudeHomeStartup.ts:99-105` 一次性收养 `CLAUDE.md`。
**这解释了用户的疑问「为什么要收养 CLAUDE.md」** —— 正因为 `CLAUDE_CONFIG_DIR` 一改，
`~/.claude/CLAUDE.md` 就读不到了。但 Claude 侧也只补了这一个文件，
`commands/` / `skills/` 只建空目录不收养（同文件 §phase ①）。

⚠️ **本条不是 S3 引入的**：只要隔离 home 存在就成立，而 codex 的隔离 home **今天已经在跑**
（`ensureCodexHome` 不受托管 flag 控制，fallback 分支照样建）。⇒ **已经在影响用户，不是未来风险。**

**修法待定**：① 扩大投影范围（把 AGENTS.md / agents / hooks / skills 一并搬）——
但要想清是拷贝还是软链、更新时机、以及用户改了隔离 home 里那份怎么办；
② 只搬 AGENTS.md（最小止血）；③ 不搬但在 UI 明示。**须先决定隔离 home 的定位**：
是「我们完全接管的干净环境」还是「用户环境的投影」—— 今天两边都不像，这才是根因。
