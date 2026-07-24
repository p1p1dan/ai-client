# Test & Release Gates

## 提交门禁（DoD，执行计划 §4）

- **三绿**：`pnpm typecheck`（**不覆盖 src/agent-host/**，tsconfig 排除）/ `pnpm lint`（biome，**0 诊断基线**自 C-09 `ce5a577`；`.gitattributes` 锁代码文件 eol=lf）/ `pnpm test`（vitest；2026-07-24 时点 38 文件 344 例）。
- 提交规范 Conventional Commits 中文描述（分类表见 `CLAUDE.md`）。
- 加密机相关项**永不**在开发机标注通过。

## Host 门禁（typecheck 盲区的补位）

- vitest 单测：`src/agent-host/__tests__/`（historyReader / eventNormalizer / permissionBridge / **protocolErrors 真子进程 NDJSON**）。
- spikes smoke：`src/agent-host/spikes/*-smoke.ts`（网关凭证由 `testCredentials.ts` 自动注入，零配置）。

## 打包门禁

- `pnpm verify:packaged` 25 项：app 壳 / agent-host 结构与剪枝 / TSD header 哨兵 / Node24 寻径 / **随包 node.exe 直跑网关 PONG**。
- 打包链：`pnpm dist:prereq` → electron-builder → afterPack 串行拷贝（勿回退 extraResources——rcedit 竞态先例见主线台账 C-02 行）。

## CI

- `.github/workflows/build.yml`：tag 触发，双平台打包 + agent-host 构建 + 结构断言。
- **无测试作业**（C-09 期间发现）——是否补 test/lint 步骤见 open-questions。

## GUI 联调环境

```powershell
$env:CLAUDE_CONFIG_DIR='C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config'; pnpm dev
```
（等价 `pnpm prepare:test-config` 生成；Beta 壳入口：Settings → Appearance → OpenChamber Workspace Shell）
