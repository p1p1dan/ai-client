# Implementation Status — Pi Backend Migration

**Last Verified**：2026-08-29（T12 后）· 完整 vitest **269 files / 5395 tests** 全绿（T08-c 切片 2 后为 269/5397，净 −2 是 FB3 三例退役换 T12 两例，见 T12 证据档 §3）；typecheck（主仓）全绿；Biome `src` + `scripts` **0 error / 0 warning**；`build:agent-host` 成功（394.3MB）；打包产物权限闸 smoke 通过（`smoke:permission-plugin` → `PERMISSION GATE INTACT`）。完整 Electron build 因当前 VM 仅 3.3 GiB、脚本固定 4 GiB heap 出现内存压力，沿用既有处置不重跑。`pnpm lint`（全仓）另有 1 个**既存**错误，来自未跟踪文件 `docs/plans/2026-08-27-entry-design/logo-concepts-preview.html`，与本仓代码无关。

## Current Phase

**Phase 1 与 Phase 5 已完成；Phase 2 未整体完成；Phase 3 已起手（T12 代码完成，等用户看图）。**

区分「代码施工完成」和「真实 E2E 验收完成」——这两件事在 Phase 2 上不一致：

- **代码施工完成**：T07 / T11 / T08 / T08-a / T08-b，加 2026-08-29 的审计修复批
  （13 项全修）。证据见
  [phase2-extension-ui-permission.md](./evidence/phase2-extension-ui-permission.md)
  与 [phase2-audit-fixes.md](./evidence/phase2-audit-fixes.md)。
- **未完成**：T08-b **真机审批 E2E 一次都没跑通**（因此从 Done 降级）；
  T08-c 两个切片**代码完成但验收未过**（面板未点验、策略未在真机上验证生效）；
  **T09 / T10 为 Deferred**。所以不能写「Phase 2 已完成」。
- **Q9 已关闭（[D11](./decisions/011-default-permission-policy.md)）**，T08-c 切片 1
  已落地：随包**务实档**默认策略（读放行 / 改询问 / bash 只读白名单 / mcp 仅发现类 /
  external_directory 一律 ask），path deny 面含 `.env` 系列、私钥与自家凭据库；
  项目级 `.pi/` 配置**受管模式不生效、本机模式生效**。证据见
  [t08c-default-permission-policy.md](./evidence/t08c-default-permission-policy.md)。
- 权限姿态的准确说法（已随 D11 改变）：**随包带一份最低优先级的默认策略**，用户
  自己 agentDir 里的配置整条压过它；未被任何规则命中的请求仍落 `ask`
  （`rule.ts:112` `defaultAction ?? "ask"`）。另有一条插件硬编码的自动放行：
  **只读工具读 Pi 基础设施目录一律 allow**。
- Phase 3 已起手：**T12 Done**（用户 2026-08-29 指示「Phase 2 点验推迟，先做 T12」，
  同日看图确认「整体效果满意」并拍板删掉 meta 行）。Phase 2 的真机 E2E 验收**没有取消，
  只是排在后面**。下一件是 T12-a（display-items / turn-groups 数据建模）。

## Last Landed

**2026-08-29 T12-b —— meta 行退役，换成悬停操作条**（同日，T12-a 之后）。
用户看图后拍板「跟随 pi-app 删掉 meta」，复制按钮的放置给了三选一，用户选
**「完全照抄 pi-app」**。于是 `Worked for 12s · 2 tools`、模型名、相对时间**全部丢掉**，
复制与 `HH:MM` 进一条**悬停才出现**的操作条。

**先核过 pi-app 到底丢了什么**（逐项读源码，非推测）：复制和时间戳它**留着**，只是挪进
悬停条；思考时长挪到思考块写成 `Thought for Xs`；模型名挪到输入框常驻；**回合总时长和
工具数是真的不显示** —— 实证是它 `timeline-turn-timing.ts` 里算这个数的两个函数还在，
但全仓零调用方，是删 footer 之后留下的死代码。

**`F-B15` 红线经用户知情后明确反转**：原规则是「复制按钮永远不能悬停才出现，因为键盘和
触屏够不到」。代价已如实告知并被接受，所以红线**反转而不是悄悄放宽**，代价写进
`turnActionsSlotClass()` 头注。保留下来的那半条写成断言：**遮蔽只能在容器上，绝不能在
按钮自己身上** —— 按钮若也带 `opacity-0`，就成了「两件事都得同意才点得动」。

