# TODO — 用量可见性与目录韧性（A 组）

> 勾选视图。任务身份与判据以 [roadmap.md](./roadmap.md) 为准。
>
> **2026-09-08**：A1 / A2 / A3 三项代码与自动化全部完成，逐项证据在 [evidence/](./evidence/)。
> 剩下的两项都不是编码工作：一次累计 GUI 点验，和三项都 Done 后的计划归档。

## A1 · 缓存命中率（S，半天）

- [x] `src/shared/piUsage.ts` 新增 `deriveCacheHitRate(usage): number | null`
- [x] 臂 1：分母为 0 → `null`（**不得显示 `0%`**）
- [x] 臂 2：只有 cacheWrite、cacheRead=0 → `0`
- [x] 臂 3：cacheRead 缺失/非数/负数 → `null`
- [x] 臂 4：取整口径与 `ComposerUsageChip` 现有 `Math.round` 一致
- [x] `runPanelModel.ts` 输出字段
- [x] `RunSurfaceView.tsx` Cache read/write 之后加一行
- [ ] （可选）`ComposerUsageChip.tsx` tooltip 补一行 —— **不做**，理由见 [a1 evidence](./evidence/a1-cache-hit-rate.md#未做的可选项)
- [x] 门禁：lint / typecheck(`--max-old-space-size=1200`) / 小批次 test
- [x] evidence 文件，含未跑到的门禁

## A2 · 会话内轮级汇总（M，2–3 天，A1 之后）

- [x] **前置取证**：pi 的 `turn_end` 是否携带子代理用量增量？结论写进 evidence
- [x] 新建 `src/shared/piTurnRollup.ts`：`init` / `apply` / `view` 三个纯同步函数
- [x] `piWorkerSession.ts:909` `turn_end` 臂接入
- [x] 臂：多轮相加正确
- [x] 臂：`apply` 收到不改状态的事件返回**同一引用**（`Object.is`）
- [x] 臂：缺字段 usage 不污染累加
- [x] 臂：会话切换归零，worker 复用不串号
- [x] 臂：汇总永不写回单条消息（前后逐字段相等）
- [x] Run 面板新增「本会话累计」分组，与「上一轮」**分别标注**
- [x] 门禁 + evidence

## A3 · 模型目录随包快照（M，1–2 天，可并行）

- [x] `resources/model-catalog/snapshot.json` 首版落库
- [x] 新建 `catalogSnapshot.ts`，复用 `validatePiManagedModelsConfig`
- [x] `PiModelConfigService.ts` 的 `unavailable` 分支回落快照
- [x] `src/shared/piModelConfig.ts` 给 `PiModelSyncSource` **追加**取值（只追加不重排）
- [x] 新建 `scripts/refresh-model-catalog.mjs`：拉取 → 校验 → 原子替换
- [x] 选定发布流程接入点并写进 evidence（**人工发布前步骤 + `verify:release` 静态门禁**，不接 `dist:prereq`）
- [x] `electron-builder.yml` 打包快照
- [x] 臂：损坏快照被拒且不使启动失败
- [x] 臂：拉取失败 → 回落快照，`source='bundled'`，`endpointUrl` 如实报告
- [x] 臂：快照缺失 → 仍是 `unavailable`
- [x] 臂：拉取成功 → 内存结果覆盖，`source` 回到 `'remote'`
- [x] 臂：刷新动作**不写盘**（断言写盘路径未被调用）
- [x] 门禁 + evidence

## 收尾

- [ ] GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验
- [ ] 三项全部 Done 后，在根注册表把本计划移入 Archived 并改写本 README 状态行
