# 第 10 批：H/20 互通与 P6 切换的验收记录

日期：2026-09-13。范围：[H/20](../../topics/gui-tui-session-interop.md) + [P6-1～P6-5](../../topics/p6-cutover.md)。
本记录只写**这一批做了什么、验到哪一步**；节点状态以[核心任务树](../../README.md)为准。

## H/20 会话互通

### 结论

**一个文件，两种格式，双向通。**会话文件的头一行同时写 `kind:"header"`（v4）与 `type:"session"`（v3），其余行保持 v4 形状；读的时候容忍 CLI 追加的 v3 行，但**不回写、不重排**。

### 可行性验证漏掉的两处（本轮才发现）

2026-09-10 的[可行性探针](../gui-tui-session-interop/README.md)只跑了纯文本消息，于是有两处结构性问题没暴露：

1. **不是 entry 的那些行会把 CLI 带到空对话。** v4 里「改名」「切分支」写的是 `fact` / `lane` 行，它们没有 `id`、没有 `parentId`。而 CLI 读文件时把**每一行**都当条目、并把**最后一行的 id**当作对话的末端——遇到这种行，末端就成了 `undefined`，CLI 于是回退到「文件最后一行」，也就是那行 bookkeeping 本身，父链一步都走不通，**整段对话在 TUI 里显示为空**。导入的会话更是必中：`convertLegacySession` 的最后一行永远是 `lane` 行。
   修法：给这些行补上 v3 的 `id` / `parentId` / `type:"custom"`。CLI 把它们当作不参与上下文的扩展条目（不渲染、不进模型），链因此不断；我们这边读回来时，把「CLI 挂在这些 id 下面的行」重新指回它真正代表的那条 entry（`chainTarget`）。
2. **压缩在两个方向上表达方式不同。** v3 用 `firstKeptEntryId` 指一个锚点，v4 把保留下来的消息整段存在条目里。两边都要翻译：我们写压缩时补一个 `firstKeptEntryId`（否则 TUI 只看得到摘要、看不到保留的尾巴），读 CLI 的压缩时按锚点把尾巴重建出来（重建不出来就退化成空尾巴，而不是拒绝打开整个会话）。

另外补了 v3 独有的三种行：`custom_message` 映射成 v4 的 custom 角色消息、`session_info` 映射成会话名、`label` 映射成标签——后两者同时**仍以惰性条目留在链上**，因为 CLI 的下一行会挂在它们的 id 上。认不出的类型也照此处理：不认识不等于可以丢，丢了它后面所有行就全断了。

### 旧会话怎么办

H/20 之前建的 native 会话，头一行只有 v4，TUI 打不开。**在 app 里再打开一次就会就地升级**：`JsonlSessionStore` 在 resume 时（握着写锁）把第一行换成双格式头，走的是既有的 temp + rename 那条修复路径，其余每一行原样不动。入口守卫（`inspectPiTuiSessionSupport`）因此改为只拒绝「还没升级过的 v4」，拒绝文案也改成告诉用户怎么办。

### 验证

`src/runtime/__tests__/sessionInterop.test.ts`，**两边都是真实实现**：CLI 侧是 `pi --session` 背后的 `SessionManager`（按文件路径加载 `dist/core/session-manager.js` 的真实产物），GUI 侧是 `JsonlSessionStore`。打桩任何一边只能证明「我们对对方格式的想象自洽」，而那正是此前出错的地方。

7 条用例：四轮交替 · 改名与切分支后 CLI 仍读得到 · 压缩尾巴双向 · CLI 能写的全部行型（含一种「未来版本才有」的未知行型） · 孤儿父指针仍要拒绝 · 旧头升级。

**五处反向验证全部判红**（抽掉实现，对应用例当场失败）：去掉头里的 `type` → 6 条红；去掉 bookkeeping 链 → 分支那条红；关掉 CLI 行容忍 → 6 条红；去掉压缩锚点 → 压缩那条红；关掉头升级 → 升级那条红。

### 顺带的两个结果

