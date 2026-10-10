# 决策 171：自定义 User-Agent——全局一个值，经模型计划里的中继头与宿主的 fetch 包装发出（GitHub issue #7）

日期：2026-10-10。**状态：第 1 节为用户裁决（2026-10-10，issue #7 与答复）；第 2 节起为自主决定，待用户审批。**

来源：GitHub issue #7（dssaiy，`1.1.0-dsh.8`）：部分供应商按 User-Agent 放行，给我们的格式是 `claude-cli-pilab/版本`；DSH 固定发 `deepseek-harness/0.1.7-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`，会被拒。要求可以自定义，并且不改 DSH 内核（内核随 DeepSeek Harness 升级，补丁会丢）。调研与实测由编排者转述（报告不入库），用户 2026-10-10 答复。代码提交：`41738034`（功能）、`bd27ab0d`（假网关与集成测试）；集成测试 git 桩的顺带修复 `665e9bdb`。

修订关系：

- [决策 037](037-user-agent-test-first.md)（已批准）：本决策是 B 的改进版，有三处不同。
  - 范围：B 只改写发往我方网关的 UA；现在扩到所有路由，公司网关与自定义服务一律跟全局。
  - 匹配：不按 URL 匹配，按计划给每条路由写的私有中继头。
  - 前提：B 说「要与 `dsh-http-proxy` 的全局 dispatcher 组合」，这个前提不成立。宿主不装 dispatcher（[决策 157](157-outbound-proxy.md) §1.1），包装又在 fetch 层，以后装了 dispatcher 也互不影响。
  - A 的 `X-Pilab-Client` 不变，继续在每条路由上发。
- GW-5（[P1-5 真实网关证据](../evidence/p1-5-real-gateway-2026-09-30.md)）：那 4 条 `headers.User-Agent` 的 `reserved_header`，来自 F08 自动写进 `models.json` 的 `$AICLIENT_PI_USER_AGENT` 引用，不是管理员配置的值（管理端 headers 只能写 `$环境变量`，见 `configValidation.ts` 的 `validateProvider`）。本决策删掉这处写入，这 4 条从此不再出现（金样本见 §2.9）。
- 1.0.x F08（提交 `69576588`）：
  - 默认值恢复成它的 `claude-cli-pilab/<版本>`。
  - 它写进 `models.json` 的环境变量引用，在 DSH 分支已经没有任何代码解析，属于死代码，删除。
- [决策 159](159-gw16-cache-control-temp-switch.md)：复用它的 `onRendererSettingsWrite` 链路——设置一变就重建计划，宿主空闲时重启。它的「每个修订号记一行模式日志」旁边，加一行 UA。
- [决策 090](090-user-rulings-2026-09-28.md)「默认跟随 DSH」：这里的默认值不跟随 DSH，因为这是供应商准入问题，不是行为移植；「引擎默认」作为可选项保留。
- [决策 165](165-user-provider-adaptive-thinking-and-anthropic-model-list.md)、[决策 168](168-custom-service-model-settings-panel.md)：自定义服务的「获取模型列表 / 测试连接」也带这个 UA。不做按服务的 UA，与 168「不做 headers」一致。

## 1 用户裁决（2026-10-10）

1. **默认 UA = `claude-cli-pilab/<应用版本>`**：恢复 F08 的格式，复用 `PI_USER_AGENT_PRODUCT`，版本取 Main 的应用版本。设置里可以改回「引擎默认」（DSH 自带的 UA）。
2. **只做全局一个值**，不做按服务覆盖。托管服务（公司网关）和自定义服务一律跟全局。
3. 自定义服务的「获取模型列表 / 测试连接」（Main 的 `net.fetch`）也用这个 UA。
4. 不向 DSH 上游提 feature request。

## 2 决定（自主，待审批）

### 2.1 为什么只靠配置改不了（DSH 0.1.7-rc.2、pi-ai 0.85.1，读代码并实测）

- **我们的组合里只有 `llm-pi-ai` 发模型请求**。`llm-deepseek`、`llm-deepseek-account` 在 `bundle/cordis.patch.yml` 里关掉了。issue 根因表查的是 `dsh-llm-deepseek`：行号对，但那条路由我们根本没用。
- **决策 037 第 1 条「保留字」的出处**：在 `dsh-llm-pi-ai/lib/index.js`，共两处。
  - 1732-1740 行的 `requestHeaders()`：先去掉路由 headers 里任何大小写的 `user-agent`，再把 `attributionHeaders()` 放在最后，由 1883 行作为 `options.headers` 交给 pi-ai。
  - 2302-2308 行：模型发现在路由 headers 之后用 `headers.set` 写入 DSH 的 UA。
  - 路由 headers 不会进 pi-ai 的 `model.headers`。
