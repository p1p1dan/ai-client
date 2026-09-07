# 现场反馈取证 — 2026-09-07（Windows / 托管模式 / 0.4.0-test.7）

**来源**：用户在 Windows 真机的第三轮点验，四条反馈，第四条附抓包（`infoRecord.txt`）；
第五条是同一轮之后补报的启动横幅（见下第五节）。
**环境**：Windows 加密档、已登录（托管凭据模式）、本机装过 pi 与插件、工作目录 `E:/testaaa`。
**判定构建**：抓包里带 `subagent` / `ask_user_question` 工具，而这两个随包扩展是
`8948aef2`（2026-09-06，R03）才引入的，所以用户跑的是 **0.4.0-test.7 或其后**——
这一条决定了下面第二项不能用「装的是旧包」解释。

---

## 一、`pi-permission-system: project is not trusted` 弹提示 — 已修

**不是缺陷，是两个正确决定撞在一起。** 托管模式按 T08-c（D-Q9 决定 4）故意不给 pi
`projectTrusted`（`piModelConfig/index.ts` 的 `PI_PROJECT_TRUST_ENV: managed ? '0' : '1'`），
而扩展为了「降级作用域绝不静默」（上游 #644）在每次 `session_start` 和每次
`resources_discover` reload 都 `ui.notify` 一条 warning。

原文在 `@gotgenes/pi-permission-system@27.0.1` 的 `src/handlers/lifecycle.ts`：

```ts
export const UNTRUSTED_PROJECT_MESSAGE =
  "pi-permission-system: project is not trusted — skipping project-scoped " +
  "permission configuration. Only global policy applies. Grant project trust " +
  "to load this project's permission rules.";
```

它建议的补救（"Grant project trust"）在本应用里**不存在**：托管模式是故意不给的，
本机模式则本来就给了（`'1'`），所以这条消息只会出现在它无法被执行的地方。

**修法**：并入既有的同类过滤器。`extensionUiDisplayModel.ts` 早就有
`isMisleadingPermissionLegacyNotification`（挡的是随包 `config.json` 的「Legacy extension
config found at…」，同样是「本应用故意如此、补救建议是错的」），本次把它更名为
`isInapplicablePermissionNotification` 并加上这一条。按消息文本匹配是因为 `ui.notify`
只带 `{ message, type }`，没有 code 可认；只匹配最短的稳定片段，改写后重新出现而不是继续隐藏。

---

## 二、权限档菜单选完不关 — 根因确认，已修（U30 rev.2）

现场补充的两条观察定住了它：**按钮文字变成了「只读」**（说明 `handleSelect` → `applyTier`
全跑了、React 状态也更新了），但**按 Esc 和点菜单外面都关不掉**。
即：状态是对的，弹层压根没卸载。

根因在 `@base-ui/react@1.1.0` 的 `menu/root/MenuRoot.js`，`setOpen` 第一行就是守卫：

```js
const setOpen = useStableCallback((nextOpen, eventDetails) => {
  if (open === nextOpen && eventDetails.trigger === activeTriggerElement
      && lastOpenChangeReason === reason) {
    return;                       // ← 直接返回，什么都不做
  }
  …                               // 关闭的全部记账都在这行之下
```

U30-a 把 `<Menu>` 改成受控后，`applyTier` 里的 `setOpen(false)` 走的是
**写 prop** 这条路：`store.useControlledProp('open', …)` 的 layout effect 把 store 的 `open`
直接置为 `false`，**从来没有调用过 `MenuRoot.setOpen`**。于是：

1. 关闭时该做的记账一件都没做，弹层留在 `mounted` 状态；
2. 之后任何一次 dismiss（Escape 的 `useDismiss`、点外面的 outsidePress）再调 `setOpen(false)`，
   守卫看到 `open === nextOpen`（store 里已经是 `false`）就 return——**两条退路同时死掉**。

所以这不是「没修好」，是 **U30-a 把「不自动关」换成了「关不掉」**，比原来更糟。
而 U30 那一批的断言恰恰钉的是 `open={open}` 和 `setOpen(false)` 这两处源码文本——
它们全程是绿的，因为它们钉的正是出问题的那行。

**修法（U30 rev.2）**：不再受控，改用 Base UI 自己的关闭通道。

