# 决策 007：删除 `run.targetPath`，项目指令按官方分级规则处理，只认 CLAUDE.md 与 AGENTS.md

日期：2026-09-14。状态：已采纳（用户拍板，回答 Q001）。

## 背景

`run.targetPath` 与 root→leaf 链改编自 PI-Desktop 的 `project-instructions.ts`（其注释称照 Codex 的指令链），在原产地也只是一个无人调用的侧车查询接口；我们连空接口一起抄了过来，产品从未传入目标文件。它既不是官方的「开局装父目录」，也不是「按需装子目录」。

## 决定

1. 删除 `run.targetPath` 参数、root→leaf 分支与对应测试。
2. 项目指令改为按 Claude Agent SDK 官方分级规则加载，**只处理 CLAUDE.md 与 AGENTS.md**（含现有的 `.claude/CLAUDE.md`、`AGENTS.override.md` 同目录变体）：
   - 项目根与 cwd 上方每个父目录：会话开始时加载。
   - cwd 子目录：代理读到该子树中的文件时按需加载，每份一次，会话内持续有效。
   - 用户级 `~/.claude/CLAUDE.md`：继续由宿主经 `prompt.globals` 传入。
   - 各级累加，没有硬优先级；提示块只声明「各级累加，冲突以更具体文件自述为准」，不再写「后者优先」。
3. 暂不做：`.claude/rules/*.md`、`~/.claude/rules/*.md`。（原「不做 settingSources 与 CLAUDE.local.md」已被[决策 008](008-setting-sources-switch.md) 修订：两者都做。）

## 影响

- T014 中「`run.targetPath` 按 Q001 决定接线或删」改为「删」。
- 批次 B 新开 T035 承接分级加载；按需加载走工具插件挂点，以内部标记消息注入（复用 T005）。
- 沿用现有 32 KiB 共享预算、symlink 守卫、每 run 重读、未信任项目不装。
- Q001 从 open-questions 移除；审计 context-prompt-03 由 T014 关闭。
