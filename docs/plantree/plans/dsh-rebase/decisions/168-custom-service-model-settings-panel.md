# 决策 168：自定义 AI 服务的「模型设置」面板（左列选模型 + 共享设置面板）

日期：2026-10-09。**状态：第 1 节为用户裁决（2026-10-09）；第 2 节起的具体做法为自主决定，待用户审批。**

来源：用户 2026-10-09 原话：「自定义服务里的模型配置…可配置项太少…每个模型共用一个公共的配置块…勾选模型后，在选择列里选择已经勾选的模型，公共配置栏就显示哪个模型对应的思考强度、上下文以及支持的输入形式等等」。在决策 165（issue #4，提交 `117ac93d`）的基础上做。调研与对抗复核见编排者的 `modelpanel.json`（不入库），复核意见与调研冲突的地方以复核为准。代码提交：待编排者提交。

## 1 用户裁决（2026-10-09）

1. **本轮字段 = 核心 8 项**：显示名称、推理、自适应思考（仅 Anthropic Messages）、可选推理强度、厂商协议预设（仅 OpenAI Chat Completions，且推理开着时显示）、上下文窗口、输出上限、图片输入。不做高级兼容性分区，不做价格 / headers / temperature，不做「应用到其他模型」。
2. **选择器 = 左侧一列已勾选的模型 + 右侧共享面板**，对话框加宽到 `max-w-2xl`。已自定义的模型标圆点（判据：与 `prefillModelMeta(id, api, undefined)` 的结果不同）；有非法草稿的模型标错误记号。列表项是按钮，用正规的 listbox 或 tablist 模式，可键盘操作；长 id 截断并有 Tooltip；填了显示名称时主行显示名称、次行灰色显示 id。
3. **本轮不提供「关闭」档**：声明 off 后，所有不带档位的请求（提交信息、代码审阅、没勾「中」时的「默认」）都会显式关闭思考，很多后端会 400。可选档位为 极低 / 低 / 中 / 高 / 极高 / 最高，按矩阵过滤：anthropic 自适应 → 低、中、高、极高、最高（无极低）；anthropic 预算思考（推理开、自适应关）→ 极低、低、中、高（极高 / 最高会被 pi-ai 钳成高，显示为禁用并说明）；openai-completions / openai-responses → 六档全有。不可用 = 未按下 + 禁用 + Tooltip 说明原因。推理开着时至少保留一档（最后一个按下的按钮禁用）。
4. **预填（扩展决策 165 §2.4 的裁决）**：自适应 Claude id（`suggestsAdaptiveThinking`）预填 推理 + 自适应思考 + 档位 低 / 中 / 高 / 最高（不含极高）。不预填输出上限。

## 2 决定（自主，待审批）

### 2.1 数据形状（`src/shared/userProviders.ts`）

- `UserModelMeta` 新增三项，都不以这个名字写进 `models.json`：
  - `name?: string`：菜单显示名；
  - `efforts?: UserModelEffort[]`：`UserModelEffort = Exclude<SessionEffortLevel, 'off'>`，常量 `USER_MODEL_EFFORTS`（六档，升序）；
  - `compatPreset?: UserCompatPreset`：`'openai' | 'deepseek' | 'qwen' | 'qwen-chat-template' | 'zai' | 'openrouter'`。
- 新增纯函数：`availableModelEfforts(api, adaptive)`（矩阵）、`normalizeModelEfforts(efforts, api, adaptive)`、`compatPresetSendsEfforts(preset)`、`compatForPreset(preset)`、`isModelMetaCustomized(id, api, meta)`、`parseModelTokenCount(raw)`、`isUserCompatPreset`。
- 扩展 #4 的函数：
  - `applyModelMetaPatch(meta, patch, api?)`：联动规则不变；带 `api` 时，修改档位或自适应开关翻转后，按新状态规范化 `efforts`。
  - `modelMetaForApi`：`name` 去首尾空白，空串不写；`efforts` 与 `compatPreset` 只在推理开着时保留；`compatPreset` 只对 openai-completions 保留；`efforts` 先规范化；预设为 `qwen-chat-template` 时不保留 `efforts`。
  - `prefillModelMeta`：见第 1 节第 4 条。
  - `modelMetaDraft`：不变。

