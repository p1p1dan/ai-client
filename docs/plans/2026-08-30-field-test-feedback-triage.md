# 2026-08-30 真机点测反馈分诊

> 来源：用户 2026-08-30 对 Pi 后端分支进行真实试用后的 11 条反馈。
> 截图：`/home/ai/code/test/Screenshot From 2026-08-30 11-24-38.png`、
> `11-32-28.png`、`11-33-56.png`。
> 关联计划：[Pi Backend Migration roadmap](../plantree/plans/pi-backend-migration/roadmap.md)。
> 状态：分诊完成；仅更新规划与交接，不代表已授权施工。

## 1. 先纠正三条容易误判的事实

1. **“我的设置未创建”本身不是 F4 的原因。** 设置页截图明确显示“随包默认 · 生效中”，
   而“我的设置”层只应在用户第一次保存自定义规则后创建；空白用户层不需要预先写一个
   `config.json`。因此 F6 是符合当前设计的空态，不应为了消除“未创建”字样自动造文件。
2. **权限实际行为仍与 D11 有偏差。** 当前随包文件确实包含 `read: allow` 和
   `~/.pilab/*: deny`，但真机表现为普通 read 首次仍询问、访问 `~/.pilab/` 也询问而非
   直接拒绝。用户接受后者的交互，但它仍是“实现行为是否符合既有安全策略”的技术问题，
   不能用“用户觉得合理”把 D11 的验收差异抹掉。见 roadmap T08-c / open question Q10。
3. **右键当前做的是 archive，不是永久 delete。** `SessionRow.onContextMenu` 直接调用
   `archive(sessionId, true)`，记录立即从列表消失且没有明显恢复入口，所以用户感知为
   “被删除”。后续菜单应先把语义说清楚；没有真实永久删除能力前，不应把菜单项伪装成 Delete。

## 2. 分诊表

| # | 发现 | 分类 | 严重度 | 映射任务 | 处置 |
|---|---|---|---|---|---|
| F1 | 未添加仓库时不应显示聊天框，误导用户以为可以直接聊天 | 决定反转 | major | T12-e → T12-e′ | 用户真机推翻 2026-08-29“保留输入框”的决定；只留添加仓库引导。注意欢迎卡当前在 `ChatComposer` 内，不能只把 Composer 整体隐藏 |
| F2 | 发送 `hi` 后延迟数秒才显示；失败/重试时消息回显时序令人困惑 | bug / 时序 | major | T24 | 当前没有乐观插入，用户消息要等 Host 接纳后的权威 echo；需抓 create/resume/send/retry 的事件序列再定修法 |
| F3 | 权限审批是阻断式弹窗，应改为聊天窗口内浮现的形式 | 体验改进 | major | T08-b | 将审批 UI 从窗口级 `AlertDialog` 改为聊天区域内的审批层/卡；协议与 Host bridge 可复用 |
| F4 | 默认权限下 read/edit 等看起来都会询问 | 策略验收差异 | major | T08-c / Q10 | 随包默认已显示生效，不能归因于 F6；需核对实际 surface、value、path/external-directory 联合判定与 activity 记录 |
| F5 | 读 `~/.pilab/` 会询问而非直接拒绝；用户认为询问也可接受 | UX 可接受，但策略不一致 | minor | T08-c / Q10 | D11 明定 `~/.pilab/*: deny`，故仍需查明为何未命中；产品最终要“ask 还是 deny”可在查明事实后再决定是否改判 D11 |
| F6 | 设置页“我的设置”未创建，当前使用随包默认 | 确认正常 | — | T08-c | 不自动创建空文件；第一次用户编辑时再物化。截图同时证明随包默认层已被识别为生效 |
| F7 | 连续 read 未折叠为 `Explored 2 files` | 低优先级验收缺口 | trivial | T12-d | 截图中每次 read 后夹有 permission activity 行，可能影响连续工具聚合；用户明确“无伤大雅”，不重开 T12-d，只留复验 |
| F8 | 正文顺序、思考时间、流式代码块、锚点、悬停条、被拒工具、长回合表现正常 | 真机通过 | — | T12 全系 | 接受为 T12-a/b/c/d 的真实回合验证证据；保留 F7 与发送后滚动问题的独立例外 |
| F9 | 模型列表过长，需要按 claude / gpt / 国产等标签分组；effort 应按模型能力变化 | 新功能 | major | T25 / Q11 | 云端模型配置负责标签；客户端 models 配置与 catalog 必须携带标签和模型级思考能力，参考 pi-app 分组菜单 |
| F10 | 浏览历史后发送消息，页面不主动滚到底部 | bug | major | T26 | 主动发送应发出一次明确 jump-to-bottom 信号；不能只依赖“原本就在底部才跟随”的增长逻辑 |
| F11 | 右键会话即消失；移除 repository 后左侧仓库和会话不更新，仍可新建对话 | bug + 体验 | major | T13 + T27 | T13 做右键菜单并明确 archive 语义；T27 修空树同步被提前 return 导致的陈旧快照 |

