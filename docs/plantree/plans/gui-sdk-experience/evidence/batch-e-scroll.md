# E：底部跟随与快速输出（2026-09-09）

第 12 项追加需求：中部聊天栏原本在底部时跟随 agent，用户上翻时保留阅读位置。

## 调查与实现

沿用 MessageTimeline 原有 ResizeObserver 和底部判定，不改变消息渲染或 runtime。原实现仅观察内容，未覆盖输入区/窗口改变 viewport 高度；内容增长后、observer 回调前到达的 scroll 事件可能将跟随误判为上翻。

- 同时观察 content 与 viewport。记录上次 scrollTop，内容增长且位置未动的事件不解除跟随、不闪现跳底按钮。
- 向上 wheel 意图先解除跟随；正常手动回底与现有跳底按钮可以恢复。会话切换重新贴底，卸载清理观察器/监听器。
- 使用浏览器 ResizeObserver 在绘制前合并交付，距离底部超过 1px 才写 scrollTop，显式 scrollBehavior=auto。未添加平滑滚动动画。
- 实验中在 ResizeObserver 外再排 requestAnimationFrame，真实 Electron 测得大段输出一帧落后（最大距底部 2111px），因此最终没有采用该实现。

## 实际验证

命令：`NODE_OPTIONS=--max-old-space-size=768 node scripts/verify-timeline-follow.mjs`。
脚本从当前 MessageTimeline 提取完整滚动 hooks，配真实 ScrollArea、Tailwind 与开发 React，在 Electron 中执行（不是源码字符串断言）。测试隔离了消息内容，不能替代完整 Markdown/Monaco/安装包现场。

- 40 批 × 8 次长文本增长，40 次 scrollTop 写入，采样最大距底部 0px。
- 内容增长与排队 scroll 事件交错仍贴底；真实 mouseWheel 上翻、继续输出位置保持；跳底后恢复；viewport 收缩、切换会话、卸载通过。
- 小批 Vitest：messageTimelineScroll / messageTimelineWiring / timelineRetryInteraction 共 3 文件 65 项通过。
- 同批发现 C 改动使旧全目录行高计数、ToolGroup 完整字符串断言过期：密度检查限定原 prose/tool/skeleton 范围，sessionId 检查限定真实 ToolGroup 属性，保留已有行为测试。

## 未验收

没有执行 Windows/加密机安装包测试；Electron fixture 禁用 GPU，不能据此声称 GPU 合成或实际屏幕撕裂已消除。完整 Markdown 快速长输出、大代码块、窗口拖动/输入区增长及硬件显示需按现场清单验证。
