# 批次 D 审计 · 加密文件系统（TSD）回落与 Electron utility 载体

区域：tsd-utility · 任务：T031（批评者缺口 13 / 14）· HEAD：`ebc82f16` · 日期：2026-09-15 · 只读

节点判定对象：P1-0、P1-2、P1-8、P4-0（载体面）。

## 总评

这一块的**代码质量比它的证据质量高得多**。T013（`19f9e888`）对 core-host-05 与 tools-10 的修复是真修：exec 的 stderr 预算确实与 stdout 分开了（`exec.ts:572-592`），`host.test.ts:148` 那条用例用真子进程跑了「stderr 刷 8 KiB + stdout 刚好写满窗口」的组合，不是纸面断言；readLines 的块大小几何增长也有计数替身用例（`tools.test.ts:654`）。T022 的长驻子进程与 dispose 同理。

但我在核对「这条回落什么时候会被触发」时发现了一件比任何单条缺陷都重要的事：**按当前接线，TSD 回落分支在任何一种出厂形态下都跑不到**。有密文的只有 Windows 安装版，而 Windows 安装版走的是 `bundled-node` 载体，`workerHost` 对它明写 `tsdReadFallback: 'disabled'`；开启回落的是打包后的 macOS / Linux（因为随包 node 三平台都有），而那两个平台上没有加密驱动、`%TSD-Header-###%` 永远不会出现在文件头。也就是说 `source: 'node-fallback'` 这个取值在产品里从不产生，`tsd-read.mjs`、io.ts 的回落段、以及 T013 为「node-fallback」加的块增长分支，全都只在单元测试里活着。这不是说这套设计错了（`bundled-node` 不需要回落的推理是成立的），而是说：**批次 E 上加密机那天，你没有办法通过产品触发这条路径**，T031 原计划里「现场只验真实策略文件」这一条要重新定义验收对象。

utility 载体这一侧，缺口 14 的结论我复核后依然成立且没有改善：`p1-utility-worker.ts` 仍然手写 host 配置（`source: 'explicit'`、`tsdReadFallback: 'disabled'`），不经 `workerHost()` 产品推导；而 `p1-host-tools.ts:49` 那条 carrier 断言是同义反复——它拿 trace 的版本戳跟产出这个版本戳的同一个配置对象比。唯一的真实子进程端到端用例 `workerEntryWiring.test.ts` 用的是 `fork()`，也就是 **bundled-node 那半边的形状**；utilityProcess 半边零真实进程覆盖。顺着协议面逐项对表还捞出一条实打实的不对称：node 载体显式排空了 worker 的 stdout，utility 载体没有，而 D11 第 5 条把「普通 stdout 必须排空」写成了硬约束。

## 优点

- **core-host-05 是真修，不是改注释**。`RuntimeExecRequest.maxStderrBytes` 进了契约（p1-0 第 4 节）、进了实现（`exec.ts:46-47` 校验、`572-592` 消费）、进了用例，并且明确了「stderr 写满自己的预算后丢弃多余字节，不置 truncated、不触发 terminate」的语义，adapter 也被要求履行同一语义。
- **回落判定是收敛的**：无论 offset 是否为 0 都先探头（`io.ts:113-115`），命中后只允许一次 `runtimeExec.run`，路径以独立 argv 传递（`io.ts:142`），helper 自己再验一次头（`tsd-read.mjs:20-24`），失败不换别的 Node 重试。契约第 3 节点名的五条要求逐条落在代码里。
- **载体推导集中在一个函数**：`workerHost()` 把「哪个 Node、有没有回落」从调用点收到了一处，并且守住了最危险的那个坑——electron-utility 下绝不把 `process.execPath`（Electron 本体）当 helper，`workerCarrier.test.ts:44` 专门盯这条。
- **helper 的打包缺失有门禁**：`agent-host-build-lib.mjs:244-245` 把 `runtime-helpers/exec-runner.mjs` 与 `tsd-read.mjs` 列为产物必存在项，`afterPack.mjs` 的 TSD 解密修复也覆盖 `.mjs`。这正是「spawn 而非 import 的文件」最容易掉的那个坑，而且已经被堵上了。
- **readLines 的块增长只对 helper 生效**（`read-lines.ts:111`），明文路径保持 32 KiB，没有为了修一个平台的问题让所有平台多占内存。

## 弱点

1. 回落分支与真实载体错配（tsd-01），导致 T013 的两项修复、tsd-read.mjs、`node-fallback` 这个 source 取值都无出厂触发路径，现场也无法取证。
2. 读出口的错误没有被工具层兜住：grep 的逐文件 `readFile` 裸奔，任何一个读不了的文件（EACCES、io_tsd_*）让整次搜索失败（tsd-02）——这和 T010 修掉的悬空 symlink 是同一类，只是修在了遍历层没修在读取层。
3. 两载体的协议面有四处实现差异没人对过表，其中 stdout 排空这一处直接违反 D11 第 5 条（tsd-03）。
4. helper 的 stdout 是**无框字节协议**，而子进程环境是整份 `process.env` 直传，NODE_OPTIONS 一类的启动噪声只被挡住了 stderr 半边（tsd-04）。
5. 「O(n²)→约线性」这句落地结论在 2 MiB 封顶之后不成立（tsd-05）。
6. utility 载体的探针不走产品路径、断言同义反复（tsd-06）。
7. TSD 魔数误判没有任何出口：首 16 字节恰好是那串魔数的明文文件在所有载体上都读不出来（tsd-07）。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P1-0 | complete-with-gaps | 两个 service 的契约面基本齐整，core-host-05 已修（T013）且有真子进程用例；缺口是 helper 的 stdout 无框 + 环境整份继承（tsd-04），以及回落分支本身没有出厂载体（tsd-01）。 |
| P1-2 | complete-with-gaps | tools-10 已修（T013）且有计数替身用例；残留是封顶后重新二次化（tsd-05，产品里不可达）、魔数误判无出口（tsd-07）、以及读出口错误在 grep 侧无容错（tsd-02）。 |
| P1-8 | complete-with-gaps | 六项断言的探针仍在仓里可重跑，T027 也补注了实况；但 utility 探针不走产品路径、carrier 断言同义反复（tsd-06），加密机那一半按当前接线无法通过产品触发回落（tsd-01），所以「两载体验收」目前只能算「两载体各跑过一次工具冒烟」，不构成载体兼容性证据。 |
| P4-0 | complete-with-gaps | 两种载体确实共用一套 RPC 形状，Main 侧分支清楚；但协议面有四处实现差异无对表，其中 utility 载体 worker stdout 从不排空违反 D11 第 5 条（tsd-03），且 utility 半边零真实进程用例（tsd-06）。 |

