# Evidence — U01 数值档对齐取证

> 2026-09-03，[D02](../decisions/002-layout-cwd-and-evidence-scope.md) 决定三派 `maxapi/grok-4.6` 子代理取证。
> 读取对象：pix 冻结提交 `da01b3e` 的 `styles.css` vs AiClient `src/renderer/styles/globals.css` + `docs/design-system.md`。
> 两者 rem 基准都是 16px（pix 未设 html font-size；AiClient `--font-size-base: 16px` `globals.css:169`）。

## pix 数值档（styles.css）

**Typography**：`--ui-font-size` 14px（:192）、`--code-font-size` 12px（:193）、`--composer-prompt-size` = 14px（:1567）、`--composer-prompt-leading` 1.5（:1568）、`--group-label-size` 14px（:198）、`--group-label-line-height` 1.35（:200）、`body` 14px / **1.45**（:326-327）、`.pix-md`/气泡 14px（:1898,1990）、bootstrap brand 18px（:378）。

**Radius**（`@theme` :16-20）：sm **6px**、md **10px**、lg=xl=2xl **12px**。别名 control=sm / field=md / panel=lg（:178-180）。

**Spacing**：`--composer-prompt-pad` 12px 14px 4px（:1569）、composer dock pb 8px（:1306）、sidebar chrome p-2.5/gap-1（:844）、nav/list/section **h-8**（32px）+px-2.5（:860-896）、thread column pad 24px（:1232-1233）、`.timeline` pt-6 pb-40（:1890）、assistant row **mb 26px**（:2606）、tool/think wrap mb 10px（:2643）、user-edit bubble pad 14×18（:2004）。Header h-46px（:1088）。

**Layout**：`--sidebar-width` 272（:173）、`--thread-max` 760（:174）、`--review-width` 480（:175）。

## AiClient vs pix 逐项对比

| Category | AiClient | pix | 判定 |
|---|---|---|---|
| UI size | `--text-ui` 14（`globals.css:56`） | 14 | ✅ **匹配** |
| Title | `--text-title` 18（`:57`） | 18 | ✅ **匹配** |
| 2xs | 10 / lh 14（`:44-45`） | ~10-11 ad-hoc | 接近 |
| Markdown/body | `--text-markdown` **15**（`:48`）；body 继承 16，无 lh（`:291-293`） | **14** / lh **1.45** | ❌ **不同 → 14/1.45** |
| Code | `--text-code` **13**（`:47`） | **12** | ❌ **不同 → 12** |
| Meta/group | `--text-meta` 13（`:55`） | group-label **14** / lh 1.35 | ❌ **不同** |
| Composer type | session `leading-6`（24px 盒；`middleColumnLayout.ts:461+`） | 14px / lh 1.5 / pad 12-14-4 | ❌ **不同** |
| radius-xs | 4（`:39`） | 无 | 保留（AiClient 独有） |
| radius-sm | **8**（`:40`） | **6** | ❌ **不同 → 6** |
| radius-md | **12**（`:41`） | **10** | ❌ **不同 → 10** |
| radius-lg | **16**（`:42`） | **12**（xl/2xl 同值） | ❌ **不同 → 12** |
| Sidebar width | **280**（`shellLayoutModel.ts:24`） | **272** | ❌ **不同** |
| Reading col | **720**（`45rem`，`:60`；D25 48 CJK@15） | **760** | ❌ **不同**（14px body 也会改 CJK 公式） |
| Sidebar row | **h-7 / 28**（`design-system.md:546`） | **h-8 / 32** | ❌ **不同** |
| Composer inset | `p-2` = 8（`middleColumnLayout.ts:162`） | 12/14/4 | ❌ **不同** |
| Msg gap | 不是 token | 26px assistant mb | ❌ **不同** |
| Review/panel | 默认 **380**（`shellLayoutModel.ts:35`） | **480** | ❌ **不同**（布局，非样式 token） |

## 关键：灰阶不可照搬

**D01 保留 Flexoki 结构与调色板。** pix 灰阶是**无彩度 hex**；AiClient 暗色是**暖色 OKLCH**（`design-system.md:60-75`）：bg `#171515`/`oklch(0.1981 0.0032 17.43)`（`globals.css:186`）、card `#1c1a19`（`:188`）、muted `#1C1B1A`（`:194`）、hover `#2d2b2b`（`:199`）、border `#343331`（`:209`）、muted-fg `#9F9D96`（`:195`）。pix `--foreground` 是冷近白；Flexoki ink 是 `#CECDC3`。pix `--primary`/`--link` 是蓝（品牌，非灰）。**照搬 pix hex 会抹平 Flexoki 的色相。**

**安全可搬**：font-size、line-height、radius px、spacing/行高。
**不可搬**：任何颜色 token，包括「中性」表面/边框/前景色。

**可调粒度**：只可把 **L 阶关系**（canvas < sidebar < panel < hover）重映射到 Flexoki 色度上，**不可**换 hex。

## 对 U01 的修正

roadmap 原文写「中性灰阶向 pix 靠拢」——**措辞需修正**：灰阶**不能**照搬 pix 的 achromatic hex。U01 对齐范围为：字号（markdown 15→14、code 13→12、meta/group 视对齐）、行高（1.45）、圆角（sm 8→6、md 12→10、lg 16→12）、间距/行高（sidebar row 28→32、composer pad）。灰阶只做 **L 阶关系重映射**，不换 hex。
