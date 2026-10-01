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
