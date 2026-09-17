# 批次 D4 第二轮真机复验 —— 五项回炉（T061 / T062 / T064 / T065 / T066）在用户可见层面的结论

证据目录：`docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/dev-D4-reverify-2/`

环境：同一台 Linux 开发机（2 核 / 3.3 GB），HEAD `b3d751e3`，分支 `feat/runtime-evolution`，
**工作区带批次 D4 未提交修补（含 R-A / R-B / R-C 三轮回炉）**，dev 模式跑的就是工作区代码。
全程本地假网关、两次起停、逐条还原，细节见 [env-teardown.txt](…/dev-D4-reverify-2/env-teardown.txt)。

**一句话总账：六项判据里 5 项完全成立、1 项（D17）基本成立但留了一次约 4% 的偶发空白。**

---

## 一、T065 / D17 —— TUI 模式 A↔B 切换（最硬判据）⚠️ 基本成立（27 次里 1 次仍空白）

完整读数在 [T065-D17-result.txt](…/dev-D4-reverify-2/T065-D17-result.txt)。

两个会话是同一份真会话的拷贝，画面本来一模一样，所以先在各自 pi 的输入行里留了一个**未发送**的
标记（`AAAMARKER` / `BBBMARKER`），这样「现在屏幕上是谁」才有判据。
每一腿都是：清空 `piTui.onData` 抓取 → 切会话 → 等 6 秒 → 读回流字节数 / xterm 非空行数 / 标记。

| 批次 | 腿数 | 结果 |
|---|---|---|
| 第一批 | 6 | 5 腿回流 15,372～15,383 字节、非空行 22、标记正确；**1 腿只回 11 字节、非空行 0** |
| 第二批（每腿单独清 states） | 10 | 全部 ≈15,372 字节、非空行 22、标记正确 |
| 第三批（先空转 70 秒再跑） | 6 | 全部正常 —— 「久置之后第一次切更容易空白」这个怀疑不成立 |

- **上一轮那个稳定故障不复现了**：上一轮是两个方向都整屏空白、`state:"live"` 之后只回 10 字节；
  这一轮 27 次真实切换里 26 次是整屏重绘（数 KB，6～8 个分片），符合判据。
- **剩下那一次**回的 11 个字节是 `ESC[10G ESC[?25l` 加一个换行 —— 只有光标定位，没有重绘，
  和上一轮是同一种形态。这正是 T065 回炉自己写明的那条概率边界
  （pi 在整个 IPC 往返期间一次都没被调度，就只看得到最终尺寸而错过中间态）。
- 我试着找更细的触发条件但**没找到**：失败那次两个 `live` 事件间隔 4 ms，可成功的腿里也有 2 ms 的，
  所以这个间隔不是判别量。这一条是读数 + 未解释的残留，如实记下。

## 二、T065 / D18 —— 跨窗口互斥、拒绝提示、关窗文案 ✅ 成立

完整读数在 [T065-D18-result.txt](…/dev-D4-reverify-2/T065-D18-result.txt)。

1. **窗口二进来时已是 TUI 模式，点「Start Pi TUI」**——上一轮这条路是零提示，现在弹中文 toast：
   「Pi 终端无法打开这个对话 / 该会话已在另一个窗口的终端中打开，请先关闭那个终端，或在那个窗口里继续。」
   xterm 不挂载，按钮还在。（[T065-D18-win2-startbtn-toast.png]）
2. **切回 GUI 再点 TUI 开关**（老路）：同一句中文 toast，`aria-pressed` 停在 GUI:true / TUI:false，不切过去。
3. **只有一个 pi**：全程 `/proc` 计数 `pi-count=2`（会话 A、B 各一个，都在窗口一），
   按天日志里 `[pi-tui] Spawned terminal` 始终是 2 行，没有第三个。
   （注意：pi 启动后会把自己的进程标题改写成 `pi`，`ps | grep -- --session` 数不到，要按「父进程 = Electron 主进程」认。）
