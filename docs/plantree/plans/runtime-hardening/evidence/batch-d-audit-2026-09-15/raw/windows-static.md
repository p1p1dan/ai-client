# 批次 D 区域审查原文 — Windows 静态面与上机检查单

- **区域**：windows-static
- **任务**：T031（Windows 静态面部分），对应批评者缺口 12（`cross-and-critic.md` 第 75 行）
- **节点判定对象**：P1-8（载体兼容矩阵）、P4-0（同步平台 worker）、P4-6（打包与现场集成验收）的 Windows 面
- **HEAD**：`ebc82f16`
- **日期**：2026-09-15
- **重要前提**：本区域**没有一次 Windows 执行**。下面每一条结论都是读代码 + 读现场旧记录得出的静态推断（`static_inference = true`），凡是能在 Linux 上用 `node -e` 验证纯路径语义的，我都跑了并把输出贴在 EVIDENCE 里；凡是需要真机的，都进了上机检查单。

---

## 总评

Windows 面的代码质量不均匀：**进程树杀灭、分隔符折叠、env 大小写合并这三块写得很认真**（都有注释说明为什么，T001 / T022 各修过一轮），但**"Windows 上真实会出现的输入形态"这一层几乎没人想过**——Git Bash 的 `/c/...` 盘符写法、CRLF 文件、`.cmd` 形式的 MCP 启动器、OEM 代码页的子进程输出、PID 复用。这些不是"Windows 也许有点不一样"，而是那台加密机上**已经发生过的**事：现场记录里模型自己就写过 `cat /c/Users/JC/Desktop/...`（`test12-reverify.md:728`），探针文件本身就是"57 字节、含 CRLF 和中文"（同文件 :748），控制台还撞过 cp1252 编码错（:278）。

最要紧的一条是 windows-01：**Git Bash 的 `/c/...` 写法让 `~/.ssh/*` 这条不可覆盖的 deny 规则失效**。策略文件自己写着「`path` deny **不能**被 per-tool allow 覆盖」，而在 Windows 上换一种拼法就绕过去了。T001 修的是"分隔符混用导致通配展开成空集"（permissions-19），这是**另一件事**：不是分隔符，是盘符记法。

第二要紧的是 windows-02：**在 Windows 上，`runPipe` 唯一的成功出口是一个外部 `taskkill.exe` 进程在 2 秒内跑完**。Linux 上 `process.kill` 是一次系统调用，Windows 上是一次进程创建——而现场那台机器装着 TsdEncrypt、Sangfor aTrust、sprotect、HipsTray 四层安全软件（`environment.md:28-32`），进程创建正是它们钩的地方。taskkill 起不来或超 2 秒，一条**已经跑完、输出已经收全**的命令会被报成 `exec_cleanup_failed`。

第三是 windows-03：**stdio 型 MCP 服务器在 Windows 上基本起不来**，因为 `npx` / `uvx` / `npm` 在 Windows 上是 `.cmd`，而链路上两次 `spawn` 都是 `shell: false`。

另外有一条**好消息**值得写进判定：P4-0 名义上的"Node 解析"模块 `NodeRuntimeResolver.ts` 在产品里一个调用方都没有（这条已由 main-host-aux 区域立项，我不重复立发现）。它的意义是——**Windows 上机日不必测 nvm4w / volta / fnm 发现逻辑，那是死代码**；真正要测的只有"随包 `node.exe` 在不在、能不能起"这一条硬编码路径。这把上机日省下来的时间应该花在 windows-01～03 上。

---

## 优点

1. **`createTreeKiller` 的 Windows 重入保护是真做了**（`exec.ts:336-404`）。`windowsKillStarted` 保证一个 child 只起一次 `taskkill`，每个 taskkill 进来都进 `cleaners` 并在 `dispose` 时回收，失败被记进 `error` 而不是丢掉。注释还写清了为什么 `platform` 和 `spawnProcess` 要可注入（"Windows 分支是构建机上跑不到的那条"），配套有 5 条注入式用例（`host.test.ts:752-810`）。这是 T022 的成果，做法正确。
2. **分隔符折叠做了两件对的事**（`bash-analysis.ts:77-83`）：`normalizeShellPath` 把命令里的 `/` 折到平台分隔符，`splitShellPath` 分割时两种分隔符都认。`shellPolicy.test.ts:459-476` 用纯函数钉住了，不需要 Windows 机器。这是 T001 修 permissions-19 的正解。
3. **env 的 Windows 大小写语义处理得比多数项目细**（`exec.ts:415-437`）：override 键按大小写不敏感删旧键，所有 `PATH` / `Path` / `path` 变体先全删再写一个 `PATH`，避免 Node 在 win32 上按字典序去重时留下一个旧值。
4. **`resolveWorkerShell` 明确排除 WSL launcher**（`shell.ts:115`，只排 `system32` / `sysnative` 结尾的 PATH 项），并且认得 Git for Windows 把 `cmd` 目录放进 PATH、`bash.exe` 在隔壁 `bin` 的布局（:117-119）。注释写明了"不选 WSL：工具要 Windows cwd 和 runner 的原生进程树"。
5. **`appendFile` 的串行键在 Windows 上做了大小写归一**（`io.ts:179`），同一文件的两种拼法不会各排一条队。
6. **`exec-runner.mjs` 的 `disconnect` 自杀逻辑是对的**（:26-37）：worker 被强杀时 IPC 管道关闭，runner 自己 `taskkill /T /F` 掉整棵树，不留孤儿。这是 Windows 上没有进程组时唯一可靠的兜底。
7. **`PiWorkerProcess` 的 cwd 预检注释是从现场教训里长出来的**（:65-74）："缺失的临时工作区在 Windows 上表现为 `spawn ...\node.exe ENOENT`，而 node.exe 一直在盘上"。这种注释值得保留。

---

## 弱点

1. **"Windows 上的路径长什么样"这个问题没人系统问过。** 代码只想到了"分隔符可能是 `/`"，没想到 Git Bash 里 `pwd` 返回 `/c/...`、`$BASH` 返回 `/usr/bin/bash`、`cygpath` 存在。现场日志里模型已经在用这种写法了（windows-01）。
2. **Windows 分支的可测性不对称。** `createTreeKiller` 做了注入所以有 5 条用例；`runPipe` 里那份**功能几乎相同的内联 `killTree`**（`exec.ts:516-552`）硬编码 `process.platform`，一条用例都没有，而它才是 bash 工具实际走的那条（windows-02）。
3. **行尾、编码、代码页三件事全仓没有一处处理。** `grep` 修过 CRLF（tools-17，`index.ts:630`），`edit` / `write` 没有；bash 输出一律 `toString('utf8')`；`reg query` 一律 `encoding:'utf8'`。
4. **"平台能力缺失"没有统一的用户可见出口。** 没有 Git Bash → `shell_unconfigured`（全仓零消费者）；随包 node 缺失 → `Pi Node runtime is missing`；MCP 起不来 → `exec_spawn_failed`。三条都到不了一句用户能照做的话。
5. **长路径（MAX_PATH 260）、保留文件名（`nul` / `con` / `COM1`）、8.3 短名、尾随点空格——全仓零处理、零用例。** 我没能构造出确定成立的触发路径（见"未经执行验证的声明"），所以只进检查单。
6. **P1-8 的现场证据不只是"旧"，它引用的前提已经被 T028 改掉了**（windows-08）。

