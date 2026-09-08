# P1 执行 TODO

2026-09-08 · 用户已授权代码修改 · [看板](README.md) · [P1-0 契约](topics/p1-0-host-contracts.md) · [验证记录](evidence/p1/README.md)

## 已落地（代码未提交）

- [x] 收口契约三项建议和 Q6。
- [x] HostIo/Exec、TSD helper；bootstrap/catalog/trace 异步迁移。
- [x] 六工具注册表、文件/bash/搜索实现、四档权限、scope/白名单、审批桥接。
- [x] 本机相关 69 项测试、类型检查、P0 离线冒烟、Node 与真实 Electron utilityProcess 探针。
- [x] P1 工具/权限提示词贡献函数供 P2 装配；保留 P2 的已提交实现。

## 剩余 TODO

- [ ] Windows 完成根进程先退出时的后代清理；P1-0/P1-3 保持进行中。
- [ ] 用真实 Windows 随包 Node 跑 P1-8 六项工具探针与超时/退出检查。
- [ ] 在企业加密机签收工具读写明文、bash stdout 和残留进程检查。
- [ ] P4 前核对完整旧权限策略导入、bash 解析兼容与 worker 审批 RPC 路由。

## 验收边界

P1 整体未完成。Linux 的检查不能代签 Windows；没有运行远端 CI 或 GUI 全链路。
D13 的 Main 读取改造由 P3-5/P4-5 处理；Q7 由主线处理。
