# D07 — 双栏就是两栏；每栏只留一条横条

- **日期**：2026-09-04
- **状态**：Active
- **拍板人**：用户（看到实际界面后提出，三问三答）
- **推翻**：[D02](./002-layout-cwd-and-evidence-scope.md) 决定一、[D05](./005-two-column-run-surface.md)

## 背景：原型和决策自己打架，代码跟了决策那一边

用户的原话是界面「十分的不协调，显得软件很臃肿」，点名三处：顶栏、中右侧的横栏、右侧的小图标栏。
并给出对齐基准：`docs/design/a10-pix-ui-alignment-prototype.html` 实际渲染出来的形态。

取证后确认了三件事，其中第三件是本次改动的真正起因：

**① 原型在本计划里的身份就是「不施工」。** 计划 README 的引用表原文写着
「原型画面，非施工依据」。整份 execution-plan 只有 U09-2 的验收①引用过它一次，
管的是 Composer 底栏控件顺序。**壳层横条从来没有进过任何一片的验收标准。**

**② 壳层结构落在三不管地带。** [D01](./001-style-depth-and-sequencing.md) 把样式授权
划死在「密度 / 字体 / 圆角 / 灰阶」；[Q11](../open-questions.md) 把「侧栏宽 / 右面板宽 /
阅读栏宽」拍板为维持现值。「几条横条、谁贯通谁」既不是 D01 的样式，也不是 Q11 的尺寸，
没有任何一条决策认领它。

**③ 双栏语义上原型与 D02 互相矛盾。**

| 出处 | 双栏是什么 |
|---|---|
| 原型 CSS `:90` | `[data-mode="two"] .right { display: none; }` —— 右栏**整个消失** |
| D02 决定一原文 | 「双栏 = 内容栏 + **右辅助栏**，右栏**仍承载** `context`」 |
| 代码（U02-b） | 跟的是 D02：`isSurfaceAvailableInColumnMode` 返回 `id === 'context'` |
| 代码（D05） | 又把 `run` 加进去，变成 `context + run` |

所以「双栏」至今渲染的是三列。这不是漏做，是当时按决策做的，而那条决策和原型画的不是一件事。

## 决定一：双栏 = 侧栏 + 聊天，没有第三列

**采纳**：`columnModeHasPanel('two-column') === false`。右栏不是「变窄」或「清空」，而是
**不渲染**——`visible={false}` 的 0 宽盒子仍会画出 `border-l` 的 1px 竖线，那还是三列。

**理由**：用户原话「我希望双栏时就是和 pix 一样，一个左侧栏目，一个右侧聊天栏目」，
且原型自己就是这么画的。D02 决定一当时写「右栏仍承载 context」是在**没有看到实际界面**的
情况下推的，用户看到实现后否掉了它。

**代价（已如实告知并由用户确认）**：刚落地的 U06-a（Run 面板）与 U07（Context 增强）
在双栏下**完全不可达**，只在三栏能看到。`Ctrl/Cmd+1..4` 与 `Ctrl/Cmd+J` 在双栏下全部无效。

**连带的模型改动**：
- `bareOpenTarget` 必须**先**问 `columnModeHasPanel` 再问别的——`firstAlwaysSurfaceId`
  结尾有个 `?? 'context'` 的兜底（防空注册表用的），照单全收会让 `activeSurfaceId`
  声称有面板开着而屏幕上什么都没有。
- `reduceColumnModeChange` 从「把活动面换成 context」改为「**关掉面板**」，
  `lastSurfaceId` 记住原来那个，往返三栏时恢复。`expanded` 一并清掉——覆盖层是
  「面板可见」的属性，带着 `true` 回三栏会凭空盖住聊天区。

## 决定二：每栏一条横条，三列齐平

改前中栏在第一条消息之前压着 **104px 三层横条**，右栏也是三层，左栏两层：

