# Roadmap — OpenChamber Chat Refactor

> 状态口径：✅ 需有证据（hash / 台账行）；「impl done 待 GUI 联调」不算 Done。
> 明细证据一律看台账档案，此处只留一行摘要 + hash。

## Done

**阶段性**
- Phase 0 技术 Go/No-Go：🟡 Conditional Go（加密机项待 T-11 转正，见 [phase0-report](../../../plans/phase0-report.md)）
- **Phase 0A 设计基线补做** 🟡 **部分完成** 2026-07-28——**A01 / A05 / A06** 三项补登并交付，产物统一为 [`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（用户已验收），据此拍板 **D18 / D19 / D20**。**A02 / A03 / A04 仍未立项**（可行性文档 `:997` / `:1005` / `:1013`），且已交付的 A06 依赖列写的正是「A01、A02」——**本 Phase 未整体收口，设计基线尚未全部落地**。A05 只到方案层，代码落地另立 **T-21**；A06 的违规清单另立 **T-23**。状态口径以[总台账](../../../plans/openchamber-chat-refactor-ledger.md) Phase 总览 0A 行为准。
- Phase 1 UI Shell（Mock）✅ `259e863`——**注**：按**旧四区口径**完成，状态不回退；D18/D19 后的重做归 T-21 / T-22，计入 Phase 4。
- Phase 2 Runtime Vertical Slice ✅（目标闭环 + 打包链 + Question/Resume 全超额完成；唯 stream-json fallback 后置为 C-11 机动）

**主线 C-xx（全部完成，明细见[主线台账](../../../plans/ledger-claude-mainline.md)）**
- C-01/C-02 打包链 + 自动化验证 `f21fec7` `dbb20be`（M1 自动化半边；GUI 半边=T-10）
- C-03/C-04 Question 桥（spike+实现）`c9522d2`
- C-05 Thinking 探测 + 默认开 `8449e88`
- C-06 Resume 历史重放全链（CP4 协议定稿）`db41f63`
- C-07 Session Index `f6807c9`
- C-08 Store 批处理 + 分桶 `138ccb3` `922d689`
- C-09 测试基建 + lint 恢复绿 `ce5a577` `49a6031`
- C-10 Effort/Plan/Build 探测（结论：仅 xhigh 有实证；plan 非硬只读）。⚠️ 该行的 `output_config.effort` 假设已被 #8 更正为 **SDK 顶层 `Options.effort`**
- C-13 附件桥 `d339f70` · C-14 挂起看门狗 `f87c1cc` · C-15 随包 Node `adc3127`
- D16 vflow 整体移除 `dbb20be` `eac23f7`
- **#8 thinking 形态修正 + effort 协议底座** ✅ 2026-07-27（`{type:'adaptive', display:'summarized'}`；网关实测 thinking 文本 408 字符、真 Host 全链 361 字符；`session.create/send` 加可选 `effort`，未 bump 协议版本；40 文件 364 例三绿）
- **T-07 补强四项 + open-q#7** ✅ 2026-07-27 `0f886a8`（目录可选 +144 条 / `--hidden` 90 条隐藏条目 / 查 `chat` 显示「10/319」/ 同分全序；`searchContent` 反斜杠一并修。含 8 例真跑 ripgrep 集成测试；41 文件 391 例三绿）
- **T-20 Effort 选择器** ✅ 2026-07-27 `4c3f67e`（Renderer→Main→Host 全链；「Default」= 不发 `effort` 键，与 T-20 前行为一致；顺带把存储逻辑下沉为纯函数以绕开 vitest 无 React 渲染器的限制；44 文件 417 例三绿）
- **T-18 Composer 粘贴图片/文件** ✅ 2026-07-27 `703f981`（上限依据经当日重测推翻后按官方硬限制重建；顺带修掉 `runSend` 硬编码 45s 的误判 bug。49 文件 561 例三绿；**GUI 全部待人工点验**。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27「T-18 上限依据重测」「T-18 落地」两行）
- **2026-07-28 GUI 首测暴露链五连修** ✅（用户 Ubuntu 机首次真机点测暴露，全部当日修复）：多轮上下文继承 `eea2f25` · demo 机器路径解绑 `0bd70d5` · Host stderr 可观测性 + 随包 Node win32 守卫 `da9a5da` · open-path 首启拉取握手 + gotTheLock 门 `9331d51` · dev.js argv 透传 + enso→aiclient 归档名 `576f3bd`。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 07-28 六行
- **T-03 收尾：历史读失败 UI** ✅ 2026-07-27 `7a5c2cd`（协议 §7 归口的最后一块：三种契约码分档 severity/文案、`read_failed` 可 Retry，纯函数 `historyError.ts` + 3 例契约往返测试。45 文件 455 例三绿。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27「T-03 收尾」行）
- **2026-07-29「不出窗口」故障闭环** ✅ `d68d3c6`：同事的 show 兜底修复复核有效（本机生效路径 = `did-finish-load`，`ready-to-show` 因无 3D 首帧不提交而从不触发）；**原故障报告根因判错已更正**（`/proc/*/fd` 里 Unix socket 恒显示 `socket:[inode]`，据此判「窗口未创建」不成立）；连带修 `MainWindow.ts` 窗口状态从未恢复的既有 bug + 兜底日志被 electron-log 静音；顺带修 `McpSection.tsx` 嵌套 `<button>`。档案 [`BUG-2026-07-29-no-window.md`](../../../design/BUG-2026-07-29-no-window.md)，明细见[主线台账](../../../plans/ledger-claude-mainline.md) 07-29 第一行
- **2026-07-29 dev 态凭证隔离（`dev.env`）** ✅ `b18ccac`：裸 `node scripts/dev.js` 原会回落开发者本人 `~/.claude` OAuth 登录计费；改为 `scripts/dev.js` 启动期读 `dev.env` 剥离/注入/隔离 `CLAUDE_CONFIG_DIR`，缺文件拒绝启动。**仅覆盖 dev.js 一条路径**（打包版/preview 缺口见 open-q #14），且**零自动化断言**。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 07-29 第二行

**团队 T-xx 已验收**
- T-01 真实数据树 `a01712a` · T-08 Model 选择器 `298e3e6` · T-17 Tool 真实调用 GUI 闭环
- **T-02 Session 生命周期 UI** ✅ `dc727d2` + 修复 `db5116a`（2026-07-26 GUI 复验通过：标题正常显示、空标题回退短码占位符）
- **T-07 Composer @ 文件引用** ✅ `1ff7fc1` + 修复 `db5116a`（2026-07-26 GUI 复验通过：`@src/` 有结果、目录后缀正常渲染）。补强项另列 Next。
- **T-24 新壳「添加仓库」通路** ✅ 实体 `b38017b`（2026-07-29 随 T-21 夹带落库，账实更正 2026-07-29）；**2026-08-04 收尾结项**：双链审计 CONFIRMED（入口 LeftNav 四处 + 目标栏三项 / 拖放整壳落区，HEAD `01be19c`）+ 用户 fresh-profile 模拟实测验收①②③全过（git/非 git 分支门控一并核验）+ 三绿 1902 例；**偏离登记：真机 Windows 打包版未测 → 并入 T-10 清单第 8 项**。明细见主线台账 2026-08-04 T-24 行

**观感对齐批次 · GUI 点验链闭环（第二~八轮，2026-07-30 ~ 2026-08-03）**

> 转 Done 依据 = 本表原定门槛「0-octies 通过后 T-27/T-28/T-19/T-30批1 方可转 Done」：0-octies ①~⑤ 第三轮全过（2026-07-30）、⑥ 失败路径经第四~七轮闭环、⑦~⑩ 各轮未报异议；**第七轮用户验收通过（2026-08-03 原话「验收完毕，没有问题」）**。

- **T-27 Composer 目标栏（D22）** ✅ `e8fb36a`（2026-07-29 落地，Codex 复核 8 项全采纳）——0-octies 门槛达成转 Done。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-07-29 T-27 行
- **T-28 中列状态化布局（D23）** ✅ `4c1e4d7`（2026-07-29 落地，Codex 复核 blocker 卡高已修）——同门槛转 Done。明细见主线台账 2026-07-29 T-28 行
- **T-19 消息队列（运行中解禁输入 + FIFO 排队）** ✅ `1b350ff`（2026-07-30 落地，+100 例）——同门槛转 Done（第三轮第 1 条「排队消息正常」实测确认）；已知代价（后台会话不自动放行/重启队列丢失）均设计如此。明细见主线台账 2026-07-30 T-19 行
- **T-30 观感打磨批1+批2（D25/D26）** ✅ 批1 `3dcd2dc`（2026-07-30）+ 批2 `9e2736b`（2026-08-03，D25 分域字体全量 + Composer 形态三拍板，Opus+Codex 双轨复核 2+4 major 全闭环）——批1 随 0-octies 门槛、批2 第五轮点验无本批异议且五~七轮链闭环，转 Done；**残留 0-nonies ⑪（a09 改后截图回填 + D25 §6.2 五项真机指标，Win10 必测字重）未采集**，留 implementation-status 用户线。明细见主线台账 2026-07-30 T-30 行 + 2026-08-03 行
- **第二~八轮 GUI 点验反馈闭环** ✅ `b159e4a`（二轮九条：授权卡/排队丢失/模型直通/附件回显四项根治 + 网络可见性 + 视觉六项）→ `514560c`（三轮快赢：下拉分域/首句凝练标题/居中残留）→ `cb2d8d7`（四轮：重试双发根治，`sawUserEcho` 幂等权威）→ `6ece6cb`（五轮四项：New 焦点夹/归档关闭语义/对齐/⊕ Attach files）→ `fd55a26`（六轮两项：aaa 文件夹 New 恢复 + 重发双显根治）→ **第七轮验收通过**→ `8109d45`（T-31）→ **第八轮验收通过结项（2026-08-03「点验完毕，没啥问题」）**；测试 1148→1759；各轮明细见主线台账对应行，六轮诊断档 [`2026-08-03-round6-feedback-diagnosis.md`](../../../plans/2026-08-03-round6-feedback-diagnosis.md) 已结项
- **T-31 回复解剖 + 置顶气泡** ✅ `8109d45`（2026-08-03，36 文件 +4712/−318，测试 1593→1759）——回合分组渲染 / 状态读条迁回合头（owner token + send-begin 基线 × `h:` 双守卫）/ `Worked for ⌄` 折过程段（授权强制展开红线）/ CSS sticky 置顶气泡 + scroll-state 3 行截断 / 回合尾 copy / D26④ 满宽补落 / §4.5 撤回；Opus+Codex 双轨对抗复核 + 修复批三轮 + Codex 终验两轮闭环；A07 v5 追记。**第八轮 GUI 点验验收通过转 Done（0-undecies 十一项全过）**。明细见主线台账 2026-08-03 T-31 行
- **T-22 壳结构改造（D19）** ✅ `95a5c04`（2026-07-29 落地）——0-bis 清单随第八轮捆绑表态收口转 Done（二~八轮真机连续使用未报异议）。明细见主线台账 2026-07-29 T-22 行
- **T-05 工具行/问答卡重做（D24）** ✅ `340a59a`（2026-07-30 落地）——0-quinquies 随第八轮捆绑表态收口转 Done；T-31 已重排其挂载结构，点验面被 0-undecies 覆盖。明细见主线台账 2026-07-30 T-05 行
- **T-29 assistant 正文 Markdown 渲染（D26）** ✅ `d320206`+`666c7c3`+`4507df3`+`b08f6ae`（2026-08-04 用户点验验收转 Done；**拍板两项均裁定维持现状：脚注区 13px、六级标题三种视觉档**）——策略层纯函数（F-C1~F-C7）/ shiki 27 语白名单懒加载 / 流式门逐消息即时转正 / 安全五规则零 XSS 面；双轨对抗复核闭环（27 findings / 3 证伪 + verify:security 补格 + Codex 双盲）；点验首轮唯一缺陷（全局 `user-select:none` 下内容不可选中）当轮修复。三绿 1902 例；红线 `chatSessions.ts` 零改动。明细见主线台账 2026-08-04 T-29 三行


**A08 骨架与四 surface 批次 · 第九轮 GUI 点验闭环（2026-08-04 ~ 2026-08-05）**

> 转 Done 依据 = 用户 **2026-08-05** 表态「点验通过，进入下一任务环节」——点验清单 **0-quindecies【合并版】**（T-12~15 / T-23 / T-32 三份合一去重，7 组 24 项）收口。
> **遗留（不阻塞，已另有归口）**：A2 的「Win10 字重真机核验」本机（Linux）不可采集 → 并入 [T-10 打包版清单](../../../plans/t10-packaged-gui-checklist.md)；macOS 无标题栏行 → 无 usage 展示的既有缺口维持 backlog。
> **随验收生效的追认**：`Ctrl/Cmd+1..4` 改绑 1=git 2=files 3=context 4=terminal · `Ctrl/Cmd+B` 侧栏收展 · 四死按钮走删除支 · 72% 假 usage 环撤除。

- **T-12 / T-13 / T-14 / T-15 四 surface** —— **2026-08-04 八提交一次性落地**（S0 壳前置 `f3183f1` + T-14 `2e7353a` + T-13 `f9439d6` + T-12 `701d008` + T-15 `11616e5` + 注册收口 `61f79db` + A08 适配快捷键 `cb4de4f` + 双轨对抗复核修复批 `45c3b63`——1 blocker + 8 major + 8 minor 全闭环；A08 临时基线正式化随行，对照表见 [`2026-08-04-t12-15-surface-spec.md`](../../../plans/2026-08-04-t12-15-surface-spec.md) §7）。按本表口径「impl done 待 GUI 联调」不算 Done——**点验清单 0-tredecies**（[implementation-status](./implementation-status.md) 用户线，含 Ctrl+B 改绑追认项），通过后转 Done。三绿 117 文件 2171 例。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-04 四 surface 行。 **✅ 2026-08-05 点验验收转 Done。**
- **T-23 存量违规清理** —— **2026-08-04 代码落地 `bfc087f`**（五违规清零走删除支 + P-19/P-22 随批 + A06 矩阵逐行结清；双轨对抗复核 + Codex 终验闭环，三绿 118 文件 2180 例）。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单（**已并入 0-quindecies【合并版】**）（implementation-status 用户线，含删除/撤环/单行化追认），通过后转 Done。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-04 T-23 行。 **✅ 2026-08-05 点验验收转 Done。**
- **T-32 右栏骨架回归 A08**（**D27** + open-q #28，2026-08-05 当日立项/裁定/施工）—— **五切片落地** `fbb45fe`（S1 tab 条四项）+ `8df9341`（S2 顶栏贯通 + Rail 联动收展）+ `4f4fb52`（S3 **editor 回中列**）+ `2f46fa6`（S4 降级梯与手动覆盖），S5 归档随行。规格 [`2026-08-05-t32-a08-shell-regression-spec.md`](../../../plans/2026-08-05-t32-a08-shell-regression-spec.md)；A08 §7 十一项逐条回标（§7-bis）：**回归 7 项 / 维持豁免 4 项**。**三处有据偏离**：阈值改内容行 1300/964 · 不新增 `panelOpen` 字段 · editor 保留多 tab。**首轮点验修复批四提交** `fef5ce3`+`8014bef`+`c424128`+`a0c9b90`（m1~m8，其中 **4 条为本任务自引入的回归**；被推翻的原设计与通用坑见[规格 §9](../../../plans/2026-08-05-t32-a08-shell-regression-spec.md) 追记）。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单 **0-quindecies【合并版】**（与 T-12~15 / T-23 两份合并去重，7 组 24 项），**用户 2026-08-05 收尾表态「暂时没啥问题」属阶段性收手、非逐项验收**，通过后三者一并转 Done。三绿 121 文件 2223 例。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-05 T-32 行。 **✅ 2026-08-05 点验验收转 Done；三绿 121 文件 2223 例。**
## In Progress

- **决策落库（2026-07-28）**：D18 / D19 / D20 已进[总台账](../../../plans/openchamber-chat-refactor-ledger.md)；ARD 十二节连带改口（清单见 [ARD 修订头](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md)，2026-07-28 复验轮更正：原写「§1/§4/§7/§8/§9/§11/§13」七节已过期）、执行计划任务表（T-05 重写 + T-12~T-16 重定义 + 新增 T-21~T-25 / C-17）、本树四文件同步中。**落完才动代码**。
- **T-04**：🔴 **重新阻塞——卡在网关**（2026-07-28 用户实测无卡后探针实证，各 2/2）：GUI 默认 `sonnet` 在本网关返回**空文本 thinking 块**（不理会 `display:'summarized'`）；#8 验证过的网关默认模型今日**确定性 400「thinking 块格式无效」**。渲染链逐门核查无 bug，app 侧无可修。等网关侧处理（open-questions #5/#8），修复后仍须在**新发起轮次**验证（旧 fixture 的 153 个 thinking 块文本为空）。
- **T-06**：实现已落地（`0f3a8da` 等），**唯一完全未测**的任务，网关恢复后可直接补。
- **CP2（M1 确认）**：材料已齐（C-02 自动化 25 项 PASS），等 T-10 点验合并汇报。
- **T-21 Flexoki 主题 + 全等宽字体栈**：代码已提交 `b38017b`（2026-07-29，31 文件）。按本表口径「impl done 待 GUI 联调」不算 Done —— 用户 2026-07-29 已点测大部分，**中英混排三场景 + 6 处 `normal-case` 豁免的目视验收尚未出截图**（open-q #10），且验收须在**默认主题**下进行（`sync-terminal` 混色属 open-q #12 未裁定边界，不是 T-21 引入的 bug）。截图入台账后转 Done。
- **T-16 新旧壳开关成熟化** —— **2026-08-05 落地 `fd57ebf`**：拆掉**四处**强制覆盖（任务书原记两处，`App/useAppKeyboardShortcuts.ts` 与 `App/hooks/useSettingsState.ts` 两处为 07-28 之后新增的同形 OR）；`SKIP_ONBOARDING_GATE` 维持 `true` 未动。**两处执行裁定待用户追认**：store 默认值 `false`→`true`（存量 profile 零影响，只避免新 profile 落进旧壳）·新增同步镜像 `shellPreferenceMirror.ts` 消除异步水合的一帧闪壳（范式同 `stores/shellLayout.ts`）。防回归 `shellSwitchStatic.test.ts` + `shellPreferenceMirror.test.ts`。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单 **0-sexdecies**（三条验收全在 GUI 面），通过后转 Done。三绿 123 文件 2231 例。明细见[主线台账](../../../plans/ledger-claude-mainline.md) 2026-08-05 T-16 行。
- ~~T-12 / T-13 / T-14 / T-15 四 surface~~ —— **2026-08-05 第九轮点验验收后转 Done**（见 Done「A08 骨架与四 surface 批次」块）。
- ~~T-32 右栏骨架回归 A08~~ —— **2026-08-05 第九轮点验验收后转 Done**（见同上块）。
- ~~T-23 存量违规清理~~ —— **2026-08-05 第九轮点验验收后转 Done**（见同上块）。
- ~~T-29 Markdown 渲染~~ —— **2026-08-04 用户点验验收后转 Done**（见 Done「观感对齐批次」块；拍板两项均维持现状）。
- ~~T-22 / T-05 / T-31~~ —— **2026-08-03 第八轮验收后全部转 Done**（见 Done「观感对齐批次」块）。

## Next

> 2026-07-28 重排：开发线以观感对齐为主轴，用户点测线并行。
> **顺序权威 = [执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3**（起步顺序 + §8 风险 9：「T-24 是阻断级缺口，不排进 Phase 4 尾巴」）。执行计划口径全序为
> **T-24 → T-21 → T-22 → T-05 → T-12/T-13/T-14/T-15 → T-23（与 surface 并行消化）→ T-16 → T-25**；本表只列近端五项，四种 surface 与 T-16 / T-25 见 Deferred。
> 本表顺序不得晚于执行计划口径；要后移 T-24 必须先改执行计划并在总台账追加说明。
> **开发项（1~5）的任务定义、数值与 `file:line` 只存在于执行计划 §3 任务表**，此处不复制（避免同一口径三处漂移）；6~8 为用户点测/验收项，不受此限。

0. ~~**T-16 新旧壳开关成熟化**~~ —— **✅ 2026-08-05 代码落地 `fd57ebf`，转 In Progress 待 GUI 点验（0-sexdecies）**（原文见 In Progress 块）。
1. ~~**T-24 新壳「添加仓库」通路**（阻断级，排第一）~~ —— **✅ 2026-08-04 收尾结项转 Done**（见 Done「团队 T-xx 已验收」块；真机 Windows 项并入 T-10 清单第 8 项）。原文保留供参考：补新壳入口并把窗口拖放 ref 绑到新壳，解开「新机器只能靠 `--open-path` argv 注册」的死结。→ 执行计划 §3 T-24 行
2. ~~**T-21 Flexoki 主题 + 全等宽字体栈**~~ —— **代码已落 `b38017b`，转 In Progress 等 GUI 截图验收**（原文保留供参考）：`globals.css` 语义 token 重写 + 四个新 token + `docs/design-system.md` 同步改写；原色硬编码清理**只覆盖新壳 chat / workspace-shell 两个目录**（**不是全仓唯一**，旧模块归后置的 T-25，清单与实测面见执行计划）。**开工前先结 open-q #11**（根字号 14→16），验收含中英混排实测截图（#10）；终端与 Monaco 边界外（#12）。→ 执行计划 §3 T-21 行
3. ~~**T-22 壳结构改造：三列 + 44px 导轨 + surface 模型**（D19）~~ —— **代码已落 `95a5c04`，转 In Progress 等 GUI 点验**（原文保留供参考）：建 surface 注册表并**删除 `BottomDock.tsx`**，布局与 surface 选择逻辑下沉纯函数。→ 执行计划 §3 T-22 行
4. ~~**T-05 重做：Tool 行 + Question 卡**~~ —— **代码已落 `340a59a`（D24 Cursor 口径），转 In Progress 等 GUI 点验**（原文保留供参考）：无边框单行工具行 + 就地冻结问答卡（D20）；store 侧冻结已实现，本任务只补 UI。→ 执行计划 §3 T-05 行
5. ~~**T-23 存量违规清理**~~ —— **✅ 2026-08-04 代码落地 `bfc087f` 转 In Progress 待 GUI 点验（0-quattuordecies）**。原文保留供参考：死按钮与假 usage 环逐项接线，或 `disabled` + Tooltip 明写状态（落地裁定走删除支，口径补记执行计划 §3 T-23 行）。
6. **GUI 统一点测**（用户人工）：多轮上下文回归 / T-04 thinking 卡 / T-07 补强三项 / T-20 Effort 选择器 / T-06 补测 / T-03 历史读失败提示 / **T-18 粘贴附件（本轮 100% 待人工测）**——**均已就绪，无待写代码**，点验清单见 [implementation-status](./implementation-status.md) Active TODO「用户线」。
7. **T-10 打包版 GUI 点验**（用户；[清单](../../../plans/t10-packaged-gui-checklist.md)，产物含随包 Node 141MB）→ CP2 汇报。
8. **T-11 M2 加密机现场验收**（等 T-10；六项含白名单⑥）→ CP5，Phase 0 转正式 Go。
9. **T-33 / T-34 / T-35 三条能力缺失**（2026-08-05 由 [multi-agent plan](../multi-agent/roadmap.md) **正式平移主线并分配节点**）——三条都只用 Claude 直连链上**已有**的数据，与「接不接 ACP」这个根问题互不依赖，压在后置的支线下会被一并冻住，故归主线：
   - **T-33 网络重试横幅**（0.5d）——数据已在 `chatSessions.ts:85` 的 `retry`，只差 UI；三条里最便宜、用户最快能感知（「不是卡死了，在重试」）
   - **T-34 子 agent 实况**（1.5d）——**唯一有产品价值增量的一条**。开 `forwardSubagentText`（`sdk.d.ts:1619`，现装 0.3.218 已有）+ 协议加可选字段透传 `parent_tool_use_id`；拉起/传输/交互 SDK 与既有桥全包，**真正的工作量只在「显示」**（Task 行下如何挂子 agent 的文本/思考/工具）。**已知限制**：resume 重放的 `HistoryBlock` 无子 agent 归属，当场嵌套、重开变平铺——与 D20 问答卡同一协议缺口，根治须扩历史协议（C-17，后置）
   - **T-35 Host stderr 进 UI**（0.5d）——`claudeRuntime.ts:677` 已有 `[cli-stderr]`，开事件 + 脱敏；诊断向，平时用不到、出事时省很多时间
   → 任务定义与验收标准的权威 = 执行计划 §3 各行；出处见 [multi-agent/topics/acp-decision.md](../multi-agent/topics/acp-decision.md) 末表（三条走 ACP 都只会更绕）

## Deferred

- **Phase 4 surface 化（D19 重定义，全部依赖 T-22 壳结构）**——**2026-08-05 更新：T-12~T-15 四项已点验验收转 Done，T-16 已出列进 Next；本块残余 = 后置 6 surface**：
  - T-12 **git surface**（原「右栏 Git 面板」）· T-14 **context surface**（原「右栏 Context 面板」，只放真实数据）
  - T-13 **editor surface**（原「右栏 Files 面板」）——**2026-07-28 解冻**：此前因布局未定而冻结，D19 定下骨架后放行，队列在 T-22 之后；F5 反馈（边看代码边看分析）由「Main 阅读栏 + ContextPanel 并列」直接满足
  - T-15 **terminal surface**（原「底部 Terminal Dock 接真终端」）——**重定义**：终端是 ContextPanel 的一种 surface、可提升为覆盖 Main 全视图，**不再往底部 Dock 接线**；`BottomDock.tsx` 随 D19 废弃并在 T-22 删除
  - 其余 6 种 surface（`pr / diff / plan / notes / browser / preview`）保留注册位，本轮不实现
  - ~~T-16 新旧壳开关成熟化~~ —— **2026-08-05 出 Deferred 进 Next 第 1 项**（前置 T-24 已 Done、T-12~T-15 已点验通过，开发线现行第一顺位）
- **C-17 问答进历史协议**（D20 偏离的解除前置，后置）：扩 `HistoryBlock` 联合类型加 question/permission + Host 把问答写进历史 + store 补 case；做完才可重评是否切到 OpenChamber 的「回答后消失 + 历史只读 Q/A」。属主线协议变更，走协议变更纪律。（编号跳过 C-16——已被 spike 文件占用）
- **T-25 旧模块原色硬编码清理**（2026-07-28 审查后立项，依赖 T-21）——T-21 覆盖范围之外的旧模块原色工具类，按 Flexoki 语义 token 逐目录分批替换（实测面与目录清单见执行计划 §3 T-25 行）。
- C-11 stream-json fallback（机动，SDK 路线阻塞时提级）
- C-12 旧路径收缩 + 千 block 压测（Phase 5；虚拟化决策依赖压测数据）
- ~~T-19 消息队列~~（提案内容待用户落库，落库前不排期）—— **已复活并代码落地 `1b350ff`，转 In Progress**（2026-07-30，open-q #18 拍板 A 触发；原「待用户落库」前提已由用户拍板与团队研究共同满足）；**2026-08-03 已转 Done**（见 Done「观感对齐批次」块）
- T-09 补验：真触发「Node 缺失」场景（想法见 [ideas](../../ideas/inbox.md)）
