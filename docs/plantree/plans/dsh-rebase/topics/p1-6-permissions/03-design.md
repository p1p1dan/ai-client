# P1-6 分片 03 · 移植设计明细

Role: detail shard。上位：[P1-6 方案](../p1-6-permissions.md)。回答调研问题 3～5 的实现层细节。标「推断」的项需要在开工前做小实验。文件名都是建议名。

## 1 分层与落点（D1、D3）

| 层 | 位置 | 内容 | 依赖 |
|---|---|---|---|
| 纯库 | `src/shared/permissions/` | 由 `PermissionsPlugin` 改成的 `PermissionGate` 类，含 evaluate、队列、档位、授权、epoch、审计记录；`grants`、`policy`（读文件由调用方注入）、`pathPolicy`、`windowsPaths`；`shellPaths`，即从 `tools/index.ts:191-315` 抽出的 target、`checkShellPaths` 与 canonical 解析，文件系统由调用方注入；`activity`、提示词文本；`cardEmitter`，从 `worker/permissionPrompt.ts` 抽出；`bashWalker`，只含 AST 遍历，SyntaxNode 用结构类型描述；新增 `pwshAnalysis` | 只用 `node:path` / `node:os` 和 `@shared` 类型。有先例 `src/shared/windowsCodePage.ts` |
| 解析器装载 | `src/dsh-host/permissions/treeSitter.ts` | 读 `web-tree-sitter` 与 `tree-sitter-bash` 的 wasm，交给 `bashWalker` | 宿主包新增这两个 MIT 依赖（约 1.6 MB wasm） |
| 宿主插件 | `src/dsh-host/permissions/plugin.ts`，打成 bundle 的 `lib/permissions.js`，占新行 `aiclient-permissions` | 会话路由、`tools/pre-execute`、guard、`tools/post-execute`、`approval/request` 终端应答方、systemPrompt 上下文 | inject：`tools`、`approval`、`sandboxPolicy`、`systemPrompt`、`sessions` |
| bridge | `DshSessionRuntime` | 每个虚拟 slot 持有一个 `PermissionGate`；在 bootstrap 里 attach 到路由，dispose 时 detach；实现 `respondPermission` 与三个 setter | bridge 行硬依赖 `aiclient-permissions`：闸门装不上，bootstrap 就失败，`permissionGate` 不再空口声明 |
| 1.0.x runtime | `src/runtime/plugins/permissions/*` | 改成薄封装，委托纯库；现有用例不改，照常运行（P1-12 删掉） | — |

## 2 工具归类表（D9）

| 类 | DSH 工具 | 映射到 `ToolPermissionRequest` |
|---|---|---|
| 读 | `read`、`read_image` | tool 为 `read`；path = 按会话 cwd 解析 `file_path`，再做 canonical |
| 搜索 | `glob`、`grep` | tool 同名；path = 把 `path`（缺省为 cwd）做 canonical；post-execute 过滤结果（§6） |
| 写 | `write`、`edit` | tool 同名；path 取 `file_path`；write 带内容预览 `{label:'Content', text: content}`（沿用 1.0.x） |
| shell | `bash`、`pwsh` | tool 取原名；策略面统一按 `bash`；path = `workdir` 按 cwd 解析（缺省为 cwd），再做 canonical；分析交给 `bashWalker` / `pwshAnalysis`；带 `sandbox_permissions` 时记为 `escalation {mode, justification}` |
| 执行（看不透内容） | `workflow`，以及 PTC 模式下的 `run_code` | 当 shell 处理，但 `unresolvedPaths: true`：ask、accept-edits、auto 都问，只有 bypass 放行；plan 下拒绝 |
| skill | `skill` | `policySurface: 'skill'`，`policyValue` 取技能名，`trustedPath: true`（沿用 1.0.x） |
| 内部 | `todo_write`、`job_list`、`job_output`、`job_kill`、`subagent`、`subagent_fork`、`list_agents`、`send_message`、`interrupt_agent`、`get_goal`、`create_goal`、`update_goal`、`exit_plan_mode`、`present` | 不过闸，直接 `next()`（对应 1.0.x 里派发子代理的工具与 todo 不过闸）。子代理自己发起的调用会单独过闸 |
| 未知或第三方插件 | 其余全部（例如 `word_create`） | `policySurface` 取工具名；path 取 cwd；按策略兜底 `'*': 'ask'` 判：ask 与 accept-edits 下问，auto 与 bypass 下放行，plan 下拒绝 |

