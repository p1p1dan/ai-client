# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。2026-08-03 前的逐批 Landed/Verified 摘要与已结项点验清单原文已归档 [history/2026-0728-0803-archive.md](./history/2026-0728-0803-archive.md)。

- **Current Phase**: **Phase 0A 基线部分补做（A01 / A05 / A06）→ 观感对齐改造**（2026-07-28 转向）。这三项产品设计基线此前只在可行性文档的候选任务池、从未进执行计划或台账，而下游 F05/H01/H09 已按它们施工——这是「观感不到位 + 死按钮泛滥 + 布局反复卡壳」的同一根因，本日补做并落库（D18 / D19 / D20）。⚠️ **Phase 0A 整体仍 🟡 未收口**：A02 / A03 / A04 仍未立项，且已交付的 A06 依赖列写的正是「A01、A02」（口径以总台账 Phase 总览 0A 行为准）。Phase 3 Chat MVP 的剩余点测与网关阻塞并行不变。
- **Last Landed**:
  - 代码（2026-08-05，最新）：**context surface 打开即崩修复 `42b692c`**——根因 `ContextSurfaceView.tsx:82-84` 的消息桶 selector `state.messages[id] ?? []` 每次新建 `[]`，zustand v5 经 `useSyncExternalStore` 以 `Object.is` 比对订阅前后快照 → passive effect 内 `forceStoreRerender` 自激至嵌套更新上限；冷启/新会话（无消息桶）必然命中，**与热更残留无关**。修法：selector 只回稳定切片，兜底移到模块级常量 `EMPTY_MESSAGES`（沿用 `MessageTimeline.tsx:173` + `messageQueue.ts:72` 既有约定）。防回归：新增 `stores/__tests__/storeSelectorStability.test.ts` 静态不变量（TS AST，`deadControlsStatic` 范式）扫全 renderer 的 `use*Store(selector)` 返回位；`getState()` 非订阅读取排除在外。全仓扫描确认此前仅此一处违规。**resume 优先项② 就此结清**；明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-05 行
  - 代码（2026-08-04，最新）：**T-23 存量违规清理 `bfc087f`**——MainHeader Browser/Window 死按钮删除 + 72% 假环撤除（真数据在 WindowTitleBar 胶囊；macOS 无标题栏行缺口显性化记 backlog）+ 顶栏单行 h-9（三顶条齐平）+ 标题 h1 15px semibold（Win10 无 500 故弃审计建议的 medium）+ 工作区 chip（项目名 + Tooltip 披露项目·工作区·Ident 路径，hover/focus 双可达，窄窗可收缩）；LeftNav Menu/Help 删除；deadControlsStatic TS AST 正向不变量 + 具名 pin；i18n 补 4 键。双轨对抗复核（Opus 1 blocker+5 major+8 minor / Codex 1 major+3 minor）+ Codex 终验（1 major chip 挤压 + 1 minor 扫描器 AST 化）全闭环；审计 P-19~P-23 五行回标（两处偏离注）。红线零改动。**GUI 点验待用户（0-quattuordecies，用户线）**；A06 矩阵已逐行结清（验收③）。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-04 T-23 行
  - 代码（2026-08-04 八提交）：**T-12/T-13/T-14/T-15 四 surface 一次性落地 + S0 壳前置 + A08 临时基线正式化 + 快捷键** `f3183f1`+`2e7353a`+`f9439d6`+`701d008`+`11616e5`+`61f79db`+`cb4de4f`+`45c3b63`——三路勘察 → 双轨设计（Opus+Codex 互不见，合并规格落库 [`2026-08-04-t12-15-surface-spec.md`](../../../plans/2026-08-04-t12-15-surface-spec.md)）→ 四路并发施工（共享接线文件所有权收归编排者）→ 双轨对抗复核（Codex 3maj+2min / Opus 1blocker+5maj+12min，互补显著）→ 修复批全闭环。keep-alive 挂载契约（切 surface pty 不死）/ Escape 作用域 P0 / gitQueryKeys 工厂根治 win/mac 圆点不刷 / permissionMode 协议可选加法 / A08 对照表（被取代 11 项、采纳适配 10 项）。红线 chatSessions 零改动。**GUI 点验待用户（0-tredecies，用户线）**；明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-04 四 surface 行
  - 验收（2026-08-04）：**T-24 收尾结项转 Done**（S0 零代码改动）——施工前双链审计 CONFIRMED（入口链 LeftNav 四处 + 目标栏三项 / 拖放整壳落区，HEAD `01be19c`，Workflow 2 追链 + opus 对抗核验）；用户本机 fresh-profile 模拟实测（`AICLIENT_PROFILE=t24fresh`，不带 `--open-path`）验收①②③全过，另核 git/非 git 目录目标栏分支门控吻合 T-27 口径；**偏离登记：真机 Windows 打包版未测 → 并入 T-10 清单第 8 项**。明细见主线台账 2026-08-04 T-24 行
  - 验收（2026-08-04）：**T-29 GUI 点验用户验收通过**（首轮「目前展示效果都不错还可以」+ 唯一缺陷内容不可选中当轮修复 `b08f6ae` + 收尾表态「本阶段收尾。脚注和标题不用改，先这样吧」）——**T-29 转 Done**；**拍板两项均维持现状**：① 脚注区 13px ② 六级标题三种视觉档。0-duodecies 随轮收口
  - 代码+文档（2026-08-04）：**T-29 Markdown 渲染代码结项 `d320206` + `666c7c3` + `4507df3`**（前两 hash 曾提交并推送但状态文档漏记，本日补登；第三个为双轨对抗复核修复批 13 文件 +2,104/−142）——策略层/shiki 高亮/流式门/安全五规则主体 + 复核裁定修复：流式门下沉纯函数 `deriveStreamingBlockIds` 根治 major 会话级误伤（新回合曾抹掉全会话历史回答的 Markdown）、门单调化、(c) 收窄为逐消息即时转正；F-C7 三重高亮预算 + 64 项 LRU；`__proto__` 守卫与 href 主机名加固；共享 TS 编译器 API `stripComments` 换掉全仓四份假绿拷贝。双轨复核闭环（Workflow 27 findings / 3 证伪 + verify:security 补格 + Codex 双盲收活）。红线零改动。**GUI 点验待用户（0-duodecies，用户线）**。明细见主线台账 2026-08-04 T-29 行
  - 验收（2026-08-03 第八轮）：**T-31 GUI 点验用户验收通过**（原话「点验完毕，没啥问题」）——0-undecies 十一项全过，**T-31 转 Done**；0-bis / 0-quinquies 随本轮捆绑表态收口，**T-22 / T-05 转 Done**（二~八轮真机连续使用未报异议 + 本轮无异议；T-31 已重排 T-05 挂载结构，其点验面被 0-undecies 覆盖）。§9 六项推荐值与 D26④ 满宽等编排者执行裁定全部获追认
  - 代码+文档（2026-08-03 四批）：**T-31 回复解剖 + 置顶气泡落地 `8109d45`**（36 文件 +4712/−318，测试 1593→1759）——回合层纯推导 + 时间线回合化渲染 / 状态读条迁回合头（turnSendStatus 单槽 owner token + send-begin 基线 × `h:` 前缀双守卫）/ `Worked for Ns ⌄` 折过程段（授权卡强制展开安全红线）/ 置顶气泡 CSS sticky + scroll-state 钉住 3 行截断（η 实测支持；lightningcss 吞规则 → 独立 `styles/scroll-state.css`）/ 尾部条 模型·相对时间·copy / **D26④ 满宽补落（T-30 批2 账实更正）** / §4.5 撤回。Opus+Codex 双轨对抗复核（Opus 2 blocker + 4 major；Codex 4 major 含独有 owner 竞态）+ 修复批三轮 + Codex 终验两轮全闭环；A07 v5 追记 + design-system 连带。红线零改动。**✅ 第八轮 GUI 点验验收通过（2026-08-03）**。明细见主线台账 2026-08-03 T-31 行
  - 验收（2026-08-03）：**第七轮 GUI 点验用户验收通过**（原话「验收完毕，没有问题」）——第六轮两项与全部复核批修复闭环，诊断档结项；实测范围含 aaa 文件夹 New / "+ new chat" / 分支 chip 归属 / 失败退回重发无重复气泡 / 同文连发保留 / 附件与归档关闭对齐。第五轮清单 0-decies 与第四轮失败路径顺延项就此关闭；**0-octies 门槛达成 → T-27/T-28/T-19/T-30批1 转 Done**（见 roadmap）。点验期间一次「No repository registered」经查为 dev server 带病热更新残留态，非代码回归（诊断档附注）
  - 更早批次（2026-07-28 ~ 2026-08-03 三批：五连修/T-21/T-22/T-26/T-27/T-28/T-05/T-19/T-30 批1+批2/第二~六轮点验修复等）：摘要原文见 [history 归档](./history/2026-0728-0803-archive.md)，明细见[主线台账](../../../plans/ledger-claude-mainline.md)各行
