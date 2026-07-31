# T-30 批 2 · Composer 形态规格 · 第四轮追补（合并式模型档位控件 + 无框悬停显壳）

> 母规格：[`2026-07-31-t30b2-composer-form-design.md`](./2026-07-31-t30b2-composer-form-design.md)（下称「原规格」）。
> 本追补**只修订原规格的一部分行**，未被点名的行一律原样有效。逐行修订清单见 §5。
> 立项来源：第四轮 GUI 点验第 **4** 条与第 **5** 条（用户原话见 §1.1）。
> 参照素材：`docs/design/refs/feedback-20260731-round4/ScreenShot_2026-07-31_134823_982.png`（Cursor 合并式模型弹层）。

---

## 0. 一句话结论

原规格「待拍板 ①」的推荐线（一体式合并控件）已由用户第 5 条点验拍板通过；第 4 条又追加了「**默认无框、悬停才显壳**」这一形制要求。
两条合起来的净效果是：**Composer 右段从「两枚 104/88px 带框满圆胶囊 + 两枚 chevron」收敛为「一段裸文字 `Sonnet High` + 一枚下三角」，静息态零边框零底色，只在 hover / 键盘聚焦 / 弹层打开三种态才浮出一层 8px 圆角的 `--hover` 底。**
这一步同时结清原规格 §3.1 认定的「AI 化」第一大来源，且**不需要任何新 token、不引入新高度档、不引入新圆角档**。

---

## 1. 拍板状态更新（原规格 §9 三项全部结清）

### 1.1 用户口径锚点

- **第 4 条**（形制）：「model 和 effect……就和 cursor 一致，不要常显示的外壳框，而是默认没有外接框，鼠标放上去后才显示，而且字体可以相对小一点，或者外接框稍微大一点点，右侧用下三角即可。」
- **第 5 条**（结构）：「model 和 effect 可以做到一个选项中」（附 `134823_982.png`）。

### 1.2 三项拍板结论

| 原规格待拍板项 | 结论 | 生效日期 / 依据 | 对本追补的影响 |
|---|---|---|---|
| **①** 模型档位合并为一体式控件（撤销 A07 `:1632`） | ✅ **采纳选项 A**（一体式 `Sonnet High ⌄`） | 2026-07-31 用户第四轮点验第 5 条 | 本追补 §3 即其施工规格；原规格 §9-① 的选项 B（保两枚 ghost chip）**作废** |
| **②** follow-up 卡改满圆 pill（`rounded-full`） | ✅ **采纳选项 A**（改 pill） | 2026-07-31 用户第四轮拍板 | 原规格 §5.3 的 `rounded-full` 与 §5.3 的 `hasExtras` 分支**从条件态转为无条件生效**；断言 F-A2b 由「拍板后启用」转为**必测** |
| **③** 圆钮 28→24px + send 配色 `--primary`→近黑 | ✅ **采纳选项 A**（两项都改） | 2026-07-31 用户第四轮拍板 | 原规格 §4.5 的两行由「拍」转「改」；断言 **F-A14 由条件启用转为必测**；原规格 §9-③ 的选项 B/C 作废 |

> 连带结清：原规格 §9-③ 选项 C 曾提示「若不改直径，卡高需回到 44 或维持 40px 挤压态」——③ 采纳后，**42px 卡高（`1+8+24+8+1`）成为唯一口径**，原规格 §3.3-E1 的算术勘误随之落地，`middleColumnLayout.test.ts:174` 的 40px 断言按原规格 F-A2 改写。
> 连带结清：原规格 §6.2 的 **F-A8**（`chat/` 目录下 `SelectTrigger` 出现次数 === 0）原标注「仅在拍板 ① 采纳时启用」——**现无条件启用**。

### 1.3 三项拍板与本追补的先后关系

②③ 是**几何与配色**裁定，落在原规格 §4.1 / §4.5 / §5.3，本追补不重写它们，只把「拍」改记为「改」。
①是**结构**裁定，原规格只给到「推荐 A + 代价估算」的粒度（§9-①），**没有给弹层内部结构**——第四轮参照图补上了这一层，因此本追补 §2/§3 才有必要存在。

---

## 2. 参照图裁剪判据（Cursor 弹层 → 本仓弹层）

### 2.1 度量纪律声明

本追补**不从 round-4 素材取任何像素值**。
`134823_982.png` 的 DPR 未知（与 round-3 两张 Cursor 图不同批次、不同截取方式，无三条独立互证可用），因此它只作**结构与信息架构**的依据；一切几何数值仍沿用原规格 §1.2 的 round-3 实测（DPR 1.25）与本仓既有 token 档位。
凡本追补出现的像素数，均为**本仓 token 档位的直读值**（估值），不是对 Cursor 的实测；已逐处标注。

### 2.2 Cursor 弹层的六个构件与我方取舍

