# 决策 038：「key 不以明文落盘」的口径：DSH 路径零明文，`auth.json` 等 TUI 去留定了再停写（请重点审批）

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-5 方案 §5 D6](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、[分片 03](../topics/p1-5-models-and-credentials/03-design.md)。

## 规则

1. P1-5 的退出判据「key 不以明文落盘」，按 DSH 路径来算：
   - key 不写 `DSH_HOME`（包括 zstd 日志）、不进宿主环境和工具环境、不进模型上下文、不进会话日志和 stderr；
   - 用 KEY-CANARY 门禁扫一遍：`DSH_HOME`、宿主 stderr、`/proc/<宿主>/environ`、工具环境、临时目录，另加服务商错误回显 key 的场景；
   - 宿主收不到 key 的明文副本，只有按请求拉取的那一次（[决策 034](034-per-request-credential-pull.md)）。
2. 管理员 key 的缓存 `managed-models-source.json` 改为加密存储。
3. `pi-agent/auth.json` 继续明文写，权限 0600，这是 1.0.x 的现状，给内嵌 pi TUI 用。等 P1-11 定了 TUI 去留、P1-15 落地之后再停写，P1-12 收尾。

## 取舍

- 不选「P1-5 立刻停写 `auth.json`」：内嵌 TUI 马上就会失去模型访问，而 P1-11 之前 TUI 是旧会话唯一能续聊的地方（[决策 005](005-legacy-pi-sessions-read-only-until-p1-9.md)）。
- 代价：这段时间里 `auth.json` 仍是明文 0600，同一用户的进程都读得到，与 1.0.x 相同。

## 补记（2026-09-29，P1-15，[决策 125](125-p1-15-one-shot-completions-choices.md)）

第 3 条的两个前提之一已满足：P1-15 落地，一次性补全改在 DSH 宿主上跑，不再把含 key 的目录交给任何进程；原生补全在 Main 没交目录时会退回读 `auth.json`，这条路也随之不再走。现在读 `auth.json` 的只剩内嵌 pi TUI，停写只等 P1-11 定下 TUI 的去留。
