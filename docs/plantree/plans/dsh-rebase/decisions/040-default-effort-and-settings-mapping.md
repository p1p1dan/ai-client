# 决策 040：没选档位时会话补发 medium；设置映射到 DSH 的路由级参数

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-5 方案 §5 D8、D9](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、[分片 03 §2、§5](../topics/p1-5-models-and-credentials/03-design.md)。

## 规则

1. 档位声明翻译：我方 map 里的 `null` 表示不支持，一律不写；low / medium / high 没写的，补成同名。DSH 里 `off` 写空值，表示「支持但不发送」。
2. 没选档位时：会话发 medium（模型支持时），与 1.0.x 原生一致；一次性补全里 `off` 和没选都不发。不支持的档位直接剔除，不让回合失败。
3. 设置映射：
   - 缓存 TTL → `cacheRetention`；
   - 空闲超时 → `streamIdleTimeoutMs`，0（永不超时）映射为上限值；
   - 重试 3 次、间隔 3 s～30 s → `retryPolicy`。
4. `subagentPromptCacheTtl` 在 DSH 下失效：DSH 只有路由级设置，子代理继承父会话的路由。设置页注明这一项。

## 取舍

- 不选「一律不发，照 DSH 原样」：GPT 类模型在 Default 档下会不思考，这与 1.0.x 行为不同。
- 代价：与 DSH 官方桌面端的行为不同；子代理不能再单独设缓存 TTL。
