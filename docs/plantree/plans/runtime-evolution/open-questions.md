# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

| 问题 | 当前证据 | 处理节点 |
|---|---|---|
| Q7 `GitService` 在加密机上返回空结果 | 2026-09-08 现场：应用 git 面板对真仓库 `E:\testaaa\git-probe-once` 返回 `current: null`、`isClean: true`、`getBranches` 为 `(no commits yet)`、`getDiff` 为空；而**同一 Main 血统**下由 `terminal.create` 起的 PowerShell 里 `git status` / `git rev-parse HEAD` 完全正确，`.git\HEAD` 也是明文。故与加密无关，差异只能来自 `GitService` 自身的 spawn 参数：`createGitEnv` 用注册表 PATH 覆盖继承 PATH、`withSafeDirectoryEnv` 注入的 `GIT_CONFIG_*`、`toGitPath` 的 WSL 分支。错误被吞掉，空 stdout 被解析成「一条空分支 + 无改动」 | **ai-client 主线缺陷，不属 runtime 演进**。但 P4-5 GUI 点验会撞上它，需在此之前由主线修复或明确豁免。复现方式与原始输出见本条证据 |

### Q7 补充：三个空结果是同一个形状（2026-09-09 读码所得，未上机）

现场三个症状看着是三处 bug，其实是同一条：**读不到可解析的 stdout 时，每个 reader 都把它
翻译成一个说得通但错误的答案，而不是报错。**

- `GitService.ts:290` `getBranches`：`git branch -a -v` 解析不出分支就走「空仓库」分支，用
  `symbolic-ref --short HEAD` 取名字并贴上 `(no commits yet)`。但 `symbolic-ref` 在**任何**
  签出了分支的仓库上都成功，它根本没有区分「真空仓库」和「分支列表丢了」的能力。现场看到的
  `(no commits yet)` 就是这样造出来的——两条 git 命令都成功了，所以这不是 git.exe 找不到、
  也不是 PATH 的问题。改判据为 `git rev-parse --verify HEAD`（只有真正 unborn 才失败）即可
  让这一步要么给出真分支、要么明确失败。
- `readPorcelainV2Limited` 的 `close` 回调：`code === 0` 且 stdout 为空时直接 resolve，产出
  `current: null` + 全空数组，`getStatus` 据此算出 `isClean: true`。`--porcelain=v2 --branch`
  在任何有效仓库上都必然先打印 `# branch.oid` / `# branch.head`，所以「0 退出码 + 零条记录」
  是不可能的正常结果，应当当作失败。
- 同一个回调里 `truncated` 一个变量兼了两个意思：达到 `MAX_GIT_STATUS_ENTRIES` 和 15s 超时
  （`GIT_STATUS_STREAM_TIMEOUT_MS`）。超时时 `!truncated` 为假，于是**不 reject**，把读了一半的
  状态当成功返回。加密盘上 `git status` 走全工作区、慢到超时是很可能的，而这条路径不会留下任何
  错误痕迹。这一条与加密无关也成立，属于独立的潜在缺陷。

结论不变：**归主线修，不在本分支动 `GitService` 的 spawn 逻辑**。但上面三处的判据修正不需要
加密机就能验证，建议主线先补，再拿现场复测——否则 P4-5 点验时仍然只能看到「面板是空的」。

已收口（2026-09-08）：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent，照搬 PI-Desktop ADR 0062/0119 边界 |
| Q5 Main 侧裸 `readFile` 读 worker 写的文件会得到什么 | [ARD D13](../../../plans/2026-09-08-runtime-evolution-ard.md) — 2026-09-08 现场坐实为**密文**：加密按文件策略生效，Main 及其派生进程读用户文件得到 `%TSD-Header-###%`。Main 侧统一改走 `readFileTsdSafe` |
| Q4 新旧后端对比用哪一版 Pi 协议依赖 | [ARD D12](../../../plans/2026-09-08-runtime-evolution-ard.md) — 用户拍板「版本影响不大，用新的」：新 runtime 保持 0.84.4，不回退对齐，版本差异在 P2-6 记为已知偏差 |
| Q6 P1-0 非 pipe stdio 范围 | 用户确认先交付 pipe + adapter 挂载点；不自动重跑命令，真实载体验收仍在 P1-8/P4-6，见 [契约](topics/p1-0-host-contracts.md) |
