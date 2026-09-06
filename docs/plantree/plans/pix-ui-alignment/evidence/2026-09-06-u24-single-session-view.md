# Evidence — U24 中栏回到单会话视图 + 后台并发

**日期**：2026-09-06
**批次**：13（第二片）
**依据**：[D12](../decisions/012-single-session-view-and-background-concurrency.md) 三条决定。
**来源**：用户点验反馈第 5 条——「用 TAB 管理的方式我用起来确实很别扭」。

## 一、开工取证：后台继续执行是既有能力

用户的疑问是「切换走了某个对话，该对话中的任务能否照常执行」。
先查了回收规则再动手，答案是**能，而且一直能**。

`WorkerManager.ts` 的 `isSafeToEvict` 要求四条同时成立才允许回收一个 worker：

1. `entry.state` 是 `ready` 或 `error`；
2. `ownerWebContentsId === null`——不是当前前台会话；
3. `activeRequestId === null`——**没有正在执行的回合**；
4. `pendingBlockingRequests` 为空且 `mutationInFlight` 为空。

第 3 条就是用户担心的那件事。而 `claimEntry`（同文件）的语义是
「一个窗口同时只认领一个 entry」，认领新会话会把旧会话的 owner 置空——
所以「切走」在 Main 看来只是「不再是前台」，从不是「关闭」。

**结论：Tab 从未参与后台存活的判定。** D08 引入 Tab 时没有为此增加任何能力，
删掉 Tab 也不会减少任何能力。真正缺的是三样：一个替代 Tab 的启动态提示、
一个够用的上限、以及回收发生时的说明——本片补的正是这三样。

## 二、决定一：删 Tab 条，回到单会话视图

**删除**：`SessionTabs.tsx`（337 行）、`stores/sessionTabs.ts`（87 行）、
`sessionTabsModel.ts`，以及 `WorkspaceShell` 里把 `activeSessionId` 镜像成打开态的
effect 和它的 `pruneSessions` 伴生 effect。

**新增** `SessionBar.tsx`：一条 `h-9` 横条，左侧是当前会话标题 + 忙碌点 +
`Temporary` 标记 + 目录上下文（路径进 tooltip），右侧是新建按钮与 GUI/TUI 开关。
形态回到 D08 之前的 `MainHeader`，但**不含** D08 已永久删除的两个控件
（面板开关、双栏/三栏切换，它们随 `shellColumnMode` 一起没了）。

**左栏启动态标记换了数据源**：原来读 `openSessionIds.includes(...)`（有没有 Tab），
现在读 `hostBoundSessionIds.includes(...)`（有没有活着的 worker）。
后者由 `session.created` / `session.resumed` 写入，由结束对话与容量回收清除，
**是真事实**；前者只是「曾经打开过 Tab」——Tab 能活过它的 worker，
而那正是 D09 当初要修的困惑。文案同步从「已在标签页中打开」改成「正在后台运行」。

**「结束对话」找到新家**：`closeSessionTab.ts` → `endSessionRuntime.ts`
（函数同步改名），入口挂到左栏会话行的右键菜单，排在 Archive 之前——
仓库三个「关闭」按严重度排列。**只在 `started` 为真时出现**：
没有 worker 的会话上，这一项点了什么也不会发生。确认框沿用 D09 的三句话，
主语从「这个」改成会话名。

## 三、决定二：并发上限 4 → 10

`resolveDefaultWorkerCapacity` 由 2 / 3 / 4 改为 **3 / 6 / 10**（≤4GiB / ≤8GiB / 其余），
`AICLIENT_PI_WORKER_CAPACITY` 的合法区间由 1–8 改为 **1–10**，
硬上限提取为 `MAX_WORKER_CAPACITY` 常量，报错文案随之派生而不再手抄数字。

**内存分档保留**，这是让提高后的默认值能安全发货的原因：一个 slot 是一整个
utilityProcess 加一份模型上下文，4GiB 机器上开十个不是十个能干活的对话，是十个在换页的。

**为什么必须提**：超过容量时新会话**不排队**，直接抛 `worker_capacity_reached`。
旧上限让「同时开十个对话」这件事不是慢，是做不到。

## 四、决定三：回收时说一次

原来的回收在**两个方向上都是静默的**：

- 渲染层仍把该会话留在 `hostBoundSessionIds` 里，
  于是下一次发送会跳过 `createSession`，去找一个已经不存在的 worker；
- 用户看到一个对话悄悄不再是「已启动」，没有任何交代。

一条 `session.status` 同时解决两件事：`disconnected` 是渲染层需要的状态，
新增的可选字段 `disconnectReason: 'capacity_reclaimed'` 是要说的那句话。

