# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q001 | `run.targetPath` 要接生产者（嵌套 CLAUDE.md / AGENTS.md 按目标文件所在目录逐级发现）还是删掉这条能力与测试？ | 加载器与测试齐全但产品从未传入（context-prompt-03，部分取舍：P2 证据写「P4 传目标文件路径」的待办没人接） | T014 |
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q004 | 项目 `.agents/skills` 是否照 pi 一路找到仓库根？ | pi 文档写「cwd 及祖先目录到仓库根」，本仓只看 cwd 一层（skills-mcp-22，K1 验收未写祖先目录） | T019 |
| Q006 | legacy 缓存命中率基线无法重采后，P2-6「可对比」怎么维持？ | `compare.mjs` 仍强制要求 legacy 归档而采集脚本已删；config_version 冻结使版本戳无法分代 | T028 |
| Q008 | session-02 的中段坏行形态（撕裂尾片之后 CLI 又写了条目，坏行落到文件中段）怎么处理：跳过无法解析的行并重写文件（与 CLI 读法一致，但会静默丢一行、丢到 lane 行会无声改分支），还是维持响亮失败？ | T003 已用真实 SessionManager 证明 session-02 可达并修了「CLI 打开但未再写」的形态；中段形态是独立取舍 | 新任务（批次 B） |
| Q007 | 子代理 usage 进会话总量的形态：并入 usage.updated 独立字段，还是单独事件？ | 渲染层 piTurnRollup 注释写「同一总量，可说明委派占比」 | T020 |
