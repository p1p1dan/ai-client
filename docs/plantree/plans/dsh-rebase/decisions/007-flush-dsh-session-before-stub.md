# 决策 007：新建 DSH 会话时先固化落盘，再写桩

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-1 方案 §5 D3](../topics/p1-1-engine-cutover.md#5-需要拍板的决策点)。

## 规则

1. 新建顺序：`agents.create` → `ctx.sessions.flush(session)`（写 header 并取锁）→ 原子写桩（[决策 006](006-session-identity-stub-file.md)）→ 返回 `sessionFile`。
2. Main 继续沿用「桩在即提交身份」。因为桩一定晚于 DSH 会话落盘，身份提交时 DSH 会话已经在盘上。
3. 如果 bridge-smoke 实测发现 `flush` 之后只有 header 的会话无法 `agents.resume`，本决策作废，回到下面的备选 B 重议。

## 取舍

- 今天的问题：DSH 新会话要到首次追加才落盘，bridge 却在 bootstrap 时就写桩。首回合之前宿主一死，这个会话就永远打不开。这和 pi 懒写那次是同一个坑。
- 备选 B「仿 pi 懒提交」：首次落盘后才写桩，靠 Main 现有的懒提交和 rematerialize 补救。不选的原因：DSH 落盘有 200 ms 攒批，窗口期更难证明；rematerialize 会用同一个 id 重建，又会撞上 `SessionAlreadyExistsError`。
- 代价：发送失败的会话会留下一个只有 header 的日志。会话在首次发送时才创建，所以量很小，由 P1-3 的日志清理策略统一处理。

## 影响

- P1-1：`dshSessionRuntime.ts` 的新建路径；`bundle/lib/bridge.js` 把 `sessions` 注入给 bridge；bridge-smoke 增加「新建后已落盘」「只有 header 的会话能恢复」两个场景。
