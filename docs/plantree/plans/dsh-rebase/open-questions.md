# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

## Q001 进程拓扑：共享宿主还是一会话一宿主

- 依据：P0-1 实测数据（单宿主空载常驻内存、每多一个会话的增量、冷 / 热启动时间），与我方现有 worker 同机同口径对比。
- 待定判据：一会话一宿主的额外内存与启动时延是否在可接受范围；共享宿主时崩溃后自动重启 + 会话恢复是否可靠。
- 默认倾向：共享宿主（[决策 001](decisions/001-route-b-and-scope.md) 第 4 条）。
- 2026-09-25 P0-1 实测（[证据](evidence/p0-1-host-probe-2026-09-25.md)，Linux 开发机，Node 24.18.0）：
  - DSH 宿主：空载 RSS 约 177 MB；每多一个空会话约 +1～3 MB；启动到 ready 约 0.74 s，磁盘冷约 0.95 s。
  - 我方 worker：约 94 MB，约 0.21 s。
  - 4 个会话时：共享宿主约 181 MB；一会话一宿主 735 MB；现状 4 个 worker 387 MB。
  - 探针建议：共享宿主。还需补验：崩溃重启后用 `agents.resume` 恢复会话；多会话并发回合时的事件循环延迟；带历史会话的内存。
  - 待用户裁决。

## Q002 DSH 沙箱能否作为兜底层叠加

- 依据：P0-4 加密机上机，`sandbox-windows-acl` 开 / 关各测一次 read / write / edit / grep / glob 与 bash、pwsh 子进程读写。
- 通过则 P1 / P2 叠加在我方审批之下；不通过则 Windows 上关闭沙箱。Linux / macOS 的 bwrap / landlock 另议。

## Q003 切换后内嵌终端跑什么

- DSH 官方没有 TUI。候选：社区 `@deepseek-harness-tui/dsh-tui`（需过白名单审查），或内嵌终端不再提供 agent 界面、只当普通终端。
- P2 默认切换前定。

## Q004 DSH 版本钉在哪个通道

- npm `latest` 落后（2026-09-25 查 `@deepseek-ai/dsh-base` 的 `latest` 为 `0.0.1-rc.1`，调研时 `@deepseek-ai/dsh` 的 `next` 为 `0.1.7-rc.2`）。P0 先钉 `next` 的具体版本号；升级节奏在 P2 定。
- P0-2 实测（[证据](evidence/p0-2-goal-and-plugins-2026-09-25.md)）：社区目录下载量前 150 的插件里，有 9 个把 DSH peer 精确钉在旧 rc 上（例如 `0.1.7-rc.1`），按 DSH 的准入规则在 0.1.7-rc.2 上会被拒绝。也就是说，DSH 每升一个 rc，都会让一批白名单插件失效。定升级节奏时，要连同白名单插件的复核一起算进去。
