Role: detail shard

# P1-10 / P1-16 分片 04 · 改动清单、边界、实验与测试

上位：[P1-10 / P1-16 方案](../p1-10-p1-16-extensions.md)。回答调研问题 7（改动与切分），并给出测试方案。设计依据见[分片 03](03-design.md)。行数是粗估，「搬」指从 `src/runtime` 移到 `src/shared` 的现成代码。

## 1 改动清单（按子任务）

### P1-10a 白名单与构建期审计（约 300 / 400 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/dsh-host/plugins/allowlist.json`（新） | 清单；首批按 D5 | 20 |
| `src/shared/dshPluginAllowlist.ts`（新） | 清单模式、双键核对、补丁审计、bundles 目标列表的纯函数，宿主与构建脚本共用 | 180 |
| `scripts/dsh-host-build-lib.mjs`（P1-2 新建） | 插件步骤：兼容、补丁审计、体积、许可、敏感 API 报告，写 manifest 的 `plugins` 段 | 100 |
| `src/dsh-host/package.json` 与锁文件 | 加插件依赖；删 `pnpm` | — |
| `scripts/packaging-budget.mjs` | 单插件上限；总上限重定 | 20 |
| 测试：`src/shared/__tests__/dshPluginAllowlist.test.ts`、`scripts/__tests__/dsh-plugin-allowlist.test.mjs`（新），夹具：好补丁、改隐私行的补丁、关权限行的补丁、插非白名单模块的补丁、peer 不兼容的包 | | 400 |

### P1-10b 宿主装载与审计（约 200 / 300 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/dsh-host/host.ts` | bundles 重申扩成「产品 + 启用 ∩ 清单」；`userLayer: false`；`REQUIRED_DISABLED` 加两行；必须启用的行；未声明行的审计；`ready` 带插件状态；删 `packageManager` | 120 |
| `src/dsh-host/bundle/cordis.patch.yml` | `plugin-manager` 改为关闭，删 registry 配置 | 10 |
| Main 的 `DshHostSupervisor` / `DshHostProcess.ts`（P1-3b 在改） | 下发启用集合（`configure` 或环境变量）；把 `ready` 里的插件状态交给插件服务 | 40 |
| 测试：reconcile 与审计的纯函数单测；`tools/bridge-smoke.ts` 加 PLG-2、PLG-3 | | 300 |

### P1-10c 设置页与 IPC（约 350 / 400 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/main/services/dshPlugins/DshPluginService.ts`（新） | 读产物清单与设置；`setEnabled` 排队 `invalidateAll`；读旧 pi 扩展列表（不调 pi CLI） | 150 |
| `src/main/ipc/dshPlugins.ts`（新）、`src/shared/dshPlugins.ts`（新）、`src/shared/types/ipc.ts`、`src/preload/index.ts` | `dshPlugins:list` / `dshPlugins:setEnabled` | 60 |
| `src/renderer/components/settings/DshPluginsSettings.tsx`（新）、`SettingsContent.tsx:134-140` | 替换 `PiPluginsSettings` | 150 |
| `src/renderer/components/workspace-shell/LeftDock.tsx:536-540`、i18n | 文案 | 10 |
| 测试：服务单测；渲染层挂载测试（`electronAPI.settings` 桩放进 `vi.hoisted`） | | 400 |

P1-12 删掉 `PiPluginService` 的安装部分、`src/main/ipc/piPlugins.ts`，以及 `src/shared/piPlugins.ts` 里只给安装用的部分。

### P1-10d 试点插件（约 100 / 300 行，另有审查记录）

| 文件 | 改动 |
|---|---|
| `src/dsh-host/plugins/reviews/dsh-office-tools@1.0.4.md`（新） | 按分片 03 §6.2 写的审查记录 |
| P1-6 的分类表（`src/dsh-host/permissions/*`） | 8 个工具的过闸分类与路径参数 |
| `src/dsh-host/tools/bridge-smoke.ts`、`scripts/packaged-dsh-host-smoke.mjs` | PLG-1；打包冒烟带一个已启用插件 |
| `.github/workflows/*` | Windows 两路跑 PLG-1（推送前确认） |

