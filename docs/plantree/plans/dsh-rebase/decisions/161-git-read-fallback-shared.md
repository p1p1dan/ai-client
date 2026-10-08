# 决策 161：git 读取共用「丢输出判定 + node.exe 回退」，补齐切分支、变更列表、提交历史

日期：2026-10-08。**状态：自主决定，待用户审批。**

来源：用户在 `1.1.0-dsh.6`（加密机）上反馈：聊天栏与左侧 git 页能显示分支了，但选择分支后没有反应，显示「没有修改」「暂无提交记录」。代码提交 `cc4f1f48`（`fix(git)`）。前序：`acfe0a4e`（Windows 端，getBranches / getStatus 回退）、`a065c849`（复核修复）。

## 1 根因

三个现象同一个原因：加密机上由 Main 直接拉起的 git 退出码为 0、stderr 正常，stdout 收不到；dsh.6 只给 `getStatus` 与 `getBranches` 加了回退。

1. **切分支「没有反应」**：两个入口（聊天栏 `BranchColumn`、左侧 `GitBranchControl`）共用 `useGitCheckout` → `GitService.checkout`，checkout 本身大概率执行了。但聊天栏显示的当前分支来自 `ChatWorkspace.branch` ← `deriveChatWorkspaceTree` ← `WorktreeService.list`（`git worktree list`），这条没有回退，得到 0 个 worktree、当前分支为 null，按钮一直是「选择分支」。另：simple-git 把「非零退出且 stderr 为空」当成功，静默失败的 checkout 也会像成功。
2. **「没有修改」**：由 `getFileChanges` 决定（不是 `getStatus`）。它能识别丢输出并抛错，但没有回退；渲染层 query 出错时 data 为 undefined，`partitionFileChanges` 当成空。
3. **「暂无提交记录」**：`getLog` 把空输出解析成 0 条，不报错。`getCommitFiles` 同样为空。

普通机器上没有回归：三条链路的渲染层与 preload 相对 main 未改。

## 2 决定

1. **一处共用的读取函数** `gitReadFallback.ts`（`readGit` / `readGitBuffer`），每个读取自己声明何时算丢失：`'empty'`（成功必有输出：worktree list、`cat-file -p`、log 第一页、`rev-parse HEAD`）、`'never'`（空是合法答案：空 blob、无 diff、翻过最后一页）、或判断函数。**非零退出一律不算丢失**（那是 git 自己的答复）。替代方案：每个方法各补一份——没采用。
2. **回退成功过一次后，本进程之后的读取直接走 runner**（WSL 除外，wsl.exe 不经 runner）。理由：`'never'` 类读取的空答案本身判断不了是否丢失，只有改道才在加密机上读对；也省掉每次轮询必丢的那次主路径，顺带去掉此前「每 5 秒写 2 行 warn」。开关只在「主路径丢了且 runner 拿到」时打开；普通机器不会触发。开关不复位（若之后 runner 失效，读取会一直失败到重启），属设计取舍。
3. **日志**：前缀 `[git-fallback]`；成功每种读取只记一次（info），失败每次都记（warn）。
4. **读取主路径从 simple-git 改为 `spawnGit` 并保留退出码**（参数、env、cwd、`windowsHide` 与 simple-git 等价，审查对照 simple-git 3.30 源码核过）。被改读取的错误类型变为 `GitCommandError`，消息仍是 stderr；全仓无调用方按 `GitError` 类型或这些读取的错误文本判断。
5. **只看退出码的问题不经 runner**：`rev-parse --verify --quiet HEAD`、`show-ref --verify --quiet`。依据：现场能拿到 `fatal: not a git repository`，dsh.6 的分支回退也是靠退出码触发的。
6. **写操作不经 node.exe**：退出码与 stderr 都能回来。checkout / createBranch 之后读回 `symbolic-ref --quiet HEAD` 核对：只有确实读到 HEAD 在别处才报错；读不回来时以 checkout 自己的结果为准；目标不是本地分支（提交、tag、游离 HEAD 条目）不核对。
7. **getFileChanges 共用 porcelain v2 `-z` 解析器**（`PorcelainV2FileChangesAccumulator`），修掉原有的「路径含空格只取最后一个词」「改名 path / originalPath 对调」（渲染层不读 `originalPath`）。截断语义细微变化：只有真丢掉记录才标截断，恰好 5000 条不再标。
8. **worktree list 两条路都丢时抛错**，不再返回空列表（与 Q7 一致）；输出非空但解析不出时仍按原做法记 error 并返回空。
9. **getLog 判「无提交」不只认英文报错**：`rev-parse --verify --quiet HEAD` 退出码 1 才算无提交，非仓库（128）照常抛错，避免中文 git 下误判。
10. **流式 status 改用 StringDecoder**，修掉按块解码 UTF-8 时中文路径可能被截坏的原有问题。
11. **getHeadSignature 只把 git 的非零退出当作无提交**；丢输出或 runner 失败照常抛出。
12. **被外部信号杀掉的 `git status` 报错**（独立审查第 1 条，编排者修）：原判据 `code && code !== 0` 在 `code === null` 时为假，表头前被杀会被当成丢输出、走回退并打开进程级开关（普通 Linux 上被 OOM killer 或 `pkill git` 即可触发），表头后被杀会把半截结果当成功。现在：我方因截断发的 SIGTERM 照旧算成功；其余 `code === null` 报「terminated by <signal>」，不触发回退。补 2 例测试。

## 3 验证

- 代理：git 目录 129 例、`src/main/ipc` 225 例、workspace-shell 与 source-control 814 例、git 相关 hooks / chat 280 例、Static / Scan / Wiring 764 例、shared 446 例、`pnpm typecheck`、lint。
- 独立审查（只读，另一个代理）：普通机器上主路径与改前等价；空仓库 / 游离 HEAD / bare / 非仓库、含 `/` 的分支、远程检出、别的 worktree 已检出的分支逐项核过；1 条中低（第 2 节第 12 条，已修）、2 条低（大 blob 静默变空、测试缺口，转决策 162 的收尾批）。
- 编排者修第 12 条后复跑：git 目录 9 个文件 131 例、Static / Scan / Wiring + shared 104 个文件 1181 例、根 `pnpm typecheck`、改动文件 biome。

## 4 加密机复测

- 聊天栏分支按钮显示真实分支名，切换后会变；左侧 git 页列出变更、diff 两侧有内容；提交历史有内容、能翻页、展开能看到文件。
- 日志目录 `aiclient-YYYY-MM-DD.log` 搜 `[git-fallback]`：`output lost; retrying via node runner`（发现丢失）、`node runner recovered lost <what> output; git reads go through the node runner from now on`（改道，每进程一次）、`<what> via node runner ok`、`via node runner failed` / `lost its output too`（回退也失败）。`[worktree:list] parsed 0 worktrees` 不应再出现。
- 前提假设：主路径丢输出时 git 退出码为 0。若日志出现 `git log failed (exit N)` 而不是 `output lost`，假设不成立，要回来再看。

## 5 本批未覆盖（转决策 162）

AI 提交信息与代码审查读的 diff、commit 返回的 hash、discard 读的 status、合并前 clean 检查 / 冲突列表 / 合并状态、子模块读取、`origin/HEAD`、文件树 check-ignore；远程端 `parseFileChanges` 的同类解析错误；渲染层出错时显示成「没有更改 / 暂无提交记录」；大 blob 静默变空与新增的 30 s 超时；读取不再受 simple-git 每实例 3 并发限流；开关打开后每次读取多一个 node.exe。