## 发现

### [tsd-01] MEDIUM contract-gap | P1-0 / P1-8 | src/runtime/host/worker.ts:82 | TSD 回落只在不可能命中的平台上启用，在唯一有密文的平台上按设计关闭，整条链路无出厂触发路径

DESC: 三段接线合起来决定了回落永远跑不到。(1) `PiWorkerProcess.ts:79` —— `app.isPackaged && win32` 时 worker 由 `resources/node-runtime/node.exe` 直接 spawn，走 Node IPC，于是 `worker.ts:52` 推出的 carrier 是 `bundled-node`；(2) `host/worker.ts:66` —— `bundled-node` 硬编码 `tsdReadFallback: 'disabled'`；(3) `host/worker.ts:82` —— `electron-utility` 只有在 `resources/node-runtime/` 存在时才给 `configured-node`，而 `afterPack.mjs` 的 `copyNodeRuntime` 按 pin 表给 win32 / darwin / linux 三平台都装了随包 Node，所以打包 macOS / Linux 会开启回落，未打包开发态（Electron 的 `resourcesPath` 下没有 node-runtime）则关闭。结论：开启回落的形态里没有加密驱动，`%TSD-Header-###%` 不会出现在文件头；有密文的形态里回落是关的。`RuntimeReadResult.source === 'node-fallback'` 因此在产品里从不产生，`tsd-read.mjs` 整个文件、`io.ts:140-168`、以及 T013 给 `read-lines.ts:111` 加的 `node-fallback` 分支都只被单元测试执行。这不是说 `bundled-node` 不需要回落的判断错了（同一个二进制再 spawn 一次确实只会重复同一次失败），而是说：随包 node.exe 一旦哪天不在驱动白名单内（换驱动厂商、改按签名放行、企业改策略），Windows GUI 会直接以 `io_tsd_unavailable` 硬失败，而仓库里躺着一套完整的、从未在现场跑过的回落实现帮不上忙；同时批次 E 上加密机那天没有任何产品操作能触发这条路径去验证它。static_inference：是，判定依据是三段代码的组合与打包脚本，没有在 Windows / 加密机上执行过。
EVIDENCE:
```ts
// src/runtime/host/worker.ts:60-83
  if (input.carrier === 'bundled-node') {
    ...
      node: { path: execPath, source: 'bundled' },
      // This carrier exists precisely because the security driver whitelists
      // this binary: it already reads plaintext, so a fallback that re-spawns
      // the same binary could only repeat the failure with a worse message.
      tsdReadFallback: 'disabled',
  }
  const bundled = input.resourcesPath ? bundledNodePath(input.resourcesPath, platform) : undefined;
  const node = bundled && existsSync(bundled) ? { path: bundled, source: 'bundled' as const } : undefined;
  return { ...base, carrier: 'electron-utility', ...(node ? { node } : {}), tsdReadFallback: node ? 'configured-node' : 'disabled' };
```
```ts
// src/main/services/agent-host/PiWorkerProcess.ts:79-92
  if (app.isPackaged && process.platform === 'win32') {
    const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    ...
    const processHandle = spawn(nodePath, [entryPath], { ... stdio: ['ignore','pipe','pipe','ipc'] });
    return { process: processHandle, transport: createNodeProcessWorkerTransport(processHandle) };
  }
```
SCENARIO: 加密机（Windows 安装版）上，驱动不再放行随包 node.exe（换版本、换厂商、按签名放行、或安装目录变了）。worker 是 `bundled-node`，`io.ts:113` 探头命中魔数，`io.ts:134` 判 `tsdReadFallback !== 'configured-node'` 直接抛 `io_tsd_unavailable`，模型每次 read 都拿到「TSD read requires configured Node」，edit / grep 一并失败；仓库里那套能工作的 helper 不会被调用。反过来，在批次 E 的加密机上想验证 helper 契约，也没有任何产品操作能让它跑起来——必须临时改配置才能触发，那验的就不是出厂形态。
FIX: 三件事分开做。(a) 把「`configured-node` 目前没有出厂载体」写进 p1-0 契约第 3 节与 P1-8 验收口径，避免后来者以为现场验过；(b) 给 `bundled-node` 加一条**可诊断**而非可回落的路径：命中魔数时的错误里带上 `node_exec_path` 与 carrier，并在 trace 里落一个 `tsd_head_hit` 计数，这样现场一眼能分清「白名单失效」和「文件本来就读不了」；(c) 如果要让回落在 Windows 上真的可用，只能引入一个与 worker 不同身份的解密进程（Main 侧 `tsdSafeRead.ts` 已经是这个形态），此时必须连带修 tsd-04，否则回落一开就带着静默污染风险。