### P1-16a 指令与技能（约 400 / 600 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/dsh-host/host.ts` | 由 `<agentDir>` 生成 `agent-instructions`、`skill-filesystem` 两行 overlay | 30 |
| `src/dsh-host/extensions/instructions.ts`（新，打进 bundle 的 `lib/`，占新行 `aiclient-instructions`） | 用户层三选一注入 | 120 |
| `src/shared/skills/{frontmatter,loader}.ts`（搬自 `runtime/plugins/skills/loader.ts`）、`compat.ts`（新） | 兼容报告 | 搬 250 + 新 120 |
| bridge 的 commands / capabilities 模块（P1-4 拆出） | `/skill:` 改写；`capabilities.skillIssues` | 60 |
| `PiResourcesSettings.tsx`、`main/services/piModelConfig/index.ts:336-354` | 报告与说明 | 80 |
| 测试：compat 表驱动；INS-1、SKL-1 | | 600 |

### P1-16b MCP（搬约 1.1k，新约 500 / 测试约 900 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/shared/mcp/{config,client,naming,results}.ts`（搬自 `runtime/plugins/mcp/*`） | 纯逻辑；客户端改为吃抽象的双工流 | 搬 1.1k |
| `src/runtime/plugins/mcp/*` | 改薄封装，旧用例原样跑 | −900 / +120 |
| `src/dsh-host/extensions/mcp.ts`（新，行 `aiclient-mcp`） | 按 slot 连接；`ctx.subprocess` 起进程；在 scope 里注册工具；资源提供者；关闭时回收 | 350 |
| P1-6 分类表 | `mcp__*` → `mcp` 面 | 30 |
| bridge capabilities | `mcpServers` | 20 |
| 测试：`mcp.test.ts` 迁到 shared 跑；宿主插件单测（假 subprocess）；MCP-1 | | 900 |

### P1-16c 模板与斜杠命令（搬约 350，新约 150 / 测试约 350 行）

| 文件 | 改动 |
|---|---|
| `src/shared/skills/{templates,expand}.ts`（搬） | 纯逻辑 |
| bridge commands 模块 | 合并 DSH 命令、模板、技能；展开顺序；遮蔽报告 |
| 测试 | `skills.test.ts` 里模板与展开的用例迁到 shared；TPL-1 |

### P1-16d 子代理定义（约 500 / 500 行）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/shared/subagentCatalogRoots.ts`（搬自 `runtime/plugins/subagent/catalog.ts`） | 根、合并、内置 | 搬 150 |
| `src/dsh-host/extensions/delegates.ts`（新，行 `aiclient-delegates`） | 委派工具、字段映射、可选的轮数上限 | 350 |
| overlay | 委派总开关关掉时关 `tool-subagent*` | 20 |
| `PiSubagentsSettings.tsx` | 说明文字 | 30 |
| 测试：映射表驱动；SUB-1 | | 500 |

合计：P1-10 约 1.5～2 人周，P1-16 约 3～4 人周（其中 MCP 约 1.5 人周）。

## 2 与其他任务的边界

