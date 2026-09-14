# Roadmap — Runtime 加固与收口

Role: roadmap。本文件是任务身份、状态、顺序的唯一权威。建立：2026-09-14。发现编号（如 `permissions-01`）指向[审计证据](../runtime-evolution/evidence/runtime-audit-2026-09-14/README.md)。

状态：⬜ 未开始 · 🔧 进行中 · ✅ 已落地（挂提交与证据）· ⏸ 推迟（写明原因）。

## 顺序与依赖

批次 A（安全与数据完整性）先于 B（功能正确性）先于 C（清扫与文档）；D（补审）与 A/B 并行，只读不冲突；E（现场）最后一次上机，合并 A～D 的现场项。批次内按编号顺序，编号即建议顺序。

## Done

- ✅ **T001** bash 静态分析补全 — `c4e2b2e4`（2026-09-14）。permissions-01/02/03/04/05/06/19 已修；shellPolicy.test 26→60 条，每类反向验证记录在提交说明。PERM-1 探针需真机与真实模型，转入 T032 检查单。
- ✅ **T009** 打包门禁 native-only — `89c73e5b`（2026-09-14）。cutover-01 已修；CI 三平台绿灯待推送后的打包作业确认。cutover-16 拆解结论记入 T025，门禁新增断言建议记入 T028。
- ✅ **T003** H/20 交叉写入 — `0332214c`（2026-09-14）。session-01/02/03/13、cutover-04 已修；Q005 结案（可达，已修「CLI 打开未再写」形态），中段坏行记 Q008。真机一圈归 T032。
- ✅ **T004 + T005** 子代理错误路径与内部报告投影 — `4e80f9ff`（2026-09-14）。subagent-core-01/02/03/04/05、rpc-projector-01/04、loop-model-06 已修；新增 golden 录制 `nativeGuiSubagentEventStream.json`。权限行的委派归属展示留 UI 批次。
- ✅ **T027（两件机械活）** signoff SA09/SA12/SA15/SA19 实况标注、P5-2-5 标注 — `95e63960`（2026-09-14）。T027 其余文档回写仍在批次 C。

## In Progress

- 2026-09-14 批次 A 第一波 **已提交（c4e2b2e4 / 89c73e5b / 95e63960）**：T001（bash 静态分析，shellPolicy.test 26→60 条，七类发现各有反向验证；permissions-04 改为 auto 放行加 `!unresolvedPaths` 条件而非整行下移，避免顺带改动 scope/grants 语义；here-string 字面量按审计要求登记为路径，属保守取舍；PERM-1 探针需真机与真实模型，留到批次 E）、T009（两脚本只剩 native lane，`report.stamp.backend` 改读 trace 自证；CI workflow 无需改）、T027 两件机械回写（signoff SA09/SA12/SA15/SA19、P5-2-5 标注）。全量 397 文件 / 5644 测试、三套 tsc、Biome 通过。
- 2026-09-14 批次 A 第二波 **已提交（0332214c / 4e80f9ff / 06ea395d）**：
  - T003：CLI 行不计入我方 seq 空间，对老文件保留「不超过此前 CLI 行数」的兼容额度；紧跟 CLI 行之后一行豁免一次 lane 链校验（审计未提、同一缺陷的另一面）；TUI 退出（含 pi 自行退出）无条件 reload，靠记录「终端可能写过的会话」；send / compact / rewind 共用「释放 → 过闸 → reload」；`assertHostPromptAllowed` 改为按会话键判断（无参会误伤切会话发送，与审计建议不同）；compactionAnchor 从 retainedTail 按 role+timestamp 反查，查不到不写锚点。Q005 结案：session-02 用真实 SessionManager 证明可达并修「CLI 打开未再写」形态，中段坏行形态记 Q008。
  - T004：admit 后整段 try/catch（`delegation_start_failed`）；drain 30 秒兜底（`delegation_drain_timeout`，强制 settle 为 timed_out）；TaskStop 对已完成目标把报告放进返回文本；prune 只淘汰已交付项；cancelReason 单一真相源区分 stopped / timed_out 并带 lastReportText。顺带让 `subagents.projectInstructions` 选项真正生效。
  - T005：交回消息打 `aiclientInternal` 标记（`src/shared/internalMessage.ts`），projector 不铸用户气泡、重开不当最新用户任务、compaction 的 latestUser 排除它（额外一条，契约 §3 明写）；权限活动过滤放宽为父调用或已登记委派，payload 带 delegationId / agentName，授权语义按决策 003 不变；新增独立 golden 录制 `nativeGuiSubagentEventStream.json`（28 条），原录制未重录。渲染层只补类型，归属展示留 UI 批次。
  - 全量 398 文件 / 5680 测试、三套 tsc、Biome 通过。
