# S-5 回归证据（2026-10-16）

Role: evidence（脱敏摘要）。上位：[S-5 记录](../topics/s5-regression.md)。本机 Windows 10，claude.exe 2.1.300（SDK 0.3.300），只用本机假网关（`src/dsh-host/tools/fake-gateway.mjs --plan claude-sdk`），探针用假 key。不含本机路径与任何凭据。

## 1 回归命令（`src/claude-sdk-host/tools/probe-suite.ts`）

| 组 | 场景 | 源码宿主 | 安装目录的宿主 |
|---|---|---|---|
| flow | text tools ask stop plan steer agent search compact history | 35/35（49 秒） | 35/35（48 秒） |
| modes | keyiso mode-manual mode-edits mode-plan mode-bypass mode-switch mode-enterplan mode-auto | 34/34（15 秒） | 34/34（16 秒） |
| refused | mode-plan-refused | 3/3 | 3/3 |
| errors | errors repoenv | 33/33 | 33/33 |
| projcfg | projcfg | 12/12 | 12/12 |
| scratch | projcfg-scratch | 9/9 | 9/9 |
| home | projcfg-home | 4/4 | 4/4 |
| **合计** | | **130/130** | **130/130** |

"安装目录的宿主"：本分支合入 S-4 后重新打的 `win-unpacked`，用随包的 node（v24.18.0）、随包的 `resources/claude-sdk-host/host.js` 与随包的 `claude.exe` 跑；CI 的 Windows 打包作业里的同一步在本机照原样跑过一遍，结果相同。

对照：合入前 S-4 会话打的旧包（早于 README 裁决 17～20）跑出 124/130，失败的 6 条全是计划模式与插件市场那几条。

## 2 录制门禁（`src/claude-sdk-host/tools/event-record.ts --check`）

| 场景 | 样本行数 | 源码宿主 | 安装目录的宿主 |
|---|---|---|---|
| text | 113 | 一致 | 一致 |
| tools | 296 | 一致 | 一致 |
| ask | 189 | 一致 | 一致 |
| plan | 193 | 一致 | 一致 |

连录两遍逐字节相同；临时去掉宿主事件里的 `model` 字段时报 `DIFF text`。

## 3 打包核验（`scripts/verify-packaged-app.mjs`）

- 通过：第三方声明、无旧 worker、DSH 宿主产物（85.2 MiB、9769 个文件）、SDK 宿主产物（262.2 MiB、19 个文件，其中 CLI 258.3 MiB）、DSH 冒烟、SDK 冒烟（8 条）。
- 安装后增量即 SDK 宿主产物 262.2 MiB，低于 0.6 GB 门槛。

## 4 安装目录的界面点验（README §11.2 #43）

- 同一个 `win-unpacked`，隔离 profile（临时 home），用本机已登录账号的凭据副本过登录页，副本用完连同临时 home 删掉。
- [GUI 清单](../topics/gui-checklist.md) 9 项全过，细节见清单 §2.1。
- 假网关收到 15 个请求：13 个 SDK 回合、1 个自动模式的安全检查、1 个 DSH 回合；SDK 回合的 User-Agent 带 `client-app/pilab/1.1.1-test.1`。日志里没有 key 原文。
- 退出应用后 2 秒内宿主与 CLI 进程全部退出。

## 5 未覆盖

- 真实网关上的 T1 复跑与自动模式回合（README §9.2 #32）：待用户。
- Linux：CI 的 Linux 打包作业第一次推送后才跑（README §11.2 #44）；录制门禁在 Linux 上先只报告。
- 加密机上的正式安装包：S-6。
