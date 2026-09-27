# P1-1 引擎直替：方案与就绪检查

Role: topic。上位：[roadmap P1-1](../roadmap.md)。依据：[决策 004](../decisions/004-branch-isolated-dsh-only.md)、[P0-3 接缝与映射](../evidence/p0-3-bridge-2026-09-25.md)、[P0-6 共享宿主](../evidence/p0-6-shared-host-2026-09-26.md)、[P1-0 同步](../evidence/p1-0-sync-main-2026-09-26.md)。逐行依据、守卫字面量、单测用例：[inventory.md](p1-1-engine-cutover/inventory.md)。2026-09-26 在 `feat/dsh-p0-probe` HEAD `5e1385e7` 上只读调研，DSH 以 `0.1.7-rc.2` 源码为准。本文是方案，不是施工结论：§5 的决策点待拍板；标「推断」的没有运行验证。

## 1 结论先行

1. **能做，而且改动面集中。** 新建、恢复、fork、崩溃重启四条路径在 Main 里都汇到 `spawnForEntry → createSlot`（`WorkerManager.ts:2535-2606`）。真正分引擎的只有 `createPiWorkerSlot.ts:70-75` 这一处三元式。改成无条件拉 DSH 宿主，四条路径就都走 DSH，WorkerManager 的状态机不用动。
2. **「走到 DSH」不等于「走得通」。** 光改拉起点，下面三处会让恢复和崩溃重启必然失败，或者把会话弄成打不开。P1-1 要一起补，都是小改，与 P1-4 不冲突：
   - bridge 恢复时不返回 `initialHistory`。Main 在恢复、重启、fork 目标上都强制要求它（`WorkerManager.ts:1324`、`:3343`、`:1873`）。
   - 索引服务把 `pi` 写死了：`commitResumed` 每次恢复都把行改回 `pi`（`SessionIndexService.ts:316`）；`commitPiLeaf` 拒收非 `pi` 行（`:343`），而 `restartEntry` 直接 await 它（`WorkerManager.ts:3355`）。
   - 桩文件先于 DSH 会话落盘。DSH 新会话要到首次追加才写盘（jsonl README:76），bridge 却在 bootstrap 时就写桩（`dshSessionRuntime.ts:297-315`），Main 见桩即提交身份。如果首个回合之前宿主就死了，这个会话以后永远恢复不了。这和 pi 懒写那次的坑是同一个形状。
3. **fork：** Main 这一侧的路径 P1-1 可以切到 DSH，也有单测。但 bridge 的 `worker.fork` 需要把「消息」换算成 DSH 事件 seq，这依赖 P1-4 的历史投影，所以 P1-1 里维持 `WORKER_DSH_UNSUPPORTED`。DSH 本身支持从任意事件 seq 分叉。
4. **旧 pi 会话：** 推荐在 P1-9 之前只读。主进程只读回放照常能用；恢复和发送由 Main 明确拒绝；不留 native 回退。
5. **打包态：** 去掉「仅未打包」限制。打包态按 P1-2 的资源布局解析宿主，找不到就明确报 `DSH_HOST_MISSING`，不回退 native。
6. **规模：** 约 1 人周（粗估）。产品代码约 400～500 行（含 smoke 扩展），测试约 600～800 行。
7. **roadmap 里没有人认领的缺口**（见 §8）：一次性补全的替代引擎；DSH 会话的主进程只读回放；图片附件的桥接。

## 2 现状盘点

| 路径 | Main 入口 → 拉起点 | 传给 worker 的身份 | worker 装载 | Main 硬要求 | DSH 下今天 |
|---|---|---|---|---|---|
| 新建 | `CHAT_CREATE_SESSION`（`chat.ts:282-362`）；另有恢复时的「修复」分支（`:504-528`，同逻辑 id 重建）→ `createSession` → `spawnForEntry` `:1023` | `logicalSessionId` + `cwd`，无 `sessionFile` | `worker.bootstrap` → `agents.create('aiclient-<逻辑 id>')` + 写桩 | 返回 `sessionFile`；桩在即提交身份（`:1072`） | 通（P0-3 GUI 验过），但身份提交早于落盘 |
| 恢复 | 渲染层 4 个触发：点开会话且预览失败、发送 preamble=resume、direct 发送遇 `session_not_found`、错误卡重试 → `CHAT_RESUME_SESSION`（`chat.ts:436-543`）→ `resumeSession` → 冷路径 `:1280` | 加上 `sessionFile` = 索引 `runtimeIdentity`（+ 一次性 `forceTakeover`） | 读桩 → `agents.resume` | 同键；**必须有 `initialHistory`** | 必失败 |
| fork | 会话树「从这里分叉」→ `chat.ts:874-889` → `forkSession`：源槽 `worker.fork{entryId}` → Main 铸 `session-fork-<uuid>` → 目标 `:1861` | 新逻辑 id + 源 cwd + 子会话 `sessionFile` | 源 `worker.fork` / `.accept` / `.discard`；目标 `worker.bootstrap` | 精确打开；`initialHistory`；fork 行写 `agent: pi` | 必失败（bridge 不支持） |
| 崩溃重启 | 宿主退出 → `handleLifecycle`；Stop 看门狗 10 s → `forceStop` → `restartEntry` `:3297` | 同逻辑 id + `entry.sessionFile`（身份未提交且文件不在时 fresh），`generation + 1` | 同恢复 | 同键；`initialHistory`；`commitPiLeaf`；60 s 内 2 次预算 | 必失败 |

