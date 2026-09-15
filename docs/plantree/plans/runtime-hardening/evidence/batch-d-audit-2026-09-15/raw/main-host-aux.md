# 批次 D 补审原文：Main 侧宿主辅助模块（Node 解析 / 临时工作区 / stderr / 布局）

- 区域：main-host-aux（任务 T029，批评者缺口 1 的另一半，cross-and-critic.md:64）
- 节点判定对象：P4-0（Node 解析）、F2-a / F2-b / F2-c 代码侧、H/19 目录下发半边
- 基线 HEAD：`ebc82f16`
- 日期：2026-09-15
- 方式：只读。未构建、未跑测试、未起 Electron。分析工具限于 `git log` / `grep` / `cat` / `node -e`（三次纯函数复算：路径前缀比较、尾部分隔符比较、`path.resolve` 结果）。

## 总评

这一片代码的书面质量明显高于仓库平均：每个模块开头都写清了「为什么是这个形状」，`ScratchWorkspaceService` 甚至把隔离边界说得很老实（目录权限不是边界，权限层才是）。批次 A～C 确实把审计当时的账清掉了——F2-a 的「两个读者读不同副本」已经统一，F2-c 的 `workspace_missing` 从抛出到渲染整条都在，H/19 的 `PI_CODING_AGENT_DIR` 在 worker 与 PTY 两条路都是无条件下发，runtime 与 Main 对 subagents 目录的根与优先级逐字一致。

但是有三处是这一轮新查出来的，且都不是审计原文里的条目：

第一，**临时工作区的「越界守卫」不成立**。`isScratchPath` 用的是字符串前缀比较，而它比较前的规范化函数不解析 `..`。于是 `<scratch 根>/./../<别的目录>` 会被判成「这是我们自己的目录」，随后 `adopt()` 会把它 `mkdir` 出来并登记为该会话的 cwd，`release()`（归档路径）会对它做 `rm -rf`。守卫的注释和它自己那条 `[release-blocker]` 测试都把「被篡改的索引行不能变成创建并随后删除任意目录」写成了它要挡的事，而它没挡住。同目录的兄弟模块 `TempWorkspaceService.isTempWorkspacePath` 用 `path.resolve` + `dirname` 比较，是对的——两者的写法差异本身就是证据。

第二，**归档删目录的时机与 worker 生命周期是反的**。`workerManager.ts` 自己写着「必须等 worker 没了再删 scratch 目录，否则 Windows 上 EBUSY、别处是莫名其妙的工具失败」，而归档这条路先删目录、渲染层随后才去 detach runtime。

第三，**被当作 P4-0 验收对象的 `NodeRuntimeResolver.ts` 在产品里一个调用方都没有**。真正决定用哪个 node 的是 `PiWorkerProcess` 与 `PiTuiPty` 里两处硬编码，渲染层那条「设置 AICLIENT_NODE24_PATH」的指引也因此永远不会出现。

另外 worker 的 stderr 只有走 IPC 那一路做了脱敏，写进 `main.log` 的那一路是原文。

F2-b 的三条现场结论与当前代码逐条对得上：关闭只 dispose worker、不碰目录；归档当场 `rm -rf`；启动与退出都把整个 scratch 根连锅端。

## 优点

- **F2-a 的修法是对的，而且是同步生效的**。`ScratchWorkspaceService.settingsTemporaryPath()`（:82）与 `TempWorkspaceService.settingsBasePath()`（:67）都改读 `readSettings()`；而 `readSettings()` 返回的是渲染层刚提交、尚未落盘的那份（`src/main/ipc/settings.ts:82-87`，`SETTINGS_WRITE` 在 :164 同步赋值 `pendingRendererSettings`）。所以设置一改，两个目录种类立刻看到同一个新值，不用等 500ms 防抖或 5s 兜底。
- **F2-c 整条都在**：`PiWorkerProcess.ts:70-74` 在 fork 之前显式检查 cwd 并抛 `WORKER_WORKSPACE_MISSING`（注释还记下了加密 Windows 上「明明 node.exe 在，却报 spawn node.exe ENOENT」的根因），`historyError.ts:33-34` 按子串映射成 `workspace_missing` 错误码，渲染层有图标与文案。用户目录不自动重建，与 F2-c 的口径一致。
- **H/19 下发是无条件的**：`piModelConfig/index.ts:295` 在 `resolveManagedPiWorkerEnv()` 里无分支地写 `PI_CODING_AGENT_DIR: getAppPiAgentDir()`，`resolveManagedPiPtyEnv()`（:314）原样复用同一份，所以 GUI worker 与内嵌 TUI / 插件管理器跑的是同一个 agent 目录。
- **子代理目录的两个读者口径一致**：Main 侧 `subagentCatalog.ts:90-92` 的根是 `[<agentDir>/subagents, ~/.agents/subagents]`，runtime 侧 `src/runtime/plugins/subagent/catalog.ts:85-88` 是同样两个根、同样顺序；「没表态 = 开」在 `nativeSubagentSettings.ts:53` 与 `nativeWorkerRuntime.ts:224` 两侧都成立（只有显式 `false` 才不注册 `Task*`）。
- **`save()` 的往返自检是真在干活**：`subagentCatalog.ts:205` 把写出去的文档解析回来再格式化一次做全等比较，注释里点名它抓到过「描述里的单引号每存一次多一个」这种真实缺陷。
- **`retiredSurfaceAbsence.test.ts` 用 latin1 读文件**（:63），显式绕开了「含 NUL 的源码被 grep 静默跳过」这个坑，同时按词汇（正则 `extension[_-]?ui`）而不是按文件名清单守，改名换文件也躲不掉。
- **`workerSessionKey.ts` 把「显示值」与「比较键」分开**：Windows 风格路径折大小写只发生在 `normalizedWorkerPathIdentity`，`normalizeWorkerPath` 保留段大小写用于展示。

## 弱点

