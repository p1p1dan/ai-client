1. **严重度：blocker｜规格节号：§2.3、§10.1 Q1｜主张摘要：`--tool-arg` 的 85% 修法一边已被规格裁定，一边又被列为“必须再次让用户拍板”，施工入口互相矛盾。**  
   **证据：**规格已经在 [2026-08-18-f456-readability-composer-spec.md:261](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:261) 明确裁定“保留派生，混合比 78% → 85%”，并在 [同文件:272](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:272) 给出完整数值链；但 [同文件:1185](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1185) 又把 Q1 列入“需要用户拍板才能施工”，要求在 85% 与退役 token 之间再选一次。本次评审前提已经明确把 D2-b 及 85% 派生链列为不可复议的既定方案，因此执行者按 §2.3 会直接施工，按 §10.1 则必须停工询问。  
   **建议修法：**删除 Q1 的开放问题身份，改成“已决：保留 `--tool-arg`，85%”；候选 B 只能保留为历史备选，不得再写“评审拍板即可启用”。在规格开头的不可复议清单中把“`--tool-arg` 85%”逐字钉明，避免实现者把 D2-b 错解成只改 `muted-foreground`。

2. **严重度：major｜规格节号：§0.5 C6、§1.3、§3.2、§4.3、§6、§7.4、§7.5、§9｜主张摘要：大量标成【实测】的 `file:line` 已被当前 HEAD 推移，特别是 `c5cbd19` 之后的时间线文件；规格不能按现有锚点直接施工。**  
   **证据：**当前 HEAD 为 `72da179`。代表性的失效引用如下：

   - 规格 [同文件:97](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:97)、[同文件:402](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:402) 把 D26 注释写成 `MessageTimeline.tsx:708-715`，当前实际是 [MessageTimeline.tsx:725](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:725)。
   - 规格把用户 `<article>`、尺寸类和角色类写成 `:716/:719/:726`；当前分别在 [MessageTimeline.tsx:733](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:733)、[MessageTimeline.tsx:736](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:736)、[MessageTimeline.tsx:743](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:743)。
   - 规格 [同文件:147](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:147) 写用户正文 `MessageTimeline.tsx:765`，当前为 [MessageTimeline.tsx:782](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:782)。
   - 规格 [同文件:146](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:146) 写流式兜底 `:1449`，当前为 [MessageTimeline.tsx:1464](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1464)。
   - 规格 [同文件:507](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:507) 写 answer 挂点 `:1209`，但 `:1209` 当前是 process panel 的 `className`；answer 真正挂点在 [MessageTimeline.tsx:1224](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1224)。
   - 规格 [同文件:148](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:148) 把 `turnBodyClass()` 写在 `chatTimelineLayout.ts:79`；`:79` 当前仍是 clamp 注释，函数实际在 [chatTimelineLayout.ts:94](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:94)。
   - 规格 [同文件:875](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:875) 写 tone helper 在 `MessageTimeline.tsx:1372-1377`；当前定义在 [MessageTimeline.tsx:1388](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1388)。
   - 规格 [同文件:214](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:214) 写流式类断言在测试 `:404-406`；当前承重字符串在 [messageTimelineWiring.test.ts:407](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:407)。
   - Composer 侧，`composerTextareaClass` 当前从 [middleColumnLayout.ts:418](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:418) 开始，不是规格反复使用的 `:435-464`；`composerCardClass` 当前在 [middleColumnLayout.ts:150](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:150)。

   同时也有核对准确的引用：`chatMarkdownPolicy.ts:391-400/:426/:473-475/:509/:523-524`、`ToolRows.tsx:76/:112/:230/:233/:262/:285/:304`、`turnBubbleBandClass()` 的 [chatTimelineLayout.ts:63](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:63) 均与当前源文一致。问题不是“全部引用失效”，而是规格把一批旧行号继续标成了当前实测。  
   **建议修法：**对当前 HEAD 重新生成整份锚点表；对高漂移大文件优先使用“符号名 + 当前行号 + 关键原文”三元锚点，例如 `UserBubble`、`ChatTurn` answer 条件、`turnStatusToneClass`，不要只留裸行号。尤其统一修订 §0.5、§1.3、§3.2、§4.3、§7.4、§7.5、§9.1、§9.3 中重复引用的同一批旧行号。

