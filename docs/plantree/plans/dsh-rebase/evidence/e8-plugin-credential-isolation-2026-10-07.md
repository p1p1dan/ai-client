# 证据：E8 开工前实验——插件与凭据的隔离边界（2026-10-07）

Role: evidence。上位：[P1-10 / P1-16 扩展方案 分片 04](../topics/p1-10-p1-16-extensions/04-changes-and-tests.md) §3 的 E8（服务于 P1-5 与 §4.5 安全）、[分片 03](../topics/p1-10-p1-16-extensions/03-design.md) §6.1 的「凭据」一行；验证[决策 034](../decisions/034-per-request-credential-pull.md)（第 4 条只覆盖了工具子进程）与[决策 085](../decisions/085-model-plan-wiring-implementation-choices.md) 的假设。结论与缓解选项见[决策 150](../decisions/150-e8-plugin-credential-isolation.md)。

**结论：14 项判定全部通过（`pass: true`）。两个问题的答案是「能，但没有用」与「能」：**

- **Q1 凭据提供者能不能认出调用方**：**能拿到调用方身份**——Cordis 的 traceable 代理把服务方法的 `this.ctx` 换成**调用方**的 context，所以 `aiclient-credentials` 里读 `this.ctx.fiber` 就能拿到调用方的行 id（`llm-pi-ai` / `credential-probe` / `aiclient-credentials`）与包名。**但现状没有按调用方限制**：第三方插件直接调 `ctx.credentials.resolve(<计划里的引用名>)` 就拿到了假 key 的原文（digest 与下发的一致）。而且这种限制**可被绕过**：`ctx.credentials[Symbol.for('cordis.original')]` 能拿到裸的 `AiclientCredentials` 实例，用它调用时身份显示为凭据行自己。
- **Q2 插件能不能读到 IPC 上的凭据应答**：**能**。插件挂的 `process.on('message')`（以及 `process.prependListener`，实测排在 host.ts 自己的监听者**之前**）看到了 Main 发来的 `credential-result` 明文 `value`，包括**它没有发起过的那一次**（回合里 `llm-pi-ai` 自己拉的 key）。更进一步：插件包了 `process.send`，读到了外发请求里的 `configure` nonce，**自己伪造了一次 `{host:'credential', …}` 请求并被 Main 正常应答**——Main 的 `DshCredentialBroker` 看不出这次请求不是宿主发的。
- 顺带：现状的两道闸**确实生效**——非计划引用名一律 `undefined` 且**不往 Main 发请求**；`set` / `unset` / `modifyRecord` / `deleteRecord` 全部以 `CREDENTIALS_READ_ONLY` 拒绝。插件还能**自己发现计划里的引用名**（从 loader 的组合里读 `llm-pi-ai` 的 `providers[*].apiKeyEnv`），不需要别人告诉它。

## 1 怎么跑的

