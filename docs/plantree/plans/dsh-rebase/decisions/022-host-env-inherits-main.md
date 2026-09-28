# 决策 022：宿主环境继承 Main 的环境再剔除，不用严格白名单（工具可见的环境有变化）

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-3 方案 §4 D6](../topics/p1-3-shared-host.md#4-需要拍板的决策点)、[分片 03](../topics/p1-3-shared-host/03-env-and-logs.md)、`dsh-subprocess` 的 `scrubbedParentEnv`。

## 规则

1. 宿主进程的环境取 Main 的完整环境，剔除三类：
   - `NODE_OPTIONS` 等运行时注入项；
   - `ELECTRON_*` 与应用内部变量；
   - 名字像密钥的变量。
2. 再显式设置 `DSH_HOME`、`DSH_TELEMETRY_DISABLED=1`、`NARB_NATIVE_CACHE_DIR=<状态根>/dsh-native-cache`。
3. P1-1 的 17 项白名单作废。

## 用户可见的变化（请重点审批）

- **1.0.x**：工具能拿到 Main 的全部环境（`src/runtime/host/worker.ts:62-68`）。
- **DSH**：DSH 自己会从工具环境里去掉两类变量：名字匹配 `KEY|PASSWORD|SECRET|TOKEN`（不分大小写）的，以及 `DSH_*`（`dsh-subprocess` 的 `scrubbedParentEnv`）。所以不管本决策怎么选，切换后在 bash / pwsh 工具里，`GITHUB_TOKEN`、`NPM_TOKEN`、`AWS_SECRET_ACCESS_KEY` 这类变量都看不到了。这是 DSH 有意的安全设计，本决策照单接受。
- 用本决策（继承再剔除），`SSH_AUTH_SOCK`、`JAVA_HOME`、代理、`XDG_RUNTIME_DIR` 等非密钥变量与 1.0.x 保持一致。用严格白名单则这些都会丢。
- 如果以后有用户确实要在工具里用某个令牌，可以加一个「显式转发的变量名单」设置。DSH 允许显式传入的 env 覆盖掉清洗结果。这一项记入想法，不在 P1 范围。

## 取舍

- 继承了 `XDG_RUNTIME_DIR` / DBus 之后，DSH 在 Linux 上改走 systemd scope 收容，P0-6 看到的降级警告会消失。
- 代价：Main 的杂项变量会进工具环境，与 1.0.x 相同。P1-5 的开发网关 key 会被密钥名规则剔除，要显式补回宿主。
