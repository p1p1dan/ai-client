# DEV-34 — Main IPC 层缺失附件校验的直接验证（真机，dev-E2）

绕开 Composer，在渲染层直接调 `window.electronAPI.chat.send(payload)`
（通道 `chat:send`，Main handler `src/main/ipc/chat.ts:503`）。
会话 `session-1789656608127-jy9zhgb`（工作区 /home/ai/code/ai-client），
先用一条普通消息把 worker 绑上，再发两种超限 payload。

## A. 单图超过单附件上限

| 观察点 | 结果 |
|---|---|
| payload | 1 张图，base64 **9,786,712 字符**（背后 **7,340,034 原始字节**） |
| 上限 | `ATTACHMENT_MAX_BYTES` = `MAX_ATTACHMENT_READ_BYTES` = 5,242,880（超 40%） |
| Main 是否拒绝 | **否**。`chat.send` 未抛错，70 ms 返回 `{"requestId":"send-1789656669843-5"}` |
| worker 侧结果 | runtime 拒绝：`attachment "huge-7mib.png" is 7340034 bytes; the limit is 5242880 bytes per attachment`（`attachments.ts:103-108`，code `attachment_size_limit`） |
| 界面 | composer 上方裸 mono 红块 `Error: attachment "huge-7mib.png" is 7340034 bytes; …` |
| 假网关 | 请求计数不变（6 → 6），模型侧从未被调用 |
| 会话文件 | 未增长 |

## B. 六张图超过 5 张上限

| 观察点 | 结果 |
|---|---|
| payload | 6 张图，每张 base64 266,668 字符（200,000 原始字节） |
| 上限 | `DEFAULT_ATTACHMENT_LIMITS.maxCount` = 5（`attachmentLimits.ts:41`），**只有渲染层有这条** |
| Main 是否拒绝 | **否**，18 ms 返回 `{"requestId":"send-1789656713935-6"}` |
| worker 侧结果 | **接受**。runtime 没有条数上限，`preparePrompt` 只按字节判 |
| 会话文件 | 第 6 行写进 `['text','image','image','image','image','image','image']`，共 6 个 image block |
| 假网关 | 6 → 7，模型真的收到了这一轮 |
| 界面 | 时间线正常显示 six-1.png … six-6.png 六个附件与回复 |

## judge

**Main 原样放行**，两种 payload 都不做任何长度 / 字节检查，与
`src/runtime/plugins/agent-loop/attachments.ts:22-36` 的注释
（"the IPC hop carries `attachments` through preload, the chat handler and the
worker bridge without a single byte check"）逐字相符。
字节这一维由 runtime 的 `preparePrompt` 兜住（A 被拒），
**条数这一维在 Main 与 runtime 两侧都没有人兜**（B 通过）。

## 日志

发送当时三处 grep 计数全 0（`main.log` 更是全程 0 行）。
那条 `attachment_size_limit` 只在**杀掉应用**时，由 Main 的
`crashed: Worker exited (code=15 …); last 6 stderr line(s):` 把 worker 的 stderr
回放出来，落在按天日志与 `dev.js` 标准输出里，带完整调用栈
（`attachments.ts:104` → `agent-loop/index.ts:209` → `:150`）。
即：应用还在跑的时候看不到，退出时才作为「遗言」补出来。详见 `dev-33-34-mainlog-grep.txt`。
