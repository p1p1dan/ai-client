# 决策 143：P1-7e 第五组（e5）的实现取舍：插件开关后宿主自己起来、插件页跟随；旧资产提示补上项目级；「本会话允许」放行的调用有活动行；图片边长上限对齐引擎

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-7e 分组](../topics/p1-7e-pointcheck-fixes.md) 的 e5 行与「编排者的默认取舍」（问题 30 按决策 129 第 16 条补上；问题 6 以引擎为准）；
- [P1-7d 点验证据](../evidence/p1-7d-gui-2026-09-30.md) 的问题 29（G2）、27（H1）、30（I2）、6（A7）；
- [决策 108](108-p1-10b-host-plugin-loading-choices.md) 第 7 条、[117](117-p1-10c-plugin-settings-choices.md) 第 1、13 条、[116](116-p1-16e-legacy-asset-notice-choices.md) 第 13、14 条、[104](104-legacy-asset-notice-and-extension-pages.md) 第 2 条、[129](129-p1-6d-pwsh-analysis-choices.md) 第 16 条、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）、[025](025-host-lifecycle.md) 第 1 条（空闲停止）；
- 用户 2026-09-18 的裁决「输出过程中不要再显示『授权详情』这个项目了」（`PermissionActivityRows.tsx` 文件头）。

改动留在工作区，由编排者复跑后提交。**第 3、7、16 条请重点审批。**

## 落地了什么

- Main：`services/agent-host/DshHostSupervisor.ts`（`onPluginReport`）、`WorkerManager.ts`（`startHostAfterPluginChange`）、`dshHostPlugins.ts`（`onDshPluginReport`）、`ipc/dshPlugins.ts`（推送 `dshPlugins:changed`）；`shared/types/ipc.ts`（新通道）、`preload/index.ts`（`dshPlugins.onChanged`）。
- 渲染层：`settings/DshPluginsSettings.tsx`（订阅推送）、`settings/LegacyAssetNotice.tsx`（关闭之前按工作区重查）、`chat/permissionActivityRow.ts`（`session_grant` 不算安静）、`chat/PermissionActivityRows.tsx`（注释）、`chat/attachmentLimits.ts`（8192）；`shared/utils/imageDimensions.ts`（注释）。
- 宿主：`dsh-host/bridge/dshSessionRuntime.ts`（会话授权放行的调用发 `permission.activity`）。
- 没有新文案：活动行用已有的「已允许 {{surface}}」「本会话已授权」，其余三项不涉及文案。

## 规则

### 问题 29：插件开关后宿主只停不起，插件页不刷新

1. **根因**：`setDshPluginSelection` → `WorkerManager.reconcileHostPlugins` → 空闲时 `invalidateAll`，关掉所有会话和宿主，之后没有任何东西再起宿主，要等下一次对话。插件页只在挂载时 `list()` 一次，宿主的新报告到了也看不见。
2. **宿主停下后立刻再起**：`invalidateAll` 完成后，若这次重启是因为插件选择变了，`startHostAfterPluginChange` 调一次 `ensureHost()`。新宿主上没有会话，它的 `ready` 带着新选择的插件报告；10 分钟没人用就按决策 025 第 1 条自己空闲停止。
   - 只从 `idle` 起：此时已经有会话把它起来了（`starting` / `ready`）、supervisor 已 `failed` 或 `disposed`，都不动；
   - 不算用户操作（不带 `userInitiated`），并且在重启预算超额时直接跳过：一次没人要求的启动不应该把 supervisor 打成 `failed`（那样之后要等用户操作才能再起）；
   - 有对话在跑时照旧每 2 s 复查（`hasWorkInFlight`，含一次性补全），空闲后才关、才起，不打断任何回合；
   - 只对插件选择做。模型计划变化（决策 033 第 4 条）仍是「关掉，下一个会话起新宿主」：那边没有页面在等报告。
