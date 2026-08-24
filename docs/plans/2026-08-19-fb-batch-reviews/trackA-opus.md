# A 轨（Opus） —— 0820 FB 批规格 rev.1 双盲评审

> 评审基线：当前 HEAD `347ab26b`（规格锚点基线 `99dfd78` 之后 34 个提交）。
> 【实测】`git diff --name-only 99dfd78..HEAD -- src/renderer` **零命中**（改动集中在 `src/agent-host` / `src/main` / `src/shared` / `scripts` / `.github`）
> ⇒ 渲染端锚点原则上仍有效（已抽验 60+ 条，见末尾清单）；
> `electron-builder.yml` / `scripts/**` / `package.json` 在阶段 4 打包链批次里大改，已逐条重实读。
> 本报告全部 `file:line` 均为我在当前 HEAD 上亲自 `awk`/`rg` 取出的原文，未沿用规格的引用。

---

## 判语

**修订后开工。** 规格的骨架是扎实的（FB1 的空行切分论证、FB7 的关联键取证链、§4.6 Base UI 单 panelId 硬约束三条锚点我都逐条实读复核过，全部成立），
但有 **2 条 blocker** 必须在开工前改掉：**§6.3 的 permission join 缺 `resolved === true` 守卫，会把未决授权卡并进工具行、抹掉全仓唯一的 Allow/Deny 入口**；
**§4.5 的 C1/C3 把只有用户能行使的 D3-b 降级权写成了施工方的点验分支，绕过 F456 §4.6/§10.4 的三步上报路径**。
另有 8 条 major 会导致返工或验收不成立，其中三发变异臂（M-06 / M-10 / M-12）按规格照做**结构上不可能被咬红**。

---

## 发现

### 1. **严重度：blocker｜规格节号：§6.3 / §6.5｜主张摘要：permission join 没有 `resolved` 守卫，未决授权卡会被并进工具行，全仓唯一的 Allow/Deny 入口消失，回合死锁**

**证据：**

规格 `docs/plans/2026-08-19-fb-batch-spec.md:679-682` 的算法逐字：

```
对每个 permission_request block P：
  找同一 message 内 id === P.permissionId 的 tool_call block T
  ├─ 命中 → P 的决议信息并入 T 所在的 run 行（不产出独立 item）
  └─ 未命中 → 原样产出独立的 { kind: 'permission' } item（＝今天的行为）
```

——**没有任何 `P.resolved === true` 前置条件**。

而【实测】`src/renderer/components/chat/MessageTimeline.tsx:1578-1598` 的 `case 'permission':` 分支是**交互式授权卡**，不是只读行：

```
1578	    case 'permission':
1583	        <QuestionCard
1584	          variant="permission"
1586	          canRespond={canRespondPermission(item.block.permissionId)}
1590	          onRespondPermission={(decision) =>
1591	            onRespondPermission(
```

【实测】`onRespondPermission` 在全仓**只有这一个 UI 调用点**（`rg 'onRespondPermission|respondPermission' src/renderer --include=*.tsx --include=*.ts`，去掉测试与 props 转发后只剩 `MessageTimeline.tsx:1590`）；
`ComposerPermissionTrigger.tsx` 是权限**档位**选择器（`composerPermissionModel.ts:1-3` 头注：`the Composer's LIVE permission control`），不是应答面；
`PendingQuestionDock.tsx` 只服务 question。

而未决 permission **必然命中 join 条件**：【实测】`src/renderer/stores/__tests__/chatSessionsCore.test.ts:535-565` 证明 `tool.started` 先于 `permission.requested` 落块、二者同 id 同 message：

```
535	  it('appends a permission_request block even when a tool_call block already shares its id', () => {
565	    expect(target?.blocks.map((block) => block.type)).toEqual(['tool_call', 'permission_request']);
```

⇒ 授权还在等用户时，tool_call block 已在同一 message 里，join 必中 ⇒ 卡片被并成一行灰阶文本 ⇒ **用户无从 Allow/Deny，回合永久挂起**。

这正撞既有安全红线【实测】`src/renderer/components/chat/chatTurn.ts:192-196`：

```
192	 * The unresolved-permission branch is a **separate, first return on purpose**:
193	 * it is the safety red line (burying an authorization card inside a collapsed
194	 * shell re-opens round-2 point-check #5, "the permission card does not
195	 * render"), and it must stay un-overridable by any rule added below it
```

且规格自称「本件最重要的一条断言」的 `[FB7-4]` 守恒律（`spec:956`：「输出中 permission 信息条数**恒等于**输入 permission block 条数」）**抓不到它** —— 被并进 run 的未决 permission 仍然「算一条」，守恒律绿。
`[FB4-6]` / `hasUnresolvedPermission`（`chatTurn.ts:214-216`）只保证折叠壳被强制展开，展开后里面什么也没有。

**建议修法：**
把 `spec:679-682` 的算法首行改为「**对每个 `resolved === true` 的 permission_request block P**」，并在其下补一条硬约束行：
「**`resolved !== true` 的 permission 一律原样产出独立 `{ kind: 'permission' }` item，不参与 join** —— 它是全仓唯一的 Allow/Deny 交互面（`MessageTimeline.tsx:1578-1598`），合并即等于删除它。」
依据现成：`questionCardModel.ts:711` `derivePermissionRowView` 已有 `if (block.resolved !== true) return null;`，D28 的单行形态本来就只覆盖已决态。
同时 §9.1 追加 `[FB7-8]`：**未决 permission（`resolved` 缺省/false）必产出独立 permission item，且不被任何 toolGroup 吸收**；§9.2 追加 M-30「join 忽略 `resolved`」→ 应红 `[FB7-8]`。

---

### 2. **严重度：blocker｜规格节号：§4.5 / §10 G-6｜主张摘要：C1/C3 把只有用户能行使的 D3-b 降级权写成施工方的点验分支，绕过 F456 §4.6/§10.4 的三步上报路径，文末「与总台账无一处冲突」因此不成立**

**证据：**

规格 `spec:515`：

> **备选 C3**（**仅在点验判定 C1 碎片化不可接受时启用**）：仅当整个回合**只有一个 answer 段**时挂容器，多段时全部裸奔。

`spec:1023`（G-6）：

> **FB4-C1 的碎片化风险**：3~5 个小边框盒堆叠是否可接受。**若不可接受 ⇒ 启用备选 C3**

但【实测】这条降级权在地基批里是**明文保留给用户的**：

`docs/plans/2026-08-18-f456-readability-composer-spec.md:1039`（§4.6 触发条件①，与 G-6 判据逐字同义）：

> 1. GUI 点验截图显示容器边框与内层叶子框在视觉上仍构成「框中框」的压迫感；

同档 `:1047-1049`：

> 3. 由**用户拍板**是否降级为「只留 D3-c、撤 D3-b」或改走候选 A/C。
>    **施工方不得自行撤销 D3-b**——它是用户在知情（设计员已反对）情况下的拍板，
>    只有用户能推翻自己的拍板。

同档 `:1928`（§10.4 禁止动作）：

> - **禁止动作**：施工方**不得自行撤销 D3-b**，也不得"折中"成 `bg-muted` 版

同档 `:1962`（§11 as-built 实录，说明该权利**至今未行使、仍然开着**）：

> - **§4.6 否决权终态**：未撤销未折中；条件②当场证否（720→690px 朝最优行长靠拢）；条件①③连同…移交 GUI 点验

且这条保留写进了总台账：`docs/plans/openchamber-chat-refactor-ledger.md:94`（D50 行）逐字：

> **D3-c 与 D3-b 并用**（设计员明示反对后用户坚持，**实现方否决权保留：§4.6 三条件**，静态可判的「阅读宽度净损」施工时证否，余两条待 GUI）

