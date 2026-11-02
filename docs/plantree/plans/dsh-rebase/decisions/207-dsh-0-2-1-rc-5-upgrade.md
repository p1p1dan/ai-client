# 决策 207：DSH 升到 0.2.1-rc.5；支持模型换目录，子代理按「一律后台」重新设计

日期：2026-11-02。**状态：两个方向由用户 2026-11-02 定下（本次支持换目录；子代理按后台重新设计），按[决策 003](003-p0-closeout-enter-p1.md) 第 2 条与[决策 189](189-dsh-0-2-0-rc-2-upgrade.md) 的升级流程做。2026-11-02 用户看过预览后裁定：换目录一节按推荐做（含不出卡）；子代理不加输入框上方的条带，改为对话右栏里单独一张「子代理」卡片，参考 open-claude-ui（第 8 节）；用户级说明文件选方案 A（第 6 节）；测试可以随上游改，但先定规则与理想结果再测（第 12 节）。其余标「自主」的待用户审批；第 12 节是还要拍板的事。** 未推送、未合入；推送与合入前先经用户确认。

代码：本地分支 `feat/dsh-0.2.1-rc.5`，工作目录 `/home/pi/code/ai-client-dsh-upgrade`，基于 `c5860848`（本地 main 的 `61347bd9` 只比它多一个文档提交）。起点是 WIP 提交 `be840f56`（版本钉、cordis 4.0.5、锁文件、去掉 ralph），提交时关了钩子，2026-11-02 补跑 biome，无改动。

证据：[dsh-0.2.1-rc.5-upgrade-2026-11-02.md](../evidence/dsh-0.2.1-rc.5-upgrade-2026-11-02.md)（同一台 Linux 机器上的升级前后对照，脚本在同名目录 `scripts/`）。

修订关系：

- [决策 003](003-p0-closeout-enter-p1.md) 第 2 条：版本钉 `0.2.0-rc.2` → `0.2.1-rc.5`，「钉精确版本、锁文件入库、不自动追 rc」不变。
- [决策 189](189-dsh-0-2-0-rc-2-upgrade.md)：同一流程。`forkSeed.ts` 这次不用改代码，上游那段逐字未变。
- [决策 101](101-instructions-and-skills-dsh-native.md)（`<agentDir>` 的说明与技能）：DSH 不再接受我们指定说明目录的方式，做法要改（第 6 节）。
- [决策 169](169-plan-review-flow.md)（计划审阅）：「关闭审阅」由 DSH 改为成功并直接结束回合（第 5 节）。
- [决策 190](190-tool-gaps-web-fetch-grep-max-tokens.md) 与 P0-2「不连 DeepSeek 官方」：新行 `web-deepseek-api` 要关（第 4 节）。
- [决策 047](047-tool-classification-and-plan-mode.md)（工具分类）：新增 `working_directory`（第 7 节）。
- [决策 069](069-stop-and-background-lifecycle.md)、[201](201-send-now-keeps-subagents.md)、[202](202-background-subagent-row-and-synthetic-turn-send.md)、[203](203-stop-main-turn-background-and-subagent-page.md)、[206](206-turn-end-notes-subagent-window-and-status-counts.md)：子代理一律后台（第 8 节）。
- [决策 060](060-first-allowlist-pilot-office-tools.md)、[115](115-p1-10d-pilot-plugin-choices.md)：试点插件仍是 1.0.6。它的 peer `>=0.2.0-rc.1 <0.3.0-0` 按 npm 的规则不含 0.2.1 的预发布版，靠 `overrides` 装上；DSH 自己的兼容判断让预发布参与匹配，判为兼容（集成测试 `[PLG-6]` 通过）。

## 1 结论

- 升。上游接口大体没变，桥接、回路守卫、压缩、模型计划、思考回放都照旧成立：
  - 请求前缀与缓存探针 21/21；
  - 思考回放 A/B 与 0.2.0 计数相同；
  - 目标三种结局相同。
- 但「不改代码直接升」有 **6 个用户能碰到的缺陷**，都在本分支修（第 4 节）：
  1. 文件名搜索（glob）每次都失败；
  2. 计划审阅点「关闭」后显示成「已批准」；
  3. 用户在应用里写的全局说明（`<agentDir>/AGENTS.md`）不再送到模型，反而会读入用户真实的 `~/.agents/AGENTS.md`；
  4. 新加的 DeepSeek 官方搜索行没关；
  5. 打包脚本会因上游删包而失败，插件审计的报错文字变成 `undefined`；
  6. 两个同名子代理同时跑时，可能挂错到对方的委派行上。
