# 调研：把 Claude Agent SDK 引擎加回来（2026-09-26）

Role: study（事实来源，非决策）。基线 main `d23d72aa`（v1.0.3）。只读调研，旧代码以 `<sha>^:路径:行号` 引用。人周为名义值，口径与 [DSH 二开计划](../plantree/plans/dsh-rebase/roadmap.md) 一致。

用户需求（2026-09-26）：v1.0.3 用下来没问题，但自有内核和 Claude 不太适配，「工具调用不太智能，表现不如在 Claude 中使用」。希望 Claude 模型默认走官方 Claude SDK，设置里可切回当前内核。Claude 继续走自家网关。

## 0. 结论

- **能加回来。** 旧实现是 `@anthropic-ai/claude-agent-sdk@0.3.218`，配第三方包 `@cometix/claude-code@2.1.212` 的 `cli.js`，跑在随包 `node.exe` 上。2026-08-15 加密机 T-11 六项全过（`f70cc6b5`）。
- **工作量：** 最小可用版约 5～7 人周；与 v1.0.3 对等约 10～15 人周。旧代码不能直接复活：Host 协议、WorkerManager、RuntimeEvent、worker RPC 之后都重写过。推荐按现在的 worker RPC 接缝新写，旧代码当参考。
- **两条硬约束：**
  1. 官方 Claude Code 从 2.1.113～2.1.120 起改为 Bun 原生二进制，加密机不放行，只能继续用第三方的 Node 版 Cometix。
  2. 体积（npm `unpackedSize` 推算，未实测）：Cometix 路线每平台约 +55～75 MB 未压缩；官方原生路线约 +230～250 MB 未压缩。
- **「不太适配」大概率有一半是我方配置问题，可以低成本先验证：** 默认思考强度 `medium`，而 API 默认 `high`、Claude Code 默认 `xhigh`；系统提示词和工具描述薄了一到两个数量级；read 输出不带行号；网关 key 分组可能不同。
- **建议两步走：** 先花约 1 人周做「对照评测 + 轻量改良」，拿到数据再决定是否投入 SDK 引擎。

## 1. 「工具调用不够智能」的来源

### 事实：自有 runtime 与 Claude Code 的差异

| 维度 | 自有 runtime（v1.0.3） | Claude Code |
|---|---|---|
| 思考强度默认值 | 不选档位时渲染层不发 effort（`src/renderer/components/chat/efforts.ts:51-64`）→ agent loop 兜底 `medium`（`src/runtime/plugins/agent-loop/index.ts:309`）→ pi-ai 映射成 `output_config.effort: "medium"`（`src/runtime/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:611-626,789-796`） | API 不传时默认 `high`；Claude Code 在 Sonnet 5、Opus 4.7/4.8、Fable 5 上默认 `xhigh` |
| 系统提示词 | 身份一句、协作五句、工具指引一段（`src/runtime/plugins/prompt/baseSegments.ts:20-39`、`src/runtime/plugins/tools/prompt.ts:21-31`）；环境段只有 cwd、平台、shell、日期，没有 git 状态。静态部分约几百 token | 旧版抓包：首轮 tools+system 前缀 38,592～42,435 token（`e1b45ed8^:docs/design/BUG-2026-07-29-prompt-cache-rewrite.md:13,43`） |
| 工具集 | read / write / edit / bash / glob / grep / ask / skill / new_context / Task / TaskWait / TaskList / TaskStop / 可选 browser_preview，外加 MCP | 另有 TodoWrite、WebFetch、WebSearch、NotebookEdit、后台 Bash 与输出读取、ExitPlanMode 等 |
| 工具名与参数 | pi 风格：`read{path}`、`edit{path, edits[{oldText,newText}]}` | `Read{file_path}`、`Edit{file_path, old_string, new_string, replace_all}` |
| 工具描述 | 基本一句话（`src/runtime/plugins/tools/index.ts:335-337,405-406,438-439,490-491`） | 长篇，带用法、禁忌、示例 |
| 工具结果 | read 不带行号（`src/runtime/plugins/tools/read-lines.ts:63-106`） | `cat -n` 风格，带行号 |
| 缓存与思考形态 | adaptive + `display:summarized` + 1 小时缓存，配置正确 | 同类 |
| 网关格式 | 原生 `anthropic-messages`，无格式转换 | 同 |

### 推断：各来源的贡献排序

> 2026-09-26 用户更正：已实测，思考强度影响不大，主要差距在提示词、可调用工具与内置工具。下面第 1 条作废，按第 2～4 条看。

