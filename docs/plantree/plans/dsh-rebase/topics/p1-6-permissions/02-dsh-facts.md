# P1-6 分片 02 · DSH 的权限与沙箱模型（`0.1.7-rc.2` 源码）

Role: detail shard。上位：[P1-6 方案](../p1-6-permissions.md)。回答调研问题 2，以及问题 5 里 DSH 那一侧的部分。路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，行号指当前装好的包。只读了源码和 README，没有起宿主；标「推断」的是读码得出的结论，没有实跑过。

## 1 dsh-base 里的组合

`dsh-base/cordis.patch.yml` 挂载的相关行如下：

| 行 | 作用 | 出处 |
|---|---|---|
| `sandbox` → `dsh-sandbox-local` | 各平台的进程沙箱 | `:225-226` |
| `sandbox-policy` | 默认档位 `DSH_PERMISSION_MODE ?? 'workspace-write'`（包自身的默认值是 `read-only`，`dsh-sandbox-policy/lib/index.js:102`）；回退根目录为 `process.cwd()` | `:228-232` |
| `bash-sandbox` / `tool-bash` | 非 Windows 平台挂载 | `:234-238`、`:266-268` |
| `pwsh-sandbox` / `tool-pwsh` | 只在 Windows 挂载。所以 **Windows 上只有 `pwsh` 工具**（P0-4 证据第 76 行） | `:240-242`、`:270-272` |
| `approval` → `dsh-user-approval` | 策略 `ask`；只有 `DSH_PERMISSION_MODE=danger-full-access` 时为 `never` | `:244-247` |
| `permission` → `dsh-permission-presets` | 三个预设：read-only / workspace-write 配 `ask`，danger-full-access 配 `never` | `:249-261` |
| `fs-sandbox` | read / write / edit 的进程内围栏 | `:517-518` |

- 覆写语义：按 id 打的补丁会**整段替换**该行的 config，不做深合并（`dsh-app-boot/README.md:206`）。推断我方 bundle 叠在 base 上的补丁也是这个语义，所以覆写时要把保留的字段重新写一遍。
- 我方 bundle 目前没有碰上面任何一行（`src/dsh-host/bundle/cordis.patch.yml`，基线版本）。

## 2 审批在哪里触发

- **执行前拦截点**：每次工具调用都会经过 `tools/pre-execute` waterfall，然后是同步 guard，然后是 `tools/execute` 包装、`tools/post-execute`，最后是 `tools/result` 观察（`dsh-tools/README.md:85`、`:105`；`dsh-tools/lib/index.js:3213-3273`）。没有监听者时默认放行（`:3225`）。
- **base 里没有任何按策略审批的监听者**。`tools/pre-execute` 上只有 `dsh-tool-jobs` 挂了一个 prepend 监听，它只记录输出上限然后调 `next()`（`dsh-tool-jobs/lib/index.js:235-239`）。`dsh-tool-bash` 的源码注释写着「TODO(permissions): deployment policy belongs in `tools/pre-execute`」（`:218`）。
- 因此在 base 组合里，审批**只有两个来源**：
  1. 越界升级：bash / pwsh / fs 工具带 `sandbox_permissions` 和 `justification` 调用；
  2. 某个插件的 pre-execute 返回了 `ask`。

  P0-2 实测证实了这一点：沙箱内的操作不问，越界先被拒绝，模型带升级参数重试才出卡（P0-2 证据第 17-21、169-174 行）。

## 3 `tools/pre-execute` 能拿到什么、能做什么

- **入参 `exec`**（`dsh-tools/lib/types/index.d.ts:216-287`）：
  - `callId`、`rootCallId`、`name`；
  - `arguments`：解析后的 JSON，已经深冻结；
  - `agent?`：发起调用的 Agent，能拿到 `session.header.cwd`、`parentSession`、`origin`；
  - `parent?`：PTC / workflow 子调用才有；
  - `signal`：调用方的取消信号；
  - `token`：注册表分配的不透明标识。
- **返回值** `PreToolDecision`（`:436-460`）：
  - `allow`；
  - `deny {reason, info?: ToolErrorInfo{name, code, reason?}}`：reason 进模型内容，info 进持久化投影；
  - `cancel`：得到标准的 `ABORTED_BEFORE_DISPATCH` 结果；
  - `ask {reason?, displayReason?}`：交给 ApprovalService，结果为 `allowed-once` 才放行，其余都拒绝（`lib/index.js:3439-3492`）。
