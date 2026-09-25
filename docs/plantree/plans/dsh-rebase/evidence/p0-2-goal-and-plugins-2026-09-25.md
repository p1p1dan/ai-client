# P0-2 goal 四件套、todo、jobs 与社区插件（2026-09-25，Linux 开发机）

Role: evidence。对应 [roadmap P0-2](../roadmap.md)。宿主骨架与测量方法沿用 [P0-1](p0-1-host-probe-2026-09-25.md)。原始数据（去掉本机路径）在同目录 [p0-2-goal-and-plugins-2026-09-25.data.json](p0-2-goal-and-plugins-2026-09-25.data.json)，由 `src/dsh-host/goal-probe.ts` 生成。

## 结论先行

1. **退出判据全部满足。** 所有包都没改过，版本统一钉在 `next` 通道的 0.1.7-rc.2。
   - goal 四件套能自动续跑，完成、阻塞、暂停三种终态全部走到。其中阻塞走了两条路：模型上报阻塞，以及轮数用完时由驱动器自动阻塞。暂停后还能恢复。
   - `dsh-tool-todo`、`dsh-tool-jobs` 都能用。
   - 社区插件选的是 `dsh-office-tools@1.0.4`（纯宿主插件，没有 `dsh.client`）。它经 DSH 自带的 plugin-manager 装上，宿主重启后激活，`word_create` / `word_read` 各成功执行一次。
2. **模型请求只打到本地假网关。**
   - 所有请求都走 `llm-pi-ai` 的纯配置路由，指向本地假网关，主运行共 43 个请求。
   - 能通向 DeepSeek 官方端点的 9 行全部关掉（清单见后文）。
   - 宿主进程没有发起任何非回环连接，也没有做 DNS 查询。唯一的外网流量是 pnpm 装插件时访问 registry.npmjs.org。
3. **对 P1 有影响的新发现：**
   - **`.env` 会泄到工具里。** 宿主启动目录下的 `.env` 和 `$DSH_HOME/.env` 在启动时就被读进宿主环境，里面的变量会原样传给 bash 工具的子进程。会话工作区的 `.env` 从头到尾没有被打开过。当作凭据引用的那个变量没有传给工具。
   - **审批模型和我方不同。**
     - 沙箱内的操作不需要审批。
     - 越界操作直接拒绝，并提示模型可以申请升级。
     - 只有模型显式带上 `sandbox_permissions` 和 `justification` 申请升级时，才会走 `approval/request`。
     - 我方是逐次审批，所以 P1 的权限移植不能只挂一个 answerer。
   - **`session-log-deepseek` 默认会把会话日志增量上传给官方接口。** 它把日志塞进官方请求的 `dsh_session_log` 字段。这不只是路由问题，是隐私问题，已经关掉。
   - **node-pty 没有被用到。** base 里的 bash 和 jobs 后台任务都是普通 spawn 加 bwrap。node-pty 只给终端类工具用，而 `dsh-base` 不挂终端类工具。
   - **社区生态能直接用的很少。**
     - 下载量前 150 的插件里，121 个带界面（`dsh.client`，属于 L2）。
     - 9 个把 DSH peer 精确钉在旧 rc 上，按 DSH 的规则在 0.1.7-rc.2 上会被拒绝。
     - 纯宿主而且版本兼容的只有 14 个。

## 方法

- **驱动：** `src/dsh-host/goal-probe.ts`。它拉起宿主（`host.ts`，随包 Node v24.18.0），经 IPC 让 `aiclient-probe` 插件建会话、发消息、执行斜杠命令、读 goal、安装插件，每个场景用一个独立会话。
  - 纪律与 P0-1 相同：先等没有 vitest 进程再跑；沙盒目录建在 `/var/tmp`，权限 0700；环境变量走白名单；不起 Electron。
