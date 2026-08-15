# S3 切片 5 施工规格 — Codex 历史（5a 显式降级 + 5b thread/resume 重投影）rev.2

> 2026-08-15。plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。上游：[S2 设计档 §3 切片 5](./2026-08-06-s2-codex-integration-design.md)。
> **rev.2 = 双轨双盲对抗评审合取修订**（deep-reasoner 失败态镜头 5 blocker + 7 major + 7 minor；Codex 证据镜头 1 blocker + 3 major + 1 minor；四处独立命中同点；评审记录与分歧仲裁见 §7）。rev.1 原文以 git 历史为准（`5987113`）。
> S2-d 原档（G1–G12 可执行形式）确认失传——本档按仓内证据重生成。取证：四路 recon workflow `wf_bf03ccc7-b13` + **U2-a 真实回合**（[fixtures README「S5 追加捕获」](../../src/agent-host/__tests__/fixtures/codex/README.md)）。
> 标注纪律沿用 S2：`[实测]` / `[读码]` / `[推测]`。

---

## 0. 取证对 S2 的推翻与收窄（rev.2 修订后）

| # | S2 原表述 | 取证结论 | 后果 |
|---|---|---|---|
| F1 | 5b id 方案 `h:codex:<threadId>:<itemId>` | 重投影 item id 是 **turn 内位置序 `item-N`**，跨 turn 必碰撞 [实测]；`turns[].id` 是 uuid [实测] | 消息 id = **`h:codex:<threadId>:<turnId>:<itemId>`**；**块 id 与 toolCallId 同域改写**（M8）：reader 在 mapper 产物上统一加 `codex:<threadId>:<turnId>:` 前缀（mapper 本体不动）；itemId 缺失→位置序 `item-pN`、turn.id 缺失→`turn-N`（m17） |
| F2 | 「replay-merge 去重（若 id 不等改按 toolCallId/文本）」 | 实时 id 与重投影 id 两个空间 [实测]；重投影**整类丢** reasoning/commandExecution（`itemsView:"full"` 的回包仍如此；同进程 `thread/turns/list` 同样只回 2 个 → 存储性质。注：full/summary 是**回包里观察到的值**，非我方请求变体，m19）[实测] | 按 id 去重判死；toolCallId 去重救不了缺失 item。**既有 fold 兜不住 codex**（M9/Codex-major 双轨同判）：codex 实时链一回合单条 assistant 消息挂 reasoning/tool 块 → 永不可 fold，且 merge 把保留行整体追加到历史**之后**（重排）[读码 `historyReplayMerge.ts:153-161,259`] → 登记 **L6** + **G14 钉现行为**；B1 的「活连接不重投影」分支收窄暴露面 |
| F3（rev.2 修正） | 「thread/resume 唯一可用」 | **唯一不可用的是 `thread/items/list`**（-32601）[实测]；`thread/read` 恒 `turns:[]` [实测]；`thread/resume` 与 `thread/turns/list` 都能回 items 且内容一致 [实测]；resume 回包带 `initialTurnsPage`/`turnsBackwardsCursor`/`itemsBackwardsCursor` 三个分页键（单 turn 下均 null）、turns/list 带 `nextCursor`（M6）[实测] | 冷恢复用 `thread/resume{threadId}` 单键（兼续跑）；**已有活连接的历史补读用 `thread/turns/list`**（无 resume 副作用，B1）；**任一分页 cursor 非 null → `truncated:true`**（诚实优先；全量翻页另立 L7） |
| F4 | （S2 未覆盖）resume 权限姿态 | `thread/resume` 从 CODEX_HOME 的 config.toml **重新派生**权限（字段级对上：`on-request`/`danger-full-access`/`user` 逐字来自探针机的真实 config）[实测]；我方隔离投影**有意剥掉** `approval_policy`/`sandbox_mode` [读码]；**resume 回显里 `networkAccess` 键恒缺失** [实测]；仓内已有 `compareSandboxEcho` 但为 **advisory 语义**（部分字段缺失可判 match，create 路径仅 WARN）[读码 `codexRuntime.ts:275-377,825-831`] | 硬约束 **H9（rev.2 细化）**见 §4 |
| F5 | C7/U6/U7（listHistory 扇出） | `session.historyListed` 零渲染端消费者、事件无 sessionId 必被 reducer 早退吞掉、Host 从未读 `agents[]`、侧栏数据源是 `chat.listSessions`（双轨 + recon 三方证实）[读码] | **扇出砍出本片**（待裁 P1）；`agents[]` 类型维持不接线 |
| F6（rev.2 新增） | rev.1 引 C11 称「jsonl_not_found 文案已去 JSONL 字样」 | **不实**：guidance 仍含「历史文件（JSONL）」、dead-session hint 承诺 Claude CLI 专属报错串 [读码 `historyError.ts:52-64`]（M11） | 本片顺带把两段文案改 agent 中性 + 测试钉住；「渲染端零改动」修正为「渲染端仅文案与测试」 |

