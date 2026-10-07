# 决策 147：P1-12 退役自有 runtime——用户裁决与实现取舍

日期：2026-10-01。**状态：第一节为用户裁决；第二节起是实现方的自主决定，待用户审批。**

依据：[决策 130](130-user-rulings-2026-09-29-batch3.md)（P1-12 已授权）；施工方案 [topics/p1-12-retire-runtime.md](../topics/p1-12-retire-runtime.md)（清点、四步施工、风险）。

## 一、用户裁决（2026-10-01，答复「按建议」）

1. **Q1 第 4 步**：先做第 1～3 步；Windows 整包 CI 通过后再做第 4 步（删掉整个 `src/agent-host`、内部改名）。改名只改内部标识符和文件名；`pi_session_*` 错误码、`AICLIENT_PI_WORKER_CAPACITY`、IPC 名、设置键、会话索引里的 `agent: 'pi'` 都不改。
2. **Q2 整包 CI**：第 1 步和第 3 步之后各推送一次并手动触发 `build.yml`（属于决策 130 已批准的「推送 + Windows CI」）。
3. **Q3 `models.json`**：P1-12 不动，需要时另开小任务。
4. 第 3 步改写 `THIRD_PARTY_NOTICES.md` 前，把改动给用户过目。

## 二、实现取舍（各步实现方追加）

### 第 1 步：产品与安装包断开 native worker（2026-10-01，基线 `3da90e37`）

1. **首屏判据**：`PiRuntimeChecker` 改用 `resolveDshHostLayout`，与 `DshHostSupervisor` 启动宿主是同一个函数，两边不会判得不一样。打包时查 `resources/node-runtime/node(.exe)` 和 `resources/dsh-host/host.js`；未打包时查 `out-node-runtime/node`（或 `AICLIENT_DSH_NODE`）和 `src/dsh-host/host.ts`。`workerVersion` 改为 `'dsh-host'`。只有 `DSH_HOST_MISSING` 判为 `unavailable`，其他异常照旧上抛，由 IPC 报成 `detection-failed`。布局输入可以注入，便于测试。
   - 副作用：开发机没取随包 node 时，首屏就会进「runtime 不可用」；以前要等到第一次开对话才失败。这本来就是宿主起不来的情况，提前说出来不算坏事。
   - 首屏这句提示原来写的是「没有找到随包的 Pi worker 运行时。」，改为「没有找到随包的对话引擎。」（英文 key 同步改）。
2. **权限设置页的 bundled 层**：在 `src/shared/permissions/policy.ts` 加 `bundledPolicyScope()`，路径记作 `bundled`。宿主的 `loadPermissionPolicy` 和 Main 的设置页共用它，不再读 agent-host 产物里的 `config.json`。
   - `resolveScopeLocations` 只列有文件的两层（global、project）。`readPermissionPolicy` 把 bundled 放在最前，合并顺序不变。
   - 渲染层的 `ScopeRow` 加 `onDisk`：bundled 行不显示路径，也不显示「在文件管理器中显示」按钮。reveal 的 IPC 只接受绝对路径。
   - `permissionPolicy.mjs` 本身仍在 `src/agent-host/`，按方案第 3 步再挪；挪的时候只改 `policy.ts`、`pathPolicy.ts` 的 import。
   - `dev.js` 不再往 agent-host 的 node_modules 写开发用的 `config.json`。
3. **Main 删除**（连同各自的测试）：`PiWorkerProcess`、`PiUtilityService`、`PiImportProcess`、`NativeSessionIndexAdapter`、`nativeSubagentSettings`、`subagentCatalog`、`ipc/piSubagents.ts`、桶文件 `agent-host/index.ts`；另删 `piWorkerEnv.test`、`nativeFeatures.test`。
   - `WorkerManager` 删掉导入的三个方法、三个选项、三个字段和 `disposeAll` / `forceKillAllNow` 里释放导入槽位的两段，以及 `readSubagentSettings`、`readPromptCacheTtls`、`readProviderTimeout`。`WorkerManager.test` 删掉 4 个导入用例。
   - `WorkerTransport.ts` 只留接口。`WorkerTransport.test` 只测那两个已删的工厂，所以整个删掉。
4. **bootstrap 停发**：`subagents`、`promptCacheTtl`、`subagentPromptCacheTtl`、`providerIdleTimeoutMs` 都不再发。
   - `createPiWorkerSlot` 里转发这几个字段的代码，以及 `workerRpc` 的类型字段，留到第 3 步：已经没人传，留着是死代码，但不碍事。`createPiWorkerSlot.test` 里的转发用例照旧。
   - 主会话 TTL 和超时仍经模型计划送到宿主（决策 040）。`promptCacheSettings` 只删子代理那一半。
5. **测试改写**：
   - `piWorkerEnv.test` 里仍然有效的 `getPiResourceSettings` 断言（HOME 覆盖、appSkills 路径、route）搬进新的 `piModelConfig/__tests__/piResourceSettings.test.ts`。
   - `vaultIntegration` 改为断言 DSH 宿主启动（`buildDshHostLaunch`）的 argv 和 env 里没有凭据。这样「凭据不进子进程环境」这条边界还有测试守着。
