# OpenChamber 气泡对话重构 — 台账

> 分支：`feat/openchamber-chat-refactor`  
> 权威：[`2026-07-23-openchamber-chat-refactor-ard.md`](./2026-07-23-openchamber-chat-refactor-ard.md)  
> 术语：[`../../CONTEXT.md`](../../CONTEXT.md)  
> Phase 0 证据：[`phase0-report.md`](./phase0-report.md)  
> 最后更新：2026-07-23

**维护规则**：每完成一个关键节点（可合并的里程碑 / Phase 子目标），更新本台账「状态总览 + 检查点 + 下一步」，并附关键提交 hash。不要把旧 `PROGRESS.md`（bug 清单 / 已废弃拷贝路线）当本主线台账。

---

## 状态总览

| Phase | 名称 | 状态 | 说明 |
|---|---|---|---|
| 0 | 技术 Go/No-Go | 🟡 Conditional Go | 开发机项基本完成；TSD / 打包 / Permission 未齐 |
| 1 | UI Shell（Mock） | ✅ 完成 | 四区壳可交互；Beta 开关接入 |
| 2 | Runtime Vertical Slice | 🟡 进行中 | Host + Main/IPC 已通；Chat Store / UI 待接真事件 |
| 3 | Chat MVP | ⬜ 未开始 | |
| 4 | 现有能力重新接线 | ⬜ 未开始 | |
| 5 | 收口与正式版 | ⬜ 未开始 | |
| 6 | 按需增强 | ⬜ 后置 | |

图例：✅ 完成 · 🟡 条件通过 / 进行中 · ⬜ 未开始 · ⏳ 待特定环境 · ❌ 阻塞

---

## 已拍板决策（勿再争论）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 运行时宿主 | 外部白名单 Node 24 Agent Host；不升 Electron |
| D2 | UI/数据层 | 自建 UI on `@coss/ui`；不拷 OpenChamber sync/store |
| D3 | 导航 | Project > Workspace > Session；保留 Worktree |
| D6 | 视觉 | 对齐布局架构，非色调；沿用 OKLCH |
| D8 | Cometix | 打包进 Host；固定 `2.1.212` |
| D9 | Host 驱动 | **默认 `agent-sdk`**；`stream-json` fallback（`DEFAULT_AGENT_HOST_DRIVER`） |
| D10 | 其他 Agent | 暂留终端模式；仅 Claude 进气泡 |
| D11 | 历史 | Host 读 CC JSONL；本地只存索引 |
| D15 | 右栏 | MVP 单层 `git \| files \| context` |

---

## 检查点（按时间）

| 日期 | 节点 | 结果 | 关键提交 |
|---|---|---|---|
| 2026-07-23 | 文档基线：ARD + CONTEXT | ✅ | `ed93202` |
| 2026-07-23 | Phase 0：Node24 Resolver / Host 骨架 / Cometix pin / 双路线 spike | ✅ Conditional | `e36dbbe` |
| 2026-07-23 | Phase 1：四区 Workspace Shell + Mock Runtime | ✅ | `259e863` |
| 2026-07-23 | Phase 0 报告（初版，后有纠正） | ✅ | `335ba02` |
| 2026-07-23 | 多轮对比脚本；纠正「stream-json 更快」误判 | ✅ | `ac8d021` |
| 2026-07-23 | API settings.env 注入后：双路线均可 resume 召回 | ✅ | `fcc8c81` |
| 2026-07-23 | **默认驱动改为 Agent SDK** | ✅ | `7db1424` |
| 2026-07-23 | 本台账落地 | ✅ | `902a9f5` |
| 2026-07-23 | **Phase 2 节点 1：Host settings + Cometix + SDK Adapter + Normalizer** | ✅ | `c0aaf14` |
| 2026-07-23 | **Phase 2 节点 2：Main session API + Chat IPC + Runtime Event 推送** | ✅ | （本提交） |

---

## Phase 0 明细

| 项 | 状态 | 备注 |
|---|---|---|
| Node 24 resolver + 版本校验 | ✅ | nvm `v24.18.0` |
| Cometix pin + SHA256 | ✅ | `2.1.212` / 见 `src/agent-host/PINNED.md` |
| Agent SDK spike（结构化事件） | ✅ | 多轮 resume 通过 |
| stream-json spike | ✅ | fallback 保留 |
| 多轮连续上下文对比 | ✅ | 两边均可召回 `ORANGE-42` |
| Host 启停无孤儿（开发态） | ✅ | |
| Stop 成功路径 | 🟡 | Host + Main IPC 已接；UI 未接 |
| Permission 桥接 | ⬜ | Phase 2 下一节点（Host stub + IPC 已预留） |
| Resume 进 Host 协议（非仅 spike） | 🟡 | `session.resume` + `chat:resumeSession` 已接；历史重放仍 Phase 3 |
| Effort/Plan/Build 探测 | ⏳ | 条件性 UI |
| TSD 解密读 | ⏳ **待加密机** | 开发机不得冒充通过 |
| 打包 Electron 启 Host | ⏳ | 打包态未验 |

