# DEV-33 — 会话 JSONL 字节数逐条记录（真机 GUI，dev-E2）

会话：`session-1789655267185-g85qdok`（工作区 /home/ai/code/ai-client）
文件：`/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/session-1789655267185-g85qdok.jsonl`
每条消息的附件：`big-5mib.png`（5,242,000 B，1024×5112 灰度 PNG）+ `small-1mib.png`（1,040,000 B，512×2025）
两张合计 base64 = 6,989,336 + 1,386,668 = **8,376,004 B**，落在
`ATTACHMENT_TURN_STORED_BYTES` = 8,388,608 之内（余 12,604 B）。

| 发送 | 界面结果 | 会话文件字节 | MiB | 与 32 MiB 预算的差 | 假网关累计请求 |
|---|---|---|---|---|---|
| 第 1 条 | 成功，模型回 "fake gateway ok" | 8,377,869 | 7.989 | 25,176,563 | 1 |
| 第 2 条 | 成功 | 16,754,892 | 15.978 | 16,799,540 | 2 |
| 第 3 条 | 成功 | 25,131,915 | 23.968 | 8,422,517 | 3 |
| 第 4 条 | 成功 | **33,508,940** | **31.957** | **45,492** | 4 |
| 第 5 条 | **被拒**：composer 出现 `Error: session exceeds the configured size budget` | 33,508,940（未变） | 31.957 | 45,492 | 4（未再发请求） |
| 拒绝后纯文本 ×3 | **什么都没有**：时间线无消息、无错误、网关无请求、文件不变（worker 侧其实每次都抛了 `session_size_limit`，只在退出时的 stderr 回放里可见） | 33,508,940 | 31.957 | — | 4 |
| 退出重开后打开该会话 | **正常打开**：`historyErrors` 为空、无 `io_limit`、4 轮历史全在 | 33,508,940 | 31.957 | 45,492 | 4 |
| 重开后再发纯文本 | **成功**，模型回 "fake gateway ok" | 33,509,873 | 31.958 | 44,559 | 5 |

每条附件消息的实际增量：第 2/3/4 条各 **8,377,023 B**（第 1 条另含会话头行）。
文件最终 **33,508,940 B = 31.957 MiB < 32 MiB (33,554,432)**，与判据「停在 32 MiB 以内（≈31.9 MiB）」一致。

## 逐行结构（删除会话文件前留档）

| 行 | kind | role | content block | 字节 |
|---|---|---|---|---|
| 0 | header | — | — | 188 |
| 1–3 | entry | — | — | 195 / 215 / 248 |
| 4 | entry | user | text,image,image | **8,376,397** |
| 5 | entry | assistant | text | 626 |
| 6 | entry | user | text,image,image | 8,376,397 |
| 7 | entry | assistant | text | 626 |
| 8 | entry | user | text,image,image | 8,376,397 |
| 9 | entry | assistant | text | 626 |
| 10 | entry | user | text,image,image | 8,376,398 |
| 11 | entry | assistant | text | 627 |
| 12–13 | entry | user / assistant | 重开后那条纯文本与回复 | 合计 933 |

单行 8,376,397 < `SESSION_MAX_ENTRY_BYTES` = 8,388,608（余 12,211 B），
所以第 4 条不是被单行上限挡住、而是刚好塞得下，这正是「4 条才顶满」的算术前提。
完整逐行表见 `dev-33-34-session-rows.md`。