- 四个档位的 `MenuPrimitive.RadioItem` 加 `closeOnClick={!option.dangerous}`。
  `closeOnClick` 在 radio item 上默认 false（radio 语义是「来回切」），显式打开后
  Base UI 走它自己的 `menuEvents.emit('close')` → `setOpen` 正路，记账齐全。
  危险档保持 false，`handleSelect` 把弹层换成确认面板而不是应用档位。
- 确认面板的「应用」按钮是普通 markup、没有自己的 item click 可挂，所以用
  `Menu.Root` 的 `actionsRef`（`{ unmount, close }`，1.1.0 的公开 API）：
  `menuActions.current?.close()` → `store.setOpen(false, imperativeAction)`，同一条正路。
- 断言跟着改成钉**受控 prop 的缺席**（`not.toContain('open={open}')`），
  而不是钉某一处关闭调用——旧断言的教训就是「钉住了写法，没钉住行为」。

**仍是静态断言，没在真机复看**：这条和 U30-a 一样属于 JSX 形状改动，纯测试够不着。
但和 U30-a 不同的是，这次的机制有上游源码逐行对照（守卫那三行 + `closeOnClick` 的
`getItemProps.onClick` + `actionsRef` 的 `useImperativeHandle`），不是「写成这样应该就对了」。

**顺带发现的真缺陷（无关，未修）**：`ui/menu.tsx` 的 `MenuPopup` 用
`has-data-starting-style:` / `has-data-ending-style:` 写 Tailwind 变体。它们编译成
`:has([data-…])`，只匹配**后代**；而 Base UI 把 `data-starting-style` / `data-ending-style`
放在 **Popup 元素自己身上**（`MenuPopupDataAttributes`）。所以全仓所有菜单的开合动画
其实从来没播过——`transition-[scale,opacity] duration-150` 一直挂着，只是没有属性变化去触发它。
不影响开关，只影响观感。

## 三、首轮 11.15K 缓存写入 — 已按用户拍板落地（subagent 默认关）

抓包那一条请求的实测拆解（compact JSON 字符数）：

| 组成 | 字符 | 来自 |
|---|---|---|
| system prompt | 4,236 | pi 自带 |
| `read` / `bash` / `edit` / `write` | 2,836 | pi 自带 |
| `ask_user_question` | 3,792 | **本应用随包**（`@juicesharp/rpiv-ask-user-question`） |
| `subagent` + `get_subagent_result` + `steer_subagent` | 4,758 | **本应用随包**（`@gotgenes/pi-subagents`） |
| messages | 94 | 用户那句「你好」 |
| 合计 | 16,205 | |

即：**工具 schema 11,395 字符里有 8,550（75%）是本应用注入的两个扩展**，
而它们进的是每次请求都要重发的缓存前缀，用不用都在花钱。

**用户拍板**：`ask_user_question` 需要保留（渲染层的 `ui.select` / `ui.input` 消费者只有它这一个
生产者，关掉等于让一个已发布的界面永远不出现）；**subagent 默认关**。

落地形态是一个开关而不是删除：`bundledPlugins.mjs` 的表项加 `optIn: 'subagents'`，
包**照样打进制品**（`agent-host-build-lib.test.mjs` 新增一条断言钉住这点，否则打开开关会
解析成 `not_present`，读起来像构建事故）；Main 侧新增设置 `enablePiSubagents`（默认 false），
经 `AICLIENT_PI_OPT_IN_EXTENSIONS` 环境变量送到 Host，形状照抄 R01 的 `PI_BORROW_RESOURCES_DIR_ENV`
（一个值同时承载开关与目标，缺席 = 全关，旧 Main 落在保守那侧）。
界面在 设置 → Pi 资源 新增「随包扩展 / 子智能体」一节。

**另一半不在本仓**：抓包尾部的网关 trace 显示
`anthropic_cache_ttl_header_override / scope: request_header / ttl: 1h`，
而同一份文件里 Claude Code 的那条是 `ttl: 5m`。1h 缓存写入按 **2 倍**计价——
用户看到的「(2x)」是网关按流量来源改写的，pi 请求体里只有裸 `{"type":"ephemeral"}`。
长会话里 1h 更便宜（读按 0.1x 持续一小时），但第一轮看起来贵，这是 `ai.pilab.qzz.io` 的策略问题。

