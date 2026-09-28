# 决策 026：DSH 历史按消息投影，树跨 lineage 合并

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D1](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)、[分片 03](../topics/p1-4-bridge-parity/03-history-tree-rewind.md)。

## 规则

1. 投影单位：
   - 人类消息一条一个 `HistoryMessage`；
   - 每个 step（一次模型调用加上它的工具结果）一个 `HistoryMessage`。
2. id 取 DSH 的 `MessageId`，写作 `h:<id>`。fork 种子是原样复制事件的，所以回退、fork 前后 id 不变，渲染层现有的合并规则照样成立。
3. 投影写成纯模块 `src/shared/dshHistory/`，不依赖 DSH 包，bridge、宿主只读回放、根 vitest 共用。
4. 树的构建：
   - 节点就是投影出的消息，`parentId` 是同一个 DSH 会话链上的前一条消息。
   - 按桩里记下的 lineage（当前会话加退役会话），把各条链按 id 合并成一棵树。
   - leaf = 当前 DSH 会话的最后一条消息，加上 `<dshId>#<lastSeq>`。
5. **硬约束：bridge 不往 DSH 日志追加自定义事件类型。** DSH 读盘遇到未知、又没标 `ignorable` 的事件会拒绝打开整个会话，而 `Session.append` 没有设这个标记的入口。我方要落盘的信息，只能用 DSH 已有的词汇表达（`turn/end` 的取消原因、用户消息的 `source.kind`），或者写进桩文件。

## 取舍

- 不选「只画当前会话的线性树」：兑现不了树对话框的文案「后面的消息仍保留为另一分支」。
- 代价：
  - 要读退役会话，树的构建要做缓存（退役会话不可变，按 id 缓存）；
  - 节点上限 4000。

## 补记（2026-09-27）

第 5 条的适用范围由[决策 053](053-ignorable-events-in-seeds-only.md) 修订（待审批）：运行期仍然不追加自定义事件；种子里可以带 `ignorable: true` 的 `aiclient/*` 事件，DSH 的格式迁移会把它改名为 `plugin:<名>` 保留。