1. 「越界」这件事在这一片有三套不同的判法：`isScratchPath` 用 `canonicalPathKey` 前缀（不解析 `..`），`isTempWorkspacePath` 用 `path.resolve` + `dirname` 全等（不折大小写、不容忍尾部分隔符），`WorkerManager` 用 `normalizeWorkerPath`（`path.resolve`，解析 `..`）。三套里每一套都有自己的漏洞，而它们判的是同一批路径。
2. 生命周期的顺序约束只写在一处、只在一处被遵守：`ipc/workerManager.ts:8-11` 的退出清理知道「先收 worker 再删目录」，`ipc/chat.ts:613` 的归档不知道。
3. 「声明了但没接线」这一类在本区域有两例：`NodeRuntimeResolver`（整模块）与渲染层 `isNode24ResolutionFailure`（导出、有测试、无调用方）。两者还互相引用对方的措辞，所以单读任一侧都自洽。
4. 脱敏只做了会被截图的那一路，写进日志文件的那一路没做——而日志文件恰恰是用户会打包发给支持的东西。
5. 兼容根 `~/.agents/subagents` 在 `subagentCatalog.test.ts:38` 被显式指到一个空临时目录，整个第二根的行为（影子、删除、改名跨根）零覆盖。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P4-0（Node 解析） | complete-with-gaps | 产品路径是通的且有明确失败信息：打包 win32 用随包 `node.exe`（`PiWorkerProcess.ts:82-83`），其余用 Electron `utilityProcess`（:94），TUI / 插件管理器用 `PiTuiPty.ts:95-99`，三处都先 `existsSync` 再起。但被文档当作该节点实现的 `NodeRuntimeResolver.ts` 无任何生产调用方（main-aux-04），其版本管理器分支在 POSIX 上拼出的路径缺 `bin/` 段、且不认现代 nvm 的 `versions/node` 布局（main-aux-05），渲染层为它准备的指引分支同样不可达。 |
| F2-a（临时根设置不同步）代码侧 | complete-with-gaps | 两个读者已统一到同一份即时生效的设置（见「优点」）。残留在于根路径是每次调用现算：改设置后旧根下的 scratch 目录既不再被认作 scratch，也不再被退出/启动的整根清理覆盖（main-aux-03）。 |
| F2-b（TEMP 删除后归组/消失）代码侧 | complete-with-gaps | 旧树三条结论与当前代码逐条一致：关闭 = `workerManager.releaseSession` + `closeSession`，不碰目录（`ipc/chat.ts:509-514`）；归档 = `release()` 当场 `rm -rf`（`ipc/chat.ts:613`、`ScratchWorkspaceService.ts:194`）；重启 / 退出 = `wipeAll()` 删整个根（`ipc/workerManager.ts:11`、:21）。缺口是守卫可绕过（main-aux-01）与删除时机早于 worker 回收（main-aux-02）。 |
| F2-c（用户目录缺失 workspace_missing）代码侧 | complete-with-gaps | 抛出、映射、界面三段都在（见「优点」），用户项目目录不自动重建也符合口径。缺口是 app 自建的临时工作区那一半自愈：`isTempWorkspacePath` 的比较方式让一个带尾部分隔符或正斜杠的设置值直接让 `adoptTempWorkspace` 静默空转（main-aux-07）。 |
| H/19（目录下发半边） | complete-with-gaps | `PI_CODING_AGENT_DIR` 无条件下发、worker 与 PTY 同一份；子代理目录的两个读者根与优先级一致。缺口在兼容根的写侧语义：删除一个被 `<agentDir>/subagents` 影子覆盖的 `~/.agents` 定义只会删掉影子、旧文档随即复活成为生效定义，而改名会直接删掉 `~/.agents` 下的原文件（main-aux-09），且第二根零测试。 |

## 发现

### [main-aux-01] high security | F2-b | src/main/services/agent-host/ScratchWorkspaceService.ts:130 | scratch 根的越界守卫用不解析 `..` 的前缀比较，`adopt` 能创建、`release` 能递归删除根外任意目录

DESC: `isScratchPath` 的实现是「把候选路径和根路径都过一遍 `canonicalPathKey`，再判前缀」。`canonicalPathKey`（`src/shared/utils/path.ts:58`）只做三件事：反斜杠换正斜杠、去尾部分隔符、转小写——**不解析 `.` 与 `..`**。所以任何以 scratch 根开头、后面接 `../` 的字符串都会被判为「这是我们自己的目录」。这个判断有两个下游：`adopt()`（:172）拿它当唯一准入检查，然后 `mkdir(existingPath, {recursive:true})`；`release()`（:184）对登记下来的路径做 `rm(target, {recursive:true, force:true})`。模块注释（:170）与测试用例名（`__tests__/ScratchWorkspaceService.test.ts:199`「[release-blocker] refuses a path outside the scratch root」，注释写「A tampered or stale session-index row must not be able to turn adopt into "create, own, and later delete an arbitrary directory"」）都把这条威胁写明了，但用例只试了 `<base>/user-folder` 与 `/etc` 两个不含 `..` 的样本。同目录的兄弟函数 `TempWorkspaceService.isTempWorkspacePath`（:283-288）先 `path.resolve` 再比 `dirname`，是正确写法——两者的差异本身就说明这不是有意为之。另外 `WorkerManager` 给 worker 的 cwd 走的是 `normalizeWorkerPath`（`workerSessionKey.ts:29`，内含 `path.resolve`），所以 worker 真的会在解析后的越界目录里跑。

