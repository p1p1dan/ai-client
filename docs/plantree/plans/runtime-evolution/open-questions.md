# 未决问题

Role: open-questions；只维护尚需回答的问题，任务执行状态统一见[核心任务树](README.md)。
旧 Q1～Q7 的决策映射保存在[整理前快照](history/2026-09-10-status-before-consolidation.md)，Q7 判错修复不代表 F3 已修复。

| 问题 | 当前证据 / 需要明确的内容 | 关联节点 |
|---|---|---|
| F3 的实际故障机制与启动方案 | 同一仓库独立 Git 正常、Electron 启动 Git 输出异常；test.11 有密文读取差分，test.12 R2/R3 没有隔离驱动放行规则。需对照实际 Main→Git 链，不能从文件可读直接推定 Git stdout 原因 | P4-6 / GUI 13 |
| F2-b 删除范围与列表归属 | 当前恢复流程通过，旧 TEMP 异常未定性；需三个时点索引/目录与实际删除入口 | GUI 4/15 |
| TUI-1 与原验收标准冲突 | 方案 C 已明确，但 ARD §7.6 原要求 native GUI/TUI 一致；是调整本期成功标准还是另补互通能力，不能由整理文档代为决定 | P4-6 / P6-3 |

功能/取证细节：[现场问题说明](topics/field-followups.md)、[F3/F4/F5 决策](../../../plans/2026-09-09-gui-defect-decisions.md)。
