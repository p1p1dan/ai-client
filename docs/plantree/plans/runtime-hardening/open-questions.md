# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q011 | TUI（内嵌终端里的真 pi CLI）在 managed 模式下的项目信任由 pi 自己决定（`--approve` / trust.json / `defaultProjectTrust` / 弹窗），我方从未真正管住；决策 009 第 2 条「项目 model 相关设置不读」对 TUI 只是意图。要生效只能给 PTY 加 `--no-approve`，但 pi 的单一开关会连项目 skills / prompts / extensions / themes / SYSTEM.md 一起挡掉。是接受 TUI 由 pi 自决（现状），还是加 `--no-approve` 换取 models 不读？ | `src/main/services/terminal/PiTuiPty.ts` argv 只有 `[cliPath]`；pi `settings-manager.js:169/189`、`resource-loader.js` 的 projectTrusted 门控清单见决策 009 | 决策 009；若加 `--no-approve` 是 Main 侧一行 + 用例 |
| Q006 | legacy 缓存命中率基线无法重采后，P2-6「可对比」怎么维持？ | `compare.mjs` 仍强制要求 legacy 归档而采集脚本已删；config_version 冻结使版本戳无法分代 | T028 |
