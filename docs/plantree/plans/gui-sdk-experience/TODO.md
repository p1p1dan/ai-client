# GUI 改进可见 TODO

完整验收前所有产品任务保持未勾选。批次 A → B → C → D，追加 E、F；状态：待调查 / 实施中 / 已实现待验收 / Done。

2026-09-09 Windows 现场执行了 A~E，末列按[现场结果](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)回填。GUI 大项通过，但没有一项达到 Done——加密机未验收，且交回的 F 编号缺陷在 [runtime-evolution 看板](../runtime-evolution/TODO.md#windows-交回缺陷2026-09-09linux-侧)统一跟踪。

| 编号 | 批次 | 任务 | 实现 | 自动化 | GUI | Windows/加密机 |
|---|---|---|---|---|---|---|
| 1 | A | 左栏菜单鼠标与焦点生命周期 | 已实现待验收 | 通过（见 A 证据） | 真实 Electron 鼠标/焦点通过 | Windows 通过；加密机未验收 |
| 2 | A | 终端设置循环更新 | 已实现待验收 | 通过（见 A 证据） | 开发 React 控件通过；完整 GUI 待验 | Windows 部分：进入正常，「网络」子项报错（F1） |
| 7 | A | 文件点击与编辑器挂载/行号 | 已实现待验收 | 通过（见 A 证据） | 真实 React 链路通过；Monaco GUI 待验 | Windows 通过（多样路径 2c 无样本未测） |
| 10 | A | /new 保留目录 | 已实现待验收 | 通过（见 A 证据） | 动作测试通过；完整 GUI 待验 | Windows 部分：被 F2 阻断 |
| 4 | A | 临时目录复用/创建时间及绑定 | 已实现待验收 | 通过（见 A 证据） | 文件系统测试通过；完整 GUI 待验 | Windows 失败（F2）；已修 `dbead94b`，待现场复验 |
| 5 | B | 尾部重试/异常 | 已实现待验收 | 通过（见 B 证据） | 真实时间线 DOM 通过；GUI 待验 | Windows 未触发 529/429；503 直接失败待定性（F4） |
| 6 | B | 真实运行状态/计时/摘要 | 已实现待验收 | 通过（见 B 证据） | 真实状态 DOM 通过；GUI 待验 | Windows 通过；「正在输出」两处重复（F7b） |
| 3 | C | 权限展示降噪 | 已实现待验收 | 通过（见 C 证据） | 真实权限 DOM 通过；GUI 待验 | Windows 部分：无提问工具，授权详情不可展开（F5/F7a） |
| 8 | C | 问答卡布局与交互 | 已实现待验收 | 通过（见 C 证据） | 两种问答 Electron 通过 | Windows 未能测：会话无提问工具，弹不出卡（F5） |
| 11 | D | 原位置丰富上下文用量提示 | 已实现待验收 | 通过（见 D 证据） | Tooltip Electron 通过 | Windows 通过；重启后需发一句话才显示，待定性（F7e） |
| 12 | E | 底部跟随与快速输出滚动 | 已实现待验收 | 通过（见 E 证据） | Electron 真实滚轮/批量输出通过；完整 GUI 待验 | Windows 通过；输入框增高有限（F7f） |
| 9 | C | diff 设置与展开体验 | 已实现待验收 | 通过（见 C 证据） | SDK Edit/真实 DOM 通过；GUI 待验 | Windows 部分：仅单栏 patch，无双栏对比（F6） |

- [x] 读取规范、相关计划，核对起点及他人改动（仅未跟踪截图）。
- [x] A 实施、串行验证、[证据](evidence/batch-a.md)、独立提交（提交号见 git log）。
- [x] B 实施、串行验证、[证据](evidence/batch-b.md)、独立提交；含恢复后过期红框。
- [x] C 实施、串行验证、[证据](evidence/batch-c.md)、独立提交。
- [x] D 追加上下文详情、验证、[独立证据](evidence/batch-d-context.md)和提交。
- [x] E 追加底部跟随、串行验证、[证据](evidence/batch-e-scroll.md)，随最终修正提交。
- [x] 汇总十项及追加项状态与[最小现场验证清单](现场验收清单.md)。

## 追加 F：多工作目录可观察性与死代码清理（2026-09-09）

起因：用户提出「窗口可同时运行不同工作目录的会话」是否有副作用。查实后确认隔离本身没有功能缺陷，真正代价是**非 active 目录的变更完全不可见**——git 状态轮询与 rail 变更点都只跟 active session。顺带查出旧 shell 遗留的一批不可达代码。

| 编号 | 任务 | 实现 | 自动化 | GUI | Windows/加密机 |
|---|---|---|---|---|---|
| 13 | 侧栏目录行显示未提交变更量（复活旧 WorktreePanel 能力，展示按现行 design-system 重做） | 已实现待验收 `4081271f` | 通过（folderDiffStats 14 项） | 待验 | 未验收；加密机受 F3 影响将恒为空，降级为不渲染 |
| 14 | 清理旧 GitView 及其专属组件、全局 git 状态镜像、DiffViewer 永不触发的自动跳转、零引用 hook 与四条无调用方的 git IPC | 已实现待验收 `b75d3e7b` `31ce7705` `253faff1` `88aed3c0` | 通过（全量回归无回退） | 行为零变更，待验 | 未验收 |
| 15 | F2 修复：cwd 缺失校验、已消失目录可删除、临时工作区按原路重建 | 已实现待验收 `dbead94b` | 通过（tempWorkspaceRecovery 9 项 + PiWorkerProcess 5 项） | 待验 | 交回项，待现场复验 |

- [x] 13：数据走已有 `worktreeActivity.diffStats`，不新增 IPC；沿用旧版「只给有会话在跑的目录取、10 秒一次、失焦即停」的拉取策略，并补一次转空闲时的收尾读数。
- [x] 14：四批删除累计约 −1330 行，每批 tsc/vitest/biome 全绿后独立提交。
- [x] 15：三处根因分别修复，详见 [runtime-evolution 看板](../runtime-evolution/TODO.md#windows-交回缺陷2026-09-09linux-侧) F2 行。
- [ ] 13/14/15 的 GUI 与 Windows 现场验收；未验收前不标 Done。

## 提交与最终复查

- A：`8f4b72b0`；B：`7f114608`；C：`9c4ea0e2`；D：`20da96e4`。
- [最终复查](evidence/final-review.md) 随独立修正提交落地（提交号见 git log）。
- 所有产品任务：已实现、分批自动化通过；完整 GUI 与 Windows/加密机未验收，没有标 Done。