1. ~~effort 偏低（`medium` 对 `xhigh`）。~~
2. 提示词和工具描述太薄。
3. 工具名与参数偏离 Claude 的训练分布，read 不带行号。
4. 缺 TodoWrite 这类任务管理工具。

缓存、思考形态、上下文压缩不像主因。

### 网关侧待核实

- 事实：旧 SDK 路线的流量落在网关「ccmax 分组」，该分组背后有多个上游账号。
- 事实：native runtime 用 vault 里的 `pi.apiKey || codex.apiKey`，走 `x-api-key`；旧 SDK 路线用 `claude.authToken`，走 Bearer（`src/main/services/piModelConfig/index.ts:171-178`；`65061ccf^:src/agent-host/claudeRuntime.ts:716-720`）。
- 推断：两把 key 如果不同，可能落在不同的分组或上游。需要网关运营方确认，约 0.1 人周。

### 轻量改良与换 SDK 的对照

- **轻量改良约 2～4 人周：**
  - Claude 默认 effort 改为 high 或 xhigh：约 0.1 人周。
  - Claude 专用提示词段：0.5～1 人周。必须自己写，不能照抄 Claude Code，其许可为 "All rights reserved"。
  - 工具描述扩写、read 加行号、edit 参数调整、先读后改的约束：1～1.5 人周。
  - todo 工具：0.5 人周。
  - A/B 评测集：约 1 人周。同任务同模型，分别在 Claude Code 和我方跑。必须先做，否则「变聪明」无法验收。
- **上限：** 训练分布上的偏差补不满。改良做在自有 runtime 上，DSH P2 冻结 native 后就作废；DSH 也经 `llm-pi-ai` 调 Claude，问题会重现。
- **换 SDK：** 最小可用版 5～7 人周，行为基本就是 Claude Code，代价见第 2 节的体积与许可风险。

## 2. 网关、随包与加密机

### 网关

- 托管路线下 Claude 走 cch 网关的根地址（不带 `/v1`），协议 `anthropic-messages`（`docs/plans/2026-09-08-runtime-evolution-ard.md:335-345` D15；`src/shared/modelBaseUrl.ts:40-76`）。
- SDK 用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 指向 cch，历史上多次跑通：Phase 0 多轮 resume、thinking 探针、加密机 T-11。
- 所需地址和 token 今天仍在 vault：`claude{baseUrl,authToken}`、`cchBaseUrl`（`src/main/services/auth/CredentialVault.ts:61-69`），只写不读。
- 托管模式启动时会剥掉所有 `ANTHROPIC_*`（`managedCredentialsStartup.ts:39-61`），新引擎必须显式注入。旧注入方式见 `77ff5dd4`。
- 未核实：当前 Claude Code 带的 beta 头 cch 是否全部放行；目录里 `supportsToolReferences:false`，提示 tool search 类特性可能要关。

### 旧版随包

- 随包内容：SDK 的 `sdk.mjs`，加 Cometix 的 `cli.js` 与 `vendor/`（ripgrep 等）。
- 构建校验禁止带入官方原生二进制平台包（`e1b45ed8^:scripts/agent-host-build-lib.mjs:283-284,323-324,411-433`）。
- Cometix 是社区包（CometixSpace/claude-code，"Claude Code restored for Node.js runtime"），持续跟版：latest 2.1.282/2.1.283，官方 2.1.283。

### 旧版怎么过加密机

- 进程链：Electron Main → 随包 `node.exe` 起 Host（C-15 / D17，`adc31273`）→ SDK 以 `executable: process.execPath` + `pathToClaudeCodeExecutable: <cometix cli.js>` 起 Claude Code 子进程，用的是同一个随包 node.exe（`65061ccf^:src/agent-host/claudeRuntime.ts:716,978-979`）。
- 2026-08-15 T-11 六项全过，含「随包 node 按进程名放行明文」。
- 2026-04 已发现官方 2.1.113+ 的 Bun 二进制读不到加密 JSONL，当时把 CLI 锁在 2.1.112（`67952e3a`）。
- 没找到证据的两项：CC 的 Bash 走 Git Bash；Grep/Glob 调 `vendor` 里的 `rg.exe`。T-11 都没有单独覆盖。
- 当前 SDK 0.3.283 默认用原生二进制，但仍支持把 `.js` 路径交给 node 执行（`sdk.d.ts:1664,1982`）。推断机制上可行，未实测。

