# 批次 D4 真机复验 — 九项修补（T060～T068）在用户可见层面的结论

证据目录 [dev-D4-reverify](../../docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/dev-D4-reverify/)
（相对路径以仓库为准：`docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/dev-D4-reverify/`）。

环境：同一台 Linux 开发机（2 核 / 3.3 GB），HEAD `b3d751e3`，分支 `feat/runtime-evolution`，
**工作区带 T060～T068 九项未提交修补**，dev 模式跑的就是工作区代码。
全程假网关、三次起停、逐条还原，细节见 [env-teardown.txt](…/dev-D4-reverify/env-teardown.txt)。

**一句话总账：九项里 6 项完全成立、2 项部分成立、1 项未生效。**

---

## 一、T060 / DEV-2 补格 + D6 —— ✅ 成立

**判据**：GUI 改「保存位置」到新目录 → 新建临时对话发一句 → scratch 落在新根；
跑过回合的临时对话在打开/关闭一个普通工作区文件夹后仍在侧栏。

**做了什么 / 看到什么**（[T060-t0-roots.txt](…/T060-t0-roots.txt) / [T060-t1-after-gui-change.txt](…/T060-t1-after-gui-change.txt)）：

- 设置 · 通用 · 临时会话 · 保存位置 填 `/home/ai/JYWAI/temporary-d4new`，
  settings.json 的 `aiclient-settings.state.defaultTemporaryPath` 当场变成这个值。
- **改完 1 分钟内**（右键「临时对话」分组 →「新建临时对话」→ 发一句）：
  scratch 目录落在 **新根** `temporary-d4new/unbound-sessions/e5c490bd-…`，
  旧根 `~/JYWAI/temporary/` 一个子目录都没有 —— 缺陷版这里会落回旧根（D13）。
- **DEV-2-c**：重启后 `session-index.json` 里这条会话的 `workspacePath` 指向新根；
  改设置**之前**建的三条 devB 会话仍指旧根（旧行不迁移，是预期）。
- **D6**：run 2 用 `--open-path=/tmp/t032/d4/ws-normal` 多开一个仓库（= 打开一个普通工作区文件夹），
  再从侧栏「仓库操作 →移除仓库」把它关掉（= 关闭）。
  工作区数 2 → 1（证明工作区树签名真的变了、`rebindSessionsToTree` 跑了），
  **16 条未绑定会话一条没少**，其中跑过一轮的 `session-1789666511934-glr2gmf` 仍在「临时对话」分组里
  （[T060-D6-after-repo-removed.png](…/T060-D6-after-repo-removed.png)）。缺陷版这里会当场消失、重启才回来。

> 取证口径的一点说明：「添加仓库」走的是原生文件对话框，CDP 驱动不了，
> 所以「打开」那半边用 `--open-path` 在启动时注册（产品自己的代码路径），「关闭」那半边是真点界面。

---

## 二、T061 / DEV-33 —— ✅ 成立

**判据**：4 条「5 MiB + 1 MiB 图」后第 5 条被拒 → 再发一句纯文本能发出并出现在时间线；
退出重开该会话，附件片显示文件名而非 `image/png`。

**字节账**（每条消息两张图，走 composer 的 paste 入口，与 E2 同一条 `ingestFiles` 管线）：

| 发送 | 结果 | 会话文件字节 | MiB |
|---|---|---|---|
| 1 | 成功 | 8,377,933 | 7.989 |
| 2 | 成功 | 16,755,020 | 15.978 |
| 3 | 成功 | 25,132,107 | 23.968 |
| 4 | 成功 | 33,509,196 | 31.958 |
| 5 | **被拒** | 33,509,767 | 31.958 |

- 第 5 条被拒，composer 上方仍是那个红色 mono 块 `Error: session exceeds the configured size budget`
  （[T061-01-fifth-rejected.png](…/T061-01-fifth-rejected.png)）；假网关计数停在 5，模型侧没被调用。
  **这条改动前就成立的错误提示没有被「不再失败」顺手抹掉** —— T061 复验点 2 成立。
- **清掉附件、打一句纯文本、点发送 → 成功**：网关计数 5 → 6，会话文件 +926 字节，
  时间线出现「fake gateway ok」（[T061-02-plaintext-after-reject.png](…/T061-02-plaintext-after-reject.png)）。
  E2 那轮这里是**连试 3 次全部静默失败**，D1/D24 的正面验证通过。
