# Roadmap — OpenChamber Chat Refactor

> 状态口径：✅ 需有证据（hash / 台账行）；「impl done 待 GUI 联调」不算 Done。
> 明细证据一律看台账档案，此处只留一行摘要 + hash。

## Done

**阶段性**
- Phase 0 技术 Go/No-Go：🟡 Conditional Go（加密机项待 T-11 转正，见 [phase0-report](../../../plans/phase0-report.md)）
- Phase 1 UI Shell（Mock）✅ `259e863`
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

**团队 T-xx 已验收**
- T-01 真实数据树 `a01712a` · T-08 Model 选择器 `298e3e6` · T-17 Tool 真实调用 GUI 闭环
- **T-02 Session 生命周期 UI** ✅ `dc727d2` + 修复 `db5116a`（2026-07-26 GUI 复验通过：标题正常显示、空标题回退短码占位符）
- **T-07 Composer @ 文件引用** ✅ `1ff7fc1` + 修复 `db5116a`（2026-07-26 GUI 复验通过：`@src/` 有结果、目录后缀正常渲染）。补强项另列 Next。

## In Progress

- **T-03**：重放机制联调通过（历史 tool 卡正常渲染），但历史读失败的 UI 展示（协议 §7 归 T-03）实现仍缺；thinking 缺失已定性为非本任务问题。
- **T-04**：代码链逐环验证正确；#8（2026-07-27）落地 `display:'summarized'` 后 **可观测对象已就位**（真 Host 实测 `thinking.delta` 361 字符非空），阻塞解除，等 GUI 人工点验。**注意**：历史 fixture 的 153 个 thinking 块文本仍是空串（录制时 display=omitted，不可追溯补全）→ 只能在**新发起轮次**验证，resume 旧会话无 thinking 属预期。
- **T-06**：实现已落地（`0f3a8da` 等），**唯一完全未测**的任务，网关恢复后可直接补。
- **CP2（M1 确认）**：材料已齐（C-02 自动化 25 项 PASS），等 T-10 点验合并汇报。

## Next

1. **GUI 统一点测**（用户人工）：T-04 thinking 卡 / T-07 补强三项 / T-20 Effort 选择器 / T-06 补测——**四项均已就绪，无待写代码**，点验清单见 [implementation-status](./implementation-status.md) Active TODO 1。
2. **T-05 Tool Card 增强 + Question 卡**——工具卡：spinner/折叠/input-output 截断/toolCallId 关联/Read-Write-Edit 路径摘要行 + **F1 反馈：路径可点击**；Question 卡消费指引见总台账 C-04 行。**当前唯一剩余的纯开发项。**
3. **T-10 打包版 GUI 点验**（用户；[清单](../../../plans/t10-packaged-gui-checklist.md)，产物含随包 Node 141MB）→ CP2 汇报。
4. **T-18 Composer 粘贴图片/文件**（C-13 协议就绪；大图 79s 先例，必须做发送中状态）。
5. **T-11 M2 加密机现场验收**（等 T-10；六项含白名单⑥）→ CP5，Phase 0 转正式 Go。

## Deferred

- Phase 4：T-12 右栏 Git / T-13 Files（F5 反馈提级）/ T-14 Context / T-15 Terminal Dock / T-16 新旧开关（M3 后）
- C-11 stream-json fallback（机动，SDK 路线阻塞时提级）
- C-12 旧路径收缩 + 千 block 压测（Phase 5；虚拟化决策依赖压测数据）
- T-19 消息队列（提案内容待用户落库，落库前不排期）
- T-09 补验：真触发「Node 缺失」场景（想法见 [ideas](../../ideas/inbox.md)）
