# P2-0 采集证据

任务：[基线方案与 TODO](../../topics/p2-0-cache-baseline.md) · 工具：[运行与复核](../../../../../../scripts/runtime-baseline/README.md)

**正式基线已完成：整体命中率 95.01%，六场景、28 次普通模型调用。**
[基线报告](baseline-20260908/report.md) · [验收与交接](validation.md) · [原始数据复核](baseline-20260908/verification.json)

| 记录 | 状态 | 用途 |
|---|---|---|
| [接口与旧 SDK 冒烟](endpoint-preflight.json) | 通过，不是正式基线 | 用户指定模型可访问，能上报原始缓存 usage；无完整应用 bootstrap |
| [run-20260908-01](run-20260908-01/report.md) | 失败，排除 | suite v1 在 B02 使用旧 edit 参数；实际工具要求 `edits[]`，被样本约束拦下。失败 trace 与会话保留 |
| [run-20260908-02](run-20260908-02/report.md) | 整套不完整；B01–B03 被选入 | B01–B03 是兼容输入的首次完整成功；B04 第二步连接错误、usage 全零，B04 失败会话排除 |
| [run-20260908-03](run-20260908-03/report.md) | 不完整，保留成功场景及失败记录 | B01–B03 通过，B04 再次在分页后的模型请求遇到连接错误；含与 manifest 哈希一致的 collector 源码快照 |
| [失败请求直接重放](long-file-replay.json) | 诊断通过，不计基线 | 原样请求直接访问同一 endpoint 返回 HTTP 200、完整 SSE 结束；不能据此断言 SDK 或网关的具体根因 |
| [diagnostic-b04-01](diagnostic-b04-01/report.md) | B04 完整成功 | 同一 suite v2 的长文件场景首次完整成功，包含真实截断、分页与标记核验 |
| [case-b05-01](case-b05-01/report.md) | 样本失败，排除 | v2 材料集中在第一轮，SDK 保留完整轮次导致无可压缩前缀；前三轮通过但 compact 返回 Nothing to compact |
| [case-b05-02](case-b05-02/report.md) | B05 完整成功 | v3 仅为 B05 第二轮补充固定材料，真实压缩 16104 → 3909，后续两轮事实核验通过 |
| [case-b06-01](case-b06-01/report.md) | B06 完整成功 | 销毁后从同一 JSONL 重开，会话身份与消息快照一致，两轮续聊成功 |
| [baseline-20260908](baseline-20260908/report.md) | 正式基线，复核通过 | 六份首次完整成功会话及来源证明，机器汇总 `validBaseline: true` |

单次 runner 的 `summary.json.validBaseline` 只有六场景全部通过时才为 true；单场景运行即使
成功也为 false，场景完成状态以其 `result.json.passed` 为准。
连接失败连续两次发生后，改为按独立场景补齐：`collect.mjs` 按运行时间选取每个场景首次
完整成功结果，要求逐场景输入、模型/参数/采集器与旧后端源码哈希一致，原始 JSONL 原样复制，失败尝试全部登记。
只有六场景齐备且独立 verifier 从原生 session JSONL 与 trace 复核通过，收集结果才有效。

v1 → v2 仅修改 B02 的 edit 提示与期望参数为 `edits: [{oldText, newText}]`；各套原始输入
分别保存在各自 `suite.json` 中。脚本新增嵌套参数深比较与启动时参数名/schema 校验；
首次失败证据不合并进 v2 的命中率。

v2 → v3 仅修改 B05 第二轮材料，确保 SDK 能划出可压缩的旧轮次。其余五个场景字节未变；
收集器可复用原始输入完全相同的场景，必须验证来源 suite 中该场景内容与最终 suite 一致，
并归档来源 manifest/suite 与 case SHA-256。不存在将 v2 失败的 B05 标为通过的操作。