3. **宿主没在运行时切换，不为此起宿主（请审批）**：从未起过、或已空闲停止时，切换只写设置；页面照旧显示「待重启生效」，直到下一次引擎启动。理由：没有正在运行的引擎就谈不上「自动重启」，只为刷新一个徽章起一个进程，10 分钟后它又会空闲停止。提示句「插件的改动在对话引擎下次启动时生效；引擎正在运行时，会等所有对话都没有进行中的工作后自动重启」对两种情形都成立，不改。
4. **报告推送**：supervisor 每次存下新的 `ready.plugins`（格式不对的报告不算）就通知 `onPluginReport` 的监听者，给的是副本，监听者抛错只记日志。`dshHostPlugins.ts` 加第四个调用 `onDshPluginReport`；IPC 模块注册时订阅一次，每次通知后按 `list` 的同一算法算出整页状态，发 `dshPlugins:changed` 给所有未销毁的窗口；算不出来时不发，只记日志。
5. **页面跟随**：`DshPluginsSettings` 挂载时订阅 `dshPlugins.onChanged`，卸载时退订。收到推送就整页替换；推送里 `hostReported` 为真时清掉「本次访问切换过」的标记，此后提示与「待重启生效」只按各行的 `pendingRestart` 判断，所以重启完成后徽章变「已加载」、提示消失。推送比挂载时 `list()` 的应答新：推送先到时，晚到的应答不再覆盖。
6. **应用刚启动、引擎还没起过**时页面开着：第一次对话起宿主后，页面同样自动换成宿主的报告，「对话引擎自应用启动以来还没有运行过」那句随之消失。
7. **两个源码扫描测试随接口扩展更新（请审批）**：
   - `dshPluginsIpc.test.ts` 钉「IPC 只从 agent-host 导入 `dshHostPlugins.ts` 的调用」，清单由三个变为四个（加只读的 `onDshPluginReport`）；同文件「不写设置、不重启」的禁止项清单一字未动；
   - `dshPluginsSettingsStatic.test.ts` 钉「页面只经插件通道与 Main 通信」，集合加 `dshPlugins.onChanged`。
   两个测试的意图（只经 `dshHostPlugins.ts`、只经插件通道、不自己写设置或重启）不变，改的是它们列举的接口本身。
8. **真宿主集成测试**：插件一组的 `select()` 改为等宿主以新选择自己起来（旧宿主先退、之后恰好一个宿主、不需要会话）；PLG-1 在切换后、发消息前就断言报告已是 `disabled`；PLG-4 把篡改 profile 挪到切换之前，因为现在读 profile 的是切换引起的那次启动。

### 问题 27：第一次启动时旧资产提示漏了项目级三类

9. **根因**：`LegacyAssetNoticePrompt` 第一次检测时工作区还没恢复（第一次启动时工作区经 `--open-path` 由 Main 送来，晚于挂载），只要用户层有内容就弹出并立即记为「定了」，之后工作区到了也不再查。决策 116 第 13 条的「弹出之前工作区变了就重查」只覆盖了「第一次什么都没查到」。
10. **选「先弹用户层、工作区就绪后补进同一个提示」，不选「等工作区恢复后再检测」**：渲染层没有「工作区恢复完成」的可靠信号——从 localStorage 恢复与挂载同一轮，`--open-path` 的时间不定，没有工作区的启动则永远等不到；要等就得设超时，超时之后仍是同一个问题。
11. **规则**：
    - 「已答」只有两种：以前看过（`seen`），或本次启动里关过这个弹窗。已答之后本次启动不再检测；
    - 弹出而还没关的时候，工作区每变一次就重查一次；结果有内容就整份替换列表（新结果本来就含用户层，再加上这个工作区的项目级）；
    - 新结果什么都没有（用户层为空、这个工作区也没有），保留弹窗里现有的列表；检测失败也保留；
    - 替换而不是跨工作区合并：项目级文件只看当前打开的工作区（决策 104 第 2 条）。实际只会在弹窗被公告等排队压住、用户还看不到它时发生：弹窗可见时是模态，换不了工作区；
    - 「关闭就算看过」、只在关闭时写键（决策 116 第 14 条）不变。

### 问题 30：DSH 下没有授权活动行