## 1. 范围

### 5a — 显式降级契约（先落；最终态 = 「无 reader 的 agent」default 分支，永不删）

1. `codexRuntime.resumeSession` 前置守卫（**顺序固定**，B1/B2/M10）：
   - **① busy 守卫**：`state?.turn !== null || registry.get(sessionId)?.running` → 镜像 Claude 发 `host.error{code:'session_busy', fatal:false}` 并 return（**H10 例外一**，理由：会话已活着可用，此时注入历史错误横幅是错误语义；Claude 先例 `claudeRuntime.ts:360-375`；registry 自身契约要求调用方拦 [读码 `sessionRegistry.ts:72-76`]）；
   - **② agent 冲突守卫**：registry 既有条目 `agent !== 'codex'` → `host.error{code:'agent_conflict', fatal:false}` 并 return，**禁止**靠 `registry.resume` 覆写（它有意不合并 agent [读码 `:70-81`]；**H10 例外二**——不能对拒绝拥有的会话谎发 resumed）；
   - **③ 活连接守卫**（B1）：`this.sessions.has(sessionId)` 且连接 alive → **不 spawn**，复用现有连接以 `thread/turns/list` 补读历史（F3），照常发三连；`connect` 工厂全程只被调用一次（G 断言）。
2. 降级主体（无 reader / 5a 独立落地态）：**先绑定**（`registry.resume{agent:'codex', runtimeIdentity, …}`）→ 三连：
   - `session.resumed{agent:'codex', runtimeIdentity}` →
   - `session.history` **全字段**（B5）：`{runtimeIdentity: threadId, workspacePath, messages: [], truncated: false, omittedCount: 0, agent: 'codex', error: {code:'history_unsupported', …}}`，且 **requestId 全程透传**（renderer 的 resume 快照按 requestId 配对 [读码 `chatSessions.ts:479` / `historyReplayMerge.ts:121-131`]）→
   - `session.status{idle}`。零 host.error、零连接 spawn。
3. 5a 态 send：无 state → 既有 `host.error{code:'session_not_found', fatal:false}` 路径，Composer 有 sessionId+requestId 关联捕获，非静默且不卡 busy [读码，Codex 轨验证]。**诚实性修正（M12）**：`history_unsupported` 的 continuationHint 不得承诺「可以继续发送」→ 文案改法待裁 **P2**。
4. 渲染端改动仅限：M12/F6 三段文案 + 测试（G3/G14 及文案钉）。banner/图标/Retry 机制零改动（全链已就位 [读码]）。

### 5b — 真 resume（历史重投影 + 运行时续跑一条链）

