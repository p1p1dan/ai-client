# Runtime 加固批次 D 补审（2026-09-15）

Role: evidence（review outcome + evidence index）。审计对象：09-14 审计批评者留下的 21 条覆盖缺口所对应的面——Main 进程侧（agent-host 宿主与辅助模块、SessionIndexService、会话导入上游、终端 / TUI）、渲染层（chat 的工具与事件两张词汇表）、任务树上没人认领的节点（P4-6、P1-7、P2-5 / P2-6、H/17、H/19、H/21、F1～F7、P0-6 冒烟、D1 spike），以及并发多会话、长会话容量、Windows、加密文件系统（TSD）、Electron utility 载体五个「整体缺席」的横切面。审计基线：HEAD `ebc82f16`（批次 C 收口之后）。修补由 [Runtime 加固与收口](../../roadmap.md) 计划的批次 D2（上机前）与批次 F（上机后）承接。

## 文件索引

| 文件 | 内容 | 读法 |
|---|---|---|
| 本文 | 总体结论、方法与可信度、3 条 high 全文摘要、medium 按修补组归并、22 条节点裁决、low 主题、未计入项、覆盖缺口对账、修补分组 | 先读这份 |
| [findings-high.md](findings-high.md) | 3 条 high 的审查员原文 + 反驳者 + 取舍核对 | 修 high 时逐条读 |
| [findings-medium.md](findings-medium.md) | 39 条 medium 原文 + 3 条 medium 接缝发现 | 按区域查 |
| [findings-low.md](findings-low.md) | 79 条 low 原文 + 1 条 low 接缝发现 | 清扫时查 |
| [findings-uncertain-refuted-waived.md](findings-uncertain-refuted-waived.md) | 待定 1、被推翻 2、文档取舍 5，含反驳理由与取舍原文 | 决定要不要补用例时查 |
| [cross-and-critic.md](cross-and-critic.md) | 接缝审查员（去重 5 组、4 条接缝发现、22 条节点裁决、20 个修补组、10 条弱点）与批评者（21 条缺口对账、9 条仍未覆盖、8 条矛盾、22 条未验证声明、34 条上机必做） | 规划修补顺序与下一轮审计时查 |
| [checklist-e.md](checklist-e.md) | 批次 E 上机检查单草案：34 条必做 + 150 项区域检查项 + 128 条测试缺口 | 排上机日程与写修补用例时查 |
| [findings.json](findings.json) | 完整结构化数据：18 个区域、129 条发现及双重验证结果、接缝、批评者、修补分组 | 机器处理 |
| `raw/` | 18 份区域原文报告与三份工作流裁决存档（`T029-verdicts.json` 等） | 要看审查员完整推理时查 |

## 一、总体结论

runtime 本体是扎实的：插件内部逻辑、单会话 RPC、事件投影主干在本轮没有被推翻。缺陷几乎全部集中在**接缝**——一侧把语义实现了，另一侧没接线，而中间那段注释还在替它背书。这正是 09-14 审计接缝审查员给出的同一种形态，只是这次出现在 runtime 与 Main / 渲染层之间，而不是 runtime 内部。

三种最典型的样本：限额与诊断在 runtime 侧执行，在 Main 与渲染层的投影里完全不可见（子代理 16 条上限、MCP 16 台上限、技能文档解析失败，用户只看到一个数字，看不到「为什么少了一个」）；渲染层能画的东西 runtime 根本没持久化（权限卡与问答卡从不写进会话文件，所以「重开会话后消失」不是渲染层能单独修的）；退役之后没清扫的死通道还带着一句「它是现行修复」的注释。

3 条 high 分别落在三处：Main 侧临时目录守卫能被 `..` 绕过并递归删除根外真实目录、会话索引读坏后被整表覆盖成空、Windows 上换一种路径拼法就能绕过不可覆盖的 deny 读走私钥。前两条是数据丢失，第三条是安全绕过。

| 统计 | 数量 |
|---|---|
| 子代理总数 | 65（18 区域审查 + 27 反驳 + 18 取舍核对 + 接缝 1 + 批评者 1） |
| 发现总数 | 129 |
| 确认（含 12 条部分取舍） | 121（109 + 12） |
| 文档明确取舍、不计入 | 5 |
| 被反驳者推翻 | 2 |
| 待定 | 1 |
| 去重 5 组后的独立缺陷 | 115 |
| 接缝审查员新查 | 4（d-cross-01～04） |
| 进修补分组的总数 | 119 |
| 确认里 high / medium / low | 3 / 39 / 79（按反驳者裁定的 `final_severity`） |
| 修补分组 | 20 组：fix-before-e 12、fix-after-e 6、docs-only 1、checklist-e 1 |

按 09-14 定下的取舍规则，文档明确豁免的 5 条已剔除，部分取舍的 12 条保留但在原文里标注。反驳者改过严重级的有 20 条（审查员原判偏重的居多：原判 4 high 59 medium，裁定后是 3 high 39 medium）。

## 二、方法与可信度

三个工作流按 T029 → T030 → T031 串行跑，各自内部并行：每个区域一个审查员逐文件通读源码、测试与相关文档，输出带 `file:line` 与代码引用的发现；每 6 条发现配一名 opus 反驳者重读代码与第三方库源码尽力推翻；每个区域配一名 sonnet 取舍核对员查文档是否明确豁免。18 个区域跑完之后，一个接缝审查员读区域之间的缝并直接回代码核实，一个批评者按 09-14 的 21 条缺口逐条对账。所有代理只读：不构建、不跑测试、不写文件。

批评者给的整体置信度是 **medium**，四条理由：

1. **整轮零执行**。129 条发现全部是静态推断，合并去重后仍有 60 余条未经验证声明，三条 high 都没有一次真机复现。121 条确认里有 54 条自己标了「静态推断」标记。
2. **本轮复刻了 T027 刚关掉的两个元问题**：P4-6 被两个区域判出不同结论且无人裁决（已由接缝审查员当场裁掉）；windows-08 指出 T027 在 `1b7c55fd` 写下的 P1-8 行，当天更晚的 `a11ccbe0`（T028）就已推翻，回写当天失效。
3. **覆盖仍是按「点名文件」而不是按「面」收的**。渲染层 chat 目录 100 个生产模块只做了两张词汇表的比对；`src/renderer/stores` 41 个文件只有 `chatSessions.ts` 被整读；`src/main` 的 vault / session / files / search / remote / updater 与 `scripts/packaging-budget.mjs` 一次都没被任何区域提到。
4. **检查单实际是 150 项**（不是各区域汇总时说的约 130），其中 35 项自标 dev-box，另有十余项标成 real-model 但用合成 transcript 在开发机就能出图——这批不该占用上机日。

18 个区域的分工、置信度与原文报告：

