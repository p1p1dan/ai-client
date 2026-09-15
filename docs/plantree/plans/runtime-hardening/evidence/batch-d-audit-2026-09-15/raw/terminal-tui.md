# 批次 D 补审：终端 / TUI 侧（H/20 互通的另一半）

- 区域：terminal-tui（任务 T029，对应批评者缺口 20）
- 节点判定对象：H/20 Main 半边、TUI-1、GUI A/2 代码侧
- 基线：HEAD `ebc82f16`（批次 A / B / C 与 T036 全部落地后）
- 日期：2026-09-15
- 方式：只读（git log / show / grep / cat），未构建、未跑测试、未起 Electron

## 总评

审计当时未读的三个模块（`PiTuiPty.ts`、`PtyManager.ts`、`ShellDetector.ts`）读完之后，H/20 判定里那句「TUI 路径只有 Main 进程内的 `PiTuiExclusiveGuard`，不碰 writer.lock」属实：Main 侧从头到尾没有任何一处去碰 runtime 的写锁文件，互斥完全靠单进程内的一个字符串槽位加「杀终端」这个动作本身。配合 `app.requestSingleInstanceLock()`（`src/main/index.ts:269`）只允许一个应用实例，这个设计在正常路径上是成立的。

T003（`0332214c`）补上的那半边——`tuiWrittenSessions`「进门就记、GUI 读回才删」——是这条链上最关键的一块，它让「pi 自己退出、Main 没东西可杀」不再等于「不用重读」。我逐条走了任务书里列的七种情形（CLI 异常退出、PTY 未清理、用户在 pi 里退出、应用退出、同一会话两个终端、终端关闭事件丢失、kill 后未 flush），其中五种当前代码能正确收口，两种仍有洞：**索引读失败会整条跳过闸门**（terminal-02），以及**kill 是「发出即当成功」，既不等进程真退出也不校验**（terminal-01）。

另外查证了一个原本担心的点并排除了它：pi 的 `SessionManager` 落盘用的是 `appendFileSync`（`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:732/753`），不存在「缓冲区里还有没写出去的内容」这种状态，所以「kill 后 CLI 尚未 flush」这条隐患的主体不成立，剩下的只是「信号送达到进程真正终止之间还能再写一行」这个很窄的时间窗。

渲染层这半边（GUI A/2）问题比 Main 侧多：终端 id 是**整个应用一份**、和会话不绑定，而会话列表在 TUI 模式下照样可点，于是「在终端模式下切换会话」会留下一个绑在上一个会话 JSONL 上的终端（terminal-03）。这条不会写坏文件（`tuiWrittenSessions` 兜住了），但用户在终端里敲的内容会进另一个会话的历史。

区域外沿的两个模块（`PtyManager` / `ShellDetector`）服务的是普通终端而不是 pi TUI，那里各有一条与 pi 无关的老问题（terminal-08 / terminal-09）。

## 优点

1. **「进门就记」的方向选对了**。`src/main/ipc/piTui.ts:137` 在 `controller.open()` 之前就把会话键写进 `tuiWrittenSessions`，注释也写明了理由。这让「pi 自行退出 → onExit 先把 guard 释放了 → disposeSession 无事可做」这条 session-01 的原始触发路径失效。
2. **闸门的作用域改对了**。`assertHostPromptAllowed(sessionKey)`（`piTuiSession.ts:112`）按会话键判断而不是「有没有终端活着」，所以「A 的终端挂着、在 B 里发消息」不会被误伤，这正是 cutover-04 的取舍。
3. **归一化键在三处统一**。guard、controller 的 `disposeSession`、`tuiWrittenSessions` 都过 `normalizeSessionKey`，macOS `/private` 漂移这条 pix 踩过的坑被一次性堵住，并且有针对性用例（`piTuiSession.test.ts:19/97`、`PiTuiPty.test.ts:204`）。
4. **TUI-1 的闸门是「只有确证才拒」**。`inspectPiTuiSessionSupport`（`piTuiSession.ts:146`）读不到、解析不了一律放行，只有 `kind:'header' && version===4 && type!=='session'` 才拒。我核了头部的实际字段（`src/runtime/plugins/session/codec.ts:95` 的 `interopHeader` 只加 `type` 与 `timestamp`），加上 `kind/version/id/createdAt/cwd`，总长远小于 8192 字节，所以「头部行超过读取窗口被截断导致误放行」不可达。
5. **决策 011 的「公司渠道可用」是真跑出来的**。`piTuiManagedChannel.test.ts` 用仓库生产代码生成 `models.json` / `auth.json`，在清空凭据的环境里 spawn 真 pi CLI 断言模型列表与请求落点——这是本区域唯一一处不靠阅读的证据。
6. **凭据剥离清单是共享的单一来源**。`PiTuiPty.ts:16` 直接 import `scripts/credential-env-keys.mjs`，与 `dev.js`、`managedCredentialsStartup.ts` 同一份，不存在副本漂移。另外核实 Main 自己的 `process.env` 只做「删」不做「写」（`managedCredentialsStartup.ts:38-44`），所以普通终端 `{...process.env}` 全量继承并不会把公司 key 带进用户 shell。