- **Last Verified**:
  - **2026-08-05 context surface 修复复核（HEAD `42b692c`，逐门串行）**：typecheck 干净 / lint **763 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **119 文件 2182 例**（较 T-23 基线 118 文件 2180 例 +1 文件 +2 例只增；同 3 例 Windows-only 失败）。
  - **2026-08-04 T-23 复核（HEAD `bfc087f`）**：typecheck 干净 / lint **762 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **118 文件 2180 例**（较四 surface 批 2171 基线 +1 文件 +9 例只增；同 3 例 Windows-only 失败）。
  - **2026-08-04 四 surface 批复核（HEAD `45c3b63`，逐门串行）**：typecheck 干净 / lint **761 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **117 文件 2171 例**（较 1902 基线 +16 文件 +269 例只增；同 3 例 Windows-only 失败）。⚠️ 全量 vitest 曾三连挂死：新增测试经 hook 拖入 settings store import 图在 node 环境死锁 + 僵尸 worker 连环卡池——纯函数下沉独立模块（`App/mainTabShortcutGate.ts`）根治，「UI 逻辑一律下沉纯函数」纪律的又一实证。
  - **2026-08-04 T-24 收尾态实测（HEAD `01be19c`，逐门串行）**：typecheck 干净 / lint **728 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **101 文件 1902 例**（较 4507df3 登记基线 +1 例=b08f6ae 所增；同 3 例 Windows-only 失败）。本任务零代码改动。
  - **2026-08-04 T-29 代码结项态实测（HEAD `4507df3`）**：typecheck 干净 / lint **0 错误**（29w+3i 既有 a08 豁免）/ vitest **101 文件 1901 例**（较 666c7c3 合并态 1838 例 +1 文件 +63 例全为本批；同 3 例 Windows-only 失败）/ `pnpm build` 成功且 **20 个 shiki 语法异步 chunk 全在 27 语白名单内**。⚠️ **本机内存有限（用户 2026-08-04 明示）：门禁必须逐门串行跑，禁止链式合跑或与子代理/后台任务并行**——前次四门链式合跑被 OOM 杀（exit 137）。
  - **2026-08-03 T-29 工作区态实测（未提交，施工后复核前）**：typecheck 干净 / lint **724 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **98 文件 1813 例**（+1 文件 +54 例；同 3 例 Windows-only 失败）。
  - **2026-08-03 四批复核（T-31 `8109d45` 合并态）**：typecheck 干净 / lint **718 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **97 文件 1759 例**（+7 文件 +166 例；同 3 例 Windows-only 失败）/ `pnpm build` 成功且产物含 `@container scroll-state(stuck: top)` 规则（lightningcss 管线绕行有效性的产物级验证）。
  - **2026-08-03 三批复核（第六轮修复 `fd55a26` 合并态，T-31 开工前基线实测）**：typecheck 干净 / lint **703 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **90 文件 1593 例**（+2 文件 +56 例；同 3 例 Windows-only 失败）。
  - 更早复核记录（2026-07-28 基线 51 文件 590 例起，全程只增）与 T-21 复核口径注记：见 [history 归档](./history/2026-0728-0803-archive.md)
