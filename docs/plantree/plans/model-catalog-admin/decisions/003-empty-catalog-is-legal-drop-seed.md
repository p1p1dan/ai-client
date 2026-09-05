# D03 — 空配置是合法结果，删除硬编码 seed 兜底

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：用户（三选一里选「客户端能表达『空』，删掉硬编码兜底」）
- **答复**：[Q01](../open-questions.md)

## 背景

客户端把「模型清单为空」当成非法数据：`configValidation.ts` 要求 `models` 非空且至少一个
provider，于是空配置会退到旧缓存（`stale-cache`），没有旧缓存就退到
`createDefaultManagedConfig()` 里写死的三个 `gpt-5.6-*`（`PiModelConfigService.ts:382-401`）。

[D01](./001-authenticated-catalog-fetch.md) 让未登录状态也拉不到配置，
加上管理员现在能停用渠道与模型，「空」从罕见分支变成了正常路径之一。

## 决定

**「拉到了，是空的」与「没拉到」是两种不同状态；空配置合法；硬编码的三个模型删除。**

- 服务端不必刻意保证非空——管理员把所有渠道停用是合法操作，客户端要能如实呈现。
- 客户端区分两件事：拉取成功但零个可用模型（显示「管理员当前没有启用任何模型」），
  与拉取失败（显示失败原因，可退旧缓存）。
- `createDefaultManagedConfig()` 与它的三个 `gpt-5.6-*` 删除，`source: 'seed'` 一并退役。

## 为什么删 seed

有了管理端之后，写死的模型只会在拉取失败时把失败伪装成成功。M04 记的正是这个坑：
装包后默认地址指向 `127.0.0.1:3210`，用户不改就必然拉失败、静默落到这三个模型，
界面看上去一切正常。删掉之后失败就是失败，会被看见。

## 连带改动

- `configValidation.ts` 的非空校验放开（provider 表与 models 数组允许为空）。
- `PiModelSyncState['source']` 去掉 `'seed'`；`readState()` 无本地配置时的重建分支要重写。
- 写 `models.json` 时允许写出零模型的合法文件——需确认 pi 读到空 provider 表不会崩，
  开工时取证。
- 渲染层需要一个「零可用模型」的显式空态，不能沿用「加载中」。

## 与其它计划的关系

同一类问题在本仓已出现两次：插件清单的 `null` vs `[]`（[D06](../../pix-ui-alignment/decisions/006-plugin-inventory-source.md)）、
权限档的显式降级（[D10](../../pix-ui-alignment/decisions/010-user-configured-gate-explicit-degradation.md)）。
本决定与它们同向：缺席与空值必须是两句不同的话。