- **会产生新分支的入口：**
  - v1.0.3 的分支栏是 git 分支切换（`BranchColumn.tsx`），与会话无关。
  - 重试上一轮是同一个槽上的 `worker.send mode:'retry'`；回退是同一个槽上的 `worker.rewind`。两者都不拉新槽，pi 靠文件内分支实现。
  - 只有 fork 会产生新会话。
  - DSH 日志是线性的，没有 rewind，也没有会话内分支。重试和回退怎么映射，要由 P1-4 设计。
- **不经 `createPiWorkerSlot` 的 native 拉起：** 一次性补全（`PiUtilityService.ts:113`：提交信息、分支名、代码评审）和 CC / Codex 导入（`PiImportProcess.ts:93`）。
- **索引：** 位置是 `<userData>/session-index.json`，裸数组。行结构见 `sessionIndex.ts:46-95`；`agent` 在磁盘侧是字符串，未知值原样保留，渲染层遇到未知值只是隐藏该行。
  - `agent` 的写入点：`chat.ts:319`、`:422`；`WorkerManager` 5 处（`:947`、`:1079`、`:1887`、`:1915`、`:2864`）；`commitResumed` 的字面量 `'pi'`；导入（`LegacyImportService.ts:386`）；TUI 收编会话（`piTui.ts:195`）。
  - 读取与守卫：`chat.ts:128`、`:192`、`:264`、`:464`；`SessionIndexService.ts:343`、`:383`；`sessionIndexMerge.ts:111`；`resumeIntent.ts:105`；`chatSessionActions.ts:169`。
- **`AGENT_WIRE_NAMES = ['pi']`**（`agentWire.ts:13`）：它是 ABI，只能追加。
- **静态守卫：** 与 P1-1 相关的是 `agentWireStatic`（钉 `['pi']`、`sessionAgent` 缺省为 `pi`、禁止对 agent 读值写字面量缺省、索引裸数组）、`devDshEngine.test`（开关门控与环境逐键相等），以及行为测试 `chatPiWorkerRouting`。`t31PiOnlyAbsence`、`t35`、`nativeCatalog`、`retryLastTurn` 钉的是 P1-5 / P1-11 / P1-12 的东西，P1-1 不碰。全表见 inventory §3。

## 3 DSH 侧事实（源码）

- **新建：** `ctx.agents.create({sessionId, meta: {cwd, parentSession?, isSeeded?}, seed?, inheritedEventCount?, agentOptions})`，id 由调用方给。不给 id 时 store 铸 `session-<n>`，这是进程内计数，不能当持久身份。
- **落盘：**
  - 路径：`$DSH_HOME/sessions/--<归一化 cwd>--/<转义 id>/session.v4.jsonl.zstd` + `session.lock`。
  - 懒落盘：`create` 不写盘，首次追加才写。
  - 显式固化：`ctx.sessions.flush(session)` 只写 header 并取锁。
  - 同 id 已在盘上时，`create` 直接抛 `SessionAlreadyExistsError`。
- **恢复：** `ctx.agents.resume({resumeSessionId})` = 以写方式打开 + 补中断收尾 + 重放。
  - 找不到：抛 `SessionPersistenceNotFoundError`。
  - 别的进程持锁：抛 `SessionAlreadyOwnedError`。锁是内核锁，没有「强制接管」。
