# D48 双轨合取仲裁 — Codex CLI 选择功能设计定稿依据

> 2026-08-16。输入 = [A 稿（Opus 轨）](./design-track-a.md) + [B 稿（Codex 轨）](./design-track-b.md)，双盲独立作答。
> 仲裁纪律：互补反例合取而非二选一；回退分支必须退到安全态；风险项写成条件执行（实现方保留否决权）。

## 1. 双轨独立收敛项（直接定稿，置信度高）

| 项 | 两轨一致结论 |
|---|---|
| 切片骨架 | picker+绑定 → 目录真源+D40 → 权限读侧+写侧默认档 → 中途改档**条件执行**（A 并进 S3 探针 / B 单列 S4 条件切片——采 B 的单列形式，边界更清晰） |
| 目录服务归 Main | 双轨同证：凭据只在 Main CredentialVault，agent-host 无 baseUrl（A `hostEnv.ts:64-75` 八键实证）；范式照抄 `UsageService`；**独立 IPC，不塞 `host.ready`**，key 不进 renderer |
| 短名不自动猜全名 | 存量 `sonnet/haiku/opus` 保留为 Legacy alias 合成项，用户改选后只能写全名或 Automatic（B 措辞）；不做静默映射迁移（A 同判） |
| picker 不可用项显示而非隐藏 | 置灰 + 说明（`runtimeEvents.ts:104-108` 类型注释本就写 disable 而非 hide）；old Host 无 capabilities 字段 → legacy Claude-only 降级 |
| 权限写侧首期只管创建/恢复默认档 | 不做中途改档；`networkAccess` 只读（服务端回声非请求键）；持久化到 app settings 独立区，不复用终端轴 AgentSettings、不写用户 `~/.codex/config.toml` |
| 中途改档两通道 | SDK `setPermissionMode` 与 codex `thread/settings/update` 均须探针先行，探针不成立则该轴不做实时 selector，不阻断 D48 收口 |

## 2. 分歧裁定

### 2.1 D40 Codex 半边：model 补不补（唯一真分歧 → 用户拍板）

- **A 轨：只补 effort，不补 model**。三条理由：① model 的 `turn/start` 覆盖是 sticky 的 → 与 `thread/start` 形成**双真源**，不一致时谁赢无证据；effort 则 `thread/start` 根本不发，补上是唯一真源；② Codex 换 model 的正确做法 = 新会话（与 D48 ② 物化锁定同构）；③ Claude 轴补 model 是因为每回合重开 CLI 有回落漂移压力（`agentHost.ts:91-96`），Codex 长驻 app-server 无此压力——同一票号两轴正确解不同。另附负控断言防后来者「顺手补全」。
- **B 轨：model/effort 都补**。理由：调查 04 已消除丢弃前提；`thread/start` 管初始值、`turn/start` 管本回合覆盖并按 schema sticky 语义成为后续默认——即接受「覆盖即新默认」为单一语义，不视为双真源。
- **用户拍板（2026-08-16 当场）：采 B——model/effort 都补**（双轴行为对称优先）。
- **用户补充佐证（同日）**：官方 codex CLI 本身支持会话中途 `/model` 换模型与 effort——后端同为 app-server 长驻 thread，即「中途覆盖 model」是上游一等公民路径，「覆盖即新默认」有官方先例。A 轨双真源担忧进一步降级；下方探针 ① 的预期从「验证是否可行」转为「确认 CLI 同款行为并抄其报文形状」（探针仍保留：需看清 CLI 用的是 turn/start 覆盖还是别的方法，照抄不猜）。
- **A 轨反例按仲裁纪律转为条件执行防线（不丢弃）**：
  ① **探针先行**：施工前用真实 thread 实证 `turn/start` 覆盖 model 的 sticky 行为与 thread/start 值的关系（覆盖后续回合是否延续、与 resume 重派生是否冲突）——探针推翻「覆盖即新默认」则回退到只补 effort 并回报用户重拍；
  ② **单一语义写死**：turn/start 覆盖成功后，运行时须把新 model 写回会话状态（对齐 Claude 轴 `claudeRuntime.ts:514-521` 的回写模式），使 thread/start 值不再被任何路径读作真源——消双真源靠回写收敛，不靠禁止覆盖；
  ③ **A 轨负控断言保留**：中途换 model 路径必须有显式测试与变异对（今天零覆盖正是双真源分叉无人能测的原因）。

### 2.2 已裁定项（编排者合取，附理由，实现方保留否决权）