**进行中的状态行保留**。它跟 meta 行只是**碰巧共用一个槽**：`Awaiting first token 8s` /
`Stalled` / `Failed` 是唯一说明「还在跑」的东西，F2 的「秒表丢了」缺陷就是这行在还没跑完时
消失。现在跑完什么都不显示，跑的时候照旧。连带退役 `deriveTurnHeadModel` 的四个降级档 ——
它们回答的都是「没量到时长的已完成回合该说点什么」，而现在的答案是「什么都不说」。

⚠️ **GUI 抓到一个断言抓不到的缺陷**：折叠态操作条实测 **28px 而不是 0**，
也就是「收起来了但照样占位置」，正好把删 meta 行省下的竖向预算又花回去。
根因是 `h-7` 从 pi-app 原样抄来，而 grid item 一旦有确定高度就压不扁。
**三个类一个不缺、每条单看都对、断言全绿** —— 失效在类与类的相互作用里。
已修（行高改由 24px 按钮决定）并补了「此行不许有任何高度类」的钉子，把 `h-7` 加回去立刻咬红。

四门：typecheck 0 · biome 1045 文件 0/0 · **vitest 269 文件 5381 例** · 变异 8/8 咬红。
真机 CDP 实测：折叠两条均 `height:0`；真悬停第二个回合后**只有第二条**打开（24px），
证明 `group/turn` 的按回合作用域成立。

**2026-08-29 T12-a —— 时间线外壳与气泡视觉基线**（Phase 3 起手）。
提问气泡取 pi-app 形状（右对齐 · 80% 上限 · 切角从右下换到**右上** ·
`12px 4px 12px 12px` · **不再六行截断**），模型回复**去掉每段一个的边框盒**，
钉住提问的 `sticky` 吸顶条整条退役。

**这三件本来就是一条因果链，只有第一环是当初真想要的**：吸顶条会跟贴底滚动打架
（收起→变矮→`scrollTop` 被夹回→又展开，逐帧震荡），所以 F10 加了无条件截断；
截断藏掉了正文，所以 FB3 加了恒显的 `Show more`。去掉吸顶条，后两件失去存在理由。
反向纪律已写成断言：任何回合级 class 函数长出 `sticky`/`fixed`/`z-*` 即红 ——
单独把吸顶条加回来会原样复现 F10 的震荡。

角色区分改由**不对称**承担：用户侧是个物件（有形状、有面、有切角），模型侧根本不是物件
（占满阅读宽度、无面、无边）。给模型侧「为了一致」加个环，会从另一头到达 D3-b 反对的
「什么都是卡片」。

改动文件：`chatTimelineLayout.ts`（退役两个 class 函数 + 新增两个 + 节奏算术重组）·
`MessageTimeline.tsx`（`UserBubble` 去 state/去按钮/去 title；吸顶条 wrapper 删除；
answer 分支去容器）· 三份测试逐条**改写立论**（不是放宽）。
证据与四张截图见 [t12-timeline-shell-baseline.md](./evidence/t12-timeline-shell-baseline.md)。

⚠️ 截图里的时间线内容是**注入的合成 transcript**（走真渲染路径，但流式态没被覆盖）。
当时留给用户裁定的「meta 行保留还是删掉」已由同日 T12-b 结案：删掉。

**2026-08-29 T08-c 切片 2 —— 权限策略设置面**（同日，切片 1 之后）。
应用内第一次能读到权限闸的判断依据：按插件语义镜像三层合并（随包默认 < 受管/用户
agentDir < 项目 `.pi/`）并显示每条规则由哪一层决定，**只让受管 agentDir 那一层可编辑**
——本机路线下那一层就是用户自己的 `~/.pi`，写它等于改一个我们不拥有的工具（T08-a 红线），
所以直接抛错拒写而不是静默不做。危险选择（write/edit/bash 兜底/external_directory
兜底/mcp/skill/顶层 `*` 选“直接允许”）走二次确认；`yoloMode` 只显示不提供开关。

同批修掉两个静默缺陷：① **dev 下随包默认策略根本不生效**——插件目录按运行中 Host
入口解析，dev 是 `src/agent-host/`，而构建只写产物；回落到插件裸默认是安全的（什么都问），
所以症状只是弹窗变多，而「`cat .env` 被直接拒」这一半是静默缺失的，会让真机验收
在 dev 上得出错误结论。修法保留原意图（构建仍不碰 checkout），由 `node scripts/dev.js` 自己
显式写入。② 设置分类的联合类型与 localStorage 校验数组是**两份手写清单**，漏改一份
的症状是「新面板能打开、重启后再也打不开」；改为单一来源 + 静态扫描。

