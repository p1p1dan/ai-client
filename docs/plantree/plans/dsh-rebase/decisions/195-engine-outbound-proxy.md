# 决策 195：「设置 · 网络」的代理作用于模型请求（两个引擎）

日期：2026-10-18（UTC+8）。**状态：用户裁决（决策 193 第 21、22 条）的落实方案；第 3 节各条是自主决定，待用户审批，其中第 5 节列的几点要用户定。** 已实现，落地与验证见第 7 节。

依据：

- [决策 193](193-user-rulings-2026-10-18.md) 第 21 条：公司里有人必须经代理才能访问模型网关，做[决策 157](157-outbound-proxy.md) 的 C，两个引擎都要；动工前定 socks5、改设置是否重启、工具子进程看不看产品代理。第 22 条：设置页说明按做完的实际行为写。
- 决策 157 第 1 节的现状调研（DSH 宿主不装代理；产品代理只管 Main、更新、git 与终端）；[决策 150](150-e8-plugin-credential-isolation.md) 第 2 节 D（Main 本地反代）仍是长期方向，本决策不做。
- 决策 022（宿主环境继承 Main 再剔除）、023（不读 `.env`）、090（默认跟随 DSH 的做法）。
- 路线 B：S-3 K-3（鉴权代理的上游一段跟随启动环境的 `HTTP(S)_PROXY`）、K-4（CLI 的 `NO_PROXY` 补本机地址）、K-5（网关 key 只走 IPC），见 `docs/plantree/plans/claude-sdk-engine/topics/s3-project-config.md`。
- DSH 0.1.7-rc.2 的 `@deepseek-ai/dsh-http-proxy`（README 与 `lib/index.js`）、`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv`；undici 8.11.2 的 `ProxyAgent`；Node 24 内置的 `http.Agent({ proxyEnv })`。

## 1 动工前读代码与实测得到的事实

1. **DSH 的代理包怎么装**：`installProxyFromEnvironment(env, report)` 从一个「按名字取值」的环境解析出策略（`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`，小写优先），装成 undici 的全局 dispatcher。Node 内置的 `fetch`、pi-ai 的 provider、MCP over HTTP、web-search 都走它；`dsh-web-fetch-http` 用 `proxyRouteFor` 读同一份策略。返回的 disposer 会还原先前的 dispatcher、策略与环境，**所以可以先卸再装，不必重启宿主**。
2. **它会改写宿主的 `process.env`**：装上后把解析结果写回 `http(s)_proxy` / `HTTP(S)_PROXY` / `no_proxy` / `NO_PROXY`。工具子进程的环境是 `scrubbedParentEnv()` = `process.env` 去掉凭据形状的名字，再叠 `proxyEnvironmentForChild()`：用户自己在启动环境里写过的协议保留用户的值，没写过的给解析出的代理，`NO_PROXY` 一律用解析结果，并加 `NODE_USE_ENV_PROXY=1`（子进程里的值有它拒收的就不加）。不给 DSH 打补丁，就做不到「宿主走代理而工具不拿代理」。
3. **SOCKS / PAC / 解析不了的值**：报一条诊断（只写变量名，不写值），该协议直连。回环地址（`localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0`）永远直连。`NO_PROXY` 不认 CIDR。
4. **undici 8.11.2 的 `ProxyAgent`**：代理 URL 里的用户名、密码按百分号解码后作 `Proxy-Authorization: Basic`；`http:` 目标默认不建隧道（绝对 URI 转发），`https:` 目标走 `CONNECT`。
5. **Node 24.12 的 `http.Agent({ proxyEnv })`**（本机实测，`/tmp` 下的实验脚本）：认大小写两种写法；URL 里的凭据同样变成 `Proxy-Authorization: Basic`（`us%40er:p%3Ass` 解码为 `us@er:p:ss`）；`socks5://` 不支持（请求失败，不会退回直连）；**不会自动绕过回环**（`127.0.0.1` 也被送去代理）。
6. **Main 自己的流量不支持带凭据的代理**（读代码，没有实测）：Electron 的 `setProxy({ proxyRules })` 不接受 URL 里的凭据，Main 也没有处理 `login` 事件；设置页的校验正则 `^((https?|socks…)://)?[\w.-]+:\d+` 也把 `user:pass@host:port` 标红。也就是说，今天带凭据的代理连登录都过不去。
7. **启动顺序**：Main 的代理设置只在两处落地：渲染层恢复设置时调一次 `setProxy`，以及 Windows / AppImage 上更新器初始化时补一次。Linux deb/rpm 上，渲染层恢复之前 Main 不知道代理（`getProxyEnvVars()` 为空）。DSH 宿主可能被预热，早于渲染层恢复。
8. **本机网络**：这台开发机有一个 198.18.x 的 TUN 网卡（fake-ip 类透明代理），「直连」一个不存在的域名也会连上 TUN 再被重置，而不是 `ENOTFOUND`。所以本地验证用测试代理自己的记录区分「经代理 / 没经代理」，不靠错误码。