| # | Cursor 构件（`134823_982.png`） | 它在 Cursor 存在的理由 | 本仓判定 | 依据 |
|---|---|---|---|---|
| ① | 顶部 `Search models` 搜索框 | 目录规模大：图中可见 **9 个模型跨 5 家供应商**（Cursor Grok 4.5 / Composer 2.5 / Opus 5 / GPT-5.6 Sol / Fable 5 / Sonnet 5 / GPT-5.6 Terra / Kimi K3 / GLM 5.2），且列表可滚动 | **不采** | 本仓 `CHAT_MODELS` 是**硬编码 3 条**（`models.ts:17-21` Sonnet / Haiku / Opus），加上 `ensureModelOptions()`（`models.ts:40-45`）在 Host 报告了目录外默认值时**最多前插 1 条** ⇒ 全量 **3~4 行**。对 4 行列表放搜索框是装饰件，且给了「这里还有更多模型」的错误暗示（A06） |
| ② | `Auto` 开关（列表之上、独立一行） | Cursor 有自动路由能力（按任务选模型） | **不采** | 本仓无自动路由能力。摆一枚不接线的 Auto = 与 A07 `:2843` 裁定④、原规格 §10-A（不摆 action pills）同一条 A06 红线 |
| ③ | 模型行**自带档位后缀**（`Opus 5 High` / `Composer 2.5 Fast` / `Kimi K3 Max`） | Cursor 的 effort 是**每模型记忆**的，所以列表里每行都能显示自己的当前档 | **不采** | 本仓 effort 是**每会话**的（`sessionEffortStore.ts`，与模型无关）。给每行挂后缀 = 谎报「按模型分别记忆」这一并不存在的行为（A06）。**列表行只显示模型名** |
| ④ | 悬停行右侧的 `↺ Edit`（图中挂在 `Fable 5 High` 行） | Cursor 支持自定义模型档位预设 | **不采** | 无对应能力 |
| ⑤ | 右挂 `Options` 子面板：`Thinking` 开关 / `Context 300K·1M` 二选一 / `Effort Low~Max` 单选 | 三组正交设置，单列放不下 | **裁剪为一段内联段** | 逐项核对：`Thinking` 本仓是**能力门控而非用户开关**（`thinkingCard.ts:isThinkingCapable`，由 Host 能力位决定，用户无权开关）⇒ 不采；`Context` 本仓无上下文窗口选择协议字段 ⇒ 不采；**只剩 `Effort` 一组**。为一组单选开一个横向子面板，交互成本（二级悬停、方向翻转、键盘穿越）远高于收益 ⇒ **降为主列表内的第二个分组段** |
| ⑥ | 底部触发器 `Fable 5 High ⌄` | — | **采纳（1:1）** | 与原规格 §2.1 的 round-3 实测一致（单 chevron、基名 + 档位后缀双色）。规格见 §3.1 |

### 2.3 裁剪后的结构对照

```
Cursor（9 模型 + 3 组正交设置）        本仓（3~4 模型 + 1 组设置）
┌──────────────┬───────────┐         ┌──────────────┐
│ Search models│  Options  │         │ Model        │  ← MenuGroupLabel
│ Auto      ○  │ Thinking ●│         │ ✓ Sonnet     │
│──────────────│───────────│         │   Haiku      │
│ Cursor Grok  │ Context   │         │   Opus       │
│ Composer 2.5 │  300K   ✓ │         │──────────────│  ← MenuSeparator
│ Opus 5  High │  1M       │         │ Reasoning    │  ← MenuGroupLabel
│ …（共 9 行） │ Effort    │         │   Default    │
│ Fable 5 ↺Edit│  Low…Max  │         │   Low        │
└──────────────┴───────────┘         │   Medium     │
                                     │ ✓ High       │
        Fable 5 High ⌄                │   X-High     │
                                     │   Max        │
                                     └──────────────┘
                                       Sonnet High ⌄
```

**一句话判据**：Cursor 的搜索框 / Auto / 子面板**全部是规模与能力的产物**，不是形制审美的产物。规模不同、能力不同就照搬，等于把别人的约束当成自己的样式。

---

## 3. 合并控件规格

### 3.1 触发器（`ComposerModelTrigger`）

#### 3.1.1 结构

```
<button type="button" class={composerModelTriggerClass()}>
  <span class={composerModelBaseClass()}>{base}</span>          ← 模型名，恒渲染
  <span class={composerModelSuffixClass()}>{suffix}</span>       ← 档位后缀，effort=Default 时整段不渲染
  <ChevronDown class="size-3.5 shrink-0 text-muted-foreground"/> ← 单向下三角（用户第 4 条「右侧用下三角即可」）
</button>
```

标签拆分由纯函数 `composerModelLabelParts({modelLabel, effort})` 给出（原规格 §6.1 已登记）：

| 输入 | 输出 | 触发器渲染 |
|---|---|---|
| `{modelLabel:'Sonnet', effort:'default'}` | `{base:'Sonnet', suffix:null}` | `Sonnet ⌄` |
| `{modelLabel:'Sonnet', effort:'high'}` | `{base:'Sonnet', suffix:'High'}` | `Sonnet High ⌄` |
| `{modelLabel:'Opus', effort:'xhigh'}` | `{base:'Opus', suffix:'X-High'}` | `Opus X-High ⌄` |
| `{modelLabel:'<host default id>', effort:'max'}` | `{base:'<id 原文>', suffix:'Max'}` | Host 目录外默认值不加工，原样显示 |

