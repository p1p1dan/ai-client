# Roadmap — 模型配置页迁入 onboard 并扩展

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> **2026-09-05 开工**：四个 open question 已拍板（[D03](./decisions/003-empty-catalog-is-legal-drop-seed.md)–[D06](./decisions/006-explicit-pi-block-in-register-response.md)），
> M01–M05 的形状随之定死，下面各条已并入结论。

## 施工边界（用户 2026-09-05 拍板）

两个仓库都改：`ai-client`（本仓）与 `jyw-cch-onboarding`（`/home/ai/code/jyw-cch-onboarding`）。
**各自开分支，只提交不推送**；推送与部署由用户操作。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 5 | M01–M05（2026-09-05，[evidence](./evidence/2026-09-05-m01-m05-model-catalog-admin.md)） |
| In Progress | 0 | — |
| Next | 0 | 只剩累计 GUI 点验与部署，见 evidence「未做 / 待办」 |
| Deferred | 0 | — |

## Done

### M01 — onboard 侧配置存储与鉴权拉取端点

SQLite 存渠道/模型配置（onboard 已用 `bun:sqlite`）。两个端点分开：

- **客户端端点**：按 [D01](./decisions/001-authenticated-catalog-fetch.md) 用登录 key 做 Bearer 鉴权，
  只返回**启用**的渠道与模型，按 [topic §一](./topics/wire-contract-and-constraints.md) 的形状
  标注每个渠道的 baseUrl / apiKey 是管理员填的还是继承登录值。
  按 [D03](./decisions/003-empty-catalog-is-legal-drop-seed.md)，**零启用项时正常返回空集合**，
  不做「至少留一个」的兜底。
- **管理端点**：返回全部（含停用），按 [D04](./decisions/004-admin-page-static-token.md)
  用静态口令鉴权，口令未配置则整体不可用。
- 路径按 [D05](./decisions/005-catalog-endpoint-on-onboard-origin.md) 挂 onboard 自身域名：
  客户端端点 `/api/v1/models-config`。
- 改动留痕表：时间、渠道/模型、改前改后值、来源 IP（[D04](./decisions/004-admin-page-static-token.md) 已说明记不到人）。

**已落地**（onboard `5c0326d`）。施工中定的一条：cch 不可达时客户端端点返回 **502 而非 401**——
「没能得出结论」不等于「拒绝」，这样客户端保留旧缓存而不是把它当作登出。

### M02 — onboard 管理页 UI

渠道与模型的增删改 + **启用开关**（渠道级、模型级各一）+ **URL/Key 两个覆盖勾选**
+ 字段补齐。本轮做 `thinkingLevelMap`；
[topic §四](./topics/wire-contract-and-constraints.md) 里另外四项（默认思考强度、工具调用、
仅思考模式、允许关闭思考）本仓 schema 无对应字段，**先取证 pi 认不认再定**，见
[open-questions 尚未回答](./open-questions.md)。
管理页登录按 [D04](./decisions/004-admin-page-static-token.md)。

**已落地**（onboard `8dc988d`）：用户拍板用 Vite + React 前端子项目（非当时推荐的单文件方案），
产物由 Hono 托管在 `/admin`。截图里另外三项按 pi 取证结论**不做**，理由见
[evidence](./evidence/2026-09-05-m01-m05-model-catalog-admin.md)「pi 字段取证」。

### M03 — ai-client 侧契约适配

1. `sync()` 带 `Authorization: Bearer`（key 从 vault 取）；
2. `PiManagedProviderDefinition.baseUrl` 改可选，写盘时用 vault 值补齐；
3. `writeAuth()` 从「每个渠道同一把登录 key」改为按渠道取；
4. `configValidation.ts` 的「不得含凭据」改为「仅鉴权来源允许含 key」——**放开不取消**；
5. 按 [D03](./decisions/003-empty-catalog-is-legal-drop-seed.md)：非空校验放开、
   `source: 'seed'` 与 `createDefaultManagedConfig()` 删除、渲染层补「零可用模型」空态；
6. 按 [D06](./decisions/006-explicit-pi-block-in-register-response.md)：优先读应答里的 `pi` 块，
   保留 codex 推导回退。

**已落地**。两处施工中新增的事实：① `credentials` **缺席**是「D01 之前的管理端」这一独立情况，
按 `{baseUrl:'managed', apiKey:'onboarding'}` 读，老端点继续可用；
② 新增 `managed-models-source.json` 保存线上原样目录——`models.json` 是 pi 格式、丢了凭据来源，
key 轮换后重写文件需要那个答案。

### M04 — 客户端默认端点地址

**已落地**。取证更正后为两级：手填（env → 设置项）→ 编译期 `__ONBOARDING_SERVICE_URL__`
拼 `/api/v1/models-config`。`onboarding.serverUrl` 存的是 cch 地址而非 onboard 地址，
不能作为来源（见 [D05](./decisions/005-catalog-endpoint-on-onboard-origin.md) 的更正段）。
写死的 `http://127.0.0.1:3210/...` 已退役。

### M05 — 本仓 `scripts/pi-model-admin.mjs` 的去留

**已落地：整体下线**（用户 2026-09-05 拍板）。脚本与 `pnpm model-admin` 命令删除；
设置页文案改为指向 onboard 的 `/admin`，并说明拉取会带登录 key、配置可能含管理员填的密钥——
原文案「管理接口不返回任何 key」在 D01 之后不成立。

## 顺序与依赖（全部完成）

```text
Q01–Q04 拍板（已完成 2026-09-05）
  → M01 存储与端点 ──┬→ M02 管理页 UI
                     └→ M03 客户端契约适配（可与 M02 并行，两边按同一份约定）
  → M04 默认端点地址
  → M05 旧脚本去留（收尾）
```

跨计划：与 Pi 计划 [T38](../pi-backend-migration/roadmap.md) **无依赖**，互不阻塞。
