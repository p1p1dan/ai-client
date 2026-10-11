# 决策 176：没启动的对话里执行 `/compact`、目标条命令与会话分支——先按发消息的同一条路径启动对话，再执行

日期：2026-10-10。**状态：第 1 节为用户裁决（2026-10-10）；第 2 节起为自主决定，待用户审批。**

来源：[决策 175](175-slash-commands-before-session-start.md) §7 风险 6（没启动的已有对话里 `/compact` 报「压缩上下文失败：No ready Pi WorkerSlot exists…」）；用户 2026-10-10 裁决「修，做法是先自动启动，再执行」；编排者同日补充的压缩机制调研结论（压缩没有任何进行中状态、重复回车会排第二次压缩、失败提示是原始英文错误码）。代码提交：`2bc593b6`。

修订关系：

- [决策 175](175-slash-commands-before-session-start.md) §7 风险 6：本决策修掉。
- [决策 118](118-p1-7a-goal-todo-round-choices.md)（目标条）与 P1-7a 的「没有活 worker 的目标条不出按钮」：改为照常出按钮，按下先启动对话再执行（§3.3）。「设定目标…」不可用时的提示随之只剩一句（在目标条上暂停、继续、编辑或清除），`GOAL_ENTRY_HINT_OFFLINE` 删除（词典里那一条留着，没有引用）。
- [决策 122](122-p1-9d-migration-orchestration-choices.md) 第 14 条（旧对话先迁移再做 `/compact`、会话分支，`runAfterLegacyMigration`）：并入本决策的「先启动」。1.0.x 的旧对话在宿主上从来没有运行过，先启动（恢复）这一步就是迁移；迁移失败照旧是「这个对话没能迁移到当前引擎」那句。`runAfterLegacyMigration` 已没有调用方，删掉。
- [决策 113](113-p1-4d2-commands-and-projection-choices.md)（`/compact` 不接受附加说明）、[决策 140](140-p1-7e-e2b-choices.md)（压缩成功即在时间线末尾出摘要行）：不变。
- [决策 030](030-read-only-replay-via-host.md)（预览不启动 worker）：不变。翻页仍然不启动对话（§4）。
- Stop 的既有语义（代码注释里的 decision 046：没有回合时 Main 当场答 `no_active_turn`）：不变。压缩不是回合，没有 Stop（§5）。

## 1 用户裁决（2026-10-10）

1. 在没启动的对话里执行 `/compact`（及目标条命令）时，先按**发消息时的同一条路径**把会话启动起来（旧 pi 会话的迁移、工作区一致性检查、凭据 / 模型计划就绪等都照旧），启动成功后再压缩 / 执行命令。不另写一条启动逻辑。
2. 界面先显示「正在启动对话…」，再显示「正在压缩…」（只加一个启动阶段）。编排者同日补充：现有代码里并没有「正在压缩…」——新做一个简洁的进行中状态，样式照输入框现有的提示 / 状态行惯例；进行中再次回车 `/compact` 不再排第二次（渲染层在途标记 + Main 拒绝并给友好提示）；启动失败与 `session_not_found` 必须是中文友好文案，超时、没有可压缩内容、无法产生有用摘要若改动小也一并给友好文案，原始错误码放到日志。
3. 启动失败：显示现有的友好失败卡 / 错误（例如工作区不一致走现有的不可重试卡），不再把「No ready Pi WorkerSlot」这类内部原文露给用户；顺手检查其他把这条内部报错直接显示出来的地方。
4. 其他约束照旧：回合进行中仍拒绝压缩；启动或压缩途中用户发消息、点 Stop、关闭对话、宿主重启时，行为要确定且有测试。编排者补充：自动压缩、摘要 `maxTokens`、**压缩期间发消息的 10 秒超时**另行问用户，本决策不动。

## 2 现状与根因（HEAD `d678092f` 上逐条核实）

### 2.1 什么时候对话「没启动」

| 情形 | 渲染层 | Main |
|---|---|---|
| 应用重启后打开老对话 | 历史是读文件的预览（决策 030），`hostBoundSessionIds` 里没有它 | 池里没有条目 |
| 闲置 15 分钟被回收 | `session.status disconnected/released` 解除绑定 | `reclaimIdleInternal` 把条目移出池 |
| 登录、模型、插件变更重建引擎 | 同上（`released`） | `invalidateAll` 移出全部条目 |
| 引擎重启 | `disconnected/engine_restarted` 解除绑定 | 条目还在，`restarting`；恢复成功后发 `session.resumed` 重新绑定 |
| 从没发过消息的对话 | 没有 `runtimeIdentity` | 池里没有条目，索引行没有会话文件 |

### 2.2 `/compact` 为什么一定失败

