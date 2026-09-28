# 决策 111：P1-4c1 回合语义的实现取舍：插话载荷与「有没有回合」的口径、回显、待送达气泡、重试受理的细节

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 093](093-interject-via-dsh-steer.md)、[094](094-stop-keeps-inbox.md)、[095](095-retry-keeps-hidden-continuation.md)（用户已批准，[决策 110](110-user-rulings-2026-09-28-batch2.md)）；[决策 028](028-retry-via-hidden-continuation-prompt.md)；[决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [决策 106](106-p1-4d1-live-mapping-choices.md) 第 43 条；runtime-hardening 决策 046（worker 是「有没有回合」的权威）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-1～4c-3、§8 第 1 个实验；[分片 04](../topics/p1-4-bridge-parity/04-turn-semantics.md) §2；
- 开工前实验：[evidence/p1-4c1-steer-experiment-2026-09-28.md](../evidence/p1-4c1-steer-experiment-2026-09-28.md)（17 项判定全部通过）。

改动留在工作区，由编排者复跑后提交。

**修订（2026-09-28，P1-7a）**：第 12 条「待送达」气泡的最终样式已由 P1-7a 定下：虚线边框、不画底色、时钟图标代替转圈；目标条没有「因插话暂停」这一态；输入框运行中的占位改为「Ctrl+Enter 并入当前回合」（[决策 118](118-p1-7a-goal-todo-round-choices.md) 第 24、26 条，待审批）。「遗留」里引擎重启后待送达气泡收不掉的问题未动。

**修订（2026-09-28，P1-4c2）**：第 4 条的「带附件的插话一律拒绝」已放开：插话与普通发送共用同一个入库入口，被拒时答 `WORKER_ATTACHMENT_REJECTED`，渲染层给出点名文件的提示，「当前引擎暂不支持附件」一句连同翻译已删（[决策 112](112-p1-4c2-attachment-choices.md) 第 5、12 条）。

## 规则

### 一、开工前实验

1. 按重划 §8 第 1 条做了实验，脚本是 `src/dsh-host/tools/steer-experiments.ts` 和只在实验里装的行 `tools/lib/steer-experiment-row.mjs`（仿 P1-4b 的 `rewind-experiments.ts`，留在仓库里供复跑，不进产品包）。结果与决策 093 / 094 的假设一致，按原方案实现。
2. 实验多测到两条事实，写进了实现：
   - 不能在 `session/event` 监听器里同步 steer，DSH 会以「append 不可重入」拒绝。bridge 只在 RPC 处理里 steer，本来就满足；`DshAgent.steer` 的注释写明了这一点。
   - Stop 之后、回合收敛之前 steer，DSH 会把消息改投下一回合，并在中止收敛后自己开一个回合（见第 6 条）。

### 二、协议

3. `worker.interject` 的载荷改为 `{logicalSessionId, attemptId, text, attachments?}`：
   - `attemptId` 必须非空；要么 `text` 非空，要么至少一个附件；附件格式与 `worker.send` 相同。
   - 原来只带 `logicalSessionId` 的「停在边界」信号不再是合法请求，答 `WORKER_INVALID_PAYLOAD`。
   - 结果仍是 `{interjected, turnActive?}`；IPC `chat:interject` 把整个结果交回渲染层，错误码按 `chat:send` 的写法带过 IPC。
4. **带附件的插话**：载荷里收下并校验，但 DSH bridge 在 steer 之前就拒绝，错误码与普通发送相同，都是 `WORKER_DSH_UNSUPPORTED`（决策 010）。渲染层给出与发送相同的「当前引擎暂不支持附件」提示，草稿原样留在输入框。附件入库由 P1-4c2 统一放开（决策 096、097）。

### 三、bridge

5. **「有回合」的口径**：bridge 持有回合（自己开的，或 DSH 自己开、bridge 起了名字的合成回合），或者 agent 状态不是 `idle`，就算有回合，照样 steer。以下都算没有回合，答 `{interjected:false, turnActive:false}`，什么也不发：
   - 回合已经 `turn/end`；
   - 只剩后台任务在跑、agent 空闲。这时 steer 会让 DSH 自己开一个新回合（实验 E2b），不如交给渲染层按普通发送处理；
   - agent 正处在维护任务里（rewind），这时状态也读作 `idle`。
6. **Stop 之后、回合结束之前的插话**：这时 bridge 仍持有回合，照样 steer。DSH 把消息改投下一回合，等中止收敛后自己开出这一回合（实验 E5）。对 bridge 来说，这是一个合成回合，插话按 id 回显。按决策 090 跟随 DSH，不另做拦截。
7. **回显**：
   - 回合里凡是来源为 `user` 的 `user/message` 都回显 `message.started`（user）。回合自己的提示词带发送的 `attemptId`；bridge steer 进去的消息按消息 id 找到插话的 `attemptId` 带上。
   - 两样都对不上的（比如宿主重启后，收件箱里留下的插话被取走，bridge 内存里的对应表已经没了），也照样回显，只是不带 `attemptId`。
   - 原来只回显回合自己的提示词，别的都丢掉。现在直播与历史投影一致：历史里每条用户消息都是一行。
   - 插话的对应表只存在 bridge 内存里，会话 `dispose` 时清空，不落盘。
8. **Stop**：`cancel({kind:'user'}, {keepInbox:true})`，别的不动。`--check` 复核：`stop-stream`、`stop-tool`、`perm-stop` 三个金样本都没有变化，因为收件箱是空的，本来就不落事件。
9. **重试的受理**：
   - 顺序：先 bootstrap，再等历史缓存就绪。缓存读不出来时，当作「没有回合结束的记录」拒绝（fail closed）。然后先查空闲（有回合就拒，理由写「A turn is running」），再查最后一个 `turn/end`。
   - `turn/end` 的种类取自历史折叠。为此给 `DshHistoryFold` 加了 `lastTurnEnd`，缓存层透出 `lastTurnEnd()`。这样恢复之前的回合、DSH 恢复时补写的 `interrupted` 都算得上。
   - `aborted` 包括 Stop，也包括步数上限收尾时的 `aborted{hook: aiclient-turn-ceiling}`。后者在渲染层显示为 `turn_limit`，不出失败卡，也就不会走到重试；即使走到了，受理也无害。
   - 续跑提示的文字取分片 04 §2 的英文句子，定为常量 `DSH_RETRY_CONTINUATION_TEXT`：「The previous model request failed. Continue from where it stopped.」；来源是 `{kind:'aiclient-retry', form:'notice', summary:'Retry after a failed request'}`。
   - 受理后与普通发送一样，按载荷里的 model / effort 重新选路，所以也可能在发任何事件之前答 `MODEL_NOT_CONFIGURED`。回合不记 `userMessageId`，不会回显。
   - DSH 的 `MessageSource` 靠声明合并扩展，我方没有把 `aiclient-retry` 声明进去；bridge 行照防空转插件的写法做类型转换。

### 四、Main 与渲染层

10. `WorkerManager.interject` 把消息交给 worker，返回完整的结果。受理时不碰忙碌锁：插话并入的就是正在跑的那个回合，回显也用这个回合的 requestId。`turnActive:false` 时照决策 046 收掉残留的锁，规则没变。
11. **Ctrl+Enter 不再经过队列**：
    - 删掉队列的 `'next'` 优先级、`interject` reducer 与 store 动作、排队条上的「插话」标记、条目模型的 `interjection` 字段，以及相关的 4 条翻译；
    - 回合跑着时，Ctrl+Enter 直接调 `chat.interject`；worker 说没有回合时，这条消息按 Enter 的方式普通排队，由 Main 收锁后的 `idle` 放行；
    - 用 Enter 排队的行为不变。
12. **「待送达」气泡**：
    - 复用待回显气泡的 store，加字段 `awaitingDelivery`，id 前缀是 `pending-user:steer:`，仍属于待回显行。气泡上把「正在发送…」换成「待送达」，转圈图标保留。样式先做到最小，最终样式随 P1-7 定。
    - 气泡在 IPC 之前发布，因为回合可能在 IPC 答复之前就取走了消息，先回显；取走后由带同一 `attemptId` 的回显收掉，与发送的气泡相同。
    - worker 拒绝或答「没有回合」时，气泡当场撤下。
    - 送达之前，气泡排在时间线末尾；送达后，正式的用户行出现在 DSH 实际取走它的位置（「助手 → 插话 → 助手」）。
13. **草稿什么时候清空**：worker 接下之后才清，而且只在输入框里仍是发出去的那段文字时才清；被拒时草稿原样保留。另加了防重入标志，防止连按两次 Ctrl+Enter。
14. **决策 106 第 43 条**：
    - 发送等待期间收到本会话的 `session.failed`，如果回合已经受理（见过回显或重试的 `running`），而且错误码不是 Main 的 `dsh_host_crashed` / `dsh_engine_restarted`，就不再 `unbindHost()`。于是失败卡的「继续」直接发给原来的 slot，不走暖 resume。
    - 宿主崩溃或重启、受理之前的失败，照旧解绑。
    - 本分支所有会话都走 DSH，所以「只影响 DSH 路径」成立。

### 五、假网关与录制

15. 假网关新增 3 个场景，脚本多收第 7 个参数：请求里全部用户文本（不含工具结果）：
    - `P1-STEER`：两个 bash 步，第一个先睡 2 秒；最后作答，列出请求里出现过的 `STEER-NOTE-<标记>`；
    - `P1-STEER-ONE`：一步作答，同样列出这些标记；
    - `P1-FAILONCE`：请求里没有续跑提示时答 HTTP 500；有了就作答。
16. 录制新增两个场景：
    - `steer`：第一个命令睡眠开始 500 ms 后插话；断言回答里有这条插话的标记；在 `rpc.interject` 里记下两次插话的回答（运行中受理、空闲时 `turnActive:false`）；
    - `fail-retry`：先失败，然后「继续」受理并恢复；成功之后再点一次「继续」，被拒（`WORKER_RETRY_UNAVAILABLE`），记在 `rpc.retry`。

    两个场景各录两次，结果逐字节相同；历史投影与 bridge 的答复对得上（在 /tmp 用金样本测试的同一套比对跑过）。`dshHistoryGolden.test.ts` 的场景清单已经加上这两个名字；金样本由编排者收口时重录，在那之前清单这一条会失败。

## 取舍

- **回显所有用户消息，还是只回显认得的**：只回显认得的，宿主重启后送达的插话就只在历史里出现，直播里看不到。全部回显的代价是不带 `attemptId` 的那一条，渲染层收不掉它原来的待送达气泡（见「遗留」）。
- **没有回合时，由 bridge 自己 steer 开新回合，还是交还渲染层**：前者会绕过 Main 的忙碌锁和渲染层的发送流程，比如首句标题、Stop 看门狗。交还渲染层，走的是 Enter 已有的整条路径。
- **在 Stop 收敛前拦下插话**：可以在 `stop()` 之后答 `turnActive:false`，让消息走排队，在 Stop 之后自动发出。那是为贴近 1.0.3 做的自研；DSH 的原样语义同样不丢消息，所以不做。

## 遗留

- 宿主重启、或 bridge 的插话对应表丢失之后，收件箱里留下的插话送达时，回显不带 `attemptId`：
  - 渲染层原来的「待送达」气泡收不掉，时间线上会多出一行重复；
  - 可以在 `disconnected{engine_restarted}` 时撤下这个会话的待送达气泡，留给 P1-7 或 P1-3 的收尾。
- Stop 之后收件箱里还有插话时，做 rewind 或 fork：
  - 这条插话留在被退役的会话里，没有随子会话带过去；
  - 分叉种子会不会复制收件箱的 splice 事件，没有实测；
  - 渲染层的待送达气泡会一直留着。
- 待送达气泡的外观、目标条去掉「因插话暂停」，归 P1-7。
