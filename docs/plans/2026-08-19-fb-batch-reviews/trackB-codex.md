# B 轨（Codex） —— 0820 FB 批规格 rev.1 双盲评审

## 判语

**修订后开工。** 主体方向可行，但 D55 的单行拍板尚未回灌施工正文，FB1 hwm 合同与若干变异臂也无法按现规格闭环；照文施工会产生互斥入口或虚假验收。

## 发现

1. **严重度：blocker｜规格节号：§5.2 / §5.3 / §9 / §10｜D55 要求单条 meta 行，但正文和断言仍施工为两个兄弟节点；G1 又未解决 copy 按钮与触发按钮的组合。**

   **证据：**

   - 【实测】`docs/plans/openchamber-chat-refactor-ledger.md:99`：D55 明定「**底部状态行与 TurnFooter 合并成一行（回合底部单条 meta 行）**」。
   - 【实测】`docs/plans/2026-08-19-fb-batch-spec.md:555-563` 仍给出两个节点：`{head && <底部状态行 />}` 后接 `<TurnFooter />`。
   - 【实测】同档 `:578-581` 又规定「触发器 = **底部状态行本身**」。
   - 【实测】当前 footer 内含独立 copy 控件：`src/renderer/components/chat/MessageTimeline.tsx:1685-1697` 为 `<div>…<TurnCopyButton />…</div>`；`:1730-1738` 的 `TurnCopyButton` 本身是 `<button>`。

   若把“合并行整体”直接实现成 G1 的按钮，就会遇到按钮内再放 copy 按钮；若继续两个兄弟节点，则直接违反 D55。规格没有给出唯一合法 DOM。

   **建议修法：**

   将 §5.2 `:555-563` 改成唯一结构：

   ```tsx
   <div className={turnMetaRowClass()}>
     {collapsible ? (
       <button aria-expanded aria-controls={panelIds}>状态 + chevron</button>
     ) : (
       <span>状态</span>
     )}
     <span>model · relative time</span>
     <TurnCopyButton />
   </div>
   ```

   即“单行容器”不是按钮，只有左侧状态区域是唯一折叠按钮，右侧 copy 为兄弟控件。同步重写 `[FB6-1]`、G-13、G-16，并退役或明确重定义 `TurnFooter`，防止形成同名空壳。

2. **严重度：major｜规格节号：§1.3 / §1.5 / §9.1 / §9.2｜hwm 的生产者、状态转移函数与测试落点互相矛盾，M-01 按规格无对象可删。**

   **证据：**

   - 【实测】`docs/plans/2026-08-19-fb-batch-spec.md:191-195` 只定义纯函数 `splitClosedPrefix(text)`，没有 hwm 入参或返回状态。
   - 【实测】同档 `:241-242` 又要求跨渲染保存 `max(hwm, splitClosedPrefix(t).length)`。
   - 【实测】同档 `:269-276` 把 hwm 放进 `TurnItemView` 的 `useRef`。
   - 【实测】但 `[FB1-2]` 被安排在纯模块测试 `chatMarkdownPolicy.test.ts`，见 `:934-936`；M-01 却写成「`splitClosedPrefix` 去掉 hwm」，见 `:972`。
   - 【实测】当前代码明确采用“含 hook 的分支拆独立组件”纪律：`src/renderer/components/chat/MessageTimeline.tsx:1619-1627` 写明 `toolGroup` 被拆出是为了让 `useMemo` “**legal**”。

   纯 `splitClosedPrefix` 没有 hwm 可供 M-01 删除；组件内 `useRef` 又无法由纯模块测试直接验证。把 `useRef` 直接放进 `switch` 的 text case 也违背当前组件的 hook 落点纪律。

   **建议修法：**

   在 §1.2 明确定义纯状态转移函数，例如：

   ```ts
   advanceClosedPrefix(text, previousHwm)
     -> { hwm, segments, openTail }
   ```

   `[FB1-2]` 与 M-01 都针对该函数；组件侧新增独立 `StreamingTextItem`，无条件调用 `useRef` 保存 `hwm`。同时明确：当当前安全切点短于 hwm 时，必须对 `text.slice(0, hwm)` 重建相同 segments，不能只替换一个长度数字。

