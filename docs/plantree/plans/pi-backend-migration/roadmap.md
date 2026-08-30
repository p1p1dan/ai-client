# Roadmap — Pi Backend Migration

## Phase 1 — 接 SDK + 打包（后端替换）

> 参考：pix `agent-host`（utilityProcess 架构） + pi-app SDK 集成方式
> 进程模型：utilityProcess + MessagePort（D3 rev2）
> Phase 1 实施顺序：T01 → T02 → T03 → T05 → T00 → T04 → T06（已完成）
>
> **2026-08-28 重新规划后的近期主线（仅规划，未授权施工）**：
> 1. **模型闭环**：T19 本地模型目录 → T20 选中模型真实生效；
> 2. **权限闭环**：T07 contracts → T11 bridge → T08 UI 原语 → T08-a 插件随包 → T08-b 审批闭环（T08-c 默认策略等 Q9）；
> 3. **GUI 体验重构**：T12 气泡/时间线外壳 → T12-a~d 工具、思考、流式与交互（直接取用 pi-app MIT 实现）；
> 4. **受管模式**：T21 隔离 agentDir + key 注入；T22 等公司管理页；T23 随 T16。
>
> 排序原则：先补「选了不能生效/无审批」等功能缺口，再做气泡与工具显示；本仓独有但参照项目没有的按钮/附加功能后置。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T00 | 屏蔽 Claude/Codex 路径（D5） | **Done** | `ACTIVE_BACKEND = 'pi'` 硬编码在 `AgentHostManager.ts`，走 `PiHostProcess`（utilityProcess），Claude/Codex 代码完整保留 |
| T01 | 安装 pi SDK + piRuntime.ts 核心逻辑 | **Done** | SDK 已装、`piRuntime.ts`（事件映射 + session 生命周期）、`agentWire.ts` 已加 `'pi'`、5038 测试全绿 |
| T02 | utilityProcess 入口 + MessagePort IPC 层 | **Done** | `piHost.ts`（utilityProcess 入口，接收 MessagePort 命令，分发到 PiAgentRuntime） |
| T03 | main 进程接入：spawn utilityProcess + 命令路由 | **Done** | `PiHostProcess.ts`（utilityProcess.fork + MessagePort 双向通信，同 AgentHostProcess 事件接口） |
| T04 | pi SDK 打包进安装包（D7） | **Done** | `ESBUILD_EXTERNAL` 加 pi SDK、`piHost.ts` 作为第二入口、agent-host deps 加 pi SDK、构建验证通过（piHost.js 18KB + pi SDK in node_modules） |
| T05 | 工作区信任适配（原名「权限桥接」） | **Done** | `projectTrusted: true` 只解决工作区是否可信，**不等于用户权限审批已完成**；工具审批另由 T08 系列接 `pi-permission-system`（D9 rev.2） |
| T06 | 冒烟测试：pi SDK 会话创建 → 发消息 → 收流式回复 → 会话关闭 | **Done (2026-08-28)** | 真机实测：发 `hi` 流式回复正常，Q6 事件映射验证通过；模型菜单错位另立 D8/T19 |
| T06-a | 事件映射修复：piRuntime.ts `projectEvent` 重写对齐 EventNormalizer 输出格式 | **Done** | 修复三类缺陷：① 缺 messageId/blockId（渲染器靠它们定位消息块）；② message_update 只看 assistantMessageEvent.delta，忽略 event.message.content 快照（pi SDK 主要用快照发文本）；③ 缺 thinking.started/thinking.delta 事件。2026-08-28 真机验证通过 |
| T06-b | 启动阻塞修复 | **Done** | ① `CREDENTIAL_MODE_SETTING_KEY` 循环块：vite 自动拆块 `shell→settings→shell`，pi SDK 依赖树变化触发，内联常量断开循环；② `utilityProcess.fork()` env 不接受 undefined 值：改为显式过滤 `ELECTRON_RUN_AS_NODE` |

## Phase 2 — Extension UI + 权限审批（D9 rev.2，提前到时间线重造之前）