而代码头注也把「一容器一回合」记成用户裁定：【实测】`src/renderer/components/chat/chatTimelineLayout.ts:174-176`：

```
174	/**
175	 * The assistant's answer segment: one neutral container per turn (F5 D3-b,
176	 * user decision 2026-08-18).
```

规格全文 `grep '否决权\|§4.6 三条件\|D3-b'` 对 FB 规格**零命中**（只有 `:12` 提到 D50 批次边界），§12.1「需用户拍板」六条里也没有 C1/C3。
因此 `spec:1204`「⚠️ 本规格已逐条核对，**与总台账无一处冲突**」不成立。

**建议修法：**
① `spec:515` 的「仅在点验判定 C1 碎片化不可接受时启用」改写为：「G-6 判定不可接受时**不得由施工方自行切 C3**，必须走 F456 §4.6 三步上报（施工分支对照截图 → 该规格追加 §4.6-a 实作否决记录 → **由用户拍板**降级方案）」；
② §12.1「需用户拍板」表追加一行 **Q14：C1（每段一容器）是否可接受、不可接受时降级到 C3 还是撤 D3-b**，判据 = G-6；
③ `spec:1204` 的「与总台账无一处冲突」改为「与总台账一处需上报：D50 保留的 D3-b 否决权，见 §4.5 / Q14」；
④ §11.4 文档影响面追加 `docs/plans/2026-08-18-f456-readability-composer-spec.md`（若触发否决则需回填 §4.6-a）。

---

### 3. **严重度：major｜规格节号：§9.2｜主张摘要：M-06 / M-10 / M-12 三发变异与其映射断言结构上对不上，按规格照做必然存活；§4.5 要求重定义的 `[D3-7]` 没有进 §9.1 清单**

**证据：**

**(a) M-12 是空转臂。** `spec:983`：

> | M-12 | answer 容器挂到 process 段一侧 | `[FB4-2]` + `[FB6-1]` |

`[FB4-2]`（`spec:945`）是**纯模块**断言：「`segmentTurnBody` 保序 + run-length：`[text, tool, text, tool, text]` ⇒ 5 段且 kind 序列为 `answer/process/answer/process/answer`」——
把容器 className 挂到 process 段那一侧是 `.tsx` 的挂点改动，`segmentTurnBody` 的返回值一字不变 ⇒ 咬不到。
`[FB6-1]`（`spec:950`）断的是「`ChatTurn` 的 direct-child 顺序：band → 内容段 → head → `TurnFooter`」——挂点换边不改直接子元素的个数与次序 ⇒ 也咬不到。
真正能咬的是 §4.5 连带要求重定义的 `[D3-7]`（`spec:520`：「`messageTimelineWiring.test.ts:717-725` `[D3-7]` 的 `countIn(…, 'turnAnswerContainerClass()') === 1` 语义要从「源码里出现一次」改成「只挂在 answer 段上」的结构断言」），
但 §9.1 的 29 条新增断言清单（`spec:936-966`）里**没有 `[D3-7]` 这一条**。
【实测】现行 `[D3-7]` 的定位工法是有的：`src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:717-725`

```
717	  it('[D3-7] the assistant container is mounted on the answer segment, exactly once', () => {
718	    const answerSegment = jsxGuardedBy('answer.length > 0');
719	    expect(classNameExpressionOf(answerSegment)).toBe(
720	      '{cn(turnBodyClass(), turnAnswerContainerClass())}'
```

**(b) M-06 是空转臂。** `spec:977` 映射 `[FB2-1]`，而 `[FB2-1]`（`spec:938`）落点是 `chatTimelineLayout.test.ts`。
【实测】`src/renderer/components/chat/__tests__/chatTimelineLayout.test.ts:1-18` 只 import 纯类装配函数，`grep 'readFileSync'` **零命中** ⇒ 读不到 `ChatCodeBlock.tsx` 的源码。
M-06「FB2 按钮改 `opacity-0 group-hover:opacity-100`」若写成 `cn(turnCopyButtonClass(), 'opacity-0 group-hover:opacity-100')`，`turnCopyButtonClass()` 返回串不变 ⇒ 既有 `:239-243` 与 `[FB2-1]` 全绿：

```
239	  it('F-B15: the copy button is never hover-only', () => {
240	    const cls = turnCopyButtonClass();
241	    expect(cls).not.toContain('opacity-0');
```

（顺带：`[FB2-1]` 的后半「该串仍不含 `opacity-0` / `group-hover:`」与 `:239-243` **完全重复**，是零增量断言。）

**(c) M-10 是空转臂，而它守的是 F10 振荡回路。** `[FB3-2]`（`spec:942`）落点写「同上」= `chatTimelineLayout.test.ts`，但它要断的是「`UserBubble` **函数体内**该调用的实参标识符不出现 `pinned`/`stuck`/`scroll`/`intersect` 词根」——同样读不到源码。

**建议修法：**
- §9.1 追加 `[FB4-7]`：重定义后的 `[D3-7]`（结构断言：`turnAnswerContainerClass()` 只出现在 `kind === 'answer'` 段的 className 里），落 `messageTimelineWiring.test.ts`；`spec:983` 的 M-12 映射改为 `[FB4-7]`。
- `spec:938` 把 `[FB2-1]` 落点改为 `messageTimelineWiring.test.ts` 同族的**源文扫描**（需新增对 `ChatCodeBlock.tsx` 的投影），断言内容改为「`ChatCodeBlock.tsx` 内 copy 按钮的 className 表达式含 `turnCopyButtonClass()` 且**整份文件**不出现 `opacity-0` / `group-hover:`」。
- `spec:942` 的 `[FB3-2]` 落点由「同上」改为 `messageTimelineWiring.test.ts`（该文件已有 `SYNTAX` / `CALL_SITES` 两套 MessageTimeline.tsx 投影，`:120-141` 有现成工法）。

---

### 4. **严重度：major｜规格节号：§0.4 / §8.5 / §11.3｜主张摘要：`electron-builder.yml:64` 锚点已漂到别的规则上，照字面「删第 64 行」会删掉 cytoscape 排除且 katex 仍被裁；片④ 的 scoped vitest 漏了 HEAD 上新增的唯一可落点**

**证据：**

规格 `spec:165`（§0.4 锚点总表，且 electron-builder.yml 被放在「**低漂移**纯模块」表里，不享受「行号只是索引」的豁免）：

> | `electron-builder.yml` | `:64` | `- "!node_modules/katex/**"` | §8.5 **地雷** |

`spec:900`：

> **裁定：本片必须删除 `electron-builder.yml:64` 那一行**

【实测 HEAD `347ab26b`】`electron-builder.yml` 真实内容：

```
61	  # Mermaid and its heavy dependencies (~60MB total) - loaded from CDN at runtime
64	  - "!node_modules/cytoscape/**"
69	  - "!node_modules/katex/**"
77	  - "!node_modules/dompurify/**"
```

⇒ `:64` 现在是 cytoscape；katex 在 `:69`；`spec:890` 说的「mermaid 段 `:56-73`」实为 `:61-77`。
照字面执行会删错行：katex 仍被裁（打包版公式静默失效，正是该节要拆的雷），同时静默删掉一条 cytoscape 规则。
`[FB9-5]` 会因残留的 katex 行变红从而暴露前半，但删错的 cytoscape 行**没有任何断言看着**。

另：【实测】HEAD 上新增了 `scripts/__tests__/packaging-config.test.mjs`（`:17-18` `readFileSync(path.join(repoRoot, 'electron-builder.yml'))` + `yaml.load`），它是 `[FB9-5]`（`spec:966`「新增（构建配置侧）」）唯一现成的落点；
`vitest.config.ts:13` `include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']` 已覆盖它。
但 `spec:1089` 片④ 的 scoped vitest 只列 `chatMarkdownRender.test.ts` · `chatMarkdownPolicy.test.ts`，`spec:1098` 的测试影响面 10 份也没有它 ⇒ 片④ 收口跑不到自己改的构建配置。

