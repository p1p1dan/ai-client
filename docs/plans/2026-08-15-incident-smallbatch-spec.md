# 意外发现小批施工规格（2026-08-15）

> 立项依据：总台账 2026-08-15「拍板批（排期 + D36）」行②（三条意外发现即修，先于主线）+ 第三轮行（#13 dark: 并入本小批）。
> 取证来源：四路并行静态取证 workflow `wf_96baf464-cdf`（四路均 confirmed；journal 在会话 transcript 目录）。
> 纪律：施工员对取证结论保留否决权——现场与取证不符时以现场为准并记偏差（惯例见记忆 investigation-needs-implementer-veto）。

## 范围（四件，文件不相交，可并行施工；禁并行跑测试）

### 1. `<button>` 嵌套违规（console error 级）

- **根因（confirmed）**：`BreadcrumbTreeMenu.tsx:295` `<MenuTrigger>{children}</MenuTrigger>` 无 `render` prop → base-ui 自渲染 `<button>` 外壳；`EditorArea.tsx:1383-1396` 传入的是原生 `<button>`（面包屑路径段钮）→ 嵌套。
- **修法**：`MenuTrigger` 改 `render={children as React.ReactElement<Record<string, unknown>>}` 自闭合（仓内先例 `sidebar.tsx:516-518` / `MainContent.tsx:411-420`）；`children` prop 类型从 `ReactNode` 收窄为 `ReactElement`。EditorArea 侧零改动。
- **验证**：CDP——多段路径面包屑点开菜单后 `document.querySelectorAll('button button').length === 0` 且 console 无 validateDOMNesting。
- **已核对无同类**：Menu/Popover/Dialog/Tooltip 触发器全量排查仅此一处；Select/Combobox/Tabs 族仅抽查（caveat 登记，不在本批）。

### 2. `chat:runtimeEvent` 监听器 11/10 超限

- **根因（confirmed）**：**静态超订而非无界泄漏**——preload `onRuntimeEvent`（`src/preload/index.ts:1439`）每调用挂一个裸 `ipcRenderer.on`；渲染端 8 个订阅点（7 常驻 + per-mount hooks：useHostStatus×5 挂载 / useMessageTimeline 双份 / useTurnTiming）正常态并发 11-13 个，打默认上限 10。全部订阅点均有清理路径，卸载对称。
- **修法**：新纯模块 `src/renderer/stores/runtimeEventBus.ts`——`createRuntimeEventBus(upstream)` 引用计数扇出（首订阅才挂 upstream、末退订才拆；退订幂等防负计数；dispatch 用快照迭代 + per-listener try/catch）；单例 lazy 读 `window.electronAPI`（保 node-env 可 import）；`resetRuntimeEventBus()` 供测试。8 个调用点从 `window.electronAPI.chat.onRuntimeEvent(cb)` 换 `subscribeRuntimeEvent(cb)`。
- **测试**：`runtimeEventBus.test.ts`（node env，仅 import 纯模块）：N 订阅→upstream 恰一次；事件广播全达；末退订才拆；退订幂等；listener 抛错不阻断邻居。
- **红线提示**：本链路是核心事件路径，改动后四门必须全绿；ChatComposer 的订阅在 try 块外、finally 清理（`ChatComposer.tsx:1123`）——换线时保持原清理时序。

### 3. React「synchronously unmount while rendering」告警

- **根因（confirmed，react-dom 19.2.3 源码级）**：passive-effect flush 全程持 CommitContext（`react-dom-client.development.js:18425`），effect body/cleanup 里同步 `root.unmount()` 必触发告警（`:27906`）。仓内 14 处命令式 root unmount，6 处在禁区：`EditorArea.tsx:982/1101/1105`、`DiffViewer.tsx:612/628`、`EditorLineComment.tsx:172/176`、`DiffReviewModal.tsx:944-956`（该文件 `:437/:644` 已有 queueMicrotask 修复先例与中文注释诊断）。
- **修法**：新纯函数 `src/renderer/lib/deferRootUnmount.ts`（roots 数组 + 可注入 schedule，默认 queueMicrotask；null 容忍；try/catch 包 unmount），六处禁区调用点换用；Monaco widget 移除保持同步，仅 React unmount 延迟。延迟安全性：各容器节点均为 per-effect-run 局部或随 owner 拆除，无 createRoot 竞态。
- **测试**：`deferRootUnmount.test.ts`（node env 纯模块）：同步零调用；schedule 回调后各 root 恰一次；null/全 null 容忍。
- **归因 caveat**：现场那一条告警具体出自六处中哪处未实证（不影响修法——六处同类同修）。

