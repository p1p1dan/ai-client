# 决策 197：Agent SDK 对话不走只读预览，打开时直接恢复，不再先问 DSH 宿主

日期：2026-10-18（北京时间）。**状态：自主决定，待用户审批。** 小修，不改 DSH 的行为。

分支：`claude/trusting-tesla-39bbe3`，从 `feat/slash-skills-193-29`（`f5aed950`）开出。编号：195、196 已在 `claude/s6-feedback` 占用，故用 197。

修订关系：

- [决策 030](030-read-only-replay-via-host.md)（DSH 会话的只读回放交给宿主读）：不变。本决策只把 SDK 对话从这条路上摘出去。
- 路线 B [S-1](../../claude-sdk-engine/topics/s1-engine-selection.md) 决策 2（重开的对话按桩文件后缀 `.ccsdk.json` 定引擎）：照用同一条规则判断。

## 1 问题

决策 194 点验时发现：在开发版里重开一个 SDK 对话，控制台出两条错误。渲染层点开没有时间线的对话时先要预览（`chat:readSessionPage`），Main 见索引行的 `agent` 是 `dsh` 就交给 `DshHostSupervisor.readPage`；DSH 宿主不认 SDK 的桩，答 `session_invalid: Not a DSH session identity: …\aiclient-sessions\<id>.ccsdk.json`，Main 再转成 `session_replay_unavailable`，渲染层这才退回恢复。功能上没坏（最后恢复成功），但：

- 每次都多一个注定失败的往返，Main 还会记一条「Error occurred in handler for 'chat:readSessionPage'」；
- DSH 宿主没起时，`readPage` 会为这次预览把它冷启动起来，只为了拒绝。

SDK 对话的记录是 CLI 自己的转写（`<配置目录>/projects/<目录>/<ccSessionId>.jsonl`），只有这个对话自己的 SDK 宿主（`getSessionMessages`）读它；Main 没有「不开会话就读一页」的 SDK 通道。

## 2 规则

1. 渲染层 `runSessionActivation`（`activateSessionStart.ts`）：运行身份以 `CLAUDE_SDK_STUB_SUFFIX` 结尾的对话不预览，直接恢复（和已有 worker 的对话一样）。`onLoad` 照旧只报一次。
2. Main 的 `chat:readSessionPage`：仍先查 `worker_active`（SDK 对话在跑时，翻旧页照旧转去问 worker）；之后遇到 SDK 桩直接报 `session_replay_unavailable`，不问 DSH 宿主，也不问旧 pi 读取器。这条兜住其他调用方（如没有 worker 时的「加载更早」）。
3. DSH 对话、旧 pi 对话的预览路径一字不改。

## 3 取舍

- 不选「为预览起一个 SDK 宿主读一页」：要起宿主进程，代价比直接恢复还大，恢复本来就会把历史带回来。
- 只改 Main 不改渲染层不够：Main 抛错时 Electron 自己会在 Main 控制台记一条 handler 错误，所以渲染层也要不发这次请求。
- 判断用桩后缀而不是 `engineForSessionFile`：后者按架构测试（`chatEngineDshOnly.test.ts`）只给 `WorkerManager` 用；这里不是选引擎，是判断哪个读取器能读这个文件，和 `transcriptLocation.ts`、`chatEngineView.ts` 的做法一致。

## 4 验证（2026-10-18，Windows 开发机）

- 根 `pnpm typecheck`：0 错。
- vitest：`chatReadSessionPage.test.ts` 新增「an Agent SDK row (decision 197)」三条（不问 DSH 宿主与旧读取器、翻旧页同样拒绝、在跑时仍答 `worker_active`）；`activateSessionStart.test.ts` 新增两条（SDK 对话直接恢复、DSH 对话照旧预览）。连同 `permissionModesSdkModel.test.ts`、`claudeSdkEngine.test.ts` 共 4 个文件 74 项过。
- `chatEngineDshOnly.test.ts`：引擎选择那条（`engineForSessionFile` 只在 `WorkerManager`）过。另有一条「Main reads no engine switch…」在 `f5aed950` 上本来就失败：它还在找 `new ClaudeSdkProcessTransport({ command: node, args: [entry], cwd: configDir, … })`，而 `975a4954`（决策 194 Q1）把启动参数挪进了 `claudeSdkHostLaunch`。与本次无关，没改。
- 开发版（`gui-probe.mjs`，隔离 HOME，假网关 `--plan claude-sdk`）：建一个 SDK 对话（claude-opus-5-5，桩 `….ccsdk.json`，索引行 `agent: dsh`）和一个 DSH 对话（glm-fake-1），重启应用后：
  - 点开 SDK 对话：历史照常出来；渲染层控制台没有错误；Main 日志自点开起没有新行（没有 `session_invalid`，没有 `Error occurred in handler for 'chat:readSessionPage'`）。
  - 点开 DSH 对话：只收到一条 `session.history`（`mode: branch`，2 条消息），没有 `session.resumed`，即照旧由 DSH 宿主预览；Main 日志同样没有新行。
- 没验证：Linux；安装包；没有 worker 时 SDK 对话「加载更早」走到 Main 兜底的那条路（只有单测）。