### [tsd-02] MEDIUM robustness | P1-4（经 P1-2 的读出口触发）| src/runtime/plugins/tools/index.ts:612 | grep 的逐文件 readFile 没有容错，一个读不了的文件让整次搜索失败

DESC: `walk()` 已经按 T010 的修法对遍历错误容错（`index.ts:770` / `index.ts:772-774` 用 `isSkippableIoError` 跳过 EACCES/ENOENT/ELOOP…），但 walk 吐出文件之后，grep 主循环里的 `io.readFile` 是裸的——没有 try/catch，也没有过 `isSkippableIoError`。`OPTIONAL_FILE_ERRORS`（`index.ts:53`）只含六个 POSIX 码，`io_tsd_unavailable` / `io_tsd_unreadable` / `io_limit` 都不在其中，而且这里根本没走到那个判断。后果是任何单个文件的读失败把整次 grep 变成一条工具错误，模型拿不到已经命中的结果。这条不依赖加密环境：普通 Linux 上一个 `chmod 000` 的文件就能复现（walk 能列出它——目录可读，dirent 说它是 file——readFile 时才 EACCES）。加密机上则是 tsd-01 与 tsd-07 的放大器。
EVIDENCE:
```ts
// src/runtime/plugins/tools/index.ts:598-615
        for await (const file of walk(io, root, budget, (file) => ..., signal)) {
          if (included && !included(file)) continue;
          if (pathPolicy(file) !== 'allow') { skipped++; continue; }
          const data = await io.readFile(file, {
            maxBytes: SEARCH_FILE_BYTES,
            overflow: 'truncate',
            signal,
          });
```
SCENARIO: 工作区里有一个 `chmod 000` 的文件（CI 产物、别人的 socket 目录里的普通文件、root 拉起的日志）。模型执行 `grep {pattern:'TODO'}`，walk 把它列出来，`io.readFile` 抛 EACCES，异常冒出 `execute`，整次 grep 返回错误；已经扫到的匹配全部丢弃。模型看到的是「grep 失败」，无从得知是哪一个文件、也不知道其余结果本来是好的。
FIX: 与 walk 同款处理：把这次 readFile 包进 try/catch，`isSkippableIoError(error)` 为真时 `skipped++` 并 continue；同时把 `io_tsd_unavailable` / `io_tsd_unreadable` / `io_not_utf8` 也纳入「可跳过」集合（加密文件与二进制文件对 grep 而言都是「扫不了」，不是「搜索失败」），并在结果尾巴上把 skipped 的条数报给模型（现有 `skipped` 计数已有出口）。

### [tsd-03] MEDIUM robustness | P4-0 | src/main/services/agent-host/WorkerTransport.ts:56 | utility 载体的 worker stdout 从不排空，node 载体排空——D11 第 5 条只落实了一半

DESC: `PiWorkerProcess.ts:94-100` 给 utilityProcess 传 `stdio: 'pipe'`，所以 worker 的 stdout 是一根真管道。`createNodeProcessWorkerTransport` 在 `WorkerTransport.ts:97-98` 有一行显式的 `proc.stdout?.resume()`，注释写明「drain ordinary stdout so tool/extension logs cannot fill its pipe」；`createUtilityProcessWorkerTransport`（:56-93）没有对应的一行，`onStderr` 只订阅 stderr（:82-84），全仓再无第二处碰 `proc.stdout`（`grep -rn "stdout" src/main/services/agent-host/*.ts` 只命中 NodeRuntimeResolver 与这一行）。ARD D11 第 5 条把「子进程的普通 stdout 必须排空」写成硬约束，p1-0 契约第 10 节也把「真实 stdout 不混进 worker RPC」列为验收点。后果的准确说法是：Node 里管道 stdout 是**异步**写，写入端不会立刻阻塞，而是把数据排进本进程的内存队列，所以第一现场是 utility worker 的内存单调增长、日志永远不落地，极端情况下才表现为写入方停摆。我们自己的代码全部写 stderr（`worker.ts:142/160/165` 都是 `console.error`），所以触发要靠第三方（pi-ai / cordis / MCP 客户端 / 未来的插件）往 stdout 打日志——这正是 D11 那条约束存在的理由。static_inference：是，未在 Electron 里实测；「未排空」本身是 100% 确定的代码事实，「后果」这一段是按 Node/libuv 语义推断的。
EVIDENCE:
```ts
// src/main/services/agent-host/WorkerTransport.ts:96-99
export function createNodeProcessWorkerTransport(proc: ChildProcess): WorkerTransport {
  // RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe.
  proc.stdout?.resume();
```
```ts
// src/main/services/agent-host/WorkerTransport.ts:56-58（utility 分支，无对应行）
export function createUtilityProcessWorkerTransport(proc: UtilityProcess): WorkerTransport {
  return {
    get pid() {
```
SCENARIO: 打包后的 macOS / Linux（或任意平台的开发态）上跑一个会 `console.log` 的 MCP 客户端库或第三方插件。utility worker 的 stdout 没有任何读者，输出在 worker 进程内排队；一个长会话下来 worker 内存持续上涨而 Main 侧看不到任何日志，排查时也拿不到这些行。冒烟脚本发现不了：`scripts/runtime-smoke/electron-carrier.cjs:31` 自己订阅了 `child.stdout` 并转写到父进程 stdout，探针环境里管道是被读的。
FIX: 在 `createUtilityProcessWorkerTransport` 里加一行 `proc.stdout?.resume()`，或者更好：两个 transport 共用一个 `drainStdout(proc)` 辅助，并把 stdout 也接到 `hostStderr.ts` 的按行组装上（标注来源 stream），这样第三方日志既不会积压也不会消失。补一条单测：用替身 transport 断言构造后 stdout 处于 flowing 模式（`readable.readableFlowing === true`），两个 transport 各一条。

