# Plan — 资源归位与会话导入（B 组）

> **状态**：Not Started —— 四项（B1–B4）均未动工。
>
> **范围**：给用户资源一个**可写的落点**（B1 技能默认安装位、B2 借读面对齐），
> 把随包扩展从「一个功能一个开关」改成表驱动（B3），以及把会话导入扩到 Codex（B4）。
> 四项共享一个主题——**用户自己的东西放在哪、怎么被看见**。
>
> **状态权威**：[roadmap.md](./roadmap.md) · **当前进度与欠项**：[implementation-status.md](./implementation-status.md)。
> **执行清单**：[TODO.md](./TODO.md) · **需求原文**：[PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md)。

## 为什么是一组

四项都落在**资源目录与设置页**这条线上：`piModelConfig/index.ts` 的资源那一半、
`userResourcePaths.ts`、`bundledPlugins.mjs`、`PiResourcesSettings.tsx`、导入链路。
它们与 A 组的用量/目录数据链路**没有共享文件**（例外三处见下），可以两队并行。

## 与 A 组的文件边界（并行前提）

本计划**只碰**下表左列。右列属 [用量可见性与目录韧性](../usage-and-catalog/README.md)，本组不碰。

| B 组拥有 | A 组拥有 |
|---|---|
| `src/main/services/piModelConfig/index.ts`（**整个文件**） | `src/shared/piUsage.ts` · `src/shared/piTurnRollup.ts`（新建） |
| `src/agent-host/userResourcePaths.ts` | `src/agent-host/piWorkerSession.ts` |
| `src/agent-host/bundledPlugins.mjs` / `bundledFeaturePlugins.ts` | `src/main/services/piModelConfig/PiModelConfigService.ts` |
| `src/renderer/components/settings/PiResourcesSettings.tsx` | `src/main/services/piModelConfig/catalogSnapshot.ts`（新建） |
| `src/shared/types/legacyImport.ts` · `src/agent-host/piLegacyImport.ts` | `resources/model-catalog/` · `scripts/refresh-model-catalog.mjs`（新建） |
| `src/agent-host/codexHistoryReader.ts` / `codexItemMapper.ts` | Run 面板 · `ComposerUsageChip.tsx` · `electron-builder.yml` |
| `src/main/services/legacyImport/*` · `src/main/ipc/piResources.ts` | |

**三处需要协调的接缝**：

1. `src/shared/piModelConfig.ts`（shared 常量文件）：B3 要改 `PiResourceSettings`，
   A3 要给 `PiModelSyncSource` 加取值。**两边都只追加，不改动已有字段顺序**，冲突可自动合并。
2. `src/main/services/piModelConfig/index.ts` 归 B。A 组若需在此导出新符号，
   走**追加一行 re-export**；B 组不要重排该文件的既有导出顺序，以免把那一行冲掉。
3. 两组都不得改动 `src/agent-host/piAgentSessionBootstrap.ts`。它承载权限闸的 fail-closed 判定，
   任何一组要动都要先在本文件登记。

## 已确认口径

来自 [调研档](../../../plans/2026-09-08-pi-desktop-study.md) §2 / §3.1，本计划不再重新讨论：

1. **不改用 `~/.pi` 作为 agent 目录，不做运行时备份还原。** 三条理由记在调研档 §2.3：
   备份是有状态操作崩溃即失真、并发击穿备份语义、信任闸语义无法解释。
   `PI_CODING_AGENT_DIR` 继续指向 `~/.pilab/<profile>/pi-agent`。
2. **真正的痛点是缺少可写的共享安装位**，不是目录归属。B1 就是补这个。
3. **借读永远只读，永不回写；绝不转成 `additionalExtensionPaths`。**
   这条已经写在 `userResourcePaths.ts` 模块头与 `piAgentSessionBootstrap.ts:427`，
   改这块的人**必须先读那两段注释**。理由：技能与模板是进上下文的文本，扩展是代码，
   用户自己那份权限系统会和随包的打架。
4. **不做第三方插件平台。** PI-Desktop spec 自述「插件主进程保留裸 Node 内置，
   市场包即以用户权限运行的任意代码，沙箱未实现」；我们的产品发到加固机器，风险性质不同。
   B3 只做随包扩展的表驱动化。

## 明确不做

- 第三方插件市场、插件沙箱、插件权限矩阵（口径 4）。
- 把 `PI_CODING_AGENT_DIR` 指向 `~/.pi/agent`，或任何形式的用户配置备份还原（口径 1）。
- Subagent 生命周期改造（用户 2026-09-08 裁定本轮不做，记档在调研档 §3.4）。
- opencode 会话导入：B4 只做 Codex。opencode 需求触发再立。

## 文件地图

| 内容 | 位置 |
|---|---|
| 任务 ID / 状态 / 顺序（唯一权威） | [roadmap.md](./roadmap.md) |
| 当前 phase / Next / blocker | [implementation-status.md](./implementation-status.md) |
| 执行清单（勾选视图） | [TODO.md](./TODO.md) |
| 逐任务落地证据 | [evidence/](./evidence/) |
| 需求原文 | [PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md) |
| 资源借读的既有决策 | [pi 资源接入计划 R01](../pi-resources-and-commands/README.md)（已归档，仍是边界来源） |
