# 决策 045：Windows 默认不开 ACL 沙箱；打开时预检 WRITE_OWNER，不满足就退回并提示（回答 Q005，请重点审批）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-6 方案 §5 D6](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[Q005](../open-questions.md)、[P0-4 证据](../evidence/p0-4-windows-ci-2026-09-26.md)。

## 规则

1. Windows 默认不开 `sandbox-windows-acl`，也不做预检（与[决策 044](044-dsh-sandbox-off-by-default-in-p1.md) 一致）。
2. 以后用户打开沙箱开关时，在打开工作区时预检 WRITE_OWNER。不满足的会话退回 `danger-full-access`，并提示用户。不拒绝会话，也不改工作区的 ACL。
3. 加密目录上 ACL 沙箱开启时（F-on-acl）的结论，仍归 P1-13 上机。

## 取舍

- 不选「默认开，不预检」：P0-4 已经证明，工作区只有 Modify 权限时，沙箱下的 pwsh 全部失败，也不会退回无沙箱运行。
- 不选「默认开加预检，不满足就拒绝会话」：`C:\work`、IT 只给 Modify 的共享目录会直接不可用。
- ACL 授权会永久改动工作区权限：常驻 ACE、Low 完整性标签、沿树继承，手工撤不掉。默认开的代价太大。
- 代价：Windows 上没有沙箱兜底，与 1.0.x 相同。
