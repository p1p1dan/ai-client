# TODO — 用量可见性与目录韧性（A 组）

> 勾选视图。任务身份与判据以 [roadmap.md](./roadmap.md) 为准。

## A1 · 缓存命中率（S，半天）

- [ ] `src/shared/piUsage.ts` 新增 `deriveCacheHitRate(usage): number | null`
- [ ] 臂 1：分母为 0 → `null`（**不得显示 `0%`**）
- [ ] 臂 2：只有 cacheWrite、cacheRead=0 → `0`
- [ ] 臂 3：cacheRead 缺失/非数/负数 → `null`
- [ ] 臂 4：取整口径与 `ComposerUsageChip` 现有 `Math.round` 一致
- [ ] `runPanelModel.ts` 输出字段
- [ ] `RunSurfaceView.tsx` Cache read/write 之后加一行
- [ ] （可选）`ComposerUsageChip.tsx` tooltip 补一行，不改可见字形
- [ ] 门禁：lint / typecheck(`--max-old-space-size=1200`) / 小批次 test
- [ ] evidence 文件，含未跑到的门禁

## A2 · 会话内轮级汇总（M，2–3 天，A1 之后）

- [ ] **前置取证**：pi 的 `turn_end` 是否携带子代理用量增量？结论写进 evidence
- [ ] 新建 `src/shared/piTurnRollup.ts`：`init` / `apply` / `view` 三个纯同步函数
- [ ] `piWorkerSession.ts:909` `turn_end` 臂接入
- [ ] 臂：多轮相加正确
- [ ] 臂：`apply` 收到不改状态的事件返回**同一引用**（`Object.is`）
- [ ] 臂：缺字段 usage 不污染累加
- [ ] 臂：会话切换归零，worker 复用不串号
- [ ] 臂：汇总永不写回单条消息（前后逐字段相等）
- [ ] Run 面板新增「本会话累计」分组，与「上一轮」**分别标注**
- [ ] 门禁 + evidence

## A3 · 模型目录随包快照（M，1–2 天，可并行）

- [ ] `resources/model-catalog/snapshot.json` 首版落库
- [ ] 新建 `catalogSnapshot.ts`，复用 `validatePiManagedModelsConfig`
- [ ] `PiModelConfigService.ts` 的 `unavailable` 分支回落快照
- [ ] `src/shared/piModelConfig.ts` 给 `PiModelSyncSource` **追加**取值（只追加不重排）
- [ ] 新建 `scripts/refresh-model-catalog.mjs`：拉取 → 校验 → 原子替换
- [ ] 选定发布流程接入点并写进 evidence
- [ ] `electron-builder.yml` 打包快照
- [ ] 臂：损坏快照被拒且不使启动失败
- [ ] 臂：拉取失败 → 回落快照，`source='bundled'`，`endpointUrl` 如实报告
- [ ] 臂：快照缺失 → 仍是 `unavailable`
- [ ] 臂：拉取成功 → 内存结果覆盖，`source` 回到 `'remote'`
- [ ] 臂：刷新动作**不写盘**（断言写盘路径未被调用）
- [ ] 门禁 + evidence

## 收尾

- [ ] GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md) 的累计点验
- [ ] 三项全部 Done 后，在根注册表把本计划移入 Archived 并改写本 README 状态行
