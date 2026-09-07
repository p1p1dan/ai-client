# 批次二实现证据 — F08 Pi 请求自定义 User-Agent

> 日期：2026-09-07 · 分支：`feat/model-catalog-admin`。

## 判定

落点已经存在，缺的只是接线：

- `PiManagedProviderDefinition.headers` 与它的校验（值必须 `$` 开头，即只能引用环境变量）
  在 D01 就位；
- `toPiModelsJson` 是**唯一**写 `models.json` 的函数，`writeAll` 的三条路径
  （新鲜远端 / 10 分钟内缓存复写 / stale-cache 回退）全部经过它。

所以注入点选在 `toPiModelsJson` 内部而不是三个调用点：调用点注入要写三遍，
而且第四条路径一旦出现就会漏。

## 改动

| 文件 | 内容 |
|---|---|
| `shared/piModelConfig.ts` | `PI_USER_AGENT_ENV` = `AICLIENT_PI_USER_AGENT`、`PI_USER_AGENT_PRODUCT` = `claude-cli-pilab`、`PI_USER_AGENT_HEADER`、`piUserAgent(version)` |
| `main/services/piModelConfig/index.ts` | `resolveManagedPiWorkerEnv` 注入 `piUserAgent(app.getVersion())`；PTY 环境**不剥离**该键 |
| `main/services/piModelConfig/configValidation.ts` | `toPiModelsJson` 为每个 provider 写 `headers['User-Agent'] = '$AICLIENT_PI_USER_AGENT'` |

### 三个决定

1. **写引用不写字面量。** `validateProvider` 拒绝任何非 `$` 开头的 header 值，
   注入必须落在同一条规则里而不是成为它的例外；同时升级后的 App 不必重写可能不再同步的配置，
   就能改正自己的 UA。这也直接满足验收「不通过类型逃逸绕过配置校验」。
2. **管理端自带的 `User-Agent` 优先。** 理由同 `resolveProviderApiKey`：
   管理站显式写下的是决定，我们的只是默认值。比较**大小写不敏感**——HTTP header 名本就如此，
   写死 `User-Agent` 而配置里是 `user-agent` 会发出两份，谁生效交给传输层决定。
3. **PTY 保留该变量。** borrow 目录和 opt-in 列表被剥离是因为真实 pi CLI 不读它们；
   这个变量恰恰是 pi 自己读的（从它加载的同一份 `models.json` 的 `headers` 里），
   所以 TUI 会话应当和 worker 会话一样表明身份。

产品名不带 OS/arch：pi 默认的 `pi (win32 10.0.26100; x64)` 标识的是 CLI 与宿主系统，
而这正是网关不该看到的——区分「App 的请求」和「CLI 的请求」就是覆盖它的目的。

## 测试

- `PiModelConfigService.test.ts` +4：三条写入路径都带 header（每次先删掉 `models.json` 再触发，
  确认是这一次写的）；写的是环境引用且能被校验器原样回读；管理端其他 header 保留；
  管理端自带的 `User-Agent`（两种大小写）不被覆盖。
- `piWorkerEnv.test.ts` +4：两种凭据模式都带版本号；PTY 也带；空版本不产生尾随斜杠；
  值不以 `pi ` 开头、不含平台/架构字样。

## 执行过的命令

| 命令 | 结果 |
|---|---|
| `npx vitest run src/main/services/piModelConfig/__tests__ --maxWorkers=1 --no-file-parallelism` | 2 文件 / 40 项通过 |
| `npx vitest run src/main/services/agent-host/__tests__ src/main/services/terminal/__tests__ src/main/ipc/__tests__ --maxWorkers=1 --no-file-parallelism` | 27 文件 / 286 项通过；`PiTuiPty.test.ts` 加载失败 |
| `NODE_OPTIONS=--max-old-space-size=1200 npx tsc --noEmit` | 通过 |
| `npx biome check .` | 983 文件，0 error |

`PiTuiPty.test.ts` 的失败是 `node-pty` 原生模块未安装（`prebuilds/linux-x64/pty.node` 缺失），
与本改动无关——它是[设置清单计划](../../settings-cleanup/implementation-status.md)已记录的四个
环境相关失败之一。

## 未验证项

1. **真实 HTTP 请求头**：验收要求「测试可以捕获最终 HTTP 请求头」。
   本轮证明的是**配置链路**——`models.json` 里有引用、环境里有值。
   最终发出的头由 pi 自己拼装，捕获它需要跑起 Worker 并拦截出站请求，本机未做。
2. **`app.getVersion()` 的真实取值**：测试里 electron 被 mock 为 `9.9.9-test`。
   真实版本号来自打包产物，未在打包环境验证。