### 体积（npm `dist.unpackedSize` 推算，未实测安装包）

| 路线 | win32-x64 | linux-x64 | darwin-arm64 | darwin-x64 |
|---|---|---|---|---|
| 旧（Cometix 2.1.212 平台包） | 26.3 MB | 28.2 MB | 28.7 MB | — |
| Cometix 最新平台包 | 46.8 MB | 49.8 MB | 51.7 MB | 52.1 MB |
| 官方原生 SDK 平台包 0.3.283 | 245.0 MB | 241.6 MB | 225.0 MB | 233.5 MB |

- SDK 主包 5.15 MB，各路线都要加。
- Cometix 路线：连同 ws、undici、node-pty、sharp 等依赖，每平台约 +55～75 MB 未压缩。
- 原生路线：约 +230～250 MB 未压缩；压缩后估计安装包 +80～120 MB（纯推断）。
- 旧版实测参照：agent-host 产物 linux 42.8 MB、win32 91.5 MB（`e1b45ed8^:scripts/packaging-budget.mjs:45,69`）。

## 3. 历史

- 2026-07-23 Phase 0 选定 Agent SDK 为主路线，`stream-json` 直接 spawn CLI 作备份（`7db14240`）。旧设计每回合调一次 `query()` 并带 `resume`，Claude Code 子进程每回合重新 spawn。
- 2026-08-28 `e1b45ed8`：切到 pi，D5「先屏蔽 Claude/Codex 路径，代码不删」。动机是「pi-agent 适配多模型供应商，开箱即用」。
- 2026-08-31：D14 取代 D5，产品改为 Pi-only，Claude/Codex 只保留只读历史导入；D16「替代即删除」。
- 删除提交：`65061ccf`（T31，-51,807 行，含 Codex）、`ebfee0a6`、`c954b3e1`、`cb0eddb5`（-9,073）、`8dadf598`（-8,307）、`8aafd450`（-5,399）。
- 当时覆盖：流式、工具行、审批（`canUseTool` 权限桥与 AskUserQuestion 桥）、中途切权限档、会话恢复、Stop 看门狗、图片与附件、子代理、usage、`settingSources`。
- 旧代码量：Claude 专用 Host 源码约 5.5k 行，测试约 7.5k 行，Host 入口 981 行，Main 侧 `AgentHostManager` 888 行。
- 今天的残留：Claude 会话只读导入（`src/main/services/legacyImport/`，约 3k 行）；渲染层 Claude 工具词汇表（`toolCard.ts:1024-1226`）；`cometixVersion` 字段；vault 里的 `claude` 凭据。
- 反向守卫（加回来时要拆）：`t31PiOnlyAbsence.test.ts`；`scripts/agent-host-build-lib.mjs:28-33`；`scripts/__tests__/packaging-config.test.mjs:154-158`；`sessionIndexMerge.ts:107-116` 会隐藏 `agent:'claude-code'` 的行。

## 4. 接缝与功能对等

### 接缝

- transport 选择点：`createPiWorkerSlot.ts:69-71`。
- 4 条拉起路径都经 `WorkerManager.spawnForEntry`（`:2535-2606`）：新建 `:1023`、恢复 `:1280`、fork `:1861`、崩溃重启 `:3297`。
- 协议：worker RPC 26 个方法。新引擎复用 `PiWorkerRpcServer`，实现 `PiWorkerRuntime`（`:110-147`）即可；DSH 探针就是这么做的。
- 要改的地方：
  - `ManagedSlot` 加 engine 字段；
  - 5 处写死的 `agent: PI_AGENT`；
  - 新建时 bootstrap 就要返回 `sessionFile`，沿用 DSH 探针的「私有桩文件」做法；
  - `AGENT_WIRE_NAMES` 追加 `'claude-sdk'`，不能用 `'claude-code'`，否则会被隐藏。
- 推断：
  - 按会话固定引擎，新建时读设置，恢复、重启、fork 都跟随会话记录。
  - Claude 模型默认走 SDK，非 Claude 模型总是走 native（以后是 DSH）。
  - 设置放「pi」类，改名为「模型与引擎」。

### 功能对等（推断）