| 工作流 | 区域 | 面 | 自评置信度 | 读过文件 | 发现 | 原文 |
|---|---|---|---|---|---|---|
| T029 | `main-host-aux` | Main 侧宿主辅助模块（Node 解析、临时工作区、stderr、布局） | high | 43 | 9 | [raw/main-host-aux.md](raw/main-host-aux.md) |
| T029 | `main-host` | Main 侧宿主（WorkerManager 轴） | high | 36 | 8 | [raw/main-host.md](raw/main-host.md) |
| T029 | `utility-chain` | utility 通道的产品消费者（代码评审 / 分支名 / 提交信息） | medium | 47 | 10 | [raw/utility-chain.md](raw/utility-chain.md) |
| T029 | `session-index` | SessionIndexService 与 fork 生命周期 | high | 35 | 11 | [raw/session-index.md](raw/session-index.md) |
| T029 | `import-upstream` | 会话导入的上游六模块 | medium | 41 | 10 | [raw/import-upstream.md](raw/import-upstream.md) |
| T029 | `terminal-tui` | 终端 / TUI 侧（H/20 互通的另一半） | medium | 44 | 10 | [raw/terminal-tui.md](raw/terminal-tui.md) |
| T029 | `agent-host-lib` | src/agent-host 未读模块与 runtime → agent-host 依赖方向 | high | 47 | 6 | [raw/agent-host-lib.md](raw/agent-host-lib.md) |
| T029 | `chat-tool-vocab` | 渲染层工具词汇表全量比对 | medium | 55 | 9 | [raw/chat-tool-vocab.md](raw/chat-tool-vocab.md) |
| T029 | `chat-event-vocab` | 渲染层事件词汇表与状态机全量比对 | medium | 71 | 12 | [raw/chat-event-vocab.md](raw/chat-event-vocab.md) |
| T030 | `smoke-p0-6` | P0-6 冒烟通道（runOnce / assertions / cases） | high | 24 | 2 | [raw/smoke-p0-6.md](raw/smoke-p0-6.md) |
| T030 | `cordis-spike-d1` | D1 Cordis 选型 spike 与 core-host-19 | high | 42 | 2 | [raw/cordis-spike-d1.md](raw/cordis-spike-d1.md) |
| T030 | `baseline-comparability` | 可比性与单测门禁（P2-0 / P2-5 / P2-6 / P1-7） | high | 28 | 4 | [raw/baseline-comparability.md](raw/baseline-comparability.md) |
| T030 | `field-nodes` | 现场口径复核（P4-6 与 F1～F7） | high | 61 | 6 | [raw/field-nodes.md](raw/field-nodes.md) |
| T030 | `h-nodes` | H/17、H/19、H/21 与 P5-2-0 | medium | 37 | 0 | [raw/h-nodes.md](raw/h-nodes.md) |
| T031 | `concurrency` | 并发多会话静态面 | medium | 42 | 9 | [raw/concurrency.md](raw/concurrency.md) |
| T031 | `windows-static` | Windows 静态面与上机检查单 | medium | 41 | 9 | [raw/windows-static.md](raw/windows-static.md) |
| T031 | `capacity-leftovers` | 容量对账的余项 | medium | 26 | 5 | [raw/capacity-leftovers.md](raw/capacity-leftovers.md) |
| T031 | `tsd-utility` | 加密文件系统（TSD）回落与 Electron utility 载体 | medium | 40 | 7 | [raw/tsd-utility.md](raw/tsd-utility.md) |

仍然没有任何现场证据的三块：**Windows**、**加密文件系统 / TSD**、**Electron utility 载体**。这三块恰好压着最重的结论（windows-01 的安全绕过、windows-03 的 stdio MCP 起不来、tsd-01 的回落路径无出厂触发），而 ARD D16 明写过「Linux 与 CI 的绿色不得代签」。

## 三、3 条 high 级确认缺陷

### main-aux-01 — scratch 根的越界守卫用不解析 `..` 的前缀比较，adopt 能创建、release 能递归删除根外任意目录

`src/main/services/agent-host/ScratchWorkspaceService.ts:130`（节点 F2-b，类别 security，可在开发机复算，归属 **T037**）

**后果**：会话索引行或导入文件里的 `cwd` 形如 `<scratch 根>/../<某真实目录>` 时，打开会话把那个真实目录登记为会话 cwd，点归档就把它整棵 `rm -rf`。
**触发场景**：`ipc/chat.ts` 的 resume / 首发路径调 `adopt()` 放行并登记，归档时 `release()` 递归删除；两条投递路径是被改写的 `session-index.json`（模块注释自己点名的威胁模型）与会话导入时原样采用导入文件里的 `cwd`。
**修法**：改为先 `path.resolve` 再用 `path.relative` 判包含，与同目录的 `isTempWorkspacePath` 对齐；`adopt()` 补「候选不得含 `..` 段」早退；`[release-blocker]` 用例扩到三种 `..` 形态。

### session-index-01 — 索引文件读坏与「文件不存在」走同一条分支，下一次写入就把全部会话行覆盖成空

`src/main/services/chat/SessionIndexService.ts:420`（节点 P3-5，类别 robustness，静态推断，归属 **T038**）

**后果**：`session-index.json` 是「聊天 → JSONL 文件」的唯一映射，读坏之后第一次任何写入就把整表覆盖成只剩新行，此前全部会话（含已归档、含导入）从此不可达，坏文件被覆盖后连事后取证都做不了。
**触发场景**：写索引时断电（`writeJsonAtomically` 只有 writeFile + rename，无 fsync）或磁盘坏块把文件截断；重启后侧栏空白，用户随手新建会话发第一句就触发 `recordCreated` → `flush()`。现有测试把这个行为固化成了期望值。
**修法**：非 ENOENT 的读 / 解析失败时把原文件改名备份、置 `loadFailed` 让本进程拒绝写、解析后逐行校验跳过坏行；顺带给原子写加 fsync。

### windows-01 — Git Bash 的 /c/... 盘符写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny

`src/runtime/plugins/permissions/index.ts:490`（节点 P4-6，类别 security，静态推断，归属 **T039**）

**后果**：Windows 上用 Git Bash 的 MSYS 盘符写法 `/c/Users/<user>/.ssh/id_ed25519`，`~/.ssh/*` 与 `~/.aws/credentials` 这两条不可覆盖的 deny 全部匹配不上；auto 档直接放行，私钥全文进模型上下文并落进会话文件。同一个文件换成原生反斜杠写法或 `~/.ssh/...` 都会被拦住。
**触发场景**：只影响必须靠完整路径匹配的规则；`*.env`、`*.pem`、`id_rsa*` 走 basename 兜底不受影响，所以实际被放行的是 `~/.ssh/config`、`known_hosts` 以及不叫 `id_rsa` 的私钥——`id_ed25519` 是今天的默认密钥名。现场 trace 里已经能看到模型在用这种写法。
**修法**：在 `bash-analysis.ts` 的 `register()` 里、`normalizeShellPath` 之前加一次盘符记法归一（`/X/` → `X:/`，并处理 UNC），必须在 register 里做，因为工作区判定吃同一个字符串；用纯函数用例钉住转换结果，不需要 Windows 机器。

三条的共同点：两条路径比较缺陷（main-aux-01 与 windows-01）犯的是同一个低级错误——不先规范化就比字符串。接缝审查员指出仓库里缺一个统一的「这个路径属不属于这个根」的工具函数与一条成文规则，本轮在三个不同区域被三个人分别发现三次（第三次是 main-aux-07，medium）。

## 四、medium 级确认缺陷（按修补组归并）

共 42 条：39 条区域发现 + 3 条接缝发现（d-cross-01 / -02 / -04）。按 [cross-and-critic.md](cross-and-critic.md) 的修补分组归并，每组一行；组内还含 high 与 low 时只列 medium 的编号。