- **模型：** 复用并扩展了 `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs`，新增三样东西：
  - `dsh-p0-2` plan：按请求内容决策，不看请求序号。
    - 最近一条带场景标记（`P0-GOAL-COMPLETE` 等）或 `<goal_round>` 的 user 消息算作触发点。
    - 触发点之后已经发生的工具调用数就是当前步号。
    - 轮号取自续跑提示里的 `Round: N/M`。
    - `update_goal` 用的 id 和 revision 抄自最近一次 `get_goal` 的结果。
    - 遇到 `<goal_complete>` / `<goal_blocked>` 收尾提示，一律回文本。
  - `--log`：指定日志路径。
  - `--port 0`：随机端口。

  假网关只讲 Anthropic Messages SSE，宿主侧路由为 `api: anthropic-messages`，请求路径是 `/v1/messages?beta=true`。
- **组合改动：** 本次对 bundle `cordis.patch.yml` 的改动如下。
  - 关掉以下 9 行：`llm-deepseek`、`deepseek-llm-api-extensions`、`plugin-package-inventory-deepseek`、`session-log-deepseek`、`session-title-llm`、`tool-web`、`web`、`web-search-deepseek`、`web-fetch-http`。
  - 配置 `llm-pi-ai` 的唯一路由 `aiclient-gateway`：
    - `baseURL` 取自环境变量 `AICLIENT_DSH_GATEWAY_URL`，未设置时指向本机 discard 端口 `127.0.0.1:9`；
    - 凭据引用是 `apiKeyEnv: AICLIENT_DSH_GATEWAY_KEY`；
    - 模型 `fake-1`，`maxRetries: 0`。
  - `agent-default-model` 指向这条路由。
  - plugin-manager 只问 `https://registry.npmjs.org/`，并去掉默认的 npmmirror 回落。

  `host.ts` 在任何插件导入前断言上述官方相关的行全部是 `disabled: true`。组合结果：
  - 宿主 1 共 77 行激活、18 行关闭、0 行未激活；
  - 装完插件后的宿主 2 是 78 行激活，多出来的是 `dsh-office-tools`。

  顺带用 `measure.ts smoke` 复测了一次空载 RSS，约 168 MB，只有一次采样，仅供参考；P0-1 的数字是 177 MB。
- **插件安装：** 子包里钉了 `pnpm@11.7.0`（与 DSH Desktop 随包版本相同）。宿主经 `profileContext.packageManager` 用同一个随包 node 去跑 `pnpm.mjs`，这和打包后的产品形态一致。
- **子进程、文件、网络的采集方法与 P0-1 相同：**
  - `/proc` 每 250 ms 采一次进程树；
  - `probe-hooks.mjs` 进程内钩子：记录 spawn 和 DNS，并断开非回环连接；
  - 单独跑一轮 `strace -f`，抓 execve 和写文件类系统调用，另外匹配所有 `.env` 文件的 open。
- **轮次：**
  - 主运行（2026-09-25 13:22:46～13:23:20，共 35 s）的数字就是本档引用的数字。
  - strace 运行（13:23:55～13:24:37）的功能结果与主运行一致，它的计时不采用。
  - 格式化之后又完整重跑了一次，各项结果也一致。

## 版本

| 项 | 版本 |
|---|---|
| `dsh-goal` / `dsh-tool-goal` / `dsh-goal-round-driver` / `dsh-command-goal` / `dsh-tool-todo` / `dsh-tool-jobs` | 全部 0.1.7-rc.2。它们本来就是 `dsh-base` 的行，这里原样挂载、配置保持默认 |
| 其余 `@deepseek-ai/*` | 同 P0-1（dsh 包全是 0.1.7-rc.2，cordis 4.0.4） |
| 社区插件 | `dsh-office-tools@1.0.4`，由 pnpm 装进 `$DSH_HOME/profiles/aiclient/node_modules` |
| pnpm | 11.7.0，钉在 `src/dsh-host/package.json` |
| Node | 宿主、pnpm、假网关都跑在随包 v24.18.0 上 |