3. **严重度：major｜规格节号：§5.6 / §9.0 / §9.2｜FB6“先补钉子”的红绿顺序自相矛盾，无法按零回归网流程执行。**

   **证据：**

   - 【实测】`docs/plans/2026-08-19-fb-batch-spec.md:924` 要求新断言「对着旧代码写、**跑绿**，再改代码看它红」。
   - 【实测】但 M-16 在 `:987` 明定同一个 `[FB6-1]` 对旧代码「**必须红**」。
   - 【实测】当前定位器确实只认函数声明：`src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:272-278` 返回 `ts.FunctionDeclaration`；当前 `ChatTurn` 是 `memo(function …)`，见 `MessageTimeline.tsx:954`。

   **建议修法：**

   改成明确的三步证据链：

   1. 扩定位器，并加临时基线断言 `head-before-content`，旧代码跑绿；
   2. 移动生产结构，确认该基线断言变红；
   3. 将永久断言换为 `content-before-meta-row`，跑绿，再用 M-16 恢复旧顺序确认永久断言红。

   不得同时要求同一断言在旧代码上既绿又红。

4. **严重度：major｜规格节号：§9.1 / §9.2｜M-12 与 M-14 存在咬不到的空转路径。**

   **证据：**

   - 【实测】M-12 要把 answer 容器挂到 process 一侧，并声称由 `[FB4-2] + [FB6-1]` 捕获，见 `docs/plans/2026-08-19-fb-batch-spec.md:983`。
   - 【实测】`[FB4-2]` 只断言纯分段顺序，见 `:945`；`[FB6-1]` 只断言 head 晚于内容段，见 `:950`。容器挂错侧不会改变分段结果，也仍可位于 head 之前，两条均可能继续绿。
   - 【实测】M-14 要防止 `collapsedLeavesNothing` 退回“没有 answer”，见 `:985`；但 `[FB4-5]` 只覆盖“全 process”与“含 text”，见 `:948`，没有覆盖恒可见的 `notice`。
   - 【实测】正确公式明确是 `segments.every(s => s.kind === 'process')`，见 `:493-495`，因此 `process + notice` 必须为 false。

   **建议修法：**

   - 为 M-12 新增 wiring 断言：`turnAnswerContainerClass()` 只能出现在 `segment.kind === 'answer'` 分支，process/notice 分支均不得出现。
   - `[FB4-5]` 增加 `process + notice => false` 与 `notice-only => false` 两臂。
   - §9.2 将 M-12 发射半边改为新 wiring 断言，不能继续指向纯分段测试。

5. **严重度：major｜规格节号：§9.2 / §10｜M-04 没有客观“红”判据，因此与“零存活”纪律不相容。**

   **证据：**

   - 【实测】M-04 明言静态断言抓不到，发射半边仅为 G-2 性能点验，见 `docs/plans/2026-08-19-fb-batch-spec.md:975`。
   - 【实测】G-2 只写「对比不分段实现的帧率」，没有帧耗时、解析次数或退化比例阈值，见 `:1019`。
   - 【实测】同档却要求全部变异「零跳过零存活」，见 `:1002-1003`。
   - 【实测】工程规范要求自动回归而非以人工点验作为唯一判据：`docs/agent-project-engineering.md:8-10` 为“define verification first”；`:174-175` 明定手工测试不能作为主要回归方式。

   **建议修法：**

   给 M-04 增加确定性工作量断言，例如对固定追加序列统计“发生变化、需要重新解析的 segment 总字符数/次数”；分段实现应近线性，单一 closedPrefix mutant 必须超过明确上限。G-2 保留为观感补充，不承担“红/绿”唯一裁决。

