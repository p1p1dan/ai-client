# 批次 D 跨区域接缝审查与完整性批评（原文）

Role: evidence（source material，原文保留）；来源：2026-09-15 批次 D 只读补审（T029 / T030 / T031，基线 HEAD `ebc82f16`）。18 个区域审查与双重验证跑完之后，一个接缝审查员读 18 份报告之间的缝并直接回代码核实，一个批评者按 09-14 审计批评者留下的 21 条覆盖缺口逐条对账。两人都只读：不构建、不跑测试、不改文件。

本文包含：接缝审查员的总评、去重 5 组、新查出的 4 条接缝发现全文、22 条节点裁决全文、20 个修补分组、10 条弱点；以及批评者的置信度、21 条缺口对账、9 条仍未覆盖、8 条矛盾、22 条未经执行验证的声明、34 条上机必做。逐条发现见 [findings-high.md](findings-high.md) / [findings-medium.md](findings-medium.md) / [findings-low.md](findings-low.md)，总览见 [README.md](README.md)。

## 一、接缝审查（CROSS REVIEW）

### 总评

批次 D 补审的 129 条里 121 条确认，去重后 115 条独立缺陷，加上我这一轮跨区域新查出的 4 条，共 119 条进修补分组。总体判断：runtime 本体（插件内部逻辑、单会话 RPC、事件投影主干）是扎实的，缺陷几乎全部集中在**接缝**——一侧把语义实现了，另一侧没接线，而中间的注释还在替它背书。最典型的三种形态：(1) 限额与诊断在 runtime 侧执行，在 Main / 渲染层的投影里完全不可见（我新发现的 d-cross-01～03，子代理 16 条上限、MCP 16 台上限、技能/子代理解析失败在管理界面与能力面板里一条都看不到）；(2) 渲染层能画的东西 runtime 根本没持久化（d-cross-04，权限卡与问答卡从不写进会话文件，所以「重开会话后消失」不是渲染层能单独修的）；(3) 退役后没有清扫的死通道，注释仍写着它是现行修复（tier 通道、五种诊断、host.ready/host.error、NodeRuntimeResolver 一条链）。节点裁决上最需要拍板的是 P4-6：field-nodes 判 complete-with-gaps、windows-static 判 incomplete，我裁 incomplete——它是全树唯一的现场验收节点，验收表里 R2/R3/R4 三行从未执行，而 Windows 面上恰好压着唯一一条 high 级安全绕过（windows-01）。P4-0 被 5 个区域一致判 complete-with-gaps，直接推翻 09-14 审计的「完成·无缺口」。修补分成 20 组：13 组 fix-before-e（3 条 high 全在其中）、6 组 fix-after-e、1 组 docs-only、1 组 checklist-e。需要提醒的是，13 组 before-e 对上机前的时间窗来说偏多，如果要再压缩，第 11 组（TSD）与第 12 组（终端/TUI）里有一部分其实可以转成上机当天的观察项。

### 去重（5 组，6 条并入）

被并入的条目在 findings-*.md 里原文保留、标题行标 `→ 并入 <keep>`，但不计入独立缺陷数，也不单独进修补分组。

| keep（主编号） | merge（并入） | 理由 |
|---|---|---|
| `concurrency-03` | `capacity-05` | 同一根因：src/runtime/trace.ts 的轮转逻辑在多个 worker 进程共享同一个 traceDir 时没有跨进程互斥。concurrency-03 说的是「双重轮转提前丢一代并在代号上留空洞」（trace.ts:258），capacity-05 说的是「runs.jsonl 轮转无跨进程互斥」（trace.ts:81），是同一份非原子的 rename+重建序列的两个观察角度，一次加文件锁（或改为按进程分目录）同时解决。保留 concurrency-03 作主编号，因为它把用户可见后果说全了。 |
| `concurrency-02` | `windows-06` | 同一根因：src/runtime/plugins/session/writerLock.ts:128 判定陈旧锁只看 PID 是否存活，PID 被系统复用后这把锁永远判不成陈旧。concurrency-02 从并发角度提出（会话永久打不开、界面无补救入口），windows-06 从 Windows 角度提出同一行代码（Windows 的 PID 复用更快，且 acquiredAt 记了却没人读）。修法是同一个：把 acquiredAt/启动时间或进程签名纳入陈旧判定，并给界面一个强制接管入口。windows-06 补充的「acquiredAt 已记录但无读者」要并进修复范围。 |
| `tsd-03` | `main-host-04` | 同一根因：src/main/services/agent-host/WorkerTransport.ts 里 utilityProcess 支路不排空 worker 的 stdout，而 child_process 支路显式 resume() 并写明了原因（D11 第 5 条只落实了一半）。tsd-03 锚在 :56、main-host-04 锚在 :96，是同一个分支对的两侧，一次补上 utility 支路的 resume() 即同时消除。保留 tsd-03，因为它的严重级是 medium（main-host-04 记为 low），取组内最高。 |
| `main-aux-06` | `ah-lib-01`、`ah-lib-02` | 同一根因：仓库里有两套脱敏实现（src/agent-host/stderrRedaction.ts 与 T011 新写的 src/runtime/plugins/agent-loop/providerErrors.ts），既没有统一，也没有装在所有出口上。三条是同一个缺口的三个出口：worker stderr 进 main.log 的两路是原文（main-aux-06，WorkerManager.ts:2062 的 this.log(prefix, line) 在 sanitizeStderrLine 之前）、provider 错误正文落进会话文件两套都没走（ah-lib-01）、新那套规则比既有那套弱、认不出裸密钥（ah-lib-02）。必须作为一个修补任务：先合并成一份规则，再逐出口装上。保留 main-aux-06 作主编号（medium security，出口最具体）。 |
| `utility-01` | `utility-07` | 同一根因：src/main/services/agent-host/PiUtilityService.ts 的一次性补全通道只有一个 timeoutMs 常量在同时充当三件事的预算。utility-01 是「冷启动用了 10 秒热请求预算，而会话路径为同一件事配了 60 秒」（:119），utility-07 是「两端共用同一个 timeoutMs、没有先后余量，worker 侧那份永远轮不到」（:169）。两条都要靠同一张「utility 通道超时预算表」（冷启动 / 热请求 / Main 侧 / worker 侧，并保证严格不等式）来修，与 /compact 已有的 60s>45s 做法一致。保留 utility-01。 |

### 接缝新增发现（4 条，编号 d-cross-01～04）

这四条都不是任何单个区域能看见的：每条都要同时读 runtime、worker 协议与 Main / 渲染层两侧以上才成立。格式同区域发现，但没有 REFUTER / WAIVER 段——接缝审查员自己回代码核实。

### [d-cross-01] MEDIUM contract-gap confirmed | P5-1 / P5-3 / H/19（runtime 能力目录 ↔ worker 协议 ↔ 渲染层能力面板） | src/runtime/worker/nativeWorkerRuntime.ts:319 | worker 的能力清单只报数量，三个目录的全部诊断在协议上就没有位置，界面却把这份清单当成「这次会话带起来了什么」的全部答案
DESC: runtime 的三个目录加载器都会产出 diagnostics：技能目录（skills 插件的 diagnostics）、子代理目录（parse_failed / document_too_large / too_many）、MCP 配置（invalid_entry，含超过 16 台被丢弃的名单）。但 worker 往 Main 报的 WorkerCapabilityInventory 只有 mcpServers 列表和 skills / promptTemplates / subagents 三个计数，没有任何 diagnostics 字段；渲染层的 Capabilities 对话框直接把这份清单渲染出来，并在标题上写「MCP servers, skills and sub-agents this chat brought up.」。结果是：一份写坏的技能文档、一个超过上限被丢掉的子代理、一台超出 16 台被切掉的 MCP 服务器，在界面上都表现为「它就是不在列表里」，没有任何解释。这些诊断唯一的去处是 worker 日志（SubagentPlugin.reportDiagnostics 调 this.config.log），以及模型调用未知子代理时拼进 Task 错误正文的一句话——两个用户都看不到的地方。这条只有把 runtime（产出诊断）、workerRpc 协议（没有字段）、渲染层（把计数当全部）三侧合起来读才能成立，任何单个区域看到的都只是「它自己那一侧是自洽的」。
EVIDENCE: src/runtime/worker/nativeWorkerRuntime.ts:319-337
  private capabilities(): WorkerCapabilityInventory {
    ...
      ...(skills ? { skills: skills.skills.length, promptTemplates: skills.templates.length } : {}),
      ...(subagents ? { subagents: subagents.definitions.length } : {}),
    };
  }

src/shared/types/workerRpc.ts:208-246 —— WorkerMcpServerInfo 只有 name / ok / toolCount / error，WorkerCapabilityInventory 只有 mcpServers?、skills?、promptTemplates?、subagents?，没有任何 diagnostics 通道。

