# D48 施工规格（定稿 rev.3）— Codex CLI 选择功能（阶段 3）

> 2026-08-16。**定稿 rev.1 = A 稿（Opus 轨）为底本 + B 稿（Codex 轨）吸收项 + 仲裁档裁定 + 用户拍板三条**
> （家族规则白名单 / D40 model-effort 都补 / 官方 CLI 中途 `/model` 佐证）。
> 权威链：[仲裁档](./2026-08-16-agent-picker-investigation/design-arbitration.md)（最高）→
> [A 稿](./2026-08-16-agent-picker-investigation/design-track-a.md) →
> [B 稿](./2026-08-16-agent-picker-investigation/design-track-b.md) →
> [05 设计任务书](./2026-08-16-agent-picker-investigation/05-design-brief.md) → 调查 00~04。
> 一切与仲裁档冲突处以仲裁档为准（**唯一例外**：仲裁 §1 收敛表「权限写侧首期只管创建/恢复默认档」行已被仲裁 §4-3-Q1 的用户拍板自我改判，以 §4-3 为准）；本文自身是施工唯一入口，实现方对标注「实现方可否决」的项保留否决权（**rev.3 起全文已无「条件执行」项**）。
>
> **rev.2（2026-08-16，三镜头对抗核查后修订）**：① 越权自裁的写侧落点与危险档控件退回 **§8.0 需用户拍板**（仲裁 §1 只裁持久化位置）；② `agentBindingLocked` 的来源与 `ChatWorkspace.tsx` 改动面补齐（照 rev.1 抄编译不过）；③ 锁定判据按 store/UI 分层（`sendAttempted` 不在 store）；④ 锁定态收敛为单段静态 chip（`deriveMiddleColumnMode` 实测：session 模式恒锁定）；⑤ `lastAgent` 记忆移出 S1 并补 hydration 口径；⑥ 回退回写 / 空列表发送守卫 / 消费侧回写 / unverified 存量选择 / Main 侧 model 校验各补断言与变异对；⑦ cache key 去掉不存在的 `credentialGeneration`；⑧ 十余处行号引用按 `cat -n` 实测校正。
>
> **rev.3（2026-08-16，用户三项拍板 + 三探针实证后修订）**
>
> **拍板三条**（[仲裁 §4-3](./2026-08-16-agent-picker-investigation/design-arbitration.md)）：① **Q1：中途改权限档 = 必做**（用户原话「肯定要支持中途改啊」）——**S4 由条件切片升为正式切片**，写侧收敛为**双层**（Composer 实时控件管当前会话 + Settings「Chat agent defaults」默认模板管新会话起点，与 codeg 同构）；仲裁 §1 收敛表「权限写侧首期只管创建/恢复默认档」行按本条**改判作废**。② **Q3：危险档给控件 + warning + 二次确认，默认值绝不是危险档**（两层同口径，断言钉死）。③ **Q4：P1/P2/P3 三探开工前齐发**——**已执行完毕**。
>
> **探针三证**（[06-probes.md](./2026-08-16-agent-picker-investigation/06-probes.md)，live 3 回合 / 预算 ≤8，本地配置零写入）：**P1 ✅** `turn/start` 覆盖 model 是 sticky（覆盖写进线程常驻设置并广播 `thread/settings/updated`；`sandboxPolicy` 同样 sticky）⇒ §4.6 防线 ① 已过、S2 的 D40 半边不再条件执行；**P2 ✅** Claude 中途改档 = per-turn `query()` options（无需 `setPermissionMode`、无 streaming-input 前提），`CHAT_PERMISSION_MODE` 的**三消费点须同喂**（`:754` query options / `:341` session.created / `:391` session.resumed）；**P3 ✅** `thread/settings/update` 存在、零回合生效、**未知字段静默吞**（⇒ 类型 + 单测兜底）。
>
> **本轮受影响章节**：文档头 · §0.1/§0.2 · §1.1 · §2 · §4.6（连带 §4.8-B8 / §4.9-⑥）· §5.1/§5.4/§5.5/§5.7/§5.8 · **§6 全面改写** · §7 · §8 · §9。**§3（S1）一字未动——S1 正在施工。**
> **已知悬挂引用（不本轮修）**：§3.3 有一处括注「S3 若将来恢复 per-session 权限控件（§8.0-Q1）须同 import」——rev.3 口径下该分支**不会发生**（S4 的权限控件**不消费**锁定判据，见 §6.3 与 D13），因 §3 冻结，留待 S1 收口 as-built 时一并清理。

---

## §0 结论先行

### 0.1 三句话

1. **切四片，依赖序 S1 → S2 → S3 → S4（rev.3 起四片全为正式切片）**：S1 = agent picker + 零回合绑定（纯渲染端 + `capabilities.agents` 首消费者，零协议改动）；S2 = 模型目录代理化（家族白名单过滤）+ D40 Codex 半边补齐；S3 = 权限读侧闭环 + 新会话默认档写侧（**模板层**）；S4 = **会话中途改权限档（Q1 拍板，由条件切片升正式切片）**：Composer 实时控件 + 两条已实证通道（Claude per-turn `query()` options / Codex `thread/settings/update`）。
2. **目录服务归 Main，不进 agent-host、不塞 `host.ready`**：凭据只在 Main 的 CredentialVault（`CredentialVault.ts:52-56`），agent-host 子进程只拿到 `AICLIENT_CODEX_API_KEY` 一个 key、**没有任何 baseUrl**（`hostEnv.ts:64-71` 八键全列）；把目录查询放进 Host 需要新增 env 键扩散凭据面，与 D47「凭据权威收敛到 app」直接冲突。范式照抄 `UsageService.ts:102-131`（`resolveManagedCredentialsEnabled` → vault → `net.fetch`），走**独立 IPC**，key 与 baseUrl 都不进 renderer（`runtimeEvents.ts:85-115`：capabilities 只描述 Host build 能力）。
3. **D40 Codex 半边 = `buildTurnStartParams` 补 `model` 与 `effort` 两者**（用户拍板 2026-08-16，双轴行为对称优先；官方 codex CLI 会话中途 `/model` 即上游一等公民路径）。A 稿「不补 model」的双真源分析**不丢弃**，全部转为三条防线（① 探针先行 —— **rev.3 已过：P1 实证 sticky 成立** / ② 覆盖后回写收敛为单一真源 —— **回写值取 `thread/settings/updated` 广播，不做乐观更新** / ③ 中途改 model 路径必须有显式测试与变异对），见 §4.6。

### 0.2 定稿相对双轨草案的改判清单

> 施工方只读本文即可；此表是给评审者的差异索引，说明「为什么与你读过的某一稿不同」。

| # | 改判项 | 双轨原状 | 定稿 | 依据 |
|---|---|---|---|---|
| 1 | D40 Codex 半边 | A：只补 effort，不补 model | **model / effort 都补 + 三条防线** | 仲裁 §2.1 用户拍板；A 的双真源分析降级为防线理由 |
| 2 | 目录数据形状 | A/B 均为「代理返回的全量目录」（claude 15 / codex 10） | **家族规则白名单过滤后的目录**（Main 侧过滤层），种子表六条 | 拍板 #5（05 简报 :12）+ 仲裁 §3 |
| 3 | 不可用 agent 的表达 | A：`agents.length < 2` 整个 picker 不挂载 | **恒渲染两项，不可用项置灰 + tooltip 原因** | 仲裁 §1；`runtimeEvents.ts:104-108` 类型注释本就写 disable 而非 hide |
| 4 | 三态琥珀点 | A 的可选加法 C1 / codeg 参照 | **不做（首期二态）**，扩 wire 进遗留登记 | 仲裁 §2.2；N2：`HostAgentDetail.reason` 不过 wire |
| 5 | 切片数 | A：3 片（中途改档并进 S3 探针） | **4 片，S4 单列且为正式切片**（rev.2 曾记「条件切片」，rev.3 按 Q1 拍板升格） | 仲裁 §1 采 B 的单列形式，边界更清晰；仲裁 §4-3-Q1 定「中途改档必做」 |
| 6 | 锁定判据 | A：`computeEverHostBound`；B：`onSendStart()` latch | **两者合取**：`sendAttempted \|\| hostBound \|\| runtimeIdentity != null` | 仲裁 §2.2「两轨各答了半边」 |
| 7 | agent 草稿存哪 | A：新 localStorage key + `resolveDraftAgent` 双路径接线 | **store 窄 action `setDraftSessionAgent`（零新字段）** | B §3.3；`chatSessions.ts:95-114` 只禁「第二默认值」，不禁用户显式选择；A 的「读一律经 `sessionAgent()`」与显式回退语义保留 |
| 8 | 目录缓存介质 | A：进程内 + `<userData>` 磁盘缓存 TTL 24h | **仅进程内内存 cache**，磁盘快照不做 | 仲裁 §2.2 回退链写死「进程内 stale cache」；B U2 的「昨日目录冒充当前真源」关切 |
| 9 | 目录回退第三级 | A：内置 snapshot = 04 实测 25 条全表 | **内置种子表 = 白名单过滤后六条，`source:'seed'` 且 UI 显示「目录不可达」** | 仲裁 §2.2（合取 B 的「不得伪装可用目录」）+ 拍板 #5 |
| 10 | 新会话默认 model | A：取目录第一条 | **`Automatic`（省略 model）** | B U1：不猜服务端/规则排序；短名常量 `DEFAULT_CHAT_MODEL_ID` 同样退役。**实现方可否决**：若 Claude 轴 Automatic 在 resume 后产生可感知漂移（`agentHost.ts:91-96`），退到「该 agent 的 `byAgent` 默认；仍无则退到 §4.2 定义的**本仓确定性家族序首条**」——注意该序是本仓硬编码的家族序，**不是 `/v1/models` 的返回序**（返回顺序不做任何语义假设，B U1 原意如此），回退到安全态 |
| 11 | 权限写侧落点与持久化 | A：Context 面板未物化可写 + localStorage | **双层写侧**：Settings 新增「Chat agent defaults」区（新会话模板，S3）+ **Composer 实时权限控件（当前会话中途可改，S4）**；Context 面板**恒只读** | **持久化位置**由仲裁 §1 裁定（app settings 独立区、不复用终端轴 AgentSettings、不写 `~/.codex/config.toml`）；**写侧 UI 落点由 §8.0-Q1 拍板**（仲裁 §4-3：与 codeg 同构的双层；rev.2 的「只做 Settings 模板」推荐案作废）；B §5.3 Preference/Policy 双类型要求 Context 只承载 Host 回声 |
| 12 | 权限 preference 的会话快照 | A：无（草稿不跨重启） | **首发时物化进 session-index 可选字段，resume 优先会话快照** | B §5.3：否则改 Settings 会在重启后静默改变旧会话安全姿态 |
| 13 | 会话中途改权限档 | A/B 均为**条件执行**（探针不成立即该轴不做） | **必做，S4 正式切片**：Claude = per-turn `query()` options（P2）；Codex = `thread/settings/update`（P3）；成功后**更新会话快照、不回写全局模板** | 仲裁 §4-3-Q1 用户拍板；06-probes P2/P3 两条通道均实证成立 |
| 14 | 危险档控件 | A 推荐 (a) 给 + warning + 二次确认（未拍板）；rev.2 挂在 §8.0-Q3 待拍 | **拍定 (a)**：给 + warning + **二次确认** + **绝不做默认/回退值**，模板层与实时层**两层同口径**；Claude `bypassPermissions` 下发时必须同发 `allowDangerouslySkipPermissions:true` | 仲裁 §4-3-Q3 用户拍板；扩权键出处 = 06-probes P2（`sdk.d.ts:1729`） |

### 0.3 承重事实（调查抽查 + 本批新发现）

调查引用抽查（A 稿复核，定稿沿用）：

| 调查断言 | 复核 | 备注 |
|---|---|---|
| `capabilities.agents` UI 零消费 | ✅ 成立 | 全 renderer `capabilities` 命中 8 处，唯一生产消费者 `ChatWorkspace.tsx:49` 读 `.thinking`；`hostStatus.ts:35`（`:29-38` 的 JSDoc）自述 "Today's only consumer is test assertions" |
| agent 物化点 = `sendMessage()` | ✅ 成立 | `chatSessions.ts:1030-1037`；`chatSessionActions.ts:30-38` 确无 agent 字段 |
| `buildTurnStartParams` 只发 `{threadId, input}` | ✅ 成立 | `codexRuntime.ts:259-265`，丢弃理由注释 `:246-256` |
| Codex 权限读侧断链 | ✅ 成立 | `contextSurfaceModel.ts:499-501` 只认 `payload.permissionMode`；`isSessionPermissionMode` 只查 5 值白名单（`:447-451`） |
| cch 双轴 `/v1/models` 可信 | ⏸ 未复跑 | 采信调查 04 当日实测；§4.1 的四级回落使设计不依赖它长期为真 |

**五条承重新发现（改变了设计形状，调查五篇未记载）**：

- **N1 · `capabilities.permissionPolicy` 类型已存在但 Host 从不发。** `runtimeEvents.ts:109-115` 定义了 `permissionPolicy?: boolean`（注释 "Absent = old Host, UI keeps the old `permissionMode`-only behaviour"），而 `agent-host/index.ts:363-373` 实发的 capabilities 只有四键 `{history, thinking, subagentActivity, agents}`（本批以 `grep -n permissionPolicy src/agent-host/index.ts` 复验：零命中）。**S3 的现成降级闸门，白捡。**
- **N2 · `HostAgentDetail.reason` 不过 wire。** `agentSupport.ts:116-131` 的 `detail[]` 只在 Host 进程内合成 `agent_unsupported` 文案（`index.ts:82-93`）；`capabilities.agents` 只是 `detail.filter(available).map(agent)`（`:185-188`）。→ 渲染端只知道「codex 不在列表里」，**永远不知道是 flag_off 还是 credentials_missing 还是 entry_missing**。codeg 的琥珀点三态在本仓当前协议不可表达 → 定稿二态（§3.4），文案必须用不承诺原因的措辞。
- **N3 · 「已物化」判定已有单一真源，且今天已经有两处镜像。** `computeEverHostBound`（`useComposerTarget.ts:83-91`，`hostBoundSessionIds.includes(id) || runtimeIdentity != null`）；`isLiveOnlySession`（`useSessionIndex.ts:205-219`，注释自陈 "Same criterion as `computeEverHostBound`"）；`MiddleColumnModeInput` 的三元组（`middleColumnLayout.ts:25-30`，`sendAttempted` + `hostBound` + `hasRuntimeIdentity`，注释 "mirrors `computeEverHostBound`"）。**picker 的锁定判定必须复用同一符号，不得写第四份**（§3.3）。
- **N4 · `reduceSessionRuntimeFacts` 有一道早退陷阱，且代码里已有前车之鉴。** `contextSurfaceModel.ts:489-491` 的 created/resumed 守卫之前，`:479-482` 的 D33 注释明写三个 usage 分支必须放在守卫之前否则「静默 no-op 穿过去」；而 `:499-501` 还有一道 `if (!isSessionPermissionMode(permissionMode)) return prev;` ——**Codex payload 没有 `permissionMode` 键，会在这里 return，`permissionPolicy` 永远读不到**。断言点 §5.7-C2。
- **N5 · 锁定三元组与「中列模式」判据是同一组输入。** `middleColumnLayout.ts:25-30` 已经把 `sendAttempted / hostBound / hasRuntimeIdentity` 三个布尔并列传入，`ChatWorkspace.tsx:162` 的 `onSendStart={markSendAttempt}` 就是那个 sticky latch 的写入点。→ 仲裁裁定的「`computeEverHostBound` + `onSendStart()` 时机」合取**不是新发明**，而是把中列已在用的三元组提取成共享判据（§3.3）。

---

## §1 定稿约束与施工纪律

### 1.1 已拍板约束（不可重开，来源 05 简报 :6-12 + 仲裁 §4）

1. **范围 = 三块全做**：agent 选择入口（`capabilities.agents` 首个 UI 消费者）+ 模型/思考档按 agent 适配 + 权限模式管理面。
2. **绑定语义 = 零回合可选、物化后锁定**；换 agent 等于另开会话，不迁移 runtime identity（`openchamber-chat-refactor-ledger.md:92`）。
3. **三轴隔离**：不碰终端轴 `AgentPickerMenu`/`SessionBar`；聊天轴另立入口；`AgentWireName` 与 `BuiltinAgentId` 不互转（静态断言已钉，`agentWireStatic.test.ts` 保持绿）。
4. 沿用既定：D45 直连（无 ACP config_options 通道）；flag `AICLIENT_AGENT_CODEX` 只控 Host registry/capabilities 与运行时注册，**renderer/store 形状不得因 flag 分叉**；红线 store `chatSessions.ts` 只走加法。
5. **模型展示面 = 家族规则白名单 + 动态推导**（拍板 #5，落点见 §4.2）：规则硬编码，型号动态推导；全新家族名默认不上架；三级回落含内置种子表（**拍板原话是「三级回落」；定稿在其后加了 `Automatic + Retry` 兜底，共四级，见 §4.1** —— 加的是最后一级安全态，不改前三级）；静态短名表 `CHAT_MODELS` 随之退役。
6. **D40 Codex 半边 = model / effort 都补**（拍板，见 §4.6 的三条防线；**防线 ① 探针已过**）。
7. **中途改权限档 = 必做需求**（拍板 2026-08-16，仲裁 §4-3-Q1，用户原话「肯定要支持中途改啊」；理由与 D40 同构——官方 CLI 两侧都支持中途改档，后端即同一 CLI 运行时）：**S4 升为正式切片**；写侧 = **Composer 实时控件（当前会话）+ Settings 默认模板（新会话起点）双层**，与 codeg 同构。**仲裁 §1 收敛表「权限写侧首期只管创建/恢复默认档」行按本条改判作废**（该表其余行不变；权限数据的**持久化位置**裁定仍有效）。
8. **危险档 = 给控件 + warning + 二次确认 + 绝不做默认值**（拍板，仲裁 §4-3-Q3）：模板层与实时层**逐条同口径**，断言钉死（§5.7-C13/C16、§6.5-D3/D12）。

### 1.2 运维铁律（仲裁 §3.5，约束全部后续探针与施工，用户原话强调）

- **绝不更改开发机本地 `~/.claude/` 与 `~/.codex/` 配置文件；绝不用 cch 远端获取的密钥覆盖本地配置。** 本机 Claude Code 走官方订阅用量；cch 是公司付费按量 API（昂贵），两套凭据体系不得互串。
- 一切打 cch 的探针（含 §4.6 的 model sticky 探针、§6 的 `thread/settings/update` 探针）：**事前向用户报测试项与预计用量，批准后以最小 payload 执行；只读端点优先。**
- 被测 app 的托管凭据链（D47 vault）只写 `<userData>/credentials` 与 app 私有 home——施工中若发现任何路径会写用户全局配置，**即为缺陷，当场拦**。
- **本地不得主动拉起完整 app 走注册/登录流程做测试**（历史上正是这条路把 cch key 写进了开发机 `~/.claude/settings.json`）。各片 GUI 点验确需拉起时：URL 用测试方案（mock-cch / 测试环境）并以**进程注入**植入，不修改开发服务器 env 与任何本地全局配置；登录态相关点验优先用免登录/免额度手段（借 rollout、fixture 回放）。

### 1.3 收口条件与证据（每片一致）

- 四门**逐门串行**（链式合跑曾 OOM exit 137）：`pnpm typecheck` → `pnpm typecheck:agent-host` → `pnpm lint` → `pnpm test`。门禁权威见 `docs/plantree/baseline/test-and-release-gates.md:3-18` 与 `package.json:30-34`。
- 基线 = D47 收官态 **208 文件 3973 例 0 红**；每片 as-built 记实跑文件数/例数。
- 每片按规范 12/4/15 条：**先落会红的纯函数/协议结构/fixture 断言，再补实现**；断言钉过程与状态机而非观感；变异**逐对实跑并抄红灯原文**；flag off/on 双轮各跑一次。
- 每片 as-built 段落必须记：git commit · 四门逐门实跑输出 · 变异逐对红灯原文 · off/on 双轮结果 · 新增/改动文件清单 · 规格偏差条目。
- GUI 点验只补自动化覆盖不了的部分（focus/tooltip/菜单切换/cch 实链），并遵守 §1.2。

---

## §2 切片划分与依赖序

| 片 | 名称 | 范围 | 依赖 | 协议改动 | 独立可回归 |
|---|---|---|---|---|---|
| **S1** | agent picker 与零回合绑定 | Composer 新入口 + `capabilities.agents` 首消费者 + 锁定判据下沉（含 `ChatWorkspace.tsx` 计算并下传 `agentBindingLocked`）+ 降级矩阵 | 无（**不含跨会话 `lastAgent` 记忆**——它要动 app settings 三处落点，整体推迟到 S2，见 §3.3-4） | **无** | ✅ 四门 + off/on 双轮 + 两轴首发 GUI |
| **S2** | 模型目录代理化 + D40 Codex 半边 | Main `AgentCatalogService`（含家族白名单过滤层）+ 1 条 IPC + per-agent 目录/偏好（`ChatAgentDefaults` app settings 区，含 `lastAgent`）+ 短名兼容 + `turn/start` 补 model/effort | **S1**（P1 探针 **✅ 已过**：sticky 成立，见 [06-probes §P1](./2026-08-16-agent-picker-investigation/06-probes.md)；D40 半边**不再条件执行**） | 加法（`CodexTurnStartParams` 加可选 `model`/`effort`；app settings 既有通道加字段，无 Host 协议改动） | ✅ 四门 + **四级回落四轮**（含凭据不可用臂）+ D40 payload |
| **S3** | 权限读侧闭环 + 新会话默认档 | Codex 读侧补链 + `capabilities.permissionPolicy` 补发 + Settings「Chat agent defaults」+ create/resume preference 通道 | S1（按 agent 分岔） | 加法（capabilities 补键 + create/resume 加可选 preference + session-index 可选字段） | ✅ 四门 + 双轴 Context 对照 |
| **S4** | 会话中途改权限档（**正式切片**） | Composer 实时权限控件（idle-only）+ Claude `CHAT_PERMISSION_MODE` 升会话态（**三消费点同喂**）+ Codex `thread/settings/update` 通道与 `thread/settings/updated` 回声订阅 + 会话快照更新 | **S3**（通道已实证，不再条件执行） | 加法（`CODEX_METHOD` 扩 `thread/settings/update`，**须先落 contract fixture**；runtime command 加法，renderer 形状不按 flag 分叉） | ✅ 四门 + 双轴 idle/busy 双轮 + 危险档二次确认 |

**为什么是这四片**：

- **S1 与 S2 不能合**：S1 是零协议、零 Main、纯渲染端的一片（**跨会话 `lastAgent` 记忆因此不能留在 S1**——它要动 `stores/settings/` 的 `types.ts`/`defaults.ts`/`migration.ts` 并踩异步 hydration 竞态，见 §3.3-4/§4.3），可在 flag-off 下全绿收口并单独 GUI 点验；S2 一并入就把「新增 Main 服务 + 网络 IO + 缓存 + Host 协议加法」拖进同一次回归，失败面从一个组件扩到四个进程边界，红了分不清是谁。
- **S2 与 S3 不能合**：唯一耦合点是「都要按 agent 分岔」，而那个分岔在 S1 已建立。
- **S2 内部不再切第 4 片**：「目录查询」与「D40 半边」看似可分，但补 model/effort 的前提就是目录/词表已有真源，拆开会让 S2 落一个「查了目录但没人用」的半成品，违反规范第 6 条（每个能力都要能 on/off 双跑并各自有意义）。
- **S4 单列，但 rev.3 起是正式切片**（单列形式仍采 B 稿；升格依据 = 仲裁 §4-3-Q1）：两条通道已由 06-probes 实证（P2 Claude per-turn options / P3 Codex `thread/settings/update`），**「探针不成立就不做」的臂已删除**。单列的理由改为工程边界——S4 是唯一一片要动 `CODEX_METHOD` 方法表、把 `CHAT_PERMISSION_MODE` 常量升成会话态、并新增一条设置回声订阅的切片，与 S3 的「读侧 + 模板写侧」是两套失败面。**S4 仍不得成为 S1~S3 的暗含前提**：S1~S3 各自可独立收口发布，产品在 S4 落地前不出现实时权限控件。

**最小安全交付线 = S1 + S2 + S3 + S4**（rev.3 按 Q1 拍板扩线；S2 的 D40 半边**不再条件执行**——P1 已过）：用户能零回合选 agent；模型/effort 由代理真实目录（白名单过滤）驱动且 Codex 轴覆盖后成为线程新默认；权限既能如实展示、能管新会话默认模板，**也能在会话中途改当前会话的档位**。

> **与 rev.2 的差别要读清**：若 S4 因排期延期，S1~S3 仍是可独立发布的安全态（不渲染实时控件，模板层照常工作）——但那是**延期**，不是 rev.2 的「条件不成立就不做」。中途改档已是承诺的需求，不得再以「探针」为由缩范围。

---

## §3 S1 — agent picker 与零回合绑定

### 3.1 组件形态：两段式 segmented ghost pill

**新增文件**：`src/renderer/components/chat/ComposerAgentPicker.tsx` · `composerAgentPickerModel.ts`（纯视图模型）· `sessionBinding.ts`（§3.3 提取）· `__tests__/composerAgentPickerModel.test.ts`。

**改动面（既有文件，S1 全清单）**：`ChatComposer.tsx`（组装 + 新 prop `agentBindingLocked` / `agentSendAttempted` + 发送守卫）· **`ChatWorkspace.tsx`（计算 `agentBindingLocked` 并下传，另下传原始 `sendAttempted` latch——该 latch 只有它有，见 §3.2 与 §3.8-⑤）** · `chatSessions.ts`（窄 action `setDraftSessionAgent`）· `useComposerTarget.ts`（`computeEverHostBound` 改 import 共享模块）· `__tests__/pureModuleImports.test.ts`（`TARGET_FILES` 加两个新纯模块）。

**改动面补记（rev.3 规格未列、施工实际动到的 7 个文件；口径见 §3.8-⑦）**：新增测试 3 个 —— `__tests__/composerAgentPickerWiring.test.ts`（A3 composer 臂 / A6 / A10a / A10b / A11 / A12 源扫描）· `__tests__/sessionBinding.test.ts`（A2 真值表 + 消费者 import 扫描）· `stores/__tests__/chatSessionsDraftAgent.test.ts`（A5a / A5b / A7 store action 单测）；fixture 存根 4 个（`ChatSessionsState` 加了 action，既有 `baseState()` 工厂必须补桩，否则类型不全）—— `components/chat/__tests__/historyError.test.ts` · `stores/__tests__/chatSessionsBatch.test.ts` · `stores/__tests__/chatSessionsCore.test.ts` · `stores/__tests__/chatSessionsHistory.test.ts`。

- 底座 = 仓内已有的 `ToggleGroup`/`Toggle`（`components/ui/toggle-group.tsx:88` 导出 `{ToggleGroup, Toggle, ToggleGroupItem, ToggleGroupSeparator}`，Base UI 底层），`type="single"` 单选语义（或等价 `role=radiogroup`）。**禁止手写 segmented control**（CLAUDE.md 组件优先条）。候选集恒为 ≤2 项（`AgentWireName` 是闭合两元，`agentWire.ts:43-45`），为两项开一层 popup 是纯负收益。
- **必须遵守本仓 ghost chip 规则**（`docs/design-system.md:360-388`，B 稿吸收项）：`h-6`（小按钮 24px）、`rounded-sm`、`text-ui`；**四条硬性禁止**——任何 `border*`、任何 `shadow*`（含 `before:` 内高光）、任何 `min-w-*`、`rounded-md` 及以上。静息无壳，`hover:bg-hover` 与 `focus-visible:` **成对**给同一层底色（`:383-385`：只挂 hover 会让键盘用户完全失去控件边界）；弹层/选中态用 `data-[popup-open]:bg-selection`，不叠 `/N` alpha。
  > `design-system.md:281-286` 记录过实测教训：Composer 的 Model/Effort 触发器写 `rounded-lg` 挂 `h-6` 渲染成满圆胶囊——**不照搬 codeg 的满圆大胶囊**。同一条工具条上只允许一种 ghost chip 形制，高度类与横内距类须与 `composerModelTriggerClass()`（`chat/middleColumnLayout.ts`）一致，可交叉断言。
- 当前项 `bg-selection text-foreground`，非当前项静息透明；窄宽时隐藏非当前项长 label，只留图标 + `sr-only` 名称，**不得靠固定 min-width 抢 textarea**；`min-w-0 flex-1 truncate` + 图标 `shrink-0`。
- 图标用 Lucide；**label 唯一来源 = `AGENT_DISPLAY_NAMES`（`agentWire.ts:48-51`）与 `AGENT_WIRE_NAMES`**，不新建第二张文案表、不复制字面联合。
- **不可用与锁定原因必须有 tooltip/title，不能只靠 opacity**（B §3.1）。

### 3.2 落点与组装

`ChatComposer.tsx` 两处底栏，**两处都紧邻 `modelEffortControls` 左侧**，但整体位置各按本模式的既有阅读序：

```
session 模式 :2455-2461  → [attachButton, textareaEl, statusLine, agentPicker, modelEffortControls, actionButtons]
empty  模式 :2474-2479  → [attachButton, agentPicker, modelEffortControls, statusLine, actionButtons]
```

- **empty 模式为什么在 model 左边**：`:2470-2473` 的注释把 empty 底栏阅读序定义为 "⊕ → model → status → actions"，理由是「两个开启一条消息的控件挨在左边」。agent 在语义上**先于** model（选了 agent 才知道有哪些 model——§4.3 的 per-agent 目录就是这个依赖的物化），放右边会让阅读序与因果序相反。
- **session 模式为什么不插在 `attachButton` 之后（吸收 B 稿 §3.2）**：那条 "⊕ → model → status → actions" 注释是 **empty 模式专有**的，session 行的既有序是 `[attach, textarea, status, modelEffort, actions]`（实测 `ChatComposer.tsx:2455-2461`），没有同款阅读序可援引。插在 `attachButton` 之后有两个实害：① picker 与 model 之间隔着整个 textarea + status line，§3.1「同一条工具条上只允许一种 ghost chip 形制、高度/内距与 `composerModelTriggerClass()` 可交叉断言」的**相邻假设失效**；② session 行左侧宽度直接压 textarea，而 §3.1 明令**不得抢 textarea 宽度**。故 session 模式采 B 稿序 `attach → textarea → status → agent → model/effort`。

