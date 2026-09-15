# 批次 D 补审 · 并发多会话静态面

- **区域**：concurrency（跨进程写锁、runs.jsonl、技能 / 子代理目录快照、MCP 进程预算、Main 槽位与工作区）
- **任务**：T031（批评者缺口 15，`cross-and-critic.md:78` GAP [并发多会话]）
- **节点判定对象**：P3-1、P3-3、P5-1、P5-3、P4-0 的并发面
- **基线**：HEAD `ebc82f16`
- **日期**：2026-09-15
- **方式**：只读。未构建、未跑 tsc / vitest、未起 Electron、未跑打包。

---

## 总评

先把「同时开 N 个会话」在这套代码里到底长什么样说清楚，因为后面每一条结论都取决于它：

1. **一个会话 = 一个独立进程。** Main 的 `WorkerManager` 给每个会话分一个 `WorkerSlot`，每个 slot 是一个单独的 Electron utilityProcess（Windows 打包态是单独的 `node.exe`）。默认并发上限按内存分档：≤4 GiB 的机器 3 个，≤8 GiB 6 个，再往上 10 个。
2. **同一个会话文件不会被两个 worker 同时打开——这条由 Main 保证，不是由锁保证。** `entriesByKey` 用会话文件路径当键，创建与恢复两条路径都在同一条串行链上先查冲突；再加上 `app.requestSingleInstanceLock()`，第二个应用实例根本起不来。
3. **真正跨进程共享的东西只有四样**：会话 JSONL（写锁守）、`runs.jsonl`（trace，只在设了环境变量时存在）、agent 目录下的技能 / 子代理定义文件（多读一写）、以及每个会话各自拉起的 MCP 服务器子进程。

在这个前提下看，T015 之后的写锁**主干是对的**：创建即互斥、按 pid 判陈旧、跨机器不偷、释放校验 token、抢占用原始字节比对。它已经覆盖了两个进程抢一把陈旧锁的两种交织，用例也在。

但这一层还剩两个洞，都不在「两个进程」这个视角里：

- **第三个申领者。** 抢占是「把锁改名移到一边，发现不是自己读到的那个就原样放回」。改名移开与放回之间，锁这个**名字是空的**；此刻任何一个走正常路径的进程只要 `createOnly` 建文件就会成功，而它根本不知道有人正在抢占。结果是两个进程都认为自己持有同一个会话的写权，而失败方还会顺手把前一个赢家的锁文件删掉。这条需要三个竞争者，产品里目前凑不齐（见「未经执行验证的声明」），但它是这个模块自己写在文件头注释里的那条不变式——「拒绝一个会话是可恢复的，同一个 JSONL 上有两个写者不可恢复」——的反例。
- **pid 复用。** 判陈旧只问「这个 pid 还在不在」。worker 被强杀留下锁之后，如果系统把这个 pid 分给了别的进程，这把锁就**永远**不再陈旧，会话从此打不开，报 `session already has a writer`，而机器上一个写者都没有。锁里其实记了 `acquiredAt`，但没有任何代码读它；界面上也没有任何「强制打开」的入口（全仓除 runtime 自己外没有 `session_locked` 的消费者）。

`runs.jsonl` 这一条是 T024 主动留给本任务的（对账表原话：「多 worker 并发轮转归 T031」）。核实结论：**轮转在进程内是串行的，跨进程完全没有协调**，而且判大小是 `stat` 盘上的真实字节，所以多个 worker 会在同一时刻各自得出「该轮转了」。两个 worker 前后脚各做一轮三次 `rename`，会把一整代 8 MiB 的 trace 提前挤掉，并在代号上留下空洞（`runs.1.jsonl` 缺失而 `runs.2/3` 有内容）。需要澄清的是**它在打包后的产品里不会发生**：全仓没有生产代码设置 `AICLIENT_RUNTIME_TRACE_DIR`。它发生在现场取证时——`evidence/p4-6` 的取证脚本正是先设这个环境变量再起应用，而 worker 无差别继承 `process.env`，于是那一天所有会话共用同一个 `runs.jsonl`。也就是说，这个缺陷只在「我们最需要 trace 可信」的那个场景里出现。

MCP 是并发面上唯一的**预算**问题，不是正确性问题：每会话最多 16 个服务器，容量最多 10 个会话，也就是最多 160 个常驻子进程，而分档注释里算的只有「一个 utilityProcess 加一份模型上下文」。另一半是回收：这些子进程是 `detached` 起的（自成进程组），干净 dispose 会挨个杀掉，但 worker 被强杀（Main 的 `forceKillNow`、dispose ACK 超时后的 kill、崩溃）时**没有任何人杀它们**，只能指望服务器自己认 stdin EOF 退出。

技能 / 子代理这一条比审计当时的描述更清楚：子代理定义已经做到每个顶层 run 重读（T020），技能目录则是 worker 启动时拍一次快照、全仓没有任何刷新触发端。多会话下的直接后果是**不同会话的技能菜单可以长期不一致**（编辑技能之前开的会话看不到新技能，之后开的看得到），这一点插件注释是诚实的，但「谁来触发」至今没人认领。另外，子代理定义的写盘是 `writeFile` 直接截断重写，读者是 N 个 worker 每个顶层 run 的全目录重扫——这两者撞上时，读到的是半截文档。

Main 这一侧没有发现并发正确性问题：创建 / 恢复 / 驱逐全在一条串行链上，容量检查与驱逐也在链内；`session-index.json` 是「临时文件 + rename」加进程内串行队列（其读路径的问题属 session-index 区域，本报告不重复）；scratch 与 temp 工作区每个会话一个 uuid 目录，不存在并发创建冲突。唯一的账面出入是导入 worker：它另起一个进程，但不计入容量。

## 优点

