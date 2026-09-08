# P1 执行 TODO

2026-09-08 · 用户已授权代码修改 · [看板](README.md) · [P1-0 契约](topics/p1-0-host-contracts.md)

## 当前批次

- [x] 收口契约三项建议和 Q6；核对现有实现、资源与参考。
- [ ] P1-0：实现 HostIo/Exec、TSD helper 和确定性测试。
- [ ] P1-0：迁移 bootstrap/catalog/trace，回归 P0。
- [ ] P1-1～P1-4：注册表、文件/bash/搜索工具及测试。
- [ ] P1-5～P1-8：权限、审批接入、行为回归和载体检查。

## 验收边界

本机测试、Windows runner、真实载体、加密机现场分别记录。尚未执行的检查不标通过。
P4 WorkerTransport/平台合并仍属于 P4，不提前修改 Main/renderer。

## 最近验证

启动前工作区干净；当前主机内存可用约 4.1 GiB，磁盘可用约 44 GiB，无遗留重型构建。重任务继续串行。
