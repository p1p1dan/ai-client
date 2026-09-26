# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

Q001（进程拓扑）已于 2026-09-26 定为共享宿主，见[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)；补验是 roadmap P0-6。

## Q002 DSH 沙箱能否作为兜底层叠加

- 裁决时点：P2 默认切换前的加密机关（[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md) 把它移出了 P0）。普通 Windows 上沙箱开关能否正常工作由 P0-4 的 CI 实测回答，但那不能代替加密机的结论。
- 依据：加密机上机，`sandbox-windows-acl` 开 / 关各测一次 read / write / edit / grep / glob 与 bash、pwsh 子进程读写。
- 通过则 P1 / P2 叠加在我方审批之下；不通过则 Windows 上关闭沙箱。Linux / macOS 的 bwrap / landlock 另议。

## Q003 切换后内嵌终端跑什么

- DSH 官方没有 TUI。候选：社区 `@deepseek-harness-tui/dsh-tui`（需过白名单审查），或内嵌终端不再提供 agent 界面、只当普通终端。
- P2 默认切换前定。

## Q004 DSH 版本钉在哪个通道

- npm `latest` 落后（2026-09-25 查 `@deepseek-ai/dsh-base` 的 `latest` 为 `0.0.1-rc.1`，调研时 `@deepseek-ai/dsh` 的 `next` 为 `0.1.7-rc.2`）。P0 先钉 `next` 的具体版本号；升级节奏在 P2 定。
- P0-2 实测（[证据](evidence/p0-2-goal-and-plugins-2026-09-25.md)）：社区目录下载量前 150 的插件里，有 9 个把 DSH peer 精确钉在旧 rc 上（例如 `0.1.7-rc.1`），按 DSH 的准入规则在 0.1.7-rc.2 上会被拒绝。也就是说，DSH 每升一个 rc，都会让一批白名单插件失效。定升级节奏时，要连同白名单插件的复核一起算进去。
