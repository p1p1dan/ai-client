# 决策 041：权限逻辑抽成 `src/shared/permissions/` 纯库，1.0.x runtime 改成薄封装

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-6 方案 §5 D1](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[分片 05](../topics/p1-6-permissions/05-changes.md)。

## 规则

1. 以下纯逻辑搬到 `src/shared/permissions/`，不依赖 DSH 包，也不依赖 runtime 的 cordis：
   - 闸门、授权、策略、路径黑名单、Windows 路径写法；
   - shell 路径复核、卡片发射、bash AST 遍历（用结构类型）。
2. `src/runtime/plugins/permissions/` 改成薄封装，委托纯库。约 115 条现有权限用例一行不改，经薄封装跑在纯库上，以此证明抽取没有变形。
3. P1-12 删 runtime 时，一并删掉薄封装，用例改为直接指向纯库。
4. 子任务 P1-6a 没有前置依赖，可以先做。

## 取舍

- 不选「复制一份到宿主，runtime 不动」：main 上的权限修复会悄悄漏掉。
- 不选「宿主直接引用 `src/runtime`」：会把我方的 cordis 拖进宿主包。
- 代价：同步 main 时，main 上改过的权限文件会冲突，要手工搬进纯库。这正好迫使修复不被漏掉。