src/runtime/plugins/subagent/index.ts:455-461
  /** subagent-data-10 — the one place a bad definition document is reported. */
  private reportDiagnostics(): void {
    for (const diagnostic of this.diagnostics) {
      this.config.log?.(
        `[subagent] ${diagnostic.code}: ${diagnostic.path} — ${diagnostic.message}`
      );

src/renderer/components/workspace-shell/LeftDock.tsx:455
            {t('MCP servers, skills and sub-agents this chat brought up.')}
SCENARIO: 用户在 <agentDir>/skills 下放了 5 份技能文档，其中一份 frontmatter 写坏。开会话后 Capabilities 对话框显示「Skills 4」。用户看到的是 4，没有任何提示说第 5 份加载失败、失败在哪一行、文件在哪里；模型也不会提到它，因为技能压根没进菜单。唯一的线索在 worker 日志里，而日志不是产品界面。
FIX: 在 WorkerCapabilityInventory 上加一个诊断通道（每条带 source: 'skills'|'subagents'|'mcp'、code、path、message），nativeWorkerRuntime.capabilities() 把三个目录的 diagnostics 汇总进去（按条数封顶并注明「还有 N 条见日志」），渲染层的 Capabilities 对话框在对应分组下用次要文字列出。注意 message 目前是英文裸串，要么结构化成 code + 参数交给渲染层查词典，要么明确接受英文（与本组 d-cross-02/03 一起决定）。
SOURCE: 接缝审查员直接核实代码（跨区域新查，无 REFUTER / WAIVER 段）。关联发现：d-cross-02 / d-cross-03 / concurrency-08 / main-aux-09。修补归属：T050。

### [d-cross-02] MEDIUM contract-gap confirmed | H/19（统一 agent 目录下发）/ P5-2-1（子代理目录） | src/main/services/agent-host/subagentCatalog.ts:114 | 子代理管理界面自己重算了一遍目录，却漏掉了 runtime 的 16 条上限；注释明写「用户编辑的这份列表就是会话会加载的那份」，超过上限时这句话不成立
DESC: Main 的 SubagentCatalogService.read() 为管理界面重新实现了一遍目录合并：两个根（<agentDir>/subagents 优先、~/.agents/subagents 兼容）、文件名排序、首个根赢得同名、最后补上未被影子覆盖的内建定义——这几条确实和 runtime 的 subagentRoots / loadSubagentCatalog 一字不差。唯一没有复制的是上限：runtime 侧 mergeSubagentDefinitions 在 MAX_SUBAGENT_DEFINITIONS = 16 处停下，把尾部丢弃并记一条 too_many 诊断；Main 侧一条都不丢。内建定义有 4 份，所以用户只要写到 13 份自有定义，界面上就会出现 17 行、而引擎只加载 16 个，被丢掉的那个（按 user 先、builtin 后的顺序，通常是最后一个内建定义）在界面上仍然显示为「已启用」。再多写几份，被丢的就轮到用户自己的定义。配合 d-cross-01（too_many 诊断没有出口），这件事在产品里完全静默。
EVIDENCE: src/main/services/agent-host/subagentCatalog.ts:106-148
  /**
   * Everything the management UI shows, in one read.
   *
   * User documents first, then the builtins they did not shadow — the same
   * precedence the runtime applies, computed the same way, so the list a user
   * edits is the list a session will load.
   */
  async read(): Promise<SubagentCatalogView> {
    ...（整个方法里没有任何 MAX_SUBAGENT_DEFINITIONS / 计数上限）

src/shared/subagentDefinition.ts:566-585
  const ordered = [
    ...definitions.filter((definition) => definition.source === 'user'),
    ...definitions.filter((definition) => definition.source === 'builtin'),
  ];
  for (const definition of ordered) {
    if (byName.has(definition.name)) continue;
    if (byName.size >= MAX_SUBAGENT_DEFINITIONS) {
      dropped.push(definition.name);
      continue;
    }

src/shared/subagentDefinition.ts:177 —— export const MAX_SUBAGENT_DEFINITIONS = 16;
src/shared/subagentBuiltins.ts:33/59/77/95 —— 内建 4 份（explorer / code-reviewer / test-runner / fixer）。
SCENARIO: 用户写了 13 份自有子代理定义。设置页列出 17 行（13 自有 + 4 内建），全部显示为可用。会话实际加载 16 个，fixer 被丢。模型问「有哪些子代理可用」时列不出 fixer，用户在设置页看到它明明开着，找不到解释。写到 17 份时，被丢的变成用户自己排在最后的那份定义。
FIX: 让管理界面停止重算：要么 SubagentCatalogService.read() 直接复用 loadSubagentCatalog + mergeSubagentDefinitions（把 Main 的 readdir/readFile 包成同一个 SubagentDocumentSource），要么至少在 read() 末尾套一次同样的上限，并在 SubagentCatalogView 里加一个「超出上限、不会被加载」的行状态，界面上灰显并说明。与 d-cross-01 一起做，让 too_many 有出口。
SOURCE: 接缝审查员直接核实代码（跨区域新查，无 REFUTER / WAIVER 段）。关联发现：d-cross-01 / main-aux-09。修补归属：T050。

### [d-cross-03] LOW contract-gap confirmed | P5-3（MCP）/ 渲染层能力面板 | src/runtime/plugins/mcp/config.ts:235 | 超过 16 台的 MCP 服务器在连接之前就被切掉，所以它们不是以「失败」出现在能力面板里，而是根本不出现
DESC: MCP 配置读取在返回前做 servers.slice(0, MAX_SERVERS)，被切掉的名字只进了一条 diagnostics。connectMcpServers 只会为切完之后的那批建立 connections，而 worker 的能力清单是 mcp.connections.map(...) 得来的——所以被切掉的服务器不会以 ok:false + error 的形态出现（那条路径是留给「起了但失败」的），它们在界面上是彻底不存在的。渲染层的 Capabilities 对话框为失败的服务器专门画了红色 Failed 徽标和错误文字，恰恰说明它对「有问题的服务器」是有表达能力的，只是这一类拿不到数据。这条与 d-cross-02 是同一个形态在 MCP 上的复现，但代码位置和修法不同，所以单列。
EVIDENCE: src/runtime/plugins/mcp/config.ts:226-235
  if (servers.length > MAX_SERVERS) {
    const dropped = servers.slice(MAX_SERVERS).map((item) => item.name);
    diagnostics.push({
      code: 'invalid_entry',
      path: '',
      message: `only the first ${MAX_SERVERS} servers declared are started; ${servers.length} were declared, so ${dropped.join(', ')} did not start`,
    });
  }
  return { servers: servers.slice(0, MAX_SERVERS), diagnostics };

src/runtime/plugins/mcp/config.ts:40 —— export const MAX_SERVERS = 16;

src/runtime/worker/nativeWorkerRuntime.ts:327
            mcpServers: mcp.connections.map((connection) => ({

src/renderer/components/workspace-shell/LeftDock.tsx:476-495 —— 逐台渲染，ok 为 false 时画 Badge variant="error" 与 server.error。
SCENARIO: 用户在 <agentDir>/mcp.json 与项目 .pi/mcp.json 里合计声明了 18 台服务器。能力面板列出 16 台、全部绿色。第 17、18 台既没有行也没有错误，用户会以为是自己 JSON 写错了位置，而实际原因是上限。
FIX: 两选一：(a) 把被切掉的服务器也放进 connections 列表，带 ok:false 与一句「超过 N 台上限，未启动」的 error；(b) 沿用 d-cross-01 的诊断通道把这条 invalid_entry 送到面板。(a) 改动更小且复用了现成的失败渲染。无论哪种，message 目前是英文裸串，需要按 d-cross-01 的同一决定处理。
SOURCE: 接缝审查员直接核实代码（跨区域新查，无 REFUTER / WAIVER 段）。关联发现：d-cross-01 / concurrency-04。修补归属：T050。

### [d-cross-04] MEDIUM contract-gap confirmed | P3-4 渲染半边 / P4-5 / F5 / F7a·F7c | src/renderer/stores/chatSessions.ts:524 | 权限卡、审批审计行、已答问答卡在 runtime 侧从来没有被写进会话文件，所以 chat-event-12 的「重开会话后全部消失」不是渲染层能单独修的
DESC: chat-event-12 在渲染层发现回放只还原 text / thinking / tool_call / tool_result 四类 block。跨到 runtime 侧看，原因比「渲染层少写了几个分支」更深：会话文件里根本没有这些数据。runtime 里会往会话文件追加 custom 条目的只有两处——agent-loop 在权限「档位」变化时写一条 PERMISSIONS_ENTRY，subagent 插件写 SUBAGENT_ENTRY（这也是为什么重开会话后子代理面板能回来）。权限插件（plugins/permissions/index.ts、activity.ts）与 ask 工具（plugins/tools/ask.ts）里一次 session 引用都没有：逐次审批的请求/结果、审批活动行、问答卡的问题与用户的回答，全部只活在事件流里，落盘的一份从来没有。而 mapHistoryBlock 上方的注释写着「用和实时 runtime 分支相同的字段用法映射」，把这件事说成了纯映射问题。这条只有把渲染层（少了分支）与 runtime 会话存储（没有数据）合起来看才成立。
EVIDENCE: src/renderer/stores/chatSessions.ts:519-524
/**
 * Maps one HistoryBlock to a ChatBlock using the same field usage as the live
 * runtime branches (tool.started / tool.completed / thinking.delta).
 */
function mapHistoryBlock(block: HistoryMessage['blocks'][number]): ChatBlock | null {

src/runtime/plugins/agent-loop/index.ts:549-553 —— 写盘的只有档位变化：
          await session.appendEntry({
            type: 'custom',
            customType: PERMISSIONS_ENTRY,
            data: { mode: permissions.mode, gear: permissions.gear },
          });

src/runtime/plugins/subagent/index.ts:507
      await session.appendEntry({ type: 'custom', customType: SUBAGENT_ENTRY, data });

对照：grep 'appendEntry|SESSION_SERVICE|session\.' src/runtime/plugins/tools/ask.ts src/runtime/plugins/permissions/index.ts src/runtime/plugins/permissions/activity.ts —— 零命中。
SCENARIO: 用户在一次回合里批准了三次写文件、回答了一个问答卡，然后关掉应用。重开会话，时间线上工具调用与结果都在，但「已批准 写入 src/foo.ts」的权限卡行、审批审计行、以及那个已回答的问答卡和答案全部不见，用户无法回溯自己当时批准了什么——而审批记录恰恰是最需要事后可查的一类内容。
FIX: 先定位置再改渲染：在 runtime 侧为审批与问答各加一类 custom 条目（customType 如 PERMISSION_DECISION_ENTRY / QUESTION_ENTRY，只存结构化字段：工具、路径/命令、决定、来源、时间戳、问答的 questionId 与所选项），在 permissions 插件的 resolve 点与 ask 工具的回答点写入；再在 piSessionTimeline 的投影里映射成 HistoryBlock，最后补 mapHistoryBlock 的分支。注意两件事：条目要计入会话字节预算（见 capacity 组），以及权限卡里可能含命令原文，要走统一脱敏（见脱敏组）。
SOURCE: 接缝审查员直接核实代码（跨区域新查，无 REFUTER / WAIVER 段）。关联发现：chat-event-12 / chat-event-01 / capacity-04 / main-aux-06。修补归属：T051。

### 节点裁决（22 条）

18 个区域各自给出的节点判定有重叠也有冲突，这里是裁决后的单一状态。verdict 取值：complete=完成；complete-with-gaps=完成但有缺口；incomplete=未完成。README 第五节是同一份裁决的压缩表。

#### P4-0 — complete-with-gaps
RATIONALE: 本轮被 5 个区域各自判过，5 个全是 complete-with-gaps，没有冲突，裁决就是 complete-with-gaps。关键是它推翻了 09-14 审计第五节的「完成 / 无缺口」——那次判定是在 src/main/services/agent-host 下一半模块和全部 13 个测试都没读的情况下下的（批评者缺口 1 明写了这件事），本轮补读之后，同一个节点上冒出来的实质缺口有：utility 载体不排空 worker stdout 而 node 载体排空（tsd-03，含 main-host-04）、Windows 上一条已跑完的命令能否回报取决于外部 taskkill 是否 2 秒内退出（windows-02）、stdio 型 MCP 在 Windows 上起不来（windows-03）、导入 worker 另起进程但不计入容量（concurrency-09）、被文档当作本节点实现的 NodeRuntimeResolver 整模块无生产调用方（main-host-06，另见已豁免的 main-aux-04/05）。要升回 complete，至少要先落地 tsd-03 与 windows-03，并在两种载体上各跑一次现行探针。
SOURCES: main-host；main-host-aux；concurrency；windows-static；tsd-utility；09-14 审计第五节（旧判定：完成 / 无缺口）

#### P4-6 — incomplete
RATIONALE: 这是本轮唯一的真冲突：field-nodes 判 complete-with-gaps（理由是十一行验收项里代码可核的部分在 HEAD 上都成立，缺口只在口径与文档），windows-static 判 incomplete（理由是 Windows 面有六条缺陷全部没有现场结论，验收表 R2/R3/R4 三行在 test12-reverify.md:583-585 就写着未执行）。我裁 incomplete，理由有三条。第一，P4-6 是整棵树上唯一的现场与打包验收节点，它的验收对象就是「上机跑过」，代码静态可核不构成这个节点的达标证据。第二，验收表里有三行从未执行，其中 R4 恰好是 windows-04 要测的那件事，节点不可能在自己的验收表缺三行的情况下算「基本完成」。第三，节点上压着本轮唯一的 high 级安全缺陷 windows-01（Git Bash 的 /c/... 写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny），而这条只能在 Windows 上验。field-nodes 发现的口径问题（field-01 把现场明确拒签的 R2/R3 写成结论、field-02 决策文档结果栏全空、field-04 已删开关还留在启动脚本里）不但不与 incomplete 冲突，反而是支持它的——现场结论被文档提前写成了「已结案」。任务树里该节点标 🟡、09-14 审计标「未评估」，本轮是首次正式判定。
SOURCES: field-nodes（complete-with-gaps）；windows-static（incomplete）；09-14 审计第五节（旧判定：未评估）

#### P3-1 — complete-with-gaps
RATIONALE: 被 concurrency（单写者并发面）与 capacity-leftovers（容量面）分头判过，两边都是 complete-with-gaps，加上 09-14 的「有缺口」，三者一致。主体成立：单写者在两进程视角下有确定性用例（T015 把 session-04/05 推到了结论），MCP 工具响应 / 子代理转录 / trace 文件与内存镜像四条主要字节来源已限额并有测试（T024、T020）。残留分两类，都不是小事：并发面三条（抢占陈旧锁时锁名短暂空缺让第三方能建锁 concurrency-01、PID 复用使陈旧锁永久判不成陈旧且界面无补救入口 concurrency-02、跨进程 trace 轮转丢代 concurrency-03）；容量面四条对账表自己列为「待落地」的至今全部敞口（附件无服务端体积上限 capacity-01、trace 工具参数全文无截断 capacity-02、压缩摘要无显式字节上限 capacity-03、会话文件缺单行最大字节安全网 capacity-04）。其中 capacity-01 的后果是会话文件顶满 32 MiB 后永久打不开，属于数据损坏级，必须先修。
SOURCES: concurrency；capacity-leftovers；09-14 审计第五节（旧判定：有缺口，已修部分）

#### P1-8 — complete-with-gaps
RATIONALE: windows-static 与 tsd-utility 各判一次，都是 complete-with-gaps，但两边说的不是同一件事，合起来才是完整判据。windows-static 的角度是证据陈旧：两载体六项探针确实在真机跑过并全绿（test12-reverify.md:547 bundled-node、:570 electron-utility），但证据钉在提交 8115ebe1，到 HEAD 已隔 158 个提交、其中 24 个动过 src/runtime/host、plugins/tools 或 bootstrap.ts；另外任务树 P1-8 行还带着一条已被 T028 推翻的陈述（RUNTIME_CONFIG_VERSION 仍冻结在 runtime_p3_complete_v1，windows-08）。tsd-utility 的角度是证据本身不够格：utility 探针不走产品路径推导宿主配置、carrier 断言是同义反复（tsd-06），加密机那一半按当前接线根本没有出厂触发路径（tsd-01）。结论是「两载体各跑过一次工具冒烟」，不构成载体兼容性证据。升 complete 的前置条件：先做 tsd-06 的探针改造，再上机重采一次并绑当前版本戳。
SOURCES: windows-static；tsd-utility；09-14 审计第五节（旧判定：完成，证据陈旧，已复核）

#### P4-5 — complete-with-gaps
RATIONALE: chat-tool-vocab（工具词汇面）与 chat-event-vocab（事件词汇面）各判一次，都是 complete-with-gaps，无冲突。09-14 的「有缺口」在本轮部分兑现：录制已扩到五类、工具动词表随 T020 补全并有专门用例（runtimeToolVocabulary.test.ts），批评者缺口 8 的主体消除。但两端各还剩实质漂移。工具面三处用户可见：命中列表只认大写 Grep / Glob，native 的每一次搜索都没有命中列表（chat-tool-01）；只带路径的审批卡从不显示被批准的那个路径（chat-tool-02）；T020 自己新写的四段 arg 文案没过 t()，中文界面半中半英（chat-tool-03）。事件面主要是无生产者的死字段与丢事件不可检测：tool.updated 全链无生产者（chat-event-04）、seq 零消费者且在 Main 丢弃事件之后才编号（chat-event-11）、三处死分支（chat-event-08/09/10）、委派花费的 usage.updated 丢 context 导致上下文徽标消失（chat-event-03）。另外录制仍缺六类事件，这是「可回归」这条工程规范在事件面上的直接缺口。
SOURCES: chat-tool-vocab；chat-event-vocab；09-14 审计第五节（旧判定：有缺口，部分已修）

#### P5-3 — complete-with-gaps
RATIONALE: 本轮只有 concurrency 一个区域判（complete-with-gaps），与 09-14 的「有缺口（十条 MCP 缺陷，已由 T018 修）」相衔接，不存在冲突，但判据的重心变了：09-14 关心的是单会话内的 MCP 正确性，本轮补的是并发与进程回收面。单会话内的连接预算、共享秒表、取消与 close 语义在 T018 之后是完整的。并发面缺两块：没有跨会话的全局 MCP 进程预算，worker 内存分档的注释也没把它算进账（concurrency-04）；worker 被强杀时 detached 的 MCP 子进程无人回收，只能指望服务器自己认 stdin EOF（concurrency-05）。再叠上我这一轮的 d-cross-03（超过 16 台的服务器在界面上彻底不出现），这个节点在「多会话同时开」这一维上还没有达标证据。resources / prompts / sampling 仍在既有豁免内，不计入。
SOURCES: concurrency；d-cross-03（接缝新增）；09-14 审计第五节（旧判定：有缺口，已修）

#### H/19 — complete-with-gaps
RATIONALE: main-host-aux 与 h-nodes 各判一次，都是 complete-with-gaps，且两份判据互相印证而不是重复。main-host-aux 从代码侧核实了下发口径是通的：PI_CODING_AGENT_DIR 在 resolveManagedPiWorkerEnv 无分支下发、resolveManagedPiPtyEnv 原样复用，GUI worker 与内嵌 TUI / 插件管理器共用同一个 agent 目录；子代理目录的两个根与优先顺序在 Main 侧（subagentCatalog.ts:90-92）与 runtime 侧（plugins/subagent/catalog.ts:85-88）完全一致——这一点我自己复核过，first-wins 规则两侧也一致。h-nodes 从验收侧确认 U1~U6 已落地并在 2026-09-10/11 真机点验通过。缺口有三条：兼容根 ~/.agents/subagents 的写侧语义不对且零测试（main-aux-09，删除被影子覆盖的定义只删影子、改名直接删掉 ~/.agents 下的原文件）；验证案例 7 依赖 H/20 完整闭环未做；2026-09-10/11 的点验先于三次架构改动，缺一次「结论仍成立」的复核。再加上我本轮新查的 d-cross-02（管理界面漏掉 16 条上限），这个节点的「界面所见即引擎所载」这句话目前不完全成立。
SOURCES: main-host-aux；h-nodes；d-cross-02（接缝新增）；09-14 审计（旧判定：未被任何区域认领）

#### H/21 — complete-with-gaps
RATIONALE: import-upstream（代码侧 C1～C6）与 h-nodes（验收侧）各判一次，都是 complete-with-gaps，互补而非冲突。代码侧确认 C1/C2/C3/C4/C6 都有实现且有用例，C3 的「未匹配仓库落为临时对话」是双端接通的，C6 的「可续聊」由离线 faux provider 回合守住。验收侧确认 P0/C1~C6 于 2026-09-11 真机点验通过，含可续聊硬验收闭环。缺口分两类：上游转换的正确性（以「<」开头的真实用户消息被当合成注入整条丢弃、整段会话可能从导入列表消失 import-up-02；一个读不动的子目录让整份 Codex 历史静默消失 import-up-01；思考块只读 summary import-up-08），以及现场覆盖（Codex 旧格式只有构造用例、内嵌 TUI 模型缺失覆盖层未点验、打包/加密机/Windows 现场未做）。另外 H/21 的现场证据文档记的还是 pi 时代的落盘路径，与 native 的扁平 sessions 目录不符（import-up-10）。注意 import-up-09（Claude summary 行被丢弃）经反驳者判 refuted，不计入。
SOURCES: import-upstream；h-nodes；09-14 审计（旧判定：未被任何区域认领）

#### F2（含 F2-a / F2-b / F2-c） — complete-with-gaps
RATIONALE: field-nodes 从现场口径判 F2 整体 complete-with-gaps，main-host-aux 从代码侧分别判 F2-a / F2-b / F2-c 三个子项 complete-with-gaps，四份判定方向一致，裁决取 complete-with-gaps。但要强调的是代码侧查出的东西比现场口径严重得多，节点状态不应该掩盖这一点：F2-b 上挂着本轮三条 high 之一——scratch 根的越界守卫用不解析 `..` 的前缀比较，adopt 能在根外创建目录、release 能递归删除根外任意目录（main-aux-01）；同一子项下还有归档在 worker 还活着时就 rm -rf 它的 cwd、与退出清理自己写下的顺序约束相反（main-aux-02）。F2-a 是改临时根设置后旧根下的 scratch 目录永不清理、且恢复时丢掉 unbound 不信任姿态（main-aux-03）。F2-c 是临时工作区归属判定用未规范化的 base 做 dirname 全等比较，设置值带尾部分隔符就让自愈静默失效（main-aux-07）。三条路径比较里有两条犯的是同一个错误（不 resolve 就比字符串），值得作为一组一起修。
SOURCES: field-nodes（F2 整体）；main-host-aux（F2-a / F2-b / F2-c 代码侧）；09-14 审计（旧判定：未被任何区域认领）

#### F5（通用问答） — complete-with-gaps
RATIONALE: field-nodes 与 chat-event-vocab 各判一次，都是 complete-with-gaps。两边指向同一条实质缺陷：问答卡只有一个全局槽位，第二个问答挤掉第一个并让那一回合永久挂起（chat-event-01，chatSessions.ts:1266）。我做了一次跨区域复核想确定这条的可达性：子代理拿不到 ask 工具（SUBAGENT_ASSIGNABLE_TOOLS 只有 Read/Glob/Grep/BrowserPreview/Bash/Edit/Write，ask 不在内），所以并发问答不会来自委派；剩下的触发路径是同一条助手消息里并列发起两次 ask，这一段要看 runtime 依赖里的工具执行是否并行，我没有在本轮读到确证，因此把「常见到什么程度」列为未验证，但「发生时回合永久挂起」这个后果本身是代码可核的。另外 field-nodes 发现看板里 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾（field-03），这是文档侧要一并回写的。
SOURCES: field-nodes；chat-event-vocab；09-14 审计（旧判定：未被任何区域认领）

#### P3-5 — complete-with-gaps
RATIONALE: 只有 session-index 一个区域判，complete-with-gaps；09-14 的旧判定是「完成（证据不足）」，本轮把证据补齐之后结论必须下调。09-14 那次是在没读 SessionIndexService.ts 本体的情况下判的完成（批评者缺口 3 明写）。补读之后查出三件不该留到现场的事：索引文件读坏与「文件不存在」走同一条分支，下一次写入就把全部会话行覆盖成空（session-index-01，high，数据损坏）；fork 未绑定会话时索引行漏写 unbound，fork 当场在界面上失败、重启后这一行被当孤儿丢掉（session-index-02）；setArchived 等三处写失败不回滚内存而 flush 写整张表，报错过的修改会被后面任何一次无关写入悄悄落盘（session-index-05）。另外 09-14 关于 NativeSessionIndexAdapter 零生产引用的观察在本轮被坐实（session-index-03），它和它的集成测试是一份不参与真实行为的平行实现。
SOURCES: session-index；09-14 审计第五节（旧判定：完成，证据不足）

#### P3-2 — complete-with-gaps
RATIONALE: 只有 agent-host-lib 一个区域判，complete-with-gaps。09-14 判「完成」时附了一句「piSessionTree.ts 未被读过」，批评者也把这块列为缺口；本轮补读之后没有查出正确性缺陷——forkable 的判据与 store.createFork 的准入是同一条规则、seq 不进树所以 T003 改 seq 口径无波及、压缩锚点条目正常进树、T034 跳坏行之后不会留孤儿。所以从 complete 降到 complete-with-gaps 不是因为查出了新 bug，而是因为两个被 runtime 直接消费的模块缺关键用例：T005 的重开半边、以及 forkable 的正例（ah-lib-06）。这是「可回归」意义上的缺口，不是「可运行」意义上的。
SOURCES: agent-host-lib；09-14 审计第五节（旧判定：完成）

#### P6-5 尾巴 / 依赖边界 — complete-with-gaps
RATIONALE: agent-host-lib 判 complete-with-gaps。P6-5 主体的死代码清扫在批次 A～C（T025、T026、T028、T036）之后确实收敛了，但尾巴上还剩三件性质不同的事。第一是用户可见的词汇漂移：恢复失败的分类表仍查 pi 时代的 WORKER_SESSION_* 词汇，native 的错误码一条都不认（ah-lib-03），意思是恢复失败时用户看到的是兜底文案而不是真实原因。第二是死模块：src/agent-host/userResourcePaths.ts 零消费者，它承载的「技能装到哪」指令在 native 提示词里没有替身（ah-lib-04）——这是一条能力缺失，不只是死代码。第三是边界本身没有规则：宿主边界守卫只扫 src/runtime，经 agent-host 模块可绕过，而 src/runtime → src/agent-host 这条反向依赖边既无守卫也无成文规则（ah-lib-05）；我复核确认这条边实际存在五处（piSessionPreflight、piSessionTimeline ×2、piSessionTree、permissionPolicy.mjs ×2），且其中之一是跨 npm 子包引用 .mjs，打包链上值得单独盯一眼。
SOURCES: agent-host-lib；09-14 审计第五节（旧判定：完成（小瑕疵），已修多项）

#### P1-7 — incomplete
RATIONALE: baseline-comparability 判 incomplete，09-14 未评估，本轮首次判定，我认同 incomplete。判据是硬的：测试执行只挂在 tag 推送与手动 dispatch 上，日常提交与 PR 完全不触发任何自动化测试（baseline-01，.github/workflows/build.yml）。这直接抵触工程规范里的「可回归」——一个能被另一个 Agent 接管开发与测试的项目，不能靠人记得手动点。配套还有 baseline-02：支撑 D9 缓存命中率公式的单测被 vitest.config.ts 排除在外，等于门禁本身有一块被关掉了。这两条是 low 级，但节点状态应当如实标 incomplete，因为它不是「有小缺口」，而是这个节点要求的那件事根本没在跑。
SOURCES: baseline-comparability；09-14 审计（旧判定：未被任何区域认领）

#### P2-5 / P2-6 — complete-with-gaps
RATIONALE: baseline-comparability 判两者都是 complete-with-gaps，09-14 未评估（批评者把它列为「D9 缓存命中率门槛的唯一达标证据」）。本轮首次判定。达标数据本身在，但复现路径已经断了一半：采集脚本产出的报告标题硬编码为旧后端、不看归档的实际 backend 字段（baseline-04，已判 waived，但它说明脚本还停留在双后端假设）；证据文档「复现」小节引用的命令指向已删除的采集器 run.mjs（baseline-03，waived）。两条都被取舍豁免，所以节点不降到 incomplete；但「可对比」这条工程规范在缓存命中率这一维上目前只剩一份归档数据，没有可重跑的路径，这一点要在节点备注里写明，别让下一个人以为随时能复采。
SOURCES: baseline-comparability；09-14 审计（旧判定：未被任何区域认领）

#### F3（GUI Git 输出丢失） — incomplete
RATIONALE: field-nodes 判 incomplete，本轮唯一一个被直接判 incomplete 的现场子项，且没有第二个区域给出不同意见。09-14 未评估。我保留这个判定：现场表上它是一条待查项，本轮既没有代码侧的定位，也没有现场结论，属于「还没开始」而不是「做了但有缺口」。它应当原样进 T032 的现场检查单，并且要注意 field-06 指出的问题——T032 声称合并了旧树的待现场项，枚举却漏掉了 field-nodes 这一片十余条，F3 很可能就在漏掉的那批里。
SOURCES: field-nodes；09-14 审计（旧判定：未被任何区域认领）

#### P0-6 — complete-with-gaps
RATIONALE: smoke-p0-6 判 complete-with-gaps，09-14 判「完成（小瑕疵）」。下调的唯一理由是证据陈旧而不是通道有问题：P0-6 的存档冒烟证据落后 HEAD 227~228 个提交，横跨一次引擎整体退役（smoke-01）。断言层与用例本身经本轮补读没查出缺陷——smoke-02（注释承诺 P1..P3 可复用断言层但 P1 探针未复用）被反驳者判 refuted，不计入。所以这个节点的修法是「重跑一次并绑版本戳」，不是改代码。
SOURCES: smoke-p0-6；09-14 审计第五节（旧判定：完成（小瑕疵），已修部分）

#### P0-2 / D1 — complete-with-gaps
RATIONALE: cordis-spike-d1 判两者都是 complete-with-gaps。09-14 对 P0-2 判「完成（小瑕疵）」，且批评者指出 P0-2 的 rationale 还在引用已被推翻的 core-host-19，本轮把这块补齐了。结论是：D1 选型时点名的三项 Cordis 能力（响应式属性 / Fork / Isolate 与热插拔）零落地，且 ARD 里没有任何落地注记说明为什么不用（spike-01）。这不改变「选 Cordis 是对的」这个决定——按记忆里的口径，选它本来就是为了复用 DSH 生态，免代码扩展已推后——但文档必须写下来，否则下一个人会以为这三项还在计划内。另外 bootstrap 的 plugin_graph_incomplete 失败兜底路径没有任何测试覆盖（spike-02），这是启动失败时唯一的兜底，值得补一条用例。
SOURCES: cordis-spike-d1；09-14 审计第五节（旧判定：P0-2 完成（小瑕疵））

#### P5-1 — complete-with-gaps
RATIONALE: concurrency 判 complete-with-gaps，09-14 判「有缺口（已修）」。本轮从并发角度复核：技能目录扫描没有跨进程写者，快照语义在插件注释里是诚实的（明说本插件不自动刷新），所以不存在数据竞争。缺的是触发端——SkillsPlugin.refresh() 全仓零生产调用方，多会话的技能菜单只能靠各自重启对齐（concurrency-08）。也就是说注释是诚实的，但产品里没有任何一处兑现它承诺的那个动作。配合 d-cross-01（技能解析失败的诊断没有出口），用户改了技能文档之后既看不到旧会话没刷新，也看不到新文档是否加载成功。
SOURCES: concurrency；09-14 审计第五节（旧判定：有缺口，已修）

#### H/20 Main 半边 / GUI A/2 代码侧 — complete-with-gaps
RATIONALE: terminal-tui 判 H/20 Main 半边与 GUI A/2 代码侧都是 complete-with-gaps、TUI-1 complete；concurrency 在 H/20 上补了一条（concurrency-07）。09-14 判 H/20「有缺口（已修）」，但那次是在 PiTuiPty.ts、PtyManager.ts、ShellDetector.ts 三个模块都没读的情况下判的（批评者缺口 20）。补读之后的缺口集中在生命周期与绑定：kill 发出即当成功、不等进程退出、不校验、失败被吞（terminal-01）；终端 id 是应用级的，TUI 模式下切换会话终端仍绑在上一个会话的 JSONL 上（terminal-03）；复活用的 open 不带 sessionFile，PTY 已不在时会静默起一个全新的 pi 会话（terminal-04）；「TUI 接管会话前不能有正在跑的回合」只由渲染层把关，Main 的 IPC 入口不复核（concurrency-07）；dispose() 不带 terminalId 会让这个窗口的控制器永久报废（terminal-10）。这几条合起来意味着 H/20 的非对称保护（GUI 写入前先杀终端再重读）在进程异常退出或 PTY 未清理时不成立。
SOURCES: terminal-tui；concurrency；09-14 审计第五节（旧判定：H/20 有缺口，已修）

#### P6-2（一次性补全换引擎）的产品消费者面 — complete-with-gaps
RATIONALE: utility-chain 判 complete-with-gaps，置信度 medium；09-14 对 P6-2 判「完成（小瑕疵）」，但那次完全没看产品消费者一侧（批评者缺口 2）。补读之后，这条通道在产品里的三个真实入口（代码评审 / 分支名 / 提交信息）各有问题，且大多是用户直接撞得到的：冷启动用 10 秒热请求预算而会话路径为同一件事配了 60 秒（utility-01，含 utility-07）；超时设置无上界，配到 600 秒以上被 RPC 载荷守卫整条判非法、报错却说「缺 id / cwd / prompt」（utility-02）；模型下拉查不到已存值时显示「自动」却不回写、请求仍带旧模型（utility-03）；超时或失败时错误块优先于内容渲染，已经流式显示几分钟的评审正文被一行错误顶掉（utility-06）。再加上 src/main/services/ai/* 与 stores/codeReview.ts 一条用例都没有（utility-08），这个面既没有测试也没有现场证据。不过它不在上机必经路径上，所以整组归 fix-after-e。
SOURCES: utility-chain；09-14 审计第五节（旧判定：P6-2 完成（小瑕疵））

#### P4-3 / P4-4 — complete-with-gaps
RATIONALE: main-host 分别判两者 complete-with-gaps，与 09-14 的「完成（小瑕疵）」/「有缺口」衔接，无跨区域冲突。RPC 宿主本体是扎实的：请求关联、per-request 超时覆盖、generation 三重闸、崩溃时 pending 全部结算、dispose 两段式与 isLostDisposeAck 兜底都有用例；09-14 的几宗悬案本轮也核清了（worker-runtime-05 的 Main 半边已修、cutover-20 仓内零残留、事件归属闸无法被 worker 伪造）。P4-3 的缺口里最值得看的是 main-host-03：Main 在 slot.dispose() 之前就关掉事件闸，把 worker 专门为排空保留的事件全部丢掉——而 worker 侧 handleDispose 的注释（piWorkerRpcServer.ts 约 :940-955）明写「disposed 在运行时拆除之后才置位，因为引擎在排空停在那里的权限门、问答和预览时还要发事件」。这是 09-14 审计说的那种缺陷形态的教科书样本：一侧实现了语义，另一侧把它丢掉，注释还在替它背书。P4-4 的两条是跨工作区斜杠命令回退（main-host-01）与关机时导入槽拆除抛错连带跳过整池拆除和 7 秒兜底强杀（main-host-02）。
SOURCES: main-host；09-14 审计第五节（旧判定：P4-3 完成（小瑕疵）、P4-4 有缺口，均已修部分）

### 修补分组（20 组）

接缝审查员把 119 条独立缺陷（115 条区域发现 + 4 条接缝发现）按「一个代理一次能改完、验收能一起写」的粒度分组。任务号由 task_map 落定：T037～T055 为新任务，最后一组并入既有的 T032（上机检查单）。batch 取值：fix-before-e=上机前必须修；fix-after-e=上机后修；docs-only=只改文档不改行为；checklist-e=只进检查单。

#### T037 · fix-before-e · high — scratch / 临时工作区：越界删除、归属判定与归档顺序
FINDINGS: main-aux-01 / main-aux-02 / main-aux-03 / main-aux-07
SCOPE: src/main/services/agent-host/ScratchWorkspaceService.ts、src/main/services/agent-host/TempWorkspaceService.ts、src/main/ipc/chat.ts 的归档分支——四条都在「某个目录到底属不属于我」和「什么时候能删」这两件事上。
ACCEPTANCE: 越界用例：adopt / release 传入 <root>/../<外部目录> 被拒且不产生任何文件系统副作用（用 path.resolve + path.relative 判定，不再用字符串前缀）；设置值带尾部分隔符时临时工作区自愈仍然生效；改临时根之后旧根下的 scratch 目录被清理且恢复出来的会话保持 unbound 不信任姿态；归档必须先确认 worker 已退出再删除它的 cwd，并有一条用例钉住这个顺序。

#### T038 · fix-before-e · high — 会话索引的读写安全网：读坏不清空、写失败要回滚、行数要有上限
FINDINGS: session-index-01 / session-index-05 / session-index-11
SCOPE: src/main/services/chat/SessionIndexService.ts 的 load / flush / 三处 setter——同一个类的读写路径，一个代理一次改完。
ACCEPTANCE: 索引文件内容损坏（非 ENOENT）时不进入「空表」状态：要么保留上一版并拒绝写，要么把坏文件改名备份后重建并在日志与界面上说明；setArchived 等写失败时内存状态回滚，后续无关写入不会把失败过的修改顺带落盘；索引行有上限与修剪策略，且每回合结束不再无条件重写整张表。三条各配一条用例，其中读坏那条必须用真实的坏 JSON 走完整路径。

#### T039 · fix-before-e · high — Windows 行为面：不可覆盖 deny 的路径形态绕过、.cmd 启动、编码与 CRLF
FINDINGS: windows-01 / windows-02 / windows-03 / windows-04 / windows-05 / windows-07 / windows-09
SCOPE: src/runtime/plugins/permissions/index.ts 的 pathPolicy、src/runtime/host/exec.ts 的 taskkill 与解码、src/runtime/plugins/mcp/index.ts 的 spawn、src/runtime/plugins/tools/index.ts 的 bash 登记与 edit、src/main/services/terminal/PtyManager.ts 的注册表读取——全部是「只在 Windows 上才成立」的一类，上机日必然同时撞上。
ACCEPTANCE: pathPolicy 在比对前把候选路径规范化为同一形态，Git Bash 的 /c/Users/... 与 \\?\C:\... 等写法都能命中 ~/.ssh/* 与 ~/.aws/credentials 的 deny，并有一组 Windows 路径形态用例；stdio 型 MCP 在 Windows 上能起 npx / uvx / npm（.cmd 走正确的 spawn 方式）；没装 Git for Windows 时 bash 工具不登记给模型，或登记时说明前置条件；edit 对 CRLF 文件失败时错误里点明行尾差异；reg query 输出按系统代码页解码；bash 子进程输出按代码页解码而不是一律 UTF-8；已跑完命令的回报不再取决于外部 taskkill 是否 2 秒内退出。

#### T040 · fix-before-e · medium — fork 生命周期闭环：绑定、提交与暂存文件回收
FINDINGS: session-index-02 / session-index-04 / session-index-09
SCOPE: src/main/services/agent-host/WorkerManager.ts 的 fork 分支与 src/runtime/worker/nativeWorkerRuntime.ts 的 fork 状态机——「fork 只实现了丢弃那一半」的三个后果。
ACCEPTANCE: fork 未绑定会话时索引行正确写入 unbound，fork 在界面上不再当场失败，重启后这一行不被当孤儿丢掉；acceptFork（提交那一半）接上生产调用方或明确删除并改写状态机注释，暂存标记不再永不清除；启动时有一次暂存 fork 文件的回收扫描，fork 窗口里崩溃不会在会话目录里留下无主 JSONL。三条各一条用例。

#### T041 · fix-before-e · medium — Main 宿主：跨工作区斜杠命令回退、关机拆除顺序与 dispose 事件闸
FINDINGS: main-host-01 / main-host-02 / main-host-03
SCOPE: src/main/services/agent-host/WorkerManager.ts 的 getSlashCommands 回退、disposeAll 与 dispose 前的事件闸——同一个类的三处生命周期/路由缺陷。
ACCEPTANCE: getSlashCommands 不再「随便找个活着的 worker」，没有本工作区的 worker 时返回空并说明，不会把另一个仓库的项目级技能与提示词交给用户，同时改掉那条已不成立的依据注释；disposeAll 里导入槽拆除抛错不再连带跳过会话池的优雅拆除与 7 秒兜底强杀（逐个 try/catch，兜底强杀始终执行）；事件闸在 slot.dispose() 之后才关，worker 排空权限门 / 问答 / 预览时发出的事件能被 Main 收到并转发——这一条要和 worker 侧 handleDispose 的顺序注释对上，并补一条端到端用例。

#### T042 · fix-before-e · medium — 凭据脱敏统一到一份规则、装在所有出口上
FINDINGS: main-aux-06 / main-aux-08
SCOPE: src/agent-host/stderrRedaction.ts 与 src/runtime/plugins/agent-loop/providerErrors.ts 两份实现的合并，以及三个出口：WorkerManager.ts:2062 进 main.log 的两路、provider 错误正文落会话文件那一路；另含 hostStderr.ts 的条数限制。（已并入 ah-lib-01、ah-lib-02）
ACCEPTANCE: 仓库里只剩一份脱敏规则，且规则强度不低于既有那份（能认出裸密钥形状与 JSON 形态的密钥）；worker stderr 无论走 IPC、main.log 还是崩溃回放都经过它；provider 错误正文写进会话文件与 trace 之前也经过它；无换行的 stderr 流同时受内存与条数限制，一次巨量输出不会把 50 行崩溃回放挤空。配一组含真实密钥形状样本的用例。

#### T043 · fix-before-e · medium — 渲染层词汇表：工具名、审批卡参数、恢复错误码与文案
FINDINGS: chat-tool-01 / chat-tool-02 / chat-tool-03 / chat-tool-04 / chat-tool-05 / chat-tool-06 / chat-tool-07 / chat-tool-09 / ah-lib-03 / chat-event-07
SCOPE: src/renderer/components/chat/ 下的 toolCard.ts、questionCardModel.ts、piToolNames.ts、subagentActivityModel.ts、turnTiming.ts、permissionActivityRow.ts、historyError.ts，以及 src/runtime/plugins/permissions/activity.ts 与 skills/index.ts 的标签——全部是「渲染层还在按旧引擎的词汇查表」这一个根因。
ACCEPTANCE: native 注册的每个工具名（小写 grep / glob / ask / skill / browser_preview / new_context、TaskWait/TaskList/TaskStop、mcp__*）在主时间线、子代理面板、Run 面板都能查到正确的动词与参数，不再出现「Ran …」或原始工具名；只带路径的审批卡显示被批准的那个路径；mcp__ 拆分在服务器名含 __ 或结尾为 _ 时给出正确标签；恢复失败的分类表认得 native 的错误码；权限活动行的 resolution / autoReason 与 T020 新写的 arg 文案、技能审批卡的 Skill 标签全部过 t()。补一条用例拿 runtime 的工具注册表去对账渲染层的每个查表点（这条测试目前完全不存在，见 chat-tool-08，归入事件协议组）。

#### T044 · fix-before-e · medium — 问答卡与等待态状态机
FINDINGS: chat-event-01 / chat-event-02
SCOPE: src/renderer/stores/chatSessions.ts 的问答槽位与 waiting_* 状态回程——两条都会让界面卡在一个假状态上。
ACCEPTANCE: 同一会话能同时挂多个问答卡（按 questionId 键控），第二个问答不再挤掉第一个、也不会让那一回合永久挂起；waiting_permission / waiting_question 在审批或回答落地后回到 running / idle，Run 面板不再从用户点「允许」起一直显示「等待审批」。两条各一条用例，含「先答第二个再答第一个」的乱序场景。

#### T045 · fix-before-e · medium — 并发多会话：写锁陈旧判定、抢占窗口与 trace 轮转
FINDINGS: concurrency-01 / concurrency-02 / concurrency-03 / concurrency-06
SCOPE: src/runtime/plugins/session/writerLock.ts、src/runtime/trace.ts、src/main/services/agent-host/subagentCatalog.ts 的定义写入——同时开多个会话时才成立的一类。（已并入 windows-06、capacity-05）
ACCEPTANCE: 抢占陈旧锁时锁名不出现空缺窗口（原子替换而不是先删后建），第三个申领者无法在窗口内建锁；陈旧判定不再只看 PID 存活，纳入 acquiredAt / 进程启动时间，PID 复用不会把一把死锁永久锁死，并给界面一个「强制接管」的补救入口；多个 worker 共享同一 traceDir 时轮转有跨进程互斥，不再双重轮转丢代、runs.jsonl 追加不交织；子代理定义文件改为原子写入（临时文件 + rename），全目录重扫的读者不会读到半截文档。至少补两条并发用例（当前 runtime 内一条都没有）。

#### T046 · fix-before-e · medium — 容量与进程对账表的余项：字节预算与进程回收
FINDINGS: capacity-01 / capacity-02 / capacity-03 / capacity-04 / concurrency-04 / concurrency-05 / concurrency-09
SCOPE: src/runtime/plugins/agent-loop/attachments.ts 与 index.ts 的 trace 落盘、plugins/context/index.ts 的压缩摘要、plugins/session/store.ts 的单行安全网、plugins/mcp/config.ts 的全局预算、host/exec.ts 的子进程回收、legacyImport/PiImportProcess.ts 的容量计账——T024 对账表里列为「待落地」的那批，一次收口。
ACCEPTANCE: 用户附件有服务端体积上限（与 Main 侧 5 MB/次 的 attachmentReadGuard 对齐并把累计量算进 32 MiB 会话预算），正常使用不再能在个位数消息内把会话文件顶到打不开；trace 的工具调用参数走和其他落盘点一样的预览截断；压缩摘要有显式字节上限；会话文件有单行最大字节安全网；MCP 服务器有跨会话的全局进程预算且写进 worker 内存分档的账；worker 被强杀时 MCP 子进程随之退出（进程组/job object），不再只指望 stdin EOF；导入 worker 计入 worker 容量。每条限额配一条越界用例。

#### T047 · fix-before-e · medium — TSD 回落链路与两种载体的行为差
FINDINGS: tsd-01 / tsd-02 / tsd-03 / tsd-04 / tsd-05 / tsd-06 / tsd-07
SCOPE: src/runtime/host/worker.ts 的回落开关、host/io.ts 的 helper 协议、plugins/tools/index.ts 的 grep、plugins/tools/read-lines.ts、src/main/services/agent-host/WorkerTransport.ts 的 utility 支路、src/runtime/smoke/p1-utility-worker.ts——加密机是主要现场，这条链路目前只有阅读没有可复现证据。（已并入 main-host-04）
ACCEPTANCE: utility 载体的 worker stdout 像 node 载体一样被排空（D11 第 5 条落实到位），并有一条用例覆盖；TSD 回落在真实平台上有出厂触发路径，而不是只在不可能命中的平台上启用；grep 的逐文件读取对单个读不了的文件容错，不再让整次搜索失败；helper 的 stdout 帧协议不再被子进程的启动噪声污染（加帧或改用独立 fd）；首 16 字节恰为 TSD 魔数的明文文件有可读出口；块大小封顶后的重读量与注释所称的「约线性」一致，或改注释说实话；utility 探针改为走产品路径推导宿主配置，carrier 断言不再同义反复。做完后上机重跑一次并把结果绑当前版本戳（这是 P1-8 升 complete 的前置）。

#### T048 · fix-before-e · medium — 终端 / TUI 行为面：进程退出确认、会话绑定与接管把关
FINDINGS: terminal-01 / terminal-03 / terminal-04 / terminal-08 / terminal-09 / terminal-10 / concurrency-07
SCOPE: src/main/services/terminal/PiTuiPty.ts、PtyManager.ts、ShellDetector.ts、src/main/ipc/piTui.ts、src/renderer/components/chat/usePresentationSwitch.ts、src/renderer/hooks/useXterm.ts——H/20 互通的另一半。
ACCEPTANCE: kill 之后等待并校验进程真的退出，失败要上报而不是吞掉；终端 id 按会话而不是按应用，TUI 模式下切会话不会仍绑在上一个会话的 JSONL 上；复活用的 open 带 sessionFile，PTY 已不在时不会静默起一个全新的 pi 会话；自定义 shell 推参不再用子串匹配（/bin/sh 不能被判成 PowerShell）；Windows 默认 shell 与 spawn 失败回退有 Windows 分支；dispose() 带 terminalId，不会让窗口的控制器永久报废；「TUI 接管前不能有正在跑的回合」在 Main 的 IPC 入口也复核一次，不只靠渲染层。

#### T049 · fix-after-e · medium — utility 通道的超时预算与 AI 三功能的产品侧表现
FINDINGS: utility-01 / utility-02 / utility-03 / utility-04 / utility-05 / utility-06 / utility-08 / utility-09 / utility-10
SCOPE: src/main/services/agent-host/PiUtilityService.ts、src/main/services/ai/{code-review,branch-name,commit-message}.ts、src/renderer/components/settings/AISettings.tsx、source-control/{CodeReviewModal,CommitBox}.tsx——一次性补全通道从设置到结果渲染的一整条。（已并入 utility-07）
ACCEPTANCE: 有一张成文的超时预算表：冷启动与热请求分开、Main 侧与 worker 侧保持严格不等式（照 /compact 的 60s>45s 做法），worker 侧那份真的能轮到；设置页的超时有上界且越界在输入处就拒绝，不再到 RPC 载荷守卫那里报成「缺 id / cwd / prompt」；模型下拉查不到已存值时回写而不是只显示「自动」；分支名过 stripCodeFence；评审弹窗在已有流式内容时错误不再顶掉正文；三个功能的错误文案过 t() 而不是直出引擎英文串；评审弹窗标题默认「自动」时不显示空括号；AI 设置页不再硬编码宿主状态为 ready、目录不可用时有说明。src/main/services/ai/* 与 stores/codeReview.ts 补上第一批用例。

#### T050 · fix-after-e · medium — 能力目录的诊断没有出口：MCP / 技能 / 子代理
FINDINGS: d-cross-01 / d-cross-02 / d-cross-03 / concurrency-08 / main-aux-09
SCOPE: src/runtime/worker/nativeWorkerRuntime.ts 的 capabilities()、src/shared/types/workerRpc.ts 的 WorkerCapabilityInventory、src/renderer/components/workspace-shell/LeftDock.tsx 的 Capabilities 对话框、src/main/services/agent-host/subagentCatalog.ts 的 read() 与写侧、src/runtime/plugins/mcp/config.ts 的上限切片——一个根因：限额与加载失败在 runtime 侧执行，在用户看得到的地方没有任何位置。
ACCEPTANCE: 能力清单带诊断通道（source / code / path / message，按条数封顶），Capabilities 对话框在对应分组下列出「为什么它不在列表里」；子代理管理界面不再自己重算目录（复用 loadSubagentCatalog + mergeSubagentDefinitions），或至少套上同一个 16 条上限并把越界行标成「不会被加载」；超过 16 台的 MCP 服务器以 ok:false + 说明出现在面板里而不是消失；SkillsPlugin.refresh() 接上生产调用方（或明确删除并改注释），多会话的技能菜单不再长期分叉；兼容根 ~/.agents/subagents 的删除与改名语义修正（不再只删影子、不再直接删掉兼容根下的原文件）并补测试。诊断 message 目前是英文裸串，这一组要顺带决定是结构化交给渲染层查词典还是接受英文。

#### T051 · fix-after-e · medium — 重开会话的回放覆盖，以及权限 / 问答从未落盘这件事
FINDINGS: chat-event-12 / d-cross-04
SCOPE: src/runtime/plugins/permissions/ 与 plugins/tools/ask.ts 的落盘（目前零 session 引用）、src/agent-host/piSessionTimeline.ts 的投影、src/renderer/stores/chatSessions.ts 的 mapHistoryBlock——必须三侧一起改，只改渲染层修不好。
ACCEPTANCE: 审批决定与问答回答以结构化 custom 条目写进会话文件（工具、路径/命令、决定、来源、时间戳、questionId 与所选项），投影层映射成 HistoryBlock，回放后权限卡行、审批审计行与已答问答卡都能还原；新条目计入会话字节预算并过统一脱敏；补一条「批准三次 + 回答一次 → 重开会话 → 四项都在」的端到端用例。若决定不做持久化，则必须改掉 mapHistoryBlock 上方那条「用和实时 runtime 分支相同的字段用法」的注释，并在界面上说明这些行不保留。

#### T052 · fix-after-e · medium — 会话导入上游：扫描容错、Codex 转换与限额对账
FINDINGS: import-up-01 / import-up-02 / import-up-03 / import-up-04 / import-up-05 / import-up-06 / import-up-07 / import-up-08
SCOPE: src/main/services/legacyImport/ 下的 CodexSessionScanner.ts、CodexRollout.ts、ClaudeSourceAdapter.ts、legacyImportSanitization.ts 与 src/shared/types/legacyImport.ts——导入内容正确性的一整片。
ACCEPTANCE: 一个读不动的子目录或超过 1 万个文件不再让整份 Codex 历史从导入列表里静默消失（部分失败要报出来）；以「<」开头的真实用户消息不再被当合成注入丢弃；导入一条会话不再重扫重解析整个 ~/.codex/sessions；上游的 64 MiB / 4000 条 / 64 KiB 口径与 32 MiB 会话预算对账，越界在入口就拒而不是走完整条链路在最后一步失败；display 条目 title 的生产侧约束与 worker 校验（非空且 ≤ 256）对齐；进模型上下文的正文也过脱敏且认得 JSON 形态的密钥；Codex 思考块的 summary / content 口径与同仓 codexItemMapper 一致、丢弃要记诊断；补一条把真实转写结果喂给 native 写入器的用例。

#### T053 · fix-after-e · low — 事件协议的无生产者字段与「丢事件不可检测」
FINDINGS: chat-event-03 / chat-event-04 / chat-event-06 / chat-event-09 / chat-event-10 / chat-event-11 / chat-tool-08
SCOPE: src/shared/types/runtimeEvents.ts 的字段清理、src/runtime/plugins/tools/index.ts 的 tool.updated、src/runtime/events/projector.ts 的 usage.updated、src/renderer/components/chat/ 下为这些字段保留的分支，以及 runtimeToolVocabulary 的对账测试。
ACCEPTANCE: 每个没有生产者的字段二选一：接上生产者，或连同渲染层的分支一起删掉，不留「注释说它还在用」的状态；子代理花费那条 usage.updated 带上 context，上下文占用徽标不再消失；seq 要么接上消费者并在丢事件时可检测（Main 丢弃发生在编号之前），要么在协议注释里明说它不承担这个职责；补一条测试拿 runtime 注册表对账渲染层的所有查表点；golden 录制补上目前缺的六类事件（tool.updated / session.failed / session.stopped / session.stderr / custom.* / preview.requested）。

#### T054 · fix-after-e · low — 退役残留清扫、宿主边界守卫与 CI 门禁
FINDINGS: main-host-05 / main-host-06 / main-host-07 / main-host-08 / chat-event-08 / ah-lib-04 / ah-lib-05 / ah-lib-06 / terminal-05 / terminal-06 / session-index-03 / session-index-06 / session-index-07 / session-index-08 / session-index-10 / baseline-01 / baseline-02 / spike-02
SCOPE: src/main/services/agent-host（tier 通道、WorkerSlotDiagnostic、replaceCrashedTransport、index.ts 桶文件）、src/renderer/components/chat/hostStatus.ts、src/agent-host/userResourcePaths.ts、src/runtime/__tests__/hostBoundary.test.ts、SessionIndexService 周边的次要接线、.github/workflows/build.yml 与 vitest.config.ts——一批「删掉或接上，并把替它背书的注释一起改掉」。
ACCEPTANCE: tier RPC 通道、五种 WorkerSlotDiagnostic、replaceCrashedTransport 状态机、agent-host 目录桶文件、host.ready / host.error 与 Node 24 指引分支、userResourcePaths.ts：逐个给出「删除」或「接上生产者」的结论并落地，注释同步；宿主边界守卫扩到覆盖 src/runtime → src/agent-host 这条边并把规则写成文；NativeSessionIndexAdapter 与它的集成测试给出去留结论；chat:createSession 不再传索引不存在的 effort 字段；重命名要么接上 worker 协议让会话文档的 name 真的被写入、要么在界面上说明只改索引；fork 走和其他会话变更一样的 TUI 交接；mergeSessionIndex 的 orphaned 接上消费者，会话因目录消失而蒸发时有提示；TUI 守卫用例的断言改成与现状一致（TUI 现在靠 --session 续接）；TUI 活动指示灯不再拿 terminalId 当会话 id 查表；日常提交与 PR 触发测试；D9 缓存命中率的单测重新纳入 vitest / CI；bootstrap 的 plugin_graph_incomplete 兜底路径补一条用例。

#### T055 · docs-only · low — 文档与现场口径回写
FINDINGS: field-01 / field-02 / field-03 / field-04 / field-05 / windows-08 / smoke-01 / import-up-10 / spike-01 / terminal-07
SCOPE: docs/plantree/plans/runtime-evolution/README.md 的看板、docs/plans/2026-09-09-bash-carrier-decision.md、Windows-P4-6-evidence/ 下的启动脚本与清单、evidence/p4-6/perm1/README.md、evidence/p0 的冒烟存档、external-agent-migration/README.md、docs/plans/2026-09-08-runtime-evolution-ard.md，以及 tuiHandoverWiring.test.ts 里那条不成立的注释——不改行为，只把文档改成实话。
ACCEPTANCE: 看板不再把现场明确拒签的 R2/R3 写成载体对照结论、也不再据此宣告放行规则结案；D1 决策文档的现场结果栏如实填写（含 R4 方法已被证明无效）；F7a/F7c 行与 F5 行的自相矛盾消除；已删除的后端开关在启动脚本与清单里的四处残留清掉（脚本不再回显假确认）；PERM-1 证据的复现命令更正，并明确 T032 复跑不得就地覆盖被标 legacy 的历史证据；P1-8 行删掉已被 T028 推翻的 RUNTIME_CONFIG_VERSION 冻结说法；P0-6 与 H/21 的证据陈旧程度如实注记（分别落后 227~228 与若干提交，且 H/21 记的还是 pi 时代落盘路径）；ARD 里 D1 三项 Cordis 能力零落地写成落地注记；「suspend 之后另一个写者不再追加」这条注释改掉。

#### T032（并入） · checklist-e · low — 把本轮现场项并进 T032 的上机检查单
FINDINGS: field-06
SCOPE: docs/plantree/plans/runtime-hardening/roadmap.md 的 T032 条目——不是代码缺陷，是检查单枚举不全。
ACCEPTANCE: T032 的现场项枚举补齐 field-nodes 区域的全部十余条（F1～F7、GUI A/2、A/4、A/10、B/5、C/8、F/13、F/15 以及 F3 这条 incomplete 子项），并把本轮 fix-before-e 各组做完后需要现场确认的点（Windows deny 绕过的修复验证、两载体重采、加密机 TSD 触发、并发多会话写锁接管）一并列进去，逐条写清「怎么算通过」。

### 弱点（10 条）

接缝审查员对「这一轮补审本身暴露出什么系统性问题」的判断，不是缺陷，是形态归纳。

1. 注释替另一侧背书，是这一轮出现频率最高的形态。最干净的样本是 dispose：worker 侧 handleDispose 用整段注释解释「disposed 必须在运行时拆除之后才置位，否则排空权限门 / 问答 / 预览时发出的事件会丢」，而 Main 在 slot.dispose() 之前就把事件闸关了（main-host-03），worker 精心保留的那批事件一条都到不了。类似的还有 Main 的子代理管理界面注释「用户编辑的这份列表就是会话会加载的那份」（实际漏了 16 条上限）、渲染层回放注释「用和实时 runtime 分支相同的字段用法」（实际数据压根没落盘）。读注释的人会以为契约成立，读代码的人要跨两个目录才看得出不成立。

2. 「限额在引擎里执行、在界面上不可见」是一个成体系的空白，不是个别遗漏。子代理 16 条、MCP 16 台、技能文档解析失败，三条链路的诊断都只进 worker 日志，而 worker 协议的能力清单里根本没有诊断字段。用户看到的永远是一个数字，看不到「为什么少了一个」。这一条只有跨 runtime / 协议 / 渲染层三侧才发现得了，18 份区域报告里没有一份触到。

3. 退役之后没有清扫的死通道数量仍然可观，而且大多带着一句「它是现行修复」的注释。tier RPC 整条通道自 D14 之后没有生产者、五种 WorkerSlotDiagnostic 零消费者、host.ready / host.error 全仓零生产者、tool.updated 无生产者、permission.activity 有五个字段自旧引擎退役后再无生产者。这些单条都是 low，但叠起来的后果是：协议面上有相当一部分内容不再代表任何真实行为，任何按协议推断行为的人都会推错。

4. 证据陈旧是跨节点的系统性问题，且各节点的陈旧程度不一。P1-8 的两载体证据落后 158 个提交（其中 24 个动过相关目录），P0-6 的冒烟存档落后 227~228 个提交并横跨一次引擎整体退役，H/21 的现场证据记的还是 pi 时代的落盘路径，P4-6 引用的 test.13 CI 停在 144 个提交之前而打包门禁其间被改过两次。这些节点在看板上都是绿的或黄的，但它们的绿是旧代码的绿。

5. 静态推断占比过高，而最需要实测的三块恰好全是静态的。18 份报告里大量条目标着「静态」，Windows、加密文件系统、Electron utility 载体这三块没有任何现行现场证据——而 D16 明写过「Linux 与 CI 的绿色不得代签」。windows-01 这条 high 级安全绕过、windows-03 的 stdio MCP 起不来、tsd-01 的回落路径无出厂触发，都只能靠上机才能给出结论。

6. 测试缺口集中在边界与并发，而不是主干。runtime 内至今没有一条真正的多会话并发用例，没有 Windows 路径形态用例，没有一条测试拿 runtime 的工具注册表去对账渲染层的查表点，src/main/services/ai/* 与 stores/codeReview.ts 一条用例都没有，而日常提交与 PR 根本不触发任何自动化测试。主干测得厚、边界测得薄，这正好和缺陷的实际分布相反。

7. 同一个低级错误在不同模块里被重复犯：路径比较不先规范化。scratch 根用不解析 `..` 的字符串前缀比较（main-aux-01，越界删除）、临时工作区用未规范化的 base 做 dirname 全等比较（main-aux-07，自愈静默失效）、权限 deny 用展开后的正则直接匹配候选路径（windows-01，Git Bash 写法绕过）。三处在三个不同区域被三个人分别发现，说明仓库里缺一个统一的「这个路径属不属于这个根」的工具函数与一条成文规则。

8. 用户可见文案的一致性差，且错在多个层次上。引擎内部英文错误串被直接当提示文案（utility-04）、枚举值直出（chat-event-07）、T020 新写的 arg 文案没过 t()（chat-tool-03）、报错文本指向错误原因（utility-02 越界报成「缺 id / cwd / prompt」）。T023 已经把 runtime 产出的中文清理过一轮并把守卫扩到 runtime / agent-host，但守卫只管中文硬编码，管不了「英文裸串直出到中文界面」这一面。

9. 节点判定仍以区域自评为主，缺一个统一的升格标准。本轮 18 个区域给出的判定里 complete-with-gaps 占压倒多数（40 余项里只有 5 项 complete、3 项 incomplete），说明这个档位正在被当成「没查出致命问题」的默认值用。P4-6 上两个区域判出不同结论（complete-with-gaps vs incomplete）就是这个模糊地带的直接后果——两边各自只看了节点的一半，而节点的定义是「现场验收」，只有一边的口径才对。

10. 少数结论仍停在推断阶段，报告里也如实标了，但下游容易忽略这个区别。tsd-01 的「无出厂触发路径」依赖对配置分支的静态阅读、chat-event-01 的并发问答可达性取决于工具调用是否并行执行（我本轮复核确认子代理拿不到 ask 工具，因此排除了委派这条路径，但并行工具调用那条没有读到确证）、windows 面多条缺陷的实际表现都要上机才能确定。排修复顺序的人应当把「机制成立、频率未验」和「已复现」分开对待。

## 二、完整性批评（CRITIC）

### 置信度：medium

批次 D 补审把 09-14 批评者点名的 21 条缺口逐条接住了：19 条的「指名文件」我在各区域报告的 files_read 清单里逐个核到（例如 src/main/services/agent-host 的 8 个模块全读、14 个测试读了 13 个、legacyImport 六模块全读、smoke/runOnce.ts 与 assertions.ts 与 cases/*.json 全读、spikes/p0-cordis-semantics.ts 读了并给 core-host-19 下了结论、SessionIndexService.ts 读了并把 session-07 重判为「维持 refuted、但事实那一半拆成 session-index-04」）。findings 本身质量可信：我抽查了本轮最重的一条 main-aux-01，ScratchWorkspaceService.isScratchPath 走 canonicalPathKey 前缀比较，而 normalizePath 只把反斜杠换成斜杠、不解析 `..`，所以「根外目录能通过守卫」是可静态复算的确定事实，不是猜测。给 medium 而不是 high，理由有四条。第一，整轮零执行：129 条发现全部是静态推断，合并去重后仍有 60 余条未经验证声明，其中三条 high（scratch 根越界、Windows 的 /c/... 绕过 ~/.ssh deny、索引读坏当空文件覆盖）都没有一次真机复现。第二，本轮自己复刻了 T027 刚关掉的两个元问题：P4-6 被 field-nodes 判 complete-with-gaps、被 windows-static 判 incomplete，无人裁决；而 windows-08 指出 T027 在 1b7c55fd 写下的 P1-8 行说 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1，同一天更晚的 a11ccbe0（T028）已解冻成 runtime_p6_hardening_v1，回写当天就失效了。第三，覆盖仍是按「点名文件」而不是按「面」收的：渲染层 chat 目录 100 个生产模块只做了工具词汇表与事件词汇表两张表的比对，src/renderer/stores 41 个文件只有 chatSessions.ts 被整读，src/main 的 vault/session/files/search/remote/updater 与 scripts/packaging-budget.mjs 一次都没被任何区域提到。第四，检查单实际是 150 项（不是约 130），其中 35 项自己标了 dev-box，另有十余项标成 real-model 但其实用合成 transcript 在开发机就能出图，这批不该占用上机日。

### 覆盖缺口对账（09-14 批评者的 21 条，全文）

status 取值：covered=本轮点名文件已读、结论已给；partial=补了一部分，面上仍有空白；closed-by-fix=缺口本身已被批次 A～C 的修补关掉，本轮只做复核。

#### 缺口 1 — P4-0 / P4-3 / P4-4 Main 进程侧载体与 RPC 宿主（covered）
main-host 与 main-host-aux 两个区域合起来读完了缺口点名的全部 8 个模块（NodeRuntimeResolver / PiUtilityService / ScratchWorkspaceService / TempWorkspaceService / hostStderr / piCliLayout / workerSessionKey / index.ts），__tests__ 目录 14 个测试文件读了 13 个（只有 workerSessionKey.test.ts 没进任一清单）。缺口要求核实的四条 Main 侧事实都有结论：worker-runtime-05/06 判「Main 半边已修（T016）」、cutover-20 判「已修（T025），sessionKeysMatch 仓内只剩一行历史注释」、rpc-projector-08 的事件归属闸判「结实、无法伪造」。新出 17 条发现（main-host-01～08、main-aux-01～09）。

#### 缺口 2 — P6-2 一次性补全换引擎的产品消费者（covered）
utility-chain 读了 PiUtilityService.ts 全文与它的测试，以及缺口点名的 ai/code-review.ts、ai/branch-name.ts、ai/commit-message.ts，再往下游读到 CodeReviewModal / CommitBox / AISettings / stores/codeReview。缺口要求追踪的 model/effort/timeoutMs 三参数取值都追到了（utility-01 冷启动用 10 秒热请求预算、utility-02 超时无上界撞 RPC 载荷守卫、utility-03 模型下拉查不到已存值仍带旧模型）。但全部是静态：冷启动真要多久、托管模式 + 钥匙串锁定下读 models.json/auth.json 的回落，都只有代码阅读。

#### 缺口 3 — P3-5 SessionIndexService 接线（covered）
session-index 读了 SessionIndexService.ts 本体与 __tests__，并对 session-07 明确重判：维持 refuted（worker.fork.discard 在 Main 侧只有 discardForkFile 一个调用方，三个调用点全在索引提交前或被 !indexCommitted 挡住，store.removeFork 还要核对文件 header 的 id 与 parentSessionId），但把「acceptFork 无人调用、暂存标记永不清」这半拆成 session-index-04。同时确认 NativeSessionIndexAdapter 至今零生产引用（session-index-03），并指出 area-assessments.md:69 仍把 session-07 当 P3-5 的直接后果陈述、需要回写。

#### 缺口 4 — P5-4 会话导入的上游一半（covered）
import-upstream 的 files_read 里六个模块一个不落（ClaudeSessionScanner / ClaudeSourceAdapter / CodexSessionScanner / CodexSourceAdapter / CodexRollout / legacyImportSanitization），并按缺口要求把 CodexImportIntegration.test.ts 的本批 diff（git show fe246bd6）与退役前的 piLegacyImport.ts 一起读了做形状比对。10 条发现，其中 import-up-09 被反驳者判 refuted。脱敏、rollout 转换、扫描器容错三面都有结论。

#### 缺口 5 — P3-2 / H/20 会话树与互通（agent-host 四模块 + 依赖方向）（covered）
agent-host-lib 读了点名的 piSessionTree.ts / stderrRedaction.ts / piWorkerErrors.ts / userResourcePaths.ts 以及它们的测试，并且真的按缺口要求评估了 src/runtime 反向依赖 src/agent-host 这条边（ah-lib-05：hostBoundary.test.ts 只扫 src/runtime，经 agent-host 模块可绕过，这条边本身无守卫无成文规则）。缺口建议的「拿 stderrRedaction 当 core-host-03 的现成修复材料」也做了，结论是 T011 新写的那份比仓库既有的弱（ah-lib-02）。

#### 缺口 6 — P0-6 冒烟通道（covered）
smoke-p0-6 读了 runOnce.ts、assertions.ts、cases/p0-single-turn.json 与 p0-single-turn-offline.json，并对着 evidence/p0/offline-smoke-trace.jsonl 逐条比对断言名。结论是 P0-6 存档证据落后 HEAD 227~228 个提交、横跨一次引擎整体退役（smoke-01），assertions.ts 注释承诺的「P1..P3 可复用」实际没复用（smoke-02，判 refuted）。判定不再建立在未读文件上，但 lane 本身仍未跑过一次，执行证据仍为零。

#### 缺口 7 — P0-2 / D1 Cordis 选型 spike（covered）
cordis-spike-d1 读了 spikes/p0-cordis-semantics.ts 原始实验，并连带核了 cordis 的 lib/context.d.ts 与 lib/index.js。给 core-host-19 下了确定结论并升级为 spike-01：D1 承诺的三项 Cordis 能力（响应式属性 / Fork / Isolate 热插拔）零落地且无任何落地注记。该区域自报「无未经验证声明」，是 18 份里唯一一份。

#### 缺口 8 — P4-5 / P6-3 第 4 条 GUI 无回归（chat 目录）（partial）
缺口点名的五个查表点全做了：TOOL_VERBS 与 toolCard 参数映射、piToolNames、questionCardModel（chat-tool-vocab），permissionActivityRow（chat-event-vocab）。两区域共 21 条发现，坐实了缺口作者随手抽到的那类漂移（chat-tool-01：命中列表只认大写 Grep/Glob，native 每次搜索都没有命中列表）。但只覆盖了「词汇表 + 事件状态机」两个切面：chat 目录 100 个生产模块（含测试共 193 个文件）里绝大多数没被整读，布局、滚动、附件、diff 审阅、composer 等面无人看，所以「GUI 无回归」这条结论的覆盖面仍比字面窄。

#### 缺口 9 — 整棵任务树的 12 类无人认领节点（partial）
12 类里 11 类这轮有人判：P1-7 / P2-0 / P2-5 / P2-6（baseline-comparability）、P4-6 与 F1～F3 / F5～F7（field-nodes）、P5-2-0 与 H/17 / H/19 / H/21（h-nodes）。唯一仍无人认领的是 P5-2（父节点）——node_verdicts 里只有 P5-2-0、P5-2-1、P5-2-6 三个子节点，父节点本身没有任何区域出结论。另外 P4-6 虽被两个区域认领，却判出互斥结论（见 contradictions）。

#### 缺口 10 — P2-5 / P2-6 与工程规范「可对比」（closed-by-fix）
T028（a11ccbe0）已把 compare.mjs 从「强制要求 backend=legacy 归档」改成收 --baseline（任意后端）或 --legacy，并把 RUNTIME_CONFIG_VERSION 从 runtime_p3_complete_v1 解冻到 runtime_p6_hardening_v1 并写了分代规则——我读 compare.mjs 第 10～59 行确认了。baseline-comparability 这轮复核过修法并新开两条：baseline-02（支撑 D9 缓存命中率公式的 scripts/runtime-baseline/metrics.test.mjs 放在 runtime-baseline 目录下，而 vitest.config.ts 的 include 只收 scripts/__tests__/**，所以它不在任何自动化门禁里）、baseline-04（collect.mjs 报告标题硬编码旧后端，已豁免）。

#### 缺口 11 — i18n 整体缺席的角度（closed-by-fix）
T023（a28b3f93）已把权限卡改成 runtime 发 PermissionRequestAction 标识、渲染层查表再 t()，并把 noHardcodedChinese 的 ROOTS 扩到 runtime 与 agent-host。但本轮在同一维度上又抓到 5 条新的、方向相反的漏网：chat-tool-03（T020 新写的四段 arg 文案是裸英文）、chat-tool-04（技能审批卡 Skill 标签无中文词条）、chat-event-07（审批行 resolution / autoReason 直出原始枚举）、utility-04（三个 AI 功能把引擎英文错误串当提示文案）、windows-09（bash 输出按 UTF-8 硬解码，OEM 代码页变替换字符）。守卫抓的是「不该有中文」，抓不到「该中文却是英文」，这半边至今无门禁。

#### 缺口 12 — Windows 整体缺席的角度（partial）
windows-static 把静态面补齐了（41 个文件，9 条发现，含 high 级 windows-01：Git Bash 的 /c/... 盘符写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny），并按缺口的 NEXT 产出了 16 项 W1～W16 的上机检查单。NodeRuntimeResolver 的 Windows 分支也读了，结论是「读起来对，但整模块零生产调用方，上机日不要花时间测它」。但缺口的核心——「Windows 面上没有现场证据」——原封不动：本轮零次 Windows 执行，permissions-19 之外又叠了 windows-01 一条越权类缺陷，都只有静态判据。

#### 缺口 13 — Electron utility 载体整体缺席的角度（partial）
静态面补上了：tsd-utility 的 tsd-03 与 main-host-04 从两个方向坐实同一件事——createUtilityProcessWorkerTransport 不排空 worker stdout，而 child_process 支路显式 resume() 并写了原因，D11 第 5 条只落实了一半。tsd-06 也确认 p1-utility-worker.ts 探针不走产品路径推导、carrier 断言是同义反复，正是缺口指出的那个问题。但缺口要的「可重复的现行探针 + 与 HEAD 版本戳绑定」没有做，仍是检查单项 U1，且 19 项检查单标了 utility 目标环境。

#### 缺口 14 — 加密文件系统 / TSD 整体缺席的角度（partial）
tsd-utility 读了 host/io.ts、host/worker.ts、plugins/tools/read-lines.ts 并出了 7 条，其中 tsd-01 是一条缺口作者没预料到的结构性结论：TSD 回落只在不可能命中的平台上启用、在唯一有密文的平台上按设计关闭，整条链路没有出厂触发路径——也就是说「回落路径的正确性」目前在产品里根本跑不到。tools-10（O(n²) 重拉 helper）与 core-host-05（stderr 噪声）这轮没有推到结论，tsd-04 把后者换了个说法（helper stdout 是无框字节协议，一条启动噪声会悄悄改写文件内容）仍是静态。缺口建议的「用替身固化 helper 契约」没有做，真实受策略文件仍零证据。

#### 缺口 15 — 并发多会话整体缺席的角度（covered）
concurrency 区域按缺口列的五条轴逐条走了：写锁（concurrency-01 抢占陈旧锁时锁名短暂空缺、concurrency-02 pid 复用后永远判不成陈旧——把 session-04/05 从 uncertain 推到了结论）、runs.jsonl 跨进程（concurrency-03 双重轮转 + capacity-05 无跨进程互斥）、技能与子代理目录缓存（concurrency-06 截断式写入撞上全目录重扫、concurrency-08 SkillsPlugin.refresh 无生产调用方）、MCP 进程预算（concurrency-04 只有每会话上限无全局预算、concurrency-05 worker 被强杀时 MCP 子进程不随之退出）。区域自己坦承 concurrency-01 在当前产品形态下可达性没构造出来（单实例锁 + entriesByKey 挡着），按「模块契约的反例」计。

#### 缺口 16 — 长会话容量与性能整体缺席的角度（closed-by-fix）
T024（8564ba41）已产出 evidence/capacity-reconciliation-2026-09-15.md 对账表，并落了 MCP 工具响应限额（图片 1 MiB/张、2 MiB/次）、子代理转录限额、runs.jsonl 按字节轮转（8 MiB × 3 代）。capacity-leftovers 这轮把 T024 自己记的四项待落地逐条复核并补成发现：capacity-01（用户附件无任何服务端体积上限，正常使用个位数消息即可顶满 32 MiB，medium）、capacity-02（tool_execution_start 把工具参数全文写 trace，唯一不走预览截断的落盘点）、capacity-03（压缩摘要正文无显式字节上限）、capacity-04（会话文件缺单行最大字节安全网）。

#### 缺口 17 — 判定与验证结果未回写（审计自身的完整性）（closed-by-fix）
T027（1b7c55fd）已做机械回写，8 处已推翻发现追加了标注、P5-2 契约补了说明。但本轮立刻暴露出回写会腐坏：windows-08 指出 README 第 73 行的 P1-8 行（正是 T027 当天写下的那段）仍断言 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1，而同一天更晚的 T028（a11ccbe0）已解冻成 runtime_p6_hardening_v1——我 grep 源码确认现值就是 runtime_p6_hardening_v1。session-index 也指出 area-assessments.md:69 仍把 session-07 当 P3-5 的直接后果。所以机制性问题（没有让回写跟着代码走的守卫）没关。

#### 缺口 18 — 跨区域判定冲突未裁决（审计自身的完整性）（closed-by-fix）
T027 已为 09-14 那四个冲突节点（P4-3 / P4-2 / P2-1 / P5-1）与 toolCallId 串档那条事实指定裁决并回指。但本轮在没有裁决人的情况下又造出一个同型冲突：P4-6 被 field-nodes 判 complete-with-gaps、被 windows-static 判 incomplete，两份报告互不知情。说明「同一节点多区域认领时谁拍板」这条流程仍未成文。

#### 缺口 19 — P6-5 退役清扫的尾巴（与守卫注释矛盾）（closed-by-fix）
agent-host-lib 读了 workerStripOnlyCompat.test.ts 并核实：那条错误注释已经在 T028 里改掉（现在写的是「worker.ts 只通过 import('../runtime/...') 到达 runtime」，与实况一致），bundledPlugins.mjs 也不再是死数据——scripts/agent-host-build-lib.mjs、scripts/verify-packaged-app.mjs、src/main/ipc/piResources.ts、src/main/services/piModelConfig/index.ts 四处都在读它。同一轮清扫的新残留另立：ah-lib-04（userResourcePaths.ts 零消费者，T025 扫掉五个孤儿模块时不在清单上）。

#### 缺口 20 — 终端 / TUI 侧（H/20 互通的另一半）（covered）
terminal-tui 读了缺口点名的 PiTuiPty.ts、PtyManager.ts、ShellDetector.ts（files_read 在结构化返回里，44 个文件），10 条发现。缺口问的那条「进程异常退出、PTY 未清理时保护是否仍成立」有了答案：terminal-01 判 kill 发出即当成功——不等进程退出、不校验、失败被吞。另附 terminal-05，指出守卫用例 t35FinalAbsence.test.ts:108 声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 --session 续接，守卫说明已失真。

#### 缺口 21 — 打包与供应链（P0-1 / P4-6 边缘）（partial）
cutover-01 已由 T009 修掉，T028 又补了打包门禁的三类断言与口径 A 守卫改认子路径 import、workerStripOnlyCompat 覆盖 16→99 文件。缺口的两半这轮各补了一点：h-nodes 读了 src/runtime/node_modules 下 pi-agent-core 与 pi-ai 的 package.json version 字段对 pin（实装版本核对那半），cordis-spike-d1 与 agent-host-lib 读了 electron-builder.yml、scripts/build-agent-host.mjs、agent-host-build-lib.mjs、afterPack.mjs（grep）。但 scripts/packaging-budget.mjs 在 18 份报告里零命中，打包产物本身（worker.js 里到底进了哪些文件）从未被任何区域验证过——agent-host-lib 自己把「esbuild 在 outfile + 无 splitting 下会内联字面量动态 import」列为未经验证声明。

### 仍未覆盖（9 条）

这几块本轮没有任何区域整读过，结论为「不知道」而不是「没问题」。

#### R1 — 渲染层 chat 目录的非词汇面（100 个生产模块，含测试共 193 个文件）
WHY: 本轮两个 chat 区域只做了工具词汇表与事件词汇表/状态机两张表的比对，够用来回答「查表点会不会失效」，不够回答「GUI 有没有回归」。布局与滚动、附件上传、diff/审阅栏（F6）、composer 的 spawnPermissions 与草稿、SessionTreeDialog 之外的会话树交互、MessageTimeline 的虚拟化，都没有任何区域整读过；而 P6-3 第 4 条与 P4-5 的验收对象正是这一面。
NEXT: 按「用户动作」而不是「查表点」切一轮：选发送一条消息、审批一次工具、切会话、fork、看 diff 五条主路径，每条把渲染层从入口组件到 store 到 IPC 的模块整读一遍，重点补 composer / MessageTimeline / 审阅栏三块。

#### R2 — src/renderer/stores 作为一个整体（41 个生产文件）
WHY: 只有 chatSessions.ts 被 chat-event-vocab 整读，codeReview.ts / worktreeActivity.ts / chatSessionActions.ts / settings 系列是被别的区域顺带读到的片段。store 是渲染层唯一的状态权威，本轮已经在这里抓到两条 medium（chat-event-01 问答卡只有一个全局槽位、chat-event-02 waiting_permission 没有回程），说明这层的缺陷密度不低，但没人系统看过。
NEXT: 以 chatSessions.ts 的状态机为轴做一轮 store 专项：列出所有会写会话态的 action 与所有订阅方，核对多会话/多窗口下的隔离性，顺带把 session-index-10（orphaned 返回值零消费者）这类「产出了没人用」的字段清一遍。

#### R3 — src/main/ipc/chat.ts 的整体契约
WHY: 这个文件被 main-host（spawn / 权限 / 斜杠命令 / reload 段）、main-host-aux（create / ensureScratch / register / resume / close / archive 段）、session-index（全文，但只从索引与 fork 视角）三个区域分段读过，还从中抓出 main-aux-02、session-index-06/07/08 四条发现。三份都是「为了别的问题顺带读」，没人对它作为 Main 与渲染层之间会话协议的完整性负责。
NEXT: 把 chat.ts 的每个 handler 与 src/preload/index.ts 的 chat API、src/shared/types/ipc.ts 的类型三方对齐，检查参数校验、错误码、以及哪些 handler 缺少与 worker 生命周期的联动（rename 就是现成例子：索引改了、worker 协议里根本没有这个操作）。

#### R4 — 凭据与鉴权链：src/main/services/auth（CredentialVault / spawnGate / managedCredentialsStartup / AuthStateService）
WHY: 18 份报告里只有 agent-host-lib 提到 auth/redact.ts 一个文件。但本轮两条 medium security（ah-lib-01 provider 错误正文落盘不脱敏、ah-lib-02 新脱敏规则认不出裸密钥）的威胁模型前提就是「凭据会出现在错误正文里」，而凭据从哪来、怎么下发给 worker、锁定时回落读什么，全在这个没人看过的目录里；utility-chain 也把「托管模式 + 钥匙串锁定下读 models.json/auth.json」列成未验证声明。
NEXT: 读完 auth 目录，画出一张「key 从 vault 到 worker 到 provider 请求」的下发图，标出每一跳上 key 可能进入日志/trace/会话文件的位置，与 ah-lib-01/02 的修法合并处理。

#### R5 — preload / IPC 契约本身
WHY: src/preload 只有 index.ts 与 types.ts 两个文件，是渲染层能触达主进程的全部入口，安全边界意义上最关键；本轮只有 main-host 读了其中的 chat API 段。capacity-01 的结论「渲染层是唯一防线」直接依赖「Main 侧没有二次校验」，而这条恰恰要在 preload/IPC 这一层确认，区域自己也把它列为未经验证声明。
NEXT: 把 preload 暴露的每个通道与对应的 ipcMain handler 配对，逐条检查有无参数校验与体积上限；先验 capacity-01（绕开 Composer 直接发 CHAT_SEND 带超大附件，Main 是否放行）。

#### R6 — 本轮未点名的 Main 模块：services/session、services/files、services/search、services/remote、services/updater、LocalSessionManager、SharedSessionState
WHY: 我按文件名在 18 份报告里检索，这几个目录零命中（SharedSessionState 只在 concurrency 的一句存疑里被提到，且明说「未核对广播范围」）。concurrency-07 的场景之所以写不成「第二个窗口一定能触发」，原因就是 SharedSessionState 没人读。
NEXT: 先补 SharedSessionState 与 LocalSessionManager 两个（多窗口一致性的直接依赖），其余按是否与 runtime 有数据往来排序，无往来的可以明确宣布不在本次演进的验收范围，写进计划而不是默默留白。

#### R7 — 打包产物与 scripts/packaging-budget.mjs
WHY: packaging-budget.mjs 在 18 份报告里一次都没被提到，而它是随包体积与内容的门禁。更要紧的是没有任何区域看过打包后的 worker.js 到底内联了什么——agent-host-lib 自己承认「esbuild 在 outfile + 无 splitting 时会内联字面量动态 import」只是依据 esbuild 通用行为的推断。团队记忆里有过一次「打包过滤陷阱：测试全绿但整包被跳过」的教训，而这次退役恰好改变了 worker 的静态图。
NEXT: 在一台能跑构建的机器上做一次打包，把产物里的 worker.js 做一次静态图核对（谁被内联、谁没进去），与 workerStripOnlyCompat 守卫覆盖的 99 个文件对账；同时读 packaging-budget.mjs 与它的测试，确认 native-only 之后的预算口径还成立。

#### R8 — P5-2（父节点）
WHY: 09-14 缺口 9 点名的 12 类无人认领节点里，这是唯一一个本轮仍无人认领的。node_verdicts 里只有 P5-2-0、P5-2-1、P5-2-6 三个子节点有结论，父节点的整体验收状态没人回答。
NEXT: 指定一个人，按子代理这条线把 P5-2 的全部子节点结论汇总成父节点判定，再回写 docs/plantree/plans/runtime-evolution/README.md。

#### R9 — 「谁裁决跨区域冲突」与「回写如何跟着代码走」这两条流程本身
WHY: T027 关掉了 09-14 那一批具体的冲突与陈旧回写，但没有建立机制。证据是本轮当场复发：P4-6 出现新的未裁决冲突，T027 写下的 P1-8 行在同一天被 T028 的代码改动作废。批次 E 之后一定会再产生一批需要回写的结论，不解决机制就会第三次复发。
NEXT: 两条最小规则：一是派活时若同一节点被多个区域认领，事先指定裁决人；二是给会被文档引用的常量（RUNTIME_CONFIG_VERSION 是现成例子）加一条守卫测试，断言文档里写的值等于源码里的值。

### 矛盾（8 条）

本轮结论与现有文档 / 看板 / 更晚提交之间对不上的地方，方括号里是矛盾的两方。

1. 【区域之间 · 未裁决】P4-6 同一节点两个结论：field-nodes 判 complete-with-gaps，windows-static 判 incomplete。两份报告互不引用，没有裁决人。这正是 09-14 缺口 18 点名、T027 刚为四个节点关掉的同型问题，当场复发。

2. 【本轮发现 vs roadmap「已修」标注】chat-event-04 判 tool.updated 在 native 下没有任何生产者，因而 T017 补的 input 与三个渲染消费者一起失效；而 roadmap 的 T017 Done 行（84ac35e0 / 83a9d0f8）把「tool.updated 带 input」列为已修。我独立核实：projector.ts:343 只在收到 pi-agent-core 的 tool_execution_update 时才发 tool.updated，而该事件在 agent-loop.js:451-465 只有当工具的 execute 调用第四个参数 onUpdate 回调时才产生，src/runtime/plugins/tools/index.ts 里 grep onUpdate 零命中——所以 T017 那条修复在 native 下确实是空转。建议 T017 的 Done 行加注。

3. 【本轮发现 vs 同批次更晚的提交】windows-08 指出 README 第 73 行的 P1-8 行仍写 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1。这一行正是 T027（1b7c55fd）写下的「已修」产物，而同一天更晚的 T028（a11ccbe0）把它解冻成 runtime_p6_hardening_v1——我 grep 源码确认 bootstrap.ts:132 现值就是 runtime_p6_hardening_v1。回写在落笔当天就被自己这一批的另一个任务作废了。

4. 【本轮发现 vs 旧树 ✅ 与批次 C 的门禁工作】baseline-comparability 判 P1-7 为 incomplete，而旧树 README 第 72 行是 ✅（备注「历史实现门禁；不代表包后新改动测试已执行」）。这不是硬矛盾而是口径差：旧树的 ✅ 说的是「单测这件事做过」，本轮的 incomplete 说的是「今天没有任何自动化在日常提交上跑它」。我核实 .github/workflows/build.yml 的 on: 只有 push tags 'v*' 与 workflow_dispatch，确实如此。需要注意的连带后果：T009 的验收标准写的是「pnpm verify:packaged 在 CI 三平台绿」，而这条 CI 只在打 tag 或手动触发时才跑——T009 的 Done 行自己也写了「CI 三平台绿灯待推送后的打包作业确认」，等于验收条件至今未满足。

5. 【本轮发现 vs T028 的「全绿」表述】baseline-02 指出支撑 D9 缓存命中率公式的 metrics.test.mjs 不在任何自动化门禁里。我核实：vitest.config.ts 的 include 是 ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']，而该文件在 scripts/runtime-baseline/ 下，不匹配。T028 的 Done 行写「node --test 的 metrics.test.mjs 5 条全绿」——那是人工单跑一次，不是回归门禁的一部分，措辞容易被读成后者。

6. 【计划文档内部 · 本轮点出】field-06 指出 T032 的括号枚举漏掉 field-nodes 区域全部十余条现场项。我核对 roadmap 第 107 行，T032 只列了「P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因」加 PERM-1 探针与若干静态推断项，确实没有问答卡（F5 / GUI C/8）、F4 的 GUI 观感、GUI A/4、F/13、F/15。按现在的括号执行一遍，这五行会在上机日结束后仍停在 🟡。

7. 【旧树看板内部 · 本轮点出】field-01 与 field-03 指出两处自相矛盾：README 第 136 行把现场明确拒签的 R2/R3 写成载体对照结论并据此宣告放行规则结案；第 223 行的现场表 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾。

8. 【守卫注释 vs 实况 · 已反转】terminal-05 指出 t35FinalAbsence.test.ts:108 的守卫用例声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 --session 续接会话——与 09-14 缺口 19 的 workerStripOnlyCompat 注释问题同型（那条已由 T028 修正），说明「守卫注释与实况脱节」是这个仓库的系统性模式，不是孤例。

### 未经执行验证的声明（22 条）

批评者对 129 条发现去重后统一登记的「只推断、没跑过」清单。方括号里是需要什么条件才能验。

1. 【只有上机能验 · Electron utility 载体】utilityProcess 的 stdout 在无读者时到底是内存堆积还是写阻塞把 worker 卡死——main-host、utility-chain、tsd-utility 三个区域各自独立提出同一条，三份都只能确认「未排空」这个代码事实，后果分支取决于 Electron 实现。

2. 【只有上机能验 · Windows】打包 Windows 上 spawn 出的 node.exe worker 在主进程退出后是否残留（main-host-02 最坏后果的一半），以及 forceKillAllNow 里 forceKillNow() 返回 false 的槽位在 Windows 下会不会留孤儿。

3. 【只有上机能验 · Windows】taskkill /T 的子孙枚举误杀、PID 回绕速度、node-pty ConPTY 的 kill 失败形态、resolvePiCliLaunchPlan 同时写 PATH 与 Path 两个键后 ConPTY 取哪个——windows-static 与 terminal-tui 各提一半。

4. 【只有上机能验 · Windows】长路径 MAX_PATH 260、保留设备名（nul/con/COM1）、尾随点空格、8.3 短名、映射网络盘与 junction 上 walk 的 canonical 严格比较——全仓零处理零用例，无法静态定论。

5. 【只有上机能验 · 加密机】真实受策略文件的一切：.writer.lock 会不会成为 TSD 容器（若会则一次陈旧接管最坏 60 秒，正好等于 Main 的 bootstrap 预算）、~/.codex rollout 是否受策略覆盖（CodexSessionScanner 完全没有 TSD 分支）、session-index.json 所在 userData 是否落在受策略路径、加密驱动对非白名单进程写入的实际行为（拒绝/写明文/仍加密）。

6. 【只有上机能验 · 加密机】encryption-special.md 记录的「系统 Git Bash 也在白名单内」是 2026-09-09 那台机器那个驱动版本的实测，换机器/换驱动需重验；D11 的 F3 未决项当时据此判低风险。

7. 【只有上机能验 · 真实模型/真机】权限卡与审批行、Run 面板状态、上下文徽标、并发问答、回放差异这一整组用户可见后果——chat-tool-vocab 与 chat-event-vocab 两份共 13 条，全部是从纯函数返回值与组件 JSX 推的，零截图。

8. 【只有上机能验 · 真实模型】真实 provider 或网关的错误 body 里是否真会出现可用凭据（ah-lib-01/02 的威胁模型前提）；nativeUtility.cancel 在 abort 后 provider 是否仍继续消耗配额；模型是否真会把技能装到扫描不到的地方（ah-lib-04）。

9. 【只有上机能验 · 真实模型】MCP 相关三条：真实 MCP 截图服务器的图片字节分布是否贴合 1 MiB/张与 2 MiB/次的假设（T024 遗留，capacity-leftovers 确认仍未验）；真实 MCP 服务器在 worker 被杀、stdin 关闭后认不认 EOF（concurrency-05 的后果段按「不认的服务器存在」写）；reload 的 60 秒预算在真实 MCP 握手下是否够。

10. 【只有上机能验 · 托管凭据】托管模式 + 钥匙串锁定时 resolveNativeModelCatalog 返回 undefined、worker 回落读 <agentDir>/models.json + auth.json 这条路径，以及 utility 三功能是否计入同一服务端配额——都只有静态阅读。

11. 【dev-box 可验，但本轮因只读规则未做】smoke offline lane 在当前 HEAD 能否跑通、六项断言是否全 PASS（smoke-p0-6 自述只做了静态导入与类型核对）。

12. 【dev-box 可验】fork 一个 unbound 会话的完整界面表现、索引损坏后的第一次写、重启后 orphans 丢弃——session-index 自述判定链完整（按钮可见性→IPC→索引行→merge 分支）但没起 Electron。

13. 【dev-box 可验】main-aux-01 的两条投递路径（被改写的 session-index.json、cwd 含 .. 的导入会话文件）只做了代码追踪，未构造真实索引行跑通端到端；守卫本身失效那一步是可复算的确定事实（我已用 normalizePath 只替换反斜杠这一点独立复核）。

14. 【dev-box 可验】capacity-01 的「两三条消息顶满 32 MiB」是按渲染层限额与 base64 膨胀系数估算，未端到端复现；「渲染层是唯一防线」也未实际绕开 Composer 调 CHAT_SEND 验证 Main 放行。

15. 【dev-box 可验】多个 Node 进程并发 append/轮转同一 runs.jsonl 会不会写出半行、会不会双重轮转——concurrency 与 capacity-leftovers 各提一次，都无实测样本，两个真实 node 进程即可复验。

16. 【dev-box 可验】terminal-03 / terminal-04 的触发链（TUI 模式下切会话终端仍绑旧 JSONL、复活用的 open 不带 sessionFile 会静默起新会话）是读渲染层源码推出来的，没起过 Electron。

17. 【dev-box 可验】ah-lib-03 的用户可见表现（恢复失败卡片的标题 / Retry 按钮 / 继续提示）按 historyError.ts 文案表推断，未实际看过那张卡；映射落到 read_failed 这一步静态可证。

18. 【结构性存疑，已静态定性】concurrency-01 在当前产品形态下可达性没构造出来：要凑齐三个同时抢同一会话文件的进程，需绕过 WorkerManager.entriesByKey 与 app.requestSingleInstanceLock；区域按「模块契约的反例 + 未来出现第二个取锁方时立即成立」计。

19. 【结构性存疑】开发构建与打包构建是否共用同一个 userData 目录未核实——若共用，两份进程内的索引表会互相覆盖（session-index 提出）。

20. 【结构性存疑】两种载体的序列化差异：utility 是结构化克隆、node IPC 是 JSON，值为 undefined 的键在前者保留、后者消失，任何用 'key' in payload 判断的消费者会在两载体上行为不同；tsd-utility 在 workerRpc.ts 里没找到二进制/Date/Map/Set 字段，故未立发现，但这类差异未排除。

21. 【外部不可读】GitHub 仓库的分支保护规则是否要求状态检查才能合并 main——本地只能读工作流定义，读不到 Settings；baseline-01 的结论仅限「现有工作流在什么事件上触发」（我独立确认 build.yml 的 on: 只有 push tags v* 与 workflow_dispatch）。

22. 【外部不可读】pi CLI / TUI 究竟在哪些界面显示会话名（决定 session-index-07 重命名不同步的严重度）、pi --session 读会话文件时会不会显示 assistant 的 errorMessage 字段（决定 ah-lib-01 的泄漏面是否还包括 CLI）。

### 批次 E 上机必做（34 条）

按目标环境分组的版本在 [checklist-e.md](checklist-e.md) 第一节，那份带上机顺序建议；这里按原始顺序保留原文。

1. 【windows】W1/W2：P1-8 的六项工具探针在当前 HEAD 上重采两遍，bundled-node 载体与 electron-utility 载体各一遍，trace 里的 stamp 必须带新的 runtime_p6_hardening_v1 分代号，用来替换那份落后 150 个提交的 test12-reverify.md。
2. 【windows】W3（high）：验 windows-01，用 Git Bash 的 /c/Users/<user>/.ssh/id_rsa 盘符写法请求写入，确认不可覆盖的 deny 是否被绕过——这是本轮两条 high 级越权中唯一必须在 Windows 上落地的一条。
3. 【windows】W4/W5/W15：验 windows-02 与旧树 P1-0/P1-3 的命令树清理，量一条正常 bash 的 taskkill 耗时，再人为让 taskkill 缺失或变慢，看命令能否仍成功回报。
4. 【windows】W7：验 windows-03，起一个 stdio 型 MCP 服务器（npx / uvx / npm 都是 .cmd 而链路上两次 spawn 都是 shell:false），确认在 Windows 上到底能不能起来。
5. 【windows】W8/W11/W10：CRLF 工作区下 edit 的精确匹配行为（windows-05）、原生工具 OEM 代码页输出进模型上下文的样子（windows-09）、reg query 输出按 utf8 解码在中文 Windows 上是否损坏含非 ASCII 的 PATH 条目（windows-07）——三条都是字符编码，一次会话里连着做。
6. 【windows】W12/W13/W14：长路径 MAX_PATH、保留设备名与尾随点、映射网络盘或 junction 工作区下的 glob 与 grep——全仓零处理零用例，这三条是纯探索，做完至少要能回答「有没有」。
7. 【windows】W16 与随包 Node 缺失路径：删掉 resources/node-runtime/node.exe 起一次，看用户看到什么文案；顺带确认 AICLIENT_NODE24_PATH 是否仍被宣传但实际无效（main-host-aux 指出 NodeRuntimeResolver 整模块零生产调用方，不要在它身上花时间）。
8. 【windows】Windows 侧终端：默认 shell 返回 pwsh.exe 时 PtyManager 的 spawn 失败回退只有 Unix 分支（terminal-09）、以及 TUI 启动计划同时写 PATH 与 Path 两个键后 ConPTY 取哪个。
9. 【windows】强杀与孤儿：主进程退出后 node.exe worker 是否残留、worker 被强杀后它拉起的 MCP 与孙进程是否回收、索引写入被杀软或搜索索引器占用时 rename 覆盖失败的表现。
10. 【encrypted】E1/E5：先确认随包 node.exe 与系统 Git Bash 在当前这台机器、当前驱动版本上仍在白名单内——2026-09-09 那份记录是换机器就作废的前提，后面的 E2/E3/R2/R3 全都建立在它之上，必须第一项做。
11. 【encrypted】E2/E3 + R2/R3 合并执行：write 后 read 的明文往返、edit 的读-改-写不破坏加密、GUI bash 工具与随包 node 读同一受策略文件、随包 node 改名副本再读一次。encryption-special.md 自己留的两条未决项与这组是同一件事，不要跑两遍。
12. 【encrypted】写锁在加密目录下的取/读/接管：先看 .writer.lock 在盘上是不是 TSD 容器；若是，一次陈旧接管要读两次锁、最坏 60 秒，正好等于 Main 的 bootstrap 预算——这条决定 concurrency-01/02 的现场严重度。
13. 【encrypted】导入链在加密机上的闭环：Claude 导入走完整条链路，Codex 导入重点看 ~/.codex 是否受策略覆盖（CodexSessionScanner 完全没有 TSD 分支，若受覆盖会读到密文并在 JSON.parse 处失败）。
14. 【encrypted】E4/E6：一个 chmod 000 或读不了的文件是否打垮整次 grep（tsd-02）；首 16 字节恰为 TSD 魔数的明文文件在所有载体上都读不出来且无任何出口（tsd-07）——后者在加密机上更容易撞到真实样本。
15. 【encrypted】F3 根因拍板与 GUI Git 输出丢失：这是本轮唯一被判 incomplete 的现场节点（field-nodes），也是 P4-6 两个区域判定打架的一半，上机日必须给出一个确定结论。
16. 【encrypted】加密机上的 TUI-1 闸门与 H/20 真机一圈：piTuiSession 的 readSessionHead 走裸 node:fs，不经 TSD 回落，受策略时会失败或读到密文、两种情况都 fail-open 放行。
17. 【utility】U1：让 p1-utility-worker.ts 探针走产品路径推导而不是 explicit node.source，重跑并把结果与当前 HEAD 的版本戳绑定——这是 09-14 缺口 13 的收口判据，本轮没做。
18. 【utility】U2 + main-host-04 + tsd-03 三家合一：在真实 Electron utility worker 里让一次回合往 stdout 写 ≥ 1 MiB，看 worker 还能不能应答只读 RPC、Main 的 RSS 是否线性增长——三个区域独立提出同一条，只做一次。
19. 【utility】U3/U4：两种载体跑同一组报文，比对形状与退出码/信号语义；特别核对「值为 undefined 的键在 JSON 下消失、在结构化克隆下保留」这类差异有没有消费者受影响。
20. 【utility】utility 通道三个产品功能（代码评审 / 分支命名 / 提交信息）在 utility 载体上端到端各跑一次，量冷启动耗时（utility-01 说它用的是 10 秒热请求预算，而会话路径为同一件事配了 60 秒），并看超时时用户看到什么（utility-06 说已流式显示几分钟的评审正文会被一行错误顶掉）。
21. 【utility】worker stderr 在 utility 载体下的组装与 50 行上限、以及落进 main.log 的两路是否脱敏（main-aux-06 指出只有走 IPC 那一路脱敏）。
22. 【real-model】PERM-1 探针复跑（T001 之后）——注意 field-nodes 的提醒：探针选择器写死中文正则，T023 之后标签走词典，英文界面或 locale 非 zh 的机器上会匹配不到，跑之前先确认上机机器的语言设置。
23. 【real-model】权限卡倒计时走到底的超时拒绝：目前只有单测覆盖，是 P1-6 明确留下的唯一现场缺口。
24. 【real-model】F5 / GUI C/8 问答卡真机一圈，含并发问答（chat-event-01 判第二个问答会挤掉第一个并让那一回合永久挂起）——这是 T032 括号枚举漏掉、field-06 点名的那批。
25. 【real-model】smoke 的 --model 在线 lane 跑一次，确认 P0-6 判定依赖的「真实端点关闭风险」结论在当前 HEAD 仍成立，同时存档 report.outcomes 与新的 runs.jsonl。
26. 【real-model】导入会话的续聊（H/21 C6）、Codex 旧格式裸行导入（H/21 C5）、GUI 重命名后在 pi CLI 侧看到的标题（session-index-07）——三条互通类，一次导入后连着做。
27. 【real-model】ah-lib-01/02 的取证：故意触发一次 provider 错误（错 key 或错 endpoint），看错误正文有没有原样落进会话文件，以及裸密钥形状是否被脱敏漏过。
28. 【real-model】GUI F/13 真实 busy 会话下的目录行变更量数字、F4 重试在加密机的复测——两条都属旧树遗留且证据已过期 89~94 个提交。
29. 【dev-box · 不该等上机】渲染层词汇表那一组（native grep/glob 的命中列表、中文界面的工具行参数文案、技能审批卡 Skill 标签、MCP 行三处名字一致、审批后 Run 面板状态、上下文徽标在委派后是否还在、审批行的中文用词、回放后权限卡与问答卡是否还在）：这 13 项在检查单里被标成 real-model，但按团队既有的 CDP 点验配方，合成 transcript 灌进 store 就能出图，完全不需要真实回合，也不需要 Windows 或加密机。
30. 【dev-box · 不该等上机】smoke offline lane（node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline）与 cordis spike 复跑、plugin_graph_incomplete 失败路径补测试——三项检查单自己就标了 dev-box，本轮只是因为「不跑任何执行」的规则才没做，批次 E 一开始就该跑掉。
31. 【dev-box · 不该等上机】session-index 的五项（fork 一个 unbound 会话、之后重启、索引损坏后的第一次写、fork 窗口内强杀的残留文件、临时工作区删除后的会话去向）与 main-host-aux 的 POSIX 半边（归档正在跑回合的临时对话、临时根改设置后的旧根、兼容根子代理定义的删除语义）：都只需要一台能起 Electron 的 Linux 机器。
32. 【dev-box · 不该等上机】capacity 的三项（附件顶满会话文件后打不开的端到端、Main IPC 层缺失附件校验的直接验证、两个 node 进程并发轮转同一 runs.jsonl）：不需要模型、不需要平台，是纯本地复现。
33. 【dev-box · 已可结案】baseline-01 的「CI 在日常 push/PR 上不触发任何测试 job」不必再验——我读 .github/workflows/build.yml 的 on: 字段已确认只有 push tags 'v*' 与 workflow_dispatch，这项从检查单里划掉即可；剩下的只是决策：要不要给日常提交加测试 job。
34. 【dev-box · 内存约束提醒】concurrency 的「三个会话并发时的真实进程数与内存」被标成 utility 目标环境，实际关键约束是机器规格——开发机 2 核 / 3.3 GB 跑不出有意义的数字，这项要么上机日做，要么换一台内存充裕的机器，不要在开发机上得出假结论。
