# OpenChamber 气泡对话重构 — 总台账

> 分支：`feat/openchamber-chat-refactor`  
> 权威：[`2026-07-23-openchamber-chat-refactor-ard.md`](./2026-07-23-openchamber-chat-refactor-ard.md)  
> 执行计划：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md)（双轨任务表 + 协作规则）  
> 术语：[`../../CONTEXT.md`](../../CONTEXT.md)  
> Phase 0 证据：[`phase0-report.md`](./phase0-report.md)  
> 最后更新：2026-07-23

**维护规则**：每完成一个关键节点（可合并的里程碑 / Phase 子目标），更新本台账「状态总览 + 检查点 + 下一步」，并附关键提交 hash。不要把旧 `PROGRESS.md`（bug 清单 / 已废弃拷贝路线）当本主线台账。

**分账规则（自 2026-07-23 起双轨执行）**：本文件只保留 **Phase 状态总览、拍板决策、里程碑级检查点与确认点（CP-x）结果**。过程明细分两条子台账记录：

| 轨道 | 范围 | 台账 | 维护人 |
|---|---|---|---|
| 🤖 Claude 主线 | 复杂/架构攸关任务（C-xx：打包链、协议、Host、Store 结构、探测类） | [`ledger-claude-mainline.md`](./ledger-claude-mainline.md) | Claude |
| 👥 团队轨道 | 常规实现 / GUI 打磨 / 真机与加密机验收（T-xx） | [`ledger-team-track.md`](./ledger-team-track.md) | 用户 / 同事 |

任务归属、依赖与验收标准以执行计划为准；里程碑（M1 打包链通 / M2 加密机验收 / M3 Chat MVP / M4 接线 / M5 收口）完成时回填本文件检查点。

---

## 状态总览