---

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P1-8 载体兼容矩阵（Windows 面） | complete-with-gaps | 两载体六项探针确实在真机上跑过并全绿（`test12-reverify.md:547` bundled-node、:570 electron-utility），这是硬证据。但证据钉在提交 `8115ebe1`，到 HEAD `ebc82f16` 已隔 **158 个提交，其中 24 个动过 `src/runtime/host` / `plugins/tools` / `bootstrap.ts`**（我用 `git rev-list --count` 实测）。任务树 P1-8 行对这件事的描述本身还带着一条已被 T028 推翻的陈述（windows-08）。判 complete-with-gaps 而不是 incomplete：矩阵本身建立过，缺的是重采。 |
| P4-0 同步平台 worker（Windows 面） | complete-with-gaps | 打包 Windows 走 `spawn(resources/node-runtime/node.exe, [worker.js])` 的 bundled-node 载体，现场 trace 确认过 `carrier=bundled-node` / `node_source=bundled` / `node_exec_path` 指向安装目录（`test12-reverify.md:500`），这一条成立。缺口有三：windows-02（Windows 上 exec 的成功出口挂在一个外部 taskkill 进程上，2 秒预算，零用例）、windows-03（stdio MCP 在 Windows 上起不来）、以及**未打包 Windows 开发态没有随包 node，`workerHost` 给不出 `node`，`runPipe` 会直接 `invalid_host_config` 拒掉每一次 exec**——这条我只做静态确认，列在检查单而非发现，因为开发态是否属于验收范围要计划来定。另：名义上属于 P4-0 的 `NodeRuntimeResolver.ts` 无生产调用方，该事实由 main-host-aux 区域立项，此处只作为"上机日不必测它"的依据。 |
| P4-6 打包与现场集成验收（Windows 面） | incomplete | 三条用户可见的 Windows 行为缺陷（windows-01 安全绕过、windows-04 无 Git Bash 时 bash 工具仍被登记、windows-05 CRLF 编辑）＋两条环境相关（windows-06 写锁 PID 复用、windows-07 注册表 PATH 解码、windows-09 OEM 代码页输出）都没有任何现场结论。任务树 P4-6 验收表里 R2/R3/R4 三行在 `test12-reverify.md:583-585` 就写着"未执行"，其中 **R4 恰好就是 windows-04 要测的那件事**（"无可发现 Git Bash 时检查 `shell_unconfigured` 与应用状态"）。这个节点现在是 🟡，判 incomplete 与之一致。 |

---

## 发现

### [windows-01] high security | P4-6 | src/runtime/plugins/permissions/index.ts:490 | Git Bash 的 `/c/...` 盘符写法绕过 `~/.ssh/*` 与 `~/.aws/credentials` 的不可覆盖 deny

**DESC**
`pathPolicy` 把待判路径与策略模式都折成 `/` 分隔后做正则匹配，Windows 下正则加 `i` 标志解决大小写。这对**原生写法**（`C:\Users\JC\.ssh\id_ed25519`）是对的。但 Windows 上真正跑命令的 shell 是 Git for Windows 的 `bash.exe`（`shell.ts:100-106` 选它），在它里面文件的自然写法是 MSYS 盘符记法 `/c/Users/JC/.ssh/id_ed25519`。

这个字符串走完整条链之后仍然匹配不上 deny：`path.win32.isAbsolute('/c/...')` 返回 **true**，所以 `bash-analysis.ts:182` 认为它已经是绝对路径，直接 `normalizeShellPath` 成 `\c\Users\JC\.ssh\id_ed25519`；`canonicalPath`（`tools/paths.ts:11-19`）对它 realpath 失败后逐级回退，最终拼出 `C:\c\Users\JC\.ssh\id_ed25519`。两个形态都匹配不上 `C:/Users/JC/.ssh/.*`。

受影响的是**只能靠完整路径匹配的那几条规则**：`~/.ssh/*` 与 `~/.aws/credentials`。`*.env` / `*.pem` / `*.key` / `id_rsa*` 不受影响，因为它们展开后不含 `/`，`pathPolicy` 会走 basename 兜底（`index.ts:491`）。所以实际被放行的是 `~/.ssh/config`、`~/.ssh/known_hosts`，以及**不叫 `id_rsa` 的私钥**——`id_ed25519` 是今天的默认密钥名。

后果分档（`permissions/index.ts:259-337`）：
- `auto` 档：`evaluate` 在第 302 行 `if (gear === 'auto' && !request.unresolvedPaths) return 'allow'` 直接放行，**没有任何卡片、没有任何提示**。deny 被完全绕过。
- `accept-edits` / `ask` 档：`containsPath` 判出"在工作区外"（我实测 `relative` 返回 `\c\Users\JC\.ssh`，`isAbsolute` 为 true），降级成 `ask`。用户会看到一张卡，但卡上写的是 `\c\Users\JC\.ssh\id_ed25519` 这种看不出是私钥目录的路径——本该是**硬 deny、不给选**的东西变成了一个容易被顺手点"允许"的问题。

这是 P1-5 权限内核的缺陷，只在 Windows 上成立，所以归在本区域。它**不是** T001 修过的 permissions-19：那条是分隔符混用导致通配符展开成空集，这条是盘符记法导致 deny 规则匹配不上，两者代码位置和机制都不同。策略文件自己的承诺是「`path` 的 deny **不能**被 per-tool allow 覆盖」（`src/agent-host/permissionPolicy.mjs:45-46`），这条承诺在 Windows 上不成立。

`static_inference = true`（需要 Windows + Git Bash 才能端到端复现），但路径语义部分我在 Linux 上用 `node:path/win32` 实测了。

**EVIDENCE**

`src/runtime/plugins/permissions/index.ts:476-494`：
```ts
export function pathPolicy(path: string): PermissionAction {
  let action: PermissionAction = 'allow';
  const candidate = path.replaceAll('\\', '/');
  for (const [pattern, value] of Object.entries(
    AICLIENT_DEFAULT_PERMISSION_POLICY.permission.path
  )) {
    if (value !== 'allow' && value !== 'ask' && value !== 'deny') continue;
    const expanded = pattern.startsWith('~/')
      ? resolve(homedir(), pattern.slice(2)).replaceAll('\\', '/')
      : pattern;
    const expression = expanded
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const regex = new RegExp(`^${expression}$`, process.platform === 'win32' ? 'i' : '');
    if (regex.test(candidate) || (!expanded.includes('/') && regex.test(basename(path))))
      action = value;
  }
  return action;
}
```

`src/runtime/plugins/permissions/bash-analysis.ts:180-183`：
```ts
    function register(text: string, state: ShellState) {
      if (!text) return;
      // Keep wildcard's static parent; glob expansion is handled by the caller.
      paths.add(normalizeShellPath(isAbsolute(text) ? text : `${state.cwd}${sep}${text}`));
    }
```

`src/agent-host/permissionPolicy.mjs:45-46, 61, 65`：
```js
 * The `path` surface is cross-cutting and a `path` deny CANNOT be overridden by
 * a per-tool allow — which is what makes `cat *` safe to allow further down.
...
  '~/.ssh/*': 'deny',
...
  '~/.aws/credentials': 'deny',
```

Linux 上对 `node:path/win32` 的实测（只读，不改任何文件）：
```
$ node -e "...（见报告生成过程）..."
isAbsolute /c/Users: true
normalizeShellPath: \c\Users\JC\.ssh\id_ed25519
resolve: C:\c\Users\JC\.ssh\id_ed25519
relative: \c\Users\JC\.ssh
deny native: true
deny msys  : false
deny canon : false
```

现场证据证明模型**确实**在用这种写法（`Windows-P4-6-evidence/test12-reverify.md:728`，这是 trace 里 `tool_execution_start` 的原文）：
```
tool_start: {"event": "tool_execution_start", "tool": "bash", "args": {"command": "printf 'BASH_WINDOWS_PATH='\ncygpath -aw \"$BASH\"\nprintf 'FILE_CONTENT='\ncat /c/Users/JC/Desktop/AiClient-test12-probe/probe-a.txt\nprintf '\\n'", ...}}
```

**SCENARIO**
Windows 加密机，档位 `auto`（或用户在 `accept-edits` 下顺手点了允许）。模型调用 bash：`cat /c/Users/JC/.ssh/id_ed25519`。
- `BashAnalyzer` 产出 `\c\Users\JC\.ssh\id_ed25519`；
- `checkShellPaths` 的两次 `pathPolicy` 检查（lexical 与 canonical）都判 `allow`；
- `evaluate` 在 `auto` 档第 302 行返回 `allow`；
- Git Bash 执行 `cat /c/Users/JC/.ssh/id_ed25519`，私钥全文进入模型上下文并落进会话文件。
同一台机器上 `cat ~/.ssh/id_ed25519` 或 `cat "C:\Users\JC\.ssh\id_ed25519"` 会被 deny 拦住——**同一个文件，换一种拼法就放行**。

