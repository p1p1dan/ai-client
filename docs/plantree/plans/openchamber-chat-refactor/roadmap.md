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
- C-10 Effort/Plan/Build 探测（结论：仅 xhigh 有实证；plan 非硬只读）
- C-13 附件桥 `d339f70` · C-14 挂起看门狗 `f87c1cc` · C-15 随包 Node `adc3127`
- D16 vflow 整体移除 `dbb20be` `eac23f7`

**团队 T-xx 已验收**
- T-01 真实数据树 `a01712a` · T-08 Model 选择器 `298e3e6` · T-17 Tool 真实调用 GUI 闭环

## In Progress

- **T-02 / T-03 / T-04 / T-06 / T-07**：实现全部落地（`dc727d2` / `25cb888` / `22ef2ff` / `0f3a8da`等 / `1ff7fc1`），**统一等用户 GUI 联调复验**（要点见团队台账各行；环境见 [baseline 门禁](../../../plantree/baseline/test-and-release-gates.md)）。联调通过项转 Done。
- **CP2（M1 确认）**：材料已齐（C-02 自动化 25 项 PASS），等 T-10 点验合并汇报。

## Next

1. **T-05 Tool Card 增强 + Question 卡**——全解锁（Question 依赖 C-04 已 ✅），下一个开发任务。工具卡：spinner/折叠/input-output 截断/toolCallId 关联/Read-Write-Edit 路径摘要行 + **F1 反馈：路径可点击**；Question 卡消费指引见总台账 C-04 行。
2. **T-10 打包版 GUI 点验**（用户；[清单](../../../plans/t10-packaged-gui-checklist.md)，产物含随包 Node 141MB）→ CP2 汇报。
3. **T-18 Composer 粘贴图片/文件**（C-13 协议就绪；大图 79s 先例，必须做发送中状态）。
4. **T-20 Effort 选择器**（先做协议扩展 `session.create/send` 传 effort——原「提需求给主线」现同归我们；开工前按官方文档核实档位）。
5. **T-11 M2 加密机现场验收**（等 T-10；六项含白名单⑥）→ CP5，Phase 0 转正式 Go。

## Deferred

- Phase 4：T-12 右栏 Git / T-13 Files（F5 反馈提级）/ T-14 Context / T-15 Terminal Dock / T-16 新旧开关（M3 后）
- C-11 stream-json fallback（机动，SDK 路线阻塞时提级）
- C-12 旧路径收缩 + 千 block 压测（Phase 5；虚拟化决策依赖压测数据）
- T-19 消息队列（提案内容待用户落库，落库前不排期）
- T-09 补验：真触发「Node 缺失」场景（想法见 [ideas](../../ideas/inbox.md)）