| 环节 | 位置（改前） | 做了什么 |
|---|---|---|
| 输入框 | `ChatComposer.tsx:1285-1353` | `runCompactCommand` → `runAfterLegacyMigration(compactSession, resumeSessionById)`：只在 Main 答「旧对话未迁移」时先恢复再问一次，别的拒绝原样返回 |
| IPC | `src/main/ipc/chat.ts:879-892` | `requireLiveSession` 只查索引行（DSH 行通过），然后直接调 `compactSession`；**不带错误码**（只有 `chat:send` 等少数通道过 `withWorkerErrorCode`） |
| Main | `WorkerManager.ts:1561-1586` → `requireReadySession`（3251-3259） | 池里没有就绪的槽 → `WorkerManagerError('session_not_found', 'No ready Pi WorkerSlot exists for …')` |
| 渲染层 | `compactCommand.ts` | `unwrapIpcErrorMessage` 去掉 Electron 外壳，toast「压缩上下文失败」+ 描述「No ready Pi WorkerSlot exists for session-…」 |

结论：压缩从来不会启动对话；`session_not_found` 连代码都没带到渲染层，渲染层无从识别，只能原样显示。

### 2.3 其他同一类入口

- **目标条**（`runSessionCommand`，`WorkerManager.ts:1598`）：同样要求就绪。但界面上没有活 worker 时目标条**不出按钮**（`deriveGoalBarView` 里 `action: live ? 'resume' : null`、`controls: panels.live`），所以只在竞态里失败（按下的瞬间被回收），toast 显示的是带 Electron 外壳的原文；正常情况下用户在被回收的对话里根本没法暂停 / 继续 / 编辑 / 清除目标，「目标已挂起」的说明却写着「重开会话、回退或打断后需要手动继续」。
- **会话分支对话框**（`getSessionTree`，`WorkerManager.ts:1712`）：顶栏只要对话有 `runtimeIdentity` 就给「会话分支」按钮（`SessionBar.tsx`），没启动时打开即失败，对话框错误行显示 `Error invoking remote method 'chat:getSessionTree': … No ready Pi WorkerSlot …`。回退、分叉在对话框里，树加载成功后对话已在运行，只在竞态里失败。
- **后台任务窗口的停止、子代理窗口的中断**（`killSessionJob` 1641、`interruptSubagent` 1689）：toast 原样显示 `error.message`。
- **向上翻页**（`loadHistoryPage` 1424）：渲染层以为有 worker 而 Main 已回收时，写成「读取历史失败」卡，详情里是 `No ready Pi WorkerSlot`。

### 2.4 发消息时对话是怎么启动的（本决策复用的路径）

| 环节 | 位置（HEAD） | 做什么 |
|---|---|---|
| 输入框 `runSend` | `ChatComposer.tsx:2089` | `captureSessionGenerationPreferences`：第一次用时把默认模型、档位记到这个对话上 |
| | 2117-2169 | 模型 `resolveResumeModel`、档位 `toWireEffort(resolveEffortSelection(…))`、权限 `readSessionPermissions ?? readDefaultPermissions` |
| | 2137 | `decideSendPreamble`：已绑定 → 直接发；有 `runtimeIdentity` → 恢复；没有 → 新建 |
| | 2975 | `chat.ensureHost()` |
| | 3015-3087 | 恢复：`resumeSessionWithMigration`（旧对话迁移时界面显示「正在迁移」并应用迁移摘要）；失败 → `encodePiResumeError` 写 `historyErrors`（失败卡），另把原文写进 `lastError`（输入框上方红框） |
| | 3174 起 | 直接发送被 Main 答 `session_not_found` → 解除绑定 → 恢复 → 再发一次 |
| IPC `chat:resumeSession` | `chat.ts:473-588` | 索引行与请求的会话文件一致；`sameWorkerDirectory` 工作区一致性（决策 163，不一致是不可重试卡）；临时目录重建；`legacyMigrationService.prepareResume` 迁移旧对话 |
| Main | `WorkerManager.resumeSession`（1146 起） | 同一对话、同一指纹（会话文件、工作区、模型、档位、强制接管）的恢复在途时合并成一个（`resumeFlights`）；`spawnForEntry` → `createDshChatSlot`：开宿主通道（凭据、模型计划随宿主） |

### 2.5 压缩本身（编排者调研，2026-10-10）

- 没有任何进行中状态：渲染层不设在途标记，Main 也不标记；会话状态仍是空闲、没有 Stop，`/compact` 留在输入框直到结束（最长 45 秒）。
- 进行中再次回车会再发一次压缩；第二次请求在 Main 的 60 秒时钟上先到期、界面报失败，而 worker 仍会写入。
- 失败 toast 是「错误码: DSH 原句」的英文（`WORKER_COMPACT_FAILED: …`）。

## 3 修法（自主决定，待审批）

### 3.1 启动：发消息的同一条路径（渲染层，不改 Main 的启动逻辑）