- 两个大变化按用户定的方向做：
  - **换目录**：模型可以用 `working_directory` 改会话的当前目录。权限判断要跟着改，否则会出现「判在工作区内、实际在别处执行」的绕过（第 7 节）。
  - **子代理一律后台**：调用立即返回，跑完通知主对话。决策 202、203 为 Claude 引擎做的后台子代理那一套大部分能直接用，要补的是：回合外的子代理权限卡、主对话空闲时「子代理还在跑」的提示，以及停止规则文字（第 8 节）。
- 界面改动（换目录的显示、子代理的显示）先出 HTML 预览，用户认可后再做（第 11 节）。

## 2 对照上游

只有编译产物（没有上游 git），逐包比 `lib/` 与 `package.json`。随包没有升级指南或 CHANGELOG。

- **包与行**：
  - 删 5 个包：`dsh-client-connection`、`dsh-invariants`、`dsh-skill-badge`、`dsh-subagent-in-process-driver`、`dsh-tool-ralph`。
  - 增 4 个包：`dsh-api-remote-access`、`dsh-working-directory`、`dsh-tool-working-directory`、`dsh-web-deepseek-api`。
  - dsh-base 行 94 → 96：删 `skill-badge`、`tool-ralph`（两行上游原本就关着，`be840f56` 已从权限分类与工具名表去掉 ralph）；增四行。
  - 我们补丁和宿主代码引用的行 id 全部还在。
  - `remote-access` 只是「非所有者远程调用的方法级访问策略」，给 API 网关用，自己不开端口、不建连接。我们的组合不挂 Web 网关，跟随 DSH 不关。
- **cordis** 4.0.4 → 4.0.5，`cordis-plugin-group` / `include` / `loader` 跟到 1.0.5 / 1.0.10 / 1.0.6（`dsh-app-boot` 的 peer 要求），已在 `be840f56`。
- **我们用到的钩子与服务**：
  - 只改了版本号或生成文件：fs、user-approval、attachment、goal、skill、launch-environment、compaction、user-questions、commands、agent。
  - 有实质变化：
    - **system-prompt**：上下文项可标 `required`、关插值；agent-loop 改为**每个请求前**重算运行期上下文，文字变了才追加一条 `runtime-context` 消息；不再注册 `cwd` 提示词变量。前缀探针 21/21，没有多出的前缀断裂。
    - **agent-instructions**：项目根按会话**当前目录**找；用户级说明改成两个根（第 6 节）。
    - **subagent**：大改，见第 8 节。
    - **jobs**：作业 id 改成 `<种类>-<16 位十六进制>`；日志里新记 `job/registered` / `job/settled`，前台 `bash` 也记；作业带上发起它的工具调用 id。唤醒与通知的路径没变。
    - **app-boot**：`evaluatePluginCompatibility` 的结果字段 `peers` 改名 `requirements`；我们调用的 15 个成员都还在。
    - **tools**：去掉展示模式 `both`；嵌套调用也跑 `presentationMeta`。我们没用到。
    - **home-paths**：新增 `resolveAgentsHome`（`$DSH_AGENTS_HOME` 或 `~/.agents`）。
- **dsh-session**：`buildForkSeed` / `openTurnClosers` / `ToolCallRecovery` 逐字未变，`forkSeed.ts` 只更新注释里的版本与行号；新认识三种日志事件 `job/registered`、`job/settled`、`working-directory/change`。
- **dsh-llm-pi-ai 与 pi-ai**：
  - `COMPAT_GATES` 逐字未变，`src/shared/dshModelPlan/tables.ts` 的静态副本照旧成立（只更新行号）。
  - pi-ai 0.87.1 → **1.4.0**（大版本），带动 `@anthropic-ai/sdk` 0.124 → 0.129、`openai` 6.40 → 7.19。
  - `detectCompat` 逐字未变，自定义服务四家预设照旧成立。
  - 历史中段的系统消息改以 `system` 角色交给 pi-ai；User-Agent 改由 `getIdentityHeaders` 给，`[UA-1..3]` 都过。
- **模型能看到的变化**：
  - 新工具 `working_directory`；
  - 每个会话的上下文多一行 `Current working directory: "<目录>".`，真正换目录时注入一条通知；
  - `bash` / `pwsh` 说明要求先写 `description` 再写 `command`，结果带 `cwd`；
  - `write` / `edit` 的结果路径改为绝对路径；
  - `subagent` / `subagent_fork` 去掉 `run_in_background`、加 `cwd`；
  - 计划模式提示词措辞改了。
  - 已有会话升级后第一次请求因工具定义变化重建一次缓存，与任何 DSH 升级相同。

## 3 测试前后对照

详见证据。「0.2.1」一列是**还没为新版改代码**时的结果。

