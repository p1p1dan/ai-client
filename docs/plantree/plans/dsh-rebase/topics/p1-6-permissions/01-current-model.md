# P1-6 分片 01 · 我方权限模型全貌（1.0.x 自有 runtime 与 HEAD bridge）

Role: detail shard。上位：[P1-6 方案](../p1-6-permissions.md)。回答调研问题 1。行号指 worktree 基线 `d6e1c811`；`src/runtime/`、`src/agent-host/` 在基线之后没有改动，可直接读工作区。调研期间 P1-1 已提交（`100ebcf1`），它没有改动 bridge 里的审批与 setter，只是行号后移，下文另行注明。

## 1 两个轴与四档

- **两个轴（D14）**：`mode`（`plan` / `agent`）决定能用哪些工具；`gear`（`ask` / `accept-edits` / `auto` / `bypass`）决定多久问一次（`src/shared/types/runtimePermission.ts:1-22`）。
- **旧四档（tier）只做迁移**：`readonly` → plan + ask；`pragmatic` → agent + ask（默认）；`handsoff` → agent + accept-edits；`fullopen` → agent + auto（`runtimePermission.ts:45-56`；`sessionPermissionTier.ts:8-17`）。`bypass` 不能作为新会话默认值，委派定义也不能声明它（`runtimePermission.ts:4-16`）。
- **判定顺序**（`src/runtime/plugins/permissions/index.ts:492-580`）。所有拒绝都排在档位之前，所以没有哪一档能越过拒绝：
  1. 工具白名单（`:493`）；策略里的 deny，包括 `path`、工具面、`external_directory`（`:494-510`）；内置路径黑名单（`:511-513`）；plan 模式裁剪：只剩 read / glob / grep / skill，外加 exploration 类 bash（`:514-524`）；deny scope（`:525-530`）。
  2. `bypass` → 放行（`:536`）。
  3. `auto` → 放行，**除非 bash 有解析不出的操作数**（`unresolvedPaths`，`:541`）。
  4. ask / allow scope（`:542-549`）→ 会话授权（`:555`）→ 解析不出的操作数一律问（`:556`）。
  5. 工作区外的路径、策略标 `ask` 的路径 → 问（`:561-575`），`trustedPath`（skill 目录）除外。
  6. read / grep / glob → 放行（`:576-577`）；`accept-edits` 下工作区内的 write / edit / bash → 放行（`:578`）；其余 → 问（`:579`）。
- 各档写给模型的一句话见 `prompt.ts:4-11`，经 `prompt/index.ts:104-106` 进系统提示。

## 2 逐次审批

- **触发**：`evaluate()` 返回 `ask`。只有 fs 工具、bash、MCP、skill、`browser_preview` 会调 `authorize()`（`tools/index.ts:191-228`，`mcp/index.ts:404`，`skills/index.ts:394`）。派发子代理的工具、todo 之类不过闸（runtime-hardening 决策 022）。
- **串行队列**（决策 022）：同一时刻只有一张卡；排队中的请求不发事件、不计时；120 s 倒计时从出卡那一刻算起；`queuePosition` / `queueDepth` 随卡下发（`index.ts:660-709`、`:710-792`，超时常量 `:29`、`:40`）。
- **加宽档位能收回活卡**：`setGear()` 加宽后重判活卡，判为放行就经 `autoAllow` 收卡，排队中的请求轮到时重判；收窄不动已在排队的请求（`index.ts:379-397`、`:742-743`）。
- **`configure()`**（换 mode 或整体重设）会清空授权、作废排队中的请求（epoch 加 1），并把空授权写盘（`index.ts:370-378`）。
- **拒绝来源**分为 policy-deny、user-denied、timed-out、cancelled、error（`index.ts:192-203`），审计行按来源显示（`activity.ts:31-43`）。
- **路径改变复查**：审批前后各做一次 canonical 解析，目标变了就报 `path_changed`（`tools/index.ts:216-227`；bash 再跑一遍 `checkShellPaths`，`:517-526`）。

