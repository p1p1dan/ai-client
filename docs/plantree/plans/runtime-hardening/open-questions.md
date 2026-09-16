# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |

~~Q015~~ 已由[决策 016](decisions/016-home-tier-instruction-gating.md)结案（2026-09-16）：家目录从 project 链移除、改作独立的 **user 层 global**，全局规则对所有项目生效；全局层只取一份，顺序 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，找到即停；家目录之上的多用户共享目录不读；未信任项目仍整条 project 链不读的底线不动。落地任务 **T059**，排在 T032 之前。
