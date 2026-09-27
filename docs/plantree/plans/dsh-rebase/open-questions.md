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

- 2026-09-26 P0-5 建议（待用户确认后记为决策）：P1 钉 `next` 的精确版本（目前 `0.1.7-rc.2`），不追每个 rc；升级作为单独任务，重跑 P0 回归并复核白名单插件的 peer。见 [P0-5 收口](evidence/p0-5-closeout-2026-09-26.md#未决问题的处置)。

## Q005 Windows 上 ACL 沙箱默认开不开、工作区权限不够时怎么办

- 依据：[P0-4 普通 Windows CI 证据](evidence/p0-4-windows-ci-2026-09-26.md)。`sandbox-windows-acl` 授权时要同时改 DACL 并写 Low 完整性标签，后者需要 WRITE_OWNER。标准用户在 `C:\` 根下自建的目录、IT 只给 Modify 的共享目录都不满足，沙箱下的 pwsh 每次都失败，并且不会退回无沙箱运行。用户目录和管理员不受影响。
- 另一个代价：沙箱会永久改工作区权限（常驻 ACE、Low 标签、Everyone 拒绝删除子项，沿目录树继承），大目录首次授权可能要几分钟。
- 待定：P1 默认开不开沙箱；是否预检 WRITE_OWNER；不满足时是提示用户、改用 danger-full-access 加我方审批，还是拒绝。与 [Q002](#q002-dsh-沙箱能否作为兜底层叠加)（加密机上能否叠加）一起在 P1 设计权限移植时定，加密机上的 F-on-acl 在 P2 前上机时补看。

## Q006 Claude 模型是否另加 Claude Agent SDK 引擎

- 起因：2026-09-26 用户反馈，v1.0.3 下 Claude「工具调用不太智能，表现不如在 Claude Code 中使用」。用户已实测排除思考强度，认为主要差距在提示词、可调用工具与内置工具。
- 调研：[Claude SDK 引擎调研](../../../plans/2026-09-26-claude-sdk-engine-study.md)。
  - 能加回来：旧版是 SDK + 第三方 Cometix（Node 版 Claude Code），跑在随包 node.exe 上，曾过加密机。
  - 最小可用约 5～7 人周，与 v1.0.3 对等约 10～15 人周。
  - 每平台安装包约 +55～75 MB（推算）。
  - 有第三方重打包与许可风险。
- 三条路线驾驭层的接近程度（推断，未抓真实请求）：SDK = Claude Code 原样 > DSH（带行号读取、先读后改、todo、计划模式、提醒，但为 DeepSeek 调校）> 自有 runtime。DSH 的提示词与工具由插件提供，可以做「Claude 专用配置」插件来逼近，但不能照抄 Claude Code 的提示词。
- 进行中：用户在自己的 Windows 机上用官方 DSH Desktop + 自家网关 Claude 试效果，结果回来再定加不加 SDK 引擎。
- 影响：加的话会出现阶段性三引擎；「按会话选引擎」接缝与 P1 共用。
