# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q014 | 32 MiB 会话预算与渲染层 5 MiB 单张附件上限之间的算术冲突：正常使用满足「个位数消息顶不满」，但极端构造（每条都塞满附件上限）仍可 4 条打满预算；候选是调大 `SESSION_MAX_BYTES`、调小 `DEFAULT_ATTACHMENT_LIMITS`，或改走附件旁路文件 + 引用 | T046 对账表新增第八节给出的完整算术（[evidence/capacity-reconciliation-2026-09-15.md](evidence/capacity-reconciliation-2026-09-15.md)） | 待拍板，不阻塞 D2；T046（已落地） |
