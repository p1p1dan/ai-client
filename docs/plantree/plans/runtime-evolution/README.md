# Runtime / GUI — 核心任务树

Role: roadmap。核对日期：2026-09-12；覆盖 runtime-evolution 与已并入的 gui-sdk-experience。
核心功能与架构见 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md)，[GUI 功能定义](../gui-sdk-experience/TODO.md)。
本文件是节点完成状态的唯一权威；当前执行窗口、最近提交、包版本、阻塞和下一步只见[进度看板](../../进度看板.md)。[项目基线](../../baseline/README.md)。

## 状态口径

✅ = 本节点定义范围已实现并有验证证据；🟡 = 实现已有、列明剩余验证/修复；⬜ = 尚未实现。
“核心验证通过”不覆盖新增代码或所有特殊文件样本。通过项累计保留，新增缺陷单独关联，不把已测项目重新写成“未开始”。

<a id="执行顺序"></a>

## 执行顺序

技术依赖：P0 → P1/P2/P3 → P4 → P5 → P6；P2-0 是先行基线。依赖不等于排期，下面是 2026-09-10 重排后的实际推进顺序。

剩余量（2026-09-12 第三次订正）：**12 个节点未开始**（P5 七个，P6 五个）。P2-5/P2-6 与第 7 批（P5-1、P5-3）均已于 2026-09-12 完成；同日第 8 批 P5-2 开工，八个子节点完成了 0～3。P5 剩下的七个里有五个仍是 P5-2 的后半（P5-2-3 收尾 + 4～7），它依旧是后半程的主体。

