# B 组合入 feat 开发分支

日期：2026-09-08。用户要求将当前 worktree 提交并合入 `/home/pi/code/ai-client`，保持 feat 分支，禁止合入 main。

- 来源：`feat/resource-home-and-import`，源码提交 `40538e1e`（68 files）。
- 目标：`feat/model-catalog-admin`，合并前为 `edc67179`，保留目标中 A 组的四个提交。
- 唯一文本冲突：Plantree 根注册表。保留 A 组最新 In Progress 收尾状态、B 组 Completed 归档状态。
- shared piModelConfig / i18n 自动合并后复核，A 的目录快照类型与 B 的扩展清单字段同时保留。
- 目标中原有未跟踪文档 `docs/plans/2026-09-08-runtime-evolution-ard.md` 保持原内容，未纳入提交。
- 当前 worktree 的 node_modules 链接没有纳入 Git。

## 目标目录验证

- `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit`：通过。
- `NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json`：通过。
- Vitest 两批，均 `--maxWorkers=1 --no-file-parallelism`，共 **10 files / 141 tests** 通过：
  - PiModelConfigService、catalogSnapshot、piWorkerEnv、optInFeatures、piResources：81 tests。
  - piWorkerSession、CodexImportIntegration、LegacyImportService、piUsage、piTurnRollup：60 tests。
- 合并 shared 文件 Biome 检查、git diff --cached --check、计划相对链接检查通过。

验证没有重新运行全仓测试；B 组此前的完整 303 files / 4532 tests 证据单独保留。
本次是本地 feat 分支合并，没有推送远端，也没有移动 main 分支。
