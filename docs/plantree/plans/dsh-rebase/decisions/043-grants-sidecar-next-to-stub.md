# 决策 043：会话授权记忆存在桩旁的 sidecar `<桩名>.grants.json`

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-6 方案 §5 D4](../topics/p1-6-permissions.md#5-需要拍板的决策点)。

## 规则

1. DSH 日志不能写自定义事件（[决策 026](026-history-per-message-tree-across-lineage.md) 第 5 条），所以授权记忆放在桩旁的 `<桩名>.grants.json` 里，沿用 v2 编码，原子写。
2. 生命周期：
   - bootstrap、恢复、崩溃重启时读回；
   - 用户选「本会话允许」时写全量；
   - 换 mode 时写空集；
   - 回退时保留，fork 时复制；
   - discard 或 GC 时与桩一起删（[决策 024](024-gc-only-orphan-empty-sessions.md)）。
3. P1-9 负责把旧 pi 会话里的 `aiclient.permissionGrants` 条目迁移成 sidecar。

## 取舍

- 不选「写进桩文件」：会和 P1-4b 的桩写入（lineage、指针切换）相互干扰。
- 不选「Main 持久化后在 bootstrap 下发」：宿主崩溃后还要绕回 Main 取。
- 行为差异：回退之后授权保留。1.0.x 回退后，只认当前分支上的记录。
- 代价：多一个小文件，GC 和 fork 要顺带处理它。
