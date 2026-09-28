# 决策 012：三个平台的 DSH 宿主都跑在随包 node 上（偏离 ARD D11 载体表）

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-2 方案 §4 D2](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、ARD D11（`docs/plans/2026-09-08-runtime-evolution-ard.md:233-234`：`bundled-node` 只用于 Windows 安装版，其余平台与开发模式用 `electron-utility`）。

## 规则

1. Windows、Linux、macOS 的打包态，以及开发态，DSH 宿主一律由随包 node 拉起：打包态是 `resources/node-runtime/node(.exe)`，开发态是 `out-node-runtime/node`。当前版本钉在 24.18.0。
2. 不用 Electron 充当 node，也不用 `utilityProcess`。
3. ARD D11 的载体表在 P1-14 回写。在那之前，DSH 宿主的载体以本决策为准。

## 取舍

- P0 的全部证据都是在随包 node v24.18.0 上取得的。`dsh-app-boot` 通过原生 addon 修改 Node 内部加载器，这在 Electron 里没验证过。
- 随包 node 本来就进了三个平台的安装包：pi TUI 在打包态三个平台都用它。
- ARD D11 的初衷（按进程身份选载体，加密机只放行随包 `node.exe`）没有变。只是把 Windows 的做法扩到了其他平台。
- 不选 Electron 充当 node：官方 DSH Desktop 是这么做的，但我方没有验证过。
- 代价：与 ARD 的文字暂时不一致，必须在 P1-14 回写。

## 影响

- P1-1（决策 009 的入口解析）、P1-2 打包、P1-14 回写 ARD。
