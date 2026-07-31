# D25 规格 · 编排者裁定（2026-07-30，已生效）

> 状态：三条裁定随第二轮 GUI 点验交付用户，**用户未异议 → 生效**（台账 2026-07-30 行「D25 §2.3 三处细化点用户本轮点验未异议 → 裁定 A 生效」）。
> 本文件原存 scratchpad，2026-07-30 晚 scratchpad 意外清空后由编排者凭上下文重写入库；规格正文同批抢救自会话 transcript，完整 637 行落于
> [`2026-07-30-d25-font-domain-design.md`](2026-07-30-d25-font-domain-design.md)。

## 裁定 1 · §2.3 三处口径细化点 → 采 A（对齐 Cursor）

侧栏分支 chip = sans 13 / Composer 分支下拉触发器 = sans 14 / 运行位置指示器 = sans 14。

依据：用户复议原话「我希望能做到 cursor 那种协调的美感」；参照图逐像素证明 Cursor 底栏分支就是比例字体；用户拍板的「等宽只留给代码/路径/分支/终端」按天花板（mono 不得溢出）而非地板（mono 必须覆盖）解读。
可逆性：三处各一个 class 字符串，翻回 B（全 mono 13px）为 5 分钟改动。

## 裁定 2 · §3.4 阅读栏 → 采 45rem（container token 方案）

`--container-reading: 45rem` / `--container-reading-wide: 60rem`，READING_COLUMN_CLASS 改
`max-w-reading` / `max-w-reading-wide`，同步改 shellLayoutModel.test.ts 四例。
依据：审计 E5 的 42rem 是估值，规格用 DPR 标定实测出 Cursor = 48 CJK 字/行 = 15px 下 720px = 45rem，证据等级更高。
不采零 token 降级方案（42rem 会比参照窄 3 字/行）。

## 裁定 3 · a09 新基线页 → 建

`docs/design/a09-font-domain-baseline.html`：三测点 × (mono/split/Cursor 参照) 三图并排。
A07 渲染层冻结后需要新的视觉凭证载体；同时充当工程规范第 10 条的对比报告。

## 施工注意（写进 T-30 批 2 规约）

- 规格锚定 HEAD `9a3fd86`，其后 T-19 全批 + T-30 批1 + 第二轮点验修复已落库
  （HEAD 已至 `b6149b9`，MessageTimeline/ToolRows/ChatComposer/globals.css 均被动过）——
  **规格里的 file:line 只作定位线索，施工前必须重新用内容匹配定位，禁止按行号盲改**。
- 施工序遵守规格 §5.5：① token → ⑥ 六条断言先落（A1~A6）→ ② 原语 → ②b argKind → ③ 域映射 → ④ chat 外复核 → ⑤ 基线文档。
- `stores/settings/index.ts:112` 死字段 `fontFamily: 'Inter'` 不接线不改值（规格 §1.4 ⚠️）。
- mono 元素禁 500/600 字重；`font-synthesis-weight: none` 落 `@layer base` html。
- 与 T-19 的文件交叠（ChatComposer / MessageTimeline / middleColumnLayout）：T-19 已全批落库，
  串行约束自动满足；T-30 批 2 与 composer 形态对齐（同批）合并施工时按形态规格的施工序编排。
