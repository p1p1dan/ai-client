# 批次 H 本地 GUI 点验（2026-09-18，开发机 Electron dev）

Role: evidence。本目录记录批次 H（T077～T086）落地代码在真实 Electron 里跑出来的结果。上游落地明细见同级 [../README.md](../README.md)；任务身份见 [roadmap.md](../../../roadmap.md) 批次 H。

**本轮只读代码、不改 `src/`、不提交、不 stash。** 所有模型请求都打向本地假网关，全程没有使用任何真实 provider 发出成功请求（唯一一次接触真实端点的意外见 T086 一节）。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `/home/ai/code/ai-client` · `feat/runtime-evolution` |
| 点验时的 HEAD | `f3b658d4`（`feat(terminal): TUI 里新建的会话在终端关闭时登记进侧栏…`） |
| 收尾时的 HEAD | `e1137cc0`（点验期间有人提交了 plantree 文档；**仅文档，`src/` 与点验时完全一致**） |
| 时间 | 2026-09-18 09:05 ～ 09:40 EDT |
| 机器 | 2 核 / 3350 MB 内存 / 3861 MB swap |
| `free -m` available | 启动前 1904 MB · 应用跑起来后约 1060～1460 MB · 收尾后 1859 MB |
| 启动方式 | `DISPLAY=:0 no_proxy=localhost,127.0.0.1,::1 node scripts/dev.js --remote-debugging-port=9222` |
| 窗口就绪耗时 | 本轮约 30 s（比手册记的 103 s 快，因为内存宽裕） |
| 模型 | 只有 `probe-fake/fake-sonnet`（本地假网关）。注册假服务后 `chat.listPiModels()` **只返回这一个模型**，真实 provider 在会话侧根本不可选 |
| 假网关 | `tools/fake-gateway.mjs --port 18090`，Anthropic Messages SSE 替身 |

### 本轮对工具的改动（都在 evidence 目录，不在 `src/`）

`tools/fake-gateway.mjs` 是批次 E 那份的副本，加了三样东西：

1. **`--dump-dir <目录>`**：把每个 POST 的原始请求体逐个写成 `req-NNN.json`。T077 要看的 `system[].cache_control.ttl` 在原来那行日志里没有，必须落盘才看得见。
2. **`write-twice` plan**：第 1、2 个请求都回一个写 `probe-write.txt` 的 `tool_use`，同一个路径写两次——T081 的「第二次还弹不弹卡」需要这个。
3. **`subagent-delegate` plan**：第 1 个请求回 `Task` 工具调用（`agent: "explorer"`），之后一律回纯文本。子代理自己那次请求就是到达网关的第 2 个请求，配合 `--dump-dir` 就能在同一次运行里对比主对话与子代理的 `cache_control`。

---

## 2. 逐项结果

| 项 | 判定 | 一句话结论 | 证据 |
|---|---|---|---|
| **T077** 缓存 TTL 上线 | **PASS** | 主对话 `cache_control` 带 `ttl:"1h"`，子代理那次请求只有 `{type:"ephemeral"}`（即 5m），设置页两个档位都在 | `artifacts/t077-cache-control-summary.txt`、`artifacts/t077-req-001-main.json`、`artifacts/t077-req-002-subagent.json`、`shots/t077-01/02/03` |
| **T078** 完全放行档 | **PASS** | 第四档存在、二次确认面板出现、确认后触发器变红、reload 后新会话回到「每次询问」 | `shots/t078-01/02/03/04` |
| **T080** 运行中切档撤卡 | **PASS（主判据）/ FAIL（副判据，已修待复验）** | 卡挂着时把档位调宽 → 卡消失、写入真的执行、回合继续；但「卡挂着时 mode 单选项灰掉」**没有发生**，模式选项全程可点。**本条 FAIL 已于同日修复并提交 `03e0b6d8`**（`turnActive={busy \|\| sending}`），复验见下方第 8 节 | `shots/t080-01`、`shots/t080-02` |
| **T079** 设置弹窗内下拉 | **PASS** | 嵌套弹窗内下拉 z-index 80 > 71，普通设置页下拉 60 > 51，两处 `elementFromPoint` 都命中下拉项 | `shots/t079-01`、`shots/t079-02` |
| **T084** 上下文占用点击 | **PASS** | 点百分比按钮展开 Popover（`data-open`，z-index 40），再点收起（节点卸载） | `shots/t084-01` |
| **T081** 授权记忆 | **PASS** | 副标题写「会记住 write 可访问 probe-write.txt」；点「本会话内允许」后第二次写同一文件不再弹卡，直接执行 | `shots/t081-01`、`shots/t081-02`、`artifacts/fake-gateway-2026-09-18.jsonl` |
| **T086** TUI `/new` 登记 | **BLOCKED** | 本轮没验成：TUI 的模型请求 401 → pi 不落盘会话文件 → 没有可扫描的滞留会话，链路无法触发。**原记录归因（「读的是用户私人 `~/.pi/agent`」）已被复核推翻**，真因是应用目录的 `settings.json` 没写默认渠道、pi 回落到内置 anthropic，详见本文 T086 一节末尾 | `artifacts/t086-tui-transcript.txt` |

---

## 3. 每项的做法与所见

### T077 缓存 TTL 上线 —— PASS

**做了什么。** 假网关起 `subagent-delegate` plan 并开 `--dump-dir`；在主对话里发一句「用 Task 工具委派一个子代理列出当前目录」。假网关先回一个 `Task` 工具调用委派给内置的 `explorer` 子代理，子代理自己那一轮请求随后也打到同一个网关。四次请求的请求体全部落盘。

**看到什么。** 逐个请求的缓存标记（完整表在 `artifacts/t077-cache-control-summary.txt`）：

| 请求 | 是谁的 | 工具清单 | `system[0].cache_control` |
|---|---|---|---|
| req-001 | 主对话 | 14 个（含 `Task` / `TaskWait` / `TaskList` / `TaskStop`） | `{"type":"ephemeral","ttl":"1h"}` |
| **req-002** | **子代理（explorer）** | **4 个（`read,bash,glob,grep`，正是 explorer 定义里的那四个）** | **`{"type":"ephemeral"}` —— 没有 `ttl`** |
| req-003 | 主对话（回填委派结果） | 14 个 | `{"type":"ephemeral","ttl":"1h"}` |
| req-004 | 主对话（子代理报告回来） | 14 个 | `{"type":"ephemeral","ttl":"1h"}` |

