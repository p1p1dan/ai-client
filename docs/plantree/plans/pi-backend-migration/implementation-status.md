# Implementation Status — Pi Backend Migration

**Last Verified**：2026-08-28 · 完整 vitest **257 files / 5173 tests** 全绿；typecheck（主仓 + agent-host）全绿；Biome `src` + `scripts` 全绿；`build:agent-host` 成功（394.2MB）；权限插件对打包产物实跑加载通过（`smoke:permission-plugin`）。完整 Electron build 因当前 VM 仅 3.3 GiB、脚本固定 4 GiB heap 出现内存压力，按用户要求不再重跑高内存门禁。

## Current Phase

**Phase 1、Phase 5 与 Phase 2（除 T08-c）已完成。**

- Phase 2：T07 / T11 / T08 / T08-a / T08-b 全 Done；证据见 [evidence/phase2-extension-ui-permission.md](./evidence/phase2-extension-ui-permission.md)。
- T08-c 仍被 Q9 阻塞。当前**不带任何 policy 配置文件**，插件自身兜底是所有 surface 一律 `ask`（`rule.ts:112` `defaultAction ?? "ask"`），即 fail-closed，所以这个阻塞不影响其余功能可用。
- 下一阶段：Phase 3 GUI 时间线与气泡重构（T12 起），或用户拍板 Q9 后回头做 T08-c。

## Last Landed

**2026-08-28 Phase 2 落地**，五个提交（T07 → T11 → T08 → T08-a → T08-b）；主要实现文件：

- `src/shared/types/runtimeEvents.ts` + `src/shared/types/agentHost.ts`（契约）
- `src/agent-host/extensionUiBridge.ts`（移植自 pix）
- `src/agent-host/permissionPlugin.ts` + `src/agent-host/permissionActivity.ts`
- `src/agent-host/piRuntime.ts` + `src/agent-host/piHost.ts`（绑定与命令分发）
- `src/renderer/components/chat/ExtensionUiDialog.tsx` + `extensionUiModel.ts`
- `src/renderer/stores/extensionUi.ts`
- `scripts/agent-host-build-lib.mjs`（打包过滤特判）

## Active TODO

1. **真机端到端验收**：模型发起工具调用 → 插件拦截 → GUI 弹窗 → 用户选择 → 工具执行/拒绝。链路各段均有测试与实跑证据，但整条链首次贯通需要真实模型调用。
2. Q9 拍板后施工 T08-c 默认权限策略与设置面。
3. Phase 3：T12 时间线外壳 + 气泡视觉基线（直接取用 pi-app）。

## Blocked By

仅 T08-c 被 Q9 阻塞，且不影响其余功能可用（fail-closed 兜底见上）。

## Handoff

- **权限弹窗怎么来的**：pi 扩展调 `ui.select` → `extensionUiBridge` 转成 `extensionUi.request` 事件 → MessagePort → main → renderer 的 `useExtensionUiStore` → `ExtensionUiDialog`。用户选择经 `chat:respondExtensionUi` 原路回去。
- **关掉弹窗＝拒绝**：dismiss 只发 `ok:false` 不带 value，由 Host 侧 bridge 补开窗时记下的 fallback（confirm 是 `false`，其余是 `undefined`）。渲染端从不自己挑这个值。
- **权限插件在哪**：`src/agent-host/node_modules/@gotgenes/pi-permission-system`（pin 27.0.1），随 `build:agent-host` 进 `out-agent-host/node_modules/`。用户 `~/.pi/agent/settings.json` 里已自装同名包时不注入。
- **验证产物是否真的带上了插件**：`./out-node-runtime/node --experimental-strip-types src/agent-host/spikes/t08a-permission-plugin-smoke.ts out-agent-host`，期望 `RESULT: LOADED`。
- **改打包过滤要注意**：walker 会先问包目录本身（`parts.length === 1`），只答文件路径会导致整个包被跳过——本轮 tree-sitter-bash 就这么漏过一次，单元断言全绿、真实构建才暴露。
- 本地管理端：`pnpm model-admin`，默认 `127.0.0.1:3210`（Phase 5）。
- 管理模式目录：`~/.pilab/<profile>/pi-agent`；本机模式继续读用户自己的 Pi 目录。
