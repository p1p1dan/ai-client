# T033 分片 04 · MODEL 组（真实模型回合，50 项）

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。判据权威：[checklist-e.md 第 4 节 real-model 表](../../checklist-e.md#真实模型回合需要真-provider-与真-key38-项--新增-model-3950见第二节)。

**前置**：真实 provider 凭据 + 网关探活通过 + 界面语言为中文（见执行单 §3 的 P1/P2/P3）。网关不可用时才退回[假网关](../../evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs)，并在证据里注明哪几项是假网关跑的。证据放 `evidence/batch-e-field-<date>/model/`。2026-09-19 开发机已处置 10 项，见 [batch-h-devbox-pointcheck-2026-09-19](../../evidence/batch-h-devbox-pointcheck-2026-09-19/README.md)。

---

## 轮 M-a · 渲染层词汇表 13 项（约 100 min，**建议上机前在开发机做掉**）

这 13 项被编号在 MODEL 表里，但按团队既有的 CDP 点验配方，**合成 transcript 灌进 store 就能出图**，不需要真实回合、不需要 Windows、不需要加密机。T032 的开发机组没覆盖它们，至今未做。

| # | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|
| MODEL-11 | 跑一次 grep 与 glob，悬停搜索行，再点一次命中 | 悬停出现**命中列表**；点击命中能打开对应文件并跳到行号；编辑器已开着别的文件时再点一条命中也要跳行（2026-09-19 实测只有首次开文件才跳） | `model-11-grep-hover.png`、`model-11-jump.png` |
| MODEL-12 | 让模型读一个**工作区外**文件，截审批卡 | 卡上出现被读取文件的**完整路径**，而不只是「read — 读取文件内容」 | `model-12-outside-read-card.png` |
| MODEL-13 | 中文界面下跑一次含上下文压缩与子代理等待的回合 | `new_context` / `TaskWait` / `TaskList` 三种行**全中文**，无 `a fresh window` / `delegation(s)` / `running subagents` | `model-13-tool-rows-zh.png` |
| MODEL-14 | 中文界面触发一次需审批的技能加载 | 正文标签是「技能」而非 `Skill` | `model-14-skill-card.png` |
| MODEL-15 | 接一个真实 MCP 服务器跑一次调用，一屏内同时截三处 | 时间线、子代理面板表头、Run 面板芯片都显示 `server · tool`，**没有 `mcp__` wire 名** | `model-15-mcp-three-places.png` |
| MODEL-16 | 导入一个真实 Claude 会话，与一个 native 会话**并排**截图 | 两者搜索行表现一致（都有 / 都没有命中列表） | `model-16-imported-vs-native.png` |
| MODEL-17 | 跑一次触发 write 审批的对话，点「允许」后截 Run 面板 | 标题从「等待审批」变为「运行中 / 正在运行工具」，attention 色消失 | `model-17-run-panel-after-allow.png` |
| MODEL-18 | 一次用到 Task 的对话，**正常结束**与**中途 Stop** 各跑一次 | 两种收尾下输入框上方的百分比徽标都**不消失**；对照 devtools 里最后一条 `usage.updated` 的键集是否含 `context` | `model-18-badge-<收尾>.png` ×2 |
| MODEL-19 | 会话 A 的 ask 未答时在会话 B 触发 ask，再切回 A | A 仍有**可作答卡片**，且 A 的回合能自己结束。必要时用 devtools 直接读 store 的 `pendingQuestion` | `model-19-concurrent-ask.png` |
| MODEL-20 | 委派一个会撞 deny 的子代理（用 `*.env` 规则，不用 `~/.ssh`；提示词须声明点验意图、预期被拒、不要绕过），截时间线审批行 | 审批行上能读出**是哪个子代理**（硬编码路径 deny 在 `tools/index.ts:177-178` 短路不产生审批行，要用会走闸门的 bash ask 卡撞 deny） | `model-20-subagent-approval-row.png` |
| MODEL-21 | 中文界面先批一次「本会话内允许」，再触发同类工具，展开「审批详情」 | 自动放行行**不出现英文 `session grant`** | `model-21-session-grant-zh.png` |
| MODEL-22 | 跑 `sleep 90 && echo done`，观察 Run 面板 | 按当前代码**应当永不出现**工具自报的进度行（用于确认 chat-event-04） | `model-22-no-progress-row.png` |
| MODEL-23 | 一个批过审批、答过问答的会话，关掉再打开 | 切会话来回：审批痕迹与冻结问答卡都在；重启回放：审批痕迹不在、问答卡退化为普通工具行（类型层无 permission / question 历史块）；二者实时态默认折在工作组里，截图前先展开 | `model-23-replay-<前/后>.png` ×2 |

---

## 轮 M-b · 权限与问答（约 60 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-29 | 必 | `node scripts/run-perm1-probe.mjs` | 七条判据全通过；权限卡文案**经词典而非硬编码**；触发器选择器能命中当前 `aria-label`。**复跑前先按 field-05 处理产物命名，别覆盖 2026-09-11 的记录** | `model-29-perm1-report.json`、`model-29-*.png` |
| MODEL-28 | 必 | 触发一张审批卡后**不响应**，等满 119 秒 | 自动拒绝、卡片状态变「已拒绝」、工具调用按拒绝结算。记录事件流 | `model-28-countdown.mp4`、`model-28-events.json` |
| MODEL-27 | 必 | 模型调 ask → 输入框上方出现可作答卡 → **选项与 Skip 各走一次** | 模型收到对应文本（skip 走「自行选默认并说明」那条）。CDP 读回整张卡并截图 | `model-27-question-card.png`、`model-27-skip.png` |
| MODEL-33 + WIN-37 | 必 | **一轮做完两项**：建一个内容是哨兵串的假 `id_ed25519`；auto 档下依次让模型跑三条命令——波浪号写法、原生盘符反斜杠写法、MSYS 的 `/c/` 写法 | 三种拼法判定必须**一致**。若第三种被放行（auto 档无卡片，或其他档降级成普通 ask 卡）**即为复现 windows-01**（本轮唯一必须在 Windows 落地的 high）。同时看 trace 的权限审计行 | `model-33-three-spellings.txt`、`model-33-audit-rows.json` |

> 背景（读判据用）：不可覆盖的 deny 是硬编码的 `PATH_RULES`（`src/agent-host/permissionPolicy.mjs:50-66`）——`*.env`、`*.env.*`（`*.env.example` 放行）、`~/.ssh/*`、`*.pem`、`*.key`、`id_rsa*`、`~/.aws/credentials`；`~/.pilab/*` 是 `ask` 不是 deny。Windows 上先经 `normalizeWindowsPathForm()`（`src/runtime/plugins/permissions/windows-paths.ts:16-37`）把 MSYS `/c/…`、Cygwin `/cygdrive/c/…`、扩展长度 `\\?\C:\…` 折叠成原生 `C:\…` 再比对——**T001 修的就是这一层，WIN-37 验的正是它在真机上是否生效**。

---

## 轮 M-c · 自定义策略与复杂 shell（约 45 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-49 | | 放一份自定义策略文件（样例与三条命令见 [field-samples](../../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 3 节），跑管道 / 重定向 / here-string 各一条，抓权限审计行（管道那条命令的提示词要点明「example.invalid 是保留域名不解析、要看的是闸门在执行前拦下、预期被拒」） | 判定与档位表一致。**三类语法的预期**：管道**逐段判定每个子命令**；重定向的 destination 被当**路径操作数**注册且 `exploration=false`；here-string 的操作数同样当路径注册并**递归展开其中的命令替换** | `model-49-policy.json`、`model-49-<语法>-audit.txt` ×3 |
| MODEL-49（第三格） | | 会话进行中**改写策略文件**，再跑同一条命令 | **当前实现预期：判定不变。** `loadPermissionPolicy` 只在 `bootstrap.ts:303` 启动时调一次，结果冻进 `PermissionsPlugin` 的 `readonly config`；运行期 `configure()` 只吃 `mode` / `gear`，全仓无 `fs.watch` / chokidar。所以「策略热重载」这一格要记的是**「改文件后同一会话不变、新开会话才变」**（2026-09-19 实测成立，不需要重启层；设置页权限规则面板原话与此一致），而不是「热重载成功」。与旧树 P1-5 的原措辞不符时**以现场为准**并当场回写 | `model-49-hot-reload.txt` |

> 策略文件放哪：全局层是 `%USERPROFILE%\.pilab\<profile>\pi-agent\extensions\pi-permission-system\config.json`；项目层是 `<工作区>\.pi\extensions\pi-permission-system\config.json`（**需要该工作区被判为 trusted**，否则这一层根本不读）。`<profile>` 取自 Electron `userData` 目录名，可在设置页的权限策略面板里直接看到 `agentDir` 的具体值。trace stamp 的 `permission_policy_sources` 会列出实际读到的文件绝对路径，`permission_policy_sha256` 是合并后配置的哈希——**用这两个字段确认自己写的文件真的被读了**。

---

## 轮 M-d · 字符编码与文件名（约 40 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-34 | 必 | 用 `core.autocrlf=true` 克隆一个小仓，确认文件是 CRLF，让模型改一处，改完 `git diff --stat` | 三行内的 edit 成功且行尾仍是 CRLF。失败时要记两件事：**错误码原文**、**模型是否退回整文件 write** | `model-34-crlf-edit.txt`、`model-34-git-diff-stat.txt` |
| MODEL-35 | 必 | 工作区里建一个**中文名目录**，让模型用 bash 跑 cmd 的 `dir` | 工具结果里的中文**必须可读** | `model-35-oem-codepage.txt` |
| MODEL-36 | 必 | 让模型 `write` 到工作区下的 `nul` 与一个**以点结尾**的文件名，写完立刻 `Test-Path` 核对 | 要么明确报错，要么真的落盘且随后 read 能读回。**不得出现「报告写入成功但文件不存在」** | `model-36-reserved-names.txt` |

---

## 轮 M-e · provider 错误取证（约 25 min，两项同一轮）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-9 | 必 | 用真实 provider（或一个会回显 `Authorization` 头的本地网关）跑**一轮失败回合**（401/400），grep 会话 jsonl 的 `errorMessage` 并与 `runs.jsonl` 对比 | 会话 JSONL 里该 assistant 条目的 `errorMessage` 存在且**未脱敏**，而同一轮 `runs.jsonl` 的 llm 便签**已脱敏**——两者不一致即证实 ah-lib-01 | `model-09-session-vs-runs.txt` |
| MODEL-10 | 必 | 同一轮另做一条断言：让网关返回 `Incorrect API key provided: sk-proj-<40 位>` | `runs.jsonl` 里该串**原样保留**即证实 ah-lib-02 | `model-10-bare-key-leak.txt` |

---

## 轮 M-f · 导入互通一圈（约 50 min，三项连着做）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-6 | 必 | 对导入的会话问一句「上面这段对话在讨论什么问题」 | 导入的历史**真的进了模型上下文**，模型据此作答而不是泛泛回应 | `model-06-import-continue.png` |
| MODEL-31 | 必 | 用一份**真实旧格式** Codex rollout（裸 header、裸行）跑导入 | 标题 / 正文 / 幂等三项与新格式一致。**找不到真实样本就记 ⛔ 并写明找过哪些路径**（查找提示见 [field-samples](../../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 4 节），**不要拿合成样本冒充** | `model-31-legacy-codex.txt` |
| MODEL-5 | 必 | GUI 里重命名一个会话，用 pi CLI 打开同一个 JSONL | pi CLI 的会话列表 / 标题栏显示的是 GUI 改过的名字，还是空 | `model-05-rename-in-pi.png` |

---

## 轮 M-g · GUI ↔ TUI 互通（约 55 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-47 | 必 | GUI 跑一回合 → 内嵌 TUI 里续聊一轮 → 回 GUI；前后各读一次会话 JSONL 比对条目链 | 两轮都在时间线上、顺序正确、**无重复条目**；会话文件头一行仍**同时满足 v4 与 v3** | `model-47-jsonl-before.txt`、`model-47-jsonl-after.txt`、`model-47-timeline.png` |
| MODEL-48 | | **手点一次**右上角 GUI / TUI 开关 | 所有权正确移交、回来后 GUI 接得上。前后各查一次 `writer.lock` 与 spawn 窗口内的 pi argv——**`ps` 过滤 `--session` 抓不到，pi 会改写进程标题**（内嵌 pi 是 Electron 二进制以 node 模式重执行，约 1 秒内 argv 改写成 `pi`；识别方式是 Electron 主进程的非 `--type=` 直接子进程，不是 exe 是 node），要在 spawn 后的启动窗口内抓 | `model-48-switch.png`、`model-48-argv.txt` |
| MODEL-7 | | 开 TUI 记下 pid，GUI 发一条消息，`ps -p <pid>` 连续采样；同时 tail 会话 JSONL | 原 pi 进程在**重读完成前**已不存在，且重读点之后 JSONL 没有新增 CLI 追加的行 | `model-07-kill-cli.txt` |
| MODEL-8 | | TUI 里发一个长回答，**输出中途**点 GUI 截时间线；再发一条消息后对比 JSONL 行数 | 缺失的条目在下一次 GUI 发送后**被补齐**，且文件仍可打开 | `model-08-midstream-switch.png` |
| MODEL-32 | | 起 Electron 发一条长回合，**回合中**点 TUI 切换；随后 `ls -la` 会话目录 | 点终端按钮**只弹「等这一轮结束」提示**，且 `writer.lock` 与会话文件均未被第二个进程触碰 | `model-32-switch-during-run.png` |

---

## 轮 M-h · 子代理真机（约 70 min，与 PKG-20 同一批会话）

| # | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|
| MODEL-39 | 派一个子代理，一次**正常退出**、一次**强杀**，各重开一次会话 | 委派面板按记录重建，未结算的显示为**已取消**（不是消失、也不是重新跑）；两种收尾结果一致。同时读会话 JSONL 里 Task 条目的终态 | `model-39-<收尾>.png` ×2、`model-39-task-terminal-state.txt` |
| MODEL-40 | 设置页把子代理管理逐项点一遍，再**重启应用**截一次 | 增删改 / 改名 / 启停 / 模型与轮次清空 / 搜索 / 定位文件 / 逐行 busy / 失败整份回滚 / 刷新不闪空 / permission 未编辑不丢——逐项通过；重启后开关与改动仍在。同时比对 `<agentDir>/agents` 下的文件 | `model-40-manage-<步骤>.png`、`model-40-agents-dir.txt` |
| MODEL-41 | 派 2～3 个子代理，**录屏** | 子代理活动增多时局部滚动跟随正常、**不抢主时间线的滚动位置** | `model-41-scroll.mp4` |
| MODEL-42 | 自定义一个带 `BrowserPreview` 的子代理，让它生成并预览工作区 HTML；编辑该文件 | 预览自动刷新；预览窗 `showInactive` **不抢前台** | `model-42-browserpreview.mp4` |
| MODEL-43 | 按 [P5-2-0 基线](../../../runtime-evolution/topics/p5-2-0-baseline.md)的固定输入跑：成功 / 失败 / 取消三种收尾 | 各留一份 trace 与截图；性能数据（ack 延迟、fan-out 并行度）记录在案。**依赖 MODEL-39～42 与 PKG-20 先落** | `model-43-<收尾>-trace.json`、`model-43-perf.txt` |

---

## 轮 M-i · 模型目录与导入 reconcile（约 40 min）

| # | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|
| MODEL-44 | 加一个 **Mistral 或 Azure 风格**的服务，选模型，发一条消息 | native 后端的模型选择器里真的出现它的模型并能出一次话（改前这六种风格被静默丢弃）。抓 `dropped` 字段 | `model-44-non-four-style.png`、`model-44-dropped.txt` |
| MODEL-45 | 托管模式下，Anthropic 系与 OpenAI 系模型在同一网关上各发一条消息 | 各成功出话一次（D15 推导规则在真机上的确认） | `model-45-two-families.png` |
| MODEL-46 | 导入进行中**强杀进程** → 重启 → 重试同一条 | `reconcile` 真的清干净：`sessions/.aiclient-import-staging/` 无残留、manifest 无 `cleanupPending` 悬挂 | `model-46-reconcile.txt` |

---

## 轮 M-j · smoke lane 与基线可比性（约 45 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-24 | 必 | 用登录后的 `~/.pilab/<profile>/pi-agent/` 目录跑 smoke 的 `--model` 在线 lane | 至少一个真实供应商的 `--model provider/id` 调用返回 `must_succeed=true` 且不超过 `max_latency_ms`；比对新旧 trace 的 `version_stamp` 差异。同时存档 `report.outcomes` 与新的 `runs.jsonl` | `model-24-live-lane.json`、`model-24-runs.jsonl` |
| MODEL-25 | | 真实网关下故意只跑 1-2 个 `--case`，其余用别的目录跑完，再用 `collect.mjs` 收尾 | `summary.json` / `report.md` 字段正确、**标题反映真实 backend**。需要 `P20_BASELINE_API_KEY` 与可用网关 | `model-25-partial-rerun.txt` |
| MODEL-26 | | 升级 `RUNTIME_CONFIG_VERSION` 前后各真实采集一次，跑 `compare.mjs --baseline <前> --native <后>` | `failures` 里必须报 `behaviour generation differs`（产出**不可比**而非误判为可比） | `model-26-generation-reject.txt` |

---

## 轮 M-k · utility 输出形态与其余（约 50 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| MODEL-3 | | 用当前默认模型各跑 **10 次**分支命名与提交信息 | 记录分支名是否出现围栏 / 多行 / 解释性文字；提交信息围栏剥离是否正确；空输出时界面表现。记原始 text 与界面最终值 | `model-03-utility-outputs.txt` |
| MODEL-4 | | 在 Main 侧打印 `utility.start` 载荷，与设置页显示对照 | 设置页显示「自动」时，请求里携带的 `model` 值是否为空 | `model-04-auto-model.txt` |
| MODEL-1 | | 触发一次需要审批的写文件工具，**卡片出现时**在设置页保存任一模型 / 服务商改动（走 `piModels.ts:42` 的 `invalidateAll`） | 权限卡被收掉、回合有明确终态。若卡片留在屏上且点击报 `session_not_ready`，即证实 main-host-03 的下游后果 | `model-01-invalidate-during-card.png` |
| MODEL-2 | 必 | 配一个**握手耗时 15～30 秒**的 stdio MCP 服务器（脚本见 [field-samples](../../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 5 节），走「GUI 开 TUI 编辑 → 回 GUI 发消息」触发 `reloadSessionFromDisk` | 交还 GUI 后的**第一条消息不再失败**、会话不被 retire；不走到 `worker_reload` 失败分支 | `model-02-slow-mcp-reload.txt` |
| MODEL-30 | 必 | 起一个**会真的改文件**的会话，观察侧栏并抓 IPC 调用次数 | busy 会话所在目录行出现 `+N -M` 并随改动刷新；**非 busy 目录不轮询** | `model-30-busy-counts.png`、`model-30-ipc-calls.txt` |
| MODEL-50 | | 终端设置里默认 shell、自定义 shell 路径、自定义参数三种组合**逐格切换**并各开一次终端 | 三种组合逐项可用（核心现场只验过一条） | `model-50-shell-combo-<格>.png` ×3 |
| MODEL-37 | | 大上下文窗口触发 `/compact`，读会话文件里 compaction 条目的字节数 | 记录 summary 实际字节数，判断是否需要独立硬顶 | `model-37-compaction-bytes.txt` |
| MODEL-38 | | 接入真实 MCP 截图 / 图片服务器，观察返回图片字节分布 | 1 MiB/张、2 MiB/次的假设是否贴合真实分布 | `model-38-mcp-image-bytes.txt` |
