# Roadmap — 多 Agent 接入

> 状态：**In Progress — S3 施工中，切片 0/1 已落地**（2026-08-06 同日四连：解冻 → S1 spike → S2 设计 → S3 开工）。
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
| **2** Codex 客户端骨架 | 下一件 | JSON-RPC + 单一 pending 表 + **单一 status mapper** + 隔离 `CODEX_HOME` |
| **3** 提问桥 | 待 2 | 用 S2-a 抓到的 4 条真实报文做夹具回放；**`isSecret` 要补掩码**（§0.5-②） |
| **4** 权限投影 | 待 3 | 同批卡文件，不与 3 并行 |
| **5** 历史 | 待 1+2 | 先档 A（`history_unsupported` 显式降级）再档 C |
| **6** 收口 | 待全部 | flag on/off 双跑 + **侧栏窄宽截图（U8）** + 台账 |

**切片 0/1 的双轨对抗复核（Opus + Codex 双盲）1 blocker + 5 major + 2 minor 全闭环**，
两轨互补显著——blocker 与 registerSession 缺口**仅 Codex 见**，typecheck 盲区与自报身份零覆盖**仅 Opus 见**，
静态扫描形同虚设**双轨同判**。详见[主线台账](../../../plans/ledger-claude-mainline.md)。

**本片新增第四道门 `pnpm typecheck:agent-host`**：根 `tsconfig.json` 的 `exclude` 含 `src/agent-host/**`，
此前该目录**零类型检查**（实测根门编译 0 个文件）；切片 2 要在那里写全新的 `codexRuntime`，
不补门等于在无类型检查处写核心运行时。新门覆盖 266 文件。**此后门禁为四门，仍须逐门串行跑。**

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
