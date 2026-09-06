# Evidence — R01 借用用户 `~/.pi` 的技能与模板

**日期**：2026-09-06
**关闭**：roadmap R01
**决定**：[D01](../decisions/001-borrow-user-pi-resources-not-symlink.md)

## 一、问题与取证

托管模式下 `PI_CODING_AGENT_DIR` 指向 `~/.pilab/pi-agent`，用户装在 `~/.pi/agent/` 下的
技能与模板一律不加载，**而且没有任何提示**。官方文档和模型的既有知识都指向 `~/.pi`，
所以照做的人最容易撞上。

探针 `src/agent-host/spikes/project-trust-resource-probe.ts`，隔离的临时 cwd + agentDir：

| | 项目 settings | 项目技能 | 项目模板 |
|---|---|---|---|
| `projectTrusted: true` | `{"theme":"light"}` | 加载 | 加载 |
| `projectTrusted: false` | **`{}`** | **消失** | **消失** |
| **`false` + 借用** | `{}` | **用户 `.pi` 的出现了** | **用户 `.pi` 的出现了** |

settings 那一半在源码里也是确定的（`core/settings-manager.js:188`：
scope 为 `"project"` 且不信任时直接 `return {}`）。

**探针第三条走的是本片新增的模块**，不是字面量路径——
所以它证明的是「我们的代码产出的路径被真实 SDK 接受」，而不只是 SDK 支持这个参数。

## 二、两个顺带撞出来的事实

**技能有第四个来源，绕过一切隔离。** `core/package-manager.js:1976`：

```js
const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
```

用的是 `getHomeDir()` 而不是 agentDir，所以 `~/.agents/skills` **不受任何模式影响**。
探针在临时 agentDir 下仍拉出开发机上的六个技能，路径全部指向那里。
这是 agentskills.io 的跨 agent 标准位置，R04 会把它写成推荐位。

**信任一个仓库等于允许它自动 npm install。** 探针第一版在项目配置里写了个
`packages` 声明，pi 真的去装了：

```
npm install project-only-package --prefix /tmp/.../.pi/npm failed with code 1
```

这是 `projectTrusted: 0` 的实质理由，也是 R01 **只借资源目录、绝不借 settings.json**
的硬约束。

## 三、实现

**一个值同时承担开关和目标。** Main 决定要不要借（它是知道凭据模式和用户设置的那一侧），
只有答案是「借」时才发路径。没有第二种状态，旧 Main 构建什么都不发也落在保守的那一侧。

| 层 | 改动 |
|---|---|
| `shared/piModelConfig.ts` | 新常量 `PI_BORROW_RESOURCES_DIR_ENV`、`PI_BORROW_USER_RESOURCES_SETTING_KEY` |
| `main/services/piModelConfig/index.ts` | `resolveBorrowUserPiResources()`；`resolveManagedPiWorkerEnv` 发路径 |
| `agent-host/worker.ts` | 读环境变量 |
| `agent-host/piWorkerRpcServer.ts` | 进程级选项，传给每个会话 |
| `agent-host/piWorkerSession.ts` | 传给 bootstrap |
| `agent-host/userResourcePaths.ts` | **新增**：解析两个子目录 + 存在性检查 + 同目录守卫 |
| `agent-host/piAgentSessionBootstrap.ts` | 接到 `resourceLoaderOptions` |

**四个承重的细节**：

1. **只借资源，绝不进 `additionalExtensionPaths`**。技能与模板是进上下文的文本，
   插件是代码；而且用户那份权限系统（31.0.0）会和我们打了补丁的 27.0.1 冲突。
   这条有专门的断言守着。
2. **`unbound` 不撤销借用**。项目信任被 `unbound` 撤销，是因为那关系到「克隆来的仓库
   能配置什么」；借用关系到「这个用户给自己装了什么」，与临时目录无关。
3. **同目录守卫在 worker 侧也有一份**。非托管模式下 agentDir 就是用户的，
   借了会把每个技能加载两次。Main 已经不发，但模块自己也挡——它因此能被单独信任。
4. **PTY 环境剔除这个变量**。TUI 跑的是真 pi 命令行，不读我们的环境变量；
   留着会宣称一个没发生的借用。代价是 TUI 下借用不生效，登记为
   [Q-R4](../open-questions.md)。

**默认开。** 这个功能存在的场景就是「用户不知道自己装错了地方」，
默认关等于让不知道的人继续不知道。

## 四、门禁

| 项 | 结果 |
|---|---|
| `pnpm test`（全仓） | **281 files / 4262 tests pass** |
| `pnpm typecheck` | pass |
| `npx biome check src/` | 干净（`--write` 修了两处格式） |
| `git diff --check` | 干净 |

280 → 281 files，4246 → 4262 tests：新增 16 条
（`userResourcePaths` 8、`piWorkerEnv` 5、`piAgentSessionBootstrap` 3）。
**没有改写任何既有断言。**

## 五、变异验证

| 变异 | 结果 |
|---|---|
| bootstrap 不把借用路径接进 `resourceLoaderOptions` | `1 failed \| 9 passed` |
| Main 不发环境变量 | `2 failed \| 6 passed` |
| 去掉「同目录不借」守卫 | `2 failed \| 6 passed` |

三处各自判红，恢复后全绿。

## 六、欠项

- **真机端到端未验**。探针证明了 SDK 侧和我们的路径产出，但「在真实客户端里放一个技能
  到 `~/.pi/agent/skills`，开会话后看见它」需要 R02-a 的命令目录查询才能观察到。
  R02-a 落地后补。
- ~~**设置项没有界面**。~~ 已由 [R04 资源设置页](./2026-09-06-r04-resource-settings.md)
  于 2026-09-06 关闭：开关可见、可改，并走 Main-owned setting。
- **TUI 下不生效**，见 [Q-R4](../open-questions.md)。