- **写锁的失败方向选对了。** `stale()` 只在「本机 + pid 确实不存在」时才判陈旧，跨机器一律不偷（`writerLock.ts:127`），读不出 owner 的（撕裂写）才当陈旧。文件头注释把这个取舍写明白了：拒绝可恢复，双写不可恢复。
- **释放按归属，不按路径。** `releaseWriterLock` 先读回文件比 token，不是自己的就原样留下（`writerLock.ts:236-239`）。这堵住了 session-05 那条「删掉别人的锁」的路。
- **抢占用原始字节而不是 token 比对。** 连撕裂、超长、无法解析的锁文件也有一个可比的身份（`writerLock.ts:101-113`），所以「我读到的那个」和「我移走的那个」是同一个判断口径。
- **两个进程抢一把陈旧锁的两种交织都有确定性用例**（`sessionWriterLock.test.ts:229-272`），其中一条用 `afterFirstRead` 钩子把对手完整塞进自己的读—判窗口里，这是可复制到第三方竞争者的现成手法。
- **trace 的大小从盘上 `stat`，不是进程内计数**（`trace.ts:238-240` 的注释点明了理由：文件比进程活得久）。这个选择本身是对的，它同时也是跨进程双重轮转成立的原因。
- **轮转与追加在同一条串行链里**（`trace.ts:206-209`），进程内不会出现「别人的 rename 落在我的大小检查和写入之间」。
- **MCP 连接阶段有一块共享秒表**（`mcp/index.ts:176-184`），一台慢服务器不会让整个阶段按人数累加；握手失败 / 超时都走同一个 catch，`client.close()` 会杀掉已经起来的子进程。
- **Main 的会话身份冲突检查是双向的**：创建路径拿到真实会话文件后回查 `entriesByKey`（`WorkerManager.ts:772-778`），恢复路径在建条目前查（`WorkerManager.ts:945-953`），两者都在同一条 `serialize` 链内。
- **worker 进程自带二次启动保护**：同一进程收到第二次不同 payload 的 `worker.bootstrap` 会被 `WORKER_ALREADY_BOOTSTRAPPED` 拒绝，同 payload 重发则命中缓存的结果（`nativeWorkerRuntime.ts:160-172`），不会二次开同一个会话文件。
- **bootstrap 失败路径按正确顺序收尾**：`session?.close()`（要用到 io）在 `io?.shutdown()` 之前（`bootstrap.ts:598-611`），所以半途失败不会把写锁留在盘上。

## 弱点

1. 抢占陈旧锁时锁名会短暂空缺，第三个申领者可以在这个窗口里正常建锁（concurrency-01）。
2. 陈旧判定只看 pid 在不在，pid 被复用后会话永久打不开，`acquiredAt` 写了没人读，界面无补救入口（concurrency-02）。
3. `runs.jsonl` 的轮转跨进程无协调，双重轮转丢一整代并留下代号空洞（concurrency-03）。
4. MCP 服务器数量只有每会话上限，没有全局上限，也没有进入内存分档的账（concurrency-04）。
5. worker 被强杀时 MCP 子进程无人回收，只能指望服务器自己认 stdin EOF（concurrency-05）。
6. 子代理定义文件非原子写，而读者是每个顶层 run 全目录重扫的 N 个 worker（concurrency-06）。
7. 「TUI 接管会话前必须没有正在跑的回合」这半条不变式只活在渲染层，Main 的 IPC 入口不复核（concurrency-07）。
8. `SkillsPlugin.refresh()` 全仓无生产调用方，多会话的技能快照只能靠各自重启对齐（concurrency-08）。
9. 导入 worker 另起一个进程但不计入 worker 容量（concurrency-09）。

## 节点判定

| 节点 | 判定 | 依据 |
|---|---|---|
| P3-1（JSONL 存储）| complete-with-gaps | 单写者在两进程视角下成立且有用例（T015）；剩下的是三方抢占窗口（concurrency-01）与 pid 复用导致的永久锁死（concurrency-02）。跨进程 trace 轮转（concurrency-03）按 T024 的移交口径也记在本节点。 |
| P3-3（旧会话兼容）| complete | 旧格式判定、头部升级与坏行剔除的原子重写都在已持有的写锁内完成（`store.ts:169-196`），legacy 迁移路径的陈旧锁清理也有用例（`sessionWriterLock.test.ts:159`）。并发面无残留。 |
| P5-1（skills / 模板）| complete-with-gaps | 目录扫描本身无跨进程写者，快照语义在注释里是诚实的；缺的是刷新触发端，导致多会话快照长期不一致（concurrency-08）。 |
| P5-3（MCP bridge）| complete-with-gaps | 连接预算、取消、关闭在单会话内是完整的；并发面缺全局进程预算（concurrency-04）与异常终止时的子进程回收（concurrency-05）。 |
| P4-0（同步平台 worker）| complete-with-gaps | 一会话一进程的假设在 Main 与 worker 两侧都有守卫，未发现同一会话被两个 worker 打开的路径；账面出入是导入 worker 不计容量（concurrency-09），以及强杀载体时后代进程无人收（concurrency-05 的 Windows 半边）。 |

## 发现

### [concurrency-01] medium concurrency | P3-1 | src/runtime/plugins/session/writerLock.ts:173 | 抢占陈旧锁时锁名短暂空缺，第三个申领者可在此窗口建锁，造成同一会话两个写者

DESC：`clearStale` 的做法是「把锁改名移到一边 → 读移走的那个 → 如果不是我读到的那个就用 `createOnly` 原样放回」。放回用的是 `createOnly`，也就是说**从 `rename` 成功到 `writeFile` 放回之间，锁这个名字在文件系统上是不存在的**。任何一个此刻走 `acquireWriterLock` 第 0 次尝试的进程都会直接建锁成功，它不会读、不会判陈旧，因为它压根没撞上 EEXIST。更糟的是放回失败（EEXIST，说明那个窗口里确实有人建了新锁）之后，代码会 `unlinkQuiet(aside)` 把手上这份别人的锁文件删掉——被删的正是那个还在写会话的进程的锁。此后它的 `releaseWriterLock` 会读到别人的 token、返回 `false`，而 `store.close()` 丢弃这个返回值（`store.ts:588`），没有任何日志或事件说明「我的锁被别人拿走了」。T015 修的是两个进程的交织，这条是三个。

EVIDENCE：

