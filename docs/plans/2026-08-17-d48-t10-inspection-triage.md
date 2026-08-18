# D48+T-10 GUI 点验发现批 — 根因分诊（2026-08-17）

> 来源：用户在 `0.4.0-test.5` 真机完整点验（覆盖 D48 四切片 + T-10 深度回归），报告 9 项问题，
> 后追加 2 项证据（stall watchdog 195s 频发、admitted-but-no-reply 文案）与 1 项环境性现象（加密机 xlsx 读取失败）。
> 截图证据 5 张（用户提供，含删除线误判实拍与两种超时报错原文）。
> 方法：五路并行根因调查（timeout-chain / md-strikethrough / model-automatic / ui-batch / rewind-fork；
> 2×opus + 3×sonnet，全部只读，未改任何文件）。总 token 690k，工具调用 283 次。
> 状态：**分诊完成，待拍板分批施工**。拍板结果见文末「拍板记录」。

## 总表

| # | 发现 | 定性 | 根因锚点 | 工作量 |
|---|---|---|---|---|
| F1 | `18~36 µm` 单波浪线被误判删除线 | 缺陷 | `ChatMarkdown.tsx:79`（remarkGfm 无选项 → singleTilde 默认 true） | small |
| F2 | 超时看门狗体系：误报死亡 + 错误回显输入 + 文案矛盾 | 缺陷群（6 个独立缺陷） | 三表体系无共享活性信号，详见 F2 节 | large |
| F3 | Automatic 模型机制（用户咨询）＋附带挖出陈旧钉住缺陷 | 咨询 + 缺陷 | `claudeRuntime.ts:602-608`、`sessionRegistry.ts:100` | small（缺陷部分） |
| F4 | 等待行文案（俏皮动词 + 流量数字） | 体验改进 | `attachments.ts:321-359`；所需数据大多已在渲染端 | small~medium |
| F5 | 用户/助手气泡区分度不足 | **设计基线修订**（非 bug） | 现状是 phase0a 基线「助手完全平铺无容器」的忠实实现 | 待拍板方向 |
| F6 | Composer 单行七件套拥挤，要两行布局 | 体验改进 | session 模式 `composerBarClass` 一行装七件；empty 模式已是两行 | medium |
| F7 | 回退/分叉会话（revert / fork / copy / multi-run） | 新功能 | 双运行时均原生支持定点分支；瓶颈在我方 id 管道 | medium |
| F8 | historyReader 分支盲（调查附带发现） | 潜伏缺陷 | `historyReader.ts:439-450` 无 parentUuid | 另立票 |
| F9 | 加密机 xlsx 读取失败（TSD） | 环境性 | 白名单判定语义待判别测试（用户报 python 在白名单） | n/a |
| F10 | 置顶气泡滚动振荡（追加发现，2026-08-18） | 缺陷 | `scroll-state(stuck: top)` 截断制造滚动位→版面高度反馈环 | small（已修） |

---

## F1 markdown 单波浪线删除线（small）

- **根因**：`src/renderer/components/chat/ChatMarkdown.tsx:79` `REMARK_PLUGINS = [remarkGfm, remarkBreaks]` 无选项调用，
  micromark-extension-gfm-strikethrough 默认 `singleTilde: true`。数字紧贴波浪线（`20~40`）同时满足开/闭侧翼条件，
  段内第一个合格 opener 贪婪配对下一个 closer，跨量程划掉中间文本。已用仓内同版依赖逐字符复现截图现象；
  `{ singleTilde: false }` 后两条样例均完好，`~~真删除线~~` 不受影响。
- **修法**：`[[remarkGfm, { singleTilde: false }], remarkBreaks]`；同步在 `chatMarkdownPolicy.ts:703` 政策注记落决策；
  补 F-C 测试用截图原句（`20~40 µm 的崩边只有 1~2 px`）。
- **同病兄弟位（建议同批）**：`CodeReviewModal.tsx:372`、`MarkdownPreview.tsx:216`（任意 .md 文件预览同样中招）。
- **范围确认**：仅助手消息中招；用户气泡是 `whitespace-pre-wrap` 纯文本不走 markdown（`MessageTimeline.tsx:690-711`）。
- **现有测试**：F-C5 只断言插件名单不断言选项，不需改；无任何用例依赖单波浪删除线。

