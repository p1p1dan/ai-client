# Runtime / GUI — 核心任务树

Role: roadmap。核对日期：2026-09-10；覆盖 runtime-evolution 与已并入的 gui-sdk-experience。
核心功能与架构见 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md)，[GUI 功能定义](../gui-sdk-experience/TODO.md)。
本文件是节点完成状态的唯一权威；当前执行窗口、最近提交、包版本、阻塞和下一步只见[进度看板](../../进度看板.md)。[项目基线](../../baseline/README.md)。

## 状态口径

✅ = 本节点定义范围已实现并有验证证据；🟡 = 实现已有、列明剩余验证/修复；⬜ = 尚未实现。
“核心验证通过”不覆盖新增代码或所有特殊文件样本。通过项累计保留，新增缺陷单独关联，不把已测项目重新写成“未开始”。

## Runtime 任务树

执行依赖：P0 → P1/P2/P3 → P4 → P5 → P6；P2-0 是先行基线。

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
| P1-6 | 审批流 | 🟡；PERM-1 已修入 test.13；包后结构化权限链、卡片及倒计时/超时拒绝（9cf6bbde）尚待验证/打包现场回归 |
| P1-7 | 单测 | ✅ 历史实现门禁；不代表包后新改动测试已执行 |
| P1-8 | 载体兼容矩阵 | ✅ 核心矩阵：Linux 与 Windows 两载体六项工具探针通过；真实受策略样本的特定链路归 P4-6 |
| P1-9 | new_context 工具 | ✅，与 P2-8 配对 |

证据：[P1 本机](evidence/p1/README.md)、[TEC Windows 五态清理](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)、[test.12 两载体及现场结果](../../../../Windows-P4-6-evidence/test12-reverify.md)、[test.11 密文载体对照](../../../../Windows-P4-6-evidence/encryption-special.md)。
五态的“应用退出”测的是 ExecPlugin dispose 清理路径，不扩写为所有 GUI 崩溃/退出场景都已覆盖。
P1-8 探针使用源码 runtime + 实际载体；安装包 worker 冒烟是另一份补充证据。

<a id="p2"></a>

### P2 上下文与提示词 — 🟡 剩真实缓存门禁

| 节点 | 功能 | 状态 |
|---|---|---|
| P2-0 | 旧后端基线 | ✅，95.01% |
| P2-1 | 提示词分段组装 | ✅，skills 槽位归 P5 |
| P2-2 | 项目指令注入 | ✅ |
| P2-3 | 压缩策略 | ✅ |
| P2-4 | compaction record 持久化 | ✅ |
| P2-5 | 缓存命中率达标 | ⬜，真实 provider ≥95.01% |
| P2-6 | 同套会话新旧对比 | ⬜，记录 Pi 0.84.4 / 基线 0.84.3 偏差 |
| P2-7 | 前缀稳定性度量 | ✅ |
| P2-8 | 主动压缩提醒 | ✅，尾部内部消息不改变 system 前缀 |

证据：[基线](evidence/p2-0/validation.md)、[P2](evidence/p2/README.md)、[持久化](evidence/p3/README.md)。

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
| 加密载体对照 | test.11 已有真实密文三读取者差分；test.12 R2/R3 都读到明文，未隔离具体驱动放行规则 |
| Main Git / diff / 编码 / 二进制 | 🟡 F3 持续复现；特定编码与真实二进制样本无完整现场结果 |
| 旧会话 | ✅ test.12 v3 历史/重启 resume 通过；首次转换生成时点的基线证据有限 |
| 新权限 UI、档位与状态修复 | 🟡 按“现场缺陷与修复”列出的包边界复验 |
| 重试 | 🟡 F4 代码已入 test.12/13；现场未触发所需错误 |
| native GUI/TUI 一致性 | 当前不支持：方案 C 拒绝 v4 进入旧 Pi TUI；入口保护已入 test.13，待复验。原 ARD 成功标准 6 的对应条款存在范围冲突，不能把拒绝入口记成互通通过 |
| R4 无 Bash | 可选探针无效（shell 仍被发现）；独立保留，不撤销已通过的 Bash 验证 |

