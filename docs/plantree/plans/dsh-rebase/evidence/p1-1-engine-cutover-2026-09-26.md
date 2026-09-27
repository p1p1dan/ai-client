# P1-1 引擎直替：实现与验证（2026-09-26，Linux 开发机）

Role: evidence。对应 [roadmap P1-1](../roadmap.md)，按[方案](../topics/p1-1-engine-cutover.md)与决策 005～010 施工。代码提交 `100ebcf1`（40 个文件，+2726 / −506）。无界面回归原始输出（已去掉本机路径与 stderr）：[p1-1-engine-cutover-2026-09-26.bridge-smoke.json](p1-1-engine-cutover-2026-09-26.bridge-smoke.json)。GUI 点验另见 `p1-1-gui-2026-09-26.md`（进行中）。

## 落地内容

- **拉起**：`DshHostProcess.ts` 取代 `devDshEngine.ts`。
  - 聊天会话不论是否打包都只拉 DSH 宿主。
  - 缺随包 node 或宿主入口时报 `DSH_HOST_MISSING`，不回退到 PATH 上的 node。`AICLIENT_DSH_NODE` 覆盖的路径也必须真实存在。
  - 打包态的布局常量是 `resources/node-runtime/node(.exe)` + `resources/dsh-host/host.js`，等 P1-2 交付产物。
  - `DSH_HOME` 为 `~/.pilab/<profile>/dsh-home`。
- **身份与索引**：
  - `AGENT_WIRE_NAMES = ['pi', 'dsh']`，`sessionAgent()` 缺省为 `dsh`。新建、恢复、fork 一律写 `dsh`。
  - `commitResumed` 的 agent 改为必填；`commitPiLeaf` 接受 pi 和 dsh 两种。
- **旧 pi 会话只读**（决策 005）：
  - Main 在任何副作用之前抛 `legacy_session_readonly`，渲染层显示「迁移前只能查看」卡片。
  - 从未落盘的 pi 空行会修复成 DSH 会话：先用 `recordCreated` 把行改写成 `dsh`，再新建。
- **bridge**：
  - 新建：`agents.create` → `sessions.flush` → 原子写桩（临时文件、fsync、rename）。
  - 恢复：先校验 cwd，再返回空页 `initialHistory`。
  - 错误映射：`dsh_session_missing`、`session_locked`、`session_cwd_mismatch`、`session_invalid`。
  - 安全拒绝：重试报 `WORKER_RETRY_UNAVAILABLE`，附件报 `WORKER_DSH_UNSUPPORTED`。fork 仍报不支持。
- **TUI**：`.dsh.json` 身份一律「不支持」，pi 终端打不开 DSH 会话。
- **守卫**：新增静态测试 `chatEngineDshOnly.test`：聊天拉起不引用 native fork、`AICLIENT_DEV_ENGINE`、`isPackaged` 门控。

## 与方案的偏离（实现时按代码事实调整）

1. 渲染层不预先拦截 pi 行，恢复请求交给 Main 判定。原因：只有 Main 能 stat 文件，区分得出「从未落盘的 pi 行」（该修复）和「真实的旧会话」（该只读）。
2. 新建时遇到 `SessionAlreadyExistsError`，改为重开同 id 的日志，校验 header 里的 cwd 后补写桩。原因：DSH 会话 id 是确定的，先前某次新建只要半途失败，以后每次重试都会失败。已补记到[决策 007](../decisions/007-flush-dsh-session-before-stub.md)。
3. 额外的错误映射：桩文件缺失报 `dsh_session_missing`；桩损坏报 `session_invalid`，渲染层落到「会话已损坏」卡片。已补记到[决策 006](../decisions/006-session-identity-stub-file.md)。
4. P0-6 探针 `shared-bridge.js` 同步改了构造参数（inject `sessions`、`createUserMessage`），否则运行时会坏。

## 验证（均在 worktree，HEAD 为提交前的工作区，内容与 `100ebcf1` 相同）

实现代理自测：四套 tsc 通过；相关单测 91 个文件、1417 例全过；bridge-smoke 18 项判定全部为真。编排器独立复跑：

| 项 | 结果 |
|---|---|
| 四套 tsc（根、agent-host、runtime、dsh-host） | 全部退出 0 |
| `src/main/services/{agent-host,chat,terminal}/`、`src/main/ipc/`、渲染层 `sessionIndex/`、`historyError`、`chatSessionActions`、`src/shared/types/__tests__/`、`src/dsh-host/bridge/__tests__/` | 65 个文件、1043 例全过 |
| 渲染层 `components/chat/`、`stores/`、`hooks/` | 165 个文件、3201 例全过 |
| `bridge-smoke.ts`（重跑） | 18 项判定全部为真 |

bridge-smoke 新增的 12 项判定回答了方案里标「推断」的点：
- 新建后、跑任何回合之前，会话就已落盘（`persistedBeforeFirstTurn`），桩的 mtime 不早于日志。
- 只有 header 的会话，在宿主被 SIGKILL 后能被另一个宿主恢复，并跑完一整个回合（`headerOnly*`）。
- 会话被别的宿主持有时，恢复报 `session_locked`，`forceTakeover` 被忽略（`lockedWhileOwned`）。
- 回合结束后被 SIGKILL，再恢复时模型能看到之前那一轮（`resumedAfterSigkill`、`recalledAfterSigkill`）。
- 同 id 重建会重开已有日志（`recreateReopenedExistingLog`）。

没跑的：全量 Vitest（批次收口时跑一次）；打包态（P1-2 的产物还不存在，按决策 009 会报 `DSH_HOST_MISSING`）。

## 遗留与后续

- `session_locked` 卡片上的「强制接管」在 DSH 下无效，点了只会显示接管失败。归 P1-3，与孤儿宿主、锁的处理一起做。
- 宿主在回合刚结束时就 dispose，DSH 的 projection-cache 会告警 `flush on a closed handle`。只是把缓存标为过期，日志完好。P1-3 / P1-4 顺手看一下。
- `mkdirSync(..., {mode: 0o700})` 只对新建的目录生效，已存在的 `dsh-home` 不会被收紧权限。归 P1-3 的环境与 home 策略。
- P0-3 的 GUI 工具还在设 `AICLIENT_DEV_ENGINE`，现在已被忽略，无害。
- 仍未验证：pi TUI 打开桩会不会写坏它（现在按文件名直接拒绝，没拿真实 pi 试）；Windows 下的路径大小写与长路径。
