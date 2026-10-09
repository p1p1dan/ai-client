# 决策 163：恢复对话时按「是不是同一个目录」比较工作区，cwd 以索引为准

日期：2026-10-09。**状态：自主决定，待用户审批。**

来源：GitHub issue #1「升级到 dsh.7 后旧对话『读取历史失败』：同一目录的 `E:\` 与 `E:/` 写法被判为工作区不一致」。加密机上 dsh.6 建的对话升级到 `1.1.0-dsh.7` 后打不开，报 `pi_session_workspace_mismatch: Indexed workspace does not match the resume request`，点重试没用；数据没有丢。代码提交：待编排者提交。

## 1 根因

Main 恢复对话时把索引行的工作区和渲染层发来的工作区**逐字比较**（`src/main/ipc/chat.ts` 恢复入口的 `row.workspacePath !== payload.workspacePath`），而同一个目录在几处写法不同：

1. **渲染层的工作区路径会随 git 有没有读到而变**：`deriveChatWorkspaceTree.ts` 的主工作区原来是 `mainWt?.path ?? repo.path`。worktree 列表读到时用 git 的输出（Windows 上是 `E:/x`），读不到时用登记的仓库路径（`E:\x`）。dsh.6 在加密机上读不到列表（F3），对话记成 `E:\x`；dsh.7 补了 `node.exe` 回退后读到了，恢复请求发 `E:/x`，被拒。
2. **Main 自己也会改写法**：`WorkerManager.resumeSession` 用 `normalizeWorkerPath` 规范化 cwd（反斜杠、盘符大写），`commitResumed` 把规范化后的 cwd 写回索引。
3. **另外几类行的写法本来就可能与渲染层不同**：分叉出的对话，行里记的是源会话规范化后的 cwd（`WorkerManager` 的 `createForked`）；从 Claude Code / Codex 导入的对话，行里记的是对方日志里的原样路径（`LegacyImportService.resolveWorkspace`）；linked worktree（`kind: 'worktree'`）在渲染层只有 git 的写法。
4. **错误卡片还给了一个没用的重试**：渲染层 `historyError.ts` 不认识 `pi_session_workspace_mismatch`，落到可重试的 `read_failed`（「读取历史失败」）。重试发的是同一个路径，只会再失败一次，这就是 issue 里「点重试没用」的原因。
5. 侧栏分组用 `canonicalPathKey` 比较，所以对话仍显示在原项目下，只有恢复这一步逐字比较。DSH 桥自己的 `samePath` 先 `resolve` 再在 win32 上忽略大小写，不会在这里拦下。

**什么时候会走到这个比较**：点开一个没有 worker 的对话，先走只读预览（`activateSessionStart.ts` 的 `runSessionActivation` → `chat.readSessionPage`，不校验工作区）；只有预览失败、会话已绑定宿主（`hostBound`）、在历史卡片上点重试、或者**发消息**时（`ChatComposer.tsx` 发送前的恢复，以及 `session_not_found` 后的重新打开；cwd 来自 `composerTarget.ts` 的 `resolveActiveTarget`）才调 `chat:resumeSession`。所以在普通机器上，症状多半出现在发消息时；加密机上预览先失败了，于是一点开就报错。加密机上预览为什么失败是待查项（见第 7 节）。

**普通 Windows 机器上的影响，按代码推断，未复现**：git 仓库根目录下的主工作区，要看恢复发生在 worktree 列表加载之前还是之后，路径可能是 `E:\x` 也可能是 `E:/x`，能不能对上不确定。linked worktree 下的对话、分叉出的对话、导入的对话，以及至少恢复过一次的 1.0.x pi 对话，因为行里的写法已被规范化或本来就是原样路径，会在第一次或第二次冷启动后恢复时对不上。

## 2 决定

