# 决策 017：打包冒烟要跑到工具回合（L1）

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-2 方案 §4 D7](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、[分片 05 §2](../topics/p1-2-host-packaging/05-changes-and-verification.md)。

## 规则

1. 新建 `scripts/packaged-dsh-host-smoke.mjs`。用安装包里的随包 node 拉起 `resources/dsh-host/host.js`，先过 L0：起到 ready、组合审计通过、停止后退出码为 0。
2. 再过 L1：经 bridge 建一个会话，用本地假网关跑 read、grep、shell 三种工具回合（Windows 上的 shell 是 pwsh）。
3. 同时检查模块加载路径不越出 `resources/dsh-host/`（[决策 013](013-clean-install-and-deletion-pruning.md) 第 6 条）。
4. Windows CI 要在带空格的安装目录里再跑一次。真实安装目录 `Programs\PiLab Ai` 带空格，CI 的 `win-unpacked` 没有。
5. P1-2 的退出判据「三平台安装包里能起 DSH 宿主」，以三个打包 job 的 L1 全部通过为准。

## 取舍

- 打包最容易坏的是「用到才加载」的原生件：rg、pty / conpty、koffi、沙箱启动器。只起到 ready 碰不到它们。现有 native worker 的冒烟也跑 read + bash。
- 代价：约 300 行跨平台脚本；P1-3 改共享宿主、P1-5 改路由时要跟着改。
