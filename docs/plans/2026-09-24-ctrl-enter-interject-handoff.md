# Ctrl+Enter 插话 — 真机验证 Handoff

> **给接管者的说明**：本文档是 `feat/ctrl-enter-interject` 分支上一轮代码审查 + 修复后的交接单。
> 代码改动已全部完成并通过静态检查与单元测试，**缺的是真机（Electron GUI）端到端验证**。
> 原开发者所在主机的 Swap 见底，未执行 GUI 冒烟。接管者需要做的是：跑起来、按下面步骤点、把结果回报。

---

## 1. 背景：这个功能是什么

用户按 **Ctrl+Enter** 时，如果 agent 正在执行，不打断当前这一轮，而是等这一轮跑完（工具全部执行完、消息流式输出完）后优雅停下，然后把用户刚输入的内容作为**下一轮**自动发出去。

这不同于已有的 "Send now"（立即中止当前轮）。

参考实现模型是 Claude Code 的优先级队列：`Enter` = later（普通排队）、`Ctrl+Enter` = next（当前轮结束后停止并优先发送）。

---

## 2. 代码状态

**仓库**：`/home/pi/code/ai-client-runtime`（注意：不是 `jyw-ai-client`）
**分支**：`feat/ctrl-enter-interject`
**被审提交**：`0a836f27` — `feat(chat): Ctrl+Enter 插话——运行中消息入队并在下一个 turn 边界交付`
**工作区**：有一批**未提交**的修复改动（见下）。

```bash
git -C /home/pi/code/ai-client-runtime status --short
```

未提交改动共 16 个文件、+378/−41，集中在：

| 文件 | 改动 |
|---|---|
| `src/main/ipc/chat.ts` | 补 `claimSessionForSender` 归属校验 |
| `src/renderer/components/chat/ChatComposer.tsx` | 插话结果反馈 + i18n 文案 |
| `src/renderer/components/chat/messageQueue.ts` | `interject` 真正抢占队头 |
| `src/renderer/components/chat/queueRelease.ts` | 队列条 `interjection` 标记 |
| `src/renderer/components/chat/QueuedMessageStrip.tsx` | 插话条目 UI 标记 |
| `src/renderer/components/chat/middleColumnLayout.ts` | 运行中占位提示补快捷键 |
| `src/runtime/plugins/agent-loop/index.ts` | `_interjected` 改 per-run |
| `src/runtime/contracts.ts` | `AgentLoopService.interject(): boolean` |
| `src/runtime/worker/nativeWorkerRuntime.ts` | 如实透传 `interjected` |
| `src/agent-host/piWorkerRpcServer.ts` | 补 `PiWorkerRuntime.interject` 接口声明 |
| `src/shared/i18n.ts` | 新增 4 条中英文案 |
| `src/renderer/components/workspace-shell/StatusBar.tsx` | `text-xs` → `text-meta`（修另一处门禁） |
| 4 个测试文件 | +18 个用例、修 1 个脆弱的静态断言 |

**未提交是刻意的**：真机验证通过后再提交更合适。如果要提交，建议拆成两个 commit：
- `fix(chat): Ctrl+Enter 插话补齐归属校验、失败反馈与真实优先级`
- `test(chat): 补插话链路单测并修复 composerStopStatic 的窗口假设`

---

## 3. 已验证 / 未验证

**已验证（静态 + 单元测试，全绿）**：

| 检查 | 命令 | 结果 |
|---|---|---|
| 全项目类型检查 | `npx tsc --noEmit` | 通过 |
| runtime 子项目类型检查 | `npx tsc --noEmit -p src/runtime/tsconfig.json` | 通过 |
| lint（本次触及文件） | `npx biome check <files>` | 干净 |
| chat 目录全部测试 | `npx vitest run src/renderer/components/chat/__tests__/ --maxWorkers=1 --no-file-parallelism` | 2349 通过 |
| 插话 agent-loop 测试 | `npx vitest run src/runtime/__tests__/interject.test.ts` | 5 通过 |
| shared（含 i18n 两道门禁） | `npx vitest run src/shared/__tests__/` | 492 通过 |

**未验证**：Electron GUI 下的真实交互链路。具体是「按下 Ctrl+Enter → 队列释放 → 下一轮真的发出」这一段，单测覆盖了各环节，但没有跨进程真跑过。

---

## 4. 怎么跑起来（重要：不要手写 electron-vite 命令）

**必须用**：

```bash
cd /home/pi/code/ai-client-runtime
NODE_OPTIONS=--max-old-space-size=1536 pnpm dev
```