**顺带一条对规格裁定的加强证据**：该文件在阶段 4 新增了一条同向纪律，`electron-builder.yml:50-54`：

```
50	  # dependencies. Do NOT add exclusions for agent CLI packages that are not root
51	  # dependencies — a rule that can never match reads as evidence that the
52	  # package IS a root dependency, which is how the previous Codex rule survived
53	  # for so long.
```

【实测】`node_modules/katex`、`node_modules/mermaid`、`node_modules/cytoscape`、`node_modules/d3`、`node_modules/elkjs`、`node_modules/langium` **全部不存在**，`package.json` 里 `mermaid|katex|cytoscape` 零命中 ⇒ 整个 mermaid 段（`:61-77`）今天全是「永远匹配不到的规则」，正是这条头注点名的反模式。

**建议修法：**
- `spec:165` 改为 `| \`electron-builder.yml\` | \`:69\`（HEAD 347ab26b 复取；`:64` 现为 cytoscape） | ... |`；`spec:890` 的 `:56-73` 改为 `:61-77`；
- `spec:900` 改为「**按原文 `- "!node_modules/katex/**"` 定位删除**（不得按行号盲删），并在同处补注释说明 katex 现为 FB9 直接依赖」；
- `spec:966` 的 `[FB9-5]` 落点写死为 `scripts/__tests__/packaging-config.test.mjs`，断言用 `builderYml.files`（已解析的 YAML）而非行号；
- `spec:1089` 片④ scoped vitest 追加 `scripts/__tests__/packaging-config.test.mjs`；`spec:1098` 测试影响面由 10 份改 11 份。

---

### 5. **严重度：major｜规格节号：§4.6 E1 / §13 ①｜主张摘要：E1 使 `disabled={permissionLock}` 变成死 prop，而既有断言仍会绿 —— 教科书式的同名空壳，§13 ① 漏列**

**证据：**

【实测】今天的强制展开是**双保险**：`src/renderer/components/chat/MessageTimeline.tsx:1259-1265`

```
1259	          <Collapsible
1260	            open={processShellOpen}
1261	            onOpenChange={setProcessOpen}
1262	            disabled={permissionLock}
1265	            <CollapsibleTrigger className={cn(turnHeadClass(), 'w-full disabled:cursor-default')}>
```

Base UI 的 `disabled` 只作用于**它自己的 Trigger**：【实测】`node_modules/@base-ui/react/collapsible/trigger/CollapsibleTrigger.js:45-49`

```
45	  } = (0, _useButton.useButton)({
46	    disabled,
47	    focusableWhenDisabled: true,
```

而 `spec:533` 的 E1 明文把触发器换成 Root 之外的普通按钮：

> **E1（主推）** | 每个 process 段一个**受控** `Collapsible`（…）；底部状态行做成普通 `<button aria-expanded aria-controls="id1 id2 …">`

⇒ 各 Root 里再没有 Trigger，`disabled={permissionLock}` 成为**没有任何作用的 prop**。
但既有断言只看字符串，会继续绿：【实测】`src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:481-484`

```
481	  it('the permission lock still forces the shell open and disables its trigger', () => {
482	    expectWired('permissionLock || processOpen');
483	    expectCalled('disabled={permissionLock}');
```

`spec:1155` 的 §13 ① 只把 `messageTimelineWiring.test.ts:481-484` 列在「`processOpen` / `collapsible` 变量名承袭…**语义扩为「所有可折叠项」时**一并改名（连带换钉）」这条**条件句**下，没有把「prop 变死、断言仍绿」识别出来。
（`spec:533` 声称 E1「测试 `messageTimelineWiring.test.ts:472-477` / `:575-577` 继续绿」——这两条我复核**属实**：`:475-476` 的 `<CollapsibleContent` + `keepMounted` 与 `:576` 的 `cn(turnProcessPanelClass(), turnBodyClass())` 在 E1 下都还在。漏的是 `:481-484` 这一条。）

**建议修法：**
在 `spec:533` 的 E1 行补一句硬约束：「新的普通 `<button>` 必须自带 `disabled={permissionLock}`（或 `aria-disabled` + 阻断 onClick）；各 `Collapsible.Root` 上的 `disabled` 属于死 prop，**必须删除**」；
§13 ① 表追加一行：「`disabled={permissionLock}`（`MessageTimeline.tsx:1262`）在 E1 下失效而 `messageTimelineWiring.test.ts:483` 仍绿 ⇒ 断言必须换钉到新按钮上」；
§9.1 追加 `[FB6-4]`：底部触发器按钮带 `disabled={permissionLock}`，并把 `:481-484` 的 `expectCalled` 改指该按钮。

---

### 6. **严重度：major｜规格节号：§5.3 G1 × D55 ①｜主张摘要：拍板「底部状态行与 TurnFooter 合并成一行」之后，G1 的整行触发器会把 copy `<button>` 嵌进触发器 `<button>` —— 非法嵌套 + a11y 破，rev.1 未回填这个后果**

**证据：**

D55 ①（`spec:1210`，不可复议）：

> Q4 = **底部状态行与 TurnFooter 合并成一行**（用户拍板）

`spec:1112`（Q4 的形态描述）：

> （左：`Worked for 1m 6s · 3 tools`，右：`3h ago` + copy）

G1（`spec:578`）：

> **G1（主推）** | 触发器 = **底部状态行本身**（chevron 在行尾），所有 process 段受它统一控制

【实测】copy 是一个真的 `<button>`：`src/renderer/components/chat/MessageTimeline.tsx:1730-1738`

```
1730	    <button
1731	      type="button"
1732	      className={turnCopyButtonClass()}
1733	      onClick={() => void handleCopy()}
1735	      title={label}
1737	      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
```

挂点：`:1696` `{copyText.length > 0 && <TurnCopyButton text={copyText} />}`，父级是 `:1685` `<div className={turnFooterClass()}>`。

合并后「整行 = 触发器 `<button>`」且「行内右侧 = copy `<button>`」⇒ `<button>` 嵌 `<button>`：HTML 非法（React 会报 validateDOMNesting）、键盘 Tab 序与点击目标都坏。
`spec:578` 的代价栏只写了「触发器与 `TurnFooter` 相邻，**误触**概率上升」——那是**未合并**前提下的判断；D55 ① 之后它从「相邻误触」升级为「嵌套非法」，rev.1 没有回填。
今天的 `CollapsibleTrigger`（`:1265-1275`）里只有 `TurnHeadContent` 与 chevron，**没有嵌套按钮**，所以这是本批新引入的问题。

**建议修法：**
在 §5.3 G1 行补一条形态硬约束：「**合并行整体不得是 `<button>`**；触发器落在行内一个独立的 chevron 按钮上（或整行用 `<div role="button">` 但把 copy 按钮移出该行）」，
并把 §5.2 的 DOM 骨架示意（`spec:557-564`）改成合并后的真实形状；
§9.1 追加 `[FB6-5]`：底部合并行的源码里 copy 按钮**不在**触发器元素的子树内（AST 断言，`messageTimelineWiring.test.ts` 的 `jsxChildrenOf` `:243-256` 可直接用）；
§9.2 追加 M-31「把 copy 按钮塞进触发器」→ 应红 `[FB6-5]`。

---

### 7. **严重度：major｜规格节号：§2.3 / §2.4 × D55 ③｜主张摘要：「复用同一个类装配函数、不新写类串」与拍板「常显低对比」互斥，且「低对比」没有任何验收判据**

**证据：**

D55 ③（`spec:1210`，不可复议）采纳的是 §12.1 Q3 的建议原文（`spec:1116`）：