```ts
// src/runtime/plugins/session/writerLock.ts:164-180
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await io.rename(lock, aside);          // ← 从这里开始，lock 这个名字是空的
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { cleared: true };
    throw error;
  }
  const moved = await readLock(io, aside);
  if (moved !== undefined && !moved.bytes.equals(expected)) {
    await io.writeFile(lock, moved.bytes, { createOnly: true, mode: 0o600 }).catch((error) => {
      if (errorCode(error) !== 'EEXIST') throw error;   // ← 窗口里有人建了锁，静默吃掉
    });
    await unlinkQuiet(io, aside);                        // ← 把别人的锁文件删掉
    return moved.owner === undefined ? { cleared: false } : { cleared: false, owner: moved.owner };
  }
```

```ts
// src/runtime/plugins/session/writerLock.ts:205-211（第 0 次尝试不判陈旧，直接建）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await io.writeFile(path, claim, { createOnly: true, mode: 0o600 });
      return { path, token };
```

SCENARIO：盘上有一把陈旧锁 L0（上一次 worker 被强杀留下）。进程 P1、P2 同时打开这个会话，都读到 L0 并判为陈旧。P1 先完成整套抢占，建出自己的锁 L1 并开始写会话。P2 随后把 L1 改名移到一边——此刻锁名为空——进程 P3 在这一瞬打开同一个会话，第 0 次尝试直接建锁成功。P2 的放回撞上 EEXIST 被静默吃掉，随后把 L1 删掉并报告自己输了。最终盘上只剩 P3 的锁，而 **P1 和 P3 同时在往同一个 JSONL 追加**：两条各自从自己读到的 leaf 出发的分支交织进同一个文件，条目的 `parentId` / `seq` 互相矛盾，下次打开时解码器只能按单链还原，另一条的内容被丢进不可达分支。

FIX：给抢占本身加一把二级互斥——抢占前先 `createOnly` 建 `<lock>.takeover` 哨兵，成功者才执行改名—判定—重建，失败者直接当作「输掉竞争」重试正常路径；抢占结束（无论输赢）删掉哨兵，哨兵自身也按 pid 判陈旧。这样锁名空缺的窗口里不会有第二个抢占者，而普通申领者在窗口里建出的锁会在抢占者重建前被发现（放回改为：EEXIST 时不删 `aside`，把 `aside` 保留并把这次抢占判为失败，让下一轮重新读盘决定）。附带把 `releaseWriterLock` 返回 `false` 接到日志与 `writeFailure` 一类的可观测出口上，让「锁被别人接管」不再无声。

### [concurrency-02] medium robustness | P3-1 | src/runtime/plugins/session/writerLock.ts:128 | pid 被复用后陈旧锁永远判不成陈旧，会话永久打不开且界面无补救入口

DESC：`stale()` 的全部判据是「这个 pid 现在还存在吗」。worker 被 SIGKILL（Main 的 `forceKillNow`、dispose ACK 超时后的强杀、进程崩溃）会留下锁文件；操作系统之后把这个 pid 号分配给任意别的进程，这把锁就再也不会被判为陈旧，`acquireWriterLock` 每次都抛 `session_locked`。锁里其实写了 `acquiredAt`（`writerLock.ts:201`），`WriterLockOwner` 也声明了这个字段，但全模块没有任何地方读它。全仓（除 runtime 自身）没有 `session_locked` 的消费者，Main 与渲染层都没有「强制打开 / 清理锁」的入口，用户只能手工删 `<session>.jsonl.writer.lock`——而这个文件在 userData 深处，产品从不提它。Windows 的 pid 回绕比 Linux 快得多，这条在现场机器上的概率高于开发机（属静态推断，需上机确认）。

EVIDENCE：

```ts
// src/runtime/plugins/session/writerLock.ts:124-129
function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}
```

```ts
// src/runtime/plugins/session/writerLock.ts:24-31（acquiredAt 记了，但无人读）
export interface WriterLockOwner {
  pid: number;
  host?: string;
  token: string;
  acquiredAt?: number;
}
```

SCENARIO：用户在一次会话跑到一半时强制退出应用（或应用崩溃），worker 来不及跑 dispose，锁文件留在盘上，记着 pid 4711。用户继续用机器、几小时后重启应用，此时系统的 pid 已经回绕并把 4711 分给了别的程序（浏览器标签进程、编辑器的语言服务器都行）。用户点开那条聊天：worker 起来 → `acquireWriterLock` → EEXIST → 读到 owner 4711 → `processAlive` 为真 → 判定「有活写者」→ 抛 `session_locked: session already has a writer: …（pid 4711 on …）`。这条聊天从此**每次打开都失败**，界面上只有一个 bootstrap 失败，没有任何可点的恢复动作。

FIX：把「pid 还在」收窄成「pid 还在**且它就是我们的 worker**」：在锁里额外记一个可交叉验证的身份（Linux / macOS 可用 `/proc/<pid>` 或进程启动时间，跨平台的最小版本是记一个应用实例 id + 启动时间戳），或者退一步用 `acquiredAt`：超过一个明显安全的年龄（例如 24 小时）且本应用本次启动从未持有过它，就允许接管。再加一条产品侧兜底——`session_locked` 在 Main 冒泡时给用户一个「这个会话被另一个窗口占用；仍要打开？」的显式动作，把不可恢复变成可恢复。

### [concurrency-03] medium concurrency | P3-1 | src/runtime/trace.ts:258 | 多个 worker 共用一个 traceDir 时会双重轮转，提前丢掉一整代 trace 并在代号上留空洞

DESC：轮转判据是 `stat` 盘上的真实大小（这个选择本身是对的，文件比进程活得久），执行是三次 `rename`。进程内轮转与追加在同一条 `pending` 链上，注释也只声称到进程内为止。跨进程完全没有协调：N 个 worker 同时追加同一个 `runs.jsonl`，在它接近上限时会**各自**得出「该轮转了」，然后各做一轮完整的三次改名。第二轮改名会把第一轮刚刚上移的代再上移一次：本该再保留一个周期的那一代被直接覆盖，同时 `runs.1.jsonl` 变成空缺（源文件已经不在了，`move` 把 ENOENT 当正常状态跳过）。T024 的对账表已把这条明确移交本任务（原文：「多 worker 并发轮转归 T031」）。**产品打包态不受影响**：全仓没有生产代码设置 `AICLIENT_RUNTIME_TRACE_DIR`；受影响的恰恰是现场取证——取证脚本先设这个变量再起应用，而 `buildPiWorkerEnvironment` 把 `process.env` 整个继承给每个 worker（`PiWorkerProcess.ts:53-56`），于是当天所有会话共用同一个 `runs.jsonl`。