- **附件名回放（D25）**：退出应用、重开、点回该会话，历史 11 条全部回来、`historyErrors` 为空，
  时间线上 `big-5mib.png` ×4、`small-1mib.png` ×4，**`image/png` 出现 0 次**
  （[T061-03/04 截图](…/T061-03-attachment-names-after-restart.png)）。
  落盘侧也对得上：4 行消息各带两个 `aiclientName`（[T061-jsonl-attachment-names.txt](…/T061-jsonl-attachment-names.txt)）。

---

## 三、T062 / DEV-32 —— ⚠️ 部分成立（码通了，中文卡还是没出来，而且状态条是英文）

完整读数在 [T062-result.txt](…/T062-result.txt)。

**成立的那半（D3，选择器与 worker 同一份目录）**：
`chat.listPiModels()` 返回的只有 `probe-fake/fake-sonnet`，与 worker 报的「(1 available)」完全一致；
物理 `models.json` 里手写的 `vllmproxy` / `cx2` / `maxapi` **不再出现在选择器里**。
诊断行现在真的落进了按天日志（info 级）：
`[pi-models] models.json holds providers no session can use { dropped: 'cx2, maxapi, vllmproxy', … }`。
（任务书提到的 `~/.pilab/t37c-agent/models.json` 那份也有同样三个 provider，但 H/19 之后它只是读配置来源，不参与目录。）

**没成立的那半（D19，中文覆盖层）**：

- 稳定码**确实传到了**渲染层：`store.lastError` = `model_not_in_catalog: no model "vllmproxy-old/claude-does-not-exist" in the catalog (1 available)`，
  `isModelMissingError()` 现在命中（改动前两个信号都对不上，是死分支）。
- composer 的红块不再是裸错误，换成了 `MODEL_MISSING_ERROR_VIEW.hint`——
  **但打印出来的是英文词典键**：`Migrate or add the AI service under Settings · Pi and this chat can continue; …`。
  成因在 `ChatComposer.tsx:773-774`：这条状态条直接 `return MODEL_MISSING_ERROR_VIEW.hint`，没套 `t()`
  （`i18n.ts:2694` 的中文条目是有的，`MessageTimeline` 那两处都写了 `t(...)`）。
- **中文覆盖层卡片一个字都没出现**：`本应用没有这个模型` / `这个会话记录的模型不在本应用的模型目录里…` /
  `去 Pi 设置补上模型` 三处全为 false。两个渲染点都够不着发送失败这条路：
  `MessageTimeline.tsx:742` 挂在**历史恢复失败**通知里（本次 `historyErrors` 为空），
  `MessageTimeline.tsx:1171` 要求时间线里有一条 `isError` 且文本命中的**消息**（发送失败只写了 `lastError`）。

截图 [T062-01-model-missing-composer.png](…/T062-01-model-missing-composer.png)。

---

## 四、T063 / DEV-3 —— ✅ 成立（这项改动最干净）

四个时点（[T063-t0](…/T063-t0-compat-root.txt) ～ [t3](…/T063-t3-after-restart.txt)）：

| 时点 | 兼容根 `~/.agents/subagents` | 主目录 `<agentDir>/subagents` | 设置页那一行 |
|---|---|---|---|
| t0 | `probe-compat.md` 220 B，描述 ORIGINAL，md5 `15b2c52f…` | **不存在** | 显示 ORIGINAL，`piSubagents.list()` 的 `filePath` 指向兼容根 |
| t1 编辑描述为 EDITED 并保存 | **原地改了**：221 B，md5 `e9d530dd…`，内容 EDITED | **仍然不存在**（旧版本这里会多出一份 207 B 的影子副本） | 显示 EDITED |
| t2 点**一次**删除 | 目录空了 | 仍不存在 | **该行立即消失**（旧版本这里回到 ORIGINAL，要删两次） |
| t3 重启应用 | 空 | 不存在 | 列表只剩 4 个内置子代理，`probe-compat` **没有回来** |

删除确认框文案是「删除 probe-compat？/ 这会删掉定义文件。已经在跑的会话仍用它启动时的那份快照。」
（[T063-01-delete-confirm.png](…/T063-01-delete-confirm.png)）。