**锁定态的形态（承重：它是 session 模式的常态，不是边缘态）**：实测 `deriveMiddleColumnMode`（`middleColumnLayout.ts:41-60`）——`sendAttempted || hostBound || hasRuntimeIdentity` 任一为真即判 `session` 模式。**反过来说：可交互的两段 picker 只可能出现在 empty 模式，session 模式下它几乎恒为锁定态**。因此锁定态**不渲染「两段全置灰」**（那会给每个已建立会话的单行底栏留一个永久占宽的死控件），而收敛为**单段静态 chip**：只显示 `sessionAgent(session)` 的图标 + 名称，非交互（`aria-disabled`）、tooltip `Agent is fixed after the first send`。渲染分叉由 **`locked` 而非 `mode`** 驱动（session 模式下未锁定的边缘态——只有 historyError/busy 而尚未绑定——仍渲染两段 picker）。

> **与改判 #3 不冲突**：仲裁 §1 裁的是「**不可用 agent** 置灰而非隐藏」，那是**可选场景**下的表达；锁定态属 05 简报拍板 ② 自陈的「已物化会话 picker 转只读，**具体只读形态是设计项**」。

**`locked` 从哪来（施工必读，照 A 稿原文抄会编译不过）**：`sendAttempted` sticky latch 是 `ChatWorkspace` 的本地 `useState`（实测 `ChatWorkspace.tsx:57-65` 的 `sendAttempts` + `markSendAttempt`），`ChatComposer` 只拿到写回调 `onSendStart?: () => void`（`ChatComposer.tsx:101`、`:242`），**读不到 latch 值**；`turnSendStatus.ts` 也不是替代品（头注 `:28-36` 自陈 "One slot, not a per-session map"，是 in-flight 快照而非 per-session sticky latch）。所以 `locked` **必须在 `ChatWorkspace` 算完再作为新 prop 下传**：

```tsx
// ChatWorkspace.tsx —— 与 deriveMiddleColumnMode 同一组输入（N5），零新状态
const agentBindingLocked = isChatAgentBindingLocked({
  sendAttempted: sendAttempts.includes(activeSessionId ?? ''),
  hostBound: hostBoundSessionIds.includes(activeSessionId ?? ''),
  hasRuntimeIdentity: activeSession?.runtimeIdentity != null,
});
// …
<ChatComposer mode={mode} disabled={…} onSendStart={markSendAttempt} agentBindingLocked={agentBindingLocked} />
```

```tsx
// ChatComposer.tsx，定义处紧邻 modelEffortControls（`:2224-2231`）
const agentPicker = activeSessionId ? (
  <ComposerAgentPicker
    sessionId={activeSessionId}
    agents={hostStatus.capabilities?.agents}
    hostState={hostStatus.state}
    locked={agentBindingLocked}
    disabled={disabled}
  />
) : null;
```

**闸门口径与 `modelEffortControls` 故意不同**：后者是 `disabled || busy || sending`（`:2229`），因为 model 改了下一回合还能生效；agent 不是——它由 `locked` 单独接管（§3.3），`disabled` 只保留「没地方放这个草稿」这层总闸。busy/sending **不额外传**：会话一旦 busy，`sendAttempted` latch 必然已置位，`locked` 已经为真，再叠一层是重复真源。

### 3.3 选择值写哪、锁定判据与锁定时机

**写入 = store 窄 action，零新字段**（改判 #7，采 B §3.3）：

1. `chatSessions.ts` 增加窄 action `setDraftSessionAgent(sessionId, agent)`，只更新目标 session 的 `agent` 与 `updatedAt`。**这是加法且不新增字段**——`ChatSession.agent?` 已存在（`chatSessions.ts:114`）。
2. **action 守卫分层（store 只看得到 store）**：`setDraftSessionAgent` 的 store 侧守卫口径 = **两项析取**（`hostBoundSessionIds.includes(id) || session.runtimeIdentity != null`），命中即返回原 state（引用相等）或显式失败；**`sendAttempted` 不在任何 store**（§3.2 实证：它是 `ChatWorkspace` 的本地 `useState`），因此必须由调用方作为显式入参交给 action —— 签名 `setDraftSessionAgent(sessionId, agent, { sendAttempted })`，三项在 action 内合取。不让组件直接 `setState`，否则锁定不变量没有单点断言。
   > **断言必须按臂分列**（A5a store 两元臂 / A5b 含 `sendAttempted` 的三元臂）：合成一条会让「删掉 `sendAttempted` 项」这个变异不红——R2 的咬合力就只剩 UI 的 `disabled` 一层。
3. 读**一律经 `sessionAgent(session)`**（`agentWire.ts:118-120`）。`chatSessions.ts:109-113` 明令："NEVER read this field directly … 写 `session.agent ?? '…'` 就是这套安排要防的第二默认值"。
   > 为什么写草稿不违反该注释：`:100-107` 禁的是**默认值在第二处物化**（`mergeSessionIndex` 是缺失值变成绑定的唯一点，live-only 未发送行必须原样穿过并保持 `undefined`）。用户的**显式选择**不是默认值；未发送 live-only session 本来就不进 index，写它不产生第二个物化点。这条边界必须有断言守（§3.6-A7）。
4. 新草稿默认值（**S1 口径 = 会话内草稿，不跨会话记忆**）：一律 `sessionAgent(session)`，未设置即 `sessionAgent(undefined) → claude-code`，**不写 inline legacy 默认**。
   > **为什么 `lastAgent` 不在 S1**：跨会话记忆要读写 app settings 的 `ChatAgentDefaults`（§4.3），而 app settings 是 zustand persist + 异步 IPC（`stores/settings/storage.ts` 的 `getItem/setItem` 均为 `await window.electronAPI.settings.read/write`），要动 `types.ts`/`defaults.ts`/`migration.ts` 三处落点并给 hydration 竞态口径——与 S1「依赖=无、零协议、纯渲染端」直接冲突。整体推迟到 S2（口径与断言见 §4.3 与 B15）。
5. 用户主动切换：未锁定时只写草稿 `session.agent`，**不得写 session-index**；S2 落地 `ChatAgentDefaults` 后在同一处追加写 `lastAgent`（§4.3）。
6. **回退必须回写（显示值 == 发送值）**：`resolveSelectedAgent` 解析出 `fellBack:true` 且会话**未锁定**时，picker 一次性提示后**立即经 `setDraftSessionAgent` 把回退值提交回 store**，使 `sessionAgent(session)`、picker 选中项、`chat.createSession` payload 三者恒等（断言 A11）。只改视图不回写 = picker 显示 Claude Code 而 payload 仍是 `codex`，与 §4.3-1「picker 与 model 同一个值、单一真源」自相矛盾。**已锁定会话不回退也不回写**——已绑定 agent 是事实，即便当前 Host 不支持也照原样显示（§3.4 矩阵末两行）。
7. **发送守卫（空列表不静默放行）**：当 `agents !== undefined && !agents.includes(resolvedAgent)` 时，`runSend` 在 `onSendStart()` **之前**拒绝并给 inline 提示（`agents=[]` 与「回写失败/锁定会话绑定到不可用 agent」同臂），避免下一次 create 撞 `agent_unsupported`；`agents === undefined`（old Host）**不触发**该守卫。断言 A12。

**锁定判据 = 三元组合取（仲裁 §2.2：两轨各答半边）**：

```
locked = sendAttempted || hostBound || runtimeIdentity != null
```

- 后两项 = `computeEverHostBound(session, hostBoundSessionIds)`（`useComposerTarget.ts:83-91`）。**S1 的第一个动作是把它提取成共享纯模块**（建议 `src/renderer/components/chat/sessionBinding.ts`），`useComposerTarget.ts` 改 import。**S1 的全部消费者 = `useComposerTarget.ts` + `ChatWorkspace.tsx`（算 `agentBindingLocked`）+ picker 视图模型**，三处 import 同一符号（A2 扫描口径同此三处）；S3 若将来恢复 per-session 权限控件（§8.0-Q1）须同 import。
  > **这是本片唯一的重构动作，且必须发生。** 今天已有两处镜像：`isLiveOnlySession`（`useSessionIndex.ts:205-219`，注释自陈 "Same criterion as `computeEverHostBound`"）与 `MiddleColumnModeInput`（`middleColumnLayout.ts:25-30`，注释 "mirrors `computeEverHostBound`"）。再写第四份的后果不是 UI 不一致，而是**一个从 session-index 恢复的 Codex 会话被判为「未物化」、用户改成 Claude、下一条消息拿着 Codex 的 threadId 走 Claude 运行时的 resume 分支**（`useComposerTarget.ts:76-81` 已记录过同形状事故）。
  > 新模块须过 `pureModuleImports.test.ts` 的纯度扫描（禁 `from 'react'`/`from '@/stores'` 值导入，`:33-37`），并**加进 `TARGET_FILES`（`:38-45`）**，否则明天有人往里加个 store import 没人拦。
- 第一项 = 既有 sticky latch：`ChatComposer.runSend()` 在**所有 guard 通过、首个 await 之前**调用 `onSendStart?.()`（`ChatComposer.tsx:907`），`ChatWorkspace.tsx:162` 的 `onSendStart={markSendAttempt}` 是写入点，中列已用它决定 session mode。**这保证用户按下 Send 后不会在 create IPC 飞行期间再改 agent**（B 稿吸收项，A 稿缺的半边）。
- 三元组合取后，判据函数下沉为 `isChatAgentBindingLocked()`，与 `middleColumnLayout` 的输入形状同源（N5）。

**create payload 的读取点不变**：首个 create 继续从同一 pre-IPC store snapshot 读 agent（`ChatComposer.tsx:872-880`），并在 `createSession` payload 明确发送（`:1253-1260`）；store 的 `sendMessage` 物化点（`chatSessions.ts:1030-1037`）读同一 `sessionAgent()`。**两条发送路径各要一例断言**（§3.6-A3，发射半边 pin）。Host 的 `session.created/resumed` 回填是持久化确认，**不是第二次选择**。

### 3.4 态矩阵与降级（定稿二态：显示而非隐藏）

**两个纯函数，同属 `composerAgentPickerModel.ts`，调用序 = 先解析后派生**：

```ts
// ① 先解析：草稿值 × 当前 capabilities → 实际选中项（含回退标记）
resolveSelectedAgent(input: {
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  draftAgent: AgentWireName | undefined;   // = session.agent（未设置为 undefined）
  locked: boolean;
}): { agent: AgentWireName; fellBack: boolean };
// ② 再派生：选中项 × 可用集 → 每项的展示状态
deriveComposerAgentOptions(input: {
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  selectedAgent: AgentWireName;            // = ① 的输出
  locked: boolean;
  hostState: HostStatus['state'];
}): Array<{ agent: AgentWireName; selected: boolean; available: boolean; disabled: boolean; reason?: string }>;
```

`fellBack:true` 的**回写责任在调用方**（§3.3-6），不在纯函数内。

| 输入状态 | Claude | Codex | UI 口径 |
|---|---|---|---|
| `agents=['claude-code','codex']`，未锁 | 可选 | 可选 | 正常 segmented picker |
| `agents=['claude-code']`，未锁 | 可选 | **disabled + tooltip** | `Unavailable in the current Host`——**不得声称是 flag-off**（N2：capabilities 不带原因） |
| `agents===undefined`（old Host） | 可选 | disabled | `This Host predates agent capabilities; Claude Code is the compatibility fallback` |
| `agents=[]`（Host ready 但全被过滤） | disabled | disabled | 保留两项 + inline 空态 `No chat agent is available` + Restart/Retry Host 动作；**不静默回退发送**、不谎称能跑 claude（否则下一次 create 撞 `agent_unsupported`） |
| Host 非 ready / `capabilities` 整个 undefined | 当前选择只读占位 | disabled | 等 Host ready，不提前宣称可用 |
| 已锁定（**session 模式的常态**） | 单段静态 chip = `sessionAgent(session)` | 不渲染第二段 | **不渲染「两段全置灰」**（永久占宽的死控件，§3.2）；tooltip `Agent is fixed after the first send`；不显示可点击假控件 |
| 已锁定 **且** 绑定 agent 已不在 `agents` 中 | 仍显示绑定 agent（事实） | — | **不回退、不回写**；chip 加 tooltip「该会话绑定的 agent 在当前 Host 不可用」；发送经 §3.3-7 守卫拒绝 |
| **未锁定**草稿 agent 从 `agents` 中消失（flag 中途关掉后重启） | — | — | 回退到 `LEGACY_AGENT` 且**不静默**：`resolveSelectedAgent` 返回 `fellBack:true`，picker 一次性提示 **且立即经 `setDraftSessionAgent` 回写 store**（§3.3-6），保证显示值 == `sessionAgent(session)` == create payload（A11）。若 `LEGACY_AGENT` 本身也不在 `agents` 中（如 `agents=[]`）则不回写，改由发送守卫拦截（A12） |

**改判说明（#3）**：A 稿「`agents.length < 2` 时整个 picker 不挂载」被仲裁 §1 推翻。`composerModel.ts:91-101` 的「a control for a capability we do not have is a lie about the product」针对的是**我们根本没有的能力**；agent 二选一是我们有的能力，只是当前 Host 缺凭据/未开 flag，属于「有但当前不可用」——`runtimeEvents.ts:104-108` 的类型注释本就写 **disable 而非 hide**。
→ **连带影响（施工必须知道）**：flag-off 轮的视觉基线**不再等于今天**。off 轮断言从 A 稿的「零视觉变化」改为「picker 渲染两项且 codex `disabled:true` 且带 reason 文案」。
→ **发布形态（已知并接受，非缺陷）**：`AICLIENT_AGENT_CODEX` 默认 off 时，全体用户会在**新建会话（empty 模式）**的底栏看到一个恒置灰的 Codex 段——这是仲裁 §1「disable 而非 hide」的直接后果，且 §1.1-4 禁止 renderer 按 flag 分叉，因此 **S1 没有独立 UI 回退杆**；唯一回退手段是整片不合入。已建立会话不受影响（锁定态只有单段 chip）。R16 按此口径记，不是「评审误判」而是发布事实。

`hostStatus.ts:42-52` 的 `filterAgentWireNames` 已统一过滤未知 slug 并区分 `undefined` 与 `[]`，**picker 不再二次解析未知字符串**，视图模型入参类型是 `readonly AgentWireName[] | undefined` 而非 `string[]`。

**三态琥珀点：定稿不做**（仲裁 §2.2）。要三态必须把 `HostAgentDetail`（含 `reason` 四值，`agentSupport.ts:116-131/227-237`）扩上 wire，即把 Host 内部诊断变成对外契约 → 进 §8 遗留登记，等真实需求。

### 3.5 S1 Happy Path

1. **主路径**：flag-on 冷启动 → Host ready 带 `agents:['claude-code','codex']` → 新建草稿会话（未物化）→ 底栏出现两段 pill，选中 `Claude Code` → 点 `Codex` → `setDraftSessionAgent` 写 `session.agent='codex'`（**S1 不写 `lastAgent`**，见 §3.3-4）→ 发首条消息 → `onSendStart()` 同步锁定 → `chat.createSession` payload `agent:'codex'` → Host `session.created` 回填 → 侧栏 chip 与 picker 一致 → 重启 app → 会话从 index 恢复（`runtimeIdentity` 在）→ **底栏只剩单段静态 Codex chip（锁定态）**。
2. old Host：Claude selected、Codex disabled 带兼容文案 → 首发成功 → picker 同帧锁定。
3. flag-off/凭据缺失：capabilities 只有 Claude → Codex 可见但禁点、有 generic 原因 → Claude 首发。
4. 未发送前来回切 Claude↔Codex：允许，且 session-index 仍无新行。
5. Send guard 拒绝（无 cwd / in-flight / disabled）→ `onSendStart` 调用 0 次 → picker 不锁。
6. 首发 create 失败：因 send 已 commit，picker **保持锁定**；Retry 沿用原 agent，不生成跨 runtime 重试。
7. **回退回写**：草稿 agent = `codex`，重启后 flag 关掉（`agents=['claude-code']`）→ `resolveSelectedAgent` 返回 `{agent:'claude-code', fellBack:true}` → 一次性提示 + 回写 store → picker 显示 Claude Code，`sessionAgent(session)` 与 create payload 同为 `claude-code`。
8. **空列表**：`agents=[]` → 两项均 disabled + inline 空态 → 用户按 Send → §3.3-7 守卫在 `onSendStart()` 前拒绝（`onSendStart` 调用 0 次、无 create IPC），提示 Restart/Retry Host。

### 3.6 S1 确定性断言点

| # | 断言 | 形状 |
|---|---|---|
| A1 | `deriveComposerAgentOptions` 五类输入真值表（双可用 / 仅 Claude / old Host `undefined` / `[]` / Host 非 ready）逐项 `available`·`disabled`·`reason` 钉死；**`undefined` 与 `[]` 不等价** | 纯函数真值表（node-env 直跑） |
| A2 | 锁定判据三元组：`{sendAttempted:false, hostBound:false, runtimeIdentity:'x'}` → `true`；`{sendAttempted:true, 其余 false}` → `true`；全 false → `false`。且**三个消费者**（`useComposerTarget.ts` / `ChatWorkspace.tsx` / picker 视图模型）**import 同一个符号** | 真值表 + 静态扫描（`sessionBinding.ts` 在三处 import 行各出现一次；`ChatWorkspace.tsx` 不得自算三元组） |
| A3 | 首条消息发出时 `chat.createSession` 的 `agent` 参数 === 提交点 snapshot；**两条发送路径**（`chatSessions.sendMessage` / `ChatComposer.runSend`）各一例；发送过程中后续 store 变化不改写该 payload | spy on `window.electronAPI.chat.createSession`，断参数对象 |
| A4 | 草稿指向已消失的 agent → 解析结果 = `LEGACY_AGENT` **且** `fellBack:true`（不是静默） | 纯函数判别式 |
| A5a | **store 两元臂**：`setDraftSessionAgent` 对 `hostBound` 或 `runtimeIdentity != null` 的 session 返回原 state（引用相等）或显式失败 | store action 单测 |
| A5b | **`sendAttempted` 臂（单列）**：入参 `{sendAttempted:true}` 而 store 两项均 false 时，action **同样拒绝**；视图模型 `locked:true` 时输出单段静态 chip（非「两段 disabled」）且选中项 = `sessionAgent(session)` | store action 单测 + 视图模型真值表 |
| A6 | Send guard 未通过时 `onSendStart` 调用 0 次；通过时**恰好 1 次且早于首个 IPC** | 调用序断言（spy 顺序） |
| A7 | 未发送切换不创建 index 行（`mergeSessionIndex` 仍是唯一物化点）；首发后 index binding 与 Host 回声一致 | store + index 集成断言 |
| A8 | `composerAgentPickerModel.ts` 与 `sessionBinding.ts` 过 `pureModuleImports` 扫描（已加入 `TARGET_FILES`）；`agentWireStatic.test.ts` 继续钉 `AgentWireName`↔`BuiltinAgentId` 无互转、无 inline legacy default | 静态扫描 |
| A9 | 组件类名静态断言：无 `border*`/`shadow*`/`min-w-*`/`rounded-md+`，且高度类与 `composerModelTriggerClass()` 一致；`hover:` 与 `focus-visible:` 成对 | 类名字符串扫描（范式 `composerFormStatic.test.ts`） |
| A10a | **empty 模式**组装顺序 = `[attach, agentPicker, modelEffort, status, actions]`（picker 紧邻 model 左侧） | 结构静态断言 |
| A10b | **session 模式**组装顺序 = `[attach, textarea, status, agentPicker, modelEffort, actions]`（picker 与 model **相邻**，A9 的高度/内距交叉断言依赖这个相邻性） | 结构静态断言 |
| A11 | **回退回写（显示值 == 发送值）**：草稿 `codex` + `agents=['claude-code']` + 未锁定 → 回写后 `sessionAgent(session) === 'claude-code'`，picker 选中项与 `chat.createSession` payload 的 `agent` **三者相等** | store + spy 集成断言 |
| A12 | **空列表不放行**：`agents=[]` 时按 Send → `onSendStart` 调用 0 次、`chat.createSession` 调用 0 次；`agents===undefined`（old Host）时**不触发**该守卫、正常发送 | 调用计数双臂 |

### 3.7 S1 变异对（逐对实跑记红灯）

① `computeEverHostBound` 删掉 `|| runtimeIdentity != null` 析取项 → **A2 红**
② 删掉 `sendAttempted` 项（只按 hostBound/runtimeIdentity 判锁）→ 模拟 create IPC 未返回时切 agent → **A2/A6 红**（B 稿标 blocker 的那条）
③ old Host `undefined` 当成 `[]` 处理 → **A1 红**
④ **未锁定态**把不可用项改为隐藏 → **A1/A9 结构断言红**（锁定态的单段 chip 不在本变异射程内，它是设计口径而非隐藏不可用项）
⑤ 视图模型的 `resolveSelectedAgent`（草稿 agent 不在 `agents` 中时的回退分支）不置 `fellBack` → **A4 红**
⑥ 两条发送路径之一改回忽略草稿（直读 index 值）→ **A3 对应一例红**（发射半边 pin：只钉一条会让另一条的漂移无人看守）
⑦ picker action 允许修改已 indexed / 有 runtimeIdentity 的 session → **A5a 红**
⑦b action 忽略 `sendAttempted` 入参（latch 已置位仍允许改草稿）→ **A5b 红**（R2 在 store 层的咬合力；不单列这一对会让防线只剩 UI 的 `disabled`）
⑧ 默认值写成 `'claude'` 字面量或从 `BuiltinAgentId` 转换 → **A8 红**
⑨ 把 picker 放到 `modelEffortControls` 之后 → **A10a/A10b 红**
⑩ `fellBack` 只改视图不回写 store（picker 显 Claude、payload 仍 `codex`）→ **A11 红**
⑪ `agents=[]` 仍放行发送 → **A12 红**

### 3.8 as-built（施工后记，2026-08-16 S1 规格符合性终检后补）

> 本节只记 **§3 定稿口径与实际落地的差异**，以及差异的理由与交叉证据。断言编号沿用 §3.6，变异编号沿用 §3.7。
> 触发来源 = S1 规格符合性终检 9 条发现（B1 / M2 / M3 / M4 / m6 / m7 / m8 / m9 / m10，M5 lint 由编排者另修）。

**① 偏差（形制）：`ComposerAgentPicker.tsx` 保留手写 segmented control，不用 `ToggleGroup`/`Toggle`。**

§3.1 写的是「底座 = 仓内已有的 `ToggleGroup`/`Toggle`……**禁止手写 segmented control**（CLAUDE.md 组件优先条）」。实际实现是手写的两段 `<button role="radio">` + `role="radiogroup"` 容器。理由是**这两条规则在本控件上互斥，且 §3.1 自己的另一半（ghost chip 四禁）有断言背书、组件优先条没有**：

- 冲突串（实测 `src/renderer/components/ui/toggle.tsx:8-24`，`toggleVariants` 是每个 `ToggleGroupItem` 的渲染底座）：base 串含 `rounded-lg`、`border`、`before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)]`（内高光 = §3.1 明文点名的 `shadow*` 一类）；`size` 三档最小的 `sm` = `h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7`。
- 对照 §3.1 的四条硬性禁止（任何 `border*` / 任何 `shadow*`（含 `before:` 内高光）/ 任何 `min-w-*` / `rounded-md` 及以上）：**四条全撞**；外加高度档不符（要 `h-6`，最小档给 `h-8`）与一个 `sm:h-7` 断点前缀高度——后者正是 A9 里「`Button` 的 `sm:size-7` 泄漏」那条既有教训的同形状（裸 `h-6` 只置换无前缀那半，断点前缀那半在所有真实窗宽下继续赢）。
- **交叉证据 = A9 会红**：`composerAgentPickerModel.test.ts` 的 A9 组把四禁写成正则 `[/\bborder/, /\bshadow/, /\bmin-w-/, /\brounded-(md|lg|xl|2xl|3xl|full)\b/]` 逐个类名串跑，并单列一条 `sm:h-` 断点高度残留断言。走 `ToggleGroup` 要把 base 串整个覆盖掉才能过 A9——那是「引入一个组件，只为了把它的类名全部剥掉」，剩下的只有 `role=radiogroup` 语义，而候选集是闭合两元（`AGENT_WIRE_NAMES`），没有列表逻辑可继承。
- 组件头部已就地记同一取舍（英文注释，引 `toggleVariants` 冲突串）；**若将来 `toggleVariants` 出现 ghost/`unstyled` 变体，本条偏差应回退到组件优先**。

**② 语义修正（M3）：锁定分支不再把「Host 未 ready」说成「Host 不支持该 agent」。**

原实现 `deriveComposerAgentOptions` 锁定分支的 `boundAvailable = available(selectedAgent)` 把 `hostState !== 'ready'` 折进了 `BOUND_AGENT_UNAVAILABLE_REASON`（"This session is bound to an agent the current Host cannot run"）。后果：**冷启动期间每一个已建会话的 chip 都挂这句文案**——而 §3.2 实测「session 模式下 picker 几乎恒为锁定态」，即这是全量已建会话的常态路径，不是边缘态。现口径：`hostState !== 'ready'` 时锁定 chip 只出 `AGENT_LOCKED_REASON`，不宣称任何不可用；`available` 字段仍如实为 `false`（Host 没给答案 ≠ 给了否定答案）。断言补 `locked × hostState` 四态真值表（`stopped`/`starting`/`error`/`ready` × 绑定项在列表/不在列表）+ 一条「冷启动 `capabilities===undefined` 也不出不可用文案」。

**③ 语义修正（M4）：`resolveSelectedAgent` 增加 `hostState` 入参，Host 未 ready 时不回退。**

§3.4 声明的签名只有 `{capabilitiesAgents, draftAgent, locked}`。按该签名实现会踩：冷启动 `capabilities` 整个 `undefined` → `effectiveAgents(undefined)` 读成「老 Host 只能跑 legacy」→ **codex 草稿在 picker 上显示 Claude Code，而 `sessionAgent(session)` 与 create payload 仍是 `codex`**——正是 §3.3-6 / A11 要禁的「显示值 ≠ 发送值」，只是从另一头到达（`shouldCommitAgentFallback` 的 `hostState` 闸门只拦住了回写，拦不住显示）。现签名加 `hostState`，`!== 'ready'` 时原样返回草稿值、`fellBack:false`，与 §3.4 矩阵「Host 非 ready → **当前选择只读占位**」那行字面一致。断言补 `draft codex + hostState 'starting'/'stopped'/'error'` ⇒ `selectedAgent==='codex'` 三态，及一条 `deriveComposerAgentPicker` 端到端冷启动用例。

**④ 断言手法（m6）：A3 的 composer 臂 / A6 / A12 以源扫描替代 spy。**

`vitest.config.ts` 实测 `test: { environment: 'node', include: ['src/**/__tests__/**/*.test.ts', …] }`——**node 环境 + 只收 `.test.ts`**，`.tsx` 在整个套件里从不渲染，`ChatComposer.runSend` 也就无法被调用。§3.6 给 A3/A6/A12 标的「spy on `window.electronAPI.chat.createSession`」「调用序断言（spy 顺序）」因此只在 store 侧那条路径（`chatSessions.sendMessage`，纯 `.ts`）成立，已如实用 spy 实现；**composer 侧那条路径改为对 `ChatComposer.tsx` 的源扫描**（`composerAgentPickerWiring.test.ts`，范式沿用同目录既有的 `composerStopStatic.test.ts` / `messageTimelineWiring.test.ts`，注释均经 `stripComments` 解析器致盲）。A3 的「发射半边 pin」由此保留：两条发送路径各一例，只是取证手段不同轴。**残余盲区已知并接受**：源扫描不证可达性（`if (false)` 内的守卫同样能过），这正是把全部判断下沉到 `composerAgentPickerModel.ts` 纯函数真值表的原因。

**⑤ 偏差（接线，m9）：picker 新增 `sendAttempted` prop，`deriveComposerAgentPicker` 新增 `lockedUpstream` 入参。**

§3.2 的组装示例只给 picker 传 `locked={agentBindingLocked}`。首版实现据此把**折叠后的** `locked` 塞进了两个 `sendAttempted` 槽（视图模型 `binding.sendAttempted` 与 store action 的 `{ sendAttempted }` 选项）。行为上今天等价（多出的两臂只会让守卫更严），但**契约上是错的**：`setDraftSessionAgent` 的第三参数按 §3.3-2 是「store 看不见、必须由调用方显式交出」的那一个事实，喂给它一个三项析取会让守卫**靠巧合成立**，并让 A5b 那条臂在其唯一调用点上无人看守。现口径：`ChatWorkspace` 把原始 latch 与折叠值**并排下传**（`agentSendAttempted` / `agentBindingLocked`，经 `ChatComposer` 同名 prop 透传），picker 用原始 latch 填两个 `sendAttempted` 槽，上游折叠值走 `lockedUpstream` 独立入参并与本地折叠取**析取**（两折叠若失配只能倒向「锁定」，fail closed）。A2 的「`ChatWorkspace` 不得自拼析取」不受影响（仍是 `isChatAgentBindingLocked(...)` 单点）。

**⑥ 断言范围（m8）：A2 的消费者扫描是 4 处，不是 §3.3-2 的 3 处。**

§3.3 列的 S1 消费者是 `useComposerTarget.ts` + `ChatWorkspace.tsx` + picker 视图模型。实际第 4 个消费者是 **`stores/chatSessions.ts`**：`setDraftSessionAgent` 的 store 侧写守卫与 picker 的 UI 闸是同一条规则，而 store 看不到组件 props，只能自己再折一次。它是最容易长出「第四份手写析取」的地方（两臂就在自己 state 里，`hostBoundSessionIds.includes(id) || session.runtimeIdentity != null` 是一行的诱惑，而漏掉的恰是覆盖整个 create-IPC 飞行期的 `sendAttempted`）。扫描已补第 4 处，并对该 action 体加「不自拼析取」的负断言。注：store 侧 import 说明符是 `@/components/chat/sessionBinding`，扫描正则同时认 `./` 与 `@/components/chat/` 两种拼法。

**⑦ 改动面（m7）**：§3.1 的既有文件清单漏列 7 个实际动到的文件（3 新测试 + 4 fixture 存根），已在 §3.1 就地补记。另有 1 个**连带勘误**不计入 S1 改动面：`src/main/services/auth/__tests__/adoptionStaticImportBans.test.ts` 的「禁任何 `fs` import」与 `adoption.ts` 模块头自陈的契约（只用只读 `existsSync`/`readFileSync`）自相矛盾，本轮改为「具名只读 import 放行、默认/命名空间 import 与全部写 API 仍禁」。

**⑧ 注释勘误（m10）**：`chatSessions.ts` 的 `setDraftSessionAgent` 原注释承诺返回值「能区分 refused 与 already-that-value」，而实现（`:1033-1035`）两者都返 `true`。**返回值形状不动**（红线 store 最小动原则），改注释为 "false only when refused"。若将来真需要区分，那是加法接口而不是改这条返回值。