## 社区插件的选择

- **筛选方法：** `src/dsh-host/lib/select-community-plugin.mjs` 读 `dsh-plugin-catalog@2026.925.4511`（共 4311 条），按下载量取前 150 个，逐个 `npm view` 取已发布的 manifest，然后按 app-boot 的准入规则判断：DSH peer 必须被 0.1.7-rc.2 满足，预发布版本也参与匹配。
- **筛选结果（前 150 个）：**

  | 类别 | 数量 |
  |---|---|
  | 带 `dsh.client`（界面插件） | 121 |
  | 不是 bundle，plugin-manager 装不了 | 12 |
  | 被 peer 规则拒绝 | 9 |
  | 纯宿主、是 bundle、且 peer 兼容 | 14 |

- **拒绝原因基本都是 peer 精确钉在旧 rc 上。** 例子：
  - `@deepseek-harness-tui/dsh-tui@0.11.0` 要求 `dsh-ptc-runtime-node@0.1.7-rc.1`；
  - `dsh-codex-connect` 把 20 个 peer 钉在 0.1.7-rc.1；
  - `dsh-token-usage-stats` 要求 `dsh-util-values@0.1.2-alpha.2`；
  - `stratagate-dsh` 列举的是 0.1.2～0.1.6 的精确版本；
  - `dsh-win32` 要求 `dsh-subprocess-local <0.1.0-rc.7`。

  **这意味着 DSH 每升一个 rc，都会有一批社区插件失效。** 这是 Q004（钉哪个通道）要考虑的成本。
- **选中 `dsh-office-tools@1.0.4`（下载量 7441）的理由：**
  - 纯宿主，没有 `dsh.client`；运行时依赖为 0。
  - 5 个 DSH peer 都写成 `^0.1.0-rc.6 || … || ^0.1.5-alpha.0`，按含预发布的规则满足 0.1.7-rc.2。
  - 目录标注的能力只有 `fs-read`，没有安全红线，不需要网络。
  - 它提供 8 个 Word / Excel / PowerPoint 工具，读写都经 DSH 的 `ctx.fs` 文件服务，而这正是我方以后放「加密机感知文件接缝」的位置；办公文档本身也贴近我方用户场景。
- **没选的几个更高下载量候选：**
  - `billion-context`：压缩插件，没法「用一次」来验证，而且带 llm 和网络能力，还有一条红线。
  - `@vectorize-io/hindsight-coding-agents`、`@openviking/dsh-memory-plugin`：要依赖外部服务。
  - `dsh-find-plugin`：实时搜 GitHub，需要外网，违反本轮只许访问 npm registry 的约束。
  - `@furongjun1999/dsh-memory`、`dsh-builtin-browser`：需要 shell、网络，或者 Electron 窗口。
- **兼容性说明：** plugin-manager 在 `pnpm view` 阶段检查 peer，没有拒绝这个包。包自带的 `dsh.compatibility.dshReleases` 只列到 0.1.5-rc.2，但 DSH 准入只看 `peerDependencies`，不读这个字段。

## goal：三种终态

