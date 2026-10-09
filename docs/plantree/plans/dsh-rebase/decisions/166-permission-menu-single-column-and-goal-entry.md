# 决策 166：权限菜单改为单列五个预设，菜单里加「设定目标…」，发起目标时自动切到「全自动」

日期：2026-10-09。**状态：第 1～3 条为用户裁决 2026-10-09；第 4～12 条为自主决定，待用户审批。** 原第 4、5 条（plan 模式拒绝模型建目标、plan 提示词改写）按用户意见推迟，见第 13 条。

来源：GitHub issue #5「建议优化权限/模式选择菜单：统一“计划/执行/自动编辑”等选项，并补充 Goal 模式」。issue 的观察：目标（goal）看起来只能由模型自己设定，而且不是每个模型都会设；两根轴（模式 × 档位）不直观。代码提交：待编排者提交。

修订关系：

- ARD [D14](../../../../plans/2026-09-08-runtime-evolution-ard.md)（「权限与模式分成两根轴」）的**界面**：两组单选改成一列五个预设，档位的中文名改了；**数据模型不变**，存储仍是 `{mode, gear}`，localStorage 键不变，不迁移，1.0.x 重装后照样读得到。D14 的旧值映射（`readonly → plan + ask` 等，`migratePermissionTier`）不变。
- [P1-7 方案](../topics/p1-7-renderer.md) §4.2 与[分片 03](../topics/p1-7-renderer/03-panels.md) §2「创建目标只靠 `/goal` 与 `create_goal`，输入框不加目标模式开关」：改为权限菜单里有一个「设定目标…」入口。它只往输入框里预填 `/goal `，不是开关，也没有「目标模式」。
- [P1-7 原型](../evidence/p1-7-prototype-2026-09-28/prototype.html)（约第 1124 行）的权限芯片画的是「执行 · 每次询问」，现在芯片只显示预设名（如「改动前确认」）。这是有意偏离原型（原型是验收基准，偏离在此记录）。

## 用户裁决（2026-10-09）

### 1. 单列五个预设，加一个动作

菜单从上到下：

| 预设 | 界面名 | 词典键 | 写入的 `{mode, gear}` |
|---|---|---|---|
| `plan` | 计划模式 | `Plan mode` | `{plan, auto}` |
| `ask` | 改动前确认（默认） | `Confirm before changes` | `{agent, ask}` |
| `accept-edits` | 自动编辑 | `Auto edit` | `{agent, accept-edits}` |
| `auto` | 全自动 | `Full auto`（沿用） | `{agent, auto}` |
| `bypass` | 完全放行 | `Bypass all prompts`（沿用） | `{agent, bypass}` |

然后一条分隔线，再是「设定目标…」（`Set a goal…`）。

- **计划模式 = plan + 全自动**（用户的理解：计划模式权限是全自动的，但只勘察、只产出 markdown 计划）。所以选它不需要二次确认。按闸门的实际行为（`src/shared/permissions/gate.ts` 的 `evaluate`）：plan 模式下，读文件、glob / grep、技能和只读 shell 命令不再弹卡（包括工作区外的读取）；写、改、非只读命令、`run_code` / `workflow` 这类程序、联网（`web_search` / `web_fetch`）和其他未分类工具一律在调用时拒绝；密钥文件等显式拒绝照旧；操作数解析不出的只读命令仍会询问。内部工具（todo、子代理、提问等）照旧放行，子代理的调用也受 plan 模式约束。
- **自动编辑**的说明按实际行为写：工作区内的改动和命令直接执行；工作区外的路径、联网和其他工具仍会询问（`gate.ts` 的 accept-edits 分支、`requestBuilder.ts` 的 `generic` / `opaque` 分支）。
- **全自动**保留原来的二次确认；**完全放行**保留 runtime-hardening [决策 023](../../runtime-hardening/decisions/023-bypass-permissions-tier.md) 的全部行为：二次确认、只能在已有会话里开、不能存成新对话默认、芯片红色、开始界面上不可选。
- 纯函数在 `src/shared/types/runtimePermission.ts`：`PermissionPreset`、`PERMISSION_PRESETS`（菜单顺序）、`PERMISSION_PRESET_LABELS`、`presetOf(settings)`（任何 `mode: 'plan'` 都是 `plan`，其余取档位）、`settingsOf(preset)`、`isPermissionPreset`。没有改 `migratePermissionTier`（`hostStatic.test.ts` 钉着），也没有改与 `surfaceRegistry.ts` 共用的 `Plan` 词条，没有复用孤儿词条 `Full access`。`RUNTIME_MODE_LABELS` 已无人用，删除。

### 2. 「设定目标…」= 预填 `/goal ` 并聚焦