> 常驻，但**可降低常态不透明度到仍可辨档位** + `focus-visible` 增强

`spec:326` 同义：

> 若评审坚持要弱化视觉存在感，**唯一允许的做法**是**降低常态不透明度**到仍可辨的档位并配 `focus-visible` 增强

但 §2.4 的复用表（`spec:337`）说的是完全复用、零新类：

> | 类串 | `turnCopyButtonClass()` = `'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover'` | ✅ **复用同一个类装配函数**，不新写类串 |

【实测】`src/renderer/components/chat/chatTimelineLayout.ts:170-172` 该函数返回串确实已含 `text-muted-foreground`，**没有任何不透明度档**：

```
170	export function turnCopyButtonClass(): string {
171	  return 'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover';
```

⇒ 逐字照 §2.4 做出来的按钮与 `TurnCopyButton` **对比度完全相同**，兑现不了 D55 ③ 的「低对比」；
要兑现就必须加类（`opacity-*` 或另一档 token），又与「不新写类串」冲突，而 `[FB2-1]`（`spec:938`）也测不到「低到什么档才算数」。
规格全文没有任何一条断言或点验项定义「低对比」的验收判据（§10 G-3 只验按钮位置与 `Check` 反馈）。

**建议修法：**
§2.4 的类串行改为：「**装配方式**复用 `turnCopyButtonClass()`，外加一档常态弱化（D55 ③）——写成 `cn(turnCopyButtonClass(), <弱化档>)`，`turnCopyButtonClass()` 本体一字不动」；
在 §2.3 末尾写死具体档位（建议 `text-muted-foreground/70` 或 `opacity-70` 二选一，随 `docs/design-system.md` 的 Token 分档定，**不得用任意值**）并说明 `focus-visible` 增强怎么写；
`[FB2-1]` 补第三半：断言 `ChatCodeBlock.tsx` 中该按钮的 className 表达式含该弱化档且**不含** `opacity-0`；G-3 补一条判据「亮暗双主题下按钮常态可辨」。

---

### 8. **严重度：major｜规格节号：§8.2 / §8.4 / §9.1｜主张摘要：FB9 全批没有一条渲染级断言，`output: 'mathml'` 这条守着字体红线的裁定没有任何自动化守卫，而 node 环境本来就能渲染判定**

**证据：**

`spec:885`（§8.4 (a) 路，规格的优先裁定）：

> **（a，优先）** | `rehype-katex` 传 **`output: 'mathml'`**，走 Chromium 原生 MathML 渲染 ⇒ **不需要 KaTeX 字体**

`spec:869`（红线原文，我已复核逐字成立于 `src/renderer/styles/globals.css:81-84`）：

```
81	   *  4. No bundled webfont: this repo has no @font-face and no font assets;
82	   *     naming a non-system family here is a blank cheque (design-system red
83	   *     line), and a bundled Latin face paired with a system CJK face reads
84	   *     worse than the OS's own co-designed pair.
```

【实测】全仓 `rg '@font-face' src/` 只命中上面这行注释本身 ⇒ 规格 `spec:878`「该红线至今零例外，且没有自动化守卫」属实。

但 §9.1 的五条 `[FB9-1..5]`（`spec:962-966`）全是 policy 卡片比对与源文扫描，**没有一条钉住 `output: 'mathml'`，也没有一条禁止 `import 'katex/dist/katex.min.css'`**；
§9.2 的 M-26~M-29（`spec:997-1000`）同样没有一发针对 output 模式。
⇒ 有人把 `output` 去掉（回到默认 `htmlAndMathml`）并顺手引入 katex.css，全批 vitest 全绿，红线被静默突破，只能靠 G-10 一张截图发现。

同时【实测】本仓在 node 环境**已经能做渲染级断言**：`src/renderer/components/chat/__tests__/chatMarkdownRender.test.ts:1-29`

```
  1	import { createElement, type ReactElement } from 'react';
  2	import { renderToStaticMarkup } from 'react-dom/server';
 27	function render(markdown: string): string {
 28	  return renderToStaticMarkup(createElement(ChatMarkdown, { text: markdown }));
```

`:189-196` 的 F-C6 已经用它验证「裸 HTML 转义而非丢弃」。
⇒ `spec:847`「§8.2 ④ `rehype-katex` 不走 raw 节点路径」标为【推测，须施工时验证】其实**不必推迟到施工期**：一条 `render('$$e=mc^2$$')` 就能当场判定输出里有 `<math` 且无 `<script` / 无 `dangerouslySetInnerHTML` 痕迹。

**建议修法：**
§9.1 追加三条：
- `[FB9-6]`（源文扫描）：`rehype-katex` 配置对象**必须**含 `output: 'mathml'`（与 `[FB9-3]` 的「不出现 `trust`/`macros`」同处）；
- `[FB9-7]`（源文扫描，落 `fontDomainScan.test.ts` 同族）：全仓 `src/**` 与 `package.json` 的入口不出现 `katex/dist/*.css`，且 `src/**` 无新增 `@font-face`；
- `[FB9-8]`（`chatMarkdownRender.test.ts`）：`render('$$e=mc^2$$')` 输出含 `<math`、不含 `<script`、不含 `katex-html`（后者即 HTML 输出路径的指纹）；`render('a $x$ b')` 输出**不含** `<math`（兑现 §8.6 行内关闭）。
§9.2 追加 M-32「去掉 `output: 'mathml'`」→ 应红 `[FB9-6]` + `[FB9-8]`；M-33「引入 katex.min.css」→ 应红 `[FB9-7]`。

---

### 9. **严重度：major｜规格节号：§1.5 / §11.4｜主张摘要：规格把 `useMemo`/`useRef` 指定落在 `TurnItemView` 的 `switch` 分支内，违反 React Hooks 规则；正解要抽子组件，而 §11.4 的 12 份生产文件没为它留位置**

**证据：**

`spec:269`：

> **结论：纯函数 + `useMemo(…, [text])` **落在 `TurnItemView` 的 `text` 分支内**；hwm 用 `useRef`；一律不进 store、不新增 `ChatTurn` prop。**

【实测】`TurnItemView` 是一个 `switch` + 早返回的多分支函数组件：`src/renderer/components/chat/MessageTimeline.tsx:1523-1565`

```
1523	function TurnItemView({
1531	}: TurnItemViewProps) {
1532	  switch (item.kind) {
1555	    case 'text': {
1556	      const text = item.block.text ?? '';
1557	      if (shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })) {
1558	        return <ChatMarkdown text={text} />;
1559	      }
```

把 hook 写进 `case 'text':` 是条件调用 hook。今天恰好不会在运行期炸，只是因为【实测】`turnItemKey`（`:1415-1423`）给不同 kind 发不同 key（`toolGroup` → `${messageId}~group-${blockIndex}`、`notice` → `${messageId}~notice`、其余 → `item.block.id`），
使同一实例的 `item.kind` 不会变——**这是一条不该被依赖的隐性不变量**，而且它正是 FB7 会动的东西（合并后 permission item 消失、key 组成变化）。

正解是抽一个 `TurnTextItem` 子组件（hook 在其顶层），但 `spec:1096` 的「生产代码（12 份）」清单里没有它，§11.2 片④ 的工作量也没算这笔。

**建议修法：**
`spec:269` 改为：「新增 `TurnTextItem` 子组件承载 `useMemo(…, [text])` 与 hwm 的 `useRef`，由 `TurnItemView` 的 `text` 分支渲染 `<TurnTextItem key 不变 …/>`；**hook 一律在该子组件顶层调用，不得写进 `TurnItemView` 的 switch 分支**」；
§11.4 生产代码清单由 12 份改为「12 份 + `MessageTimeline.tsx` 内新增 `TurnTextItem`」；
`[FB1-4]`（`spec:940`）的扫描范围由「`TurnItemView` 的 text 分支内」改为「`TurnTextItem` 函数体内」。