EVIDENCE:
```ts
// src/main/services/agent-host/ScratchWorkspaceService.ts:125-131
  isScratchPath(candidate: string): boolean {
    if (!candidate.trim()) return false;
    // `canonicalPathKey` already folds separators to `/` and trims trailing
    // ones, so a plain prefix test is exact here — no `path.relative` on
    // half-normalized strings.
    return canonicalPathKey(candidate).startsWith(`${canonicalPathKey(this.rootPath())}/`);
  }

// src/shared/utils/path.ts:58-60
export function canonicalPathKey(inputPath: string): string {
  return trimTrailingPathSeparators(normalizePath(inputPath)).toLowerCase();
}

// src/main/services/agent-host/ScratchWorkspaceService.ts:172-181
  adopt(sessionId: string, existingPath: string): Promise<string> {
    if (!this.isScratchPath(existingPath)) {
      return Promise.reject(new Error('scratch_workspace_foreign_path'));
    }
    return this.serialize(async () => {
      await mkdir(existingPath, { recursive: true, mode: 0o700 });
      this.pathsBySession.set(sessionId, existingPath);
      return existingPath;
    });
  }

// src/main/services/agent-host/ScratchWorkspaceService.ts:212-220（release 的删除动作）
      await rm(target, { recursive: true, force: true });
```
只读复算（`node -e`，按上面两个函数的原样逻辑）：根为 `/home/ai/JYWAI/temporary/unbound-sessions` 时
- `<根>/./../secret` → `isScratchPath` 判 `true`，`path.resolve` 得 `/home/ai/JYWAI/temporary/secret`（即用户自己的临时工作区所在层）；
- `<根>/../../../../home/ai/code/ai-client` → 同样判 `true`。

SCENARIO: 会话索引行的 `workspacePath` 只要形如 `<scratch 根>/../<某个真实目录>`，用户打开这个会话时 `ipc/chat.ts:404-406`（resume）或 :315-318（首次发送）就会调用 `adopt()`，守卫放行，目录被登记为该会话的 cwd；随后用户点「归档」（`ipc/chat.ts:613` → `release()`），那个真实目录被整棵 `rm -rf`。产生这种行的两条路：① 被改写的 `session-index.json`——注释自己点名的威胁模型；② 会话导入：`LegacyImportService.ts:145` 在「记录的目录存在」时原样采用导入文件里的 `cwd`，:275 立刻用 `isScratchPath` 给它打 `unbound` 标记，于是一份 cwd 字符串里带 `..` 的导入会话文件就能把任意已存在目录送进这条链。我没有实测跑过这两条端到端路径（只读约束），但守卫本身失效是可复算的确定事实。

FIX: 把比较改成先解析再判包含，与 `isTempWorkspacePath` 对齐：`const resolved = path.resolve(expandHomePath(candidate, ...)); const rel = path.relative(this.rootPath(), resolved); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);`（Windows 上用大小写不敏感比较）。另外在 `adopt()` 里补一条「候选路径不得包含 `..` 段」的早退，并把 `[release-blocker]` 用例扩到 `<根>/../x`、`<根>/./../x`、`<根>/a/../../x` 三种形态。

### [main-aux-02] medium correctness | F2-b | src/main/ipc/chat.ts:613 | 归档在 worker 还活着时就 `rm -rf` 它的 cwd，与退出清理自己写下的顺序约束相反

DESC: `CHAT_ARCHIVE_SESSION` 的处理是「翻归档位 → `await scratchWorkspaceService.release()`」，`release()` 会立刻对该会话的 cwd 做递归删除。这个 handler 不 dispose worker，也不等 worker 退出。渲染层的顺序是先 `await` 这个 IPC、成功后才 `detachRuntime(sessionId)`（`sessionIndex/useSessionIndex.ts:343-350`），而 detach 才是发 `chat:closeSession` 的地方——也就是说目录删除**一定**发生在 worker 回收之前。同一个仓库的退出清理路径把这条约束写得很清楚，并且遵守了它。

EVIDENCE:
```ts
// src/main/ipc/chat.ts:608-615
      const result = await sessionIndexService.setArchived(payload.sessionId, payload.archived);
      // U05-a "session destroyed" cleanup: archiving is how this product
      // retires a chat, so it is where an unbound chat's throwaway directory
      // goes away. Un-archiving re-creates it empty through the resume path.
      if (result && payload.archived) {
        await scratchWorkspaceService.release(payload.sessionId);
      }

// src/main/ipc/workerManager.ts:6-12（同一件事，顺序是对的）
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);
  // U05-a: after the workers are gone, not before — a live worker still has
  // its scratch cwd open, and removing it underneath one invites EBUSY on
  // Windows and a confusing tool failure everywhere else.
  await scratchWorkspaceService.wipeAll();
}

// src/renderer/components/chat/sessionIndex/useSessionIndex.ts:343-350（detach 在归档 IPC 之后）
  if (ok) {
    if (archived) {
      if (isHostBound(sessionId)) {
        detachRuntime(sessionId);
      }
```

SCENARIO: 一个未绑定文件夹的临时对话正在跑一个回合（agent 正在往 cwd 写文件），用户在侧栏对它点「归档」，或用 U31 的批量归档一次归掉若干行。Main 立刻删掉这个 worker 的 cwd，之后渲染层才发关闭。POSIX 上该回合后续的文件工具在一个已被删除的目录里执行，失败信息与「目录不见了」毫无关系；Windows 上 `rm` 很可能因占用失败（`removeQuietly` 吞掉并只记日志，`ScratchWorkspaceService.ts:212-219`），于是目录残留到下次启动的整根清理，「归档即销毁」这个承诺当场不成立、且没有任何提示。Windows 那一半是静态推断（static_inference 见下），POSIX 那一半是代码顺序可确定的。

FIX: 在 handler 里把顺序倒过来——先 `await workerManager.closeSession(payload.sessionId)`（或一个专门的 `retireSession`），拿到 worker 已退出的信号后再 `release()`；`release()` 内部也可以加一条「该会话仍有活 slot 时拒绝并让调用方先收 worker」的断言，把这条约束变成代码而不是注释。补一条用例：注入一个假的 worker 生命周期，断言 `release` 的调用发生在 dispose 之后。

### [main-aux-03] medium correctness | F2-a | src/main/services/agent-host/ScratchWorkspaceService.ts:109 | 改临时根设置后，旧根下的 scratch 目录永不被清理，且恢复时丢掉 `unbound` 不信任姿态

