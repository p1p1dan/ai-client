# 决策 148：P1-5d 协议收口的实现取舍

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [决策 036](036-filter-unsupported-protocols.md) 第 2 条（用户 2026-09-28 批准，[决策 090](090-user-rulings-2026-09-28.md)）：「用户服务设置里只能选这三种协议，并附上说明」；
- [P1-5 方案 §5 D4](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、§6 P1-5d 行；
- [决策 123](123-p1-9e-migration-renderer-choices.md) 第 14 条：设置侧的收口归 P1-5d，随协议选择框一起做；
- `docs/design-system.md`（@coss/ui 组件、CSS 变量、Token 分档）。

本组改动留在工作区，由编排者复跑后提交。没有起 Electron，没有做 GUI 点验（本机硬规则：2 核 3.3 GB），界面行为只由挂载测试与源码扫描验证。

## 落地了什么

- 共享：`src/shared/userProviders.ts` 新增 `SUPPORTED_USER_PROVIDER_APIS`、`isSupportedUserProviderApi`；`src/shared/i18n.ts` 文末新增一段 4 条中英。
- 渲染层：`settings/ProviderSetupDialog.tsx`（API 风格选择框收口到三种并附说明；预设选择框过滤掉协议不受支持的两个；编辑态把当前值钉进列表并标注；保存路径不变）、`settings/UserProvidersSettings.tsx`（列表行加「当前引擎不支持」徽标）。
- 测试：`src/shared/__tests__/userProviders.test.ts`（新文件，6 例）、`src/renderer/components/settings/__tests__/userProvidersSettings.test.ts`（补 9 例，并把 `@/i18n` 的 `t` 桩升级为支持 `{{token}}` 替换，不影响既有用例）。

## 规则

### 1. 「受支持协议」常量放在哪、复用谁

没有新定义一份独立的「DSH 支持三种协议」列表。`src/shared/dshModelPlan/tables.ts` 已经有 `DSH_PROTOCOLS`（P1-5a 落的，`build.ts` 的 `isProtocol` 拿它过滤模型目录，决定哪些模型进 `llm-pi-ai` 路由、哪些进 `plan.dropped`）。`userProviders.ts` 新增的 `SUPPORTED_USER_PROVIDER_APIS` **直接等于 `DSH_PROTOCOLS`**（`export const SUPPORTED_USER_PROVIDER_APIS: readonly UserProviderApi[] = DSH_PROTOCOLS`，不是复制一份同样的三个字符串）。`src/shared/__tests__/userProviders.test.ts` 用 `toBe` 做引用相等断言，而不是 `toEqual` 值相等——防的就是以后有人改成「抄一份」，测试却看不出来已经和菜单的判据分叉。

这样菜单的「N 个模型在当前引擎下不可用」footer（`unavailableModelsNotice`，读 `dshModelPlan/menu.ts` 产出的 `catalog.unavailable`）和设置页的协议收口，最终都源于同一张表，不会出现「菜单说支持但设置页不让选」或反过来的情况。

**为什么是深路径 `import { DSH_PROTOCOLS } from './dshModelPlan/tables'`，不是走 `dshModelPlan` 的包装桶 `index.ts`**：`index.ts` 还重新导出了 `build.ts`，`build.ts` 顶部 `import { createHash } from 'node:crypto'`。`userProviders.ts` 会被渲染层加载（`ProviderSetupDialog.tsx` 本来就在用它），而渲染层的 `webPreferences` 是 `nodeIntegration: false` / `contextIsolation: true`（`MainWindow.ts`），没有 Node 内置模块。实测：只从 `tables.ts` 这一个叶子文件导入，它自己的依赖链（`../types/agentHost.ts`、`./types.ts` 的 `import type`）里没有任何 Node 内置或副作用导入，`pnpm typecheck` 与挂载测试都过；如果走包装桶，等于把 `build.ts` 一起拉进渲染层的模块图。`dshModelPlan` 目录自身的边界测试（`dshModelPlanBoundaryStatic.test.ts`）只检查它内部文件是否反向引用了 `renderer` 等目录，不检查谁可以引用它，所以这条深路径导入不违反那条测试，但也没有现成约定说「只能走桶」——这次就按「避免把 `node:crypto` 带进渲染层」这条硬约束选了深路径，并在 `userProviders.ts` 的注释里写明原因，防止以后有人「整理导入」时改回桶导入。

`USER_PROVIDER_APIS`（10 个）本身没有收窄：存储格式、`UserProviderDraft`/`UserProviderView` 的 `api: UserProviderApi` 字段、`isUserProviderApi` 的校验范围都不变。`AgentDirMigrationService` 导入旧 `models.json` 时仍按这 10 个校验，与「当前引擎用哪个」无关——它校验的是「这个 app 的存储层认得这个协议字符串」，不是「DSH 的路由能不能用它」。

### 2. 预设列表怎么处理

`PROVIDER_PRESETS`（`userProviders.ts`，16 条，PI-Desktop 移植）本身没有删减：它是「pi-ai 的适配器能打到的服务」的记录，决策 036 的想法池写着「以后确有用户需要可以自写适配插件」，那条路径一旦真的要做，这份记录还有用。

过滤发生在消费侧：`ProviderSetupDialog.tsx` 新增模块级常量 `SELECTABLE_PRESETS = PROVIDER_PRESETS.filter((preset) => isSupportedUserProviderApi(preset.api))`，渲染「Service」下拉框时只用这份过滤后的列表；判断「当前值该显示什么标签」的 `PROVIDER_PRESETS.find(...)`（`useEffect` 里重新打开弹窗时执行）仍查全量列表不变。16 条里只有 `google`（`google-generative-ai`）、`mistral`（`mistral-conversations`）两条被排除；其余 14 条用的都是三种支持协议之一（多数是 `openai-completions`），一条没少。

选预设只是把 `name`/`baseUrl`/`api` 三个字段填进表单，不写盘、不影响已存的数据——`applyPreset` 对找不到的 id 直接提前返回，什么都不改。所以就算编辑一个用了 google 协议的旧服务，此时「Service」下拉框里已经没有「Google Gemini」这一项，也不会丢数据：这个选择框从来不是协议值的来源，`API style` 选择框才是。

### 3. 已有服务用了不支持协议时怎么显示、怎么保存

**列表页**（`UserProvidersSettings.tsx`）：服务名旁边除了原有的协议徽标（`apiLabel(provider.api)`，一直显示，不隐藏真实协议），`!isSupportedUserProviderApi(provider.api)` 时再加一个 `warning` 变体的徽标「当前引擎不支持」，带 `AlertTriangle` 图标。两个徽标都给，而不是把原来的协议徽标换成警告色——用户需要同时看到「这是什么协议」和「为什么标红」，换掉前者会丢掉第一个信息。

**编辑弹窗**（`ProviderSetupDialog.tsx`）：

1. `api` 表单状态照旧在打开时 `setApi(editing.api)`，不做任何清洗或回退——这是「不静默改掉协议值」的全部实现：没有一处代码在读到不支持的值时把它换成默认值。
2. `API style` 选择框的候选列表 `selectableApis`：`api` 本身受支持时就是 `SUPPORTED_USER_PROVIDER_APIS`（三项）；不受支持时追加当前值，变成四项，追加项的文案是「{{label}}（当前引擎不支持）」。不追加的话，选择框会显示一个不在候选列表里的当前值——Base UI 的 `SelectValue` 用的是显式 children（`{API_LABELS[api]}`），不会因此崩或显示错，但打开下拉菜单时找不到任何一项处于「已选中」状态，体验上像是「这个值凭空出现」。追加之后，用户能看到「我现在选的就是这个，它被标了不支持」，也能直接点三个受支持的协议中的任意一个切换过去。
3. `API style` 字段下方的 `Field` 提示（hint）复用同一个插槽：协议受支持时显示通用说明「当前对话引擎只支持这三种协议」（这是新建服务时看到的那句，决策 036 第 2 条要的「附上说明」）；不受支持时换成针对当前值的警告，点名具体协议（如「此服务使用的协议是 Mistral Conversations，……」），`invalid` 置为真（走警示配色）。两句话不会同时出现，因为它们回答的是同一个问题「这个协议能不能用」，只是答案不同。
4. **保存路径没有新增任何协议相关的分支**：`save()` 里 `draft.api = api` 照抄原逻辑，`canSave` 也没有把 `isSupportedUserProviderApi(api)` 加进去。也就是说：不支持的协议不会被保存阻止，也不会被保存改写——用户可以什么都不动直接点「保存」（协议原样留着），可以改选三种之一（协议变成新值），也可以点「删除」（这个服务消失）。这三条都是任务里点名要保留的路径。
5. 「获取模型」探测（`runProbe`）没有加协议限制：它调的是 `electronAPI.userProviders.fetchModels`，走的是 Main 侧对该服务 `baseUrl` 的直接探测，与 DSH 的聊天路由无关（DSH 不支持的是「拿这个协议去聊天」，不是「拿这个协议去问它有哪些模型」）。限制探测会在协议收口之外引入一条无依据的新限制，所以没有做。

### 4. 文案

新增 4 条中英（`src/shared/i18n.ts` 文末）：

| 英文（key） | 中文 |
|---|---|
| `Only these three API styles work with the current chat engine.` | 当前对话引擎只支持这三种协议。 |
| `This service uses {{api}}, which the current chat engine cannot use. Pick one of the styles above, or remove the service.` | 此服务使用的协议是 {{api}}，当前对话引擎无法用它来聊天。可以改选上方的三种协议之一，或删除这个服务。 |
| `{{label}} (not supported by the current engine)` | {{label}}（当前引擎不支持） |
| `Not supported by the current engine` | 当前引擎不支持 |

`{{api}}`/`{{label}}` 插的是 `API_LABELS[...]` 这个英文技术名（如 "Mistral Conversations"），中英文界面下都保持英文——这些是协议/供应商的专有名词，不是需要翻译的句子，与 `{{reason}}` 插服务原始错误文本是同一惯例。`API_LABELS` 本身（10 条协议到人类可读名的映射）不受 `noHardcodedChinese`/`i18nCoverage` 两个静态测试管辖：它既不含中文，也不经过 `t()`，和菜单模块的 `catalogStatusRow` 等纯状态文案是一类东西。

## 已知入口清点（任务要求的穷举）

用 `rg -a` 搜了 `UserProviderApi`、`USER_PROVIDER_APIS`、`apiLabel`、`API_LABELS` 以及十个协议字符串本身，命中的生产代码文件只有：

- `src/shared/userProviders.ts`（类型与常量的家，本次改动）；
- `src/renderer/components/settings/ProviderSetupDialog.tsx`、`UserProvidersSettings.tsx`（唯一的两处用户可见界面，本次改动）；
- `src/main/services/userProviders/UserProviderService.ts`、`src/main/ipc/userProviders.ts`（读写与探测，不展示协议选择，不改）；
- `src/main/services/agentMigration/AgentDirMigrationService.ts`：从 `~/.pi/agent` 的 `models.json` 批量导入旧配置时按 `isUserProviderApi`（十个）校验，拒绝识别不了的协议字符串，给出英文错误原因。这条路径**没有对应的渲染层界面**（`rg` 未命中任何 `.tsx` 引用 `AgentDirMigrationService`/`MigrationEntry`），是一次性、无人工复核步骤的批量迁移，不是「让用户选择或展示协议」的入口，所以不在本次收口范围——它已经用十个协议的全集校验，与「当前引擎支持三个」是两个独立的问题（存储层认不认 vs. 引擎能不能聊），迁移出来的服务进了保险库之后，一样会被上面两处界面按新规则标注。
- `src/shared/piModelConfig.ts` 的 `PI_MODEL_APIS`（4 条）：这是管理端下发的托管目录的**服务端**协议校验，`userProviders.ts` 文件头的注释本来就写明「不是一回事」。公司目录按决策 036 的证据已经全在三种协议里（随包快照 10/10），这条校验的对象也不是用户自己填的服务，所以不动。

没有发现引导页、导入向导或其他设置子页涉及用户自建服务的协议选择——`OnboardingView.tsx`/`WelcomeView.tsx` 等引导页只处理公司账号登录，不引用 `userProviders`。

## 取舍

- **预设过滤放在组件里（`SELECTABLE_PRESETS`），不改 `PROVIDER_PRESETS` 本身**：备选是直接从共享的 `PROVIDER_PRESETS` 数组里删掉 google/mistral 两条。没选，因为那是改一份带「PI-Desktop 移植」语境、且与想法池（自写适配插件）有关的记录；而任务也要求「只在 UI 层收口」。唯一的调用方只有这个弹窗和两个无关痛痒的测试（`modelBaseUrl.test.ts` 只按 `api === 'anthropic-messages'` 过滤校验，不关心总数），所以放在消费侧过滤没有产生第二份清单需要维护。
- **不支持的协议钉进选择框而不是干脆不出现**：备选是「不支持就不放进候选列表，靠 `SelectValue` 的显式 children 顶住显示」。没选，因为打开下拉菜单时会出现「当前明明选着什么，但列表里没有任何一项是选中状态」的空白感，而任务要求「用户可以改选」——钉进去且带后缀，用户一眼能看到「这是哪个协议、为什么标了不支持、旁边三个能换」。代价是选择框在这一种情况下会有 4 项而不是 3 项，属于预期内的例外。
- **列表页用两个徽标而不是把协议徽标整个换成警告色**：换色会丢「这到底是什么协议」这条信息，两个徽标并排的代价只是多占一点横向空间——`UserProvidersSettings.tsx` 这一行本来就有 `min-w-0 flex-1 truncate` 在兜底换行/截断，没有新开专门的响应式处理。
- **没有限制「获取模型」探测**：见上文规则 5。这是唯一一处「本可以顺手也限制，但选择不限制」的点，写出来是为了防止以后有人觉得「协议不支持就该整体锁住」而误加限制。

## 验证

- `pnpm typecheck && pnpm typecheck:dsh-host`：均通过，0 错误。
- `pnpm lint`：8 warnings / 1 info，均为改动之外的既有文件（`docs/plantree/.../tools/*.mjs`、`scripts/run-f3-dev-probe.mjs`），0 新增。
- `pnpm exec vitest run Static Scan Wiring`：75 files / 759 tests 全过。
- `pnpm exec vitest run src/shared/__tests__`：31 files / 443 tests 全过（含新文件 `userProviders.test.ts` 6 例）。
- `pnpm exec vitest run src/renderer/components/settings`：25 files / 226 tests 全过（含 `userProvidersSettings.test.ts` 31 例，9 例新增）。
- 追加：`pnpm exec vitest run src/shared/dshModelPlan`（2 files / 55 tests）、`pnpm exec vitest run src/main/services/piModelConfig`（6 files / 102 tests），均全过——确认没有动到 `DSH_PROTOCOLS` 的任何消费方。

## 待用户审批的点

都是沿用既有决策做的工程选择，没有发现需要改存储格式或推翻决策 036/090 的情况。请重点过一遍：第 3 节「钉进选择框并追加后缀」的呈现方式，以及第 2 节「预设在消费侧过滤、不改共享数组」的取舍，是否符合预期。