1. **`src/renderer/components/chat/sessionStart.ts`**（纯函数，副作用全部注入）：
   - `startSessionAsSendDoes(sessionId, deps)`：已绑定 → `running`；否则用 `shouldResumeSession` 算出与发送相同的恢复参数，`ensureHost()` → `resumeSessionWithMigration(args)` → 标记已绑定 → `started`。
   - 与 `runSend` 只差两处，都是有意的：**从没运行过的对话不新建**（发送会新建；操作在空对话上无事可做，答「还没有可以压缩的内容」）；**失败不往输入框上方写原文**（`lastError`），只按发送的同一规则写失败卡（`encodePiResumeError` → `historyErrors`），操作自己用一句中文说「对话没能启动，原因见对话里的提示」。
   - Main 答 `session_not_ready`（引擎重启后正在重开这个对话）或 `session_busy`：不写卡，说「引擎正在重新打开这个对话，请稍后再试」/「有回复正在进行」。
   - `runWithSessionStarted({ operation, start, isRunning, forgetRunning, onPhase, cancelled })`：渲染层知道没启动 → 先启动再执行；以为在运行、Main 却答 `session_not_found` 或 `legacy_migration_required`（漏收了回收事件，或是旧对话）→ 解除绑定 → 启动 → 再执行一次（发送路径 `session_not_found` 回退的同一形状）；本次刚启动过还被这样拒绝，不再试第三次，交给调用方说「对话在操作开始前停止了运行，没有任何改动」；启动途中用户结束了对话（`cancelled`）→ 不执行。
2. **`sessionStartDeps.ts`**：`sendStartPreferences` 照 `runSend` 的顺序读同一组值（`captureSessionGenerationPreferences` → 模型 → 档位 → 权限），所以操作的启动与同时按下的发送在 Main 里指纹相同，**合并成同一次恢复**，不会出现「另一个恢复在途」的冲突。`shouldResumeSession` 新增可选 `effort`（侧栏打开对话的恢复不传，行为不变）。
3. **Main 把错误码带过 IPC**：`withWorkerErrorCode` 加到 `compactSession`、`runSessionCommand`、`getSessionTree`、`rewindSession`、`forkSession`、`killSessionJob`、`interruptSubagent`、`loadHistoryPage` 与 `resumeSession` 九个处理函数（以前只有发送、重试、插话、撤回）。worker 自己的拒绝（`WORKER_*`）不是 `WorkerManagerError`，原样通过。顺带让恢复失败里的 `dsh_host_unavailable` 真正带到渲染层（`historyError.ts` 早就按它出「引擎没在运行」卡，此前文本里没有这个码）。

### 3.2 `/compact`

1. **进行中状态**：输入框状态行（与读取附件时那一行同一处、同一样式：`Spinner` + `text-meta` 灰字，单行截断）先显示「正在启动对话…」（只在没启动时），再显示「正在压缩上下文…」。阶段存在新 store `stores/compactRuns.ts`（按会话，不持久化），`compactRun.ts` 把启动器的阶段写进去；`middleColumnLayout.shouldShowStatusLine` 加可选 `working`。
2. **防重复**：进行中再回车 `/compact`，渲染层直接答「这个对话正在压缩中」（在途标记，两次回车也只有一次能通过 `begin`）；Main 侧条目加 `compacting` 标记，第二次压缩答 `compact_in_progress`，渲染层同一句话。
3. **结果全部是中文**（`compactOutcomeToast`，一张表）：

   | 情形 | 提示 |
   |---|---|
   | 回合进行中（输入框判定，或 Main `session_busy`、bridge `WORKER_SESSION_BUSY`） | 「等这一轮结束后再压缩上下文」（原有） |
   | 带附加说明 | 「/compact 不接受附加说明」（原有） |
   | 已在压缩 | 「这个对话正在压缩中」 |
   | 从没运行过；DSH 答 "No compactable history yet." | 「还没有可以压缩的内容 / 对话里还没有可以压缩的较早内容。」 |
   | 启动失败 | 「压缩上下文失败 / 对话没能启动，原因见对话里的提示。」+ 失败卡（工作区不一致 → 原有不可重试卡；旧对话迁移失败 → 原有那句） |
   | 引擎正在重开 | 「…引擎正在重新打开这个对话，请稍后再试。」 |
   | 启动后、压缩前对话被结束或释放 | 「…对话在压缩开始前停止了运行，没有压缩。」 |
   | 压缩途中被结束或引擎重启（Main `worker_compact_interrupted`） | 「…压缩途中对话停止了运行（对话被结束，或引擎重启）。重新打开对话，可以看到摘要是否已经写入。」——没有收到答复，不能断言没写 |
   | `WORKER_COMPACT_TIMEOUT` | 「…生成摘要用时过长，压缩已取消，对话没有改动。」 |
   | `WORKER_COMPACT_FAILED`「could not produce a useful summary」 | 「…没能生成有用的摘要，对话没有压缩。这次尝试已记录在会话日志里。」 |
   | 其他（DSH 的其余原句） | 「压缩上下文失败」+ DSH 原句去掉错误码 |

   失败的完整原文（带码）写 `console.warn('[compact] …')`，进渲染层日志。