6. **Skills 页的数据收窄**：`PiResourceSettings` 收窄为 `{ managed, paths: { sharedSkills, appSkills } }`。
   - 删掉 `UpdatePiResourceSettingsRequest`、IPC 常量 `PI_RESOURCES_UPDATE_SETTINGS`、`PI_RESOURCES_OPEN_PROMPTS`、8 条 `PI_SUBAGENTS_*` 和 preload 的对应桥。`getAppPiPromptTemplatesDir` 没有调用方了，一起删。
   - 设置键 `enablePiSubagents`、`piOptInFeatures`、`PI_SUBAGENTS_FEATURE_ID` 留着：旧资产提示（决策 116 第 9 条）和 `MAIN_OWNED_SETTING_KEYS` 还在用。
7. **渲染层**：删 `PiSubagentsSettings.tsx`、`subagentManagementModel.ts`。设置键 `subagentPromptCacheTtl` 从类型、默认值和 setter 中删掉，并加进 `REMOVED_SETTING_KEYS`，旧配置加载时会被清掉。只被这两个页面用的 i18n 词条这一步不删（方案标为可选），以后和 runtime 专用的词条一起清。
8. **scripts**：
   - 删 `build-agent-host.mjs`、`agent-host-build-lib.mjs`、`packaged-worker-smoke.cjs`、`packaged-worker-report.mjs`（含两个测试）。方案点名的 9 个 `run-*` 探针和 `probes/` 下的 6 个也删了。
   - `afterPack` 只拷 DSH 宿主和 node。
   - `verify-packaged-app`：
     - 删掉 worker 的结构检查、TSD 头检查、256 MiB 上限和 Electron 冒烟。
     - `--skip-smoke` 参数一并删除，再传会报 unknown argument。
     - 新增检查：`resources/agent-host` 存在即失败。
     - DSH 产物超预算时，打印 `node_modules` 下最大的 10 个目录。复用的 `topDirectories` 原来只有 worker 那段在用。
   - `packaging-budget` 删 worker 上限。
   - `assert-build-target.mjs` 的注释提到了已删的 `build-agent-host`，顺手改了（方案原列在第 3 步）。
9. **build.yml**：
   - 三个打包 job 都删掉三步：安装 agent-host 依赖、安装 runtime 依赖、构建 worker 产物。macOS 只能手动触发，但同样不该再构建 worker，所以也删了。
   - 「Verify packaged Pi worker」改名为「Verify packaged app」。
   - Linux 去掉 `xvfb-run`：它只服务于已经删掉的 Electron worker 冒烟，DSH 冒烟跑在随包 node 上。
   - 报告文件 `dist/worker-smoke-report.json` 和 artifact 名 `worker-smoke-*` 不改名，里面只剩 DSH 的内容。
   - gate 不动（第 3 步再动）。
10. **`.gitignore` 的 `out-agent-host/` 和 `biome.json` 的 `!**/out-agent-host` 留着**：旧检出里还有这个目录（本机 132 MB）。去掉忽略后，`git status` 会列出它，`pnpm lint` 也会去扫它。等第 3 或第 4 步、产物清掉以后再删。本地的 `out-agent-host/` 没有删，交用户决定。
11. **`runtimeRetiredStatic` 第 1 步加的几条**：
    - 方案 §1.11 写「最后两条第 1 步先加」，§2 写「前两条」，两处说法不一致。这里的处理是：凡是第 1 步结束时已经成立的，都现在加上。
    - 已加的：Main 和 preload 里没有 `utilityProcess.fork` 和 `PiWorkerProcess`；`PiRuntimeChecker` 和权限策略服务不引用 worker 入口或产物；afterPack 不拷 agent-host；`package.json` 和 build.yml 里没有 `build-agent-host`；verify-packaged-app 带反向检查。
    - 第 3 步再补：`src/runtime` 不存在、没有 import 指向 `runtime/`、根依赖里没有 pi 包、build.yml 里没有 `src/runtime`。
12. **静态测试**：
    - `oneShotCompletionsStatic` 去掉了豁免，并断言文件已经不存在。
    - `legacyImportStatic` 第二个守卫的白名单改为空，并断言 `PiImportProcess.ts` 已经不存在。
    - `piResourcesSettingsStatic` 断言两个页面文件已经不存在。
    - `packaging-config` 删掉「worker package dependency boundary」整块，afterPack 的正则改为 `copyDshHost` 紧跟 `copyNodeRuntime`；agent-host `npm ci` 的断言换成反向断言：打包 job 不装 agent-host、不装 runtime，也不构建 worker。
13. **不动**：`src/dsh-host/tools/measure.ts` 里「missing: run pnpm build:agent-host」这句提示（方案 §1.7 要求保留）；`scripts/patch-pi-permission-system.mjs` 的注释（这个文件第 3 步删）。

### 第 2 步 A：权限用例迁移（2026-10-01，基线 `13bc19f5`）

逐条映射见 [evidence/p1-12-permission-case-map.md](../evidence/p1-12-permission-case-map.md)：原 126 例，迁入纯库 108 例，已有覆盖 8 例，N/A 10 例，**判定差异 0 例**。本步只新增测试，`src/runtime`、`src/agent-host` 和产品代码一行未改。以下各条都是**自主决定、待审批**。

1. **怎么驱动纯库**（自主决定、待审批）：
   - 新增共用夹具 `src/shared/permissions/__tests__/gateHarness.ts`。它按 runtime bootstrap 的四步建闸门：工作区取 realpath，`scopes` 按 `canonicalPath` 解析，`loadPermissionPolicy`，`new PermissionGate`。这四步与 DSH bridge 的 `buildGate` 相同。文件工具走 `authorizeTarget`。
   - bash 走 `src/dsh-host/permissions/__tests__/bashHarness.ts`：先 `analyzeBash`（用 `loadBashParser`）加 `checkShellPaths`，再 `authorizeTarget`，最后重新分析并比对。这与 runtime `bash` 工具、DSH `requestBuilder` 的三步一致。
   - 没有改用 DSH 的 `authorizeCall` 或 `permissionHost`。它们属于 D 类，已有自己的测试；这里只驱动纯库。
