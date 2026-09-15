# 批次 D 补审发现：high 级（3 条）

Role: evidence（source material，原文保留）；来源：2026-09-15 批次 D 只读补审（T029 / T030 / T031，基线 HEAD `ebc82f16`，65 个代理）。严重级取反驳者裁定（`final_severity`）。本文件只收 `confirmed` 与 `confirmed-partial-waiver`；待定 / 推翻 / 取舍见 [findings-uncertain-refuted-waived.md](findings-uncertain-refuted-waived.md)，接缝与批评者全文见 [cross-and-critic.md](cross-and-critic.md)，总览见 [README.md](README.md)。

统计：区域发现 3 条（main-host-aux 1 · session-index 1 · windows-static 1），接缝发现 0 条；其中部分取舍 0 条、静态推断 2 条、被去重并入 0 条。

每条发现的格式：`[编号] 严重级 类别 最终状态 | 节点 | 文件:行 | 标题`，随后是审查员描述（DESC）、引用代码（EVIDENCE）、失败场景（SCENARIO）、修法建议（FIX）、反驳者结论（REFUTER）与文档取舍核对（WAIVER）。最终状态：confirmed=反驳者确认且无取舍；confirmed-partial-waiver=确认但文档部分取舍；uncertain=无法构造触发路径也无法排除；refuted=被推翻；waived=文档明确取舍、不计入。

标题行的补充标记：`（审查员原判 x）`=反驳者改过严重级，以标题行开头的严重级为准；`（静态推断）`=结论来自静态阅读、本轮无任何现场执行；`→ 并入 <编号>`=接缝审查员判为同一根因的重复条目，原文保留、修补时跟着 keep 那条走，被并入的条目不计入独立缺陷数。接缝审查员直查的 4 条 `d-cross-*` 没有 REFUTER / WAIVER 段，改写一行 SOURCE。

排列顺序：T029 九区（main-host-aux / main-host / utility-chain / session-index / import-upstream / terminal-tui / agent-host-lib / chat-tool-vocab / chat-event-vocab）→ T030 五区（smoke-p0-6 / cordis-spike-d1 / baseline-comparability / field-nodes / h-nodes）→ T031 四区（concurrency / windows-static / capacity-leftovers / tsd-utility）→ 接缝。区域原文报告在 `raw/<区域>.md`。

