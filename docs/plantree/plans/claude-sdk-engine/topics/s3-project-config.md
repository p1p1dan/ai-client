# S-3 项目级配置与 key 隔离（设计）

Role: topic（S-3 方案，2026-10-16）。上位：[README](../README.md) §1 裁决 5、12，§3，§4 S-3，§7.4 #2。工作方式同 [S-2](s2-permission-modes.md)：一般问题按推荐方案自行决定，自主决定列在 §1.2 供审阅。

## 0 范围

| 项 | 来源 | 本任务做什么 |
|---|---|---|
| key 隔离 | 裁决 12、§7.4 #2 | 网关 key 不进 CLI 及其子进程（Bash、仓库 hooks、MCP）的环境；Main 交给宿主时也不经环境变量。先于放开 hooks 做完 |
| 设置来源 | 裁决 5、§3 | `settingSources: ['project','local']`；临时（未绑定项目）会话不读 |
| 放开锁定 | 裁决 5 | 去掉 `managedSettings` 对仓库 hooks 与 allow 规则的锁定 |
| 项目 allow 规则 | 裁决 5 | 实测 CLI 只在"工作区受信任"后才用 `.claude/settings.json` 的 allow 规则（§4.2）：宿主为绑定的项目目录声明信任 |
| 插件市场 | 新发现 | 受信任的工作区会在启动时去拉仓库声明的插件市场（git+ssh 直连 GitHub，不走网关与代理）：封住 |
| CLAUDE.md | 裁决 5、§3 | 项目的 CLAUDE.md、`.claude/rules`、`CLAUDE.local.md` 进上下文；用户级 `~/.claude` 不读（§3 不做项） |

不做：在界面上展示 hook 的执行（hook 照官方行为生效，界面无变化）；用户级 `~/.claude`（技能、用户 CLAUDE.md）；PiLab 自己的信任提示框（见 P-3）。

## 1 决定

### 1.1 用户裁决

- 裁决 5：项目的 CLAUDE.md、hooks、allow 规则都生效，不再锁仓库的 hooks 与 allow。
- 裁决 12：不让 key 进子进程；先试文件描述符，Windows 上不行就做本机鉴权代理；S-3 放开 hooks 之前做完。

### 1.2 自主决定（待审阅）

