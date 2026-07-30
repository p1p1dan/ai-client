# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。

- **Current Phase**: **Phase 0A 基线部分补做（A01 / A05 / A06）→ 观感对齐改造**（2026-07-28 转向）。这三项产品设计基线此前只在可行性文档的候选任务池、从未进执行计划或台账，而下游 F05/H01/H09 已按它们施工——这是「观感不到位 + 死按钮泛滥 + 布局反复卡壳」的同一根因，本日补做并落库（D18 / D19 / D20）。⚠️ **Phase 0A 整体仍 🟡 未收口**：A02 / A03 / A04 仍未立项，且已交付的 A06 依赖列写的正是「A01、A02」（口径以总台账 Phase 总览 0A 行为准）。Phase 3 Chat MVP 的剩余点测与网关阻塞并行不变。
- **Last Landed**:
  - 文档（2026-07-28）：**A01 / A05 / A06 基线补登交付**，产物统一为 [`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（用户已验收）；三条裁定落库 **[D18](../../../plans/openchamber-chat-refactor-ledger.md)（视觉，撤销 D6）/ D19（布局骨架，撤销 D15）/ D20（问答归宿，偏离登记）**。
  - 代码（2026-07-28）：GUI 首测暴露链五连修——**多轮上下文继承** `eea2f25` · **demo 机器路径解绑** `0bd70d5` · **Host stderr 可观测性 + win32 守卫** `da9a5da` · **open-path 拉取握手 + 单实例门** `9331d51` · **dev.js argv 透传 + enso 归档名** `576f3bd`（明细见主线台账 2026-07-28 六行）
  - 文档（2026-07-29 四批）：**D24 落库——工具行/问答卡形态源改判为 Cursor**（用户在 Cursor 触发两类组件演示并存图，5 图入库 refs/cursor-20260729/）：工具行=动词开头灰阶单行+聚合展开；问答卡=Questions 折叠条/A-B-C-D 字母行/Skip+Continue/**回答后冻结 Answers 卡（与 D20 合流）**。D23 的「时间线内部不动」边界句作废；**T-05 待二次重写验收标准**（开工前、按 A07 v2）；A07 v2 补两屏制作中。「点击历史消息重新编辑」用户标注待定、仅归档
  - 文档（2026-07-29 三批）：**A07 中列 Cursor 观感基线 ✅ 用户正式定稿(2026-07-29,v3)** [`docs/design/a07-cursor-composer-alignment.html`](../../../design/a07-cursor-composer-alignment.html)——六屏 × Flexoki 亮暗;§08 五件事已全部裁定,工具行交互口径(Read 可点击/Grep 悬浮命中列表)与 main/master chip 已烧入;**T-05 验收标准已按定稿重写(执行计划 §3 T-05 行现行权威段)**，token 与 globals.css 机器校验一致；**待用户浏览器验收**（重点：Tab 栏带/不带、运行位置只读 chip），通过后 T-27/T-28 方可施工
  - 文档（2026-07-29）：**侧栏两层化 + Composer 目标栏合并设计**落库 [`docs/plans/2026-07-29-sidebar-composer-target-bar-design.md`](../../../plans/2026-07-29-sidebar-composer-target-bar-design.md)（双独立方案 Opus/Codex 收敛合并；用户 2026-07-29 拍板方向）——核心裁定：侧栏「文件夹→对话」两层、Workspace 降为运行目标属性、分支下拉=worktree 选择器**禁 in-place checkout**、subagent 后置（Path B 先行）；**T-24 账实不符已更正**（实体随 `b38017b` 夹带落库）。呈现层四点待拍板 → open-q **#16**，拍板后 D21/D22 落总台账、T-26/T-27 立项
  - 代码（2026-07-29 五批）：**T-27 Composer 目标栏落地** `e8fb36a` —— Composer 卡上方三控件（D22/A07 档位）：文件夹下拉（Recents+分组+四动作全真实接线）、分支下拉=worktree 选择器（禁 checkout 守卫钉死、getBranches 仅对话框内、gitEnabled 门控非 git 不出现）、运行位置只读指示器（缺数据隐藏）；三档规则纯函数 `composerTarget.ts` + `chatSessionActions.ts`（retarget/fork）+ fork 附件草稿携带；删 MainHeader Folder/Host 死按钮。**Codex 对抗复核 5 blocker+3 major 全采纳零驳回**（runtimeIdentity 入 fork 判据 / pending 携源会话 / 发送门统一 cwd / gitEnabled 前置）。+70 例（总 784）。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-27 行
  - 代码（2026-07-29 四批）：**T-22 壳结构改造落地** `95a5c04` —— 四区壳改三列 + 44px 导轨 + surface 模型（D19）：Sidebar 280 可拖 280–500、阅读栏 48/64rem（LayoutGrid 接线，消化一枚 A06 死按钮）、ContextPanel 380–1400 按 surface 记忆宽 + 提升覆盖 Main、Rail 仅 git 圆点（真数据无轮询）、**删 BottomDock/RightDock**；布局纯函数 `shellLayoutModel.ts`/`surfaceRegistry.ts` 断言先行（+79 例）+ persist store `aiclient-shell-layout`。Codex 对抗复核（恢复同行位）1 blocker 驳回（验收⑤口径=代码零引用，docs 历史叙述不改）+ 采纳 5 项当场修（pointer 会话绑定/动画期基线/卸载复位/内层列保宽/NaN 防护）。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-22 行
  - 代码（2026-07-29 三批）：**T-26 侧栏两层化落地** `dd23b01` —— 侧栏「文件夹→会话」两层平铺（D21/D21-A）：`sidebarTree.ts` 纯函数断言先行（14 例）、全量分支 chip（main/master 显实际分支名，`ChatWorkspace.branch` 纯可选加法）、Recent 段 48h 口径（7 条+Show more，折叠持久化）、`selectedWorkspaceId` 移除（选择权移交 T-27 目标栏）。对抗复核 1 blocker——sync 桥变更签名缺 `branch`，冷启动 chip 全灭——已修（`workspaceTreeSignature` + 回归测试）；ARD §4 数据层级文字块按 D21 连带改写。**GUI 点验待用户**。明细见主线台账 2026-07-29 T-26 行
  - 代码（2026-07-29 二批）：**缓存排查闭环** `3622c19` —— 对话每条消息全量重写缓存的双根因坐实：**主因网关无会话亲和（app 无可修，open-q #15 待用户找运营方）**；次因 Host `session.resume` 丢 model/effort（Host 重启后静默换回 cli 默认模型）已修，+3 例钉死 resume→query() 下发。故障档案 [`docs/design/BUG-2026-07-29-prompt-cache-rewrite.md`](../../../design/BUG-2026-07-29-prompt-cache-rewrite.md)，探针 `spikes/cache-affinity-probe.mjs` / `capture-proxy.mjs` 入库
  - 代码（2026-07-29）：**窗口链** `d68d3c6` · **凭证隔离** `b18ccac` —— **「不出窗口」故障闭环**——同事的 show 兜底复核有效（本机实际生效路径 = `did-finish-load`，`ready-to-show` 从不触发），**原故障报告根因判错已更正**；连带修 `MainWindow.ts` 窗口状态从未恢复的既有 bug + 兜底日志被 electron-log 静音；顺带修 `McpSection.tsx` 嵌套 `<button>`。**dev 态凭证隔离**——`scripts/dev.js` 读 `dev.env` 剥离/注入/隔离，裸启动不再回落开发者本机 `~/.claude` 登录。明细见主线台账 2026-07-29 两行
- **Last Verified**: 2026-07-28 Linux 三绿——typecheck 干净 / lint 609 文件 0 诊断 / vitest **51 文件 590 例**（3 失败=Windows-only 基线）
  - **2026-07-29 复核（`d68d3c6` / `b18ccac` / T-21 `b38017b` 合并态）**：typecheck 干净 / lint **615 文件 0 诊断** / vitest **54 文件 618 例**（同 3 例 Windows-only 失败）。**例数未增 = 本轮未补测试**，`dev.js` 凭证逻辑目前零自动化断言（见 open-q **#14**）。
  - **2026-07-29 二批复核（`3622c19` 合并态）**：typecheck 干净 / lint 615 文件 0 诊断 / vitest **54 文件 621 例**（+3，同 3 例 Windows-only 失败）。
  - **2026-07-29 三批复核（T-26 `dd23b01` 合并态）**：typecheck 干净 / lint **620 文件 0 诊断** / vitest **55 文件 635 例**（+1 文件 +14 例，同 3 例 Windows-only 失败）。
  - **2026-07-29 四批复核（T-22 `95a5c04` 合并态）**：typecheck 干净 / lint **631 文件 0 诊断** / vitest **57 文件 714 例**（+2 文件 +79 例，同 3 例 Windows-only 失败）。
  - **2026-07-29 五批复核（T-27 `e8fb36a` 合并态）**：typecheck 干净 / lint **643 文件 0 诊断** / vitest **61 文件 784 例**（+4 文件 +70 例，同 3 例 Windows-only 失败）。
  - **T-21 复核口径（2026-07-28 审查回合，代码已于 2026-07-29 提交 `b38017b`）**：typecheck 干净 / lint **615 文件 0 诊断** / vitest **54 文件 618 例**（同 3 例 Windows-only 失败）。
    lint 文件数从 613 涨到 615 是**新增文件**所致（`docs/design/phase0a-openchamber-alignment.html` 基线产物 + `src/renderer/lib/__tests__/ghosttyTheme.test.ts`），**`biome.json` 未改**——
    施工中一度加过 `"!docs/design"` 排除项来绕开该 HTML 的 13 条诊断，这违反「不得改 lint 配置变绿」，已撤销：改为就地修（9 条 `useArrowFunction` 自动修 + 2 条 `noImportantStyles`、2 条 `noUnknownProperty` 加带理由的 `biome-ignore`，后者是 `corner-shape` 这个 Biome 尚无定义的 CSS Backgrounds 4 属性）。
- **Next Target**（2026-07-29 二次修订，D21~D23 已拍板落库）: **T-24 收尾**（S0：全新机器 GUI 实测 + 台账补登，代码已随 `b38017b` 落库）→ **T-28**（中列状态化布局；**T-27 已落库 `e8fb36a`，A07 已定稿，前置全清**）→ **T-05 重做** → **T-23**。**A07 基线（中列 Cursor 观感）与 T-26/T-22 并行制作，用户验收后 T-27/T-28 观感部分方可施工**。T-21 已落库 `b38017b`。用户侧 GUI 点测（含**多轮上下文**必测项）与 **T-04 网关阻塞**、**#15 缓存复测裁定**并行。

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