---

## 四、思考等级不生效 — 根因确认，修法在 onboard 模型目录（不在本仓）

反编译 `@earendil-works/pi-coding-agent@0.84.3` 的
`dist/bundle/chunks/anthropic-messages-JWX2WP65.js`，请求体是这样拼的：

```js
if (options?.thinkingEnabled) {
  const display = options.thinkingDisplay ?? "summarized";
  model.compat?.forceAdaptiveThinking === true
    ? (params.thinking = { type: "adaptive", display },
       options.effort && (params.output_config = { effort: options.effort }))
    : (params.thinking = { type: "enabled",
                           budget_tokens: options.thinkingBudgetTokens || 1024, display });
}
```

**`compat.forceAdaptiveThinking` 没设，就永远走 else 分支**——发 `budget_tokens`，
且**根本不发 `output_config.effort`**。抓包与此逐字吻合：
`"thinking":{"type":"enabled","budget_tokens":8192,"display":"summarized"}`，没有 `output_config`。

档位映射同一文件里：

```js
DEFAULT_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }
clampReasoning(effort) = (effort === "xhigh" || effort === "max") ? "high" : effort
```

所以旧分支下 **`xhigh` 与 `max` 被夹成 `high`**，七档实际只剩四个不同的数字；
而抓包里的 8192 正是 `medium`（= pi 的默认档），与用户是否选过档无关。

更要紧的是上游侧：`budget_tokens` 这一形态在 **Claude Sonnet 5 / Opus 5 上已被移除**
（官方口径：发送即 400；这些模型的深度控制是 `output_config.effort`）。
本仓台账在 Claude runtime 时代就记过同一条（`ledger-claude-mainline.md` 2026-07-26 行的 #8）。
现在网关没有 400 而是照单接收，所以症状是**静默无效**而不是报错——正是用户说的「好像不生效」。

**修法（模型目录数据，不改客户端代码）**：给 onboard 目录里 Anthropic 系模型补上

```json
{
  "id": "claude-sonnet-5",
  "reasoning": true,
  "compat": { "forceAdaptiveThinking": true },
  "thinkingLevelMap": {
    "off": null,
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max"
  }
}
```

- `compat` 与 `thinkingLevelMap` 客户端**已经透传**：`configValidation.ts` 收下，
  `toPiModelsJson` 原样写进 `models.json`，无需改代码。
- `thinkingLevelMap` 的值就是发给 `output_config.effort` 的字符串
  （pi 的 `mapThinkingLevelToEffort` 优先取表、取不到才 fallback 到 low/medium/high）。
  不点名 `xhigh` / `max` 的话，本仓的 `effortsForModel` 也不会把这两档显示出来。
- `off` 设成 `null`：pi 只在 `thinkingLevelMap?.off !== null` 时才发
  `thinking: {type:"disabled"}`；Opus 5 只在 effort ≤ high 时接受 disabled，Fable 系直接 400。
- 顺带影响：设了 `forceAdaptiveThinking` 后 pi 不再加 `interleaved-thinking-2025-05-14`
  beta（adaptive 自带），也不再为思考预算抬高 `max_tokens`。

**建议先在一台机器上验一次**再全量推：改完目录 → 客户端设置页同步 → 抓一次请求，
确认体里出现 `"thinking":{"type":"adaptive",...}` 与 `"output_config":{"effort":"..."}`。

### onboard 侧已做的改动（`/home/pi/code/jyw-cch-onboarding`）

目录数据在部署机的 SQLite 里、仓库中没有种子，所以那边改的不是数据，是**让这个坑不再是静默的**：

`/admin` 本来就能填 `compat`（自由 JSON 文本框）和逐档的 `thinkingLevelMap`，
但没有任何东西提示这两者**必须配套**——compat 那栏的提示词甚至写着「不确定就别填」，
正好把人从唯一让思考档生效的开关旁边引开。于是一个看起来配置齐全的条目可以完全不生效。

- `web/src/lib/payload.ts` 新增纯函数 `thinkingLevelsAreInert` /
  `modelThinkingIsInert` / `formThinkingIsInert`：api 落到 `anthropic-messages`
  （模型自己的 `api`，没有就取渠道的）、声明了档位、而 `compat.forceAdaptiveThinking !== true`
  → 判定为「声明了但不会上线」。
