# Ctrl+Enter 插话 — 真机验证 Handoff

> **给接管者的说明**：本文档是 `feat/ctrl-enter-interject` 分支上一轮代码审查 + 修复后的交接单。
> 代码改动已全部完成并通过静态检查与单元测试，**缺的是真机（Electron GUI）端到端验证**。
> 原开发者所在主机的 Swap 见底，未执行 GUI 冒烟。接管者需要做的是：跑起来、按下面步骤点、把结果回报。

> **2026-09-24 状态更新（以此为准）**：
> - 代码已全部提交（分支 HEAD `46789042`，未推送）。第 2 节「未提交是刻意的」、第 6.1 节 `StatusBar.tsx` 两段**已过时**：底部状态栏已在 `e23c6c1a` 删除，分支切换改在输入框上方的分支栏。
> - 之后又做了一轮代码审查修复（插话、分支栏、时间线）和一个线上死循环修复，见 [批次 M 证据](../plantree/plans/runtime-hardening/evidence/review-and-loop-incident-2026-09-24.md)。第 5 节 V1–V7 仍可参考，V5、V6 已按新行为改写。
> - **Windows 上实测请直接看第 9 节「Windows 实测清单（1.0.3-test.1）」。**

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

**（已过时，2026-09-24：代码已提交）** ~~未提交是刻意的：真机验证通过后再提交更合适。~~如果要提交，建议拆成两个 commit：
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

### V5 · 没有回合在跑时按 Ctrl+Enter【2026-09-24 按新行为改写】
- **操作**：没有回合在运行时，或者趁某一轮刚结束的那一瞬，按 Ctrl+Enter。
- **预期**：没有回合在跑时，Ctrl+Enter 就等于普通发送，消息直接发出。恰好卡在回合结束那一瞬时，消息不会丢：要么照常发出，要么留在队列里并提示 `当前没有正在运行的回合 —— 消息已作为普通排队等待发送`。
- **改前行为**：输入框清空、什么都不提示，用户以为发出去了。

### V6 · 事件改路由（原称「归属校验」，2026-09-24 更正）
- **更正**：`claimSessionForSender` **不是**归属校验，它不会拒绝任何窗口的插话；它做的是把这个会话之后的事件（包括审批卡）转给发起插话的那个窗口，与相邻的 `CHAT_STOP` 一致。代码注释已按此改写（`4a964c7d`）。
- 单窗口下看不出差别，**不需要手动验**；以代码为准。

### V7 · 既有功能未回归
- **Esc 停止**：运行中按 Esc 应照常停止当前轮。
- **普通 Enter 排队**：运行中按 Enter 仍走排队、不触发提前停止。
- **Send now**：队列条头部的 "立刻发送" 仍能立即中止当前轮。

---

## 6. 已知问题 / 不要误判

### 6.1 `StatusBar.tsx` 有个未完成的分支（已过时：该文件已在 `e23c6c1a` 删除）
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
V6 事件改路由：无需手动验（2026-09-24 更正，见第 5 节 V6）
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

---

## 9. Windows 实测清单（1.0.3-test.1）

> 面向在 Windows / 加密机上装测试包的人。安装包来自手动触发的打包（不发 Release，已装的客户端不会收到自动更新）。每一条写了「怎么做」和「应该看到什么」，对不上就记下来。

### 9.1 插话（Ctrl+Enter）

1. **基础插话**：让 AI 做一件要跑一会儿的事（比如让它跑几条命令），运行中在输入框打一句新要求，按 **Ctrl+Enter**。
   应该看到：它把手上这一步做完就停下（正在跑的命令不会被杀），然后你那句话自动作为下一条发出去，AI 接着按你的新要求做。
2. **后台子代理在跑时插话**：让 AI 派一个子代理去做耗时的调查，子代理还在跑时按 Ctrl+Enter 插一句话。
   应该看到：插话**很快**送达，不用等子代理跑完；子代理那一栏仍显示「运行中」，不会变成「已取消」；子代理跑完后，它的结论会在后面的回复里被用上。
