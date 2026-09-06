# Plan — pi 资源接入与斜杠命令

> **状态**：Completed —— R01–R04 已于 2026-09-06 全部落地；后续候选只留在 open questions。
>
> **范围**：pi 生态资源（插件 / 技能 / 提示词模板 / 斜杠命令）在本客户端里的**可见性与可用性**。
> 与 [UI 对齐计划](../pix-ui-alignment/README.md) 是两回事：那个管界面形态，这个管
> 「用户装的东西在这里到底生不生效、看不看得见」。
>
> **关闭状态与后续候选**：[roadmap.md](./roadmap.md) / [open-questions.md](./open-questions.md)。
> **执行形态**：[execution-plan](./topics/execution-plan.md) —— 切片、验收标准与门禁。
>
> **拍板记录**（用户 2026-09-06）：新建独立计划；执行顺序 R01 → R02 → R03 → R04；
> 内置斜杠命令四条（`new` / `settings` / `archive` / `compact`）——
> 用户砍掉了 `/permission`，理由是底栏已有控件，`/model` 同理砍掉。

## 开工时的问题（已关闭）

**托管模式下我们用自己的 pi 配置目录，用户装在 `~/.pi` 下的东西一律不生效。**

以下是开工时的切换点；R01/R04 已在同一服务上补上借用与可见设置入口：

```ts
export function resolveManagedPiWorkerEnv(): Record<string, string> {
  const managed = resolveManagedCredentialsEnabled();
  return {
    [PI_PROJECT_TRUST_ENV]: managed ? '0' : '1',
    ...(managed ? { PI_CODING_AGENT_DIR: getManagedPiAgentDir() } : {}),
  };
}
```

配置目录指向 `~/.pilab/pi-agent`，项目信任关闭。紧接着一行
`resolveManagedPiPtyEnv() { return resolveManagedPiWorkerEnv(); }`——
**TUI 和 GUI 用同一份环境**，不是两套。

用户的判断（2026-09-06）：「用户或者用户使用 AI 辅助大概率会安装到 `~/.pi` 下，
这个我们也得考虑到」。官方文档和模型的既有知识都指向那里，
照做的人会发现东西装了但看不见，**而且没有任何提示**。

## 目标

1. 用户按官方文档装到 `~/.pi` 的技能和模板，在这里直接可用（R01）
2. 输入框打 `/` 能看见有哪些命令，并知道每条从哪来（R02）
3. 三个补齐产品缺口的插件随包附带（R03）
4. 提示词模板有一个能找到的安装位置（R04）

## 非目标

- **不做 `~/.pi` → `~/.pilab` 的软链接**。理由见 [D01](./decisions/001-borrow-user-pi-resources-not-symlink.md)。
- **不重实现 pi 的资源解析**。沿用 [D06](../pix-ui-alignment/decisions/006-plugin-inventory-source.md)
  的既有结论：pi 拥有解析，我们只问它加载了什么。
- **不为凑齐参考实现的命令表去补功能**。pix 有 15 条内置命令，我们只接已有界面动作的那几条。

## 取证基线

本计划的事实来自一支探针和若干源码定位，**不是读文档推的**：

- 探针 `src/agent-host/spikes/project-trust-resource-probe.ts`（2026-09-06 新建）
- 参考仓冻结版本沿用 UI 计划的表：pix `da01b3e`、pi-app `c5ad2f4`
- pi SDK `@earendil-works/pi-coding-agent@0.84.3`（`src/agent-host/package.json` 锁定）

关键实测结论见 [execution-plan §一](./topics/execution-plan.md)。

## 文件图

| 文件 | 角色 |
|---|---|
| [roadmap.md](./roadmap.md) | 任务 ID、状态、顺序的**唯一权威** |
| [topics/execution-plan.md](./topics/execution-plan.md) | 切片划分、逐片验收、门禁、取证结论 |
| [decisions/](./decisions/) | 稳定决定与边界 |
| [open-questions.md](./open-questions.md) | 仅未解决的问题 |
| [evidence/](./evidence/) | 落地证据（实际命令与数字） |

## 阅读路径

1. 本文件
2. [roadmap](./roadmap.md) —— 当前在哪一片
3. [execution-plan](./topics/execution-plan.md) —— 那一片要做什么、怎么验
4. 只读当前任务直接链接的 decision 与 evidence