## F2 超时看门狗体系（large — 按整体重设计，不零敲碎打）

### 现状：三只表，没有一只测「活性」

| 表 | 值 | 位置 | 到期动作 |
|---|---|---|---|
| Host TTFT | 32s 一次性 | `claudeRuntime.ts:115`（env `AICLIENT_HOST_TTFT_TIMEOUT_MS`） | **真 abort 杀回合** → session.failed（Failure A 红横幅） |
| Host stall | 195s 滚动 | `claudeRuntime.ts:95`（env `AICLIENT_HOST_STALL_TIMEOUT_MS`） | 同上 abort |
| Renderer 送信预算 | 45s 纯挂钟 | `attachmentLimits.ts:166`，`ChatComposer.tsx:956/1431-1476` | **不杀回合**（故意，:1749-1759），但 unbindHost + 红报错 + 回显输入 |

### 六个独立缺陷

1. **45s 预算不看活性**：唯一复位条件是 `classifyAssistantProgress === 'assistant'`；Host 发的真活性帧
   （`session.status(running)` 含 retry、`session.stderr`、system/init）全部不可见 → 首 token 慢就 45s 判死。
   用户遇到的「报错后回复又出现」正是它不杀回合的直接证据（Failure B 全属此表）。
2. **「停止等待」与「回合失败」混淆**：到期把猜测当事实走 `decideRunEntryOutcome → 'committed' → 'restore-draft'`
   （`queueRelease.ts:181-256`），对仍在流的回合打红横幅并静默回显输入。
3. **回显草稿不随迟到回复清理**：`clearAbandonMarkerIfMatch`（`ChatComposer.tsx:1929-1946`）清横幅清 retryable，
   **不清已回显的草稿** → 迟到回复落地后输入框里留着一份等着被误发的复制稿。
4. **红卡文案指向不存在的按钮**：`MessageTimeline.tsx:534-536`「点 Retry 重发」对 `status==='failed'` 无条件显示，
   但 committed 态 `shouldArmRetryable` 明确不装 Retry（`queueRelease.ts:226-229`）。
5. **TTFT R9 洞**：`claudeRuntime.ts:751-762` 自注——system/init 到达且无 api_retry 时永远 rearm，
   该形态下 Host 全线失守，45s 渲染端猜测成了唯一权威。代码自己标注「future work」，本批就是那个 future work。
6. **Codex 轴无 Host 看门狗**：仅 30 分钟 RPC ack（`codexRuntime.ts:381`），与渲染端 45s 形成 40 倍哲学错配。

**重要更正（防错修）**：Failure B 报错里 `message.started/delta/completed` 三连是 **用户回声**（role:'user'，
`eventNormalizer.ts:434-473`），判定谓词本身没错——错在 `formatRuntimeEvent`（`ChatComposer.tsx:151-178`）不打印 role，
诊断读起来自相矛盾。**任何「放宽谓词把 message.delta 算进度」的修法都是错的**，会让所有发送瞬间假成功。
另：45s 到期还 `unbindHost()`（:1748）——绑定健康却强迫下一条消息走 resume 握手；Stop 路径此前修过同病
（composerStopStatic.test.ts 钉着），超时路径漏了。

### 修法方向（用户已拍板 300s 量级 + 「明确死亡才回显报错」）

A. 预算抬档：45s→300s（`SEND_BASE_TIMEOUT_MS`），联动 `SEND_TIMEOUT_CEILING_MS`、两个 Host 文档镜像、
   INVARIANT 注记、`SLOW_WAIT_HINT_SECONDS`（现值 45 与预算重合，「Still waiting」文案从未被看见过——死文案复活后需审读）。
B. 活性感知（承重变更）：`assistantProgress.ts` 增设第三信号 `'liveness'`（session.status 任意/ stderr / thinking.* /
   tool.* / usage.updated / subagent.activity / 助手 message.*），TTFT 预算=首活性帧，stall 预算=帧间隔；
   api_retry 连续复位需封顶防无限重试保活。