### [tsd-04] LOW correctness | P1-0 | src/runtime/host/io.ts:148 | helper 的 stdout 是无框字节协议，而子进程环境整份继承：一条 stdout 启动噪声会把文件内容悄悄改写

DESC: T013 把 stderr 预算独立出去，解决了「噪声吃掉输出额度」这半边；另一半没动——helper 的 stdout 里**只有明文，没有任何框**，io.ts 拿到多少字节就当多少字节的文件内容返回（`io.ts:168`）。同时子进程环境是整份父进程环境：`workerHost` 用 `Object.entries(env)` 全量拷进 `childEnv`（`host/worker.ts:66-69`），`commandEnvironment`（`exec.ts:419`）只改 PATH，不剔除 `NODE_OPTIONS`。契约第 4 节自己点名了「NODE_OPTIONS、企业预载脚本」这个威胁模型，但结论只写到「不能把一次成功读取变成失败」，没覆盖「不能把一次读取变成错误的内容」。于是：预载脚本往 stderr 打字 → 已被 4 KiB 独立预算挡住（已修，T013）；往 stdout 打一个字节 → 要么被当成文件开头的内容返回给模型（静默错误），要么把总量顶过 `maxBytes + 1` 触发 `terminate` 变成 `io_tsd_unreadable`（把能读的文件报成读不了）。严重级定 low 而不是 medium，唯一的理由是 tsd-01：这条路径当前没有出厂触发形态；**一旦按 tsd-01 的 (c) 把回落接到 Windows 上，这条立刻是数据正确性问题，必须同批修**。static_inference：是。
EVIDENCE:
```ts
// src/runtime/host/io.ts:140-152
      const output = await this.ctx.runtimeExec.run({
        command: this.config.node.path,
        args: [tsdHelper(), path, String(offset), String(options.maxBytes + 1)],
        cwd: dirname(path),
        timeoutMs: TSD_READ_TIMEOUT_MS,
        maxOutputBytes: options.maxBytes + 1,
        maxStderrBytes: TSD_STDERR_BYTES,
        overflow: 'terminate',
        signal,
      });
```
```ts
// src/runtime/host/worker.ts:66-69（childEnv 全量继承，未剔除 NODE_OPTIONS）
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
```
SCENARIO: 企业机器的系统环境里设了 `NODE_OPTIONS=--import /opt/corp/telemetry.mjs`，而该脚本在初始化时 `console.log('[corp] telemetry ready')`。helper 进程继承了这个变量，19 个字节先于明文写进 stdout。io.ts 没有任何办法区分它和文件内容，于是模型读到的 `config.json` 开头多了一行 `[corp] telemetry ready`——read 显示的行号、edit 的唯一匹配、readBeforeChange 的 diff 全部基于这份被污染的内容；如果这次 read 恰好是满窗口的，则多出来的字节顶破 `maxBytes + 1`，`overflow: 'terminate'` 生效，一个完全正常的文件被报成 `io_tsd_unreadable`。
FIX: 两步。(a) 给 helper 专用一份最小环境：spawn 时删掉 `NODE_OPTIONS`、`NODE_REPL_EXTERNAL_MODULE`、`NODE_V8_COVERAGE`，并加 `--no-warnings`（或在 `io.ts` 调用点用 `env: { NODE_OPTIONS: undefined }` 覆盖，`commandEnvironment` 已支持 `undefined` 删键）。(b) 给 stdout 加一层极薄的框以便自检：helper 先写固定 8 字节魔数 + 4 字节长度，io.ts 校验后剥掉——这与契约「stdout 保持原始字节」不冲突（那句约束的是「不要转换载荷」），并且是唯一能把「噪声」与「内容」区分开的办法。若不做框，至少做 (a) 并在契约里明写「stdout 上的任何额外输出都会被当成文件内容」。

### [tsd-05] LOW perf | P1-2 | src/runtime/plugins/tools/read-lines.ts:52 | 块大小封顶 2 MiB 之后重读量重新变成二次，注释与落地记录的「约线性」不成立

