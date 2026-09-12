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

## 点验查出的缺口：迁移没跑之前，旧会话一律 resume 失败

2026-09-10 在真实应用里点开一条 4 天前的会话，报：

```
Error occurred in handler for 'chat:resumeSession':
WorkerSlotError: WORKER_REQUEST_FAILED: Pi model not found: maxapi/grok-4.6
```

不是 bug，是 U1 的**直接后果**，但缺了一层提示：

- `maxapi/grok-4.6` 在 `/home/ai/.pilab/t37c-agent/models.json` 里（本机 `dev.env` 的 `PI_CODING_AGENT_DIR`）。U1 之后那里是「用户自己的目录」＝迁移**来源**，不再被加载。
- 应用自己的目录 `/home/ai/.pilab/jyw-ai-client-dev/pi-agent/` 里**没有 models.json**，只有两个空的 `auth.json` / `models-store.json`。
- 于是每一条在切换前创建的会话，模型都指向一个本应用现在看不见的服务。

U2 的迁移正是这条的解药（把 provider 导进 vault 用户组），但**用户没有任何线索知道该去点它**：错误文案只说「Pi model not found: <id>」，不提迁移，也不提设置页。升级到这个版本的用户，第一次打开任何旧会话都会撞上它。

补救方式当时待定（启动时检测到「有旧会话且本应用目录无模型」就提示迁移？还是只把错误文案改成指向设置页？），属于产品取舍，未擅自实现。

