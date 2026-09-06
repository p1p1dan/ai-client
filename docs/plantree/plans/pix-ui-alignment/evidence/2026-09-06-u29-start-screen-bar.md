# Evidence — U29 起始屏底栏不再是空的

**日期**：2026-09-06
**批次**：14（第二片）
**关闭**：[D14](../decisions/014-start-screen-is-a-live-composer.md)「已知未对齐处」
**拍板**：用户 2026-09-06——「那就全局默认吧」

## 一、问题

U28 之后起始屏能打字了，但底栏只剩附件按钮和发送键。权限档、模型/思考档、
占用三个槽位都写着 `activeSessionId ? … : null`。

后果不只是难看：**第一条消息只能用默认模型发出**，用户没有预选的机会。

## 二、先查 pix 怎么处理，结论是它没有这个状态

`pix/apps/desktop/src/renderer/` 下逐个看过：

- **`Composer.tsx` 不接收 sessionId**。模型、思考档、权限档都是普通 props
  （`modelValue` / `thinkingLevel` / `accessMode`），由 `main.tsx` 传入。
- **模型与思考档属于 host 进程**：`changeModel` 调 `window.pix.models.set()`，
  `changeThinking` 调 `window.pix.thinking.set()`——写给那个常驻的 pi 进程，
  不是写给某次对话。
- **权限档是全局偏好**：`applyAccessMode` 调 `setAccessMode` + `saveAccessMode`，
  与任何会话无关。
- **占用是只读的快照字段**：`snapshot?.usage?.context?.percent ?? undefined`。

pix 是**一个 host、一个当前会话**的模型，所以「没有会话」这个状态在它那里不存在，
只有「host 快照还没到」。它对付快照空档的手法在 `main.tsx:632`：

```ts
const displayModel = snapshot?.model ?? lastComposerChromeRef.current.model;
```

那个 ref 的注释写得很直白：
*"Last known model chrome — survives snapshot gaps so composer never flashes 未选择模型"*。

还有一处更贴近我们的处境——service tier 是 pix 里唯一处理了「host 不在」的控件：

```ts
if (!current) setStatus("Request priority preference saved")
```

**只记下偏好，等 host 起来再应用**；`changeModel` 里配套的注释是
「在另一个模型激活时选的偏好，现在生效」。

## 三、为什么不能照抄，以及抄了哪一半

我们是多会话并发的（U24 刚把上限提到 10），每个会话一个独立进程、一份独立上下文，
模型与思考档因此是**每个会话各自的**（U12 / U08-2 一路建立的语义，
也是「这个对话用 Terra 高强度、那个用 Luna 低」能成立的原因）。

**抄的是规则，不是结构**：控件永不空白，没有会话时用全局模板顶上。

## 四、改动

### 模型与思考档 — 全局位置早就存在

`shared/models/chatAgentDefaults.ts` 的头一行注释就是
「Pi-only defaults for new chat sessions」，字段正好是 `model` / `effort`，
且 `runSend` 已经在读它（`agentDefaultModel` / `agentDefaultEffort`）。

更省事的是：`ComposerModelTrigger` **本来就在每次选择时写它**
（§4.3「an explicit pick also becomes this agent's template」）。
所以这次改的不是新增一个存储，而是**把 per-session 的读写在无会话时跳过**：

- `sessionId: string` → `string | null`；
- 三处读改为 `sessionId ? getSessionModel(sessionId) : null`（effort 同理）；
- 四处写加 `if (sessionId)` 守卫；
- `setChatAgentDefaults` **两种情况下都写**，因为无会话时它是唯一的落点。

### 权限档 — 唯一需要新增全局位的

新增 `DEFAULT_TIER_STORAGE_KEY = 'aiclient:chat:default-tier'` 与
`readDefaultTier` / `writeDefaultTier`。

