# 统一 agent 目录、资源迁移与插件管理

Role: implementation-plan。日期：2026-09-10。依据：用户 2026-09-10 决定「本地模式和登录模式都工作在我们的目录，同时在软件中支持把 skill、AGENTS.md 迁移到我们的目录，插件也在我们自己目录里」。

## 起因：H/17 暴露的缺陷

H/17 让本地模式在「用户加了服务」时把 `PI_CODING_AGENT_DIR` 指向本应用目录。当时只把 skills / prompts / `AGENTS.md` 通过借用机制搬了过来，遗漏了两样：

- 用户原有 `~/.pi/agent/models.json` 里的 provider **从模型选择器消失**，凭据也不再被读到。
- 会话目录跟着 agent 目录走（pi 的 SessionManager 默认 `<agentDir>/sessions/<编码后的cwd>/`），用户在自己终端跑 `pi` 就找不到这些会话。**这一条 2026-09-10 已决定不管**（范围收窄为只保证本应用内 GUI/TUI 能找到），但它说明了搬动 agent 目录的副作用不止于模型配置。

真正要修的是第一条。修法不是运行时合并，而是把「搬动」做成一次显式、完整的迁移。

## 本轮决定

- **两种模式一律使用本应用的 agent 目录**。不再有「加了服务才搬」这种条件分支——条件分支正是上面那个缺陷的来源。托管模式本就如此，本地模式改为一致。
- **迁移一律用复制，保留用户原文件**。用户目录只读不写这条边界不变；复制过来之后，修改在我们的目录里进行，用户原来的 `~/.pi/agent` 不受影响。
- **迁移范围三样**：skills、`AGENTS.md`、以及**已有的模型服务**（把 `~/.pi/agent/models.json` + `auth.json` 里的 provider 一次性导入 vault 的用户组）。第三样是 H/17 缺陷的正解：数据形状本来就与 `UserProvider` 一致，导入后用户在设置页里就能看到和管理。
- **迁移完成后废弃借用机制**。`AICLIENT_PI_BORROW_RESOURCES_DIR` 那条运行时借用路径可以整个删掉，少一层。删除时机在迁移能力可用之后。
- **插件复用 pi 自己的 install / remove / list，不自建插件管理器**。PI-Desktop 的方案（`crates/host-core/src/plugins.rs`，4521 行 / 134 个函数，含 installed / disabled / data / market / cache 五个目录和一套清单校验）用户已明确判定太重，不采用。

## pi 插件机制实测

`pi install <source>` 的落点就是 agent 目录，因此**统一 agent 目录之后，插件天然就在我们的目录里，不需要任何搬迁**：

```
$PI_CODING_AGENT_DIR/settings.json          → {"packages":["npm:@juicesharp/..."]}
$PI_CODING_AGENT_DIR/npm/node_modules/...   → 包本体
```

- 来源支持 npm、git、GitHub URL、ssh、本地路径。
- `remove` 是真卸载：settings 里的行与 `node_modules` 下的文件一并删除。
- `list` 输出包名与解析后的绝对路径，够界面直接用。

**注意事项**：

- `install` 会联网跑 npm，实测约 8 秒且可能失败，界面需异步与错误反馈，不能同步阻塞。
- `-l`（项目级 `.pi/settings.json`）在托管模式下无效——`AICLIENT_PI_TRUST_PROJECT_CONFIG` 为 `'0'` 时项目级配置整体不生效。界面不应提供该选项，否则装了没反应。
- 现有随包清单（`bundledPlugins.mjs`）保持不变，它解决的是「随产品分发」，与用户自装是两件事。

## 插件冲突：由用户负责（2026-09-10 决定）

用户自装的插件是可执行代码，其中最敏感的是用户自带的权限系统副本。用户 2026-09-10 决定：**装出问题由用户自己负责**，不为此阻塞插件功能。

这条落地起来比预想的自然，因为机制本就不是静默撞车（`permissionPlugin.ts:468-486`）：

| 情况 | 判定 | 行为 |
|---|---|---|
| 用户在 `packages` 里配了权限系统 | `user_configured` / `gated: true` | 我们**主动让路**，用他那份 |
| 只有随包那份 | `bundled` / `gated: true` | 用随包的 |
| 两份都没有 | `missing` / `gated: false` | 启动抛 `PermissionGateUnavailableError`，明确报「工具审批不可用」 |