---

## 五、T064 / DEV-4 —— ✅ 成立

完整读数在 [T064-result.txt](…/T064-result.txt)。制造方式与批次 B 同（应用起好后把 `workerRpc.ts:50` 的 1 改成 2，
`out/main/index.js` 仍是 1，dev 模式 worker 现读源码）。

新建对话 → 粘一张 195 KB 的图 → 打一句话 → 发送（14:05:22）。满 63 秒后：

1. **输入框里那句话回来了**（`textarea.value` 逐字相同）；
2. **附件也回到附件条**（`six-0.png 195.3 KB`）；
3. 错误照旧可见：`Error: … WorkerSlotError: Worker request worker.bootstrap timed out after 60000ms`；
4. **右下角没有 ↺**：整页按钮的 aria-label / 文本里没有任何 retry/重试，只剩 Attach files 与发送；
5. **`session-index.json` 行数 177 → 177**，没有新增空壳行；批次 B 留下的那行 `session-1789644851492-gidi2oz` 仍在（预期，不自动清理）；
6. 日志只多一条 `[error] chat:createSession … bootstrap timed out`，清理路径静默（与 T064 预期一致）。

截图 [T064-01-draft-restored.png](…/T064-01-draft-restored.png)。

---

## 六、T065 / DEV-14 + DEV-16 —— ⚠️ 部分成立（跨窗口互斥与关窗文案都对，**切回 TUI 仍整屏空白**）

### DEV-16（D18，跨窗口同会话互斥）—— ✅ 成立

第二个窗口仍按批次 D 的办法开（主进程 node inspector 调应用菜单「文件 → 新建窗口」自己的 click handler）。
两个窗口都选中 `session-1789666361268-er5utwj`：

- 窗口一点 TUI，pi 正常起来（`(probe-fake) fake-sonnet` 状态行）。
- 窗口二点 TUI → **弹中文 toast**「Pi 终端无法打开这个对话 / 该会话已在另一个窗口的终端中打开，请先关闭那个终端，或在那个窗口里继续。」
  界面**不切**到终端（`aria-pressed` 停在 GUI:true / TUI:false）。
  （[T065-04-window2-toast.png](…/T065-04-window2-toast.png)）
- **`/proc` 里始终只有一个 pi**（pid 519715，`argvBytes=246` = 带 `--session`）。
  批次 D 那种「同一 parentId 两个子节点」的静默分叉没有再出现。
- 机制侧也核了一遍：窗口二直接打 IPC，`piTui.sessionSupport()` 返回
  `{supported:false, reason:"This chat is already open in a terminal in another window"}`，
  `piTui.open()` 被 Main 拒绝抛错。

  ⚠️ **一条毛边**：窗口二如果因为展示模式被持久化、进来时就已经是 TUI 模式，用户点的是「Start Pi TUI」而不是 TUI 开关，
  这条路直接走 `useXterm` → `piTui.open`，被 Main 拒绝后**界面上什么提示都没有**（我连点两次，终端不出、也不弹 toast）。
  中文 toast 只在 `usePresentationSwitch.openTui`（即点 TUI 开关）这条路上。

### 轻项二（关窗文案）—— ✅ 成立

两个窗口时关第二个：「关闭这个窗口 / 应用会在你其他的窗口里继续运行。/ 关闭窗口」
（[T065-05-close-window-dialog.png](…/T065-05-close-window-dialog.png)）；
只剩最后一个窗口时再关：「确认退出 / 确定要退出应用吗？/ 退出」。

### DEV-14（D17，切回被挂起的 TUI）—— ✗ **未生效**

完整读数在 [T065-D17-result.txt](…/T065-D17-result.txt)。

1. 聊天 A 点 TUI → pi 正常出屏（[T065-A-first-open.txt](…/T065-A-first-open.txt)）；
2. 切到聊天 B → 显示「Start Pi TUI」→ 点开 → pi 正常出屏；
3. **切回聊天 A → 整屏空白**：`.xterm-rows` 有 35 行，`textContent` 去空白后长度 **0**
   （[T065-01-back-to-A.png](…/T065-01-back-to-A.png)）；
