# D48 施工规格（定稿 rev.2）— Codex CLI 选择功能（阶段 3）

> 2026-08-16。**定稿 rev.1 = A 稿（Opus 轨）为底本 + B 稿（Codex 轨）吸收项 + 仲裁档裁定 + 用户拍板三条**
> （家族规则白名单 / D40 model-effort 都补 / 官方 CLI 中途 `/model` 佐证）。
> 权威链：[仲裁档](./2026-08-16-agent-picker-investigation/design-arbitration.md)（最高）→
> [A 稿](./2026-08-16-agent-picker-investigation/design-track-a.md) →
> [B 稿](./2026-08-16-agent-picker-investigation/design-track-b.md) →
> [05 设计任务书](./2026-08-16-agent-picker-investigation/05-design-brief.md) → 调查 00~04。
> 一切与仲裁档冲突处以仲裁档为准；本文自身是施工唯一入口，实现方对标注「条件执行」的项保留否决权。
>
> **rev.2（2026-08-16，三镜头对抗核查后修订）**：① 越权自裁的写侧落点与危险档控件退回 **§8.0 需用户拍板**（仲裁 §1 只裁持久化位置）；② `agentBindingLocked` 的来源与 `ChatWorkspace.tsx` 改动面补齐（照 rev.1 抄编译不过）；③ 锁定判据按 store/UI 分层（`sendAttempted` 不在 store）；④ 锁定态收敛为单段静态 chip（`deriveMiddleColumnMode` 实测：session 模式恒锁定）；⑤ `lastAgent` 记忆移出 S1 并补 hydration 口径；⑥ 回退回写 / 空列表发送守卫 / 消费侧回写 / unverified 存量选择 / Main 侧 model 校验各补断言与变异对；⑦ cache key 去掉不存在的 `credentialGeneration`；⑧ 十余处行号引用按 `cat -n` 实测校正。

---

## §0 结论先行

### 0.1 三句话

1. **切四片，依赖序 S1 → S2 → S3 → S4（条件切片）**：S1 = agent picker + 零回合绑定（纯渲染端 + `capabilities.agents` 首消费者，零协议改动）；S2 = 模型目录代理化（家族白名单过滤）+ D40 Codex 半边补齐；S3 = 权限读侧闭环 + 新会话默认档写侧；S4 = 会话中途改权限档，**探针先行、条件执行，不阻断 D48 收口**。
2. **目录服务归 Main，不进 agent-host、不塞 `host.ready`**：凭据只在 Main 的 CredentialVault（`CredentialVault.ts:52-56`），agent-host 子进程只拿到 `AICLIENT_CODEX_API_KEY` 一个 key、**没有任何 baseUrl**（`hostEnv.ts:64-71` 八键全列）；把目录查询放进 Host 需要新增 env 键扩散凭据面，与 D47「凭据权威收敛到 app」直接冲突。范式照抄 `UsageService.ts:102-131`（`resolveManagedCredentialsEnabled` → vault → `net.fetch`），走**独立 IPC**，key 与 baseUrl 都不进 renderer（`runtimeEvents.ts:85-115`：capabilities 只描述 Host build 能力）。
3. **D40 Codex 半边 = `buildTurnStartParams` 补 `model` 与 `effort` 两者**（用户拍板 2026-08-16，双轴行为对称优先；官方 codex CLI 会话中途 `/model` 即上游一等公民路径）。A 稿「不补 model」的双真源分析**不丢弃**，全部转为三条条件执行防线（探针先行 / 覆盖后回写收敛为单一真源 / 中途改 model 路径必须有显式测试与变异对），见 §4.6。

### 0.2 定稿相对双轨草案的改判清单

> 施工方只读本文即可；此表是给评审者的差异索引，说明「为什么与你读过的某一稿不同」。

