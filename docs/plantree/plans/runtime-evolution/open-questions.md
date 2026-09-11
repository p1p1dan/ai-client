# 未决问题

Role: open-questions；只维护尚需回答的问题，任务执行状态统一见[核心任务树](README.md)。
旧 Q1～Q7 的决策映射保存在[整理前快照](history/2026-09-10-status-before-consolidation.md)，Q7 判错修复不代表 F3 已修复。

| 问题 | 当前证据 / 需要明确的内容 | 关联节点 |
|---|---|---|
| F3 的实际故障机制与启动方案 | 同一仓库独立 Git 正常、Electron 启动 Git 输出异常。用户 2026-09-10 确认 Node 与 Git 在企业白名单内，因此不是被拦；剩下的是 Main→Git 这条启动链本身为什么丢 stdout，改在开发机对照复现 | P4-6 / GUI 13 |
| F2-b 删除范围与列表归属 | 当前恢复流程通过，旧 TEMP 异常未定性；需三个时点索引/目录与实际删除入口 | GUI 4/15 |
| H / 17 是否已覆盖 P5-5 模型目录切源 | 用户自加服务本质上就是给模型目录换源，两者可能重叠。P5-5 在任务树里只有一行标题，没有范围定义；开工前需先确定 P5-5 还剩什么，避免重复实现或漏做 | H / 17 / P5-5 |

已于 2026-09-10 关闭：

- **老用户迁移的默认程度**：用户选「首启一键确认」——弹一次对话框、五项默认全勾、一个开始按钮。完全静默被否的理由是 API key 属于同意边界，不该静默吸进本应用 vault。见 [H / 21](topics/external-agent-migration.md#决策一2026-09-10-已定老用户首启一键确认)。
- **Claude / Codex 迁移做到哪一层**：用户决定**只做对话导入、不做配置迁移**，且要求可看可续聊、工具调用不重要。我提过「配置迁移对新用户留存杠杆更大」的不同意见，用户不认同，按用户决定执行。施工计划见[对话导入](topics/conversation-import.md)。
- **用户自装插件与权限系统的冲突**：用户决定由用户自己负责。机制上本就不是静默撞车——`permissionPlugin.ts:473` 判定用户已配置权限系统时返回 `user_configured` / `gated: true`，主动让路用他那份；两份都没有才 `gated: false` 并在启动时抛 `PermissionGateUnavailableError`。落地只需界面如实显示当前审批用的是哪一份，见 [H / 19](topics/unified-agent-directory.md)。
- **统一 agent 目录后用户终端里的 `pi` 如何找到会话**：用户决定不管。范围收窄为「保证本应用内的 GUI 与 TUI 能找到历史对话」，官方 pi 的支持等其后续版本。
- **TUI-1 与原验收标准的范围冲突**：用户当日推翻方案 C、要求恢复 GUI/TUI 互通，ARD 成功标准 6 维持原样，冲突消解；可行性已实测，落地见 [H / 20](topics/gui-tui-session-interop.md)。

功能/取证细节：[现场问题说明](topics/field-followups.md)、[F3/F4/F5 决策](../../../plans/2026-09-09-gui-defect-decisions.md)。
