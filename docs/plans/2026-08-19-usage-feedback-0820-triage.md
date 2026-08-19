# 0820 使用反馈批分诊（2026-08-19）

> 来源：用户 2026-08-19 提交实际使用问题八点 + 截图四张（`/home/dan/projects/sharefile/0820/11~44.png`）。
> 调查：四路并行（渲染管线 / 回合折叠模型 / shell 污染链 / 既有拍板对照，sonnet ×4，412k tokens，workflow `wf_99291c39-224`）。
> 编号沿用反馈票系列，本批 = **FB1~FB11**（T-10 批 F1~F13 已占用，避免撞号换前缀）。
> 状态：分诊完成，§4 三项拍板已收口（**D53**，2026-08-19 当场问答）。

## 1. 分诊表

| # | 现象（用户原话/截图） | 根因（file:line） | 归因 | 修法与量级 | 处置 |
|---|---|---|---|---|---|
| FB1 | 「全部流式输出完才渲染」——流式期标题显 `#`、围栏显反引号，结束瞬间整体重排 | `shouldRenderMarkdown`（`chatMarkdownPolicy.ts:326-328`）：流式期纯文本，`message.completed` 才切 markdown（`MessageTimeline.tsx:1555-1564`）。**这是 D26/T-29 既定设计**（2026-07-30 拍板、`d320206` 落地、当日 GUI 验收），理由 = 防围栏未闭合频闪 | 设计改判（用户新要求推翻 D26） | **渐进渲染方案 a**：结构闭合的块实时切 markdown，仅未闭合尾部保持纯文本——兼得「实时样式」与「不频闪」（D26 当年真正要防的）。M 档，改 `chatMarkdownPolicy` + 调用点 | **直修**（用户已明示要求，D26 改判随批记档） |
| FB2 | 「代码/bash 指令应有 copy 按钮」 | `ChatCodeBlock.tsx:57-76` 纯 `<pre><code>`，全聊天面唯一 copy 是整回合 `TurnCopyButton`（且按安全设计排除 tool IN/OUT——`turnCopy.ts:6-10` 防外泄路径） | 缺陷（正文块）+ 安全边界（工具块） | 正文代码块加悬浮 copy（S）；**工具 IN/OUT 块是否加 = 安全边界改判，见 §4-Q1** | 正文块**直修**；IN/OUT 待拍板 |
| FB3 | 「用户历史输入默认折叠看不到全文」 | `userBubbleTextClass()` 无条件 `line-clamp-6`（`chatTimelineLayout.ts:87-89`）——F10（2026-08-18）修 pinned 气泡滚动振荡时的兜底；**无点击展开**，F456 规格 §3.4④ 明确「本批不做展开开关、另立票」（票至今未立） | 已登记欠账（非静默回归） | 气泡加点击展开/收起开关（复用 `title` 全文数据），S/M | **直修**（即本欠账立票并随批做） |
| FB4 | 「正文被收进 Worked for 组，只有最后一小块在气泡里」 | `splitTurnBody()`（`chatTurn.ts:168-176`）：answer = 仅末尾连续 text 段，**之前所有正文（含中间叙述）全折进 process**。**这是 T-31 A07 v5 既定设计**（2026-07-31 规格 §4.2/§4.4，源自用户当时提供的 Cursor 参考图，GUI 验收过） | 设计改判（用户新要求推翻 T-31 折叠范围） | 改 `splitTurnBody`：**所有 text 段恒在折叠组外**（Thinking/工具行/授权卡仍可折叠），保持交错顺序展示。M 档 | **直修**（用户已明示「每段正文独立不可折叠」，T-31 改判随批记档） |
| FB5 | 「会话中断/折叠后输出会不会丢？」 | 折叠纯 UI：`keepMounted` + hidden attribute（`MessageTimeline.tsx:1276-1290`、`chatTimelineLayout.ts:106-133`）；重载走 `mergeReplayedHistory`「never drops a runtime message」（`chatSessions.ts:557-563`） | 无缺陷 | 无需修 | **答复用户：不丢**，仅折叠开合状态不跨重载记忆 |
| FB6 | 「worked for/↑↓ 流量应在输出最下方动态显示，而非顶部」 | head 槽恒为回合首子元素（`MessageTimeline.tsx:1259-1298`），流式/完成两态同槽（T-31 §4.7「同一槽位两态」）；截图 22 底部「Finagling…」是 `PendingTurnHead`（握手窗口挂时间线末尾，`MessageTimeline.tsx:526-528`） | 设计改判（推翻 T-31 §4.7 槽位） | 状态/统计行移至回合**底部**：流式中跟随内容尾部动态更新，完成后停驻底部；折叠触发器可留顶部或随行合并——形态施工时按截图对齐。M 档 | **直修**（用户已明示；T-31 §4.7 改判随批记档） |
| FB7 | 每工具调用两行：`Ran X` + `Allowed Bash — X` 铺屏翻倍 | D24 row-per-block + D28 permission 收单行两个决策的**涌现副作用**，从未联合评估（`toolCard.ts:164-167` 独立 item kind；合并需 permissionId↔toolCallId join，无纯模块做过）；无任何 G/F 点验项覆盖 | 设计盲区 | 合并进所属工具行（跨 `toolCard`/`questionCardModel`/`chatTurn`，L 档）或收窄样式（S 档） | **待拍板**（§4-Q2） |
| FB8 | `Thought for 1702s` 裸秒不换算 | `formatThoughtRow`（`turnTiming.ts:110-130`，:127 裸 `${Math.round(ms/1000)}s`），兄弟函数 `formatWorkedForDuration` 有分钟换算；测试只钉了 12s 档 | 缺陷 | 复用分钟换算 + 补分钟级测试臂，S | **直修** |
| FB9 | LaTeX `$$…$$` 原样输出 | 无 math 插件：`REMARK_PLUGINS=[remarkGfm, remarkBreaks]`、`REHYPE_PLUGINS=[]` 为安全策略锁定（`ChatMarkdown.tsx:40-48,85-91`，加项须过评审 + 扫描测试改判） | 功能缺失 | `remark-math` + `rehype-katex` + CSS，M 档含安全评审 | **待拍板**（§4-Q3） |
| FB10 | 每个 Bash OUT 首行 `.bash_profile: line 3: .: .bashrc: cannot execute binary file` | **全链在上游 CLI + 用户机**：vendored CLI shell snapshot 机制开会话时用 login shell 建快照，source 到二进制（大概率 UTF-16/BOM）`~/.bashrc` 失败 → 快照 Promise 整会话缓存 undefined → **每次 Bash 调用都回落 `-l` login shell** 重新 source 报错（cli.js ~:3473）。本仓不写 rc 文件、不强制 login shell、不改写 tool_result（`eventNormalizer.ts:240-258` 原样转发），三方向排查均零命中 | 用户机配置 + 上游机制 | **用户机修复**：`~/.bashrc` 重存为 UTF-8 无 BOM（或从 `.bash_profile` 去掉 source 行）；修好后快照快路径恢复、`-l` 不再追加。同机跑官方 CLI 亦会逐字复现。显示端过滤该噪声行**不推荐**（掩盖真实回落） | **给用户指引**，本仓不改码 |
| FB11 | 「明显慢于 CLI/VSCode 插件」 | 事件管线实测健康：`ChatTurn` memo 纪律完好（`STATIC_NOW_MS` 哨兵保 memo 恒等，重渲染 O(在飞回合)）；仅两级合批窗口串联（Host `COALESCE_WINDOW_MS=45` + 渲染 `RUNTIME_EVENT_FLUSH_MS=16`，合计 ~61ms 块状出字）。**主观慢的主因 = FB1 纯文本观感 + FB2/FB9 叠加的粗糙感** | 观感（非管线缺陷） | FB1 修后重评；如仍块状，两个常量可调（均有测试覆盖），S | FB1 修后**真机重评** |