---

### 10. **严重度：major｜规格节号：§6.2 / §6.3 / §13 ②｜主张摘要：「permission_request 与 tool_call 落在同一 message」这条 join 的前置条件从未被验证，两者的落块规则实际不同；§13 ② 的「已闭环」自评过宽**

**证据：**

`spec:681` 的 join 限定在「**同一 message 内**」，`spec:689` 的冲突处理也建立在「同一 message 内 id 唯一」上。
【实测】两类 block 的落块目标是**两套不同规则**：

`src/renderer/stores/chatSessions.ts:702-713`（tool_call → **事件显式指定的 messageId**）：

```
702	    case 'tool.started': {
703	      const bucket = state.messages[sessionId] ?? [];
704	      const existing = bucket.find((item) => item.id === event.payload.messageId);
705	      if (!existing) {
706	        return {};
713	            id: event.payload.toolCallId,
```

`src/renderer/stores/chatSessions.ts:747-754`（permission → **最后一条非历史 assistant 消息**，事件里根本没有 messageId）：

```
747	    case 'permission.requested': {
749	      const existing = [...bucket]
750	        .reverse()
751	        .find(
752	          (item) => item.role === 'assistant' && !item.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
753	        );
754	      const messageId = existing?.id ?? `msg-perm-${event.payload.permissionId}`;
```

⇒ 两者在常见时序下重合（`chatSessionsCore.test.ts:535-565` 的单消息夹具证明了这一点），但**没有结构保证**：
一旦 tool_call 之后又开了一条新的 assistant message，permission 会落到**新的那条**上，而 tool_call 留在旧的 ⇒ join 恒不中；
`existing` 为空时更是落到合成的 `msg-perm-…` 消息里，那里永远没有 tool_call。
后果是「静默退回今天的两行形态」——安全（授权记录不丢），但 FB7 的收益在这些场景下**无声归零**，而且 `[FB7-1]`（同 message 夹具）会一直绿。

而 `spec:1172`（§13 ② 生产者缺席自查）把这一条写成了全批唯一的「已闭环」：

> **FB7 关联键的生产者** | ✅ **已实证**：…这是本批唯一一条**已闭环**的生产者验证

实证的是「**两个 id 相等**」，不是「**两个 block 同 message**」——后者才是 §6.3 算法的前置条件。

**建议修法：**
§6.2 的逐跳表追加第 ⑥ 跳：「落块**归属**（`chatSessions.ts:702-704` vs `:747-754`）—— 二者规则不同，同 message 不是结构保证」；
§6.3 算法加一句：「join 的搜索域可放宽到**同一 turn 的全部 assistant message**（`flattenTurnItems` 已按 turn 聚合，`chatTurn.ts:148` 逐 message 调 `groupTimeline`），或在 `[FB7-1]` 之外补一条**跨 message 夹具**断言其退化行为」；
§9.1 追加 `[FB7-9]`：permission 与 tool_call 分处同一 turn 的两条 message 时的行为被显式钉住（合并 or 回落，二选一写死）；
`spec:1172` 的「已闭环」改为「id 相等已闭环；**同 message 归属未闭环**，见 `[FB7-9]`」。

---

### 11. **严重度：minor｜规格节号：结论先行 4 / §5.6｜主张摘要：「`ChatTurn` 的 JSX 子树从未进入任何 AST 断言」这条【实测】不成立（结论仍成立，措辞须收窄）**

**证据：**

`spec:28` 与 `spec:624` 逐字：

> `ChatTurn` 是 `memo(function ChatTurn…)`，而 `messageTimelineWiring.test.ts` 的定位器只认 `ts.FunctionDeclaration`，**其 JSX 子树从未进入任何 AST 断言**

前半我复核**成立**：`src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:272-279`

```
272	function topLevelFunction(fnName: string): ts.FunctionDeclaration {
273	  const fn = sourceFile.statements.find(
274	    (statement): statement is ts.FunctionDeclaration =>
275	      ts.isFunctionDeclaration(statement) && statement.name?.text === fnName
```

但后半不成立：同文件另有一个**全文件游走**的定位器，`:370-393`

```
370	function jsxGuardedBy(guard: string): JsxNode {
392	  ts.forEachChild(sourceFile, walk);
```

它已经在 `[D3-7]`（`:717-721`）里对 `ChatTurn` 内部的 `answer.length > 0 && <div className={cn(turnBodyClass(), turnAnswerContainerClass())}>` 做了 AST 断言。
真正成立的表述是：**没有任何断言钉住 `ChatTurn` 直接子元素的顺序**（这一点我逐条查过 `messageTimelineWiring.test.ts` 全文，`children[0]`/`children[1]` 顺序断言只出现在 `[D3-8]`（`:701-705`）里，目标是 `UserBubble`）。§5.6 的结论与处置不受影响。

**建议修法：** `spec:28` 与 `spec:624` 的「其 JSX 子树从未进入任何 AST 断言」改为「**其直接子元素的顺序从未进入任何 AST 断言**（`jsxGuardedBy` 能游走进它的子树，`[D3-7]` 就是一例，但那是挂点断言不是顺序断言）」。

---

### 12. **严重度：minor｜规格节号：§4.4 / §2.4 / §8.5｜主张摘要：三处锚点行号小偏**

**证据：**

- `spec:491`（§4.4）：「它今天的含义是「折叠后只剩一行光杆」（`chatTurn.ts:192` 的 §4.3 末行规则）」——【实测】`chatTurn.ts:192` 是 `The unresolved-permission branch is a **separate, first return on purpose**:`；那句「光杆」在 `chatTurn.ts:185`：`/** \`splitTurnBody(...).answer\` is empty — collapsing would leave the turn as one bare row. */`
- `spec:340`（§2.4）：「`ChatCodeBlock.tsx:57` 的 `<pre>` 没有 `relative`」——【实测】`<pre>` 在 `ChatCodeBlock.tsx:58`（`:57` 是 `return (`）。结论成立，行号偏一。
- `spec:890`：「【实测 `electron-builder.yml:56-73`】mermaid 段」——【实测】mermaid 段是 `:61-77`（`:56-58` 是 claude-agent-sdk 的排除）。

**建议修法：** 三处行号按上文更正；`spec:491` 的引用改为 `chatTurn.ts:185`。

---

### 13. **严重度：minor｜规格节号：§8.3 / `[FB9-4]`｜主张摘要：五文件白名单的符号名叫错了，且新增文件还须同步一张 `Record` 类型的注释对照表**

**证据：**

`spec:862` 与 `spec:965` 都把五文件白名单称作 `FORBIDDEN_ON_PATH`。
【实测】`src/renderer/components/chat/__tests__/chatMarkdownPolicy.test.ts` 里这是**两个不同的东西**：

```
989	const MARKDOWN_PATH_FILES = [
990	  'ChatMarkdown.tsx',
991	  'ChatCodeBlock.tsx',
992	  'chatMarkdownPolicy.ts',
993	  'chatShiki.ts',
994	  '../ui/ident.tsx',
995	] as const;
```

```
1005	const FORBIDDEN_ON_PATH: ReadonlyArray<{ what: string; re: RegExp; plant: string }> = [
```

`FORBIDDEN_ON_PATH` 是**禁用构造表**（rehype-raw / dangerouslySetInnerHTML / `<img` / fetch 等 9 条），不是文件白名单。
另有一个规格没提到的连带：新增文件还必须同步 `COMMENT_ONLY_PROSE`，否则**类型直接不过**：

```
1122	  const COMMENT_ONLY_PROSE: Record<(typeof MARKDOWN_PATH_FILES)[number], string> = {
1123	    'ChatMarkdown.tsx': 'Security rule',
```