2. **不执行命令和工具**（自主决定、待审批）：原用例里断言工具输出、读回写入内容的那半句删掉，并在注释里写明，共 7 处。只有一处后一条命令要用到前一条命令建的文件（`cat sub/*`），改由测试预先建好。
3. **按是否需要语法树分放**（自主决定、待审批）：
   - 需要语法树的 44 例进 `src/dsh-host/permissions/__tests__/`：`bashGate.test.ts` 39 例，`bashGateTools.test.ts` 5 例。
   - 其余 64 例进 `src/shared/permissions/__tests__/`。其中包括手写 bash 请求的授权与前缀用例，以及 shellPolicy 里不需要语法树的 8 例（纯函数 6 例、plan / 白名单 1 例、非法策略 1 例）。
   - 因此原文件里同一个 `describe` 会拆在两个地方，映射表逐条写明了去向。
4. **拆图与 drain 判为可迁，不判 N/A**（自主决定、待审批）：
   - 派工提示把「cordis 拆图与 drain」列为 N/A 的例子。但 `permissionQueue` 里这两例测的是纯库 API：拆图唤醒队列改用 `gate.dispose()`，drain 用 `createPermissionPrompt` 的 `drain`。
   - DSH 关会话时，`dshSessionRuntime.dispose` 也是先 drain 再 dispose，所以按「DSH 下存在」处理，照迁。拆图那一例相应改名为「…when the gate is torn down」。
5. **SA10 迁 5 例，3 例判 N/A**（自主决定、待审批）：
   - 迁的 5 例：署名、显式 auto 不越过 deny、继承 bypass、bypass 不越过 deny、作用域释放。
   - 判 N/A 的 3 例测「委派定义声明的档位」，属 C 类（分片 04 §3：DSH 的代理预设没有 `permission` 字段）。
   - `scopeToolCall` 仍在纯库里，但 DSH 没有调用它：DSH 的署名走请求自带的 `delegation`。这 3 例如果要保留，照抄即可，成本很小。
6. **skills 的 4 例照迁**（自主决定、待审批）：
   - 派工提示把「技能的可信路径」列为 N/A 的例子，但分片 04 把 skills 4 例算在 A 类。DSH 的 `skill` 调用走的是同一套 `policyValue` / `trustedPath` 规则，迁过来几乎不花成本，所以照迁。
   - 请求按 runtime `authorizeSkill` 的形状照抄。`/skill:name` 展开入口是 runtime 自己的（DSH 原生加载技能，决策 101），只迁它发给闸门的那次判定，用例相应改名。
7. **MCP 的 3 例判 N/A**（自主决定、待审批）：MCP 已搁置（决策 090），dsh-base 没有 MCP 服务器工具（分片 04 §3 C 类）。按 `policyValue` 匹配的规则已由 skill 用例和审计值用例覆盖。
8. **已有覆盖的不重写**（自主决定、待审批）：
   - `workerEndToEnd` 的 3 例、`nativeWorkerRuntime` 的 4 例，由 `permissionBridge.test.ts` 的 [perm-card-allow]、[perm-card-deny]、[perm-stop]、[perm-seed-*]、[setter-*]、[policy-project] 和 `perm-*` 录制覆盖。
   - tools 的「grep 跳过秘密文件」由 `permissionHost.test.ts` 的 search results 两例和 `perm-search` 录制覆盖。
9. **依赖 runtime 机制的判 N/A**（自主决定、待审批）：
   - 判 N/A 的有：`BASH_ENV`（runtime 自己的执行环境）、plan 下工具表裁剪（runtime 注册表）、trace 里的 `permission_decision` 与预览截断（runtime agent loop）。
   - 「requires approval for writes…crops plan mutation」的最后一句原来断言工具表里没有 `write`，改为断言闸门在 plan 下对 `write` 判 `deny`，用例名里的 crops 相应改为 refuses。
   - tools 的 D14 一例只迁两段文字和槽位名；拼接顺序是 runtime `composeSystemPrompt` 决定的，DSH 的顺序已由 `permissionHost.test.ts` 的提示词上下文用例覆盖。
10. **按内容命名，文件头注明出处**（自主决定、待审批）：
    - 新文件按测的内容命名：`cardOutcomes`、`sessionGrants`、`approvalQueue`、`delegateScope`、`gearsAndTools`、`shellPathSpellings`、`bashGate`、`bashGateTools`，不按来源命名。
    - 每个文件头写「Moved from src/runtime/__tests__/…」。第 3 步删掉 runtime 后，靠它追溯；以后从 main 合并 1.0.x 的权限修复时，也靠它对照。
11. **夹具的位置**（自主决定、待审批）：
    - 两个夹具 `gateHarness.ts`、`bashHarness.ts` 放在各自的 `__tests__/` 下，与 `fakeDsh.ts` 同例；dsh-host 的夹具 import shared 的夹具。
    - vitest 只收 `*.test.ts`，不会把夹具当用例。纯库的边界静态测试只扫 `src/shared/permissions/*.ts`，不扫 `__tests__/`，所以夹具可以用 `node:fs`。

### 第 2 步 B：解码链用例搬迁与只读回放对拍（2026-10-01，基线 `13bc19f5`）