| 场景 | 创建方式 | 过程 | 终态 |
|---|---|---|---|
| GOAL-COMPLETE | 人类消息，模型调用 `create_goal`（上限 4 轮） | 第 1 轮：`todo_write` + bash 写 `progress.txt`，然后结束，留给下一轮。第 2 轮：bash 校验 → `todo_write` 全部完成 → `get_goal` → `update_goal complete` → 收到 `<goal_complete>` 收尾提示后回复 | `complete`，共 2 轮，之后不再续跑 |
| GOAL-BLOCKED | 同上（上限 6 轮） | 每轮 bash 读一个不存在的配置文件，然后 `update_goal blocked`。第 1、2 轮被拒：`blocked requires at least 3 consecutive goal rounds; current round is N`，goal 保持 active。第 3 轮被接受 → `<goal_blocked>` 收尾 | `blocked`，原因码 `model-reported`，共 3 轮 |
| GOAL-ROUNDLIMIT | 同上（上限 2 轮） | 两轮都只回文本、不结束 goal | `blocked`，原因码 `round-limit`，由驱动器写入 |
| GOAL-PAUSE | 斜杠命令 `/goal <objective>`（command-goal，默认上限 256 轮） | 第 1 轮在执行 `sleep 8` 时，宿主执行 `/goal pause` → 工具被中止、这一轮结束。暂停后观察 4 s：轮数不变，网关没有收到新请求。然后 `/goal resume` → 第 2 轮 `get_goal` → `update_goal complete` | 先 `paused`（`activation: disarmed`），恢复后 `complete` |

四个场景进入终态后都再等 3 s 复核：轮数不再增长。

转录摘录（取自会话事件；`#` 后面是事件序号，user 消息括号里是 `source.kind`）：

```text
GOAL-COMPLETE
#26 user/message (goal): <goal_round> Objective: "P0-GOAL-COMPLETE: write progress.txt …" Round: 1/4 …
#35 tool/call bash {"command":"echo round-1 > progress.txt && cat progress.txt", …}
#39 assistant/message: Round 1: wrote progress.txt; verification remains for the next round.
#46 user/message (goal): <goal_round> … Round: 2/4 …
#65 tool/call update_goal {"goal_id":"goal-d40e…","revision":1,"action":"complete"}
#66 goal/change complete -> phase=complete rounds=2
#72 user/message (tool-goal): <goal_complete> Objective: "…" The goal is marked complete and this autonomous run is ending. …
#75 turn/end {"kind":"completed"}

GOAL-BLOCKED
#40 tool/result [isError]: Error: blocked requires at least 3 consecutive goal rounds; current round is 1
#64 tool/result [isError]: Error: blocked requires at least 3 consecutive goal rounds; current round is 2
#87 tool/call update_goal {…,"action":"blocked","blocked_reason":"Config /nonexistent/p0-config.json is still missing (round 3)."}
#88 goal/change block -> phase=blocked rounds=3 reason=model-reported
#94 user/message (tool-goal): <goal_blocked> …

GOAL-ROUNDLIMIT
#37 assistant/message: Still polishing (round 2); work remains.
#39 turn/end {"kind":"completed"}
#40 goal/change block -> phase=blocked rounds=2 reason=round-limit

GOAL-PAUSE
#3  command/run /goal P0-GOAL-PAUSE: run the slow check, then finish
#16 tool/call bash {"command":"sleep 8; echo slow-check-done", …}
#17 command/run /goal pause
#18 goal/change pause -> phase=paused rounds=1
#20 tool/result [isError]: Error: tool call aborted
#22 turn/end {"kind":"aborted","reason":{"kind":"user"}}
#23 command/run /goal resume
#24 goal/change resume -> phase=active rounds=1
#39 goal/change complete -> phase=complete rounds=2
```

暂停时进程树的变化：暂停前是宿主 → `bwrap` → `bwrap` → `bash -c sleep 8; …` → `sleep 8`；暂停 1 s 后再看，只剩宿主本身，整棵树都被回收了。

## todo、jobs、审批

- **todo：** `todo_write` 产生 `todo/write` 会话事件（每次都是完整清单）。工具结果是 `Updated todo list: 1 pending, 1 in progress, 0 completed.`
- **jobs：** 过程如下。
  1. bash 带 `run_in_background: true` 执行，立即返回 `started background job bash-8`。
  2. `job_list` 返回 `bash-8 [bash] running — …`。
  3. `job_output`（`wait: true`）返回 `tick-1 tick-2 tick-3 [status: completed, exit code: 0]`。

  第一轮调试时，`job_output` 因为 job id 写错而失败。那一次后台任务结束后，DSH 自己插入了一条 user 消息，`source.kind` 为 `tool-jobs`、`form` 为 `notice`，内容是 `background job bash-8 … finished … Read its output with job_output.`，并据此开了一个新回合。P0-3 的 bridge 要能识别这种消息。