| # | 改判项 | 双轨原状 | 定稿 | 依据 |
|---|---|---|---|---|
| 1 | D40 Codex 半边 | A：只补 effort，不补 model | **model / effort 都补 + 三条防线** | 仲裁 §2.1 用户拍板；A 的双真源分析降级为防线理由 |
| 2 | 目录数据形状 | A/B 均为「代理返回的全量目录」（claude 15 / codex 10） | **家族规则白名单过滤后的目录**（Main 侧过滤层），种子表六条 | 拍板 #5（05 简报 :12）+ 仲裁 §3 |
| 3 | 不可用 agent 的表达 | A：`agents.length < 2` 整个 picker 不挂载 | **恒渲染两项，不可用项置灰 + tooltip 原因** | 仲裁 §1；`runtimeEvents.ts:104-108` 类型注释本就写 disable 而非 hide |
| 4 | 三态琥珀点 | A 的可选加法 C1 / codeg 参照 | **不做（首期二态）**，扩 wire 进遗留登记 | 仲裁 §2.2；N2：`HostAgentDetail.reason` 不过 wire |
| 5 | 切片数 | A：3 片（中途改档并进 S3 探针） | **4 片，S4 单列为条件切片** | 仲裁 §1 采 B 的单列形式，边界更清晰 |
| 6 | 锁定判据 | A：`computeEverHostBound`；B：`onSendStart()` latch | **两者合取**：`sendAttempted \|\| hostBound \|\| runtimeIdentity != null` | 仲裁 §2.2「两轨各答了半边」 |
| 7 | agent 草稿存哪 | A：新 localStorage key + `resolveDraftAgent` 双路径接线 | **store 窄 action `setDraftSessionAgent`（零新字段）** | B §3.3；`chatSessions.ts:95-114` 只禁「第二默认值」，不禁用户显式选择；A 的「读一律经 `sessionAgent()`」与显式回退语义保留 |
| 8 | 目录缓存介质 | A：进程内 + `<userData>` 磁盘缓存 TTL 24h | **仅进程内内存 cache**，磁盘快照不做 | 仲裁 §2.2 回退链写死「进程内 stale cache」；B U2 的「昨日目录冒充当前真源」关切 |
| 9 | 目录回退第三级 | A：内置 snapshot = 04 实测 25 条全表 | **内置种子表 = 白名单过滤后六条，`source:'seed'` 且 UI 显示「目录不可达」** | 仲裁 §2.2（合取 B 的「不得伪装可用目录」）+ 拍板 #5 |
| 10 | 新会话默认 model | A：取目录第一条 | **`Automatic`（省略 model）** | B U1：不猜服务端/规则排序；短名常量 `DEFAULT_CHAT_MODEL_ID` 同样退役。**实现方可否决**：若 Claude 轴 Automatic 在 resume 后产生可感知漂移（`agentHost.ts:91-96`），退到「该 agent 的 `byAgent` 默认；仍无则退到 §4.2 定义的**本仓确定性家族序首条**」——注意该序是本仓硬编码的家族序，**不是 `/v1/models` 的返回序**（返回顺序不做任何语义假设，B U1 原意如此），回退到安全态 |
| 11 | 权限写侧落点与持久化 | A：Context 面板未物化可写 + localStorage | **Settings 新增「Chat agent defaults」区 + app settings 持久化；Context 面板恒只读**（**落点为定稿推荐案，待 §8.0-Q1 用户拍板**） | **持久化位置**由仲裁 §1 裁定（app settings 独立区、不复用终端轴 AgentSettings、不写 `~/.codex/config.toml`）；**写侧 UI 落点仲裁档未裁**（§2.2 五项与 §4-2 吸收清单均不含此项），故本行只是推荐案 → §8.0-Q1；B §5.3 Preference/Policy 双类型要求 Context 只承载 Host 回声 |
| 12 | 权限 preference 的会话快照 | A：无（草稿不跨重启） | **首发时物化进 session-index 可选字段，resume 优先会话快照** | B §5.3：否则改 Settings 会在重启后静默改变旧会话安全姿态 |

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
6. **D40 Codex 半边 = model / effort 都补**（拍板，见 §4.6 的三条条件执行防线）。

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
| **S2** | 模型目录代理化 + D40 Codex 半边 | Main `AgentCatalogService`（含家族白名单过滤层）+ 1 条 IPC + per-agent 目录/偏好（`ChatAgentDefaults` app settings 区，含 `lastAgent`）+ 短名兼容 + `turn/start` 补 model/effort | **S1 + P1 探针**（§4.6 防线 ①；P1 未过则本片 D40 半边退到只补 effort 并回报用户重拍，其余照做） | 加法（`CodexTurnStartParams` 加可选 `model`/`effort`；app settings 既有通道加字段，无 Host 协议改动） | ✅ 四门 + **四级回落四轮**（含凭据不可用臂）+ D40 payload |
| **S3** | 权限读侧闭环 + 新会话默认档 | Codex 读侧补链 + `capabilities.permissionPolicy` 补发 + Settings「Chat agent defaults」+ create/resume preference 通道 | S1（按 agent 分岔） | 加法（capabilities 补键 + create/resume 加可选 preference + session-index 可选字段） | ✅ 四门 + 双轴 Context 对照 |
| **S4** | 会话中途改权限档 | **条件切片**：两条探针任一成立才做对应轴的 idle selector | S3 + 对应探针 PASS | 条件（`CODEX_METHOD` 扩项须先落 contract fixture） | ✅ 探针报告 + fixture + 四门 |

**为什么是这四片**：

- **S1 与 S2 不能合**：S1 是零协议、零 Main、纯渲染端的一片（**跨会话 `lastAgent` 记忆因此不能留在 S1**——它要动 `stores/settings/` 的 `types.ts`/`defaults.ts`/`migration.ts` 并踩异步 hydration 竞态，见 §3.3-4/§4.3），可在 flag-off 下全绿收口并单独 GUI 点验；S2 一并入就把「新增 Main 服务 + 网络 IO + 缓存 + Host 协议加法」拖进同一次回归，失败面从一个组件扩到四个进程边界，红了分不清是谁。
- **S2 与 S3 不能合**：唯一耦合点是「都要按 agent 分岔」，而那个分岔在 S1 已建立。
- **S2 内部不再切第 4 片**：「目录查询」与「D40 半边」看似可分，但补 model/effort 的前提就是目录/词表已有真源，拆开会让 S2 落一个「查了目录但没人用」的半成品，违反规范第 6 条（每个能力都要能 on/off 双跑并各自有意义）。
- **S4 必须单列且条件执行**（仲裁 §1 采 B 的单列形式）：两条协议半通道均未实证，探针不成立则该轴不做实时 selector，**不阻断 D48 收口**。S4 先提交探针（只含 fixture/测试工具与报告），结论成立后另提实现提交；**S4 不得成为 S1~S3 的暗含前提**。