4. **启动途中发消息**：输入框不发出，info 提示「等对话启动后再发送 / 消息还留在输入框里，对话启动后再发送。」；队列释放同样等待（`isInFlight`）。压缩成功后只在输入框还是这条命令时才清空，途中写的消息留着（以前成功会清掉当时输入框里的任何内容）。**压缩阶段的发送不在本决策范围**（编排者：「压缩期间发消息的 10 秒超时」另行问用户），照旧送到 Main。
5. 首页上的 `/compact` 仍按决策 175 拦下，不建对话。

### 3.3 目标条

1. 没有活 worker 时也给按钮：激活的目标显示「目标已挂起」+「继续」，暂停 / 受阻的给「继续」，菜单里照常有「编辑目标…」「清除目标…」；`GoalBarView.controls` 删除。
2. 按下 → `runGoalCommand(sessionId, line, sessionStartEffects)`：没启动先启动（目标条的状态文字临时换成「正在启动对话…」，按钮在途禁用），再跑 `/goal …`。启动失败 toast「目标没有改动 / 对话没能启动，原因见对话里的提示。」；对话在执行前停止运行 → 「对话在操作开始前停止了运行，没有任何改动。」；其他失败去掉 Electron 外壳，原文进日志。
3. 已知缺口（不改）：应用重启后目标条要等对话在宿主上运行、宿主发来投影才出现（投影只来自 worker）。要在启动前显示，需从文件读目标投影，涉及宿主，另议。

### 3.4 会话分支对话框（树、回退、分叉）

同一个启动器：打开对话框时没启动先启动（状态行显示「正在启动对话…」），再读树；回退、分叉被 Main 答「没在运行」时同样启动后再试一次。失败一律是词典里的句子（`SESSION_START_KEYS`），旧对话迁移失败仍是原来那句。

### 3.5 Main（`WorkerManager.ts`）

- `requireReadySession` 的原文改为 `Session <id> is not running on the DSH host`（码不变，只进日志与卡片详情），去掉「Pi WorkerSlot」。
- `compactSession`：`compacting` 标记与 `compact_in_progress`（§3.2 第 2 条）；请求被槽自己切断（`WORKER_SLOT_DISPOSING`、`WORKER_EXITED` 等本地失败，不是 worker 的答复）→ `worker_compact_interrupted`，原文里不再带会话文件路径；答复不是压缩时的原文去掉「Pi worker」。
- 不改：发送在压缩期间的准入（§3.2 第 4 条）、回收与驱逐规则、`assertIdleEntry`（回合中仍拒绝压缩）。

### 3.6 顺手修的其他露出

- 后台任务窗口「停止」、子代理窗口「中断」：Main 答「没在运行」时说「这个对话已不在运行，它的任务也随之结束了。」（任务随 worker 结束，不为它启动对话）；其他失败去掉 Electron 外壳。
- 向上翻页：渲染层以为有 worker、Main 答 `session_not_found` → 改读文件（决策 030 的预览通道），不再写「读取历史失败」卡。

### 3.7 没有改的

bridge 协议、宿主（`src/dsh-host/`）、DSH 行为；金样本不需要重录；`typecheck:dsh-host` 不涉及。自动压缩、摘要 `maxTokens`、压缩期间发消息的 10 秒超时按编排者要求不动。

## 4 `requireReadySession` 调用方逐个判定

| 调用方（`WorkerManager.ts`，HEAD 行号） | 用户入口 | 老对话上会主动触发 | 判定 |
|---|---|---|---|
| `compactSession`（1561） | `/compact` | 是 | **先启动再执行**（§3.2） |
| `runSessionCommand`（1598） | 目标条暂停 / 继续 / 编辑 / 清除 | 是（改后按钮常在） | **先启动再执行**（§3.3） |
| `getSessionTree`（1712） | 顶栏「会话分支」 | 是：只要有 `runtimeIdentity` 就有按钮 | **先启动再执行**（§3.4） |
| `rewindSession`（1749） | 分支对话框里的回退 | 树加载后才能点，对话已在运行；竞态里可能被拒 | **同一启动器**：被拒时启动后再试一次（用户已确认的同一操作） |
| `forkSession`（1835） | 分支对话框里的分叉 | 同上 | **同一启动器** |
| `startTurn`（2102，发送与「继续」） | 发送、失败卡「继续」 | 是 | 不改：`runSend` 自己就是这条启动路径（新建 / 恢复 / `session_not_found` 回退） |
| `loadHistoryPage`（1424） | 向上翻页 | 是 | **不启动**：翻页是读，决策 030 规定读不起 worker；改为回退到读文件（§3.6） |
| `killSessionJob`（1641） | 后台任务窗口的停止 | 否：任务随 worker 结束，窗口里那一行已是「引擎重启，任务已结束」 | **不启动**：为停一个已不存在的任务启动对话没有意义；只把报错改成中文（§3.6） |
| `interruptSubagent`（1689） | 子代理窗口的中断 | 否：同上 | **不启动**；报错改中文 |