## 2 方案概览

开启代理时，Main 把产品代理（地址与绕过列表）经 IPC 交给宿主，宿主据此安装代理；关闭时两个引擎的模型请求都直连。代理地址**不进宿主的启动环境，也不进任何命令行**。

| | DSH 宿主（所有会话共用一个） | SDK 引擎（每个对话一个宿主） |
|---|---|---|
| 交付 | `configure` 里的 `proxy`；之后每次改动发 `{ host: 'proxy', proxy }` | `host.secret` 里的 `proxy`；之后每次改动发 `{ type: 'host.proxy', proxy }` |
| 宿主怎么装 | `installProxyFromEnvironment`（DSH 自带的包），改动时先卸后装 | 鉴权代理转发到网关的那一段：`http.Agent({ proxyEnv })`，改动时换一个新 agent |
| 覆盖 | 模型请求、一次性补全（提交信息、代码审查）、MCP over HTTP、web 抓取与搜索 | 模型请求（含 count_tokens、模型校验） |
| 子进程 | 第 3 节第 7 条 | CLI 及其子进程，第 3 节第 7 条 |

## 3 定下来的做法（自主，待审批）

1. **来源只有产品设置**（C，不是 B）：宿主装代理只看 Main 交来的设置，不看启动环境里的 `HTTP(S)_PROXY`。`proxy` 为 `null` 表示产品代理关着。
2. **关闭时直连，两个引擎一致。** DSH 宿主维持现状。SDK 引擎**改掉 S-3 K-3**：鉴权代理的上游一段不再跟随启动环境的 `HTTP(S)_PROXY`，产品代理关着就直连。理由：设置页这个开关应当是模型请求走不走代理的唯一开关，两个引擎一个说法；路线 B 还没正式发布，没有用户依赖 K-3。Main 没发 `proxy` 字段时（应急开关，见第 10 条；或旧的探针脚本），SDK 宿主照旧按 K-3 走。**待确认，见第 5 节 Q1。**
3. **SOCKS 告警并直连，不拒绝。** 产品设置允许 `socks5://` 等，Main 自己的流量（登录、目录、git、终端）用得上；宿主用不了，就在宿主日志里写一行「产品代理是 SOCKS，模型请求不能用，直连」（不写地址），模型请求直连，工具子进程也不拿这个值（DSH 的规则：拒收的值不发布）。不拒绝的理由：同一个设置还管 Main 的流量，用 SOCKS 只为更新或 GitHub 的用户，不能因此连模型都用不了。设置页在填了 SOCKS 地址时显示一行警告色说明（第 11 条），免得用户以为模型请求也经代理。不认识的协议、解析不了的地址同样处理。
4. **改了设置立即生效，不重启宿主。** DSH 宿主卸掉旧的 dispatcher 装新的；已经发出的请求在旧路由上走完（DSH 的 disposer 是 `close` 不是 `destroy`）。SDK 宿主换掉鉴权代理的上游 agent，旧 agent 上进行中的流式应答照常走完，对话结束时一并关掉。Main 只在「交给引擎的值」真的变了、并且停稳 0.5 秒后才发（设置页每敲一个字都会调一次 `setProxy`；只改「代理更新」开关、或代理关着时改地址，都不发）。
5. **已开的 SDK 对话**：模型请求立即切换（第 4 条）；CLI 自己的联网（WebFetch、MCP over HTTP）和它起的子进程用的是对话开始时的环境，要等这个对话的宿主重启（重开对话或重启应用）才换。没有为此重启 CLI：会打断进行中的回合，而这部分不是模型请求。
6. **启动时 Main 先读出已保存的代理设置**，在任何宿主启动之前（所有平台；以前只有渲染层恢复和 Windows / AppImage 的更新器两处）。渲染层恢复时的那次 `setProxy` 值相同，不会再发给宿主。
7. **工具子进程看产品代理，照 DSH 的默认做法。** DSH 宿主装上代理后，bash / pwsh 等子进程：用户在启动环境里自己写过的协议用用户的值，没写过的给产品代理；`NO_PROXY` 见第 8 条；Node 子进程多一个 `NODE_USE_ENV_PROXY=1`。SDK 引擎的 CLI 环境按同一规则算（CLI 的 WebFetch、MCP、Bash 子进程都吃这份环境）。产品代理关着时，两边都与现在一样，只有启动环境里的值。理由：(a) 决策 090 默认跟随 DSH；(b) 应用自己的终端和 Main 跑的 git 早就拿产品代理（`getProxyEnvVars`），模型跑的命令与终端一致；(c) 不打补丁做不到另一种（第 1 节第 2 条）。代价：带凭据的代理地址会出现在工具的环境里，模型能读到（例如 `echo $HTTPS_PROXY`）。**待确认，见第 5 节 Q2。**
8. **绕过列表 = 设置页的绕过列表 ∪ 启动环境里的 `NO_PROXY` ∪ 本机地址。** 设置页的 `*.example.com` 照 Main 现有的规则写成 `.example.com`；本机地址（`localhost`、`127.0.0.1`、`::1`、`[::1]`）永远直连：DSH 自带，SDK 一侧显式加上（Node 不会自动绕过回环，第 1 节第 5 条），所以本机起的网关（如本地 new-api）不会被送去代理。并上启动环境的 `NO_PROXY`：绕过项只会让某个主机直连，IT 在环境变量里写下的例外不该因为打开产品代理而失效，子进程的 `NO_PROXY` 也就不会比原来少（DSH 的子进程拿的是解析结果）。不支持 CIDR（DSH 的限制）。
9. **带凭据的代理**：两个引擎都按 URL 里的用户名、密码发 `Proxy-Authorization: Basic`。地址不进宿主的启动环境、不进命令行（DSH 宿主与 SDK 宿主的参数都只有入口文件；SDK 的 flag 层 `settings` 会上 CLI 命令行，带凭据的代理变量照 S-3 原规则不钉，只记名字）；日志只写「开 / 关 / 不支持」、协议和绕过项个数，从不写地址；SDK 宿主把代理的密码加进日志脱敏名单，宿主 stderr 的共用脱敏本来就会抹掉 URL 里的 `user:pass@`。第 1 节第 6 条说的 Main 一侧问题本决策不改，**见第 5 节 Q3。**
10. **应急开关**：环境变量 `AICLIENT_RUNTIME_ENGINE_PROXY=0` 时，Main 不把代理交给任何宿主（消息里没有 `proxy` 字段），两个引擎回到本决策之前的行为（DSH 直连，SDK 按 K-3）。命名沿用 `AICLIENT_RUNTIME_*` 一族；只由 Main 读，不转发进宿主。
11. **设置页说明**（决策 193 第 22 条）：
    - 「启用代理」一行：「登录、模型请求、git、终端，以及对话里运行的命令都经代理」（英文：Sign-in, model requests, git, the terminal and commands run in chats go through the proxy）。
    - 代理地址下面的说明补一句「模型请求不能用 SOCKS 代理」；开着代理又填了 SOCKS 地址时另显示一行警告色：「SOCKS 代理不作用于模型请求和对话里运行的命令，它们直连；要让它们经代理，请填 http:// 代理」。
    - 更新那一行不变（更新仍由「代理更新」单独决定）。
