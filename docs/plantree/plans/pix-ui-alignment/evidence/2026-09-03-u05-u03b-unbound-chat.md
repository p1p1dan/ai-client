# Evidence — U05 免绑定开聊 + U03-b TUI 解绑（批次 4）

**日期**：2026-09-03
**分支**：`feat/pi-primary-backend`
**切片**：U05-a（隔离 cwd 生命周期）、U05-b（放行发送路径与会话身份）、U05-c（信任态与逐次授权）、U05-d（回归）、U03-b（TUI 解除目录强绑定）
**执行计划**：[execution-plan §三 批次 4](../topics/execution-plan.md)
**边界**：[D02 决定二](../decisions/002-layout-cwd-and-evidence-scope.md)

## 一、做了什么

改造前，没有绑定工作目录的对话**根本无法说话**：`ChatWorkspace` 用欢迎卡整块替换掉输入框，`ChatComposer` 的
`canSend` 与 `runSend` 又各有一道 `!cwd` 硬闸。批次 4 把这条路打通，同时把安全边界一次性钉死。

### U05-a — 隔离 cwd 生命周期（Main 侧）

新增 `src/main/services/agent-host/ScratchWorkspaceService.ts`。

- **落点**：`<临时会话基路径>/unbound-sessions/<uuid>`，`mode 0700`，逐会话一个。基路径复用既有
  「临时会话路径」设置（`defaultTemporaryPath`，缺省 `~/JYWAI/temporary`），Main 自己从
  `readSharedSettings()` 读——渲染器**没有**任何指定路径的入口。
- **惰性创建**：只在**首次发送**或**首次开 TUI** 时创建。侧栏里建了没用的对话不会在磁盘上留目录，
  与本仓既有做法一致（`chat:registerSession` 的注释就写着「用户没打字之前不起 worker、不建运行时会话」）。
- **销毁**：归档会话 → 删该目录；应用退出 → 整个 `unbound-sessions/` 目录树清空；下次启动 → 再清一次
  （这一次覆盖崩溃退出）。启动清理和退出清理**是同一个方法**，因为启动清理就是崩溃时没来得及跑的那次退出清理。
- **跨运行恢复**：上次运行的目录已被清掉，但会话索引行仍写着那个路径。`adopt()` 在原路径**重建一个空目录**，
  所以恢复对话不会拿到一个不存在的 cwd，索引行也不用改写。`adopt()` 拒绝任何不在
  `unbound-sessions/` 下的路径——被篡改的索引行不能把它变成「创建并随后删除任意目录」的工具。

### U05-b — 放行发送路径与会话身份

- `deriveChatEmptySurface` 新增 `unbound` 入参：免绑定会话跳过「没目录」这一档，但**继续下落**到会话检查，
  所以一个真出错的免绑定会话仍然显示红框诊断，不会被伪装成健康。
- `ChatComposer`：新增 `isUnboundSession`（有会话且 `cwd === null`）、`effectiveCwd`（绑定目录 ?? 隔离目录）。
  `canSend` / `hasSendTarget` 放行免绑定；`runSend` 删掉 `!cwd` 早退。
  隔离目录在 **`ensureHost()` 之后、握手 try 之内**分配——分配失败因此走与其他握手失败**同一条**
  `finalizeOutcome` 路径，用户的草稿被保住、Retry 正常武装。同步提交段（T-19 的「不可返回点」）没有被插入 await。
- `ChatWorkspace`：欢迎卡从「**替换**输入框」改成「**在输入框上方**」，只在应用一个目录都没有且中栏处于空态时出现——
  想绑定目录的用户引导没丢，想直接聊的用户可以打字。`renderedMode` 不再被 `hasWorkingDirectory` 强压成 `empty`。
- **临时会话标识（两处）**：会话头部一枚 `Temporary` 徽标（tooltip 说明目录位置与退出即删）；
  侧栏会话行的 chip 对「无 workspace / 空路径 workspace」返回 `temporary`。
- 欢迎卡文案改写：原文「先选一个目录」在「不选也能聊」之后是错的，改成「想在项目里干活就选目录；不选则用私有临时目录」。

### U05-c — 信任态与逐次授权

用户 2026-09-03 拍板：**档位默认务实、用户可手动切换；项目信任另算**。两者是两层：

- **档位**（U12 的四档芯片）决定单次工具调用的裁决。免绑定会话默认 `pragmatic` = 每次都问，不自动放行写入。
- **项目信任**（`projectTrusted`）决定 pi 要不要加载并写入**项目级持久授权**。免绑定会话强制关闭，
  所以「以后这个目录都别问我了」这种记忆**不会**攒在一个用完就删的目录里——授权只对当次生效。

