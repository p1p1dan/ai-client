# Evidence — U09 Composer 形态（批次 2）

> 2026-09-03 落地。切片范围与验收标准见 [execution-plan §批次 2](../topics/execution-plan.md)。
> 形态判定依据 [evidence-u09 组件形态对照表](../topics/evidence-u09-component-forms.md) #1。

## 一、U09-1 空会话顶部接合摘列

**改动**：`middleColumnLayout.ts` 的 `targetRowClass('empty')` 从自由浮动行
（`mb-2 flex h-6 items-center gap-1`）改为与卡片接合的顶盖
（`mx-3 flex h-7 items-center gap-1 rounded-t-md bg-muted px-2`）；
`composerCardClass` 增加 `opts.hasProtrusion`，有顶盖时顶部圆角降到 `rounded-t-xs`（4px），
底部保持 `rounded-md`；新增纯函数 `composerHasProtrusion`。

**三个决定与理由**：

- **去掉 `mb-2`**：那 8px 间隙正是"两个独立元素"的读感来源。接合 = 零间隙，
  且这个间隙没有第二个所有者可以补偿。测试断言的是**不存在** `mb-*`，比断言某个具体值更强。
- **`mx-3`（12px）而非 pix 的 18px**：让顶盖比卡片窄，卡片上边缘才读作"压在顶盖上"。
  18px 需要任意值，design-system 禁止；12px 是本仓自有档位。
- **`h-7`（28px）而非 `h-6`**：顶盖现在是围住 24px 控件档的**填充容器**，不是裸行，
  需要上下各 2px 余量。28px 是 D03 拍板的侧栏行高档，不是新档。

**填充选 `bg-muted`**：与 `bg-card` 相邻一档，亮暗两套都是小差值。顶盖靠**形状**
（顶部圆角、更窄、齐平接合）区分，响亮的填充会读成独立面板，正是本批次要退掉的东西。
`bg-hover` 被显式排除并写进测试——那个 token 语义是"指针悬于其上"，
拿它做静息填充会让真正的 hover 态无处可去。

**无 targetable workspace 时**：`composerHasProtrusion` 返回 false，卡片类串与改动前**逐字节相同**
（有测试断言 `toBe(composerCardClass('empty'))`），全新安装的观感不变。

**没有重复调用 `useComposerTarget`**：ChatComposer 已有的 `cwd` 就是
`workspace && isTargetableWorkspace(workspace)` 的结果，与 `ComposerTargetBar` 的渲染谓词同源。
那个 hook 拥有 effect（pending-target 应用流程）与 query，第二个实例会重复执行它们——
顶盖的圆角不值得一次重复的 store 写入。

## 二、U09-2 底栏控件顺序对齐

**顺序落成数据而非 JSX 阅读顺序**：新增 `COMPOSER_BAR_LEADING = ['attach', 'permission']`
与 `COMPOSER_BAR_TRAILING = ['usage', 'modelEffort', 'actions']`，两个分支都靠 map 这两个数组渲染。

理由是 T-28 的原教训：本切片的验收条件就是"控件按此顺序出现"，而 JSX 顺序不是测试能陈述的东西——
断言全绿而组合结果是错的，正是那次的失败形状。现在测试读到的顺序就是发布的顺序。

**`modelEffort` 是一个槽而非两个**：本仓把模型名与思考档合并成了单一触发器
（`composerModelTriggerClass`），evidence-u09 #2 判定 pix 的拆分「不搬」。
原型的「模型 · 思考」因此落成这一个 chip，位置不变。

**两个槽故意留空，且渲染 `null` 而非占位壳**（空壳与「利落简约」相悖）：
- `permission` — 权限档 chip，归 [U12](../topics/evidence-u12-session-permission-tier.md)。
- `usage` — 上下文占用，等 Pi runtime 发 `usage.updated`（U06-b 已移交 Pi 计划 T38）。

**`composerActionGroupClass` 的容纳范围扩大**：不再只是圆形按钮，而是全部尾部控件。
类串本身未改——`ms-auto` 与 `shrink-0` 一直就是"把定宽簇锚在末尾"，现在依然如此。
6px 组内间距刻意小于底栏自身的 8px：读作一簇的控件应当比簇间更紧。

**取代的旧顺序**：T-30b2 §5.2 的「⊕ → model → status → actions」按"哪些控件开始一条消息"分组；
新顺序按**控件回答什么问题**分组——左侧是"这条消息带什么、能做什么"，
右侧是"它会被怎样回答"加发送键本身。状态行两种排法下都占弹性中段。

## 三、门禁（串行，`--maxWorkers=1 --no-file-parallelism`）

| 项 | 结果 |
|---|---|
| `middleColumnLayout.test.ts` | 109 tests pass（新增 U09-1 顶盖 4 条、`composerHasProtrusion` 4 条、U09-2 顺序 5 条） |
| `composerFormStatic.test.ts` | 8 tests pass（[F6-5]/[F6-6] 两条 AST 断言按新结构改写） |
| `src/renderer/components/chat/__tests__/` 全目录 | **70 files / 1637 tests pass** |
| `pnpm typecheck` | pass |
| `pnpm exec biome check`（4 个改动文件） | 0 error，无 fix |
| `git diff --check` | clean |

**变异验证**：把 JSX 里 session 分支的 `COMPOSER_BAR_LEADING` 与 `COMPOSER_BAR_TRAILING`
对调，[F6-5] 如期变红
（`expected '{renderBarSlots(COMPOSER_BAR_TRAILING…' to contain 'COMPOSER_BAR_LEADING'`），
随即还原。这一条是必要的：`renderBarSlots` 的被调用名对两个数组完全相同，
只比对 callee 名的断言会在把发送键搬到左边的情况下照样全绿。

## 四、欠项

**GUI 点验未做。** 按 execution-plan §四，视觉切片落地后应做一次 CDP 点验出图存证，
但点验**不阻塞**后续切片推进（本片的验收标准无取证型条目——U01-b 那种必须出数的对比度复测不适用于此）。
顶盖接合、圆角衔接、底栏新顺序三处需要肉眼确认，建议与 U12 落地后合并做一次。