| 层 | 组件 | 高 | 装了什么 |
|---|---|---|---|
| 1 | `WindowTitleBar` | 32px | logo + 应用名 · 用户胶囊 · ⚙ · ⋯ · 窗口按钮 |
| 2 | `MainHeader`（**贯通中+右**） | 36px | 标题 · 文件夹 chip · **7 个图标按钮** |
| 3 | `ChatWorkspace` 头（只在中栏） | 36px | 仓库名 / Temporary 徽标 · [GUI｜TUI] |
| 3′ | `ContextPanel` 头（只在右栏） | 36px | 面板名 · 放大 |

**采纳**：

- **顶栏瘦身**为 logo + 应用名 + ⋯ 菜单 + 窗口按钮。设置与用户胶囊下沉左栏底部。
- **`MainHeader` 不再贯通中右**，移到中栏内部（chat ║ editor 之上），只剩
  `标题 · 文件夹 · [收/开面板][双栏⇄三栏][GUI｜TUI]`。
- **`ChatWorkspace` 的整条 h-9 头删除**（−36px），内容上交 `MainHeader`。
- **`ContextPanel` 的头变成文字 tab 条**，接住原本在 `MainHeader` 里的四个 surface 图标。

结果：中栏 104px → **68px 两层**；左中右三列各一条 h-9，齐平在同一条水平线上。

**左栏那条 h-9 保留不动**（只装一个折叠按钮）。原型左栏没有横条，但删掉它会让左栏比
中右两栏起始位置更高——**反而更不齐**。用户点名的三处也不包括它。

## 决定三：GUI/TUI 与 双栏/三栏 是两个控件，不合并

用户提问「GUI/TUI 切换是不是跟这个双栏三栏要区分开呢」。**是**，理由三条：

1. **合并需要藏一个状态**。原型画的是 `[三栏][双栏][TUI]` 三选一；从 TUI 切回来要回三栏
   还是双栏？三选一控件必须偷偷记住「上一个非 TUI 档」。
2. **底下本来就是两个 store**。`shellColumnMode` 在 `PersistedShellLayout`（shell 布局），
   `presentationMode` 在 settings store。合成一个控件等于 UI 声称它们是一个状态。
3. **TUI 已经在覆盖列数，不是并列**。`isTui` 直接把右栏和 editor 列全收掉，
   TUI 期间「双栏还是三栏」在屏幕上没有任何区别。做成第三档是把覆盖关系画成并列关系。

**落地**：两个独立控件并排，中间 `border-l` 分隔。列数按钮在 TUI 时**置灰不隐藏**
（消失会读作 bug），面板按钮在双栏时**隐藏不置灰**（用户刚选的模式里出现一个灰按钮读作坏了）。

## 决定四：两个旧按钮的去向

用户原话「都丢进设置吧」。

- **宽阅读栏** → 照办，落为 Settings › 外观的一行开关。它是一次性偏好，
  不该在中栏横条常驻一个位置。
- **面板放大** → **没有照办，理由已说明**：它是**动作**不是偏好。做成持久设置就成了
  「右栏永远盖住聊天区」，没人要这个。它本来也不在用户嫌挤的顶栏里，就在右栏自己那条
  tab 条上，原地留着。

## 施工中被推翻的一次尝试

第一版把 `MainHeader` 直接从 `ChatWorkspace` 里渲染（因为 `openTui`/`openGui` 的
handover 状态在那儿）。**`composerTargetGuards.test.ts` 的依赖方向守卫当场判红**：
`components/chat` 不得 import `components/workspace-shell`。

那条守卫是对的，改法是反过来：把 handover 抽成 `components/chat/usePresentationSwitch.ts`，
由 **shell** 持有唯一实例，同时喂给 `MainHeader`（画按钮）和 `ChatWorkspace`（画终端）。
方向变成 workspace-shell → chat，合法。handover 逻辑**一个字节没改**——
`openTui` 仍然回合中拒绝，`openGui` 仍然先 suspend 再 reload，两个 dispose effect 都在。

## 后果

- roadmap 的 U02 / U03-a / U06-a / U07 条目补注本决定的影响。
- D02 决定一与 D05 标记为 **Superseded by D07**，原理由保留。
- 累计 GUI 点验的清单增加本片：双栏两列、三条横条合一、顶栏瘦身、右栏 tab 条、
  设置里的宽阅读栏。
