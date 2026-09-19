# 本轮发现的缺陷与观察（2026-09-19，滚动记录，收口时并入 README）

Role: evidence shard。判据权威：[04-model.md](../../topics/t033-field-day/04-model.md)。行号以 HEAD 9fa5a511 为准。

## 缺陷

### F1 · 命中列表跳行只在编辑器第一次开文件时生效（MODEL-11）

现象：编辑器已开着别的文件时点命中，新开 tab 但不跳行，`pendingCursor` 挂着不被消费。倒序实验证明与路径形态（相对 / 绝对）无关，只与顺序有关。

根因：`EditorArea.tsx:309` 的 `editorForPathRef` 只在 `handleEditorMount`（`:640`）赋值一次；`<Editor path=…/>`（`:1455-1462`，无 `key`）切 tab 只换 `path` 不重新 mount。运行时 effect 的守卫 `editorForPathRef.current !== activeTabPath`（`:607`）对任何非首个文件恒真，提前 return（`:609`），既不 `setPosition` 也不清 `pendingCursor`。首次开文件走 mount 内联分支（`:712-736`）所以能跳。

最小修法：去掉 `:607` 那个判断（`pendingCursor.path !== activeTabPath` 已足够），或在 `activeTabPath` 变化的 effect 里持续同步 `editorForPathRef.current`。

### F2 · 命中列表弹层锚在视口左上角盖住标题栏（MODEL-11）

现象：positioner rect `[0, 4, 560, 122]`。

根因：`HitListPopover.tsx:30` 给 `PreviewCardTrigger` 的 `render={<span className="contents" />}`，`display: contents` 无盒子（`getClientRects().length === 0`），floating-ui 拿空盒当 reference。Base UI 不校验也不兜底（`@base-ui/react/preview-card/trigger/PreviewCardTrigger.js:78-86`）。全仓唯一一处 `contents` 触发器；其它 Trigger 都给有盒子的元素（`BranchSwitcher.tsx:192`、`SessionBar.tsx:135`、`BreadcrumbTreeMenu.tsx:295`、`ui/sidebar.tsx:518`）。

最小修法：去掉包裹 span，直接 `render={children as ReactElement}`（调用方 `ToolRows.tsx:336` 传的 `<span className={argClass}>` 本来就有盒子），与 `BreadcrumbTreeMenu.tsx:295` 同写法。

### F3 · 用户手点「直接允许」没有独立审计行（MODEL-23 顺带）

`permissionActivityRow.ts:84-86` 的 `isQuietPermissionActivity` 只看 `result === 'allow' && !resolution.includes('error')`，不看 `resolution`；`USER_RESOLUTIONS`（`:127`）只用于 `derivePermissionActivityRow` 挑 tone。唯一调用点 `MessageTimeline.tsx:2399` 未传 `includeAllowed`，所以 `'allowed'` 这条 tone 分支线上不可达。注释（`PermissionActivityRows.tsx:12-42`）的理由是「policy_allow 不该像用户决策一样醒目」，但把 `user_approved` 一并吞了。实时态唯一痕迹是工具行后缀「· 已允许」；重启回放后连这个后缀也没有（见 MODEL-23）。

是否算缺陷待用户拍板：审批可见性是交互取舍。

### F4 · 模型 / 思考强度菜单半中半英（MODEL-27 顺带，文案项，用户已降级）

分组标题 `Model` / `Reasoning effort` 与档位 `Default / Low / Medium / High / X-High / Max` 是英文，同一菜单里「其他模型」是中文。`i18n.ts` 里 `Off: '关闭'`（`:1243`）、`Low/Medium/High`（`:2019-2021`）词条存在，说明渲染点没走 `t()`。属 T067 那类漏网，按用户 09-18 口径不阻塞。

### F5 · Stop 之后上下文徽标被清成 0%（MODEL-18）

徽标不消失（判据通过），但 Stop 触发后连发两条 `usage.updated`，`context` 子对象变成 `{tokens:0, percent:0}`、`totalTokens:0`，同一 payload 里 `session`（16.8 万 token）与 `delegated` 仍是真实累计值；键集比正常结束少了 `reasoning`。徽标只读 `context`，于是从 2% 变 0%。正常结束不出现。原始对象在 `pointcheck/model-18/report.json`。