- **分叉：** `buildForkSeed(events, 边界 seq)` / `SessionStore.fork(source, boundary, childId)`，可以从任意事件 seq 分叉，未收尾的部分补 `forked` 收尾。agent 级分叉 = 带 `seed` 和 `isSeeded` 的 `agents.create`。**没有 rewind。**
- **cwd：** 会话 header 里的 cwd 不可变。工具、沙箱根、提示词都读它；恢复时 Main 传进来的 cwd 不起作用。
- **用户层：**
  - `$DSH_HOME/cordis.patch.yml` 会叠加到任何 profile 上。
  - `$DSH_HOME/.env` 会进宿主和工具的环境。
  - 格式总是取最高代际，**不支持降级**（当前 v4）。
- **`DshSessionRuntime` 现状：**
  - 已实现：bootstrap（不带 `initialHistory`）、send、stop、审批应答。
  - send 忽略 `mode:'retry'`（会把空文本当新消息发出去）、忽略附件（图片被静默丢掉）、忽略每轮的 model / effort。
  - 桩：插话、问答、预览、三个权限 setter、history / tree（空页）、commands。
  - 不支持：compact / rewind / reload / fork / accept / discard、导入、一次性补全。

## 4 推荐方案

- **R1 Main 直替。**
  - `devDshEngine.ts` 改名为 `DshHostProcess.ts`，仿 `PiWorkerProcess.ts` 的形态，去掉门控。
  - 宿主解析：
    - 未打包：`out-node-runtime/node` + `src/dsh-host/host.ts`。
    - 打包：`resources/node-runtime/node(.exe)` + `resources/dsh-host/host.js`。路径常量在 P1-1 定，产物由 P1-2 交付。随包 node 在已钉版本的平台上本来就在（`afterPack.mjs`）；`src/**` 不进包（`electron-builder.yml:9-12`）。
    - 缺任何一个都抛 `DSH_HOST_MISSING`；删掉「回退到 PATH 上的 node」。
  - `createPiWorkerSlot` 的默认 transport 固定为 DSH。拉起前检查会话 cwd，保留 `WORKER_WORKSPACE_MISSING`（渲染层有对应卡片）。
  - `forkPiWorkerProcess` 只留给一次性补全和导入。
- **R2 身份。** 沿用「桩文件 = runtimeIdentity」，但改成先固化 DSH 会话、再写桩。
  - 新建：`agents.create` → `ctx.sessions.flush` → 原子写桩，内容为 `engine`、`version`、`dshSessionId`、`logicalSessionId`、`cwd`、`createdAt`。
  - 恢复：
    - 先校验桩；`stub.cwd` 与请求的 cwd 不一致时抛 `session_cwd_mismatch`。
    - 错误映射：NotFound → `dsh_session_missing`；Owned → `session_locked`；`forceTakeover` 忽略。
    - 返回 `initialHistory` = `history({offset: 0, limit: 80})`。P1-4 之前这是合法的空页，渲染层遇到空页会保留运行期消息（`historyReplayMerge.ts:374-378`）。
  - 安全桩：`mode:'retry'` 抛 `WORKER_RETRY_UNAVAILABLE`，带附件抛 `WORKER_DSH_UNSUPPORTED`。真正的实现在 P1-4。
- **R3 索引与 wire。**
  - `AGENT_WIRE_NAMES = ['pi', 'dsh']`（追加）；新增 `DSH_AGENT`；`sessionAgent()` 的缺省改为 DSH。
  - 新建、恢复、fork 一律写 `dsh`。`PI_AGENT` 只留给导入、TUI 和旧行读取。
  - `commitResumed` 按传入的 agent 写；`commitPiLeaf` 接受 `dsh`。
  - Main 守卫改为「活引擎 = dsh」，旧行按 D1 处理。
- **R4 `DSH_HOME` = `~/.pilab/<profile>/dsh-home`。**
  - 与 `pi-agent` 同在应用状态根下（`appStatePaths.ts:41-44` 注明新状态都放这里）。
  - 以 0700 创建。
  - `AICLIENT_DSH_HOME` 只在未打包时生效；宿主继续拒绝 `~/.dsh`。
- **R5 环境。**
  - 白名单不动；XDG / DBus 与 `.env` 隔离归 P1-3。
  - `AICLIENT_DSH_GATEWAY_URL/KEY`、`AICLIENT_DSH_NODE`、`AICLIENT_DSH_HOME` 只在未打包时读。网关两项注明由 P1-5 删除。
