# Evidence — U01 样式地基落地

> 2026-09-03，批次 1（U01-a/b/c/d）。分支 `feat/pi-primary-backend`。
> 依据 [execution-plan](../topics/execution-plan.md) 的 U01 验收标准逐条取证。

## U01-a 字号 / 行高 / 圆角改档 — Done

改动落点全部在 `src/renderer/styles/globals.css` 的 `@theme` 与 `@layer base`：

| Token | 旧 | 新 | 说明 |
|---|---|---|---|
| `--text-markdown` | 0.9375rem (15px) | 0.875rem (14px) | 与 `--text-ui` 同值，pix 亦然；两者仍是两个 token |
| `--text-code` | 0.8125rem (13px) | 0.75rem (12px) | 跟随正文动，档比 0.867 → 0.857，仍在推荐带内 |
| `--text-meta` | 0.8125rem (13px) | **不变** | 变更理由是「次级 UI 文本」，与正文无关 |
| `--radius`（= `--radius-sm`） | 0.5rem (8px) | 0.375rem (6px) | |
| `--radius-md` | 0.75rem (12px) | 0.625rem (10px) | |
| `--radius-lg` | 1rem (16px) | 0.75rem (12px) | |
| `--radius-xs` | 0.25rem (4px) | **不变** | 本仓独有档，pix 无对应物 |
| `body` | 无字号、无行高 | `font-size: var(--text-ui)` + `line-height: 1.45` | pix 的 body 是 14/1.45 |

**两处刻意不动**：

- `html` 的 `--font-size-base: 16px` 是整套 token 的 rem 基准，改它会把全仓每个 rem 值一起缩放。
- Markdown 正文的 `leading-relaxed`（1.625）来自 F5 D1-b（2026-08-18），是针对长文阅读单独定的，
  与 UI 外壳的默认行距不是同一个问题。pix 的 1.45 落在 `body` 上，正对应我们此前完全空缺的那一档。

**验收**：全仓未新增任何为绕过新档而写的任意值类名（改动只发生在 token 声明处，零个组件文件被改）。

## U01-b 灰阶明度重映射 — Done

只改 OKLCH 的 **L 分量**，色相角与彩度一个都没动，因此仍是 Flexoki 暖色系而非 pix 的无彩度灰
（[evidence-u01](../topics/evidence-u01-numeric-scale.md) 的红线）。

**动机（实测）**：暗色下 canvas → panel 只差 0.0216 L，即 **1.05:1**——面板对画布几乎不可见，
`globals.css` 自己的注释也承认「all panel separation rests on the border」。pix 的同一步是 0.0838 L。

**新的明度阶**（暗色）：

| Token | L 旧 → 新 | 新 hex |
|---|---|---|
| `--background` | 0.1981（不变） | `#171515` |
| `--card` / `--popover` | 0.2197 → **0.2620** | `#262423` |
| `--muted` | 0.2228 → 0.2680 | `#272625` |
| `--secondary` | 0.2315 → 0.2760 | `#292827` |
| `--accent` / `--hover` | 0.2912 → 0.3050 | `#302e2e` |
| `--selection` | 0.3112 → 0.3250 | `#363333` |
| `--border` | 0.3214 → 0.3400 | `#393836` |
| `--input` | 0.3651（不变） | `#403e3c` |

亮色按同样的秩序反向做（`--card` 0.9837→0.97、`--muted` 0.969→0.965、`--secondary` 0.9673→0.962、
`--accent`/`--hover` 0.9422→0.935、`--selection` 0.9152→0.91、`--border` 0.881→0.875；
`--background` 与 `--input` 不变）。

**两条自我约束**：

1. **秩序不变**：亮暗两套的 token 排序前后完全一致，只有间距变宽——没有任何 token 越过另一个。
2. **panel → hover 用 pix 自己的 0.043 L**（0.3050 − 0.2620 = 0.0430 vs pix 的 0.0435），
   所以面板抬高之后 hover 仍然读得出来。

**对比度实测**（sRGB / WCAG，脚本用 OKLCH→sRGB→相对亮度，`--foreground` 与 `--muted-foreground` 均未改动）：

| 组合 | 暗色 旧 → 新 | 亮色 旧 → 新 |
|---|---|---|
| `--foreground` on `--card` | 10.85 → **9.68** | 18.28 → **17.57** |
| `--foreground` on `--accent`（用户气泡填充） | 8.81 → **8.40** | 16.17 → **15.83** |
| `--muted-foreground` on `--card` | 6.39 → **5.70** | 7.01 → **6.74** |
| `--muted-foreground` on `--accent` | 5.19 → **4.94** | 6.20 → **6.07** |
| 面板分离 card\|background | 1.049 → **1.177** | 1.027 → **1.069** |
| 气泡分离 accent\|background | 1.292 → **1.356** | 1.161 → **1.187** |
| 悬停可见 accent\|card | 1.232 → **1.152** | 1.130 → **1.110** |

**结论**：`--foreground` 在每一个 surface 上都 ≥ 4.5:1（暗色 6.67–11.38，亮色 11.98–18.78）。
`--muted-foreground` 在所有**承载文本**的 surface 上也 ≥ 4.5:1。

