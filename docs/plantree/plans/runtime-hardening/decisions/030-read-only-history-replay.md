# 决策 030：查看历史会话不再起 worker——主进程只读回放，发送时才 resume（档位 A）

日期：2026-09-19 · 拍板人：用户（「先档位 A 吧」）· 状态：已决 · 任务：T102

## 问题

用户反馈（批次 I #3）：结束对话后连历史也看不见；「对话历史一定要启动该对话么？我的理解是发送消息才正式启动」。T092 只解决了同一次运行内（结束不再删时间线）；重启后查看任何历史会话仍必须 resume——`chat:resumeSession` 与 `chat:loadHistoryPage` 都要活 worker，看历史就占一个 worker 名额（默认按内存 3 / 6 / 10），开得多时连看历史都会被容量拒绝。

[Q029](../open-questions.md) 调研四方：PI-Desktop（Rust 内核版）常驻文件服务直读、偏移表分页、不起 agent；pi-app（旧版 pi-desktop）专职只读预览进程，代码注释明令「NEVER spawn a worker just to read history — that was the main cause of slow session switches」，并有静态测试守门；pix 必须起完整 host（pi-app 正是从这条路撤回来的）；pi 官方 CLI 选会话零 agent。pi SDK 的 `SessionManager.open()` **不是只读**（缺换行补写、旧版本重写、空文件写 header），不能拿来只读打开。

## 决定

选 **档位 A**：新增主进程只读回放通路，点开会话先显示历史，发送时才 resume。

落地约束：

- 只读链复用本仓现成纯函数：`readFile` →（v3 时内存内 `convertLegacySession`）→ `decodeSession` → `branchEntries` → 时间戳 ISO 适配（照 `store.ts:469-478`）→ `projectPiSessionHistory` → `paginatePiSessionHistory`。**不得**经 `JsonlSessionStore.open`（无条件取写锁并写修复）。
- `@earendil-works/pi-agent-core` 显式加进根 `package.json`（`codec.ts` 唯一值导入 `buildSessionContext`，现在只是传递依赖）。
- **有活 worker 的会话仍走老路**（worker 内存里的分支才是权威）；只有「无 worker」才走只读。这同时绕开 `decodeSession` 对未闭合 operation 抛错的约束（正在跑的会话文件解不了）。
- 事件形状尽量复用 `session.history` RuntimeEvent 让 `chatSessions.ts` reducer 不改；`initial` / `refresh` 模式要求匹配的 resume 快照，只读路径要补对应快照或用不校验的模式。
- 渲染层 `useActivateSession` 从「无时间线即 resume」改为「无时间线即只读预览」；真正的 `resumeSession` 推迟到发送路径（`ChatComposer` 那里本来就会调）。`MessageTimeline` 与 `SessionReviewPanel` 的翻页改指只读通道（无 worker 时）。
- 两条路输出要用对照测试钉一致（同一份会话文件，只读回放与 worker 回放投影结果相等）。
- 不做档位 B（磁盘快照与 live 流合并）与档位 C（独立进程 + 偏移表分页），需要时再议。

## 影响

- T102 立项。改动面：新建 `src/main/services/chat/SessionReplayReader.ts`（名字可调），`src/main/ipc/chat.ts` 新 handler，`src/preload/index.ts` 新通道，`useActivateSession.ts`、翻页两处调用点。
- 与 T092 串行（同动 `useActivateSession.ts`），T092 先落地。
- 决策 018（临时工作区删除后聊天行仍可见）同向：别让会话凭空消失、别让看历史付出不必要的代价。