> 参考：pi-app `features/extension-ui/` + worker RPC、pix `packages/contracts` / `EXTENSION_UI.md`、`@gotgenes/pi-permission-system`。**默认能直接取用 MIT 代码就取用**，不为维持旧布局重复实现。执行依赖：T07 → T11 → T08 → T08-a/b/c；完成后才进入 T12。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T07 | 定义 renderer ↔ agent-host 的 Extension UI contracts | **Done (2026-08-28)** | 走 pix contracts 体系。`extensionUi.request` 事件 + `extensionUi.respond` 命令 + 14 个 portable 方法表；两个边界守卫。另新增 `extensionUi.cancelled`：超时计时器在 bridge 侧，会话切换/关停也只在 bridge 侧，不告知渲染端就会留下点了没反应的僵尸弹窗 |
| T11 | Extension UI bridge：utilityProcess ↔ Main ↔ preload ↔ renderer | **Done (2026-08-28)** | 移植 pix `extension-ui-bridge.ts` → `src/agent-host/extensionUiBridge.ts`，接 `bindExtensions({ uiContext, mode:'rpc' })`。迟到响应/会话切换/重复应答由 runtimeId + pending map 双重判重；`setBeforeSessionInvalidate` 接 reload |
| T08 | Portable UI 原语：select / confirm / input | **Done (2026-08-28)** | 用 @coss/ui `AlertDialog`（design-system 组件优先），未手搓遮罩。含 editor。挂载于 ChatWorkspace 且不受 session 模式限制——扩展在 bind 期就可能发问 |
| T08-a | 随包并固定 `@gotgenes/pi-permission-system` | **Done (2026-08-28)** | pin 27.0.1；经 `additionalExtensionPaths` 传绝对本地路径（传目录不传文件：exports 入口与 pi 入口不是同一个文件）；用户已自装则不注入，否则每次工具调用弹两次。打包过滤特判 `.ts` 保留（该包运行入口是 TS）与 tree-sitter-bash 只留 wasm。+6.4MB |
| T08-b | 权限审批闭环：插件 ask → GUI → decision | **代码完成，验收未过（2026-08-29 降级）** | 确认非 TUI 走 `ui.select`/`ui.input`，四选项实跑捕获。补两处缺口：① 多行标题拆分（提示正文整段塞在标题位，是用户判断的全部依据）；② 内联扩展订阅 `permissions:ui_prompt`/`permissions:decision` → `permission.activity`（`policy_allow` 不弹窗，这是「被闸过」的唯一证据）。2026-08-29 审计修复批补齐 timeline 落地、Stop 排空、IPC 失败恢复与窗口路由。**从 Done 降级**：真机「模型发起工具调用 → 弹窗 → 允许/拒绝」这条链一次都没跑通过，Done 需要它 |
| T08-c | 默认权限策略与设置面 | **代码完成（两切片），验收未过 (2026-08-29)** | Q9 已拍板收口 → [D11](./decisions/011-default-permission-policy.md)。**切片 1**：务实档策略随包写进产物内插件目录的 `config.json`（最低优先级，用户/受管 agentDir 配置永远压得过它，绝不写用户的 `~/.pi`）+ path deny 面含 `~/<APP_STATE_DIR>/*` 保护自家凭据库 + `projectTrusted` 按凭据模式分叉（受管 `false`，本机 `true`）+ 构建期写入与产物断言 + smoke 升级绊线。**切片 2**：设置面 GUI —— 按插件语义镜像三层合并并显示来源归属，只让**受管 agentDir 那一层**可编辑（本机路线抛错拒写，红线同 T08-a），危险选择走二次确认，`yoloMode` 只报不给开关。同批修掉 dev 下随包策略根本不生效的不一致（`ensureDevPermissionPolicy`）。证据见 [evidence/t08c-permission-settings-panel.md](./evidence/t08c-permission-settings-panel.md)。**验收仍欠**：面板点验 + 策略真机生效 |
| T09 | Portable UI 原语：notify / setStatus / setWidget | Deferred | 标题栏通知 + 状态芯片 + Composer 卡片；非权限主线，可后置 |
| T10 | 三级能力分层框架：Portable / Semantic no-op / TUI-only | Deferred | 降级策略 + `unsupported` 诊断信号；不阻塞首版权限审批 |

## Phase 3 — GUI 时间线与气泡重构（D9 rev.2：直接取用 pi-app，保持本仓风格）

