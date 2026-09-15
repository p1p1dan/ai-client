# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q013 | 批次 D2 上机前修补共 12 组代码任务（T037～T048，含 3 条 high）+ 1 组文档回写（T055），上机前的时间窗是否够？要不要压缩？编排者建议：3 条 high 所在的 T037 / T038 / T039 与数据安全类 T040 / T041 / T042 / T045 / T046 必做；T043（渲染层词汇表）、T044（问答卡状态机）、T047（TSD）、T048（终端 / TUI）如时间不够可推到批次 F，但要把它们的用户可见症状写进 T032 检查单，避免上机日被当成新缺陷记录 | 接缝审查员的分组与提醒（[cross-and-critic.md](evidence/batch-d-audit-2026-09-15/cross-and-critic.md)「修补分组」）；批次 C 单波两任务约需半天 | T037～T048、T055、T032 |
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
