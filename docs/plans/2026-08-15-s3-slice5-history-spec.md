# S3 切片 5 施工规格 — Codex 历史（5a 显式降级 + 5b thread/resume 重投影）rev.1

> 2026-08-15。plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。上游：[S2 设计档 §3 切片 5](./2026-08-06-s2-codex-integration-design.md)。
> **S2-d 原档（含 G1–G12 可执行形式）确认不在仓内**（全 docs grep 仅 S2 档引用）——本档按仓内证据**重生成 G 表**，与切片 4「取证重生成契约」同一路径。
> 取证来源：① 四路只读取证 workflow `wf_bf03ccc7-b13`（Host / 渲染端 / 契约与 mapper / 切片 1 链路）；② **U2-a 真实回合**（U9 拍板预算内的 1 个，探针 `spikes/s5-u2a-history-probe.ts`，判决与新夹具见 [fixtures README「S5 追加捕获」](../../src/agent-host/__tests__/fixtures/codex/README.md)）。
> 标注纪律沿用 S2：`[实测]` / `[读码]` / `[推测]`。

---

## 0. 取证对 S2 的推翻与收窄（五条，写码前锁定）

| # | S2 原表述 | 取证结论 | 后果 |
|---|---|---|---|
| F1 | 5b id 方案 `h:codex:<threadId>:<itemId>` | **重投影 item id 是 turn 内位置序 `item-N`**（`turns[0].items[]` = item-1/item-2），跨 turn 必碰撞 [实测] | id 改为 **`h:codex:<threadId>:<turnId>:<itemId>`**（turnId 为 uuid，capture 有据） |
| F2 | 「replay-merge 去重（若 id 不等改按 toolCallId/文本）」 | **实时 id 与重投影 id 是两个空间**（uuid/`rs_…`/`exec-…`/`msg_…` vs `item-N`）[实测]；且**重投影整类丢 item**：reasoning 与 commandExecution 不进 `thread/resume` 回包（4 个实时 item 只回 2 个，`itemsView:"full"` 仍如此；同进程 `thread/turns/list` 同样只回 2 个 → 是存储/压缩性质，非 restart 特有）[实测] | 按 id 去重**判死**；按 toolCallId 去重**也救不了缺失 item**（item 整个不在）。5b 不做跨源去重——依赖既有 `historyReplayMerge` 的 fold（text/thinking-only，宁多勿丢）兜同进程重放；**重投影缺工具行/思考行登记为已知限制 L1** |
| F3 | 「reader = `thread/resume` 不传 `excludeTurns`」 | 证实且**唯一可用**：`thread/read` 恒不带 turns（`turns:[]`）、`thread/items/list` 服务端未实现（-32601）[实测]。`excludeTurns` 本身零证据（探针只发过 `{threadId}` 单键）——「不传」是唯一有实证的路径 | reader 定死 `thread/resume` `{threadId}` 单键；不实验 excludeTurns |
| F4 | （S2 未覆盖）resume 的权限姿态 | **`thread/resume` 从 CODEX_HOME 的 config.toml 重新派生权限，不继承原 thread 的 start 参数**：原 `never/read-only` 起的 thread，restart-resume 回显 `on-request` + `dangerFullAccess`（探针跑在真实 `~/.codex` 下）[实测]。而我方隔离 config 投影**有意剥掉** `approval_policy`/`sandbox_mode`（`codexHome.ts:78-108`，因姿态原在 thread/start 参数层）[读码] → **resume 后姿态失控** | 新硬约束 **H9**（见 §4）：隔离 config 投影补写权限键 + resume 回显校验，失败即 fail-safe |
| F5 | C7/U6/U7（listHistory 扇出 codex + per-agent errors + 临时 spawn） | `session.historyListed` **零渲染端消费者**（事件无 sessionId，reducer 顶部早退必吞；grep 零命中）[读码]；侧栏列表只读 `session-index.json`（主线 handoff 口径）；Host 侧 `agents[]` 参数已进类型但 index.ts 从未读 [读码] | **listHistory 的 codex 扇出砍出本片**（做了也是死代码）；`agents[]` 参数维持「类型在、不接线」现状；U6 的 errors[] 协议加法**不落**。→ 待裁定 P1（§6） |

## 1. 范围

**5a — 显式降级契约（先落，落地后永不删；最终态是「无 reader 的 agent」的 default 分支）**

Host 侧（渲染端零改动——`history_unsupported` 的 CODE_COPY/toCode/图标/warning 态/Retry 禁用**已全链就位且今日是死代码**，无任何 Host emit 站点 [读码]）：

