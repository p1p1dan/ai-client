# 决策 053：只在种子里写 `ignorable` 的 `aiclient/*` 事件，运行期仍然禁止（修订决策 026 第 5 条的适用范围，请重点审批）

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-9 方案 §5 D4](../topics/p1-9-migration.md#5-需要拍板的决策点)、[决策 026](026-history-per-message-tree-across-lineage.md) 第 5 条、[分片 03](../topics/p1-9-migration/03-dsh-facts.md)。

## 规则

1. 运行期：bridge 仍然不往 DSH 日志追加自定义事件。决策 026 第 5 条对运行期的结论不变，因为 `Session.append` 设不了 `ignorable`。
2. 种子里可以带 `ignorable: true` 的 `aiclient/*` 事件，用来承载只供展示或留档的数据：
   - 导入会话的展示行与来源说明；
   - 委派记录；
   - 标签；
   - 其他 custom 条目。

   授权记忆照[决策 043](043-grants-sidecar-next-to-stub.md) 放 sidecar，不走这条路。
3. 投影要同时认 `aiclient/*` 和 `plugin:aiclient/*` 两种前缀：DSH 自己的 v3→v4 格式迁移，会把这类事件改名为 `plugin:<名>` 原样保留。
4. **前提是实验 E2 通过**：ignorable 事件经过落盘、冷读、fork 后都还在。不通过就退到备选 B（写 sidecar）。

## 取舍

- 这是 DSH 为下游插件事件设计的正规机制：内存校验、读盘校验、格式迁移都会保留它。事件天然按位置排序，fork 时会一起带走。
- 不选 B「另写 sidecar」：要自己处理 fork 和 GC。
- 不选 C「丢弃」：导入会话的工具行会全部消失。
- 代价：依赖以后的 DSH 版本继续保留这类事件，靠钉版本和金样本兜住。