- **pi-ai 三种协议的拼法**：都是先放 `{"User-Agent": "pi (…)", ...model.headers}`，再合入 options headers，对应 `openai-completions.js:548/571`、`openai-responses.js:177/199`、`anthropic-messages.js:147-158/726-729`。openai 6.40.0 与 @anthropic-ai/sdk 0.123.0 的 `buildHeaders` 对普通对象的同名键（大小写不敏感）取最后一个，所以 DSH 的小写 `user-agent` 胜出，线上只有一行。
- **白标入口**：`dsh-llm` 的 `attributionHeaders(identity)` 只在函数签名上支持，两个适配器调用时都不传参。导出的 `APP_IDENTITY` 是可变对象，改它能生效，但格式固定为 `名称/版本 (+url)`，去不掉 ` (+url)`，只能全局一个值；而且一旦 DSH 冻结它或改成预先算好的常量，就会静默失效。
- **环境变量**：pi-ai 没有 UA 相关的变量。两个 SDK 的 `OPENAI_CUSTOM_HEADERS` / `ANTHROPIC_CUSTOM_HEADERS` 在 defaultHeaders 之前合并，会被覆盖。
- **实测**（真宿主，三条路由各发一次一次性补全，抓头服务器只听 127.0.0.1）：

| 做法 | 三种协议的线上 UA |
|---|---|
| 现状 | `deepseek-harness/0.1.7-rc.2 (+…)`，一行；`X-Pilab-Client` 在 |
| 路由 headers 写 `User-Agent` / `user-agent` | 仍是 DSH 的 UA，被静默剥掉，`routeDiagnostics` 为空 |
| fetch 包装（预加载） | 包装给的值，一行 |
| 改写 `APP_IDENTITY` | `claude-cli-pilab/9.9.9-identity (+https://example.invalid/pilab)` |
| 中继头 + 包装（只给其中两条路由加中继头） | 两条是中继值，另一条是 DSH 默认；中继头没有到达网关 |
| 中继头但没装包装 | 两条中继路由都是 DSH 默认，且中继头到达网关（失效时的样子） |

  Node 24.18.0 的 fetch 收到同一个普通对象里的 `user-agent: A` 与 `User-Agent: B`，会发出一行 `A, B`；`Headers.set` 则是干净地替换。

### 2.2 机制：计划里的中继头 + 宿主的 fetch 包装

- **计划层**（`src/shared/dshModelPlan/build.ts`）：按设置算出一个 UA，写进**每条路由**的 headers，名为 `X-Aiclient-User-Agent`。
  - DSH 不拥有这个头，会原样带到每个请求上：聊天、子代理、压缩、目标轮次、一次性补全、重试、DSH 的模型发现都覆盖到。
  - `X-Aiclient-User-Agent` 与 `user-agent` 都列为保留名：models.json 里同名的头（管理端或用户写的，任何大小写）照旧记 `reserved_header` 并剥掉。
  - 「引擎默认」不写中继头。
  - UA 进入 `routes`，所以修订号随 UA 变化。
- **宿主**（`src/dsh-host/lib/userAgentRelay.ts`）：包装 `globalThis.fetch`。
  - 请求带中继头：删掉中继头，值通过共享校验后 `set('user-agent', 值)`；通不过就保留 DSH 的 UA（中继头照删），并只告警一次，不打印值。
  - 不带中继头：用原来的参数原样调用。
  - 头的来源取 `init.headers`，没有时取 Request 自己的。这与 Fetch 的规则一致：`init.headers` 会整体替换 Request 的头。
  - 包装是无状态的，不需要计划，也不需要知道 provider；MCP、插件等其他请求一概不碰。重复安装会被拒绝。
- **安装点**：`host.ts` 文件体最前面（`marks` 之后），在第一次 `import('@deepseek-ai/…')` 之前。`hostStatic.test.ts` 钉住两件事：安装早于第一个 DSH import；host.ts 没有静态导入任何 DSH 包。
  - `dsh-app-boot` 不派生子进程（只用 `worker_threads` 的环境数据接口），唯一的 Worker 是会话 JSONL 写盘，所以模型请求都在宿主主线程上，经过这个包装。