| # | 决定 | 理由 |
|---|---|---|
| K-1 | **本机鉴权代理**：宿主在 `127.0.0.1` 上开一个只对本会话的 HTTP 代理；CLI 拿到的 `ANTHROPIC_BASE_URL` 是代理地址，`ANTHROPIC_API_KEY` 是每个 CLI 进程一个的随机令牌（`sk-pilab-session-<48 位十六进制>`）；代理核对令牌（常数时间比较）后换成真 key 转发给网关，流式原样回传。两者都钉在 flag 层，仓库换不掉 | 文件描述符一路在 Windows 上不通：2.1.300 只读 `/proc/self/fd/N`，没有 Windows 分支（§4.1）；代理在实测里 Bash、PowerShell、hooks、会话记录、配置目录都看不到真 key，长会话、`/compact`、子代理、中途打断都正常 |
| K-2 | **代理只放行 CLI 用到的接口**：`POST /v1/messages` 与 `POST /v1/messages/count_tokens`（带查询串），其他一律 404；令牌不对回 401（`x-should-retry: false`） | 子进程拿到令牌也只能在本会话存活期间调同一个网关的对话接口（实测 curl 可以），收窄面 |
| K-3 | **代理的上游自己守代理与证书设置**：上游请求用 `proxyEnv` 的 Agent（继承到的 `HTTP(S)_PROXY`、`NO_PROXY`），证书用宿主继承到的 `NODE_EXTRA_CA_CERTS`；连不上网关时回 502（Anthropic 格式的错误体），交给现有的失败映射 | 原来这些由 CLI 自己按钉住的变量做；改走代理后由宿主做 |
| K-4 | **`NO_PROXY` 必含回环**：CLI 的环境与 flag 层都在继承到的值后补 `127.0.0.1,localhost,::1` | 实测 CLI 对回环地址不自动绕过代理：没有这一条，公司代理会收到明文令牌，回合失败（§4.1） |
| K-5 | **Main 交 key 改走 IPC**：宿主启动后由 Main 发第一条 IPC 消息 `{ type: 'host.secret', apiKey }`，宿主收到前不处理 RPC；去掉 `AICLIENT_CLAUDE_SDK_API_KEY` 环境变量 | Linux 上 `/proc/<pid>/environ` 一直留着进程的初始环境（宿主与 CLI 都是），子进程同用户可读；IPC 通道 Main 本来就开着 |
| K-6 | 令牌加进宿主的脱敏名单；每个宿主进程（即每个对话的一次运行）一个令牌，宿主退出代理随之关闭 | 令牌虽不是 key，但能在会话存活期间花 key；初稿想在 CLI 每次重启时换令牌，收益小（同一对话内）而要让 CLI 环境随启动重算，未做 |
| P-1 | **设置来源**：绑定项目的会话 `['project','local']`；未绑定（临时）会话 `[]`，沿用共享规则 `resolveSettingSources`（决策 008 第 5 条：不受信任的检出不读 project/local） | 裁决 5；临时目录是应用自建的空目录 |
| P-2 | **去掉 `managedSettings` 锁**（`allowManagedPermissionRulesOnly`、`allowManagedHooksOnly`），实验开关 `AICLIENT_CLAUDE_SDK_REPO_POLICY` 一并删掉 | 裁决 5 |
| P-3 | **绑定项目的会话由宿主声明工作区受信任**（SDK 选项 `workspaceTrust`，按会话的 cwd）；不另做 PiLab 的信任提示框 | 不声明信任时项目 allow 规则一律被忽略（§4.2），裁决 5 落空；用户在 PiLab 里打开项目，就是把它当自己的项目用（与 DSH 对绑定项目 `projectTrusted: true` 一致）。信任会记进应用私有配置目录 |
| P-4 | **封住插件市场**：`managedSettings` 只放 `strictKnownMarketplaces: []`（policy 层；§4.3 实测唯一管用、又不关 hooks 与 allow 的设置） | 受信任后 CLI 启动就去拉，git+ssh 直连外网，不经网关、不经代理；目录源的插件还会当场加载并跑它的 hooks |
| P-5 | **用户级 `~/.claude` 不读**：flag 层 `claudeMdExcludes` 排除 `<主目录>/.claude/**`，写法按 cwd 的拼写（盘符大小写一致，正斜杠） | §3 不做项；CLI 沿 cwd 往上逐级读 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules`，工作区在主目录下时会读到用户自己的 `~/.claude/CLAUDE.md` |
| P-6 | 其余照官方行为：项目外祖先目录的 CLAUDE.md 照读；`settings.local.json` 的 allow 规则不需信任就生效；仓库可禁用自动模式或跳过权限确认（切档被拒时按 S-2 A-5 提示）；`.mcp.json` 仍不读（`strictMcpConfig`） | 裁决 5 "照官方行为" |
| P-7 | **主目录的各种写法都排除**：cwd 自身及每一级祖先目录，只要与主目录是同一目录（大小写不同，或经软链、目录联接、`subst` 盘符到达），按 cwd 里的拼写各排除一次；主目录原样也排除一次。目录名里的 glob 语法字符（`()[]{}*?+@`）写成单字符的方括号类，只匹配它自己 | CLI 按 cwd 的拼写往上找，只排一种写法会漏；Windows 用户名可以带括号，原样写进 glob 会被当成语法：探针实测主目录叫 `pilab-fakehome (s3)` 时，不转义则排除失效 |
| P-8 | §3.2 的"外连检查"改成看结果：仓库声明的市场是目录源，其插件带一个 SessionStart hook 留标记；`projcfg` 在同一次运行里重启一次宿主（CLI 从受信任工作区的第二次启动起才去拉），再断言标记不存在、配置目录 `plugins/` 下没有这个市场的登记 | 抓进程的网络连接与平台相关、容易漏；目录源会当场加载插件并跑它的 hook，是最直接的可观测结果，且能做变异检查（去掉封锁即失败）。不用"预置信任记录"让第一次启动就拉：那样会盖住 P-3 的检查（信任记录本身就让 allow 规则生效） |
| P-9 | **计划模式里 allow 规则放不过改动**：宿主的进程内 PreToolUse 回调在计划模式里把任何代理的命令（Bash、PowerShell）送回 `canUseTool` 拒绝，除非命令在 DSH 计划模式的探索语法内（`isExplorationCommand`：`git status/diff/log/show/…`、`ls`、`cat`、`head`、`rg`、`grep` 等，不含重定向与命令替换）；主代理的文件改动 CLI 在计划模式里先于 allow 规则就拒了（探针实测：`Edit(...)` 规则匹配的写入照样被拒），不另加。回调的 `ask` 也压过仓库 hook 的 `allow` | 审查确认（读 2.1.300 的代码）：规则放行 Bash 先于任何计划模式检查，项目、本机或"本会话允许"的 `Bash(npm run:*)` 在计划模式里会直接执行，S-2 A-2 与说明里"计划模式由 PiLab 拒绝改动"落空；S-2 A-20 对子代理已是同一立场，DSH 的计划模式也用同一套探索语法。代价：语法以外的只读命令（如 `find`、`git branch`）计划模式里也被拒，原来 CLI 认作只读会放行。另一做法是照官方行为放行（裁决 5 的字面），未采用，待审阅 |
| P-10 | **绑定到主目录本身的会话按临时会话开**（不读 project、local，不声明信任） | 此时项目层的 `.claude/settings*.json` 就是用户自己的 `~/.claude/settings*.json`（PiLab 改了配置目录，CLI 认不出它是用户层），用户的 hooks、allow 规则会当成项目的生效，违背 §0"用户级不读" |
| P-11 | 探针用的替身主目录（`AICLIENT_CLAUDE_SDK_HOME`）是**追加**排除，不顶替真主目录 | 探针工作区在 `%TEMP%` 下，也在真主目录下；顶替会让开发者自己的 `~/.claude/CLAUDE.md` 进请求 |

## 2 契约

- 宿主进程的启动环境去掉 `AICLIENT_CLAUDE_SDK_API_KEY`；Main 在宿主进程起来后经 IPC 先发 `{ type: 'host.secret', apiKey: string }`，再发 RPC。宿主等不到（超时 10 s）就以启动失败退出（Main 侧映射为 `claude_sdk_host_unavailable`，新会话退回 DSH）。
- 宿主 → CLI：`ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>`、`ANTHROPIC_API_KEY=<令牌>`，都在 CLI 环境里并钉在 flag 层；`NO_PROXY` 含回环。
- `AICLIENT_CLAUDE_SDK_SETTING_SOURCES` 的缺省值改为 `project,local`（开发覆盖保留，S-4 收紧）。

## 3 验证（先定断言，再改代码）

### 3.1 单测

1. 代理：令牌不对 401；路径不在名单 404；转发时去掉令牌、换上真 key，其他头与请求体原样；流式回包原样；客户端断开时上游请求也断；连不上上游回 502（Anthropic 格式）。
2. CLI 环境与 flag 层：`ANTHROPIC_API_KEY` 是令牌不是 key；`ANTHROPIC_BASE_URL` 是代理；`NO_PROXY` 含 `127.0.0.1,localhost,::1` 且保留继承到的项；真 key 不出现在 CLI 的环境、命令行参数与 flag 层里。
3. Main 侧：宿主启动环境里没有 key；第一条 IPC 是 `host.secret`；宿主没回应（超时）映射为 `claude_sdk_host_unavailable`。
4. 设置：绑定会话 `['project','local']`、未绑定 `[]`；没有 `managedSettings` 锁；`workspaceTrust` 只给绑定会话；`claudeMdExcludes` 的写法按 cwd 拼写。

### 3.2 探针（只用本机假网关）

| 场景 | 断言 |
|---|---|
| `keyiso` | Bash 的 `env`/`set`、PowerShell 的环境、仓库 PreToolUse hook 记下的环境里都没有真 key；网关收到的仍是真 key（`CC-ENV` 摘要）；会话记录与配置目录里没有真 key |
| `projcfg` | 测试仓库带 `.claude/settings.json`（allow `Bash(touch:*)` + PreToolUse hook 写标记文件）、`CLAUDE.md`（暗号）、`.claude/rules/x.md`、`CLAUDE.local.md`、`settings.local.json`：`touch` 不出卡；hook 标记文件存在；暗号出现在首个请求里（`CC-ENV` 之外再加一条回显暗号的假网关标记）；仓库禁用跳过权限确认时切档被拒并给出原因 |
| `projcfg-home` | 工作区放在一个带 `.claude/CLAUDE.md` 的"假主目录"下（宿主按 `AICLIENT_CLAUDE_SDK_HOME` 覆盖主目录）：其中的暗号不进请求 |
| `projcfg-scratch` | 未绑定会话：上面的规则、hook、CLAUDE.md 都不生效 |
| 外连检查 | 带插件市场声明的受信任仓库：整个回合里 claude.exe 及其子进程没有非回环连接 |
| 原有 | 流程 34 条、`errors`、`repoenv`、S-2 的各档场景照常全过 |

## 4 实测

### 4.1 key 隔离（2026-10-16，假网关）

- 文件描述符：`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3` 加第 4 路管道，Windows 上 CLI 报 "Not logged in"：它只在描述符是 socket 时直接读，否则读 `/proc/self/fd/3`，Windows 上读不到；Node 在 Windows 上也传不了 socket 作 stdio。
- 现状（key 在环境里）：Bash 的 `env`/`set`、PowerShell 子进程、PreToolUse hook 都看得到 key，打印出来后还会写进会话记录。
- 仓库能换 key：`.claude/settings.json` 的 `env.ANTHROPIC_API_KEY` 今天就生效（网关收到仓库的 key）；在 flag 层钉 `''` 会连宿主给的一起清掉。代理方案里钉令牌即可。
- 代理（46 行原型）：子进程、hooks、配置目录都只见令牌；14 个请求（含 `/compact`、子代理）都带真 key 到达网关；流式节奏不变；中途打断时上游请求随之中断。子进程拿令牌经代理可以发请求（会话存活期间）。
- 代理与公司代理：CLI 对 `http://127.0.0.1` 也走 `HTTPS_PROXY`/`HTTP_PROXY`，只有 `NO_PROXY` 含 `127.0.0.1` 时才绕过（只写 `localhost` 不够）。Node 24 的 `http.request` 缺省不读代理变量，要 `proxyEnv` 或 `NODE_USE_ENV_PROXY=1`。
- Main → 宿主：IPC 消息与额外管道都可行；IPC 更简单（传输层本来就开着 `ipc`）。