- 不弹对话框。点它后输入框变成 `/goal ` 加上原来的草稿（已有的文字当作目标），光标在末尾，焦点在输入框（菜单关闭时不把焦点还给芯片，`finalFocus`）。
- 会话已有未完成的目标（进行中、等待下一轮、已挂起、已暂停、受阻）时不可用：DSH 会拒绝第二个目标。提示按目标条有没有按钮分两种：有活着的 worker 时「可在目标条里暂停、继续、修改或清除」；没有时目标条没有按钮，提示「发送 /goal 可查看，发送 /goal clear 可结束它」。目标已完成时可用。判断用目标条自己的视图（`deriveGoalBarView`）。
- 本会话正在发送（`sendingHere`）时不可用，提示「当前消息发出后可用」。
- 开始界面（还没有会话）也可用。
- 斜杠菜单里 DSH 命令的说明改为按英文原文查词典、查不到就原样显示（`buildSlashCatalog`）。新增词条 `Set or view the goal for a long-running task` →「设定或查看长任务目标」。技能的说明是作者写的，不翻译。

### 3. 发起目标时自动切到「全自动」

一条**创建**目标的 `/goal <目标>` 真正发出之前（手打或经入口预填都算）：

- plan 模式 → 切到执行；
- 档位是改动前确认或自动编辑 → 切到全自动。不走平时的二次确认（发起目标就是明确的意图），弹一条提示「已切换到「全自动」，目标会自动多轮推进」；
- 全自动、完全放行不动；**永远不会自动切到完全放行**（存量的 plan + bypass 只离开 plan 模式）。
- 不切的情况：`/goal`（查看）和控制形式 `clear` / `pause` / `resume` / `edit …`（语法按 `dsh-command-goal` 的 `parseGoalCommand`），以及会话已有未完成目标时（DSH 会拒绝，切了也白切）。

## 自主决定（待用户审批）

4. **切换的时机**：在 `ChatComposer.runSend` 里、真正派发时做，不在入队时做。排队中的 `/goal` 在出队发送时才切；Ctrl+Enter 插话不经过命令通道（DSH 把它当作文字插入当前回合），不切；「继续」重试（`retryLastTurn`）不切。带附件的 `/goal` 在 bridge 里会当作普通提示词发给模型（决策 113），这里仍然切换，因为用户的意图同样明确。
5. **切换只作用于这个会话**：
   - 这次发送要拉起 worker 的会话（新建或恢复）：先把新姿态写进这个会话自己的那一行，`spawnPermissions` 从同一处读，worker 直接以新姿态起来。开始界面上新建的会话也是这样，**不写新对话默认**（`aiclient:chat:default-permissions` 不变）。
   - worker 已在的会话：发送前先调 `setPermissions`，worker 接受后才写存储（与芯片自己的选择一致）。被拒（例如 DSH 自己在跑一轮目标时改模式会得到 `WORKER_SESSION_BUSY`）时弹错误提示「未能切换到「全自动」——目标仍已发出，执行中可能会停下来请求确认」，目标照常发出。切换成功后，`session_not_found` 回落重建也用新姿态（`spawnPermissions` 因此由 `const` 改为 `let`，`permissionTierWiring.test.ts` 相应改钉）。
   - 芯片的状态在 `ComposerPermissionTrigger` 的 `useState` 里，靠 `postureRevisions`（P1-9e 迁移用的那个修订号）重读。切换后同样调 `notePostureSynced`，芯片立即更新。
6. **旧行的显示**：plan + ask（1.0.x `readonly` 迁移来的）、plan + accept-edits、plan + bypass 都显示为「计划模式」，不悄悄改写；芯片的悬停提示补一句「只读工具沿用之前的确认方式：<档位>」。在菜单里再点「计划模式」不会触发改写（单选值没变）。
7. **轮中规则**沿用「轮中锁模式、不锁档位」：轮次进行中「计划模式」不可选；会话处于计划模式时其余四项也不可选（每一项都会离开计划模式）；执行模式下四个档位预设照常可选。被锁的项显示「本轮对话结束后可修改」，菜单底部写「本轮对话进行中不能进入或退出计划模式」（替换原来的「本轮对话进行中只能修改权限档位」）。
8. **芯片格式**：只显示预设名（「自动编辑」「计划模式」），不再是「模式 · 档位」；完全放行的红色样式不变。
9. **提示文案**：自动切换成功是 info 提示，标题即上面那句；失败是 error 提示。
10. **去掉暗示审批流程的文案**：删除「执行已批准的工作」（`Carries out approved work.`）和「勘察并提交实现计划，等待批准」，计划模式的说明改为中性的「只读：勘察时不再询问，最后写出计划。改文件、其他命令和联网工具都会被拒绝。」（审批步骤以后才有，见第 13 条）。全自动确认面板的说明去掉「当前模式下」（全自动现在一定是执行模式）。
11. 「设定目标…」只出现在非降级的菜单里；降级（用户自己的权限系统）分支已无生产方，不处理。
12. 手动探针 `scripts/run-perm1-probe.mjs` 的芯片匹配与点击目标改成新名字（判定格 `popupHasAllFourGearsAndModes` 改名为 `popupHasAllFivePresets`）；本机没有在真实应用里跑。

## 13. 推迟：plan 审阅流程（按用户意见）

原计划的两条不做，留给后续「DSH 原生 plan 审阅」一并设计：