12. **日志**：DSH 宿主每次应用写一行 `[dsh-host] outbound proxy: on (http proxy; 4 bypass entries)` / `off` / `not used: the product proxy is a SOCKS proxy …`，SOCKS 时另有 DSH 自己的告警（只写变量名）；SDK 宿主在启动行写 `outbound=…`，每次切换写 `auth proxy: outbound proxy …`。Main 在改动停稳后写 `[worker-manager] outbound proxy for the engines is now on|off; the DSH host switched`（宿主没在跑时是「the next DSH host starts with it」）。都不含地址。
13. **代理拒绝凭据（407）**（实现时补的）：SDK 宿主的鉴权代理收到上游的 407 时，回给 CLI 一个不重试的 502 `api_error`，说明是 PiLab 设置里的代理拒绝了请求。原样转 407 时，CLI 的 fetch 把它当网络错误，会反复重试才失败。DSH 一侧没改：undici 遇到 407 同样报网络错误，按 DSH 现有的重试与失败处理走。

## 4 验证（先定，后改代码）

| 层 | 内容 |
|---|---|
| 纯函数单测 `src/shared/__tests__/hostProxy.test.ts` | 设置的读取与校验；协议分类（http、https、socks、无效）；绕过列表合并与去重、回环必含；SDK 上游 `proxyEnv` 的开、关、socks、带凭据；CLI 子进程环境的叠加规则（用户写过的保留、没写的给产品代理、关时不变）；脱敏名单含密码；日志摘要不含地址与凭据 |
| Main 单测 | `ProxyConfig`：开、关、socks、带凭据时交给宿主的值，只在值变化时通知，应急开关；`DshHostSupervisor`：`configure` 带上 `proxy`，改动时给活着的宿主发 `proxy` 控制消息；SDK 传输：`host.secret` 带上 `proxy`，改动时发 `host.proxy`，退出后不再发 |
| DSH 宿主单测 | `lib/hostProxy.ts`：先卸后装、串行、相同值不重装、socks 告警、读取消息 |
| SDK 宿主单测 | `authProxy`：起一个测试代理与一个只有经代理才能解析的上游（`*.invalid`），开 → 测试代理看到请求、带凭据时收到正确的 Basic；切到关 → 测试代理不再看到请求；socks → 告警并直连；`hostConfig`：CLI 环境与钉住的变量 |
| 真宿主探针 | `src/dsh-host/tools/proxy-probe.ts`：真 DSH 宿主 + 假网关（只经测试代理可达的 `*.invalid` 地址）+ 测试代理：开（带凭据）→ 一轮对话完成，测试代理记到模型请求且凭据正确；宿主 stderr 不含密码；运行中切到关 → 下一轮的模型请求不经代理（测试代理没有新记录）；socks → 告警、不经代理。SDK 引擎在 `host-probe.ts` 加 `proxy` 场景，同样三步 |
| 静态 | 三套 tsc（根、DSH 宿主、SDK 宿主）0 错；相关 vitest 通过 |