EVIDENCE：

```ts
// src/runtime/trace.ts:256-262
      // Oldest first, so nothing is overwritten before it has been shifted up.
      // `rename` replaces the destination, which is what retires generation N.
      for (let index = this.fileGenerations; index >= 1; index--) {
        const from = index === 1 ? path : join(dir, `runs.${index - 1}.jsonl`);
        await this.move(from, join(dir, `runs.${index}.jsonl`));
      }
```

```ts
// src/runtime/trace.ts:206-210（串行保证只到进程内）
    const work = this.pending.then(async () => {
      // Rotation runs inside the same serialized chain as the append, so a
      // rename can never land between another run's size check and its write.
      const rotation = await this.rotate(dir, path, line.byteLength);
      await this.io.appendFile(path, line, { mode: 0o600 });
```

SCENARIO：现场取证按 `evidence/p4-6` 的脚本设好 `AICLIENT_RUNTIME_TRACE_DIR` 后起应用，同时开三个会话跑任务。`runs.jsonl` 涨到 8 MiB 附近，会话 A 与会话 B 的 worker 在同一秒各自结束一个 run：两边 `stat` 都得到 8 MiB+，都进入轮转。A 做完 `runs.2→runs.3`、`runs.1→runs.2`、`runs→runs.1`；B 紧接着又做一遍，把 A 刚放到 `runs.2` 的那一代（原 `runs.1`）直接盖掉 `runs.3`，把 A 刚放到 `runs.1` 的满文件移到 `runs.2`，而 `runs→runs.1` 因为源文件已不存在被跳过。结果：磁盘上 `runs.1.jsonl` 缺失、原来的第三代被提前销毁，取证时按代号顺序拼时间线的人会得到一段**看不出缺口的**缺失历史。另一条次生形态：A 的 `appendFile` 正好落在 B 的 `rename` 之后，这一行会写进一个刚刚被改名的文件，最新的 run 出现在 `runs.1.jsonl` 里而不是 `runs.jsonl`。

FIX：既然 traceDir 是可以被多个进程共享的，就让文件名自带进程身份：落盘路径改为 `runs.<pid>.jsonl`（或 `runs-<sessionId>.jsonl`），轮转与上限按每个文件独立算，读者按 glob 收集。这样既不需要跨进程锁，又保住「一个 run 一行、不丢行」的语义。如果一定要共享一个文件，则轮转前必须先拿一把 `createOnly` 的 `<dir>/runs.rotate.lock`（拿不到就跳过这次轮转，直接追加），并在拿到锁后**重新 `stat`** 确认仍然超限。

### [concurrency-04] medium capacity | P5-3 | src/runtime/plugins/mcp/config.ts:227 | MCP 服务器数量只有每会话上限，没有全局预算，也没有进入 worker 内存分档的账

DESC：`MAX_SERVERS = 16` 是**每个会话**的上限，而每个会话是一个独立 worker 进程，各自完整地拉起自己那一套服务器。会话容量按内存分档（≤4 GiB 三个、≤8 GiB 六个、其余十个），分档注释把一个 slot 算作「一整个 utilityProcess 加一份模型上下文」，没有把它可能带起来的最多 16 个常驻子进程算进去。上限相乘就是最多 160 个常驻子进程；每个还各带三条管道（stdout / stderr / stdin），在 4 GiB 的机器上是 3 × 16 = 48 个。没有任何一处对「这台机器上一共起了多少 MCP 子进程」有认识，也没有共享池——同一个服务器配置在 N 个会话里就是 N 份进程。

EVIDENCE：

```ts
// src/runtime/plugins/mcp/config.ts:227-235
  if (servers.length > MAX_SERVERS) {
    const dropped = servers.slice(MAX_SERVERS).map((item) => item.name);
    …
  }
  return { servers: servers.slice(0, MAX_SERVERS), diagnostics };
```

```ts
// src/main/services/agent-host/WorkerManager.ts:316-325
 * The memory tiers are kept, and are the reason the top number is not applied
 * everywhere: a slot is a whole utilityProcess plus one model context, so on a
 * 4 GiB machine ten of them would not be ten working conversations, it would be
 * ten that swap.
 */
export function resolveDefaultWorkerCapacity(totalMemoryBytes = os.totalmem()): number {
  if (totalMemoryBytes <= 4 * 1024 ** 3) return 3;
```

SCENARIO：用户在 `~/.pi/mcp.json` 里配了 8 个 MCP 服务器（浏览器、数据库、文件检索各一套是常见组合），在一台 16 GiB 的机器上开到 8 个会话。应用这时持有 8 个 worker 进程 + 64 个 MCP 子进程；每个会话启动还要为它们各跑一次 45 秒预算内的握手。用户看到的是「开第五个会话之后整台机器开始卡」，而应用的容量分档告诉它这台机器可以开十个。

FIX：把预算从「每会话」提到「每应用」：Main 在下发 MCP 配置时带一个全局余额（例如 `maxServersTotal`），worker 侧按余额截断并把被截断的服务器写进 `diagnostics`（复用现有的超限诊断文案）；或者按会话数动态收缩每会话上限（`min(MAX_SERVERS, floor(total/capacity))`）。同时把「一个 slot ≈ 1 个 utilityProcess + 模型上下文 + 最多 K 个 MCP 子进程」写进 `resolveDefaultWorkerCapacity` 的分档注释，让这条账以后改动时不会再被漏算。

### [concurrency-05] medium robustness | P5-3 | src/runtime/host/exec.ts:171 | worker 被强杀时 MCP 子进程不随之退出，回收只能指望服务器自己认 stdin EOF

