# Implementation Status — Pi Backend Migration

**Last Verified**：2026-08-28 · 完整 vitest **251 files / 5053 tests** 全绿；typecheck（主仓 + agent-host）全绿；Biome `src` 981 files 全绿；`build:agent-host` 成功；管理端 GET/PUT/token/拒绝凭据字段与 Pi SDK models/auth 探针实跑通过。完整 Electron build 因当前 VM 仅 3.3 GiB、脚本固定 4 GiB heap 出现内存压力，按用户要求不再重跑高内存门禁。

## Current Phase

**Phase 1 与 Phase 5 已完成。**

- Phase 5：T19~T23 全 Done；证据见 [evidence/phase5-model-config.md](./evidence/phase5-model-config.md)。
- Q8 已由 [D10](./decisions/010-tui-managed-pi-config.md) 关闭：登录模式 TUI 使用公司 Pi 配置。
- 下一阶段回到 Phase 2：Extension UI + 权限审批。

## Last Landed

**2026-08-28 Phase 5 已随本提交落地**；主要实现文件：

- `src/main/services/piModelConfig/` + `src/main/ipc/piModels.ts`
- `scripts/pi-model-admin.mjs` + `model-admin/`
- `src/agent-host/piRuntime.ts`
- `src/main/services/agent-host/AgentHostManager.ts`
- `src/main/services/session/SessionManager.ts`
- `src/renderer/components/settings/PiModelManagementSettings.tsx`

## Active TODO

1. T07 — Extension UI contracts。
2. T11 — utilityProcess ↔ Main ↔ preload ↔ renderer bridge。
3. T08/T08-a/T08-b — UI 原语、权限插件随包、审批闭环。
4. Q9 拍板后施工 T08-c 默认权限策略。

## Blocked By

Phase 5 无阻塞。Phase 2 的 T08-c 仍被 Q9 阻塞，其余前置可施工。

## Handoff

- 本地管理端：`pnpm model-admin`，默认 `127.0.0.1:3210`。
- 客户端部署 URL：设置页 **Pi Models** 修改，或用 `PILAB_MODEL_CONFIG_URL`。
- 管理模式目录：`~/.pilab/<profile>/pi-agent`；本机模式继续读用户自己的 Pi 目录。
- 管理页只承载元数据；任何 `apiKey` / `key` / `token` 字段都会被服务端和客户端双重拒绝。
