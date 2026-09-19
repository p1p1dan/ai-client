# 决策 027：审批行不做审计留痕——用户手点允许与硬编码 deny 均维持现状

日期：2026-09-19 · 拍板人：用户 · 状态：已决 · 任务：无（不做）

## 问题

2026-09-19 MODEL 组开发机点验（[batch-h-devbox-pointcheck-2026-09-19](../evidence/batch-h-devbox-pointcheck-2026-09-19/README.md)）顺带发现两处审批可见性缺口，记入 [findings.md](../evidence/batch-h-devbox-pointcheck-2026-09-19/findings.md)：

- **F3**：用户在授权卡上手点「直接允许」时，时间线不产生独立的审计行。`permissionActivityRow.ts:84-86` 的 `isQuietPermissionActivity` 只看 `result === 'allow' && !resolution.includes('error')`，不看 `resolution` 本身，于是 `user_approved` 与策略自动放行被同等吞掉；实时态唯一痕迹是工具行后缀「· 已允许」，重启回放后连这个后缀也没有。
- **F7**：硬编码路径 deny（`.env`、`~/.ssh/*` 等内置路径黑名单）在 `src/runtime/plugins/tools/index.ts:177-178` 的 `pathPolicy(lexical) === 'deny'` 短路里直接抛错，走不到 `runtimePermissions.authorize`，因此时间线与 store 都是零审计行，用户只能从工具调用失败的回执文本里间接得知。

两处都登记为 [Q027](../open-questions.md)，需要用户拍板是否要给这两类结果各补一条审计行。

## 决定

两处均维持现状，不加审计行。

用户原话：「权限审核不需要审计，仅用于当时是否批准对应指令，没人会回头去看」。

## 理由

用户点明审批系统的定位：审批只服务于「当时是否放行这一次调用」的即时判断，不是面向事后回溯的审计日志。既然没有回看审计记录的使用场景，补一条只在时间线上多存在、平时不会被查阅的行，对用户没有实际价值，不值得为此改动 `isQuietPermissionActivity` 的判定逻辑或在 `tools/index.ts` 的路径黑名单短路之前插入一次审批广播。

## 后果与备注

- `permissionActivityRow.ts` 的 `isQuietPermissionActivity` 保持只看 `result`、不看 `resolution` 的现状，`user_approved` 与策略自动放行继续不产生独立审计行。
- `src/runtime/plugins/tools/index.ts:177-178` 的硬编码路径 deny 短路保持在 `runtimePermissions.authorize` 之前，继续零审计行。
- MODEL-20 判据（[checklist-e.md](../checklist-e.md) 第四节）里「硬编码路径 deny 应产生一条审计行」的预期由缺陷改判为已知设计，不再作为待修项跟踪。

## 相关

- 发现记录：[evidence/batch-h-devbox-pointcheck-2026-09-19/findings.md](../evidence/batch-h-devbox-pointcheck-2026-09-19/findings.md) F3 / F7
- 已结案：[open-questions.md](../open-questions.md) Q027
