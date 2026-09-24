# feat/ctrl-enter-interject 分支 GUI 真机点验（2026-09-24，Linux 开发机）

- 分支 `feat/ctrl-enter-interject`，HEAD `46789042`（代码全部已提交；点验期间 `git diff -- src` 始终为空，没有任何 git 写操作）
- 机器：2 核 / 3.3 GB；同一时间只开一个 Electron；没有跑全量测试
- 模型：**全程只用本地假网关**（`probe-fake/fake-sonnet` → `http://127.0.0.1:18124`）。真实 provider 调用次数为零：隔离 profile 里的模型目录只含这一个服务，dev.env 也换成了不带任何真实凭据的副本（见「环境」）

## 结论速览

| 结果 | 数量 | 项 |
|---|---|---|
| ✅ | 18 | A1 A2 A3 A4 A5 A6 A7 A8 A9 · B1 B2 B3 B4 B5 · C1 C2 · D2 D3 |
| ❌ | 2 | **C3**（点开思考块后标题被跟随滚动卷走）· **D1**（掐断本身正确，但失败卡没有出现，只有英文原始报错） |
| 取证 | 1 | D4（三条证据都拿到了） |
| 未验 | 0 | — |

另有清单之外的问题 8 条，见「新问题与观察」。

---

## 环境

### 为什么没用默认的 dev profile

第一次按惯例启动（默认 profile `jyw-ai-client-dev`）时，应用卡死了：CDP 端口在监听，但 `/json/version` 超过 6 分钟都没有响应；Electron 主线程停在 `poll` 里，窗口出不来。

- 当时的事实：GNOME 的 `login` 密钥环是**锁着的**。用 `dbus-send` 读 `org.freedesktop.Secret.Collection.Locked`，返回 `true`（开机是自动登录，没有解锁密钥环）。
- 默认 profile 的 vault 是 `enc: safeStorage`，启动时要用系统密钥环解密。
- 推断：主线程在等密钥环解锁。这是**环境问题**，不是本分支的缺陷。同样的构建换到隔离 profile、加上 `--password-store=basic` 之后，9 秒就起来了，也印证了这一点。

处理方式如下：

1. 按手册往**真实 vault** 注册过一次假网关（先备份）。应用卡住后，用 `register-fake-provider.mjs --restore` 逐字节还原。md5 前后都是 `324185c020bb76e9648726242874f57c`，备份文件已删除。
2. 改用隔离 profile 做全部点验：
   - `AICLIENT_PROFILE=ijpc`，对应 userData `~/.config/jyw-ai-client-ijpc`、状态根 `~/.pilab/jyw-ai-client-ijpc`。路径按代码核实过：`src/main/index.ts:156-158`，以及 `src/shared/appStateLayout.ts` 的 `buildAppStateRoot`。
   - Electron 额外加参数 `--password-store=basic`。
   - 隔离 profile 的 `credentials/vault.json` 是手写的明文 vault：`payload: null`，`userProviders` 只有一条 `probe-fake`（`anthropic-messages`，模型 `fake-sonnet`）。
   - 点验结束后，整个隔离 profile 已删除。
3. dev.env 用的是副本，经 `AICLIENT_DEV_ENV_FILE` 指定，**不含真实凭据**：
   ```
   ANTHROPIC_BASE_URL=http://127.0.0.1:18124
   ANTHROPIC_AUTH_TOKEN=fake-pointcheck-token
   AICLIENT_DEFAULT_TEST_MODEL=fake-sonnet
   AICLIENT_MANAGED_CREDENTIALS=0
   PI_CODING_AGENT_DIR=/tmp/ij/agentdir-empty
   ```
   这样做的原因：仓库里的 `dev.env` 现在是 `AICLIENT_MANAGED_CREDENTIALS=1`（手册写的是 0）。托管模式下，如果没有登录凭据，`resolveNativeModelCatalog` 会直接返回空，用户自己加的服务全部用不了；界面上会弹出「你的账号没有拿到模型访问凭据」。
   D3 用的副本在上面这份的基础上多一行 `AICLIENT_RUNTIME_LOOP_GUARD=0`，用完即删。
