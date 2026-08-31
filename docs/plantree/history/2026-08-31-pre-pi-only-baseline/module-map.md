# Module Map

## 分层

| 层 | 路径 | 要点 |
|---|---|---|
| Electron Main | `src/main/` | `services/agent-host/AgentHostManager.ts`（Host 进程管理 + 命令 API + requestAndWait）、`services/agent-host/NodeRuntimeResolver.ts`（六源寻径：explicit > env > **bundled** > nvm/fnm/volta/PATH）、`services/chat/SessionIndexService.ts`（会话索引持久化）、`ipc/chat.ts`（Chat IPC + 事件广播） |
| Preload | `src/preload/index.ts` | `electronAPI.chat`（create/resume/send/stop/close/respondPermission/respondQuestion/listSessions/listHistory + onRuntimeEvent） |
| Renderer | `src/renderer/` | `stores/chatSessions.ts`（核心 store：**messages 按 sessionId 分桶 + 16ms 事件批处理**，C-08）、`components/chat/**`（时间线/Composer/卡片 + 纯函数侧表：messageMetadata/hostStatus/thinkingCard/fileMention/sessionIndex/composerTarget（T-27））、`components/workspace-shell/**`（**三列 + 44px 导轨 + surface 模型**——D19/T-22 已落地 `95a5c04`，2026-07-29；布局纯函数侧表 shellLayoutModel/surfaceRegistry + `stores/shellLayout.ts` persist；`BottomDock.tsx`/`RightDock.tsx` 已删除） |
| Agent Host | `src/agent-host/` | **独立 Node 24 进程**，stdin/stdout NDJSON 协议。`index.ts`（协议循环）、`claudeRuntime.ts`（SDK 适配 + 看门狗）、`eventNormalizer.ts`（SDK→Runtime Event）、`permissionBridge.ts` / `questionBridge.ts`（canUseTool 停靠）、`historyReader.ts`（CC JSONL 读取）、`sessionRegistry.ts` |
| Shared | `src/shared/types/` | `runtimeEvents.ts` / `agentHost.ts` / `sessionHistory.ts` —— **协议 = 唯一汇合点**，变更纪律见执行计划 §4 |
| 构建 | `scripts/` | `build-agent-host.mjs`（esbuild + 剪枝 424→87MB）、`afterPack.mjs`（串行拷贝产物 + TSD 修复，避 extraResources 竞态）、`verify-packaged-app.mjs`（25 项断言）、`fetch-node-runtime.mjs`（随包 Node 24.18.0） |

## 注意

- `src/agent-host/**` 被 tsconfig 排除——**typecheck 不覆盖 Host**，门禁靠 vitest 单测（`src/agent-host/__tests__/`）+ spikes smoke。
- 双轨时期的「红线区域」概念已随 2026-07-24 移交失效，全仓单线维护。
- 旧路径（AgentPanel 终端式聊天等）留给其他 Agent 使用，Phase 5（C-12）收缩。
