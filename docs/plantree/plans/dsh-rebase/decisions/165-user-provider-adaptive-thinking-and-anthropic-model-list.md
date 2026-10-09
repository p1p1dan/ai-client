# 决策 165：自定义 AI 服务的「自适应思考」开关，与 anthropic-messages 的模型列表路径

日期：2026-10-09。**状态：自主决定，待用户审批**；其中第 2.4 节（预填）为**用户裁决 2026-10-09：对话框按 id 预填，计划层不猜**。

来源：GitHub issue #4「调用 Claude 模型时 thinking 参数错误（自定义供应商缺少自适应思考设置 + anthropic-messages 拉模型路径错误）」。用户 2026-10-09 选方案 B：每个模型一个显式的「自适应思考」开关，外加对话框按模型 id 预填；模型计划层继续不按 id 猜（决策 141 不变）。代码提交：待编排者提交。

## 1 根因链（更正版）

1. **拉模型列表的路径错**：`src/shared/userProviders.ts` 原来所有接口风格共用一个 `PROVIDER_MODELS_PATH = '/models'`。`anthropic-messages` 的地址保存时会去掉末尾 `/v1`（`normalizeProviderBaseUrl` → `stripRedundantVersion`，SDK 自己拼 `/v1/messages`），所以实际请求的是 `https://<host>/models`。Anthropic 官方 API 的模型列表在 `GET /v1/models`（头 `x-api-key` + `anthropic-version`，`limit` 最大 1000、默认 20，返回 `{data:[{id,…}],has_more,last_id}`），new-api / one-api 一类代理也只认 `/v1/models`。结果连随包的 Anthropic 预设都拉不到列表，用户只能退到 `openai-completions` 拉模型。issue 里「Anthropic 官方对 `/v1/models` 返回 403、没有公开的模型列表端点」的说法不对。
2. **自定义服务没有地方声明「只支持自适应思考」**：`UserModelMeta` 只有四个字段，IPC 白名单、`toPiUserProvider` 都不写 `compat`。所以用户自己加的 Claude 行即使协议选对了，也没有 `compat.forceAdaptiveThinking`。
3. **于是任何档位都会 400**：没有这个 compat 时，pi-ai 0.85.1 的 `anthropic-messages` 对有档位的请求走预算思考 `thinking:{type:"enabled", budget_tokens}`。「默认」档也一样：会话请求不带档位时，`resolveRoute`（`src/shared/dshModelPlan/route.ts`）按决策 040 填成 `medium`，同样走预算路径。Opus / Sonnet 4.6 及之后的模型拒收，报 `requires adaptive thinking`。issue 评论里「默认/关闭时发 `{type:"disabled"}`」的说法不对：DSH 分支的会话请求「默认」就是 `medium`。
4. 模型计划层（决策 141）对这种行只记一条 `adaptive_thinking_undeclared` 提示，不改下发内容。这是有意的：只凭 id 判断，误判的代价更大。
5. 失败卡片：`requires adaptive thinking` 不在 `MODEL_SETTING_PATTERN` 里，落成普通 `PROVIDER_ERROR`，卡片不提示该去哪里改。

## 2 决定

### 2.1 拉模型列表：按协议给出有序的尝试序列

- 新增纯函数 `providerModelListAttempts(baseUrl, api)`（`src/shared/userProviders.ts`），返回有序的 `{url, path, auth, onlyAfterRefusal?}`。它会先按存储规则规范化地址，所以粘贴的 `…/v1`、`…/v1/messages` 也能用，对已存的地址不起作用。原来「One path for every style」的注释已改写。
- `anthropic-messages` 依次是：
  1. `{root}/v1/models?limit=1000`，带 `x-api-key` + `anthropic-version: 2023-06-01`（官方 API）；
  2. 只有第 1 步答 401 / 403 时：同一 URL，改带 `Authorization: Bearer`（只认 Bearer 的代理）；
  3. 前面的 `/v1` 请求以任何非传输层原因失败后（任何非 2xx，包括 400 / 5xx；不是 JSON；列表为空）：旧的 `{root}/models`，带 Anthropic 头。这是兜底，让以前能用的服务继续能用。
  - 任何一步都**不会同时带两种鉴权头**。带子路径的地址保持子路径（`…/anthropic` → `…/anthropic/v1/models`）。
- 其他协议不变：仍然只请求一次 `{base}/models`，头与原来一样（`pi-messages` 仍带 Anthropic 头）。
- `UserProviderService.fetchModels` 按序执行：
  - 传输层错误（DNS、拒绝连接、超时）**立即停止**，返回原错误信息；换路径也到不了同一台主机。
  - 第一个合法且非空的列表即为结果。`extractModelIds` 已经能解析 `{data:[{id}]}`，官方返回形状不需要改。
  - 非 2xx 的响应体在后台读完丢弃，免得 `net.fetch` 的连接挂着。
  - 全部失败时：只要有一步是 401 / 403，就报 `the service refused this API key`；否则报第一个 HTTP 状态（都没有状态时报第一个失败的原因），试过多条路径时附上路径，例如 `the service answered 404 (tried /v1/models, /models)`。只试了一条路径时不加后缀，与原来的文案一致。错误仍是英文原句，由对话框的 `Could not reach this service — {{reason}}` 包起来显示，与现有做法一致。