4. 手动 `piTui.resize(<A 的 terminalId>, 70, 20)` → **整屏立刻恢复**；
5. 再切到聊天 B → 同样整屏空白（[T065-02-back-to-B.png](…/T065-02-back-to-B.png)）。两个方向都复现。

`window.__dtui` 的事件流证明 resume 确实发生了（A 的终端在 `1789667762656` 收到 `state:"live"`），
但此后**只回流了 10 字节**，不是整屏重绘。也就是说 Main 侧新加的 `#requestRepaint`（`rows+1` 再回退）
在真机上没能让 pi 重画，而一次真实的尺寸变更（70×20）立刻救回——杠杆选对了，抖动这一下没起作用。
（怀疑两次 `resize` 挨得太近被合并成一次净变化为零的调整，单测里断言的是 PTY 收到了三次 resize 调用，
证明不了 TTY 真的发了两次 SIGWINCH。这一条是读数 + 推测，已标明。）

---

## 七、T066 —— ✅ 成立（五类各拿到一行，全部在按天日志里）

日志一律取 `~/.config/jyw-ai-client-dev/logs/aiclient-2026-09-17.log`；
同期 `main.log` 只多了启动时的 `Shared state paths` 一条（1245 字节），**五类事件一条都没进 main.log**，与 T066 的设计一致。
原文见 [T066-logs-run1.txt](…/T066-logs-run1.txt) 与 [T066-logs-run2-run3.txt](…/T066-logs-run2-run3.txt)。各贴一行（已脱敏，路径由产品自己折成 `~`）：

```
[13:17:38.852] [warn]  [chat] Session index was damaged (1 row(s) had no usable sessionId); the original is kept at ~/.config/jyw-ai-client-dev/session-index.json.corrupt-2026-09-17T17-17-38-849Z and the list was rebuilt from 171 readable row(s).
[13:52:37.881] [info]  [legacy-import] Batch started: 2 session(s) from 2 requested.
[13:52:38.944] [info]  [legacy-import] Batch done: 0 imported, 0 already imported, 2 failed.
[13:37:41.490] [info]  [chat] Archiving temp session session-1789665909436-k1sadhy: retiring its worker before releasing its scratch directory.
[13:37:41.490] [info]  [chat] Worker retired for archived session session-1789665909436-k1sadhy.
[13:37:41.491] [info]  [scratch] Released ~/JYWAI/temporary-d4new/unbound-sessions/e5c490bd-… for session session-1789665909436-k1sadhy
[13:53:34.401] [info]  [pi-tui] Spawned terminal pi-tui-65e9d704-… (generation 1): ~/code/ai-client/node_modules/electron/dist/electron …/cli.js --session ~/.pilab/jyw-ai-client-dev/pi-agent/sessions/session-1789666361268-er5utwj.jsonl in ~/code/ai-client
[13:58:54.004] [info]  [pi-tui] Terminal pi-tui-65e9d704-… exited (code=0 signal=0)
[13:19:48.739] [warn]  [pi-worker:session-d4062-missingmodel] turn failed: model_not_in_catalog: no model "vllmproxy-old/claude-does-not-exist" in the catalog (1 available)
[13:32:48.592] [warn]  [pi-worker:session-1789666361268-er5utwj] provider retry 1/3 in 3000ms (status=503 code=PROVIDER_ERROR)
```

- 索引修复那条是先在索引数组里塞一行**没有 `sessionId` 的坏行**触发的（`parseSessionIndexRows` 丢弃它、
  `entries.size > 0` 走 COPY 分支），比批次 A1 的截断法温和，真实行一条没丢。
- 重试那三行是**在重试发生的当下**就出现的，不再只活在 trace 里（E1 那轮三处 grep 全 0）。
- 预算拒绝那一行也在应用**仍在运行时**就能 grep 到：
  `[14:41:32] [warn] [pi-worker:…] turn failed: session exceeds the configured size budget`
  —— E2 那轮要等杀进程后由 stderr 回放才看得见。
  ⚠️ **一处与 T066 表格的措辞对不上**：这一行**没有带码**（只有正文，没有 `session_size_limit:` 前缀），
  而模型缺失那条是带码的（`model_not_in_catalog: …`）。码带不带取决于抛出点，不影响「当场有一行」这个主判据。

---

