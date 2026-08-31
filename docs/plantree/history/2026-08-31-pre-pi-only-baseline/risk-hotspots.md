# Risk Hotspots

| 风险 | 现状与缓解 | 清零路径 |
|---|---|---|
| **加密机 / TSD** | 白名单「按进程名」口径是用户转述、未实证；Host 读密文会显性报 `encrypted_unreadable`（非静默空） | T-11 现场六项（含白名单⑥：任意路径 node.exe 读 TSD、随包 node）→ CP5 转正式 Go |
| **CC JSONL 格式漂移** | 历史格式属 CC 内部实现 | Cometix pin `2.1.212`（SHA256 校验）；historyReader 宽容解析（未知行跳过分账不崩）；崩溃兜底=ARD 后置「历史快照」 |
| **网关瞬态** | 双端点同时刻齐挂实测过；偶发「400 thinking 格式无效」（重跑即过） | C-14 看门狗显性 failed；备用网关 `api.vllmproxy.com`（执行计划 §4）；GUI 复现按 session.failed 处理，不回滚 thinking 默认开 |
| **SDK 未文档化不变量** | Question 自由文本 response 注入依赖「SDK 不对 updatedInput 二次校验」；bare allow 被 cli.js 静默作废重问 | cli.js 已 pin；网关 smoke response 场景即回归钉子；Host/index 双层校验拒空响应 |
| **打包体积** | portable 141MB（随包 node +21MB） | 可接受性待用户确认（open question）；不可接受则回退五源寻径为主 |
| **共树并发**（已消除） | 曾双向提交对撞（474ad21） | 2026-07-24 双轨合一、工作树独占；若恢复并行先恢复 pathspec + 避让纪律 |
