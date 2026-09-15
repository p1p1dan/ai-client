# Runtime 任务树只读审计（2026-09-14）

Role: evidence（review outcome + evidence index）。审计对象：核心任务树 P0～P6 与 H/20 的完成情况与完成质量；审计基线：工作区 2026-09-14 当时内容（HEAD `78695187` + 未提交的第 10 批改动）。修补由 [Runtime 加固与收口](../../../runtime-hardening/README.md) 计划承接。

## 文件索引

| 文件 | 内容 | 读法 |
|---|---|---|
| 本文 | 总体结论、方法与可信度、high 级全文摘要、medium 级按主题归并、裁决后的逐节点判定、low 级主题、未计入项、覆盖缺口 | 先读这份 |
| [findings-high.md](findings-high.md) | 10 条 high 的审查员原文 + 反驳者 + 取舍核对 | 修 high 时逐条读 |
| [findings-medium.md](findings-medium.md) | 48 条 medium 原文（含 12 条部分取舍中的 medium） | 按区域查 |
| [findings-low.md](findings-low.md) | low 级与 3 条文档已取舍项，一行一条 | 清扫时查 |
| [findings-uncertain-refuted.md](findings-uncertain-refuted.md) | 27 条待定与 20 条被推翻，含反驳理由 | 决定要不要补用例时查 |
| [area-assessments.md](area-assessments.md) | 13 个区域的总评、优点、弱点、测试缺口、读过的文件、逐节点原始判定 | 做节点回写时查 |
| [cross-and-critic.md](cross-and-critic.md) | 跨区域接缝 7 条 + 批评者的 20 条覆盖缺口与 18 条未经执行验证的声明 | 规划下一轮审计时查 |
| [findings.json](findings.json) | 完整结构化数据：99 个节点的验收标准、155 条文档取舍、18 条全局决策、235 条发现及双重验证结果 | 机器处理 |

## 一、总体结论

Runtime 任务树的功能面确实做齐了，但「完成质量」明显低于任务树上 ✅ 的密度。92 个子代理只读审查后，经反驳验证确认的缺陷 185 条，其中 10 条 high、约 49 条 medium。high 级集中在四个主题：bash 权限分析漏掉整类语法；GUI 与 TUI 交替写入会把会话文件写坏；子代理链路多处把内部报告当成用户消息或直接卡死进程；若干「代码写了但没接线」（请求头没发出、导入记录跨重启丢失、打包门禁跑已删除的 lane）。

按用户规则，文档明确取舍的项已剔除（3 条），部分取舍的 12 条保留但标注。

| 统计 | 数量 |
|---|---|
| 子代理总数 | 92（13 个区域审查 + 双重验证 + 接缝 + 批评者） |
| 发现总数 | 235 |
| 确认（含 12 条部分取舍） | 185 |
| 待定 | 27 |
| 被反驳者推翻 | 20 |
| 文档明确取舍、不计入 | 3 |
| 确认里 high / medium / low | 10 / ~49 / ~126 |

## 二、审查方式与可信度

每个区域一个 opus 代理逐文件通读源码、测试与相关文档，输出带 file:line 与代码引用的发现。每条发现再过两道独立验证：一个 opus「反驳者」重新读代码和第三方库源码尽力推翻；一个 sonnet「取舍核对员」查文档是否明确豁免。最后一个 opus 审 13 个区域之间的接缝，一个 opus「批评者」找覆盖盲区。所有代理只读：不构建、不跑测试、不写文件。

批评者给的整体置信度是 medium：
- `src/runtime` 的 80 个非测试源文件读了 77 个，44 个测试文件全读，「插件内部有没有缺陷」这一问的结论较可信。
- Main 进程侧（agent-host 一半模块、SessionIndexService、导入上游六模块、终端三模块）和渲染层（chat 下 100 个模块只读了不到 10 个）基本没覆盖。批评者抽查渲染层就发现一条没人报的回归：主时间线的工具动词表不认 native 注册的小写 `glob`、`ask`、`skill`、`browser_preview`、`TaskWait` 等，这些工具行全显示成「Ran …」。
- 所有 Windows、加密文件系统、Electron utility 载体的结论都是静态阅读，没有一次真实执行。
- 任务树里 12 类节点没被任何区域认领：P1-7、P2-0、P2-5、P2-6、P4-6、P5-2-0、H/17、H/19、H/21、F1～F7。