- **审批：** 模型对工作区之外的文件调用 `write`，过程如下。
  1. 第一次不带升级参数，工具报错：`[sandbox: file access denied under workspace-write mode] [sandbox: escalation available — retry …]`，没有触发审批。
  2. 第二次带上 `sandbox_permissions: danger-full-access` 和 `justification`，于是发出 `approval/request`（waterfall 调用），会话里依次记下 `approval/asked`（toolName、callId、`reason: "escalate sandbox to danger-full-access: …"`）和 `approval/decided`（`allowed-once`）。
  3. 应答方是 probe 插件里的替身，结果是文件写入成功。

  也就是说，DSH 的审批只针对「越出沙箱」这一种情况。bash 和工作区内的读写在 `workspace-write` 模式下一次也不会问。

## 社区插件：安装与使用

1. **安装：** 调用 `ctx.pluginManager.installBundle('dsh-office-tools@1.0.4', { registry: npmjs })`，结果如下：
   - `stage: enable`、`changed: true`、`application: restart-required`（我们关了 hmr，所以 profile 只在启动时加载）；
   - 只问了 `https://registry.npmjs.org/`，pnpm 退出码 0；
   - 日志写在 `$DSH_HOME/profiles/aiclient/.plugin-manager/logs/`。
   - pnpm 在输出里提示 `Update available! 11.7.0 → 12.6.0`，说明它会自己去 registry 做版本检查。
2. **重启：** 宿主 2 在 0.73～0.82 s 内就绪。工具数从 22 个变成 30 个，多出的正是 8 个 `word_*` / `excel_*` / `ppt_*` 工具。
3. **使用：**
   - `word_create` 在工作区生成 `p0-report.docx`，7190 字节。写入方式是在临时目录写好再 rename，经 `ctx.fs` 完成。
   - `word_read` 读回的正文与写入内容一致。

## 宿主发出的事件（P0-3 映射的输入）

**持久会话事件**（`session/event`，主运行 8 个会话合计）：

| 类型 | 次数 | 说明 |
|---|---|---|
| `user/message` [append] | 27 | 按 `source.kind` 区分：主运行里出现了 `user`（人类）、`goal`（续跑提示）、`tool-goal`（收尾提示）三种，调试那一轮另外出现过 `tool-jobs`（后台任务通知）。此外还有若干条 runtime context 快照（`Current runtime context …`） |
| `assistant/message` [append] | 44 | `content` 里有 `text` 和 `tool-call`（`id` / `name` / `arguments` 字符串） |
| `tool/call` / `tool/result` [append] | 29 / 29 | 结果带 `isError`。bash 非零退出码不算错误，而是在正文末尾写 `[exit code: 1]`；中止的工具结果是 `Error: tool call aborted` |
| `turn/start` / `turn/end` | 16 / 16 | `turn/end.reason` 取 `completed`，或 `aborted` + `{kind:'user'}` |
| `step/start` / `step/end` | 44 / 44 | |
| `goal/change` | 10 | 完整快照，`operation` 取 create / pause / resume / complete / block |
| `todo/write` | 2 | 完整清单 |
| `command/run` / `command/done` | 3 / 3 | 斜杠命令的执行记录，只写日志、不开回合 |
| `approval/asked` / `approval/decided` | 1 / 1 | 只写日志，不属于 surface 事件 |
| `request/header` / `request/context` | 16 / 8 | 请求配置和工具清单 |
| `system/message` [append] | 8 | 系统提示词 |
| `session/title` | 7 | 我们关了 LLM 起标题，所以都是 fallback |
| `permission/preset` / `sandbox/mode` / `approval/policy` | 各 8 | 会话初始策略 |
| `agent/inbox/spliced` | 38 | 收件箱变更 |

