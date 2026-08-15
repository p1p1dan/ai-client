# auth 夹具（codex-config blessing）

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