`pnpm dev` → `node scripts/dev.js`，这个包装脚本做了四件绕不过去的事：

1. **凭据注入**：剥掉 shell 继承的凭据变量，从 `dev.env` 注入 `ANTHROPIC_AUTH_TOKEN`，然后才启动 Electron。
2. **`--no-sandbox`**：Linux 上自动加（非特权 user namespace 被禁用时需要）。
3. **`ensureDevPermissionPolicy`**：给 dev 的 agent-host 写与正式版一致的权限策略；缺了会导致 dev 与 packaged 的权限行为不一致。
4. **SIGINT 进程树清理**：Ctrl+C 时 SIGTERM → SIGKILL 整棵 Electron 进程树，避免 PTY 残留。

> ⚠️ 不要用 `createServer({}, { rendererOnly: true })` 这类程序化 `electron-vite` 调用：它只起 renderer 的 Vite server，**不编译主进程/preload、不启动 Electron**，界面根本不会出现，而且绕过了上面 4 件事。

**跑之前**：

```bash
pgrep -af "electron-vite|aiclient|qoder" || echo "clean"
free -h
```

本机资源紧张（≈5.8 GiB RAM / 2 vCPU / Swap 曾见底），启动前确认没有残留的 electron / vite 进程。

**凭据文件**：`dev.env` 存在与否请自行确认（它是凭据文件，**不要读取内容、不要提交**；`.gitignore` 应已覆盖）。若缺失，dev.js 会拒绝启动并提示 `cp dev.env.example dev.env`。不要用 `--allow-local-credentials` 绕过，除非你确认本机 Pi 配置可用。

---

## 5. 验证清单（逐条点，逐条记）

起界面后按顺序做，每条都对应一处具体修复。

### V1 · 运行中提示文案【对应修复 6】
- **操作**：发一条会跑一会儿的消息，趁运行中看输入框占位符。
- **预期**：`Agent Host is running —— Enter 排队，Ctrl+Enter 在下一轮后插话…`
- **改前**：只显示 `Agent Host 正在运行 —— 你的消息会先排队…`（完全没提 Ctrl+Enter）。

### V2 · 基础插话链路【核心】
- **操作**：运行中打一句新内容，按 **Ctrl+Enter**。
- **预期**：当前这一轮把正在执行的事做完就停（不是立刻中止），随后插话内容自动作为新一轮发出。
- **关键观察点**：日志里应出现 `turn_stopped_by_interjection`。

### V3 · 队列条标记【对应修复 6】
- **操作**：插话入队后看输入框上方的队列条。
- **预期**：该条目左侧有 `↵ 插话` 标记；普通 Enter 排队的条目没有这个标记。

### V4 · 插话优先级【对应修复 4，最容易看出差别】
- **操作**：运行中**先按 Enter** 排一条 A，**再按 Ctrl+Enter** 插入 B。
- **预期**：**B 先发，A 后发**。
- **改前行为**：B 会排在 A 后面（`priority` 字段当时没人读，`decideQueueRelease` 只弹队头）。
- **这是本次改动里最值得确认的一条**——它是这个功能"插话"语义成立的前提。

### V5 · 失败反馈【对应修复 2】
- **操作**：趁某一轮刚结束的那一瞬按 Ctrl+Enter（时序窗口窄，多试几次）。
- **预期**：出现提示 `当前没有正在运行的回合 —— 消息已作为普通排队等待发送`，且消息确实留在队列里没有丢。
- **改前行为**：输入框清空、什么都不提示，用户以为发出去了。

### V6 · 归属校验【对应修复 1，难以手动验】
- 单窗口下看不出差别。它防的是"另一个渲染进程对不属于自己的 session 发插话信号"。
- **验证方式**：以代码审查为准——确认 `src/main/ipc/chat.ts` 的 `CHAT_INTERJECT` handler 调用了 `claimSessionForSender(e, payload.sessionId)`，与相邻的 `CHAT_STOP` 一致。
- 如果想真验：开两个窗口/两个 session，从窗口 A 构造对窗口 B session 的 `chat:interject` 调用，应该被拒绝或落到 A 自己的 session。

### V7 · 既有功能未回归
- **Esc 停止**：运行中按 Esc 应照常停止当前轮。
- **普通 Enter 排队**：运行中按 Enter 仍走排队、不触发提前停止。
- **Send now**：队列条头部的 "立刻发送" 仍能立即中止当前轮。

---

## 6. 已知问题 / 不要误判

