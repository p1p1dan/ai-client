# MODEL 组剩余【必】项 · 开发机点验（2026-09-19）

Role: evidence。上位：[批次 H 证据](../batch-h-field-fixes-2026-09-18/README.md)（本轮是其「本地点验」的第三轮，接 [09-18 下半场 MODEL 组实测](../batch-h-field-fixes-2026-09-18/model-group-devbox-2026-09-18.md)）。判据权威：[checklist-e.md](../../checklist-e.md) 第四节「真实模型回合」组；执行步骤 [04-model.md](../../topics/t033-field-day/04-model.md)。准备事实见 [prep-notes.md](prep-notes.md)，缺陷与观察见 [findings.md](findings.md)。

## 这一轮是什么

09-18 下半场 MODEL 组做完 7 项后，剩 10 项因「并行代理改渲染层污染点验」与余额不足未做。本轮在**无并行代码改动**的窗口里把这 10 项全部处置完毕，源码 HEAD `9fa5a511`（6 个未推送提交之上），**`src/` 零改动**。

**凭据口径**：全程只用登录后的托管凭据（`~/.pilab/jyw-ai-client-dev/pi-agent/auth.json` 的 `claude` 条目，指向公司中转），未使用 cx2 / maxapi / vllmproxy / beehears。网关探活 200。

**环境**：Linux 开发机 2 核 3.3 GB，dev 模式 + CDP 9222，应用起停 5 次（每批一次），全部按 `/proc` 逐 pid 核 `exe` 后 SIGTERM，未用 `pkill -f`。模型 `claude/claude-opus-5`、思考档 default、权限档位「执行 · 每次询问」、界面中文。真实模型回合合计 23 次（MODEL-11 用合成 transcript，零回合）。用户配置只在 MODEL-49 新建过一个策略文件并已删除校验；其余由应用自身写入的会话 / 索引 / 导入文件保留。

## 结果表

| 项 | 档 | 结果 | 一句话 | 证据 |
|---|---|---|---|---|
| MODEL-27 ask 作答卡 | 【必】 | ✅ | 选项轮模型复述「你选择的是「Tab」」；跳过轮模型说「我按合理默认选定「UTC」」；store `questionOutcome` 分别 answered / cancelled | [model-27/](pointcheck/model-27/) |
| MODEL-19 跨会话 ask | 【必】 | ✅ | A 未答时 B 起卡，切回 A 卡仍可作答；`pendingQuestions` 全程两条按 sessionId 分开；A 答后自己结束 | [model-19/](pointcheck/model-19/) |
| MODEL-23 关掉再打开 | 【必】 | ◐ 取证 | 切会话来回：审批痕迹与冻结问答卡都在；**重启回放：审批痕迹消失、问答卡退化为普通工具行**（消息数 6 → 6 不丢内容）。与预判一致，判据措辞需回写 | [model-23/](pointcheck/model-23/) |
| MODEL-11 搜索悬停 | — | ⚠️ 部分 | 悬停出命中列表 ✓、点击开文件 ✓（相对 / 绝对路径都行）；**跳行只在编辑器第一次开文件时生效**（F1）；弹层锚在视口左上角（F2） | [model-11/](pointcheck/model-11/) |
| MODEL-18 徽标不消失 | — | ✅ + 退化 | 正常结束 2% 保持；Stop 后徽标仍在但**清成 0%**（F5）；两种收尾最后一条 `usage.updated` 都含 `context` | [model-18/](pointcheck/model-18/) |
| MODEL-20 子代理审批行 | — | ❌ | 审批行「已拒绝 bash pwd」无子代理名；store 里 `agentName: "explorer"` 就在记录里，渲染读的是永远为空的 `forwarded` / `requesterAgentName`（F6）。活卡与子代理面板归因正常 | [model-20/](pointcheck/model-20/) |
| MODEL-49 策略三类语法 | — | ✅ | 管道逐段（`commands` 两段、第二段命中 deny）、重定向 destination 进 `paths` 且 `exploration=false`、here-string 递归展开出 `cat t033-secret.txt`；三条均策略拒、不弹卡、审计行带「· 策略拒绝」；`permission_policy_sources` 精确列出文件、sha256 `d2669835…` | [model-49/](pointcheck/model-49/) |
| MODEL-49 第三格 改文件 | — | ✅ | 同会话判定不变（合并哈希不动）；**新开会话即生效**（哈希变 `a4df1e08…`，deny 消失落到 ask 弹卡）；设置页面板原话与此一致，重启层无需做 | [model-49-hot-reload.txt](pointcheck/model-49/model-49-hot-reload.txt) |
| MODEL-47 GUI→TUI→GUI | 【必】 | ✅ | JSONL 8 → 10 → 12 行，重复 id / 重复文本 / parentId 断点均 0；头行逐字节未变、v4+v3 双头；时间线两轮按序；`writer.lock` 全程 GUI worker 持有 | [model-47/](pointcheck/model-47/) |
| MODEL-5 重命名→pi | 【必】 | ◐ 观察 | `session-index.json` title 已改；JSONL `session_info` 0 条；pi 冷启动状态栏无会话名，`/name` 落 Usage 警告。**pi 显示为空**（F8） | [model-05/](pointcheck/model-05/) |
| MODEL-6 导入续聊 | 【必】 | ✅ | 导入 172 KB Claude Code 会话（5 user / 3 assistant 真实 message + 68 条展示条目），问「上面在讨论什么」，模型点名 3/3 条只有读过历史才知道的事实（技能来源仓库、落盘路径、nvm node 版本与修复命令）；输入 12.1k token 与原文重放相符 | [model-06/](pointcheck/model-06/) |