**⑨ B1 补断言**：`composerAgentPickerWiring.test.ts` 对 `ComposerAgentPicker.tsx` 原本只有一条 `toContain('ComposerAgentPicker')` 空壳断言（即：删光组件实现也不会红）。已按同文件对另两个 `.tsx` 的既有手法补齐——回退 effect 体内含 `setDraftSessionAgent(sessionId, selectedAgent, { sendAttempted })`、onClick 体内含同一 action 且 inert/已选早退在前、三个 `<button>` 开标签均无 `disabled` 属性而锁定 chip 与 segment 均带 `aria-disabled` + `title`、`onRetryHost` 嵌在 `emptyStateNotice` 条件块之内、锁定分支早退于任何可交互 segment。**变异 ⑩ 已按 §3.7 复跑取证**（字节级删除回退 effect 里的回写调用 → scoped vitest 两红：A11「the fallback effect writes the resolved agent back to the store」+ m9「both writes are handed the RAW latch」；字节还原后 19/19 复绿）——补断言前该变异**存活**。

**⑩ 悬挂引用清理**：文档头 rev.3 记的「§3.3 有一处括注『S3 若将来恢复 per-session 权限控件（§8.0-Q1）须同 import』」——rev.3 口径下该分支不会发生（S4 的权限控件不消费锁定判据，见 §6.3 与 D13），**该括注作废**；§3.3 正文保持冻结原样，以本条为准。

---

## §4 S2 — 模型目录代理化 + D40 Codex 半边

### 4.1 通道设计：谁查、何时查、缓存哪、失败回退

**新增 `src/main/services/agentCatalog/AgentCatalogService.ts`（Main，纯模块 + 懒工厂）** ·  `src/main/ipc/agentCatalog.ts` · `src/shared/types/ipc.ts` 增 `CHAT_LIST_AGENT_MODELS: 'chat:listAgentModels'`（`ipc.ts:347` USAGE 同级，照 `usage:getStats` 的 `域:动作` 惯例）· `src/preload/index.ts` 暴露 `chat.listAgentModels({agent, force?})` · renderer `useAgentModelCatalog(agent)`（**不得进 `chatSessions.ts`**）。

| 问题 | 裁定 | 依据 |
|---|---|---|
| **谁查** | **Main**，`net.fetch` 直打 cch `/v1/models`；renderer/preload/Host event 一律不携带凭据 | 凭据只在 Main（`CredentialVault.ts:52-56`）；agent-host 只有一个 codex key 无 baseUrl（`hostEnv.ts:64-71`）。范式 = `UsageService.ts:102-131` |
| **何时查** | **惰性 + 单飞**：Composer 首次拿到 `hostStatus.state==='ready'` 且有 active session 时查当前 agent；零回合切 agent 立即查新 agent；同 key 并发去重。**不在启动时预热** | 启动期打网络会把「登录态未就绪」变成「目录空」的竞态；`UsageService` 也是按需 |
| **缓存哪** | **Main 进程内内存**，key = `agent + 规范化 baseHost + 凭据摘要`（**凭据摘要 = 已解析出的 key/token 的非可逆摘要，如 sha256 前 8 字节 hex**）；**TTL 10 分钟**；失败保留最近成功值到本进程结束。**不引入 vault generation 计数器/失效通道**——vault 今天既无 generation 也无变更事件（实测 `CredentialVault.ts:52-56` 只有 `claude:{baseUrl,authToken}` / `codex:{baseUrl,apiKey}`，全文件零 `emit`/`subscribe`），范式 `UsageService` 也是每次调用重解析；凭据一变摘要即变、key 自然失配，**无需 login/logout/adoption 三个写点各挂一次 invalidate**（那属 D47 面的改动，不在 S2 改动面）。摘要**只存在于 Main 进程内存的 cache key 里，不进日志、不进 renderer payload**（B4 secret scan 覆盖）。**本阶段不落磁盘** | 仲裁 §2.2 回退链写死「进程内 stale cache」；B U2：无来源/年龄 UI 前不把昨日目录冒充当前真源（改判 #8） |
| **刷新** | 打开模型菜单时 cache 超 10 分钟则后台 refresh，菜单先显 stale 值并标 `Refreshing…`；`force=true` 只由 Retry/Refresh 触发 | B §4.2 |
| **失败回退** | **四级**：fresh → 进程内 stale cache → **内置种子表（`source:'seed'`，UI 明示「目录不可达」）** → `Automatic`（省略 model）+ Retry | 仲裁 §2.2（拍板 #5 的三级回落 ∧ B「不得伪装可用目录」）|
| **凭据不可用** | 直接返回种子表 + `source:'seed'` + `error:'credentials-unavailable'`，**不报错、不卡住、`net.fetch` 零调用** | vault `locked`（safeStorage 未解锁，D47 S1 §2.1 窗前死锁 E6）时目录服务必须窄口直落，否则 model 选择器整个瘫掉 |

**返回形状（判别式带来源，不是裸数组）**：

```ts
type AgentModelCatalog = {
  agent: AgentWireName;
  models: Array<{ id: string; label: string }>;   // 已过家族白名单过滤（§4.2）
  source: 'proxy' | 'stale-cache' | 'seed';
  stale: boolean;
  fetchedAt: number | null;
  error?: 'host-not-ready' | 'credentials-unavailable' | 'http' | 'invalid-response';
};
```

> `source` 不是诊断糖：§4.4 的短名口径与 §4.8 的断言都要读它。一个「目录回来了」的 boolean 分不清「代理说只有这些」和「网断了用的种子表」——前者该信，后者**必须在 UI 上标明目录不可达**，不得伪装成可用目录。

**双轴查询规则**：

| agent | URL | Auth | 响应解析 |
|---|---|---|---|
| `claude-code` | 规范化 base URL + `/v1/models` | `x-api-key` | Anthropic list，取非空字符串 id |
| `codex` | 规范化 base URL + `/v1/models` | `Authorization: Bearer` | OpenAI list，取 `data[].id` |

> **vault 字段名 → header 名的映射（必须照抄，别照字段名猜）**：Claude 轴取 vault 的 **`claude.authToken`** 值填入 **`x-api-key`** 头——`authToken` 是 D47 的历史命名（对应 `ANTHROPIC_AUTH_TOKEN` 生态），**不代表 Bearer 语义**；`x-api-key` 的口径来自调查 04 当日实测（`04-cch-live-probe.md:15`「claude 轴（x-api-key，Anthropic list 形状）」）。Codex 轴取 `codex.apiKey` 填 `Authorization: Bearer`（04 `:9`）。B4 断言直接钉这条**字段名 → header 名**的映射，变异 ③ 也钉在这条映射上。

base URL 与 key **只**从 D47 托管凭据/已收编配置的 Main authority 取；请求用短超时 + `AbortSignal`；只接受预期 JSON 结构，去重并过滤空 id；**日志只记 agent、host、状态码、条数、耗时，不记 header、完整响应体或 URL userinfo**。

### 4.2 家族规则白名单过滤层（拍板 #5 强制执行）

**落点 = Main 目录服务的响应过滤层**（仲裁 §3）——renderer 收到的**已经是过滤后的目录**，两稿的「全量目录」数据形状按此收窄。

- **规则硬编码，型号动态推导**：
  - Claude 轴：`haiku`/`sonnet`/`opus` 三族各取最新版；**同版本优先无日期别名**。
  - Codex 轴：最高世代（现 5.6）的全部变体，**排除 `gpt-image-*` / `codex-auto-review` / `-mini`**。
  - **全新家族名（如未来的 fable）默认不上架**——族内更新与世代更迭零代码改动，只有新家族需人工加一行规则。
- **内置种子表 = 过滤后六条**（`src/shared/models/seedCatalog.ts`）：`claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`。头注写明**出处 = 调查 04 实测 + 采集日期**，并注明「这是回退底座不是真源，代理实况以 proxy 为准」。
- 过滤规则本身是纯模块 **`src/shared/models/familyWhitelist.ts`**（与 `seedCatalog.ts` **同处 `src/shared/models/`**：过滤规则与种子表同侧才不会两处漂移（R10），且 shared 侧纯模块能被既有 `pureModuleImports.test.ts` 以相对路径自然覆盖——该测试的 `TARGET_FILES` 本就含跨目录条目 `../../workspace-shell/surfaces/contextSurfaceModel.ts`。**Main 服务只调用它**，「落点 = Main 响应过滤层」指的是**过滤发生在 Main 的响应路径上**，不是规则表必须写在 `src/main/` 下），**必须表驱动可测**：喂 04 实测原始列表（claude 15 / codex 10）→ 输出恰好六条；喂「新增一个族内更高版本」→ 自动上架；喂「新增一个未知家族」→ 不上架。断言点 §4.8-B9。
- 过滤在 Main 侧做的第二个理由：种子表与过滤规则同处一侧，`source:'seed'` 与 `source:'proxy'` 的输出形状恒同（都是过滤后六条量级），renderer 不需要知道过滤存在。
- **输出排序 = 本仓硬编码的确定序，不透传服务端顺序**（B U1 只禁「猜服务端排序有语义」，不禁我们自己定一个稳定序；不定序会让菜单顺序随代理返回顺序抖动）：Claude 轴 `opus → sonnet → haiku`，Codex 轴按变体名字典序（`gpt-5.6-luna` → `-sol` → `-terra`）；两轴各自内部稳定，跨轴不混排。**B9 同时断言顺序**（不只是集合）。改判 #10 的实现方否决条款所说的「确定性家族序首条」即指本条。

### 4.3 per-agent 目录/偏好切换与 `ComposerModelTrigger` 改造面

`ComposerModelTrigger.tsx` 当前自行读取静态目录、session storage 与 Host default（`:98-148`，目录来源是同步纯函数 `ensureModelOptions(hostDefaultModel)` at `:131`）。改造后组件只负责展示/选择，目录与选择解析下沉纯 model：

1. **props 增加** `agent`、`catalog`、`catalogState`、`selectedModel`、`selectedEffort`、`onModelChange`、`onEffortChange`、`onRetryCatalog`。`agent` 由 `ChatComposer` 传 `sessionAgent(session)` 的结果——**与 picker 同一个值，单一真源**。
2. **新增 `useAgentModelCatalog(agent)`**（`src/renderer/components/chat/useAgentModelCatalog.ts`）：调 IPC，按 agent 在 renderer 侧缓存，返回 `{catalog, state, retry}`。
3. `models.ts` 从「静态真源」改成「目录 normalization + Automatic/legacy 合成 + 合法性判定」；**`CHAT_MODELS` 三短名表删除**，`DEFAULT_CHAT_MODEL_ID` 退役，`ensureModelOptions()` 的「未知 Host default 前插即合法」语义**不得保留**；`resolveResumeModel`（`models.ts:58-64`）保留但改吃解析结果。
   → **`hostDefaultModel` prop 的处置（不得留白）**：`ComposerModelTrigger` 今天用 `hostDefaultModel = hostStatus.settings?.model`（`ChatComposer.tsx:2227`）做两件事——初值 `defaultModelId(hostDefaultModel)`（`:110`、`:122-123`）与 `ensureModelOptions(hostDefaultModel)` 前插（`:131`）。本片把这两件事都拿掉（新会话默认 = `Automatic`；「未知 Host default 前插即合法」语义作废），**prop 保留但降级**：只作为「catalog 缺失且 session 无既有选择时的 unverified 既有值来源之一」（形状同 §4.4-6 的 unverified 前插行，`verified:false`，不扩为可选目录）；`ChatComposer.tsx:2227` 的传参保留不动，`ComposerModelTrigger` 内部语义改写。**不得默默留着旧语义**。
   → **静态扫描断言**：`src/renderer/components/chat` 下不得再出现 `CHAT_MODELS` 标识符（范式 `composerFormStatic.test.ts:53-58` 的「资产删除靠文件系统扫描」）。
4. **`composerModelMenuModel` 的「未知选择前插为独立行、不把勾移到 options[0]」逻辑保留**（`composerModel.ts:103-171`，`:110-127` 长注释）。目录变小（白名单六条）后这条**更重要**：存量短名与 legacy 选择就是靠它不丢。
5. 菜单仍是 Model + Reasoning effort 两个 `MenuRadioGroup`；catalog 的 loading/error/stale/seed 是**非 RadioGroup 的 status row**（含 Retry）。目录量级 ≤ 六条，**不引入搜索/虚拟化**。
6. **加载态显示上一次的值**（不是 spinner、不是空）。`ComposerModelTrigger` 的 model 状态本就是 `useState` 自持（`:107-114`），既有的「session 切换 / Host 默认迟到」reconciliation effect（`:118-125`）是**形状先例，不是零改动**——它的另一半输入正是 `hostDefaultModel`，该语义已被上条降级，因此这个 effect **必须重写为「按 catalog 到达/切轴 reconcile」**：`sessionId` 或 `agent` 变 → 读该 (session, agent) 的既有选择；catalog 迟到 → 只在当前选择既不在 catalog 也不是 legacy/unverified 既有值时才改写。**行为口径 = 加载态保持显示上一次的值，不闪 spinner、不闪空**，对应断言见 §4.8-B17。
7. **effort 不做 per-agent 词表分岔**：调查 04 实证双轴同为五档 `low/medium/high/xhigh/max`，与 `efforts.ts:24-30` 逐值一致，`CHAT_EFFORTS` 继续做双轴共用词表 + `Default`。`model/list` 的 per-model `supportedReasoningEfforts` **本片不读**（读了要么做 per-model 过滤——`composerModel.ts:86-89` 明确不做且理由仍成立，要么读了不用）。

**两层偏好（B §4.3 吸收，避免 per-agent 与 per-session 互相覆盖）**：

```ts
type ChatAgentDefaults = {
  lastAgent?: AgentWireName;
  byAgent?: Partial<Record<AgentWireName, {
    model?: string;            // absent = Automatic
    effort?: EffortSelection;
    permission?: ChatAgentPermissionPreference;   // §5.5
  }>>;
};
```

- **per-session** 选择仍留在现有 storage（`useSessionModel.ts:12` key `aiclient:chat:session-models`、`sessionEffortStore.ts`），以保证两个 Claude 会话可选不同模型；storage 升级为可测试的纯 module，**schema 必须按 (session, agent) 二元组记**：`Partial<Record<AgentWireName, { model?: string; effort?: EffortSelection }>>`（每个 sessionId 一条）。**不能是单条 `{agent, model}`**——那只记得住最后一次，草稿会话 Claude→Codex→Claude 来回切时第一次的 Claude 选择必然丢失并悄悄回落到 `byAgent` 默认，而 B12 的现有口径（「不存在跨 agent selection」）两种实现都能过。B12 因此加一例「切走再切回，原选择仍在」。
- **per-agent 默认**（`ChatAgentDefaults`）负责「新草稿切到该 agent 时恢复什么」，存 app settings 独立区（与 §5.5 同区），**不复用终端轴 `AgentSettings`**。
- 优先级：该 session 对**该 agent** 的临时选择（上条的二元组 storage）→ `byAgent[agent]` → `Automatic + Default effort`。
- 用户改 model/effort：写当前 session storage，**同时**更新该 agent 默认偏好。
- 已锁定会话：agent 不变，但 model/effort 仍允许 idle 时改、下一回合生效；busy/sending 沿用现 gate（`ChatComposer.tsx:2220-2231`）。
- **模型必须属于当前 agent 的 catalog，或是该 session 的 legacy/unverified 既有值**（口径见 §4.4-6）；不能把 Claude id 带到 Codex。**校验落点 = Main 的 dispatch 前**，与 §5.5 的 preference `agent` 校验（C10）同一位置同一形状：`model ∈ 该 agent 当前 catalog ∪ {该 session 的 legacy/unverified 既有值}`，错配在 dispatch 前失败。**不在 agent-host 侧做**——Host 子进程既没有目录也没有 baseUrl（`hostEnv.ts:64-71` 八键实证），在那里写「跨 agent id 拒绝」只能得到一个永远放行的假守卫。断言 B18 + 变异 ⑯。

**跨会话记忆 `lastAgent`（从 S1 移入本片，§3.3-4）**：

- `ChatAgentDefaults.lastAgent` 只影响**新草稿的初始 agent**，且**必须与当前 `capabilities.agents` 求交**：`lastAgent` 不在可用集（或 `agents===undefined` 的 old Host）→ 退到 `sessionAgent(undefined) → claude-code`。不求交的后果是：codex 关闭的 Host 上新草稿被绑到不可用 agent，首发直接撞 `agent_unsupported`。
- **hydration 口径（app settings 是异步 IPC persist）**：settings 未 hydrate 完成前**不读也不写** `lastAgent`，新草稿一律 `sessionAgent(undefined)`；hydrate 完成后才开始生效。**不得在未 hydrate 时把 `defaults.ts` 的空值当成用户选择写回**。
- 落点三处：`src/renderer/stores/settings/` 的 `types.ts` / `defaults.ts` / `migration.ts`（既有通道加字段，无 Host 协议改动）。
- 断言 B15（求交真值表 + hydration 双臂）+ 变异 ⑭。

### 4.4 短名 → 全名的兼容口径（不迁移、不猜测）

**现状**：`models.ts:17-23` 的三短名；存量 localStorage 值大概率是 `'sonnet'/'haiku'/'opus'`，无版本字段。调查 04 实测 **cch 不接受短名**（探测 B），现链路能跑靠 SDK/CLI 层翻译。

**裁定（仲裁 §1：不自动猜全名 + Legacy alias 合成项 + 不做静默映射迁移）**：

1. **不改写、不删除存量值**。读到 `sonnet|haiku|opus` 且 agent 为 Claude 时，合成 session-scoped legacy 选项：`{id:'sonnet', label:'Sonnet (legacy alias)', verified:false}`，前插为独立行并打勾。
2. **不自动映射**到 `claude-sonnet-5` / dated id / 列表首项——**这张映射表没有权威出处**（`sonnet` 指向哪个版本由 SDK 当期默认决定，会随 SDK 升级漂移）；猜错就是把用户会话静默钉在他没选过的模型上且旧值已被覆盖无法回滚。`sessionIndex.ts:19-27` 已为完全同类问题立过规矩：「normalizing it on load 会把一次兼容的读变成一次不可逆的写迁移」。
3. **旧值继续经 SDK/CLI 兼容链发送**——「cch 不认短名」不等于「我们下发短名会坏」，中间隔着 SDK 翻译层（`claudeRuntime.ts:780-783` 把 model 作为 `query()` 顶层选项；D47 GUI 点验 Claude 回合 PASS 即这条链在跑的实证）。
4. **迁移由用户的下一次点击完成**：用户选任何全名或 `Automatic` 后覆写旧值，之后不再显示 legacy alias。
5. **新 session 的 UI 只提供 `Automatic` 与白名单过滤后的全长名**，不再提供三短名静态选项；新会话默认 = `Automatic`（改判 #10，实现方可否决条款见该行）。
6. **`Stored selection · unverified`（B 稿承重独有物，独立于 §4.4-1 的三短名 Legacy alias）**：拍板 #5 的白名单会把**代理确实支持但不在展示面**的全名挡在目录外（调查 04 实测 claude 15 / codex 10 条，过滤后各 3 条——`gpt-5.5`、`claude-opus-4-6` 等存量选择全部落在目录外）。这类既有值的口径：
   - **前插为独立行**：`{ id: <存量值>, label: '<存量值> · unverified', verified: false }`，打勾选中，**不扩为可选目录**（其他人选不到它，只有本 session 保留）；
   - **send payload 原样带出**（不改写、不重置为 `Automatic`——那就是 R11 要防的静默换模型，只是换了个入口）；
   - 用户下次显式改选后该行消失（与 §4.4-4 同一迁移机制）。
   - 断言 B16（喂 04 实测目录 + 存量 `gpt-5.5` → 前插 unverified 且 selected 且 payload 原样）+ 变异 ⑮（丢弃/重置存量选择为 `Automatic` → B16 红）。

### 4.5 Codex 侧第二目录源：不接 `model/list`

Codex 有两个可能来源：cch `GET /v1/models`（10 条，调查 04 实测）与 codex app-server `model/list`（5 条，S1 spike）。**裁定：只用 cch，不接 `model/list`。**

- `model/list` 已在方法契约里（`codex-method-contract.json` clientRequest[53]）且真实调用过，技术可行；**但它答的是「codex 二进制内置目录」，不是「代理支持什么」**（调查 01 `:130` 实测）。调查 04 探测 H 证明代理列表外的模型打不通 → **代理列表才是决定能否跑通的那个**。
- 接了就有两张 codex 目录要合并，而合并规则（交集？并集？谁优先？）没有任何证据支撑。
- 代价：`CODEX_METHOD`（`codexWire.ts:85-96`，实为**十方法**）不用加第十一个方法，agent-host 不用加凭据面。

### 4.6 D40 Codex 半边：**model / effort 都补 + 三条防线（rev.3：防线 ① 探针已过）**

> **定稿裁定（用户拍板 2026-08-16，仲裁 §2.1）：`buildTurnStartParams` 同时补 `model` 与 `effort`。**
> A 稿的「不补 model」被推翻，但其**双真源分析全部保留为防线理由背景**（下）。

`codexRuntime.ts:246-256` 的两条丢弃理由在调查 04 之后的处置：

| 字段 | 原丢弃理由（`:250-256`） | 04 之后 | 定稿 |
|---|---|---|---|
| `effort` | 「per-model 词表，从未读过 `model/list`，盲映射会 fail turns」 | ❌ **前提已消除**：04 探测 E/G 实证 cch 侧五档 `low/medium/high/xhigh/max` 与 `CHAT_EFFORTS`（`efforts.ts:24-30`）逐值一致，越界（`ultra`）是**显式报错非静默** | **补上**（`thread/start` 根本不发 effort，`buildThreadStartParams:216-223` 只有 `cwd/approvalPolicy/sandbox/model?` → 补它是**唯一真源**） |
| `model` | 「已在 `thread/start` 钉死，会话建立时生效一次」 | ⚠️ 事实仍成立，但**不再构成不补的理由**：接受「覆盖即新默认」为单一语义 | **补上 + 三条防线** |

**拍板理由（用户，双轴行为对称优先）**：同一个 D48 UI 在 Claude 轴能中途改 model、Codex 轴无效，是确定性错误而非安全降级。
**用户补充佐证（同日）**：官方 codex CLI 本身支持会话中途 `/model` 换模型与 effort，后端同为 app-server 长驻 thread ——**「中途覆盖 model」是上游一等公民路径，「覆盖即新默认」有官方先例**，A 轨的双真源担忧因此进一步降级。

**A 轨反例转成的三条防线（不丢弃，全部为施工前置/硬约束；rev.3 起防线 ① 已由 P1 实证关闭，②③ 原样生效）**：

- **① 探针先行【✅ 已过，rev.3】**：P1 实测（[06-probes §P1](./2026-08-16-agent-picker-investigation/06-probes.md)，live 2 回合，`~/.claude` / `~/.codex` / dev.env 零写入）——`thread/start` 钉 `gpt-5.6-sol` → 第 1 发 `turn/start` 带 `model:'gpt-5.5'` → **第 2 发不带任何覆盖，rollout 的逐回合 `turn_context` 仍是 `gpt-5.5`**（`sandboxPolicy` 同样没回到 `thread/start` 的值）；schema 侧 `TurnStartParams` 的 `model`/`effort`/`approvalPolicy`/`sandboxPolicy` 等覆盖字段描述逐条写着 "for this turn AND subsequent turns"（06 §0.3），即**codex 在 schema 层就没有「仅本回合」的覆盖语义**。
  → **「覆盖即新默认」成立，`buildTurnStartParams` 补 model/effort 的前提坐实**；「探针推翻则退回只补 effort」的回退臂**不再触发**（保留在 §7-R8 作为历史依据，不再是活条款）。
  **连带口径（P1 对 S2 的直接指示 1，必须落进 UI）**：Codex 轴**不存在 per-message 模型语义**——选了 X 就是整条线程改成 X，直到下次再改。S2 的模型选择器在 Codex 轴按「**线程当前模型**」呈现，**不得复制 Claude 轴的 per-turn 心智**（Claude 轴每回合重开 `query()`，见 P2）；文案与 tooltip 按此写，两轴不共用一句话。
  **顺带实证（归 S4 用）**：`turn/start` 覆盖 `approvalPolicy`/`sandboxPolicy` 同样合法且 sticky——但 **S4 的实时权限走 `thread/settings/update`（零回合），不为改档去凑一个 `turn/start`**（§6.2-1）。
- **② 单一语义写死（消双真源靠回写收敛，不靠禁止覆盖）**：`turn/start` 覆盖成功后，运行时**必须**把新 model 写回会话状态（Host `SessionRegistry` session default），对齐 Claude 轴 `claudeRuntime.ts:514-522` 的回写模式（回写语句本身在 `:522`），使 `thread/start` 的初始值不再被任何路径读作真源；idle sweep revive 与后续 resume 都用回写后的值。**请求失败不提交默认值**（事务式）。
  > **回写的 wire 依据 = `thread/settings/updated` 广播（P1 实证，rev.3 落实）**：`turn/start` 的**响应体里没有 model**（实测 `{turn:{id,items,itemsView,status,…}}`），`turn/started`/`turn/completed` 通知载荷同为 `Turn` 对象、同样没有，`thread/read` 的 `Thread` 也没有 —— **覆盖生效的唯一权威回声是 `thread/settings/updated` 通知的全量 `threadSettings`**（06 §0.4）。因此回写值**取通知里的 `threadSettings.model`/`effort`，不做「我发了什么就回写什么」的乐观更新**（发出去的值可能被 `allowProviderModelFallback` 之类改写）。**这条通知本来就要在 S4 订阅（§6.2-6），S2 直接消费同一条即可，不另造第二条回声路径。** 兜底：通知在超时窗内未到达 = **未确认**，不回写 registry 默认、UI 保留旧值（与「请求失败不提交」同臂）。断言 B8（扩为三臂），B14 不变。
  > **消费侧也必须有钉子**：B6/B8 只钉了**生产侧**（出参形状 / 成功臂写、失败臂不写），没有任何一条钉「revive/resume 重建 `thread/start` 参数时读的是回写值而非初始值」。只钉生产侧时，一个「照写 registry 但 revive 仍读初始 model」的实现可以全绿通过，双真源原样复活。承重断言 = **B14**（消费侧分叉场景），对应变异 ⑬。
- **③ 负控与显式覆盖**：中途换 model 路径**必须有显式测试与变异对**（§4.8-**B6/B8/B14** + §4.9-⑤⑥⑬）。A 轨指出的真实风险是「两处发同一个值时行为一致，**只有用户中途改 model 才分叉**，而那条路径今天零覆盖」——因此本防线的承重用例**必须构造分叉场景**：`thread/start` 用 model A 建 thread → `turn/start` 覆盖为 B → 随后 revive/resume。纯函数出参断言与写入臂断言都**不构成**这条路径的覆盖。

**改动面（S2 内，纯加法）**：

```ts
// codexRuntime.ts:232-235 / :259-265
type CodexTurnStartParams = {
  threadId: string;
  input: CodexTextInput[];
  model?: string;                 // 新增
  effort?: SessionEffortLevel;    // 新增
};
```

发送规则：

1. `input.model` trim 后非空才发。**「必须来自当前 agent 的目录选择」这条校验落在 Main dispatch 之前，不在 Host 侧**——agent-host 子进程既无目录也无 baseUrl（`hostEnv.ts:64-71` 八键实证），它拿到的只是一个字符串，无法判定它是不是「当前 agent 目录里的项」，在那里写拒绝只能得到一个永远放行的假守卫。校验形状与位置同 §4.3 末条与 C10（`model ∈ 该 agent 当前 catalog ∪ {该 session 的 legacy/unverified 既有值}`，错配在 dispatch 前失败）。断言 B18 + 变异 ⑯。
2. `input.effort` 经现有 `SessionEffortLevel` 五值守卫后才发。
3. **两者只在显式选择时出现；`Automatic`/`Default` 一律省略键**（不是发 `undefined` 值）。
4. 成功后按防线 ② 事务式回写 registry 默认；失败不回写。
5. `thread/start` 保留初始 model 与权限姿态，**不删**。
6. **不把 approval/sandbox 顺手加进 `turn/start`**——P1 顺带实证它们在 `turn/start` 里同样合法且 sticky，**正因为能塞进去才更要挡住**：S4 的实时权限走 `thread/settings/update`（零回合，§6.2-1），S2 顺手补上会在两个切片之间造出第二条权限写通道。本条是**负控**，不是「暂时不做」。

调用点 `:2393-2399` 把 `send()` 已收到的 model/effort（`:2304-2311`）透传进去；**`:250-256` 的丢弃注释整段重写**为本裁定 + 三条防线的摘要（保留 sticky 语义引用，因为防线 ② 依赖它）。
`codex-turn-schema.json` 的 `TurnStartParams.propertyNames` 已含 `effort`/`model`，`codexWireContract.test.ts` 范式的契约测试**必须同步扩到断言这两个字段名**——否则 codex 升级改名会变成运行时 `-32602`。

### 4.7 S2 Happy Path

1. **Claude 轴**：登录态就绪 → 打开 Composer → `useAgentModelCatalog('claude-code')` 首次触发 IPC → Main 单飞 `net.fetch(claudeBaseUrl + '/v1/models')` → 15 条经白名单过滤为 3 条（haiku/sonnet/opus 各最新）→ 菜单显示全名，存量 `sonnet` 前插为 `Sonnet (legacy alias)` 并打勾 → 用户点 `claude-sonnet-5` → 覆盖 per-session storage 且更新 `byAgent['claude-code'].model` → 重开 app 后新草稿默认恢复该值。
2. **Codex 轴**：切 picker 到 Codex → 拉 10 条 → 过滤为 3 条 `gpt-5.6-*`（目录不出现 `gpt-5.2`、不出现 `-mini`/`gpt-image-*`）→ 选 `gpt-5.6-sol` + effort `high` → 发消息 → **`turn/start` params 同时含 `model:'gpt-5.6-sol'` 与 `effort:'high'`** → 成功后 registry 默认更新 → 下一次 send 即使 renderer 省略也继承新默认。
3. **切轴隔离**：Claude↔Codex 切换时目录与偏好整体切换，Claude id 不泄漏到 Codex。
4. **refresh 失败但有 cache**：仍能选旧值，UI 明示 stale + Retry；Retry 成功原地刷新。
5. **首次查询失败/凭据不可用**：返回种子表六条，UI 明示「目录不可达（内置种子表）」；用户仍可发送；`net.fetch` 零调用（凭据不可用臂）。
6. **完全无目录且用户未选**：`Automatic` 可发送，wire 省略 model；**不伪造静态目录、不回退 `CHAT_MODELS`**。

### 4.8 S2 确定性断言点