### 4.2 项目设置（2026-10-16，假网关）

- 未受信任的工作区：`.claude/settings.json` 的 allow 规则全被丢弃（stderr 有一行提示）；`settings.local.json` 的 allow 规则照样生效；仓库 hooks（project 与 local）照样执行；仓库的 `disableAutoMode`、`disableBypassPermissionsMode` 照样生效。
- 受信任：SDK 选项 `workspaceTrust: { accepted: true, directory }`（不在类型里）或在私有 `.claude.json` 预置 `hasTrustDialogAccepted`；信任按目录精确匹配，信任父目录不算。
- allow 规则写法：`Write`、`Edit(**)`、`Edit(<glob>)`、`Bash(touch:*)` 等有效；`Write(**)` 无效；只读命令（如 `echo hello`）本来就不问。
- PreToolUse hook 回 `allow` 可以跳过卡；回 `ask` 时卡的原因是 hook 给的原因。
- 指令文件：`['project','local']` 下，仓库的 CLAUDE.md、`.claude/CLAUDE.md`、`.claude/rules/*.md`、`CLAUDE.local.md` 与所有祖先目录的同类文件，作为一条 system-reminder 放进首条用户消息；子目录的 CLAUDE.md 在读到该目录的文件时再加进来。`claudeMdExcludes` 区分大小写，按 cwd 的拼写匹配（盘符大小写要一致；正、反斜杠都行；`/c/...` 不行）。
- `settingSources: []`：什么都不读。