## 三、10 条 high 级确认缺陷

按后果排序。每条都经反驳者独立核实了完整触发路径。

1. **bash 权限分析漏掉前置重定向与 here-string**（`src/runtime/plugins/permissions/bash-analysis.ts:243`，P1-5，安全，permissions-01）。命令解析只遍历 argument 子节点，command 节点上的 redirect 子节点从不被看。`> /tmp/outside/x echo hi` 在 accept-edits 档直接放行写到工作区外；`cat <<< "$(cat .env)"` 把被 deny 的 .env 读进模型上下文。plan 模式也拦不住前缀写法。证据文档写「重定向、命令替换都解析，所有操作数参与 deny 判定」。
2. **GUI 与 TUI 交替写入后会话文件永久打不开**（`src/runtime/plugins/session/codec.ts:357`，H/20，session-01）。seq 被当严格位置计数器，CLI 追加占位后，worker 用内存旧 seq 再写一行，文件从此每次打开抛 `session_invalid`。reload 兜底只在「确实杀掉了一个活着的终端」时触发，用户在 pi 里自己退出时不执行；`/compact` 与 rewind 不经 TUI 释放就写 JSONL。
3. **Task 从准入到交接之间无异常保护**（`src/runtime/plugins/subagent/index.ts:539`，P5-2-2，subagent-core-01）。`admit()` 之后的 `await projectInstructions()` 与 `new SubagentRun()` 在 try/catch 之外，任何失败留下永不结算的 running 记录；父 run、Stop 后的 `drain()`、`dispose()` 三条出口都等它，只能杀进程。
4. **自动交回的子代理报告被当成真实用户消息**（`src/runtime/events/projector.ts:188` 与 `agent-loop/index.ts:379`，P3-4 / P5-2-4，rpc-projector-01 / subagent-core-02）。交回走 `agent.prompt(report)`，projector 对任何 user 消息铸用户气泡并盖原用户 attemptId 与附件，同时以 role=user 落盘；重开后它是「最新用户任务」。契约「内部报告无用户气泡」被直接违反。
5. **子代理不继承父回合模型，落到目录第一条**（`src/runtime/plugins/subagent/index.ts:412`，P5-2，cross-01）。注释与契约写「Task.model > pin > 父模型」，实现第三档是 `adapter.defaultRef()`；内置角色都无 pin，这是默认路径。
6. **目录里展开好的请求头从未发出**（`src/runtime/plugins/model-adapter/binding.ts:110`，P0-4 / P5-5，loop-model-01）。头挂在 pi-ai 的 Provider 对象上，pi-ai 只合并 `model.headers` 与 auth resolve 结果；F08 的 User-Agent 与管理员配的路由头在 native 上一个都没发。
7. **导入清单校验仍按 pi 命名，native 记录重启后静默丢失**（`src/main/services/legacyImport/LegacyImportManifest.ts:106`，P5-4，import-catalog-01）。要求 `_<id>.jsonl` 后缀而 native 写 `<id>.jsonl`，解析失败不打日志；跨重启去重与中断清理都失效；测试替身用 pi 命名所以全绿。
8. **打包验证脚本仍跑已删除的 legacy lane**（`scripts/verify-packaged-app.mjs:203`，P6-5，cutover-01）。legacy lane 起的仍是 native，按 legacy 形状断言 `bootstrap.extensions` 必抛；`pnpm verify:packaged` 与 CI 三处打包作业必红。
9. **一条悬空符号链接让 grep / glob 整体失效**（`src/runtime/plugins/tools/index.ts:594`，P1-4，tools-01）。`walk()` 判类型前无条件 `realpath`，ENOENT 冒泡出异步生成器；`readDirectory` 的 EACCES 同理。
10. **子代理审批活动被父循环过滤掉**（`src/runtime/plugins/agent-loop/index.ts:184`，P0-5 / P3-4，loop-model-06 / rpc-projector-04）。过滤条件是「toolCallId 在父 Agent 的集合里」，子代理的永远不在；policy 自动放行与用户决策都没有审计行与 trace。反驳者判 medium，此处按两区域交叉确认与审计语义列入。