3. **严重度：major｜规格节号：§1.3、§1.6、§8.2、§9.2｜主张摘要：D1-b 的测试影响面漏掉一份必红测试，因此“全量门禁”会在施工后失败，切片②也不完整。**  
   **证据：**规格只安排修改 `chatMarkdownPolicy.test.ts` 和 `messageTimelineWiring.test.ts`，见 [规格:187](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:187)、[规格:210](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:210)、[规格:975](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:975)。但现有渲染测试还在 [chatMarkdownRender.test.ts:297](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/chatMarkdownRender.test.ts:297) 明确钉住 D25 正文字号及行高，并于 [chatMarkdownRender.test.ts:300](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/chatMarkdownRender.test.ts:300) 断言根节点包含 `leading-normal`。D1-b 把 markdown 根类改成 `leading-relaxed` 后，这条测试按构造必红。  
   传播路径也确认不是 token 自动传播：`text-markdown` 只承担 15px 字号，行高是独立显式类；当前用户正文和流式兜底分别在 [MessageTimeline.tsx:782](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:782)、[MessageTimeline.tsx:1464](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1464) 各自写死 `leading-normal`，回合骨架则在 [chatTimelineLayout.ts:100](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:100) 保留 `leading-normal`。  
   **建议修法：**把 `chatMarkdownRender.test.ts` 加入 §1.6、§8.1、§9.2 和 §9.3 的测试清单；把 `:300` 改为正向 `leading-relaxed` 加负向 `not leading-normal`。测试总数应相应从规格当前自相矛盾的“7 份/8 份”统一为 **9 份，其中 1 份新建**。

4. **严重度：major｜规格节号：§8.2 D3-6、§8.4 M-14｜主张摘要：规格把 answer 容器误判成 sticky 气泡的祖先，导致 `[D3-6]` 和 M-14 建立在错误 DOM 因果链上；该变异是 inert。**  
   **证据：**规格 [同文件:1008](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1008) 声称“容器是新加在 sticky 链上的祖先元素”，因此禁止 `overflow-*`、`transform`、`filter`、`contain`；[同文件:1070](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1070) 又把 `overflow-hidden` 描述为“会静默关掉置顶气泡”的真实缺陷。实际 DOM 是：

   - sticky band 位于 [MessageTimeline.tsx:1168](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1168)；
   - 它关闭后，`turnBodyClass()` 对应的兄弟节点从 [MessageTimeline.tsx:1172](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1172) 开始；
   - answer 容器挂点在这个兄弟节点内部的 [MessageTimeline.tsx:1224](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1224)。

   因此 answer 容器是 sticky band 的**后续兄弟的后代**，不是 sticky 元素的祖先。给 answer 容器加 `overflow-hidden` 不会改变 sticky band 的 containing block，也不会“关掉置顶气泡”。  
   **建议修法：**删除 `[D3-6]` 的 sticky 因果论证和 M-14；如果确实要禁止这些类，应给出与 answer 内容本身相关的真实失败，例如 `overflow-hidden` 裁掉代码块横向滚动、focus ring 或浮层，并配对应 DOM/浏览器复现。否则不要把风格偏好包装成承重安全断言。

5. **严重度：major｜规格节号：§8.2 D3-1/D3-2/D3-3/D3-7、§8.4 M-10～M-15｜主张摘要：D3 的结构断言沿用当前全文件投影 helper 时无法证明类挂在正确节点，多个变异可以挂错位置仍通过。**  
   **证据：**当前 `expectCalled` 只检查 token 是否出现在整份 `MessageTimeline.tsx` 的任意 call/JSX attribute 投影中，见 [messageTimelineWiring.test.ts:180](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:180)；`expectUnwired` 只检查 token 是否在整份可执行源文中彻底消失，见 [同文件:195](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts:195)。因此：

   - 规格 [规格:996](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:996) 的 `expectCalled('flex justify-end')`、`max-w-[85%]`、`bg-accent` 可以被放到任意其他 JSX 元素上仍通过，不能证明它们属于 `UserBubble`。
   - [规格:998](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:998) 写“在 `UserBubble` 范围内 `expectUnwired('bg-card')`”，但现有 helper 没有“范围”参数；直接使用会要求整份 `MessageTimeline.tsx` 都没有 `bg-card`，与所述合同不是一回事。
   - [规格:999](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:999) 的附件芯片断言同样只证明类串存在，不证明在附件芯片 `<span>` 上。
   - [规格:1011](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1011) 的 D3-7 只要求 `cn(turnBodyClass(), turnAnswerContainerClass())` 存在一次。把唯一调用挂到 `process.map` 或无关节点仍满足“一次”，所以 [规格:1071](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1071) 的 M-15 不会可靠发红。

   **建议修法：**为测试增加 TypeScript AST 节点级定位：先定位 `UserBubble` 函数，再定位其 `<article>`、内层 bubble `<div>`、附件 `<span>`；D3-7 则定位 `answer.length > 0` 条件表达式并断言其直接 JSX 节点的 `className`。不能继续用全文件 substring/出现次数冒充节点归属。

