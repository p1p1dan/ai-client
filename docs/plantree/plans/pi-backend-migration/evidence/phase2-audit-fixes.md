# Phase 2 审计修复 — 落地与验证证据

**日期**：2026-08-29
**输入**：`docs/plans/2026-08-29-pi-backend-phase2-bugfix-prompt.md`（外部审计 13 项）
**范围**：P0 两项 + P1 六项 + P2 五项，全部施工完成；文档状态同步见本档末尾。

## 结论先说

- **13 项审计发现全部成立**，无误报。逐项根因与修法见下表。
- **代码施工完成，自动化验证全绿**；**真机 E2E 仍未做**（见「未完成」）。
- Phase 2 **不满足**正式签收条件：T09/T10 为 Deferred、T08-c 仍被 Q9 阻塞、
  真机审批 E2E 未跑。

## P0 — 安全与隔离

### 1. 权限插件不可用时 fail-closed

**根因**：三个独立缺陷叠成一个 fail-open。

1. `decidePermissionPlugin` 返回 `missing` 时，`piRuntime` 只发一条
   `fatal: false` 的 `host.error` 就继续建 session；而 `hostStatus.ts:135`
   对非致命 `host.error` 直接 `return prev`，所以用户看不到。
2. `permissionPluginConfiguredByUser` 只比对包名，不看 pi 的 `PackageSource`
   过滤字段。实测 pi `package-manager.js:1806` 的
   `collectPackageResources`：`autoload: false` 且无 `extensions` 模式 →
   `applyPackageDeltaFilter` 空列表直接 return，**什么都不加载**；
   `extensions: []` → `applyPackageFilter` 空列表，pi 自己的注释写着
   "Empty array explicitly disables all resources of this type"，**全部注册为
   disabled**。两种写法都会被旧代码判成「用户已配置」，于是我们的副本不注入，
   会话最终一个闸都没有。
3. `bindExtensions` 缺失或抛错时只记日志。插件是靠 `ui.select` 提问的，
   没有 UI 绑定 = 闸问不出话来。

**修法**：

- `permissionPlugin.ts` 重写。`permissionPluginConfiguredByUser` 的语义从
  「名字匹配」改成「**能确认用户配置会真的加载这个包的扩展**」：新增
  `packageEntryLoadsExtensions` 逐条对齐 pi 的过滤语义（`autoload:false`
  空模式 → false；`extensions: []` → false；全否定模式 → false）。
  `PermissionPluginDecision` 新增 `gated: boolean` 与 `detail`。
  判定方向是刻意不对称的，理由写在文件头：跳过我们的副本而用户其实没有闸 =
  fail-open；重复注入 = 双弹窗，烦但不危险。**所以「无法确认」一律落在注入。**
- 新增 `verifyPermissionExtensionLoaded()`：读
  `services.resourceLoader.getExtensions()` 的 `extensions`/`errors`。pi 对扩展
  载入失败的契约是**收集进 `errors` 然后继续**，所以这是「插件 import 时抛了」
  与「插件正在放行一切」唯一可区分的地方。
- `piRuntime.ts` 新增 `PermissionGateUnavailableError`。闸不成立时
  **不创建 pi session**（工厂里抛，工厂外再校验一次，防 SDK 吞异常），
  `send()` 捕获后发 **`fatal: true`** 的 `host.error` + `session.failed`。
  fatal 是刻意的：非致命那条渲染端会丢掉，而这正是绝不能被忽略的一类失败。
- `bindExtensionUi` 改为 fail-closed（无 `bindExtensions` / 绑定抛错 → 同上）。

**新增测试**：`permissionPlugin.test.ts` 25 例（npm/git/file/本地绝对路径/
无 scope 路径/禁用配置/过滤配置/半拷贝/错包/载入失败/未载入/无法验证），
`piRuntimeSessions.test.ts` 权限组 7 例（缺包、bind 不支持、bind 抛错、
扩展载入失败、列表里没有权限扩展、正常注入、用户已配置跳过注入）。

### 2. 多 Session / 多 Worktree 隔离

**根因**：`if (this.handle) return this.handle;` —— 第一个会话建的 handle 被后
续任何 workspace 的会话复用；`turn` / `abortController` / `currentSessionId` /
`unsubscribe` 全是类级单例。