主对话、工具清单最后一块、消息末块三处都打上了 `ttl:"1h"`；子代理三处都是裸 `ephemeral`。这就是决策 024 要的「主 1h / 子 5m」，而且**子代理请求确实是通过同一条链路发出去的**（工具清单被裁到 explorer 的四个，能证明它不是主对话的重复请求）。

**设置页。** 两个档位都在「设置 → Pi」这一页里（本 build 里 `PiModelManagementSettings` 与 `PiSubagentsSettings` 是同一页的两个区块，不是两个独立导航项）：

- 「提示词缓存 → 主对话」：`5 分钟` / `1 小时` 两个按钮，当前 `1 小时` 为 `aria-pressed="true"`（`shots/t077-02`）
- 「子代理 → 子代理提示词缓存」：当前 `5 分钟` 为 `aria-pressed="true"`（`shots/t077-03`）

两处说明文案与真实行为一致。

### T078 完全放行档 —— PASS

**做了什么。** 在一个已有会话里点输入框旁的权限档位触发器 → 菜单 → 选「完全放行」→ 二次确认 →「应用」→ 然后 reload 应用。

**看到什么。**

1. 档位单选组有四项：`每次询问` / `自动接受编辑` / `全自动` / `完全放行`，第四项文案是「完全不再询问。连『全自动』都会停下来确认的命令也直接执行；明确的拒绝规则依然生效。」（`shots/t078-01`）
2. 点第四项不立即生效，弹出确认面板：标题「关闭全部授权询问？」，正文明写「该档位不会被保存为新对话的默认」，按钮是「取消 / 应用」（`shots/t078-02`）
3. 点「应用」后，触发器文字变 `执行 · 完全放行`，class 里带上 `bg-destructive/10 text-destructive hover:bg-destructive/20`，界面上确实是红底红字（`shots/t078-03`）
4. `localStorage` 里只有当前会话那一行变成 `{"mode":"agent","gear":"bypass"}`，**没有写出任何默认档记录**（`aiclient:chat:default-permissions` 键根本不存在）
5. reload 之后新会话的触发器是 `执行 · 每次询问`，普通样式（`shots/t078-04`）

### T080 运行中切档撤卡 —— 主判据 PASS，副判据 FAIL

**做了什么。** 假网关换 `write-approval` plan，新会话发「请写一个文件 probe-write.txt」，等授权卡出现；在卡挂着的时候打开档位菜单，把档位从「每次询问」切到「全自动」（走了二次确认）。

**看到什么（主判据，PASS）。** 点「应用」后 4 秒内：

- 授权卡从输入框上方消失，没有留下「已拒绝 / 已超时」之类的残影
- 工具**真的执行了**：`/home/ai/code/ai-client/probe-write.txt` 落盘，内容是假网关给的 `hello from fake gateway`（23 字节）
- 回合继续并正常收尾：时间轴显示「已工作 1 分 5 秒」+ 模型的收尾文本，右上「审阅」计数变 1
- 触发器变成 `执行 · 全自动`

对照 `shots/t080-01`（卡挂着）与 `shots/t080-02`（切档之后）。

**看到什么（副判据，FAIL）。** 期望是「卡片挂着时 mode 单选项灰掉但 gear 可点」。实测：**卡挂着时六个单选项（两个 mode + 四个 gear）全都可点**，一个都没灰；菜单底部那行也仍然是「立即生效，作用于当前线程。」，而不是运行中该显示的「回合进行中只能改权限档位。」。

初步归因（只读源码，未改动）：`ComposerPermissionTrigger` 的 `modeLocked` 来自它的 `sending` prop（`src/renderer/components/chat/ComposerPermissionTrigger.tsx:154` 的 `const modeLocked = sending === true;`），而 `ChatComposer` 传给它的是自己那个**本地发送闩** `sending`（`ChatComposer.tsx:3083`）——`setSending(true)` 在 `:1462`、`setSending(false)` 在 `:2408`，只覆盖「send 这个 IPC 调用在飞」的那一小段。真正表示「回合在跑」的是同文件 `:602` 的 `busy = isStoppable(activeSession?.status)`，`:606` 的 `canStop = busy || sending` 就是两者的并集。也就是说组件里那段注释描述的「A running turn locks the MODE」目前**几乎永远不会发生**：等卡出现时 `sending` 早已回落成 false。

这是个观感/一致性问题，不影响 T080 的核心能力（切档撤卡），但它让「运行中改 plan/agent 模式」这条本来被刻意锁住的路在真实运行期间是敞开的。**修法方向**：把 `:3083` 那处的 `sending={sending}` 换成 `sending={busy || sending}`（或直接给组件多传一个 `busy`）。是否要改请拍板，本轮没动代码。

> **已修（2026-09-18，提交 `03e0b6d8`）**：按上述方向落地，并把 prop 名从 `sending` 一并改成 `turnActive`，因为它承载的语义已经是「本回合进行中」而不是「发送请求在飞」。传入值 `busy || sending` 与同文件里 `canStop`（决定是否显示停止按钮）、模型选择器的 `disabled` 用的是同一个信号，不是新发明的写法。
>
> 反向风险已自查：`busy` 读的是会话状态仓库里的 `status`，该字段按 16 毫秒一批刷新（队列攒满 256 条会提前强刷），所以回合真正结束与界面解锁之间有一个最长约一帧的窗口。这个窗口**自愈**——`busy` 每次渲染都重新读，刷新一落地锁就解开；且它不是本次引入的新依赖，停止按钮与模型选择器早就在承受同一个延迟。另外输入框本身按既有设计（注释标注 T-19）故意不看 `busy`/`sending`，回合中用户始终能继续打字并排队，所以「能输入」与「模式是否锁」本来就是两件事。
>
> 回归测试加在 `composerFormStatic.test.ts` 的源码扫描断言里（`toContain('turnActive={busy || sending}')`），而不是组件挂载测试——因为缺陷不在组件自身逻辑（给它真值它一直锁得对），而在调用方喂错了值，而本仓没有任何测试完整挂载过 `ChatComposer`。相关 32 个测试文件 / 719 条用例全绿，根 `tsc --noEmit` 干净。