- `ModelEditor.tsx` 在思考档区块下方实时显示红色 Banner（勾上 compat 即时消失），
  compat 那栏的提示改成点名 `forceAdaptiveThinking`。
- `CatalogView.tsx` 的模型行加「未生效」角标，不打开编辑器也看得见。
- `tests/web/payload.test.ts` 加七条：`true` 之外的值（含字符串 `"true"`）仍判未生效、
  api 回落到渠道、没声明档位不报、compat JSON 敲到一半时不报（那是 `buildModelBody` 的活）。

**刻意做成警告而不是拦截**：`budget_tokens` 对 Haiku 4.5 及更早的模型是**正确**形态，
硬拦会把合法配置也堵死。它只在 Claude Sonnet 5 / Opus 5 及之后是静默错误。

那边同样**没跑 test / typecheck / lint**（没有 `node_modules`，本机也没有 bun）——
只做了逐文件语法检查、行宽对照 `biome.json` 的 `lineWidth: 100`（超长行经 stash 对照确认全是既有的）。

---

---

## 五、刚启动就报「Pi session service 已停止」而消息发得出去 — 已修

**用户原话**：「在测试机点击使用 xxx@jcdz.cc 后刚启动时还是会提示（发消息可用）：
Pi session service 已停止 / Retry / 点击 Retry 初始化 Pi session service /
capacity=10·slots=0·active=0」。

诊断行里 `capacity=10` 说明这个快照**是 Main 真答出来的**（不是占位值），
`slots=0` 说明池子确实还没有 worker。所以状态本身没错，错的是把它翻译成了「服务已停止」。

### 根因：一个自己造出来的竞态，加一个 10 秒的沉默期

`WorkerManager.state` 的初值是 `'stopped'`，`ensureReady()` 做的事只有一件：
`if (this.state === 'stopped') this.state = 'ready'`——不拉起任何进程。
渲染层在同一次挂载里同时发出两个 IPC：

| 发起方 | 调用 | 作用 |
|---|---|---|
| `useHostStatus` 的 prime | `getHostStatus()` | 只读，**不会**翻转 `stopped` |
| `chatSessions.initRuntime` | `ensureHost()` | 翻转成 `ready`，但返回值被丢弃 |

hook 的 effect 注册在前，读先到 Main，于是拿回 `state:'stopped'`；
随后的 `ensureHost()` 把 Main 翻成 `ready`，**却没有任何东西把这个事实送回横幅**——
Pi-only 之后 Main 已经不再发 `host.ready` / `host.error` 运行时事件
（`ipc/chat.ts` 自己的注释就写着这一点），所以渲染层唯一的第二次机会是
`useHostStatus` 里那个 **10 秒**的轮询探针。用户看到的就是这十秒。

同一个 `state:'stopped'` 在这十秒里还悄悄拖了另外两个控件：

- `piModelCatalog.shouldRequestCatalog` 的第一行是 `hostState !== 'ready'` → 不拉目录，
  模型菜单先显示「Host 未就绪」的兜底目录；
- `ComposerPermissionTrigger` 的 `isDisabled` 同样按 `hostState !== 'ready'` → 权限档按钮是灰的。

三处症状、一个根因。

**它不是回归，是上一次修法留下的另一半。** 2026-09-04 修过同一句文案
（[缺陷记录](../plantree/plans/pix-ui-alignment/evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md)
第一节，现象一字不差：「横幅说服务停了、还给了 Retry 按钮，而同一个对话框发消息正常收到回复」），
`WorkerManager.updateManagerState()` 的注释里至今逐字记着结论：空池子不能推导成 `stopped`。
但那次改的是**重算**路径，并且明写了「`ensureReady` 之前的初始值」仍然是 `stopped`——
留下的正是每一次冷启动都会走的那条路径。这一次修的是它。

### 修法

1. **prime 改用 `ensureHost()`**（`useHostStatus.ts`）。两个 IPC 的返回**形状完全一样**
   （`ipc/chat.ts` 里 `CHAT_ENSURE_HOST` 就是 `await ensureReady()` 后 `return getStatus()`），
   区别只在于它会先把没启动过的管理器翻成 `ready`。`ensureReady()` 只赋一个字段、不拉进程，
   所以一个「状态 hook」发这个调用是干净的。失败时 `.catch(() => getHostStatus())` 退回只读，
   这样「Main 拒绝启动」依然会如实显示成 `stopped`。