### 4.3 插件市场（2026-10-16，假网关，市场源全指向回环）

- 受信任的工作区：第一次会话不拉（启动安装早于信任落盘）；之后每次启动都按仓库 `.claude/settings.json` 的 `extraKnownMarketplaces` 去装市场：git 源 `git clone`（ssh 源直接起 ssh，不理代理）、URL 源下载、目录源当场加载其插件（插件自带的 hooks 也跑了）。不受信任时不拉。
- 能封住的只有 **policy 层 `managedSettings: { strictKnownMarketplaces: [] }`**（SDK 的过滤保留这一项）：不拉、不装、不加载任何仓库声明的插件；仓库 hooks、项目 allow 规则、项目的技能/命令/子代理照常；`.mcp.json` 仍不读。已登记过的市场也不再加载。
- 不管用的：flag 层的 `strictKnownMarketplaces`、`blockedMarketplaces`（只认 policy 层）；flag 层 `enabledPlugins` 全关（不加载但照拉）；policy 层 `blockedMarketplaces`（`file://` 的 git 源仍被克隆）；`CLAUDE_CODE_SIMPLE`/`CLAUDE_CODE_SAFE_MODE`（连 hooks 一起关）。
- 副作用：只要传了 `managedSettings`，CLI 就加一个内置插件 `cc-plugin-sec-default@builtin`（现状的锁也会带上它）。
- 机器上有 IT 下发的 policy 层时，按 SDK 文档我们的 `managedSettings` 会被丢掉（除非管理员设 `parentSettingsBehavior: 'merge'`）；未实测。