**修法**：`PiAgentRuntime` 改为 `Map<sessionId, PiSessionState>`。每个 session
独占 handle、事件订阅、AbortController、流式投影 `turn`、**以及自己的 Extension
UI bridge**。`workspacePath` 变了就拆掉重建（resume 可以把同一个 sessionId 指到
另一个 checkout）。`stop`/`closeSession`/`teardownState` 全部只动目标 session。
`respondExtensionUi` 改为按 `runtimeId` 找 bridge——每个 session 一个 bridge，
所以一条应答只可能落在提问的那个 session 上。

`closeSession` 顺带补了一个真缺陷：原来不 abort pi session，关掉一个正在跑的
会话会留下一个没人听的 turn 在跑。

**新增测试**（`piRuntimeSessions.test.ts` 隔离组 6 例）：两 workspace 顺序发送
（各自 cwd 正确）、同 session 跨回合复用一个 runtime、两 workspace 并发发送
（工具事件 sessionId 不串）、A/B 同时运行时停 A（B 的 session 未 abort）、
关 A 后 B 继续（B 的 `agent_settled` 仍投射到 B）、session 换 workspace 后重建。

## P1 — 功能正确性

### 3. Stop 立即取消 pending Extension UI

**根因**：`stop()` 只 abort pi session。扩展卡在 `ui.select` 里等的是 bridge 的
Promise，abort 到不了那里——弹窗还在、Promise 永不 settle、turn 结束不了。

**修法**：bridge 新增 `cancelAll(reason)`；`stop()` **先排空再 abort**（先让扩展
的 Promise 拿到 fallback，turn 才展得开）。close / 换 workspace / dispose 各自
用对应 reason 排空。`ExtensionUiCancelReason` 新增 `'session_closed'`
（原来的四个词没有一个是「这个会话没了」）。

**新增测试**：弹窗等待期间 Stop（extension Promise resolve、
`extensionUi.cancelled` 带 `aborted` 与正确 uiRequestId、session 回到 idle
而非等超时）、不误取消另一个 session 的弹窗（B 的弹窗仍可应答）、
每个 session 的 bridge id 不同且跨 session 应答被拒、close/dispose 排空。

### 4. Runtime Event 契约漂移

**根因**：`EmitFn` 的类型是 `(event: Record<string, unknown>) => void`，
任何字段名都能编译通过。于是 `tool.completed` 发的是 pi 的 `isError`
（契约要 `ok`/`error`），`session.status.retry` 发的是 `errorMessage`
（契约要 `error`/`errorStatus`）。两处都编译通过、都上了线、都没有任何消费者
在读——失败的工具在界面上显示为成功。

**修法**：`runtimeEvents.ts` 新增 `RuntimeEventDraft`（对 union **逐成员**
distributive omit `seq`/`timestamp`；对 `type` 字面量分发会漏掉
`'session.completed' | 'session.failed' | 'session.stopped'` 这种一个接口带多个
字面量的成员）。`piRuntime` 所有发射改走私有 `this.emit(event: RuntimeEventDraft)`。

**这个类型当场抓到了额外一处漂移**：`message.completed` 多发了一个契约里没有的
`reason`，没有任何 runtime 发它、没有任何消费者读它——已移除。

`tool.completed` 现在发 `ok: !isError`，失败时 `error` 取输出文本、空输出时兜底
`'Tool call failed'`（渲染端把这串当失败原因显示，空串会读成「失败了但不知道
为什么」）。retry 映射为 `error`/`errorStatus`（数字状态转字符串，无状态为 `null`）。

**新增测试**（`piRuntimeSessions.test.ts` 契约组 5 例）：成功工具 `ok:true`
且无 `error`/`isError` 键、失败工具 `ok:false` 带错误文本、失败且无输出仍有原因、
retry 字段名映射、无 HTTP 状态时 `errorStatus: null`。

### 5. 附件 / effort / permissionPreference

**根因**：`piHost.ts` 的 `session.send` 要求 `text` 非空（协议明写「有附件时
可为空」），且根本没有读 `attachments`；`effort` 与 `permissionPreference`
在 pi 侧连解析都没有。

**修法**：

- 命令边界读取器抽到 `piHostCommands.ts`（`piHost.ts` 没有 `parentPort` 就无法
  import，抽出来才测得了）。`readAttachments` / `readEffort` /
  `rejectsPermissionPreference` / `hasSendableContent`。