- **scratch / 临时工作区：越界删除、归属判定与归档顺序**（T037，fix-before-e）：main-aux-02 / main-aux-03 / main-aux-07。临时目录归档在 worker 还活着时就删它的 cwd，改临时根后旧根下的目录永不清理，归属判定遇到尾部分隔符就失效。
- **会话索引的读写安全网：读坏不清空、写失败要回滚、行数要有上限**（T038，fix-before-e）：session-index-05。索引写失败不回滚内存，之后任何一次无关写入都会把报错过的修改顺带落盘。
- **Windows 行为面：不可覆盖 deny 的路径形态绕过、.cmd 启动、编码与 CRLF**（T039，fix-before-e）：windows-02 / windows-03 / windows-07 / windows-09。Windows 面：一条跑完的命令能否回报取决于外部 taskkill、stdio 型 MCP 起不来、reg query 与 bash 输出按 UTF-8 硬解码。
- **fork 生命周期闭环：绑定、提交与暂存文件回收**（T040，fix-before-e）：session-index-02。fork 未绑定会话时索引行漏写 unbound，fork 当场在界面上失败、重启后这一行被当孤儿丢掉。
- **Main 宿主：跨工作区斜杠命令回退、关机拆除顺序与 dispose 事件闸**（T041，fix-before-e）：main-host-01 / main-host-02 / main-host-03。跨工作区拿别人的斜杠命令、关机时一处抛错连带跳过整池拆除、事件闸在 dispose 之前就关掉。
- **凭据脱敏统一到一份规则、装在所有出口上**（T042，fix-before-e）：main-aux-06。worker stderr 进 main.log 的两路是原文，仓库里两套脱敏规则既没合并也没装全。
- **渲染层词汇表：工具名、审批卡参数、恢复错误码与文案**（T043，fix-before-e）：chat-tool-01 / chat-tool-02 / ah-lib-03。命中列表只认大写 Grep / Glob，只带路径的审批卡不显示被批准的路径，恢复失败仍查 pi 时代的错误码。
- **问答卡与等待态状态机**（T044，fix-before-e）：chat-event-01 / chat-event-02。问答卡只有一个全局槽位，第二个问答挤掉第一个并让那一回合永久挂起。
- **并发多会话：写锁陈旧判定、抢占窗口与 trace 轮转**（T045，fix-before-e）：concurrency-01 / concurrency-02。抢占陈旧锁时锁名短暂空缺，PID 被复用后陈旧锁永远判不成陈旧且界面无补救入口。
- **容量与进程对账表的余项：字节预算与进程回收**（T046，fix-before-e）：capacity-01 / concurrency-05。用户附件没有服务端体积上限，会话文件顶满 32 MiB 后永久打不开；worker 强杀后 MCP 子进程无人回收。
- **TSD 回落链路与两种载体的行为差**（T047，fix-before-e）：tsd-02 / tsd-03。utility 载体不排空 worker 的 stdout 而 node 载体排空，同一件事两种载体行为不同。
- **终端 / TUI 行为面：进程退出确认、会话绑定与接管把关**（T048，fix-before-e）：terminal-01 / terminal-03 / terminal-08。kill 发出即当成功不等退出，终端 id 是应用级的，切会话后终端仍绑在上一个会话的 JSONL 上。
- **utility 通道的超时预算与 AI 三功能的产品侧表现**（T049，fix-after-e）：utility-01 / utility-02 / utility-03 / utility-06。冷启动用 10 秒热请求预算而会话路径给 60 秒，超时配到 600 秒以上报错却说「缺 id / cwd / prompt」。
- **能力目录的诊断没有出口：MCP / 技能 / 子代理**（T050，fix-after-e）：d-cross-01 / d-cross-02 / main-aux-09。子代理 16 条上限、MCP 16 台上限、技能解析失败，三条链路的诊断在协议上就没有位置，界面只显示一个数字。
- **重开会话的回放覆盖，以及权限 / 问答从未落盘这件事**（T051，fix-after-e）：chat-event-12 / d-cross-04。权限卡、审批审计行、已答问答卡从来没有被写进会话文件，「重开会话后全部消失」不是渲染层能单独修的。
- **会话导入上游：扫描容错、Codex 转换与限额对账**（T052，fix-after-e）：import-up-01 / import-up-02 / import-up-03。以「<」开头的真实用户消息被当合成注入整条丢弃，一个读不动的子目录让整份 Codex 历史静默消失。
- **事件协议的无生产者字段与「丢事件不可检测」**（T053，fix-after-e）：chat-event-03。委派花费的 usage.updated 丢 context，上下文徽标在子代理回合里消失。

另有 2 条 medium 被去重并入：`ah-lib-01`、`ah-lib-02` 并入 `main-aux-06`（T042，脱敏三个出口同一根因）。

## 五、节点判定（接缝裁决后）

18 个区域各自给了判定，其中有重叠也有冲突，下表是接缝审查员裁决后的单一状态，逐条理由与来源在 [cross-and-critic.md](cross-and-critic.md)「节点裁决」。「09-14 判定」列取自 [09-14 审计第五节](../../../runtime-evolution/evidence/runtime-audit-2026-09-14/README.md)，不在那张表里的写「未评估」。

