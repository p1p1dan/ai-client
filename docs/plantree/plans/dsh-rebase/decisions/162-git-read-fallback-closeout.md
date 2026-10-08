# 决策 162：git 回退收尾——其余读取、读失败不再显示成空、大文件 diff 与提交核对

日期：2026-10-08。**状态：自主决定，待用户审批。** 用户要求「接着做」[决策 161](161-git-read-fallback-shared.md) 第 5 节列出的未覆盖项。沿用 161 的机制（每个读取声明 `lostWhen`，非零退出不算丢失，回退成功一次后进程内读取走 runner，WSL 除外）。

## 1 改了什么

1. **读文件内容（diff、冲突、提交 diff）失败不再吞成空**：改前 `encoding.ts` 的 `gitShowBuffer` 与 `getCommitDiff` 的 `showOrEmpty` 一律把失败当空，超限、超时、丢输出都让界面显示成「空 / 新增 / 删除」。现在只有 git 非零退出（路径或版本不存在）回空；过大抛 `GIT_BLOB_TOO_LARGE`，超时抛 `GIT_BLOB_READ_TIMEOUT`，其余原样抛出；DiffViewer 在「无法加载差异」下显示原因。
2. **AI 生成提交信息、代码审查**：改前 execSync 拼字符串，失败回空串，加密机上把空 diff 发给模型。现在走 `readGit`，「真的没有改动」由 `diff --cached --quiet` / `diff HEAD --quiet` 退出码判定；两条路径都读不到时报错。
3. **commit 返回的 hash**：提交前后各读一次 `rev-parse --verify HEAD`；HEAD 没动就报错；读不回时保留 commit 自己的结果。
4. **discard**：改前用 simple-git 的 `status().not_added`，丢输出时等于「没有未跟踪文件」。现在复用 porcelain v2 状态读取并做目录前缀匹配；状态读不出来就失败，不碰文件。`discardSubmodule` 同。
5. **WorktreeService**：合并前 clean 检查、`getConflicts` 走 `GitService.getStatus`；`getMergeState` 的 MERGE_HEAD 用退出码探针，合并中冲突列表读不出来报错（不再说「不在合并中」）；合并后 commitHash 读回 HEAD。
6. **`origin/HEAD`、子模块读取、文件树 ignored 标记**：新 `checkIgnore.ts`（退出码 1 = 都没被忽略；加 `-c core.quotePath=false` 与 `--`，修掉中文路径被转义后永远匹配不上的原有问题）。
7. **远程端** `RemoteServerSource.ts` 的 `parseFileChanges` / `parsePorcelainStatus`：修路径含空格只取最后一个词、改名方向反。
8. **渲染层**：变更列表、提交历史、提交文件读失败时显示 `Alert` 错误行（上次成功的数据保留在下面），只有没错误时才显示「没有更改 / 暂无提交记录」；聊天栏分支按钮在不知道当前分支且 worktree 列表读失败时显示「读取当前分支失败」。6 个 i18n 词条。
9. **其他**：同时在跑的相同 runner 读取共用一次 node.exe（`shareRunnerRead`，只在运行期间共用、不缓存）；git 工作目录不存在时报 `GIT_WORKDIR_MISSING`，不再显示像没装 git 的 `spawn git ENOENT`。

## 2 自主决定

