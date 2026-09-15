# 批次 D 审计覆盖补全 · 区域 H-nodes（H/17、H/19、H/21、P5-2-0）

Role: evidence（只读区域审查原文）。区域：H/17、H/19、H/21、P5-2-0（任务 T030）。HEAD：`ebc82f16`。日期：2026-09-15。

## 总评

这四个节点在 2026-09-14 审计里属于「12 类未认领节点」（cross-and-critic.md 批评者缺口 9，第 72 行）。本轮逐条对照代码复核后，结论是：**四个节点在当前 HEAD 上都站得住**，此前文档里记录的已知缺陷（H/17 的明文派生文件、H/19 的 provider ID 迁移丢失、H/21 的错误文案与首启迁移）在批次 A～C 期间已经修完并有对应提交号；P6-2/P6-5/T036 三次退役性改动（摘除 pi-coding-agent 依赖、退役旧引擎、删 extensionUi 整链）之后，H/19 的插件管理与 H/17 的明文文件这两条线的「用途」发生了实质收窄（插件管理只影响内嵌终端，不再影响 GUI 会话），但代码侧的文案、IPC 契约、测试都已经跟着收窄同步更新，不是「代码没跟上文档」的那种缺口。

深挖了七八条最可能藏 bug 的线（明文文件谁在写谁在读、迁移时 provider ID 是否再次丢失、insufficient 权限系统的两份都缺失路径、Main 侧 modelCatalog 的磁盘回落触发条件、探针门禁的版本 pin 与是否跑），**没有找到一条能构造出具体触发场景、且未被批次 A～C 修过的新缺陷**。因此本报告没有立新的 hnode 发现——不是没查，是查完之后站不住。按规则「宁可少而准」，不勉强凑数。

## 优点

- H/17 的「明文派生文件是共存期措施」这条债，在 P6-2/P6-5 执行后被**主动改判**（不是遗漏，是查清后写了新结论）：`src/runtime/plugins/model-adapter/catalog.ts:1-24` 的模块头注释与 `docs/plantree/plans/runtime-evolution/README.md:39-40` 的说法逐字对得上——随包 `pi` CLI 的 `ModelRuntime` 仍要读 `<agentDir>/models.json` + `auth.json`，这两个文件现在服务的是终端，不是旧引擎，停写会让 TUI 没有模型可用。
- H/19 的 P6-2/P6-5 之后，`chat:listSessionExtensions`（读 pi 扩展列表，P6-5 后无生产者）被 T026 主动替换成 `chat:listSessionCapabilities`（读 native runtime 自己的 MCP/技能/子代理服务），`src/shared/types/ipc.ts:372-384` 的注释直接点名了替换原因（cutover-03：侧栏插件清单与 MCP 徽标永久为空）。`PiPluginsSettings.tsx:10-16` 的模块头与页面里 `description` 文案（`'Extensions installed for your account. Only the built-in Pi terminal loads them; chats in this app do not.'`）如实告诉用户「装的插件只对内嵌终端生效，GUI 会话不生效」——这正是 H/19 topic 文档里 2026-09-10 写的验证案例 4（「会话里真的可用」）在架构收窄后失效的那部分，代码没有假装它还成立。
- H/21 的 D1（迁移丢失 provider 原始 ID，最严重的一条现场缺陷）已在 `src/main/services/agentMigration/AgentDirMigrationService.ts:432-437` 用 `configKeyOf(provider)` 修好：新增/覆盖 provider 时都保留源 `models.json` 里的原始 key，注释直接引用「H/21 point-check D1」。
- P5-2-0 的版本 pin 仍精确锁定 `0.84.4`（`src/runtime/package.json:9-10`，`src/runtime/node_modules/@earendil-works/pi-agent-core/package.json` 与 `pi-ai/package.json` 的 `version` 字段与之一致），10 条探针（`src/runtime/__tests__/subagentHostProbe.test.ts`）全部存在、没有 `.skip`，落在根 `vitest.config.ts` 的 `include: ['src/**/__tests__/**/*.test.ts', ...]` 范围内，随 `pnpm test` 常规跑。

## 弱点

