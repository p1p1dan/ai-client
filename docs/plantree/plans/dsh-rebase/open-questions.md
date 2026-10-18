# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

Q001（进程拓扑）已于 2026-09-26 定为共享宿主，见[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)；补验是 roadmap P0-6。

Q002（DSH 沙箱能否作为兜底层叠加）已于 2026-10-18 关闭：加密机上沙箱开、关两组读写结果一样，维持[决策 044](decisions/044-dsh-sandbox-off-by-default-in-p1.md)「默认关」，见[决策 193](decisions/193-user-rulings-2026-10-18.md) 第 25 条。

Q003（内嵌终端）已于 2026-09-28 裁决：去掉 pi TUI 与 GUI / TUI 开关，原位置加一个普通终端按钮，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q004（版本通道）已于 2026-09-26 定为钉 `next` 的精确版本 `0.1.7-rc.2`，见[决策 003](decisions/003-p0-closeout-enter-p1.md)。

Q005（Windows 上 ACL 沙箱默认开不开）已于 2026-10-18 关闭，由[决策 045](decisions/045-windows-acl-sandbox-default-off.md) 承接（默认不开、不预检），见[决策 193](decisions/193-user-rulings-2026-10-18.md) 第 25 条。

Q006（是否另加 Claude SDK 引擎）已于 2026-09-26 定为暂不加，见[决策 003](decisions/003-p0-closeout-enter-p1.md)；调研留在 [Claude SDK 引擎调研](../../../plans/2026-09-26-claude-sdk-engine-study.md)。

Q007（libvips 许可）已于 2026-09-28 裁决：完全内部使用，直接随包，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q008（布局原型）已于 2026-09-28 裁决：待办、目标两条保留；后台与子代理改为浮动 / 嵌入子窗口，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q009（加密策略缺口）已于 2026-09-28 裁决：产品自己绕开，node 读到密文时改用 Windows PowerShell 5.1 回读（P1-13c）；写入维持 DSH 的做法，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q010（普通权限补测）已于 2026-09-28 裁决：不需要，管理员与普通员工的权限表现一样，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