| # | 断言 | 形状 |
|---|---|---|
| B1 | 四级回落真值表：proxy 成功→`source:'proxy'`·`stale:false`；失败+cache→`'stale-cache'`·`stale:true`；失败+无 cache→`'seed'`；**凭据不可用→`'seed'` 且 `net.fetch` 调用数 0 且 `error:'credentials-unavailable'`** | 纯模块 + fake fetch |
| B2 | 单飞：同一 cache key 并发 3 次 → `net.fetch` 恰 1 次 | spy 调用计数 |
| B3 | cache key 含 agent 与凭据/baseHost generation：拉 `claude-code` 不污染 `codex`；凭据变化清空对应条目；HTTP 非 2xx **不覆盖** last success 也不更新 `fetchedAt` | 交叉真值表 |
| B4 | 双轴请求契约：Claude 用 `x-api-key`、Codex 用 `Bearer`，URL 各自规范化；**日志与 renderer payload 不含 key/token/完整响应体/URL userinfo** | 请求契约断言 + secret scan |
| B5 | 存量短名 `'sonnet'` + 全名目录 → 菜单前插 `{id:'sonnet', verified:false}` 且 `selected:true`，**且读操作不改 localStorage**（字节快照对比）；新 session options 不含 `sonnet/haiku/opus` | 已有测试扩例 + storage 快照 |
| **B6** | **`buildTurnStartParams({threadId,text,model:'gpt-5.6-sol',effort:'high'})` → params 同时含两键**；不传时**键缺席**（`'model' in params === false`，不是 `undefined` 值）；model 空串/空白 trim 后省略 | 纯函数 `toEqual` + `in` 断言（表驱动） |
| B7 | 契约测试扩到断言 `model`/`effort` ∈ `codex-turn-schema.json` 的 `TurnStartParams.propertyNames` | 读 fixture 比对 |
| B8 | **回写事务性 + 回写来源（防线 ②）**：`turn/start` 成功**且收到 `thread/settings/updated`** → registry session default 更新为**通知里的 `threadSettings.model`/`effort`**（须构造「请求 `gpt-5.6-sol` 而通知回 `gpt-5.5`」的分叉臂，钉死回写的是**通知值不是请求值**）；请求失败 → 不更新；通知在超时窗内**缺席** → 同样不更新（旧值不变） | Host 单测三臂（成功 / 失败 / 通知缺席） |
| B9 | **白名单过滤（拍板 #5）**：喂 04 实测原始列表 → 输出恰为种子六条；族内出现更高版本 → 自动上架且旧版下架；出现未知家族名 → 不上架；`gpt-image-*`/`codex-auto-review`/`-mini` 恒被排除；同版本有日期别名与无日期别名时取无日期 | 表驱动纯函数 |
| B10 | 目录外项不会成为 verified option（Codex fixture 含 `gpt-5.2` → 过滤后不出现）；`ultra` 在 shared type、storage normalization、菜单、Host wire **四层均被拒绝** | 边界表 |
| B11 | `Automatic`/`Default` 分别使 model/effort 键从 create/send payload **省略** | payload 断言 |
| B12 | agent 切换后 options 与 selection 都来自目标 agent，不存在跨 agent selection | 切轴真值表 |
| B13 | `src/renderer/components/chat` 下 `CHAT_MODELS` 标识符零命中（`stripComments` 后扫描）；`ensureModelOptions` 已删除 | 静态扫描（资产删除） |
| **B14** | **消费侧回写（防线 ② 的承重半边）**：`thread/start` 用 model A 建 thread → `turn/start` 覆盖为 B **且成功** → **idle sweep revive 与 resume 重建的 `thread/start` 参数必须是 B**；失败臂：覆盖失败后 revive/resume 重建的参数仍是 A | Host 单测（分叉场景，双臂） |
| **B15** | **`lastAgent` × capabilities 求交真值表**：`lastAgent='codex'` + `agents=['claude-code']` → 新草稿 `claude-code`；`agents===undefined`（old Host）→ `claude-code`；`lastAgent` 未设置 → `claude-code`；`lastAgent='codex'` + 双可用 → `codex`。**hydration 双臂**：settings 未 hydrate 时新草稿 = `sessionAgent(undefined)` 且**不写** `lastAgent`；hydrate 完成后才生效 | 纯函数真值表 + hydration 双臂 |
| **B16** | **unverified 既有值（§4.4-6）**：喂 04 实测目录（过滤后 3 条）+ 该 session 存量 `gpt-5.5` → 菜单**前插** `{id:'gpt-5.5', verified:false}` 且 `selected:true`，且 send payload 的 model **原样是 `gpt-5.5`**（不重置为 `Automatic`、不改写为目录首条） | 菜单模型 + payload 断言 |
| **B17** | **catalog reconcile（§4.3-6）**：catalog 迟到期间显示上一次的值（无 spinner、无空）；catalog 到达后当前选择若已在 catalog 则**不改写**；切 agent 时按新 agent 的 (session, agent) 记录重解析 | 时序真值表 |
| **B18** | **model 跨 agent 校验在 Main dispatch 前**：Claude id 走 Codex session → dispatch 前失败且**无 `turn/start` 报文发出**；该 session 的 legacy/unverified 既有值**放行** | 拒绝路径断言（与 C10 同形状） |

### 4.9 S2 变异对（逐对实跑记红灯）

① cache TTL 判定反向（过期当新鲜）/ refresh 失败仍更新 `fetchedAt` → **B1/B3 红**
② 单飞去重删掉 → **B2 红**
③ Claude 请求误用 `Bearer`、Codex 误用 `x-api-key` → **B4 红**
④ 把静态 `CHAT_MODELS` 当失败 fallback（伪装可用目录）→ **B1/B13 红**
⑤ `buildTurnStartParams` 再次丢掉 `model`（或丢 `effort`）→ **B6 红**（D40 承重变异）
⑥ `turn/start` 失败仍写 registry 默认（非事务）**／** 把**请求值**乐观回写而不等 `thread/settings/updated`（通知回了别的 model 也照写请求值）→ **B8 红**（两个方向各一次实跑）
⑦ legacy `sonnet` 自动映射为目录第一条 → **B5 红**
⑧ 白名单过滤层跳过（直接透传全量目录）或把「未知家族默认上架」→ **B9 红**
⑨ 接受 `ultra` 或目录外 `gpt-5.2` 为 verified → **B10 红**
⑩ `composerModelMenuModel` 的未知项前插改为「勾移到 options[0]」 → **B5 红**
⑪ cache 不按 agent 分 key → **B3/B12 红**
⑫ vault `locked` 时改为 throw（或改为照常发起 `net.fetch`）→ **B1 的凭据不可用臂红**（含 `net.fetch` 计数 0 那半边）——R3 的承重断言至此才有配对变异
⑬ revive/resume 改读 `thread/start` 的初始 model（而非回写后的值）→ **B14 红**（防线 ② 消费侧；不补这一对，该变异今天可全绿通过、双真源原样复活）
⑭ 新草稿直接采用 `lastAgent` 不与 capabilities 求交（或未 hydrate 就写 `lastAgent`）→ **B15 红**
⑮ 目录外的存量选择被丢弃/重置为 `Automatic` → **B16 红**（R11 的第二个入口）
⑯ 把「跨 agent model 拒绝」放进 agent-host 侧（等价于永远放行）→ **B18 红**

### 4.10 S2 as-built（施工实况与规格偏差）

> 落账 2026-08-16。按 §1.3「每片 as-built 段落必须记：git commit · 四门逐门实跑输出 · 变异逐对红灯原文 · off/on 双轮结果 · 新增/改动文件清单 · 规格偏差条目」六项补齐。
> **施工编制**：核心员（Main / agent-host 半边）→ UI 员（renderer 半边）→ 变异复核员（⑨ 补跑 + ⑫~⑯ 交叉复核）→ **终检修复批**（本节末四门数字与 ⑰ / B10 变异出自该批）。
> **git commit：本片尚未提交**——终检修复批按用户纪律不自行 commit，收口态为工作树 50 个变更项（清单见 §4.10.6）。

#### 4.10.1 四门逐门实跑（终检修复后，逐门串行）