DESC: F2-a 的修法（两个读者读同一份设置）是对的，但根路径是**每次调用现算**的：`rootPath()` 现读 `resolveBasePath()`。已经分配出去的目录仍在旧根下，而 `isScratchPath` / `wipeAll` 判的都是新根。于是改一次设置会同时产生三件事：① 退出与下次启动的 `wipeAll()` 只删新根，旧根下的目录永久留在磁盘上——模块开头写的「a scratch directory does not survive the app」不再成立，而这正是「临时会话」这个词对用户的承诺；② 重启后恢复这个会话时 `isScratchPath(row.workspacePath)` 为 `false`，`ipc/chat.ts:404-410` 走的是 else 分支，`unbound` 为 `false`，而 `unbound` 正是决定「这个会话不带项目信任启动」的那一位（`WorkerManager.ts:124-129` 的字段注释、:731 写入、:2002 随 spawn 下发）；③ 同一行在 `CHAT_ENSURE_SCRATCH_WORKSPACE`（:313-321）里也不再被认出，会走 `ensure()` 分配第二个目录，而 :313 的注释自己写了这会让 resume 报 workspace mismatch。

EVIDENCE:
```ts
// src/main/services/agent-host/ScratchWorkspaceService.ts:108-111
  rootPath(): string {
    return path.join(this.resolveBasePath(), SCRATCH_ROOT_DIR);
  }

// src/main/ipc/chat.ts:402-411（恢复时的姿态判定）
      const unbound = scratchWorkspaceService.isScratchPath(payload.workspacePath);
      if (unbound) {
        await scratchWorkspaceService.adopt(payload.sessionId, payload.workspacePath);
      } else {
        await adoptTempWorkspace(payload.workspacePath);
      }

// src/main/services/agent-host/WorkerManager.ts:124-129
  /**
   * U05-c — `cwd` is a throwaway scratch directory, not a project the user
   * picked, so this session must bootstrap without project trust. ...
   */
  readonly unbound: boolean;
```
设置的可见性是即时的：`readSettings()`（`src/main/ipc/settings.ts:82`）优先返回 `pendingRendererSettings`，而它在 `SETTINGS_WRITE` 里同步赋值（:164），不等 500ms 防抖。

SCENARIO: 用户有若干临时对话，然后在「设置 → 常规 → 保存位置」把临时目录从默认 `~/JYWAI/temporary` 改到别处。退出应用：旧路径下的 `unbound-sessions/` 连同 agent 写过的文件原封不动留着，下次启动也不会被清。重开那些对话：它们以**带项目信任**的姿态启动在这些残留目录里，侧栏也不再把它们标成临时会话。

FIX: 目录一旦分配就把它的根记下来（例如把根写进 session-index 行，或让服务持有一个「本次运行已知的历史根」集合），`wipeAll()` 同时清理当前根与历史根；`isScratchPath` 对历史根也返回 true。最省事的等价做法是在设置变更时把旧根下的内容迁移/清理一次并记一条日志。补一条用例：分配 → 换 `resolveBasePath` → 断言 `isScratchPath(旧路径)` 与 `wipeAll` 的行为。

### [main-aux-04] medium dead-code | P4-0 | src/main/services/agent-host/NodeRuntimeResolver.ts:50 | Node 24 解析器整模块无生产调用方，渲染层为它写的指引分支同样不可达

DESC: `resolveNode24Runtime` 全仓只有三个文件提到它：自身、`agent-host/index.ts` 的桶导出、自己的测试（`grep -rl` 结果见下）。产品里真正决定「用哪个 node」的是两处硬编码：打包 win32 用 `resources/node-runtime/node.exe`、其余用 Electron `utilityProcess`（`PiWorkerProcess.ts:79-100`），TUI 与插件管理器用 `PiTuiPty.ts:95-99`。这两处的失败文案是 `Pi Node runtime is missing: <path>` 与 `WORKER_WORKSPACE_MISSING: …`，都不含解析器那句 `No Node 24 runtime found. Set AICLIENT_NODE24_PATH…`。链条的另一半也是死的：渲染层 `hostStatus.ts:264` 的 `isNode24ResolutionFailure` 有导出、有测试（`__tests__/hostStatus.test.ts:89`），但 `describeHostStatus`（:92-122）从不调用它，`HostStatusBanner.tsx:9-10` 的文档却写着自己覆盖「Node 24 missing actionable guidance（AICLIENT_NODE24_PATH）」。所以 P4-0 的「Node 解析」在文档上指着一段代码，在产品上跑的是另一段。

EVIDENCE:
```
$ grep -rl "resolveNode24Runtime" src/ --exclude-dir=node_modules
src/main/services/agent-host/index.ts
src/main/services/agent-host/NodeRuntimeResolver.ts
src/main/services/agent-host/__tests__/NodeRuntimeResolver.test.ts
```
```ts
// src/renderer/components/chat/hostStatus.ts:259-268
/**
 * Node 24 resolution failures are emitted by the Main process throwing inside
 * `ensureHost`. The Renderer treats any `state=error` whose message looks like
 * a Node-resolution failure as actionable guidance (set AICLIENT_NODE24_PATH).
 */
export function isNode24ResolutionFailure(status: HostStatus): boolean {
  if (status.state !== 'error') return false;
  const message = status.lastFatalError ?? '';
  return /node 24|AICLIENT_NODE24_PATH/i.test(message);
}

// src/main/services/agent-host/PiWorkerProcess.ts:82-83（产品里的实际解析）
    const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);
```

SCENARIO: 打包后的 Windows 机器上随包 node 运行时缺失或被杀软隔离。用户看到的是宿主横幅里一句原文 `Pi Node runtime is missing: C:\…\node-runtime\node.exe` 加通用的「Press Retry」，不会出现「设置 AICLIENT_NODE24_PATH」这条唯一可自救的指引——因为产出那句话的模块没人调，而认那句话的渲染函数没人用。同时 `AICLIENT_NODE24_PATH` 这个环境变量在产品里事实上完全无效，尽管文档与横幅注释都还在承诺它。

FIX: 二选一，但要选。要么删：删掉 `NodeRuntimeResolver.ts`、桶导出、`isNode24ResolutionFailure` 与其用例，并把 `HostStatusBanner.tsx` 的文档改写为实际覆盖的三种状态。要么接：让 `PiWorkerProcess` / `PiTuiPty` 的 node 选择走解析器（把随包路径作为 `bundledPath` 传入），这样 `AICLIENT_NODE24_PATH` 逃生口重新生效——但接之前必须先修 main-aux-05。

