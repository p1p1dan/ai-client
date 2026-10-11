# 决策 177：按模型的自动压缩策略——自动压缩被关掉时要知道，并尽量不让它被关掉

日期：2026-10-11。**状态：第 1 节为用户要求（2026-10-11）；第 2 节起为自主决定，待用户审批。**

来源：用户 2026-10-11 的要求（经编排者转达）；编排者同日核实的调研结论（`dsh-compaction-basic` 的阈值公式、默认 bundle 不带 config、摘要输出上限固定 65536）。[决策 176](176-session-commands-start-before-run.md) 第 1 节第 4 条把「自动压缩、摘要 `maxTokens`」留给另行处理，即本决策。代码提交：`645aeb52`（宿主策略）、`7d915232`（设置界面）。

修订关系：

- [决策 146](146-real-gateway-followups.md) 第 12 条「未覆盖：不到一半但窗口很小的行……跟随 DSH，不处理」：本决策处理。第 9 条（输出上限超过窗口一半时按四分之一下发）不变，规则抽成共享函数 `plannedMaxTokens`（`src/shared/dshModelPlan/tables.ts`），计划与设置面板共用，算法不变。
- [决策 168](168-custom-service-model-settings-panel.md)（自定义服务的「模型设置」面板）：「上下文与输出」分区末尾多一行自动压缩说明（§6.1）。它的两条输出上限警示不变。
- [决策 090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）：DSH 默认值能用的模型照旧，只在默认值让自动压缩失效或几乎无效时调整余量（§4），随包目录的模型全部不变（§5）。
- [决策 033](033-model-plan-via-configure-overlay.md)、[决策 159](159-gw16-cache-control-temp-switch.md)：不改 `configure` 协议。计划在宿主启动时固定，换计划就重启宿主，所以宿主每次启动按当次计划算一遍即可。
- [决策 015](015-probe-plugin-out-of-product.md)、[决策 110](110-user-rulings-2026-09-28-batch2.md)：产品 bundle 的 `cordis.patch.yml` 仍不出现 `compaction-basic`。测试专用 probe bundle 的 `auto` 开关照常生效（§3.3）。

## 1 用户要求（2026-10-11）

1. 自动压缩被关掉时要知道：用户能看到某个模型会不会自动压缩，大概在多少 token 时触发。
2. 更好的是让自动压缩不被关掉。
3. 全部用配置实现，不改 DSH 内核文件。

## 2 现状（读代码与实测核实）

### 2.1 DSH 怎么决定自动压缩

`@deepseek-ai/dsh-compaction-basic` 0.1.7-rc.2（`src/dsh-host/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`）：

- 默认 bundle 挂载它时不带 config（`dsh-base/cordis.patch.yml:340-341`）。默认值：余量 `headroomTokens` 65536、阈值比例 0.8、保留比例 0.16（`resolveConfig`，`lib/index.js:59-91`）。
- 每一步开始前（`agent/pre-step`，`lib/index.js:839`）调用 `compactIfNeeded`（`:914`）：
  - 取这次请求路由到的 provider / model；
  - 取窗口 W（`resolveModelInfo`）与预留输出 O（请求头的 `maxTokens`，没有就取模型配置的 `maxTokens`，`reservedCompletionTokens`，`:757`）；
  - 用 `resolveCompactSpec`（`:124-157`）算阈值：
    - 消息预算 B = W − O；
    - 阈值 = floor(min(0.8 × W, B − 余量))；
    - 保留尾部 = floor(0.16 × B)，必须小于阈值。
- 不成立时抛 `TargetPressureConfigError`，宿主日志 warn 一次（`:845-849`），之后这个模型不再自动压缩。超窗后的压缩重试（`agent/request-error` 上的 context-overflow 恢复）不经过这个公式，不受影响。
- 实算边界：B ≤ 78,019 时一定不成立。B 在 78,020 到 107,275 之间虽然成立，但「阈值 − 保留尾部」不到 24,576，一次压缩只能腾出很少的空间（B = 78,020 时只有 1 个 token）。
- 测量发生在每一步开始前、这一步的新消息加入会话**之前**（`dsh-agent-loop` `preStep`，`lib/index.js:902-906`）。所以一条很大的消息要到下一步才被量到。真宿主用例按此设计（§9）。

### 2.2 摘要请求的输出上限

- 摘要请求的 `max_tokens` 取策略的 `maxTokens`，默认等于余量 65536（`resolveConfig :64`，`summarizeWithLlm :318`），与模型自己的输出上限无关。手动 `/compact` 与超窗重试用的是同一个值。
- pi-ai 只把它夹到「窗口 − 当前上下文估算 − 4096」（`@earendil-works/pi-ai/dist/api/simple-options.js:4-9,17`），不夹到模型的输出上限。唯一的例外是 anthropic-messages 带预算思考的路径（`anthropic-messages.js:679`），而摘要请求不带思考档位，不走这条。
- 实测：普通回合发出的 `max_tokens` 就是计划里的输出上限（假网关抓包：8192）。
- 推断（未在真实网关验证）：对按模型上限严格校验 `max_tokens` 的服务（Anthropic 原生、OpenAI、DeepSeek 官方等），输出上限低于 65536 的模型，手动与自动压缩都会被 400 拒绝。

### 2.3 我们的计划给 DSH 的尺寸

计划（`src/shared/dshModelPlan/`）给每个模型行 `contextWindow` 与 `maxTokens`（输出上限超过窗口一半时按四分之一下发，决策 146）。宿主再用路由默认值 128000 / 8192 补齐没写的（`hostModelPlan.ts` `sizedModel`，`:113-120`），交给 `llm-pi-ai`。

## 3 配置怎么下发（结论）

1. **宿主按计划现算，作为内存里的启动 overlay 交给 `compaction-basic` 这一行，不写进任何 yml。**
   - 宿主已有同样的机制：`llm-pi-ai` 与 `agent-default-model` 两行就是按计划生成的 overlay（`hostModelPlan.ts` `modelPlanOverlays`，`host.ts` 的 `profileContext.overlays`）。
   - 一条 id patch 会**整体替换**该行的 config，不做深合并（`dsh-app-boot lib/index.js:2759,2922`）。
2. **按计划修订号生效，不改协议。**
   - 计划在宿主启动时固定（`host.ts` 只收第一条 `configure`，第二条忽略）。
   - 设置一变，Main 重建计划；修订号变了就在空闲时重启宿主（决策 159 的链路）。新宿主按新计划再算一遍。
   - 所以 `modelPolicies` 可以由宿主按计划现算，不必写死在 yml 里，也不必扩 `configure`。
3. **合并，而不是替换。**
   - 宿主先组合出全部 patch（各 bundle 层、源码运行时的 home 层、计划 overlay），读出 `compaction-basic` 这一行当时的 config，再在其上加 `modelPolicies`，作为最后一条 overlay（`host.ts` 新增一段，`lib/hostCompaction.ts`）。
   - 测试专用 probe bundle 的 `auto: !!js "…AICLIENT_DSH_COMPACTION_AUTO !== '0'"`（`tools/probe-bundle/cordis.patch.yml:11-13`）因此保留。若整体替换，P0-6 一类探针关掉的自动压缩会被重新打开。
   - 某一层自己设了阈值类的键（`headroomTokens`、`thresholdRatio`、`retainRatio`、`retainTokens`、`maxTokens`、`modelPolicies`）时，不加我们的策略，该行保持那一层的样子，宿主 warn 一行。只认 `auto`、`summarizationProvider` / `summarizationModel`、`compactionRetries`、`maxOverflowRetries` 这几个与阈值无关的键。
   - 该行不存在或被关掉时也不加，并 warn。
4. **为什么不写进产品 bundle 的 yml。**
   - 静态 yml 跟不上计划：模型列表、尺寸都随托管目录和用户设置变化。
   - `scripts/__tests__/packaging-config.test.mjs:251` 要求产品 patch 里不出现 `compaction-basic`（决策 015）。
5. **共享与打包。**
   - 计算放在 `src/shared/dshAutoCompaction.ts`：纯函数，没有任何 import。
   - 宿主（`lib/hostCompaction.ts`）、Main（`dshModelPlan/menu.ts` 给模型菜单逐项附上策略）、设置界面（`autoCompactionText.ts`）用同一份。
   - `scripts/dsh-host-build-lib.mjs` 的 `HOST_INPUTS` 加入这个文件，打包测试同步列出宿主 bundle 的新输入。

## 4 策略（自主决定）

对每个模型行，用 W、O（宿主交给 `llm-pi-ai` 的尺寸，即计划尺寸用路由默认值补齐后）算：

1. **DSH 默认值能用就照用。** 默认余量 65536 下阈值成立，且「阈值 − 保留尾部」≥ 24,576（下称**最小压缩跨度**）时，不改余量，阈值就是 DSH 的。
2. **否则调小余量，只调到刚好够。** 保留尾部不变，仍是 floor(0.16 × B)；余量取 B − 保留尾部 − 24,576，使阈值正好比保留尾部高出最小压缩跨度。
   - 余量不得低于 8,192（下称**最小余量**），即一步的增长加上摘要输出的空间。
   - 在两条规则的交界处（B = 107,276），阈值连续，不会跳变；B 越大，阈值越高或不变。
3. **两个下限都满足不了就判为不会自动压缩**，即 B < 39,009。原因分两种：
   - 把输出上限降到 W − 39,009 以下就能满足、且这个上限不低于 4,096 时，判为「输出上限太大」，并给出建议值；
   - 否则判为「窗口太小」。
4. **摘要输出上限**：取 min(65536, 模型输出上限)；余量调小时再不超过余量（保证余量容纳摘要输出）。
   - 判为不会自动压缩的模型同样设这个上限，因为手动 `/compact` 与超窗重试也用它。
   - 输出上限为 0 或没有时保持 DSH 的 65536。
5. **生成 `modelPolicies` 的规则**：只为与 DSH 默认不同的模型生成一条，形如 `{provider: 路由名, model: 模型 id, …}`。
   - 调了余量：同时写 `headroomTokens` 与 `maxTokens`。只写余量的话，DSH 会把摘要上限也设成余量（`resolveConfig :71`）。
   - 只是摘要上限低于 65536：只写 `maxTokens`。
   - 其余模型不写，保持 DSH 默认。

为什么是这几个数：

- **最小压缩跨度 24,576。** 一次压缩要压掉的，除了对话本身，还要盖过不参与压缩的系统提示与工具定义，以及摘要本身。
  - 实测宿主的系统提示加 23 个工具约 2.2k + 19.7k 字符，约 5.5k token。有 AGENTS.md（上限 64 KB）、skills、MCP 时更大。
  - 跨度比这些小，压完立刻又到阈值，每一步都会压缩。
  - 取 24,576 时，常见的 128k / 8192、128k / 16384 都落在 DSH 默认值里（跨度分别是 35,103、28,222），不受影响。
- **最小余量 8,192**：一步的增长（回复加工具结果）加上摘要的输出。再小就几乎每一步都会越过整个预算，只能靠超窗重试。
- **建议输出上限不低于 4,096**：再小，模型连一次像样的回复都放不下，这时该说的是窗口太小。

## 5 结果表

（「DSH 默认」是不加任何配置时 DSH 的结果；阈值、保留尾部、余量、摘要上限的单位都是 token，按 DSH 的估算。）

| 模型（W / O） | DSH 默认：阈值 / 保留尾部 | 本决策 | 写入 `modelPolicies` |
|---|---|---|---|
| 随包目录 claude、gpt（1,000,000 或 1,050,000 / 128,000） | 800,000 / 139,520（gpt 840,000） | 同 DSH | 不写 |
| 随包目录 grok-4.6（500,000 / 500,000，决策 146 计划为 125,000） | 309,464 / 60,000 | 同 DSH | 不写 |
| 随包目录 deepseek-v4（1,000,000 / 384,000）、glm-5.2（1,000,000 / 131,072） | 550,464、800,000 | 同 DSH | 不写 |
| 窗口、输出都没写（按 128,000 / 8,192） | 54,272 / 19,169 | 同 DSH，摘要 8,192 | `maxTokens: 8192` |
| 128,000 / 16,384 | 46,080 / 17,858 | 同 DSH，摘要 16,384 | `maxTokens` |
| 200,000 / 32,000 | 102,464 / 26,880 | 同 DSH，摘要 32,000 | `maxTokens` |
| 200,000 / 64,000 | 70,464 / 21,760 | 同 DSH，摘要 64,000 | `maxTokens` |
| 假网关 fake-1（200,000 / 8,192） | 126,272 / 30,689 | 同 DSH，摘要 8,192 | `maxTokens`（金样本差异的来源，§10） |
| 128,000 / 32,768 | 29,696 / 15,237（跨度 14,459） | 39,813 / 15,237，余量 55,419，摘要 32,768 | 余量 + 摘要 |
| 131,072 / 32,768 | 32,768 / 15,728（跨度 17,040） | 40,304 / 15,728，余量 58,000，摘要 32,768 | 余量 + 摘要 |
| 200,000 / 100,000（o3 一类） | 34,464 / 16,000 | 40,576 / 16,000，余量 59,424，摘要 59,424 | 余量 + 摘要 |
| 98,304 / 8,192 | 24,576 / 14,417 | 38,993 / 14,417，余量 51,119，摘要 8,192 | 余量 + 摘要 |
| 128,000（默认）/ 50,000 | 拒绝（保留尾部不小于阈值） | 37,056 / 12,480，余量 40,944，摘要 40,944 | 余量 + 摘要 |
| 128,000 / 64,000 | 拒绝（没有压力预算） | 34,816 / 10,240，余量 29,184，摘要 29,184 | 余量 + 摘要 |
| 131,072 / 65,536 | 拒绝 | 35,061 / 10,485，余量 30,475，摘要 30,475 | 余量 + 摘要 |
| 65,536 / 8,192（64k） | 拒绝 | 33,751 / 9,175，余量 23,593，摘要 8,192 | 余量 + 摘要 |
| 64,000 / 4,096 | 拒绝 | 34,160 / 9,584，余量 25,744，摘要 4,096 | 余量 + 摘要 |
| 65,536 / 16,384 | 拒绝 | 32,440 / 7,864，余量 16,712，摘要 16,384 | 余量 + 摘要 |
| 49,152 / 4,096（48k） | 拒绝 | 31,784 / 7,208，余量 13,272，摘要 4,096 | 余量 + 摘要 |
| 65,536 / 32,768 | 拒绝 | 不会自动压缩：输出上限太大，降到 26,527 即可；摘要 32,768 | `maxTokens` |
| 128,000（默认）/ 100,000（只填了输出上限） | 拒绝 | 不会自动压缩：输出上限太大，降到 88,991 即可，或填写窗口；摘要 65,536 | 不写 |
| 40,960 / 4,096、32,768 / 4,096、16,384 / 4,096 | 拒绝 | 不会自动压缩：窗口太小；摘要 4,096 | `maxTokens` |

随包目录（`resources/model-catalog/snapshot.json`）的 10 个模型全部是第 1 种情况，`modelPolicies` 为空，宿主不加 overlay，与改动前完全一样。

## 6 界面

### 6.1 自定义服务的「模型设置」面板（决策 168）

- 「上下文与输出」分区末尾，两个数字框之后，一行 `text-meta`（14px）。
  - 会自动压缩：`text-muted-foreground`。
  - 不会自动压缩：`text-warning`，位置与样式照输出上限的提示。
- 按面板当前的值计算，规则与计划一致：没写的用 128000 / 8192，输出上限超过窗口一半时按四分之一（决策 146）。
- 任一数字框有非法输入时不显示（那一栏的错误提示已经说明原因）。
- 文案（中文；英文键在 `src/shared/i18n.ts` 文末 `// Auto compaction policy` 一块）：
  - 「自动压缩：约在 34k token 时触发。」
  - 没填窗口：「自动压缩：约在 54k token 时触发（按默认上下文窗口 128000 计算）。」
  - 「此模型不会自动压缩：上下文窗口（32768）太小，留不出压缩所需的余量。对话超出窗口时仍会先压缩再重试；长任务建议换用窗口更大的模型。」
  - 「此模型不会自动压缩：输出上限（32768）占去了上下文窗口（65536）的大部分。把输出上限改为 26527 或更小，就会自动压缩。」
  - 没填窗口：「此模型不会自动压缩：输出上限（100000）占去了默认上下文窗口（128000）的大部分。请填写实际的上下文窗口，或把输出上限改为 88991 或更小。」
- 阈值是 DSH 自己的估算，所以取整说（34k、1.2M）；窗口、输出上限与建议值给原数，方便照着填。

### 6.2 「设置 · 模型」页

- 新增一节「自动压缩」，放在「模型管理」之后、「提示缓存」之前（`AutoCompactionSection.tsx`）。
- 说明：「对话快要占满上下文窗口时，引擎会自动把较早的内容压缩成摘要。各模型开始压缩的位置如下：」
- 列表 `divide-y rounded-md border`。每个模型一行：
  - 第一行是显示名（`text-ui`，截断，悬停显示 id）；
  - 第二行是与 6.1 同一句话（`text-meta`）。
- 末尾一行说明：「自己添加的 AI 服务：在上方「AI 服务」里编辑该服务，在「模型设置」中修改上下文窗口和输出上限；管理员提供的模型请联系管理员。」
- 数据来自与模型菜单同一份目录（`listPiModels`）。Main 组目录时用同一份计划给每个模型附上策略（`applyDshPlanToCatalog`，字段 `autoCompaction`，只有数字，不涉及 key），所以显示的就是宿主所用的。
- 页面打开时读一次；增删改服务（「AI 服务」列表通知页面）或托管同步之后再读一次。
- 没有任何模型带策略时（例如没有可用目录）整节不显示。

## 7 宿主日志

每次启动（即每个计划修订号）记一行，Main 的日志里是 `[dsh-host:gN:stderr]` 前缀。写法：

- 每个模型写：路由 / 模型、W / O；
- 再写阈值，或 `off (原因)`；
- 余量被调小时写 `headroom`，摘要上限不是 DSH 默认时写 `summary`；
- 开头汇总：模型数、调余量的个数、不会自动压缩的个数，以及 overlay 加了几条（或「DSH's defaults」「not applied: 原因」）。

一行放不下（Main 按 2000 字符截断宿主的 stderr）时拆成编号的几行。真宿主上的实例：

```
[dsh-host] auto compaction, plan ee6d1ffbad82 (4 models, 1 headroom lowered, 1 off; 3 model policies): aiclient-gateway/w64k 65536/8192 at 33751 headroom 23593 summary 8192; aiclient-gateway/w32k 32768/4096 off (window too small) summary 4096; aiclient-gateway/w200k 200000/32000 at 102464 summary 32000; aiclient-gateway/w1m 1000000/128000 at 800000
```

策略没加上时另有一行 warning：`per-model compaction policies not applied: <原因>`。

## 8 改动的文件

- 共享：
  - `src/shared/dshAutoCompaction.ts`（新）；
  - `src/shared/dshModelPlan/tables.ts`（`plannedMaxTokens`）、`build.ts`（改用它，算法不变）、`index.ts`、`menu.ts`（附 `autoCompaction`）；
  - `src/shared/types/agentCatalog.ts`（`AgentModelAutoCompaction`）；
  - `src/shared/i18n.ts`（文末一块 8 条）。
- 宿主：
  - `src/dsh-host/lib/hostCompaction.ts`（新）；
  - `src/dsh-host/host.ts`（组合后加 overlay、记日志）；
  - `lib/hostModelPlan.ts`（只改注释）；
  - `scripts/dsh-host-build-lib.mjs`（`HOST_INPUTS`）。
- 渲染层：
  - `settings/autoCompactionText.ts`（新）、`AutoCompactionSection.tsx`（新）；
  - `ModelSettingsPanel.tsx`、`PiModelManagementSettings.tsx`、`SettingsContent.tsx`、`UserProvidersSettings.tsx`（`onChanged`）。
- 没有改 `@deepseek-ai/`、`@earendil-works/` 的任何包文件，没有改产品 bundle 的 yml，没有改 `configure` 协议。WorkerManager 与输入框没有动。

## 9 验证（2026-10-11，Linux 开发机，一次一个测试进程）

- 两套 tsc：`pnpm typecheck`、`pnpm typecheck:dsh-host` 通过。
- `biome check`：23 个改动文件通过。
- `src/shared/__tests__/dshAutoCompaction.test.ts`（新，18）：
  - DSH 公式的复述：阈值、80% 上限、三种拒绝、78,019 / 78,020 边界；
  - 最小预算 39,009 是最小值；
  - 随包大窗口不写策略；Grok 500k 经决策 146 计划后照 DSH 默认；没写尺寸、200k / 32k 只写摘要上限；
  - 64k、128k / 64k 调余量；131072 / 32768 抬高阈值；32k 窗口太小；65536 / 32768 输出上限太大（26,527 可开、26,528 不可）；
  - 窗口太小与输出上限太大的分界；非整数尺寸；
  - 交界处阈值连续（B = 107,276）；
  - 网格上的不变式：跨度、余量上下限、摘要上限、与 DSH 复述一致、输出上限越大阈值不升。
- `src/dsh-host/lib/__tests__/hostCompaction.test.ts`（新，14）：
  - 按计划逐模型算策略（含默认尺寸、`~2` 路由）；只为与默认不同的模型生成策略；
  - overlay 合并（保留 probe 的 `auto` 表达式，不改原对象）；跳过的四种情况；组内找行；
  - 日志一行与拆行（每行 < 2000 字符）。
  - **与已安装 DSH 对拍**：直接取已安装 `dsh-compaction-basic` 的 `lib/types/config.js` 一段（`resolveConfig`、`resolveTargetPolicy`、`resolveCompactSpec` 原样）求值：
    - 818 组 W / O（22 × 19 的网格加 400 组确定性随机）× 3 种余量，复述的公式与 DSH 逐一一致；
    - 每组的 `modelPolicies` 交给 DSH 解析，得到的阈值、保留尾部、摘要上限与我们的预测完全一致；判为不会自动压缩的，DSH 都抛错；
    - 整份计划的 `modelPolicies` 一次通过 DSH 的配置校验。
- `src/shared/dshModelPlan`（77）：MN-01 改为不比 `autoCompaction`，新增附策略一例（按宿主的方式补齐尺寸、Grok 用计划后的输出上限）、`plannedMaxTokens` 一例。边界静态测试通过（`menu.ts` 只引入 `src/shared` 内的纯模块）。
- `src/renderer/components/settings/__tests__/autoCompactionSettings.test.ts`（新，12，happy-dom 挂载）：
  - 面板五种句子与样式（含决策 146 计划后的输出上限、非法输入时不显示）；
  - 设置页列表（显示与跳过、只在有策略时出现、`reloadKey` 变化后重读）；
  - 「AI 服务」改动后通知页面；页面接线。
- **真宿主**：`AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run src/dsh-host/__tests__/autoCompaction.integration.test.ts`，3 例通过。同一个本地假网关、三台宿主依次启动，每条请求抓包：
  1. 产品组合：
     - 日志行与 §7 一致；
     - 64k 模型两条大消息加一条短消息，第三个回合第一步前自动压缩一次，摘要请求 `max_tokens` 8192，没有 DSH 的「no pressure budget」警告；
     - 手动 `/compact`：200k / 32000 的摘要请求是 32000，1M / 128000 是 DSH 的 65536。
  2. 对照：home 层把该行的 `headroomTokens` 设成 65536（源码运行读 home 层），宿主跳过我们的策略并说明。同样三个回合没有任何压缩，并出现 DSH 自己的「leaving no pressure budget」警告。这就是要修的问题本身。
  3. probe bundle 设 `AICLIENT_DSH_COMPACTION_AUTO=0`：策略照加（日志 3 条），同样三个回合不压缩，`auto` 开关保住了。
- 门禁：`vitest run src/dsh-host`（51 文件通过，3 个按条件跳过）、`vitest run scripts`（13 文件 230 例，含宿主 bundle 的输入清单）、`vitest run Static Scan Wiring`（79 文件 822 例）、`vitest run src/shared/__tests__`（38 文件 624 例）、`src/renderer/components/settings` + `src/main/services/piModelConfig` + `agentCatalogIpc`（37 文件 467 例）。
- 没有起 Electron，没有跑整包构建；模型请求只发往本地假网关。

## 10 金样本

- `bridge-record --check`：一处差异，是本决策的预期结果，**需要编排者重录**（`-t compact`）：
  - `log.compact.json`：`$.events[28].data.maxTokens: 65536 -> 8192`（`compaction/summary` 事件记录的摘要上限；fake-1 是 200000 / 8192）。
- `dshModelPlan.snapshot.json`：不变（计划结构没变，MP-01 通过）。

## 11 风险与要在真实网关上取证的点

1. **摘要被截断（主要风险）**：
   - 没写输出上限的模型（按 8192），摘要上限从 65536 降到 8192；
   - 对不校验 `max_tokens` 的宽松服务，长会话的摘要（尤其服务端默认开思考的模型）可能超过 8192，报「summarization truncated」，这次压缩失败；
   - 以前这类服务用 65536 能成功。
   - 取证：用一个没写输出上限、默认思考的自定义服务模型跑长会话，看摘要的输出 token 数。
   - 缓解：在「模型设置」里写上真实输出上限。
2. **「65536 会被严格服务拒绝」仍是推断**：
   - 请在公司网关（Claude Opus / Sonnet 的输出上限是 32k / 64k）与 DeepSeek 官方（`deepseek-chat` 8192）上，各对一个改动前的会话执行 `/compact`，确认是否 400；
   - 再在改动后复测，确认通过。
3. **调小余量后阈值偏保守**：小窗口的触发点在窗口的 27%～65%。AGENTS.md 很大时（上限 64 KB，约 16k token），64k 模型仍可能压得比较频繁。请看真实会话里压缩的间隔。
4. **阈值是 DSH 的估算（约 4 字符一个 token）**，与服务端计费的 token 数不同，所以界面写「约」。
5. **「对话超出窗口时仍会先压缩再重试」依赖服务的报错**：服务端「上下文太长」的报错要被 pi-ai 识别为 `CONTEXT_WINDOW_EXCEEDED` 才会触发。网关改写了报错时，这句话不成立。
6. **DSH 升级漂移**：
   - 对拍测试直接读已安装包的配置段。DSH 改了公式或默认值，测试会失败；找不到该段时也会报错，不会静默通过。
   - dsh-base 将来若给这一行带上阈值类的 config，宿主会跳过我们的策略并 warn，不会两边打架。
7. **打开「设置 · 模型」页会构建一次计划**（与打开模型菜单相同）。修订号变了时，宿主会在空闲后重启。
8. **未做 GUI 点验**：只有 happy-dom 挂载测试。设置页新的一节与面板里的一行，要在 CI 包或用户机器上看一眼。

## 12 审批要点

- 第 4 节规则 1 的范围：除了 DSH 默认值直接失效的模型（B ≤ 78,019），也调整了「成立但几乎无效」的模型（B 在 78,020～107,275，例如 128k / 32k、131072 / 32768、200k / 100k）。这一段偏离了 DSH 默认（决策 090），理由见第 4 节。
- 两个下限的取值：最小压缩跨度 24,576、最小余量 8,192。
- 没写输出上限的模型，摘要上限按 8192（第 11 节风险 1）。
- 「设置 · 模型」页新增「自动压缩」一节的位置与内容。

## 用户审批

待审批。
