# 决策 075：宿主死后，由 Main 的 supervisor 停掉旧宿主留下的 systemd scope（Linux 桌面）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：P1-3c 集成测试的新发现、[P1-3a 证据](../evidence/p1-3a-shared-host-2026-09-27.md)。

## 事实

桌面 Linux 上有 systemd user bus 时，DSH 把工具进程装进 `dsh-subprocess-<宿主pid>-*.scope`。宿主被 SIGKILL 后，这些 scope 里的工具进程会一直跑到自己结束（实测约 20 s）。P1-3a 的「2 s 内没有孤儿工具进程」，是在没有 user bus、走回退收容时测到的。集成测试现在按收容模式分别断言。

## 规则

1. 宿主崩溃、被强杀或卡死判定之后，Main 的 supervisor 在拉起新宿主之前，停掉旧宿主 pid 对应的 `dsh-subprocess-<旧pid>-*.scope`，用 `systemctl --user stop`，只按确切的旧 pid 匹配。
2. 只在有 systemd user bus 时执行；没有时，回退收容本来就会随宿主一起回收。
3. 在 P1-3d 实现，并补集成测试断言「宿主被杀后，scope 内的工具进程在 N 秒内消失」。

## 取舍

- 不选「交给新宿主启动时清理」：新宿主不知道旧宿主的 pid，按前缀清理有误杀的风险，比如第二个应用实例。
- 不选「不管，等工具自己结束」：长时间运行的工具（比如 `sleep`、构建）会一直占着工作区和资源，用户看不见也停不掉。
- 代价：多一次 `systemctl` 调用，要处理 systemctl 不存在或调用失败的情况，失败只写日志。

## 实施补记（2026-09-27，P1-3d `b3b58f2b`，待用户审批）

- 只用 `systemctl --user stop` 不够：被杀宿主留下的 bash 工具熬过 5 s 超时仍在；自建一个忽略 SIGTERM 的 scope 也会让 stop 等满超时。改用 DSH 自己宿主退出时的做法：先 `systemctl --user kill --kill-whom=all --signal=SIGKILL <确切单元名>`，再 `stop`。自建 scope 15 ms 内清掉。
- 除 `dsh-subprocess-<pid>-*.scope` 外，另外覆盖 `dsh-terminal-<pid>-*.scope`。
- 只在「就绪过的宿主异常退出」（信号或非 0 退出码）之后执行；新宿主最多为此等 6 s。
- 实测：宿主被杀后，scope 里的工具进程 1.7 s 内消失。代价是每次崩溃多一次 `systemctl list-units`，恢复时间从 0.82～0.86 s 变为约 1.0～1.4 s。
