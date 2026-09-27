# 决策 018：P1-2 的 macOS 验收以 dispatch 构建的未签名 arm64 包为准

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-2 方案 §4 D8](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)。

## 规则

1. macOS 从 2026-09-23 起不在发布链里，只在 `workflow_dispatch` 时构建未签名的 arm64 包（`build.yml:420-432`）。这个包的 L1 冒烟通过，P1-2 的 macOS 部分就算完成。
2. 签名、公证、x64 包不在 P1-2 的范围内。macOS 回到发布链时另立任务。那时要核实 `resources/dsh-host` 里约 10 个 Mach-O 文件能否全部签上。

## 取舍

- 与 macOS 现在的发布状态一致，不为 P1-2 单独恢复签名链路。
- 代价：macOS 正式发布前还欠签名这一环。
