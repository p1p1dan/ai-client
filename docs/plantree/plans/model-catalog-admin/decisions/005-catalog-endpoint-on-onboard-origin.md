# D05 — 配置端点挂 onboard 域名，默认值取已知的 onboard 地址

- **日期**：2026-09-05
- **状态**：Active
- **拍板人**：用户（三选一里选「挂 onboard 域名，默认值用已知的 onboard 地址」）
- **答复**：[Q04](../open-questions.md)，并确定 [M04](../roadmap.md) 的形状

## 取证：客户端本来就知道 onboard 在哪

原计划写的是「从登录拿到的 cch 地址推导管理端点地址」。开工前复核发现有更直接的来源：

- `OnboardingService.ts:14-18`：onboard 服务地址是编译期注入的
  `__ONBOARDING_SERVICE_URL__`，缺省 `https://onboarding-jyw.pipidan.qzz.io`。
- `OnboardingService.ts:384`：每次登录还把实际用的 `onboarding.serverUrl` 写进应用状态。
- 保险箱里的 `cchBaseUrl`（`CredentialVault.ts:54`）是 **cch 网关**地址，
  onboard 侧由 `ONBOARDING_BASE_URL` 给出（`verify-and-register.ts:127`），
  与 onboard 服务自身的地址不是一回事。

## 决定

**配置端点属于 onboard 服务本身：`<onboardServiceUrl>/api/v1/models-config`。**

客户端默认值按以下优先级取，不做任何字符串推导：

1. 用户手填值（`PILAB_MODEL_CONFIG_URL` 环境变量 → `piModelManagementUrl` 设置项）；
2. 编译期注入的 `__ONBOARDING_SERVICE_URL__` / 其缺省值，拼上 `/api/v1/models-config`。

**2026-09-05 施工时的取证更正**：本决策初稿里的第 2 级「登录时记录的 `onboarding.serverUrl`」
不成立。`OnboardingService` 写入该字段时用的是 `cchServerUrl`（`OnboardingService.ts` 成功分支
与 `:384` 的登出分支都是），也就是 **cch 网关地址**，不是 onboard 服务自身的地址。
onboard 地址在客户端只有编译期注入这一个来源（`verifyAndRegister` 也是用它发请求的），
因此优先级从三级缩为两级。结论不变——端点仍挂 onboard 域名，只是默认值的来源少一层。

`src/shared/piModelConfig.ts:29` 里写死的 `http://127.0.0.1:3210/api/v1/models-config` 随之退役。

## 理由

配置数据和管理页都住在 onboard 里，端点跟着它走，部署就是一份。
挂 cch 域名的方案要求网关把这条路径转发回 onboard，多一跳网关配置且与 cch「不动」的范围冲突
（见 [README 不在范围](../README.md)）。

## 连带改动

- 管理页地址由端点地址推出：现有 `src/main/ipc/piModels.ts:17-20` 已经在做
  「去掉 `/api/v1/models-config` 得到管理页根路径」，这条逻辑继续成立。
- 本地开发仍可手填 `127.0.0.1`，只是不再是缺省值。