| 节点 | 09-14 判定 | 本轮裁决 | 主要缺口与发现编号 |
|---|---|---|---|
| P4-0 | 完成 / 无缺口 | **complete-with-gaps** | utility 载体不排空 worker stdout、Windows 命令回报依赖 taskkill、stdio MCP 起不来、导入 worker 不计入容量、NodeRuntimeResolver 整模块无调用方（tsd-03、main-host-04、windows-02、windows-03、concurrency-09、main-host-06；另涉已剔除的 main-aux-04（已取舍）、main-aux-05（已取舍）） |
| P4-6 | 未评估（现场节点） | **incomplete** | 验收表 R2/R3/R4 从未执行；节点上压着唯一一条 high 级 Windows 安全绕过；文档已把现场拒签写成结论（windows-04、windows-01、field-01、field-02、field-04） |
| P3-1 | 有缺口（已修部分） | **complete-with-gaps** | 并发面三条锁与轮转缺陷；容量对账表自列「待落地」的四条至今全部敞口（concurrency-01、concurrency-02、concurrency-03、capacity-01、capacity-02、capacity-03、capacity-04） |
| P1-8 | 完成（证据陈旧，已复核） | **complete-with-gaps** | 两载体探针证据落后 158 个提交；探针本身不走产品路径、断言同义反复；加密机那一半无出厂触发路径（windows-08、tsd-06、tsd-01） |
| P4-5 | 有缺口（部分已修） | **complete-with-gaps** | 搜索命中列表永不出现、审批卡不显示被批准路径、T020 新文案没过 t()；事件面死字段与丢事件不可检测；录制仍缺六类事件（chat-tool-01、chat-tool-02、chat-tool-03、chat-event-04、chat-event-11、chat-event-08、chat-event-09、chat-event-10、chat-event-03） |
| P5-3 | 有缺口（已修） | **complete-with-gaps** | 无跨会话全局 MCP 进程预算；worker 强杀后 detached 子进程无人回收；超 16 台的服务器在界面上彻底不出现（concurrency-04、concurrency-05、d-cross-03） |
| H/19 | 未评估 | **complete-with-gaps** | 兼容根 ~/.agents/subagents 写侧语义不对且零测试；点验早于三次架构改动；管理界面漏掉 16 条上限（main-aux-09、d-cross-02） |
| H/21 | 未评估 | **complete-with-gaps** | 以「<」开头的用户消息被整条丢弃、读不动的子目录让整份 Codex 历史消失、思考块只读 summary；现场证据记的还是 pi 时代路径（import-up-02、import-up-01、import-up-08、import-up-10；另涉已剔除的 import-up-09（已推翻）） |
| F2（含 F2-a / F2-b / F2-c） | 未评估 | **complete-with-gaps** | scratch 根越界守卫（high）、归档早于 worker 退出、改临时根后旧根不清理、归属判定遇尾部分隔符失效（main-aux-01、main-aux-02、main-aux-03、main-aux-07） |
| F5（通用问答） | 未评估 | **complete-with-gaps** | 问答卡只有一个全局槽位，第二个问答挤掉第一个并让那一回合永久挂起；看板 F7a/F7c 行与 F5 行自相矛盾（chat-event-01、field-03） |
| P3-5 | 完成（证据不足） | **complete-with-gaps** | 索引读坏当空文件覆盖（high）、fork 漏写 unbound、写失败不回滚；NativeSessionIndexAdapter 是不参与真实行为的平行实现（session-index-01、session-index-02、session-index-05、session-index-03） |
| P3-2 | 完成 | **complete-with-gaps** | 无新增正确性缺陷；缺 T005 重开半边与 forkable 正例两类关键用例（ah-lib-06） |
| P6-5 尾巴 / 依赖边界 | 完成（小瑕疵，已修多项） | **complete-with-gaps** | 恢复失败分类表仍查 pi 时代词汇、userResourcePaths 死模块带走一条能力、反向依赖边无守卫也无成文规则（ah-lib-03、ah-lib-04、ah-lib-05） |
| P1-7 | 未评估 | **incomplete** | 日常提交与 PR 完全不触发任何自动化测试；支撑 D9 公式的单测被 vitest 配置排除在外（baseline-01、baseline-02） |
| P2-5 / P2-6 | 未评估 | **complete-with-gaps** | 归档数据还在，但可重跑的采集路径已断（两条均被取舍豁免，故不降级）（—；另涉已剔除的 baseline-04（已取舍）、baseline-03（已取舍）） |
| F3（GUI Git 输出丢失） | 未评估 | **incomplete** | 既无代码侧定位也无现场结论；T032 的现场项枚举可能漏掉了 field-nodes 这一片（field-06） |
| P0-6 | 完成（小瑕疵） | **complete-with-gaps** | 存档冒烟证据落后 227~228 个提交并横跨一次引擎整体退役；断言层本身无缺陷（smoke-01；另涉已剔除的 smoke-02（已推翻）） |
| P0-2 / D1 | P0-2 完成（小瑕疵）；D1 未评估 | **complete-with-gaps** | D1 点名的三项 Cordis 能力零落地且 ARD 无落地注记；bootstrap 失败兜底路径零测试（spike-01、spike-02） |
| P5-1 | 有缺口（已修） | **complete-with-gaps** | SkillsPlugin.refresh() 全仓零生产调用方；技能解析失败的诊断没有出口（concurrency-08、d-cross-01） |
| H/20 Main 半边 / GUI A/2 代码侧 | H/20 有缺口（已修）；GUI A/2 未评估 | **complete-with-gaps** | kill 发出即当成功、终端 id 应用级导致跨会话错绑、复活时静默起新会话、接管把关只在渲染层（concurrency-07、terminal-01、terminal-03、terminal-04、terminal-10） |
| P6-2（一次性补全换引擎）的产品消费者面 | 完成（小瑕疵） | **complete-with-gaps** | 三个产品入口各有超时预算 / 上界 / 模型回写 / 错误覆盖正文的问题；整面零用例零现场证据（utility-01、utility-07、utility-02、utility-03、utility-06、utility-08） |
| P4-3 / P4-4 | P4-3 完成（小瑕疵）；P4-4 有缺口 | **complete-with-gaps** | Main 在 slot.dispose() 之前关事件闸、跨工作区斜杠命令回退、关机时一处抛错连带跳过整池拆除（main-host-03、main-host-01、main-host-02） |

**P4-6 的冲突与裁决理由**：`field-nodes` 判 complete-with-gaps（十一行验收项里代码可核的部分在 HEAD 上都成立，缺口只在口径与文档），`windows-static` 判 incomplete（Windows 面六条缺陷全部没有现场结论，验收表 R2/R3/R4 三行在 `test12-reverify.md:583-585` 写着未执行）。接缝审查员裁 **incomplete**，三条理由：一、P4-6 是整棵树上唯一的现场与打包验收节点，验收对象就是「上机跑过」，代码静态可核不构成达标证据；二、验收表有三行从未执行，其中 R4 恰好是 windows-04 要测的那件事；三、节点上压着本轮唯一一条 high 级安全绕过 windows-01，只能在 Windows 上验。field-nodes 查出的口径问题（field-01 / -02 / -04）不与 incomplete 冲突，反而支持它——现场结论被文档提前写成了「已结案」。

**另一处需要注意的翻盘**：P4-0 被 5 个区域一致判 complete-with-gaps，直接推翻 09-14 的「完成 / 无缺口」——那次判定是在 `src/main/services/agent-host` 下一半模块和全部 13 个测试都没读的情况下下的。

## 六、low 级确认缺陷（79 条 + 1 条接缝，按主题）

- **死代码与无生产者字段（16 条）**：main-host-05、main-host-06、main-host-07、main-host-08、session-index-03、session-index-06、session-index-10、terminal-06、ah-lib-04、chat-tool-07、chat-event-04、chat-event-06、chat-event-08、chat-event-09、chat-event-10、concurrency-08。tier RPC 整条通道、五种 `WorkerSlotDiagnostic`、`host.ready` / `host.error`、`tool.updated`、`permission.activity` 的五个字段自旧引擎退役后再无生产者。单条都是 low，叠起来的后果是协议面上有相当一部分内容不再代表任何真实行为。
- **契约缺口（15 条）**：utility-07、session-index-04、session-index-07、import-up-04、import-up-05、terminal-10、ah-lib-05、chat-tool-05、chat-event-11、baseline-01、field-06、concurrency-07、windows-04、tsd-01、d-cross-03。多数是「声明了语义、另一侧没接线」；接缝发现 d-cross-03 是超过 16 台的 MCP 服务器在界面上根本不出现。
- **正确性小错（8 条）**：utility-05、utility-09、import-up-08、chat-tool-06、chat-tool-09、windows-05、tsd-04、tsd-07。
- **健壮性（7 条）**：main-aux-08、main-host-04、utility-10、session-index-08、session-index-09、terminal-04、windows-06。
- **测试缺口（9 条）**：utility-08、import-up-07、terminal-05、ah-lib-06、chat-tool-08、smoke-01、spike-02、baseline-02、tsd-06。测试缺口集中在边界与并发而不是主干：没有一条真正的多会话并发用例、没有 Windows 路径形态用例、没有一条测试拿 runtime 的工具注册表去对账渲染层的查表点。全量 128 条在 [checklist-e.md](checklist-e.md) 第三节。
- **容量（6 条）**：session-index-11、concurrency-04、concurrency-09、capacity-02、capacity-03、capacity-04。都是 T024 对账表自己列为「待落地」的余项。
- **文档陈旧与自相矛盾（9 条）**：import-up-10、terminal-07、spike-01、field-01、field-02、field-03、field-04、field-05、windows-08。看板把现场明确拒签的 R2/R3 写成结论、决策文档结果栏全空、F7a/F7c 行与 F5 行自相矛盾、P1-8 行的 `RUNTIME_CONFIG_VERSION` 说法当天就被推翻。整组归 T055，只改文档不改行为。
- **文案与 i18n（4 条）**：utility-04、chat-tool-03、chat-tool-04、chat-event-07。T023 的守卫只管中文硬编码，管不了「英文裸串直出到中文界面」这一面。
- **并发（3 条）**：concurrency-03、concurrency-06、capacity-05。
- **其余**：import-up-06（security）、terminal-09（windows）、tsd-05（perf）。