DESC：长驻子进程在非 Windows 上以 `detached: true` 启动，也就是自成进程组、不随父进程终止。干净 dispose 的路径是完整的：`runtimeExec.shutdown()` 会杀掉所有登记过的子进程，`McpPlugin.close()` 再兜一次。但 worker 并不总是干净退出——Main 在 dispose ACK 超过 3 秒后会直接杀进程（`WorkerSlot.ts:93` 的 `DEFAULT_DISPOSE_TIMEOUT_MS = 3_000` 与 `finalizeDisposed` 的 `killCurrentTransport`），`forceKillNow()` 在导入失败路径上也会直接杀，崩溃更不必说。这些情况下 MCP 子进程**没有任何人杀它**，唯一的退出机制是它自己发现 stdin 到了 EOF。Windows 上更长一截：MCP 服务器是经 `node.exe` 运行器起的孙进程，`taskkill /T` 只在 exec 层自己的 kill 路径里跑，载体被杀时不会执行。

EVIDENCE：

```ts
// src/runtime/host/exec.ts:163-173（spawnPersistent，MCP 服务器走这条）
    const child = spawn(
      nodePath ?? request.command,
      nodePath ? [execRunnerPath()] : [...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
```

```ts
// src/main/services/agent-host/WorkerSlot.ts:603-605（ACK 超时后无条件杀）
    const exitPromise = this.waitForTransportExit(transport, generation);
    this.detachCurrentTransport();
    this.killCurrentTransport();
```

SCENARIO：会话空闲 15 分钟被 `reclaimIdle` 驱逐，worker 在 dispose 时正卡在一次慢 MCP 调用上（单次调用预算与 bash 同级，远大于 3 秒），3 秒 ACK 预算耗尽，Main 杀掉 worker 进程。worker 的 `ctx.effect` 清理没跑完，它拉起的 MCP 服务器进程组还在。一个不理会 stdin EOF 的服务器（自带 HTTP 端口的、或 Python 写的轮询式服务器）就此常驻，端口与内存不释放；用户重开这个会话又拉起一套。重复几次之后端口冲突或内存告急，而任务管理器里看到的是一堆没有父进程的 node / python。**静态推断**：需要 Windows 与 utility 载体上机才能确认残留形态与服务器的 EOF 行为。

FIX：两头都补。worker 侧：非 Windows 用 `process.kill(-pid)` 的路径已经有了（`createTreeKiller`），缺的是「父进程非正常退出时谁来调用」——可以在 exec 层为长驻子进程登记一个进程组清单文件，或改用 `detached: false` 让它们随父进程的会话终止（代价是失去进程组整杀，需要与现有 killTree 逻辑一起权衡）。Main 侧：`WorkerSlot` 杀进程时在 Windows 上走 `taskkill /PID <worker> /T /F` 而不是普通 kill，把整棵树一起收掉；在 POSIX 上对 worker 也用进程组杀（注意 `kill(-pid)` 必须有真实 pid，测试里要 mock，见记忆条目「测试里 kill(-1) 灭掉整个会话」）。

### [concurrency-06] medium concurrency | P5-2-1 | src/main/services/agent-host/subagentCatalog.ts:236 | 子代理定义文件是截断式写入，而读者是每个顶层 run 全目录重扫的 N 个 worker，撞上就读到半截文档

DESC：T020 之后，每个顶层 run 开始前都会 `subagents.refresh()` 重读整个定义目录（`agent-loop/index.ts:244`），这是「编辑完下一轮就生效」这条承诺的实现。写的一侧是 Main 的设置页：`writeFile(this.pathFor(name), document, 'utf8')`，也就是**先截断、再写**，没有临时文件 + rename。两侧共用一个目录，而读者有 N 个（每个会话一个 worker 进程），读的时机是不受控的。读到空文件或半截 frontmatter 时，解析器产出诊断、这条定义从目录里消失；`refresh()` 只有在 reload **抛错**时才保留旧列表，返回一份缺人的目录是照单全收的。同一条文件的写入还有一个更长的窗口：改名保存是「先写新文件、再删旧文件」，两者之间读到的是两条同内容不同名的定义。

EVIDENCE：

```ts
// src/main/services/agent-host/subagentCatalog.ts:235-236
    await mkdir(this.directory(), { recursive: true });
    await writeFile(this.pathFor(name), document, 'utf8');
```

```ts
// src/runtime/plugins/subagent/index.ts:409-425（读到缺人的目录会照单全收）
  async refresh(): Promise<void> {
    const reload = this.config.reloadCatalog;
    if (!reload) return;
    let catalog: SubagentCatalog;
    try {
      catalog = await reload();
    } catch (error) {
      this.config.log?.('[subagent] catalog reload failed', error);
      return;
    }
    this.activeDefinitions = applySubagentActivation(…).definitions;
```

SCENARIO：用户同时开着三个会话，在设置页里编辑子代理「researcher」的描述后点保存。保存的那一刻，会话 B 正好开始新一轮：它的 `refresh()` 扫到 `researcher.md` 时文件已被截断成 0 字节 → 解析产出一条诊断 → 这一轮的 `Task` 工具枚举里没有 `researcher`。模型这一轮如果按之前的菜单去委派，拿到的是「unknown subagent」加一串诊断文本；用户看到的是「我刚保存完它就不见了」，而下一轮它又回来了——一个无法复现的幽灵。

FIX：定义写盘改成与 `SessionIndexService.writeJsonAtomically` 同款的「写 `<name>.<uuid>.tmp` + `rename`」（同目录内 rename 在 POSIX 与 Windows 上都是原子替换），改名保存也用同一手法把「写新 + 删旧」压成两次原子操作。读的一侧加一条便宜的兜底：`applySubagentActivation` 之后如果新目录比旧目录**少了**条目且本次扫描带着解析类诊断，就保留旧列表并记一条日志——把「文件正在被写」和「用户真的删了一个定义」区分开。

### [concurrency-07] low contract-gap | H/20 | src/main/ipc/piTui.ts:114 | 「TUI 接管会话前不能有正在跑的回合」只由渲染层把关，Main 的 IPC 入口不复核