> 后缀取值走既有 `effortLabel(selection)`（`efforts.ts:60+`），**不新建标签表**。`X-High` 保持本仓既有字面（Cursor 写 `Extra High`），理由：`efforts.ts:28` 的 `xhigh` 提示语与设置页文案已在用 `X-High`，改字面属跨面文案迁移，不在形态批范围；记入 §7 诚实性清单 H。

#### 3.1.2 「默认无框 + 悬停显壳」的类方案（用户第 4 条主体）

```ts
// middleColumnLayout.ts
export function composerModelTriggerClass(): string {
  return [
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2',   // 几何：24px 高、8px 圆角、8px 横内距
    'transition-colors duration-150',                                 // design-system 既有时长档
    'hover:bg-hover',                                                 // ← 鼠标悬停显壳
    'focus-visible:bg-hover',                                         // ← 键盘聚焦同样显壳（a11y，见 3.1.4）
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary',
    'data-[popup-open]:bg-selection',                                 // ← 弹层打开时保持显壳（更重一档）
    'disabled:pointer-events-none disabled:opacity-64',
  ].join(' ');
}
```

四条**硬性禁止**（`SelectTrigger` 基类 `ui/select.tsx:22` 带进来的全部形制，逐条对应原规格 §3.1）：

| 禁止 | 现状来源 | 为什么 |
|---|---|---|
| 任何 `border*` | `select.tsx:22` `border border-input` | 「常显示的外壳框」的字面来源；用户第 4 条点名删除 |
| 任何 `shadow*`（含 `before:shadow` 内高光） | `select.tsx:22` `shadow-xs` + `before:shadow-[0_1px_…]` | A07 `:1337`「按钮、卡片一律零阴影」；且 Cursor 实测零阴影（原规格 §2.1） |
| 任何 `min-w-*` | `ModelSelect.tsx:79` `min-w-22`(88px) + `EffortSelect.tsx:60` `min-w-26`(104px) | 固定下限制造死空间，正是第三轮「文字不居中」误诊的真因（`ModelSelect.tsx:67-75` 注释已记载）。合并后**宽度纯内容自适应** |
| `rounded-md` / `rounded-lg` 及以上 | `select.tsx:22` `rounded-lg`(16px) | 挂在 `h-6`(24px) 上被 CSS 钳成 `h/2`=满圆胶囊（原规格 §3.1）。**`rounded-sm`(8px) 是 A07 `.sel` 的原值** |

**「壳」的形态裁定**：Cursor 与 A07 `.sel`（`:810-819`）给的都是**填充式**壳（`hover:bg-hover`），不是描边式壳。用户第 4 条说的「外接框」在实现上落为一层底色而非一条边——这一点必须写死，否则很容易被实现成 `hover:border`，那会在 hover 瞬间把控件撑高 2px 造成行抖动。

> 复用性证据：`TargetFolderSelect.tsx:125` / `TargetBranchSelect.tsx:142` **已经在用**同一套 `hover:bg-hover data-[popup-open]:bg-selection`。本追补不是发明新形制，是把目标行早就在用的 ghost chip 形制横移到模型控件上，**全 Composer 自此只有一种下拉形制**。

#### 3.1.3 字号与内距（用户第 4 条后半句的取舍）

用户给的是一个二选一：「字体可以相对小一点，**或者**外接框稍微大一点点」。

| 方案 | 做法 | 与 D25 的关系 | 判定 |
|---|---|---|---|
| **A（采纳）· 框大一点点** | 字号维持 D25 **S11 = 14px `--text-ui`**，横内距 `px-1.5`(6px) → **`px-2`(8px)** | D25 §2.2 S11 一字不改 | ✅ |
| B · 字小一点 | 字号降到 `--text-meta` 13px | **要为单个控件破 D25 的域映射**（S9 目标行 folder/branch = 14、S10 运行位置 = 14、S11 模型 = 14 是同一行同一档） | ❌ |

选 A 的硬理由：模型 chip 与目标行三个控件**同为 24px 高的 ghost chip**，只是分处卡内 / 卡下两行。若模型 chip 单独降到 13px，两行之间会出现一档 1px 的字号差——这正是 polish-audit P-12 点名的「相邻档只差 1~2px、读不出层级」的病灶复制。

**连带**：为保持「全 Composer 只有一种 ghost chip」，目标行触发器的横内距**一并**由 `px-1.5` 提到 `px-2`。这修订了原规格 §5.2/§5.3 里写的 `px-1.5`，也是对 A07 `.sel`（`:810-819` `padding: 0 6px`）与 `.tgt-btn`（`:736-753`）的一次 **+2px 追记修订**，动因是用户第 4 条的明示要求。**幅度 2px，不改任何 token，不新增间距档**（`px-2` 是 0.25rem 刻度上的既有档）。