所以 P-4 定为：`managedSettings` 只放 `strictKnownMarketplaces: []`。

### 4.4 放开之后（2026-10-16，假网关）

- 仓库 `.claude/settings.json` 的 `permissions.defaultMode`（试了 `bypassPermissions`、`acceptEdits`）盖不过宿主启动时给的模式：`mode-manual` 在两种仓库里都照样出卡。仓库换不了会话的起始档。
- 信任记在应用私有配置目录的 `.claude.json`（该工作目录一项 `hasTrustDialogAccepted: true`）；宿主每次启动都声明，不依赖这份记录。

## 5 实现记录

### 5.1 key 隔离（2026-10-16，先于项目设置单独提交）

- 宿主 `authProxy.ts`：`127.0.0.1:0` 上的代理，令牌常数时间比较，只转发 `POST /v1/messages`、`POST /v1/messages/count_tokens` 与 `GET /v1/models[/<id>]`，换上真 key 后与路由的路径前缀拼接，双向流式，客户端断开即断上游，连不上上游回 502（Anthropic 格式）；上游用 `proxyEnv` 的 Agent。
- 宿主 `host.ts`：不再读 key 的环境变量；等 Main 的 `host.secret`（10 秒，等不到就退出），之前到的 RPC 先存着；起代理后用 `hostConfig.ts` 组 CLI 配置（地址与令牌，flag 层也钉这两项）；退出时关代理。
- `cliEnvironment.ts`：`NO_PROXY`（两种拼写）补回环；flag 层可钉会话令牌。
- Main：`openClaudeSdkTransport` 去掉 key 的环境变量；`ClaudeSdkProcessTransport` 起进程后先发 `host.secret`。
- 验证：代理 8 条、CLI 环境 22 条、`buildHostConfig` 3 条、传输 1 条（真子进程：第一条消息是密钥、环境里没有 key）单测；变异检查：把真 key 交给 CLI 时 `buildHostConfig` 的用例失败。探针 `keyiso`（Bash 的 `env`、PowerShell 的环境、配置目录、宿主 stderr 都没有 key，网关照样收到 key）与原有全部场景通过。探针本身对"CLI 进程初始环境里有没有 key"看不到（flag 层的令牌钉值会盖住子进程看到的值），这一项由 `buildHostConfig` 的单测守。

### 5.2 项目设置（2026-10-16）