12. **1.0.x 的事件形状**（`git show origin/main`）：自有 runtime 订阅闸门的 `onActivity`，每条 prompt / decision 记录经 `permissionActivityEvent`（现在的 `src/shared/permissions/activity.ts`）发成 `permission.activity`：`payload` 为 `phase`、`requestId`（工具调用 id）、`surface`（工具名）、`value`（`policyValue ?? command ?? path`）、有委派时 `delegationId` / `agentName`，decision 另带 `result` 与 `resolution`（「本会话允许」放行的是 `session_grant`）。
13. **1.0.x 的渲染位置**：store 把它追加为最近一条直播 assistant 消息里的 `permission_activity` 块；`toolCard.groupTimeline` 把「不安静」的块变成时间线上的 `permissionActivity` 项，由 `PermissionActivityRows` 画。但自 2026-09-18 用户裁决起，**所有 allow（包括 `session_grant`）都算安静，时间线上不画**，只有待批、拒绝、闸门出错三种会画。也就是说 1.0.x 里「本会话允许」放行的调用同样看不到「已允许 bash」这一行，块只在 store 里。清单 I2 与决策 129 第 16 条说的是这一行的写法（行模型 `derivePermissionActivityRow`），不是 1.0.x 在界面上画过它。
14. **bridge 只补「会话授权放行」这一种**：会话的闸门建好时订阅 `onActivity`，只在 `phase: 'decision'` 且 `source: 'session-grant'` 时，用同一个 `permissionActivityEvent` 发 `permission.activity`（带当前回合的 `requestId`，关闭会话后不再发）。
15. **其余记录不发**：卡片自己的应答（允许一次、本会话允许、拒绝）已经写在它那一行的行尾；策略放行在 1.0.x 里也不画；策略拒绝有工具行的失败结果；prompt 阶段有审批卡。按决策 090 默认跟随 DSH，不为与 1.0.x 一致把闸门的全部记录都搬上流。
16. **渲染层把 `session_grant` 从「安静」里拿出来（请审批）**：`isQuietPermissionActivity` 对它返回假，于是按现有的活动行画出：「已允许 bash `echo …` · 本会话已授权」，auto 色调（ShieldAlert 图标、次要色）；pwsh 按决策 129 第 16 条写「已允许 PowerShell」。其余 allow 仍然安静，2026-09-18 的裁决（不显示「授权详情」）不动。
    - 与编排者原话「渲染层照现有的活动行画」的出入：只发事件的话，现有渲染层会把它当安静记录丢掉，问题 30 的现象（「被授权放行的那一行看不出是授权放行的」）原样还在。撤回只需改回这一行判断，bridge 的事件可以保留（store 里有块，界面不画）。
17. **副作用**：这一行是时间线上的独立项，会把前后的工具组切开，也计入「N 个步骤」的折叠计数（与 1.0.x 的拒绝行相同）；子代理的调用会标「为子代理 X」；重开会话后不在（DSH 历史里没有审批记录，与问题 31 同因）。
18. **金样本**：`bridge-record --check` 28 个场景里两处差异，都是预期结果：`stream.perm-grants.json` 与 `stream.perm-restart.json` 在第二条 `echo` 的 `tool.updated` 之前各多一条 `permission.activity`（`surface: bash`、`resolution: session_grant`、`value` 为该命令），其后下标顺延。请编排者用 `-t perm-grants`、`-t perm-restart` 重录。

### 问题 6：图片边长上限

19. `MAX_IMAGE_EDGE_PX` 由 8000 改为 8192。来源：`@deepseek-ai/dsh-attachment-local` 0.1.7-rc.2 的 `DEFAULT_MAX_IMAGE_DIMENSION = 8192`（每边上限，`Math.max(w, h) > 上限` 时以 `IMAGE_DIMENSION_TOO_LARGE` 拒收）；我方宿主没有覆盖 `maxImageDimension`。判法与渲染层相同，等于上限的图照收。8000 原是模型 API 的上限；引擎在发给模型之前会把图归一化（默认总像素 2048×2048 以内），所以它不再约束。代码注释引用了这个常量。
20. **相关发现（未改）**：
    - DSH 另有总像素上限 `DEFAULT_MAX_IMAGE_PIXELS = 64e6`：8192×8192（约 67.1 MP）在渲染层预检能过，会被引擎以 `IMAGE_TOO_MANY_PIXELS` 拒收（草稿与附件退回、提示码）。渲染层没有总像素预检；
    - 两边一致之后，清单 A7 的 8193×1 仍到不了引擎（预检正好拦下）。要测引擎拒收路径，可用截断的 PNG（`INVALID_IMAGE`，第 1 批已这样测）或 8000×8200（`IMAGE_TOO_MANY_PIXELS`）；
    - 单张字节上限渲染层 5 MB，DSH 20 MB，渲染层更严，未动。

