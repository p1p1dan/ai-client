# Roadmap — 多 Agent 接入

> 状态：**In Progress — S3 施工线全落（切片 0/1/2a/2c/3/4/5/6；仅 2b 打包链既定后置），**用户登录管理 D47 已全收官（2026-08-16）**，当前阶段 = Codex CLI 选择功能（阶段 3，**D48 已立项 2026-08-16**）**（2026-08-06 同日四连：解冻 → S1 spike → S2 设计 → S3 开工；切片 5/6 均于 2026-08-15 收口）。
>
> ✅ **解冻裁定（用户 2026-08-06）**：原话「multi-agent 支线解冻 开干」。
> 2026-08-05 的「后置」裁定（原话「先做 B，优先把现有 Claude 客户端任务大致完成后，再考虑 codex 支线」）
> 挂的条件已满足——主线开发线五任务 T-32 / T-16 / T-33 / T-35 / T-34 于 2026-08-06 第十二轮点验全部转 Done。
> **S1 spike 自即日进入执行。**

## Done

- **2026-08-06 S2 — 直连 Codex 接入设计 ✅ 收口**（S1 当日接着做完）——产出
  [S2 设计档](../../../plans/2026-08-06-s2-codex-integration-design.md)（389 行，单一施工档）。
  编排：a 与 b/c/d 全并发，b 走 **Opus + Codex 双轨双盲**（唯一不可逆项），后接 Reconcile 强制收敛。
  **关闭 [#2](./open-questions.md)（提问形状）与 [#3](./open-questions.md)（绑定口径）；[#5](./open-questions.md) 关掉权限半边。**
  - **a 结 #2**：抓到 **4 条真实 `item/tool/requestUserInput` 报文 / 10 颗问题**，答复走通、回合续跑（4/6 回合）。
    「薄适配」由 S1 的 [推测] 40–80 行校正为 **Host 100–150 行 + 类型 12 行 + 渲染端 0 行**（偏乐观约 2 倍，**方向不变**）。
    **证伪了编排者给的线索**：`default_mode_request_user_input` 等三个开关任意组合**外发请求体逐字节相同**，
    真因是模型走 Codex 出厂提示词留的**散文后门**，唯一杠杆是提示词。
    副产物：**零额度看工具表的方法**（base_url 指向 sinkhole），已用它取得 U4 负结果。
  - **b 双轨**：独立收敛 6 处（只落 session 层 / 不补 schemaVersion / 唯一回落点 / runtimeIdentity 不兼任 /
    平行加 chip / **两轨各自独立命中同一个早退守卫**）；分歧 3 处——wire 值上交用户裁定
    （**`'claude-code'/'codex'`**），字段名取 `agent`，**回落点取 renderer `mergeSessionIndex`**
    （编排者复核发现 Codex 主张的 Main 侧 `ensureLoaded` 与它自己的否决项打架：`flush()` 写整张表，
    读侧规范化 = 把兼容读取变成不可逆写迁移）。
  - **仲裁员挖出三份设计共同的错误前提**：仓内**已有两套 agent 词表**（`BuiltinAgentId` 终端轴 /
    `AIProvider` 一次性助手轴），且 `agentId?` 已被占用为 Claude 子代理 id，`'claude-code'` 全仓已有 24 处
    ——b 原定的静态扫描若照落**第一次运行就红**。三轴互不转换写成断言。
  - **编排者复核新增**：`clientInfo.name` 会被 codex 揉进 User-Agent **发给 OpenAI**，
    生产环境须换应用名（对外身份，与 wire 名两回事）；`isSecret` 推翻原「不做」，
    按 codeg 先例 + 本仓 T-35 脱敏立场**补掩码**。
  - 落码 `<pending>`：`src/agent-host/spikes/s2-codex-question-probe.ts`。
- **2026-08-06 S1 — ACP + Codex 可行性 spike ✅ 收口**（解冻当日跑完）——四路并发探针实测，
  产出 [S1 spike 报告](../../../plans/2026-08-06-s1-acp-codex-spike-report.md)（474 行，含编排者逐条回验记录）。
  **出口达成：[open-q #1](./open-questions.md) 关闭 → 裁定「不接 ACP，直连 `codex app-server`」。**
  三条支撑：① 用户答复不加第 3 个 agent → ACP 价值不成立；② 实测**直连反而更便宜**
  （直连 540–740 行 / 2.5–5.0 人日 vs ACP 670–1090 行 / 3.0–7.0 人日），复核条款未触发；
  ③ **推翻了 #1 的隐含前提**——`codex app-server` 的命令审批与补丁审批**已在真实回合捕获原始报文**，
  「直连不可行时 ACP 是唯一退路」不成立，ACP 的保险价值归零。
  头号实证：**ACP 只是把直连的 payload 原样塞进 `_meta.codex` 再转发一次**（两路并列逐字段比对坐实），
  并在此过程丢掉 `applyNetworkPolicyAmendment` / `granular` / `approvalsReviewer`；
  代价还有 **362M node_modules（341M 是与 PATH 同版 codex 0.145.0 的纯副本）+ 3 级进程链**。
  「接 ACP 就不用写解析器」被 codeg 实证证伪：它接了 ACP 仍用 **508 行** `emit_conversation_update` 装 13 个分支。
  **同轮校正 [reuse-boundary](./topics/reuse-boundary.md) 六行初判表**（3 行确认 / 2 行校正 / 1 行部分推翻 / 1 行未覆盖），
  另补两行新层。落码 `bc531c7`：`src/agent-host/spikes/s1-{acp-codex,codex-direct,target-contract}-probe.ts`（三门：lint ✅ / typecheck ✅ /
  test 3 例既有失败，已 `git stash -u` 退干净 HEAD 复验为**既有非本轮引入**）。
  **未闭合：open-q #2**（真实提问报文两条路都没诱发出来，9 个真实回合零命中）。
- **2026-08-04 ACP 路线调研**（会话 `a5273935-…`，2026-08-05 补落库）——产出三篇 topic：
  [acp-decision](./topics/acp-decision.md)（判断依据 + Claude 线不走 ACP 的证据链）·
  [reuse-boundary](./topics/reuse-boundary.md)（问答卡上层 agent 无关、仅 `questionBridge.ts` 303 行 Claude 专属）·
  [codeg-reference](./topics/codeg-reference.md)（参照事实 + 适配器版本 pin）。
  **无代码改动**。当轮一处错判（自建统一伴生进程）当场收回，一处口径纠正（子 agent 文本是收不到而非混入）已记入 topic。

## In Progress

### S3 — 直连 Codex 施工（2026-08-06 开工，用户裁定「开工吧」）

| 片 | 状态 | 备注 |
|---|---|---|
| **0** 类型与断言骨架 | ✅ **已落地 `0314216`** | `agentWire.ts` 叶子模块 + 协议增量 #1–#19 + 19 例 AST 静态扫描 |
| **1** 绑定回流链 | ✅ **已落地 `0314216`** | 正向链 + 早退守卫放宽 + 唯一物化点 + 侧栏 chip；**Host 现会显式拒绝跑不了的 agent** |
| **2a** Codex 客户端骨架 | ✅ **已落地 `84ae4e1`** | JSON-RPC + 单一 pending 表 + **单一 status mapper** + 隔离 `CODEX_HOME` + Node 入口解析。双轨合流仲裁档 [2026-08-09-s3-slice2-arbitration](../../../plans/2026-08-09-s3-slice2-arbitration.md) |
| **2b** 打包链 | **待 3/4/5/6 之后**（用户 2026-08-10 裁定体积可接受，但排期后置——见下方阶段顺序） | **因用户裁定「Codex 随 Agent Host 打包」而新增**：`build-agent-host.mjs` 整条（preflight/external/prune/verifier）+ electron-builder + CI。**包体 141MB→约 480MB（3.4×）**，与 open-q #1 冲突，落之前须向用户交待 |
| **2c** 回合循环 + 事件归一化器 | ✅ **已落地 `8b0277f`** | S2 切片表 0→1→2→{3,4},5 里**没有任何一片认领它**：`turn/start`(即 send) · `item/*`→`message/tool/thinking` · `turn/completed` · `account/rateLimits/updated`→`usage.updated` · `turn/interrupt`(拼写仍 [未测]，`session.stop` 要用)。**连带后果最严重**：提问与审批只在回合中到达，没有回合循环则切片 3/4 的验收只能是夹具回放——会绿着落地却在生产里是死代码。S1 估净新增 300–420 行。**必须排在 3 之前** |
| **3** 提问桥 | ✅ **已落地 `4b468f4`** | `codexQuestionBridge.ts`（纯函数）+ 三道前置守卫 + `pending.forget()` 前置修复 + 渲染端 id 键与 `isSecret` 掩码。施工档 [切片 3 规格](../../../plans/2026-08-10-s3-slice3-question-bridge-spec.md)（rev.2，双轨评审后修订）。**夹具实际只有 2 条入向报文 / 5 颗问题**——S2 写的「4 条 / 10 颗」仓内不存在 |
| **4** 权限投影 | ✅ **已落地 `7f357c2`** | `codexDecisions.ts` + 审批桥全链路 + 渲染端 decision 透传 8 处。施工档 [切片 4 规格](../../../plans/2026-08-10-s3-slice4-permission-projection-spec.md)（rev.2 + §7 as-built）。评审在写代码前推翻 rev.1 十三处（含 `grantRoot` 会话级写权 blocker）；施工收窄规格一处（回合末 drain 仅审批族，§7.1）；复核修复含 decision 发射链三个接线 pin。**vitest 152 文件 3160 例 0 红** |
| **5** 历史 | ✅ **已落地 `1aa68f2`+`61bcd0d`（2026-08-15）** | 5a 降级契约（busy/冲突/活连接三守卫 + 先绑定根治 misroute）+ 5b `thread/resume` 全链（**恢复即续聊**；H9 权限双层重申经免额度真机双臂实证）。U2-a 真实回合四推翻（id 对齐判死 / 重投影丢 reasoning·exec / thread-resume 唯一可靠读法 / resume 从 config 重派生权限）。规格 [切片 5 spec](../../../plans/2026-08-15-s3-slice5-history-spec.md)（rev.2 = 双轨双盲评审合取 + as-built）。四门全绿 **vitest 167 文件 3418 例 0 红**；变异 43+ 翻全红。P1 listHistory 扇出砍（死接口）、P2 假承诺文案改（用户拍板）。遗留 L1~L7 见规格 §5 |
| **6** 收口 | ✅ **已落地 `81a130b`（2026-08-15）** | #7 HostAgentRegistry 全链 + #8 idle sweep 与回收后续聊（`session_revive_failed`）+ flag 双轮门禁（off/on 双轮 vitest 3482 全绿）+ **U8 三态截图判不挤** + **G13 真机恢复 PASS**。规格 [切片 6 spec](../../../plans/2026-08-15-s3-slice6-closure-spec.md)（rev.1 双轨合取 + §11 as-built）。open-q #7/#8 关闭；遗留 L8~L11 见规格 §7 |

**切片 0/1 的双轨对抗复核（Opus + Codex 双盲）1 blocker + 5 major + 2 minor 全闭环**，
两轨互补显著——blocker 与 registerSession 缺口**仅 Codex 见**，typecheck 盲区与自报身份零覆盖**仅 Opus 见**，
静态扫描形同虚设**双轨同判**。详见[主线台账](../../../plans/ledger-claude-mainline.md)。

**切片 3 已落地 `4b468f4`（2026-08-10）**——动工前先写规格再双轨对抗评审（Codex 轨因模型容量满载失败，改派第二个独立 reasoner 换镜头），**评审在写代码之前推翻了规格三处**：
`', '` 拆分规则对 Codex 恒不可达且只可能切碎自由文本（改恒不拆）· 桥内重复了分发层已有的空 payload 防呆（删除）·
「本片不改 `chatSessions.ts`」是错的（`question.resolved` 无条件清 `pendingQuestion` 会跨会话抹掉另一张卡，补匹配守卫）。
四门：**vitest 146 文件 2914 例 0 红**。

**切片 4 已落地 `7f357c2`（2026-08-10，规格与夹具先行 `35b4594`/`1ae2abc`）**——沿用切片 3 流程（取证 → 规格 → 双轨对抗评审 → 施工）。
取证重生成同版 codex 契约，**在写规格前推翻 S2 三处**（exec 方言 6 变体非 4 / exec≠file_change / legacy deny 是对象），
并抓出仓内证据缺陷（method-contract 的 serverRequest 一多一少两处错，契约测试按错列表钉了「未覆盖面」）。
双轨评审（失败态镜头 + 证据镜头，双盲）推翻 rev.1 十三处；施工三段 + 修复段做了 16 处变异验证；
fresh-eyes 复核的 major（decision 发射链零覆盖）以三个源码接线 pin 收口。四门全绿 **vitest 3160 例**。
遗留见规格 §6 L1~L10 与 §7.4（含「权限卡同卡中英混排」待用户裁）。

⚠️ **本片教训：设计档里的数字不等于仓里的证据。** 规格 rev.1 照抄 S2「4 条真实报文 / 10 颗问题」写进验收表，
而夹具只留存 **2 条**入向报文（5 颗问题）——另两次交换只剩我方回包。照 rev.1 施工，唯一写得出测试的办法
就是**编一条假请求**，而夹具 README 首段正是明令禁止这件事（「编一条假报文会让切片 3 的回放验收变成自证」）。
**两轨各自独立数了夹具行数才发现**。此后引用夹具数目一律现数，不得转述。

**切片 3 遗留七项**（如实登记，见[规格 §5](../../../plans/2026-08-10-s3-slice3-question-bridge-spec.md)）：
**L1 `pendingQuestion` 全局单槽**（两会话并发提问必丢一张卡，被顶掉的那条因 `waiting_question` 恒忙而**永久不能发消息也答不了**——
**与 agent 无关的既有缺陷，两个 Claude 会话同样触发**，本片只修了「误清」半边，改形状另立任务）·
L2 渲染端 reducer 自写 `waiting_question` 构成第二个等待态来源 · L3 `buildRespondPayload` 折叠 Claude 侧同文问题会丢答案 ·
L4 `autoResolutionMs` 真触发时卡片显示「Questions skipped」而模型其实拿到了自动答案 · L5 服务端复用 id 时两难已记录 ·
L6 未答 item「整条省略」是零样本推测（降级路径已备）· L7 schema 快照不会自己发现漂移，codex 升级必须重跑生成命令。

**切片 2c 已落地 `8b0277f`（2026-08-10）**——`codexItemMapper`（18 变体全覆盖，键集合对着契约快照
断言）+ `codexNormalizer`（按 turnId 隔离，diff 预缓存供切片 4）+ `codexRuntime.send/stop` 接线。
另落 `84cf0d6` 的 codex 自生成契约快照（**U-a/U-b 闭合**，elicitation 方法名补齐）。
四门：**vitest 145 文件 2852 例 0 红**，红线五文件零改动。

⚠️ **本片的过程教训值得记**：接线实现（489 行）曾在**零测试**状态下完成（施工方写完实现即中断）。
补验证时采取**对抗性立场**（「写出来是红的就是发现缺陷，不许改实现去迁就测试」），
**逼出两个真缺陷**：① `stop()` 在终态之后又发 busy 状态 → 输入框冻死（`isBusyStatus` 认
`waiting_permission` 为忙，`sendMessage` 硬拒），正是 `stop()` 自己注释声称要避免的更坏结果；
② 外部 thread 的 `turn/completed` 静默退休我方回合且不发终态（既无终态又无回合记录）。
**若当时按「实现绿了就落库」处理，这两条都会带进切片 3/4。**

**切片 2c 遗留五项**（如实登记，未混进「已完成」）：`serverRequest/resolved` 无消费者（切片 3/4 会
留下陈旧条目→「对不存在的请求回帧」）· `CodexTurnState.requestId` 只写不读 · `stop()` 的状态回声
仍是陈旧读数（二次 Stop 会再发一次 busy）· `turn/start` 的 30 分钟期限假设 [未测] ·
`turn/interrupt` 的实际效果 [未测]。

**切片 2a 已落地 `84ae4e1`（2026-08-09）**——八个新模块（codexWire / codexPending / codexStatus /
codexNodeEntry / codexHome / agentSupport / codexConnection / codexRuntime）+ `index.ts` 加法接线 +
main 侧 `hostEnv.ts`。四门：lint 813 文件 0 错 / typecheck 0 / typecheck:agent-host 0 /
**vitest 142 文件 2709 例 0 红**（较基线 133/2481 只增 +9 文件 +228 例）。**红线五文件 git diff 为空。**
两条**有意的有界限制**（不是缺陷，已登记）：`resumeSession` 回 `agent_unsupported`（归 5a 整条替换）·
`send()` 回 `not_implemented`（等 2c）。三条新登记的未决见 [open-questions](./open-questions.md) #6/#7/#8。

**切片 2 双轨合流已收口（2026-08-09）**——Opus + Codex 双盲同题，独立收敛 6 条（CODEX_HOME 按字面「隔离」不可实现 ·
`networkAccess:false` 我方下发不了 · 验收句按现有类型字面不成立 · pending「清表未回帧」是最危险失效 ·
禁止回落原生二进制 · flag env 本就全量继承），分歧 3 处已裁，单轨独有 12 条全部采纳。
**两条用户裁定**：Codex 随包（体积代价已实测登记）· 授权 transcript→仓库夹具。
仲裁与施工契约见 [arbitration 档](../../../plans/2026-08-09-s3-slice2-arbitration.md)。

**本片新增第四道门 `pnpm typecheck:agent-host`**：根 `tsconfig.json` 的 `exclude` 含 `src/agent-host/**`，
此前该目录**零类型检查**（实测根门编译 0 个文件）；切片 2 要在那里写全新的 `codexRuntime`，
不补门等于在无类型检查处写核心运行时。新门覆盖 266 文件。**此后门禁为四门，仍须逐门串行跑。**

## 阶段顺序（用户 2026-08-10 裁定）

**先做完当前切片 → 再进用户登录 → 最后接 Codex CLI 选择功能。**
每一阶段的**具体设计与需求，在进入该阶段时再逐轮明确**，不提前设计。

| 序 | 阶段 | 状态 | 备注 |
|---|---|---|---|
| 1 | S3 切片 3 / 4 / 5 / 6（提问桥 · 权限投影 · 历史 · 收口） | ✅ **全落（2026-08-15）** | 四片依序收口；切片 6 见上表行（#7/#8 一并了账） |
| 2 | **用户登录管理** | ✅ **D47 全收官（2026-08-16）** | 立项五点见[总台账 D47](../../../plans/openchamber-chat-refactor-ledger.md)：范围=凭据权威收敛到 app · 邮箱+验证码登录（无密码）· 服务端最小改（登录=换取既有 key，幂等假定需实证）· 单账号 · **落盘改 app 私有托管+注入（不再写 `~/.claude` 与 `~/.codex`）**；[#9](./open-questions.md) 按此解。既有口径「同一把 key、不同 URL」不变。设计规格 = [2026-08-15-login-management-design-spec.md](../../../plans/2026-08-15-login-management-design-spec.md)（rev.2：四调查 + 双轨双盲合取 + 拍板收口；U1 收编不清理 / U2 S5 收门禁 / U3 幂等经 onboard 源码 CONFIRMED（S7 删）/ U4 换邮箱历史接受现状；**S0 六项全收口 2026-08-15**：E1-lite 线上幂等双轮实证（变体邮箱同 key）/E2 信任标志 PASS/E3 无 ~/.claude 会话 PASS/E4 turn 级错误帧 fixture/E5 双臂判据（业务端点只认 cookie）/E6 safeStorage 窗前死锁发现，报告 docs/plans/2026-08-15-d47-s0-spikes/；**S1 已落地 `a53d130`**（规格 rev.2 双盲评审合取 `27e6db3` → 施工 20 文件，vitest 174 文件 3538 例，变异 8/8；CredentialVault/AuthStateService/IPC 消毒/双写/升格闩/dev.js flag）→ **S2 已落地 `2f7d60b`**（规格 rev.2 `6852238` 双盲合取 10B+20M；三员并行施工 50 文件；vitest 191 文件 3637 例；变异 16/16 零存活；托管 claude-home 两相启动/统一写手/Provider 裁剪/Scanner provenance/trust 矩阵）→ **S3+S4 合并落地 `50de617`**（规格 rev.2 `e65ecc8` 双盲合取 11B+15M，架构拍板 config 物化归 Main；vitest 195 文件 3727 例；变异 10/10；codex 生成模式/三态 resolver/终端注入/I5 屏障/normalizer 修复）→ **S5 已落地 `5e8b494`**（规格 rev.2 `9a393a6` 双盲合取 14B：双轨下沉 Main/argv 投递/resolveGateDecision 共享/probe 独立化/locked 第五臂/三现役 bug 修复；vitest 205 文件 3874 例；变异 10/10）→ **GUI 点验 14/14 PASS**（2026-08-15 全链真跑：真实登录/重启持久化/probe valid/用量卡/Claude 回合/终端 environ 铁证/codex 双路实转/登出预填；抓获「注册后漏接 refresh」缺陷当场修 `bf8de41`——测试与变异均未覆盖的接线缺席型；报告 docs/plans/2026-08-15-d47-gui-checklist.md）→ **S6 已落地 `8cfef4d`**（规格 rev.2 `0a49f8f` 双盲合取 10B【A 轨真机取证改写输入契约：源分级/网关集合 origin 守卫/零网络编排/userId 放宽/migration_incomplete】；vitest 208 文件 3973 例；变异 7/7；adoption.ts 收编模块 + 停双写 + logout 拆分 + rmSync 外科修）→ **真机双步过（2026-08-16）**：flag-off 造场（外科修实证）→ flag-on 冷启动**零重登**（vault 收编 + marker + legacy mtime 不动 = 停双写实证）；**分发纪律已解除**（flag 默认仍 off，转 on 属发布决策）。**D47 全链收官**（S0 六 spike + S1~S6 + GUI 14/14 + 收编双步；vitest 3482→3973；变异 51 对零存活）。遗留：投影链退役批（阶段 4 附注）· Bun 横幅小票 · test.4 补测项。 |
| 3 | **Codex CLI 选择功能接入** | **D48 已立项（2026-08-16）** | 即「聊天会话用哪个 agent」的 UI 入口。**注意三轴隔离**：现有 `AgentPickerMenu` / `SessionBar` 管的是终端 `BuiltinAgentId` 轴，**不是**聊天 `AgentWireName` 轴；`chatSessionActions.ts` 也没有 agent 参数。直接改旧 picker 会违反三轴隔离纪律，须另立入口。**D48 拍板（2026-08-16，见[总台账](../../../plans/openchamber-chat-refactor-ledger.md)决策表）**：范围 = 全套 codeg 形态（入口 + 模型/思考档按 agent 适配 + 权限管理面）· 绑定 = 零回合可选、物化后锁定。**调查轮四篇已落库（2026-08-16）**：[docs/plans/2026-08-16-agent-picker-investigation/](../../../plans/2026-08-16-agent-picker-investigation/README.md)（00 代码面 / 01 模型目录+cch+D40 / 02 权限面 / 03 codeg 参照 / **04 cch 线上实证**）；关键发现 = D40 Codex 半边显式丢弃 · Codex 权限读侧断链 · **cch 双轴 /v1/models 已实证可信（短名别名不被接受；codex effort 五档与 Claude 一致，D40 Codex 丢弃理由消除）**；**追加拍板（2026-08-16）：模型展示面 = 家族规则白名单 + `/v1/models` 动态推导**（Claude 三族各最新 / Codex 最高世代变体组；规则硬编码、型号动态推导，更新零代码；三级回落）；**双轨双盲已合取（A/B 稿 + [仲裁档](../../../plans/2026-08-16-agent-picker-investigation/design-arbitration.md)）**，拍板：D40 Codex 半边 model/effort **都补**（sticky 探针先行 + 回写收敛单真源 + 负控断言，A 轨反例转条件执行防线）；**定稿规格 rev.2 已产出并过三镜头对抗核查（36 发现修 34 否决 2，[规格](../../../plans/2026-08-16-d48-agent-picker-spec.md)）**；**§8.0 三项已拍板（2026-08-16）**：中途改档**必做**（S4 升正式切片，写侧 = Composer 实时 + Settings 默认双层）· 危险档给控件+警告+二次确认（绝不默认）· 开工前 P1/P2/P3 三探齐发（cch ≤8 发已批）。**三探针批已收官（06-probes.md：P1 sticky 成立 / P2 Claude per-turn options 成立 / P3 thread-settings-update 零回合生效，live 仅 3 回合）→ 规格升 rev.3**（S4 转正式切片 + 写侧双层 + §6 断言 D1~D15；§3 与施工基线逐字节一致）。**S1 已落地 `d42ff0a`（2026-08-16）**：picker ghost chip 二态 + sessionBinding 共享判据 + 红线纯加法 + A12 守卫；四门全绿 vitest 213/4066；变异 11/11；终检修两真缺陷；附 D47 ⑥b pin 勘误。**S2 已落地 `2e4f39d`（2026-08-16）**：目录代理化（家族白名单+四级回落+B18 守卫）+ D40 都补（turn/start model/effort + settings-updated 回写收敛）；四门全绿 vitest 220/4268；变异 31 行；终检修 1B2M + NUL 假绿风险。当前 = S3 施工（权限读侧补链 + Settings 默认档模板层）。 |
| 4 | **2b 打包链** | 待 | **体积已由用户 2026-08-10 拍板可接受**（141MB → 约 480MB，3.4×；codex 平台包单文件 296MiB）。原 open-q #1（C-15 的 +21MB）**一并关闭**。排期后置的理由：现在做只是让包变大，Codex 尚未到可用程度，无即时收益。 |

## Next

### ~~1. S3~~ —— **2026-08-06 已转 In Progress**（切片 0/1 已落地，见上）

<details><summary>S3 立项时的六切片定义</summary>

**六切片，依赖图 `0 → 1 → {2 → {3 → 4}, 5}`**（切片 5 同时依赖 2）。全部细节见
[S2 设计档 §3](../../../plans/2026-08-06-s2-codex-integration-design.md)。

| 片 | 内容 | 关键前置 |
|---|---|---|
| 0 | 类型与断言骨架（**零逻辑**） | 一次性消掉三方 payload 撞车；本仓「定义验证先于改代码」纪律 |
| 1 | 绑定回流链（18 跳 + 早退守卫放宽 + 唯一物化点 + 侧栏 chip） | **全局串行前置**——切片 5 的重启后 resume 完全依赖它 |
| 2 | Codex 客户端骨架（JSON-RPC + 单一 pending 表 + **单一 status mapper** + 隔离 CODEX_HOME） | 可与 1 并行开发，**合并在 1 之后** |
| 3 | 提问桥（用 a 抓到的 4 条真实报文做夹具回放） | 2 |
| 4 | 权限投影（decisions 表 + approvalCorrelator + 卡层） | 3（同批卡文件，不并行） |
| 5 | 历史：先档 A（`history_unsupported` 显式降级）再档 C | 1（threadId 落盘通道） |
| 6 | 收口：flag on/off 双跑 + 侧栏窄宽截图 + 台账 | —— |

**flag**：`AICLIENT_AGENT_CODEX`（默认 **off**，照抄既有 env 开关形状）。
flag 只控 `capabilities.agents` 与运行时注册，**不控协议字段/store 形状/渲染分支**（否则会长出两套形状）。

**门禁纪律**：逐门串行跑（本机内存有限，链式合跑曾 OOM）。

</details>

### ~~2. S2~~ —— **2026-08-06 已 Done**（见 Done 段）

<details><summary>S2 立项时的四项定义（2026-08-06）</summary>

裁定既定，下一件事是**设计**而非继续 spike。四项，前两项可并行：

| # | 事项 | 出口 | 说明 |
|---|---|---|---|
| a | **补 U1：真实提问报文** | 结 [#2](./open-questions.md) | 唯一出口；估 4–8 回合，「诱发实验」额度损耗率实测 50–75%。**不阻塞 b/c/d** |
| b | **会话 ↔ agent 绑定口径** | 结 [#3](./open-questions.md) | 落点已测准 4 处；硬约束：`session-index.json` 裸数组无迁移 → **「undefined 视作 claude」必须读侧显式实现** |
| c | **权限投影口径** | 结 [#5](./open-questions.md) 权限半 | Codex 4 维正交 → 我方 `permissionMode`；协议惯例支持只加可选字段不升版 |
| d | **历史跨 agent 的最小可接受降级** | —— | 全表**最大共同空洞**（三机制，见 reuse-boundary 末行）；两条路都没跑过 resume（U2）。短期大概率结论是「Codex 会话不支持 resume 历史」，但要**显式降级不是崩** |

**红线提醒**：b 要动 `stores/chatSessions.ts`（红线 store，走加法纪律），动工前回主线核对三处接缝。

</details>

### 2. ~~S1~~ —— **2026-08-06 已 Done**（见 Done 段）

### 2. ~~三条能力缺失~~ —— **已于 2026-08-05 正式平移主线并分配任务节点**

不再挂在本 plan。三条各自成任务，定义与验收标准的权威在
[执行计划 §3](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md)：

| 任务 | 一行目标 | 估时 |
|---|---|---|
| **T-33** | 网络重试横幅——数据已在 `chatSessions.ts:85` 的 `retry`，只差 UI | 0.5d |
| **T-34** | 子 agent 实况——开 `forwardSubagentText` + 协议加可选字段 + **UI 嵌套渲染（真正的工作量）** | 1.5d |
| **T-35** | Host stderr 进 UI——`claudeRuntime.ts:677` 已有 `[cli-stderr]`，开事件 + 脱敏 | 0.5d |

**为什么归主线而不是本 plan**：三条都只用 Claude 直连链上已有的数据，与「接不接 ACP」这个
根问题（[#1](./open-questions.md)）**互不依赖**——把它们压在后置的本 plan 下会被一并冻住，
而它们本可以随时做。判断依据仍见 [acp-decision](./topics/acp-decision.md) 末表
（三条走 ACP 都只会更绕）。

**T-34 的已知限制**（与本 plan 相关，故在此留指针）：resume 重放的 `HistoryBlock` 无子 agent
归属概念，与 D20 问答卡是同一个协议缺口，根治须扩历史协议（C-17，后置）。

## Deferred

- **多 agent 协同工作** —— 用户 2026-08-04 明示「先放一放」。codeg 有此能力（`src-tauri/src/acp/delegation/`），
  作为远期参照保留，本阶段不评估。
- **第 3 个及以后的 agent**（Gemini / Cursor / OpenCode / …）—— 它是否存在正是 ACP 判据本身
  （见 [open-questions #1](./open-questions.md)），不作为承诺。
- **扩 git 能力对齐 codeg** —— 用户表达了偏好但未指明具体点，且同轮裁定本阶段 git 维持最小集
  （见 [open-questions #4](./open-questions.md)）。