## 弱点

1. 「杀掉另一个写者」这个动作没有任何回执：kill 抛错被吞、不等退出、不复验，而整条非对称保护的正确性建立在「它真的死了」上（terminal-01）。
2. 闸门有一条静默旁路：索引读失败时 `handOverFromTui` 直接 return，释放和闸门一起被跳过（terminal-02）。
3. 终端身份与会话身份在渲染层是脱钩的：一个应用级 `tuiTerminalId`，而 `useXterm` 的初始化不随 `sessionFile` 变化重跑（terminal-03、terminal-04）。
4. 两处「注释/守卫测试说的话」与实现相反：`suspend` 被描述成让另一个写者停笔（terminal-07），T35 守卫声称 TUI 不带 resume 参数（terminal-05）。
5. `ShellDetector` 的自定义 shell 推参用子串匹配，`/bin/sh` 会被判成 PowerShell（terminal-08）；Windows 默认 shell 与产品默认不一致且 spawn 失败无回退（terminal-09）。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| H/20 Main 半边 | complete-with-gaps | 互斥 + 杀终端 + 重读三步齐备，T003 的 `tuiWrittenSessions` 把「pi 自行退出」这条原始触发路径堵死；但 kill 无回执（terminal-01）与索引读失败静默跳闸（terminal-02）各留一个洞，terminal-07 的注释与实现不符会误导后续维护者 |
| TUI-1 | complete | 渲染层预检（`usePresentationSwitch.ts:105`）与 IPC 复检（`piTui.ts:128`）双重入口都在，判定只读文件头且只在确证 v4 非 interop 时拒绝，头部长度远小于读取窗口，误判风险低；加密机上这条闸门会 fail-open（读不到明文 → 放行），但那是文档明写的取舍方向，列为上机检查项而非缺口 |
| GUI A/2 代码侧 | complete-with-gaps | 离开 TUI 的「suspend → reload」与「pi 自退 → 无条件 reload」两条路都在且有守卫测试；但终端 id 与会话不绑定（terminal-03）、复活路径丢 `sessionFile`（terminal-04）、TUI 活动指示灯键不匹配恒不亮（terminal-06） |

## 发现

### [terminal-01] medium robustness | H/20 Main 半边 | src/main/services/terminal/PiTuiPty.ts:333 | kill 发出即当成功：不等进程退出、不校验、失败被吞

DESC：`#disposeNow` 先把终端从 `#live` 里删掉，再 try/catch 调 `pty.kill()`，catch 里只有一句「Process may already have exited」的注释。于是三件事同时成立：(a) kill 抛错时失败被吞，控制器照样发 `dead` 状态、`disposeSession` 照样把这个 terminalId 当作「已杀」返回；(b) 因为条目已从 `#live` 删除，`pty.onExit` 回调开头的 `active` 检查会直接 return，Main 侧的 `onExit`（`piTui.ts:64`，负责释放 guard、给渲染层发 `PI_TUI_EXIT`）永远不会为这条路径触发；(c) 整个链路没有任何一步等待进程真正退出。`releaseSessionForHostPrompt` 因此在「信号已发出」而不是「另一个写者已死」的时刻返回 true，紧接着 `handOverFromTui` 就去重读文件。unix 上 node-pty 的 kill 是 `process.kill(this.pid, 'SIGHUP')`（`node_modules/node-pty/lib/unixTerminal.js:228`），只发给 pi CLI 自己、不发进程组，也不升级到 SIGKILL。static_inference：kill 失败与「信号送达到进程终止之间还能再追加一行」这两种形态都需要真机（尤其 Windows 的 conpty 路径）才能观察，本轮没有执行证据。

EVIDENCE：
```ts
// src/main/services/terminal/PiTuiPty.ts:333
  #disposeNow(terminalId: string): void {
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
```
```ts
// src/main/ipc/piTui.ts:188 —— 杀完立刻返回，返回值直接决定要不要重读
  const results = await Promise.allSettled(
    [...controllers.values()].map((controller) => controller.disposeSession(sessionFile))
  );
  sessionGuard.release(sessionFile);
```

