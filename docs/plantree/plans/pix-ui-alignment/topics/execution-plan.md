# Topic — 执行计划（U01–U09 切片、顺序、验收）

> 2026-09-03 制定。`roadmap.md` 仍是任务 ID 与状态的唯一权威；本文件只提供**执行形态**：
> 切片划分、批次顺序、每片的改动落点与验收标准、门禁与跨计划依赖。
> 前置已满足：Pi-only 计划 T37 已关闭（manual CI run `33714362901` 全绿），D01 决定二的排期闸门解除。

## 一、开工前锚点复核（2026-09-03）

[current-state-audit](./current-state-audit.md) 要求动工前复核行号漂移。本轮复核结论：

- **审计结论整体成立**：`surfaceRegistry.ts` 仍无 `run`；`PersistedShellLayout`（`shellLayoutModel.ts:405`）仍无布局模式字段；`deriveChatEmptySurface`（`chatEmptyState.ts:46`）仍在无 workspace/cwd 时挡住发送；TUI 分支（`ChatWorkspace.tsx:266`）仍是 `presentationMode === 'tui' && activeWorkspacePath`，只换中栏。
- **一处审计过时，U08-2 比原判小得多**：Pi 七档词汇与按模型过滤**已有一半落地**——`configValidation.ts:10` 的 `THINKING_LEVELS` 已含 `off`/`minimal`，`piModelConfig.ts:50` 与 `agentCatalog.ts:31` 的 `thinkingLevelMap` 已覆盖七档，`efforts.ts:114-118` 已按 `thinkingLevelMap` 过滤档位。真缺口只剩两个常量：`SESSION_EFFORT_LEVELS`（`agentHost.ts:7`）与 `CHAT_EFFORTS`（`efforts.ts:25`）都只有五档。
- **U08-3 的可行性未取证**：全仓源码对 `serviceTier` 零命中成立；唯一命中在 `pi-coding-agent` 自带的 OpenAI SDK 里。我方 `piModelConfig.ts:53-54` 声明了 `samplingParams` / `compat` 两个透传口，但 `piWorkerSession.ts` 未消费它们——**注入点存在与否未证实**，见 [Q09](../open-questions.md)。

## 二、批次与顺序

顺序原则：先改全仓生效的样式地基（避免后续切片在旧档上返工），再做结构层，最后做增量面板。

| 批次 | 内容 | 切片 | 阻塞 |
|---|---|---|---|
| 1 | 视觉地基 | U01-a/b/c/d | — |
| 2 | Composer 形态 | U09-1、U09-2 | 批次 1 |
| 2.5 | 会话级权限档 | U12 | 批次 2（占 U09-2 留的位） |
| 3 ✅ | 布局模式 | U02-a/b、U03-a | 批次 1 |
| 4 ✅ | 免绑定开聊 | U05-a/b/c/d、U03-b | 批次 3（U03-b） |
| 5 ✅ | 控件语义 | U08-2 | — |
| 5.5 ✅ | 免绑定会话可见性 | U13 | 批次 4（承 `unbound` 语义） |
| 6 ✅ | 面板 | U06-a、U07 | 批次 3 |
| 7 ✅ | 左栏入口 | U04 | — |
| 8 ✅ | 壳层横条重排与双栏收敛 | U14 | 用户看到实际界面后开的，[D07](../decisions/007-two-column-is-two-columns-and-one-bar-per-column.md) |
| 9 ✅ | VSCode 式壳层重排 + 上下文页 | U15-a/b/c/d、U16 | [D08](../decisions/008-vscode-dock-shell.md) |
| 10 ✅ | 缺陷批（用户报障） | U17、U18、U19 | — |
| 11 ✅ | 占用与 usage | U06-b | 随 Pi 计划 T38 同批（[evidence](../../pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)） |
| — | 已放弃 | U08-3 | [Q12](../open-questions.md) 拍板不做 |

