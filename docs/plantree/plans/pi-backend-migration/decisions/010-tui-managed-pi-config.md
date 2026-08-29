# D10 — TUI 直通模式使用公司 Pi 配置

> 用户补充拍板 2026-08-28：Q8 选择向 TUI 的 pty 注入 `PI_CODING_AGENT_DIR`，TUI 也使用公司模型。

## 决策

登录/受管模式下，应用内 **agent 类型**的本地 PTY 注入：

- `PI_CODING_AGENT_DIR=~/.pilab/<profile>/pi-agent`
- 公司 key 不进入 `models.json`；客户端同步时写入同一隔离目录的 `auth.json`（0600）

普通 terminal 类型 PTY 不注入该目录；“Use my own setup” 模式完全不注入，继续读取用户自己的 `~/.pi/agent`（或用户自行设置的 `PI_CODING_AGENT_DIR`）。远程 PTY 不在本次注入范围。

## 理由与影响

- Pi 原生支持 `PI_CODING_AGENT_DIR`，与 Codex 无法仅靠 env 改 `base_url` 的 D66 技术条件不同。
- GUI utilityProcess 与 TUI PTY 共用同一受管目录，模型菜单、GUI 回合和 TUI 不再出现配置分叉。
- key 落在应用隔离目录的 `auth.json`，不污染用户的 `~/.pi/agent`，登出时清除受管 `auth.json`，模型元数据缓存可保留用于降级。
