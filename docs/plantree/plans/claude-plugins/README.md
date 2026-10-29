# 在设置里安装与管理 Claude 插件与 MCP 服务

分支 `feat/claude-plugins`，从 main `14628143` 开出。进度看 [tasks.md](tasks.md)。

**2026-10-29 用户定**：

| 问题 | 定案 |
|---|---|
| 放在哪 | ~~A：扩展页~~ → **设置 → 插件页**（2026-10-29 用户改：所有插件与 MCP 都放插件页；Pi 插件也从扩展页搬过去，扩展页只留技能与旧版遗留内容）。侧栏账号行右边的「能力」按钮（只显示技能数）一并去掉 |
| 官方市场 | **A**：不预置，空状态里一键添加 |
| MCP | **只做 Claude 对话**（有人提了 MCP 需求）；Pi 对话的 MCP 不做（要先升 DSH，见 §6） |
| 内核 | **先只升 Claude SDK** 0.3.300 → 0.3.312（CLI 2.1.312）；DSH 先不动 |

## 1 起因

用户问「Claude 的插件怎么安装？还是无法通过 PiLab 页面安装？」。现在确实装不了：

- 设置 → 扩展里的「Pi 插件」是随包、经审查的 DSH 插件，只能开关（决策 058、059、117）。
- 设置 → 插件是 PiLab 自己的 `.pilabplug`，和对话引擎无关。
- Claude 对话只会加载仓库 `.claude/settings.json` 里声明的插件（路线 B 裁决 18）。用户层 `~/.pilab/<配置名>/claude`（裁决 19）没有任何界面，CLI 的 `/plugin` 是终端里的交互界面，SDK 的命令清单里没有它。

交互预览：[`docs/design/2026-10-29-claude-plugins-preview.html`](../../../design/2026-10-29-claude-plugins-preview.html)。

## 2 实测（2026-10-29，本机，随包 CLI 2.1.300）

随包 CLI 自带非交互的插件子命令，全部能输出 JSON。用 `CLAUDE_CONFIG_DIR` 指到一个临时目录，跑通了下面的全流程：

| 操作 | 命令 | 结果 |
|---|---|---|
| 加市场 | `plugin marketplace add <owner/repo \| git 地址 \| 本机目录> --json` | 本机目录立即完成；官方市场 `anthropics/claude-plugins-official` 用 git 走 HTTPS 克隆，用时 16 秒。写进用户层 `settings.json` 的 `extraKnownMarketplaces` |
| 列市场 | `plugin marketplace list --json` | 名字、来源、本地位置 |
| 列可装的 | `plugin list --available --json` | 官方市场有 315 个，字段为 `pluginId`、`name`、`description`、`marketplaceName`、`source`、`installCount`（多数有），`version` 只有少数有 |
| 安装 | `plugin install <名字@市场> --json`（默认 `--scope user`） | code-review 用时 10 秒，写进 `enabledPlugins`，文件放在 `plugins/cache/` |
| 列已装的 | `plugin list --json` | `id`、`version`、`scope`、`enabled`、`installPath`、`projectEnabled` |
| 关 / 开 | `plugin disable\|enable <id> --json` | `enabledPlugins` 里改成 false / true |
| 卸载 | `plugin uninstall <id> --json` | 文件与数据一起删 |
| 移除市场 | `plugin marketplace remove <名字> --json` | ok |
| 插件里有什么 | `plugin details <id>` | 只有文字输出，没有 `--json`，所以改由我方读 `installPath` 下的目录 |

这些操作都不经过模型、不经过网关。要联网的只有 GitHub 或 git 来源：克隆市场、下载插件。

## 3 方案

### 3.1 原则

- **只调 CLI，不复刻**：装、关、卸、加市场全部交给随包 CLI 的 `claude plugin … --json`。PiLab 不自己写 `settings.json`，不解析市场格式。这符合裁决 17「SDK 引擎都按官方行为来」。
- **只管用户层**：安装范围固定为 `user`，不往仓库里写东西。仓库声明的插件只列出来、标「仓库声明」，开关不可点（要改就去仓库里改）。
- **里面有什么要写明**：每行标出插件带的技能、命令、子代理、钩子、MCP 服务。钩子和 MCP 服务会在本机运行程序，用警告色标出，和 Pi 插件的「写入文件」一样醒目。

### 3.2 预览里的两个选项（2026-10-29 都选了 A）