- 基线：worktree `.claude/worktrees/agent-a84b7bf3214a2affd`，分支 `feat/dsh-p0-probe`，HEAD `32a7acee`，加上本任务的实验脚本（无产品行为改动）。
- 环境：Linux 开发机（2 核 / 3.3 GB，跑前 `free -m` 可用 1959 MB，脚本自带 800 MB 门槛），随包 Node v24.18.0，DSH 钉 `0.1.7-rc.2`。
- 宿主形态：**打包态**（`ready.artifact.form = "packaged"`）。用 `out-dsh-host`（2026-10-07 03:37 构建，`gitCommit d26f4e6b`，是 HEAD 的祖先）的一份副本，按产品装插件的方式把测试插件装进去（`tools/lib/plugin-install.ts`：自己的 `node_modules` 目录 + 宿主 `package.json` 的依赖 + `dsh-host-manifest.json` 的 `plugins` 条目），再用 Main 自己的环境规则（`buildDshHostEnvironment`，`AICLIENT_DSH_PLUGINS` 打开）拉起。
- 模型：只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`（plan `dsh-p0-2`，场景 `P0-STREAM`）。key 是脚本自己造的一次性假 key `sk-e8-canary-<随机>`，由脚本充当 Main 应答；**没有用任何真实 provider、真实 key 或私人网关**。
- 命令（退出码 0）：

  ```bash
  cd src/dsh-host
  ../../out-node-runtime/node tools/e8-plugin-credential-isolation.ts --out /var/tmp/e8-report.json
  ```

  可重复运行；`--keep` 保留 `/var/tmp/aiclient-dsh-e8-<时间戳>/` 下的脚手架，`--host-dir` 换别的宿主构建产物。
- 脚本与测试插件（都是测试专用，不进产品 bundle，也不进白名单 `src/dsh-host/plugins/allowlist.json`）：
  - 驱动：`src/dsh-host/tools/e8-plugin-credential-isolation.ts`；
  - 测试插件：`src/dsh-host/tools/credential-probe-plugin/`（包名 `@aiclient-test/dsh-credential-probe`，一行 `credential-probe`）。
- 口径：插件**从不写 key 原文**，只写 sha256 digest 与长度，由驱动与自己下发的假 key 的 digest 比对；nonce 只记长度。报告 JSON 里 grep `sk-e8` 零命中。

### 测试插件做了什么

在宿主启动、它的行被组合起来时（`apply`）：

1. 记自己的身份（`ctx.fiber` / loader 条目）；
2. 挂两个 `message` 监听者（一个 `on`、一个 `prependListener`），包一层 `process.send`（原样透传）；
3. 从 loader 的组合里找计划的引用名（`providers[*].apiKeyEnv`）；
4. `ctx.credentials[Symbol.for('cordis.original')]` 取裸服务，并在裸实例上装一个**观察用**的 `resolve` 包装（记录调用方身份后原样转调，行为不变）——这一步既回答 Q1，也顺带证明了「插件能猴子补丁我方的行」；
5. 对**计划里的引用名**与**不在计划里的引用名**各调一次 `resolve`、`describe`，再把写接口（`set`/`unset`/`modifyRecord`/`deleteRecord`）与读记录接口（`readRecord`/`listRecords`）各试一次；
6. 用裸服务直接调一次 `resolve`（看调用方身份会变成什么）；
7. 用读到的 nonce 伪造一次 `{host:'credential', id: 991001, ref, nonce}` 并等应答。

然后驱动跑一个回合（`P0-STREAM`），让宿主**自己**为模型请求拉一次 key，看插件的监听者能不能看到这次应答。

## 2 结果

| 编号 | 判定 | 结果 |
|---|---|---|
| `pluginLoaded` | 插件按产品方式加载：`ready.plugins` 里 `state: loaded`、bundles 末位是它、组合审计无未激活行（`census: active 80 / disabled 21 / inactive []`） | 通过 |
| `probeSettled` | 插件的探测序列在 30 s 内写完 `probe-done` | 通过 |
| `planRefServedToThePlugin` | 第三方插件拿到了计划引用名背后的 key 原文（digest 与下发的一致，长度 37） | 通过（**现状不按调用方限制**） |
| `bogusRefUnserved` | 非计划引用名返回 `null`，而且 Main 侧**从未收到**该引用名的请求 | 通过 |
| `writeHalfRefused` | `set`/`unset`/`modifyRecord`/`deleteRecord` 全部以 `CREDENTIALS_READ_ONLY` 拒绝 | 通过 |
| `providerSeesCallerRow` | 提供者能读到调用方的行：插件自己的调用是 `credential-probe`，回合里的调用是 `llm-pi-ai` | 通过（**身份可得**） |
| `originalReached` | `Symbol.for('cordis.original')` 拿到了裸实例（`constructor: AiclientCredentials`） | 通过 |
| `callerHiddenViaOriginal` | 用裸实例调用时身份变成凭据行自己（`aiclient-credentials`），key 照样返回 | 通过（**身份判定可被绕过**） |
| `unaskedAnswerVisible` | 插件看到了**自己没发起过**的那次 `credential-result` 的明文 `value`（回合里 `llm-pi-ai` 拉的 key） | 通过（**Q2 = 能**） |
| `prependedListenerRunsFirst` | `process.listeners('message')[0]` 就是插件 prepend 的那个（共 4 个监听者） | 通过 |
| `nonceReadOffTheChannel` | 包过的 `process.send` 读到了外发请求里的 nonce（长度 24） | 通过 |
| `forgedRequestServed` | 插件伪造的请求（id 991001）被 Main 正常应答，digest 与下发的 key 一致 | 通过（**可自助拉 key**） |
| `turnFinished` | 回合正常跑完（`idle`），假网关收到 1 个请求 | 通过（这些动作没有弄坏宿主） |
| `cleanStop` | `shutdown` → `stopped` → 退出码 0 | 通过 |

报告 JSON：[`e8-plugin-credential-isolation-2026-10-07.data.json`](e8-plugin-credential-isolation-2026-10-07.data.json)（`scratch` 与日志路径已改成占位，其余原样；含 digest，不含任何值）。

### 2.1 提供者看到的调用方（原始记录）

```json
{"step":"row-active","caller":{"runtime":"credential-probe","uid":7,"row":"include:credential-probe","rowId":"credential-probe","package":"@aiclient-test/dsh-credential-probe"}}
{"step":"provider-saw-call","ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","caller":{"rowId":"credential-probe","package":"@aiclient-test/dsh-credential-probe","uid":7}}
{"step":"provider-saw-call","ref":"E8_REF_NOT_IN_THE_PLAN","caller":{"rowId":"credential-probe","package":"@aiclient-test/dsh-credential-probe","uid":7}}
{"step":"provider-saw-call","ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","caller":{"rowId":"aiclient-credentials","package":"@aiclient/dsh-app/credentials","uid":55}}
{"step":"provider-saw-call","ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","caller":{"rowId":"llm-pi-ai","package":"@deepseek-ai/dsh-llm-pi-ai","uid":60}}
```

四条依次是：插件调计划引用名、插件调非计划引用名、**插件用裸服务调**（身份显示成凭据行自己）、**回合里 `llm-pi-ai` 自己调**。前三条发生在启动期（相隔 0～91 ms），最后一条在回合里（插件的行激活后约 174 ms）。

为什么能看到调用方：Cordis 的 `createTraceable`（`@deepseek-ai/cordis/src/utils.ts:165`）给服务实例套一层代理，读属性时把 `tracker.property`（`'ctx'`）换成**调用者的 context**，方法再经 `createShadowMethod` 绑到这个 shadow 上。所以 `AiclientCredentials.resolve` 里的 `this.ctx` 是调用方的 context，`this.ctx.fiber` 是调用方的 fiber，`fiber.entry.options.id` 就是组合里的行 id。调用方走 `ctx.credentials`、`ctx.get('credentials')` 还是 `ctx.reflect.get('credentials')` 都一样。

绕过只要一行：`createTraceable` 的 get 陷阱里 `if (prop === symbols.original) return target`（同文件 175 行），`symbols.original === Symbol.for('cordis.original')`。拿到裸实例后 `this` 就是实例本身，`this.ctx` 回到凭据行自己的 context。

### 2.2 IPC 上看到了什么（原始记录，value 只记长度与 digest）

```json
{"step":"ipc-listeners","count":4,"oursFirst":true,"oursLast":true}
{"step":"send-patched","patched":true}
{"step":"ipc-outbound","id":1,"ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","nonceLength":24,"duringProbe":true}
{"step":"ipc-inbound","where":"prepended","id":1,"ok":true,"keys":["host","id","ok","value"],"value":{"length":37,"digest":"aa8e0c21…"}}
{"step":"forged-request","sent":true,"answered":true,"ok":true,"value":"string","length":37,"digest":"aa8e0c21…"}
{"step":"probe-done","inbound":6,"outbound":3}
{"step":"ipc-inbound","where":"prepended","id":3,"ok":true,"duringProbe":false,"value":{"length":37,"digest":"aa8e0c21…"}}
```

最后一条是回合里宿主自己拉的 key（`id: 3`，`duringProbe: false` 表示插件的探测早已结束，这次不是它发起的），digest 与下发的假 key 一致。

Main 侧（驱动扮演）收到的四次请求，除了 id 之外**完全一样**：

```json
[{"id":1,"ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","outcome":"served"},
 {"id":2,"ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","outcome":"served"},
 {"id":991001,"ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","outcome":"served"},
 {"id":3,"ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","outcome":"served"}]