### 2.2 档位规范化（同一个函数，三处调用）

`normalizeModelEfforts`：丢掉未知值和 `off`；去重；按升序排；按矩阵过滤；**过滤后为空，或恰好是隐含的 低 / 中 / 高，就返回 `undefined`**（即不写 `efforts`，回落到隐含三档）。调用方：

1. 对话框：`applyModelMetaPatch` 在改档位、翻转自适应时规范化内存里的值；面板显示也按它派生。
2. 保存：`modelMetaForApi` 再规范化一次。所以切换接口风格时内存不动（字段隐藏但保留），显示和保存都按新风格派生。
3. Main：`toPiUserModel` 再规范化一次（纵深防御，保险库读取时不校验 `modelMeta`）。

「恰好是隐含三档就不写」是新加的规则：两种写法在计划层的结果完全一样（都是 low / medium / high），不写更省事，「已自定义」的判断也不会因为用户点了又点回来就亮起。

### 2.3 厂商协议预设

下拉标签「厂商协议」，选项：自动（按服务名称和地址识别）/ OpenAI / DeepSeek / 通义千问 / 通义千问（chat template）/ 智谱 GLM / OpenRouter。选中后，`toPiUserModel` 把该厂商**整组** compat 写进行上（不只是 `thinkingFormat`），结果不再依赖服务名和地址。每组固定写下面 6 个键，全部在 `DSH_OFFERED_COMPAT['openai-completions']` 之内（`compatForPreset` 运行时再过滤一次，测试也断言了），计划层原样放行，不会出现 `compat_not_offered`：

| 预设 | thinkingFormat | supportsDeveloperRole | supportsStore | supportsReasoningEffort | maxTokensField | requiresReasoningContentOnAssistantMessages | 依据（pi-ai 0.85.1） |
|---|---|---|---|---|---|---|---|
| OpenAI | openai | true | true | true | max_completion_tokens | false | `detectCompat` 对未知地址的结果 |
| DeepSeek | deepseek | false | false | true | max_tokens | true | `deepseek.json` 各行 + `isDeepSeek` 分支 |
| 通义千问 | qwen | false | false | true | max_completion_tokens | false | `qwen-token-plan*.json`（DashScope） |
| 通义千问（chat template） | qwen-chat-template | false | false | false | max_tokens | false | 目录里没有这种行；取非 OpenAI 行的保守值（自建 vLLM / SGLang） |
| 智谱 GLM | zai | false | false | true | max_tokens | false | `zai.json` 的 GLM-5.2 / 5.3 行（`zaiToolStream` 不在 DSH 开放范围内，不写） |
| OpenRouter | openrouter | false | true | true | max_completion_tokens | false | `openrouter.json` 常见行 + `isOpenRouter` 分支 |

- `qwen-chat-template` 只发 `chat_template_kwargs.enable_thinking`，档位在线上没有区别。所以面板不显示六个档位按钮，改为一句说明「这种格式只开关思考、不发送强度档位：对话里选哪一档效果都一样」；保存时不写 `efforts`，`models.json` 里也不写 `thinkingLevelMap`。
- 预设只在推理开着时显示和保存（第 1 节第 1 条）。推理关着时这组开关不写，经代理接入的非推理模型仍走 pi-ai 的自动识别，与现状一致。

### 2.4 写出 `models.json`（`PiModelConfigService.ts` 的 `toPiUserModel`）

