# 决策 116：P1-16e 旧资产一次性提示与「扩展」页收窄的实现取舍

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 104](104-legacy-asset-notice-and-extension-pages.md)（本任务的规则全文，已批准）；[102](102-drop-user-layer-instruction-files.md)、[103](103-drop-prompt-templates.md)、[105](105-drop-delegation-switch.md)、[101](101-instructions-and-skills-dsh-native.md)（均由[决策 110](110-user-rulings-2026-09-28-batch2.md) 批准，且 102、103、105「只给提示、不迁移」）；[090](090-user-rulings-2026-09-28.md)（pi 扩展彻底去掉，不留提示入口）；[064](064-accepted-behavior-differences-extensions.md) 第 2 条；[087](087-subagent-catalog-move-and-fixture-relocation.md)；[099](099-p1-4d-scope-dsh-data-only.md) 第 12 条与 [113](113-p1-4d2-commands-and-projection-choices.md) 第 14、15 条（能力清单只报技能数）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-6、16-8、16-9、16-11、16-12 与 §5 的 P1-16e 行；[P1-10 / P1-16 方案 §4.4](../topics/p1-10-p1-16-extensions.md)；
- 1.0.x 规则来源：`src/shared/subagentCatalogRoots.ts`、`src/shared/skills/{catalog,loader,templates,frontmatter}.ts`、`src/shared/mcp/config.ts`、`runtime/plugins/prompt/projectInstructions.ts`（`HOME_INSTRUCTION_FILE_NAMES`）、`services/agent-host/nativeSubagentSettings.ts`；
- DSH 规则来源：`dsh-skill-filesystem/README.md`「Roots and priority」「Skill format」、`dsh-skill-filesystem/lib/index.js`（`discoverRoot` 只看根的直接子项、`parseSkillFile` 要求 `name` 与 `description`）、`dsh-skill/lib/index.js:17`（`SKILL_NAME`）。

改动留在工作区，由编排者复跑后提交。下面是 104 没有写死、由本次实现定下的地方。**第 6、14、19 条请重点审批。**

## 规则

### 一、Main 检测模块

1. **形状**：
   - 纯逻辑在 `src/main/services/legacyAssets/detectLegacyAssets.ts`，`node:fs` 适配在同目录 `nodeFiles.ts`，Electron 接线在 `index.ts`；类型与设置键在 `src/shared/legacyAssets.ts`；
   - IPC 三条：`legacyAssets:inspect`（只读）、`legacyAssets:markSeen`（只写设置键）、`legacyAssets:openAgentDir`；
   - 文件访问、家目录、`<agentDir>`、设置对象全部注入，测试只在临时目录里跑；
   - 「1.0.x 在哪里找」一律调 shared 里 1.0.x 运行时本来就用的函数：`subagentRoots`、`templateRoots` + `loadPromptTemplates`、`skillRoots` + `loadSkills`、`mcpConfigFiles` + `mcpConfigSource`、`parseFrontmatter`。不重新描述一遍规则。
2. **项目级检测只看「当前打开的工作区」**：
   - 启动提示用 App 当前选中的仓库，设置页的常驻入口用 `SettingsContent` 的 `repoPath`；
   - Main 只接受本地绝对路径。临时工作区的哨兵值、远程（SSH）虚拟路径、相对路径都按「没开工作区」处理，只查用户层，不报错；
   - 不去扫所有登记过的仓库；
   - 范围比 104 第 2 条写的 `.pi/prompts`、`.pi/mcp.json` 多了项目技能（`.pi/skills`、仓库根以下各级的 `.agents/skills`）：它们同样只存在于项目里，同样只在打开工作区时查。
3. **不看项目信任**。1.0.x 对未信任的目录不加载项目模板、技能、`mcp.json`；提示只列文件名与服务器名，不加载任何东西，所以不走信任闸（取根时传 `projectTrusted: true`）。代价：未信任仓库里别人提交的 `.pi/prompts` 也会列出来。
4. **自定义子代理**：
   - 扫 `subagentRoots` 给出的两个根（`<agentDir>/subagents`、`~/.agents/subagents`）的直接 `.md` 普通文件，与 1.0.x 目录一致：软链、子目录不算；
   - 名字取 frontmatter 的 `name`，没有就用文件名，都经 1.0.x 的 `normalizeSubagentName` 规范化；
   - 1.0.x 解析失败的定义也列出，它仍是用户写过的文件；
   - 内置 4 个写在代码里，天然不会出现；与内置同名的用户文件照列；
   - `<agentDir>/agents`（subagent-data-01 的旧导入源）不列：1.0.x 本来就不加载它；
   - 按决策 105，按定义的停用名单 `nativeSubagentsDisabled` 不提示。
