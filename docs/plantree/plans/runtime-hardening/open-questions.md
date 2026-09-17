# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q016 | 删除临时工作区后，其下聊天的去向：静默消失（现状）、删除前提示、还是转为 unbound 继续显示在侧栏？ | DEV-9 真机点验（缺陷 D5）：临时工作区一删，其下聊天从侧栏静默消失、无任何提示，而索引行与 JSONL 都还在盘上；[开发机证据](evidence/batch-e-devbox-2026-09-17/README.md) | 待拍板、不阻塞 D4；拍板后落到批次 D4（或按需新开一条） |
| Q017 | 运行时错误（重试预算耗尽、会话超预算 / 附件超限）是否升级成带标题与下一步的卡片，并整体走 i18n？ | DEV-24 / DEV-33 的判据问题（缺陷 D26 与 E1 轻项）：现状是裸 mono 错误块或英文原文直出（`Error: session exceeds the configured size budget`），与「会话历史已损坏」那三张有标题有引导的历史错误卡不是一个规格；[开发机证据](evidence/batch-e-devbox-2026-09-17/README.md) | 待拍板、不阻塞 D4；答案决定 T061 / T067 的范围边界 |
| Q018 | 临时工作区认领判据是否要加「由本应用创建」标记（如 marker 文件），或限制「保存位置」不得设成已有项目的父目录？ | T060（D13）修好「保存位置」设置的读取问题后，`adoptTempWorkspace`（`src/main/ipc/chat.ts:296`）判断是否认领一个目录，只看它是不是保存位置根的**直接子目录**（`isDirectChildOf`），不问该目录是否由本应用创建。若用户把保存位置设成某个真实项目的父目录，且该项目本身不是 git 仓库，应用会对它执行 `mkdir` + `git init` 并当作临时工作区处理（`src/main/services/agent-host/TempWorkspaceService.ts:80-86`），用户没做过这个动作也没有任何提示。来源：T060 只读审阅备注 `/tmp/t032/reviews/group1.md` T060 节 note 1 | 待拍板、不阻塞 D4 |

~~Q015~~ 已由[决策 016](decisions/016-home-tier-instruction-gating.md)结案（2026-09-16）：家目录从 project 链移除、改作独立的 **user 层 global**，全局规则对所有项目生效；全局层只取一份，顺序 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，找到即停；家目录之上的多用户共享目录不读；未信任项目仍整条 project 链不读的底线不动。落地任务 **T059**，排在 T032 之前。
