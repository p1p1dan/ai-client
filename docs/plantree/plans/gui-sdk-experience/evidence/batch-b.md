# B 批运行状态与重试恢复（2026-09-09）

## 根因与实现

- RetryBanner 原先在 segments 之前，长输出末尾看不到；移到输出末尾，详情折叠，输入区上方共享短状态。
- 现有 turnStatus 把任何 block（包括 thinking/tool）统称 streaming，只有时钟。新增 sessionActivity 从真实 message/thinking/tool/status 事件推导等待模型、思考、输出、工具摘要、等待确认、重试、停止。计时以事件 timestamp 为起点；重试显示实际次数与剩余等待时间，过了 delay 显示等待重试响应，不伪造成功或进度。
- 追加红框反馈的直接根因：PiWorkerSession 的 message_end(error) 写 turn.pendingError，但重试成功的 message_end/auto_retry_end 未清理，agent_settled 误报 session.failed。现成功响应/auto_retry_end(success) 清旧错误；失败重试保留 finalError。仅修现有 SDK 事件映射，不迁移 runtime。
- renderer 原先 session.failed 写全局 lastError，完成不清理。增加会话 runtimeError，真实恢复输出、完成/停止清理，后台失败不污染当前会话；切换会话清全局旧提示，原会话终止错误可重新读取。重试中不显示终止红框。
- 保持既有滚动跟随策略，无新增 scrollIntoView/强制滚底。末尾正常状态复用新组件，旧发送前等待/失败兜底保留。

## 参考行为

读取本地 pi-app worker-session-events 的 auto_retry_end 分支：适配其失败结算语义；不移植 worker 架构。核对本机 Pi SDK agent-session 的成功响应发 auto_retry_end(success) 与取消发 finalError 行为。界面状态契约留在本仓 UI/宿主层。

## 验证

- piWorkerSession.test.ts：22 项通过，新增成功/耗尽两条 529 重试事件序列；成功只发 session.completed，耗尽只发最终 session.failed。
- sessionActivityRecovery/chatSessionsCore/chatSessionsBatch/sessionActivityStatus：4 文件 78 项通过。包含 529/400/429→重试→恢复→完成、跨会话错误归属、工具/确认/停止、真实 React 倒计时与卸载后计时器清理。
- retryBanner/turnStatus/messageTimelineScroll/messageTimelineWiring：4 文件 106 项通过。保留用户上翻后的跟随锁定规则。
- 根 tsc 与独立 agent-host tsc 均通过（1200 MiB）；本轮 Biome 11 文件通过。
- 未运行生产构建、未使用真实上游制造 529/4xx、未完成整套 GUI/Windows 点验。没有把纯函数/DOM 测试写成现场验收。

## 最小现场清单

长输出滚至末尾，触发可恢复 529/429，核对末尾与输入区计时/次数；向上读时不得抢滚动；恢复后旧提示消失且最终无红框。另测耗尽/停止、等待确认、切换会话与重载，真正失败需保持可见。
