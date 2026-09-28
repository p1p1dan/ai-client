# 决策 072：渲染层的数据通路：jobs 与目标 armed 经 `session.projection`，目标控制走新 RPC `worker.command`，自主回合带 `origin` 轮次头

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-7 方案 §5 D1～D7](../topics/p1-7-renderer.md#5-需要拍板的决策点)、[决策 031](031-session-projection-event.md)。

## 规则

1. jobs 列表与目标的 armed 状态，走 `session.projection`，由 bridge 合成两个 key：`goalActivation`、`jobs`（DSH 的 goal 投影不含 armed 状态）。决策 031 的 key 从此不全来自 DSH 投影，类型里注明。
2. 目标控制用新 RPC `worker.command`，在队列之外执行 `/goal …`：普通发送在回合进行中会被排队，这个 RPC 还能给别的命令复用，并保留 DSH 的暂停语义。
3. 自主回合（goal 续跑、子代理或后台完成唤醒）回显一条带 `origin` 的轮次头。回合时钟、工作组折叠都按「一轮」计；`chatSessions.ts` 加一个可选字段，读用户消息的 5 处要认 `origin`。P1-4a / 4d 的投影要把这类回合的首条投成轮次头。
4. 通知按来源定显示表（分片 03 §6.2），直播与历史共用；`[model changed]` 和提醒类只给模型看，不显示。
5. 运行中命令的实时输出，从 DSH 的 job 环取，节流后发 `tool.output`。前台命令本身就登记成 job，不改 runtime。
6. 子代理配对：直播与历史用同一套规则，按执行期结果值确证，加日志位置规则。同一回合里描述完全相同的并行委派可能配错，由实验 E2 验证。
7. 泳道收尾：DSH 会话只在引擎失联时扫；其余情况靠子代理自己的结束事件。现状是任何 `session.completed` 都会把泳道扫成「已取消」，与 DSH 后台可续跑的子代理冲突，**必须改**。

## 取舍

- 各项的备选与代价见方案 §5 的 D1～D7。
- 开工前做实验 E1～E6：前台 job 与工具调用的对应、子代理配对、`goal/activation-changed` 的顺序、实时输出的事件量、Stop 对后台的影响、唤醒上限。
