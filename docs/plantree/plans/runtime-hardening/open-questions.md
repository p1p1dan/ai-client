# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q009 | managed 路线一直发 `projectTrusted=false`（D-Q9 / D11 决策 4，原义「仓库不得放宽权限策略」）。T035 按决策 007 / 008 给指令文件补上信任门控后，managed 会话不再装仓库 CLAUDE.md / AGENTS.md。是接受（与项目 MCP / skills / 策略既有门控一致，防未信任仓库注入指令），还是给 managed 路线单独放开指令层？ | `src/main/services/piModelConfig/index.ts` `resolveManagedPiWorkerEnv` 固定发 0；`src/runtime/settingSources.ts` 未信任即关 project / local；决策 007 写「沿用现有未信任项目不装」但实际此前指令层无此门 | T035（已落地，`5b305fdb`）；改口只需动 Main 侧 trust 值或 settingSources 规则 |
| Q010 | 决策 008 第 3 条「随包 fail-closed 策略相当于托管策略、优先级最高」与 D-Q9 决策 4「随包 < 用户 < 项目，用户永远赢」冲突。`mergePermissionScopes` 是后者覆盖前者，随包压顶会整表删掉用户规则；真正不可覆盖的兜底是 `permissions/index.ts` 的 `pathPolicy`。是把决策 008 第 3 条收窄为「永远加载」（现状），还是引入独立的托管策略文件层？ | `src/runtime/plugins/permissions/policy.ts` 注释；`src/agent-host/permissionPolicy.mjs` | T035（已按「永远加载、仍为 base」落地）；若要压顶需新任务 |
| Q006 | legacy 缓存命中率基线无法重采后，P2-6「可对比」怎么维持？ | `compare.mjs` 仍强制要求 legacy 归档而采集脚本已删；config_version 冻结使版本戳无法分代 | T028 |