- 2026-09-14 批次 A 第三波开工：T002（权限 surface 映射）、T006（子代理继承父回合）。

## Next

### 批次 A：安全与数据完整性

| ID | 任务 | 节点 | 覆盖的发现 | 验收 |
|---|---|---|---|---|
| T001 | bash 静态分析补全：遍历 command 节点的 redirect 子节点（前置重定向、here-string）；命令名 basename 归一并把 timeout/nice/nohup/time/stdbuf/command 一类包装词按剥壳或 unresolved 处理；`bash/sh/zsh/dash script` 无 -c 时置 unresolvedPaths；命令名位置的命令替换走 visitSubstitutions；贴合选项与 `key=value` 操作数登记为路径；auto 档改到 unresolvedPaths 判定之后；addPath/expand 统一路径分隔符 | P1-5 | permissions-01/02/03/04/05/06/19 | shellPolicy.test 新增每类形态的正反用例；PERM-1 探针复跑；混合分隔符用例不需真 Windows |
| T002 | 权限 surface 映射：`mcp__server__tool` 授权时以 `mcp` 为 surface、`server:tool` 为匹配值；skill 工具与 `/skill:name` 展开过 authorize（surface `skill`，目录已信任的路径判 allow 不弹卡）；删随包策略里无生产者的 `ls` 规则；allow-session 保持会话级不收敛（决策 003），审批卡文案注明对本会话所有代理生效 | P1-5 / P5-1 / P5-3 | permissions-09、skills-mcp-11/12、cross-05 | 策略里写 `mcp: deny` / `skill: deny` 在 auto 档真的拦住；permission.activity 出现 skill 行 |
| T003 | H/20 交叉写入：解码端不把 CLI 行计入 seq 空间或对陈旧 seq 按位置容忍；TUI 退出（含 pi 自行退出）无条件 reload；CHAT_COMPACT / CHAT_REWIND 前做 TUI 释放；`assertHostPromptAllowed` 接到发送路径；compactionAnchor 改为从 retainedTail 反查条目 id，查不到退化为 undefined；先补「CLI 追加后我方以陈旧 seq 再写」「CLI 补换行后再打开」两条用例把 session-02 从待定推到结论 | H/20 / P3-1 | session-01/02/03/13、cutover-04 | sessionInterop.test 新增交替写入用例；真机 GUI→TUI→GUI 一圈留到批次 E |
| T004 | 子代理编排错误路径：admit 之后到 SubagentRun 接手之间整段 try/catch，失败即 settle 为 failed；drain() 加兜底超时；TaskStop 只对真正被停掉的记录 markDelivered，已完成目标把报告放进返回文本；prune 不淘汰未交付项；run() 区分 stopped/timed_out 并带 lastReportText | P5-2-2 | subagent-core-01/03/04/05 | 新增 projectInstructions 拒绝、TaskStop 传已完成 id、registry 满 100 条淘汰三条用例 |
| T005 | 内部报告与审计投影：交回 prompt 打内部标记，projector 不投影为用户气泡、不盖 attemptId/附件（落盘保留但标记）；权限活动过滤条件放宽为「本 run 父调用或已登记的委派调用」，payload 带 delegationId/agentName | P3-4 / P5-2-4 | rpc-projector-01/04、subagent-core-02、loop-model-06 | 一条带子代理的 run 端到端事件流用例；guiEventContract 录制扩到子代理 |
| T006 | 子代理继承父回合：bindRun 传父回合解析出的 model ref 与 thinkingLevel，resolveModel 第三档用它；委派面板 resolvedModel 与父一致 | P5-2-1 / P5-2-2 | cross-01/02 | 用例：父回合切模型后委派，子代理 ref 等于父 |
| T007 | 模型绑定与目录诊断：展开后的 headers 放进 auth resolve 返回值或每个 Model；per-model api 用 pi-ai 的 map 形态；缺 API key 归入不可重试并进 dropped（`no_api_key`）；空 baseUrl 进 dropped（`no_base_url`）；auth.json 损坏给诊断；dropped 在 catalog_empty 抛错前也留一条出口 | P0-4 / P5-5 | loop-model-01/02/04/07/08、cross-06 | 用例断言请求真的带 User-Agent；catalog_empty 时 dropped 可读 |
| T008 | 导入清单与路径：清单校验同时接受 `<id>.jsonl` 与 `*_<id>.jsonl`；parseRecord 失败打 warn；四个导入 RPC 对 targetPiSessionId 用 isLegacyImportPathSegment；reconcile 清理写锁旁车与暂存目录，且单条失败不连坐后续记录；测试替身改 native 命名并补「落盘 → 新实例重载 → already-imported」用例 | P5-4 | import-catalog-01/07/09/10/11 | 替身改名后现有用例仍绿；reconcile 多记录用例 |
| T009 | 打包门禁 native-only：verify-packaged-app 只跑 native lane，packaged-worker-smoke 删 --backend 与 legacy 分支；顺带只读审查打包链（agent-host-build-lib、packaging-budget、afterPack）给出 native-only 后的门禁形状 | P6-5 / P6-3 | cutover-01、cutover-16 | `pnpm verify:packaged` 在 CI 三平台绿 |
| T010 | 搜索遍历容错：walk() 先看 entry.kind，symlink 直接跳过，realpath/readDirectory 包 try/catch 按跳过处理；checkShellPaths.expand 的 readDirectory 对 ENOENT/ENOTDIR/EACCES 按空展开 | P1-4 / P1-3 | tools-01/07 | 悬空 symlink、EACCES 子目录、不存在的通配父目录三条用例 |
| T011 | trace 脱敏与体积：provider 错误正文过 redactSensitiveErrorText 并截 600 字再进 trace 与 run 结果；审批 preview 进 trace 前截断；write preview 不常驻内存 | P0-6 / P1-6 | core-host-03、permissions-12、tools-11 | 含 `Authorization: Bearer` 的假错误在 runs.jsonl 里是 [REDACTED] |

