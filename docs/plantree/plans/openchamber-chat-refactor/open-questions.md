# Open Questions

> 只放未决问题；决了就移去台账（决策/检查点）并从这里删除。

1. **C-15 产物体积**：portable 120MB→141MB（随包 node.exe +21MB）可否接受？——等用户拍板；不可接受的回退方案=随包改可选、五源寻径为主。
2. **T-19 消息队列**：提案内容（turn 运行中排队后续消息，CC 有 `queue-operation` 机制可依托？）尚未落库——等用户提供原文后评估排期。
3. **CI 测试作业缺失**：`build.yml` 仅打包无 `pnpm test/typecheck/lint`（C-09 期间发现）。tag 触发的发布构建要不要加测试门禁？——成本（双平台时长）vs 收益待拍板。
4. **T-09 Node 缺失场景无法真触发**：resolver 容错太好，坏路径仍 fallback 成功。构造「全候选失败」的可行法？（候选想法：mock-resolver 注入容器，见 ideas）
5. **网关「400 thinking 格式无效」——2026-07-28 升级：默认模型路径上已从瞬态变确定性**。07-26 的 budgetTokens 假说已被 07-27 实测推翻（场景 A 原样发旧形态仍 200）。**07-28 探针**：`{type:'adaptive', display:'summarized'}` 打网关默认模型（opus-4-8[1m]，即 #8 当日实测 408 字符成功的同一配置）**2/2 确定性 400**——网关对 thinking 的处理跨模型不一致且随时间漂移。处理口径不变（按 session.failed 显示、不回滚 thinking 默认开），**定位与修复在网关侧**（newapi 渠道配置），app 侧无可修。
8. **sonnet 空文本 thinking 块要不要渲染指示**（2026-07-28）：GUI 默认 `sonnet`（claude-sonnet-5）在本网关返回**带签名但文本为空**的 thinking 块（不理会 `display:'summarized'`），Host 按设计吞空 thinking → 无卡。CLI 历史 JSONL 可证上游确实思考了。要不要给这种块渲染一个无文本的「已思考」指示？——产品决策，等用户拍板；根治仍在网关侧。**T-04 在网关修复前无法点验**（连同 #5）。
6. **归档会话无 un-archive 入口**：T-02 右键即归档、无确认，`mergeSessionIndex` 把 archived 连 live 镜像一起丢弃 → 彻底不可见，只能手改索引文件恢复。用户首轮联调即误触两条。要不要补 UI 入口（或至少加确认）？——等用户拍板。
7. **TSD 白名单口径**（按进程名，任意路径 node.exe 均可读）待 T-11⑥ 现场实证——实证前所有加密机相关能力不得标注通过。
10. **全等宽字体的中英混排风险**（2026-07-28，D18 连带）：sans / mono / heading 三者统一 `ui-monospace` 后**中文会回退系统字体**——等宽拉丁字形与非等宽 CJK 字形混排，行内宽度节奏、基线与标点对齐都可能崩。需在三处实测后决定是否给 CJK 单独指定字体或给中文段落开例外：① Chat 阅读栏正文（48rem 宽下的中文段落）；② 左栏 Session 树（中文标题 + 短码占位符 truncate）；③ 工具行摘要（中文工具人类名 + 拉丁路径同行 truncate）。**归 T-21 验收项④**，实测截图入台账后回填本条；崩得不能看的回退方案 = 保留全等宽给 UI chrome、正文 CJK 走系统 sans。
    - **补记（2026-07-28，T-21 施工中；2026-07-28 审查回合修正为 6 处）**：混排风险不止字形宽度，还有 **`lowercase` 与中英混排的叠加**。按钮原语基类补 `lowercase` 后，中文是 no-op，但**中英混排的硬编码文案、以及按钮里渲染的动态标识符会被连带小写化**。需 `normal-case` 豁免的共 **6 处**，T-21 已就地加上：
      ① `src/renderer/components/onboarding/ClaudeVsCodeOnlyShell.tsx:74` 的「一键安装 CLI」按钮；
      ② 同文件 `:87` 的「VSCode 使用文档」按钮；
      ③ `src/renderer/components/onboarding/OnboardingView.tsx:739` 的「继续安装 CLI 环境」按钮；
      ④ 同文件 `:746` 的「返回 VSCode 使用」按钮（与③同在 `mode === 'vscode-extension'` 分支，**初版漏了**）；
      ⑤ `src/renderer/components/worktree/MergeEditor.tsx:751` 冲突文件 Tab 条 —— 渲染 `conflict.file.split('/').pop()`，`README.md` 会显示成 `readme.md`；
      ⑥ `src/renderer/components/git/AddRepositoryDialog.tsx:1087` SSH 根目录快捷 chip —— 渲染远端路径 `{root}`，Linux/macOS 路径大小写敏感，`/home/Dan/Projects` 会显示成 `/home/dan/projects`（另加了 `font-mono`）。
    - **✅ 2026-07-30 结项（升级为 D25）**：风险坐实且超出原范围——观感审计（`docs/design/polish-audit-20260730.md`）证实全等宽使层级三件套塌维（等宽回退链字重档缺失 / letter-spacing 全仓仅 1 用 / 侧栏字符量 -23%），用户拍板改**分域字体**（UI 比例 + 等宽专供代码/路径/分支），落地归 **T-30**。本条关闭。
      另 4 处纯英文 i18n 文案（AI Polish / Polish with AI / Generate with AI / URL Mode）小写化可接受，不豁免。
      **初版「已确认无任何 Button 渲染动态标识符」的结论是错的**（⑤⑥即反例）。重新用「按 `{}` 深度切开 Button 开标签、只看 children 表达式」的方式穷尽扫描全仓 `.tsx`，除⑤⑥外再无动态标识符（`ClaudeRuntimeBanner.tsx:93` 的 `v{LAST_NODE_CLAUDE_VERSION}` = `2.1.112` 纯数字，`DiffReviewModal.tsx:1241` 的 `(${allComments.length})` 同理，均为 no-op）。复用 `buttonVariants` 的只有 `ui/toast.tsx` 5 处 + `ui/pagination.tsx` 1 处，Select / Menu / Combobox 的 Trigger 不走它。
      **本条的 GUI 首测须同时目视这 6 处**（确认豁免生效、大小写正确），与①②③三个混排场景一并出截图。
      **新增中英混排按钮文案时，务必同时加 `normal-case`**——这条已写进 `docs/design-system.md` 的 Squircle 节。
