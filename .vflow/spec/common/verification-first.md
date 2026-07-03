# 验证先行开发规范

> 适用：AI Agent / LLM 编排 / 非确定性系统（强适用）；有外部依赖或 tool 编排的多步流程（适用）
>
> 来源：spec-dan-v2.md 提炼
>
> 级别说明：【规】= 必须遵守；【建】= 建议

---

## 总纲

> 把「改完再测」翻转为「先定义验证、再改代码」。
>
> 目标不是「把功能做出来」，而是：把系统改造成**可验证、可回归、可对比、可被另一个 Agent 独立接管**的系统。

---

## 一、可观测前提

1. 【规】系统必须有一个**脱离 UI 也能完整运行**的入口，可脚本化、可重复、可被另一个 Agent 调用。(源:vflow)
2. 【规】每次执行必须输出**结构化轨迹**（JSON/JSONL）；必填字段：`run_id`、`timestamp`、`input`、`model`、`config_version`、`steps[]`（含每步 tool 调用及输出）、`final_output`、`latency_ms`、`success`。不能只依赖纯文本日志。(源:vflow)
3. 【规】出 bug 时必须能从 trace 复盘「它到底怎么走歪的」；另一个 Agent 能直接读 trace 做分析，无需人工解读。(源:vflow)

---

## 二、分层验证

4. 【规】每个核心功能必须先用自然语言描述 Happy Path（输入条件、预期 tool 调用、调用顺序、必须出现的中间状态、最终输出最低要求），再写断言。(源:vflow)
5. 【规】断言按优先级执行：P0=结构/格式 → P1=tool 调用行为 → P2=路由/路径 → P3=边界/禁止模式 → P4=性能。先穷尽确定性断言，再用 LLM-judge 兜底。(源:vflow)
6. 【规】LLM-judge 只用于无法硬编码的语义判断（完整性、事实一致性、语气）。每个维度用独立 judge；必须提供参考答案或源文档；judge 模型必须「干净」（不参与开发）；rubric 必须结构化输出。(源:vflow)
7. 【建】单次运行结果不足以下结论。冒烟测试每个 case 建议跑 3 次，`pass^3 < 80%` 的 case 必须修复才能合并。(源:vflow)

---

## 三、资产沉淀与对比

8. 【规】维护三层回归集：**冒烟集**（10–20 个核心 case，≤5 分钟跑完）、**主回归集**（覆盖主要路径，每日/合并前）、**事故回归集**（线上翻车 case + 历史 bug，只增不删）。(源:vflow)
9. 【规】任何已修复的 bug 必须转成永久 case，加入事故回归集。修了 bug 但没加 case = 未完成。(源:vflow)
10. 【规】新 tool / 新 prompt 路径 / 新 planner / 新 memory 行为，一律加 feature flag。对比必须能回答：「这个功能提升了什么，又悄悄搞坏了什么」。(源:vflow)
11. 【规】每轮评估自动生成对比报告，必须包含：总通过率变化、各维度通过率、latency 变化（p50/p99）、新增失败 case 列表、已修复 case 列表、top regressions。3 分钟内应能看懂这次改动是否值得保留。(源:vflow)
12. 【建】给 bad case 打分类标签：`route_error` / `tool_misfire` / `hallucination` / `memory_error` / `format_error` / `timeout` / `loop_error` / `judge_score_drop` / `regression`。禁止统一叫 `bad_case`。(源:vflow)
13. 【规】每次评估记录必须绑定：`git_commit`、`prompt_version`、`tool_version`、`config_hash`、`feature_flags`、`eval_suite_version`。缺一不可。(源:vflow)

---

## 四、工作流顺序

14. 【规】加功能时必须按此顺序，**不允许跳步或倒序**：①写 Happy Path 描述（自然语言） → ②写确定性断言 → ③补充/修改 eval case → ④加 feature flag → ⑤最后才改业务逻辑。先改业务逻辑再补测试 = 断言可能迁就了错误实现。(源:vflow)

---

## 附录：反模式速查

| 反模式 | 症状 | 正确做法 |
|:---|:---|:---|
| 人肉回归 | 改完就自己手点验证 | 独立运行入口 + 脚本触发 |
| 日志依赖 | 只写 print/log | 强制 JSON trace，含 run_id |
| judge 滥用 | 所有东西都给 LLM 打分 | 先穷尽确定性断言，judge 兜底 |
| 单次判定 | 跑一次绿了就合并 | pass^k 指标，多次运行 |
| 无版本绑定 | 不知道哪次改动导致退步 | 每次 eval 记录 commit + config hash |
| bug 修而不沉淀 | 同一 bug 半年后复发 | 每个 bug → 永久 case |
| 顺序颠倒 | 先改代码再补测试 | Happy Path → 断言 → case → flag → 代码 |
