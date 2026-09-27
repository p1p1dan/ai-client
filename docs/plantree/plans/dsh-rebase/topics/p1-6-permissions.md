# P1-6 权限移植：方案与就绪检查

Role: topic。建立：2026-09-26。上位：[roadmap P1-6](../roadmap.md)。

**依据**：[决策 001](../decisions/001-route-b-and-scope.md) 第 3 条、[002](../decisions/002-defer-encrypted-machine-and-shared-host.md)、[004](../decisions/004-branch-isolated-dsh-only.md)、[019](../decisions/019-one-host-per-app-virtual-slots.md)～[025](../decisions/025-host-lifecycle.md)、[026](../decisions/026-history-per-message-tree-across-lineage.md) 第 5 条；[Q002 / Q005](../open-questions.md)；[P0-2](../evidence/p0-2-goal-and-plugins-2026-09-25.md)、[P0-3](../evidence/p0-3-bridge-2026-09-25.md)、[P0-4](../evidence/p0-4-windows-ci-2026-09-26.md) 证据；[P1-4 方案](p1-4-bridge-parity.md)；runtime-hardening 决策 003 / 022 / 023 / 026 / 027。

**明细分片**：[01 我方模型全貌](p1-6-permissions/01-current-model.md) · [02 DSH 源码事实](p1-6-permissions/02-dsh-facts.md) · [03 设计明细](p1-6-permissions/03-design.md) · [04 回归基准与测试](p1-6-permissions/04-regression-baseline.md) · [05 改动、切分与边界](p1-6-permissions/05-changes.md)。

**状态**：
- 只读调研，基线 `d6e1c811`。调研期间 P1-1 已提交为 `100ebcf1`，它没有动审批与 setter，只是行号后移。
- 没有改代码，没有起宿主，没有调用任何模型。
- **方案待拍板**（§5 的 D1～D11）。其中 **D5、D6 需要用户拍板**。

**约定**：DSH 路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，版本以 `0.1.7-rc.2` 为准。标「推断」的结论没有运行验证。

## 1 结论先行

1. **能移植，而且接缝现成。**
   - DSH 的 `tools/pre-execute` 是每次工具调用都会经过的执行前拦截点，拿得到解析后的参数和发起调用的 agent。它可以放行、拒绝、取消，也可以异步挂起等人工审批。
   - 我方闸门（四档、串行队列、倒计时、`allow_session`、加宽档位收卡）可以原样搬进去。出处：`dsh-tools/lib/types/index.d.ts:36-47,436-460`，`lib/index.js:3213-3273`。
2. **不能只挂 answerer，也不建议把我方的询问交给 DSH 的审批服务。**
   - DSH 只在越出沙箱时审批（P0-2），`approval/request` 不带工具参数，只有一次性授权。
   - DSH 把子代理的审批策略钉死为 `never`（`dsh-subagent/lib/index.js:540`），经它转一手，子代理的写操作会被一律拒绝。
   - 推荐：我方在 pre-execute（prepend）里**自己完成审批**，再加一个同步 guard 做失败关闭；`approval/request` 只做 DSH 自发询问（越界升级、第三方插件）的终端应答方，并遵守「同一 callId 最多一张卡」（D2）。
3. **落点。**
   - 纯逻辑抽到 `src/shared/permissions/`：闸门、授权、策略、路径黑名单、Windows 路径写法、shell 路径复核、卡片发射、bash AST 遍历。
   - 1.0.x 的 `src/runtime/plugins/permissions/` 改成薄封装委托纯库。**约 115 个现有权限用例一行不改就跑在纯库上**，这是抽取不变形的证明（D1）。
   - DSH 适配放在新的宿主插件行 `aiclient-permissions`，bridge 硬依赖它（D3）。
4. **会话隔离。**
   - 每个虚拟 slot 持有一个 `PermissionGate`。
   - 宿主级路由把 `exec.agent` 归到根会话：子会话在 `session/created` 时按 header 里的 `parentSession` 登记。归属不到就拒绝。
   - 授权、档位、队列都在会话之间隔离；子代理共用根会话的闸门（决策 003、022）。
5. **授权记忆持久化。**
   - DSH 日志不能写自定义事件（决策 026 第 5 条），所以放在桩旁的 sidecar `<桩名>.grants.json` 里，沿用 v2 编码，原子写。
   - 回退时保留，fork 时复制，GC 时同删（D4）。