### 批次 B：功能正确性

| ID | 任务 | 节点 | 覆盖的发现 | 验收 |
|---|---|---|---|---|
| T012 | 工具输出形状：状态尾巴先留预算再拼接；单行超限时 nextOffset 前进；空结果给占位文本；bash details 只放标量，read details 去重复 text；include/pattern 不含 `/` 时按任意深度；正则循环加取消点与单文件时间预算；edit/readBeforeChange 保 BOM；非 UTF-8 报带 code 的错误；CRLF 去 `\r`；limit 恰满不误报 | P1-2/3/4 | tools-02/03/04/05/06/08/09/12/13/14/17 | 每条一个用例；tools.test 顶满 50 KiB 的 read 与 bash |
| T013 | TSD 读取效率：readLines 在 node-fallback 下把块大小提到输出预算量级或让 HostIo 暴露可复用句柄；helper 的 stderr 与 stdout 预算分开 | P1-2 / P1-0 | tools-10、core-host-05 | fake HostIo 计数断言 readFile 调用次数 |
| T014 | 压缩与提示词：回合边界压缩成功后写回 agent.state.messages；shapeForCheckpoint 重算 fileOps；hard limit 下 compaction_empty_range 与摘要超窗两条死路给降级；instructionSource 吞 invalid_host_request；entriesFor 切片口径与 snapshot 一致；提醒档位按会话；run 前 prepareTurn 记 trace；isWithinRoot 处理文件系统根；指令文件编码识别；tool-guidance 工具名大小写；`run.targetPath` 按 Q001 决定接线或删 | P2-2/3/4/8 | context-prompt-01/02/03/04/05/06/08/10/11/13/14/15/16/17 | 「压缩后同一 run 再 prompt」用例；checkpoint details 覆盖被摘要消息 |
| T015 | 会话 store 与写锁：close() 用 allSettled 等队列、锁释放后正常 resolve；释放锁校验 token；clearStale 抢占加归属校验；旧 label 行校验 targetId；首行解析包 code；32 MiB 常量集中；补两个进程同时抢陈旧锁的并发用例 | P3-1 / P3-3 | session-04/05/06/09/10/12 | 写失败后 dispose 正常完成的用例 |
| T016 | worker 生命周期与超时：discardFork 在 dispose 前 unlink；reload/compact 传与 bootstrap 同量级超时且 compact 传 signal；显式 effort=off 不回落配置；handleDispose try/finally，disposed 置位放在拆除之后；setPermissionTier 不谎报；utility.start 交付 modelCatalog | P4-1/3/4 / P5-5 | worker-runtime-01/02/05/06/07/09/12、rpc-projector-05/06/08/10、import-catalog-04、context-prompt-07 | 假 handle dispose reject 的用例；utility 路径不读 models.json |
| T017 | 事件投影与 golden 录制：assistant 消息惰性开启、无内容不发 completed；providerRetry 的 onRetry 发带 retry 的 session.status；tool.updated 带 input；超时产出 timed_out；session.stderr 接生产者或删类型；重录 nativeGuiEventStream 并扩到 thinking / 子代理 / 重试 / 问答 / 压缩 | P3-4 / P4-5 | rpc-projector-02/03/07/13/17/18、permissions-08 | 重录 fixture 后逐条读 diff；renderer 回放测试同步 |
| T018 | MCP：tools/list 留在连接预算内且 connectMcpServers 有小于 60 秒的总预算；listTools 去重、register 包 try/catch 记进 connection.error；工具名白名单收窄到 `[A-Za-z0-9_-]`；StringDecoder 跨 chunk；image part 透传；request 接 AbortSignal 并发 notifications/cancelled；项目 disabled 覆盖用户同名；帧长按字节计且超限杀进程；spawn 失败不伪造 client；未实现方法回 method not found；MAX_SERVERS 截断按声明顺序 | P5-3 | skills-mcp-01/02/03/04/05/06/07/14/15/16/21/24 | mcp.test 新增分帧、重名、慢 tools/list、取消四类 |
| T019 | skills 与模板：symlink 条目 stat 后再判；解析 disable-model-invocation 并在提示词过滤；YAML 块标量报诊断；$ARGUMENTS 用函数替换值；描述回退截 60 字；目录扫描可刷新或文档改口；祖先目录按 Q004 | P5-1 | skills-mcp-08/09/10/17/18/19/20/22/25 | skills.test 新增 symlink、disable、块标量用例 |
| T020 | 子代理数据与展示：迁移预览接 IPC + 设置页入口或改签收；定义每个顶层 run 重读；subagentUsage 经事件送到 Main 并入会话总量；事件条数上限与 capped；转录写入限额；渲染层动词/参数表补 glob、browser_preview、ask、skill、new_context、Task*、mcp__*；定义写回转义对称；迁移器原型链键与带引号布尔；诊断出口；usage 求和复用 addUsage；turn 计数转发；截断保代理对；BOM 文档两读者一致 | P5-2-1/4/5/6 | subagent-data-01～17、subagent-core-06/12/13 | 定义编辑后下一 run 生效的用例；面板与主时间线工具行渲染的跨层用例 |
| T021 | 模型目录 Main 侧：resolveNativeModelCatalog 在凭据不可读或用户组读失败时返回 undefined 走读盘回落；托管半边选取抽成共用函数并按凭据模式判定；model 级 baseUrl 在 Main 组装路径可达；补 resolveNativeModelCatalog 单测 | P5-5 | import-catalog-02/03/06/12 | 钥匙串 locked 场景用例 |
| T022 | host exec 与 bootstrap：dispose 里 trace flush 失败不吞 exec 清理失败；长驻子进程 kill 宽限用尽报 exec_cleanup_failed；Windows killTree 加重入保护并跟踪 taskkill；spawn/shutdown 并发回收；abort 监听器摘除；readDirectory 校验前置；runner 助手路径缓存；EventsPlugin 订阅者隔离 | P1-0 / P0-3 | core-host-04/06/07/08/09/10/11/14/20 | host.test 新增运行中取消与清理失败路径 |
| T023 | i18n：runtime 产出的用户可见文案改为结构化标识、渲染层查词典；noHardcodedChinese 扫描根加 runtime 与 agent-host | P1-6 | 批评者 i18n 缺口、cutover-17 | 守卫反向验证 |
| T024 | 容量对账：按来源列出写进会话文件与 trace 的最大字节（工具结果、审批 preview、子代理转录、MCP 响应），与 32 MiB 预算对账并给 runs.jsonl 轮转 | P3-1 | 批评者容量缺口、subagent-data-05、tools-06 | 一份对账表 + 至少一处限额落地 |

