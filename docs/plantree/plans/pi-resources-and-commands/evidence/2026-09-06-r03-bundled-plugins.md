# Evidence — R03 三个插件随包附带

**日期**：2026-09-06
**关闭**：roadmap `R03`（含 Q-R5 结论）
**上游决定**：[D06（UI）](../pix-ui-alignment/decisions/006-plugin-inventory-source.md)、
[D10（UI）](../pix-ui-alignment/decisions/010-user-configured-gate-explicit-degradation.md)

## 一、结论先行

R03 原定随包三个插件，实际落地**两个**：

| 插件 | 状态 | 体积 | 说明 |
|---|---|---|---|
| `@juicesharp/rpiv-ask-user-question` | ✅ 随包 | 388K | 补齐已有的半截显示链路 |
| `@gotgenes/pi-subagents` | ✅ 随包 | 552K | 换掉会绕过权限审批的 `tintinweb` 版 |
| `pi-workspace-history` | ⛔ 未随包 | — | **上游 peer 冲突，npm 拒绝安装**（见 [Q-R5](../open-questions.md)） |

子代理这条是安全缺口不是偏好：`@gotgenes/pi-permission-system` 自己的
[`subagent-integration.md`](node_modules/@gotgenes/pi-permission-system/docs/subagent-integration.md)
写着 `tintinweb/pi-subagents`「不发布生命周期事件」，其 in-process 子代理
「既没有确定性检测，也没有 ask-state 转发」——
用那版子代理的工具调用会绕过审批弹窗，而界面上还显示着权限档。

## 二、为什么 `pi-workspace-history` 装不进去

它**每一个**发布过 `@earendil-works` 名字的版本（0.3.0 / 0.3.1 / 0.4.0 / 0.4.1）
都声明 `peer @earendil-works/pi-coding-agent@"^0.84.4"`；再往前的 0.1.x / 0.2.x
挂在旧的 `@mariozechner/pi-coding-agent` 名下，不是同一个包。我们锁 `0.84.3`，
差一个补丁号。

**那条边界是声明的，不是真实的。** 逐项核对插件
`.pi/extensions/workspace-history.ts` 实际用到的 SDK 面与 0.84.3 的 `.d.ts`：

- 七个 import 全是 `import type`，运行时被擦掉
- 五个运行时方法（`pi.exec` / `pi.on` / `pi.registerCommand` / `ctx.navigateTree` / `ctx.waitForIdle`）都在
- 十一个订阅的事件名都在事件联合里

即 `^0.84.4` 是上游保守取整，不是它依赖 0.84.4 的某个新东西。

**`overrides` 三种写法 npm 全部拒绝**（嵌套、`$name` 引用、顶层），每次同一条 ERESOLVE。
剩余三条路都不该顺手做：SDK 抬到 0.84.4+ 要重跑整套 worker 门禁（独立一片）；
`--legacy-peer-deps` 为一个插件放弃另外三个包的 peer 保护；vendor 进仓要自己跟上游同步。

**处置**：它是撤销安全网，不是安全缺口——缺了没任何东西变得不安全。
**SDK 例行升版时在同一片里试装一次**，结论写进 [Q-R5](../open-questions.md)。

## 三、落地形态

### 3.1 单一数据源

`src/agent-host/bundledPlugins.mjs` 是唯一列表，三个消费方读它：

- `scripts/agent-host-build-lib.mjs` —— preflight（装了没）、copy filter 的 licence 集、产物校验（entry 活着没）
- `src/agent-host/bundledFeaturePlugins.ts` —— 运行时把每个包解析成绝对目录交给 pi
- 两者的测试

`.mjs` 的原因与 `permissionPolicy.mjs` 相同：build 脚本要 import 它，而 `.mjs`
不能 import `.ts`。配套 `.d.mts` 给 TS 侧类型。

**entry 是断言不是查找。** 每条 `entry` 从该包自己的 `pi.extensions[0]` 抄来，
build 断言文件存在于产物。这是刻意重复——packaging filter 按**目录**遍历，
对目录答 no 就跳过整棵子树，filter 错了会静默丢包而单测全绿。
**丢掉的 entry 是唯一藏不住的症状。**

### 3.2 运行时接入

`permissionPlugin.ts` 的单包查找推广成表：

- `lookupBundledPackage(packageName, baseDir)` —— 三个同款检查：
  `not_present` / `half_copied`（目录在但 `package.json` 读不出）/ `wrong_package`
- `packageSourceMatches(source, packageName)` —— 按 source kind 匹配（npm / git / local）
- `packageConfiguredByUser(packages, packageName)` —— 用户配置里**真的会加载**才算
- 原三个权限插件函数保留为薄封装

`bundledFeaturePlugins.ts` 解析出 `{ paths, skipped }`。两条关键边界：

1. **feature 路径绝不混进权限门禁的 list。**
   `verifyPermissionExtensionLoaded(loaded, injectedRoots)` 接受任何「路径以
   injected root 开头」的扩展作为权限系统已加载的证据。
   把 feature root 追加进那个参数，会让「pi-subagents 加载了」满足那条
   「用来证明审批门在跑」的检查——一个没门禁的会话会照常启动并自报健康。
   两条 list 只在调 pi 的地方 join，验证始终只收门禁自己的 list。
2. **缺 feature 不判死刑。** 权限系统是 fail-closed（缺了拒绝开会话）；feature
   相反——缺了少一个功能，其余照旧。所以问题写 log、会话照常。