SCENARIO：用户在 TUI 里发起一轮回答，流式输出进行中切回 GUI（`openGui` 只 suspend，pi 进程继续跑、继续 `appendFileSync`），然后在 GUI 里发一条消息。`handOverFromTui` → `disposeSession` 发出 SIGHUP 即返回 → guard 释放 → 闸门放行 → `reloadSession` 走 IPC 到 worker 重读文件（几十毫秒）。若 pi 在信号真正生效前又追加了一条 entry，worker 拿到的仍是旧 seq，下一次 GUI 追加就是 session-01 那类「按陈旧 seq 写入」的形态。Windows 上还多一层：`WindowsTerminal.kill` 走 conpty agent，失败同样会被这里的 catch 吞掉，届时 GUI 与一个仍然活着的 CLI 同时写同一个 JSONL。

FIX：把 `#disposeNow` 改成可等待：kill 之后等 `onExit`（或轮询 pid）带超时，超时后升级信号（unix `SIGKILL`，Windows 走 `killProcessTree` 的 taskkill /T /F），并让 `disposeSession` 返回「确认已退出」与「超时未确认」两种结果；`releaseSessionForHostPrompt` 在未确认时不要释放 guard，让 `assertHostPromptAllowed` 把这次 GUI 写入挡下来（这正是 cutover-04 那道闸门存在的意义）。kill 抛出的异常至少要 `console.warn` 出来，不能与「进程早已退出」混为一谈。

### [terminal-02] medium correctness | H/20 Main 半边 | src/main/ipc/chat.ts:134 | 会话索引读失败时，释放与闸门被一起跳过，GUI 直接开写

DESC：`handOverFromTui` 取会话文件走 `sessionIndexService.get`，这一步失败时 catch 里只打一条 warn 然后 `return`——释放（`releaseSessionForHostPrompt`）、闸门（`assertHostPromptAllowed`）、重读三步全部不执行，调用方（send / compact / rewind）继续往下走。函数头的注释把整体说成「Best-effort by design」，但这条早退跳过的是 cutover-04 明确要求「即使释放没发生也要拦住」的那道闸门，而不是某个尽力而为的步骤。注意同一函数里另一条失败路径处理得是对的：`releaseSessionForHostPrompt` 抛错时被 catch 住，但随后仍然调用 `assertHostPromptAllowed(sessionFile)`。

EVIDENCE：
```ts
// src/main/ipc/chat.ts:129
  try {
    sessionFile = (await sessionIndexService.get(sessionId))?.runtimeIdentity;
  } catch (error) {
    console.warn('[chat] Failed to read the session row before a GUI write:', error);
    return;                     // ← 释放 / 闸门 / 重读 三步一起被跳过
  }
  if (!sessionFile) return;
  const { assertHostPromptAllowed, releaseSessionForHostPrompt } = await import('./piTui');
```

SCENARIO：一个 pi 终端正开在会话 A 上（guard 持有 A），此时会话索引的一次读取失败（索引文件被占用、行损坏、磁盘瞬时错误——`sessionIndexService.get` 是有抛出路径的）。用户在 GUI 里对同一个会话点发送：`handOverFromTui` 在第一步就 return，终端没被杀、guard 没被问、文件没被重读，`workerManager.send` 直接让 worker 往同一个 JSONL 追加，于是出现两个活写者。

FIX：catch 分支不要裸 return。索引读不出来时，退化成「应用级」判断：调用 `assertHostPromptAllowed()`（不带 key，任何终端持有任何会话都抛）把这次写入挡下来，或者用 `controller.status()` 确认当前确实没有任何活终端再放行。两者都比「读不到就当没有终端」安全，且与函数注释里「failing the write is better than becoming its second writer」的自述一致。

### [terminal-03] medium correctness | GUI A/2 代码侧 | src/renderer/components/chat/usePresentationSwitch.ts:96 | 终端 id 是应用级的：在 TUI 模式下切换会话，终端仍绑在上一个会话的 JSONL 上

DESC：`tuiTerminalId` 由 `setTuiTerminalId((current) => current ?? 'pi-tui-' + uuid)` 生成，只在「工作区路径变化」时才被清掉（`usePresentationSwitch.ts:222-229`），不随 `activeSessionId` 变化。`ChatWorkspace.tsx:214` 用这个 id 渲染 `AgentTerminal`，`sessionFile` 取当前会话的 `runtimeIdentity`；而 `useXterm` 的初始化 effect 依赖里只有 `piTuiTerminalId`，没有 `piTuiSessionFile`（`src/renderer/hooks/useXterm.ts:826` 起的依赖数组），所以 `sessionFile` 变了不会重新 open。即使重新 open，Main 侧 `#openExclusive` 的「已存在则恢复」分支也完全忽略请求里的 `sessionFile`（`PiTuiPty.ts:186-201`）。同时 TUI 模式下侧栏与 `SessionBar`（含「New chat」按钮）都照常渲染（`WorkspaceShell.tsx:211` 之后只调整布局，不隐藏会话入口）。static_inference：这条链路是读源码推出来的，需要起 Electron 点两下才能坐实。