4. **R-B blocking（terminal-03 过度释放）反向验证也过了**：先让窗口一「正在跑会话 A」的那个 terminalId
   去 open 会话 B 被拒（`This terminal is already running another chat…`），紧接着窗口二对**会话 A**
   仍然被拒（`supported:false / already open in a terminal in another window`）——
   失败的那次 open 只撤了它自己要的那把认领，没把会话 A 的认领连带清掉。
5. **关窗文案三种都对**：
   - 两个主窗口关其一：「关闭这个窗口 / 应用会在你其他的窗口里继续运行。/ 关闭窗口」
   - 用 runtime 自己的 `browser_preview` 工具**真开一个预览窗**之后再关第二个主窗口：文案不变（预览窗没被算成「其他窗口」）
   - 反过来只剩「主窗口 + 预览窗」时关主窗口：「确认退出 / 确定要退出应用吗？/ 退出」——这正是 R-B 毛边二要修的那条。

## 三、T062 / D19 —— 模型缺失的中文覆盖层 ✅ 成立

完整读数在 [T062-D19-result.txt](…/dev-D4-reverify-2/T062-D19-result.txt)。

**先记一个坑**：只把会话文件的 model 改成目录里没有的组合**不够**。目录里只剩一个可用模型时，
composer 会自动改用它并往会话里补写一条 `model_change`，这一轮就正常出话了。
上一轮之所以能触发，是因为 localStorage 的每会话模型钉子 `aiclient:chat:session-models`
里已经有一条指向那个不存在的模型。本轮按同一形态补上钉子后才复现
（这也正是真实用户的处境：曾经配过这个模型，后来它从目录里消失了）。

复现之后：composer 上方出现 `ModelMissingNotice`（`[data-slot=alert]`），四段全中文——
标题「本应用没有这个模型」、正文「这个会话记录的模型不在本应用的模型目录里…」、
提示「到「设置 · Pi」把 AI 服务迁移或补上…」、按钮「去 Pi 设置补上模型」，
卡内保留 runtime 原始诊断 `model_not_in_catalog: no model "vllmproxy-old/claude-does-not-exist" in the catalog (1 available)`。

- **状态条没有英文词典键**：整页扫四条英文原句全为 0；session 模式带错误时那一行走 `largeHint`（本次为空），所以是空的。
- **不与其它覆盖层同现**：标题 / 提示 / 诊断各 1 次，`[data-slot=alert]` 只有这一张，老的红色等宽 `Error:` 框 0 次。
- **按钮可用**：点了之后打开「设置 · Pi」。
- **反向不削弱**（在 T064 那一节顺带验的）：bootstrap 超时这条路上，composer 上方仍是原来的红色等宽诊断框，没被这张卡吃掉。

## 四、T064 —— createSession 失败时载荷的去处 ✅ 成立（正反两条都看了）

完整读数在 [T064-result.txt](…/dev-D4-reverify-2/T064-result.txt)。
制造方式：应用起好后把 `workerRpc.ts:50` 的 1 改成 2（`out/main/index.js` 仍是 1，electron-vite 没有因此重建 main）。

- **主判据**：新建对话 → 贴一张 195.3 KB 的图 → 打一句话 → 发送 → **发送后 15 秒（仍在 60 秒窗口内）再打一个字 "X"** →
  超时之后：输入框里仍是用户自己打的 "X"（没被覆盖）、出现重发按钮
  `aria-label="Retry last message (1 file)"`（附件计数在里面）、错误照旧可见。
- **载荷完整性是端到端确认的**：把常量改回 1 之后点那颗 ↺，会话真的建起来并发出去了，
  假网关落盘的请求体里 user 消息 = `[text "T064 复验：等待期间我会再打一个字", image]`，原文与那张图一起重发。
