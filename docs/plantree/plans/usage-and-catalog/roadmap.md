# Roadmap — 用量可见性与目录韧性（A 组）

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 需求原文与取证在 [PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md)；
> 本文件只维护任务身份、状态、依赖，以及调研档没写的**落点**与**判据**。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 0 | — |
| In Progress | 0 | — |
| Next | 3 | A1 → A2 → A3；A3 与前两项无依赖，可同时起 |
| Deferred | 1 | A2-b 用量落盘，需求触发再做 |

## 执行顺序

```text
串行线（同文件，必须按序）
  A1 缓存命中率            src/shared/piUsage.ts
  A2 会话内轮级用量汇总     src/shared/piUsage.ts + agent-host

并行线（与上面零文件重叠，可同时开工）
  A3 模型目录随包快照       PiModelConfigService + resources/ + scripts/
```

A1 与 A2 都改 `src/shared/piUsage.ts`，**A1 必须先合入**，否则两人改同一个导出面。
A3 与它们没有任何共享文件，一个人可以从第一天就开始。

## 通用门禁

每个任务合入前：`pnpm lint` · `pnpm typecheck` · `pnpm test`。
本机是资源受限的小服务器，测试按小批次执行（`--maxWorkers=1 --no-file-parallelism`），
不跑整套生产构建；未跑到的门禁如实记在 [implementation-status](./implementation-status.md)，不写成全绿。
`tsc --noEmit` 需要 `--max-old-space-size=1200`（896 MiB 会 OOM，前序计划已实测）。

**每个任务至少一条纯函数层断言。** vitest 是 `environment: 'node'` 且只收 `*.test.ts`，
写在 `.tsx` 里的判断没有自动化覆盖——决策必须先落到纯模块才谈得上验收。

GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验，本计划不单开轮次。

---

## A1 — 缓存命中率 · **Next**

**要解决的问题**：`cacheRead` / `cacheWrite` 已经在 `src/shared/piUsage.ts:40` 拿到，
Run 面板也在显示两个绝对数字（`RunSurfaceView.tsx:331-336`），但**没有比率**。
比率的用途是当哨兵：随包扩展打开、系统提示混入会变的内容、借来的技能列表变动，
都会立刻表现为命中率下跌；没有它，这类回归只表现为「账单涨了」。

**落点**

| 文件 | 改动 |
|---|---|
| `src/shared/piUsage.ts` | 新增纯函数 `deriveCacheHitRate(usage: PiTurnUsage): number \| null` |
| `src/renderer/components/workspace-shell/surfaces/runPanelModel.ts` | 视图模型输出该字段 |
| `src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx` | Cache read/write 两行之后加一行 |
| `src/renderer/components/chat/ComposerUsageChip.tsx` | 可选：tooltip 补一行；不改可见字形 |

**口径**

```text
命中率 = cacheRead / (input + cacheRead)      // 分母不含 cacheWrite
```

`cacheWrite` 是写入缓存的代价，不属于「这次请求有多少是白拿的」这个问句的分母。

**判据（纯函数臂，缺一不可）**

1. 分母为 0（input=0 且 cacheRead=0）→ 返回 `null`，UI 不渲染该行；**不得显示 `0%`**。
2. 只有 `cacheWrite > 0`、`cacheRead = 0` → 返回 `0`（是真的没命中，不是未知）。
3. `cacheRead` 字段缺失（非数字/负数）→ 返回 `null`，与「未知」同一处置。
4. 取整口径与百分号位置：与 `ComposerUsageChip` 现有的 `Math.round` 一致，避免两处不同的四舍五入。

**参考**：`PI-Desktop/apps/desktop/src/lib/context-usage.ts:250`（同一公式，含分母不含 cache write 的理由）。

**量级**：S（半天）。 **依赖**：无。

---

## A2 — 会话内轮级用量汇总 · **Next**

**要解决的问题**：我们只有「上一轮」。`RunSurfaceView.tsx:322` 的注释解释了为什么不能简单相加
（一次 run 结算多轮，相加会印出没人被收过的费），那个判断是对的——但代价是**我们没有任何总数**。
用户问「这次会话花了多少」时无法回答。

**落点**

| 文件 | 改动 |
|---|---|
| `src/shared/piTurnRollup.ts`（新建） | 纯累加器：`init()` / `apply(state, usage)` / `view(state)` |
| `src/agent-host/piWorkerSession.ts:909` `turn_end` 臂 | 现有唯一的 `usage.updated` 生产者；在此追加汇总字段 |
| `src/shared/piUsage.ts` | 事件 payload 类型扩展（**A1 之后**） |
| Run 面板两个文件 | 「上一轮」下方新增「本会话累计」分组 |