2. **Retry 采用自己的返回值**：原来 `retry()` 把 `ensureHost()` 的快照丢掉，
   等下一次 10 秒探针才可能变化——按钮按下去十秒不动，读起来就是个死键。
3. **初值从 `stopped` 改成 `unknown`**（`hostStatus.ts`）。「还没问过」和「问过了，答的是停止」
   是两件事，只有把它们分开，`stopped` 横幅才重新变得可信——现在它只在
   prime 真的失败或应用正在退出时出现。
4. **横幅的显示规则提成纯函数** `describeHostStatus()`。vitest 是 `environment: 'node'` +
   只收 `.ts`，渲染不了 `.tsx`；而「绝不谎报一个下一条消息就答得上来的服务」这条规则
   恰恰是最该有真实测试的那种，不能只靠源码字符串断言。

### 顺带修掉的两个同源缺陷

- **`degraded` 从来没在渲染层的联合类型里**。Main 的 `WorkerManagerState` 是
  `stopped | ready | degraded`，渲染层的 `HostStatus['state']` 是
  `stopped | starting | ready | error`，中间靠 `as` 强转。于是有 worker 崩过之后
  横幅会渲染成一条**没有标题**、却带着 Retry 按钮的空条。现在联合类型补齐了
  `unknown` 与 `degraded`，`describeHostStatus` 对每个分支都给得出标题。
- **`degraded` 被当成「不可用」**。它的真实含义是「池子里有一个 worker 崩了」，
  管理器照常服务：那条 entry 会在它自己会话的下一次 create/resume 时被退休
  （`WorkerManager` 里 `existing?.state === 'error'` 那段），期间还是头号驱逐候选。
  可原来的 `=== 'ready'` 判定会因为**别的**会话崩过一次，就把当前会话的权限档按钮变灰、
  把模型菜单钉在兜底目录上，直到那条 entry 被退休为止。两处改用共享的
  `isHostUsable(state)`（`ready || degraded`），`unknown` 仍然保守地算不可用——
  没答案不等于知道它能用。

### 验证

`hostStatus.test.ts` 新增两组纯函数用例（横幅规则、`isHostUsable`）与一组
`useHostStatus.ts` 的接线断言；`piModelCatalog.test.ts` 补 `degraded` / `unknown` 两档。
`startScreenBarStatic.test.ts` 里那条钉整行 `isDisabled` 的断言改成只钉两个承载规则的片段——
理由就是第二节 U30 的教训：**钉住写法而没钉住行为的断言，会在行为坏掉时一路全绿**。

**真机复看点**：冷启动后横幅不再出现，且模型菜单与权限档按钮在第一屏就是活的。

## 门禁

本轮改动在**本机未跑**项目自己的 lint / typecheck / test——本机是资源受限的小服务器，
仓库当前没有 `node_modules`，装依赖不划算。已做的替代校验：

- 每个改动的 `.ts` / `.mjs` 走 `node --experimental-strip-types --check` 语法通过；
- 新增的消息过滤逻辑用独立脚本对**扩展源码里的原文常量**跑过三例（命中/命中/不命中）；
- 第五节的两个纯函数用独立脚本实跑：`describeHostStatus` 的六个状态分支（`ready` /
  `unknown` / `degraded` 静默，`stopped` / `starting` / `error` 各有非空标题与正确的
  Retry 可见性）、`isHostUsable` 的六个状态、以及 `shouldRequestCatalog` 在六个状态下的
  取值（只有 `ready` 与 `degraded` 为 `true`）；新增的源码断言片段也逐条对当前源码比对过命中；
- `git diff --check` 干净；逐行宽度对照 `biome.json` 的 `lineWidth: 100` 核过。

**CI 是权威**。已知需要它复核的点：`bundledFeaturePlugins.test.ts` 里七处调用新增了
第三个参数、`piResourcesSettingsStatic.test.ts` 改了一条 `toContain`、
`piResources.test.ts` 的 `mergeSettingsPatch` mock 改成只应用 patch 里真有的键、
`bulkArchiveStatic.test.ts` 的 U30 三条断言整组重写（旧的两条钉的正是出问题的写法）。