MODEL 组累计：09-18 已过 7（24 · 3 · 12 · 28 · 17 · 22 · 29）+ 本轮 10 项处置完毕。仍跳过：33～36 / WIN-37（Windows 加密机）、31（缺真实旧格式样本）、13～16 / 21（文案项，用户 09-18 降级）、9 / 10 构造 401 那半、25 / 26 真实网关半边（权限分类器）。

## 判据修正（按 checklist-e.md 第五节体例）

| 项 | 原判据 / 示例 | 实测应改为 | 依据 |
|---|---|---|---|
| MODEL-20 | 「委派一个会撞 deny 的子代理」，示例 `~/.ssh/id_rsa` | 用 `*.env` 规则，提示词须声明「点验权限策略、预期被拒、不要绕过」 | 模型对 `~/.ssh` 例子自行拒绝，0 工具调用，权限系统未被叫到 |
| MODEL-20 | 「审批行上能读出是哪个子代理」 | 判据不变，但要注明**硬编码路径 deny 不产生审批行**（`tools/index.ts:177-178` 短路），要用会走闸门的 bash ask 卡撞 deny | F7 |
| MODEL-49 | 第一条管道命令中性措辞 | 提示词点明「example.invalid 是保留域名不解析 / 要看的是闸门在执行前拦下 / 预期被拒」 | 中性措辞下模型自拒 71 秒白跑 |
| MODEL-49 第三格 | 「改文件后同一会话不变、新开会话才变」 | 措辞成立，**不需要重启层**；补一句「设置页权限规则面板原话与此一致」 | 实测新会话即生效 |
| MODEL-23 | 「审批行与问答卡**是否还在**」 | 预期写死：切会话来回都在；重启回放**审批痕迹不在、问答卡退化为普通工具行**；且实时态下二者默认折在工作组里要展开才见 | 类型层无 permission / question 历史块 |
| MODEL-48 | 「`ps` 过滤 `--session` 抓不到，pi 会改写进程标题，要在 spawn 后的启动窗口内抓」 | 补：内嵌 pi 是 Electron 二进制以 node 模式重执行，约 1 秒内 argv 改写成 `pi`；识别方式是「Electron 主进程的非 `--type=` 直接子进程」，不是「exe 是 node」 | MODEL-47 实测 |
| MODEL-11 | 「点击命中能打开对应文件并跳到行号」 | 补一格：编辑器已开着别的文件时再点一条 | F1 只在第二次才暴露 |

## 缺陷与观察

全文在 [findings.md](findings.md)。摘要：

| # | 一句话 | 建议 |
|---|---|---|
| F1 | 命中跳行只在编辑器首次开文件时生效（`EditorArea.tsx:607` 守卫恒真） | 已修，`171d1369`（2026-09-19） |
| F2 | 命中列表弹层锚在视口左上角（`HitListPopover.tsx:30` 用 `display: contents` 触发器） | 已修，`539cd754`（2026-09-19） |
| F3 | 用户手点「直接允许」无独立审计行（`isQuietPermissionActivity` 不看 `resolution`） | [决策 027](../../decisions/027-permission-rows-no-audit-trail.md) 不做 |
| F4 | 模型 / 思考强度菜单半中半英 | 文案项，已降级 |
| F5 | Stop 后上下文徽标清成 0%（aborted `turn_end` 用空消息重算 `context`） | 已修，`f059a8ae`（2026-09-19） |
| F6 | 时间线审批行读不出子代理（`forwarded` / `requesterAgentName` 无生产者） | 已修，`6ea3fb2d`（2026-09-19） |
| F7 | 硬编码路径 deny 零审计行（`tools/index.ts:177-178` 短路在闸门之前） | [决策 027](../../decisions/027-permission-rows-no-audit-trail.md) 不做 |
| F8 | 应用会话名与 pi 会话名两套存储从未打通 | Q028 推迟 |
| F9 | 切回 GUI 后第一次发送会杀掉挂起的 TUI | 设计如此，记录 |
| F10 | GUI worker 与 pi CLI 写的 JSONL 条目格式不一致（`kind` / `lane` / `seq`） | 回放正常；读取端守卫要留意 |

## 用户待办状态