**建议修法：** `spec:862` / `spec:965` 的 `FORBIDDEN_ON_PATH` 改为 `MARKDOWN_PATH_FILES`（`chatMarkdownPolicy.test.ts:989-995`），并补一句「同步扩表时须一并补 `COMMENT_ONLY_PROSE`（`:1122-1128`，`Record` 类型，漏改即 typecheck 红）」。

---

### 14. **严重度：minor｜规格节号：§11.3｜主张摘要：全批收口的全量基线「239 文件 / 4724 例」在当前 HEAD 已过时**

**证据：**

`spec:1092`：

> **全批收口**：五片合并后再跑一次全量 vitest（基线：F456 as-built 记录为 **239 文件 / 4724 例**，本批应只增不减）

【实测】`vitest.config.ts:13` 的 include 两条 glob 命中的测试文件数：`99dfd78` 上 **239**；当前 HEAD **245**（`src/**/__tests__/**/*.test.ts` 238 + `scripts/__tests__/**/*.test.mjs` 7）——阶段 4 新增了 `packaging-config.test.mjs`、`packaging-budget.test.mjs` 等 6 份。
「只增不减」拿旧基线比会恒真，等于没有门。

**建议修法：** `spec:1092` 改为「基线在**施工分支起点**当场复取（`pnpm test` 的 summary 行），F456 的 239/4724 只作历史参照；阶段 4 后本机基线已是 245 文件」。

---

### 15. **严重度：minor｜规格节号：§1.2｜主张摘要：逐类结论表漏了 CommonMark HTML block（类型 1–5 可跨空行）**

**证据：**

`spec:207` 的承重论证：

> 【实测 CommonMark 语义】**所有行内语法都不能跨越空行** … R-2 只处理**跨空行的块级容器**（围栏、数学块）

`spec:213-219` 的逐类表列了 7 类，没有 HTML block 一行。
CommonMark 的 HTML block 类型 1（`<pre>`/`<script>`/`<style>`/`<textarea>`）到类型 5（`<![CDATA[`）**以结束条件而非空行终止**，即它们是第三类「跨空行的块级容器」，R-2 的栈里没有它。
影响被本仓的既有安全姿态限制住了（裸 HTML 一律转义为文本，见 `src/renderer/components/chat/chatMarkdownPolicy.ts:745-746` `rawHtml: 'escaped-text'` 与 `chatMarkdownRender.test.ts:190-196` 的运行时验证），所以最坏只是转义文本的块包裹层数变化，不产生安全后果——但它是 `spec:207` 那句全称判断的一个真实反例。

**建议修法：** `spec:213-219` 表末补一行「HTML block（CommonMark 类型 1–5） | **已知偏差** | 可跨空行，R-2 栈未跟踪；因本路径裸 HTML 恒转义为文本（`chatMarkdownPolicy.ts:745-746`），后果限于块包裹层数，与引用式链接定义同级登记为已知偏差」，并把 `spec:207` 的「所有行内语法」收窄为「所有**行内**语法」+「块级容器只剩围栏、`$$` 与 HTML block」。

---

### 16. **严重度：minor｜规格节号：`[FB4-1]` / §11.1｜主张摘要：`[FB4-1]` 的「或」放行了一个约束不了函数的写法；§11.1 混面分析只算了生产文件**

**证据：**

`spec:944`：

> `turnItemPlacement` 对 `TurnItemKind` **联合穷尽**（`satisfies Record<TurnItemKind, TurnSegmentKind>` **或**逐成员），当前 5 成员

但 §4.2 把 `turnItemPlacement` 定义成**函数**（`spec:436-442`）：

```
export function turnItemPlacement(kind: TurnItemKind): TurnSegmentKind {
  if (kind === 'text') return 'answer';
```

`satisfies Record<…>` 只能约束一个字面对象，约束不了函数体 ⇒ 选这一支时 M-11（`spec:982`，黑名单写法）会存活（`[FB4-2]` 的夹具 `[text, tool, text, tool, text]` 在黑名单实现下**结果相同**，也咬不到）。

§11.1（`spec:1041-1050`）只逐条分析了 `MessageTimeline.tsx` / `chatTimelineLayout.ts` / `chatMarkdownPolicy.ts` 三份**生产**文件，没有分析测试文件的混面：
`messageTimelineWiring.test.ts` 同属片③（含 AST 定位器扩建）与片⑤（`spec:1060` / `spec:1090`）、`chatMarkdownPolicy.test.ts` 同属片①与片④、`chatTimelineLayout.test.ts` 同属片③与片⑤。
另 `spec:1007` 的片③变异分配写成「M-11~M-18、M-12」，M-12 重复列了一次。

**建议修法：** `spec:944` 去掉「或逐成员」的二选一，写死为**逐成员断言**（五个 kind 各一行，`text→answer` / `notice→notice` / 其余三个 `→process`）；
§11.1 补一段测试文件混面（三份 `.test.ts` 各自被两片触及，AST 定位器扩建归片③独占、片⑤ rebase 时不得回退）；
`spec:1007` 删掉重复的 `M-12`。

---

## §12.2 五条逐条结论

### Q2 —— FB1 的 hwm 落点（`TurnItemView` 的 `useRef` 依赖 `turnItemKey` 稳定）

**同意「hwm 用 `useRef`、不进 store」；反对规格给出的落点写法；并须追加一条段容器 key 纪律。**

`turnItemKey` 的稳定性我可以现在就替施工方结掉，不必留到施工期：【实测】`MessageTimeline.tsx:1415-1423`

```
1415	function turnItemKey(item: TurnItem): string {
1416	  switch (item.kind) {
1417	    case 'toolGroup':
1418	      return `${item.messageId}~group-${item.blockIndex}`;
1419	    case 'notice':
1420	      return `${item.messageId}~notice`;
1421	    default:
1422	      return item.block.id;
1423	  }
```

`text` 走 `default` ⇒ key = `item.block.id`，而这正是 `shouldRenderMarkdown` 用来判「谁在流」的同一个身份（`:1557` `blockId: item.block.id`）。
流式追加只改 `block.text`、不改 `block.id` ⇒ **key 在整段流式期恒定**，`useRef` 天然跨渲染存活。⇒ §1.5 ④ 的「须施工时实测确认」可以直接标为**已确认**，不成立时的备案（上提到 `ChatTurn` 的 `Map<blockId, number>`）不必启用。

但有两条必须一起改：
1. **落点写法违规**（见发现 9）：hooks 不能写在 `TurnItemView` 的 `switch` 分支里，必须抽 `TurnTextItem`。
2. **FB4 会改元素树位置，而 `useRef` 的存活同时依赖位置**。§4.5 C1 之后每个 answer 段各有一个容器 `<div>`，`spec:258` 给的示例 `segments.map((s, i) => <ChatMarkdown key={i} text={s} />)` 是**数组下标 key**。
   段容器如果也用下标 key，一旦在流式段之前插入一个新段（例如工具组落地时机与文本块交错），下标整体后移 ⇒ 整棵子树重挂 ⇒ **hwm 归零、已封存前缀回退**，正是 M-01 要守的那个退化，但它是运行期发生的、静态断言看不见。
   ⇒ §4.5 / §5.2 必须补一条：**段容器的 key 取该段首个 item 的 `turnItemKey(items[0])`，不得用数组下标**；`[FB1-2]` 之外再加一条 wiring 源文断言「段容器 key 表达式不是裸下标」。

### Q8 —— 时长的小时档（本批不加）

**同意，且理由比规格给的更硬。**