6. **严重度：major｜规格节号：§6.3～§6.7、§8.3 F6-4/F6-5/F6-6、§9.2｜主张摘要：F6 的纯函数数值推导正确，但 DOM 结构测试和切片所有权不完整，存在“helper 已改、session DOM 未接线”仍绿的空壳路径。**  
   **证据：**42px 旧契约与 74px 新推导本身成立：

   - 当前卡片为 `min-h-10.5` 和 `rounded-[21px]`，见 [middleColumnLayout.ts:157](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:157)、[middleColumnLayout.ts:173](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:173)。
   - 当前算术为 `2 border + 16 padding + 24 content = 42`，见 [middleColumnLayout.ts:185](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:185) 至 [同文件:194](/home/dan/projects/ai-client/src/renderer/components/chat/middleColumnLayout.ts:194)。
   - 两行后 `2 + 16 + 24 + 8 + 24 = 74`，半高为 37px，所以退役 21px pill 推导、改 `rounded-md` 是正确的。

   问题在测试和所有权：

   - 当前 session DOM 的七件套确实还在同一个 div，见 [ChatComposer.tsx:2622](/home/dan/projects/ai-client/src/renderer/components/chat/ChatComposer.tsx:2622) 至 [ChatComposer.tsx:2630](/home/dan/projects/ai-client/src/renderer/components/chat/ChatComposer.tsx:2630)；`composerActionGroupClass()` 目前只在 empty 分支使用，见 [ChatComposer.tsx:2653](/home/dan/projects/ai-client/src/renderer/components/chat/ChatComposer.tsx:2653)。
   - 规格 [规格:1027](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1027) 要“沿用源文扫描工法”证明兄弟关系、session 分支归属和 empty direct-child 顺序；但当前 `composerFormStatic.test.ts` 只有目录遍历、去注释和正则名称扫描，见 [composerFormStatic.test.ts:34](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/composerFormStatic.test.ts:34) 至 [同文件:86](/home/dan/projects/ai-client/src/renderer/components/chat/__tests__/composerFormStatic.test.ts:86)，没有 JSX AST、分支或 sibling 模型。
   - `composerActionGroupClass()` 在 empty 分支本来就出现；若 F6-5 只做全文件 presence 检查，即使 session 行2漏接仍然会绿。
   - 规格切片③的“独占文件”表 [规格:1135](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1135) 漏掉必须修改的 `ComposerAgentPicker.tsx`，但后面的影响面表又在 [规格:1157](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1157) 把它列入③。当前承重点确为 [ComposerAgentPicker.tsx:224](/home/dan/projects/ai-client/src/renderer/components/chat/ComposerAgentPicker.tsx:224) 的 `shrink-0`。

   **建议修法：**把 F6-4～F6-6 改成 JSX AST 断言：定位 `mode === 'session'` 分支、`composerRowsClass()` 容器、两个 direct-child 行，再检查 textarea 和 action group 的节点归属；empty 分支按 direct-child 顺序比较。把 `ComposerAgentPicker.tsx` 补进切片③的独占文件表和施工 ownership。

