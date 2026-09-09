# Windows-P4-6 验收证据归档

> **校准说明（test.11 交付后）**：本文件的原始测试结果是在远端 `a6ebf5fc`（修复 B1/M1/M2/M3）**之前**的 `f677f705` 基线上执行的，故保留为"修复前基线"。远端 `76424efa`/`b6aa0844`(test.11) 已修复所列 B1/M1/M2/M3，并经 CI `34308304362` 双载体 native/legacy 冒烟证实。对照分析见 `linux-side-punch-list.md`。

生成时间: 2026-09-09 11:59:16
分支: feat/runtime-evolution  HEAD: f677f70546b06b1d2184f1c877fb5d83dc99aaf8
来源提交: f677f70546b06b1d2184f1c877fb5d83dc99aaf8 docs(runtime): 同步 P4-6 接棒状态与 Windows 验收分工

## 环境
- OS: Windows 11 Pro 10.0.26100 (24H2), AMD64, Gigabyte Z790 UD
- RAM: 约 31.8 GB; 磁盘: C 空闲0 大致估算
- Node: v24.18.0; npm: 11.18.0; pnpm(corepack): 10.26.2
- Git: git version 2.45.2.windows.1; PowerShell: 5.1.26100.9168
- 企业加密驱动: TsdEncrypt.sys / TsdEncryptMF.sys (Running); Ocular3Path(TEC OCular) 存在

## 已安装 AiClient
- 安装路径: D:\Program Files\AiClient
- 版本: 1.0.0-test.9 (来自主工作分支, CI run 34207032908)
- 随包 node.exe: D:\Program Files\AiClient\resources\node-runtime\node.exe (v24.18.0)
- 注意: 此包为旧测试包, 不含 native runtime 源码, 不能代替 P4-6 测试包
- 未发现 resources/git/bin/bash.exe (包内无 bash 载体)

## typecheck
- typecheck:runtime -> 通过 (exit 0)
- typecheck:agent-host -> 通过 (exit 0)

## 测试
- scripts/__tests__/agent-host-build-lib.test.mjs: 19 通过 / 1 失败
    失败项: accepts a worker-only Pi artifact (missing runtime-helpers/exec-runner.mjs + tsd-read.mjs)
    判定: 测试样本缺文件, 非真实安装包缺陷 (build-agent-host.mjs 会复制)
- host.test.ts + workerCarrier.test.ts + hostBoundary.test.ts: 24 通过
    含: retains a runner leader and cleans descendants; rejects ciphertext without fallback
- session/sessionCodec/sessionNavigation/sessionLegacy/runtimeEvents: 49 通过
- tools.test.ts: 33 通过 / 3 失败 (spawn /bin/bash ENOENT, Windows 平台排除)
- shellPolicy.test.ts: 部分失败 (spawn /bin/bash ENOENT, Windows 平台排除)
- nativeWorkerRuntime.test.ts: 13 通过 / 1 失败 (路径分隔符差异)
- workerEndToEnd.test.ts (单独跑): 11 通过 (P4-4 端到端)
- guiEventContract.test.ts: 5 通过 / 1 失败 (路径分隔符差异: <workspace>/ vs <workspace>\)
- newContext.test.ts: 5 通过
- contextBudget/contextCompaction/prefixStability/promptSegments/promptService/contracts/bootstrap/agentLoop/catalog: 9 文件通过
- projectInstructions.test.ts: 失败 (ROOT 路径在 Windows 下 resolve 引入盘符, 平台相关)

## 冒烟
- smoke:runtime (offline): PASS (6 项断言, p0_single_turn)
- smoke:runtime-tools (standalone): PASS (read/edit/bash/glob/grep/trace 全 true)
    node=C:\nvm4w\nodejs\node.exe v24.18.0, carrier=standalone-node, git_commit=f677f705
    注意: 系统 PATH node, 非随包 node
