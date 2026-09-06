# Execution Plan — pi 资源接入与斜杠命令

> 切片、逐片验收、门禁，以及本计划全部结论所依据的取证。
> 任务身份与状态看 [roadmap](../roadmap.md)。

## 一、取证基线

全部来自实跑，不是读文档推的。

### 1.1 托管模式挡掉了什么

探针 `src/agent-host/spikes/project-trust-resource-probe.ts`，
隔离的临时 cwd + agentDir（绝不读开发机自己的 `~/.pi`），三种情况各一次：

| | 项目 settings | 项目技能 | 项目模板 |
|---|---|---|---|
| `projectTrusted: true` | `{"theme":"light"}` | 加载 | 加载 |
| `projectTrusted: false`（托管模式） | **`{}`** | **消失** | **消失** |
| **`false` + 借用路径** | `{}` | **用户 `.pi` 的出现了** | **用户 `.pi` 的出现了** |

第三行是 R01 的地基：通过 `resourceLoaderOptions.additionalSkillPaths` /
`additionalPromptTemplatePaths` 传绝对路径能把用户资源接进来，
**同时不碰 `auth.json` / `models.json` / `settings.json`，项目信任仍然关着**。

settings 那一半在源码里也是确定的，`core/settings-manager.js:188`：

```js
static loadFromStorage(storage, scope, projectTrusted = true) {
    if (scope === "project" && !projectTrusted) {
        return {};   // 项目配置直接返回空，根本不读
    }
```

### 1.2 技能有四个来源，其中一个绕过一切隔离

`core/package-manager.js:1976`：

```js
const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
```

用的是 **`getHomeDir()`，不是 agentDir**。

| 来源 | 受项目信任控制 | 跟 agentDir 走 |
|---|---|---|
| `<cwd>/.pi/skills` | 是 | 否 |
| `<cwd> 及祖先>/.agents/skills` | 是 | 否 |
| `<agentDir>/skills` | 否 | 是 |
| **`~/.agents/skills`** | **否** | **否，跟 HOME** |