| 序 | 批次 | 内容 | 为什么排这里 |
|---|---|---|---|
| 1 | H / 17 | [AI 服务管理](topics/local-provider-management.md) | 已实现（`3f6a61fd`）。本地模式配不了模型是功能空白。遗留一个缺陷：搬动 agent 目录导致用户原有模型配置与会话失联，修法并入第 2 批 |
| 2 | H / 19 | [统一 agent 目录、迁移与插件](topics/unified-agent-directory.md) | ✅ 已完成。用户 2026-09-10 方向变更；它同时是 H / 17 那个缺陷的正解——把「加了服务才搬」的条件分支换成一次显式完整迁移。U1～U6 `4284c893`，剩余的[验证案例 4、5 已于 2026-09-11 真机点验通过](evidence/unified-agent-directory/README.md#验证案例-45-的真机点验2026-09-11)（案例 7 依赖 H / 20） |
| 3 | H / 18 | [侧栏对齐 PI-Desktop](topics/sidebar-pi-desktop-alignment.md) | 与 H / 17 同批指定，纯 renderer，不依赖上面两项 |
| 4 | 本地缺陷 | 中文界面英文残留、重载后重复公告与多开空会话 | ✅ 已完成（2026-09-11）。英文残留分两批，走 `t()` 的 `d0332939`、硬编码的这批 `4f7dedf7`，均已真机点验；重复公告与多开空会话查证后定性为**非缺陷**，不改代码。**同日补做了反方向的那一半**：`src/renderer` + `src/shared` 里 15 个文件、82 条硬编码中文（含整个权限档控件）改走词典，108 条新词条，加守卫测试 `noHardcodedChinese.test.ts`。[验证](evidence/chinese-ui-residue/README.md) · [反方向](evidence/chinese-ui-residue/hardcoded-chinese.md) |
| 5 | P4-6 收口（改在开发机） | F3 启动链、F2-b 取证、F4 触发、PERM-1 与权限链复验 | 🟢 开发机侧已完成。用户 2026-09-11 追加规矩：**先把开发机做到完全正常，必须在加密机才能测的留到最后一次上机**，于是本批拆两半——F3 里「加密驱动按什么放行」整体推迟，其余在开发机做完。**F3 开发机侧已完成**（不复现，[记录](evidence/f3-dev-probe/README.md)），**F4 已完成**（真实 HTTP 四条路通过，[记录](evidence/p4-6/f4-retry/README.md)），**PERM-1 与权限链已完成**（legacy / native 两趟，[记录](evidence/p4-6/perm1/README.md)），**F2-b 三时点取证已完成**（[记录](evidence/p4-6/f2b/README.md)）。**开发机侧四项全部做完**；F3 的「加密驱动按什么放行」那一半按用户决定留到最后一次上机。批次内顺带清掉了 H / 19 的[验证案例 4、5](evidence/unified-agent-directory/README.md#验证案例-45-的真机点验2026-09-11) |
| 6 | P2-5、P2-6 | 真实缓存命中率达标与新旧对比 | ✅ 已完成（2026-09-12）。用户指定网关，两个后端在同一网关上各跑一遍同套六场景：native **99.97%**、同网关 legacy **99.97%**，差 -0.0073 个百分点，均高于 95.01% 门槛。原基线网关已不供 `claude-sonnet-5`，故 95.01% 退为历史参考值。[记录](evidence/p2-5/README.md) · [对比报告](evidence/p2-5/comparison.md) |
| 7 | P5-1、P5-3 | skills / 模板（含 F5 提问能力）、MCP bridge | ✅ 已完成（2026-09-12）。四块分四次提交：技能与模板 `4e0f1f3e`、F5 通用提问 `4916a633`、MCP bridge `d4fcd600`。F5 补的是**整条纵切**，其中可作答卡片的渲染位此前全仓不存在。MCP 顺带给 exec 出口加了长驻子进程能力，并修掉它第一版在 runner 载体下的漏报。[施工计划](topics/p5-1-skills-templates-ask.md) · [记录](evidence/p5-1/README.md) |
| 8 | P5-2（含 P5-2-0～7） | subagent 整体复刻 | 🟡 进行中（2026-09-12）。**运行时侧基本齐备**：探针门禁、定义与模型目录、Task* 后台编排、权限与工具能力、会话/事件/usage、迁移预览与开关。**剩下的都是界面与现场**：BrowserPreview 的 Electron 预览窗口、子代理管理界面（SA17）、运行/历史展示逐条对齐（P5-2-6）、SA01～22 全量签收（P5-2-7，依赖 GUI 与打包）。[记录](evidence/p5-2/README.md) · [基线](topics/p5-2-0-baseline.md) |
| 9 | P5-4、P5-5 | 会话导入适配、模型目录切源 | P5-5 与第 1 批的服务管理可能重叠，开工前先核对是否已被覆盖，避免重复实现 |
| 10 | H / 20 + P6-1～P6-5 | [会话互通](topics/gui-tui-session-interop.md)、切默认、摘除 pi-coding-agent 依赖、六项成功标准、回退开关、退役旧集成层 | 用户 2026-09-10 决定互通排到最后做。但它是 P6-1 的**前置**：默认切到 native 之前必须先通，否则切换等于取消 TUI 能力。P6-2 落地时才能删掉派生明文文件的临时分支 |
| — | H / 21 | [外部 Agent 迁移](topics/external-agent-migration.md)、[对话导入](topics/conversation-import.md) | 🟢 四摊都已落地并真机点验：P0 错误文案 `22da278c`、P1 首启一键迁移 `f147059b`、点验修复 `b7dacfb0`/`d0332939`、对话导入 C1～C6 `2715b9a6`（2026-09-11）。含「可续聊」硬验收：导入的会话里发消息拿到基于导入历史的真实回复 |
| 11 | 现场实测 | 加密 Windows 一次性全量验收 | 用户 2026-09-10 决定：全部做完后再去现场实测一次，不再分轮上机 |

第 1 批与第 10 批之间有一条明确的债：H / 17 为兼容 legacy 后端要把用户凭据解密后写成明文 `auth.json`，这是共存期措施，P6-2 摘除旧依赖时一并删除。详见[实施计划](topics/local-provider-management.md)的本轮决定第五条。

## Runtime 任务树

<a id="p0"></a>

### P0 骨架 — ✅

| 节点 | 功能 | 状态 |
|---|---|---|
| P0-1 | 依赖落地 | ✅ |
| P0-2 | 目录与 bootstrap | ✅ |
| P0-3 | service 接口 | ✅ |
| P0-4 | 模型适配器 | ✅ |
| P0-5 | 最小 agent loop | ✅ |
| P0-6 | 离线/在线冒烟 | ✅ |

证据：[P0 在线](evidence/p0/live-smoke.md)、[离线 trace](evidence/p0/offline-smoke-trace.jsonl)。

<a id="p1"></a>

### P1 工具与权限 — 🟡 实现齐备，权限回归待收口

| 节点 | 功能 | 状态与剩余边界 |
|---|---|---|
| P1-0 | IO/exec 出口 | ✅；Windows 五态命令树清理已通过，不再写“Windows 待实测” |
| P1-1 | 工具注册表 | ✅ |
| P1-2 | 文件工具 | ✅；真实加密文本 GUI/agent 读写有现场反馈，特殊 Main 样本归 P4-6 |
| P1-3 | Bash 工具 | ✅ 核心跨平台验证；Windows Bash/工具调用与清理通过，可选无 Bash 场景 R4 另列 |
| P1-4 | 搜索工具 | ✅；首版字面 grep，无正则/gitignore 引擎承诺 |
| P1-5 | 权限内核 | 🟡 已实现；真实自定义策略/复杂 shell 与策略重载组合仍缺专项现场记录 |
| P1-6 | 审批流 | 🟢 开发机侧已验（2026-09-11）：native 后端下结构化权限卡在真实回合中弹出，中文文案齐全、带高风险徽标与「若 119 秒内未响应将自动拒绝」倒计时，点「直接允许」后请求消失且命令真的执行；legacy 后端下审批是 pi 插件自己的英文 `ui.select` 弹窗，两者不是同一张卡。**倒计时走到底的超时拒绝仍只有单测覆盖**；打包现场回归待最后一次上机。[记录](evidence/p4-6/perm1/README.md) |
| P1-7 | 单测 | ✅ 历史实现门禁；不代表包后新改动测试已执行 |
| P1-8 | 载体兼容矩阵 | ✅ 核心矩阵：Linux 与 Windows 两载体六项工具探针通过；真实受策略样本的特定链路归 P4-6 |
| P1-9 | new_context 工具 | ✅，与 P2-8 配对 |

证据：[P1 本机](evidence/p1/README.md)、[TEC Windows 五态清理](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)、[test.12 两载体及现场结果](../../../../Windows-P4-6-evidence/test12-reverify.md)、[test.11 密文载体对照](../../../../Windows-P4-6-evidence/encryption-special.md)。
五态的“应用退出”测的是 ExecPlugin dispose 清理路径，不扩写为所有 GUI 崩溃/退出场景都已覆盖。
P1-8 探针使用源码 runtime + 实际载体；安装包 worker 冒烟是另一份补充证据。

<a id="p2"></a>

### P2 上下文与提示词 — ✅

| 节点 | 功能 | 状态 |
|---|---|---|
| P2-0 | 旧后端基线 | ✅，95.01% |
| P2-1 | 提示词分段组装 | ✅；skills 槽已于 2026-09-12 由 P5-1 填上，`deferredSlots()` 现在为空 |
| P2-2 | 项目指令注入 | ✅ |
| P2-3 | 压缩策略 | ✅ |
| P2-4 | compaction record 持久化 | ✅ |
| P2-5 | 缓存命中率达标 | ✅ 真实 provider **99.97%**（门槛 95.01%），六场景 28 次调用全绿；[记录](evidence/p2-5/README.md) |
| P2-6 | 同套会话新旧对比 | ✅ 同网关重采 legacy 作可比基准：legacy 99.97% / native 99.97%，差 -0.0073 个百分点；0.84.4 与 0.84.3 的 patch 差按 D12 记为已知偏差；[对比报告](evidence/p2-5/comparison.md) |
| P2-7 | 前缀稳定性度量 | ✅ |
| P2-8 | 主动压缩提醒 | ✅，尾部内部消息不改变 system 前缀 |

证据：[基线](evidence/p2-0/validation.md)、[P2](evidence/p2/README.md)、[持久化](evidence/p3/README.md)、[P2-5/P2-6 真实命中率](evidence/p2-5/README.md)。
95.01% 是 2026-09-08 在 `maxapi` 网关上的历史值；该网关今天已不供 `claude-sonnet-5`，
本轮换网关后两个后端一起重采，所以 99.97% 与 95.01% 之间的跳变是网关差异，不是后端差异。

<a id="p3"></a>

### P3 会话与事件 — ✅ 实现与本机往返验证

| 节点 | 功能 | 状态 |
|---|---|---|
| P3-1 | JSONL 存储 | ✅ |
| P3-2 | 分支与 resume | ✅ |
| P3-3 | 旧会话兼容 | ✅；v3 resume 修复在 test.12 现场通过 |
| P3-4 | RuntimeEvent 翻译 | ✅ 原基线；权限事件变更关联 P1-6，包后工具结果文本投影 b43d7005 待验证 |
| P3-5 | SessionIndexService 接线 | ✅；Main Git/受策略文件专项仍归 F3/P4-6 |
| P3-6 | 往返测试 | ✅ |

证据：[P3 收尾](evidence/p3/completion/README.md)、[test.12 v3 恢复](../../../../Windows-P4-6-evidence/test12-reverify.md)。
v4 互通对象是 pi-agent-core JSONL；不能据此宣称 pi-coding-agent 的 CLI/TUI 能读 v4。

<a id="p4"></a>

### P4 集成 — 🟡 现场已执行，剩具体缺陷与复验

| 节点 | 功能 | 状态 |
|---|---|---|
| P4-0 | 同步平台 worker | ✅ |
| P4-1 | worker bootstrap | ✅ |
| P4-2 | 后端开关 | ✅，默认 legacy，native 显式选择 |
| P4-3 | WorkerTransport | ✅ |
| P4-4 | 多轮工具/审批/压缩/会话端到端 | ✅ 本机基线；F4 重试现场单列 |
| P4-5 | GUI 点验 | ✅ 原实现点验；后续状态/权限 UI 改动须回归 |
| P4-6 | 打包与现场集成验收 | 🟡，按下表累计签收 |

| P4-6 验收项 | 累计结果 / 精确缺口 |
|---|---|
| 包与载体 | test.13 CI 已成功；test.12 实际安装包 native worker Read/Bash/权限活动/退出通过 |
| Windows 命令树 / 两载体六工具 | ✅，分别计入 P1-0/P1-3/P1-8 |
| 加密文本 GUI / agent 读写 | ✅ 用户确认被其他软件修改并加密后仍能打开、修改和读取；不是“加密机未测” |
| 加密载体对照 | test.11 已有真实密文三读取者差分；test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项 |
| Main Git / diff / 编码 / 二进制 | 🟡 F3 持续复现；特定编码与真实二进制样本无完整现场结果 |
| 旧会话 | ✅ test.12 v3 历史/重启 resume 通过；首次转换生成时点的基线证据有限 |
| 新权限 UI、档位与状态修复 | 🟡 按“现场缺陷与修复”列出的包边界复验 |
| 重试 | 🟢 F4 代码已入 test.12/13；2026-09-11 开发机真实 HTTP 触发四条路通过，[记录](evidence/p4-6/f4-retry/README.md)；加密机复测并入最后一次上机 |
| native GUI/TUI 一致性 | 🟡 2026-09-10 改为必须互通（H / 20），范围冲突消解。可行性已实测，实现未落地；在此之前该验收动作仍无法执行 |
| R4 无 Bash | 可选探针无效（shell 仍被发现）；独立保留，不撤销已通过的 Bash 验证 |

<a id="p5"></a>

### P5 扩展 — 🟡 P5-1 / P5-3 已完成，P5-2 进行中

| 节点 | 功能 | 状态 |
|---|---|---|
| P5-1 | skills / 模板；F5 提问能力 | ✅ 技能发现按 agentskills.io 规则、`skills` 槽的最后一条延期声明已删、`skill` 工具按名加载（不走 `read`，避免每次弹权限卡）、模板 `/name` 与 `/skill:name` 在发送路径展开、`worker.commands` 返回真实行；F5 整条纵切补齐。[记录](evidence/p5-1/README.md) |
| P5-2 | subagent 整体复刻 | 🟡 运行时侧基本齐备（0～4 完成，3 与 5 各差界面那一半），6～7 未开始；[记录](evidence/p5-2/README.md) |
| P5-2-0 | 版本/宿主适配探针与基线 | ✅ 10 条探针实测 0.84.4，两条结论推翻了原假设（取消要多花一次请求、terminate 要整批一致），差异矩阵见[基线](topics/p5-2-0-baseline.md)。D12 维持 0.84.4 |
| P5-2-1 | 定义与模型目录 | ✅ 四内置角色与解析器复刻；目录改 `<agentDir>/subagents`（H/19），pin 解析不出即失败、不回落。30 条 SA01/SA02 |
| P5-2-2 | 子 Agent / Task* 后台编排 | ✅ 四工具、10 并发、registry 100、wait all/any、Stop 真收敛、自动交回。**run() 的 promise 现在等子任务结算**。修了两个真缺陷：Stop 后提前 resolve、子任务早完成则报告丢失（补 `deliveredAt`）。26 条 SA03～SA09 |
| P5-2-3 | 权限、工具与重试依赖 | 🟡 运行时侧完成：grep 正则、bash `timeoutSeconds`（上限 6h，默认不变）、按调用隔离的权限档与审批归属、父子共用写锁、流中失败重试不重放工具。**Electron 预览窗口未接通，SA20 保持未验收**。17+2 条 SA10/SA11/SA13/SA20 |
| P5-2-4 | 会话、事件与 usage | ✅ 子代理消息存为带归属的 `custom` 条目——隔离是条目类型的性质，不是靠人记得加的过滤；事件通道只是有上限的实时摘要，终态/usage/完整报告都从记录来。状态枚举扩到六值（`stopped`/`truncated`），否则渲染层四值白名单会直接丢弃。8 条 SA14/SA15/SA16 |
| P5-2-5 | 定义管理与旧资源迁移 | 🟡 迁移预览（只出预览、不写不删、逐条列差异、裸模型 id 阻塞、项目文档不自动升全局、原文件保留）与 native 委派开关（没设过=开，只有显式 false 才关）已完成，19+3 条测试。**管理界面未做，SA17 未验收** |
| P5-2-6 | 运行/历史展示 | ⬜ |
| P5-2-7 | SA01～22 等价门禁 | ⬜ |
| P5-3 | MCP bridge | ✅ 自写 stdio JSON-RPC 客户端（不引官方 SDK：它自己 spawn，违反 D11 第 4 条），配置沿用生态 `{"mcpServers":{…}}`，项目文件仅在 projectTrusted 时打开，每次调用过权限门。对真实 stdio 服务器取证。[记录](evidence/p5-1/README.md) |
| P5-4 | 会话导入适配 | ⬜ |
| P5-5 | 模型目录切源 | ⬜ |

范围与验收：[P5-2 契约](topics/p5-2-subagent-contracts.md)、[任务定义与 SA01～22](topics/p5-2-subagent-tasks.md)。完整复刻后才做优化。

<a id="p6"></a>

### P6 切换 — ⬜ 尚未实现

| 节点 | 功能 | 状态 |
|---|---|---|
| P6-1 | 默认新 runtime | ⬜ |
| P6-2 | 摘除 pi-coding-agent 依赖 | ⬜ |
| P6-3 | 六项成功标准达标 | ⬜，包括缓存与 TUI 范围冲突的明确处理 |
| P6-4 | 一个版本周期的回退开关 | ⬜ |
| P6-5 | 周期后退役旧集成层 | ⬜ |

## GUI 任务树

所有 A～F 功能已有实现；下列保留已通过范围，未覆盖样本/修复回归单列。GUI 批次 F 与缺陷编号 F1～F7 是不同编号体系。

| 批次 / 编号 | 功能 | 实现与现场进展 |
|---|---|---|
| A / 1 | 目录菜单鼠标与焦点 | ✅ 核心现场通过 |
| A / 2 | 终端设置 | ✅ 核心现场及 test.12 F1 网络面板通过；完整 Shell/Custom 组合无逐项记录 |
| A / 7 | 文件点击与编辑器 | ✅ 核心现场通过；多样路径 2c 缺样本 |
| A / 10 | /new 继承 cwd | 🟡 已实现；普通流程有记录，原 TEMP /new 矩阵未完整补签，F2 恢复不等于 /new 全矩阵 |
| A / 4 | 临时目录复用/创建/绑定 | 🟢 test.12 当前恢复流程通过；F2-b 三时点取证已于 2026-09-11 在开发机完成（[记录](evidence/p4-6/f2b/README.md)），未见索引损坏；加密机回归并入最后一次上机 |
| B / 5 | 重试与异常恢复 | 🟢 F4 已实现并于 2026-09-11 在开发机真实 HTTP 上触发通过（[记录](evidence/p4-6/f4-retry/README.md)）；加密机复测并入最后一次上机 |
| B / 6 | 运行状态/计时/摘要 | ✅ F7b 只留输入框上方一处、折叠只显示「已处理 N 个步骤」（`225c325e`）、进行中不提前折叠（`ca6aac0f`）；本地真实应用验证 |
| C / 3 | 权限展示降噪 | 🟡 原流程部分通过；结构化权限链与重画已提交，待新包回归 |
| C / 8 | 问答卡交互 | 🟢 F5 已落地（`4916a633`）：native 的 `ask` 工具是本仓**第一个** `question.requested` 生产者，可作答卡片的渲染位（`PendingQuestionDock`）此前全仓不存在，本轮一并补上。**未真机点验**，未打包。[记录](evidence/p5-1/README.md) |
| C / 9 | 当前对话审阅栏 | ✅ R1/R2 `6be1d70a`、上限 `1f45531f`；2026-09-10 本地真实应用（native + 真实模型）验证通过，[记录](evidence/session-review-and-updates/README.md#本地真实应用验证) |
| D / 11 | 上下文用量详情 | ✅ 核心现场通过；F7e 归既有行为，增强另排 |
| E / 12 | 输出跟随 | ✅ 原核心现场通过；F7f 输入框增高本地验证通过 |
| F / 13 | 目录行变更量 | 🟡 接线完好（`useFolderDiffStats.ts` 的轮询 hook 由 `LeftNav.tsx:291` 调用），开发机上 git 已证通、F3 阻断解除。实测驱动抓取侧：IPC 正常、store 写入成功；当时工作区只有未跟踪文件，`git diff --shortstat` 本就不计未跟踪，返回 0/0 行上不显示数字，属正确行为。**仍缺**：真实 busy 会话下数字出现并刷新的现场记录。[记录](evidence/f3-dev-probe/README.md) |
| F / 14 | 旧 GitView / IPC 等死代码清理 | ✅ 实现及回归；后续测试包整体 GUI 继续回归 |
| F / 15 | cwd 缺失与临时目录恢复 | 🟡 test.12 当前恢复流程通过；F2-a/c 后续修复待 test.13 验证；**F2-b 取证已完成**（[记录](evidence/p4-6/f2b/README.md)） |
| G / 16 | 软件更新提醒 | 🟡 U1 已提交 `b919b1aa`，自动化与隔离弹窗验证通过；真实更新源下载/安装按用户 2026-09-10 决定暂缓验证 |
| H / 17 | 本地模式 AI 服务管理 | 🟡 L1～L5 已实现：vault 分组存储、主进程服务与 IPC、设置页与添加/编辑弹窗、本地模式首次进入自动打开。全量 5161 测试通过；未打包、未现场回归；[实施计划](topics/local-provider-management.md) |
| H / 19 | 统一 agent 目录、资源迁移与插件管理 | 🟢 U1～U6 已落地（`4284c893`）：两种模式一律用本应用目录、五项资源一次性复制迁移、插件复用 pi 的 install/remove/list、借用机制整条删除。**验证案例 2～5 均已真机点验通过**（4、5 于 2026-09-11：真装 `npm:pi-jingle` → 会话扩展清单里 `scope:user` 出现 → 装不存在的包给出 npm 原文 → 卸载后文件与配置双双清空；项目级插件在 `projectTrusted:false` 下不可见，界面两种模式都没有项目级入口）。点验顺带修掉插件面板把随包权限系统显示成 `src`。案例 7 依赖 H / 20；未打包。[实施计划](topics/unified-agent-directory.md) · [验证](evidence/unified-agent-directory/README.md) |
| H / 20 | GUI / TUI 会话互通 | ⬜ 单文件双格式，可行性已实测通过、需补五处容忍；P6-1 前置；[实施计划](topics/gui-tui-session-interop.md) · [验证](evidence/gui-tui-session-interop/README.md) |
| H / 18 | 左侧 Chat 栏对齐 PI-Desktop | 🟢 S1～S5 已实现并现场点验通过（`70b9a31d`），点验另修一处 Esc 缺陷（`b92800a7`）；[实施计划](topics/sidebar-pi-desktop-alignment.md) · [验证](evidence/sidebar-pi-desktop-alignment/README.md) |
| H / 21 | 外部 Agent 迁移（默认迁移策略 + Claude / Codex 对话导入） | 🟢 P0 `22da278c`、P1 `f147059b`、对话导入 C1～C6 `2715b9a6`（2026-09-11）均已落地并真机点验。对话导入的读写链路 T34 就有、只是无人挂载，本轮补的是设置页入口、未匹配仓库落为临时对话、Codex 旧格式、标题不取斜杠命令；[策略](topics/external-agent-migration.md) · [施工计划](topics/conversation-import.md) · [点验](evidence/external-agent-migration/README.md#c1c6-对话导入2026-09-11) |

[GUI 功能定义](../gui-sdk-experience/TODO.md) · [验收方法](../gui-sdk-experience/现场验收清单.md) · [test.11 现场](../../../../Windows-P4-6-evidence/gui-a-e-findings.md) · [test.12 现场](../../../../Windows-P4-6-evidence/test12-reverify.md)。

## 现场缺陷与修复

| 编号 | 精确状态 | 包 / 证据 |
|---|---|---|
| F1 网络面板 | ✅ 已修并现场通过 | `80a8b040`；test.12 |
| F2 当前临时会话恢复 | ✅ 缺目录重建、Close/归档隔离、重启保留通过；不代签旧 TEMP 异常 | `dbead94b` 在 test.11 现场之后提交，包含于 test.12；旧交付文档“test.11 已含”有误 |
| F2-a 临时根设置不同步 | 🟡 已修一类，待复验 | `e817fc2a`；test.13 |
| F2-b TEMP 删除后归组/消失 | 🟢 2026-09-11 开发机三时点取证完成，索引与目录两侧分别读取。**「关闭」什么都不删**（索引行与目录在未重启时原样不动，只是行离开侧栏——界面消失不等于文件被删）；**「归档」当场删目录**并置 `archived:true`；**重启会把整个 scratch 根目录连锅端**，与用哪个入口无关，因此重启后必然出现「索引行在、`workspacePath` 指向已不存在目录」的状态，这是 U05-a 的设计而非索引损坏。仍未测：临时行第三个「删除」按钮那条 `temp:workspace:*` 链；正常退出（非 kill）时的退出清理 | [记录](evidence/p4-6/f2b/README.md) · [取证要求](topics/field-followups.md#f2-b-取证) |
| F2-c 用户目录缺失 | 🟡 已提供 workspace_missing 与恢复/归档说明；不自动重建用户目录 | `3bd3f547`；test.13 |
| F3 GUI Git 输出丢失 | 🟡 **开发机侧已取证：不复现**，三层（纯 Node、Electron 主进程走应用 IPC、Git 面板界面）全部正常，故确认为加密机专属，按用户 2026-09-11 决定整体推迟到最后一次上机。用户提出的根因方向：加密软件认**调用方**，Electron 调 git 在驱动眼里就是 Electron 在操作——若成立，换哪个 git 都没用，只能在中间插一个白名单进程（ARD §8 已记 Main→PowerShell→git 正常，是该方向的直接证据）。根因与修法仍未拍板 | [开发机取证](evidence/f3-dev-probe/README.md) · [事实与方案](../../../plans/2026-09-09-gui-defect-decisions.md#f3--gui-起的-git-子进程输出丢失) |
| F4 重试 | 🟢 自有重试层已实现（`27d4b7be`），2026-09-11 在开发机用真实 HTTP 假网关触发通过四条路。**退避节奏按用户当日决定改为 3s → 10s → 30s**（三次重试、四次尝试，持续故障总等 43 秒），替掉原来的两套倍增公式；两条预算仍各记各的次数，限流那条保留抖动，服务端 `Retry-After` 一律优先。实测：503×2 后成功（3 次请求、3s→10s）、一直 503 时 4 次请求耗尽、429 按 `Retry-After` 只等 1s、退避中取消 401ms 结束只发 1 次请求。stream 开始后的恢复仍不在该层范围；GUI 侧观感与加密机复测未做。[记录](evidence/p4-6/f4-retry/README.md) |
| F5 通用问答缺生产者 | 🟢 已实现（2026-09-12，`4916a633`）。runtime `ask` 工具 → `question.requested` → `worker.question.respond` → `chat:respondQuestion` → store → 输入框上方的可作答卡片。工具自己给每一问分配 id（answers 表按问题原文做键时，一次调用里两问同字面会撞键）；不设超时也不做权限门；宿主无处显示时不注册该工具。**仅自动化测试，未真机点验** | [功能决策](../../../plans/2026-09-09-gui-defect-decisions.md#f5--无提问工具questioncard--扩展问答弹不出来) · [记录](evidence/p5-1/README.md) |
| F6 对话修改审阅 | ✅ 2026-09-10 采用右侧审阅，本地真实应用验证通过，尚未打包 | [R1/R2 与更新 U1](topics/session-review-and-updates.md) |
| F7a/F7c 权限卡样式/尺寸 | 🟡 结构化权限链与重画本地真实应用可用；倒计时原未接通，已补 `baeff487` 并本地验证；视觉口径仍待定 | 不在 test.13；通用问答卡仍受 F5 限制 |
| F7b 重复状态行 | ✅ 根因是时间线末尾与输入框上方各挂一个 `SessionActivityStatus`（`a3debdf6` 守的是另一对）；按用户选择只留输入框上方，本地真实应用全程单份 | `225c325e`；[修前截图](evidence/session-review-and-updates/local-f7b-duplicate.png) |
| 会话写入锁残留 | 🟡 已修：锁记录 `pid`/`host`，`EEXIST` 后判定主进程是否存活，陈旧锁经 rename 独占后接管；活写者与他机锁仍拒绝。7 项新测试含反向对照，未打包、未现场回归 | `280f49fc`；`src/runtime/plugins/session/writerLock.ts`（`store.ts` 与 `legacy.ts` 共用）；[验证](evidence/session-writer-lock/README.md) |
| 中文界面英文残留（走 t() 的） | ✅ 已修 `d0332939`：全渲染层 1078 个 `t('…')` 字面量逐一比对，补齐 57 处缺失词条（设置、Git、差异视图、用户资料等）。新增 `i18nCoverage` 测试守住这条线，此后新加 `t()` 必须同时加词条 | 起因是 H/21 点验 D4（迁移列表里「AI services」与「历史对话」并排一中一英），量化后一次补齐 |
| 中文界面英文残留（硬编码的） | ✅ 已修并真机点验（`4f7dedf7`）。做法：纯函数模块继续吐英文，但那串英文从此是**词典的键**——行首动词一路当键传到 `ToolRows.tsx` 统一 `t(view.verb)` 翻一次；要拼数字路径的参数段则在构造时就翻好，相关函数多收一个 `t`（默认 `englishTranslate`，即英文本身，所以漏接一处只会少一条翻译、不会产生坏字符串）。覆盖工具动词表、思考行、权限卡、审批记录行、子 Agent 面板、输入框占位、回合状态行、排队条、侧栏 New、会话分支对话框、模型按钮 aria-label；另修 15 条词典自身的中英混排值（「搜索 Session」→「搜索会话」） | 来源[本地实测](evidence/session-review-and-updates/README.md#本地真实应用验证)。守卫两条且缺一不可：`toolVocabulary` 查词表有没有词条，`chineseChatSurface` 用真 zh 渲染真组件查屏幕上的词是不是从词典来的（后者已反向验证）。[验证与点验](evidence/chinese-ui-residue/README.md) |
| 重载后重复公告与多开空会话 | ⚪ **查证后定性为非缺陷，不改代码**（2026-09-11）。公告：`shouldOpenAnnouncementsOnStartup` 明确不看已读状态，「每次启动都弹」是已确认的产品决定。空会话：`createLiveSession` 是纯渲染层占位，不进索引、不起 worker，重载后重建一个是种子逻辑的正常行为，不累积。而 reload 在打包版里够不着——`MenuBuilder.ts:94` 仅在 `!app.isPackaged` 时挂 `reload`/`forceReload`，生产唯一路径是渲染进程崩溃后 `ErrorBoundary.tsx:92` 的按钮，那时重来一遍本就合理。原初判的 `--open-path` 方向也已排除：`APP_TAKE_PENDING_OPEN_PATH` 取一次即清空 | 来源[本地实测](evidence/session-review-and-updates/README.md#本地真实应用验证)；查证见 [H/21 点验记录](evidence/external-agent-migration/README.md) |
| F7d / EFFORT-1 | 🟡 effort 传递与默认 medium 已修；GPT 慢响应本次未证明为本地缺陷 | `4145fa65` / `c0ae2a34`；test.13 |
| F7e resume 后暂无上下文统计 | 已定性为既有行为；可选恢复快照增强尚未排期 | [功能说明](topics/field-followups.md#f7e-上下文快照) |
| F7f 输入框增高 | ✅ 八行上限本地验证通过（8 行 192px 后滚动） | `87f3dc7d` |
| PERM-1 权限档弹层不关 | 🟢 2026-09-11 开发机真实点击复验通过（legacy / native 两个后端各一趟）：选普通档与换模式后 `data-open` 在 100ms 内消失，选「全自动」弹层留着换成确认面板，取消后什么都不应用。探针第一版把判据写成「节点从 DOM 消失」量出过假阳性——Base UI 关闭后节点还在，只是换成 `data-closed`。「worker 永不回执也必须关」仍只有单测覆盖 | `1e1e4469`；test.13；[记录](evidence/p4-6/perm1/README.md) |
| TUI-1 native v4 进不了 TUI | 🟡 2026-09-10 用户推翻方案 C，改为必须互通。可行性已实测（双向四轮交替通过），待按 H / 20 落地；方案 C 的入口保护实现保留为格式不兼容时的兜底 | `0644ba3d`；[验证](evidence/gui-tui-session-interop/README.md) · [实施计划](topics/gui-tui-session-interop.md) |
| v3 resume 身份不匹配 | ✅ 已修，test.12 历史与再次恢复通过 | `d2564e5d` |

## 相关决策入口

F3、F2-b、TUI 范围冲突分别关联上表节点，具体待答问题只维护在 [open-questions](open-questions.md)。F6 已按用户选择实施右侧审阅（[范围与验证](topics/session-review-and-updates.md)）；F7e 仍为候选增强，不新增为基础功能阻塞。默认字体：2026-09-10 用户看过 Maple Mono 对比（[截图](../../../../sharePic/20260910/maple-mono-preview/)）后决定维持系统字体栈（设计规范 D25），不做字体选择器。

## 证据与维护

本次核对源：git 提交及源码差异、现场 test.11/test.12、GitHub Actions 实时查询；没有重新执行产品测试或现场操作。
参考源码与测试已复核：pi-app WorkerManager/session-isolation、pix pi-tui-session；本轮不移植参考实现，沿用本仓契约与现场证据，pix 的旧 Pi TUI 启动形状不能证明 native v4 互通。

旧多份状态与实现说明冻结在 [2026-09-10 整理前快照](history/2026-09-10-status-before-consolidation.md)，它只供追溯。
节点实现或验收状态变化只更新本文件相关行；当前执行窗口更新进度看板；功能/决策变更才改 ARD/topics；新测试只追加对应版本证据。
