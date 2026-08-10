# 归档 · roadmap / open-questions / 注册表行 快照（2026-08-08 瘦身前）

> 2026-08-08 规划树整理归档时整段快照移入（archive-only，不再更新）。含三部分：
> ① [roadmap.md](../roadmap.md) 全文（Done 各批长摘要原文——瘦身后 roadmap 只留一行式）；
> ② [open-questions.md](../open-questions.md) 全文（含已关闭条目 #2/#10/#11/#16/#17/#18/#25/#28 的
> 结项推导原文——#17 为 T-34 as-built + C-17 归口所取代）；
> ③ [plantree 根 README](../../../README.md) 注册表行原文（2026-08-05 版长叙事）。
> **快照含当时仍活动的条目，现行状态一律以活动文件为准。**
> **链接注**：快照内相对链接已按归档位置整体调深一级（仅路径前缀，正文逐字未改）。

---

## ① roadmap.md 全文快照

# Roadmap — OpenChamber Chat Refactor

> 状态口径：✅ 需有证据（hash / 台账行）；「impl done 待 GUI 联调」不算 Done。
> 明细证据一律看台账档案，此处只留一行摘要 + hash。

## Done

**阶段性**
- Phase 0 技术 Go/No-Go：🟡 Conditional Go（加密机项待 T-11 转正，见 [phase0-report](../../../../plans/phase0-report.md)）
- **Phase 0A 设计基线补做** 🟡 **部分完成** 2026-07-28——**A01 / A05 / A06** 三项补登并交付，产物统一为 [`docs/design/phase0a-openchamber-alignment.html`](../../../../design/phase0a-openchamber-alignment.html)（用户已验收），据此拍板 **D18 / D19 / D20**。**A02 / A03 / A04 仍未立项**（可行性文档 `:997` / `:1005` / `:1013`），且已交付的 A06 依赖列写的正是「A01、A02」——**本 Phase 未整体收口，设计基线尚未全部落地**。A05 只到方案层，代码落地另立 **T-21**；A06 的违规清单另立 **T-23**。状态口径以[总台账](../../../../plans/openchamber-chat-refactor-ledger.md) Phase 总览 0A 行为准。
- Phase 1 UI Shell（Mock）✅ `259e863`——**注**：按**旧四区口径**完成，状态不回退；D18/D19 后的重做归 T-21 / T-22，计入 Phase 4。
- Phase 2 Runtime Vertical Slice ✅（目标闭环 + 打包链 + Question/Resume 全超额完成；唯 stream-json fallback 后置为 C-11 机动）

**主线 C-xx（全部完成，明细见[主线台账](../../../../plans/ledger-claude-mainline.md)）**
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
- **T-18 Composer 粘贴图片/文件** ✅ 2026-07-27 `703f981`（上限依据经当日重测推翻后按官方硬限制重建；顺带修掉 `runSend` 硬编码 45s 的误判 bug。49 文件 561 例三绿；**GUI 全部待人工点验**。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 07-27「T-18 上限依据重测」「T-18 落地」两行）
- **2026-07-28 GUI 首测暴露链五连修** ✅（用户 Ubuntu 机首次真机点测暴露，全部当日修复）：多轮上下文继承 `eea2f25` · demo 机器路径解绑 `0bd70d5` · Host stderr 可观测性 + 随包 Node win32 守卫 `da9a5da` · open-path 首启拉取握手 + gotTheLock 门 `9331d51` · dev.js argv 透传 + enso→aiclient 归档名 `576f3bd`。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 07-28 六行
- **T-03 收尾：历史读失败 UI** ✅ 2026-07-27 `7a5c2cd`（协议 §7 归口的最后一块：三种契约码分档 severity/文案、`read_failed` 可 Retry，纯函数 `historyError.ts` + 3 例契约往返测试。45 文件 455 例三绿。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 07-27「T-03 收尾」行）
- **2026-07-29「不出窗口」故障闭环** ✅ `d68d3c6`：同事的 show 兜底修复复核有效（本机生效路径 = `did-finish-load`，`ready-to-show` 因无 3D 首帧不提交而从不触发）；**原故障报告根因判错已更正**（`/proc/*/fd` 里 Unix socket 恒显示 `socket:[inode]`，据此判「窗口未创建」不成立）；连带修 `MainWindow.ts` 窗口状态从未恢复的既有 bug + 兜底日志被 electron-log 静音；顺带修 `McpSection.tsx` 嵌套 `<button>`。档案 [`BUG-2026-07-29-no-window.md`](../../../../design/BUG-2026-07-29-no-window.md)，明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 07-29 第一行
- **2026-07-29 dev 态凭证隔离（`dev.env`）** ✅ `b18ccac`：裸 `node scripts/dev.js` 原会回落开发者本人 `~/.claude` OAuth 登录计费；改为 `scripts/dev.js` 启动期读 `dev.env` 剥离/注入/隔离 `CLAUDE_CONFIG_DIR`，缺文件拒绝启动。**仅覆盖 dev.js 一条路径**（打包版/preview 缺口见 open-q #14），且**零自动化断言**。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 07-29 第二行

**团队 T-xx 已验收**
- T-01 真实数据树 `a01712a` · T-08 Model 选择器 `298e3e6` · T-17 Tool 真实调用 GUI 闭环
- **T-02 Session 生命周期 UI** ✅ `dc727d2` + 修复 `db5116a`（2026-07-26 GUI 复验通过：标题正常显示、空标题回退短码占位符）
- **T-07 Composer @ 文件引用** ✅ `1ff7fc1` + 修复 `db5116a`（2026-07-26 GUI 复验通过：`@src/` 有结果、目录后缀正常渲染）。补强项另列 Next。
- **T-24 新壳「添加仓库」通路** ✅ 实体 `b38017b`（2026-07-29 随 T-21 夹带落库，账实更正 2026-07-29）；**2026-08-04 收尾结项**：双链审计 CONFIRMED（入口 LeftNav 四处 + 目标栏三项 / 拖放整壳落区，HEAD `01be19c`）+ 用户 fresh-profile 模拟实测验收①②③全过（git/非 git 分支门控一并核验）+ 三绿 1902 例；**偏离登记：真机 Windows 打包版未测 → 并入 T-10 清单第 8 项**。明细见主线台账 2026-08-04 T-24 行