批次 5、7 与前序无依赖，资源允许时可与批次 3/4 交错，但**不与批次 1 并行**（会在旧档上落地）。

> **批次编号在两份文件里对不齐，以本表为准**：[roadmap](../roadmap.md) 把 U15/U16 那批叫「批次 8」、
> 把本表的批次 10 叫「批次 9」，因为它没给 U14 单独编号。任务身份（U 编号）两边一致，
> 只有批次这个流水号有偏移；roadmap 仍是任务 ID 与状态的唯一权威。

## 三、逐切片

### 批次 1 — 视觉地基（U01）— **已完成 2026-09-03**

> 落地记录、实测对比度与门禁结果见 [U01 evidence](../evidence/2026-09-03-u01-style-baseline.md)。
> U01-c 三项经复核后全部未改，原因见下方各条与 [Q11](../open-questions.md)。

**U01-a 字号 / 行高 / 圆角改档**
落点 `src/renderer/styles/globals.css`。`--text-markdown` 15→14px、`--text-code` 13→12px、body 行高设 1.45、`--radius-sm` 8→6px（注意它当前是 `var(--radius)` 的引用，需先看清 `--radius` 归属）、`--radius-md` 12→10px、`--radius-lg` 16→12px。`--radius-xs` 4px 是本仓独有，保留。
验收：① 六个 token 为目标值且 `--radius-xs` 未动；② 全仓没有为绕过新档新增的任意值（`text-[15px]`、`rounded-[8px]` 之类）；③ 阅读列宽 `--max-w-reading`（现 45rem/720px）随 body 由 15px 变 14px 重算 D25 的 CJK 字符数公式，结论写入 U01-d，不允许沿用旧值而不说明。

**U01-b 灰阶 L 阶重映射**
只调 OKLCH 的明度分量，使 canvas < sidebar < panel < hover 的层级关系向 pix 靠拢；**色相角与彩度不动，不换 hex**（[evidence-u01](./evidence-u01-numeric-scale.md)）。
保护项：用户气泡的 `border-input` + `bg-accent` 组合是[已测过的对比度修复](./evidence-u09-component-forms.md)（#4），重映射后必须复测。
验收：① 所有 surface token 仍为暖色 OKLCH，色相/彩度未变；② 四层明度单调；③ 用户气泡、代码块、选中态三处对比度不低于改动前，且正文 ≥ 4.5:1、边框/大字 ≥ 3:1；④ diff 中无 hex 替换。