- **路径**：统一经 `shellPaths` 走 1.0.x 的三步：先按字面做黑名单判断，再做 canonical 解析，最后审批。审批之后在 pre-execute 里复查一次 canonical，目标变了就拒绝（reason 为 `path changed during approval; retry`）。
- **可信路径**：DSH spill 根下的路径算 `trustedPath`，黑名单照样生效。否则 DSH 截断输出后，模型每次去读溢出文件都会因为「工作区外」弹卡。建议在 bundle 里把 `spill-local` 的根配置成已知目录，方便判断。
- 分类表集中放在一处，写成静态守卫：未分类的 DSH 内置工具名出现时测试失败，这样升级 DSH 时能发现新工具。

## 3 一次调用的流程（D2）

```text
tool/call（持久事件） → bridge 发 tool.started
tools/pre-execute（aiclient-permissions，prepend）
  ├─ 路由：exec.agent → 根会话 → PermissionGate；归属不到 → deny「permission gate not attached」
  ├─ 内部工具 → verdict[exec] = allow → next()
  ├─ 构造请求（§2）；shell 先做分析与路径复核；命中黑名单 → deny
  ├─ gate.authorize(request, exec.signal)：
  │    allow → verdict[exec] = allow → return next()
  │    deny（policy-deny / user-denied / timed-out）→ { kind:'deny', reason, info:{ name:'PermissionDenial', code:'tool_denied', reason: <来源> } }
  │    cancelled（Stop、dispose 或 epoch 变化）→ { kind:'cancel' }，即 ABORTED_BEFORE_DISPATCH
  └─ 审批成功后复查 canonical 路径
guard（同步）：verdict[exec] 不是 allow → 拒绝「permission gate did not run」（其他监听者抢先返回时失败关闭）
tool 执行体：遇到升级请求 → approval/request → 我方应答方（§5）
tools/post-execute（排在 fs-search 下游，非 prepend）：过滤 glob / grep 结果（§6）
```

- **拒绝理由沿用 1.0.x 原文**：`access denied: <tool> <path>`、`permission denied`、`nobody answered the permission request in time`。模型看到的是 `Error: <理由>`（`dsh-tools/README.md` 的 Model Experience 一节）。
- **Stop 与关会话**：`exec.signal` 触发 abort 后，活卡以 `autoReason: aborted` 结算并返回 `cancel`；关会话时 `gate.drain('session_closed')`。这一点决定 Stop 阶梯（决策 021）能不能在 3 s 内收尾，是硬要求。
- **审计**：`gate.onActivity` 产出的记录用纯库里的 `permissionActivityEvent` 转成 `permission.activity`，经 slot 的 emit 发出，`requestId` 仍取工具调用 id。
- **为什么不返回 `ask` 交给 DSH 的审批服务**：
  - 子代理被钉在 `never`，会被一律拒绝；
  - 审批服务的请求不带参数；
  - 队列、倒计时、`allow_session`、收回活卡这些都在我方闸门里。

  代价是 DSH 日志里没有 `approval/asked` / `approval/decided` 这对事件。按 runtime-hardening 决策 027（审批不做审计留痕），可以接受。

## 4 会话路由与隔离（决策 019）

- **路由表**：`rootOf: Map<dshSessionId, rootDshSessionId>`、`gates: Map<rootDshSessionId, PermissionGate>`。
  - bridge 在 bootstrap 时登记根会话；
  - 监听 `session/created`：header 带 `parentSession` 的，登记为 `rootOf[child] = rootOf[parent] ?? parent`（推断：子会话的 header 在创建时就带着 `parentSession`，见分片 02 §7）；
  - 回退（P1-4b）换了 `dshSessionId` 就重新登记；dispose 时注销。
- **隔离**：授权、档位、队列、epoch 都在各自的 `PermissionGate` 里，不同会话之间互不可见。子代理共用根会话的闸门、授权和队列（决策 003、022）。
- **子代理署名**：`agentId` 取子会话 id，`agentName` 取 header 的 `agentPreset`，缺省为 `subagent`。P1-7 的子代理面板要用同一个 join 键。
- **委派定义里的档位**（1.0.x 的 `definition.permission`）：DSH 的代理预设没有这个字段，P1 一律按 inherit 处理（D11）。
- **子代理的越界升级**：DSH 把子代理的审批策略钉在 `never`，所以永远被拒绝。这是 DSH 的既有设计，本方案不去改它。

## 5 approval/request 终端应答方

- 取代 P0-3 的 `ask()`。只处理 DSH 自己发起的询问，也就是越界升级和第三方插件的 `ask`。
- **每个 callId 最多出一张卡**：
  - 同一 callId 已经在 pre-execute 里由用户批准过，而且当时的卡已经展示了升级信息 → 直接回 `allowed-once`，不再出卡；
  - 同一 callId 已经被拒 → 回 `rejected`。
- **没出过卡的询问按档位处理**：
  - bypass → `allowed-once`；
  - 其余档位进同一个串行队列出卡。`action` 用新 id `escalate_sandbox`，`reason` 填模型写的 justification，原样展示；`decisions` 为 `allow` / `deny`。