5. **提示词模板**：逐根调 1.0.x 的 `loadPromptTemplates`。
   - 名字不合 1.0.x 规则的文件 1.0.x 也没用过，不列；
   - 逐根而不是跨根合并，所以被项目模板同名遮蔽的用户模板也列出。技能同理。
6. **用户层指令文件只列 1.0.x 实际读的那一个**（修订决策 102 第 3 条的措辞「这些文件」）：
   - 按 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md` 取第一个有非空内容的，与 1.0.x 一致（空文件跳到下一个）；
   - 排在后面、被遮蔽的文件在 1.0.x 里也从未生效，列出来说「不再生效」不准确；
   - 没有复刻 1.0.x 的两个细节，都极少见：软链指向家目录以外时 1.0.x 拒读；与 `<agentDir>/AGENTS.md` 是同一文件时 1.0.x 当作已加载。
7. **`mcp.json`**：
   - 三层路径由 `mcpConfigFiles` 给出；
   - 只带出 `mcpServers` 的键名（`disabled: true` 的也算），命令、URL、`env` 一律不出 Main；
   - 文件读不出、不是 JSON、没有 `mcpServers` 对象的，照列，标「无法读取」。
8. **DSH 不会加载的技能**：先按 1.0.x 规则逐根扫出（深度 4、`.agents` 类根顶层的散 `.md` 忽略等，全在 `loadSkills` 里），再按 DSH 判，一个技能可以有多条原因，全部列出：
   - `unscanned-root`：所在根不在 DSH 的扫描集合里。集合是 `<agentDir>/skills`（`customSkillDirs`，决策 101）、`~/.agents/skills`、仓库根的 `.agents/skills`；仓库根是最近一个含 `.git` 的祖先，找不到就是工作区本身，与 dsh-skill-filesystem 相同。于是 `.pi/skills` 与仓库根以下各级的 `.agents/skills` 都算；
   - `nested`：不是 `<根>/<name>/SKILL.md`，也不是 `<根>/<name>.md`；
   - `missing-name`：frontmatter 没写 `name`（1.0.x 用目录名顶上，DSH 直接跳过）；
   - `invalid-name`：写了 `name`，但不是 `^[a-z0-9]+(?:-[a-z0-9]+)*$`；
   - 1.0.x 本来就没加载的（比如缺 `description`）不列；
   - 没有判的两类，104 也没列：DSH 用 YAML 解析 frontmatter，1.0.x 是逐行平面解析，二者在少数写法上结果不同；`disable-model-invocation` 写了 DSH 不认的取值时，DSH 会整条丢弃。
9. **委派总开关**：判法与 `nativeSubagentSettings` 相同：`piOptInFeatures.subagents` 优先于旧的 `enablePiSubagents`，只有显式 `false` 才算关过。代码复制一份放进检测模块，因为 `nativeSubagentSettings.ts` 要在 P1-12 随 native 删除。
10. **一类失败不连累其他**：每一类单独 try，失败时记一行 `console.warn`，该类当作空，界面上不报。理由：这是建议，不是要逐项核对的清单。代价：网络家目录出 `EIO` 时，这一类会静默缺席。
11. **pi 扩展一处也不看**：`npm/`、`settings.json` 的 `packages`、`extensions/` 都不碰；测试钉住报告里没有这类字段，也不出现扩展名。

### 二、一次性提示

12. **设置键 `dshLegacyAssetNoticeSeen`**：顶层、归 Main 所有，加进 `MAIN_OWNED_SETTING_KEYS`，渲染层整对象回写时既清不掉它，也伪造不出它；值只写 `true`。
13. **什么时候弹**：
    - App 挂 `LegacyAssetNoticePrompt`，每次启动问 Main 一次；没看过、并且有内容，才弹；
    - 「DSH 版首次启动」按「还没看过」理解：本分支整个就是 DSH 版，没有另设「DSH 版第一次」的标记；
    - 没内容时不记键，下次启动还会再查（几次目录列举，代价很小）。这样之后才出现的旧资产，比如后来打开了一个带 `.pi/prompts` 的工作区，也还能等到这一次提示；
    - 弹出之前工作区变了（启动时仓库是异步恢复的），就按新工作区重查；弹过一次后，本次启动不再查。
14. **关闭就算看过**：点「知道了」、按 Esc、点背景都记键。
    - 这与 `AgentMigrationPrompt` 不同，那边 Esc 表示「以后再说」。区别在于：这份提示只是告知，没有要用户回答的事，而且设置里有常驻入口；
    - 只在关闭时写。弹出后应用崩了，不算看过；写失败，下次启动再弹。
15. **模态队列**：新 id `legacyAssetNotice`，优先级 3，排在公告、迁移提示、更新提示之后，谁都不用等它。
16. **打开目录的入口**（决策 102 第 3 条）：弹窗和设置页各有一个「打开 Agent 目录」按钮，打开 `<agentDir>`，不存在时先建。不逐个提供「在文件夹中显示」。
17. **常驻入口**：「设置 > 扩展」里的一节「旧版遗留内容」。
    - 直接内嵌同一份列表，不在设置对话框里再弹一个嵌套对话框；
    - 每次进页面重新检测，看没看过都显示；用户已经挪走或改好的文件会自己消失；
    - 没找到时显示一句话；并注明项目文件查的是哪个工作区，没开工作区时提示「打开工作区后还会检查项目文件」。
18. **文案**进 i18n，中英各一份；技能原因用字面 `t('…')` 写在 `switch` 里，让目录覆盖扫描看得见每一条。

### 三、「扩展」页与能力弹窗

19. **子代理页、插件页从「扩展」页卸下，插件页不留占位**：
    - `PiPluginsSettings` 整页都是 pi 扩展（安装框、列表、权限说明），按决策 090 整块卸下；
    - 不放「插件即将提供」之类的空占位：P1-10c 做白名单插件列表时直接在这一页加一节。空占位只会让人以为自己少装了什么；
    - 两个页面文件照 104 第 5 条留到 P1-12。
20. **「资源」页只剩技能**：
    - 标题改为「技能」；两个目录各带一个「打开文件夹」按钮。新 IPC `piResources:openAppSkills` 打开 `<agentDir>/skills`，原有的 `openSkills` 仍打开 `~/.agents/skills`；
    - 下面三条 DSH 技能规则：只看目录第一层（`<name>/SKILL.md` 或 `<name>.md`）；`name`、`description` 必填，`name` 只用小写字母、数字、短横线；消息任意位置的 `/<name>` 触发，`disable-model-invocation: true` 让模型不自己调用；
    - 说明里提到项目仓库根的 `.dsh/skills`、`.agents/skills`，不提 `$DSH_HOME/skills`（产品里不让用户接触 DSH_HOME）；不写「改动无需重启」，因为宿主里技能目录的 watcher 是否开着没有核实；
    - 去掉：模板目录与按钮；「你自己的 Pi 目录」（`~/.pi/agent` 下的 skills、prompts，H/19 起就不加载，搬运入口在「数据迁移」页）；「智能体功能」里的委派开关（决策 105）。页面不再写任何设置。
21. **能力弹窗只留技能一行**，描述改为「这个对话可以使用的技能」。`sessionCapabilityModel` 的视图收成 `{reported, skills}`；`WorkerCapabilityInventory` 类型不动，1.0.x runtime 仍在产出，P1-12 再删。

### 四、测试与翻译

22. **测试**：
    - 新增：`src/main/services/legacyAssets/__tests__/detectLegacyAssets.test.ts`（表驱动 52 例，临时目录 + 注入的家目录；另钉只读、pi 扩展不列、一类失败不连累、工作区路径过滤）；`src/main/ipc/__tests__/legacyAssetsIpc.test.ts`；`src/renderer/components/settings/__tests__/legacyAssetNoticeMount.test.ts`（`electronAPI.settings` 桩在 `vi.hoisted`）；
    - 补充：`settingsMainOwnedKeys.test.ts` 钉住新键归 Main 所有、拼写与 shared 一致；`piResources.test.ts` 加 `openAppSkills` 两例；
    - 删除：`subagentPanelMount.test.ts`、`subagentManagementModel.test.ts`。被测页面已经卸下，源文件留给 P1-12，测试不留；
    - 改写：`piResourcesSettingsStatic.test.ts`、`capabilityEntryStatic.test.ts`、`sessionCapabilityModel.test.ts`、`SettingsContent.test.ts`；
    - `piPluginsPermissionNoticeStatic.test.ts` 照 104 随 P1-10c 处理。它读的是 `PiPluginsSettings.tsx` 的源码，文件还在，所以照样通过。
23. **死翻译**：删掉只被本次拿掉的界面用到的 15 条：
    - 能力弹窗：`MCP servers, skills and sub-agents this chat brought up.`、`Pi extensions you install are loaded only by the built-in terminal.`、`No MCP servers configured`；
    - 资源页：`Pi Resources`、`Install skills and prompt templates where Pi can load them reliably.`、`This cross-agent location is always loaded…`、`This app’s Pi directory`、`Every session in this app…`、`Your personal Pi directory`、`Where the Pi CLI in your own terminal reads from…`、`Agent features`、`Open prompt templates folder`、`Open skills folder`；
    - 委派开关（由 Main 的功能表动态下发，页面拿掉后没有显示方）：`Sub-agents`、`Lets the model delegate work to background agents…`；
    - 只被卸下文件（`PiSubagentsSettings.tsx`、`PiPluginsSettings.tsx`）用到的文案随文件在 P1-12 删。

## 留给 P1-12 的无引用清单

本次只改入口与显示，下面这些在渲染层已经没有入口或调用方，照 104 第 5 条留到 P1-12 一起删：

- 渲染层：`src/renderer/components/settings/PiSubagentsSettings.tsx`（含 `SubagentPromptCacheTtlRow`，设置项 `subagentPromptCacheTtl` 随之没有编辑入口）、`subagentManagementModel.ts`、`PiPluginsSettings.tsx`（及其测试 `piPluginsPermissionNoticeStatic.test.ts`，归 P1-10c）；
- IPC 与 preload：`piSubagents:*` 全部 8 条（`src/main/ipc/piSubagents.ts`、`services/agent-host/subagentCatalog.ts`、`src/shared/types/subagentManagement.ts`）；`piPlugins:*` 4 条（`src/main/ipc/piPlugins.ts`、`services/piPlugins/`、`src/shared/piPlugins.ts`，除卸下的页面外没有别的调用方）；`piResources:updateSettings`、`piResources:openPromptTemplates`；
- Main 与 shared 字段：`PiResourceSettings` 的 `enableSubagents`、`features`、`paths.userSkills`、`paths.userPromptTemplates`、`paths.appPromptTemplates`；`getActivePiPromptTemplatesDir`；`agent-host/bundledPlugins.mjs` 的 `NATIVE_FEATURE_SWITCHES`（注释里还写着「驱动 Settings → Pi Resources 的开关」）；
- `WorkerCapabilityInventory` 的 `mcpServers`、`promptTemplates`、`subagents`：渲染层已不读，只剩 1.0.x runtime 在产出。

## 取舍

- **只列 1.0.x 真正读的那个指令文件（第 6 条）**：备选是三个都列，照 102 的字面意思。那样会把 1.0.x 从未读过的文件也说成「不再生效」，误导用户去搬一份本来就没生效的规则。
- **关闭即看过（第 14 条）**：备选是照 `AgentMigrationPrompt` 做「以后再说 / 不再提示」两个出口。那是给要用户做决定的弹窗用的；这里没有决定要做，第二个按钮只会让一条告知每次启动都回来。
- **插件页不留占位（第 19 条）**：备选是留一个空状态「白名单插件将在这里显示」，约 10 行加一条文案。P1-10c 与本任务同泳道、紧接着做，占位活不过一个任务。
- **检测放在 Main、渲染层每次启动问一次**：备选是 Main 在启动时主动推送。那样 Main 得知道渲染层何时就绪、当前是哪个工作区，比「渲染层带着工作区来问」多一条通道。

## 影响

- **用户看得见的不同**：
  - 升级后，有旧资产的用户会看到一次「以下内容在新版中不再生效」；
  - 「设置 > 扩展」只剩「技能」和「旧版遗留内容」两节：子代理页、pi 扩展页、模板目录、委派开关都不见了；
  - 能力弹窗只剩技能数。
- **迁移**：只读，不改任何用户文件；回装 1.0.x 不受影响（它不认识新设置键，会忽略它）。
- **与 P1-10c 的衔接**：插件页在「扩展」页上的位置空着，P1-10c 直接加一节白名单插件列表，并处理 `piPluginsPermissionNoticeStatic.test.ts`。
  - **补记（2026-09-28，[决策 117](117-p1-10c-plugin-settings-choices.md)）**：「插件」一节排在技能与旧版遗留内容之间；`piPluginsPermissionNoticeStatic.test.ts` 已删除，要点并入 `dshPluginsSettingsStatic.test.ts`（117 第 18 条）。上面「留给 P1-12 的无引用清单」里它随 `PiPluginsSettings.tsx` 一条不再适用。