C. 解耦：预算到期且 `sawUserEcho` 时不 unbindHost、不写 lastError、不 finalize；回合头留「still running · Ns」+ Stop。
   红横幅只在确定死亡（session.failed / stopped / completed 无产出——三谓词已有单测）时出现。
D. restore-draft 只给从未被受理的回合；若保留自动回显则迟到回复必须连草稿一起清；红卡文案与 Retry 装配状态一致化。
E. TTFT 只凭证据 abort（子进程退出/spawn 错/auth 失败/api_retry 达上限），其余降级为警告帧交 stall 表接管。
F. 分工反转（目标形态）：Host 拥有两只狗（唯一能诚实 abort、唯一看得见 api_retry/stderr/exit 的一方），
   渲染端只做展示 + 一个高于 Host 的 300s 安全天花板。**现行 INVARIANT（渲染端天花板 < Host stall）要反转重写**。
G. 诊断诚实：`formatRuntimeEvent` 打印 role。
H. Codex 轴补齐同款活性看门狗（或明确接受渲染端权威，二选一，不能含糊）。

### 牵连的 pin 测试（施工时一并改）

`attachmentLimits.test.ts:216-262`（45/75/105k 与两条跨程序不变量 T-06/a4——F 方向下要重写非重编号）、
`attachments.test.ts:330-464`（逐字文案）、`turnStatus.test.ts`（45_000 + SLOW_WAIT 边界）、
`claudeRuntimeOptions.test.ts:551-800`（F1 证据门 + TTFT 文案判别）、`ttftWatchdog.test.ts`（一次性状态机形状）、
`claudeRuntimePartialStall.test.ts:101-140`、`composerStopStatic.test.ts:235-300`（源文静态断言，C 方向按构造必红）。
文档镜像：`attachmentLimits.ts:176-202`、`ttftWatchdog.ts:1-19`、`claudeRuntime.ts:88-123`、`middleColumnLayout.ts:607-611`。

## F3 Automatic 机制（咨询答复）＋陈旧钉住缺陷（small）

**机制**（按设计工作正常）：`Automatic` 是 UI 哨兵（`models.ts:68-70`），选中即 `clearSessionModel`——存储层记为**缺席**而非值；
发报文时 `toWireModel` 把 undefined/blank/'automatic' 统一编码为**省略 model 键**（`...(model ? { model } : {})`）。
Claude 轴省略键 → CLI 自身默认模型（受 `~/.claude` settings model 影响，D48 S2 已把它降级为目录空时的未验证回落）；
Codex 轴省略键 → app-server 服务端默认。目录四级回落（fresh→stale→seed→Automatic+Retry）的最后一档也是它，
且健康目录里它恒为第 0 行——它不是模型 id，不经家族白名单过滤。

**附带缺陷（Claude 轴独有）**：`claudeRuntime.ts:602-608` 把「本回合没带 model」一律解释为「沿用 session.model 上次钉的」
（`sessionRegistry.ts:100` resume 合并分支同病）。复现链：turn1 Automatic → turn2 选显式模型（钉住）→ turn3 切回 Automatic：
UI 显示 Automatic、wire 真没带键，但 Host 仍发 turn2 的模型，**直到 Host 进程重启**。与 UI 文案
`CLAUDE_MODEL_SCOPE_HINT = 'applies to the next turn'`（改回免费）直接矛盾。Codex 不受影响（sticky 是真服务端语义且文案如实）。
**修法**：删 re-pin（渲染端每回合重申显式选择已由 D48 S2 保障，Host 侧 re-pin 已冗余且有害）；
`claudeRuntimeOptions.test.ts:364-373`「re-pins」用例需退役换新（显式→Automatic 同 live 会话内 query() 必须省略 model）。
保守替代：send 报文加三态（`model: null`=显式清除 vs 缺席=本回合无意见）。

## F4 等待行（small~medium）

