# 0820 FB 批规格 rev.1 —— 双轨双盲评审仲裁档

| 项 | 值 |
|---|---|
| 日期 | **2026-08-23**（2026-08-19 首次评审被推理网关 524 打断，本次为重跑） |
| 评审对象 | [`2026-08-19-fb-batch-spec.md`](./2026-08-19-fb-batch-spec.md) rev.1（1210 行） |
| 评审基线 HEAD | `347ab26b`（规格锚点基线 `99dfd78` 之后 34 个提交） |
| A 轨 | Opus，只读子代理，[`trackA-opus.md`](./2026-08-19-fb-batch-reviews/trackA-opus.md) —— 2 blocker · 8 major · 6 minor |
| B 轨 | Codex（`gpt-5.6-sol`，high effort，只读沙箱），[`trackB-codex.md`](./2026-08-19-fb-batch-reviews/trackB-codex.md) —— 1 blocker · 7 major · 2 minor |
| 同题任务书 | [`review-brief.md`](./2026-08-19-fb-batch-reviews/review-brief.md)（双盲，两轨互不可见） |
| 两轨判语 | **均为「修订后开工」** |
| 合取结果 | **3 blocker · 10 major · 7 minor ＝ 20 条修订项**，另 **1 条新增用户拍板项（Q14）** + **1 条开工前取证项** |

**合取规则**：并集取全，严重度取高，修法冲突时取保守（不作废任一轨已证事实的那一支）。

---

## §1 前置事实（两轨独立复核，一致）

- 【实测】`src/renderer/**` 自 `99dfd78` 起**零提交** ⇒ 渲染端锚点整体有效（A 轨抽验 60+ 条逐字全中，B 轨独立抽验一致）。
- 【实测】`src/agent-host/permissionBridge.ts` 与 `codexRuntime.ts` 同样零改动，FB7 取证链四跳仍成立。
- 【实测】阶段 4 打包链改过 `electron-builder.yml` / `scripts/**` / `package.json` ⇒ **凡涉及这三处的锚点全部失效或漂移**，两轨独立命中（见 C-2）。

---

## §2 互证条目（两轨独立命中同一问题 —— 证明力最高）

| # | 问题 | A 轨 | B 轨 | 合取严重度 |
|---|---|---|---|---|
| **C-1** | **G1 整行触发器 × D55 ① 合并成一行 ⇒ `<button>` 套 `<button>`** | #6 major | #1 **blocker** | **blocker**（取高） |
| **C-2** | `electron-builder.yml:64` 锚点已漂到 `:69`（`:64` 现为 cytoscape 排除） | #4 major | #10 minor | **major**（取高） |
| **C-3** | 片④ 影响面与收口清单没跟上阶段 4 打包链 | #4 后半 | #8 major | **major** |
| **C-4** | 全批基线「239 文件 / 4724 例」已过时（当前 245 文件） | #14 minor | #10 后半 | **minor** |
| **C-5** | 变异臂结构上咬不到 —— **M-12 两轨同判空转** | #3 major（M-06 / M-10 / M-12） | #4 major（M-12 / M-14） | **major**（并集四发） |
| **C-6** | hwm 的 hook 落点与纯函数合同互相矛盾，M-01 无靶子 | #9 major | #2 major | **major**（修法互补，全取） |
| **C-7** | FB9 断言面不足（A：无渲染级断言、`output:'mathml'` 无守卫；B：无数学输入攻击臂） | #8 major | #7 major | **major**（互补，全取） |

**C-1 的修法差异**（非实质分歧，形态细节）：A 主张「行尾独立 chevron 按钮，整行不是按钮，copy 并列」；B 主张「左侧状态区域是唯一触发按钮，footer 文本与 copy 为兄弟」。
**裁定取 A**：`spec:578` 原文 chevron 就在行尾，且可点区从整行缩到 24px 图标同时压掉 §5.3 ③ 担心的误触；B 的「单行容器不是按钮 + copy 是兄弟」这两条骨架约束一并采纳。
**B 独有的连带一条必须补上**：`spec:555-563` 的 DOM 骨架**至今仍写成两个兄弟节点**（`{head && <底部状态行/>}` + `<TurnFooter/>`），即 D55 ① 的拍板从未回灌施工正文 —— 这是 C-1 的根因，不只是触发器形态问题。

