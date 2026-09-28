# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

Q001（进程拓扑）已于 2026-09-26 定为共享宿主，见[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)；补验是 roadmap P0-6。

## Q002 DSH 沙箱能否作为兜底层叠加

- 裁决时点：合入 main 前的加密机关 P1-13（决策 004 把「P2 前」改为「合入前」；[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md) 把它移出了 P0）。普通 Windows 上沙箱开关能否正常工作由 P0-4 的 CI 实测回答，但那不能代替加密机的结论。
- 依据：加密机上机，`sandbox-windows-acl` 开 / 关各测一次 read / write / edit / grep / glob 与 bash、pwsh 子进程读写。
- 通过则叠加在我方审批之下；不通过则 Windows 上关闭沙箱。Linux / macOS 的 bwrap / landlock 另议。
- 2026-09-27：[决策 044](decisions/044-dsh-sandbox-off-by-default-in-p1.md)（待审批）把 P1 期间的默认值定为三平台都关，叠加能力放在开关后面。本问题照旧在 P1-13 裁决。

Q003（内嵌终端）已于 2026-09-28 裁决：去掉 pi TUI 与 GUI / TUI 开关，原位置加一个普通终端按钮，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q004（版本通道）已于 2026-09-26 定为钉 `next` 的精确版本 `0.1.7-rc.2`，见[决策 003](decisions/003-p0-closeout-enter-p1.md)。

## Q005 Windows 上 ACL 沙箱默认开不开、工作区权限不够时怎么办

- 依据：[P0-4 普通 Windows CI 证据](evidence/p0-4-windows-ci-2026-09-26.md)。`sandbox-windows-acl` 授权时要同时改 DACL 并写 Low 完整性标签，后者需要 WRITE_OWNER。标准用户在 `C:\` 根下自建的目录、IT 只给 Modify 的共享目录都不满足，沙箱下的 pwsh 每次都失败，并且不会退回无沙箱运行。用户目录和管理员不受影响。
- 另一个代价：沙箱会永久改工作区权限（常驻 ACE、Low 标签、Everyone 拒绝删除子项，沿目录树继承），大目录首次授权可能要几分钟。
- **2026-09-27 建议已落为[决策 045](decisions/045-windows-acl-sandbox-default-off.md)（待用户审批）**：Windows 默认不开，也不预检；以后打开时预检 WRITE_OWNER，不满足就退回并提示。用户批准后，本问题只剩加密机上的 F-on-acl，归 P1-13。
- 原待定项：P1 默认开不开沙箱；是否预检 WRITE_OWNER；不满足时是提示用户、改用 danger-full-access 加我方审批，还是拒绝。与 [Q002](#q002-dsh-沙箱能否作为兜底层叠加)（加密机上能否叠加）一起在 P1 设计权限移植时定，加密机上的 F-on-acl 在 P2 前上机时补看。

Q006（是否另加 Claude SDK 引擎）已于 2026-09-26 定为暂不加，见[决策 003](decisions/003-p0-closeout-enter-p1.md)；调研留在 [Claude SDK 引擎调研](../../../plans/2026-09-26-claude-sdk-engine-study.md)。

Q007（libvips 许可）已于 2026-09-28 裁决：完全内部使用，直接随包，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q008（布局原型）已于 2026-09-28 裁决：待办、目标两条保留；后台与子代理改为浮动 / 嵌入子窗口，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q009（加密策略缺口）已于 2026-09-28 裁决：产品自己绕开，node 读到密文时改用 Windows PowerShell 5.1 回读（P1-13c）；写入维持 DSH 的做法，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

Q010（普通权限补测）已于 2026-09-28 裁决：不需要，管理员与普通员工的权限表现一样，见[决策 090](decisions/090-user-rulings-2026-09-28.md)。

