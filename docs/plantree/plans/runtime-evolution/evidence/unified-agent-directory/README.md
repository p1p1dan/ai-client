# H/19 统一 agent 目录、迁移与插件 —— 验证记录

日期：2026-09-10。范围：[实施计划](../../topics/unified-agent-directory.md) 执行清单 U1～U6。基线提交 `ae38918b`，落地提交 `4284c893`。

## U1 目录解析统一

`getManagedPiAgentDir` 更名为 `getAppPiAgentDir`（旧名会读成「托管专用」的断言），`getActivePiAgentDir()` 现在无条件返回它。H/17 引入的 `localRouteUsesAppAgentDir()` 分支连同函数一起删除，`resolveManagedPiWorkerEnv()` 里 `PI_CODING_AGENT_DIR` 改为两种模式都发。

连带改动，都是同一条分支的下游：

- `getActivePiPromptTemplatesDir()` 两种模式都返回本应用目录。此前本地模式返回 `~/.pi/agent/prompts`，而该目录已不再被任何会话加载，打开它会给用户看一堆进不了对话的文件。
- 权限策略页的 global scope 改为本应用目录，因此**两种模式都可写**。此前本地模式只读，理由是「global scope 就是用户自己的 `~/.pi`」——这条前提没了。红线的守法从「拒绝写任何东西」变成「目录解析器根本不指向 `~/.pi/agent`」，测试同时断言写入落在本应用目录**且**用户目录下没有产生文件。

## U2 迁移能力

新增 `src/shared/agentMigration.ts`（类型）、`src/main/services/agentMigration/`（服务 + 接线）、`src/main/ipc/agentMigration.ts`、设置页 `AgentMigrationSettings.tsx`。

- **一律复制，用户目录只读**。测试直接断言复制后源文件内容不变。
- **两种拷贝粒度**。skills / prompts 整目录搬（半个 skill 不是 skill）；sessions 逐文件合并（`sessions/<项目>/` 目标侧本来就可能存在同名目录，整目录跳过会把用户当前正在用的那个项目的旧对话全藏起来）。
- **冲突默认跳过**，界面逐条列名字，用户显式打开「替换」开关才覆盖。
- **模型服务导入**是 H/17 缺陷的正解：读用户 `models.json` 的 provider（key 取 provider 自带的 `apiKey`，没有再取 `auth.json`），写进 vault 用户组。按名字去重，重跑不产生重复条目。
- 导不进来的**逐条报原因**而不是静默少几行：API 风格本应用不支持、URL 不可用、没有 key、`$NAME` 指向本进程看不到的环境变量。

**超出计划范围的一项**，已在此登记：计划的「迁移范围三样」是 skills / `AGENTS.md` / 模型服务，但 U5 要删的借用机制同时覆盖 prompt templates 和会话目录。只搬三样会让用户的 prompt templates 静默消失、本应用里已有的历史对话找不到。因此迁移项做成五样（多了 prompt templates 与 sessions），两者都在界面里单独列出、可单独取消勾选。

## U3 会话目录

不需要单独实现：agent 目录统一后，GUI worker（`SessionManager.create(cwd)` 走 agentDir 默认值）与内嵌 TUI（`resolveManagedPiPtyEnv` 保留 `PI_CODING_AGENT_DIR`）落在同一个 `<appAgentDir>/sessions/`。测试断言两种模式下 PTY 与 worker 拿到的目录字符串相同。

搬家前已有的对话由 U2 的 sessions 项复制过来。按用户 2026-09-10 决定，不保证用户自己终端里的官方 `pi` 能找到本应用的会话。

## U4 插件界面

新增 `src/shared/piPlugins.ts`、`src/main/services/piPlugins/`、`src/main/ipc/piPlugins.ts`、设置页 `PiPluginsSettings.tsx`。

- list / install / remove 全部调 pi 自己的 CLI；`resolvePiTuiLaunchPlan` 更名 `resolvePiCliLaunchPlan` 并抽出 `currentPiCliLayout()`，让内嵌 TUI 与插件管理器共用同一份路径解析（打包布局的修复不会只落到其中一边）。
- **启用开关自己写 `settings.json`**：pi 没有对应 CLI 动词（`pi config` 是交互式 TUI）。在 `"npm:x"` 与 `{source:"npm:x",autoload:false}` 之间切换，即 `pi config` 自己写的那两种形态。手写的资源过滤（`{source, skills:[...]}`）跨切换保留。
- 不提供 `-l`（项目级）入口；托管模式下 `projectScopeAvailable` 为 false 并在界面说明原因。
- 审批归属：读本应用 agent 目录的 `settings.json`，用 worker 启动时调的**同一个**导出函数 `permissionPluginConfiguredByUser`（不是第二份实现）。界面在两种情况下都显示——「用你自己装的权限系统接管」与「用随包的」都是信息，只在异常时才出现的提示没人知道要去看。