- plan 模式下拒绝模型自己调用 `create_goal` 与 `update_goal`（`action: resume`）；
- 改写 plan 模式的模型提示词（`src/shared/permissions/promptText.ts`：现在仍写 "produce an implementation plan for user approval"，执行模式仍写 "Execute the approved work"）并重录 `perm-plan` 金样本。

用户要的是另一种流程：计划模式只勘察、不改动；计划完成后问用户，是「按这份计划设定目标并切到执行模式」，还是「继续讨论计划」。这需要 DSH 的 `exit_plan_mode` → 批准 → 自动执行一路接通（现在 `dsh-plan-mode` 没有挂载，`exit_plan_mode` 调用总是报错），届时会修订[决策 047](047-tool-classification-and-plan-mode.md) 第 3 条。在此之前，`src/dsh-host/permissions/permissionHost.ts`、`promptText.ts`、`gearsAndTools.test.ts` 和全部金样本都没动。

## 风险

1. **授权记忆被清空的次数变多**：worker 空闲时改姿态走 `configure`，会清掉「本会话内允许」记下的授权（[决策 092](092-p1-6c-grants-and-setters-choices.md)）。现在每次发起目标、每次在计划模式与执行之间切换，都会清一次。
2. **全自动下的目标轮仍可能停下来问**：操作数解析不出的 shell 命令、`run_code` / `workflow` 这类程序在全自动下照样弹卡，目标会停在卡上；自动切换永远不会选完全放行。
3. **模型仍可能自己建目标**：执行模式下模型可以自行调用 `create_goal`（DSH 默认行为，按[决策 090](090-user-rulings-2026-09-28.md) 跟随 DSH）。这种目标不经过输入框，姿态不会自动切换，按用户当时的档位跑。计划模式下模型调用 `create_goal` 目前也不拦（第 13 条推迟），目标轮会在计划模式下跑，写操作照样被拒。
4. **计划模式比旧的 plan + ask 宽**：选「计划模式」写入 plan + 全自动，工作区外的读取和只读命令不再询问。密钥文件等显式拒绝照旧。
5. 新对话默认可以是 plan + 全自动（在开始界面选了「计划模式」）。

## 验证

新增或改写的测试：

- `src/shared/__tests__/permissionPresets.test.ts`：五个预设的顺序与中文名，`settingsOf` / `presetOf` 的映射与往返，1.0.x `readonly` 迁移结果显示为计划模式。
- `src/renderer/components/chat/__tests__/composerPermissions.test.ts`（重写）：单列五项；选计划模式写 plan + auto、无确认、等 worker 回执后才存；全自动与完全放行的二次确认不变；轮中锁定（执行模式下四项可选、计划模式全锁）；旧行显示为计划模式且不改写；P1-9e 迁移用例改为新名字；目标入口的点击、禁用与开始界面；目标切换后芯片显示全自动。
- `src/renderer/components/chat/__tests__/goalStart.test.ts`：哪些 `/goal` 行算创建；姿态规则（plan → 执行，改动前确认 / 自动编辑 → 全自动，全自动 / 完全放行不动，永不到完全放行，控制形式与未完成目标不切）；入口状态与提示；预填；新会话只写自己的行、不改默认；在线切换先 `setPermissions` 后存储；`WORKER_SESSION_BUSY` 时报错、不存、照常发出。
- `src/renderer/components/chat/__tests__/composerGoalEntry.test.ts`：挂载真实 `ChatComposer`，预填 `/goal ` 并聚焦、保留草稿、开始界面可用、未完成目标（有 / 无 worker）与已完成目标的入口状态。
- `src/renderer/components/chat/__tests__/goalStartWiringStatic.test.ts`：`runSend` 里的调用位置（派发时、入队路径不调、重试不调、拉起 worker 前写存储、在线切换在 `ensureHost` 之后第一次发送之前、可被 Stop 取消）。
- `slashCommands.test.ts`：DSH 命令说明的翻译与回落。
- 改钉：`composerStopStatic.test.ts`（`runSend` 里的 `cancellation.race` 由 7 处变 8 处）、`permissionTierWiring.test.ts`（`let spawnPermissions`）。

命令（2026-10-09 在开发机上逐条跑）：

- 上面六个新增 / 改写的测试文件：74 项全过；`composerSessionDrafts` + `sessionPanels`：10 项；`bulkArchiveStatic` / `startScreenBarStatic` / `permissionGateDegradedStatic` / `composerFormStatic`：30 项；`slashCommands` / `e4CatalogKeys` / `slashCommandWiringStatic`：45 项。
- `pnpm vitest run Static Scan Wiring`：本决策的改动全过（`composerStopStatic` 按上面改钉）。
- `pnpm vitest run src/shared/__tests__`：503 项；`pnpm vitest run scripts`：228 项；`pnpm vitest run src/shared/permissions`：422 项；`pnpm exec vitest run src/dsh-host/permissions`：161 项（1 项跳过）；`dshStreamReplay`：224 项。
- `pnpm typecheck`、`pnpm typecheck:dsh-host` 通过。
- `bridge-smoke` 66 项判定全真；`bridge-record --check` 28 个场景 0 差异，金样本未重录。