| 检查 | 0.2.0-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| 宿主 tsc | 0 错 | 0 错 |
| 根 tsc | — | 1 错，**主检出同样有**，与升级无关（第 10 节） |
| 全量单测 | 796 文件通过 | 3 项失败（第 4 节 ⑤，第 7、10 节） |
| 真宿主集成 56 项 | 全过 | 54 过：挂 `[190-I-2]`（第 4 节 ④）、`[PLN-3]`（第 5 节） |
| 桥接录制 37 场景 | 无差异 | 69 个文件有差异；屏蔽编号后移后，应用收到的内容只有 3 个场景不同：`perm-search`（搜索失败）、`perm-subagent`（子代理后台）、`plan-dismiss`（关闭审阅即结束） |
| 请求前缀探针 | 21/21 | 21/21 |
| 回路守卫冒烟 | 33/33 | 30/33（第 8 节） |
| 桥接冒烟 | 72/72 | 71/72（第 6 节） |
| 目标探针 | 24 个工具，三种结局到达 | 25 个工具（多 `working_directory`），三种结局到达 |
| 思考回放 A/B | 50 / 43 / 29 原样 | 相同 |

## 4 升级带来的缺陷与修法（都在本分支修）

| # | 用户看到的 | 原因 | 修法 |
|---|---|---|---|
| ① | 模型按文件名搜索（glob）每次都报错 | 我们的搜索行复用上游的 `applyGlobTool`，它现在读会话当前目录，我们的行没声明 `workingDirectory` 注入 | `fsSearch/plugin.ts` 的注入加 `workingDirectory`；我们自己的 grep 也改按当前目录（第 7 节） |
| ② | 计划审阅点「关闭」后，工具行写「已批准」 | DSH 把关闭改成成功结果，我们只从失败结果里读关闭 | 第 5 节 |
| ③ | 应用里写的全局说明不再生效，用户真实的 `~/.agents/AGENTS.md` 会被读入 | DSH 不再接受行配置里的说明目录 | 第 6 节 |
| ④ | 平时没有影响；关掉网页抓取时宿主组合普查报错 | 新行 `web-deepseek-api` 会连 `api.deepseek.com`，我们没关 | 加进 `REQUIRED_DISABLED`（「任何行都不连 DeepSeek 官方」那一组）与 bundle 补丁 `disabled: true` |
| ⑤ | 打包失败；插件审计的报错写 `undefined` | 打包必备清单还要求已删的 `dsh-skill-badge` 的文件；兼容结果字段改名 | 清单与注释去掉 `dsh-skill-badge`；报错文字读 `requirements`（兼容旧名） |
| ⑥ | 同时委派两个描述相同的子代理时，活动可能挂到另一行 | 子代理调用的结果换成 `{kind:'activation', subagentId}`，桥接不认，退回按描述配对 | `bridge/subagents.ts` 认 `activation`，按 id 配对 |

## 5 计划审阅「关闭」（跟随 DSH）

- **DSH 的新做法**：关闭审阅时工具返回成功，文字是 "The user dismissed the plan review to reply in their own words; plan mode remains active."，并结束本回合，模型不再多回一句。之前是返回失败，模型还会再走一步。仍在计划模式。
- **改法**：
  - 读工具行结果的 `planReviewRowOutcome` 同时认新旧两种文字（旧会话回放还是旧文字），关闭的行写「审阅已关闭」，不再写「已批准」。
  - **自主**：我们自己做的 `create_goal` 审阅（决策 169）关闭时也照 DSH 结束回合，文字统一成 DSH 的新文字。实现时核对我们拿到的调用对象上有没有 `concludeTurn`；没有就保持现状并记下。
  - Claude 引擎的关闭不变（它走 SDK 的拒绝加中断）。
  - **实现时核对结果（2026-11-02）**：上游的「结束本回合」只能挂在**成功**结果上，而 `create_goal` 的成功结果文字由它自己的输出格式生成（写的是目标），放不进「审阅已关闭」的说明。所以 `create_goal` 审阅的关闭**保持现状**（失败结果 + 旧文字，模型再回一句后停下），界面读法不受影响。
- **测试 `[PLN-3]`**：它的意图「关闭后模型停下，下一条消息仍在计划模式」在新版上成立，只是断言写死了 DSH 旧版的「失败 + 旧文字」。按决策 090「默认跟随 DSH」，要把断言改成新契约（成功、新文字、没有多出的模型请求）。**这是改测试，需用户同意**（第 12 节）。

## 6 用户级说明文件（决策 101）

- **变化**：
  - `dsh-agent-instructions` 的行配置去掉了 `dshHome`，我们 `agentDirOverlays()` 传的 `<agentDir>` 被静默丢掉，用户级说明改从宿主私有的 `$DSH_HOME/AGENTS.md` 读，那里没有文件。
  - 新增第二个用户级根：`$DSH_AGENTS_HOME`，没设就是 `~/.agents`。这是 Codex 等工具共用的目录，**用户真实的 `~/.agents/AGENTS.md` 会进 PiLab 的每个会话**（读代码得出，未用探针证实）。
  - `~/.agents/skills` 在 0.2.0 就会读，不是新变化。
