# D01 — 模型配置拉取端点用客户端登录 key 做 Bearer

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：用户（三选一里选「用客户端登录拿到的 key 做 Bearer」）

## 背景：管理员填 key 这件事本身要求鉴权

新需求允许管理员为某个渠道填死 API Key。那把 key 必须送到客户端，客户端才能用它请求该渠道。

而**今天的拉取是裸 GET**：`PiModelConfigService.sync()` 调
`net.fetch(endpointUrl, { method: 'GET', headers: { Accept: 'application/json' } })`，
不带任何凭据。两边还各有一条硬红线明确禁止配置里出现 key：

- 客户端 `src/main/services/piModelConfig/configValidation.ts:118`
  ——渠道对象里出现 `apiKey`/`key`/`token`/`oauth` 直接抛错；
- 本仓管理站 `scripts/pi-model-admin.mjs` ——同样的黑名单，注释写着
  「keys never belong in models config」。

在这个前提下直接加「管理员填 key」，等于任何能访问该 URL 的人 GET 一次就能拿走全部渠道的 key。

## 决定

**客户端拉取模型配置时，带上自己登录 onboard 拿到的那把 key 作 Bearer；onboard 验过才返回含 key 的配置。**

理由：

- 不需要多发一套凭据。客户端登录后本来就把它存在保险箱里（`pi.apiKey`）。
- onboard 本来就能向 cch 核实这把 key（它注册时就是从 cch 拿的）。
- 登出后自然拉不到——凭据没了，配置也就取不到了，不需要第二套吊销机制。

## 连带必须改的

1. `PiModelConfigService.sync()` 增加 `Authorization: Bearer <key>`。
   key 从 vault 取，与 `writeAuth` 用的是同一份。
2. `configValidation.ts` 的「渠道不得含凭据」红线**放开但不取消**：
   改为「只有经鉴权取回的配置允许携带 key」。
   本地/未鉴权来源的配置仍然一律拒绝——降级方向必须是安全的那一侧。
3. onboard 的客户端端点与管理端点分开：前者鉴权后只返回启用项，后者是管理员面。

## 被否掉的两条

- **单独发一个只读 token**：多一套凭据要发、要存、要吊销，而它保护的东西与业务 key 同级。
- **不让管理员填 key、只让填 URL**：改动最小，但用户明确要求「只勾 key」和「都勾」两种组合，
  这条做不到。

## 代价

拉取从「任何人可读的公开元数据」变成「需要凭据的接口」。
未登录 / 登出状态下拿不到模型清单——这本来就是正确行为（那时也没有 key 可用），
但客户端现有的 `seed` 兜底语义要跟着复核，见 [Q01](../open-questions.md)。