【实测】`turnTiming.ts:142-148` 的 `formatWorkedForDuration` 有**两个**消费者：`formatWorkedForRow`（`:164-172`，回合头/底部行的 `Worked for`）与 FB8 之后新加的 `formatThoughtRow`。
在 FB8 里加小时档 = 同时改掉一个**已验收形态**（T-31 §4.7 的 head 槽），属于超出 FB8 反馈面的改动，规格 `spec:806-810` 的第 2 条理由成立。
补两点：
- 60m / 120m 的显示是**不精确但不错误**（1702s → `28m 22s` 才是用户报的那个错误，分钟档已完全解决）；
- 但 §7.2 的第 3 条理由「没有证据表明存在 >1h 的思考时长」在 FB8 落地后会变弱：`formatThoughtRow` 加入共享后，任何一侧出现 >1h 都会同时暴露两处。⇒ 建议 Q8 的另立票在 `spec:1124` 补一句「该票的影响面在 FB8 后由 1 处变 2 处（`Worked for` + `Thought for`），改时须同批点验两处」。

### Q9 —— 行内 `$…$` 不启用

**同意「不启用」；但 `[FB9-2]` 的断言口径不可判定，必须改写。**

同意的理由在本仓比在一般聊天应用强得多：本路径就是 shell 指令的展示面（D53 ① 的原话是「模型输出给用户去终端执行的指令，如 git push」，`ledger.md:97`），`$PATH` / `$HOME` / `$1` 是高频字面量；先严后宽也确实是单向安全的顺序。

问题在断言：`spec:963` 的 `[FB9-2]` 写「remark 位含 `remark-math`，且**块级选项开、行内选项关**」。
【实测】`node_modules` 下 `remark-math` / `rehype-katex` / `katex` **均不存在**（`ls node_modules | grep -E '^remark|^rehype|katex'` 只有 `remark-breaks` / `remark-gfm` / `remark-parse` / `remark-rehype` / `remark-stringify` / `rehype-raw`），所以我无法在本机核对选项名。
但【推测】据我所知 `remark-math` 当前主版本只提供 `singleDollarTextMath` 这一个开关，其语义是「行内数学是否接受**单个** `$`」，**不是**「关闭行内数学」—— 关掉它之后 `$$x$$` 写在一行里仍会成为行内数学。
⇒ 「行内选项关」这个说法可能没有对应的选项，`[FB9-2]` 作为**必红断言**就不可判定。

**修法**：`spec:963` 改为行为断言而非选项断言，落 `chatMarkdownRender.test.ts`（node 环境已能渲染，见发现 8）：
`render('价格是 $5 到 $10')` 输出**不含** `<math`；`render('$PATH')` 原样保留；`render('$$e=mc^2$$')` 含 `<math`。
配置项名按施工时所用版本的文档填，规格保持「不发明选项名」的纪律（`spec:907` 这条自律是对的）。

### Q12 —— §4.6 折叠实现取 E1（多受控 Collapsible + 单按钮多 `aria-controls`）

**同意取 E1；但必须补两条附加条件，否则 E1 会带走一条安全 UX 并留下一个空壳断言。**

E1 的三条硬约束我逐条实读复核，**全部成立**：

```
node_modules/@base-ui/react/collapsible/root/useCollapsibleRoot.js:46-47
  const [panelIdState, setPanelIdState] = React.useState();
  const panelId = panelIdState ?? defaultPanelId;

node_modules/@base-ui/react/collapsible/panel/CollapsiblePanel.js:89
    id: panelId,

node_modules/@base-ui/react/collapsible/trigger/CollapsibleTrigger.js:51
    'aria-controls': open ? panelId : undefined,
```

⇒「单 Root 挂多 Panel 会撞 id」属实；E1 的「每段一个受控 Root」正好绕开它。
Panel 显式传 `id` 也可行：`CollapsiblePanel.js:30` 解构 `id: idProp`，`:66-74` 在 layout effect 里 `setPanelIdState(idProp)` 并在卸载时清回 —— 每 Root 一 Panel 时无竞争。
E1「不作废既有资产」的说法我也复核属实：`messageTimelineWiring.test.ts:475-476`（`<CollapsibleContent` + `keepMounted`）与 `:576`（`cn(turnProcessPanelClass(), turnBodyClass())`）在 E1 下都还在。

两条附加条件：
1. **`disabled={permissionLock}` 变死 prop**（发现 5）—— 必须迁到新的普通按钮上，并把 `messageTimelineWiring.test.ts:481-484` 换钉；
2. **多 Root 的 `open` 漏接**（`spec:1169` 已识别为「node 测试测不到 ⇒ G-15 强制点验」）—— 我同意点验是终验，但**静态半边是可以补的**：`spec:557-564` 的骨架里各段 `Collapsible` 的 `open` 表达式应该是同一个标识符，wiring 层可以断言「文件内 `open={processShellOpen}` 的出现次数 == process 段容器的渲染点数」。建议 §9.1 追加 `[FB6-6]` 作为 G-15 的静态半边，别让它 100% 押在一张截图上。

### Q13 —— §5.3 触发器取 G1（回合级单触发器）而非 G2

**同意 G1 的选择；但 G1 与 D55 ①（Q4 合并成一行）叠加后有一个 rev.1 未处理的形态冲突，必须先解掉再开工。**

G1 优于 G2 的理由成立：G2 的触发器行数 = process 段数，与 FB7 的减行目的正相反；G1 还能延续 `MessageTimeline.tsx:1183-1188` 的「head IS the trigger」既有语义（该头注我已复核逐字在位）。

冲突见发现 6：D55 ① 拍板「底部状态行与 `TurnFooter` 合并成一行」，而 `TurnFooter` 里挂着一个真的 `<button>`（`MessageTimeline.tsx:1730-1738`，挂点 `:1696`）。
G1 的「触发器 = 底部状态行**本身**」在合并后就是 `<button>` 套 `<button>`。
`spec:578` 的代价栏只写了「误触概率上升」，那是**未合并**语境下的判断，rev.1 没有回填 D55 ① 的后果。

⇒ **取 G1，但形态口径必须改为「行内独立 chevron 按钮」**：整行不是按钮，行尾的 chevron 是唯一的 `<button aria-expanded aria-controls="…">`，copy 按钮与它并列。
这样同时保住三样东西：单触发器（G1 的收益）、合并成一行（D55 ①）、以及 §5.3 ③ 担心的误触（可点区从整行缩到一个 24px 图标，误触风险反而下降）。
`spec:583-587` 的四项 GUI 确认项里，第 3 项「G1 的误触」的判据需要随之改写。

---

## 已复核正确清单

以下是我在当前 HEAD 亲自实读、确认**成立**的关键点（规格里写对的东西，不重复展开）：

**锚点有效性（检查面 A）**