估值（非实测）：`Sonnet High` 在 14px sans 下约 82px + 内距 16 + gap 4 + chevron 14 ≈ **116px**。对比现状两枚触发器 `88 + 8 + 104 = 200px`，**Composer 右段净省约 84px**，全部让给 textarea。

#### 3.1.4 可及性（键盘态必须同样显壳）

「默认无框、hover 才显」若只挂 `hover:`，键盘用户将**完全失去控件边界**——Tab 到该控件时屏幕上没有任何形状变化，只有一圈 outline。三条硬要求：

1. `focus-visible:bg-hover` 与 `hover:bg-hover` **成对出现**（断言 F-A15 交叉校验，缺一即红）。
2. 保留本仓既有 outline 约定 `focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary`（同 `QuestionCard.tsx:400`），**outline 与底色两者叠加**，不互相替代。
3. `aria-label` 必须同时说清两件事：`aria-label={`Model and reasoning effort: ${base}${suffix ? ' ' + suffix : ''}`}`。理由：合并后「Effort」这个词在触发器上**只以档位值的形式出现**（`High`），不带类目词；纯靠视觉的用户能从菜单分组标题补上，读屏用户不能。

> 同理，`title` 属性给 `${base}${suffix ?? ''} — click to change model or reasoning effort`。这也是原规格 §9-① 记录的「Effort 发现性略降」风险的正式缓解措施。

### 3.2 弹层（`ComposerModelMenu`）

#### 3.2.1 原语选型

用 **Base UI `Menu`**（`@base-ui/react`，`package.json:40`），与 `TargetFolderSelect` / `TargetBranchSelect` 同族——`data-[popup-open]` 这个 data 属性就是该族给的。**不用 `Select`**：`Select` 的语义是「一个值」，我们要放的是两个独立单选组。

构件：`Menu.Root` / `Menu.Trigger`(render 为上面的 button) / `Menu.Positioner` / `Menu.Popup` / `Menu.GroupLabel`×2 / `Menu.RadioGroup`×2 / `Menu.RadioItem`×(3~4 + 6) / `Menu.Separator`×1。**全部为既有原语，零自研弹层。**

#### 3.2.2 视图模型（纯函数）

```ts
// composerModel.ts（原规格 §6.1 已登记，本追补给定形）
composerModelMenuModel({ options, selectedModel, selectedEffort }) => {
  sections: [
    { id: 'model',  label: 'Model',            items: [{ id, label, selected }] },   // 3~4 项
    { id: 'effort', label: 'Reasoning effort', items: [{ id, label, hint, selected }] }, // 恒 6 项
  ]
}
```

- `model` 段 items 来自 `ensureModelOptions(hostDefault)`（**不改** `models.ts`）。
- `effort` 段 items = `[{id:'default',label:'Default'}, ...CHAT_EFFORTS]`（**不改** `efforts.ts`），`hint` 原样透传到 `title`。
- 段序**写死** `model` → `effort`，不做用户排序。断言 F-A16 锁死段序与段数。

#### 3.2.3 几何与形制（全部为既有 token 直读，估值）

| 项 | 值 | 来源 |
|---|---|---|
| 弹层最小宽 | `min-w-40`（160px） | 估值：最长行 `Reasoning effort` 分组标题 ≈ 118px + 内距 16 + 勾选列 20 ≈ 154 → 收到 0.25rem 刻度的 160 |
| 弹层圆角 | `rounded-md`（12px） | 与既有 Menu popup 同档，≥32px 高的容器才用 12（原规格 §7.4 新规则） |
| 行高 | 既有 Menu item 档（`--h-row` 28px） | 不新增档；A07 `:1329` 明示 `--h-row` 仍服务「下拉项 / 侧栏会话行」 |
| 勾选标记 | 右侧 `Check size-3.5` | Cursor 同位（`134823` 的 `300K ✓` / `High ✓`） |
| 分组标题 | `--text-meta`(13) + `text-muted-foreground` + `tracking-[0.04em]` | D25 §2.2 段头口径 + polish-audit b.1-⑥ 字距梯度 |
| 分隔线 | `Menu.Separator`（1px `--border`） | 既有 |
| 打开方向 | `session` 态向上、`empty` 态向下 | 复用既有 `mentionPopupPlacementClass(mode)` 的同一判据（原规格 §5.2/§5.3），**不新增方向逻辑** |

#### 3.2.4 行为契约（一律沿用，不因合并而变）

| 契约 | 出处 | 处置 |
|---|---|---|
| 模型选择落 `useSessionModel` / effort 落 `useSessionEffort` | 两个 store | **零改动**（原规格 §9-① 已核） |
| `disabled={disabled \|\| busy \|\| sending}` | `ModelSelect.tsx` / `EffortSelect.tsx` 现状 | 不变（行为契约，非形态） |
| `resolveResumeModel()` 的解析口径 | `models.ts:57-63` | 不变 |
| effort=`default` ⇒ 线上不发 `effort` 字段 | `toWireEffort()` `efforts.ts:56-58` | 不变；**触发器不显示后缀**正是这条协议语义的可视化 |
| P-14 模型名兜底（`getSessionModel ?? defaultModelId`） | T-30 批1 `3dcd2dc` | 不变 |