### 2.2 每个模型的「自适应思考」开关

- `UserModelMeta` 增加 `adaptiveThinking?: boolean`：只对 `anthropic-messages` 有意义，打开即意味着 `reasoning`。IPC 的 `readDraft` 与 `reasoning` 一样只收布尔值。
- `toPiUserProvider`（`src/main/services/piModelConfig/PiModelConfigService.ts`，新抽出 `toPiUserModel`）：`adaptiveThinking` 不以这个名字写进 `models.json`。`anthropic-messages` 且为 `true` 时写 `reasoning: true`、`compat: {forceAdaptiveThinking: true}`、`thinkingLevelMap: {off: null}`，与 1.0.x 的临时办法（`implementation-status.md` 2026-09-30 条目）同一组字段，物理 `models.json` 对任何 pi 读者都自洽。其他协议直接丢掉该字段，以免产生 `compat_not_offered` 噪声。行上已有的 `compat` / `thinkingLevelMap` 会合并，不会被覆盖。GW-16 的 `supportsCacheControlOnTools: false`（决策 159）是计划层按路由加的，不经过这里，互不影响；`src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts` 的 GW-16 用例照旧通过。
- 计划层不改：这样的行有效 `forceAdaptiveThinking === true`，`off` 本来就是 `null`，计划给出 low / medium / high 三档，不记 `adaptive_thinking_undeclared`，也不记 `adaptive_thinking_forced`。pi-ai 的强制分支发 `thinking:{type:"adaptive"}` + `output_config:{effort}`。
- 对话框（`ProviderSetupDialog.tsx` 的 `ModelMetaRow`）：只在接口风格为 Anthropic Messages 时，在「推理」之后加一个原生复选框「自适应思考」。用原生 `<input type=checkbox>` 并排放在「推理」后面，原有测试取第一个复选框当「推理」，不受影响。勾上它会同时勾上「推理」；取消「推理」会一并取消它。元数据小节顶部有一段说明（i18n）：Opus / Sonnet 4.6 及之后（含 5.x）只接受自适应思考，报 `requires adaptive thinking` 时打开；更早的模型（Haiku 4.5、Sonnet 4.5 及之前）要关闭；打开后建议输出上限 ≥ 32000，因为用户行不填时默认 8192（`tables.ts` 的 `DEFAULT_MAX_TOKENS`），高档位的自适应思考可能把它用完。保存时接口风格不是 Anthropic Messages 就丢掉该字段。
- 这些规则都放在 `src/shared/userProviders.ts` 的导出纯函数里：`applyModelMetaPatch`（两个开关的联动）、`modelMetaForApi`（去掉该协议不收的字段和未设置的字段）、`hasModelMeta`、`prefillModelMeta`（预填规则）、`modelMetaDraft`（保存载荷的 `modelMeta`）。对话框只调用它们。编排者已告知：用户随后要把每模型设置改成「当前选中模型的共享面板」，这次的界面改动保持最小，改版时可以原样复用这些函数。

### 2.3 修掉「取消勾选存不下来」的旧缺陷

- 原来的对话框 `save()` 会丢掉所有字段都未设置的条目，整张表为空时干脆不发 `modelMeta`；而 `UserProviderService.upsert` 收到缺省的 `modelMeta` 时保留已存的值（`draft.modelMeta ?? existing?.modelMeta`）。结果是取消某个模型唯一一个元数据字段后保存，旧值原样留着。对本开关来说，误开就再也关不掉。
- 改法：编辑时只要该服务已存有非空的 `modelMeta`，就总是显式发送 `modelMeta`，全部清空时发 `{}`（`modelMetaDraft` 的 `stored` 参数）。服务端「缺省 = 保留」的约定不变，非表单路径（如 `setEnabled`）不受影响；空表不写进 vault。新建服务、或编辑一个本来就没有元数据的服务时，行为不变（全空仍不发 `modelMeta`）。
- 连带变化：编辑时用行上的 X 去掉唯一一个带元数据的模型，现在会发 `modelMeta: {}`，已存的那条一并清掉（原来会残留在 vault 里，下次重新选上这个模型时又冒出来）。`userProvidersSettings.test.ts` 的「removes a selected model from the row itself」断言相应改为 `{}`。

### 2.4 预填（用户裁决 2026-10-09：对话框按 id 预填，计划层不猜）

