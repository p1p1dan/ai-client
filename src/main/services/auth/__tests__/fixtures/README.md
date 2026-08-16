# auth 夹具

## E5 auth-probe 拒绝形状夹具（`e5-*.json`）

D47 S5 §2 —— `classifyAuthLoginResponse` 与 `UsageService`'s login/actions
接缝的 fixture 驱动测试数据源。Schema：`{request:{endpoint,authMode},
response:{status,headers,bodyText}}`。

| 文件 | 来源 | 溯源 |
|---|---|---|
| `e5-login-valid.json` | 真机实测字节（打码） | `docs/plans/2026-08-15-d47-s0-spikes/e5-cch-auth-probe.md` "Valid 臂补齐" 节：`POST /api/auth/login` 有效 key → `200` + `{"ok":true,"user":{...},"redirectTo":"/my-usage","loginType":"readonly_user"}` + `Set-Cookie: auth-token=...; Max-Age=604800; HttpOnly; SameSite=lax` |
| `e5-login-key-invalid.json` | 真机实测字节（逐字节） | 同文档「补测（真 cch 主机）」a 组：`401` + `{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}` |
| `e5-actions-401-no-cookie.json` | 真机实测字节（逐字节，另附 `warning`/`deprecation` 头，本 fixture 只保留 `warning` 供上下文） | 同文档 c 组：`POST /api/actions/my-usage/getMyTodayStats` 无效 bearer → `401` + `{"ok":false,"error":"认证无效或已过期"}`（注意 body schema 与 login 端点不同：无 `errorCode`） |
| `e5-actions-cookie-200.json` | **合成**，非逐字节实测 | E5 文档记录「带 `auth-token` cookie 重试 → `200` + 真实用量体」但未存字面 JSON；本 fixture 的 `bodyText` 按 `UsageService.ts` 既有 `readActionData`/`{ok:true,data:{calls,costUsd}}` 契约合成，仅用于驱动 UsageService 重试路径断言（cookie 头置换 + 200 成功），不用于 `classifyAuthLoginResponse`（该函数只消费 login 端点响应） |

`classifyAuthLoginResponse(status, bodyText)` 只读 `e5-login-*` 两份（唯一权威判据：
`401 + body.errorCode==='KEY_INVALID'` → `'rejected'`，其余一律 `'unknown'`，
`e5-actions-401-no-cookie.json` 的 `ok:false` 无 `errorCode` 形状是这条规则的负控——
两轨评审都判定「若误把 actions 端点的 `ok:false` 也算作 KEY_INVALID 会连坐误杀业务
401」，`__tests__/AuthProbeScheduler.test.ts` 显式驱动这份 fixture 断言分类结果为
`'unknown'`）。

## codex-config blessing

`codex-config.blessed.toml` — D47 S3b §3「strict-config 验收」的 blessing fixture。

## 为什么是 blessing 而不是引依赖

不把 `codex` 二进制（300MB 级）拉进测试依赖（B 轨 B5 裁定）。改为**一次性真机验证**：
本机跑一次 `codex --strict-config`，确认 `src/shared/codexManagedConfig.ts` 的
`generateManagedCodexConfigToml()` 产出被 codex 接受（无 `unknown configuration field` /
strict-config 拒绝），然后把那次的生成字节原样存成本文件。之后的 vitest
（`src/shared/__tests__/codexManagedConfig.test.ts`）只做**字节相等**断言（hermetic，
不再需要本机装 codex）。

## 本次 blessing 记录

| 项 | 值 |
|---|---|
| 日期 | 2026-08-15 |
| codex-cli 版本 | `0.145.0`（`/home/dan/.nvm/versions/node/v24.18.0/bin/codex --version`） |
| 命令 | `CODEX_HOME=<tmp> AICLIENT_CODEX_API_KEY=blessing-spike-dummy-key codex --strict-config doctor --no-color` |
| 生成器输入 | `generateManagedCodexConfigToml({ baseUrl: 'https://cch-blessing.example.com/v1' })` |
| 结果 | `config.toml parse ok`；无 `unknown configuration field` / strict-config 拒绝；`auth` 段确认 `provider auth env var AICLIENT_CODEX_API_KEY (present)`；仅 `reachability` 检查失败（fake base URL 连不通，预期内，与 strict-config 无关） |

## 何时必须重跑 blessing

- `codexManagedConfig.ts` 的生成形状发生任何改动（新增/删除/重命名键、改 posture 常量）。
- `codex` CLI 版本升级（新版本可能收紧或放宽哪些字段合法）。

重跑步骤：

```bash
mkdir -p /tmp/codex-blessing-home
node --experimental-strip-types -e "
import('/home/dan/projects/ai-client/src/shared/codexManagedConfig.ts').then(m => {
  const toml = m.generateManagedCodexConfigToml({ baseUrl: 'https://cch-blessing.example.com/v1' });
  require('node:fs').writeFileSync('/tmp/codex-blessing-home/config.toml', toml, 'utf-8');
});
"
CODEX_HOME=/tmp/codex-blessing-home AICLIENT_CODEX_API_KEY=blessing-spike-dummy-key \
  codex --strict-config doctor --no-color
# Confirm no "unknown configuration field" / strict-config rejection, then:
cp /tmp/codex-blessing-home/config.toml \
  src/main/services/auth/__tests__/fixtures/codex-config.blessed.toml
```

`~/.codex` is never touched by this spike — always point `CODEX_HOME` at a throwaway temp dir.