实现：`WorkerBootstrapPayload` 新增 `unbound?: boolean`，`piWorkerRpcServer` 里写成
`this.options.projectTrusted && request.payload.unbound !== true`——**只能减不能加**，
进程本来就不受信任时任何 payload 都无法把它抬成受信任。`sameBootstrap` 把 `unbound` 纳入比较，
所以一次翻转信任姿态的重复 bootstrap 会被判为「不同会话」而拒绝，而不是被第一次建好的 runtime 顺手答掉。

`unbound` 由 **Main 自己**从 `isScratchPath(workspacePath)` 推出，渲染器发来的同名字段被忽略。
`ManagedSlot` 持有该姿态，所以崩溃重启、恢复、fork 都不会把一个 scratch 会话悄悄升级成受信任。

### U03-b — TUI 解除目录强绑定

`ChatWorkspace.tsx` 的 `presentationMode === 'tui' && activeWorkspacePath` 改成
`presentationMode === 'tui' && effectiveCwd`；`AgentTerminal` 的 `cwd` 也换成 `effectiveCwd`。
`openTui` 变成先确保隔离目录再切模式，失败弹 toast 而不是开一个没有目录的终端——
因此 TUI 的 cwd 恒等于该会话自己的隔离目录，不会回落到进程 cwd。头部工具条的显示条件同步放宽，
否则免绑定会话根本看不到 GUI/TUI 开关。

## 二、与计划的两处偏差（需要知会）

1. **隔离目录落在用户主目录下**。execution-plan 的 U05-a 验收①写「不落在用户主目录」，
   但用户 2026-09-03 拍板基路径沿用「临时会话路径」设置（缺省 `~/JYWAI/temporary`）并可在设置里改。
   按用户决定执行。实质暴露面不变：agent 的 cwd 是那个**新建的空子目录**，不是主目录本身。
2. **应用退出会删掉 agent 在临时目录里写的文件**。这是 execution-plan「会话销毁与应用退出时清理」的字面执行。
   对话历史不受影响（pi 的 JSONL 在 agent 目录里，不在 cwd 里），丢的只是 agent 在该目录写的文件。
   UI 已用 `Temporary` 徽标 + tooltip 明示。若你希望改成「只在归档时删、退出时保留」，说一声即可改。

## 三、验收对照

| 切片 | 验收 | 结果 |
|---|---|---|
| U05-a ① | 目录逐会话独立、权限最小 | ✅ `ScratchWorkspaceService.test.ts`：逐会话独立目录、`mode 0o700`（POSIX）、空 sessionId 被拒。落点见上方偏差 1 |
| U05-a ② | 会话销毁与异常退出两条清理路径各有测试 | ✅ 销毁：`release` 四条（只删本会话 / 连内容一起删 / 未分配时 no-op / 删后重新分配）。异常退出：`wipeAll` 五条 + `agentHostCleanup.test.ts` 两条（退出时**在 worker 全部消失之后**才清、启动时同一个清理再跑一次） |
| U05-a ③ | 跨会话不可互访（发布 blocker） | ✅ `[release-blocker] no two sessions ever share a directory` + `one session's directory is outside every other session's cwd`。**如实说明**：所有 worker 同一 OS 用户，文件权限拦不住彼此；真正的边界是权限层——别人的目录属于 `external_directory`，被 delegation envelope 一律压到 `defer`（U12 已测）。0700 是纵深防御，不是边界本身 |
| U05-b ① | 无 workspace/cwd 时可发送 | ✅ `chatEmptyState.test.ts` 新增四条；`unboundChatWiring.test.ts` 断言 `canSend` 含 `isUnboundSession`、旧 `!cwd` 早退已删 |
| U05-b ② | 想绑定目录的用户仍能看到 welcome 引导 | ✅ 欢迎卡改为「在输入框上方」而非替换；测试同时锁死「不能再是 `hasWorkingDirectory ? 输入框 : 卡片`」与「卡片只在空态出现」 |
| U05-b ③ | 会话列表与头部有临时会话标识 | ✅ 头部 `Temporary` 徽标（`unboundChatWiring.test.ts`）；侧栏 chip（`sidebarTree.test.ts` 两条，含空路径占位 workspace） |
| U05-c ① | 未授权时写工具被拒并给出可操作提示 | ✅ 默认务实档 = 每次弹窗，不自动放行；用户拒绝即拒绝。**提示**由头部徽标 tooltip + 欢迎卡承担；**未**改 pi 权限插件自身的弹窗文案（那段文案由插件产出，改它超出本计划授权） |
| U05-c ② | 授权只对当次生效 | ✅ `projectTrusted=false` 抽掉项目作用域，持久授权无处可写。`piWorkerRpcServer.test.ts` 四条 + `WorkerManager.test.ts` 四条 |
| U05-c ③ | 升级路径有测试 | ✅ `chatPiWorkerRouting.test.ts`「does not touch scratch state when resuming a real folder」：绑定真实目录后 `unbound` 整个字段消失，走正常信任门 |
| U05-c ④ | 既有 permission policy 套件全绿 | ✅ 见门禁 §四 |
| U05-d | packaged permission gate + permission policy 全套 | ✅ 全仓 260 files / 4031 tests 全绿 |
| U03-b | 免绑定会话可进 TUI，且 cwd 就是隔离目录，不回落进程 cwd | ✅ `unboundChatWiring.test.ts` 四条：旧强绑定条件已删、`cwd={effectiveCwd}`、进 TUI 前先分配、分配失败弹 toast 不开终端 |

