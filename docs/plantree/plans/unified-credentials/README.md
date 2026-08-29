# Plan — 统一凭据目录与托管凭据转默认

> 2026-08-26 立项。触发：用户在 codex 升级票收口后追问「当前 claude/codex/pi（未来）的 env 是怎么注入的」，
> 并指出应当有我们自己的目录、配置自持久化，而不是从 `~/.claude` / `~/.codex` 里提取修改。
> 同轮四项拍板 = **[D59](../../../plans/openchamber-chat-refactor-ledger.md)**。

## Scope

把「用户登录一次 → 所有 agent 都用这份凭据」从**已写好但被 flag 关着的代码**变成**默认路径**，
并把我们自己的配置目录收拢成一个。

**In scope**：目录合并与改名（`~/.aiclient` → `~/.pilab`，凭据从 `<userData>/credentials/` 迁入）·
**取消隔离 home、凭据改经 env 直送（D60 新增）** · `AICLIENT_MANAGED_CREDENTIALS` 转默认开 ·
存量用户衔接 · 目录字面量收敛成单一常量 · 为第三 agent（pi）预留 vault arm。

**Out of scope**：pi 后端本身的接入（属 [multi-agent](../multi-agent/README.md) 阶段 5 候选）·
登录/注册流程本身的改动 · 凭据轮换与刷新策略（现有 `AuthStateService` 不动）·
**`settingSources: []` 与 CLAUDE.md 上下文（D60 明确另立项，见 [open-q #6](./open-questions.md)）**。

## 方向修正（2026-08-26，[D60](../../../plans/openchamber-chat-refactor-ledger.md)）

立项当天下午，用户追问「隔离目录会不会让 CLAUDE.md / commands/ / skills/ 失效」，取证后**方向改了**：

> **隔离 home 降级为「只隔离凭据」——取消 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 整体重定向。**

三条互相独立的机制被分开（详见 D60 与 [open-q 附-5](./open-questions.md)）：

| 失效项 | 源头 | 今天状态 | 与隔离目录 |
|---|---|---|---|
| CLAUDE.md 不进模型上下文 | `claudeRuntime.ts:985` 的 `settingSources: []` | **已失效** | **无关**，另立项 |
| 用户级 `commands/`/`skills/`/plugins/hooks | `CLAUDE_CONFIG_DIR` 整体重定向 | flag 开才失效 | 直接相关 |
| codex 全局 `AGENTS.md` + 整棵配置树 | `ensureCodexHome` 只搬两个文件 | **已失效**（不受 flag 控制） | 直接相关 |

**为什么取消而不是扩大投影**：重定向从来不是凭据注入的必要条件。仓内已有反例 ——
codex 的 key 走 `hostEnv.ts:161` 的 `AICLIENT_CODEX_API_KEY` 直接进 env，全程不碰文件；
Claude 侧却绕了一趟磁盘（Main 写 `<claude-home>/settings.json` → Host `loadClaudeSettingsEnv()` 读回来）。
**正因为凭据经「文件」传递，才不得不控制「目录」，一旦控制目录就顺带劫持了整棵配置树。**
投影方案的成本随 agent 家数线性增长，与 [D58](../../../plans/openchamber-chat-refactor-ledger.md)
「够不到的开关不是灰度」同构。

## 起点认知（2026-08-26 实测，不是设想）

**用户要的东西大部分已经存在**，缺的是「合并 + 改名 + 打开」。

| 用户设想 | 仓内实况 | 差距 |
|---|---|---|
| 我们自己的目录 | ✅ `~/.aiclient`（`SharedSessionState.ts:7`），本机已落盘 | 改名 |
| 里面放 `settings.json` | ✅ 已经就是这个文件名（同目录另有 `session-state.json`） | 无 |
| `auth.json` 存 url + key | ⚠️ 内容已存在于 `<userData>/credentials/vault.json`，safeStorage 加密 | 位置 |
| 登录那步拿到 url+key | ✅ 且**已按 agent 分开存** | 无 |
| claude/codex/pi 都用这份 key | ⚠️ 代码齐备（D47 整批），被 `AICLIENT_MANAGED_CREDENTIALS` 关着 | 开关 |

vault 载荷形状（`CredentialVault.ts`）：

```ts
identity:   { email, userId }
cchBaseUrl: string
claude:     { baseUrl, authToken }   // 每家一对 url+key
codex:      { baseUrl, apiKey }
pi?:        { baseUrl, apiKey }        // S4，旧文档可缺省
receivedAt: string
```

Pi 第三 arm 已于 2026-08-28 随 [pi-backend-migration Phase 5](../pi-backend-migration/evidence/phase5-model-config.md) 落地；旧文档缺省时兼容回退到 codex arm。

## 三条承重事实（决定本 plan 的形状）

**① `~/.aiclient` 不只装设置。** 还装远程连接的 `remote-auth` / `remote-runtime` / 远端 helper 配置，
且字面量在生产代码里**重复了 5 遍**（`SharedSessionState` · `RemoteAuthBroker` · `RemoteConnectionManager` ·
`RemoteRuntimeAssets` · `RemoteHelperSource`），没有单一常量。改名前必须先收敛，否则是 5 处并行改。

**② 存量衔接已有代码。** `adoption.ts`（D47 S6）会把老机器的
`~/.aiclient/settings.json` + `~/.claude/settings.json` 一次性提升进 vault，
**翻开关不强制用户重新登录**。这条极大降低 ④ 的风险，但它今天的早退分支正是 `reason: 'flag_off'`，
需要连带复核。

**③ `RemoteHelperSource` 里的路径在远端机器上。** helper 是我们自己下发的，不是第三方契约，
但已连过的远端机会留下 `~/.aiclient/` 孤儿：远端设置回到默认、runtime 缓存重下一次。

## 与既有工作的关系

- **前置已完成**：D47 整批（凭据保险库 + 托管 claude-home + 托管 codex-home + 收编）已落地，本 plan 是把它转正。
- **同源教训**：[D58](../../../plans/openchamber-chat-refactor-ledger.md) 刚退役了 `AICLIENT_AGENT_CODEX` —— 
  理由是「GUI 用户够不到的开关不是灰度控制」。`AICLIENT_MANAGED_CREDENTIALS` 是**同一个病**，
  本 plan 的 ④ 就是对它做同样的事，但它更重（会改写 Claude 的 settings.json）。
- **pi 接入**：S4 的 vault arm 已完成；实际模型配置、运行期与 TUI 接入见 [pi-backend-migration](../pi-backend-migration/README.md)。

## 文件

- [implementation-status.md](./implementation-status.md) — **恢复工作先读这个**：当前位置、Active TODO、未解风险、关键文件
- [roadmap.md](./roadmap.md) — 阶段与状态（逐批明细）
- [open-questions.md](./open-questions.md) — 未决问题（**2026-08-27 已全部关闭**）
- [topics/discarded-approaches.md](./topics/discarded-approaches.md) — 废案：试过什么、为什么废、取证在哪

## 权威顺序

沿用全树口径：ARD ＞ 执行计划 ＞ 总台账（决策）＞ 本树（当前状态）。
四项拍板原文在总台账 **D59**，本树只链接不复制。