## 3. 任务树变更

### 已有任务更新

| 任务 | 更新内容 |
|---|---|
| T12-e / T12-e′ | T12-e 保留已落地证据；新子节点 T12-e′ 追踪“无仓库时隐藏聊天输入区”的决定反转 |
| T08-b | 增加“窗口级阻断弹窗 → 聊天区域内联审批层”的形态变更；真机 allow/deny 链已贯通，但新形态仍待施工与复验 |
| T08-c | F6 改判为正常空态；F4/F5 合并为真实策略命中调查，不再假设是用户层文件缺失 |
| T12 全系 | F8 记为真实回合验证通过；F7 只保留低优先级聚合复验，不把已完成任务整体降级 |
| T13 | 激活范围仅为会话右键管理：菜单、重命名、Archive 的确认/撤销或恢复入口；历史浏览与分支回退仍 Deferred |

### 新建任务

| 任务 ID | 名称 | 阶段 | 状态 |
|---|---|---|---|
| T24 | 消息发送时序与重试体验 | Phase 3 | Pending |
| T25 | 模型选择菜单分类与模型级 effort | Phase 5 | Pending；云端 schema 相关设计待 Q11 |
| T26 | 发送消息后主动滚动到底部 | Phase 3 | Pending |
| T27 | 仓库移除后的左侧树同步 | Phase 3 | Pending |

## 4. 对应子节点与验收口径

### T12-e′ — 无仓库时隐藏聊天输入区

- **落点**：`ChatWorkspace.tsx`、`ChatComposer.tsx`、`ChatWelcomeCard.tsx`。
- **关键约束**：欢迎卡目前由 Composer 渲染；施工时需先把欢迎卡提升到工作区空态，不能
  简单 `!cwd && return null`，否则添加仓库按钮也一起消失。
- **验收**：无仓库只见引导与添加按钮；不可输入/发送；添加仓库后欢迎态消失、Composer 出现；
  移除最后一个仓库后反向回到欢迎态。

### T24 — 消息发送时序与重试体验

- **落点**：`ChatComposer.runSend()` / `handleRetry()`、`chatSessions.applyRuntimeEvent()`、
  `piRuntime` 的用户 echo 与 create/resume fallback。
- **先取证**：记录 draft 清空、create/resume/send 发起、Host admission、`message.started`、
  error、retryable snapshot 恢复的时间线；确认用户所谓“回到聊天窗口”指 timeline echo
  还是输入框 draft 恢复。
- **验收**：点击发送后立即有明确反馈；同一用户消息只出现一次；失败可重试且不双发；
  resume→create fallback 不让消息消失、跳位或重复。

### T08-b — 内联权限审批

- **落点**：保留 `extensionUiBridge` / `useExtensionUiStore`，重做
  `ExtensionUiDialog.tsx` 的呈现边界并挂到聊天工作区。