| Phase | 名称 | 状态 | 说明 |
|---|---|---|---|
| 0 | 技术 Go/No-Go | 🟡 Conditional Go | 开发机项基本完成；TSD / 打包未齐 |
| 1 | UI Shell（Mock） | ✅ 完成 | 四区壳可交互；Beta 开关接入 |
| 2 | Runtime Vertical Slice | 🟡 进行中 | Host→UI 主路径 + Permission 桥已通；Question/Resume 待补 |
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
| D16 | vflow | **整体移除**（用户拍板 2026-07-24，不再需要）：Phase A 打包/CI 链 `dbb20be` + Phase B 运行时代码 `eac23f7`，全仓 vflow 引用清零 ✅ |
| D17 | Host Node 来源 | **随包独立 Node（打包态首选）+ 现有五源解析兜底**（用户拍板 2026-07-24）。依据：TSD 白名单**按进程名**——「只要是 node 就是白名单」（用户口径；注意 Electron 内嵌 node 进程名是 electron.exe **不**匹配，ARD 当年否决内嵌路线的理由依然成立）；随包 node.exe 同时解 T-09「用户自装 Node 24」痛点。→ 立项 **C-15**；加密机实证（白名单口径 + 随包 node 读 TSD）归 T-11，开发机不得标注通过 |

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
| 2026-07-23 | **Phase 2 节点 2：Main session API + Chat IPC + Runtime Event 推送** | ✅ | `ea0286b` |
| 2026-07-23 | **Phase 2 节点 3：Chat Store 接真 Runtime + Composer Send/Stop** | ✅ | `76632cf` |
| 2026-07-23 | **Phase 2 节点 4：Permission 桥 happy path** | ✅ | `5cd5163` |
| 2026-07-23 | **CP1：双轨执行计划定稿 + 分账结构落库** | ✅ | 执行计划 + 两条子台账 |
| 2026-07-23 | **C-01：agent-host 构建产物 + electron-builder 打包配置（M1 前半）** | ✅ | `f21fec7` |
| 2026-07-24 | vflow 打包链摘除（D16 Phase A）+ `pnpm test` 首次全绿 111/111 | ✅ | `dbb20be` |
| 2026-07-24 | **Host 行为变化通知**：SDK 流结束无 result 时补发终态事件（有输出→completed+idle；无输出→failed）——修团队定位的「UI 永驻 running」；无新事件类型、无协议 bump | ✅ | `6a633d6` |
| 2026-07-24 | **C-02：打包态自动化验证 PASS（M1 自动化半边齐）** — portable 产物 + `pnpm verify:packaged` 22 项全绿（含打包产物网关 PONG）；GUI 点验移交 T-10 | ✅ | `dbb20be` |
| 2026-07-24 | vflow 运行时代码摘除（D16 Phase B 收口，全仓引用清零） | ✅ | `eac23f7` |
| 2026-07-24 | 用户反馈 F1-F5 映射进计划（§7）；新增 C-13 附件协议 + T-18 Composer 粘贴 | ✅ | 执行计划 §7 |
| 2026-07-24 | **C-07：Session Index（Main 持久化 + 3 条 chat IPC）完成，T-02 解锁** | ✅ | `f6807c9` |
| 2026-07-24 | **CP4：`session.history` 协议定稿（用户确认）** — 协议文档 [`2026-07-24-c06-session-history-protocol-draft.md`](./2026-07-24-c06-session-history-protocol-draft.md) 即 T-03 接口契约。协议纯增量不 bump：新事件 `session.history`/`session.historyListed`/`session.updated` + 新命令 `session.listHistory` + `host.ready.capabilities.history`。**团队注意**：① T-03 数据层随 C-06 实现落地后解锁（本行仅协议定稿）；② running 会话 resume 将被拒（`session_busy`）；③ 历史消息 id 带 `h:` 前缀为契约。fresh-fable 对抗评审 GO-WITH-CHANGES 12 findings 全采纳（明细见主线台账） | ✅ | 协议文档 |
| 2026-07-24 | **CP3：Question/Thinking/Effort-Plan/附件 探测结论 + 用户拍板** — ① Question 卡可做（AskUserQuestion 走 canUseTool 权限流是官方机制，答案经 updatedInput.answers 回传）→ C-04 开工；② **Thinking 开启且默认开**（多轮零 400，disable 防御过时；延迟成本已知悉）→ capabilities.thinking=true，**T-04 解锁**；③ Effort/Plan：仅 xhigh 有实证、plan 非硬只读 → **新开 T-20**（原拟 T-19，让位消息队列提案）（effort 控件，开工前按官方文档调研实际档位，不止 default/xhigh 两档；plan UI 暂缓等主线 canUseTool 只读约束）；④ 附件可行 → C-13 桥接实现排队（解锁 T-18 在即）；⑤ **C-14 立项**（Host 无事件超时看门狗，排 C-04 后）。四 spike `9bda9e5`、结论 `a179955` | ✅ | 见左 |
| 2026-07-24 | **C-06：Resume 历史重放全链实现完成，T-03 解锁** — Host historyReader + runtime 时序/session_busy + Main `chat:listHistory` IPC/preload + store `h:` 前缀灌入；新增 49 单测（全套 181 绿）；网关端到端 smoke `spikes/c06-resume-history-smoke.ts` ok:true（含历史召回码字验法）。**T-03 可开工**：数据流 = 点击历史会话 → `chat:resumeSession` → 事件 `session.resumed → session.history → status idle` 自动灌入 store（消息 id `h:*`）；列表合并数据源 = `chat:listSessions`（C-07 索引）+ `chat:listHistory`（盘上 CLI 会话，含 title）；历史读失败看 store `historyErrors[sessionId]`（非阻断） | ✅ | `db41f63` |

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
| Stop 成功路径 | ✅ | Host Abort + UI Stop 已接 |
| Permission 桥接 | ✅ | Phase 2 节点 4；unit smoke 通过 |
| Resume 进 Host 协议（非仅 spike） | 🟡 | `session.resume` + `chat:resumeSession` 已接；历史重放仍 Phase 3 |
| Effort/Plan/Build 探测 | ⏳ | 条件性 UI |
| TSD 解密读 | ⏳ **待加密机** | 开发机不得冒充通过 |
| 打包 Electron 启 Host | 🟡 | C-02 自动化冒烟通过（打包产物 Host 直跑 PONG + Node24 寻径）；GUI 启动点验 → T-10 |

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
| 接真 Runtime | ✅ | Phase 2 节点 3：Chat Store → `electronAPI.chat` |

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
| Host 协议命令接线 | ✅ | session.* + `permission.respond`；question 仍 stub |
| Stop（Host 侧） | ✅ | AbortController；smoke `STOP_AFTER_MS` 通过 |
| 协议 smoke | ✅ | `spikes/phase2-sdk-runtime-smoke.ts` → `PONG` |
| Main：命令/事件 + IPC 推送 | ✅ | `AgentHostManager` session API；`ipc/chat.ts`；`CHAT_RUNTIME_EVENT` |
| Preload `electronAPI.chat` | ✅ | create/send/stop/close + `onRuntimeEvent` |
| Chat Store 接真事件 / Composer Stop | ✅ | 替换 Mock；`session-live` 发真 Host；Composer 有 Stop |
| Permission 桥 happy path | ✅ | `permissionBridge.ts` + `canUseTool`；unit smoke 通过 |
| agent-host 打包产物（C-01） | ✅ | `pnpm build:agent-host` → `out-agent-host/`（87MB）；产物 PONG/permission smoke 通过 |
| 打包态整链验证（C-02） | ✅ | afterPack 拷贝产物（extraResources 有 node_modules 排除与 rcedit 竞态两坑，见主线台账）；`pnpm verify:packaged` 22 项全绿；CI 两作业已接 agent-host 构建+断言 |
| Tool 事件进时间线（UI） | 🟡 | Store/UI 已支持；依赖模型实际调工具 |
| stream-json Adapter | ⬜ | fallback，可后置 |
| Resume 历史重放 | ✅ | C-06（Phase 3 项提前收口）：`session.history` 协议 + Host 读 JSONL + store 灌入，`db41f63` |
| Question 桥 | ⬜ | **下一步** |

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