1. **blob 读到空的判定按 git 非零退出**，不看提示文字（本地化 git 下不可靠），不多跑 `cat-file -e` 探针。
2. **blob 上限 32 MB，主路径与 runner 一致**。普通机器上超过 32 MB 的文件 diff 也改为提示「过大」。替代：只限 runner（两类机器不一致）或调大 runner 缓冲（吃内存）。
3. **blob 超时 120 s**（cc4f1f48 之前没有，161 引入 30 s）。仍防 git 永不退出，又给加密盘留余量。
4. **过大 / 超时用带 `GIT_BLOB_*:` 前缀的错误消息**（能穿过 IPC 包装），渲染层识别前缀翻译。替代：给 `FileDiff` 加字段（要改共享类型）。
5. `getCommitDiff` 改用 gitShow：解码从固定 UTF-8 改为自动识别，与工作区 diff 一致。
6. `getDiffStats` 只有 git 非零退出回 0，其余抛错（渲染层原有 catch，界面不变）。
7. blame 两条路径都映射成 `git blame failed: <stderr>`；`NodeGitRunnerError` 加 `stderr` 字段。
8. **commit 前后读 HEAD**（每次提交多 2 个进程）：HEAD 没动就报错——普通机器上 simple-git 原本当成功的「nothing to commit」也变成「提交失败」。返回值优先 simple-git 的短 hash，取不到用读回的完整 hash。
9. **discard**：状态被截断时没列到的路径按「已跟踪」处理（git 拒绝恢复，不会误删）；未跟踪目录仍用 unlink，与改前一样会失败，没扩成递归删除。
10. WorktreeService 的 sourceBranch 仍是尽力而为，读不到留空。
11. **子模块**：`submodule status` 只在 `.gitmodules` 非空时判丢失（`.gitmodules` 过期时普通机器会白跑一次 runner 并多两行 warn）；`listSubmodules` 读不出来抛错，不再返回 []；子模块变更列表也跳过 node_modules 等目录；unstagedCount 中未跟踪目录按一个条目计。
12. check-ignore 独立成模块；files.ts 里读失败仍静默（没有 ignored 标记），与改前一样。
13. **AI 读取**：每次生成多一个探针进程；超时 5 s / 10 s 统一改 30 s；读不到时报错，不再拿空内容请求模型；去掉 `--no-pager` 与 shell 拼接。
14. **远程端移植规则而不共用代码**：远程脚本是独立的字符串，`Function.toString` 注入会被打包器改名。`u` 记录只算冲突，与本地一致；远程端没加跳过 node_modules 与条目上限。脚本 sha256 变化，已安装的远程端按 `helperSourceSha256` 机制重装。
15. **不加并发上限**（实测单仓库峰值与 cc4f1f48 之前同量级：打开仓库主路径峰值 5、每 5 s 轮询 4 次峰值 3；simple-git 的 3 并发是按实例算的）。现场若有内存压力，再给 runner 加全进程上限（如 4）。
16. **减少 node.exe 只做了共享同时在跑的相同读取**（runner 路径每轮 4 → 3）。只写建议、没做：head signature 两次读取合一；Git 面板当前分支改从 file-changes 的 `# branch.head` 取；切到 runner 后放慢轮询。
17. 目录不存在只在出错时才检查（平时不多一次 stat）；错误码 `GIT_WORKDIR_MISSING`。

## 3 验证

代理：git 目录 183 例、`src/main/services/ai` 20 例、`src/main/services/remote` 5 例、`src/main/ipc` 229 例、workspace-shell 与 source-control 823 例、hooks / 聊天分支与 composer / files 327 例、Static / Scan / Wiring 764 例、shared 446 例、根 `pnpm typecheck`、改动文件 biome。测试不拉起真实 node（runner 一律 mock），真实 git 只在临时仓库。独立审查与编排者复跑见第 5 节。

## 4 加密机复测

- 有暂存改动时生成提交信息不是「(no staged changes detected)」；代码审查能拿到 diff；提交后历史出现新提交；丢弃未跟踪文件能删掉；被 .gitignore 的条目（含中文名）变灰；超过 32 MB 的 diff 显示「文件过大」；读失败时面板与分支按钮显示错误行。
- 日志搜 `[git-fallback]`；新增种类 check-ignore、submodule、config、diff、log、symbolic-ref、rev-parse、show、blame；`commit reported success but HEAD could not be read back`。

仍未覆盖：`commitSubmodule` 返回的 hash（子模块界面已没有）；`gh pr list` / `gh auth`（不是 git，但同样由 Main 拉起，stdout 可能也丢）；check-ignore 目录条目特别多时可能超出 Windows 命令行长度（与改前一样静默）。

## 5 独立审查与编排者复核

独立审查（只读，另一个代理，在临时仓库实测）查出 6 条，全部已修（修复代理一个；原收尾代理两次因 API 断线中途停下，换新代理接手）：