| 门 | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm typecheck` | `EXIT=0`，`tsc --noEmit` 无输出 |
| 2 | `pnpm typecheck:agent-host` | `EXIT=0`，`tsc --noEmit -p src/agent-host/tsconfig.json` 无输出 |
| 3 | `pnpm lint` | `EXIT=0`，`Checked 955 files in 755ms. No fixes applied. / Found 29 warnings. / Found 3 infos.`（0 error；29 warning 全在 `docs/design/*.html`，基线既有） |
| 4 | `pnpm test` | `EXIT=0`，`Test Files 220 passed (220) / Tests 4268 passed (4268)`，Duration 19.17s |

基线链：D47 收官 208 文件 3973 例 → 核心员交接 217/4161 → UI 员交接 220/4247 → **终检修复批收口 220/4268**（+21 例，无新增文件）。

#### 4.10.2 flag off/on 双轮

| 轮次 | 结果 |
|---|---|
| `AICLIENT_AGENT_CODEX` 未设（off） | `Test Files 220 passed (220) / Tests 4268 passed (4268)` |
| `AICLIENT_AGENT_CODEX=1`（on） | `Test Files 220 passed (220) / Tests 4268 passed (4268)` |

两轮逐例相同 —— §1.1-4「renderer/store 形状不得因 flag 分叉」在测试面成立。

#### 4.10.3 既有非 hermetic 红（**非本批引入**，不计入收口）

`AICLIENT_MANAGED_CREDENTIALS=1` 下：`Test Files 4 failed | 216 passed (220) / Tests 15 failed \| 4253 passed (4268)`。

落点 4 文件：`main/services/auth/__tests__/index.test.ts`（1）· `onboarding/__tests__/OnboardingService.test.ts`（6）· `session/__tests__/SessionManager.test.ts`（2）· `usage/__tests__/UsageService.test.ts`（6）。

**判定**：核心员已 `git stash` 回基线复跑，复现同样 15 例红 ⇒ 既有夹具非 hermetic 缺陷（读环境变量而非注入），**与 F13 同形**，零例落在 D48 S2 改动面。终检修复批在当前工作树复跑数字一致。留作独立票，不阻塞本片。

#### 4.10.4 规格偏差清单

**A · 核心员自报（Main / agent-host 半边，12 条）**

1. 服务文件名取规格 §4.1 原文 `AgentCatalogService.ts`（任务书写作 `ModelCatalogService`），因规格自称施工唯一入口。
2. **B18 判据 = 归属制而非目录成员制**。规格写 `model ∈ 当前 catalog ∪ {该 session legacy/unverified 既有值}`，但 Main 侧没有 renderer 的 per-session 选择存储，成员判定会把 §4.4-6 的 unverified（`gpt-5.5` / `claude-opus-4-6`）一并拒掉 = R11 的第二入口。改为三值 `resolveModelAgentOwner`：**只拒能证明属于对方轴的，未知/unverified/legacy 同轴一律放行**。
3. **B14 的 wire 事实修正**：codex 复活走 `thread/resume`（schema 仅 `threadId`，不重发 `thread/start`）。故「revive 重建的 `thread/start` 参数必须是 B」落为「复活后首发 `turn/start` 带 B」+「registry 默认 == B」双断言；失败臂用「下一发仍是 A」。
4. **B8 无超时窗状态机**。`thread/settings/updated` 处理器是 registry model/effort 的唯一写者 ⇒「通知缺席不回写」由构造成立，不需要 pending-override + latch + 定时器。规格的「超时窗未到达 = 未确认」退化为「没通知就没写」，行为等价、活动部件少一组。
5. 凭据 flag-off = `credentials-unavailable` → 种子表；**不**像 `UsageService` 那样回落读 `~/.codex/auth.json`（D47 S6 停双写后该文件可能是已被拒的旧 key），同时严守 §1.2：全链零读用户全局配置。
6. 种子表/请求规则不用 `Record<AgentWireName, …>` 字面量（`agentWireStatic.test.ts` 禁 `'claude-code'` 二次拼写），改为两个具名常量 + 选择器 `seedCatalogFor` / `requestRuleFor`。
7. effort 词表上收 shared（`SESSION_EFFORT_LEVELS` / `isSessionEffortLevel` 落 `shared/types/agentHost.ts`），`claudeRuntime.normalizeEffort` 改委托——一表两轴。这是本批唯一一处 `claudeRuntime` 触碰。
8. codex 侧 effort 开始入 registry：`createSession` / `resumeSession` / `bindResumedRow` 原注释「Codex has no measured effort parameter」故意丢弃，04 探测 E/G 后前提消失，已改为记录并注明反转理由。
9. **过滤后为空 ≠ 种子**：代理答了但白名单过滤后 0 条 → 仍 `source:'proxy', models:[]`（诚实的第四级 `Automatic` + Retry）；只有「解析不出 / 0 个 id」才判 `invalid-response` 进回落链。
10. `error:'host-not-ready'` 在类型里但 **Main 永不产生**（Main 看不到 Host 状态），留给 renderer hook 产生；已在类型注释写明。
11. 顺带补 `SessionIndexService.get(sessionId)` 点查（不用 `list().find` 排序全表）——B18 的 send 臂需要它。
12. 夹具欠采（06 §0.1 的 clientRequest 126 vs 121）本批未补；D48 要用的四个方法名夹具里都在，不阻塞。

**B · UI 员自报（renderer 半边，13 条）**

1. **两个存储键保留**，schema 为 `Record<sessionId, Partial<Record<agent, string>>>`，而非规格 §4.3 字面的合并对象 `{model?, effort?}`：合并对象需要第三个新键并迁移两份 legacy blob；拆成两键各存自己那个标量，(session, agent) 粒度完全一致，且两份 pre-D48 blob 在首次写入前字节不动。
2. legacy 扁平值的归属判据复用 `isModelAllowedForAgent`（与 Main B18 守卫**同一符号、同三值语义**）：`sonnet` 不会出现在 codex 草稿上；无法归类的值两轴都能读。
3. `hostDefaultModel` 降级口径落为「目录为空且本会话无既有选择」时的 unverified 选中值，**且同时是发送值**（只显示不发送会重演 A11 的显示值≠发送值）；走 `isModelAllowedForAgent` 闸，catalog 到达后由 `reconcileModelSelection` 的唯一 rewrite 臂改回 `Automatic`。
4. `Automatic` 存为「缺席」而非持久化哨兵（effort 的 `Default` 仍存哨兵）：model 侧「显式选 Automatic」与「从未选过」行为等价（都省略键、都继续跟随 agent 模板），存哨兵会把会话冻结在模板之外。
5. `resolveResumeModel` 签名改为 `(get, sessionId, agent, agentDefaultModel?) => string | undefined`，不再吃 `hostDefaultModel`；四个站点改经新 hook `useResolvedSessionModel`。
6. `resumeIntent.ts` 与 `ChatComposer` 内的 `resumeSession` 也改条件展开（规格 B11 只点名 create/send）：`model: undefined` 会把 Host registry 的 model 显式钉成「无」，与 `Automatic` 的「字段不存在」语义不同。变异 B11a 正是靠这条暴露出第三个漏改站点。
7. `useMessageMetadata` 的 `?? defaultModelId(null)` 兜底**删除而非替换**（它给每个未触碰会话盖上一个用户没选、线上也没发过的 `sonnet`），现为 `?? null`。
8. `ChatAgentDefaults` 落 `src/shared/models/` 而非 `src/renderer/`：与 `familyWhitelist.ts` / `seedCatalog.ts` 同类，且让 `settings/types.ts` 继续只从 `@shared` 取类型，不新增 settings → components 的 import 边。
9. 新增 `useSettingsHydrated()`（reactive）：裸调 `persist.hasHydrated()` 只会把「未 hydrate」答案留一辈子。B15 两条 hydration 臂分别由 `resolveInitialDraftAgent` 与 `canPersistLastAgent` 承担（拆开才咬得住写臂，变异 ⑭b 实证）。
10. `lastAgent` 记忆值会被回写 store，但**仅当它不等于 legacy 绑定**——否则每个新会话都会物化 `session.agent`，等于在 `mergeSessionIndex` 之外造第二个默认物化点。
11. `composerAgentPickerWiring.test.ts` 的 m9 断言由「恰 2 次」改为「等于 `setDraftSessionAgent` 调用点数」：S2 新增了第三个正确调用点，钉死字面 2 会为「正确代码到来」而红。
12. `chat.ts:240` 英文注释里混入的 `承重` 已改 `load-bearing`（CLAUDE.md 注释语言条），同批把同形状的 4 处一并改掉（保留 `[实测 调查 04]` 形式的中文出处引用）。
13. **未做**：`ChatAgentDefaults.permission` 字段（§5.5，属 S3）；Settings 的「Chat agent defaults」面板（S3 模板层写侧 UI）。本片只落 `byAgent` 的读写通道，写入点是 Composer 的显式选择。

**C · 终检核查新增（6 条，两员未自报）**

1. **§4.6 P1 指示 1「线程当前模型」文案 = 简版实现**。规格要求 registry 回声投影到 renderer 的完整版；as-built 只做**文案分轴**（`CLAUDE_MODEL_SCOPE_HINT` / `CODEX_MODEL_SCOPE_HINT` + `modelScopeHint(agent)`，进 tooltip 与 `aria-label`），并以静态断言钉死两轴不共用同一句、Codex 句不得含 `turn`。**完整版（registry 回声 → renderer 显示线程当前模型）降级为遗留条目，另立后续票**，S4 订阅 `thread/settings/updated` 时一并落。
2. **B18 归属制放行未知 id 是负控，须有引用**：偏差 A-2 的三值判据意味着「未知家族的新 id」在 Main 侧一律放行——这是**刻意**的（拒绝未知 = R11 的第二入口），不是守卫漏洞。变异 ⑯b（守卫恒真）9 红证明它不是假守卫。
3. **§4.3-1 的 props 契约未抬升**。规格列 `agent / catalog / catalogState / selectedModel / selectedEffort / onModelChange / onEffortChange / onRetryCatalog` 八个新 prop；实际只加了 `agent` 与 `hostState`，目录与选择仍由组件内 `useAgentModelCatalog` + 两个 `useState` 自持。理由：把 catalog 提到 `ChatComposer` 会让每个 Composer 渲染都持有目录状态，而目录是**按 agent** 而非按 composer 缓存的；抬升 props 只是把同一份 hook 状态多穿一层。**决策面仍全在纯模块**（`models.ts` / `agentModelCatalog.ts`），可真值表化的部分一条没少。
4. **`ChatAgentDefaults` 落点实际是 `types.ts` / `index.ts` / `migration.ts`**，非 §4.3 写的 `types.ts` / `defaults.ts` / `migration.ts`：本仓 `settings/defaults.ts` 不是 store 初值的落点，初值在 `settings/index.ts:177`（`chatAgentDefaults: EMPTY_CHAT_AGENT_DEFAULTS`）。规格行号引用有误，实现取实况。
5. **`ChatAgentPreference.effort` 类型是 `string` 而非 `EffortSelection`**（`shared/models/chatAgentDefaults.ts:42`）。原因：`shared` 侧不 import renderer 的 `efforts.ts`，而 `EffortSelection` 含 renderer 的 `EFFORT_DEFAULT_ID` 哨兵。sanitize 只做「非空字符串」收窄，**真正的词表守卫在 storage 与 Host wire 两层**（见下条）。
6. **B10「四层拒绝」措辞修正为实况**。规格称 `ultra` 在「shared type / storage normalization / 菜单 / Host wire」四层均被拒；实况是 **shared type 为编译期**（`SessionEffortLevel` 联合，运行时零拦截）、**菜单为不提供**（只渲染 `CHAT_EFFORTS` 五条 + 哨兵，属「选不到」而非「拒绝」）。终检前真正的**运行时**拒绝只有 Host wire 一层。本轮补 storage 层（见 D-3），实况为**运行时两层 + 编译期一层 + 菜单不提供一层**。

**D · 终检修复批新增（3 条）**

1. **`reconcileModelSelection` 双触发折叠（BLOCKER，已修）**。§4.3-6 的两个触发被折成单保守函数：切会话保留上一会话模型（`storedModel` 被无视）、`catalogLoaded=false` 时跨轴值存活（B12 破口）。修法 = `ModelReconcileInput` 增**必填** `pairChanged`（刻意不给默认值，漏传不编译），pair 变化时无条件走 `resolveModelSelection`；保守臂只服务 catalog 迟到场景，且**在所有 keep 臂之前**加 `isModelAllowedForAgent` 闸。消费侧 `ComposerModelTrigger` 用 `resolvedPairRef` 记住上次已解析的 `(sessionId, agent)`——该组件**从不按会话重挂载**（`ChatWorkspace` 渲染单个无 `key` 的 `ChatComposer`），无此 ref 则「切会话」与「重渲染」不可区分。补 B17「pair 移动」四例 + B12「未加载即杀跨轴值」一例；变异 ⑰ 三臂全灭。
2. **`ComposerModelTrigger.tsx` 混入两个裸 NUL 字节（新发现，已修）**。pair key 写作 `` `${sessionId}<0x00>${agent}` `` —— 分隔符选 NUL 本身是对的（会话 id 与 agent 名都不可能含它），但**以裸字节写进源文件**使 `file(1)` 判定该文件为 `data`、ripgrep 判定为 binary 并**整文件跳过**。本仓多处资产删除守卫（B13 等）依赖对 `chat/` 目录的文本扫描，一个 grep 不可见的文件是**假绿风险**。改为 `\0` 转义，运行时字符串逐字节相同，文件恢复 `UTF-8 text`。
3. **B10 storage 层词表守卫补齐（对应 C-6）**。`efforts.ts` 新增 `isEffortSelection()`（由 `CHAT_EFFORTS` 派生，不第二次拼写五个词），`sessionPreferenceStore.writeSessionEffort` 在写入前拒绝词表外的值。选**写入拒绝**而非读时丢弃：读时丢弃会把坏值留在盘上、每次读重新判定一次，而「读时顺手改写」被 `sessionIndex.ts:19-27` 明令禁止（把一次兼容的读变成不可逆的写迁移）。四例断言 + 变异两臂各 3 红。

> **另附终检修复批过程中的两处连带修**（非规格偏差，属测试自身缺陷）：
> ① `composerModelWiring.test.ts` 的 `expect(trigger).toContain('useAgentModelCatalog(agent, hostState)')` 因菜单 TTL 修复往解构里加了一个 `refresh,`，整行由 100 字符涨到 102 触发 biome 换行而变红——**正是该文件头注自己警告的「formatter owns the line breaks」**。改为按去空白形式断言（新增 `compact()` 助手）。
> ② `models.test.ts`「catalog 未加载时保持当前值」一例原用 `current:'gpt-5.5'` 配 Claude 轴，被 D-1 新增的跨轴闸正确改写而变红。该用例本意是「过滤掉的同轴遗留值也要保留」，故改用 Claude 轴的 `claude-opus-4-6`；跨轴场景由相邻的 B12 用例专管。

#### 4.10.5 变异逐对红灯表

> 口径：逐对实跑，红灯以 vitest 失败用例名记录（本仓 reporter 不打印 `FAIL ... N failed` 汇总尾行，故抄失败用例名 + 计数）。**变异施加与还原一律用 python / Edit 精确字符串替换，禁 `git checkout`**（原因见 §4.10.5 末「事故披露」）。

| 编号 | 变异内容 | 红灯 | 执行者 |
|---|---|---|---|
| ①a | cache TTL 判定反向（过期当新鲜） | 4 红（B1-② + TTL 三例） | 核心员 |
| ①b | 失败仍刷新 `fetchedAt` | 1 红（"a non-2xx overwrites neither the models nor fetchedAt"） | 核心员 |
| ② | 删单飞去重 | 1 红（B2） | 核心员 |
| ③ | 双轴 header 对调（Claude 用 Bearer / Codex 用 x-api-key） | 11 红（含 B4 两条对钉） | 核心员 |
| ④ | 静态 `CHAT_MODELS` 当失败 fallback | 2 红（B13 扫描 +「空目录仍只给 Automatic」） | UI 员 |
| ⑤a | `buildTurnStartParams` 再丢 `model` | 8 红（B6 五 + B14 三） | 核心员 |
| ⑤b | 丢 `effort` | 4 红 | 核心员 |
| ⑤c | `effort` 改名 `reasoningEffort` | 5 红（含 "every key it can emit is one the binary declares"，即 -32602 咬合） | 核心员 |
| ⑥a | 乐观回写请求值（仍消费通知） | 3 红（B8-②③ + B14 失败臂） | 核心员 |
| ⑥b | 乐观回写 + 忽略通知 | 5 红（含 B8-① 分叉臂） | 核心员 |
| ⑦ | legacy 短名自动映射到目录首条 | 3 红（B5/B16 存量原样 + Host default 优先级） | UI 员 |
| ⑧a | 跳过白名单直透全量目录 | 24 红 | 核心员 |
| ⑧b | 删解析层家族闸 | **首轮存活**（输出循环是第二道闸）→ 补 parse 层断言后 1 红 | 核心员 |
| **⑨a** | `SESSION_EFFORT_LEVELS` 加入 `'ultra'` | 2 红（`claudeRuntimeOptions.test.ts` `normalizeEffort` 拒绝表 + `codexRuntime.test.ts` "drops an effort outside the measured five-word vocabulary"） | **变异复核员补跑** |
| **⑨b** | `filterCodex` 顶代过滤改为放行全部代际（目录外 `gpt-5.2` 成 verified） | 9 红（`familyWhitelist.test.ts` B10 纯半 + `agentCatalogService.test.ts` B3 双轴交叉两例） | **变异复核员补跑** |
| ⑩ | 未知项前插改为把勾移到 `options[0]` | 3 红（F-A16 + B5 + B16） | UI 员 |
| ⑪ | cache key 不按 agent 分 | **首轮仅 1 红**（夹具两轴密钥不同掩盖）→ 补「同 host 同 key」用例后 2 红 | 核心员 |
| ⑫a | vault `locked` 改 throw | 1 红 | 核心员 |
| ⑫b | 凭据不可用仍发 `net.fetch` | 7 红 | 核心员 |
| ⑬ | revive/resume 改读 `thread/start` 初始 model | 4 红（B14 三 + B6 wiring 一） | 核心员 |
| ⑭a | `lastAgent` 不与 capabilities 求交 | 3 红（B15 求交三臂） | UI 员 |
| ⑭b | hydration 前允许写 `lastAgent` | 1 红（B15 写臂——单列才咬得住） | UI 员 |
| ⑮ | 目录外存量选择重置为 `Automatic` | 3 红（B17 keep 臂 + B12 切轴臂） | UI 员 |
| ⑯a | 删 Main send 守卫 | 4 红 | 核心员 |
| ⑯b | 守卫恒真（假守卫形） | 9 红（跨两文件） | 核心员 |
| **⑰a** | **删 `if (pairChanged) return resolveModelSelection(input);`（两触发折成单保守函数）** | **3 红**：`B17: the pair moved > a session switch on the same agent adopts the new session stored choice` / `> a session switch to a session that chose nothing falls back, it does not inherit` / `> resolves the new pair even while its catalog is still in flight`（`Tests 3 failed \| 34 passed (37)`） | **终检修复批** |
| **⑰b** | **删 keep 臂前的 `isModelAllowedForAgent` 跨轴闸** | **1 红**：`B17: what a late catalog may overwrite > B12: a value belonging to the other runtime dies even before the catalog loads`（`Tests 1 failed \| 36 passed (37)`） | **终检修复批** |
| **⑰c** | **消费侧改传 `pairChanged: false`（组件算了但不告诉纯函数）** | **1 红**：`B17 wiring > the reconcile is told when the (session, agent) pair moved, off a ref`（`Tests 1 failed \| 20 passed (21)`） | **终检修复批** |
| **B10a** | **删 `writeSessionEffort` 的词表守卫** | **3 红**：`B10: a word outside the vocabulary never reaches storage` / `B10: rejecting an illegal write leaves the previous legal value intact` / `B10: neither a blank string nor a near-miss casing gets through`（`Tests 3 failed \| 24 passed (27)`） | **终检修复批** |
| **B10b** | **`isEffortSelection` 放宽为「任意非空字符串」** | **3 红**（同上三例，`Tests 3 failed \| 24 passed (27)`） | **终检修复批** |
| **ctx** | **Context 面板去掉 agent 模板那一级（第二实参改 `null`）** | **2 红**：`§4.3 wiring > reads the session rung and the agent-template rung through the shared helper` / `> keys both rungs by the session agent, never by a hard-coded axis` | **终检修复批** |
| **ttl** | **菜单 `onOpenChange` 改接 `retry()`（强制臂）** | **1 红**：`B17 wiring > opening the menu re-checks the TTL through the non-forced request` | **终检修复批** |

**⑫~⑯ 交叉复核**（变异复核员独立重跑，范围比原报告更粗、方向一致，不构成推翻）：⑬ 屏蔽 `onThreadSettingsUpdated` 的 `session.model` 写回 → 4 红（revive 用旧值 `gpt-5.6-sol` 而非确认值 `gpt-5.5`）· ⑭ 删 `resolveInitialDraftAgent` 求交 → 3 红 · ⑮ `usableFor` 恒返回 null → 13 红 · ⑯a `assertModelMatchesAgent` 整函数 no-op → 7 红（关的是全部 3 个调用点）· ⑫b `credentials.status !== 'ok'` 判据关闭 → 1 红（`vault.codex` 访问 undefined 崩溃，证明该分支承重）· ⑫a vault locked→throw 因 electron 依赖不可单测，经 `AgentCatalogService.test.ts` "④ credentials unavailable" 间接钉住，走查一致、未独立实跑。

**事故披露（纪律违反，已复原）**：变异复核员验证 ⑨ 时用 `git checkout -- src/shared/types/agentHost.ts` 撤销自施变异，而该文件同时携带 D48 的真实未提交改动（`SESSION_EFFORT_LEVELS` / `isSessionEffortLevel`），checkout 把真实工作一并清空——违反用户「未提交态恢复禁 checkout」明令。发现后以此前保留的完整 diff 经 Edit 手工重建，`git diff` 复核显示重建后 blob hash（`8ba0fb5`）与事故前完全一致，**确认字节级零损失**。此后全部变异施加/还原改用 python / Edit 精确字符串替换。

#### 4.10.6 改动/新增文件清单（`src/` 工作树 50 项；本规格文档 §4.10 落账为第 51 项）

**新增 · Main / shared（11）**：`src/shared/types/agentCatalog.ts` · `src/shared/models/familyWhitelist.ts` · `src/shared/models/seedCatalog.ts` · `src/shared/models/chatAgentDefaults.ts` · `src/main/services/agentCatalog/AgentCatalogService.ts` · `src/main/services/agentCatalog/index.ts` · `src/main/ipc/agentCatalog.ts` · 测试 4：`src/shared/__tests__/familyWhitelist.test.ts` · `src/shared/__tests__/chatAgentDefaults.test.ts` · `src/main/services/agentCatalog/__tests__/agentCatalogService.test.ts` · `src/main/ipc/__tests__/chatModelAgentGuard.test.ts` · `src/main/ipc/__tests__/agentCatalogIpc.test.ts`

**新增 · renderer（6）**：`chat/agentModelCatalog.ts` · `chat/useAgentModelCatalog.ts` · `chat/sessionPreferenceStore.ts` · `chat/useResolvedSessionModel.ts` · 测试 2：`chat/__tests__/agentModelCatalog.test.ts` · `chat/__tests__/composerModelWiring.test.ts`

**删除/改名（2）**：`chat/sessionEffortStore.ts` 删除（并入 `sessionPreferenceStore.ts`）· 其测试 `git mv` 为 `chat/__tests__/sessionPreferenceStore.test.ts` 并重写

**修改 · Main / agent-host（13）**：`shared/types/ipc.ts` · `shared/types/agentHost.ts` · `preload/index.ts` · `main/ipc/index.ts` · `main/ipc/chat.ts` · `main/services/chat/SessionIndexService.ts` · `agent-host/codexRuntime.ts` · `agent-host/codexWire.ts` · `agent-host/codexNormalizer.ts` · `agent-host/claudeRuntime.ts` · 测试 3：`agent-host/__tests__/codexRuntime.test.ts` · `agent-host/__tests__/codexWireContract.test.ts` · `chat/__tests__/pureModuleImports.test.ts`

**修改 · renderer（18）**：`chat/models.ts`（整体重写）· `chat/composerModel.ts` · `chat/efforts.ts` · `chat/ComposerModelTrigger.tsx`（重写）· `chat/ComposerAgentPicker.tsx` · `chat/ChatComposer.tsx` · `chat/useSessionModel.ts` · `chat/useSessionEffort.ts` · `chat/useMessageMetadata.ts` · `chat/MessageTimeline.tsx` · `chat/sessionIndex/resumeIntent.ts` · `workspace-shell/LeftNav.tsx` · `workspace-shell/surfaces/ContextSurfaceView.tsx` · `stores/settings.ts` · `stores/settings/{types,index,migration}.ts` · 测试 4：`chat/__tests__/models.test.ts` · `chat/__tests__/composerModel.test.ts` · `chat/__tests__/efforts.test.ts` · `chat/__tests__/composerAgentPickerWiring.test.ts`

**终检修复批实际触碰（8）**：`chat/models.ts`（⑰ 修：`pairChanged` + 跨轴闸；上批已落，本批仅复核）· `chat/ComposerModelTrigger.tsx`（NUL → `\0`）· `chat/efforts.ts`（`isEffortSelection`）· `chat/sessionPreferenceStore.ts`（B10 写侧守卫）· `chat/__tests__/sessionPreferenceStore.test.ts`（+4 例）· `chat/__tests__/composerModelWiring.test.ts`（+3 例 Context 面板断言、+`compact()`）· `chat/__tests__/models.test.ts`（跨轴用例改判）· `main/services/agentCatalog/AgentCatalogService.ts` 与其测试 + `chat/__tests__/composerModel.test.ts`（中英混排注释改英文，共 5 处）


---

## §5 S3 — 权限读侧闭环 + 新会话默认档

### 5.1 分层：本片做什么、明确不做什么

| 层 | 本片 | 说明 |
|---|---|---|
| **L1 读侧补链** | ✅ 做 | Codex 会话的 Context 面板不再整行消失 |
| **L2 capabilities 补键** | ✅ 做 | `permissionPolicy: true`（N1：类型已存在、Host 忘接） |
| **L3 写侧：新会话/恢复默认档** | ✅ 做 | Settings「Chat agent defaults」模板 + 首发物化为会话快照 |
| **L4 会话中途改档** | ❌ 本片不做 | 归 **S4 正式切片**（§6）——Q1 拍板后它是必做需求，只是不在 S3 的失败面里 |
| **L5 单次工具审批** | ❌ 不做 | `PermissionQaCard`（`QuestionCard.tsx:498`）已存在，是独立概念（调查 02 §4），与默认档互不污染 |

**为什么 L3 进本阶段而不是首片**：L3 的**下发时机**与 agent/model 完全同构——未物化可选、随 create 下发、物化后由会话快照接管，**共用同一个物化点**（首条 `sendMessage()` commit）与同一条 wire 时机，分开做等于把同一语义实现两遍；而 L4 不同构（要动 `CODEX_METHOD` 方法表、把 `CHAT_PERMISSION_MODE` 升成会话态、并订阅一条新的设置回声），故切出去。

> **rev.3 口径修正（Q1 拍板后，务必读完再动工）**：写侧是**双层**——S3 只做 **Settings 模板层**，Composer 的**实时权限控件归 S4**。因此 S3 依旧**不存在** per-session 权限控件，「三者共用锁定判据」的理由依旧**不引用**（锁定判据的消费者仍是 §3.3 的三处，一处不多）。
> 更要紧的是：**S4 的权限控件也不消费锁定判据**。agent 绑定在首发后锁死，是「换 agent 等于另开会话」的后果；而权限档在**已锁定会话里照样可改**——那正是 Q1 拍板的需求本体。两个闸门形状不同、**不得复用**（§6.3 + 断言 §6.5-D13）。

### 5.2 L1：Codex 读侧补链（三处改动 + 一个早退陷阱）

shared 已有判别联合：Claude 为 `permissionMode`，Codex 为 `approvalPolicy + sandboxMode + networkAccess`（`runtimeEvents.ts:506-567`）；Host 已发 Codex policy，但 renderer adjacent store 只折叠旧 `permissionMode`（`contextSurfaceModel.ts:447-508`）。

1. **`SessionRuntimeFacts` / `ContextRuntimeFacts` 加字段**（两个接口相距约 350 行，**必须并列标注**：`ContextRuntimeFacts` = `contextSurfaceModel.ts:75-100`；**`SessionRuntimeFacts` = `contextSurfaceModel.ts:425-440`**，后者才是 `reduceSessionRuntimeFacts` 读写的那个）：加 `permissionPolicy?: SessionPermissionPolicy | null`，**与现有 `permissionMode` 并存不替换**。
   > 并存是对齐不是冗余：`permissionMode`（`:98`）的三态语义（undefined 省略行 / null "not reported" / 值→文案）被 `buildRuntimeRows:222-227` 与一堆测试钉着；且 `SessionCreatedEvent.payload` 至今**同时**携带历史字段 `permissionMode?`（`runtimeEvents.ts:555`）与新字段 `permissionPolicy?`（`:567`，注释 "Absent = fall back to the permissionMode row"）——**wire 上就是并存的，模型层也并存**。
2. **新纯守卫 `isSessionPermissionPolicy()`**：严格按 `agent` 判别位（`runtimeEvents.ts:540-550`）并逐字段校验，**不接受 widened string**。调查 02 §1 已确认全仓零命中，需新建。放 `contextSurfaceModel.ts` 内，与既有 `isSessionPermissionMode`（`:449-451`）同处，保持「守卫跟着消费者走」。
3. **reduce 加分支**（`reduceSessionRuntimeFacts`，`:472-509`）：对 `session.created/resumed` 同时读 `permissionPolicy` 与 `permissionMode`，合法新 policy 优先，缺失/非法**不覆盖旧真值**，两个 session 互相隔离。
   > ⚠️ **N4 早退陷阱（承重）**：`:499-501` 的 `if (!isSessionPermissionMode(permissionMode)) return prev;` 会让 Codex payload（**没有 `permissionMode` 键**）在这里 return，后面加的任何 `permissionPolicy` 处理都**静默 no-op**——与 `:479-482` 的 D33 注释记载的事故同形状。**`permissionPolicy` 分支必须放在这道守卫之前**，且必须有一条断言专门钉这个顺序（§5.7-C2）。
4. **`buildRuntimeRows` 行构建**（`:213-231`）：
   - Codex：一行三值摘要 `Approval: on-request · Sandbox: workspace-write · Network: off`；**不把三维压成 Claude 枚举**。新增 `CODEX_APPROVAL_LABELS` / `CODEX_SANDBOX_LABELS`，与 `PERMISSION_MODE_LABELS`（`:171-177`）同级同风格。
   - Claude：沿用现行 `Permission policy = <mode label>`，**逐字不改**。
   - 两者都有时 `permissionPolicy` 优先（`runtimeEvents.ts:567` 的 wire 规定，照抄即可）。
   - 两字段都没报：`Permission policy not reported`，**不猜 default**。
   - 唯一 wiring 在 `ContextSurfaceView.tsx:106-108,156-205`，从 adjacent store 选择并传入。

### 5.3 L2：`capabilities.permissionPolicy` 补发（N1，白捡的降级闸门）

- `agent-host/index.ts:363-373` 的 capabilities 补 `permissionPolicy: true`（本批复验：该文件 `permissionPolicy` 零命中）。
- `hostStatus.ts:38` 的 `HostStatus.capabilities` 加 `permissionPolicy?: boolean`；**reduce（`:90-98`）与 prime（`:182-187`）两条通道都要加**——`hostStatus.ts:155-160` 的注释记录过 slice 6 的原始事故：只加一条通道，另一条静默丢字段。
- 缺失（old Host）→ 面板退回今天的 `permissionMode`-only 行为，不报错不空行。

### 5.4 L3：写侧最小形态 —— Settings「Chat agent defaults」+ Preference/Policy 双类型

**落点：已拍板（§8.0-Q1，仲裁 §4-3）—— 写侧双层，本片只做其中的模板层。**

| 层 | 管什么 | 落点 | 切片 |
|---|---|---|---|
| **模板层** | **新会话起点**：新草稿首发时采用的权限档 | `AISettings` 新增 **Chat agent defaults** 区（持久化位置照仲裁 §1：app settings 独立区、不复用终端轴 AgentSettings、不写 `~/.codex/config.toml`） | **S3（本片）** |
| **实时层** | **当前会话**：会话中途改档（Claude 下一回合 / Codex 零回合生效） | **Composer 实时权限控件**（idle-only），通道与形态见 §6 | **S4** |

**Context 面板恒只读（两层都不进它）**：该面板承载的是 **Host 回声的事实**（Policy），把可写请求塞进事实面会让同一行既是请求又是回声——B 稿标 blocker 的「preference 被当作 runtime fact」正是这个形状。A 稿 Q1 推荐 (a) 的核心关切（「**建会话当时**才是用户想设它的时刻」「为单次会话调档要去 Settings 改完再改回来」）由**实时层正面解决**：用户在 Composer 就地改当前会话，全局模板一动不动。

- **模板层为什么不进 Composer 底栏**：它是「此后所有新会话的起点」，放进每回合都看得见的位置会与实时控件语义打架（同一个 pill 到底改的是本会话还是所有新会话？）；且三个 pill 挤在 `h-6` 底栏会撑爆 `@[30rem]` 窄形态（codeg 都要折叠成 Popover，调查 03 §4）。**Composer 只放实时控件（S4），它改的恒是当前会话。**
- **两层不互相回写**：实时层改档**只影响当前会话并更新该会话快照**，**不修改模板层**（§6.3 + 断言 §6.5-D11）。这与 model/effort 的口径（§4.3「用户改 model/effort：写当前 session storage，**同时**更新该 agent 默认偏好」）**是故意的不对称**——权限是安全姿态，把一次临时提权变成此后所有新会话的默认就是静默扩权（§7-R18）。
- **不复用终端轴 `AgentSettings.tsx`**：后者管理终端/CLI `BuiltinAgentId`、custom/hapi/happy agent，复用会破坏三轴隔离（`AISettings.tsx:26-66` 的 provider/模型静态面**不得**被误当 `AgentWireName`）。

设置区按 agent 两张小卡：

**Claude Code** — Permission mode：`default / acceptEdits / dontAsk / bypassPermissions / plan`（`SessionPermissionMode`，`runtimeEvents.ts:506-511`，**冻结类型不动**）。
**不加 SDK 的第 6 值 `'auto'`**：rev.3 起理由升级——06-probes P2(b) 抄录的 `sdk.d.ts:1720` 取值注释就是 `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'` **五值**（SDK 0.3.218），与本仓冻结类型逐值一致，**当前 SDK 版本压根没有 `'auto'`**。该项由「未实证、随 S4 探针处理」改判为**明确不做**，转 §8.2-L10 遗留登记，等 SDK 真出现该值且有行为实证再议。

**Codex** — Approval policy `untrusted / on-request / never` + Sandbox mode `read-only / workspace-write / danger-full-access`。
**Network：只读 `Reported by runtime`，本片不给控件。**（**S3 终检改判**：该维度由「Host 记一个常量信念 `false`」改为「只从 `thread/start` 回声学、学不到就不报」——`SessionPermissionPolicy` 的 codex 臂 `networkAccess` 由必填放宽为**可选**，缺席即 Context 显 `Network: not reported`。理由见 §5.9.4 偏差 ⑦：S3 把 sandbox 档位变成用户可选后，`danger-full-access` 根本没有网络边界，常量 `false` 会在最危险的档位上把事实说反。) `networkAccess` **不是 `thread/start` 的请求字段**（`codexRuntime.ts:122-132`，只在响应回声里，由 `compareSandboxEcho:594-665` 校验），只能经隔离 config.toml 投影生效（`codexHome.ts:149-163`、`:173-178`、`:412`）；给了控件就要改 config.toml 写手，而 resume 姿态是从 config.toml 重派生的（`:2952-2954` H9），会波及 resume 回声校验。

**危险档 `bypassPermissions` / `danger-full-access`：已拍板（§8.0-Q3）= 给控件 + warning + 二次确认 + 绝不做默认值。** 五条硬口径，**模板层（本片）与实时层（S4）逐条同口径**，不得只在一层落实：

1. **给控件**：不给等于替用户决定他不能用，且 codeg 给了。首版不再「留空位」。
2. **warning 文案常驻**：控件旁明写风险，不靠 tooltip 藏；文案不承诺「可随时撤销」。
3. **二次确认**：从选中危险档到写入 preference 之间必须经过一次显式确认；**未确认不写入**，取消 = 值回到原档（**不是**停在危险档上的「未保存态」）。断言 C16 / D12。
4. **绝不做默认值**：`defaults.ts` 出厂值、**任何回退/降级臂**、hydration 未完成时的占位值，**均不得**是危险档（C13 由「不可能成为默认值」扩到「回退臂也不得」）。
5. **Claude 的扩权键**：下发 `bypassPermissions` 时 `query()` options 必须**同时**含 `allowDangerouslySkipPermissions: true`（06-probes P2(b)，`sdk.d.ts:1729`），否则 SDK 直接拒；其余四档**不得**出现该键（负控半边）。断言 C16 / D3。

**文案硬要求**：`Applies to new chat sessions. Existing and active sessions keep the permission posture captured when they were first sent.` 且不得与消息流中的单次 `PermissionQaCard` 混淆。

**类型分离（B §5.3 吸收，本片的类型级承重）**：

```ts
// 请求：UI 能表达的
type SessionPermissionPreference =
  | { agent: 'claude-code'; permissionMode: SessionPermissionMode }
  | { agent: 'codex'; approvalPolicy: CodexApprovalPolicy; sandboxMode: CodexSandboxMode };
// 事实：Host 回声的（已存在，含 networkAccess）
type SessionPermissionPolicy = /* runtimeEvents.ts:540-567 现状不动 */;
```

> **Preference 是请求，Policy 是事实回声。** 两者不得混用——这样类型层永远不会声称 UI 能控制 `networkAccess`（Codex preference 结构里根本没有这个键，§5.7-C8 负控断言）。

### 5.5 持久化与 create/resume 通道

**两层，不能只存全局默认**：

1. `ChatAgentDefaults.byAgent[agent].permission`（§4.3 同一 app settings 区）= 新草稿的模板。
2. **首条发送 commit 时，把该草稿采用的 preference 与 agent 一起物化为会话快照**：`session-index` 增加**可选加法**字段 `permissionPreference`（`sessionIndex.ts:1-8` 头注 + `:10-35` 接口：该文件必须保持裸 JSON 数组，加字段只能是 optional per-entry，历史行**不重写**）。resume 用会话快照，**不重新读取可能已变化的全局默认**——否则改一次 Settings 会在重启后静默改变旧会话的安全姿态（B 标 blocker）。
3. **物化前必须确认 settings 已 hydrate（与 R6 同族的第二个入口）**：app settings 走 zustand persist + 异步 IPC（`stores/settings/storage.ts` 的 `getItem/setItem` 均为 `await window.electronAPI.settings.read/write`）。冷启动后立刻发第一条消息，若此时 hydrate 未完成，捕获进 session-index 的会是 `defaults.ts` 的出厂值而非用户实际设置，**并被永久钉进快照**（resume 按设计不再纠正，正是 §5.5 的立意）——安全姿态的静默降级/升级。**口径**：未 hydrate 时**不物化**权限快照（该 session 的 `permissionPreference` 字段缺席，resume 时走 runtime 安全默认，与 old snapshot 同路径），**绝不写 defaults 冒充用户选择**；实现可选「首发路径经一次 Main 同步读取权限模板后再物化」，两者择一写死。断言 C15 + 变异 ⑪。

4. **会话快照的第二个写入点（rev.3，写入臂归 S4）**：S4 的中途改档**成功**后，同一 `permissionPreference` 字段按新值更新（resume 因此拿到用户**最后一次显式选择**）。这不违反第 2 条的立意——第 2 条防的是「**全局模板**在 resume 时倒灌旧会话」，而中途改档是**本会话内的显式选择**（同 §3.3-6「显示值 == 发送值」与 §4.6 防线 ② 的回写收敛）。S3 只需保证该字段是**可选加法、可被二次写入、历史行不重写**；写入臂与断言归 S4（§6.5-D10）。

5. **「行存在但从未捕获姿态」的分支（S3 终检补写，实况口径）**：§5.4 文案「已存在的会话保持首发时捕获的姿态」描述不到这类行——**pre-D48 老行**与 **C15 下首发时 settings 未 hydrate 的行**都没有可保持的姿态。口径**写死为「取当次模板」**：下一次 `chat:createSession` 会把**当时的**全局模板捕获进去（含危险档）。这是权衡后的选择而不是疏漏：唯一能区分「老行」与「全新行」的带内信号只有「行是否存在」，而 `chat:registerSession`（R5 D2）在侧栏出现该会话的那一刻就写了行、远早于首发——因此「只要行存在就拒绝候选」等于对**所有**会话拒绝模板，即删掉 S3 的写侧。风险边界由「捕获至多一次」封住：行一旦有姿态，任何模板都推不动它（两条断言见 §5.7-C9 扩，`chatPermissionPreferenceGuard.test.ts` 的 §5.5-5 双臂）。

**不得写**：终端轴 `AgentConfig`（key 是松散 terminal agent id）· `chatSessions.ts` 的 runtime facts（会话索引只保存「请求偏好」，不冒充实际回声）· **用户真实 `~/.codex/config.toml`**（Host 使用隔离生成文件并声明用户 posture 不继承，`codexHome.ts:123-140`；这条同时受 §1.2 运维铁律约束）。

**wire 与运行时**：

- `SessionCreateCommand.payload`（`agentHost.ts:61-77`）与 resume 命令加可选 `permissionPreference?: SessionPermissionPreference`（判别联合，agent 位自带）。
- **约束**：payload 的 preference `agent` 必须等于 `sessionAgent(session)`，不匹配在 Main/Host dispatch **之前**拒绝，不让 runtime 自己猜。首发 create 用草稿 snapshot；resume 用 session-index snapshot；两者都缺失才用 runtime 安全默认。
- Claude：`CHAT_PERMISSION_MODE`（`claudeRuntime.ts:215`）与 Codex：`CODEX_PERMISSION_DEFAULT`（`codexRuntime.ts:134-144`）**保留为默认值不删**（它们是 `:204-214` 自陈的「单一真源」，参数化的正确做法是给它一个覆盖入口，不是把常量拆了），改为「有则用、无则常量」。
  > **Claude 侧的覆盖入口有三个消费点，必须一起改**（06-probes P2 指示 2；`:204-214` 头注 "Change this constant, not either call site" 正是在防这个事故）：`query()` options（`claudeRuntime.ts:754`，**真正下发给 SDK 的那一处**）· `session.created` 回声（`:341`）· `session.resumed` 回声（`:391`）。S3 把「常量」换成「create/resume 带来的 preference」，S4 再把它升成可中途改的会话态（§6.1-2）——**两片都必须三处同喂**，漏一处即 Context 面板报的档位与实际下发漂移。断言 C11（扩）/ D1。
- Claude：session 值进 `query()` options，`session.created/resumed` 回声同一值。
- Codex：`state.policy` 与 `buildThreadStartParams` 使用它；隔离 `config.toml` 继续写 approval/sandbox 以保证 resume 重派生与 H9 回声校验一致（四处同值：thread/start · isolated config · state.policy · Context 回声）。
- Host `SessionRegistry` 增加可选 policy 存储位，create/resume 合并规则与 model/effort 同类，**但 agent 不可变**。
- `networkAccess` 不由 renderer 偏好提供；Host 继续记录/回声实际值；若输入里出现伪造的 `networkAccess`，**拒绝而不是假装已控制**。

### 5.6 S3 Happy Path

1. **Codex 读侧闭环**：Codex 会话建立 → `session.created` 带 `permissionPolicy:{agent:'codex',...}` → Context 面板出现 `Permission policy` 三值行（**今天这行整个消失**）。
2. **Claude 无回归**：打开旧 Claude 会话（只有 legacy `permissionMode`）→ Context 行输出与今天逐字一致。
3. **写侧模板**：Settings 选 Claude `plan` → 新草稿首发 → create 携带 preference → `query()` 用 plan → Host 回声 → Context 显 Plan → session-index 记下该会话快照。
4. **Codex 写侧**：Settings 选 `untrusted + read-only` → 新草稿首发 → thread/start 与隔离 config 同值 → Context 显三维事实。
5. **Codex resume**：不依赖旧 event 猜值，从隔离 config 重派生并经 H9 校验；校验成功后事实事件到达 renderer，权限行不再消失。**该「事实事件」= `session.resumed` 自带 `permissionPolicy`**（S3 终检补：原实现无条件不带该字段，冷 resume 与 live-connection resume 两条路都不带 ⇒ 任何经历过一次 app 重启的 Codex 会话，权限行退回 `not reported`，S3 读侧等于对绝大多数打开方式不存在）。校验**失败**的降级臂**不带**该字段——未验证的姿态不广播。
6. **偏好不污染事实**：用户改 Settings 默认 → 当前 active session 与所有已物化 session **姿态不变**；只有之后首次发送的新草稿采用新值。
7. **old Host**：不发 `permissionPolicy` → renderer 保留 legacy 行，不崩溃、不显示 Codex 假值。
8. 单次 `PermissionQaCard` Allow/Deny **不改** chat defaults，也不改 Context policy 行。

### 5.7 S3 确定性断言点

| # | 断言 | 形状 |
|---|---|---|
| C1 | Codex `session.created`（有 `permissionPolicy` 无 `permissionMode`）经 `reduceSessionRuntimeFacts` → facts 写入 `permissionPolicy` | reduce 真值表 |
| **C2** | **顺序钉子（N4 承重）**：同一 payload，若 `permissionPolicy` 分支被放在 `isSessionPermissionMode` 守卫**之后**，C1 必须红 | 变异对 ①（见 §5.8） |
| C3 | Claude `session.created`（有 `permissionMode` 无 `permissionPolicy`）→ 行文案与今天**逐字一致**（不许改现有输出） | 回归对照 |
| C4 | 两者都有 → `permissionPolicy` 优先（钉 `runtimeEvents.ts:567` 的 wire 规定）；非法/缺失 policy **不覆盖**旧真值；session A 不影响 B | 真值表 |
| C5 | Context 四种输出分别钉死：Claude / Codex 三值 / legacy / `not reported`（不猜 default） | 输出快照表 |
| C6 | `isSessionPermissionPolicy` 覆盖两判别分支、未知 enum、缺字段、额外 agent slug、widened string | 守卫真值表 |
| C7 | `capabilities.permissionPolicy` 在 **reduce 与 prime 两条通道**都能到达 `HostStatus`（各一例）；缺失时面板退回今天行为 | 双通道 pin（照 `hostStatus.ts:155-160` 的事故形状） |
| **C8** | **负控**：`SessionPermissionPreference` 的 Codex 分支**不存在 `networkAccess` 键**（类型级 + 面板视图模型 `writable:false`） | 类型断言 + 结构负控 |
| C9 | 首发把 preference 恰好物化一次进 session-index；resume 读会话快照，**后来修改的全局默认不生效** | 时序真值表（改 Settings 后 resume 旧会话） |
| C10 | create/resume 的 preference `agent` 必须匹配 `sessionAgent(session)`；错配在 dispatch **之前**失败 | 拒绝路径断言 |
| **C11-R** | **resume 侧同值（S3 终检补）**：`session.resumed.permissionPolicy` == `state.policy` == `ensureCodexHome` 收到的 permission（H9 姿态验证通过的那一个）；live-connection resume 复述 `session.created` 的同一值；**验证失败的降级臂不带该字段** | 三处同值 + 负控臂 |
| **C17** | **`networkAccess` 只从回声学（S3 终检补）**：`thread/start` 回声带 `networkAccess:true` → `session.created.permissionPolicy.networkAccess === true`；回声不带该键 → 该键**缺席**（不是 `false`）；Context 行相应显 `Network: not reported`；`resolveCodexPolicy` 的结果恒无该键 | 回声真值表 + 面板三态 |
| C11 | Claude：**四处同值**——`query()` options（`claudeRuntime.ts:754`）· `session.created` 回声（`:341`）· `session.resumed` 回声（`:391`）· registry 值，全部来自同一 preference（P2 的三消费点 + registry）；Codex：thread/start、isolated config、`state.policy`、Context 回声四处 approval/sandbox 同值 | 四处同值断言（H9 形状） |
| C12 | Settings 更新**不调用任何 active-session mutation IPC**；`PermissionQaCard` 响应不写 chat defaults | spy 零调用 |
| C13 | 危险档：`bypassPermissions` / `danger-full-access` 有常驻 warning 且**不可能成为默认值**——`defaults.ts` 出厂值、**每一条回退/降级臂**、hydration 未完成时的占位值**逐项枚举皆非危险档**；chat permission 不落终端轴 `agentSettings`（轴隔离静态扫描） | 设置模型真值表（含回退臂逐条枚举）+ 静态扫描 |
| **C15** | **hydration 前不物化（§5.5-3）**：settings 未 hydrate 时首发 → session-index 该行**无** `permissionPreference` 字段（或首发被显式等待到 hydrate 完成后才物化），**绝不写入 `defaults.ts` 的出厂值**；hydrate 完成后首发 → 物化的是用户实际设置 | 时序双臂 |
| **C16** | **危险档二次确认 + 扩权键（Q3 拍板的模板层半边）**：选中 `bypassPermissions` / `danger-full-access` 后**未完成二次确认前不写入** app settings（取消 → 值回原档，不留「未保存的危险态」）；采用 `bypassPermissions` 模板的会话，其 `query()` options **同时**含 `allowDangerouslySkipPermissions:true`，其余四档该键**缺席**（`in` 断言，不是 `undefined` 值） | 设置动作双臂 + options 真值表（含负控半边） |
| C14 | old Host payload 不含新字段时仍走现 compatibility path（session-index 历史行无字段 → 回退 runtime 安全默认，不重写历史行） | 兼容回归 |

### 5.8 S3 变异对（逐对实跑记红灯）

① `permissionPolicy` 分支移到 `isSessionPermissionMode` 守卫之后 → **C1/C2 红**（承重行变异）
② `buildRuntimeRows` 优先序反过来（`permissionMode` 赢）→ **C4 红**
③ prime 通道漏掉 `permissionPolicy` 键 → **C7 的 prime 臂红**
④ 给 `networkAccess` 加上写控件 / 在 Preference 类型里加该键 → **C8 红**
⑤ renderer 忽略 Codex policy（读侧不接）→ **C1/C5 投影测试红**
⑥ 把 Codex 三维压成 Claude `permissionMode` 枚举 → **C5/C6 红**
⑦ Settings 修改立即篡改 active Context（乐观写）→ **C12 红**
⑧ resume 改读全局默认而非会话快照 → **C9 红**
⑨ Codex isolated config 与 thread/start 用不同 policy → **C11 红**（H9 一致性）
⑩ 把 chat permission 存进终端 `agentSettings` → **C13 红**
⑪ settings 未 hydrate 时照写 `defaults` 的出厂值进 session-index → **C15 红**
⑫ 危险档跳过二次确认直接写入 app settings（反向：取消后仍停在危险档）→ **C16 红**（两个方向各一次实跑）
⑬ `bypassPermissions` 不发 `allowDangerouslySkipPermissions`（反向：给全部档位都发）→ **C16 红**（前者 SDK 直接拒、后者静默扩权，两个方向各一次实跑）
⑭ 某条回退/降级臂落到危险档（如 hydration 未完成时占位 `danger-full-access`）→ **C13 红**
⑮ `emitResumed` 重新无条件丢掉 `permissionPolicy`（反向：把未验证的姿态也广播）→ **C11-R 红**（两个方向各一次实跑）
⑯ `networkAccess` 改回常量信念（反向：面板把「未上报」渲染成 `off`）→ **C17 红**（两个方向各一次实跑）

---

### 5.9 S3 as-built（施工实况与规格偏差）

> 落账 2026-08-17（终检修复批收口）。按 §1.3「每片 as-built 段落必须记：git commit · 四门逐门实跑输出 · 变异逐对红灯原文 · off/on 双轮结果 · 新增/改动文件清单 · 规格偏差条目」六项补齐，格式照 §4.10。
> **施工编制**：施工两员（Host/Main 半边 + renderer/Settings 半边）→ 规格符合性终检（10 条，1 blocker / 2 major / 7 minor）→ **终检修复批**（本节全部数字、⑮/⑯ 两对新变异、C11-R/C17 两条新断言出自该批）。
> **git commit：本片尚未提交**——按用户纪律终检修复批不自行 commit，收口态为工作树 32 个变更项（清单见 §5.9.6）。

#### 5.9.1 四门逐门实跑（终检修复后，逐门串行）

| 门 | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm typecheck` | `EXIT=0`，`tsc --noEmit` 无输出 |
| 2 | `pnpm typecheck:agent-host` | `EXIT=0`，`tsc --noEmit -p src/agent-host/tsconfig.json` 无输出 |
| 3 | `pnpm lint` | `EXIT=0`，`Checked 964 files in 732ms. No fixes applied. / Found 29 warnings. / Found 3 infos.`（0 error；29 warning 全在 `docs/design/*.html`，基线既有） |
| 4 | `pnpm test` | `EXIT=0`，`Test Files 227 passed (227) / Tests 4403 passed (4403)`，Duration 19.26s |

