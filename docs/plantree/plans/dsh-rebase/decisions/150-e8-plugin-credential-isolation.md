# 决策 150：E8 的结论——插件与宿主凭据同权；缓解选项待拍板

日期：2026-10-07。**状态：自主决定，待用户审批。**第 2 节的缓解方案**待用户拍板**，本次不实现。

依据：

- [证据：E8 插件与凭据的隔离边界（2026-10-07）](../evidence/e8-plugin-credential-isolation-2026-10-07.md)——14 项判定全部通过的实测；
- [决策 034](034-per-request-credential-pull.md)（按请求拉 key，第 4 条只覆盖了工具子进程）、[决策 085](085-model-plan-wiring-implementation-choices.md)（宿主侧接线与 KEY-CANARY）；
- [P1-10 / P1-16 扩展方案 分片 04](../topics/p1-10-p1-16-extensions/04-changes-and-tests.md) §3 的 E8、[分片 03](../topics/p1-10-p1-16-extensions/03-design.md) §6.1 / §6.2；
- [决策 015](015-probe-plugin-out-of-product.md)（探针代码不进产品）、[决策 023](023-no-dotenv-private-cwd-home-patch-overlay.md)、[决策 042](042-approval-in-pre-execute-plugin.md)。

分支 `feat/dsh-p0-probe`，基线 `32a7acee`。本决策**不含任何产品行为改动**：落地的只有测试专用的实验脚本与测试插件。

## 1 结论（事实，已实测）

1. **凭据提供者能认出调用方，但现状不按调用方限制。** Cordis 的 traceable 代理把服务方法里的 `this.ctx` 换成调用方的 context，所以 `aiclient-credentials` 读 `this.ctx.fiber` 就能拿到调用方的行 id 与包名（实测 `llm-pi-ai`、`credential-probe`、`aiclient-credentials` 三种调用方各自可辨）。现状只按引用名判定，所以一个白名单里的第三方插件调 `ctx.credentials.resolve(<计划里的引用名>)` 就拿到了 key 原文。
2. **这种按调用方的限制可以被绕过。** `ctx.credentials[Symbol.for('cordis.original')]` 返回裸的提供者实例，用它调用时身份显示成凭据行自己；插件还能直接猴子补丁裸实例上的 `resolve`（本实验正是这么观察的）。
3. **插件能读到 IPC 上的凭据应答。** 同进程插件挂 `process.on('message')` 就看到 Main 发来的 `credential-result` 明文 `value`，包括宿主为模型请求自己拉的那一次；`process.prependListener` 排在 host.ts 自己的监听者之前。**决策 034 第 4 条的覆盖面要补一句**：当时只查了工具子进程会不会继承 IPC 句柄（Linux 上不会），同进程插件根本不需要继承。
4. **更进一步：插件可以自助拉 key。** 包一层 `process.send` 就能读到外发请求里的 `configure` nonce，然后伪造 `{host:'credential', id, ref, nonce}`；`DshCredentialBroker` 的三道检查（通道、nonce、引用名）全部成立，它分不出这次请求不是宿主发的。也就是说即使把凭据行改成只服务 LLM 路由，插件仍能从 Main 直接拿到 key。
5. **现状的两道闸确实有效，继续保留**：非计划引用名一律 `undefined` 且不往 Main 发请求；写接口全部以 `CREDENTIALS_READ_ONLY` 拒绝。但「只认计划里的引用名」不构成信息门槛——插件能从组合里读到 `llm-pi-ai` 的 `providers[*].apiKeyEnv`，实测自己发现了引用名。
6. **所以方案 分片 03 §6.1 的结论在凭据这一面也成立且更强**：白名单插件与宿主同权，运行期兜底挡不住「白名单里的代码作恶」，**审查是唯一的硬防线**。进程外隔离不在 DSH 的模型里，也不在 P1 范围。

## 2 缓解选项（**待用户拍板**，本次不实现）

| # | 做法 | 挡住什么 | 代价与风险 |
|---|---|---|---|
| A | **只加审查判据与静态守卫，运行期不动**（推荐） | 什么都不在运行期挡；把「插件碰凭据/IPC/猴子补丁」变成审查必拒项，并用测试把判据钉住 | 约 0.5 人日：审查单加三条（第 3 节）、一个静态扫描单测扫白名单插件源码里的 `ctx.credentials` / `cordis.original` / `process.on('message')` / `process.send` / `prependListener`。行为零改动。缺点：对作恶代码无运行期约束 |
| B | **凭据行按调用方放行**（A 之外可叠加） | 挡住「顺手调一下」的插件与第三方库的环境探测；不挡 ① 裸服务绕过 ② 猴子补丁 ③ 伪造 IPC 请求 | 约 1 人日：`CredentialPort.resolve` 多一个 caller 参数，`plugin.ts` 从 `this.ctx.fiber` 取行 id，只放行 `llm-pi-ai`（与未来别的 llm 行）。风险：**行为改动**——DSH 升级或换 llm 行时会静默拒绝导致「模型用不了」；要配一个显式的 fail-loud 诊断。单测易写（port 层纯函数） |
| C | **凭据应答换专用通道**（不走 `process` 级 IPC） | 挡住「被动旁听」（Q2 的第 3 条）；不挡插件自己向该通道发请求（它能从宿主内存里拿到句柄），也不挡 B 挡不住的那三条 | 约 2～3 人日：Main 与宿主之间多一条 socket / 额外 fd，Windows 命名管道差异，加一个启动失败面（决策 034 已经把「宿主没有 IPC 就不拉 key」写进行为）。收益只有「被动旁听」一项，而主动路径照旧，**性价比最低** |
| D | **key 根本不进宿主：Main 本地反代**（决策 034 当年的备选，决策 037 也提到） | 两个问题一次性解决：宿主与插件都看不到 key | 大工程（Main 搬运全部 LLM 流量，含流式与重试），顺带解决 UA 问题。**超出 P1 范围**，只作为长期方向记录 |
| E | **不让第三方插件进产品**（白名单只留我方行） | 彻底解决，但等于放弃 P1-10 的插件能力 | 产品取舍，不是工程取舍；与「基于 DSH 二开、复用生态插件」的方向冲突 |