11. ~~**根字号 14→16 的影响面**~~ —— **已结项（2026-07-28，随 T-21 关闭）**。
    - **原前提是错的，须一并更正**：本条与 `docs/design-system.md` 旧警示里「ai-client 现为 `html { font-size: 14px }`、全仓 rem 实际值 ×14/16、`--radius: 0.5rem` 真实 7px」的说法**不成立**。
    - **实测事实**：`src/renderer/styles/globals.css` 的 `:root` 确实**声明** `--font-size-base: 14px`，但 `src/renderer/stores/settings/index.ts:57` 的 `applyTerminalFont()` 把 `terminalFontSize`（`getInitialState` 默认 **16**）以 **inline style** 写到 `document.documentElement` 的 `--font-size-base`，inline 优先级永远赢 `:root` 声明 → **运行时稳态一直是 16px**。因此**全仓 rem 早已按 16px 解析**，`--radius: 0.5rem` **真实即 8px**（`--radius-xs` 4px / `--radius-md` 12px / `--radius-lg` 16px 同理），与 OpenChamber（无 `html` font-size 覆盖、依赖浏览器默认 16px）**天然对齐**，不存在 12.5% 的系统性偏小。
    - **结论：不改数值，改治理。** 本条从「要不要改根字号」降级为「把声明改成 16px + 切断终端注入」，三行改动、对默认配置视觉零位移：① `globals.css` 的 `--font-size-base` 声明 14px → 16px（消灭首帧跳变：`electronStorage.getItem` 是 async，rehydrate 前按 `:root` 的 14px 渲染，hydrate 后被 inline 16px 顶掉，全局 rem 元素跳一次 14.3%）；② 删掉 `settings/index.ts` 对 `--font-size-base` 的 inline 注入；③ 删掉同处对 `--font-family-mono` 的注入（即整个 `applyTerminalFont`——xterm 字体走 JS option、Monaco 走 `editorSettings`，两者都不读 CSS 变量，这两条写入没有任何合法消费者）。顺带修掉「调终端字号 = 等比缩放整个 UI」这个现存 bug（16→24 时界面放大 50%）。
    - **零位移的边界（须进 release note）**：只对 `terminalFontSize` 保持默认 16 的用户成立。改过终端字号的存量用户，UI 目前被按 `terminalFontSize/16` 缩放，改完会回到 100%——**是修 bug 不是回归**，但对他们是可见变化。
    - 已同步 `docs/design-system.md`（新增「根字号结论」节 + Border Radius 表补「真实值」列 + 顶部警示中该条撤销）。**待入总台账后从本文件删除。**