6. **严重度：major｜规格节号：§8.4 / §8.5｜FB9 两个打包地雷尚未真正闭环：node_modules 排除规则与 renderer 构建产物的关系未经证明，字体退路也没有授权出口。**

   **证据：**

   - 【实测】当前 `electron-builder.yml:10-11` 同时打包 `out/**/*` 与 `node_modules/**/*`，而 KaTeX 排除仅作用于 `node_modules/katex/**`，现位于 `:69`。
   - 【实测】renderer 是独立 Vite 构建入口：`electron.vite.config.ts:90-107`，输入为 renderer `index.html`。
   - 【实测】规格却直接断言恢复 node_modules 排除会使公式失效，并将其定为 M-29，见 `docs/plans/2026-08-19-fb-batch-spec.md:898-901`、`:1000`。
   - 【推测】renderer 依赖及其 CSS/font 很可能被 Vite 产入 `out/renderer`；若如此，`!node_modules/katex/**` 对公式或 woff2 均不起作用，M-29 只是“让配置断言红”，并不构成产品变异。
   - 【实测】设计规范将随包字体定为独立资产/打包/许可证立项：`docs/design-system.md:648-665`。
   - 【实测】规格却允许 G-10 不满意后直接转 HTML+字体，只要求三处留痕，见 FB 规格 `:885-886`；§12.2 五项中没有该偏离的确认入口，见 `:1119-1127`。

   **建议修法：**

   - 依赖安装后先做一次构建取证：确认 KaTeX JS/CSS/woff2 最终位于 `out/renderer`、app.asar 的 node_modules，还是其他位置。
   - 若运行时不消费 `node_modules/katex`，删除 `[FB9-5]`、M-29 和强制修改 builder 的要求，改为断言真实产物位置。
   - MathML 路明确写成“不得 import `katex/dist/katex.min.css`”，并增加构建产物中无 KaTeX `.woff2` 的断言。
   - G-10 若失败，片④应标为阻塞并另行取得字体立项/红线偏离授权，不能自动转（b）路。

7. **严重度：major｜规格节号：§8.2 / §8.3 / §9.1｜FB9 安全结论没有针对数学输入的运行时攻击臂。**

   **证据：**

   - 【实测】规格承认“插件是否走 raw 节点路径”仍须实证，见 `docs/plans/2026-08-19-fb-batch-spec.md:847`。
   - 【实测】但 `[FB9-3]` 只做配置源码扫描、`[FB9-4]` 只检查本仓文件是否纳入扫描名单，见 `:964-965`。
   - 【实测】当前 F-C6 渲染安全测试仅覆盖裸 HTML、markdown image、checkbox 与代码文本：`src/renderer/components/chat/__tests__/chatMarkdownRender.test.ts:189-235`，没有任何数学输入。
   - 【实测】规格将这组现有测试直接判为“不受影响”，见 FB 规格 `:863`。

   **建议修法：**

   在 `chatMarkdownRender.test.ts` 新增真实数学渲染安全组，至少覆盖：

   - `\href{javascript:...}{x}`
   - `\includegraphics{https://evil/...}`
   - `\htmlClass` / `\htmlStyle`
   - 公式解析失败时含 `<script>` 的源文本

   断言输出不含 `<a href>`、`<img>`、`src=`、网络 URL、`dangerouslySetInnerHTML`/raw HTML，并正向确认产生真实 `<math>`。