**观感对齐批次 · GUI 点验链闭环（第二~八轮，2026-07-30 ~ 2026-08-03）**

> 转 Done 依据 = 本表原定门槛「0-octies 通过后 T-27/T-28/T-19/T-30批1 方可转 Done」：0-octies ①~⑤ 第三轮全过（2026-07-30）、⑥ 失败路径经第四~七轮闭环、⑦~⑩ 各轮未报异议；**第七轮用户验收通过（2026-08-03 原话「验收完毕，没有问题」）**。

- **T-27 Composer 目标栏（D22）** ✅ `e8fb36a`（2026-07-29 落地，Codex 复核 8 项全采纳）——0-octies 门槛达成转 Done。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 2026-07-29 T-27 行
- **T-28 中列状态化布局（D23）** ✅ `4c1e4d7`（2026-07-29 落地，Codex 复核 blocker 卡高已修）——同门槛转 Done。明细见主线台账 2026-07-29 T-28 行
- **T-19 消息队列（运行中解禁输入 + FIFO 排队）** ✅ `1b350ff`（2026-07-30 落地，+100 例）——同门槛转 Done（第三轮第 1 条「排队消息正常」实测确认）；已知代价（后台会话不自动放行/重启队列丢失）均设计如此。明细见主线台账 2026-07-30 T-19 行
- **T-30 观感打磨批1+批2（D25/D26）** ✅ 批1 `3dcd2dc`（2026-07-30）+ 批2 `9e2736b`（2026-08-03，D25 分域字体全量 + Composer 形态三拍板，Opus+Codex 双轨复核 2+4 major 全闭环）——批1 随 0-octies 门槛、批2 第五轮点验无本批异议且五~七轮链闭环，转 Done；**残留 0-nonies ⑪（a09 改后截图回填 + D25 §6.2 五项真机指标，Win10 必测字重）未采集**，留 implementation-status 用户线。明细见主线台账 2026-07-30 T-30 行 + 2026-08-03 行
- **第二~八轮 GUI 点验反馈闭环** ✅ `b159e4a`（二轮九条：授权卡/排队丢失/模型直通/附件回显四项根治 + 网络可见性 + 视觉六项）→ `514560c`（三轮快赢：下拉分域/首句凝练标题/居中残留）→ `cb2d8d7`（四轮：重试双发根治，`sawUserEcho` 幂等权威）→ `6ece6cb`（五轮四项：New 焦点夹/归档关闭语义/对齐/⊕ Attach files）→ `fd55a26`（六轮两项：aaa 文件夹 New 恢复 + 重发双显根治）→ **第七轮验收通过**→ `8109d45`（T-31）→ **第八轮验收通过结项（2026-08-03「点验完毕，没啥问题」）**；测试 1148→1759；各轮明细见主线台账对应行，六轮诊断档 [`2026-08-03-round6-feedback-diagnosis.md`](../../../../plans/2026-08-03-round6-feedback-diagnosis.md) 已结项
- **T-31 回复解剖 + 置顶气泡** ✅ `8109d45`（2026-08-03，36 文件 +4712/−318，测试 1593→1759）——回合分组渲染 / 状态读条迁回合头（owner token + send-begin 基线 × `h:` 双守卫）/ `Worked for ⌄` 折过程段（授权强制展开红线）/ CSS sticky 置顶气泡 + scroll-state 3 行截断 / 回合尾 copy / D26④ 满宽补落 / §4.5 撤回；Opus+Codex 双轨对抗复核 + 修复批三轮 + Codex 终验两轮闭环；A07 v5 追记。**第八轮 GUI 点验验收通过转 Done（0-undecies 十一项全过）**。明细见主线台账 2026-08-03 T-31 行
- **T-22 壳结构改造（D19）** ✅ `95a5c04`（2026-07-29 落地）——0-bis 清单随第八轮捆绑表态收口转 Done（二~八轮真机连续使用未报异议）。明细见主线台账 2026-07-29 T-22 行
- **T-05 工具行/问答卡重做（D24）** ✅ `340a59a`（2026-07-30 落地）——0-quinquies 随第八轮捆绑表态收口转 Done；T-31 已重排其挂载结构，点验面被 0-undecies 覆盖。明细见主线台账 2026-07-30 T-05 行
- **T-29 assistant 正文 Markdown 渲染（D26）** ✅ `d320206`+`666c7c3`+`4507df3`+`b08f6ae`（2026-08-04 用户点验验收转 Done；**拍板两项均裁定维持现状：脚注区 13px、六级标题三种视觉档**）——策略层纯函数（F-C1~F-C7）/ shiki 27 语白名单懒加载 / 流式门逐消息即时转正 / 安全五规则零 XSS 面；双轨对抗复核闭环（27 findings / 3 证伪 + verify:security 补格 + Codex 双盲）；点验首轮唯一缺陷（全局 `user-select:none` 下内容不可选中）当轮修复。三绿 1902 例；红线 `chatSessions.ts` 零改动。明细见主线台账 2026-08-04 T-29 三行


**A08 骨架与四 surface 批次 · 第九轮 GUI 点验闭环（2026-08-04 ~ 2026-08-05）**