上列编号里 `main-host-04`、`windows-06`、`capacity-05`、`utility-07` 四条已被去重并入别的条目（见第七节），原文仍在 [findings-low.md](findings-low.md) 里保留、标题行标了并入去向，修补时跟着 keep 那条走。

## 七、未计入的项

**文档明确取舍（5 条，剔除）**：

- `main-aux-04` / `main-aux-05`：`NodeRuntimeResolver` 整模块无生产调用方、版本管理器分支路径拼错——p1-0 契约对照表明写「不采用其广泛搜索/回落作为 Windows 安装版策略」。
- `chat-event-05`：子代理审批行的归属只发不画——T004 + T005 落地记录写着「权限行的委派归属展示留 UI 批次」。
- `baseline-04`：采集脚本报告标题硬编码为旧后端——批次 C 转移项表格记「记录，不做」。
- `baseline-03`：p2-5 证据的「复现」命令指向已删除的 `run.mjs`——决策 001 写明「旧树不再更新」。

**被推翻（2 条）**：`import-up-09`（Claude 的 summary 行被丢弃——反驳者在本机真实历史里核对，59 个会话文件里 `"type":"summary"` 一条都没有，前提不成立）；`smoke-02`（注释承诺的断言层复用未兑现——注释主语是 case file 与 `expected_assertions` 块，审查员按 import 图判「复用」判错了）。

**待定（1 条）**：`terminal-02`（会话索引读失败时释放与闸门被一起跳过，GUI 直接开写）——代码形态属实，但审查员给的触发条件被被调用方挡住，反驳者既无法构造触发路径也无法排除，降为 low。

**去重（5 组，6 条并入）**：`capacity-05` → `concurrency-03`（trace 轮转跨进程无互斥，同一段非原子 rename+重建）；`windows-06` → `concurrency-02`（陈旧锁只看 PID 存活，Windows 的 PID 复用更快）；`main-host-04` → `tsd-03`（utility 支路不排空 worker stdout，同一个分支对的两侧）；`ah-lib-01` + `ah-lib-02` → `main-aux-06`（两套脱敏实现、三个出口，同一个缺口）；`utility-07` → `utility-01`（一个 `timeoutMs` 常量同时充当三件事的预算）。被并入的条目在 findings-*.md 里原文保留、标题行标 `→ 并入 <keep>`。

## 八、覆盖缺口对账

09-14 批评者留下 21 条覆盖缺口，本轮逐条对账：covered 9 条、partial 6 条、closed-by-fix 6 条。逐条说明全文在 [cross-and-critic.md](cross-and-critic.md)。

| # | 缺口 | 状态 | 说明 |
|---|---|---|---|
| 1 | P4-0 / P4-3 / P4-4 Main 进程侧载体与 RPC 宿主 | covered | main-host 与 main-host-aux 两个区域合起来读完了缺口点名的全部 8 个模块（NodeRuntimeResolver / PiUtilityService / ScratchWorkspaceService / TempWorkspaceService / hostStde… |
| 2 | P6-2 一次性补全换引擎的产品消费者 | covered | utility-chain 读了 PiUtilityService.ts 全文与它的测试，以及缺口点名的 ai/code-review.ts、ai/branch-name.ts、ai/commit-message.ts，再往下游读到 CodeReviewModal / CommitBox / A… |
| 3 | P3-5 SessionIndexService 接线 | covered | session-index 读了 SessionIndexService.ts 本体与 __tests__，并对 session-07 明确重判：维持 refuted（worker.fork.discard 在 Main 侧只有 discardForkFile 一个调用方，三个调用点全在索引提交… |
| 4 | P5-4 会话导入的上游一半 | covered | import-upstream 的 files_read 里六个模块一个不落（ClaudeSessionScanner / ClaudeSourceAdapter / CodexSessionScanner / CodexSourceAdapter / CodexRollout / legacy… |
| 5 | P3-2 / H/20 会话树与互通（agent-host 四模块 + 依赖方向） | covered | agent-host-lib 读了点名的 piSessionTree.ts / stderrRedaction.ts / piWorkerErrors.ts / userResourcePaths.ts 以及它们的测试，并且真的按缺口要求评估了 src/runtime 反向依赖 src/agen… |
| 6 | P0-6 冒烟通道 | covered | smoke-p0-6 读了 runOnce.ts、assertions.ts、cases/p0-single-turn.json 与 p0-single-turn-offline.json，并对着 evidence/p0/offline-smoke-trace.jsonl 逐条比对断言名。结论是… |
| 7 | P0-2 / D1 Cordis 选型 spike | covered | cordis-spike-d1 读了 spikes/p0-cordis-semantics.ts 原始实验，并连带核了 cordis 的 lib/context.d.ts 与 lib/index.js。给 core-host-19 下了确定结论并升级为 spike-01：D1 承诺的三项 Cor… |
| 8 | P4-5 / P6-3 第 4 条 GUI 无回归（chat 目录） | partial | 缺口点名的五个查表点全做了：TOOL_VERBS 与 toolCard 参数映射、piToolNames、questionCardModel（chat-tool-vocab），permissionActivityRow（chat-event-vocab）。两区域共 21 条发现，坐实了缺口作者随… |
| 9 | 整棵任务树的 12 类无人认领节点 | partial | 12 类里 11 类这轮有人判：P1-7 / P2-0 / P2-5 / P2-6（baseline-comparability）、P4-6 与 F1～F3 / F5～F7（field-nodes）、P5-2-0 与 H/17 / H/19 / H/21（h-nodes）。唯一仍无人认领的是 P… |
| 10 | P2-5 / P2-6 与工程规范「可对比」 | closed-by-fix | T028（a11ccbe0）已把 compare.mjs 从「强制要求 backend=legacy 归档」改成收 --baseline（任意后端）或 --legacy，并把 RUNTIME_CONFIG_VERSION 从 runtime_p3_complete_v1 解冻到 runtime_… |
| 11 | i18n 整体缺席的角度 | closed-by-fix | T023（a28b3f93）已把权限卡改成 runtime 发 PermissionRequestAction 标识、渲染层查表再 t()，并把 noHardcodedChinese 的 ROOTS 扩到 runtime 与 agent-host。但本轮在同一维度上又抓到 5 条新的、方向相反的… |
| 12 | Windows 整体缺席的角度 | partial | windows-static 把静态面补齐了（41 个文件，9 条发现，含 high 级 windows-01：Git Bash 的 /c/... 盘符写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny），并按缺口的 NEXT 产出了 16 项 W1～W1… |
| 13 | Electron utility 载体整体缺席的角度 | partial | 静态面补上了：tsd-utility 的 tsd-03 与 main-host-04 从两个方向坐实同一件事——createUtilityProcessWorkerTransport 不排空 worker stdout，而 child_process 支路显式 resume() 并写了原因，D1… |
| 14 | 加密文件系统 / TSD 整体缺席的角度 | partial | tsd-utility 读了 host/io.ts、host/worker.ts、plugins/tools/read-lines.ts 并出了 7 条，其中 tsd-01 是一条缺口作者没预料到的结构性结论：TSD 回落只在不可能命中的平台上启用、在唯一有密文的平台上按设计关闭，整条链路没有出… |
| 15 | 并发多会话整体缺席的角度 | covered | concurrency 区域按缺口列的五条轴逐条走了：写锁（concurrency-01 抢占陈旧锁时锁名短暂空缺、concurrency-02 pid 复用后永远判不成陈旧——把 session-04/05 从 uncertain 推到了结论）、runs.jsonl 跨进程（concurren… |
| 16 | 长会话容量与性能整体缺席的角度 | closed-by-fix | T024（8564ba41）已产出 evidence/capacity-reconciliation-2026-09-15.md 对账表，并落了 MCP 工具响应限额（图片 1 MiB/张、2 MiB/次）、子代理转录限额、runs.jsonl 按字节轮转（8 MiB × 3 代）。capaci… |
| 17 | 判定与验证结果未回写（审计自身的完整性） | closed-by-fix | T027（1b7c55fd）已做机械回写，8 处已推翻发现追加了标注、P5-2 契约补了说明。但本轮立刻暴露出回写会腐坏：windows-08 指出 README 第 73 行的 P1-8 行（正是 T027 当天写下的那段）仍断言 RUNTIME_CONFIG_VERSION 冻结在 runt… |
| 18 | 跨区域判定冲突未裁决（审计自身的完整性） | closed-by-fix | T027 已为 09-14 那四个冲突节点（P4-3 / P4-2 / P2-1 / P5-1）与 toolCallId 串档那条事实指定裁决并回指。但本轮在没有裁决人的情况下又造出一个同型冲突：P4-6 被 field-nodes 判 complete-with-gaps、被 windows-… |
| 19 | P6-5 退役清扫的尾巴（与守卫注释矛盾） | closed-by-fix | agent-host-lib 读了 workerStripOnlyCompat.test.ts 并核实：那条错误注释已经在 T028 里改掉（现在写的是「worker.ts 只通过 import('../runtime/...') 到达 runtime」，与实况一致），bundledPlugin… |
| 20 | 终端 / TUI 侧（H/20 互通的另一半） | covered | terminal-tui 读了缺口点名的 PiTuiPty.ts、PtyManager.ts、ShellDetector.ts（files_read 在结构化返回里，44 个文件），10 条发现。缺口问的那条「进程异常退出、PTY 未清理时保护是否仍成立」有了答案：terminal-01 判 k… |
| 21 | 打包与供应链（P0-1 / P4-6 边缘） | partial | cutover-01 已由 T009 修掉，T028 又补了打包门禁的三类断言与口径 A 守卫改认子路径 import、workerStripOnlyCompat 覆盖 16→99 文件。缺口的两半这轮各补了一点：h-nodes 读了 src/runtime/node_modules 下 pi-… |