| 任务 | 本方案要它做什么，或给它什么 |
|---|---|
| P1-2 | 构建脚本留出插件步骤的接口；体积预算与许可清单覆盖插件；打包冒烟能带插件。决策 016 由本方案 D3 收口，「打包态默认指向随包 pnpm」可以不做 |
| P1-3a | `reconcileProductBundles` 扩成带清单与启用集合；overlay 加两行；`ready` 带插件状态；插件 bundle 跳过只告警 |
| P1-3b / P1-5a | `configure` 带上 `<agentDir>` 与启用集合；落地前先用环境变量 |
| P1-4d | `commands()` / `capabilities` 模块化，本方案往里加模板、技能、MCP 字段 |
| P1-5 | 凭据提供者能否按调用方限制（E8）；IPC 上的凭据应答对同进程插件可见（决策 034 第 4 条只覆盖了工具进程） |
| P1-6 | 分类表加 `mcp__*` 与白名单插件的条目；`AICLIENT_PERMISSION_AGENT_DIR` 并到同一份 `<agentDir>` 下发；C 类里的 MCP 两例由 P1-16b 补回 |
| P1-7 | 子代理面板（两类委派都是 DSH 子会话）；插件工具行的文案；`/skill:` 写法的去留 |
| P1-9 | 不迁资产；H/19「数据迁移」页照旧复制进 `<agentDir>`，DSH 构建原地读到 |
| P1-11 | pi TUI 的去留决定 D12 的呈现 |
| P1-12 | 删 runtime 之前，先完成 16a、16b、16c、16d 的搬迁；删 `PiPluginService` 等 |
| P1-13 | 检查单加两项：MCP 服务器、插件工具起的子进程在加密机上读写明文 |
| P1-14 | Windows 两路 CI 跑 PLG-1、MCP-1 |

## 3 开工前实验（每个一个脚本；动手前先 `free -m`，与全量测试错开）

| # | 问题 | 做法与判据 | 服务于 |
|---|---|---|---|
| E1 | 关掉 `plugin-manager`、`tool-plugin-manager`，profile 用户层不参与组合，宿主还能起吗 | 改 bundle 补丁后跑 `tools/measure.ts smoke` 与 bridge-smoke：ready、census 没有新增的未激活行、工具回合正常 | D3 |
| E2 | 插件作为宿主依赖时，npm 怎么解析 peer | 在 `src/dsh-host` 的临时副本里加 `dsh-office-tools@1.0.4`，跑 `npm install --package-lock-only` 与 `npm ci --ignore-scripts`；记下有没有 `ERESOLVE`，有就试 `overrides`；核对锁文件的 integrity 与 registry 的 `dist.integrity` 一致。要联网，在 CI 上或经授权做 | D2 |
| E3 | 安装范围的插件 bundle 能不能从只读的安装目录加载 | 构建出带插件的 `out-dsh-host`，profile 清单加上它，把目录设成只读后起宿主；工具清单里有 `word_*` | D2 |
| E4 | 插件能不能把工具注册在某个会话的 scope 里 | 测试插件在会话 A 的 agent scope 里注册工具；A 看得到，B 看不到；记下 A 的子代理看不看得到 | D7 |
| E5 | `ctx.subprocess` 能不能跑 MCP 的双向流，进程会不会被回收 | 用 `src/runtime/__tests__/fixtures/mcp-echo-server.mjs`，`stdio: 'pipe'` 往返一次；SIGKILL 宿主后没有孤儿进程（Linux 本机，Windows 在 CI） | D7 |
| E6 | `dshHome`、`customSkillDirs` 的 overlay 生不生效 | 假网关抓首个请求：带 `<agentDir>/AGENTS.md` 的内容；技能目录里有 `<agentDir>/skills` 下的技能 | D8、D9 |
| E7 | 插件能不能调 `ctx.subagents.start` 并带 persona 与 toolFilter | 假网关抓子代理的请求：有 persona 段，没有被过滤掉的工具 | D11 |
| E8 | 凭据提供者能不能认出调用方；插件能不能读到 IPC 上的凭据应答 | 测试插件调 `ctx.credentials.resolve`，看提供者能不能拿到调用方的上下文；测试插件挂 `process.on('message')`，预期能看到应答。结论转给 P1-5 | 安全 |

## 4 测试方案

### 4.1 单测（根 vitest，不装 DSH）