12. **终端 Ghostty 主题与 Monaco 跟随是否随 D18 一并 Flexoki 化**（2026-07-28，D6 撤销的连带边界）：D6 把「@coss/ui + OKLCH token + Ghostty 终端主题 + Monaco 跟随 Ghostty」四项打包成一条，D18 只裁定了应用壳的**主题与字体**，**未涉及**后两项。三种口径待选：① 全保留（应用壳 Flexoki、终端与编辑器仍走 Ghostty 派生，接受两套配色并存）；② Monaco 改跟 Flexoki、终端仍 438 主题；③ 全部 Flexoki 化（438 主题降级为可选）。**裁定前 `resources/ghostty-themes/`、`scripts/generate-themes.ts`、`lib/ghosttyTheme.ts`、`monacoTheme.ts` 原样不动**（T-21 已明写为边界外）。注：D6 撤销的理由是「现有语义 token 没有强调色」，该理由不覆盖终端配色，故不构成自动推翻。
    - **补记（2026-07-28，T-21 施工中发现，冲突面比原描述大得多）**：本条**不只是终端配色，是整个应用壳**。`src/renderer/lib/ghosttyTheme.ts:238-312` 的 `applyTerminalThemeToApp()` 在主题选 **`sync-terminal`** 时，会把**全部 25 个语义变量**以 hex 写到 `document.documentElement`：`--background` / `--foreground` / `--card(-foreground)` / `--popover(-foreground)` / `--primary(-foreground)` / `--secondary(-foreground)` / `--muted(-foreground)` / `--accent(-foreground)` / `--destructive(-foreground)` / `--success(-foreground)` / `--warning(-foreground)` / `--info(-foreground)` / `--border` / `--input` / `--ring`。inline 永远赢 `:root` / `.dark` 声明 → **该模式下 Flexoki 调色板被 100% 覆盖**，`docs/design-system.md` 的 Color System 整节不生效。
    - **改造后该模式反而更糟**：`applyTerminalThemeToApp` **不覆盖** T-21 新增的 5 个 token（`--accent-primary` / `--selection` / `--hover` / `--status-running` / `--folder`），所以 `sync-terminal` 下会出现「**25 个终端派生色 + 5 个 Flexoki 色**」的混色；改造前是 25 个全覆盖、观感自洽。**新增的硬编码色清理（`bg-status-running` 等）恰好落在这 5 个之内**，冲突可见度更高。
    - **口径**：T-21 **未裁定**本条，`ghosttyTheme.ts` / `monacoTheme.ts` 原样不动。**T-21 的全部验收必须在默认（非 `sync-terminal`）主题下进行**；首测若在 `sync-terminal` 下看到混色，**属本条未决事项，不是 T-21 引入的 bug**。
    - ~~另需注意：`--panel-bg-opacity` 也写在 `documentElement`，`sync-terminal` + 背景图会同时丢掉面板半透明~~ —— **已修，不属本条**（2026-07-28 审查回合）。这不是「待裁定的边界」而是 **T-21 引入的行为回归**：旧实现把带 alpha 的完整色写在 `<body>`（html 的后代），能压过 `applyTerminalThemeToApp` 写在 `documentElement` 的不透明 hex，所以 `sync-terminal` + 背景图**原本是能看见壁纸的**；改成单开关后开关与 hex 落在同一元素，hex 胜出 → 面板全不透明、壁纸完全不可见。修法是给 `ghosttyTheme.ts` 的 4 个面板表面套 `withPanelBgOpacity()`（`color-mix(in srgb, <色> calc(var(--panel-bg-opacity, 1) * 100%), transparent)`，默认值 1 时为恒等变换，有 3 例单测）。**该修改不改变 sync-terminal 下「谁覆盖谁」，本条主体（25 个语义变量被覆盖 / 5 个新 token 未被覆盖的混色）仍未裁定。**