> 转 Done 依据 = 用户 **2026-08-05** 表态「点验通过，进入下一任务环节」——点验清单 **0-quindecies【合并版】**（T-12~15 / T-23 / T-32 三份合一去重，7 组 24 项）收口。
> **遗留（不阻塞，已另有归口）**：A2 的「Win10 字重真机核验」本机（Linux）不可采集 → 并入 [T-10 打包版清单](../../../../plans/t10-packaged-gui-checklist.md)；macOS 无标题栏行 → 无 usage 展示的既有缺口维持 backlog。
> **随验收生效的追认**：`Ctrl/Cmd+1..4` 改绑 1=git 2=files 3=context 4=terminal · `Ctrl/Cmd+B` 侧栏收展 · 四死按钮走删除支 · 72% 假 usage 环撤除。

- **T-12 / T-13 / T-14 / T-15 四 surface** —— **2026-08-04 八提交一次性落地**（S0 壳前置 `f3183f1` + T-14 `2e7353a` + T-13 `f9439d6` + T-12 `701d008` + T-15 `11616e5` + 注册收口 `61f79db` + A08 适配快捷键 `cb4de4f` + 双轨对抗复核修复批 `45c3b63`——1 blocker + 8 major + 8 minor 全闭环；A08 临时基线正式化随行，对照表见 [`2026-08-04-t12-15-surface-spec.md`](../../../../plans/2026-08-04-t12-15-surface-spec.md) §7）。按本表口径「impl done 待 GUI 联调」不算 Done——**点验清单 0-tredecies**（[implementation-status](../implementation-status.md) 用户线，含 Ctrl+B 改绑追认项），通过后转 Done。三绿 117 文件 2171 例。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 2026-08-04 四 surface 行。 **✅ 2026-08-05 点验验收转 Done。**
- **T-23 存量违规清理** —— **2026-08-04 代码落地 `bfc087f`**（五违规清零走删除支 + P-19/P-22 随批 + A06 矩阵逐行结清；双轨对抗复核 + Codex 终验闭环，三绿 118 文件 2180 例）。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单（**已并入 0-quindecies【合并版】**）（implementation-status 用户线，含删除/撤环/单行化追认），通过后转 Done。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 2026-08-04 T-23 行。 **✅ 2026-08-05 点验验收转 Done。**
- **T-32 右栏骨架回归 A08**（**D27** + open-q #28，2026-08-05 当日立项/裁定/施工）—— **五切片落地** `fbb45fe`（S1 tab 条四项）+ `8df9341`（S2 顶栏贯通 + Rail 联动收展）+ `4f4fb52`（S3 **editor 回中列**）+ `2f46fa6`（S4 降级梯与手动覆盖），S5 归档随行。规格 [`2026-08-05-t32-a08-shell-regression-spec.md`](../../../../plans/2026-08-05-t32-a08-shell-regression-spec.md)；A08 §7 十一项逐条回标（§7-bis）：**回归 7 项 / 维持豁免 4 项**。**三处有据偏离**：阈值改内容行 1300/964 · 不新增 `panelOpen` 字段 · editor 保留多 tab。**首轮点验修复批四提交** `fef5ce3`+`8014bef`+`c424128`+`a0c9b90`（m1~m8，其中 **4 条为本任务自引入的回归**；被推翻的原设计与通用坑见[规格 §9](../../../../plans/2026-08-05-t32-a08-shell-regression-spec.md) 追记）。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单 **0-quindecies【合并版】**（与 T-12~15 / T-23 两份合并去重，7 组 24 项），**用户 2026-08-05 收尾表态「暂时没啥问题」属阶段性收手、非逐项验收**，通过后三者一并转 Done。三绿 121 文件 2223 例。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 2026-08-05 T-32 行。 **✅ 2026-08-05 点验验收转 Done；三绿 121 文件 2223 例。**
## In Progress

- **决策落库（2026-07-28）**：D18 / D19 / D20 已进[总台账](../../../../plans/openchamber-chat-refactor-ledger.md)；ARD 十二节连带改口（清单见 [ARD 修订头](../../../../plans/2026-07-23-openchamber-chat-refactor-ard.md)，2026-07-28 复验轮更正：原写「§1/§4/§7/§8/§9/§11/§13」七节已过期）、执行计划任务表（T-05 重写 + T-12~T-16 重定义 + 新增 T-21~T-25 / C-17）、本树四文件同步中。**落完才动代码**。
- **T-04**：🔴 **重新阻塞——卡在网关**（2026-07-28 用户实测无卡后探针实证，各 2/2）：GUI 默认 `sonnet` 在本网关返回**空文本 thinking 块**（不理会 `display:'summarized'`）；#8 验证过的网关默认模型今日**确定性 400「thinking 块格式无效」**。渲染链逐门核查无 bug，app 侧无可修。等网关侧处理（open-questions #5/#8），修复后仍须在**新发起轮次**验证（旧 fixture 的 153 个 thinking 块文本为空）。
- **T-06**：实现已落地（`0f3a8da` 等），**唯一完全未测**的任务，网关恢复后可直接补。
- **CP2（M1 确认）**：材料已齐（C-02 自动化 25 项 PASS），等 T-10 点验合并汇报。
- **T-21 Flexoki 主题 + 全等宽字体栈**：代码已提交 `b38017b`（2026-07-29，31 文件）。按本表口径「impl done 待 GUI 联调」不算 Done —— 用户 2026-07-29 已点测大部分，**中英混排三场景 + 6 处 `normal-case` 豁免的目视验收尚未出截图**（open-q #10），且验收须在**默认主题**下进行（`sync-terminal` 混色属 open-q #12 未裁定边界，不是 T-21 引入的 bug）。截图入台账后转 Done。
- **T-16 新旧壳开关成熟化** —— **2026-08-05 落地 `fd57ebf`**：拆掉**四处**强制覆盖（任务书原记两处，`App/useAppKeyboardShortcuts.ts` 与 `App/hooks/useSettingsState.ts` 两处为 07-28 之后新增的同形 OR）；`SKIP_ONBOARDING_GATE` 维持 `true` 未动。**两处执行裁定待用户追认**：store 默认值 `false`→`true`（存量 profile 零影响，只避免新 profile 落进旧壳）·新增同步镜像 `shellPreferenceMirror.ts` 消除异步水合的一帧闪壳（范式同 `stores/shellLayout.ts`）。防回归 `shellSwitchStatic.test.ts` + `shellPreferenceMirror.test.ts`。按本表口径「impl done 待 GUI 联调」不算 Done——点验清单 **0-sexdecies**（三条验收全在 GUI 面），通过后转 Done。三绿 123 文件 2231 例。明细见[主线台账](../../../../plans/ledger-claude-mainline.md) 2026-08-05 T-16 行。 **✅ 2026-08-06 第十二轮点验验收转 Done（两处执行裁定随验收追认）。**
- ~~T-12 / T-13 / T-14 / T-15 四 surface~~ —— **2026-08-05 第九轮点验验收后转 Done**（见 Done「A08 骨架与四 surface 批次」块）。
- ~~T-32 右栏骨架回归 A08~~ —— **2026-08-05 第九轮点验验收后转 Done**（见同上块）。
- ~~T-23 存量违规清理~~ —— **2026-08-05 第九轮点验验收后转 Done**（见同上块）。
- ~~T-29 Markdown 渲染~~ —— **2026-08-04 用户点验验收后转 Done**（见 Done「观感对齐批次」块；拍板两项均维持现状）。
- ~~T-22 / T-05 / T-31~~ —— **2026-08-03 第八轮验收后全部转 Done**（见 Done「观感对齐批次」块）。

