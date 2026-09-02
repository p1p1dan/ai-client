# T35 Pi-only absence audit evidence

**日期**：2026-09-02  
**分支**：`feat/pi-primary-backend`  
**最终实现提交**：`8aafd450`

## 结论

T35 的 Pi-only absence gate 已关闭。活动 conversation、one-shot、terminal、onboarding、settings、IPC/preload、remote runtime 与打包路径不再保留 Claude/Codex execution runtime、multi-agent picker、legacy permission posture、Claude product integration 或 transition facade。

保留的 Claude/Codex 名称只属于下列明确边界：

1. `src/main/services/legacyImport/` 的 Claude 只读 source scanner/adapter；
2. `src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence；
3. legacy credential adoption/logout cleanup 与 persisted settings/profile 的单向兼容读取；
4. Pi provider/model protocol metadata，以及历史事件/导入记录的显示兼容；
5. build gate 中用于证明 obsolete payload 不得进入产物的禁用依赖名称。

这些保留项不能启动旧 runtime，且不构成 renderer 可选 backend、Main execution path 或 artifact entry。

## 已删除或收窄

### Runtime / contracts

- 删除 `SessionPermissionPreference`、`SessionPermissionPolicy`、`session.permissionUpdated`、`session.settingsEcho` 及 SessionIndex permission persistence/update path。
- Context surface 不再投影 Claude/Codex permission facts、settings echo 或 host permission-policy capability。
- 删除 agent status/ask/pre-tool notification IPC、preload listeners、renderer store 与 `StatusLine`。
- Host status capability 收窄到当前 Pi 能力；保留的 persisted agent binding 只接受显式 `pi`，缺失/unknown row 不进入 live execution。

### Product / auth / settings

- 删除 Claude runtime/config/version modules、managed-mode facade、Claude home writer/onboarding mutation和相应死测试。
- local credential entry 不再探测 `~/.claude` / `~/.codex` 是否“健康”；Pi 在实际 runtime/model resolution 时解析本机 provider 配置。
- settings 将 ClaudeCode integration 重命名为 generic terminal input；migration 仅单向读取并删除旧 key。
- onboarding、runtime failure、idle prompt、terminal glow 等活动产品文案改为 Pi/generic wording。
- 删除 orphan plugin DTO、legacy session trust/spawn/Codex env tests 与旧 bootstrap package。

### Remote / packaging / scripts

- remote helper ABI 重命名为 remote runtime/server；删除 duplicate helper preload methods、IPC aliases、status aliases 与 persisted write path，只保留旧 profile 字段的单向读取。
- `RemoteHelperSource.ts` 重命名为 `RemoteServerSource.ts`；remote source 无 legacy agent/plugin CLI method。
- 删除 cloudflared packaging residue、Claude-specific dev config generation、obsolete test-config script与bootstrap artifacts。
- Main 仍不导入 Pi SDK；Pi SDK 只在 agent-host worker 侧。

## Protected assets

静态门禁继续保护：

- `src/main/services/legacyImport/ClaudeSessionScanner.ts`
- `src/main/services/legacyImport/ClaudeSourceAdapter.ts`
- `src/agent-host/codexHistoryReader.ts`
- `src/agent-host/codexItemMapper.ts`
- legacy import fixtures/evidence

上述 reader 无 `claudeRuntime`、`codexRuntime`、`codexConnection`、`codexNodeEntry` 或 `cometix` execution import。

## 验证

在低资源主机上按单 worker 串行验证：

- `pnpm typecheck`：通过。
- `pnpm typecheck:agent-host`：通过。
- focused serial Vitest：19 files / 551 tests 通过，覆盖 T31/T35 absence、auth/onboarding/adoption、SessionIndex、agent binding、settings migration、host/context projections、product copy、permission/question display与静态 font gate。
- scoped Biome：通过；commit hook再次执行 staged Biome。
- `git diff --check`：通过。
- manifest scan：root/agent-host manifests 与 lockfile 无 `@anthropic-ai/claude-agent-sdk`、`@cometix/claude-code`、`@openai/codex` 或 cloudflared execution dependency。
- production-source scan：无 `AUTH_MANAGED_MODE`、agent status/ask/pre-tool channels、legacy permission contracts、remote helper aliases、Claude/Hapi/Happy/Cloudflared product copy。

T36 已独立验证 worker-only artifact、bundled Pi CLI `0.84.3` 与 node-pty help smoke；T35 未重复重建该 92.9 MiB artifact。完整 packaged Electron、跨平台解包与真账号 GUI smoke 继续归 T37。

## Gate status

- T35-a conversation/runtime contract cleanup：**Done**。
- T35-b dependencies/artifacts/IPC/dead tests：**Done**。
- T35-c product/settings/terminal/remote surfaces：**Done**。
- T35-d protected migration-only assets：**Done**。
- T35 overall：**Done**；下一阶段为 T37 release candidate gates。