**仍未覆盖的 9 块**（结论是「不知道」而不是「没问题」）：

1. **渲染层 chat 目录的非词汇面（100 个生产模块，含测试共 193 个文件）** — 本轮两个 chat 区域只做了工具词汇表与事件词汇表/状态机两张表的比对，够用来回答「查表点会不会失效」，不够回答「GUI 有没有回归」。下一步：按「用户动作」而不是「查表点」切一轮：选发送一条消息、审批一次工具、切会话、fork、看 diff 五条主路径，每条把渲染层从入口组件到 store 到 IPC 的模块整读一遍，重点补 composer / MessageTimeline / 审阅栏三块。
2. **src/renderer/stores 作为一个整体（41 个生产文件）** — 只有 chatSessions.ts 被 chat-event-vocab 整读，codeReview.ts / worktreeActivity.ts / chatSessionActions.ts / settings 系列是被别的区域顺带读到的片段。下一步：以 chatSessions.ts 的状态机为轴做一轮 store 专项：列出所有会写会话态的 action 与所有订阅方，核对多会话/多窗口下的隔离性，顺带把 session-index-10（orphaned 返回值零消费者）这类「产出了没人用」的字段清一遍。
3. **src/main/ipc/chat.ts 的整体契约** — 这个文件被 main-host（spawn / 权限 / 斜杠命令 / reload 段）、main-host-aux（create / ensureScratch / register / resume / close / archive 段）、session-index（全文，但只从索引与 fork 视角）三个区域分段读过，还从中抓出 main-aux-02、session-index-06/07/08 四条发现。下一步：把 chat.ts 的每个 handler 与 src/preload/index.ts 的 chat API、src/shared/types/ipc.ts 的类型三方对齐，检查参数校验、错误码、以及哪些 handler 缺少与 worker 生命周期的联动（rename 就是现成例子：索引改了、worker 协议里根本没有这个操作）。
4. **凭据与鉴权链：src/main/services/auth（CredentialVault / spawnGate / managedCredentialsStartup / AuthStateService）** — 18 份报告里只有 agent-host-lib 提到 auth/redact.ts 一个文件。下一步：读完 auth 目录，画出一张「key 从 vault 到 worker 到 provider 请求」的下发图，标出每一跳上 key 可能进入日志/trace/会话文件的位置，与 ah-lib-01/02 的修法合并处理。
5. **preload / IPC 契约本身** — src/preload 只有 index.ts 与 types.ts 两个文件，是渲染层能触达主进程的全部入口，安全边界意义上最关键；本轮只有 main-host 读了其中的 chat API 段。下一步：把 preload 暴露的每个通道与对应的 ipcMain handler 配对，逐条检查有无参数校验与体积上限；先验 capacity-01（绕开 Composer 直接发 CHAT_SEND 带超大附件，Main 是否放行）。
6. **本轮未点名的 Main 模块：services/session、services/files、services/search、services/remote、services/updater、LocalSessionManager、SharedSessionState** — 我按文件名在 18 份报告里检索，这几个目录零命中（SharedSessionState 只在 concurrency 的一句存疑里被提到，且明说「未核对广播范围」）。下一步：先补 SharedSessionState 与 LocalSessionManager 两个（多窗口一致性的直接依赖），其余按是否与 runtime 有数据往来排序，无往来的可以明确宣布不在本次演进的验收范围，写进计划而不是默默留白。
7. **打包产物与 scripts/packaging-budget.mjs** — packaging-budget.mjs 在 18 份报告里一次都没被提到，而它是随包体积与内容的门禁。下一步：在一台能跑构建的机器上做一次打包，把产物里的 worker.js 做一次静态图核对（谁被内联、谁没进去），与 workerStripOnlyCompat 守卫覆盖的 99 个文件对账；同时读 packaging-budget.mjs 与它的测试，确认 native-only 之后的预算口径还成立。
8. **P5-2（父节点）** — 09-14 缺口 9 点名的 12 类无人认领节点里，这是唯一一个本轮仍无人认领的。下一步：指定一个人，按子代理这条线把 P5-2 的全部子节点结论汇总成父节点判定，再回写 docs/plantree/plans/runtime-evolution/README.md。
9. **「谁裁决跨区域冲突」与「回写如何跟着代码走」这两条流程本身** — T027 关掉了 09-14 那一批具体的冲突与陈旧回写，但没有建立机制。下一步：两条最小规则：一是派活时若同一节点被多个区域认领，事先指定裁决人；二是给会被文档引用的常量（RUNTIME_CONFIG_VERSION 是现成例子）加一条守卫测试，断言文档里写的值等于源码里的值。

