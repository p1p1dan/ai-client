# Evidence — U28 起始屏改为「可用的输入框」

**日期**：2026-09-06
**批次**：14
**依据**：[D14](../decisions/014-start-screen-is-a-live-composer.md)
**基准**：`sharePic/20260906/pix-desktop.png`

## 一、用户报的崩溃

点「直接开聊」立即抛：

```
Error: Objects are not valid as a React child (found: object with keys
{_reactName, _targetInst, type, nativeEvent, target, currentTarget, ...})
```

**根因**：`ChatWelcomeCard` 写的是 `onClick={onStartTemporaryChat}`，
而 `ChatWorkspace` 传的是 `onStartTemporaryChat: createUnboundChatSession`。
React 把鼠标事件对象作为第一个实参交给它，落到
`createUnboundChatSession(title = 'New chat')` 的 `title` 上，
于是新会话的 `title` 是一个 SyntheticEvent；渲染那一行标题时炸掉。

键名里的 `_reactName` / `nativeEvent` / `clientX` 就是这条链的指纹。

**没有单独修它**：这个按钮在 D14 下整个退役了（见下）。

## 二、真正的问题：U22 补的是入口，不是闸

U22 的取证是对的——`canSend` 要求 `activeSessionId`，而全新安装四个入口全死。
但它的修法是给欢迎卡加一个按钮去**补一个入口**，闸本身留着。

对照 pix：起始屏是标记 + 一行标题 + 一句话，下面是一个**能直接打字**的输入框。
没有「开始聊天」按钮，因为打字就是开始。

而我们当时那一屏：一个与输入框顶盖功能重复的「选择工作目录」大按钮、
一段解释用户没问过的选择的说明、一个会崩的按钮，加一个**禁用的**输入框。
用户的原话是「太臃肿浮夸」。

## 三、改动

### 拆掉最后一道闸（决定一）

```ts
const sessionId = activeSessionId ?? createUnboundChatSession();
```

放在 `runSend` 的提交点之前，所以下面每一行读到的 `sessionId` 都一样，
无论它是在侧栏点出来的还是这一次敲键盘造出来的。

连带三处：
- `hasSendTarget` 由 `activeSessionId && (cwd || isUnboundSession)`
  改为 `activeSessionId ? cwd || isUnboundSession : true`；
  `canSend` 收缩为 `hasSendTarget && !disabled && !canStop`；
- `useComposerAttachments` 的 `disabled` 去掉 `|| !activeSessionId`；
- `ChatWorkspace` 不再传 `disabled={!activeSessionId}`。

### 「没有会话」不再是故障（决定二）

- `deriveChatEmptySurface` 删掉 `!hasSession → 'error-notice'`，`hasSession` 字段整个移除；
- `composerPlaceholder` 删掉 `Select a session in the left nav before sending…`；
  「Active session has no workspace…」加上 `hasSession &&` 前缀——
  它描述的是一个坏掉的绑定，而从未创建的会话不可能有绑定。
- 两个调用点把 `unbound` 放宽为 `isUnboundSession || !activeSessionId`：
  没有会话意味着下一次发送会造一个免绑定的，所以所有「先去选个目录」类文案都不适用它。

### 起始屏（决定三）

`ChatWelcomeCard` 重写：标记（`MessagesSquare`，`bg-primary/10` 圆角方块）+
`text-title` 的「开始对话」+ 一句 `text-meta` 副文案。**没有任何控件。**

副文案两句，由是否有工作目录决定：

| 状态 | 文案 |
|---|---|
| 有目录 | AI 会在 `<目录名>` 里干活，直接说你想做什么。 |
| 无目录 | 直接输入即可，这次对话会在一个私有的临时目录里进行。 |

渲染条件由 `!hasWorkingDirectory && renderedMode === 'empty'`
改为 `renderedMode === 'empty'`——用户 2026-09-06 追加的要求：
已绑定但还没开始的会话，和免绑定会话是同一个时刻。