6. **setter 真正生效。**
   - `setPermissions` / `setPermissionGear` / `setPermissionTier` 改为作用在 `PermissionGate` 上。闸门没装上就报 `WORKER_PERMISSIONS_UNAVAILABLE`。
   - 判断会话是否空闲时，要把 DSH 自发的回合（goal 续跑、job 唤醒）也算上。
   - `permissionGate: 'bundled'` 改为如实上报。
7. **沙箱：推荐 P1 默认三平台都关**，即 `danger-full-access` 加我方审批（D5，**需用户拍板**）。
   - DSH 沙箱**只管写、不管读、不管网络**。拒读 `.env`、问询工作区外的读取，本来就只能靠我方。
   - 关掉就与 1.0.x 行为等同，不会出现同一操作审批两次。
   - 叠加能力做完，但放在设置开关后面。Linux / macOS 在开发机实测常见命令的越界率之后再定是否默认打开；Windows 等 P1-13。
8. **Q005 的建议**（D6，随 D5 一起拍板）：
   - Windows 默认不开 ACL 沙箱，也不做预检。
   - 以后打开时，在打开工作区时预检 WRITE_OWNER；不满足的会话退回 `danger-full-access` 并提示用户，不拒绝会话，不改 ACL。
   - 加密目录上 F-on-acl 的结论仍归 P1-13。
9. **pwsh**：DSH 在 Windows 上只有 `pwsh` 工具，我方现有分析只懂 bash。
   - 推荐自写保守的词法分析：别名与大小写归一，登记路径参数和重定向，看不懂的一律算「解析不出」。结果是 auto 档下照问，bypass 放行。
   - 策略面沿用 `bash`（D7）。
10. **拒绝清单对搜索结果也要生效**：DSH 的 glob 连隐藏文件和被忽略的文件一起列出（`--no-ignore --hidden`，`dsh-tool-fs-search/lib/index.js:584-592`）；grep 按 ripgrep 的默认规则搜，仍可能读到 `*.pem`、`*.key`、`id_rsa` 的内容。用 post-execute 过滤结构化结果，排在 fs-search 下游，这样被过滤掉的内容也不会进 spill（D10）。
11. **规模与顺序**：约 3～4 人周（粗估），切成 a～d 四步，另有可选的 e。
    - a（纯库抽取）现在就能做；
    - b、c 排在 P1-3a 之后；
    - d 要推 Windows CI，推送前需用户确认。
12. **开工前要做的小实验**（各用一个脚本）：
    - 全局 pre-execute 能不能收到子代理和 PTC 子调用；
    - guard 能不能兜住「前面的监听者不调 `next()` 就返回」；
    - post-execute 是不是排在 fs-search 之后；
    - 关掉 `permission` 行之后宿主能不能启动；
    - 卡片挂着时 `exec.signal` 触发 abort，会不会映射成 `ABORTED_BEFORE_DISPATCH`。

## 2 现状（明细见分片 01）

| 面 | 1.0.x 自有 runtime | HEAD bridge（P0-3，P1-1 未改动） |
|---|---|---|
| 档位 | mode（plan / agent）× gear（ask / accept-edits / auto / bypass）。先判所有拒绝，再看档位：bypass 全放；auto 遇到解析不出的操作数照问；accept-edits 放行工作区内的写和 bash（`permissions/index.ts:492-580`） | 三个 setter 是空操作，RPC 却回 `applied:true`（`dshSessionRuntime.ts:394-396`；`piWorkerRpcServer.ts:968,992,1019`） |
| 逐次审批 | 串行队列，一次一张卡；120 s 倒计时从出卡时算；显示队列位置；加宽档位收回活卡（`index.ts:660-792`，决策 022） | 只接 DSH 的越界审批，只有允许 / 拒绝，没有倒计时（`:700-736`） |
| 授权记忆 | 文件精确到单个文件，bash 记命令前缀加工作区根，会话级，子代理共享；写成 JSONL 的 custom 条目，最后一条为准，换 mode 时清空（`grants.ts`，决策 003 / 026） | 无 |
| 分析与拒绝 | tree-sitter-bash 的 AST；通配展开与 canonical 解析，审批前后各复核一次；随包黑名单与策略合并；bypass 保留五道拒绝（决策 023）；glob / grep 过滤结果（`tools/index.ts:191-315,617-719`） | 无 |
| 子代理 | 同一闸门、同一队列，卡片带署名，委派定义可以声明档位（`subagent/index.ts:1395-1420`） | 无 |
| 事件 / RPC | `permission.requested` / `resolved` / `activity`；`worker.permission.respond` 与三个 setter；Main 按会话记住档位并在重启、恢复时下发；渲染层按逻辑 id 存 localStorage | 只发 requested / resolved；`permissionGate` 空口声明为 `'bundled'`（`:326`） |

