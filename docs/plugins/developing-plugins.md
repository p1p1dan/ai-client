# 开发 PiLab 插件

插件是 PiLab 主体之外的功能，单独打包、单独安装，不进安装包。方案与取舍见 [plugin-system 计划](../plantree/plans/plugin-system/README.md)；示例插件在 [`plugins/example-hello/`](../../plugins/example-hello/)。

## 1. 插件长什么样

一个目录，根上有 `manifest.json` 和入口文件：

```text
my-plugin/
  manifest.json
  main.mjs        # 入口，ES 模块，导出 activate()
```

打包成 `.pilabplug`（就是 zip）：

```bash
node scripts/pack-plugin.ts plugins/my-plugin        # 生成 <id>-<version>.pilabplug
```

用户在 设置 → 插件 里「从文件安装」。装好后默认**停用**，用户看过权限再启用。

## 2. manifest.json（schema 1）

格式和校验规则在 `src/shared/plugins/manifest.ts`，安装和打包用的是同一套。

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 固定 `1` |
| `id` | 是 | 小写、点分，如 `pilab.remote-access`；装好后不能改 |
| `name` / `version` | 是 | 显示名；`x.y.z` 版本 |
| `description` / `author` | 否 | 插件页显示 |
| `apiVersion` | 是 | 用的宿主 API 版本，现在是 `1`；PiLab 不支持就拒绝加载 |
| `main` | 是 | 包内入口文件的相对路径 |
| `permissions` | 否 | `chat.read`（看对话）、`chat.control`（改对话）；不声明就调不了对应接口 |
| `net.hosts` | 否 | 要连的地址，安装时给用户看（第一版不强制） |
| `contributes.settings` | 否 | 设置项：`key`、`title`、`type`（`string` / `number` / `boolean` / `select`）、`default`、`options`、`secret`（加密保存，界面上不回显） |
| `contributes.services` | 否 | 常驻服务，最多 4 个：`id`、`title`、`autoRestart`（默认 `true`） |

## 3. 入口与 API

```js
/** @param {import('../../src/shared/plugins/api.ts').PilabPluginApi} pilab */
export function activate(pilab) {
  pilab.services.register('worker', { start: async () => {}, stop: async () => {} });
}
export function deactivate() {}
```

`activate` 要在 15 秒内返回，只做登记，不要在这里连网络：长期运行的事情放进服务。服务的 `start` / `stop` 由 PiLab 调用，各 5 秒时限。

API 全部在 `src/shared/plugins/api.ts`，每个调用都经过 PiLab 检查权限，改动类调用记进审计日志（`<数据目录>/plugins/audit.jsonl`）：

| 接口 | 权限 | 用途 |
|---|---|---|
| `chat.invoke(clientId, channel, payload)` | 读：`chat.read`；改：`chat.control` | 以某个客户端的身份调用对话功能。能调哪些见 `src/shared/plugins/chatChannels.ts` |
| `chat.releaseClient(clientId)` | 任一 | 客户端断开：它占着的对话和操作权都还回去 |
| `chat.onEvent(listener)` | `chat.read` | 和桌面窗口看到的同一串运行事件，带序号 |
| `chat.snapshot(sessionId)` / `chat.since(cursor)` | `chat.read` | 中途接入补这一轮；断线重连补漏掉的 |
| `sessionControl.get / acquire / onChange` | 读：任一；接管：`chat.control` | 对话同一时间只能由一端改动；客户端要先接管 |
| `settings.get / set / onChange` | 无 | 只能读写自己的设置 |
| `status.set({ state, text })` | 无 | 在插件页显示一行状态 |
| `log.info / warn / error` | 无 | 写进 PiLab 的日志 |

`clientId` 是插件自己给每个客户端起的名字（比如每台连上来的手机一个）。PiLab 给每个客户端单独的身份，对话接管、权限归属都按它算。

## 4. 运行环境

- 每个插件一个独立进程，用安装包自带的 Node（24.x）运行，不是 Electron。插件崩溃不影响 PiLab；退出后 1、2、4、8、16 秒各重试一次，5 次后停在「失败」。连续运行满 60 秒就重新计数。
- 环境变量只有 `PATH`、`HOME`、临时目录、语言、代理等少数几个，**拿不到** PiLab 的模型密钥。
- 工作目录是插件自己的数据目录（`pilab.dataDir`），更新时保留，卸载时删除。
- 第一版只管住宿主 API 这一面，插件进程本身能用 Node 的全部能力（文件、网络）。只装自己信得过的插件。
- 依赖要事先打进入口文件（比如用 esbuild 打成一个 `.mjs`），PiLab 不会替插件装依赖。

## 5. 开发时

- 在仓库里运行未打包的 PiLab 时，插件宿主程序直接跑 `src/plugin-host/pluginHost.ts`；打包后跑 `resources/plugin-host/pluginHost.mjs`（`pnpm build:plugin-host`）。
- `src/main/services/plugins/__tests__/pluginManager.test.ts` 里有用真插件进程跑的例子，示例插件也在其中测试。