- **R6 TUI 护栏。**
  - `PI_TUI_SESSION_SUPPORT` / `PI_TUI_OPEN` 一律拒绝 `.dsh.json` 身份。
  - 原因：桩是多行 JSON，现有检查只看首行，会判成「支持」。pi 打开它时可能往文件里写 header（推断）。

## 5 需要拍板的决策点

**D1 旧 pi 会话在 P1-9 之前怎么办**（影响范围，建议用户拍板）

- 选项：
  - A 只读（推荐）：预览照常（`chat.ts:906-960` → `SessionReplayReader`；`src/runtime` 在 P1-12 前都在）。恢复和发送由 Main 抛 `legacy_session_readonly`，渲染层给卡片「迁移前只能查看」。没有 runtimeIdentity 的 pi 空行允许直接转成 DSH 新会话。
  - B 旧行继续走 native：等于按会话选引擎，违反决策 004。
  - C 发送时新开一个 DSH 会话接着聊：上下文会断，属于 P1-9 的产品语义。
  - D 提前做临时转换：这就是 P1-9 本身。
- 理由：成本最低，不留双引擎；分支里自测用新会话即可。
- 代价：P1-1～P1-9 期间，旧会话和 CC / Codex 导入的会话都不能在 GUI 续聊。嵌入式终端的 pi TUI 仍能续聊旧会话，直到 P1-11 定去留。

**D2 会话身份的形态**

- 选项：
  - A 桩文件（推荐）：Main 的路径语义不用动（绝对路径、stat、会话键、staged-fork 清扫）。桩还是个可变指针：P1-4 如果用 DSH 种子子会话实现回退 / 重试，只要改桩里的 `dshSessionId`，索引行和会话键都不变。
  - B 直接用 DSH 日志路径：文件名随格式代际变化，而且首回合前不存在。
  - C 合成 URI（`dsh:<id>`）：`normalizeWorkerPath`、`sessionFileExists`、只读回放、TUI、清扫都要改。
- 代价：多一个私有小文件。桩丢失时，靠 `aiclient-<逻辑 id>` 反查。

**D3 新会话何时算落盘**

- 选项：
  - A 创建即 flush 固化 header，再写桩（推荐）：恢复和重启总能找到 DSH 会话。代价是发送失败的会话也会留下一个只有 header 的日志；会话在首次发送时才创建，所以量很小。
  - B 仿 pi 懒提交（首次落盘后才写桩，靠 Main 现有的懒提交和 rematerialize）：落盘有 200 ms 攒批，窗口期更难证明；而且 rematerialize 会用同一个 id 重建。

**D4 `DSH_HOME` 放哪，L3 怎么解释**（影响兼容目标，建议用户拍板）

- 选项：
  - A 私有目录 `~/.pilab/<profile>/dsh-home`（推荐）。
  - B `<userData>/dsh-home`：可行，但与现有「会话数据放应用状态根」的约定不一致。
  - C 与官方共用 `~/.dsh`（L3 的字面含义）。风险：
    - 两边版本不一致时会互相迁移格式，而 DSH 不支持降级。我方钉 `0.1.7-rc.2` 写 v4；官方 `latest` 仍是 `0.1.5-rc.3`，它写哪一代没有核实。
    - 用户层的 patch 和 `.env` 会流进我方宿主。可能把我方关掉的官方行重新打开，宿主的启动审计会因此直接失败。
    - 同一个会话两边同时打开会撞锁。
- 推荐：P1-1 用 A。L3 暂时解释为「格式和插件兼容」；「共用 home」另立一项，合入前再议。

**D5 P1-1 期间的打包态**

- 选项：
  - A 按 P1-2 的布局解析宿主，缺失时明确报错（推荐）。
  - B 保留「仅未打包」直到 P1-2：与 roadmap 的文字冲突，而且打包态会静默没有引擎可用。
- 代价：P1-2 之前打出的包无法聊天，但会明确报错，不会悄悄换回旧引擎。

**D6 P1-1 与 P1-4 的界线**

- 选项：
  - A P1-1 带上 R2 的最小补丁（推荐）：空页 `initialHistory`、错误映射、cwd 校验、重试 / 附件拒绝。
  - B 全部留给 P1-4：那么开发机上的恢复、重启、Stop 强杀之后，会话都会停在 error，「4 条路径」只在单测里成立。
- 代价：P1-1 多约 100 行 bridge 代码。P1-4 只替换 `history()` / `tree()` 的实现和两个安全桩，不推倒。

**可自主决定的小项**（按工作方式各写一份决策、标「待审批」）：