- 纯函数 `suggestsAdaptiveThinking(modelId)`：取最后一个 `/` 之后的部分，允许 `us.anthropic.` 这类点分前缀，匹配 `claude-(opus|sonnet)-4[-.][6-9]` 与 `claude-(opus|sonnet|fable|mythos)-[5-9]`，后面不能紧跟数字，可以带后缀（`-5`、`.1`、`-20260101`、`-v1`、`:batch`、`[1m]`），不区分大小写；不匹配 Haiku。
- 对齐依据：pi-ai 0.85.1 随包目录（`dist/providers/data/*.json`）里带 `forceAdaptiveThinking: true` 的 Claude 行，正好是 Opus / Sonnet 4.6、4.7、4.8，Opus 5、Sonnet 5，Fable 5、5.1（anthropic、opencode、cloudflare、vercel、openrouter、github-copilot 各表一致，两种版本号写法都有）；Haiku 4.5、Opus / Sonnet 4.5 及之前都没有。Mythos 不在目录里，按用户的要求一并列入。
- 触发条件（`prefillModelMeta`）：接口风格为 Anthropic Messages，用户**刚刚点选**这个模型的标签，且该模型**还没有任何元数据**。满足时填入 `{reasoning: true, adaptiveThinking: true}`，并展开「各模型元数据」小节，让用户看得见、可以取消。编辑已有服务时，已存的元数据一律不覆盖；取消选择不会删除元数据，所以再次选上也不会重新预填。
- 计划层（`dshModelPlan/build.ts`）不按 id 猜，决策 141 不变。

### 2.5 失败卡片（修订决策 140 §24 的提示文案）

- `MODEL_SETTING_PATTERN`（`src/shared/dshFailureCodes.ts`，实时卡片、历史投影、`retryVeto` 共用；宿主经类型剥离加载）增加三个标记：`requires adaptive thinking`、`between_tools`、`output_config.effort`，都取自上游原文（决策 140 §22：只认上游自己的措辞）。这类 400 现在归为 `MODEL_SETTING_UNSUPPORTED`，不自动重试，卡片上没有「继续」。不含这些标记的 400 归类不变（`AT-CLASS-2` 用例）；流闸门和「没有可用上游」仍然优先。
- `MODEL_SETTING_UNSUPPORTED` 的提示改为两个方向都覆盖，并沿用决策 144 §13 的设置路径写法：
  - EN：`For an AI service you added, open Settings · Models · AI services → Edit → Per-model metadata: Claude Opus 4.6 / Sonnet 4.6 and later need Adaptive thinking on (API style Anthropic Messages); older models need it off. Or turn off Reasoning for this model. For a model your administrator provides, forward the detail to them. Then send your message again.`
  - 中文：「如果是你自己添加的 AI 服务，请在「设置 · 模型 · AI 服务」里编辑该服务，在「各模型元数据」中调整：Claude Opus 4.6 / Sonnet 4.6 及之后的模型要打开「自适应思考」（接口风格为 Anthropic Messages），更早的模型要关闭它；也可以关掉这个模型的「推理」。如果是管理员提供的模型，请把错误详情转给管理员。改好后再发一次消息。」
  - 旧键「请在模型设置里检查这个模型的思考相关配置…」已删除。标题和原因不变。
- `GATEWAY_STREAM_GATE` 的文案（决策 140）已经覆盖 issue 的期望 5（重试无效，换模型或调低思考档位），不改。

## 3 不做什么

- **不实现 `thinking:{type:"between_tools"}`**：pi-ai 0.85.1 和随附的 Anthropic SDK 都不认识这个取值，决策 036 不给 `llm-pi-ai` 打补丁。计划层对强制自适应的行本来就不下发 `off`（决策 141），现状已经是「省略 thinking」。症状三的 `claude` 路由已声明 `forceAdaptiveThinking`，会话轮不会发 `disabled`。issue 推测来源是旧会话或辅助路径，这次没有复现；若再出现，卡片会按 2.5 归类。记入想法收件箱。
- **不做手动输入模型 id**（拉不到列表时也能添加模型）：记入想法收件箱。
- **计划层不按 id 猜**（决策 141 不变），advisory 仍只是提示。

## 4 风险