EVIDENCE：
```ts
// src/renderer/components/chat/usePresentationSwitch.ts:94
    const start = () => {
      setPresentationMode('tui');
      setTuiTerminalId((current) => current ?? `pi-tui-${crypto.randomUUID()}`);
    };
```
```ts
// src/main/services/terminal/PiTuiPty.ts:186 —— 恢复分支不看 sessionFile
    const current = this.#live.get(request.terminalId);
    if (current) {
      current.suspended = false;
      ...
      return { terminalId: request.terminalId, generation: current.generation, resumed: true };
    }
```

SCENARIO：在会话 A 打开 TUI（终端跑 `pi --session A.jsonl`）→ 不离开终端模式，在侧栏点会话 B（同一个仓库目录，所以工作区路径不变）→ 界面标题、会话栏都变成 B，终端画面仍是 A 的 pi 会话，用户接着敲的所有内容写进 A 的 JSONL。文件不会写坏（回到 A 发消息时 `tuiWrittenSessions` 仍记着 A，会触发重读），但「我以为我在 B 里对话，内容却进了 A」是用户可见的错误行为。「New chat」按钮在 TUI 模式下同样可点，路径相同。

FIX：让终端身份带上会话身份。最小改法是把 `tuiTerminalId` 改成按 `activeSessionId` 记的映射（`Map<sessionId, terminalId>`），切会话时换 id（`useXterm` 依赖 `piTuiTerminalId`，换 id 天然触发重建，Main 侧容量上限会把旧的挂起/淘汰）；或者在 `#openExclusive` 的恢复分支里比较 `live.sessionKey` 与请求的 `sessionFile`，不一致就拒绝恢复并要求调用方换 id。两者都要配一条「TUI 模式下切会话」的用例。

### [terminal-04] low robustness | GUI A/2 代码侧 | src/renderer/hooks/useXterm.ts:981 | 复活用的 open 不带 sessionFile：PTY 已不在时会静默起一个全新的 pi 会话

DESC：终端重新变为活跃时的那次 `piTui.open` 只传 `terminalId / cwd / cols / rows`，没有 `sessionFile`。活终端存在时走恢复分支没事；但只要那一刻 `#live` 里已经没有这个 terminalId（pi 快速失败自退、被容量淘汰、被别处 dispose），Main 就会进入新建分支，用 `buildPiTuiArgs(cliPath, undefined)` spawn 一个**不带 `--session`** 的全新 pi 会话，同时因为请求里没有 `sessionFile`，IPC 也不会做 TUI-1 检查、不会 `transferTo`、不会记 `tuiWrittenSessions`。

EVIDENCE：
```ts
// src/renderer/hooks/useXterm.ts:981
    void window.electronAPI.piTui
      .open({
        terminalId: piTuiTerminalId,
        cwd: cwd || window.electronAPI.env.HOME,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .catch(() => {});
```

SCENARIO：pi CLI 起来就失败并退出（例如会话里的模型本机没有、配置错误），退出事件先把 `#live` 里的条目删掉；紧接着的那次渲染把 `isLoading` 翻成 false，本 effect 触发 → Main 看不到活终端 → 新建分支 → 起一个与当前聊天毫无关系的空白 pi 会话。由于 pi 的会话文件是懒写的（第一条 assistant 消息才落盘），通常不会留下垃圾文件，但用户会看到一个「莫名其妙变成新会话」的终端，且这个终端不在任何 guard / 重读记账里。

FIX：这次复活调用也带上 `piTuiSessionFile`（与首次 open 同源），让恢复失败时的新建分支仍然绑定同一个 JSONL 并重新走一遍 TUI-1 检查与记账；或者给 `open` 增加一个「只恢复、不新建」的模式给这条路径用。

### [terminal-08] medium correctness | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:327 | 自定义 shell 推参用子串匹配，`/bin/sh` 被判成 PowerShell

DESC：`inferExecArgs` 拿 shell 文件名去和所有 shell 定义的 `paths` 做 `includes` 子串匹配，而 Windows 定义排在数组前面。文件名 `sh` 是 `pwsh.exe` 的子串，于是在 Unix 上把 `/bin/sh` 判成 PowerShell 7，返回 `['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command']`。更糟的是这正好是「自定义 shell 但路径没填」的默认值：`resolveShellForCommand` 第一句就是 `config.customShellPath || (isWindows ? 'powershell.exe' : '/bin/sh')`，随后把这个默认值交给 `inferExecArgs`。