13. **`dark:` 变体与 `.dark` 调色板整体脱钩**（2026-07-28 T-21 审查回合发现，**既存 bug、非 T-21 引入**，影响面全仓）：本仓只有一个 CSS 入口 `src/renderer/styles/globals.css`（`index.tsx:7` 引入），其中**从未声明** `@custom-variant dark (&:where(.dark, .dark *))`。Tailwind **v4.1.18** 的 `dark` 变体默认实现是 `@media (prefers-color-scheme: dark)`（实测编译产物：`.dark\:bg-primary\/10 { @media (prefers-color-scheme: dark) { … } }`），而应用的明暗切换靠 `document.documentElement.classList.toggle('dark', …)`（`stores/settings/index.ts` 的 `applyAppTheme`）。**两者互不相干**：
    - 用户选 Light、系统是 Dark → 调色板走 `:root`（亮），但所有 `dark:*` 工具类**生效**；反之亦然。
    - `theme: 'system'` 时二者恰好同步，所以问题长期被掩盖；一旦用户显式选 Light/Dark 就暴露。
    - 受影响的是全仓每一处 `dark:` 工具类（`ui/badge.tsx`、`ui/button.tsx` 的 `dark:bg-input/32` 等大量原语内部用法）。
    - **T-21 的连带影响**：验收①「亮暗有别」若在 `theme: 'system'` 下点验则观察不到本问题；**显式切 Light/Dark 才能复现**。T-21 已按此规避——`ui/badge.tsx` 四个色调 variant 的字色改用同族实色（`text-success` 等，随 `.dark` 自动换值），`dark:` 只用于把色调底 8%→16%，脱钩时最多是浓淡差、不会不可读；`chat/MessageTimeline.tsx` 的用户气泡也因此**没有**按亮暗拆写（改用两套主题下都能与 `bg-card/50` 分开的 `bg-accent`）。
    - **修法与风险**：一行 `@custom-variant dark (&:where(.dark, .dark *));` 即可对齐，但会**一次性改变全仓所有 `dark:` 工具类的生效条件**，需逐屏复验——**属独立任务，不塞进 T-21**。裁定前新代码**不得依赖 `dark:` 表达关键可读性差异**。
14. **`dev.env` 凭证隔离只覆盖 `scripts/dev.js` 一条启动路径**（2026-07-29，随 dev 态凭证隔离落地时登记）：剥离 + 注入 + 隔离 `CLAUDE_CONFIG_DIR` 三步都写在 dev.js 里，**不经过 dev.js 的路径一律仍回落开发者本机 `~/.claude` 登录**：① 打包版（`app.isPackaged`，属设计如此，但用户拿打包版点测 T-10 时会用自己的账号计费）；② `pnpm start` / `pnpm preview`（`electron-vite preview`）；③ 直接跑 `npx electron-vite dev`；④ agent-host 的 `spikes/*.ts` 探针脚本。要不要把这层下沉到 Host 侧（`claudeSettings.ts` 按标志位强制），还是维持「只保 dev.js 这一条主路径 + 其余靠约定」？——**等用户拍板**，牵涉是否动程序代码（本轮用户明确要求不动）。
    - **连带缺口**：`dev.js` 的 `parseEnvFile` / 剥离逻辑 / 拒绝启动分支**没有任何自动化断言**（vitest 例数 618 未增），只有一次手工投毒实测记在台账。按工程规范第 4 条（断言过程）与第 7 条（回归分层），至少该补 smoke 级用例；未补前这段逻辑的回归靠人工。