**C-5 的并集**：
- M-06（FB2 按钮改 hover-only）→ `[FB2-1]` 落 `chatTimelineLayout.test.ts`，该文件 `readFileSync` 零命中、读不到 `ChatCodeBlock.tsx` 源码 ⇒ 咬不到。
- M-10（FB3 引入滚动耦合）→ `[FB3-2]` 落点同上 ⇒ 咬不到。**它守的正是 F10 振荡回路复活**。
- M-12（answer 容器挂到 process 侧）→ `[FB4-2]` 是纯分段断言、`[FB6-1]` 是直接子元素顺序断言，挂点换边两者都不变 ⇒ 咬不到；真正能咬的 `[D3-7]` 重定义**没有进 §9.1 清单**。
- M-14（`collapsedLeavesNothing` 退化）→ `[FB4-5]` 只覆盖「全 process」与「含 text」，漏了恒可见的 `notice`；正确公式 `segments.every(s => s.kind === 'process')` 要求 `process + notice ⇒ false`。

---

## §3 单轨独有条目

### 3.1 A 轨独有（B 轨未命中）

| # | 严重度 | 摘要 |
|---|---|---|
| **A-1** | **blocker** | **§6.3 permission join 缺 `resolved === true` 守卫** —— `chatSessionsCore.test.ts:535-565` 坐实 `tool.started` 先于 `permission.requested` 落块且同 id 同 message ⇒ **未决**授权卡必然命中 join、被并成灰阶单行；而 `MessageTimeline.tsx:1578-1598` 是全仓唯一 Allow/Deny 交互面（`onRespondPermission` 仅此一个 UI 调用点）⇒ 用户无从应答，**回合永久挂起**，正撞 `chatTurn.ts:192-196` 安全红线。规格自称最重要的 `[FB7-4]` 守恒律**抓不到**（被并进 run 的未决 permission 仍「算一条」）。现成依据：`questionCardModel.ts:711` 的 `derivePermissionRowView` 早有 `if (block.resolved !== true) return null;` |
| **A-2** | **blocker** | **§4.5 C1/C3 把只有用户能行使的 D3-b 降级权写成施工方的点验分支** —— F456 `:1047-1049`/`:1928` 明文「施工方不得自行撤销 D3-b，只有用户能推翻」，该否决权已写进总台账 D50 行（`ledger.md:94`）且**至今未行使、仍然开着**（F456 `:1962`）。⇒ `spec:1204`「与总台账无一处冲突」不成立 |
| **A-5** | major | **E1 使 `disabled={permissionLock}` 变成死 prop，而 `messageTimelineWiring.test.ts:481-484` 仍会绿** —— 教科书式同名空壳，§13 ① 漏列。Base UI 的 `disabled` 只作用于它自己的 Trigger（`CollapsibleTrigger.js:45-49`），E1 把触发器换成 Root 之外的普通按钮后各 Root 里再无 Trigger |
| **A-7** | major | **D55 ③「常显低对比」与 §2.4「复用同一装配函数、不新写类串」互斥** —— `chatTimelineLayout.ts:170-172` 的 `turnCopyButtonClass()` 无任何不透明度档，逐字照 §2.4 做出来与 `TurnCopyButton` 对比度完全相同；且「低对比」全批**没有任何验收判据** |
| **A-10** | major | **「permission_request 与 tool_call 同 message」这条 join 前置条件从未被验证** —— 两者落块规则不同：`chatSessions.ts:702-713` 用事件显式 `messageId`，`:747-754` 取「最后一条非历史 assistant 消息」（事件里根本没有 messageId）。常见时序重合但**无结构保证**；一旦中途开新 assistant message，join 恒不中 ⇒ FB7 收益无声归零而 `[FB7-1]` 恒绿。§13 ② 把这条自评为「全批唯一已闭环」，实证的是「两个 id 相等」而非「两个 block 同 message」 |
| A-11 | minor | 「`ChatTurn` 的 JSX 子树从未进入任何 AST 断言」这条【实测】不成立 —— 另有全文件游走定位器 `jsxGuardedBy`（`:370-393`）已在 `[D3-7]` 里断过它的子树。**结论仍成立**，正确表述是「没有任何断言钉住其**直接子元素的顺序**」 |
| A-12 | minor | 三处锚点行号小偏：`chatTurn.ts:192`→`:185` · `ChatCodeBlock.tsx:57`→`:58` · mermaid 段 `:56-73`→`:61-77` |
| A-13 | minor | 五文件白名单符号名叫错：`FORBIDDEN_ON_PATH`（禁用构造表）→ 应为 `MARKDOWN_PATH_FILES`（`chatMarkdownPolicy.test.ts:989-995`）；连带须同步 `COMMENT_ONLY_PROSE`（`:1122-1128`，`Record` 类型，漏改即 typecheck 红） |
| A-15 | minor | §1.2 逐类结论表漏 CommonMark HTML block（类型 1–5 可跨空行），是 `spec:207`「所有行内语法都不能跨越空行」全称判断的真实反例；因本路径裸 HTML 恒转义为文本（`chatMarkdownPolicy.ts:745-746`），后果限于块包裹层数 ⇒ 登记为已知偏差即可 |
| A-16 | minor | `[FB4-1]` 的「`satisfies Record<…>` **或**逐成员」放行了约束不了函数体的写法（§4.2 把 `turnItemPlacement` 定义成函数）⇒ 选该支时 M-11 存活；§11.1 混面分析只算生产文件，漏了三份 `.test.ts` 各被两片触及；`spec:1007` 片③变异分配重复列了 M-12 |