EVIDENCE：
```ts
// src/main/services/terminal/ShellDetector.ts:321
  private inferExecArgs(shellPath: string, customArgs?: string[]): string[] {
    const shellName = shellPath.split(/[/\\]/).pop()?.toLowerCase() || '';
    const allDefs = [...WINDOWS_SHELLS, ...UNIX_SHELLS];
    for (const def of allDefs) {
      if (def.paths.some((p) => p.toLowerCase().includes(shellName))) {
        return def.execArgs;      // 'pwsh.exe'.includes('sh') === true
      }
    }
```
```ts
// src/main/services/terminal/ShellDetector.ts:276
    if (config.shellType === 'custom') {
      const shell = config.customShellPath || (isWindows ? 'powershell.exe' : '/bin/sh');
      const execArgs = this.inferExecArgs(shell, config.customShellArgs);
```

SCENARIO：用户在「设置 → 终端 → Shell」里选 Custom（`TerminalSettings.tsx:161`），路径输入框默认是空的；或者显式填 `/bin/sh`。此后 `getShellForCommand()`（`src/main/utils/shell.ts:117`）返回的 args 是 PowerShell 的四个开关，`execInPty` 于是执行 `/bin/sh -NoLogo -ExecutionPolicy Bypass -Command "tmux -V"`，命令必然失败——现表现为 tmux 探测恒判「未安装」（`TmuxDetector.ts:25`）。影响面今天只有 execInPty 这一条（`shell.resolveForCommand` 的 IPC/preload 出口目前没有任何渲染层调用方），但任何新接入这条推参逻辑的调用方都会中招。

FIX：把子串匹配换成文件名精确匹配（对 `def.paths` 取 basename 后比较，Windows 还要去掉 `.exe`），并在匹配前按平台过滤 `allDefs`（Unix 上根本不该考虑 WINDOWS_SHELLS）。顺带给「自定义但路径为空」一个显式分支，不要用 `/bin/sh` 冒充用户的选择。

### [terminal-09] low windows | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:356 | Windows 默认 shell 返回 pwsh.exe，且 PtyManager 的 spawn 失败回退只有 Unix 分支

DESC：两处不一致叠在一起。`getDefaultShell()` 在 Windows 上无条件返回 `'pwsh.exe'`，而产品默认设置明确写的是 PowerShell 5.x（`src/renderer/stores/settings/defaults.ts:308`，注释就是「PowerShell 7 需要单独安装」）。同时 `PtyManager.create` 的 spawn 失败回退只在 `!isWindows` 分支里，Windows 分支直接 `throw error`；create 前那次 `existsSync(shell)` 预检也同样只在非 Windows 执行。static_inference：Windows 上一次都没跑过，本条是静态阅读结论。

EVIDENCE：
```ts
// src/main/services/terminal/ShellDetector.ts:354
  getDefaultShell(): string {
    if (isWindows) {
      // Try pwsh.exe (PowerShell 7) from PATH first
      return 'pwsh.exe';
    }
```
```ts
// src/main/services/terminal/PtyManager.ts:396
    } catch (error) {
      if (!isWindows) {
        ... // 找一个可用 shell 重试
      } else {
        throw error;
      }
    }
```

SCENARIO：两条路。其一，任何不带 `shell` 也不带 `shellConfig` 的 `session.create`（渲染层今天总会带上设置里的 `shellConfig`，所以这条主要是留给远端/未来调用方的坑）在没装 PowerShell 7 的 Windows 上会尝试 spawn 不存在的 `pwsh.exe`。其二，用户填了自定义 shell 路径后把那个程序卸载/改名：Unix 上会静默回退到可用 shell，Windows 上直接把 node-pty 的原生 spawn 错误抛给渲染层，终端面板显示的是 `Error invoking remote method 'session:create': ...` 这类原文。

FIX：`getDefaultShell()` 的 Windows 分支改为先探测 `pwsh.exe`、不可用则退回 `powershell.exe`（`commandExists` 已有现成实现），与渲染层默认对齐；`PtyManager.create` 的回退逻辑对 Windows 也给一条（`powershell.exe` → `cmd.exe`），至少保证失败时给出一句可读的说明而不是原生 spawn 错误。

### [terminal-05] low test-gap | H/20 Main 半边 | src/main/services/terminal/__tests__/t35FinalAbsence.test.ts:108 | 守卫用例声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 `--session` 续接会话

DESC：这条用例叫「uses absolute bundled Pi CLI and packaged Node paths without resume flags」，断言 `PiTuiPty.ts` 文本里不出现 `'--session'`。该断言今天之所以还绿，只是因为 Q17 之后拼参数的代码搬到了 `piTuiSession.ts` 的 `buildPiTuiArgs`，而 TUI 的行为恰恰相反：只要聊天有 JSONL，跑的就是 `pi --session <file>`。一条用名字和断言共同陈述「我们不做 X」的守卫，在我们已经做了 X 之后仍然绿，会把后来的人引向错误结论（例如「把拼参数挪回 PiTuiPty 就会判红」这种误伤，或者反过来以为 TUI 从不续接会话）。

