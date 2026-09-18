# 批次 E 上机前打包：run 35295618831（2026-09-18）

Role: evidence。[T032](../../roadmap.md) 收口后为 [T033](../../roadmap.md) 上机产出的三平台测试安装包，同时结案 WIN 组第 19 项（打包门禁改 native-only 后的三平台绿灯）。

## 触发与结果

| 项 | 值 |
|---|---|
| 触发 | `workflow_dispatch`，HEAD `13e6cdb7`（feat/runtime-evolution） |
| 时间 | 2026-09-18T01:30Z 触发，01:55Z 完成，全部作业 success（[jobs.tsv](jobs.tsv)） |
| 前两次失败 | run 35293647441（HEAD `9cca79dd`）倒在门禁第 4 步 lint：H/21 两份探针脚本与 T032 归档的 4 个 `.mjs` 工具未过 Biome（pre-commit 只查 `.js/.ts`），修于 `69d209af`；run 35294611278（HEAD `9250d209`）门禁七步全过，三平台倒在「Smoke the packaged permission gate」：脚本 `t08a-permission-plugin-smoke.ts` 已随旧引擎在 `fe246bd6` 删除而工作流未删，修于 `13e6cdb7`。另 `aabe37e2` 先把 `sessionWriterLock` 两条吃真实开机时长的用例改成可控值，否则门禁第 5 步在 CI 机上必红 |
| 产物 | [artifacts.tsv](artifacts.tsv)：`windows-installer` 179 MB、`windows-portable` 178 MB、`windows-unpacked`、`linux-packages`、macOS 两份 unsigned、两份 remote-runtime、`app-build`，三份 `worker-smoke-*`；到期 2026-09-25 |
| 本地留档 | `/home/ai/t033-artifacts/`：本版 installer + portable、上一版（run 34424337205，`c0ae2a34`，2026-09-24 到期）installer，含 SHA256SUMS |

## WIN-19：三平台「Verify packaged Pi worker」（判据：步骤成功，stamp.backend=native、carrier=bundled-node、权限审计行存在）

| 平台 | ok / exit | backend | carrier | config_version | node | exec_adapter | 权限审计行 | 文件 |
|---|---|---|---|---|---|---|---|---|
| Windows | true / 0 | native | **bundled-node**（`resources\node-runtime\node.exe`） | runtime_p6_hardening_v1 | v24.18.0 | node-runner-pipe-v1 | read / bash 各一条 `policy_allow` | [worker-smoke-win.json](worker-smoke-win.json) |
| Linux | true / 0 | native | electron-utility | runtime_p6_hardening_v1 | v22.21.1 | node-direct-pipe-v1 | 同上 | [worker-smoke-linux.json](worker-smoke-linux.json) |
| macOS | true / 0 | native | electron-utility | runtime_p6_hardening_v1 | v22.21.1 | node-direct-pipe-v1 | 同上 | [worker-smoke-mac.json](worker-smoke-mac.json) |

结论：**WIN-19 ✅**。`carrier=bundled-node` 只在 Windows 成立（非 Windows 打包态走 Electron utilityProcess，与 PKG 组第 10 / 15 项和 `docs/plans/2026-09-09-bash-carrier-decision.md` 的载体规则一致）；三份 `failures` 均为空；`tsd_read_fallback=disabled` 是 CI 机无 TSD 的预期值，ENC-16 上机时应为 `configured-node` 路线的相应值。

## 未覆盖

CI 只证明打包 worker 能起、两条工具能过权限审计；安装包在加密机上的行为（ENC-16 白名单、TSD 读写、bundled-node 载体下的 R2/R3）仍是 T033 的内容。
