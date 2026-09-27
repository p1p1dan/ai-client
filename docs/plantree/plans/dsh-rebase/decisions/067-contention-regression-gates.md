# 决策 067：长会话并发争用的回归：硬门槛每次推送都跑，软门槛只告警

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-8 / P1-11 方案 §4 D10](../topics/p1-8-p1-11-guards-and-terminal.md#4-需要拍板的决策点)、[P0-6 证据](../evidence/p0-6-shared-host-2026-09-26.md)、[分片 05](../topics/p1-8-p1-11-guards-and-terminal/05-regression-tests-changes.md)。

## 规则

1. 场景 LC-0～LC-4，观测量用 P1-3b 心跳 pong 里的 `eldMaxMs`、`rssMb`。
2. 硬门槛每次推送都跑，例如 LC-2：ELD ≤ 1 s、RSS ≤ 600 MB、没有卡死判定。
3. 软门槛取 P0-6 实测值的 1.3～1.5 倍，只告警，由人看摘要。
4. LC-3 / LC-4 太重，只手动跑。
5. CI 与 P1-4e 共用 `dsh-bridge-gate.yml`。推分支前要用户确认。

## 取舍

- 不选全部硬门槛：CI runner 的规格没核实，时间类指标会抖，容易误报。
- 不选只手动跑：退化会悄悄进来。
- 代价：软门槛发现的退化要有人看。