EVIDENCE：
```ts
// src/main/services/terminal/__tests__/t35FinalAbsence.test.ts:108
  it('uses absolute bundled Pi CLI and packaged Node paths without resume flags', () => {
    const service = read('src/main/services/terminal/PiTuiPty.ts');
    ...
    expect(service).not.toContain("'--session'");
    expect(service).not.toContain("'--continue'");
  });
```
```ts
// src/main/services/terminal/piTuiSession.ts:48
export function buildPiTuiArgs(cliPath: string, sessionFile?: string | null): string[] {
  const file = sessionFile?.trim();
  return file ? [cliPath, '--session', file] : [cliPath];
}
```

SCENARIO：任何按这条守卫理解 TUI 行为的人（包括下一轮审计）都会得出「内嵌终端从不接管既有会话文件」的结论，而这正是 H/20 整条互斥设计存在的原因。守卫本身也失去了意义：它现在只能防住「有人在 PiTuiPty.ts 里写 `--session` 字面量」，防不住任何真实回归。

FIX：把这条改成陈述实际不变量的两句——`--continue` / `--resume` 这类「pi 自选会话」的参数在整个 TUI 路径（`PiTuiPty.ts` + `piTuiSession.ts`）里都不出现；`--session` 只能由 `buildPiTuiArgs` 产出且必须带显式文件参数。用例名同步改掉。

### [terminal-07] low docs | GUI A/2 代码侧 | src/renderer/components/chat/__tests__/tuiHandoverWiring.test.ts:42 | 「suspend 之后另一个写者不再追加」这句话不成立

DESC：`openGui` 的做法是 `piTui.suspend(terminalId)` 然后 `chat.reloadSession`，守卫用例把这个顺序钉死并解释为「the reload has to read a file the other writer is no longer appending to」。但 `suspend` 在 Main 侧只做两件事：把 `live.suspended = true`、把后续 PTY 输出转存进重放缓冲（`PiTuiPty.ts:273-281`）。pi CLI 进程完全不受影响，仍在跑、仍在 `appendFileSync` 写同一个 JSONL。`usePresentationSwitch.ts:132-146` 的大段注释同样把 suspend 描述成安全边界。

EVIDENCE：
```ts
// src/main/services/terminal/PiTuiPty.ts:273
  suspend(terminalId: string): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (!live) return;
      live.suspended = true;          // 只影响输出转发，不影响进程
```
```ts
// src/renderer/components/chat/__tests__/tuiHandoverWiring.test.ts:42
    // Order is the correctness point, not a preference: the reload has to read
    // a file the other writer is no longer appending to.
```

SCENARIO：用户在 TUI 里发起一轮回答，回答还在流式产出时点 GUI。suspend 立即返回、reload 立即执行，而 pi 随后把这一轮剩下的条目继续写进文件——GUI 时间线缺这一段。只要用户后续在该会话有一次 GUI 写入（send / compact / rewind），`tuiWrittenSessions` 会触发「杀 + 重读」把它补回来，所以不是持久错误；但注释把一个「顺序偏好」说成了「正确性保证」，谁按它推理下一处改动都会推错。

FIX：改写这两处注释说清真实语义（suspend 只停转发，真正的写者停止靠 send 路径的 dispose），并在 `openGui` 的 reload 之后补一句「此刻可能仍落后于文件，下次写入前会再读一次」。若要让离开终端时的时间线立即完整，需要的是等 pi 那一轮结束或直接 dispose，而不是 suspend。

### [terminal-06] low dead-code | GUI A/2 代码侧 | src/renderer/stores/worktreeActivity.ts:294 | TUI 活动指示灯拿 terminalId 当会话 id 查表，永远查不到

DESC：`initAgentActivityListener` 订阅 `piTui.onData` / `onExit`，用 `event.terminalId` 去 `useAgentSessionsStore.sessions` 里按 `s.id` 找 cwd。但 TUI 的 terminalId 形如 `pi-tui-<uuid>`（`usePresentationSwitch.ts:96`），而 `useAgentSessionsStore` 的条目 id 来自已退役的 agent PTY 路线——全仓库唯一的 `addSession(` 调用在 `src/renderer/hooks/useTerminal.ts:37`，写的是另一个 store（`useTerminalStore`）。也就是说 `useAgentSessionsStore.sessions` 在当前代码里没有任何生产写入方，这个监听器 `setForSession` 里的 `if (cwd)` 永远为假。