**为什么是搭车而不是新事件类型**：它不独立成立——它限定的是同一条载荷里已有的
`status`（「断开了，而且这是你唯一无法自行归因的那个原因」）。
独立事件反而要再和它解释的那条 status 做关联。对照 `session.stderr`：
那个之所以独立成型，正因为它是一条独立的流。这段推理写进了 `[W-1]` 那条 pin 的注释里。

**新增 `evictForCapacity(victim)`**，三个容量驱逐点改用它；
`reclaimIdleInternal`（15 分钟空闲扫描）**刻意不用**——那是另一条线，
D12 明确不动它，把超时说成「池满了」是误报。这条有专门的反向断言守着。

**渲染层**：reducer 在 `capacity_reclaimed` 时把该会话移出 `hostBoundSessionIds`，
但**保留 `messages`**——与主动结束对话不同，这不是用户要求的，
正在读的记录不能在眼前清空。代价是下次发送要 resume 一次，而这正是回收本身换来的东西。
提示语由 `useCapacityReclaimNotice` 发一条 info toast。

## 五、门禁

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test`（全仓） | **276 files / 4219 tests pass** |
| `npx biome check src/` | 干净 |
| `git diff --check` | 干净 |

测试数从 U22/U23 后的 275 files / 4210 增至 276 / 4219：新增 9 条
（`singleSessionViewStatic` 4 条、WorkerManager 2 条、`chatSessionsBatch` 2 条、
`endConversationWiringStatic` 净增 1 条）。

## 六、改写的既有断言（六个文件，逐条理由）

**不是覆盖率倒退，是被钉的事实换了载体。**

1. **`agentWireStatic.test.ts` `[W-1]`** — `SessionStatusEvent.payload` 的可选键集合
   由 `{retry, liveness}` 改为加上 `disconnectReason`。这条 pin 的用途就是逼人回答
   「第四个可选键该不该在这里」，理由写在上面第四节，也补进了它自己的注释。
2. **`WorkerManager.test.ts` 容量档位** — 2/3/4 → 3/6/10，越界用例 `9` → `11`，
   错误文案 `1 to 8` → `1 to 10`。新增一条 `10` 在 4GiB 机器上仍可被显式覆盖的用例。
3. **`sessionTabCloseStatic.test.ts` → `endConversationWiringStatic.test.ts`** —
   三条断言（先确认、只在确认分支 detach、不动左栏行）**逐条保留**，
   读取的文件从 `SessionTabs.tsx` 换成 `LeftNav.tsx`；新增第四条
   「只在有 worker 时提供该项」。
4. **`deadControlsStatic.test.ts`** — `SessionTabs pins` → `SessionBar pins`。
   三条守「诚实」的断言（不得有硬编码 usage 环、browser/preview 不进中栏、
   目录上下文必须仍可达）原样保留；`max-w-52` 那条随 Tab 退役，
   它守的截断风险改由 `min-w-0 flex-1` + `truncate` + `shrink-0` 守。
5. **`panelVisibilityStatic.test.ts`** — 「中栏不得有第二份 surface 切换器」
   的读取目标由 `SessionTabs.tsx` 换成 `SessionBar.tsx`，断言本身不变。
6. **`unboundChatWiring.test.ts`** — 临时标记的正则由 `tab.unbound` 改为
   `activeSession?.unbound`，读取目标同步换文件。标记该在「当前会话被命名的地方」
   这条理由不变。

## 七、变异验证

回退两处核心改动后重跑：

```
× WorkerManager … D12: announces a capacity eviction so the renderer can drop its stale binding
× applyRuntimeEvents … D12: a capacity reclaim drops the host binding but keeps the transcript
Test Files  2 failed (2)     Tests  2 failed | 76 passed (78)
```

恢复后 78 条全绿。

## 八、欠项

- **GUI 点验未做**。看点：① 中栏不再有 Tab 条，点左栏会话直接切换；
  ② 左栏空心环出现在「已启动但不在前台」的会话上；
  ③ 右键会话行有「结束对话」，确认后该行还在、环消失；
  ④ 开满 10 个会话后再开第 11 个，弹出「有一个对话已转入后台」。
- **10 个 worker 的真机内存占用未实测**（D12 影响一节列的那笔账）。
  自动化只验了上限数字与分档函数，没验十个进程同时在跑时这台机器是什么表现。
- **空闲超时（15 分钟）仍不提示**。D12 明确不动它，但用户撞上时同样会困惑
  「为什么它自己停了」。留作 open question，不在本片范围。