```

其中 `id 1` 是插件经 `ctx.credentials` 拉的、`id 2` 是插件用裸服务拉的、`id 991001` 是插件**伪造**的、`id 3` 是回合里 `llm-pi-ai` 拉的。`DshCredentialBroker` 的三道检查（通道、nonce、引用名）对这四次都成立，所以它分不出谁是谁——Main 侧也没有调用方身份这一维。

### 2.3 现状仍然挡住的

```json
{"step":"resolve-bogus-ref","ref":"E8_REF_NOT_IN_THE_PLAN","value":null}
{"step":"describe","ref":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","described":{"configured":true,"source":"aiclient-main","writable":false}}
{"step":"describe","ref":"E8_REF_NOT_IN_THE_PLAN","described":{"configured":false,"writable":false}}
{"step":"write-half","operation":"set","refused":true,"code":"CREDENTIALS_READ_ONLY"}
{"step":"write-half","operation":"unset","refused":true,"code":"CREDENTIALS_READ_ONLY"}
{"step":"write-half","operation":"modifyRecord","refused":true,"code":"CREDENTIALS_READ_ONLY"}
{"step":"write-half","operation":"deleteRecord","refused":true,"code":"CREDENTIALS_READ_ONLY"}
{"step":"write-half","operation":"readRecord","refused":false,"returned":null}
{"step":"write-half","operation":"listRecords","refused":false,"returned":[]}
```

非计划引用名连请求都不发（第 2.2 节的 Main 侧列表里没有它），这与决策 034 第 2 条一致。

### 2.4 插件自己能发现引用名

```json
{"step":"refs","planRef":"AICLIENT_KEY_AICLIENT_GATEWAY_1964","discovered":{"refs":["AICLIENT_KEY_AICLIENT_GATEWAY_1964"]}}
```

`discovered` 是插件从 `ctx.get('loader').entries()` 里读 `llm-pi-ai` 行的 `config.providers[*].apiKeyEnv` 得到的，与驱动通过环境变量告诉它的一致。也就是说「只认计划里的引用名」不构成信息门槛：组合本身就把引用名摆在插件面前。

## 3 边界与未测

- **只在 Linux、只在打包态宿主上跑过一遍。** Windows 的 IPC 句柄继承与 `process.send` 行为留给 P1-14 的 CI（与决策 034 第 4 条同样的分工）。
- **没有测「插件改写 / 吞掉凭据应答」**：prepend 的监听者只观察、没有改消息，也没有删掉 host.ts 的监听者。能做到是显然的（Node 对同一事件的所有监听者都发同一个对象引用，`process.removeAllListeners('message')` 也是公开 API），但本次没有实测，写在这里避免把推断当事实。
- **没有测 `dsh-office-tools`、`dsh-tool-ask-user` 这两个试点插件**：它们是否真的碰这些 API，由审查单第 5 条逐包看，不是本实验的事。
- **没有测 MessagePort / 专用通道的替代方案**：缓解选项的可行性（决策 150 第 2 节）只做了代价估算，没有做原型。
- 本实验**没有改任何产品行为**；测试插件与驱动都在 `tools/` 下，`dsh-host-manifest.json` 的 `plugins` 条目只写进 `/var/tmp` 的脚手架副本。

## 4 转给谁

- P1-5：决策 034 第 4 条的覆盖面要补一句「同进程插件也能读到应答」；缓解选项见决策 150，等用户拍板。
- P1-10/P1-16：审查单（分片 03 §6.2 第 5、6 条）按决策 150 第 3 节补三条具体判据；分片 03 §6.1 的表格里「凭据」一行的「能否按调用方限制见实验 E8」可以换成结论。
