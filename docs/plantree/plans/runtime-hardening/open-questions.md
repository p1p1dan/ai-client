# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q015 | Windows 用户的仓库多在 `C:\Users\<user>` 之下，`~/.claude/CLAUDE.md` 会经 **project 层的祖先目录爬升**进入系统提示（`projectInstructions.ts:97-110`）：这一份不受 `settingSources` 的 user 层开关控制（决策 008 只管 user 层那份），且排最外层**优先消耗 32 KiB 共享预算**，可能把工作区自己的 AGENTS.md 挤出去。是否加「祖先链遇到 home 目录时按 user 层处理/去重」的规则？ | [缺陷深查存证](evidence/defect-deep-dive-2026-09-16.md)第 3 节；`projectInstructions.ts:285-299` 注释已承认残余风险但未料到 Windows 上是常态 | 待拍板；不阻塞 |
