# Roadmap — pi 资源接入与斜杠命令

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 切片划分、逐片验收标准与门禁见 [execution-plan](./topics/execution-plan.md)；
> 本文件只维护任务身份与状态。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 6 | **R04：资源设置与模板目录入口**（2026-09-06，[evidence](./evidence/2026-09-06-r04-resource-settings.md)）；**R03：三个插件随包（实收两个）**（2026-09-06，[evidence](./evidence/2026-09-06-r03-bundled-plugins.md)）；**R02-c：补全浮层与发送前拦截**（2026-09-06，[evidence](./evidence/2026-09-06-r02c-slash-menu.md)）；**R02-a / R02-b：命令目录（worker → Main）**（[evidence](./evidence/2026-09-06-r02ab-command-inventory.md)）；**R01：借用用户 `~/.pi` 的技能与模板**（[evidence](./evidence/2026-09-06-r01-borrow-user-pi-resources.md)） |
| In Progress | 0 | — |
| Next | 0 | — |
| Deferred | 0 | — |

**执行顺序**（用户 2026-09-06 拍板）：

```text
R01 借用用户 ~/.pi 资源
→ R02 斜杠命令（R02-a worker 目录 → R02-b Main 缓存 → R02-c 渲染层）
→ R03 三个插件随包
→ R04 模板安装入口
```

R01 排在最前的理由：改动最小、收益立刻可感，而且它**改变 R02 命令目录的内容**——
先接进来，补全菜单第一次出现时就是完整的。

## 任务

### R01 — 借用用户 `~/.pi` 的技能与模板 · **Done**（2026-09-06）

托管模式下把用户自己的 pi 资源目录作为额外路径传给资源加载器。
只借技能与模板，不借插件（[D01](./decisions/001-borrow-user-pi-resources-not-symlink.md)）。

落地形态与实测见 [evidence](./evidence/2026-09-06-r01-borrow-user-pi-resources.md)。
开关走**环境变量**而非 bootstrap 载荷——它是进程级事实，与 `projectTrusted` 同一条路；
一个值同时承担开关和目标，没有「开了但没路径」这种状态。

**后续边界**：真机技能展开仍可继续扩大点验；设置开关已由
[R04](./evidence/2026-09-06-r04-resource-settings.md) 补齐；TUI 下借用仍不生效
（[Q-R4](./open-questions.md)）。

### R02 — 斜杠命令

| 片 | 归属 | 状态 |
|---|---|---|
| R02-a | worker | **Done**：`commandInventory.ts` 从三处取（`getCommands()` 只在扩展上下文上，不在 session 上） |
| R02-b | Main | **Done**：`getSlashCommands()` + IPC。**不缓存**——RPC 是进程内消息，缓存只会让新装的技能一直藏着 |
| R02-c | 渲染层 | **Done**：补全浮层 + 发送前拦截 + 四条内置命令。`/` 与 `@` 触发条件不同——只在消息开头，且**不需要工作目录**（起始屏正是要打 `/new` 的地方） |

内置命令：`/new`、`/settings`、`/archive`、`/compact`
（[D02](./decisions/002-builtin-slash-commands-only-where-no-control-exists.md)）。

### R03 — 三个插件随包附带 · **Done**（2026-09-06）

`@juicesharp/rpiv-ask-user-question`（408K）、`@gotgenes/pi-subagents`（~2.8M）随包；
`pi-workspace-history`（168K）**未随包**——上游 `peer ^0.84.4` 与我们锁的
`0.84.3` 冲突，npm 三种 `overrides` 写法全部拒绝（[Q-R5](./open-questions.md)）。

问答卡关闭 UI 计划的
[Q14](../pix-ui-alignment/open-questions.md)——渲染层有完整消费链却从来没有生产者。

子代理**必须用 `@gotgenes` 那版**：`tintinweb` 版不发生命周期事件，
其子代理绕过权限审批（[execution-plan §四](./topics/execution-plan.md)）。

落地形态与实测见 [evidence](./evidence/2026-09-06-r03-bundled-plugins.md)。

### R04 — 提示词模板安装入口 · **Done**（2026-09-06）

设置新增 Resources / 资源页，说明共享技能、个人 Pi、本应用 managed Pi 三个位置；
`~/.agents/skills/` 是推荐位。页面补齐 R01 的借用开关，并通过 Main-owned setting
防止 renderer 整对象保存回滚。

「打开模板目录」打开当前凭据模式实际使用的 `<agentDir>/prompts`；Main 负责解析路径、
创建目录并调用 `shell.openPath`。落地与 GUI 点验见
[evidence](./evidence/2026-09-06-r04-resource-settings.md)。

## 关联的既有决定

- [D06（UI 计划）](../pix-ui-alignment/decisions/006-plugin-inventory-source.md)——
  插件清单由 worker 上报实际加载了什么，不在 Main 重实现 pi 的解析。本计划沿用。
- [D10（UI 计划）](../pix-ui-alignment/decisions/010-user-configured-gate-explicit-degradation.md)
  决定三——用户自己装了权限插件就由他自己去 pi TUI 设置里改。
  R01 的「不借插件」与这条同向。