由实现代理交回、编排者录入。迁移结果：三份解码链测试 22 / 15 / 6 例全搬，shared 与原实现没有结果差异；`sessionReplayReader.test.ts` 39 例。

1. **新文件命名**（自主决定、待审批）：按 shared 模块命名为 `legacyPiCodec`、`legacyPiTimeline`、`legacyPiTree.test.ts`，与已有的 `legacyPiCorpus` 同前缀，不沿用 `sessionCodec`、`piSessionTimeline`、`piSessionTree`。第 3 步用 `rg -a` 扫旧标识符时不会撞上新文件，同目录也没有大小写冲突。
2. **只改 import**（自主决定、待审批）：三份搬迁测试的用例主体与期望逐字未改，只换 import、加文件头；两边同时全绿，证明搬迁没有改变判定。
3. **tree 不补错误类型断言**（自主决定、待审批）：方案 §1.3 说的「改成 `LegacyPiSessionError`」那条断言不在 `piSessionTree.test.ts`，而在第 3 步整份删的 `legacyPiSessionWrappers.test.ts`；shared 一侧 `legacyPiSessionSeams.test.ts` 已断言 `LegacyPiSessionError` / `WORKER_TREE_UNAVAILABLE`，不重复。
4. **回放的对拍基准**（自主决定、待审批）：以 `fixtures/legacy-pi/golden/*.golden.json` 的 `history` 为准（`legacyPiCorpus.test.ts` 钉住的那份），只读不写；不用 `legacy-pi-dsh/*.projection.json`，那是转成 DSH 之后的投影，链路不同。
5. **严格解码与金样本的对应**（自主决定、待审批）：金样本在 `tolerateUnfinished` 下解码，回放器严格解码；金样本 `strict` 为拒绝的文件，按「回放被拒，`cause` 等于该 code」判定。另有一例写死「语料中被拒的恰好是这 4 份及其 cause」，防止拒绝分支空转。
6. **两处 cause 不同，按现状记录**（自主决定、待审批）：非法 UTF-8 取金样本的 `ERR_ENCODING_INVALID_ENCODED_DATA`；零字节文件由回放器自己的头检查拒绝、不带 cause（金样本记的 `session_invalid` 来自回放器不调用的 `firstRow`）。没有改生产代码。
7. **v1 派生 id 换算**（自主决定、待审批）：v1 没有 id，转换时用「路径加行号」的 sha256 派生；测试把金样本里按生成器路径派生的 id 换成按临时副本路径派生的 id 再比较。
8. **语料先复制再读**（自主决定、待审批）：每个用例把语料复制进自己的临时目录再读，并核对目录里只有这一个文件、mtime / 大小 / sha256 不变；即使将来回放器出现写盘回归，也不会污染夹具。
9. **`legacy-pi-v3-drifted` 不参加「原件 = 副本」对拍**（自主决定、待审批）：副本做完后原件又被续写，与 `legacyPiCorpus.test.ts` 的处理一致。
10. **旧断言的去向**：v4 可回放且不取写锁、v3 只在内存里转换、分页、未完成操作被拒、非会话文件与缺失文件、头里没有 cwd 时用索引的工作区，六组全部保留或改写，没有删掉仍有意义的断言；「非会话文件」语料里没有，测试里直接写一行纯 JSON。
11. **留给后续的过期注释**：`SessionReplayReader.ts` 文件头仍写「与 `JsonlSessionStore.history()` 对拍」；`modelMissingWiring.test.ts` 第 217、235 行引用 `piSessionTimeline`；`legacyPiSessionSeams.test.ts` 文件头说「1.0.x 行为由 runtime 自己的会话测试钉住」。第 3 步删文件时一并改指新测试。

### 第 3 步：删除 runtime、native worker 与根 pi 依赖（2026-10-03，基线 `36d1e02c`）

代码提交 4 个：`fe4b9b7e`（删 runtime 与 native worker，收窄协议）、`ce47554c`（根依赖与 lockfile、agent-host 子包清单）、`6b8e7d79`（策略表进 shared）、`f874bc19`（CI 与打包检查）。`THIRD_PARTY_NOTICES.md` 与两个必需字符串按用户裁决第 4 条先给用户过目，2026-10-03 用户同意后提交为 `30245837`。以下各条都是**自主决定、待审批**。

1. **接手半成品**：上一个代理 10-01 停在「`src/runtime` 已在工作区删除、策略表三个文件原样搬进 `src/shared/permissions/`、引用没改」。核对三个搬家文件与基线逐字节相同后接着做。搬来的测试 import `../../shared/defaultPaths.ts`，在新位置会指到 `shared/shared/`，改为 `../../defaultPaths.ts`。
2. **提交怎么拆**：
   - 顺序是「删 runtime 与 worker → 根依赖与子包 → 策略表进 shared → CI」。策略表放在依赖之后，因为基线里 `permissionPatchScript`、`permissionPolicyIntegration` 两个测试还 import 旧路径，它们随子包在第 2 个提交删除。
   - 为让每个中间提交的树自洽，`package.json`、`t31PiOnlyAbsence`、`defaultPaths`、`noHardcodedChinese`、`packaging-config` 五个文件先在前面的提交里放过渡版本，后面的提交再改成终版。全量验证只在最后的树上跑过；中间提交没有逐个跑测试。