**进程内 Cordis 事件**（主运行里出现过的名字，括号内是分发方式）：

- 流式输出：`agent/assistant-stream`（emit，360 次，帧类型为 start / chunk / end，类型定义在 `dsh-agent` 的 `AssistantStreamFrame`）。
- 回合与状态：`agent/status`（running / idle）、`agent/created`、`agent/pre-step`、`agent/request`、`agent/turn-stopping`、`agent/inbox/claimed|inserted`。
- 工具：`tools/pre-execute|execute|post-execute`（waterfall）、`tools/result`。
- 其他：`llm/stream`、`system-prompt/assemble`、`approval/request`、`goal/changed`、`goal/activation-changed`、`fs/write-intent`、`fs/observed`、`domain/changed`、`session/created|event|flush`、`plugin-manager/changed|install-log`。

对 P0-3 的建议：bridge 以持久会话事件为准（它们可以回放），实时流式文本用 `agent/assistant-stream`，审批卡挂在 `approval/request` 上。

## 子进程清单（Linux）

三种采集方法结论一致：

| 触发 | 子进程 |
|---|---|
| 第一次用到沙箱 | `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true`，是 sandbox-local 的 runner 探测，同步执行 |
| 每次 bash 调用（前台和后台一样） | ① `systemd-run --user --scope --quiet --collect … -- systemctl --user show <unit>.scope …`：subprocess-local 的 user scope 探测，同步执行。本机 user systemd 处于 degraded 状态，探测失败，所以没有真正执行 systemctl，日志报 `weaker process-tree containment`。② `bwrap … --bind <workspace> <workspace> -- bash -c <命令>`，分成外层和 PID 命名空间内两个 bwrap 进程。③ `bash -c`，再由它起具体命令（`cat`、`env`、`cut`、`sleep`） |
| 插件安装 | 三次 `<随包 node> …/pnpm/bin/pnpm.mjs`，分别执行 `config get registry`、`view dsh-office-tools@1.0.4 …`、`add dsh-office-tools@1.0.4 --registry=…`。pnpm 自己没有再派生进程 |
| Office 工具、goal、todo、jobs 管理 | 不派生进程，都在宿主进程内完成 |

主运行里钩子记到 20 次 spawn：1 次 bwrap 探测、8 次 systemd-run、8 次 bwrap、3 次 pnpm。strace 看到的 execve 去重后是 node 4 条、bwrap 7 条、systemd-run 8 条、bash 5 条，外加 `true` / `env` / `cut` / `cat` / `sleep`。

全程没有出现 git、python、shell 以外的解释器，也没有 node-pty：
- jobs 的后台命令同样是普通 spawn 加 bwrap；
- node-pty 只在 `spawnTerminal`（终端类工具）里用，`dsh-base` 不挂这类工具。

两次宿主停止后都没有残留子进程。

加载过的原生模块：`node-addon-require-builtin`（缓存副本）、`node-addon-system`（会话写锁 flock），以及 **`koffi.node`**：Linux 上 subprocess-local 用它调 libc 的 `execve` / `fcntl`（见 `linux-execve.ts`）。Windows 上会话写锁（命名信号量）、`fs-local`、`win32-process`、`sandbox-windows-acl` 也都依赖 koffi。

Windows 上还有两条链路（依据源码，本次没法实测）：
- subprocess-local 的 Windows runner 就是 `process.execPath`（随包 `node.exe`）加 `runner.js`，由它以挂起方式创建目标进程并挂进 Job；
- pwsh 沙箱走 `sandbox-windows-acl`。

## `.env` 被读取的情况

用了三个金丝雀：宿主启动目录、会话工作区、`$DSH_HOME` 下各放一个 `.env`。模型的凭据 key 只写在宿主启动目录的 `.env` 里；工作区的 `.env` 里另放了一个不同的 key 值。

