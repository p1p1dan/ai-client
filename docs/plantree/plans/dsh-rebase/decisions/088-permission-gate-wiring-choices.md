# 决策 088：P1-6b 权限闸门接线的实现取舍

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：`262a240c`；[P1-6 方案](../topics/p1-6-permissions.md)；[决策 042](042-approval-in-pre-execute-plugin.md)～[045](045-windows-acl-sandbox-default-off.md)、[081](081-loop-guard-implementation-choices.md) 第 2 条。

## 规则

1. **播种提前做了一小块**：闸门直接用会话载荷里的档位（`permissions.mode/gear`、`tier`）构造，旧档位按 1.0.x 的规则迁移；策略只加载随包的表，不读用户和项目的策略文件；三个 setter 仍是空操作。
   - 方案把播种整体划给 P1-6c。
   - 提前做这一块，是为了让冒烟和探针能显式设 bypass。不然每条 bash 都要等满 120 s，卡片也会进录制流。随包策略表本来就是 1.0.x 始终加载的底线。
2. **只有权限行由 overlay 重申启用**：用户补丁如果把它关掉，会被悄悄改回，宿主照常启动，不报错。loop-guard 和 credentials 两行只检查、不重申。理由与决策 023 第 3 条相同：审批是底线，用户层改不掉。
3. **DSH 自带的 `permission` 行**也进了 `REQUIRED_DISABLED`，同样由 overlay 重申关闭，防止用户层再打开第二套档位入口。
4. **决策 044 与 045 由同一个字面值落地**：`sandbox-policy` 写成 `mode: danger-full-access`，`approval` 写成 `policy: ask`。
   - DSH 0.1.7-rc.2 没有单独的 Windows ACL 行，ACL 授权在 `sandbox` 行里，只在 `confine()` 时才写 ACE；`danger-full-access` 下根本不会调用它。
   - 所以 `sandbox` 行本身没有关掉。
5. **同一宿主里重复打开同一会话**：路由表拒绝第二次挂闸门，bridge 映射成 `session_locked`（可重试）。原来这个码由 DSH 的写锁报出。
6. **会话关闭时还挂着的卡片**：以 `session_closed` 收起，工具调用得到 `cancel`（即 ABORTED_BEFORE_DISPATCH），不是 `deny`。
7. **冒烟语义的变化**：沙箱关掉之后，APPROVAL 与 FDS 场景里原来的「越界升级」重试也改走我方闸门，各出两张卡。
8. **金样本全部重录**。DSH 的 `permission` 行关闭后，新会话不再写 `permission/preset`、`sandbox/mode`、`approval/policy` 这 3 条初始事件：日志的 seq 整体减 3，用户消息 id 从 `dsh-user-8` 变成 `dsh-user-5`，`fileTailEntryId` 变成 `null`。RuntimeEvent 的形状没有变化。`forkSeed.test.ts` 里依赖样本下标的断言随之减 3。

## 留给后续

- **P1-6b 剩余**：
  - `escalate_sandbox` 的 action id 与中英文案；
  - 提示词上下文 `aiclient:permission`，现在模型还看不到档位说明；
  - `perm-*` 录制场景。
- **P1-6c 全部**：
  - 授权记忆 sidecar；
  - 三个 setter 真正生效；
  - Main 传 `AICLIENT_PERMISSION_AGENT_DIR` 和用户、项目两级策略；
  - 沙箱映射钩子；
  - 集成测试「授权跨宿主重启仍生效」。

  「本会话允许」目前只在宿主进程活着时有效，宿主重启后会丢。
- **P1-6d**：pwsh 目前一律按「解析不出」处理，每条都会出卡。（2026-09-29 修订注记：已由 [决策 129](129-p1-6d-pwsh-analysis-choices.md) 解决，pwsh 有了自己的词法分析，读得懂的命令按档位判定。）
- **P1-4c / d**：`tool.completed` 对 PermissionDenial 和 ABORTED_BEFORE_DISPATCH 的映射，Stop 收卡后应该显示「未开始」；命令列表隐藏 `/plan`、`/permission`。
- **只过了 tsc、没有实跑的工具**：goal-probe、p0-6-probe、p0-4-probe 与其上机包、perm-experiments、rewind-experiments、measure。perm-experiments 的 raw 模式是按「权限行默认关」设计的，现在已经失去原来的意义。