DESC: `read-lines.ts:112` 的 `chunkBytes = Math.min(Math.max(chunkBytes * 2, maxBytes), FALLBACK_CHUNK_MAX_BYTES)` 在触到 2 MiB 封顶前是几何增长（这段确实把总重读量压成 O(n)），但封顶之后每一块都要让 helper 从文件头重读一次前缀，重新变成等差和，即 O(n²/2·cap)。按扫描上限 64 MiB 实算（我用 node 跑了这段循环的算术，非执行产品代码）：38 次 readFile、约 **1121 MiB** 的解密重读量，而线性下限是 64 MiB，仍有 17.5 倍放大；每次 readFile 在 pipe 模式下还是**两个**进程（`exec-runner.mjs` + helper），即约 76 次进程创建。对照修前（固定 32 KiB）是 2048 次调用、约 64 GiB，所以 T013 确实改善了约 60 倍——但 `read-lines.ts:50` 的注释「keeps both roughly linear in the bytes actually scanned」与 roadmap T013 行的「总重读量 O(n²)→约线性、进程创建上百次→个位数」，在 4 MiB 以上都不准确（4 MiB：8 次调用、11.7 MiB 重读，此时才接近说法）。现有用例 `tools.test.ts:654` 用的是 1 MB 样本（5000×200B），断言 `windows.length <= 6`，正好落在封顶生效之前，所以这段回归没有守护。严重级 low：tsd-01 决定了这条路径当前在产品里不可达，且即使可达也只是慢，不是错。
EVIDENCE:
```ts
// src/runtime/plugins/tools/read-lines.ts:45-52
/**
 * tools-10 — ... Doubling the window after each fallback chunk keeps both
 * roughly linear in the bytes actually scanned; the cap bounds what a single
 * step may buffer.
 */
const FALLBACK_CHUNK_MAX_BYTES = 2 * 1024 * 1024;
```
SCENARIO: 加密机上对一个 40 MiB 的受策略日志执行 `read {path:'app.log', offset: 400000}`。扫描要走完 40 MiB，封顶后每块 2 MiB，约 25 次 readFile、约 50 个进程、约 500 MiB 的驱动解密读取，每块各自带 30 秒预算——单次 read 从毫秒级变成分钟级，且 50 次进程创建全落在企业安全软件的监控上。
FIX: 代码不必再改（再放大块大小会顶到内存），但要把话说准：把 `read-lines.ts:50` 的注释改为「封顶前几何增长、封顶后按 cap 线性分块，总重读量相对线性有 n/(2·cap) 倍放大」，并在 roadmap T013 行补一句实测量级。若确实要修，唯一有效的方向是让 HostIo 暴露一个「一次回落读取跨多块复用」的接口（例如 helper 一次性输出到一个临时明文文件再由 worker 顺序读），这属于新能力，应单立任务。补一条用例：样本放大到 >8 MiB，断言 `windows` 序列在触顶后恒为 2 MiB 且调用次数落在 ceil(n/2MiB)+6 内。

### [tsd-06] LOW test-gap | P1-8 / P4-0 | src/runtime/smoke/p1-utility-worker.ts:10 | utility 载体探针不走产品路径推导，且它的 carrier 断言是同义反复

DESC: 批评者缺口 14 指出的两件事在 HEAD 上一件都没变。(1) 探针自己手写 host 配置：`carrier: 'electron-utility'`、`node: { path: nodePath, source: 'explicit' }`、`tsdReadFallback: 'disabled'`，而产品里这三项是 `workerHost({ carrier, resourcesPath })` 推导出来的（`agent-host/worker.ts:93`），推导结果应当是 `source: 'bundled'` 且 `tsdReadFallback: 'configured-node'`。探针跑绿不能证明推导正确。(2) `p1-host-tools.ts:49` 的 `trace.version_stamp.carrier === host.carrier` 是拿 `bootstrap.ts:449` 从**同一个 host 对象**抄进版本戳的值去比这个对象——恒真，换句话说探针即使跑在错误的载体上也会 `passed: true`。报告里其实带了能证伪的原料（`execPath`、`process.versions.electron`），但没有一条断言用它们。另外，全仓唯一的真实子进程端到端用例 `workerEntryWiring.test.ts` 用的是 `fork()`（Node IPC，即 bundled-node 那半边的形状），utilityProcess 半边只有 `workerCarrier.test.ts` 这种纯函数替身。
EVIDENCE:
```ts
// src/runtime/smoke/p1-utility-worker.ts:7-15
  const result = await runHostToolsProbe(
    {
      carrier: 'electron-utility',
      node: { path: nodePath, source: 'explicit' },
      tsdReadFallback: 'disabled',
```
```ts
// src/runtime/smoke/p1-host-tools.ts:49
      trace: run.trace.version_stamp.carrier === host.carrier && !run.trace.persistence_error,
```
SCENARIO: 有人改坏 `workerHost` 的 electron-utility 分支（比如把 `existsSync` 判断写反，或让它回退到 `process.execPath`，也就是 Electron 本体）。`workerCarrier.test.ts` 会红——这条守住了；但如果改坏的是 `agent-host/worker.ts:52` 的 carrier 推导或 `resourcesPath` 的取法，两个探针与全部单测都照常绿，因为探针根本不调用这两段。P1-8 的「两载体六项断言通过」因此只覆盖了「在手写配置下工具能跑」，没覆盖「产品会不会给出这份配置」。
FIX: (a) 把 `p1-utility-worker.ts` 改成 `workerHost({ carrier: 'electron-utility', resourcesPath: process.resourcesPath })`，缺随包 Node 时明确失败而不是退成 `explicit`；(b) 把 `p1-host-tools.ts` 的 carrier 断言换成可证伪的：electron-utility 下断言 `process.versions.electron` 非空且 `host.node.source === 'bundled'`、`host.node.path !== process.execPath`，bundled-node 下断言 `process.versions.electron` 为空且 `host.node.path === process.execPath`；(c) 给 utilityProcess 半边补一条可在有 Electron 的机器上跑的集成用例（沿用 `electron-carrier.cjs` 的形态），至少断言一次 bootstrap 往返与一次 dispose 干净退出。

### [tsd-07] LOW correctness | P1-2 | src/runtime/host/io.ts:115 | 首 16 字节恰为 TSD 魔数的明文文件，在所有载体上都读不出来且没有任何出口

