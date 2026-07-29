# Ideas Inbox（低承诺想法池）

> 想法不是承诺。成熟后 promote 到 roadmap / open-questions / decisions 并回链。

- 2026-07-24 长会话时间线虚拟化——是否需要以 C-12 压测数据为准（ARD 已列为后置项，此处仅存念）。
- 2026-07-24 显式 mock-resolver 注入容器：让 T-09「Node 缺失」场景可被真实触发（源自 T-09 验收未竟项）。
- 2026-07-29 死代码清理：`chatSessions.recentSessionIds` + `touchLiveUpdatedAt` + `recentSessionIdsFromIndex`——T-26 后最后读者已移除，仍在三处被维护（cap 还不一致 8 vs 20）。动红线 store，宜随 T-22/T-23 顺手清（源自 T-26 对抗复核 info 项）。
- 2026-07-29 `worktree.list` handler 的 `clearWorktrees()` 全局副作用（扇出时 auto-fetch 只剩最后一个仓库）——设计文档 §2 标注的既存 bug，T-27 分支下拉重度依赖该数据源，开工前宜先修（源自双盲设计取证）。