- 按白名单逐项构造行，**不再用 `{id, ...rest}` 展开**：`name`（去空白、非空）、`contextWindow` / `maxTokens`（正的安全整数）、`reasoning`（布尔）、`input`（只认 text / image，去重）。保险库里其他键（`compat`、`thinkingLevelMap`、`samplingParams`、`headers`……）一律不写。这推翻了决策 165 §2.2「行上已有的 compat / thinkingLevelMap 会合并」：表单从来写不出这些键（IPC 白名单会拦下），合并只会让脏数据进文件。
- 自适应（决策 165，不变）：`reasoning: true` + `compat.forceAdaptiveThinking: true` + `thinkingLevelMap.off: null`。
- 推理开着且规范化后有 `efforts`：`thinkingLevelMap` 7 个键全部显式写出，选中的写同名字符串，其余（含 `off`）写 `null`；与自适应的输出合并。
- 推理开着且是 openai-completions 且有预设：合并该预设的整组 compat。
- 计划层（`build.ts` / `tables.ts` / `route.ts`）、宿主、`CredentialVault.ts`、`UserProviderService.ts` 都不改；金样本 `dshModelPlan.snapshot.json` 没变。

### 2.5 IPC（`src/main/ipc/userProviders.ts` 的 `readDraft`）

- `name`：必须是字符串，去空白后最长 200（与输入框 `maxLength` 一致），空串不写。
- `efforts`：必须是非空数组，每项都是 `isSessionEffortLevel` 且不是 `off`；去重并按升序存。
- `compatPreset`：必须是六个预设之一。
- 这些拒绝都只会由调用方的错误触发：表单保存前已规范化（不会发空数组或 `off`），名称框有 `maxLength`，所以界面能做出来的任何状态都不会把英文校验错误显示给用户。

### 2.6 界面（`ModelSettingsPanel.tsx` 新文件；`ProviderSetupDialog.tsx` 只留状态和保存）

- 对话框 `max-w-2xl`（`AddRepositoryDialog` 已有同宽先例），仍用 `DialogPanel`。原来的 `<details>「各模型元数据」` 和每模型一行的 `ModelMetaRow` 删掉。
- 「模型设置」块：一个带边框的容器，左边 `w-44` 的模型列，右边共享面板（`key={当前模型}`）。
- **无障碍模式选 tablist（竖向）而不是 listbox**：这一列唯一的作用是决定旁边那一个面板显示谁，正是 WAI-ARIA 的 tabs 模式；listbox 表示「在表单里选一个值」，而在列里移动并不改变任何表单值。用 @coss/ui 的 `Tabs`（base-ui），`orientation="vertical"`、`activateOnFocus`，自带 roving tabindex、上下方向键、Home / End；每项是 `role="tab"` 的按钮，`aria-selected` 标当前项，面板是 `role="tabpanel"` 并由 tab 命名。列表 `aria-label`「已选模型」。
- 列表项：圆点（已自定义）+ `sr-only`「已自定义」；主行显示名称（没填就是 id），填了名称时次行灰色显示 id；都 `truncate`，悬停 / 聚焦有 Tooltip 显示完整名称和 id；有非法草稿时右侧一个错误图标 + `sr-only`「有填写错误」。样式按 design-system：`rounded-sm`、`hover:bg-hover`、选中 `bg-selection`。
- 面板：顶部是模型 id 与两个图标按钮 ↺「恢复默认」（已是默认时禁用）、✕「移除此模型」，都有 Tooltip 和 aria-label。下面依次是：
  - 显示名称（`Field` + `FieldLabel` + `FieldDescription`，占位文字为模型 id）；
  - 「思考」分区（`Fieldset`）：推理 `Switch`；自适应思考 `Switch`（仅 Anthropic Messages）；厂商协议 `Select`（仅 openai-completions 且推理开）；可选推理强度 `ToggleGroup multiple`（推理开时；`qwen-chat-template` 时换成说明）；
  - 「上下文与输出」分区：上下文窗口、输出上限；
  - 「输入类型」分区：图片输入 `Switch`。
- `Switch` / `Toggle` 用 aria-label，不包在 `<label>` 里（base-ui 在 label 里会变成 span，测试里 `.click()` 不触发）。面板里的 `Select` 弹层传 `Z_INDEX.DROPDOWN_IN_NESTED_MODAL`（T079 教训）。模型芯片容器加 `role="group"`、`aria-label`「可用模型」。
- 图片输入从两项 `ToggleGroup`（没传 `multiple`，base-ui 1.1.0 默认单选，文本和图像不能同时按下）改成一个 `Switch`：开写 `['text','image']`，关不写；已存的 `['text']` 原样往返。