不经 `requireReadySession`、不适用的：插话（`interject`，只在回合进行中有意义，没有 worker 时答「未插入」，按普通发送走）、#8 的撤回（`withdrawInterjection`，没有 worker 答 `not_found`）、面板与任务输出读取（`getSessionPanels`、`readSessionJob`，没有 worker 答空）、权限与档位（`setPermissions`、`setPermissionTier`，没有条目时只记下、下次启动带上）、斜杠菜单（决策 175）、Stop（没有 worker 时 Main 当场答 `no_active_turn`）。改模型、改档位每次随发送传，没有单独的 Main 调用。

## 5 途中事件的确定行为

| 阶段 | 事件 | 行为 | 测试 |
|---|---|---|---|
| 启动中（「正在启动对话…」） | 发消息（回车、Ctrl+Enter、队列释放） | 不发出；提示「等对话启动后再发送」；消息留在输入框；压缩成功后也不清掉它 | `[176-C-03]` |
| | 再次 `/compact` | 「这个对话正在压缩中」，不发第二次 | `[176-C-04]`（压缩阶段）、`compactRun` 的 `begin` 闩 |
| | Stop / Esc | 没有回合，输入框不出 Stop，Esc 不发 Stop；启动与压缩照常走完 | `[176-C-09]` |
| | 结束对话（侧栏「结束对话」） | Main 的关闭排在恢复之后；渲染层收到结束信号后不再请求压缩，提示「对话在压缩开始前停止了运行，没有压缩」；若压缩请求已先到 Main，则按下一行处理 | `[176-C-05]`、`[RS-07]` |
| | 宿主重启 / 起不来 | 启动失败写卡（`engine_unavailable` 等），提示「对话没能启动…」；正在重开则「请稍后再试」 | `[SS-06]`、`[SS-07]`、`[176-C-02]` |
| 压缩中（「正在压缩上下文…」） | 再次 `/compact` | 渲染层在途标记先答；另一个窗口发来的由 Main 答 `compact_in_progress` | `[176-C-04]`、`[176-WM-2]` |
| | Stop | 没有回合；Main 的 `stop` 当场答 `no_active_turn`，压缩照常完成 | `[176-WM-5]`、`[176-C-09]` |
| | 结束对话 | 槽被释放，压缩请求立即被切断 → `worker_compact_interrupted` →「压缩途中对话停止了运行…重新打开可以看到摘要是否已经写入」 | `[176-WM-3]`、`[176-C-07]` |
| | 宿主重启 | 同上；Main 照常把对话重开（`session.resumed`），之后可再压缩 | `[176-WM-4]` |
| | 发消息 | **不在本决策范围**（编排者：另行问用户）：照旧送到 Main | — |
| 任意 | 回合进行中 | 输入框当场答「等这一轮结束后再压缩」（原有）；Main 与 bridge 的同类拒绝也归到这一句 | `[CC-01]`、`[CC-02b]`、`[CC-176-01]` |

## 6 验证（2026-10-10～11，开发机，一次一个测试进程，每次先看 `free -m`）

### 6.1 复现

- Main 侧先写的测试在改动前失败：`[176-WM-1]`（原文是 `No ready Pi WorkerSlot exists for s1`）、`[176-WM-2]`（第二次压缩被放进 worker）、`[176-WM-3]`、`[176-WM-4]`（答复是槽的原句 `Worker slot <会话文件路径> is disposing`、`Worker exited …`）；`[176-WM-5]`、`[176-WM-6]` 改前即成立，作回归保护。IPC 侧 `[176-IPC]` 八个通道改前全部不带码。
- 渲染层变异检查：把 `ChatComposer.tsx`、`compactCommand.ts`、`legacyMigration.ts` 临时换回 HEAD 版本跑 `compactStartMount`，9 项全部失败（HEAD 不启动对话、直接调 `compactSession`；启动失败一类根本走不到）；换回后三个文件 sha256 与换前一致，再跑 43 项通过。

### 6.2 新增与改写

- `agent-host/__tests__/WorkerManager.test.ts`：新增一组 6 项（`[176-WM-1]`～`[176-WM-6]`）。
- `ipc/__tests__/chatPiWorkerRouting.test.ts`：新增 10 项（八个操作通道带码、恢复带码、worker 原句不变）。
- `chat/__tests__/sessionStart.test.ts`（17 项，新）、`compactStartMount.test.ts`（9 项，新，挂载真 `ChatComposer`）、`compactCommand.test.ts`（新增 7 项，改写 3 项）、`sessionTreeDialogMigration.test.ts`（改写 3 项、新增 3 项）、`sessionPanelStripsMount.test.ts`（改写 1 项、新增 2 项）、`sessionPanelsModel.test.ts`（改 3 项）、`goalStart.test.ts`、`composerGoalEntry.test.ts`（各改 1 项）、`stores/__tests__/sessionPanels.test.ts`（改 1 项、新增 2 项）、`sendRefusalWiring.test.ts`（改 1 项）、`sessionIndex/__tests__/legacyMigration.test.ts`（随 `runAfterLegacyMigration` 删去 4 项）；`sessionTreeDialogDsh.test.ts`、`workspace-shell/__tests__/sessionBranchesEntry.test.ts` 把两个已不用的桩换成 `sessionStartDeps` 的桩（对话框不再引用那两个 hook；不换会加载真设置 store，挂死在渲染层日志上）。
- 真宿主集成 `dshSharedHost.integration.test.ts` 新增 `[176-IT]`：建对话、两轮（P0-STREAM、P0-TOOL）→ 放开归属、等宿主心跳报空闲 → 闲置回收（`disconnected/released`）→ 压缩被拒 `session_not_found` → 发送路径的恢复 → 压缩成功（带回摘要行，2648 ms）→ 再发一轮正常。