## 3 DSH 侧事实（明细见分片 02）

- **审批只有两个来源**：
  - 越界升级：bash / pwsh / fs 工具带 `sandbox_permissions` 和 `justification`，在工具体内调 `approval.request`（`dsh-sandbox/lib/index.js:99-123`）；
  - 插件的 pre-execute 返回 `ask`。

  base 里没有按策略审批的监听者（`dsh-tool-bash/lib/index.js:218`「TODO(permissions)」）。
- **`tools/pre-execute`**：
  - 收到 `exec`，含 name、参数、callId、agent、signal、token；
  - 返回 allow / deny（带 info）/ cancel / ask；可以异步，但必须观察 signal；不能改写参数（`dsh-tools/README.md:230`）。
  - waterfall 里前面的监听者可以短路后面的（`cordis/lib/index.js:317-325`），所以要配同步 guard 兜底（`types/index.d.ts:515-522`）。
- **审批服务**：
  - 必须处在打开的回合里；`never` 在派发前就判拒绝；没有应答方时失败关闭；审计事件只写日志；只有一次性授权（`dsh-user-approval/lib/index.js:128-189`，`README.md:154-157`）。
- **沙箱**：
  - 三档 `read-only` / `workspace-write` / `danger-full-access`，按会话用 `sandbox/mode` 事件切换；`danger-full-access` 完全不调用沙箱（`dsh-bash-sandbox/README.md:38-40`）。
  - 实现：Linux 用 bwrap（只读根 + 工作区 + 临时 `/tmp`）或 Landlock；macOS 用 Seatbelt；Windows 用 ACL，只到 partial。都失败关闭（`dsh-sandbox-local/README.md:71,75,130`）。
- **Windows ACL**：
  - 工作区根要有 WRITE_OWNER；授权常驻，沿树继承，手工撤不掉；沙箱里用不了命名管道（`dsh-sandbox-windows-acl/README.md:120,122,176`；P0-4）。
- **组合与其他**：
  - dsh-base 默认 `workspace-write` 加 `ask`，预设表里 `danger-full-access` 配 `never`（`dsh-base/cordis.patch.yml:225-261`）。
  - plan 模式不限制工具（`dsh-plan-mode/README.md:32`）。
  - PTC / workflow 的程序体可以直接调用 Node API（`dsh-ptc-runtime-node/README.md:12`）。

## 4 方案（明细见分片 03）

**4.1 落点与形态（D1、D3）**
- **三层**：纯库 `src/shared/permissions/`；宿主插件 `src/dsh-host/permissions/`，打成 bundle 的 `lib/permissions.js`，占新行 `aiclient-permissions`；bridge 在 bootstrap 时 attach 一个 `PermissionGate`。
- **tree-sitter**：wasm 由宿主包带（`web-tree-sitter`、`tree-sitter-bash`，MIT，约 1.6 MB）；AST 遍历逻辑留在纯库，用结构类型，不依赖包。

**4.2 一次工具调用（D2）**
- **归类**：内部工具（todo、job、subagent、goal 等）直接放行。读、写、shell、skill、未知工具构造成 `ToolPermissionRequest`；看不透内容的执行类（`workflow`、`run_code`）一律按「解析不出」处理（D9，分类表见分片 03 §2）。
- **判定**：
  - `gate.authorize(request, exec.signal)`：放行 → `next()`；拒绝 → `{kind:'deny', reason, info:{name:'PermissionDenial', code:'tool_denied', reason: 来源}}`；取消 → `{kind:'cancel'}`。
  - 审批通过后在 pre-execute 里复查 canonical 路径。
  - guard 检查本次调用有没有得到放行判定，没有就拒绝。
- **拒绝理由沿用 1.0.x 原文**，审计行复用 `permissionActivityEvent`。
- **Stop**：卡片挂着时 Stop 会触发 `exec.signal`，活卡以 `aborted` 结算。这决定决策 021 的 Stop 阶梯能不能收尾。

**4.3 审批卡经 bridge 往返（与 P1-4 衔接）**
- **出卡**：`PermissionGate` 的卡片发射器经 slot 的 emit 发 `permission.requested`。字段与 native 相同：`decisions` 为 allow / allow_session / deny，带 `sessionGrantScope`、`timeoutMs`、队列位置、子代理署名。
- **应答**：`worker.permission.respond` → `respondPermission` → `gate.respond`。
- **先后顺序**：持久事件 `tool/call` 早于 pre-execute（P1-4 分片 02），所以时间线仍是先出工具行、后出卡。