- **为什么不按 URL 匹配**：两个服务可能填同一个地址；中继头天然是按路由的，以后要做按服务覆盖也不用改宿主。
- **为什么不用 undici 的 dispatcher 拦截器**：`dsh-http-proxy` 的 `installGlobalProxy` 会替换全局 dispatcher（决策 157 的 B / C 都会调用它），拦截器会被冲掉。fetch 层的包装位于任何 dispatcher 之上。
- **宿主 bundle**：`HOST_INPUTS`（`scripts/dsh-host-build-lib.mjs`）加入 `src/shared/types/requestUserAgent.ts`。这个文件零依赖，`requestUserAgent.test.ts` 钉住它不导入任何东西；`dsh-host-build-lib.test.mjs` 实际跑一次 esbuild，核对 bundle 的输入清单。

### 2.3 取值与校验（`src/shared/types/requestUserAgent.ts`）

- **三种模式**：`default`（默认）、`engine`、`custom`。
  - 设置键：`requestUserAgentMode`、`requestUserAgentCustom`。
  - `PI_USER_AGENT_PRODUCT`（`claude-cli-pilab`）从 `src/shared/piModelConfig.ts` 迁到这里。
  - `defaultRequestUserAgent(版本)` 得到 `claude-cli-pilab/<版本>`；没有版本时只有 `claude-cli-pilab`，不留尾随斜杠。
- **校验** `checkRequestUserAgent`：去掉首尾空白后，长度 1～256，只允许可见 ASCII 与空格（0x20～0x7E）。换行、制表符、NUL、中文与其他非 ASCII 都拒绝，也就杜绝了用换行夹带第二个头。
  - 同一个函数用在 6 处：设置页输入框、store 的 setter（写入口）、设置迁移、计划构建、Main 的模型列表、宿主的包装（兜底）。
- **回落** `resolveRequestUserAgent`：
  - 自定义值不合法（含空）：按默认值发送，计划里记一条 `{kind:'setting', setting:'userAgent', reason:'invalid_user_agent', detail:<原因>}`，Main 的「left out」日志里是 `setting userAgent: invalid_user_agent (<原因>)`。此时路由与默认模式完全相同，修订号不变，宿主不重启。
  - 默认值本身不合法（版本串含非 ASCII，实际不会出现）：按引擎默认发送，同样记一条诊断。
- `DshPlanDrop` 增加 `kind: 'setting'` 这一种。菜单只认 `kind: 'model'`，不受影响。

### 2.4 生效时机与日志

- Main 的 `agent-host/requestUserAgentSetting.ts` 提供三样东西：
  - `requestUserAgentSettings()`：读设置。模式只认三种；自定义文字原样交给计划层去校验。
  - `resolveMainRequestUserAgent()`：Main 自己的请求用这个算出 UA。
  - `watchRequestUserAgent()`：挂在 `onRendererSettingsWrite` 上，**算出的 UA 变了**才调用 `resolveDshModelPlan()`。以下保存都不触发重建：别的设置、自定义文字被保留但当前不在自定义模式、非法值回落到同一个默认值。
- 重建后沿用决策 159 的链路：`onDshModelPlanBuilt` → `WorkerManager.reconcileModelPlan` → 没有在飞的工作时重启宿主 → 下一轮用新计划。
- **main.log**：
  - 每个新修订号记一行：`[dsh-plan] user agent: default (claude-cli-pilab/1.1.0-dsh.8), plan <12 位>`。另外三种写法：`user agent: engine default`；`user agent: custom (<值>)`；`user agent: custom value unusable (<原因>), sending the default (<值>)`。
  - 值变化时另记一行：`[dsh-plan] user agent changed to <值或 the engine default>; new plan`。
  - UA 不是机密，所以记值。

### 2.5 Main 的「获取模型列表 / 测试连接」

- `UserProviderService.fetchModels` 的每次尝试都带 `User-Agent`（Anthropic Messages 会依次试多个路径，每个路径都带）。
  - 引擎默认时不带，沿用 Electron 的默认 UA，因为 Main 拿不到 DSH 拼出的字符串。
  - 值来自 `resolveMainRequestUserAgent(app.getVersion())`，与计划同一套规则。
- **Electron 实测**（Linux，Electron 39.2.7，无窗口脚本打本地抓头服务器）：
  - `net.fetch` 带 `User-Agent` 或 `user-agent` 时，都照发我们给的值，只有一行。
  - 不带时发 `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36`。正式应用里可能还带应用名。
  - Windows 未实测（见 §5）。