- 白名单：清单模式；清单、`package.json`、锁文件三方一致；补丁审计的好样本与坏样本（改隐私行、关权限行、插非白名单模块）；兼容判定用 DSH 同款规则。
- bundles 重申：全新安装、保留用户启用项、剔除未入清单的、下架、`replaces` 改名、重复执行结果不变。
- 启动期组合审计：必须启用的行、必须关闭的行、未声明的行。
- 技能兼容报告：表驱动覆盖缺 `name`、大写与下划线、多层目录、`.pi/skills`、中间目录的 `.agents/skills`、同名冲突。
- 模板与展开：`skills.test.ts` 里的相关用例迁到 shared，一行不改地跑过，证明搬迁没有变形。
- MCP：`mcp.test.ts` 的配置合并、命名、JSON-RPC 帧、结果折叠用例迁到 shared；宿主插件用假 subprocess 测连接、超时、关闭回收、scope 注册。
- 子代理映射：工具补集（含 Windows 的 pwsh）、`{{` 转义、模型钉选与档位的翻译、停用名单。
- 设置页与服务：插件列表、开关排队、旧 pi 扩展只读列表；渲染层挂载测试的 settings 桩放进 `vi.hoisted`。

### 4.2 真宿主（bridge-smoke 风格，假网关，进 Linux CI）

| 场景 | 内容与判据 |
|---|---|
| PLG-1 | 试点插件从安装范围加载；`word_create` 出审批卡，允许后写入工作区；全程零非回环连接、零 DNS、没有 pnpm 进程、不写 `~/.cache/pnpm`（复用 `probe-hooks` 钩子） |
| PLG-2 | 插件关闭后工具消失；peer 不兼容的夹具插件：宿主照常起，`ready.plugins.skipped` 有记录 |
| PLG-3 | 篡改 profile 清单加入非白名单 bundle：被剔除并告警；home 层补丁插入未声明的行：产品态拒绝启动 |
| INS-1 | `<agentDir>/AGENTS.md`、家目录用户层文件、项目 `CLAUDE.md` 三类内容都进首个请求 |
| SKL-1 | `<agentDir>/skills` 与 `~/.agents/skills` 的技能都在目录里；`/skill:x` 触发注入；不合规的技能出现在报告里 |
| TPL-1 | `/review 123` 先按模板展开，再交给 DSH；与 DSH 命令同名的模板被遮蔽并报告 |
| MCP-1 | echo 服务器：工具只在本会话可见；调用过闸；资源工具出现；会话关闭后进程被回收；cwd 是会话工作区 |
| SUB-1 | 自定义定义委派：子代理带 persona，调不到定义之外的工具 |

### 4.3 CI 与打包冒烟

- Windows CI（管理员与标准用户两路）：PLG-1、MCP-1。MCP 服务器要经 runner 与 Job 起。推分支前需用户确认。
- 打包冒烟：P1-2 的 L1 冒烟带一个已启用插件，加断网断言。

### 4.4 GUI 点验

- 插件开关后宿主重启，工具可用；pi 扩展的只读说明；技能兼容报告；MCP 服务器出现在能力弹窗里。
- 用真实模型点验插件工具的过闸时，提示词要写明「点验、预期要审批、原样执行」，否则模型可能自己拒绝，闸门根本没被调到。

### 4.5 退出判据对照

- P1-10「白名单插件离线可装可用」：PLG-1 在 Linux CI、Windows 两路、打包冒烟里全过；PLG-2、PLG-3 全过。
- P1-16「每类资产有结论并落地；1.0.x 用户的自定义项在 DSH 构建里可用或有明确提示」：INS-1、SKL-1、TPL-1、MCP-1、SUB-1 全过；设置页里的兼容报告、pi 扩展说明、MCP 环境变量说明经 GUI 点验。

## 5 roadmap 补登建议（本文不改 roadmap，由编排者决定）

1. P1-12：删 runtime 之前，先把 `plugins/skills` 的解析、模板、展开，`plugins/mcp` 的配置与客户端，`plugins/subagent/catalog.ts` 的目录与合并搬进 `src/shared`（同 P1-9a 的做法）。
2. P1-13：检查单加「MCP 服务器与插件子进程读写明文」。
3. 决策 016：由本方案 D3 收口（pnpm 不再随包）。
4. P1-5：评估同进程插件读到 IPC 凭据应答的风险。
5. 决策 023：启动期对 home 层补丁新插入的行的处理（分片 03 §3.3）需要一并审批。