DESC：跨进程单写者在 GUI → TUI 这个方向上是**靠顺序保证的**，不是靠写锁：`pi --session` 这个 CLI 进程从不碰 `writer.lock`，Main 只有一个进程内的 `PiTuiExclusiveGuard`，而它的 `transferTo` 按设计是「永远转移、从不测试后设置」。反方向（GUI 要写时）Main 有硬门：`handOverFromTui` 先杀终端、再 `assertHostPromptAllowed`、必要时重读磁盘（`ipc/chat.ts:137-145`）。正方向（TUI 要接管时）Main 的 `PI_TUI_OPEN` 只做了「CLI 能不能解析这个文件」的检查，**没有**问过 `WorkerManager` 这个会话有没有正在跑的回合。唯一拦住它的是渲染层的 `isSessionBusy`（`usePresentationSwitch.ts:86`）。这在当前产品里是够用的（单一入口、单一按钮），但它把一条数据完整性的不变式放在了信任边界的外侧：任何第二个调用方——另一个窗口、将来的快捷键 / 菜单项、一次重放的 IPC——都能绕过它。

EVIDENCE：

```ts
// src/main/ipc/piTui.ts:122-136
    if (request.sessionFile) {
      const support = await inspectPiTuiSessionSupport(request.sessionFile);
      if (!support.supported) throw new Error(support.reason);
      // Always transfer, never test-and-set: see PiTuiExclusiveGuard.transferTo
      const acquired = sessionGuard.transferTo(request.sessionFile);
      if (!acquired.ok) throw new Error(acquired.reason);
      tuiWrittenSessions.add(normalizeSessionKey(request.sessionFile));
    }
    return controller.open(request);
```

```ts
// src/renderer/components/chat/usePresentationSwitch.ts:76-95（唯一的 busy 门在渲染层）
    if (isSessionBusy(liveStatus ?? 'idle')) {
      addToast({ type: 'warning', title: 'Wait for this turn to finish', … });
      return;
    }
```

SCENARIO：任何绕开 `usePresentationSwitch.openTui` 的 `PI_TUI_OPEN` 调用（第二个窗口、将来加的命令面板项、开发者在 devtools 里直接调 `window.electronAPI.piTui.open`）在一个回合正在跑时把终端开在同一个会话文件上：worker 还在按自己内存里的 leaf 追加条目，CLI 从它读到的那一版开始写自己的条目，两条分支交织进同一个 JSONL，且写锁完全看不见这件事（CLI 不取锁）。

FIX：把这条判断挪到 Main：`PI_TUI_OPEN` 在 `transferTo` 之前先问 `WorkerManager`「这个会话文件现在有没有活跃请求」（`entriesByKey` + `activeRequestId` 已经在手边），有就拒绝并返回与渲染层同一条文案的错误码；渲染层那道门保留为「不弹无谓的错误」的体验层，而不是唯一的正确性保证。

### [concurrency-08] low dead-code | P5-1 | src/runtime/plugins/skills/index.ts:363 | `SkillsPlugin.refresh()` 全仓无生产调用方，多会话的技能快照只能靠各自重启对齐

DESC：技能目录是 worker 启动时的一次性快照，插件接口为此提供了 `refresh()`，注释也诚实地写明「本插件不会自动调用它，触发端属于谁去做那个动作的人」（`index.ts:85-90`）。核实结果：全仓 `runtimeSkills` 的消费者只有 `prompt/index.ts:69` 的 `segment()`，`refresh()` 除测试外零调用；Main 侧既没有 IPC，也没有 UI 动作。T019 的落地记录写的是「触发端归 T020 / UI」，而 T020 只落了子代理的按 run 重读。并发面的后果是快照在多会话之间会长期分叉：编辑技能之前开的会话与之后开的会话，在整个应用生命周期里都会向模型宣告不同的技能列表，而两者写的是同一个会话历史格式，事后从 trace 的 `skills=<n>` 版本戳上看是两个不同的配置。

EVIDENCE：

```ts
// src/runtime/plugins/skills/index.ts:363-377
  async refresh(): Promise<void> {
    const source = skillSource(this.ctx.runtimeHostIo, MAX_SCAN_BYTES);
    const [skills, templates] = await Promise.all([
      loadSkills(source, this.catalog.resolvedSkillRoots),
      loadPromptTemplates(source, this.catalog.resolvedTemplateRoots),
    ]);
```

```
$ grep -rn 'runtimeSkills' src/ --include=*.ts | grep -v 'plugins/skills' | grep -v __tests__
src/runtime/plugins/prompt/index.ts:69:    const skills = this.ctx.get('runtimeSkills')?.segment();
```

SCENARIO：用户装了一个新技能（往 `~/.pi/skills/` 拷一个目录），此时应用里开着三个会话。三个会话在本次应用生命周期内都看不到这个技能——模型不会提它、`/skill:name` 展开不了；新开第四个会话则看得到。用户的心智模型是「技能是全局的」，实际得到的是「按会话打开时间分代」。

FIX：二选一，都要落到文档上。要么接触发端：加一个 worker RPC（`worker.skills.refresh`）并挂在与子代理定义相同的时机（每个顶层 run 之前，或设置页保存技能后由 Main 广播给全部 worker）；要么保留快照语义但明确它，在设置页 / 技能列表处写明「新装的技能在新会话里生效」，并删掉这个没有触发端的 `refresh()`（连同 `resolvedSkillRoots` 这个只为它保留的字段）。

### [concurrency-09] low capacity | P4-0 | src/main/services/legacyImport/PiImportProcess.ts:34 | 导入 worker 另起一个进程，但不计入 worker 容量

DESC：容量检查数的是 `entriesBySession.size`，而导入用的 worker 完全不进这两张表：`inspectPiImport` / `reconcilePiImport` / `createPiImport` 各自直接 `forkPiWorkerProcess` 并自建一个 `WorkerSlot`，只由 `importSlotActive` 这个布尔保证同时只有一个。也就是说进程峰值是 `capacity + 1`。在 ≤4 GiB 分档（容量 3）的机器上这是 33% 的超额，而分档注释的措辞是「十个 slot 不是十个能用的会话，是十个互相换页的会话」——说明这个数就是按内存卡出来的。导入 worker 同样继承 `process.env`，所以在设了 trace 目录的现场场景里它也是 `runs.jsonl` 的第 N+1 个写者（见 concurrency-03）。

EVIDENCE：

