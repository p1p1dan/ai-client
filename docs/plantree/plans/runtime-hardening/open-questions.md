# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |

~~Q015~~ 已由[决策 016](decisions/016-home-tier-instruction-gating.md)结案（2026-09-16）：家目录从 project 链移除、改作独立的 **user 层 global**，全局规则对所有项目生效；全局层只取一份，顺序 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，找到即停；家目录之上的多用户共享目录不读；未信任项目仍整条 project 链不读的底线不动。落地任务 **T059**，排在 T032 之前。

~~Q016~~ 已由[决策 018](decisions/018-temp-workspace-removal-keeps-chats-visible.md)结案（2026-09-17）：删除临时工作区前先弹确认框，列出该目录下受影响的对话条数；删除后这些聊天转为未绑定会话，继续在侧栏未绑定分组下可见、可打开（复用 T040 已落地的未绑定会话语义）。落地任务 **T069**，排批次 F。

~~Q017~~ 已由[决策 019](decisions/019-runtime-errors-as-guided-cards.md)结案（2026-09-17）：运行时错误（重试预算耗尽、会话超预算等）统一改成带标题、一句话原因与下一步操作（重试 / 新开会话 / 去设置）的引导卡片，原始报错文字折叠进「详情」，复用 T062 `ModelMissingNotice` 的卡片骨架。落地任务 **T070**，排批次 F。

~~Q018~~ 已由[决策 020](decisions/020-temp-workspace-root-app-owned-subdir.md)结案（2026-09-17）：在「保存位置」设置的目录下固定加一层应用专属子目录，临时工作区只认领该层下的直接子目录，不再直接扫描保存位置根；默认值 `~/JYWAI/temporary` 本身即是专属目录，行为不变。落地任务 **T071**，排批次 F。