### [main-aux-05] low correctness | P4-0 | src/main/services/agent-host/NodeRuntimeResolver.ts:162 | 版本管理器分支在 POSIX 上拼出的候选路径缺 `bin/` 段，nvm 的现代目录布局也不认

DESC: 三个版本管理器的候选路径都由 `nodeBinaryInDir(dir, platform)` 收尾，它在非 win32 上返回 `<dir>/node`。实际布局是：nvm 为 `<version>/bin/node`、fnm 为 `<version>/installation/bin/node`、volta 为 `<version>/bin/node`（win32 才是 `<dir>/node.exe`，那一半是对的）。另外 POSIX 的 nvm 自 0.32 起把版本目录放在 `$NVM_DIR/versions/node/` 下，而 `collectNvmCandidates` 只 `readdirSync(root)` 一层并按 `/^v?24\./` 过滤；POSIX 的 `NVM_DIR` 环境变量也没被读（只读了 Windows 的 `NVM_HOME`）。于是在 Linux / macOS 上这三条发现路径恒为空集，只剩 PATH 查找。因为 main-aux-04（模块没人调），今天没有用户可见后果，所以定 low；但它是 main-aux-04「接线」那个修法的直接地雷。

EVIDENCE:
```ts
// src/main/services/agent-host/NodeRuntimeResolver.ts:223-225
function nodeBinaryInDir(dir: string, platform: NodeJS.Platform): string {
  return path.join(dir, platform === 'win32' ? 'node.exe' : 'node');
}

// :142-144（POSIX 只看 ~/.nvm 一层）
  } else {
    roots.add(path.join(home, '.nvm'));
  }

// :190-191（fnm：installation 下直接拼 node）
      const dir = path.join(versionsDir, v.name, 'installation');
      out.push(nodeBinaryInDir(dir, platform));
```
本机对照：`/home/ai/.nvm/v22.23.2/` 下只有 `bin/`，node 可执行文件在 `/home/ai/.nvm/v22.23.2/bin/node`。测试侧零覆盖——`__tests__/NodeRuntimeResolver.test.ts` 的四条用例要么用不存在的 `D:\…` 路径只断言顺序，要么以 `if (!result.ok) return` 的形式软退（:27-30、:66-72），没有一条构造过 nvm/fnm/volta 的目录形状；第三条还直接读开发机真实环境（:26 `resolveNode24Runtime()` 无参），不是隔离用例。另外 `collectFnmCandidates` 读 `process.env.FNM_DIR`（:170）时不看 `useProcessEnv`，与 `collectNvmCandidates` 的约定不一致，使「隔离单测」在装了 fnm 的机器上不隔离；`pathsEqual`（:242）判平台用的是 `process.platform` 而不是 `options.platform`，测试传入 `platform:'win32'` 时去重规则仍按宿主平台。

SCENARIO: 若按 main-aux-04 的「接线」修法把解析器接进产品，一台只用 nvm 装了 Node 24、且从桌面图标启动（PATH 不含 nvm shim）的 Linux/macOS 机器会得到 `No Node 24 runtime found`，而磁盘上 Node 24 一直在。今天则表现为：这段代码看起来支持三种版本管理器，实际在开发者的主力平台上一个都发现不了，且测试全绿。

FIX: `nodeBinaryInDir` 在非 win32 下返回 `path.join(dir, 'bin', 'node')`；nvm 分支加 `$NVM_DIR` 与 `<root>/versions/node` 两个根（保留老布局作为回退）；`collectFnmCandidates` 接受 `useProcessEnv`；`pathsEqual` 接受平台参数。用例改为在临时目录里造出三种版本管理器的目录形状（放一个真实可执行的 node 拷贝或用可注入的探针函数），断言各自被发现且 `source` 正确。

### [main-aux-06] medium security | main-host-aux | src/main/services/agent-host/WorkerManager.ts:2060 | worker stderr 只有走 IPC 的那一路脱敏，进 main.log 的两路是原文

DESC: `absorbStderr` 把组装好的整行同时送三处：`this.log(prefix, line)`（日志 sink，info 级）、`forwardStderr(entry, line)`（IPC 给渲染层）、以及 `entry.recentStderr` 缓冲区——后者在 worker 死亡时由 `dumpWorkerStderr` 用 `console.error` 整批打出。三处里只有 `forwardStderr` 调了 `sanitizeStderrLine`（:2102）。`dumpWorkerStderr` 的注释还特意说明用 `console.error` 是因为「electron-log 在文件日志关闭时仍保留 error 级」——也就是说这条路**一定**落盘。而 `stderrRedaction.ts` 的模块文档把自己定位成「泄漏的凭据与 UI 之间唯一的门」，门确实装在了 UI 那一侧，落盘那一侧没装。

EVIDENCE:
```ts
// src/main/services/agent-host/WorkerManager.ts:2055-2063
  private absorbStderr(entry: ManagedSlot, generation: number, chunk: string): void {
    const drained = drainStderrLines(entry.stderrPending, chunk);
    entry.stderrPending = drained.pending;
    entry.recentStderr = pushRecentStderr(entry.recentStderr, drained.lines);
    const prefix = `[pi-worker:${entry.logicalSessionId}:g${generation}:stderr]`;
    for (const line of drained.lines) {
      this.log(prefix, line);          // ← 原文
      this.forwardStderr(entry, line); // ← 这一路才脱敏
    }
  }

// :2098-2103（唯一的脱敏点）
        line:
          forwarded === STDERR_FORWARD_MAX_LINES_PER_TURN
            ? `…more stderr this turn is in the worker log only (…)`
            : sanitizeStderrLine(line),

// :2109-2117（崩溃回放，原文进 error 级日志）
    console.error(
      `[pi-worker:${entry.logicalSessionId}:g${entry.generation}] ${reason}; last ${lines.length} stderr line(s):\n${lines.join('\n')}`
    );
```

