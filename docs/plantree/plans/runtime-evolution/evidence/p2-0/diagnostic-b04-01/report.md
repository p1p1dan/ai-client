# P2-0 旧后端采集

有效完整基线：否。模型：claude-sonnet-5。费用：未知。

| 场景 | 成功 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |
|---|---|---|---|---|---|---|
| B04 长文件截断与分页 | true | 5 | 10 | 50089 | 38539 | 99.98% |

整体 token 加权命中率：不可测。压缩摘要 usage 独立保存在 summary.json；不计入 D9 门禁分母。