1. `codexHistoryReader.ts`（纯函数为主）：`thread/resume` 回包 → `HistoryMessage[]`：
   - 逐 item 过 **`mapCodexItem`**（与实时链共用；**不得**碰 `CodexNormalizer.ingest` [读码]）；空 blocks（not_rendered）整条略过；
   - id/块 id/toolCallId 按 F1 域改写；时间戳（m16/Codex-minor）：userMessage = `turn.startedAt×1000`、末位 agentMessage = `turn.completedAt×1000`（completedAt null → 回落 startedAt），其余 item 取 startedAt；G4 断言具体值；
   - **上限与诚实截断**（M7）：沿用 Claude 侧 `HISTORY_MAX_MESSAGES` 级常量与头部淘汰 + `omittedCount`；**分页 cursor 非 null → `truncated:true`**（M6）。
2. `resumeSession` 全链（**与 createSession 同构**，B3）：
   - 守卫①②③（同 5a）→ `ensureCodexHome` → spawn 连接 → **立即** `this.sessions.set(state)` + `registry.resume(...)`（**在 initialize 之前**——resume 窗口不安静：MCP 启动通知/elicitation 可能到达，无 state 的服务端请求会被静默丢弃 [实测 fixture 第 5-8 行 + 读码 `codexRuntime.ts:900-901,1047-1048`]）→ initialize → `thread/resume{threadId}` 单键；
   - **resume 窗口内压住 status mapper 出声**（m13）：`session.resumed` 发出前 mapper 不得先发 `session.status`；G 按有序子序列断言兜底；
   - **成功**：H9 校验过 → 发 `session.resumed` → `session.history{messages, 全字段, truncated 如实}` → `session.status{idle}`；连接留作会话活连接（**resume 即续聊**）；
   - **失败路径一律 `teardown()`**（drain pending → interrupt → dispose → delete state + registry 状态收敛），**然后**三连降级（B3；G7 断言 teardown 三步而非仅进程死）：thread 不存在→`jsonl_not_found`（文案已中性化，F6）；spawn/initialize/超时→`read_failed`；H9 不过→`read_failed`（message 写明权限姿态原因）；无 reader→`history_unsupported`。
3. `history_unsupported` 分支保留为 default（5a 代码即最终 default）。

### 明确不做（登记）

- listHistory codex 扇出 / U6 errors[] / U7（F5，P1）；跨源 id 对齐去重（F2）；重投影缺行的 UI「部分历史」指示（L1）；merge 重排的口径改造（L6，agent 无关既有行为）；分页全量翻页（L7）；`historyMode`/`itemsView` 处理（L2）；`thread/fork`（C12）；协议升版（禁）。

## 2. 验收 G 表（rev.2）