## 测试

- 新增 18 条：
  - `WorkerManager.test.ts` 3 条（WM-plugins-05 宿主立即再起且不开会话；06 只改模型计划仍不起；07 超预算时不起、不打成 failed）；
  - `DshHostSupervisor.test.ts` 1 条（SH-PL4 监听者拿到副本、只收好报告、抛错不影响宿主、退订后不再收到）；
  - `dshPluginsIpc.test.ts` 3 条（注册时订阅一次；推给所有未销毁的窗口、不写任何东西；读不出状态时不发不抛）；
  - `dshPluginsSettingsMount.test.ts` 3 条（挂载：PLS-15 切换后推送到达，徽章变已加载、提示消失、不重读；16 引擎第一次启动时补上状态；17 仍有分歧时提示保留、卸载时退订）；
  - `legacyAssetNoticeMount.test.ts` 3 条（挂载：LAN-08 晚到的工作区把项目级补进同一个弹窗，关闭时才记看过；09 新工作区没内容时保留；10 重查失败时保留）；
  - `permissionBridge.test.ts` 1 条（会话授权放行的调用发一条 1.0.x 形状的 `permission.activity`，卡片应答与策略放行不发，关闭后不再发）；
  - `permissionActivityRow.test.ts` 2 条、`permissionDisplay.test.ts` 1 条（挂载：`session_grant` 默认画出，其他 allow 仍不画）；
  - `attachmentLimits.test.ts` 1 条（8192 为上限，8001～8192 收，8193 拒）。
- 改写：`legacyAssetNoticeMount` 的 LAN-06（「弹过就不再查」→「关过就不再查」）；`attachmentLimits.test.ts` 两条（8000→8192，含中文句）；`imageDimensions.test.ts` 的分组标题；第 7 条的两个源码扫描测试；集成测试的 `select()`、PLG-1、PLG-4（第 8 条）。

## 影响与遗留

- **GUI 复核要看的**：
  - 插件页开着时切换开关：约数秒内宿主重启，徽章由「已关闭 · 待重启生效」变「已加载」，提示消失，不用退出重进；有对话在跑时，等它结束后才变；
  - 旧资产：隔离 HOME、带 `--open-path` 的第一次启动，弹窗里有项目级三类（`.pi/prompts`、`.pi/mcp.json`、`.pi/skills`）；
  - ask 档「本会话内允许」之后的第二条 `echo`：时间线上出现「已允许 bash echo … · 本会话已授权」一行，深浅两套主题；Windows 上为「已允许 PowerShell」；
  - 8001～8192 px 的图可以粘贴，8193 px 预检拒收，提示写 8192。
- **重开会话后活动行不在**：同问题 31，要持久化需要新的记录格式，不在本次范围。
- **没有改**：`roadmap.md`、`implementation-status.md`、`README.md`、`decision-review*.md`、`CLAUDE.md`、P1-7e 分组文件、金样本。

## 对既有决策的修订注记

- [决策 108](108-p1-10b-host-plugin-loading-choices.md) 第 7 条：插件选择变化引起的重启，关停之后立即再起（第 2 条）；`dshHostPlugins.ts` 的调用由三个变为四个（第 4 条）。
- [决策 117](117-p1-10c-plugin-settings-choices.md) 第 1 条「两条通道」：另有一条 Main → 渲染层的推送 `dshPlugins:changed`；第 13 条「不轮询：宿主状态在每次打开页面时重新读取」：改为订阅推送（第 5 条），仍不轮询。
- [决策 116](116-p1-16e-legacy-asset-notice-choices.md) 第 13 条「弹过一次后，本次启动不再查」：改为「关过之后」（第 11 条）。
- [决策 129](129-p1-6d-pwsh-analysis-choices.md) 第 16 条：DSH 会话里的活动行由本决策第 14、16 条补上，只限「本会话允许」放行的调用。

## 用户审批

待审批。