### 批次 C：退役清扫与文档回写

| ID | 任务 | 节点 | 覆盖的发现 | 验收 |
|---|---|---|---|---|
| T025 | 死代码与死字段：随包 `@juicesharp/rpiv-ask-user-question` 与 `@gotgenes/pi-subagents` 为纯载荷（cutover-16 经 T009 拆解，约 1.7MB），从 bundledPlugins / REQUIRED_WORKER_PACKAGES / verifyArtifact 删除，`@gotgenes/pi-permission-system` 的 config.json 位置仍被 native 读取需保留；sessionTierAuthorizer、permissionActivity、bundledFeaturePlugins、extensionInventory、commandInventory、subagentProjection、extensionUiBridge 链路、permissionPlugin 注入决策、sessionKeysMatch、leafCheckpoint、`*_UNAVAILABLE` 死分支、worker 侧 seq 逐一确认后删除或改注释；PiWorkerRuntime 可选方法收紧为必填 | P6-5 / P4-3 | cutover-05/06/07/20、permissions-11、subagent-data-13、cross-07、rpc-projector-09/15、permissions-15 | 删除后三套 tsc 与全量测试绿；守卫注释同步 |
| T026 | 用户可见的退役残留：插件页权限归属文案改为「审批由本应用自有权限系统负责，自装扩展只影响内嵌终端」；侧栏插件清单与 MCP 徽标改从自有能力投影；opt-in 链路删除或消费，Sub-agents 开关与 native 默认一致 | P6-5 / P6-3 | cutover-02/03/10 | 开发机点验三处界面 |
| T027 | 文档回写：runtime README 与 P4-6 现场清单去掉已删除的开关；README P5-5 行与 p6-cutover 对派生明文文件的结论统一；piSessionPreflight 保留理由改写；evidence/p1 的 Windows 说法与任务树一致；signoff 的 SA09/SA12/SA15/SA19 改为实际状态；P5-2-5 在旧树标注「迁移预览未接入口」；四个跨区域冲突节点的裁决记入审计证据；被推翻的发现从各区域 rationale 里清掉 | 文档 | cutover-08/12/18、core-host-15/16/17/18、subagent-core-16、审计第五节 | 链接全部可解析 |
| T028 | 守卫与基线：打包门禁补「native bootstrap 结果不带 extensions 字段」与 `report.workerExecutable` / `exitCode` 断言（T009 审查建议）；口径 A 守卫认子路径 import；workerEntryWiring 用例名与实际一致或补真实进程用例；DEFERRED_SERVICES 与门禁修正；config_version 解冻并写明分代规则；runtime-baseline 脚本在只剩 native 采集器后能独立跑通，compare.mjs 对缺失 legacy 归档的处理写明 | P6-2 / P0-3 / P0-6 / P2-5 | cutover-11/13、core-host-01/02、批评者 P2-5/P2-6 缺口 | 守卫反向验证；基线脚本一次干跑 |