```ts
// src/main/services/legacyImport/PiImportProcess.ts:33-42
  const { transport } = forkPiWorkerProcess({ generation, cwd: payload.workspacePath });
  const slot = new WorkerSlot({
    slotKey: `import-inspect:${payload.logicalSessionId}`,
    …
  });
```

```ts
// src/main/services/agent-host/WorkerManager.ts:707-716（容量只数会话条目）
      if (this.entriesBySession.size >= this.capacity) {
        const victim = this.selectEvictionCandidate();
```

SCENARIO：3.3 GiB 的机器（容量 3），用户开满三个会话，其中两个刚跑完长回合、上下文都在内存里；这时他去设置页导入一段旧对话。第四个 worker 进程起来，带着自己的一整套插件图与 Node 堆。内存压力下系统开始换页，正在跑的会话变慢或被 OOM killer 挑中——而应用自己认为它一直在容量以内。

FIX：让导入走同一本账：导入前先 `reclaimIdleInternal()` 并在 `entriesBySession.size >= capacity` 时驱逐一个候选（或直接复用一个空闲 slot 跑导入 RPC，导入 RPC 本来就不需要一个绑定会话的 worker）；至少把导入槽计入 `stats()` 报的 `slots`，让「现在有几个 worker 进程」这个数字是真的。

## 测试缺口

下面每条都是可在开发机上确定性复现的用例（不需要 Electron、不需要真实模型），按建议落点分组。

1. `src/runtime/__tests__/sessionWriterLock.test.ts` — **「抢占的放回窗口里不允许第三方建锁」**。用已有的 `afterFirstRead` 同款钩子包一层 io，在 `clearStale` 的 `rename` 成功之后、`writeFile` 放回之前注入第三个 `acquireWriterLock`。断言：三次调用中至多一次 fulfilled；盘上锁文件的 token 等于唯一 fulfilled 的那个；目录里没有 `.stale` 残留。（当前实现会有两个 fulfilled。）
2. 同文件 — **「输掉抢占的一方不得删除赢家的锁文件」**。断言 `clearStale` 放回撞 EEXIST 之后，赢家的锁文件仍然存在（内容与赢家 token 一致）。
3. 同文件 — **「pid 被复用的陈旧锁仍可接管」**。写一把 owner 为 `process.pid`（活着，但不是我们的 worker）且 `acquiredAt` 为 48 小时前的锁，断言 `acquireWriterLock` 成功接管而不是永久 `session_locked`。（该用例先于 concurrency-02 的修法落地会红。）
4. 同文件 — **「释放时发现锁已易主要能被观测到」**。断言 `releaseWriterLock` 返回 `false` 的那一次，`JsonlSessionStore.close()` 之后 `writeFailure`（或新增的观测出口）非空。
5. `src/runtime/__tests__/trace.test.ts` — **「两个 TracePlugin 实例共用一个目录轮转时不丢代」**。同一个 `dir` 建两个实例（`maxFileBytes` 调到几百字节），交错 `finish()` 直到触发轮转，断言 `runs.1/2/3.jsonl` 在存在的代号上连续无空洞，且三代文件里的 `run_id` 集合包含所有应保留的 run。
6. 同文件 — **「轮转期间另一实例的追加不丢行」**。两个实例交错写 N 行，断言 `runs*.jsonl` 全部文件里 `run_id` 的并集大小为 N（当前可能出现最新行落在 `runs.1.jsonl` 的错位，若采纳 per-pid 文件方案则此用例改为断言两个文件各自守恒）。
7. `src/main/services/agent-host/__tests__/subagentCatalog.test.ts` — **「保存定义时并发读只会看到旧文档或新文档」**。保存过程中并发跑一次目录扫描 + 解析，断言解析结果要么是旧定义、要么是新定义，不会是「该定义缺席」。
8. `src/runtime/__tests__/subagentDefinitions.test.ts` — **「重载读到缺人的目录时保留旧列表」**。让 `reloadCatalog` 返回一份少了一个定义且带解析类诊断的目录，断言 `definitions` 不变且记了日志（配合 concurrency-06 的读侧兜底）。
9. `src/main/services/agent-host/__tests__/WorkerManager.test.ts` — **「导入槽计入容量」**。容量设为 1，已有一个就绪会话时发起 `inspectLegacyImport`，断言要么先驱逐、要么拒绝，总之同一时刻不存在两个 fork 出来的进程（当前会有两个）。
10. `src/main/ipc/__tests__/`（TUI 路由）— **「回合进行中 Main 拒绝 TUI 接管」**。构造一个 `activeRequestId` 非空的会话，直接调 `PI_TUI_OPEN` 处理函数，断言抛错且 `sessionGuard` 未易主（当前会成功接管）。
11. `src/runtime/__tests__/mcp.test.ts` — **「exec 关停会杀掉 MCP 子进程」**（正向已隐含）与其反面 **「载体被强杀时子进程不受进程组保护」**：用一个忽略 stdin EOF 的替身服务器脚本，断言 `detached` 下父进程退出后替身仍存活——把 concurrency-05 的前提用替身固化下来，真机形态留给批次 E。

## 未经执行验证的声明