详见 [`phase0-report.md`](./phase0-report.md)。

---

## Phase 1 明细

| 项 | 状态 | 备注 |
|---|---|---|
| 左栏全高（菜单 / 项目会话 / 底设置） | ✅ | |
| 主区顶栏 | ✅ | |
| Chat + Composer（Mock） | ✅ | |
| 单层右栏 git\|files\|context | ✅ | 默认可折叠 |
| 底栏 Terminal Dock 占位 | ✅ | |
| Mock Runtime Event 驱动状态 | ✅ | |
| Beta 开关 | ✅ | Settings → Appearance |
| 接真 Runtime | ⬜ | Phase 2 节点 3 |

验证：`pnpm dev` → Appearance → 打开 **OpenChamber Workspace Shell**。

---

## Phase 2 明细

目标闭环：**新建 Session → 发送 → 流式文本 → 一个 Tool → Stop → idle**（默认 Agent SDK）。

| 项 | 状态 | 备注 |
|---|---|---|
| Host 加载 `~/.claude/settings.json` env | ✅ | `claudeSettings.ts`；`host.ready.settings` 脱敏诊断 |
| Cometix `cli.js` 解析 | ✅ | `cometix.ts`；pin `2.1.212` |
| SDK Runtime Adapter | ✅ | `claudeRuntime.ts`：create / resume / send / stop / close |
| Event Normalizer | ✅ | `eventNormalizer.ts` → 稳定 Runtime Event |
| Session Registry | ✅ | `sessionRegistry.ts` |
| Host 协议命令接线 | ✅ | `index.ts` 接 session.*；permission/question 仍 stub |
| Stop（Host 侧） | ✅ | AbortController；smoke `STOP_AFTER_MS` 通过 |
| 协议 smoke | ✅ | `spikes/phase2-sdk-runtime-smoke.ts` → `PONG` |
| Main：命令/事件 + IPC 推送 | ✅ | `AgentHostManager` session API；`ipc/chat.ts`；`CHAT_RUNTIME_EVENT` |
| Preload `electronAPI.chat` | ✅ | create/send/stop/close + `onRuntimeEvent` |
| Chat Store 接真事件 / Composer Stop | ⬜ | **下一步** |
| Permission 桥 happy path | ⬜ | |
| Tool 事件进时间线（UI） | ⬜ | Normalizer 已发 tool.*；UI 未接 |
| stream-json Adapter | ⬜ | fallback，可后置 |
| Resume 历史重放 | ⬜ | 顺延 Phase 3 |

### 节点 1 验收证据

```bash
cd src/agent-host
node --experimental-strip-types spikes/phase2-sdk-runtime-smoke.ts
# ok: true，assistantPreview: "PONG"
```

注意：SDK `options.executable` 须传 **绝对 Node 路径**（`process.execPath`）。

### 节点 2 验收要点

- Renderer：`window.electronAPI.chat.ensureHost()` → `createSession` → `send` → `onRuntimeEvent`
- Main 将 Host stdout Runtime Event 广播至所有窗口（`chat:runtimeEvent`）
- Host 生命周期仍可用 `electronAPI.agentHost.*`

---

## 下一步（Phase 2 续）

建议顺序：

1. ~~Host：加载 settings.env + Cometix；SDK Runtime Adapter~~ ✅ `c0aaf14`  
2. ~~Event Normalizer → 稳定 Runtime Event~~ ✅  
3. ~~Main：`AgentHostManager` + Chat IPC + Runtime Event 推送~~ ✅（本节点）  
4. **Chat Store：替换 Mock，接真事件；Composer 发送 / Stop** ← 当前  
5. Permission 桥（时间线卡片）至少一条 happy path  
6. Tool 卡进时间线；Resume 会话身份（历史重放可顺延 Phase 3）

完成上述任一可演示切片后，在本台账「检查点」追加一行。

---

## 环境与约束备忘

- 开发机：正常环境，无 TSD；可做 Node / Cometix / SDK / Host / 布局壳  
- 加密机：TSD 解密、白名单读文件验收  
- 不要按旧 PROGRESS「拷 OpenChamber UI + 升 Electron + 弃 Worktree」路线做  

---

## 关键路径速查

```text
docs/plans/2026-07-23-openchamber-chat-refactor-ard.md   # 权威
docs/plans/phase0-report.md                              # Phase 0 证据
docs/plans/openchamber-chat-refactor-ledger.md           # 本台账
CONTEXT.md                                               # 术语
src/agent-host/                                          # Node 24 Host
src/main/services/agent-host/AgentHostManager.ts         # Main 侧命令 API
src/main/ipc/chat.ts                                     # Chat IPC + 事件广播
src/preload/index.ts                                     # electronAPI.chat
src/renderer/components/workspace-shell/                 # 四区壳
src/renderer/stores/chatSessions.ts                      # Chat Store（现 Mock）
```