### [main-aux-01] HIGH security confirmed | F2-b | src/main/services/agent-host/ScratchWorkspaceService.ts:130 | scratch 根的越界守卫用不解析 `..` 的前缀比较，adopt 能创建、release 能递归删除根外任意目录
DESC: isScratchPath 把候选路径与根路径都过 canonicalPathKey 后做字符串前缀比较，而 canonicalPathKey（src/shared/utils/path.ts:58）只做分隔符归一、去尾部分隔符、转小写，不解析 `.` 与 `..`。于是任何以 scratch 根开头、后接 `../` 的字符串都被判为「自己的目录」。两个下游：adopt()（:172）拿它当唯一准入检查后 mkdir(existingPath,{recursive:true})；release()（:184）对登记的路径 rm(target,{recursive:true,force:true})。模块注释（:170）与测试用例名（__tests__/ScratchWorkspaceService.test.ts:199「[release-blocker] refuses a path outside the scratch root」）都把「被篡改的索引行不能变成创建并随后删除任意目录」写成要挡的威胁，但用例只试了不含 `..` 的 <base>/user-folder 与 /etc。同目录兄弟函数 isTempWorkspacePath（TempWorkspaceService.ts:283-288）先 path.resolve 再比 dirname，是正确写法，差异说明这不是有意为之。WorkerManager 给 worker 的 cwd 走 normalizeWorkerPath（含 path.resolve），worker 真的会在解析后的越界目录里跑。
EVIDENCE: isScratchPath(candidate) { if (!candidate.trim()) return false; return canonicalPathKey(candidate).startsWith(`${canonicalPathKey(this.rootPath())}/`); } // :125-131
canonicalPathKey = trimTrailingPathSeparators(normalizePath(inputPath)).toLowerCase() // shared/utils/path.ts:58-60，不解析 ..
adopt(): if (!this.isScratchPath(existingPath)) reject('scratch_workspace_foreign_path'); … await mkdir(existingPath,{recursive:true,mode:0o700}) // :172-181
release(): await rm(target,{recursive:true,force:true}) // :194 → :214
只读复算（node -e 按原样逻辑）：根=/home/ai/JYWAI/temporary/unbound-sessions 时，'<根>/./../secret' → 判 true，path.resolve 得 /home/ai/JYWAI/temporary/secret（用户自己的临时工作区所在层）；'<根>/../../../../home/ai/code/ai-client' → 同样判 true。
SCENARIO: 会话索引行的 workspacePath 形如 <scratch 根>/../<某真实目录> 时，用户打开该会话会走 ipc/chat.ts:404-406（resume）或 :315-318（首次发送）调用 adopt()，守卫放行并把该目录登记为会话 cwd；随后用户点归档（ipc/chat.ts:613 → release()），那个真实目录被整棵 rm -rf。产生这种行的两条路：① 被改写的 session-index.json——注释自己点名的威胁模型；② 会话导入：LegacyImportService.ts:145 在「记录的目录存在」时原样采用导入文件里的 cwd，:275 立刻用 isScratchPath 给它打 unbound 标记。两条投递路径为静态追踪，守卫失效本身为可复算的确定事实。
FIX: 改为先解析再判包含，与 isTempWorkspacePath 对齐：const resolved = path.resolve(expandHomePath(candidate,...)); const rel = path.relative(this.rootPath(), resolved); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);（Windows 折大小写）。另在 adopt() 补「候选不得含 `..` 段」的早退，并把 [release-blocker] 用例扩到 <根>/../x、<根>/./../x、<根>/a/../../x 三种形态。
REFUTER(CONFIRMED,high): 推翻失败，守卫确实是不解析 `..` 的字符串前缀比较。ScratchWorkspaceService.ts:125-131 原文：`isScratchPath(candidate){ if(!candidate.trim()) return false; return canonicalPathKey(candidate).startsWith(`${canonicalPathKey(this.rootPath())}/`); }`；canonicalPathKey（src/shared/utils/path.ts:58-60）= `trimTrailingPathSeparators(normalizePath(inputPath)).toLowerCase()`，只换分隔符、去尾斜杠、转小写，没有任何 path.resolve/normalize，所以 `<根>/../secret` 的 key 仍以 `<根>/` 开头 → 判 true。下游确实无第二道闸：adopt() 在 :172-181 只有这一句 `if(!this.isScratchPath(existingPath)) reject('scratch_workspace_foreign_path')` 然后 `mkdir(existingPath,{recursive:true,mode:0o700})` 并写进 pathsBySession；release() :184-200 对 map 里的路径直接 `rm(target,{recursive:true,force:true})`（:203-210 removeQuietly）。worker 侧也不会挡：WorkerManager.ts:719 用 `normalizeWorkerPath`，其 POSIX 分支（workerSessionKey.ts:29）是 `path.normalize(path.resolve(input))`，会把 `..` 解析掉，worker 真的跑在越界目录里。兄弟实现确实是正确写法（TempWorkspaceService.ts:51-56 `const resolved = path.resolve(expandHomePath(...)); return resolved !== basePath && path.dirname(resolved) === basePath;`，审查员给的行号 283-288 不对，内容对），说明不是刻意设计。测试也确实没钉住：__tests__/ScratchWorkspaceService.test.ts:199-209 的 [release-blocker] 只试了 `<base>/user-folder` 与 `/etc`，无任何含 `..` 的形态。git log -- ScratchWorkspaceService.ts 未见批次 A~C 的修复，roadmap.md 里 grep 不到 scratch/unbound 任何条目。投递路径两条均存在：ipc/chat.ts:268-269（首发）、:404-406（resume）、:315-318（ensure 走索引行）都拿索引里的 workspacePath 喂 adopt，chat.ts:608-615 归档时 release；LegacyImportService.ts:144-146 `if (matched && await this.directoryExists(recordedPath)) return recordedPath;` 原样采用导入文件里的 cwd，:275 再用 isScratchPath 打 unbound。定 high：结果是对根外真实目录的递归删除（数据丢失），且模块注释 :170 自己把这条写成要挡的威胁。前提是能写本地 session-index.json 或提供一份构造过的导入文件，不是纯远程攻击面。
WAIVER(none): 无 — 全文档检索无命中