- **concurrency-01 在产品里的可达性没有构造出来。** 模块级窗口是确定的，但要凑齐三个同时抢同一个会话文件的进程，需要绕过 `WorkerManager.entriesByKey`（同一 Main 内一个会话文件只有一个 worker）与 `app.requestSingleInstanceLock()`（第二个应用实例起不来）。我未能构造出一条产品路径；这条按「模块契约的反例 + 未来第二个取锁方（CLI、外部工具、多实例开发构建）出现时立即成立」来读。
- **多个 worker 同时 `appendFile` 同一个 `runs.jsonl` 会不会写出半行**：`O_APPEND` 下对常规文件的单次 `write` 通常是原子的，只有当 Node 的写循环遇到短写并拆成多次系统调用时才可能交织。机制成立，我没有实测样本，也没有量出典型 trace 行的大小分布，因此没有立成发现。
- **加密机上 `.writer.lock` 是否会成为 TSD 容器**：如果会，`readLock` 走的是 `io.readFile`，它对 TSD 头有分支，会转去拉 helper 子进程（单次预算 30 秒）；一次陈旧接管要读两次锁（锁本体 + 移走的那个），最坏 60 秒，正好等于 Main 的 `BOOTSTRAP_REQUEST_TIMEOUT_MS`。策略文件覆盖哪些目录无法静态判定，故只进上机检查单。
- **MCP 服务器在 worker 被杀后是否真的退出**取决于每个服务器自己认不认 stdin EOF；我没有实测任何真实服务器的行为，concurrency-05 的后果段按「不认 EOF 的服务器存在」写。
- **多窗口下渲染层的 `isSessionBusy` 是否在所有窗口都能看到「运行中」**：我没有核对 `SharedSessionState` 的广播范围，因此 concurrency-07 的场景没有写成「第二个窗口一定能触发」，只写成「任何绕过该调用点的入口」。
- **Windows pid 回绕的实际速度**与 concurrency-02 的现场概率没有量化，只标了方向。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| 加密目录下写锁的取 / 读 / 接管是否可用，代价多少 | `.writer.lock` 在盘上是不是 TSD 容器；正常打开会话的耗时；人为留一把陈旧锁后接管是否在 60 秒 bootstrap 预算内完成 | 在受策略目录下开一个会话，`Get-Content -Encoding Byte -TotalCount 16` 看锁文件头是否为 `%TSD-Header-###%`；再手写一把 pid 不存在的锁，重开会话并计时 | encrypted |
| worker 被强杀后 MCP 子进程是否残留 | 杀掉 worker 进程后，它拉起的 MCP 服务器进程是否在 10 秒内消失 | 配一个真实 stdio MCP 服务器，开会话待其就绪，记下子进程 pid，然后 `taskkill /PID <worker> /F`（Windows）或 `kill -9`（Linux），10 秒后查 pid | windows |
| 同一场景下 Windows 的 node 运行器孙进程 | `node.exe`（exec 运行器）与它下面的 MCP 进程是否都消失 | 同上，用 `wmic process where ParentProcessId=<worker>` 逐层看 | windows |
| 三个会话并发时的真实进程数与内存 | 进程数 = 3 个 worker + 每会话 MCP 数；常驻内存是否仍在机器可承受范围 | 起 Electron，开三个会话各跑一轮，`ps -o pid,rss,comm --ppid` / 任务管理器截图 | utility |
| 现场取证时的 `runs.jsonl` 代号完整性 | 设 `AICLIENT_RUNTIME_TRACE_DIR` 后开 3 个会话跑到至少两次轮转，检查 `runs.1/2/3.jsonl` 是否连续无空洞、行数是否守恒 | 按 `evidence/p4-6` 的脚本设变量起应用，跑完后 `wc -l runs*.jsonl` 并比对 `run_id` 并集 | utility |
| 导入时的进程峰值 | 在容量 3 的机器上开满 3 个会话后发起旧对话导入，是否出现第 4 个 worker 进程 | 起 Electron，导入前后各数一次 worker 进程 | utility |
| 回合进行中切 TUI 的实际行为 | 点终端按钮是否只弹「等这一轮结束」提示、且 `writer.lock` 与会话文件均未被第二个进程触碰 | 起 Electron，发一条长回合，回合中点 TUI 切换；随后 `ls -la` 会话目录看有无新写者痕迹 | real-model |
| 会话被强杀后 pid 复用的实际形态 | 强杀应用后留下的锁，重启应用能否打开该会话 | 现场机器上强制结束应用进程，记下锁里的 pid，等待或制造 pid 回绕后重开该会话 | windows |

## 读过的文件

- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md`（第二、五、八节）
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md`
- `docs/plantree/plans/runtime-hardening/roadmap.md`
- `docs/plantree/plans/runtime-evolution/README.md`（节点表）
- `docs/plantree/plans/runtime-hardening/evidence/batch-d-raw/session-index.md`（避免与同批区域重复）
- `src/runtime/plugins/session/writerLock.ts`
- `src/runtime/plugins/session/store.ts`
- `src/runtime/plugins/session/index.ts`（目录清点）
- `src/runtime/trace.ts`
- `src/runtime/host/io.ts`
- `src/runtime/host/exec.ts`
- `src/runtime/bootstrap.ts`
- `src/runtime/flags.ts`
- `src/runtime/plugins/mcp/index.ts`
- `src/runtime/plugins/mcp/config.ts`（MAX_SERVERS 段）
- `src/runtime/plugins/mcp/client.ts`（close / kill 段）
- `src/runtime/plugins/skills/index.ts`
- `src/runtime/plugins/subagent/index.ts`（refresh / refreshTaskTool 段）
- `src/runtime/plugins/subagent/run.ts`（trace 关系）
- `src/runtime/plugins/agent-loop/index.ts`（run 起点段）
- `src/runtime/worker/nativeWorkerRuntime.ts`（bootstrap 幂等段）
- `src/runtime/worker/nativeUtility.ts`（traceDir 段）
- `src/runtime/__tests__/sessionWriterLock.test.ts`
- `src/runtime/__tests__/trace.test.ts`
- `src/agent-host/piWorkerRpcServer.ts`（bootstrap / import 段）
- `src/main/services/agent-host/WorkerManager.ts`
- `src/main/services/agent-host/WorkerSlot.ts`（dispose / finalizeDisposed 段）
- `src/main/services/agent-host/PiWorkerProcess.ts`
- `src/main/services/agent-host/PiUtilityService.ts`（fork 段）
- `src/main/services/agent-host/piCliLayout.ts`
- `src/main/services/agent-host/ScratchWorkspaceService.ts`
- `src/main/services/agent-host/TempWorkspaceService.ts`
- `src/main/services/agent-host/subagentCatalog.ts`（save 段）
- `src/main/services/chat/SessionIndexService.ts`
- `src/main/services/legacyImport/PiImportProcess.ts`
- `src/main/services/terminal/piTuiSession.ts`
- `src/main/ipc/piTui.ts`
- `src/main/ipc/chat.ts`（handOverFromTui 段）
- `src/main/index.ts`（单实例锁段）
- `src/renderer/components/chat/usePresentationSwitch.ts`
- `src/renderer/components/chat/ChatWorkspace.tsx`（TUI 挂载段）
- `src/renderer/hooks/useXterm.ts`（piTui.open 调用段）