所以要补的只有一件事：**界面如实显示当前审批用的是哪一份**（随包 / 用户自配）。这不是拦阻，是让接管的人知道自己接管了什么。

### 为什么不做进程级插件隔离

PI-Desktop 的隔离**不在它的 Rust 宿主里**（此前本文的说法有误）——按其 ADR 0008，是 Electron 侧的 `plugin-host-process.mjs` 用 `utilityProcess.fork` 一插件一进程，配 `plugin-runtime.ts` 做 RPC 中转：每个 `pi.*` 调用先过 `HOST_API_ALLOWLIST`、再过 `assertPermission`、再到宿主服务、最后写审计日志。那个 4521 行的 Rust 文件是插件**管理器**，不是沙箱。

技术栈上我们能做同样的事（也是 Electron，`utilityProcess` 已在用，且这部分是 TypeScript）。不做的原因是结构性的：**PI-Desktop 的插件调的是它自己的 `pi.*` API，所以中间架得起关卡；我们的插件是 pi 的扩展，由 pi 加载、跑在 agent 进程内、调 pi 自己的 API，这条链路不经过我们，没有地方架关卡。**要架就得自建一套插件 API 并停用 pi 的扩展加载——那正是用户已判定过重的那个模型。

ADR 0008 的四个目标里，**崩溃非致命我们天然满足**：pi worker 本来就是独立进程，插件崩溃不拖垮主进程。

## 执行清单

全部实现完成（2026-09-10），[验证记录](../evidence/unified-agent-directory/README.md)。尚未打包、未现场点验。

- [x] U1：agent 目录解析改为两种模式一致；删除 H/17 引入的条件分支。
- [x] U2：迁移能力（复制）——skills、`AGENTS.md`、模型服务导入 vault 用户组；明确的确认步骤，冲突时不静默覆盖。
- [x] U3：会话目录随 agent 目录统一。用户 2026-09-10 决定不管用户自己终端里的官方 `pi` 能否找到，只保证**本应用内**的 GUI 与 TUI 能找到历史对话；官方支持等其后续版本。
- [x] U4：插件界面——列表、安装、卸载、启用开关，全部调 pi 的 install/remove/list；同时显示当前审批用的是随包还是用户自配的权限系统。
- [x] U5：迁移完成后移除借用机制与相关 env。
- [x] U6：验证（自动化 + 真实 CLI 冒烟；现场回归未做）。

### 落地时的两项范围调整

1. **迁移项从三样变五样**，多了 prompt templates 与会话目录。原因是 U5 要删的借用机制同时覆盖 prompts 和 `AGENTS.md`，而会话目录跟着 agent 目录搬家；只搬三样会让用户的 prompt templates 静默消失、本应用里已有的历史对话找不到。两项在界面里单独列出、可单独取消勾选。
2. **权限策略页在本地模式变为可写**。此前只读的理由是「本地模式的 global scope 就是用户自己的 `~/.pi/agent`」——U1 之后这条前提不成立了。红线改由目录解析器保证（根本不指向 `~/.pi/agent`），而不是靠拒绝写入。

## 验证案例

1. 全新用户（`~/.pi/agent` 为空）两种模式下都正常，无迁移提示。
2. 已有 skills / `AGENTS.md` / models.json 的用户：迁移后三样都在我们目录生效，**原文件仍在原处未被修改**；导入的服务出现在设置页 AI 服务列表里并可编辑。
3. 重复执行迁移不产生重复条目、不覆盖用户在我们这边的后续修改。
4. 安装一个 npm 插件后会话里真的可用；卸载后文件与配置都消失；安装失败有明确原因。
5. 托管模式下项目级插件仍然不生效，且界面不提供该入口。
6. 用户自配权限系统时界面明确显示「审批由你自己配置的权限系统接管」；两份都缺失时启动报错可读。
7. 本应用内的 GUI 与 TUI 都能列出并打开迁移后的历史对话。

## 范围外

不做插件市场、版本管理、禁用目录、进程级插件隔离（理由见上）。不保证用户自己终端里的官方 `pi` 能找到本应用的会话。