- **平台 off 档**：上午勾选后接口未变（`updatedAt` 仍 `03:16:43Z`、`off: null`），直拉接口确认是平台侧未生成新版本，向平台方提了需求（`off` 须为非空字符串，null / 缺省都会被客户端隐藏；后台「留空即可」的说明文字是错的）。平台 10:55Z 修复发布，客户端端到端确认可用（见上节）。
- **默认模型改回 opus-5**：已是 `claude/claude-opus-5`，不用再做。
- **重启应用加载弹层修复**：本轮点验起的是 dev 实例，用户自己那份仍需重启。

## 方法与探针

探针全部归档在 [pointcheck/tools/](pointcheck/tools/)：`pc-lib.mjs`（共用：进主界面 / 关公告弹层 / 写 textarea 再点发送 / 动态 import store / evalAsync / 截图 / 展开工作组）、`m27-ask.mjs`、`m19-m23.mjs` + `m23-capture.mjs`、`m11-hover.mjs` + `m11-jump-order.mjs`、`m18-m20.mjs`、`m49-policy.mjs`、`m47-m05-m06.mjs` 及其 peek / shot / reports / stop 四件。后四份都是分阶段 + 状态文件可续跑，改脚本不必重跑已花钱的回合。

本轮沉淀的配方（细节在 findings.md 观察段）：回合结束判定「先等 busy 再连续三次 idle」；工作组默认折叠要先展开；每个搜索调用各占一条 assistant 消息；导入会话首次打开走侧栏行；GUI/TUI 开关用 `Input.dispatchMouseEvent` 且判 `aria-pressed`；「危险味」的测试命令要在提示词里声明测试意图，否则模型自拒。

## 修复与收口验证

2026-09-19 用户拍板后，F1 / F2 / F5 / F6 四条缺陷当日已修，分四个本地提交（均未推送）：

| 提交 | 内容 |
|---|---|
| `171d1369` | fix(editor) F1 命中跳行在编辑器已开其他文件时也生效：`EditorArea.tsx` 守卫改比较 Monaco 模型 URI；新增 `files/__tests__/editorPendingCursor.test.ts` 3 条 |
| `539cd754` | fix(chat) F2 弹层锚定到搜索行：`HitListPopover.tsx` 去掉 `display: contents` 包裹，`children` 收紧为单个 `ReactElement`；新增 `hitListPopoverTrigger.test.ts` 2 条 |
| `f059a8ae` | fix(runtime) F5 aborted / error 收尾不再清零上下文：`projector.ts` 的 `turn_end` 对占位消息不覆盖 `lastTurnUsage` / `lastContextUsage`；`runtimeEvents.test.ts` +3 条 |
| `6ea3fb2d` | fix(chat) F6 审批行归因：`permissionActivityRow.ts` 改认 `delegationId` / `agentName`，`runtimeEvents.ts` 类型注释更新；测试 +2 条 |

F3 / F7（审批行审计留痕）经用户拍板结案为「不做」，见[决策 027](../../decisions/027-permission-rows-no-audit-trail.md)；F8（pi 会话名打通）经编排器裁定推迟，见 [Q028](../../open-questions.md)。

收口验证（Linux 开发机）：三套 tsc（根 / `src/runtime` / `src/agent-host`）全部退出 0；全量 Vitest（单 worker）**450 文件 / 6909 条全部通过，277 s**（对比 09-18 收口的 447 文件 / 6843 条）。GUI 实测（HEAD `6ea3fb2d`，5 次真实回合，3 次起停）**四条全部通过**，证据 [pointcheck/fix-verify/](pointcheck/fix-verify/)：F1 先开 A 再点 B 跳到 57 行、再点回 A 跳到 12 行，`pendingCursor` 均清空；F2 触发元素 rect `[500, 178, 118, 21]`，弹层 `[279, 203, 560, 94]` 贴在行下 3.7 px；F5 Stop 前后徽标都是 1%，`context.tokens` 13186 沿用最后一次真实值，Stop 后三条 `usage.updated` 的 `context` 均非零；F6 审批行「已拒绝 bash pwd · 代子 Agent explorer 请求」，store `agentName: "explorer"`。F6 复验再次印证两条规律：`.env` 提示词模型自拒（把「不要绕过」读成「不要用子代理绕过」）；强制 bash `cat .env` 撞的是硬编码 deny、零审计行（F7 原样，决策 027 不修）。

同轮顺带确认 **off 档端到端可用**：平台 10:55Z 发布后，应用常规同步已拉到 `updatedAt = 2026-09-19T10:55:45Z`、三个 claude 模型 `thinkingLevelMap.off = "off"`；菜单出现该档（文案是英文 `Off`，即 F4 未修）；选中后跑一条短问题，回合头无思考子句、`thinking` 块 0 个、`usage.reasoning = 0`。

## 未做与原因

| 项 | 原因 |
|---|---|
| MODEL-49 重启层 | 判据兜底条件「新会话也不变」未触发 |
| MODEL-23 回放后 `thinking` 块 0 → 3 的根因 | 观察记录，未追 |
| F10 全仓 `kind === 'entry'` 守卫扫描 | 未查 |
| 全量 Vitest / tsc | 本轮 `src/` 零改动，无需重跑；基线仍是 09-18 的 447 文件 / 6843 条 |
