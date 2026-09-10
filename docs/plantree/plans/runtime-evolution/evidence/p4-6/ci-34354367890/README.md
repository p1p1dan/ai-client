# 1.0.0-test.12 交付与 Windows 复验入口

2026-09-09 · 源码提交：`b6dbfe65`。分支 `feat/runtime-evolution`；[手动 CI 34354367890](https://github.com/p1p1dan/ai-client/actions/runs/34354367890)。

Role: historical-delivery。下文待办描述出包时点；后续现场结果已记入[核心任务树](../../../README.md#p4)，不在交付说明重复维护。

本轮出包的目的：复验 Linux 侧刚落地的四项修复，并把两批一直没执行的探针一次跑完。

## 与 test.11 的差异

| 提交 | 内容 |
|---|---|
| `80a8b040` | F1 修复：`RemoteSettings` 四处 Field 子部件补 `<Field.Root>`。此前点设置页「网络」分类必抛 `FieldRootContext is missing`，非 Windows 特有 |
| `d2564e5d` | 旧会话 v3 resume 修复：bootstrap 新增 `sessionSourceFile`，Main 只在 worker 指名来源时接受转换重定向，并把索引身份迁到 `.native-v4.jsonl` |
| `27d4b7be` | F4 修复：native 补自有 provider 重试层（429 与 5xx/网络各一条预算、`Retry-After` 优先、内层 `maxRetries: 0`） |
| `dbead94b`（test.11 后新增） | F2 修复：临时工作区目录消失后的对话与删除；祖先关系确认 test.11 的 b6aa0844 不含此提交 |

## CI 结果

**全部 job success**，含上一轮未收尾的 macOS：
gate · build-app · build-windows · build-linux · build-macos · build-remote-runtime-linux(x64/arm64)。
`generate-release-notes` 按预期 skipped（非 tag 运行）。

Windows 打包冒烟两条 lane 均通过（[原始报告](windows/worker-smoke-report.json)）：

| lane | ok | backend stamp | carrier | transport | exitCode | 工具 |
|---|---|---|---|---|---|---|
| legacy | true | — | — | node-ipc | 0 | read, bash |
| native | true | native | bundled-node | node-ipc | 0 | read, bash |

与 test.11 同样的边界：该冒烟从仓库 Electron 启动已打包 worker，**证明 worker 产物与载体可运行，不等于真实安装应用的 Main/preload/renderer 全链路验收**。加密机现场仍未签收。

## 下载

| 用途 | Artifact |
|---|---|
| 正常安装、GUI 复验 | [windows-installer](https://github.com/p1p1dan/ai-client/actions/runs/34354367890/artifacts/10105553610) |
| 固定目录分析 worker/资源 | [windows-unpacked](https://github.com/p1p1dan/ai-client/actions/runs/34354367890/artifacts/10105583855) |
| Portable | [windows-portable](https://github.com/p1p1dan/ai-client/actions/runs/34354367890/artifacts/10105558519) |
| Windows 原始冒烟证据 | [worker-smoke-Windows](https://github.com/p1p1dan/ai-client/actions/runs/34354367890/artifacts/10105548806) |

installer / portable / smoke 保留至 2026-09-23，unpacked 至 2026-09-16，以 artifact 实际过期时间为准。

## 现场要做的事

复验四项修复、跑 P1-8 六项工具探针 × 两载体、跑 [D1 的 R0–R4 探针](../../../../../../plans/2026-09-09-bash-carrier-decision.md)（R2/R3 同时定 F3），以及企业加密机签收。
定性口径见 [GUI 缺陷决策](../../../../../../plans/2026-09-09-gui-defect-decisions.md)；未执行的项一律标「未执行」，不代签。