**FIX**
在 `bash-analysis.ts` 的 `register`（:182）里、`normalizeShellPath` 之前加一次 Windows 盘符记法归一：`^/([A-Za-z])(/|$)` → `$1:/`，并对 `//server/share` 形态做 UNC 归一。必须在 `register` 里做（而不是只在 `pathPolicy` 里），因为 `containsPath` 的工作区判定同样吃这个字符串。配套在 `shellPolicy.test.ts` 的 `describe('shell path separator folding')` 旁边加一个 `describe('msys drive notation')`，用纯函数钉住 `/c/Users/x/.ssh/id_ed25519` → `C:\Users\x\.ssh\id_ed25519`——和 T001 一样不需要 Windows 机器。顺便复核：`cygpath -u` 风格的 `/cygdrive/c/...` 要不要一起收。

---

### [windows-02] medium robustness | P4-0 | src/runtime/host/exec.ts:518 | Windows 上一条已经跑完的命令，能否成功回报取决于一个外部 taskkill 进程是否在 2 秒内退出

**DESC**
Windows 上 `runPipe` 强制走 runner 载体（:462-466 无 `nodePath` 直接拒），于是每条命令的正常结束路径是：runner 通过 IPC 发 `{type:'exit'}` → 父进程 `stop('exit')`（:642）→ `killTree(false)`（:557）→ **spawn 一个 `taskkill.exe`** 去杀 runner 这棵树。

关键在于此后谁来 `finish`：
- `child.on('close')`（:610-619）只在 `!cleaners.size` 时 `finish`，而 `cleaners` 从 `killTree` 那一刻起就非空；
- 真正调用 `finish` 的是 `killer.on('close')`（:533-538）里的 `if (childClosed) finish(cleanupError)`。

所以 **Windows 上 `runPipe` 唯一的 resolve 出口，是那个外部 `taskkill.exe` 进程跑完并退出 0**。Linux 上对应的是一次 `process.kill` 系统调用，没有这个依赖（:617 走另一分支）。

两条具体的坏路：
1. **taskkill 起不来**（`SystemRoot` 异常、EDR/HIPS 拦截 `taskkill.exe`、System32 不可达）：`killer.on('error')`（:527）把 `cleanupError` 设成 `taskkill could not start`，然后 `child.kill()`。我在本机实测过 Node 的 spawn 失败事件序列是 `error` → `close`（输出 `error,close:-2`），所以 `killer.on('close')` 仍会触发并 `finish(cleanupError)` ——**以拒绝的形式**。结果：一条命令已经跑完、stdout 已经收全，工具却抛 `exec_cleanup_failed`。这不是偶发，是**该机器上每一次 bash 调用**。
2. **taskkill 超过 2 秒**：`cleanupDeadline`（:559-570，预算是 `cleanupTimeoutMs`，产品路径固定 2000 ms，见 `host/worker.ts:44` 的 `?? 2000`，`agent-host/worker.ts:93` 不传覆盖）触发，`finish(new RuntimeHostError('exec_cleanup_failed', 'command streams did not close before cleanup deadline'))`。错误文案还是错的：流可能早就关了，没跑完的是 taskkill。

现场那台机器装着 TsdEncrypt.sys / TsdEncryptMF.sys / Sangfor aTrust / sprotect / HipsTray / DSATray（`Windows-P4-6-evidence/environment.md:28-32`），进程创建正是这类产品挂钩子的地方——2 秒预算在这种机器上不是富余。

另外注意：`runPipe` 的这份 `killTree` 是 `createTreeKiller`（:336-404）的内联副本，但**没有做 T022 在后者里做的那次修正**——`killer.on('error')` 里少一句 `cleaners.delete(killer)`（对比 :378），而且用的是 `=` 而非 `??=`（对比 :379）。因为 `close` 总会补上删除，这两处目前不构成额外故障，但它们是同一段逻辑的两份实现开始漂移的信号。`createTreeKiller` 有 5 条注入式用例，这份**一条都没有**。

`static_inference = true`：需要 Windows + 一个会拦 taskkill 或让进程创建变慢的环境才能实测。

**EVIDENCE**

`src/runtime/host/exec.ts:516-552`：
```ts
    function killTree(force: boolean): void {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (windowsKillStarted) return;
        windowsKillStarted = true;
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        cleaners.add(killer);
        killer.on('error', (error) => {
          cleanupError = new RuntimeHostError('exec_cleanup_failed', 'taskkill could not start', {
            cause: error,
          });
          child.kill();
        });
        killer.on('close', (code) => {
          cleaners.delete(killer);
          if (code !== 0)
            cleanupError ??= new RuntimeHostError('exec_cleanup_failed', `taskkill exited ${code}`);
          if (childClosed) finish(cleanupError);
        });
      } else {
```

`src/runtime/host/exec.ts:610-619`（Windows 下这里从不 `finish`）：
```ts
    child.on('close', (code, signal) => {
      childClosed = true;
      if (!reportedExit) {
        result.exitCode = code;
        result.signal = signal;
      }
      // Kill remaining members even when the leader exited normally.
      if (process.platform !== 'win32') killTree(true);
      if (!cleaners.size) finish(cleanupError);
    });
```

`src/runtime/host/exec.ts:637-643`（正常退出也走 `stop`）：
```ts
          } else {
            reportedExit = true;
            result.exitCode = message.code ?? null;
            result.signal = message.signal ?? null;
          }
          stop('exit');
```

Node spawn 失败的事件序列（本机实测，只读）：
```
$ node -e "const {spawn}=require('child_process'); const c=spawn('/definitely/not/here',['x']); ..."
error,close:-2
```

**SCENARIO**
Windows 加密机，企业 HIPS 对 `C:\Windows\System32\taskkill.exe` 的调用做同步检查（或直接拦截）。用户让模型跑 `bash: git status`。命令 0.2 秒跑完、stdout 收全、runner 发出 IPC exit，父进程 spawn taskkill——taskkill 被 HIPS 卡住 3 秒或直接失败。2 秒到点，`cleanupDeadline` 触发，`runPipe` reject。bash 工具把 `exec_cleanup_failed` 当成工具错误抛给模型，模型看到的是"命令失败"，用户看到的是一条永远失败的 bash——而命令其实次次都成功。

**FIX**
两件事分开做：
1. **把成功与清理解耦**。Windows 分支下，`child.on('close')` 且 `reportedExit` 为真时就应该 resolve 结果；taskkill 的失败改为**记进结果的诊断字段**（或一条 trace 行），而不是把整个 `run` 变成 reject。命令已经退出、输出已经完整，这两件事和"收尸干不干净"是两回事。
2. **把 `runPipe` 的内联 `killTree` 换成 `createTreeKiller`**，消掉重复实现，顺带把已有的 5 条注入式用例覆盖到这条路上；再补两条：taskkill 起不来 / taskkill 超时，断言结果仍然 resolve 且诊断里有清理失败。
另外建议把 `cleanupTimeoutMs` 在 Windows 上放宽（或从 2000 改为可配），并把 `command streams did not close before cleanup deadline` 的文案按实际卡住的对象分开写。

---

### [windows-03] medium windows | P4-0 | src/runtime/plugins/mcp/index.ts:211 | stdio 型 MCP 服务器在 Windows 上起不来：`npx` / `uvx` / `npm` 都是 `.cmd`，而链路上两次 spawn 都是 `shell: false`

**DESC**
MCP 配置里的 `command` 原样交给 `exec.spawn`（`mcp/index.ts:210-212`），`config.ts:213` 只做了一次 `.trim()`，没有任何 Windows 形态处理。`exec.spawn` → `spawnPersistent`（`exec.ts:152-174`）在 Windows 上强制走 runner，runner（`exec-runner.mjs:10-16`）再 `spawn(request.command, request.args, { shell: false })`。

Windows 上 `CreateProcess` 只会给无扩展名的可执行名补 `.exe`，**不查 `PATHEXT`**。而 MCP 生态里最标准的配置写法是：
```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "..."] }
```
Windows 上 npm 装出来的是 `npx.cmd` / `npx.ps1` / `npx`（sh 脚本），**没有 `npx.exe`**。所以 bare `npx` → ENOENT。

