# S3 切片 6 施工规格 — 收口（#7 capabilities registry + #8 idle sweep + flag 双跑 + U8 点验）rev.1

> rev.1 = rev.0（取证版）+ **双轨双盲对抗评审合取修订**（2026-08-15：Opus 失效态镜头 O1~O20 / Codex 证据契约镜头 C1~C8，映射见 §9）。
> 权威链：[仲裁档 §2.1](./2026-08-09-s3-slice2-arbitration.md) ＞ [S2 设计档 §4](./2026-08-06-s2-codex-integration-design.md) ＞
> [open-q #7/#8 裁定](../plantree/plans/multi-agent/open-questions.md) ＞ 本档。
> 范围来源：roadmap 切片 6 行 + 注册表行追加（#7 capabilities + #8 idle sweep）。

## 0. 范围

四件施工 + 一件收尾：

| 件 | 内容 | 出口 |
|---|---|---|
| A | **#7** HostAgentRegistry：可用性现算（含真实 home 准备）+ Main/renderer 全链透传（含 prime 通路） | open-q #7 关闭 |
| B | **#8** idle sweep（照 codeg 形状）+ **回收后续聊**（send 复活，判据=被 sweep 名单） | open-q #8 关闭 |
| C | flag on/off 双跑门禁（含既有非密闭测试改造清单） | S2 §4「on/off 都要跑」落地 |
| D | U8 侧栏窄宽截图 + G13 真机半边（真 rollout 借用法） | C14/U8 关闭；切片 5 真机债了账 |
| E | 台账 + plantree 收口 | S3 六切片全落（2b 除外，已后置） |

**rev.0 约束撤销**：「revive 失败不新增 error code」撤销——复用 `session_not_found` 会命中渲染端 direct-send 兜底（close+create 新线程并覆盖持久 `runtimeIdentity`，O1），把 H9 fail-safe 变成静默丢会话。新增非致命错误码 **`session_revive_failed`**（wire 加法）。

**明确不做（登记，同 rev.0）**：#9（登录管理阶段解）· stage-3 picker UI · L1 提问坞单槽（open-q #10）· 共享连接 · 切片 5 遗留 L1/L2/L5/L6/L7 各归其位。

## 1. 取证结论（F 表；rev.1 含评审修正）

| # | 结论 | 证据 |
|---|---|---|
| F1 | `SUPPORTED_AGENTS` 模块级冻结**是有意的**（广播=执行不漂移）；registry 化必须保留该不变量 | `index.ts:37-44,78-91,306` |
| F2 | `resolveCodexEnabled` 每调现读（仅 `'1'` 开）；Main 有意不注入 flag | `agentSupport.ts:33-35`；`hostEnv.ts:24-27`；`hostEnv.test.ts:25-30` |
| F3 | C-c 三句核实成立；**另有第三条通路 `primeHostStatus`（晚挂载快照）规格 rev.0 漏改**——同文件注释记着 settings 当年同款事故（O6） | `AgentHostManager.ts:58-76,316-322`；`hostStatus.ts:28-29,61-70,100-136` |
| F4 | **（rev.1 修正，O19）** `teardown()` 调用方五处：`startThread` catch `:1155` / `onExit:1559` / `close:1796` / `dispose:1809` / resume 冷路径失败 `:2133`；`stop()` 非 teardown | `codexRuntime.ts` 各行 |
| F4b | **（新增，C2=O5 双轨同判）** `teardown()` 先置 `torndown` 再删 state；`onExit` 首行 `if (!state \|\| state.torndown) return` → 其 `:1560` 的 `registry.setStatus('disconnected')` 对 teardown 发起的击杀**永不执行**；close 靠显式 `registry.delete()` 补偿。sweep 必须自己 setStatus | `codexRuntime.ts:1538-1541,1559-1560,1731-1744,1794-1803` |
| F5 | 回收后 send 打 `session_not_found`（`!state \|\| !session`）；**（rev.1 扩展，O1）渲染端对 direct 态 `session_not_found` 的既有兜底 = close+create 新线程 + 覆盖持久 runtimeIdentity**——revive 失败绝不可复用此码 | `codexRuntime.ts:1844-1849`；`ChatComposer.tsx:1097-1108,1238-1274,1523`；`chatSessions.ts:486-507`；`sendPreamble.ts:28-37` |
| F6 | S2 §4 off 态断言 #3 已过时（切片 5 P1 砍 listHistory 扇出）；断言改「两态行为同一」 | 切片 5 规格 F5/P1 |
| F7 | entry 解析在 agent-host（`codexNodeEntry` 纯函数）；home 位置由 Main 注入 `CODEX_HOME_ENV`（`userData/codex-home`，**生产恒非空**——env 缺失不是主要失败空间，C3） | `index.ts:182-208`；`AgentHostManager.ts:393-415`；`hostEnv.ts:37-44` |
| F8 | codeg sweep 形状：180s/60s/env 覆盖/`0` 禁用/**四豁免含「非 Connected 不扫」**（`Connecting` 独立态，O4）；`u64` 解析天然拒负数与小数（O15） | codeg `idle_sweep.rs:13-64`、`manager.rs:536-584`、`types.rs:661-667` |
| F9 | dev session-index 无 codex 行（18=13 缺省+5 claude）——U8/G13 须自造 | 实查 |
| F10 | 仲裁「Main 规范化 flag」半边无需落（严格 `==='1'` 已覆盖） | `agentSupport.ts:33-35` |
| F11 | 侧栏 chip：agentChip 恒 `shrink-0` 不截断、branch chip 唯一让步者、静态预算测试已钉、折叠 rail 无 chip、展开 280–500 | `sidebarTree.ts:24-45,105-129`；`LeftNav.tsx:302,318,774-814`；`sidebarRowBudgetStatic.test.ts:59-105` |
| F12 | **（新增，C1）零回合 thread 无 rollout 文件，`thread/resume` 必报 `-32600 no rollout found`**；探针注释即载解法：从真实 `~/.codex/sessions/<y>/<m>/<d>/` 拷 rollout jsonl 进隔离 home 的 sessions 树 | `s5-g8b-posture-probe.ts:14-24` |
| F13 | **（新增，C4=O8）** `protocolErrors.test.ts` harness spawn 继承 `process.env`，三组 off 态断言（create/resume `agent_unsupported`、capabilities 精确 `['claude-code']`）在全局 flag=1 下必红 | `protocolErrors.test.ts:35-49,251-271,282-318,349-368` |
| F14 | **（新增，O7）** `index.ts` 模块作用域跑 `main()`，import 即挂死 vitest worker（agentSupport 头注明示）——registry 的 `let` 必须落在可 import 模块 | `agentSupport.ts:5-9` |
| F15 | **（新增，O9）** `waitForReady` 超时分支 `if (proc.isRunning) resolve()`——**没等到 host.ready 也放行**，initialize 之前到达 create 是真实序 | `AgentHostManager.ts:461-467` |
| F16 | **（新增，O2）** `send()` 已有 `!state.threadId → session_busy`（复活窗口的二次 send 天然被挡，无需假 turn 占位）；`CodexTurnState.normalizer` 必填且构造要求 threadId 已知 | `codexRuntime.ts:635-645,1857-1866,1900-1905` |
| F17 | **（新增，O3/O13）** `statusGated` 全仓置位 `:2072`、清位仅 `:2314`（`emitHistoryClose` 内）；守卫③的 `connection.alive` 自构造起即 true——quiet 复活必须自带清位点与 `reviving` 位 | `codexRuntime.ts:1266-1277,2072,2314,2014`；`codexConnection.ts:325-327` |
| F18 | **（新增，O10/O11）** initialize 超时 15s + `thread/resume` 走默认请求超时 60s = 最坏 75s；渲染端 send 预算 45s、busy 有界重试 8×250ms≈2s——复活需自有 deadline，二次 send 重试耗尽是已知代价 | `codexConnection.ts:58,66`；`ChatComposer.tsx:1373,1476-1506`；`queueRelease.ts:314-316` |

## 2. 施工 A — #7 HostAgentRegistry

**裁定回放**（仲裁 §2.1）：codex 可用性 = flag × entry 解析 × **隔离 home 准备结果**，initialize 时建。必须保留 F1 不变量（广播=执行同源冻结）。

1. **A1 落点与形状**（O7）：registry 的 `let` + 构建/查询函数落 **`agentSupport.ts`**（可 import、可单测）；`index.ts` 只调用。
   `buildHostAgentRegistry({ env, probeEntry, prepareHome })` → `{ agents: AgentWireName[], detail: Array<{agent, available, reason?: 'flag_off'|'entry_missing'|'home_prepare_failed'}> }`。
2. **A2 真实 home 准备**（C3，采纳）：flag on 时 registry 构建**真跑 `ensureCodexHome`**（幂等；目录创建/投影/凭据任一失败 → codex 不广播 + `home_prepare_failed`）。flag off 时不碰 fs。entry 探测用 `codexNodeEntry` 纯函数注入真实 fs。create/resume 照旧再跑 ensureCodexHome（防 initialize 后漂移；其会话级失败语义不变）。
3. **A3 构建时机 = memoized single-flight**（O9a）：`ensureHostAgentRegistry()` 首次调用构建并冻结，之后恒返回同一份。initialize 处理器调用它；**create/resume 校验在 registry 未建时也调用它**（F15 的早到 create 不被冤枉）。冻结后翻转 env 不生效（F1 不变量，G2）。
4. **A4 与 Claude 初始化解耦**（O9b）：registry 构建在 initialize 分支里**先于** `ensureRuntime()`，且互不吞错——Claude `initialize_failed` 不得连带清空/跳过 registry；registry 构建失败只影响 codex 位（claude 恒可用）。此为 A1 引入的新耦合的显式拆除。
5. **A5 Main 透传**（additive）：`AgentHostManager` 存 `payload.capabilities`；`getStatus()` 返回加 `capabilities`。
6. **A6 渲染端两条通路**（O6）：`hostStatus.ts` 的 `reduceHostStatus` **与 `primeHostStatus`/`HostStatusPrimeSnapshot`** 同步加 `agents?: AgentWireName[]`（按 wire 词表过滤未知 slug）。本片消费者=测试断言；stage-3 picker 是未来 UI 消费者。
7. `agent_unsupported` message 带 reason 线索（三种 reason 文本可区分），不加新 code。

## 3. 施工 B — #8 idle sweep + 回收后续聊

**裁定回放**（open-q #8）：补 idle sweep 照 codeg 形状，不做共享连接。「回收后续聊」是 #8 的组成部分。

### 3.1 活动时间戳与 sweeper

1. **B1 触碰点挂连接层**（O20）：touch 挂进 `openConnection` 的 handlers 包装 + 出站封装（pending 的 reply 闭包直达 connection、不经 runtime，挂 runtime 层必漏）。注入时钟 `opts.now?`。
2. **B2 sweeper**：实例级 interval 60s、`unref()`；**两个 session 插入点（`createSession:931` 与 `resumeColdThread:2073`）都 ensure**（O14——只挂 create 侧则「重启后只点开历史会话」的进程永不扫）；sessions 空/`dispose()` 时停。
3. **B3 阈值 env `AICLIENT_CODEX_IDLE_TIMEOUT_SECS`**（C8/O15，对齐仓内先例 `claudeRuntime.ts:87-95` + `<=0` 禁用调用点形状）：`Number()` 解析；非有限 → 默认 180；**有限且 ≤0 → 禁用**；正数按秒生效（含小数）。
4. **B4 资格六条件**（C1+O4 合取）：
   `state.threadId != null`（我方唯一 Connected 标记——排除 create/resume 握手窗口，O4 的 `startThread` catch `:1153` 静默吞 create 是最脏后果）
   && `state.rolloutBacked === true`（**零回合 thread 无 rollout 不可 resume（F12），绝不回收**；置位点=resume 成功时 / 本连接首个 `turn/completed` 时）
   && `state.turn === null` && pending 表空（`pending.sizeFor`，`codexPending.ts:406-411`）
   && `!state.torndown && !state.reviving`
   && `now - lastActivityAt >= 阈值`。
5. **B5 回收动作**：`teardown(state,'aborted','idle sweep',…)` → **显式 `registry.setStatus(sessionId,'disconnected')`**（F4b：onExit 链对 teardown 击杀不触发；绝不 `registry.delete`——绑定要留给复活）→ `sweptSessions.add(sessionId)` → host log 记数。**不发任何 session.\* 事件**。

### 3.2 send 复活（quiet revive）

6. **B6 判据 = sweep 名单**（O12 收窄）：`send()` 命中 `!state` 时，仅当 `sweptSessions.has(sessionId)` 且 registry 绑定完好（codex + runtimeIdentity）才走复活；崩溃残留、失败冷 resume 残留**不在名单**，维持既有 `session_not_found` 语义（本片不改变它们的渲染端行为）。名单清理：close/dispose 删项、复活成功删项、复活失败遇 THREAD_MISSING（rollout 真没了）删项（此后收敛回既有语义）。
7. **B7 复活链**（O2/O3/O13 合取，无假 turn 占位）：
   - 立即插入占位 state（`turn:null`、`threadId:null`、`statusGated:true`、**`reviving:true`**）+ registry 已有绑定不动；
   - 二次 send 天然被既有 `!state.threadId → session_busy` 挡住（F16）；`resumeSession` 守卫链**前置 `state.reviving → session_busy`**（挡守卫③的 `alive` 恒真竞态，O13）；
   - `ensureCodexHome`（H9 层 1，`openConnection` 内既有）→ spawn → initialize → `thread/resume{threadId}` 单键；
   - **H9 层 2 抽出共享函数**（现内联于 `resumeColdThread:2106-2107`）：`assertResumePosture` 供冷 resume 与复活共用；
   - **整链自有 deadline 20s**（O10/F18：默认超时链最坏 75s > 渲染端 45s 预算），超时走失败路径；
   - **成功**：`state.threadId=threadId`、`rolloutBacked=true`、`reviving=false`、**显式清 `statusGated=false`**（O3：quiet 模式无 `emitHistoryClose`，清位必须自带）、`sweptSessions.delete` → 接原 send 流程（`turn/start` 同 threadId）。全程**不发 resumed/history 三连**；
   - **失败**：`teardown()` → `registry.setStatus('disconnected')` → 发 **`host.error{code:'session_revive_failed', fatal:false, message:含原因}`**（requestId 关联）——绝不 `session_not_found`（O1：撞渲染端 close+create 兜底 = 静默换线程）。渲染端半边：确认新 code 不触发 `ChatComposer.tsx:1523` 兜底、send 以可见失败收场（G12）。
8. **B8 已知代价（登记不掩饰）**：
   - 零回合 idle 会话不回收（124MiB 持有直到 close/退出）——F12 的必然推论；
   - 复活窗口内二次 send 的渲染端 busy 重试（≈2s）必然耗尽 → 该条消息判 rejected（F18；复活自身 ≤20s）；
   - 复活中 `stop()` 走既有路径（drain 空转 + status 回显）——瞬态回显，不新增处理；
   - rollout 被外部删除的会话：复活报 THREAD_MISSING → 名单删项 → 后续收敛回既有 `session_not_found` 语义。

## 4. 施工 C — flag on/off 双跑门禁

1. **off 轮** = 既有四门逐门串行（env 缺省）。
2. **on 轮** = `AICLIENT_AGENT_CODEX=1` 重跑 **test 门全量**。
3. **既有非密闭测试改造清单**（F13，施工前置项）：`protocolErrors.test.ts` harness 加 env 覆写口；三组 off 断言显式钉 `AICLIENT_AGENT_CODEX:''`；**补 on 臂**：capabilities 含 codex（entry 探测指向注定失败的隔离 home/候选表 → create 得 `agent_unsupported{entry_missing}`，不真 spawn）。
4. **Claude 等价双臂**（C5：仅「不是 agent_unsupported」承载不了「Claude 零影响」）：同一 claude create 在 off/on 两臂 → 首事件与 `session.created` 关键字段（agent/runtimeIdentity 形状）等价断言。
5. off 态断言 #2 补全（O18）：off-create 拒绝后**不建 session、不进 busy**（`index.ts:47-68` 契约字面）。

## 5. 点验 D — U8 截图 + G13（CDP 工法）

1. **前置（rev.1 修正，F12/C6）**：
   - dev.env 设 `AICLIENT_AGENT_CODEX=1`；
   - **借用真 rollout**：从 `~/.codex/sessions/<y>/<m>/<d>/` 选一个小 jsonl 拷进 **app 隔离 home（`userData/codex-home`）的 sessions 树**（探针注释载明的方法），threadId 取自文件；只读借用，点验后清理；
   - session-index 落行，**最小字段集**（C6）：`sessionId`（新 uuid）、`workspacePath`（**必须 = GUI 当前打开的 workspace 规范化路径**，否则进 orphaned 不显示）、`title`、`updatedAt`、`archived:false`、`agent:'codex'`、`runtimeIdentity:<threadId>`；resume 还要求 workspace 已注册且会话非 busy（`resumeIntent.ts:49-95`）。
2. **截图矩阵**（每图 Read 目验）：展开 280px 窄 / 展开 500px 宽（codex 行 agent+branch 双 chip + 长标题，与 claude 行同屏）/ 折叠 rail（预期无 chip，记录）。
3. **判定**：不挤 → C14/U8 关闭；挤 → 退路 icon-only chip 另立小片。
4. **G13**：CDP 点开 codex 行 → 真实冷 resume（resumed+history+idle，H9 姿态来自投影 config）→ 可续发（不实发，输入框可用即证）。
5. **现场恢复**：撤 index 行、撤 flag、清借用 rollout 与临时 state。

## 6. 验收表（G 表 rev.1）

| # | 断言 | 层 |
|---|---|---|
| G1 | registry 四臂（C7 拆分）：flag off → `['claude-code']`+reason `flag_off`；on+entry 缺 → 无 codex+`entry_missing`；on+home 准备失败 → 无 codex+`home_prepare_failed`；on+全通 → 含 codex。四臂 message 线索可区分；off-create 拒绝后无 session/无 busy（O18） | agentSupport/Host 单测 |
| G2 | 冻结不变量：`ensureHostAgentRegistry()` 构建后翻转 env 再查询 → 同一冻结值（unit 层，F14：spawn 层无法翻 env） | agentSupport 单测 |
| G3 | 早到 create：registry 未建时 create 触发构建并按同一份校验（F15 序） | Host 单测 |
| G4 | 解耦：Claude `ensureRuntime` 抛错时 registry 仍建成、codex 位不受累；反向 registry 构建失败不改 claude 可用性 | Host 单测 |
| G5 | Main+prime 双通路：`getStatus().capabilities.agents` 与 wire 一致；`primeHostStatus` 快照携带 agents（O6）；旧 payload 无 capabilities 不炸 | Main/渲染端单测 |
| G6 | sweep 资格：六条件逐一独立否决（threadId null 不扫 / 非 rolloutBacked 不扫 / turn 挂起不扫 / pending 非空不扫 / reviving 不扫 / 未达阈值不扫），全通过才扫（假时钟） | Host 单测 |
| G7 | env 解析六例：缺省→180 / `'0'`→禁 / `'-1'`→禁 / `'abc'`→180 / `'1.5'`→1.5s / `'1e9'`→生效（O15/C8） | Host 单测 |
| G8 | sweep 动作：dispose 被调 + sessions 删除 + **显式 `registry.setStatus('disconnected')`**（F4b）+ `sweptSessions` 登记 + emit 捕获零 session.\* 事件 | Host 单测 |
| G9 | revive 全链（内存 transport 驱动真实 connection 核——**先例 `codexRuntime.test.ts:46-47,355-375`**；harness 需扩成按 connect 序号切片的多连接核列表，O16）：swept 会话 send → connect 工厂恰+1、`thread/resume` 单键、无 resumed/history 发射、`statusGated` 复活后为 false 且后续 `thread/status/changed` 正常投影（O3 反例）、`turn/start` 同 threadId | Host 单测 |
| G10 | **H9 行为断言（替代自证版）**：喂姿态不符的 resume result → 复活被拒、无 `turn/start`、错误码 `session_revive_failed`（Opus 定向答复的行为化改写） | Host 单测 |
| G11 | revive 失败面：THREAD_MISSING（`no rollout` 串）→ teardown+名单删项；infra 失败 → 名单保留可重试；两者皆发 `session_revive_failed` 非 `session_not_found`；deadline 20s 超时收敛 | Host 单测 |
| G12 | 渲染端半边：`session_revive_failed` **不触发** close+create 兜底（`ChatComposer.tsx:1523` 判据不命中），send 以可见失败收场；无法单测则以 D 阶段 CDP 取证替代并登记 | 渲染端单测或 CDP |
| G13 | 复活竞态：复活中二次 send → `session_busy`（F16 既有行为回归钉）；复活中侧栏 resume → `session_busy`（reviving 前置守卫，O13） | Host 单测 |
| G14 | 非 sweep 的 `!state`（崩溃残留 / 失败冷 resume 残留）→ 维持 `session_not_found`（O12 收窄的负例） | Host 单测 |
| G15 | 懒启动双挂点：仅 resume（不 create）的进程同样起 sweeper 并回收（O14） | Host 单测 |
| G16 | flag on 轮 test 门全量 0 红（含 F13 改造后的 protocolErrors 双臂） | 门禁 |
| G17 | Claude 等价双臂（§4.4） | Host 单测 |
| G18 | U8 三张截图 + 目验结论 | 点验记录 |
| G19 | G13 真机恢复（切片 5 移交项原号沿用；含 H9 投影姿态回显） | 点验记录 |
| G20 | 变异验证：sweep 六条件逐条翻转红 / 复活判据（名单/绑定）翻转红 / registry 四臂翻转红 / `statusGated` 清位翻转红 | 施工现场 |

## 7. 遗留登记（本片新增）

- **L8** 零回合 idle 会话不回收（F12 必然推论），空会话持有 124MiB 至 close/退出——影响面小（需用户建 codex 会话且永不发言），修法需「复活改走 thread/start 换线程」，与 O1 的反静默换线程立场冲突，不做。
- **L9** 复活窗口二次 send 判 rejected（渲染端 2s 重试 < 复活 ≤20s）——如实代价；若实用中高频命中，另立「revive 感知的 send 排队」。
- **L10** 复活中 `stop()` 的状态回显瞬态（沿 2c 既有回显语义）。
- **L11** `session_revive_failed` 的渲染端呈现本片按「可见失败」最低标准验收（G12）；专属 UI 文案归 stage-3 或另立。

## 8. 台账动作（E）

- ledger-claude-mainline 加行（证据 + hash）；roadmap 切片 6 转 ✅ + 阶段顺序表下一件=用户登录管理；open-q #7/#8 关闭存根、#9 钉「登录管理阶段解」；注册表两行刷新。
- **提请用户**：#1 存根「不接 ACP / Claude 线不走 ACP 待升格编号决策」是否本轮升格 D 号。

## 9. 双轨评审合取记录（2026-08-15）

- **Opus 轨**：4 blocker（O1 revive 失败码撞渲染端兜底 / O2 假 turn 占位三重不可行 / O3 statusGated 无清位点 / O4 资格漏 Connected 豁免）+ 10 major（O5=C2、O6 prime 通路、O7 落点、O8=C4、O9 早到 create 与初始化耦合、O10 deadline、O11 重试窗口、O12 判据半径、O13 守卫③竞态、O14 双挂点、O16 harness）+ 5 minor（O15/O17/O18/O19/O20）。
- **Codex 轨**：2 blocker（C1 零回合无 rollout / C2 registry 收敛断链）+ 4 major（C3 home 准备偷换、C4 非密闭测试、C5 等价自证、C6 index 行过滤门）+ 2 minor（C7 G1 合并臂、C8 负数解析）。
- **互补性**：渲染端兜底链与 quiet 机器不可实现性仅 Opus 见；零回合 rollout 缺失与 index 行过滤门仅 Codex 见；registry 收敛断链**双轨同判**（C2=O5）。全部合取采纳，无二选一冲突；rev.0 自设约束一条撤销（§0）。
- 编排者亲验：C1（探针注释原文）、C2/O5（`onExit` 早退控制流）属实后才改写。

## 10. 顺序与门禁

施工 A → B → C（A 先行；B 依赖 A 无共享冻结面可并，但 protocolErrors 改造（C 件）与 A 同文件族，排 A 后）→ 四门逐门串行（off 轮）→ on 轮 test 门 → 点验 D → 台账 E。
门禁纪律照旧：逐门串行、vitest `--maxWorkers=2` 以内、期间不并行大编队。

## 11. As-built（2026-08-15 收口）

- **提交序**：规格 rev.1 `e281435` → 施工批 `81a130b`（11 文件 +2643/−162）→ 收尾档案批（本节所在提交）。
- **门禁**：lint 0 错 / typecheck 0 / typecheck:agent-host 0 / **off 轮 vitest 167 文件 3482 例 0 红** / **on 轮（`AICLIENT_AGENT_CODEX=1`）167 文件 3482 例 0 红（G16）**。基线 3418 → 3482（+64）。
- **施工偏差与登记（全部追认）**：
  - A 件：连带删除 `supportedAgents()` 纯函数（规格只要求删 `index.ts` 冻结常量）——按 F1 反漂移立场追认：留两个能算 agents 列表的函数正是要防的漂移。`ensureCodexRuntime` 的 home 空值检查因 registry 前置而结构性不可达，保留为防御。
  - B 件三条规格冲突全部成立并按报告落地：①「wire 错误码词表 + AST 扫描」前提不成立（`HostErrorEvent.payload.code` 是裸 string、扫描管的是 agent 名三轴）→ 落具名常量 `CODEX_REVIVE_FAILED_CODE`（比现状强一档）；② B4 六条件在 runtime 层不可独立构造（`threadId==null` 恒伴 `rolloutBacked=false` 等）→ 纯谓词 `isCodexIdleSweepable` 承担 G6 字面 + 适配层 5 例端到端，变异 M10（`reviving` 子句）在运行时层不可杀，已注释登记；③ B6 名单清理补第四点：用户自行重开且冷 resume 失败时在 `resumeColdThread` 顶部清名单（M26 钉住），防「已见降级横幅还再 spawn」。
  - B 件顺带修实码缺陷：`onExit` 原按 sessionId 查表，dispose 早于子进程真死时会把同 id 的**下一条**连接拆掉——改闭包捕获 `owner.state`。复活场景会把此竞态变常发。
  - C 件规格缺口自解：无 `AICLIENT_CODEX_HOME` 的裸 vitest 环境里 flag on/off 都以 codex 不可用收场（reason 不同），原三断言检不出 off 钉丢失 → off 断言升级为 `describeHostAgentReason('flag_off')` 子串专断言（严格更强）。
  - 编排者两笔：修 A 件 `hostStatus.test.ts` 三处 `prev` 字面量宽化型错（补 `HostStatus` 注解，根 typecheck 门抓获）；改 `codexRuntime.ts` 构造器注释里已删除常量名的引用。
- **变异验证合计 40 处**：A 件 10（G1 四臂 5 + G2 冻结 5）全翻红；B 件 27 中 26 翻红 + M10 登记存活（运行时不可达组合）；C 件 3 全翻红（off 钉撤除在 on 轮翻红实证了钉的承重）。
- **G12（渲染端半边）双源确认**：编排者与 B 件独立读码同判——`ChatComposer.tsx:1523` 兜底判据为严格 `=== 'session_not_found'`，新码落 `:1552` 通用可见失败分支，不触发 close+create。未加渲染端断言（组件内联逻辑），D 阶段真机未触发复活失败路径，按规格 G12 降级条款登记。
- **D 件点验（CDP，evidence: `docs/design/refs/slice6-20260815-u8/`）**：
  - **U8 三态全过，判定不挤**（icon-only 退路不启用）：280px 窄态（DOM 实测 280，DPR 1.33）双 chip 完整、长标题正常截断；500px 宽态干净；折叠 rail 无 chip（符合 F11 预期）。**C14/U8 关闭。**
  - **G13 真机恢复 PASS**：借真 rollout（`019fd342-c370-7bc2-bdbe-873eb809316f`，129KB 真实对话）入隔离 home + 植入 index 行 → GUI 点行 → registry（flag on + PATH entry + home 真准备）→ spawn → `thread/resume` → H9 → 切片 5b reader 重放時间线完整可读 → 「Send follow-up…」可续发。切片 5 移交的真机半边了账。
  - 一次瞬态：折叠态首拍全白系 reload 中间帧，重拍正常（DOM 全量在场），非缺陷。
  - 现场已恢复：植入行/借用 rollout/dev.env flag/备份/进程树全清（残留第二个 dev.js 进程按精确 pid 清除）。
- **L8~L11 维持登记**；B 件另报三条如实观察（复活成功后 registry 状态到首帧前仍 disconnected（单写者纪律不补写）/ 附件 send 先复活再 `not_implemented`（顺序与改动前一致）/ `close()` 的名单删除是防泄漏非行为位），均不改语义，随 L 系列归档。