### [session-index-01] HIGH robustness confirmed | P3-5 | src/main/services/chat/SessionIndexService.ts:420 | 索引文件读坏与「文件不存在」走同一条分支，下一次写入就把全部会话行覆盖成空（静态推断）
DESC: ensureLoaded 的 catch 只区分 ENOENT（安静）与其它（warn 一行），两者之后都 loaded=true 且 entries 保持为空；JSON.parse 失败、内容不是数组（for...of 抛 TypeError）、EACCES、EIO 全落这里。flush() 写的是整张表，所以加载失败后第一次任何写入都会把 session-index.json 原子改写成只剩新行。原文件不备份、不改名、不进只读模式。丢的不是缓存：session-index.json 是「聊天 → JSONL 文件」的唯一映射，全仓没有扫描自有会话目录的恢复入口（agent-host/chat/src/agent-host 下的 readdir 只出现在 Node 运行时解析与子代理目录）。sessionIndex.ts:4-8 的类型头已写明这个后果，但那是用来论证「格式必须是裸数组」的，对「文件被写坏」一侧没有任何防护。现有测试 SessionIndexService.test.ts:382-389 把该行为固化成期望值（只断言 list() 为 []，不断言坏文件是否还在）。
EVIDENCE: src/main/services/chat/SessionIndexService.ts:412-425
      try {
        const content = await readFile(path, 'utf8');
        const parsed = JSON.parse(content) as SessionIndexEntry[];
        for (const entry of parsed) { this.entries.set(entry.sessionId, entry); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn('[chat] Failed to read session index, starting empty:', error);
        }
      }
      this.loaded = true;

:442-447
  private async flush(): Promise<void> {
    const entries = [...this.entries.values()];
    await this.writeAtomically(path, entries);
  }
SCENARIO: 用户机器在一次写索引时断电（writeJsonAtomically 只有 writeFile + rename，无 fsync），或磁盘坏块/杀软把文件截断。重启后侧栏一条聊天都没有，用户随手新建会话并发第一句 → CHAT_REGISTER_SESSION / CHAT_CREATE_SESSION 调 recordCreated → flush() → session-index.json 被原子改写成只有这一行。此前所有会话（含已归档、含导入）从此不可达，坏文件被覆盖后连事后取证都做不了。
FIX: 把「读不出来」和「没有这个文件」分开：非 ENOENT 的读/解析失败时 (1) 把原文件改名为 session-index.json.corrupt-<时间戳> 保留证据；(2) 置 loadFailed 标志让本进程的 flush() 拒绝写或需用户确认后才接管；(3) 解析后校验 Array.isArray 与每行 sessionId 的类型，跳过坏行而非整份放弃。测试改成断言坏文件被改名保留、损坏后第一次 recordCreated 不让旧行消失。顺带给 writeJsonAtomically 加 fsync（临时文件 + 目录）。
REFUTER(CONFIRMED,high): 静态推断，但代码在 HEAD ebc82f16 上逐字对得上，推翻失败。src/main/services/chat/SessionIndexService.ts:412-425 的加载分支原文：`const parsed = JSON.parse(content) as SessionIndexEntry[]; for (const entry of parsed) { this.entries.set(entry.sessionId, entry); }` catch 里只有 `if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { console.warn('[chat] Failed to read session index, starting empty:', error); }`，随后无条件 `this.loaded = true;`——解析失败、非数组、EACCES 与「文件不存在」四种情况事后状态完全相同（entries 空 + loaded），没有 loadFailed 之类的只读闸门。flush 确认是整表覆盖写：:442-447 `const entries = [...this.entries.values()]; await this.writeAtomically(path, entries);`，writeJsonAtomically(:21-29) 是 writeFile+rename 且无 fsync、无备份。恢复入口确不存在：我把 `grep -rn "session-index" src/ --include=*.ts`（排除测试）跑了一遍，命中只有类型注释、ScratchWorkspaceService/TempWorkspaceService 的注释与本服务自身，Main 侧全部 readdir 调用点（subagentCatalog.ts:420、NodeRuntimeResolver.ts:151/181/202、CodexSessionScanner.ts:89、files.ts:653/1064 等）没有一个扫自有会话目录重建索引。测试确实把现状钉成期望：src/main/services/chat/__tests__/SessionIndexService.test.ts:382-389 `writeFileSync(join(userDataDir,'session-index.json'),'not json{{','utf8')` 后只 `await expect(service.list()).resolves.toEqual([])`，不检查坏文件是否保留。批次 A~C 未涉及：roadmap.md 里这块归在尚未派出的 T029（就是本次补审）。严重级维持 high——后果是唯一的「聊天→JSONL」映射被整表覆盖，属数据丢失。
WAIVER(none): 无 — 全库检索无命中