- 附件：`buildPrompt()` 把 image 映射到 pi 的唯一附件槽 `PromptOptions.images`
  （`ImageContent = {type,data,mimeType}`），text 附件按 `--- name ---` 分段附到
  正文（pi 没有 document 块，正文是文本该去的地方）。**没有映射的 kind 抛错**，
  send 失败并点名，而不是悄悄少发。
- effort：`applyEffort()` 调 `session.setThinkingLevel()`。我们的五个词
  （low/medium/high/xhigh/max）是 pi `ThinkingLevel` 的子集，映射是恒等——
  但**调用本身不是可选的**。SDK 没有这个方法时抛错而不是静默忽略。
- permissionPreference：`SessionPermissionPreference` 的 union **只有
  claude-code 和 codex 两条臂，没有 pi 臂**，且 pi 的姿态由权限插件自己的
  rule 文件决定，本 Host 不写那些文件。所以 pi 会话**明确拒绝**该字段
  （`unsupported_capability`），并在 `host.ready` 里声明
  `capabilities.permissionPolicy: false`（**显式 false 而非省略**——省略读作
  「老 Host，不知道」，而这个 Host 知道答案）。

**新增测试**：`piHostCommands.test.ts` 13 例 + `piRuntimeModelSelection.test.ts`
新增 effort 3 例 / 附件 2 例 / `buildPrompt` 4 例。

### 6. `permission.activity` 接入 Timeline

**根因**：Host 早就在发，渲染端 reducer 没有这个 case。

**修法**：`ChatBlockType` 新增 `'permission_activity'`；`ChatBlock` 新增
`permissionActivity`。纯模块 `permissionActivityRow.ts` 负责记录形状、合并规则与
显示派生；`PermissionActivityRows.tsx` 渲染。

三条设计约束写进了代码注释：

- **一个 requestId 一行**。插件对同一个闸先发 `prompt` 再发 `decision`，两条都
  append 会让每次审批在时间线里出现两次。prompt 开行、decision 填结果——这也正是
  「关掉弹窗后结果仍在」的实现方式。
- **`policy_allow` 要留痕但不能吵**。tone 分四档，只有 `denied` 上颜色；
  用户做的决定与规则做的决定是两件不同的事实，画成一样要么夸大用户同意了什么，
  要么把自动的那些埋到没人注意到闸的存在。**没见过的 resolution 一律落在安静那侧**
  ——把自动放行标成用户决定是更坏的那个错误。
- **没有 sessionId 或会话不在屏幕上就丢弃**，不给不存在的 transcript 建 bucket。

不渲染未转义 HTML：全部走 React 文本节点，无 `dangerouslySetInnerHTML`。

**新增测试**：`permissionActivityRow.test.ts` 11 例、
`chatSessionsPermissionActivity.test.ts` 8 例（含 groupTimeline 的相邻合并与
不跨工具组合并）。

### 7. Extension UI 应答失败后的悬挂

**根因**：渲染端在 IPC **成功之前**就把弹窗移除，失败只 `console.error`。
结果是 GUI 没了、Host 那边还 pending —— turn 永远结束不了，用户既看不见也没法重试。

**修法**：语义改为「**Host 收到之前不关窗**」。`ExtensionUiState` 新增
`sending: string[]` 与 `sendErrors: Record<string,string>`（放 store 不放组件，
remount 不会把飞行中的守卫重置掉）。失败 → 保留弹窗 + `role="alert"` 提示 +
释放守卫允许重试。**不替用户发取消**：Host 那边的弹窗还在、还能答，替他发取消
会把一次网络抖动变成一次他没做过的拒绝。

**新增测试**：store 层「失败保留弹窗并记录原因」「重试后成功关闭」「飞行中被
Host 取消则跟随关闭」；model 层 4 例 send 追踪。

### 8. Extension UI 的窗口所有权路由

**根因**：`broadcastRuntimeEvent` 把所有事件发给所有 `BrowserWindow`。
文本流无所谓，但 `extensionUi.request` 是 Host 正阻塞等待的**提问**——广播会让
两个窗口同时弹权限框、抢答，第二个应答被拒，按下去的人只看到点了没反应。