> 皮肤风格与主题令牌保留，但**布局、气泡形态、按钮位置均可调整**；用户明确认为当前气泡偏丑。pi-app 为 MIT，默认直接取用/改写其实现。我们独有而参照项目没有的按钮/功能降优先级，不阻塞核心体验。前置：T08 权限审批链完成。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T12 | 时间线外壳 + 输入/输出气泡视觉基线 | **Done（2026-08-29，用户看图确认「整体效果满意」）** | **T12-a 视觉基线**：提问气泡右对齐 80% + 右上切角（实测 `12px 4px 12px 12px`）+ **不再截断**；模型回复**去掉边框盒**；**`sticky` 吸顶条整条退役** —— 三件是同一条因果链（吸顶条→截断→`Show more`），一起退役。**T12-b meta 行退役**（用户拍板跟随 pi-app）：`Worked for · N tools` / 模型名 / 相对时间全部丢掉，复制 + `HH:MM` 进**悬停操作条**（`grid-rows-[0fr]→[1fr]`，`group/turn` 按回合作用域）；**`F-B15` 红线经用户知情后明确反转**（hover-only，键盘/触屏拿不到复制）；**进行中的状态行保留**（它与 meta 行只是碰巧共用一个槽，删掉会重现 F2「秒表丢了」）。四门全绿（typecheck 0 · biome 1045 文件 0/0 · **vitest 269 文件 5381 例**）· **变异 16/16 咬红**（两轮各 8）· 亮暗双主题真机 CDP 截图 7 张。⚠️ **GUI 抓到一个断言抓不到的缺陷**：折叠态操作条实测 28px 而非 0（`h-7` 从 pi-app 抄来，grid item 有确定高度就压不扁），三个类一个不缺、断言全绿 —— 已修并补「此行不许有任何高度类」的实测型钉子。⚠️ 未覆盖：流式态 · 悬停条的 `HH:MM`（合成 transcript 不走 event bus，拿不到 `completedAt`）· `fork`/`rewind`（归 T13）。证据见 [evidence/t12-timeline-shell-baseline.md](./evidence/t12-timeline-shell-baseline.md) |
| T12-a | display-items / turn-groups 数据建模 | Deferred | 优先直接移植 `timeline-display-items`/`timeline-turn-groups`；若现有 `chatTurn.ts` 能低成本承载则复用，否则替换，不为保留旧代码增加适配层 |
| T12-b | 工具行人话摘要、diff 徽记、原生预览 | Deferred | 直接移植 `tool-call-row`、`buildToolSummary`、`tool-previews`：Edit/Write diff、Read、Grep/Find、Bash、Ls；声明模板→原生预览→通用 default 三层 fallback |
| T12-c | 思考链、流式文本与 Markdown | Deferred | 直接取用 `thinking-chain-block`、`stream-text-reveal`；pi-app 与本仓 FB1-b markdown 分段实测对比后择优，不预设保留旧实现 |
| T12-d | 展开记忆、跟随滚动、底部锚点、问卷 | Deferred | 直接取用 `toolExpandBySession`、follow-scroll/bottom-anchor、questionnaire-dialog；问卷共用已完成的 T08 原语 |
| T13 | 会话管理：历史浏览 / 分支回退 | Deferred | 参考 pi-app 会话树；现有 sessionIndex 仅在低成本时复用，独有按钮后置 |
| T14 | 消息队列：agent 运行时可继续输入 | Deferred | 直接取用 `composer-pending-queue` 及相关状态模型 |
| T15 | 工作区文件预览集成 | Deferred | 多标签浏览、行级源码查看；非首轮气泡/工具体验阻塞项 |

## Phase 4 — 模式切换

> 参考：pix 视图/TUI 切换

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T16 | GUI 视图模式 ↔ TUI 直通模式切换机制 | Deferred | 一键切换，保留 xterm 作为 TUI 直通 |
| T17 | TUI-only 功能降级 UI 提示 | Deferred | 明确告知用户"此功能在 GUI 模式下不支持" |
| T18 | 模式状态持久化 | Deferred | 用户偏好记住上次模式 |

## Phase 5 — 模型配置链路（D8）

> 2026-08-28 立项。背景、pi-app 参考架构与目标架构见 [topics/model-config.md](./topics/model-config.md)；拍板见 [decisions/008](./decisions/008-model-config-strategy.md)。核心：**先读本地，管理页就绪后切换（D8-d）；key 永不进 models.json（D8-c）；隔离 agentDir（D8-a）**。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T19 | GUI 模型菜单对 pi 改读本地 pi 配置 | **Done (2026-08-28)** | Pi 独立目录分支读取本地/受管 `models.json` → `provider/model`；不读 Claude/Codex vault、不发网关请求、不经家族白名单 |
| T20 | 模型选择闭环：`session.create`/`send` 的 model 参数接通 pi SDK `getModel(provider, id)` | **Done (2026-08-28)** | `applySelectedModel()` 在 prompt 前调用 `getModel()` + `session.setModel()`；create 默认、send override、非法/不存在模型均有测试 |
| T21 | 隔离 agentDir（方案 B）：`PI_CODING_AGENT_DIR` 指向 `~/.pilab` 下受管目录 + 登录模式 key 注入 | **Done (2026-08-28)** | `~/.pilab/<profile>/pi-agent`；models/auth 分离，vault 新增可选 pi arm；utilityProcess 只在登录模式注入目录，本机模式零注入 |
| T22 | 管理页同步：登录模式启动拉取 → 校验 → 写隔离目录 | **Done (2026-08-28)** | `pnpm model-admin` 本地端口管理页 + GET/PUT API；启动/登录/手动同步；远端失败 → stale cache → 默认配置；设置页可改部署 URL |
| T23 | TUI 直通模式的模型配置策略 | **Done (2026-08-28, D10)** | 用户拍板 Q8：登录模式 agent PTY 注入 `PI_CODING_AGENT_DIR`，TUI 与 GUI 共用公司模型；普通 terminal/local/remote 不注入 |

