# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。

- **Current Phase**: **Phase 0A 基线部分补做（A01 / A05 / A06）→ 观感对齐改造**（2026-07-28 转向）。这三项产品设计基线此前只在可行性文档的候选任务池、从未进执行计划或台账，而下游 F05/H01/H09 已按它们施工——这是「观感不到位 + 死按钮泛滥 + 布局反复卡壳」的同一根因，本日补做并落库（D18 / D19 / D20）。⚠️ **Phase 0A 整体仍 🟡 未收口**：A02 / A03 / A04 仍未立项，且已交付的 A06 依赖列写的正是「A01、A02」（口径以总台账 Phase 总览 0A 行为准）。Phase 3 Chat MVP 的剩余点测与网关阻塞并行不变。
- **Last Landed**:
  - 验收（2026-08-03）：**第七轮 GUI 点验用户验收通过**（原话「验收完毕，没有问题」）——第六轮两项与全部复核批修复闭环，诊断档结项；实测范围含 aaa 文件夹 New / "+ new chat" / 分支 chip 归属 / 失败退回重发无重复气泡 / 同文连发保留 / 附件与归档关闭对齐。第五轮清单 0-decies 与第四轮失败路径顺延项就此关闭；**0-octies 门槛达成 → T-27/T-28/T-19/T-30批1 转 Done**（见 roadmap）。点验期间一次「No repository registered」经查为 dev server 带病热更新残留态，非代码回归（诊断档附注）
  - 代码（2026-08-03 三批）：**第六轮点验两项修复 `fd55a26`**（测试 1537→1593）——① aaa 注册 worktree 文件夹 New 恢复（D2 裁定：注册文件夹即项目主 workspace，短路泛化子目录/尾斜杠/软链）；② 重发「双发」定性为 resume 重放与 live 回显未对账的显示层复制并根治（`historyReplayMerge` 三重护栏：resume 水位/命中才删/快照尾锚；红线最小挂接）。Opus+Codex 双轨独立诊断 + 两轮对抗复核（首轮 1 blocker+3 major、终验 1 blocker+1 major）全闭环。明细见主线台账 2026-08-03 第六轮三行 + 诊断档 [`2026-08-03-round6-feedback-diagnosis.md`](../../../plans/2026-08-03-round6-feedback-diagnosis.md)
  - 代码（2026-08-03 二批）：**第五轮点验四项修复 `6ece6cb`**（47 文件 +5811/−235，测试 1475→1537）——New 焦点夹三级回退/归档关闭语义定版（撤销 eager 登记+tree-sync 补种收紧+幽灵会话守卫）/items-start 对齐/⊕ Attach files 全链（fd 绑定安全读取）。Opus+Codex 双轨复核 1 blocker+8 major 全闭环。**GUI 点验待用户**（0-decies）。明细见主线台账 2026-08-03 第五轮行
  - 代码+文档（2026-08-03）：**T-30 批2 落地 `9e2736b`——D25 分域字体全量 + Composer 形态对齐 Cursor 三拍板**（70 文件 +4202/−603，测试 1345→1415）——globals.css 分域两栈 + 六字号 token 注册进 tailwind-merge（根治 cn 吞类）+ argKind 多态 + chat/workspace-shell 域映射清零 + chat 外补 mono 9 处 + 45rem 阅读栏；合并一体式 `Sonnet High ⌄`（删 ModelSelect/EffortSelect）+ follow-up 卡 42px 静息半高 rounded-[21px]（as-built 修正）+ 圆钮 24px 近黑 + ⊕ Add file context（结清 T-28 偏离①）+ 8px 净空归一；A07 v4 追记一~十一节（.fx 零字节）/phase0a/design-system 改写/a09 凭证页新建；Opus+Codex 双轨独立对抗复核 2+4 major 全闭环（反例证红→证绿），Grep/Glob argKind 分歧仲裁采 Opus（复合渲染入 ideas）。**GUI 点验待用户**（第五轮，清单 0-nonies）。明细见主线台账 2026-08-03 行
  - 文档（2026-07-28）：**A01 / A05 / A06 基线补登交付**，产物统一为 [`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（用户已验收）；三条裁定落库 **[D18](../../../plans/openchamber-chat-refactor-ledger.md)（视觉，撤销 D6）/ D19（布局骨架，撤销 D15）/ D20（问答归宿，偏离登记）**。
  - 代码（2026-07-28）：GUI 首测暴露链五连修——**多轮上下文继承** `eea2f25` · **demo 机器路径解绑** `0bd70d5` · **Host stderr 可观测性 + win32 守卫** `da9a5da` · **open-path 拉取握手 + 单实例门** `9331d51` · **dev.js argv 透传 + enso 归档名** `576f3bd`（明细见主线台账 2026-07-28 六行）
  - 文档（2026-07-29 四批）：**D24 落库——工具行/问答卡形态源改判为 Cursor**（用户在 Cursor 触发两类组件演示并存图，5 图入库 refs/cursor-20260729/）：工具行=动词开头灰阶单行+聚合展开；问答卡=Questions 折叠条/A-B-C-D 字母行/Skip+Continue/**回答后冻结 Answers 卡（与 D20 合流）**。D23 的「时间线内部不动」边界句作废；**T-05 待二次重写验收标准**（开工前、按 A07 v2）；A07 v2 补两屏制作中。「点击历史消息重新编辑」用户标注待定、仅归档
  - 文档（2026-07-29 三批）：**A07 中列 Cursor 观感基线 ✅ 用户正式定稿(2026-07-29,v3)** [`docs/design/a07-cursor-composer-alignment.html`](../../../design/a07-cursor-composer-alignment.html)——六屏 × Flexoki 亮暗;§08 五件事已全部裁定,工具行交互口径(Read 可点击/Grep 悬浮命中列表)与 main/master chip 已烧入;**T-05 验收标准已按定稿重写(执行计划 §3 T-05 行现行权威段)**，token 与 globals.css 机器校验一致；**待用户浏览器验收**（重点：Tab 栏带/不带、运行位置只读 chip），通过后 T-27/T-28 方可施工
  - 文档（2026-07-29）：**侧栏两层化 + Composer 目标栏合并设计**落库 [`docs/plans/2026-07-29-sidebar-composer-target-bar-design.md`](../../../plans/2026-07-29-sidebar-composer-target-bar-design.md)（双独立方案 Opus/Codex 收敛合并；用户 2026-07-29 拍板方向）——核心裁定：侧栏「文件夹→对话」两层、Workspace 降为运行目标属性、分支下拉=worktree 选择器**禁 in-place checkout**、subagent 后置（Path B 先行）；**T-24 账实不符已更正**（实体随 `b38017b` 夹带落库）。呈现层四点待拍板 → open-q **#16**，拍板后 D21/D22 落总台账、T-26/T-27 立项
  - 文档（2026-07-30）：**观感审计交付 + 三拍板落库**——[`polish-audit-20260730.md`](../../../design/polish-audit-20260730.md)（34 条）；**D25**（D18 复议通过：分域字体，open-q #10 结项）/ **D26**（四条 A07 修订 + Markdown 立项）落总台账；**T-29**（Markdown 渲染 ≈2d）/ **T-30**（打磨批次 1+2，批1 ≈1d 零基线修订可先行）进执行计划 §3；open-q **#19** 新立。T-19 三批施工中（批 1 纯函数层）。
  - 文档（2026-07-30 二批）：**T-30 批2 施工依据——D25 分域字体规格交付 + 编排者三条临时裁定（待确认）**：deep-reasoner 产出 637 行规格（scratchpad `d25-font-design.md`）——系统字体栈零随包/Latin 先 CJK 后（禁 `system-ui`）；「内容 vs 控件」判据；`ToolRowView` 需加 `argKind` 字段区分参数渲染；`ToolRows.tsx` 两处 `<pre>` 缺 `font-mono` 属回归必补；字重仅 400/600 全平台真档（Win10 Segoe UI 无 500）；字距四档 + CJK 禁负值；~14 处补 `tabular-nums`；阅读栏 48rem→45rem（DPR 标定实测，对齐 Cursor 参照 45rem=48 CJK 字/行）；A07/phase0a 渲染层冻结段 + v4 追记；与 open-q #12 正交。量级估 ≈3.25~3.75d。**编排者三条临时裁定（待用户 GUI 点验确认/否决，非正式拍板）**：①§2.3 三处细化点采方案 A（侧栏分支 chip sans13/分支下拉 sans14/运行位置 sans14，对齐 Cursor 参照）；②阅读栏采 45rem container token 方案；③新建 `a09-font-domain-baseline.html` 承载三测点 A/B 凭证（尚未建）。批2 开工前待用户表态。明细见主线台账 2026-07-30 D25 规格交付行。
  - 代码（2026-07-30 四批）：**T-19 消息队列落地——运行中解禁输入 + FIFO 排队** `1b350ff` —— 三批施工断言先行（纯函数层 messageQueue/queueRelease +85 例 → 解禁输入+提交即消费+idle 放行 +5 例 → 队列 strip 删除/拖序回填+暂停 Resume+授权提示行 +4 例）；对抗复核位变更（Codex 两次容量满载改派 deep-reasoner，1 blocker/6 major/17 minor）+ 修复批（+6 例，按 R5 预案回退「失败载荷归队」等）；测试 997→1097。已知代价：后台会话不自动放行、重启队列丢失（均设计如此）。**GUI 点验待用户**。明细见主线台账 2026-07-30 T-19 行
  - 代码（2026-07-30 五批）：**T-30 批1 观感快赢落地** `3dcd2dc` —— 12 项快赢中 10 项落地（删 USER 角标/user 气泡回归/NoticeMessage/失败框收敛/间距/`--tool-arg` 62%→78%/模型名兜底/QuestionCard+LeftNav 字距），P-19/P-22 让给 T-23。批2（D25 分域字体+D26 四条修订）待编排者三条临时裁定确认后开工。**GUI 点验待用户**。明细见主线台账 2026-07-30 T-30 行
  - 代码（2026-07-30 三批）：**授权串行呈现 + A08 临时基线入库** `beb8ccc` —— 授权逐张弹出（仅队首可答，用户裁定）；A08（用户 Cursor 自制右栏/导轨**临时基线**）入库，正式化留 T-12~15 消费时。明细见主线台账 2026-07-30 三行
  - 代码（2026-07-30 二批）：**首轮 GUI 点验修复** `4019fed` —— 授权并发队列化（单槽→pendingPermissions + permissionId 级门，含设计期挖出的静默错投隐患；桥/协议零改动）+ 默认主题改亮（'system' 迁移）+ 输入框双框 unstyled 根治 + 流式 stick-to-bottom。**#18 拍板 = A（解禁打字+排队）→ T-19 复活**（openchamber 队列语义研究已完成：纯客户端四件套可复刻）；**#15 改「初步命中，持续观察」**。观感判定与两图入库 refs/feedback-20260730，打磨底稿五条归专项。明细见主线台账 2026-07-30 二行
  - 代码（2026-07-30）：**T-05 工具行/问答卡重做落地** `340a59a` —— 工具行 Cursor 动词灰阶单行（--tool-arg 新 token、完成前缀聚合、Thought/Worked for 行、输出体三档滚动窗）、assistant 去气泡、Read 点击（fileOpenIntent 待 T-13 消费）+ Grep 560×288 悬浮浮层（不可信逐行降级）、问答卡四态（Dock 吸附不滚走/字母 chip/冻结 Answers/skipped）、Permission 换形、respond 返 Promise 提交失败可重试（红线纯加法）。Codex 复核 4 blocker+2 major+2 minor 全采纳。**空 thinking 块改裸行=批准变更；R-5 挂起禁打字升 open-q #18**。**GUI 点验待用户**。明细见主线台账 2026-07-30 T-05 行
  - 代码（2026-07-29 六批）：**T-28 中列状态化布局落地** `4c1e4d7` —— 空态 Composer 卡居中偏上+目标栏三槽在上 / 会话态时间线在上（Session status 头行删）+40px follow-up 沉底+目标行两槽在下（D23/A07 屏①②）；两态判定纯函数 `middleColumnLayout.ts`（恢复态 runtimeIdentity 防闪帧 + sendAttempted 粘滞闩，+49 例）；ChatComposer 单槽位防卸载在飞 send；28px 圆形发送键；Codex 复核 blocker（卡高 42≠40，设计自证漏算边框）已修 `min-h-10+py-1`。「+」附件钮不实现入档。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-28 行
  - 代码（2026-07-29 五批）：**T-27 Composer 目标栏落地** `e8fb36a` —— Composer 卡上方三控件（D22/A07 档位）：文件夹下拉（Recents+分组+四动作全真实接线）、分支下拉=worktree 选择器（禁 checkout 守卫钉死、getBranches 仅对话框内、gitEnabled 门控非 git 不出现）、运行位置只读指示器（缺数据隐藏）；三档规则纯函数 `composerTarget.ts` + `chatSessionActions.ts`（retarget/fork）+ fork 附件草稿携带；删 MainHeader Folder/Host 死按钮。**Codex 对抗复核 5 blocker+3 major 全采纳零驳回**（runtimeIdentity 入 fork 判据 / pending 携源会话 / 发送门统一 cwd / gitEnabled 前置）。+70 例（总 784）。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-27 行
  - 代码（2026-07-29 四批）：**T-22 壳结构改造落地** `95a5c04` —— 四区壳改三列 + 44px 导轨 + surface 模型（D19）：Sidebar 280 可拖 280–500、阅读栏 48/64rem（LayoutGrid 接线，消化一枚 A06 死按钮）、ContextPanel 380–1400 按 surface 记忆宽 + 提升覆盖 Main、Rail 仅 git 圆点（真数据无轮询）、**删 BottomDock/RightDock**；布局纯函数 `shellLayoutModel.ts`/`surfaceRegistry.ts` 断言先行（+79 例）+ persist store `aiclient-shell-layout`。Codex 对抗复核（恢复同行位）1 blocker 驳回（验收⑤口径=代码零引用，docs 历史叙述不改）+ 采纳 5 项当场修（pointer 会话绑定/动画期基线/卸载复位/内层列保宽/NaN 防护）。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-22 行
  - 代码（2026-07-29 三批）：**T-26 侧栏两层化落地** `dd23b01` —— 侧栏「文件夹→会话」两层平铺（D21/D21-A）：`sidebarTree.ts` 纯函数断言先行（14 例）、全量分支 chip（main/master 显实际分支名，`ChatWorkspace.branch` 纯可选加法）、Recent 段 48h 口径（7 条+Show more，折叠持久化）、`selectedWorkspaceId` 移除（选择权移交 T-27 目标栏）。对抗复核 1 blocker——sync 桥变更签名缺 `branch`，冷启动 chip 全灭——已修（`workspaceTreeSignature` + 回归测试）；ARD §4 数据层级文字块按 D21 连带改写。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-26 行
  - 代码（2026-07-29 二批）：**缓存排查闭环** `3622c19` —— 对话每条消息全量重写缓存的双根因坐实：**主因网关无会话亲和（app 无可修，open-q #15 待用户找运营方）**；次因 Host `session.resume` 丢 model/effort（Host 重启后静默换回 cli 默认模型）已修，+3 例钉死 resume→query() 下发。故障档案 [`docs/design/BUG-2026-07-29-prompt-cache-rewrite.md`](../../../design/BUG-2026-07-29-prompt-cache-rewrite.md)，探针 `spikes/cache-affinity-probe.mjs` / `capture-proxy.mjs` 入库
  - 代码（2026-07-29）：**窗口链** `d68d3c6` · **凭证隔离** `b18ccac` —— **「不出窗口」故障闭环**——同事的 show 兜底复核有效（本机实际生效路径 = `did-finish-load`，`ready-to-show` 从不触发），**原故障报告根因判错已更正**；连带修 `MainWindow.ts` 窗口状态从未恢复的既有 bug + 兜底日志被 electron-log 静音；顺带修 `McpSection.tsx` 嵌套 `<button>`。**dev 态凭证隔离**——`scripts/dev.js` 读 `dev.env` 剥离/注入/隔离，裸启动不再回落开发者本机 `~/.claude` 登录。明细见主线台账 2026-07-29 两行
  - 代码（2026-07-30）：**第二轮 GUI 点验反馈闭环** `b159e4a`（51 文件 +4721/-184）—— 用户第二轮真机点验回报九条反馈，7 路并行工作流逐条行级定位 + deep-reasoner 22 次 A/B 侦查证伪「新仓库信任拦路」假设、坐实网络传输层瞬断触发 CLI `api_retry` 静默重试环为真根因。**四项功能根治**：授权卡不渲染（`4019fed` 幂等谓词过宽已收紧）/ 排队消息消失+新会话无回复（origin 语义改造 + 受理证据改用户回显）/ 选 sonnet 实调 opus4.8（`session.send` 补可选 `model` 字段全链直通）/ 附件发送后不显示（`MessageStartedEvent` 补可选附件元数据）。另有网络重试可见性五项（状态行 Network retry N/M 等，其中一项被复核否决删除）与视觉六项（combobox 横滚/resize 穿透/触发器尺寸/padding/scrollFade）。**复核链**：Codex + Opus deep-reasoner 双轨独立对抗复核 → 三轮修复迭代 + 三路复验全 pass，红线文件本轮批准四处微改。**残留**：网络环境复测待用户配合（open-q **#22**）；授权 FIX 3（`PendingPermissionDock` UX）留档（open-q **#23**）；**T-30 批2 施工依据的编排者三条临时裁定，用户本轮点验未异议 → 裁定 A 生效，批2 解禁开工**。**待用户第三轮 GUI 真机复验**。明细见主线台账 2026-07-30「第二轮 GUI 点验反馈闭环」行
- **Last Verified**: 2026-07-28 Linux 三绿——typecheck 干净 / lint 609 文件 0 诊断 / vitest **51 文件 590 例**（3 失败=Windows-only 基线）
  - **2026-07-29 复核（`d68d3c6` / `b18ccac` / T-21 `b38017b` 合并态）**：typecheck 干净 / lint **615 文件 0 诊断** / vitest **54 文件 618 例**（同 3 例 Windows-only 失败）。**例数未增 = 本轮未补测试**，`dev.js` 凭证逻辑目前零自动化断言（见 open-q **#14**）。
  - **2026-07-29 二批复核（`3622c19` 合并态）**：typecheck 干净 / lint 615 文件 0 诊断 / vitest **54 文件 621 例**（+3，同 3 例 Windows-only 失败）。
  - **2026-07-29 三批复核（T-26 `dd23b01` 合并态）**：typecheck 干净 / lint **620 文件 0 诊断** / vitest **55 文件 635 例**（+1 文件 +14 例，同 3 例 Windows-only 失败）。
  - **2026-07-29 四批复核（T-22 `95a5c04` 合并态）**：typecheck 干净 / lint **631 文件 0 诊断** / vitest **57 文件 714 例**（+2 文件 +79 例，同 3 例 Windows-only 失败）。
  - **2026-07-29 五批复核（T-27 `e8fb36a` 合并态）**：typecheck 干净 / lint **643 文件 0 诊断** / vitest **61 文件 784 例**（+4 文件 +70 例，同 3 例 Windows-only 失败）。
  - **2026-07-29 六批复核（T-28 `4c1e4d7` 合并态）**：typecheck 干净 / lint **646 文件 0 诊断** / vitest **62 文件 833 例**（+1 文件 +49 例，同 3 例 Windows-only 失败）。
  - **2026-07-30 复核（T-05 `340a59a` 合并态）**：typecheck 干净 / lint **662 文件 0 诊断** / vitest **68 文件 966 例**（+6 文件 +133 例，同 3 例 Windows-only 失败）。
  - **2026-07-30 二批复核（`4019fed` 合并态）**：typecheck 干净 / lint **665 文件 0 错误**（外来未跟踪 a08 html 警告不计）/ vitest **69 文件 995 例**（+1 文件 +28 例，同 3 例 Windows-only 失败）。
  - **2026-07-30 四批复核（T-19 `1b350ff` + T-30 批1 `3dcd2dc` 合并态）**：typecheck 干净 / lint **672 文件 0 错误**（外来 a08 html 29 警告不入库不计）/ vitest **71 文件 1097 例**（较上次登记基线 `4019fed` 的 69 文件 995 例 +2 文件 +102 例——含 `beb8ccc` 此前未单独登记的 +2 例与 T-19 的 +100 例，T-30 批1 本身无新增测试；同 3 例 Windows-only 失败）。
  - **2026-07-30 五批复核（`b159e4a` 合并态，第二轮 GUI 点验反馈闭环）**：typecheck 干净 / lint **676 文件 0 错误**（外来 a08 html 29 警告 + 3 infos 不入库不计，同既往口径）/ vitest **74 文件 1240 例**（较上次登记基线 71 文件 1097 例 +3 文件 +143 例；commit message 记「测试 1148→1240」，与登记基线的差值未溯源，以本次实测为准；同 3 例 Windows-only 失败）。
  - **2026-08-03 复核（T-30 批2 `9e2736b` 合并态）**：typecheck 干净 / lint **686 文件 0 错误**（29 警告 + 3 infos 均为既有 a08 html 豁免，同既往口径）/ vitest **81 文件 1415 例**（较上次登记基线 74 文件 1240 例 +7 文件 +175 例——含快赢批 `514560c` 1290 与 `cb2d8d7` 1345 两级未单独登记的增量，可溯各自台账行；同 3 例 Windows-only 失败）。
  - **2026-08-03 二批复核（第五轮修复 `6ece6cb` 合并态）**：typecheck 干净 / lint **700 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **88 文件 1537 例**（+3 文件 +62 例；同 3 例 Windows-only 失败）。
  - **2026-08-03 三批复核（第六轮修复 `fd55a26` 合并态，T-31 开工前基线实测）**：typecheck 干净 / lint **703 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **90 文件 1593 例**（+2 文件 +56 例；同 3 例 Windows-only 失败）。
  - **T-21 复核口径（2026-07-28 审查回合，代码已于 2026-07-29 提交 `b38017b`）**：typecheck 干净 / lint **615 文件 0 诊断** / vitest **54 文件 618 例**（同 3 例 Windows-only 失败）。
    lint 文件数从 613 涨到 615 是**新增文件**所致（`docs/design/phase0a-openchamber-alignment.html` 基线产物 + `src/renderer/lib/__tests__/ghosttyTheme.test.ts`），**`biome.json` 未改**——
    施工中一度加过 `"!docs/design"` 排除项来绕开该 HTML 的 13 条诊断，这违反「不得改 lint 配置变绿」，已撤销：改为就地修（9 条 `useArrowFunction` 自动修 + 2 条 `noImportantStyles`、2 条 `noUnknownProperty` 加带理由的 `biome-ignore`，后者是 `corner-shape` 这个 Biome 尚无定义的 CSS Backgrounds 4 属性）。
- **Next Target**（2026-08-03 六次修订，第七轮验收结项）：**T-31 施工中**（回复解剖 + 置顶气泡，2026-08-03 开工；规格权威 [`2026-07-31-reply-anatomy-design.md`](../../../plans/2026-07-31-reply-anatomy-design.md)，施工序 R0~R6 ≈3.6d，任务定义见执行计划 §3 T-31 行；**§9 六项可拍板点按推荐值开工**——δ footer 不显耗时 / ε `Generating · Ns` / ζ 会话级失败块不移 / η scroll-state 截断（GUI 实测不可用则降 B）/ θ ScrollArea 按边 fade / ι 不做 fork——属编排者依「不阻塞开工」条款的执行裁定，用户如异议按点验反馈回改）；其后 **T-29 Markdown 渲染** → **T-24 收尾**（S0：全新机器 GUI 实测 + 台账补登，代码已随 `b38017b` 落库）→ **T-12/T-13/T-14/T-15**（四 surface，均依赖 T-22 已清）→ **T-23**。**点验残留**：T-22（0-bis）/ T-05（0-quinquies）清单未逐项表态，暂留 In Progress 建议并入下一次点验轮；0-nonies ⑪（a09 改后截图回填 + D25 §6.2 五项真机指标，Win10 必测字重）未采集；网络环境复测（open-q **#22**）；授权 FIX 3（open-q **#23**）；**T-04 网关阻塞**与 **#15 缓存复测裁定**并行。

> ⚠️ **门禁口径依机器而异（2026-07-27 新增，07-28 扩充）**：Linux 检出上「全绿」不成立。3 例
> Windows-only 断言在 Linux 上不可能通过——`ShellDetector.test.ts` 2 例（断言
> `powershell.exe`）、`CliDetector.test.ts` 1 例（cmd fallback）。**Linux 上的三绿口径 =
> typecheck 干净 / lint 0 诊断 / test 只剩这 3 个失败且总例数只增不减**；Windows 上仍应全绿。
> **Linux 机每次 `pnpm install` 后必须两步复原**（否则 app 起不来、T-07 集成 6 例红）：
> ① `npx electron-builder install-app-deps`（重建 sqlite3 等 Electron ABI）；② 把
> `src/agent-host/node_modules/@cometix/claude-code/vendor/ripgrep/x64-linux/rg` 拷进
> `node_modules/@vscode/ripgrep/bin/rg`（postinstall 被 GitHub 403 挡）。下载类脚本另需
> `NODE_USE_ENV_PROXY=1`。联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)。
> **2026-07-29 更正**：第 ① 步原写「必须用可用代理覆盖 `~/.npmrc` 里的 `127.0.0.1:7890`」——
> **实测不需要代理**，Electron 39.2.7 头文件本就缓存在 `~/.electron-gyp/39.2.7`，直接跑即可。
>
> ⚠️ **GUI 启动口径（2026-07-29 变更）**：一律 `node scripts/dev.js`，**不要用 `pnpm dev`**——
> pnpm 10 的 `verifyDepsBeforeRun` 会在跑脚本前重装依赖，冲掉上面两步复原的成果。
> 凭证改由仓库根 **`dev.env`**（gitignore，模板 `dev.env.example`）在启动期注入，dev.js 会剥离
> shell 继承的全部 `ANTHROPIC_*` 并把 `CLAUDE_CONFIG_DIR` 指向隔离目录；**缺文件直接拒绝启动**。
> 这取代了原先手工 `CLAUDE_CONFIG_DIR=... ` 的做法；`pnpm prepare:test-config` 仍可用但不再是主路径。
> 覆盖面缺口（打包版 / preview 不经 dev.js）见 open-q **#14**。

## 2026-07-28 观感对齐转向（摘要，正文见台账）

| 编号 | 一行摘要 | 去向 |
|---|---|---|
| **D18**（撤销 D6） | 对齐 OpenChamber 观感 = Flexoki 主题 + 全等宽字体 + 卡片形态三者一并对齐 | 代码落地 **T-21**；风险 open-q **#10 / #11 / #12** |
| **D19**（撤销 D15） | 三列 + 44px 图标导轨 + surface 模型，**废弃底部面板** | 壳改造 **T-22**；连带 T-12/T-13/T-14/T-15 重定义 |
| **D20** | 问答卡保留「就地冻结」，不照搬 OpenChamber「回答后消失」——登记为偏离 | 解除前置 **C-17**（后置） |
| **A01 / A05 / A06** | 三项设计基线补登并交付，产物统一为对齐基线 HTML（**A02 / A03 / A04 未立项，Phase 0A 整体仍 🟡**） | 违规清理 **T-23**；新壳添加仓库 **T-24**（阻断级） |

决策原文与依据一律看[总台账](../../../plans/openchamber-chat-refactor-ledger.md) D18~D20，本树不复制。
架构改口见 ARD 十二节（清单见 [ARD 修订头](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md)，2026-07-28 复验轮更正：原写七节已过期）。

## #8 结论（2026-07-27）

| 项 | 结论 |
|---|---|
| T-04 thinking 空白真凶 | ✅ `display` 默认 `omitted`。实测：裸 `{type:'adaptive'}` → thinking 块 1 个但文本 **0**；加 `display:'summarized'` → 文本 **408** 字符 |
| C-14「400 thinking 格式无效」根因 | ❌ **原假说被推翻**——`{type:'enabled', budgetTokens}` 实测仍返回 200。open-questions #5 **保持 open** |
| `effort` 位置 | ✅ SDK 顶层 `Options.effort`，**不是** `output_config.effort`（更正 C-10 台账行） |
| T-20 协议底座 | ✅ `session.create.effort` / `session.send.effort` 已落（纯可选加法，未 bump 协议版本）；选择器 UI 已于 `4c3f67e` 补齐全链 |

证据：`spikes/c16-thinking-shape-probe.ts`（SDK 层五场景）+ `spikes/c16-thinking-host-smoke.ts`（真 Host NDJSON 全链）+ `__tests__/claudeRuntimeOptions.test.ts`（10 例钉死 options）。

## 首轮 GUI 联调结论（2026-07-26）

| 任务 | 结论 | 说明 |
|---|---|---|
| T-02 会话生命周期 | ✅ Done | 标题 bug 已修并复验通过；归档无 un-archive 入口 = 设计缺口，转 open-questions #6 |
| T-03 Resume 历史 | ✅ Done | 重放机制 2026-07-26 已复验通过；缺的历史读失败 UI 已于 2026-07-27 `7a5c2cd` 补齐（三码可区分 + 非致命表达 + read_failed 可 Retry），等 GUI 点验 |
| T-04 Thinking 卡 | 🔴 **卡在网关**（2026-07-28） | 用户实测无卡。探针实证（各 2/2）：GUI 默认 `sonnet` 在本网关返回**空文本 thinking 块**（不理会 `display:'summarized'`）；#8 验证过的网关默认模型今日**确定性 400**。渲染链逐门核查无 bug。**app 侧无可修**，等网关侧处理（open-questions #5/#8） |
| T-06 元数据/重试 | ⬜ 未测 | 唯一完全未碰的任务，不受上述 bug 影响，可直接补测 |
| T-07 `@` 引用 | ✅ Done | P0 反斜杠已修并复验通过；三项补强（目录 / 隐藏文件 / 截断提示）+ 同分定序已于 2026-07-27 `0f886a8` 落地，等 GUI 点验 |

Tool 卡不折叠 = T-05 未开发，**非 bug**（且 T-05 口径已于 2026-07-28 整体重写：工具行改为**无边框无徽章单行**，见下）。

## Active TODO

> 2026-07-28 重排：开发线按「落库 → **添加仓库通路（阻断级）** → 主题 → 壳结构 → 工具行/问答卡 → 违规清理」推进；
> 原第 0~2 项及其后的待拍板项并行不变，移入下方「用户线」。
> **顺序权威 = [执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3**（起步顺序 + §8 风险 9：「T-24 是阻断级缺口，**不排进 Phase 4 尾巴**」）。
> 执行计划全序：**T-24 → T-21 → T-22 → T-05 → T-12/T-13/T-14/T-15 → T-23（与 surface 并行）→ T-16 → T-25**；本表顺序不得晚于该口径。
> **开发线各项的任务定义、数值与 `file:line` 只存在于执行计划 §3 任务表**，此处只留「ID + 一行目标 + 链接」（用户线的点验步骤不受此限）。

### 开发线（按序）

1. **落库收尾（进行中）**：ARD（十二节连带改口，清单见 [ARD 修订头](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md)）+ 总台账 D18~D20 + 执行计划任务表（T-05 重写、T-12~T-16 重定义、新增 T-21~T-25 / C-17）+ 本树四文件。落完才动代码。
2. **T-24 新壳「添加仓库」通路**（阻断级）——**2026-07-29 账实更正：实体已随 `b38017b` 落库**（名义 T-21 的提交夹带，信息未提本任务；入口/拖放/纯函数+测试俱全，证据见执行计划 §3 T-24 行更正段）。**剩余 = 全新机器 GUI 实测 + 台账补登（S0，不改代码）**；「文件夹下拉」入口是增强，拟归 T-27（open-q #16 拍板后立项）。→ 执行计划 §3 T-24 行
3. **T-21 Flexoki 主题 + 全等宽字体栈**（A05 代码化，D18）：`globals.css` 语义 token 重写 + 四个新 token + `docs/design-system.md` 同步改写（该文件是 `CLAUDE.md` 定的 UI 强制规范，不改就与 D18 对撞）；原色硬编码清理**只覆盖新壳 chat / workspace-shell 两个目录**（**不是全仓唯一**，旧模块归后置的 T-25）。**开工前先结 open-q #11**（根字号 14→16），验收含中英混排实测截图（#10）；终端与 Monaco 边界外（#12）。→ 执行计划 §3 T-21 行
4. **T-22 壳结构改造**（D19）：三列 + 44px 导轨 + surface 注册表，**删除 `BottomDock.tsx`**；布局与 surface 选择逻辑下沉纯函数。→ 执行计划 §3 T-22 行。**✅ 2026-07-29 已落库 `95a5c04`**（Codex 复核采纳项全修；剩 GUI 点验，清单见用户线 0-bis）
5. **T-05 重做**（口径 2026-07-28 整体重写，原口径作废）：无边框单行工具行 + 就地冻结问答卡（D20）；**store 侧冻结已实现**（含 5 例幂等测试），本任务只补 UI。原「开工前需用户定交互口径」已由本次拍板收口，不再阻塞。→ 执行计划 §3 T-05 行
6. **T-23 存量违规清理**（A06 矩阵产出）：死按钮与假 usage 环逐项接线，或 `disabled` + Tooltip 明写状态。→ 执行计划 §3 T-23 行

> T-25（旧模块原色硬编码清理，依赖 T-21）与 T-16 同属**后置**，不列入本开发线队列，归类以 [roadmap Deferred](./roadmap.md) 为准（2026-07-28 复验轮更正：此前误列为开发线第 7 项，与 roadmap 的 Deferred 归类相矛盾）。

### 用户线（点测 / 待拍板，与开发线并行）

0. **多轮上下文回归点测（2026-07-28 新增，最优先）**：同一会话连发两条（如「我最喜欢的数字是 47」→「我最喜欢的数字是几？」），第二条必须记得第一条；newapi 面板应显示同一会话续接而非每条新建缓存。修复 `eea2f25`。**⚠️ 2026-07-29 口径更正**：「缓存读取」一项在网关开会话亲和**之前不会稳定出现**（open-q **#15**，对照实验证实命中随路由随机、与 app 无关）——点测只验记忆连续性，勿再以面板缓存读取为判据。另补一项：**Host 重启后续聊模型不变**（修复 `3622c19`：重启前选非默认模型 → 重启 → 同会话再发一条 → 响应模型应仍是所选模型而非默认）。
0-bis. **T-22 壳结构点验（2026-07-29 新增）**：① 三列拖拽边界——Sidebar 拖到头停在 280/500、ContextPanel 停在 380/1400、Rail 恒 44（DevTools 量）；② Rail 四枚图标（Context/Git/Editor/Terminal）单选切换、再点同枚收起，未接入 surface 应显「T-1x 接线」诚实空态而非假内容；③ 顶栏 PanelRight 关→开应恢复上次 surface；④ 面板 Maximize 提升覆盖中列（不遮侧栏/导轨）、Minimize 还原；⑤ 顶栏 LayoutGrid 切 48↔64rem，时间线与 Composer 同栏宽居中；⑥ 有未提交改动的仓库 git 图标右上亮 6px 圆点、`git stash` 后熄灭，其余图标恒无圆点；⑦ 重启后侧栏宽/折叠、surface 选择、各 surface 面板宽、宽模式全部保持。
0-ter. **T-27 目标栏点验（2026-07-29 新增）**：① 有目标时 Composer 卡上方现三控件（文件夹/分支/运行位置），无目标整行隐藏；② 文件夹下拉切目标 → 底部状态行 cwd 跟着变；③ 有消息的会话切目标 → 提示将新建对话（fork）且**输入框文字与粘贴附件都保留**；④ 发送中/等待中三控件禁用（悬停有说明）；⑤ 分支下拉仅 git 仓库出现（普通文件夹添加后不出现），每行右侧显 worktree 路径；⑥ **New worktree 建完自动切换到新 worktree（重点）**；⑦ Use Existing/Clone/Add Remote 各打开添加仓库对话框对应 tab、New Folder 建临时工作区并自动切换；⑧ MainHeader 的 Folder / Host: Local 图标按钮已消失；⑨ 本机仓库运行位置显 This PC、悬停显只读说明。
0-quater. **T-28 中列两态点验（2026-07-29 新增）**：① 首开（空 Live 会话）Composer 卡居中偏上、无时间线、卡下留白；② 回车发首条 → 同帧沉底为 40px 单行 follow-up、横向左边界不动、焦点与草稿不丢；③ 关掉重开恢复历史会话不闪居中卡帧；④ 会话态目标行在卡下且只剩分支+运行位置；⑤ 圆形发送键、运行中原位变红停止圆、失败时左侧重试圆；⑥ 空态 @ 文件弹窗向下开不被裁；⑦ follow-up 打多行自动长高至 56px 后内滚；⑧「Session status」头行与输入区上方横线消失。
0-quinquies. **T-05 工具行/问答卡点验（2026-07-30 新增）**：① 工具行动词灰阶、无边框无图标、与正文同字号；② 连续读/搜完成后聚合行「Explored N files, M searches」可展开，进行中动作独立一行；③ 失败行整行红并自动展开输出；④ 展开体输入段（240px 滚动）在输出段之上；⑤ Thought 行展开见思考正文；⑥ Worked for Ns 在回合顶部；⑦ Read 行文件名悬停变色、点击打开右栏 editor（T-13 前为诚实空态）；⑧ Grep 行悬浮命中列表、列表项可点击；⑨ 提问时 Composer 上方吸附 Questions 条不被滚走 → 字母行选择 → Continue 后就地冻结 Answers → Skip 显 skipped；⑩ Permission 卡新外形 Allow/Deny 可用、断线失败后可重试；⑪ 挂起时输入框 placeholder 变化（**输入框仍禁用 = open-q #18 待拍板**）。
0-sexies. **T-19 消息队列点验（2026-07-30 新增）**：① 运行中输入框不禁用，可打字可粘贴图；② 回车不发送而入队，Composer 上方出现可编辑消息的队列条；③ 队列条可删除、可拖序（交换语义）；④ idle 时队首自动放行，多条按 FIFO 依次消费；⑤ 挂起问答/授权时点发送 = 自动取消挂起卡 + 消息入队（不直接发送、不误代答）；⑥ Stop 后队列暂停，Resume 或新回合自动恢复放行；⑦ 后台会话不自动放行、需切回前台才放行（设计如此非 bug）；⑧ 应用重启后队列清空（内存态，设计如此非 bug）。
0-septies. **T-30 批1 观感快赢点验（2026-07-30 新增）**：① USER 角标已消失、user 气泡回归基线观感；② 失败提示框不再整块刺眼（已收敛）；③ 工具行灰阶层级更清楚（`--tool-arg` 提升到 78%、destructive 降为 70%）；④ assistant 元数据行模型名不再丢失（切换过模型或重启后仍显示正确模型名）；⑤ QuestionCard 与侧栏文字字距梯度可见差异。
0-octies. **✅ 已结项（2026-08-03）**——①~⑤ 第三轮全过（2026-07-30），⑥ 失败路径经第四~七轮闭环（重试双发根治 `cb2d8d7` + 六轮 Bug B 根治 `fd55a26` + 第七轮验收「失败退回重发无重复气泡」），⑦~⑩ 各轮未报异议。原文留档：**第二轮点验修复回归点验（2026-07-30 新增，`b159e4a`）**：① 授权卡正常渲染不再卡住（重点回归「卡住了.png」场景）；② 排队消息不再消失，新会话能正常收到回复；③ 选 sonnet 时实际调用的确是 sonnet（非 opus4.8），meta 行模型名与所选一致；④ 发送带附件的消息后，时间线用户气泡能看到附件 chip；⑤ 网络瞬断重试时状态行出现「Network retry N/M」可见提示，不再是无声等待；⑥ combobox 下拉不再横向滚动；⑦ textarea 不再可拖拽变形、多行文字垂直居中；⑧ Model/Effort 选择器触发器尺寸一致不再挤压；⑨ 卡片内边距上下对称；⑩ 时间线顶部滚动时有柔和淡出（贴底滚动场景属固有行为非 bug）。
0-nonies. **✅ ①~⑩ 已结项（2026-08-03）**——第五轮点验对本批形态/字体无异议，五~七轮链闭环；**⑪（a09 改后截图回填 + D25 §6.2 五项真机指标，Win10 必测字重）未采集，仍待用户**。原文留档：**T-30 批2 点验（2026-08-03 新增，`9e2736b`）**：① 全 UI 已是比例字体，代码块/工具行输出/路径/hash/diff 行号仍等宽（三测点对拍页 `docs/design/a09-font-domain-baseline.html`，浏览器直接打开）；② Composer 右下为**单个**无框 `Sonnet High ⌄`（悬停/键盘聚焦才显壳；点开菜单分 Model / Reasoning effort 两段、勾在右；effort=Default 时触发器不显后缀；选目录外模型时菜单应勾在该模型自己的行上而非 Sonnet）；③ follow-up 卡静息 42px 两端半圆观感；**多行输入长高时两端不失控**（保持 21px 圆角矩形）；附件/notice 出现时降为 12px 圆角；④ 发送键 24px 近黑（不再品牌橙），运行中原位红色 Stop，失败重试圆并存；⑤ 卡最左 ⊕ 点击后光标处出现 `@` 且文件搜索弹窗弹出（文案 Add file context，非附件上传）；⑥ 目标行/模型触发器 hover 底为 8px 圆角（非满圆胶囊）；⑦ 聚焦 Composer 卡边框为中性灰加深（不再变橙）；⑧ 阅读栏变窄至 45rem（中文正文约 48 字/行）；⑨ 空态不再常驻 `Ready · cwd:` 行（cwd 移至文件夹下拉悬停 title）；⑩ 中文界面观感：18px 标题（如会话管理页）负字距无撞字、Win10 下 400/600 字重可辨、StatusLine/侧栏计数数字原地刷新不横跳；⑪ a09 页「改后」空位截图回填 + D25 §6.2 五项真机指标（Linux 与 Win10 各一台，Win10 必测字重）。
0-decies. **✅ 已结项（第七轮验收 2026-08-03，含第六轮两项修复 `fd55a26` 复验）**。原文留档：**第五轮修复回归点验（2026-08-03 新增，`6ece6cb`）**：① 侧栏点击某文件夹（如 aaa）后点全局 New → 会话建在该文件夹下（New 按钮悬停 title 显示目标夹）；文件夹内逐行「+」照旧；② 新建会话（未发消息）点归档 → 行立即消失；已发消息的会话归档 → 同样消失且运行中的会自动停；关闭 → 行本次运行消失（重启后持久化会话重现属设计，永久移除用归档）；关最后一个后**不再**自动冒出新 Live 行；③ follow-up 输入框 placeholder 与 ⊕ 图标中线对齐（打 2-3 行长高后图标钉在首行不漂移）；④ ⊕ 点击弹菜单（暂 Attach files 一条）→ 系统多选文件 → chip 入列（图 5MB/文本 512KB/最多 5 个逐件限额，超限有折叠提示；选 8 个只读 5 个不多读盘）；取消选择器零副作用；发送后附件随消息走；手打 @ 引用照常；⑤ 斜杠指令未做（低优先级已立档）。
1. **T-04 / T-07 GUI 验收**（用户人工，统一点测）：联调环境见
   [baseline 门禁「GUI 联调环境」](../../baseline/test-and-release-gates.md)（2026-07-29 起：填好 `dev.env` 后 `node scripts/dev.js`，勿用 `pnpm dev`、勿硬编码路径）
   - **T-04 thinking 卡**：🔴 **当前无法点验**——卡在网关（sonnet 空文本 / 默认模型 400，见上表）。网关侧修复后再测；仍须在**新发起轮次**验证（旧 fixture 的 153 个 thinking 块文本为空，不可追溯）。
   - **T-07 补强**：`@` 输入 `src/` 应见目录条目（黄色文件夹图标 + 尾随 `/`）；输入 `git` 应见 `.gitignore` 等隐藏文件；输入 `chat` 右下角应显示 `10/319`。
   - **T-20 Effort 选择器**：Composer 右下角 ModelSelect 旁应见新的档位下拉（默认显示 `Default`）。选 `X-High` 后重启应仍保持；**`Default` 与 `High` 是不同选项**——前者不下发 `effort`、保持模型默认。
   - **T-03 历史读失败提示**：造错的最快办法是把 `session-index.json` 里某条的 `runtimeIdentity` 改成一个不存在的 uuid 再 resume → 应见黄色告警「History file not found」，且**不再显示** "No messages yet"，输入框仍可用。`read_failed` 档才有 Retry 按钮；会话进行中时 Retry 应为禁用并说明原因。
   - **T-18 粘贴附件**（`703f981`，**本轮全部为人工待测**，Linux 环境起不了 Electron）：
     ① **纯文本粘贴回归——最重要**：Ctrl+V 普通文本/多行代码必须还是原生插入，一个字不丢；
     ② 截图工具粘贴 → 出现带缩略图的 chip；Explorer 复制文件粘贴 → 出现 chip **且路径文本照常插入**；
     ③ 中文输入法合成态下粘贴不打断候选词；粘贴后 `@` 引用弹窗仍正常；
     ④ 超限提示：>5 MB 图 / >512 KB 文本 / 第 6 个附件 / bmp-tiff-heic 格式 / 8000px 超限，各自应有可读文案；
     ⑤ 发送中：Send 变 Stop、秒数在走、45s 后转警告色；**双击 Send 与连按 Enter 都只发一次**；
     ⑥ **jpeg / gif / webp 至今未过网关实测**（自动化只验了 PNG 与 text/plain），请各发一张确认；
     ⑦ 失败后 chip 保留且 Retry 带着附件重发；健康会话里粘图**不应**出现 Retry 按钮。
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）
3. T-10 打包版点验（用户，[清单](../../../plans/t10-packaged-gui-checklist.md)）→ **CP2 汇报**
4. C-15 体积 141MB（+21MB）可接受性——等用户拍板
5. T-19 消息队列提案——等用户落库
5-bis. ~~布局呈现层四点拍板~~（**2026-07-29 已收口**：#16 四点当日拍板 → D21~D23 落总台账，T-26 已落库 `dd23b01`、A07 已定稿）；**#15**（网关缓存亲和）改判「待复测裁定」——GUI 重启连发两条看第二条有无缓存读取，裁定前暂缓联系运营方
6. **给主线的需求（T-03 / T-18 / 07-28 衍生，共 8 条）**：① `session.history` 的 `truncated` / `omittedCount` 全链路无展示；② **用户气泡不回显附件**——`beginTurn` 只 emit 文字，用户发完图后时间线上没有任何证据表明图发出去了（Renderer 无法自救）；③ 看门狗把整个上传窗口计入 stall，是未来提高附件上限的硬天花板；④ 协议可选加 `document`(PDF)；⑤ store 的 `sendMessage(text, attachments?)` 无人调用、无覆盖，与 Composer 的 `runSend` 双路径漂移；⑥ **`session.create` 应校验 workspacePath 存在性**（坏路径现在 created+idle、到 send 才泛化报错）；⑦ **resume 重放与存活 live 时间线会视觉双份**（h:* 整段排在 live 前，Host 中途重启场景）；⑧ thinking 空块（带签名无文本）要不要渲染「已思考」指示——待用户拍板。详见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27/07-28 各行。

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）

## Handoff Notes

- **观感对齐的唯一基线（2026-07-28 新增）**：[`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（A01 / A05 / A06 统一产物，用户已验收）。颜色、字体、区域尺寸、工具行与问答卡形态一律以它为准，**业务组件不得自行发明视觉值**；与其冲突时先回台账 D18 / D19 核对，不要就地拍脑袋改。
- 提交习惯：pathspec 提交保留（非强制）；三绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- 同事交接词两处过时勿信：「biome CRLF 行尾债」（C-09 后 lint 0 诊断）、「T-05 Question 等 C-04」（C-04 已 ✅）。
- **`ui/alert.tsx` 的 variant 是 `error` / `warning` / `info` / `success` / `default`，没有 `destructive`**（那个只存在于 button.tsx 与 badge.tsx）。写「借鉴 destructive 错误条」的交接词时要注意这一点，照字面写会编译不过。
- **UI 逻辑一律下沉纯函数**：vitest 是 `node` 环境且 include 只收 `.ts`，`.tsx` 里的逻辑零覆盖。现成范式 `hostStatus.ts` / `fileMention.ts` / `sessionEffortStore.ts` / `historyError.ts` / `sendPreamble.ts` / `hostStderr.ts`。
- **新机器首启注册仓库**：OpenChamber 壳内**仍**无添加仓库 UI（`SKIP_ONBOARDING_GATE=true` 硬编码 + 两处覆盖使旧壳不可达）。当前唯一通路：`pnpm dev -- --open-path=<仓库绝对路径>`（`576f3bd` 起 dev.js 透传 argv；`9331d51` 起首启拉取握手保证不丢）。**2026-07-28 起归 T-24（阻断级）+ T-16 处理，open-questions #9 已关闭**；T-16 要拆的是 `App.tsx:450` 与 `Root.tsx:52-59` 两处强制覆盖，`devFlags.ts:10` 是两者的**共同开关**——翻 `false` 能一并解除，但会连带恢复 onboarding 闸门，故**不作为达成手段**（验证时保持 `true`）。口径以[执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3 T-16 行为准。
- **T-05 / 布局类交接词已整体过期（2026-07-28）**：凡提到「带边框工具卡 + 状态徽章」「按行数截断 + 展开全部」「四区壳」「底部终端 Dock」「右栏三 tab」的旧描述一律作废，以 D18 / D19 / D20 与对齐基线 HTML 为准。（例外：[baseline/module-map](../../baseline/module-map.md) 里的四区表述是**代码现状**，已就地标注 D19 改造去向，不属过期交接词。）