**矛盾（8 条）**：

- **区域之间 · 未裁决**：P4-6 同一节点两个结论：field-nodes 判 complete-with-gaps，windows-static 判 incomplete。两份报告互不引用，没有裁决人。这正是 09-14 缺口 18 点名、T027 刚为四个节点关掉的同型问题，当场复发。
- **本轮发现 vs roadmap「已修」标注**：chat-event-04 判 tool.updated 在 native 下没有任何生产者，因而 T017 补的 input 与三个渲染消费者一起失效；而 roadmap 的 T017 Done 行（84ac35e0 / 83a9d0f8）把「tool.updated 带 input」列为已修。我独立核实：projector.ts:…
- **本轮发现 vs 同批次更晚的提交**：windows-08 指出 README 第 73 行的 P1-8 行仍写 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1。这一行正是 T027（1b7c55fd）写下的「已修」产物，而同一天更晚的 T028（a11ccbe0）把它解冻成 runtime_p6_hardening_v…
- **本轮发现 vs 旧树 ✅ 与批次 C 的门禁工作**：baseline-comparability 判 P1-7 为 incomplete，而旧树 README 第 72 行是 ✅（备注「历史实现门禁；不代表包后新改动测试已执行」）。这不是硬矛盾而是口径差：旧树的 ✅ 说的是「单测这件事做过」，本轮的 incomplete 说的是「今天没有任何自动化在日常提交上跑它」。我核实 .gith…
- **本轮发现 vs T028 的「全绿」表述**：baseline-02 指出支撑 D9 缓存命中率公式的 metrics.test.mjs 不在任何自动化门禁里。我核实：vitest.config.ts 的 include 是 ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']，而该文件在 scr…
- **计划文档内部 · 本轮点出**：field-06 指出 T032 的括号枚举漏掉 field-nodes 区域全部十余条现场项。我核对 roadmap 第 107 行，T032 只列了「P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因」加 PERM-1 探针与若干静态推断项，确实没有问答卡（F5 / GUI C/8）、F…
- **旧树看板内部 · 本轮点出**：field-01 与 field-03 指出两处自相矛盾：README 第 136 行把现场明确拒签的 R2/R3 写成载体对照结论并据此宣告放行规则结案；第 223 行的现场表 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾。
- **守卫注释 vs 实况 · 已反转**：terminal-05 指出 t35FinalAbsence.test.ts:108 的守卫用例声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 --session 续接会话——与 09-14 缺口 19 的 workerStripOnlyCompat 注释问题同型（那条已由 T028 修正），说明「守卫注释与实况脱节…

## 九、修补分组

接缝审查员把 119 条独立缺陷分成 20 组，task_map 落定任务号：T037～T055 为新任务，最后一组并入既有的 T032（上机检查单）。完整 scope 与验收在 [cross-and-critic.md](cross-and-critic.md)「修补分组」，任务权威状态在 [roadmap.md](../../roadmap.md)。

