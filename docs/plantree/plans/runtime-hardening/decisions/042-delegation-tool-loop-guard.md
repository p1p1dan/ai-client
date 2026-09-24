# 决策 042：子代理工具防空转——流式掐断重复回复，空转调用给终态回答

日期：2026-09-24。来源：用户在 v1.0.2 上用 glm-5.2 遇到「列出 / 停止 / 等待子 Agent」无限刷行；会话文件分析后，用户拍板：修复放进当前分支、四项全做（工具返回与报告交付 / 防空转 / 重开会话恢复子代理记录 / 默认开启轻量取证）、防空转只管子代理工具族、加一个紧急关闭开关、形态 A 只写会话文件即可。落地任务 **T122**（`46789042`）。

## 背景

- **现场（形态 B）**：一条 assistant 消息含 5709 个 toolCall，前 47 个是混杂的真实调用（含写文件与 `git add`），之后逐字重复 `TaskList {}` → `TaskStop {"delegationIds":[]}` → `TaskWait {"delegationIds":[],"mode":"any","timeoutSeconds":3}` 约 1887 轮；流了约 19 分钟后被用户 Stop，零执行、usage 全记 0。统计见[事故证据](../evidence/review-and-loop-incident-2026-09-24.md)。
- **代码推出的另一形态（形态 A）**：子代理都已结束、报告不在模型手里时，三个工具每次只回一句固定的话，报告又只能等模型不调工具时才由自动续跑送进来——模型与 runtime 互相等。
- 500 轮上限（[决策 040](040-main-session-turn-ceiling-with-wrap-up.md)）按「一次回复」计数，对形态 B 无效；对形态 A 要跑满约 1500 行才停。
- `b3eee689` 移除 64 轮上限时写明「不新增单工具循环检测（生态无先例，误报风险真实）」。**本决策推翻这一前提**：现场的 5709 个调用与疑似被它烧光的月额度证明成本真实存在；误报风险用「只管子代理工具族」控制。

## 规则

1. **范围**：只针对子代理工具族（TaskList / TaskStop / TaskWait，必要时含 Task），不做通用循环检测。
2. **单条回复内（形态 B）**：同一子代理工具以相同的规范化参数在一条回复里第 **3** 次出现，或一条回复里子代理工具总数超过 **16**，即在**流式阶段**取消服务方请求并结束这条回复。
   - 这条回复里的调用**一个都不执行**（它们是模型没看任何结果就盲写的）。
   - 之后**不自动再请求模型**（不跑收尾轮、不续跑、不重试）；本次运行以 `tool_call_repetition` 失败收尾，界面显示失败卡「模型输出出现重复调用，已中断」，会话可直接继续发消息，这条回复不进后续上下文。
   - 规范化：控制类调用只看目标 id（`{"delegationIds":[]}` 等同于 `{}`，TaskWait 的 mode / timeoutSeconds 不参与）；Task 看 agent、任务说明、model。
3. **跨回复空转（形态 A）**：没有运行中、也没有待交付报告时，每次运行第一次空调用给完整的终态说明，之后直接拒绝；连续 **2** 条回复全是空调用，复用触顶收尾机制（一轮禁止调工具的总结）后结束，不报 `turn_limit`。
4. **工具返回不再误导**：不带 id 的 TaskWait 默认目标改为「运行中 + 已结束未交付」；TaskStop 等待有上限（30 秒）、响应取消与插话、附上被停子代理的阶段性输出；TaskList 标注每份报告是否已交付；工具描述不再写死「列出 → 停止 → 等待」的顺序；自动续跑的等待有期限。这些是修正，不受开关影响。
5. **重开会话**：从会话文件的 `aiclient.subagent` 条目恢复子代理登记表；只有 started 没有 settled 的记为「已中断」，直接算已交付，不主动推给模型。
6. **取证默认开启**：每次拦截写 `aiclient.loopGuard` custom 条目（不进会话树）；形态 B 另经 `session.failed` 进 main.log。形态 A 只写会话文件，排查时让用户发会话文件即可。
7. **紧急关闭开关**：`AICLIENT_RUNTIME_LOOP_GUARD=0` 关掉第 2、3 条的拦截与取证（只有精确等于 `0` 才关，与 `AICLIENT_STREAM_TOOL_ROWS` 同风格）；第 4、5 条不受影响。

## 已知限制（接受）

- 同一条回复里用一字不差的任务说明派 3 次子代理会被拦下。
- 失败卡的「继续」按钮重发上一条用户消息，同一模型可能再次退化；代价有上限（几十个调用内再次掐断）。
- 被掐断回复的实际 token 消耗仍记为 0，另立 T125。

## 实现与验证入口

- `src/runtime/plugins/agent-loop/delegationLoopGuard.ts`（规则）、`src/runtime/plugins/agent-loop/index.ts`（`guardReplyRepetition` 包在 `streamFn` 外、`shouldStopAfterTurn` 空转计数）、`src/runtime/plugins/subagent/{index,registry,records}.ts`、`src/runtime/flags.ts`、`src/runtime/bootstrap.ts`、`src/runtime/README.md`（开关说明）。
- `src/renderer/components/chat/sessionFailure.ts`（失败卡）、`toolCard.ts`（参数文字改为「全部委派 / 未指定委派」）。
- 测试：`src/runtime/__tests__/subagentLoopGuard.test.ts`（规则纯函数、形态 B 合成事故、形态 A、正常用法不受影响、重开会话、开关关闭）、`flags.test.ts`、`subagentDelegation.test.ts`、`runtimeToolVocabulary.test.ts`、`sessionFailure.test.ts`；金样本 `nativeGuiSubagentEventStream.json` 已重录。
- 证据：[review-and-loop-incident-2026-09-24](../evidence/review-and-loop-incident-2026-09-24.md)。任务状态以 [roadmap](../roadmap.md) 为准。

## 追加注记（2026-09-24，T128 点验修复）

- **失败卡真正显示出来了**：开发机点验发现（D1），所有失败回合都以 `session.failed` 后紧跟 `session.status: idle` 收尾，store 用后者覆盖前者，中文失败卡在任何失败路径上都活不过一次渲染。T128 改为：`failed` 不被收尾的 idle 覆盖、保持到下一轮开始；「能否开始下一轮」统一走 `statusForNextTurn`（失败且已收尾按空闲算）。
- **失败后队列照常放行**（取舍）：`queueRelease.ts` 注释里的原始设计 3.2 是「失败后队列不自动放行」，但 native runtime 上线后因上面的覆盖，实际行为一直是放行。T128 保持放行：改成不放行会让用户在失败后发不出任何消息（Enter 只入队、「立即发送」被状态拦、「继续」重发的是导致失败的那条）。设计 3.2 以本注记为准失效；若要恢复，需先设计失败后的出口。
