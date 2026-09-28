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

## 补记（2026-09-28，依决策 110 修订）

[决策 108](108-p1-10b-host-plugin-loading-choices.md) 第 12 条原本落实了上一条补记（未声明行拒绝启动）；[决策 110](110-user-rulings-2026-09-28-batch2.md) 用户裁决改选更彻底的做法：**打包态完全不读 `$DSH_HOME/cordis.patch.yml`**，只在文件存在时打一行告警说明它被忽略；源码态（开发与探针）仍照第 3 条原文读取、应用。这连带解决了「home 层的 `!!js` 表达式在组合时会被求值」这一未处理的风险点——打包态既然不再解析这个文件，其中的 `!!js` 表达式也就不会被求值。上一条补记（决策 059 的「未声明行拒绝启动」）在打包态上被取代；源码态的读取行为本身不变。
