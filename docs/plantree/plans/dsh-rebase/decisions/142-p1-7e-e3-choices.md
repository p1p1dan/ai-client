# 决策 142：P1-7e 第三组（e3 浮窗、终端、工具行）的实现取舍

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-7e 分组](../topics/p1-7e-pointcheck-fixes.md) 的 e3 行与「编排者的默认取舍」（问题 19 与问题 4 的两条）；
- [P1-7d 点验证据](../evidence/p1-7d-gui-2026-09-30.md) 的问题 14（C1）、15（E6）、17（C3）、18（D1）、21 的后半（E4b）、11、12（A8、D1）、5（B2、B3）、4 的补水部分（B4）、19（D5）；
- 用户 2026-09-30 对问题 19 的裁决「调深一点」；
- [决策 128](128-p1-11-right-column-terminal-choices.md) 第 8、10 条（右列叠放、Ctrl+F 与 Esc）。

## 落地了什么

- 问题 14：`src/renderer/components/chat/SessionSubwindows.tsx`。
- 问题 15：`src/renderer/components/terminal/ShellTerminal.tsx`（`isTerminalSearchShortcut`）。
- 问题 17：`src/renderer/components/chat/sessionPanelsModel.ts`（`formerJobs`、`workerEpoch`、`jobHideKey`）、`subwindowsModel.ts`、`BackgroundJobsWindow.tsx`。
- 问题 18、12：`src/renderer/components/chat/toolCard.ts`（`argPattern`、`attachmentFileName`）、`ToolRows.tsx`。
- 问题 21 的后半：`src/renderer/stores/editor.ts`（`revealSeq`、`requestReveal`，`openDiffTab` 也计一次）、`src/renderer/hooks/useEditor.ts`、`src/renderer/components/workspace-shell/WorkspaceShell.tsx`。
- 问题 11：`src/renderer/components/ui/toast.tsx`（寿命看护、叠放上限、避开输入框）、`src/renderer/components/workspace-shell/useCapacityReclaimNotice.ts`、`src/renderer/components/chat/ChatWorkspace.tsx`（输入框外层加 `data-toast-avoid`）。
- 问题 5：`sessionPanelsModel.ts`（`resumedGoal`）。
- 问题 4 的补水部分：`src/main/services/agent-host/WorkerManager.ts`（`workerTurn`）。
- 问题 19：`src/renderer/components/chat/chatTimelineLayout.ts`（`toolRowIconClass`、`sessionFailureTitleClass`）、`ToolRows.tsx`、`MessageTimeline.tsx`。
- `src/shared/i18n.ts`：三条新文案（中英）。
- 没有动 bridge、Main 的插件与 IPC，也没有动 e5 组的文件。

## 规则

### 问题 14：浮窗第一次拖动只跟一步

1. **根因如点验所判**：停靠的窗画在右上角的叠放容器里，拖出过的窗画在另一个分支。第一次 `pointermove` 写入位置后，窗换了父节点，React 把它当成新组件重新挂载，`SubwindowFrame` 记在 `useRef` 里的拖动状态和指针捕获随之丢失。
2. **改法：每个窗在树里只有一个位置。** 叠放容器改成铺满整个浮窗层（`absolute inset-0`，上 8 px、左右各 12 px 内边距，`subwindowStackClass()`），两个窗始终是它的子节点：停靠时在流里从右上角往下排；拖出后 `absolute`，按左上角定位。容器与浮窗层同一个盒子，所以拖出后的坐标仍是浮窗层坐标，拖动的夹取规则、双击复位、两个窗同开时分高度，都不变。
3. 停靠窗的最大宽度与原来相同（浮窗层宽度减 24 px）；拖出后的最大宽度也与原来相同（浮窗层宽度）。

### 问题 15：右列终端里 Ctrl+F 进了 shell

4. **根因**：xterm 在自己的输入框上处理 keydown，把 Ctrl+F 当成 ^F 发给 pty，并阻止冒泡；`ShellTerminal` 挂在 window 冒泡阶段的监听器永远收不到。原来的自定义键钩子只放过 Shift+Enter。
5. **改法：终端自己的键钩子认这一个组合键。** 焦点在终端里时，Ctrl+F（macOS 上是 Cmd+F）、不同时按 Alt 或 Shift，就打开终端搜索（已打开则把焦点放到搜索框），按下与松开都不交给 shell。其余所有键照旧交给 shell，Esc 仍然是 vim、less 的。
6. macOS 上的 Ctrl+F 是 readline 的「前进一个字符」，焦点在终端里时仍交给 shell。按决策 090 暂不做 macOS，这里只是不去破坏它。
7. window 上原有的监听器保留：终端显示着但焦点不在里面时，Ctrl+F 仍打开终端搜索（原行为）。两处都触发时效果与一次相同。
8. 这个组件左栏终端面板也在用，那里同样生效。