**最小安全交付线 = S1 + S2 + S3**（其中 S2 的 D40 半边**条件执行**：P1 探针未过则退到只补 effort 并回报用户重拍，不阻断本线收口）：用户能零回合选 agent；模型/effort 由代理真实目录（白名单过滤）驱动且 Codex 本回合生效；权限既能如实展示，也能管理新会话默认值。

---

## §3 S1 — agent picker 与零回合绑定

### 3.1 组件形态：两段式 segmented ghost pill

**新增文件**：`src/renderer/components/chat/ComposerAgentPicker.tsx` · `composerAgentPickerModel.ts`（纯视图模型）· `sessionBinding.ts`（§3.3 提取）· `__tests__/composerAgentPickerModel.test.ts`。

**改动面（既有文件，S1 全清单）**：`ChatComposer.tsx`（组装 + 新 prop `agentBindingLocked` + 发送守卫）· **`ChatWorkspace.tsx`（计算 `agentBindingLocked` 并下传——`sendAttempted` latch 只有它有，见 §3.2）** · `chatSessions.ts`（窄 action `setDraftSessionAgent`）· `useComposerTarget.ts`（`computeEverHostBound` 改 import 共享模块）· `__tests__/pureModuleImports.test.ts`（`TARGET_FILES` 加两个新纯模块）。

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

### 4.6 D40 Codex 半边：**model / effort 都补 + 三条条件执行防线**

> **定稿裁定（用户拍板 2026-08-16，仲裁 §2.1）：`buildTurnStartParams` 同时补 `model` 与 `effort`。**
> A 稿的「不补 model」被推翻，但其**双真源分析全部保留为防线理由背景**（下）。

`codexRuntime.ts:246-256` 的两条丢弃理由在调查 04 之后的处置：

| 字段 | 原丢弃理由（`:250-256`） | 04 之后 | 定稿 |
|---|---|---|---|
| `effort` | 「per-model 词表，从未读过 `model/list`，盲映射会 fail turns」 | ❌ **前提已消除**：04 探测 E/G 实证 cch 侧五档 `low/medium/high/xhigh/max` 与 `CHAT_EFFORTS`（`efforts.ts:24-30`）逐值一致，越界（`ultra`）是**显式报错非静默** | **补上**（`thread/start` 根本不发 effort，`buildThreadStartParams:216-223` 只有 `cwd/approvalPolicy/sandbox/model?` → 补它是**唯一真源**） |
| `model` | 「已在 `thread/start` 钉死，会话建立时生效一次」 | ⚠️ 事实仍成立，但**不再构成不补的理由**：接受「覆盖即新默认」为单一语义 | **补上 + 三条防线** |

**拍板理由（用户，双轴行为对称优先）**：同一个 D48 UI 在 Claude 轴能中途改 model、Codex 轴无效，是确定性错误而非安全降级。
**用户补充佐证（同日）**：官方 codex CLI 本身支持会话中途 `/model` 换模型与 effort，后端同为 app-server 长驻 thread ——**「中途覆盖 model」是上游一等公民路径，「覆盖即新默认」有官方先例**，A 轨的双真源担忧因此进一步降级。

**A 轨反例转成的三条防线（不丢弃，全部为施工前置/硬约束）**：

- **① 探针先行【条件执行】**：施工前用真实 thread 实证 `turn/start` 覆盖 model 的 sticky 行为与 `thread/start` 值的关系（覆盖是否延续到后续回合、与 resume 重派生是否冲突）。
  **预期不是「验证是否可行」，而是「确认 CLI 同款行为并抄其报文形状」**——需看清官方 CLI 的 `/model` 走的是 `turn/start` 覆盖还是别的方法，**照抄不猜**。
  **不过怎么办**：探针推翻「覆盖即新默认」→ 回退到只补 effort（安全态）**并回报用户重拍**，不得自行改语义。
  探针受 §1.2 运维铁律约束：事前报测试项与预计用量，最小 payload。
- **② 单一语义写死（消双真源靠回写收敛，不靠禁止覆盖）**：`turn/start` 覆盖成功后，运行时**必须**把新 model 写回会话状态（Host `SessionRegistry` session default），对齐 Claude 轴 `claudeRuntime.ts:514-522` 的回写模式（回写语句本身在 `:522`），使 `thread/start` 的初始值不再被任何路径读作真源；idle sweep revive 与后续 resume 都用回写后的值。**请求失败不提交默认值**（事务式）。
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
6. **不把 approval/sandbox 顺手加进 `turn/start`**——它们属于 S4 条件项。

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
| B8 | **回写事务性（防线 ②）**：`turn/start` 成功 → registry session default 更新为新 model/effort；失败 → 不更新（旧值不变） | Host 单测双臂 |
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
⑥ `turn/start` 失败仍写 registry 默认（非事务）→ **B8 红**
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

---

## §5 S3 — 权限读侧闭环 + 新会话默认档

### 5.1 分层：本片做什么、明确不做什么

| 层 | 本片 | 说明 |
|---|---|---|
| **L1 读侧补链** | ✅ 做 | Codex 会话的 Context 面板不再整行消失 |
| **L2 capabilities 补键** | ✅ 做 | `permissionPolicy: true`（N1：类型已存在、Host 忘接） |
| **L3 写侧：新会话/恢复默认档** | ✅ 做 | Settings「Chat agent defaults」模板 + 首发物化为会话快照 |
| **L4 会话中途改档** | ❌ 本片不做 | 归 S4 条件切片（§6） |
| **L5 单次工具审批** | ❌ 不做 | `PermissionQaCard`（`QuestionCard.tsx:498`）已存在，是独立概念（调查 02 §4），与默认档互不污染 |