### 6.3 门禁

- `AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts -t 176-IT`：1 项通过（41 项跳过），21.4 s。
- `pnpm exec vitest run src/main/services/agent-host`：28 个文件通过、1 个跳过，600 项通过、42 项跳过（真宿主集成）。
- `pnpm exec vitest run src/renderer/components/chat`：166 个文件、3314 项中 3313 项通过；1 项是仓库级扫描用例在负载下超时（`messageTimelineWiring.test.ts`「only MessageTimeline.tsx imports … ChatMarkdown」，8.1 s > 5 s），单独重跑 61/61 通过。
- `pnpm exec vitest run Static Scan Wiring`：79 个文件、821 项。
- `pnpm exec vitest run src/shared/__tests__`：38 个文件、624 项（含词条覆盖）。
- `pnpm exec vitest run src/renderer/stores src/renderer/components/workspace-shell src/main/ipc`：138 个文件、2056 项。
- `biome check`（本决策改动的 37 个代码文件）：无问题。
- `pnpm typecheck`：本决策的文件无错误；同一工作树里另一个会话（决策 177，自动压缩）正在改的 `settings/__tests__/autoCompactionSettings.test.ts` 有一处类型错误，与本决策无关。
- 没改 `src/dsh-host`，不跑 `typecheck:dsh-host`；bridge 协议与录制金样本不变，不用重录。没有起 Electron、没有整包构建。

## 7 风险

1. **启动是渲染层发起的**：同一对话在两个窗口里同时触发，两个窗口各自启动；Main 按指纹合并恢复，参数不同（两个窗口里的模型选择不同）时后到的答「另一个恢复在途」，归入「对话没能启动」卡。
2. **目标条在没启动时给按钮**：按「继续」会启动对话并让目标继续跑下一轮（会花模型额度）；以前要先发一条消息。
3. **压缩阶段发消息**仍是原来的行为（编排者列为另行问用户的「10 秒超时」问题）。
4. **`compacting` 只挡第二次压缩**，不挡发送、不阻止回收或驱逐；压缩途中对话被容量驱逐时按 §5「压缩途中被结束」处理。
5. **启动后才知道没有可压缩的内容**：老对话很短时，用户看到「正在启动对话…」后得到「还没有可以压缩的内容」——这次启动没有白费，对话已经在运行。
6. **翻页回退读文件**：渲染层以为有 worker、Main 已回收时，某些状态（条目还在但未就绪）会让文件读取答 `worker_active` 再问 worker，仍可能落到「读取历史失败」卡（极少见）。
7. **`resumeSession` 的错误现在带码**：发送路径的失败卡与输入框红框里的原文前面多了 Main 的码（例如 `worker_capacity_reached: …`）；`dsh_host_unavailable` 因此能走到「引擎没在运行」卡（以前落到「读取历史失败」）。

## 8 Windows 现场清单（下一个测试包起）

1. **重启后的老对话**：重启应用，打开一个有内容、没发过消息的老对话，输入 `/compact` 回车：状态行先「正在启动对话…」再「正在压缩上下文…」，结束后时间线末尾出现「上下文摘要」行；不再出现 `No ready Pi WorkerSlot`。
2. **闲置回收**：对话闲置超过 15 分钟（期间切到别的对话），回来 `/compact`：同第 1 条。
3. **启动失败**：把一个老对话的仓库目录改名或删掉，再 `/compact`：toast「压缩上下文失败 / 对话没能启动，原因见对话里的提示」，时间线上是「工作目录已不存在」卡；输入框上方没有英文红框。
4. **旧版本对话**：1.0.x 的 pi 对话直接 `/compact`：先显示「正在把这个对话迁移到当前引擎…」与「正在启动对话…」，迁移后压缩。
5. **重复回车**：压缩进行中再按回车：提示「这个对话正在压缩中」，只压缩一次。
6. **启动途中发消息**：在「正在启动对话…」时删掉 `/compact`、写一句话回车：提示「等对话启动后再发送」，话留在输入框，压缩成功后也还在。
7. **结束对话**：在「正在启动对话…」时从侧栏结束这个对话：提示「对话在压缩开始前停止了运行，没有压缩」。
8. **引擎重启**：压缩进行中在设置里换模型或登录（会重建引擎）：提示「压缩途中对话停止了运行…」，重新打开后看摘要是否写入。
9. **目标条**：一个带目标的对话闲置被回收后，目标条仍有「继续」与「编辑目标… / 清除目标…」；按「继续」：目标条短暂显示「正在启动对话…」，之后目标继续。
10. **会话分支**：重启应用后打开老对话，点顶栏「会话分支」：对话框先显示「正在启动对话…」再出树；不再显示 `No ready Pi WorkerSlot`。
11. **路径写法**：仓库路径大小写或斜杠与索引不同时（决策 163 的情形），`/compact` 照常启动、压缩。
12. 中文界面下所有新提示完整不截断；暗色主题下状态行的转圈与灰字可读。