### 问题 17：宿主重启后任务窗被清空

9. **根因**：任务窗只读当前 worker 的任务列表。旧 worker 退出后到新 worker 的列表到达前（约 1.4 s），行显示「引擎重启，任务已结束」；新列表一到，旧行全部消失。
10. **改法：旧 worker 列出的任务，由本窗口接过来。** 会话从「有活 worker」变成断开时，它当时列出的任务整批移到 `formerJobs`，标上是第几个 worker（`epoch`），`jobs` 清空，等下一个 worker 的列表。任务窗先画这些旧行（较早），再画当前 worker 的行。
11. **旧行的样子**：当时还在跑的，状态写「引擎重启，任务已结束」；已经结束的，保留原来的状态（已完成、失败、已停止）与退出码。旧行没有「停止」，也没有「输出」：输出随旧 worker 没了，而新 worker 会从 1 重新编号（`bash-2` 会再出现），按编号去读就读到别的任务。
12. **保留到用户点「移除」为止**（本任务要求的主规则）。另设上限：每个对话最多留 8 条旧行，超出时先丢最早的，与 bridge 自己保留 8 条已结束任务的做法一致。对话被删除时一起清掉。没有采用「该对话有新任务时清掉旧行」：新任务出现时用户未必看过旧行的结局，而移除只要一次点击。
13. **「移除」记的键**：第一个 worker 的任务仍记编号本身（`bash-4`，与原来相同，旧的记录照样有效）；之后的 worker 记 `<epoch>:<编号>`（`1:bash-4`）。所以移除一个任务，不会连带隐藏另一个 worker 里同号的任务；重启之前移除过的任务，重启后也不会作为旧行冒出来。
14. 每次「有活 worker → 断开」都把 epoch 加一，即使当时没有任务，保证下一个 worker 的编号不与之前隐藏过的编号相撞。
15. 可续子代理的行不在此列：它们由子代理活动 store 在同一次断开时标为已取消，在「子代理」窗里仍看得到。

### 问题 18：glob 模式被拆成「文件名 + 目录」

16. grep、glob、find（含 Claude 的 `Grep`、`Glob`）的参数是搜索模式，行视图带上 `argPattern`，按原文显示，例如「搜索 `**/*`（workspace）」。只有路径形状的参数才把文件名提到目录前面（决策 034 不变）。

### 问题 21 的后半：点已激活的文件，终端不让位

17. **根因**：右列「打开文件就让终端退后」的判断看的是当前标签有没有变。点的就是当前标签时，什么都没变，终端留在前面。
18. **改法：每一次「要看这个文件」都计一次数。** 编辑器 store 加 `revealSeq`；`useEditor().navigateToFile`（文件树、工作区搜索、聊天里的文件链接都经过它）每次调用加一，`openDiffTab`（Git 面板、审阅面板打开差异）每次也加一。右列看到计数变了，就按决策 128 第 8 条处理：关掉审阅，终端退到文件后面，shell 不结束。
19. 标签栏里点标签、关标签不计数：那时文件已经在前面（或是在收拾标签），不是「打开文件」。

### 问题 11：toast 不自动消失、层层叠加、盖住输入框；空闲对话被说成「已停止运行」

20. **根因**：Base UI 的 toast 计时器在窗口失焦时暂停，恢复只认落在某个元素上的 focus 事件；窗口重新获得焦点而焦点落在 body 上时，计时器不再恢复，toast 就一直停着。开发机上窗口的焦点状态本来就不稳定，所以每次都能看到。
21. **寿命由 `toast.tsx` 自己管**：Provider 不再排 Base UI 的计时器（`timeout={0}`），改由一个看护器每 0.5 s 检查一次。寿命：成功、信息类 5 s；错误、警告类 10 s；调用方显式给了 `timeout` 的以它为准（`0` 表示一直留着，直到用户关）；加载中的不计时，变成结果后从那一刻起计。所有 toast 右上角都有 ×。
22. **什么时候不关**：指针停在 toast 上，或键盘焦点在 toast 里。移开后到期的立即关。窗口失焦、最小化不再暂停计时（这是取舍：离开应用期间弹出的 toast 可能在回来前就消失了；换来的是它一定会消失）。
23. **叠放上限 3 条**（Base UI 的 `limit`，原来是默认值，现在写明）。超出的较早几条隐藏，并且 `visibility: hidden`，原来它们只是透明、仍然挡点击；它们照样按寿命计时并关闭。
24. **不遮挡输入框**：凡是标了 `data-toast-avoid` 的元素（聊天列的输入框外层），toast 叠放区的底边就抬到它的上沿之上 8 px；没有这样的元素时，仍用原来的角落内距。右列打开时 toast 在右列上，同样停在这个高度，终端最后几行（提示符所在处）也不再被盖住。
25. **容量回收的措辞**：池子只回收 Main 看来空闲的对话，但「空闲」只看 Main 自己发出的回合。所以这个 hook 按事件记下每个对话最近是否有回合在跑（任何忙碌的 `session.status`，含目标轮、任务唤醒）或有后台任务在跑，在回收那一刻查：
    - 确实有东西在跑：沿用原句「为了给新对话腾出位置，「X」已停止运行。点开它就能继续。」；
    - 空闲：「为了给新对话腾出位置，空闲的「X」已转入后台，内容都还在。点开它就能接着聊。」（不知道名字时：「……一个空闲的较早对话已转入后台，内容都还在。」）。标题都是「有一个对话已转入后台」。
    没有选「空闲的就不提示」：决策 D12 第三条是用户选的「回收并说一声」。