**为什么 L3 进本阶段而不是首片**：L3 的**下发时机**与 agent/model 完全同构——未物化可选、随 create **一次性下发**、物化后由会话快照接管，**共用同一个物化点**（首条 `sendMessage()` commit）与同一条 wire 时机，分开做等于把同一语义实现两遍；而 L4 不同构（需要新协议 + 中途生效），故切出去。（**注意**：改判 #11 之后写侧只在 Settings（全局模板），Context 面板恒只读、不进 Composer 底栏，S3 **不存在** per-session 权限控件，因此「三者共用锁定判据」这个理由已不成立，不再引用——锁定判据的消费者见 §3.3 的三处。若 §8.0-Q1 拍板改回 Context 面板未物化可写，则本条恢复。）

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

**落点：定稿推荐案（未拍板）—— 见 §8.0-Q1**。仲裁档只裁定了**持久化位置**（app settings 独立区 / 不复用终端轴 AgentSettings / 不写 `~/.codex/config.toml`，仲裁 §1 第 5 项），**写侧 UI 落点仲裁档未裁**（§2.2 五项裁定与 §4-2 的 B 稿吸收清单均不含此项），A 稿把它列为需用户拍板的 Q1 并推荐 (a) Context 面板未物化可写。本节以下为**定稿推荐案 (c) Settings 区**的理由；**拍板前施工方不得按本节动工写侧 UI**（L1 读侧 + L2 capabilities 补键不受影响，可照常开工）。

**推荐案**：入口放在 `AISettings` 下新增 **Chat agent defaults** 区，**不进 Composer 底栏、不进 Context 面板**。

- **不进 Composer 底栏**：三个 pill 挤在 `h-6` 底栏会撑爆 `@[30rem]` 窄形态（codeg 都要折叠成 Popover，调查 03 §4）；且本片只有创建时一次性下发，**放在每回合都看得见的高频位置会暗示它随时可改**——那是关于产品的谎言（同 `composerModel.ts:91-93` 的规矩）。
- **不进 Context 面板（本推荐案与 A 稿 Q1 推荐 (a) 的分歧点）**：该数据是「新会话默认模板」而非「本会话事实」，而 Context 面板承载的是 **Host 回声的事实**（Policy）；把可写模板放进事实面会让同一行既是请求又是回声——B 稿标 blocker 的「preference 被当作 runtime fact」正是这个形状。
  > **A 稿的反对理由（拍板前必须一并呈给用户，不得只给推荐案）**：权限档决定 agent 动手前问不问你，**建会话当时**才是用户想设它的时刻；放进全局 Settings 意味着「改一次影响此后所有新会话」，用户要为单次会话调档就得去 Settings 改完再改回来。A 稿的 (a) 用「未物化可写 / 物化后只读」把请求与事实放在同一面但用锁定态区分，代价是同一行两种语义。
- **不复用终端轴 `AgentSettings.tsx`**：后者管理终端/CLI `BuiltinAgentId`、custom/hapi/happy agent，复用会破坏三轴隔离（`AISettings.tsx:26-66` 的 provider/模型静态面**不得**被误当 `AgentWireName`）。

设置区按 agent 两张小卡：

**Claude Code** — Permission mode：`default / acceptEdits / dontAsk / bypassPermissions / plan`（`SessionPermissionMode`，`runtimeEvents.ts:506-511`，**冻结类型不动**）。
**不加 SDK 的第 6 值 `'auto'`**：调查 02 §6-4 明确其行为未实证，且可能需额外开关（类比 `bypassPermissions` 需 `allowDangerouslySkipPermissions`）；随 S4 探针一并处理。

**Codex** — Approval policy `untrusted / on-request / never` + Sandbox mode `read-only / workspace-write / danger-full-access`。
**Network：只读 `Reported by runtime`，本片不给控件。** `networkAccess` **不是 `thread/start` 的请求字段**（`codexRuntime.ts:122-132`，只在响应回声里，由 `compareSandboxEcho:594-665` 校验），只能经隔离 config.toml 投影生效（`codexHome.ts:149-163`、`:173-178`、`:412`）；给了控件就要改 config.toml 写手，而 resume 姿态是从 config.toml 重派生的（`:2952-2954` H9），会波及 resume 回声校验。

**危险档 `bypassPermissions` / `danger-full-access`：推荐案（未拍板）—— 见 §8.0-Q3**。定稿推荐 = **给控件**（不给等于替用户决定他不能用，且 codeg 给了）+ **warning 文案** + **二次确认** + **绝不做默认值**（= A 稿 Q3 推荐 (a)，B 稿同向）。该项涉及安全姿态扩权，仲裁档未裁，按 05 简报设计要求 6「需用户拍板项单列（含推荐案）」列入 §8.0；未拍板前施工方**先做非危险档**（Claude `default/acceptEdits/dontAsk/plan` + Codex `untrusted/on-request/never` × `read-only/workspace-write`），危险档控件留空位。

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