#### 3.2.5 删除面

`ModelSelect.tsx`（92 行）与 `EffortSelect.tsx`（75 行）**整体删除**。
回归面已核（原规格 附录 A）：`models.test.ts` / `efforts.test.ts` / `sessionEffortStore.test.ts` 测的都是 `.ts` 纯层，不 import 组件 ⇒ **零影响**。
连带：`ModelSelect.tsx:67-75` 与 `EffortSelect.tsx:51-57` 那两段关于 `min-w` 配额的注释随文件消失——其结论（「`justify-between` + `min-w` 造成死空间被读成不居中」）**必须转写进 `composerModelTriggerClass()` 的注释**，否则下次有人重新加 `min-w` 时没有反面教材。

---

## 4. 两态装配增量（对原规格 §5.2/§5.3 的差分）

只列本追补改动的行，其余原样。

### 4.1 empty 态（原规格 §5.2）

```
       └─ div  composerBarClass('empty') = "mt-1.5 flex items-center gap-2"
            ├─ button composerAttachButtonClass()                             ← 原规格，不变
            ├─ <ComposerModelTrigger>  composerModelTriggerClass()            ★本追补定形
            │    ├─ span composerModelBaseClass()   = "text-muted-foreground"
            │    ├─ span composerModelSuffixClass() = "text-foreground font-medium"
            │    └─ <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ├─ renderStatusLine(...)                                          ← 见 §6 交叉说明
            └─ div "flex shrink-0 items-center gap-1.5"
                 └─ {actionButtons}  roundActionButtonClass()  size-6 + send=bg-foreground  ★拍板③ 无条件生效
```

### 4.2 session 态（原规格 §5.3）

```
       = "relative rounded-full border border-border bg-card focus-within:border-input
          flex min-h-10.5 items-center gap-2 p-2"        ★拍板② 无条件生效（hasExtras 时降 rounded-md）
                 ├─ <ComposerModelTrigger> composerModelTriggerClass()        ★本追补定形（原两枚 → 一枚）
                 └─ {actionButtons} roundActionButtonClass()                  ★拍板③ 无条件生效
```

### 4.3 双色极性对 D25 的依赖（必须记）

`composerModelSuffixClass()` = `text-foreground font-medium`。
D25 §3.2 已实证：**在 D18 的全等宽栈下 `font-medium`(500) 是 no-op**（多数系统等宽字体只有 400/700）。
⇒ **本追补的双色极性（基名浅 + 后缀深且更重）必须排在 D25 ①（`globals.css` 分域字族）之后才成立**，否则只剩颜色一维，「后缀更粗」一半失效。
原规格 §8.2 的施工序 **S1（D25 ① token 层）→ S2（形态主体）** 已经满足这个依赖，**不需要改序**，但需要在执行时把它作为一条显式前置条件（见 §6 断言 F-A17）。

---

## 5. 对原规格的逐锚点修订清单

