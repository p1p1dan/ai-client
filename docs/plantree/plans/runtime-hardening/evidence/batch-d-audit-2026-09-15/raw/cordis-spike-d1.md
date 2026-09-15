# D1 Cordis 选型 spike 与 core-host-19 复核（任务 T030，区域 D1）

- 区域：D1 Cordis 选型 spike 与 core-host-19
- HEAD：`ebc82f16`
- 日期：2026-09-15

## 一、总评

`src/runtime/spikes/p0-cordis-semantics.ts` 是 D1（"插件内核采用 Cordis"）唯一的第一手实验证据，但它的验证范围比 ARD D1 原文承诺的选型理由窄得多：spike 只钉住了三件事——`static inject` 缺依赖时是"推迟到依赖出现"而不是直接抛错、`ctx.plugin()` 返回的 fiber 何时算"稳定"、dispose 依赖插件是否会连带收回依赖它的插件。D1 原文另外点名的三项能力——响应式属性（worker 内插件间状态传播）、Fork/Isolate（插件间 service 接口隔离纪律）、热插拔（开发期不重启换工具定义）——spike 从未涉及，生产代码里也是零使用（全仓 grep 零命中 `ctx.isolate`、reactive/`accept`、cordis 语义下的 fork）。

对批评者缺口 7 指名的 `core-host-19`（"D1 点名的能力一项未用，插件间零隔离"），我复核后维持前一轮反驳者给出的 **REFUTED** 结论：这条发现最重的论断——"没有机械约束，任何新插件都能无声依赖任何服务"——是错的，`static inject`（生产代码 10 处显式声明）本身就是 cordis 4.0.0-rc.9 强制校验的机械约束，属性访问在没有 `static inject` 声明时会直接抛 `cannot get property "X" without inject`。但反驳者自己也承认有残渣没处理：`ctx.isolate`、热插拔确实一处未用，且没有任何落地注记说明是暂缓还是放弃。这条残渣，加上"响应式属性"这个说法本身在选型时锁定的 `cordis@4.0.0-rc.9` 里根本没有对应 API，是本次复核新增的两条低严重度发现（spike-01、spike-02）。

spike 文件本身：不被 `src/runtime/tsconfig.json` 类型检查（显式排除 `spikes/`）、不被任何生产代码或测试导入、也不在打包产物里（既不在 electron-builder 的 `files` 白名单，也不在 `worker.js` 的 esbuild bundle 可达图里）。建议保留为证据，不建议删除，理由见五。

## 二、优点

- spike 的模块增强写法（`declare module 'cordis' { interface Context { ... } }`）与生产代码 `contracts.ts` 的服务声明手法完全一致，说明它不是随手写的玩具代码，而是提前踩出了生产要用的接口扩展模式。
- spike 验证的三点（inject 推迟激活、fiber 稳定时机、dispose 连带收回）恰好是 `bootstrap.ts` 真正依赖的行为：`bootstrap.ts` 里除 `ExecPlugin` 外的每个 `ctx.plugin()` 调用后都跟一次 `await xxxFiber.await()`，末尾用 `ctx.get(name) === undefined` 做"必需服务缺失"兜底（`bootstrap.ts:519-524`），这套写法只有在"依赖不满足时 fiber 停在 pending 而不是同步抛错"成立时才有意义——这正是 spike 的 Q1/Q2。
- spike 头部注释诚实注明"Throwaway probe, excluded from the type-check gate like `agent-host/spikes`"，与仓库另一处同类探针（`src/agent-host/spikes/`）用同样的措辞和同样的 tsconfig 排除方式处理，是一致的仓库约定，不是例外。

## 三、弱点

- D1 原文（ARD 第 55~61 行）用"作为完整框架使用，不预先排除任何能力"给四项 Cordis 能力（依赖图解析/生命周期/注入、热插拔、Fork/Isolate、响应式属性）背书，但只有第一项被 spike 实测、被生产代码使用；另外三项从决策落笔到现在（P0 至 T036）都没有代码，也没有任何 `docs/plantree/plans/runtime-hardening/decisions/` 或 `open-questions.md` 条目记录这是"暂缓"还是"放弃"（spike-01）。
- 生产 bootstrap 里依赖 spike Q1/Q2 语义的失败兜底路径（`plugin_graph_incomplete`）没有任何回归测试覆盖，`__tests__/bootstrap.test.ts` 全文搜不到这个错误码（spike-02）。
- `ExecPlugin` 的注册（`bootstrap.ts:251`）是全部 `ctx.plugin()` 调用里唯一一处不 `await` 返回 fiber 的（其余 8 处都紧跟 `await xxxFiber.await()`），这条此前已被别的区域（core-host）记入 P0-2 的"小瑕疵"清单，本轮未新增证据，不重复立发现，但复核时确认这一状态在 HEAD `ebc82f16` 仍未变。