- 这些卡与 pre-execute 的卡共用 permissionId = callId，时间线的连接规则不变。
- **推断**：D5 选 A（默认关沙箱）时，这里只会收到第三方插件的 `ask`。base 里没有这样的插件。

## 6 搜索结果过滤（D10）

- `tools/post-execute` 的监听者不加 prepend，注册在 `tool-fs-search` 之后。它只处理 glob / grep 的直接调用：
  - 用 `gate.canTraverse` 过滤 `value.paths` / `value.matches`；
  - 有东西被过滤掉时，返回 `{kind:'accept', value: 过滤后的值}`，由 DSH 重新渲染；
  - 没有被过滤的，原样 `next()`。
- 替换了 value 之后，fs-search 就不再把完整清单写进 spill（`dsh-tool-fs-search/lib/index.js:517-520`），未过滤的清单因此不会落盘。
- 顺序依赖行挂载顺序（推断，分片 02 §8 第 2 条）。要加一条集成用例把它钉住。

## 7 授权记忆持久化（D4）

- **位置**：与桩同目录，文件名同前缀，`$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.grants.json`。前缀取桩文件名，不取当前的 `dshSessionId`，所以回退改写桩之后路径不变。
- **内容**：沿用 `encodeGrants` 的 v2 编码（`{version:2, grants:[…]}`），读取用 `decodeGrants`，版本不认识就丢弃。
- **写法**：先写临时文件再改名，保证原子；即发即忘，失败只记日志（与 1.0.x 一致）。
- **生命周期**：

| 时机 | 做什么 |
|---|---|
| bootstrap / 恢复 / 崩溃重启 | 读 sidecar，作为 `grants` 的初值 |
| `allow_session` | 写全量 |
| `configure`（换 mode） | 写空集，作用等同 1.0.x 的「清空并落盘」 |
| 回退（P1-4b） | 桩路径不变，授权保留。与 1.0.x 小有差异：1.0.x 回退后的恢复只读当前分支上的记录 |
| fork（P1-4b） | 把 sidecar 复制到新桩旁边，对齐 1.0.x「fork 继承分叉点之前的授权」 |
| discard fork / GC（决策 024） | 连同桩一起删 |

- **P1-9 迁移**：从 pi 会话里读最后一条 `aiclient.permissionGrants` 条目，写成 sidecar。
- 会话档位在渲染层的 localStorage 里，按逻辑 id 存，不需要迁移。

## 8 档位、setter 与播种

- **bootstrap**：
  - 按 payload 的 `permissions`、`tier`，以及由 `unbound` / `projectTrusted` 推出的信任状态建 `PermissionGate`；
  - 策略用 `loadPermissionPolicy` 读，文件读取由调用方注入；
  - 全局策略文件在应用的 pi-agent 目录下，路径靠宿主环境变量 `AICLIENT_PERMISSION_AGENT_DIR` 传进来，由 Main 设置。P1-1 的环境白名单会把 `PI_CODING_AGENT_DIR` 滤掉，决策 022 的剔除规则也不保证带上它，所以要显式传。
- **`setPermissions`**：只能在空闲时调。空闲不只看 bridge 自己发起的回合，DSH 自发的回合（goal 续跑、job 唤醒）也算，这时报 `WORKER_SESSION_BUSY`。然后依次：`gate.configure`；写空 sidecar；D5 开着叠加时写 `sandbox/mode`；最后才回 `applied:true`。闸门没装上时报 `WORKER_PERMISSIONS_UNAVAILABLE`，与 native 一致。
- **`setPermissionGear`**：回合中也可以调。`gate.setGear`，加宽时收回活卡；D5 开着叠加时写 `sandbox/mode`（DSH 在下一次受限调用时生效）。
- **`setPermissionTier`**：先用 `migratePermissionTier` 迁移，再走 `setPermissions`。
- **提示词**：插件用 `systemPrompt.context` 提供 `aiclient:permission` 一段，内容为 `modeSegment` 加 `permissionGearSegment`，按调用方 agent 所属会话动态取值。DSH 的运行时上下文只追加不改写，档位变了会追加一份新快照，与 DSH 的审批策略说明是同一种做法。
- **plan 模式（D8）**：在 pre-execute 里拒绝写类、非 exploration 的 shell 和未知工具，工具目录不变。DSH 自带的 `/plan` 与 `/permission` 从我方命令列表里隐藏（P1-4d）。bundle 里关掉 `permission` 行，免得出现第二套档位入口。

## 9 bundle 补丁（`src/dsh-host/bundle/cordis.patch.yml`）