## 5 待用户确认

- **Q1**（第 3 节第 2 条）：产品代理关着时，SDK 引擎的模型请求也直连，不再跟随启动环境的 `HTTPS_PROXY`（改掉 S-3 K-3）。推荐：是，两个引擎一个开关。备选：维持 K-3（关着时 SDK 跟随启动环境，DSH 直连，两个引擎行为不同）。改回只需一行。
- **Q2**（第 3 节第 7 条）：打开产品代理后，模型跑的命令（bash / pwsh、CLI 的子进程）也拿到产品代理，带凭据时模型能读到代理密码。推荐：接受，与应用自己的终端和 git 一致，也是 DSH 的默认做法。备选：带凭据时不给工具。SDK 一侧容易做；DSH 一侧要包一层子进程环境（给 `dsh-subprocess` 打补丁或换掉它的环境来源），约 0.5～1 人日，并且要随 DSH 升级维护。
- **Q3**（第 3 节第 9 条）：Main 自己的流量（登录、模型目录）目前用不了带凭据的代理，设置页也把这种地址标红。要不要另开任务补上（处理 `login` 事件，从设置里的地址取凭据；校验正则放行 `user:pass@`）。推荐：等有人确实需要认证代理时再做；本决策只保证引擎一侧支持、且不泄露。
- **Q4**（第 3 节第 3 条）：SOCKS 是告警后直连（推荐），还是拒绝发模型请求并报错。