## 四、节点判定

### P0-2 — complete-with-gaps

理由：Cordis 插件图本体（依赖推导、生命周期、dispose 清理、`ctx.effect` 释放钩子）落地正确，与 spike 验证的语义、与 `bootstrap.ts` 的实际写法三方一致（证据见二、spike-02 之前的正文）。缺口有二，均为低严重度、非阻塞：

1. D1 承诺的另外三项 Cordis 能力零落地且无注记（spike-01）。
2. `plugin_graph_incomplete` 失败路径缺测试（spike-02）。

`cross-and-critic.md:80` 指出 P0-2 的 rationale 仍引用已被推翻的 `core-host-19` 会误导读者——本轮复核给出的修正写法是：**不要把 core-host-19 从 P0-2 的缺口清单里整条删除**，而要改写成"core-host-19 整体已 REFUTED（`static inject` 已提供等价机械约束）；其残留的'isolate/热插拔/响应式三项未用且无落地注记'子结论仍成立，见 spike-01"。直接删除会丢失"三项能力确实没用、确实没人记录"这个仍然真实的信息。

### D1 — complete-with-gaps

理由：Cordis 作为插件内核的选型结论本身站得住（轻量、依赖推导机制经 spike 实测确认符合预期、生产代码 10 处 `static inject` 正常工作），但决策文本里四项能力只兑现了一项，另外三项既没有代码也没有回收记录；其中"响应式属性"援引的具体机制在选型时锁定的 `cordis@4.0.0-rc.9` 里查无此 API（见 spike-01 证据），说明这条卖点从落笔那一刻起就没有对应的可验证实现路径，不是"以后再做"的技术债，而是需要先确认可行性的开放问题。

## 五、发现

### [spike-01] LOW docs | P0-2 / D1 | docs/plans/2026-09-08-runtime-evolution-ard.md:58 | D1 承诺的三项 Cordis 能力零落地且无任何落地注记

DESC：D1 原文把"热插拔""Fork/Isolate 上下文自动执行插件间 service 接口隔离纪律""响应式属性用于 worker 内插件间状态传播（如权限配置变更→工具注册表更新）""动态 scope"列为选型理由的具体承诺。对 `src/runtime`（含 `plugins/`、`host/`、`events/`、`bootstrap.ts`，排除 `node_modules` 与测试）做全量 grep：`ctx.isolate(` 零命中，`.accept(`/`reactive(` 零命中，`.scope(` 作为 cordis API 调用零命中（仅有的 `scope` 命中是技能/MCP 配置里的业务字段，与 cordis 动态 scope 无关），"fork"仅在会话分支这个业务概念下出现（`plugins/session/index.ts:68` 的 `store.fork`），不是 cordis 的 Fork 机制（cordis 4 的 `Context` 类型定义里也已经没有 `fork` 方法，只有 `extend`/`isolate`/`intercept`）。权限变更→工具注册表这条"响应式传播"的具体例子，实际实现是拉模式：`plugins/tools/index.ts:78` 与 `:97` 在 `list()`/`execute()` 里现读 `this.ctx.runtimePermissions.mode`，不是订阅推送。`docs/plantree/plans/runtime-hardening/decisions/`、`open-questions.md`、`README.md` 全目录检索"isolate""热插拔""响应式属性""accept"均无第二处提及，说明这不是被显式接受的限制，也没有被记录为推迟到某个后续节点。