- **验收**：审批只阻断当前待决工具，不用窗口级模态遮罩；内容、`Request N/M`、允许、
  session allow、拒绝、带原因拒绝、关窗 fallback 均保留；切会话/Stop/超时能清理待决卡。

### T08-c / Q10 — 策略真实命中调查

- **已知事实**：dev 插件目录中的 `config.json` 存在且设置页显示“随包默认生效”；用户层
  缺失是设计行为；真机 activity 显示首个 read 为用户批准、后续来自 session pattern。
- **要查**：read 是否同时触发 `external_directory`；surface/value 是否为预期的小写名与
  规范化路径；`~` 展开后是否导致 `~/.pilab/*` pattern 不匹配；项目 cwd 与测试目录是否一致。
- **验收**：`read` 在仓库内按 D11 自动放行；write/edit 询问；`git status` 自动放行；
  `git commit` 询问；`.env` 与 `.pilab` 的最终 ask/deny 行为有明确决定与 activity 证据。

### T13 — 会话右键菜单

- **落点**：`LeftNav.tsx` 的 `SessionRow`。
- **验收**：右键不再立即 archive；菜单至少提供 Rename 与 Archive；Archive 前有明确确认、
  撤销或可发现的恢复入口之一；菜单文字不得把 archive 伪装成永久删除。
- **后置**：真正永久删除、历史浏览、fork/rewind 仍需单独能力与产品决定。

### T27 — 仓库移除后的左侧树同步

- **根因候选已定位**：`useSyncChatWorkspaceTree.ts` 在 `tree.workspaces.length === 0`
  时提前返回，导致 App 的 repositories 已清空而 `chatSessions` 仍保留最后一份非空快照。
- **验收**：移除仓库后仓库行和所属会话立即消失；不能再为已移除仓库新建会话；移除最后
  一个仓库时同样清空；无需 Reload；重新添加同一路径后不产生重复项目/会话。

### T25 / Q11 — 模型标签与模型级 effort

- **落点**：`piModelConfig.ts` / validation、`AgentModelOption`、`PiModelConfigService.piModelOption()`、
  `ComposerModelTrigger.tsx` / `composerModel.ts` / `efforts.ts`。
- **现状**：Pi 模型配置已有 `reasoning` / `thinkingLevelMap`，但投影为 `AgentModelOption` 时
  只留下 id/label；标签目前不存在，effort UI 则是全局固定五档。
- **建议方向**：云端管理站点维护 `tags`，同步进本地 models 配置；客户端沿 catalog 透传。
  effort 不再另造一份平行能力表，优先复用每模型已有的 `reasoning` / `thinkingLevelMap`，
  并为旧配置定义兼容 fallback。
- **验收**：顶层只显示标签/分组，悬停或点击进入子菜单；无标签模型有稳定兜底组；当前模型
  仍可定位；每个模型只显示其支持的 effort，切模型后非法旧值被安全降级。

### T26 — 主动发送后的滚底

- **落点**：`ChatComposer` 发送信号 → `ChatWorkspace` → `MessageTimeline.jumpToBottom()`。
- **验收**：用户在历史位置点击发送后立即滚到新消息/运行中状态；随后流式增长继续跟随；
  单纯浏览历史且未发送时仍尊重用户位置；发送失败也能看到错误与重试入口。

## 5. 落地检查点（2026-08-30）

紧急稳定化 M1/M2/M3 已完成：F1/T12-e′、F2/T24、F10/T26、F11/T13 右键切片与
T27 仓库移除同步均落地；提交、对抗复核与最终 282 files / 5517 tests 见
[证据档](../plantree/plans/pi-backend-migration/evidence/2026-08-30-urgent-stabilization-m1-m3.md)。
F3/T08-b、F4/F5/Q10、F9/T25/Q11 仍按原分诊后续处理。

## 6. 无需单独开工的反馈

- **F6**：用户层未创建是正常空态，不创建空文件。
- **F8**：接受为真实回合通过证据。
- **F7**：仅留复验，不进入近期主线，除非后续确认是 permission activity 打断聚合的回归。