## 9 用户审批

- [x] 第 1 节（用户 2026-10-10 的裁决与编排者补充）
- [ ] 3.1 渲染层复用发送的启动路径（不新建、不写原文红框）；九个 IPC 通道带错误码
- [ ] 3.2 `/compact` 的状态行两段、防重复、全部中文提示、启动途中的消息等待
- [ ] 3.3 目标条在没有活 worker 时也给按钮，按下先启动
- [ ] 3.4 会话分支对话框同样先启动
- [ ] 3.5 Main 的 `compact_in_progress`、`worker_compact_interrupted` 与原文改写
- [ ] 3.6 任务窗口、翻页的顺手修正
- [ ] 第 4 节逐个判定（翻页、停止任务、中断子代理不启动）
- [ ] 第 7 节风险的接受程度
- [ ] 第 8 节 Windows 现场清单

## 用户审批补记（2026-10-11）

- 没启动的对话里目标条也显示「暂停 / 继续 / 编辑 / 清除」，按下先启动再执行（推翻 P1-7a「没有活 worker 不出按钮」）：**用户同意**。

## GUI 点验后的修复（2026-10-11）

### 缺陷

1. 首页选「不选仓库（临时对话）」发一条消息，等这个对话被回收（容量回收或闲置 15 分钟），打开它输入 `/compact` 回车：toast「压缩上下文失败 / 这个对话没有可以运行的文件夹。」。同一对话直接发消息能正常恢复；重启应用后同类对话的 `/compact` 正常。
2. 启动失败时出的「工作目录已不存在」卡（点验截图 `i4-start-failure.png`），中文正文里有英文词「worker」：「……因此无法启动它的 worker。……」。

### 根因（HEAD `ea8420b9` 上核实）

- 本次运行里新建的临时对话在 store 里**没有 `session.unbound`**：`createUnboundChatSession`（`stores/chatSessionActions.ts` 143–169）有意不写，`unbound` 只在重启后的索引合并（`mergeSessionIndex`）或分叉（`materializeIndexedPiChatSession`）时写入；它的 `workspaceId` 是空串，store 里也找不到工作区。
- 发送路径不看 `unbound` 有没有：`ChatComposer.tsx` 2129–2131 取「可用的仓库目录 → 记在对话上的临时目录 → 空」，空就在握手里（2998–3008）调 `useScratchWorkspaceStore.ensure(sessionId)` 取或建临时目录（本次运行第一次发送时分配过的，store 里有记录，不再走 IPC；Main 也是幂等的）。
- 本决策的启动器只读对话本身：`sessionStart.ts` 141–146 调 `shouldResumeSession(session, workspace, …)`，后者（`sessionIndex/resumeIntent.ts` 114–117）在「没有 `unbound` 也没有工作区」时答 `no-workspace`；`sessionStartDeps.ts` 64–72 的 snapshot 也不带临时目录。于是 `/compact`、目标条按钮、会话分支对话框（树、回退、分叉）对这类对话一律答「没有可以运行的文件夹」。重启后的临时对话带 `unbound`，所以正常。
- 同一判定的另一个入口：时间线上历史卡的「重试」与「重启引擎」（`resumeSessionById`，`sessionIndex/useResumeSession.ts` 55–61）也只读对话本身，本次运行新建的临时对话按下去答「重试未生效」。这张卡在启动失败（例如引擎没起来）或发送的恢复失败时出现，所以本条修法一并处理。
- 「worker」：`historyError.ts` 375 的 `workspace_missing` 正文英文键里有 worker，中文译文（`shared/i18n.ts` 3003）照搬了这个词。

### 修法

1. **一条规则，三处共用**：新增 `components/chat/runDirectory.ts`，就是从发送路径抽出来的那段——`knownRunDirectory(session, workspace)`（可用的仓库目录，否则记在对话上的临时目录，否则 `null`）与 `ensureScratchRunDirectory(sessionId)`（`useScratchWorkspaceStore.ensure`，首次分配、之后同一个）。
   - 发送路径（`runSend`）改用这两个函数，行为不变（仍在 `ensureHost` 之后取临时目录，仍和「停止」竞速）。
   - 启动器（`startSessionAsSendDoes`）：先挡掉「有回合在跑」（`isSessionBusy`，不为它去要目录），再 `knownRunDirectory`，为空就经注入的 `deps.ensureScratchDirectory`（`sessionStartDeps` 接到 `ensureScratchRunDirectory`）取临时目录；取不到才答 `no-workspace`（不写卡）。目录作为 `shouldResumeSession` 的新可选项 `workspacePath` 传入，优先于它自己从对话上读的值。
   - 历史卡的重试（`resumeSessionById`）：同样先 `knownRunDirectory`；为空且这次恢复确实会打开它（有会话文件、不在回合中）时才 `await` 取临时目录——其他恢复照旧同步发出。