| 位置 | 是否被打开（strace） | 变量是否进了 bash 工具的环境 | 是否用作凭据 |
|---|---|---|---|
| 宿主启动目录 `.env` | 是，启动时 | 是（`hostcwd=from-host-cwd-dotenv`） | 是，假网关收到的 `x-api-key` 全都是这个值 |
| `$DSH_HOME/.env` | 是，启动时 | 是（`dshhome=from-dsh-home-dotenv`） | — |
| 会话工作区 `.env` | **否**，从未打开 | 否 | 否，工作区那个 key 值一次也没出现 |

补充几点：
- 被当作凭据引用的 `AICLIENT_DSH_GATEWAY_KEY` 没有出现在工具环境里（`gatewaykey=` 为空，变量名列表里也没有）。具体是按 `apiKeyEnv` 引用过滤、还是按名字模式过滤，本次没有核实。
- 宿主自身环境里的其他变量会原样传给工具，例如 `AICLIENT_DSH_GATEWAY_URL`、`AICLIENT_DSH_PNPM_CLI`、`DSH_HOME`；DSH 还会补上 `DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_SHELL` 等变量。

**对产品的含义：** P1 里 Main 拉起宿主时，工作目录应设在应用私有目录，不能是用户仓库；环境变量走白名单。`$DSH_HOME/.env` 属于用户级的环境层，里面的内容会流进用户执行的命令。

## 写到 DSH_HOME 之外的文件与网络

| 位置 | 写了什么（strace） |
|---|---|
| `$TMPDIR` | 与 P0-1 相同的原生 addon 缓存和 `dsh-spill-*`；新增 `dsh-subprocess-*`（subprocess-local 的临时目录），以及 `node-compile-cache/v24.18.0-…`（pnpm 入口调用了 `module.enableCompileCache()`） |
| `$HOME`（沙盒） | pnpm 的元数据缓存 `~/.cache/pnpm/v11/metadata/…` 和内容寻址 store `~/.local/share/pnpm/store/v11/…`（含 `index.db`），共 299 项。Windows 上对应 `%LOCALAPPDATA%\pnpm` |
| 会话工作区 | `progress.txt`、`p0-report.docx`，都是先写临时目录再 rename |
| 工作区之外 | 只有审批通过后写的 `outside/approved.txt` |

strace 里另有几条是 bwrap 在沙盒命名空间内的写入：`uid_map` / `gid_map` / `setgroups`（相对路径），以及 `/newroot/dev/*` 下的符号链接。它们不是宿主文件系统上的真实路径。

网络：
- 宿主进程只连过假网关（`127.0.0.1`），没有被拦截的连接，也没有 DNS 查询。
- pnpm 是单独的进程，不在钩子范围内，它访问了 registry.npmjs.org，包括安装本身和版本检查。

模块解析越界：strace 看到 `supports-color` / `has-flag` 被向上解析到工作树根的 `node_modules`（软链到主检出）。和 P0-1 第 10 条是同一类问题，打包时宿主必须放在独立目录。

## 意外与风险

1. **`.env` 泄漏和宿主环境透传。** 见上一节。P1 要定宿主的工作目录和环境变量白名单，并决定是否屏蔽 `$DSH_HOME/.env`。
2. **审批模型不同。**
   - DSH 只在「申请越出沙箱」时审批；沙箱内操作不问；越界不申请就直接拒绝。
   - 决策 001 第 3 条要求沿用我方的逐次审批加四档。这不能只靠 `approval/request` answerer，还得挂 `tools/pre-execute` 这类 waterfall 在工具执行前拦截；沙箱档位也要和我方四档对上。