用户若改写成绝对路径 `C:\Program Files\nodejs\npx.cmd`，也过不去：Node 自 18.20.2 / 20.12.2 的 CVE-2024-27980 修复之后，`spawn` 一个 `.bat` / `.cmd` 而不给 `shell: true` 会直接抛错。runner 的 `try/catch`（:19-24）会把它转成 `{type:'spawn-error'}`，父进程报 `exec_spawn_failed: could not start C:\...\npx.cmd`——至少可诊断，但服务器仍然起不来。

顺带：`exec.ts:86` 的入参校验（`!isAbsolute && /[/\\]/.test()`）对 bare `npx` 是放行的，所以问题不会在这一层被拦住报错，而是一路走到 spawn 才 ENOENT。

同一条链路上 bash 工具不受影响，因为它传的是 `resolveWorkerShell` 解析出的 `bash.exe` 绝对路径。

`static_inference = true`：CreateProcess 不查 PATHEXT、Node 拒绝无 shell 的 `.cmd` 都是平台 / 运行时的既定行为，但本仓没有任何 Windows 执行证据，也没有 `.cmd` 相关用例。

**EVIDENCE**

`src/runtime/plugins/mcp/index.ts:210-213`：
```ts
    const child = await exec.spawn({
      command: server.command,
      args: server.args,
      cwd: config.cwd ?? process.cwd(),
```

`src/runtime/plugins/mcp/config.ts:211-214`（唯一的加工只有 trim）：
```ts
        command: entry.command.trim(),
```

`src/runtime/host/exec-runner.mjs:10-16`：
```js
    const command = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
```

`src/runtime/host/exec.ts:162-174`（父侧同样 `shell: false`）：
```ts
    const child = spawn(
      nodePath ?? request.command,
      nodePath ? [execRunnerPath()] : [...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        shell: false,
```

**SCENARIO**
Windows 用户按 MCP 官方 README 配 `{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]}`。会话启动 → `connectOne` → `exec.spawn('npx', …)` → runner `spawn('npx', …, {shell:false})` → CreateProcess 找 `npx.exe` 找不到 → ENOENT → runner 发 `spawn-error` → `exec_spawn_failed: could not start npx`。该 MCP 服务器的工具在整个会话里都不存在，用户在 Linux / macOS 上用同一份配置是好的。

**FIX**
在 runner（或 `spawnPersistent` 组装参数处）加一层 Windows 可执行解析：给无扩展名的 bare 命令按 `PATHEXT` 顺序（`.COM;.EXE;.BAT;.CMD`）在 `PATH` 里查一遍；命中 `.cmd` / `.bat` 时改用 `cmd.exe /d /s /c "<quoted>"` 显式包装（不要开 `shell: true`，那会把 args 重新按 shell 规则解析，引号语义不可控）。配套在 `mcp.test.ts` 加一条 Windows 形态用例（用注入的 spawn 替身，不需要真机），并在 MCP 配置校验里对 Windows 给一条明确诊断而不是裸 ENOENT。

---

### [windows-04] medium contract-gap | P4-6 | src/runtime/plugins/tools/index.ts:413 | Windows 上没装 Git for Windows 时，`bash` 工具照样登记给模型，每次调用返回一句指责宿主的英文错误

**DESC**
`ToolsPlugin.install()` 无条件注册 `bash`（:413），只有在 `execute` 内部才检查 `this.config.shellPath`（:449-453），没有配就抛 `shell_unconfigured: host must configure the shell executable`。而 `shellPath` 来自 `resolveWorkerShell(this.options.host.childEnv)`（`nativeWorkerRuntime.ts:197`），它在 Windows 上只找 Git for Windows 的 `bash.exe`（`shell.ts:100-119`），找不到就返回 `undefined`。

这和同一个文件里 `ask` / `browser_preview` 的登记规则**直接矛盾**。那两个工具的注释写得很清楚（:62-66、:68-72）：宿主没有展示面就干脆不注册，理由是"一个永远回答'没人在听'的工具还被登记着，模型会一直调它"。`bash` 是同一种情况，却走了相反的做法。

后果不只是浪费：`bash` 在 Windows 上是模型最常用的工具，它会反复调、反复失败，占满上下文。而错误文案 `host must configure the shell executable` 是**说给宿主开发者听的英文**，用户既不知道该装什么，也没有任何入口去装——现场 `environment.md:24` 明确记录了安装包里"未发现 resources/git/ 或 git/bin/bash.exe"，也就是说这个产品**不随包带 Git**，完全依赖用户机器上已有的 Git for Windows。

全仓对 `shell_unconfigured` 零消费者（`grep -rn 'shell_unconfigured' src/` 只有抛出点本身），所以没有任何一层把它翻译成用户能照做的话。

这正是 `test12-reverify.md:585` 里编号 R4 的验收项——"无可发现 Git Bash 时检查 `shell_unconfigured` 与应用状态"——状态是"未执行"。

`static_inference = true`：需要一台没装 Git for Windows 的 Windows 才能看到真实表现。

**EVIDENCE**

`src/runtime/plugins/tools/index.ts:413`（无条件注册）与 `:449-453`：
```ts
    this.register({
      name: 'bash',
      label: 'Bash',
```
```ts
        if (!this.config.shellPath)
          throw new RuntimeHostError(
            'shell_unconfigured',
            'host must configure the shell executable'
          );
```

同文件 `:62-66` 与 `:68-72`（相反的登记规则，写在注释里）：
```ts
   * F5 — how the model reaches the user with a question. Absent registers no
   * `ask` tool at all, which is the honest state for a host with nowhere to
   * show one: a tool that always answers "nobody is listening" would still be
   * advertised, and the model would keep calling it.
   */
  ask?: AskUser;
```

`src/runtime/host/shell.ts:96-121`（Windows 上只找 Git bash，找不到返回 undefined）：
```ts
): string | undefined {
  const windows = platform === 'win32';
  ...
  return candidates.find(exists);
}
```

现场事实，`Windows-P4-6-evidence/environment.md:24`：
```
未发现 resources/git/ 或 git/bin/bash.exe
```

**SCENARIO**
一台干净的 Windows 11，装了本产品但没装 Git for Windows。用户开一个会话说"跑一下测试"。模型看到工具列表里有 `bash`，调用它 → `shell_unconfigured: host must configure the shell executable` → 模型换个写法再调 → 同样的错 → 反复三五次后放弃，告诉用户"我无法执行命令"。用户拿不到任何"请安装 Git for Windows"的提示。

**FIX**
按本文件自己的规则办：`shellPath` 为空时**不注册** `bash`（和 `ask` / `browser_preview` 一样），让模型能看见自己没有这个能力。同时在 Main 侧做一次启动预检——`resolveWorkerShell` 返回 undefined 时，通过已有的宿主状态横幅给一条可操作的中文提示（"未找到 Git for Windows 的 bash.exe，命令执行功能不可用，请安装 Git for Windows 或在设置中指定 bash 路径"），并把它纳入 `noHardcodedChinese` 守卫已扩到的范围（T023 已经把守卫扩到 runtime / agent-host）。上机日按 R4 取证。

---

### [windows-05] medium correctness | P4-6 | src/runtime/plugins/tools/index.ts:384 | `edit` 对 CRLF 文件做逐字节精确匹配，匹配不上时的错误不提行尾，模型会退回整文件 `write` 从而把全文行尾改成 LF

**DESC**
`edit` 用 `content.indexOf(edit.oldText)` 做精确匹配（:384），全链路没有任何行尾归一。`read` 保留了 `\r`（`read-lines.ts` 按 `'\n'` 切行、切片含 `\r`），所以严格逐字复制 read 输出的模型能匹配上；但模型普遍会把多行文本归一成 `\n` 再发回来。一旦归一，跨行的 `oldText` 在 CRLF 文件上**必然**匹配不上。

失败后模型拿到的是 `edit_not_unique: oldText must match exactly once; file was not changed`——这句话把模型推向"我引的上下文不唯一"，而真正的原因是行尾。没有任何线索指向 CRLF。模型的标准应对是**改用 `write` 重写整个文件**，而 `write`（:337-359）同样不做行尾处理，直接 `Buffer.from(args.content)` 落盘。结果是一次本该三行的改动变成**整个文件行尾从 CRLF 变成 LF**，在 git 里表现为全文件 diff。

