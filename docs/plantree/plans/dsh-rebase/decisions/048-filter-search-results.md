# 决策 048：拒绝清单对 glob / grep 的结果也生效，用 post-execute 过滤

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-6 方案 §5 D10](../topics/p1-6-permissions.md#5-需要拍板的决策点)。

## 规则

1. DSH 的 glob 连隐藏文件和被忽略的文件一起列出（`--no-ignore --hidden`）。grep 按 ripgrep 的默认规则搜，仍可能读出 `*.pem`、`*.key`、`id_rsa` 的内容。
2. 我方在 `tools/post-execute` 里过滤结构化结果，把命中拒绝清单的路径与内容去掉，再重新渲染。这个监听必须排在 fs-search 下游，被过滤掉的内容才不会进 spill 文件。
3. 用例钉住挂载顺序。

## 取舍

- 不选「不做，相关用例判 N/A」：那样 glob 能列出 `.env`，grep 能读出私钥内容，比 1.0.x 倒退。
- 代价：依赖行的挂载顺序（推断），要用用例钉住。
- 开工前要先做小实验：确认 post-execute 排在 fs-search 下游。

## 补记（2026-09-27）

第 2 条的挂载顺序经实测不成立，由[决策 078](078-search-filter-prepend-post-execute.md)（待审批）修订：改为 prepend，过滤到内容时直接返回。