- 发往公司服务器的请求（登录、托管目录同步、用量、公告、注册）不改。它们不是模型服务，按 UA 放行的是供应商。远程运行时下载、远程图片代理同样不改。

### 2.6 删除 F08 死代码

- `configValidation.ts`：删掉 `withClientHeaders`。`toPiModelsJson` 只照抄管理端写明的 headers，没写就不出现 `headers` 字段。
- `PiModelConfigService.ts` 的 `toPiUserProvider`：不再加 UA 引用，只保留 `$` 开头的用户 headers，没有就不写。
- `src/shared/piModelConfig.ts`：删掉 `PI_USER_AGENT_ENV`、`PI_USER_AGENT_HEADER`、`piUserAgent`；`PI_USER_AGENT_PRODUCT` 迁走（见 §2.3）。
- 测试：F08 那组三条与「三条写入路径都带 UA」那条，改成「models.json 不再写 User-Agent」的守卫（`PiModelConfigService.test.ts`）。Main 计划测试的 `ENV` 保留 `AICLIENT_PI_USER_AGENT` 并给它一个醒目的值，哪个写入方把它带回来，计划里就会出现这个值。

### 2.7 设置界面（`RequestUserAgentSection.tsx`，挂在「设置 · 模型」页「模型请求超时」之后、GW-16 实验开关之前）

- 标题「请求标识（User-Agent）」。说明写明它作用于发给模型服务的每个请求（含公司网关与自定义服务）和获取服务模型列表，并提示部分服务只接受特定的值。
- 行标签「User-Agent」，控件是三选一的 `ToggleGroup`：「默认 / 引擎默认 / 自定义」（与「提示词缓存」同一种控件）。
- 选「自定义」时出现输入框（`Field` + `Input`，`max-w-md`），占位文字是实际默认值 `claude-cli-pilab/<版本>`。
  - 文字先作为本地草稿，**回车或离开输入框时才提交**，而且只提交通过校验的值。原因：每次 UA 变化都会重建计划、空闲时重启宿主，不能每敲一个字就触发。
  - 清空后提交等于清除自定义值，此时按默认值发送。
  - 不合法时当场显示 `FieldError`（`aria-invalid`）：超长显示「最多 256 个字符。」，其他显示「只能包含英文字母、数字、空格和常见符号（可见 ASCII 字符）。」，并且不提交。
- 下方一行显示实际发送的值（`Ident` 等宽）：「实际发送：…」；自定义还没填时为「尚未填写，暂按默认值发送：…」。
  - 引擎默认时改为「使用引擎自带的 User-Agent（deepseek-harness/…）。获取服务模型列表时使用系统默认值。」
  - 再下一行写「从下一轮开始生效，无需重启。」
- **版本来源**：渲染层用 preload 的 `env.appVersion`（`package.json` 的 version），Main 用 `app.getVersion()`；打包后两者相同。
- **store**：`requestUserAgentMode`（默认 `default`）与 `requestUserAgentCustom`（默认空）。
  - setter 在写入口拦截：未知模式忽略；自定义值只收通过校验的值（去空白后保存）或空串。
  - `migrateSettings` 对手改的设置文件做同样的清理。
  - 切到别的模式时，自定义文字保留。
- 字号：说明行 `text-meta`（14px），值用 `Ident`（等宽 13px，只有 ASCII）。没有 `Button size="xs"`。组件全部来自 @coss/ui。
- i18n：`src/shared/i18n.ts` 文末单独一块（注释 `// Request identity / User-Agent (issue #7)`）。「默认」「自定义」复用已有词条；「从下一轮开始生效，无需重启。」在本块重复声明，因为决策 159 那一块会随实验开关删除。

### 2.8 测试设施

- **假网关**（`src/dsh-host/tools/fake-gateway.mjs`）：
  - 路径以 `/chat/completions`、`/responses` 结尾时，不论哪个计划，都用该协议自己的流格式回一段文字 `fake gateway ok (<wire>)`。
  - 每行日志新增 `wire`、`userAgentLines`（原始请求里 User-Agent 的行数；`req.headers` 只留第一行）、`relayHeader`（中继头的值，正常应为 null）。