**用户自己装了同名包时，我们的让路。** pi 会把 settings 派生包列表与
`additionalExtensionPaths` 合并；同一扩展两份活副本会重复注册工具与命令，
而用户选的是他们那个版本。跳过我们的是更小的意外，也是他们能撤销的。

`piAgentSessionBootstrap.ts` 加 `resolveFeaturePlugins` 测试缝（默认
`resolveBundledFeaturePlugins`），在调 `createAgentSessionServices` 前 join。

### 3.3 build 侧

`scripts/agent-host-build-lib.mjs`：

- `REQUIRED_WORKER_PACKAGES` 加 `...bundledFeaturePluginPackages()`——
  preflight 缺任何一个直接拒建
- `LICENSE_BEARING_PACKAGES` 加 shipsLicenceFile 的条目
- `verifyArtifact` 的 `mustExist` 加 `...bundledFeaturePluginEntryPaths()`

**copy filter 不需要分支。** 两个包的 entry（`index.ts` / `src/index.ts`）都走
通用过滤器默认分支（排除 `.md`/`.d.ts`/`docs`/`test`，保留 `.ts`），
且必须下探包目录本身。实测 `shouldCopy` 对两者全部正确。

## 四、门禁

| 项 | 结果 |
|---|---|
| 相关 Vitest（5 文件） | `81 passed` |
| `pnpm typecheck` | pass |
| `npx biome check scripts/ src/agent-host/ src/main/` | 干净 |
| `git diff --check` | 干净 |
| `build:agent-host` | `OK — 78.8MiB (82673762B), worker-only, pi 0.84.3, permission 27.0.1`（上限 256MB） |
| packaged-worker-smoke | `{"ok":true,"bundledExtensions":2}` |

**新增测试**：`bundledFeaturePlugins.test.ts`（9）；`agent-host-build-lib.test.mjs`（16 → 19，+3）；
`packaging-config.test.mjs`（+2）；`workerStripOnlyCompat.test.ts`（+1）。

## 五、门禁阶段又档回来两处

既有断言不是一碰就过，这个计划的门禁抓到了两处我没预见的边界：

1. **`workerStripOnlyCompat` 的 value-import 白名单只有 `.ts`/`.js`。**
   `bundledFeaturePlugins.ts` imports `./bundledPlugins.mjs`，被误判为
   「相对 value import 无扩展名」。实际 `.mjs` 是真实 ESM 扩展名，Node（包括 dev
   下的 `--experimental-strip-types`）直接解析。此规则防的是**裸名**（`./dog`），
   不是 ESM 文件类型。白名单扩到 `.mjs`/`.cjs`，加一条回归断言锁住这个区分。
2. **`packaging-config` 的 worker 依赖边界是精确比对。**
   `expect(Object.keys(deps)).toEqual([SDK, permission])` 会因 R03 加包而红。
   这是安全边界不是便利清单（每项都是与权限门序同在 Pi utility 进程里跑的代码），
   所以保持精确，改为从 `bundledPlugins.mjs` 派生出期望值。
   另加一条「每个随包扩展必须是精确 pin」——range 会让 `npm install` 把扩展
   漂移到产物断言测的那个 entry 之外。

## 六、变异验证

build-lib 三处，每处判红后恢复：

| 变异 | 结果 |
|---|---|
| 移除 `verifyArtifact` 的 entry 断言 | `1 failed \| 18 passed` |
| filter 拒绝 feature 包的 `.ts` entry | `1 failed \| 18 passed` |
| filter 下探包目录时忘 `parts.length === 1`（整包跳过） | `2 failed \| 17 passed` |

smoke 一处：把内置包名改成不存在的 `@gotgenes/pi-subagents-nope` →
`bundled extension @gotgenes/pi-subagents-nope did not load`，退出码 1。

**一个被我修正的测试缺陷**：初版 `shouldCopy` 断言把 `verifyArtifact` 的
`node_modules/...` 路径喂给了以 node_modules 为根的 walker——`topPackage`
读到 `node_modules`，包级分支全部失配，断言空转。
拆成 `bundledFeaturePluginCopyPaths()`（node_modules 相对，给 `shouldCopy`）
与 `bundledFeaturePluginEntryPaths()`（产物相对，给 `verifyArtifact`）两个视图后，
断言才开始真正看 filter。
**如果不是为了做变异验证，这条空转测试会一直全绿。**

## 七、真机验证

### 7.1 打包墙

`xvfb-run` 不在本机，直接 `npx electron --no-sandbox scripts/packaged-worker-smoke.cjs
"$PWD/out-agent-host/worker.js"`。注意 worker 路径必须是**绝对路径**：
smoke 用 `utilityProcess.fork`，子进程 cwd 是临时工作区，相对路径会解析到那儿。

```
[pi-worker] permission plugin: bundled
{"ok":true,"workerPid":... ,"sessionFile":"/tmp/aiclient-packaged-worker-.../agent/sessions/...jsonl","bundledExtensions":2}
```

extension inventory 里三个包全部 `loaded`：
`pi-permission-system`、`rpiv-ask-user-question`、`pi-subagents`。

### 7.2 欠项

- **问答卡端到端未跑**（execution-plan §四的"模型调 `ask_user_question` → 弹窗出现
  → 选项回传"）。smoke 只验到扩展加载；真正的 `ui.select` / `ui.input` 对话路径要
  起一个真会话让模型真问一次，本轮未做。
- **`pi-workspace-history` 未随包**，已按 [Q-R5](../open-questions.md) 记档等 SDK 升版。
- **子代理的子代理**（二级）行为未验——只确认 `@gotgenes/pi-subagents` 加载且
  与其权限集成文档一致。