基线链：S2 收口 **220 文件 4268 例** → 施工两员交接 **227/4392**（+7 文件 +124 例）→ **终检修复批收口 227/4403**（+11 例，无新增文件）。
终检修复批新增的 11 例分布：`codexRuntime.test.ts` +5（C11-R 双臂、C17 三例）· `contextPermissionPolicy.test.ts` +2（网络三态行、guard 可选臂/null 负控净 +1）· `chatPermissionPreferenceGuard.test.ts` +2（§5.5-5 双臂）· `composerPermissionWiring.test.ts` +1（store 休眠 create 负控）· `sessionPermissionSnapshot.test.ts` ±0（空壳用例就地改写为真断言）· `compareSandboxEcho` 组 +2 −1（学习/未上报/二次回声矛盾三例换掉原「server default」一例）。

#### 5.9.2 flag off/on 双轮

| 轮次 | 结果 |
|---|---|
| `AICLIENT_AGENT_CODEX` 未设（off） | `Test Files 227 passed (227) / Tests 4403 passed (4403)` |
| `AICLIENT_AGENT_CODEX=1`（on） | `Test Files 227 passed (227) / Tests 4403 passed (4403)` |

两轮逐例相同 —— §1.1-4「renderer/store 形状不得因 flag 分叉」在测试面成立；S3 的写侧模板与读侧补链**均不受 flag 控制**（flag 只管 Codex 能否被 spawn，不管 store 形状与渲染分支）。

#### 5.9.3 既有非 hermetic 红（**非本批引入**，不计入收口）

`AICLIENT_MANAGED_CREDENTIALS=1` 下：`Test Files 4 failed | 223 passed (227) / Tests 15 failed | 4388 passed (4403)`。

落点与 §4.10.3 **逐文件逐例完全一致**（4 文件 15 例）：`main/services/auth/__tests__/index.test.ts`（1）· `onboarding/__tests__/OnboardingService.test.ts`（6）· `session/__tests__/SessionManager.test.ts`（2）· `usage/__tests__/UsageService.test.ts`（6）。零例落在 D48 S3 改动面，判定沿用 S2：既有夹具非 hermetic 缺陷（读环境变量而非注入），留独立票。

#### 5.9.4 规格偏差清单

**A · 施工两员自报（6 条，由终检核实）**

1. **`SessionPermissionMode` 由手写联合改为 const 数组派生**。§5.4 写「冻结类型不动」，实况是 `SESSION_PERMISSION_MODES` const 数组 + `type = (typeof …)[number]`。**词表逐值未变**（仍是 SDK 0.3.218 的五值），改动理由是请求侧现在必须**运行时校验**一个不可信值：`isSessionPermissionMode` 住在 renderer，Host 需要自己的读法，而第二份手写副本正是 wire 与校验器对 `dontAsk` 各说各话的经典入口。判定：**非违规**，是「冻结的是词表不是写法」。
2. **`readSessionPermissionPreference` 以入参形式接收两个 agent 常量，而非 import**。`shared/types/runtimeEvents.ts` 不 import `agentWire.ts`（strip-types 环境下会把类型模块拖进运行时依赖），故签名为 `(value, agents: {claudeCode, codex})`。代码里有解释，规格里没有，补记于此。
3. **`isSessionPermissionPolicy` 落在 `contextSurfaceModel.ts` 内为 module-private**。§5.2-2 只写「放 `contextSurfaceModel.ts` 内」，未写导出与否；实况不导出（守卫跟着唯一消费者走），因此 **C6 的真值表改由 reducer 间接钉**（合法值写进 facts / 非法值 `toBe(prev)`），比直接调守卫更贴近它承重的位置。
4. **`capabilities.permissionPolicy` 通到 `HostStatus` 但零消费者**：面板实际是按字段有无降级的。C7 仍钉两条通道（reduce + prime），本片只把该 bit 的**措辞收窄**（见 D-4）。登记为 §8.2-L14。
5. **create/resume 的 preference 判据在 Main 与 Host 各拦一次**：§5.7-C10 只写了 Host 侧。实况是 Main（`chat.ts` `resolveSessionPermissionPreference`）在 `recordCreated` **之前**拒绝，Host（`index.ts`）在 dispatch 时第二次拒绝。两道都要：Main 那道保证被拒的姿态**不会先落成索引行**，Host 那道保证从任何入口调 runtime 都安全。
6. **隔离 codex home 单目录并发写**：代码注释自陈「registered as a leftover」而 §8.2 当时没有该条。已补 **§8.2-L13**（并把注释改为指名 `§8.2-L13`，不让代码单方面声称已登记）。

**B · 终检核查新增（4 条，两员未自报）**

1. **`session.resumed` 从不带 `permissionPolicy`（BLOCKER，已修）**——详见 D-1。
2. **`Network: on/off` 渲染的是硬编码信念（MAJOR，已修）**——详见 D-2。
3. **`chatSessions.ts` 的第二条 create 派发点不带姿态**（也不带 model/effort，S2 起如此）。判定：**休眠 API，不修**。全 renderer 无非测试调用方（`.sendMessage(` 零命中），活的发送路径是 `ChatComposer` 自己那条。处置 = 把 `composerPermissionWiring.test.ts` 的用例名限定到 `ChatComposer.tsx`，并新增一条负控：store 那条 payload **不含** posture/model/effort，**且**全 renderer 无调用方——任何一天出现调用方，这条断言先红。红线文件 `chatSessions.ts` 因此**一字未动**。
4. **`capabilities.permissionPolicy` 的措辞过宽（已修）**：`index.ts` 与 `hostStatus.ts` 原注释均称「this Host normalizes **per-agent** permission facts into `SessionPermissionPolicy`」，而 Claude 轴按 §5.2 逐字不改、只发 legacy `permissionMode`、永远不发 policy。措辞已收窄为「**Codex 轴**发 policy + **两轴**收 preference」，并明写「不得据此等一个永远不来的 Claude policy」。

**C · 终检修复批新增（4 条）**

1. **`session.resumed` 不带 `permissionPolicy`（BLOCKER，已修）**。`emitResumed` 原注释自陈「reporting the constant here would state a posture instead of the verified one」——推理对、结论差一步：调用它时 `assertResumePosture` 已经抛过了，除非线程正是按 `state.policy` 回来的，所以**那一刻 `state.policy` 就是被验证过的姿态**。后果是 `reduceSessionRuntimeFacts` 收到一个两个载体都没有的 payload → `return prev` → **任何经历过一次 app 重启的 Codex 会话，权限行恒显 `Permission policy not reported`**，即 S3 读侧对绝大多数打开方式等于不存在（直接违反 §5.6-5 与 §9.2）。修法：`emitResumed` 增可选 `permissionPolicy` 入参；**冷 resume 走 `assertResumePosture` 之后传 `state.policy`**，**live-connection resume 传 `state.policy`**（该进程的姿态在 create 或冷 resume 时已验证过，`thread/turns/list` 不回声姿态，故是复述不是复验），**失败降级臂不传**（未验证不广播）。**revive 路仍一个事件都不发**：它按 `resolveCodexPolicy(registry.permissionPreference)` 重开、`reopenThread` 的 `assertResumePosture` 会拒掉任何别的姿态，所以 renderer 手里的事实跨 revive 仍为真——已在该函数头注写明。新增断言 C11-R（三处同值 + 负控臂）与变异 ⑮ 两臂。**这正是 §7-R14 预判过的风险**（「resume 不发 Codex policy，权限行再次消失」，major，缓解写的就是「H9 校验成功后补事实事件（§5.6-5）」），施工时缓解措施漏落、且被一条**只喂合成 payload 的 reducer 用例**（`contextPermissionPolicy.test.ts` 的「a session.resumed carries the policy on the same path as session.created」）掩盖成有覆盖的样子——**有断言、无生产者**的同名空壳。该用例已就地加注指回 Host 侧的真生产者断言。
2. **`networkAccess` 是硬编码信念而非事实（MAJOR，已修）**。原链路：`CODEX_PERMISSION_DEFAULT.networkAccess = false` → `resolveCodexPolicy` 显式从常量取 → `compareSandboxEcho` 发现回声不一致只打 WARN、**从不回写** → `session.created` 照发 → 面板渲染 `Network: off`。而 06-probes P1/P3 实测报文里 workspaceWrite 线程的服务端回答是 `networkAccess: true`；S3 又把 sandbox 档位变成用户可选，`danger-full-access` **根本没有网络边界**，于是最危险的档位上必然把事实说反。修法（三处一致）：① `SessionPermissionPolicy` 的 codex 臂 `networkAccess` **由必填放宽为可选**（"没说" 是第三态，`false` 不是它）；② 常量与 `resolveCodexPolicy` **不再携带该维度**，`compareSandboxEcho` 返回 `SandboxEchoReading{verdict, detail, networkAccess?}`，`startThread` 在 emit **之前**把学到的值并入 `state.policy`（比较臂仍在：只有「已学到的值被第二次回声推翻」才算 mismatch）；③ 面板三态渲染 `on / off / not reported`，reducer 守卫接受**缺席**但仍拒绝**非布尔**。新增断言 C17 与变异 ⑯ 两臂。
3. **「行存在但从未捕获姿态」的分支无口径（minor，已写死 + 加断言）**。`chat.ts` 的「行内已捕获姿态优先」只保护已捕获过的行；pre-D48 老行与 C15 未 hydrate 行会在下一次 `chat:createSession` 捕获**当时的**模板（含危险档）。评审建议的收紧案（只有 `entry === undefined` 才收候选）**经核实不可行**：`chat:registerSession`（R5 D2）在侧栏出现会话的那一刻就写了行、远早于首发，该规则会对**所有**会话拒绝模板 = 删掉 S3 写侧。故取「写死 + 钉住」：口径入 §5.5-5，`chat.ts` 注释写明为什么不是疏漏，并加 §5.5-5 双臂断言（老行 + 危险档模板 → 捕获；已捕获行 + 反向模板 → 推不动）。
4. **§5.5-4「快照第二写入点」原是空壳用例（minor，已改写）**。原用例名「the field is re-writable, which is what S4 needs」，断言只有「值还等于 PLAN」+「`Object.isFrozen === false`」，一次二次写入都没发生；而实况是 `recordCreated` first-write-wins、`recordResumed` 只保留，**现有 API 无任何一条能改写该字段**。改写为真断言：拿不同姿态再跑一遍 `recordCreated` + 一次 `recordResumed`，钉「姿态不动、而 `model`/`runtimeIdentity` 确实动了」（证明这是姿态的性质不是整行冻结），再加一条 **S4 前置**断言——该 service 原型上没有任何 `/permission/i` 方法，S4 必须自带写入口。

**D · 判定为不成立、未改（1 条，附证据）**

- **「中文界面权限下拉会中英混排」——不成立**。评审称 `'Plan'` 与 `'Default'` 两个选项标签在 `zhTranslations` 无词条、`t()` 回落英文。实测两条都在：`src/shared/i18n.ts:189` `Default: '默认'`（对象简写键形式），`:1806` `Plan: '规划模式'`（同为简写键，与新增块同批）。`grep -n "^  Plan:\|^  Default:"` 双命中，全表各仅一处、无重复键。故下拉五项在中文界面全中文，无需补词条；评审很可能是按 `'Plan':` 引号形式检索而漏掉简写键。

#### 5.9.5 变异逐对红灯表

> 口径同 §4.10.5：逐对实跑，红灯抄失败用例名 + 计数。**变异施加与还原一律经 python 精确字符串替换（`/tmp/d48s3_mutate.py`：施加 → 跑子集 → 无条件还原原始字节），禁 `git checkout`。**

| 编号 | 变异内容 | 红灯 | 计数 |
|---|---|---|---|
| ① | `permissionPolicy` 分支移到 `isSessionPermissionMode` 守卫之后 | `C1 — a Codex session.created writes permissionPolicy, with no permissionMode anywhere in sight` / `C2 — the policy is read BEFORE the permissionMode guard, in behaviour and in source order` / `C4 ×2` / `a session.resumed carries the policy on the same path as session.created` / C6 accepts 组 6 例 | **11 红**（`Tests 11 failed \| 23 passed (34)`） |
| ② | `permissionRowValue` 优先序反过来（`permissionMode` 赢） | `the Permission policy row (C3/C5) > C4 — the policy wins over the legacy field when both are present` | **1 红**（`1 failed \| 33 passed (34)`） |
| ③ | prime 通道漏掉 `permissionPolicy` 键 | `capabilities.permissionPolicy — both channels (D48 S3, C7) > the prime channel carries it` | **1 红**（`1 failed \| 32 passed (33)`） |
| ④ | Preference 守卫不再拒绝伪造的 `networkAccess` | `C8 — refuses a Codex preference that claims to set networkAccess` / `C8 — a forged networkAccess claim is refused, not silently stripped` / `resolveCodexPolicy … degrades to the constant for absent, malformed, cross-agent and forged input` | **3 红**（`3 failed \| 240 passed (243)`） |
| ⑤ | renderer 读侧不接 Codex policy（`permissionPolicy` 恒 undefined） | C1/C2/C4 四例 + `a session.resumed carries the policy…` + C6 accepts 组 6 例 | **12 红**（`12 failed \| 31 passed (43)`） |
| ⑥ | 把 Codex 三维压成 Claude `permissionMode` 枚举 | `C5 — a Codex policy renders all three dimensions, never a Claude enum` / `C5 — networkAccess true and the dangerous sandbox are reported verbatim, not softened` / `C5 — an unreported network dimension says so, it does not resolve to off` / `C5 — a Codex session with only the policy still gets a row` | **4 红**（`4 failed \| 30 passed (34)`） |
| ⑦ | Settings 提交时顺手打一发 `chat.createSession`（乐观写活动会话） | `C8 / C12 — negative controls > C12 — the write side cannot reach a session: no IPC surface is imported at all` | **1 红**（`1 failed \| 18 passed (19)`） |
| ⑧a | create：模板反超快照（`candidate ?? captured`） | `a re-create after a Settings edit still runs under the captured tier` / `§5.5-5 — and once that row HAS a posture, the same second create cannot move it` + C10 四例 | **6 红**（`6 failed \| 8 passed (14)`） |
| ⑧b | resume 改吃 renderer 送来的模板 | `C9 — the snapshot outranks the template > resume takes the tier off the row and offers the renderer no way to supply one` | **1 红**（`1 failed \| 13 passed (14)`） |
| ⑨ | 隔离 config 写常量、`thread/start` 写请求（两载体分叉） | `C11 — thread/start, the isolated config, the created echo and the registry agree` / `C11 resume — session.resumed carries the VERIFIED posture, the same one the isolated home got` / `carries the posture across an idle sweep and back` | **3 红**（`3 failed \| 215 passed (218)`） |
| ⑩a | 只在注释里写 `agentSettings` | **首轮存活**（C13 轴隔离扫描走 `stripComments`，注释不算代码——**这是对的**）→ 换可执行形态 | 0 红 |
| ⑩b | `commit` 里真写 `useSettingsStore.setState({ agentSettings: … })` | `chat permission never lands on the terminal axis (axis isolation, static)` / `C12 — the only store this panel writes is app settings` | **2 红**（`2 failed \| 17 passed (19)`） |
| ⑪ | 删 `resolveDraftPermissionPreference` 的 hydration 闸 | `C15 — an unhydrated first send materialises nothing at all` / `C15 — an unhydrated first send materialises nothing, so nothing is pinned` | **2 红**（`2 failed \| 32 passed (34)`） |
| ⑫a | 危险档跳过二次确认直接 apply | `a dangerous tier is held, not written` / `the CANCEL arm leaves app settings untouched…` / `the CONFIRM arm writes exactly the held tier…` | **3 红**（`3 failed \| 16 passed (19)`） |
| ⑫b | 反向：Cancel 按钮也提交（取消后仍落危险档） | `the component routes EVERY selection through the gate — there is no direct write path` | **1 红**（`1 failed \| 18 passed (19)`） |
| ⑬a | `bypassPermissions` 不发 `allowDangerouslySkipPermissions` | `sends allowDangerouslySkipPermissions with bypassPermissions` | **1 红**（`1 failed \| 20 passed (21)`） |
| ⑬b | 反向：全部档位都发该键 | `omits the key entirely for every other tier (negative half)` / `the default session (no preference at all) never carries the key` | **2 红**（`2 failed \| 8 passed (10)`） |
| ⑭ | 回退臂落到危险档（`MOST_RESTRICTIVE_SANDBOX` 改 `danger-full-access`） | `every non-user-chosen arm is enumerated by name, and none of them is dangerous` / `the Codex companion dimension fills in the most restrictive value, not the most convenient` | **2 红**（`2 failed \| 17 passed (19)`） |
| **⑮a** | **`session.resumed` 重新无条件丢掉 `permissionPolicy`** | `emits resumed then history then idle, with the replayed transcript in full` / `reads with thread/turns/list, spawns nothing, and keeps the link` / `C11 resume — session.resumed carries the VERIFIED posture…` | **3 红**（`3 failed \| 215 passed (218)`） |
| **⑮b** | **反向：广播一个没验证过的姿态（冷 resume 传 `never`+`danger-full-access`）** | `emits resumed then history then idle, with the replayed transcript in full` / `C11 resume — session.resumed carries the VERIFIED posture…` | **2 红**（`2 failed \| 216 passed (218)`） |
| **⑯a** | **`networkAccess` 改回常量信念（`state.policy.networkAccess = false`）** | `the reported networkAccess is the echoed one, never a constant (S3 terminal check)` / `omits the dimension entirely when the runtime did not report it` | **2 红**（`2 failed \| 250 passed (252)`） |
| **⑯b** | **反向：面板把「未上报」渲染成 `off`** | `C5 — an unreported network dimension says so, it does not resolve to off` | **1 红**（`1 failed \| 33 passed (34)`） |

**⑩ 的首轮存活值得单记**：它不是漏网，而是断言正确地区分了「注释里提到」与「代码真写」——`code(file)` 走 `stripComments`，所以只有可执行形态才算变异。换形态后 2 红，且第二条红灯（`C12 — the only store this panel writes is app settings`）证明轴隔离与单写者两道闸互为补充。

#### 5.9.6 改动/新增文件清单（`src/` 工作树 32 项 = 新增 9 + 修改 23；本规格文档 §5.9 落账为第 33 项）

**新增（9）**

- renderer 实现 2：`components/settings/chatPermissionDefaults.ts`（模板层纯模型：选项表 · 危险档判定 · 二次确认动作 · 回退臂枚举 `NON_USER_CHOSEN_TEMPLATE_ARMS`）· `components/settings/ChatAgentDefaultsSection.tsx`（两张卡 + 常驻 warning + AlertDialog 二次确认）
- 测试 7：`components/settings/__tests__/chatPermissionDefaults.test.ts` · `components/workspace-shell/surfaces/__tests__/contextPermissionPolicy.test.ts` · `components/chat/__tests__/composerPermissionWiring.test.ts` · `shared/types/__tests__/sessionPermissionPreference.test.ts` · `agent-host/__tests__/claudeRuntimePermissionPreference.test.ts` · `main/ipc/__tests__/chatPermissionPreferenceGuard.test.ts` · `main/services/chat/__tests__/sessionPermissionSnapshot.test.ts`

**修改（23）**

- shared（5）：`types/runtimeEvents.ts`（Preference 判别联合 + 三个读取器 + `isDangerousPermissionPreference` + policy 的 `networkAccess` 转可选）· `types/agentHost.ts`（create/resume payload 加可选 `permissionPreference`）· `types/sessionIndex.ts`（行内可选 `permissionPreference`）· `models/chatAgentDefaults.ts`（`permission` 字段 + `agentDefaultPermission` / `withAgentPreference` / `resolveDraftPermissionPreference`）· `i18n.ts`（zh 词条）
- agent-host（4）：`codexRuntime.ts`（`resolveCodexPolicy` · policy 入 `openConnection` · 回声学 `networkAccess` · `emitResumed` 带已验证姿态）· `claudeRuntime.ts`（三消费点同喂 + `dangerousSkipPermissionsOption`）· `sessionRegistry.ts`（可选 preference 存储位与 create/resume 合并语义）· `index.ts`（dispatch 侧 C10 拒绝 + `capabilities.permissionPolicy`）
- Main / preload（3）：`main/ipc/chat.ts`（`resolveSessionPermissionPreference` 三规则 + create/resume 两入口）· `main/services/chat/SessionIndexService.ts`（快照字段 first-write-wins）· `preload/index.ts`（两条 payload 加可选键）
- renderer（5）：`components/workspace-shell/surfaces/contextSurfaceModel.ts`（facts 加字段 · 严格守卫 · N4 顺序 · 三值行 + 网络三态）· `.../ContextSurfaceView.tsx`（选择并传入，恒只读）· `components/chat/hostStatus.ts`（reduce + prime 两通道）· `components/chat/ChatComposer.tsx`（首发解析模板并条件展开）· `components/settings/AISettings.tsx`（挂载新区块）
- 测试（6）：`agent-host/__tests__/codexRuntime.test.ts` · `agent-host/__tests__/protocolErrors.test.ts` · `main/ipc/__tests__/chatSpawnGate.test.ts` · `main/ipc/__tests__/chatTrust.test.ts` · `renderer/components/chat/__tests__/hostStatus.test.ts` · `shared/__tests__/chatAgentDefaults.test.ts`

**红线文件零触碰**：`src/renderer/stores/chatSessions.ts` 全片一字未动（`git status` 无该项），三轴隔离亦无破口（终端轴 `AgentSettings.tsx` / `AgentPickerMenu` / `SessionBar` 均未出现在清单里，并由 C13 静态扫描反向钉住）。

**终检修复批实际触碰（13）**：`shared/types/runtimeEvents.ts` · `agent-host/codexRuntime.ts` · `agent-host/index.ts`（capability 措辞收窄）· `renderer/components/chat/hostStatus.ts`（同上）· `renderer/.../contextSurfaceModel.ts` · `main/ipc/chat.ts`（§5.5-5 分支注释）· `agent-host/__tests__/codexRuntime.test.ts` · `renderer/.../__tests__/contextPermissionPolicy.test.ts` · `main/ipc/__tests__/chatPermissionPreferenceGuard.test.ts` · `main/services/chat/__tests__/sessionPermissionSnapshot.test.ts` · `renderer/components/chat/__tests__/composerPermissionWiring.test.ts` · `shared/types/__tests__/sessionPermissionPreference.test.ts` · `agent-host/__tests__/claudeRuntimePermissionPreference.test.ts`（后两项为中英混排的两处引用改纯英文，CLAUDE.md 注释语言条）

---

## §6 S4 — 会话中途改权限档（**正式切片**，rev.3 升格）

> **rev.3 状态变更**：Q1 拍板「中途改权限档 = 必做」（仲裁 §4-3），本片由条件切片升为**正式切片**；两条通道已由 [06-probes](./2026-08-16-agent-picker-investigation/06-probes.md) 实证成立（P2 Claude / P3 Codex），**「探针不过就不做」的臂已全部删除**。rev.2 的 §6.1/§6.2「探什么 / 过的判据 / 不过怎么办」整段作废——探针结论见 06-probes，本节写的是**施工形状**。
> **依赖 = S3**：preference 判别联合类型、会话快照字段、`capabilities.permissionPolicy` 能力闸门、Codex 读侧闭环都在 S3 落地；本片只加「中途改」这一层。
> **本片仍单列的理由**（不是条件性）：它是唯一一片要动 `CODEX_METHOD` 方法表、把 `CHAT_PERMISSION_MODE` 常量升成会话态、并新增一条设置回声订阅的切片。
> 真机点验（两轴各一次 idle 改档）仍受 §1.2 运维铁律约束：事前报测试项与预计用量、最小 payload、只读优先、不碰本地 `~/.claude` / `~/.codex` 与开发服务器 env。

### 6.1 Claude 通道 = per-turn `query()` options（P2 实证）

**通道形状**：Claude 轴**每发一条消息都新开一个 `query()`**（`claudeRuntime.ts:513` 取 `queryFn`——`ensureSdk` 只缓存函数引用不缓存会话；`:735` 在 `send()` 函数体内新建 stream；`:952-967` finally 关流；跨回合连续性靠 `options.resume`），而 `permissionMode` 是 `query()` 的 options 字段（`sdk.d.ts:1720`，落在 `Options` 体内）。→ **中途改档与 D40 的 model 完全同形状：下一发 send 带上新档即可。**

1. **不引入 `setPermissionMode`、不改 streaming-input、不动 `canUseTool` 桥**：`Query.setPermissionMode()`（`sdk.d.ts:2281`）注释明写 "Only available in streaming input mode."，而我们的 prompt 在无附件时是**字符串**（`claudeRuntime.ts:706-708` 三元），大多数回合根本不满足该前提。回合进行中的实时管控仍由既有 `canUseTool` 权限卡承担（`:563-574`）——**单次审批与档位管理是两件事，不重叠、不互相实现**。rev.2 §6.1 的「扩权红线：若必须全改 streaming-input 需单独拍板」随之作废（§8.2-L7）。
2. **改造量 = 把常量升成会话态，三个消费点必须一起改**：`CHAT_PERMISSION_MODE`（`claudeRuntime.ts:215`）→ `session.permissionMode`（缺省仍取该常量，常量**不删**）。三处（P2 指示 2；`:204-214` 头注 "Change this constant, not either call site" 就是在防这个事故）：
   - `:754` — `permissionMode: CHAT_PERMISSION_MODE` 的 `query()` options（**真正下发给 SDK 的那一处**）；
   - `:341` — `session.created` 回声；
   - `:391` — `session.resumed` 回声。
   漏改任一处 = **Context 面板报的档位与实际下发的档位漂移**（谎报安全姿态）。断言 D1、变异 ①。
3. **生效时机 = 下一个回合边界**：改档**不影响 in-flight 回合**（那个 `query()` 的 options 在创建时已定型，不得为改档去重建 stream 或中断回合）。**UI 文案统一写「下一条消息起生效」，不得对 Claude 轴承诺「立即生效」**——与 Codex 轴的零回合语义不同轴，两轴文案不共用。断言 D2、变异 ②。
4. **危险档扩权键**：`bypassPermissions` 下发时 options 必须**同时**含 `allowDangerouslySkipPermissions: true`（`sdk.d.ts:1729`），否则 SDK 直接拒；其余四档**不得**出现该键。与 §5.4 危险档口径 5 是同一条，两层各有断言。断言 D3、变异 ③。
5. **`'auto'` 明确不做**：P2 抄录的 SDK 0.3.218 取值注释是五值，无 `'auto'`（§5.4 已改判 → §8.2-L10）。

### 6.2 Codex 通道 = `thread/settings/update`（P3 实证）

**通道形状**：方法真实存在（不是 method not found）、**零回合成本**（线程空闲时可调、不消耗模型回合）、响应体是空的（实测 `null`/`{}`，**不带任何回声**），但会立刻广播一条**全量** `thread/settings/updated`；实测「没有任何 turn 的情况下改掉 model + effort + approvalPolicy，随后那一回合的 `turn_context` 三项全按新值执行，未提及的 `sandbox_policy` 原样保留」。

1. **不为改档去凑 `turn/start`**：P1 顺带实证 `turn/start` 覆盖 `approvalPolicy`/`sandboxPolicy` 同样合法且 sticky，但那要求用户**必须同时发一条消息**才能改档。**实时控件走 `thread/settings/update`（零回合）**；「改档并同时发消息合并进一次 `turn/start` 省一次往返」是可选优化，**不是首版形状**（→ §8.2-L11）。
2. **省略即不变**：`ThreadSettingsUpdateParams` 唯一必填 `threadId`，其余字段全部 nullable——**省略 = 不变，显式 `null` = 清除**（06 §0.2 的字段表已采全）。→ 参数构造**只带用户本次改动的键**，不做「全量重发」（全量重发会把 UI 没有真源的字段一起钉死）。断言 D4。
3. **未知字段静默吞（承重坑，必须用类型 + 单测兜住）**：P1 严格性实测——坏枚举 `-32600` 拒、缺 `threadId` `-32600` 拒，但**未知字段返回 `{}`、无通知、无副作用**。**拼错字段名不会报错，只会悄无声息地不生效**，且在测试里完全不可见。→ 参数构造走**白名单常量**（只允许 schema 明示且实测过的键），配一条单测钉「白名单外的键在类型层构造不出来 + 报文里零出现」。断言 D4、变异 ④。
4. **形状映射：三处不可互抄**——`thread/start` 用 `sandbox`（`SandboxMode` 字符串枚举，kebab-case `read-only` / `workspace-write` / `danger-full-access`）；`turn/start` 与 `thread/settings/update` 用 `sandboxPolicy`（判别联合对象，camelCase `readOnly` / `workspaceWrite` / `dangerFullAccess` / `externalSandbox`）。仓内现有 `CODEX_PERMISSION_DEFAULT`（`codexRuntime.ts:134`，`on-request` + `workspace-write`）是 **thread/start 形状，不能直接喂给 settings/update**，须过一层显式映射纯模块并配静态断言。断言 D5、变异 ⑤。
5. **`permissions` 与 `sandboxPolicy` 互斥**（schema 自述 "Cannot be combined with `sandboxPolicy`"）。D48 首版**不引入命名权限 profile**（§9.1 已列不做），但构造层仍要有二选一守卫——服务端对冲突/未知字段同样静默吞，不会替我们报错。断言 D6。
6. **回声唯一来源 = `thread/settings/updated` 通知**：响应体空 ⇒ **「请求成功」不等于「已生效」**，不得据此更新 UI 或 facts。一条通知带全量 13 项设置，Host 侧**一次映射**即可同时刷新模型标签与权限档标签，**不为两个控件各写一条回声路径**（S2 的 model 回写消费同一条，§4.6 防线 ②）。断言 D7、变异 ⑦。
   > **as-built 改判（§6.7.4-A-4）**：模型那半边 S4 未落（renderer 没有 reader），`model` 字段已从 payload 移除，`thread/settings/updated` 的模型值只写 registry。回声事件本身升为**两轴共用**——Claude 轴也发它（§6.7.4-A-2）。
7. **idle-only 下发**：P3 实测竞态——`turn/start` 刚发出后 1ms 打 settings/update，那一回合的 `turn_context` 已定型，表现为「**改了但这一回合没生效**」。→ 控件在 active turn 时 disabled，**且 runtime 侧再拦一次**（UI 闸门不是安全边界），失败即失败、**不排队**（不引入权限 mutation queue）。断言 D8、变异 ⑧。
   > **as-built 补臂（§6.7.4-A-1）**：`idle` 还有第三态——被 idle sweeper 收走进程、只剩 registry 行的会话（默认 180s，属常态而非边缘）。该臂**不 spawn 也不拒绝**：写行 + `next_turn` ACK + 一条陈述已被 `assertResumePosture` 强制的姿态的回声。