3. **协议收窄（`workerRpc.ts`）**：按方案 §1.6 删除。另外：
   - 导入的三个 payload 守卫（inspect / reconcile / discard）也删了。方案只点名四个结果守卫，但 payload 守卫唯一的调用方是被删的服务端处理。
   - bootstrap 守卫不再校验 TTL 与超时字段。字段已从类型里删掉，旧 Main 发来的带这些字段的 payload 不会被拒，只是没人读；`workerRpc.test` 有用例钉住。`sameBootstrap` 去掉两项 TTL 比较。
   - `normalizeWorkerCapabilities` 只读 `skills`。带着 1.0.x 三项的清单保留技能数、其余丢弃；`WorkerMcpServerInfo` 一并删。`WorkerManager.test`、`chatPiWorkerRouting.test`、`sessionCapabilityModel.test` 的桩随之只剩 `skills`。
   - `ChatSlotBootstrapPayload` 改为 `WorkerBootstrapPayload` 的别名。`chatEngineDshOnly` 原来断言 `Omit<…, 'modelCatalog'>`，改为断言协议类型里已经没有 `modelCatalog`。
   - `createPiWorkerSlot` 删掉转发委派开关、两项 TTL、超时的代码（第 1 步第 4 条留下的死代码），对应用例改为断言这几个字段都不上线。
4. **`PiWorkerRpcServer`**：
   - `handleDispose` 只剩释放 runtime 一项，注释同步。
   - 新增用例：7 个退役方法都回 `WORKER_METHOD_NOT_FOUND`，并且不会建 runtime（风险 R9）。
   - bridge 里两个 `unsupported` 函数没有调用方了，一并删除。
   - 错误文案 `Pi utility worker is disposed` 不改，它是线上字符串。
5. **`runtimeToolVocabulary`**：方案写的是删掉「对照 runtime 注册表」一节。实际只删读注册表的部分（`registeredToolNames` 和两条对照用例）。逐工具的 `it.each` 改为遍历冻结下来的 `RUNTIME_TOOL_NAMES`（14 个 1.0.x 工具名），理由是迁移来的旧会话里仍有这些名字。
6. **其他渲染层测试**：
   - `permissionGate.test` 删掉「native runtime 是产出方」用例；store 与 `runtimeEvents.ts` 的注记改指 DSH 权限行与 bridge 的 `reportedGate()`。
   - `modelMissingWiring` 删 MMW-14、MMW-15 两条读 runtime 源码的断言及常量，MMW-16 保留。
   - `retiredSurfaceAbsence` 的允许名单去掉已删的 `nativeStreamReplay.test.ts`。
7. **`legacyImport.test`**：worker RPC 守卫那一例改为直接测 `isLegacyImportPathSegment`（Main 的 manifest 与 IPC 仍在用），另加一例 `isImportedConversation`（宿主的 `seedSession` 在用）。
8. **`skills.test`**：删掉「P5-1 slash expansion」一节（5 例），连同 `expand.ts`。
9. **`dsh-host-build-lib`**：permissions 行的 inputs 直接去掉旧路径，没有换成新路径。新路径已经在 `src/shared/` 前缀之内，再列一行是重复。
10. **边界静态测试**：
    - `permissionsLibraryBoundaryStatic` 新增一例：库内只有这一个 `.mjs`、它没有 import、旧位置不存在。`allowedTarget` 只认 `src/shared`。
    - 四个 `*BoundaryStatic` 删掉「旧位置是薄封装」一节，出处注记的正则保留；随之无用的 `read` 辅助函数一并删掉。`legacyPiSessionBoundaryStatic` 里 `SessionReplayReader` 那一例保留，`describe` 改名。
    - `noHardcodedChinese` 去掉 `runtime` 根，`agent-host` 下限 3（剩 4 个文件）。`defaultPaths` 的 `POLICY_PATTERN` 换路径，`RUNTIME_SUBPACKAGE` 删除。
11. **`runtime-baseline`**：
    - 删 `run-native.mjs`、`verify-native.mjs`。
    - `archive.mjs` 的不可比文案改为不再指向已删的脚本。
    - archive 测试的「接线」用例只钉 `compare.mjs`，并断言 `run-native.mjs` 已删。
    - README 的表格与采集说明标注「已删，要重跑须在 P1-12 之前的提交上开临时 worktree」。
12. **根依赖与 lockfile**（R3）：
    - 手改 `package.json`，跑 `pnpm install --lockfile-only --ignore-scripts`。前后核对共享 `node_modules` 的 `.modules.yaml`、`.pnpm/lock.yaml` 的修改时间不变。
    - lockfile 只删不增，删除 107 个包：pi 七件套，以及只经 pi-ai 进来的 Anthropic、OpenAI、Google、AWS Bedrock 等 SDK。`jiti@2.7.0`、`yaml@2.9.0` 只是改标为 optional。
    - 本机 `node_modules` 是软链、没有动，本机测试仍能解析这些包。CI 的 `--frozen-lockfile` 才能真正证明没有漏掉的引用；本地的替代证据是 `runtimeRetiredStatic` 的 import 扫描。
13. **agent-host tsconfig**：去掉 `spikes` 排除（目录已不存在），注释改写。子包没了以后，`vitest`、`@types/node` 从根 `node_modules` 解析，`typecheck:agent-host` 通过。
14. **app.asar 反向检查**（§4）：
    - asar 头的解析放在新模块 `scripts/asar-inspect.mjs`，方便单测；不依赖 `@electron/asar`。
    - 扫描范围是 `app.asar` 内任意深度的 `node_modules/<包>`，加上 `app.asar.unpacked/node_modules`。
    - Main 的标记字符串选了 5 个只有 runtime 定义、在 Main / shared / preload / 渲染层源码（含注释）里都不出现的标识符：`NativeWorkerRuntime`、`RUNTIME_CONFIG_VERSION`、`CONTEXT_ROLLOVER_SUMMARY`、`DEFAULT_AGENT_LOOP_CONFIG`、`resolveWorkerShell`。
    - `asar-inspect.test` 用假 app 目录直接跑 `verify-packaged-app`，证明两类失败都会报出、干净的包不报。
