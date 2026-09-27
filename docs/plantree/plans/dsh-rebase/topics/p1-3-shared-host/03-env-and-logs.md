# P1-3 分片 03 · 环境策略与日志清理

Role: detail shard。上位：[P1-3 方案](../p1-3-shared-host.md)。回答调研问题 6（环境策略）和问题 7（DSH 日志清理）。行号约定同[分片 01](01-current-state.md)。

## 1 宿主环境

### 1.1 事实

- **宿主的环境就是工具环境的底子。**
  - DSH 启动子进程时，从宿主的 `process.env` 出发，只去掉名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和 `DSH_*`，代理变量按父进程的设置补齐（`dsh-subprocess:25-56`）。
  - `dsh-shell-env` 只能注入 `DSH_*` 形式的事实（`dsh-shell-env:64`），没有办法给工具单独加别的变量。
  - 所以「宿主用一份环境、工具用另一份」做不到。
- **P1-1 现状是 17 项白名单**，另加两项开发网关变量（`devDshEngine.ts:27-49`）。P1-1 方案沿用它，单测逐键核对，并且明确不含 `ANTHROPIC_*` / `OPENAI_*`（[inventory](../p1-1-engine-cutover/inventory.md) 第 156 行）。
- **1.0.x 的做法**：
  - worker 的环境 = Main 的环境去掉 `ELECTRON_RUN_AS_NODE`，再加上托管的 pi 变量（`PiWorkerProcess.ts:45-60`）。
  - 工具拿到的是 worker 的全部环境（`src/runtime/host/worker.ts:62-68`、`exec.ts:631`）。
  - macOS 上，Main 启动时会并入登录 shell 的环境（`index.ts:37-45`）。