- 四个节点的「完成」判断相当一部分依赖 2026-09-10～09-11 的真机点验证据（`evidence/unified-agent-directory/README.md`、`evidence/external-agent-migration/README.md`），而这些点验发生在 P6-2/P6-5/T036 三次架构级改动**之前**。点验里验证过的具体行为（如「案例 4：装完发一轮真实对话，`chat:listSessionExtensions` 返回扩展清单」）依赖的 IPC 通道本身已被替换，点验记录本身没有被标注为「已随架构变化失效，靠 T026 的静态用例接续」，容易被后来者当成仍然成立的现行证据来引用。这是文档维护问题，不是代码缺陷，但值得在下一轮机械回写里补一句「该点验先于 P6-5，行为已由 T026 的单测接续验证，未重新真机点验」。
- H/19、H/21 两个节点从未在打包产物、Windows、加密文件系统上跑过；已知的路径解析、大小写、权限位问题（如 U4 落地记录里提到的 `resolvePiCliLaunchPlan`/`currentPiCliLayout()` 打包布局）目前只有开发机 Linux 证据。
- P5-2-0 本身没有产品级弱点——它是一次性门禁，10 条探针的结论已经写进 P5-2-1～7 的实现里，本节点自身不需要持续验证，只需要盯住 D12（版本 pin）不被静默升级。这条已确认成立。

## 节点判定

| 节点 | 判定 | 依据 |
|---|---|---|
| H/17 | complete-with-gaps | 代码侧结论稳定：明文派生文件是终端消费的正当设计而非残留债务，写入/读取路径与文档描述一致，T021 已把 Main 侧的钥匙串 locked 回落、baseUrl 可达性等已知缺口修完。差的只是现场：未打包、未在真机/加密机/Windows 回归（README 明确写「未打包、未现场回归」）。归入批次 E。 |
| H/19 | complete-with-gaps | U1～U6 全部落地且 2026-09-10/11 真机点验通过；D1（迁移丢 provider ID）已修；P6-2/P6-5/T036 收窄了插件管理的实际作用范围（只剩内嵌终端），代码文案与 IPC 契约已同步收窄（T026），不是文档过时未追。差的是：验证案例 7（依赖 H/20 的完整闭环）与打包/现场回归仍未做；2026-09-10/11 的点验记录先于三次架构改动，需要一次「重新确认点验结论仍成立」的复核（非代码修复，是证据维护）。 |
| H/21 | complete-with-gaps | P0～P1（错误文案、首启一键迁移）与 C1～C6（对话导入）均已落地并在 2026-09-11 真机点验通过，含「可续聊」硬验收闭环；本轮抽查确认所有界面入口（`AgentMigrationPrompt.tsx`、`AgentMigrationSettings.tsx`、`ConversationImportSettings.tsx`、`modelMissingError.ts` 接的四个界面）在当前 HEAD 均未被 T036 等后续改动动过。差的是：Codex 旧格式导入只有构造用例、没有真实旧格式样本跑过；内嵌 TUI 的模型缺失覆盖层未点验；打包/加密机/Windows 现场未做。 |
| P5-2-0 | complete | 门禁本身是一次性判定，10 条探针全部实测通过并固化进 P5-2-1～7 的实现约束；D12（pin 0.84.4）在当前 HEAD 上原样成立，探针测试文件仍在标准测试套件范围内、未被跳过或排除。没有需要现场验证的残留项。 |

## 发现

无。本轮针对以下七条最可能藏缺陷的线索做了逐行核实，均已被批次 A～C 的提交修复、或本来就是设计内行为，均未能构造出独立于已知修复之外的新触发路径，因此不立为 hnode 发现（按规则 9，宁可少而准）：

