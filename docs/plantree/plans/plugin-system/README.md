# PiLab 插件机制

分支 `feat/mobile-remote`（插件机制是手机远程的前置，先在同一分支上做）。阶段清单见 [tasks.md](tasks.md)。

## 1. 需求（用户 2026-10-23）

- 手机远程（issue #25）是**额外功能，不打进主体安装包**，做成可安装的插件。
- 插件机制要有**标准接口**，以后别的额外功能也按同一格式开发。

## 2. 参考：PI-Desktop 的插件系统

PI-Desktop（`/home/pi/code/PI-Desktop`）已经做完一套并跑稳了，照它来，只在下面 §3 标出的地方改：

| 方面 | PI-Desktop 的做法 | 出处 |
|---|---|---|
| 总体 | 目录形式的插件包，`manifest.json` 声明贡献点和权限；本地安装、启用、停用、卸载；权限默认拒绝 | ADR 0005 |
| 包格式 | `.piplug`，就是根目录带 `manifest.json` 的 zip；安装前查路径穿越和超大包 | ADR 0007 |
| 运行隔离 | 每个插件一个独立进程，经 RPC 调宿主 API；调用依次过 API 白名单、权限检查、审计日志；插件崩了不拖垮宿主，挂起的调用以 `PLUGIN_CRASHED` 失败 | ADR 0008 |
| 常驻服务 | 服务在 manifest 里声明（每插件最多 4 个），由宿主决定何时启停；崩溃后整插件重启，退避 1s→30s、最多 5 次，状态显示在插件页 | ADR 0040 |
| 市场 | 先做本地插件，市场延后 | ADR 0006 |
| 清单字段 | `schemaVersion`、`id`、`version`、`engines`、`main`、`contributes`（commands / settings / services / views …）、`permissions` | `docs/spec/07-plugins/02-plugin-manifest-schema.md` |
| 开发包 | `packages/plugin-sdk`（类型与 API）、`packages/plugin-devkit`（打包与校验） | |

## 3. 我们的做法（与 PI-Desktop 的差别）

1. **插件进程用打包的 Node 运行时启动，不用 Electron `utilityProcess`。** 加密机上 `utilityProcess` 读文件拿到的是密文、跑命令报 `Bad file descriptor`；打包的 Node（`resources/node-runtime`）是已经验证能用的载体，DSH 宿主也是这么起的。插件进程和 DSH 宿主同一种起法、同一种 RPC 桥。
2. **第一版只做两个贡献点**：`settings`（宿主按声明画设置表单）和 `services`（常驻服务）。命令、面板、agent 工具、主题等以后按需加，清单格式先留位。
3. **宿主 API 按需开放**，第一批只开手机远程要用的：

   | 命名空间 | 内容 | 权限 |
   |---|---|---|
   | `chat` | 会话列表、调用对话处理函数（白名单内）、订阅运行事件、会话实时快照与按序号补发 | `chat.read`、`chat.control` |
   | `sessionControl` | 代表插件的客户端接管 / 交还某个对话（见 §4） | `chat.control` |
   | `settings` | 读写本插件自己的设置；声明为 `secret` 的设置用 `safeStorage` 加密保存（落地时把原计划的单独 `secrets` 接口并进了这里） | 无（只能碰自己的） |
   | `status` | 在插件页和标题栏状态里报告「已连接 / 断开 / 出错」 | 无 |

   网络访问不经宿主 API：插件进程本身是 Node，可以直接连网；在清单里用 `net` 声明要连的地址，安装时展示给用户。和 PI-Desktop 一样，第一版不做进程级的沙箱，权限只管宿主 API 这一面。
