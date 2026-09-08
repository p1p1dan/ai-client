# Evidence — 资源归位与会话导入（B 组）

逐任务落地证据。每个文件记录**实际执行的命令、日期、环境**，以及**未跑到的门禁**。

按仓库规范（`docs/agent-project-engineering.md`）：
不沿抄旧的「全绿」数字；本机是资源受限的小服务器，不跑整套生产构建、不启动 Electron GUI 时，
必须在文件末尾逐条列出未验证项。

**B1-a 的取证 evidence 额外要求**：记录 pi 版本（当前 `pi-coding-agent` 0.84.3）、
探针脚本路径、托管/本地/TUI 三种模式各自的结论。结论为负时，同一份 evidence 要写明
设置页那句「三处始终加载」被改成了什么。

命名：`b1a-agents-skills-probe.md` · `b1b-default-skill-home.md` ·
`b2-borrow-surface.md` · `b3-bundled-extension-registry.md` · `b4-codex-import.md`。