| 原规格锚点 | 原文要点 | 本追补处置 |
|---|---|---|
| §4.1「圆角 · session」行，裁定列 `拍 ②` | 待拍板 | ✏️ **改记为「改」**——2026-07-31 用户拍板采纳 `rounded-full` |
| §4.3「数量」行，裁定列 `拍 ①` | 待拍板（推荐合并） | ✏️ **改记为「改」**——采纳合并；施工规格转由本追补 §3 承载 |
| §4.3「双色」行，裁定列 `拍 ①-b` | 待拍板 | ✏️ **改记为「改」**，并补 §4.3 的 D25 前置依赖 |
| §4.3「形制」行的类串 `h-6 rounded-sm px-1.5` | A07 `.sel` 原值 6px 内距 | ✏️ **内距 6 → 8**（`px-1.5`→`px-2`），依据用户第 4 条「外接框稍微大一点点」；同时**补 `focus-visible:bg-hover`**（原规格漏了键盘态显壳） |
| §4.4「hover 底圆角」行的目标 `rounded-sm` | 8px | ✅ 不变；但**内距同步 6 → 8**（与上一行成对，保持全 Composer 单一 ghost chip 形制） |
| §4.5「send / enfqueue 配色」行，裁定列 `拍 ③` | 待拍板 | ✏️ **改记为「改」**——采纳 `bg-foreground text-background` |
| §4.5「直径」行 | 已是「改」 | ✅ 不变（28→24 随 ③ 落地） |
| §5.2 / §5.3 装配树里的 `px-1.5` | — | ✏️ 全部改 `px-2`（见 §4.1/§4.2） |
| §5.2 / §5.3 装配树里 `composerModelTriggerClass()` 的类串 | 无 `focus-visible:*` | ✏️ 按本追补 §3.1.2 的六段式重写 |
| §6.2 **F-A8** 标注「仅在拍板 ① 采纳时启用」 | 条件启用 | ✏️ **无条件启用** |
| §6.2 **F-A14** 标注「仅在拍板 ③ 采纳时启用」 | 条件启用 | ✏️ **无条件启用** |
| §6.2 **F-A2b** | pill 的 hasExtras 分支 | ✏️ 由「拍板 ② 采纳时才有意义」升为**必测**；并新增 F-A21 断言 `composerCardClass('session')` 基线含 `rounded-full` |
| §6.2 **F-A5** | 触发器不含 border/shadow/min-w/rounded-lg，含 rounded-sm/hover:bg-hover | ✏️ **扩写为 F-A15**（增 `focus-visible:bg-hover` 与 `px-2` 交叉校验） |
| §8.3 量级表 S2b 行「拍板 ① 不采纳则降 S」 | 条件分支 | ✏️ 分支消除，固定为 **M（0.75d）**；细化见 §7 |
| §9 三项待拍板 | 待拍板 | ✏️ **全部结清**，见 §1.2。§9 自此仅作决策留痕，不再是开工阻塞项 |
| §10 诚实性清单 A~G | 七条 | ✅ 全部继续有效；本追补**追加 H~K 四条**（见 §7） |
| §7.2 A07 逐锚点表中 `:1632` 行标 ⚠️ 待拍板 ① | — | ✏️ 改为 **✏️ 已撤销**：A07 `:1632`「我们拆回现有的两个 select，零新控件」由 2026-07-31 用户拍板正式撤销，替代口径见本追补 §3 |
| §7.3 v4 追记文本草案的六~十节 | — | ✏️ **追加第十一节**「合并式模型档位控件与悬停显壳」，文本草案见 §8 |

> 原规格 §1（度量方法）、§2（实测数据表）、§3（归因）、§5.1（状态判据不变 + 单一 JSX 槽位红线）、§5.4（硬契约兼容表）、附录 A/B **一字不改**。

---

## 6. 断言增补（接原规格 F-A1~F-A14 编号往下）

全部仍为 vitest **node 环境**下的纯函数 / 字符串 / 静态扫描断言（`.tsx` 在本仓 vitest 下零覆盖，`vitest.config.ts` 的 `include` 只匹配 `*.test.ts`）。

| # | 断言 | 形式 | 抓什么回归 |
|---|---|---|---|
| **F-A15** | `composerModelTriggerClass()`：**含** `hover:bg-hover`、`focus-visible:bg-hover`、`rounded-sm`、`px-2`、`data-[popup-open]:bg-selection`；**不含** `border`、`shadow`、`min-w-`、`rounded-lg`、`rounded-md`、`rounded-full`。且「含 `hover:bg-hover`」与「含 `focus-visible:bg-hover`」**必须同真同假**（成对断言） | 字符串 + 成对交叉 | ① 常显外壳框复辟（用户第 4 条主体）；② 只给鼠标不给键盘的显壳（a11y 回归） |
| **F-A16** | `composerModelMenuModel({options:[3 项], selectedModel:'sonnet', selectedEffort:'default'})` → `sections.length === 2`；`sections[0].id==='model'` 且 `items.length===3`；`sections[1].id==='effort'` 且 `items.length===6`；`sections[1].items[0].id==='default'`；**全部 items 里 `selected===true` 的恰好各 1 项** | 纯函数 | 段序颠倒 / Default 漏项 / 多选或零选 |
| **F-A16b** | 同上，`options` 传 4 项（Host 目录外默认值前插）→ `sections[0].items.length===4` 且首项即该 Host 值 | 纯函数 | `ensureModelOptions` 的前插被合并控件吞掉 |
| **F-A16c** | `composerModelMenuModel(...)` 的返回对象**不含**任何 `search` / `auto` / `subPanel` 键（`Object.keys` 深扫） | 结构断言 | §2.2 ①②⑤ 的裁剪结论被后人「顺手补齐」 |
| **F-A17** | `composerModelSuffixClass()` 含 `font-medium`；**且** 断言文件顶部注释锚定 D25 ① 前置（配套：D25 的 A1 断言「`--font-sans` 已进 `@theme`」必须与本条在同一 suite 中先行通过） | 字符串 + 序依赖 | §4.3 的「后缀更粗在 mono 栈下是 no-op」被忽略 |
| **F-A18** | `composerModelTriggerClass()` 与 `targetTriggerClass()` 抽出的横内距类**相同**（正则取 `px-(\d+(?:\.\d+)?)`），且抽出的高度类相同 | 交叉 | 「全 Composer 只有一种 ghost chip」被局部改坏 |
| **F-A19** | `composerModelLabelParts` 的 `suffix` 对 `'default'` 为 `null`，对 `'xhigh'` 为 `'X-High'`（走 `effortLabel`），对未知字符串**不抛且回退为原值** | 纯函数 | 标签表二次实现 / 未知 effort 崩溃 |
| **F-A20** | 静态扫描：`src/renderer/components/chat/` 下 **不存在** `ModelSelect.tsx` / `EffortSelect.tsx` 两个文件（拍板 ① 落地后的删除证据），且目录内 `SelectTrigger` 命中数 === 0（即原 F-A8，无条件） | 文件系统 + rg | 旧组件被回滚复活 |
| **F-A21** | `composerCardClass('session')`（不带 opts）含 `rounded-full` 且不含 `rounded-md` | 字符串 | 拍板 ② 被回退 |
| **F-A22** | `roundActionButtonKindClass('send')` 与 `('enqueue')` 均含 `bg-foreground` `text-background` 且**不含** `bg-primary`；`('stop')` 含 destructive；三者两两不等 | 字符串 | 拍板 ③ 被回退 / send 与 stop 撞成同色 |