- **pi-ai 会自己找凭据**：路由没有配 `apiKeyEnv` 时，pi-ai 会从环境里自己找（`dsh-llm-pi-ai:2559-2566`），读的就是启动快照（`:2082-2090`）。宿主环境里如果有用户自己的 `ANTHROPIC_API_KEY`，一条漏配的路由就会拿它去打我方网关。
- **systemd 收容**：
  - 不带 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` 时，DSH 退回较弱的收容方式，告警一次，而且每次调用 bash 都同步探测一遍 `systemd-run`，耗时 5～8 ms（`dsh-subprocess-local:73-95,1384-1404`；`p0-6…md:254-256`）。
  - 带上这两个变量后，走 systemd scope：第一次深度探测约 42 ms，之后每次调用做一次 `systemctl --user show`，8～12 ms（`dsh-subprocess-local:101-113`；`p0-6…md:257-259`）。

### 1.2 推荐规则（方案 D6 选 B）

| 步骤 | 内容 | 理由 |
|---|---|---|
| 起点 | Main 的 `process.env`（macOS 上已经并入登录 shell 的环境） | 与 1.0.x 工具看到的环境对等：`SSH_AUTH_SOCK`、`JAVA_HOME`、`GOPATH`、代理、`DISPLAY`、`XDG_RUNTIME_DIR` 都在 |
| 剔除敏感名 | `/KEY\|PASSWORD\|SECRET\|TOKEN/i`，与 DSH 给工具洗名用的同一条规则 | 工具本来就拿不到这些；宿主也拿不到，就堵住了 pi-ai 自找凭据这条路 |
| 剔除运行时注入 | `NODE_OPTIONS`、`NODE_PATH`、`ELECTRON_*` | `NODE_OPTIONS` 可以往宿主里 `--require` 代码、开调试端口，或者带上随包 node 24 不认的参数，导致起不来；`NODE_PATH` 会让模块解析越出宿主目录 |
| 剔除应用内部项 | `AICLIENT_*`、`DSH_*`、`npm_*`、`VITE_*` | 这些是开关和开发启动的杂项，需要的在下一步显式补 |
| 显式设置 | `DSH_HOME`、`DSH_TELEMETRY_DISABLED=1`、`NARB_NATIVE_CACHE_DIR`；未打包时加 `AICLIENT_DSH_GATEWAY_URL/KEY`（P1-5 删除） | 开发用的网关 key 会被敏感名规则剔除，所以必须在这一步补回 |
| Windows | 变量名按大小写不敏感去重，写法同 `childEnv`（`runner-launch-*.js:694-707`） | 防止 `Path` 与 `PATH` 并存 |

- **代价**：
  - 工具里不再有 `NODE_OPTIONS`。用户靠它调构建内存的，要改在命令里写。
  - Main 的杂项变量会进工具。1.0.x 本来也是这样。
- **选项 A（严格白名单）**要维护一张越写越长的清单（XDG、显示、SSH、代理、各语言工具链……），漏一项，用户的命令就会在 DSH 下莫名失败。
- **测试**：分 posix 与 win32，对剔除和补齐逐键做金样本比对；再用一条静态守卫钉住敏感名规则与 DSH 的 `SENSITIVE_ENV_PATTERN` 一致。

### 1.3 `XDG_RUNTIME_DIR` 与 DBus

- 选 B 时，这两个变量随继承自动带过去；选 A 就要显式加上。
- 带上之后走 systemd scope，收容更强，`weaker process-tree containment` 告警消失。每次 bash 的同步开销，两条路径差不多（`p0-6…md:337-339` 推荐交给宿主）。
- 没有 user systemd 的环境（WSL、容器）照样退回较弱的收容方式，不影响可用性。

### 1.4 `NARB_NATIVE_CACHE_DIR`

- 取 `~/.pilab/<profile>/dsh-native-cache`（P1-2 分片 05 的 D2）。P0-4 的 B3 形态在 Windows CI 上已经通过（`p0-4…md:42`）。
- 不设置时，默认放在 `%LOCALAPPDATA%\node-addon-native-custom-loader\native-cache` 或 `/tmp/node-addon-native-custom-loader-<uid>`（`node-addon-native-custom-loader/lib/index.js:34-43`）。前者与其他应用共用，后者可能被系统清掉。
- 缓存目录按版本分开（`:86`），升级后旧版本的目录会一直留着。宿主启动时可以顺手删掉非当前版本的目录，量很小，列为可选。

### 1.5 宿主的启动目录与 `TMPDIR`

- **cwd 用私有空目录** `~/.pilab/<profile>/dsh-host-cwd`（0700）。P1-1 目前用的是 `DSH_HOME`。换掉的理由：
  - 我们已经不读 `.env`（§2），但以后 DSH 某个版本可能在别处读 cwd 下的 `.env`；
  - `PATH` 里的相对路径是相对 `process.cwd()` 解析的（`dsh-subprocess-local:1351-1355`）；
  - `profileContext.cwd` 取的是 cwd（`host.ts:112`）；
  - 沙箱在拿不到会话 cwd 时会退回到 `process.cwd()`（P1-1 inventory §4.5）。
- **`TMPDIR` 保持用户自己的**，因为工具依赖它。DSH 会在里面写 `dsh-spill-*`、`dsh-subprocess-*` 和编译缓存（`p0-2…md:263`）。宿主崩溃后留下的残留不在 P1-3 处理。

## 2 `.env`：读取点与关闭办法

- **读取点**：在安装的全部 `@deepseek-ai/*` 包里搜 `loadEnvFile` 和 `".env"`，只有 `dsh-app-boot` 命中。
  - `loadEnv`（`dsh-app-boot:3298-3304`）用 `process.loadEnvFile` 读，**我方宿主没有调用它**。
  - `readEnvLayer`（`:3398-3420`）解析文件，拒绝只能来自启动环境的变量名：`PATH`、`HOME`、`NODE_OPTIONS`、代理（home 层除外），以及 `DSH_*`、`XDG_*` 等前缀（`:3306-3376`）。其余变量全部接受。
  - `loadLayeredEnv`（`:3432-3457`）依次读 `<cwd>/.env`（项目层）和 `$DSH_HOME/.env`（用户层，home 与 cwd 相同时只读一次）。进程里还没有的变量会**直接写进 `process.env`**（`:3437-3440`），然后返回分层快照。
- **我方宿主在 `host.ts:105` 调用了它**，并把快照提供给插件（`:211`）。值已经进了 `process.env`，所以会一路传到工具，这就是 P0-2 金丝雀实验的结果（`p0-2…md:245-255`）。
- **消费方**：
  - `dsh-credentials-local:429,438`：区分进程层与项目层、用户层；
  - `dsh-llm-pi-ai:2089,2563`；
  - deepseek 相关的行，已经关闭。
- **关闭办法**（不改 DSH 包）：
  - 把 `host.ts:105` 换成 `createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])`（`dsh-launch-environment:30-54`，从 `:82` 导出）。这样项目层和用户层都不存在，`process.env` 也不会被改。
  - 再加上 §1.5 的私有空 cwd。
  - `$DSH_HOME/.env` 如果存在，在宿主 stderr 里告警一次。
- **验证**：
  - 静态守卫：`host.ts` 里不出现 `loadLayeredEnv`、`loadEnv`、`loadEnvFile`。
  - 集成测试或 bridge-smoke：沿用 P0-2 的办法，在宿主 cwd 和 `DSH_HOME` 下各放一个 `.env` 金丝雀，断言 bash 工具的环境里没有它们。
- **代价**：`$DSH_HOME/.env` 里的代理设置不再生效（`:3371-3376`）。产品有自己的代理设置，与 P1-5 的网关一起考虑。

## 3 `$DSH_HOME/cordis.patch.yml`（用户层）

- **组合顺序**，后面的覆盖前面的：
  1. 各 bundle 的补丁；
  2. profile 层 `profiles/aiclient/cordis.patch.yml`，由 `loadProfileDirectory` 读取，除非传 `userLayer:false`（`dsh-app-boot:945-946`）；
  3. home 层 `$DSH_HOME/cordis.patch.yml`，`readProfilePatches` 无条件读取（`:1027`）；
  4. `context.overlays`（`:1028`）；
  5. 遥测补丁（`:1030-1031`）。
- **profile 层必须保留**：plugin-manager 安装插件后，靠它激活插件（P0-2），去留由 P1-10 管。
- **home 层**：`DSH_HOME` 是私有目录（决策 008），只有用户本人或本机恶意程序能写。现有的兜底是启动审计：只要组合出禁用的行，或者隐私相关的行没有关，宿主就明确失败（`host.ts:130-149`）。
- **推荐做法**：
  - 保留 DSH 的读取行为；
  - 把 `REQUIRED_DISABLED` 里的各行以 `disabled: true` 放进 `overlays`，排在 home 层之后，让用户层无法重新打开它们；
  - 保留审计，它仍然能拦住 `webserver` / `frontend-static` 这类新增的行；
  - 文件存在时告警。
- **不选**：
  - 自己重写一遍不含 home 层的 `readProfilePatches`：DSH 每次升级都得重新核对；
  - 文件一存在就拒绝启动：DSH 哪天自己生成这个文件，就会把引擎弄成不可用。

## 4 DSH 日志清理

### 4.1 现状

- **产品没有删除入口。**
  - 归档只是一个标志。索引行只在三种情况下被删：创建失败回滚（`chat.ts:334-358`）、导入回滚、超过 2000 行时截断（先截已归档的，`SessionIndexService.ts:752-766`）。
  - 截断时注明「会话文件都不动」（`:747-750`）。1.0.x 的 pi 会话文件从不删除。
  - 唯一的清扫是分叉暂存文件（`WorkerManager.ts:628-710`）：只看索引点名的目录，只删带标记、又没有被任何行引用的文件。本方案照搬这两条规则。
- **DSH 侧**：
  - 没有删除 API（`dsh-session-persistence-jsonl/README.md:163`）。
  - 布局：`sessions/--<cwd>--/<转义后的 id>/session.v4.jsonl.zstd` 加 `session.lock`（`README:54-74`；P1-1 inventory §4.2）。
  - 桩：`$DSH_HOME/aiclient-sessions/<id>.dsh.json`（决策 006）。
  - 另有 `storages/` 下的投影缓存。
- **垃圾从哪来**：
  1. 决策 007：已经 flush 了，但 Main 侧创建失败，索引行被回滚，只剩一个 header 的孤儿会话。
  2. 截断出索引的行：有内容的孤儿会话。
  3. 桩和会话互相找不到对方。
  4. 已删父会话下的子代理会话（推断，布局待核）。
  5. 崩溃残留：POSIX 上的锁文件（无害，**不能删**）和 `TMPDIR` 里的临时目录。

### 4.2 规则（方案 D8 选 A）

- **引用集合**，以下都算：
  - 所有索引行（包括已归档的）的 `runtimeIdentity` 指向的桩里写的 `dshSessionId`；
  - 每一行按约定推出的 `aiclient-<逻辑 id>`，桩丢失时靠它反推（决策 006 第 3 条）；
  - 当前所有通道正在用的会话。
- **可删的候选**必须同时满足：
  - id 以 `aiclient-` 开头，别的一律不碰；
  - 不在引用集合里；
  - header 创建时间早于 24 h；
  - 只有 header，或者一个事件都没有。
- **子会话**：父会话被删，它的子代理会话一起删；被引用的会话，它的子会话也算被引用（推断）。
- **删除步骤**（在宿主里做）：
  1. `persistence.open(id, 'write')` 取内核锁；取不到说明有人占着，跳过；
  2. 关闭句柄；
  3. 删除整个会话目录；
  4. 如果有桩指向这个 id，删掉桩。
  - 只动 `sessions/` 和 `aiclient-sessions/` 两个目录。**绝不单独删 `session.lock`**：在 POSIX 上删锁文件等于放弃互斥（`README:164`）。
- **孤立的桩**：没有对应的会话目录、也没有索引行引用，满 24 h 就删。
- **有内容的孤儿会话**：默认保留，日志里记个数。以后如果要清，再议选项 B（宽限期后删）或 C（先进回收站、到期再删）。
- **归档的会话**：不删，它们可以恢复。

### 4.3 谁在什么时候清

- **执行者是宿主**：在 bridge 里加一个 `{host:'gc', claimed, graceMs}` 操作。宿主有 DSH 的路径推导（`persistence.list/stat`，README:82，返回字段是推断）和内核锁的实现，而且是唯一在用 `DSH_HOME` 的进程。
- **为什么不在 Main 启动时直接删**：
  - 判断「只有 header」要解 zstd；
  - Main 拿不到 DSH 的内核锁；
  - 目录名的转义规则是 DSH 内部的东西（`README:74`）。
- **时机**：每次运行只做一次，在第一次宿主 `ready`、恢复批次完成之后的第一个空闲时刻。Main 等索引加载完成后，算出引用集合发过去；宿主回删除计数，Main 记日志。
- **怎么保证不误删正在打开的会话**，三道防线：
  - 24 h 宽限期，挡住刚创建、索引还没写进去的会话；
  - 取锁检查，挡住任何活着的写者；
  - 单宿主不变式，保证不存在另一个宿主。
- **锁与崩溃残留**：
  - POSIX 的 `flock` 随进程死亡释放，锁文件留着也无害；Windows 的命名信号量没有文件，随进程释放。所以**锁本身不需要清**。
  - 唯一要防的是活着的旧宿主：由 supervisor 负责杀（分片 02 §3.3）。
  - Main 崩溃时恰好卡死的孤儿宿主，会一直表现为 `session_locked`，列为风险（方案 §7）。
