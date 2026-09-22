# Chat 内容显示优化 · 当前实施规格

> 以本次会话用户最新确认的三点为准。旧原型 `chat-optimization-prototype.html` 中的绿色边条、底色和最终回复装饰已取消，不作为当前视觉验收依据。
> 实施与验证记录见 `chat-optimization-handoff.md`。

## 需求

1. 区分最终回复与中间说明文本。
2. 移除“已处理 N 个步骤”头部，显示具体文字 chips：`思考 · N 次工具调用 · N 段说明`；不存在的类别省略。
3. 中间说明降亮并折叠进过程区，不用斜体。

最终回复保持现有普通 answer 的样式、颜色、背景、边框与间距。只使用现有 `text-muted-foreground` 降低中间说明亮度，不改全局主题，不新增最终回复的颜色强调或装饰。

## 分组规则

在 turn 级的 `splitTurnWorkGroup` 中找最后一个 answer 段，输出独立 `finalAnswer` section。其余 answer 段与相邻 process 段归入 `processGroup`。

示例：

```text
process → 中间说明 → process → 最终回复

[processGroup: process + 中间说明 + process] → [finalAnswer: 普通正文]
```

- 不改变 `turnItemPlacement` 的逐项分类。
- 有 answer 时 notice 保持原序，始终在过程组之外。
- 无 answer 时保留原有排序：process 合为一组，notice 在后独立显示。
- 最终回复后出现的 process 独立成组；后续 answer 到达时，先前最后 answer 归入中间说明。
- `groupKey` 使用首 item 身份，保留已存在过程组的用户开合选择。

## 渲染与计数

- `finalAnswer` 走普通 `renderSegment`；不增加专用装饰包装。
- 组内 answer 通过 `renderSegment(segment, true)` 使用 `turnIntermediateToneClass()`。
- 思考统计 `toolGroup.entries` 中的 thinking 条目；有思考时显示“思考”，不显示次数。
- 工具调用数复用 `countTurnToolCalls`。
- 说明数按过程组中的 text item 统计。
- 头部通过 `useI18n()` 使用现有翻译机制，中文 chips 的 key 与运行状态“思考中”区分。
- 保留原折叠阈值：多于一步时显示折叠头；单步原位显示。
- 保留受控 `<details>` 开合、未决授权强制展开、二级工具/思考展开状态。

## 范围与验证

涉及 `turnProcessFold.ts`、`MessageTimeline.tsx`、`chatTimelineLayout.ts`、共享翻译目录及相关测试。不修改事件流、projector、session store、`App.tsx` 或主题定义；Q2（Automatic 选项）、Q3（/compact）另行处理。

测试覆盖分组、notice、授权、chips 计数/目录、普通最终回复与中间说明的样式，以及原有折叠连接。按资源约束小批串行运行，并复查 typecheck、定向 Biome。最后需要开发版 Electron 实际会话验证；测试通过不等于界面已验收。
