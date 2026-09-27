# P1-6 分片 04 · 权限回归用例基准与 DSH 下的测试方案

Role: detail shard。上位：[P1-6 方案](../p1-6-permissions.md)。回答调研问题 1 的「现有回归用例清单」和问题 6。例数是基线 `d6e1c811` 里 `it(` / `test(` 的个数，混合文件只数和权限有关的用例。它们就是退出判据「现有权限回归用例在 DSH 下全过」的基准。

## 1 A 类：纯库复用（经 runtime 薄封装原样运行，P1-12 改为直接指向纯库）

| 文件 | 权限用例 | 覆盖 |
|---|---|---|
| `src/runtime/__tests__/permissions.test.ts` | 5 | 超时与取消在卡片和审计行上分开记录；action 只发 id、不发句子 |
| `src/runtime/__tests__/permissionGrants.test.ts` | 20 | 文件授权精确到单个文件、按工具区分；秘密文件直接拒绝；标 `ask` 的路径照问；bash 前缀授权、链式命令每段都要授权过、授权不延伸到工作区外、读不出程序名的命令不可授权；重开会话后恢复、换 mode 时清空并落盘；存储格式（v1 丢弃、最后一条为准、坏记录跳过） |
| `src/runtime/__tests__/permissionQueue.test.ts` | 14 | 一次一张卡、先来先服务；倒计时从出卡起算；排队中取消不留痕；approver 抛错时交接闸门；策略直接判定的请求不进队列；drain 与图拆除；队列位置；换 mode 作废排队请求；加宽档位收卡、收窄不动；`setGear` 保留授权 |
| `src/runtime/__tests__/shellPolicy.test.ts` | 43 | AST 判定；symlink / junction / `..`；重定向；包装词；解释器载荷；auto 下遇到解析不出的操作数照问；bypass 的五道拒绝；名字位置的命令替换；短选项和 `key=value` 操作数；分隔符折叠；Windows 路径写法（MSYS / Cygwin / `\\?\`）；策略加载（全局 deny、未信任项目、JSONC、非法策略直接失败） |
| `src/runtime/__tests__/subagentToolsPermissions.test.ts` | 8（SA10 一组） | 卡片带委派署名；拒绝规则优先于档位；inherit 跟随 bypass；作用域释放。另有 3～4 例测「委派定义声明档位」，归 C 类 |
| `src/runtime/__tests__/tools.test.ts` | 约 12 | accept-edits 与外部目录；plan 模式只允许只读 bash；D14 提示词槽位；写要审批、auto 下秘密文件仍拒绝；grep 跳过秘密文件、deny scope 深入递归；授权与 settings 变更；超时拒绝；白名单与 deny scope 优先于授权；预览截断 |
| `workerEndToEnd` / `nativeWorkerRuntime` / `skills` / `mcp` | 3 / 4 / 4 / 2 | 端到端审批与拒绝；旧 tier 迁移；播种与 setter；Stop 结算挂着的闸门；skill 的可信路径、审计行与 deny；MCP 走闸门 |

合计约 115 例，纯库的每条判定规则都覆盖到了。P1-6a 完成后这些文件一行不改，照样全绿，这本身就证明抽取没有改变行为。

## 2 B 类：与引擎无关，必须原样全绿

| 文件 | 例数 | 为什么与引擎无关 |
|---|---|---|
| `src/agent-host/__tests__/piWorkerRpcServer.test.ts` | 7（setter 与信任相关） | 用假 runtime 测 RPC 协议；DSH 用的是同一个 `PiWorkerRpcServer` |
| `src/main/services/agent-host/__tests__/WorkerManager.test.ts` | 14（D10 闸门上报 3、D14 档位跨生命周期 4、tier 7） | Main 的状态机不变 |
| `src/main/ipc/__tests__/chatPiWorkerRouting.test.ts` | 3（spawn tier） | 同上 |
| `src/shared/__tests__/piPermissionPolicy.test.ts` | 28 | 策略解析与合并 |
| `src/agent-host/__tests__/permissionPolicy.test.ts` | 18 | 随包策略表本身 |
| `src/main/services/piPermissionPolicy/__tests__/*` | 14 + 15 | 设置页读写策略文件 |
| 渲染层：`pendingPermissionDock` 13、`composerPermissions` 12、`permissionActivityRow` 16、`chatSessionsPermissionActivity` 8、`permissionGate`（store）14、`permissionTierWiring` 5、`permissionGateDegradedStatic` 4、`permissionDisplay` 2、设置页 `permissionPolicyView` 29 与 `permissionPolicyCollapse` 2 | 105 | 只消费 RuntimeEvent 与 IPC。前提是 bridge 发出的事件形状与 native 完全一致 |

native 金样本（`guiEventContract` 14 例、`nativeStreamReplay` 22 例，含权限事件）随 runtime 在 P1-12 退役。DSH 这边的对应物是 P1-4e 的 `dshStreamReplay` 加上本方案的 `perm-*` 录制场景。

## 3 C 类：判为 N/A（原因写进决策文件，待批准）

| 用例 | 例数 | 原因 |
|---|---|---|
| `agent-host` 的 `permissionPlugin`、`permissionPolicyIntegration`、`permissionPatchScript`；`main/.../terminalPermissionSystem` | 12 + 8 + 2 + 4 | 测的是旧 pi-permission-system 扩展，只服务 pi TUI。去留随 P1-11 / P1-12 |
| SA10 里「委派定义声明档位」一组（定义档位、并发的两个委派各用自己的档位、审计记档位、作用域释放） | 3～4 | DSH 的代理预设没有 `permission` 字段（D11）。P1-7 定子代理定义的去向时再议 |
| MCP 服务器工具走闸门 | 2 | dsh-base 只有 `mcp-resources` 三个读资源的工具，没有 MCP 服务器工具。MCP 的去向归 P1-10，届时补 |
| `browser_preview` 走闸门 | 散见于 tools 用例 | DSH 没有这个工具（P1-4 分片 01） |

## 4 D 类：DSH 适配层新单测（根 vitest，假 DSH 上下文，不起宿主）

- **归类表**：所有 DSH 内置工具名都归了类；出现新的内置工具名时静态守卫失败。
- **请求构造**：`file_path` / `path` / `workdir` 的解析与 canonical；带升级参数时记为 escalation；spill 根下的路径算可信；pwsh 走 `pwshAnalysis`。
- **pre-execute 的返回**：allow → `next()`；三类拒绝分别带什么 `info`；取消返回 `cancel`；`exec.signal` 在卡片挂着时 abort 会怎样；审批之后路径变了会怎样。
- **guard 失败关闭**：模拟另一个监听者不调 `next()` 就返回 allow。
- **路由**：子会话归到根会话；归属不到时拒绝；回退后重新登记；dispose 后注销。
- **应答方**：同一 callId 只出一张卡；bypass 自动答；第三方插件的 `ask` 进同一个队列。
- **post-execute**：glob / grep 过滤之后，fs-search 不再写 spill。
- **setter**：`applied` 必须真正生效（静态守卫：bridge 的 setter 不能是空函数）；DSH 自发回合进行中换 mode 报 busy；闸门没装上时报 `WORKER_PERMISSIONS_UNAVAILABLE`；bootstrap 结果里 `permissionGate` 如实上报。
- **sidecar**：原子写；丢弃不认识的版本；`configure` 写空集；bootstrap 读回；fork 复制；GC 删除。
- **pwsh 分析**：表驱动，约 150 条命令，覆盖别名、重定向、路径参数、判为解析不出的每种构造、exploration。
- **提示词上下文**：各 mode 与档位下的文本。

## 5 E 类：集成场景（真 DSH 宿主 + 假网关）

- **挂载方式**：挂进 P1-4e 的 `bridge-record.ts --check`，场景名以 `perm-` 开头。假网关按场景标记回放固定的工具调用，不接任何真实模型或 provider。Linux 进 CI。
- **Windows 子集**走 Windows CI，管理员和标准用户各跑一路（P1-14）。**推送前要用户确认**。

| # | 场景（档位） | 判定 |
|---|---|---|
| S1 | ask：工作区内 write → 卡 → 允许一次 / 拒绝 | 文件写入或未写；工具行显示「已允许」或「已拒绝」；审计行 |
| S2 | ask：write 选「本会话允许」→ 再写同一文件 → 再写另一文件 | 第二次不出卡；第三次出卡；sidecar 里有这个文件 |
| S3 | ask：`echo a` 选「本会话允许」→ `echo b` → `echo c && rm x` | 第二次不出卡；第三次出卡（`rm` 没授权过） |
| S4 | bypass：读 `.env`、`cat ~/.ssh/id_rsa` | 直接拒绝，不出卡 |
| S5 | ask 与 auto：读工作区外的文件 | ask 下出卡；auto 下放行 |
| S6 | accept-edits：工作区内写与 bash、工作区外写 | 前两者不出卡；工作区外写出卡 |
| S7 | auto：`echo $X > f` 与 `echo a > f` | 前者出卡，后者放行 |
| S8 | bypass：S7 的第一条命令 | 放行 |
| S9 | plan：write、`git status`、`touch f` | 拒绝、放行、拒绝 |
| S10 | ask：卡片挂着时 `setPermissionGear(auto)` | 卡片以 allow 收起，调用继续执行 |
| S11 | ask：一步里并行三个写 | 卡片依次出，队列位置显示 1/3、2/3、3/3 |
| S12 | ask：倒计时调短 | `timed_out` 拒绝，审计行显示超时 |
| S13 | ask：卡片挂着时 Stop | 卡片以 `aborted` 结算；工具显示为未开始；回合在 10 s 内收尾 |
| S14 | 回合中换 mode 与换档位 | 换 mode 报 busy；换档位生效 |
| S15 | 授权后 SIGKILL 宿主 → 恢复 → 再次同样调用 | 不出卡（sidecar 读回）；之后换 mode，授权被清空 |
| S16 | 子代理在 ask 下 write | 卡片带子代理署名，允许后写入 |
| S17 | grep 命中工作区里的 `server.key`；glob 列出 `.env` | 结果里没有这两项，spill 里也没有 |
| S18 | Windows：pwsh 的 S1、S3、S4、S7 | 与 Linux 结论相同；工作区的 ACL 没有被改动（沿用 P0-4 的 F-off-acl 检查） |

- **沙箱叠加开关**（D5 的 B，或以后打开时）另加：升级只出一张卡；静态可见的越界直接拒绝并引导升级；Windows 上 WRITE_OWNER 预检不满足时退回。
- **开发机 GUI 点验**：按 CDP 配方走 S1、S2、S10、S13、S16。
  - 用真实模型点验时，提示词要写明意图：这是点验、预期会被拒、请原样执行。否则模型遇到 `~/.ssh/id_rsa`、`curl example.invalid` 这类请求会自己拒绝，闸门根本没被调用。
  - 真实模型只走用户允许的渠道；调研与实现代理不自行调用任何 provider。

## 6 「全过」的判定口径

1. A、B 两类在同一次全量 vitest 里全部通过。例数写进证据，逐个文件列出。
2. D 类全部通过。
3. E 类在 Linux CI 上全部通过，S18 在 Windows CI 两路（管理员、标准用户）上都通过。
4. C 类的每一项都在决策文件里列明原因，并获用户批准。没批准的项回到 A、B、D、E 里补齐。
5. 静态守卫通过：
   - bridge 的 setter 不是空函数；
   - `permissionGate` 不再无条件写 `'bundled'`；
   - 产品 bundle 里只有一个 `approval/request` 终端应答方（`aiclient-probe` 已按 P1-2 D5 移出产品）。