EVIDENCE：
```
docs/plans/2026-09-08-runtime-evolution-ard.md:58-61
作为完整框架使用，不预先排除任何能力——依赖图解析、生命周期管理、service 注入是基础；
热插拔在开发调试阶段有价值（改工具定义不用重启 app）；Fork/Isolate 上下文自动执行
插件间 service 接口隔离纪律；响应式属性用于 worker 内插件间状态传播（如权限配置变更
→ 工具注册表更新）；动态 scope 为后续场景（测试 mock、按会话差异化策略）保留空间。
```
```
$ grep -rn "\.isolate(\|\.accept(\|reactive(" src/runtime --include="*.ts" | grep -v node_modules
(no matches)
```
```
src/runtime/plugins/tools/index.ts:78/97 —— 现读 this.ctx.runtimePermissions.mode（拉模式，非响应式推送）
```
```
src/runtime/node_modules/cordis/lib/index.js —— 全文 grep "accept" 零命中；package.json version "4.0.0-rc.9"；README.md 只有 10 行，明确说明是文档占位（"official documentation is still under construction"）
```

SCENARIO：新插件作者读到 D1 决策文本，以为"响应式属性/Fork-Isolate/热插拔"这三项已经过选型验证、可以直接使用——例如想用 `ctx.isolate` 隔离一个第三方风险插件的服务访问面，或指望权限策略变化能通过响应式属性自动推送到工具注册表而不必每次现读。他会发现全仓找不到任何先例，而当前锁定的 cordis 版本（`4.0.0-rc.9`）甚至没有对应的 `accept` API 可用。下一轮审计如果只看 D1 原文和"已修"标记（本轮之前的批次 A/B/C 都没有触碰这个问题），仍会把这三项能力当成"待兑现的技术债"而不是"需要先确认可行性的开放问题"。

FIX：在 `docs/plantree/plans/runtime-hardening/decisions/` 下新开一条决策，逐项裁决 D1 四项能力：inject/生命周期/dispose（已用，保留）；`ctx.isolate`（是否需要，若不需要写明理由——`contracts.ts:22-27` 的 flat service name 取舍已经部分回答了"为什么不靠嵌套隔离"，可以直接引用并收口）；热插拔（当前 bootstrap 是一次性构建、无重建入口，若仍要保留承诺需要先给出接入点或明确推迟到哪个节点）；响应式属性（记录清楚锁定的 `4.0.0-rc.9` 无对应 API，決定是等 cordis 出稳定版再评估，还是从选型理由里删除这条）。

### [spike-02] LOW test-gap | P0-2 | src/runtime/bootstrap.ts:519 | `plugin_graph_incomplete` 失败兜底路径没有任何测试覆盖

DESC：`bootstrap.ts` 末尾用 `required.filter((name) => ctx.get(name) === undefined)` 做"必需服务缺失"的最终兜底，这条路径的正确性直接依赖 spike Q1 钉住的语义——依赖不满足时 fiber 停在 pending、不同步抛错，才轮得到这个 filter 去发现"缺服务"而不是在更早的 `ctx.plugin()` 调用处就已经抛出一个更难定位的裸异常。`grep -rn "plugin_graph_incomplete" src/runtime/__tests__` 与各插件目录下的 `__tests__/*.ts` 全部零命中，说明这条路径自 P0 建立以来从未被任何用例真正触发过。

EVIDENCE：
```
src/runtime/bootstrap.ts:519-524
    const missing = required.filter((name) => ctx.get(name) === undefined);
    if (missing.length)
      throw new RuntimeConfigError(
        'plugin_graph_incomplete',
        `missing services: ${missing.join(', ')}`
      );
```
```
$ grep -rn "plugin_graph_incomplete" src/runtime --include="*.ts"
src/runtime/bootstrap.ts:522   （仅此一处，无测试引用）
```

SCENARIO：`cordis` 目前锁定在 `4.0.0-rc.9`（一个 release candidate，`README.md` 自称"API is not yet stable and may change without notice"）。如果未来升级版本时，cordis 改变了"依赖缺失时 fiber 是否推迟"这条语义（即推翻 spike Q1 的结论），`bootstrap.ts` 里某个 `await ctx.plugin(XxxPlugin, ...)` 就会在注册那一刻直接抛出未分类的异常，而不是走到 `:519` 这条本该给出清晰错误码和缺失服务名单的兜底分支。因为没有任何测试构造过"必需服务缺失"这一具体场景（比如刻意不注册 `ToolsPlugin` 但仍在 `options.tools` 为真的路径下运行），这种回归只能在真实启动失败、且排查过程中翻源码才会被发现，而不是在 `pnpm typecheck:runtime` 或现有 vitest 套件跑绿时被拦下。

