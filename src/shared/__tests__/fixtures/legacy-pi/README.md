# legacy-pi 语料：1.0.x 留在盘上的 pi 会话文件

dsh-rebase P1-9g。给 P1-9 迁移（解码、转换、离线工具）当回归夹具。**P1-12 删 runtime 之后就没有 native 写入器了**，这批文件只能在那之前生成。

## 来源

- 生成脚本：`scripts/gen-legacy-pi-fixtures.ts`（`node --experimental-strip-types scripts/gen-legacy-pi-fixtures.ts`，需要 `src/runtime` 自己的 npm 依赖和根 `node_modules` 里的 pi-coding-agent）。**这个脚本、`src/runtime` 与根依赖里的 pi-coding-agent 已在 P1-12 第 3 步删除（决策 147）**：要重新生成，须在 P1-12 之前的提交上开临时 worktree 运行，再把产物拷回来（风险 R6）。
- **全部是合成数据**，不含任何真实用户数据：对话是脚本里写死的，模型是 pi-ai 的 faux provider，工作区是脚本在 `/tmp/aiclient-legacy-pi-corpus/` 下临时建的（`notes.txt`、`src/app.ts`、`src/AGENTS.md`），`$HOME` 在任何模块加载前就指到这个临时目录。
- 写入器都是真的：`createRuntime` + `JsonlSessionStore`、`prepareSessionConfig`（1.0.x 的旧格式副本）、`NativeLegacyImportWriter`（CC / Codex 导入）、pi-coding-agent 0.84.4 的 `SessionManager`（v3 写入器，也就是内嵌 TUI 往同一文件追加行的那个）。只有 v1、v2、PI-Desktop 是手写的，因为这三种格式已经没有写入器了。
- 路径（`cwd`、`importedFrom`、工具输出里的路径）都是固定的 `/tmp/aiclient-legacy-pi-corpus/…`，不指向任何真实机器。
- id 和时间是写入器当场生成的，所以重跑脚本会得到另一份等价的语料。
- `.gitattributes` 让 `.jsonl` 按字节原样检出：金样本钉了每份文件的 sha256，`.native-v4.jsonl` 副本钉了原件的 sha256，换行转换会让旧格式原件看起来都「副本之后被改过」。

`manifest.json` 逐份记录：代际、写入器、读法（`v4` 直接解码 / `legacy` 先转换再解码 / `bytes` 字节层就读不了）、生成时的原路径（v1 的转换 id 由它派生）、覆盖点。

## 每份文件覆盖了什么

**native v4（自有 runtime 写的）**

| 文件 | 覆盖 |
|---|---|
| `v4-basic.jsonl` | 用户、助手、思考与签名、正文签名、`responseId`；工具调用与结果（`read`，以及带 `details.review` 的 `write`）；图片附件（带 `aiclientName`）；`model_change`、`thinking_level_change`、`aiclient.permissions`；会话名与标签（fact 行） |
| `v4-compaction.jsonl` | 压缩三次：summary 家族（`new_context` 工具触发，带 `firstKeptEntryId` 锚点）、fresh_window 家族（续开后第二次）、保留尾为空的压缩（无锚点，经 store 的 `appendCompaction` 写入） |
| `v4-branches.jsonl` | 失败回复（`stopReason: error`）留在重试旁支、重试运行（不加用户消息）、回退到用户消息之前、`lane` 行（切到旧分支再切回）、旧分支上的标签、每次切分支写的空 `aiclient.permissionGrants`；leaf 在最新分支 |
| `v4-branches.fork.jsonl` | 从上面那份 fork 出的文件（头里有 `parentSessionId`），又续了一轮 |
| `v4-stop-interject.jsonl` | 用户 Stop 截断的半截回复（`aborted`）+ `aiclient.runStop` `user_stop`；工具边界上的插话 + `aiclient.runStop` `interjected` |
| `v4-permissions.jsonl` | `aiclient.permissionGrants`（路径授权、命令前缀授权）、换 mode 时写的空授权、`aiclient.permissions` 三种档位（agent/ask、plan/ask、agent/auto）、bash 工具结果 |
| `v4-subagent.jsonl` | 委派：`aiclient.subagent` 的 started / message / settled，以及喂回父代理的内部消息 `subagent-report` |
| `v4-internal.jsonl` | 内部消息另外两种：`project-instructions`（按需发现的 `src/AGENTS.md`）、`turn-ceiling`（回合上限的收尾请求） |
| `v4-crash-midstream.jsonl` | 运行中崩溃：模型请求发出、还没有回复时的文件（只有用户消息） |
| `v4-crash-dangling.jsonl` | 运行中崩溃：工具调用已落盘、结果还没有（悬空调用） |
| `v4-crash-recovered.jsonl` | 上一份在 1.0.x 里再打开并续一轮：悬空调用补上了固定文本的中断结果（`recovery.ts`） |