7. **严重度：major｜规格节号：§7.4、§8.4 F4-7、§9.3｜主张摘要：`promptChars` 只规划了 attached-turn 消费者，漏掉 pending-turn 的第二个 `deriveTurnStatus` 调用，导致用户回显出现前的等待行没有 `↑`，或者接口改为必填后直接类型失败。**  
   **证据：**规格只指定在 `MessageTimeline.tsx:986-1013` 的 attached `ChatTurn` 调用加入 `promptChars`，见 [规格:849](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:849) 至 [规格:858](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:858)。当前 attached 调用在 [MessageTimeline.tsx:1003](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1003)。但同文件还有 pending head 的第二个生产消费入口：`PendingTurnHead` 在用户 echo 尚未到达时调用 `deriveTurnStatus`，见 [MessageTimeline.tsx:1262](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1262) 至 [MessageTimeline.tsx:1271](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1271)。它已经拿到完整 `sendStatus`，却未被规格列入 `promptChars` 透传计划。  
   当前 producer/store 链确实都尚无该字段：提交快照位于 [ChatComposer.tsx:1117](/home/dan/projects/ai-client/src/renderer/components/chat/ChatComposer.tsx:1117) 至 [同文件:1125](/home/dan/projects/ai-client/src/renderer/components/chat/ChatComposer.tsx:1125)，store 接口止于附件字段，见 [turnSendStatus.ts:41](/home/dan/projects/ai-client/src/renderer/stores/turnSendStatus.ts:41) 至 [同文件:52](/home/dan/projects/ai-client/src/renderer/stores/turnSendStatus.ts:52)。  
   **建议修法：**把 `PendingTurnHead` 明列为第二个消费者，并传 `promptChars: sendStatus.promptChars`。增加一个 pending-window 测试：用户 echo 尚未建立 turn、`promptChars=428` 时等待头必须含 `↑ 428 chars`；否则现有 F4-7 只证明 producer 写了字段，不能证明最早可见窗口消费了字段。

8. **严重度：major｜规格节号：§8.4 F4-1～F4-6、M-21～M-28｜主张摘要：F4 多条测试只能证明字符串形态或局部源文存在，不能证明数值接线、纯函数性和色阶消费者；其中 F4-6 按指定测试文件甚至不可直接执行。**  
   **证据：**

   - [规格:1046](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1046) 的 F4-3 只要求箭头出现/省略和顺序；错误实现恒定输出 `↑ 1 chars · ↓ 1k` 仍可通过。当前输出 token 的真实格式化与数据绑定在 [turnStatus.ts:102](/home/dan/projects/ai-client/src/renderer/components/chat/turnStatus.ts:102) 至 [同文件:112](/home/dan/projects/ai-client/src/renderer/components/chat/turnStatus.ts:112)，新 awaiting 接线必须核对具体输入值。
   - [规格:1047](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1047) 的 F4-4 只证明 `budgetMs` 不影响输出且没有 `up to`；一个完全忽略 elapsed、附件、prompt、token 的常量文案也满足这两条。
   - [规格:1048](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1048) 只扫描 `attachments.ts` 是否出现 `Math.random`/`Date.now`；把随机选择移入 `countFormat.ts` 或另一个 imported helper 即可逃逸。
   - [规格:1044](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1044) 的“同参两次相等”不能排除全局可变状态在两次之间恰好返回同值；应做交错调用和模块状态检查。
   - [规格:1049](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1049) 把 F4-6 分配给 `turnStatus.test.ts`，但需要断言的 `turnStatusToneClass` 是 `MessageTimeline.tsx` 内部未导出的函数，当前定义在 [MessageTimeline.tsx:1388](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:1388)。`turnStatus.test.ts` 无法按普通单元测试直接导入它，规格也没有要求导出、抽取或源文扫描。
   - 当前 `composerSendingLine` 仍从 [attachments.ts:321](/home/dan/projects/ai-client/src/renderer/components/chat/attachments.ts:321) 接口进入，并在 [attachments.ts:342](/home/dan/projects/ai-client/src/renderer/components/chat/attachments.ts:342) 真实消费 `budgetMs`；因此必须验证迁移后的正向内容，不能只验证“某内容消失”。

   **建议修法：**F4-3 增加具体映射，例如 `promptChars=428` 必须得到 `↑ 428 chars`，`outputTokensDisplay=1800` 必须得到 `↓ 1.8k`；F4-4 同时断言动词、elapsed、附件、retry 和两个计数仍存在。纯函数测试做 `A→B→A` 交错调用，并将词表选择函数直接导出测试。把 tone helper 抽到可测试的纯模块，或用 AST 精确定位 `turnStatusToneClass` 的 `slow/stalled` 分支；不能把一个不可导入的 TSX 私有函数直接分配给 `turnStatus.test.ts`。