SCENARIO: worker 或它拉起的子进程在启动失败时把环境或请求头打到 stderr（`ANTHROPIC_AUTH_TOKEN=…`、`authorization: Bearer …`、`sk-ant-…` 都在 `stderrRedaction.ts` 的规则表里，说明这些形态是预期会出现的），worker 随后退出，`dumpWorkerStderr` 把最近 50 行原样写进 `main.log`。用户为排障把日志发给支持或贴进 issue，凭据随之外泄；界面上同一批行是打过码的，所以没人会意识到日志里没有。

FIX: 把脱敏提到 `absorbStderr` 的循环里做一次（`const safe = sanitizeStderrLine(line)`），三个出口统一用 `safe`；`forwardStderr` 相应去掉自己那次调用。注意 `sanitizeStderrLine` 还带长度上限，与 `clampLine` 叠加需要确认谁先谁后。补用例：喂一行含 `sk-ant-` 的 stderr，断言注入的 `log` sink 与 `console.error` 收到的都是 `[redacted]`。

### [main-aux-07] medium correctness | F2-c | src/main/services/agent-host/TempWorkspaceService.ts:287 | 临时工作区的归属判定用未规范化的 base 做 `dirname` 全等比较，设置值带尾部分隔符就让自愈静默失效

DESC: `isTempWorkspacePath` 把候选路径 `path.resolve` 之后取 `dirname`，与 `settingsBasePath()` 的返回值做**字符串全等**比较。而 `settingsBasePath()` 返回的是 `getEffectiveTemporaryBasePath(用户输入, …)`，它只做 `trim()` 与 `~` 展开（`src/shared/defaultPaths.ts:85-91`），既不 `path.resolve` 也不去尾部分隔符、也不统一分隔符方向。保存位置在设置页是一个自由文本输入框（`GeneralSettings.tsx:129-131`），用户完全可能输入 `/home/x/tmp/` 或（Windows 上）`D:/tmp`。一旦如此，比较恒为 false，`adoptTempWorkspace` 直接 `return`，自愈不发生。对照组是隔壁的 scratch：`rootPath()` 用 `path.join` 归一、`isScratchPath` 两侧都过 `canonicalPathKey`，同样的输入不受影响。

EVIDENCE:
```ts
// src/main/services/agent-host/TempWorkspaceService.ts:283-288
export function isTempWorkspacePath(candidate: string): boolean {
  if (!candidate.trim()) return false;
  const basePath = settingsBasePath();
  const resolved = path.resolve(expandHomePath(candidate, homedir(), path.sep));
  return resolved !== basePath && path.dirname(resolved) === basePath;
}

// :299-305（唯一消费者）
export async function adoptTempWorkspace(dirPath: string): Promise<void> {
  if (!isTempWorkspacePath(dirPath)) return;
  ...
```
只读复算（`node -e`）：`base='/home/x/tmp/'`、候选 `'/home/x/tmp/ws1'` → `path.dirname(path.resolve(候选))` 得 `/home/x/tmp`，与 base 不等 → `false`；base 去掉尾斜杠后为 `true`。

SCENARIO: 用户把保存位置填成 `~/JYWAI/temporary/`（末尾多一个斜杠），之后在资源管理器里手工删掉某个临时工作区目录，再回到应用点开那个对话。本该「app 自建内容就地重建 + `git init`」的自愈整条不执行，`forkPiWorkerProcess` 撞上不存在的 cwd，用户拿到 `workspace_missing` 错误卡。表现与 F2-c 里「用户目录缺失不自动重建」完全一样，但这是 app 自己建的目录，本来应该被重建。

FIX: 让 `isTempWorkspacePath` 与 scratch 侧共用一套归一：两侧都过 `path.resolve` + 去尾分隔符（Windows 上再折大小写），或直接改用 `path.relative(base, resolved)` 判「恰好一层」。更根上的修法是让 `getEffectiveTemporaryBasePath` 返回归一化后的路径。补用例：base 带尾斜杠 / 正斜杠形态各一条。

### [main-aux-08] low robustness | main-host-aux | src/main/services/agent-host/hostStderr.ts:58 | 无换行的 stderr 流只被限制了内存，没被限制条数，一次巨量输出会把 50 行崩溃回放挤空

DESC: `drainStderrLines` 对「一直不出现换行」的情况的处理是：`tail` 超过 2000 字符就截断成一行发出去并把 pending 清零。这确实挡住了缓冲区无限增长，但下一段同一逻辑行的内容会作为**新的一行**再次触发同样的路径。所以一个 1 MB 的无换行 payload 会变成约 500 条 2000 字符的日志行，而 `MAX_STDERR_LINE_CHARS` 的注释写的是「the tail is noise once the failure is identifiable」——尾巴并没有被丢掉，只是被切成了段。连带后果落在 `pushRecentStderr` 的 50 行窗口上：这 500 行会把真正有诊断价值的启动横幅与栈整个挤出窗口，而 `dumpWorkerStderr` 的注释恰恰说「boot banner 加一段 SDK 栈完全装得下这 50 行」。

EVIDENCE:
```ts
// src/main/services/agent-host/hostStderr.ts:57-64
  if (tail.length > MAX_STDERR_LINE_CHARS) {
    const trimmed = tail.trim();
    if (trimmed) lines.push(clampLine(trimmed));
    return { lines, pending: '' };
  }

  return { lines, pending: tail };
```
测试侧只覆盖了「超过上限就刷掉，所以 pending 不会无限增长」这一半（`__tests__/hostStderr.test.ts:53`），没有覆盖「同一逻辑行被切成 N 段后一共产生多少行」。

SCENARIO: worker 或其子进程把一份序列化后的大 payload（例如一整个请求体或一段 base64）一次性打到 stderr 且不带换行。日志里出现数百条截断行；worker 随后因别的原因退出时，`dumpWorkerStderr` 回放的 50 行全部是这份 payload 的中段，真正的失败原因已被挤出缓冲区——而这个缓冲区存在的唯一理由就是保住失败原因。

FIX: 给「同一逻辑行」加一个丢弃计数：截断发出一次后，继续吞掉同一行剩余字节直到遇到换行（可发一条 `…[dropped N bytes of an unterminated line]` 作为收尾），而不是把剩余内容当作新行。

