# 决策 046：pwsh 命令用自写的保守词法分析，看不懂的一律当「解析不出」

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-6 方案 §5 D7](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[分片 03 §11](../topics/p1-6-permissions/03-design.md)。

## 规则

1. 新增 `src/shared/permissions/pwshAnalysis.ts`：
   - 别名与大小写归一；
   - 登记路径参数和重定向；
   - 看不懂的一律算「解析不出」。
2. 结果：auto 档遇到解析不出的操作照问；bypass 放行。策略面沿用 `bash`。
3. 用约 150 条 pwsh 命令做表驱动用例，进 Windows CI 的两路（管理员、标准用户）。推送前需用户确认。
4. 以后可以换成 tree-sitter-powershell 提升精度。

## 取舍

- 不选「PowerShell 自带的 AST」：要常驻一个 helper 进程。
- 自写分析零新进程、零新依赖，看不懂就问，失败关闭。
- 代价：auto 档下，Windows 用户会比 Linux 用户多弹卡。runtime-hardening 决策 023 那类「太常问」的反馈有可能重现；bypass 档不受影响。