2. `shouldResumeSession` 不传 `workspacePath` 时行为不变（侧栏点开对话仍按原来的读法）。
3. 词条：只改这一条的中文，「……因此会话无法启动。……」；英文键不动。
4. 一个随「与发送一致」带来的变化：仓库已不在本窗口里的老对话（`workspaceId` 非空但找不到），发送路径向来把它当没有文件夹、去取临时目录再恢复，Main 因目录与索引不符拒绝、出「工作目录不匹配」卡；启动器现在也这样（以前直接说「这个对话没有可以运行的文件夹」）。这类对话很少见：索引合并不会为找不到工作区的索引行建对话（放进 `orphaned`），只有本次运行里已经在列表上的对话才可能这样。

### 其他入口的排查

- 走同一个启动器（`sessionStartEffects`）的全部入口都随第 1 条修好：`/compact`（`compactRun.ts`）、目标条的暂停 / 继续 / 编辑 / 清除（`GoalBar.tsx` → `sessionPanels.runGoalCommand`）、会话分支对话框的树、回退、分叉（`SessionTreeDialog.tsx` 的 `afterStart`）。
- 历史卡的「重试 / 重启引擎」（`MessageTimeline.tsx` → `resumeSessionById`）：同一判定，已修。
- 侧栏点开对话（`useActivateSession` → `resumeIdentityForActivation`）仍按 `unbound` 判断临时对话；本次运行新建的临时对话时间线就在内存里，按规则 3 本来就不恢复，没有可见缺陷，不改。
- 任务窗口、子代理窗口的停止与中断（不启动对话）、翻页（`loadOlderHistoryPage` 只看是否绑定）、输入框的 `/goal`（走发送路径）：不涉及工作区判定。

### 验证（2026-10-11，开发机，一次一个测试进程，每次先看 `free -m`）

- 复现：先写的测试在改动前 8 项失败——`sessionStart.test.ts` 的 `[SS-03b]`（本次运行的临时对话答 `no-workspace`）、`[SS-03c]`、`[SS-04]`（回合中的临时对话答 `no-workspace` 而不是 `busy`）；`compactStartMount.test.ts` 的 `[176-C-10]`、`[176-C-11]`（挂载真 `ChatComposer`，回收后的临时对话 `/compact` 不启动）；新文件 `temporaryChatStart.test.ts`（接真 store 与 `sessionStartEffects`）的 `[TC-01]` 目标条、`[TC-02]` 会话分支、`[TC-03]` 历史卡重试。`[176-C-12]`、`[TC-04]`（重启后带 `unbound` 的临时对话）改前即通过，作回归保护。改后全部通过。
- 新增与改写：`sessionStart.test.ts` 新增 2 项、改写 2 项（`[SS-03]` 的桩原来让对话同时带 `unbound` 和工作区，改成 store 的真实形状；`[SS-04]` 的「没有文件夹」改为「临时目录也取不到」）；`compactStartMount.test.ts` 新增 3 项；`temporaryChatStart.test.ts` 4 项（新）；`unboundChatWiring.test.ts` 改写 2 处钉子（发送路径改调共用函数）、新增 1 项（启动器、启动器接线、历史卡重试都用 `runDirectory.ts`，三处都不再直接调 store 的 `ensure`）；`historyError.test.ts` 新增 1 项（`workspace_missing` 的中文不含 worker）。
- `pnpm typecheck`：通过。
- `biome check`（改动的 12 个文件）：无问题。
- `pnpm exec vitest run src/renderer/components/chat`：168 个文件、3342 项通过。
- `pnpm exec vitest run src/renderer/stores`：44 个文件、873 项通过。
- `pnpm exec vitest run src/renderer/components/workspace-shell`（`resumeSessionById` 也服务侧栏点开）：69 个文件、962 项通过。
- `pnpm exec vitest run Static Scan Wiring`：79 个文件、823 项通过。
- `pnpm exec vitest run src/shared/__tests__`：39 个文件、628 项通过。
- 没改 bridge 协议、宿主与 DSH，不跑 `typecheck:dsh-host`、不重录金样本；没有起 Electron、没有整包构建。GUI 复验留给下一次点验：「不选仓库」新建临时对话 → 发一条 → 等回收 → `/compact`、目标条「继续」、会话分支都先显示「正在启动对话…」再执行；改名或删掉一个仓库目录后 `/compact`，「工作目录已不存在」卡的中文里没有 worker。