## 四、门禁

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test`（全仓） | **278 files / 4228 tests pass**（两轮改完后的最终数） |
| `npx biome check src/` | 干净（`ChatComposer`/`ChatWorkspace` 各 `--write` 修一次格式） |
| `git diff --check` | 干净 |

测试数 4229 → 4228：新增 3 条（U28 的两条闸断言 + 起始屏无控件），
删 4 条（旧「没有会话即故障」的真值表条目与「直接开聊」按钮的形状断言）。

## 五、改写的既有断言（四个文件）

1. **`chatEmptyState.test.ts`** — 两条关于「没有会话 → 红框」的真值表条目
   合并成一条反向断言（现在必须是 `'none'`）；「传 onAddRepository 免得按钮是死的」
   改写为「起始屏没有任何控件」，因为按钮本身没了。
2. **`unboundChatWiring.test.ts`** — `canSend` 的正则拆成两条：
   `hasSendTarget` 保留 `isUnboundSession` 项，`canSend` 断言新形状；
   新增一条「无会话也能发」。
3. **`unboundChatEntryStatic.test.ts`** — U22 那条「卡片只在无会话时给按钮」
   改写为「卡片没有按钮」+ 「发送闸不再要求会话」。
4. **`middleColumnLayout.test.ts`** — 「没有会话」的占位符期望从
   `Select a session…` 改为普通提示；「Active session has no workspace」保留但
   现在要显式带 `hasSession: true`。

## 六、变异验证

回退三处（发送时建会话、`hasSendTarget` 放宽、空态不再判故障）后：

```
× U28: the send gate no longer requires a session
× U28: and admits a chat that has no session yet
× shows nothing when the composer can send
× U28: a chat with no session is not a fault — it is the starting position
Test Files  3 failed (3)     Tests  4 failed | 30 passed (34)
```

恢复后 34 条全绿。

第二轮同样做了：回退 textarea 的 `disabled`、标题回读、以及 empty 模式的布局类之后

```
× U28: the textarea and attach button are not locked by a missing session
× U28: the first message titles the session runSend actually created
× U28: pins the empty-mode composer to the bottom, with the start screen taking the room above
× never lets a composer host grow — the start screen is what takes the slack
Test Files  2 failed (2)     Tests  4 failed | 122 passed (126)
```

恢复后 126 条全绿。

## 七、第二轮：用户报「聊天还是假的」，以及一次真机验证

第一轮改完之后用户回报两件事，都是自动化没能拦住的。

### 7.1 输入框仍然锁着（真正的原因）

发送闸拆了、占位符也变成了 `Message Pi…`，但 **textarea 自己**还带着
`disabled={disabled || !activeSessionId}`（`ChatComposer.tsx` 的 JSX 属性），
附件按钮同样。于是屏幕上是一个写着「Message Pi…」的**锁住的**输入框——
用户的原话是「聊天还是假的」。

两处都改成只看 `disabled`。同时补上第三处：`runSend` 建的会话，
`handleSend` 里那个闭包读不到（它的 `activeSessionId` 还是 null），
`maybeApplyFirstMessageTitle` 因此拿不到 id，**从空输入框开的每个会话
标题都会永远停在「New chat」**。改为回读 store。

`statusHint` 的 `!activeSessionId` 分支也一并删除——同一条理由。

### 7.2 起始屏位置（用户：「这个欢迎页面的显示位置合理么」）

`middleColumnHostClass('empty')` 是 A07 留下的
`flex-1 justify-center pb-[9%]`：composer 在**起始屏剩下的空间里**居中。
起始屏本身在自然流顶部，于是两者一起挤在上半屏，下面一大片空白——
正是用户截图里的样子。

改为：composer `shrink-0 ... pb-6` 钉在底部，新增
`START_SCREEN_HOST_CLASS = 'flex min-h-0 flex-1 items-center justify-center px-6'`
接管上方的全部剩余高度，起始屏在其中居中。**整列里只有一个元素会伸展**，
就是那个只有标题和一句话的区域。

### 7.3 真机验证（这次自己跑了）

一次性 CDP 探针，两种状态各出一图，存
[`2026-09-06-u28-shots/`](./2026-09-06-u28-shots/)。

**无仓库无会话**（临时 `HOME` 起的干净 profile，这是用户报的那个状态）：

| 采样项 | 实测 |
|---|---|
| `activeSessionId` | `null` |
| `workspaces` | `0` |
| `textarea.disabled` | **`false`** |
| 占位符 | `Message Pi…` |
| 红色诊断框 | **不存在** |
| 副文案 | Just type. This chat runs in a private temporary folder. |
| 键盘输入 `hello` 后 `textarea.value` | **`"hello"`** |

**有工作目录**（本机 profile，中文界面）：副文案为
「AI 会在 ai-client 里干活，直接说你想做什么。」，同样可输入。

**布局实测**：无仓库窗口高 900，起始屏标题 y=407、输入框 776–832，
底部留 68px；内容区 65–776 的中心是 420，标题块中心约 406——居中成立，
输入框贴底成立。

**干净 profile 那两张是英文界面**：临时 `HOME` 下没有 settings.json，
语言跟随系统默认。文案键是同一个，中文那半由有目录的两张图佐证。

## 八、欠项

- **仍未跑的是「真的发出去一回合」**。第七节的探针验到了「能打字」，
  没验「按下发送后会话被创建、消息真的到达 runtime」——那需要真账号真模型，
  与既有的六件真机验证同性质，并入累计点验。
- **起始屏在有目录时的中文那张图是本机 profile 拍的**，因此它同时带着本机的
  仓库与会话；干净 profile 那两张是英文界面（临时 `HOME` 下没有 settings.json）。
  两者合起来覆盖了两种副文案，但没有一张是「干净 profile + 中文」。
- **底栏控件在无会话时不渲染**（D14「已知未对齐处」）：权限档、模型/思考档、
  占用 chip 三个槽位都以 `activeSessionId` 为条件，pix 的对应位置是有的。
  后果是第一条消息只能用默认模型发出。需要单独拍板「无会话时改的是全局默认还是暂存值」。