## 四、medium 级确认缺陷（按主题归并）

- **权限内核（P1-5）**：命令名 deny 可被 `command`/`timeout`/`nice`/`nohup` 包装绕过（permissions-02）；`bash script.sh` 不标 unresolvedPaths（-03）；`-tDIR` 与 `of=/x` 形式路径被丢或记错（-06）；随包策略 `mcp`/`skill`/`ls` 面在 native 下从不被查询（-09，skills-mcp-11/12 同根）；Windows 分隔符混用使子目录通配展开成空集（-19，静态推断）。
- **文件与搜索工具（P1-2/3/4）**：50 KiB 二次截断切掉续读行号与退出码（tools-03）；单行超限时 nextOffset 指回同一行（-04）；bash details 里的 Uint8Array 被逐字节序列化、会话文件膨胀约 12 倍（-06）；通配符父目录不存在时预检抛裸 ENOENT（-07）；include/pattern 按相对路径整体匹配（-08）；模型正则无取消点可卡死 worker（-09）；空结果返回空文本块（-02）；加密文件下 readLines 分块 O(n²) 且每块拉一次 helper（-10）。
- **上下文与压缩（P2-3）**：回合边界压缩不写回 `agent.state.messages`，委派续跑把全量历史再发一遍（context-prompt-01）；`shapeForCheckpoint` 沿用旧 fileOps，最近改过的文件从 checkpoint 丢失（-02）。
- **会话存储（P3-1 / H/20）**：写给 CLI 的压缩锚点在工具回合末尾指向 toolResult（session-03）；写入失败后 `close()`/`dispose()` 永远 reject（-06）。
- **agent loop 与目录（P4-4 / P5-5）**：缺 API key 被当可重试故障等 43 秒（loop-model-04）；空 baseUrl 的 provider 进选择器且会直连 SDK 默认公网端点（-08）。
- **worker 集成（P4-1/3/4）**：显式 `effort='off'` 被目录档位覆盖（worker-runtime-02）；`worker.reload` 重建整图只有 10 秒预算（-05）；`worker.compact` 在序列化链里等模型且超时后摘要照样落盘（-06）；discardFork owned 分支恒失败且无测试（-01/-12）。
- **事件投影（P3-4 / P4-5）**：重试横幅无生产者（rpc-projector-02，部分取舍）；每个工具轮次多发一条空 assistant 消息（-03）。
- **skills 与 MCP（P5-1 / P5-3）**：tools/list 120 秒预算撞 Main 60 秒 bootstrap（skills-mcp-01）；工具重名在构造函数抛 duplicate_tool 打垮 bootstrap（-02）；工具名保留点号被 provider 拒（-03）；按 chunk 解码 UTF-8（-04）；图片折成 `[image]`（-05，部分取舍）；AbortSignal 不进 MCP（-06）；符号链接技能目录静默跳过（-08）；`disable-model-invocation` 被忽略（-09）；skill 工具不过权限门（-11）；MCP 策略段永不匹配（-12）。
- **子代理（P5-2）**：TaskStop 把已完成委派标 delivered 吞掉报告（subagent-core-03）；stopped 状态配 aborted 文本（-05）；迁移预览无任何入口而 SA19 签收为 tested（subagent-data-01）；定义只在建图时读一次（-02）；子代理花费无消费者（-03）。
- **导入与目录（P5-4 / P5-5）**：钥匙串锁定时的读盘回落未实现（import-catalog-02）；写盘与内存交付输入规则不同（-03）；测试替身命名掩盖 high 第 7 条（-11）。
- **P6 切换**：插件页仍称用户自装权限系统在审批（cutover-02）；侧栏插件清单与 MCP 徽标永久为空、已装扩展对 GUI 会话不生效（-03）；opt-in 链路空转、Sub-agents 开关显示与默认相反（-10）。
- **core-host**：provider 错误正文未脱敏进 trace 与 run 结果，现成的脱敏函数是死代码（core-host-03）。

## 五、裁决后的逐节点判定