- **反向那一半**：同样制造失败但**全程不碰输入框** → 原文回到输入框、附件条回来、**没有** ↺。
- 索引行：对照那一条（自始至终没成功）**没有留下任何索引行**，没有空壳行。
- ⚠️ 毛边（非判据）：重发按钮的 `aria-label`/`title` 是英文 `Retry last message (1 file)`，中文界面里没翻译。

## 五、T061 —— 出网剥掉本应用自己的键 ✅ 成立（而且是在「adapter 不会替你丢键」那条路上成立的）

完整读数在 [T061-result.txt](…/dev-D4-reverify-2/T061-result.txt)。

**先记一个对上机同样适用的坑**：把假网关注册成 vault 里的自定义 AI 服务时，图**根本出不了网**——
请求体里只有一句 `(image omitted: model does not support images)`。
原因在 `PiModelConfigService.ts:773 toPiUserProvider()`：vault 里的自定义服务只带模型 id，
没有 `input` 能力声明。改走物理文件目录那条路（清空 vault 的 `userProviders`，让 worker 退回读
agentDir 下的 `models.json`/`auth.json`，并在里面声明 `"input":["text","image"]`）之后图才真的出网。

- **落盘有**：会话 JSONL 里那条 image block 的键集合 = `['aiclientName','data','mimeType','type']`。
- **出网无（控制组）**：退出并重开该会话后发一条纯文本，`anthropic-messages` 请求体里历史 image block
  键集合 = `['source','type']`，整包 grep `aiclient` / 文件名都是 0。这条只是控制组——该 adapter 本来就会重建 block。
- **出网无（判据）**：把 api 改成 **`pi-messages`**（就是 T061 回炉点名的那个「原样 `JSON.stringify` 发出」的 adapter），
  重启让 worker 重读目录后再发：请求体顶层键 = `['context','model','options']`（确认是原样透传形状），
  `context.messages` 里历史 image block 键集合 = `['data','mimeType','type']`，
  **没有 `aiclientName`**；整个 295 KB 请求体里 `aiclient` 出现 0 次、文件名出现 0 次。
  （假网关回的是 Anthropic 风格 SSE，pi-messages 客户端解析不了，所以这一轮回合本身是失败的；
   不影响判据——请求体是在任何响应处理之前落盘的。）

## 六、T066 —— 按天日志三处 ✅ 成立

完整读数在 [T066-result.txt](…/dev-D4-reverify-2/T066-result.txt)。

1. **预算拒绝行带码**（上一轮只有正文）：把一份真会话用 `custom` 条目填到距 32 MiB 只剩 300 字节，
   重启后再发一句话 →
   `[warn] [pi-worker:session-r2-budget] turn failed: session_size_limit: session exceeds the configured size budget`。
   码在正文前面并排，正文一字未改。
   另一种码用 IPC 直接发一个 6 MiB 附件绕过 composer 限额 →
   `turn failed: attachment_size_limit: attachment "oversize.png" is 6291456 bytes; the limit is 5242880 bytes per attachment`，
   而且**没有重复印码**（这条的码来自抛出路径），防重复的守卫有效。
   ⚠️ 与上一轮的一处读数差异：本形态下拒绝发生在「把消息落盘」那一步，**模型先被调用了一次**
   （假网关计数涨了 1）。上一轮记的「模型侧没被调用」在这里不成立，记下备查。
2. **保险库解析错误不回显内容**：把 vault.json 换成 `{sk-ant-plaintext-9f3aSECRET, "version": 2}`（44 字节），
   走 dev-only 的 `auth:devMarkInvalidated` →
   `[CredentialVault] markInvalidated: existing vault is not valid JSON (SyntaxError, 44 bytes read)`。
   只有错误类型与字节数；整段日志 grep `sk-ant` / `SECRET` / `plaintext` = **0 次**。
