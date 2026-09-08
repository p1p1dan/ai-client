# Implementation Status — 用量可见性与目录韧性（A 组）

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**In Progress（收尾）。** 2026-09-08 立项当天完成 A1 / A2 / A3 三项的全部代码与自动化。
剩下的两件都不是编码工作：一次累计 GUI 点验，以及三项确认 Done 后的计划归档。

三项的逐条落地与门禁记录：
[a1-cache-hit-rate](./evidence/a1-cache-hit-rate.md) ·
[a2-turn-rollup](./evidence/a2-turn-rollup.md) ·
[a3-catalog-snapshot](./evidence/a3-catalog-snapshot.md)。

## Active TODO（最多五项）

1. **GUI 点验**（并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验）。三项各自的待点验项
   逐条写在自己的 evidence 末尾；本计划不单开轮次。三项的渲染层改动都在 `.tsx` 里，
   而 vitest 是 `environment: 'node'` 且只收 `*.test.ts`，所以这部分**没有**自动化覆盖。
2. **A3 打包实测**：需要一次真实打包（或一份 CI 产物）确认
   `<resources>/model-catalog/snapshot.json` 真的在产物里。目前只有 `electron-builder.yml`
   的静态断言，**没有拆包证据**。
3. ~~A3 首份真实快照~~ —— **已完成**（2026-09-08）。管理端已部署，
   `resources/model-catalog/snapshot.json` 现在是真实目录：4 provider / 10 模型，
   全部 `credentials.apiKey: 'onboarding'`，文件里没有密钥。onboard 侧一行未改。
   `verify:release` 同步新增「拒绝零模型快照」门禁，防止空快照在其它检查全绿时悄悄让兜底失效。
4. **A2 的一处未取证项**：随包扩展 `@gotgenes/pi-subagents` 是否**实际填写**
   `ToolResultMessage.usage`。协议层已取证（SDK 明说该字段不在主账里，所以是增量），
   但该扩展本机未安装、未实测。若它不填，`toolResults` 计数恒为 0，其余数字仍正确——降级方向安全。
5. 三项确认 Done 后：在根注册表把本计划移入 Archived，并改写本计划 README 的状态行。

## Blocker

无。

A1 → A2 的合入顺序约束（同改 `src/shared/piUsage.ts`）已不再适用：两项在同一轮里按序落地，
A1 先加 `deriveCacheHitRate`，A2 再加 `session` 字段，没有并发改同一导出面的情况。

与 B 组的三处接缝**全部未被触碰或按约定处理**：

- `src/shared/piModelConfig.ts`：A3 只在 `PiModelSyncSource` **末尾追加** `'bundled'`，
  未重排任何既有取值，与 B3 的 `PiResourceSettings` 改动可自动合并。
- `src/main/services/piModelConfig/index.ts`（归 B）：**一行未改**。
  `catalogSnapshot.ts` 的默认读取器只从 `process.resourcesPath` / `process.cwd()` 取路径、
  不 import `electron`，所以 `PiModelConfigService` 自己就能兜住默认值，不需要在 index.ts 接线。
- `src/agent-host/piAgentSessionBootstrap.ts`：**一行未改**。

## Last verified

**2026-09-08**，分支 `feat/model-catalog-admin`，Linux 6.12.94 本机小服务器。

| 门禁 | 命令 | 结果 |
|---|---|---|
| lint | `node_modules/.bin/biome check <24 个改动/新增文件>` | 通过 |
| typecheck | `NODE_OPTIONS=--max-old-space-size=1200 node_modules/.bin/tsc --noEmit` | 通过 |
| typecheck (agent-host) | `node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json` | 通过 |
| test | `vitest run src/shared/__tests__/ src/agent-host/__tests__/piWorkerSession.test.ts src/renderer/components/workspace-shell/__tests__/ src/renderer/components/chat/__tests__/piModelCatalog.test.ts src/main/services/piModelConfig/__tests__/ scripts/__tests__/ --maxWorkers=1 --no-file-parallelism` | 通过，**55 files / 801 tests** |
| release 门禁 | `node scripts/verify-release-metadata.mjs` | 通过 |

**未跑到的门禁（不写成全绿）**：整套 `pnpm test` 未跑（只跑上述批次）；`pnpm lint` 全仓未跑
（只跑改动文件）；**任何生产构建都未跑**（`pnpm build` / `dist:prereq` / electron-builder）；
**Electron GUI 未启动**。以上均按仓库规范如实记录，整套门禁以 CI 为准。