- **方案 A（用户 2026-11-02 选定）**：宿主环境设 `DSH_AGENTS_HOME=<agentDir>`。
  - `<agentDir>/AGENTS.md` 作为共享用户级说明载入，决策 101 恢复；
  - `~/.agents/AGENTS.md` 不读；
  - 为了不改变技能，把 `~/.agents/skills` 显式加进技能目录（原来就会读的）。
  - 改动小，桥接冒烟的 `agentDirOverlaysReachedFirstRequest` 可以直接验证。
- **方案 B**：跟随 DSH，`~/.agents/AGENTS.md` 也读；`<agentDir>/AGENTS.md` 改由我们自己的上下文行送。好处是和其他 AI 工具共用一份说明；坏处是要自己写一行、和 DSH 的同名去重逻辑分开，用户在应用外改的说明会悄悄影响 PiLab。
- 用户 2026-11-02 选 A。

## 7 换目录（用户定本次支持）

**DSH 的做法**：

- 会话有一个「当前目录」，初始就是工作区（`header.cwd`，它永远不变）。
- `working_directory({cd})` 接受绝对路径或相对当前目录的路径，目标必须是存在的目录。它不检查是否在工作区内，自己不要审批，也不改任何权限。执行时独占，不和同一步的其他调用并发。
- `fs` / `bash` / `pwsh` / 搜索 / 技能 / 项目说明的相对路径都按当前目录算。
- 真正换了目录时，给模型注入一条通知；上下文里那行 `Current working directory` 跟着变。
- 当前目录被删了，自动退回工作区并通知模型。
- 恢复、分叉、回退都保留当前目录（日志投影重放）。子代理默认继承父会话的当前目录，也可以用 `cwd` 参数指定。
- DSH 自己的沙箱策略仍以工作区为可写根。

**我们的规则（自主）**：**相对路径按当前目录解析；「在不在工作区内」仍按原工作区判。**

| 位置 | 改法 |
|---|---|
| 权限行 `permissionHost.ts` 三处（判定用的目录、搜索结果过滤、卡片上的路径） | 改用 `workingDirectory.ensure(调用方)`，取不到退回 `header.cwd`。按调用方取，子代理用自己的 |
| `fsSearch/grepTool.ts` | 同上 |
| `dshSessionRuntime.ts` 技能计数 | 同上，与 DSH 的技能工具一致 |
| 插件工具（`dsh-office-tools`） | **不变**：它自己按 `header.cwd` 解析路径，权限也按工作区算 |
| 工作区边界、策略、信任、授权的显示、自动审阅、Main 的工作区校验 | **不变**，仍是原工作区 |
| `environmentContext.ts` / `permissions/plugin.ts` 给模型的环境说明 | **要改写**。现在写「工作目录是 X，相对路径按它算，别处说的工作目录不适用」，和 DSH 的 `Current working directory` 正面冲突。改成「工作区（项目根）是 X；当前目录见 Current working directory 一行」 |
| `shellWorkdir.ts` 的提示文字 | 「省略 workdir 就在会话工作区运行」改成「在当前目录运行」 |

**权限（用户 2026-11-02 同意按推荐，按 Claude Code 的原则「换目录不扩大权限」）**：

- `working_directory` 归「内部」类，不出审批卡，**包括换到工作区外**。它本身不读不写。换到工作区外之后的每次读、搜、命令仍按工作区边界照常询问，再给换目录本身加卡只是重复问一遍。
- `subagent` 的 `cwd` 参数同理。
- 自动审阅的「只读工具」名单不加它，让审阅模型看得到换目录。

**界面（预览 `docs/design/2026-11-02-working-directory-preview.html`，用户 2026-11-02 认可推荐项）**：

- 时间线上换目录的工具行：「切换目录 → <路径>」，失败时写原因；不带参数的调用写「查看当前目录」。
- 当前目录和工作区不同时，在输入区的工作区标签旁显示一个次要标签；在工作区外时用警告色并写全路径，回到工作区就消失。会话投影加 `workingDirectory` 一项，宿主经 `session.projection` 发出。
- 工具行里的路径显示成相对工作区（在子目录里写的 `src/main.ts` 显示为 `packages/web/src/main.ts`），在工作区外显示完整路径。
- 工具结果里的相对路径（点击打开文件、搜索命中）按**调用那一刻的目录**解析，不再一律接到工作区上：历史投影按日志顺序记下 `working-directory/change`，给之后的工具行打上当时的目录。
- 「在 <仓库> 中运行」之类的字样，在工作区外时改为显示实际目录。

## 8 子代理一律后台（用户定按后台重新设计）

**DSH 的新语义**（读代码，并用真宿主实验核对，见证据第 6 节）：

