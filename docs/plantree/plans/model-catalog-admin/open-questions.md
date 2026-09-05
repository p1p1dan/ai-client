# Open questions — 模型配置页迁入 onboard

四问全部**未答**，都会改变 [M01/M03](./roadmap.md) 的形状，开工前先拍板。

## Q01 — 全部停用（或未登录）时，客户端拿到空配置怎么办？

客户端现在要求 `models` 非空且至少一个 provider，空配置会被判非法，然后落
`stale-cache`（有旧缓存）或 `seed`（硬编码的三个 `gpt-5.6-*`）。

[D01](./decisions/001-authenticated-catalog-fetch.md) 让未登录状态也拉不到配置，
这个分支从「罕见」变成「正常路径之一」。两条路：

- **A**：服务端保证永不返回空配置（至少留一个启用渠道）；
- **B**：客户端放开空配置语义，明确区分「拉到了，是空的」与「没拉到」——
  和插件清单 `null` vs `[]` 同一类问题。

顺带要复核：`seed` 兜底那三个硬编码模型在有管理端之后还该不该存在。

## Q02 — onboard 要不要显式返回 `pi: { baseUrl, apiKey }`？

现在注册应答只有 `claude` 与 `codex` 两块，ai-client 从 `codex` 那份推出 `pi`
（`OnboardingService.saveVaultShadowCopy`）。既然模型配置要按渠道决定用不用「登录拿到的 pi 凭据」，
让服务端显式声明比让客户端继续猜更稳。改动很小，但属于线上格式变更，要考虑旧客户端。

## Q03 — 管理页自身的登录与权限是什么？

onboard 现在**没有任何管理端鉴权中间件**。`ONBOARDING_SECRET` 是给遗留 `/register` 的，
`CCH_ADMIN_TOKEN` 是拿去调 cch 的，都不是管理员身份。
需要定：谁能进管理页、用什么登录、要不要审计谁改了配置。

## Q04 — M04 的默认 URL 具体长什么样？

用户 2026-09-05 明确「后续做配置页 + onboard 打包时再讨论确定需求」。待定的至少有：
路径形态（`<cch>/api/v1/models-config`？还是挂在 onboard 域名下而非 cch 域名下）、
手填值与推导值的优先级、以及推导失败时的表现。