- **可以异步，可以挂起等审批**：「Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise」（`types/index.d.ts:36-47`）。
- **不能改写参数**：刻意不支持，因为参数已经落盘并展示给用户（`dsh-tools/README.md:230`）。
- **监听顺序**：waterfall 按注册顺序依次调用，每个监听者靠调 `next()` 往下传；**前面的监听者可以直接返回，后面的就不会被调用**（`cordis/lib/index.js:317-325`）。`prepend` 用的是 `unshift`，所以后注册的 prepend 排在最前（`:336`）。
- **guard**：`ctx.tools.guard(fn)` 在 pre-execute 结果为 allow 之后同步执行，返回字符串就拒绝。guard 只能拒绝、不能放行，也不能被别的监听者绕过（`types/index.d.ts:515-522`；`lib/index.js:3241`）。
- **post-execute** 可以替换 `content` 或 `value` 二者之一；替换 `value` 时会按工具的 render 重新渲染（`lib/index.js:3504-3530`）。
  - glob 带 `--no-ignore --hidden`，隐藏文件和被忽略的文件都会列出，比如 `.env`；grep 按 ripgrep 的默认规则搜（`dsh-tool-fs-search/lib/index.js:584-592`、`:933-938`）。
  - glob / grep 自己在 post-execute 里先调 `next()`，下游没有改动时才把超量的完整清单写进 spill 文件；下游替换了 `value` 就不写（`dsh-tool-fs-search/lib/index.js:517-520`、`:1159-1178`）。
- **时序**：持久事件 `tool/call` 在派发时就追加，早于 pre-execute（P1-4 分片 02 §3）。所以现有 bridge 会先发 `tool.started`，再发卡，这和 native 的顺序一致。

## 4 `user-approval` answerer 的协议

- **应答方**：`approval/request` waterfall 的监听者。签名是 `(req, next) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>`。按 agent 限定作用域的监听者只收到该 agent 的请求。一个部署只应该有一个终端应答方（`dsh-user-approval/README.md:32`）。
- **请求字段**：`agent`、`toolName`、`callId?`、`reason?`、`displayReason?{en, zh…}`、`signal?`。**不带工具参数**（`types/index.d.ts:68-89`；`README.md:156`）。
- **服务端的处理规则**（`lib/index.js:128-189`）：
  - 必须处在一个打开的回合里，否则直接抛错（`:49-56`、`:130`）；
  - 会话策略为 `never` 时，在派发之前就判 `rejected`（`:175`）；
  - 请求中途 abort → `cancelled`；没有应答方或应答方抛错 → `unavailable`，按失败关闭处理；
  - `approval/asked` / `approval/decided` 两条事件只写日志。
- **只有一次性授权**：没有「总是允许」，没有授权记忆，会话策略只有 ask / never（`README.md:155`）。
- **策略切换**：`setPolicy(agent, …)` 会往模型的下一步插一条「changed by the user」提示（`lib/index.js:98-109`）；`setApprovalPolicy(session, …)` 只写日志（`:63-66`）。模型的运行时上下文里带着当前策略的完整说明（`:79-89`）。

## 5 沙箱档位与越界升级

- **三档**：`read-only` / `workspace-write` / `danger-full-access`（`dsh-sandbox-policy/lib/index.js:26-30`）。
  - 会话的覆写靠 `sandbox/mode` 事件记录，只写日志，下一次受限调用生效（`:40-42`）。
  - 生效档位的优先级：已批准的单次升级 > 会话覆写 > 部署默认（`:141-156`）。
  - 可写根就是会话 header 里的 `cwd`，不能改。
- **只管写，不管读**：
  - bash：`workspace-write` 可写的只有工作区和 `/tmp`（bwrap 下是临时的 `/tmp`）；`danger-full-access` **完全不调用沙箱**（`dsh-bash-sandbox/README.md:38-40`）。
  - fs 工具只围栏写入，读取不受限制（`dsh-fs-sandbox/README.md:28`、`:50`）。
  - Windows ACL 沙箱不限制读，也不限制网络（`dsh-sandbox-windows-acl/README.md:117`）。
  - **结论**：拒读 `.env` / `~/.ssh`、问询工作区外的读取，只有我方闸门在做。
- **越界升级**（`dsh-sandbox/lib/index.js:30-42`、`:99-123`）：
  - 只能升到严格更宽的档位；
  - 在工具体内、执行之前调 `approval.request`，带上 `callId`；reason 是 `escalate sandbox to <mode>: <justification>`，displayReason 有中英文；
  - 批准只对这一次调用有效。
  - bash 在 `:361-380`；fs 在 `dsh-tool-fs/lib/index.js:1111-1134`；PTC 的 `run_code` 在 `dsh-tools/lib/index.js:1187-1196`。