- **Next Target**（2026-08-05 十五次修订）：**resume 两项优先项均已结清**——① 用户 2026-08-05 开题「决定软件走向的核心问题」= **codeg 参照下的多 agent 方向**，已立新 plan root [`plans/multi-agent`](../multi-agent/README.md)（用户裁定并行推进：新线先做 **ACP + Codex 可行性 spike**，确认可行再并入主线）；② context surface 报错已定位并修复 `42b692c`。**本线新增开发项**：**T-32 右栏骨架回归 A08（D27，2026-08-05 拍板）**——同日 open-q #28 已裁定关闭，**editor 回中列已定**（`chat ║ editor` 并排，右栏 files tab 降为纯文件树），右栏 tab 扩四项、Rail 仅收起时渲染、恢复顶栏贯通与降级梯；量级 **3d**，其顶栏贯通要求与 T-23 刚落的单行 h-9 口径直接冲突须一并重定。**开发线顺序（用户 2026-08-05 同日裁定：先做 T-32，multi-agent 支线后置）：T-32 → T-16**。T-32 先于 T-16 的理由：T-16 是新旧壳开关成熟化，壳骨架未定型就做开关，T-32 落地后还要重验一遍。原「下一项 **T-16 新旧壳开关**」（两处强制覆盖见 Handoff Notes；前置 T-24 已备）。**T-23 impl done 待 GUI 点验（0-quattuordecies，含删除/撤环/单行化追认）**；**T-12~T-15 impl done 待 GUI 点验（0-tredecies）**，快捷键 Ctrl+B 改绑待追认。**残留**：T-24 真机 Windows 打包版（并入 T-10 清单第 8 项）；0-nonies ⑪ 真机指标（Win10 必测字重）；网络环境复测（open-q **#22**）；授权 FIX 3（open-q **#23**）；**T-04 网关阻塞**与 **#15 缓存复测裁定**并行。**backlog**：CI 出包缺口（build.yml `workflow_dispatch` 无 installer artifact 上传，≈6 行补法已备）；历史侧回合时长源；`ran N command(s)` 聚合复议（需 A07 基线修订）；T-29 转入四项（全局 `color-scheme` / 三 HighlighterCore 单例 / monacoSetup 懒化 / `isTurnActive` 死导出）；**本批新增**：useGitChangeCount 的 useRepositoryStore 全局单槽副作用小票；sessionRuntimeFacts 重启会话权限行永「未上报」（已知限制）；gitQueryKeys fileDiff path 参数未归一化（注释登记）；隐藏终端随他人 surface 宽度重排 / compact 跨组拖放静默 no-op（均登记不修）；**T-23 撤环连带**：macOS 无标题栏行 → 全 app 无 usage 展示（既有缺口显性化）。

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