**4.4 隔离与持久化（D4）**
- **路由表**：`rootOf` 与 `gates`（分片 03 §4）。
- **sidecar 的生命周期**：
  - bootstrap、恢复、崩溃重启时读回；
  - `allow_session` 时写全量；
  - `configure` 时写空集；
  - fork 时复制；
  - discard 或 GC 时删除。
- **P1-9**：从 pi 会话的 `aiclient.permissionGrants` 条目迁移成 sidecar。

**4.5 档位与 setter**
- **播种**：bootstrap 按 payload 的 `permissions` / `tier` 和信任状态播种。全局策略目录由 Main 通过 `AICLIENT_PERMISSION_AGENT_DIR` 传给宿主。
- **提示词**：档位与 mode 的说明经 `systemPrompt.context` 进模型上下文。
- **plan（D8）**：
  - 在 pre-execute 里拒绝写类、非只读 shell 和未知工具，工具目录不变；
  - bundle 关掉 `permission` 行，不让 DSH 的 `/permission` 和预设成为第二套档位入口；
  - `/plan`、`/permission` 从命令列表里隐藏。

**4.6 与 DSH 沙箱的叠加（D5）**
- **顺序**：先过我方闸门（pre-execute），后过 DSH 沙箱（工具体内）。
- **默认**：bundle 把 `sandbox-policy` 设成字面值 `danger-full-access`，`approval` 设成字面值 `ask`。这时审批只有我方一处，不会出现两次。
- **开关打开后**：ask / accept-edits / auto 用 `workspace-write`，bypass 用 `danger-full-access`，plan 用 `read-only`。
  - 同一 callId 只出一张卡；
  - 静态就能看出目标在工作区外的调用，直接按 DSH 的提示拒绝，引导模型带 `sandbox_permissions` 重试，只在重试时出一张卡；
  - `npm install` 这类内容看不透的命令仍可能出两张卡，靠带沙箱标记的「本会话允许」缓解。
  - 映射表见分片 03 §10。

**4.7 Windows**
- **pwsh 分析**：分片 03 §11。
- **卡片**：pwsh 沿用 `run_command` / exec；新增 action id `escalate_sandbox`，只加最小文案，精修归 P1-7。
- **ACL**：见 D6。