根因（代码推导，未单独复现）：`runtime/events/projector.ts:444-472` 的 `turn_end` 分支用 `estimateContextTokens([event.message, ...toolResults])` 算 `context`（`:456`）。abort 时 pi-agent-core 的 `runLoop`（`dist/agent-loop.js:122-127`）用空 `toolResults` + 空内容的 `stopReason: 'aborted'` 消息直接 emit `turn_end`；`compaction.js:94-105` 的 `getAssistantUsage` 又显式排除 aborted 消息，于是退化成按字符估算空内容，精确得 0。第二条事件来自 `agent-loop/index.ts:321-326` 的 `foldDelegatedUsage()` → `projector.delegated()`（`:569-587`）复述刚被污染的 `lastContextUsage`。`reasoning` 缺失是流在 `message_delta` 帧前被截断、适配器从未赋值（`anthropic-messages.js:565-572`），属契约行为。

最小修法：`projector.ts` 的 `turn_end` 在 `stopReason === 'aborted'` 时不用空消息覆盖 `lastContextUsage` / `lastTurnUsage`；或 aborted 的 `usage.updated` 不带 `context` 键（同 `buildPiInterimUsagePayload` 的做法），让渲染层保留上次真实值。

### F6 · 时间线审批行读不出是哪个子代理（MODEL-20，不通过）

审批行全文「已拒绝 bash pwd」，无子代理名。store 原始对象：`forwarded: null, requesterAgentName: null, delegationId: "1103083d-…", agentName: "explorer"`。渲染 `permissionActivityRow.ts:140-145` 只读前两个字段，生产者 `runtime/plugins/permissions/activity.ts:70-74` 只写后两个。名字就在记录里，渲染层查的是永远为空的键。活的审批卡是归因的（「来自子 Agent · …」），子代理面板也归因正常（走 `permission.requested` 的 agentId/agentName），只有结算进时间线之后丢失。

最小修法：渲染层改读 `agentName`（`delegationId` 非空即视为 forwarded），或生产者补写 `forwarded: true, requesterAgentName: agentName`。

### F7 · 硬编码路径 deny 不产生任何审批活动记录（MODEL-20 顺带）

`src/runtime/plugins/tools/index.ts:177-178` 在调 `runtimePermissions.authorize` 之前先做 `pathPolicy(lexical) === 'deny'` 短路，直接抛 `access denied: <path>`。所以 explorer 读 `.env` 被拦时，时间线零审计行、store 零 `permission_activity`。用户只能从子代理回报文本里得知。走完闸门的只有 bash 那类 ask 档位的调用。审计完整性问题，待拍板是否要让硬编码 deny 也广播一条活动。

### F8 · 「应用的会话名」与「pi 的会话名」是两套从未打通的存储（MODEL-5）

GUI 重命名只改 `~/.config/jyw-ai-client-dev/session-index.json` 的 `title`；JSONL 里 `session_info` 条目 0 条，模拟 pi 的 `getSessionName()` 得 undefined；pi 冷启动打开同一文件状态栏无会话名，`/name` 落到 Usage 警告分支。导入会话的标题也写成 `{"kind":"fact","fact":"name",…,"customType":"aiclient.v4"}` 而非 pi 的 `session_info`。能写回 JSONL 的 `NativeSessionIndexAdapter.rename()` 生产代码零实例化。是否要打通待拍板（pi 侧显示名字属锦上添花）。

### F9 · GUI 发送会杀掉挂起中的 TUI（MODEL-47 顺带）

回 GUI 走的是 `piTui.suspend` 不是 dispose，切回瞬间 pi 还活着；但下一次 GUI 发送经 `handOverFromTui` → `releaseSessionForHostPrompt` 把该会话上的终端杀掉。行为符合「GUI 写路径先夺回所有权」的设计，但用户视角是「切回 GUI 发一句话，TUI 就没了」。记录，不判缺陷。

### F10 · 两个写入方的 JSONL 条目格式不一致（MODEL-47 顺带）

