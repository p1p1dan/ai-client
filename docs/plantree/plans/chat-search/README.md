# 按聊天内容搜索并跳到对应会话

分支 `feat/chat-search`，从 main `14628143` 开出。进度看 [tasks.md](tasks.md)。

## 1 起因与已定方案

一位用户在侧栏「搜索」里输入只在对话中出现过的编号 `8GE21E15`，想找到当时的会话。但这个入口只搜工作区里的文件，侧栏的「搜索会话」也只比对标题，所以两处都搜不到（排查经过见 [加密机内容搜索证据](../dsh-rebase/evidence/encrypted-search-2026-10-28.md)）。

交互预览见 [`docs/design/2026-10-29-chat-search-preview.html`](../../../design/2026-10-29-chat-search-preview.html)。用户 2026-10-29 按推荐定了：

| 问题 | 定案 |
|---|---|
| 入口 | **A**：侧栏「搜索」打开搜索框，默认在「对话」页；「文件」「内容」两页原样保留 |
| 选中之后 | **1**：打开会话，滚到命中的那条消息并闪一下，右上角留查找条（第几处 / 共几处，上下跳） |
| 已归档会话 | 先不搜 |

## 2 现状（2026-10-29 调研）

- **会话列表**：`<userData>/session-index.json`（`SessionIndexService`）只有标题和元数据，没有消息正文。最多 2000 条，已归档的会被前端过滤掉。
- **正文在哪**，每个引擎各一种格式：
  - Pi（DSH）：`<dshHome>/sessions/.../session.v4.jsonl.zstd`，是 zstd 压缩的事件日志，只有 DSH 宿主能解开（`readPage`）。存根经过回退或分叉后，会指向新的子会话。
  - Claude：`<appStateRoot>/claude/projects/<cwd>/<id>.jsonl`，是 CLI 自己的 JSONL。Main 可以直接读，现在只有 SDK 宿主在解析。
  - 旧版 pi：Main 自己能解（`SessionReplayReader`）。
- **现有检索**：没有任何按消息正文的检索。sqlite3 已经是依赖，目前只用来只读打开 VS Code 的 `state.vscdb`。
- **跳转**：时间线只为每个回合挂了锚点 `data-turn-id`，工具行另有 `data-tool-call-id`；助手消息本身没有锚点。可复用的有：
  - `PromptNavRail.jumpTo`：按几何位置滚动时间线的视口；
  - `locateToolRow`：先展开折叠组，再 `scrollIntoView`，并用 `data-located` 高亮；
  - 「改动」面板的定位请求：一个 store，用 `seq` 区分每次请求。
- **历史分页**：默认只加载最近 80 条消息。命中的消息更早时，要先往前加载历史，再滚动过去。
- **搜索入口**：`LeftDock` 在没有工作区时会禁用「搜索」。改成对话搜索之后，入口要一直可用，只禁用「文件」「内容」两页。

## 3 方案

1. **索引在 Main**，独立一个服务 `ChatSearchIndex`，存 sqlite3 库 `<userData>/chat-search.db`：
   - 每条消息一行（会话 id、消息键、角色、正文、时间），全文表用 FTS5 trigram 分词，中文也能按子串命中；
   - 查询不足 3 个字时走 `LIKE` 全表扫描；
   - 工具输出不入索引，只索引用户与助手的正文。
2. **取正文**：
   - Claude 会话：Main 直接读 JSONL，读文件走 `readFileTsdSafe`，见第 4 节。
   - Pi 会话：通过宿主 `readPage` 按页取投影后的历史，这样消息键和时间线用的 `h:<entryId>` 一致。
   - 旧版 pi 会话：用 `SessionReplayReader`。
3. **何时建索引**：
   - 会话结束时（`SessionIndexService.handleRuntimeEvent` 收到 `session.completed`）增量更新这一个会话；
   - 第一次打开对话搜索时，在后台补建所有未归档会话的索引；
   - 补建期间结果写「正在建立索引…」，不阻塞搜索。按 `updatedAt` 判断哪些会话需要重建。
4. **查询接口**：`chatSearch.query({ text, scope: 'all' | workspacePath, limit })`：
   - 按会话聚合，每个会话带首个命中的片段（前后截取）、命中条数和全部命中的消息键；
   - 排序先看标题是否命中，再看最近更新时间。
5. **界面**：
   - `GlobalSearchDialog` 增加「对话」页，作为默认页；
   - 范围菜单可选「全部仓库 / 当前仓库」；
   - 空输入时列出最近的对话。
6. **跳转**：
   - 发出跳转请求（store，用 `seq` 区分每次请求），打开会话；
   - 等时间线就绪，如果命中的消息不在已加载的页里，就往前加载历史；
   - 滚到命中的消息并闪一下，消息上要新挂一个锚点 `data-message-id`；
   - 查找条只在这个会话的命中之间跳。

## 4 风险

- **加密机**：Main（Electron）写的 `.db` 会不会被加密、读回来是不是明文，都还没实测过。
  - 对策：打开库失败、或者文件头是 `%TSD-Header-###%` 时，删掉重建，必要时退到内存库。反正索引只是缓存，丢了可以重建。
  - 读 Claude 的 JSONL 走 `readFileTsdSafe`。
  - 最后上加密机实测一次，和 CI 结果分开记。
- **补建索引要拉起 Pi 宿主**：会话多时耗时长。
  - 对策：补建限速，每次一页；只补未归档的会话；宿主正忙时让路。
- **sqlite3 构建是否带 FTS5 trigram**：阶段 1 第一步先验证。不带的话退到普通表加 `LIKE`，2000 个会话的规模也够用。

## 5 分工（两队并行）

| | A 队：索引与查询（Main） | B 队：界面与跳转（renderer） |
|---|---|---|
| 拥有的文件 | `src/main/services/chatSearch/**`、`src/main/ipc/chatSearch.ts`、`SessionIndexService` 里的事件挂钩 | `src/renderer/components/search/**`、时间线锚点与跳转（`src/renderer/components/chat/**` 里的相关文件）、新的跳转 store |
| 共享的接缝 | `src/shared/types/chatSearch.ts`：A 队先写好、B 队只读；`src/shared/types/ipc.ts` 与 `src/preload/index.ts` 两队都只在末尾追加；`src/shared/i18n.ts` 同样只追加 | 同左 |
| 先后顺序 | 阶段 1 → 2 | 阶段 3 可以先用假的 IPC 开工；阶段 4 依赖阶段 3 |

两队之间只靠 `chatSearch.ts` 的类型对接，B 队不用等 A 队完成。
