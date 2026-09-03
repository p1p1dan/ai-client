# T37-d 会话变砖缺陷修复 — 2026-09-02

**Role**：evidence · **Status**：accepted
**Related**：[roadmap T37](../roadmap.md#t37--pi-only-release-gates--in-progress) · [T37-c evidence](./2026-09-02-t37c-gui-packaged.md) · [D15](../decisions/015-main-owned-worker-manager.md) · [D17](../decisions/017-worker-pool-policy.md)

## 结论

T37-c 报出但没修的那个缺陷已经修完并实测。查下来它比原来记录的范围**大得多**：
不是"崩溃正好落在约 1 秒窗口里"的小概率事件，而是**任何一个还没拿到模型第一条回复的会话，
都会在索引里留下一行永久损坏的记录**。用户 Stop、退出应用、模型报错都能触发，不需要崩溃。

本机实测数据：修复前 `session-index.json` 里 **54 行有 runtimeIdentity，其中 5 行（9%）指向从未存在过的文件**。
这 5 行全部是 T37-c 那批探针跑出来的，点开任何一个都只会得到"该会话已无法继续"。

修完之后：这 5 行全部自动修好，且又跑了一整轮 12 步 GUI 探针（会新建十几个会话、杀 worker、强杀应用），
索引里**指向不存在文件的行数为 0**。

## 根因

Pi 的 `SessionManager` 在会话创建时就把 JSONL 的**文件名定下来**，但直到**第一条 assistant 消息**落地才真正写盘。
这是 SDK 里 `_persist` 的 `hasAssistant` 判断，源码在
`src/agent-host/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`。

直接跑 SDK 验证过：

```text
planned sessionFile      : …/2026-09-03T01-20-39-628Z_01a064da-….jsonl
exists right after create: false
exists after user message: false      ← 用户消息也不写
exists after assistant   : true
```

Main 拿到这个**还只是预留的路径**，立刻当作会话的持久身份写进 `session-index.json`。
于是所有下游都相信"runtimeIdentity 指向一个可以重新打开的文件"，而这句话当时并不成立。

后果有四层，前两层 T37-c 已经报过，后两层是这次查出来的：

1. **崩溃后重启失败**：`restartEntry` 拿这个路径去 resume，worker 报 `WORKER_SESSION_FILE_NOT_FOUND`；
   两次重启都这样，预算耗尽后 `entry.state = 'error'`。
2. **`error` 是个没有出口的状态**：`resumeSession` 见到非 `ready` 就抛 `session_not_ready`，
   `send` 抛 `session_not_found`，而 `isSafeToEvict` 只认 `ready`，所以这条 entry
   **既清不掉、也永远占着池子里的一个名额**。D17 在 4 GiB 机器上容量只有 2 —— 两个坏会话就能让整个应用建不出新会话。
3. **不用崩溃也能触发**（新发现）：Stop、退出应用、模型报错，只要第一条 assistant 消息没落地，
   那一行就永久坏掉。本机 5 行里有 4 行标题都是探针 Stop 测试用的 "Count slowly from 1 to 60…"。
4. **重开应用也修不好**（新发现）：选中该会话 → resume → `WORKER_SESSION_FILE_NOT_FOUND` →
   界面提示"该会话已无法继续：请新建会话继续工作"。而它其实什么都没丢过。

## 改了什么

### 1. 文件不存在就不发布持久身份（根因修复）

`WorkerManager` 新增 `identityCommitted` 与可注入的 `sessionFileExists`。
`createSession` 里原本无条件 `bindRuntimeIdentity`，现在先看文件在不在：

- 在 → 和以前完全一样，写索引并在 `session.created` 里带上 `runtimeIdentity`。
- 不在 → **不写索引、`session.created` 不带 identity**，entry 只在内存里记住这个路径（做 slot key 与冲突检测用）。

这比原来更保守，没有放宽 T30-a 的不变量：Main 依然不会公布索引没落盘的身份，
现在还额外做到不会把文件系统兜不住的身份写进索引。

索引里 `runtimeIdentity` 这个字段的含义因此变成一句真话：**它指向一个存在、可重新打开的 Pi 会话文件**。

### 2. 文件一出现就补发身份

新增 `ensureIdentityCommitted`，两个触发点：

- **回合结束**（`syncLeafCheckpoint` 里，`commitPiLeaf` 之前——索引会拒绝给没有身份的会话提交 leaf）。
- **第一条 assistant 消息完成时**（`message.completed`）。

第二个触发点是必需的：一个跑了几分钟工具调用的长回合，文件其实早就写出来了，
如果等到回合结束才认领身份，中途强杀应用就会让一份**磁盘上真实存在的转写**变得无法访问。
补发走的是 `session.updated` 事件——这个事件类型早就存在，索引服务和渲染层都已经接好，只是一直没有发送方。

代价：身份认领前每条完成的消息多一次 `stat`，认领后为零。

### 3. 文件从没写出来过，就重建而不是修不好

`restartEntry` 现在先判断：身份没认领过 **且** 文件确实不在磁盘上 → 说明这个会话从未 materialize，
于是**开一个全新的 Pi 会话挂到同一个逻辑会话 id 上**，而不是去 resume 一个不存在的文件。

- 不会产生重复会话，也不会留下孤儿索引行：逻辑 id 不变，改的是同一行。
- 那个"文件确实不在"的复查不能省：文件有可能在上次检查之后、崩溃之前刚好落地，
  那种情况下重建就是真的丢数据了。
- 新会话和当初一样是"未 materialize"状态，按同样的规则去挣它的持久身份。

**要说清楚的代价**：重建恢复的是**可用性，不是那个丢掉的回合**。
崩溃前的对话内容本来就没写进磁盘，新 worker 也拿不回来，用户的下一条消息从空上下文开始。
但对比原来的"这个会话永久报废"，这是严格的改善。

### 4. `error` 不再是墓碑

- `createSession` / `resumeSession` 遇到 `error` 状态的 entry，先退役销毁再走冷启动路径——
  这是"没有任何路径可以清除"那句话的正面解决。
- `isSafeToEvict` 把 `error` 也算作可淘汰，并在挑淘汰对象时优先挑它：
  死掉的 entry 没有 worker 可失去，不该逼着池子去淘汰一个健康的空闲会话。

### 5. 修好已经写坏的索引行

只防不修等于没修——本机那 5 行照样是死的。
`chat:resumeSession` 现在会识别这种历史遗留行并就地修复：**指向的文件不存在，且这一行没有 `piLeaf`**。

`piLeaf` 是判据的关键：leaf checkpoint 只有回合结束时才提交，所以

- 文件缺失 + 没有 leaf = Pi 从没写过它 → 什么都没丢，清掉身份并给它一个真的 Pi 会话。
- 文件缺失 + 有 leaf = 曾经写出来过，是用户删了转写 → **真的数据丢失，必须照旧大声报错**，不能拿一个空会话糊弄过去。

本机数据支持这个判据，分得干干净净：

```text
文件存在 + 有 piLeaf : 49
文件存在 + 无 piLeaf : 0
文件缺失 + 有 piLeaf : 0
文件缺失 + 无 piLeaf : 5      ← 全部是需要修的
```

## 门禁与实测

### 单元回归（10 条新用例）

`WorkerManager.test.ts` 新增一个 describe 块，harness 加了 `sessionFileExists` 注入口（默认"文件都在"，
等于既有用例原来的语义）。三条关键用例已实测：**把修复拆掉就变红**。

| 用例 | 断言 |
|---|---|
| 文件没写就不发身份 | `bindRuntimeIdentity` 未被调用；`session.created` 的 payload 里没有 `runtimeIdentity` |
| 文件出现就补发 | `message.completed` 后 bind 一次 + 发一条 `session.updated`；再来一条消息不重复 |
| 未写就崩溃 → 重建 | 重启的 spawn 不带 `sessionFile`/`leafCheckpoint`；key 与 sessionFile 换成新文件；随后 `send` 成功 |
| 写过的文件不见了 | 仍然按原路径 resume，不静默重建 |
| `error` 可被 resume 清除 | resume 从 `error` 恢复到 `ready`，不再抛 `session_not_ready` |
| `error` 不再占容量 | capacity 1 时新会话能建出来，坏 entry 被退役 |
| 索引服务 ×2 | 清身份后行里没有 `runtimeIdentity` 字段（是删掉不是置空）；身份对不上时拒绝清 |
| IPC ×2 | 无 leaf + 文件缺失 → 走 `createSession` 并清身份；有 leaf → 照常 resume |

### 真应用实测

探针加了一步 `crashUnwritten`（在 `crashWorker` 之前），专测这个窗口：建会话 → 发长回合 →
worker 一起来就 `kill -9` → 断言身份从未发布、磁盘上确实什么都没多出来 → 再发一条看能不能用。

完整 12 步跑通（`2026-09-03T02:18:03Z → 02:20:45Z`，真 cx2 账号、真模型端点）：

```text
entry ✓  models ✓  workspace ✓  multiSession ✓  queue ✓  history ✓
import ✓  tui ✓  crashUnwritten ✓  crashWorker ✓  crashTui ✓  hardKillRestart ✓
```

`crashUnwritten` 的实测记录：

```json
{ "identityBeforeKill": null,
  "filesWrittenBeforeKill": [],
  "recoveryAttempts": 1,
  "runtimeIdentityAfterRecovery": "…/2026-09-03T02-18-59-779Z_01a0650f-….jsonl" }
```

即：杀的时候身份确实没发布、磁盘确实没有文件；一次发送就恢复；恢复后公布的身份是一个真实存在的文件。

`crashWorker` 的等待条件顺带改了。它原来等 `runtimeIdentity && running`，
在新语义下这个条件永远等不到（回合中途还没有身份）。改成等 `runtimeIdentity` 出现——
**现在这就等价于"文件已经写到磁盘上了"**，正是这一步需要的前置状态，比原来直接 `existsSync` 更贴。
这一步实测 74.5 秒通过，`recoveryAttempts: 2`，与 T30-c 的 "active turn single failure" 契约一致。

### 历史坏行修复实测

拿本机那 5 行真实的坏记录，逐个调用 `window.electronAPI.chat.resumeSession(...)`：

```text
session-1788362915985-slwaai5 {"ok":true,"requestId":"create-1788401509142-1"}
session-1788365458607-3i2u9q7 {"ok":true,"requestId":"create-1788401511201-2"}
session-1788365591287-5g73c64 {"ok":true,"requestId":"create-1788401512680-3"}
session-1788366181501-m0dg1ax {"ok":true,"requestId":"create-1788401514267-4"}
session-1788366555356-xajw24k {"ok":true,"requestId":"create-1788401515704-5"}
```

全部成功，`requestId` 前缀是 `create-` 而不是 `resume-`——证明确实走的是修复路径。
修完索引里这 5 行的 `runtimeIdentity` 都被清掉了。

之后又跑了一整轮 12 步探针（新建十几个会话、杀 worker、强杀应用），索引复查：

```text
总行数 77 | 有 identity 62 | identity 指向不存在的文件 0
```

## 顺带记录：本机环境的一个坑（不是代码缺陷）

第一次跑探针时应用**启动即挂死**：窗口不出现、调试端口接受连接但不回包。
在**未改动的已提交代码**上复现，所以不是这批改动引入的。

原因是环境里设了 `HTTP_PROXY=http://127.0.0.1:7890`。Chromium 会拿它去代理渲染进程加载
`http://localhost:5173` 的请求，然后就卡住了；大写的 `NO_PROXY` 不管用，**Chromium 读的是小写 `no_proxy`**。

探针启动 dev app 时补上了小写 `no_proxy` 的回环绕过。
**注意**：直接 `pnpm dev` 在配了代理的机器上仍然会挂死且没有任何提示——这条留给 T37-d 判断要不要单独处理。

## 未覆盖

- **应用内已 evict 的未 materialize 会话**：一个从没写盘的会话被空闲回收（15 分钟）之后，
  再回去输入会得到 `session_not_found`——因为没有 runtimeIdentity 就不会触发 resume，
  而渲染层的 `hostBoundSessionIds` 只增不减。这是既有窟窿，本批没有让它变好也没有让它变坏；
  修它要动 `chatSessions.ts`（红线文件），应当单独切片。
- **packaged 产物**：本批没有涉及，仍按 T37-c 的决定交 CI。

## 验证

```text
node scripts/run-t37c-gui-probe.mjs        → 12/12 pass（2026-09-03T02:18:03Z 起，约 2.7 分钟）
pnpm exec vitest run（全量）                → 256 files / 3909 tests 全绿，0 失败（新增 10 条）
pnpm typecheck                              → pass
pnpm typecheck:agent-host                   → pass
pnpm exec biome check <7 个改动文件>         → pass
git diff --check                            → pass
```

收尾复查：探针退出后 `electron` / `pi` 进程数为 0。