4. `AICLIENT_RUNTIME_TRACE_DIR=/tmp/ij/trace`：点验时写了 trace，本目录保留了摘录 `data/trace-excerpts.jsonl`。

### 本 build 的实际落盘位置（与手册不同的地方）

- 会话文件平铺在 `<状态根>/pi-agent/sessions/<sessionId>.jsonl`，**没有**按 cwd 编码的子目录。
- 主进程日志写在 `~/.config/<userData>/logs/aiclient-YYYY-MM-DD.log`。同目录的 `main.log` 只写启动时那几行，`turn failed …` 这类行不会出现在 `main.log` 里。
- 窗口就绪的判断：日志行 `Showing main window` 只在 did-finish-load 或超时的**兜底路径**上才会打印（`MainWindow.ts:259`）。如果走的是 `ready-to-show`，日志里什么都没有。所以工具改成了「CDP 返回 http page target 即算就绪」。

### 启动记录

| 次序 | 打开的路径 | 说明 |
|---|---|---|
| 0 | `/tmp/ij/repo`（默认 dev profile） | 被密钥环卡死，已停止，见上 |
| 0' | `/tmp/ij/repo`（ijpc，托管=1） | 模型目录为空，改用 dev.env 副本后重启 |
| 1 | `/tmp/ij/repo` | A1–A8、B1/B2/B3/B5、C1–C3、D1、D2、D4 |
| 2 | `/tmp/ij/plain`（非 git 目录） | B4、A9（重启后重开会话）、会话树 |
| 3 | `/tmp/ij/repo`，关闭开关 | D3 |

### 测试仓库（`/tmp/ij/repo`，已清理）

```bash
git init -b main; printf 'hello from main\n' > shared.txt; git add -A; git commit -m init
git checkout -b dev;  printf 'dev line\n' >> shared.txt; git commit -am dev
git checkout main; git checkout -b feature/very-long-branch-name-for-width-check-ctrl-enter-interject-pointcheck-2026-09-24
printf 'long branch change\n' > shared.txt; git commit -am long; git checkout main
```

`/tmp/ij/plain` 是一个只放了一个文本文件的普通目录。

### 假网关 `tools/ij-gateway.mjs`

由 batch-e 的 `fake-gateway.mjs` 改写而来，SSE 帧的格式相同。主要区别：

- **一个进程服务所有场景**，场景由最近一条人类消息里的标记决定，换场景不用重启网关。
- 请求的工具列表里有 `Task` 的算父代理，没有的算子代理。
- 每个请求往 `data/gw-requests.jsonl` 写一行：messages 概要、工具列表、最后一条的工具结果文本、历史里工具调用的数量。每个响应也记一行，标明是完整发完（`response_complete`）还是客户端中途断开（`client_abort`，附已发出的 tool_use 块数）。

| 标记 | 行为 |
|---|---|
| `⟦long⟧` | 文字 + `bash echo prep-ok` → 文字 + `bash sleep 20`（`timeoutSeconds: 90`，结束时写一个标记文件）→ `bash echo` → `LONG-DONE` |
| `⟦toolend⟧` | 两次 bash 之后回一条**空的** end_turn（回合以工具收尾，没有最终回答） |
| `⟦sub⟧` | 派 `explorer`（慢子代理：`sleep 45` 后回报）→ `SUB-DISPATCHED` → 收到报告后回 `REPORT-SEEN` |
| `⟦formA⟧` | 派快子代理 → `FORMA-WAITING` → 报告交付后回三件套 → 再回三件套 → 收尾时回 `FORMA-WRAPUP` |
| `⟦formB⟧` | 一条回复里流式写：40 个杂调用（第 10 个是 `write /tmp/loopguard-sentinel.txt`，第 20 个是 `bash touch /tmp/loopguard-touched.txt`）+ 300 组 `TaskList {}` / `TaskStop {"delegationIds":[]}` / `TaskWait {"delegationIds":[],"mode":"any","timeoutSeconds":3}`，每个块间隔 250ms，共 940 个调用 |
| `⟦formBshort⟧` | 10 个杂调用 + 12 组三件套，哨兵文件用另一套路径（D3 用） |
| `⟦think⟧` | 思考 + 文字 + `bash echo think-tool` → 思考 + 约 45 秒的慢速长正文 |
| `⟦echo⟧` 或无标记 | 回 `ECHO: …`；如果收到的是子代理报告，回 `REPORT-SEEN` |