## 6 影响

- 决策 157 的 C 由本决策落实；157 第 4 节的三个问题由决策 193 第 21、22 条回答。决策 023 代价一节「代理改由继承 Main 的环境获得」的更正（157 第 1.1 节第 5 条）仍然成立：继承来的代理只给工具子进程，模型请求只看产品设置。
- 路线 B S-3 K-3 按第 3 节第 2 条修订（待 Q1）；K-4（CLI 的 `NO_PROXY` 含本机地址）不变。
- 设置页的说明与新增的 SOCKS 提示走词条（第 3 节第 11 条）。
- ARD §10（DSH 偏离）与路线 B README 在下次回写时补一句「产品代理作用于模型请求」。

## 7 落地与验证

分支 `claude/outbound-proxy-model`（基于 `claude/s6-feedback` 的 `89d82245`）。本机 Windows 10，Node 24.12。

### 7.1 改了什么

| 位置 | 内容 |
|---|---|
| `src/shared/hostProxy.ts`（新） | Main 与两个宿主共用的纯规则：读取设置、协议分类、绕过列表合并、SDK 上游的 `proxyEnv`、CLI 环境的叠加、日志摘要、脱敏名单 |
| `src/main/services/proxy/ProxyConfig.ts`、`src/main/index.ts` | `engineProxyFrom` / `getEngineProxySetting`（含应急开关）/ `onEngineProxyChange`（值变了且停稳 0.5 秒才通知）/ `seedProxySettings`（启动时先读出已保存的设置） |
| `DshHostSupervisor.ts`、`dshHostModelSource.ts`、`dshHostProtocol.ts` | `configure.proxy`；`updateProxy` 发 `{ host: 'proxy' }`；Main 订阅改动 |
| `src/dsh-host/lib/hostProxy.ts`（新）、`host.ts` | `HostProxyInstaller`：用 DSH 的 `installProxyFromEnvironment` 安装，先卸后装、串行、相同值不重装；收到 `configure` 后、组合之前等它装好 |
| `src/dsh-host/package.json` 与 lock、`scripts/dsh-host-build-lib.mjs` | `@deepseek-ai/dsh-http-proxy` 改为直接依赖（原来是 peer），列进 `HOST_DEPENDENCIES`、`HOST_EXTERNALS` 与必带文件；lock 只改两处 |
| `ClaudeSdkProcessTransport.ts`、`claudeSdkEngine.ts`、`src/shared/claudeSdkEngine.ts` | `host.secret.proxy`，之后每次改动发 `host.proxy`；宿主退出即退订 |
| `src/claude-sdk-host/authProxy.ts`、`host.ts`、`hostConfig.ts` | 上游 agent 按设置建，`setProxy` 换 agent；407 映射（第 3 节第 13 条）；CLI 环境按第 7 条叠加；代理密码进脱敏名单 |
| `NetworkSettings.tsx`、`src/shared/i18n.ts` | 第 3 节第 11 条的说明与 SOCKS 提示 |
| 测试工具 | `src/dsh-host/tools/lib/testProxy.ts`（新：带认证的 HTTP 代理，转发与 `CONNECT` 都支持，`*.invalid` 解析到本机）；`src/dsh-host/tools/proxy-probe.ts`（新）；`host-probe.ts` 加 `proxy` 场景；假网关加 `P1-ENVDUMP-PWSH` |