9. **严重度：major｜规格节号：§3.4、§8.5 G-2/G-3/G-4｜主张摘要：规格没有覆盖 `line-clamp-6`、多段落、附件芯片和 85% 宽度共同作用的真实结构，而且 G-3 误写成“三行 clamp”。**  
   **证据：**当前 clamp helper 明确返回 `line-clamp-6`，见 [chatTimelineLayout.ts:84](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:84) 至 [同文件:85](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:85)，不是三行。规格却在 [规格:1097](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1097) 写“超长单行用户提问（触发三行 clamp）”。实际 clamp 容器不是纯文本节点：附件 chip 位于 [MessageTimeline.tsx:752](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:752) 至 [同文件:773](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:773)，随后 clamp 容器内部可以包含多个 `<p>`，见 [MessageTimeline.tsx:778](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:778) 至 [同文件:787](/home/dan/projects/ai-client/src/renderer/components/chat/MessageTimeline.tsx:787)。D3-c 再把这一内层盒限制为 85% 宽，换行数会显著增加。  
   **推断：**`line-clamp-6` 的 `-webkit-box` 模型套在多个块级 `<p>` 上时，段间 `space-y-2` margin 与附件占位可能共同消耗可见高度；单测只看类名无法确定不同 Chromium 版本的裁切/省略号行为。右对齐本身不会制造透明缝，因为满宽 opaque band 仍在 [chatTimelineLayout.ts:63](/home/dan/projects/ai-client/src/renderer/components/chat/chatTimelineLayout.ts:63)，但 clamp 内容预算需要真实浏览器点验。  
   **建议修法：**把 G-3 改成“六行 clamp”，并至少拆为：无附件超长单段、多段落、含空行/换行、含附件后长正文四种场景；亮暗双主题下核对省略号、可访问 title、实际高度和 sticky 状态。若附件不应占正文六行预算，应把附件区移出 `userBubbleTextClass()` 的 clamp 容器并明确结构合同。

10. **严重度：major｜规格节号：§9.1～§9.3｜主张摘要：四切片的并行关系方向基本合理，但冲突矩阵和文件 ownership 不完整，不能称为“真正零混面”。**  
    **证据：**规格自己已经承认等待行片④会再次修改片②、③的文件，见 [规格:1122](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1122) 至 [规格:1127](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1127)，并在 [规格:1136](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1136) 列出它“轻触” `MessageTimeline.tsx` 和 `ChatComposer.tsx`。因此准确表述应是：①、②、③可以并行，④必须在②/③合入后基于新 AST 落地；不是四片零文件重叠。另有两个矩阵遗漏：

    - 片②遗漏第 3 条所述 `chatMarkdownRender.test.ts`，所以 D1-b 的测试 ownership 不完整。
    - 片③的独占文件列表遗漏 `ComposerAgentPicker.tsx`，与 [规格:1157](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:1157) 的影响面表矛盾。
    - 汇总文档 `openchamber-chat-refactor-ledger.md`、plantree 状态文件和本规格 as-built 回填没有明确归属某片；如果多个施工者各自回填，同样会形成共享文件冲突。

    **建议修法：**把依赖图写成“`① ∥ ② ∥ ③`，三者合入并通过片内测试后，④ rebase 到合并结果；最后由单一集成者修改 D49/plantree/as-built 文档”。补齐片②、片③文件表，并给所有聚合文档指定唯一 owner。不要再使用“真正零混面”描述含后置重叠文件的整个四片方案。