15. **提示词缓存命中不稳定:网关责任待复测裁定(2026-07-29 当日降级)**:~~原结论「网关无会话亲和、app 无可修」~~——**用户当日实测反证:同一网关直接接 Claude Code CLI 使用,缓存一切正常**。两组数据可同时为真的解释:命中行为按模型/通道而异(探针用的是 sonnet-4-6 / sonnet-5,CLI 走的模型可能落在不同上游通道)。**裁定步骤**:① `3622c19` 修复后直接 GUI 复测(第二条消息面板应出现缓存读取);② 仍为 0 则用 `spikes/cache-affinity-probe.mjs` 分别跑 GUI 默认模型与 CLI 同款模型做同模型对照。裁定前**暂缓**联系网关运营方。原探针数据(相同重发 4/4 命中、前缀增长 2/4)仍记录在案:对照实验证实 ccmax 分组多上游账号轮询、上游缓存按账号隔离——字节级相同请求重发 4/4 命中,多轮前缀增长形态 2/4 命中 2/4 全量重写;app 侧前缀已拦截证实逐字节稳定,**无可修**。后果:多轮对话每条消息大概率按 ¥6/M 全量重写(42k 上下文 ≈ ¥0.25/条,随上下文线性恶化)。**待用户**:找网关运营方开「渠道亲和 + 渠道内 Key 亲和」(new-api issue #5992)或给令牌绑定单上游通道;修复后用 `spikes/cache-affinity-probe.mjs` 复测(预期 5 次请求后 4 次全部 read>0)。与 #5/#8(thinking 跨模型不一致/漂移)同根因家族,亲和落地可能一并收敛。证据全文:[`docs/design/BUG-2026-07-29-prompt-cache-rewrite.md`](../../../design/BUG-2026-07-29-prompt-cache-rewrite.md)。
16. ~~侧栏两层化 + Composer 目标栏:四项呈现层拍板~~ **已全部拍板(2026-07-29 当日收口,决策入总台账 D21~D23)**:A=`flat` 平铺+分支 chip(by-worktree 带被否,参照 Cursor 侧栏截图);B=运行位置只读指示器(远程功能上线后再升级为下拉);C=Recent 段保留(用户保留否决权);D=**超出原选项**——用户要求中列整体对齐 Cursor 风格(空态居中 Composer/会话态沉底+目标行,截图入库 `docs/design/refs/cursor-20260729/`),立项 **A07 观感基线**(用户验收后 T-27/T-28 施工)+ **T-28 中列状态化布局**;会话 Tab 栏是否引入在 A07 验收时定。原文如下——双独立方案(Opus/Codex)核心裁定全部收敛(侧栏「文件夹→对话」两层、分支下拉=worktree 选择器禁 in-place checkout、New Worktree 归分支下拉、subagent 后置),分歧仅呈现层四点待用户拍板——A. 侧栏 worktree 默认 `by-worktree` 吸顶带还是 `flat`+chip(建议前者,openchamber 默认);B. 运行位置做只读指示器还是带 disabled 项的下拉(建议前者);C. 侧栏 Recent 段保留还是移除(建议保留,参考实现口径);D. 零新视觉值还是先补 Composer/下拉观感基线 A07(建议前者;基线 HTML 对 composer/dropdown 零命中)。拍板后 D21/D22 进总台账、T-26/T-27 进执行计划任务表。全文:[`docs/plans/2026-07-29-sidebar-composer-target-bar-design.md`](../../../plans/2026-07-29-sidebar-composer-target-bar-design.md)。
17. **subagent 层数据源:Path A(SDK `forwardSubagentText` 直播)还是 Path B(读磁盘 `<session>/subagents/agent-*.jsonl` + `.meta.json` 回放)**(2026-07-29):建议 **B 先行**——不动协议版本、覆盖 resume/CLI 历史、join key `toolUseId ↔ ChatBlock.toolCallId` 已就绪;A 作后续增强。⚠️ 两条实测更正:派生工具名是 **`Agent`** 不是 `Task`;`isSidechain:true` 已不再内联出现在主 transcript(子代理外置 `subagents/` 子目录),`historyReader.ts:700` 防线基本空转,真正挡路的是文件名过滤 + 不递归 readdir。设计文档 §5 有全部证据。

## #18 问答挂起时是否解禁 Composer 打字（T-05 R-5，2026-07-30）

- **现状**：问题挂起（waiting_question）时 placeholder 已按 A07 屏⑥E 变为「Add more optional details…」，但 textarea 因 busy 判定仍禁用——文案邀请补充、实际不能打字，存在不自洽。
- **矛盾根源**：验收④条文字面要求 placeholder 变化；解禁打字属 Composer 行为改动（busy 判定拆分），超出 T-05 边界，T-05 未单方面裁定。
- **待拍板**：A（解禁：挂起时可打字入草稿，答完题后可发——对齐 Cursor 语义，需拆 busy 判定另立小任务）/ B（不解禁：回退 placeholder 变化，挂起时保持原文案——牺牲验收④一条）/ C（维持现状不自洽）。
- **✅ 2026-07-30 用户拍板 = A 并扩展**：解禁打字且**后发消息排队**（当前工具调用/回合完成后再处理）→ **T-19 复活**承接（openchamber 队列语义研究已完成，纯客户端可实现，见主线台账 2026-07-30 行）。本问题关闭，后续归 T-19。
- 出处：主线台账 2026-07-30 T-05 行；A07 :2702-2706。

## #19 model/effort 对 hostBound 会话的 direct 发送不生效（T-19 设计发现，2026-07-30）

- **现象**：`sendPreamble` 在 hostBound 时走 `'direct'` 不经 createSession，ModelSelect/EffortSelect 改值对下一回合不生效（仅重启/新会话生效）。属既存问题非 T-19 引入；T-19 的处置是「运行中不解禁 ModelSelect = 不撒谎」。
- **待裁定**：给 `session.send` 补 model/effort 下发（协议可选加法，Host 侧 query() 支持与否需探针验证），或明确「模型仅会话级」的产品口径并在 UI 表达。
- 出处：T-19 设计文档 R3。

## #20 stopping 态下手动直发路径未覆盖（T-19 复核 M6 附带发现，2026-07-30）

- **现状**：`isStoppable` 改为委托 `queueRelease.isRunningStatus` 后覆盖 running/starting/waiting_permission/waiting_question 四态，**`stopping` 不在其中**——理论上处于 `stopping` 态时手动直发路径可能被误判为可发送。
- **范围判定**：T-19 前既存的口子，本轮修复只是把手抄副本换成委托、未新引入或放大；本轮同时补了九态×五布尔一致性属性测试，确认边界清楚。**自动放行路径 `decideQueueRelease` 走独立判定，不受影响，天然安全**——仅手动直发路径存在理论缺口。
- **待裁定**：要不要把 `stopping` 也并入 busy/disabled 判定——不阻塞 T-19 验收，等后续复现或用户反馈再评估。
- 出处：主线台账 2026-07-30 T-19 行「复核结论执行」段（M6）。

## #21 T-19b：消息队列后续设计事项收拢（2026-07-30 新立）

消息队列首版（T-19，`1b350ff`）落地后收拢的后续设计与增强事项，暂不阻塞当前验收，留待后续排期：

- **失败载荷归队需重新设计**：对抗复核 M2 指出，把失败载荷放队首会造成永久闭锁（head-failed 卡死后续消息），本轮 R5 预案已回退为组件局部 retryable 形态规避，但**正确语义应是退避 + 可见出口**，需要重新设计而非维持临时规避。
- **后台会话自动放行 / `runTurn` 抽取**：当前设计决策是后台会话不自动放行（需切回前台才放行）；若要改为后台自动放行，需先抽取共享 `runTurn` 逻辑。
- **插队 / 拖序增强**：队列条已支持删除与拖序（交换语义），更完整的插队（跳过队列顺序直接发送某条）暂未做。
- **持久化只存文本**：队列目前纯内存态，应用重启即丢失；若要持久化，需先定「只存文本（不含附件）」还是「文本 + 附件」的口径。

出处：T-19 设计文档（scratchpad `t19-design.md`）+ 主线台账 2026-07-30 T-19 行「已知代价」段。

## #22 网络环境复测需要用户配合（第二轮 GUI 点验，2026-07-30 新立）

- **现状**：`b159e4a` 诊断链（deep-reasoner 实跑 22 次 A/B 侦查）证伪「新仓库信任拦路」假设，坐实排队消息消失 / 新会话无回复的根因为**网络传输层瞬断触发 CLI `api_retry` 静默重试环**（`error_status` null、内建 10 次指数退避、归一化层原样丢弃）。app 侧已补网络重试可见性（状态行「Network retry N/M」+ TTFT 32s 看门狗），但**瞬断本身无法在 app 侧根治**。
- **待用户配合**：① 确认网络环境（是否走 VPN / 代理，是否存在已知瞬断源）；② 对网关做 curl 采样，观察是否复现瞬断；③ 在 ai-client 仓持续复测偶发频率（此前「新仓库特有」的判定已被本轮证伪撤销，需重新观察真实触发条件）。
- 出处：主线台账 2026-07-30「第二轮 GUI 点验反馈闭环」行。

## #23 授权 FIX 3（`PendingPermissionDock` UX 打磨）仍留档未做（2026-07-30 新立）

- **现状**：第二轮点验修复中授权卡不渲染的根因（幂等守卫谓词过宽）已随 `b159e4a` 根治，并同步补了拒答补偿事件回显、授权块首次裁定胜出、双桥互查挂起态。修复过程中额外识别出的 `PendingPermissionDock` 交互体验打磨项（FIX 3）**未纳入本轮范围**，本轮只做根治不做打磨。
- **待裁定**：是否排期打磨 `PendingPermissionDock` UX，具体范围留待后续设计另立。
- 出处：主线台账 2026-07-30「第二轮 GUI 点验反馈闭环」行。

## #24 会话标题来源元数据缺失（快赢批施工发现，2026-07-30 新立）

- **现状**：会话标题来源元数据缺失——`isPlaceholderTitle` 凭显示字符串判定，无 `titleSource`（`'placeholder'|'auto'|'user'`）持久化；Main 侧 `renameSession` 无条件更新（`CHAT_RENAME_SESSION`→`SessionIndexService.rename`），自动标题与手动改名的磁盘持久化次序毫秒窗残余。
- **方向**：`titleSource` 元数据 + Main 侧条件更新（CAS），涉主进程与索引 schema，非快赢范围。
- 出处：主线台账 2026-07-30「第三轮 GUI 点验结果 + 快赢批落地」行，Codex 对抗复核条目 2a/5「已接受残余」判定。

## #25 T-30 批2 形态三拍板项待用户（2026-07-30 新立）

- **现状**：T-30 批2 形态规格（[`2026-07-31-t30b2-composer-form-design.md`](../../../plans/2026-07-31-t30b2-composer-form-design.md)）交付，含三处待拍板项：①模型档位是否合并一体式 `Sonnet High ⌄`；②follow-up 卡是否改满圆 pill；③圆钮 28→24px + 发送键 `--primary`→近黑。
- **待用户**：三拍板项确认或否决，批2 开工前需裁定。
- **✅ 2026-07-31 结项**：三拍板项全部落定（第四轮 GUI 点验第 4/5 条）——①合并一体式模型档位控件 `Sonnet High ⌄`（默认无框，悬停/聚焦/弹层打开才显壳）；②follow-up 卡改满圆 `rounded-full` pill；③圆钮 28→24px + 发送键 `--primary`→近黑，均按推荐方案落定。T-30 批2 施工依据齐备（原规格 + [`2026-07-31-t30b2-composer-form-addendum-round4.md`](../../../plans/2026-07-31-t30b2-composer-form-addendum-round4.md) 追补，量级 5.6~6.1d），可开工。本条关闭。
- 出处：主线台账 2026-07-30「T-30 批2 形态规格交付」行；结项见 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行。

## #26 Host 受理边界 clientTurnId 幂等（Codex 诊断方案，纵深防御，2026-07-31 新立）

- **现状**：重试双发根治（`cb2d8d7`）采纳的是渲染发送层 `sawUserEcho` 作为幂等权威（Opus 诊断方案，红线零改动落地）。Codex 独立诊断同判核心根因，但主张更纵深的第二道防线——Host 受理边界按 `clientTurnId` 去重，本轮未采纳（不动 Host/协议）。
- **连带**：A5（retry-resume 历史重放，即中断发生在 `beginTurn` 之后、Retry 走 resume 续接时模型可能看到同一条消息两遍）按 Opus 诊断建议留待现场取证后单独立项，取证与本条一并评估。
- **待裁定**：是否排期实现 Host 侧 `clientTurnId` 幂等（涉协议/Host 改动，非零风险），或维持渲染层单一权威——等后续复现或用户反馈再评估。
- 出处：主线台账 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行，双轨诊断分歧仲裁段；[`2026-07-31-retry-doublesend-diagnosis-codex.md`](../../../plans/2026-07-31-retry-doublesend-diagnosis-codex.md) / [`2026-07-31-retry-doublesend-diagnosis-opus.md`](../../../plans/2026-07-31-retry-doublesend-diagnosis-opus.md)。

## #27 组件级事故测试基建缺口（2026-07-31 新立）

- **现状**：重试双发一类事故（`chat.send` 计数、竞态注入）需要真实组件渲染 + 交互模拟才能钉住回归，但本仓 vitest 为 node-only 环境、无 `.tsx` 渲染能力，写不出这类组件级事故回归测试。`cb2d8d7` 相关不变量本轮只能以 inspection-verified 注释入码，不可单测。
- **方向**：引入 component-test 环境（jsdom/@testing-library）或补一层 e2e 冒烟层，覆盖 `.tsx` 组件交互路径。
- **待裁定**：排期与选型（jsdom+RTL vs e2e）——等用户或后续任务评估。
- 出处：主线台账 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行，有意不做与残余段。