驱动脚本在 `tools/` 下：`ij-lib.mjs` 是公共库，`ij-app.mjs` / `ij-gw.mjs` 控制应用和网关，`sNN-*.mjs` 是各组点验。进程一律按 pid 和 `/proc` 精确处理，从不使用 `pkill -f`。

---

## 逐项结果

### A. 插话（Ctrl+Enter）

| 项 | 做法 | 预期 | 实际 | 结论 | 证据 |
|---|---|---|---|---|---|
| A1 | `⟦long⟧` 回合跑到 `sleep 20` 时，读输入框的占位文案 | 提到 Ctrl+Enter | 「Agent Host 正在运行 —— Enter 排队，Ctrl+Enter 在下一轮后插话…」 | ✅ | `shots/11-a1-running-placeholder.png`，`data/11-a2.json` |
| A2 | 在 `sleep 20` 跑到第 4 秒时，输入框填入插话，用 CDP 发真实的 Ctrl+Enter 按键 | 这一步跑完就结束回合；插话作为下一条自动发出；请求里带插话文字；bash 没被杀 | 网关 13:01:33.351 回了 sleep 那一步；13:01:37.094 按 Ctrl+Enter；**13:01:53.393 标记文件写出**（bash 完整跑了 20 秒，输出 `step-long-done`，`exit=0`）；**13:01:53.599 插话请求到达**（bash 结束后 206ms），请求里含 sleep 的工具结果和「插话-A2」；**没有**第 3 步请求；trace 里有 `turn_stopped_by_interjection`；最后一条 assistant 消息 `stopCause=interjected` | ✅ | `data/11-a2.json`，`data/trace-excerpts.jsonl` |
| A3 | 插话入队后读队列条 | 插话条目有标记 | `1 ↳ 插话 ⟦echo⟧ 插话-A2…`，悬停提示「Ctrl+Enter 插话 —— 在下一个回合边界发送」；普通 Enter 排的条目没有这个标记 | ✅ | `shots/11-a3-queue-marker.png`，`shots/12-a4-queue-order.png` |
| A4 | 运行中先按两次 Enter（排队-1、排队-2），再按 Ctrl+Enter（插话-A4） | 插话排在两条之前 | 队列条显示顺序：1 插话-A4 / 2 排队-1 / 3 排队-2；网关收到的顺序：插话-A4（13:03:10.1）→ 排队-1（13:03:14.2）→ 排队-2（13:03:24.2）；会话里用户消息的顺序与此一致 | ✅ | `data/12-a4.json` |
| A5 | 空闲时按 Ctrl+Enter | 等同普通发送 | 28ms 后网关收到请求；没有入队，没有任何提示；得到正常回复 | ✅ | `data/10-a5.json` |
| A6 | 运行中输入 `/compact`，按 Ctrl+Enter（第一下被斜杠弹窗吃掉，只补全成 `/compact `；第二下才真正执行） | 在本地执行，不作为文字发给模型 | 走的是本地 IPC `chat:compactSession`，被主进程拒绝：`cannot compact the conversation while active`；没有任何含 `/compact` 的请求发给模型；回合**没有**被提前结束（第 2 步和 `LONG-DONE` 都正常出现）。但**界面上没有任何提示**，输入框里一直留着 `/compact `（见 N1） | ✅（附缺陷 N1） | `data/13-a6.json`，`data/main-log-excerpts.txt`，`shots/13-a6-after-ctrl-enter.png` |
| A7 | `⟦sub⟧` 派出慢子代理（sleep 45），父代理进入等待；这时按 Ctrl+Enter | 插话很快送达；子代理泳道保持「运行中」；子代理跑完后，报告在下一次运行里交给模型 | 插话 **201ms** 就送达（13:07:46.131），子代理 13:08:28 才结束；泳道状态从头到尾是 `running`，结束后变成 `completed`，**从来没有**出现 cancelled；报告通过第 29 个请求交给模型（「The following subagents have finished … CHILD-REPORT-SLOW」），发生在插话那一轮之内；trace 里有 `delegates_left_running: 1` 和 `delegation_resume` | ✅ | `data/15-a7.json`，`shots/15-a7-*.png` |
| A8 | 分别看被插话、被 Stop、正常结束、以工具收尾（空回复）四种回合的过程区 | 插话和 Stop 默认展开、点击可收起；以工具收尾的正常回合默认折叠 | 插话结束（A2、A4、A7）：`open=true`，点击后 `false`；Stop 结束：`open=true`，点击后 `false`（bash 被中止，`[exit=null; aborted]`，标记文件没有写出）；正常结束（A8-normal、A6）：`false`；以工具收尾（toolend）：`false` | ✅ | `shots/11-a8-*`，`shots/14-a8-*`，`data/14-a8-c1.json` |
| A9 | 重启应用（第 2 次启动），从侧栏重开上面这些会话；恢复会话 worker 后读会话树 | 展开规则不变；会话树里没有多出 custom 节点 | 重开后：A2、A4、A7、Stop 默认展开，点击可收起；normal、toolend、A6 默认折叠，与重启前一致。会话文件里有 `aiclient.runStop` 条目，但会话树（`chat.getSessionTree`）里**没有**对应节点。树里仍有的 custom 节点是 `aiclient.permissions`（每个会话 1 个）和 `aiclient.subagent`（A7 会话 6 个）——这是 P5-2-4 起就有的行为，不是本分支引入的（见 N4） | ✅ | `data/52-a9.json`，`data/53-a9-a7.json`，`data/40-tree-after-restart.json`，`shots/52-a9-*`，`shots/55-tree-A7.png` |