| | 0.2.0-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| 调用方式 | `subagent` 默认前台，主回合等它跑完拿结果；`run_in_background` 可选后台；`subagent_fork` 一次性前台 | 一律后台，没有任何「等结果」的选项；立即返回 `started subagent <id>` |
| 结果怎么回来 | 前台：作为工具结果；后台：结束通知 | 子代理结束时，主对话收到一条用户角色通知（"Background subagent <id> finished…" 加子代理最后的话）：主对话空闲就**自己开一个回合**，忙就插进当前回合。另外子代理被要求结束前用 `send_message` 向主对话汇报，空闲时同样会唤醒一次 |
| 子代理的权限卡 | 前台：出现在主回合里 | **经常在主回合结束、会话已空闲时出现**，不属于任何回合 |
| 停止主回合 | 前台子代理跟着结束 | 子代理不受影响；只有「全部停止」或关会话才停 |
| 并发上限 | 一次性子代理不计 | 每棵会话树最多同时 8 个（含 fork），超出直接报错，不排队 |

**我们已有的（决策 202、203、206，为 Claude 引擎的后台子代理做的）大部分能直接用**：

- 委派行在调用结束、子代理还在跑时显示「后台运行中」；
- 子代理泳道；
- 子代理窗口只列运行中的、可「全部停止」、可「查看对话」；
- DSH 自己开的回合（「子代理已完成，自动继续」）与这时发送改插话；
- 停止按钮只停主回合。

录制里原来就是后台模式的 `sub-cont` 场景，升级后应用收到的内容没有变化。

**要改的**：

1. **配对**：见第 4 节 ⑥。原来前台、一次性子代理专用的代码（`runs` 配对表、`foreground` / `background` 结果、DSH 的一次性子代理作业停止）对 DSH 不再走到，Claude 引擎仍用，保留。
2. **回合外的权限卡**（实验已证实会出现）：渲染端会把它挂到最近一条助手消息上并放进待审队列，按代码能显示能操作，但界面没实查。设计上要让人看出是**哪个子代理**在问、主对话此刻空闲；会话列表与侧栏的「待你处理」也要算上它。进预览。
3. **主对话空闲、子代理还在跑**（「等待子代理」）：以前主回合会一直等，现在模型说一句「已派出」就结束回合。用户 2026-11-02 先否了输入框上方的条带，又定：**子代理在对话右栏（会话侧栏）里单独一张卡片**，参考 open-claude-ui 的多代理看板（`code-examples/CoworkAgentCanvas.tsx`：成员行写名字、状态 `running` / `waiting_review` / `completed` / `errored`、角色、当前任务，选中后看详情与操作）。预览 v3：`docs/design/2026-11-02-subagents-background-preview.html`。
   - 卡片 id `subagents`，排在「待办」之后、「服务」「运行中」之前；本会话没派过子代理就不画。卡头「子代理」，右端「N 运行中」，有等确认的写「N 等你确认」配 `waiting` 圆点。
   - 每个子代理一行三层：名字 + 状态字（运行中 / 等你确认 / 已完成 / 出错 / 已打断）；类型或「分叉」+ 模型；正在做什么（泳道最近一次工具调用）+ 时长，结束后换成用时、用量、工具次数。数据都在现有泳道里（`SubagentLane`，含 `pendingPermission`）。
   - 点一行展开「查看对话」（决策 203 的子对话页）与「打断」。**自主**：不做 open-claude-ui 的「发送协同指令」（决策 203 第 7 节第 5 条定过只读）。
   - 「运行中」卡片只留命令与工作流，不再列子代理（决策 206「不重复」）；顶栏「后台任务」按钮与面板不变。
   - 已结束的子代理：留在卡片里折成「已结束 N ›」，点开能再看对话（用户 2026-11-02「按推荐」）。这一条只管右栏卡片；决策 206 第 5 项的子代理窗已并入「后台任务」面板，那里不变。
4. **停止规则文字**（决策 203）：DSH 停止按钮的提示「停止当前回合 — 后台子代理继续运行」现在对**所有** DSH 子代理都成立（含 fork），文字不变；后台任务面板里的停止对 DSH 子代理全部是「打断」（都可续聊）。决策 203 的条文照此改写，不改行为。
5. **唤醒次数与费用**：一个子代理最多唤醒主对话两次（汇报一次、结束通知一次），各算一个回合、一次计费。假网关没测到汇报那条路，要在实现时补一个假网关脚本测出顺序。**自主**：先不加上限，在决策里记下观察项；用户若在真实模型上觉得吵，再按回路守卫的唤醒上限做。
6. **8 个并发上限**：超出时子代理行显示 DSH 的报错原文，不另做排队。
7. **子代理页**（决策 203 第 6 节）：读子会话日志的做法不变。**自主**：仍只读，不在页内给子代理发消息（DSH 有 `send_message`，要放开另行决定）。