4. **包格式** `.pilabplug`（zip + 根目录 `manifest.json`），校验规则照 ADR 0007。`engines.pilab` 写兼容的 PiLab 版本范围，`apiVersion` 写用的宿主 API 版本，不兼容就拒绝加载并说明原因。
5. **管理入口**：设置里新增「插件」页：从文件安装、启用 / 停用、卸载、查看权限和网络声明、查看服务状态。没有安装任何插件的用户，除了这一页什么都看不到，也不起任何插件进程。
6. **开发标准**：插件 SDK 是 `src/shared/plugins/`（清单 schema 与校验、宿主 API 类型、帧协议、版本号），打包脚本 `scripts/pack-plugin.ts`，示例插件 `plugins/example-hello/`，开发说明 `docs/plugins/developing-plugins.md`。仓库不是 pnpm 工作区，所以没有另起 `packages/plugin-sdk`；以后要单独发布 SDK 时再搬。
7. **签名、市场、自动更新**：先不做。内部使用，从文件安装。

## 4. 对话接管（属于主体，不属于插件）

用户 2026-10-23 选定「按对话接管」：同一个对话同一时间只能由一端操作。

- 主进程给每个对话记一个「操作方」：桌面，或某个插件代表的客户端（带一个给人看的名字，如「网页 · iPhone」）。
- 发消息、插话、回答权限和提问卡、切模型 / 强度 / 档位、压缩、回退、分叉等**改动类调用**，不是操作方发来的一律拒绝（`session_controlled_elsewhere`）。**停止**两边都能按，用来应急。读历史、看面板等只读调用两边都行。
- 非操作方照常看到进度，输入框变成只读，显示「正在 网页 · iPhone 上使用 · 接管」；点「接管」就把操作权拿回来，对方那边同样变成只读。
- 默认操作方是桌面；插件的客户端第一次对某个对话做改动类操作前要先接管。
- 放在主体里的原因：它管的是桌面自己的输入框，也是以后任何「从外面驱动对话」的插件共用的规则。

## 5. 手机远程变成什么

- 插件 `pilab.remote-access`：一个常驻服务，连到中转服务器，把网页发来的调用经宿主 API 转成对话调用，把运行事件推回去；设置项是中转地址、接入口令、启用开关。
- 中转服务器 `pilab-relay` 和网页本来就是单独部署的程序，不进安装包。
- 阶段 1 已经做的两件事留在主体里，作为宿主 API 的底子：对话处理和窗口解绑（`invokeChatHandler`）、会话实时日志（`SessionLiveJournal`）。日志改成「有插件声明了 `chat.read` 并启用时才记录」，没装插件的用户不付任何代价。

## 6. 可以并行的分组

| 组 | 内容 | 拥有的文件 | 依赖 |
|---|---|---|---|
| A 插件运行时 | 安装与校验、插件进程（打包 Node 启动）、RPC 桥、宿主 API 分发（白名单 → 权限 → 审计）、常驻服务监管 | `src/main/services/plugins/`、`src/main/ipc/plugins.ts`、`src/plugin-host/`、`src/shared/plugins/` | 无 |
| B 插件页 | 设置里的「插件」页：安装、启停、卸载、权限、服务状态；按 `settings` 声明画表单 | `src/renderer/components/settings/plugins/` | A 的 IPC 接口（先定接口再并行） |
| C 对话接管 | 主进程操作方记录与改动类调用拦截；桌面输入框只读与「接管」 | `src/main/services/chat/sessionControl.ts`、`src/main/ipc/chat.ts`、输入框相关组件 | 无 |
| D 中转与网页 | `pilab-relay`、网页端 | `packages/pilab-relay/`、`src/mobile/`（网页入口） | 网关帧协议（先定协议再并行） |
| E 手机远程插件 | `pilab.remote-access` | `plugins/remote-access/` | A、C 完成 |

接缝：A 与 C 都要动 `chat` 宿主 API 的权限（`chat.control` 要先过接管检查）——由 C 提供 `sessionControl` 的判断函数，A 只调用不实现。

## 7. 待现场验证

- **加密机上的插件文件**：插件包由 Electron 主进程解压写盘，由打包的 `node.exe` 读取执行。两个进程是否都在加密驱动的白名单里、写出来的文件另一方能否读成明文，只有上机才能确认（ARD D11 的教训：载体决定兼容性）。如果读到密文，改成由插件宿主程序（`node.exe`）自己解压。
- **打包后的插件宿主程序**：`resources/plugin-host/pluginHost.mjs` 已加进 `afterPack` 和 Windows 的去加密处理，要跟下一个 Windows 测试包一起看。
