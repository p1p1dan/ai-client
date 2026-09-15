# 批次 D 补审发现：medium 级（42 条）

Role: evidence（source material，原文保留）；来源：2026-09-15 批次 D 只读补审（T029 / T030 / T031，基线 HEAD `ebc82f16`，65 个代理）。严重级取反驳者裁定（`final_severity`）。本文件只收 `confirmed` 与 `confirmed-partial-waiver`；待定 / 推翻 / 取舍见 [findings-uncertain-refuted-waived.md](findings-uncertain-refuted-waived.md)，接缝与批评者全文见 [cross-and-critic.md](cross-and-critic.md)，总览见 [README.md](README.md)。

统计：区域发现 39 条（main-host-aux 5 · main-host 3 · utility-chain 4 · session-index 2 · import-upstream 3 · terminal-tui 3 · agent-host-lib 3 · chat-tool-vocab 2 · chat-event-vocab 4 · concurrency 3 · windows-static 4 · capacity-leftovers 1 · tsd-utility 2），接缝发现 3 条（d-cross-01 / d-cross-02 / d-cross-04）；其中部分取舍 5 条、静态推断 22 条、被去重并入 2 条。

每条发现的格式：`[编号] 严重级 类别 最终状态 | 节点 | 文件:行 | 标题`，随后是审查员描述（DESC）、引用代码（EVIDENCE）、失败场景（SCENARIO）、修法建议（FIX）、反驳者结论（REFUTER）与文档取舍核对（WAIVER）。最终状态：confirmed=反驳者确认且无取舍；confirmed-partial-waiver=确认但文档部分取舍；uncertain=无法构造触发路径也无法排除；refuted=被推翻；waived=文档明确取舍、不计入。

标题行的补充标记：`（审查员原判 x）`=反驳者改过严重级，以标题行开头的严重级为准；`（静态推断）`=结论来自静态阅读、本轮无任何现场执行；`→ 并入 <编号>`=接缝审查员判为同一根因的重复条目，原文保留、修补时跟着 keep 那条走，被并入的条目不计入独立缺陷数。接缝审查员直查的 4 条 `d-cross-*` 没有 REFUTER / WAIVER 段，改写一行 SOURCE。

排列顺序：T029 九区（main-host-aux / main-host / utility-chain / session-index / import-upstream / terminal-tui / agent-host-lib / chat-tool-vocab / chat-event-vocab）→ T030 五区（smoke-p0-6 / cordis-spike-d1 / baseline-comparability / field-nodes / h-nodes）→ T031 四区（concurrency / windows-static / capacity-leftovers / tsd-utility）→ 接缝。区域原文报告在 `raw/<区域>.md`。

