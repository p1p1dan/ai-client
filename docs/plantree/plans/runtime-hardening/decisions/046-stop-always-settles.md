# 决策 046：Stop 必须在有限时间内以终态收尾；运行状态以 worker 为准、Main 对账

日期：2026-09-25。来源：[「继续」之后停不下来](../evidence/stuck-after-continue-2026-09-25.md)（用户 Windows `1.0.3-test.2` 现场）。落地任务 **T144**、**T145**。

## 背景

Stop、插话、结束对话原先都是只发不回的信号：worker 没有活动回合时静默返回 `false`，Main 丢掉结果，渲染层只在终态事件到达时才解除「运行中」。只要渲染层与 worker 对「在不在跑」的看法不一致，界面就永远停不下来。

## 规则

1. **权威**：回合是否在跑以 worker 为准；Main 镜像并负责对账；渲染层只从事件和自己在飞的握手推导，不自造「在跑」。
2. **Stop 必收尾**：
   - worker 报「没有活动回合」时，Main 清掉自己的闩锁，派发幂等的 `session.stopped`（原因「没有活动回合」）加 `session.status idle`。
   - worker 接下了 Stop 时，Main 启动看门狗；到时仍无终态，就走崩溃路径强制重启该 slot，派发 `session.stopped`（原因「强制停止」）加 idle。
   - 渲染层在 `stopping` 状态下 Stop / Esc 仍然可用（显示为强制停止），发送握手中的每个 IPC 等待都可被 Stop 取消。
3. **结束对话**：有活动请求时先派发 `session.stopped` 再 `disconnected`；渲染层同时复位该会话的发送 / 停止闩锁、回合头与乐观气泡；`disconnected` 下队列不能死锁。
4. **禁用的按钮不能把点击穿透成别的动作**（队列行「立即发送」禁用时不得触发「取回编辑」），并说明为何不可用。
5. **接纳要真实**：worker 只在 run 真正被接纳后才回 accepted；前置拒绝要发 `session.failed` 加 idle。

看门狗时长由实现定（建议 8～10 秒），定下后回写本条。