### T079 设置弹窗内下拉 —— PASS

**做了什么。** 设置 → Pi → 「AI 服务」区块 → 「添加服务」打开嵌套弹窗「添加 AI 服务」→ 点开「服务」下拉（服务预设）。再回到「通用」页点开「语言」下拉。全程只看不存，没有点「保存」，vault 未被应用改写。

**看到什么。**

| 场景 | 弹层 z-index | 底下弹窗 z-index | `elementFromPoint` 命中 |
|---|---|---|---|
| 嵌套弹窗内的「服务预设」下拉 | **80**（`DROPDOWN_IN_NESTED_MODAL`） | 71（`NESTED_MODAL_CONTENT`） | 下拉项 `Mistral`，在 listbox 内部 |
| 普通设置页的「语言」下拉 | **60**（`DROPDOWN_IN_MODAL`） | 51（`MODAL_CONTENT`） | 下拉项 `英语`，在 listbox 内部 |

截图上下拉完整盖在弹窗之上，没有被裁切或被弹窗遮住（`shots/t079-01`、`shots/t079-02`）。

### T084 上下文占用点击 —— PASS

**做了什么。** 点输入区右侧的 `0%` 小按钮（`aria-label="上下文占用"`），读弹层状态，再点一次。

**看到什么。** 第一次点击后出现 `[data-context-details]` 面板，容器带 `data-open`，z-index 40（`Z_INDEX.DROPDOWN`）。内容完整：上下文窗口剩余量、占用进度条、最近一次模型请求的六行 token 明细、会话累计、本轮工具调用（`write × 2`）。再点一次按钮，面板卸载。`shots/t084-01`。

### T081 授权记忆 —— PASS

**做了什么。** 假网关换 `write-twice` plan（同一路径写两次），新会话（档位默认「每次询问」）发「请连续写两次 probe-write.txt」，在第一张卡上点「本会话内允许」。

**看到什么。**

- 卡的副标题是：**「本会话内允许」会记住 write 可访问 probe-write.txt · 对本次会话内的所有代理生效，含子代理**——路径就是被批准的那一个文件本身，与 `6913c264`「只记批准的那一个文件，不再放大到目录」一致（`shots/t081-01`）
- 点「本会话内允许」后，第一次写执行（26 字节）；**第二次写同一文件没有再弹卡**，直接执行。假网关日志里两条 `tool_result:Wrote 26 bytes to …probe-write.txt` 相隔 31 毫秒（13:25:59.879 / 13:25:59.911），中间没有任何等人的空档
- 整个回合 21 秒结束，磁盘上的文件内容是第二次写的 `hello from fake gateway #2`，「审阅」计数为 2（`shots/t081-02`）

### T086 TUI `/new` 登记 —— BLOCKED

> **复核纠正（编排器，2026-09-18 收口时）**：下面原记录的两条定因都是错的，实测现象属实但归因不成立。正确结论见本节末尾的「复核后的真因」。错误的推断保留在原位不删，用作调查轨迹。

**卡在哪（原记录，归因已被推翻）：内嵌 TUI 读的模型配置不是应用的，是用户自己的 `~/.pi/agent`，手册里的两条改法都够不着它。**

试了两轮，都是先 sha256 备份再改、全程可还原：

1. **第一轮**：按手册把应用 profile 下的 `~/.pilab/jyw-ai-client-dev/pi-agent/models.json` + `auth.json` 改写成只有假网关一个 provider，再用 preload IPC `piTui.open({terminalId, cwd, cols, rows})` 起 TUI，写 `/new\r`、写一句话 `\r`。
   TUI 状态栏显示 `(anthropic) claude-opus-4-8`，模型请求返回 `401 authentication_error: invalid x-api-key`。
2. **第二轮**：怀疑是环境变量压过了文件，于是复制一份 dev.env（`ANTHROPIC_BASE_URL=http://127.0.0.1:18090`、`ANTHROPIC_AUTH_TOKEN=fake-key`、`PI_CODING_AGENT_DIR=/tmp/…/tui-agent` 指向只含假网关的 agent 目录），用 `AICLIENT_DEV_ENV_FILE` 整个重启应用后重跑。
   TUI 状态栏**还是** `(anthropic) claude-opus-4-8`，还是 401（这次是 `Invalid bearer token`）。

**定因（都是实测，不是推断）：**

- 假网关两轮都是 `count: 0`——**一个请求都没收到**，所以流量根本没往 `127.0.0.1:18090` 去。
- 两次报错都带 Anthropic 形态的 `request_id`（`req_011Cf…`），说明请求打到了真实端点。两次都是 401，**没有成功调用、没有产生任何真实模型用量**；两次之后即停手，没有另找 provider 替代。
- pi CLI 的 bundle 里 `grep -a` 不到 `PI_CODING_AGENT_DIR` 这个字符串——**这个变量是 ai-client 自己的，pi CLI 根本不读**，所以第二轮那条路从一开始就是空的。
- 真正的来源是用户自己的 pi 目录：`~/.pi/agent/settings.json` 里写着 `defaultProvider: "dan"` / `defaultModel: "claude-opus-4-8"`。**没有去动它**——那是用户的私人配置，不属于本次点验能改的范围。

**因此链路无法触发**：pi 的会话文件是懒写的（第一条 assistant 消息才落盘），模型请求 401 之后 pi 没写出任何 `.jsonl`，于是终端关闭时的滞留会话扫描没有东西可扫。实测两轮前后 `session-index.json` 都是 **173 行没变**，`piTui.onSessionsIndexed` 一次都没推。

**已经确认可用的半截链路**（`artifacts/t086-tui-transcript.txt`）：`piTui.open` 成功返回 `{generation:1, resumed:false}`；`/new` 被 TUI 接受并打出 `✓ New session started`；输入的那句话正确回显。**只差模型能回一句话**。

**下次要接着做，需要先解决的（原记录）**：找到一条能让内嵌 TUI 指向假网关、又不碰 `~/.pi/agent` 的办法。可能的方向是在 `piTui.open` 之前给 pty 注入一个临时 `HOME`（或 pi 自己的配置目录变量，需要先从 pi 的 CLI help / 源码确认变量名），但本轮没有验证过，不要当结论用。

