# D09 — 关闭中栏 Tab 就是结束对话（弹确认框，但不动左栏那一行）

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：用户（「关闭中栏对话 tab 就是关闭对话，而不是挂起后台。关闭时可以弹出个提示窗让用户确认」；
  追问「左栏那条要不要一起消失」时选「只停会话，左栏保留」）
- **修正**：[D08](./008-vscode-dock-shell.md) 决定三留下的「关 Tab 只是收起 Tab」

## 背景：D08 把 Tab 做成了纯视图状态

D08 引入中栏 Tab 时，把「打开态」定义成第三份会话状态（`openSessionIds`），
并刻意让它**单向依赖**：活动的必须是打开的，但关掉一个 Tab 不代表对该会话做了任何事。
`sessionTabsModel.ts` 的注释把这条写死了，`sessionTabs.ts` 的 `closeSession` 也注明
「Does NOT archive or close the session itself」。

这在实现上是干净的，在产品上是错的：用户关掉一个对话之后，它的 worker 还活着、还占着
`WorkerManager` 有上限的 slot 池里的一格，而界面上再没有任何东西指向它。
用户的判断是「这是挂后台，不是关闭」。

## 决定一：Tab 上的 X = 断开该会话的运行时

**采纳**：确认之后调 `chat.closeSession`，即 Main 的 `workerManager.closeSession` →
`retireAndDispose`，utility process 一并退出。

同时必须在渲染层复位三样东西，否则「关掉再打开」会以三种不同方式坏掉：

| 复位项 | 不复位的后果 |
|---|---|
| `hostBoundSessionIds` 去掉该 id | `sendMessage` 认为 Host 已认识这个会话，跳过 `createSession`，下一次发送打到一个不存在的运行时 |
| `messages[sessionId]` 清空 | `useActivateSession` 用 `!hasTimeline` 判断要不要 resume，留着历史就永远不再拉起 worker |
| `historyErrors` / 分页 / 分支版本号 | 它们描述的是刚被丢掉的那次读取 |

状态置 `disconnected` 而不是 `idle`：确实没有运行时挂着，而且 `disconnected` 不在
`isSessionBusy` 里，不会挡住之后的 resume。

## 决定二：左栏那一行留着

**采纳**：不 `markSessionDismissed`、不 `removeSessionRow`、不改 `archived`。

仓库里已经有两个「关闭」，这次刻意选了轻的那个：

- **本决定**：结束这一次运行，对话仍在左栏，随时点开重新载入历史。
- **`closeSessionAndRemoveRow`**（左栏自己的 Close，R5 D2）：额外把行从导航里去掉，
  本次运行内不再出现，重启后回来。
- **Archive**：翻 `archived` 位，永久不出现。

D08 点验清单第 ④ 条「关 Tab 后会话仍在左栏列表里」因此继续成立——变的是它在后台还活不活，
不是它在列表里还在不在。

## 决定三：每次都确认，不做「只在忙时确认」

**采纳**：X 一律先弹 `AlertDialog`。文案分三句，因为要区分的正是「会失去什么」：
标题问是否结束；正文说明会停掉 agent、从后台释放；会话正在跑时补一句红字说明当前这一轮会被中断；
最后一句说明它仍留在左栏、重开会重新载入历史。

不做「只在 busy 时才确认」：那样一个不可逆的动作会因为时机不同而有时问、有时不问，
用户没法建立稳定预期。

## 代价

- 关一个 Tab 从一次点击变成两次。
- 关掉再打开要重新 resume（重新起 worker、重新读历史），不再是瞬时切换。
  这正是「不挂后台」的定义，不是可以顺手优化掉的开销。