**不得写**：终端轴 `AgentConfig`（key 是松散 terminal agent id）· `chatSessions.ts` 的 runtime facts（会话索引只保存「请求偏好」，不冒充实际回声）· **用户真实 `~/.codex/config.toml`**（Host 使用隔离生成文件并声明用户 posture 不继承，`codexHome.ts:123-140`；这条同时受 §1.2 运维铁律约束）。

**wire 与运行时**：

- `SessionCreateCommand.payload`（`agentHost.ts:61-77`）与 resume 命令加可选 `permissionPreference?: SessionPermissionPreference`（判别联合，agent 位自带）。
- **约束**：payload 的 preference `agent` 必须等于 `sessionAgent(session)`，不匹配在 Main/Host dispatch **之前**拒绝，不让 runtime 自己猜。首发 create 用草稿 snapshot；resume 用 session-index snapshot；两者都缺失才用 runtime 安全默认。
- Claude：`CHAT_PERMISSION_MODE`（`claudeRuntime.ts:215`）与 Codex：`CODEX_PERMISSION_DEFAULT`（`codexRuntime.ts:134-144`）**保留为默认值不删**（它们是 `:204-214` 自陈的「单一真源」，参数化的正确做法是给它一个覆盖入口，不是把常量拆了），`claudeRuntime.ts:341` / `codexRuntime.ts:1547` 改为「有则用、无则常量」。
- Claude：session 值进 `query()` options，`session.created/resumed` 回声同一值。
- Codex：`state.policy` 与 `buildThreadStartParams` 使用它；隔离 `config.toml` 继续写 approval/sandbox 以保证 resume 重派生与 H9 回声校验一致（四处同值：thread/start · isolated config · state.policy · Context 回声）。
- Host `SessionRegistry` 增加可选 policy 存储位，create/resume 合并规则与 model/effort 同类，**但 agent 不可变**。
- `networkAccess` 不由 renderer 偏好提供；Host 继续记录/回声实际值；若输入里出现伪造的 `networkAccess`，**拒绝而不是假装已控制**。

### 5.6 S3 Happy Path

1. **Codex 读侧闭环**：Codex 会话建立 → `session.created` 带 `permissionPolicy:{agent:'codex',...}` → Context 面板出现 `Permission policy` 三值行（**今天这行整个消失**）。
2. **Claude 无回归**：打开旧 Claude 会话（只有 legacy `permissionMode`）→ Context 行输出与今天逐字一致。
3. **写侧模板**：Settings 选 Claude `plan` → 新草稿首发 → create 携带 preference → `query()` 用 plan → Host 回声 → Context 显 Plan → session-index 记下该会话快照。
4. **Codex 写侧**：Settings 选 `untrusted + read-only` → 新草稿首发 → thread/start 与隔离 config 同值 → Context 显三维事实。
5. **Codex resume**：不依赖旧 event 猜值，从隔离 config 重派生并经 H9 校验；校验成功后事实事件到达 renderer，权限行不再消失。
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
| C11 | Claude：`query()` option、`session.created` 回声、registry 值三处来自同一 preference；Codex：thread/start、isolated config、`state.policy`、Context 回声四处 approval/sandbox 同值 | 四处同值断言（H9 形状） |
| C12 | Settings 更新**不调用任何 active-session mutation IPC**；`PermissionQaCard` 响应不写 chat defaults | spy 零调用 |
| C13 | 危险档：`bypassPermissions` / `danger-full-access` 有 warning 且**不可能成为默认值**；chat permission 不落终端轴 `agentSettings`（轴隔离静态扫描） | 设置模型真值表 + 静态扫描 |
| **C15** | **hydration 前不物化（§5.5-3）**：settings 未 hydrate 时首发 → session-index 该行**无** `permissionPreference` 字段（或首发被显式等待到 hydrate 完成后才物化），**绝不写入 `defaults.ts` 的出厂值**；hydrate 完成后首发 → 物化的是用户实际设置 | 时序双臂 |
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

---

## §6 S4 — 会话中途改权限档（**条件切片**）

> **本片在探针出结果之前，一律不得进入施工范围。规格写它们是为了钉住「探什么、什么算过」，不是为了排期。**
> S4 先提交探针（只含 fixture / 测试工具 / 报告），结论成立后**另提**实现提交。**S4 不得反向阻塞 S1~S3，也不得把未成立的能力写进 UI。**
> 一切打 cch / 真机的探针受 §1.2 运维铁律约束：事前报测试项与预计用量、最小 payload、只读优先、不碰本地全局配置。

### 6.1 条件 A：Claude SDK `Query.setPermissionMode()`

- **探什么**：① 纯文本字符串 prompt（非 streaming input）下调用的真实失败模式——抛异常 / 静默无效 / 自动切换；② prompt 固定改为 streaming-input 后，首回合/空闲期调用是否生效；③ active turn 调用的时序与失败模式；④ 第 6 值 `'auto'` 是否真实可用、是否需额外 flag。
- **为什么必须探**：`claudeRuntime.ts:33-36` 把 `queryFn` 类型收窄成 `AsyncIterable & {close?}`，**类型上抹掉了 `setPermissionMode`**；且 prompt 只在有附件时才是 AsyncIterable（`:706-708` 三元），纯文本走字符串 → **我们大多数回合都不满足 SDK 文档写的 streaming-input 前提**。
- **过的判据**：纯文本场景下调用后，**下一个回合的实际权限行为**与新档一致（"没抛异常" 不算过——静默无效恰恰不抛），需要一个会触发权限询问的真实回合做对照臂；且错误可确定性归类。
- **不过怎么办**：Claude 半边取消，或退到「改档需要重开会话」（与 Codex 半边对齐，安全态）。
- **成立后的最小实现**：Composer model 菜单旁增 Claude permission selector，**只在 idle 启用**（active turn 时 disabled，不引入权限 mutation queue）；走专用 `chat:setPermissionPreference` runtime command；成功事件更新事实 store，失败**不改 Context**。
- **扩权红线**：若必须把所有 prompt 改成 streaming-input，那是 query 输入架构改造，**需单独用户拍板**，不得在 S4 自动扩权。

