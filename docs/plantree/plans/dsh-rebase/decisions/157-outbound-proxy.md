# 决策 157：宿主的出站代理——现状、选项与推荐

日期：2026-10-07。**状态：待用户拍板。** 本决策只做调研，没有改代码。

依据：

- roadmap P1-3 行原文「宿主的出站代理（`installProxyFromEnvironment`、产品代理设置传进宿主）在 P1-3 定」；[P1-5 方案](../topics/p1-5-models-and-credentials.md)「与其他任务的边界」与 §8「风险与未覆盖」两处写「要在 R1 之前由 P1-3 定下」；[P1-3 分片 03](../topics/p1-3-shared-host/03-env-and-logs.md) §2 写「`$DSH_HOME/.env` 里的代理设置不再生效……产品有自己的代理设置，与 P1-5 的网关一起考虑」。三处都没有落成决策，由 [P1-14 之前的盘点](../topics/pre-p1-14-remaining-2026-10-07.md)第 7 项补登。
- 已批准的决策：[022](022-host-env-inherits-main.md)（宿主环境继承 Main 再剔除）、[023](023-no-dotenv-private-cwd-home-patch-overlay.md)（不读 `.env`）、[034](034-per-request-credential-pull.md)（key 按请求拉取）、[037](037-user-agent-test-first.md)（UA）；[150](150-e8-plugin-credential-isolation.md) 第 2 节 D（Main 本地反代，长期方向）。
- 1.0.x：main 分支 `src/runtime/host/httpDispatcher.ts` 的文件头（runtime-hardening T093 与决策 029，提交 `5f5433fa`）。
- DSH 0.1.7-rc.2：`src/dsh-host/node_modules/@deepseek-ai/dsh-http-proxy/README.md` 与 `lib/index.js`。

## 1 现状（读代码得出，没有实测）

### 1.1 DSH 分支

1. **宿主不装出站代理。** `src/dsh-host/host.ts` 文件头写明照 `@deepseek-ai/dsh/profile-boot` 的 `runProfile` 做，但「minus the proxy」。我方代码里没有调用 `installProxyFromEnvironment`，也没有任何 `setGlobalDispatcher`，搜索只命中 `node_modules`。宿主依赖里没有 `dsh` 启动器包，只有 `dsh-app-boot`，所以也没有别的代码替我们装。
2. **模型请求因此直连。** pi-ai 的 provider 走 `globalThis.fetch`（dsh-http-proxy README）。随包 Node v24.18.0 的内置 fetch 默认不读 `HTTP(S)_PROXY`；只有环境里有 `NODE_USE_ENV_PROXY=1` 时才读（DSH README 写 22.21+、24+）。宿主的启动参数只有 `--expose-internals`（`DshHostProcess.ts` 的 `DSH_HOST_NODE_ARGS`），Main 也不设这个变量。如果用户自己在启动环境里导出了它，按决策 022 会被继承进宿主（推断，没有实测）。一次性补全（P1-15）走同一个宿主，同样直连。
3. **产品的代理设置不进宿主。** 设置 · 网络（`NetworkSettings.tsx`，默认关）经 `applyProxy` 只作用于 Electron 默认 session 和更新用的 session。`getProxyEnvVars()` 只注入 Main 起的 git（`services/git/runtime.ts`）和终端（`PtyManager.ts`），`DshHostProcess.ts` 与 `dshHostEnvironment.ts` 都不用它。
4. **工具子进程只拿到继承来的代理变量。** 宿主环境取 Main 的环境再剔除（决策 022），`HTTPS_PROXY` 这类变量不剔除（`DshHostProcess.test.ts` 的 `INHERITED` 钉住了这一点）。DSH 的 `dsh-subprocess` 会给子进程叠上 `proxyEnvironmentForChild()`，没装策略时它返回空对象。所以 bash / pwsh 里的 curl、git、npm 看到的是用户启动应用时的原始代理变量，看不到产品代理设置。
5. **`$DSH_HOME/.env` 里的代理不生效**（决策 023）。决策 023 代价一节写「代理改由继承 Main 的环境获得」，这只对工具子进程成立，对宿主自己发出的模型请求不成立。本决策在此更正。
6. **Main 自己的公司流量**（登录、模型目录、用量、公告）用 Electron 的 `net.fetch`，跟随默认 session，也就是跟随产品代理设置。渲染层恢复设置时会调一次 `setProxy`，没启用时设为 direct（推断，没有实测）。
7. **实测情况**：09-30 的真实网关 R1～R10 在用户的 Linux 开发机上直连完成（[证据](../evidence/p1-5-real-gateway-2026-09-30.md)），没有遇到需要代理的情况。公司其他办公网络是否必须经代理才能访问模型网关，没有数据（待确认）。

### 1.2 1.0.x（main，自有 runtime）