15. **`runtimeRetiredStatic`**：补齐第 3 步的断言，并入 `piCliIsBundledToolOnly` 的「不当库 import」规则：扩到三个包，扫 `src` 与 `scripts`，深路径也算。import 扫描按相对路径解析，避免 `@emnapi/runtime` 这类误报。
16. **注释回写**：第 2 步 B 第 11 条点名的三处已改指新测试。顺带改了 `questionCardModel`、权限闸门 store、`runtimeEvents`、`piModelConfig`、`stderrRedaction` 等处仍用现在时描述 native 产出方或已删文件的注释。
17. **不动**：
    - `.gitignore` 的 `out-agent-host/` 与 `biome.json` 的忽略：本地 132 MB 旧产物还在，交用户决定，同第 1 步第 10 条。
    - 根 `package-lock.json`：npm 旧锁文件，pnpm 不读，内容早已和 `package.json` 脱节，只在发版时同步版本号。方案没列，删它属于发布流程的改动。
    - 项目 `CLAUDE.md`、`README` 等文档：§1.12，由 P1-14 回写。
    - `measure.ts`、`p0-6-probe.ts`：§1.7。
    - 各处 `Moved from src/runtime/...` 出处注记：§1.1。
18. **验证**（本机，`f874bc19` 的树）：
    - 三套 tsc、`pnpm lint` 通过。lint 剩 8 条警告，都在 `docs/` 证据脚本与 `run-f3-dev-probe.mjs`，是基线就有的。
    - `Static Scan Wiring`：75 个文件 756 例。
    - `src/shared/__tests__`：29 个文件 402 例。
    - `scripts`：12 个文件 208 例。
    - bridge-smoke：66 项全过。
    - `bridge-record --check`：28 个场景 0 差异。
    - 真宿主集成：35 例。
    - `build-dsh-host`：82.6 MiB；L1 冒烟 44 项全过。
    - 全量单测分四批：
      - `src/renderer`：321 个文件 5299 例；
      - `src/main src/preload src/shared`：199 个文件 3286 例，跳过 1 个文件 35 例，即没开环境变量的集成测试；
      - `src/dsh-host src/agent-host scripts`：52 个文件 1034 例，跳过 2 个文件 11 例，是 win32 专用用例；
      - `src/__tests__`：1 个文件 2 例。
    - 打包检查只能在 CI 上验证，等推送后手动触发 `build.yml`（裁决第 2 条）。

### 第 4 步：搬家与改名（2026-10-07，基线 `d915a2a5`）

代码提交 3 个：`3d679576`（搬家、删 `src/agent-host`、同步引用）、`d26f4e6b`（内部改名）、`e890aa7c`（补改第一个提交漏掉的一处注释出处）。两类改动分开提交，可以按步 revert；第三个只改一行注释。以下各条都是**自主决定，待用户审批**。

1. **新位置**（都用 `git mv`，保留历史）：

   | 原路径（`src/agent-host/` 下） | 新路径 |
   |---|---|
   | `piWorkerRpcServer.ts`、`piWorkerErrors.ts` | `src/dsh-host/bridge/`（第二个提交再改文件名，见第 2 条） |
   | `__tests__/piWorkerRpcServer.test.ts` | `src/dsh-host/bridge/__tests__/` |
   | `stderrRedaction.ts` | `src/shared/stderrRedaction.ts` |
   | `__tests__/stderrRedaction.test.ts`、`__tests__/fixtures/credentialSamples.ts` | `src/shared/__tests__/`、`src/shared/__tests__/fixtures/` |
   | `codexItemMapper.ts` | `src/main/services/legacyImport/codexItemMapper.ts` |
   | `__tests__/codexItemMapper.test.ts`、`__tests__/fixtures/codex/`（18 个文件） | `src/main/services/legacyImport/__tests__/`、`…/__tests__/fixtures/codex/` |
   | `tsconfig.json` | 删除；根脚本 `typecheck:agent-host` 一并删除 |

   - 目录里没有 `node_modules` 软链（第 3 步已删），删完文件后只剩空目录，用 `rmdir` 逐级删除。
   - stderr 脱敏放在 shared 顶层，与 `dshPluginAllowlist.ts` 等单文件库同级。Main 的 8 处 import 改用 `@shared/stderrRedaction`；宿主凭据行与它的测试用相对路径 `../../shared/stderrRedaction.ts`（宿主 tsconfig 不声明 `@shared` 别名）。
   - `codexItemMapper.ts` 搬进 Main 后按 Main 的写法 import `@shared/types/...`，`CodexRollout.ts` 改为 `./codexItemMapper`。四个 legacyImport 测试和真宿主集成测试里的 codex 夹具路径同步。
   - 四个搬来的源文件开头加一行 `Moved from src/agent-host/…`，与 shared 各库的出处注记同例：以后从 main 合并 1.0.x 修复时（风险 R4），靠它找到对应文件。
   - `piWorkerErrors.ts` 用显式字段、RPC 服务端只有 `private` 字段修饰，没有枚举和参数属性，搬进开了 `erasableSyntaxOnly` 的宿主 tsconfig 后不需要改写。

