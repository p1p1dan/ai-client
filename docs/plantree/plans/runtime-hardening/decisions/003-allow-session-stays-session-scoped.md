# 决策 003：「本次会话允许」授权保持会话级，不按委派归属收敛

日期：2026-09-14。状态：已采纳（用户拍板，回答 Q003）。

## 决定

`grantKey` 保持 `[tool, path, command, paths]`，不加 delegationId / agentName。子代理触发的 allow-session 对父代理与其他子代理同样生效（cross-05 记为产品取舍）。

## 理由

- 用户批准的是「这个路径 / 命令可以执行」，不是「这个代理可以执行」；父代理做同一件事再弹卡只增加摩擦，安全增量小。
- 按钮文案「Allow for session」字面即会话级，实现与承诺一致；反驳者也据此把 cross-05 降为 low。
- 钥匙带完整 path / command，不会泛化到别的路径。
- 收敛需改 grantKey、activity 审计行、卡片文案，并处理「父先批、子再申请」的反向语义，T002 范围明显扩大。

## 影响

- T002 范围：只做 mcp / skill surface 映射与删 `ls` 规则；顺手在审批卡上注明「对本会话内所有代理生效」（文案改动，非语义改动）。
- roadmap Deferred 中「按委派归属收敛」一行改为已决不做；Q003 从 open-questions 移除。
