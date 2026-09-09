# P3-2 至 P3-5 实现与验收契约

2026-09-09 · execute-ready · [看板](../README.md) · [TODO](../TODO.md)

- P3-2：沿用 Pi 的 parent 树与 main lane。支持完整树/历史、切换分支、确认后 rewind、独立 fork、标签与标题；导航持久化，fork 不更改源 leaf/file。新运行恢复选中分支的 checkpoint、模型/思考档位与权限状态。
- P3-3：兼容读取 Pi v1/v2/v3 与 PI-Desktop transcript schema 1，保留消息、工具关联、compaction、未知自定义数据与来源。resume 使用独立 v4 目标文件，不原地破坏旧文件；旧 readonly/pragmatic/handsoff/fullopen 按 D14 完整迁移。迁移支持明确 workspace 重定位，并保存原 cwd 与来源身份；默认拒绝不一致 cwd。
- P3-4：native AgentEvent 翻译为既有 RuntimeEvent，覆盖消息/思考/工具/usage/status/error/custom/compaction。重用已有流去重、usage 与输出格式；不改变 renderer/preload 协议。真实 native run 接通翻译出口，保留原始 onEvent。
- P3-5：session 索引元数据由 runtime 输出，Main adapter 调用现有 createImported/createForked/commitResumed/commitPiLeaf/handleRuntimeEvent；文件身份不降格成只按标题匹配。验证真实 SessionIndexService 文件持久化与失败边界，不改 Main 索引格式。
- 边界：worker 默认 native 开关与两种 carrier 全链路仍归 P4；本批通过实际 native runtime + Main adapter 联调验证接缝，不用空接口代替接线。
- 验收：分支往返、fork 隔离、用户回退语义、旧格式 fixture + P2-0 真实旧 JSONL、D14 四值迁移、新旧事件契约、Main 索引创建/恢复/leaf 与错误回滚；所有运行使用 fauxProvider，不消耗线上模型。

## 落地接口与可靠性边界

- 会话导航持久化 main lane；完整树与当前分支历史复用已有 piSessionTree/piSessionTimeline，历史分页沿用 offset 从最新向前、最多 500 条。
- 模型从选择分支恢复，显式 run.model 优先；已删除的 catalog 模型回落默认，不保证运行缺失模型。
- 迁移在目标 writer 锁内写临时文件并 rename 发布；失败清理临时文件。来源使用 realpath + SHA-256 绑定，原文件不写。
  旧来源需空闲；不承诺与官方 writer 并发读写。旧副本来源改变后拒绝自动复用，可另选新目标显式 import。
- Main adapter 操作覆盖 runtime 修改、索引提交和失败回滚的整个区间；fork 回滚校验创建者身份并重新获得文件锁。
  两文件操作没有跨文件事务日志，进程在间隙被强杀时可能留下未索引 fork，或磁盘 lane 与旧索引暂时不同；下次 connect 以持锁读取的 JSONL 元数据提交索引。
- custom.entry 在写入成功后发布；usage 使用既有 payload/rollup，turn_end 为唯一计费事件来源，重开按完整分支恢复累计值。
- Main 只引用共享类型与已有纯投影函数，未导入 runtime/Pi SDK 值；P4 实现 worker RPC 的控制端口绑定和生产生命周期。
