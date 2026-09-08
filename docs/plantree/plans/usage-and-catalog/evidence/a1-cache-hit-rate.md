# Evidence — A1 缓存命中率

**日期**：2026-09-08 · **分支**：`feat/model-catalog-admin` · **环境**：Linux 6.12.94，本机小服务器（资源受限）。

## 落地

| 文件 | 改动 |
|---|---|
| `src/shared/piUsage.ts` | 新增纯函数 `deriveCacheHitRate(usage): number \| null` |
| `src/renderer/components/workspace-shell/surfaces/runPanelModel.ts` | 视图模型新增 `cacheHitRate` 字段 |
| `src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx` | Cache write 行之后新增 `Cache hit rate` 行 |
| `src/shared/i18n.ts` | 新增 `'Cache hit rate': '缓存命中率'` |
| `src/shared/__tests__/piUsage.test.ts` | 新增 `describe('deriveCacheHitRate')`，六条用例 |
| `src/renderer/components/workspace-shell/__tests__/runPanelModel.test.ts` | 新增两条接线用例 |

## 口径确认

```text
命中率 = Math.round(cacheRead / (input + cacheRead) * 100)   // 分母不含 cacheWrite
```

与 `PI-Desktop/apps/desktop/src/lib/context-usage.ts:250` 的 `calculateCacheRate` 同式
（已实读该文件确认，不是凭记忆）：`inputTokens` 是未命中的 prompt 部分，`cacheReadTokens` 是命中部分，
cache write 是**为后续轮次写入缓存的代价**，计入分母会让「暖缓存的那一轮」被记两次未命中。

**返回值是已取整的 0..100 整数百分数**，不是比值。理由写在函数文档里：
多个界面可能都印这个数，各自 `Math.round` 一次就会出现两个视图差一个百分点。
取整算子与刻度和 `ComposerUsageChip` 现有的 `Math.round(occupancy.percent)` 一致，
视图只负责补 `%`；即便某个视图再包一层 `Math.round` 也是幂等的。

## 四条判据的对应用例

| roadmap 判据 | 用例 |
|---|---|
| 臂 1 分母为 0 → `null`，不得显示 `0%` | `returns null when there are no prompt tokens to divide` |
| 臂 2 只有 cacheWrite、cacheRead=0 → `0` | `reports 0 when the prompt was billed and none of it was cached` |
| 臂 3 cacheRead 缺失/非数/负数 → `null` | `treats an unreported or nonsensical count as unknown, not as zero` |
| 臂 4 取整口径与 `ComposerUsageChip` 一致 | `rounds once, the way the composer chip rounds occupancy` |

**臂 1 与臂 2 的优先级已显式钉住**：`input=0, cacheRead=0, cacheWrite>0` 返回 `null` 而不是 `0`。
roadmap 两条臂在 `input=0` 时字面冲突，此处按臂 1 的定义（分母为 0 即未知）裁决，并写成断言。

另加两条 roadmap 未要求但值得钉住的：
- `input>0, cacheRead=0, cacheWrite=0`（provider 完全没有缓存）→ `0`，**不是 `null`**。
  这正是哨兵要抓的「缓存悄悄停止工作」场景，隐藏它就失去了这一行的意义。
- `deriveCacheHitRate` 不修改传入的 usage 对象（前后 `toEqual`）。

## UI 渲染条件

`view.cacheHitRate !== null` 时渲染，**包含 0%**。
与上面两行 `cacheRead > 0` / `cacheWrite > 0` 的条件不同是有意的：绝对数为 0 时没有信息量，
比率为 0 时有——它说明这一轮完全没命中。

## 门禁执行记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| lint | `node_modules/.bin/biome check <6 个改动文件>` | **通过**，`Checked 6 files. No fixes applied.`（首轮报一处 formatter 差异，已 `--write` 修好后复跑） |
| typecheck | `NODE_OPTIONS=--max-old-space-size=1200 node_modules/.bin/tsc --noEmit` | **通过**，exit 0（全量，非分片） |
| test | `node_modules/.bin/vitest run src/shared/__tests__/piUsage.test.ts src/renderer/components/workspace-shell/__tests__/runPanelModel.test.ts --maxWorkers=1 --no-file-parallelism` | **通过**，2 files / 41 tests，358ms |

## 未跑到的门禁（如实记录，不写成全绿）

- **未跑整套 `pnpm test`**。只跑了两个相关测试文件。本机是资源受限的小服务器，按 roadmap
  「通用门禁」的小批次约定执行；整套回归以 CI 为准。
- **未跑 `pnpm lint`（全仓）**。只对 6 个改动文件跑了 `biome check`。
- **未跑任何生产构建**（`pnpm build` / `dist:prereq` / electron-builder）。A1 不碰构建链。
- **未启动 Electron GUI**。`RunSurfaceView.tsx` 的新行没有自动化覆盖——vitest 是
  `environment: 'node'` 且只收 `**/__tests__/**/*.test.ts`，`.tsx` 不在采集范围。
  按 roadmap，GUI 点验并入 [UI 对齐计划](../../pix-ui-alignment/README.md) 的累计点验。
  待点验项：Run 面板在 Cache write 之下出现「缓存命中率 / Cache hit rate」一行；
  未产生用量的会话不出现该行。

## 未做的可选项

`ComposerUsageChip.tsx` 的 tooltip **未改**。roadmap 与 TODO 都标为可选。
不做的理由：该组件自己的文档注释写明「exact numbers stay one click away in the Run surface,
which is where the rest of the usage breakdown already lives」——把命中率塞进 composer tooltip
与它的既定分工相反。需求触发再做。