| 问题 | A（推荐） | B |
|---|---|---|
| 放在哪 | 扩展页里加一节「Claude 插件」，和「Pi 插件」上下并排，与刚做完的「技能按 Pi / Claude 分组」一致 | 侧栏单独一页「Claude 插件」，更宽敞，但插件分散在两处 |
| 官方市场 | 不预置。空状态里放一个「添加官方市场」按钮，点了才联网 | 预置好，第一次打开就去克隆。省一步，但加密机或断网时一打开就先看到错误 |

### 3.3 界面（按 A 画）

- **「Claude 插件」一节**：标题旁的问号说明「只对 Claude 对话生效，装在本应用自己的 Claude 配置目录，不碰 ~/.claude；钩子与 MCP 服务会在本机运行程序」。右侧两个按钮：「插件市场」「浏览插件」。
- **已装的插件**：每个一行，显示名字、版本、说明、来自哪个市场、里面有什么，加一个开关和「⋯」菜单（检查更新、卸载）。卸载前先弹确认框。
- **当前仓库声明的插件**：单独一组，开关只读。
- **浏览对话框**：上方是市场下拉框和搜索框，下面每个插件一行（名字、两行说明、安装量），右侧是「安装」按钮。点了之后依次显示「正在安装…」「已安装」；失败时在那一行下面显示 CLI 给的原因。
- **市场对话框**：列出已加的市场，每个可以「更新」「移除」。下方一个输入框，可填 owner/repo、git 地址或本机目录（内网可填共享目录）。
- **改动之后**：显示提示「新开的 Claude 对话会用上改动；已经打开的对话在下次启动时生效」。

## 4 实现要点