### B. 分支栏

| 项 | 做法 | 预期 | 实际 | 结论 | 证据 |
|---|---|---|---|---|---|
| B1 | 用真实鼠标事件打开输入框目标栏的分支列，依次选 dev 和 main | 列出全部分支；切换后按钮名立即变过来；能切回原分支 | 列出 `dev` / `feature/very-long…` / `main`；main→dev：HEAD 在 ≤110ms 内就切过去了，按钮在 **508ms** 显示 `dev`；dev→main 用了 451ms | ✅ | `data/30-b-b1.json`，`shots/30-b1-*.png` |
| B2 | `⟦long⟧` 运行中读分支按钮，并尝试点开 | 锁定 | `disabled=true`，锁图标的 aria-label 是「当前对话正在运行 —— 切换分支前先停止它」；弹层没有打开；点 Stop 之后解锁 | ✅ | `data/30-b-b5-b3-b2.json`，`shots/30-b2-locked-while-running.png` |
| B3 | 在 main 上把 `shared.txt` 改成未提交状态，再切到 dev | 切换失败，并显示 git 的报错 | 红色报错：「切换分支失败: Error invoking remote method 'git:branch:checkout': Error: error: Your local changes to the following files would be overwritten by checkout: shared.txt …」；HEAD 仍在 main | ✅（附观察 N6） | `shots/30-b3-checkout-refused.png` |
| B4 | 第 2 次启动时打开 `/tmp/ij/plain`，在第一列选 `plain` | 不显示分支栏 | 目标栏只有「plain ∨ ｜ 本机」两项，没有分支按钮 | ✅ | `data/51-b4-switch.json`，`shots/51-b4-plain-selected.png` |
| B5 | 切到那条超长分支名 | 显示得下，最多约 240px，超出截断 | 按钮宽度正好 240px（计算样式 `max-width: 240px`）；文字 scrollWidth 486 > clientWidth 186，末尾显示省略号 | ✅ | `shots/30-b5-long-branch.png` |

### C. 时间线