1. `codexRuntime.resumeSession` 从「host.error 拒绝」改为**降级契约**：
   - **先注册**：`registry.resume(...)`，会话绑 `agent:'codex'` + `runtimeIdentity`（**misroute blocker**：今日拒绝路径不注册 → 后续 send/stop/close 经 `runtimeForSession` 误路由到 ClaudeRuntime 再 `session_not_found`，错 runtime 错错误码 [读码 `index.ts:232-237` + `agentWire.ts:118-120`]）；
   - 按 Claude 契约发三连：`session.resumed{agent,runtimeIdentity}` → `session.history{messages:[], agent:'codex', error:{code:'history_unsupported',…}}` → `session.status{idle}`（镜像 `claudeRuntime.ts:351-451` 的 replayHistory 形状；**不得走 host.error**——resume 的 host.error 渲染端零关联，是静默无声无息的失败 [读码 `useResumeSession.ts:39-57`]）；
   - **不 spawn 连接**（5a 零 IO）。
2. 5a 态下的 send：会话已注册但无活连接 → `codexRuntime.send` 现有 no-state 路径给出显式非致命错误（取证确认其形状后钉住，不得静默）。

**5b — 真 resume（历史重投影 + 运行时续跑，一条链）**

1. 新 `src/agent-host/codexHistoryReader.ts`（纯函数为主）：输入 `thread/resume` 回包 → `HistoryMessage[]`：
   - 遍历 `result.thread.turns[].items[]`，逐 item 过 **`mapCodexItem`（与实时链路同一纯函数**，`CodexBlock = HistoryBlock` verbatim，零上下文依赖 [读码]；**不得**复用 `CodexNormalizer.ingest`——那是回合循环专用有状态层 [读码]）；
   - id：`h:codex:<threadId>:<turnId>:<itemId>`（F1）；role：userMessage→user、agentMessage→assistant（mapper 的 `role` 字段现成）；时间戳：turn 的 `startedAt/completedAt` 为**秒**（capture 值 1786767552）→ ×1000 进 ms；
   - 空 blocks 的 item（not_rendered）整条略过（渲染端对空 blocks 已有防御，但不投喂垃圾）。
2. `codexRuntime.resumeSession` 升级为全链：`ensureCodexHome` → spawn 连接（复用 `codexConnection`/`codexNodeEntry`，与 createSession 同构）→ initialize → `thread/resume{threadId}` →
   - **成功**：H9 回显校验过 → `registry.resume` → 建 `CodexSessionState`（threadId、policy、连接归此会话——后续 `turn/start` 直接可用，**resume 即续聊**）→ `session.resumed` → `session.history{messages}` → `idle`；
   - **thread 不存在**（rollout 丢失 = codex 版断链）：错误映射 `jsonl_not_found`（C11/D32 已裁语义放宽、文案已去 JSONL 字样）→ 三连降级（messages:[] + error）→ 连接关闭；
   - **spawn/initialize/超时类失败**：映射 `read_failed`（retryable，渲染端有 Retry）→ 三连降级 → 连接关闭；
   - **H9 校验失败**：视同失败（fail-safe）：杀连接 → `read_failed` 降级三连，message 写明权限姿态不符。
3. `history_unsupported` 分支保留为「该 agent 无 reader」default（5a 代码即最终 default 分支，5b 不删只改 codex 的 happy path）。

**明确不做（登记，防散架）**

- listHistory 的 codex 扇出 / U6 errors[] / U7 临时 spawn（F5，待裁定 P1）；
- 跨源 id 对齐去重（F2 判死）；重投影缺 reasoning/exec 的 UI「部分历史」指示（L1，另立）；
- `historyMode:"legacy"` / `itemsView` 字段的处理（仓内零消费 [读码]，观察项 L2）；
- `thread/fork`（C12 禁令不变）；协议不升版（硬约束不变）。

## 2. 验收 G 表（证据重生成；每条须有可执行断言）