### 3.2 B 轨独有（A 轨未命中）

| # | 严重度 | 摘要 |
|---|---|---|
| **B-3** | major | **FB6「先补钉子」的红绿顺序自相矛盾** —— `spec:924` 要求新断言「对着旧代码写、**跑绿**，再改代码看它红」，而 M-16（`spec:987`）明定同一条 `[FB6-1]` 对旧代码「**必须红**」。同一断言不能既绿又红。修法 = 拆三步：扩定位器 + 临时基线断言 `head-before-content`（旧码绿）→ 移动结构（基线断言红）→ 永久断言换 `content-before-meta-row`（绿）+ M-16 回退确认红 |
| **B-5** | major | **M-04 没有客观「红」判据，与「零跳过零存活」纪律不相容** —— `spec:975` 自认静态抓不到、发射半边仅 G-2 性能点验，而 G-2（`:1019`）只写「对比不分段实现的帧率」，无帧耗时/解析次数/退化比例阈值；`spec:1002-1003` 又要求全部变异零跳过零存活。工程规范 `docs/agent-project-engineering.md:174-175` 明定手工测试不能作为主要回归方式 |
| **B-6** | major | **FB9 打包地雷未真正闭环** —— ① `electron-builder.yml:10-11` 同时打包 `out/**/*` 与 `node_modules/**/*`，而 renderer 是独立 Vite 构建入口（`electron.vite.config.ts:90-107`）；KaTeX 的 JS/CSS/woff2 **很可能被 Vite 产入 `out/renderer`**，若如此则 `!node_modules/katex/**` 对公式与字体**均不起作用**，M-29 只是「让配置断言红」而非产品变异。② 字体退路（b）没有授权出口：`docs/design-system.md:648-665` 把随包字体定为独立资产/打包/许可证立项，而 `spec:885-886` 允许 G-10 不满意后**自动**转 HTML+字体，只要三处留痕 |
| **B-7** | major | **FB9 安全结论没有针对数学输入的运行时攻击臂** —— `[FB9-3]`/`[FB9-4]` 只做配置源码扫描；现有 F-C6 渲染安全组（`chatMarkdownRender.test.ts:189-235`）零数学输入，规格却直接判其「不受影响」。须补 `\href{javascript:…}` · `\includegraphics{https://…}` · `\htmlClass`/`\htmlStyle` · 解析失败时含 `<script>` 的源文本四臂 |
| B-9 | minor | §11.2 把**调度约束**写成了技术依赖：片①表项称「与全部片并行」（`:1058`），图（`:1064-1067`）却要求 `① ∥ ⑤` 全完成才进②；正文列出的真实依赖只有 `②→③`（kind 定案）与 `①→④`（消费切分函数）。要么改写依赖图，要么改称「推荐串行调度」 |

---

## §4 实质分歧与裁定（两条）

### D-1 · M-04 能否以「静态不可捕获、只靠 G-2 点验」收口

- **A 轨**：认可（已复核清单 #23，称其为「本批唯一静态不可捕获变异的诚实记账」）。
- **B 轨**：判 major，要求补确定性工作量断言，G-2 降为观感补充。

