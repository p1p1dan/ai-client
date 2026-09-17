# dev item 25 (F7a / F7c) — permission card & question card against docs/design-system.md token tiers

Measured on the running dev app over CDP with `getComputedStyle` (raw dumps:
[dev-25-permission-card-computed.json](dev-25-permission-card-computed.json),
[dev-25-question-card-computed.json](dev-25-question-card-computed.json)).
Screenshots: `dev-25-01-permission-card.png`, `dev-25-03-question-card.png`.
Both cards were driven by the local fake gateway (`write-approval` and a new `ask-question` plan),
not by a real provider.

Token tiers used as the yardstick: radius 4/6/10/12 (§Border Radius), squircle buttons
`rounded-[10px]` + `supports-[corner-shape:squircle]:rounded-[50px]` (§Squircle), shadows
none/xs/sm/md/lg (§Shadow), sizes 10/12/13/14/18 (§Typography), weights 400/500/600/700
(§Font Weight), spacing gap-1/2/3 = 4/8/12 (§Spacing), motion 100/150/250 ms (§Motion).

## Permission card (F7a)

| element | measured | tier | in tier? |
|---|---|---|---|
| card container | `rounded-md` → 10px, `border` 1px, `bg-card`, box-shadow **none**, h 301px | radius md (容器) + §Shadow「靠 border + bg-card 而不是阴影」 | ✅ |
| header row | `min-h-9` (36px), padding 8/12, gap 8px | 高度 h-9 / gap-2 | ✅ |
| 「权限」label | 14px / **500** / `tracking-[0.01em]` | `--text-ui` ✅ ; weight 500 ⚠️ ; 0.01em 是**按钮**档的值，用在了卡片段头上（段头档是 +0.04em） | ⚠️ |
| 「高风险」badge | 13px / 400 / `rounded-sm` 6px / h 24px | `--text-meta` + radius sm on h-6 → 未被钳成满圆 | ✅ |
| card title 「write — 写入工作区文件」 | 14px / **500** / `text-ui font-medium leading-relaxed` | 档位表把**卡片 / 对话框 / 段落标题**判给 `font-semibold`(600) | ⚠️ |
| 「内容」label | 13px / 400 | `--text-meta` | ✅ |
| content block | 14px, `font-mono` (`ui-monospace`), `tracking-normal`, radius 10px, padding 10px, `max-h-48 overflow-auto` | mono 禁止非零 tracking → 显式 `tracking-normal` ✅ ; radius md on h≥32 ✅ ; **padding 10px (`p-2.5`) 不在 4/8/12 档** | ⚠️（轻） |
| path line | 12px `--text-code` + `font-mono` + `truncate` | 路径归 code 档 | ✅ |
| 「A」序号 chip | 13px, `rounded-xs` 4px, `size-5` (20px) | radius xs on 小内嵌元素 | ✅ |
| 「项目：…」/ 倒计时 | 13px / 400，倒计时带 `tabular-nums` | `--text-meta` + §数字对齐「会原地变化的数字必须 tabular-nums」 | ✅ |
| 三个按钮 | h 28px, 14px / 500, radius **50px**, padding 0/9, gap 6px, transition **0.15s**, 第一个带 `shadow-xs` | §Squircle 的 50px 就是基线值；150ms = Normal 档；按钮保留 `shadow-xs` 是文档写明的过渡态 | ✅ |
| 卡内纵向间距 | `gap-3` 12px / `gap-1` 4px / `gap-2` 8px | 宽松 / 紧凑 / 标准 | ✅ |

## Question card (F7c)

| element | measured | tier | in tier? |
|---|---|---|---|
| card container | radius 10px, border 1px, no shadow, h 401px | 同上 | ✅ |
| header 「Questions」 | 14px / **500** / `tracking-[0.14px]`(=0.01em) | 字号在档；weight 同上 ⚠️；**文案是英文硬编码**（`QUESTION_TITLE` 常量，未过 `t()`） | ⚠️ |
| question text | 14px / **500**, padding 8/4 | `--text-ui`；weight 同上 | ⚠️ |
| radiogroup | gap 8px | gap-2 | ✅ |
| option row 外壳 | radius 10px, padding **8px**, gap **10px**, h 68px | radius md on h≥32 ✅；**gap 10px (`gap-2.5`) 不在 4/8/12 档** | ⚠️（轻） |
| option button | radius **50px**, h 50px, padding 0/11, gap 10px, transition 0.15s | squircle 基线 ✅ | ✅ |
| option label | 14px / **500** | `--text-ui`；weight 同上 | ⚠️ |
| option description | 13px / **500**（继承按钮基类的 `font-medium`） | 档位表：**描述 / 占位文本一律 `font-normal`(400)** | ⚠️ |
| 「A/B/C/D」chip | 13px, radius 4px (`rounded-xs`), 20px 见方 | ✅ | ✅ |
| Skip / Continue | h 24px (`h-6`), radius **6px** (`rounded-sm`), 14px/500 | h-6 小控件配 rounded-sm 正是钳制硬规则第 1 条要求的 | ✅ |
| 「Ctrl + Enter」副标 | 13px `text-meta opacity-70` | meta 档 | ✅ |

## 结论

- **几何与色彩全部在档**：圆角只出现 4 / 6 / 10 / 50(squircle) 四个值，字号只出现 12 / 13 / 14 三档，
  动画只有 150 ms，两张卡都是「零阴影 + border + bg-card」，`font-mono` 处都显式写了 `tracking-normal`，
  会变的数字带 `tabular-nums`。没有任何任意值色、没有 `shadow-[...]`、没有 `text-[13px]` 这类写法。
- **字重是唯一的系统性偏差**：两张卡的标题层级全部靠 `font-medium`(500)。档位表把卡片/段落标题判给
  `font-semibold`(600)，理由正是 **Win10 的 Segoe UI 静态族没有 500，CSS 会降到 400**——
  这批点验的下一站就是 Windows 加密机，在那台机器上两张卡的标题会和正文逐像素相同。
  问答卡的选项描述还额外从按钮基类继承了 500，而档位表要求描述用 400。
- **两处 10px**（权限卡内容块的 `p-2.5`、问答卡选项行的 `gap-2.5`）不在 4 / 8 / 12 的间距档上。轻微。
- **问答卡整片文案没走 i18n**（`Questions` / `Other…` / `Skip` / `Continue` / `Ctrl + Enter` 都是硬编码
  英文常量），而紧挨着的权限卡每一句都过了 `t()`。这是观感上最刺眼的一条，见缺陷表 D20。