### [windows-01] HIGH security confirmed | P4-6 | src/runtime/plugins/permissions/index.ts:490 | Git Bash 的 /c/... 盘符写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny（静态推断）
DESC: pathPolicy 把路径与策略模式都折成正斜杠后做正则匹配，对原生写法（C 盘反斜杠形式）是对的。但 Windows 上真正跑命令的是 Git for Windows 的 bash.exe（shell.ts:100-106 选它），其中文件的自然写法是 MSYS 盘符记法 /c/Users/JC/.ssh/id_ed25519。该字符串走完整条链仍匹配不上 deny：path.win32.isAbsolute 对 /c/... 返回 true，bash-analysis.ts:182 因此认为它已是绝对路径并直接折成反斜杠形式；canonicalPath 对它 realpath 失败后逐级回退，拼出一个 C 盘下多出一层 c 目录的路径。两个形态都匹配不上展开后的 deny 正则。受影响的是只能靠完整路径匹配的规则：~/.ssh/* 与 ~/.aws/credentials；*.env、*.pem、*.key、id_rsa* 不受影响，因为它们展开后不含斜杠，会走 index.ts:491 的 basename 兜底。所以实际被放行的是 ~/.ssh/config、~/.ssh/known_hosts，以及不叫 id_rsa 的私钥——id_ed25519 是今天的默认密钥名。这是 P1-5 权限内核的缺陷但只在 Windows 成立，且不是 T001 修过的 permissions-19（那条是分隔符混用导致通配展开成空集，机制与代码位置都不同）。静态推断：端到端复现需 Windows 加 Git Bash，但路径语义部分已在 Linux 上用 node:path/win32 实测。
EVIDENCE: src/runtime/plugins/permissions/index.ts:488-492
    const regex = new RegExp('^' + expression + '$', process.platform === 'win32' ? 'i' : '');
    if (regex.test(candidate) || (!expanded.includes('/') && regex.test(basename(path))))
      action = value;

src/runtime/plugins/permissions/bash-analysis.ts:180-183
    function register(text: string, state: ShellState) {
      if (!text) return;
      // Keep wildcard's static parent; glob expansion is handled by the caller.
      paths.add(normalizeShellPath(isAbsolute(text) ? text : state.cwd + sep + text));
    }

src/agent-host/permissionPolicy.mjs:45-46 与 :61
 * The path surface is cross-cutting and a path deny CANNOT be overridden by
 * a per-tool allow ...
  '~/.ssh/*': 'deny',

Linux 上对 node:path/win32 的只读实测输出：
isAbsolute /c/Users: true
normalizeShellPath: 反斜杠形式 c 目录路径
resolve: C 盘下多一层 c 目录
relative: 以反斜杠 c 开头，isAbsolute 为 true
deny native: true
deny msys  : false
deny canon : false

现场 trace 证明模型确实在用这种写法（Windows-P4-6-evidence/test12-reverify.md:728 的 tool_execution_start 原文里含 cat /c/Users/JC/Desktop/AiClient-test12-probe/probe-a.txt）
SCENARIO: Windows 加密机，档位 auto。模型调 bash 跑 cat /c/Users/JC/.ssh/id_ed25519。BashAnalyzer 产出反斜杠 c 形式路径；checkShellPaths 的两次 pathPolicy 检查（lexical 与 canonical）都判 allow；evaluate 在 permissions/index.ts:302 的 gear 为 auto 且无 unresolvedPaths 分支直接返回 allow，没有任何卡片；Git Bash 执行成功，私钥全文进模型上下文并落进会话文件。同一台机器上 cat ~/.ssh/id_ed25519 与原生反斜杠写法都会被 deny 拦住——同一个文件，换一种拼法就放行。在 accept-edits 与 ask 档则降级为一张普通 ask 卡（containsPath 判出在工作区外），卡上路径看不出是私钥目录，本该硬 deny 的东西变成容易被顺手点允许的问题。
FIX: 在 bash-analysis.ts 的 register（:182）里、normalizeShellPath 之前加一次 Windows 盘符记法归一：把开头的 /X/ 形态（X 为单个盘符字母）改写成 X:/ 形态，并对双斜杠开头的 server/share 形态做 UNC 归一。必须在 register 里做而不是只在 pathPolicy 里，因为 containsPath 的工作区判定吃同一个字符串。配套在 shellPolicy.test.ts 的 shell path separator folding 那个 describe 旁边加一个 msys drive notation 的 describe，用纯函数钉住转换结果——和 T001 一样不需要 Windows 机器。顺带复核 /cygdrive/c/ 形态要不要一起收。
REFUTER(CONFIRMED,high): 尽力反驳未成功，三条反驳路线都走不通。(1) 主检查点确实漏：src/runtime/plugins/permissions/index.ts:477 `const candidate = path.replaceAll('\\', '/')`、:480 遍历 `AICLIENT_DEFAULT_PERMISSION_POLICY.permission.path`、:481-483 `pattern.startsWith('~/') ? resolve(homedir(), pattern.slice(2))`、:490 `regex.test(candidate) || (!expanded.includes('/') && regex.test(basename(path)))`。deny 项只有 `~/.ssh/*`（src/agent-host/permissionPolicy.mjs:61）与 `~/.aws/credentials`（:65）展开后含 `/`，所以 basename 兜底不适用，审查员的「只有这两条受影响」判断准确。(2) 我本机用 node:path/win32 实测：isAbsolute('/c/Users/JC/.ssh/id_ed25519')=true；折斜杠得 '\c\Users\JC\.ssh\id_ed25519'；win32.resolve 得 'C:\c\Users\JC\.ssh\id_ed25519'；展开后的 deny 正则 ^C:/Users/JC/\.ssh/.*$ 对 msys 写法 false、对原生写法 true。bash-analysis.ts:182 `paths.add(normalizeShellPath(isAbsolute(text) ? text : ...))` 正是这条折叠，normalizeShellPath（同文件:77-79）只做 `/`→`\`，无盘符归一。(3) 我另查了第二道独立闸门 policyAction（plugins/permissions/policy.ts:165-167 `values.flatMap(v => [v, relative(cwd, resolve(v)), basename(v)])`，matches() 在 :130 展开 `~`、:132-133 折斜杠），三个候选（msys 原串 / 相对 cwd 的 ../../c/... / basename 'id_ed25519'）没有一个能命中 `~/.ssh/*` 或 `id_rsa*`，所以第二道闸门同样漏。tools/index.ts:218-234 的 checkShellPaths 两次 pathPolicy（lexical 与 canonical）吃的都是同一串，canonicalPath（plugins/tools/paths.ts:11-18）对不存在路径逐级回退拼出多一层 c 的路径，也匹配不上。auto 档在 index.ts:303 `if (gear === 'auto' && !request.unresolvedPaths) return 'allow'` 之前只拦 deny，故直接放行。全仓 grep 无 cygdrive/msys 任何归一（git log -S"cygdrive" 为空），与 T001 的 permissions-19（分隔符折叠，shellPolicy.test.ts:459-476 钉住）确为两件事。静态推断：端到端需 Windows + Git Bash，但路径语义部分已在 Linux 上用 node:path/win32 实测复现。严重级 high：不可覆盖的 deny 被换一种拼法绕过，属安全绕过。
WAIVER(none): 无取舍 — 核对来源：docs/plans/2026-09-08-runtime-evolution-ard.md D16；docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json waivers[node=P1-8, kind=deferred]；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md；相关原文：「Windows/加密机现场验收攒到 P4-6 一次上机，不分批；签收前一律记为进行中/未验收，Linux 与 CI 的绿色不得代签 /「待现场验证」「待复验」只豁免缺现场证据，不豁免代码本身的缺陷」