Git for Windows 默认安装选项就是 `core.autocrlf=true`（检出即 CRLF），所以这在 Windows 工作区是常态而不是边角。现场证据也对得上：`test12-reverify.md:748` 记录探针文件是"57 字节 UTF-8 文本（**含 CRLF 和中文**）"。

对照：`grep` 已经为 CRLF 修过（tools-17，`index.ts:630` 用 `split(/\r?\n/)`）。`edit` / `write` 没有跟上。

`static_inference = true`：需要在 Windows CRLF 工作区跑一次真实模型回合才能确认模型的实际退化行为（尤其是"退回 write"这一步）。行尾不做归一、错误文案不提行尾，这两点是确定的代码事实。

**EVIDENCE**

`src/runtime/plugins/tools/index.ts:380-390`：
```ts
          for (const edit of args.edits) {
            const start = content.indexOf(edit.oldText);
            if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0)
              throw new RuntimeHostError(
                'edit_not_unique',
                'oldText must match exactly once; file was not changed'
              );
            content =
              content.slice(0, start) + edit.newText + content.slice(start + edit.oldText.length);
```

同文件 `:350`（`write` 原样落盘）：
```ts
          await io.writeFile(target, Buffer.from(args.content));
```

对照 `:628-630`（grep 已经处理过 CRLF）：
```ts
          // carries the stray byte (tools-17).
          const lines = Buffer.from(data.bytes).toString('utf8').split(/\r?\n/);
```

现场事实，`Windows-P4-6-evidence/test12-reverify.md:748`：
```
本次 Python、PowerShell 与 Node 读取均得到 57 字节 UTF-8 文本（含 CRLF 和中文）
```

**SCENARIO**
Windows 工作区，`core.autocrlf=true` 检出的仓库，`src/app.ts` 是 CRLF。用户说"把这个函数的 timeout 从 30 改成 60"。模型 `read` 到内容（含 `\r`），按习惯归一成 `\n` 后发 `edit` → `edit_not_unique` → 再试一次仍失败 → 改用 `write` 重写整个文件（LF）→ 成功。用户回到 IDE，`git diff` 显示整个文件每一行都变了。

**FIX**
在 `edit` 里做行尾感知：读到 `before` 后探测主导行尾（含 `\r\n` 的比例），匹配前把 `oldText` / `newText` 与文件内容在同一行尾空间里比较，写回时把 `newText` 折成文件原来的行尾。`write` 同理——目标文件已存在且原本是 CRLF 时，把模型给的 LF 内容折成 CRLF（新建文件保持 LF）。另外把 `edit_not_unique` 拆成两条错误码：真的多处命中 vs **归一后能命中但原文不能**，后者的文案直接说"该文件使用 CRLF 行尾"。测试可以在 Linux 上写：造一个 `\r\n` fixture，断言 LF 形式的 `oldText` 能命中且写回后仍是 CRLF。

---

### [windows-06] medium robustness | P4-6 | src/runtime/plugins/session/writerLock.ts:128 | 会话写锁只靠 PID 存活判定陈旧，Windows 的 PID 复用会把一把死锁永久锁死；记了 `acquiredAt` 却从没人读

**DESC**
`stale()` 判定一把锁能不能接管，唯一依据是 `processAlive(owner.pid)`（:128），而 `processAlive` 就是 `process.kill(pid, 0)`（:65-73）。这个设计在 Linux 上基本够用——PID 空间大、回绕慢。Windows 不一样：PID 是 4 的倍数、从一个不大的池子里分配、进程退出后**立刻**可被复用。一台开着浏览器和 IDE 的 Windows 机器，PID 在几分钟内就可能转一圈。

后果：worker 崩溃/强杀留下 sidecar 锁 → 用户重开会话 → `readLock` 读到 owner.pid → 该 PID 已经被某个无关进程占用 → `processAlive` 返回 true → `stale` 返回 false → 抛 `session_locked: session already has a writer: <file> (pid 1234 on HOSTNAME)`。用户只能手工去删 `.writer.lock` 或重启机器。模块自己的开场注释说"一把只测存在性的锁会永远拒绝这个会话"，它用 PID 校验来避免这件事——但在 Windows 上 PID 校验本身就是不可靠的那一环。

更直接的证据是：这条记录里**已经有一个可以做年龄兜底的字段，但没人读它**。`WriterLockOwner.acquiredAt`（:30）由 `acquireWriterLock` 写入（:201），由 `parseOwner` 解析（:89），然后全仓再无第二个读取点——`grep -n acquiredAt src/runtime/plugins/session/writerLock.ts` 只有这三处。也就是说"这把锁是 3 天前留下的"这个信息采集了、落盘了、解析了，却没有参与任何判定。

`static_inference = true`：PID 复用速率和实际撞上的概率要在 Windows 上观察；`acquiredAt` 无读取方是确定的代码事实。

**EVIDENCE**

`src/runtime/plugins/session/writerLock.ts:124-129`：
```ts
function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}
```

同文件 `:65-73`：
```ts
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}
```

同文件 `:26-31`、`:196-203`、`:89`（写入、解析，然后没有读取方）：
```ts
  /** Absent in locks written before this field existed. */
  host?: string;
  token: string;
  acquiredAt?: number;
```
```ts
  const claim = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: Date.now(),
    } satisfies WriterLockOwner)
  );
```

**SCENARIO**
Windows 上 AiClient 被任务管理器强杀（或加密驱动导致的崩溃，现场 `environment.md` 记录过 pnpm worker 被安全软件搞崩）。会话 A 的 `<file>.writer.lock` 留在盘上，记录 `pid: 15236`。用户重开应用、点开会话 A。此时 15236 已经被 Chrome 的一个渲染进程占用。`processAlive(15236)` → true → `stale` → false → `session_locked (pid 15236 on DESKTOP-XXX)`。会话 A 在这台机器上**再也打不开**，直到那个 Chrome 进程退出或用户自己找到并删掉 `.writer.lock`（而这个文件的存在对用户不可见）。

**FIX**
在 `stale()` 里把 `acquiredAt` 用起来，作为 PID 判定之外的第二条件：
```ts
const AGE_LIMIT_MS = 24 * 60 * 60 * 1000;
if (owner.acquiredAt !== undefined && Date.now() - owner.acquiredAt > AGE_LIMIT_MS) return true;
```
更严格的做法是把进程启动时间一起记进 sidecar（Windows 上可由 `wmic` / `Get-Process` 取，或退一步用 `process.uptime()` 换算出的近似启动时刻），接管前比对 pid + 启动时刻，这样 PID 复用就不再构成误判。另外给 `session_locked` 的用户可见文案加一个"强制接管"的出口，至少让用户不必去文件系统里找一个隐藏 sidecar。测试可以在 Linux 上写：伪造一份 `acquiredAt` 很旧、pid 指向当前进程的锁，断言可接管。

---

### [windows-07] medium windows | P4-6 | src/main/services/terminal/PtyManager.ts:126 | 用 `encoding: 'utf8'` 读 `reg query` 的输出，中文 Windows 上会把含非 ASCII 的 PATH 条目解码坏

**DESC**
`getWindowsRegistryPath()` 用 `execSync('reg query ... /v Path 2>nul', { encoding: 'utf8' })` 读注册表里的用户级与系统级 PATH，然后正则取值、拼起来当作终端的 PATH。

`reg.exe` 通过管道输出时用的是**控制台输出代码页**（中文 Windows 默认 936/GBK），不是 UTF-8。用 `encoding: 'utf8'` 解码 GBK 字节，所有非 ASCII 字符会变成 U+FFFD。纯 ASCII 的 PATH 条目不受影响，但只要用户名或安装目录带中文（`C:\Users\张三\AppData\Local\Programs\...`，中文 Windows 上非常常见），那一条 PATH 项就被解码坏，终端里对应的工具从此"找不到"。

同一台现场机器上这类问题已经出现过一次：`test12-reverify.md:278` 记录"初次读取遇到控制台 cp1252 无法输出中文的 UnicodeEncodeError；设置 PYTHONIOENCODING=utf-8 后成功重读"。方向相反，但说明的是同一件事——这台机器的控制台不是 UTF-8。

另外结果被 `cachedWindowsPath` 缓存，坏掉的 PATH 在整个进程生命周期里都不会重算。