8. **扩 `CODEX_METHOD` 前先落 contract fixture**：`codexWire.ts:85-96` 今天是十方法、不含它；`codex-method-contract.json` 记 121 条而同版二进制 126 条（06 §0.1，差集 5 条为**纯欠采**、无一条消失，`thread/settings/update` 在 experimental 与非 experimental 两版里都在）。→ **先提交 fixture（顺手补齐 5 条欠采），再扩方法表**。断言 D14、变异 ⑭。

### 6.3 写侧 UI = Composer 实时权限控件（实时层）

**落点**：Composer 底栏，与 `modelEffortControls` 同族的 ghost chip + 菜单（形制照 §3.1 的 ghost chip 规则与 `composerModelTriggerClass()`，**不新造第二种形制**，高度/内距可交叉断言）。**Settings 模板层（§5.4）不变**：一个管新会话起点，一个管当前会话。

- **闸门 = idle-only，与 agent picker 的 `locked` 是两套，不得复用**：agent 绑定首发即锁死（换 agent 等于另开会话）；**权限档在已锁定会话里照样可改**——那正是 Q1 拍板的需求本体。控件闸门 = `busy || sending || Host 非 ready || capabilities 未报 permissionPolicy`，**判据里不出现 `agentBindingLocked`**。断言 D13、变异 ⑬。
- **两轴文案不同轴**：Claude =「下一条消息起生效」；Codex =「立即生效（当前线程）」。**不共用一句话**，也不把 Claude 的延迟语义粉饰成即时。
- **危险档（Q3 拍板的实时层半边）**：给控件 + 常驻 warning + **二次确认**（未确认前 **runtime command 零调用**，取消回原档）+ **绝不做默认/回退值**。断言 D12、变异 ⑫。
- **改档成功后做三件事、且只做三件**：① 更新 runtime facts —— **经回声，不乐观写**（Codex 等 `thread/settings/updated`；Claude 等下一回合的 `session.created/resumed` 回声 —— **as-built 改判（§6.7.4-A-2）**：这两个事件每次 Host 会话只发一次，实测无法承载改档后的回声，故 Claude 轴改为在 `send()` 把 `permissionMode` 交给 `query()` 的那一刻发 `session.settingsEcho`）；② 更新该会话的 `permissionPreference` 快照（§5.5-4），使重启 resume 拿到用户最后一次显式选择；③ **不修改 `ChatAgentDefaults.byAgent[agent].permission` 模板**——与 model/effort 的回写口径**故意不对称**（§5.4），一次临时提权不得变成此后所有新会话的默认。断言 D10 / D11，变异 ⑩⑪。
- **失败 = 保持旧事实**：协议 error（`-32600` 坏枚举 / 缺 `threadId`、SDK 拒扩权键）必须冒泡为**可判定的失败态**，控件回滚旧值 + inline 提示，**Context 面板一格不动**，不自动重试。断言 D9、变异 ⑨。
  > as-built：控件没有可回滚的本地值（chip 派生自 facts），义务全在 inline 那一半——走 `useChatSessionsStore.lastError`，与 `AGENT_UNAVAILABLE_SEND_ERROR` 同一条状态行（§6.7.4-B-6）。
- **能力闸门复用 S3 的 `capabilities.permissionPolicy`**（N1 补发的那把闸）：old Host 不报该键 → **不渲染实时控件**（不是渲染一个禁用的空壳），Settings 模板层与 S3 读侧行为逐字不变。断言 D15、变异 ⑮。
  > 与 §3.4 的「不可用 agent 置灰而非隐藏」**不冲突**：那条针对的是「我们有、但当前 Host 缺凭据/未开 flag」的能力；old Host 的实时改档是**协议上根本不存在**的能力，渲染一个永远点不动的权限控件才是关于产品的谎言（`composerModel.ts:91-101`）。

### 6.4 S4 Happy Path

1. **Claude 中途改档**：已发过两轮的 Claude 会话（idle）→ Composer 权限控件选 `plan` → 写会话态 + 更新会话快照 → 提示「下一条消息起生效」→ 用户发第 3 条 → `query()` options 带 `permissionMode:'plan'`，`session.created/resumed` 回声同值 → Context 面板显示 Plan。
2. **Codex 中途改档（零回合）**：idle 的 Codex 会话 → 选 `never` + `read-only` → `thread/settings/update` **只带 `approvalPolicy`/`sandboxPolicy` 两键** → 响应 `null` → **等** `thread/settings/updated` 全量通知到达 → 才刷新 facts 与控件显示 → 下一回合 `turn_context` 按新档跑。
3. **危险档**：选 `danger-full-access` → warning + 二次确认 → **取消** → 值回原档、**IPC 零调用**；再选一次并确认 → 下发。Claude 侧选 `bypassPermissions` 并确认 → options 同时带 `allowDangerouslySkipPermissions:true`。
4. **busy 臂**：回合进行中控件 disabled；即使绕过 UI 直调 runtime command 也被拒（idle-only 在 runtime 侧再拦一次），**不排队、不延迟执行**。
5. **失败臂**：坏枚举被 `-32600` 拒 → 控件回滚旧值 + inline 错误 → Context 不变 → 不重试；Claude 侧 SDK 拒扩权键同形状。
6. **重启后**：会话快照记的是**最后一次成功改档**的值 → resume 用它，不被 Settings 模板倒灌（C9 的形状，值来源换成 S4 的写入）。
7. **old Host**：`capabilities.permissionPolicy` 缺席 → 实时控件不渲染；Settings 模板层与 S3 读侧行为不变、不报错。
8. **模板不受污染**：中途把当前会话改成 `dontAsk` → 新建下一个草稿 → 仍取 Settings 模板的值（**不是** `dontAsk`）。

### 6.5 S4 确定性断言点

| # | 断言 | 形状 |
|---|---|---|
| **D1** | **三消费点同喂（P2 承重）**：改档后 `query()` options（`:754`）· `session.created`（`:341`）· `session.resumed`（`:391`）三处取到**同一个** `session.permissionMode`；任一处仍读 `CHAT_PERMISSION_MODE` 常量即红 | 三点同值断言（Host 单测） |
| **D2** | **Claude 生效时机 = 下一回合**：in-flight 回合中改档 → 当前 `query()` 的 options **不变**（不重建 stream、不中断回合）；下一发 send 的 options 才带新值；文案常量为「下一条消息起生效」，Codex 轴文案与之**不同串** | 时序双臂 + 文案常量断言 |
| **D3** | **Claude 危险档扩权键**：preference = `bypassPermissions` → options **同时**含 `allowDangerouslySkipPermissions:true`；`default`/`acceptEdits`/`dontAsk`/`plan` 四档 → 该键**缺席**（`in` 断言，不是 `undefined` 值） | options 真值表（含负控半边） |
| **D4** | **参数白名单 + 省略即不变（静默吞的兜底）**：`thread/settings/update` 参数只由白名单常量构造，白名单外的键**类型层不可表达且报文里零出现**；只发本次改动的键，未改动键**缺席**而非发 `null` | 类型断言 + 构造真值表 |
| **D5** | **形状映射三处不互抄**：`read-only` / `workspace-write` / `danger-full-access`（thread/start 的 `sandbox`）↔ `{type:'readOnly'}` / `{type:'workspaceWrite'}` / `{type:'dangerFullAccess'}`（settings/update 的 `sandboxPolicy`）逐值映射；`CODEX_PERMISSION_DEFAULT` 的字符串形态**原样出现**在 settings/update 参数里即红 | 映射表 + 静态扫描 |
| **D6** | **互斥守卫**：`permissions` 与 `sandboxPolicy` 不得同时出现在同一次请求；同时给出时构造层失败且**零报文发出** | 构造守卫双臂 |
| **D7** | **回声唯一来源**：facts 与控件显示只在收到 `thread/settings/updated`（Claude 轴为下一回合的 `session.created/resumed`）后更新；**空响应 `null`/`{}` 不触发任何 facts 变更**；通知值与请求值不一致时**以通知为准** | 事实/请求隔离 + 分叉臂 |
| **D8** | **idle-only 双层闸门**：active turn 时控件 disabled **且** runtime command 被拒、`thread/settings/update` 报文**零发出**、**不排队**；turn 完成后同一操作成功 | 调用计数 + 时序 |
| **D9** | **协议 error 不吞**：`-32600`（坏枚举 / 缺 `threadId`）与 SDK 拒扩权键各一例 → 失败态可判定、控件回滚旧值、**Context/facts 一格不动**、无自动重试 | 失败双臂 |
| **D10** | **会话快照更新（§5.5-4）**：改档**成功** → session-index 的 `permissionPreference` 更新为新值，重启 resume 用新值；改档**失败** → 快照逐字节不变 | 时序双臂（C9 形状） |
| **D11** | **不回写全局模板（负控，安全承重）**：改档后 `ChatAgentDefaults.byAgent[agent].permission` **逐字节不变**，此后新草稿仍取模板值 | settings 快照对比 + 新草稿真值表 |
| **D12** | **危险档二次确认（实时层）**：选中危险档但未确认 → runtime command **调用 0 次**、控件值回原档；确认后**恰好 1 次**；控件的默认值/回退值枚举**均非**危险档 | 调用计数 + 真值表 |
| **D13** | **两个闸门不复用**：`agentBindingLocked === true` 的会话（agent picker 已是单段静态 chip）在 idle 下权限控件**仍可用**；权限控件的 disabled 判据里**不出现** `agentBindingLocked` 符号 | 结构断言 + 静态扫描 |
| **D14** | **契约门禁**：`thread/settings/update` 出现在 `codexWire.ts` 的 `CODEX_METHOD` 中**当且仅当** `codex-method-contract.json` 已含该方法；fixture 补采后 clientRequest 计数与同版二进制一致（121 → 126） | 契约测试（`codexWireContract.test.ts` 范式） |
| **D15** | **能力闸门降级**：`capabilities.permissionPolicy` 缺席（old Host）→ 实时控件**不渲染**（非「渲染个禁用的」）、runtime command 不注册；Settings 模板层与 S3 读侧输出**逐字不变** | 降级臂 + 回归对照 |

### 6.6 S4 变异对（逐对实跑记红灯）

① 改档只改 `query()` options，`session.created` / `session.resumed` 仍读常量（或只改其中一处）→ **D1 红**
② 为改档重建 in-flight 回合的 stream，或把文案改成「立即生效」→ **D2 红**
③ `bypassPermissions` 不发 `allowDangerouslySkipPermissions`（反向：全部档位都发）→ **D3 红**（两个方向各一次实跑）
④ 参数构造改为透传 UI 对象（未知/拼错的键照发）→ **D4 红**（**服务端静默吞 ⇒ 没有这一对，该缺陷在测试里完全不可见**）
⑤ 把 `CODEX_PERMISSION_DEFAULT` 的 kebab 字符串形态直接喂 `thread/settings/update` → **D5 红**
⑥ 同一次请求同时发 `permissions` 与 `sandboxPolicy` → **D6 红**
⑦ 收到空响应即乐观更新 facts / 用请求值刷 UI（不等通知）→ **D7 红**
⑧ 去掉 idle-only 闸门（turn 飞行期照发）或改为排队重试 → **D8 红**（P3 实测竞态：改了但这一回合没生效）
⑨ 吞掉 JSON-RPC / SDK error 并保留新档显示 → **D9 红**
⑩ 改档成功后不更新会话快照（重启 resume 回旧档）→ **D10 红**
⑪ 改档顺手回写 `ChatAgentDefaults` 模板（照抄 model/effort 的回写口径）→ **D11 红**（静默扩权主入口，R18）
⑫ 危险档跳过二次确认直接下发，或把危险档设为控件默认/回退值 → **D12 红**
⑬ 权限控件复用 `agentBindingLocked` 闸门（已锁定会话不能改权限）→ **D13 红**（等于把 Q1 拍板的需求实现没）
⑭ 无 committed fixture 就扩 `CODEX_METHOD` → **D14 红**
⑮ `capabilities.permissionPolicy` 缺席时仍渲染控件（点了报错）→ **D15 红**

### 6.7 S4 as-built（施工实况与规格偏差）

> 落账 2026-08-17（终检修复批收口）。按 §1.3「每片 as-built 段落必须记：git commit · 四门逐门实跑输出 · 变异逐对红灯原文 · off/on 双轮结果 · 新增/改动文件清单 · 规格偏差条目」六项补齐，六子节形状照 §5.9。
> **施工编制**：施工两员（Host/Main 半边 + renderer 半边）→ 规格符合性终检（8 条，3 blocker / 1 major / 4 minor）→ **终检修复批**（本节全部数字、⑯~㉒ 七对新变异、以及 swept 臂 / Claude 回声 / null 守卫 / inline / i18n 五组新断言出自该批）。
> **git commit：本片尚未提交**——按用户纪律终检修复批不自行 commit，收口态为工作树 34 个变更项（清单见 §6.7.6）。

#### 6.7.1 四门逐门实跑（终检修复后，逐门串行）

