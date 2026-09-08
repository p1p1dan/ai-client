# P1 执行 TODO

2026-09-08 · 用户已授权代码修改 · [看板](README.md) · [P1-0 契约](topics/p1-0-host-contracts.md) · [验证记录](evidence/p1/README.md)

## 当前批次：D14 返工

- [x] 重读 P1 交接、ARD D14 和当前代码；确认旧 69 项测试不能代签新权限模型。
- [x] P1-1：plan/agent 枚举、注册表按模式裁剪，执行边界也拒绝被裁掉的工具。
- [x] P1-5 核心：ask/accept-edits/auto、旧值迁移、deny 优先；accept-edits 放行工作区 bash。
- [x] P1-5：Bash AST（引号、变量、cd、重定向、嵌套 shell/替换、通配符与 symlink）及原生策略加载已接入；路径同时参与 deny/scope 判定，审批后复核，普通工作区管道自动放行。
- [x] P1-5：导入全局/可信项目及旧 JSONC 配置；保持表合并顺序，glob 映射旧 find，坏配置明确阻止启动；policy 哈希/来源/迁移提示进 stamp。
- [ ] P1-5/P4：在真实项目中验证复杂脚本兼容与策略更新后的 runtime 重载；动态程序仍不属于 OS 沙箱保证。
- [x] P1/P2 提示词接口：导出 modeSegment / permissionGearSegment，对齐新固定槽位。
- [x] P1-6：renderer 两模式/三档控件与偏好迁移；新 IPC/RPC 传递完整 permissions，旧 tier 仅保留兼容入口。
- [x] P1-6：创建/resume/存量 worker 复用、空闲时更新、崩溃重启传递 mode + gear；worker 拒绝时 UI 不落盘。
- [x] P1-6：旧 worker 适配 D14 工具裁剪/授权器，随包 bash 默认询问，accept-edits 由授权器放行；DOM 交互与真实策略加载回归通过。
- [ ] P1-6/P4：打包壳 GUI 全链路签收；用户自定义策略与复杂 shell 兼容仍按 P1-5 跟踪。
- [x] 更新新矩阵与载体证据：P1/P0 共 79 项通过，Node 与 Linux Electron 六项探针通过；Windows 和 GUI 仍待验收。

## 新增 P1-9（与 P2-8 成对）

- [x] 阅读 PI-Desktop new_context 源码和测试，适配无参数工具、两种回复及只提交意图语义。
- [x] 导出 newContextTool({ family, request })；不默认注册。P2 接入时按 read 注册，plan 可用，无普通审批，显式工具白名单仍生效；4 项测试通过。
- [ ] 与 P2-8 共同接通注册和提醒，P2 在下一轮边界消费意图；未接通前不向模型宣称已支持主动压缩。

## 已落地（旧口径历史，代码未提交）

- [x] 收口契约三项建议和 Q6。
- [x] HostIo/Exec、TSD helper；bootstrap/catalog/trace 异步迁移。
- [x] 六工具注册表、文件/bash/搜索实现、四档权限、scope/白名单、审批桥接。
- [x] 本机相关 69 项测试、类型检查、P0 离线冒烟、Node 与真实 Electron utilityProcess 探针。
- [x] P1 工具/权限提示词贡献函数供 P2 装配；保留 P2 的已提交实现。

## 剩余 TODO

- [x] 增加保留进程树根身份的 Node runner；Linux 验证命令先退出后的后代清理。
- [ ] Windows 验证 runner + taskkill 的命令树清理；P1-0/P1-3 保持进行中。
- [ ] 用真实 Windows 随包 Node 跑 P1-8 六项工具探针与超时/退出检查。
- [ ] 在企业加密机签收工具读写明文、bash stdout 和残留进程检查。
- [x] 旧权限配置导入与两轴 worker RPC 本机回归；仍需 P4 的完整项目/打包链路签收。

## 本轮重读确认的要求

- D11：Windows 安装版随包 Node；其他产品路径 electron-utility，独立 Node 探针另列。
- D12：Pi 保持 0.84.4；旧基线 0.84.3 的 patch 差记录为偏差，不回退、不补采。
- D13：Main 用户文件读取统一 TSD-aware，属于 P3-5/P4-5；Q7 GitService 由主线处理。
- D9：缓存门禁为 provider 原始 cacheRead / (input + cacheRead)，不低于旧基线 95.01%；属于 P2/P6，不用本轮 faux 测试代签。
- D14：旧 readonly 迁为 plan + ask，其余分别迁为 agent + ask/accept-edits/auto；goal 本轮不做。

## 验收边界

P1 整体未完成。Linux 的检查不能代签 Windows；没有运行远端 CI 或 GUI 全链路。
D13 的 Main 读取改造由 P3-5/P4-5 处理；Q7 由主线处理。