- **bridge-smoke**：新增判定 `userAgentRelayed`：所有请求都发 `claude-cli-pilab/bridge-smoke`、只有一行、没有中继头。只统计请求行，不统计假网关自己的 `burst-completed` 事件行。
- **集成测试**（`dshSharedHost.integration.test.ts`）：
  - IT-01 原来断言 UA 以 `deepseek-harness/` 开头，改为断言 `claude-cli-pilab/it-p1-5`、一行、无中继头。
  - 新增「a User-Agent supervisor」：三种协议的三条路由，默认 / 自定义 / 引擎默认各起一台宿主，每条路由各发一次一次性补全（UA-1～3）。
- **顺带修复**：同一文件里 `../../git/runtime` 的桩缺少 `createGitEnv`。提交 `6626d618`（决策 162 的 git 读回退）开始用到它，从那以后 IT-15a/b/c 在 HEAD 上就是失败的（集成测试默认不跑，所以一直没人发现）。补上一行后通过。与 UA 无关，建议单独提交。

### 2.9 金样本

- `src/main/services/piModelConfig/__tests__/fixtures/dshModelPlan.snapshot.json` 已重录（`AICLIENT_UPDATE_FIXTURES=1` 只跑那一个测试文件，再 `biome format`）。差异只有三类：
  - 修订号：`4031e408…` → `1063419f5462e31e770a70ec82f782aa839b22e438bdd5978507d9a915049c93`；
  - `claude`、`gpt`、`grok`、`china` 四条路由各多出 `headers: {"X-Aiclient-User-Agent": "claude-cli-pilab"}`。这个测试的组装不传 `clientVersion`，所以没有版本号，也没有 `X-Pilab-Client`；
  - `dropped` 里四条 `headers.User-Agent` 的 `reserved_header` 消失（GW-5）。
- `bridge-record --check`：30 个场景 0 差异。录制样本里没有请求头，也没有模型计划的修订号。

## 3 风险

1. **DSH 升级时要复核三条**（宿主模块文件头里也写了）：
   - 路由 headers 仍原样带到请求上（`requestHeaders()`、`discoverModels`）；
   - pi-ai 和两个 SDK 仍在每次请求时读全局 `fetch`（`getDefaultFetch()`，DSH 不传 `fetch` 选项）；
   - 模型请求仍在宿主主线程上。

   任何一条失效时，表现都是中继头到达供应商、UA 回到 DSH 默认。自动闸会同时报错：集成测试 UA-1～3 与 IT-01、bridge-smoke 的 `userAgentRelayed`。
2. **中继头泄漏的后果**：供应商多看到一个无害的头，UA 退回 `deepseek-harness/…`。中继头里只有 UA 值，没有凭据。
3. **以后装代理**（决策 157 的 B / C）不影响包装。如果 DSH 改为显式传 `fetch`，或改用 undici 的 `request`，包装会被绕过，由第 1 条的闸发现。
4. **第三方服务能看到**应用的 UA 与 `X-Pilab-Client`（含版本号）。与决策 037 相同，本决策不改。
5. **自定义服务的 `headers` 字段**（保险库里有，界面不能编辑，只保留 `$` 引用）如果写了 `User-Agent`，会被计划层按保留名剥掉，以全局设置为准（裁决第 2 条）。
6. **改设置会重启宿主**：每次实际改变 UA 都会在宿主空闲时重启它，这台宿主上的空闲会话会重新打开（与决策 159 相同）。输入框只在回车或失焦时提交，避免逐字重启。
7. **Windows 未实测**：Electron `net.fetch` 带自定义 UA、宿主包装都只在 Linux 上验证过（同一套 Chromium 网络栈与 Node 24，风险低），见 §5。

## 4 验证（2026-10-10，开发机逐条跑，一次一个）