| 功能 | 判定 | 要点 |
|---|---|---|
| 流式、思考、工具行 | 对等 | 渲染层还保留 CC 词汇表 |
| Ctrl+Enter 插话 | 可做，需探针 | SDK `streamInput` 带 `priority`；前提是改成长驻 query |
| 分支栏 | 对等 | Main 侧 git，与引擎无关 |
| 读图 | 对等 | |
| Stop 必收尾 | 基本对等 | Windows 上要补测子进程树清理 |
| 四档权限 | 需移植 | CC 固定跑 default，四档逻辑放进 `canUseTool` |
| 会话授权记忆 | 需移植 | CC 的会话规则不持久，要在我方层实现 |
| bash 分析 | 可对等 | 复用 `src/runtime/plugins/permissions/bash-analysis.ts` |
| 拒绝清单 | 可对等，要拍板 | 必须用 PreToolUse hook；旧代码实测 `permissions.allow` 会绕过 `canUseTool`（`65061ccf^:claudeRuntime.ts:984-1031`） |
| 子代理 | 部分对等 | 泳道能做；TaskWait/TaskList/TaskStop 语义不同 |
| 失败卡「继续」重试 | 首版降级 | 失败回复不留旁支 |
| 用量与额度 | 对等 | 额度由网关按 key 计 |
| rewind/tree、pi TUI 互通 | 首版不支持 | 可选：内嵌终端改跑 Cometix `claude --resume` |

## 5. 与 DSH 路线的关系

- 会出现阶段性三引擎：P1、P2 期间 native、DSH、Claude SDK 并存；P2 冻结 native 后剩 DSH 加 Claude SDK。
- 两者不冲突：DSH 解决生态与插件，SDK 引擎解决 Claude 的行为质量，DSH 解决不了后者。DSH 自带的 `subagent-claude-code` 是一次性无人值守用法，不能当交互主引擎。
- 可共用的前置工作：
  - 「按会话选引擎」接缝，约 1～1.5 人周，只做一次。
  - 权限模型抽成纯库，DSH 插件和 SDK 引擎都要用。
  - RuntimeEvent 录制回归门禁。
- roadmap 影响：DSH P1（6～8 人周）与 SDK 引擎最小可用版（5～7 人周）会争用人力；P2「冻结 native」要改为「native 冻结，Claude 走 SDK」。

## 6. 工作量

| 做法 | 最小可用版 | 与 v1.0.3 对等 | 主要风险 |
|---|---|---|---|
| (a) 从历史复活 | 5～8 人周 | 11～16 人周 | 绑定已删的 Host 协议；`runtimeEvents.ts` 此后改了 1211 行、`workerRpc.ts` 增了 1310 行；每回合 spawn 与插话冲突；版本落后约 65 个。可复用约 40～60% |
| (b) 按 worker RPC 新写（推荐） | 5～7 人周 | 10～15 人周 | Cometix 供应链与许可风险；体积；加密机上 rg 与 bash；网关对 CC beta 头的兼容；CC 读 `~/.claude` 的暴露面 |
| 对照：轻量改良自有 runtime | — | 2～4 人周（含评测集） | 上限受训练分布限制；DSH P2 后作废 |

(b) 的最小可用版拆分：引擎接缝 1～1.5（与 DSH 共用）；SDK runtime 与事件映射 1.5～2.5；审批、档位、拒绝清单 0.5～1；会话桩与历史投影 1（可复用 `ClaudeSourceAdapter.ts`）；凭据与三平台打包 1；开发机与 CI 验证 0.5～1。

## 7. 推荐与待拍板

推荐：

1. 先做约 1 人周：
   - 建 5～10 个真实任务的 A/B 评测，同模型对比 Claude Code 与我方；
   - 同时把 Claude 默认 effort 调高；
   - 向网关确认 native 所用 key 的分组。
2. 差距仍明显：按 (b) 新写 SDK 引擎。Cometix 加随包 node，三平台同一路线；引擎接缝与 DSH P1 共用、最先做；权限逻辑抽成纯库。
3. 差距基本消失：不加引擎，把改良作为 DSH P1 的宿主插件需求带过去。

待拍板：

1. 是否先做一周对照评测再决定？能否给 2～3 个现场例子？
2. Claude 用哪把 key：`claude.authToken`（ccmax 分组）还是 `pi/codex apiKey`？
3. 是否接受依赖第三方 Cometix，以及在安装包里再分发 Claude Code 的许可问题？
4. 每平台 +55～75 MB 能否接受？
5. SDK 会话是否读用户的 `~/.claude` 与项目 `.claude` 配置？其中的 allow 规则会绕过我方审批。
6. 排期：SDK 引擎与 DSH P1 谁先做？
7. 首版能否接受这些降级：失败重试不留旁支、没有 rewind/tree、不能在 pi TUI 里打开？