- 这一步不改名：`createPiWorkerSlot`、`PiWorkerRpcServer`、`pi_session_*` 错误码、`AICLIENT_PI_WORKER_*` 都留到 P1-12。
- DSH 会话 id = `aiclient-<逻辑 id>`，便于反推。fork 子会话的 id 由 P1-4 定，建议 `worker.fork` 带上 Main 预先铸好的新逻辑 id。
- 显示名 `dsh: 'DSH'`。
- 不加回退开关。对比基线用 main 分支的构建。

## 6 改动清单与边界（明细见 inventory §5）

| 范围 | 文件 | 约 |
|---|---|---|
| Main 拉起 | `devDshEngine.ts` → `DshHostProcess.ts`；`createPiWorkerSlot.ts` | 160 行 |
| 身份与索引 | `agentWire.ts`、`WorkerManager.ts`（5 处 agent、`commitResumed` 传 agent）、`SessionIndexService.ts`、`chat.ts` 守卫 | 95 行 |
| 渲染层 | `resumeIntent.ts`、`chatSessionActions.ts`、`historyError.ts` + 中英文案 | 40 行 |
| TUI 护栏 | `piTuiSession.ts`、`piTui.ts` | 15 行 |
| bridge | `dshSessionRuntime.ts`、`bundle/lib/bridge.js`（`inject` 加 `sessions`）、`bridge-smoke.ts` 加 3 个场景 | 205 行 |
| 删除 | `devDshEngine.ts` 及其测试（由新文件取代）。`AICLIENT_DEV_ENGINE` 从代码里消失 | — |

- **不做，留给 P1-3（共享宿主）：**
  - 不加心跳、按 pid SIGKILL、宿主级重启预算、多 slot 传输。
  - 不改容量，不改 Stop 看门狗。
  - P1-3 会复用 `DshHostProcess` 的布局、环境、home 三块，替换的只是「每槽一个进程」的 `forkDshHost`。
- **不做，留给 P1-4（bridge 对等）：**
  - 历史 / 树 / leaf 投影；fork / rewind / compact / reload。
  - 插话、重试、附件的真实现。
  - 用量、goal / todo、中断标记、`TOOL_OUTCOME_UNKNOWN`、录制门禁。
- **其他后续项：**
  - P1-2：打包宿主，把 bridge 按路径引用 `src/agent-host`、`src/shared` 的 TS 打进包（`bridge.js:40-43`）；`PiRuntimeChecker` 与 `verify-packaged-app` 改查 DSH。
  - P1-5：路由与凭据、模型标签。
  - P1-9：旧会话转换、导入产出 DSH 格式、回装安全的索引策略。
  - P1-11：TUI。
  - P1-12：删 runtime / native、统一改名、更新 t31 等守卫。

## 7 单测方案（用例清单见 inventory §6）

判定「走了 DSH」要分两层：
- 拉起层：`createPiWorkerSlot` 默认只调 `forkDshHost`。
- 路径层：WorkerManager 四条路径都经 `createSlot`，带上正确的身份，并把 `dsh` 写进事件和索引。

两层合起来才证明四条路径都走 DSH。现成的 `WorkerManager.test.ts` harness 可以直接复用：它把 `createSlot` 换成桩并记录 options，提供 `records[i].crash()`、`events` 数组，以及 `commitResumed` / `commitPiLeaf` / `createForked` 的桩。

- **新建：** `createSlot` 不带 `sessionFile`；`session.created` 带 `agent: 'dsh'`；`bindRuntimeIdentity` 收到桩路径。
- **恢复：** `createSlot.sessionFile` = 桩；`session.resumed` 带 `dsh`；`commitResumed` 收到 `dsh`。Main IPC 层：dsh 行能恢复；带身份的 pi 行被拒；无身份的 pi 行能新建。
- **fork：** 源 `worker.fork` 回子桩 → 目标 `createSlot` 带子桩；`createForked` 行和 `session.created` 都是 `dsh`。bridge 单测钉住 `fork()` 仍是 `WORKER_DSH_UNSUPPORTED`，没有 native 回退。
- **崩溃重启：** `crash()` 后第二次 `createSlot` 带同一个桩且 `generation` 为 2；`commitPiLeaf` 不抛；`session.resumed` 为 refresh。Stop 看门狗的强制重启照 `[T144-wm-04]` 再测一遍。
- **拉起层与守卫：**
  - `createPiWorkerSlot.test` 加一例：mock `DshHostProcess` 和 `PiWorkerProcess`（后者一被调用就失败），`app.isPackaged` 取真假两种都只走 DSH。
  - `DshHostProcess.test` 覆盖布局、缺失报错、环境白名单、home、仅未打包的覆盖项。
  - 新静态守卫 `chatEngineDshOnly.test`：`createPiWorkerSlot.ts` 不引用 `forkPiWorkerProcess`、`AICLIENT_DEV_ENGINE`、`isPackaged`；`WorkerManager.ts` 恰有 4 处 `spawnForEntry(`，且没有 `PI_AGENT`。
