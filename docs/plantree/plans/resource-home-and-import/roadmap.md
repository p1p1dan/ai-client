# Roadmap — 资源归位与会话导入（B 组）

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 需求原文与取证在 [PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md)；
> 本文件只维护任务身份、状态、依赖，以及调研档没写的**落点**与**判据**。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 0 | — |
| In Progress | 0 | — |
| Next | 4 | B1 取证先行；B3、B4 与 B1/B2 零依赖，可同时起 |
| Deferred | 1 | opencode 导入，需求触发再做 |

## 执行顺序

```text
串行线（B2 依赖 B1 的取证结论）
  B1 技能默认安装位 = ~/.agents/skills   ← 含前置取证，必须最先做
  B2 借读面对齐

并行线（与上面零文件重叠，可同时开工）
  B3 随包扩展表驱动
  B4 会话导入扩到 Codex
```

**B1 的取证必须最先做**：它的结论决定 B2 要不要借 `~/.agents/subagents`——
如果 pi 原生就读 `~/.agents`，那一半根本不用借。
B3 和 B4 是两条独立的线，一个人做 B1→B2、另一个人做 B3→B4 也成立。

## 通用门禁

每个任务合入前：`pnpm lint` · `pnpm typecheck` · `pnpm test`。
本机是资源受限的小服务器，测试按小批次执行（`--maxWorkers=1 --no-file-parallelism`），
不跑整套生产构建；未跑到的门禁如实记在 [implementation-status](./implementation-status.md)，不写成全绿。
`tsc --noEmit` 需要 `--max-old-space-size=1200`。

**每个任务至少一条纯函数层断言。** vitest 是 `environment: 'node'` 且只收 `*.test.ts`，
写在 `.tsx` 里的判断没有自动化覆盖。设置页的判断要先落到纯模块——
既有范式见 `components/settings/__tests__/piResourcesSettingsStatic.test.ts`。

GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验，本计划不单开轮次。

---

## B1 — 技能默认安装位 = `~/.agents/skills` · **Next（含前置取证）**

**要解决的问题**：用户让 App 里的 AI「帮我装一个 skill」时，模型会按官方文档往
`~/.pi/agent/skills/` 写。托管模式下那要靠借读开关才生效，内嵌 pi TUI 则完全看不到
（`resolveManagedPiPtyEnv` 刻意摘掉借用变量，`piModelConfig/index.ts:230-247`）。
**根因是我们没有一个可写的共享安装位**，而不是目录归属有问题。

`~/.agents/skills` 已经是设置页里唯一标 `Recommended` 的那一行，文案写着
「托管模式、本地模式、Pi TUI 三处始终加载」（`PiResourcesSettings.tsx:105`）。
缺的只是**模型不知道该往那儿写**。

### B1-a 前置取证（必须最先做，半天）

**该承诺在本仓没有测试或探针支撑。** `commandInventory.test.ts:65` 里那条
`~/.agents/skills/pdf/SKILL.md` 是夹具不是实证。动工前先证实：

1. 在 `~/.agents/skills/<临时名>/SKILL.md` 放一个最小技能文档；
2. 起一个 worker（参照 `scripts/probes/` 与 `scripts/run-t29c-worker-probe.mjs` 的既有形状）；
3. 读 `services.resourceLoader.getSkills()`，确认该技能在列，并记下它的 `sourceInfo.scope`；
4. 托管模式、本地模式各跑一次；TUI 那次可用 `PiTuiPty` 的 launch plan 手工验。

**取证结论写进 evidence，无论正反。** 如果 pi 并不原生加载该目录，B1 的落点要改成
「把 `~/.agents/skills` 加进 `additionalSkillPaths`」，且 TUI 那一半仍然是洞——
届时在 evidence 里如实记，不要让设置页那句话继续无据地挂着。

### B1-b 落点（取证通过后）

| 文件 | 改动 |
|---|---|
| 系统提示或内建命令 | 给模型一个明确的技能安装路径；让「帮我装个 skill」有确定落点 |
| `src/renderer/components/settings/PiResourcesSettings.tsx` | 文案从「推荐」改为「默认」；补一个「打开技能目录」按钮（现在只有 prompts 有） |
| `src/main/ipc/piResources.ts` | 「打开技能目录」的 IPC，比照现有 `openPromptTemplates` |

**判据**

1. 探针脚本进 `scripts/probes/`，可重跑，输出结论而不是靠人读日志。
2. 路径解析的纯函数臂：`getPiResourceSettings().paths.sharedSkills` 在 `HOME` 被覆盖时跟着走
   （既有 `piWorkerEnv.test.ts:170` 已有一条，扩到打开目录那条路径）。
3. 设置页文案改动有静态断言（`piResourcesSettingsStatic.test.ts` 的既有范式）。

**量级**：S + 探针。 **依赖**：无（本身就是其他项的前置）。

---

## B2 — 借读面对齐 · **Next（B1 取证之后）**

**要解决的问题**：现在只借 `~/.pi/agent/{skills,prompts}`。PI-Desktop 还只读
`~/.pi/agent/AGENTS.md`（全局指令，`project-instructions.ts:12`）。
用户在 `~/.pi` 写的全局指令，我们这边静默不生效。

**落点**

| 文件 | 改动 |
|---|---|
| `src/agent-host/userResourcePaths.ts` | `resolveBorrowedResourcePaths` 扩出全局指令一路 |
| `src/main/services/piModelConfig/index.ts` | `resolveManagedPiWorkerEnv` 相应传参 |
| `src/agent-host/piWorkerSession.ts` **不碰** | 属 A 组；如确需改动先在两边 README 登记 |