1. **新增 `sameWorkerDirectory(a, b)`**（`src/main/services/agent-host/workerSessionKey.ts`）：逐字相同直接算同一目录；否则两边各算一个目录标识再比较。标识建立在已有的 `normalizedWorkerPathIdentity` 上（worker 键也用它）：
   - 按**路径本身的写法**判断风格，不看宿主平台：带盘符或 UNC（`\\` / `//` 开头）的按 Windows 规范化，分隔符统一、忽略大小写；其余按 POSIX 规范化，**区分大小写**。两边都消掉 `.`、`..` 与重复分隔符。
   - 末尾分隔符手工去掉（`path.win32.normalize` / `path.posix.normalize` 都会保留它），根保留：`C:\`、`/`、`\\srv\share\`。
   - 空串、相对路径算不相同，不抛异常。
   - 只做字面比较，不访问磁盘：`\\?\` 前缀、8.3 短名、junction、`subst` 盘符都不折叠。
2. **不用 `canonicalPathKey`**：它在所有平台都转小写，Linux 上 `/repo` 和 `/Repo` 是两个目录，却会被当成同一个；它也不处理 `.` / `..`。它是渲染层与工作区 ID 共用的比较键，改它的大小写语义会改动工作区 ID（见其注释）。Main 这边已有按路径风格区分大小写的 `normalizedWorkerPathIdentity`，与 worker 键同一套口径，所以在它上面加一层。
3. **恢复入口**（`chat.ts`）：`!sameWorkerDirectory(row.workspacePath, payload.workspacePath)` 时抛**原样的** `pi_session_workspace_mismatch` 错误。通过之后，后面的一切都用**索引行的写法**作 cwd：临时目录识别与 `adopt`、旧 pi 行迁移（`prepareResume` 的 cwd）、`adoptTempWorkspace`、`WorkerManager.resumeSession` 与它的进行中去重指纹。理由：索引行是 Main 自己写下的，渲染层的路径只是一个声明，用来校验。DSH stub 里的 cwd 写法取决于会话怎么来的：新建、分叉是规范化后的写法；迁移（`LegacyMigrationService` 传给宿主的 cwd）、导入（`DshLegacyImportHost` 的 `cwd: conversation.workspacePath` → seed）是原样写法。宿主打开时用自己的 `samePath` 比较，分隔符与大小写差异不影响。
4. **渲染层把 `pi_session_workspace_mismatch` 映射到已有的 `session_cwd_mismatch`**（`historyError.ts`）：不可重试的「会话属于另一个工作区」卡片，沿用已有文案，不加 i18n。真正不同的目录不再给一个只会再失败的重试。
5. **`SessionIndexService.removeUncommittedCreated`**（建会话失败后收回空壳行）：「工作区已经变了就不删」的判据改用 `sameWorkerDirectory`。写法不同不算搬家。
6. **渲染层固定主工作区路径**（`deriveChatWorkspaceTree.ts`），**属于可选的加固**：只改 Main（第 1、3 条）就能修好 #1；这一条若现场点验出现回归，可以单独撤回。
   - 本地仓库的主工作区路径一律用登记的 `repo.path`，分支仍取自 git 的 main 条目；远程仓库保持 `mainWt?.path ?? repo.path`。走到这里时，登记路径与 git 列出的根已经是同一个 `canonicalPathKey`，不一致的情况在前面的 linked worktree / 子目录分支里已经提前返回，所以换写法不改变指向哪个目录。linked worktree 没有登记写法，仍用 git 的路径。
   - 工作区 ID：`workspaceIdFor` 统一分隔符并转小写，但**不去末尾分隔符**。所以只有 `repo.path` 带末尾分隔符时，列表已加载情况下的 ID 会变一次（与列表没加载时的 ID 一致）；`chatSessions` 的工作区树不持久化，重新派生即可。
   - 跳过「与主工作区同目录的条目」的比较改为两边都用 `canonicalPathKey`（原来不去末尾分隔符）。
   - **副作用与配套修改**：Windows 上 git 根目录项目的工作区根从此是反斜杠写法，而 Main 列出的文件路径本来就是反斜杠拼接（`src/main/ipc/files.ts` 的 `join`）。几处「`startsWith(rootPath)` 再 `.replace(/^\//, '')`」的写法会得到 `\src\a.ts`：blame 拿它调 git，面包屑显示成一整段。改为共用新的纯函数 `relativeToRoot(root, target)`（`src/shared/utils/path.ts`，同时导出 `isWindowsStylePath`）：Windows 写法的根两种分隔符都认、不分大小写，其余逐字比较（POSIX 区分大小写）；返回目标路径自己写法的剩余部分（去掉开头分隔符，根本身返回 `''`），不在根下返回 `null`。调用方：`useEditorBlame.ts`（再转成 `/` 交给 git）、`EditorArea.tsx` 面包屑（转成 `/` 再切段）、`useFileTree.ts` 的 `revealFile`（父目录从文件路径本身截取，与树节点写法一致；该函数目前没有调用方）、`FileTree.tsx` 复制相对路径（保留原分隔符）、`EditorLineComment.tsx` 发到终端的相对路径（保留原分隔符）。改前这些地方在 Windows 上本来也有问题（根是 `E:/x` 时匹配不上，根是 `E:\x` 时多一个开头反斜杠），这次一并修掉。`EditorArea.getRelativePath` 与 `editorDefinitionProvider.relativePath` 原本就不受分隔符影响，没动。
7. **不迁移、不改写已有索引行**：两种写法都能恢复，没必要动旧版本也会读的 `session-index.json`。`commitResumed` 仍写规范化后的 cwd，行里的写法会从 `E:/x` 变成 `E:\x` 一次，现在无害。
8. 只改渲染层不够：dsh.7 期间新建的对话已经记成 `E:/x`，渲染层固定为 `E:\x` 之后，靠第 3 条放行。

## 3 边界情况

| 索引里的写法 | 恢复请求的写法 | 结果 |
|---|---|---|
| `E:\Projects\repo` | `E:/Projects/repo` | 同一目录，用索引写法恢复 |
| `E:/Projects/repo` | `E:\Projects\repo\` | 同一目录 |
| `e:/projects/Repo/` | `E:\Projects\repo` | 同一目录（Windows 写法不分大小写） |
| `E:\x` | `E:\y` | 拒绝，`pi_session_workspace_mismatch` → 不可重试的工作区卡片 |
| `/repo` | `/Repo` | 拒绝（POSIX 区分大小写，与运行平台无关） |
| `/repo/` | `/repo` | 同一目录 |
| `/a/./b/../repo` | `/a/repo` | 同一目录 |
| `C:\` | `C:/` | 同一目录（根保留） |
| `/` | `/` | 同一目录 |
| `\\srv\share\x` | `//srv/share/x/` | 同一目录 |
| `\\wsl.localhost\Ubuntu\home\a\repo` | 仅大小写不同 | 同一目录（与 `normalizedWorkerPathIdentity` / worker 键一致）；cwd 仍用索引写法 |
| `//` 开头的 POSIX 路径 | 任意 | 当作 UNC 处理（Windows 规则） |
| `\\?\E:\x` | `E:\x` | 拒绝（不折叠长路径前缀） |
| 8.3 短名、junction、`subst` 盘符 | 长名或目标路径 | 拒绝（只做字面比较） |
| 空串、相对路径 | 任意 | 拒绝，不抛异常；两边逐字相同时照旧放行 |
| 临时会话 `<scratch>`（`unbound`） | `<scratch>/` | 同一目录；`adopt` 与 worker 拿到的都是索引写法 |

## 4 刻意没改的逐字比较

- `WorkerManager.resumeSession` 热路径的 `entry.cwd !== cwd`：两边都是同一索引写法经 `normalizeWorkerPath` 的结果，本修复后不会因写法不同而触发。
- `WorkerManager` 校验宿主回传的树 / 历史页（`validateTreeResult`、`validateHistoryResult`）：宿主回传的就是我们传进去的 cwd，原样回声。
- `WorkerManager.getSlashCommands` 按 cwd 找同目录的就绪 worker：只影响斜杠命令菜单，不拦任何流程。
- `WorktreeService.getWorktreeBranch`：合并流程，传入的 linked worktree 路径本来就来自 git 列表，写法一致。
- `src/dsh-host` 的两个 `samePath`：桥里的（`dshSessionRuntime.ts`）先 `resolve` 再在 win32 上忽略大小写；`seedSession.ts` 里的不 `resolve`、不统一分隔符，同样的模式，但迁移 / 导入的重试现在拿到的是同一个索引写法，走不到不一致的情况。都不在本次范围。

## 5 验证

新增测试：

- `workerSessionKey.test.ts`：`sameWorkerDirectory` 覆盖第 3 节前十几行（双向）、空串与相对路径不抛异常、逐字相同放行。
- `chatPiWorkerRouting.test.ts`：反斜杠行 + 正斜杠请求能恢复，`resumeSession` 收到索引写法；反方向带末尾反斜杠同样；`E:\x` 对 `E:\y`、`/repo` 对 `/Repo` 被拒且 `resumeSession`、`prepareResume` 都没被调用；临时会话行 + 带末尾 `/` 的请求，`adopt` 与 `resumeSession` 都收到索引写法；旧 pi 行 `prepareResume` 收到索引写法。原有「不同目录被拒」用例保留。
- `SessionIndexService.test.ts`：记 `E:/ws/a`、按 `E:\ws\a\` 收回 → 删掉；记 `/ws/a`、按 `/ws/A` 收回 → 不删。
- `historyError.test.ts`：现场原文 `Error invoking remote method 'chat:resumeSession': Error: pi_session_workspace_mismatch: ...` → `session_cwd_mismatch`。
- `deriveChatWorkspaceTree.test.ts`：登记 `D:\Code\demo`，worktree 列表有内容 / 为空 / 没查过三种情况下主工作区路径都是 `D:\Code\demo`、ID 相同；列出时分支为 `main`；linked worktree 仍是 `D:/Code/demo-wt`；远程仓库行为不变。
- `src/shared/utils/__tests__/path.test.ts`：`relativeToRoot` 覆盖 `E:\x` 根 + `E:\x\src\a.ts`、`E:/x` 根 + `E:\x\src\a.ts`、POSIX 根与文件系统根、仅大小写不同（POSIX 区分）、根外返回 `null`、根本身返回 `''`；`isWindowsStylePath` 按写法判断。

本地跑过（2026-10-09，Linux 开发机，一次一条）：`workerSessionKey` 17 例 + `chatPiWorkerRouting` 70 例、`SessionIndexService` 58 例、`deriveChatWorkspaceTree` + `treeSyncPatch` 54 例、渲染层 `sessionIndex` 目录 + `composerTarget` 215 例、`historyError` 102 例、`chatReadSessionPage` 10 例、`chatMarkdownPolicy` 103 例、`path.test.ts` 12 例、受影响组件的测试（`useFileTree`、`editorPendingCursor`、`filesDeleteConfirm`、`errorBoundary`、`diffCenterTabsStatic`、`legacyShellAbsence`、`fontDomainScan`）7 个文件 48 例、`src/shared/__tests__` + `src/shared/utils` 34 个文件 506 例、Static / Scan / Wiring 75 个文件 764 例，全部通过；根 `pnpm typecheck`、改动文件 biome 通过。

## 6 现场验证

- 加密机：打开 dsh.6 建的对话（issue 里的「继续T2-3b」）与 dsh.7 建的对话（「1+1=」），历史正常显示，并**发一条消息**。
- 完全退出并重启两次，每次重启后在上面两个对话里**都发一条消息**，而不只是打开。
- linked worktree 项目下的对话、分叉出的对话、从 Claude Code / Codex 导入的对话：各发一条消息，重启后再发一条。
- 普通 Windows 机器：在 git 仓库根目录下继续一个 1.0.x 的 pi 对话（决策 050 的迁移要能走完）；git 仓库根目录下新建对话，重启两次后仍能发消息。
- Windows 上 git 根目录项目的渲染层点验（第 2 节第 6 条的副作用）：文件树、打开文件、面包屑（应分成多段）、blame、全局搜索、git 面板、分支下拉、复制相对路径。
- 日志里不应再出现 `pi_session_workspace_mismatch`；万一出现，界面应是「会话属于另一个工作区」卡片，没有重试按钮。侧栏同一项目下的对话分组不变，主工作区不会因 worktree 列表读到与否而重复或跳动。

## 7 待查

- 加密机上点开对话时只读预览为什么会失败（因此每次点开都走了恢复）。修复后，这些点开会每次都拉起一个 worker；要看是不是预览读取在加密机上本身有问题。