1. **H/17 明文文件的写者/读者是否已随 P6-5 收窄** —— 核实 `PiModelConfigService.writeRuntimeConfig`（`src/main/services/piModelConfig/PiModelConfigService.ts:584-600`）仍无条件写 `models.json`/`auth.json`，但 `PiUtilityService`（`src/main/services/agent-host/PiUtilityService.ts:394-399`）已改用 `resolveNativeModelCatalog()` 的内存目录，不再读盘——与 T016「utility 路径不读 models.json」的验收一致，已修。
2. **H/19 插件管理入口在 T036 之后是否还有用途** —— 核实 `install`/`remove`/`list` 三个 IPC（`src/main/ipc/piPlugins.ts`、`src/main/services/piPlugins/`）与 extensionUi 整链完全独立，T036 的删除范围没有波及它们；页面文案已按 T026 收窄成「只影响内嵌终端」。
3. **H/19 验证案例 4～5 的前提是否失效** —— 案例 4 的「会话里真的可用」（通过已删除的 `chat:listSessionExtensions`）前提确实不再成立，但当前代码没有假装它成立：新 IPC 语义变了、页面文案改了、这条是 cutover-03 的已修范围，非新发现。案例 5（托管模式项目级插件不生效）与 extensionUi 无关，机制未变。
4. **H/19 迁移的 provider ID 覆盖是否会撞车托管三固定 arm（`claude`/`codex`/`pi`）** —— 核实这是 `local-provider-management.md` 第 12 行明写的既定设计（「写给运行时时两组合并，同名以用户组优先并在界面提示」），不是缺陷。
5. **Main 侧 modelCatalog 的磁盘回落触发条件** —— 核实 `WorkerManager` 的生产单例（`WorkerManager.ts:2787-2792`）注入的是 `resolveNativeModelCatalog()`，其在凭据库锁定/不可读时按 T021 设计返回 `undefined`，此时 `bootstrap.ts:470-476` 才会退回 `readPiCatalog` 读盘——这正是 T021 验收里「locked 场景断言的是回落，不是 dropped」那句话描述的行为，是设计内分支，不是遗留死代码或未接线的 bug。
6. **权限系统「两份都缺失」的报错路径是否随 T025 清扫而失效** —— 核实 `PermissionGateUnavailableError` 确实已随 P6-5 删除旧引擎分支而不再抛出（`src/agent-host/piWorkerRpcServer.ts:277` 的注释直接写明），但这条错误原本描述的是**旧引擎**加载 pi 权限插件失败的路径；GUI 会话现在用的是自有 `src/runtime/plugins/permissions/`（不依赖用户/随包 pi 插件是否存在），内嵌终端那条路径的「两份都缺失」场景已被 T025 特意保留 `@gotgenes/pi-permission-system` 挡住（「因 Main 权限策略面板仍读它的 config.json 保留」）。不是新缺口。
7. **P5-2-0 探针是否会因 `src/runtime` 是独立 npm 子包而在某些执行路径下被静默跳过** —— 确认根 `vitest.config.ts` 的 `include` 是纯路径 glob、不依赖 `src/runtime` 自己的 `package.json`，只要 `src/runtime/node_modules` 已装（`npm ci`），探针就会随根 `pnpm test` 一起跑；这是已知的环境搭建前提（见团队记忆「src/runtime 是独立 npm 子包」），不是代码或门禁本身的缺陷，因此不计入代码级发现，但已写进下方上机检查单作为环境前提提醒。

## 测试缺口

- H/21：Codex 旧格式（首行裸 header、条目为裸行）的读取只有构造用例（`CodexRollout.ts` 的合成样本），没有一份真实旧格式 rollout 文件跑过；`external-agent-migration/README.md` 第 101 行已自陈「本机 10 个 rollout 全是新格式」。
- H/19：验证案例 7（GUI 与 TUI 都能列出迁移/导入后的历史对话）没有自动化用例，也没有依赖 H/20 完整闭环后的真机点验。
- H/17、H/19：没有任何打包产物（`pnpm verify:packaged` 之外）、Windows、加密文件系统上的自动化或真机用例。
- H/21：内嵌 TUI 的模型缺失覆盖层（`modelMissingError.ts` 接的第四个界面）没有点验记录，只有 GUI 三个出口验证过。

## 未经执行验证的声明