新增 `shared/piPermissionPolicy.ts`、`services/piPermissionPolicy/{index,policyStore}.ts`、
`ipc/piPermissions.ts`、`settings/{permissionPolicyView.ts,PermissionPolicySettings.tsx}`；
改动 `shared/types/ipc.ts`、`preload/index.ts`、`ipc/index.ts`、`settings/constants.ts`、
`SettingsContent.tsx`、`App/hooks/useSettingsState.ts`、`agent-host-build-lib.mjs`、
`scripts/dev.js`。证据见
[t08c-permission-settings-panel.md](./evidence/t08c-permission-settings-panel.md)。

**2026-08-29 T08-c 切片 1 —— 默认权限策略与信任边界**（同日，审计修复批之后）。
Q9 四问拍板收口为 [D11](./decisions/011-default-permission-policy.md)：务实档基线 ·
path deny 面 · external_directory 一律 ask · 项目配置按凭据模式分叉。策略随包写进
**产物内插件目录的 `config.json`**（插件的最低优先级层，用户配置永远压得过它，
且绝不写用户的 `~/.pi`）。新增 `permissionPolicy.mjs` / `permissionPolicy.d.mts` /
`piHostEnv.test.ts`，改动 `piRuntime.ts`（`projectTrusted()`）、
`shared/piModelConfig.ts`（`PI_PROJECT_TRUST_ENV`）、
`services/piModelConfig/index.ts`、`agent-host-build-lib.mjs`、
`build-agent-host.mjs`、`t08a-permission-plugin-smoke.ts`、
`shared/__tests__/defaultPaths.test.ts`（护栏白名单 + 强制点转移）。

**2026-08-29 Phase 2 审计修复批**（外部审计 13 项，逐条成立、逐条修复）。
最重的四条：权限插件不可用时改为 **fail-closed**（不建 session + `fatal: true`
的 `host.error`）；pi runtime 由**进程级单例改为每 session 一套**
（handle / 订阅 / abort / 投影 / Extension UI bridge）；**Stop 立即排空** pending
弹窗（abort 到不了卡在 `ui.select` 里的扩展）；Runtime Event 改走**强类型
`RuntimeEventDraft`**，`isError`/`errorMessage` 两处漂移修正并当场再抓出一处多余
字段。逐项根因与证据见
[evidence/phase2-audit-fixes.md](./evidence/phase2-audit-fixes.md)。

新增/改写实现文件：`permissionPlugin.ts`（重写）、`piHostCommands.ts`（新）、
`permissionActivityRow.ts` + `PermissionActivityRows.tsx`（新）、
`extensionUiRouting.ts`（新）、`piRuntime.ts` / `piHost.ts` /
`extensionUiBridge.ts` / `extensionUi.ts` / `ExtensionUiDialog.tsx` /
`chatSessions.ts` / `toolCard.ts` / `MessageTimeline.tsx` /
`agent-host-build-lib.mjs` / `t08a-permission-plugin-smoke.ts` /
`.github/workflows/build.yml`。

**2026-08-28 Phase 2 落地**，五个提交（T07 → T11 → T08 → T08-a → T08-b）；主要实现文件：

- `src/shared/types/runtimeEvents.ts` + `src/shared/types/agentHost.ts`（契约）
- `src/agent-host/extensionUiBridge.ts`（移植自 pix）
- `src/agent-host/permissionPlugin.ts` + `src/agent-host/permissionActivity.ts`
- `src/agent-host/piRuntime.ts` + `src/agent-host/piHost.ts`（绑定与命令分发）
- `src/renderer/components/chat/ExtensionUiDialog.tsx` + `extensionUiModel.ts`
- `src/renderer/stores/extensionUi.ts`
- `scripts/agent-host-build-lib.mjs`（打包过滤特判）

## Active TODO

1. **真机端到端验收（T08-b 的 Done 前置）**：模型发起工具调用 → 插件拦截 →
   GUI 弹窗 → 允许 / 拒绝 / 关窗三种走法 → 工具执行或不执行。链路各段均有测试与
   实跑证据，但整条链首次贯通需要真实模型调用。
2. **GUI 点验**：权限活动行四种 tone × 亮暗双主题；弹窗的 select 按钮组、
   `Request N/M`、发送失败提示；**权限策略设置面**（危险二次确认、「位置未变」徽章、
   规则增删、只读横幅）。一样都没在屏幕上看过。
3. **多窗口真机验证**：路由有 13 例单测，两个真实 BrowserWindow 的行为未实测。
4. **策略真机验证**（并入上面的 E2E 批）：`cat .env` 应被直接拒而非弹窗；
   `git status` 不弹窗而 `git commit` 弹窗；受管模式下仓库自带 `.pi/` 配置无效。
   **验收若在 `node scripts/dev.js` 下跑，先确认启动日志里有 `[dev] permission policy: …`**
   ——这条是切片 2 才补上的 dev/打包一致性，没有它随包策略不生效，第一条会误判。