**录制与探针**：

- `perm-subagent` 场景改为等回合外的卡与唤醒回合（照证据第 6 节的实验）；
- 假网关 `P1-PERM-SUB` 去掉已无意义的 `run_in_background:false`；
- 回路守卫冒烟的 G7 改成等子代理结束再收集；G3 改成 8 个以内，另加一条「第 9 个报上限错误」。
- 这些是**测试工具随上游语义改**，同第 12 节一并请用户同意。

## 9 其他变化（不用改，或只改注释）

- 作业 id 变长（`bash-<16 位十六进制>`）：界面里按 `bash-N` 写的注释改掉；作业窗显示的是标签，不受影响。
- `write` / `edit` 的结果路径变成绝对路径：审批卡的改动对比来自我们自己的卡片数据，录制里 `perm-card` 等场景应用收到的内容没变；工具行显示路径时已按工作区取相对路径。实现时用新录制核对一次。
- 每个请求前重算上下文：我们的环境说明、权限说明只有在换目录或换档位时才会变，前缀探针没有多出断裂。
- `session-title-llm` 的输出上限 64 → 4096：这一行我们关着。
- `remote-access`：见第 2 节，跟随 DSH。

## 10 与升级无关、顺带记下的

- **根 tsc 1 错**：`src/shared/__tests__/fixtures/pilabExperience.ts:25`（`EventOf<T>` 与 `PermissionActivityEvent` 对不上），主检出 `61347bd9` 上同样存在，来自 `51fe766a`，与 DSH 升级无关。**不在本分支修**：用户 2026-11-02 已明确不许用改测试夹具的类型断言（如 `as unknown as`）来消掉它，应查清是产品代码的事件类型哪里不对再修；也不混进升级的提交。另开话题。

## 11 分阶段实现（每阶段一个本地提交，阶段看板见 [dsh-0.2.1-upgrade-tasks.md](../dsh-0.2.1-upgrade-tasks.md)）

| 阶段 | 内容 | 前提 |
|---|---|---|
| 1 | 不涉及界面的修复：第 4 节 ①④⑤⑥、第 5 节读结果、第 6 节（按用户选的方案）、工具分类与工具表、`forkSeed` 注释、`perm-subagent` 场景与回路守卫 G3 / G7（不涉及界面，随桥接基准一起定）；按第 14 节先定后测；重录桥接基准 | 第 12 节 1、2 |
| 2 | 换目录的权限与模型说明（第 7 节表格）；新增权限单测，例如「cd 到工作区外后，不带路径的 glob 按外面判」 | 无 |
| 3 | 换目录的界面 | 已认可（2026-11-02） |
| 4 | 子代理后台的界面与停止规则文字（第 8 节 2、3、4） | 已认可（2026-11-02，预览 v3） |
| 5 | 收尾：小批串行跑全量测试、集成测试、录制、四个探针；全过之后在隔离环境 `/tmp/pilab-r0` 加假网关查真实界面；更新证据与本决策 | 前四阶段完成 |

## 12 要用户拍板的事

1. ~~用户级说明文件~~：用户 2026-11-02 选方案 A。
2. ~~随上游语义改测试~~：用户 2026-11-02 同意，**条件是先定测试规则和理想结果，再去测**，不能等测试跑出问题再反过来改测试。照第 14 节执行。
3. ~~换目录不出卡~~：用户 2026-11-02 同意按推荐。
4. ~~两个界面预览~~：换目录按推荐；子代理右栏卡片按预览 v3 的推荐（用户 2026-11-02）。

## 13 没验证的

- 修复后的整轮复跑（第 5 阶段）。
- 子代理用 `send_message` 汇报的实际顺序；`~/.agents/AGENTS.md` 被读入（读代码得出）。
- 回路守卫在后台子代理上的截断与上限（探针没等到子代理）。
- 整包构建与打包冒烟、Windows、加密机。
- 真实界面。

## 14 测试规则与理想结果（先定后测，用户 2026-11-02）

执行顺序固定：**① 在本节写下规则与理想结果 → ② 按本节改测试或新增测试 → ③ 再跑**。跑出来和本节不一致时，**修产品代码，不改本节、不改测试**；确实是本节写错了，先停下来改本节并说明理由，再测。下表是阶段 1、2 要动的测试；阶段 3、4 的界面测试在动工前按同样格式补进本节。

**A. 随上游改的测试（契约变了）**