- **旧后端也能打开 native 会话了**：`piSessionPreflight.ts` 要求头里有 `type:"session"`，此前 native 文件在这里就被判为损坏。当天旧后端随 P6-5 退役，这条的现实意义变成了**回退更安全**——装回上一个安装包，那个版本的引擎与终端仍读得到这期间的对话。
- 反过来，导入路径要多一道门：`convertLegacySession` 现在会显式拒绝 `kind:"header"` 的文件，否则一份 native 会话会因为「有 `type:"session"`」而被当成旧文件重新导入一遍。

### 真实应用点验（2026-09-13，开发机）

`scripts/run-p6-native-default-probe.mjs`，**不设 `AICLIENT_RUNTIME_BACKEND`**——跑出来的就是「什么都不配时用户会得到什么」。四条判据全通过（[报告](p6-native-default-report.json)）：

| 判据 | 实测 |
|---|---|
| 默认后端是 native | 真实回合弹出的是**结构化中文权限卡**（「直接允许 / 本会话内允许 / 直接拒绝」），不是 legacy 那张英文 `ui.select`。这是两个后端唯一可靠的界面指纹 |
| 一整回合跑通 | 模型 `grok-4.6`，发「用 bash 运行 echo p6-native-default-ok」→ 权限卡 → 放行 → 命令输出回到时间线（[截图](p6-native-default-after-turn.png)） |
| H/20 头一行真的是双格式 | 应用写到磁盘的那个会话文件：`{"kind":"header","version":4,…,"type":"session","timestamp":"…"}` |
| pi CLI 能打开这个真文件 | 用随包 `SessionManager` 打开**应用刚写的那个文件**，读回 4 条消息（user / assistant / toolResult 齐全） |

**内嵌 Pi 终端也真的开起来了**（这是计划里 I5 的核心那半）：`piTui.sessionSupport` 对这个 native 会话回 `{supported:true}`，`piTui.open` 起了真实 PTY 跑 `pi --session <该文件>`，回流 **34,985 字节**终端输出，没有 `not a valid pi session`，而且 **`p6-native-default-ok` 出现在 TUI 画出来的屏幕缓冲里**——终端确实渲染了这段对话。

两点如实记下来：

- 终端是**通过 preload 的真 IPC 打开的，不是点右上角那个 GUI/TUI 开关**。合成点击与真鼠标事件都没能让那个分段控件切过去（`aria-pressed` 始终停在 GUI），日志里也没有任何 TUI 相关报错——**这是探针驱动不了这个控件，不是应用拒绝**。要验的那条链（入口守卫 → node-pty → `pi --session`）IPC 打的是同一条，但「用户点那个按钮」这一下仍未点过。
- 截图里看到的还是 GUI 界面：终端是在后台起的，证据是数据流不是画面。

**退役之后又跑了一遍。**删掉旧引擎、删掉后端开关、把 RPC server 的三个工厂改成必填之后，同一个探针原样再跑：五条判据仍全过（应用起得来、真实回合跑通、双格式头、pi 读得回、终端真开）。这是这次删除最要紧的一条证据——改的是每个 worker 都要走的入口。

### 未验

- **GUI↔TUI 交替的完整一圈**：本轮验到「TUI 能打开并渲染这条 native 会话」，没有在 TUI 里继续聊、再回 GUI 看是否接上。
- 并发写入仍靠 `writerLock.ts` 与 `PiTuiExclusiveGuard` 挡，本轮没有新证据。
- CLI 版本漂移：结论只对随包的 0.84.4 成立。

## P6-1 默认切 native

`readRuntimeBackend` 先改为「只有精确的 `legacy` 走旧引擎」，并用真实 worker 进程验过三种取值（不设 / 打错字 / `legacy`）。**同日 P6-5 执行后，这个开关连同旧引擎一起删除**：没有第二个引擎可选，留一个不起作用的开关只会让人以为还能切。`RuntimeFlags.backend` 保留为常量 `'native'`，因为 trace 版本戳要记引擎名，归档 trace 与今天的 trace 才能逐字段比。