| 门 | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm typecheck` | `EXIT=0`，`tsc --noEmit` 无输出 |
| 2 | `pnpm typecheck:agent-host` | `EXIT=0`，`tsc --noEmit -p src/agent-host/tsconfig.json` 无输出 |
| 3 | `pnpm lint` | `EXIT=0`，`Checked 974 files in 728ms. No fixes applied. / Found 29 warnings. / Found 3 infos.`（0 error；29 warning 全在 `docs/design/*.html`，与 S3 逐字同数） |
| 4 | `pnpm test` | `EXIT=0`，`Test Files 232 passed (232) / Tests 4567 passed (4567)`，Duration 19.29s |

基线链：S3 收口 **227 文件 4403 例** → 施工两员交接 **232/4550**（+5 文件 +147 例）→ **终检修复批收口 232/4567**（+17 例，无新增文件）。
终检修复批新增的 17 例分布：`codexRuntime.test.ts` +5（swept 臂四例 + 崩溃臂负控一例）· `composerPermissionLiveWiring.test.ts` +7（inline 一例 + D-i18n 六例）· `claudeRuntimePermissionUpdate.test.ts` +2（回声生产者 + 判别式常量 pin）· `contextPermissionPolicy.test.ts` +1（Claude 臂回声入 fold）· `composerPermissionModel.test.ts` +1（Claude pending 经回声落地）· `protocolErrors.test.ts` +1（`permissionPreference: null` 臂）。

#### 6.7.2 flag off/on 双轮

| 轮次 | 结果 |
|---|---|
| `AICLIENT_AGENT_CODEX` 未设（off） | `Test Files 232 passed (232) / Tests 4567 passed (4567)` |
| `AICLIENT_AGENT_CODEX=1`（on） | `Test Files 232 passed (232) / Tests 4567 passed (4567)` |

两轮逐例相同 —— §1.1-4「renderer/store 形状不得因 flag 分叉」在测试面成立；实时权限控件的渲染判据是 `capabilities.permissionPolicy`（能力）与 facts（回声），**与 flag 无关**（flag 只管 Codex 能否被 spawn）。

#### 6.7.3 既有非 hermetic 红（**非本批引入**，不计入收口）

`AICLIENT_MANAGED_CREDENTIALS=1` 下：`Test Files 4 failed | 228 passed (232) / Tests 15 failed | 4552 passed (4567)`。

落点与 §4.10.3 / §5.9.3 **逐文件逐例完全一致**（4 文件 15 例）：`main/services/auth/__tests__/index.test.ts`（1）· `onboarding/__tests__/OnboardingService.test.ts`（6）· `session/__tests__/SessionManager.test.ts`（2）· `usage/__tests__/UsageService.test.ts`（6）。零例落在 D48 S4 改动面，判定沿用 S2/S3：既有夹具非 hermetic 缺陷（读环境变量而非注入），留独立票。

#### 6.7.4 规格偏差清单

**A · 终检核查抓出并已修（3 blocker / 1 major）**

1. **Codex 轴主路径在 180 秒后必挂（BLOCKER，已修）**。`CODEX_DEFAULT_IDLE_TIMEOUT_SECS=180` 且 sweeper 默认开启，`reclaimIdleSession` 走 `teardown` 删掉 `this.sessions` 的行、保留 registry 行；此后 `updatePermission` 的 `if (!state || !session)` 早退直接 `session_not_found`，**registry 的 `permissionPreference` 一个字节都没写**。而该方法头注写的是「swept 会话不复活，下次 send 会按 registry 行的姿态回来——所以行才是这个方法要写的东西」，代码在写行之前就 return 了：注释描述的行为不存在。用户实际路径正是 §6.4-2（闲置 >3 分钟的 Codex 会话，控件仍渲染仍可点，点任一档 toast 报 `session_not_found`，改档丢失）。**修法**：`state` 缺席分两种因由，用 `send` 同款的 `reviveHandleFor` 判据分开——不在 sweep 名单上（崩溃 / 已关闭 / 从未有过）仍是 `session_not_found`；在名单上则走 swept 臂：写行 + 发 `session.permissionUpdated{effective:'next_turn'}`，**不 spawn、不发帧、不排队**。新增断言四例 + 崩溃臂负控一例，变异 ⑯a/⑯b/⑯c 三臂。
2. **Claude 轴回声「生产者缺席」（BLOCKER，已修）**——S3 终检抓过的同一形状，方向相反。§6.3-① 写「等下一回合的 `session.created/resumed` 回声」，但这两个事件只在 `createSession` / `resumeSession` 发一次，而 `sendPreamble.decideSendPreamble` 对已 host-bound 的会话恒返回 `direct`：同一次 app 运行内，Claude 会话改档后 `SessionRuntimeFacts` **永远不会更新**——chip 恒显旧档 + `pendingLabel` 恒挂、Context 面板权限行恒显旧档，把 `default` 改成 `bypassPermissions` 后面板会一直说 `Default`（§6.1-2 与 §9.2 要禁的「谎报安全姿态」）。掩护它的是 `claudeRuntimePermissionUpdate.test.ts` 里手调 `rig.runtime.resumeSession()` 造出的那条回声，生产链上没有任何东西会调它。**修法**：给 Claude 轴补真生产者——`send()` 在 `queryFn` 返回后（即 SDK 真的拿到了这轮 options 的那一刻）发一条 `session.settingsEcho{permissionPolicy:{agent:'claude-code',permissionMode}}`；消费端零改动（`foldSettingsEcho` 与 `projectEchoedPreference` 的 claude 臂本来就吃这个形状）。断言钉「改档 → 发第二条 → facts 变新值 → pending 落地」，且值与 **capture** 比而非与字面量比。变异 ⑰a/⑰b 两臂。
3. **§6 末尾无 as-built 小节（BLOCKER 收口条件，已补）**——本节即是。连带补齐：15 对变异的逐对实跑红灯原文、四门逐门输出、off/on 双轮、基线例数、偏差清单。
4. **L12 回声投影只落了一半（MAJOR，已按方案 ② 落账）**。`session.settingsEcho.payload.model` 有生产者、Main 照转，但**全 renderer 零消费者**（`foldSettingsEcho` 显式跳过 model，`ComposerModelTrigger` 仍显示本地选择），而用例名却叫「L12 — one frame refreshes the posture AND the thread model」——S3 抓的是消费者单边空壳，这是它的镜像。**判定与修法**：S4 不做模型标签订阅（`ComposerModelTrigger` 有 per-agent 本地选择、目录、未验证标签三层状态，接线不是本片能顺手带的量），因此**从 payload 里删掉 `model` 字段**，`onThreadSettingsUpdated` 的早退改为 `if (!posture) return`（只带 model 的帧仍写 registry 的 `session.model`/`session.effort`——那半边是真消费者，revive 与下一回合都读它——但不再广播），用例改名为「one frame is read ONCE — the registry takes model and effort, the renderer gets one echo」并加一条 `'model' in echo === false` 的负控。§8.2-L12 同步改判为「S4 未落，另立票，落地时随 reader 一起加回可选字段」。变异 ⑳。

**B · 终检核查抓出并已修（4 minor）**

5. **dispatch 的 REQUIRED 守卫对 `null` 形同虚设（已修）**。`index.ts` 只查 `=== undefined`，而 `readPermissionPreference` 对 `null` 返回 `{ok:true}` 且 preference 为 `undefined` → `permissionChangeNeedsConfirmation(undefined, …)` 恒 false（危险档那道墙对着 undefined 空转）→ 一路走到 runtime 才被另一条消息拒掉。净结果不危险（最终仍是 invalid_payload），但守卫与错误文案都不是它。守卫改为 `=== undefined || === null`，`protocolErrors.test.ts` 补一条 null 臂（先 create 一个真会话，因为该守卫在绑定查找之后）。变异 ⑲。
6. **失败提示 toast → inline（已修）**。§6.3「失败 = 保持旧事实」要求的是「控件回滚旧值 + inline 提示」，实况是 `toastManager.add`。控件本来就没有可回滚的本地值（chip 派生自 facts），所以义务全在 inline 那一半；改为写 `useChatSessionsStore.setState({ lastError })`——同一个 Composer 上 `AGENT_UNAVAILABLE_SEND_ERROR` 用的正是这条通道，`ChatComposer` 的 `statusHint` 渲染它。红线文件 `chatSessions.ts` **一字未动**（只是从外部 `setState`）。变异 ㉑。
7. **中英混排（已修）**。菜单项 / scopeHint / 警告 / 对话框都过了 `t()` 且有中文词条，但 `aria-label` / `title` / chip 上可见的 `pendingLabel` / `disabledReason` 是 `composerPermissionModel.ts` 拼出来的英文合成串——既没过 `t()` 也**无法**过（内嵌未翻译的部件）。中文界面下弹层中文、chip 后缀 `· applying…`、tooltip 整句英文。S3 终检 §5.9.4-D 用的是同一把尺子（那次判 不成立 是因为词条真的在）。**修法**：模型改为交出**键与模板**而非句子——`labelKeys` / `pendingLabel{template,tierKeys}` / `titleTemplate` / `spokenTemplate` / `disabledReason`（整句键），组件先逐段 `t()` 再拼；`permissionChipLabel` 改为 `permissionTierLabelKeys` + `PERMISSION_TIER_JOINER`。`i18n.ts` 补 13 条 zh 词条（4 条 disabled 整句 + 3 条 pending 模板 + 4 条 title/spoken 模板）。Codex 档位标签（`on-request` / `read-only` / `danger-full-access` …）**故意不翻**：它们是用户在 codex 自身输出里也会读到的协议 token，翻译等于给同一件事造第二套词汇。新增 D-i18n 六例静态断言，变异 ㉒a/㉒b 两臂。
8. **no-op 臂发 ACK 但不发帧、也就不会有 `thread/settings/updated` 跟上（已修）**。renderer 收到 ACK 后 `setPending(...)`，而 `permissionChangeSettled` 只认 facts —— facts 与 `state.policy` 可以合法地不一致（上一帧是 `granular` approvals 这类本 build 读不出的形状时，`onThreadSettingsUpdated` 按设计不写 policy，facts 停在旧值），于是这次点击会留下一个永不落地的 pending 标记；UI 侧 `samePermissionPreference(preference, view.current)` 早退挡不住，因为 view.current 来自 facts 而 runtime 比的是 `state.policy`。**修法**：no-op 臂顺手把 `state.policy` 作为 `session.settingsEcho` 发一次——它是**已验证的事实**（`thread/start` 回声验过或被上一条 settings 帧改写过），不是乐观写。变异 ⑱。

**C · 施工两员/修复批自报（4 条，非违规但规格没写）**

1. **`session.settingsEcho` 由「Codex 专属投影」升为「两轴共用的事实事件」**。§6.2-6 与该事件原头注都写着「Claude has no counterpart and must not grow a synthesized one」，前提是「created/resumed 每回合都来」——被实测证伪（见 A-2）。两条臂都不是合成：Codex 复述服务端广播，Claude 复述刚刚交给 SDK 的 options。头注已重写。
2. **swept 臂会发一条 `session.settingsEcho`**，看起来像违反 D7「facts 只经回声」。理由写进了方法头注：该会话**没有线程**，registry 行就是它的姿态，且 `reopenThread` 的 `assertResumePosture` 会**拒掉**任何别的姿态回来（revive 失败而不是跑错档）——所以「这个会话跑在 X 下」是被强制执行的陈述，不是预测。不发的话，chip 会永远停在 sweep 前的旧档配一个没有任何帧会来结算的 pending 标记，即对安全姿态的永久错误陈述。`networkAccess` 在这条 echo 上**故意缺席**：sweep 丢掉了从 `thread/start` 学到的值，且沙箱刚刚在它下面变了，「未上报」是唯一诚实的答案（§5.9.4-B-2 的三态口径）。
3. **swept 臂的 ACK 是 `next_turn`，与 §6.3「Codex =立即生效（当前线程）」的轴文案不同调**。没有线程可供「立即」，姿态在下一次 send 复活时生效，所以 ACK 说 `next_turn`。菜单里那句 scopeHint 仍是按 agent 静态取的「Applies immediately, to this thread.」——因为上面那条 echo 让 pending 当场结算、chip 立刻显示新档，用户看到的与那句话一致；把 scopeHint 也做成按会话状态动态的话，需要 renderer 知道「这个会话被 sweep 过」，而 renderer 从设计上就不该知道（revive 全程静默）。登记为已知取舍，不改。
4. **`agentWire.ts` 新增 `CLAUDE_CODE_AGENT_ARM`**。`SessionPermissionPolicy` 是按字面量判别的联合，而 `CLAUDE_CODE_AGENT` 的类型是宽的 `AgentWireName`，narrow 不了；在 `claudeRuntime.ts` 里写 `'claude-code'` 字面量会被 `agentWireStatic.test.ts` 的值位扫描直接判红（`CODEX_PERMISSION_DEFAULT` 能写 `'codex'` 只是因为终端轴占了同一拼写、那条扫描覆盖不到）。故在字面量的唯一归属地新增一个窄类型导出，值从 `AGENT_WIRE_NAMES[0]` 读（顺序本身已被 pin），并由 `claudePermissionPolicy('plan').agent === CLAUDE_CODE_AGENT` 钉住两者相等。

#### 6.7.5 变异逐对红灯表

> 口径同 §4.10.5 / §5.9.5：逐对实跑，红灯抄失败用例名 + 计数。**变异施加与还原一律经 python 精确字符串替换（`/tmp/d48s4_mutate.py`：预检唯一命中 → 施加 → 跑子集 → `finally` 无条件写回原始字节），禁 `git checkout`。** 收口后已逐文件确认零残留。

| 编号 | 变异内容 | 红灯 | 计数 |
|---|---|---|---|
| ① | `session.resumed` 的 permissionMode 改回读常量 | `resume: the same three readers, on the resume half of the pair` / `D1 … the next turn, the registry and a later resume echo all read the changed tier` | **2 红**（`2 failed \| 21 passed (23)`） |
| ②a | Claude 的 ACK 改口说 `immediately` | `the ACK re-states the accepted preference and says when it applies` / `the ACK never claims immediate effect on this axis` | **2 红**（`2 failed \| 11 passed (13)`） |
| ②b | 去掉 Claude 侧 busy 闸门（in-flight 回合可被改档） | `refuses while a turn is running, and the running turn keeps its options` | **1 红**（`1 failed \| 12 passed (13)`） |
| ③a | `bypassPermissions` 不发 `allowDangerouslySkipPermissions` | `sends allowDangerouslySkipPermissions with bypassPermissions` / `a mid-session switch to bypassPermissions sends allowDangerouslySkipPermissions` | **2 红**（`2 failed \| 21 passed (23)`） |
| ③b | 反向：全部档位都发该键 | `omits the key entirely for every other tier (negative half)` / `the default session (no preference at all) never carries the key` / `a mid-session switch …` / `switching BACK drops the key entirely, rather than sending false` | **4 红**（`4 failed \| 19 passed (23)`） |
| ④ | 参数构造改为透传调用方对象（未知键照发） | `a built frame carries ONLY whitelisted keys, on the wire as well as in the type` / `the thread/start spelling never appears in a settings frame (the copy-paste defect)` / `D4 — sends only the dimensions that actually changed, and nothing else` | **3 红**（`3 failed \| 253 passed (256)`） |
| ⑤ | kebab 字符串直接喂 `sandboxPolicy.type` | `every mode maps to a declared SandboxPolicy variant` / `maps each tier by name, in both directions, with no tier left over` / `the thread/start spelling never appears in a settings frame` / `D4 — sends only the dimensions …` | **4 红**（`4 failed \| 252 passed (256)`） |
| ⑥ | 去掉 `permissions` / `sandboxPolicy` 互斥守卫 | `refuses the combination and emits no frame at all` | **1 红**（`1 failed \| 18 passed (19)`） |
| ⑦ | 空响应即乐观发 facts（用请求值刷 UI） | `D7 — the empty response is not a fact: session.settingsEcho waits for the notification` / `D7 — the NOTIFICATION wins when it disagrees with what we asked for` | **2 红**（`2 failed \| 235 passed (237)`） |
| ⑧ | 去掉 Codex 侧 idle-only 闸门 | `D8 — a running turn refuses the change, writes no frame and queues nothing` | **1 红**（`1 failed \| 236 passed (237)`） |
| ⑨ | 吞掉 JSON-RPC error 并照写 registry | `D9 — a JSON-RPC refusal is surfaced, not swallowed, and moves nothing` | **1 红**（`1 failed \| 236 passed (237)`） |
| ⑩ | 改档成功后不写会话快照 | `writes the snapshot from the Host ECHO, after the Host confirmed` / `the snapshot it writes is the one a later resume replays (C9 chain)` / `the update handler writes exactly one thing, and it is the session row` | **3 红**（`3 failed \| 11 passed (14)`） |
| ⑪ | 改档顺手回写 `ChatAgentDefaults` 模板 | `the live control has no way to write chatAgentDefaults` / `the live control has no way to write useSettingsStore` | **2 红**（`2 failed \| 31 passed (33)`） |
| ⑫ | 危险档跳过二次确认直接 apply | `both dangerous tiers are held for confirmation, every other tier applies` / `the LIVE gate and the TEMPLATE gate reach the same verdict for every tier` / `the held value is the requested one, unmodified …` / `a dangerous tier is dangerous no matter which dimension the finger moved` | **4 红**（`4 failed \| 36 passed (40)`） |
| ⑬ | 权限控件复用 `agentBindingLocked` 闸门 | `neither the control nor its model names agentBindingLocked (the fold ChatWorkspace computes for the picker)` | **1 红**（`1 failed \| 32 passed (33)`） |
| ⑭ | fixture 里没有该方法就扩 `CODEX_METHOD` | `client→server thread/settings/update exists in the contract` / `D48 §4.6 — the settings echo is a declared server notification, spelled exactly` / `D14 — CODEX_METHOD spells the settings channel IF AND ONLY IF the fixture declares it` | **3 红**（`3 failed \| 29 passed (32)`） |
| ⑮ | `capabilities.permissionPolicy` 缺席时仍渲染控件 | `an old Host that never reports permissionPolicy gets NO control` | **1 红**（`1 failed \| 39 passed (40)`） |
| **⑯a** | **swept 会话回到 `session_not_found`（本次 blocker 的原始形态）** | swept describe 四例全红：`writes the row and acknowledges it as next_turn…` / `states the new posture as a fact…` / `and the revive that follows really does reopen under it…` / `refuses a posture it cannot name on this arm too…` | **4 红**（`4 failed \| 233 passed (237)`） |
| **⑯b** | **swept 臂的 ACK 改口说 `immediately`（线程根本不存在）** | `writes the row and acknowledges it as next_turn, spawning nothing and sending nothing` | **1 红**（`1 failed \| 236 passed (237)`） |
| **⑯c** | **swept 臂只写行、不陈述事实（留一个没有帧会结算的 pending）** | `states the new posture as a fact, because the row IS the posture while the process is gone` | **1 红**（`1 failed \| 236 passed (237)`） |
| **⑰a** | **Claude `send()` 不再发回声（生产者缺席，本次 blocker 的原始形态）** | `the change becomes a FACT on the next send, without a resume (D7, the producer half)` | **1 红**（`1 failed \| 12 passed (13)`） |
| **⑰b** | **反向：`updatePermission` 自己发事实（ACK 冒充证据）** | `the change becomes a FACT on the next send, without a resume (D7, the producer half)` | **1 红**（`1 failed \| 12 passed (13)`） |
| **⑱** | **no-op 臂不复述已验证姿态** | `D4 — a change to the posture the session already has writes NO frame` | **1 红**（`1 failed \| 236 passed (237)`） |
| **⑲** | **REQUIRED 守卫回到只查 `=== undefined`** | `D48 S4 — permissionPreference: null is caught by the REQUIRED guard, not two layers down` | **1 红**（`1 failed \| 19 passed (20)`） |
| **⑳** | **`model` 字段加回 payload（生产者单边空壳）** | `one frame is read ONCE — the registry takes model and effort, the renderer gets one echo` | **1 红**（`1 failed \| 236 passed (237)`） |
| **㉑** | **失败提示改回 toast** | `the failure path writes the composer status line and opens no toast` | **1 红**（`1 failed \| 32 passed (33)`） |
| **㉒a** | **chip 先 join 后不翻译（tier 部件不过 `t()`）** | `each composed value is built by a t() call, and the tier parts are translated before the join` | **1 红**（`1 failed \| 32 passed (33)`） |
| **㉒b** | **模型层重新拼英文整句（`spokenLabel` 回归）** | `the model builds no user-visible sentence of its own` | **1 红**（`1 failed \| 32 passed (33)`） |

**首轮存活：0 对**（S3 的 ⑩a 存活是「注释不算代码」，本批无同形态）。⑯a 一次打红四例值得单记：它证明 swept 臂的四条断言互相不可替代——行写入、事实陈述、真机复活姿态、非法姿态拒绝，各钉一段链路。

#### 6.7.6 改动/新增文件清单（`src/` 工作树 34 项 = 新增 10 + 修改 24；本规格文档 §6.7 落账为第 35 项）

**新增（10）**

- Host 实现 1：`agent-host/codexSettingsUpdate.ts`（`thread/settings/update` 参数层：白名单常量 · 双向 sandbox 映射 · 互斥守卫 · 帧读取器）
- shared 1：`shared/models/permissionTiers.ts`（两层共用的档位词表 + `dangerous` 标记 + 最严回退值）
- renderer 实现 2：`components/chat/composerPermissionModel.ts`（实时层纯模型：回声投影 · 危险档闸 · 视图键与模板 · 非用户选择臂枚举）· `components/chat/ComposerPermissionTrigger.tsx`（chip + 菜单 + 常驻 warning + AlertDialog 二次确认 + inline 失败）
- 夹具 1：`agent-host/__tests__/fixtures/codex/codex-settings-schema.json`
- 测试 5：`agent-host/__tests__/claudeRuntimePermissionUpdate.test.ts` · `agent-host/__tests__/codexSettingsUpdate.test.ts` · `main/ipc/__tests__/chatPermissionUpdate.test.ts` · `renderer/components/chat/__tests__/composerPermissionLiveWiring.test.ts` · `renderer/components/chat/__tests__/composerPermissionModel.test.ts`

**修改（24）**

- shared（5）：`types/runtimeEvents.ts`（`PermissionUpdateEffective` · `SessionPermissionUpdatedEvent` · `SessionSettingsEchoEvent`——两轴共用、去掉 `model`）· `types/agentHost.ts`（`session.updatePermission` 命令）· `types/ipc.ts`（`chat:updatePermission`）· `types/agentWire.ts`（`CLAUDE_CODE_AGENT_ARM`）· `i18n.ts`（S4 zh 词条 + 13 条模板/整句词条）
- agent-host（4）：`codexRuntime.ts`（`updatePermission` 三臂：live / no-op / swept · 回声只带 posture）· `claudeRuntime.ts`（`updatePermission` + `claudePermissionPolicy` + `send()` 的回声生产者）· `index.ts`（dispatch 守卫 · null 臂 · R18 第二道墙）· `codexWire.ts`（`CODEX_METHOD` 扩两方法）
- Main / preload（4）：`main/ipc/chat.ts`（handler 四步：绑定取自索引行 → 校验 → R18 → 等 ACK 再写快照）· `main/services/agent-host/AgentHostManager.ts`（唯一一条等自己答复的会话命令）· `main/services/chat/SessionIndexService.ts`（`setPermissionPreference`）· `preload/index.ts`
- renderer（3）：`components/chat/ChatComposer.tsx`（挂载控件 + 能力/态传参）· `components/workspace-shell/surfaces/contextSurfaceModel.ts`（`foldSettingsEcho` + N4 序）· `components/settings/chatPermissionDefaults.ts`（改用共享词表）
- 夹具/测试（8）：`agent-host/__tests__/fixtures/codex/codex-method-contract.json`（补采 5 条欠采 + 该方法）· `agent-host/__tests__/codexWireContract.test.ts` · `agent-host/__tests__/codexRuntime.test.ts` · `agent-host/__tests__/protocolErrors.test.ts` · `main/services/chat/__tests__/sessionPermissionSnapshot.test.ts` · `renderer/components/chat/__tests__/pureModuleImports.test.ts` · `renderer/components/workspace-shell/surfaces/__tests__/contextPermissionPolicy.test.ts` · `shared/types/__tests__/sessionPermissionPreference.test.ts`

**红线文件零触碰**：`src/renderer/stores/chatSessions.ts` 全片一字未动（`git status` 无该项；失败提示只是从外部 `setState({ lastError })`，与 `AGENT_UNAVAILABLE_SEND_ERROR` 同法）。三轴隔离无破口：终端轴 `AgentSettings.tsx` / `AgentPickerMenu` / `SessionBar` 均不在清单里，并由 `composerPermissionLiveWiring.test.ts` 的 D11/D13 静态扫描反向钉住。`AGENT_HOST_PROTOCOL_VERSION` 未动，协议改动全为可选加法。

**终检修复批实际触碰（12）**：`agent-host/codexRuntime.ts` · `agent-host/claudeRuntime.ts` · `agent-host/index.ts` · `shared/types/runtimeEvents.ts` · `shared/types/agentWire.ts` · `shared/i18n.ts` · `renderer/components/chat/composerPermissionModel.ts` · `renderer/components/chat/ComposerPermissionTrigger.tsx` · `renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts`（一处注释口径）· `agent-host/__tests__/codexRuntime.test.ts` · `agent-host/__tests__/claudeRuntimePermissionUpdate.test.ts` · `agent-host/__tests__/protocolErrors.test.ts`（另含三个测试文件的断言增补：`contextPermissionPolicy` · `composerPermissionModel` · `composerPermissionLiveWiring`）。

---

## §7 风险表

| # | 风险 | 等级 | 触发条件 | 影响 | 缓解 / 断言 |
|---|---|---|---|---|---|
| R1 | **锁定判据在四处漂移** | blocker | 不提取共享判据，picker 自写一份 | 从 index 恢复的 Codex 会话被判「未物化」→ 用户改成 Claude → 下一条消息拿 Codex threadId 走 Claude resume 分支 | §3.3 提取 `sessionBinding.ts`（今天已有两处镜像 N3/N5）+ A2 共用符号扫描 + 变异 ① |
| R2 | **首发 IPC 飞行期仍可切 agent** | blocker | 只按 hostBound/runtimeIdentity 判锁 | create payload 与 UI 选择分裂 | `sendAttempted` 同步 latch（`ChatComposer.tsx:907`）+ A3 snapshot 断言 + A6 调用序 + **A5b（store action 的 `sendAttempted` 入参臂）** + 变异 ②⑦b |
| R3 | **目录代理化把一次网络故障变成「模型选不了」** | blocker | vault `locked`（safeStorage 未解锁，D47 S1 §2.1 窗前死锁 E6）而 `resolveManagedCredentialsEnabled` 为 on | 发消息前的必经控件卡住 | §4.1 凭据窄口直落种子表；**B1 的「凭据不可用 → seed 且 fetch 计数 0」是本片最重要的一条断言，不是边缘用例**（配对变异 ⑫，§4.9） |
| R4 | **目录查询泄露 key / 响应体** | blocker | renderer 直 fetch，或日志打 header/body | 凭据泄露 | Main-only service + 脱敏返回形状 + B4 secret scan |
| R5 | **权限 preference 被当作 runtime fact** | blocker | Settings 乐观写 Context | UI 谎报实际权限姿态 | Preference/Policy 双类型（§5.4）+ C8/C12 |
| R6 | **全局默认在 resume 时覆盖旧会话安全姿态** | blocker | 会话未存权限快照 | 重启后安全姿态静默变化 | 首发物化进 session-index（§5.5）+ C9 + 变异 ⑧；**hydrate 前不物化（§5.5-3）+ C15 + 变异 ⑪** |
| R7 | **`networkAccess` 被假装可控** | blocker | UI 给布尔开关但 wire/config 不接 | 安全边界错误 | S3 只读 + C8 负控 + 变异 ④ |
| R8 | **D40 补 model 后出现 thread/start 与 turn/start 双真源** | major | 覆盖成功但不回写会话状态 | 后续回合/resume 用哪个值无定论 | §4.6 防线 ②（成功后事务式回写，**回写值取 `thread/settings/updated` 通知而非请求值**）+ **B8（生产侧三臂）+ B14（消费侧：revive/resume 读回写值，分叉场景双臂）** + 变异 ⑥⑬；**防线 ① 探针 ✅ 已过（P1 sticky 成立），「退回只补 effort」的回退臂不再触发，仅作历史依据保留** |
| R9 | **stale cache 被误标 fresh / 种子表伪装成可用目录** | major | refresh 失败仍更新 `fetchedAt`；或用静态表当 fallback | 用户选到已下线模型，或以为目录正常 | `source`/`stale`/`fetchedAt` 明示 + UI「目录不可达」+ B1/B3 + 变异 ①④ |
| R10 | **家族白名单在 renderer 侧实现或被绕过** | major | 过滤层不在 Main 响应层 | 白名单与种子表两处规则漂移，renderer 见到未过滤目录 | §4.2 落点写死 Main 过滤层 + B9 表驱动 + 变异 ⑧ |
| R11 | **legacy 短名被自动映射** | major | 迁移时猜 `sonnet → claude-sonnet-5` | 升级后静默换模型且不可回滚 | §4.4 legacy 合成项 + B5 storage 字节快照 + 变异 ⑦；**目录外存量全名走 §4.4-6 的 unverified 前插 + B16 + 变异 ⑮**（白名单过滤是 R11 的第二个入口） |
| R12 | **capabilities 不带原因，UI 过度承诺** | major | 文案写「flag 未开启」 | 误导用户去改一个不存在的开关 | N2 → 文案用 generic `Unavailable in the current Host`；old Host 单独可判 + A1 |
| R13 | **per-agent 与 per-session 偏好互相覆盖** | major | 单一 map 没有两层语义 | 切 agent 或切 session 串值 | §4.3 两层优先级 + key 含 agent + B12 + 变异 ⑪ |
| R14 | **resume 不发 Codex policy，权限行再次消失** | major | 打开恢复会话 | 读侧闭环白做 | H9 校验成功后补事实事件（§5.6-5）+ resume regression C5 |
| R15 | **S4 照猜不照抄**（rev.3 改写：探针已完成，风险从「先实现后探针」变为「不照 06-probes 的实测报文施工」） | blocker | 绕过 06-probes 的报文自行猜字段名/形状；无 committed fixture 就扩 `CODEX_METHOD`；把 `thread/start` 的 kebab `sandbox` 与 settings/update 的 `sandboxPolicy` 互抄 | 错协议；或**未知字段被静默吞导致改档悄无声息不生效** | §6.2 逐条钉报文形状 + **D4（白名单）/ D5（形状映射）/ D14（契约门禁）**；真机点验按 §1.2 报备 |
| R16 | **flag-off 发布形态改变（不只是评审误判）** | minor | 改判 #3 后 flag-off 也在 empty 模式渲染置灰 Codex 段 | 评审以为 off 轮不该有变化；且 **§1.1-4 禁 renderer 按 flag 分叉 → S1 没有独立 UI 回退杆**，唯一回退是整片不合入 | §3.4 已写明 off 轮断言口径改为「两项渲染 + codex disabled + reason」，并把「flag-off 上架置灰段」记为**已知并接受的发布形态**（仲裁 §1 disable-not-hide 的直接后果）；已锁定会话只有单段 chip，不受影响 |
| R17 | **中途改档静默不生效（谎报安全姿态）** | blocker | Codex 未知字段静默吞（P1 严格性实测）；在 `turn/start` 飞行期打 settings/update（P3 实测竞态）；把空响应当作已生效 | UI 显示新档、实际按旧档执行——**且该缺陷在服务端不报错、在测试里不可见** | §6.2-3/6/7 三条合围（构造白名单 · 只认通知回声 · idle-only 双层闸门）+ **D4 / D7 / D8** + 变异 ④⑦⑧ |
| R18 | **中途改档变成静默扩权** | blocker | 危险档无二次确认；一次临时提权被回写进 `ChatAgentDefaults` 模板；`bypassPermissions` 缺 `allowDangerouslySkipPermissions` 被 SDK 拒后落到未知态 | 此后**所有新会话**默认带危险档；或用户以为已提权而实际被拒 | §5.4 危险档五条口径（两层同口径）+ §6.3 + **C13 / C16 / D3 / D11 / D12** + 变异 §5.8-⑫⑬⑭、§6.6-③⑪⑫ |

---

## §8 未决表与遗留登记

### 8.0 拍板记录（2026-08-16 当场逐卡敲定 —— rev.3 由「需拍板」转为「已拍板」）

> rev.2 挂在本节待拍的三项（仲裁 §1 只裁了权限数据的**持久化位置**，§2.2 五项与 §4-2 吸收清单均不含写侧 UI 落点与危险档控件），用户已于 2026-08-16 当场全部拍定；原始记录见[仲裁 §4-3](./2026-08-16-agent-picker-investigation/design-arbitration.md)。
> **本节自此是拍板存档，不再是待办**；三项结论已回填正文（§1.1-7/8 · §2 · §5.1/§5.4 · §6 · §9）与 plantree（`docs/plantree/plans/multi-agent/roadmap.md` 的 D48 行 + `open-questions.md`）。

| # | 原问题 | 拍板结论 | 回填落点 |
|---|---|---|---|
| **Q1** | 写侧权限控件落在哪？（rev.2 选项：(a) Context 未物化可写 / (b) Composer 第三个 pill / (c) Settings 区） | **双层，且连带改判切片形状**：**Composer 实时控件**（管当前会话，**中途可改**）+ **Settings「Chat agent defaults」默认模板**（管新会话起点），与 codeg 同构。用户原话「肯定要支持中途改啊」，理由与 D40 同构——官方 CLI 两侧都支持中途改档，后端即同一 CLI 运行时。**S4 由条件切片升正式切片**；rev.2 的「写侧只做创建时一次性下发」前提与仲裁 §1 收敛表「权限写侧首期只管创建/恢复默认档」行**一并作废** | §1.1-7 · §2 切片表 · §5.1/§5.4 · **§6 全篇** · §9.2 |
| **Q3** | 两个危险档给不给控件？ | **(a) 给 + warning + 二次确认，且默认值绝不是危险档**（断言钉死；与 A/B 两轨及 rev.2 推荐同向）。**模板层与实时层两层同口径**；Claude `bypassPermissions` 另须同发 `allowDangerouslySkipPermissions:true` | §5.4 危险档五条 · C13/C16 · D3/D12 · §7-R18 |
| **Q4** | 三条探针什么时候跑？ | **(a) 开工前齐发**（用户批准 Codex 侧 cch 用量 ≤8 发最小回合，P2 优先代码级验证）。**已执行完毕**：实耗 live 3 回合，`~/.claude` / `~/.codex` / dev.env 零写入，结论见 06-probes | §8.1 · §4.6 防线 ① · §6 |

### 8.1 已闭探针（P1/P2/P3 —— rev.3 全部关闭，本节无真未决项）

> **一行指针**：三条探针的报文、file:line 证据、严格性观察、预算与产物全在 **[`06-probes.md`](./2026-08-16-agent-picker-investigation/06-probes.md)**（2026-08-16；live 3 回合 / 预算 ≤8；探针脚本在 `/tmp/d48-probe/` 不入仓；本地配置零写入）。下表只留**结论 + 它改了规格哪一处**，细节不在本文重复。

| # | 探针 | 结论 | 落到规格哪里 |
|---|---|---|---|
| **P1** | `turn/start` 覆盖 model 的 sticky 行为 | **✅ 成立**：覆盖写进线程常驻设置（第 2 发不带覆盖仍跑被覆盖的模型，rollout 逐回合 `turn_context` 为证），并广播 `thread/settings/updated`；`sandboxPolicy` 同样 sticky；schema 层所有覆盖字段自述 "this turn AND subsequent turns"，即 codex **没有「仅本回合」语义** | §4.6 防线 ①（已过）与防线 ②（回写值取通知）· §2 的 S2 依赖列 · B8 · §4.6-6 负控 |
| **P2** | Claude 中途改权限档的通道 | **✅ 成立且比预想简单**：每发一条消息新开 `query()`，`permissionMode` 是 options 字段 ⇒ 与 D40 model 同形状；**不需要 `setPermissionMode`、不需要 streaming-input**；`CHAT_PERMISSION_MODE` 三消费点（`:754`/`:341`/`:391`）须同喂；`bypassPermissions` 需 `allowDangerouslySkipPermissions`；SDK 0.3.218 **无 `'auto'` 第 6 值** | §6.1 全条 · D1/D2/D3 · §5.4（`'auto'` 改判 + 危险档扩权键）· §5.5 wire · §8.2-L7/L10 |
| **P3** | codex `thread/settings/update` | **✅ 成立**：方法存在、**零回合**、空响应但立刻广播全量 `thread/settings/updated`；省略即不变；坏枚举/缺必填 `-32600` 拒而**未知字段静默吞**；`permissions` 与 `sandboxPolicy` 互斥；`thread/start.sandbox`（kebab 字符串）≠ `settings/update.sandboxPolicy`（camelCase 对象）；`turn/start` 刚发出即改档有竞态 | §6.2 全条 · D4~D8 · §6.3 · §7-R17 |

**副产物（不阻塞，登记去向）**：`codex-method-contract.json` 记 121 条而同版二进制 126 条，差集 5 条（`initialize` / `fuzzyFileSearch` / `thread/inject_items` / `thread/increment_elicitation` / `thread/decrement_elicitation`）为**纯欠采**、无一条消失，D48 要用的四个方法拼写无漂移 → **不构成任何前置**；补采挂 S4 的 fixture 提交（D14）或 S2 顺手活，见 §8.2-L9。

**开工判据**：S1~S4 四片均可直接开工，**不存在「等探针结论才能定形状」的项**；剩余的真机动作只有各片收口时的 GUI 点验（受 §1.2 约束）。

### 8.2 遗留登记（不阻塞施工，不进本阶段）

| # | 项 | 处置 |
|---|---|---|
| L1 | 三态琥珀点（扩 wire 发 `HostAgentDetail.reason`） | 仲裁裁定不做。要做须把 Host 内部诊断（`agentSupport.ts:227-237` 四条 reason，含「pairwise 非包含」纪律）变成对外契约 → 等真实需求（用户自己装了 codex 但没生效且高频） |
| L2 | 目录磁盘快照（跨重启离线目录） | 本阶段只做进程内 cache。要做须先设计来源/年龄 UI，否则昨日目录会冒充当前真源 |
| L3 | `model/list` 的 per-model `supportedReasoningEfforts` | §4.3 本片不读。将来出现「某模型不支持 xhigh」的真实故障再开 |
| L4 | ~~`turn/start` 的 `effort` 是否 sticky~~ | **已闭（rev.3）**：06 §0.3 实采 schema——`effort` 与 `model` 同列在「for this turn AND subsequent turns」字段清单里，**sticky 确定**；与防线 ② 的回写口径一致，无遗留动作 |
| L5 | 种子表随时间过期 | 调查 04 是单日快照；四级回落使设计不依赖它长期为真，但**每次发布前对一次**（`seedCatalog.ts` 头注写明采集日期） |
| L6 | 存量短名的自然衰减速度 | §4.4 迁移靠用户下次点击。若长期仍大量残留且 SDK 翻译层变了，届时才需写迁移（那时会有真实映射证据） |
| L7 | ~~Claude 统一改 streaming-input 的架构成本~~ | **已闭（rev.3）**：P2 实证中途改档走 per-turn `query()` options，**根本不需要 streaming-input**；rev.2 §6.1 的「扩权红线」条款随之作废（§6.1-1） |
| L8 | ~~Context 面板内联的「未物化可写」权限控件~~ | **已闭（rev.3）**：Q1 拍成**双层**，A 稿 (a) 的关切（「建会话/用会话当时才是想设它的时刻」）由 Composer 实时控件正面解决；**Context 面板恒只读**的口径不再有例外分支 |
| L9 | `codex-method-contract.json` 欠采 5 条 clientRequest（121 vs 126） | 纯欠采、方向单一、D48 用的四个方法都在 → **不阻塞**。补采顺手挂 S4 扩 `CODEX_METHOD` 的 fixture 提交（D14）；S2 若先动 codex fixture 也可顺手带 |
| L10 | SDK `PermissionMode` 的 `'auto'` 第 6 值 | **明确不做**：06-probes P2 抄录 SDK 0.3.218 的取值注释为五值，当前版本没有该值（§5.4 已改判）。等 SDK 真出现该值且有行为实证再议 |
| L11 | 「改档 + 发消息」合并进一次 `turn/start` 的往返优化 | P1/P3 都支持（`turn/start` 覆盖字段 sticky），但首版形状是 `thread/settings/update` 零回合下发（§6.2-1）。等真实性能诉求再做；做时须保证两条路径的回写收敛口径一致（同认 `thread/settings/updated`） |
| L12 | Codex 轴「线程当前模型」的 **registry 回声投影到 renderer**（P1 指示 1 完整版） | S2 as-built §4.10.4-C-1 记为简版落地：只做**文案分轴**（`modelScopeHint`，两轴不共用一句 + 静态断言）。完整版 = 把 `thread/settings/updated` 确认后的 registry 值投影回 renderer，让触发器显示「线程当前模型」而非本地选择。**S4 未落——已改判**（§6.7.4-A-4）：S4 确实加了 `session.settingsEcho`，但 renderer 侧的模型标签没有 reader，`ComposerModelTrigger` 仍显示本地选择；一个有生产者没有消费者的 payload 字段就是 S3 终检抓的空壳形状的镜像，所以 `model` 字段**已从 payload 移除**（Host 侧仍把它写进 registry，那半边有真消费者：revive 与下一回合）。落地时随 reader 一起把可选字段加回来（纯可选加法，不动协议版本），仍不另造第二条回声路径 |
| L13 | **隔离 codex home 是 Host 进程唯一一个目录**（`codexRuntime.openConnection` 每次开连接整文件重写 `config.toml`） | S3 as-built 新登记。顺序开连接恒正确（每次 spawn 读的就是本次刚写的文件），但**两个不同姿态的会话并发开连接**会把写入与对方的 spawn 交错 → 失效形态是「A 会话按 B 的姿态启动」（安全姿态串档，不是性能问题）。今天不可达：create/resume 都由 renderer 的发送路径串行化。正解 = **per-session home**（`codexHome.ts` 的 `homeDir` 改按 sessionId 派生），成本是每会话一份投影目录 + 清理时机；S4 若引入并发改档路径须先落这条 |
| L14 | **`capabilities.permissionPolicy` 目前零消费**（`hostStatus.ts` 写入，面板实际按字段有无降级） | S3 as-built 新登记。本片只把措辞收窄到「Codex 轴发 policy + 两轴收 preference」（`index.ts` / `hostStatus.ts` 注释，C7 仍钉两通道）。要让它落到实处 = Context 面板读该 bit，缺失即按 `permissionMode`-only 渲染；今天面板已能按字段有无降级，所以这是**冗余闸门而非缺口**，等出现「Host 比 renderer 新/旧」的真实事故再接 |

---

## §9 边界重申与验收清单

### 9.1 本阶段明确不做

多 agent 协同 / 同会话切 agent · 终端轴 `AgentPickerMenu`/`SessionBar`/`AgentSettings` 任何改动 · 2b 打包链（阶段 4）· git surface 扩展（open-q #4）· 提问坞单槽（open-q #10）· cch 服务端 / 供应商配置 / 模型重定向表改动 · ACP 通道与 config_options（D45 已定直连）· **不照 06-probes 实测报文而自行猜测/模拟 `thread/settings/update` 与 SDK 权限通道**（rev.3：通道已实证，禁的是猜形状与无 fixture 扩 `CODEX_METHOD`）· `networkAccess` 写侧 · SDK `'auto'` 权限档 · 命名权限 profile（`permissions` 字段）· 「改档 + 发消息」合并进 `turn/start` 的往返优化（§8.2-L11）· 目录搜索/虚拟化 · 目录磁盘快照。
> **rev.3 移除项**：「会话中途改权限档」已由 Q1 拍板成为**必做需求**（S4），不再属于本阶段不做清单。

### 9.2 功能验收

- [ ] 新会话在 Composer 可见 Claude/Codex 两段 picker；终端轴 UI/类型零改动。
- [ ] 五态（双可用 / Codex 不可用 / old Host / 空列表 / Host 非 ready）与锁定态均有确定表达，不可用项**置灰带 tooltip 而非隐藏**。
- [ ] 首发 commit 同步锁 agent；create/resume/index/侧栏展示同一绑定；**锁定后底栏只剩单段静态 chip**（不是两段置灰）。
- [ ] **显示值恒等于发送值**：草稿 agent 消失时回退**并回写** store；`agents=[]` 时发送被守卫拦截（`onSendStart` 0 次）。
- [ ] 双轴模型目录来自 cch `/v1/models` 且**经家族白名单过滤**；renderer 无 key；静态表不再作为 verified fallback；目录不可达时明示种子表来源。
- [ ] Claude 新选择为全长名；存量短名按 legacy alias 兼容，不自动映射；**目录外的存量全名按 `· unverified` 前插保留并原样下发**，不被重置为 `Automatic`。
- [ ] model/effort 随 agent 切换偏好，session 之间不串值。
- [ ] Codex `turn/start` 实际收到 **model 与 effort**，五档生效，`ultra` 不可进入 wire；成功后 registry 默认事务式回写。
- [ ] Codex `permissionPolicy` 在 Context 可见；Claude legacy 展示零回归。
- [ ] Settings 可保存两轴新会话默认权限（**模板层**，落点已由 §8.0-Q1 拍板）；active Context 只显示 Host 实际回声；**settings 未 hydrate 时不物化权限快照**。
- [ ] `networkAccess` 无假写控件；单次审批与会话默认权限互不污染。
- [ ] **Composer 实时权限控件（S4）**：idle 可改、busy 禁用**且 runtime 侧再拦一次**；Claude 文案「下一条消息起生效」、Codex 零回合生效且**只认 `thread/settings/updated` 回声**；两轴均**不吞** JSON-RPC / SDK 错误，失败保持旧事实。
- [ ] **中途改档只动当前会话**：成功后更新该会话 `permissionPreference` 快照（重启 resume 用它），**不回写 `ChatAgentDefaults` 模板**；**agent 已锁定的会话照样能改权限**。
- [ ] **危险档两层同口径**：warning + 二次确认（未确认零 IPC）+ 绝不做默认/回退值；Claude `bypassPermissions` 同发 `allowDangerouslySkipPermissions:true`。

### 9.3 工程验收

- [ ] `AgentWireName` / `BuiltinAgentId` 静态隔离断言保持绿色。
- [ ] `chatSessions.ts` 只有 `setDraftSessionAgent` 等必要加法（**零新字段**）；目录/权限 facts 走 adjacent store / Main service。
- [ ] 新增纯模块（`sessionBinding.ts` / `composerAgentPickerModel.ts` / **`src/shared/models/familyWhitelist.ts`**，路径见 §4.2）已加入 `pureModuleImports.test.ts` 的 `TARGET_FILES`（相对 `src/renderer/components/chat/__tests__/` 的路径，跨目录条目已有先例）；**S4 新增的 sandbox 形状映射与 `thread/settings/update` 参数白名单亦为纯模块，同样入表**（§6.2-3/4）。
- [ ] IPC/shared/session-index 字段均为兼容性可选加法；old Host / old snapshot 各有回归。
- [ ] secret scan 证明 catalog 日志与 renderer payload 不含 key/token/完整 auth URL。
- [ ] 每片 Happy Path、确定性过程断言、变异对**逐对实跑并抄红灯原文**；flag off/on 双轮各跑。
- [ ] 每片分别逐门通过 `typecheck → typecheck:agent-host → lint → test`（串行），基线 208 文件 3973 例 0 红不倒退。
- [ ] 三条前置探针已按 §1.2 报备并执行完毕（06-probes：live 3 回合 / 预算 ≤8，本地配置零写入）；各片收口的真机点验同样先报备；施工全程未触碰本地 `~/.claude/`、`~/.codex/` 与开发服务器 env。
- [ ] `CODEX_METHOD` 的 `thread/settings/update` 扩项**有 committed contract fixture 在先**（D14）；fixture 补采后 clientRequest 计数与同版二进制一致。
- [ ] 收口按规范第 15 条更新 D48 台账、plantree 状态与证据链接（由实际施工票执行，本规格不预改其他文件）。