**修法**：新增纯模块 `src/main/services/chat/extensionUiRouting.ts`。
所有权 = 最近驱动该 session 的窗口（create/resume/send 三个 IPC 处认领）。
**取消事件按「当初发给了谁」路由，而不是重新计算**——所有权可能在请求与取消之间
变过，重算会恰好在最要紧的时候错，把一个答不掉的弹窗留在原窗口。
无 sessionId（扩展 init 期提问）、所有者已关闭、未认领 → 回退广播。
Host 侧 runtimeId + sessionId + pending map 三重校验原样保留。

**新增测试**：`extensionUiRouting.test.ts` 13 例（双窗口定向、所有权转移、
init 期广播、窗口关闭回退、取消跟随原目标、混批回退广播、其他事件不受影响、
两条 settle 路径都释放条目）。

## P2 — 质量、打包与文档

### 9. 权限插件去重规则

**根因**：npm spec 用 `lastIndexOf('@')` 切版本（scoped 名自带 `@`），
git/本地路径靠 `includes(包名)`——git URL 里根本没有 scope，
`https://github.com/gotgenes/pi-permission-system.git` 永远匹配不上。
**这是 false negative**：我们的副本会和用户的一起注入，每次工具调用弹两次。

**修法**：`describePackageSource()` 按 pi 自己 `parseSource` 的顺序分三类。
npm 用 pi 的正则解析名；git 取 repo 名（URL 里只有这个）；本地优先读目录自己的
`package.json` name（`~/pi-extensions/pi-permission-system` 里装的可能是别的 fork），
读不到再退到目录名。**匹配到只是必要条件**——还得过
`packageEntryLoadsExtensions` 才算「用户已配置」。

### 10. runtimeId 生命周期

**修法**：选了审计给的第一条路。runtimeId 现在是**每个 Host session 一个**
（bridge 随 session 建），session 重建（关闭重开、换 workspace）时换新。
原地 session swap（reload/fork/switch）保持 bridge 但**排空**，所以旧应答落不到
任何 pending 条目。协议注释已按实际实现重写。

`extensionUi.cancelled` 的 reducer 改为 **runtimeId + uiRequestId 双匹配**：
id 只在单个 bridge 内唯一，只按 id 删会让 A 的取消关掉 B 还活着的弹窗。

### 11. 打包运行时与 LICENSE

**实测确认审计属实**：`node-addon-api` 与 `node-gyp-build` 确实随包（经
`tree-sitter-bash` / `node-pty` 传递依赖进来），且许可证被通用规则删掉了。

**修法**：

- `LICENSE_BEARING_PACKAGES` 补两个包；抽 `isLicenseFileName` / `findLicenseFile`。
- `verifyArtifact` 新增：权限插件 `package.json` + `src/index.ts` 必须在、
  `tree-sitter-bash.wasm` 必须在、**集合里每个「产物中存在的包」都必须有许可证文件**。
- smoke 从「入口被加载」升级到三段：① pi 载入扩展 ② **扩展注册了
  `tool_call` handler**（拦截点本身——载入了但不注册 handler 的插件从外面看和
  放行一切一模一样）③ **用产物里的 WASM 真解析一条复合 bash 命令**并要求两条命令
  都被枚举（只看见第一条会让 `git status && rm -rf …` 溜过为 `rm` 写的规则）。
- smoke 进 CI：`build.yml` 的 win + linux 两个 job 在 `build-agent-host` 之后各加
  一步硬门禁；根 `package.json` 加 `smoke:permission-plugin`。

**实测记录**：修复前对旧产物跑 smoke → `FAILED (2)`，两条都是缺许可证；
重新 `build:agent-host` 后 → `PERMISSION GATE INTACT`。

```text
[t08a] loaded: out-agent-host/node_modules/@gotgenes/pi-permission-system/src/index.ts
[t08a] handlers: session_start, resources_discover, session_shutdown, before_agent_start, input, tool_call
[t08a] bash parse: ["git status","rm -rf /tmp/definitely-not-real"]
[t08a] RESULT: PERMISSION GATE INTACT
```

**新增测试**：`agent-host-build-lib.test.mjs` +7 例（无入口的半拷贝插件、
完全没有插件、没有 bash 语法文件、三个包各自缺许可证、不在产物里的包不追究、
许可证文件名各种拼写）。

### 12. Extension UI 可访问性与反馈

