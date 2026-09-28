# 决策 087：子代理目录规则搬进 `src/shared`，MCP 真实 stdio 夹具移出 runtime

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：`fe089adf`；[决策 086](086-shared-skills-mcp-move-choices.md)「留给后续」第 1、2 条；[P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md)的分片 03（`runtime/plugins/subagent/catalog.ts` 搬 shared 那句）、分片 04（P1-16d 表格、E5 实验）。

## 规则

1. **`plugins/subagent/catalog.ts` 整份是纯逻辑，全部搬进 `src/shared/subagentCatalogRoots.ts`（单文件，不开新目录）。**
   - 盘点：该文件唯一的运行时依赖是从 `../../contracts.ts` 引入的两个类型 `RuntimeFileKind`、`RuntimeModelRef`（仅类型导入，不含任何 Cordis / Electron / 工具注册表的值依赖）。其余全部依赖 `node:os`、`node:path`，以及已经在 shared 里的 `subagentBuiltins.ts`、`subagentDefinition.ts`。
   - 命名：没有照搬指令里建议的目录形式 `src/shared/subagents/`。原因是 `src/shared/` 下子代理相关的既有文件（`subagentBuiltins.ts`、`subagentDefinition.ts`、`subagentMigration.ts`、`types/subagentManagement.ts`）全是扁平文件，不是子目录；而且方案分片 04 的 P1-16d 表格已经预写了目标路径 `src/shared/subagentCatalogRoots.ts`（"根、合并、内置"，搬 150 行）。跟已有约定和已有方案对齐，比新开一个只装一个文件的目录更省心，往后 P1-16d 真正接 DSH 时也不用再挪一次。
   - 两个仅类型的依赖改为在新文件里本地声明结构等价的 `SubagentFileKind`、`SubagentModelRef`，不从 runtime 反向引用（跟 `SkillFileKind` 在 `src/shared/skills/loader.ts` 里的处理一致）。因为是结构类型，runtime 侧调用方（`index.ts`、`bootstrap.ts`）传 `RuntimeFileKind[]` / `RuntimeModelRef[]` 进去、接 `SubagentModelRef` 的返回值出来，两套 tsc 都干净通过，不需要显式转换。
   - runtime 原位置 `plugins/subagent/catalog.ts` 改成纯 `export { ... } from '../../../shared/subagentCatalogRoots.ts'`，导出名和行为不变；`plugins/subagent/index.ts`、`bootstrap.ts` 不用改一行。

2. **测试整份搬空，不是「一半搬一半留」。**
   - `fe089adf` 的先例是 skills 36/12、MCP 19/22 按「纯逻辑 / 依赖 Cordis」拆开两半。子代理这边的原测试文件 `subagentDefinitions.test.ts`（P5-2-1 门禁 SA01+SA02，35 例）整份只用内存里的 `fakeSource()`，没有一个用例碰 Cordis、真实文件系统或 `SubagentPlugin`。子代理生命周期（`Task`/`TaskWait`/`TaskList`/`TaskStop`、并发、恢复）已经有另外 7 个独立测试文件在管（`subagentSession`、`subagentDelegation`、`subagentHardening`、`subagentLoopGuard`、`subagentDisplay`、`subagentHostProbe`、`subagentMigration`），它们都通过 `createRuntime`/bootstrap 走真实的 Cordis 接线，跟 catalog 的纯逻辑测试没有交集。
   - 所以：35 例原样搬进 `src/shared/__tests__/subagentCatalogRoots.test.ts`（用例体逐字不改，只改 import 路径和两个类型名），旧文件整份删除。按用例全名比对（`describe > it` 文本，去掉文件名前缀）新旧两份完全一致，35/35，零丢失、零新增、零改名。
   - runtime 侧新增 `src/runtime/__tests__/subagentCatalogSharedWrapper.test.ts`（2 例），只做「导出名不变」「导出值就是 shared 的同一个引用」两件事，照 `skillsMcpSharedWrappers.test.ts` 的写法，但拆成单独文件而不是塞进那个已有文件——那个文件的文档注释明确限定在 skills/MCP 范围内，混进子代理会让它的 docstring 和断言表都不再准确。
   - 新增边界静态测试 `src/shared/__tests__/subagentCatalogRootsBoundaryStatic.test.ts`（5 例）。跟 `skillsLibraryBoundaryStatic.test.ts` / `mcpLibraryBoundaryStatic.test.ts` 的写法不同的地方：那两个是扫一个目录（`readdirSync(LIBRARY)`），这里只有一个入口文件，所以直接从这一个文件出发做穷举导入的传递闭包判定；闭包会走到 `subagentBuiltins.ts`、`subagentDefinition.ts`（这两个文件比这次搬迁更早进 shared，从未贴过「Moved from」横幅），静态测试对它们只检查「在白名单边界内」，不检查横幅——横幅要求只加在这次新建的 `subagentCatalogRoots.ts` 上。