11. **严重度：minor｜规格节号：§2.1～§2.4、§6.7｜主张摘要：关键色值、对比度、warning/primary 同色和 Composer 高度算术均复算成立；但 `muted-foreground` 全仓计数无法按规格数字复现，导致影响面百分比和分面表缺少可审计口径。**  
    **证据：**

    - 当前亮主题 `--primary` 与 `--warning` 分别位于 [globals.css:154](/home/dan/projects/ai-client/src/renderer/styles/globals.css:154)、[globals.css:176](/home/dan/projects/ai-client/src/renderer/styles/globals.css:176)，均逐字为 `oklch(0.5665 0.1523 45.02)`。
    - 当前暗主题对应值位于 [globals.css:206](/home/dan/projects/ai-client/src/renderer/styles/globals.css:206)、[globals.css:223](/home/dan/projects/ai-client/src/renderer/styles/globals.css:223)，均逐字为 `oklch(0.6576 0.1539 49.3)`。
    - 当前 `--tool-arg` 确为 78% 派生，见 [globals.css:195](/home/dan/projects/ai-client/src/renderer/styles/globals.css:195)。
    - 按 OKLCH→Oklab、Oklab 85% 线性混合、转 sRGB、WCAG 2.x 复算：亮 `#6E6D69` 对背景为 **5.0893**，暗 `#888680` 为 **5.0162**，规格的 5.09/5.02 成立；新 muted 值本身分别为 **7.2019/6.7012**。
    - 42→74 和 21→退役的算术也如第 6 条所述成立。
    - 但按可复算命令  
      `rg -o --glob '!**/__tests__/**' --glob '!**/*.test.*' 'text-muted-foreground(?:/[0-9]+)?' src | wc -l`  
      当前结果是 **845**，不是规格 [规格:324](/home/dan/projects/ai-client/docs/plans/2026-08-18-f456-readability-composer-spec.md:324) 的 844；对应 `rg -l ... | wc -l` 为 **154 份文件**，不是 156。chat 子目录计数为 **106**，这一项与规格一致。因此当前可复算比例是 `106 / 845 = 12.544%`，而不是以 844 为分母的 12.6% 口径。

    **建议修法：**在 §2.4-c 直接附上完整扫描命令、排除规则、HEAD hash 和结果；重新生成目录分面表。色值和高度数值无需改，但应把“数值已复算成立”和“用量扫描已更新”分成两种证据，避免正确的色学结论替错误的 inventory 背书。

12. **严重度：minor｜规格节号：§0.6、§2.1～§2.3、§8.2 D2-1｜主张摘要：`color-mix()` 在当前源码/Tailwind/Chromium 路径上可用，但规格若把构建安全归因于 Lightning CSS 则证据不足；当前生产配置并未启用 Lightning CSS minifier。**  
    **证据：**仓库已经在 [globals.css:195](/home/dan/projects/ai-client/src/renderer/styles/globals.css:195) 使用 `color-mix(in oklab, …)`，并通过 Tailwind 主题桥接；依赖为 Tailwind 4.1.18 与 `@tailwindcss/vite`，见 [package.json:50](/home/dan/projects/ai-client/package.json:50)、[package.json:107](/home/dan/projects/ai-client/package.json:107)。renderer 确实加载 Tailwind Vite 插件，见 [electron.vite.config.ts:90](/home/dan/projects/ai-client/electron.vite.config.ts:90)。但 renderer build 没有设置 `build.cssMinify: 'lightningcss'`，见 [electron.vite.config.ts:101](/home/dan/projects/ai-client/electron.vite.config.ts:101)；Vite 只有在该值严格等于 `lightningcss` 时才调用 Lightning CSS，见 [node_modules/vite/dist/node/chunks/config.js:30378](/home/dan/projects/ai-client/node_modules/vite/dist/node/chunks/config.js:30378) 至 [同文件:30386](/home/dan/projects/ai-client/node_modules/vite/dist/node/chunks/config.js:30386)。  
    因而可以确认“该语法已经存在、Tailwind 插件不会要求把它改写成别的形式、目标 Electron/Chromium 可直接解析”，不能确认“生产 CSS 已由 Lightning CSS 实际转换/验证”。此外，规格的 `[D2-1]` 只锁字面量，不执行构建或浏览器 computed-style 核验。  
    **建议修法：**把构建链表述改成“由 Tailwind Vite 管线透传，运行时由 Electron Chromium 解析；当前未显式启用 Lightning CSS”。在 D2 验收中补一个真实 renderer build 加 CDP `getComputedStyle`/CSS custom property 探针，分别在亮暗主题确认 `--tool-arg` 的解析值不为空；无需为了这次改动强行切换 CSS minifier。

修订后开工


Codex session ID: 01a013d0-2938-7e72-8e61-10e80078679e
Resume in Codex: codex resume 01a013d0-2938-7e72-8e61-10e80078679e
