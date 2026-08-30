# T12-e 证据 — 没有工作目录时的欢迎页（2026-08-29）

用户报告原文：没添加 repository 时对话框上方常亮一个红色警告，「让人感觉是软件坏了报错」。

## 改前是什么样

`ChatComposer.tsx` 里四种「发不出去」的状态**共用同一个红框**
（`border-destructive/40 bg-destructive/10 text-destructive` + 等宽字体），文案是
`No repository registered — launch with --open-path=<repo> (or add a repository) first.`
—— 一个桌面用户永远不会去敲的命令行参数。

**为什么全新安装必然常亮**：`DEMO_WORKSPACES` 的 `path` 是**空字符串**
（`chatSessions.ts:309-324`，刻意为之——早年那里写过开发机的真实路径字面量，
在没有仓库数据的机器上会被当成 agent 的 cwd，每次 spawn 都死），于是
`activeWorkspace` 有值而 `cwd` 为 null，正好落进那条四合一的判断。

## 改法

**新增 `chatEmptyState.ts`**：把「发不出去」拆成**故障**与**没配置**两件事。

| 结果 | 何时 | 长什么样 |
|---|---|---|
| `error-notice` | 真出错了，或不是选目录能解决的 | 保留红框（故障就该长这样） |
| `welcome` | 只是还没选目录 | 引导卡 + 按钮 |
| `none` | 能发了 | 什么都不显示 |

**顺序是承重的**：真错误压过欢迎卡。否则「没选目录时发生的一个错误」会被一张
根本无法提及它的卡片吞掉。反过来，两者都缺时优先显示欢迎卡——选目录是用户**能做**的那一步。

**新增 `ChatWelcomeCard.tsx`**：形态取 pi-app 的 `ProjectHomeView`（用户 2026-08-29
看三张示意图后拍板）——居中的文件夹按钮 + 菜单，下面一行说明，**输入框照常留在下方**。
最后这条是用户**推翻自己最初建议**后选的，理由是选完目录不该让整个右侧换掉。
菜单三项复用文件夹下拉页脚的同一批文案与同一个 `onAddRepository` 回调 —— 两个入口一条通路。

`ChatComposer` 的红框改为只在 `error-notice` 时渲染。`hasStatusError` 也改成读同一个
派生结果，而不是第二份手写条件（F14 minor m2 记录的就是这两者漂移的事故）。

## GUI 实测（真机 CDP，本批**做了**，不是只有断言）

启动 dev、点「use my own setup」进主界面，再把工作区的 `path` 置空还原全新安装的状态：

- **亮色**：`t12e-screenshots/t12e-light.png` —— 红框消失，居中按钮 + 说明，输入框在下方
- **菜单**：`t12e-screenshots/t12e-menu.png` —— Use Existing… / Clone… / Add Remote… 三项
- **暗色**：`t12e-screenshots/t12e-dark.png`

`getComputedStyle` 实测（非从类名推断）：说明文字 13px（`text-meta`）、按钮 15px
（`text-markdown`）、圆角 12px；暗色下说明文字 `oklch(0.6956 …)` 对底 `oklch(0.1981 …)`。

## ⚠️ GUI 抓到一个断言抓不到的缺陷（空转臂同型第九发）

出图后才看见：卡片已经在好好说话了，**输入框的 placeholder 仍然写着
`Cannot send right now…`** —— `composerPlaceholder` 那条 if 阶梯有
「没有会话」和「没有工作区」两个分支，**唯独没有「有工作区但没有路径」**，
于是全新安装看到的是整个函数里**最没信息量的那句兜底**。

已补 `hasCwd` 分支，改说 `Choose a working directory to start…`，与卡片同一口径。
真机热更新后实测 placeholder 已变。这条**没有任何单元断言会红** —— 它是一句文案落到了
错误的兜底分支上，只有看屏幕才发现。已补一条 wiring 断言钉住调用点传了 `hasCwd`。

## 测试与变异

`chatEmptyState.test.ts` **12 例**：7 例真值表 + 5 例**接线扫描**。

接线扫描是必需的：真值表全绿的同时，把 `ChatComposer` 里那个 `'welcome'` 分支整段删掉
——也就是把这一批的成果删干净——**所有真值表断言照样绿**。扫描前先剥注释（本文件头注
自己就写了那些词，负向断言匹配到自己的散文就是"因为错误的原因而通过"）。

变异 **4 发全咬红**：

| # | 变异 | 红 |
|---|---|---|
| M1 | 真错误不再优先 | 2 |
| M2 | 取消 welcome 档，退回 error-notice | 3 |
| M3 | 会话检查插到目录检查前面 | 1 |
| M4 | **删掉 composer 里的 welcome 分支** | 2 |

M4 就是上面说的那个逃逸口，被接线断言抓住。

## 四门

typecheck 0 · biome 1051 文件 0/0 · **vitest 273 文件 5425 例全绿**

## 未做

- **没有真的走一遍「点按钮 → 添加仓库 → 卡片消失」的完整闭环**：实测只确认了菜单打开、
  三项在位、回调已接线，没有真的添加一个仓库看它切回正常态。
- 长路径 / 窄窗口下的换行未测。
- 文案目前只有中英两版随全局语言切换，未做更多语言。