| G | 断言 | 层 |
|---|---|---|
| G1 | 5a/5b 的 resume 后会话在 registry 绑 codex：随后 `session.send`/`stop`/`close` 路由到 CodexRuntime（misroute 钉死；含「拒绝路径也注册」的负例回归） | Host 单测 |
| G2 | 5a 三连顺序与 payload 钉死：resumed（agent+runtimeIdentity）→ history（messages:[] + error.code=history_unsupported + agent）→ status idle；全程零 host.error、零连接 spawn | Host 单测 |
| G3 | `history_unsupported` 走 store reducer 端到端（applyRuntimeEvent → historyErrors → banner view + Retry 禁用 + composer 不禁用）——补 CTR-02 缺口（现仅 parseHistoryError 直调覆盖 [读码]） | 渲染端单测 |
| G4 | reader 纯函数喂**真实夹具** `codex-s5-thread-resume.jsonl` 的回包 → 恰 2 条 HistoryMessage（user 原文 / assistant "DONE"），id 形如 `h:codex:<threadId>:<turnId>:item-1/2`，时间戳为 ms | Host 单测（真实帧） |
| G5 | id 含 turnId：构造两 turn 输入（合成输入喂纯函数，非冒充线上帧）→ 四条 id 全唯一；item-N 复现跨 turn 时无碰撞 | Host 单测 |
| G6 | 成功 resume 全链（mock 连接）：thread/resume 带且只带 `{threadId}`；回显校验通过后 resumed→history(messages)→idle；**连接保留**、后续 send 的 `turn/start` 打同一 threadId | Host 单测 |
| G7 | 失败映射三分法：thread-not-found→`jsonl_not_found`、spawn/超时→`read_failed`、无 reader→`history_unsupported`；三者都以三连降级收尾（messages:[] + error + idle），连接不残留 | Host 单测 |
| G8 | **H9 权限重申**：① codexHome 投影 config 含 `approval_policy`/`sandbox_mode` 且值与 `CODEX_PERMISSION_DEFAULT` 单一真相（相等断言）；② resume 回显与期望不符 → 杀连接 + read_failed 降级（fail-safe 用例） | Host 单测 |
| G9 | mapper 契约照真回包：`mapCodexItem` 直接吃重投影形状的 userMessage（content[] 型）与 agentMessage（text 型）不 malformed；**当前真相钉住**「重投影只含 user/agent 两类」——codex 未来版本若恢复 reasoning/exec，此钉变红提醒富化（L1 的哨兵） | Host 单测（真实帧） |
| G10 | flag off：`session.resume{agent:'codex'}` 仍在 index.ts 门口 `agent_unsupported`（§4 off 态 #2 不回归） | Host 单测 |
| G11 | Claude 端到端零变化：claude 侧文件零 diff；全量既有 vitest 0 红 | 门禁 |
| G12 | 协议不升版断言仍绿（`AGENT_HOST_PROTOCOL_VERSION===1`）；索引顶层裸数组断言仍绿 | 既有钉 |
| G13 | 重启后 resume（G13 原义）：从 `session-index.json` 行出发（agent=codex + runtimeIdentity=threadId [读码：#22 守卫已放宽、链路 create 半边实测通]）→ resume 命令逐跳携带 agent/runtimeIdentity/workspacePath [读码] → mock 连接断言 `thread/resume` 收到的正是索引里的 threadId | Host 单测 + 后续 CDP 实机 |

## 3. 施工顺序

1. **5a**（小、零 IO）：codexRuntime.resumeSession 降级契约 + G1/G2/G3/G10 → 四门串行；
2. **5b-reader**（纯函数 + 真夹具测试）：codexHistoryReader + G4/G5/G9；
3. **5b-runtime**：resumeSession 全链 + codexHome 投影扩展 + G6/G7/G8/G13 → 四门串行 + 变异验证；
4. 收口：G11/G12 全量、台账、plantree、（CDP 实机验证挂入下轮真机/本地点验单）。

## 4. 硬约束（S2 附表 8 条全承继，新增两条）

- **H9（新）**：Codex 会话的权限姿态必须在 **config 投影与 resume 回显校验**两层同时成立；两处取值同源 `CODEX_PERMISSION_DEFAULT`（单一真相），回显不符即 fail-safe 断连降级。
- **H10（新）**：5a/5b 的一切失败路径必须以 `session.history{error}` 三连收尾，**不得以 host.error 结束 resume**（渲染端 resume 链路对 host.error 零关联 [读码]）。

## 5. 遗留登记

- **L1** 重投影缺 reasoning/commandExecution（codex 0.145.0 存储性质）——历史回放无工具行/思考行；G9 哨兵钉当前真相；「部分历史」UI 指示另立。
- **L2** `historyMode:"legacy"` / `itemsView:"full"|"summary"` 零消费观察项；codex 升级重跑契约快照时一并看。
- **L3** 5a 态 send 的错误形状依赖 codexRuntime 现有 no-state 路径——施工时取证钉住（若形状不可接受再修，不预设）。
- **L4** `historyErrors` 仅被「无 error 的 session.history」清除 [读码]——重复 resume 尝试的 stale 场景补一条渲染端用例（归 G3 附带）。
- **L5** 真实回包夹具只覆盖单 turn/两 item 形态；多 turn、含审批/问答的 thread 重投影形状未捕获（预算内回合已花完，留待下次真实使用时截获）。

## 6. 待裁定

- **P1（用户）**：listHistory 的 codex 扇出按 F5 砍出本片——「侧栏 Codex 行来自 session-index（切片 1 已落）」已覆盖可见性需求；若要「扫 CODEX_HOME 补索引外的 codex 会话」再立新片。**默认：砍。**