## 四、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：全仓 **260 files / 4031 tests pass**。
2. **typecheck**：`NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck` pass。
3. **typecheck:agent-host**：pass（本批改了 `piWorkerRpcServer.ts` 与 `workerRpc.ts`）。
4. **biome**：27 个改动文件 check 干净（5 个文件经 `--write` 格式化）。
5. **`git diff --check`**：clean。

### 变异验证（证明新测试真的挡得住）

| 变异 | 结果 |
|---|---|
| `spawnForEntry` 去掉 `...(entry.unbound ? { unbound: true } : {})` | 3 条 WorkerManager 测试转红（create/resume/fork 各一） |
| `projectTrusted: ... && payload.unbound !== true` 退回 `this.options.projectTrusted` | 「withholds project trust」转红 |
| `isScratchPath` 的 `startsWith(root + '/')` 退化成 `startsWith(root)` | 2 条路径边界测试转红（root 自身、同前缀兄弟目录） |

## 五、顺手修复的既有红灯（不属本批范围）

批次 2.5（U12）落地时把 `ComposerPermissionTrigger.tsx` 这个**文件名**复活为一个 Pi 原生控件，
而 T31 的「Pi-only 缺席门禁」把这个文件名列在「已删除的 Claude/Codex 期文件」里，于是
`t31PiOnlyAbsence.test.ts` 两条 + `piModelWiring.test.ts` 一条从 U12 起就是红的
（本批开工前 `git stash` 复核确认：与本批改动无关）。

修法是把门禁从「断言这个文件名不存在」改成「断言旧权限 IPC 通道不存在」
（`chat:respondPermission` / `chat:updatePermission` / `permissionMode`）——后者才是这道门禁真正要守的东西，
且不会因为一个文件名被复用而误报。U12 的验收④「既有 permission policy 与 packaged permission gate 全套全绿」
因此才真正成立。

## 六、改动文件

**新增**：`src/main/services/agent-host/ScratchWorkspaceService.ts`、`src/renderer/stores/scratchWorkspace.ts`。

**源码**：`shared/types/ipc.ts`、`shared/types/workerRpc.ts`、`shared/i18n.ts`、
`agent-host/piWorkerRpcServer.ts`、`main/ipc/chat.ts`、`main/ipc/index.ts`、`main/ipc/workerManager.ts`、
`main/services/agent-host/WorkerManager.ts`、`main/services/agent-host/createPiWorkerSlot.ts`、`preload/index.ts`、
`renderer/components/chat/ChatComposer.tsx`、`ChatWorkspace.tsx`、`ChatWelcomeCard.tsx`、`chatEmptyState.ts`、
`middleColumnLayout.ts`、`renderer/components/workspace-shell/sidebarTree.ts`。

**测试**：新增 `ScratchWorkspaceService.test.ts`、`stores/__tests__/scratchWorkspace.test.ts`、
`chat/__tests__/unboundChatWiring.test.ts`；改 `chatEmptyState.test.ts`、`sidebarTree.test.ts`、
`piWorkerRpcServer.test.ts`、`WorkerManager.test.ts`、`chatPiWorkerRouting.test.ts`、`agentHostCleanup.test.ts`、
`piModelWiring.test.ts`、`t31PiOnlyAbsence.test.ts`。

## 七、欠项

- **GUI 点验未做**：与 U09 / U12 / U02 / U03-a 的待做点验合并一次 CDP 出图。非取证型验收，不阻塞后续切片。
- **免绑定会话跨应用重启不出现在侧栏**：索引行的 `workspacePath` 是隔离目录，重启后没有对应的 `ChatWorkspace`，
  `sessionIndexMerge` 会把它判为 orphan 而丢弃。这是**既有行为**（移除文件夹后其会话同样变 orphan），
  不是本批引入，但免绑定会话让它变得常见。已记入 [open-questions Q13](../open-questions.md)，未在本批解决。
- **pi 权限弹窗文案未针对免绑定会话定制**（见验收表 U05-c ①）。