#### 复核后的真因（编排器，同日收口）

上面两条定因都不成立，逐条更正：

**更正一：pi 确实读 `PI_CODING_AGENT_DIR`，而且 auth 与 settings 都从它取。** 原记录说「pi CLI 的 bundle 里 `grep -a` 不到这个字符串」，是因为只搜了入口文件 `dist/bundle/cli.js`——那只有 629 字节，是个转发 shim，真正的代码在同级 `chunks/` 的 44 个文件里。在 `chunks/chunk-OMWWHBTG.js` 里可以读到：

```js
ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`   // APP_NAME = "pi"
function getAgentDir(){ let envDir = process.env[ENV_AGENT_DIR];
  return envDir ? expandTildePath(envDir) : join(homedir(), ".pi", "agent") }
function getAuthPath(){ return join(getAgentDir(), "auth.json") }
function getSettingsPath(){ return join(getAgentDir(), "settings.json") }
```

所以内嵌 TUI 读的是应用目录 `~/.pilab/jyw-ai-client-dev/pi-agent/`，**不是**用户私人的 `~/.pi/agent/`。这条更正同时给了 **T082 一个正面结论**：那个「保管箱变更后重写 `auth.json`」的修复写对了目录，TUI 读的确实是它写的那一份。（教训：「搜不到」永远比「搜到了」弱，尤其当搜索范围本身就选错时——搜 bundle 要搜 `chunks/`，不要只搜入口文件。）

**更正二：第二轮之所以无效，是应用自己把那个变量覆盖了。** 第二轮通过 dev.env 设 `PI_CODING_AGENT_DIR=/tmp/…/tui-agent` 确实是对路子的，但 `PiTuiPty.ts` 构造 pty 环境时先复制继承环境、随后 `Object.assign(env, managedEnv)`，而 `resolveManagedPiWorkerEnv()`（`piModelConfig/index.ts:303`）无条件写死 `PI_CODING_AGENT_DIR: getAppPiAgentDir()`——继承来的值在这一步被盖掉。所以那条路不是「空的」，是**被应用自己关上的**。

**第一轮 401 的真因：应用目录的 `settings.json` 里没有默认渠道。** 那份文件只有 `packages` / `theme` / `lastChangelogVersion` 三个键，没有 `defaultProvider`、没有 `defaultModel`。pi 从 `settingsManager.getDefaultProvider()` 读不到值，就退回自己内置的默认选型（anthropic + `claude-opus-4-8`，正是状态栏显示的那个），于是请求打向真实 Anthropic 端点、拿一个不存在的 key，必然 401。第一轮改写 `models.json` 加入假网关 provider 是不够的——**光有 provider 没有默认指向，pi 不会选它**。

**顺带暴露的一处产品面事实**：全仓 `src/` 搜不到任何写 `defaultProvider` 的地方，也就是说**应用从不把用户在界面上选的渠道告诉内嵌 TUI**，TUI 永远走 pi 自己的默认选型。这不是本批次引入的，也不构成新缺陷立项——[决策 011](../../../decisions/011-managed-tui-company-channel-usable-not-exclusive.md) 已经拍板「只保证没有其他渠道时公司渠道可用，用户自己的 key 与其他渠道不管」，当前现象正落在那条「不管」的范围里（本机 local 模式下 `models.json` 有三个私人 provider，pi 挑不中任何一个，就回落到内置 anthropic）。记在这里只是为了让下一个人不要把它当成回归。

**因此，让 T086 可验的正确做法**是下面任一条，都不需要碰用户私人的 `~/.pi/agent`：

1. 往应用目录 `~/.pilab/<profile>/pi-agent/settings.json` 里临时写入 `defaultProvider` / `defaultModel`，指向假网关那个 provider（备份后改，验完还原）。
2. 让应用切到公司账号（managed）模式并登录——那时 `models.json` 里只剩公司 provider，pi 的兜底选型自然会命中它（[决策 011](../../../decisions/011-managed-tui-company-channel-usable-not-exclusive.md) 当初的实测就是这个形态）。

---

## 4. 清单之外观察到的异常

1. **T080 副判据那条模式锁失效**（见上，已给初步归因与修法方向）——这是本轮唯一一条明确的 FAIL。
2. **主对话与子代理都拿到了同一份 `tools[...]` 缓存标记位置**：`cache_control` 打在**工具清单的最后一个工具**上（主对话是 `TaskStop`，子代理是 `grep`）。这是 pi-ai 自己的分块策略，行为正确，只是记一下——以后如果有人按「打在 system 上」去 grep 会漏掉一半。
3. **注册假服务后真实 provider 直接从会话侧消失**：写进 vault 的自建服务一旦是明文数组，`chat.listPiModels()` 就只返回这一个模型，`~/.pilab/…/pi-agent/models.json` 里的 cx2 / maxapi / vllmproxy 一个都不出现。这对点验是好事（想误用真实 provider 都没得选），但也说明**自建服务与 agentDir 里的 provider 不是合并关系**，值得单独确认是不是有意为之。
4. **`subagent-delegate` plan 下界面出现两条 `turn finished`**：这是假网关 plan 的产物（req-003 与 req-004 都回了纯文本），不是渲染重复，不用查。
5. **点验期间 HEAD 被别的进程推进了一个提交**（`f3b658d4` → `e1137cc0`，纯文档）。所有结论对应的代码是 `f3b658d4`，两个提交之间 `src/` 无差异。

---

## 5. 收尾清单

- [x] 假网关自建服务已 `--restore` 还原：`vault.json` 回到 `userProvidersEnc: "safeStorage"` + 加密字符串（备份文件 `vault.json.bak-2026-09-18T13-09-57-131Z` 保留在 credentials 目录）
- [x] 手写的 `~/.pilab/jyw-ai-client-dev/pi-agent/models.json` / `auth.json` 已还原，`sha256sum -c` 两项 **OK**
- [x] 假网关进程已杀，18090 端口已释放
- [x] Electron / electron-vite / esbuild 全部退出，9222 与 5173 端口已释放（按 `/proc/*/cmdline` 精确核对，**没有用 `pkill -f`**）
- [x] 点验产生的 `probe-write.txt` 已从仓库根删除（它命中 `.gitignore` 的 `/*.txt`，本来也不会进 git）
- [x] `git status --short -- src/` 为空；工作区只剩 plantree 文档与本目录
- [x] 收尾后 `free -m` available 回到 1859 MB（启动前 1904 MB），无泄漏

## 6. 未做的项与原因

| 项 | 原因 |
|---|---|
| T086 TUI `/new` 登记 | 本轮 BLOCKED，见上。停手本身是对的（按「假网关起不来就停下报告，不要自选替代」的约定，两次 401 之后就停了）；但原因判断错了，**复核后已知怎么做**（给应用目录的 `settings.json` 临时写默认渠道，或切公司账号模式），留待第二轮 |
| T080 「gear 可点」之外的 mode 锁 | 做了，结论是 FAIL，已记录并已派修 |
| bypass 档下 `rm -rf` 的实际行为（Q022） | 不在本轮清单内，且在自己的仓库里跑破坏性命令风险不对等，没做。**收口时以静态方式确认**：`src/runtime/plugins/permissions/` 与 `tools/` 下不存在任何 `rm` 拦截规则（只有两处注释提到这个词），与[决策 023](../../../decisions/023-bypass-permissions-tier.md)「不加黑名单」一致；相关 183 条权限测试（`shellPolicy` / `tools` / `subagentDefinitions`）全绿 |
| T083 搜索性能、T082 TUI 凭据同步 | 不在本轮清单内。T082 由本轮 T086 的复核**间接得到一个正面结论**：TUI 读的确实是应用目录那份 `auth.json`，修复没有写错地方 |

---

## 7. 文件清单

```
pointcheck/
├── README.md                    ← 本文件
├── tools/
│   ├── bh-cdp.mjs               CDP 驱动库 + CLI（eval / shot / enter / text）
│   ├── bh-send.mjs              走 textarea + [aria-label="发送消息"] 真发一条消息
│   ├── bh-tui.mjs               走 preload IPC 驱动内嵌 TUI（open → /new → 一句话 → dispose）
│   ├── bh-tui-dump.mjs          读回 TUI 的 pty 输出并剥 ANSI
│   ├── fake-gateway.mjs         批次 E 版 + 本轮新增 --dump-dir / write-twice / subagent-delegate
│   ├── register-fake-provider.mjs  批次 E 原样副本（把假网关写进 vault，--restore 还原）
│   └── cdp-eval.mjs             批次 E 原样副本
├── shots/                       14 张截图，文件名前缀即任务号
└── artifacts/
    ├── t077-cache-control-summary.txt   四次请求的 cache_control 摘要
    ├── t077-req-001-main.json           主对话请求体原文
    ├── t077-req-002-subagent.json       子代理请求体原文
    ├── t086-tui-transcript.txt          TUI pty 输出（剥 ANSI、去掉 spinner 帧）
    └── fake-gateway-2026-09-18.jsonl    本轮假网关请求日志
```

> 上面这份清单只到第一轮为止。第二轮补验（第 8 节）另外加了 `tools/round2/`、5 张截图和 5 份 artifact，清单在 8.7。

---

## 8. 第二轮补验（2026-09-18）

Role: evidence。补验第一轮遗留的三条：T080 副判据（第一轮 FAIL，`03e0b6d8` 已修）、T078 bypass 档下破坏性命令的实际行为（Q022）、T086 TUI `/new` 登记（第一轮 BLOCKED）。**结论：三条全部 PASS。**

**第 1～7 节一字未改**，本节只追加。

### 8.1 本轮环境（与第 1 节的差异）

| 项 | 值 |
|---|---|
| 点验时的 HEAD | **`03e0b6d8`**（`fix(chat): 回合进行中真正锁住权限模式选择…`），即第一轮 FAIL 的那条修复已在代码里 |
| 时间 | 2026-09-18 10:08 ～ 10:42 EDT |
| 应用 | **沿用第一轮之后由用户启动、一直在跑的那个 Electron dev 实例**，本轮没有重启过它；启动参数多带了 `AICLIENT_RUNTIME_TRACE_DIR=/tmp/bh-trace-q021`，所以本轮多了一份 runtime trace 可查 |
| 凭据模式 | 接手时停在登录页，按约定点「使用本机已有配置」进本地模式；全程 `未登录` |
| 模型 | 同第一轮：注册假服务后 `chat.listPiModels()` 实测返回 `{"models":[{"id":"probe-fake/fake-sonnet","label":"fake-sonnet"}],"source":"local"}` —— **只有这一个**，真实 provider 在会话侧根本不可选。收尾还原后再查一次，回到 cx2 ×3 + maxapi ×1，`probe-fake` 消失 |
| 假网关 | `tools/fake-gateway.mjs --port 18090`，本轮先后跑 `write-approval` → `bypass-rm` → `text` 三个 plan |
| `free -m` available | 开工前 1542 MB，收尾 1111 MB |

**本轮对工具的改动**（仍然都在 evidence 目录，不在 `src/`）：`fake-gateway.mjs` 新增 **`bypass-rm`** plan（第 1 个请求回纯文本 `ready`，第 2 个请求回一条 `bash` 工具调用，命令是写死在常量 `RM_SANDBOX` 上的绝对路径 `rm -rf /tmp/bh-rm-sandbox/sub /tmp/bh-rm-sandbox/b.txt && ls -la /tmp/bh-rm-sandbox`，第 3 个起回 `turn finished`）。分两步是因为 `bypass` 档在会话还不存在时是禁用的（`ComposerPermissionTrigger.tsx:286` 的 `unavailable = option.id === 'bypass' && !sessionId`），得先有一个回合把会话建出来。

### 8.2 逐项结果

| 项 | 判定 | 一句话结论 |
|---|---|---|
| **T080 副判据** 卡挂着时 mode 锁死 | **PASS** | 两个模式项 `aria-disabled="true"` + `pointer-events:none`，四个档位项全部 `aria-disabled:null`，菜单底部换成运行中文案 |
| **T078 / Q022** bypass 档下 `rm` | **PASS（行为确认）** | 不弹卡、直接执行、目标真消失；trace 里写着 `decision:"allow" source:"policy" gear:"bypass"`，与[决策 023](../../../decisions/023-bypass-permissions-tier.md)「不加黑名单」一致 |
| **T086** TUI `/new` 登记 | **PASS** | 假网关收到 TUI 的请求、`/new` 会话落盘、关终端后 `session-index.json` 176→177、`onSessionsIndexed` 推了、侧栏出现该行、点开正常打开并自动转出 `.native-v4.jsonl` |

---

### 8.3 T080 副判据 —— PASS

**第一轮那次读数是错的（不是修复没生效）。** 第一轮在「卡挂着」和「读菜单」之间隔了几分钟，等真正去读 DOM 时授权卡早已因 120 秒无人响应而自动拒绝、回合也结束了——这时菜单本来就该是解锁的。本轮第一次复现也踩了同一个坑：先读到「六项全可点 + 底部『立即生效，作用于当前线程。』」，回头一查界面已经是「已工作 2 分 / turn finished」，假网关日志里写着 `[tool_result:nobody answered the permission request in time]`（`artifacts/fake-gateway-round2-2026-09-18.jsonl` 里 14:12:07 发出、14:14:07 超时那一对）。

**所以本轮把判据改成一次 `Runtime.evaluate` 里同时取「卡在不在」和「菜单 DOM」**，让快照不可能跨在回合结束的前后两侧。脚本 `tools/round2/t080-run.mjs`，动作是：新建会话 → 发「请写一个文件 probe-write.txt」→ 轮询到 `等待审批` 出现 → 立刻开菜单 → 一次取全部。

**取到的东西**（完整原文在 `artifacts/t080-menu-dom-while-card-up.json`）：

同一时刻 `cardWaiting: true`、倒计时 `119` 秒、`turnFinished: false`，此时六个 `[role="menuitemradio"]`：

| 选项 | `aria-disabled` | `data-disabled` | `pointer-events` | `opacity` | `tabindex` |
|---|---|---|---|---|---|
| **规划** | **`"true"`** | **`""`** | **`none`** | **`0.64`** | `-1` |
| **执行** | **`"true"`** | **`""`** | **`none`** | **`0.64`** | `-1` |
| 每次询问 | `null` | `null` | `auto` | `1` | `0` |
| 自动接受编辑 | `null` | `null` | `auto` | `1` | `-1` |
| 全自动 | `null` | `null` | `auto` | `1` | `-1` |
| 完全放行 | `null` | `null` | `auto` | `1` | `-1` |

两个模式项的副标题同时换成了「本轮对话结束后可修改。」（`Can be changed once this turn ends.`），菜单底部那行是 **「本轮对话进行中只能修改权限档位。」**，即 `While this turn runs, only the permission level can change.` 的中文译文，不再是「立即生效，作用于当前线程。」。截图 `shots/t080-03-mode-locked-while-card-up.png`。

**主判据没被改坏**（`tools/round2/t080-widen.mjs`）：在卡还挂着的时候把档位从「每次询问」切到「全自动」（走了二次确认面板「启用全自动？」→「应用」），**1.5 秒内**：

- 授权卡消失（`cardWaiting: false`），没有残影
- 时间轴出现 `turn finished`，触发器变 `执行 · 全自动`
- 工具真的执行了：`/home/ai/code/ai-client/probe-write.txt` 落盘，**23 字节**，内容 `hello from fake gateway`
- 假网关计数从 2 走到 4（发送一次 + tool_result 回填一次）

截图 `shots/t080-04-card-released-after-widen-rerun.png`。

> **方法记一条：这个菜单只有 `element.click()` 打得开。** `Input.dispatchMouseEvent`（三段 mouseMoved/Pressed/Released，加不加 `pointerType: 'mouse'` 都试过）点在触发器正中心，菜单一个 `menuitemradio` 都不出来；`btn.click()` 一次就出六个。批次 E 手册 §2.6 记的「GUI/TUI 开关 CDP 驱动不了」是同一类现象的另一半——**别默认哪一种点法通用，两种都要留着**。四种点法逐个试的探路脚本存成了 `tools/round2/t080-open.mjs`。

---

### 8.4 T078 / Q022 bypass 档下的 `rm` —— PASS（行为确认，不是缺陷）

**先说安全边界。** 全程只在 `/tmp/bh-rm-sandbox` 里做，这个目录是本轮临时建的，里面只有 `a.txt` / `b.txt` / `sub/nested.txt` 三个文件。命令里的路径是**绝对路径、写死在 `fake-gateway.mjs` 的 `RM_SANDBOX` 常量上**，不经任何命令行参数，也就不可能因为敲错一个 flag 而指向别处。`a.txt` 全程没有被命令点名，它是对照组。**仓库目录里没有跑过任何 `rm`。**

**做了什么。** 新建会话 → 发一句无害的话（假网关回 `ready`，把会话建出来）→ 把档位切到「完全放行」（走二次确认「关闭全部授权询问？」→「应用」）→ 再发一句话，假网关回 `bash` 工具调用。

**看到什么。**

1. **没有弹授权卡**。这条不是靠肉眼或轮询判的——`AICLIENT_RUNTIME_TRACE_DIR` 落下来的 trace 里，这一回合只有一个 `permission_decision` 步骤，内容是（`artifacts/t078-bypass-rm-trace.json`）：

   ```json
   {
     "event": "permission_decision", "phase": "decision",
     "request": { "tool": "bash",
       "command": "rm -rf /tmp/bh-rm-sandbox/sub /tmp/bh-rm-sandbox/b.txt && ls -la /tmp/bh-rm-sandbox" },
     "decision": "allow", "source": "policy", "mode": "agent", "gear": "bypass"
   }
   ```

   `source: "policy"` 就是「策略直接判的」，没有 `ask` 阶段、没有等人。

2. **命令直接执行，而且是立刻**。trace 里 `tool_execution_start` 在 `14:21:17.133`、`tool_execution_end` 在 `14:21:17.235`——**102 毫秒**；假网关两条日志相隔 `14:21:17.127` → `14:21:17.247`，**120 毫秒**。界面上这一回合显示「已工作 1 秒」。
3. **目标真的没了**：`sub/`（含 `nested.txt`）与 `b.txt` 双双消失，`exitCode: 0`；命令自带的 `ls -la` 回来的内容里只剩 `a.txt`，与磁盘实际一致。
4. 触发器是红的：`className` 含 `bg-destructive/10 text-destructive`，计算色 `oklch(0.5042 0.1648 27.84)`。

截图 `shots/t078-05-bypass-rm-no-card.png`。

**结论**：决策 023 说的「不加黑名单」在运行时确实如此——`bypass` 档下 `rm -rf` 与任何别的命令没有区别，不做特判、不弹卡。这是**设计如此，本条是行为确认，不立缺陷**。第一轮第 6 节那条静态核对（`permissions/` 与 `tools/` 下不存在 `rm` 拦截规则）由此得到动态印证。

> **顺带看到一处小的、与本条无关的东西**（只记录，不主张）：上面那个 `permission_decision` 的 `request.paths` 是
> `["/home/ai/code/ai-client/a", "/home/ai/code/ai-client/f", "/tmp/bh-rm-sandbox", "/tmp/bh-rm-sandbox/b.txt", "/tmp/bh-rm-sandbox/sub"]`。
> 前两项不是真路径，磁盘上也不存在。命令里只有 `-rf` 和 `-la` 两个 flag 含 `f`、`a` 这两个字母，所以**推测**是 flag 的字母被当成了工作区相对路径——这一步是推断，没有去读解析代码确认，`r` 与 `l` 为什么没出现也没查。可确认的事实只有一条：这次判定的 `paths` 里混进了两个不存在的工作区路径。在 bypass 档下没人看得见，但**会弹卡的档位下，卡片上列出的受影响路径可能会混进 `<工作区>/a`、`<工作区>/f` 这类条目**——这一条也没有在卡片 UI 上实测过。留给后续判断要不要立项。

---

### 8.5 T086 TUI `/new` 登记 —— PASS

第一轮 BLOCKED 的归因（见第 3 节 T086 与其后的「复核后的真因」）方向是对的，但**只做那一步还是跑不通**。本轮实际需要三件事同时成立：

**（一）给 pi 一个能用的默认渠道。** 按复核结论，备份后往 `~/.pilab/jyw-ai-client-dev/pi-agent/settings.json` 加了 `defaultProvider: "probe-fake"` / `defaultModel: "fake-sonnet"`，并把同目录的 `models.json` 改写成**只有假网关一个 provider**（三个真实 provider 全部移走，这样 pi 连回落都无处可去）、`auth.json` 改写成只有 `probe-fake: {type:"api_key", key:"fake-key"}`。

配完先用 pi CLI 自己验了一次，不碰应用：

```
$ env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
    PI_CODING_AGENT_DIR=/home/ai/.pilab/jyw-ai-client-dev/pi-agent \
    node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --list-models
provider    model        context  max-out  thinking  images
probe-fake  fake-sonnet  128K     16.4K    no        no
```

**（二）终端必须带着 `sessionFile` 打开，否则这条链路根本没布防。** 这是第一轮和复核都没提到的一环：`src/main/ipc/piTui.ts:391` 的 `if (request.sessionFile)` 把 `rememberSessionDirectory()` 整个包住，而那个「开终端前的目录快照」正是终端死后扫滞留会话的唯一依据（`reportStrandedSessions` 拿不到快照就直接 return）。第一轮用的 `bh-tui.mjs` 调的是 `piTui.open({terminalId, cwd, cols, rows})`，**没有 `sessionFile`**——所以即使模型当时能回话，这一条也验不出来。真实用户路径是「GUI 里开着一个会话 → 切 TUI」，那条路一定带 `sessionFile`。

**（三）交接的那个会话文件里记的模型也得是假网关。** 第一次带 `sessionFile` 重跑时闸门拦下了：TUI 状态栏显示 `(anthropic) claude-opus-4-8`。原因是被 resume 的那个文件（第一轮 09:33 留下的探针会话）里写着 `{"type":"model_change","provider":"anthropic","modelId":"claude-opus-4-8"}`，**resume 时会话自带的模型压过 `settings.json` 的默认值**。于是在会话目录里造了一份全新的 pi v3 会话文件（只有 header + `model_change: probe-fake/fake-sonnet` + `thinking_level_change` 三行），拿它做交接对象。

> **这一步有真实风险，所以脚本里加了闸门。** 应用进程自己带着 dev.env 的 `ANTHROPIC_BASE_URL=https://api.vllmproxy.com` 和 `ANTHROPIC_AUTH_TOKEN`（实测 `/proc/<electron pid>/environ`），而 `PiTuiPty.ts:175-178` **只在 managed 模式下**剥掉凭据类环境变量——本地模式的 pty 是原样继承的。也就是说，pi 一旦回落到内置 anthropic provider，就会拿着真 token 打真端点（第一轮那两次 401 就是这么来的）。`tools/round2/t086-tui.mjs` 因此在**打字之前**先读 pty 状态栏，不是 `probe-fake` 就立刻 `dispose` 并以非零码退出。第一次重跑正是被它拦下的，**假网关计数当时是 0，事后确认没有任何请求发出**。

**接通之后看到什么。**

1. **假网关真的收到了 TUI 的请求**：`/health` 从 `count:0` 变成 `count:1`。这是第一轮从未达成的前置条件。
2. TUI 状态栏全程 `(probe-fake) fake-sonnet`；`/new` 打出 `✓ New session started`；发出去的「回一个字：丁」拿到了回复，状态栏 token 计数变成 `↑12 ↓9`（正是假网关 SSE 里写的 `input_tokens:12` / `output_tokens:9`）。pty 全文在 `artifacts/t086-tui-transcript-round2.txt`。
3. **pi 落盘了 `/new` 的会话文件**：`sessions/--home-ai-code-ai-client--/2026-09-18T14-32-25-183Z_01a0b4ee-….jsonl`，1171 字节（懒写，第一条 assistant 消息才出现——与既有认知一致）。
4. **关终端后登记进了侧栏**。`piTui.dispose()` 之后 **1.5 秒内**：
   - `session-index.json` 从 **176 行变成 177 行**
   - 新增的那一行（`artifacts/t086-indexed-row-round2.json`）：`sessionId: 19c881be-…`、`runtimeIdentity` 指向 **pi 的原件**、`agent: "pi"`、`workspacePath: /home/ai/code/ai-client`、`title: ""`、`archived: false`
   - `piTui.onSessionsIndexed` 推了 `{sessionIds:["19c881be-…"]}`
   - 侧栏 `ai-client` 仓库下**第一行就是这条新会话**，回落标题 `Session a5eed4`、分支 `feat/runtime-evolution`，**没有手动刷新也没有 reload**。截图 `shots/t086-01-tui-new-session-indexed-in-sidebar.png`
5. **点开不报错**。点那一行，会话正常打开，标题栏 `Session a5eed4 · ai-client · Main`，正文就是 TUI 里那轮对话（`回一个字：丁` → `fake gateway ok`），没有任何 alert/错误文案。同时磁盘上出现了 `<原件>.native-v4.jsonl`（1984 字节）与其 `.writer.lock`，索引行的 `runtimeIdentity` 也**被改绑到了那个 v4 副本**并补上了 `piLeaf` ——这正是 `legacy.ts prepareSessionConfig` 自动转格式 + Main 改绑的那套，`f3b658d4` 说的「不需要新的转换代码」成立。截图 `shots/t086-02-tui-session-opens-in-gui.png`

---

### 8.6 收尾清单（逐条核对）

- [x] 假网关自建服务已 `--restore` 还原：`vault.json` 的 `sha256sum -c` **OK**（备份 `vault.json.bak-2026-09-18T14-08-17-150Z` 留在 credentials 目录）
- [x] 手写的 `~/.pilab/jyw-ai-client-dev/pi-agent/settings.json` / `models.json` / `auth.json` 全部还原，`sha256sum -c` 三项 **OK**，文件权限位（664 / 600 / 600）与原来一致
- [x] 还原后 `chat.listPiModels()` 回到真实 provider（cx2 ×3 + maxapi ×1），`probe-fake` 已消失
- [x] **没有碰过 `~/.pi/`**（用户私人 pi 配置），全程只动 `~/.pilab/jyw-ai-client-dev/` 下的文件
- [x] `/tmp/bh-rm-sandbox` 已整个删除
- [x] 点验产生的 `probe-write.txt` 已从仓库根删除；为交接造的那份 pi v3 会话脚手架文件也已删除
- [x] 假网关进程已按 `/proc/*/exe` + `cmdline` 精确核对后 kill（**没有用 `pkill -f`**），18090 端口已释放
- [x] **Electron 没有关**：pid 681336（electron）/ 681299（vite）仍在，9222 仍应答，界面可用（`textarea` 在、`role="dialog"` 为 0、侧栏 168 行）
- [x] `git status --short -- src/` **为空**；工作区改动只有 plantree 文档与本目录

> 途中有一次自伤值得记下来：用 `for p in /proc/[0-9]*` 扫 `cmdline` 找假网关时，**匹配到了我自己那条 bash 命令行**（因为命令文本里就含 `fake-gateway.mjs --port 18090`），把自己的 shell 杀了。教训与 `pkill -f` 完全一样，**扫 `/proc` 也得先用 `readlink /proc/<pid>/exe` 把进程限定成 `node`**，光比对 cmdline 不够。

### 8.7 本轮新增文件

```
pointcheck/
├── tools/
│   ├── fake-gateway.mjs                 ← 本轮新增 bypass-rm plan（其余未动）
│   └── round2/
│       ├── t080-run.mjs         新建会话→发话→等卡→开菜单→同一次 evaluate 取全部
│       ├── t080-menu.mjs        只读菜单 DOM 的各项禁用态与底部文案
│       ├── t080-open.mjs        探路：四种开菜单方式逐个试，只有 element.click() 成
│       ├── t080-widen.mjs       卡挂着时放宽档位并观察撤卡/执行/收尾
│       ├── t078-run.mjs         bypass 档下的 rm 全流程（含 500ms 轮询看有没有卡）
│       ├── t086-tui.mjs         带 sessionFile 开 TUI + 打字前的「必须是 probe-fake」闸门
│       ├── t086-dispose.mjs     关终端并盯 session-index.json / onSessionsIndexed
│       ├── t086-open-row.mjs    点开新登记的那一行，看会不会报错
│       ├── dump2.mjs            剥 ANSI 读回 pty（修了 bh-tui-dump.mjs 的贪婪正则，见下）
│       └── click.mjs            CDP 真鼠标点击（用于 .click() 打不开的元素）
├── shots/
│   ├── t080-03-mode-locked-while-card-up.png       卡挂着时两个模式项灰掉、四个档位项可点
│   ├── t080-04-card-released-after-widen-rerun.png 放宽后卡消失、回合收尾
│   ├── t078-05-bypass-rm-no-card.png               完全放行档下 rm 直接跑完，全程无卡
│   ├── t086-01-tui-new-session-indexed-in-sidebar.png  TUI /new 的会话出现在侧栏第一行
│   └── t086-02-tui-session-opens-in-gui.png        点开它，正文就是 TUI 里那轮对话
└── artifacts/
    ├── t080-menu-dom-while-card-up.json    卡在/菜单 DOM 的同一时刻快照（本条的硬证据）
    ├── t078-bypass-rm-trace.json           runtime trace 里那一回合的步骤（含 permission_decision）
    ├── t086-tui-transcript-round2.txt      TUI pty 全文（剥 ANSI）
    ├── t086-indexed-row-round2.json        sweep 写进 session-index.json 的那一行
    └── fake-gateway-round2-2026-09-18.jsonl 本轮假网关请求日志
```

> **`tools/bh-tui-dump.mjs` 有个会静默吃掉全部内容的 bug，本轮没改它，在 `round2/dump2.mjs` 里绕开了。** 它的 OSC 剥离正则写成了 `/\][^]*(?:|\\)/g`——字面上的 ESC / BEL 控制字符在写入文件时丢了，只剩下 `]` 和 `[^]*`，于是从 pty 流里第一个 `]` 起整段吞掉。实测一份 66586 字节的 pty 流被它剥成 **17 个字符**，而且不报错。`dump2.mjs` 用 `[\s\S]*?` 非贪婪 + 保留真实转义字符重写，同一份流剥出 11373 字符。
