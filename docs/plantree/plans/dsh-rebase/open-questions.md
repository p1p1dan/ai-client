# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

## Q001 进程拓扑：共享宿主还是一会话一宿主

- 依据：P0-1 实测数据（单宿主空载常驻内存、每多一个会话的增量、冷 / 热启动时间），与我方现有 worker 同机同口径对比。
- 待定判据：一会话一宿主的额外内存与启动时延是否在可接受范围；共享宿主时崩溃后自动重启 + 会话恢复是否可靠。
- 默认倾向：共享宿主（[决策 001](decisions/001-route-b-and-scope.md) 第 4 条）。

## Q002 DSH 沙箱能否作为兜底层叠加

- 依据：P0-4 加密机上机，`sandbox-windows-acl` 开 / 关各测一次 read / write / edit / grep / glob 与 bash、pwsh 子进程读写。
- 通过则 P1 / P2 叠加在我方审批之下；不通过则 Windows 上关闭沙箱。Linux / macOS 的 bwrap / landlock 另议。

## Q003 切换后内嵌终端跑什么

- DSH 官方没有 TUI。候选：社区 `@deepseek-harness-tui/dsh-tui`（需过白名单审查），或内嵌终端不再提供 agent 界面、只当普通终端。
- P2 默认切换前定。

## Q004 DSH 版本钉在哪个通道

- npm `latest` 落后（2026-09-25 查 `@deepseek-ai/dsh-base` 的 `latest` 为 `0.0.1-rc.1`，调研时 `@deepseek-ai/dsh` 的 `next` 为 `0.1.7-rc.2`）。P0 先钉 `next` 的具体版本号；升级节奏在 P2 定。