EVIDENCE：
```ts
// src/renderer/stores/worktreeActivity.ts:293
export function initAgentActivityListener(): () => void {
  const setForSession = (sessionId: string, state: AgentActivityState) => {
    const cwd = useAgentSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.cwd;
    if (cwd) useWorktreeActivityStore.getState().setActivityState(cwd, state);
  };
  const unsubscribeData = window.electronAPI.piTui.onData((event) => {
    setForSession(event.terminalId, 'running');
  });
```

SCENARIO：用户在某个 worktree 里用 TUI 跑一轮，侧栏/worktree 列表的活动指示（绿点）不会亮，也不会在结束后置为 completed。`App.tsx:109` 每次启动都注册这个监听器，它只是恒定空转。这属于 T35 退役后失去消费者的那一层（P6-5 的尾巴）。

FIX：二选一。要留这个能力，就把 TUI 的 cwd 记在一张以 terminalId 为键的表里（`PiTuiOpenRequest` 里本来就有 cwd，Main 也在 `LiveTerminal.cwd` 存着，可以随 data/exit 事件带出来）；不留就把 `initAgentActivityListener` 与 `useAgentSessionsStore` 里已无写入方的部分一起删掉，别留一个恒假分支。

### [terminal-10] low contract-gap | H/20 Main 半边 | src/main/ipc/piTui.ts:162 | `dispose()` 不带 terminalId 会让这个窗口的控制器永久报废

DESC：`PI_TUI_DISPOSE` 的 handler 在没有 terminalId 时调 `controller.disposeAll()`，而 `disposeAll` / `disposeAllSync` 会把 `#disposed` 永久置真（`PiTuiPty.ts:306-316`），此后该实例的每次 `open` 都抛 `Pi TUI controller is disposed`。应用退出与登出走的 `disposeAllPiTuiControllers()` 之所以没事，是因为它在之后 `controllers.clear()` 了，下次会新建；从 IPC 这条路进来的实例则留在 `controllers` 里，窗口不重开就再也起不来终端。preload 把这个重载暴露成了公共 API（`src/preload/index.ts:487` 的 `dispose: (terminalId?: string)`）。诚实标注：今天渲染层所有调用都带 id，所以没有现行触发路径，这条是契约面的坑而非现行缺陷。

EVIDENCE：
```ts
// src/main/ipc/piTui.ts:162
  ipcMain.handle(IPC_CHANNELS.PI_TUI_DISPOSE, async (event, terminalId?: string) => {
    ...
    if (terminalId) await controller.dispose(terminalId);
    else await controller.disposeAll();      // #disposed 永久置真，实例仍留在 controllers 里
  });
```

SCENARIO：任何一次 `window.electronAPI.piTui.dispose()`（漏参、未来新调用方、清理路径复用）都会让当前窗口在本次应用生命周期内彻底失去内嵌终端，界面上表现为每次点 TUI 都弹一句英文原文错误。

FIX：两条都要。IPC 的整窗清理路径改成「`disposeAll()` 之后把该控制器从 `controllers` 里摘掉」，与 `disposeAllPiTuiControllers` 一致；或者干脆取消 `dispose()` 的无参重载，让整窗清理只走 `disposePiTuiWindow`。

## 测试缺口

1. `PiTuiPty.test.ts` 的 `FakePty.kill()` 永远成功、且不触发 exit 监听，所以「kill 抛错」「kill 之后进程仍活」「dispose 路径不会触发 onExit」这三件事一条用例都没有——terminal-01 正踩在这个盲区上。
2. `handOverFromTui` 的索引读失败分支（terminal-02）无用例：`piTuiHandover.test.ts` 与 `chatPiWorkerRouting.test.ts` 都是在 `sessionIndexService.get` 成功的前提下验证释放/闸门/重读。
3. 没有任何用例覆盖「在 TUI 模式下切换活跃会话」或「同一会话开两个终端」（terminal-03）。`PiTuiPty.test.ts:191` 只验证了「disposeSession 只杀那条 JSONL 上的终端」，没有验证「同一 JSONL 上不该同时有两个终端」。
4. `useXterm` 的复活 open（terminal-04）无用例；渲染层这块只有 `tuiHandoverWiring.test.ts` 的源码文本扫描，扫不到依赖数组与参数缺失这类问题。
5. `ShellDetector.test.ts` 只有两条用例，全是 Windows PowerShell 回退；`inferExecArgs`、自定义 shell、Unix 分支、`resolveShellForCommand` 一条没有（terminal-08）。
6. `PtyManager` 没有任何单元测试文件（目录下只有 ShellDetector / PiTuiPty / piTuiSession / piTuiManagedChannel / t35FinalAbsence 五个），spawn 失败回退、`destroyAndWait` 超时、`destroyByWorkdir` 的路径归一化都没有回归保护。
7. 没有「Windows 形态」的 `resolvePiCliLaunchPlan` 用例覆盖 `PATH` / `Path` 双键合并与 `node.exe` 拼接（`PiTuiPty.ts:126-136`）。