- 文案源：`attachments.ts:321-359` `composerSendingLine()`；渲染在回合头 `MessageTimeline.tsx:1348-1365`（非 composer）。
- **已在渲染端、零新管道可用的数字**：elapsed/budget（现有）、附件字节（现有）、**实时输出 token ↓**
  （D33 `usage.updated{interim}` → `outputTokensDisplay`，现只接了 streaming 分支，awaiting 阶段没接）、
  **实时流式字符数**（`turnProgressStamp`，`MessageTimeline.tsx:948-952`，现仅用于 retry 横幅门控，从未曝光）、
  重试计数（现有）。发送侧字符数（↑）：`TurnSendStatus` 加一个字段即可（纯渲染端）。
- **需要 Host 新管道的**：实时输入 token（SDK 的 input_tokens 只在回合结束的 settled usage 里到达）——v1 用字符数替代。
- 俏皮动词：纯文案改（按 elapsed 桶轮换词表）。

## F5 气泡区分度（设计基线修订——先拍板再动工）

现状**不是 bug**：`phase0a-openchamber-alignment.html:431-433` 明文「助手：完全平铺，无容器」，
用户气泡 `bg-card + border-primary/8`（:419-433），代码逐字节吻合（T-30/P-09 注记）。改区分度=修订已验收基线。
两个设计系统合规方向：
- （i）**加强用户气泡**：`border-primary/8 → /16` 或加强 bg，保持助手平铺——最小改动，不违反基线；
- （ii）**助手加中性容器**：`bg-muted + border-border`（design-system 判据 #3 中性提示盒）——直接违反基线那行，须正式修订基线文档。
注意 design-system.md:93-101 明文警告 `bg-muted/bg-secondary` 与 card/background ΔE 近同，不能靠它们表达双层。

## F6 Composer 两行布局（medium）

- session 模式现状：`composerBarClass('session')` 一行装七件（attach/textarea(flex-[2])/statusLine/agent/model/permission/actions），
  textarea 与五控件抢宽度即拥挤根因。empty 模式**已是两行**，仅需确认复用类助手不回归 T-30b2 居中卡。
- 改法：外层 `flex-col` 包装内拆两行——行 1=textarea 独占全宽（撤 flex-[2]/min-w-32），
  行 2=attach + agent + model + permission + actions（`ms-auto` 尾靠），类助手在 `middleColumnLayout.ts` 集中拆分保持可测。
- **待定槽位**：`renderStatusLine`（现骑在 textarea 与 agent 之间）——F4 落地后回合头等待行变富，composer 状态行或可退役；规格期定。
- 实施提醒：五个 leaf 控件未逐个审内部（弹层定位可能有兄弟相对假设），施工前过一遍。

## F7 回退/分叉（medium — 前提被调查推翻：双运行时都原生支持定点分支）

### 能力底座（实证）

- **Claude**：捆包 SDK 0.3.218 `forkSession(sessionId, {upToMessageId})` **全实现**（sdk.mjs 内 in-process：切片、uuid/parentUuid 重映射、
  forkedFrom 戳、新 jsonl；零 spawn 零 token）；`resumeSessionAt`（含式截断、同文件原地分支）；
  双击 Esc 不是 API——是 TUI 内存切片（tengu_conversation_rewind），程序化等价物即上两者。
  文件回滚需 `enableFileCheckpointing + Query.rewindFiles`，受 streaming-input-only 限制（同 setPermissionMode 既有限制），v1 不做。
- **Codex**：`thread/fork{beforeTurnId|lastTurnId}` 在 0.145.0 契约内（fixture 已含名，加 `CODEX_METHOD` 无 fixture 扰动）；
  `thread/rollback` **上游已标 DEPRECATED** 且明言不回滚文件——不用。thread/resume 确认 tip-only（无截断参数）。
- **瓶颈在我方**：Claude live 消息 id 是合成挂钟串（`eventNormalizer.ts:441/478`），SDK `uuid` 在手（:1008）却只喂子代理块；
  仅回放消息（`h:<uuid>`）可作锚。Codex 意外已备好（live 助手 id 内嵌真 turn UUID，`codexNormalizer.ts:517`）。

### 能力矩阵