| 项 | 做法 | 预期 | 实际 | 结论 | 证据 |
|---|---|---|---|---|---|
| C1 | `sleep 20`（`timeoutSeconds: 90`）运行期间，每 500ms 读一次整行文字，共 35 次 | 显示「已耗时 / 超时上限」并每秒走动；数字单调递增；与墙钟误差在取整范围内 | 行文字形如「运行中 sleep 20; … · 7s / 1m 30s」；数字单调不减，从 1s 走到 18s，上限始终是 `1m 30s`；墙钟减去显示值落在 −0.44 到 +0.09 秒之间 | ✅ | `data/14-a8-c1.json`（`normal.c1Samples`），`shots/14-c1-running-clock.png` |
| C2 | `⟦think⟧` 流式期间和结束后读思考行 | 默认折叠 | 流式中显示「思考中」，结束后显示「思考 片刻」，`aria-expanded` 全程为 `false`，正文不渲染 | ✅ | `shots/16-c2-*.png`，`shots/16-c3-before-click-thought.png` |
| C3 | 页面停在底部、正文还在流式输出时，点开视野内的思考标题或工具行，每 150ms 采样 scrollTop 和标题的 rect | 页面不被自动滚走，刚点开的标题留在视野里 | **思考块**：点击时标题在 top=542（视口范围 68–772）；约 160ms 后 scrollTop 从 8467 跳到 8933（+466，正好是展开面板的高度），标题跑到 top=76；约 470ms 后移出视野（top=49），之后跟着流式正文一路往上滚走。在内容还没溢出视口的会话里复现也一样：展开后第一段新正文一到，就跳到底部，标题跑到 −641。**工具行**：点击后 scrollTop 立刻 +173（面板高度），标题从 516 跳到 343，4.5 秒的采样窗口内还在视野里，但页面仍在持续跟随 | ❌ | `data/17-c3-thought.json`，`data/17-c3-tool.json`，`data/16-c2-c3.json`，`shots/17-c3-thought-after-click.png` |

### D. 死循环防护

| 项 | 做法 | 预期 | 实际 | 结论 | 证据 |
|---|---|---|---|---|---|
| D1 | `⟦formB⟧`，重复做了两次（`s20` 和 `s21`） | 几十个调用之内掐断，之后没有新请求；哨兵文件和 touch 文件都不存在；出现失败卡「模型输出出现重复调用，已中断」；画出的工具行不多且都有结局；再发一条消息能正常回复，而且请求里不带那条退化回复 | 在**第 47 个** tool_use 块处掐断（两次都是）：流到第 11.8 秒，3134 帧只发了 155 帧，网关记到 `client_abort`；之后 15 秒内**没有**新请求。哨兵文件和 touch 文件都**不存在**。时间线上 47 行，全部是红色的结束态，没有转圈。再发一条能正常回复，那次请求里只有两条 user 消息，历史中工具调用数为 0。trace 和会话文件记录的规则是 `identical_call TaskList {}`，出现 3 次，其中子代理调用 7 个。**但失败卡没有出现**：store 里 `runtimeErrorCode = tool_call_repetition`，会话状态却是 `idle`；页面上找不到「模型输出出现重复调用」，只在输入框上方有一个英文原始报错框「Error: The model wrote the same subagent tool call 3 times…(run send-…)」（见缺陷 F2） | ❌ | `data/20-d1.json`，`data/21-d1b.json`，`shots/20-d1-*.png`，`shots/21-d1b-failure-surface.png` |
| D2 | `⟦formA⟧`：快子代理交付报告之后，父代理连续两条回复都只有三件套 | 第一次空调用拿到完整的终态说明，之后的空调用被拒；两条空转回复之后进入一轮收尾（核对这一轮有没有 tools）；正常结束，不报「达到轮次上限」 | 第 1 组：TaskList 拿到完整答复加终态说明（「Nothing is left to wait for…」）；TaskStop 和 TaskWait 都是「Refused: … has nothing left to act on」。第 2 组：三个调用**全部** Refused。接着第 46 个请求是收尾：最后一条是内部提示「Stop now and do not call any tool — a tool call in this reply will be refused…」，**请求里仍带着 14 个 tools**（代码注释说明是有意保留定义，调用会被 `beforeToolCall` 拒绝），模型回的是文字。之后结束，没有错误，没有 `stopCause`，页面上也没有「上限」字样。trace：`delegation_idle_loop replies=2` 和 `delegation_idle_wrap_up` | ✅ | `data/22-d2.json`，`shots/22-d2-end-expanded.png` |
| D3 | 用加了 `AICLIENT_RUNTIME_LOOP_GUARD=0` 的 dev.env 副本重启（第 3 次启动），发 `⟦formBshort⟧`（46 个调用） | 不被掐断 | 46 个块全部流完（`response_complete`，11.8s），46 个工具结果全部执行，0 个被拒；哨兵文件和 touch 文件被真实创建（开关关闭时这是预期结果，文件已删除）；会话文件里 0 条 `aiclient.loopGuard`；没有错误；最终回复 `FORMBSHORT-DONE`。跑完即恢复默认，副本已删除 | ✅ | `data/60-d3.json`，`shots/60-d3-*.png` |
| D4 | 读会话文件、主进程日志和会话树 | 有 `aiclient.loopGuard` 条目；有 `turn failed: tool_call_repetition` 行；树里没有这些条目的节点 | 3 条 `aiclient.loopGuard`：两次 formB 是 `identical_call`，formA 是 `idle_replies`。日志行在 `logs/aiclient-2026-09-24.log`，同目录的 `main.log` 里没有，因为它只写启动行。D1 和 D2 会话的树里都**没有** loopGuard 节点 | 取证 | `data/session-file-bookkeeping-entries.txt`，`data/main-log-excerpts.txt`，`data/40-tree-*.json` |

