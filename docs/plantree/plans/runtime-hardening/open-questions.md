# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q001 | `run.targetPath` 要接生产者（嵌套 CLAUDE.md / AGENTS.md 按目标文件所在目录逐级发现）还是删掉这条能力与测试？ | 加载器与测试齐全但产品从未传入（context-prompt-03，部分取舍：P2 证据写「P4 传目标文件路径」的待办没人接） | T014 |
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q006 | legacy 缓存命中率基线无法重采后，P2-6「可对比」怎么维持？ | `compare.mjs` 仍强制要求 legacy 归档而采集脚本已删；config_version 冻结使版本戳无法分代 | T028 |