### 2.7 交互

- 勾选芯片：加入已选，**设为当前模型**（不移动焦点，键盘仍停在芯片上），并执行预填（只在该模型还没有任何元数据时）。
- 取消勾选：只从已选去掉，元数据和草稿留在内存里，再勾回来不重新预填。
- 当前模型 = `selected.includes(activeId) ? activeId : selected[0]`：取消或移除当前模型时回落到第一个。
- ✕ 移除：沿用决策 165 的 `removeModel`，元数据和草稿一并删掉；编辑时会发 `{}`。
- ↺ 恢复默认：`meta[id] = prefillModelMeta(id, api, undefined)`，没有建议值就删掉；草稿一并清掉。已是默认且没有草稿时禁用。
- 切换接口风格：字段按新风格显示或隐藏，内存不动；保存时 `modelMetaForApi` 丢掉不适用的字段，档位按新风格规范化。
- 编辑态打开：已选取 `editing.models`，元数据取 `editing.modelMeta`，当前模型为第一个；不拉列表也能设置和移除。
- 空态：探测成功但一个都没勾时，芯片下方显示「在上方勾选模型后，可以在这里逐个设置。」；没有已选模型时不渲染「模型设置」块。

### 2.8 校验

- 数字框用 `type="text" inputMode="numeric"`，自己解析（`type=number` 对「32k」只给空串，分不出「清空」和「非法」）。只认数字，允许 `128,000`、`128 000`、`128_000` 这类分组写法；`0`、`-1`、`1.5`、`1e999`、`32k`、超出安全整数都算非法。
- 原始文本按模型 id 存在对话框状态里（`tokenDrafts`），面板 `key={当前模型}`，草稿不会串到别的模型。合法值或空串立即写进元数据；非法时只留文本、元数据不动。
- 任一**已选**模型有非法草稿：保存按钮禁用，列表里该模型标错误记号，面板里该字段 `aria-invalid` 并显示 `FieldError`（`match` 为 true、条件渲染）「请输入大于 0 的整数。」，对话框底部另有一行「有模型设置填写不正确，请先改好列表中标出的模型再保存。」（免得保存按钮无故变灰）。
- 输出上限的警示（不阻止保存），分两种情况，见第 4 节偏离 1。
- 推理开着时，输出上限下方提示「思考也计入输出上限；高档位建议 32000 以上。」占位文字为「默认 128000」「默认 8192」（`tables.ts` 的 `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS`，本轮不改）。

### 2.9 文案

- 区块名「各模型元数据」改为「模型设置」。两条指向它的提示同步改，英文键同步换：
  - `attachmentLimits.ts`：「…在「设置 · 模型 · AI 服务」里编辑该服务，在「模型设置」中选中该模型，打开「图片输入」。」
  - `sessionFailure.ts`（`MODEL_SETTING_UNSUPPORTED`，修订决策 165 §2.5）：「…在「模型设置」中选中该模型：Claude Opus 4.6 / Sonnet 4.6 及之后的模型要打开「自适应思考」…」
- 可选推理强度的说明按复核意见：「对话里推理强度菜单可选的档位。选「默认」时，有「中」就用「中」；没勾「中」时不指定强度，由服务端决定。」
- 不可用原因：「自适应思考没有「极低」这一档。」「不开自适应思考时，「极高」和「最高」都按「高」发送。」「推理开着时至少保留一个档位。」可用的档位 Tooltip 复用 `CHAT_EFFORTS` 的说明。
- i18n 只在 `src/shared/i18n.ts` 末尾加了一块（注释 `// Custom service model settings panel (decision 168)`）；删掉了本次变成无用的键：`Per-model metadata`、`Text`、`Image`、决策 165 的长说明、两条旧提示。`Input`（工具行也在用）、`Output limit`、`Reasoning`、`Context window`、`Adaptive thinking` 保留复用。

## 3 与已有决策的张力

