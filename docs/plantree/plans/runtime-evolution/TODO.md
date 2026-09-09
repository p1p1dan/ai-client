# Runtime 执行 TODO

2026-09-09 状态同步 · [看板](README.md) · [P4-6 交接与 CI 结果](evidence/p4-6/README.md)

当前阶段：P4-6 的 Windows 现场已执行 GUI A~E 与命令树清理五态，两者均留证；GUI 核心功能在 native 后端可用，交回的 7 组缺陷中 F1/F2/F4 与旧会话 resume 已修、F3/F5 已定性。企业加密机签收仍未开始。**当前测试包提交 `b6dbfe65`（`1.0.0-test.12`）**，[CI 34354367890 全绿含 macOS，证据/下载/现场清单](evidence/p4-6/ci-34354367890/README.md)；上一包 `.11` 的记录见 [ci-34308304362](evidence/p4-6/ci-34308304362/README.md)。

本轮授权：同步状态文档、推送任务分支并手动 CI 打包；测试包名称/版本可递增。不本地打包、不推 tag、不触发自动发布。用户已明确授权本轮代码/工作流修复，与 Windows AI 同步推进。

## 当前 TODO：P4-6

- [x] 接棒 `9edab07c`，推送 `feat/runtime-evolution`，手动触发并核对 [CI 34303440949](https://github.com/p1p1dan/ai-client/actions/runs/34303440949)；未出包。
- [x] 修复 helper 测试样本，补齐打包 job 的 runtime 依赖与双后端冒烟；另补 native shell 接线和 ESM bundle 的 CommonJS 支持。本机小批测试/runtime typecheck 通过，产物待 CI。
- [x] 手动 [CI 34308304362](https://github.com/p1p1dan/ai-client/actions/runs/34308304362) 生成 `.11` Windows installer/unpacked；包含主线 GUI A～E 与正常退出修复，Windows/Linux 双后端产物冒烟通过，原始报告已归档。macOS 同轮仍运行。
- [x] 2026-09-09 Windows 现场执行 GUI A~E 与命令树清理五态：[GUI 结果与缺陷清单](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)、[五态清理证据](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)。GUI 大项通过，交回 7 组缺陷。
- [ ] 六项工具探针与两种 carrier 分别留证仍未执行；[主线 GUI 清单](../gui-sdk-experience/现场验收清单.md)按组回填中，未全部签收。
- [ ] 企业加密机签收明文读写、Main diff/编码/二进制判定、GUI/TUI 一致性与退出无残留；逐项回填 P1/P4，不能代签。

历史代码提交：`27ff2020` + `2ae6f209`（2026-09-08，实现与证据归档；不代表完整验收）。

## 已完成批次：P3-2 / P3-3 / P3-4 / P3-5（代码与证据已归档）

- [x] P3-2：完整树、导航、确认 rewind、独立 fork、标签与历史恢复。
- [x] P3-3：Pi v1/v2/v3 / PI-Desktop schema 1 迁移、来源保护、D14 旧值与历史状态恢复。
- [x] P3-4：既有 RuntimeEvent 翻译并接入 native run。
- [x] P3-5：Main SessionIndexService adapter 实际联调与持久化。
- [x] 按 [收尾契约](topics/p3-completion-contracts.md) 逐项验收、回归和证据归档。

## 已完成批次：P3-1 → P2-4（代码与证据已归档）

- [x] 核对 Pi v4 / PI-Desktop schema 1 差异并写入 [存储契约](topics/p3-1-session-contracts.md)。
- [x] 自有 JSONL 存储、独占 writer、损坏尾行处理、官方 Pi 格式互通。
- [x] message_end 写入、同 runtime 多 run 串行边界、dispose 排空。
- [x] 压缩记录持久化、跨 run/resume 恢复及再次压缩。
- [x] 小批回归、类型检查、证据与看板同步。

## 已完成批次：审查补修 → P2 接线

- [x] 修复内部容量提醒被当作用户任务保留，覆盖提醒后主动换窗的真实工具循环。
- [x] 首轮模型请求前检查预算；超预算明确失败，不截断用户输入、不调用 provider。
- [x] P2-1：注册 runtimePrompt，接通固定槽位、工具贡献和 D14 两轴；显式 systemPrompt 保留固定探针入口。
- [x] P2-2：InstructionSource 适配 HostIo，接入全局与项目指令链并验证真实请求。
- [x] 小批串行回归、类型检查、离线冒烟；更新看板/交接/证据。P2-4 依赖 P3，P2-5/P2-6 按计划在 P3/P4 后真实验收。

该历史批次已提交 `fb7cb10b`（2026-09-09）；[P2 验证记录](evidence/p2/README.md)记录 15 文件 195 项、类型检查与冒烟。

## 已落地：P4-0～P4-5（打包现场验收另列）

- [x] P4-0/P4-3：随包 Node / utilityProcess 共用 worker RPC 与事件/取消语义，host 配置按载体生成。
- [x] P4-1/P4-2：worker bootstrap 切入 Cordis 图；环境变量选 native，默认 legacy。
- [x] P4-4：多轮工具、审批、压缩、会话 RPC 与 GUI/TUI reload 接线本机通过。
- [x] P4-5：四处事件缺口已修，真实事件录制 6 项 + renderer reducer 重放 13 项；D13 读路径静态复核完成，驱动解密归 P4-6。

## P5-2 并行调研与后续完整复刻

- [x] 2026-09-09 用户确认整体复刻后优化；固定参考源码、追踪 ADR 演进、核对本仓差异。
- [x] 更新 ARD D10/D17、[完整契约](topics/p5-2-subagent-contracts.md)和[任务/验收矩阵](topics/p5-2-subagent-tasks.md)；参考 3 文件 32 项轻量测试通过，非产品验收。
- [ ] P4 稳定后执行 P5-2-0 版本/宿主依赖门禁（不新增版权、许可证或来源版本记录，不设许可证审批），再按 P5-2-1～6 实现整个子系统。
- [ ] P5-2-7：22 项等价矩阵与 GUI/两载体全部签收；不能用 runner 完成代替整体完成。
- [ ] 完整基线后另案优化并发资源/报告成本/性能；未开工。

## P2 后续门禁

- [x] P3-1：Pi v4 自有存储、与 PI-Desktop 不同 wire 格式的兼容契约和官方互通测试完成。
- [x] P2-4：compaction record 已经 session 存储持久化，跨 run/resume/进程重开与再次摘要通过。
- [x] P3-2/P3-3：完整分支导航、Pi v1/v2/v3/PI-Desktop schema 1 导入及 D14 旧值迁移；P3-4/P3-5 事件和索引已接通。
- [ ] P2-5/P2-6：P3/P4 后以 P2-0 同套会话实测，原始 provider 命中率不得低于 95.01%；记录 0.84.4/0.84.3 偏差。

## 已落地：D14 返工

- [x] 重读 P1 交接、ARD D14 和当前代码；确认旧 69 项测试不能代签新权限模型。
- [x] P1-1：plan/agent 枚举、注册表按模式裁剪，执行边界也拒绝被裁掉的工具。
- [x] P1-5 核心：ask/accept-edits/auto、旧值迁移、deny 优先；accept-edits 放行工作区 bash。
- [x] P1-5：Bash AST（引号、变量、cd、重定向、嵌套 shell/替换、通配符与 symlink）及原生策略加载已接入；路径同时参与 deny/scope 判定，审批后复核，普通工作区管道自动放行。
- [x] P1-5：导入全局/可信项目及旧 JSONC 配置；保持表合并顺序，glob 映射旧 find，坏配置明确阻止启动；policy 哈希/来源/迁移提示进 stamp。
- [ ] P1-5/P4：在真实项目中验证复杂脚本兼容与策略更新后的 runtime 重载；动态程序仍不属于 OS 沙箱保证。
- [x] P1/P2 提示词接口：导出 modeSegment / permissionGearSegment，对齐新固定槽位。
- [x] P1-6：renderer 两模式/三档控件与偏好迁移；新 IPC/RPC 传递完整 permissions，旧 tier 仅保留兼容入口。
- [x] P1-6：创建/resume/存量 worker 复用、空闲时更新、崩溃重启传递 mode + gear；worker 拒绝时 UI 不落盘。
- [x] P1-6：旧 worker 适配 D14 工具裁剪/授权器，随包 bash 默认询问，accept-edits 由授权器放行；DOM 交互与真实策略加载回归通过。
- [ ] P1-6/P4：打包壳 GUI 全链路签收；用户自定义策略与复杂 shell 兼容仍按 P1-5 跟踪。
- [x] 更新新矩阵与载体证据：native runtime 共 109 项通过，Node 与 Linux Electron 六项探针通过；Windows 和 GUI 仍待验收。

## 新增 P1-9（与 P2-8 成对）—— 已成对落地

- [x] 阅读 PI-Desktop new_context 源码和测试，适配无参数工具、两种回复及只提交意图语义。
- [x] 导出 newContextTool({ family, request })；已由 ContextPlugin 默认按 read 注册，plan 可用，无普通审批，显式工具白名单仍生效。
- [x] `runtimeContext` 服务落地：注册工具、消费意图、执行换窗（`prepareNextTurnWithContext` 边界）。压缩只换请求上下文；完整历史保留在 session 日志。
- [x] 提醒按注册结果决定是否点名工具，配对规则写进代码而不是靠人记得；提醒以尾部消息注入，保持 D9 缓存前缀不变。
- [x] 13 项配对/压缩用例 + 2 项措辞用例；runtime 全量 189 项、两个载体探针、离线冒烟通过。
- [x] P2-4 已完成 v4 compaction record 持久化及跨 run/resume；真实命中率复核仍待 P2-5/P2-6。

## 已落地（旧口径历史，当时尚未提交）

- [x] 收口契约三项建议和 Q6。
- [x] HostIo/Exec、TSD helper；bootstrap/catalog/trace 异步迁移。
- [x] 六工具注册表、文件/bash/搜索实现、四档权限、scope/白名单、审批桥接。
- [x] 本机相关 69 项测试、类型检查、P0 离线冒烟、Node 与真实 Electron utilityProcess 探针。
- [x] P1 工具/权限提示词贡献函数供 P2 装配；保留 P2 的已提交实现。

## P1 剩余现场 TODO

- [x] 增加保留进程树根身份的 Node runner；Linux 验证命令先退出后的后代清理。
- [x] Windows 验证 runner + taskkill 的命令树清理：正常/超时/取消/父先退/应用退出五态实测无残留 `node.exe`，见[证据](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)。P1-0 该项结清；P1-3 保持进行中。
- [ ] 用真实 Windows 随包 Node 跑 P1-8 六项工具探针与超时/退出检查。
- [ ] 在企业加密机签收工具读写明文、bash stdout 和残留进程检查。
- [x] 旧权限配置导入与两轴 worker RPC 本机回归；仍需 P4 的完整项目/打包链路签收。

## Windows 交回缺陷（2026-09-09，Linux 侧）

来源：[GUI A~E 现场结果](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)。归属 Linux 侧修复或决策；未修完不视为 P4-6 通过。

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| F2 | 🔴 | 临时工作区目录消失后无法对话（cwd 缺失被误报为 `node.exe ENOENT`）且无法删除 | 已修复 `dbead94b`，待现场复验 |
| F1 | 🔴 | 设置 → 终端「网络」子项点击报错 | **已修复（本轮）**：`RemoteSettings` 的四处 Field 子部件在 `<Field.Root>` 之外，渲染即抛 `FieldRootContext is missing`，整个网络分类挂掉。非 Windows 特有，Linux 上同样复现。补 `networkPanelMount` 挂载回归测试，待现场复验 |
| F3 | 🟠 | GUI 起 git 子进程 stdout 丢失，分支列表/状态为空 | **已定性**：载体问题，与 D1 同一个未知量（放行按进程名还是按进程树），[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f3--gui-起的-git-子进程输出丢失)。先按现状收，等 D1 的 R2/R3 探针一起拍板 |
| F4 | 🟡 | 503 不重试直接失败（529/429 未触发） | **已定性并修复（本轮）**：native 此前没有自有重试层，跑的是 SDK 默认阶梯。已搬 `createProviderRetryStream` 与错误分类到 `plugins/agent-loop/`——429 一条预算（5 次）、5xx/网络/超时一条（4 次，1s→8s）、`Retry-After` 优先并封顶、内层固定 `maxRetries: 0`；只接管流开始前的失败。31 项测试，[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f4--503-不重试直接失败)。待现场复测，F7d 一并复测 |
| F5 | 🟡 | native 会话无提问工具，QuestionCard/扩展问答无法弹卡 | **已定性**：能力缺口非回归——`question.requested` 全仓无生产者，legacy 同样弹不出；native 的扩展 UI 通道是通的（权限卡在用）。建议加 ask 工具但排进 P5-1 批，不阻塞 P4-6，[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f5--无提问工具questioncard--扩展问答弹不出来) |
| F6 | 🟡 | 文件修改 diff 为单栏 patch，无左右双栏对比 | 待评估：属形态优化，非功能缺陷 |
| F7 | 🟡 | a 授权详情样式 / b「正在输出」重复显示 / c 卡片尺寸字体 / d GPT 渠道 effort 无效且耗时长 / e 上下文详情需发一句话才显示 / f 输入框增高有限 | 待排期；d 的耗时部分随本轮重试层现场复测，`reasoning_effort` 无效仍待单独排查 |

另有一项与 F 清单同批交回：[旧会话 resume 身份不匹配](../../../../Windows-P4-6-evidence/old-session-resume-error.md)——所有 `runtimeIdentity` 仍指向 v3 文件的会话（本机 20 条）resume 必失败。
**已修复（本轮）**：bootstrap 新增 `sessionSourceFile` 声明转换来源，Main 只在 worker 指名「打开的是所请求文件的转换副本」时接受重定向，随即把索引身份迁到副本上（`adoptRematerializedFile` + `bindRuntimeIdentity`）；来源不匹配或未声明仍报 `worker_resume_identity_mismatch`。三项 WorkerManager 用例 + 一项 runtime 上报用例，待现场复验。

## 本轮重读确认的要求

- D11：Windows 安装版随包 Node；其他产品路径 electron-utility，独立 Node 探针另列。
- D12：Pi 保持 0.84.4；旧基线 0.84.3 的 patch 差记录为偏差，不回退、不补采。
- D13：Main 用户文件读取统一 TSD-aware，代码与静态复核已完成，驱动现场归 P4-6；Q7 已在本分支由 `b984b282` 修复，现场复测仍待 P4-6。
- D9：缓存门禁为 provider 原始 cacheRead / (input + cacheRead)，不低于旧基线 95.01%；属于 P2/P6，不用本轮 faux 测试代签。
- D14：旧 readonly 迁为 plan + ask，其余分别迁为 agent + ask/accept-edits/auto；goal 本轮不做。

## 验收边界

P1/P4 整体未完成。Linux/CI 不能代签 Windows 或企业加密机。远端 CI 已执行但测试门禁失败，尚未进入打包；P4-5 的事件/reducer 检查不代替真实打包 GUI 现场验收。
D13/Q7 代码已落地，现场复测归 P4-6。P2-5/P2-6 真实模型与缓存对比仍待后续执行。