- select 选项改用项目的 `Button`（`variant="outline"`），外层
  `role="group" + aria-label`。**不用 radiogroup**：这里点一下即提交，
  不是先选值再确认，报成 radio 会承诺一个不存在的状态。
- 空 `AlertDialogTitle` 兜底为 `Extension request`——标题渲染成空的弹窗没有可访问名。
- 队列 > 1 时显示 `Request 1/N`。
- IPC 失败改为弹窗内 `role="alert"` 可见反馈（见 P1-7）。

### 13. Biome 警告

`permissionActivity.ts` 的 `(() => void) | void` 改 `| undefined` 并写清理由
（没有任何调用方 unsubscribe，这个类型只是为了如实描述 pi 的形状）。
`biome check src scripts` **0 警告 0 错误**。

## 验证命令与结果

```text
pnpm typecheck                  ✅ 0
pnpm typecheck:agent-host       ✅ 0
pnpm test                       ✅ 262 files / 5275 tests（修复前 259/5229）
pnpm exec biome check src scripts ✅ 0 error / 0 warning
pnpm build:agent-host           ✅ 394.3MB (413,414,154 B)
pnpm smoke:permission-plugin    ✅ PERMISSION GATE INTACT
```

`pnpm lint`（= `biome check .`）报 **1 个既存 error**：
`docs/plans/2026-08-27-entry-design/logo-concepts-preview.html:410`
`noInnerDeclarations`。该文件是工作树里的**未跟踪文件**，任务明令不得改动，
与本批修改无关。

`pnpm build`（完整 Electron 构建）**未执行**：脚本固定 4 GiB heap，当前 VM
3.3 GiB，沿用 Phase 2/5 的既有处置。替代证据见上面的 `build:agent-host` 与
packaged smoke 两行。

## 新增/改写测试清单

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `agent-host/__tests__/permissionPlugin.test.ts` | 25（改写） | 源解析三类、过滤语义、半拷贝/错包、载入验证 |
| `agent-host/__tests__/piRuntimeSessions.test.ts` | 22（新） | 会话隔离 6 / 权限闸 7 / Stop 与 UI 4 / 事件契约 5 |
| `agent-host/__tests__/piRuntimeModelSelection.test.ts` | 12（扩写） | 模型 3 + effort 3 + 附件 2 + buildPrompt 4 |
| `agent-host/__tests__/piHostCommands.test.ts` | 13（新） | effort/附件/attachment-only/permissionPreference 拒绝 |
| `agent-host/__tests__/fixtures/piSdkStub.ts` | — | 按 cwd 建独立 session 的 pi SDK 替身，闸可开关 |
| `main/services/chat/__tests__/extensionUiRouting.test.ts` | 13（新） | 双窗口路由、所有权转移、取消跟随、条目释放 |
| `renderer/components/chat/__tests__/permissionActivityRow.test.ts` | 11（新） | tone 四档、未知 resolution、subagent、合并规则 |
| `renderer/stores/__tests__/chatSessionsPermissionActivity.test.ts` | 8（新） | 一 requestId 一行、幂等、跨 session、groupTimeline 合并 |
| `renderer/components/chat/__tests__/extensionUiModel.test.ts` | +7 | runtimeId 双匹配、send 追踪四例 |
| `renderer/stores/__tests__/extensionUi.test.ts` | +2 改 1 | 失败保留/重试/飞行中被取消 |
| `scripts/__tests__/agent-host-build-lib.test.mjs` | +7 | 权限闸文件 + 许可证 |

## 未完成 / 交由真机

1. **真机端到端审批 E2E**（审计验收场景 6~9）：模型发起工具调用 → 插件拦截 →
   GUI 弹窗 → 允许/拒绝/关窗 → 工具执行或不执行。需要真实模型调用，本批未做。
   **T08-b 的 Done 状态因此降级**，见 roadmap。
2. **GUI 点验**：权限活动行（四种 tone、亮暗双主题）、弹窗的 select 按钮组与
   `Request N/M`、发送失败提示，均未在屏幕上看过。
3. **多窗口真机验证**：路由逻辑有 13 例单测，但两个真实 BrowserWindow 的行为未实测。
4. **完整 `pnpm build`**：内存限制，见上。
5. **Windows 产物**：本机只验证了 linux-x64 产物；CI 的两个 smoke 步骤是新加的，
   首次真实运行结果待下一次 CI。