| 分歧 | 裁定 | 理由 |
|---|---|---|
| 不可用三态 vs 二态 | **首期二态**（在列/置灰不可用），琥珀点式三态**不做** | A 轨新发现 N2：`HostAgentDetail.reason` 不过 wire，三态在当前协议不可表达；扩 wire 是可选加法 → 进遗留表，等真实需求 |
| 目录回退链 | fresh → 进程内 stale cache → **内置种子表（标注 `source:'seed'` 且 UI 显示「目录不可达」）** → Automatic+Retry | 用户拍板 #5 指定三级回落含种子表；B 轨「不得伪装可用目录」的关切以 source 标注 + UI 提示吸收（合取而非二选一）；A 轨补的凭据窄口（vault locked 时直接走种子表不卡）纳入 |
| 锁定判定与时机 | 判定复用 `computeEverHostBound`（A 轨 N3，须提取导出防三控件漂移）+ 时机在 `onSendStart()` 同步提交点（B 轨） | 两轨各答了半边，互补合取 |
| 权限读侧早退陷阱 | S3 的 `permissionPolicy` reduce 必须放在 `isSessionPermissionMode` 早退**之前**，断言点照 A 轨 §4.3-A2 | A 轨 N4 独有发现（D33 有前车之鉴注释） |
| `capabilities.permissionPolicy` | Host 补发（类型已存在、Host 忘接——A 轨 N1），作 S3 降级闸门 | 白捡的现成开关 |

## 3. 追加拍板 #5 强制执行（两轨均未吸收，开跑早于拍板）

模型展示面 = **家族规则白名单 + 动态推导**：Claude 轴 haiku/sonnet/opus 三族各最新（优先无日期别名）；Codex 轴最高世代（现 5.6）全部变体，排除 `gpt-image-*`/`codex-auto-review`/`-mini`。规则硬编码、型号动态推导；全新家族名默认不上架。**落点 = Main 目录服务的响应过滤层**（renderer 收到的已是过滤后目录）；种子表 = 过滤后六条（claude-haiku-4-5 / claude-sonnet-5 / claude-opus-5 / gpt-5.6-sol / -terra / -luna）。两稿的目录数据形状按此收窄，定稿时改写对应章节。

## 3.5 运维铁律（用户 2026-08-16 原话强调，约束全部后续探针与施工）

- **绝不更改开发机本地 `~/.claude/` 与 `~/.codex/` 配置文件；绝不用 cch 远端获取的密钥覆盖本地配置。** 本机 Claude Code 走官方订阅用量；cch 是公司付费按量 API（昂贵），两套凭据体系不得互串。
- 一切打 cch 的探针（含 S2/S4 的 model sticky 探针、`thread/settings/update` 探针）：**事前向用户报测试项与预计用量**，批准后以最小 payload 执行；只读端点优先。
- 被测 app 的托管凭据链（D47 vault）只写 `<userData>/credentials` 与 app 私有 home——施工中若发现任何路径会写用户全局配置，即为缺陷，当场拦。
- **本地不得主动拉起完整 app 走注册/登录流程做测试**（历史上正是这条路把 cch key 写进了开发机 `~/.claude/settings.json`）。各切片 GUI 点验：确需拉起时 URL 用测试方案（mock-cch / 测试环境）并以进程注入植入，不修改开发服务器 env 与任何本地全局配置；登录态相关点验优先用免登录/免额度手段（借 rollout、fixture 回放）。

## 4. 拍板记录

1. **D40 model 半边 = 都补**（用户拍板 2026-08-16，见 §2.1 条件执行防线三条）。
2. 定稿以 A 稿为底本，吸收 B 稿的 S4 单列、`onSendStart()` 锁定时机、回退措辞、ghost chip 设计 token 引用，并强制执行 §3 家族规则白名单。
3. **§8.0 三项拍板（用户 2026-08-16 当场逐卡敲定，覆盖 rev.2 的推荐案与切片形状）**：
   - **Q1（连带改判切片形状）：中途改权限档 = 必做需求**（用户原话「肯定要支持中途改啊」，理由与 D40 同构：官方 CLI 两侧都支持中途改档，后端即同一 CLI 运行时）。**S4 从条件切片升格为正式切片**；写侧 UI = **Composer 实时控件（管当前会话，中途可改）+ Settings「Chat agent defaults」默认模板（管新会话起点）双层**，与 codeg 同构。本条推翻 rev.2「写侧只做创建时一次性下发」的前提与 §1-收敛表「权限写侧首期只管创建/恢复默认档」行（该行按本条改判）；探针 P2/P3 性质从「定可行性」转为「定报文形状」。技术候选：Codex = `turn/start` sticky approvalPolicy/sandboxPolicy 覆盖（schema 已承认）或 `thread/settings/update`；Claude = 每回合重开 CLI ⇒ per-turn `query()` options 下发 permissionMode（与 D40 model 同形状，绕开 `setPermissionMode` 的 streaming-input 前提）。
   - **Q3：危险档给控件 + warning + 二次确认，默认值绝不是危险档**（断言钉死；与 A/B 两轨及定稿推荐一致）。
   - **Q4：开工前 P1/P2/P3 三探齐发**（用户批准 Codex 侧 cch 用量 ≤8 发最小回合；P2 优先代码级验证 per-turn 下发路径，必要时才补真机回合）。