3. **搬迁前先跑一次未改的原测试，确认迁移后的代码行为不变。**
   - `subagentDefinitions.test.ts` 在完全不改一行的情况下（因为它一直是通过 `plugins/subagent/catalog.ts` 这个入口调用，搬迁只是把入口后面的实现换成 re-export），对着搬迁后的代码跑：35/35 通过。这是「旧用例原样跑」的证据，然后才做上面第 2 条的拆分与删除。

4. **MCP 真实 stdio 夹具 `runtime/__tests__/fixtures/mcp-echo-server.mjs` 移到 `src/shared/mcp/__tests__/fixtures/mcp-echo-server.mjs`。**
   - 用 `git mv`，文件内容不改。跟它已经在同一目录的 `scriptedServer.ts`（`fe089adf` 新增的脚本化传输测试替身）放一起——两者都是"MCP 客户端的测试替身"，一个是真进程、一个是内存里的假端口，放同一个 `fixtures/` 目录比散在两处更好找。
   - 更新引用：`src/runtime/__tests__/mcp.test.ts` 的 `FIXTURE` 路径与文件头注释；`src/shared/mcp/__tests__/fixtures/scriptedServer.ts` 头注释里指向旧路径的一句话；方案分片 04 的 E5 实验行的路径引用。`topics/p1-10-p1-16-extensions.md:146`（MCP-1 场景描述）只提到文件名，没有目录路径，不用改。
   - 这个夹具本身**不是纯逻辑**（是一段跑在独立 Node 子进程里的脚本，不 import 任何 runtime 或 shared 代码），移动它单纯是因为 P1-12 删 `src/runtime` 之前，`src/runtime/__tests__/mcp.test.ts`（依赖 `runtimeExec.spawn` 和真实 Cordis 宿主接线，留在 runtime 不搬）要能继续引用到它；夹具本身放哪都行，放今后 P1-16b `aiclient-mcp` 也用得上的 `src/shared/mcp/__tests__/fixtures/` 更省一次搬家。

## 留给后续

- P1-16d 真正把子代理接进 DSH（`aiclient-delegates`）时，`src/shared/subagentCatalogRoots.ts` 直接复用；宿主插件那半（`ctx.subagents.start` 映射、委派工具 schema）另起文件。
- `src/shared/subagentBuiltins.ts`、`src/shared/subagentDefinition.ts` 目前没有专门的边界静态测试（进 shared 早于 `fe089adf` 定下的横幅/边界测试约定），这次的边界测试只覆盖到它们「在白名单内」，没有单独补横幅或专属边界测试——这不在本次任务范围内，需要的话应作为独立小任务处理。
- P1-12 删 runtime 前，`docs/plantree/plans/dsh-rebase/topics/p1-10-p1-16-extensions/04-changes-and-tests.md` §5「roadmap 补登建议」第 1 条列的三项（skills/模板、MCP、子代理目录规则）现在全部搬完。