## 八、T067 —— ✅ 成立（四处 + 一处遗留全部中文）

| 处 | 触发方式 | 看到的原文 | 截图 |
|---|---|---|---|
| 问答卡 | 假网关 `--plan ask-question` | 段头「提问」、chip「点验顺序」、选项 A/B/C + 末行「其他…」、按钮「跳过」「继续」——**整片中文，无英文硬编码** | [T068-01-question-card.png](…/T068-01-question-card.png) |
| 重试横幅 | `--plan retry-503-forever` | 时间线「上游返回错误 503 · 正在重试 2/3 · 本回合仍在进行」+ 折叠钮「详情」；composer「正在重试 · 2/3 · 7 秒后重试 · 3s」 | [T067-03-retry-banner.png](…/T067-03-retry-banner.png) |
| 导入失败 | `make-samples.mjs --huge` 重造样本，GUI 里勾两条一起导 | 64 MiB 那条：「这个对话的体积超过了 **64 MiB** 的导入上限，没能导入。**请改导入较小的对话，或先拆分后再导入。**」<br>35 MiB 那条：「这个对话的记录条数超过了 4000 条的导入上限，没能导入。请改导入较小的对话，或先拆分后再导入。」<br>汇总句：「新导入 0 个，已存在 0 个，失败 2 个。」 | [T067-06-import-failures.png](…/T067-06-import-failures.png) |
| 附件超限 | paste 6 张图 / 7 MiB 图 / 空文件 / .bmp | 「每条消息最多 5 个附件，已跳过「six-5.png」。」<br>「「huge-7mib.png」有 7.0 MB，单个图片最大 5.0 MB。」<br>「「empty.png」是空文件，已跳过。」<br>「「probe.bmp」既不是图片也不是文本文件，已跳过。」 | [T067-04](…/T067-04-attach-count-limit.png) / [T067-05](…/T067-05-attach-hints.png) |
| （原「遗留」项）附件总量提示 | 贴 5 MiB + 1 MiB 两张图 | composer 状态行「**附件合计 6.0 MB，发送可能会慢一些。**」——`largeHint` 的收尾接线生效，不再是英文 | 同 T061-01 |

导入失败那两句的英文原文仍完整落在日志里供排查
（`Claude session exceeds the 67108864-byte import limit`），只是不再糊到用户脸上。
遗留未动的一条：`formatAttachmentSize` 仍输出 `MB/KB`（二进制除数、十进制单位），这是另一条账。

---

## 九、T068 —— ✅ 成立

1. **无 `AICLIENT_NODE24_PATH` 照常启动**：`dev.env` 里这一行已被 T068 删掉（备份 `/tmp/t032/dev.env.bak-T068`，
   diff 确认只少了这一个块）。三轮启动全部正常，dev 日志里 `node24|node runtime|NodeRuntimeResolver` **0 命中**，
   没有任何横幅或错误；run 1 起来后第一句话就发成功了。
2. **问答卡 header chip（D22）**：卡上问题正文**正上方**出现 chip「点验顺序」，
   `span.inline-block rounded-sm bg-muted px-1.5 py-0.5 text-meta text-muted-foreground`，
   `getComputedStyle` 读到 **13px / 400**。
3. **两张卡的字重（D23）**，`getComputedStyle` 实测（[问答卡](…/T068-question-card-computed.json) / [权限卡](…/T068-permission-card-computed.json)）：

| 元素 | 字号 | 字重 | 期望 |
|---|---|---|---|
| 问答卡段头「提问」 | 14px | **600** | 600 ✅ |
| 问答卡问题正文 | 14px | **600** | 600 ✅ |
| 问答卡选项描述（「写文件审批那一张」等） | 13px | **400** | 400 ✅ |
| 问答卡选项标题 / 跳过 / 继续 | 14px | 500 | 按钮基类 500，T068 明说允许 |
| 权限卡段头「权限」 | 14px | **600** | 600 ✅ |
| 权限卡标题「write — 写入工作区文件」 | 14px | **600** | 600 ✅ |
| 权限卡正文 / 「内容」标签 / 底部说明 | 13～14px | 400 | 400 ✅ |

E1 那轮「两张卡的层级全部靠 `font-medium`(500)」的系统性偏差已经消失。
（Win10 那半边的对拍仍要等上机日，本机只能给 Linux 口径。）