3. **被打断的回合默认展开、可以收起**：上面被插话打断的那个回合，以及你点「停止」打断的回合，过程区默认是展开的；点一下折叠头能收起来。正常跑完的回合默认是收起的。
4. **插话排在普通排队消息前面**：运行中先按 Enter 排一条 A，再按 Ctrl+Enter 插一条 B。应该 B 先发、A 后发。

### 9.2 分支栏（输入框上方）

1. 在一个有多个分支的 git 仓库里，点分支栏，能看到全部分支。选另一个分支后，按钮上的名字**马上**变过来；再切回原来的分支也能成功。
2. AI 正在运行时，分支栏是锁住的，点不了。
3. 工作区有没提交的改动、切换会覆盖它们时，会显示 git 的报错，而不是「点了没反应」。
4. 打开一个不是 git 仓库的文件夹时，不显示分支栏。
5. 长分支名能看清大部分，太长时末尾用省略号截断。

### 9.3 运行中的命令能看到进度

让 AI 跑一条要等一会儿的命令（比如等 CI）。运行中那一行可以点开看到完整命令，行尾显示「已耗时 / 超时上限」，并且每秒在走。

### 9.4 死循环防护（用 glm-5.2 复现）

1. 用 glm-5.2，在一个已经很长的对话里（上下文很大时更容易出现），让它派子代理做事并等待结果。
2. 如果模型又开始成串重复「列出 / 停止 / 等待子 Agent」，应该看到：几十行之内就被掐断，出现提示卡「模型输出出现重复调用，已中断」；被掐断的那段里的操作一个都没执行；之后可以直接继续发消息。
3. 不会再出现刷几千行、刷十几分钟的情况。
4. 复现不出来也没关系，记下「未复现」即可。

### 9.5 紧急关闭开关

如果怀疑防护误拦了正常工作，可以临时关掉拦截：退出应用，设置环境变量 `AICLIENT_RUNTIME_LOOP_GUARD=0`（只有写 `0` 才算关），再启动应用。关掉后只是不再掐断或拒绝，工具回话的改进仍然有效。验完记得删掉这个变量。

### 9.6 点验后补修的几处（T128）

1. **失败提示卡**：9.4 里死循环被掐断后，时间线底部应出现中文卡「模型输出出现重复调用，已中断」（带原因和「继续」按钮），输入框上方**不应**再有英文红框。直接发一条新消息，卡片消失、正常回复。
2. **运行中点开折叠块**：AI 正在输出时，停在页面底部点开一个「思考」或工具行，页面应停在原地，不会把刚点开的内容卷走；自己滚回底部（或点「回到底部」）后恢复自动跟随。
3. **运行中发 `/compact`**：应弹出中文提示「等这一轮结束后再压缩上下文」，输入框里的 `/compact` 保留；这一轮结束后再按一次 Enter 就会执行。
4. **被拦下 / 没执行的调用**：被掐断那段里的调用显示「· 未执行」，被拒绝的显示「· 已拒绝」，都是灰色，不会看起来像成功了。
5. **插话回合重开后的时长**：被插话打断的回合，重启应用再打开这个对话，「已工作」应接近实际时长（不会变成 1 秒）。
6. **切分支失败的报错**：应直接显示 git 的原话（如「error: Your local changes…」），悬停能看到完整内容。

### 9.7 出问题时请收集

- 出问题那个对话的会话文件：`%USERPROFILE%\.pilab\PiLabAi\pi-agent\sessions\` 目录下，按修改时间取最新、最大的那个 `.jsonl`。
- 日志：`%APPDATA%\PiLabAi\logs\` 目录下的 `aiclient-<日期>.log`（运行日志，主要看这个）和 `main.log`（启动日志），两个都发来；设置里也有「打开日志文件夹」。死循环被掐断时，运行日志里会有一行 `turn failed: tool_call_repetition`。
- 截图，以及操作顺序（先按了什么、隔了多久、再按了什么）。