3. **scratch 删除失败行脱敏**：把 `~/JYWAI/temporary` 设成只读，启动时的 sweep 触发 →
   `[scratch] Failed to remove ~/JYWAI/temporary/unbound-sessions: Error: EACCES: permission denied, rmdir '~/JYWAI/temporary/unbound-sessions'`。
   一条 warn、**一个参数**，路径与 fs 错误里那份路径都折成 `~`，整行 grep `/home/ai` = **0 次**，失败原因仍读得出来。

---

## 「未生效 / 新观察」清单

| # | 属于哪项 | 看到了什么 | 严重度 |
|---|---|---|---|
| 1 | **T065 / D17** | **偶发未生效。** 27 次真实切换里 1 次仍整屏空白（`state:"live"` 后只回 11 字节，只有光标定位）。上一轮的稳定故障已消失，这是 T065 回炉自己预告的概率边界；本轮没能定位更细的触发条件（`live` 事件间隔不是判别量）。 | 中低——观感偶尔仍会坏一次 |
| 2 | T064 毛边（新观察，非回归） | 重发按钮的 `aria-label`/`title` 是英文 `Retry last message (1 file)`，中文界面里没翻译。 | 低 |
| 3 | T066 读数差异（非回归） | 会话预算拒绝这条路上，**模型先被调用了一次**才在落盘那步被拒；上一轮记的「模型侧没被调用」在本形态下不成立。主判据（带码的那一行）成立。 | 低 |
| 4 | 环境事实（非缺陷，但会误导后来人） | ① vault 里的自定义 AI 服务**不带图片能力声明**，用它验附件出网永远看不到 image block；要走物理 `models.json` 那条路。② 只改会话文件的 model 不足以制造「模型缺失」，还要 localStorage 的每会话模型钉子。③ dev.js 收到 SIGTERM 的退出路径**没有**跑到 scratch 的 `wipeAll`。 | — |
| 5 | 沿用未修（上一轮已列） | `usePresentationSwitch.ts` 另外三条 toast 与 `AgentTerminal.tsx` 的模型缺失覆盖层四个字段仍是硬编码英文（本轮未触发到，未复验）。 | 低 |

**没有发现任何一项回炉引入的新崩溃、新失败或对旧行为的破坏。**
上一轮判定「未生效」的 D17 和「半生效」的 D19，这一轮分别变成「基本成立（偶发 1/27）」和「完全成立」。

---

## 环境交代（逐条还原证据）

见 [env-teardown.txt](…/dev-D4-reverify-2/env-teardown.txt)。摘要：

- **一句真模型都没发**；为此把 `pi-agent/models.json` / `auth.json` 临时改成**只有** probe-fake 一个 provider
  （指向本地假网关 `127.0.0.1:18080`），私有 provider 在整轮里连配置里都不存在。
- 两次起停，起前 available 分别是 1984 / 1953 MB；两次退出后进程全无、9333 / 5173 / 9444 端口全部释放、无残留 pi。
- 强杀只用真实 pid；查残留遍历 `/proc`。**全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。**
- 还原逐条核对过（sha256 全部校回本轮开始时的值）：
  `vault.json` **1042 字节** `7200ffeb…`、`settings.json` `af758e00…`、
  `models.json` `35257b8d…`、`auth.json` `8d106c13…`、
  `session-index.json` `84d9a093…`（170 行）、`workerRpc.ts` `ea9ebf9e…`（第 50 行回到 `= 1 as const`）。
- 本轮产生的 9 份会话 JSONL、对应 `.writer.lock`、本轮写的那份 vault 备份、只读陷阱目录、
  以及我加进 localStorage 的那条模型钉子，都已删除或写回原值。
- **产品代码一行未改**（`workerRpc.ts` 的常量是 T064 的制造手段，已还原）。**dev.env 没动。没跑 vitest、没跑 build。**
- `git status` 相对开始只多出 `dev-D4-reverify-2/` 一个未跟踪目录（121 条 → 122 条）。