1. **各家代理对 `/v1/models` 的鉴权没实测**：new-api / one-api 等对 `x-api-key` 与 Bearer 的处理只按公开资料推断。请用户用自己的 newapi 渠道点验一次「获取模型列表」（选 Anthropic Messages，地址填根地址或带 `/v1` 都可以）。
2. **失败时最多发 3 个请求**（`/v1/models` 两次、`/models` 一次）；传输层错误只发 1 个。
3. **开关可能被误开**：对 Haiku 4.5、Sonnet 4.5 这类只支持预算思考的模型打开它，上游会拒收 adaptive 参数。卡片提示两个方向，且 2.3 修复后可以关掉。
4. **输出上限 8192**：用户行不填输出上限时默认 8192，高档位的自适应思考可能用完；目前只在说明文字里建议设 ≥ 32000，不自动填。
5. **服务 id 与 pi-ai 内置 provider 同名**（例如服务名叫「Anthropic」或「OpenRouter」，路由键为 `anthropic` / `openrouter`）：DSH 会继承 pi-ai 目录里该模型的 compat，如 `supportsMidConvoEffort`、`allowedFallbackModels`。与决策 077 §2 同类，本次不修。
6. **已有的服务要用户自己勾选**：预填只在新选模型时触发，不迁移、不改写已存的服务。在此之前的临时办法：对报错的模型取消「推理」（不发 thinking，模型按上游默认运行）。

## 5 验证

新增或修改的测试：

- `src/shared/__tests__/userProviders.test.ts`：`providerModelListAttempts`（官方根地址、子路径、粘贴的 `/v1` 与 `/v1/messages`、其他协议不变）；`suggestsAdaptiveThinking` 匹配 21 个 id、不匹配 17 个；`applyModelMetaPatch`、`modelMetaForApi`、`hasModelMeta`、`prefillModelMeta`、`modelMetaDraft`（含编辑清空时发 `{}`）。
- `UserProviderService.test.ts`：`/v1` 直接成功且只带 Anthropic 头；`/v1` 401 → Bearer 成功；`/v1` 400 / 404 / 500 → `/models` 成功（不走 Bearer、错误响应体被读完）；HTML 页与空列表都会继续往下试；有 403 时报「refused」；其余报第一个状态并附路径；传输层错误只发一次；`openai-completions` 仍只发一次；`modelMeta: {}` 会清掉已存的元数据；开关原样保存。
- `userProvidersIpc.test.ts`：开关与空表能通过 IPC，非布尔值被拒。
- `PiModelConfigService.test.ts`：anthropic 行写出 `reasoning`、`compat.forceAdaptiveThinking`、`thinkingLevelMap.off: null`，文件里没有 `adaptiveThinking`；关闭时不写 compat；`openai-completions` 忽略该字段；已有的 compat / thinkingLevelMap 被合并。
- `piModelConfig/__tests__/dshModelPlan.test.ts`（MP-05，走真实组装）与 `src/shared/dshModelPlan/__tests__/dshModelPlan.test.ts`：这样的行三档 low / medium / high、带 `forceAdaptiveThinking`、没有 advisory；同服务下没开开关的行仍有 advisory。金样本 `dshModelPlan.snapshot.json` 没有变化。
- `dshFailureCodes.test.ts`：issue 原文与各标记单独出现都归为 `MODEL_SETTING_UNSUPPORTED` 且不重试；不含标记的 400 仍是 `PROVIDER_ERROR`；流闸门与无上游仍然优先。
- `sessionFailure.test.ts`、`failureCardProviderText.test.ts`：新提示文案；新增 DOM 用例，按 bridge 的方式把 issue 原文分类后渲染：显示新提示与原文，没有「继续」。
- `userProvidersSettings.test.ts`（轻量 DOM）：开关只在 Anthropic Messages 下出现；勾选联动；编辑后两项都取消发 `modelMeta: {}`；Anthropic Messages 下点选 `claude-opus-5-5` 会预填并展开小节，点选 `claude-haiku-4-5` 或在 `openai-completions` 下不会预填。

本地跑过（2026-10-09，Linux 开发机，一次一条）：`src/shared/__tests__/userProviders.test.ts` 54 例；`dshFailureCodes.test.ts` 16 例；`src/main/services/userProviders` 2 个文件 46 例；`userProvidersIpc.test.ts` 10 例；`src/main/services/piModelConfig` 6 个文件 118 例；`src/shared/dshModelPlan` 2 个文件 63 例；`userProvidersSettings.test.ts` 36 例；`sessionFailure` + `failureCardProviderText` 35 例；`retryVeto` + `liveEvents` 36 例；Static / Scan / Wiring 75 个文件 764 例；`src/shared/__tests__` 32 个文件 497 例；`scripts` 13 个文件 228 例，全部通过。根 `pnpm typecheck`、`pnpm typecheck:dsh-host`、改动文件 biome check 通过。

## 6 用户审批

- [ ] 2.1 拉模型列表的尝试顺序与错误文案
- [ ] 2.2 开关语义与 `models.json` 写法
- [ ] 2.3 编辑时显式发送空 `modelMeta`（含「行上 X 去掉模型」的连带变化）
- [x] 2.4 预填（用户 2026-10-09 已裁决）
- [ ] 2.5 失败卡片标记与提示文案（修订决策 140 §24）
- [ ] 风险 1：请用 newapi 渠道点验一次「获取模型列表」