## 3 会话授权记忆（allow_session）

- **粒度**（决策 026，`grants.ts:42-45`、`:169-231`）：
  - 文件类工具：只记被批准的那个文件，按工具区分；
  - bash：记命令前缀加工作区根（`{kind:'command', prefix, root}`）。`npm`、`git` 等多子命令工具取前两个词，其余取第一个词（`:96-131`）。链式命令的每一段都得被授权过；程序名读不出来的命令不可授权（`:146-160`）。
  - MCP / skill：按 `policyValue` 精确记（`:175-176`）。
- **授权不管的事**：秘密文件、策略标 `ask` 的路径每次照问；bash 授权不延伸到工作区外（`index.ts:445-460`）。
- **作用域**：会话级，对本会话的父代理和所有子代理都生效（决策 003）；不跨会话。
- **持久化**：整份授权集写成 session JSONL 里的 custom 条目 `aiclient.permissionGrants`（`session/legacy.ts:36`）；格式版本 2，读到不认识的版本一律丢弃；最后一条记录为准（`grants.ts:288-362`）。恢复时由 `bootstrap.ts:371-379` 读回。写盘是即发即忘，失败只影响下次重开（`index.ts:479-491`）。
- **卡片上的范围说明**：`describeGrantScope` 算出「允许本会话」到底会记住什么（`grants.ts:243-260`）。

## 4 bash 分析与拒绝清单

- **AST**：`web-tree-sitter` 加 `tree-sitter-bash` 的 wasm，共约 1.56 MB，由 HostIo 读入（`bash-analysis.ts:109-125`）。
  - 输出 `paths`、`commands`、`unresolvedPaths`、`exploration`（`:10-15`）。
  - 剥掉 `timeout`、`nice` 这类包装词（`:27-71`）。
  - 递归解析 `bash -c` 的内层脚本（`:288-304`）；登记重定向目标、`-C/path`、`key=value` 里的操作数（`:207-228`、`:369-387`）。
- **判为「解析不出」的情形**：变量和命令替换（`:185-199`、`:388-393`）；`eval`、`source`、`xargs`、`sudo`、`env`、解释器（`:340-355`）；控制结构（`:400-411`）；包装后读不出的内层命令（`:281`）；不带 `-c` 的 shell（`:296`）。
- **exploration**：`isExplorationCommand` 是只读命令白名单（`src/shared/runtimeShellPolicy.ts:1-39`），供 plan 模式判断。
- **执行前的路径复核**：通配符展开（上限 2 万项）、symlink / junction 的 canonical 解析，展开前后各查一次黑名单（`tools/index.ts:266-315`）。
- **搜索结果过滤**：glob / grep 用 `canTraverse` 把被拒的文件从结果里剔掉（`tools/index.ts:617-622`、`:714-719`；`index.ts:581-596`）。
- **拒绝清单**：
  - 内置路径规则：`*.env`、`*.env.*`、`~/.ssh/*`、`*.pem`、`*.key`、`id_rsa*`、`~/.aws/credentials` 拒绝；`~/.pilab/*` 询问；`.env.example` 放行（`agent-host/permissionPolicy.mjs:50-66`）。
  - 默认策略：bash `*: ask`，MCP 只放行发现类调用，其余面默认 `*: ask`（`:70-134`）。
  - 策略文件的合并顺序：随包 < 全局 < 项目 < local，后加载的覆盖先加载的（`policy.ts:38-125`；决策 008 / 010）。
  - bypass 仍保留五道拒绝（决策 023）。
  - 硬编码路径拒绝不出审计行（决策 027）。