### 4. #13 `dark:` 变体脱钩（D43 前拍板并入）

- **根因（confirmed）**：全仓零 `@custom-variant`；`dark:` 走 prefers-color-scheme 而主题切换靠 `.dark` class（`settings/index.ts:64-84`），仅 theme='system' 时二者巧合一致。
- **修法**：`globals.css` 第 2 行（`@import "tailwindcss";` 与 `@theme {` 之间）插入 `@custom-variant dark (&:where(.dark, .dark *));`。单 CSS 入口已确认，无连带。
- **测试**：仿 `fontDomain.test.ts` 先例——读 globals.css 文本断言该行存在且位于 `@theme {` 之前。
- **复验（CDP，亮/暗均显式选择、勿用 system）**：Settings 外观/Agent/Hapi 各状态 pill、Onboarding runtime 横幅、TreeSidebar NEW 徽章与 diff ± 计数、破坏性菜单项红字。全仓 66 处 `dark:` 清单见取证 journal。

## 门禁与收口

1. 施工（四件并行，**施工期禁跑任何测试/构建**）→ 2. 逐门串行：scoped 新测试 → lint → typecheck → vitest 全量（本机内存纪律，禁链式合跑）→ 3. 新测试变异验证（承重行各翻一处，恢复用字节替换禁 checkout）→ 4. CDP 复验（button 嵌套消失 + dark: 屏清单 + 监听器告警不再出现）→ 5. 台账 + plantree 收口。

## 不在本批

- git 面板外部提交不自动刷新（backlog 票，候选窗口聚焦 invalidate）。
- Select/Combobox/Tabs 触发器族嵌套全量审计（取证 caveat，如现场再报再立）。
- `DiffReviewModal.tsx:944-956` 之外的非禁区 unmount 站点维持现状。


## As-built 备注（2026-08-15 施工后）

- 全部落地于 `5dab201`；四门全绿 vitest 166 文件 3357 例 0 红；变异验证 7/7 咬合。
- **偏差三处（实现方否决权行使，均现场证据推翻取证）**：① DiffViewer `[]`-cleanup 内未延迟 unmount 实为 **4 处**（addButton / comment / selectionWidget / selectionComment），非取证的 2 处，全部延迟；连带两处 DOM `.remove()` 先于延迟 unmount 执行——合法（detached 容器上 unmount 合法且组件卸载中无 root 复建）。② 取证所称「useMessageTimeline 双份」实为 `useMessageMetadata.ts:36` 单订阅；8 订阅点实名 = chatSessions.initRuntime / sessionRuntimeFacts / subagentActivity / useHostStatus / useMessageMetadata / useTurnTiming / ChatComposer×2。③ 既有 sessionRuntimeFacts「regression (Opus m9)」用例断言的正是被总线消除的重复订阅（断言 spy 调用两次），同场景改锚新观测面（首退订不拆上游）。
- **变异验证发现测试缺口一处**：disposed 守卫对「独立 listener 三连退订」inert（Set 删除幂等 + detach 置空已兜住该场景）；真承重场景 =「同 listener 重订阅后旧句柄二次调用」（旧句柄误删活订阅并拆上游），补用例后咬合。
- **CDP 复验四查全过**：面包屑段钮即 trigger 本体（render 融合生效）、点开菜单正常、全 DOM `button button`=0；模拟亮 OS 下 `.dark` 切换使 `dark:text-red-400` 计算色翻转（oklch 0.577→0.704）；console 全程无 validateDOMNesting / MaxListeners / sync-unmount（仅启动期既有良性日志）；整窗截图目检无布局异常。
- **Residual**：① 原始同步卸载告警的具体来源站点未逐一现场复现（机制级同类同修，六站点全改）；② dark: 66 处逐屏视觉细查并入下轮真机 D34/D35 复验单；③ Select/Combobox/Tabs 触发器族未全量审计（如现场再报再立）。