FIX：在 `src/runtime/__tests__/bootstrap.test.ts` 里补一个用例——用一个会让必需服务注册失败或缺失的路径调用 `createRuntime`（例如给 `ToolsPlugin` 传入会在构造期抛错的非法配置，或直接 mock 掉某个插件类），断言最终抛出的是 `code: 'plugin_graph_incomplete'` 且 `message` 里列出了具体缺失的 service 名，而不是断言某个更早、更不透明的异常类型。

## 六、测试缺口

- `plugin_graph_incomplete` 失败兜底路径无测试覆盖（spike-02，已列为发现）。
- spike 本身不接入 CI（`tsconfig.json` 排除、无 npm script 调用它），cordis 版本升级不会自动触发它重跑；它验证的三条语义（inject 推迟、fiber 稳定时机、dispose 连带收回）目前完全靠人工记忆维护。

## 七、未经执行验证的声明

- 无。本区域全部结论均基于对 `src/runtime`（含 `node_modules/cordis` 源码）、`docs/plans/2026-09-08-runtime-evolution-ard.md`、打包脚本（`electron-builder.yml`、`scripts/build-agent-host.mjs`）的直接阅读与全量 grep，不涉及 Windows / 加密机 / Electron utility 载体 / 真实模型回合才能验证的事实。cordis 本身是纯 JS 依赖注入库，其依赖推导/fiber/dispose 语义不因操作系统或执行载体而变化。

## 八、上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| `plugin_graph_incomplete` 失败路径补测试后仍能在真实 `pnpm typecheck:runtime` + `vitest` 下通过 | 新增用例断言 `code: 'plugin_graph_incomplete'` 且缺失服务名单正确，且不影响既有用例 | 运行 `pnpm typecheck:runtime` 与对应 vitest 文件 | dev-box |
| cordis 版本从 `4.0.0-rc.9` 升级到下一个版本时，重跑 `node --experimental-strip-types src/runtime/spikes/p0-cordis-semantics.ts` 确认 Q1/Q2/Q3 三个答案不变 | 三行 console.log 的布尔值与升级前一致（`shouter present? true` 两次、`dispose 后 shouter present? false`） | 手动执行 spike 脚本，比对升级前后输出 | dev-box |

## 九、读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/area-assessments.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-uncertain-refuted.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json（`core-host-19` 结构化记录，含反驳与豁免核对）
- docs/plantree/plans/runtime-hardening/roadmap.md
- docs/plantree/plans/runtime-hardening/decisions/（目录检索，未见 D1 残留能力相关条目）
- docs/plantree/plans/runtime-hardening/open-questions.md（检索，未见相关条目）
- docs/plans/2026-09-08-runtime-evolution-ard.md（D1、4.1、4.4 节）
- src/runtime/spikes/p0-cordis-semantics.ts
- src/runtime/bootstrap.ts
- src/runtime/contracts.ts（节选，服务命名与 DEFERRED_SERVICES 说明段）
- src/runtime/tsconfig.json
- src/runtime/package.json
- src/runtime/host/exec.ts（`static inject` 检查）
- src/runtime/host/io.ts（`static inject` 检查）
- src/runtime/trace.ts（`static inject` 检查）
- src/runtime/events/index.ts、plugins/tools/index.ts、plugins/skills/index.ts、plugins/permissions/index.ts、plugins/mcp/index.ts、plugins/agent-loop/index.ts、plugins/model-adapter/index.ts、plugins/subagent/index.ts、plugins/prompt/index.ts、plugins/context/index.ts、plugins/session/index.ts（`static inject`、`ctx.effect`、`.scope`、`.fork` grep）
- src/runtime/__tests__/host.test.ts
- src/runtime/__tests__/bootstrap.test.ts（grep）
- src/runtime/worker/nativeImport.ts（`new Context()` 用法核对）
- src/runtime/node_modules/cordis/package.json、README.md、lib/context.d.ts、lib/index.js（节选：inject 校验、fiber store、isolate 实现）
- electron-builder.yml
- scripts/build-agent-host.mjs
- scripts/afterPack.mjs（grep）
- electron.vite.config.ts（grep）
- src/agent-host/worker.ts
- src/main/services/agent-host/PiWorkerProcess.ts（节选）
- src/main/services/agent-host/WorkerManager.ts（grep）