最后一行是 [agentskills.io](https://agentskills.io) 的跨 agent 标准位置，
**无论什么模式都加载**。探针在临时 agentDir 下仍然拉出了开发机上的六个技能，
路径全部指向 `~/.agents/skills/`。

**提示词模板没有对应的共享位置**，只有 `<cwd>/.pi/prompts` 和 `<agentDir>/prompts`。
这是 R04 存在的理由。

### 1.3 信任一个仓库等于允许它自动 npm install

探针第一版在项目配置里写了个 `packages` 声明，pi 真的去装了：

```
npm install project-only-package --prefix /tmp/.../.pi/npm failed with code 1
```

`projectTrusted: 0` 挡的是供应链，不是保守。**R01 不能借 settings.json**，
只借资源目录，这条是硬约束。

### 1.4 斜杠命令的执行链路已经通了

`src/agent-host/piWorkerSession.ts:811` 调 `session.prompt(text, options)`，
**没有传 `expandPromptTemplates`，而它默认为 `true`**
（`core/agent-session.d.ts:155`「Whether to dispatch extension commands and expand
skill commands and prompt templates (default: true)」）。

所以插件命令、技能、模板**现在就能执行**。技能的展开在
`core/agent-session.js:956` `_expandSkillCommand`：`/skill:名字` → 读文件 →
剥 frontmatter → 包成 `<skill name= location=>` 块。

缺的只有**发现**（没有补全菜单）和**客户端自己的命令**（`/new` 之类 pi 不认识）。

另外技能还有第二条触发路径：`formatSkillsForPrompt` 把名字/描述/位置写进系统提示词的
`<available_skills>` 块，**模型自己会去读**。这条不需要任何界面工作。

### 1.5 命令目录有现成的单一数据源

`core/agent-session.js:1914` 的 `getCommands()` 已经合并三类并打好来源标记：

```js
extensionCommands → source: "extension"
templates         → source: "prompt"
skills            → source: "skill",  name: `skill:${skill.name}`
```

每条带 `name` / `description` / `source` / `sourceInfo`（含绝对路径）。
**不要自己拼三份列表**——pi-app 的 `handleGetcommands` 分三次取是因为它写得早。

## 二、R01 — 借用用户 `~/.pi` 的技能与模板

### 施工点

**新增** `src/agent-host/userResourcePaths.ts`：

- 复用 `getLocalPiAgentDir()`（`src/main/services/piModelConfig/index.ts:25`）的解析逻辑——
  它已经处理了 `PI_CODING_AGENT_DIR` 继承与 `HOME`/`USERPROFILE` 跨平台回落
- 只在**托管模式**下借（非托管模式 agentDir 本来就是用户的，借了会重复）
- 存在性检查，目录不存在就不传（传不存在的路径只会让加载器报诊断，是噪音）
- 返回 `{ skills: string[], promptTemplates: string[] }`

**接入** `src/agent-host/piAgentSessionBootstrap.ts` 的 `createRuntime`，
在现有 `resourceLoaderOptions` 上追加两个字段（现在只有
`additionalExtensionPaths` 和 `extensionFactories`）。

**开关** `borrowUserPiResources`，默认开，存 shared settings，
随 `worker.bootstrap` 载荷下发——worker 不自己读设置，与现有的 `projectTrusted` 同一条路。

### 验收

- 单测：托管/非托管分支、目录不存在时不传、路径为绝对路径
- 静态断言：`piAgentSessionBootstrap` 确实把借用路径接到 `resourceLoaderOptions`
- **变异验证**：撤掉借用，断言判红
- 真机：放一个技能到 `~/.pi/agent/skills/`，开会话后确认它出现在命令目录里

## 三、R02 — 斜杠命令

### R02-a worker 目录

`src/shared/types/workerRpc.ts` 加 `worker.commands` 的请求/结果类型，
照 `WorkerHistoryPayload` / `WorkerHistoryResult` 的样子。
`src/agent-host/piWorkerSession.ts` 加查询，**原样透传 `getCommands()` 的结果**。

上限照 `EXTENSION_INVENTORY_MAX = 64`（`src/agent-host/extensionInventory.ts:20`）的先例给一个。

### R02-b Main 缓存

`WorkerManager` 加取目录的方法，`src/main/ipc/chat.ts` 加 IPC。

**托管模式下目录不随工作目录变**（项目那部分被信任开关挡掉，agentDir 与
`~/.agents` 都固定），所以全局缓存一份，任何一个活着的 worker 都能给出正确答案。
这也让「起始屏还没有会话」不成为问题。

**不照抄 pi-app 的磁盘扫描**（`src/main/commands-catalog.ts` 的
`scanStaticSlashCommands(cwd)`）。在托管模式下它会**列出实际不会加载的命令**，
比没有补全更糟。非托管模式下才有意义，见 [Q-R1](../open-questions.md)。

缓存失效点：worker 启动/重启、借用开关变化。

### R02-c 渲染层

**补全浮层**（工作量大头），挂 `src/renderer/components/chat/ChatComposer.tsx`。
以 `/` 开头时弹出，按名字和描述过滤，上下键选择，回车填回。
**每行显示来源**——三类混在一起，用户需要分得清 `/skill:xxx` 和 `/xxx`。

**发送前拦截**，新增 `src/renderer/components/chat/slashCommands.ts`（纯函数，可测），
在 `runSend` 之前解析首个词。承重的一行照抄 pix 的 `resolveBuiltinSlash` 开头：

```ts
if (source && source !== 'builtin') return { type: 'runtime', command: name, args };
```

**先查目录里这个名字属于谁**。pi 那边真有同名插件命令就不拦，
避免客户端悄无声息地抢掉插件的命令名。

四条内置命令与反馈形式见
[D02](../decisions/002-builtin-slash-commands-only-where-no-control-exists.md)。

`/compact` 需要一条新 RPC：SDK 侧是 `session.compact(customInstructions?)`
（`core/agent-session.d.ts:508`），会先中止当前回合。
**显示端不用新写**——`src/agent-host/piSessionTimeline.ts:116` 已经把
`entry.type === 'compaction'` 转成系统提示。

### 不做（留后续）

- 参数级补全（SDK 的 `getArgumentCompletions`）
- pi 的 shell 注入语法（`!命令` / `!!命令`），pix 在同一位置做了
- 非托管模式的磁盘预览目录（[Q-R1](../open-questions.md)）

### 验收

- 单测：解析、过滤排序、内置解析（含「目录说这是插件命令就不拦」那条）
- 静态断言：拦截发生在 `runSend` 之前；`getCommands` 结果原样透传不重拼
- **变异验证**：去掉来源检查那一行，断言「插件同名命令被误拦」判红
- 真机：打 `/` 看菜单；打 `/skill:<已装技能>` 确认展开；打 `/new` 确认开新对话

## 四、R03 — 三个插件随包附带

| 插件 | 体积 | 理由 |
|---|---|---|
| `@juicesharp/rpiv-ask-user-question` | 408K | 补齐已有的半截显示链路 |
| `pi-workspace-history` | 168K | 撤销安全网 |
| `@gotgenes/pi-subagents` | ~2.8M | 换掉会绕过权限审批的那版 |

### 关键取证

**问答卡在非终端宿主下有专门分支**，`ask-user-question.ts:334`：

```ts
if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
    return runRpcPath(pi, ctx.ui, typed);
}
```

走 `ui.select` / `ui.input` 顺序对话，正是
`src/renderer/components/chat/ExtensionUiDialog.tsx` 承载的两个原语。
作者点名的宿主是 VSCode pendant、Zed、Paseo——我们是同一类。

**子代理必须换包。** 随包权限系统自己的文档
（`node_modules/@gotgenes/pi-permission-system/docs/subagent-integration.md:170`）
的兼容表写着 `tintinweb/pi-subagents`「不发布生命周期事件」，其 in-process 子代理
「既没有确定性检测，也没有 ask-state 转发」。
用那版 = 子代理的工具调用绕过审批弹窗，而界面上还显示着权限档。
**这是安全缺口，不是体验问题。**

### 施工点

1. `src/agent-host/package.json` 的 `dependencies` 加三项
2. `scripts/agent-host-build-lib.mjs` 的 `shouldCopy`（第 98 行）加分支，
   照 `@gotgenes/pi-permission-system` 那段剔除 docs/README/CHANGELOG。
   **陷阱**：walker 会先问包目录本身，分支必须像 `tree-sitter-bash` 那样处理
   `parts.length === 1`，否则整包被跳过而测试全绿
3. `src/agent-host/permissionPlugin.ts` 现在只解析一个包的路径，推广成一张表
4. 体积：`scripts/packaging-budget.mjs` 上限 256MB，加 3.4M 无压力，但要复测

### 不随包

| 插件 | 理由 |
|---|---|
| `pi-cc-extensions` | 14M，给 pi 补终端界面，与我们的 GUI 定位冲突；其渲染部分在 GUI 里一行都不显示 |
| `pi-fff` | 原生二进制，单 Linux 两个 libc 变体各 13M |
| `rpiv-advisor` | 要额外模型配额，默认开会产生用户不知情的账单 |
| `rpiv-web-tools` | 十个服务商都要自己填 key |
| `pi-web-access` | 免配置、能力最全，但**实测净增 170M**（只装 pi SDK 131M，加它 301M） |

后三个进「推荐安装」列表。

### 验收

- 打包产物里三个包都在且能加载（扩展 `scripts/packaged-worker-smoke.cjs`）
- **变异验证**：`shouldCopy` 去掉一个分支，断言判红
- 真机：问答卡端到端——模型调 `ask_user_question` → 弹窗出现 → 选项回传

## 五、R04 — 提示词模板安装入口 · **Done**（2026-09-06）

落地与 GUI 点验见 [R04 evidence](../evidence/2026-09-06-r04-resource-settings.md)。

模板没有 `~/.agents` 那样的共享位置（见 §1.2），托管模式下只剩
`~/.pilab/pi-agent/prompts` 一个位置，而用户找不到这个路径。

R01 落地后借用能兜住「装在 `~/.pi`」的情况，本片补两件小事：

1. 设置页给「打开模板目录」按钮（`shell.openPath`）
2. 资源页说明三个位置的区别，**把 `~/.agents/skills/` 写成技能的推荐位置**——
   它是唯一一个不受任何模式影响的位置，而且跨 agent 通用

## 六、门禁

每片按项目既有顺序：

1. 相关 Vitest
2. `pnpm typecheck`
3. `npx biome check src/`
4. `git diff --check`

每片必须有**变异验证**（回退改动看测试是否判红）。
证据写进 `evidence/`，记实际命令与数字，不沿抄旧的「全绿」。