### 6.1 `StatusBar.tsx` 有个未完成的分支（新发现，未修）
`src/renderer/components/workspace-shell/StatusBar.tsx:19` 的 `error` 变量被声明但从未渲染，而 49–67 行的 `onError`/`onSuccess` 回调在调 `setError(...)`。看起来是"切换分支失败时显示错误"的 UI 分支没写完。

- Biome 报 `noUnusedVariables` warning。
- **不属于本次改动范围**，我没有动它。
- 如果 V7 里切换分支失败，错误可能不会显示——这是既有缺口，不是本次回归。

### 6.2 已修复的两处门禁失败（供参考，不必再查）
- `composerStopStatic.test.ts` 的 `[E-1]`：原断言用"往后数 400 字符"找 `void handleSend();`，被 Ctrl+Enter 分支挤出去了。已改为按大括号配对切出 Enter 块（新增 `matchingBraceEnd` 辅助函数），并同时断言 `handleSend` 与 `handleInterject` 都在块内。
- `fontDomainScan.test.ts`：`a5d2059d` 在 `StatusBar.tsx` 用了 `text-xs`，该目录规范统一用 `text-meta`。已改。

### 6.3 `docs/plans/2026-09-23-bash-streaming-output-plan.md` 是未跟踪文件
不是本次改动产生的，没有动它。别当成遗留垃圾清掉。

### 6.4 一个未追踪的风险（值得留意）
`AgentLoopPlugin._interjected` 原来是插件级字段，已改为 per-run 盒子（`activeRun`）。但请注意：**一个 worker 进程一个 `AgentLoopPlugin` 实例**。如果实际部署中存在一个进程内串行跑多个 run 的情况（例如同一 session 快速连发两次发送），`activeRun` 会被后者覆盖，前者 `finally` 里的身份检查（`if (this.activeRun === interjection)`）会正确地**不**清除新盒子——这是刻意的。但这也意味着**前一个 run 收到的插话信号会被丢弃**。

真实链路里同一 session 无法并发两个 run（`NativeWorkerRuntime.turn` 是单槽，且 `interject` 要求 `this.turn` 存在），所以这条目前不可达。如果 V2/V4 出现"按了 Ctrl+Enter 但没停"的偶发现象，这是第一个该查的地方。

---

## 7. 回报格式

麻烦按这个格式回报，便于定位：

```
V1 提示文案：通过 / 失败（实际显示：___）
V2 基础插话：通过 / 失败（现象：___；日志有无 turn_stopped_by_interjection：___）
V3 队列标记：通过 / 失败（截图或描述：___）
V4 优先级：  通过 / 失败（实际顺序：___）
V5 失败反馈：通过 / 失败（实际提示：___）
V6 归属校验：仅代码审查（已确认 / 未确认）
V7 无回归：  Esc ___ / Enter 排队 ___ / Send now ___

其他异常：
日志片段：
```

失败时请附带：
1. 终端里 `pnpm dev` 的完整输出（尤其 `[dev] credentials:` 那几行和任何 stack trace）；
2. Electron 窗口的控制台输出（DevTools Console）；
3. 触发时的操作时序（先按了什么、间隔多久、再按了什么）。

---

## 8. 相关的原始资料

- **实现计划**：`docs/plans/2026-09-23-ctrl-enter-interject-plan.md`（被审提交自带的计划文档，含完整数据流与风险分析）
- **关键代码入口**（按 Ctrl+Enter 的调用链，自上而下）：
  1. `src/renderer/components/chat/ChatComposer.tsx` → `handleInterject()`（:1029）与 keydown 的 Ctrl 分支（:3213）
  2. `src/renderer/components/chat/messageQueue.ts` → `interject()` reducer
  3. `src/preload/index.ts` → `chat.interject`
  4. `src/main/ipc/chat.ts` → `CHAT_INTERJECT` handler
  5. `src/main/services/agent-host/WorkerManager.ts` → `interject()`（:1994）
  6. `src/agent-host/piWorkerRpcServer.ts` → `handleInterject()`（:838）
  7. `src/runtime/worker/nativeWorkerRuntime.ts` → `interject()`（:497）
  8. `src/runtime/plugins/agent-loop/index.ts` → `interject()`（:258）/ `activeRun` / `shouldStopAfterTurn`（:627）
  9. 队列释放：`src/renderer/components/chat/queueRelease.ts` → `decideQueueRelease()` / `useQueueRelease.ts`

- **单测参考**（想理解预期行为时最有用的两份）：
  - `src/renderer/components/chat/__tests__/messageQueue.test.ts` → `describe('interject')`
  - `src/runtime/__tests__/interject.test.ts`
