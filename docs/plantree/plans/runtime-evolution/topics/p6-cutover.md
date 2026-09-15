# P6 切换：默认 native、摘除依赖、回退窗口与旧层退役

Role: implementation-plan。日期：2026-09-13。对应节点 [P6-1～P6-5](../README.md#p6)，前置 [H/20 会话互通](gui-tui-session-interop.md)（已落地）。

## 本批开工时发现的冲突（必须先记下来）

ARD 成功标准第 3 条要求「`pi-coding-agent` 从 package.json 移除」，写这条时**它只是一个库**。后来 H/18～H/20 让它多担了两份活，于是「删掉它」不再只是换一个 runtime：

| 它现在担的活 | 代码位置 | 删掉后会发生什么 |
|---|---|---|
| 旧后端（P6-4 回退的目标） | `src/agent-host/` 整层 | 回退开关没有可回退的对象 |
| 内嵌 Pi 终端（TUI） | `src/main/services/terminal/PiTuiPty.ts:75` 跑它的 `dist/bundle/cli.js` | 终端模式消失；ARD 成功标准第 6 条里「Edit/Write 后 TUI 与编辑器看到的内容一致」这条现场验收也就没法做 |
| 插件的装 / 卸 / 列（H/19） | `src/main/services/piPlugins/index.ts:28` 用同一个可执行文件 | 插件管理界面背后没有执行体 |

ARD D8 同时写着「开关保留一个版本周期后再删」。当天用户对这两件事各拍了一次板，见下。

### 决定一 · 口径 A（用户 2026-09-13 拍板）

**保留 `pi-coding-agent` 作为随包的可执行文件，放弃它的库角色。**

- **不删包**：`package.json` 与打包产物继续带它，因为内嵌终端与插件管理跑的就是它的 `cli.js`。
- **库角色收回**：应用代码里除旧引擎（`src/agent-host/`，回退窗口内还要能跑）外一处都不 import 它。
- **成功标准第 3 条按「实质达成」签收**：我们的 agent（会话、导入、一次性补全）没有一处跑在这个包上，native worker 进程实测零加载。
- **旧引擎退役（P6-5）同日执行**，允许名单已清空：应用代码里一处都不再 import 它。

这条口径有两道可执行守卫，不靠自觉：

| 守卫 | 它拦什么 |
|---|---|
| `piCliIsBundledToolOnly.test.ts` | **任何一处** import 都当场点名（允许名单为空）；同时反过来断言终端与插件管理仍在以进程方式用它——**保留它的唯一理由**，这个理由没了就该真删 |
| `nativeWorkerDependencyBoundary.test.ts` | 从 worker 入口走静态导入图，图里不许有任何 `@earendil-works/*` |
| `nativeWorkerModuleLoads.test.ts` | 真实 worker 进程实测一行都不加载它；另起一个进程真加载它作阳性对照（旧引擎退役前这个对照由 legacy 充当） |

### 决定二 · 提前退役（用户 2026-09-13 拍板）

**不等一个版本周期，当天就执行 P6-5。**代价在问的时候就写明了：回退开关随旧引擎一起消失，出问题只能装回上一个安装包。用户在这个前提下选了立即退役。

## P6-1 默认切 native（已落地）

`readRuntimeBackend` 先反了过来：只有精确的 `legacy` 走旧引擎，其余一律 native。判读规则本身没变——**不认识的取值一律读成「当前在发布的那个引擎」**，变的只是那个引擎是谁。

同日 P6-5 执行后，这个函数连同 `src/shared/runtimeBackend.ts` 一起删除：没有第二个引擎可选，留着一个不起作用的开关只会让人以为还能切。`RuntimeFlags.backend` 保留为常量 `'native'`，因为 trace 的版本戳要记引擎名，归档的 trace 与今天的 trace 才能逐字段比。

## P6-4 回退窗口（已落地，窗口当天关闭）

- 当天先按节点交付：开关保留、方向反转、期限写明、回退路径有真实 worker 进程测试。
- 随后按决定二提前退役，开关一并删除。**现在的回退方式是装回上一个安装包**，[回退说明](../../../../pi-only-rollout-rollback.md)已按此改写。
- 回退仍然安全的那部分：**H/20 让会话文件同时满足两种格式**，旧版本的引擎与终端都能打开这期间产生的对话。

## P6-2 摘除依赖：清单

### 本批已做

- `piUtilityRunner.ts` 的 pi 导入改为**值层面延迟加载**（类型导入保留，运行期不加载）。此前 worker 入口静态 import → RPC server → 这个文件 → 整包 pi，**native 会话也照样把旧包加载进进程**。
- **一次性补全搬到自有 runtime**（`src/runtime/worker/nativeUtility.ts`）。它是 native 路径上最后一个真的会用到 pi 的地方；后端选择沿用 P5-4 的工厂注入，RPC server 不新增分支。顺带修掉 pi 版也有的一处问题：取消不再依赖 provider 认账，`cancel()` 当场结算。
- 两层守卫加一个阳性对照：静态导入图（`nativeWorkerDependencyBoundary.test.ts`）+ **真实进程的模块加载实测**（`nativeWorkerModuleLoads.test.ts`，legacy 必须记录到 pi，native 的 bootstrap 与 utility 都不许有）。

### 同日全部做完（P6-5 一并执行）

1. ~~功能缺口先补：一次性补全仍走 pi。~~ **完成**，见上。
2. ~~旧引擎代码。~~ **完成**：`piWorkerSession.ts`、`piAgentSessionBootstrap.ts`、`piLegacyImport.ts`、`piUtilityRunner.ts`、RPC server 的 `loadSdk` 分支与三个只服务旧引擎的 spike 全部删除。
3. **派生明文文件：改判，不删。**查证后确认它现在服务的不是旧后端——随包 `pi` 的 `ModelRuntime` 默认就读 `<agentDir>/models.json` + `auth.json`，而终端与插件管理按口径 A 继续存在。停写等于让 TUI 没有模型可用。要消掉明文落盘得另开一题（终端凭据怎么给），不在本节点范围。
4. 打包与脚本：**按口径 A 不动**，`cli.js` 仍要随包。
5. 清单：**按口径 A 不动**。
6. 守卫：`piCliIsBundledToolOnly.test.ts` 允许名单清空；`t31PiOnlyAbsence.test.ts`、`packaging-config.test.mjs`、`PiTuiPty.test.ts` 继续断言这个包**存在**——这正是口径 A 要的。

## P6-5 旧集成层退役（2026-09-13 已执行）

用户当日决定不等一个版本周期。`src/agent-host/` 现在只剩「worker 载体 + RPC 协议」这一层。

| 保留 | 删除 |
|---|---|
| `worker.ts` 入口、`workerHost` 载体、RPC 协议与类型、`piWorkerErrors.ts` | `piWorkerSession.ts`、`piAgentSessionBootstrap.ts`、`piLegacyImport.ts`、`piUtilityRunner.ts`、三个只服务旧引擎的 spike |
| 会话时间线/树的投影（`piSessionTimeline.ts`、`piSessionTree.ts`）、`permissionPlugin` 的用户配置判定等 Main 在用的部分 | 后端开关 `src/shared/runtimeBackend.ts` 与 `RUNTIME_BACKEND_ENV` |

> **2026-09-15 更正（T025 / 审计 cutover-05、cutover-07）**：上表「保留」一栏当时把 `bundledFeaturePlugins`、`extensionInventory` 也列了进去，这是错的——两者在 P6-5 之后就只剩自己的测试在 import，Main 读的是 `bundledPlugins.mjs` 那张表。它们连同 `commandInventory` 已在 T025 删除。`permissionPlugin` 确实还有一个生产消费者，但只剩 `permissionPluginConfiguredByUser`（插件页读用户自己的 pi 配置）；同文件的注入决策与加载校验同批删除。

### 执行时查出来的三件事（都和原计划不一样）

1. **`piSessionPreflight.ts` 不能整体删，但清单原写「只服务 legacy worker」也不准确**。`src/runtime/worker/nativeWorkerRuntime.ts` 只 import 了其中的 `samePiSessionPath`——一个 3 行的路径比较助手；文件主体 `preflightPiSessionFile`（64KB 分块头部扫描、JSON 校验、dev/ino 身份校验，共 106 行）与 `assertPiSessionFileIdentity` 原本服务旧集成层的调用方（`piWorkerSession.ts` 等），P6-5 删掉这些调用方后，两者在全仓已无任何生产调用方，只剩自身测试。按原清单整体删会打断 native 需要的 `samePiSessionPath`，但保留整份文件的说法（README.md「自有 runtime 也在用」）过度夸大——真正需要保留的只是那一个路径比较助手；文件其余部分是否删除评估留给 T025（审计 cutover-12，T027 改写此句）。
2. **派生明文文件不能删**，理由见上（随包 CLI 自己要读）。这条债从 P6 名下移出，改判为「终端凭据怎么给」的独立题。
3. **两处测试要搬家，不是删**：
   - 排队释放的端到端用例（原 `scripts/__tests__/pi-queue-release-integration.test.mjs`）驱动的是旧引擎，已移到 `src/runtime/__tests__/queueReleaseIntegration.test.ts`，改用真实 RPC server + NativeWorkerRuntime。**渲染层那两个排队模块没有一起 import**：它们经 `attachments.ts` 牵进 `@shared/*` 与 `@/` 两套路径别名，而 `src/runtime` 是独立子包、tsconfig 里没有这些别名；释放顺序在测试里按同样的步骤手写，排队模块自身的行为由渲染层单测钉住。
   - Codex 导入集成用例（`CodexImportIntegration.test.ts`）原本「转写 + 用旧写入方落盘 + 用 pi 读回」，现收敛为 Main 侧那一半（转写正确、源文件零改动）；落盘与读回那一半由 `nativeImport.test.ts` 与 `sessionInterop.test.ts` 覆盖。
4. **P2-0 的旧后端采集器 `scripts/runtime-baseline/run.mjs` 一并删除**——它跑的就是这个引擎。已采的基线原样留档、`verify.mjs` 仍能离线复核，但**再也采不了第二份**。ARD §5 当初要求「趁旧后端还在时把基线采完」，正是为了这一天。

### RPC server 的形状变化

三个引擎工厂（`createRuntime` / `createImportWriter` / `createUtilityRuntime`）从可选变成**必填**：以前「不传就回落到 pi 那份」，现在没有可回落的东西，缺一个就该在构造时报错而不是运行时才发现。`PiWorkerSessionOptions` 随旧引擎消失，改名 `PiWorkerRuntimeOptions` 留在 RPC server 里，少掉两个只有旧引擎用的字段（`loadSdk`、`decidePermissionGate`）。

## P6-3 六项成功标准

逐条状态见[验收记录](../evidence/p6/README.md)。本批能在开发机签的已签；第 6 条（加密机现场）按用户 2026-09-11 的决定并入最后一次上机。
