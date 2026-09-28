# 决策 104：用一处「旧资产一次性提示」取代 P1-16d 与原方案里分散的各页说明；「扩展」设置页与能力弹窗按 DSH 收窄

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md)：062 / 070 的裁决要求「检测到 1.0.x 用户写过的自定义子代理定义时，告诉用户 DSH 版不再加载它们」；063 的裁决要求 pi 扩展「彻底去掉，不留提示入口」；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-6、16-9、16-11、16-12；
- [P1-10 / P1-16 方案 §4.4](../topics/p1-10-p1-16-extensions.md)；
- [决策 087](087-subagent-catalog-move-and-fixture-relocation.md)（`src/shared/subagentCatalogRoots.ts` 保留作检测用）。

## 规则

1. **一次性提示**：Main 在 DSH 版首次启动时给出一次提示，设置页「扩展」里另有一处常驻入口可以再看。提示列出检测到、但 DSH 版不再使用的 1.0.x 资产：
   - 自定义子代理定义：`<agentDir>/subagents/*.md`、`~/.agents/subagents/*.md`。按决策 090 的要求做，检测复用 `src/shared/subagentCatalogRoots.ts`，内置的 4 个不算；
   - 提示词模板（[决策 103](103-drop-prompt-templates.md)），附改写成技能的说明；
   - 用户层指令文件（[决策 102](102-drop-user-layer-instruction-files.md)），附「请放进 `<agentDir>/AGENTS.md`」的说明；
   - `mcp.json` 三层（`<agentDir>/mcp.json`、`.pi/mcp.json`、`.pi/mcp.local.json`）：只列文件与服务器名，说明新版暂不支持 MCP（决策 090）；
   - DSH 不会加载的技能：缺 `name`、名字不是小写短横线、多层目录、放在 DSH 不扫的根（决策 064 第 2 条、[决策 101](101-instructions-and-skills-dsh-native.md) 第 4 条），用 1.0.x 规则扫出来再按 DSH 规则判定；
   - 用户显式关过的委派总开关（[决策 105](105-drop-delegation-switch.md)）。
   - **pi 扩展不列**：决策 090 要求彻底去掉，不留提示入口。
2. **只读**：只列名字与原因，不改、不删、不移动用户文件。看过之后记一个设置键，不再自动弹出。
   - 检测在 Main 里做，只需要目录列表与 frontmatter。技能与子代理的名字要读 frontmatter；在加密机上，`.md` 不在 node 读不出的 9 类扩展名里（P1-13b）。
   - 项目级的 `.pi/prompts`、`.pi/mcp.json` 只在打开对应工作区时检测。
3. **「扩展」设置页收窄**：
   - 「子代理」页删除：定义不再加载，编辑它们会误导用户；
   - 「资源」页只留技能目录入口（`<agentDir>/skills`、`~/.agents/skills`）和 DSH 的技能规则说明，去掉模板入口；
   - 「插件」页归 P1-10c（DSH 白名单插件），pi 扩展部分整块删除（决策 090）；
   - 原方案里的「MCP `env` 提示」「子代理 `permission` 按继承」说明不再需要。
4. **能力弹窗**（`LeftDock.tsx:438-540`）：去掉 MCP 服务器、模板数、子代理定义数，以及「pi 扩展只在内置终端加载」那句；只留技能数（决策 099 第 12 条）。
5. **删除时点**：IPC `piSubagents:*`、Main 的 `subagentCatalog.ts`、`PiSubagentsSettings.tsx`、模板相关界面等，在 P1-12 删；本决策只改入口与显示。

## 取舍

- **取代原方案里分散的说明**：技能兼容报告页、子代理页的 `permission` 注记、MCP `env` 提示、pi 扩展只读列表，合计约 0.5～0.7 人周，还要维护四处界面；一处提示覆盖全部，约 2 人日，加上页面收窄约 1 人日。
- **完全不做提示**：违反决策 090 对自定义子代理的要求；用户会以为资产丢了。
- **代价**：提示是一次性的，用户看过就不会再被提醒；常驻入口放在「扩展」页里。
- **用户看得见的不同**：「扩展→子代理」页不见了；升级后看到一次「以下内容在新版不再生效」的列表；能力弹窗变简单。

## 影响

- **测试**：
  - 新增 Main 检测模块单测（表驱动：子代理、模板、指令、`mcp.json`、不合规技能、总开关）；
  - 渲染层提示组件挂载测试，`electronAPI.settings` 桩要放 `vi.hoisted`；
  - 删除或改写：`subagentPanelMount.test.ts`、`subagentManagementModel.test.ts`、`piResourcesSettingsStatic.test.ts`、`capabilityEntryStatic.test.ts`、`sessionCapabilityModel.test.ts`、`SettingsContent.test.ts`；`piPluginsPermissionNoticeStatic.test.ts` 随 P1-10c 处理；
  - `i18nCoverage.test.ts`、`noHardcodedChinese.test.ts` 覆盖新文案。
- **与其他任务**：P1-10c 的插件页与本决策同一泳道串行；P1-9e 原计划的三条设置页说明可以并进这处提示。
- **迁移**：只读，回装 1.0.x 不受影响。