| 任务 | 归属 | 严重级 | 发现编号 | 范围 | 验收（一句话） |
|---|---|---|---|---|---|
| T037 | fix-before-e | high | main-aux-01, main-aux-02, main-aux-03, main-aux-07 | src/main/services/agent-host/ScratchWorkspaceService.ts、src/main/services/agent-host/TempWorkspaceService.ts、src/main/ipc/chat.ts 的归档分支 | 越界用例：adopt / release 传入 <root>/../<外部目录> 被拒且不产生任何文件系统副作用（用 path.resolve + path.relative 判定，不再用字符串前缀） |
| T038 | fix-before-e | high | session-index-01, session-index-05, session-index-11 | src/main/services/chat/SessionIndexService.ts 的 load / flush / 三处 setter | 索引文件内容损坏（非 ENOENT）时不进入「空表」状态：要么保留上一版并拒绝写，要么把坏文件改名备份后重建并在日志与界面上说明 |
| T039 | fix-before-e | high | windows-01, windows-02, windows-03, windows-04, windows-05, windows-07, windows-09 | src/runtime/plugins/permissions/index.ts 的 pathPolicy、src/runtime/host/exec.ts 的 taskkill 与解码、src/runtime/plugins/mcp/index.ts 的 spawn、src/runtime/plugins/tools/index.ts 的 bash 登记与 edit、src/main/services/terminal/PtyManager.ts 的注册表读取 | pathPolicy 在比对前把候选路径规范化为同一形态，Git Bash 的 /c/Users/... 与 \\?\C:\... 等写法都能命中 ~/.ssh/* 与 ~/.aws/credentials 的 deny，并有一组 Windows 路径形态用例 |
| T040 | fix-before-e | medium | session-index-02, session-index-04, session-index-09 | src/main/services/agent-host/WorkerManager.ts 的 fork 分支与 src/runtime/worker/nativeWorkerRuntime.ts 的 fork 状态机 | fork 未绑定会话时索引行正确写入 unbound，fork 在界面上不再当场失败，重启后这一行不被当孤儿丢掉 |
| T041 | fix-before-e | medium | main-host-01, main-host-02, main-host-03 | src/main/services/agent-host/WorkerManager.ts 的 getSlashCommands 回退、disposeAll 与 dispose 前的事件闸 | getSlashCommands 不再「随便找个活着的 worker」，没有本工作区的 worker 时返回空并说明，不会把另一个仓库的项目级技能与提示词交给用户，同时改掉那条已不成立的依据注释 |
| T042 | fix-before-e | medium | main-aux-06, main-aux-08 | src/agent-host/stderrRedaction.ts 与 src/runtime/plugins/agent-loop/providerErrors.ts 两份实现的合并，以及三个出口：WorkerManager.ts:2062 进 main.log 的两路、provider 错误正文落会话文件那一路；另含 hostStderr.ts 的条数限制 | 仓库里只剩一份脱敏规则，且规则强度不低于既有那份（能认出裸密钥形状与 JSON 形态的密钥） |
| T043 | fix-before-e | medium | chat-tool-01, chat-tool-02, chat-tool-03, chat-tool-04, chat-tool-05, chat-tool-06, chat-tool-07, chat-tool-09, ah-lib-03, chat-event-07 | src/renderer/components/chat/ 下的 toolCard.ts、questionCardModel.ts、piToolNames.ts、subagentActivityModel.ts、turnTiming.ts、permissionActivityRow.ts、historyError.ts，以及 src/runtime/plugins/permissions/activity.ts 与 skills/index.ts 的标签 | native 注册的每个工具名（小写 grep / glob / ask / skill / browser_preview / new_context、TaskWait/TaskList/TaskStop、mcp__*）在主时间线、子代理面板、Run 面板都能查到正确的动词与参数，不再出现「Ran …」或原始工具名 |
| T044 | fix-before-e | medium | chat-event-01, chat-event-02 | src/renderer/stores/chatSessions.ts 的问答槽位与 waiting_* 状态回程 | 同一会话能同时挂多个问答卡（按 questionId 键控），第二个问答不再挤掉第一个、也不会让那一回合永久挂起 |
| T045 | fix-before-e | medium | concurrency-01, concurrency-02, concurrency-03, concurrency-06 | src/runtime/plugins/session/writerLock.ts、src/runtime/trace.ts、src/main/services/agent-host/subagentCatalog.ts 的定义写入 | 抢占陈旧锁时锁名不出现空缺窗口（原子替换而不是先删后建），第三个申领者无法在窗口内建锁 |
| T046 | fix-before-e | medium | capacity-01, capacity-02, capacity-03, capacity-04, concurrency-04, concurrency-05, concurrency-09 | src/runtime/plugins/agent-loop/attachments.ts 与 index.ts 的 trace 落盘、plugins/context/index.ts 的压缩摘要、plugins/session/store.ts 的单行安全网、plugins/mcp/config.ts 的全局预算、host/exec.ts 的子进程回收、legacyImport/PiImportProcess.ts 的容量计账 | 用户附件有服务端体积上限（与 Main 侧 5 MB/次 的 attachmentReadGuard 对齐并把累计量算进 32 MiB 会话预算），正常使用不再能在个位数消息内把会话文件顶到打不开 |
| T047 | fix-before-e | medium | tsd-01, tsd-02, tsd-03, tsd-04, tsd-05, tsd-06, tsd-07 | src/runtime/host/worker.ts 的回落开关、host/io.ts 的 helper 协议、plugins/tools/index.ts 的 grep、plugins/tools/read-lines.ts、src/main/services/agent-host/WorkerTransport.ts 的 utility 支路、src/runtime/smoke/p1-utility-worker.ts | utility 载体的 worker stdout 像 node 载体一样被排空（D11 第 5 条落实到位），并有一条用例覆盖 |
| T048 | fix-before-e | medium | terminal-01, terminal-03, terminal-04, terminal-08, terminal-09, terminal-10, concurrency-07 | src/main/services/terminal/PiTuiPty.ts、PtyManager.ts、ShellDetector.ts、src/main/ipc/piTui.ts、src/renderer/components/chat/usePresentationSwitch.ts、src/renderer/hooks/useXterm.ts | kill 之后等待并校验进程真的退出，失败要上报而不是吞掉 |
| T049 | fix-after-e | medium | utility-01, utility-02, utility-03, utility-04, utility-05, utility-06, utility-08, utility-09, utility-10 | src/main/services/agent-host/PiUtilityService.ts、src/main/services/ai/{code-review,branch-name,commit-message}.ts、src/renderer/components/settings/AISettings.tsx、source-control/{CodeReviewModal,CommitBox}.tsx | 有一张成文的超时预算表：冷启动与热请求分开、Main 侧与 worker 侧保持严格不等式（照 /compact 的 60s>45s 做法），worker 侧那份真的能轮到 |
| T050 | fix-after-e | medium | d-cross-01, d-cross-02, d-cross-03, concurrency-08, main-aux-09 | src/runtime/worker/nativeWorkerRuntime.ts 的 capabilities()、src/shared/types/workerRpc.ts 的 WorkerCapabilityInventory、src/renderer/components/workspace-shell/LeftDock.tsx 的 Capabilities 对话框、src/main/services/agent-host/subagentCatalog.ts 的 read() 与写侧、src/runtime/plugins/mcp/config.ts 的上限切片 | 能力清单带诊断通道（source / code / path / message，按条数封顶），Capabilities 对话框在对应分组下列出「为什么它不在列表里」 |
| T051 | fix-after-e | medium | chat-event-12, d-cross-04 | src/runtime/plugins/permissions/ 与 plugins/tools/ask.ts 的落盘（目前零 session 引用）、src/agent-host/piSessionTimeline.ts 的投影、src/renderer/stores/chatSessions.ts 的 mapHistoryBlock | 审批决定与问答回答以结构化 custom 条目写进会话文件（工具、路径/命令、决定、来源、时间戳、questionId 与所选项），投影层映射成 HistoryBlock，回放后权限卡行、审批审计行与已答问答卡都能还原 |
| T052 | fix-after-e | medium | import-up-01, import-up-02, import-up-03, import-up-04, import-up-05, import-up-06, import-up-07, import-up-08 | src/main/services/legacyImport/ 下的 CodexSessionScanner.ts、CodexRollout.ts、ClaudeSourceAdapter.ts、legacyImportSanitization.ts 与 src/shared/types/legacyImport.ts | 一个读不动的子目录或超过 1 万个文件不再让整份 Codex 历史从导入列表里静默消失（部分失败要报出来） |
| T053 | fix-after-e | low | chat-event-03, chat-event-04, chat-event-06, chat-event-09, chat-event-10, chat-event-11, chat-tool-08 | src/shared/types/runtimeEvents.ts 的字段清理、src/runtime/plugins/tools/index.ts 的 tool.updated、src/runtime/events/projector.ts 的 usage.updated、src/renderer/components/chat/ 下为这些字段保留的分支，以及 runtimeToolVocabulary 的对账测试 | 每个没有生产者的字段二选一：接上生产者，或连同渲染层的分支一起删掉，不留「注释说它还在用」的状态 |
| T054 | fix-after-e | low | main-host-05, main-host-06, main-host-07, main-host-08, chat-event-08, ah-lib-04, ah-lib-05, ah-lib-06, terminal-05, terminal-06, session-index-03, session-index-06, session-index-07, session-index-08, session-index-10, baseline-01, baseline-02, spike-02 | src/main/services/agent-host（tier 通道、WorkerSlotDiagnostic、replaceCrashedTransport、index.ts 桶文件）、src/renderer/components/chat/hostStatus.ts、src/agent-host/userResourcePaths.ts、src/runtime/__tests__/hostBoundary.test.ts、SessionIndexService 周边的次要接线、.github/workflows/build.yml 与 vitest.config.ts | tier RPC 通道、五种 WorkerSlotDiagnostic、replaceCrashedTransport 状态机、agent-host 目录桶文件、host.ready / host.error 与 Node 24 指引分支、userResourcePaths.ts：逐个给出「删除」或「接上生产者」的结论并落地，注释同步 |
| T055 | docs-only | low | field-01, field-02, field-03, field-04, field-05, windows-08, smoke-01, import-up-10, spike-01, terminal-07 | docs/plantree/plans/runtime-evolution/README.md 的看板、docs/plans/2026-09-09-bash-carrier-decision.md、Windows-P4-6-evidence/ 下的启动脚本与清单、evidence/p4-6/perm1/README.md、evidence/p0 的冒烟存档、external-agent-migration/README.md、docs/plans/2026-09-08-runtime-evolution-ard.md，以及 tuiHandoverWiring.test.ts 里那条不成立的注释 | 看板不再把现场明确拒签的 R2/R3 写成载体对照结论、也不再据此宣告放行规则结案 |
| T032（并入） | checklist-e | low | field-06 | docs/plantree/plans/runtime-hardening/roadmap.md 的 T032 条目 | T032 的现场项枚举补齐 field-nodes 区域的全部十余条（F1～F7、GUI A/2、A/4、A/10、B/5、C/8、F/13、F/15 以及 F3 这条 incomplete 子项），并把本轮 fix-before-e 各组做完后需要现场确认的点（Windows deny 绕过的修复验证、两载体重采、加密机 TSD 触发、并发多会话写锁接管）一并列进去，逐条写清「怎么算通过」 |

接缝审查员的提醒：12 组 fix-before-e 对上机前的时间窗来说偏多，若要再压缩，第 11 组（T047，TSD）与第 12 组（T048，终端 / TUI）里有一部分可以转成上机当天的观察项。这一条已在 roadmap 立为待拍板项。