5. Phase 3 续做：**T12-a** display-items / turn-groups 数据建模（T12 本身已 Done）。
   顺带在真实回合上补两件 T12 没能覆盖的：流式态观感、悬停条的 `HH:MM`
   （合成 transcript 不走 runtime event bus，拿不到 `completedAt`）。

## Blocked By

- 无阻塞项。Q9 已关闭，T08-c 两个切片均已施工。
- T08-b 与 T08-c 的**验收**都在等同一件事：真机 E2E。不是代码阻塞。

## Handoff

- **权限弹窗怎么来的**：pi 扩展调 `ui.select` → `extensionUiBridge` 转成 `extensionUi.request` 事件 → MessagePort → main → renderer 的 `useExtensionUiStore` → `ExtensionUiDialog`。用户选择经 `chat:respondExtensionUi` 原路回去。
- **关掉弹窗＝拒绝**：dismiss 只发 `ok:false` 不带 value，由 Host 侧 bridge 补开窗时记下的 fallback（confirm 是 `false`，其余是 `undefined`）。渲染端从不自己挑这个值。
- **权限插件在哪**：`src/agent-host/node_modules/@gotgenes/pi-permission-system`（pin 27.0.1），随 `build:agent-host` 进 `out-agent-host/node_modules/`。用户 `~/.pi/agent/settings.json` 里已自装同名包时不注入。
- **验证产物里的权限闸是否真的能用**：`pnpm smoke:permission-plugin`，期望
  `RESULT: PERMISSION GATE INTACT`。它查三件事：pi 载入扩展、扩展**注册了
  `tool_call` handler**（拦截点本身）、**用产物里的 WASM 真解析一条复合 bash
  命令**并要求两条命令都被枚举。顺带查随包许可证。CI 的 win/linux 两个 job 里
  也各有一步。
- **权限闸不成立时 Host 会拒绝开会话**：`PermissionGateUnavailableError` →
  `host.error{fatal:true}` + `session.failed`，不会「先跑起来再说」。
  想在测试里造这个状态用 `PiAgentRuntimeOptions.decidePermissionGate` 注入。
- **改打包过滤要注意**：walker 会先问包目录本身（`parts.length === 1`），只答文件路径会导致整个包被跳过——本轮 tree-sitter-bash 就这么漏过一次，单元断言全绿、真实构建才暴露。
- **默认权限策略在哪**：`src/agent-host/permissionPolicy.mjs`（单一来源，
  构建期写进 `out-agent-host/node_modules/@gotgenes/pi-permission-system/config.json`）。
  它是插件读的**最低优先级**层——用户自己 agentDir 里的配置整条压过它，我们从不写
  用户的 `~/.pi`。改策略只改这个文件；产物断言与 smoke 会挡住「一词之差变宽松」。
- **想知道现在的权限策略到底是什么**：设置 → 权限（`piPermissions` 分类）。
  它按插件语义合并三层并标出每条规则的来源。**只有受管 agentDir 那一层可写**；
  本机路线整个面板只读，`update`/`reset` 会抛错（写它等于改用户自己的 `pi` CLI）。
- **改这个面板要小心的一条**：合并语义是**镜像**插件的
  （`shared/piPermissionPolicy.ts`），不是调用它——插件的 `.ts` 在 `node_modules` 里，
  Node 拒绝类型剥离。两条必须一起动：最后匹配优先，以及 `{...base,...override}`
  会让**重述的规则保留原位置**。改了镜像而没改断言，面板会开始对「agent 能做什么」
  给出自信但错误的答案。
- **dev 下策略是否生效**：启动日志找 `[dev] permission policy: …`。
  没有这行 = 随包默认没写进 `src/agent-host/node_modules/...`，插件走它自己的裸默认
  （安全但更吵），此时验「`.env` 被直接拒」会得到错误结论。
- **项目级 `.pi/` 配置生不生效**：看 `AICLIENT_PI_TRUST_PROJECT_CONFIG`。
  受管/登录模式发 `'0'`（不生效），本机模式发 `'1'`（生效）。键缺失 = 老 Main 构建，
  按历史姿态 `true`；值不认识 = 落安全侧 `false`。注意这是 pi 自己的
  `projectTrusted`，`'0'` 连带让仓库的 `.pi/settings.json`（packages / 模型）也失效。
- 本地管理端：`pnpm model-admin`，默认 `127.0.0.1:3210`（Phase 5）。
- 管理模式目录：`~/.pilab/<profile>/pi-agent`；本机模式继续读用户自己的 Pi 目录。