8. **严重度：major｜规格节号：§11.2 / §11.3 / §11.4｜片④影响面和每片收口条件未跟上当前打包链。**

   **证据：**

   - 【实测】规格自己确认引入三包会改 `package.json + lockfile`，见 `docs/plans/2026-08-19-fb-batch-spec.md:835`。
   - 【实测】但片④文件表 `:1061` 和影响面清单 `:1096-1098` 均遗漏 `pnpm-lock.yaml`。
   - 【实测】当前项目明确使用 pnpm：`package.json:12` 为 `"packageManager": "pnpm@10.26.2"`。
   - 【实测】阶段 4 已存在专门的 builder 配置测试：`scripts/__tests__/packaging-config.test.mjs:22-57`；且 `vitest.config.ts:13` 已把 `scripts/__tests__/**/*.test.mjs` 纳入全量测试。片④却另写一个未命名“构建配置侧”测试，没有接入现有承重点。
   - 【实测】每片三件套只有 scoped vitest、变异、GUI，见 FB 规格 `:1076-1089`；而正式质量门还包括 `typecheck` 与 `lint`，见 `package.json:30-35`。

   **建议修法：**

   片④独占/影响面加入：

   - `pnpm-lock.yaml`
   - `scripts/__tests__/packaging-config.test.mjs`
   - 若做产物资产扫描，相应 packaging test/script

   `[FB9-5]` 应落现有 `packaging-config.test.mjs`。每片收口至少补 `pnpm typecheck` 与 `pnpm lint` 串行绿，否则片④可能在 scoped source-scan 全绿时仍留下 TS/plugin-option 或 hook 错误。

9. **严重度：minor｜规格节号：§11.2｜依赖图安全但把调度约束写成了技术依赖，且与表内说明矛盾。**

   **证据：**

   - 【实测】片①表项称「**与全部片并行**」，见 `docs/plans/2026-08-19-fb-batch-spec.md:1058`。
   - 【实测】图 `:1064-1067` 却要求 `① ∥ ⑤` 全部完成后才进入②。
   - 【实测】正文列出的真实依赖只有 ②→③（kind 定案）和 ①→④（消费切分函数），见 `:1059-1061`、`:1072-1074`。

   **建议修法：**

   改写为：

   ```text
   ① → ④
   ② → ③ → ④
   ⑤ 与 ③ 因共享文件择一先行，后者 rebase
   ```

   若仍选择 `① ∥ ⑤ → ② → ③ → ④`，应称为“推荐串行调度”，不要称为依赖序。

10. **严重度：minor｜规格节号：§0.4 / §8.5 / §11.3｜阶段 4 后 builder 行号与全量测试基线已漂移。**

   **证据：**

   - 【实测】规格锚点写 `electron-builder.yml:64`，见 `docs/plans/2026-08-19-fb-batch-spec.md:165`、`:900`；当前规则实际在 `electron-builder.yml:69`。
   - 【实测】当前 builder 前置说明也已扩写为 Agent Host/afterPack 新链路，见 `electron-builder.yml:47-54`，不再是锚点时的原段落形态。
   - 【实测】规格仍用 F456 的“239 文件 / 4724 例”作为本批合并后基线，见 FB 规格 `:1092`；该数字在台账中明确属于 D50/F456，见 `docs/plans/openchamber-chat-refactor-ledger.md:94`，而当前 vitest 已额外包含阶段 4 的 `scripts/__tests__`，见 `vitest.config.ts:13`。

   **建议修法：**

   §0.4 与 §8.5 改为当前 `:69`，以排除项原文作为主锚。开工前重新采集当前 HEAD 的测试文件/用例数并写成新基线，不再沿用 D50 数字。

## §12.2 五条逐条结论

### Q2 — hwm 落点：反对当前写法，接受“按 block key 保存状态”的方向

【实测】key 本身稳定：`MessageTimeline.tsx:1414-1423` 对普通 text item 返回 `item.block.id`；store 追加 token 时保留同一 block 并只追加 `text`，见 `src/renderer/stores/chatSessions.ts:482-490`。

但规格把 `useRef` 放进 `TurnItemView` 的 text 分支；当前仓已经明确将含 hook 的 `toolGroup` 分支拆为独立组件以保证 hook 合法，见 `MessageTimeline.tsx:1619-1627`。因此应改为独立 `StreamingTextItem`，而不是上提到 `ChatTurn` 的 `Map`；除非施工实测发现 block id 会变化，否则不需要扩大状态面。

### Q8 — 小时档：同意本批不加