### 节点 3 验收要点

- Settings → Appearance → 打开 OpenChamber Workspace Shell
- 选中 **Live Agent Host**，发送短 prompt（如 `Reply with exactly: PONG`）
- 时间线出现 user + assistant 流式文本；运行中可 **Stop**

### 节点 4 验收要点

```bash
cd src/agent-host
node --experimental-strip-types spikes/phase2-permission-bridge-unit.ts
# ok: true — request→respond allow；abort→deny

node --experimental-strip-types spikes/phase2-permission-smoke.ts
# ok: true — Write 触发 permission.requested → respond(allow) → tool.completed → PERM-OK
```

UI：时间线 Permission 卡 → Allow/Deny → `chat:respondPermission` → Host 继续/拒绝工具。  
Host 选项要点：`tools: claude_code` preset；`settingSources: []`（避免 settings.allow 阴影 canUseTool）；`thinking: disabled`；勿设 bare `allowedTools`。

---

## 下一步（双轨并行，详见执行计划）

- 🤖 **Claude 主线**：C-01 ✅ C-02 ✅（CP2 待 T-10 GUI 点验合并汇报）C-07 ✅ C-06 ✅（CP4 定稿 + 实现）→ C-03/C-04 Question 桥 → C-05 Thinking 探测（CP3）→ C-13 附件协议（F2）
- 👥 **T-02 已解锁**：`chat:listSessions/renameSession/archiveSession` + preload 就绪；store hydrate 建议在 `initRuntime` 接 `listSessions()` 替换 demo 种子（见主线台账 C-07 行）
- 👥 **T-03 已解锁**：resume 数据层全就位（协议文档 = 契约；消费指引见检查点 C-06 行）；注意历史消息无 T-06 元数据行（model/timestamp 在消息体内自带）、thinking 历史协议已携带但渲染等 C-05/T-04
- 🧪 **测试凭证统一约定**（用户拍板 2026-07-23）：测试不得用本机默认 Claude 登录，统一走网关 `https://cch-jyw.pipidan.qzz.io`；详见执行计划 §4
- 👥 **团队轨道**：T-17 Tool 真实调用 GUI 验收（立即可做）→ T-01 真实数据树 → 无依赖池 T-06~T-09 → 等主线解锁后 T-02/T-03 → T-10/T-11（M2 加密机，CP5）

过程明细分别记入两条子台账；里程碑达成回填本文件检查点。

---

## 环境与约束备忘

- 开发机：正常环境，无 TSD；可做 Node / Cometix / SDK / Host / 布局壳  
- 加密机：TSD 解密、白名单读文件验收  
- 不要按旧 PROGRESS「拷 OpenChamber UI + 升 Electron + 弃 Worktree」路线做  

---

## 关键路径速查

```text
docs/plans/2026-07-23-openchamber-chat-refactor-ard.md   # 权威
docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md  # 双轨执行计划
docs/plans/phase0-report.md                              # Phase 0 证据
docs/plans/openchamber-chat-refactor-ledger.md           # 本总台账
docs/plans/ledger-claude-mainline.md                     # 🤖 Claude 主线台账
docs/plans/ledger-team-track.md                          # 👥 团队轨道台账
CONTEXT.md                                               # 术语
src/agent-host/                                          # Node 24 Host
  permissionBridge.ts / claudeRuntime.ts / eventNormalizer.ts
src/main/services/agent-host/AgentHostManager.ts         # Main 侧命令 API
src/main/ipc/chat.ts                                     # Chat IPC + 事件广播
src/preload/index.ts                                     # electronAPI.chat
src/renderer/components/workspace-shell/                 # 四区壳
src/renderer/stores/chatSessions.ts                      # Chat Store（真 Runtime）
```