### 实测发现并修掉的一个缺陷

对真实 pi CLI 跑冒烟时发现：条目写成对象形态后，`pi list` 输出的是 `npm:pi-jingle (filtered)`。带着这个后缀，source 里就有空格，`checkPluginSource` 会拒绝，于是**每个被禁用的插件都会从列表里消失**，用户除了手改文件没有办法把它开回来。已在 `parsePiList` 里剥掉尾部括号注记，并用实测输出补了用例。纯 mock 的单测发现不了这一条。

## U5 移除借用机制

删除 `AICLIENT_PI_BORROW_RESOURCES_DIR`、`borrowUserPiResources` 设置键、`resolveBorrowUserPiResources()`、`resolveBorrowedResourcePaths()` / `prependBorrowedInstructions()` / `hasBorrowedPaths()`，以及 worker → RPC server → session → bootstrap 整条 `borrowResourcesFrom` 传递链和设置页那个开关。`userResourcePaths.ts` 只剩 `defaultSkillInstallInstructions()`。

同时删除 `src/agent-host/spikes/project-trust-resource-probe.ts` 与 `__tests__/userResourcePaths.test.ts`（验证的机制已不存在）。`piResources` IPC 现在**拒绝**而不是忽略 `borrowUserPiResources` 字段：静默 no-op 会读成一次保存成功。

## 界面中文

两个新页面与改写的 Pi 资源段落都补了 `src/shared/i18n.ts` 的中文词条，同时删掉借用开关那四条已经没有对应界面的旧文案。

踩到一次这个文件的陷阱：`From` / `To` / `No plugins installed` / `Installing...` 已经存在（分别属于文件移动对话框和 Claude 时代的插件浏览器）。重复键在对象字面量里是**后者静默覆盖前者**，会把别处的译文改掉。新页面改用 `Copy from` / `Copy to`，另两条直接复用既有键。Biome 的 `noDuplicateObjectKeys` 能查出来，已确认全 `src/` 无残留。

注：H/17 的「AI 服务」页本身还有一批英文键没进词典，属于看板里[中文界面英文残留](../../README.md#现场缺陷与修复)那条待办，本轮没有一并处理。

## U6 验证

**自动化**：全量 **363 文件 / 5175 测试通过**。三套 tsc（根目录、`src/agent-host`、`src/runtime`）通过。Biome 全 `src/` 检查通过（余下 2 条警告在未改动文件里）。

新增用例：

- `src/main/services/agentMigration/__tests__/AgentDirMigrationService.test.ts` 14 项，跑在真实临时目录上（用 fs mock 只能证明「我们调了我们打算调的」，证明不了用户目录没被动过）。
- `src/main/services/piPlugins/__tests__/PiPluginService.test.ts` 11 项，`settings.json` 是真实文件、pi CLI 是桩。

改写的用例（原用例断言的行为已被本轮推翻）：

- `piWorkerEnv.test.ts`：把 H/17 那四个输入原样留下当回归——无服务 / 有服务 / 服务被禁用 / 托管，四种情况下 `PI_CODING_AGENT_DIR` 现在是同一个值。
- `permissionPolicyService.test.ts`：本地模式从「拒绝写」改为「写进本应用目录，且用户 `~/.pi` 下不产生文件」。只断言前半句的话，一个偷偷写了 `~/.pi` 之后再报错的实现也能通过。
- `piAgentSessionBootstrap.test.ts`、`piResources.test.ts`、`settingsMainOwnedKeys.test.ts`、`piResourcesSettingsStatic.test.ts`。

**真实 CLI 冒烟**（2026-09-10，临时 agent 目录 `/tmp/h19-live-agent`，走 `PiPluginService` + `createPiCliRunner` 本体，非 mock）：空列表 → `install npm:pi-jingle`（约 2.5 秒，联网真装）→ list 出包名与绝对路径 → 关闭后 settings 写成 `autoload:false` 且 list 仍列出、状态为关 → 打开后回到裸字符串 → `remove` 后 settings 与 `node_modules` 双双清空 → 装一个不存在的包返回 `ok:false` 且带 npm 自己的报错文本。全部通过。该探针**未留在测试套件里**（联网会让 CI 变脆），仅此记录。

## 未验证

- **未打包，未做安装版/加密 Windows 现场回归**。按用户 2026-09-10 决定，全部做完后再上机一次。
- **迁移与插件两个界面未在真实应用里点验**，只有静态与单元覆盖。验证案例 1～3、5～7 的界面部分待现场。
- 未在真实应用里确认「导入的服务出现在模型选择器里」这一步的端到端（自动化只覆盖到写 vault + 触发派生文件重写）。
- 未验证 GUI 与 TUI 同时列出迁移后历史对话的现场表现（自动化只证明两者拿到同一个目录）。
