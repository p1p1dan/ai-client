# Roadmap — 模型配置页迁入 onboard 并扩展

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> **全部为 Next，未开工**（用户 2026-09-05：后续单独开对话执行）。
> 开工前先答 [open-questions](./open-questions.md) 的四问——它们都会改变 M01/M03 的形状。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 0 | — |
| In Progress | 0 | — |
| Next | 5 | M01–M05 |
| Deferred | 0 | — |

## Next

### M01 — onboard 侧配置存储与鉴权拉取端点

SQLite 存渠道/模型配置（onboard 已用 `bun:sqlite`）。两个端点分开：

- **客户端端点**：按 [D01](./decisions/001-authenticated-catalog-fetch.md) 用登录 key 做 Bearer 鉴权，
  只返回**启用**的渠道与模型，按 [topic §一](./topics/wire-contract-and-constraints.md) 的形状
  标注每个渠道的 baseUrl / apiKey 是管理员填的还是继承登录值。
- **管理端点**：返回全部（含停用），供管理页使用。

### M02 — onboard 管理页 UI

渠道与模型的增删改 + **启用开关**（渠道级、模型级各一）+ **URL/Key 两个覆盖勾选**
+ 字段补齐（首要 `thinkingLevelMap`，其余见
[topic §四](./topics/wire-contract-and-constraints.md) 的对照表）。
管理页自身的登录/权限见 [Q03](./open-questions.md)。

### M03 — ai-client 侧契约适配

四处，都在 [topic §一/§三](./topics/wire-contract-and-constraints.md) 里定位到了行号：

1. `sync()` 带 `Authorization: Bearer`（key 从 vault 取）；
2. `PiManagedProviderDefinition.baseUrl` 改可选，写盘时用 vault 值补齐；
3. `writeAuth()` 从「每个渠道同一把登录 key」改为按渠道取；
4. `configValidation.ts` 的「不得含凭据」改为「仅鉴权来源允许含 key」——**放开不取消**。

### M04 — 模型管理 URL 默认值从登录 cch 推导

现状：默认值是 `http://127.0.0.1:3210/api/v1/models-config`（本地开发地址），
用户装完包登录、没手动改 URL 的话这一拉必然失败，静默落到硬编码的三个模型兜底。
登录应答里已经算出 `cchBaseUrl` 并存进保险箱，但它完全没参与这个默认值。

**用户 2026-09-05 拍板：先记录，等做配置页与 onboard 打包时再一起确定需求，然后执行。**
具体形态见 [Q04](./open-questions.md)。

### M05 — 本仓 `scripts/pi-model-admin.mjs` 的去留

迁移完成后的收尾：降级为纯本地开发工具（保留但明示不是生产管理站），还是整体下线。
按 [D02](./decisions/002-build-the-admin-page-in-onboard.md)，在此之前它**不再扩写**。

## 顺序与依赖

```text
Q01–Q04 拍板
  → M01 存储与端点 ──┬→ M02 管理页 UI
                     └→ M03 客户端契约适配（可与 M02 并行，两边按同一份约定）
  → M04 默认 URL 推导（需求确认后，随 onboard 打包一起）
  → M05 旧脚本去留（收尾）
```

跨计划：与 Pi 计划 [T38](../pi-backend-migration/roadmap.md) **无依赖**，互不阻塞。