> **顺序权威 = [执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3**；任务定义、数值与 `file:line` 只存在于该表，此处只留「ID + 一行目标」。
> 2026-07-28 重排版开发线原文（T-24~T-23 六项，均已落库或后置）见 [history 归档](./history/2026-0728-0803-archive.md)。

### 开发线（按序）

1. ~~**T-29 Markdown 渲染**（D26）~~ —— **✅ 2026-08-04 用户点验验收转 Done**（`d320206`+`666c7c3`+`4507df3`+`b08f6ae`；拍板两项维持现状：脚注 13px / 标题三档）。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-04 T-29 三行
2. ~~**T-24 收尾**（S0，不改代码）~~ —— **✅ 2026-08-04 收尾结项转 Done**（fresh-profile 模拟实测全过；真机 Windows 项并入 T-10 清单第 8 项）。明细见主线台账 2026-08-04 T-24 行
3. ~~**T-12 / T-13 / T-14 / T-15 四 surface**~~ —— **✅ 2026-08-04 八提交一次性落地（S0+四 surface+收口+快捷键+复核修复批，`f3183f1`..`45c3b63`），A08 正式化随行（对照表见规格 §7）。impl done 待 GUI 点验（0-tredecies），点验通过方转 Done**。→ 主线台账 2026-08-04 四 surface 行
4. ~~**T-23 存量违规清理**~~ —— **✅ 2026-08-04 代码落地 `bfc087f`（裁定走删除支 + P-19/P-22 随批 + A06 矩阵结清），impl done 待 GUI 点验（0-quattuordecies），点验通过方转 Done**。→ 主线台账 2026-08-04 T-23 行
5. **T-32 右栏骨架回归 A08**（**D27**，2026-08-05 立项，同日 open-q #28 裁定后开工阻塞解除）——**editor 回中列**（`chat ║ editor` 并排 + `ed-grip` + editor head，右栏 files tab 降纯文件树）· 右栏 tab 扩四项 · Rail 仅收起时渲染 · 顶栏贯通 · 恢复 1580/1244 降级梯。三项豁免维持现状；editor 保留多 tab。**量级 3d，与 T-23 顶栏单行 h-9 口径冲突须一并重定**（0-quattuordecies ③ 的单行化追认项随之作废，并入 T-32 点验）。→ 执行计划 §3 T-32 行

> **开发线现行顺序（用户 2026-08-05 裁定）= T-32 → T-16**；T-25（旧模块原色清理，依赖 T-21）仍后置，归 [roadmap Deferred](./roadmap.md)。**multi-agent 支线后置**（原定并行，同日改判为「先把现有 Claude 客户端任务大致完成」）。

### 用户线（点测 / 待拍板，与开发线并行）

0. **✅ 点验清单 0 ~ 0-undecies 全部结项**（第二~八轮，2026-07-30 ~ 2026-08-03；唯 **0-nonies ⑪ 真机指标未采集**仍待用户），清单原文见 [history 归档](./history/2026-0728-0803-archive.md)。
0-duodecies. **✅ T-29 点验清单结项（2026-08-04 当日收口）**——首轮反馈「展示效果都不错」+ 唯一缺陷（内容不可选中）当轮修复 `b08f6ae` + 用户收尾表态整体收口；**拍板① 脚注 13px / 拍板② 标题三档均裁定维持现状**。清单原文（①~⑫）保留供回归参照：
   ① 流式期正文纯文本、完成后切 Markdown 无抖动无滚动跳变；**回合内中途完成的消息应立即转 Markdown**（修复批新口径），不等整回合结束；
   ② 授权/提问（waiting_*）等待期间，已完成消息的 Markdown 不回退纯文本（门单调）；
   ③ 标题/列表/行内代码/围栏代码/链接/表格全形态渲染；**拍板②**：六级标题有意仅三种视觉档（全 15px 内以字重×颜色分层），可否接受；
   ④ 亮暗翻转：代码块重高亮无残色闪烁；再翻回来应命中缓存即时呈现；
   ⑤ 链接悬停为下划线加深（非文字变淡）；点击外开系统浏览器不夺窗；相对路径 / `javascript:` 链接渲染为纯文本不可点；
   ⑥ `![alt]` 图片渲染为惰性 alt 芯片，DevTools Network 面板**零外部请求**（防信标）；
   ⑦ 回合 copy 按钮拷出 **raw markdown 原文**（非渲染后文本）；
   ⑧ 空围栏（``` 后直接 ```）渲染为空代码框而非灰色行内胶囊；
   ⑨ 任务列表复选框：暗色下应为主题色小方块（非原生浅色控件）；
   ⑩ 超预算围栏（>800 行 / >64K 字符 / 单行 >2000 字符，例：整行 base64 或单行 JSON）走无高亮纯文本 `<pre>`，滚动不卡顿；
   ⑪ GFM 脚注：`[^1]` 引用号渲染为纯文本数字（有意不成链，安全裁定成文于代码注释），脚注体仍在文末小字区；**拍板①**：脚注区 13px 与 D25「Markdown 全 15px」的张力，可否接受。
   ⑫（首轮反馈修复的复核项）正文/代码块/用户气泡/工具行输出均可鼠标选中并 Ctrl+C 复制；回合头、`Worked for` 行、按钮等壳层仍不可选（与全 app 一致）。
0-tredecies. **四 surface（T-12~T-15）+ 快捷键 GUI 点验清单（2026-08-04 施工，全部待点验）**：
   ① Rail 四枚图标单选互斥、再点同枚收起；`Ctrl/Cmd+1..4` 直达 context/git/editor/terminal、`Ctrl/Cmd+J` 面板开关、`` Ctrl/Cmd+` `` 打开终端；**`Ctrl/Cmd+B` 已改绑侧栏收展（A08 原义 chat 显隐随中列 editor 被取代）——请追认**；
   ② context surface：字段与实际会话一致（路径/类型/分支/模型/推理档/运行状态/待答授权/已发附件/runtimeIdentity），无任何假值占位；**新发起的会话**权限策略行应显示 default（Host 事件真值），**重启前的旧会话**显示「Permission policy not reported」（已知限制非 bug）；**✅ 2026-08-05 已修复 `42b692c`**（原「打开报错」为 zustand selector 引用不稳定导致的无限渲染，非热更残留；根因与防回归见主线台账 2026-08-05 行）——本条改为**验证修复**：打开 context surface 不再白屏报错，且新会话（无消息桶）与有历史的会话都能正常渲染；
   ③ git surface：changed/staged 分组与 stage/unstage；commit 可用（含 AI 生成消息、Cmd/Ctrl+Enter）；点文件行进 diff（窄面板自动 inline、拖宽约 >700 恢复并排）；头部 Maximize2 提升为两列（左列表+右 diff）；**commit 后列表清空且 Rail git 圆点熄灭**（win/mac 曾有不刷缺陷已修）；
   ④ editor surface：Rail 进入可浏览/编辑/保存；对话里点工具行 Read 行、Grep/Glob 命中行 → 跳转 editor 并定位；`@` 引用 chip 点击跳转；**文件树重命名中按 Esc 不应关面板**；脏 tab 关闭有 save/dontSave/cancel 确认；面板 380–1400 可拖，>704 树与编辑器并排；
   ⑤ terminal surface：**跑 `sleep 30` → 切 git → 切回，进程仍在、输出连续**（keep-alive 核心验收）；vim/less 里按 Esc 不关面板；切 Workspace A→B→A 恢复 A 的终端组；expanded 分屏全功能、标准态 compact 分屏禁用带提示（+N 徽章披露隐藏组）；关面板再开终端不死；
   ⑥ 跨面回归：Composer/弹窗的 Escape 原语义不回归；中文输入法合成态下快捷键不误触；旧壳本轮不可达（T-16 未做）无需回归。
   ⑦（**已拍板 2026-08-04：维持露出**——用户原话「终端既然都实现了，那就实装呗」；零代码改动，`registeredOnly` 维持 `false`，第 ⑤ 条保持全量点验）～原议题存档：terminal surface 是否本阶段露出：用户表示「终端暂时可以不实装，目前只供 Claude」。编排者评估：不点即零开销（keep-alive 仅首次激活后生效，未用时 xterm/pty/渲染链均不存在），成本形态与旧壳一致；该终端是用户工作区 shell，非 Agent 供应通道，与「只供 Claude」不冲突。**若裁定隐藏**：`surfaceRegistry.ts` terminal 行 `registeredOnly` 翻 `true` 一行即藏（持久化消毒自动清旧选中态，代码保留随时启用）。裁定隐藏则本清单第 ⑤ 条降级为「启用时再验」。
0-quattuordecies. **T-23 存量违规清理点验清单（2026-08-04 施工，待点验；①~③为裁定追认项）**：
   ① **追认·删除四死按钮**——顶栏 Browser/Window、侧栏顶部汉堡 Menu、侧栏底部 Help 均直接删除而非 disabled+Tooltip（Browser/Window 对应后置 surface，未来入口在右侧 Rail；Menu 全仓无语义；Help 无内容可指，GitHub/DevTools 在标题栏 More 菜单）；
   ② **追认·撤除 72% 假 usage 环**——真实今日成本在标题栏右上用户胶囊（$x.xx）；macOS 无该行属既有缺口已记 backlog；
   ③ **追认·顶栏单行化**——第二行「项目 · 工作区 · 完整路径」删除；顶栏 h-9 与左右两列顶条三条分隔线应齐平无台阶；
   ④ 标题 15px semibold：应明显比正文醒目（**Win10 真机必核**：若标题与正文粗细无差即字重回退 bug）；长标题截断、悬停显完整标题；
   ⑤ 工作区 chip：标题右侧黄色文件夹图标 + 项目名；悬停或 Tab 聚焦出 tooltip（「项目 · 工作区」+ 等宽路径）；无会话/无工作区时 chip 隐藏、标题显「未选择会话」；
   ⑥ 窄窗挤压：拖窄窗口 + 开面板，chip 先缩至图标、标题保底若干字符、右侧两按钮永不被裁；
   ⑦ 顶栏两按钮 tooltip 为常量名（「宽阅读栏」「上下文面板」）+ 按下态高亮，功能照常；
   ⑧ 侧栏：顶部仅剩收展按钮；底部「设置」独占整行可点；收展/设置文案已中文化。
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
5. ~~T-19 消息队列提案——等用户落库~~（**已过期**：T-19 已复活、落地并于第八轮前转 Done，见 roadmap）
5-bis. ~~布局呈现层四点拍板~~（**2026-07-29 已收口**：#16 四点当日拍板 → D21~D23 落总台账，T-26 已落库 `dd23b01`、A07 已定稿）；**#15**（网关缓存亲和）改判「待复测裁定」——GUI 重启连发两条看第二条有无缓存读取，裁定前暂缓联系运营方
6. **给主线的需求（T-03 / T-18 / 07-28 衍生，共 8 条）**：① `session.history` 的 `truncated` / `omittedCount` 全链路无展示；② **用户气泡不回显附件**——`beginTurn` 只 emit 文字，用户发完图后时间线上没有任何证据表明图发出去了（Renderer 无法自救）；③ 看门狗把整个上传窗口计入 stall，是未来提高附件上限的硬天花板；④ 协议可选加 `document`(PDF)；⑤ store 的 `sendMessage(text, attachments?)` 无人调用、无覆盖，与 Composer 的 `runSend` 双路径漂移；⑥ **`session.create` 应校验 workspacePath 存在性**（坏路径现在 created+idle、到 send 才泛化报错）；⑦ ~~resume 重放与存活 live 时间线会视觉双份~~（**已根治**：第六轮 `fd55a26` historyReplayMerge 三重护栏）；⑧ thinking 空块（带签名无文本）要不要渲染「已思考」指示——待用户拍板。详见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27/07-28 各行。

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
- **新机器首启注册仓库（2026-08-04 T-24 结项后口径）**：新壳已有完整添加仓库通路——LeftNav 四处入口 + Composer 目标栏三项 + 整壳拖放落区（明细见主线台账 2026-08-04 T-24 行）；`--open-path` argv（`576f3bd`/`9331d51`）仍可用但**不再是唯一通路**。open-questions #9 已关闭；T-16 要拆的是 `App.tsx:450` 与 `Root.tsx:52-59` 两处强制覆盖，`devFlags.ts:10` 是两者的**共同开关**——翻 `false` 能一并解除，但会连带恢复 onboarding 闸门，故**不作为达成手段**（验证时保持 `true`）。口径以[执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3 T-16 行为准。
- **T-05 / 布局类交接词已整体过期（2026-07-28）**：凡提到「带边框工具卡 + 状态徽章」「按行数截断 + 展开全部」「四区壳」「底部终端 Dock」「右栏三 tab」的旧描述一律作废，以 D18 / D19 / D20 与对齐基线 HTML 为准。（例外：[baseline/module-map](../../baseline/module-map.md) 里的四区表述是**代码现状**，已就地标注 D19 改造去向，不属过期交接词。）