- `sandbox-policy`：`mode` 写成字面值，D5 选 A 时为 `danger-full-access`；`workspaceRoot` 要重新写上，因为按 id 的补丁会整段替换 config。
- `approval`：`policy: ask` 写成字面值，不再跟着 `DSH_PERMISSION_MODE` 走。
- `permission`：`disabled: true`。
- `insert`：新增 `aiclient-permissions` 行，挂载顺序排在 `aiclient-bridge` 之前。
- **P1-3 的宿主环境要剔除用户环境里的 `DSH_*`**：决策 022 目前只剔除运行时注入项、应用内部变量和密钥名，没有剔除 `DSH_*`，`DSH_PERMISSION_MODE` 会被继承进宿主。

## 10 与 DSH 沙箱的叠加（D5、D6）

**默认（D5 选 A）**：三个平台都用 `danger-full-access`，审批只来自我方闸门，行为与 1.0.x 等同，不会出现同一操作两次审批。叠加能力做完，但放在设置开关后面（每个安装一份），默认关；Windows 在 P1-13 之前不开放这个开关。

**开关打开后的映射**（也就是 D5 的 B）：

| 我方档位 | DSH 沙箱 | 越界升级 |
|---|---|---|
| plan（任一档位） | `read-only` | 拒绝 |
| ask | `workspace-write` | 出卡（同一 callId 合并） |
| accept-edits | `workspace-write` | 出卡。与该档「工作区外仍需审批」的语义一致 |
| auto | `workspace-write` | 出卡。用户既然打开了沙箱，升级就不再是「常规审批」 |
| bypass | `danger-full-access` | 不会发生 |

- **减少两张卡**：叠加开着时，静态分析就能看出目标在工作区外的调用（fs 工具，以及操作数可见的 shell），pre-execute 不出卡，而是直接按 DSH 的提示文本拒绝，让模型带着 `sandbox_permissions` 重试，只在重试那一次出一张带 justification 的卡。
- **仍会有两张卡的情形**：`npm install` 这类内容看不透的命令，先被沙箱拒绝，再升级重试。缓解办法是升级卡支持「本会话允许」，记成带 `sandbox:'danger-full-access'` 标记的命令前缀授权。
- **Windows（D6，Q005）**：只在开关打开时，才在打开工作区时预检 WRITE_OWNER；不满足的会话退回 `danger-full-access` 并提示用户，不拒绝会话，也不改 ACL。加密目录上的 F-on / F-off 与 F-on-acl 留到 P1-13。

## 11 pwsh 分析（D7）

- **形态**：保守的词法分析，不追求完整语法。
  - 按 `;`、`|`、`&&`、`||`、换行切段；
  - 每段的首词做别名展开和大小写归一：`ls`、`dir`、`gci` → `get-childitem`；`rm`、`del`、`ri` → `remove-item`；`cat`、`gc`、`type` → `get-content`；`cp` / `mv`、`ni`、`sc`、`ac` 等照此处理；
  - 原生程序照 bash 取前缀：`npm`、`git` 等多子命令工具取两个词。
- **路径登记**：
  - 参数 `-Path`、`-LiteralPath`、`-Destination`、`-FilePath`、`-OutFile`、`-Target`；
  - 位置参数中像路径的词：含 `\` 或 `/`、盘符、`.\`、`~\`；
  - 重定向 `>`、`>>`、`2>`、`*>`；
  - `Out-File`、`Set-Content`、`Add-Content`、`New-Item`、`Copy-Item`、`Move-Item`、`Remove-Item` 的目标。
  - `$env:NAME`、`$HOME`、`$PWD` 按宿主环境展开。
- **判为「解析不出」**：
  - 其余变量、`$(…)`、`@(…)`、脚本块 `{…}`；
  - `&` 与 `.` 调用符；
  - `Invoke-Expression` / `iex`、`Start-Process`、`-EncodedCommand`；
  - 嵌套的 `pwsh` / `powershell -Command`、`cmd /c`；
  - 反引号续行；
  - 非单字母的 PSDrive，例如 `HKCU:`、`Env:`、`Function:`；
  - UNC 路径按工作区外处理。
- **exploration 白名单**：`Get-ChildItem`、`Get-Content`、`Select-String`、`Get-Location`、`Test-Path`、`Resolve-Path`、`Get-Item`、`Measure-Object`，以及管道里的 `Select-Object`、`Sort-Object`、`Where-Object`（不带脚本块），另加与 bash 相同的只读 git 子命令。
- **授权前缀**：沿用 `{kind:'command', prefix, root}`，前缀按上面的归一结果取。纯库里所有 `tool === 'bash'` 的判断改为 `isShellTool(tool)`（涉及 `index.ts`、`grants.ts`、`activity.ts`、`cardEmitter`）。
- **后续提升**：评估 `tree-sitter-powershell` 的 wasm，接口不变，可以直接替换。