### 7.2 结果

- 三套 tsc 0 错；biome 无报错。
- 新增与改动的单测全部通过：`src/shared/__tests__/hostProxy.test.ts` 13 条；`src/dsh-host/lib/__tests__/hostProxy.test.ts` 9 条，其中一条装真的 DSH 包、真发请求经测试代理（开、凭据、子进程环境、关、用户自己写的协议保留、SOCKS）；`authProxy.test.ts` 新增 6 条（开 / 关 / 再开、错误密码、SOCKS、回环网关、启动环境的 `NO_PROXY`、应急开关下按 K-3）；`hostConfig.test.ts` 新增 4 条；`ProxyConfig.test.ts` 8 条；`DshHostSupervisor.test.ts` 新增 1 条；`claudeSdkProcessTransport.test.ts` 新增 2 条。
- 相关 vitest（`src/shared`、`src/dsh-host/lib`、`src/dsh-host/bridge`、`src/claude-sdk-host`、`src/main/services/{agent-host,proxy,updater,terminal}`、设置页组件、两个打包脚本测试，共 214 个文件）：失败的只有 8 个文件里的 16 条，与本改动无关，在基线 `89d82245` 上同样失败（Linux 专用的 systemd、Windows 上的符号链接与 8.3 路径等）。本改动引起的只有 `chatEngineDshOnly.test.ts` 钉住 SDK 传输构造参数的那条静态断言，已随改动更新。
- 真 DSH 宿主（`node src/dsh-host/tools/proxy-probe.ts`，Windows）：11 项全过。开（带凭据）：一轮 P0-STREAM 完成，模型请求经测试代理、认证通过；pwsh 工具的环境里 `HTTPS_PROXY` 是产品代理、`NODE_USE_ENV_PROXY=1`；运行中切到关：下一轮的请求没有到测试代理；SOCKS：宿主告警，请求不经代理；再开（同一个宿主进程，没有重启）：一轮完成且经代理；stderr 不含密码。
- 真 SDK 宿主（`host-probe.ts <gateway> <workspace> proxy`，Windows，随包 CLI）：9 项全过。开（带凭据）：CC-TEXT 完成，请求经测试代理且认证通过；CLI 的 Bash 工具看到产品代理与 `NODE_USE_ENV_PROXY=1`；切到关：请求直连失败（本机为 `ECONNRESET`，见第 1 节第 8 条），测试代理无新记录，随后停掉这轮；再开：一轮完成且经代理；stderr 不含密码。

### 7.3 没有验证的

- Linux（用户的另一台开发机）。
- 打包产物：只跑了打包脚本的单测（含 esbuild 构建 host.js 与 externals 检查），没有出安装包。
- 设置页的新说明与 SOCKS 提示没有在界面里看过，只过了 tsc、词条覆盖与「无硬编码中文」测试。
- `https:` 网关经 `CONNECT` 的整条链：测试代理支持 `CONNECT`，但假网关只有 http；undici 与 Node 对 `https:` 目标都走 `CONNECT`（读代码）。
- 真实的公司代理、`https://` 形式的代理地址、做 TLS 拦截的代理（要 `NODE_EXTRA_CA_CERTS`）。