- **bridge：**
  - 新增 `src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts`，用假的 `DshBridgeContext`（接口很窄：`on`、`agents`、`agentDefaultModel`）测：先 flush 再写桩、恢复参数、`initialHistory` 形状、错误映射、安全桩。
  - `createUserMessage` 改成注入，才能在不装 DSH 包的根 vitest 里跑（推断）。
  - 真实 DSH 的回归靠扩展后的 `bridge-smoke.ts`：新建后会话已落盘；换一个宿主用桩恢复并跑一轮；SIGKILL 后重启恢复。
- **退出判据对照：**
  - 「4 条路径有单测」= 以上各项。
  - 「开发机上新建会话走 DSH」= 一次 GUI 点验，沿用 P0-3 的配方：隔离 HOME、假网关、不设任何开关。看四样东西：进程列表里是 `node --expose-internals …/host.ts`，没有聊天用的 native worker；索引行是 `agent: dsh` 且身份为 `.dsh.json`；`$DSH_HOME/sessions/` 下出现会话目录；流式正文正常。
  - 另外跑四套 tsc 和相关单测；全量留到批次收口。

## 8 roadmap 缺口（建议补登）

1. **一次性补全**（提交信息、分支名、代码评审）走 native utility worker。P1-12 删 runtime 之前必须有替代，目前没有条目认领。建议并入 P1-5 或 P1-12。
2. **DSH 会话的主进程只读回放**（决策 030）。`SessionReplayReader` 依赖 `src/runtime` 的 pi 解码器，只懂 pi 格式，所以 P1-1～P1-4 期间点开 DSH 会话必然回退到拉宿主。建议并入 P1-4。另外，P1-9 的转换器也要用 pi 解码器，P1-12 删 runtime 时要把它保住。
3. **图片附件桥接：** 现在被静默丢掉，这会让 v1.0.3 的读图功能倒退。P1-4 的条目里没列，建议补上。
4. **DSH 日志清理：** DSH 没有删除 API，归档会话不会清理日志。合入前要定清理策略（小项）。

## 9 风险与未覆盖

- **过渡期一会话一宿主（P1-1 到 P1-3）：**
  - 每个会话约 180 MB，冷启动约 0.8 s。
  - 多个宿主共用一个 `DSH_HOME` 不是 DSH 支持的形态：插件、设置的写入没有跨进程协调，每个宿主启动都会重写 profile 文件。
  - 所以只在开发机自测，P1-3 之前不出包。
- **P1-4 之前恢复后时间线为空**；DSH 会话点开时的预览必然回退到拉宿主。
- **模型：** 界面显示的是用户选的模型，实际走的是 `aiclient-gateway/fake-1`；不设网关变量时请求会打到 discard 端口。P1-5 之前点验必须起假网关。
- **权限：** 三个权限 setter 都是空操作，DSH 只在越出沙箱时审批，「每次询问」档不生效。P1-6 之前不能给别人用。
- **宿主卡死：** WorkerSlot 杀进程发的是 SIGTERM，宿主装了优雅停止；卡住的宿主可能 3 s 内退不掉，重启失败，会话停在 error。这要靠 P1-3 的按 pid SIGKILL。
- **Windows：** 启动器和环境白名单只在 Linux 上验过。会话路径较深（`dsh-home/sessions/--<cwd>--/<id>/…`），长路径、中文路径都没覆盖。
- **待验证的推断**（bridge-smoke 前两个场景就是验这些的）：
  - `agents.create` 返回后能立即 `flush` 固化。
  - 只有 header 的会话能被 `agents.resume` 打开。
  - pi TUI 打开桩会写坏它。
- **回装 1.0.x：** `dsh` 行会被隐藏但保留在磁盘上。P1-1 不改写任何已有的 pi 行。这符合决策 004。
- **宿主 stderr 噪声：** 宿主的 ready JSON 和 DSH 警告会以 `session.stderr` 进上下文面板（按回合限流）。属于小事，P1-3 / P1-4 顺手收掉。