---

## 「未生效 / 新回归」清单

| # | 属于哪项 | 看到了什么 | 严重度 |
|---|---|---|---|
| 1 | **T065 / D17（DEV-14）** | **未生效。** TUI 模式下 A→B→A、B→A→B 两个方向都整屏空白（`.xterm-rows` 有 35 行、文本长度 0）；`state:"live"` 之后只回流 10 字节。手动 `piTui.resize(id,70,20)` 立刻救回，证明不是 pi 死了。Main 侧新加的 `rows+1→rows` 抖动没能让 pi 重绘。 | 中——这正是该项要修的那个观感 |
| 2 | **T062 / D19（DEV-32）** | **半生效。** 稳定码 `model_not_in_catalog` 确实到了渲染层、`isModelMissingError` 命中，但①中文覆盖层卡片在**发送失败**这条路上依然出不来（两个渲染点一个挂在历史恢复失败、一个要求时间线里有 error 消息）；②composer 状态条打印的是**英文词典键**，因为 `ChatComposer.tsx:773-774` 返回 `MODEL_MISSING_ERROR_VIEW.hint` 时没套 `t()`。 | 中——用户仍然看不到那张中文卡，且中文界面里多了一句英文 |
| 3 | T065 / D18 的毛边（非回归，新观察） | 第二个窗口若进来时展示模式已是 TUI，用户点的是「Start Pi TUI」，这条路直接打 `piTui.open` 被 Main 拒绝，**界面上零提示**；中文 toast 只在点 TUI 开关那条路上。 | 低 |
| 4 | T066 措辞对不上（非回归） | 预算拒绝那一行落成了 `turn failed: session exceeds the configured size budget`，**没有** `session_size_limit:` 前缀；T066 的日志点表格写的是 `turn failed: <code: message>`。主判据（应用仍在运行时就能 grep 到）成立。 | 低 |
| 5 | 沿用未修（T065 自己列过） | `usePresentationSwitch.ts` 另外三条 toast（`Wait for this turn to finish` / `Could not start the Pi TUI` / `Could not reload this chat`）仍是硬编码英文；`ChatComposer.tsx` 的 `Error: ${lastError}` 兜底也仍是英文。本轮未触发到前三条，第四条在 T061 第 5 条被拒时照旧出现。 | 低 |

**没有发现任何一项修补引入的新崩溃、新失败或对旧行为的破坏。** 九项里没有一项让原先能用的东西变得不能用。

---

## 环境交代（逐条还原证据）

见 [env-teardown.txt](…/env-teardown.txt)。摘要：

- **一句真模型都没发**，`maxapi` / `cx2` / `vllmproxy` 一次都没碰；全程本地假网关 `127.0.0.1:18080`，
  按需切 `text` / `ask-question` / `write-approval` / `retry-503-forever` 四个计划。
- 三次起停，每次起之前都 `free -m`（available 1934 / 1815 / — MB），每次退出后都确认进程全无、端口释放、无残留 `pi`。
- 强杀只用真实 pid，从 `ps -eo pid,args` 精确取；查残留遍历 `/proc/*/cmdline`。
  **全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。**
- 还原逐条核对过：vault **1042 字节**、sha256 一致；`models.json` / `auth.json` sha256 一致；
  `session-index.json` 从备份**逐字节还原**（170 行，sha256 `84d9a093…`）；
  `workerRpc.ts` sha256 `ea9ebf9e…` 一致、第 50 行回到 `= 1 as const`；
  `settings.json` 的 `chatAgentDefaults` 已删、`defaultTemporaryPath` 回到 `""`；
  `~/.agents/subagents/` 与 `~/JYWAI/temporary-d4new/` 已整个删除；造的两份探针会话 JSONL 已删。
- **`dev.env` 没动**（T068 删掉 `AICLIENT_NODE24_PATH` 是被测改动本身）。**产品代码一行未改。**
- 有意留下的：产品自己生成的 `session-index.json.corrupt-2026-09-17T17-17-38-849Z`（T066 的现场证据，与批次 A1 同处理）。
- `git status` 相对开始只多出 `dev-D4-reverify/` 一个未跟踪目录（100 条 → 101 条）。