| 测试 | 规则 | 理想结果 |
|---|---|---|
| `[PLN-3]` 关闭计划审阅（`dshSharedHost.integration.test.ts`） | 关闭审阅 = 结束本回合、留在计划模式 | 卡片收起，`question.resolved` 为 `cancelled`；`exit_plan_mode` 的工具结果是**成功**，文字含 "dismissed the plan review"；关闭之后本回合**没有新的模型请求**（假网关请求数不增）；没有 `session.permissions`；下一条消息再次出审阅卡 |
| `planReviewRowOutcome` / 工具行字样（`src/shared/__tests__/planReview.test.ts`、渲染端；读录制历史的 `src/shared/dshHistory/__tests__/dshHistoryGolden.test.ts` 的 plan-dismiss 一项，2026-11-02 重录后补进本行：两次关闭都是**成功**结果、按结果文字读出「已关闭」） | 新旧两种关闭文字都认 | 新文字（成功结果）→「审阅已关闭」；旧文字（失败结果，旧会话回放）→「审阅已关闭」；批准仍是「已批准」；其他成功结果不误判 |
| `permissionsClassification` | 已装 DSH 的每个工具都有分类 | `working_directory` 归内部类、不出卡；没有未分类工具，也没有多余条目 |
| `dshToolVocabulary` | 工具表与分类表一一对应 | 没有 `ralph`；有 `working_directory`，带 `cd` 时动词「切换目录」、参数是目标路径，不带参数时「查看当前目录」 |
| `perm-subagent` 录制场景 | 子代理后台：父回合先结束，子代理的卡在回合外出现 | 父回合：委派行结束、结果是 `started subagent <id>`、回合 idle；之后出现 `permission.requested`，带 agentId、不带 requestId；答「允许」后子代理的命令执行、子代理结束；DSH 自开一个回合，来源是子代理完成 |
| 回路守卫冒烟 G3 | 一次派出不超过 8 个；守卫不截正常的并发委派 | 一个回合派 8 个：8 个调用全部成功、无报错、回合正常结束。另加 G3b：子代理放慢（每个约 3 秒），一个回合同时派 9 个：恰好 1 个调用失败，结果文字含 DSH 的上限原文 `subagent limit reached (active child limit: 8)`（错误码 `ACTIVATION_LIMIT_REACHED`），其余 8 个成功，回合正常结束，不排队、不重试 |
| 回路守卫冒烟 G7 | 守卫对后台子代理同样生效 | 父回合结束后，等两个新子会话各自出现回合结束（最多 120 秒）再收集：一个子代理的重复调用回复被截断（1 次请求、0 次工具执行、`tool_call_repetition`）；另一个子代理的无限读取撞到步数上限；两个父会话都正常结束。子代理结束通知唤醒父会话时，假网关只回一句话，不再派活 |
| `aiclient-fs-search` 的注入（`fsSearch/__tests__/plugin.test.ts`；打包测试 `scripts/__tests__/dsh-host-build-lib.test.mjs` 的 `ROW_INJECT` 也写死了这一项，2026-11-02 跑之前补进本行） | 我们这行替代 `dsh-tool-fs-search`，复用它的 glob，所以注入与它一致 | 注入列表等于已装 `dsh-tool-fs-search` 导出的 `inject`（0.2.1 是 `tools`、`systemPrompt`、`subprocess`、`workingDirectory`），不再写死三项 |
| `agentDirOverlays` 单元测试（`src/dsh-host/lib/__tests__/hostProfile.test.ts`，2026-11-02 动工时补；`src/main/services/agent-host/__tests__/dshSkillCatalog.test.ts` 的「技能目录取自同一个 `<agentDir>`」写死了技能行的单行原文，跑之前一并补进本行，只改成核对 `customSkillDirs` 仍是 `<agentDir>/skills`） | 0.2.1 的说明行不再接受 `dshHome`，用户级说明改由环境变量 `DSH_AGENTS_HOME=<agentDir>` 指过去（方案 A）；技能行要显式写回原来的 `~/.agents`，否则技能根也会跟着换到 `<agentDir>` | 说明行的配置只有 `maxBytes: 65536`，不带 `dshHome`；技能行是 `customSkillDirs: ['<agentDir>/skills']` 加 `agentsHome: <调用方给的 ~/.agents>`；没给 `<agentDir>` 时两行都不加 |
| `host.ts` 组合顺序静态测试（`src/dsh-host/__tests__/hostStatic.test.ts`，2026-11-02 动工时补；跑之前补进本节，理由：方案 A 要在改写环境变量之前先算出原来的共享根，所以调用多一个参数，测试写死了旧的调用原文） | 覆盖层顺序不变：模型计划两行 → `<agentDir>` 两行 → 必关的行 → 必开的行，都在用户层之后 | 顺序同前，`<agentDir>` 两行的调用是 `agentDirOverlays(agentDir, sharedAgentsHome)`；另加两条：共享根在设 `DSH_AGENTS_HOME` 之前算出；`DSH_AGENTS_HOME` 在抓启动环境（`createLaunchEnvironmentSnapshot`）之前设好 |
| 录制工具的编号归一（`src/dsh-host/tools/bridge-record.ts`，2026-11-02 重录后补：0.2.1 的作业 id 是随机的 16 位十六进制，录两次就不一样，对比永远不过） | 随机编号按出现顺序换成固定编号，和 UUID、命令 id 的做法一样；不改任何场景的内容 | 金样本里作业 id 写成 `bash-job-N`（单独计数，不挤占消息等其他编号）；更新后连跑两次 `--check` 都是 0 处差异 |
| 回退 / 分叉的切点（`src/dsh-host/bridge/__tests__/forkSeed.test.ts`，2026-11-02 重录后补：它按金样本的日志序号写死了切点，0.2.1 每次命令多记 `job/registered`、`job/settled` 两条，之后的序号整体后移） | 切点落在同一个事件上，只是序号变了 | 逐个核对过新旧日志：`tool` 的步骤切点 13→15、回合结束 17→19，`stop-tool` 14→16（仍是用户停止的回合结束），`crash-resume` 14→15，`compact` 31→33（仍是 `/compact` 的 `command/done`），`fail` 与提示词切点不变；种子测试的序号同样后移；切点处的事件类型与内容和升级前相同 |
| 桥接基准重录（37 个场景） | 只允许第 4 节与证据第 4 节列出的差异 | 允许：编号整体后移、`working-directory:current` 一节、工具表多 `working_directory`、`job/registered` / `job/settled`、作业 id 变长；压缩之后 DSH 内部日志多一条运行环境快照（`runtime-context`，2026-11-02 重录前补：0.2.1 的 `dsh-agent-loop` 在压缩替换掉原来那条环境消息后，下一步重新发一次；只在 `auto-compact`、`overflow-compact` 的 `log.*` 里，应用收到的 `stream.*` / `rpc.*` 不变）；`perm-search` 搜索成功、`perm-subagent` 按上一行、`plan-dismiss` 按 `[PLN-3]`。**其他任何差异都按缺陷处理**，修产品代码，不重录 |