3. **有两行会往官方上报数据，默认开着：**
   - `session-log-deepseek` 上传会话日志；
   - `plugin-package-inventory-deepseek` 上报已装插件清单。

   两者都只对 `deepseek-official` 路由生效，已经在 bundle 里关掉并加了断言。P1 的 bundle 必须保留这两处关闭。
4. **Linux 上每次 bash 调用都会先同步执行一次 `systemd-run` 探测。** 本机 user systemd 是 degraded 状态，探测失败后退回较弱的进程树回收，但本次各场景都没有残留进程。Windows 走 Job 对象，不受这个问题影响。
5. **宿主停止时有句柄没释放。** 用过工具之后，`fiber.dispose()` 结束时还剩若干 `Timeout` / `PipeWrap` 句柄，靠 `host.ts` 3 s 后强制退出才结束，退出码仍为 0。P1 的 supervisor 需要保留「优雅停止 + 超时强杀」两段。
6. **pnpm 的插件安装会写用户目录并访问网络。**
   - 会写 `%LOCALAPPDATA%`（缓存和 store）并访问 registry，还会自动做版本检查，可以用 `update-notifier=false` 关掉。
   - 加密机上这些文件由 node.exe 写出，然后硬链接或拷贝进 profile。这条链路放进 P0-4，并应和 P1 的「内部白名单 + 官方包」方案一起考虑，比如预装后离线分发。
7. **社区插件把 peer 精确钉版本**，DSH 升级会让一批插件失效，见「社区插件的选择」。

## 复现

```bash
cd src/dsh-host
npm ci                                              # 含 pnpm@11.7.0
../../out-node-runtime/node goal-probe.ts --out /var/tmp/p0-2.json          # 主运行
../../out-node-runtime/node goal-probe.ts --trace --out /var/tmp/p0-2-trace.json
node lib/select-community-plugin.mjs <plugins.json> --top 150               # 插件筛选（需先 npm pack dsh-plugin-catalog）
```

假网关可以单独起：`node <tools>/fake-gateway.mjs --port 0 --plan dsh-p0-2 --log /tmp/gw.jsonl`。

## 局限

- 只在 Linux 上跑过。Windows 的 runner、ACL 沙箱、koffi 信号量、conpty 都要到 P0-4 上机才能验证。
- 假网关回复是瞬时的，所以 goal 状态轮询（300 ms）只拍到了终态，没有中间态的时间线。
- 转录只覆盖脚本化的最短路径，没有测真实模型的行为，比如模型会不会滥用 `blocked`。
- `aiclient-probe` 的审批应答方一律「允许一次」，只验证了通路，没有验证策略。

## 本次新增和改动的文件

- `src/dsh-host/goal-probe.ts`：P0-2 驱动。
- `src/dsh-host/lib/kit.ts`：从 `measure.ts` 抽出的公共部分（进程树采样、沙盒目录、IPC、strace 解析），`measure.ts` 改为引用它，改完后 smoke 复验通过。
- `src/dsh-host/lib/select-community-plugin.mjs`：社区插件筛选脚本。
- `src/dsh-host/bundle/cordis.patch.yml`：关掉官方相关的 9 行，配置 `llm-pi-ai` 路由和 plugin-manager 的 registry。
- `src/dsh-host/bundle/lib/index.js`：probe 插件新增 prompt / command / goal / wait-idle / tools / install-bundle / dispatch-counts 七个请求，加上审批应答替身和事件采集。
- `src/dsh-host/bundle/package.json`：peer 增加 `@deepseek-ai/dsh-llm`。
- `src/dsh-host/host.ts`：断言清单扩到官方相关的行；支持用 `AICLIENT_DSH_PNPM_CLI` 让 pnpm 跑在同一个 node 上。
- `src/dsh-host/package.json` / `package-lock.json`：增加 `pnpm@11.7.0`。
- `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs`：新增 `dsh-p0-2` plan、`--log` 参数、`--port 0`；原有 plan 行为不变。
- 本证据和同名 `.data.json`。