**用独立 key 而不是在 per-session 映射里占一个保留 id**：那张表按真实会话 id 索引、
由 `removeSessionTier` 清扫，一个哨兵行离「被某次清理顺手删掉」只差一步。

`ComposerPermissionTrigger` 相应地：有会话时写自己那行并通知 worker，
无会话时只写默认值（没有 worker 可通知）。
`runSend` 的 spawn 档位变成两级：
`readSessionTier(sessionId) ?? readDefaultTier() ?? undefined`——
会话自己的档位仍然优先，两个都没有仍然省略字段、由 Main 决定（与 U12 一致）。

另外两处连带：

- `isTierControlDegraded(gates, sessionId)` 的 `sessionId` 放宽为可空，
  `null` 直接返回 false——降级是**运行中的 worker 报告的事实**，还没有会话就没有事实。
- 「host 未就绪」这道禁用闸在无会话时站下（`sessionId !== null && hostState !== 'ready'`）：
  它描述的是一个这个控件还没在对话的运行时。

### 占用 chip — 刻意不动

`activeSessionId ? <ComposerUsageChip …> : null` 保持原样。占用是**实测量**，
一个从未跑过回合的对话没有可测的东西。pix 的读法完全相同。
这条有专门的断言守着，防止有人「顺手也放开」。

## 五、门禁

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test`（全仓） | **278 files / 4230 tests pass** |
| `npx biome check src/` | 干净 |
| `git diff --check` | 干净 |

4228 → 4230：新增 6 条（`startScreenBarStatic.test.ts`），
改写 1 条（`permissionTierWiring` 的 spawn 档位串，见下）。

## 六、改写的既有断言（一处）

**`permissionTierWiring.test.ts`**「从芯片写入的同一个 store 读档位」——
断言串由 `readSessionTier(sessionId) ?? undefined` 改为加上 `?? readDefaultTier()`。
这条 pin 的用意（不许从组件 state 读、必须走同一个 store）没有变，
变的是同一条梯子上多了一级；顺序是承重的，会话自己的档位仍然优先。

## 七、变异验证

把两个槽位改回 `activeSessionId ? … : null`、并撤掉 spawn 的默认档回退：

```
× [U12 fix] … reads the tier from the same store the chip writes
× U29 the start screen keeps its bar controls > model/effort and permission render without a session
Test Files  2 failed (2)     Tests  2 failed | 9 passed (11)
```

恢复后 11 条全绿。

## 八、真机验证

同一支 CDP 探针，干净 profile（临时 `HOME`），改动前后各一张：

| | 底栏按钮 |
|---|---|
| U29 之前（[01](./2026-09-06-u28-shots/01-unbound-start-screen.png)） | `Attach files`、发送键 |
| U29 之后（[05](./2026-09-06-u28-shots/05-bar-with-controls.png)） | `Attach files`、**`Pragmatic`**、**`Automatic`**、发送键 |

`activeSessionId` 在两次采样中都是 `null`、`workspaces` 都是 `0`——
确实是「还没有对话」那一刻，不是恢复出来的会话。

模型显示 `Automatic` 是因为干净 profile 拉不到模型目录，
按 [model-catalog-admin D03](../../model-catalog-admin/decisions/003-empty-catalog-is-legal-drop-seed.md)
空目录是合法状态；有目录时该位显示真实模型名（[03](./2026-09-06-u28-shots/03-bound-start-screen.png)
那张是 U28 时拍的本机 profile，可对照）。

## 九、欠项

- **没验「改完默认再发送，新会话真的用了它」**。自动化锁住了 spawn 读取的那条串，
  真机只验到控件可见可点。这需要真账号真回合，与既有的六件真机验证同性质。
- **无会话时改模型会影响此后所有新会话**，这是用户拍板的语义（与 pix 一致），
  但界面上只有权限档那一个 tooltip 说了「作用于新建的对话」，
  模型菜单的 scope 文案仍是给有会话的场景写的。若日后有人误解，从那句文案改起。