1. **决策 040（没选档位时会话补发 medium）**：不改路由。某个模型去掉「中」后，「默认」就不再带档位。说明文字写的是「由服务端决定」，对 OpenAI / DeepSeek / OpenRouter / Anthropic 格式成立（不发强度参数，用服务端默认）；但 pi-ai 对**智谱 GLM（zai）、通义千问（qwen）、qwen-chat-template** 三种格式在没有档位时会**显式关闭思考**（`thinking:{type:"disabled"}` / `enable_thinking:false`），即这三种格式下「默认」且没勾「中」= 不思考。提交信息、代码审阅这类不带档位的补全本来就是这样，不是这次引入的。040 当时否决的是「GPT 类模型在默认档不思考」，这里是用户自己去掉「中」之后的结果，记为张力，请审批时确认。
2. **决策 077（默认 128000 / 8192，按宿主补齐）**：不改，面板占位文字照实显示。DSH 自己的默认是 262144 / 32768（决策 090「默认跟随 DSH」），要改需另立决策并重录金样本。
3. **决策 165**：
   - §2.4 预填扩展为含档位 低 / 中 / 高 / 最高（用户裁决）；预填后不再「展开小节」，而是「切换到该模型」。
   - §2.2 的「原生 checkbox、第一个复选框当推理」改为 `Switch`；「行上已有的 compat / thinkingLevelMap 会合并」改为白名单（见 2.4）。
   - §2.5 提示里的「各模型元数据」改为「模型设置」。

## 4 与派工说明的偏离

1. **输出上限警示分两种**：派工写的是「超过上下文窗口（或默认 128000）的一半时提示：实际预留会被钳制（决策 146）」。但 `build.ts` 的 `plannedMaxTokens` 只在**行上同时写了上下文窗口和输出上限**时才钳到四分之一；上下文窗口没填时宿主按 128000 补齐、输出上限原样下发，不会钳。所以：两项都填时提示「超过上下文窗口的一半：实际按 {{value}}（窗口的四分之一）预留输出，以免自动压缩失效。」；只填输出上限时提示「超过默认上下文窗口（128000）的一半：请一并填写上下文窗口，否则自动压缩可能没有余量。」
2. **qwen-chat-template 不做「单一开」档**：派工允许「说明档位不发送，或收成单一开」。选了前者，且不写 `thinkingLevelMap`：对话菜单仍是隐含的 低 / 中 / 高（线上都是 `enable_thinking:true`），说明文字告诉用户选哪档都一样。收成单一档需要在 `toPiUserModel` 里再加一个分支，收益不大。
3. **隐含三档写成「不写」**（见 2.2），以及数字框接受分组写法（见 2.8）：派工没提，属于实现细节。

## 5 不做什么（已记入想法收件箱）

- 「关闭」档（第 1 节第 3 条）。若以后要做，需要按格式区分取值（GPT-5.1 及之后 `"none"`，更早的模型不认），并处理决策 040 的张力。
- 高级兼容性分区（developer 角色、`max_tokens` 字段名、回放 `reasoning_content` 等单独开关）。
- 「把当前设置应用到其他已选模型」。
- 默认尺寸改为 DSH 的 262144 / 32768。
- 每档的自定义线上取值、思考预算 `thinkingBudgets`、每模型默认档位。

## 6 风险