> 与原规格的关系：F-A5 被 **F-A15 取代**（更严格的超集），F-A8 并入 **F-A20**，F-A14 被 **F-A22 取代**。执行时按新编号写，旧编号在测试文件里以注释保留映射关系，便于对着原规格逐条点验。

---

## 7. 诚实性清单增补（接原规格 §10 A~G）

| # | Cursor 有 | 本仓处置 | 理由 |
|---|---|---|---|
| **H** | 模型列表行自带档位后缀（`Opus 5 High` / `Kimi K3 Max`）；`Extra High` 字面 | **不采**后缀；`X-High` 字面保持 | 后缀暗示「每模型独立记忆 effort」，本仓 effort 是**每会话**的（`sessionEffortStore.ts`），照搬 = 谎报能力。字面差异属跨面文案统一问题，不在形态批 |
| **I** | `Search models` 搜索框 | **不做** | 目录 3~4 项（`models.ts:17-21` + `ensureModelOptions`）。搜索框会暗示存在更大的模型目录 |
| **J** | `Auto` 自动路由开关 | **不做** | 无自动路由能力。同 A07 `:2843` 裁定④ 与原规格 §10-A 一条红线 |
| **K** | `Options` 子面板的 `Thinking` 开关与 `Context 300K/1M` 二选一 | **不做** | `Thinking` 在本仓是 Host 能力门控（`thinkingCard.ts:isThinkingCapable`），**用户无权开关**，做成开关等于给一个假旋钮；`Context` 无对应协议字段。子面板因此只剩 Effort 一组 ⇒ 降为内联段（§2.2 ⑤） |

---

## 8. A07 v4 追记 · 第十一节文本草案

续写在原规格 §7.3 的六~十节之后，**同一个 `<section>`**（原规格 §8.2 S6 的「一次成文，不允许拆」继续有效）。

```html
<h3>十一、合并式模型档位控件与「悬停显壳」（2026-07-31 用户第四轮点验第 4/5 条）</h3>
<p><b>撤销 :1632。</b>本页 <code>:1632</code> 原文「Cursor 的 <code>Fable 5 High</code> 是一个合并控件；我们拆回现有的两个 select（ModelSelect + EffortSelect），零新控件」——
用户 2026-07-31 第四轮点验第 5 条明示「model 和 effect 可以做到一个选项中」，该裁定正式撤销。
替代口径：单触发器 <code>{模型} {档位} ⌄</code>，基名 <code>--muted-foreground</code>、档位后缀 <code>--foreground</code> + 500 字重，effort=Default 时后缀整段不渲染。</p>
<p><b>:810-819 <code>.sel</code> 的两处追记。</b>裁定本身（无边框、无阴影、<code>--r-sm</code>、<code>hover:bg-hover</code>）<b>完全正确且是本次的落地目标</b>，只作两点补充：
① 横内距 <code>0 6px</code> → <code>0 8px</code>（用户第 4 条「外接框稍微大一点点」，同步应用于 <code>:736-753</code> 的 <code>.tgt-btn</code>，使 Composer 只剩一种 ghost chip 形制）；
② 补 <b>键盘态</b>：<code>:focus-visible</code> 必须与 <code>:hover</code> 呈现同一层底色 —— 「默认无框」的设计若只挂 hover，键盘用户会完全失去控件边界。</p>
<p><b>Cursor 弹层的裁剪判据（登记为方法论）。</b>参照图 <code>refs/feedback-20260731-round4/ScreenShot_2026-07-31_134823_982.png</code> 中的
搜索框 / <code>Auto</code> 开关 / 行内档位后缀 / <code>↺ Edit</code> / <code>Options</code> 子面板（Thinking·Context·Effort）五件，本仓<b>一件不搬</b>：
前四件是「9 个模型跨 5 家供应商」与「每模型记忆档位」这两个规模/能力前提的产物，本仓目录恒为 3~4 项、effort 为会话级；
子面板三组中 <code>Thinking</code> 是本仓的能力门控而非用户开关、<code>Context</code> 无协议字段，只剩 <code>Effort</code> 一组，为一组单选开横向子面板得不偿失 ⇒ 降为主列表第二分组段。
<b>可复用的一句判据：别人的搜索框和子面板是他的规模与能力的产物，不是他的样式。</b></p>
<p><b>本节不含任何新的像素实测。</b>round-4 素材 DPR 未知（无三条独立互证），只作结构依据；一切几何沿用 v4 追记六~十节的 round-3 实测（DPR 1.25）与本仓既有 token 档位。</p>
```