各区域的原始判定在 [area-assessments.md](area-assessments.md)。批评者指出 4 个节点跨区域判定冲突（P4-3、P4-2、P2-1、P5-1）与 8 处 rationale 引用了被推翻的发现；下表是裁决后的单一状态，只引用经确认的发现。

| 节点 | 文档声称 | 审查判定 | 主要缺口 |
|---|---|---|---|
| P0-1 | ✅ | 完成 | 无 |
| P0-2 | ✅ | 完成（小瑕疵） | ExecPlugin 注册未 await fiber |
| P0-3 | ✅ | 完成（小瑕疵） | DEFERRED_SERVICES 门禁失灵。core-host-14 订阅者隔离已修（T022，`84ac35e0` + `117d97a9`） |
| P0-4 | ✅ | 有缺口 | 请求头不发出（high）；model 行 api 覆盖被忽略。已修（T007，`780dd9c1`） |
| P0-5 | ✅ | 完成 | 子代理审批过滤归 P3-4 |
| P0-6 | ✅ | 完成（小瑕疵） | config_version 冻结；失败分支错误正文进 trace。后者已修（T011，`b714a925`）；前者归 T028 |
| P1-0 | ✅ | 完成（小瑕疵） | 长驻子进程路径成熟度低；dispose 错误屏蔽。已修（T022，`84ac35e0` + `117d97a9`）；core-host-05 stderr 预算已修（T013，`19f9e888`） |
| P1-1 | ✅ | 完成 | 无 |
| P1-2 | ✅ | 有缺口 | 截断尾巴、单行死循环、空结果、BOM、TSD O(n²)。前四项已修（T012，`439ab922`）；TSD O(n²) 已修（T013，`19f9e888`） |
| P1-3 | ✅ | 有缺口 | 通配符父目录、退出码被切、details 膨胀。已修（通配符 T010 `1262e3b0`；其余 T012 `439ab922`） |
| P1-4 | ✅ | 有缺口 | 悬空 symlink（high）、include 语义、正则无取消。symlink 已修（T010，`1262e3b0`）；其余已修（T012，`439ab922`） |
| P1-5 | 🟡 | 有缺口（不宜升 ✅） | 6 条可静态复现的绕过。已修（T001，`c4e2b2e4`；permissions-09 由 T002 `10581139`） |
| P1-6 | 🟢 | 完成（小瑕疵） | timed_out 永不产出（已修：T017，`84ac35e0` + `83a9d0f8`）；write 覆盖显示为新增 |
| P1-8 | ✅ | 完成（证据陈旧） | 证据落后 HEAD 94/147 个提交 |
| P1-9 | ✅ | 完成 | 无 |
| P2-1 | ✅ | 完成（小瑕疵） | tool-guidance 大小写。已修（T014，`2c0eb30c`） |
| P2-2 | ✅ | 有缺口 | `run.targetPath` 无生产者（部分取舍）；目录形态 AGENTS.md 让 run 失败。已修（T014，`2c0eb30c`：targetPath 删除，分级加载归 T035） |
| P2-3 | ✅ | 有缺口 | 不回写 agent 状态、fileOps 丢失。已修（T014，`2c0eb30c`）；子代理压缩仍不做，只有预算守卫 |
| P2-4 | ✅ | 完成（小瑕疵） | /compact 无 signal；entriesFor 切片。已修（signal 由 T016 `a9ea7230`；切片由 T014 `2c0eb30c`） |
| P2-7 | ✅ | 完成（D9 可选项） | 模块无运行时调用方（文档取舍） |
| P2-8 | ✅ | 完成（小瑕疵） | per-run 而非 per-session。已修（T014，`2c0eb30c`） |
| P3-1 | ✅ | 有缺口 | close() 永久 reject；写锁 TOCTOU（待定）。均已修（T015，`ce2a7af8`；TOCTOU 用确定性用例证实成立） |
| P3-2 | ✅ | 完成 | piSessionTree.ts 未被读过 |
| P3-3 | ✅ | 完成（小瑕疵） | 旧 label 行不校验；裸 SyntaxError。已修（T015，`ce2a7af8`） |
| P3-4 | ✅ | 有缺口 | 报告当用户消息（high）、子代理审计行、空 assistant、无重试事件。前两项已修（T005，`4e80f9ff`）；后两项已修（T017，`84ac35e0` + `83a9d0f8`） |
| P3-5 | ✅ | 完成（证据不足） | NativeSessionIndexAdapter 零生产引用 |
| P3-6 | ✅ | 完成（小瑕疵） | 关键边界无反例测试 |
| P4-0 | ✅ | 完成 | 无 |
| P4-1 | ✅ | 有缺口 | discardFork owned 恒失败；dispose 抛错不自退。已修（T016，`a9ea7230`） |
| P4-2 | ✅ | 完成 | 残留只有注释与文档 |
| P4-3 | ✅ | 完成（小瑕疵） | reload/compact 超时预算不对称；死分支。已修（T016，`a9ea7230`） |
| P4-4 | ✅ | 有缺口 | effort off、compact 分叉、缺 key 重试 43 秒。缺 key 已修（T007，`780dd9c1`）；其余已修（T016，`a9ea7230`） |
| P4-5 | ✅ | 有缺口 | 录制只覆盖 11 种事件；两处真实回归；工具动词表漂移。录制已扩到五类、session.stderr 接上生产者（T017，`84ac35e0` + `83a9d0f8`）；工具动词表漂移归 T020 |
| P4-6 | 🟡 | 未评估 | 现场节点 |
| P5-1 | ✅ | 有缺口 | symlink、disable-model-invocation、YAML、skill 不过门。skill 过门已修（T002，`10581139`）；其余已修（T019，`39afacc8`） |
| P5-2-0 | ✅ | 未评估 | — |
| P5-2-1 | ✅ | 有缺口 | 定义不按 run 重读；pin 诊断无出口。cross-01/02 父模型与档位继承已修（T006，`d71eb2ec`）；其余归 T020 |
| P5-2-2 | ✅ | 有缺口 | Task 无保护窗口（high）、TaskStop 吞报告。已修（T004，`4e80f9ff`） |
| P5-2-3 | ✅ | 完成（小瑕疵） | scopeDelegateTools 无端到端用例 |
| P5-2-4 | ✅ | 有缺口 | 报告成用户消息（high）、子花费无消费者、事件无条数上限。第一项已修（T005，`4e80f9ff`）；后两项归 T020 |
| P5-2-5 | ✅ | 未完成 | 迁移预览无入口，SA19 签收不实 |
| P5-2-6 | ✅ | 完成（小瑕疵） | glob 行显示错参数 |
| P5-2-7 | 🟡 | 有缺口 | SA02/SA15/SA19 签收与代码不符；SA09 假时钟用例不存在。SA09/SA12/SA15/SA19 已标注实况（T027，`95e63960`） |
| P5-3 | ✅ | 有缺口 | 十条 MCP 缺陷。已修（T018，`942ee464`；mcp 面权限由 T002）。resources / prompts / sampling 仍在既有豁免内 |
| P5-4 | 🟡 | 有缺口 | 清单命名（high）、display-only 恒真、写锁旁车。清单命名与写锁旁车已修（T008，`23ac5df5` / `36389d1d`）；display-only 归 T021 |
| P5-5 | 🟡 | 有缺口 | 钥匙串回落、两条路规则、utility 仍读明文。utility 已修（T016，`a9ea7230`）；前两项归 T021 |
| P6-1 | ✅ | 完成 | 无 |
| P6-2 | ✅ | 完成（小瑕疵） | 守卫只认整包说明符 |
| P6-3 | 🟡 | 第 4 条存疑 | GUI 无回归未覆盖退役改变的界面；门禁脚本不可运行（已修，T009） |
| P6-4 | ✅ | 完成 | 无 |
| P6-5 | ✅ | 有缺口 | 只删了跑 legacy 的代码，没清失去消费者的一层。打包门禁已修（T009，`89c73e5b`）；清扫归 T025 |
| H/20 | 🟢 | 有缺口 | seq 陈旧（high）、压缩锚点、CLI 补换行（待定）。已修（T003，`0332214c`）；CLI 补换行判可达并修尾片形态；中段形态按决策 006 已修（T034，`1f1f40d0`） |

