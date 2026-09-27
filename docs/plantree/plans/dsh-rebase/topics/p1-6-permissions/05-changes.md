# P1-6 分片 05 · 改动清单、切分与边界

Role: detail shard。上位：[P1-6 方案](../p1-6-permissions.md)。回答调研问题 7。规模都是粗估，单位为行，「搬」指从 runtime 原样搬出的行数。文件名是建议名。

## 1 子任务与文件

### P1-6a 纯库抽取（约 0.5～0.8 人周）

- **可提前开工**：不依赖 P1-3 / P1-4，与在做的代理没有文件重叠。只有 P1-0 式的 main 同步会和 `src/runtime/plugins/permissions/` 冲突，见 §3 第 1 条。

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/shared/permissions/gate.ts` | 把 `PermissionsPlugin`（`index.ts:318-793`）去掉 Cordis `Service`，改成 `PermissionGate` 类，注入 `persistGrants`、`approve`、`autoAllow`；再加 `isShellTool` | 搬 ≈ 620，新 ≈ 60 |
| `src/shared/permissions/{grants,policy,pathPolicy,windowsPaths,activity,promptText}.ts` | 从 runtime 原样搬过来。`policy` 的读文件改为注入；`grants` 不再从 `session/legacy.ts` 引常量，改为在本库定义 `aiclient.permissionGrants` | 搬 ≈ 800，新 ≈ 40 |
| `src/shared/permissions/shellPaths.ts` | 抽出 `target()`、`checkShellPaths()`、`canonicalPath`（`tools/index.ts:191-315`），文件系统注入 | 搬 ≈ 130，新 ≈ 30 |
| `src/shared/permissions/cardEmitter.ts` | 抽出 `worker/permissionPrompt.ts` 的全部逻辑 | 搬 ≈ 280 |
| `src/shared/permissions/bashWalker.ts` | 抽出 `bash-analysis.ts` 的遍历逻辑，SyntaxNode 改成结构类型，Parser 由调用方注入 | 搬 ≈ 380，新 ≈ 30 |
| `src/runtime/plugins/permissions/*`、`tools/index.ts`、`worker/permissionPrompt.ts` | 改成薄封装：`PermissionsPlugin` 继承 Service，委托 `PermissionGate`；runtime 继续用自己的 wasm 装载 | 净删 ≈ 1.8k，新 ≈ 150 |
| `src/shared/permissions/__tests__/` | 注入缝和 `isShellTool` 的少量新用例 | 测 ≈ 200 |

### P1-6b 宿主插件与钩子（约 1～1.5 人周）

- **依赖**：P1-3a（共享 bridge 与虚拟 slot），以及 P1-4a 的事件映射骨架。

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/dsh-host/permissions/plugin.ts`（新；bundle 入口 `lib/permissions.js`） | 会话路由、`tools/pre-execute`（prepend）、guard、`tools/post-execute`（glob / grep 过滤）、`approval/request` 终端应答方、systemPrompt 上下文 | ≈ 450 |
| `src/dsh-host/permissions/{classification,requestBuilder,treeSitter}.ts`（新） | 工具归类表；把 DSH 的 exec 转成 `ToolPermissionRequest`；装载 wasm | ≈ 450 |
| `src/dsh-host/bridge/dshSessionRuntime.ts` | 每个 slot 一个 `PermissionGate`，bootstrap 时 attach、dispose 时 detach；`respondPermission` 改走 gate；删除 `ask()` 和 `approval/request` 监听；`permissionGate` 如实上报；卡片的 emit 带上 requestId | 改 ≈ 150 |
| `src/dsh-host/bundle/cordis.patch.yml`、`bundle/package.json`、`src/dsh-host/package.json` | 新行 `aiclient-permissions`；关掉 `permission` 行；`sandbox-policy` 与 `approval` 改为字面值；新依赖 `web-tree-sitter`、`tree-sitter-bash` | ≈ 60 |
| `src/shared/types/runtimeEvents.ts`、`questionCardModel.ts`、`zhTranslations` | action 新增 `escalate_sandbox`，加一条英文 key 和对应中文（精修归 P1-7） | ≈ 15 |
| `src/dsh-host/permissions/__tests__/*`、`bridge/__tests__/dshSessionRuntime.test.ts` | 分片 04 D 类，不含 sidecar 与 pwsh | 测 ≈ 850 |
| `src/dsh-host/bridge-record.ts` 的场景与假网关 | 分片 04 E 类的 S1～S17 | 测 ≈ 300（与 P1-4e 同步） |

### P1-6c 授权记忆与档位（约 0.5 人周，可与 b 同批）

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/dsh-host/permissions/grantStore.ts`（新） | sidecar 的读、写（原子）、复制、删除 | ≈ 120 |
| `dshSessionRuntime.ts` | 三个 setter 真正落地；判断空闲时把 DSH 自发的回合也算上；按 payload 播种；读策略时 `agentDir` 取自 `AICLIENT_PERMISSION_AGENT_DIR`；预留沙箱映射的钩子（开关关着时为空操作） | ≈ 150 |
| `src/main/services/agent-host/DshHostProcess.ts`（或 P1-3 的 supervisor） | 设置 `AICLIENT_PERMISSION_AGENT_DIR`；剔除用户环境里的 `DSH_*` | ≈ 15 |
| P1-4b 的 fork / discard 与 P1-3 的 GC | 调用 grantStore 复制或删除 sidecar | 各 ≈ 10 |
| 测试 | sidecar、setter、播种 | 测 ≈ 450 |

### P1-6d Windows / pwsh（约 1 人周）

- 在 b 之后做。要跑 Windows CI 就得推送分支，**推送前需用户确认**。

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/shared/permissions/pwshAnalysis.ts`（新） | 保守的词法分析：别名、路径参数、重定向、判为解析不出的构造、exploration（分片 03 §11） | ≈ 450 |
| `gate.ts`、`grants.ts` | 按 pwsh 归一前缀；策略面统一为 `bash` | ≈ 40 |
| `.github/workflows/`（沿用 `dsh-p0-windows.yml` 的形态，或并入 P1-14 的 Windows CI） | 管理员和标准用户两路跑 S18 | ≈ 150 |
| 测试 | 表驱动约 150 条 | 测 ≈ 500 |

### P1-6e 沙箱叠加开关（可选，约 0.8 人周）

- 只有 D5 选 B / C，或者 P1-13 之后要开放开关时才做。

| 内容 | 规模 |
|---|---|
| 设置项从 Main 传到 bootstrap（每个安装一份）；档位对应的 `sandbox/mode` 写入；升级卡合并与带沙箱标记的升级授权；静态可见的越界直接拒绝并引导升级；Windows 的 WRITE_OWNER 预检与退回；Linux 越界率测量脚本 | 产品 ≈ 500，测 ≈ 400 |

**合计（a～d）**：产品约 4.5k 行，其中原样搬出约 2.2k，净新增约 2.3k（含 Windows CI 约 150）；测试约 2.3k 行。约 3～4 人周（粗估，不含 e）。

## 2 顺序

1. a：现在就可以做，是纯重构。runtime 的全部权限用例一行不改，照样全绿，就是它的验收。
2. P1-3a 之后做 b 与 c。E 类场景跟着 P1-4e 的录制骨架一起落。
3. d 排在 b 之后，Windows CI 推送前确认。
4. e 视 D5 的结论而定，可以放到合入之后。
5. 全量测试只在收口时跑一次（按工作方式）。并行代理最多 2 个。

## 3 边界

| 任务 | P1-6 要它做的 / 交给它的 |
|---|---|
| main 同步（P1-0 式） | a 之后，main 上对 `src/runtime/plugins/permissions/` 的修复会在合并时冲突。这是有意为之：冲突逼着人把修复搬进纯库。选了「复制」就会悄悄漏掉修复（D1） |
| P1-2 | 宿主包带上两个 wasm（约 1.6 MB，MIT），删除式裁剪不能删 `.wasm`；第三方许可清单加两条。**所有冒烟脚本**（`bridge-smoke.ts`、打包冒烟、`goal-probe.ts`、`p0-6-probe.ts`）要显式设 `bypass` 或去应答卡片，否则 bash 会卡满 120 s 后被拒 |
| P1-3 | 路由挂在共享 bridge 之下；宿主环境带 `AICLIENT_PERMISSION_AGENT_DIR`、剔除 `DSH_*`；GC 连同 sidecar 一起删；Stop 阶梯依赖闸门观察 `exec.signal`（分片 03 §3）；S5 卡死场景的「审批处理器不理会 abort」改由测试 bundle 模拟 |
| P1-4 | `approval/request` 的透传改由 `aiclient-permissions` 接管；`session.projection` 不再有 `permissions`（预设行关掉了），`sandboxMode` 保留；命令列表隐藏 `/permission`、`/plan`；拒绝时 `tool/result` 的 `error.info` 形如 `{name:'PermissionDenial', code:'tool_denied', reason}`，供 `tool.completed` 映射；取消时为 `ABORTED_BEFORE_DISPATCH`，映射成 `notStarted`；P1-4b 的 fork 复制 sidecar；P1-4e 录制门禁里加 `perm-*` 场景 |
| P1-5 | 如果以后重新打开 `tool-web`，`web_fetch` / `web_search` 按未知工具走 `'*': 'ask'`，或者归进分类表 |
| P1-7 | 文案：`escalate_sandbox`、pwsh 工具行、Windows 版文案；子代理卡片署名的 join 键用子会话 id；委派定义的 `permission` 字段去留 |
| P1-9 | 从 pi 会话的 `aiclient.permissionGrants` 条目迁移出 sidecar；会话档位在 localStorage 里按逻辑 id 存，不用迁移 |
| P1-10 | 第三方插件的工具默认走 `'*': 'ask'`，白名单审查时决定是否归进分类表；MCP 服务器工具走闸门的方案随 MCP 去向一起定 |
| P1-12 | 删掉 runtime 的薄封装，A 类用例改为直接指向纯库；C 类里旧 pi-permission-system 的用例随 TUI 去留处理 |
| P1-13 | 加密机上测 F-on / F-off 与 F-on-acl，回答 Q002 的 Windows 部分 |
| P1-14 | Windows CI 两路跑 S18；出测试版后到 Windows 实测 pwsh 在 auto 档下弹卡的频率 |