**裁定：采纳 B 轨。** 理由三条：① A 轨只是「认可这笔记账诚实」，并未反对补断言，两者不真冲突；② B 轨援引的 `docs/agent-project-engineering.md:174-175`（手工测试不得作为主要回归方式）是本仓成文规范，优先级高于单批便利；③ 成本低 —— 对固定追加序列统计「需重新解析的 segment 字符数/次数」，分段实现近线性，单一 `closedPrefix` mutant 必然超上限。
**落法**：M-04 增确定性工作量断言作为红/绿唯一裁决，G-2 保留为观感补充。

### D-2 · FB9 打包地雷的因果链

- **A 轨**（已复核清单 #8）：`electron-builder.yml:69` 的 `!node_modules/katex/**` 在 HEAD 上仍在，规格「不删则打包版公式静默失效」的判断成立。
- **B 轨**（#6）：该因果**未经证明**；renderer 走独立 Vite 构建，katex 资产很可能落在 `out/renderer` 而非 `node_modules`，若如此则该排除规则对公式与字体都不起作用。

**两轨在事实层不矛盾**（排除规则确实还在 `:69`），矛盾在「删不删是否真的决定公式存亡」——A 沿用了规格的因果假设，B 指出它没被证明。
**裁定：不二选一，改为开工前取证（E-1）。** 依赖装齐后先做一次构建，确认 KaTeX 的 JS/CSS/woff2 最终落在 `out/renderer`、`app.asar` 的 `node_modules`、还是别处；按真实产物位置决定 `[FB9-5]`/M-29 与 builder 改动的去留。

> ✅ **取证已于 2026-08-23 完成，判 B 轨成立、A 轨沿用的因果不成立**：katex 的 JS 被 Vite 完整打进产物，bundle 内零 `node_modules` 运行时引用；字体仅在引 katex CSS 时出现，且同样落在 `out/` 之下（lib 模式内联进 CSS，真实构建发成独立资产 —— 现成佐证 `out/renderer/assets/codicon-ngg6Pgfi.ttf`）。⇒ **该排除行与公式存亡无关**，保留不动。取证明细见[规格 §8.5-a](./2026-08-19-fb-batch-spec.md)。

---

## §5 rev.2 必须落实的修订清单（20 条）

**blocker（3，开工前必改）**
1. **A-1** §6.3 join 算法首行加 `resolved === true` 前置；补硬约束行「未决 permission 一律独立产出、不参与 join」；§9.1 加 `[FB7-8]`、§9.2 加 M-30。
2. **A-2** §4.5 C1/C3 的降级权改走 F456 §4.6 三步上报；§12.1 追加 **Q14**（用户拍板）；`spec:1204` 的「与总台账无一处冲突」改为「一处需上报」；§11.4 文档影响面加 F456 规格档。
3. **C-1** §5.2 DOM 骨架按 D55 ① 重写为**单条 meta 行**（容器不是按钮 / 行尾 chevron 为唯一触发按钮 / footer 文本与 copy 为兄弟）；§5.3 G1 行补形态硬约束；§9.1 加 `[FB6-5]`（copy 按钮不在触发器子树内，AST 断言）、§9.2 加 M-31。