26. **一次只留一条回收提示**：池满后每新建一个对话就回收一个，新的回收提示出现时，上一条随即关闭。

### 问题 12：附件读取行显示哈希目录

27. DSH 把附件存在 `DSH_HOME/attachments/v1/files/<sha256 前两位>/<sha256>/<文件名>`（`dsh-attachment-local` 的布局）。`read` 与 `read_image` 读的是这样的路径时，行上写「附件 · 文件名」（有行号范围时照旧接在后面，例如「附件 · notes.txt L1-20」），不再显示哈希目录。这一段按正文字体排（不是等宽），因为它是标签加名字，不是路径。点击仍打开那份文件，悬停提示仍是完整路径。

### 问题 5：点「继续」后闪一下「目标已挂起」

28. **真宿主实测（本机、假网关）**：`/goal resume` 之后，bridge 先发 `goal`（active、revision 3），1 ms 后发 `goalActivation`（armed、revision 3）；暂停与完成时同样是先 `goal` 后 `goalActivation`。两者是两个事件，渲染层在它们之间会算出「active + 旧的 disarmed」＝ 挂起。
29. **改法**：目标从「已暂停」或「受阻」变成 active、revision 变大，只可能是 resume，而 DSH 的 resume 一定是 armed（`GoalService.resume` 提交时带 `armed`）。渲染层把这个 revision 记为 `resumedGoal`；在这个 revision 上，手里的 activation 若还是 resume 之前的（revision 更小），就按 armed 算，显示「进行中 / 等待下一轮」。同一 revision 的 activation 一到，就以它为准；真的被解除（例如轮外的 Stop）照样显示挂起。
30. 编辑一个挂起中的目标（active → active，revision 变大，DSH 不发新的 activation）不受影响，仍显示挂起。没有活 worker 时仍然一律是挂起、无按钮（决策 118 第 15 条）。
31. 点验 B3 的一个采样（410 ms，状态 running 而条显示挂起）与上面的实测次序对不上；本改法不依赖次序，只要手里是 resume 之前的 activation 就不再显示挂起。GUI 复核时再看一次。

### 问题 4 的补水部分：窗口重载后，正在跑的目标轮显示成「等待下一轮」「完成于」

32. **根因**：重载后重新点开对话走温恢复，Main 发完历史后总是补一句 `session.status: idle`。目标轮、任务唤醒这类回合是 DSH 自己开的，Main 没有为它们记「正在进行的请求」（`activeRequestId`），也就不知道它们在跑，于是把一个正在跑的对话说成了空闲。
33. **改法（Main）**：WorkerManager 另记 worker 最近一次报告的忙碌状态（`workerTurn`：状态与那一轮的请求号），不管这一轮是谁开的；回合结束（`completed / failed / stopped`、非忙碌状态）或 worker 离开（退役、崩溃、Main 丢弃回合）时清掉。温恢复发历史后，若 worker 正在一轮里，就以那一轮的请求号补一句它自己报告的状态（例如 `running`），否则仍是 `idle`。只重述 worker 自己说过的话，符合决策 046。
34. 渲染层据此把会话看作在跑：目标条显示「进行中」，时间线上这一轮显示「工作中」而不是「完成于」。这一轮之后的直播事件照常到达。
35. 冷启动、崩溃重启得到的是新 worker，它还没报告过任何状态，仍补 `idle`。
36. 「重载后中栏只画了一半」按分组的默认取舍不修（本机窗口不合成，问题 22）。

### 问题 19：工具行图标与深色失败卡标题（用户裁决「调深一点」）