2. **旧名 → 新名**（第二个提交 `d26f4e6b`）：

   | 旧名 | 新名 |
   |---|---|
   | 文件 `bridge/piWorkerRpcServer.ts`（及测试） | `bridge/bridgeRpcServer.ts`（`__tests__/bridgeRpcServer.test.ts`） |
   | 文件 `bridge/piWorkerErrors.ts` | `bridge/bridgeErrors.ts` |
   | `PiWorkerRpcServer` / `PiWorkerRpcServerOptions` | `BridgeRpcServer` / `BridgeRpcServerOptions` |
   | `PiWorkerRuntime` / `PiWorkerRuntimeOptions` | `BridgeSessionRuntime` / `BridgeSessionRuntimeOptions` |
   | `PiWorkerMessagePort` | `BridgeMessagePort` |
   | `PiWorkerSessionError`（含 `this.name`） | `BridgeSessionError` |
   | Main 文件 `services/agent-host/createPiWorkerSlot.ts`（及测试） | `createDshChatSlot.ts`（`__tests__/createDshChatSlot.test.ts`） |
   | `createPiWorkerSlot` / `CreatePiWorkerSlotOptions` / `CreatedPiWorkerSlot` | `createDshChatSlot` / `CreateDshChatSlotOptions` / `CreatedDshChatSlot` |
   | `WorkerManager` 日志前缀 `[pi-worker:…]`（4 处） | `[dsh-chat:…]` |

   - 命名的依据：服务端与运行时接口是「宿主 bridge 的 RPC」，前缀用 `Bridge`；`BridgeSessionRuntime` 的唯一实现就是 `DshSessionRuntime`。Main 一侧的槽位工厂与同目录的 `DshChannelTransport`、`DshHostSupervisor` 同用 `Dsh` 前缀，`Chat` 对上已有的 `ChatSlotBootstrapPayload`。
   - 日志前缀与新工厂名对齐。仓库代码和证据目录里的工具脚本都不解析这个前缀；`docs/` 下的历史证据（runtime-hardening 批次 D、E，P1-1 GUI、P1-5 真网关）里留着旧前缀，不改。以后在 main.log 里查旧版本的日志仍要用 `[pi-worker:`。
   - `this.name` 也跟着改成 `'BridgeSessionError'`。核对过它不上线：`errorPayload` 只发 `code`、`message`、`retryable`；bridge 别处把错误转成文本时都取 `error.message`；金样本里没有这个字符串，`--check` 0 差异。
   - 静态测试同步：`hostStatic` 的禁用词表（一次性补全不能用 RPC 服务端）换成新名；`chatEngineDshOnly`、`dshHostSupervisorStatic` 读的文件名换成 `createDshChatSlot.ts`。

3. **刻意没改的线上字符串与名字**（用户裁决第 1 条与方案 §6）：
   - RPC 方法名 `worker.*`、错误码 `WORKER_*` 与 `pi_session_*`、协议类型 `WorkerRpc*` / `WorkerBootstrapPayload` 等：Main 与宿主之间的线上协议，`--check` 必须 0 差异。
   - 错误文案：`Pi worker generation must be a positive safe integer`（服务端构造）、`Worker is not bootstrapped`、`Pi worker returned an invalid bootstrap acknowledgement`（`createDshChatSlot`）、`WorkerManager` 里约 20 条 `Pi worker …` 文案。它们会作为错误文本到达渲染层或日志，渲染层有按错误文本分流的地方（如 `historyError`），拿不准就不改。
   - 环境变量 `AICLIENT_PI_WORKER_CAPACITY`（用户设置）、`AICLIENT_PI_WORKER_GENERATION`（只剩 P0 探针 `measure.ts`、`p0-6-probe.ts` 给旧 worker 传，以及 `hostStatic`、`DshHostProcess.test` 的反向断言与桩）。
   - IPC 名、设置键、`PiRuntimeStatus`、会话索引的 `agent: 'pi'`、Main 目录名 `src/main/services/agent-host/`。
   - `WorkerManager`、`WorkerSlot`、`WorkerTransport`：名字里没有 pi，不在本次范围。
   - Main 的测试文件 `ipc/__tests__/chatPiWorkerRouting.test.ts` 与其中的 `describe('Pi WorkerSlot chat routing')`：它测的是 `pi:`/`chat:` IPC 一层，与 `PiRuntimeChecker` 等 pi 命名的 IPC 一起留给以后（§6「不在 P1-12 范围」）。
   - 两处描述已删代码的历史注释保留旧名：`modelMissingError.ts`（1.0.x 的 `piWorkerSession` 抛 `PiWorkerSessionError('WORKER_MODEL_NOT_FOUND')`，令牌按方案 §1.5 留着）、`legacyPiTree.test.ts`（第 3 步删掉的薄封装）。

