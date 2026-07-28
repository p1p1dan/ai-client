# Open Questions

> 只放未决问题；决了就移去台账（决策/检查点）并从这里删除。

1. **C-15 产物体积**：portable 120MB→141MB（随包 node.exe +21MB）可否接受？——等用户拍板；不可接受的回退方案=随包改可选、五源寻径为主。
2. **T-19 消息队列**：提案内容（turn 运行中排队后续消息，CC 有 `queue-operation` 机制可依托？）尚未落库——等用户提供原文后评估排期。
3. **CI 测试作业缺失**：`build.yml` 仅打包无 `pnpm test/typecheck/lint`（C-09 期间发现）。tag 触发的发布构建要不要加测试门禁？——成本（双平台时长）vs 收益待拍板。
4. **T-09 Node 缺失场景无法真触发**：resolver 容错太好，坏路径仍 fallback 成功。构造「全候选失败」的可行法？（候选想法：mock-resolver 注入容器，见 ideas）
5. **网关「400 thinking 格式无效」——2026-07-28 升级：默认模型路径上已从瞬态变确定性**。07-26 的 budgetTokens 假说已被 07-27 实测推翻（场景 A 原样发旧形态仍 200）。**07-28 探针**：`{type:'adaptive', display:'summarized'}` 打网关默认模型（opus-4-8[1m]，即 #8 当日实测 408 字符成功的同一配置）**2/2 确定性 400**——网关对 thinking 的处理跨模型不一致且随时间漂移。处理口径不变（按 session.failed 显示、不回滚 thinking 默认开），**定位与修复在网关侧**（newapi 渠道配置），app 侧无可修。
8. **sonnet 空文本 thinking 块要不要渲染指示**（2026-07-28）：GUI 默认 `sonnet`（claude-sonnet-5）在本网关返回**带签名但文本为空**的 thinking 块（不理会 `display:'summarized'`），Host 按设计吞空 thinking → 无卡。CLI 历史 JSONL 可证上游确实思考了。要不要给这种块渲染一个无文本的「已思考」指示？——产品决策，等用户拍板；根治仍在网关侧。**T-04 在网关修复前无法点验**（连同 #5）。
9. **OpenChamber 壳无添加仓库 UI**（2026-07-28）：`SKIP_ONBOARDING_GATE=true` 硬强制新壳且旧壳不可达（Appearance 开关被覆盖），而 AddRepositoryDialog 的全部入口都在旧壳分支、LeftNav 的 Workspace 按钮 disabled——新机器唯一注册通路是 `--open-path` argv / `aiclient://` URL。要不要在新壳补添加仓库入口（或恢复开关可切回旧壳）？——T-01/T-16 范畴，等用户拍板。
6. **归档会话无 un-archive 入口**：T-02 右键即归档、无确认，`mergeSessionIndex` 把 archived 连 live 镜像一起丢弃 → 彻底不可见，只能手改索引文件恢复。用户首轮联调即误触两条。要不要补 UI 入口（或至少加确认）？——等用户拍板。
7. **TSD 白名单口径**（按进程名，任意路径 node.exe 均可读）待 T-11⑥ 现场实证——实证前所有加密机相关能力不得标注通过。