## 5 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 权限逻辑放哪里 | A 抽成 `src/shared/permissions/` 纯库，runtime 改薄封装；B 复制一份到宿主，runtime 不动到 P1-12；C 宿主直接引用 `src/runtime` | A | 约 115 例旧用例原样验证抽取；main 上的权限修复会在合并时冲突，逼着人搬进纯库 | 同步 main 时可能有冲突。B 会悄悄漏掉修复；C 会把我方的 cordis 拖进宿主包 |
| D2 | 怎么挂到 DSH | A 我方在 pre-execute 里自己审批，加 guard 失败关闭，answerer 只管 DSH 自发的询问；B pre-execute 返回 `ask`，交给 DSH 审批服务 | A | 子代理被钉在 `never`；请求不带参数；队列、倒计时、`allow_session`、收卡都要我方掌控 | DSH 日志里没有 `approval/*` 审计对（决策 027：不需要）。B 会让子代理的写操作被一律拒绝 |
| D3 | 宿主内的形态 | A 独立插件行 `aiclient-permissions`，单一路由，bridge 硬依赖；B 每个 `DshSessionRuntime` 各自注册全局监听（P0-3 做法） | A | 归属不到的调用可以失败关闭；只有一个 guard；共享宿主下按根会话分发 | 多一个 bundle 入口 |
| D4 | 授权记忆落在哪 | A 桩旁 sidecar；B 写进桩文件；C Main 持久化，bootstrap 下发 | A | 不碰 P1-4b 的桩写入；宿主崩溃后能直接读回 | 多一个小文件，GC 和 fork 要顺带处理 |
| **D5** | **DSH 沙箱与档位（需用户拍板）** | A P1 三平台默认 `danger-full-access`，叠加能力放在设置开关后，默认关；B 叠加默认开：ask / accept-edits / auto 用 `workspace-write`，bypass 全开（Linux / macOS 开，Windows 关）；C 只给 accept-edits 叠 `workspace-write` | A | 与 1.0.x 审批体验等同（决策 001 第 3 条的主要诉求）；没有两次审批；沙箱本来不管读；避开写家目录缓存被拒（推断）、没有 bwrap / Landlock 时 `SANDBOX_UNAVAILABLE`、Windows ACL 的副作用 | 暂时放弃决策 001「验证通过就叠加」里 Linux / macOS 的兜底层。B 的代价是更多卡片和新的失败形态；C 规则难解释 |
| **D6** | **Q005 Windows ACL（需用户拍板，随 D5）** | A 默认关，不预检；打开开关时预检 WRITE_OWNER，不满足就退回并提示；B 默认开加预检，不满足就拒绝会话；C 默认开，不预检 | A | P0-4 已证明 C 会让 pwsh 全部失败；B 会在 `C:\work`、共享目录上直接不可用；ACL 的改动是常驻的 | Windows 上没有沙箱兜底。加密机上的结论留给 P1-13 |
| D7 | pwsh 分析 | A 自写保守词法分析；B 用 PowerShell 自带的 AST（常驻 helper 进程）；C 用 tree-sitter-powershell | A，C 作为后续提升 | 零新进程、零新依赖；看不懂就问，失败关闭 | auto 档下 Windows 用户会比 Linux 多弹卡（决策 023 那类反馈的风险）；bypass 不受影响 |
| D8 | plan 模式怎么限制工具 | A 在 pre-execute 里拒绝，工具目录不变（DSH 的做法）；B 用 `ctx.tools.restrict` 按模式隐藏写工具 | A | 请求缓存稳定；与 DSH plan-mode 的做法一致 | 模型能看到写工具，但调用会被拒。1.0.x 是直接隐藏 |
| D9 | 未知工具与插件工具 | A 按分类表处理，未知工具走策略 `'*': 'ask'`；B 一律放行（DSH 默认） | A | 与 1.0.x 策略里的兜底规则一致；插件工具能写文件 | 分类表要随 DSH 升级维护，由静态守卫提醒 |
| D10 | 搜索结果过滤 | A post-execute 过滤后重新渲染；B 不做，相关用例判 N/A | A | 否则 grep 能读出 `*.pem` / `*.key` 的内容，glob 能列出 `.env` | 依赖行的挂载顺序（推断，要钉用例） |
| D11 | 委派定义里的档位 | A 在 DSH 下按 inherit 处理，相关用例判 N/A，去留交 P1-7；B P1-6 自己给 DSH 代理预设加字段 | A | DSH 的代理预设没有这个字段 | 自定义子代理不能再单独降档或升档 |

除 D5、D6 外，其余按工作方式自主决定，每条单独写一份决策文件（编号接续 033），标「待审批」。

## 6 改动清单与切分（明细见分片 05）

| 子任务 | 内容 | 主要文件 | 产品 / 测试（行） | 依赖 |
|---|---|---|---|---|
| P1-6a 纯库抽取 | 闸门与各模块搬进 `src/shared/permissions/`；runtime 改薄封装；`isShellTool` | `src/shared/permissions/*`、`src/runtime/plugins/permissions/*`、`tools/index.ts`、`worker/permissionPrompt.ts` | 搬约 2.2k，新增约 310 / 约 200 | 无，可以现在做 |
| P1-6b 宿主插件与钩子 | 路由、pre-execute、guard、post-execute、answerer、提示词上下文；bridge 接上闸门；bundle 的各行与依赖；`escalate_sandbox` | `src/dsh-host/permissions/*`、`dshSessionRuntime.ts`、`bundle/cordis.patch.yml`、`package.json`、`runtimeEvents.ts` | 约 1.1k / 约 1.15k | P1-3a；P1-4a 的骨架 |
| P1-6c 授权记忆与档位 | sidecar；三个 setter；播种与策略目录；Main 传环境变量；沙箱映射的钩子 | `grantStore.ts`、`dshSessionRuntime.ts`、`DshHostProcess.ts` 或 supervisor | 约 300 / 约 450 | 与 b 同批 |
| P1-6d Windows / pwsh | pwsh 词法分析、前缀归一、Windows CI 两路 | `src/shared/permissions/pwshAnalysis.ts`、workflow | 约 640 / 约 500 | b；推送前确认 |
| P1-6e（可选）沙箱叠加开关 | 设置项、档位到沙箱的映射、升级卡合并与升级授权、WRITE_OWNER 预检、越界率测量 | 见分片 05 | 约 500 / 约 400 | 看 D5 的结论；可以放到合入之后 |