---

## 缺陷清单（❌）

### F1（C3）流式输出中点开思考块，标题立刻被跟随滚动卷走

- **复现**：
  1. 在一个已经有长内容的会话里发 `⟦think⟧`。
  2. 等第二段流式正文开始输出，保持停在底部。
  3. 点正文上方那个「思考 片刻」标题。
- **现象**：面板展开后，下一段正文一到（约 160ms），跟随器就按「新增内容」滚到底，滚动距离正好等于面板高度（466px）。刚点开的标题在 0.5 秒内离开视野。工具行同样会跳一段面板高度（173px），只是因为面板矮，标题暂时还留在视野里。
- **推断**（没有实测验证）：提交里「展开 / 收起不再被当成新内容」只管住了展开那一帧；展开后的第一次正文增长，仍然触发了「贴底跟随」，把展开的高度一起追了过去。
- **证据**：`data/17-c3-thought.json`（逐帧 scrollTop 和标题 top）、`shots/17-c3-thought-before.png` / `-after-click.png` / `-4s-later.png`

### F2（D1）形态 B 被掐断后，没有出现失败卡「模型输出出现重复调用，已中断」

- **复现**：发 `⟦formB⟧`，等它被掐断（约 12 秒）。
- **现象**：
  - store 里：`runtimeError` 是英文句子，`runtimeErrorCode = 'tool_call_repetition'`，会话 `status = 'idle'`。
  - 页面上：只有输入框上方的英文原始报错框，没有中文失败卡。`i18n` 里的中文标题和原因都没有渲染出来。
- **推断**（读代码得出，未做实验验证）：
  - 失败卡只在 `status === 'failed'` 时渲染，见 `MessageTimeline.tsx:838`。
  - runtime 的 `projector.finish()` 先发 `session.failed`，store 把状态设成 `failed`；紧接着又发 `session.status: idle`，store 的 `upsertSessionStatus` 把状态覆盖成 `idle`。所以 `sessionFailure.ts` 里新加的 `tool_call_repetition` 文案实际到不了屏幕。
  - 其它走同一路径的失败可能也受影响，这一点本轮没有验证。
- **证据**：`data/21-d1b.json`（`store` 与 `dom` 字段）、`shots/21-d1b-failure-surface.png`

## 新问题与观察（清单之外）