`static_inference = true`：需要一台中文 Windows、且 PATH 里有带中文的条目才能实测。

**EVIDENCE**

`src/main/services/terminal/PtyManager.ts:122-147`：
```ts
    let userPath = '';
    try {
      const userOutput = execSync('reg query "HKCU\\Environment" /v Path 2>nul', {
        encoding: 'utf8',
        timeout: 3000,
      });
      const userMatch = userOutput.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      userPath = userMatch ? userMatch[1].trim() : '';
    } catch {
      // User PATH might not exist
    }
```

现场事实，`Windows-P4-6-evidence/test12-reverify.md:278`：
```
初次读取遇到控制台 cp1252 无法输出中文的 UnicodeEncodeError；设置该命令进程的 PYTHONIOENCODING=utf-8 后成功重读
```

**SCENARIO**
中文 Windows，用户名 `张三`，用 scoop 装了工具链，用户级 PATH 里有 `C:\Users\张三\scoop\shims`。应用启动 → `getEnhancedPath()` → `getWindowsRegistryPath()` → GBK 字节按 UTF-8 解码 → 该条目变成 `C:\Users\??\scoop\shims` → 内嵌终端里 `rg` / `fd` 之类通过 shim 提供的命令全部 "command not found"，而同一台机器上用系统 PowerShell 是好的。

**FIX**
两条路选一条：
1. **不解码**：`execSync(..., { encoding: 'buffer' })` 拿到字节后，先 `chcp` 查出控制台代码页再按它解码（或直接在命令前加 `chcp 65001 >nul &&` 强制 UTF-8 输出）。
2. **不走 reg.exe**：改用 PowerShell 的 `[Environment]::GetEnvironmentVariable('Path','User')`，并给子进程加 `-OutputEncoding utf8` / 设 `[Console]::OutputEncoding`。
配套加一条单元用例：喂一段 GBK 编码的 `reg query` 样本字节，断言解析出的路径与原文逐字节相等。

---

### [windows-09] medium i18n | P4-6 | src/runtime/plugins/tools/index.ts:474 | bash 工具把子进程输出一律按 UTF-8 解码，Windows 原生工具的 OEM 代码页输出会变成一串替换字符进模型上下文

**DESC**
bash 工具把 stdout / stderr 直接 `Buffer.from(output.stdout).toString('utf8')`（:474-475）。`Buffer#toString('utf8')` 是**有损**的：非法字节序列静默变成 U+FFFD，不抛错、不提示。

Windows 上这不是理论问题。默认 shell 是 Git Bash（MSYS），MSYS 自带的工具（`cat`、`ls`、`grep`）输出 UTF-8，没问题；但模型经常会在 bash 里调 Windows 原生程序——`cmd /c dir`、`python`、`java`、`dotnet`、各种 `.exe` 构建工具。这些程序写管道时用的是 ANSI/OEM 代码页（中文 Windows 上是 936/GBK）。于是任何中文文件名、中文报错、中文日志都会变成 `???` 或 `\uFFFD` 串进模型上下文和会话文件。

模型看到的是乱码，既不知道原文是什么，也不知道"这是编码问题"——它会把乱码当成程序的真实输出去推理。

对照：`read` 工具在这件事上做对了——`decodeFileText` 用 `fatal: true` 的 `TextDecoder`，非 UTF-8 会抛 `io_not_utf8` 并明确告诉模型"这可能是二进制文件"（`read-lines.ts:27-41`，tools-12 修过）。bash 的输出路径没有同等待遇。

`static_inference = true`：需要中文 Windows 跑一次带中文输出的原生命令才能确认。"toString('utf8') 有损且无检测"是确定的代码事实。

**EVIDENCE**

`src/runtime/plugins/tools/index.ts:472-476`：
```ts
        return result(
          `${Buffer.from(output.stdout).toString('utf8')}${output.stderr.length ? `\n[stderr]\n${Buffer.from(output.stderr).toString('utf8')}` : ''}`,
```

对照 `src/runtime/plugins/tools/read-lines.ts:27-41`（read 做了检测并给出可诊断错误）：
```ts
export function decodeFileText(
  decoder: TextDecoder,
  bytes: Uint8Array,
  stream: boolean,
  path: string
): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new RuntimeHostError(
      'io_not_utf8',
      `${path} is not valid UTF-8 text; it is probably a binary file`
    );
  }
}
```

**SCENARIO**
中文 Windows，工作区里有一个中文命名的目录。模型调 `bash: cmd /c dir`。`cmd.exe` 用 CP936 写出中文文件名，管道字节按 UTF-8 解码 → 目录列表里的中文全变成 U+FFFD。模型据此判断"这些文件名是乱码/损坏"，或者在后续命令里原样引用乱码文件名，命令再次失败。用户看到的是模型在一个明明正常的目录里反复出错。

**FIX**
在 bash 结果编码这一步加一次可检测的解码：先用 `fatal: true` 的 `TextDecoder('utf-8')` 试；失败时不要直接降级成有损解码，而是（a）在结果尾巴的状态行里加一条 `; output was not valid UTF-8`，让模型知道发生了什么；（b）Windows 上可选地按 `chcp` 查出的控制台代码页做二次解码（Node 内置 `TextDecoder` 支持 `gbk` 等标签，需确认 `--with-intl=full-icu`，本仓随包 Node 是官方发行版，默认 full-icu）。至少 (a) 必须做，它不需要任何平台知识。另外建议 bash 工具描述里提示模型在 Windows 上优先用 MSYS 工具。

---

### [windows-08] low docs | P1-8 | docs/plantree/plans/runtime-evolution/README.md:73 | P1-8 行仍断言 `RUNTIME_CONFIG_VERSION` 冻结在 `runtime_p3_complete_v1`，而 T028 已把它解冻

**DESC**
任务树 P1-8 行是 T027 为 core-host-18 补的"证据陈旧"标注，里面有一句：「`RUNTIME_CONFIG_VERSION` 仍冻结在 `runtime_p3_complete_v1`，新旧 stamp 无法据此区分陈旧程度」。

这句话在写的时候是对的，但 T028（`a11ccbe0`）已经把常量解冻为 `runtime_p6_hardening_v1`（代码在 `src/runtime/bootstrap.ts:132`）。加固计划的审计 README 第五节 P1-8 行**已经**同步了这件事（"RUNTIME_CONFIG_VERSION 已在 T028（`a11ccbe0`）解冻为 runtime_p6_hardening_v1，新旧证据今后可按版本戳分代"），任务树这一行没有。

后果是实际的：上机日重采 P1-8 证据时，"能不能用版本戳区分新旧 stamp"直接决定要不要手工比对提交号。按任务树的说法是不能，按代码是能。同一份计划体系里两处互相矛盾。

另外这一行还说"到本次复核的 HEAD（`559c9790`）已隔 150 个提交，其中 21 个动过 …"，而到 HEAD `ebc82f16` 我实测是 **158 个提交、其中 24 个**动过那三处路径。这部分是快照性质的陈述，不算错误，但重采时应该按当前数字重新写。

**EVIDENCE**

`docs/plantree/plans/runtime-evolution/README.md:73`：
```
| P1-8 | 载体兼容矩阵 | ✅ 核心矩阵：… **现场证据已过期未重跑**：test12-reverify.md 的 stamp 停在提交 `8115ebe1`，到本次复核的 HEAD（`559c9790`）已隔 150 个提交，其中 21 个动过 `src/runtime/host`、`plugins/tools` 或 `bootstrap.ts`；`RUNTIME_CONFIG_VERSION` 仍冻结在 `runtime_p3_complete_v1`，新旧 stamp 无法据此区分陈旧程度，六项探针尚未在当前代码上复跑（审计 core-host-18，T027 标注实况） |
```

`src/runtime/bootstrap.ts:132`（当前实况）：
```ts
export const RUNTIME_CONFIG_VERSION = 'runtime_p6_hardening_v1';
```

本机实测（只读）：
```
$ git rev-list --count 8115ebe1..HEAD                                             → 158
$ git rev-list --count 8115ebe1..HEAD -- src/runtime/host src/runtime/plugins/tools src/runtime/bootstrap.ts → 24
```