DESC: 回落判定的唯一依据是文件前 16 字节是否等于 `%TSD-Header-###%`（`io.ts:113-115`），没有第二个判据（没有容器长度校验、没有 stat 形态校验），也没有任何「其实是明文」的逃生出口。一个合法的明文文件只要以这串字符开头就会被判成密文：`tsdReadFallback: 'disabled'` 的载体（Windows 安装版、所有开发态）抛 `io_tsd_unavailable`；`configured-node` 的载体（打包 macOS / Linux）把它交给 helper，helper 在 `tsd-read.mjs:23-24` 再验一次头、看到同一串魔数就抛 `configured Node still reads TSD ciphertext`，回到 io.ts 变成 `io_tsd_unreadable`。也就是说这类文件在任何出厂形态下都读不了，错误信息还把它说成加密文件。这类文件不是臆造：仓里描述这套机制的文档、测试夹具、以及任何记录该魔数的样本文件都可能以它开头。叠加 tsd-02，工作区里出现一个这样的文件会让整棵树的 grep 失败。
EVIDENCE:
```ts
// src/runtime/host/io.ts:113-115
        const head = Buffer.alloc(TSD_MAGIC.length);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        encrypted = bytesRead === head.length && head.equals(TSD_MAGIC);
```
```js
// src/runtime/host/tsd-read.mjs:22-24
    const first = await file.read(head, 0, head.length, null);
    if (first.bytesRead === head.length && head.equals(magic))
      throw new Error('configured Node still reads TSD ciphertext');
```
SCENARIO: 有人在工作区里放一份 `tsd-sample.txt`，第一行就是 `%TSD-Header-###%`（排查加密问题时抓的样本，或一份以它开头的说明）。模型 `read` 它 → `io_tsd_unavailable: TSD read requires configured Node`；`edit` 它 → 同样；`grep` 整棵树 → 整次失败（tsd-02）。用户看到的是「这个文件被加密了」，而它就是一份普通文本。
FIX: 魔数命中后加一个廉价的二次判据再决定走回落：例如要求文件大小是容器块大小的整数倍（D13 现场记录的容器是 8192 字节），或要求紧随魔数之后的若干字节符合容器头形态；不满足就按明文继续读。至少要把错误文案改成可自救的说法（「前 16 字节与 TSD 容器头一致；若这是普通文本文件，请确认…」），并把 `io_tsd_*` 纳入 grep / 技能加载等批量读取的可跳过错误集合（与 tsd-02 同批）。

### 与 2026-09-09 现场证据的对账

`Windows-P4-6-evidence/encryption-special.md` 是本区域唯一的现场一手材料，它的结论与 tsd-01 互相印证而不是冲突：同一份真实密文文件，随包 `node.exe` 与系统 Git Bash 读到明文、非白名单 PowerShell 读到 `%TSD-Header-###%` 容器。也就是说在现场那台机器上，worker 载体确实拿到明文，**TSD 探头压根不会命中**，回落自然也不会被调用——这正是「这条链路没有出厂触发路径」的现场佐证。

该文档自己留了两条未决项，与本区域检查单的 E2 / E3 是同一件事，请合并执行不要跑两遍：「加密域目录里的 GUI 读明文 / Edit 后 TUI·编辑器一致 / 退出无残留」，以及「本机工作区（E:）新写文件当前实测为明文，加密域下的行为未验」。另外它记录的一条事实值得在批次 E 复核有效性：**系统 Git Bash 也在白名单内**（D11 的 F3 未决项因此当时被判为低风险）——这条是按 2026-09-09 的那台机器、那个驱动版本得出的，换机器要重验（检查单 E5）。

## 测试缺口

下面是**可在普通开发机上跑**的 TSD helper 替身用例清单（不需要加密机、不需要 Electron）。每条给用例名 / 模拟的 helper 行为 / 期望断言。除 T09 外都建在 `src/runtime/__tests__/host.test.ts` 已有的 `host-adapter` 替身模式上（`host.test.ts:102` 与 `:148` 是现成样板），T09 建在 `tools.test.ts` 的 `countingIo` 上。

已覆盖、不必重复：无回落时抛 `io_tsd_unavailable`；真 helper 直跑 offset/limit 与含空格/`$` 的路径；adapter 恰好被调用一次且 argv 形状正确；stderr 刷 8 KiB 不影响满窗 stdout；helper 非零退出 → `io_tsd_unreadable`。

| # | 用例名 | 替身行为 | 期望断言 |
|---|---|---|---|
| T01 | `helper timeout is an unreadable file, not a partial read` | adapter 返回 `termination: 'timeout'`、`exitCode: null`、stdout 带半截明文 | 抛 `io_tsd_unreadable`；错误 message 含 `timeout`；**不返回**任何字节给调用方 |
| T02 | `a short helper read is a complete file, not a failure` | exit 0，stdout 只有 `maxBytes/2` 字节 | 正常返回，`truncated === false`，`source === 'node-fallback'`，字节与替身写入完全一致 |
| T03 | `stdout noise ahead of the plaintext must not become file content` | exit 0，stdout = `'[corp] ready\n' + 明文` | 当前实现会把噪声当内容（**修 tsd-04 前这条应判红，作为回归锚点**）；修后期望：抛带 code 的错误或剥离框外字节 |
| T04 | `stdout past the window is never a complete file` | exit 0，stdout 写 `maxBytes + 2` 字节（触发 terminate） | 抛 `io_tsd_unreadable`；不得把前 `maxBytes` 字节当成功读取返回 |
| T05 | `binary plaintext survives the fallback unchanged` | exit 0，stdout 含 NUL 与非 UTF-8 字节序列 | HostIo 原样返回字节（不解码）；随后 read 工具对同样字节报 `io_not_utf8`（两段分开断言） |
| T06 | `abort during the helper run reports io_aborted` | adapter 在 run 中等待，用例在途中 abort 外部 signal | 抛 `io_aborted`（不是 `io_tsd_unreadable`）；adapter 收到的 `request.signal` 与调用方传入的是同一次中止 |
| T07 | `offset past EOF returns empty bytes on the fallback path too` | exit 0，stdout 零字节 | `bytes.length === 0`、`truncated === false`，与明文路径（`host.test.ts:72` 已有的同形断言）结果一致 |
| T08 | `the helper does not inherit NODE_OPTIONS` | adapter 只记录 `request.env` | `request.env.NODE_OPTIONS === undefined`（修 tsd-04 后应绿，修前判红） |
| T09 | `fallback windows stay capped past 2 MiB` | `countingIo('node-fallback')`，样本 >8 MiB | `windows` 触顶后恒为 2 MiB；调用次数 ≤ `ceil(n/2MiB) + 6`；与 `direct` 同参结果逐字段相等 |
| T10 | `a plaintext file that starts with the magic is skipped by grep, not fatal` | 真实临时文件，内容 = 魔数 + 文本；grep 跑整个临时目录 | grep 正常返回其他文件的命中，`skipped` 计数 +1（修 tsd-02 后应绿）；同目录的 read 抛带可自救文案的错误 |
| T11 | `an unreadable file does not fail the whole grep` | 真实临时文件 `chmod 000`（POSIX 下用 `it.skipIf(process.platform==='win32')`） | 同上：其余命中照常返回，不抛 |
| T12 | `without maxStderrBytes the budget is still shared` | adapter 透传给真 exec：stdout 写 N 字节、stderr 写 M 字节，不给 `maxStderrBytes` | `stdout.length + stderr.length <= maxOutputBytes`（守住契约第 4 节的旧语义，防止 T013 的新语义误扩大） |
| T13 | `stderr overflow alone never sets truncated` | stdout 只写半窗，stderr 写 `TSD_STDERR_BYTES * 2` | `truncated === false`、`termination === 'exit'`、`stderrBytes` 等于真实写入总量、`stderr.length === TSD_STDERR_BYTES`（现有 `:148` 那条因为 stdout 满窗，truncated 恒真，这一面没被断言过） |
| T14 | `real helper: limit=1 / offset past EOF / non-UTF-8 bytes` | 直跑 `tsd-read.mjs`（沿用 `host.test.ts:94` 的形态） | limit=1 只吐 1 字节；offset > 文件长度吐 0 字节且 exit 0；非 UTF-8 字节原样透传（证明 helper 不做文本处理） |