- **规模**：约 3～4 人周（粗估，不含 e）。
- **边界要点**：
  - P1-2：冒烟脚本要显式设 bypass 或应答卡片，否则 bash 会卡满 120 s；
  - P1-3：路由挂在共享 bridge 下；宿主环境剔除 `DSH_*`，带上策略目录；GC 连 sidecar 一起删；
  - P1-4：`approval/request` 改由插件接管；`session.projection` 不再有 `permissions`；隐藏两个命令；拒绝与取消的结果如何映射到 `tool.completed`；fork 复制 sidecar；录制门禁加 `perm-*` 场景；
  - P1-7：卡片与 Windows 文案，子代理的 join 键；
  - P1-9：迁移授权；
  - P1-12：删掉薄封装。
  - 全表见分片 05 §3。

## 7 测试方案（明细见分片 04）

- **A 类**（约 115 例，纯库复用）：1.0.x runtime 的权限用例，包括 permissionGrants、permissionQueue、shellPolicy 与 tools、skills、mcp 里和权限相关的部分。经薄封装原样运行，P1-12 改为直接指向纯库。
- **B 类**（与引擎无关）：RPC 服务器、WorkerManager、策略解析与策略表、设置页、渲染层的卡片 / 浮层 / 审计行 / 档位入口，合计约 200 例。这些原样必须全绿，前提是 bridge 发出的事件形状与 native 完全一致。
- **C 类**（N/A，待批准）：旧 pi-permission-system 的 26 例归 P1-11 / P1-12；委派定义声明档位 3～4 例（D11）；MCP 服务器工具 2 例归 P1-10；`browser_preview`。
- **D 类**（新单测，假 DSH 上下文）：归类表的静态守卫、请求构造、pre-execute 的各种返回、guard 失败关闭、路由、「一个 callId 一张卡」、搜索过滤、setter 真正生效、sidecar、约 150 条 pwsh 命令的表驱动用例。
- **E 类**（真宿主加假网关）：S1～S17 挂进 P1-4e 的 `bridge-record.ts --check`，进 Linux CI；S18（pwsh）进 Windows CI 两路。
  - 用真实模型做 GUI 点验时，提示词要写明「点验、预期被拒、原样执行」，否则模型会自己拒绝，闸门根本没被调用。
  - 真实模型只走用户允许的渠道。
- **「全过」**：
  - A、B、D 类在同一次全量里全绿，例数写进证据；
  - E 类在 Linux CI 上全绿，S18 在 Windows 两路上全绿；
  - C 类逐项获批；
  - 静态守卫全过：setter 不是空函数、`permissionGate` 如实上报、只有一个终端应答方。

## 8 风险与未覆盖

- **需实测**（§1 第 12 条列的小实验；动手前先 `free -m` 确认内存）：
  - 子代理和 PTC 子调用经过全局 pre-execute，而且 `exec.agent` 可以归到根会话；
  - guard 能兜住短路；
  - post-execute 排在 fs-search 下游；
  - 关掉 `permission` 行后宿主能启动；
  - 取消能映射成 `ABORTED_BEFORE_DISPATCH`。
- **绕过面**：
  - PTC / workflow 的程序体能直接用 Node API，沙箱关着时只有外层调用会过闸。所以把它们当作「看不透的执行」，auto 档下也问。
  - 第三方插件只要不经工具注册表，直接调 `ctx.fs` 或子进程，就完全不过闸。这类插件靠 P1-10 的白名单审查挡住。
- **行为差异**：
  - plan 模式下能看到写工具，但调用会被拒（D8）；
  - 回退之后授权保留（1.0.x 回退后恢复，只读当前分支上的记录）；
  - 卡片挂着时 Stop，工具会显示为「未开始」，而不是「已拒绝」；
  - Windows 只有 pwsh，auto 档下会更常问；
  - 委派定义不能单独改档位。
- **后台子代理**：父回合已经结束时，子代理的调用仍可能出卡，这时卡片事件不带 requestId。要与 P1-3、P1-7 一起确认渲染层能正常处理。
- **没能确认的**：见分片 02 §8，包括 bwrap 下常见开发命令的越界率、AppArmor 限制用户命名空间的发行版上 Landlock 能否接住、用户试用官方 DSH Desktop 时沙箱是否默认开着。
- **格式与版本漂移**：DSH 升级可能新增内置工具，或改变 pre-execute 的语义。分类表的静态守卫加上 `perm-*` 金样本做第一道警报。