`docs/design-system.md` 连带（接原规格 §7.4 三节）：**第四节 · Ghost chip 的悬停显壳**——「工具条下拉一律无边框；壳用 `hover:bg-hover` **填充**实现，**禁止**用 `hover:border`（会在悬停瞬间撑高 2px 造成行抖动）；`hover:` 与 `focus-visible:` 必须成对给同一层底色。」

---

## 9. 量级更新

### 9.1 原估基线

原规格 §8.3：**合并总量（拍板 ① 采纳）= 5.3 ~ 5.8d（L+）**，其中 S2b（`composerModel.ts` + `ComposerModelTrigger.tsx` + 删两组件）= **M / 0.75d**，「拍板 ① 采纳线的 +0.5d」即 S2b 相对不采纳分支（0.25d）的差额。

### 9.2 本追补对该 +0.5d 的复核：**仍成立，且不再是估值**

第四轮参照图落地后，S2b 的内容第一次被完全确定，可逐项核：

| S2b 子项 | 内容 | 量级 |
|---|---|---|
| `composerModel.ts` | `composerModelLabelParts` + `composerModelMenuModel` 两个纯函数 | 0.15d |
| `ComposerModelTrigger.tsx` | Base UI `Menu` 装配（Trigger + Positioner + Popup + 2×GroupLabel + 2×RadioGroup + Separator），全部现成原语；两个 store 接线照搬现有两组件 | 0.35d |
| 删 `ModelSelect.tsx` / `EffortSelect.tsx` + 注释转写 | 167 行删除，`min-w` 反面教材注释转写 | 0.05d |
| F-A16/16b/16c/19 四条断言 | 纯函数断言 | 0.1d |
| a11y（`aria-label` / `title` / `focus-visible` 成对） | §3.1.4 三条 | 0.1d |
| **小计** | | **0.75d** ✅ 与原估 M 一致 |

**结论：+0.5d 仍成立。** 裁剪掉搜索框 / Auto / 子面板省下的工作量（估 0.3~0.5d），恰好被本追补新增的 a11y 三条与四条断言吃掉。

### 9.3 ②③ 拍板对总量的影响

| 项 | 增量 | 说明 |
|---|---|---|
| ② `rounded-full` + `hasExtras` 分支 | **+0**（已在 S2a 内） | 原规格 §5.3 已写好类与分支，F-A2b 早已列出；采纳只是把条件启用改为必测 |
| ③ `size-6` + `bg-foreground` | **+0.05d** | `roundActionButtonClass` 改档已在 S2a；新增的是 `roundActionButtonKindClass('send'/'enqueue')` 的配色分支与 F-A22 |
| 本追补新增：`px-1.5`→`px-2` 连带目标行 | **+0.05d** | 一处类改 + F-A18 交叉断言 |
| 本追补新增：F-A15/A18/A20/A21 四条 | **+0.1d** | |
| A07 v4 追记第十一节 + design-system 第四节 | **+0.1d** | 与六~十节同批成文，边际成本低 |

### 9.4 更新后合计

| 方案 | 合计 |
|---|---|
| 原规格 §8.3「拍板 ① 采纳」线 | 5.3 ~ 5.8d |
| **本追补更新（①②③ 全采纳 + 第 4 条无框悬停 + 弹层定形）** | **5.6 ~ 6.1d（L+）** |

增量 **+0.3d**，来源全部在 §9.3 表内，**无一项来自 S2b**（S2b 仍为 0.75d）。
施工序**不变**（原规格 §8.2 的 S0~S7 原样），仅：S0 的断言条数由 14 → **18**（F-A1~A4、A6、A7、A9~A13 沿用 + F-A15~A22 八条新增，F-A5/A8/A14 被取代）。

---

## 10. 本追补自身的可拍板点（不阻塞开工）

三项均已给推荐值并按推荐值成文；**若用户不点，按本文口径施工**。

| # | 点位 | 本文取值 | 备选 | 影响面 |
|---|---|---|---|---|
| **α** | 分组标题文案 | `Model` / `Reasoning effort` | `Model` / `Effort`（更短，但 `Effort` 单独出现时语义偏工程） | 两个字符串 |
| **β** | `X-High` 是否改写为 `Extra High`（对齐 Cursor 字面） | **不改**（§7-H） | 改，则需同步设置页与 `efforts.ts:28` 提示语 | 跨面文案，建议另批 |
| **γ** | 目标行触发器是否跟随 `px-1.5`→`px-2` | **跟随**（保持单一 ghost chip 形制） | 不跟随，则 Composer 内出现两种内距 | 一处类 + F-A18 |