**两个必须说清的代价**：

- **hover 在 card 上的可分辨度略降**（暗 1.232→1.152）。这是抬高面板的直接代价，且我们把 hover 的
  抬升量对齐到了 pix 自己的数值——pix 的 hover 相对其面板本来就更含蓄。
- `--muted-foreground` 落在 `--input` 上是 3.92:1（暗色），**低于 AA**。这是**改动前就存在**的状态
  （`--input` 本轮未动），且 `--input` 在本仓是描边/填充色而非文本背景（`globals.css` 注释已注明）。
  本轮既没有改善它也没有恶化它。

**保护项复核**：用户气泡的 `border-input` + `bg-accent` 组合（[evidence-u09](../topics/evidence-u09-component-forms.md) #4
标注为「测过的对比度修复」）在新值下 `--foreground` 对比度 8.40:1，描边与填充分离度 1.260，仍然成立。

## U01-c 间距与尺寸档 — 三项全部未改，原因分列

**Composer 内距 8px → 12/14/4：不改。** 这是 [D03](../decisions/003-sidebar-density-and-runtime-field-ownership.md)
决定一的**同型冲突**，按同一条规则处理：

- `evidence-u01` 把 `composer pad 12/14/4` 列为可搬。
- `evidence-u09` #1 判定 Composer 时明确要求「保留我们 token、8px 圆角、24px 控件档、**8px 内距**」。
- 代码侧还有第三个理由：`middleColumnLayout.ts:157-181` 的注释记载，现在的对称 8px 内距
  （T-30b2 §4.1）**正是为了取代 A07 那套「靠眼睛估出来的三值内距」**，而 pix 的 12/14/4 恰恰就是三值内距。
  同处还有一份 74px 静息高度契约（2 + 16 + 24 + 8 + 24），有测试逐项核对。

按 D03 决定一确立的先例——U01 与 U09 冲突时以 U09 为准——**内距保持 8px**。

**侧栏宽 280→272、右面板宽 380→480、阅读栏 45rem：不改，另开 [Q11](../open-questions.md)。**
这三项都是**布局尺寸而非样式 token**，落在 [D01](../decisions/001-style-depth-and-sequencing.md)
决定一授权的「字号 / 行高 / 间距 / 圆角 / 灰阶」之外；`evidence-u01` 自己也给右面板那条标了
「布局，非样式 token」。其中阅读栏还有一个连带问题：正文降到 14px 后，720px 装的从 48 个 CJK 当量
变成约 51.4 个，D25 §3.4 的原推导失效——已在 `docs/design-system.md` 就地标注，值本身维持 45rem。

## U01-d 同步 `docs/design-system.md` — Done

三处更新：圆角分档表（6/10/12 + 变更说明）、字号分档表（markdown 14 / code 12 + body 14/1.45 说明 +
「同值不同 token」的理由）、阅读栏推导（标注 48 → 51.4 CJK 当量的失效点与三种选法，指向 Q11）。

## 门禁

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行执行，未并行、未整套跑：

| 项 | 命令 | 结果 |
|---|---|---|
| 样式 / chat | `vitest run --maxWorkers=1 --no-file-parallelism src/renderer/styles src/renderer/components/chat/__tests__/` | **71 files / 1632 tests pass** |
| workspace-shell / 布局 | `vitest run --maxWorkers=1 --no-file-parallelism src/renderer/components/workspace-shell/__tests__/` | **16 files / 339 tests pass** |
| typecheck | `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck` | **pass**（无输出） |
| Biome | `pnpm exec biome check .` | **961 files, 0 error / 27 warning / 17 info** |
| `git diff --check` | — | **clean** |

**Biome 数字的解读**：27 warning + 17 info 是**既有状态**，不是本轮引入的——`git stash` 前后跑同一条命令
得到完全相同的计数。`globals.css` 本身在 Biome 的 ignore 列表里，所以本轮唯一的代码改动不进 lint。
未跑 `typecheck:agent-host`：本轮没有触及 agent-host。

## GUI 点验 — Pass

2026-09-03，用户按自己的要求**不走 CDP 截图，直接肉眼看真实窗口**。
启动方式：`AICLIENT_NODE24_PATH=$PWD/out-node-runtime/node AICLIENT_SKIP_AUTH_GATE=1 node scripts/dev.js`
（仓库文档化的 dev 入口，未使用任何会重装 native modules 的路径）。

**结论：没有问题。** 四个关注点——面板相对画布的浮起感、悬停在抬高后的面板上是否仍可分辨、
正文 14px 与代码 12px 的可读性（含 CJK）、三档圆角收紧后的观感——用户均未提出异议。

特别地，U01-b 事先标注的那个已知代价（hover 在 card 上的可分辨度从 1.232 降到 1.152）
**在真实窗口上没有构成问题**，不需要回调明度阶。

**无关噪声**：dev 日志刷出大量 `[workspace-tree] worktrees-absent`，是工作区树探测 git worktree
未果的既有行为，与本轮改动无关，未处理。