另有两条与本区域相关、不属于 helper 替身的测试缺口：
- `WorkerTransport` 两个工厂各一条「stdout 处于 flowing 模式」断言（tsd-03 的回归锚点）。
- utilityProcess 半边缺任何真实进程用例；`workerEntryWiring.test.ts` 只覆盖 `fork()` 形状（tsd-06）。

## 未经执行验证的声明

- tsd-01 的「产品里从不产生 `node-fallback`」是三段代码 + 打包脚本组合推出的，没有在 Windows / macOS 打包产物上实跑验证；尤其「打包 macOS/Linux 的 `resources/node-runtime/node` 一定存在」我只看到 `node-runtime-pin.mjs` 三平台都有 pin 与 `afterPack.mjs` 的按 pin 复制，没有验证过产物。
- tsd-03 的后果链（内存排队而非阻塞）按 Node/libuv 对管道 stdout 的异步写语义推断；未在 Electron utilityProcess 里实测，也没有确认 Electron 对 utility 子进程 stdout 是否有额外缓冲策略。
- tsd-04 的触发依赖「企业预载脚本会往 stdout 打字」，这是威胁模型不是观测；契约第 4 节自己点名了 NODE_OPTIONS 这个来源，但没有任何现场样本。
- 两种载体的 RPC 消息序列化差异（utility 是结构化克隆、node IPC 默认是 JSON）我确认了机制，但在 `src/shared/types/workerRpc.ts` 里没找到二进制/Date/Map/Set 字段，所以**没有构造出具体的失败路径**，不立为发现。仍有一类未排除的差异：值为 `undefined` 的键在 JSON 序列化下会消失、在结构化克隆下会保留，任何用 `'key' in payload` 判断的消费者会在两个载体上行为不同。
- `commandEnvironment`（`exec.ts:433`）把 `dirname(config.node.path)` 放到 PATH 首位，这在打包 macOS/Linux 上意味着 bash 工具里的 `node` 解析到随包 Node 24 而不是用户的 nvm/fnm 版本。p1-0 契约第 4 节明写了这条规则（「随后把已配置 Node 的目录放到 PATH 首位」），所以**不立为发现**；但它是否是 macOS/Linux 上想要的行为没有任何记录，列进检查单 U5。
- Windows 上 `spawnPersistent` / `runPipe` 的 taskkill 路径、`exec-runner.mjs` 的 `disconnect` → `taskkill /T /F` 自杀分支，本区域只做了静态阅读，未执行（与 windows-static 区域的检查项重叠，不要跑两遍）。
- 加密驱动在「非白名单进程写入受策略文件」时的实际行为（拒绝？写成明文？仍然加密？）没有任何仓内证据；D13 只记录了「加密按文件策略生效，不按写入进程」这一句现场结论。edit / write 的读-改-写往返因此只能上机验证，见 E2/E3。

## 上机检查单