【实测】共享函数当前仅有秒/分钟两档：`src/renderer/components/chat/turnTiming.ts:142-147`。本次反馈样本 1702 秒由分钟档即可完整修复，见 FB 规格 `:792-800`；加入小时档会同时改变既有 `Worked for` 输出，见 `:804-810`。另立票合理。

### Q9 — 行内 `$…$`：同意不启用

【实测】用户拍板范围是 `$$…$$`，上游分诊 `docs/plans/2026-08-19-usage-feedback-0820-triage.md:20` 明写 LaTeX `$$…$$`。核心场景又包含 shell 命令，D53 ①见 `openchamber-chat-refactor-ledger.md:97`。单 `$` 会与 shell 变量、价格文本发生真实冲突。

施工后测试必须锁定所选 `remark-math` 版本的真实配置项；不要保留“块开/行内关”的抽象伪选项名。

### Q12 — E1：同意，但须补唯一、稳定 panel id 的验收

【实测】Base UI 一个 Root 只保存一个 `panelId`：`node_modules/@base-ui/react/collapsible/root/useCollapsibleRoot.js:45-47`；Panel 最终消费该 id，见 `collapsible/panel/CollapsiblePanel.js:83-90`。因此“每 process 段一个受控 Root/Panel”是保留 `keepMounted` 的正确方向。

要求补充：用一个稳定 `useId()` 前缀生成所有 panel id；断言 id 唯一、`aria-controls` 枚举恰好相同集合。D55 合并行按发现 1 的兄弟按钮结构实现。

### Q13 — G1：反对当前表述；同意修订后的“单回合触发器 G1′”

单一回合级触发器优于每段重复触发器，但当前“底部状态行本身是按钮”与 D55 合并 footer 后的 copy 按钮冲突。证据为 FB 规格 `:578-581`、台账 `:99`，以及当前 copy 按钮 `MessageTimeline.tsx:1730-1738`。

应改判为 G1′：**单条 meta 行内，左侧状态区域是唯一触发按钮，footer 文本和 copy 是同一行中的非触发兄弟元素。**

## 已复核正确清单

- 【实测】绝大多数 renderer 锚点仍成立：`ChatTurn` 仍在 `MessageTimeline.tsx:954`，`PendingTurnHead` 必填 `promptChars` 仍在 `:1372`，流式 text 分支仍在 `:1555-1564`。
- 【实测】FB7 Claude 关联链仍成立：`src/agent-host/permissionBridge.ts:38-42` 有 `toolUseId` 即逐字返回；store 在 `src/renderer/stores/chatSessions.ts:786-788` 同时写入 block id 与 `permissionId`。
- 【实测】FB7 Codex 回落判断仍成立：`src/agent-host/codexRuntime.ts:2505-2507` 的关联值仍为 `codex:${sessionId}:${idKey(requestId)}`，不是 tool item id。
- 【实测】R2 安全边界仍完整：`src/renderer/components/chat/turnCopy.ts:6-16` 只复制 assistant text，明确排除 tool input/output、thinking、notice 与用户提示。
- 【实测】`ChatCodeBlock` 当前仍只有 markdown 一个调用点：`src/renderer/components/chat/ChatMarkdown.tsx:303-311`；工具渲染路径没有调用它。
- 【实测】FB6 的 `PendingTurnHead` 不应改名、也不应给 `promptChars` 加兜底：现有静态钉位于 `messageTimelinePendingStatic.test.ts:141-158`。
- 【实测】E1 排除“一个 Root 多 Panel”的取证正确：Base UI 的 Trigger 只读取单个 `panelId`，见 `node_modules/@base-ui/react/collapsible/trigger/CollapsibleTrigger.js:50-54`。
- 【实测】FB9 当前依赖确实尚未落地：`package.json:77-80` 只有 `react-markdown`、`rehype-raw`、`remark-breaks`、`remark-gfm`，没有三项 math 依赖。
- 【实测】当前 KaTeX 排除规则仍存在，只是已漂移到 `electron-builder.yml:69`；因此开工前确实必须重新评估打包链，不能沿用旧行号盲改。