4. **引用同步**：
   - `build.yml` 删「Gate 2/6 — typecheck:agent-host」，其余改为 1/5～5/5；超时注释加一句，值不变（20 分钟）。
   - `BRIDGE_ENTRIES`：bridge 行 inputs 去掉 `src/agent-host/`；凭据行改成 `src/shared/stderrRedaction.ts`。`dsh-host-build-lib.test` 对应的夹具路径同步。
   - `build-dsh-host` 的脏检查只剩 `src/dsh-host` 与 `src/shared`。
   - 根 `tsconfig.json` 的 exclude 去掉 `src/agent-host/**`；宿主 tsconfig 只改注释（它的 include 本来就不含 agent-host，靠 import 跟进）。
   - `noHardcodedChinese` 去掉 `agent-host` 根与它的下限 3；`esmShimStringTrap` 去掉 `agent-host` 根；`packaging-config` 的门禁列表与编号改为 5 道，并把 `typecheck:agent-host` 加进「已退役」的反向断言；`t31PiOnlyAbsence` 的迁移读取器名单改指新路径；`agentWireStatic` 改两处注释。
   - 注释：`WorkerManager` 与其测试里「见 `agent-host/piWorkerRpcServer.ts` 和 `runtime/worker/nativeWorkerRuntime.ts`」改指 bridge（后者第 3 步已删，顺带改掉）；`questionCardModel.ts` 里早已不存在的 `src/agent-host/codexDecisions.ts` 改写；`redact.ts` 的出处（第三个提交）。

5. **扫描覆盖的变化**：
   - `noHardcodedChinese` 不再扫 RPC 服务端和 Codex 映射：前者没有任何中文；后者的中文都在注释里，日志 note 由它自己的测试（T023 那一例）钉住不含中文，该例注释同步说明了这一点。stderr 脱敏随 shared 根照扫。
   - `esmShimStringTrap` 照扫 stderr 脱敏（shared）与 Codex 映射（main）；RPC 服务端只进 esbuild 打的宿主产物，不经过 electron-vite 的 shim，所以不扫。

6. **`runtimeRetiredStatic` 第 4 步守卫**（新 `describe`，3 例）：`src/agent-host` 不存在；`src`、`scripts` 下没有任何相对 import / `vi.mock` 指向它（按相对路径解析，Main 自己的 `services/agent-host` 不算，并自测这一点）；根清单、两个 tsconfig、build.yml 的非注释行、两个宿主构建脚本的代码里都不再提 `src/agent-host` / `typecheck:agent-host`。
   - 为此把第 3 步的整树解析提到模块级，两步共用一次解析（沿用 `f847f66d` 的「每个文件只解析一次」）。
   - `specifiersIn` 加了 `vi.mock` / `vi.doMock` / `vi.importActual` 等写法，第 3 步的两条 import 扫描也随之覆盖到模块 mock。现有代码里没有命中。

7. **文档**：
   - `README.md`、`README.zh.md` 的开发检查把 `pnpm typecheck:agent-host` 换成 `pnpm typecheck:dsh-host`，并注明要先在 `src/dsh-host` 里 `npm ci`。
   - `AGENTS.md`：质量检查补 `typecheck:dsh-host`；模块表那一行原来指向 `src/agent-host/`、写的是 PiHost 过渡态，只换路径会留下半句错话，所以整行改写成 DSH 宿主的现状，注明原目录已删；「Vitest 覆盖」一句的 agent-host 换成 dsh-host。方案 §1.12 把这一行列给 P1-14，P1-14 回写时可以再统一措辞。
   - 不动：项目 `CLAUDE.md`、`Windows-P4-6-*`、§1.12 列的其他过期文档、`.gitignore` 的 `out-agent-host/` 与 `biome.json` 的忽略（用户决定）、codex 夹具 README 里抓取时的探针路径与 auth 夹具 README 里的 blessing 记录（都是当时的历史记录）。

8. **碰到的情况**：
   - biome 的 import 排序：相对路径换成 `@shared/…` 或 `./…` 后排序位置变了，对改过的文件跑了 `biome check --write`，只动了 import 顺序和换行。
   - 风险 R10（最近的 `package.json` 变了）：bridge 源码改从 `src/dsh-host/package.json` 解析，与根目录一样是 `"type": "module"`。bridge-smoke（源码 shim 经 strip-types 加载）与真宿主集成测试都通过，确认没有影响。
   - 没有改依赖，lockfile 未变；没有跑 `pnpm install`。

9. **验证**（本机，`e890aa7c` 的树；tsc、lint 与各 vitest 在改名提交后的同一份代码上跑，第三个提交只改一行注释）：
   - `pnpm typecheck && pnpm typecheck:dsh-host`：通过，0 个错误。只剩两套 tsc。
   - `pnpm lint`：0 错误；8 条警告、1 条 info，都是基线就有的（`docs/` 证据脚本与 `run-f3-dev-probe.mjs`）。
   - `Static Scan Wiring`：75 个文件 759 例（第 3 步 756 例，加新增 3 例）。
   - `src/shared/__tests__`：30 个文件 437 例（加搬来的 `stderrRedaction.test` 32 例与守卫 3 例）。
   - `scripts`：12 个文件 208 例。
   - `src/dsh-host`：38 个文件通过、2 个跳过；760 例通过、11 例跳过（win32 专用）。
   - `src/main/services`：97 个文件通过、1 个跳过；1485 例通过、35 例跳过（没开环境变量的集成测试）。
   - 另跑改过但上面没覆盖的：`src/main/__tests__`、`src/shared/mcp`、渲染层 `historyError`、`questionCardModel`、`pendingPermissionDock`、`toolVocabulary`，10 个文件 321 例。
   - bridge-smoke：verdict 66 项全过。
   - `bridge-record --check`：28 个场景 0 差异，退出码 0，金样本未动。
   - 真宿主集成：35 例。
   - `build-dsh-host`：82.6 MiB（86616314 B），9771 个文件，`gitCommit` 不带 `+dirty`；bridge 行 77 个输入，凭据行 3 个；L1 冒烟 44 项全过。