**v4 + CLI 行**

| 文件 | 覆盖 |
|---|---|
| `v4-cli.jsonl` | native 一轮后，pi CLI 的 `SessionManager` 往同一文件追加 v3 形状的行（无 `kind` / `seq`）：消息、`bashExecution`、`custom_message`、custom、`model_change`、`thinking_level_change`、`session_info`、`label`、按 `firstKeptEntryId` 的压缩；再回到 runtime 续一轮，native 行接在 CLI 的尾巴上 |

**导入产生的 v4**

| 文件 | 覆盖 |
|---|---|
| `v4-import-claude.jsonl` | `aiclient.legacy-import.provenance`；display 行：工具、附件（图片未导入、`redacted`）、诊断；带思考与成对工具调用 / 结果的导入助手消息（`provider: legacy-import`，用量全 0） |
| `v4-import-codex.jsonl` | provenance；display 行：只供展示的工具调用、custom |

**旧格式与 1.0.x 做的副本**

| 文件 | 覆盖 |
|---|---|
| `legacy-pi-v1.jsonl` | v1：没有 id（按位置派生）、`firstKeptEntryIndex` 压缩、`hookMessage`、头里的旧档位 `tier` |
| `legacy-pi-v2.jsonl` | v2：id 与 parent、分支、`hookMessage`、思考签名 |
| `legacy-pi-v3.jsonl` | v3（pi CLI 写的）：树、`branch_summary`、按 `firstKeptEntryId` 的压缩、`bashExecution`、`custom_message`、旧档位条目 `aiclient-session-tier`、`session_info`、`label`、被 Stop 的回复 |
| `legacy-desktop.jsonl` | PI-Desktop schema 1：块记录、附件块（图片、缺失文件）、工具行并入载体、委派行（`legacy:subagent`）、`throughMessageId` 压缩、错误状态 |
| `legacy-pi-v3-drifted.jsonl` | 副本做完之后原件又被 TUI 续写（1.0.x 打开时报 `session_import_source_changed`） |
| `<上面各份>.native-v4.jsonl` | 1.0.x 打开旧文件时在旁边复制出的 v4 副本（`importedFrom`、`sourceSha256`、`legacyHeader`，末尾 `lane` 行）；v3 那份之后又续了一轮 native；drifted 那份的 `sourceSha256` 已经对不上原件 |

**损坏样本（由 `v4-basic.jsonl` 派生）**

| 文件 | 覆盖 |
|---|---|
| `damaged-torn-tail.jsonl` | 残尾：最后一行写到一半、没有换行 |
| `damaged-middle-row.jsonl` | 中间一行解析不了（解码时丢弃并报 `skipped`） |
| `damaged-seq-gap.jsonl` | 没有 CLI 行能解释的 `seq` 跳号（拒绝） |
| `damaged-unfinished-record.jsonl` | pi SDK 的 `record` 行：一对已完成的操作，外加一个只有 `operation_started` 的未完成操作（默认拒绝，`tolerateUnfinished` 时读出并报告） |
| `damaged-empty.jsonl` | 零字节文件 |
| `damaged-invalid-utf8.jsonl` | 中间一行里有非法 UTF-8 |

超过 32 MiB 的上限只测拒绝路径，不入库大文件。

## 金样本

`golden/<文件名>.golden.json` 是每份语料经 `src/shared/legacyPiSession/` 解码的结果：严格解码（1.0.x 的行为）是否拒绝、容忍未完成操作时的完整文档、活动分支、按 pi 规则构造的模型上下文摘要、权限恢复结果、历史投影、树投影。旧格式先用确定的 id 转换再解码。由 `src/shared/legacyPiSession/__tests__/legacyPiCorpus.test.ts` 比对。

重录（**只在收口时做**）：

```
AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run src/shared/legacyPiSession/__tests__/legacyPiCorpus.test.ts
pnpm exec biome format --write src/shared/__tests__/fixtures/legacy-pi
```

重跑生成脚本之后，语料里的 id 全变，金样本必须一起重录。