- `docs/plantree/plans/runtime-evolution/evidence/unified-agent-directory/README.md` 与 `evidence/external-agent-migration/README.md` 里 2026-09-10/11 的真机点验结论，均产生于 P6-2/P6-5（2026-09-13）与 T036（2026-09-15）之前；这些改动之后，点验记录里被替换/收窄的具体行为（如「装完插件后会话里可用」）没有一次重新真机复核，只有静态代码与单测层面的一致性核实（本轮做的就是这一层）。
- P5-2-0 探针（`subagentHostProbe.test.ts`）是否在 Windows / Electron utility 载体上同样通过，没有现行证据——探针本身是纯 Node/vitest 用例，理论上跨平台，但从未在非 Linux 环境实跑过。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| H/17 本地模式 AI 服务在打包产物里可用 | 添加自定义服务后模型选择器能拉到模型列表并可对话；safeStorage 不可用时界面如实显示未加密 | 打包应用 + CDP/手工点验 | dev-box（打包产物）/ windows / encrypted |
| H/19 插件安装在打包产物里的路径解析正确 | `currentPiCliLayout()` 在打包布局下解析出的 `pi` 可执行文件路径存在且可跑；安装/卸载后 `settings.json` 与 `node_modules` 增减正确 | 打包应用真实调用 `pi install/remove/list` | windows / encrypted |
| H/19 验证案例 7 | GUI 与内嵌 TUI 都能列出迁移/导入后的历史会话；在 TUI 里续聊一轮再回 GUI，历史接得上 | 真实 Electron + 内嵌 PTY，走完整一圈 | dev-box（需先有 H/20 完整闭环）→ windows / encrypted |
| H/21 Codex 旧格式导入 | 用一份真实的旧格式 Codex rollout（裸 header、裸行）跑导入，标题/正文/幂等三项与新格式一致 | 需要一份真实旧格式样本文件（当前开发机没有） | dev-box（需先找到或构造真实样本）/ real-model 续聊验证 |
| H/21 内嵌 TUI 模型缺失覆盖层 | 打开一条模型已被迁移覆盖的旧会话，TUI 侧同样给出可读的「模型缺失」提示而不是裸错误 | 真实 Electron，切到内嵌 TUI 视图 | dev-box / windows / encrypted |
| H/17 + H/19 打包与加密机联合回归 | 本地模式首次进入、加服务、统一目录迁移、插件安装卸载，全链路在加密文件系统与 Windows 上各跑一遍 | 现场实测（并入最后一次上机） | windows / encrypted |
| P5-2-0 探针跨平台 | `subagentHostProbe.test.ts` 10 条在 Windows 与 Electron utility 载体上同样全绿 | 随批次 E 常规测试套件跑一次，无需专门驱动 | windows / utility |

## 读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（全文，含 GAP 第 72 行）
- docs/plantree/plans/runtime-hardening/roadmap.md（全文，Done/In Progress/Next/Deferred）
- docs/plantree/plans/runtime-evolution/README.md（第 20～41、145～210 行）
- docs/plantree/plans/runtime-evolution/topics/local-provider-management.md
- docs/plantree/plans/runtime-evolution/topics/unified-agent-directory.md
- docs/plantree/plans/runtime-evolution/topics/external-agent-migration.md
- docs/plantree/plans/runtime-evolution/topics/conversation-import.md
- docs/plantree/plans/runtime-evolution/topics/p5-2-0-baseline.md
- docs/plantree/plans/runtime-evolution/evidence/unified-agent-directory/README.md
- docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md
- docs/plantree/plans/runtime-hardening/decisions/012-retire-extension-ui-chain.md
- src/main/services/piModelConfig/PiModelConfigService.ts
- src/main/services/piModelConfig/index.ts（部分，grep 命中行）
- src/main/services/agent-host/PiUtilityService.ts（部分）
- src/main/services/agent-host/WorkerManager.ts（部分，行 91-399、1995-2020、2770-2799）
- src/main/services/agent-host/createPiWorkerSlot.ts（部分）
- src/main/services/agentMigration/AgentDirMigrationService.ts（全文相关段落）
- src/main/services/agentMigration/index.ts
- src/main/services/piPlugins/index.ts（部分）
- src/main/ipc/piPlugins.ts（部分）
- src/main/ipc/agentCatalog.ts
- src/renderer/components/settings/PiPluginsSettings.tsx（前 140 行）
- src/shared/types/ipc.ts（部分，CHAT_LIST_SESSION_CAPABILITIES 段）
- src/runtime/plugins/model-adapter/catalog.ts（前 40 行）
- src/runtime/bootstrap.ts（部分，440-495 行）
- src/runtime/worker/nativeWorkerRuntime.ts（部分，grep 命中）
- src/runtime/package.json
- src/runtime/node_modules/@earendil-works/pi-agent-core/package.json（version 字段）
- src/runtime/node_modules/@earendil-works/pi-ai/package.json（version 字段）
- src/runtime/__tests__/subagentHostProbe.test.ts（结构，前 100 行 + `describe`/`it` 清单）
- vitest.config.ts（部分）
- package.json（部分，pi-coding-agent pin 行）
- src/agent-host/piWorkerRpcServer.ts（部分，grep 命中行）
- src/agent-host/userResourcePaths.ts（grep 命中）
- src/runtime/flags.ts（grep 命中）
- src/shared/types/workerRpc.ts（grep 命中）