- 宿主 `sdkSessionRuntime.ts`：
  - `settingSources` 由共享规则 `resolveSettingSources` 按信任收窄（`launchSettingSources`，P-1）；绑定到主目录本身的会话按临时会话开（`isUserHomeDir`，P-10）。
  - `managedSettings` 只放 `strictKnownMarketplaces: []`（P-2、P-4）；删去 `trustRepoPolicy` 与实验开关 `AICLIENT_CLAUDE_SDK_REPO_POLICY`。
  - 绑定会话声明 `workspaceTrust`（P-3）。
  - flag 层 `claudeMdExcludes` 由 `userClaudeDirExcludes` 算（P-5、P-7、P-11）。
  - 进程内 PreToolUse 回调改名 `planModeGuard`，在 S-2 A-20 之外加上 P-9。
- `hostConfig.ts`、`host.ts`：探针专用的 `AICLIENT_CLAUDE_SDK_HOME`（追加排除，P-11），头注释列出。
- Main：`AICLIENT_CLAUDE_SDK_SETTING_SOURCES` 缺省改为 `project,local`。
- 假网关：`CC-ECHO` 回显请求的系统提示与用户消息里的 `CANARY-…` 词。
- 探针：`projcfg` 11 条（指令文件、项目与本机 allow 规则、无规则仍出卡、计划模式 P-9、hook 跑且只见令牌、仓库禁用跳过权限确认、重启宿主后市场与插件不拉不装）；`projcfg-home` 4 条（替身主目录，Windows 上 cwd 的盘符大小写翻转；另用带括号的主目录名跑一遍）；`projcfg-scratch` 9 条。
- 单测：S-3 一组 8 条（Windows 跑 7 条，非 Windows 的拼写用例在 Linux 上跑）、计划模式回调 1 条、CLI 启动 1 条、`buildHostConfig` 1 条。
- 变异检查：
  - 单测 11 处，各自至少一条用例失败：去掉 glob 转义、去掉按祖先目录的排除、不解析主目录或祖先目录、不折叠大小写、去掉主目录守卫、替身顶替真主目录、不按信任收窄来源、总是或从不声明信任、信任声明给错目录、`managedSettings` 加回锁。
  - 探针 6 处，各自有检查失败：去掉市场封锁（同一次运行内的第二次启动即失败）、去掉 glob 转义、去掉按祖先目录的排除、不按信任收窄来源、不声明信任、计划模式回调不管命令。
- 回归：三套 tsc；原有探针 flow 35、keyiso 与各档 33、mode-plan-refused 3、errors 与 repoenv 33 全过；全量 vitest 的失败文件与基线一致（`chatShiki` 一次 5 秒超时，单独重跑 23 条全过）。
- 实测补记见 §4.4。

### 5.3 审查（2026-10-16）

三个维度（宿主正确性与安全、测试与探针、设计符合度），共 19 条发现，每条由独立复核员尝试推翻。确认或采纳的都已修：

1. 计划模式里，仓库 allow 规则（或仓库 hook 的 allow）放行的命令直接执行，不经宿主的计划模式拒绝：P-9。
2. 绑定到主目录本身的会话，会把用户自己的 `~/.claude/settings*.json` 当项目设置读：P-10。
3. 主目录名里的 glob 语法字符（Windows 用户名可带括号）让排除失效：P-7 的转义。
4. 探针的"什么都没读"检查在回显回合失败、或网关不认 `CC-ECHO` 时会空过：先断言回显到了。
5. 单测的 cwd 与配置目录是同一个目录，查不出两者用混：分开。
6. 采纳但复核认为不算缺陷的：市场检查改为一次运行内重启宿主（P-8）、替身主目录改为追加（P-11）、经链接到达主目录的写法（P-7）、宿主头注释、链接用例在 macOS 上的临时目录。

被推翻的：IT 下发的策略层会丢掉 `managedSettings`（§4.3 已记，转入 README §10.2）；`CC-ECHO` 会数到恢复会话里的旧暗号（探针不这么用）；探针夹具会覆盖真仓库的文件（文档要求空工作区）；界面的档位说明没提规则（与 S-2 的"本会话允许"同理，说明写默认行为）。