- `src/runtime/host/httpDispatcher.ts` 装的是 undici 的 `Agent`，只为首字节和空闲超时，**刻意不用 `EnvHttpProxyAgent`**。文件头的理由是：shell 为其他工具导出了代理的用户，不能因为一次超时修复就让本应用的 provider 流量被静默改道；代理支持要单独、有意地决定。
- 产品代理设置同样不进 worker；worker 的工具继承 Main 的环境。
- 结论：**DSH 分支的现状与 1.0.x 一致**。模型请求直连；产品代理只管 Main、更新、git 与终端。设置页的说明「通过代理路由所有网络请求」在两个版本里都不准确。

### 1.3 DSH 自己的默认做法

- `dsh` 启动器在任何插件加载之前，对每个 profile 调一次 `installProxyFromEnvironment`。它读 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`：小写优先、大写兜底，空值算没设。值先取启动环境，其次取 `$DSH_HOME/.env`；项目自己的 `.env` 里出现这些名字时直接拒绝启动。
- 策略装成 undici 的全局 dispatcher，pi-ai、MCP HTTP、web-fetch 都经过它；回环地址永远直连。
- 不支持 SOCKS、PAC 和操作系统代理（Windows、macOS 的系统代理设置都不读）。SOCKS 这类用不了的值只告警一次，该协议改为直连。
- 子进程：`proxyEnvironmentForChild()` 叠上 `NODE_USE_ENV_PROXY=1` 与解析后的变量，用户自己写过的值原样保留。
- 会做 TLS 拦截的企业代理需要 `NODE_EXTRA_CA_CERTS`，这个包既不设置也不校验它。按决策 022，这个变量会被继承进宿主。

## 2 选项

| | 做法 | 用户感受 | 代价与风险 |
|---|---|---|---|
| A | **维持现状**：宿主不装代理，模型请求直连 | 与 1.0.x 相同 | 零改动。在必须经代理才能连模型网关的网络里，模型用不了，登录和目录却正常（Main 走产品代理），容易被误判成网关故障。设置页说明不准（1.0.x 也一样） |
| B | **跟随 DSH 启动器**：`host.ts` 启动时用启动环境调 `installProxyFromEnvironment` | shell 或系统环境导出了 `HTTPS_PROXY` 的用户，模型流量从此走代理 | 约 0.5 人日，外加用假代理做的出站测试。1.0.x 刻意避免的「静默改道」重新出现：例如为别的工具开了本机代理，而这个代理不放行公司网关，模型请求就会失败。工具子进程会多拿到 `NODE_USE_ENV_PROXY=1`。将来如果按决策 037 做 UA 拦截，要与全局 dispatcher 组合 |
| C | **接产品代理设置**：产品代理启用时，Main 把 `getProxyEnvVars()` 的值放进宿主启动环境，只作为宿主代理策略的来源，宿主调 `installProxyFromEnvironment`；没启用时宿主不装 | 设置页的开关真正管到模型请求，与 Main 的公司流量一致 | 约 1～1.5 人日。设置改了之后宿主要重启才生效，可以复用插件开关的「空闲时自动重启」（决策 143）。产品设置允许 `socks5://`，宿主不支持，只能告警后直连。还要决定工具子进程看不看产品代理：这要与决策 022「工具环境与 1.0.x 一致」分开处理。Windows 与公司网络只能在测试版上验证 |
| D | **Main 本地反代**（决策 150 第 2 节 D）：模型流量经 Main 的 Electron `net`，自然跟随产品代理与系统代理 | 同 C，并且支持系统代理 | 大工程，同时能解决凭据不进宿主和 UA 两个问题。超出 P1，只作为长期方向 |

## 3 推荐

**合入前选 A，把现状写清楚。如果用户确认有人必须经代理才能连模型网关，再做 C，不做 B。**

- A 与 1.0.x 的行为一致，合入即切换时不多一个变量；R1～R10 已在直连下通过。
- B 是 DSH 的默认做法，但它按 shell 环境改道，正是 1.0.x 刻意避免的副作用。决策 090「默认跟随 DSH」在这里与「不让用户的环境静默改变本应用的流量」冲突，交给用户定。
- 真要支持代理，C 比 B 可控：用户在设置里明确打开，Main 和宿主走同一套代理。
- 不论选哪一项，都建议在 P1-14 的发版说明或设置页说明里写明「代理设置不作用于模型请求」。改说明属于代码改动，本决策不做，由用户决定。

## 4 待用户确认

1. 选 A、B、C 中的哪一项（推荐 A，需要时再做 C）。
2. 公司办公网络里，有没有用户必须经代理才能访问模型网关。这决定 C 的优先级。
3. 设置 · 网络里「通过代理路由所有网络请求」这句说明，要不要改成如实的说法。

## 5 影响

- roadmap P1-3 行「出站代理在 P1-3 定」由本决策承接。决策 023 代价一节的「代理改由继承 Main 的环境获得」只对工具子进程成立（见 §1.1 第 5 条）。
- 选 B 或 C 时还要补三件事：宿主启动日志报告代理是否生效（不打印代理地址）；出站测试（假代理加假网关）；Windows 测试版实测。