### 6.2 条件 B：Codex `thread/settings/update`

- **现有证据强度 = 仅方法名**：`codex-method-contract.json` clientRequest[110] 有它（已复核命中），`serverNotification` 有 `thread/settings/updated`，但**零 schema 样本零调用**；contract 头部自陈 L6 欠采（clientRequest 实录 121 vs 实际 126）；`CODEX_METHOD`（`codexWire.ts:85-96`）十方法不含它。
- **探什么**：完整 request schema / response / notification fixture；能否中途改 `approvalPolicy`/`sandboxMode`、是否支持 network；对下一 turn 与当前 pending approval 的作用边界；与 `turn/start` sticky 字段冲突时谁优先；当前 method-contract 欠采是否需升级 Codex CLI/fixture。
- **过的判据**：binary-generated schema（`codex app-server generate-json-schema` 是否输出它）**且**至少一个真实 thread 的 before/after 回声，且 resume 后姿态规则可解释。
- **成立后的最小实现**：**扩 `CODEX_METHOD` 前先提交 contract fixture**；只开放 schema 明示且实测成功的字段；idle-only；成功 notification 后更新 `state.policy` 与 runtime facts。
- **备选路（`turn/start` sticky 覆盖）**：schema 层已确认 `approvalPolicy`/`sandboxPolicy` 是 `turn/start` 合法字段（`codexRuntime.ts:246-249`），若 B 探不通，它是更可能成立的备选。**但权限姿态还有 config.toml 这第三个载体（H9），比 §4.6 的 model 情况更糟** → 走这条路必须回到用户拍板：是否接受「下一回合及后续回合生效」的 selector 语义，**不得自行把它包装成即时设置**。两条都不通时，**Codex 半边明确不做**，不硬上。

### 6.3 S4 Happy Path · 断言 · 变异

- **探针不支持**：产品 UI 中**不存在** active-session selector；Settings 新会话默认仍可用；报告明确写 NOT-SUPPORTED（这是可交付结论，不是失败）。
- **探针支持**：idle 改档 → protocol success → 下一回合采用新档 → Host 事实事件 → Context 更新；**任一步失败均保持旧事实**。
- **断言**：active turn 时控件 disabled；协议 error 不得被吞；Settings 默认值不得被当作 active fact；`CODEX_METHOD` 扩项必须有 committed fixture 才允许存在。
- **变异候选**：先乐观改 Context（协议未回就更新）→ 事实/请求隔离断言红；忽略 protocol error → 失败保持旧事实断言红；把 Settings default 当 active fact → 隔离断言红；无 fixture 就扩 `CODEX_METHOD` → 契约门禁红。

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
| R8 | **D40 补 model 后出现 thread/start 与 turn/start 双真源** | major | 覆盖成功但不回写会话状态 | 后续回合/resume 用哪个值无定论 | §4.6 防线 ②（成功后事务式回写）+ **B8（生产侧）+ B14（消费侧：revive/resume 读回写值，分叉场景双臂）** + 变异 ⑥⑬；**防线 ① 探针未过则退回只补 effort 并回报用户** |
| R9 | **stale cache 被误标 fresh / 种子表伪装成可用目录** | major | refresh 失败仍更新 `fetchedAt`；或用静态表当 fallback | 用户选到已下线模型，或以为目录正常 | `source`/`stale`/`fetchedAt` 明示 + UI「目录不可达」+ B1/B3 + 变异 ①④ |
| R10 | **家族白名单在 renderer 侧实现或被绕过** | major | 过滤层不在 Main 响应层 | 白名单与种子表两处规则漂移，renderer 见到未过滤目录 | §4.2 落点写死 Main 过滤层 + B9 表驱动 + 变异 ⑧ |
| R11 | **legacy 短名被自动映射** | major | 迁移时猜 `sonnet → claude-sonnet-5` | 升级后静默换模型且不可回滚 | §4.4 legacy 合成项 + B5 storage 字节快照 + 变异 ⑦；**目录外存量全名走 §4.4-6 的 unverified 前插 + B16 + 变异 ⑮**（白名单过滤是 R11 的第二个入口） |
| R12 | **capabilities 不带原因，UI 过度承诺** | major | 文案写「flag 未开启」 | 误导用户去改一个不存在的开关 | N2 → 文案用 generic `Unavailable in the current Host`；old Host 单独可判 + A1 |
| R13 | **per-agent 与 per-session 偏好互相覆盖** | major | 单一 map 没有两层语义 | 切 agent 或切 session 串值 | §4.3 两层优先级 + key 含 agent + B12 + 变异 ⑪ |
| R14 | **resume 不发 Codex policy，权限行再次消失** | major | 打开恢复会话 | 读侧闭环白做 | H9 校验成功后补事实事件（§5.6-5）+ resume regression C5 |
| R15 | **S4 先实现后探针** | blocker | 猜 schema / 猜 SDK 行为 | 错协议或静默无效 | fixture/probe 是硬 gate，条件项独立提交（§6） |
| R16 | **flag-off 发布形态改变（不只是评审误判）** | minor | 改判 #3 后 flag-off 也在 empty 模式渲染置灰 Codex 段 | 评审以为 off 轮不该有变化；且 **§1.1-4 禁 renderer 按 flag 分叉 → S1 没有独立 UI 回退杆**，唯一回退是整片不合入 | §3.4 已写明 off 轮断言口径改为「两项渲染 + codex disabled + reason」，并把「flag-off 上架置灰段」记为**已知并接受的发布形态**（仲裁 §1 disable-not-hide 的直接后果）；已锁定会话只有单段 chip，不受影响 |

