# Evidence — Q06 思考强度迁移逻辑取证

> 2026-09-03，[D02](../decisions/002-layout-cwd-and-evidence-scope.md) 决定三派 `maxapi/grok-4.6` 子代理取证。
> 读取对象：pix 冻结提交 `da01b3e` 的 `service-tier.ts` 迁移逻辑 + AiClient `feat/pi-primary-backend` 的持久化落点。
> 结论已关闭 Q06。

## pix 的迁移先例（speed→service_tier）

**映射表**（`apps/desktop/src/renderer/lib/service-tier.ts:40-47`，测试 `service-tier.test.ts:22-26`）：

| 旧存值 | 映射到 |
|---|---|
| `fast` **或** `priority` | `priority` |
| `quality` **或** `flex` | `flex` |
| `balanced` **或** `default` | `default` |
| null / empty / unknown | `default` |

对已经在新词汇的值是**恒等**——所以**双词汇安全**，重跑 mapper 是无操作。
注：`packages/agent-runtime/src/service-tier.ts` **没有** legacy mapper（只在请求注入时用）。

**触发时机**（`main.tsx:498-511`，写 `2360`）：
- **在 read 时**，`useState` 初始化里做。若 `pix.composer.serviceTier` 已是 `flex|default|priority` 则直接取用；否则映射 `pix.composer.speed`。
- **不是 migrate-on-write**。旧 key 永不删；新 key 只在用户调用 `changeServiceTier` 时才写。
- 幂等：对新词汇值重跑是 no-op。
- `default` 是**真实的 `ServiceTierId`**，不是 omit 哨兵（`applyServiceTierToPayload` 在 tier 为 `default` 时省略 wire 字段）。

**哲学**：双 key 过渡；read 时映射；**不静默重写**已存偏好。

## 对 AiClient 的建议

**复制模式，不复制双 key**：
- 用一个**纯 mapper**：对新词汇恒等 + 对垃圾值 fallback，**在 read 时应用**。
- **不**复制双 key（因为 pix 的 `speed` vs `service_tier` 是**不相交**词汇；我们的 `low|medium|high|xhigh|max` 在 `EffortLevel` 与 `ThinkingLevel` 里**都合法**）。保留这些重叠值原样，只教 store 认识 `off`/`minimal`。

**我们的 `default` 哨兵**（`efforts.ts:47`）**不是** pix 的 default tier——保留它为「omit-on-wire」（`toWireEffort` → `undefined`，`efforts.ts:105-107`）。未知值 → `default` 哨兵，**不是** `off`。

**落点（是两个 store，不是一**‍**个）**：
1. **Per-agent template** — `chatAgentDefaults.effort`，经 `sanitizeChatAgentDefaults`（`chatAgentDefaults.ts:19-39`），已从 `migrateSettings`（`migration.ts:259`）在 Zustand persist **merge**（`settings/index.ts:607-609`）时调用。On-read，无版本号。
2. **Per-session** — `localStorage aiclient:chat:session-efforts`（`sessionPreferenceStore.ts:4,66-72`）。**不在** `migration.ts` 里。在 `readSessionEffort` / `readEntry` 映射；`writeSessionEffort` 已拒绝非 `isEffortSelection` 值（`:70-71`）——需把守卫**放宽**到新词汇。

另有 AI-feature `effort` 字段（`defaults.ts:148,156,165`）是第三处、较低优先级的副本。
**不要**在 hydrate 时静默重写会话映射；对重叠 token 恒等映射，让下次用户写入时把 `off`/`minimal` 落盘。