**2026-09-10 更新：两条都做，分两步。** 文案这条已落地（[H / 21 P0](../../topics/external-agent-migration.md#p0-落地记录2026-09-1022da278c)，`22da278c`）——四个会撞上这个失败的界面共用一份判定与文案，按钮落到设置的 Pi 页；不给重试按钮，因为模型不会在两次点击之间自己出现。启动时主动提示这条是 [H / 21 P1](../../topics/external-agent-migration.md#决策一2026-09-10-已定老用户首启一键确认)（首启一键确认迁移），未开工。

两步都做的理由：跳过、失败或只迁了一部分的用户仍会撞上同一个报错，所以文案不能被首启弹窗吸收掉。

## 验证案例 4、5 的真机点验（2026-09-11）

第 5 批第 2 项。这两条是 H/19 最后剩下的验收项——案例 2、3 已随 H/21 点验一并通过，
案例 7 依赖 H/20。**两条全部通过**，三个探针：

| 探针 | 回答哪一半 | 结果 |
|---|---|---|
| [`run-h19-plugin-gui-probe.mjs`](../../../../../scripts/run-h19-plugin-gui-probe.mjs) | 案例 4 全流程 + 案例 5 的界面（本地模式） | 12 项判据全通过 |
| [`run-h19-project-scope-probe.mjs`](../../../../../scripts/run-h19-project-scope-probe.mjs) | 案例 5 的机制：项目级插件到底生不生效 | 通过 |
| [`run-h19-managed-notice-probe.mjs`](../../../../../scripts/run-h19-managed-notice-probe.mjs) | 案例 5 的界面（托管模式） | 通过 |

### 案例 4：装 → 会话里可用 → 装失败 → 卸

原始输出 [h19-plugin-gui-report.json](h19-plugin-gui-report.json)。全程走真实控件——
往输入框里用原生 setter 派发 `input` 事件（React 的受控 value 直接赋值不触发
`onChange`，按钮会一直是 disabled），再点真按钮，**不调 `electronAPI.piPlugins.install`**。
磁盘那一侧由探针自己 `readFileSync`，不借界面的 IPC：界面与磁盘要是同一个信息源，
两边一致就什么也没证明。目录也不是探针自己算的，取自页面显示给用户的那行
`settingsPath`（`/home/ai/.pilab/jyw-ai-client-dev/pi-agent/settings.json`）。

- **装**：输入 `npm:pi-jingle` → 列表出现一行 `pi-jingle / npm:pi-jingle /
  <agentDir>/npm/node_modules/pi-jingle`，带启用开关与移除按钮；磁盘上
  `settings.json` 的 `packages` 变成 `["npm:pi-jingle"]`，`npm/node_modules/` 里出现
  `pi-jingle`。[截图](h19-plugin-installed.png)
- **会话里真的可用**（这条此前从没验过，也是案例 4 里唯一不能靠磁盘回答的）：
  装完发一轮真实对话把 worker 拉起来，再问 `chat:listSessionExtensions`，拿到

  ```json
  { "name": "jingle", "path": "<agentDir>/npm/node_modules/pi-jingle/jingle.ts",
    "source": "npm:pi-jingle", "scope": "user", "ok": true }
  ```

  这份清单是 pi 自己 `resourceLoader.getExtensions()` 的结果，不是我们照着
  `settings.json` 二次推导的，所以它回答的确实是「pi 把它加载进会话了」。
- **装失败说人话**：装 `npm:aiclient-h19-no-such-package-9f3c1`，界面上直接显示 npm
  自己的原文（`npm error 404 Not Found - GET https://registry.npmjs.org/...`）加上
  pi 的那行 `npm install ... failed with code 1`；磁盘没留下任何痕迹，已装的
  `pi-jingle` 不受影响。[截图](h19-plugin-install-failed.png)
- **卸干净**：点移除后列表回到空态「暂无已安装插件」，`settings.json` 的 `packages`
  为 `[]`，`npm/node_modules/` 为空。

### 案例 5：托管模式下项目级插件不生效，且界面不提供入口

这条拆成两个独立问题，分别用不同手段回答。

**机制**（[h19-project-scope.json](h19-project-scope.json)）：在临时目录里用
`pi install -l --approve` **真装**一个项目级插件——不是手写 `.pi/settings.json`，
因为项目信任判定完全可能落在包解析而不是读文件那一步，手写文件验不到。装完
`.pi/settings.json` 是 `{"packages":["npm:pi-jingle"]}`、`.pi/npm/node_modules/` 里
有 `pi-jingle`，而 agent 目录的 `settings.json` 压根没生成（没被污染）。然后拿 pi
自己的 `SettingsManager.create(cwd, agentDir, { projectTrusted })` 做差分：

| `projectTrusted` | `getProjectSettings().packages` |
|---|---|
| `true` | `["npm:pi-jingle"]` |
| `false` | `[]` |

这正是本应用托管模式下走的那条路：托管时发 `AICLIENT_PI_TRUST_PROJECT_CONFIG=0`
（`piModelConfig/index.ts`），worker 读成 `projectTrusted: false` 交给
`piAgentSessionBootstrap` 里的同一个调用。所以差分成立即等于该案例成立。

**界面**（[h19-managed-notice.json](h19-managed-notice.json)）：两种模式下都扫了插件区
里的全部可交互元素（button / input / select / switch / radio / tab / checkbox），
按「项目 / project / -l / 本地安装」筛，**两种模式都是空集**——没有项目级入口。
判据用控件而不是文字是必须的：托管模式那句说明本身就含「项目级」三个字，按文字找
会把说明当成入口。托管模式下那句说明如期出现：

> 安装会联网下载，可能要等几秒。**登录模式下项目级插件不会生效，所以本应用只装到你的账户下。**

本地模式下它不出现。[截图](h19-managed-project-scope-notice.png)

### 点验里踩到的三件事，都值得单独记

1. **在应用里切换凭据模式，在开发机上是无效操作。** 第一版探针调
   `auth.enterApp('managed')` 再看界面，什么都没变，差点被读成缺陷。真因是
   `resolveCredentialMode` 的优先级：未打包构建里**环境变量压过设置文件**，而
   `dev.js` 会把 `dev.env` 的 `AICLIENT_MANAGED_CREDENTIALS`（开发机写的是 `0`）
   一路带给子进程。`enterApp` 确实把选择写进了 `settings.json`，但
   `getCredentialMode()` 读出来仍是 local。这不是缺陷，是那条优先级的直接后果，
   但它足以让一次点验得出相反的结论。托管模式必须另起一份应用，用
   `AICLIENT_DEV_ENV_FILE` 指向一份把该键改成 `1` 的副本（顺带
   `AICLIENT_SKIP_AUTH_GATE=1`，否则托管模式没登录会被挡在主界面外，根本点不到设置）。
2. **别在 CDP 里直接 remove 弹层的 DOM 节点。** 第一版为了让设置页重新挂载干了这件事，
   React 的树和真实 DOM 当场对不上，此后无论点标题栏的设置按钮还是走
   `settingsIntent`，`settingsDialogOpen` 都变 true 了却什么都不渲染——看起来像应用
   坏了，只能重启（这台机器冷启动数分钟）。正确做法是真点分类导航：`SettingsContent`
   给内容区挂了 `key={activeCategory}`，换一个分类再换回来，整块自然重新挂载。
3. **仓库根的 pi SDK 在纯 Node 下 import 不起来。** 根目录那棵树里
   `pi-coding-agent@0.84.4` 底下嵌着一个过期的 `pi-tui@0.84.3`，Node 先解析到它，
   `import` 直接抛 `does not provide an export named 'setCapabilityOverrides'`。
   `src/agent-host/node_modules` 那棵两个包同为 0.84.3、自洽，也正是 worker 实际加载
   的那份，所以**应用本身不受影响**（这轮真实回合跑通了工具调用就是证据），受影响的
   只有从仓库根 import SDK 的探针或测试。未改依赖树，仅在探针里指向 agent-host 那份
   并注明原因。

### 顺带修掉的一个显示缺陷：插件面板把随包权限系统显示成 `src`

不是推测，是从上面那份扩展清单里直接读出来的：随包权限系统解析到
`.../@gotgenes/pi-permission-system/src/index.ts`，而 `extensionDisplayName` 的规则是
「入口文件就取上一级目录名」，于是名字成了 `src`。任何按 `src/index.ts` 这种再普通不过
的布局发布的包都会中招，而这个名字会直接出现在侧栏的插件面板上。

已修：入口文件的上一级若是 `src` / `dist` / `lib` / `build` / `out` / `esm` / `cjs`
这类构建目录，再往上取一级。**只上一级**——真叫 `src` 的包本来就无从分辨，再往上走
就该把插件命名成 `node_modules` 或 scope 目录了。补了三条用例，含点验里那条真实路径。

## 未验证

- **未打包，未做安装版/加密 Windows 现场回归**。按用户 2026-09-10 决定，全部做完后再上机一次。
- 验证案例 7（GUI 与 TUI 都能列出迁移后的历史对话）依赖 H / 20，未开工。
- 未在真实应用里确认「导入的服务出现在模型选择器里」这一步的端到端（自动化只覆盖到写 vault + 触发派生文件重写）。
- 案例 4 的「启用/停用开关」这一轮没再点（2026-09-10 的 CLI 冒烟覆盖过，含 `pi list`
  的 ` (filtered)` 后缀那条修复）；本轮只验了装、可用、失败、卸四步。
