# Open Questions — Pi Backend Migration

## 已解决

### ~~Q1 — pi SDK 的进程模型选择~~ → D3 (rev2)

直接走 utilityProcess + MessagePort，不经过独立 Node 进程中间态。pix 已验证此路径可行。

### ~~Q2 — pi SDK 认证流程~~ → D4

双路径：企业自动注入 + 本地 GUI 配置窗口。与 unified-credentials S4 对接。

### ~~Q3 — 现有 Claude/Codex 功能的保留策略~~ → D5

先屏蔽（代码不删，配置项控制），后续可切回。

### ~~Q4 — 扩展兼容范围~~ → D6

TUI-only 插件通过模式切换使用。Phase 2 前做一次主流扩展 UI 原语调研仍有价值，但不阻塞。

### ~~Q5 — pi SDK 打包进安装包~~ → D7

pi SDK 是纯 JS 包（21.4MB），无平台二进制。作为 npm 依赖安装，esbuild external + node_modules 子树随 Electron 打包。体积 ~40-60MB，远小于 Codex 的 ~300MB。

### ~~Q6 — piRuntime 事件映射与渲染器事件格式的差异~~

**已解决（2026-08-28 用户真机实测）**：发送 `hi` 后流式回复正常显示，`projectEvent()` 重写（T06-a）验证通过。

原差异三点：① pi SDK 主要通过 `event.message.content` 发累积快照而非 `assistantMessageEvent.delta` 增量（pi-app 参考实现用 `assistantStreamDeltaFromMessageUpdate()` 做快照→增量转换）；② 渲染器期望 `message.started` 带 messageId+role、`message.delta` 带 messageId+blockId+text、thinking 独立事件，原实现全缺；③ 工具事件要 `name`/`input` 对象而非 `toolName`/JSON 字符串。

### ~~Q8 — TUI 直通模式下，公司受管模型要不要向终端 pty 注入 pi 配置~~ → D10

**已解决（2026-08-28 用户补充拍板）**：向登录模式的 agent PTY 注入 `PI_CODING_AGENT_DIR`，TUI 与 GUI 共用 `~/.pilab/<profile>/pi-agent` 下的公司模型配置；key 位于隔离 `auth.json`，不进 `models.json`。普通 terminal、“Use my own setup” 与远程 PTY 不注入。见 [D10](./decisions/010-tui-managed-pi-config.md)。

## 未解决

### Q7 — pi SDK 模型/API key 配置路径

**发现时间**：2026-08-28 真机首跑

用户选 "Use my own setup" 后发 "hi"，pi SDK 内部抛 `Cannot read properties of undefined (reading 'startsWith')`——疑似 SDK 内部解析模型标识符时值为 undefined。

**状态（2026-08-28）**：真机重测中 `hi` 正常回复，`startsWith` 报错未复现——可能与首次运行的空配置态有关。模型菜单错位问题已另立 [D8](./decisions/008-model-config-strategy.md) / [topics/model-config.md](./topics/model-config.md)。Q7 保留待观察：若后续再出现 undefined 模型标识符，沿 `getAgentDir()` → models.json 缺省路径排查。

### Q9 — 登录模式的默认权限策略

**发现时间**：2026-08-28（D9 rev.2：采用 `@gotgenes/pi-permission-system`）

权限插件与 GUI 审批链已拍板，但默认策略尚未定。至少需要决定：

- 文件 read/write/edit、bash、MCP、skill 的默认 allow / ask / deny；
- `path` 横切规则（如 `.env` / `~/.ssh/*`）的默认 deny 面；
- `external_directory` 是否默认 ask；
- 「Yes for this session」是否允许生成建议 pattern；
- 登录模式受管策略能否被本地用户配置放宽，还是只能更严格。

**待用户拍板**（T08-c 开工前）。在此之前 T07/T11/T08/T08-a/T08-b 可做协议、桥接、插件随包与 UI 闭环，但不得自造默认安全策略。

**2026-08-28 更新（T08-a/T08-b 落地后）**：前置五项已全部完成，且**没有**自造任何默认策略——随包的插件不带 policy 配置文件。实测插件自身兜底为所有 surface 一律 `ask`（`rule.ts:112` `defaultAction ?? "ask"`，另有 `rule.ts:86` 显式 `origin: "fail-closed"` 分支）。

因此当前状态是「全部询问」，安全但话多：每次读文件、每条 bash 都会弹窗。Q9 要决定的实质是**把哪些 surface 从 ask 放宽到 allow**，属于「减少打扰」而非「补上防护」——这改变了它的紧迫性，但不改变它仍需用户拍板这一点（放宽安全边界不是可以替用户默认的事）。

拍板时可参考插件 `config/config.example.json` 的示例分档，以及 `schemas/permissions.schema.json` 里对 `path` / `external_directory` 两个横切面的说明：`path` deny 无法被单工具 allow 覆盖；`external_directory` 的 ask 也无法被 `path` allow 放宽（最严格者胜）。

## 已尝试但失败的方案

### F1 — 直接从 `assistantMessageEvent.delta` 读取文本增量

**时间**：Phase 1 初始实现
**失败原因**：pi SDK 的 `message_update` 事件中 `assistantMessageEvent` 可能为 undefined（此时文本在 `event.message.content` 上），导致渲染器显示 `undefinedundefinedundefined`。正确做法是优先从 `event.message.content` 提取快照并转增量，`assistantMessageEvent` 作为 fallback。

### F2 — env 对象中传 `ELECTRON_RUN_AS_NODE: undefined` 来取消设置

**时间**：Phase 1 初始实现
**失败原因**：Electron 的 `utilityProcess.fork()` 不接受 env 值为 undefined（抛 `TypeError: Invalid value for env`）。正确做法是遍历 `process.env` 时跳过该键。
