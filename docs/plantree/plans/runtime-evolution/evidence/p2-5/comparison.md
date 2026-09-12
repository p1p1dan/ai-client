# P2-6 · 同套会话新旧后端对比

套件 p2-0-v3（SHA-256 一致）· 模型 claude-sonnet-5 · 网关 http://107.173.157.208:23000 · 工作目录 /tmp/aiclient-p2-0-work

依赖版本：legacy {"@earendil-works/pi-coding-agent":"0.84.3","@earendil-works/pi-agent-core":"0.84.3","@earendil-works/pi-ai":"0.84.3"}；native {"@earendil-works/pi-agent-core":"0.84.4","@earendil-works/pi-ai":"0.84.4","cordis":"4.0.0-rc.9"}
Node：legacy v22.23.2；native v22.23.2。git HEAD：legacy 8b75b64699ce1aa25845e3165eb3dbdec3a6d3d9；native 8b75b64699ce1aa25845e3165eb3dbdec3a6d3d9

## 逐场景命中率

| 场景 | 后端 | 模型调用 | 工具调用 | input | cacheRead | cacheWrite | 命中率 | 差（百分点） |
|---|---|---|---|---|---|---|---|---|
| B01 纯对话 | legacy | 3 | 0 | 6 | 37726 | 18948 | 99.98% |  |
| B01 纯对话 | native | 3 | 0 | 6 | 33665 | 16910 | 99.98% | -0.00 |
| B02 多轮文件工具 | legacy | 6 | 3 | 12 | 20553 | 4251 | 99.94% |  |
| B02 多轮文件工具 | native | 6 | 3 | 12 | 12452 | 293 | 99.90% | -0.04 |
| B03 搜索与读取 | legacy | 5 | 2 | 10 | 16421 | 4224 | 99.94% |  |
| B03 搜索与读取 | native | 5 | 2 | 10 | 8421 | 2229 | 99.88% | -0.06 |
| B04 长文件截断与分页 | legacy | 5 | 2 | 10 | 72256 | 22917 | 99.99% |  |
| B04 长文件截断与分页 | native | 5 | 2 | 10 | 64107 | 20850 | 99.98% | -0.00 |
| B05 压缩后续聊 | legacy | 5 | 0 | 10 | 54952 | 36313 | 99.98% |  |
| B05 压缩后续聊 | native | 5 | 0 | 10 | 42467 | 25733 | 99.98% | -0.01 |
| B06 resume 续聊 | legacy | 4 | 0 | 8 | 12159 | 4130 | 99.93% |  |
| B06 resume 续聊 | native | 4 | 0 | 8 | 6124 | 2102 | 99.87% | -0.06 |

## 整套合计

| 后端 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |
|---|---|---|---|---|---|
| legacy（同网关重采） | 28 | 56 | 214067 | 90783 | 99.97% |
| native | 28 | 56 | 167236 | 68117 | 99.97% |
| legacy（历史归档，网关 https://maxapi.hanyue.xyz） | 28 | 9599 | 182929 | 79406 | 95.01% |

native 相对同网关 legacy：-0.01 百分点。门禁阈值 95.01%：native 达标，legacy 达标。

历史归档使用的网关是 https://maxapi.hanyue.xyz，与本次不同，因此它的 95.01% 只作参考，不作为本次对比的基准；本次的可比基准是同网关重采的 legacy 结果。

## 压缩摘要调用（不计入门禁分母）

| 后端 | 调用 | input | cacheRead | cacheWrite |
|---|---|---|---|---|
| legacy | 1 | 2 | 0 | 15430 |
| native | 1 | 2 | 0 | 21701 |

## native 侧无法对齐的设置（采集时声明）

- `compaction.reserveTokens`：derived from the model window (COMPACTION_RESERVE_FLOOR_TOKENS); not configurable
- `compaction.keepRecentTokens`：derived from the model window (COMPACTION_KEEP_RECENT_RATIO); not configurable
- `compaction.enabled`：kept ON so B05 can force a real compaction; automatic compaction cannot trigger at this context size
- `retry.enabled`：the native loop has its own provider retry; a retried request that never reaches turn_end contributes no usage row