**U01-c 间距与尺寸档 — 三项全部未改**
- **Composer 内距保持 8px**：与 [evidence-u09](./evidence-u09-component-forms.md) #1 的「保留 8px 内距」冲突，
  按 [D03](../decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定一的先例以 U09 为准；
  代码侧还有第三个理由——现在的对称 8px 正是为取代 A07 那套眼估三值内距而定的（`middleColumnLayout.ts:157-181`），
  且同处有 74px 静息高度契约由测试守着。
- **侧栏行高保持 28px**：D03 决定一已直接拍板。
- **侧栏宽 / 右面板宽 / 阅读栏宽不动**：都是布局尺寸而非样式 token，不在 D01 授权内，转 [Q11](../open-questions.md)。
  阅读栏另有连带问题：正文降到 14px 后 720px 从 48 CJK 当量变成约 51.4，D25 §3.4 原推导失效，
  已在 `docs/design-system.md` 就地标注。

**U01-d 同步 `docs/design-system.md`**
D01 决定：样式层落地后必须同步规范，否则 CLAUDE.md 的强制规范与实现脱节。
验收：字号/圆角/间距分档表与 `globals.css` 逐项一致；每处改动标注来源（U01 + evidence-u01）；无残留旧数值；阅读列宽的重算结论在此落档。

### 批次 2 — Composer 形态（U09）

**U09-1 空会话顶部接合摘列**
把 project / local / branch 摘列做成与输入卡接合的顶盖（[evidence-u09](./evidence-u09-component-forms.md) #1，唯一判定为「改造后搬」的一件）。用本仓 token 与 24px 控件档，**不搬** pix 的 32/28px 控件与 `--bg-composer`。
验收：① 空会话时摘列与输入卡无缝接合；② 有会话时摘列不出现；③ 键盘可达性与焦点顺序不劣于现状；④ 两个态各有测试覆盖。

**U09-2 底栏控件顺序对齐**
左侧「＋附件 · 权限管理」，右侧「上下文占用 · 模型 · 思考 · 发送」（`Composer.tsx:1618-1770` 顺序已核）。只对齐位置与顺序，控件仍用 24px ghost chip。
上下文占用 chip 依赖 U06-b 的 usage 数据，**未落地前不渲染**（不放空壳占位——空壳与「利落简约」相悖）。请求优先级不占底栏（U08-3 已 Dropped）。
**2026-09-05 更新**：该槽已由 `ComposerUsageChip` 填上；「无数据不渲染」这条规则原样保留，
只是现在的触发条件变成「runtime 还没报过占用」（新开会话、重开会话首次回复前、压缩后未回复）。

**原「信任态移入权限 chip」一条作废**（2026-09-03 复核）：本仓 Composer **从来没有**信任态，
`ComposerTargetBar` 只有目录/分支/运行位置三格，没有可移的东西。权限 chip 是新建控件，
已另立 [U12](../roadmap.md)，取证见 [evidence-u12](./evidence-u12-session-permission-tier.md)。
本片只在底栏左侧**留出位置**，不建控件。

验收：① 控件顺序与 `docs/design/a10-pix-ui-alignment-prototype.html` 一致（权限位暂空）；
② 无 usage 数据时占用 chip 不渲染；③ 既有 Composer 测试全绿；④ 左侧留位不产生可见空白或错位。

### 批次 2.5 — 会话级权限档（U12）

**U12 权限档 chip** — 紧跟 U09-2，占它留出的底栏左侧位。
四档（只读 / 务实 / 放手 / 完全放开）作用于**当前对话**，用本仓 `allow`/`ask`/`deny` 规格定义。
机制、边界与五处落点见 [evidence-u12](./evidence-u12-session-permission-tier.md)。

安全敏感，单独成片、单独门禁，不与视觉切片混合。

验收：① 四档各自的授权链裁决有测试（含 `defer` 落回弹窗一路）；
② `path` / `external_directory` 在任何档下都不被放行——这条是发布 blocker，必须有测试；
③ 「完全放开」的文案写明保留密钥与跨目录防线，不使用「无限制」类措辞；
④ 危险档二次确认；⑤ 新会话默认「务实」，档位不跨会话泄漏；
⑥ 既有 permission policy 与 packaged permission gate 全套全绿。

### 批次 3 — 布局模式（U02 + U03-a）— **已完成 2026-09-03**

> 落地记录、验收对照与门禁结果见 [U02+U03-a evidence](../evidence/2026-09-03-u02-u03a-column-mode.md)。
> **字段命名偏差**：下文原写 `layoutMode`，实际落地为 **`shellColumnMode`**——`settings` store 已有
> `layoutMode: LayoutMode`（`'columns' | 'tree'`，最外层仓库/工作树布局），同名不同义会误导；值不变。
> 收敛判定 `isSurfaceAvailableInColumnMode` 下沉到 `surfaceRegistry.ts`，断开与 `shellLayoutModel` 的循环 import。

**U02-a 模式字段与持久化**
`PersistedShellLayout` 增 `shellColumnMode: 'three-column' | 'two-column'`（原文 `layoutMode`，见上），默认 `three-column`；`sanitizeShellLayoutPersisted` 同步（非法值与旧持久化缺字段都回落默认）。
验收：新旧两种持久化各一条测试；默认值不改变任何现有用户的布局。

**U02-b 模式开关与双栏 surface 收敛**
双栏下 rail 只保留 `context`；Files / Git / Terminal / editor **不提供任何入口**（[D02](../decisions/002-layout-cwd-and-evidence-scope.md) 决定一）。切回三栏须恢复原 `railOrder` 与 `lastSurfaceId`。
验收：① 双栏下经 rail、快捷键、命令面板均无法打开被排除的 surface；② 模式往返一次后 `railOrder` 与 `lastSurfaceId` 无损；③ 模式切换有持久化测试。

**U03-a TUI 收起右栏**
TUI 作为双栏的专用子模式：左栏 + 右侧整块 TUI，无第三栏。落点 `ChatWorkspace.tsx:266` 分支与 U02 的模式状态机合并设计。
验收：① TUI 下右栏不渲染；② 退出 TUI 恢复进入前的模式与 surface；③ D19 的 GUI/TUI 单写者守卫行为不变，既有 TUI 门禁全绿。

### 批次 4 — 免绑定开聊（U05 + U03-b）— **已完成 2026-09-03**

> 落地记录、验收对照、变异验证与门禁结果见 [U05+U03-b evidence](../evidence/2026-09-03-u05-u03b-unbound-chat.md)。
>
> **两处与下文原文的偏差**（均已在 evidence §二 展开）：
> ① **隔离目录的落点**：下文 U05-a 验收①写「不落在用户主目录」，实际落在
> `<临时会话基路径>/unbound-sessions/<uuid>`，基路径复用既有「临时会话路径」设置（缺省 `~/JYWAI/temporary`）
> 且用户可在设置里改——**用户 2026-09-03 拍板**，覆盖该条字面要求。agent 的 cwd 仍是新建的空子目录，不是主目录本身。
> ② **档位与信任分层**：下文 U05-c 只写「默认不信任、逐次授权、写路径默认拒绝」，未区分两层。
> 用户 2026-09-03 拍板后落成：**档位**默认「务实」（每次弹窗、可手动切换），**项目信任**强制关闭
> （持久授权无处可写，等价于「授权只对当次生效」）。「写路径默认拒绝」按「不自动放行、每次询问」实现，
> 而非无提示硬拒——后者会让功能开箱即废。
>
> 另发现一个**既有**缺口：免绑定会话跨应用重启后在侧栏不可见（原 [Q13](../open-questions.md)）。未在本批解决，
> 已由 [D04](../decisions/004-unbound-session-index-visibility.md) 拍板走索引标记，落为**批次 5.5 / U13**。

安全敏感批次，单独成批，不与视觉切片混合，便于回归定位。边界已由 [D02](../decisions/002-layout-cwd-and-evidence-scope.md) 决定二定死。

**U05-a 隔离 cwd 生命周期（Main 侧）**
每个免绑定会话一个隔离临时目录，注入 Pi runtime 作为 cwd；会话销毁与应用退出时清理。
验收：① 目录逐会话独立、不落在用户主目录、权限最小；② 会话销毁与异常退出两条清理路径各有测试；③ 跨会话不可互访（cross-session leakage 是发布 blocker）。

**U05-b 放行发送路径与会话身份**
`deriveChatEmptySurface` 新增免绑定分支，**不复用** welcome 的挡发送逻辑；UI 上给这类会话明确标识。
验收：① 无 workspace/cwd 时可发送；② 想绑定目录的用户仍能看到 welcome 引导；③ 会话列表与头部有临时会话标识。

**U05-c 信任态与逐次授权**
默认不信任、逐次请求授权、写路径默认拒绝；用户显式绑定目录后升级走正常信任门。
验收：① 未授权时写工具被拒并给出可操作提示；② 授权只对当次生效；③ 升级路径有测试；④ 既有 permission policy 套件全绿。

**U05-d 回归**：packaged permission gate + permission policy 全套。

**U03-b 解除 TUI 的目录强绑定**
把 `presentationMode === 'tui' && activeWorkspacePath` 的后半条件换成「已有可用 cwd」，免绑定会话用 U05-a 的隔离目录。
验收：免绑定会话可进 TUI，且 TUI 的 cwd 就是该会话的隔离目录，不回落到进程 cwd。

### 批次 5 — 控件语义（U08-2）— **已完成 2026-09-03**

> 落地记录、验收对照、变异验证与门禁结果见 [U08-2 evidence](../evidence/2026-09-03-u08-2-thinking-levels.md)。
>
> **两处与下文原文的偏差**（均已在 evidence §二/§三 展开）：
> ① **「真缺口只有两个常量」只对显示层成立**。边界校验处另有三份五词独立拷贝：
> `workerRpc.ts:340` `isWorkerEffort`（**发布级**——守卫返回 false 会让整条 bootstrap 载荷判非法，
> 带 `off` 的会话根本起不来，不是「档位不生效」）、`piUtilityRunner.ts:40` `resolveEffort`（静默丢档）、
> `git.ts` 三处未校验强转；另有 `piAgentSessionBootstrap.ts:71` 的 `PiThinkingLevel` 缺 `off`。
> 三份拷贝已统一走 `isSessionEffortLevel`。
> ② **`off` 在两条路径上不对称**：Pi 依赖树里有两个同名 `ThinkingLevel`——`pi-agent-core` 七档（聊天，含 `off`）、
> `pi-ai` 六档（AI 功能的一次性补全，无 `off`）。后者遇 `off` 省略字段而非替换成 `minimal`。

**U08-2 思考档扩到 Pi 七档**
复核后真缺口只有两个常量：`SESSION_EFFORT_LEVELS`（`agentHost.ts:7`）与 `CHAT_EFFORTS`（`efforts.ts:25`）补 `off` / `minimal`。按模型过滤与 config 层七档已就绪，无需新建。
迁移按 [evidence-q06](./evidence-q06-migration.md)：纯 mapper、read 时映射、重叠值恒等、未知值 → `default` 哨兵（不是 `off`）、**不静默重写**已存偏好；`writeSessionEffort` 的守卫（`sessionPreferenceStore.ts:70-71`）放宽到新词汇。
**待定实现细节**：`toWireEffort` 对 `default` 返回 `undefined`（省略字段）。`off` 是一个真实档位而非省略，其 wire 行为必须显式定义，不能沿用哨兵路径。
验收：① 七档按 `thinkingLevelMap` 过滤显示；② 旧偏好 low..max 恒等，无静默重写；③ 未知值落 `default`；④ `off` 与 `default` 的 wire 行为各有测试且互不混淆。

**U08-1 无需改动**：分组键保留 `tags[0]`（[Q02](../open-questions.md) 已拍板）。建议补一条行为锁定测试，不单独占切片。

### 批次 5.5 — 免绑定会话跨重启可见性（U13）— **已完成 2026-09-04**

> 落地记录、验收对照、变异验证与门禁结果见 [U13 evidence](../evidence/2026-09-04-u13-unbound-session-visibility.md)。
>
> **比下文多两处落点**（evidence §三 展开）：D04 的三处只做到「看得见」，没做到「打得开」。
> ① `chat:ensureScratchWorkspace` 在重启后必须**认领**索引里记着的目录：Main 的分配表是空的，
> 原实现会新分配一个 uuid 目录并改写索引路径，而 `chat:resumeSession` 拿
> `row.workspacePath !== payload.workspacePath` 判 `pi_session_workspace_mismatch` 直接抛错。
> ② `ChatSession` 增加 `unbound?: { workspacePath }`：resume 必须带一个精确路径，
> 而 scratch 目录按设计不是 `ChatWorkspace`，渲染器无处可取。
>
> **写入规则比 D04 严一点**：两个 IPC 入口都从自己即将写入的那个路径推出布尔值传入，
> 显式 `false` 清除标记、`undefined` 才回退到旧值——只有 `?? existing?.unbound` 的话，
> 一个后来绑到真实目录的对话会永远粘着「临时」标记。

边界由 [D04](../decisions/004-unbound-session-index-visibility.md) 定死（解 [Q13](../open-questions.md)）。三处落点：

1. **共享类型** `SessionIndexEntry` 加**可选** `unbound?: boolean`（`sessionIndex.ts`）。
   索引文件是裸 JSON 数组，只能加可选 per-entry 字段——不加 envelope、不加版本号。
2. **Main 写入** `recordCreated`（`SessionIndexService.ts:79`）按
   `ScratchWorkspaceService.isScratchPath(workspacePath)` 写入。该方法**逐字段重建**，
   新字段必须带 `?? existing?.unbound`，否则第二次调用抹掉标记（`agent` 栽过同一个坑）。
3. **渲染器合并** `mergeSessionIndex`（`sessionIndexMerge.ts:139-153`）在 `!workspaceId` 分支之前
   拦下 `unbound` 行，合成临时分组而不入 `orphans`。

展示形态（分组标题、可否折叠、是否复用 U05-b 已有的 `temporary` chip）实施时定，D04 未锁死。

验收：① 免绑定会话重启后在侧栏可见且能打开；② 连续两次 `recordCreated` 后标记仍在（防逐字段重建抹除）；
③ 非免绑定的 orphan 行（用户移除文件夹）行为**不变**，仍走 orphan 分支；④ 批次 4 之前的老行不回填、不静默写迁移；
⑤ 索引文件仍是裸数组，旧 build 解析不抛错。

### 批次 6 — 面板（U06-a + U07）— **已完成 2026-09-04**

> 落地记录、验收对照、变异验证与门禁结果见
> [批次 6 evidence](../evidence/2026-09-04-u06a-u07-run-and-context-panels.md)。
>
> **双栏可见性已确认为「可见」**，并因此开了 [D05](../decisions/005-two-column-run-surface.md)：
> D02 决定一划的线是「对话 vs 开发工具」，不是「一件 vs 多件」；Files / Git / Terminal 的排除集合一件没变。
> 三栏 rail 变成 `git | files | context | run`，`Ctrl/Cmd+4` 由 run 接手终端下线时空出的数字位，前三位没动。
>
> **U07 的范围本次定死**（原标「Scope 待细化」）：交付分角色构成 + 逐段展开；
> token 估算与手动刷新**刻意不做**，理由见 evidence §二——前者按计划随 U06-b 解锁，
> 后者在本仓没有对应语义（数据是实时 store，不是一次性快照拉取），放按钮属装饰。
>
> **2026-09-05**：U06-b 已落地（随 T38），但 U07 的 token 估算**仍不做**——理由变了：不再是「没数据」，
> 而是 runtime 只报总量、不报按角色的 token 切分，Context 页那张图按角色分段，只能用字符。

**U06-a Run 面板（渲染层可拼部分）**
注册 `run` surface，渲染状态机 / 模型 / 选中 effort / 回合耗时 / 工具名称——这些用现有 `RuntimeEvent` + store 即可（[evidence-q04](./evidence-q04-runtime-fields.md)）。
挂载位置：三栏下作为右栏 rail 新增一项。双栏下是否可见——建议**可见**，理由是 Run 描述的是对话运行态而非开发工具，符合 D02 给双栏的「AI 对话与 AI 开发」定位；实施时确认。
验收：① 状态机映射覆盖 `SessionRuntimeStatus` 全部 9 个值；② 无 usage 数据时占用区不渲染空壳；③ 面板在会话切换与 stale 事件下不串数据。

**U07 Context 面板内容增强**
对照 pi-app 的 `context-panel.tsx` 做内容层增强（分角色分段、token 估算、逐段展开、手动刷新），**不重建面板**。
范围待细化：token 估算与 U06-b 依赖同一批 usage 字段，故本切片先做不依赖 usage 的部分（分段、展开、刷新），估算部分随 U06-b 一起解锁。**建议在 U06-a 落地后再定范围**。

### 批次 7 — 左栏入口（U04）— **已完成 2026-09-04**

> 落地记录、验收对照、变异验证与门禁结果见 [U04 evidence](../evidence/2026-09-04-u04-plugin-entry.md)。
>
> **开工前取证改变了这一片的形状**：下文验收①的两个数来源完全不同，其中一个本仓根本没有。
> ① **MCP 就绪数不是 MCP API**——pix 是扫描扩展自己用 `ui.setStatus` 发布的状态文本、正则抠 `N/M`；
> 本仓 T09 已经在存这份 `statuses`，所以这半边是纯渲染层。
> ② **已装插件清单本仓没有数据源**——渲染器和 Main 都不知道装了什么。
> 用户拍板走 [D06](../decisions/006-plugin-inventory-source.md)：**worker 上报实际加载了什么**
> （它为校验权限插件本来就调用了 `getExtensions()`），不在 Main 重实现 pi 的解析。
>
> **交付边界**：插件**只可见、不可管**。启用/禁用/更新/移除要走 pi 的 `PackageManager`，
> 属于另一个量级的工作，不在本片范围。

只加「插件」入口，带 MCP 就绪徽标；**资源入口不做**（[Q03](../open-questions.md) 已拍板）。
验收：① 入口展示已装插件与 MCP 就绪数；② 未新增「资源」入口；③ 侧栏 IA 保持本仓形态，未改成 pix 的一级导航（[evidence-u09](./evidence-u09-component-forms.md) #6 判定为不搬）。

### 批次 8 — 壳层横条重排与双栏收敛（U14）— **已完成 2026-09-04**

> 本批不在原执行计划里。用户看到实际界面后开的，决策落为
> [D07](../decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)，
> 落地记录见 [U14 evidence](../evidence/2026-09-04-u14-shell-chrome-realignment.md)。
>
> **为什么原计划里没有它**：原型在本计划的引用表里登记为「原型画面，非施工依据」，
> 全份执行计划只有 U09-2 的验收①引用过它（管 Composer 底栏顺序）；
> 壳层结构既不在 D01 的样式授权内、也不是 Q11 的尺寸问题——**没有任何一条决策认领**。
> 加上原型（双栏隐藏右栏）与 D02 决定一（双栏保留 context 右栏）互相矛盾、而代码跟了 D02，
> 于是「双栏」一直渲染出三列。

- **U14-a 双栏收敛**：`columnModeHasPanel` 为假时**不渲染** `ContextPanel`。
  验收：① 双栏下 rail / 快捷键 / reducer 三条路都开不出面板；② 往返三栏后 `railOrder` 与
  `lastSurfaceId` 无损；③ `expanded` 不跨模式携带。
- **U14-b 每栏一条横条**：删 `ChatWorkspace` 的 h-9 头，`MainHeader` 移入中栏并瘦到 3 个按钮位，
  surface 切换器改为 `ContextPanel` 自己的文字 tab 条。
  验收：① 顶栏之下每列恰好一条 h-9；② header 里不得留第二份 `derivePanelTabs`（两处读
  `railOrder` 正是清单漂移的成因）；③ 面板关闭时仍有入口（header 的收/开面板按钮）。
- **U14-c 控件搬家**：顶栏只留 logo + ⋯ + 窗口按钮；设置与账号胶囊下沉左栏底部；
  宽阅读栏进 Settings › 外观。**面板放大不进设置**——它是动作不是偏好，理由见 D07 决定四。

### 批次 10 — 缺陷批（U17 + U18 + U19）— **已完成 2026-09-05**

> 三件都是用户拿着实际界面报的，不在原执行计划里。落地记录见
> [批次 9 evidence](../evidence/2026-09-05-startup-timeout-thinking-levels-tab-close.md)
> （文件名跟的是 roadmap 的编号）。

- **U17 bootstrap 冷启动预算**：`worker.bootstrap` 不再套用 `WorkerSlot` 给暖 RPC 的 10s 默认值，
  单开 `BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000`。
  验收：① 单测显式传 `requestTimeoutMs: 10_000`，推进 10s 后请求仍在飞、60s 才失败；
  ② 失败文案仍是用户看到的那句 `worker.bootstrap timed out after …ms`。
  **未复现原始现场**——这条是按代码路径判定的。
- **U18 极端档需声明**：`low/medium/high` 是任何 reasoning 模型的默认三档，
  `off`/`minimal`/`xhigh`/`max` 必须在 `thinkingLevelMap` 里点名（映射到 `null` 一律剔除）。
  验收：① 无 map 的 `reasoning: true` 模型只出三档；② 模型未知时 `reconcileEffortForModel`
  **保留**已存档位（它的返回值要写回两个存储，把「还不知道」当「不支持」会抹掉合法设置）；
  ③ 真机下拉只剩 `Default / Low / Medium / High`。
- **U19 关 Tab 即结束对话**（[D09](../decisions/009-tab-close-ends-conversation.md)）：
  确认框 → `chat.closeSession` + 复位 `hostBoundSessionIds` / `messages` / `historyErrors` / 分页 / 分支版本号。
  验收：① 左栏行数不变；② store 里该会话 `status: disconnected`、`hostBound: false`、`messages: 0`；
  ③ 打开时新起的 worker 进程在关闭后消失；④ 剪枝路径（`pruneClosedSessions`）仍然一个会话都不碰。

### 跨计划与挂起项

- **U06-b 上下文占用 donut + usage 行 — 已移交**：[D03](../decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定二把 `usage.updated` 生产者与 `contextWindow` 暴露挂到 Pi 计划 **T38-a/b**。T38 落地后本计划再做渲染。
- **U08-3 请求优先级 — Dropped**：[Q12](../open-questions.md) 用户拍板不做。取证证实通道存在但挂在
  「模型静态默认值」层，补那一层的代价与该参数只对 OpenAI 系生效的适用面都撑不起这个次要控件。
  批次 5 因此只剩 U08-2 一片。

## 四、通用门禁

每个切片按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行执行，不并行、不整套跑：

1. 该切片相关的 Vitest（强制 `--maxWorkers=1 --no-file-parallelism`）
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`
3. 触及 agent-host 时追加 `pnpm typecheck:agent-host`
4. `pnpm exec biome check <改动文件>`
5. `git diff --check`

**GUI 点验的定位**：视觉切片（批次 1、2、3）落地后做一次 CDP 点验出图存证，但点验**不阻塞**后续切片推进——除非该切片的验收标准本身就是取证型（U01-b 的对比度复测属此类，必须出数）。

## 五、风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| U01 影响面广 | `rounded-md` 命中 66 个文件、`rounded-lg` 49 个、`text-code` 28 个；改 token 等于一次性改全仓 | 只改 token 不逐文件改；改完立即一次 GUI 全域点验，出图对比 |
| 灰阶重映射误伤对比度 | U09 明确用户气泡的配色是测过的修复 | U01-b 验收含三处对比度复测，出数留证 |
| 布局持久化回落 | 新增字段与新 clamp 可能重置老用户布局 | U02-a / U01-c 各有迁移测试作为验收硬条件 |
| 免绑定会话扩大攻击面 | cwd 可写范围由 U05-a 决定 | 默认不信任 + 逐次授权 + 写路径默认拒绝；cross-session leakage 视为发布 blocker |
| 词汇迁移静默改写偏好 | 历史教训见 pi 词汇表漂移 | read 时映射、重叠值恒等、不写回；`off`/`default` wire 行为分开测试 |

## 六、跨计划依赖

U06-b 与 U08-3 触及 Pi runtime 数据契约，按本计划 README 的边界**不在本计划改 runtime**。
[D03](../decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定二已在 Pi-only 计划下开立 **T38** 承载这批补字段
（T38-a `usage.updated` 生产者、T38-b `contextWindow` 暴露、T38-c 可选的 `tool.updated` 输出转发、
T38-d 条件触发的 service_tier）。T38 不重开 T37 发版门禁。