### 加密机（target: encrypted）

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| E1 随包 node.exe 仍在驱动白名单内 | 安装版 GUI 里 `read` 一个受策略文件返回**明文**；不出现 `io_tsd_unavailable` | 读工具输出截图 + 同一次 run 的 `runs.jsonl` 版本戳（应为 `carrier=bundled-node`、`tsd_read_fallback=disabled`、`node_exec_path=…\node-runtime\node.exe`） | encrypted |
| E2 Write→Read 明文往返（契约 §3「写后密文风险」点名由 P1-8/P4-6 验证） | `write` 写出的文件在盘上是密文容器（白名单外进程看到 `%TSD-Header-###%`、stat 报容器大小），而 GUI `read` 读回原文 | 用工具写 `tracked.txt`，再用记事本/PowerShell（非白名单）看头 16 字节，再用 GUI 读回 | encrypted |
| E3 edit 的读-改-写不破坏加密 | 对受策略文件 `edit` 一次后，文件仍是密文容器，且 GUI 再读内容正确、白名单外进程仍看到密文 | 同 E2 的取头方式，edit 前后各取一次 | encrypted |
| E4 单个读不了的文件不打垮 grep（tsd-02 的现场判据） | 工作区里存在一个当前进程读不了的受策略文件时，`grep` 仍返回其余命中并报出 skipped 条数 | 构造一个驱动拒绝的文件（或 `icacls` 去掉读权限），跑一次 grep，保存工具输出 | encrypted |
| E5 bash 叶子进程读到的是明文还是密文（D11 未决项 F3） | `bash` 执行 `type tracked.txt` 的输出与 GUI `read` 一致 | 同一文件两条路径各取一次输出并 diff | encrypted |
| E6 魔数误判的现场形态（tsd-07） | 手写一个以 `%TSD-Header-###%` 开头的**明文** txt，`read` 它 | 期望当前报 `io_tsd_unavailable`；记录文案，作为 FIX 后的对照 | encrypted |
| E7 若 tsd-01 按「接通回落」修法推进，才需要跑：helper 端到端 | 一次 read 起两个进程（runner + helper）、30 秒内返回明文；连续分页读的进程数与耗时记录在案 | 临时构建打开 `configured-node`，用 Process Monitor 记进程创建次数与耗时 | encrypted |

### utility 载体（target: utility）

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| U1 探针走产品路径推导（缺口 14 的收口判据） | `carrier=electron-utility` 且 `node.source==='bundled'`、`node.path !== process.execPath`、`tsdReadFallback==='configured-node'`，六项工具断言全通过，报告里带 Electron 版本与 HEAD 版本戳 | 改造后的 `src/runtime/smoke/p1-utility-worker.ts` 经 `scripts/runtime-smoke/electron-carrier.cjs` 运行，输出与提交号一起归档 | utility |
| U2 utility worker 的 stdout 压力（tsd-03 判据） | 临时探针在 utility worker 里向 stdout 写 4 MiB 后，RPC 仍能应答一次 bootstrap；worker RSS 增长 < 数 MiB | 起 Electron，观察探针应答与 worker 进程 RSS；修复后重跑对照 | utility |
| U3 两载体同一报文形状对比 | 同一次 bootstrap + 一次 run 的 worker→Main 消息，在 utilityProcess 与 `fork()` 两条通道下逐字段等价（尤其无 `undefined` 键差异） | 两条通道各录一份消息序列 JSON，跑一次 diff，差异逐条解释 | utility |
| U4 退出码与信号语义 | 外部 SIGKILL / taskkill 掉 worker 后，Main 记录的 `Worker exited (code=? signal=?)` 两个载体各是什么；确认 `isLostDisposeAck`（`WorkerSlot.ts:118-125`，要求 `code===0 && signal===null`）不会把崩溃误判成「dispose ACK 丢了」 | 两个载体各杀一次，抓 main.log 对应行 | utility |
| U5 打包 macOS/Linux 上 PATH 首位是随包 Node | bash 工具里 `node -v` 与 `which node` 指向 `resources/node-runtime`；确认这是否是想要的行为（契约第 4 节写了这条规则，但没写它在非 Windows 上的意图） | 打包产物里跑两条 bash 命令，截输出；结论回写契约或 ARD | utility |

## 读过的文件

- src/runtime/host/io.ts
- src/runtime/host/exec.ts
- src/runtime/host/exec-runner.mjs
- src/runtime/host/tsd-read.mjs
- src/runtime/host/helpers.ts
- src/runtime/host/config.ts
- src/runtime/host/worker.ts
- src/runtime/host/shell.ts
- src/runtime/contracts.ts（RuntimeHostConfig / RuntimeRead* / RuntimeExec* 段）
- src/runtime/bootstrap.ts（host 校验与版本戳段）
- src/runtime/flags.ts（只核对有无载体覆盖开关）
- src/runtime/plugins/tools/read-lines.ts
- src/runtime/plugins/tools/index.ts（read / write / edit / bash / grep / walk 段）
- src/runtime/plugins/tools/file-change.ts
- src/runtime/__tests__/host.test.ts（TSD / fallback / helper / 前 205 行全部）
- src/runtime/__tests__/workerCarrier.test.ts
- src/runtime/__tests__/tools.test.ts（read line scanning 段）
- src/runtime/smoke/p1-utility-worker.ts
- src/runtime/smoke/p1-bundled-node.ts
- src/runtime/smoke/p1-host-tools.ts
- scripts/runtime-smoke/electron-carrier.cjs
- src/agent-host/worker.ts（载体推导与 host 装配段）
- src/agent-host/__tests__/workerEntryWiring.test.ts（前 80 行）
- src/main/services/agent-host/PiWorkerProcess.ts
- src/main/services/agent-host/WorkerTransport.ts
- src/main/services/agent-host/WorkerSlot.ts（transport 订阅与退出分类段）
- src/main/services/agent-host/hostStderr.ts
- scripts/afterPack.mjs
- scripts/build-agent-host.mjs（helper 复制段）
- scripts/agent-host-build-lib.mjs（产物必存在项段）
- scripts/node-runtime-pin.mjs
- electron-builder.yml（extraResources 段）
- docs/plans/2026-09-08-runtime-evolution-ard.md（D4 / D11 / D13 / D16）
- docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（缺口 13 / 14 与 UNVERIFIED CLAIMS）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-medium.md（tools-10 原文）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-uncertain-refuted.md（core-host-05 原文与反驳）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段与任务表）
- Windows-P4-6-evidence/encryption-special.md