**SCENARIO**
批次 E 上机日，执行人按任务树 P1-8 行准备重采计划，读到"版本戳无法区分陈旧程度"，于是放弃用 `stamp.config_version` 做新旧判据，改为人工核对 `git_commit`——多花时间，且在只有安装包没有源码的机器上根本核不了提交号。而实际上新采的 stamp 会带 `runtime_p6_hardening_v1`，一眼就能和旧的 `runtime_p3_complete_v1` 分开。

**FIX**
把 P1-8 行里 `RUNTIME_CONFIG_VERSION` 那半句改写为：「`RUNTIME_CONFIG_VERSION` 已由 T028（`a11ccbe0`）解冻至 `runtime_p6_hardening_v1`，重采后的 stamp 可据此与旧证据分代」。同时把"150 个提交 / 21 个"更新为按当前 HEAD 实测的"158 / 24"，或者改成不带具体数字的表述（"证据钉在 `8115ebe1`，重采前先跑一次 `git rev-list --count 8115ebe1..HEAD -- src/runtime/host src/runtime/plugins/tools src/runtime/bootstrap.ts` 确认差距"），免得下次又过期。

---

## 测试缺口

1. **`runPipe` 的 Windows `killTree`（`exec.ts:516-552`）零用例。** `createTreeKiller` 有 5 条注入式用例（`host.test.ts:752-810`），但 bash 工具实际走的是 `runPipe` 里那份内联副本，它硬编码 `process.platform` 且没有 spawn 注入点，无法在 Linux 上覆盖。"Windows 上只有 taskkill 的 close 才能 resolve"这条关键性质没有任何断言守着。
2. **没有一条 Windows 路径形态的端到端用例。** `shellPolicy.test.ts:459-476` 用纯函数钉住了分隔符折叠（T001），这是对的做法，但只覆盖了分隔符。MSYS 盘符记法（windows-01）、UNC 路径、盘符根、8.3 短名、保留文件名一律没有。
3. **`pathPolicy` 全仓零直接用例**（`grep -rn pathPolicy src/runtime/__tests__/` 无命中）。它是唯一执行 deny 规则的函数，且内部有一个平台分支（`process.platform === 'win32' ? 'i' : ''`），却只被间接覆盖。
4. **`edit` / `write` 没有 CRLF 用例。** `tools.test.ts:599` 只为 `grep` 加了一条（tools-17）。
5. **MCP 没有 Windows 可执行形态用例**：`.cmd` 启动器、bare 名字 + PATHEXT、带空格的路径，一条都没有；`mcp-echo-server.mjs` 这个 fixture 走的是绝对 node 路径。
6. **`writerLock` 没有 `acquiredAt` 相关用例**，因为没有读取方可测——这本身就是 windows-06 的症状。
7. **`getWindowsRegistryPath` 零用例**（`PtyManager.ts` 的 `__tests__` 里没有对应 describe），包括编码与正则解析两部分。
8. **长路径（>260）、保留文件名、尾随点空格：零用例、零处理。**

---

## 未经执行验证的声明

以下是我**怀疑但没能构造出确定触发路径**的，不立为发现，留给批次 E 判断：