## Next

> 2026-07-28 重排：开发线以观感对齐为主轴，用户点测线并行。
> **顺序权威 = [执行计划](../../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3**（起步顺序 + §8 风险 9：「T-24 是阻断级缺口，不排进 Phase 4 尾巴」）。执行计划口径全序为
> **T-24 → T-21 → T-22 → T-05 → T-12/T-13/T-14/T-15 → T-23（与 surface 并行消化）→ T-16 → T-25**；本表只列近端五项，四种 surface 与 T-16 / T-25 见 Deferred。
> 本表顺序不得晚于执行计划口径；要后移 T-24 必须先改执行计划并在总台账追加说明。
> **开发项（1~5）的任务定义、数值与 `file:line` 只存在于执行计划 §3 任务表**，此处不复制（避免同一口径三处漂移）；6~8 为用户点测/验收项，不受此限。

0. ~~**T-16 新旧壳开关成熟化**~~ —— **✅ 2026-08-05 代码落地 `fd57ebf`；2026-08-06 第十二轮点验验收转 Done**（原文见 In Progress 块）。
1. ~~**T-24 新壳「添加仓库」通路**（阻断级，排第一）~~ —— **✅ 2026-08-04 收尾结项转 Done**（见 Done「团队 T-xx 已验收」块；真机 Windows 项并入 T-10 清单第 8 项）。原文保留供参考：补新壳入口并把窗口拖放 ref 绑到新壳，解开「新机器只能靠 `--open-path` argv 注册」的死结。→ 执行计划 §3 T-24 行
2. ~~**T-21 Flexoki 主题 + 全等宽字体栈**~~ —— **代码已落 `b38017b`，转 In Progress 等 GUI 截图验收**（原文保留供参考）：`globals.css` 语义 token 重写 + 四个新 token + `docs/design-system.md` 同步改写；原色硬编码清理**只覆盖新壳 chat / workspace-shell 两个目录**（**不是全仓唯一**，旧模块归后置的 T-25，清单与实测面见执行计划）。**开工前先结 open-q #11**（根字号 14→16），验收含中英混排实测截图（#10）；终端与 Monaco 边界外（#12）。→ 执行计划 §3 T-21 行
3. ~~**T-22 壳结构改造：三列 + 44px 导轨 + surface 模型**（D19）~~ —— **代码已落 `95a5c04`，转 In Progress 等 GUI 点验**（原文保留供参考）：建 surface 注册表并**删除 `BottomDock.tsx`**，布局与 surface 选择逻辑下沉纯函数。→ 执行计划 §3 T-22 行
4. ~~**T-05 重做：Tool 行 + Question 卡**~~ —— **代码已落 `340a59a`（D24 Cursor 口径），转 In Progress 等 GUI 点验**（原文保留供参考）：无边框单行工具行 + 就地冻结问答卡（D20）；store 侧冻结已实现，本任务只补 UI。→ 执行计划 §3 T-05 行
5. ~~**T-23 存量违规清理**~~ —— **✅ 2026-08-04 代码落地 `bfc087f` 转 In Progress 待 GUI 点验（0-quattuordecies）**。原文保留供参考：死按钮与假 usage 环逐项接线，或 `disabled` + Tooltip 明写状态（落地裁定走删除支，口径补记执行计划 §3 T-23 行）。
6. **GUI 统一点测**（用户人工）：多轮上下文回归 / T-04 thinking 卡 / T-07 补强三项 / T-20 Effort 选择器 / T-06 补测 / T-03 历史读失败提示 / **T-18 粘贴附件（本轮 100% 待人工测）**——**均已就绪，无待写代码**，点验清单见 [implementation-status](../implementation-status.md) Active TODO「用户线」。
7. **T-10 打包版 GUI 点验**（用户；[清单](../../../../plans/t10-packaged-gui-checklist.md)，产物含随包 Node 141MB）→ CP2 汇报。
8. **T-11 M2 加密机现场验收**（等 T-10；六项含白名单⑥）→ CP5，Phase 0 转正式 Go。
9. **T-33 / T-34 / T-35 三条能力缺失**（2026-08-05 由 [multi-agent plan](../../multi-agent/roadmap.md) **正式平移主线并分配节点**）——三条都只用 Claude 直连链上**已有**的数据，与「接不接 ACP」这个根问题互不依赖，压在后置的支线下会被一并冻住，故归主线：
   - ~~**T-33 网络重试横幅**（0.5d）~~ —— **✅ 2026-08-05 代码落地 `ba6b371` + 复核修复 `e602096`+`d3635d3`+`8bf4829`，待 GUI 点验（0-septendecies）**。原判「数据已在 `chatSessions.ts:85` 只差 UI」成立；as-built：横幅双槽挂载 + **epoch 进度戳门**（两轮收紧：首版 hasBlocks 单调门会永久压制工具后 mid-turn 重试；二版块数门看不见续写恢复，终改块数+字符）；与状态行后缀共存属执行裁定待追认。**✅ 2026-08-06 第十二轮点验验收转 Done，追认随验收生效。**
   - ~~**T-34 子 agent 实况**（1.5d）~~ —— **✅ 2026-08-05 代码落地 `5c02730` + 复核修复批 `a81cae7`，待 GUI 点验（0-octodecies）**。as-built 与原判三处出入：① 委派工具本 CLI 实名 `Agent` 非 `Task`（双名修正随批）；② 默认态就已下发子 agent tool 流（仅 text/thinking 需开关）；③ **C-17 表述改写：重开是「全丢」非「变平铺」**——子 agent 转写在独立 sidecar `subagents/agent-*.jsonl`、主转写 isSidechain=0，未来修法抓手 = `toolUseResult.agentId`+`outputFile`（C-17 仍后置）。协议定案 `subagent.activity` 单事件 9-kind；显示 = 委派行下实况面板（跑动展开/完成不收/终报统计）。**✅ 2026-08-06 第十二轮点验验收转 Done，三追认随验收生效。**
   - ~~**T-35 Host stderr 进 UI**（0.5d）~~ —— **✅ 2026-08-05 代码落地 `5a99ee1` + 复核修复 `e602096`+`d3635d3`+`8bf4829`，待 GUI 点验（0-septendecies）**。as-built：新事件 `session.stderr` + Host 侧摧毁式脱敏（两轮复核后含 provider 裸 key 形态/Basic/URL userinfo/Windows 空格·撇号用户名）+ 每回合 50 行限流；落 context surface「Host stderr」组（环形 20 行、空即隐）。**✅ 2026-08-06 第十二轮点验验收转 Done。**
   → 任务定义与验收标准的权威 = 执行计划 §3 各行；出处见 [multi-agent/topics/acp-decision.md](../../multi-agent/topics/acp-decision.md) 末表（三条走 ACP 都只会更绕）

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
- T-09 补验：真触发「Node 缺失」场景（想法见 [ideas](../../../ideas/inbox.md)）


---

## ② open-questions.md 全文快照

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
15. **提示词缓存命中不稳定:网关责任待复测裁定(2026-07-29 当日降级)**:~~原结论「网关无会话亲和、app 无可修」~~——**用户当日实测反证:同一网关直接接 Claude Code CLI 使用,缓存一切正常**。两组数据可同时为真的解释:命中行为按模型/通道而异(探针用的是 sonnet-4-6 / sonnet-5,CLI 走的模型可能落在不同上游通道)。**裁定步骤**:① `3622c19` 修复后直接 GUI 复测(第二条消息面板应出现缓存读取);② 仍为 0 则用 `spikes/cache-affinity-probe.mjs` 分别跑 GUI 默认模型与 CLI 同款模型做同模型对照。裁定前**暂缓**联系网关运营方。原探针数据(相同重发 4/4 命中、前缀增长 2/4)仍记录在案:对照实验证实 ccmax 分组多上游账号轮询、上游缓存按账号隔离——字节级相同请求重发 4/4 命中,多轮前缀增长形态 2/4 命中 2/4 全量重写;app 侧前缀已拦截证实逐字节稳定,**无可修**。后果:多轮对话每条消息大概率按 ¥6/M 全量重写(42k 上下文 ≈ ¥0.25/条,随上下文线性恶化)。**待用户**:找网关运营方开「渠道亲和 + 渠道内 Key 亲和」(new-api issue #5992)或给令牌绑定单上游通道;修复后用 `spikes/cache-affinity-probe.mjs` 复测(预期 5 次请求后 4 次全部 read>0)。与 #5/#8(thinking 跨模型不一致/漂移)同根因家族,亲和落地可能一并收敛。证据全文:[`docs/design/BUG-2026-07-29-prompt-cache-rewrite.md`](../../../../design/BUG-2026-07-29-prompt-cache-rewrite.md)。
16. ~~侧栏两层化 + Composer 目标栏:四项呈现层拍板~~ **已全部拍板(2026-07-29 当日收口,决策入总台账 D21~D23)**:A=`flat` 平铺+分支 chip(by-worktree 带被否,参照 Cursor 侧栏截图);B=运行位置只读指示器(远程功能上线后再升级为下拉);C=Recent 段保留(用户保留否决权);D=**超出原选项**——用户要求中列整体对齐 Cursor 风格(空态居中 Composer/会话态沉底+目标行,截图入库 `docs/design/refs/cursor-20260729/`),立项 **A07 观感基线**(用户验收后 T-27/T-28 施工)+ **T-28 中列状态化布局**;会话 Tab 栏是否引入在 A07 验收时定。原文如下——双独立方案(Opus/Codex)核心裁定全部收敛(侧栏「文件夹→对话」两层、分支下拉=worktree 选择器禁 in-place checkout、New Worktree 归分支下拉、subagent 后置),分歧仅呈现层四点待用户拍板——A. 侧栏 worktree 默认 `by-worktree` 吸顶带还是 `flat`+chip(建议前者,openchamber 默认);B. 运行位置做只读指示器还是带 disabled 项的下拉(建议前者);C. 侧栏 Recent 段保留还是移除(建议保留,参考实现口径);D. 零新视觉值还是先补 Composer/下拉观感基线 A07(建议前者;基线 HTML 对 composer/dropdown 零命中)。拍板后 D21/D22 进总台账、T-26/T-27 进执行计划任务表。全文:[`docs/plans/2026-07-29-sidebar-composer-target-bar-design.md`](../../../../plans/2026-07-29-sidebar-composer-target-bar-design.md)。
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

- **现状**：T-30 批2 形态规格（[`2026-07-31-t30b2-composer-form-design.md`](../../../../plans/2026-07-31-t30b2-composer-form-design.md)）交付，含三处待拍板项：①模型档位是否合并一体式 `Sonnet High ⌄`；②follow-up 卡是否改满圆 pill；③圆钮 28→24px + 发送键 `--primary`→近黑。
- **待用户**：三拍板项确认或否决，批2 开工前需裁定。
- **✅ 2026-07-31 结项**：三拍板项全部落定（第四轮 GUI 点验第 4/5 条）——①合并一体式模型档位控件 `Sonnet High ⌄`（默认无框，悬停/聚焦/弹层打开才显壳）；②follow-up 卡改满圆 `rounded-full` pill；③圆钮 28→24px + 发送键 `--primary`→近黑，均按推荐方案落定。T-30 批2 施工依据齐备（原规格 + [`2026-07-31-t30b2-composer-form-addendum-round4.md`](../../../../plans/2026-07-31-t30b2-composer-form-addendum-round4.md) 追补，量级 5.6~6.1d），可开工。本条关闭。
- 出处：主线台账 2026-07-30「T-30 批2 形态规格交付」行；结项见 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行。

## #26 Host 受理边界 clientTurnId 幂等（Codex 诊断方案，纵深防御，2026-07-31 新立）

- **现状**：重试双发根治（`cb2d8d7`）采纳的是渲染发送层 `sawUserEcho` 作为幂等权威（Opus 诊断方案，红线零改动落地）。Codex 独立诊断同判核心根因，但主张更纵深的第二道防线——Host 受理边界按 `clientTurnId` 去重，本轮未采纳（不动 Host/协议）。
- **连带**：A5（retry-resume 历史重放，即中断发生在 `beginTurn` 之后、Retry 走 resume 续接时模型可能看到同一条消息两遍）按 Opus 诊断建议留待现场取证后单独立项，取证与本条一并评估。
- **待裁定**：是否排期实现 Host 侧 `clientTurnId` 幂等（涉协议/Host 改动，非零风险），或维持渲染层单一权威——等后续复现或用户反馈再评估。
- 出处：主线台账 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行，双轨诊断分歧仲裁段；[`2026-07-31-retry-doublesend-diagnosis-codex.md`](../../../../plans/2026-07-31-retry-doublesend-diagnosis-codex.md) / [`2026-07-31-retry-doublesend-diagnosis-opus.md`](../../../../plans/2026-07-31-retry-doublesend-diagnosis-opus.md)。

## #27 组件级事故测试基建缺口（2026-07-31 新立）

- **现状**：重试双发一类事故（`chat.send` 计数、竞态注入）需要真实组件渲染 + 交互模拟才能钉住回归，但本仓 vitest 为 node-only 环境、无 `.tsx` 渲染能力，写不出这类组件级事故回归测试。`cb2d8d7` 相关不变量本轮只能以 inspection-verified 注释入码，不可单测。
- **方向**：引入 component-test 环境（jsdom/@testing-library）或补一层 e2e 冒烟层，覆盖 `.tsx` 组件交互路径。
- **待裁定**：排期与选型（jsdom+RTL vs e2e）——等用户或后续任务评估。
- 出处：主线台账 2026-07-31「第四轮 GUI 点验结果 + 重试双发根治落地」行，有意不做与残余段。
## ~~#28 D27 回归 A08 的两处内部张力~~（**2026-08-05 当日用户裁定，已关闭**）

- **① editor 是否回中列 → 是。** 用户原话：「html 中的样式我喜欢那个，而不是现在这样文件打开后内嵌在 editor 里」。
  即 A08 的 `chat ║ editor` 并排中列形态（`a08:1208-1241`）：editor 独占中列、中间 `ed-grip` 可拖比例、
  自带 head（文件图标 + 文件名 + 未保存点 + 「隐去 chat」钮 + 关闭文件钮）；
  **右栏 files tab 降为纯文件树**，点文件在中列 editor 打开（A08 原文「不再开 panel 内 tab」）；
  关文件 → editor 撤列、chat 回、panel 恢复 `panelOpen` 偏好。
  **连带确认**：L0/L1/L2 降级梯是该形态的配套而非可选项（1580 = 280+400+520+380 / 1244 = 280+400+520+44），
  否则 1400px 窗口上 chat 与 editor 会被挤成两条都不可用的窄条。
- **② terminal 留右栏后 Rail / tab 形态 → 由 ① 推出，用户当轮确认「terminal 保留现有样式不改也行」**：
  右栏 tab 扩为**四项** `git | files | context | terminal`；Rail 同步四枚图标 + git-only dot，**仅 panel 收起时渲染**；
  `` Ctrl+` `` = 打开/聚焦 terminal tab（**不再是 A08 的底部 dock 语义**，`BottomDock.tsx` 不复活）。
- **编排者保留的一处不照搬（A06 精神，非用户裁定）**：**editor 保留多 tab**（现有 `EditorTabs`）。
  A08 画的是单文件，但隐藏 tab = 隐藏脏文件、用户会丢改动；T-12~T-15 规格 §7 当时即按此裁定，本轮沿用。
- **结果**：T-32 量级定为 **3d 级**（editor 搬家 + 中列布局 + 降级梯 + 顶栏贯通），开工阻塞解除。
- 出处：总台账 **D27**；本条裁定当日回填执行计划 §3 T-32 行。



---

## ③ plantree 根 README 注册表行原文（openchamber-chat-refactor 行）

| [openchamber-chat-refactor](../README.md) | In Progress | **Phase 0A 基线部分补做（A01/A05/A06；整体仍 🟡，A02/A03/A04 未立项）→ 观感对齐改造**（2026-07-28 转向） | **2026-08-05（最新）T-34 子 agent 实况 `5c02730` + 复核修复批 `a81cae7`**——probe 五场景实测定形（委派工具实名 `Agent`、默认态已发子 agent tool 流、权限主/子同桥带 agentID）→ Opus+Codex 双轨设计仲裁（单事件 `subagent.activity` + 扁平邻接 store + 委派行内实况面板 + 完成不自动收起）→ 半场分工施工 → Codex 复核 3maj+4min 全闭环；**主 agent 工具行不再混入子 agent 调用**（验收②源头修复）；委派双名修正（旧 Task 表从未打中）；**C-17 改写：重开全丢非平铺**（sidecar 亲验）；四门 130 文件 2399 例，**待 GUI 点验 0-octodecies（三追认）**。**同日更早 T-33 网络重试横幅 + T-35 Host stderr 进 UI `ba6b371`+`5a99ee1` + 三轮复核修复 `e602096`+`d3635d3`+`8bf4829`**——T-33：`deriveRetryBanner` 纯函数 + 横幅双槽挂载（ChatTurn turnBody 首子 / PendingTurnHead，status-running 三件套非告警色）；门语义经 Codex 复核两轮推翻收紧为 **epoch 进度戳门**（retry 引用即 epoch，块数+已流字符捕获快照——首版 hasBlocks 单调门会永久压制工具后 mid-turn 重试，二版块数门看不见续写恢复）；**执行裁定：与状态行既有后缀共存**（待追认）。T-35：新事件 `session.stderr` 纯加法 + Host 侧摧毁式脱敏（provider 裸 key 全形态·泛化敏感赋值三值形·Bearer/Basic·URL userinfo·用户目录折叠 `~`——Windows 系空格/撇号用户名双档规则）+ 单行 2000 字符钳制 + 每回合 50 行限流；渲染端 sessionRuntimeFacts 邻接 store 环形 20 行 + 载体上限 12（驱逐=stderr 首达序）；context surface「Host stderr」组空即隐。对抗复核 4maj+2min + 终验两轮 4 项 + ASIA 收口全闭环；红线零改动；三绿 125 文件 2277 例 + build，**impl done 待 GUI 点验 0-septendecies（三处执行裁定待追认）**。**同日更早 T-16 新旧壳开关成熟化 `fd57ebf`**——Appearance 开关此前是**死开关**（Root.tsx 挂载与水合后各强写一次 `true` + 消费端与 `SKIP_ONBOARDING_GATE` 做 OR，双重失效）；**勘察更正任务书：强制覆盖实为四处不是两处**（新增两处为 07-28 立项后长出来的同形 OR），四处一律改为只读设置，`SKIP_ONBOARDING_GATE` 维持 `true` 不作为达成手段；**两处执行裁定待追认**（store 默认 `false`→`true` 只影响新 profile · 新增 localStorage 同步镜像消除异步水合的一帧闪壳）；防回归 `shellSwitchStatic`（TS AST 三条）+ `shellPreferenceMirror` 纯解析。三绿 123 文件 2231 例，**impl done 待 GUI 点验 0-sexdecies**。**同日更早第九轮 GUI 点验验收通过**（用户「点验通过，进入下一任务环节」）——点验清单 **0-quindecies【合并版】**（7 组 24 项）收口，**T-32 / T-12~T-15 / T-23 三任务一并转 Done**；随验收生效的追认四项（`Ctrl/Cmd+1..4` 改绑 1=git 2=files 3=context 4=terminal · `Ctrl/Cmd+B` 侧栏收展 · 四死按钮走删除支 · 72% 假 usage 环撤除）；**唯一遗留 A2「Win10 字重真机核」并入 T-10 打包版清单**。**同日更早 T-32 首轮点验修复批 `fef5ce3`+`8014bef`+`c424128`+`a0c9b90`（m1~m8）**——切 tab 宽度跳变 / 窄窗唤不回右栏 / 提升态半透明叠加 / 快捷键乱跳 / **收窄模型重做（推翻 S4 三档阈值，改逐级试探 sidebar→panel→chat，chat 有 400 硬下限）** / 空 editor 占位吃掉半列 / **点文件不出 editor（门控引入的死循环）** / 目标栏换行；**其中 4 条为本任务自引入的回归**，被推翻的设计与三条通用坑（flex `min-width:auto`、持久化顺序漂移、ResizeObserver 滞后）见规格 §9 追记。三绿 769 文件 / 121 文件 2223 例。（该批收尾时用户表态「暂时没啥问题」属阶段性收手，**逐项收口以同日第九轮「点验通过」为准**）。**同日更早 T-32 五切片 `fbb45fe`+`8df9341`+`4f4fb52`+`2f46fa6`**——editor 回中列（`chat ║ editor` + 比例拖拽，右栏 files tab 降纯树）· tab 条四项 · Rail 仅收起时渲染 · 顶栏贯通 · L0/L1/L2 降级梯与手动覆盖；A08 §7 逐条回标（回归 7 / 豁免 4）；三处有据偏离（内容行阈值 1300/964 · 不加 `panelOpen` 字段 · editor 保留多 tab）；R1 静态不变量钉死可见性单一合成点。三绿 768 文件 / 121 文件 2220 例。**同日更早 context surface 打开即崩修复 `42b692c`**——zustand v5 selector 引用不稳定致 `forceStoreRerender` 自激（`?? []` 每次新建），修为稳定切片 + 模块级 `EMPTY_MESSAGES`，并补 `storeSelectorStability` 静态不变量扫全 renderer selector；三绿 763 文件 / 119 文件 2182 例。**同日 D27 拍板**（右栏骨架回归 A08，三项豁免维持现状）→ 立项 T-32、新立 open-q #28。**2026-08-04 T-23 存量违规清理落地 `bfc087f`**——死按钮清零（Browser/Window/Menu/Help 删除）+ 72% 假环撤除 + 顶栏单行化（P-19/P-22，h-9 + 工作区 chip），双轨对抗复核 + Codex 终验闭环，三绿 118 文件 2180 例，**impl done 待 GUI 点验（0-quattuordecies）**，A06 矩阵已逐行结清。**同日更早 T-12~T-15 四 surface 八提交一次性落地 + A08 临时基线正式化**（S0 壳前置 → Opus+Codex 双轨设计合并 → 四路并发施工 → 双轨对抗复核 1 blocker+8 major+8 minor 全闭环，`f3183f1`..`45c3b63`；三绿 117 文件 2171 例）——**impl done 待 GUI 点验（0-tredecies）**，规格与 A08 对照表 `docs/plans/2026-08-04-t12-15-surface-spec.md`。**同日更早 T-24 收尾结项（S0）**——双链审计 CONFIRMED（HEAD `01be19c`）+ 用户 fresh-profile 模拟实测三条验收全过转 Done（**偏离：真机 Windows 项并入 T-10 清单第 8 项**）。**同日更早 T-29 Markdown 渲染结项（D26）**——`d320206`+`666c7c3`+`4507df3`+`b08f6ae` 四提交，双轨对抗复核闭环（27 findings / 3 证伪），**用户当日点验验收转 Done**（唯一缺陷内容不可选中当轮修复；拍板两项维持现状：脚注 13px / 标题三档）。**2026-08-03 第八轮 GUI 点验验收通过（「点验完毕，没啥问题」）——T-31 回复解剖 + 置顶气泡 `8109d45` 结项，T-22 / T-05 旧清单随轮收口，观感对齐批次二~八轮点验链全部闭环，GUI 点验债清零**（唯 0-nonies ⑪ 真机指标未采集）。同日更早批次：T-30 批2 `9e2736b` / 第五轮修复 `6ece6cb` / 第六轮修复 `fd55a26` / 第七轮验收。**2026-07-28 ~ 08-03 全部批次的逐条脉络见 [roadmap Done](../roadmap.md) 与[主线台账](../../../../plans/ledger-claude-mainline.md)；本行原有的逐批长摘要已随第八轮归档指针化（原文存 git 历史与 [history 归档](./2026-0728-0803-archive.md)）** | **resume 两项优先项均已结清（2026-08-05）**：① 用户开题「决定软件走向的核心问题」= codeg 参照下的**多 agent 方向**，已另立 plan root [multi-agent](../../multi-agent/README.md)（并行推进）；② context surface 报错已定位修复 `42b692c`。**T-32 右栏骨架回归 A08 当日立项/裁定/施工完毕**（`fbb45fe`..`2f46fa6` 五切片）——editor 回中列 + tab 条四项 + Rail 联动收展 + 顶栏贯通 + 降级梯，**已于同日第九轮点验验收转 Done**；**T-16 亦于同日落地 `fd57ebf`（as-built：四处覆盖全拆 + 默认值翻 true + 同步镜像），待 GUI 点验 0-sexdecies**；**T-33 / T-35 同日双双落地并过三轮复核（`ba6b371`+`5a99ee1`+`e602096`+`d3635d3`+`8bf4829`），待 GUI 点验 0-septendecies（含后缀共存/路径折叠/限流三追认）**；**T-34 亦于同日落地（`5c02730`+`a81cae7`）**；**2026-08-06 第十二轮 GUI 点验验收通过——T-16 / T-33 / T-35 / T-34 四任务一并转 Done，开发线五任务全部收口**（四清单 0-sexdecies / 0-septendecies / 0-octodecies / 0-novodecies 结项；布局模型三轮改判定稿「rail 常驻切换器 + 面板宽度压缩」`cfc3bc1`，round-11 裁切与 T-32 降级梯两代被推翻均已注记；性能裁定 = VM 软渲染主因 + 实现侧拖拽 rAF 直绘已治理；后续走向见 implementation-status Next Target 廿三次修订）；三条能力缺失 2026-08-05 由 multi-agent 支线正式平移主线分配节点；**开发线现行顺序（用户 2026-08-05 裁定）= ~~T-32（已验收 Done）~~ → ~~T-16~~ → ~~T-33 / T-35~~ → ~~T-34~~（后四者 2026-08-06 第十二轮验收 Done）**；T-16 前置（T-24 / T-12~T-15 / T-23）**至此全部 Done**；**真机类遗留统一并入 [T-10 打包版清单](../../../../plans/t10-packaged-gui-checklist.md)**：T-24 真机 Windows 项（第 8 项）+ A2 的 Win10 字重真机核；残留：0-nonies ⑪ 真机指标（Win10 必测字重）、open-q #22/#23、**T-04 网关阻塞**与 **#15 缓存复测裁定**并行；backlog：历史侧回合时长源 / `ran N command(s)` 聚合复议（需 A07 基线修订） |