## 六、low 级与质量问题（126 条，按主题）

- 删除后未清扫的死代码与过时注释（约 20 条）：sessionTierAuthorizer、permissionActivity、bundledFeaturePlugins、extensionInventory、commandInventory、subagentProjection、extensionUiBridge 整条链路只剩测试引用；`*_UNAVAILABLE` 死分支；flags.ts 孤立 JSDoc；runtime README 与 P4-6 现场清单仍描述已删除的开关；leafCheckpoint 仍参与幂等比较。
- 「声明了但没接线」（约 12 条）：resolveToolOutcome、SubagentService.busy、subagentPinDiagnostics、SubagentConfig.thinkingLevel、NativeUtilityRuntime.modelCatalog、derivesBaseUrl、session.stderr、kind:'capped'、assertHostPromptAllowed、sessionKeysMatch。
- 错误形态不统一（约 8 条）：裸 TypeError / SyntaxError、同步 throw 与 reject 混用、setPermissionTier 谎报 applied。
- 资源与生命周期（约 10 条）：长驻子进程宽限假报退出；Windows killTree 无重入保护；write preview 全文进 trace 常驻内存；子代理转录无限额；handleDispose 无 try/finally；disposed 先置位吞掉收尾事件。
- 文档与代码矛盾（约 12 条）：evidence/p1 与任务树对 Windows 五态的说法相反；README P5-5 行与 p6-cutover 对派生明文文件的结论相反；loadSkills 注释 first-wins 实现 last-wins；SA09 签收声称的假时钟用例不存在。
- 边界处理（约 15 条）：CRLF 下正则 `$` 永不命中；isWithinRoot 对文件系统根失效；UTF-16 指令文件乱码注入；`$ARGUMENTS` 字符串替换；auth.json 损坏静默；定义写回转义不对称。
- i18n：`src/runtime/worker/permissionPrompt.ts:63-69` 直接产出用户可见中文，守卫扫描根不含 runtime 与 agent-host。
- 测试缺口（约 25 条）：无假时钟用例；无并发多会话用例；无 Windows 路径形态用例；没有一条测试跑带子代理的 run 并检查事件流；MCP 分帧/重名/取消无用例；golden fixture 只录 11 种事件。

