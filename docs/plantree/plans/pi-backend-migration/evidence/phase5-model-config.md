# Phase 5 模型配置链路 — 落地与验证证据

**日期**：2026-08-28

## 落地范围

| 任务 | 证据 |
|---|---|
| T19 Pi 模型目录 | `AgentCatalogService` 对 Pi 独立分支；`PiModelConfigService.readCatalog()` 读取本地/受管 `models.json`，输出 `provider/model`；绕过 vault 网关请求与 Claude/Codex 家族过滤 |
| T20 选择闭环 | `PiAgentRuntime.applySelectedModel()` 解析 `provider/model`，调用 `modelRuntime.getModel()` + `session.setModel(..., {persist:false})`，create 默认和 send override 均接通 |
| T21 隔离 agentDir/key | `~/.pilab/<profile>/pi-agent/{models.json,auth.json}`；models 不含 key，auth 按 provider 写入并设 0600；Pi utilityProcess 注入 `PI_CODING_AGENT_DIR`；vault 新增可选 `pi` arm |
| T22 管理页同步 | `pnpm model-admin` 提供本地管理页与 GET/PUT API；客户端启动/登录/手动同步，远端失败走现有缓存，再无缓存走默认配置 |
| T23 / Q8 | D10：登录模式 agent PTY 注入 `PI_CODING_AGENT_DIR`，普通 terminal/local 模式不注入；登出清受管 auth.json |

## 自动验证

```text
pnpm typecheck
pnpm typecheck:agent-host
pnpm vitest run <7 个 Phase 5 scoped suites>
```

Phase 5 scoped suites初轮 **7 files / 96 tests** 全绿；加入启动 TTL 后相关增量 **3 files / 21 tests** 全绿。最终完整仓库以单 worker 低内存执行，**251 files / 5053 tests** 全绿，覆盖：

- 远端同步、key 分离、0600、stale-cache、seed fallback、本地 models.json；
- Pi catalog 不读 Claude/Codex vault、不发网关请求；
- Pi IPC wire name、family filter bypass、跨 agent ownership；
- GUI catalog 对 local/managed source 的 TTL；
- TUI agent PTY `PI_CODING_AGENT_DIR` 注入且普通 terminal 不注入；
- create 默认 model、send override、非法/不存在 model 的显性失败。

Pi SDK 实际 `ModelRuntime.create({modelsPath, authPath})` 探针通过：`pilab/company-model` 可枚举，`getProviderAuthStatus('pilab') = {configured:true, source:'stored'}`，`getAvailable('pilab')` 返回该模型。

管理端实跑：

- `/health` 与 `GET /api/v1/models-config` 200；
- 开启 token 后未授权 PUT 401、授权 PUT 200；
- 含 `apiKey` 的配置 PUT 400。

其余门禁：主仓与 agent-host typecheck 全绿；`biome check src scripts/pi-model-admin.mjs package.json`（981 files）全绿；`build:agent-host` 成功（408,711,404 B）。完整 `pnpm build` 未在 3.3 GiB VM 上重跑到底：该脚本固定 `--max-old-space-size=4096`，本轮执行触发内存压力后按用户要求停止高内存验证，交由用户真机测试。