| 编号 | 描述 | 证据 |
|---|---|---|
| N1 | **运行中执行 `/compact`，点了没反应。** 主进程拒绝，错误是 `cannot compact the conversation while active`，界面没有任何提示，输入框一直留着 `/compact `。另外第一下 Ctrl+Enter（或 Enter）会被斜杠弹窗吃掉，只做补全，第二下才真正执行 | `data/13-a6.json`，`data/main-log-excerpts.txt`（原日志第 104 行），`shots/13-a6-after-ctrl-enter.png` |
| N2 | **被插话结束的回合，重开后「已工作」时长变小。** A2、A4 在线时显示「已工作 20 秒」，重启重开后显示「已工作 1 秒」。作为对照：Stop 回合重开前后都是 4 秒，正常回合都是 20 秒 | `shots/11-a8-interjected-turn-default.png` 与 `shots/52-a9-A2-interjected-default.png` |
| N3 | **排队消息逐条释放的间隔偏长。** A4 里，插话那条发出后 4.1 秒才发排队-1，再过 10.0 秒才发排队-2；而每条的回复在假网关上只需约 20ms | `data/12-a4.json` 的 `requestOrder` |
| N4 | **会话树里有无标签的 custom 节点（既有行为）。** `aiclient.permissions` 每个会话 1 个；`aiclient.subagent` 每次委派 4～6 个，A7 会话的树一共 17 个节点，其中 7 个是 custom。这两类条目在 P5-2-4 就已存在，不是本分支引入的；本分支新增的 `runStop` 和 `loopGuard` 已正确隐藏 | `shots/55-tree-A7.png`，`data/40-tree-after-restart.json` |
| N5 | **被拒绝的空转调用看起来像成功了。** D2 里 5 个 `Refused` 结果在时间线上显示为普通灰色的「已停止子 Agent 未指定委派 / 已等待子 Agent 未指定委派」，看不出被拒。D1 被掐断的 47 行虽然是红色，但文案用的也是「已列出 / 已停止 / 已等待」这类过去式，实际上一个都没执行 | `shots/22-d2-end-expanded.png`，`shots/20-d1-settled-expanded.png` |
| N6 | **B3 的报错被截断后只剩没用的前缀。** 行内报错宽度上限是 `max-w-48`，截断后只看得到「切换分支失败: Error invoki…」这段 IPC 包装前缀，git 的原话只在悬停提示里 | `shots/30-b3-checkout-refused.png` |
| N7 | **被 Stop 中止的 bash 标成了成功。** 它的 `tool_result` 在 store 里是 `toolOk=true`，内容是 `(no output) [exit=null; aborted]` | `data/14-a8-c1.json` 的 `stop.messages` |
| N8 | **环境问题（非本分支）：密钥环锁着会让应用卡死。** GNOME `login` 密钥环锁定时，默认 dev profile（vault 是 safeStorage 加密）启动后主线程卡死、CDP 不回包，没有任何提示；另外仓库 `dev.env` 现为 `AICLIENT_MANAGED_CREDENTIALS=1`，与手册里的 0 不一致。以后点验建议沿用本轮的隔离 profile 配方 | 本文「环境」一节 |

## 未验项

无。A6 的环境能跑，只是本地命令被拒绝，已按实际结果记录。

## 环境还原

- 进程：自己启动的 Electron（dev.js 进程树）和假网关都已按 pid 停止。复查 `/proc` 里已没有相关进程，9222 / 5173 / 18124 三个端口都没有监听。
- 真实 vault：已按字节还原，md5 与原件一致（`324185c0…`），自己留的备份文件已删除。
- 隔离 profile：`~/.pilab/jyw-ai-client-ijpc` 和 `~/.config/jyw-ai-client-ijpc` 已整体删除。
- 真实 dev profile：卡死那次启动在 `~/.config/jyw-ai-client-dev` 里留下了 `Singleton*` 残留链接（指向已退出的 pid 83839），已删除。
- 临时文件：5 个 `/tmp/scoped_dir*` 都已删除；`/tmp/ij`（测试仓库、dev.env 副本、请求体、trace）已删除；两次运行的哨兵文件都已清理。
- 仓库：`git diff -- src` 为空，没有做任何 git 写操作。工作区里别的 `M` 文件是同期其它代理改的，与本轮无关。