---

## §8 未决表与遗留登记

### 8.0 需用户拍板（不自行扩权，含推荐案 —— 05 简报设计要求 6）

> 以下三项**仲裁档未裁**（仲裁 §1 只裁了权限数据的**持久化位置**，§2.2 五项与 §4-2 吸收清单均不含写侧 UI 落点与危险档控件），定稿不得自裁。**Q1/Q3 阻塞 S3 的写侧（L3）**，不阻塞 S1/S2 与 S3 的 L1/L2；Q4 只影响 S4 排期。

| # | 问题 | 背景（这东西是干嘛的 / 别人怎么做） | 选项 | **定稿推荐** | 阻塞面 |
|---|---|---|---|---|---|
| **Q1** | **写侧权限控件落在哪？** | 权限档决定 agent 动手前问不问你。codeg 放 composer（因为它**能中途改**）；我们 L4 不做，只有创建时一次性下发。放 composer 会暗示随时可改；放 Settings 则「改一次影响此后所有新会话」，为单次会话调档要去 Settings 改完再改回来（A 稿反对理由） | (a) Context 面板未物化可写、物化后只读（**A 稿推荐**）(b) Composer 底栏第三个 pill (c) `AISettings` 新增 Chat agent defaults 区（**定稿推荐**） | **(c)**：理由见 §5.4（数据是「新会话默认模板」而非「本会话事实」，Context 面板承载 Host 回声事实，混写会让同一行既是请求又是回声 = B 标 blocker 的形状）。若选 (a)，§5.1 的「共用锁定判据」理由恢复成立、§3.3 的锁定判据多一个消费者 | S3-L3 |
| **Q3** | **`bypassPermissions` / `danger-full-access` 两个危险档给不给控件？** | 这俩是「agent 干什么都不问你」。Claude 侧 SDK 另有 `allowDangerouslySkipPermissions` 开关；codeg 全给了 | (a) 给 + warning + 二次确认（**A 稿推荐，定稿同向**）(b) 给 + 藏在 Settings 高级区 (c) 不给 | **(a)**：不给等于替用户决定他不能用；但**默认值绝不能是它们**（C13 钉死）。未拍板前先做非危险档，危险档留空位 | S3-L3 |
| **Q4** | **S4 的两条探针（P2/P3）什么时候跑？** | 两条通道都只有「名字存在」级证据，探一次要一轮真机 + cch 用量报备（§1.2） | (a) D48 开工前一并跑 (b) S1~S3 收口后与真机补测批合跑（**A 稿推荐**）(c) 明确不做 | **(b)**：S1~S3 的价值不依赖它；探针要真机轮，与既有真机补测批合跑更省用量。**P1 不在此列**——它是 S2 前置，必须先跑 | S4 排期 |

> 按「拍板要当场直接问」纪律：本节落库后须**当场向用户提问**并把结论回填到本表与 plantree（`docs/plantree/plans/multi-agent/roadmap.md` 的 D48 行 + `open-questions.md`），不得只留档。

### 8.1 真未决（施工前必须处理，全部为**探针**，均受 §1.2 运维铁律约束）

> **档位不同，别混读**：**P1 = S2 施工前置（阻塞 S2，不阻塞 S1）**；**P2/P3 = S4 前置，不阻断 D48 收口**（§2/§6 已定 S4 为条件切片）。**D48 开工（S1）不需要先跑任何探针**；P2/P3 的排期见 §8.0-Q4 推荐（与真机补测批合跑，S1~S3 收口后再按 §1.2 报备用量）。

| # | 未决项 | 归属 | 预期 | 不成立时的安全态 |
|---|---|---|---|---|
| **P1** | **`turn/start` 覆盖 model 的 sticky 行为**：覆盖是否延续后续回合、与 `thread/start` 值及 resume 重派生的关系、官方 CLI `/model` 用的是不是这条路 | S2 施工前置（§4.6 防线 ①） | **预期是「确认 CLI 同款行为并抄其报文形状」**，不是「验证是否可行」——用户已实证官方 codex CLI 支持中途 `/model`，「覆盖即新默认」有官方先例。**照抄不猜**：需看清 CLI 用的是 `turn/start` 覆盖还是别的方法 | 推翻「覆盖即新默认」→ **回退到只补 effort 并回报用户重拍**（不得自行改语义） |
| **P2** | **Claude SDK `Query.setPermissionMode()`** 在纯文本 prompt 下的真实失败模式（含 `'auto'` 第 6 值） | S4 条件 A（§6.1） | 未知；类型上已被 `claudeRuntime.ts:33-36` 抹掉，且多数回合不满足 streaming-input 前提 | Claude 半边取消，或退到「改档需重开会话」 |
| **P3** | **codex `thread/settings/update`** 的 schema / 中途改档能力 / 作用边界 | S4 条件 B（§6.2） | 证据强度仅方法名；备选路 `turn/start` sticky 覆盖需用户另行拍板语义 | 两条都不通 → **Codex 半边明确不做** |