### [main-aux-09] medium correctness | H/19 | src/main/services/agent-host/subagentCatalog.ts:266 | 删除一个被影子覆盖的兼容根定义只删影子，旧文档随即复活成生效定义；改名则直接删掉 `~/.agents` 下的原文件

DESC: `read()` 按 `[<agentDir>/subagents, ~/.agents/subagents]` 两个根扫描，第一个根先占名，被遮住的第二根文档不出现在列表里（:135-138）。但写侧只认列表里那一行的 `filePath`：`remove()` 删的是 `target.filePath`（:266-267），也就是第一根里的影子；删完重新 `read()`，第二根里那份旧文档立刻补位成为生效定义。用户看到的是「点了删除，这一行还在，而且内容变回了老版本」。`save()` 的两条路还互相矛盾：不改名地编辑一个来自第二根的定义，写的是第一根的新文件、旧文件留着（影子语义）；而带 `previousName` 的改名会执行 `rm(old.filePath)`（:242），直接删掉 `~/.agents/subagents/<旧名>.md` ——一个本应用并不拥有的目录里的文件。类文档写了四条规则，其中「Nothing we ship is ever written to」保护的是随包内置定义，没有任何一条覆盖这个兼容根。

EVIDENCE:
```ts
// src/main/services/agent-host/subagentCatalog.ts:90-92
  private roots(): string[] {
    return [this.directory(), join((this.deps.home ?? homedir)(), '.agents', 'subagents')];
  }

// :135-138（第二根的同名文档不进列表）
        if (claimed.has(parsed.definition.name)) continue;

// :266-267（删除只作用于列表里那一行的路径）
    const filePath = target?.filePath ?? brokenTarget?.filePath;
    if (filePath) await rm(filePath, { force: true });

// :238-243（改名会删掉旧文件，无论它在哪个根）
    if (previous && previous !== name) {
      const old = before.rows.find((entry) => entry.name === previous);
      if (old?.filePath) await rm(old.filePath, { force: true });
```
测试把第二根显式指向一个空临时目录（`__tests__/subagentCatalog.test.ts:36-38`：「Never the developer's real home」），所以整个兼容根的行为零覆盖。

SCENARIO: H/19 之前就在用 `~/.agents/subagents/reviewer.md` 的用户，在设置页编辑了 `reviewer`（于是 `<agentDir>/subagents/reviewer.md` 出现），之后决定删掉它。点删除 → 列表刷新后 `reviewer` 仍在、内容回到编辑前的老版本、`filePath` 指向 `~/.agents`；再点一次删除，这次删的是 `~/.agents` 下的原件。另一条：把 `~/.agents/subagents/reviewer.md` 改名为 `critic`，用户的 `~/.agents` 目录里那份文档被静默删除——而那个目录可能还被别的工具读。

FIX: 让 `read()` 保留被遮住的副本信息（例如行上加 `shadowedBy` / `shadowing` 字段），`remove()` 要么把同名的所有 user 文档一并删、要么明确告诉用户「删掉的是这一份，另一份在 `~/.agents/...` 仍会生效」；`save()` 的改名路径对第二根的文件只做「留在原处」而不是 `rm`（或至少给出确认）。补用例：在注入的 `home` 下放一份同名文档，覆盖影子、删除、改名三种路径。

## 测试缺口

1. `NodeRuntimeResolver` 的版本管理器分支（nvm / fnm / volta，POSIX 与 win32 两种布局）零用例；现有四条里两条是「不成立就直接 return」的软退，另一条直接读开发机真实环境，不隔离（`__tests__/NodeRuntimeResolver.test.ts:24-34`、:56-73）。
2. `ScratchWorkspaceService` 的 `[release-blocker]` 越界用例只试了不含 `..` 的样本，没有任何路径穿越形态（:199-211）。
3. 没有一条用例覆盖「运行中改临时根设置」：改根后的 `isScratchPath`、`wipeAll` 覆盖面、`adopt` 是否还认得旧路径，全无断言。
4. 没有一条用例把 `release()` 与 worker 生命周期放在一起断言顺序（归档时 worker 仍活着的情形）。
5. `hostStderr` 缺「同一逻辑行被切成 N 段后共产生多少行」与「巨量无换行输出把 50 行窗口挤空」的用例。
6. 没有用例断言进日志的 stderr 也被脱敏（现有断言只覆盖 IPC 那一路）。
7. `TempWorkspaceService` 没有独立测试文件；`isTempWorkspacePath` 的尾部分隔符 / 分隔符方向形态无覆盖。
8. `subagentCatalog` 的兼容根 `~/.agents/subagents` 被测试显式指空，影子 / 删除 / 跨根改名三种行为零覆盖。
9. `piCliLayout.ts` 无测试（仅在 `piTuiHandover.test.ts:43` 被整体替身掉）；它是打包态与开发态布局分歧的单点。
10. `retiredSurfaceAbsence.test.ts` 只扫 `src` 与 `scripts` 两个根下的代码文件后缀，仓库根目录的配置文件（如 `electron.vite.config.ts`）与 `.json` 固定件不在扫描范围。

## 未经执行验证的声明

