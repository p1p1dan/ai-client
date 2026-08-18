# Roadmap — OpenChamber Chat Refactor

> 状态口径：✅ 需有证据（hash / 台账行）；「impl done 待 GUI 联调」不算 Done。
> 明细证据一律看台账档案，此处只留一行摘要 + hash。
> 2026-08-08 归档：Done 各批长摘要原文移 [history 快照](./history/2026-0808-roadmap-openq-registry-archive.md)，本表只保留一行式。

## Done

**阶段性**
- Phase 0 技术 Go/No-Go：✅ 正式 Go（2026-08-15 加密机现场 T-11 六项全过 → CP5；历程见 [phase0-report](../../../plans/phase0-report.md)）
- Phase 0A 设计基线 ✅ 收口（2026-08-15 D43）——A01/A05/A06 交付（2026-07-28，产物[对齐基线 HTML](../../../design/phase0a-openchamber-alignment.html)，拍板 D18/D19/D20）；A02/A03/A04 裁定被演进取代（见总台账 D43 行）
- Phase 1 UI Shell（Mock）✅ `259e863`（旧四区口径，不回退；D18/D19 后重做归 T-21/T-22）· Phase 2 Runtime Vertical Slice ✅

**主线 C-xx（全部完成，明细见[主线台账](../../../plans/ledger-claude-mainline.md)）**
- C-01/C-02 打包链 + 自动化验证 `f21fec7` `dbb20be` · C-03/C-04 Question 桥 `c9522d2` · C-05 Thinking 默认开 `8449e88`
- C-06 Resume 历史全链（CP4）`db41f63` · C-07 Session Index `f6807c9` · C-08 Store 批处理 `138ccb3` `922d689` · C-09 测试基建 + lint 绿 `ce5a577` `49a6031`
- C-10 Effort/Plan/Build 探测（⚠️ `output_config.effort` 假设已被 #8 更正为 SDK 顶层 `Options.effort`）· C-13 附件桥 `d339f70` · C-14 看门狗 `f87c1cc` · C-15 随包 Node `adc3127` · D16 vflow 移除 `dbb20be` `eac23f7`
- #8 thinking 形态修正 + effort 协议底座 ✅ 2026-07-27 · T-07 补强四项 ✅ `0f886a8` · T-20 Effort 选择器 ✅ `4c3f67e` · T-18 粘贴附件 ✅ `703f981`（GUI 待人工）· T-03 收尾历史读失败 UI ✅ `7a5c2cd`
- 2026-07-28 GUI 首测五连修 ✅ `eea2f25` `0bd70d5` `da9a5da` `9331d51` `576f3bd` · 「不出窗口」故障闭环 ✅ `d68d3c6`（档案 [BUG-2026-07-29-no-window](../../../design/BUG-2026-07-29-no-window.md)）· dev 态凭证隔离 `dev.env` ✅ `b18ccac`（缺口见 open-q #14）

**团队 T-xx 已验收**
- T-01 真实数据树 `a01712a` · T-08 Model 选择器 `298e3e6` · T-17 Tool 真实调用 GUI 闭环 · T-02 会话生命周期 `dc727d2`+`db5116a` · T-07 `@` 引用 `1ff7fc1`+`db5116a`
- T-24 新壳「添加仓库」通路 ✅ 实体 `b38017b` + 2026-08-04 收尾结项（双链审计 + fresh-profile 实测；真机 Windows 项并入 [T-10 清单](../../../plans/t10-packaged-gui-checklist.md)第 8 项）

