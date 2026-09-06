# Evidence — U22 免绑定开聊入口 / U23 插件清单漏听 resume

**日期**：2026-09-06
**批次**：13（第一片）
**来源**：用户 2026-09-06 累计 GUI 点验反馈第 1 条与第 4 条。

## 一、U22 — 全新状态下开不了聊

### 现场

用户截图（`sharePic/20260906/ac1d2418-…png`）：左栏空态显示「添加仓库 / 添加一个仓库开始使用」，
中栏欢迎卡写着「不选也能直接聊，这时会用一个私有的临时目录」，
而正下方输入框是禁用的，占位符 `Select a session in the left nav before sending…`。
**同一屏上两句话互相矛盾。**

### 根因：U05 拆了一道闸，另一道还在

`ChatComposer.tsx:567`：

```ts
const canSend = Boolean(activeSessionId && (cwd || isUnboundSession) && !disabled && !canStop);
```

`isUnboundSession`（同文件 527 行）是 `Boolean(activeSessionId) && cwd === null`，
所以 `(cwd || isUnboundSession)` 在有会话时**恒为真**——U05 那一半是成立的。
剩下的唯一硬闸是 `activeSessionId`。

而全新状态拿不到 `activeSessionId`：

- `createChatSessionOnWorkspace`（`chatSessionActions.ts:25`）在找不到 workspace 时返回 `null`；
- `LeftNav.handleNewSession` 因此 `if (!effectiveWorkspaceId || !canStartNewSession) return;` —— 空转；
- `+ New` 按钮本身还带 `disabled={!canStartNewSession}`，根本点不动；
- 欢迎卡只提供「选择工作目录」，没有第二个动作。

**四个出口全部关闭。** U13 的注释（`LeftNav.tsx:290`）已经写到「没有仓库的机器上每个 chat 都是
unbound」，但它解决的是**列出**已有的免绑定会话，没人管**第一个**从哪来。

### 改动

1. **新增 `createUnboundChatSession()`**（`chatSessionActions.ts`）。
   形状逐字照抄 U13 在 `sessionIndexMerge.ts:157` 建立的免绑定会话形状：
   `projectId: ''` / `workspaceId: ''`，**不设** `unbound.workspacePath`。
   不设那个字段是有理由的：U13 里它是一个**已经存在**的目录的 resume 句柄，
   而这里目录还没分配（`ensure` 在首次发送时才调用，`ChatComposer.tsx:1708`），
   提前写一个猜测值正是 U13 存在的意义所要防的假 cwd。
2. **`handleNewSession` 的空转分支改为创建免绑定会话**，`+ New` 去掉 `disabled`。
   按钮 title 在这条路径上改说「新建临时对话（没有仓库）」，因为按钮不再禁用，
   落点差异只能由 title 承担。
3. **欢迎卡加「直接开聊」**，且**只在没有 `activeSessionId` 时**传入该回调——
   已经有会话时下方 composer 本就是活的，再给一个入口只会凭空多建会话。

### 未改动

`sendMessage`（`chatSessions.ts:1233`）里那条 `if (!session || !workspace)` 早期返回没有动：
全仓已无调用点（只有 `closeSessionTab.ts:33` 的一处注释提到它），发送实际走 `runSend`。
动一个死函数只会让人以为它还在服役。

## 二、U23 — 插件清单永远停在「发送一条消息…」

### 根因

`useSessionExtensions.ts` 有两条获取途径，两条都在 resume 路径上失效：

1. **挂载时的主动查询**：`sessionId` 一变就发 `chat:listSessionExtensions`。
   Main 端从缓存的 bootstrap 结果读（`WorkerManager.ts:398`），
   此刻 worker 尚未建好 → 返回 `null`。
2. **事件订阅**：只订了 `session.created`。而点开已有会话走 resume，
   发的是 `session.resumed`（`WorkerManager.ts:1893`）。

于是第二次机会从来不到。同仓 `permissionGate.ts:68` 同时读这两个事件，
说明这是既有写法，U04 落地时漏了一个。

### 改动

订阅条件补上 `session.resumed`。一处改动，无其他连带。

## 三、门禁

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test`（全仓） | **275 files / 4210 tests pass**（103.4s） |
| `npx biome check src/` | 干净（`LeftNav.tsx` 的 import 换行由 `--write` 修一次） |
| `git diff --check` | 干净 |

新增 8 条断言：`chatSessionActions.test.ts` 4 条（U22 行为）、
`unboundChatEntryStatic.test.ts` 3 条（U22 入口形状）、
`pluginEntryStatic.test.ts` 1 条（U23 双事件订阅）。基线 4202 → 4210。

## 四、变异验证

同时回退两处修复（`useSessionExtensions` 去掉 `session.resumed`、
`LeftNav` 恢复 `disabled={!canStartNewSession}`）后重跑：

```
Test Files  2 failed (2)
     Tests  2 failed | 7 passed (9)
```

两条各自被自己的断言判红，恢复后 9 条全绿。**不是「加了测试碰巧是绿的」。**

## 五、欠项

- **GUI 点验未做**：U22 的看点是「全新状态下点 `+ New` 或欢迎卡的『直接开聊』，
  输入框变为可用、发得出去、左栏出现临时对话」；U23 的看点是
  「点开一个已有会话，插件对话框列出实际加载的插件，而不是『发送一条消息…』」。
- **U23 只有静态断言**：锁的是「订阅了这两个事件」，不是「resume 之后 UI 真的刷新了」。
  行为测试需要 React 环境加 `window.electronAPI` mock，本仓这个 hook 的既有覆盖
  也是同一层次（`pluginEntryStatic`）。真机验证并入累计点验。
- **老会话不补救**：U22 之前那些「看得见但打不开」的状态不受影响，本片只解决入口。