- **各平台实现**（`dsh-sandbox-local/README.md:71`、`:75`、`:130`）：
  - Linux：先 bwrap（只读的宿主根目录 + 可写的工作区 bind + 临时 `/tmp` + 私有 PID 命名空间），不行再 Landlock；
  - macOS：Seatbelt；
  - Windows：ACL 受限令牌，只能做到 `partial`。
  - 没有可用的 runner 时，失败关闭，报 `SANDBOX_UNAVAILABLE`，绝不退回无沙箱运行（`dsh-sandbox/lib/index.js:264-275`）。
- **推断：会拦住常见开发命令**。bwrap 的 `workspace-write` 下，宿主根目录只读，写 `~/.npm`、`~/.cache`、`~/.cargo` 之类的命令会被拒（依据上面的 profile 描述，没有实测），典型的有 `npm/pnpm install`、`pip`、`cargo`、`go build`。

## 6 Windows 的 ACL 沙箱（P0-4 与 README）

- **要求工作区根有 WRITE_OWNER**：只有 Modify 权限的目录，授权会直接失败，而且是失败关闭（README `:122`；P0-4 证据第 132-167 行）。
- **授权是常驻的**：写 ACE、写 Low 完整性标签、对 Everyone 拒绝删除子项，沿目录树继承；手工 `icacls` 撤不掉（README `:120`）。首次授权要把整棵目录树传播一遍，大目录可能要几十秒（`:177`）。
- **沙箱里起不了命名管道**：子进程用 piped stdio 起孙进程会报 EPERM（README `:176`；`dsh-tool-pwsh/README.md:63`）。依赖管道的 node / npm 类工具链会受影响（推断）。
- **ConstrainedLanguage**：read-only 档下 pwsh 进 ConstrainedLanguage 模式；`workspace-write` 档下不会。
- **只有 `pwsh` 工具**，Windows PowerShell 5.1 也能跑（P0-4）。

## 7 子代理、plan、预设与投影

- **子代理**：
  - 审批策略被**钉死为 `never`**，不管父代理是什么策略（`dsh-subagent/lib/index.js:534-541`）。所以子代理的 `ask` 在 DSH 自己的审批服务里一律被判 `rejected`。
  - 沙箱覆写继承父会话的显式值。
  - 子会话的 header 带 `parentSession`、`origin:'subagent'`、`agentPreset`、父会话的 `cwd`（`:470-481`；`dsh-subagent-in-process-driver/lib/index.js:169-188`）。
- **推断：子代理的 scope 不挂在父 agent 下面**。agent-loop 调 `createScope` 时没传 parent（`dsh-agent-loop/lib/index.js:778`），全包也没有 `bindScopeParent` 的调用方。所以挂在父 agent 上的监听收不到子代理的调用，**要用全局监听，再按 `parentSession` 归属**。
- **plan 模式不限制工具**：「every tool stays callable」（`dsh-plan-mode/README.md:12`、`:32`）。
- **预设**（`dsh-permission-presets/lib/index.js`）：
  - 默认预设推不出来时构造阶段直接抛错（`:180`）；新会话写入预设和两个旋钮（`:370-392`）；
  - 注册 `/permission` 命令（`:205-226`）；
  - 投影 `permissions` 只有 `currentValue`。
  - 只有 `dsh-subagent` 可选地读它（`ctx.get`，`:536`），所以推断**关掉这一行不会影响宿主启动**。
- **投影**：`sandboxMode` 在 `dsh-sandbox-policy/lib/index.js:114-120`；`permissions` 来自预设行。
- **PTC / workflow**：模型写的 TypeScript 跑在新的 Node 进程里，「Direct Node APIs remain available within the selected restrictions」（`dsh-ptc-runtime-node/README.md:12`）。所以沙箱关掉之后，程序体可以绕过按工具的闸门，只有程序里调的子工具还会过闸。
- **spill**：DSH 把超长输出写到 `$TMPDIR/dsh-spill-*` 私有根下，并提示模型去读（`dsh-spill-local/lib/index.js:16-36`；P0-2 证据）。

## 8 没能确认的

1. 全局 `tools/pre-execute` 能收到子代理和 PTC 子调用，而且 `exec.agent` 是子 agent。推断成立，开工前用小实验确认。
2. 我方 bundle 用 `insert` 加进来的行，挂载顺序晚于 base 的 `tool-fs-search`。这决定我方 post-execute 过滤排在它下游（§3）。推断，需实测。
3. 关掉 `permission` 行后宿主能正常启动，也没有别的包硬依赖它。推断，需实测。
4. bwrap `workspace-write` 下常见开发命令被越界拒绝的比例。只读了 profile，没有实跑。
5. 开了 AppArmor 限制用户命名空间的 Linux（如 Ubuntu 24.04）上，bwrap 失败后 Landlock 能否接住。未测。
6. 用户在自己 Windows 机上试用官方 DSH Desktop 时，沙箱是不是默认开着的。未知。
