# 决策 023：宿主不读 `.env`，cwd 用私有空目录，home 层 patch 加 overlay

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-3 方案 §4 D7](../topics/p1-3-shared-host.md#4-需要拍板的决策点)、P0-2 发现（`.env` 会进工具环境）。

## 规则

1. `host.ts` 不再调用 `loadLayeredEnv`，改用只含进程层的 `createLaunchEnvironmentSnapshot`。这样宿主启动目录和 `$DSH_HOME` 下的 `.env` 都不会被读，也不会写进 `process.env`。这是 DSH 里唯一的 `.env` 读取点（`host.ts:105`），不用给 DSH 打补丁。
2. 宿主的 cwd 改为应用状态根下的私有空目录，不再是 `DSH_HOME`。
3. `$DSH_HOME/cordis.patch.yml`：保留 DSH 的读取行为。在 `overlays` 末位重申隐私相关的行保持关闭，保留启动审计；这个文件存在时写一条告警。
4. 静态守卫：`host.ts` 不出现 `loadLayeredEnv`、`loadEnv`、`loadEnvFile`。

## 取舍

- 只改一处调用，不改 DSH 包。
- 代价：用户不能再通过 `$DSH_HOME/.env` 配代理之类的设置。代理改由继承 Main 的环境获得（[决策 022](022-host-env-inherits-main.md)）。

## 补记（2026-09-27）

[决策 059](059-allowlist-verification-and-audits.md)（待审批）细化了第 3 条：home 层补丁如果插入了白名单未声明的行，产品态拒绝启动，不再只是告警。