| 按钮 | Claude | Codex | 判定 |
|---|---|---|---|
| Copy（用户/助手气泡） | 立即可做 | 立即可做 | UI-only；沿用 `turnCopy` 防外传规则 |
| Fork from here | forkSession（免费） | thread/fork（需真回合探针验证） | **v1 主体**：P1+P2+P3 |
| Revert from here | resumeSessionAt 可行但 reader 分支盲挡路 | rollback 已废弃 | **v1 以 fork+切换 别名承载**，破坏性原地版另立票 |
| 文件回滚（Esc 双击全量对齐） | 需 checkpointing+streaming 重构 | 无 | 明确不进 v1 |
| Multi-run from answer | N×fork + 编排 UI（不存在） | 同 | 依赖 fork 先落，后议 |

### 前置件

- **P1 锚 id 上线**（唯一真阻塞，仅 Claude）：`MessageCompletedEvent` 加可选 `runtimeMessageId`（取回合末助手 uuid；
  加法字段有先例，协议版本不动）；拒绝一切位置型回落 id（`t<seq>`/`synthetic-<line>` 等）作锚，否则 CLI exit 1。
- **P2 Host 新命令 `session.fork`**：Claude 臂调 SDK 导出；Codex 臂 `CODEX_METHOD` 加 threadFork，复用 `assertResumePosture`（H9 逐字转移）。
- **P3 姿态继承**：fork 的新 index 行须复制源行 `permissionPreference`，否则 `resolveSessionPermissionPreference` 静默落运行时常量。
- **纪律项**：S2 曾硬约束禁 thread/fork（`2026-08-06-s2-codex-integration-design.md:270`），理由是撕裂「一 session ≡ 一 thread」；
  新设计 fork 得自己的 sessionId+index 行，不变式仍守——但须**正式重批**，不得静默反转既载纪律。
- **开放问题**：① thread/fork 对零回合线程/rollout 时序的行为需真探针（切片 6 借 rollout 法免额度）；
  ② forkSession 在 D47 托管 CLAUDE_CONFIG_DIR 下未演练。

## F8 historyReader 分支盲（另立票，与 F7 无关也该修）

`historyReader.ts` 无视 `parentUuid`，按文件行序平铺回放。真机存量已有分支（55 份 jsonl 中 13 组同型兄弟），
在 CLI 里 rewind 过的会话 resume 进来**今天就会**双分支平铺渲染。SDK 自己的 fork 路径过滤 isSidechain 并走父链；我们两样都没做。

## F9 加密机 xlsx / TSD（环境性，待判别测试）

症状：agent 内 spawn 的 python 读 site-packages 得 NUL 字节（`SyntaxError: source code string cannot contain null bytes`）、
bash source `.bashrc` 报 cannot execute binary file；转 node 链路（CLI Read）即明文。用户报 **python 在白名单**，
故待判别：同一条读首字节命令在「app 内 agent」与「用户直开 cmd」各跑一次——
①乱码②明文=白名单不随进程链传递（升格产品级已知限制）；①②均乱码=加白的不是这份 python；①②均明文=另查。
无论何解，两张小票已识别：null-bytes/%TSD-Header 特征提示（与 D48 裸字节红线同族）、加密机 runbook 补「引导 agent 走 node 链路」。

---

## 拍板记录（2026-08-17 用户拍板）

1. **四批全部开工**：快修小批 · 超时体系重设计批（F2 全量）· Composer 两行+等待行（F6+F4）· 回退/分叉 v1（F7）。
   每批走规格→评审→施工流程；快修小批直接施工（修法已在本档钉死）。
2. **F5 扩范围**：用户补充点验体感——阅读费劲有三因：① 内容太密集（行距/字距过密，需研究合适值、参考其他项目）；
   ② 显示内容与背景对比太弱；③ 用户输入与 agent 输出无区分度。裁定：**先出 HTML 对比稿再拍方向**
   （沿 phase0a 工法，覆盖排版密度 × 对比度 × 气泡区分三个维度的变体）。
3. **thread/fork：Claude 先行，Codex 缓议**——v1 只做 Claude 臂（SDK 进程内、免费、风险低）；
   Codex thread/fork 待真回合探针验证后单独重批。S2 硬约束暂不动。