1. **中：discard 路径穿越**。前缀匹配用调用方原始路径，`discard(['newdir/../.env'])` 在 `newdir/` 未跟踪时删掉被忽略的 `.env`；`discardSubmodule` 没有穿越检查；POSIX 上把 `\` 当分隔符会删掉已跟踪的 `dir\x.txt`。只有构造的 IPC 参数能触发，但这是唯一的破坏性入口。
2. **中：`shareRunnerRead` 让写之后的读复用写之前的结果**。加密机上 status 轮询在飞时 add + commit，随后放弃已跟踪文件会把它当未跟踪删掉；commit 的 after 读撞上并发同名读误报「HEAD did not move」。
3. **中：discard 的 status 有 5000 条上限**（普通机器上的回归）：变更列表跳过 build/ 等前缀而 status 不跳，列表里显示的未跟踪文件删不掉。
4. 低：`.gitmodules` 过期（index 里没有 gitlink）时 `listSubmodules` 被误判丢失，自动 fetch 每轮白起一次 node.exe。
5. 低：最近提交都没有标题时生成提交信息失败。
6. 低：生成提交信息时主路径无上限读暂存 diff。

修法与新增的自主决定：

1. **discard 改用专用读取** `status --porcelain=v2 --branch -z --untracked-files=all -- <paths>`，按精确名字判定未跟踪，彻底不做前缀匹配；不设条数上限；`share: false`；pathspec 总长超过 8000 字符时退回不带 pathspec 的整份 `-uall` 读取（Windows 命令行上限 32767，经 runner 时参数在 node 与 git 命令行各出现一次）。
2. **`resolveDiscardTarget`**：原始输入含 `..` 段、解析后跳出根目录、或等于根目录本身（`.`、`''`，原来会变成 `git checkout -- .` 全部还原）一律拒绝，在读状态之前就拒；只在 win32 上把 `\` 当分隔符；交给 checkout 的是规范化后的 git 名。`discardSubmodule` 共用同一套并补穿越检查；子模块原有的递归删除只在 git 自己把它整项列成未跟踪目录（嵌套仓库）时发生，主仓库仍只 unlink。
3. **写操作前后的读一律 `share: false`**：discard 的状态、`readHeadCommit`（commit 前后、合并后读回）、`confirmHeadOnBranch`、WorktreeService 合并流程里的 worktree 列表（决定合并哪个分支，超出审查列出的范围）、干净检查与冲突检查。公开的 `getConflicts` / `getMergeState` 与轮询仍共用。改正了 `shareRunnerRead` 的注释。
4. **子模块**：输出为空、`.gitmodules` 非空、且 index 里确有其中某个 path（`rev-parse --verify --quiet :0:<path>` 退出码，不区分 gitlink 与普通文件）时才判丢失。
5. **提交信息读历史改 `--format=%h %s` 再去掉 hash**（成功必有输出，仍能判丢失），不用 `'never'`（加密机上历史丢失会被静默当成「没有提交」）。
6. **暂存 diff 上限 8 MB**（两条路径一致），超限时只用 `--stat` 生成。

审查核过没有问题的：commit 的首次提交、post-commit 钩子 amend、无内容可提交、调用方不用返回值；超时 / 信号 / 超限不会误开进程级开关；共享键含 encoding、workdir、args、timeout、maxBytes；`getMergeState` / `getConflicts` 不在合并中时不报错；渲染层用 coss `Alert`、错误恢复后错误行消失、词条中英齐全、`useWorktreeListFailure` 不发新请求。

验证：
- 修复代理：git 目录 193 例、ai 23 例、ipc 229 例、Static / Scan / Wiring 764 例、shared 446 例、根 `pnpm typecheck`、biome；临时把三处修复改回旧行为，对应新测试都失败。
- 编排者复跑：git + ai + remote 13 个文件 221 例、根 `pnpm typecheck`。

## 6 遗留（未修）

- 远程脚本 `REMOTE_SERVER_VERSION` 仍是 `0.4.0`：连接时的快速路径直接运行远端已装好的 server.js，`daemon:ping` 不校验 `helperSourceSha256`，所以远程端 `parseFileChanges` 的修复要等用户手动「更新运行时」或快速路径失败后才生效（好处是不打断已连接会话；`8aafd450` 也没升）。
- discard 的 checkout / status pathspec 是 glob 语义（改前就有）：文件名含 `*`、`?`、`[` 时 checkout 可能多还原别的文件；建议加 `--literal-pathspecs`。以 `:` 开头的文件名会被当成 pathspec 魔法（报错，不删东西）。
- Windows 上「全部放弃」5000 多条时，`git checkout -- <全部路径>` 本身仍可能超出命令行长度（改前就有）。
- 未跟踪目录整项放弃仍报 EISDIR、什么都不删（改前就有；不要改成递归删除，会连带删掉其中被忽略的文件）。
- `getDiffStats` 改为抛错后渲染层回落 0/0，但 Electron 每次记一条 handler 报错日志。