## 2. 既有拍板改判清单（随批记档，防后续读档打脸）

| 旧决策 | 原内容 | 本批改判 |
|---|---|---|
| D26/T-29（2026-07-30） | 流式期纯文本、完成后切 markdown（防频闪） | 改为渐进渲染：闭合块实时 markdown、未闭合尾部纯文本（FB1）。「防频闪」目标保留，手段升级 |
| T-31 §4.2/§4.4（2026-07-31） | Worked-for 展开体 = Thinking + 工具行 + **中间正文** | 中间正文移出折叠组：所有 text 段恒可见（FB4） |
| T-31 §4.7 | 状态/Worked-for 同槽两态，居回合**顶部** | 移至回合**底部**动态跟随（FB6） |
| F10 头注（2026-08-18） | 展开开关记在「F456 批」名下 | F456 规格已纠正为另立票；本批即立即做（FB3） |
| D33（2026-08-14） | Composer 内状态行禁俏皮动词 | **不受本批影响**——与 F456 ④ 回合头等待行是两条不同的行，无矛盾（调查确认） |

## 3. FB10 用户机修复指引

1. 在 git-bash 里跑 `file ~/.bashrc`——若显示 `UTF-16` / `data` 即坐实编码损坏。
2. 用编辑器将 `C:\Users\JC\.bashrc` 另存为 **UTF-8（无 BOM）**；或若内容不需要，直接从 `~/.bash_profile` 删除第 3 行的 `. ~/.bashrc`。
3. 重开会话验证：Bash 工具结果首行不再出现该报错（快照快路径恢复后 login shell 回落也随之消失）。

## 4. 拍板记录（当场问答，回填）

| # | 议题 | 拍板 |
|---|---|---|
| Q1 | 工具 IN（命令）/OUT（结果）块是否也加 copy（安全边界 `turnCopy.ts:6-10` 改判） | **范围澄清（D53 ①）**：用户所指为**正文里输出给用户执行的指令**（如 git push）= markdown 代码块 copy（FB2 原定范围）；工具 IN/OUT 块**不加**，安全边界不动 |
| Q2 | FB7 Ran/Allowed 双行：合并（L）/样式收窄（S）/维持 | **合并进工具行**（D53 ②，L 档本批做） |
| Q3 | FB9 LaTeX 渲染：本批做（M+安全评审）/另立/不做 | **本批做**（D53 ③，含 rehype 插件位安全评审） |

**本批已定范围（用户 2026-08-19 反馈原文即拍板，无需重问）**：FB1 渐进渲染 · FB2 正文代码块 copy · FB3 气泡展开开关 · FB4 正文移出折叠组 · FB6 状态行移底 · FB8 时长格式化。FB5/FB10 为答复与指引项，FB11 修后重评。
