# Completed Plan — OpenChamber Chat/Product Baseline

> **状态**：Completed product baseline。原 Claude-era activity view 已归档；当前 conversation architecture 与任务权威是 [Pi-only plan](../pi-backend-migration/README.md)。

## 保留价值

本计划建立了当前桌面产品外壳与大量 runtime-neutral 行为：

- 三列 + rail Workspace Shell、surface registry 和 responsive layout；
- chat timeline、Composer、tool rows、thinking、Markdown、attachments；
- queue/pending/retry/stop 与 session buckets；
- repository/worktree、files/editor/preview、git 和 terminal surfaces；
- welcome/entry、theme、i18n、accessibility 与 GUI/packaged testing lessons。

Cycle 1/2 及 Pi T12 已在这些资产上继续演进。它们属于 `retain` 或 `adapt`，不是随 Claude/Codex runtime 一起删除的 legacy UI。

## 不再活动

- Claude 主线、Codex/multi-agent 登录或 runtime Next；
- 旧 C-xx/T-xx 队列作为当前实施顺序；
- 旧 AgentPanel/Claude JSONL/permission/question bridge 作为产品权威；
- 由本计划驱动新的 backend 设计。

## 阅读路径

| 文件 | 当前角色 |
|---|---|
| [roadmap.md](./roadmap.md) | 历史里程碑摘要和 Pi-only 复用分类 |
| [implementation-status.md](./implementation-status.md) | completed handoff |
| [open-questions.md](./open-questions.md) | 遗留项重新归口，不含活动 Claude backlog |
| [history/](./history/) | 详细点验、旧 active state 与决策叙事 |
| [重排前快照](./history/2026-08-31-pre-pi-only-realignment/) | 2026-08-31 前三份活动文档全文 |

视觉实现仍须遵守 [`docs/design-system.md`](../../../design-system.md) 和已接受基线；Pi-only transport 替换不得无理由重做已验证产品交互。