- main-aux-01 的两条投递路径（被改写的 `session-index.json`；cwd 含 `..` 的导入会话文件）我只做了代码追踪，没有真的构造过一个索引行或导入文件跑通端到端。守卫本身失效是可复算的确定事实，投递路径是静态推断。
- main-aux-02 在 Windows 上的表现（`rm` 因占用失败 → `removeQuietly` 吞掉 → 目录残留）是静态推断，未在 Windows 上实测；POSIX 上的顺序是代码可确定的，但「回合中途归档」的用户可见表现未实测。
- main-aux-06 的前提是「worker stderr 里确实会出现凭据形态的字符串」。我的依据是 `stderrRedaction.ts` 的规则表把这些形态列为预期输入，以及该模块文档自述的威胁模型；我没有抓到一份真实含凭据的 worker stderr。
- 「打包 macOS / Linux 下 `resources/node-runtime/node` 一定存在」这一点我只看到 `scripts/node-runtime-pin.mjs` 为三平台都有 pin，没有验证打包产物。
- `sessionWorkerKey` 在 macOS 这类大小写不敏感文件系统上不折大小写（`workerSessionKey.ts:34` 只对 Windows 风格路径折），理论上同一会话文件的两种拼法会得到两个键。我没能构造出会产出不同大小写会话文件路径的生产链路，故不立为发现。
- `@gotgenes/pi-permission-system` 仍是 `src/agent-host/package.json` 的依赖且被 `t31PiOnlyAbsence.test.ts:50` 断言必须存在；`bundledPlugins.mjs:22-25` 解释了保留理由（权限策略面板要读它的 `config.json`）。我没有独立核实这条理由今天仍成立，不立为发现。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| 归档一个正在跑回合的临时对话 | 目录删除发生在 worker 退出之后；没有残留目录，日志里没有 `[scratch] failed to remove` | 起应用、发一条长回合的消息、回合中点归档；随后看 `main.log` 与临时根下是否有残留目录 | windows（EBUSY 半边）+ dev-box（POSIX 半边） |
| 随包 Node 运行时缺失时的用户可见文案 | 横幅显示的是 `Pi Node runtime is missing: <路径>`，且不出现任何提及 `AICLIENT_NODE24_PATH` 的指引 | 打包后把 `resources/node-runtime/node.exe` 改名，起应用发一条消息，截图横幅 | windows |
| `AICLIENT_NODE24_PATH` 是否仍被宣传但无效 | 设置该环境变量后启动，worker 用的仍是随包 / Electron 的 node | 打包态启动前设变量，看 worker 进程的可执行路径 | windows |
| worker stderr 落进 main.log 的内容是否脱敏 | 日志中不出现 `sk-`、`Bearer <token>`、`*_API_KEY=<值>` 原文 | 用一个会在 stderr 打印环境的假 provider 触发 worker 启动失败，检查 `main.log` 的崩溃回放段 | utility（Electron utility 载体下的 stderr 管道）|
| 临时根改设置后的旧根 | 改设置 → 退出 → 重启，旧根下的 `unbound-sessions/` 是否还在；重开旧对话时侧栏是否仍标为临时会话 | 改设置前后各记一次两个根的目录列表与 `session-index.json` 的 `unbound` 位 | dev-box |
| 手工删除临时工作区后的自愈（保存位置带尾部分隔符） | 目录被就地重建且带 `.git`；不出现 `workspace_missing` 卡片 | 设置里把保存位置写成带尾部 `/` 的形式 → 建临时工作区 → 手工删目录 → 重开对话 | dev-box + windows（分隔符方向） |
| 兼容根子代理定义的删除语义 | 在 `~/.agents/subagents` 放一份定义，编辑后删除，观察行是否消失还是回到旧内容 | 设置页子代理列表操作前后各看一次两个目录 | dev-box |
| Electron utility 载体下的 stderr 组装 | 多块、跨块、CRLF 的 stderr 在 `main.log` 里是完整整行而非半行交织 | 让 worker 分块打印一段长 stderr，检查日志行形态 | utility |

## 读过的文件

- src/main/services/agent-host/NodeRuntimeResolver.ts
- src/main/services/agent-host/ScratchWorkspaceService.ts
- src/main/services/agent-host/TempWorkspaceService.ts
- src/main/services/agent-host/hostStderr.ts
- src/main/services/agent-host/piCliLayout.ts
- src/main/services/agent-host/workerSessionKey.ts
- src/main/services/agent-host/nativeSubagentSettings.ts
- src/main/services/agent-host/subagentCatalog.ts
- src/main/services/agent-host/PiWorkerProcess.ts
- src/main/services/agent-host/createPiWorkerSlot.ts
- src/main/services/agent-host/index.ts
- src/main/services/agent-host/WorkerManager.ts（节选：stderr 段、unbound 段、key 段、closeSession）
- src/main/services/agent-host/WorkerSlot.ts（节选：错误码）
- src/main/services/agent-host/\_\_tests\_\_/NodeRuntimeResolver.test.ts
- src/main/services/agent-host/\_\_tests\_\_/ScratchWorkspaceService.test.ts
- src/main/services/agent-host/\_\_tests\_\_/hostStderr.test.ts
- src/main/services/agent-host/\_\_tests\_\_/subagentCatalog.test.ts（用例名与注入段）
- src/main/services/agent-host/\_\_tests\_\_/nativeSubagentSettings.test.ts（节选）
- src/main/services/agent-host/\_\_tests\_\_/retiredSurfaceAbsence.test.ts
- src/main/services/agent-host/\_\_tests\_\_/t31PiOnlyAbsence.test.ts
- src/main/ipc/chat.ts（节选：create / ensureScratch / register / resume / close / archive）
- src/main/ipc/workerManager.ts
- src/main/ipc/settings.ts（节选：readSettings / write 防抖 / MAIN_OWNED_SETTING_KEYS）
- src/main/ipc/piResources.ts（节选：opt-in 键写入）
- src/main/services/piModelConfig/index.ts（节选：agent 目录与 worker/PTY 环境）
- src/main/services/piPlugins/index.ts
- src/main/services/terminal/PiTuiPty.ts（节选：launch plan）
- src/main/services/legacyImport/LegacyImportService.ts（节选：resolveWorkspace / unbound）
- src/shared/defaultPaths.ts
- src/shared/utils/path.ts（节选：normalizePath / canonicalPathKey）
- src/agent-host/stderrRedaction.ts（节选）
- src/agent-host/bundledPlugins.mjs（节选）
- src/runtime/worker/nativeWorkerRuntime.ts（节选：subagents 段、agentDir 段）
- src/runtime/plugins/subagent/catalog.ts（节选：roots / disabled）
- src/renderer/components/chat/hostStatus.ts（节选）
- src/renderer/components/chat/HostStatusBanner.tsx
- src/renderer/components/chat/sessionIndex/useSessionIndex.ts（节选：archive / close）
- src/renderer/components/settings/GeneralSettings.tsx（节选：保存位置输入）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md
- docs/plantree/plans/runtime-evolution/README.md
- docs/plantree/plans/runtime-evolution/topics/field-followups.md
- docs/plantree/plans/runtime-hardening/roadmap.md