1. **Windows 长路径（MAX_PATH 260）**。全仓没有 `\\?\` 前缀处理，也没有 `longPathAware` 相关配置或说明。工作区嵌套深时 `walk` / `glob` / `write` 是否失败，取决于随包 node.exe 与 Electron 的清单是否声明了 long-path aware、以及机器上的注册表开关 —— 我无法从代码确定，也不该猜。
2. **保留设备名（`nul` / `con` / `COM1`）与尾随点/空格的文件名**。理论上 `write` 到 `<workspace>\nul` 会被 Windows 重定向到空设备、工具报"已写入 N 字节"而文件不存在，但我无法确认 `canonicalPath` 里的 `realpath` 对设备名返回什么，也无法确认 `path_changed` 的二次校验是否会先拦住它。
3. **`taskkill /T` 与 PID 复用的误杀**。`/T` 按 ParentProcessId 枚举子孙，而 Windows 不清理已退出父进程的 PPID 字段。理论上存在杀错无关进程的可能，但目标 PID（runner）在调用时确定存活，误杀只可能发生在子孙枚举层，概率与机器负载相关，无法静态判定。
4. **`walk()` 的 `canonical !== path` 严格字符串比较在 Windows 上的表现**（`tools/index.ts:768`）。理论上映射网络盘（`Z:` → realpath 返回 UNC）、Dev Drive、junction 会让每个条目都判不等从而**整棵树静默返回空**。但我核实了 `root` 来自 `target()` → `canonicalPath()` → `realpath`，链条上每一级目录入栈前都已通过同一比较，所以形态是自洽的；除非 realpath 在某一级返回了不同前缀。需要真机上在映射盘工作区里跑一次 `glob **/*.ts` 才能定论。
5. **非打包 Windows 开发态 exec 全线不可用**。`workerHost` 在 `electron-utility` 载体下只有 `resources/node-runtime/node.exe` 存在时才给出 `node`（`host/worker.ts:72-74`），而 `runPipe` 在 Windows 上无 `node` 就直接 `invalid_host_config`（`exec.ts:462-466`）。推断是：Windows 上 `pnpm dev` 起的应用，每一次 bash / MCP / TSD 都会被拒。但打包 Windows 走的是 `PiWorkerProcess.ts:79-92` 的 bundled-node 分支，不受影响，所以这条是否算缺陷取决于"Windows 开发态是否在支持范围内"——这是计划问题不是代码问题。
6. **Git Bash 收到 Windows 形态的 `HOME`**（`tools/index.ts:458` 传 `homedir()` = `C:\Users\JC`，且 bash 以 `--noprofile --norc` 启动，不会被 `/etc/profile` 覆盖）。MSYS 对 `HOME=C:\Users\JC` 的容忍度、`~` 展开结果里混合分隔符能否被 MSYS 工具接受，我只能推测能用（现场 R1/R2 成功说明基本路径可用），不能确认全部情形。
7. **内嵌终端的控制台代码页**。我原本怀疑中文 Windows 上 cmd/PowerShell 输出会在 xterm.js 里乱码（全仓无 `chcp` / `65001`），但 node-pty 在 Windows 上走 ConPTY，ConPTY 从 UTF-16 控制台缓冲区产出 UTF-8 VT 流，很可能已经消解了这个问题。无法静态定论，只留检查单。
8. **`NodeRuntimeResolver.ts` 的 Windows 发现分支（nvm4w / volta / fnm）是否正确**。我读了，Windows 布局看起来是对的（nvm4w 的 `node.exe` 确实在版本目录根下，volta / fnm 的 Windows 布局也对；POSIX 分支反而可疑——`~/.nvm` 下直接列版本目录、`node` 不在 `bin/` 下）。但这个模块在产品里零调用方（该事实由 main-host-aux 区域立项），所以**正确与否都不影响产品**，我不为它立发现，也建议上机日不要花时间测它。

---

## 上机检查单（批次 E，目标环境均为 windows / 加密机）

> 设计原则：一次上机跑完。前六项是**取证性**的（不需要模型回合，用现成探针或一条命令就能定论），放在最前面先跑完；后面几项需要真实模型回合，成本高，排在后面。

| # | 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|---|
| W1 | P1-8 六项探针在当前 HEAD 上重采（bundled-node 载体） | `passed:true` 且 `assertions` 六项全 true；`stamp.config_version` 为 `runtime_p6_hardening_v1`（旧证据是 `runtime_p3_complete_v1`，据此确认是新采） | 在 Windows 上拉到当前 HEAD，`src/runtime` 跑 `npm ci`，按 `test12-reverify.md:541` 的原命令用安装目录随包 node.exe 执行 `src/runtime/smoke/p1-bundled-node.ts`，保存完整 JSON | windows |
| W2 | P1-8 六项探针重采（electron-utility 载体） | 同上，且 `stamp.carrier` 为 `electron-utility` | 按 `test12-reverify.md:562` 的 `electron-carrier.cjs` 原命令重跑，保存 stdout/stderr | windows |
| W3 | **windows-01** MSYS 盘符记法是否绕过 `~/.ssh/*` deny | 三种拼法在**同一档位**下的判定必须一致：`cat ~/.ssh/id_ed25519`、`cat "C:\Users\<user>\.ssh\id_ed25519"`、`cat /c/Users/<user>/.ssh/id_ed25519`。若第三种被放行（auto 档无卡片 / 其他档降级成普通 ask 卡）即为复现 | 建一个假的 `~/.ssh/id_ed25519`（内容是哨兵串）；`auto` 档下依次让模型跑三条命令，记录是否弹卡、是否返回文件内容；同时看 trace 的 `permission` 审计行 | 真实模型回合 + windows |
| W4 | **windows-02** taskkill 缺失/变慢时 bash 是否仍能成功回报 | 一条 `echo hello` 必须返回 `hello` 且 `exit=0`；不得出现 `exec_cleanup_failed` | 两种造法任选：(a) 用 AppLocker / EDR 策略临时拦 `taskkill.exe`；(b) 在 worker 环境里把 `SystemRoot` 指到一个不存在的目录后起会话。跑一条 bash，抓 trace 里的 `tool_execution_*` 与错误码 | windows |
| W5 | **windows-02** 正常路径下每条 bash 的 taskkill 耗时 | 从 runner 发出 IPC exit 到 `runPipe` resolve 的间隔；持续超过 1000 ms 即说明 2000 ms 预算不安全 | 加密机上连跑 20 条短命令（`echo`），从 trace 的时间戳取 `tool_execution_start` → `tool_execution_end` 差值分布；同时用 Process Monitor 看 `taskkill.exe` 的创建耗时 | 加密机 |
| W6 | **windows-04** 无 Git for Windows 时的表现（旧树 R4，一直未执行） | 期望：`bash` 工具不出现在工具列表里，且应用给出一条可操作的中文提示。当前实现预期会失败——记录实际文案原文 | 临时把 `C:\Program Files\Git` 改名（或在一台没装 Git 的 Windows 上装包），起会话让模型执行一条命令，截图 + 抓 trace | windows |
| W7 | **windows-03** stdio MCP 在 Windows 上能否起来 | 配 `{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}`，期望服务器连上且工具出现在列表里 | 写进 MCP 配置，起会话，看 `mcp_status` / 侧栏徽标与 worker stderr 日志；再用绝对 `npx.cmd` 路径试一次，记录两次的错误原文 | windows |
| W8 | **windows-05** CRLF 工作区的 edit 行为 | 对一个 CRLF 文件做一次三行内的 edit：期望成功且文件行尾仍是 CRLF。失败形态记录两件事——错误码原文、模型是否退回整文件 write | `git -c core.autocrlf=true clone` 一个小仓，确认文件是 CRLF（`file` 或 `xxd | head`），让模型改一处；改完 `git diff --stat` 看是不是全文件 | 真实模型回合 + windows |
| W9 | **windows-06** 写锁在 PID 复用下的表现 | 伪造一份 `<session>.jsonl.writer.lock`，`pid` 填一个当前存活的无关进程（如资源管理器）、`host` 填本机名，打开该会话：期望能打开（或至少给用户一个接管出口）；若报 `session_locked` 即复现 | 只读会话目录里造 sidecar（记得先备份），点开会话截图；测完删除 sidecar | windows |
| W10 | **windows-07** 注册表 PATH 解码 | 在用户级 PATH 里加一个带中文的目录（如 `C:\Users\<中文名>\bin`），起应用，内嵌终端里 `echo $env:Path`（或 `echo %PATH%`）：该条目必须与注册表原文逐字节一致 | 改用户环境变量 → 重启应用 → 终端里打印 PATH → 与 `reg query "HKCU\Environment" /v Path` 的原文对比截图 | windows（中文系统） |
| W11 | **windows-09** 原生工具的 OEM 代码页输出 | 工作区里建一个中文名目录，让模型跑 `cmd /c dir`：工具结果里的中文必须可读 | 真实模型回合，抓工具结果原文与 trace | 真实模型回合 + windows（中文系统） |
| W12 | 长路径（MAX_PATH）边界 | 在工作区里造一条总长 > 300 字符的路径并放一个 `.ts` 文件，跑 `glob **/*.ts` 和 `read` 该文件：期望都成功 | 用 PowerShell 造深目录（`New-Item -ItemType Directory` 逐级），然后模型回合或探针 | windows |
| W13 | 保留文件名与尾随点 | 让模型 `write` 到 `<workspace>\nul` 与 `<workspace>\a.`：期望要么明确报错，要么真的落盘且随后 `read` 能读回；不得出现"报告写入成功但文件不存在" | 真实模型回合，写完立刻用 PowerShell `Test-Path` 核对 | 真实模型回合 + windows |
| W14 | 映射网络盘 / junction 工作区的 glob 与 grep | 在 `subst` 出来的虚拟盘（或映射网络盘）上开工作区，`glob **/*` 必须返回非空 | `subst X: C:\work\proj`，用 X: 打开工作区，跑一次 glob，比对 C: 路径下的结果数 | windows |
| W15 | 命令树清理（旧树 P1-0/P1-3 仍待现场） | 正常退出、超时、取消、父命令先退出四种形态下，`taskkill /T` 后无残留进程 | 每种形态跑一条命令，之后 `Get-Process` 比对基线快照；同时看 trace 的 `termination` 字段 | windows |
| W16 | 随包 node.exe 缺失时的用户可见文案 | 期望出现一条可操作的中文提示；当前预期只有 `Pi Node runtime is missing: <path>`（与 main-host-aux 区域的同名检查项合并执行，不要跑两遍） | 打包态把 `resources\node-runtime\node.exe` 改名，起应用发一条消息，截图横幅 | windows |

---

## 读过的文件

**运行时与宿主**
- `src/runtime/host/exec.ts`
- `src/runtime/host/exec-runner.mjs`
- `src/runtime/host/tsd-read.mjs`
- `src/runtime/host/shell.ts`
- `src/runtime/host/helpers.ts`
- `src/runtime/host/config.ts`
- `src/runtime/host/worker.ts`
- `src/runtime/host/io.ts`
- `src/runtime/bootstrap.ts`（第 130-135、200-330 段）
- `src/runtime/worker/nativeWorkerRuntime.ts`（第 180-215 段）
- `src/agent-host/worker.ts`（第 60-120 段）

**权限**
- `src/runtime/plugins/permissions/index.ts`
- `src/runtime/plugins/permissions/bash-analysis.ts`
- `src/agent-host/permissionPolicy.mjs`

**工具**
- `src/runtime/plugins/tools/index.ts`
- `src/runtime/plugins/tools/paths.ts`
- `src/runtime/plugins/tools/read-lines.ts`

**会话与 MCP**
- `src/runtime/plugins/session/writerLock.ts`
- `src/runtime/plugins/mcp/index.ts`（第 200-235 段）
- `src/runtime/plugins/mcp/config.ts`（第 160-215 段）

**Main 侧**
- `src/main/services/agent-host/NodeRuntimeResolver.ts`
- `src/main/services/agent-host/PiWorkerProcess.ts`
- `src/main/services/agent-host/index.ts`
- `src/main/services/agent-host/piCliLayout.ts`
- `src/agent-host/userResourcePaths.ts`
- `src/main/services/terminal/ShellDetector.ts`
- `src/main/services/terminal/PtyManager.ts`
- `src/main/services/terminal/PiTuiPty.ts`（第 85-145 段）
- `src/shared/defaultPaths.ts`（第 60-110 段）

**测试（用于判定覆盖面）**
- `src/runtime/__tests__/host.test.ts`（Windows/taskkill 相关段）
- `src/runtime/__tests__/shellPolicy.test.ts`（分隔符折叠段）
- `src/runtime/__tests__/tools.test.ts`（CRLF 段）
- `src/main/services/agent-host/__tests__/NodeRuntimeResolver.test.ts`

**文档与证据**
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md`
- `docs/plantree/plans/runtime-hardening/roadmap.md`
- `docs/plantree/plans/runtime-evolution/README.md`（P1-8 / P4 段）
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/README.md`
- `Windows-P4-6-evidence/environment.md`
- `Windows-P4-6-evidence/test12-reverify.md`
- `docs/plantree/plans/runtime-hardening/evidence/batch-d-raw/main-host-aux.md`（只为避免与 `NodeRuntimeResolver` 死代码一条重复立项而查阅）