- **Windows**：`normalizeWindowsPathForm` 把 MSYS、Cygwin 和 `\\?\` 写法折叠成原生写法（`windows-paths.ts:16-37`），服务于 1.0.x 在 Windows 上用 Git Bash 跑的 bash 工具。

## 5 子代理的审批归属

- 子代理和父代理走同一个闸门、同一个队列（决策 022）。卡片带委派署名 `agentId` / `agentName`（`permissionPrompt.ts:209-220`）。
- 委派定义可以声明自己的档位（inherit / ask / accept-edits / auto），按工具调用 id 生效，不改会话档位（`subagent/index.ts:1395-1420`；`index.ts:398-423`）。
- 授权在会话内共享（决策 003）。

## 6 事件、RPC 与状态落点

| 项 | 事实 | 出处 |
|---|---|---|
| `permission.requested` | 字段：permissionId = 工具调用 id；action 用 id 表示（`run_command`、`write_file`、`edit_file`、`read_file`）；`decisions: allow / allow_session / deny`；detail；`sessionGrantScope`；`timeoutMs`；队列位置 | `permissionPrompt.ts:34`、`:88-233`；`runtimeEvents.ts:445`、`:568-660` |
| `permission.resolved` | `allow`、`decision`、`autoReason`（`session_closed` / `aborted` / `timed_out`） | `permissionPrompt.ts:157-173`；`runtimeEvents.ts:472`、`:809-824` |
| `permission.activity` | 闸门的 prompt / decision 记录，`requestId` = 工具调用 id | `activity.ts:45-80`；`agent-loop/index.ts:624-641` |
| `worker.permission.respond` | 按 permissionId 结算；已经结算过的回 `handled:false` | `piWorkerRpcServer.ts:857-882`；`nativeWorkerRuntime.ts:160-162` |
| `worker.setPermissions` | 只能在空闲时调，调的是 `configure`（清空授权） | `nativeWorkerRuntime.ts:1007-1014`；`piWorkerRpcServer.ts:958-969` |
| `worker.setPermissionGear` | 回合进行中也可以调，调的是 `setGear` | `nativeWorkerRuntime.ts:1025-1027`；`piWorkerRpcServer.ts:981-993` |
| `worker.setPermissionTier` | 先迁移成两个轴，再走 `setPermissions` | `nativeWorkerRuntime.ts:1001-1005`；`piWorkerRpcServer.ts:995-1021` |
| bootstrap 播种 | payload 带 `tier`、`permissions`、`unbound`；结果带 `permissionGate: 'bundled' \| 'user_configured'` 和 `projectTrusted` | `workerRpc.ts:131`、`:155-156`、`:400`；`nativeWorkerRuntime.ts:278-291` |
| Main | `entry.permissions` / `entry.tier` 按会话记录，重启、恢复时重新下发；回合中只转发档位变更，换 mode 报 `session_busy`；worker 没应用成功则报 `worker_permission_not_applied` | `WorkerManager.ts:176-177`、`:2365-2410`、`:2412-2432` |
| 渲染层 | 按逻辑会话 id 存在 localStorage：`aiclient:chat:session-permissions`、`session-tiers` 及默认值 | `sessionPreferenceStore.ts:12-26`、`:141-142` |
| 卡片文案 | action id → 英文 key，中文走 `zhTranslations` | `questionCardModel.ts:863-868` |

## 7 HEAD bridge（P0-3，P1-1 未改动）的现状

- 只接了 DSH 的 `approval/request`：出一张只有 allow / deny 的卡，没有倒计时，也没有队列（`dshSessionRuntime.ts:488-490`、`:700-736`；P1-1 之后是 `:741`、`:954`）。
- 三个 setter 是空操作（`:394-396`；P1-1 之后是 `:645-647`），但 `PiWorkerRpcServer` 照样回 `applied:true`（`piWorkerRpcServer.ts:968`、`:992`、`:1019`）。
- bootstrap 结果里 `permissionGate: 'bundled'` 同样是空口声明（`:326`；P1-1 之后是 `:482`）。
- `kindOf` / `actionOf` 已经把 `pwsh` 归为 exec / `run_command`（`:173-185`）。