**B. 不改测试、只修产品代码**

| 测试 | 理想结果 |
|---|---|
| `[190-I-2]` 两个开关都关 | 组合普查没有未起来的行（`web-deepseek-api` 被关掉而不是起不来）；DSH 自己的 grep，没有 `web_fetch` |
| `dsh-plugin-allowlist` 插件审计坏样本 | 报错写出不满足的依赖（`dsh-llm`、`0.1.5`）和 `(no exemption)`，没有 `undefined` |
| 桥接冒烟 `agentDirOverlaysReachedFirstRequest` | `<agentDir>/AGENTS.md`、项目 `CLAUDE.md`、技能正文都在第一个请求里 |
| 桥接录制 `perm-search` | `glob` 与 `grep` 都成功，结果与升级前相同 |

**C. 新增的测试（阶段 1、2）**

| 测试 | 规则 | 理想结果 |
|---|---|---|
| 用户级说明（方案 A） | 只读 `<agentDir>/AGENTS.md` | 在 `<agentDir>` 与一个假 HOME 的 `~/.agents/` 各放一份带不同标记的 `AGENTS.md`：第一个请求里只有 `<agentDir>` 的标记；`~/.agents/skills` 下的技能仍出现在技能清单里 |
| 新行关闭 | 任何行都不连 DeepSeek 官方 | `web-deepseek-api` 在 `REQUIRED_DISABLED` 里；用户层补丁打开它也会被重新关掉 |
| 子代理配对 | 按 id 配对 | 同一回合派两个描述相同的子代理，各自的活动挂在各自的委派行下，不串 |
| 打包必备清单（`scripts/__tests__/dsh-host-build-lib.test.mjs`） | 只要求存在的包；文档 Markdown 照删、运行期 Markdown 照留 | 必备清单里没有 `dsh-skill-badge`；保留判定的样例换成 0.2.1 仍有的运行期 Markdown（`dsh-sandbox-windows-acl/assets/…/SKILL.md`，按路径读取的随包技能）；原「必备的 dsh-badge.md 被删时报错」一项随包一起去掉（0.2.1 里没有按路径必读的 Markdown 了，「缺必备文件就报错」由清单里其余文件的用例继续覆盖） |
| 换目录后的权限（阶段 2） | 相对路径按当前目录，边界按工作区 | ① cd 到工作区外，不带路径的 `glob` / `grep` / `bash` 按「工作区外」询问；② cd 到工作区内的子目录，`read src/a.ts` 判为工作区内、卡片路径是子目录下的那个文件；③ cd 本身不出卡；④ 子代理按自己的当前目录判；⑤ 插件工具仍按工作区解析 |
| 给模型的环境说明（阶段 2） | 不和 DSH 的当前目录一行冲突 | 环境说明写「工作区（项目根）」，不再写「相对路径按它算」「别处说的工作目录不适用」 |