1. **预设的各组取值来自 pi-ai 目录推断，没有实测**：尤其是智谱 GLM 写了 `supportsReasoningEffort: true`（目录里 GLM-5.2 / 5.3 是 true，GLM-4.7 / 5-turbo 是 false，对后者会多发 `reasoning_effort`），通义千问写了 `supportsReasoningEffort: true`（Qwen 3.8 支持档位，3.7 及之前目录里是 false）。若对应模型报错，可先改回「自动」或去掉推理。请用户用自己的 newapi 渠道点验至少一个 DeepSeek 与一个 Qwen 或 GLM 模型。
2. **OpenAI 预设会发 `store:false`、用 developer 角色**：与 pi-ai 对未知地址的默认相同；只有在自动识别把服务误判成别家时才需要选它。
3. **「自动」依赖服务名**：服务名生成的 slug 恰好是 `deepseek`、`zai`、`openrouter` 等时，即使地址是代理也会被当作该厂商（决策 165 风险 5 同类）。
4. **白名单丢键**：保险库里如果有表单以外写进去的 `compat` / `thinkingLevelMap`（目前没有任何写入路径能做到），现在会被丢掉，而不是合并。
5. **配错的后果更重**：声明了服务不认的档位、输出上限超过模型上限、对看不了图的模型开图片，都会是每轮 400。缓解：默认全部「未设置 / 自动」，不可用档位禁用并说明，失败卡片提示去「模型设置」改。
6. **GUI 未点验**：本机只跑了挂载测试（happy-dom），没有开 Electron；Tooltip 与竖向 tabs 的组合、加宽后的版面需要在 CI 包或用户机器上看一眼。

## 7 验证

本地跑过（2026-10-09，Linux 开发机，一次一条）：

- `pnpm vitest run src/shared/__tests__/userProviders.test.ts`：63 例（新增「model settings helpers (decision 168)」组 9 例：矩阵、规范化、自适应翻转、`modelMetaForApi`、chat-template、预设整组且都在 `DSH_OFFERED_COMPAT` 内、已自定义判断、数字解析）。
- `pnpm vitest run src/main/ipc/__tests__/userProvidersIpc.test.ts`：20 例（名称去空白、档位去重排序、预设；空数组、`off`、未知档位、超长名称、非法预设被拒）。
- `pnpm vitest run src/main/services/piModelConfig`：6 个文件 121 例。`PiModelConfigService.test.ts` 新增：白名单（脏键与非法值不进文件）、7 键 `thinkingLevelMap` 与自适应合并、预设整组 compat 只对 openai-completions 且推理开、文件里没有 `efforts` / `compatPreset`。`dshModelPlan.test.ts` 新增 MP-05：真实组装下自适应 Claude 档位含 max、预算思考含 minimal、DeepSeek 预设含 minimal / max、`name` 进计划、没有 `compat_not_offered` / `compat_unset` / `adaptive_thinking_forced`、用户行没有 off。金样本未变。
- `pnpm vitest run src/renderer/components/settings/__tests__/userProvidersSettings.test.ts`：47 例（「model settings (decision 168)」组重写为 28 例：编辑态、列选择、勾选即切换与回落、移除发 `{}`、取消勾选丢元数据、显示名称 / 数字 / 图片开关、5 种非法数字阻止保存并标列表、草稿不串、输出上限警示、恢复默认、自适应联动与清空、预填含 max、矩阵禁用、至少一档、自适应关闭时规范化、切换接口风格时规范化、厂商协议只在 Chat Completions + 推理开时出现、chat-template 说明）。
- `pnpm vitest run` 跑 `attachmentLimits.test.ts`、`sessionFailure.test.ts`、`failureCardProviderText.test.ts`：3 个文件 70 例。
- `pnpm vitest run src/shared/dshModelPlan`：2 个文件 63 例。
- `pnpm vitest run Static Scan Wiring`：77 个文件 792 例。
- `pnpm vitest run src/shared/__tests__`：33 个文件 512 例。
- 根 `pnpm typecheck` 通过；改动文件 `biome check` 通过。

## 8 用户审批

- [x] 第 1 节（用户 2026-10-09 已裁决）
- [ ] 2.1～2.2 数据形状与档位规范化（含「隐含三档写成不写」）
- [ ] 2.3 厂商协议预设的选项与各组取值（风险 1）
- [ ] 2.4 `toPiUserModel` 改白名单（推翻决策 165 §2.2 的「合并」）
- [ ] 2.6 竖向 tablist 的无障碍模式与版面
- [ ] 2.8 校验与输出上限警示（偏离 1）
- [ ] 3.1 决策 040 的张力（zai / qwen 格式下「默认」且没勾「中」= 不思考）
- [ ] 风险 1、6：用 newapi 渠道点验 DeepSeek 与 Qwen / GLM 预设，并看一眼加宽后的对话框