| G | 断言 | 层 |
|---|---|---|
| G1 | resume 后 registry 绑 codex，send/stop/close 路由 CodexRuntime。**负控三条**：① spawn 失败降级后 send 仍进 CodexRuntime（拒绝路径也绑定）；② registry 已有 claude 条目 → `agent_conflict` 拒绝、零 spawn、无三连；③ busy 会话 → `session_busy` 拒绝、旧 state/turn 原样无恙 | Host 单测 |
| G2 | 5a 三连有序子序列 + `session.history` **全字段等值断言**（runtimeIdentity=threadId / workspacePath / truncated:false / omittedCount:0 / agent / error.code / requestId 透传）；零 spawn | Host 单测 |
| G3 | 渲染端增量：`history_unsupported` 走 reducer 端到端置 historyErrors + banner 视图 severity=warning + **Retry 不渲染**（visible:false，非 disabled，m14）+ composer 不禁用；文案钉（M12/F6 新文案） | 渲染端单测 |
| G4 | reader 喂真实夹具 `codex-s5-thread-resume.jsonl` → 恰 2 条 HistoryMessage；id 含 threadId+turnId；**时间戳等值 `1786767552000` / `1786767565000`** | Host 单测（真帧） |
| G5 | 合成两 turn 输入：**消息 id、全部块 id、toolCallId 三个域全局唯一**（M8）；itemId/turn.id 缺失走位置序兜底不产 `undefined` 拼串 | Host 单测 |
| G6 | 成功 resume 全链（**内存 transport 驱动真实 connection 核**，m15，禁手写 stub 自证）：`thread/resume` 带且只带 `{threadId}`；state+registry 在 initialize 前就位（窗口内到达的服务端请求有 state 可查）；有序子序列 resumed→history→idle；连接保留、后续 send 的 `turn/start` 打同一 threadId | Host 单测 |
| G7 | 失败四分法（jsonl_not_found / read_failed×2 / history_unsupported）各自：**teardown 三步观测**（pending drain + dispose + state 删除）→ 三连降级全字段 → 无进程/监听残留 | Host 单测 |
| G8 | **H9**：① codexHome 投影 config 含 `approval_policy`/`sandbox_mode` 且与 `CODEX_PERMISSION_DEFAULT` 单一真相（等值断言）；② resume 回显 **approvalPolicy+sandbox.type 两维**任一 mismatch **或 missing** → fail-safe teardown+read_failed；③ **负控四条**：完全无回显 / 只回 approval / 只回 sandbox / networkAccess 缺失（**最后者必须通过**——该键 resume 恒不回显 [实测]，只查两维）；④ create 路径 advisory 语义不动（回归钉） | Host 单测 |
| G8b | **施工期免额度真机正例**（`thread/start`/`thread/resume` 不花额度）：隔离 CODEX_HOME + 新投影 → start 回显、restart-resume 回显均两维 match。**条件执行**：若正例不过（token 归一化坑），fail-safe 降级为 WARN + 登记，不得带病转 fatal | 施工现场 |
| G9a | mapper 契约照真帧：重投影形状的 userMessage（content[] 型）/ agentMessage（text 型）→ rendered（固定夹具回归，**只**证明 0.145.0 形状） | Host 单测 |
| G9b | **升级门禁（人工，防 false-green——固定夹具永不自己变红 [Codex 轨]）**：codex 版本升级流程 = 重跑 capture 探针 + 比较 `thread/resume` 的 item type 集合，出新类型即审 reader；写进 fixtures README 升级段 | 流程 |
| G10 | flag off：resume 在 index.ts 门口 `agent_unsupported`（回归） | Host 单测 |
| G11 | Claude 端到端零变化；全量 vitest 0 红 | 门禁 |
| G12 | 协议版本===1、索引裸数组断言仍绿 | 既有钉 |
| G13 | 拆两半（m15）：渲染端半——`sessionIndexMerge`+`resumeIntent` 从索引行产出含 agent+runtimeIdentity 的 resume args（既有测试补 codex 例）；Host 半——resume 命令带索引里的 threadId → mock 连接断言 `thread/resume` 收到同值；真机 CDP 挂下轮点验单 | 双侧单测 |
| G14 | **钉现行为**（M9/L6）：真实四 item 实时 bucket + 两 item 重投影历史过 merge → 断言当前输出（fold 命中面 + 保留行追加在后）——把重排写成已知事实而非意外 | 渲染端单测 |
| G15 | 分页与上限：合成「cursor 非 null」回包 → truncated:true；合成超限多 turn → 头部淘汰 + omittedCount>0 | Host 单测 |

## 3. 施工顺序

1. **5a**：守卫①②③ + 降级契约 + 文案两处 + G1/G2/G3/G10 → 四门串行；
2. **5b-reader**：纯函数 + G4/G5/G9a/G15；
3. **5b-runtime**：同构全链 + codexHome 投影扩展 + G6/G7/G8/G13 + **G8b 现场正例** → 四门串行 + 变异验证；
4. 收口：G11/G12/G14 + 台账 + plantree + G9b 写进 README。

## 4. 硬约束（S2 附表 8 条承继 + 三条）

