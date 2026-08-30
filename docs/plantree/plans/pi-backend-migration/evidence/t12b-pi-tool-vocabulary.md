# T12-b 切片 1 证据 — 工具行改说 pi 的方言（2026-08-29）

## 起因：评估 T12-b 时先撞上一个更基础的缺陷

T12-b 原计划是移植 pi-app 的工具卡（人话摘要 / diff 徽记 / 原生预览）。评估过程中先
做了一次探针，把 pi 的七个内置工具喂进 `deriveToolRowView`，输出是：

```
read   → { verb: "Ran", arg: "src/foo.ts", class: "action" }
edit   → { verb: "Ran", arg: "src/foo.ts", class: "action" }
write  → { verb: "Ran", arg: "src/new.ts", class: "action" }
bash   → { verb: "Ran", arg: "npm test",   class: "action" }
grep   → { verb: "Ran", arg: "src",        class: "action" }   ← 显示的是路径不是 pattern
find   → { verb: "Ran", arg: "*.ts",       class: "action" }
ls     → { verb: "Ran", arg: "src",        class: "action" }
```

**每一行都是 `Ran`。**

## 根因：渲染层还在说 Claude 的方言

pi 的内置工具名是**小写**的 —— `read` / `edit` / `write` / `bash` / `powershell` /
`grep` / `find` / `ls`（取自 SDK `dist/core/tools/*.js` 里各自的 `name:` 字面量，
非猜测）。而 `toolCard.ts` 的表全是 Claude 的大写名（`Read`/`Grep`/`Glob`/…）。
两边**一个都不重合**，于是每次查表都 miss —— 静默、无类型错误。四处各自坏掉：

| 位置 | 症状 |
|---|---|
| `TOOL_VERBS` | 全部落 `UNKNOWN_TOOL_VERB` ⇒ 每行都是 `Ran` |
| `classifyTool` | 全部归 `action` ⇒ **工具聚合在 pi 上从来没触发过** |
| `deriveAggregateRow` | 按 `file_path` 去重，pi 用 `path` ⇒ 退化成按 `toolCallId`，同一文件读两次算两个 |
| `formatToolArgDetail` | 落 `default:` 分支，其探测顺序是 `command ?? description ?? path ?? … ?? pattern` ⇒ **grep 显示 `path` 而不是 pattern**；且 `argKind` 为空 ⇒ 路径按比例字体渲染而非等宽 |

这与 T12-a 是**同一族**问题：后端已经换成 pi，渲染层还在按 Claude 的词汇表查表。

## 改了什么

单文件 `src/renderer/components/chat/toolCard.ts`：

- 新增 `PI_TOOL_NAMES` 常量（八个内置工具，头注记明取自 SDK 哪里）；
- `TOOL_VERBS` 补 pi 条目 —— **刻意复用既有英文**而不是另造一套方言：`grep`→`Grepped`
  同 `Grep`，`find`→`Searched files` 同 `Glob`（两者都是"按 glob 找文件"），
  `write`→`Edited` 同 `Write`。`ls` 是唯一没有 Claude 对应物的，故是本批唯一新造的动词三元组；
- `classifyTool`：`read`→read，`grep`/`find`/`ls`→search。**`ls` 归 search 不归 read** ——
  聚合行把 read 说成「N files」并按路径去重，而目录列表既不是文件也不会被"重复读"；
- `deriveAggregateRow` 去重键读 `file_path ?? path`（两种方言）；
- `formatToolArgDetail` 补五个 pi 分支：`read`（含行号区间）/`edit`+`write`/`grep`+`find`
  （取 pattern，路径只是限定范围）/`ls`（`path` 在 pi schema 里是**可选**的，缺省时说
  「working directory」而不是留一个光秃秃的 `Listed`）/`bash`+`powershell`（pi 的 bash
  schema 只有 `command` 和 `timeout`，**没有** Claude 那个 `description` 兄弟字段，
  所以这里没有 prose 备选）。

改完后同一个探针：

```
read → Read / src/foo.ts / read        grep → Grepped / TODO / search
edit → Edited / src/foo.ts / action    find → Searched files / *.ts / search
write→ Edited / src/new.ts / action    ls   → Listed / src / search
bash → Ran / npm test / action
```

## 测试与变异

新增 `src/renderer/components/chat/__tests__/piToolVocabulary.test.ts`（**23 例**）。
其中一条是**防复发的兜底断言**：遍历 `PI_TOOL_NAMES`，除 bash/powershell 外
任何一个落到 `Ran` 就红 —— 以后往 `PI_TOOL_NAMES` 加工具却忘了配动词，会在这里红，
而不是又悄悄发一个 `Ran` 出去。bash/powershell 单独断言 `Ran` 是**正确答案**（不是缺失），
免得后来者"顺手修好"。

变异 **6 发，6/6 咬红**：

