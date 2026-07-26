# Open Questions

> 只放未决问题；决了就移去台账（决策/检查点）并从这里删除。

1. **C-15 产物体积**：portable 120MB→141MB（随包 node.exe +21MB）可否接受？——等用户拍板；不可接受的回退方案=随包改可选、五源寻径为主。
2. **T-19 消息队列**：提案内容（turn 运行中排队后续消息，CC 有 `queue-operation` 机制可依托？）尚未落库——等用户提供原文后评估排期。
3. **CI 测试作业缺失**：`build.yml` 仅打包无 `pnpm test/typecheck/lint`（C-09 期间发现）。tag 触发的发布构建要不要加测试门禁？——成本（双平台时长）vs 收益待拍板。
4. **T-09 Node 缺失场景无法真触发**：resolver 容错太好，坏路径仍 fallback 成功。构造「全候选失败」的可行法？（候选想法：mock-resolver 注入容器，见 ideas）
5. **网关瞬态「400 thinking 格式无效」——根因已定位，待修复验证**：2026-07-26 查证官方文档，`thinking: {type:'enabled', budgetTokens:N}` 在 Opus 4.8/4.7、Sonnet 5、Fable 5 上**已移除，发送即 400**（仅 Opus 4.6/Sonnet 4.6 尚可用且已废弃），而 `claudeRuntime.ts:393` 正是这个形态、会话 model=opus。原「按 session.failed 显示、不回滚 thinking 默认开」的处理口径不变，但本项不再是「观察项」而是**待修工单 #8**（改 `{type:'adaptive'}` + `output_config.effort`）。修完复验无 400 即可结项。
6. **归档会话无 un-archive 入口**：T-02 右键即归档、无确认，`mergeSessionIndex` 把 archived 连 live 镜像一起丢弃 → 彻底不可见，只能手改索引文件恢复。用户首轮联调即误触两条。要不要补 UI 入口（或至少加确认）？——等用户拍板。
7. **`searchContent` 反斜杠**：`SearchService.ts:246/295` 与已修的 `searchFiles` 同款问题，但消费链（搜索结果面板）未验证，未做静默半修。要不要一并归一化？
8. **TSD 白名单口径**（按进程名，任意路径 node.exe 均可读）待 T-11⑥ 现场实证——实证前所有加密机相关能力不得标注通过。