1. **Main 服务 `ClaudePluginService`**（`src/main/services/claudePlugins/`）：
   - 用 `claudeSdkCliPath` 找随包 CLI，`CLAUDE_CONFIG_DIR` 取 `claudeSdkEngine.ts` 里同一个配置目录。
   - 代理与网络环境和 SDK 宿主用同一份（网络设置里的出站代理），否则在需要代理的网络里克隆会失败。
   - 所有改动操作串行执行，每次都设超时（克隆按 CLI 自己的 120 秒再留余量）。
   - 列已装插件时 `cwd` 取当前仓库，这样能看到仓库声明的插件；「里面有什么」由我方读插件目录（`skills/`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`）。
   - 把 JSON 结果映射成共享类型 `src/shared/claudePlugins.ts`。
2. **IPC 与预加载**：`claudePlugins.list / available / install / setEnabled / uninstall / marketplaces / addMarketplace / removeMarketplace / updateMarketplace`。
3. **斜杠菜单缓存**：`claudeSdkCatalog.ts` 按文件夹缓存命令清单（决策 194），每次改动后要清掉，否则首页菜单里看不到新插件的命令。
4. **渲染层**：`ClaudePluginsSettings.tsx`，组件用 @coss/ui（Switch、Dialog、Menu、Input、Badge、Alert），图标用 Lucide，遵循设计规范 v2。
5. **测试**：用本机目录市场做假市场（不联网），在临时配置目录里跑真 CLI，把每条子命令的 JSON 形状钉住（CLI 升级时会先在这里报错）；服务层单测覆盖超时、失败原因透传、串行执行。

## 5 风险与待实测

- **插件自带的 MCP 要用环境变量时连不上**：Claude 对话的 CLI 只继承白名单里的环境变量（不含密钥类），像官方 github 插件要 `GITHUB_PERSONAL_ACCESS_TOKEN` 就拿不到。要用的话得把变量写进用户层设置的 `env`；界面上先在问号里说明，以后再看要不要给用户层 `env` 做界面。

- **Windows 与加密机上的 git**：GitHub 市场靠 git 克隆。Windows 上 SDK 宿主已经要求 Git for Windows（gitBash），这次要实测 CLI 用不用它。加密机上 CLI 克隆和写插件缓存是否正常、加密文件能否被 CLI 读取，都要上机验证（按 per-process carrier 的经验，这是 `claude.exe` 自己的读写）。
- **CLI 升级后输出形状变**：用上面的形状测试兜住；`details` 没有 JSON，所以不依赖它。
- **安全**：插件可以带钩子和 MCP 服务，等于在本机运行第三方程序。裁决 18 已经接受仓库声明的插件照官方行为加载；用户在界面上手动装的同样处理，靠「里面有什么」标识和问号说明提醒，不另设审查。
- **Pi 引擎不受影响**：这些改动只写 Claude 的用户层，DSH 的插件白名单不变。

## 6 MCP（Claude 对话）

现状：`sdkSessionRuntime.ts` 与 `catalog.ts` 传 `strictMcpConfig: true`，CLI 只认 PiLab 传的服务器，而 PiLab 一个都不传，所以仓库的 `.mcp.json`、用户层的服务器、插件自带的 MCP（如官方市场的 github）都不会启动。

做法（照裁决 17 按官方行为来）：

1. 去掉 `strictMcpConfig`，CLI 照官方规则读用户层（配置目录里的 `.claude.json`）、仓库 `.mcp.json`、插件自带的服务器。仓库 `.mcp.json` 的服务器照 CLI 的批准规则处理（未批准的不连），要实测 SDK 下待批准的服务器怎么表现。只列清单的宿主（`catalog.ts`）保持不起 MCP。
2. 设置页加「Claude MCP 服务」一节，用随包 CLI 的 `claude mcp list / get / add-json / remove` 管理用户层的服务器，和插件同一个服务、同一套串行与超时。
3. MCP 工具在对话里的显示与审批：`mcp__<服务>__<工具>` 走现有 `canUseTool` 卡片，实测工具行的名字与参数显示。
4. 测试：假网关脚本让模型调一个本机 stdio 假 MCP 服务器的工具，加进 `host-probe.ts`。

### 6.1 实测（2026-10-29，CLI 2.1.312，探针 `mcp` 组）

- 去掉 `strictMcpConfig` 后，用户层（`<配置目录>/.claude.json` 的 `mcpServers`）的服务器与受信任仓库 `.mcp.json` 的服务器都启动了，工具名是 `mcp__<服务>__<工具>`，每次调用都先出审批卡（手动审批档），允许后结果正常回来。
- **仓库 `.mcp.json` 的服务器在 SDK 下没有单独的「是否信任这个服务器」确认**，打开对话就启动（交互式 CLI 会先问）。这与裁决 5、18（受信任的仓库，钩子与插件照官方行为加载）一致，但等于打开仓库就会运行它声明的程序。工具调用仍要审批。设置页把仓库的服务器单独列出，标「来自 .mcp.json」。
- 只列清单的宿主（`catalog.ts`）仍是 `strictMcpConfig: true`，列斜杠菜单时不起任何服务器。
- 渲染层早就认 `mcp__` 前缀（`piToolNames.ts`，1.0.x 留下的），工具行显示为「服务 · 工具」。

Pi 对话不做：DSH 0.2.0-rc.2 没有 MCP 客户端，官方 `dsh-mcp-client` 随 0.2.1 发布，升 DSH 时再评估（决策 090 记的「暂不做」照旧）。

## 7 内核升级

Claude Agent SDK 0.3.300 → 0.3.312（内置 CLI 2.1.312，npm 2026-10-27）。按 README 的约定同步升 SDK 与 CLI（`package-lock.json` 钉死），然后跑：宿主 typecheck 与单测、`probe-suite.ts` 全部分组、`event-record.ts --check`，有差异逐条看是否预期。注释里「measured on 2.1.300」的说法不批量改，只在实测结论变了的地方改。

### 7.1 升级结果（2026-10-29）

- 宿主 typecheck 过，宿主单测 224 个过。
- `probe-suite.ts` 第一遍 2 组不过（flow 的 stop、agentstop），原因是 **CLI 2.1.312 的 Bash 工具会拦下前台的长 `sleep`**（「Blocked: standalone sleep 533. To wait for a condition, use Monitor…」）。这是 CLI 的新行为，不是我们的问题：探针与假网关里这几条命令改成 `sh -c 'sleep N'`，被计数的仍是同一个 `sleep N` 进程。改后 11 组全过。
- `event-record.ts --check`：tools 场景与样本不同（Write 的输出带上了改动详情，是 main 上 `6a232b90` 改的；开头几条 `session.projection` 与用量里的 `context` 时有时无）。在干净的 main（SDK 0.3.300）上跑结果一样，与升级无关，样本没有重录。ask 场景三遍里有一遍顺序不同，0.3.300 上也会，属于时序抖动。
- 收尾时删临时目录偶尔报 `ENOTEMPTY`（假网关退出前还在写状态文件），也是原有的。