### [main-aux-02] MEDIUM correctness confirmed-partial-waiver | F2-b | src/main/ipc/chat.ts:613 | 归档在 worker 还活着时就 rm -rf 它的 cwd，与退出清理自己写下的顺序约束相反
DESC: CHAT_ARCHIVE_SESSION 的处理是「翻归档位 → await scratchWorkspaceService.release()」，release() 立刻递归删除该会话 cwd；handler 不 dispose worker 也不等它退出。渲染层先 await 这个 IPC、成功后才 detachRuntime（sessionIndex/useSessionIndex.ts:343-350），而 detach 才发 chat:closeSession，所以目录删除一定发生在 worker 回收之前。同仓库的退出清理把这条约束写得很清楚并遵守了它。Windows 上 rm 因占用失败的那一半是静态推断；POSIX 上的调用顺序是代码可确定的。
EVIDENCE: ipc/chat.ts:608-615 → if (result && payload.archived) { await scratchWorkspaceService.release(payload.sessionId); }
ipc/workerManager.ts:6-12 → await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]); // 'after the workers are gone, not before — a live worker still has its scratch cwd open, and removing it underneath one invites EBUSY on Windows and a confusing tool failure everywhere else.' await scratchWorkspaceService.wipeAll();
useSessionIndex.ts:343-350 → if (ok) { if (archived) { if (isHostBound(sessionId)) detachRuntime(sessionId); …
SCENARIO: 一个未绑定文件夹的临时对话正在跑回合（agent 正往 cwd 写文件），用户点归档或用 U31 批量归档。Main 立刻删掉这个 worker 的 cwd，渲染层之后才发关闭：POSIX 上后续文件工具在已删除目录里执行，报错与「目录没了」毫无关系；Windows 上 rm 很可能占用失败，被 removeQuietly（:212-219）吞掉只记日志，目录残留到下次启动的整根清理，「归档即销毁」当场不成立且无提示。
FIX: 在 handler 里先 await workerManager.closeSession（或专门的 retireSession）拿到 worker 已退出的信号，再 release()；release() 内部加一条「该会话仍有活 slot 时拒绝」的断言，把约束写成代码。补用例：注入假的 worker 生命周期，断言 release 发生在 dispose 之后。
REFUTER(CONFIRMED-PARTIAL-WAIVER,medium): 顺序确认成立。ipc/chat.ts:606-616 的 CHAT_ARCHIVE_SESSION 只有 `const result = await sessionIndexService.setArchived(...); if (result && payload.archived) { await scratchWorkspaceService.release(payload.sessionId); }`，全文 grep `setArchived` 在 main 侧只有这一处，handler 内没有任何 workerManager 调用（chat.ts 里 closeSession 只出现在 :512 的 CHAT_CLOSE_SESSION）。渲染层 useSessionIndex.ts:329-351 是 `let ok = await callArchive(...)`（IPC 已经返回、目录已删）→ `if (ok) { if (archived) { if (isHostBound(sessionId)) detachRuntime(sessionId); ... } }`，而 detachRuntime（:244-250）是 `void Promise.resolve(window.electronAPI.chat.closeSession({sessionId})).catch(()=>{})`，不等结果。所以 rm -rf 一定早于 worker 回收。同仓的退出清理反向证明该约束存在且被遵守：ipc/workerManager.ts:6-11 `await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);` 后注释 'after the workers are gone, not before — a live worker still has its scratch cwd open...' 才 `await scratchWorkspaceService.wipeAll()`。未见任何批次 A~C 修复。定 medium：POSIX 上表现为 agent 工具在被删目录里报莫名错误，Windows 上 rm 失败被 removeQuietly 吞掉（:203-210 catch 只 log），「归档即销毁」静默不成立；不是数据丢失也不会卡死。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/evidence/p4-6/f2b/README.md（结论 2）；原文：「「归档」当场删目录。`release()` 在归档这一步同步跑掉，T1 就能看到目录没了、索引行还在并置了 `archived:true`。索引与磁盘在这条路上是一致的。」

### [main-aux-03] MEDIUM correctness confirmed | F2-a | src/main/services/agent-host/ScratchWorkspaceService.ts:109 | 改临时根设置后旧根下的 scratch 目录永不清理，且恢复时丢掉 unbound 不信任姿态
DESC: F2-a 的修法（两个读者读同一份即时生效的设置）是对的，但 rootPath() 每次调用现算 resolveBasePath()。已分配的目录仍在旧根下，而 isScratchPath / wipeAll 判的都是新根。后果三条：① 退出与启动的 wipeAll 只删新根，旧根下目录永久留盘，模块开头「a scratch directory does not survive the app」不再成立；② 重启后 resume 时 isScratchPath 为 false，走 else 分支，unbound 为 false，而 unbound 正是决定「不带项目信任启动」的那一位（WorkerManager.ts:124-129 字段注释、:731 写入、:2002 随 spawn 下发）；③ CHAT_ENSURE_SCRATCH_WORKSPACE（:313-321）也不再认得该行，会 ensure() 分配第二个目录，而 :313 的注释自己写了这会让 resume 报 workspace mismatch。
EVIDENCE: rootPath() { return path.join(this.resolveBasePath(), SCRATCH_ROOT_DIR); } // :108-111
ipc/chat.ts:402-411 → const unbound = scratchWorkspaceService.isScratchPath(payload.workspacePath); if (unbound) { await scratchWorkspaceService.adopt(...) } else { await adoptTempWorkspace(...) }
WorkerManager.ts:124-129 → 'U05-c — cwd is a throwaway scratch directory … this session must bootstrap without project trust.' readonly unbound: boolean;
设置即时可见：readSettings()（ipc/settings.ts:82）优先返回 pendingRendererSettings，后者在 SETTINGS_WRITE 里同步赋值（:164），不等 500ms 防抖。
SCENARIO: 用户有若干临时对话，然后在设置→常规→保存位置把临时目录改到别处。退出应用后旧路径下的 unbound-sessions/ 连同 agent 写过的文件原封不动留着，下次启动也不清；重开那些对话时它们以带项目信任的姿态启动在这些残留目录里，侧栏也不再标为临时会话。
FIX: 目录分配时把所属根记下来（写进 session-index 行，或服务持有「本次运行已知的历史根」集合），wipeAll 同时清当前根与历史根，isScratchPath 对历史根也返回 true；或在设置变更时把旧根内容迁移/清理一次并记日志。补用例：分配 → 换 resolveBasePath → 断言 isScratchPath(旧路径) 与 wipeAll 的覆盖面。
REFUTER(CONFIRMED,medium): 成立。rootPath() 在 ScratchWorkspaceService.ts:108-110 是 `return path.join(this.resolveBasePath(), SCRATCH_ROOT_DIR);`，每次现算；生产的 resolveBasePath 是 productionBasePath（:90-92 `getEffectiveTemporaryBasePath(settingsTemporaryPath(), homedir(), path.sep)`），而 settingsTemporaryPath（:74-83）读的是 ipc/settings.ts 的 readSettings()，后者（settings.ts:80-86）在有 pendingRendererSettings 时直接返回它，SETTINGS_WRITE（:161-164）是同步赋值 `pendingRendererSettings = newData`，不等防抖落盘 —— 所以换根即时生效。全仓 grep `defaultTemporaryPath` 只有 Scratch/TempWorkspace/renderer 几处读取，没有任何「换根时迁移或清理旧根」的代码。三条后果逐条成立：① wipeAll（:191-196）删的是 `this.rootPath()`，即新根，旧根目录留盘，与模块头 :13-14 'a scratch directory does not survive the app' 相悖；② ipc/chat.ts:404-411 与 :266-272 都用 `isScratchPath(payload.workspacePath)` 决定 unbound，旧根路径判 false，走 `else await adoptTempWorkspace(payload.workspacePath)`（TempWorkspaceService.ts:67-68 对非 temp 路径静默 no-op，所以不会报错，只是悄悄按「真实项目」姿态起），unbound 正是 WorkerManager.ts:118-129 字段注释说的 'must bootstrap without project trust'，:731 写入、:2001 随 spawn 下发；③ ipc/chat.ts:313-321 的 ensure 分支同理认不出旧路径而新分配一个目录，:308-313 注释自己写了这会让 resume 报 workspace mismatch。注意换根后同一次运行内也会翻车（不必重启），因为 isScratchPath 判的是新根。定 medium：需要用户主动改设置，后果是残留文件 + 信任姿态降级，非直接数据损坏。
WAIVER(none): 无 — 全文档检索无命中

### [main-aux-06] MEDIUM security confirmed | main-host-aux | src/main/services/agent-host/WorkerManager.ts:2060 | worker stderr 只有走 IPC 的那一路脱敏，进 main.log 的两路是原文
DESC: absorbStderr 把组装好的整行同时送三处：this.log（日志 sink，info 级）、forwardStderr（IPC 给渲染层）、entry.recentStderr 缓冲区（worker 死亡时由 dumpWorkerStderr 用 console.error 整批打出）。三处里只有 forwardStderr 调了 sanitizeStderrLine（:2102）。dumpWorkerStderr 的注释还特意说明用 console.error 是因为「electron-log 在文件日志关闭时仍保留 error 级」，即这条路一定落盘。而 stderrRedaction.ts 的模块文档把自己定位成「泄漏的凭据与 UI 之间唯一的门」——门装在了 UI 那一侧，落盘那一侧没装。
EVIDENCE: absorbStderr: for (const line of drained.lines) { this.log(prefix, line); this.forwardStderr(entry, line); } // :2055-2063，this.log 收到的是原文
forwardStderr: line: forwarded === MAX ? '…capped…' : sanitizeStderrLine(line) // :2098-2103，唯一脱敏点
dumpWorkerStderr: console.error(`… last ${lines.length} stderr line(s):\n${lines.join('\n')}`) // :2109-2117，原文进 error 级日志
SCENARIO: worker 或其子进程在启动失败时把环境或请求头打到 stderr（ANTHROPIC_AUTH_TOKEN=…、authorization: Bearer …、sk-ant-… 都在 stderrRedaction.ts 的规则表里，说明这些形态是预期输入），worker 随后退出，dumpWorkerStderr 把最近 50 行原样写进 main.log。用户为排障把日志发给支持或贴进 issue，凭据随之外泄；界面上同一批行是打过码的，所以没人会意识到日志里没有。
FIX: 把脱敏提到 absorbStderr 的循环里做一次（const safe = sanitizeStderrLine(line)），三个出口统一用 safe，forwardStderr 去掉自己那次调用；注意 sanitizeStderrLine 自带长度上限，与 clampLine 叠加需确认先后。补用例：喂一行含 sk-ant- 的 stderr，断言注入的 log sink 与 console.error 收到的都是 [redacted]。
REFUTER(CONFIRMED,medium): 成立，但「两路原文落盘」要修正为一路。WorkerManager.ts:2055-2063 `for (const line of drained.lines) { this.log(prefix, line); this.forwardStderr(entry, line); }`，脱敏只在 forwardStderr 内（:2098-2103 `line: forwarded === STDERR_FORWARD_MAX_LINES_PER_TURN ? '…' : sanitizeStderrLine(line)`）。其中 this.log 在生产是空函数（:417 `this.log = options.log ?? (() => undefined)`，:2787-2799 的生产实例没有传 log），所以那一路不泄漏——审查员这半条不成立。真正落盘的是 dumpWorkerStderr（:2107-2117）：`console.error(`[pi-worker:...] ${reason}; last ${lines.length} stderr line(s):\n${lines.join('\n')}`)`，行来自 entry.recentStderr（:2058 未脱敏写入）。console.error 确实进文件日志：src/main/utils/logger.ts:70-71 `log.initialize({preload:true}); Object.assign(console, log.functions);`，且 :82-88 在日志关闭时仍设 `log.transports.file.level = 'error'`，即默认配置下 error 级必落盘，与 :2113 的注释自述一致。脱敏模块定位确实写成唯一闸门（src/agent-host/stderrRedaction.ts:1-6 'the only gate between a leaked credential in stderr and the UI'），规则表含 sk-ant-/Bearer/ANTHROPIC_* 赋值等形态（:39-54 及 SENSITIVE_ASSIGNMENT），说明凭据形态是预期输入。git log -S sanitizeStderrLine 只有 T017（83a9d0f8）引入 forward 侧脱敏，批次 A~C 未补落盘侧。定 medium：需要 worker 真把凭据打到 stderr 才会泄漏，属于日志泄漏而非直接权限绕过。
WAIVER(none): 无 — 全文档检索无命中
合并：ah-lib-01 / ah-lib-02 并入本条（同一根因：仓库里有两套脱敏实现（src/agent-host/stderrRedaction.ts 与 T011 新写的 src/runtime/plugins/agent-loop/providerErrors.ts），既没有统一，也没有装在所有出口上。三条是同一个缺口的三个出口：worker stderr 进 main.log 的两路是原文（main-aux-06，WorkerManager.ts:2062 的 this.log(prefix, line) 在 sanitizeStderrLine 之前）、provider 错误正文落进会话文件两套都没走（ah-lib-01）、新那套规则比既有那套弱、认不出裸密钥（ah-lib-02）。必须作为一个修补任务：先合并成一份规则，再逐出口装上。保留 main-aux-06 作主编号（medium security，出口最具体）。）

### [main-aux-07] MEDIUM correctness confirmed | F2-c | src/main/services/agent-host/TempWorkspaceService.ts:287 | 临时工作区归属判定用未规范化的 base 做 dirname 全等比较，设置值带尾部分隔符就让自愈静默失效
DESC: isTempWorkspacePath 把候选路径 path.resolve 后取 dirname，与 settingsBasePath() 的返回值做字符串全等比较。而 settingsBasePath() 返回的是 getEffectiveTemporaryBasePath(用户输入,…)，它只做 trim() 与 ~ 展开（shared/defaultPaths.ts:85-91），既不 path.resolve、也不去尾部分隔符、也不统一分隔符方向。保存位置在设置页是自由文本输入框（GeneralSettings.tsx:129-131），用户完全可能输入 /home/x/tmp/ 或（Windows 上）D:/tmp。一旦如此比较恒为 false，adoptTempWorkspace 直接 return，自愈不发生。对照组是隔壁 scratch：rootPath() 用 path.join 归一、isScratchPath 两侧都过 canonicalPathKey，同样输入不受影响。
EVIDENCE: export function isTempWorkspacePath(candidate: string): boolean { … const basePath = settingsBasePath(); const resolved = path.resolve(expandHomePath(candidate, homedir(), path.sep)); return resolved !== basePath && path.dirname(resolved) === basePath; } // :283-288
export async function adoptTempWorkspace(dirPath){ if (!isTempWorkspacePath(dirPath)) return; … } // :299-305，唯一消费者
只读复算（node -e）：base='/home/x/tmp/'、候选 '/home/x/tmp/ws1' → path.dirname(path.resolve(候选))='/home/x/tmp' ≠ base → false；base 去掉尾斜杠后为 true。
SCENARIO: 用户把保存位置填成 ~/JYWAI/temporary/（末尾多一个斜杠），之后在资源管理器里手工删掉某个临时工作区目录，再回到应用点开那个对话。本该「app 自建内容就地重建 + git init」的自愈整条不执行，forkPiWorkerProcess 撞上不存在的 cwd，用户拿到 workspace_missing 错误卡——与 F2-c 里「用户目录不重建」的表现一样，但这是 app 自己建的目录，本应被重建。
FIX: 让 isTempWorkspacePath 与 scratch 侧共用一套归一：两侧都 path.resolve + 去尾分隔符（Windows 折大小写），或改用 path.relative(base, resolved) 判「恰好一层」；更根上的修法是让 getEffectiveTemporaryBasePath 返回归一化路径。补用例：base 带尾斜杠 / 正斜杠形态各一条。
REFUTER(CONFIRMED,medium): 推翻失败，核心成立，但审查员给的触发场景举错了例子。核心代码属实：TempWorkspaceService.ts:53-55 `const basePath = settingsBasePath(); const resolved = path.resolve(expandHomePath(candidate, homedir(), path.sep)); return resolved !== basePath && path.dirname(resolved) === basePath;`——右边 path.resolve 过、左边没有。settingsBasePath()（:34-41）返回 getEffectiveTemporaryBasePath(configured, homedir(), path.sep)，而 shared/defaultPaths.ts:163-170 只有 `configuredBasePath.trim() || 默认值` 再 expandHomePath，没有 path.resolve、没有去尾分隔符。创建侧则是归一的：ipc/tempWorkspace.ts:44-50 resolveBasePath 做了 path.resolve，:124 `path.join(basePath, folderName)`，所以落盘路径永远是 '/x/tmp/ws1' 形态，与带尾斜杠的设置值比不上。node -e 复算：dirname(resolve('/home/x/tmp/ws1')) === '/home/x/tmp/' → false，=== '/home/x/tmp' → true。唯一消费者 adoptTempWorkspace(:68) 一旦判 false 直接 return，chat.ts:273 与 chat.ts:410 的自愈整条不跑，spawn 撞空 cwd。设置页是自由文本输入（GeneralSettings.tsx:129-131 `<Input value={defaultTemporaryPath} onChange=...>`），不做归一。对照组属实：ScratchWorkspaceService.ts:130 `canonicalPathKey(candidate).startsWith(canonicalPathKey(this.rootPath()) + '/')`，注释明写 canonicalPathKey 折分隔符并去尾斜杠。批次 A~C 未碰：git log 该文件最后一次改动是 dbead94b（引入自愈本身），roadmap.md Done 段无任何条目涉及临时工作区归属判定。需要更正的地方：审查员 scenario 写「用户填 ~/JYWAI/temporary/」不成立——expandHomePath（defaultPaths.ts:145-152）对 '~/' 开头的输入走 splitPathSegments，正则 /[\\/]+/ + filter(Boolean) 会把尾斜杠吃掉，波浪号形态自动归一。真正能触发的是不带 ~ 的绝对路径带尾分隔符（'/home/x/tmp/'）或 Windows 上写正斜杠（'D:/tmp'），此时 expandHomePath 原样返回。触发面因此比描述窄（要求用户手打绝对路径且带尾分隔符，文件夹选择器 GeneralSettings.tsx:54-63 给的是归一路径），但仍是用户可见的功能错误：自愈静默不发生、对话打不开。故 medium。
WAIVER(none): 无 — 全文档检索无命中

### [main-aux-09] MEDIUM correctness confirmed | H/19 | src/main/services/agent-host/subagentCatalog.ts:266 | 删除被影子覆盖的兼容根定义只删影子、旧文档随即复活；改名则直接删掉 ~/.agents 下的原文件
DESC: read() 按 [<agentDir>/subagents, ~/.agents/subagents] 两个根扫描，第一个根先占名，被遮住的第二根文档不出现在列表里（:135-138）。但写侧只认列表里那一行的 filePath：remove() 删的是 target.filePath（:266-267），即第一根里的影子；删完重新 read()，第二根里那份旧文档立刻补位成为生效定义，用户看到的是「点了删除，这一行还在，而且内容变回老版本」。save() 的两条路还互相矛盾：不改名地编辑一个来自第二根的定义，写的是第一根的新文件、旧文件留着（影子语义）；带 previousName 的改名则执行 rm(old.filePath)（:242），直接删掉 ~/.agents/subagents/<旧名>.md——一个本应用并不拥有的目录里的文件。类文档四条规则里没有一条覆盖这个兼容根。
EVIDENCE: private roots(){ return [this.directory(), join((this.deps.home ?? homedir)(), '.agents','subagents')]; } // :90-92
if (claimed.has(parsed.definition.name)) continue; // :137，第二根同名文档不进列表
const filePath = target?.filePath ?? brokenTarget?.filePath; if (filePath) await rm(filePath, { force: true }); // :266-267
if (previous && previous !== name) { const old = before.rows.find(e => e.name === previous); if (old?.filePath) await rm(old.filePath, { force: true }); // :238-243
测试把第二根显式指向空临时目录（__tests__/subagentCatalog.test.ts:36-38「Never the developer's real home」），整个兼容根零覆盖。
SCENARIO: H/19 之前就在用 ~/.agents/subagents/reviewer.md 的用户，在设置页编辑了 reviewer（于是 <agentDir>/subagents/reviewer.md 出现），之后决定删掉它：点删除后列表刷新，reviewer 仍在、内容回到编辑前的老版本、filePath 指向 ~/.agents；再点一次才删掉原件。另一条：把 ~/.agents/subagents/reviewer.md 改名为 critic，用户 ~/.agents 目录里那份文档被静默删除，而该目录可能还被别的工具读。
FIX: 让 read() 保留被遮住的副本信息（行上加 shadowedBy / shadowing 字段）；remove() 要么把同名的所有 user 文档一并删、要么明确告知「删掉的是这一份，另一份在 ~/.agents/… 仍会生效」；save() 的改名路径对第二根的文件只留在原处而不是 rm（或给出确认）。补用例：在注入的 home 下放同名文档，覆盖影子、删除、跨根改名三种路径。
REFUTER(CONFIRMED,medium): 三条子结论逐条对上当前代码，无法推翻。(1) 双根与遮蔽：subagentCatalog.ts:90-92 `return [this.directory(), join((this.deps.home ?? homedir)(), '.agents', 'subagents')];`，:137 `if (claimed.has(parsed.definition.name)) continue;`，注释明写「First root wins a name… The shadowed copy is not listed twice」，所以第二根的同名文档不进 rows，调用方只拿得到影子那一行的 filePath。(2) 删除只删影子：remove() :266-267 `const filePath = target?.filePath ?? brokenTarget?.filePath; if (filePath) await rm(filePath, { force: true });` 之后 :274 `return this.read();` 重扫两根，被遮的旧文档立刻补位——「点了删除，行还在且内容回退」成立。(3) 写侧两条路语义相反：save() 无论来源都写第一根（:235-236 `await mkdir(this.directory(), …); await writeFile(this.pathFor(name), document, 'utf8');`，pathFor 基于 directory() = agentDir()/subagents），而带 previousName 的改名走 :238-243 `const old = before.rows.find(e => e.name === previous); if (old?.filePath) await rm(old.filePath, { force: true });`——old.filePath 可能正是 ~/.agents/subagents/<旧名>.md，于是删掉应用并不拥有的目录里的文件。(4) 测试零覆盖属实：__tests__/subagentCatalog.test.ts:36-38 注入 `home: () => join(root, 'home')` 并注明 'Never the developer's real home'，全文件再无 .agents 相关断言（grep '\.agents' 只命中这条注释）。(5) UI 侧没有兜底：PiSubagentsSettings.tsx:356/510/524 只是把 row.filePath 显示出来，删除与编辑对第二根的行同样开放。(6) 未被批次 A~C 修：git log -- subagentCatalog.ts 最新为 60b250f3（T020），roadmap Done 段 T020 条目列的是 subagent-data-01~17 与迁移入口（只扫 `<agentDir>/agents`），无一条涉及 `~/.agents/subagents` 兼容根的写侧语义。严重级维持 medium：删除后旧版本复活是明确的用户可见错误行为；改名时 rm 掉 ~/.agents 下的文件虽然发生在应用之外的目录，但内容已先写入新位置（:236 在 :242 之前），是迁移而非净丢失，不到 high。
WAIVER(none): 无 — 全文档检索无命中

### [main-host-01] MEDIUM correctness confirmed | P4-4 | src/main/services/agent-host/WorkerManager.ts:1148 | 斜杠命令的「随便找个活着的 worker」回退会把另一个仓库的项目级技能与提示词端到端交给用户
DESC: getSlashCommands 在指名会话没有 ready worker 时会挑池子里任意一个 ready worker 来回答。它的依据写在同一段注释里：「In managed mode the command set does not vary by working directory — project scope is withheld」。这个前提在决策 009 之后不成立：NATIVE_PROJECT_TRUSTED 是写死的 true（src/shared/piModelConfig.ts:67），worker 原样交给图（src/agent-host/worker.ts:138），于是技能与提示词的项目级根一定会被扫（skills/index.ts:224-233 的 <cwd>/.pi/skills 与 .agents/skills 上溯链，:244-245 的 <cwd>/.pi/prompts）。worker.commands 返回的每一行还带 path（绝对路径）与 scope:'project'。worker 侧的 assertLogicalSession 拦不住，因为 Main 传的就是被回退选中那个 worker 自己的 logicalSessionId。非笔误：WorkerManager.test.ts:2160 把这个回退钉成了期望行为，修的时候要连注释、用例与口径一起改。
EVIDENCE: // WorkerManager.ts:1131-1135（注释）
//  - **Any ready worker will do.** In managed mode the command set does not
//    vary by working directory — project scope is withheld, ...

// WorkerManager.ts:1144-1156
const named = input.sessionId ? this.entriesBySession.get(input.sessionId) : undefined;
const entry =
  named?.state === 'ready' && named.slot
    ? named
    : [...this.entriesBySession.values()].find(
        (candidate) => candidate.state === 'ready' && candidate.slot
      );
if (!entry?.slot) return { commands: [], truncated: false };
const result = await entry.slot.request<WorkerCommandsResult, WorkerCommandsPayload>(
  'worker.commands',
  { logicalSessionId: entry.logicalSessionId }
);

// src/shared/piModelConfig.ts:67
export const NATIVE_PROJECT_TRUSTED = true;

// src/runtime/plugins/skills/index.ts:224-226
if (config.cwd && enabled.project) {
  roots.push({ path: join(config.cwd, '.pi', 'skills'), scope: 'project', rootMarkdown: true });
SCENARIO: 用户在仓库 /work/alpha 的会话 A 里已经发过消息（worker ready），随后在 /work/beta 新建会话 B、还没发第一条消息（B 没有 worker，懒启动）。用户在 B 的输入框敲 `/`，菜单弹出的是 /work/alpha/.pi/prompts 与 /work/alpha/.pi/skills 的条目，连同 alpha 的绝对路径。用户选一条 alpha 专属命令发给 B，B 的 worker 没有这个模板，命令要么当普通文本发给模型、要么直接失败——而用户刚刚在菜单里看到过它。
FIX: 回退只在「不知道要问谁」时才合理。二选一：(a) 指名会话没有 ready worker 时直接返回空列表，把回退限制在 input.sessionId 缺省的开始屏场景；(b) 保留回退但按 cwd 过滤，只接受与目标会话同一 cwd 的 worker。同时改掉 :1131-1135 那段已不成立的注释，并把 WorkerManager.test.ts:2160 改成新口径。
REFUTER(CONFIRMED,medium): 推不翻。WorkerManager.ts:1144-1156 的回退确实存在且无 cwd 过滤：`const named = input.sessionId ? this.entriesBySession.get(input.sessionId) : undefined;` 之后 `: [...this.entriesBySession.values()].find((candidate) => candidate.state === 'ready' && candidate.slot)`，随后用 `{ logicalSessionId: entry.logicalSessionId }` 发 worker.commands（:1153-1156），所以 worker 侧 nativeWorkerRuntime.ts:564 的 `this.assertLogicalSession(input.logicalSessionId)` 必然通过。回退所依据的前提确已作废：src/shared/piModelConfig.ts:67 `export const NATIVE_PROJECT_TRUSTED = true;`，src/agent-host/worker.ts:138 `projectTrusted: NATIVE_PROJECT_TRUSTED`，settingSources.ts:51-54 `const trusted = options.projectTrusted === true; ... project: trusted && enabled('project')`，于是 skills/index.ts:224-226 的 `join(config.cwd, '.pi', 'skills')` 与 :244-245 的 `join(config.cwd, '.pi', 'prompts')` 一定会被扫。nativeWorkerRuntime.ts:566-586 的行里带 `path: template.filePath` / `scope: template.scope`，shared/types/workerRpc.ts:1044-1045 的 sanitize 原样保留 path 与 scope，不做任何过滤。渲染层 ChatComposer.tsx:984 `getSlashCommands(activeSessionId ? { sessionId: activeSessionId } : {})` 确实指名会话，因此「指名会话没 worker 就串到别的仓库」这条路径成立。时间线也支持：回退与注释来自 8948aef2（Pi 斜杠命令接入），决策 009 是之后的 74646a40，注释「project scope is withheld」自那时起失效，批次 A~C 没有改过这段（git log -S"Any ready worker will do" 只有 8948aef2 一条）。WorkerManager.test.ts:2160-2169 确实把回退钉成期望行为并复述了同一句失效前提。严重级维持 medium（用户可见错误行为 + 跨仓库项目级路径/描述外泄，但不是权限绕过）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/decisions/009-managed-route-trusts-project-sources.md；相关原文：「native 侧的实现用常量 NATIVE_PROJECT_TRUSTED = true……项目可信意味着克隆下来的仓库可以经 .pi/mcp.json 起进程、经指令文件影响模型；这与 local 模式既有行为一致，用户接受。」

### [main-host-02] MEDIUM robustness confirmed | P4-4 | src/main/services/agent-host/WorkerManager.ts:1949 | 关机时导入槽拆除一抛错，整池会话 worker 的优雅拆除和 7 秒兜底强杀被一起跳过（静态推断）
DESC: disposeAll 把「拆导入槽」放在「拆会话池」之前且不兜底。导入槽的 dispose()（PiImportProcess.ts:137-141 → WorkerSlot.dispose）在 ACK 3 秒或退出确认 3 秒超时时 reject；WorkerManager.createLegacyImport 返回的包装层即使强杀成功也一定把原错误再抛出去（WorkerManager.ts:556-568 catch 末尾的 throw error）。于是 disposeAll 的 async 体在 await activeImport.dispose() 中断：后面的三个 null 归位、importSlotActive=false、disposeEntries(...)、state='stopped' 全不执行。外层更麻烦：cleanupWorkerManager 的 Promise.all 立刻 reject，safeRun 吞掉并迅速 resolve，于是 Promise.race([allSettled, deadline]) 远早于 7 秒结束，clearTimeout(deadlineTimer) 把那个本会调用 cleanupWorkerManagerSync() 的定时器取消掉——兜底强杀这条路一并没了。同一次失败还跳过了 scratchWorkspaceService.wipeAll()（U05-a 的临时目录清理，写在 Promise.all 之后）。
EVIDENCE: // WorkerManager.ts:1941-1957
disposeAll(reason: 'app-shutdown' | 'slot-dispose' = 'app-shutdown'): Promise<void> {
  return this.serialize(async () => {
    ...
    if (activeImport) await activeImport.dispose();        // <- 抛出即中断
    else if (activeImportSlot) await activeImportSlot.dispose(reason);
    this.activeImport = null;
    ...
    await this.disposeEntries([...this.entriesBySession.values()], reason);
    this.state = 'stopped';
  });
}

// src/main/ipc/workerManager.ts:6-12
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);
  await scratchWorkspaceService.wipeAll();
}

// src/main/ipc/index.ts:127-153
await Promise.race([ Promise.allSettled([ ... safeRun(() => cleanupWorkerManager(), 'workerManager') ... ]), deadline ]);
if (deadlineTimer) clearTimeout(deadlineTimer);
SCENARIO: 用户正在做一次体量较大的旧会话导入（导入 worker 忙于写盘），此时退出应用。worker.dispose 排在导入写入之后、3 秒 ACK 预算耗尽 → 导入槽被强杀但错误照抛 → disposeAll 在第一行中断 → 池子里所有会话 worker 都没收到 worker.dispose（不走 runtime 收尾与 MCP 子进程释放），也走不到 7 秒兜底的 cleanupWorkerManagerSync()，因为 allSettled 早已 resolve 并清掉定时器；scratch 临时目录也没被擦。静态推断部分：打包 Windows 上 worker 是 spawn 出来的 node.exe 子进程（PiWorkerProcess.ts:213），主进程退出不保证收走它们，最坏是残留 node.exe 与被它占住的会话 JSONL；macOS / Linux 走 utilityProcess 由 Electron 回收，只损失优雅收尾。需批次 E 上机确认。
FIX: 把导入槽拆除放进 try/finally（或 .catch(() => undefined) + 记日志），保证 disposeEntries 与 state='stopped' 一定执行；关机语义下「有东西没拆干净」应记录而不是中止。补一条用例：导入槽 dispose reject 时池内两个会话槽仍各收到一次 dispose。顺带让 cleanupAllResources 的 deadline 不被「快速失败」提前取消（把 cleanupWorkerManagerSync() 改成 finally 里的无条件兜底，它本来就幂等）。
REFUTER(CONFIRMED,medium): 静态推断，但链路每一环都能在当前代码读到。WorkerManager.ts:1941-1956 的 disposeAll 体：`if (activeImport) await activeImport.dispose();` 之后才是 `this.activeImport = null; ... this.importSlotActive = false; await this.disposeEntries([...this.entriesBySession.values()], reason); this.state = 'stopped';`，没有 try/finally，一抛即中断。抛错是必然而非可能：WorkerManager.ts:554-567 的包装 dispose 的 catch 分支里，即便 `const killed = created.forceKillNow();` 成功，末尾仍是无条件 `throw error;`。底层可抛：WorkerSlot.ts:392-393 `if (disposeError && !isLostDisposeAck(disposeError, exit)) throw disposeError;`，而 legacyImport/PiImportProcess.ts:139-142 的 `async dispose() { ... await slot.dispose('slot-dispose'); }` 未做吞错。serialize（:2303-2309）只吞链上的错、原 promise 照样 reject。外层 src/main/ipc/workerManager.ts:6-11 的 `await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]); await scratchWorkspaceService.wipeAll();` 会在 Promise.all 处 reject，wipeAll 被跳过；src/main/ipc/index.ts:118-124 的 safeRun 只是 console.warn 后 resolve，:127-152 的 `Promise.race([Promise.allSettled([...]), deadline])` 立即结束，:153 `if (deadlineTimer) clearTimeout(deadlineTimer);` 取消掉那个本会调 cleanupWorkerManagerSync() 的 7 秒定时器（:110-115）。之后 index.ts 的 will-quit（src/main/index.ts:871-876）在 finally 里 clearTimeout(forceExitTimer) 后直接 app.exit(0)，没有再补一次同步强杀。测试缺口属实：WorkerManager.test.ts 里 disposeAll 只在 :1843/:1886/:1986/:2123 出现，没有「导入槽 dispose reject」用例。审查员引的 PiWorkerProcess 行号偏了（该文件只有 105 行，win32 spawn 在 :78-89），但引用的代码内容与结论不受影响。严重级 medium：池内 worker 丢失优雅收尾与 scratch 目录残留是确定的；Windows 上 node.exe 残留需批次 E 上机确认。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md

### [main-host-03] MEDIUM contract-gap confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:2414 | Main 在 slot.dispose() 之前就关掉事件闸，worker 专门为此保留的排空事件全部被丢掉
DESC: worker 侧在 T016 专门调整过顺序并写了长注释：disposed 标志必须在 runtime 拆除之后才置位，因为引擎会在排空已挂起的权限门、问题与预览时发事件——「Setting it first dropped exactly the events those drains exist to deliver, so Main never learned that the dialogs it was showing had been answered for it」（piWorkerRpcServer.ts:928-943）。Main 这一侧把这份努力抵消掉了：retireAndDispose 先调 retireEntry，后者同步把 acceptEvents=false、state='disposing' 并从两张 map 摘掉 entry，然后才 await slot.dispose(reason)。而 handleWorkerEvent 第一道闸是 isAuthoritative（要求 acceptEvents 为真且两张 map 仍指向本 entry），第二道是 entry.state !== 'ready'——两道都必然不过。于是 permissions.drain('session_closed') 发出的 permission.resolved（nativeWorkerRuntime.ts:820-822 → permissionPrompt.ts:233-236 → :127-134）在 Main 出口被静默丢弃，question / preview 排空同理。
EVIDENCE: // WorkerManager.ts:2370-2378
private async retireAndDispose(entry, reason): Promise<void> {
  this.retireEntry(entry);      // acceptEvents = false, state = 'disposing', 摘 map
  const slot = entry.slot;
  await slot?.dispose(reason);  // worker 在这里才排空并发事件
  if (slot) this.ownedSlots.delete(slot);
}

// WorkerManager.ts:2414-2418
private retireEntry(entry: ManagedSlot): void {
  entry.acceptEvents = false;
  entry.state = 'disposing';

// WorkerManager.ts:2429-2430
if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return;
if (entry.state !== 'ready' || message.type !== 'runtime.event') return;
SCENARIO: 用户正在一个会话里等待一张权限卡（工具想写文件，卡片在屏上），同时在设置里保存了模型 / 服务商配置。src/main/ipc/piModels.ts:42 调 workerManager.invalidateAll() → disposeEntries([...所有 entry], 'slot-replace')（这条路径不检查 activeRequestId）→ 每个 entry 先被 retireEntry 关闸、再拆 worker → worker 排空权限门并发出 permission.resolved{autoReason:'session_closed'} → Main 丢弃。渲染层靠 permission.resolved 删卡（src/renderer/stores/chatSessions.ts:1178），卡片留在屏上；用户点它走 respondPermission，那时 entry 已不在 map 里，得到 session_not_ready。invalidateAll 本身也不发任何 session.status，所以这个会话既没有「已断开」提示、也没有终态事件。
FIX: 把关闸推迟到 worker 退出确认之后——retireAndDispose 先 await slot.dispose(reason) 再 retireEntry；或更小的改法：在 retireEntry 里保留一个「排空窗口」标志，让 handleWorkerEvent 在 disposing 期间仍放行 permission.resolved / question.resolved / preview 三类终态事件（它们本来就只是把卡片收掉）。另外给 invalidateAll 补一条与 evictForCapacity 同形的 session.status: disconnected，让渲染层解绑。
REFUTER(CONFIRMED,medium): 推不翻，顺序与两道闸都在当前代码里。WorkerManager.ts:2370-2378 `private async retireAndDispose(entry, reason) { this.retireEntry(entry); const slot = entry.slot; await slot?.dispose(reason); ... }`，disposeEntries（:2405-2412）同样是先 `for (const entry of unique) this.retireEntry(entry);` 再 dispose。retireEntry（:2414-2424）`entry.acceptEvents = false; entry.state = 'disposing';` 并从 entriesByKey / entriesBySession 摘除。handleWorkerEvent（:2428-2430）`if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return; if (entry.state !== 'ready' || message.type !== 'runtime.event') return;` —— 两道都必然不过。worker 侧确实是为排空专门排的序：piWorkerRpcServer.ts:928-935 注释「Setting it first dropped exactly the events those drains exist to deliver」，:947-960 handleDispose 先 `await release()`（runtime.dispose）再 `this.disposed = true`；nativeWorkerRuntime.ts:818-823 `this.permissions.drain('session_closed'); this.questions.drain('session_closed'); this.previews.drain('session_closed'); this.disposed = true;`，runtime/worker/permissionPrompt.ts:232-235 `drain: (reason) => { for (const [, settle] of [...pending]) settle('deny', reason); }` 经 :127-141 的 `options.emit({ type: 'permission.resolved', ... autoReason })` 发出。触发面比审查员写的更宽：invalidateAll（:1933-1939，只调 disposeEntries + updateManagerState，不发任何 session.status）被 src/main/ipc/piModels.ts:44、src/main/services/piPlugins/index.ts:123/131/139、src/main/services/auth/index.ts:70 调用。渲染层只在 session.status 的 disconnectReason === 'capacity_reclaimed' 时解绑（chatSessions.ts:858-860），permission.resolved 才是删卡的事件（:1177 起的 case），所以卡片会留屏；用户再点走 respondPermission（:1732-1738 `const entry = this.entriesBySession.get(input.sessionId); if (!entry?.slot) throw ... 'session_not_ready'`）必然报错。测试里没有钉住「retire 后丢事件」这一行为。严重级 medium。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md

### [utility-01] MEDIUM robustness confirmed | P6-2（产品消费者面） | src/main/services/agent-host/PiUtilityService.ts:119 | 一次性补全的冷启动用的是 10 秒「热请求」预算，而会话路径为同一件事专门配了 60 秒（静态推断）
DESC: utility.start 这一次 RPC 覆盖的是整段冷启动——utilityProcess.fork、开发态 --experimental-strip-types 加载 agent-host + runtime 模块图、createRuntime 建 Cordis 图与模型适配器、读一次 <agentDir>/settings.json——因为 piWorkerRpcServer.ts:621 是 await this.utilityRuntime.start(...) 之后才应答的。而这个 slot 的请求预算写死成 DEFAULT_REQUEST_TIMEOUT_MS = 10_000（:79、:119），:192 的 slot.request('utility.start', ...) 也没传 timeoutMs 覆盖。会话路径对同一类工作给的是 BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000，并把踩过的坑写进了注释。static_inference：确切耗时要在真实载体上测，本机未跑 Electron；但两条路径预算不对称本身是代码事实。
EVIDENCE: // src/main/services/agent-host/PiUtilityService.ts:79
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// :119
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
// :192
const acknowledgement = await slot.request('utility.start', {

// src/main/services/agent-host/createPiWorkerSlot.ts:41-57
 * `WorkerSlot`'s 10s default is sized for requests answered by a process that
 * is already up. `worker.bootstrap` is the opposite: it is the cold start ...
 * Reusing the warm budget here made a slow-but-healthy cold start indis-
 * tinguishable from a wedged worker ...
export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000;

// src/agent-host/piWorkerRpcServer.ts:621
this.respondSuccess(request, await this.utilityRuntime.start(request.payload));
SCENARIO: 加密 Windows 现场（或任何正在跑全量测试的开发机）上点「生成提交信息」。进程 fork + 模块图加载 + Cordis bootstrap 超过 10 秒，Main 在模型还没被调用之前就判 WORKER_RPC_TIMEOUT，complete() 抛 PI_UTILITY_TRANSPORT_FAILED，toast 显示 `Worker request utility.start timed out after 10000ms`。用户配置的 120 秒完全没派上用场，重试还是撞同一堵墙（每次都是全新冷启动，没有暖进程可复用）。
FIX: 给 utility.start 一个冷启动档预算：复用 BOOTSTRAP_REQUEST_TIMEOUT_MS 或在 PiUtilityService 定义同量级常量，在 :192 用 { timeoutMs: UTILITY_START_TIMEOUT_MS } 覆盖；WorkerSlot 的 requestTimeoutMs 保持 10 秒给 utility.cancel 这类热请求。补一条用例断言 start 与 cancel 的请求预算不同量级。
REFUTER(CONFIRMED,medium): 触发路径逐层核实成立。src/main/services/agent-host/PiUtilityService.ts:79 `const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;`，:119 `requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS`（默认 createSlot 里），:192 `const acknowledgement = await slot.request('utility.start', {` 确实没有第三个 timeoutMs 覆盖参数（sendRequest 的签名见 WorkerSlot.ts:395-411 `sendRequest(type, payload, timeoutOverride?, allowDisposing)`，:411 `const timeoutMs = positiveTimeout(timeoutOverride, this.requestTimeoutMs);`）。计时器在 postMessage 之前就起（WorkerSlot.ts:421-434 先 setTimeout 再 :443 `this.transport.postMessage(request)`），所以它覆盖的是整段冷启动。冷启动确实全在这次 RPC 里：PiWorkerProcess.ts:94-96 `utilityProcess.fork(entryPath, [], { ... execArgv: entryPath.endsWith('.ts') ? ['--experimental-strip-types'] : [] })`；piWorkerRpcServer.ts:611-621 首次 utility.start 才 `this.utilityRuntime = this.options.createUtilityRuntime(...)`，并 `this.respondSuccess(request, await this.utilityRuntime.start(request.payload));`；nativeUtility.ts:93 `const runtime = await this.runtime();` → :151-152 `const create = this.options.create ?? createRuntime; this.handle = await create({...})`，:113/:209 还要 `await runtime.hostIo.readFile(join(agentDir, 'settings.json'), ...)`。会话路径对同一类工作是 createPiWorkerSlot.ts:57 `export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000;`，其 :41-56 注释明写「10s 默认是给已经起来的进程用的」「复用热预算让慢但健康的冷启动看起来像卡死的 worker」。utility 槽位永远走不到那条 60 秒路径：piWorkerRpcServer.ts:604-608 明确禁止 `this.bootstrapPayload` 与 utility 共存。批次 A～C 未修：T016（a9ea7230）只给 reload/compact 补了 bootstrap 量级预算并给 utility.start 加了 modelCatalog，git log 显示 PiUtilityService.ts 最近一次改动即该提交，10_000 常量原样保留。测试也没钉住：PiUtilityService.test.ts:89 注入的假 slot 自带 `requestTimeoutMs: 100`，生产预算无覆盖。静态推断：真实冷启动耗时未在本机实测（开发机不跑 Electron），但两条路径预算不对称与 10 秒覆盖整段冷启动是代码事实。
WAIVER(none): 无 — (未找到)
合并：utility-07 并入本条（同一根因：src/main/services/agent-host/PiUtilityService.ts 的一次性补全通道只有一个 timeoutMs 常量在同时充当三件事的预算。utility-01 是「冷启动用了 10 秒热请求预算，而会话路径为同一件事配了 60 秒」（:119），utility-07 是「两端共用同一个 timeoutMs、没有先后余量，worker 侧那份永远轮不到」（:169）。两条都要靠同一张「utility 通道超时预算表」（冷启动 / 热请求 / Main 侧 / worker 侧，并保证严格不等式）来修，与 /compact 已有的 60s>45s 做法一致。保留 utility-01。）

### [utility-02] MEDIUM contract-gap confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:212 | 超时设置无上界，配到 600 秒以上会被 RPC 载荷守卫整条判非法，报错却说「缺 id / cwd / prompt」
DESC: 设置页的超时输入框是裸 <input type="number">，没有 min / max，也没有任何钳制；Number(v) || 60 只挡住 0 和非数字。该值以秒存，commit-message.ts:113 乘 1000 交给 PiUtilityService，Main 侧 positiveInteger 只校验「正安全整数」，于是 700 秒（700000 ms）一路畅通到 worker，被 isWorkerUtilityStartPayload 的 > 10 * 60_000 判假。错误文案把四个字段并列，指不到真凶。渲染层、Main、协议三层里只有最里面那层知道 10 分钟这个上界。反向形态：输入 -5 不被 `|| 60` 拦下（-5 为真值），Main 的 positiveInteger 抛裸 Error。
EVIDENCE: // src/renderer/components/settings/AISettings.tsx:209-218
{'timeout' in feature && (
  <SettingsRow>
    <span className="text-sm font-medium">{t('Timeout')}</span>
    <Input
      type="number"
      className="w-32"
      value={feature.timeout}
      onChange={(event) => setFeature(key, { timeout: Number(event.target.value) || 60 })}

// src/shared/types/workerRpc.ts:895-904
  if (
    !nonEmptyString(value.operationId) || !nonEmptyString(value.cwd) ||
    !nonEmptyString(value.prompt) || !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 10 * 60_000
  ) { return false; }

// src/agent-host/piWorkerRpcServer.ts:600
message: 'utility.start requires an operation id, cwd, prompt, and valid timeout',
SCENARIO: 用户觉得 120 秒不够（大 diff + 高 effort），在设置里把提交信息超时改成 900。此后每次点「生成提交信息」都立即失败，toast 描述是 `WORKER_INVALID_PAYLOAD: utility.start requires an operation id, cwd, prompt, and valid timeout`。用户没有任何线索指向自己刚改的那个数字，功能从此长期不可用。
FIX: 把 600 秒上界提到共享常量（与 workerRpc.ts 的 10 * 60_000 同源），在 AISettings 输入框加 min/max 并在 onChange 里钳制；同时在 PiUtilityService.complete 对越界值抛 PI_UTILITY_FAILED 并给出指名道姓的文案，不要让它跑到协议守卫上。补两条用例：越界值在 Main 侧被挡下、钳制后的设置值能通过载荷守卫。
REFUTER(CONFIRMED,medium): 三层链路逐段核对无误。渲染层 AISettings.tsx:208-221 是裸输入框：`<Input type="number" className="w-32" value={feature.timeout} onChange={(event) => setFeature(key, { timeout: Number(event.target.value) || 60 })} />`，无 min/max 也无钳制；类型注释确认单位是秒（stores/settings/types.ts:126 `timeout: number; // in seconds`），且只有 CommitMessageGeneratorSettings 有该字段，所以受害面是「生成提交信息」。传递层 CommitBox.tsx:48 `timeout: commitMessageGenerator.timeout` → ipc/git.ts:367-370 `generateCommitMessage({ ... timeout: options.timeout ... })`（无钳制）→ commit-message.ts:113 `timeoutMs: timeout * 1000`。Main 侧 PiUtilityService.ts:142 `positiveInteger(input.timeoutMs, 'Pi utility timeout')`，:81-83 只判 `!Number.isSafeInteger(value) || value < 1`，700000 通过。最内层 workerRpc.ts:895-904 `Number(value.timeoutMs) > 10 * 60_000` 判假，worker 回 piWorkerRpcServer.ts:598-600 `'utility.start requires an operation id, cwd, prompt, and valid timeout'`，WorkerSlot.ts:564 把它格式化成 `${code}: ${message}` 原样上浮。上界 600 秒只存在于协议守卫一处，渲染层与 Main 都不知道。反向形态同样成立：`Number('-5') || 60` 得 -5（-5 为真值），随后 positiveInteger 抛裸 Error 并被 commit-message.ts 的 catch 转成 error 文案。
WAIVER(none): 无 — (未找到)

### [utility-03] MEDIUM correctness confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:49 | 模型下拉在目录里查不到已存值时显示「自动」，却不回写，请求仍然带着那个旧模型
DESC: ModelField 的显示值是「存值在目录里找得到就用存值，否则显示 __automatic__」，但它只读不写——feature.model 里的旧值原封不动留着，下次点生成照样发出去。同一个表单里 EffortField 恰恰做了相反的事：useEffect 在 reconciled === 'default' 时主动 onChange(undefined) 把不被支持的档位回写掉。于是设置页显示「自动」、请求却带着一个引擎不认识的模型 ref，引擎按 runtime.model.list() 查不到就报 WORKER_MODEL_NOT_FOUND。注意 efforts.ts:186-193 已写明「目录没加载完时不能当作证据抹掉用户选择」，所以修法必须挂在「目录权威」这个条件上。
EVIDENCE: // src/renderer/components/settings/AISettings.tsx:49
const selected = value && models.some((model) => model.id === value) ? value : AUTOMATIC;

// 同一文件 :81-84（effort 的对照写法）
useEffect(() => {
  if (value && reconciled === 'default') onChange(undefined);
}, [onChange, reconciled, value]);

// src/runtime/worker/nativeUtility.ts:184-188
if (!runtime.model.list().some((item) => item.provider === ref.provider && item.id === ref.id))
  throw new NativeWorkerRuntimeError(
    'WORKER_MODEL_NOT_FOUND',
    `model is unavailable or has no configured authentication: ${requested}`
  );
SCENARIO: 用户把提交信息模型钉在 pilab/some-model，之后管理员在托管目录里下掉了这个模型（或用户删掉了自己那条服务）。设置页打开显示「自动」，看上去没问题；点「生成提交信息」却每次报 `WORKER_MODEL_NOT_FOUND: model is unavailable or has no configured authentication: pilab/some-model`。用户按界面所见无法理解错误，也没有明显动作能清掉这个存值。
FIX: 给 ModelField 加与 EffortField 同形的收敛：仅当目录 authoritative（usePiModelCatalog 已暴露该字段）且确认不含该 id 时回写 model: ''；或退一步，在选中项不在目录里时把触发器文案显示成「<id>（不可用）」而不是「自动」。补一条渲染层用例断言触发器文案与随请求发出的 model 一致。
REFUTER(CONFIRMED,medium): AISettings.tsx:49 `const selected = value && models.some((model) => model.id === value) ? value : AUTOMATIC;`，:56 `{models.find((model) => model.id === selected)?.label ?? t('Automatic')}` —— 存值不在目录里只改显示、不回写；:182-186 传的是 `value={feature.model ?? ''}`，而请求侧 CommitBox.tsx:50 `model: commitMessageGenerator.model` 发的仍是原存值，CodeReviewModal.tsx:307 甚至把这个陈旧 id 原样打印在标题 `({codeReviewSettings.model})` 里，与设置页的「自动」自相矛盾。对照写法就在同文件 :81-84 `useEffect(() => { if (value && reconciled === 'default') onChange(undefined); }, [onChange, reconciled, value]);`，effort 会主动收敛而 model 不会。下游后果链真实：nativeUtility.ts:182-188 `if (!runtime.model.list().some(...)) throw new NativeWorkerRuntimeError('WORKER_MODEL_NOT_FOUND', ...)`。再加一层放大：:212 `const { catalog } = usePiModelCatalog('ready'); const models = catalog?.models ?? [];`，这里传的是硬编码 'ready' 且完全没读 hook 暴露的 `authoritative`（usePiModelCatalog.ts:25-29 注释明写「只有它可以被当作关于模型的证据」），所以目录没拉到时也会整片显示「自动」。用户也难自救：选中项已是 AUTOMATIC，再点一次「自动」不会触发 onValueChange（值未变），清不掉存值。修法必须挂在 authoritative 上这一点与 efforts 模块的既有教训一致。
WAIVER(none): 无 — (未找到)

### [utility-06] MEDIUM correctness confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CodeReviewModal.tsx:319 | 超时或失败时错误块优先于内容渲染，已经流式显示了几分钟的评审正文被一行错误顶掉
DESC: 内容区是 displayError ? <错误行> : displayContent ? <Markdown> : ... 的三元链，错误排在最前。代码评审是这条链上唯一会长时间流式输出的功能（硬编码 10 分钟预算，code-review.ts:105），一旦在末尾超时或失败，整块已渲染正文立刻消失。正文其实还在 store 里，页脚的复制按钮也还挂着 displayContent && 的条件因此仍然可见——出现「屏幕上看不到内容，但复制按钮能把内容复制走」的自相矛盾状态。另外 worker 在取消时把已累计文本一并回传（nativeUtility.ts:290-296 的 text: active.text），Main 在 record.timedOut 分支里把它丢弃（PiUtilityService.ts:354-365 只取 error 不取 text），所以对不流式的两个功能而言，超时等于把已生成的一大半一起扔掉。
EVIDENCE: // src/renderer/components/source-control/CodeReviewModal.tsx:319-324
{displayError ? (
  <div className="flex items-center gap-2 text-destructive">
    <AlertCircle className="h-4 w-4" />
    <span>{displayError}</span>
  </div>
) : displayContent ? (

// 同文件 :377-378（页脚仍按内容显示复制按钮）
{displayContent && (
  <Button variant="outline" onClick={handleCopy}>

// src/runtime/worker/nativeUtility.ts:290-296（worker 确实把部分文本带了回来）
this.options.emitTerminal({ operationId: ..., state, text: active.text, model: active.model, ... });
SCENARIO: 大仓库的一次代码评审跑了 9 分 50 秒、正文已经渲染了一大半，10 分钟看门狗触发。面板正文整块被替换成一行 timeout，用户以为什么都没生成；点「重新评审」则从零开始，再花十分钟并很可能再次超时。
FIX: 错误与内容改为并存——有内容时把错误降级成正文上方或下方的一条横幅（保留「已生成部分」的措辞），只有 !displayContent 时才整块显示错误。顺带把 PiUtilityService.handleTerminal 在超时/取消分支里带回的 terminal.text 透给调用方（例如 PiUtilityServiceError 上挂 partialText），让提交信息和分支名也能用上半成品。
REFUTER(CONFIRMED,medium): 两段都成立。渲染侧 CodeReviewModal.tsx:319-332 是 `{displayError ? (<div ...><AlertCircle/><span>{displayError}</span></div>) : displayContent ? (<Markdown ...>{displayContent}</Markdown>)` 的三元链，错误优先；:202-204 `const displayContent = isCurrentRepo ? content : ''` / `const displayError = isCurrentRepo ? error : null`。正文确实还在 store 里：codeReview.ts:79 `store.updateReview({ status: 'error', error: event.data })` 只改 status 与 error，未碰 content（:37 updateReview 是浅合并），所以 :377-378 `{displayContent && (<Button ... onClick={handleCopy}>` 仍显示——「看不到内容但能复制内容」的矛盾状态可构造。长时流式这一点也对：code-review.ts:105 `timeoutMs: 10 * 60_000` 硬编码，是三个功能里唯一长跑 + 唯一走 onDelta 的。第二段同样属实：nativeUtility.ts:290-296 `this.options.emitTerminal({ operationId: ..., state, text: active.text, model: active.model, ...(error ? { error } : {}) })` 取消时带回已累计文本，而 PiUtilityService.ts:343-365 的 handleTerminal 只在 `terminal.state === 'completed'` 分支取 text，超时/取消分支构造 PiUtilityServiceError 时只用 code 与 error 串，terminal.text 被丢弃。相关文件近期提交（d949844c 修的是关闭后历史丢失与跨仓库忙保护）未触及这段渲染优先级；T029 在 roadmap.md:99 仍是批次 D 待派的只读审计项，本区域尚未被 A～C 覆盖。
WAIVER(none): 无 — (未找到)

### [session-index-02] MEDIUM correctness confirmed | P3-5 | src/main/services/agent-host/WorkerManager.ts:1569 | fork 未绑定会话时索引行漏写 unbound，fork 当场在界面上失败，重启后这一行被当孤儿丢掉（静态推断）
DESC: forkSession 把源会话的未绑定姿态带进了新 worker 的启动参数（WorkerManager.ts:1510，还写了长注释说明不能把 scratch 洗白成受信任），但交给 createForked 的索引行里没有 unbound 字段。同一服务的另一个独立创建入口（导入）是写的：LegacyImportService.ts:322-325 有 ...(unbound ? { unbound: true } : {}) 并挂 U05-c 注释，所以这是漏写不是取舍。unbound 的作用 sessionIndex.ts:37-53 写得很清楚：未绑定会话的 workspacePath 是 scratch 目录，永不匹配任何 ChatWorkspace，没有标记的行会被渲染层当孤儿丢掉。后果两条且都落到具体代码：当场——SessionTreeDialog.handleFork 调 materializeForkedChatSession，它按路径找工作区，找不到又没传 createWorkspaceIfMissing，return false（chatSessionActions.ts:156-175），对话框抛出用户可见错误行；重启后——mergeSessionIndex 走 if (!workspaceId) 分支把该行推进 orphans 并 continue（sessionIndexMerge.ts:171-185），而 orphaned 在生产里没有消费者。fork 入口对未绑定会话开放：MessageTimeline.tsx:614 的 Branches 按钮只看 hasDurablePiSession。测试恰好停在缺口前一格：WorkerManager.test.ts:1364-1375 的 [release-blocker] 用例只断言 createSlot 第二次调用带 unbound: true。
EVIDENCE: src/main/services/agent-host/WorkerManager.ts:1569-1579
          const indexed = await this.createForked({
            sessionId,
            runtimeIdentity: sessionFile,
            piLeaf: created.bootstrap.leaf,
            agent: PI_AGENT,
            workspacePath: source.cwd,
            title: `${input.sourceTitle || 'Session'} (fork)`,
            ...(input.model ? { model: input.model } : {}),
            updatedAt: this.now(),
            archived: false,
          });

同文件 :1506-1510（姿态是带了的）
          cwd: source.cwd,
          // A fork shares its source's directory, so it must share its trust posture too
          unbound: source.unbound,

src/renderer/stores/chatSessionActions.ts:156-175
  let workspace = state.workspaces.find((item) => pathsEqual(item.path, entry.workspacePath));
  if (!workspace && options?.createWorkspaceIfMissing) { … }
  if (!workspace) return false;
SCENARIO: 用户新建一个不绑定文件夹的聊天（U05 未绑定会话，cwd 是 scratch 目录），聊几轮后点 Branches → Fork。Main 侧一路成功：fork 的 JSONL 写好、新 worker 起来、索引写入一行（无 unbound）。渲染层找不到工作区 → 对话框红字「Fork was created, but its workspace could not be materialized in this window」，fork 打不开。重启后 scratch 根按 U05-a 被整体清空，该行既无 unbound 也无匹配工作区 → 被 mergeSessionIndex 静默丢弃，侧栏再也看不到它。
FIX: 在 createForked 的入参里补 ...(source.unbound ? { unbound: true } : {})，与 LegacyImportService.ts:322-325 对齐（绑定会话必须继续不写这个键）。把 WorkerManager.test.ts:1364 那条用例扩成两条断言：createSlot 带 unbound: true，并且 createForked 收到的行带 unbound: true。另建议复核 SessionTreeDialog.handleFork 的错误提示——fork 已落盘却只报「未能材料化」且无补救入口。
REFUTER(CONFIRMED,medium): 静态推断，链路逐环复核成立。WorkerManager.ts:1569-1579 的 createForked 入参原文确无 unbound：`{ sessionId, runtimeIdentity: sessionFile, piLeaf: created.bootstrap.leaf, agent: PI_AGENT, workspacePath: source.cwd, title: …, ...(input.model ? { model: input.model } : {}), updatedAt: this.now(), archived: false }`，而同一函数 :1510 明确写了 `unbound: source.unbound`（ManagedSlot.unbound 在 :129 是必填 boolean），证明姿态本身是知道的。对照入口 LegacyImportService.ts（实际路径 src/main/services/legacyImport/LegacyImportService.ts）:322-325 有 `...(unbound ? { unbound: true } : {})` 并挂 U05-c 注释，确是漏写而非取舍。IPC 侧不补：chat.ts:704-718 的 CHAT_FORK_SESSION 只转发 sourceSessionId/entryId/title/model，不碰索引。后果两条都核到实码：当场——SessionTreeDialog.tsx:132 `if (!materializeForkedChatSession(result.session)) throw new Error(t('Fork was created, but its workspace could not be materialized in this window'))`，而 chatSessionActions.ts:206 `export const materializeForkedChatSession = materializeIndexedPiChatSession`，:155-175 里 `let workspace = state.workspaces.find((item) => pathsEqual(item.path, entry.workspacePath)); … if (!workspace) return false;`（对话框没传 createWorkspaceIfMissing），scratch 路径在 store 里没有对应 workspace——sessionIndexMerge.ts:151-166 对未绑定行走的是 `workspaceId: ''` 的专用分支，根本不造工作区；重启后——同文件 :170-185 `if (!workspaceId) { orphans.push(…); continue; }`。我另外试着从 store 侧反驳：chatSessions.ts:704-730 的 session.created 只对已有 sessions 做 map，不会凭事件新建行，所以材料化失败后该会话在渲染层确实不存在。fork 入口对未绑定会话开放也成立（MessageTimeline.tsx:265-271 hasDurablePiSession 只看 `session.runtimeIdentity != null`，:614 据此渲染 Branches）。测试缺口属实：WorkerManager.test.ts:1364-1375 只断言 `h.createSlot.mock.calls[1][0]` 带 unbound: true，全文件无一处断言 createForked 收到的行。
WAIVER(none): 无 — 全库检索无命中

### [session-index-05] MEDIUM correctness confirmed | P3-5 | src/main/services/chat/SessionIndexService.ts:331 | setArchived 等三处写失败不回滚内存，而 flush 写整张表，报错过的修改会被后面任何一次无关写入悄悄落盘
DESC: 这个类有两种写法：commitResumed、commitPiLeaf、removeImported、bindRuntimeIdentity、clearUnwrittenRuntimeIdentity、rename、createIndependent 都是「改内存 → try flush → catch 塞回旧值」；而 setArchived(:331)、recordCreated(:113)、applyRuntimeEvent 的三条分支(:379、:389、:396) 只有裸 await this.flush()。关键在于 flush() 写的是整张表而不是增量，所以「不回滚」不等于「这次改动没生效」，而等于「进了内存没进盘，并会搭下一次成功的写一起进盘」——调用方已经收到异常、用户已经看到失败提示，然后它自己生效了。commitResumed 的文档注释(:117-121)把回滚说成这个类的性质，实现只做到六分之三。
EVIDENCE: src/main/services/chat/SessionIndexService.ts:325-334
  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      this.entries.set(sessionId, { ...existing, archived, updatedAt: now() });
      await this.flush();
      return true;
    });
  }

对照同文件 :309-323 的正确形态
      this.entries.set(sessionId, { ...existing, title, updatedAt: now() });
      try { await this.flush(); } catch (error) { this.entries.set(sessionId, existing); throw error; }
SCENARIO: 磁盘写满（或 Windows 上索引文件被杀软/备份工具短暂占用，rename 抛 EPERM）。用户点归档 → setArchived 改内存 → flush 抛错 → IPC 报错，界面提示归档失败，会话仍在侧栏。几分钟后磁盘腾出空间，用户在另一个会话里发一句话，回合结束触发 session.completed → applyRuntimeEvent → flush() 把整张表写盘，其中包含那条 archived: true。下次刷新或重启时第一个会话从侧栏消失——用户从没成功归档过它，也没有任何提示。
FIX: 把 setArchived、recordCreated、applyRuntimeEvent 三条分支统一成其余方法的 try/catch 回滚形态；更彻底的是抽一个私有 helper（mutateAndFlush），让「改内存+落盘+失败复原」只有一份实现。补一条用例：注入只在第 N 次失败的 writeAtomically，断言失败后 get() 读回旧值，且后续一次成功的无关写入不会把失败那次带上盘。
REFUTER(CONFIRMED,medium): 代码分布与审查员所述一致，推翻失败。SessionIndexService.ts:325-333 setArchived 原文 `this.entries.set(sessionId, { ...existing, archived, updatedAt: now() }); await this.flush(); return true;`——裸 await，无 try/catch；同样裸写的还有 recordCreated(:98-113)、applyRuntimeEvent 的 session.created(:373-379)、session.updated(:384-389)、三个终态分支(:395-396)。对照回滚形态确实存在于 rename(:314-320)、commitResumed(:149-155)、commitPiLeaf(:175-185)、removeImported(:216-222)、createIndependent(:242-249)、bindRuntimeIdentity(:266-272)、clearUnwrittenRuntimeIdentity(:297-304)，其中 commitResumed 的注释(:117-121)把回滚说成类的性质（『rolls back memory if the atomic flush fails』），实现只做到一半。危害机制也成立：flush(:442-447) 写 `[...this.entries.values()]` 整表，所以一次报过错的内存改动会被后续任何一次成功写入捎带落盘。最有力的旁证是测试自己承认这个模型：__tests__/SessionIndexService.test.ts:59 的用例名就是 'rolls back a failed binding before a queued mutation can persist it'，即『不回滚 = 被下一次排队写入落盘』是本仓已确认的行为，只是这条用例覆盖 bindRuntimeIdentity，setArchived 无对应用例。严重级取 medium：用户看到归档失败提示、会话仍在侧栏，随后该行悄悄生效并让会话消失，属用户可见的错误行为，未触及安全或整表损坏。
WAIVER(none): 无 — 全库检索无命中

### [import-up-01] MEDIUM robustness confirmed-partial-waiver | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:89 | 一个读不动的子目录（或超过 1 万个文件）会让整份 Codex 历史从导入列表里静默消失（静态推断）
DESC: CodexSessionScanner.scan() 对单个文件的失败做了隔离（:113-120 的 try/catch，注释写明「一个损坏的会话不应遮住合法的兄弟」），但对目录遍历本身没有。walk 里的 readdir 一旦抛非 ENOENT 的错（EACCES/EPERM/ENOTDIR/ELOOP），异常沿递归穿到 :123-127 的外层 try，那里只放行 ENOENT，其余原样重抛。`++inspectedFiles > 10_000` 这条上限（:94）走同一条路——不是「只看前一万个」，而是「超过一万个就整个失败」。异常出去后被 scanAllLegacySources 的空 catch 吞掉（LegacyImportSources.ts:100-102），于是用户看到的是 Claude 项目正常、Codex 一个项目都没有、且无任何提示。口径上与全仓不一致：T010（1262e3b0）定的遍历容错集合是 ['ENOENT','ENOTDIR','EACCES','EPERM','EISDIR','ELOOP'] 按跳过处理（src/runtime/plugins/tools/index.ts:53、skills/index.ts:72），Claude 扫描器也已是每层各自降级。需说明「根目录失败要传播」是有意设计并有用例（CodexSessionScanner.test.ts:90）；本条说的是根之下的子目录——Codex sessions 按日期分层（walk 允许 depth<3），坏的是其中一天，代价却是全部。静态推断，未执行验证。
EVIDENCE: src/main/services/legacyImport/CodexSessionScanner.ts:88-128
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });   // :89 非 ENOENT 直接向上抛
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(path, depth + 1); // :92 递归也向上抛
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (++inspectedFiles > 10_000) throw new Error('Codex scan exceeds session limit'); // :94
        try { const source = await readCodexSessionSource(path); ... }
        catch (error) { console.warn('[CodexSessionScanner] Skipped unreadable session', ...); } // :116 只隔离单文件
      }
    };
    try { await walk(this.resolveRoot(), 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }      // :126

src/main/services/legacyImport/LegacyImportSources.ts:94-103
  for (const importer of importers) {
    try { const result = await importer.scan(); ... }
    catch { /* A bad source does not hide other sources from the import picker. */ }
  }

src/runtime/plugins/tools/index.ts:53  —— T010 定下的全仓口径
const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);
SCENARIO: 用户某次用 sudo 跑过一回 codex，~/.codex/sessions/2026/09/12/ 这一天的目录归 root、权限 700。之后打开「设置 · 从 Claude Code / Codex 导入历史对话」：readdir 那一天抛 EACCES → walk 抛 → scan 抛 → scanAllLegacySources 静默吞掉 → 面板里只剩 Claude 项目，Codex 的全部会话（包括其它几百天完全可读的）一条都不出现，界面上没有任何错误提示。第二个触发路径：会话数超过 10 000 时同样是「一条都没有」，而不是「只列前一万条」。
FIX: 把 walk 的目录级失败按 T010 的 OPTIONAL_FILE_ERRORS 集合处理：readdir 包 try/catch，命中集合就跳过该目录并 console.warn 一条诊断，其余照抛；可只对 depth>0 的子目录降级，这样 CodexSessionScanner.test.ts:90 那条「根目录其它错误要传播」的用例仍成立。inspectedFiles 上限改为「达到上限就停止遍历并返回已收集结果 + 一条诊断」，不再 throw。补两条用例：子目录 EACCES 时其它日期的会话仍被列出；文件数超限时返回上限条数而不是空。
REFUTER(CONFIRMED-PARTIAL-WAIVER,medium): 复核成立，未被批次 A～C 修掉（git log -- src/main/services/legacyImport/ 最近一次改动是 T008 的 36389d1d / 23ac5df5，未触及 walk）。CodexSessionScanner.ts:88-121 的 for 循环里，`if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);`（:92）与 `if (++inspectedFiles > 10_000) throw new Error('Codex scan exceeds session limit');`（:94）都在 `try {`（:95）之前，try 只包住 :96 的 readCodexSessionSource 那一段；:113-120 的 catch 注释 'A corrupt session does not hide valid siblings. Root/directory failures propagate to the per-source scan isolation boundary.' 也明确承认目录级失败是往上抛的。外层 :123-127 `catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }` 只放行 ENOENT。抛出后被 LegacyImportSources.ts:100-102 的空 catch（注释 'A bad source does not hide other sources from the import picker.'）吞掉，listProjects（LegacyImportService.ts:163-166）于是只剩 Claude 项目、无任何提示。深度可达性我逐层验过：walk(root,0)→年(1)→月(2)→日(3)，日目录的 readdir 在 depth=3 执行，所以坏掉一天就废掉全部。口径不一致属实：src/runtime/plugins/tools/index.ts:53 与 skills/index.ts:72 的 OPTIONAL_FILE_ERRORS = ['ENOENT','ENOTDIR','EACCES','EPERM','EISDIR','ELOOP'] 按跳过处理；ClaudeSessionScanner.ts:76-89（listRootProjectIds）与 :91-102（listRootSessionFiles）都是每层各自 console.error + return []，不向上抛。现有测试只钉住根目录：CodexSessionScanner.test.ts:90-94 只覆盖「缺失根返回空 / 根是文件时抛错」，没有任何子目录不可读的用例。属静态推断，未执行验证。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/topics/p5-4-p5-5-import-and-catalog.md:72；原文：「扫描与转写侧（`ClaudeSessionScanner` / `*SourceAdapter`）与后端无关，不动。」

### [import-up-02] MEDIUM correctness confirmed-partial-waiver | P5-4 上游 / H/21 C2·C4 | src/main/services/legacyImport/CodexRollout.ts:35 | 以「<」开头的真实用户消息被当成合成注入整条丢弃，整段会话可能因此从导入列表里消失（静态推断）
DESC: isSyntheticCodexUserText 用三条前缀判断一条用户消息是不是 Codex 注入的仓库说明/环境上下文，其中第一条是 text.startsWith('<')。命中就在 :127 直接 continue——该条目不进 entries，也不写 diagnostics，用户在导入后的转录里完全看不到自己说过这句话。「<」是非常容易被真实内容命中的前缀：贴 HTML/XML/JSX、贴 <<<<<<< HEAD 冲突标记、或问「<Foo /> 为什么不渲染」，都会以 < 开头。Claude 侧同一件事是精确做的——stripSystemTags（ClaudeSourceAdapter.ts:100-109）按六个具名标签成对剥离，剥完还剩正文就照常保留，两边口径不对称。影响不止少一条消息：CodexSessionScanner.scan() 用「至少一条 user 且至少一条 assistant」作为会话是否值得列出的门槛（:97-101），CodexSourceAdapter.read 又用第一条 user 条目的前 120 字做标题（CodexSourceAdapter.ts:32）。首条用户消息以 < 开头 → 标题变成后面某一句；所有用户消息都以 < 开头 → 整个会话在导入面板里根本不出现。静态推断，未执行验证。
EVIDENCE: src/main/services/legacyImport/CodexRollout.ts:33-36
/** Injected repo instructions / environment context, not something the user typed. */
function isSyntheticCodexUserText(text: string): boolean {
  return text.startsWith('<') || text.startsWith('# AGENTS.md') || text.startsWith('You are Codex');
}

src/main/services/legacyImport/CodexRollout.ts:121-131
    if (type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text = readCodexTextContent(payload.content, '\n');
      if (payload.role === 'user' && isSyntheticCodexUserText(text)) continue;   // :127 无诊断，直接丢

src/main/services/legacyImport/CodexSessionScanner.ts:97-101 —— 没有 user 条目就不列出来
          const user = source.rollout.entries.find((item) => item.kind === 'user');
          if (
            user?.kind === 'user' &&
            source.rollout.entries.some((item) => item.kind === 'assistant')
          ) {
SCENARIO: 用户在 Codex 里贴了一段组件代码求助，消息正文是 `<Dialog open={open}>…`，随后十几轮里每次贴代码也都以 < 开头。导入这条会话时：这些用户消息被静默丢弃，转录里只剩 Codex 的回复，看起来像模型在自言自语；如果该会话的用户消息全部以 < 开头，scan() 的门槛直接把它判为「没有用户消息」，它在导入面板里压根不出现，用户无从得知为什么少了一条会话。
FIX: 把判据收窄成「整条消息是一个闭合的注入标签块」而不是「以 < 开头」：按 Codex 实际注入的标签名做具名匹配（需用仓库已有 fixture src/agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl 核定真实标签），或复用 Claude 侧 stripSystemTags 的「剥掉已知标签后还剩正文就保留」策略。被丢掉的条目应写一条 diagnostics。补两条用例：以 <div> 开头的真实用户消息必须保留；只含注入块的消息仍被丢弃并计入诊断。
REFUTER(CONFIRMED-PARTIAL-WAIVER,medium): 复核成立。CodexRollout.ts:33-36 原文 `function isSyntheticCodexUserText(text: string): boolean { return text.startsWith('<') || text.startsWith('# AGENTS.md') || text.startsWith('You are Codex'); }`；:127 `if (payload.role === 'user' && isSyntheticCodexUserText(text)) continue;` 在 :128-131 的 diagnose 分支之前，确实是既不入 entries 也不写诊断的静默丢弃。连锁后果两条我都核到了原文：CodexSessionScanner.ts:97-101 以「有 user 且有 assistant」作为是否列入扫描结果的门槛，CodexSourceAdapter.ts:32 `title: first?.kind === 'user' ? first.text.slice(0, 120) : 'Imported Codex session'` 用首条 user 做标题。对称性问题也属实：Claude 侧 ClaudeSourceAdapter.ts:100-109 的 stripSystemTags 是按 local-command-caveat / command-message / command-name / command-args / local-command-stdout / system-reminder 六个具名标签成对剥离，:462-463 剥完仍有正文就保留，粒度比「以 < 开头就整条丢」精细得多。测试未钉住：CodexRollout.test.ts:75-98 只覆盖 '# AGENTS.md instructions for this repo' 这一条被过滤，没有任何针对 '<' 前缀的用例（正反都没有）；fixture codex-rollout-redacted.jsonl 里唯一一条 user 文本是 "[redacted]"，也证不了真实注入标签名。属静态推断，未执行验证。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/topics/conversation-import.md:33；原文：「合成注入文本 | **丢弃**。user 文本以 `<` 开头；Codex 另加 `# AGENTS.md`、`You are Codex` 开头」

### [import-up-03] MEDIUM perf confirmed | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:132 | 导入一条 Codex 会话要把整个 ~/.codex/sessions 重扫重解析一遍，批量导入 N 条就是 N 遍（静态推断）
DESC: CodexSessionScanner.resolveSessionSource 的第一行是 await this.scan()，而 scan() 不是「列目录拿元数据」：它对每一个 .jsonl 都调 readCodexSessionSource——申请 size+1 字节缓冲整份读入、两次 stat、算两个 sha256，然后 parseCodexRollout 把每行 JSON.parse 并转成完整的 ImportedConversationEntry[]（:31-77、:95-96）。拿到全量结果后只做一次 filter，再对选中的那个文件再读一遍（:136）。调用方把这条重活儿排成乘法：listProjects() 一次全量 scan；listSessions(projectId,'codex') 又一次（LegacyImportSources.ts:53）；importBatch 里每一条 source 走 importOne→convert→adapter.read→resolveSessionSource 又各一次，而且 LegacyImportService.ts:209-211 是串行 for 循环。LEGACY_IMPORT_MAX_BATCH 是 100，单文件上限 64 MiB，文件数上限 10 000，且这些都发生在 Main 进程里、JSON.parse 是同步的。静态推断，未实测耗时（开发机 2 核/3.3GB 且规则禁止跑应用）。
EVIDENCE: src/main/services/legacyImport/CodexSessionScanner.ts:131-140
  async resolveSessionSource(projectId: string, sessionId: string): Promise<CodexSessionSource> {
    const matches = (await this.scan()).filter(                      // :132 全量重扫
      (item) => item.projectId === projectId && item.sessionId === sessionId
    );
    if (matches.length !== 1) throw new Error('Codex session is missing or ambiguous');
    const source = await readCodexSessionSource(matches[0].filePath); // :136 再读一遍选中的那个

src/main/services/legacyImport/CodexSessionScanner.ts:95-96 —— scan 对每个文件都做完整解析
          const source = await readCodexSessionSource(path);
          const user = source.rollout.entries.find((item) => item.kind === 'user');

src/main/services/legacyImport/LegacyImportService.ts:208-211 —— 串行，每条各自重扫
    const results: LegacyImportItemResult[] = [];
    for (const source of unique.values()) {
      results.push(await this.importOne(source));
    }
SCENARIO: 一个用了半年 Codex 的用户，~/.codex/sessions 下有 300 份 rollout 合计几百 MB。他在导入面板里勾选 40 条一起导入：面板打开时扫 1 遍（300 份全解析），进项目时扫第 2 遍，点导入后每条各扫 1 遍 → 共 42 遍 × 300 份 = 12 600 次「整份读入 + 两次 sha256 + 逐行 JSON.parse」，全部在 Main 进程同步解析。用户看到界面长时间无响应且没有进度反馈。
FIX: 让 scan() 与 resolveSessionSource 分层：扫描只收集「文件路径 + stat + 头部若干行足够拿到 session_meta 与首条用户消息」的轻量摘要，不做全量 parseCodexRollout、不算 contentHash；resolveSessionSource 按 projectId/sessionId 定位到文件后再做一次完整解析。另外在一次 importBatch 内复用同一份扫描结果。必须保留现有安全性质：路径只能来自扫描结果而非客户端拼接，:137-138 的「重读结果与请求身份一致」校验不能去掉。
REFUTER(CONFIRMED,medium): 复核成立，且乘法链条比描述更确定。CodexSessionScanner.ts:131-134 `const matches = (await this.scan()).filter(...)`，而 scan() 在 :95-96 对每个 .jsonl 都调 readCodexSessionSource——该函数 :40 `Buffer.alloc(before.size + 1)` 整份读入、:34 与 :47 两次 stat、:65-68 两次 createHash('sha256')、:58 parseCodexRollout 逐行 JSON.parse 并生成完整 entries（CodexRollout.ts:66-189）。命中后 :136 又对选中文件重读一次。调用方确实把它排成乘法：LegacyImportService.ts:163-166 listProjects → scanAllLegacySources → codexSourceImporter.scan()（LegacyImportSources.ts:53 `const summaries = await scanner.scan()`）一遍；:168-175 listSessions 的 `importer.scan(projectId)` 又一遍；:208-211 `for (const source of unique.values()) { results.push(await this.importOne(source)); }` 是串行，每条经 importOne→convert→CodexSourceAdapter.read:17→resolveSessionSource→scan() 再各一遍，此外 assertUnchanged（CodexSourceAdapter.ts:43-44）还会再 readCodexSessionSource 一次。CodexSessionScanner 构造器只接受 resolveRoot（:80-83），无任何缓存；LegacyImportService 的 this.flights 只对并发同键去重，对串行循环无用。上限口径也核对过：LEGACY_IMPORT_MAX_BATCH = 100、LEGACY_IMPORT_MAX_SOURCE_BYTES = 64 MiB、扫描文件上限 10 000（shared/types/legacyImport.ts:6-12、CodexSessionScanner.ts:94），且全部在 Main 进程同步 JSON.parse。属静态推断，未实测耗时。严重级我按 medium：是可感知的卡顿与重复 I/O，不是不可恢复的卡死。
WAIVER(none): 无 — 全文档检索无命中

### [terminal-01] MEDIUM robustness confirmed | H/20 Main 半边 | src/main/services/terminal/PiTuiPty.ts:333 | kill 发出即当成功：不等进程退出、不校验、失败被吞（静态推断）
DESC: #disposeNow 先把终端从 #live 删掉再 try/catch 调 pty.kill()，catch 里只有一句「Process may already have exited」。于是三件事同时成立：kill 抛错被吞、控制器照样发 dead 状态且 disposeSession 照样把它当「已杀」返回；因为条目已删，pty.onExit 回调开头的 active 检查直接 return，Main 的 onExit（piTui.ts:64，负责释放 guard 与通知渲染层）永不触发；整条链路没有一步等待进程真正退出。releaseSessionForHostPrompt 因此在「信号已发出」而非「另一个写者已死」的时刻返回 true，紧接着就去重读文件。unix 上 node-pty 的 kill 是 process.kill(pid,'SIGHUP')（unixTerminal.js:228），只发给 pi CLI 自己、不发进程组，也不升级 SIGKILL。static_inference：kill 失败与「信号送达到进程终止之间还能再追加一行」两种形态都需真机（尤其 Windows conpty）才能观察，本轮无执行证据；已确证的部分是 pi 用 appendFileSync 落盘、不存在未 flush 缓冲。
EVIDENCE: #disposeNow(terminalId: string): void {
  const live = this.#live.get(terminalId);
  if (!live) return;
  this.#live.delete(terminalId);
  try {
    live.pty.kill();
  } catch {
    // Process may already have exited.
  }
  this.#emitState(terminalId, 'dead');
}
// piTui.ts:188 —— 杀完立刻返回，返回值直接决定要不要重读
const results = await Promise.allSettled([...controllers.values()].map((c) => c.disposeSession(sessionFile)));
sessionGuard.release(sessionFile);
SCENARIO: 用户在 TUI 里发起一轮回答，流式输出进行中切回 GUI（openGui 只 suspend，pi 进程继续跑、继续 appendFileSync），再在 GUI 里发一条消息：handOverFromTui → disposeSession 发出 SIGHUP 即返回 → guard 释放 → 闸门放行 → reloadSession 走 IPC 到 worker 重读（几十毫秒）。若 pi 在信号真正生效前又追加一条 entry，worker 拿到的仍是旧 seq，下一次 GUI 追加就是 session-01 那类「按陈旧 seq 写入」的形态。Windows 上 WindowsTerminal.kill 走 conpty agent，失败同样被这里的 catch 吞掉，届时 GUI 与一个仍活着的 CLI 同写一个 JSONL。
FIX: 把 #disposeNow 改成可等待：kill 后等 onExit（或轮询 pid）带超时，超时升级信号（unix SIGKILL，Windows 走 killProcessTree 的 taskkill /T /F），让 disposeSession 返回「确认已退出 / 超时未确认」两种结果；未确认时 releaseSessionForHostPrompt 不释放 guard，由 assertHostPromptAllowed 把这次 GUI 写入挡下（这正是 cutover-04 那道闸门的意义）。kill 抛出的异常至少 console.warn，不与「进程早已退出」混为一谈。
REFUTER(CONFIRMED,medium): 代码事实成立（静态推断）。src/main/services/terminal/PiTuiPty.ts:333-343 `#disposeNow` 原文：`const live=this.#live.get(terminalId); if(!live) return; this.#live.delete(terminalId); try{live.pty.kill();}catch{/* Process may already have exited. */} this.#emitState(terminalId,'dead');` —— 先删条目再发信号，全链无一处等待进程真正退出；因条目已删，PiTuiPty.ts:238-240 `pty.onExit` 的 `if(!active||active.pty!==pty||...) return;` 使 piTui.ts:64 的 onExit（释放 guard、通知渲染层）确实永不触发。src/main/ipc/piTui.ts:188-195 `releaseSessionForHostPrompt` 在 `Promise.allSettled(...disposeSession...)` 之后立刻 `sessionGuard.release(sessionFile)` 并返回，chat.ts:141 随即 `reloadSessionFromDisk`，所以「信号已发出」即被当成「另一个写者已死」。我额外查到两条加重证据：(1) node_modules/node-pty/lib/unixTerminal.js:226-231 `UnixTerminal.prototype.kill = function(signal){ try{ process.kill(this.pid, signal||'SIGHUP'); } catch(e){ /* swallow */ } }` —— 只发单 pid、不发进程组、不升级 SIGKILL，且异常在 node-pty 内部就被吞掉（故审查员说的「kill 抛错被这里 catch 吞」在 unix 上其实到不了本仓的 catch，只有 Windows 的 `_deferNoArgs` 路径才可能抛）；(2) pi CLI bundle（node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OMWWHBTG.js）里注册了 SIGHUP 处理器：`let signals=["SIGTERM"]; process.platform!=="win32"&&signals.push("SIGHUP"); ... handler=()=>{killTrackedDetachedChildren(),disposeRuntime().finally(()=>{process.exit(signal==="SIGHUP"?129:143)})}` —— 即 SIGHUP 不是内核即刻终止，而是走一段异步 shutdown，进程存活窗口远大于「信号=立即死」，期间同一 chunk 里的 `appendFileSync3(this.sessionFile, ...)` 仍可追加（确认是同步追加、无缓冲）。git log -- PiTuiPty.ts 只有 T036/T025 等退役类提交，批次 A~C 未碰 `#disposeNow`；T003(0332214c) 只加了 tuiWrittenSessions/闸门，roadmap.md:57 自述「真机 GUI→TUI→GUI 一圈留到批次 E」。测试 PiTuiPty.test.ts 用假 PTY，没有任何一条钉住「等待真实退出」。未观测到的只有「信号后确实追加了一行」这一形态，故按 static_inference 判 confirmed；若真发生，后果是 session-01 那类会话写坏，严重级可被上调至 high。
WAIVER(none): 无取舍 — 核对来源：raw/terminal-tui.md（本发现的原始出处，非取舍文档）；roadmap.md T029 行；相关原文：「kill 抛错被吞、不等退出、不复验，而整条非对称保护的正确性建立在「它真的死了」上（terminal-01）」

### [terminal-03] MEDIUM correctness confirmed | GUI A/2 代码侧 | src/renderer/components/chat/usePresentationSwitch.ts:96 | 终端 id 是应用级的：TUI 模式下切换会话，终端仍绑在上一个会话的 JSONL 上（静态推断）
DESC: tuiTerminalId 由 setTuiTerminalId((current) => current ?? 'pi-tui-'+uuid) 生成，只在工作区路径变化时才清掉（usePresentationSwitch.ts:222-229），不随 activeSessionId 变。ChatWorkspace.tsx:214 用这个 id 渲染 AgentTerminal、sessionFile 取当前会话的 runtimeIdentity；而 useXterm 的初始化 effect 依赖数组里只有 piTuiTerminalId、没有 piTuiSessionFile，所以 sessionFile 变了不会重新 open。即使重新 open，Main 的 #openExclusive 「已存在则恢复」分支也完全忽略请求里的 sessionFile。同时 TUI 模式下侧栏与 SessionBar（含 New chat 按钮）照常渲染。static_inference：链路是读源码推出来的，需起 Electron 点两下坐实。
EVIDENCE: const start = () => {
  setPresentationMode('tui');
  setTuiTerminalId((current) => current ?? `pi-tui-${crypto.randomUUID()}`);
};
// PiTuiPty.ts:186 —— 恢复分支不看 sessionFile
const current = this.#live.get(request.terminalId);
if (current) {
  current.suspended = false;
  ...
  return { terminalId: request.terminalId, generation: current.generation, resumed: true };
}
SCENARIO: 在会话 A 打开 TUI（终端跑 pi --session A.jsonl）→ 不离开终端模式，在侧栏点会话 B（同一仓库目录，工作区路径不变）→ 界面标题与会话栏都变成 B，终端画面仍是 A 的 pi 会话，用户接着敲的所有内容写进 A 的 JSONL。文件不会写坏（回到 A 发消息时 tuiWrittenSessions 仍记着 A，会触发重读），但「我以为在 B 里对话、内容却进了 A」是用户可见的错误行为。TUI 模式下可点的 New chat 按钮走同一路径。
FIX: 让终端身份带上会话身份：把 tuiTerminalId 改成按 activeSessionId 记的映射（Map<sessionId, terminalId>），切会话时换 id（useXterm 依赖 piTuiTerminalId，换 id 天然触发重建，Main 的容量上限会挂起/淘汰旧的）；或在 #openExclusive 恢复分支比较 live.sessionKey 与请求的 sessionFile，不一致就拒绝恢复。两者都要配一条「TUI 模式下切会话」的用例。
REFUTER(CONFIRMED,medium): 四段链路逐段核实，全部成立。(1) src/renderer/components/chat/usePresentationSwitch.ts:93-96 `setTuiTerminalId((current)=>current ?? \`pi-tui-${crypto.randomUUID()}\`)`，只有 221-229 的工作区路径变化 effect 会把它清空，依赖数组是 `[activeWorkspacePath]`，与 activeSessionId 无关。(2) src/renderer/components/chat/ChatWorkspace.tsx:211-225 用 `id={tuiTerminalId}`、`{...(activeSession?.runtimeIdentity?{sessionFile:activeSession.runtimeIdentity}:{})}` 渲染 AgentTerminal，没有 key，同工作区切会话不会重建。(3) AgentTerminal.tsx:88-89 把它转成 `piTuiSessionFile`，而 src/renderer/hooks/useXterm.ts 初始化 effect 的依赖数组（824-836）是 `[piTuiTerminalId, backendSessionId, cwd, command, shellConfig, commandKey, terminalRenderer, kind, persistOnDisconnect, write]`，确无 piTuiSessionFile，sessionFile 变了不会重开。(4) 即便重开，PiTuiPty.ts:186-201 的恢复分支 `const current=this.#live.get(request.terminalId); if(current){ current.suspended=false; ... return {..., resumed:true}; }` 完全不看 `request.sessionFile`。TUI 模式下侧栏与 SessionBar 也照常可点：WorkspaceShell.tsx:211-221 只用 isTui 调整栏位（`chatVisible = isTui ? true : chrome.chatVisible`），未禁用会话切换；SessionBar.tsx:138-146 的 New chat 按钮无 isTui 判断。无任何测试覆盖「TUI 模式下切会话」。后果是用户可见的错误行为（以为在 B 里对话、内容进 A），不构成文件损坏，判 medium。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/gui-tui-session-interop.md（H/20 互通计划全文）；相关原文：「并发仍靠锁挡，不靠格式。`PiTuiExclusiveGuard` 与 `writerLock.ts` 的既有边界不变：TUI 持有会话时 GUI 发送路径必须先释放。」

### [terminal-08] MEDIUM correctness confirmed | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:327 | 自定义 shell 推参用子串匹配，/bin/sh 被判成 PowerShell
DESC: inferExecArgs 拿 shell 文件名与所有 shell 定义的 paths 做 includes 子串匹配，且 WINDOWS_SHELLS 排在数组前面。文件名 sh 是 pwsh.exe 的子串，于是在 Unix 上把 /bin/sh 判成 PowerShell 7，返回 ['-NoLogo','-ExecutionPolicy','Bypass','-Command']。更糟的是这正是「自定义 shell 但路径没填」的默认值：resolveShellForCommand 第一句就是 config.customShellPath || (isWindows ? 'powershell.exe' : '/bin/sh')，随后把它交给 inferExecArgs。
EVIDENCE: private inferExecArgs(shellPath: string, customArgs?: string[]): string[] {
  const shellName = shellPath.split(/[/\\]/).pop()?.toLowerCase() || '';
  const allDefs = [...WINDOWS_SHELLS, ...UNIX_SHELLS];
  for (const def of allDefs) {
    if (def.paths.some((p) => p.toLowerCase().includes(shellName))) {
      return def.execArgs;      // 'pwsh.exe'.includes('sh') === true
    }
  }
SCENARIO: 用户在设置→终端→Shell 里选 Custom（TerminalSettings.tsx:161），路径输入框默认为空；或显式填 /bin/sh。此后 getShellForCommand()（src/main/utils/shell.ts:117）返回 PowerShell 的四个开关，execInPty 执行 `/bin/sh -NoLogo -ExecutionPolicy Bypass -Command "tmux -V"`，命令必然失败——现表现为 tmux 探测恒判「未安装」（TmuxDetector.ts:25）。影响面今天只有 execInPty 这一条（shell.resolveForCommand 的 IPC/preload 出口无渲染层调用方），但任何新接入这条推参逻辑的调用方都会中招。
FIX: 把子串匹配换成文件名精确匹配（对 def.paths 取 basename 后比较，Windows 去掉 .exe），匹配前按平台过滤 allDefs（Unix 上根本不该考虑 WINDOWS_SHELLS）；顺带给「自定义但路径为空」一个显式分支，不要用 /bin/sh 冒充用户的选择。
REFUTER(CONFIRMED,medium): 子串匹配属实且可达，且影响面比审查员写的更大一点。src/main/services/terminal/ShellDetector.ts:321-330 原文：`const shellName = shellPath.split(/[/\\]/).pop()?.toLowerCase()||''; const allDefs=[...WINDOWS_SHELLS,...UNIX_SHELLS]; for(const def of allDefs){ if(def.paths.some((p)=>p.toLowerCase().includes(shellName))) return def.execArgs; }`，而 WINDOWS_SHELLS 首项是 powershell7（ShellDetector.ts:58-66，`paths:['pwsh.exe']`，`execArgs:['-NoLogo','-ExecutionPolicy','Bypass','-Login','-Command']`），`'pwsh.exe'.includes('sh')===true`，所以 /bin/sh 拿到的是 PowerShell 7 的五个开关（审查员引用的是 powershell 5 那条、少了 '-Login'，细节有偏差，结论不变）。入口两条而非一条：resolveShellForCommand（275-281）`const shell=config.customShellPath||(isWindows?'powershell.exe':'/bin/sh'); const execArgs=this.inferExecArgs(shell, config.customShellArgs);` 是自定义分支；286-290 的 `config.shellType==='system' && !isWindows` 分支也调 `inferExecArgs(systemShell)`，而 system 正是非 Windows 的产品默认（src/renderer/stores/settings/defaults.ts:303-309），于是 $SHELL=/bin/sh 的机器不用改任何设置就中招。消费方确为 src/main/utils/shell.ts:117-127 `getShellForCommand()` → execInPty（shell.ts:161）→ src/main/services/cli/TmuxDetector.ts:25 `execInPty('tmux -V')`，`/bin/sh -NoLogo ... -Command "tmux -V"` 必然失败并被判成 tmux 未安装。顺带记一笔：仅按平台过滤 WINDOWS_SHELLS 并不足以修好——UNIX_SHELLS 里 zsh 的 '/bin/zsh' 同样 `.includes('sh')`，必须按 basename 精确匹配；src/main/services/remote/RemoteServerSource.ts:1631-1653 内嵌的远端副本已经只遍历 UNIX_SHELLS，正因如此把 /bin/sh 错判成 zsh，是同一类缺陷的第二处。ShellDetector.test.ts 只有 powershell7→powershell 回退一条用例（104-111），未覆盖 inferExecArgs。功能错误、用户可见（tmux 恒判未装），判 medium。
WAIVER(none): 无取舍 — 核对来源：raw/terminal-tui.md；相关原文：「区域外沿的两个模块（`PtyManager` / `ShellDetector`）服务的是普通终端而不是 pi TUI，那里各有一条与 pi 无关的老问题（terminal-08 / terminal-09）」

### [ah-lib-01] MEDIUM security confirmed | 依赖边界 | src/runtime/plugins/agent-loop/index.ts:463 | 会话文件落盘的 provider 错误正文两套脱敏都没走（静态推断） → 并入 main-aux-06
DESC: T011 修 core-host-03 时把脱敏放在 TurnCollector.observe（index.ts:691）——它给自己新建的 CollectedTurn 做脱敏副本，trace 的 llm 便签与 RuntimeRunResult.error.message 吃这份副本。但同一个事件对象在这之前一行就被原样写进会话文件：index.ts:463 的 session.appendMessage(event.message) 早于 collected.observe(event) 执行，写的是未脱敏的原件；收集器只造新对象、从不改写 event.message，所以两者互不影响。结果是 runs.jsonl 干净、会话 JSONL 不干净，而会话文件恰恰是这条链上生命周期最长、最容易被带走的一件（与 pi --session 互通、被导入导出读写、用户报 bug 时最可能附上）。正文来源是 pi-ai：src/runtime/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js 的 normalizeProviderError/formatProviderError 会把非 2xx 响应的原始 body 折进 errorMessage，上限 MAX_PROVIDER_ERROR_BODY_CHARS=4000，index.ts:686-688 的注释自己也这么写。static_inference：代码路径静态可证（三处行号可逐行核对），但「真实网关的 4xx body 里确实会回显凭据」需要真实 provider 回合取证，本轮未执行。
EVIDENCE: src/runtime/plugins/agent-loop/index.ts:462-465
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'message_end' && session) await session.appendMessage(event.message);
      collected.observe(event);
      projected.observe(event);

对照 index.ts:691-693（脱敏只发生在收集器一侧）
      ...(message.errorMessage
        ? { errorMessage: sanitizeProviderErrorText(message.errorMessage) }
        : {}),

src/runtime/plugins/session/store.ts:230-232（落盘端不做任何过滤）
  appendMessage(message: AgentMessage): Promise<void> {
    return this.appendEntry({ type: 'message', message: structuredClone(message) }).then(() => {});
  }
SCENARIO: 用户配了自建网关作 provider。某轮请求 401，网关把收到的请求头回显进 body（{"error":"unauthorized","received":{"authorization":"Bearer sk-ant-api03-xxxx"}}，自建网关常见的调试回显）。pi-ai 把这段 body 折进 assistant 消息的 errorMessage，index.ts:463 把这条 stopReason='error' 的消息原样追加进会话 JSONL。此后 runs.jsonl 里是 [REDACTED]，会话文件里是明文密钥并长期驻留；用户把会话文件发给别人排查或用 pi --session 打开时随之外泄。
FIX: 在 index.ts:463 落盘前也过一次 sanitizeProviderErrorText，即把 event.message 换成一份 errorMessage 已脱敏的副本再 appendMessage（其余字段不变）；或更彻底地把脱敏提到订阅回调最上游做一次，让 appendMessage / collected / projected 三个下游吃同一份。补用例：假 provider 产出带 Authorization: Bearer sk-ant-… 的 errorMessage，断言会话文件里不含该串。
REFUTER(CONFIRMED,medium): 静态推断成立，且推翻不了。src/runtime/plugins/agent-loop/index.ts:462-465 逐字为 `const unsubscribe = agent.subscribe(async (event) => { if (event.type === 'message_end' && session) await session.appendMessage(event.message); collected.observe(event); ...`——落盘在前、脱敏在后。脱敏只在 index.ts:690-693 的 TurnCollector.observe 里对新建对象做：`...(message.errorMessage ? { errorMessage: sanitizeProviderErrorText(message.errorMessage) } : {})`，不改写 event.message。落盘端 src/runtime/plugins/session/store.ts:230-232 只做 `structuredClone(message)`，无任何过滤。全仓检索 sanitizeProviderErrorText / redactSensitiveErrorText 只有 agent-loop 内 3 个调用点，会话链一个都没有。上游事实也核实了：pi-agent-core/dist/types.d.ts:11 写明失败回合会发 `final AssistantMessage with stopReason "error" or "aborted" and errorMessage`，pi-ai/dist/utils/error-body.js:15 `export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;`、:61 `return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);` 确认原始 body 会被折进去（上限 4000 字）。批次 A～C 未覆盖：git log -S sanitizeProviderErrorText 只命中 b714a925（T011），其 --stat 只动了 agentLoop.test.ts / tools.test.ts / agent-loop/index.ts / providerErrors.ts，roadmap.md:65 的 T011 验收标准本身就只写 runs.jsonl（「含 Authorization: Bearer 的假错误在 runs.jsonl 里是 [REDACTED]」），会话文件不在范围内。严重级与审查员一致取 medium：真实泄漏取决于网关是否回显凭据（本轮未做真实回合取证），但脱敏两端不一致这件事本身是确定的。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md 第68行 GAP[P3-2/H20]（批评者缺口5）；相关原文：「stderrRedaction.ts 是仓库既有的脱敏实现，core-host-03（provider 错误正文未脱敏写进 trace）在提出改法前应当先看它；…NEXT: 读这四个模块，顺带明确 src/runtime → src/agent-host 的依赖方向是否符合「自有 runtime」的边界口径，并把 stderrRedaction 作为 core-host-03 的现成修复材料评估。 | roadmap T029行：Main 侧宿主与渲染层：agent-host 未读的 8 个模块与 13 个测试…｜批评者缺口 1/2/3/4/5/8/19」

### [ah-lib-02] MEDIUM security confirmed | 依赖边界 | src/runtime/plugins/agent-loop/providerErrors.ts:39 | T011 新写的脱敏规则比仓库既有那份弱，认不出裸密钥形状（静态推断） → 并入 main-aux-06
DESC: 批评者缺口 5 提醒过「stderrRedaction.ts 是仓库既有的脱敏实现，core-host-03 在提出改法前应当先看它」。T011 没有复用，而是在 runtime 侧新写 redactSensitiveErrorText，只有三条规则：authorization: bearer …、api_key|access_token|password 后跟 = 或 : 的赋值、控制字符。stderrRedaction.ts:40-53 有而它没有的主要是「按形状识别的裸密钥」这一整类：sk-ant-*、sk-proj-*、长 sk-*、sk_live_/sk_test_*、gh[pousr]_*、AIza*、AKIA/ASIA*，外加 basic scheme、x-api-key 头、URL userinfo。stderrRedaction.ts:36-39 的注释写明了这类规则的理由：裸密钥不带敏感字段名可挂钩，形状是唯一抓手。provider 错误正文正是最容易出现裸密钥的地方，因为服务端回显通常是散文而非赋值。第三份实现 src/main/services/auth/redact.ts 反而知道这件事（注释明确说与 stderrRedaction 同范式并逐条解释差异），三份里只有 runtime 这份不知道另外两份存在。static_inference：规则差异静态可证，真实 provider 的回显措辞需真实回合取证。
EVIDENCE: src/runtime/plugins/agent-loop/providerErrors.ts:39-47
export function redactSensitiveErrorText(message: string): string {
  return message
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(CONTROL_CHARACTERS, '');
}

对照 src/agent-host/stderrRedaction.ts:40-47
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: '[redacted]' },
  { pattern: /\bAIza[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
  { pattern: /\bA(?:KIA|SIA)[A-Z0-9]{12,}/g, replacement: '[redacted]' },
SCENARIO: OpenAI 兼容网关对错误密钥返回 `Incorrect API key provided: sk-proj-AbCd1234...`。redactSensitiveErrorText 的赋值规则要求名字 api[_-]?key 后紧跟 = 或 :，而这里名字与冒号之间隔着 provided，正则不命中；裸 sk-proj- 也没有形状规则去抓。完整密钥进 runs.jsonl 的 llm 便签与 RuntimeRunResult.error.message，并叠加 ah-lib-01 进会话文件。同一串字符若出现在 CLI stderr 里，redactStderrLine 会直接打成 [redacted]——同一个密钥，走两条路两种结局。
FIX: 把形状规则做成共享数据：从 stderrRedaction.ts 抽出 KEY_SHAPE_RULES 导出（runtime 已 import agent-host 四个模块，多一个不改变依赖方向），或把这张表下沉到 src/shared/ 让三份实现共用。至少要让 redactSensitiveErrorText 覆盖 sk-ant-* / sk-proj-* / 长 sk-* / gh[pousr]_* / AIza* / AKIA|ASIA* 与 URL userinfo；并在 providerErrors.ts 的模块注释里写清与另外两份的关系，避免第四份被写出来。
REFUTER(CONFIRMED,medium): 规则差异静态可证。src/runtime/plugins/agent-loop/providerErrors.ts:39-47 只有三条替换：authorization 后跟 bearer 的赋值、`(?:api[_-]?key|access[_-]?token|password)` 后紧跟 `:` 或 `=` 的赋值、CONTROL_CHARACTERS；无任何按形状识别的规则。对照 src/agent-host/stderrRedaction.ts:40-53 确有 sk-ant-*、sk-proj-*、`\bsk-[A-Za-z0-9_-]{16,}`、sk_(live|test)_*、gh[pousr]_*、AIza*、A(KIA|SIA)*，外加 `((?:bearer|basic)\s+)`、`(x-api-key["':\s=]+)`、URL userinfo `([a-z][a-z0-9+.-]*:\/\/)[^\s\/@"']+@`；其 :36-39 注释写明理由「bare keys carry no sensitive-field name for the assignment rule to hook, so shape is the only handle (review F2, two rounds)」。第三份 src/main/services/auth/redact.ts:1-5 与 :39-44 明确写 `Same paradigm as agent-host/stderrRedaction.ts`、`KEY_SHAPE_RULES`——只有 runtime 这份不提另外两份。审查员给的反例可复核：`Incorrect API key provided: sk-proj-Ab...` 里 `API key` 与 `:` 之间隔着 `provided`，赋值正则要求名字后紧跟 `[:=]`，不命中；裸 sk-proj- 无形状规则兜。这条是 T011（b714a925）新写的，批次 A～C 之后没有再改（git log -- providerErrors.ts 最新即 b714a925）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md 第68行 GAP[P3-2/H20]（批评者缺口5）；相关原文：「同目录的 stderrRedaction.ts、piWorkerErrors.ts、userResourcePaths.ts 也未读。…把 stderrRedaction 作为 core-host-03 的现成修复材料评估。 | roadmap T029行：agent-host 未读的 8 个模块与 13 个测试…批评者缺口 1/2/3/4/5/8/19」

### [ah-lib-03] MEDIUM correctness confirmed | P6-5 尾巴 | src/renderer/components/chat/historyError.ts:27 | 恢复失败的分类表仍查 pi 时代的 WORKER_SESSION_* 词汇，native 的错误码一条都不认
DESC: encodePiResumeError 用 message.includes('WORKER_SESSION_FILE_NOT_FOUND' | 'WORKER_SESSION_FILE_CORRUPT' | 'WORKER_SESSION_CWD_MISMATCH' | 'WORKER_WORKSPACE_MISSING') 把恢复失败分到具体文案上。在 src/ 内全量检索这四个串：只有 WORKER_WORKSPACE_MISSING 还有生产者（src/main/services/agent-host/PiWorkerProcess.ts:72），另外三个在非测试代码里零生产者。原因是退役换了词汇：会话的打开与校验现在由 runtime 自己做，抛的是 RuntimeHostError，码是小写下划线的 session_invalid / session_cwd_mismatch / session_size_limit，文件不存在时直接漏出 Node 的 ENOENT；这些码经 piWorkerRpcServer.errorPayload 的通用 Error 分支取 .code，再由 WorkerSlot 拼成 `${code}: ${message}` 送到渲染层，于是全部落到兜底的 read_failed。read_failed 的语义正好相反：retryable=true、提示「对话没有中断，你可以继续发消息」，而这两种情况下 bootstrap 根本没起来，下一条消息同样会失败。与此同时 session_file_corrupt 与 session_cwd_mismatch 两张写好的卡片变成不可达代码（MessageTimeline.tsx:841 还给后者留着图标）。讽刺的是 runtime 抛的 session_cwd_mismatch 与渲染层的 HistoryErrorCode 字面完全相同，只差匹配规则写死了 WORKER_SESSION_ 前缀。这与批评者抽查到的 TOOL_VERBS 漂移同类，但那条已由 T020 修掉，这条至今无人报过——docs/ 下检索 encodePiResumeError 与 WORKER_SESSION_FILE_CORRUPT 无任何命中，不存在已记录的豁免。
EVIDENCE: src/renderer/components/chat/historyError.ts:25-41
export function encodePiResumeError(error: unknown): { message: string; encoded: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes('WORKER_SESSION_FILE_NOT_FOUND')
    ? 'jsonl_not_found'
    : message.includes('WORKER_SESSION_FILE_CORRUPT')
      ? 'session_file_corrupt'
      : message.includes('WORKER_SESSION_CWD_MISMATCH')
        ? 'session_cwd_mismatch'

src/runtime/plugins/session/store.ts:162-166（native 实际抛的码）
        if (document.header.cwd !== (await io.realpath(config.cwd)))
          throw new RuntimeHostError(
            'session_cwd_mismatch',
            'resume cwd differs from the session workspace'
          );

src/main/services/agent-host/WorkerSlot.ts:561-566（拼成渲染层看到的那句话）
    pending.reject(
      new WorkerSlotError(
        'WORKER_RPC_REMOTE_ERROR',
        `${message.error.code}: ${message.error.message}`,
        message.error
      )
    );
SCENARIO: 用户把 A 仓库的会话在 B 仓库打开（或索引行还在、工作区换了）。runtime 抛 session_cwd_mismatch，渲染层拿到 `session_cwd_mismatch: resume cwd differs from the session workspace`，includes('WORKER_SESSION_CWD_MISMATCH') 为假 → 落 read_failed → 卡片显示「Failed to read history … 对话没有中断，你可以继续发消息」并给出 Retry。按 Retry 同样失败，正确的那张「这个会话属于另一个工作区」的卡永远不出现。同理会话文件被删时 `ENOENT: … stat '/home/dan/.pi/…jsonl'` 也落 read_failed，而不是 jsonl_not_found 那张「此对话无法继续，下一次发送就会失败」的卡。
FIX: 把匹配改成认 native 的码，并且认码字段而不是在消息正文里做子串搜索：WorkerSlotError 已带 remoteError.code（remoteCode getter），encodePiResumeError 应优先读它。映射建议：session_invalid → session_file_corrupt；session_cwd_mismatch → 同名；ENOENT 与 Main 的 pi_session_not_found → jsonl_not_found；session_size_limit 需要一张新卡。旧 WORKER_SESSION_* 分支只保留唯一还有生产者的 WORKER_WORKSPACE_MISSING。补用例：historyError.test.ts 现有码表用例逐条改成 native 码，并加一条「未知码不得落到 retryable=true 的文案」的反向断言。
REFUTER(CONFIRMED,medium): 链路逐段核实，无中间层补救。(1) 生产者缺失：全仓（排除 node_modules）检索四个串，WORKER_SESSION_FILE_NOT_FOUND 只出现在 WorkerManager.ts:2533 注释与 WorkerManager.test.ts:1193 注释，WORKER_SESSION_FILE_CORRUPT / WORKER_SESSION_CWD_MISMATCH 在非测试代码里仅出现在 historyError.ts 自身的匹配分支，只有 WORKER_WORKSPACE_MISSING 有真生产者 PiWorkerProcess.ts:72。(2) native 实际码：store.ts:162-166 `throw new RuntimeHostError('session_cwd_mismatch', 'resume cwd differs from the session workspace')`，codec.ts:126 `throw new RuntimeHostError('session_invalid', message)`，store.ts:150/292/500/562 `session_size_limit`；store.ts:125-127 对 realpath 的 ENOENT 直接放行、随后 io.readFile 抛原生 ENOENT。(3) 无映射层：src/agent-host/piWorkerRpcServer.ts:281-288 的 errorPayload 非 PiWorkerSessionError 时走通用分支 `code: typeof record.code === 'string' ? record.code : 'WORKER_REQUEST_FAILED'`，原样透出小写码；WorkerSlot.ts:561-566 拼成 `${message.error.code}: ${message.error.message}`；src/main/services/agent-host/*.ts 里检索 WORKER_SESSION 只剩一条注释，没有任何反向映射；chat.ts:213-215 的 withWorkerErrorCode 也只是再包一层 `${code}: ${message}`。(4) 消费者确在 native 恢复失败路径上：useResumeSession.ts:62-70 catch 里 `const encodedError = encodePiResumeError(error)` 写进 historyErrors，ChatComposer.tsx:1988/2108 同理。因此 session_cwd_mismatch / session_invalid / ENOENT 全部落 historyError.ts:39 的兜底 'read_failed'，而 CODE_COPY.read_failed 是 retryable:true + HISTORY_ERROR_NON_FATAL_HINT（'The chat is not interrupted; you can keep sending messages.'），语义与实际相反；session_file_corrupt / session_cwd_mismatch 两张卡片成为不可达分支（MessageTimeline.tsx:841 仍给后者留图标）。现有测试反而把旧词汇钉死：historyError.test.ts:237-241 逐条断言 WORKER_SESSION_* 映射，780 行的「full resume-failure round trip」用例走的也是 model_missing 那条，没有一条覆盖 native 码。docs 与 roadmap 的 Done 段（T001～T036）无任何条目涉及 encodePiResumeError。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/batch-c-2026-09-15.md 第64行；docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；相关原文：「src/renderer/components/chat/historyError.ts 四个错误码死支（WORKER_SESSION_FILE_NOT_FOUND 等，preflightPiSessionFile 删除后已无生产产出方） | 渲染层补审，归批次 D 或并入 T026 后续 | roadmap T029行：…chat 目录词汇表全量比对」

### [chat-tool-01] MEDIUM correctness confirmed | P4-5 / P6-3 第 4 条 | src/renderer/components/chat/toolCard.ts:628 | 命中列表只认大写 Grep / Glob，native 的每一次搜索都没有命中列表（静态推断）
DESC: isHitListTool 自 T-05 首次写下（340a59a7）至今一字未改，只匹配 Claude 期的大写名。native 注册的是小写 grep 与 glob，于是 deriveToolRowView 的 hitSource 恒为 undefined，ToolRows.tsx:309 的 HitListPopover 分支永远进不去，搜索行退化成普通可展开行。T020 补了 glob 的动词与参数，但没有补这个查表点。反向对照很刺眼：导入的 Claude 会话里的 Grep 行是有命中列表的（ClaudeSourceAdapter.ts:406 原样保留大写名，piSessionTimeline.ts:190 还原成 tool_call），旧会话能力强于主路径。native 的输出形状与解析器本身是对得上的（grep 产出 path:line:text 命中 CONTENT_LINE_RE，glob 每行一个绝对路径命中 PATH_ONLY_RE），所以这不是解析不了，是根本没被调用。静态推断。
EVIDENCE: // src/renderer/components/chat/toolCard.ts:627-629
function isHitListTool(toolName: string): boolean {
  return toolName === 'Grep' || toolName === 'Glob';
}
// src/renderer/components/chat/toolCard.ts:523
  const hitSource = isHitListTool(run.toolName) ? run.output : undefined;
// src/renderer/components/chat/ToolRows.tsx:309-313
  if (view.hitSource) {
    return (
      <HitListPopover source={view.hitSource} ...
SCENARIO: 用户让 agent 在仓库里搜 TODO。行显示「已搜索内容 TODO in ai-client」，鼠标悬停没有任何命中列表弹层，也没有从命中直接打开文件的入口，只能展开行读一整片纯文本；而同一窗口里导入的 Claude 会话的 Grep 行悬停就有列表。
FIX: 把判定改成复用 classifyTool(name) === 'search'（或至少加入 PI_TOOL_NAMES.grep / find / ls 与 RUNTIME_TOOL_NAMES.glob），去掉这第二张只有两项的表；顺手把 toolHits.ts:68 的 NOISE_RE 加上 native glob 的空结果文案 'No files matched.'。用例：给 deriveToolRowView 补 grep / glob 的 hitSource 断言（现有 toolCard.test.ts:631 只覆盖大写名）。
REFUTER(CONFIRMED,medium): 静态推断，成立。src/renderer/components/chat/toolCard.ts:627-629 仍是 `function isHitListTool(toolName: string): boolean { return toolName === 'Grep' || toolName === 'Glob'; }`，`git log -S"isHitListTool"` 只有一条 340a59a7（T-05），批次 A～C 未动。toolCard.ts:523 `const hitSource = isHitListTool(run.toolName) ? run.output : undefined;` 是全仓唯一赋值点（grep hitSource 仅命中 toolCard.ts:452/523/553 与 ToolRows.tsx:309/312）。native 注册的是小写名：piToolNames.ts:51-70 `glob: 'glob', grep: 'grep'`，runtime/plugins/tools/index.ts:490 `name: 'glob'`、:541 `name: 'grep'`，故 hitSource 恒 undefined，ToolRows.tsx:309 的 HitListPopover 分支在 native 主路径永不进入。输出形状确实可解析：tools/index.ts:645 `matches.push(`${file}:${line + 1}:...`)` 命中 toolHits.ts:67 的 CONTENT_LINE_RE，glob 的 `found.join('\n')`（:527）命中 PATH_ONLY_RE。反向对照属实：ClaudeSourceAdapter.ts:405 `toolName: item.name.slice(0, 256)` 原样保留大写 Grep。唯一测试 toolCard.test.ts:631 只断言大写名，钉不住 native。附带一点也对：toolHits.ts:68 的 NOISE_RE 只认 'Found N files' / 'No matches found'，不认 glob 的 'No files matched.'（tools/index.ts:527）。定为 medium：主路径上用户可见的能力缺失（悬停命中列表与从命中跳转文件），非安全问题。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029 行；raw/chat-tool-vocab.md [chat-tool-01]；相关原文：「T029 | Main 侧宿主与渲染层：……chat 目录词汇表全量比对」

### [chat-tool-02] MEDIUM contract-gap confirmed-partial-waiver | P4-5 | src/renderer/components/chat/questionCardModel.ts:771 | 只带路径的审批卡（read / glob / grep / browser_preview）从不显示被批准的那个路径（静态推断）
DESC: permissionPrompt.ts:166-173 把 path 放进 permission.requested 的 input，ToolPermissionRequest.preview 的注释也写明「a read or a glob is fully described by its path」，即生产者认为路径就是这张卡的正文。但消费者两条路都不读它：derivePermissionContent 只看 input.content 与 input.command；derivePermissionDetailView 依赖 permissionDetail，而 permissionPrompt 的 detailOf 对 bash/write/edit 之外一律返回 undefined。QuestionCard.tsx:663-690 渲染的四块（prompt / content / detail / workspace）没有一块会打印 input.path。于是 read 的卡有句子没有对象，glob/grep/browser_preview 连句子都没有（actionOf 返回 undefined，这一半是 runtimeEvents.ts:354-357 记过的取舍）。已决状态同样如此（derivePermissionRowView:899 的 arg 就是同一个 prompt）。门确实会开：permissions/index.ts:317-325 的 !containsPath(cwd, path) 分支在 ['read','grep','glob'] 放行分支之前返回 'ask'。静态推断。
EVIDENCE: // 生产者 src/runtime/worker/permissionPrompt.ts:166-173
            input: {
              ...(request.path ? { path: request.path } : {}),
              ...(request.command ? { command: request.command } : {}),
              ...(request.preview ? { content: ..., contentLabel: ... } : {}),
              workspace: options.cwd,
            },
// 消费者 src/renderer/components/chat/questionCardModel.ts:771-782
export function derivePermissionContent(block: ChatBlock) {
  const content = readInputField(block.toolInput, 'content');
  if (content) { ... }
  if (block.permissionDetail?.kind === 'exec') return null;
  const command = readInputField(block.toolInput, 'command');
  return command ? { label: 'Command', text: command } : null;
}
// src/runtime/worker/permissionPrompt.ts:104-115 —— 非 bash/write/edit 的 detail 直接 return undefined
SCENARIO: 用户说「看一下 ~/.config/foo/settings.json 里写了什么」。审批卡显示标题「需要你的批准」、一行「read — 读取文件内容」、底部「Project: /home/ai/code/ai-client」和倒计时——卡上没有任何地方出现 ~/.config/foo/settings.json，用户只能盲批或退回去翻上一条消息猜是哪个文件。browser_preview 更糟，正文只有 browser_preview 一个词。
FIX: 推荐改渲染层：derivePermissionContent 在没有 content/command 时回落到 input.path，标签用新词条 'Path'（与 'Content'/'Command' 同款走 t()），一处改动覆盖 read/glob/grep/browser_preview 与将来任何只带路径的工具。用例：questionCardModel.test.ts 补一条「read 门的卡上出现路径」。
REFUTER(CONFIRMED-PARTIAL-WAIVER,medium): 静态推断，成立。生产者 src/runtime/worker/permissionPrompt.ts:166-173 确实发 `input: { ...(request.path ? { path: request.path } : {}), ... workspace: options.cwd }`；detailOf（:98-115）只对 bash 与 write/edit 返回 detail，其余 `return undefined`；actionOf（:74-87）只给 bash/write/edit/read 四个 action，glob/grep/browser_preview 返回 undefined。消费者两条路都不读 path：questionCardModel.ts:771-784 的 derivePermissionContent 只读 'content' 再读 'command'；derivePermissionPrompt（:727-734）只拼 `toolName — description`；derivePermissionCardView（:811-817）只取 prompt / detail / risk / content / workspace。渲染面 QuestionCard.tsx:662-693 也只画这四块，没有任何地方输出 input.path。且现有用例反而把这个形态钉死了——questionCardModel.test.ts:1131-1136「reads quieter for a gate that only touches what it can undo」对 `toolInput: { path: '/etc/hosts' }` 断言 `expect(view.content).toBeNull()`，即修复必须同时改这条用例。触发路径存在：permissions/index.ts:317-325 的 `!request.trustedPath && (pathAction === 'ask' || !containsPath(this.config.cwd, request.path) ...) return 'ask'` 排在 :332 的 `['read','grep','glob']` 放行之前，工作区外的 read 必弹卡。定为 medium：用户被要求在看不到对象的情况下批准，属用户可见错误行为，但不是权限绕过。
WAIVER(partial): 部分取舍，保留计入 — 来源：src/shared/types/runtimeEvents.ts:348-358（经 raw/chat-tool-vocab.md 引用）；docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；原文：「Absent means "no sentence available" — an unrecognised tool, or a Host older than this field. 对应 raw evidence 原文：「actionOf 发 undefined——这是 runtimeEvents.ts:348-358 明文写下的取舍（宁可少说，不要说错），不立发现」」

### [chat-event-01] MEDIUM correctness confirmed | F5 | src/renderer/stores/chatSessions.ts:1266 | 问答卡只有一个全局槽位，第二个问答挤掉第一个并让那一回合永久挂起（静态推断）
DESC: question.requested 无条件把 pendingQuestion 覆盖成本次的 {sessionId,questionId,messageId}，而这是 store 里唯一一个问答槽（对照 pendingPermissions 是数组 + 每会话取队首）。唯一可作答界面 PendingQuestionDock 只认这个槽，时间线对未决问答卡直接 return null，respondQuestion 也只会把答案发给槽里那个 questionId。生产者 questionPrompt.ts 的 pending 是 Map，支持并发多问，并刻意不设超时。被挤掉的问答既不显示也不可答，promise 永不结算，ask 所在那一轮工具执行一直卡着。
EVIDENCE: src/renderer/stores/chatSessions.ts:1264-1272  return { messages: ..., pendingQuestion: { sessionId, questionId, messageId }, sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_question') };  ||  src/renderer/components/chat/MessageTimeline.tsx:2018-2020  const state = deriveQuestionCardState(item.block); if (state === 'pending') return null;  ||  src/runtime/worker/questionPrompt.ts:9-12  ' - **No timeout.** ... The turn's own abort still settles it.'
SCENARIO: 会话 A 的模型调 ask，卡片在 dock；用户不答，切到会话 B 发消息（worker 池默认容量≥3，WorkerManager.ts:322-326，B 可并行），B 的模型也调 ask。第二条 question.requested 覆盖 pendingQuestion。切回 A：dock 因 sessionId 不匹配不渲染，时间线因 pending 返回 null，A 一张卡都没有，状态停在 waiting_question，输入框判 busy，回合永不结束，只能按 Stop。同一会话内也可达：pi 工具默认并行（pi-agent-core/dist/agent-loop.js:286-291，askTool 未声明 sequential），一条 assistant 消息里两个 ask 时后者挤掉前者。
FIX: 把 pendingQuestion 改成与 pendingPermissions 同形的队列（每会话队首可答，其余画成 waiting），或在命中已有未决问答时排队而非覆盖并在 question.resolved 出队；两者都要同时给 MessageTimeline 的 question 分支一个非队首未决问答的呈现方式。另建议给 ask 加一个足够长的兜底超时（结算为 cancelled，工具已把 cancelled 当正常结果），避免界面侧漏掉就永久挂住回合。
REFUTER(CONFIRMED,medium): 推翻失败，触发路径实证成立。(1) 覆盖点确实无条件：src/renderer/stores/chatSessions.ts:1263-1272 的 question.requested 分支 return { messages: ..., pendingQuestion: { sessionId, questionId, messageId }, sessions: upsertSessionStatus(..., 'waiting_question') }，全程没有「已有未决问答则排队/忽略」的判断；而 pendingQuestion 在 :292 是单值 `PendingQuestion | null`，对照 pendingPermissions 是数组（:1170-1174 push 入队）。(2) 唯一可作答面 src/renderer/components/chat/PendingQuestionDock.tsx:32 `state.pendingQuestion?.sessionId === sessionId ? state.pendingQuestion : null`，只认这一个槽；时间线 src/renderer/components/chat/MessageTimeline.tsx:2018-2020 `const state = deriveQuestionCardState(item.block); if (state === 'pending') return null;` 对未决卡直接不画。(3) 同会话并发 ask 可达：src/runtime/plugins/tools/ask.ts:123 `execute: async (id, params, signal)` 未声明 executionMode，主会话侧全仓没有 toolExecution 配置（只有 src/runtime/plugins/subagent/run.ts:264 给委派设 'sequential'），pi 默认 src/runtime/node_modules/@earendil-works/pi-agent-core/dist/agent.js:134 `this.toolExecution = runtimeOptions.toolExecution ?? "parallel"`，agent-loop.js:363 `await Promise.all(finalizedCalls.map(...))` 真并发；questionPrompt.ts:44 `const pending = new Map<...>()` 也支持多问并存。(4) 现有测试没钉住这条：src/renderer/stores/__tests__/chatSessionsQuestion.test.ts 的 A15 组（:207-256）钉的是 question.resolved 错误清空 dock，没有一条覆盖「第二条 question.requested 到达」。被挤掉的问答无入口作答、promise 不结算，回合挂到用户按 Stop（drain('aborted') 才收），属用户可见功能错误但可恢复，故 medium。
WAIVER(none): 无 — 全库检索（roadmap.md / decisions/*.md / open-questions.md / ARD / evidence）

### [chat-event-02] MEDIUM correctness confirmed | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:1174 | waiting_permission / waiting_question 没有回程，Run 面板从用户点「允许」起一直显示「等待审批」（静态推断）
DESC: 这两个状态是渲染层自己在 permission.requested / question.requested 时用 upsertSessionStatus 推上去的，但 permission.resolved / question.resolved 分支都没有推回 running，生产者侧也不会在闸门放行后补一条 session.status: running——projector 只在 start/retry/recovery/recovered/finish 五处发状态，WorkerManager 的九处 session.status 全是 idle / disconnected / 一次重复 create 时的 running。runPanelModel 的活动细化（Running a tool / Thinking）只在 status === 'running' 时计算，于是整轮剩余时间 Run 面板都写着「Waiting for approval」+ attention 色。
EVIDENCE: src/renderer/stores/chatSessions.ts:1174  sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_permission'),  ——紧随其后的 case 'permission.resolved'（:1178-1226）返回的只有 messages 与 withoutPermission 的 pendingPermissions，没有任何 sessions 补丁  ||  src/renderer/components/workspace-shell/surfaces/runPanelModel.ts:266-276  const activity: RunActivity = status === 'running' ? (tools.activeTool ? 'tool' : isThinking(...) ? 'thinking' : null) : null; const presentation = status ? STATUS_PRESENTATION[status] : null;  ||  STATUS_PRESENTATION.waiting_permission = { headline: 'Waiting for approval', tone: 'attention' }（:51）
SCENARIO: 一次普通写文件回合：模型调 write → 弹审批卡 → 状态 waiting_permission → 用户点「允许」→ permission.resolved 到达、卡片冻结、队列清空，但状态仍是 waiting_permission。此后工具执行、正文流式输出、可能还有多个工具轮次，Run 面板全程「Waiting for approval」，直到 finish() 发 idle。输入框上方的 SessionActivityStatus 读的是 session.activity，会随 tool.started 变成「Running tool」，同一屏上两处状态互相矛盾。
FIX: 在 permission.resolved / question.resolved 分支里，若该会话当前状态是对应的 waiting_*，就推回 running（先确认 pendingPermissions 已清空，避免覆盖同轮紧接着到来的第二张卡）。或由生产者在 permissionPrompt.settle / questionPrompt.settle 结算后经 projector 发一条 session.status: running，与 recovered() 同形。前者改动更小且不扩协议面。
REFUTER(CONFIRMED,medium): 推翻失败。渲染层 upsertSessionStatus 全部调用点只有 src/renderer/stores/chatSessions.ts:862（session.status 事件）、:888 idle、:896 failed、:905 idle、:1174 waiting_permission、:1271 waiting_question、:1479 failed——permission.resolved 分支（:1178-1225）返回的是 `{ messages: withBucket(...), ...cleared }`，question.resolved 同样只动 messages / pendingQuestion，都不带 sessions 补丁，没有回 running 的路径。生产者侧也不补：src/runtime/events/projector.ts 的 session.status 只在 start()（:163-167 status running）、retry()（:428-432）、recovery()（:450-455）、recovered()（:465-469）、finish()（:542-547 status idle）五处，闸门放行不发；src/runtime/plugins/agent-loop/index.ts:127-133 只在 catch 里发 idle。消费端 src/renderer/components/workspace-shell/surfaces/runPanelModel.ts:265-274 `const activity: RunActivity = status === 'running' ? ... : null;` 与 :51 `waiting_permission: { headline: 'Waiting for approval', tone: 'attention' }` 说明审批之后整轮 Run 面板停在「等待审批」且不再细化 Running a tool / Thinking，直到 finish 发 idle。同屏 SessionActivityStatus.tsx:32 仍按 activity 走，两处文案互相矛盾。用户可见状态错误，medium。
WAIVER(none): 无 — 全库检索（roadmap.md / decisions/*.md / open-questions.md / ARD）

### [chat-event-03] MEDIUM correctness confirmed-partial-waiver | P4-5 | src/runtime/events/projector.ts:520 | 子代理花费那条 usage.updated 不带 context，渲染层整体替换后上下文占用徽标消失（静态推断）
DESC: 决策 005 让 projector 在委派结算时补发一条 usage.updated 重述上一条已结算回合并更新 session/delegated 两块，但调用 buildPiUsagePayload 时第二个参数（上下文占用）传的是 undefined，而该函数是「给了才带」（piUsage.ts:237），所以这条 payload 没有 context 键。消费侧 foldSettledUsage 是整体替换该会话的 usage 而非逐字段合并，于是这条事件一落地 facts.usage.context 就没了：ComposerUsageChip 直接 return null 消失，Run 面板占用条退回只知道窗口大小。
EVIDENCE: src/runtime/events/projector.ts:519-526  if (this.lastTurnUsage === undefined) return; const payload = buildPiUsagePayload(this.lastTurnUsage, undefined, viewTurnRollup(this.rollup), this.delegatedUsage); if (payload) this.emit({ type: 'usage.updated', ... });  ||  src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts:576-585  return { ...prev, [sessionId]: { ...prev[sessionId], usage } };  ||  src/renderer/components/chat/ComposerUsageChip.tsx:111-112  const occupancy = deriveContextOccupancy(usage?.context); if (!usage || !occupancy) return null;  ||  现成证据：src/shared/__tests__/fixtures/nativeGuiSubagentEventStream.json 数组下标 20 的 usage.updated 键集为 ["input","output","cacheRead","cacheWrite","totalTokens","costUsd","session","delegated"]，无 context，而前后两条都有
SCENARIO: 永久形态：一次带委派的回合被 Stop 或失败。agent-loop/index.ts:573 的 collectFinished 循环条件是 !request.signal?.aborted，被中止时整段不进；随后 :636 的收尾 foldDelegatedUsage() 取出已结算委派的花费并发出这条无 context 的 usage.updated，紧接着就是 projected.finish(...)，它因此是本轮最后一条 usage.updated，上下文徽标从此消失直到下一轮 turn_end。后台委派（run_in_background）在父回合 turn_end 之后结算同理。闪烁形态：正常同步委派时 :577 的 per-pass fold 先发无 context 的一条，父代理拿报告再跑一整轮才发下一条带 context 的，中间整整一个模型回合徽标是空的。
FIX: 生产者侧让 projector 记住最后一次算出的上下文占用块（与 lastTurnUsage 并排存），delegated() 重述时一并带上——它本来就是「重述而非重新计费」；消费者侧让 foldSettledUsage 对 context 做「新值缺失沿用旧值」的逐字段保留，理由与 mergePermissionActivity / mergeUsage 已写过的完全一致。建议两处都做。
REFUTER(CONFIRMED-PARTIAL-WAIVER,medium): 推翻失败，且有现成录制佐证。src/runtime/events/projector.ts:519-527：`if (this.lastTurnUsage === undefined) return; const payload = buildPiUsagePayload(this.lastTurnUsage, undefined, viewTurnRollup(this.rollup), this.delegatedUsage);` 第二参（上下文占用）确为 undefined；src/shared/piUsage.ts:228,239 `const context = readContextUsage(contextUsage); ... ...(context ? { context } : {})` 是「给了才带」，所以这条 payload 无 context 键。对照 turn_end 路径 projector.ts:398-409 才传 `{ tokens, contextWindow, percent }`。消费侧 src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts:582-583 `const usage = readPiUsagePayload(event.payload); ... return { ...prev, [sessionId]: { ...prev[sessionId], usage } };` 是整体替换而非逐字段合并，且 readPiUsagePayload 只要 input/output 是数字就接收，所以 context 被抹掉；ComposerUsageChip.tsx:111-112 `const occupancy = deriveContextOccupancy(usage?.context); if (!usage || !occupancy) return null;` 徽标随之消失。我自己解析了 src/shared/__tests__/fixtures/nativeGuiSubagentEventStream.json（27 条）：usage.updated 出现在下标 11、19、20、24，其中下标 20 的键集为 [cacheRead, cacheWrite, costUsd, delegated, input, output, session, totalTokens]，唯一缺 context 的一条，与审查员所述一致。收尾 fold 位置也核实：src/runtime/plugins/agent-loop/index.ts:571-577 的 per-pass `foldDelegatedUsage()` 在 `while (!request.signal?.aborted)` 内，:634 finally 之后还有一次收尾 fold，Stop 时它就是本轮最后一条 usage.updated。属用户可见显示错误（徽标消失持续到下一轮 turn_end），medium。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-hardening/decisions/005-subagent-usage-in-usage-updated.md 与 docs/plantree/plans/runtime-hardening/evidence/batch-b-2026-09-14.md 第45行（T020 落地记录）；原文：「委派结算时额外发一条 usage.updated 复述上一轮 turn 数字（渲染层取最后一条不累加）」

### [chat-event-12] MEDIUM correctness confirmed | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:524 | 回放只还原四类 block，重开会话后权限卡行、审批审计行与已答问答卡全部消失（审查员原判 low）
DESC: 实时路上渲染层会往消息里挂 text / thinking / tool_call / tool_result / permission_request / permission_activity / question 七类 block，回放路（session.history → mapHistoryBlock）只认前四类，其余 return null 被过滤。于是重开会话后已决权限卡收起后的那一行、权限审计行（包括 Approval details 折叠里的 policy_allow）、已答问答卡全部消失，只剩裸的工具调用与结果。PermissionActivityEvent 的类型注释说这行是「policy_allow 从不弹窗，所以它是这次调用被闸门管过而不是根本没检查的唯一证据」——重开会话后这份唯一证据就不在了。
EVIDENCE: src/renderer/stores/chatSessions.ts:524-567  function mapHistoryBlock(block): ChatBlock | null { switch (block.type) { case 'text': ... case 'thinking': ... case 'tool_call': ... case 'tool_result': ... default: return null; } }  ||  对照实时路的 permission.activity（:1059-1099）、permission.requested（:1102-1176）、question.requested（:1228-1273）三个分支产出的 block 类型都不在上表  ||  src/agent-host/piSessionTimeline.ts 的 HistoryBlock 同样只有四种，缺口在会话文件与投影两层
SCENARIO: 用户今天批准了三次写文件、拒绝了一次 bash，明天重开这个会话想确认「我当时到底批了什么」——时间线上只有工具行，被拒的那次表现为一次失败的工具调用，批准与自动放行的记录一条不剩。问答同理：模型问过什么、用户选了哪个，回放后只剩一次 ask 工具调用及其文本结果。
FIX: 按「值不值得进会话文件」分两档。审批决定（谁、什么、允许还是拒绝、是不是规则自动放行）建议落成 custom 条目并在 piSessionTimeline 投影成一类新的 HistoryBlock——它是审计证据且体积很小；问答卡可用同样办法，或接受「工具行即记录」并把类型注释改成实况。无论选哪档都应把「实时可见、回放不可见」这条差异写进契约。
REFUTER(CONFIRMED,medium): 复现，并把严重级从 low 上调到 medium：这是用户可见的数据在重开会话后消失，不是死代码。回放侧只认四类：src/renderer/stores/chatSessions.ts:524-567 `function mapHistoryBlock(block) { switch (block.type) { case 'text': ... case 'thinking': ... case 'tool_call': ... case 'tool_result': ... default: return null; } }`，与 src/shared/types/sessionHistory.ts:37-58 的 `HistoryBlock` 四元联合一致，缺口在会话文件与投影两层而非只在渲染层。实时侧确实多出三类：chatSessions.ts:62-75 的 `ChatBlockType` 含 'permission_request' / 'permission_activity' / 'question'，分别由 :1096 `{ id: blockId, type: 'permission_activity', permissionActivity: incoming }`、:1142 `type: 'permission_request'`、:1256 `type: 'question'` 产出，三者都不在回放表里，走 default → null 被过滤。会话文件也确实没存审批决定：src/runtime/plugins/session 下与 permission 相关的只有 legacy.ts:22 `PERMISSIONS_ENTRY = 'aiclient.permissions'` 这类「会话权限档位设置」与 store.ts:226 的 `sessionPermissions(...)`，没有任何逐次 allow/deny 记录落盘。后果与已写死的契约直接冲突：src/runtime/plugins/permissions/activity.ts:10-14 的注释原文称这一行是 'the only evidence anywhere that the call was gated rather than simply unchecked'，重开会话后这份「唯一证据」不存在，被拒的调用退化成一次普通失败工具行。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/session-review-and-updates.md；相关原文：「native 记录默认启用...对应 ToolsConfig.recordFileChanges 已验证关闭仍可写文件」

### [concurrency-01] MEDIUM concurrency confirmed | P3-1 | src/runtime/plugins/session/writerLock.ts:173 | 抢占陈旧锁时锁名短暂空缺，第三个申领者可在此窗口建锁，造成同一会话两个写者
DESC: clearStale 的做法是「把锁改名移到一边 → 读移走的那个 → 不是我读到的那个就用 createOnly 原样放回」。放回用 createOnly，意味着从 rename 成功到 writeFile 放回之间，锁这个名字在文件系统上不存在；任何此刻走 acquireWriterLock 第 0 次尝试的进程会直接建锁成功——它不读、不判陈旧，因为根本没撞上 EEXIST。放回撞 EEXIST 之后代码还会 unlinkQuiet(aside)，把赢家的锁文件删掉。赢家此后 releaseWriterLock 读到别人的 token 返回 false，而 store.close()（store.ts:588）丢弃这个返回值，没有任何日志或事件说明「我的锁被人拿走了」。T015 修的是两个进程的交织，这条是三个。
EVIDENCE: const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await io.rename(lock, aside);          // 从这里开始 lock 这个名字是空的
  } catch (error) { if (errorCode(error) === 'ENOENT') return { cleared: true }; throw error; }
  const moved = await readLock(io, aside);
  if (moved !== undefined && !moved.bytes.equals(expected)) {
    await io.writeFile(lock, moved.bytes, { createOnly: true, mode: 0o600 }).catch((error) => {
      if (errorCode(error) !== 'EEXIST') throw error;   // 窗口里有人建了锁，静默吃掉
    });
    await unlinkQuiet(io, aside);                        // 把别人的锁文件删掉

// 对照 writerLock.ts:205-208，第 0 次尝试不判陈旧直接建：
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await io.writeFile(path, claim, { createOnly: true, mode: 0o600 }); return { path, token }; }
SCENARIO: 盘上有一把陈旧锁 L0（上次 worker 被强杀留下）。P1、P2 同时打开这个会话，都读到 L0 判为陈旧。P1 先完成整套抢占，建出 L1 并开始写会话。P2 随后把 L1 改名移到一边——此刻锁名为空——P3 在这一瞬打开同一会话，第 0 次尝试直接建锁成功。P2 的放回撞 EEXIST 被静默吃掉，随后把 L1 删掉并报告自己输了。最终盘上只剩 P3 的锁，而 P1 与 P3 同时往同一个 JSONL 追加：两条各自从自己读到的 leaf 出发的分支交织进同一文件，parentId/seq 互相矛盾，下次打开时解码器按单链还原，另一条内容落进不可达分支。
FIX: 给抢占加二级互斥：抢占前先 createOnly 建 <lock>.takeover 哨兵，成功者才执行改名—判定—重建，失败者按「输掉竞争」重试正常路径；哨兵本身也按 pid 判陈旧。放回改为 EEXIST 时不删 aside，保留它并把本次抢占判为失败，让下一轮重新读盘决定。附带把 releaseWriterLock 返回 false 接到日志/writeFailure 一类可观测出口，让「锁被接管」不再无声。
REFUTER(CONFIRMED,medium): 代码属实且未被 T015 覆盖。/home/ai/code/ai-client/src/runtime/plugins/session/writerLock.ts:162-180 的 clearStale 先 `await io.rename(lock, aside)`（此刻锁名在盘上真空），再 `const moved = await readLock(io, aside)`；当 `!moved.bytes.equals(expected)`（即自己已输掉竞争、移走的是赢家的锁）时执行 `await io.writeFile(lock, moved.bytes, { createOnly: true, mode: 0o600 }).catch((error) => { if (errorCode(error) !== 'EEXIST') throw error; })`，EEXIST 被静默吞掉后紧接 `await unlinkQuiet(io, aside)` —— 赢家的锁文件就此被删。对照同文件 205-212 行的第 0 次尝试 `await io.writeFile(path, claim, { createOnly: true, mode: 0o600 }); return { path, token };`，它不读盘不判陈旧，只要撞上真空窗口就直接成锁。因此「陈旧锁 + 抢占赢家 + 窗口内第三个申领者」三方竞争后，赢家与第三者会同时持有对同一 JSONL 的写权；赢家后续 releaseWriterLock（writerLock.ts:236-238 `if (held?.owner?.token !== lock.token) return false;`）返回 false，而 store.ts:583-589 的 close() 只 `await releaseWriterLock(this.io, this.lock);` 丢弃返回值，无日志无事件。git log -- writerLock.ts 只有 280f49fc 与 T015 的 ce2a7af8 两次改动，当前代码即 T015 之后态。测试 /home/ai/code/ai-client/src/runtime/__tests__/sessionWriterLock.test.ts:228-272 只钉住两方竞争（afterFirstRead 的慢进程、两个并发 acquire），没有覆盖「写回撞 EEXIST」分支。严重级给 medium 而非 high：触发需先有陈旧锁、再有一方抢占失败、且第三方恰好落在 rename 与写回之间的微秒窗口；应用有 single-instance 锁（src/main/index.ts:269），同一会话三个写者只能靠 worker 交替期的churn 凑出，可达性很低，但缺口与后果（两写者交织同一 JSONL）真实存在。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第101行（roadmap 任务表 T031 行）；相关原文：「T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数；NodeRuntimeResolver、taskkill 路径、路径拼接与 glob 展开、会话文件路径；TSD helper 契约用替身固化 | 批评者缺口 12/13/14/15/16 | 形成批次 E 的检查单」

### [concurrency-02] MEDIUM robustness confirmed | P3-1 | src/runtime/plugins/session/writerLock.ts:128 | pid 被复用后陈旧锁永远判不成陈旧，会话永久打不开且界面无补救入口（静态推断）
DESC: stale() 的全部判据是「这个 pid 现在还存在吗」。worker 被 SIGKILL（Main 的 forceKillNow、dispose ACK 超时后的强杀、崩溃）会留下锁；系统之后把这个 pid 号分配给任意别的进程，这把锁就再也不会被判为陈旧，每次打开都抛 session_locked。锁里其实写了 acquiredAt（writerLock.ts:201）、类型里也声明了，但全模块没有任何地方读它。全仓（除 runtime 自身）没有 session_locked 的消费者，Main 与渲染层都没有「强制打开 / 清理锁」的入口，用户只能手工删 userData 深处的 <session>.jsonl.writer.lock。Windows 的 pid 回绕比 Linux 快，现场概率高于开发机——这一半属静态推断，需上机确认。
EVIDENCE: function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}

// 同文件 24-31：acquiredAt 记了但无人读
export interface WriterLockOwner { pid: number; host?: string; token: string; acquiredAt?: number; }
SCENARIO: 用户在一次会话跑到一半时强制退出应用（或应用崩溃），worker 来不及跑 dispose，锁留在盘上记着 pid 4711。用户继续用机器、几小时后重启应用，此时 pid 已回绕并把 4711 分给了别的程序（浏览器标签进程、语言服务器都行）。点开那条聊天：acquireWriterLock → EEXIST → 读到 owner 4711 → processAlive 为真 → 判「有活写者」→ 抛 session_locked: session already has a writer (pid 4711 on …)。这条聊天从此每次打开都失败，界面上只有一个 bootstrap 失败，没有任何可点的恢复动作。
FIX: 把「pid 还在」收窄成「pid 还在且它就是我们的 worker」：锁里额外记可交叉验证的身份（POSIX 可用进程启动时间 / /proc，跨平台最小版本是应用实例 id + 启动时间戳）；或退一步用 acquiredAt——超过明显安全的年龄（如 24 小时）且本次启动从未持有过它就允许接管。再加产品兜底：session_locked 冒泡到 Main 时给用户一个「该会话被另一个窗口占用，仍要打开？」的显式动作。
REFUTER(CONFIRMED,medium): 静态推断，但代码事实全部核对属实。/home/ai/code/ai-client/src/runtime/plugins/session/writerLock.ts:127-132：`function stale(held: LockFile): boolean { const owner = held.owner; if (owner === undefined) return true; if (owner.host !== undefined && owner.host !== hostname()) return false; return !processAlive(owner.pid); }`，唯一判据就是 pid 是否存在；processAlive（同文件 65-73）用 `process.kill(pid, 0)`，EPERM 也算活。acquiredAt 在 201 行写入、89 行解析，但 grep acquiredAt 全 runtime 只有 writerLock.ts:30/89/201 与测试 sessionWriterLock.test.ts:122 四处，没有任何判定读它 —— 「记了但无人用」成立。session_locked 的消费者：grep 全仓（src/ 去掉 node_modules）只命中 writerLock.ts 自身与 runtime 测试，Main 与渲染层没有任何「强制打开 / 清理锁」入口，recovery.ts 也不碰锁（其中 'lock' 命中只是 'block'）。所以 pid 回绕后该会话每次打开都抛 session_locked，用户只能手删 sidecar。严重级维持 medium：后果是单条会话永久打不开（数据仍在盘上，未损坏），概率取决于平台 pid 回绕，未实测。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第101行（T031 行）；相邻但不等同的旧文档：docs/plantree/plans/runtime-evolution/evidence/p3/completion/README.md「已知限制与下一步」；相关原文：「T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数…」
合并：windows-06 并入本条（同一根因：src/runtime/plugins/session/writerLock.ts:128 判定陈旧锁只看 PID 是否存活，PID 被系统复用后这把锁永远判不成陈旧。concurrency-02 从并发角度提出（会话永久打不开、界面无补救入口），windows-06 从 Windows 角度提出同一行代码（Windows 的 PID 复用更快，且 acquiredAt 记了却没人读）。修法是同一个：把 acquiredAt/启动时间或进程签名纳入陈旧判定，并给界面一个强制接管入口。windows-06 补充的「acquiredAt 已记录但无读者」要并进修复范围。）

### [concurrency-05] MEDIUM robustness confirmed | P5-3 | src/runtime/host/exec.ts:171 | worker 被强杀时 MCP 子进程不随之退出，回收只能指望服务器自己认 stdin EOF（静态推断）
DESC: 长驻子进程在非 Windows 上以 detached: true 启动，自成进程组、不随父进程终止。干净 dispose 的路径完整（runtimeExec.shutdown() 杀掉所有登记子进程，McpPlugin.close() 再兜一次），但 worker 并不总是干净退出：Main 在 dispose ACK 超过 3 秒后直接杀进程（WorkerSlot.ts:93 的 DEFAULT_DISPOSE_TIMEOUT_MS 与 finalizeDisposed 的 killCurrentTransport），forceKillNow() 在导入失败路径上也直接杀，崩溃更不必说。这些情况下没有任何人杀 MCP 子进程，唯一退出机制是它自己发现 stdin EOF。Windows 上更长一截：MCP 服务器是经 node.exe 运行器起的孙进程，taskkill /T 只在 exec 层自己的 kill 路径里跑，载体被杀时不会执行。Windows / utility 形态属静态推断。
EVIDENCE: // src/runtime/host/exec.ts:163-173（spawnPersistent，MCP 服务器走这条）
    const child = spawn(nodePath ?? request.command, nodePath ? [execRunnerPath()] : [...request.args], {
        cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32',

// src/main/services/agent-host/WorkerSlot.ts:603-605（ACK 超时后无条件杀）
    const exitPromise = this.waitForTransportExit(transport, generation);
    this.detachCurrentTransport();
    this.killCurrentTransport();
SCENARIO: 会话空闲 15 分钟被 reclaimIdle 驱逐，worker 在 dispose 时正卡在一次慢 MCP 调用上（单次调用预算与 bash 同级，远大于 3 秒），3 秒 ACK 预算耗尽，Main 杀掉 worker 进程。worker 的 ctx.effect 清理没跑完，它拉起的 MCP 服务器进程组还在。一个不理会 stdin EOF 的服务器（自带 HTTP 端口的、或 Python 轮询式的）就此常驻，端口与内存不释放；用户重开这个会话又拉起一套，重复几次后端口冲突或内存告急，任务管理器里是一堆没有父进程的 node / python。
FIX: 两头都补。worker 侧：非 Windows 的进程组整杀路径已有（createTreeKiller），缺的是父进程非正常退出时谁来调用——可为长驻子进程登记进程组清单文件，或改用 detached: false 让它们随父进程会话终止（代价是失去进程组整杀，需与现有 killTree 一起权衡）。Main 侧：WorkerSlot 杀进程时 Windows 走 taskkill /PID <worker> /T /F，POSIX 对 worker 也用进程组杀（注意 kill(-pid) 必须有真实 pid，测试里要 mock）。
REFUTER(CONFIRMED,medium): 静态推断，链路核对属实。/home/ai/code/ai-client/src/runtime/host/exec.ts:162-173 的 spawnPersistent（MCP 走这条，见 mcp/index.ts:210 的 exec.spawn）以 `detached: process.platform !== 'win32'` 起子进程，非 Windows 自成进程组、不随父进程被杀；Windows 上必须经 node 运行器（exec.ts:156-160 无 nodePath 直接拒绝），MCP 服务器是孙进程。清理只挂在优雅路径：mcp/index.ts:383 `ctx.effect(() => () => this.close());`，close()（:451-457）只关 client。Main 的强杀不经过这些：WorkerSlot.ts:600-604 `const exitPromise = this.waitForTransportExit(transport, generation); this.detachCurrentTransport(); this.killCurrentTransport();` 在 DEFAULT_DISPOSE_TIMEOUT_MS = 3_000（WorkerSlot.ts:93）耗尽后无条件执行，另在崩溃路径 :584 同样直接杀；killCurrentTransport 只终止 worker 进程本身，POSIX 下杀父不会连带杀子，更不会杀已 detached 的进程组，Windows 的 taskkill /T 只出现在 exec.ts:371-372 与 :521-522 自己的 kill 路径里。于是 worker 被强杀后，MCP 子进程唯一的退出机制是它自己识别 stdin EOF —— 规范建议但不保证。维持 medium：后果是孤儿进程与端口/内存不释放，重复驱逐会累积，用户可见（任务管理器里一堆无父进程），但不损坏数据；Windows 孙进程形态未上机验证。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第101行（T031 行）；节点判定见 raw/concurrency.md 第67行；相关原文：「P5-3（MCP bridge）| complete-with-gaps | 连接预算、取消、关闭在单会话内是完整的；并发面缺全局进程预算（concurrency-04）与异常终止时的子进程回收（concurrency-05）。」

### [windows-02] MEDIUM robustness confirmed | P4-0 | src/runtime/host/exec.ts:518 | Windows 上一条已跑完的命令能否成功回报，取决于一个外部 taskkill 进程是否在 2 秒内退出（静态推断）
DESC: Windows 上 runPipe 强制走 runner 载体（:462-466 无 nodePath 直接拒），每条命令的正常结束路径是 runner 发 IPC exit 消息、父进程 stop('exit')（:642）、killTree(false)（:557）、spawn 一个 taskkill.exe 杀 runner 树。关键在于谁来 finish：child.on('close')（:610-619）只在 cleaners 为空时 finish，而 cleaners 从 killTree 那一刻起就非空；真正调 finish 的是 killer.on('close')（:533-538）。所以 Windows 上 runPipe 唯一的 resolve 出口是那个外部 taskkill.exe 跑完并退出 0，而 Linux 上对应的只是一次 process.kill 系统调用（:617 走另一分支）。两条坏路：其一，taskkill 起不来（SystemRoot 异常、EDR 或 HIPS 拦截、System32 不可达）时 killer.on('error')（:527）设 cleanupError，我在本机实测 Node 的 spawn 失败序列是 error 后接 close，close 会 finish(cleanupError) 即以拒绝形式结束——一条已跑完、stdout 已收全的命令抛 exec_cleanup_failed，且是该机器上每一次 bash 调用。其二，taskkill 超过 2 秒时 cleanupDeadline（:559-570，产品路径固定 2000 毫秒，见 host/worker.ts:44 的默认值，agent-host/worker.ts:93 不传覆盖）触发，报 command streams did not close before cleanup deadline，文案还是错的，流可能早关了，没跑完的是 taskkill。现场机器装着 TsdEncrypt.sys、TsdEncryptMF.sys、Sangfor aTrust、sprotect、HipsTray、DSATray（environment.md:28-32），进程创建正是这类产品挂钩子的地方。另注意这份 killTree 是 createTreeKiller（:336-404）的内联副本却没跟上 T022 的修正：killer.on('error') 少一句 cleaners.delete（对比 :378），且用直接赋值而非空值合并赋值（对比 :379）；目前因 close 会补上删除而不构成额外故障，但 createTreeKiller 有 5 条注入式用例，这份一条都没有。
EVIDENCE: src/runtime/host/exec.ts:516-538
    function killTree(force: boolean): void {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (windowsKillStarted) return;
        windowsKillStarted = true;
        const taskkill = join(process.env.SystemRoot ?? 'C:(反斜杠)Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        cleaners.add(killer);
        killer.on('error', (error) => {
          cleanupError = new RuntimeHostError('exec_cleanup_failed', 'taskkill could not start', { cause: error });
          child.kill();
        });
        killer.on('close', (code) => {
          cleaners.delete(killer);
          if (code !== 0)
            cleanupError ??= new RuntimeHostError('exec_cleanup_failed', 'taskkill exited ' + code);
          if (childClosed) finish(cleanupError);
        });

src/runtime/host/exec.ts:610-619（Windows 下这里从不 finish）
    child.on('close', (code, signal) => {
      childClosed = true;
      ...
      if (process.platform !== 'win32') killTree(true);
      if (!cleaners.size) finish(cleanupError);
    });

src/runtime/host/exec.ts:642（正常退出也走 stop）
          stop('exit');

Node spawn 失败事件序列（本机只读实测）：error,close:-2
SCENARIO: Windows 加密机，企业 HIPS 对 System32 下 taskkill.exe 的调用做同步检查或直接拦截。用户让模型跑 bash git status。命令 0.2 秒跑完、stdout 收全、runner 发出 IPC exit，父进程 spawn taskkill——taskkill 被卡住 3 秒或直接失败。2 秒到点 cleanupDeadline 触发，runPipe reject，bash 工具把 exec_cleanup_failed 当成工具错误抛给模型。模型看到命令失败，用户看到一条永远失败的 bash，而命令其实次次都成功。
FIX: 两件事分开做。第一，把成功与清理解耦：Windows 分支下 child.on('close') 且 reportedExit 为真时就应该 resolve 结果，taskkill 的失败改为记进结果的诊断字段或一条 trace 行，而不是把整个 run 变成 reject；命令已退出、输出已完整，与收尸干不干净是两回事。第二，把 runPipe 的内联 killTree 换成 createTreeKiller，消掉重复实现并让已有的 5 条注入式用例覆盖到这条路，再补两条：taskkill 起不来与 taskkill 超时，断言结果仍 resolve 且诊断里有清理失败。另外建议 Windows 上放宽 cleanupTimeoutMs 或改为可配，并把那句 streams did not close 的文案按实际卡住的对象分开写。
REFUTER(CONFIRMED,medium): 代码事实逐条核对无误。src/runtime/host/exec.ts:462-466 `if (process.platform === 'win32' && !nodePath) return Promise.reject(...)`，Windows 必走 runner；:642 IPC exit 后 `stop('exit')` → :557 `killTree(false)` → :518-526 win32 分支 spawn taskkill 并 `cleaners.add(killer)`；:610-618 `child.on('close')` 里 `if (process.platform !== 'win32') killTree(true); if (!cleaners.size) finish(cleanupError)`——cleaners 非空即不 finish；唯一补位是 :533-538 `killer.on('close')` 里 `if (childClosed) finish(cleanupError)`。所以 Windows 上成功回报确实挂在外部 taskkill.exe 的退出上，Linux 对应位置只是 :541 一次 process.kill。坏路二成立：:559-570 cleanupDeadline 到点 finish(new RuntimeHostError('exec_cleanup_failed','command streams did not close before cleanup deadline'))，是 reject；产品值 2000ms 已核（host/config.ts:16 `cleanupTimeoutMs: 2000`、host/worker.ts:44 `input.cleanupTimeoutMs ?? 2000`，agent-host/worker.ts:93 `workerHost({ carrier, ... })` 未传覆盖）。坏路一成立：:527-532 error 处理器设 cleanupError 并 child.kill()，随后 close 走到 finish(cleanupError)。我特意查了一条可能的反驳——runner 送出 exit 后是否立刻退出导致 taskkill 必然返回非 0：exec-runner.mjs:6 的 `process.on('message')` 保持 IPC 通道引用，runner 会一直活到被 taskkill 杀掉，所以常态下 code 0，这条反驳不成立但也说明这条路对时序敏感。重复实现也属实：createTreeKiller（:336-404，T022 于 84ac35e0 落地）只在 :175 spawnPersistent 用；runPipe 的内联版 :527 缺 `cleaners.delete(killer)`（对比 :378）、用直接赋值而非 `??=`（对比 :379），host.test.ts:754-864 的 5 条注入式用例一条都覆盖不到 runPipe 这条路。静态推断：taskkill 被 EDR 拖慢/拦截是环境假设，代码依赖关系是确定的。严重级 medium（已成功的命令被报成工具错误，用户可见功能错误，非卡死）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json waivers[node=P1-0, kind=field-only]；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md；相关原文：「Windows 分支调用 taskkill /PID /T /F 并等待关闭，尚未在 Windows 实测，尤其要核对中间命令进程已退出时的后代发现 /「待现场验证」「待复验」只豁免缺现场证据，不豁免代码本身的缺陷」

### [windows-03] MEDIUM windows confirmed | P4-0 | src/runtime/plugins/mcp/index.ts:211 | stdio 型 MCP 服务器在 Windows 上起不来：npx 与 uvx 与 npm 都是 .cmd，而链路上两次 spawn 都是 shell false（静态推断）
DESC: MCP 配置里的 command 原样交给 exec.spawn（mcp/index.ts:210-212），config.ts:213 只做了一次 trim，没有任何 Windows 形态处理。exec.spawn 进 spawnPersistent（exec.ts:152-174），Windows 上强制走 runner，runner（exec-runner.mjs:10-16）再以 shell false 去 spawn 真正的命令。Windows 上 CreateProcess 只会给无扩展名的可执行名补 .exe，不查 PATHEXT；而 MCP 生态最标准的配置写法就是把 command 写成 npx，Windows 上 npm 装出来的是 npx.cmd 与 npx.ps1 与一个 sh 脚本，没有 npx.exe，所以裸 npx 直接 ENOENT。用户若改写成绝对路径指向 npx.cmd 也过不去：Node 自 18.20.2 与 20.12.2 的 CVE-2024-27980 修复之后，spawn 一个 .bat 或 .cmd 而不给 shell true 会直接抛错，runner 的 try/catch（:19-24）把它转成 spawn-error，父进程报 exec_spawn_failed——至少可诊断，但服务器仍然起不来。另外 exec.ts:86 的入参校验对裸 npx 是放行的，所以不会在这一层被拦住报错。bash 工具不受影响，它传的是 resolveWorkerShell 解析出的 bash.exe 绝对路径。静态推断：CreateProcess 不查 PATHEXT、Node 拒绝无 shell 的 .cmd 都是平台与运行时的既定行为，但本仓无任何 Windows 执行证据，也没有 .cmd 相关用例。
EVIDENCE: src/runtime/plugins/mcp/index.ts:210-213
    const child = await exec.spawn({
      command: server.command,
      args: server.args,
      cwd: config.cwd ?? process.cwd(),

src/runtime/plugins/mcp/config.ts:213（唯一的加工只有 trim）
        command: entry.command.trim(),

src/runtime/host/exec-runner.mjs:10-16
    const command = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'inherit'],
    });

src/runtime/host/exec.ts:162-170（父侧同样 shell false）
    const child = spawn(
      nodePath ?? request.command,
      nodePath ? [execRunnerPath()] : [...request.args],
      { cwd: request.cwd, env: request.env, shell: false,
SCENARIO: Windows 用户按 MCP 官方 README 把 command 配成 npx、args 配成 -y 加一个 server 包名。会话启动后 connectOne 调 exec.spawn，runner 以 shell false 去 spawn npx，CreateProcess 找 npx.exe 找不到，ENOENT，runner 发 spawn-error，父进程报 exec_spawn_failed could not start npx。该 MCP 服务器的工具在整个会话里都不存在，而同一份配置在 Linux 与 macOS 上是好的。
FIX: 在 runner（或 spawnPersistent 组装参数处）加一层 Windows 可执行解析：给无扩展名的裸命令按 PATHEXT 顺序在 PATH 里查一遍；命中 .cmd 或 .bat 时改用 cmd.exe 加 /d /s /c 显式包装（不要开 shell true，那会把 args 重新按 shell 规则解析，引号语义不可控）。配套在 mcp.test.ts 加一条 Windows 形态用例（用注入的 spawn 替身，不需要真机），并在 MCP 配置校验里对 Windows 给一条明确诊断而不是裸 ENOENT。
REFUTER(CONFIRMED,medium): 链路与结论核实无误，找不到任何一层做 Windows 可执行名解析。mcp/index.ts:207-213 `const child = await exec.spawn({ command: server.command, args: server.args, ... })`；mcp/config.ts:213 `command: entry.command.trim()` 是唯一加工；exec.ts:86-91 的入参校验 `if (!request.command || (!isAbsolute(request.command) && /[\/\\]/.test(request.command)))` 对裸 `npx` 放行；exec.ts:98-102 Windows 强制 runner；exec.ts:104-114 父侧 `shell: false`；exec-runner.mjs:10-16 `spawn(request.command, request.args, { ..., shell: false, ... })`。全仓 grep `npx|PATHEXT|cmd.exe` 在 src/runtime 无任何命中（cmd.exe 只出现在 src/main 的 GitInstaller/PtyManager/ShellDetector，与 MCP 无关），bootstrap.ts:352-361 证明这条路在产品里真的会跑。平台事实侧：libuv 的 path_search 只补 .com/.exe 不读 PATHEXT，Node 18.20.2/20.12.2 起（CVE-2024-27980）无 shell 直接 spawn .bat/.cmd 会抛错，这两条是既定行为；本仓也确实没有任何 .cmd 形态用例。静态推断：无 Windows 执行证据。严重级 medium（Windows 上 stdio 型 MCP 服务器整类不可用，同一份配置在 Linux/macOS 可用）。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md（无相关行）；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md

### [windows-07] MEDIUM windows confirmed | P4-6 | src/main/services/terminal/PtyManager.ts:126 | 用 utf8 编码读 reg query 的输出，中文 Windows 上会把含非 ASCII 的 PATH 条目解码坏（静态推断）
DESC: getWindowsRegistryPath 用 execSync 跑 reg query 读注册表里的用户级与系统级 PATH，参数里写死 encoding 为 utf8，然后正则取值、拼起来当作终端的 PATH。reg.exe 通过管道输出时用的是控制台输出代码页（中文 Windows 默认 936 即 GBK），不是 UTF-8。用 utf8 解码 GBK 字节，所有非 ASCII 字符会变成替换字符。纯 ASCII 的 PATH 条目不受影响，但只要用户名或安装目录带中文（在中文 Windows 上非常常见），那一条 PATH 项就被解码坏，终端里对应的工具从此找不到。同一台现场机器上这类问题已经出现过一次：test12-reverify.md:278 记录初次读取遇到控制台 cp1252 无法输出中文的 UnicodeEncodeError、设置 PYTHONIOENCODING 为 utf-8 后成功重读——方向相反，但说明的是同一件事，这台机器的控制台不是 UTF-8。另外结果被 cachedWindowsPath 缓存，坏掉的 PATH 在整个进程生命周期里都不会重算。静态推断：需要一台中文 Windows 且 PATH 里有带中文的条目才能实测。
EVIDENCE: src/main/services/terminal/PtyManager.ts:122-134
    let userPath = '';
    try {
      const userOutput = execSync('reg query HKCU\\Environment /v Path 2>nul', {
        encoding: 'utf8',
        timeout: 3000,
      });
      const userMatch = userOutput.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      userPath = userMatch ? userMatch[1].trim() : '';
    } catch {
      // User PATH might not exist
    }

Windows-P4-6-evidence/test12-reverify.md:278
初次读取遇到控制台 cp1252 无法输出中文的 UnicodeEncodeError；设置该命令进程的 PYTHONIOENCODING=utf-8 后成功重读
SCENARIO: 中文 Windows，用户名是中文，用 scoop 装了工具链，用户级 PATH 里有一条位于中文用户目录下的 shims 路径。应用启动时 getEnhancedPath 调 getWindowsRegistryPath，GBK 字节按 UTF-8 解码，该条目里的中文变成替换字符，内嵌终端里通过 shim 提供的命令全部提示找不到命令，而同一台机器上用系统 PowerShell 是好的。
FIX: 两条路选一条。其一不解码：execSync 改用 buffer 编码拿到字节后，先查出控制台代码页再按它解码，或直接在命令前加 chcp 65001 强制 UTF-8 输出。其二不走 reg.exe：改用 PowerShell 的 Environment.GetEnvironmentVariable 读取，并设好输出编码。配套加一条单元用例：喂一段 GBK 编码的 reg query 样本字节，断言解析出的路径与原文逐字节相等。
REFUTER(CONFIRMED,medium): 推翻失败，代码事实成立且未被任何批次修过。src/main/services/terminal/PtyManager.ts:126-128 原文 `const userOutput = execSync('reg query "HKCU\\Environment" /v Path 2>nul', { encoding: 'utf8', timeout: 3000 });`，系统级同样写法在 :140-142。审查员引用的原文少了路径两侧引号（实际带引号），仅此一处抄录差异，行号 122-134 与实际 117-160 的函数体一致，未读错行、未读错分支（HEAD ebc82f16 即为当前工作树内容）。触发路径真实存在且是活代码：PtyManager.ts:223-230 `export function getEnhancedPath()` 在 `isWindows` 分支里 `return getWindowsRegistryPath();`，其调用方为 src/main/utils/shell.ts:139 `PATH: getEnhancedPath()` 与 src/main/services/git/runtime.ts:110 同名用法，即 Windows 上终端/Git 子进程的 PATH 完全由这段注册表读取结果替换掉 process.env.PATH（后者由 Node 从 UTF-16 正确解码，反而被丢弃）。结果缓存在模块级 `cachedWindowsPath`（:16、:155），进程生命周期内不重算，只有 `clearPathCache()`（:27-31）能清。同一缺陷面比发现描述的更宽：:66-68 与 :78-80 的 `getWindowsRegistryEnvVars` 读全量环境变量时也写死 `encoding:'utf8'`，其值还被 `expandWindowsEnvVars`（:97-111）用于 %VAR% 展开。是否已修：`git log --oneline -- src/main/services/terminal/PtyManager.ts` 最近 8 条（8aafd450、19848abf、368559c3 …）无一涉及编码；全仓 grep `chcp|65001|OEMCP|codepage` 在 src 下只命中 src/main/ipc/files.ts:41 的 `gbk:'gbk'`（文件读取的编码表，与此无关），说明没有任何代码页处理。测试也没钉住：src/main/services/terminal/__tests__ 下只有 PiTuiPty/ShellDetector/piTui*/t35FinalAbsence，两处 git 测试（gitStatusFailureModes.test.ts:11、tsdWorkingTreeRead.test.ts:11）反而把 `getEnhancedPath` 直接 mock 成 `process.env.PATH`，注册表解码路径零覆盖。现场佐证方向与发现一致：Windows-P4-6-evidence/test12-reverify.md:278 记录该机控制台不是 UTF-8（cp1252 报 UnicodeEncodeError），只是那台机器用户名是 ASCII（JC），所以没暴露。静态推断：reg.exe 走管道时按控制台输出代码页写字节（中文 Windows 936），需一台中文 Windows 且 PATH 内含非 ASCII 字面路径（如 scoop 写入的 `C:\Users\张三\scoop\shims`）才能实测；`toString('utf8')` 对非 UTF-8 字节静默产出 U+FFFD 则是确定的语言事实。严重级与审查员一致取 medium：属于用户可见的功能错误（内嵌终端里该条 PATH 下的工具全部找不到），不构成安全绕过或数据损坏。
WAIVER(none): 无 — docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json（全文检索 reg query/PtyManager/PATH 编码，均无匹配）；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md

### [windows-09] MEDIUM i18n confirmed | P4-6 | src/runtime/plugins/tools/index.ts:474 | bash 工具把子进程输出一律按 UTF-8 解码，Windows 原生工具的 OEM 代码页输出会变成一串替换字符进模型上下文（静态推断）
DESC: bash 工具把 stdout 与 stderr 直接用 Buffer 的 toString utf8 转成字符串（:474-475）。这个转换是有损的：非法字节序列静默变成替换字符，不抛错、不提示。Windows 上这不是理论问题：默认 shell 是 Git Bash（MSYS），MSYS 自带的工具输出 UTF-8 没问题，但模型经常会在 bash 里调 Windows 原生程序，例如 cmd 的 dir、python、java、dotnet 以及各种 exe 构建工具。这些程序写管道时用的是 ANSI 或 OEM 代码页（中文 Windows 上是 936），于是任何中文文件名、中文报错、中文日志都会变成替换字符串进模型上下文和会话文件。模型看到的是乱码，既不知道原文是什么，也不知道这是编码问题，会把乱码当成程序的真实输出去推理。对照：read 工具在这件事上做对了，decodeFileText 用 fatal 为 true 的 TextDecoder，非 UTF-8 会抛 io_not_utf8 并明确告诉模型这可能是二进制文件（read-lines.ts:27-41，tools-12 修过），bash 的输出路径没有同等待遇。静态推断：需要中文 Windows 跑一次带中文输出的原生命令才能确认；toString utf8 有损且无检测是确定的代码事实。
EVIDENCE: src/runtime/plugins/tools/index.ts:472-476
        return result(
          Buffer.from(output.stdout).toString('utf8') 加上 output.stderr 非空时拼接的 [stderr] 段（同样是 toString('utf8')）,

对照 src/runtime/plugins/tools/read-lines.ts:27-41
export function decodeFileText(decoder, bytes, stream, path): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new RuntimeHostError(
      'io_not_utf8',
      path + ' is not valid UTF-8 text; it is probably a binary file'
    );
  }
}
SCENARIO: 中文 Windows，工作区里有一个中文命名的目录。模型调 bash 跑 cmd 的 dir。cmd.exe 用 CP936 写出中文文件名，管道字节按 UTF-8 解码后目录列表里的中文全变成替换字符。模型据此判断这些文件名乱码或损坏，或在后续命令里原样引用乱码文件名导致命令再次失败。用户看到模型在一个明明正常的目录里反复出错。
FIX: 在 bash 结果编码这一步加一次可检测的解码：先用 fatal 为 true 的 TextDecoder 试；失败时不要直接降级成有损解码，而是其一在结果尾巴的状态行里加一句说明输出不是合法 UTF-8，让模型知道发生了什么；其二 Windows 上可选地按控制台代码页做二次解码（Node 内置 TextDecoder 支持 gbk 等标签，随包 Node 是官方发行版默认带完整 ICU）。至少第一条必须做，它不需要任何平台知识。另外建议在 bash 工具描述里提示模型在 Windows 上优先用 MSYS 工具。
REFUTER(CONFIRMED,medium): 推翻失败。src/runtime/plugins/tools/index.ts:473 原文 `` `${Buffer.from(output.stdout).toString('utf8')}${output.stderr.length ? `\n[stderr]\n${Buffer.from(output.stderr).toString('utf8')}` : ''}` ``（审查员写 :474，实际 :473，属一行内的行号偏差，不影响结论）。`output.stdout/stderr` 是字节（同一处注释写明「The raw result carries stdout/stderr as Uint8Array」），`toString('utf8')` 对非法序列静默替换为 U+FFFD，不抛错、不标记，结构化元数据里只有 exitCode/termination/stdoutBytes 等标量，没有任何「输出不是合法 UTF-8」的信号。对照成立：src/runtime/plugins/tools/read-lines.ts:18-19 `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` 与 :27-41 `decodeFileText` 抛 `RuntimeHostError('io_not_utf8', ...)`，同仓 policy.ts:84、session/store.ts:156、instructionSource.ts:45 也都用 fatal 解码，唯独 bash 输出这条路没有。Windows 触发路径真实：src/runtime/worker/nativeWorkerRuntime.ts:197 `shellPath: resolveWorkerShell(this.options.host.childEnv)`，src/runtime/host/shell.ts 的候选清单是 `ProgramFiles/Git/bin/bash.exe` 等 Git Bash（MSYS），模型在其中调 cmd 的 dir、python、java 等原生程序时输出按 ANSI/OEM 代码页（中文 Windows 936）写管道，经此处按 UTF-8 解码即成替换字符并进入模型上下文与会话文件。是否已修：`git log -- src/runtime/plugins/tools/index.ts` 中与输出形态相关的是 T012（439ab922「工具输出形状」）与 tools-06 的标量化注释，均未触及解码；grep 全仓无代码页处理；批次 A～C 的 roadmap Done 段（T001～T036）无对应条目。测试未钉住该行为。静态推断：需中文 Windows 跑一次带中文输出的原生命令才能实测，但有损且无检测是确定的代码事实。一个反向提醒（不改变判定，影响修法）：该调用用 `maxOutputBytes: TOOL_OUTPUT_BYTES` 且 `overflow:'truncate'`，截断可能落在多字节字符中间，若照建议直接换成 fatal 解码，会把合法 UTF-8 的长输出误判为非 UTF-8，修复需先按截断边界处理再判定。严重级维持 medium：用户可见的错误行为（模型拿到乱码并据此推理），不属安全绕过或数据损坏。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md（无相关行）；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md

### [capacity-01] MEDIUM capacity confirmed | P3-1 | src/runtime/plugins/agent-loop/attachments.ts:34 | 用户附件无任何服务端体积上限，正常使用即可在个位数消息内顶满 32 MiB 会话预算（审查员原判 high）
DESC: 附件体积的唯一约束是渲染层一个纯前端函数 admitAttachment（DEFAULT_ATTACHMENT_LIMITS：单次发送总量 ≤10 MB 原始字节）。preload 原样转发 CHAT_SEND payload、Main 的 IPC 处理器与 WorkerManager.send() 都不做字节校验、runtime 侧 preparePrompt() 只判断 kind 不判断大小，images.push/documents.push 直接把 attachment.data 全量塞入。图片落盘是 base64（膨胀系数 ~1.34），渲染层允许的单次 10 MB 上限落盘约 13~14 MB，不需要任何绕过手段，正常发 2~3 条带图片的消息即可逼近/压过 32 MiB 会话预算。
EVIDENCE: src/runtime/plugins/agent-loop/attachments.ts:34-42（images.push({ data: attachment.data, ... }) 无大小判断）；src/main/ipc/chat.ts:471-487（CHAT_SEND 声明 attachments 类型后直接 workerManager.send({ ...payload }) 无校验）；src/preload/index.ts:1045（ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload) 原样转发）；src/main/services/agent-host/WorkerManager.ts:1648,1673（attachments 原样透传给 worker）
SCENARIO: 用户连续发送 2~3 条各含多张照片的消息（均在渲染层允许上限内，无需特殊操作），每条落盘约 13~14 MB；第三条大概率触发 session_size_limit 被拒（store.ts:291），或在预算被其它内容（工具输出/压缩摘要）预先占用的情况下更早触发；一旦某次写入恰好让文件越过 32 MiB（例如外部并发写入），下次 store.open() 走 io.readFile({ maxBytes, overflow:'error' })（store.ts:155）直接抛 io_limit——T034 的中段坏行自愈救不了，因为文件在被完整读入前就已被字节数上限拦下。会话从此永久打不开。
FIX: 在 Main 的 CHAT_SEND 处理器或 WorkerManager.send() 补一道与渲染层 DEFAULT_ATTACHMENT_LIMITS 对齐（或更严格）的服务端校验，超限直接拒绝；同时在 runtime 侧 preparePrompt() 加一道独立的最终防线（per-attachment/per-call 字节上限），与 MCP 图片已采用的双重上限模式对齐。
REFUTER(CONFIRMED,medium): 机制属实，但最坏后果被夸大，故降一级。逐行核对：(1) runtime 侧确实只判 kind 不判大小 —— src/runtime/plugins/agent-loop/attachments.ts:34-39 `if (attachment.kind === 'image') { images.push({ type: 'image', data: attachment.data, mimeType: attachment.mediaType || 'image/png' }); }`；对比 src/runtime/plugins/mcp/index.ts:290-297 的 `MCP_MAX_IMAGES=8` 与 `if (bytes > MCP_IMAGE_BYTES || imageBytes + bytes > MCP_IMAGE_TOTAL_BYTES)`，双重上限确实只给了 MCP 图片。(2) Main 侧无字节校验：src/main/ipc/chat.ts:471-488 声明 attachments 类型后直接 `const requestId = await workerManager.send({ ...payload, ownerWebContentsId })`；WorkerManager.ts:1673 `...(input.attachments ? { attachments: input.attachments } : {})`；preload/index.ts:1045 `ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload)`；contracts.ts:249 `attachments?: readonly SessionAttachment[]` 也无校验。Main 唯一的 5 MiB 闸门在另一条路上（shared/types/attachmentIo.ts:35 `MAX_ATTACHMENT_READ_BYTES = 5*1024*1024`，只管 file:readAttachment 的读盘，粘贴路径不经过它）。(3) 确实落盘：pi-agent-core/dist/agent-loop.js:52-53 对每条 prompt `await emit({ type: 'message_end', message: prompt })`，agent-loop/index.ts:463 `if (event.type === 'message_end' && session) await session.appendMessage(event.message)`，store.ts:230-232 `appendEntry({ type:'message', message: structuredClone(message) })` 原样写入 base64。渲染层 DEFAULT_ATTACHMENT_LIMITS（attachmentLimits.ts:40-45，5 张 / 单图 5 MiB / 单次 10 MiB 原始字节）base64 后约 13.4 MiB/条，2~3 条即可顶满 codec.ts:20 `SESSION_MAX_BYTES = 32*1024*1024`。反驳到的部分：审查员说「会话从此永久打不开」不成立于应用自身写入路径 —— store.ts:290、499、561 三处写入前都判 maxBytes，io.ts:264-266 只在 `bytes.length > options.maxBytes` 才抛 io_limit，恰好等于上限仍能打开，所以自伤不会越过 32 MiB（唯一未校验的重写是 store.ts:170-198 的 open 期 interop 头升级 `document.repair` 直接 writeFile，旧格式会话恰好顶满时才可能越界，条件很窄）。真实后果是会话变只读：store.ts:290-293 抛 session_size_limit 后 enqueue（store.ts:308-320）把 tail 永久置为 rejected，后续写入一律拒绝——records.ts:345 自己的注释就写着「throws `session_size_limit` and the conversation becomes a read-only artifact」。属用户可见的功能性损坏，非数据丢失/安全绕过，定 medium。未被批次 A～C 修：git log 显示 attachments.ts 最近一次改动是 2c0eb30c（T014），T024 的对账表第六节把它列为「待落地（禁改）」。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md 第六节「待落地」表格第一行；docs/plantree/plans/runtime-hardening/roadmap.md T024 行；相关原文：「用户附件（图片与文本）无任何体积上限 | plugins/agent-loop/attachments.ts:34-42 | T024 禁改 agent-loop。体积由用户选文件决定，比 MCP 可控，但同样绕过所有闸门直接落盘」

### [tsd-02] MEDIUM robustness confirmed | P1-4（经 P1-2 的读出口触发） | src/runtime/plugins/tools/index.ts:612 | grep 的逐文件 readFile 没有容错，一个读不了的文件让整次搜索失败
DESC: walk() 已按 T010 的修法对遍历错误容错（index.ts:770 与 772-774 用 isSkippableIoError 跳过 EACCES/ENOENT/ELOOP…），但 walk 吐出文件之后，grep 主循环里的 io.readFile 是裸的——没有 try/catch，也没有过 isSkippableIoError。OPTIONAL_FILE_ERRORS（index.ts:53）只含六个 POSIX 码，io_tsd_unavailable / io_tsd_unreadable / io_limit 都不在其中，而且这里根本没走到那个判断。后果是任何单个文件的读失败把整次 grep 变成一条工具错误，模型拿不到已经命中的结果。这条不依赖加密环境：普通 Linux 上一个 chmod 000 的文件就能复现（目录可读、dirent 说它是 file，walk 会列出它，readFile 时才 EACCES）。加密机上则是 tsd-01 与 tsd-07 的放大器。与 T010 修掉的悬空 symlink（tools-01，当时评 high）是同一类，只是修在了遍历层没修在读取层。
EVIDENCE: src/runtime/plugins/tools/index.ts:598-615
        for await (const file of walk(io, root, budget, (file) => ..., signal)) {
          if (included && !included(file)) continue;
          if (pathPolicy(file) !== 'allow') { skipped++; continue; }
          const data = await io.readFile(file, {
            maxBytes: SEARCH_FILE_BYTES,
            overflow: 'truncate',
            signal,
          });

对照 index.ts:770-775（walk 内部，有容错）：
        } catch (error) {
          if (!isSkippableIoError(error)) throw error;
          continue;
SCENARIO: 工作区里有一个 chmod 000 的文件（CI 产物、root 拉起的日志、别人的目录）。模型执行 grep {pattern:'TODO'}，walk 把它列出来，io.readFile 抛 EACCES，异常冒出 execute，整次 grep 返回错误；已经扫到的匹配全部丢弃。模型看到的是「grep 失败」，无从得知是哪一个文件、也不知道其余结果本来是好的。加密机变体：一个当前进程解不了的受策略文件抛 io_tsd_unavailable，后果相同。
FIX: 与 walk 同款处理：把这次 readFile 包进 try/catch，isSkippableIoError(error) 为真时 skipped++ 并 continue；同时把 io_tsd_unavailable / io_tsd_unreadable / io_not_utf8 也纳入可跳过集合（加密文件与二进制文件对 grep 而言都是「扫不了」，不是「搜索失败」），并把 skipped 条数报给模型（现有 skipped 计数已有出口）。补两条用例：chmod 000 文件（POSIX 下 skipIf win32）与魔数开头的明文文件各一条。
REFUTER(CONFIRMED,medium): 成立，T010 只修了遍历层没修读取层。src/runtime/plugins/tools/index.ts:604-614：`for await (const file of walk(...)) { if (included && !included(file)) continue; if (pathPolicy(file) !== 'allow') { skipped++; continue; } const data = await io.readFile(file, { maxBytes: SEARCH_FILE_BYTES, overflow: 'truncate', signal });` —— 这句没有 try/catch，从 :575 到 :672 之间唯一的 try 是 :578-592 包 `new RegExp` 的那个。对照 walk 内部 :772-775 `catch (error) { if (!isSkippableIoError(error)) throw error; }`（T010 `1262e3b0` 的修法，roadmap.md:20/64 记为 tools-01/07）。错误不会被改写：src/runtime/host/io.ts:61-73 的 track() 只在 disposed 与非绝对路径两种情况构造 RuntimeHostError，其余 fs 拒绝原样透出，故 chmod 000 文件在 `open(path,'r')`（io.ts:110）抛 EACCES 直接冒出 execute，整次 grep 变一条工具错误，已命中的 matches 全丢。触发不依赖加密环境（stat 对 chmod 000 文件仍成功、dirent 报 file，walk 会 yield 它）。测试未钉住：tools.test.ts:310-327 那条 EACCES 用例替身的是 `r.ctx.runtimeHostIo.readDirectory`，注释写明 'Fake HostIo error: EACCES on one directory'，readFile 半边没有对应用例。严重级维持 medium：功能错误、模型可见的错误行为，无数据损坏与卡死。
WAIVER(none): 无 — 已查 docs/plantree/plans/runtime-hardening/roadmap.md T010/T012 条目、docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md、findings.json waivers（P1-4 相关两条：index 3、53）

### [tsd-03] MEDIUM robustness confirmed | P4-0 | src/main/services/agent-host/WorkerTransport.ts:56 | utility 载体的 worker stdout 从不排空，node 载体排空——D11 第 5 条只落实了一半（静态推断）
DESC: PiWorkerProcess.ts:94-100 给 utilityProcess 传 `stdio: 'pipe'`，所以 worker 的 stdout 是一根真管道。createNodeProcessWorkerTransport 在 WorkerTransport.ts:97-98 有一行显式的 `proc.stdout?.resume()`，注释写明「drain ordinary stdout so tool/extension logs cannot fill its pipe」；createUtilityProcessWorkerTransport（:56-93）没有对应的一行，onStderr 只订阅 stderr（:82-84），全仓再无第二处碰 proc.stdout（`grep -rn stdout src/main/services/agent-host/*.ts` 只命中 NodeRuntimeResolver 与这一行）。ARD D11 第 5 条把「子进程的普通 stdout 必须排空」写成硬约束，p1-0 契约第 10 节也把「真实 stdout 不混进 worker RPC」列为验收点。后果的准确说法：Node 里管道 stdout 是异步写，写入端不会立刻阻塞，而是把数据排进本进程内存队列，所以第一现场是 utility worker 内存单调增长、日志永远不落地，极端情况下才表现为写入方停摆。我们自己的代码全部写 stderr（agent-host/worker.ts:142/160/165 都是 console.error），触发要靠第三方（pi-ai / cordis / MCP 客户端 / 未来插件）往 stdout 打日志——这正是 D11 那条约束存在的理由。static_inference：是，「未排空」是 100% 确定的代码事实，「后果」按 Node/libuv 语义推断，未在 Electron 实测。
EVIDENCE: src/main/services/agent-host/WorkerTransport.ts:96-99（node 载体，有排空）
export function createNodeProcessWorkerTransport(proc: ChildProcess): WorkerTransport {
  // RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe.
  proc.stdout?.resume();

src/main/services/agent-host/WorkerTransport.ts:56-58（utility 载体，无对应行）
export function createUtilityProcessWorkerTransport(proc: UtilityProcess): WorkerTransport {
  return {
    get pid() {
SCENARIO: 打包后的 macOS / Linux（或任意平台的开发态）上跑一个会 console.log 的 MCP 客户端库或第三方插件。utility worker 的 stdout 没有任何读者，输出在 worker 进程内排队；一个长会话下来 worker 内存持续上涨而 Main 侧看不到任何日志，排查时也拿不到这些行。冒烟脚本发现不了：scripts/runtime-smoke/electron-carrier.cjs:31 自己订阅了 child.stdout 并转写到父进程 stdout，探针环境里管道是被读的。
FIX: 在 createUtilityProcessWorkerTransport 里加一行 `proc.stdout?.resume()`；更好的做法是两个 transport 共用一个 drainStdout(proc) 辅助，并把 stdout 也接到 hostStderr.ts 的按行组装上（标注来源 stream），这样第三方日志既不积压也不消失。补一条单测：用替身 proc 断言构造后 stdout 处于 flowing 模式（readable.readableFlowing === true），两个 transport 各一条。
REFUTER(CONFIRMED,medium): 成立且是 100% 确定的代码事实。src/main/services/agent-host/WorkerTransport.ts:96-98 node 半边有 `// RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe.` + `proc.stdout?.resume();`；:56-93 的 createUtilityProcessWorkerTransport 从 `get pid()` 到 `kill()` 逐行看过，只有 :81-83 `onStderr(listener) { return subscribeReadable(proc.stderr, listener); }`，全函数不出现 stdout。`grep -rn stdout src/main/services/agent-host/` 仅命中 NodeRuntimeResolver.ts（execFile 取版本）与这一行 :98。管道确实存在：PiWorkerProcess.ts:94-100 `utilityProcess.fork(entryPath, [], { ..., stdio: 'pipe', ... })`。这违反 ARD 硬约束——docs/plans/2026-09-08-runtime-evolution-ard.md:231 D11 第 5 条原文『子进程的普通 stdout 必须排空，RPC 走独立通道，避免工具日志写满管道』，p1-0 契约 docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md:21 亦有『普通 stdout 必须排空』、:300 验收点『真实 stdout 不混进 worker RPC』。git log -S'stdout?.resume' 只出 78168b4d（P4-0 加 node 半边），批次 A～C 未碰。测试未钉住：__tests__/WorkerTransport.test.ts:15-20 的 FakeUtilityProcess 只有 `stderr = new PassThrough()`，根本没有 stdout 字段；node 半边反而有真子进程用例（:36-66，worker 里写了 `process.stdout.write('ordinary output is not RPC')`）。冒烟也发现不了：scripts/runtime-smoke/electron-carrier.cjs:31 `child.stdout.on('data', data => process.stdout.write(data))` 自己把管道读走了。后果按 Node/libuv 语义推断（写入端排队于 worker 内存、日志永久丢失），未在 Electron 实测——此半为静态推断。严重级维持 medium：触发要靠第三方库往 stdout 打日志（我们自己的 agent-host/worker.ts 全用 console.error），但一旦发生是长会话内存单调增长 + 排查证据缺失。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md 第21行；docs/plans/2026-09-08-runtime-evolution-ard.md D11 第5条；相关原文：「Windows 安装版缺少随包 Node 必须失败；worker RPC 仍由 WorkerTransport 负责；普通 stdout 必须排空。（D11 第5条：子进程的普通 stdout 必须排空，RPC 走独立通道，避免工具日志写满管道）」
合并：main-host-04 并入本条（同一根因：src/main/services/agent-host/WorkerTransport.ts 里 utilityProcess 支路不排空 worker 的 stdout，而 child_process 支路显式 resume() 并写明了原因（D11 第 5 条只落实了一半）。tsd-03 锚在 :56、main-host-04 锚在 :96，是同一个分支对的两侧，一次补上 utility 支路的 resume() 即同时消除。保留 tsd-03，因为它的严重级是 medium（main-host-04 记为 low），取组内最高。）

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