**major（10）**
4. **C-5** M-06 / M-10 / M-12 / M-14 四发空转臂重接：`[FB2-1]`/`[FB3-2]` 落点由 `chatTimelineLayout.test.ts` 改 `messageTimelineWiring.test.ts` 源文扫描族；§9.1 补 `[FB4-7]`（重定义后的 `[D3-7]` 结构断言）并把 M-12 映射改指它；`[FB4-5]` 增 `process + notice ⇒ false` 与 `notice-only ⇒ false` 两臂。
5. **C-6** §1.2 定义纯状态转移函数 `advanceClosedPrefix(text, previousHwm) -> { hwm, segments, openTail }`（给 M-01 一个真靶子）；§1.5 改为抽 `TurnTextItem` 子组件承载 hook（禁止写进 `TurnItemView` 的 switch 分支）；§11.4 生产文件清单相应 +1；**补段容器 key 纪律**：取该段首个 item 的 `turnItemKey(items[0])`，不得用数组下标（否则流式期插段会重挂子树、hwm 归零，静态断言看不见）。
6. **C-2** §0.4 / §8.5 的 `electron-builder.yml:64` 改 `:69`，并改以**排除项原文**为主锚（行号为辅）。
7. **C-3** 片④ 影响面补 `pnpm-lock.yaml`、`scripts/__tests__/packaging-config.test.mjs`；`[FB9-5]` 落到该现有承重点；每片收口三件套补 `pnpm typecheck` + `pnpm lint` 串行绿。
8. **C-7 / A-8** §9.1 补 `[FB9-6]`（`rehype-katex` 配置必须含 `output: 'mathml'`）、`[FB9-7]`（全仓不出现 `katex/dist/*.css`、`src/**` 无新增 `@font-face`）、`[FB9-8]`（渲染级：`$$e=mc^2$$` 出 `<math`、无 `<script`、无 `katex-html`；`a $x$ b` 不出 `<math`）；§9.2 补 M-32 / M-33。
9. **C-7 / B-7** `chatMarkdownRender.test.ts` 新增数学输入安全组四臂，断言输出不含 `<a href>`/`<img>`/`src=`/网络 URL/raw HTML，并正向确认产生真实 `<math>`。
10. **A-5** E1 的新普通按钮必须自带 `disabled={permissionLock}`；各 `Collapsible.Root` 上的 `disabled` 属死 prop 必须删除；§13 ① 补该空壳行；§9.1 加 `[FB6-4]` 并把 `messageTimelineWiring.test.ts:481-484` 换钉。
11. **A-7** §2.4 类串行改为 `cn(turnCopyButtonClass(), <弱化档>)`（本体一字不动）；§2.3 末尾写死具体档位（按 `docs/design-system.md` Token 分档，**不得用任意值**）；`[FB2-1]` 补第三半；G-3 补「亮暗双主题常态可辨」判据。
12. **A-10** §6.2 逐跳表加第 ⑥ 跳（落块归属两套规则）；§6.3 明确 join 搜索域（放宽到同 turn 全部 assistant message，或补跨 message 夹具钉死退化行为）；§9.1 加 `[FB7-9]`；`spec:1172` 的「已闭环」改为「id 相等已闭环，同 message 归属未闭环」。
13. **B-3** §5.6 改成三步证据链（临时基线断言 `head-before-content` 旧码绿 → 移动结构变红 → 永久断言 `content-before-meta-row`），消除「同一断言既绿又红」。
14. **B-5**（裁定 D-1）M-04 补确定性工作量断言作为唯一红绿判据，G-2 降为观感补充。
15. **B-6**（裁定 D-2）§8.5 改为「开工前构建取证后再定」；字体退路（b）标为**阻塞 + 须另行取得立项/红线偏离授权**，删除「自动转」。

**minor（7）**：16. C-4 基线改为施工分支起点当场复取（当前 245 文件） · 17. A-11 措辞收窄为「直接子元素顺序」 · 18. A-12 三处行号更正 · 19. A-13 符号名改 `MARKDOWN_PATH_FILES` + 补 `COMMENT_ONLY_PROSE` 提醒 · 20. A-15 HTML block 登记为已知偏差 · 21. A-16 `[FB4-1]` 写死逐成员断言 + §11.1 补测试文件混面 + 删重复 M-12 · 22. B-9 依赖图与「推荐串行调度」二选一改写。
（编号 16–22 共 7 条，与上文 1–15 合计 22 个动作、对应 20 条修订项 —— C-7 拆成两个动作，C-1 含 B 独有的骨架回灌。）

---

## §6 §12.2 五条 —— 两轨结论合取（可直接收口，不必惊动用户）

| # | 合取结论 |
|---|---|
| **Q2** | **同意方向（hwm 用 `useRef`、不进 store），但推翻规格给的落点写法。** 两轨独立证明 `turnItemKey` 对 text 返回 `item.block.id` 且流式只追加 `text` ⇒ key 恒定，「须施工时实测」可直接标**已确认**，备案（上提到 `ChatTurn` 的 `Map`）不必启用。改为抽独立 `TurnTextItem`（两轨一致，B 轨援引 `MessageTimeline.tsx:1619-1627` 的既有「含 hook 分支拆独立组件」纪律）。A 轨追加的段容器 key 纪律一并采纳 |
| **Q8** | **同意本批不加小时档**（两轨一致）。A 轨补充：FB8 落地后该票影响面由 1 处变 2 处（`Worked for` + `Thought for`），另立票须写明同批点验两处 |
| **Q9** | **同意不启用行内 `$…$`**（两轨一致），但 `[FB9-2]` 的「块级选项开、行内选项关」口径**不可判定**（`remark-math` 主版本只有 `singleDollarTextMath`，语义是「行内是否接受单 `$`」而非关闭行内数学）⇒ 改为**行为断言**落 `chatMarkdownRender.test.ts`；配置项名按施工时实际版本填，维持「不发明选项名」纪律 |
| **Q12** | **同意取 E1**，两轨各自实读 Base UI 三锚点确认「一个 Root 只有一个 `panelId`」成立。**附加条件三条**：① A 轨的 `disabled={permissionLock}` 迁移与换钉（A-5）；② B 轨的稳定 `useId()` 前缀 + 「panel id 唯一、`aria-controls` 枚举恰好同集合」断言；③ A 轨的 `[FB6-6]`（`open={processShellOpen}` 出现次数 == process 段渲染点数），作为 G-15 的静态半边，别 100% 押在一张截图上 |
| **Q13** | **同意取 G1，但形态口径必须改**（两轨一致判定 rev.1 表述与 D55 ① 冲突）。终态 = **G1′**：单条 meta 行，整行不是按钮，行尾独立 chevron `<button aria-expanded aria-controls="…">` 为唯一触发器，footer 文本与 copy 按钮为同行兄弟。`spec:583-587` 第 3 项误触判据随之改写（可点区从整行缩到 24px 图标，误触风险反降） |