**是否要借 `~/.agents/subagents`：由 B1-a 的取证结论决定。** pi 原生读则不借。

**边界（不许越，改这块前先读那两段模块头注释）**

1. **只读，永不回写。** 采纳目录（而不是传路径）会拖进三样东西：`auth.json`/`models.json`
   （托管模式存在的意义就是用我们自己的凭据集）、`settings.json`（`packages` 字段会让 pi
   真的跑 `npm install`）、以及写权限（pi 运行时会重写 `settings.json`）。
2. **绝不转成 `additionalExtensionPaths`。** 扩展是代码，用户自己那份权限系统会和随包的打架。
3. 不存在的目录**丢弃而非报警**——「你没装技能」不是一个值得警告的问题（既有注释已述）。

**判据（纯函数臂，前两条是既有测试的扩臂）**

1. 不存在的路径被丢弃，不出现在返回值里。
2. 借用源与活动 agentDir 相同时返回空（本地模式下重复加载的守卫）。
3. 全局指令文件存在/不存在两臂。
4. **回归臂**：返回值里永远没有扩展路径字段——用一条断言把边界 2 钉死。

**量级**：S~M。 **依赖**：B1-a 的取证结论。

---

## B3 — 随包扩展表驱动 · **Next（可并行）**

**要解决的问题**：现在是 `enablePiSubagents` 一个布尔 + `PI_OPT_IN_EXTENSIONS_ENV` 一个逗号列表
+ `PiResourcesSettings.tsx` 里一个硬编码的 Switch。加第三、第四个随包扩展时，
会变成三四个 setting key + 三四段硬编码文案 + 三四个 Switch。

**落点**

| 文件 | 改动 |
|---|---|
| `src/agent-host/bundledPlugins.mjs` | 已有 `optIn` 字段与 feature id；提成 Main 可读的清单 |
| `src/main/services/piModelConfig/index.ts` | `resolvePiSubagentsEnabled` 泛化为 `resolveOptInFeatures()` |
| `src/shared/piModelConfig.ts` | `PiResourceSettings` **追加**清单字段（只追加，不重排——A3 也在改这个文件） |
| `src/renderer/components/settings/PiResourcesSettings.tsx` | 「随包扩展」段改为遍历清单渲染 |

**口径**

1. 清单每项**必须带一句「它花你什么」**。现有 sub-agents 那段文案是范本：
   三个工具 schema 进每次请求的缓存前缀，实测 11.4 KB 工具 JSON 中占 4.8 KB。
   没有成本说明的条目不许进清单——那正是这个开关默认关闭的全部理由。
2. **默认值随清单走**，不再一个功能一个 setting key。
3. **兼容**：已有的 `enablePiSubagents` setting key 必须继续被读。
   已经打开它的用户不得被静默关掉——这是一条硬回归线。

**判据（纯函数臂）**

1. 清单解析：合法清单 → 正确的 feature id 集合。
2. 旧 key 迁移：`enablePiSubagents: true` 的存量设置 → sub-agents 仍为开。
3. 未知 feature id 被忽略，不使读取失败。
4. 空清单 → `PI_OPT_IN_EXTENSIONS_ENV` 不下发（保持「缺席即全关」的保守侧，
   现有 `resolveManagedPiWorkerEnv` 已是这个语义）。

**量级**：M。 **依赖**：无。

---

## B4 — 会话导入扩到 Codex · **Next（可并行）**

**要解决的问题**：`LegacyImportSourceKind` 只有 `'claude-code'`。
Codex 读取其实已经写了一半——`codexHistoryReader.ts` / `codexItemMapper.ts` 已在 agent-host 里，
`__tests__/fixtures/codex/` 也已有真实会话夹具。

**落点**

| 文件 | 改动 |
|---|---|
| `src/shared/types/legacyImport.ts` | `LegacyImportSourceKind` 加 `'codex'`；`LEGACY_IMPORTER_VERSION` 相应升位 |
| `src/agent-host/piLegacyImport.ts` | 按来源分发；抽出 `{ source, scan(), convert() }` 三方法形状 |
| `src/main/services/legacyImport/*` | 扫描与选择面支持多来源 |

**借鉴与不借鉴**

- **借**：PI-Desktop 的三方法接口（`importers/index.ts`），以及 `scanAllSources` 的
  **单源抛错降级为空数组**——一个坏来源不应该毁掉整个扫描。
- **借**：确定性 id 里带上来源。
- **不借**：**不要**用 `import-<source>-<externalId>` 换掉我们的指纹机制。
  我们的 `stableSourceIdentity` + contentHash + size + mode + mtime 比它强，
  只需把 source 加进 id 的组成部分，两者不冲突。

**判据**

1. 用 `__tests__/fixtures/codex/` 的真实文件做夹具，不用手写的假 JSONL。
2. **幂等臂**：同一个 codex 会话导两次，第二次不产生新会话。
3. 跨来源的 id 不碰撞（同名 externalId 分属两个来源时是两条会话）。
4. 坏来源臂：codex 目录不可读时，claude-code 的扫描结果仍完整返回。

**量级**：M。 **依赖**：无。

---

## B5 — opencode 会话导入 · **Deferred**

第四个来源。B4 把三方法形状立起来之后是纯增量。**需求触发再做。**