## Done

- T01 — pi SDK + piRuntime.ts 核心逻辑
- T02 — piHost.ts（utilityProcess 入口）
- T03 — PiHostProcess.ts（main 进程侧）
- T05 — 工作区信任适配（projectTrusted；用户权限审批另见 T08 系列）
- T00 — 屏蔽 Claude/Codex（ACTIVE_BACKEND = 'pi'）
- T04 — 打包（esbuild + node_modules）
- T06-b — 启动阻塞修复（循环块 + env undefined）
- T06/T06-a — 冒烟通过（2026-08-28 真机：流式回复正常显示）
- T19~T23 — Phase 5 模型配置链路全落（本地/受管目录、模型选择、管理端同步、TUI 注入）；证据见 [evidence/phase5-model-config.md](./evidence/phase5-model-config.md)
- T07/T11/T08/T08-a — Phase 2 前四件已完成（契约、桥接、四种对话原语、权限插件随包）；证据见 [evidence/phase2-extension-ui-permission.md](./evidence/phase2-extension-ui-permission.md)
- **T08-b 与 T08-c 均代码完成但未验收**（真机审批 E2E + 策略真机生效未跑）；**T09/T10 仍 Deferred**。⇒ **Phase 2 未整体完成**
- T08-c 切片 1 — 默认权限策略与信任边界（D11 四条拍板全部落地）；证据见 [evidence/t08c-default-permission-policy.md](./evidence/t08c-default-permission-policy.md)
- T08-c 切片 2 — 权限策略设置面（查看三层生效结果 + 编辑受管层）；同批修掉 dev/打包策略不一致与设置分类清单的双份手写；证据见 [evidence/t08c-permission-settings-panel.md](./evidence/t08c-permission-settings-panel.md)
- 2026-08-29 外部审计修复批：13 项发现逐条成立并修复（权限 fail-closed、多会话隔离、Stop 生命周期、Runtime Event 契约、附件/effort、permission.activity 落地、IPC 失败恢复、窗口路由、去重规则、runtimeId 生命周期、打包与许可证、可访问性、Biome）；证据见 [evidence/phase2-audit-fixes.md](./evidence/phase2-audit-fixes.md)
- **T12 — 时间线外壳 + 气泡视觉基线（Phase 3 起手，用户已看图确认）**：气泡取 pi-app 形态 + 回复去盒 + 吸顶条退役 + meta 行退役换悬停操作条；证据与七张亮暗截图见 [evidence/t12-timeline-shell-baseline.md](./evidence/t12-timeline-shell-baseline.md)

## 2026-08-28 本会话关键修改文件

| 文件 | 变化 |
|------|------|
| `src/agent-host/piRuntime.ts` | **重写 `projectEvent()`**：新增 `TurnState` 状态追踪（messageId/blockId/textSnapshot/thinkingSnapshot），快照→增量转换，对齐 EventNormalizer 输出格式（`message.started` 带 messageId、`message.delta` 带 blockId/text、`thinking.started`/`thinking.delta` 独立事件、`tool.started` 带 messageId/name/input）。新增 `ensureAssistant()`/`emitTextDelta()`/`emitThinkingDelta()` 三个辅助方法 |
| `src/main/ipc/settings.ts` | `CREDENTIAL_MODE_SETTING_KEY` 从 `@shared/credentialMode` 导入改为本地内联常量，断开 vite 循环块 `shell→settings→shell` |
| `src/main/services/agent-host/PiHostProcess.ts` | `utilityProcess.fork()` 的 env 参数：从 `{...process.env, ELECTRON_RUN_AS_NODE: undefined}` 改为显式过滤（遍历 process.env 跳过该键） |