## 未经执行验证的声明

- pi CLI 收到 SIGHUP 后是否总是立即退出：bundle 里只搜到一处 `process.on("SIGINT")`，SIGHUP 相关字符串出现在被打包的第三方库里（`chunks/chunk-OMWWHBTG.js`，疑似 signal-exit 一类），无法从压缩产物确证其行为，也没有执行证据。
- terminal-01 里「信号送达与进程终止之间还能再追加一行」的时间窗大小：纯静态推断。已确证的部分只有「pi 用 `appendFileSync` 落盘，不存在未 flush 的缓冲」。
- Windows 上 node-pty 的 `kill`（conpty agent）失败形态、`taskkill /T /F` 的行为，以及 `resolvePiCliLaunchPlan` 同时写 `PATH` 与 `Path` 两个键后 conpty 的取值：全部未在 Windows 执行。
- terminal-03 / terminal-04 的触发链是读渲染层源码推出来的，没有起过 Electron 点验。
- 「同一会话在两个窗口各开一个终端」：`PiTuiExclusiveGuard.transferTo` 是无条件转移、不拒绝，代码层面不阻止两个 `pi --session <同一文件>`；但我没能确证第二个窗口的 UI 能把同一个会话选中并进入终端模式，因此不立为发现。
- 加密机上 `inspectPiTuiSessionSupport` 的行为：`readSessionHead`（`piTuiSession.ts:176`）走裸 `node:fs/promises`，不经过 runtime 那条 TSD 回落路径。若会话目录受策略保护，这次读要么失败要么拿到密文，两种情况都会 fail-open 放行（与该函数文档的取舍方向一致），用户随后撞上 CLI 自己的报错。会话目录是否在策略范围内，本机无法判断。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| kill 之后 CLI 是否真的退出 | GUI 发送触发 `releaseSessionForHostPrompt` 后，原 pi 进程 pid 在重读完成前已不存在 | 开 TUI 记下 pid，GUI 发一条消息，`ps -p <pid>` 连续采样；同时 `tail -f` 会话 JSONL 看重读点之后还有没有 CLI 追加的行 | real-model |
| TUI 流式回合中途切 GUI | 时间线缺失的条目在下一次 GUI 发送后被补齐，且文件仍可打开 | 在 TUI 里发一个长回答，输出中途点 GUI，截图时间线；再发一条消息后对比 JSONL 行数 | real-model |
| TUI 模式下切换会话（terminal-03） | 切到另一个聊天后，终端画面是否仍是上一个聊天的 pi 会话；在终端里敲一句话后检查它落进哪个 JSONL | 同仓库两个聊天，TUI 模式下点侧栏切换，然后 `grep` 两个会话文件 | dev-box（需起 Electron） |
| 终端复活丢 sessionFile（terminal-04） | 让 pi 快速失败（临时改坏模型配置）后，终端是否变成一个空白新会话 | 起 TUI 观察是否出现第二次 spawn（Main 日志 / `ps` 看 `--session` 参数是否消失） | dev-box（需起 Electron） |
| Windows 默认 shell 与 spawn 回退 | 无 PowerShell 7 的机器上，内嵌终端能正常打开；自定义 shell 路径失效时给出可读错误而不是原生 spawn 报错 | 卸载/不装 pwsh，分别用默认设置与失效的自定义路径开终端截图 | windows |
| Windows 上的 TUI 启动计划 | `pi` 能起来，PATH 里确实含 node-runtime 目录，`Path`/`PATH` 双键不造成取值异常 | 打包版 Windows 上开 TUI，在 pi 里执行 `node -v` 与 `echo %PATH%` | windows |
| 加密机上的 TUI-1 闸门 | 旧 v4 会话在加密机上点 TUI：是被我们的中文提示拦住，还是直接进终端撞 CLI 原文报错 | 造一个 v4 非 interop 头的会话文件放进受保护目录，点 TUI 截图 | encrypted |
| 两个窗口对同一会话开终端 | 是否能出现两个 `pi --session <同一文件>` 进程 | 开第二个窗口选中同一聊天进 TUI，`ps aux | grep -- --session` | dev-box（需起 Electron） |
| utility 载体下的重读 | `worker.reload` 在 Electron utility 载体上同样在 `BOOTSTRAP_REQUEST_TIMEOUT_MS` 内完成（带 MCP 时） | TUI 交接后观察 reload 耗时与是否超时退槽 | utility |

## 读过的文件

见结构化返回的 `files_read`。
