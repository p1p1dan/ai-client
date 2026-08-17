# D48 调查轮索引 — Codex CLI 选择功能（阶段 3）

> 2026-08-16 四路调查全落库。立项拍板 = [总台账 D48](../openchamber-chat-refactor-ledger.md)；状态权威 = plantree multi-agent 行。

| 篇 | 主题 | 关键结论 |
|---|---|---|
| [00](./00-code-surface.md) | 代码面摸底 | `capabilities.agents` 全链已通但 UI 零消费；agent 物化点 = 首条消息 `sendMessage()`；新入口自然落点 = `ComposerModelTrigger` 同级；三轴隔离有静态断言保护 |
| [01](./01-codex-model-catalog.md) | 模型目录半边 + cch 线索 + D40 状态 | Codex 三套目录全是本地静态表不查代理；Claude 轴同构（静态 3 短名）；D40 Claude 轴已全链落地、**Codex 轴显式丢弃 per-turn model/effort**；cch 部署版非 vanilla zsio（候选 ding113 分叉），模型可用面取决于**部署实例供应商配置**而非源码 |
| [02](./02-permission-management.md) | 权限管理面现状 | 读侧 Claude 全通 / Codex 断链（Context 面板整行消失）；写侧零存在（无存储位无 IPC）；两轴各有未实证的中途改档协议半通道（SDK `setPermissionMode` / codex `thread/settings/update`） |
| [03](./03-codeg-ui-reference.md) | codeg 三块 UI 参照 | segmented pill + 琥珀点未安装态 + 落库锁定（与 D48 ② 同构）；目录 = 会话回包驱动（直连须换轴）；权限三层（实时 modes / config_options 简化面 / Settings 线程默认）+ 单次审批独立概念 |
| [04](./04-cch-live-probe.md) | cch 模型面线上实证（用户拍板拿 key 实测） | 双轴 `/v1/models` 可信（codex 10 条 / claude 15 条全长名）；**短名别名不被 cch 接受**；codex effort 实证五档（ultra 报错）与 Claude 轴一致 → **D40 Codex 半边丢弃理由已消除**；越界显式报错非静默 |

## 汇总：必须在规格前实证或裁定的事项

**线上实证**：~~1 模型白名单~~ ~~2 model/effort 参数行为~~ ~~3 effort 词表~~ —— ✅ 已由 [04](./04-cch-live-probe.md) 全部实证（2026-08-16 用户拍板拿 key 实测）。残留一条：
4. SDK `setPermissionMode` 在非 streaming-input 下的失败模式；codex `thread/settings/update` 的 schema 与实效（契约疑欠采）——权限半边探针，不阻塞目录设计。

**规格轮裁定项（设计问题，进双轨）**：agent 入口交互形态与不可用态表达 · Codex 断链的权限读侧补全 · 权限写侧要不要进本阶段首切片 · 模型目录的统一抽象与 per-agent 枚举 · D40 Codex 半边补齐路径 · 持久化位置（localStorage vs session-index）。