**观感对齐批次 · 二~八轮点验链闭环（2026-07-29 ~ 08-03；第七/八轮用户验收通过）**
- T-26 侧栏两层化 ✅ `dd23b01` · T-27 目标栏 ✅ `e8fb36a` · T-28 中列状态化 ✅ `4c1e4d7` · T-22 壳结构（D19）✅ `95a5c04` · T-05 工具行/问答卡（D24）✅ `340a59a`
- T-19 消息队列 ✅ `1b350ff` · T-30 观感打磨批1 `3dcd2dc` + 批2（D25 分域字体 + Composer 三拍板）`9e2736b`
- 二~八轮点验反馈闭环 ✅ `b159e4a`→`514560c`→`cb2d8d7`（重试双发根治）→`6ece6cb`→`fd55a26`（重发双显根治）；诊断档 [round6](../../../plans/2026-08-03-round6-feedback-diagnosis.md) 结项
- T-31 回复解剖 + 置顶气泡 ✅ `8109d45`（第八轮验收，0-undecies 全过）· T-29 Markdown 渲染（D26）✅ `d320206`+`666c7c3`+`4507df3`+`b08f6ae`（08-04 验收；拍板两项维持现状：脚注 13px / 标题三档）
- 残留：**0-nonies ⑪ 真机指标未采集**（Win10 必测字重，归 T-10 清单第 9 项）

**A08 骨架与四 surface 批次 · 第九轮验收（2026-08-05「点验通过」）**
- T-12~T-15 四 surface ✅ 八提交 `f3183f1`..`45c3b63`（S0 壳前置 + 双轨设计/复核；规格与 A08 对照 [t12-15-surface-spec](../../../plans/2026-08-04-t12-15-surface-spec.md)）
- T-23 存量违规清理 ✅ `bfc087f`（死按钮删除支 + 假 usage 环撤除 + A06 矩阵结清）
- T-32 右栏骨架回归 A08（D27）✅ 五切片 `fbb45fe`..`2f46fa6` + 修复批 `fef5ce3`..`a0c9b90`（m1~m8，4 条自引入回归；被推翻设计与通用坑见[规格 §9](../../../plans/2026-08-05-t32-a08-shell-regression-spec.md)）
- 追认四项随验收生效：`Ctrl/Cmd+1..4` 改绑 · `Ctrl/Cmd+B` 侧栏收展 · 四死按钮删除支 · 72% 假 usage 环撤除

**开发线收口批次 · 第十二轮验收（2026-08-06，开发线全部 Done）**
- context surface 打开即崩修复 ✅ `42b692c`（zustand v5 selector 稳定性 + 静态不变量扫全仓）
- T-16 新旧壳开关成熟化 ✅ `fd57ebf`（四处强制覆盖全拆 + 默认 true + 同步镜像，两裁定随验收追认）
- T-33 网络重试横幅 ✅ `ba6b371`（epoch 进度戳门，两轮收紧）· T-35 Host stderr 进 UI ✅ `5a99ee1`（摧毁式脱敏 + 限流；复核修复批 `e602096`+`d3635d3`+`8bf4829`）
- T-34 子 agent 实况 ✅ `5c02730`+`a81cae7`（`subagent.activity` 单事件 + 实况面板 + 分流根治混行；C-17 改写为「重开全丢」）
- 布局模型三轮改判定稿「rail 常驻 + 面板宽度压缩」✅ `cfc3bc1`（0-novodecies 收口）；性能裁定 = VM 软渲染主因 + 拖拽 rAF 直绘已治理
- 测试机五问题修复批 ✅ `9a6cc01`（2026-08-08 提交；现场回归项 R1~R4 见[加密机测试方案](../../../plans/2026-08-06-encrypted-machine-test-plan.md)步骤 4b）+ 侧栏行宽度预算 `eb4a6c0` + 版本抬 `0.4.0-test.2` `ff63987`