- **H9（rev.2）**：Codex resume 的权限姿态三层防御——① 隔离 config 投影写 `approval_policy`/`sandbox_mode`（与 `CODEX_PERMISSION_DEFAULT` 同源单一真相；**注意它是全应用共享持久文件：常量或版本一变，下一次 resume 即重定老 thread 姿态**，m18）；② resume 回显 **approvalPolicy + sandbox.type 两维严格**（mismatch/missing 皆 fail-safe）；③ `networkAccess` 维 resume 恒不回显 [实测] → 只由 config 层承载，事件 message 注明「network 维未校验」。create 路径维持 advisory（S2 硬约束 7 禁因校验挂回合；不对称理由：create 姿态由我方 thread/start 参数显式下发，resume 姿态源头是 config——回显是唯一证据）。
- **H10**：resume 失败一律 `session.history{error}` 三连收尾，不得 host.error 收尾。**两个例外**（都不是「resume 失败」而是「拒绝受理」）：busy → `session_busy`、agent 冲突 → `agent_conflict`（§1 理由）。
- **H11（新）**：resumeSession 的一切 I/O（spawn/initialize/resume）之前，state 与 registry 绑定必须已存在；一切失败经 `teardown()` 清态后才发降级三连。

## 5. 遗留登记

- **L1** 重投影缺 reasoning/commandExecution（0.145.0 存储性质）——G9a 只钉现状，升级哨兵走 G9b 人工门禁；「部分历史」UI 指示另立。
- **L2** `historyMode`/`itemsView` 零消费观察项，并入 G9b 升级流程一并看。
- **L3**（已结）5a 态 send 形状 = `host.error{session_not_found}`，渲染端有关联捕获 [读码]；诚实性归 P2。
- **L4** historyErrors 清除的端到端已有覆盖 [读码 `chatSessionsHistory.test.ts:423-438`]（rev.1 误判缺口，m14 更正）；G3 只补 history_unsupported 例。
- **L5** 真帧夹具仅单 turn/两 item；多 turn、含审批/问答 thread 的重投影未捕获（额度已花完，下次真实使用时截获 + G9b）。
- **L6** codex 同进程 resume 的 merge 重排/重复（agent 无关既有 merge 口径 × codex 单 assistant 消息形态）——G14 钉现状，口径改造另立。
- **L7** 分页全量翻页（`thread/turns/list` + cursor）——本片只做诚实 truncated，翻页另立。

## 6. 待裁定（P1/P2 当场问）

- **P1（用户）**：listHistory 的 codex 扇出砍出本片（F5 三方证据）。默认：砍。
- **P2（用户）**：5a/`history_unsupported` 的 continuationHint 诚实化文案（M12：现文案承诺「可以继续发送」，而 5a 态每次 send 必收 `session_not_found`）。

## 7. 双轨评审记录（合取仲裁）

- **独立命中同点四处**（可当定论）：先绑定顺序（DR-B3 / Codex-blocker）；registry 不合并 agent 的冲突面（DR-M10 / Codex-blocker）；merge 重排（DR-M9 / Codex-major2）；时间戳规则欠定（DR-m16 / Codex-minor5）。
- **单轨独有全采纳**：DR——B1 连接泄漏、B2 busy 守卫、B4 unverifiable 语义、B5 payload 抹字段、M6 分页、M7 上限、M8 块 id、M11/M12 文案诚实性、m13~m19；Codex——G9 false-green 哨兵、`compareSandboxEcho` 已存在的事实、L3 精确形状。
- **分歧一处，合取裁定**：H9 严格度——Codex 主张三维全严 vs DR 实证 `networkAccess` resume 恒不回显（全严=resume 必死）。裁定 = 两维严格 + 第三维 config 层承载 + G8b 免额度真机正例条件执行（互补反例合取，非二选一）。
- **编排者对 DR 一处修正**：B2 建议 busy 拒绝走三连+read_failed——否决，改镜像 Claude 的 `session_busy`（对活会话注入历史错误横幅是错误语义），H10 开例外并记理由。