### 批次 D：审计覆盖补全（只读）

| ID | 任务 | 范围 | 验收 |
|---|---|---|---|
| T029 | Main 侧宿主与渲染层：agent-host 未读的 8 个模块与 13 个测试、SessionIndexService 与 fork 生命周期、导入上游六模块、终端三模块、PiUtilityService 与 ai/*.ts 三个入口；chat 目录词汇表全量比对 | 批评者缺口 1/2/3/4/5/8/19 | 一份同格式的补审证据，发现进本 roadmap |
| T030 | 未认领节点：P4-6 现场口径、P2-5/P2-6 可比性、H/17、H/19、H/21、F1～F7 复核；P0-6 的 smoke/runOnce 与 assertions；D1 的 cordis spike | 批评者缺口 6/7/9/10 | 同上 |
| T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数；NodeRuntimeResolver、taskkill 路径、路径拼接与 glob 展开、会话文件路径；TSD helper 契约用替身固化 | 批评者缺口 12/13/14/15/16 | 形成批次 E 的检查单 |

### 批次 E：现场

| ID | 任务 | 范围 | 验收 |
|---|---|---|---|
| T032 | 上机检查单：合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）、T001 后的 PERM-1 探针复跑（`scripts/run-perm1-probe.mjs`，需真实模型回合）与审计静态推断项（permissions-19、core-host-05/07、tools-10、cutover-03、P1-8 证据重采、P6-4 旧版产物互读） | 旧树第 11 批 + 审计 | 检查单每项有判据与取证方式 |
| T033 | 最后一次上机：加密 Windows 一次性全量验收 | T032 | 逐项取证进 evidence |

## Deferred

| 项 | 原因 |
|---|---|
| 前缀稳定性模块（P2-7）保留或删除 | ARD D9 明写为可选加强项；见 Q002 |
| 父循环流中失败恢复 | F4 记录明写只接管流开始前的失败（文档取舍） |
| 「本次会话允许」按委派归属收敛 | 已决不做：保持会话级，见[决策 003](decisions/003-allow-session-stays-session-scoped.md) |