## 七、未计入的项

- 文档明确取舍（3 条，剔除）：前缀稳定性模块无调用方（D9 可选项）；`Retry-After: 0` 退避为 0（服务端头一律优先）；父循环无流中恢复（F4 记录明写范围）。
- 部分取舍（12 条，保留打折）：重试横幅、MCP 图片、`run.targetPath`、GUI 改名对 CLI 不可见、prune 不保护未交付项、SA09 签收等。共同点是文档豁免了「没验证」或相邻能力，没豁免这条具体缺口。
- 待定（27 条）中值得跟进：session-02（CLI 补换行把可修复尾片变成不可修复坏行，medium）；session-04/05 写锁 TOCTOU；toolCallId 串档经接缝反驳者读 pi-ai 源码基本排除；core-host-05 TSD helper 输出预算。
- 被推翻（20 条）：例如策略文件 BOM、find -exec 逃过 deny、乐观气泡退不掉，已全部剔除。

## 八、覆盖缺口与建议

批评者的 20 条覆盖缺口压成六件事，已转为加固计划的批次 C 与 D：

1. 先做两件机械回写：P5-2-5 不宜按 ✅ 计；signoff 的 SA09/SA12/SA15/SA19 签收文字与代码不符。
2. 补审 Main 侧与渲染层：agent-host 一半模块与 13 个测试、SessionIndexService、导入上游六模块、终端三模块、chat 词汇表。
3. 补审未认领节点：P4-6、P2-5/P2-6（`compare.mjs` 仍要求 legacy 归档而采集脚本已删，加上 config_version 冻结，「可对比」这条规范在缓存命中率维度已断）、H/17、H/19、H/21、F 缺陷。
4. 把静态推断的 Windows / 加密机 / utility 载体项收敛成上机检查单。
5. 容量对账：bash details、子代理转录、write preview、MCP 响应四条都往 32 MiB 会话预算与无轮转的 runs.jsonl 写。
6. P6-5 清扫的另一半：按「哪些代码因为 legacy 走了而失去消费者」重新画线。