### 8.2 遗留登记（不阻塞施工，不进本阶段）

| # | 项 | 处置 |
|---|---|---|
| L1 | 三态琥珀点（扩 wire 发 `HostAgentDetail.reason`） | 仲裁裁定不做。要做须把 Host 内部诊断（`agentSupport.ts:227-237` 四条 reason，含「pairwise 非包含」纪律）变成对外契约 → 等真实需求（用户自己装了 codex 但没生效且高频） |
| L2 | 目录磁盘快照（跨重启离线目录） | 本阶段只做进程内 cache。要做须先设计来源/年龄 UI，否则昨日目录会冒充当前真源 |
| L3 | `model/list` 的 per-model `supportedReasoningEfforts` | §4.3 本片不读。将来出现「某模型不支持 xhigh」的真实故障再开 |
| L4 | `turn/start` 的 `effort` 是否 sticky（schema 未明说） | 即使 sticky 也与 Claude 轴现有行为一致（`claudeRuntime.ts:514-522` 把新 model 写回 session 默认），不构成阻断；且防线 ② 的回写已覆盖同一形状。S2 GUI 点验时顺手观察 |
| L5 | 种子表随时间过期 | 调查 04 是单日快照；四级回落使设计不依赖它长期为真，但**每次发布前对一次**（`seedCatalog.ts` 头注写明采集日期） |
| L6 | 存量短名的自然衰减速度 | §4.4 迁移靠用户下次点击。若长期仍大量残留且 SDK 翻译层变了，届时才需写迁移（那时会有真实映射证据） |
| L7 | Claude 统一改 streaming-input 的架构成本 | S4 条件 A 若要求它，须单独用户拍板与回归评估（§6.1 扩权红线） |
| L8 | Context 面板内联的「未物化可写」权限控件 | **落点未拍板（§8.0-Q1）**：定稿推荐把写侧收在 Settings（改判 #11 的推荐案）。若 Q1 拍成 (a)，本条即为实施项而非遗留项；若拍成 (c) 而后续用户反馈「建会话时就想改」，再评估把 Preference 编辑器嵌入 Context 的只读行上方 |

---

## §9 边界重申与验收清单

### 9.1 本阶段明确不做

多 agent 协同 / 同会话切 agent · 终端轴 `AgentPickerMenu`/`SessionBar`/`AgentSettings` 任何改动 · 2b 打包链（阶段 4）· git surface 扩展（open-q #4）· 提问坞单槽（open-q #10）· cch 服务端 / 供应商配置 / 模型重定向表改动 · ACP 通道与 config_options（D45 已定直连）· 猜测或模拟 `thread/settings/update` 与 SDK 实时权限协议 · 会话中途改权限档（S4 条件执行）· `networkAccess` 写侧 · SDK `'auto'` 权限档 · 目录搜索/虚拟化 · 目录磁盘快照。

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
- [ ] Settings 可保存两轴新会话默认权限（**落点以 §8.0-Q1 拍板为准**）；active Context 只显示 Host 实际回声；**settings 未 hydrate 时不物化权限快照**。
- [ ] `networkAccess` 无假写控件；单次审批与会话默认权限互不污染。
- [ ] S4 未有探针 PASS 时，产品中不存在中途权限 selector。

### 9.3 工程验收

- [ ] `AgentWireName` / `BuiltinAgentId` 静态隔离断言保持绿色。
- [ ] `chatSessions.ts` 只有 `setDraftSessionAgent` 等必要加法（**零新字段**）；目录/权限 facts 走 adjacent store / Main service。
- [ ] 新增纯模块（`sessionBinding.ts` / `composerAgentPickerModel.ts` / **`src/shared/models/familyWhitelist.ts`**，路径见 §4.2）已加入 `pureModuleImports.test.ts` 的 `TARGET_FILES`（相对 `src/renderer/components/chat/__tests__/` 的路径，跨目录条目已有先例）。
- [ ] IPC/shared/session-index 字段均为兼容性可选加法；old Host / old snapshot 各有回归。
- [ ] secret scan 证明 catalog 日志与 renderer payload 不含 key/token/完整 auth URL。
- [ ] 每片 Happy Path、确定性过程断言、变异对**逐对实跑并抄红灯原文**；flag off/on 双轮各跑。
- [ ] 每片分别逐门通过 `typecheck → typecheck:agent-host → lint → test`（串行），基线 208 文件 3973 例 0 红不倒退。
- [ ] 所有探针执行前已按 §1.2 报备用量并获批准；施工全程未触碰本地 `~/.claude/`、`~/.codex/` 与开发服务器 env。
- [ ] 收口按规范第 15 条更新 D48 台账、plantree 状态与证据链接（由实际施工票执行，本规格不预改其他文件）。