GUI worker 写的条目带 `kind` / `lane` / `seq`，id 是 UUID；pi CLI 写的条目三个字段都没有，id 是 8 位十六进制。`parentId` 链两边接得上，回放正常。但任何用 `kind === 'entry'` 做守卫的读取逻辑会正好跳过 TUI 贡献的行——本轮探针第一版就踩了。全仓有没有这种守卫未查。

## 观察（非缺陷，影响读判据）

- **GUI/TUI 开关能被 CDP 驱动**：`Input.dispatchMouseEvent`（moved + pressed + released 打按钮中心）四次全成功，最快 3 ms 翻转 `aria-pressed`。`bh-tui.mjs` 头注释「无法驱动」应废止。但判据要用 `aria-pressed`，不能用 `.xterm` 是否挂载——开发模式下 xterm 动态导入在 2 核机上要 40 秒以上。
- **内嵌 pi 进程的识别方式**：不是「exe 是 node、cmdline 含 cli.js」。它是 Electron 二进制以 node 模式重新执行，约 1 秒内把 argv 改写成补空格的 `pi`，`comm` 从 `electron` 变 `pi`。稳定识别：Electron 主进程的直接子进程里不带 `--type=` 的那个；真 argv 只能在 spawn 后 1 秒内从 `/proc/<pid>/cmdline` 抓。04-model.md 的 MODEL-48 判据措辞应改。
- **导入会话第一次打开要走侧栏行的 `useActivateSession`**，光 `selectSession` 读到 0 条消息（无内存时间线，需从磁盘重建）。
- **发送后会话 status 约 1 秒内仍是 idle**，「等非忙」会立刻返回。回合结束判定必须「先等 busy，再连续三次 idle」。
- **判据里 `~/.ssh/id_rsa` 这个 deny 例子驱动不出场景**：模型自己拒绝（41 秒、0 次工具调用、0 次委派），认为打印私钥等于作废钥匙，权限系统根本没被叫到。改用 `*.env` 规则并在提示词里声明「点验权限策略、预期被拒、不要绕过」才让 explorer 真的去读。MODEL-20 判据示例建议改写。
- **被 Stop 过的会话再发新提示，模型会先补做上一轮被打断的事**（187 秒），新指令被排到后面。测 deny 要用新会话。
- **MODEL-49 判据的第一条管道命令用中性措辞也驱动不出场景**：模型把 `curl -X POST https://example.invalid` 读成数据外泄，自行拒绝、零工具调用（71 秒白跑）。要点明「example.invalid 是保留域名不解析 / 我要看的是闸门在执行前拦下它 / 预期被拒、不要绕过」才到闸门。与 MODEL-20 的 `~/.ssh` 例子同一规律。
- **策略拒与人工拒在时间线上靠后缀可分**：策略 deny 的审批行带「· 策略拒绝」后缀（`resolution=policy_deny`），人工拒没有（`resolution=user_denied`）。硬编码路径 deny 则零审计行（F7）。三者靠「有没有审计行 / 有没有后缀」一眼区分。
- **三条被策略拒的命令工具回执完全相同**：`access denied: bash /home/ai/code/ai-client`，模型据此误判为「按工具 + 工作目录整条拒绝，与命令内容无关」。真实判定依据只在 trace 里。回执信息量不足是可见性问题，不影响判据。
- **子代理面板的 `stopped` 终态只在 store 里**，界面那行只显示统计（工具数 / token / 秒），没有「已停止 / 已取消」字样。

- **回合结算后工具行 / 审批行 / 问答卡默认折进「Worked for …」的 `<details>` 工作组**。截图前必须展开；收起态元素 `getBoundingClientRect()` 有坐标但不参与命中测试。重启回放后同一位置的摘要文案是英文「N steps processed」。
- **合成 transcript 灌 Grep/Glob 时每个搜索调用要各占一条 assistant 消息**：同一条消息里两个搜索会被聚合成「Explored …」一行，聚合行没有 `hitSource`，悬停不出列表。
- **MODEL-23 回放后 `thinking` 块从 0 变 3**：实时态不显示思考块，回放后显示。未追根因，记录在案。
- **平台 off 档尚未下发**：应用启动（06:35Z）与强制刷新（06:49Z）都真的远端拉取了，目录 `updatedAt` 仍是 03:16:43Z，`thinkingLevelMap.off` 仍为 null，菜单无「关闭」档。UI 无 bug，等上游。