| # | 变异 | 红 |
|---|---|---|
| M1 | SEARCH 集合去掉 pi 三个名字 | 3 |
| M2 | 聚合去重只读 `file_path` | 1 |
| M3 | `ls` 的 `ident` 档位写死 prose | 1 |
| M4 | grep/find 分支失效（退回 default） | 2 |
| M5 | 删掉 `ls` 的动词条目 | 2 |
| M6 | `read` 分支不再标 `ident` | 1 |

md5 对账还原（`ac0e05ec07a86ea3830584f8b9bde600`）。

## 四门

- typecheck 0 · biome `src`+`scripts` 1048 文件 0/0
- vitest **272 文件 / 5413 例全绿**（T12-a 后为 271/5390 → +1 文件 +23 例）
- **既有测试零破坏** —— Claude 那半张表一字未动，只是补了并列的另一半。

## 切片 2（2026-08-29 同日）—— edit/write 的 diff 预览

### 范围为什么是两层不是三层

roadmap 原写「声明模板 → 原生预览 → 通用 default 三层 fallback」。**第一层对我们不存在**：
pi-app 的 `tool-card-registry.ts` 走 `adapters.json.catalog` IPC 读 `AdapterJson.toolCard.template`，
那是它的 **extension-compat 适配器层**，而本 plan README 已把「34 个逐扩展适配器」
列为**非目标**。没有那一层 `resolveAdapterForTool` 恒返回 undefined。⇒ 实际是
**原生预览 + 通用 default 两层**。

### 本切片只做 edit/write 的 diff

理由：其余工具（read/grep/bash/ls）的输出**今天已经是纯文本**，在 `<pre>` 里读起来
没什么问题；而 `edit` 展开后是 `oldText`/`newText` 两坨转义过的 JSON —— 全应用**唯一
会改用户文件**的调用，却是最难读的那个。

新增 `toolDiff.ts`（纯逻辑）+ `ToolRowDiffSegment`（渲染）：

- **从参数推导，不从输出推导**。pi 的 `edit` 返回的是一句成功文案不是补丁，而参数里
  `edits[].oldText`/`newText` 两边都齐。副作用是**运行中和被拒的调用同样能看**——
  被拒时「本来要改成什么」正是最该看见的东西。
- **自己写 LCS，不用现成包**。位置对齐式比较（pi-app 的做法）在行数变化时就错：
  开头插一行，后面每一行都会被判成改动。至于为什么不装包：`diff` 在树里但只是
  **传递依赖**（父包哪天不要它就没了），而唯一那个直接依赖 `@pierre/diffs` 在
  `src/` 里**零引用**。一个 35 行有测试的教科书算法是更小的负债。
- **diff 取代原始参数体而不是并列**：两者是同一批字节，并列等于在可读渲染的正下方
  再贴一遍它自己的转义版本。
- **颜色用语义 token** `--success`/`--destructive`，不用 pi-app 的 `text-green-600
  dark:text-green-400`：`StatusLine.tsx` 的 `+N`/`-N` 已经是这个口径，而生 palette
  既是同一件事的第二套词汇，也违反设计系统「不写原始色阶」。

⚠️ **写的时候被自己的测试抓到一处死分支**：`editPairs` 我写了「兼容 Claude 的
`old_string`/`new_string` 拼法」，但外层工具名闸只认小写的 `edit` ⇒ 那份兼容**永远
跑不到**。这正是注释比代码活得久的经典形状。已把工具名闸也放宽到 `Edit`/`MultiEdit`/`Write`。

**另**：`PI_TOOL_NAMES` 抽到独立的 `piToolNames.ts`，因为 `toolCard.ts` 与 `toolDiff.ts`
互相 import 会成环 —— 本仓在 bundle 层被这个形状咬过。

### 测试与变异（切片 2）

`toolDiff.test.ts` **17 例**：5 例 diff 算法 + 7 例参数推导 + **5 例行视图接线**
（没有最后这组，整个模型可以完全正确却无人渲染）。

变异 **5/5 咬红**：LCS 退回位置比较（2 红）· 去掉空串守卫（2 红，否则新文件顶部多一行
幻影空行）· diff 不再取代原始参数体（1）· 视图不再携带 diff（2）· diff 不再受
running 门控（1）。

### GUI 实测（真机 CDP，注入合成 transcript）

`t12b-screenshots/t12b-diff-light.png` · `t12b-diff-dark.png`：
行首读作 **`Edited src/greet.ts`**（切片 1 的动词修复在实机生效——改之前这里会是 `Ran`），
展开后 `+3 -3` 计数、红底删除行、绿底新增行、未变的 `}` 灰色，工具输出在下方。
LCS 正确把结尾的 `}` 判成公共行（3 删 + 3 增 + 1 同），没有把整段判成全改。

### 四门（切片 2 后）

typecheck 0 · biome 1054 文件 0/0 · **vitest 274 文件 5442 例**

### 仍未做

- read / grep / bash / ls 的结构化预览（本切片刻意不做，理由见上）。
- **真实回合未验**：截图用的是注入的合成 transcript，走真渲染路径，但没有真跑一次
  让模型自己发起 edit 的回合。
- 超长 diff（几百行）的性能与滚动未测；目前上限是 `max-h-72` 的滚动窗口。
