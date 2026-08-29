# Implementation Status — 统一凭据目录与托管凭据转默认

> 操作性交接档，只放「下一个人接手要立刻知道的事」。
> 逐批明细在 [roadmap](./roadmap.md)，决策原文在总台账，取证在 `docs/plans/` 下的取证档。

**Last Verified**：2026-08-27 · 四门全绿 —— typecheck 0（含 agent-host）· biome 1000 文件 0 ·
**vitest 248 文件 5009 例**

## Current Phase

**S0' / S1 / S2 / S3 / S4 全部落地，本 plan 已完成。**
S4 于 2026-08-28 随 pi-backend-migration Phase 5 完成：可选 `VaultPayload.pi` arm、登录与 adoption 写入、旧文档回退兼容。

工作重心已转移到 [entry-and-environment](../entry-and-environment/README.md)：它的第一件
（E1 本机可用性探测）前置刚被本批解开。

## Last Landed（2026-08-27 单日七笔）

| commit | 内容 |
|---|---|
| `18da2d7f` | **S2** 目录改名 `.aiclient` → `.pilab`，凭据并入同一目录 |
| `7785ee1c` | **S0' codex 侧** 取消隔离 `CODEX_HOME`，凭据与 provider 改经 `-c` + env |
| `24b3d3f4` | docs：E2 取证、新 plan `entry-and-environment`、D63~D66 |
| `972934d5` | **S0'-b** 配置加载失败报出文件、行列与修法 |
| `4f1e6897` | **S3 + D64** 凭据模式从构建期开关变运行期状态 |
| `f791e6f4` / `d29fc871` / `024990f8` | **settingSources** 取证 → 打开三层 → 加上第三层 |

## Active TODO

1. **E1**（属 entry-and-environment）—— 「使用本机已有配置」按钮的本机可用性探测。**前置已清，可开工。**
2. 复核 `verifyResumePosture` 的两条可达例外（见下方风险 ①）。
3. 补测 `managedSettings` 的执行期过滤行为（见下方风险 ②）。

## Blocked By

无。本 plan 的 open questions 已全部关闭。

## 尚未解决的风险

1. **⚠️ codex 老会话可能变成打不开**（[E2 §④](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)）
   —— `approval_policy` 在 resume 时由 rollout 定死，`-c` 与 `config.toml` 都改不动。
   常规路径撞不到（冷 resume 的期望档位取自会话自己存的偏好），但两条例外**未复核**：
   ① 会话建好后改过权限偏好；② 没存偏好的老会话遇上 `CODEX_PERMISSION_DEFAULT` 常量改值 ——
   后者会让**所有**老线程一起打不开。`codexHome.ts` 里那条写反的注释已随 `7785ee1c` 订正。

2. **⚠️ SDK 文档与实测不一致**（[settingSources 取证 §A⑥](../../../plans/2026-08-27-settingsources-spike/README.md)）
   —— 文档称 `managedSettings` 被 restrictive-only 过滤、`permissions.allow` 会被丢弃；
   `resolveSettings` 显示**没有被丢弃**。本批最终没用 `managedSettings`，**不阻塞**；
   但将来谁要拿它当安全边界，**必须先单独测执行期行为**。

3. **已知并接受的代价**（不是缺陷，是拍板结果，写在这里免得被当 bug 报）：
   - 远端已连过的机器留下 `~/.aiclient/` 孤儿，设置回默认 + runtime 重下一次（D62，发布说明已写）
   - 应用内终端敲 `codex` 走用户自己的配置，不再走公司网关（D66 —— 两半拆不开，codex 没有能改 `base_url` 的环境变量）
   - 从没走过公司登录的老用户，升级后会被拦在登录页一次（D64「首次必须登录」）
   - 配置里的免问规则会让对应动作**不弹权限卡**（D67「完全照配置办」）

4. **⚠️ S0' 引入的回归已止血但值得盯**：用户 `~/.codex/config.toml` 里一行遗留 `profile =`
   或一处 TOML 语法错会让会话起不来。`972934d5` 已让错误带出文件路径、行列与修法，
   但**没有真机用户样本**验证过文案是否够用。

## 关键文件（本批新增 / 删除）

**新增**：`shared/appStateLayout.ts` · `shared/credentialMode.ts` · `main/services/appStatePaths.ts` ·
`main/services/appStateMigration.ts` · `main/services/auth/credentialMode.ts` ·
`agent-host/codexConfigOverrides.ts` · `agent-host/codexConfigError.ts` ·
`src/__tests__/setup/hermeticHome.ts`（测试进程一次性 `$HOME`）

**删除**：`agent-host/codexHome.ts`（761 行投影器）· `main/services/auth/codexHome.ts` ·
`shared/codexManagedConfig.ts` · `OnboardingService` 的四个遗留写入方法

**改动要点**：`claudeRuntime.ts` 的 `settingSources` 由 `[]` 改为三层 ·
`AuthStateService` 与 `adoption.ts` 改为**接收**已解析的凭据模式（保住纯模块契约）·
13 个消费方的 import 从 `AuthStateService` 转到 `credentialMode`

## 本机环境注意（恢复工作时会撞到）

- **`dev.env` 里加了 `AICLIENT_MANAGED_CREDENTIALS=1`**（gitignored，只在这台机器上）。
  它现在是**仅开发期的覆盖**，语义也变了：`'0'` 是**显式 local**，不再等同于「不是 1」。
  想让配置文件说了算，得把这一行**删掉**而不是改成 `0`。
- **`<userData>/codex-home/` 还留着**（本机 `~/.config/jyw-ai-client-dev/codex-home/`）——
  旧构建写的死数据，S0' 之后没有任何代码读它，也**刻意不再删它**
  （见 `managedCredentialsStartup.test.ts` 的「不删旧 auth.json」用例）。看到别以为是活的。
- **旧目录 `~/.aiclient/` 按设计保留**，S2 的迁移是 copy 不是 move。

## 废案

见 [topics/discarded-approaches.md](./topics/discarded-approaches.md) —— 本批废掉六个方案，
每条都记了**为什么废**与详细取证在哪。