37. **只调这两处的颜色档位，只用现有 token**：
    - 工具行图标：去掉 `opacity-80`，用所在行自己的颜色满强度显示（普通行是 `--tool-arg`，失败行是 `--destructive`）。图标不再比它代表的文字更淡。
    - 会话失败卡的标题：`text-destructive` 改为 `text-foreground`。失败卡的红色由它的描边（`border-destructive/40`）和底色（`bg-destructive/10`）表达，正文与提示照旧是 `text-muted-foreground`。
38. **为什么标题不能保持红色**：`--destructive` 在深色主题下对页面底色只有 4.20:1（设计规范「已知偏差」），放到它自己的 10% 底色上更低；任何现有的红色 token 都到不了 4.5:1。设计规范也不许用 `dark:` 前缀表达可读性差异（它跟随系统，不跟随应用主题），所以两套主题一起换成正文色。
39. **对比度前后（按 `globals.css` 的实际色值计算）**：OKLCH 换成 sRGB；`--tool-arg` 是 `--muted-foreground` 62% 与 `--background` 在 oklab 里的混合；`opacity-80` 在 sRGB 里与底色合成；`bg-destructive/10` 是 `--destructive` 10% 在 oklab 里叠在 `--background` 上；按 WCAG 2.x 相对亮度计算。

    | 位置 | 主题 | 调整前 | 调整后 | 目标 |
    |---|---|---|---|---|
    | 工具行图标（普通行，对 `--background`） | 浅色 | 2.36:1（`--tool-arg` × 80%） | 3.07:1（`--tool-arg`） | ≥ 3:1 |
    | 工具行图标（普通行，对 `--background`） | 深色 | 2.44:1 | 3.12:1 | ≥ 3:1 |
    | 工具行图标（失败行） | 浅色 / 深色 | 4.33:1 / 3.10:1（`--destructive` × 80%） | 6.29:1 / 4.20:1（`--destructive`） | ≥ 3:1 |
    | 失败卡标题（对 `bg-destructive/10`） | 浅色 | 5.42:1（`--destructive`） | 16.18:1（`--foreground`） | — |
    | 失败卡标题（对 `bg-destructive/10`） | 深色 | 3.84:1（`--destructive`） | 10.41:1（`--foreground`） | ≥ 4.5:1 |

    调整前的数与点验 D5 用截图取色得到的数一致（图标 2.35 / 2.45，失败卡标题 5.38 / 3.84）。
40. 行上的动词与行尾词（`--tool-arg`，3.07:1 / 3.12:1）不在本次范围：那是决策 034 有意压低的「过程」一档，用户这次只裁决了图标与深色失败卡标题。

## 测试

- 新增文件：
  - `chat/__tests__/toolRowPatternAttachment.test.ts`（8，含挂载）：模式参数、路径参数仍拆、附件名、行上无哈希、图标无透明度、失败卡标题类与接线；
  - `terminal/__tests__/shellTerminalSearchKey.test.ts`（3，挂载，`useXterm` 用桩）：组合键判定、Ctrl+F 打开搜索且不进 shell、Esc 等其余键照旧；
  - `ui/__tests__/toastLifetime.test.ts`（5，挂载，假时钟）：按类型的寿命、窗口失焦不再卡住、悬停保持、`timeout: 0` 常驻、最多 3 条且超出的不可点、避开 `data-toast-avoid`；
  - `workspace-shell/__tests__/capacityReclaimNotice.test.ts`（3，含挂载）：记录对话在做什么、两种措辞、一次只留一条；
  - `hooks/__tests__/useEditorReveal.test.ts`（1，挂载）：`navigateToFile` 对已激活的文件也计数。
- 追加：`sessionPanelsModel.test.ts` 6 条（resume 的四种情形、旧任务的接管与上限）；`subwindowsModel.test.ts` 1 条（旧行、隐藏键）；`sessionSubwindowsMount.test.ts` 2 条（一次拖到底且不重新挂载；重启后旧行保留、无「输出」「停止」、可移除）；`rightColumnTerminalMount.test.ts` 1 条（已激活文件与已显示的差异也让终端退后）；`WorkerManager.test.ts` 1 条（温恢复时补报 worker 自开回合的 `running`，回合结束后恢复 `idle`）。
- 没有改写已有测试。
- 真宿主实验（问题 5）：用一次性的探针脚本（跑完即删，未入库）经 `experiment-host` 起宿主与假网关（`dsh-p0-2`），跑 `P0-GOAL-PAUSE` 的暂停、继续与 `P0-GOAL-BLOCKED` 的继续，记录 bridge 发出的事件次序，结果见第 28 条。

## 用户审批

待审批。