---

## §7 出口

### E-1 · 开工前取证（1 条，阻塞片④）
装齐 `remark-math` / `rehype-katex` / `katex` 后跑一次真实构建，确认 KaTeX 的 JS / CSS / woff2 最终落点（`out/renderer` vs `app.asar` 的 `node_modules` vs 其它）。**结论出来前 rev.2 不得把「删 `electron-builder.yml:69`」写成施工动作**（裁定 D-2）。

### E-2 · 需用户拍板（1 条新增）
**Q14 · C1「每段一容器」的碎片化是否可接受；不可接受时降级到 C3 还是撤 D3-b。**
判据 = G-6（3~5 个小边框盒堆叠的观感）。
**为什么必须问**：F456 §4.6 / 总台账 D50 行把这条否决权**明文保留给用户**（「施工方不得自行撤销 D3-b —— 它是用户在知情（设计员已反对）情况下的拍板，只有用户能推翻自己的拍板」），且该权利至今未行使、仍然开着。rev.1 把它写成了施工方的点验分支，属越权。

### E-3 · 下一步 —— ✅ **rev.2 已落（2026-08-23）**
§5 的 20 条**已逐条落实**，修订记录见 [规格 §14](./2026-08-19-fb-batch-spec.md#14-修订记录)（1210 → 1505 行）。
新增断言 14 条（`[FB1-5]`/`[FB1-6]`/`[FB4-7]`/`[FB6-0]`/`[FB6-4..7]`/`[FB7-8]`/`[FB7-9]`/`[FB9-6..9]`）、新增变异 6 发（M-30~M-35，总数 29→35）。
**剩余两个出口**：
- **E-1 取证**：✅ **已完成（2026-08-23），结论推翻了 rev.1 的因果** —— 两次最小独立 Vite 构建实测：MathML 路 katex JS 被完整打进 557 KB bundle、**零字体、零 `node_modules` 运行时引用**；HTML 路（引 katex CSS）源 24.7 KB CSS 涨到 1.46 MB，60 个字体全部内联，`url()` 无仓外残留。⇒ `!node_modules/katex/**` **与渲染无关**，`electron-builder.yml` 一字不动（保留只为不塞 1.2 MB 死文件）。`[FB9-5]` 换成**产物级**断言「产物中无 KaTeX 字体」（比源码扫描更强，直接把字体红线钉在产物层）；**M-29 退役**，由 M-33 顶替。详见[规格 §8.5-a](./2026-08-19-fb-batch-spec.md)。**片④ 不再阻塞。**
- **E-2 · Q14**：用户 2026-08-23 裁定 **「先按 C1 施工，等 GUI 出图后再定」** ⇒ 已按此写进规格 §12.1 Q14 与 §10 G-6；**片③ 出图后回来拍板**。
⇒ **rev.2 定稿，片① / 片⑤ 可开工**（两片都不依赖 Q14 与 E-1）。

---

## 附：本次评审与 2026-08-19 首跑的关系

2026-08-19 首次双轨评审因子代理推理网关 `api.vllmproxy.com` 持续 524 被打断三次（记录见 [主线台账](./ledger-claude-mainline.md) 2026-08-19 行），当时**零产出**。
本次为完整重跑，网关已恢复。规格自 rev.1 落库（`b330484`）以来一字未改，渲染端代码零改动 ⇒ 首跑的中断不影响本次评审的有效性。