1. `src/renderer/**` 自 `99dfd78` 起零改动 —— `git diff --name-only 99dfd78..HEAD` 在 `src/renderer/components/chat/**` 与 `src/renderer/stores/**` 上零命中；渲染端锚点整体有效。
2. §0.4-a `MessageTimeline.tsx` 22 条锚点抽验 15 条，**逐字全中**：`:173-182`（`STATIC_NOW_MS` + 第二时钟纪律）· `:526-528`（`PendingTurnHead` 挂载点）· `:737`（`UserBubble`）· `:797`（`title={fullText || undefined}`）· `:835`（`userBubbleTextClass()` 挂点）· `:936-952`（顺序头注 + memo 三支柱）· `:954`（`const ChatTurn = memo(function ChatTurn`）· `:979`（`splitTurnBody` 唯一生产调用点）· `:1141` · `:1161` · `:1169` · `:1183-1189` · `:1234-1320`（骨架，含 `:1265-1266` / `:1276-1284` / `:1287` / `:1308-1309`）· `:1355-1372` · `:1435-1465` · `:1484`（`min-w-0 truncate`）· `:1557-1564` · `:1683` · `:1704-1739`。
3. §0.4-b 低漂移模块锚点抽验 25 条，**逐字全中**（`chatMarkdownPolicy.ts:22-40/320-328/352-361/412/524-526/717-751` · `chatTurn.ts:29-35/128-132/158-176/203-206/214-216` · `chatTimelineLayout.ts:6-15/17-32/87-89/156-158/161-163/165-172/206-214` · `toolCard.ts:114-119/155-181` · `questionCardModel.ts:312-316/399/403-412` · `turnTiming.ts:110-130/142-148/164-172` · `ToolRows.tsx:76-79` · `ChatCodeBlock.tsx:32-39` · `ChatMarkdown.tsx:85-91/303-312/320-328` · `globals.css:81-84`）。
4. **agent-host 侧锚点全部仍有效**：`permissionBridge.ts` 与 `codexRuntime.ts` 自 `99dfd78` 起**零改动**（`git diff --stat` 空），`permissionBridge.ts:38-42` / `:96` / `:120,129,175` 与 `codexRuntime.ts:2433` / `:2505-2507` 逐字命中；`coalescingEmitter.ts:29 COALESCE_WINDOW_MS = 45` 仍在。
5. R1 的六个锚点全中：`middleColumnLayout.ts:537/555/654` 三个函数各只有一个调用点，全在 `ChatComposer.tsx:2313/2329/2853`；`attachments.ts:406-407` 头注逐字「the sole consumer is now the TURN HEAD (`turnStatus.ts`), not the composer」。
6. `vitest.config.ts:12 environment: 'node'` 仍是 node（无 jsdom），`:13` 的 include 两条 glob 也确认了 `.tsx` 完全不在测试面内 —— §4.2 选型理由 1 与 §5.6 的前提都成立。
7. `ToolRows.tsx` 的五处 `leading-[1.55]` 精确落在 `:230/233/262/285/304`，与 §0.2 点名的一致。

**FB9 两个地雷（检查面 F）**

8. **地雷二确实还在**：`electron-builder.yml:69 - "!node_modules/katex/**"` 在 HEAD 上仍然存在（行号漂了，见发现 4，但雷本身没被阶段 4 拆掉）。规格「不删则打包版公式静默失效」的判断成立。
9. `node_modules/{katex,mermaid,cytoscape,d3,elkjs,langium}` 全部不存在、`package.json` 无 `mermaid|katex|cytoscape` —— §8.5 的「katex 当年是 mermaid 的依赖被一并裁掉」背景属实。
10. **地雷一（字体红线）状态与规格描述一致**：`globals.css:81-84` 逐字在位；全仓 `rg '@font-face' src/` 只命中该注释自身；`fontDomain.test.ts` 只读 `globals.css` 的两个 token（`:19 GLOBALS_CSS`），`fontDomainScan.test.ts` 不扫 `@font-face` ⇒ 「该红线至今零例外且没有自动化守卫」成立。
11. `pnpm build:linux` 在本机（linux-x64）仍可执行 —— `scripts/assert-build-target.mjs:30` 只拦跨平台目标，G-11 的出包验证在本机可做，不必等 CI。
12. `checkAppDirSize`（`scripts/verify-packaged-app.mjs:995-1017`）是 **WARN-only**（`packaging-budget.mjs` 头注「never a failure」），katex 增加的体积不会撞新的次门禁。

**FB7 取证链（§6.2）**

13. 关联键的四跳传递链逐条实读全中，且第 ⑤ 跳（运行时实证）成立：`chatSessionsCore.test.ts:535-565` 的用例存在且断言 `['tool_call', 'permission_request']`；`chatSessions.ts:764-773` 的 P0 注释逐字在位。⇒ 「Claude 路径二者本就是同一字符串」这条改判**成立**，D55 ④ 的台账勘误是对的。
14. Codex 路径异构成立：`codexRuntime.ts:2505-2507` 的 `codex:${sessionId}:${idKey(requestId)}` 与 tool item id 无关 ⇒ Codex 走安全回落（D55 ③ 的 Q6 拍板）是正确的。
15. §6.6 提醒的「循环依赖」风险实际会良性化解：`questionCardModel.ts:1-7` 对 `toolCard.ts` 只有 `import type { ToolRowView }`（类型导入，编译期擦除），`toolCard.ts` 不 import `questionCardModel` ⇒ toolCard 反向取 `derivePermissionVerb` 的**值导入**不会造成运行时环。

**R2 安全边界（检查面 H）**

16. §2.2 的「渲染路径层面天然成立」我复核**属实**：`ToolRows.tsx:1-14` 的 import 列表里没有 `ChatCodeBlock` / `chatMarkdownPolicy`；`ChatCodeBlock` 的唯一调用点是 `ChatMarkdown.tsx:303-312` 的 `code` 渲染器。
17. §2.2 的「FB2 不受 R2 约束」也属实：`turnCopy.ts:3-17` 头注逐字在位，`buildTurnCopyTextFromItems`（`:34-38`）只取 `item.kind === 'text'`；FB2 复制的是 `ChatCodeBlock` 的 `code` prop，两者不在同一层。**FB4 / FB7 都不会破坏它** —— `flattenTurnItems` 不变、`hasUnresolvedPermission`（`chatTurn.ts:214-216`）直接读 `turn.body` 的 block 而非 item，FB7 的合并动不到它。

**其它**

18. §4.6 的三条 Base UI 锚点（`useCollapsibleRoot.js:46-47` / `CollapsiblePanel.js:89` / `CollapsibleTrigger.js:51`）逐字全中，「一个 Root 一个 Panel」这条硬约束是真的。
19. §5.6 的核心结论成立：`topLevelFunction`（`messageTimelineWiring.test.ts:272-279`）确实只认 `ts.FunctionDeclaration`，`jsxNodeAt`（`:282-299`）建立在它之上 ⇒ **没有任何断言钉住 `ChatTurn` 直接子元素的顺序**，FB6 是零回归网改造，「先补钉子再动结构」的纪律必须执行。工法确实现成（`isJsxNode` `:235-237` / `tagNameOf` `:239-241` / `jsxChildrenOf` `:243-256` / `classNameExpressionOf` `:365-367`，且 `[D3-8]` `:701-711` 已在用 `children[0]/[1]` 做位置断言）。
20. §1.6 的测试合同判断我抽验四条全对：`chatMarkdownPolicy.test.ts:325`（用例名 `F-C3: the block still streaming stays plain text`）· `:482`（`derivation and gate compose to the behaviour the ARD ruling states`）· `:1088` / `:1094` / `:1146` 三条必红点 · `:649/686/692` 的两档间距三连 · `messageTimelineWiring.test.ts:587-603` 的三处必红（含 `:589` 的 `chatSessions.ts is a red line` 注释）· `:922-934` 的 `leading-relaxed === 3`。
21. §7 FB8 的缺陷定性与修法正确：`turnTiming.ts:127` 的 `` `for ${Math.round(input.durationMs / 1000)}s` `` 与用户报的 `for 1702s` 逐字吻合；`turnTiming.test.ts:79-85` 的 12s 档在改用 `formatWorkedForDuration` 后确实不动（12 < 60 同值）。
22. §4.4 的「空 process 时仍渲染 head」有据：`turnHead.ts:346-351` 的 `deriveTurnHeadModel` 在无 process 时仍返回 status/workedFor/stats，只有全空才 `null`；`:341-344` 的「`hasProcess` 蕴含非空 head」不变量也逐字在位（§13 ② 关于两处必须同源派生的自查是对的）。
23. §9.2 M-04 的「诚实记账」（本批唯一静态不可捕获的变异）我认可 —— 分段 vs 不分段确实只能在性能点验里显形。
24. §12.1 Q4 的判据事实成立：`MessageTimeline.tsx:1683 if (!line && copyText.length === 0) return null;` 与 `messageMetadata.ts:182 if (metadata.model) parts.push(metadata.model);` 合起来确实意味着**流式期 footer 可能已渲染**。