**推荐：A 现在做，B 作为纵深防御可选，C 不做，D 记为长期方向。** 理由：实测证明 B 和 C 都挡不住主动路径（第 1 节第 2、4 条），把它们当成安全边界会给出错误的安全感；而 A 的代价接近零，且正好把审查这道「唯一的硬防线」变得可检查。

## 3 建议加进审查单的判据（属于 A，**待拍板**）

分片 03 §6.2 第 5、6 条已经点名 `ctx.credentials`、`process.send` / `process.on('message')`，建议补成可判定的三条：

1. **凭据**：包内任何位置出现 `ctx.credentials`（含 `ctx.get('credentials')`）即**拒绝**，除非插件有自己的凭据需求并单独走审批（P1 不提供）。
2. **宿主 IPC**：出现 `process.on('message')` / `process.prependListener('message')` / `process.send` / `process.removeAllListeners('message')` 即**拒绝**——宿主的 IPC 通道是 Main 与 bridge 的私有通道，插件没有正当理由碰它。
3. **逃出 Cordis 代理与猴子补丁**：出现 `Symbol.for('cordis.original')`、对 `ctx.get(...)` 返回对象的属性赋值、对 `Module` / 全局对象 / `process` 的属性赋值即**拒绝**。

另建议在 §6.1 的表格里把「凭据」一行的「能否按调用方限制见实验 E8」改成实测结论：「调用方可辨但限制可绕过；应答在 `process` 级 IPC 上对同进程插件可见；靠审查」。

## 4 本次落地了什么（不含产品行为）

- `src/dsh-host/tools/e8-plugin-credential-isolation.ts`（新，约 300 行）：E8 驱动。打包态宿主 + 假网关 + 一次性假 key，14 项判定，输出 JSON 报告，可重复运行，自带 800 MB 内存门槛。
- `src/dsh-host/tools/credential-probe-plugin/`（新，约 310 行）：测试专用插件包 `@aiclient-test/dsh-credential-probe`（一行 `credential-probe`）。**不在产品 bundle，也不在白名单**；只被驱动装进 `/var/tmp` 的脚手架副本。它只记 digest 与长度，不记 key 原文，不记 nonce 原文。
- `src/dsh-host/tools/lib/experiment-host.ts`：`startExperimentHost` 多返回一个 `served`（Main 侧那半边的 `ServedPlan`），这样驱动能核对 Main 实际收到的凭据请求。E1 / E3 不受影响。

## 5 取舍与存疑

- **为什么用打包态的 `out-dsh-host` 副本，而不是源码态宿主**：插件加载要走产品路径（装进宿主 `node_modules` + manifest 的 `plugins` 条目 + `AICLIENT_DSH_PLUGINS`），打包态才是真实形态；也顺便验证了打包态不读 profile / home 的 patch 层（决策 110）。代价：依赖 `out-dsh-host` 已构建（脚本会报错提示），而开发机不跑整包构建。
- **为什么让测试插件猴子补丁我方凭据行**：这是唯一能在真宿主里看到「提供者收到什么上下文」的办法，而且与 Q1 的第三问（更靠前的监听者 / 猴子补丁）是同一件事。包装只记录、原样转调，宿主行为不变（回合照常跑完，退出码 0）。
- **存疑 1**：Windows 上同一套结论是否成立（`process.send` / IPC 监听者行为、句柄继承），留给 P1-14 的 CI。
- **存疑 2**：本次没有实测「插件改写或吞掉凭据应答」。能做到几乎是必然（同一个消息对象引用、公开的 `removeAllListeners`），但没跑就不当事实写。
- **存疑 3**：`dsh-office-tools` 与 `dsh-tool-ask-user` 这两个试点插件是否真的碰这些 API，本实验没查，归审查单第 5 条逐包看。

## 补记（2026-10-07，E8-A，[决策 153](153-e8-a-plugin-review-guard-choices.md)）

第 2 节按[决策 149](149-user-rulings-2026-10-07.md) 第 4 条选了 A，已落地（代码 `350aa1b1`）。

- 第 3 节的三条写进了分片 03 §6.2 第 5 项，标为「必拒」；§6.1「凭据」一行改成实测结论。
- 静态守卫 `scripts/__tests__/dsh-plugin-review-guard.test.mjs` 扫白名单插件与产品 bundle 挂载的非我方包，命中即失败。
- 存疑 3 有了答案：`dsh-office-tools@1.0.4` 与 `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2` 都零命中。

近似边界与盲区见决策 153 第 5、6 节。