**真机点验期修复批次（2026-08-10，shice2 现场取证）**
- 现场七问题修复批 ✅ `d759023`（白屏首帧主题背景 · 授权卡已决收敛工具行 · Stop 全链路〔等待谓词补终止态 + generation 当帧生效 + 停止判正常结束 + 队列「Stop 冻结、入队恢复」〕· Temp 会话行可删 · 拖拽加固〔终端截胡修复 + 非原生拖源后备 + `[file-drag]` 自证日志〕· 历史附件元数据回放〔载体改判 content block〕· git 判据纠偏〔checkType 并集 + temp 补判 + BOM/CRLF 解析加固 + 空态显示判定路径〕；排查结论两处被实现方证据推翻——sessionIndexMerge temp 解锁否决、attachment 控制行非载体）+ 版本抬 `0.4.0-test.3` `aa3ab33`；四门 2990 例 0 红；第二轮现场回归要点见[现场操作单](../../../plans/2026-08-10-field-test-sheet.md)
- D29 侧栏点仓库切会话 ✅ `e529a55`（#28 拍 A + 三条代拍同日追认；施工+对抗复核双段，2 major 闭环——含 resume 后写 activeSessionId 既有竞态顺带根治；vitest 3004）

## In Progress

- **T-04 thinking 卡**：🔴 卡在网关（sonnet 空文本 thinking / 默认模型确定性 400，open-q #5/#8）——app 侧无可修，等网关侧处理；修复后须在新发起轮次验证。
- **T-06 元数据/重试**：实现已落地（`0f3a8da` 等），唯一完全未测的任务，网关恢复后可直接补。
- **T-21 Flexoki 主题 + 全等宽字体栈**：代码已落 `b38017b`；待默认主题下中英混排三场景 + 6 处 `normal-case` 豁免截图验收（open-q #10），截图入台账后转 Done。
- **CP2（M1 确认）**：材料已齐（C-02 自动化 25 项 PASS），等 T-10 点验合并汇报。

## Next

1. **T-10 打包版 GUI 点验**（用户；[清单](../../../plans/t10-packaged-gui-checklist.md) + [加密机测试方案](../../../plans/2026-08-06-encrypted-machine-test-plan.md)，出发前必做 M1~M4）→ CP2 汇报。
2. ~~**T-11 M2 加密机现场验收**~~ ✅ 2026-08-15 现场六项全过（含白名单⑥）→ CP5，Phase 0 正式 Go（open-q #7 关闭）。
3. **GUI 统一点测残项**（T-04 待网关 / T-06 / T-07 补强 / T-20 / T-03 / T-18 附件人工项）——清单见 [implementation-status 用户线](./implementation-status.md)。
4. **开发线推进中（2026-08-18）**：D48+T-10 用户点验分诊 F1~F11 全线出清——快修批/F10（前落）+ **F2 超时重设计五片（D49）** + **F456 可读性与 Composer 四片（D50）** + **F11 重发历史重复修复（D51）** 全部施工收口（全量 vitest 4724 例；台账三行 + as-built 各归位）。残余：GUI 点验批（G-1~G-11+新增项，含 D3-b 否决权条件①③裁定）/ F7 回退分叉 v1 规格待开 / F8 分支盲票 / F9 TSD 判别测试待用户 / Q3 全局语言口径待拍板。

## Deferred

- **Phase 4 surface 化残余 = 后置 6 surface**（`pr / diff / plan / notes / browser / preview`）保留注册位，本轮不实现（T-12~T-15 / T-16 已全部 Done 出列）。
- **C-17 问答/子 agent 进历史协议**（D20 偏离的解除前置）：扩 `HistoryBlock` 加 question/permission/subagent + Host 写历史 + store 补 case；T-34 已铺好抓手 `toolUseResult.agentId`+`outputFile`。走协议变更纪律。（编号跳过 C-16——已被 spike 文件占用）
- **T-25 旧模块原色硬编码清理**（依赖 T-21 验收）：按 Flexoki 语义 token 逐目录分批替换（清单见执行计划 §3 T-25 行）。
- C-11 stream-json fallback（机动）· C-12 旧路径收缩 + 千 block 压测（Phase 5）· T-09 补验「Node 缺失」真触发（想法见 [ideas](../../ideas/inbox.md)）
