# Plan — 用量可见性与目录韧性（A 组）

> **状态**：Not Started —— 三项（A1–A3）均未动工。
>
> **范围**：把已经拿到但没用起来的用量数据变成可判断的信号（A1 缓存命中率、A2 会话内轮级汇总），
> 以及给模型目录一条离线基线（A3 随包快照）。三项共享一个主题——**已有数据的可用性**，
> 不新增任何对外接口，不改进程模型。
>
> **状态权威**：[roadmap.md](./roadmap.md) · **当前进度与欠项**：[implementation-status.md](./implementation-status.md)。
> **执行清单**：[TODO.md](./TODO.md) · **需求原文**：[PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md)。

## 为什么是一组

三项都落在**数据链路**上：usage 事件的生产端（`agent-host`）、投影端（`shared/piUsage`）、
展示端（Run 面板），以及模型目录的读取端（`PiModelConfigService`）。
它们与 B 组的资源目录/设置页/导入**没有共享文件**（例外三处见下），可以两队并行。

## 与 B 组的文件边界（并行前提）

本计划**只碰**下表左列。右列属 [资源归位与会话导入](../resource-home-and-import/README.md)，本组不碰。

| A 组拥有 | B 组拥有 |
|---|---|
| `src/shared/piUsage.ts` | `src/main/services/piModelConfig/index.ts` |
| `src/shared/piTurnRollup.ts`（新建） | `src/agent-host/userResourcePaths.ts` |
| `src/agent-host/piWorkerSession.ts` | `src/agent-host/bundledPlugins.mjs` / `bundledFeaturePlugins.ts` |
| `src/main/services/piModelConfig/PiModelConfigService.ts` | `src/renderer/components/settings/PiResourcesSettings.tsx` |
| `src/main/services/piModelConfig/catalogSnapshot.ts`（新建） | `src/shared/types/legacyImport.ts` · `src/agent-host/piLegacyImport.ts` |
| `resources/model-catalog/`（新建） · `scripts/refresh-model-catalog.mjs`（新建） | `src/agent-host/codexHistoryReader.ts` / `codexItemMapper.ts` |
| `src/renderer/components/workspace-shell/surfaces/runPanelModel.ts` / `RunSurfaceView.tsx` | |
| `src/renderer/components/chat/ComposerUsageChip.tsx` | |
| `electron-builder.yml` | |

**三处需要协调的接缝**：

1. `src/shared/piModelConfig.ts`（shared 常量文件）：A3 要给 `PiModelSyncSource` 加取值，
   B3 要改 `PiResourceSettings`。**两边都只追加，不改动已有字段顺序**，冲突可自动合并。
2. `src/main/services/piModelConfig/index.ts` 归 B。A3 若确实需要在此导出新符号，
   走**追加一行 re-export**，不重排该文件。
3. 两组都不得改动 `src/agent-host/piAgentSessionBootstrap.ts`。它承载权限闸的 fail-closed 判定，
   任何一组要动都要先在本文件登记。

## 已确认口径

来自 [调研档](../../../plans/2026-09-08-pi-desktop-study.md) §3.2 / §3.3，本计划不再重新讨论：

1. **单条消息的 usage 永不被改写。** 它是 provider 报的原值，子代理花费绝不合并进去。
2. **「上一轮」与「本会话累计」是两个数字**，UI 上必须分别标注，不得混为一个总数。
   现有 `RunSurfaceView.tsx:322` 的注释（一次 run 结算多轮，相加会印出没人被收过的费）依然成立，
   A2 是给它补一个**有定义的**总数，不是推翻它。
3. **随包快照不是第二权威。** 它与在线目录出自同一个管理端，只是时间点不同；
   UI 必须能说出「这是随包基线，不是刚拉的」。
4. **缓存命中率的分母不含 cache write**：`cacheRead / (input + cacheRead)`。

## 明确不做

- 跨会话的用量历史与热力图看板（调研档 §3.2：那是插件的活，我们还没有插件通道）。
- 用量数据落盘。A2 第一版只在内存与事件流中存在；落盘拆为 A2-b，需求触发再做。
- 任何对 `models.dev` 的引用。我们的目录出自自己的管理端，不引入外部目录源。

## 文件地图

| 内容 | 位置 |
|---|---|
| 任务 ID / 状态 / 顺序（唯一权威） | [roadmap.md](./roadmap.md) |
| 当前 phase / Next / blocker | [implementation-status.md](./implementation-status.md) |
| 执行清单（勾选视图） | [TODO.md](./TODO.md) |
| 逐任务落地证据 | [evidence/](./evidence/) |
| 需求原文 | [PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md) |

## 2026-09-08 B 组接缝登记

B1/B2 必须在 `src/agent-host/piAgentSessionBootstrap.ts` 的 `resourceLoaderOptions`
接入默认技能安装提示与只读全局指令。仅 B 组修改该资源选项和相应 import；
不改权限 gate、扩展验证、WorkerSession 或 A 组用量链路。
配套允许追加 `src/preload/index.ts`、`src/shared/types/ipc.ts` 的技能目录 IPC，
以及 shared i18n 的对应翻译和相关测试。上述登记是本轮明确的文件边界例外。