4. F8（historyReader 分支盲）另立票；F9（TSD）待用户判别测试结果，暂不动工。
5. **F5 对比稿拍板（2026-08-18 用户，对比稿 `docs/design/2026-08-18-f5-chat-readability-draft.html`）**：
   **D1-b**（行高 1.625 舒适档，用现成 leading-relaxed 零新增 token）+ **D2-b**（次要层提档：muted-foreground
   取 Flexoki 官方色阶亮 7.20/暗 6.70，工具参数色修到过 AA）+ **D3-c 与 D3-b 并用**（用户消息非对称右对齐
   85% 宽 accent 底 + 助手加中性容器——用户在设计员明示三层嵌套框反对意见后仍选并用，施工规格须解嵌套：
   助手盒内代码块/表格边框去重方案由规格给出，实现方保留否决权上报）+ **无背景图**（阅读底票不立）。
   连带：正式修订 D26④ 与 phase0a「助手无容器」条款（按归档纪律走修订记录，不静默漂移）。

---

## F10 置顶气泡滚动振荡（2026-08-18 追加，已修 — 快修批二）

- **症状**（用户报）：最后一条用户长发言置顶后，滚向 agent 输出时置顶气泡反复折叠/展开，画面卡在一个位置闪动，需大幅甩动跳过该区段。
- **根因**（RCA 工作流，结构性闭环）：`scroll-state.css` 的钉住态 3 行截断抽走 Δ 高度 → `scrollHeight` 缩小、浏览器把 `scrollTop` 钳到新最大值（恰在底部）→ 掉回 sticky 阈值下解钉展开 → 钳制滚动事件把贴底跟随器误武装 → `ResizeObserver` 执行 `scrollTop = scrollHeight` 推回触发区——每帧一循环。振荡窗口宽度恰为 Δ（约 22.5px/行 × 超出 3 行的行数），短提问 Δ≈0 故此前未显形。次驱动：视口未关 Chromium scroll anchoring。
- **修复**（§9-η 预授权回退 §5.6-B，结构性证明：滚动位→高度的边整条删除，循环图无环）：
  ① `userBubbleTextClass()` 无条件 `line-clamp-6`（`title` 兜底全文；展开控件归 F456 批）；`scroll-state.css` 删除、`fx-turn-band`/`fx-turn-bubble-text` 钩子退役；
  ② 视口 `overflow-anchor: none`；
  ③ 跟随器改 `nextFollowState` 纯步进函数：不在底=必解除；在底但本帧高度变化=保持原值（无用户意图证据）；在底且高度稳定=武装。幂等性有测试钉住（振荡序列不可表示）。
- **不变量固化**：`scrollStateCss.test.ts`（styles 目录任何 scroll-state 块 paint-only 白名单）+ `chatTimelineLayout.test.ts` F10 三例（无条件裸 clamp）+ `messageTimelineScroll.test.ts` 五例（缩高钳制不可武装 + 幂等）。变异三臂全咬合。
- **文档修正**：design-system.md scroll-state 节改退役记录（lightningcss 教训保留）；reply-anatomy 规格附 as-built 修正；probe 结论标注「解析性≠可用性」。
- **GUI 点验项**（不可断言半边）：20+ 行提问 + 短回复，两种视口高度下慢滚过边界——无闪动、滚动行程单调。随下轮点验批执行。

## F2 追加现场证据（2026-08-18 用户截图两张，test.5，Claude Opus 5/Medium）

**同屏自相矛盾标本**：蓝色重试横幅「Upstream error 503 — retrying 3/10, the turn is still running ·
Next attempt in 2s」与红色报错「No assistant/tool progress after send」同时在屏，后者的 rawEvents 内
明确含 `session.status(running,retry 1/10)` 活性帧——45s 预算对真活性帧视而不见的原文实证（缺陷 1），
且回显输入与「the turn is still running」并存（缺陷 2 的可见形态）。已注入 F2 rev.2 §12 作
**incident 回归夹具**（规范 #8 + D5 拍板回退性依据）：断言该序列下 300s 活性预算被 retry 帧复位、
绝不进判死/回显分支；负控「重试横幅可见时不得出现 no-progress 报错」。