**真实应用里也验了**：不设变量启动，跑一条要用 bash 的指令，弹出来的是 native 那张结构化中文权限卡——见[上面的点验](#真实应用点验2026-09-13开发机)。

app 侧的前置条件已核对：worker 环境里的 `PI_CODING_AGENT_DIR` 自 H/19 起**无条件下发**，所以 native 默认后仍找得到 agent 目录；模型目录由 Main 在内存里交付（P5-5），托管与本地两种模式都不依赖那两个明文文件。

## P6-2 摘除依赖

### 做完的：native 装机的 worker 现在一行 pi-coding-agent 都不加载

两处，缺一不可。

**加载链**。worker 入口静态 import → RPC server → `piUtilityRunner.ts` → 整包 pi。这条链**与用哪个后端无关**：native 会话也照样在启动时把旧包载进进程。改为值层面延迟加载（类型导入保留，运行期不加载）。

**最后一个真用户**。一次性补全（「AI 小功能」：起标题、摘要、小改写）此前在 native 装机上仍然跑 pi 的 `ModelRuntime`——这让「我们的 agent 不再跑在别人的整包上」这句话在一个没有会话测试能发现的角落里是假的。新增 `src/runtime/worker/nativeUtility.ts`：模型来自会话用的同一份目录（`createRuntime` 不传 `tools`/`session` 时只组装模型适配器），流式调用是 `streamSimple` + `toolChoice:'none'`。**故意不走 agent loop**——loop 意味着回合、工具、权限和转录，让起标题这种请求有能力碰工作区是不对的。后端选择仍在 worker 入口以工厂注入，RPC server 一行没为它增加分支。

顺带修掉一处 pi 版也有的问题：**取消不再依赖 provider 认账**。原实现取消后要等流自己报 `aborted`；provider 不理会 abort 时，Main 那边这个操作永远等不到终态。现在 `cancel()` 当场结算（`finish` 幂等，流稍后报 abort 不产生第二次终态）。

### 怎么验的

两层，加一个阳性对照：

1. **静态**：`nativeWorkerDependencyBoundary.test.ts` 从 worker 入口走静态导入图，断言图里没有任何 `@earendil-works/*`。它自己先断言确实走到了该走的模块，否则扫描器空转也会通过。（退役后这张图从 32 个文件缩到 10 个——旧引擎本来占了三分之二。）
2. **实测**：`nativeWorkerModuleLoads.test.ts` 用 Node 的 module hooks 记录真实 worker 进程解析过的**每一个** specifier，bootstrap 与 utility 两种请求各跑一遍，断言没有一条是 pi-coding-agent。**阳性对照**是这个测试的意义所在（「什么都没记到」不能算通过）：退役前由 legacy 引擎充当，退役后改为另起一个进程真去 import 那个包，断言记录器确实记到了。
3. **反向验证**：抽掉 worker 入口注入 utility 工厂的那一行，实测用例当场判红，报错正文变成 pi 自己的 `No Pi model with configured authentication is available`——正好说明此前跑的是 pi 那份。

### 口径：用户 2026-09-13 选 A——保留为随包可执行文件

`package.json` 里保留这个名字是**这条口径的结果，不是遗留**：内嵌终端与插件管理跑的就是它的 `cli.js`，按字面删掉等于下线这两项功能，并让 P6-4 的回退开关没有回退对象。

第三道守卫随决定一起落地：`piCliIsBundledToolOnly.test.ts`。它拦两个方向——

- **任何一处** import 这个包都当场点名文件（旧引擎在时这里曾有一条允许名单，退役后已清空）；反向验证过：往 `src/runtime/bootstrap.ts` 加一行 import，测试立刻报出这个文件名。
- 反过来断言终端与插件管理**仍在以进程方式**用它。这是保留它的唯一理由，理由没了就该真删——把这条写成断言，是为了让「为什么还留着」这件事以后不用靠人记得。

**成功标准第 3 条按实质达成签收**：native 装机跑的 agent（会话、导入、一次性补全）没有一处在这个包上，进程实测零加载。**同日 P6-5 执行后允许名单已清空**——现在是「应用代码里一处都不许 import」。

## P6-3 六项成功标准

| # | 标准 | 状态 |
|---|---|---|
| 1 | 完整多轮对话（工具 / 审批 / 压缩） | ✅ P4-4 端到端 + P1-6 真机审批（[记录](../p4-6/perm1/README.md)）+ P2-3/P2-4 压缩持久化 |
| 2 | 缓存命中率 ≥ 旧后端 | ✅ 同网关 native 99.97% / legacy 99.97%，差 -0.0073 个百分点（[对比](../p2-5/comparison.md)） |
| 3 | pi-coding-agent 移出 package.json | ✅ **按口径 A 签收（实质达成）**：同日退役旧引擎后，**应用代码里一处都不再 import 它**（守卫允许名单已清空），worker 进程实测零加载。包体保留是口径 A 的结果——终端与插件管理要跑它的 `cli.js` |
| 4 | GUI 功能无回归 | 🟢 **开发机已点验**：默认 native 下真实应用起得来、一整回合跑通、权限卡与时间线正常（见上）；**打包产物的回归仍并入最后一次上机** |
| 5 | 旧会话仍可读可 resume | ✅ P3-3 + test.12 现场 v3 resume；H/20 后新增反向能力：native 会话也能被 TUI / legacy 打开 |
| 6 | 加密机现场验收（D11） | ⬜ 按用户 2026-09-11 决定推迟到最后一次上机。H/20 让其中「Edit/Write 后 TUI 与编辑器一致」这一动作重新**可执行**——此前 native 会话根本进不了 TUI |

## P6-4 回退窗口（当天开、当天关）

先按节点交付：开关保留、方向反转、期限写明，回退路径用真实 worker 进程验过（`legacy` 确实起旧引擎）。随后用户决定提前退役，开关与旧引擎一并删除，**回退方式改为装回上一个安装包**。[回退说明](../../../../../pi-only-rollout-rollback.md)与[迁移说明](../../../../../pi-only-migration.md)已按此改写。

代价在问的时候就写明了：出问题不能靠环境变量切回去。仍然成立的是——H/20 让会话文件同时满足两种格式，**装回旧包也读得到这期间的对话**。

## P6-5 旧集成层退役（同日执行）

删掉：`piWorkerSession.ts`、`piAgentSessionBootstrap.ts`、`piLegacyImport.ts`、`piUtilityRunner.ts`、三个只服务旧引擎的 spike、后端开关 `src/shared/runtimeBackend.ts`、以及 P2-0 的旧后端采集器。RPC server 的三个引擎工厂从可选改成**必填**——没有第二个后端可回落时，缺一个就该在构造时炸，而不是运行到一半才发现。

**执行时查出三件与计划不符的事**，都记在[施工计划](../../topics/p6-cutover.md#p6-5-旧集成层退役2026-09-13-已执行)里：

1. `piSessionPreflight.ts` **不能删**——清单原写「只服务 legacy worker」是错的，自有 runtime 也在用；按原清单删会当场打断 native。
2. **派生明文 `models.json` / `auth.json` 不能删**——它现在服务的不是旧后端，而是随包的 `pi` 可执行文件（`ModelRuntime` 默认就读这两个路径），而终端与插件管理按口径 A 继续存在。这条债因此从 P6 名下移出，改判为「终端凭据怎么给」的独立题。**这是本批唯一一处「计划说删、实际留下」的地方**，留下的理由是查出来的，不是忘了。
3. 两处测试**搬家而不是删**：排队释放的端到端用例移到 runtime 侧（真实 RPC server + NativeWorkerRuntime，FIFO 断言反向验证过）；Codex 导入集成用例收敛为 Main 侧那一半，落盘与读回由 `nativeImport.test.ts` 和 `sessionInterop.test.ts` 接手。

## 本轮自动化

- 全量测试：**397 文件 / 5610 测试通过**（批前 397 / 5634）。文件数与用例数比批中峰值（402 / 5659）低，是 P6-5 把旧引擎连同它自己的测试一起删了——**本批新增的用例都还在**：互通 7 条、一次性补全 6 条、依赖守卫 3 道、排队释放 1 条。
- 三套 tsc（根 / `src/runtime` / `src/agent-host`）通过。
- **真机点验已做**（开发机，默认 native + 真实模型 + 内嵌 Pi 终端，见上）；**未打包**，打包产物的回归并入最后一次上机。