<a id="p5"></a>

### P5 扩展 — ⬜ 尚未实现

| 节点 | 功能 | 状态 |
|---|---|---|
| P5-1 | skills / 模板；F5 提问能力随此批讨论 | ⬜ |
| P5-2 | subagent 整体复刻 | ⬜，调研/契约已完成，产品实现未开始 |
| P5-2-0 | 版本/宿主适配探针与基线 | ⬜，已有调研不等于门禁通过 |
| P5-2-1 | 定义与模型目录 | ⬜ |
| P5-2-2 | 子 Agent / Task* 后台编排 | ⬜ |
| P5-2-3 | 权限、工具与重试依赖 | ⬜ |
| P5-2-4 | 会话、事件与 usage | ⬜ |
| P5-2-5 | 定义管理与旧资源迁移 | ⬜ |
| P5-2-6 | 运行/历史展示 | ⬜ |
| P5-2-7 | SA01～22 等价门禁 | ⬜ |
| P5-3 | MCP bridge | ⬜ |
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
| A / 4 | 临时目录复用/创建/绑定 | 🟡 test.12 当前恢复流程通过；F2-b 历史异常待取证 |
| B / 5 | 重试与异常恢复 | 🟡 F4 已实现；现场未触发 |
| B / 6 | 运行状态/计时/摘要 | ✅ F7b 只留输入框上方一处、折叠只显示「已处理 N 个步骤」（`225c325e`）、进行中不提前折叠（`ca6aac0f`）；本地真实应用验证 |
| C / 3 | 权限展示降噪 | 🟡 原流程部分通过；结构化权限链与重画已提交，待新包回归 |
| C / 8 | 问答卡交互 | 🟡 UI 已实现；通用 question 无生产者（F5），不能把权限卡生产者当作通用提问工具 |
| C / 9 | 当前对话审阅栏 | ✅ R1/R2 `6be1d70a`、上限 `1f45531f`；2026-09-10 本地真实应用（native + 真实模型）验证通过，[记录](evidence/session-review-and-updates/README.md#本地真实应用验证) |
| D / 11 | 上下文用量详情 | ✅ 核心现场通过；F7e 归既有行为，增强另排 |
| E / 12 | 输出跟随 | ✅ 原核心现场通过；F7f 输入框增高本地验证通过 |
| F / 13 | 目录行变更量 | 🟡 已实现，目标现场受 F3 阻断 |
| F / 14 | 旧 GitView / IPC 等死代码清理 | ✅ 实现及回归；后续测试包整体 GUI 继续回归 |
| F / 15 | cwd 缺失与临时目录恢复 | 🟡 test.12 当前恢复流程通过；F2-a/c 后续修复待 test.13 验证，F2-b 单列 |
| G / 16 | 软件更新提醒 | 🟡 U1 已提交 `b919b1aa`，自动化与隔离弹窗验证通过；真实更新源下载/安装按用户 2026-09-10 决定暂缓验证 |

[GUI 功能定义](../gui-sdk-experience/TODO.md) · [验收方法](../gui-sdk-experience/现场验收清单.md) · [test.11 现场](../../../../Windows-P4-6-evidence/gui-a-e-findings.md) · [test.12 现场](../../../../Windows-P4-6-evidence/test12-reverify.md)。

## 现场缺陷与修复

| 编号 | 精确状态 | 包 / 证据 |
|---|---|---|
| F1 网络面板 | ✅ 已修并现场通过 | `80a8b040`；test.12 |
| F2 当前临时会话恢复 | ✅ 缺目录重建、Close/归档隔离、重启保留通过；不代签旧 TEMP 异常 | `dbead94b` 在 test.11 现场之后提交，包含于 test.12；旧交付文档“test.11 已含”有误 |
| F2-a 临时根设置不同步 | 🟡 已修一类，待复验 | `e817fc2a`；test.13 |
| F2-b TEMP 删除后归组/消失 | 待复现及索引/目录取证；不宣称数据已物理删除 | [取证要求](topics/field-followups.md#f2-b-取证) |
| F2-c 用户目录缺失 | 🟡 已提供 workspace_missing 与恢复/归档说明；不自动重建用户目录 | `3bd3f547`；test.13 |
| F3 GUI Git 输出丢失 | 故障已复现，根因机制/方案未定；Q7 只修正判错，未修输出 | [事实与方案](../../../plans/2026-09-09-gui-defect-decisions.md#f3--gui-起的-git-子进程输出丢失) |
| F4 重试 | 🟡 自有重试层已实现，现场未触发；stream 开始后的恢复不在该层范围 | `27d4b7be`；test.12/13 |
| F5 通用问答缺生产者 | 能力缺口，非 native 回归；归 P5-1 批，不阻塞 P4 原能力 | [功能决策](../../../plans/2026-09-09-gui-defect-decisions.md#f5--无提问工具questioncard--扩展问答弹不出来) |
| F6 对话修改审阅 | ✅ 2026-09-10 采用右侧审阅，本地真实应用验证通过，尚未打包 | [R1/R2 与更新 U1](topics/session-review-and-updates.md) |
| F7a/F7c 权限卡样式/尺寸 | 🟡 结构化权限链与重画本地真实应用可用；倒计时原未接通，已补 `baeff487` 并本地验证；视觉口径仍待定 | 不在 test.13；通用问答卡仍受 F5 限制 |
| F7b 重复状态行 | ✅ 根因是时间线末尾与输入框上方各挂一个 `SessionActivityStatus`（`a3debdf6` 守的是另一对）；按用户选择只留输入框上方，本地真实应用全程单份 | `225c325e`；[修前截图](evidence/session-review-and-updates/local-f7b-duplicate.png) |
| 会话写入锁残留 | 🔴 本地发现：应用崩溃或被强制结束后 `.writer.lock` 残留，锁里记录的进程已不存在也照样拒绝，重开会话报 `session_locked`、历史读不出 | `src/runtime/plugins/session/store.ts` 与 `legacy.ts` 同一写法 |
| F7d / EFFORT-1 | 🟡 effort 传递与默认 medium 已修；GPT 慢响应本次未证明为本地缺陷 | `4145fa65` / `c0ae2a34`；test.13 |
| F7e resume 后暂无上下文统计 | 已定性为既有行为；可选恢复快照增强尚未排期 | [功能说明](topics/field-followups.md#f7e-上下文快照) |
| F7f 输入框增高 | ✅ 八行上限本地验证通过（8 行 192px 后滚动） | `87f3dc7d` |
| PERM-1 权限档弹层不关 | 🟡 已改为选择后立即关闭，待现场复验 | `1e1e4469`；test.13；区别于包后权限审批卡重画 |
| TUI-1 native v4 进不了 TUI | 方案 C 已实现入口说明，互通能力未实现 | `0644ba3d`；test.13；[范围与后果](topics/field-followups.md#tui-1-能力边界) |
| v3 resume 身份不匹配 | ✅ 已修，test.12 历史与再次恢复通过 | `d2564e5d` |

## 相关决策入口

F3、F2-b、TUI 范围冲突分别关联上表节点，具体待答问题只维护在 [open-questions](open-questions.md)。F6 已按用户选择实施右侧审阅（[范围与验证](topics/session-review-and-updates.md)）；F7e 仍为候选增强，不新增为基础功能阻塞。

## 证据与维护

本次核对源：git 提交及源码差异、现场 test.11/test.12、GitHub Actions 实时查询；没有重新执行产品测试或现场操作。
参考源码与测试已复核：pi-app WorkerManager/session-isolation、pix pi-tui-session；本轮不移植参考实现，沿用本仓契约与现场证据，pix 的旧 Pi TUI 启动形状不能证明 native v4 互通。

旧多份状态与实现说明冻结在 [2026-09-10 整理前快照](history/2026-09-10-status-before-consolidation.md)，它只供追溯。
节点实现或验收状态变化只更新本文件相关行；当前执行窗口更新进度看板；功能/决策变更才改 ARD/topics；新测试只追加对应版本证据。
