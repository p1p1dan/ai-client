# D02 — 管理页直接在 onboard 里新建，本仓单文件脚本不再扩写

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：用户（三选一里选「直接在 onboard 里建新管理页」，覆盖同日早些时候
  「先在本仓补齐、之后整体迁」的临时选择——新需求出现后重定）

## 背景

本仓的模型管理站是 `scripts/pi-model-admin.mjs`：156 行单文件，`pnpm model-admin` 起在
`127.0.0.1:3210`，数据存本地 JSON，鉴权是一个可选的 `PILAB_MODEL_ADMIN_TOKEN`（不设就完全不校验）。
每个模型只有四个可编辑字段：ID、显示名、上下文窗口、思考/普通。

用户的部署计划是：模型配置页与 onboard 一起打包部署，客户端登录后从它取配置。

## 决定

**新管理页在 `jyw-cch-onboarding` 里从头建，配套 SQLite 存储与鉴权；本仓那份不再扩写。**

同日早些时候曾选「先在本仓补齐字段、之后整体搬」。新需求（渠道级 URL/Key 覆盖、启用开关、
鉴权拉取）出现后这条不成立了：那些能力只在有存储和鉴权的服务里才有意义，
在本仓补一遍等于同一块表单写两次，且第二次还要推翻第一次的数据模型。

## onboard 现状（开工前的已知事实）

- Bun + Hono + zod + SQLite（`bun:sqlite`），Biome，`bun test`。
- 路由只有三条半：`/api/onboarding/send-code`、`/api/onboarding/verify-and-register`、
  健康检查，外加一条给旧客户端的遗留 `/register`。
- **没有任何管理页面，也没有管理端鉴权中间件**。`ONBOARDING_SECRET` 是给遗留路由的，
  `CCH_ADMIN_TOKEN` 是拿去调 cch 的，两者都不是管理员登录。
- 注册应答返回 `config: { claude: {...}, codex: {...} }`，**没有 `pi` 块**——
  ai-client 是从 `codex` 那份推出 `pi: { baseUrl, apiKey }` 的（见 [Q02](../open-questions.md)）。

## 代价

- 管理页自身需要一套登录/权限（谁能进管理页），onboard 现在没有。见 [Q03](../open-questions.md)。
- 本仓那份脚本的去留成为收尾项（roadmap M05）：降级为纯本地开发工具，还是整体下线。