**口径（不得违反）**

1. **单条消息的 usage 永不被改写。** 汇总是旁路的第二个数，不是对第一个数的修正。
2. 「上一轮」与「本会话累计」在 UI 上**必须分别标注**，不得合并成一个「总计」。
3. 汇总只做加法，不做任何单价换算；成本仍取 pi 自己算好的 `costUsd` 求和。
4. 子代理花费如果 pi 单独报（`turn_end` 是否携带子代理增量**需先取证**），按增量并入汇总，
   **不并入任何单条消息**。取证结论写进 evidence，不要凭 PI-Desktop 的形状假设我们的。

**判据（纯函数臂）**

1. 多轮相加得到正确总数；`Object.is` 不变量——`apply` 收到不改变状态的事件时返回同一引用。
2. 缺字段的 usage（只有 input、没有 cacheRead）不污染累加结果。
3. 会话切换后归零；同一 worker 复用不串号。
4. 汇总永不写回单条消息（用一条断言钉住：调用 `apply` 前后原 usage 对象逐字段相等）。

**量级**：M（2–3 天）。 **依赖**：A1（同文件 `piUsage.ts`）。

---

## A3 — 模型目录随包快照 · **Next（可并行）**

**要解决的问题**：启动去 onboarding 拉 `/api/v1/models-config`，失败即 `unavailable`。
D03 删掉内置模型表之后，网络不佳或管理端不可用 = **用户看到空的模型下拉框**。
这是一个「首次启动 / 弱网 / 管理端故障」三合一的失败模式，且没有任何本地兜底。

**落点**

| 文件 | 改动 |
|---|---|
| `resources/model-catalog/snapshot.json`（新建） | 随仓库与发布物走的目录快照 |
| `src/main/services/piModelConfig/catalogSnapshot.ts`（新建） | 读取 + 校验（复用现有 `validatePiManagedModelsConfig`） |
| `src/main/services/piModelConfig/PiModelConfigService.ts` | `readCatalog` / `readState` 的 `unavailable` 分支回落快照 |
| `src/shared/piModelConfig.ts` | `PiModelSyncSource` **追加**一个取值（如 `'bundled'`）；只追加不重排 |
| `scripts/refresh-model-catalog.mjs`（新建） | 拉取 → 校验 → 原子替换 → 供发布流程调用 |
| `electron-builder.yml` | 把 `resources/model-catalog/` 打进包 |

**口径**

1. **快照不是第二权威**：它与在线目录出自同一个管理端，只是时间点不同。禁止引入 `models.dev`
   或任何外部目录源。
2. **启动零网络读快照**做基线，后台再拉最新覆盖。
3. 设置页的「刷新」只替换**当前进程的内存快照**，**既不写包内文件也不写用户缓存**。
   理由（ADR 0134）：用户缓存会让不同装机跑在不同配置上，发布物就不可复现了。
4. UI 必须能说出「这是随包基线，不是刚拉的」——这就是要给 `PiModelSyncSource` 加取值的原因。

**判据（纯函数臂）**

1. 快照经现有 `validatePiManagedModelsConfig` 校验；损坏的快照被拒绝且**不使整个启动失败**。
2. 在线拉取失败 → 回落快照，`source` 标为 `'bundled'`，`endpointUrl` 仍如实报告。
3. 快照文件缺失 → 仍是 `unavailable`（保留现有行为，不静默变成空目录）。
4. 在线拉取成功 → 快照被内存结果覆盖，`source` 回到 `'remote'`。
5. 刷新动作**不写盘**：断言写盘路径未被调用。

**发布流程接入**：`refresh-model-catalog.mjs` 挂进打 tag 前的前置步骤
（现有 `dist:prereq` 链或 release 流程，由实现者选定并写进 evidence）。参照
`scripts/verify-release-metadata.mjs` 的既有形状。

**量级**：M（1–2 天，主要成本在发布脚本与校验）。 **依赖**：无。
**注意**：当前分支 `feat/model-catalog-admin` 正好是这条线，时机合适。

---

## A2-b — 用量落盘 · **Deferred**

会话累计写入持久账本（候选：`~/.pilab/<profile>/usage/` 下的 NDJSON，或用 pi 的
`appendCustomEntry` 追进会话文件——`piLegacyImport.ts` 已在用该机制）。
**需求触发再做。** 跨会话看板不在本计划范围（见 README「明确不做」）。