- 共享：`pnpm vitest run src/shared/dshModelPlan src/shared/__tests__/requestUserAgent.test.ts`：3 个文件、95 项。其中 `dshModelPlan.test.ts` 69 项（新增「User-Agent relay (decision 171)」一组 12 项，MP-07 的两条按新行为改写）、`requestUserAgent.test.ts` 20 项（新文件）。
- 新文件与改动最多的文件：`requestUserAgentSetting.test.ts` 11 项、`requestUserAgentSection.test.ts` 8 项（挂载，`electronAPI` 桩在 `vi.hoisted`）、`UserProviderService.test.ts` 42 项（新增 2 项）。
- 宿主：`userAgentRelay.test.ts`、`hostStatic.test.ts`、`scripts/__tests__/dsh-host-build-lib.test.mjs` 一起跑：3 个文件、114 项（分别为 14、46、54 项）。`userAgentRelay.test.ts` 覆盖四种入参（普通对象 / Headers / 数组 / Request）、没有中继头时原样透传同一个 init、大小写、被拒的值（制表符 / 非 ASCII / 超长）、只告警一次、不会重复安装，最后一组经 Node 自己的 fetch 打本地服务器读原始行。esbuild 跑 host bundle，输入清单含两个新文件。
- 相关文件一起跑（shared 计划、Main `piModelConfig`、`userProviders`、`requestUserAgentSetting`、`cacheControlOnToolsSetting`、渲染层 `components/settings` 与 `stores/settings`）：45 个文件、559 项。
- 门禁：
  - `pnpm vitest run Static Scan Wiring`：78 个文件、798 项；
  - `pnpm vitest run src/shared/__tests__`：35 个文件、541 项（含词条覆盖、无硬编码中文）；
  - `pnpm vitest run scripts`：13 个文件、228 项；
  - `pnpm vitest run src/dsh-host`：44 个文件通过、2 个跳过，844 项通过、11 项跳过。
- `pnpm typecheck`、`pnpm typecheck:dsh-host` 通过；改动文件 `biome check` 无问题。
- 真宿主：`AICLIENT_DSH_INTEGRATION=1 pnpm vitest run src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts`：
  - `-t "IT-01|UA-|drift gate"`：5 项通过。日志：`[p1-5] User-Agent sent: claude-cli-pilab/it-p1-5`；默认三种协议都是 `claude-cli-pilab/it-ua`；引擎默认是 `deepseek-harness/0.1.7-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`；漂移闸在新金样本上没有路由诊断。
  - `-t "sixth supervisor|completion supervisor|User-Agent supervisor"`：补上 `createGitEnv` 桩之后，IT-01/02/03/06、IT-15a/b/c、UA-1～3 全部通过。
- `out-node-runtime/node src/dsh-host/tools/bridge-record.ts --check`：30 个场景、0 差异，退出码 0。
- `bridge-smoke`：70 条判定全为真（新增 `userAgentRelayed`）。共 52 个请求，UA 都是 `claude-cli-pilab/bridge-smoke`，没有中继头，没有多行。
- Electron：见 §2.5。
- 未做：GUI 点验与整包构建（开发机不跑）；Windows（见 §5）。

## 5 Windows 现场清单（测试包 `1.1.0-dsh.9` 起）

1. 「设置 · 模型 → 请求标识（User-Agent）」默认选中「默认」，下方显示 `实际发送：claude-cli-pilab/1.1.0-dsh.9`。
2. 用 issue #7 里按 UA 放行的那家供应商添加自定义服务：「获取模型列表」成功，对话、提交信息、代码审查都成功。
3. 切到「引擎默认」：同一家服务应当被拒（如果它确实按 UA 拦截），说明开关真的生效；切回「默认」后恢复。
4. 「自定义」：输入 `claude-cli-pilab/1.0.5` 后回车，下一轮生效（宿主空闲时重启，会话重新打开）；输入中文，当场报错且不保存。
5. 公司网关：请管理员在网关日志里确认，UA 从 `deepseek-harness/…` 变为 `claude-cli-pilab/<版本>`，`X-Pilab-Client` 照旧。
6. 如果有代理环境（设置 · 网络开了代理）：获取模型列表经 Electron 走代理，UA 正确（Electron 在 Windows 上 `net.fetch` 带自定义 UA）。
7. main.log 里有 `[dsh-plan] user agent: default (claude-cli-pilab/…)`；改设置时出现 `user agent changed to …; new plan`。

## 6 用户审批

- [x] 第 1 节（用户 2026-10-10 已裁决）
- [ ] 2.2 机制：中继头 `X-Aiclient-User-Agent` + 宿主 fetch 包装（决策 037 B 的改进版，范围扩到所有路由）
- [ ] 2.3 校验规则（1～256、可见 ASCII 与空格）与非法值回落默认、诊断 `invalid_user_agent`
- [ ] 2.4 生效方式（复用决策 159 的重建链路，UA 实际变化才重启宿主）与日志里记 UA 值
- [ ] 2.5 引擎默认时，Main 的模型列表沿用 Electron 默认 UA
- [ ] 2.6 删除 F08 死代码（GW-5 的 4 条 `reserved_header` 随之消失）
- [ ] 2.7 设置界面（位置、三选一、回车或失焦才提交）
- [ ] 2.8 顺带修复的集成测试桩（`createGitEnv`）是否单独提交
- [ ] 风险 7：Windows 现场清单
