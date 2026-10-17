# 决策 191：DSH 全自动档少问人：解析不了的参数放行，只问危险命令和写明了工作区外路径的命令

日期：2026-10-17（UTC+8）。**第 6 节是用户对第 5 节的裁决与落地（同日，分支 `claude/s6-feedback`）。** **状态：第 1 节是用户裁决（[路线 B README 裁决 27](../../claude-sdk-engine/README.md)，[S-6 反馈清单](../../claude-sdk-engine/topics/s6-feedback.md)第 11c 条，GitHub issue #19）；第 2 节起是按裁决落地时的自主决定，待用户审批，第 5 节列出要用户定的事。** 分支 `ccv/s6-parallel`。

## 1 用户裁决（2026-10-17）

DSH 引擎的「全自动」档改进，不去掉：**工作区内解析不了参数的命令也放行，只有删除、强推这类危险命令和明确碰到工作区外的路径才问**。

背景：全自动下最常见的询问来自命令里解析不了的部分（变量、命令替换、循环、PowerShell 的脚本块与 `$_`、`python x.py` 这类解释器），日常命令老是要人点，任务没法放手跑（用户 2026-10-17 补充：有人反馈 DSH 开了全自动仍有大量授权中断，可以向 Claude SDK 学）。

## 2 改法（`src/shared/permissions/`）

1. **全自动下的 shell 命令（`bash`、`pwsh`）只在两种情况下问**（`gate.ts` 的 `autoStillAsks`），其余一律放行，包括解析不了的参数：
   1. **危险命令**（新文件 `dangerousCommands.ts`，按分析器给出的每段命令判断，先剥掉 `sudo`、`env`、`xargs`、`timeout`、`bash -c`、`cmd /c`、`pwsh -Command` 这类只是转手执行的前缀）：
      - 递归删除：`rm -r`/`-R`/`-rf`/`--recursive`，`Remove-Item -Recurse`（及其缩写，`rm`、`del`、`rd`、`ri` 等别名），`del /s`、`rd /s`、`rmdir /s`，`find … -delete`，`find … -exec` 后面跟的命令同样判断；
      - git：`push` 带 `-f`/`--force`/`--force-with-lease`/`--force-if-includes`/`--mirror`/`--delete`/`-d` 或 `+`、`:` 开头的引用；`reset --hard`；`clean -f`；`checkout -f` 或整树（`.`、`:/`）；`restore` 整树（只 `--staged` 的除外）；`branch -D`（或 `-d` 加 `--force`）；`stash drop`、`stash clear`；
      - 磁盘：`format`、`mkfs`、`mkfs.*`、`wipefs`、`diskpart`、`Format-Volume`、`Clear-Disk`。

      危险 git 命令的范围参照了 Claude Code 对破坏性 git 操作的处理（强推、硬重置、整树 checkout/restore、`clean -f`、`branch -D`）。单个文件的删除（`rm a.txt`、`Remove-Item a.txt`）不在内：全自动下改写文件本来就不问。
   2. **命令写明了工作区外的路径**：命令里的路径或 `workdir` 落在工作区（及其别的写法，决策 134）之外。设备（`/dev/null`、`/dev/stdout` 等，Git Bash 在 Windows 上写成 `\dev\null`）不算。
2. **「写明」的口径**：只经环境变量得到的路径算参数，与解析不了的参数同等对待，不因在工作区外而问。包括 `$HOME`、`$env:TEMP`、`$PWD`（`cd` 到环境变量之后）、`cd "$DIR"` 之后的相对路径。命令里写出来的都算写明：绝对路径、`~`、`..`、同一行里用字面值赋值的变量（`T=/etc; cat $T/x`）、`cd` 到字面路径之后的相对路径、不带参数的 `cd`。
   - 两个分析器（`bashWalker.ts`、`pwshAnalysis.ts`）各自记下哪些路径来自环境变量，新字段 `parameterPaths`；`checkShellPaths` 把它带过通配符展开与规范化（同一个文件既经变量又被写明时算写明）；`authorizeTarget` 把它放进 `ToolPermissionRequest.parameterPaths`。
   - 理由：说明要求 `echo $HOME` 不问，而分析器会用环境把 `$HOME` 展开成家目录；按「解析出来在工作区外就问」，它会问。把环境变量当参数，`echo $HOME`、`cat "$HOME/notes"` 都不问；`cat /etc/hosts`、`ls ~`、`cd /tmp && …` 照样问。
3. **不变的**：
   - 所有 deny（策略、内置敏感文件、deny 范围、计划模式、工具白名单）的顺序与效果；它们都在档位之前判定。
   - 完全放行（`bypass`），以及「每次询问」「自动编辑」两档。
   - 文件工具：`read`、`write`、`edit` 在全自动下本来就不问工作区外，本次不动。
   - 看不进去的程序工具（`run_code`、`workflow`、`plugin_manager`）和 DSH 或插件自己的询问（`hostAsk`），在全自动下照旧询问。
   - 会话授权：危险命令或工作区外的命令在卡片上选了「本会话允许」后，同前缀的命令在工作区内不再问（沿用原来的授权规则；工作区外的 shell 命令授权本来就不覆盖）。
4. **界面文案**（`ComposerPermissionTrigger.tsx`，`i18n.ts`）：权限菜单里「全自动」的说明与开启时的确认框改为「工具调用基本不再询问……递归删除、强推等危险命令，以及明确指向工作区外路径的命令仍会先问你；显式拒绝规则仍生效」。原确认框写的「包括工作区外操作」不再准确。「完全放行」的说明（「连全自动都会停下来确认的命令也直接执行」）仍然成立，没改。

## 3 与说明不一致的地方（以代码实测为准）

任务说明写的是全自动现在只在「解析不了的参数」和「碰到敏感文件或工作区外的路径」时问。实测改前的 `evaluate`：全自动对能解析的请求在工作区边界检查之前就放行，所以工作区外的 `bash`、`read`、`write` 都是 allow，`~/.pilab/*` 这类路径表里写 ask 的也放行。改前全自动只在三种情况下问：解析不了的参数、看不进去的程序工具、DSH 自己的询问。因此「写明了工作区外路径的命令要问」是本次新加的行为，只加在 shell 命令上，文件工具保持原样（第 5 节第 1 条）。

## 4 验证

- `src/shared/permissions/__tests__/dangerousCommands.test.ts`：危险清单 89 条，包括应当问的和不应当问的。
- `src/shared/permissions/__tests__/autoGear.test.ts`，pwsh 端到端加门的判定，共 33 条：
  - 全自动下不问：`echo $HOME`、`npm test $FLAGS`、脚本块、`$env:TEMP`、`python build.py`、`2>$null`；
  - 要问：危险命令；写明了工作区外的命令；`workdir` 在工作区外；看不进去的程序与 DSH 自己的询问照旧问；
  - 其他：会话授权照旧覆盖；deny（策略、`.env`、deny 范围、计划模式、白名单）仍拒绝；完全放行不变；自动编辑与每次询问不变；`parameterPaths` 的来源；`checkShellPaths` 的传递。
- `src/dsh-host/permissions/__tests__/bashGate.test.ts` 新增「full auto (decision 191)」组 22 条，用真实的 tree-sitter bash 语法跑：
  - 不问：`echo $HOME`、`npm test $FLAGS`、`2>/dev/null`、`for` 循环、`$(…)`、`cat "$HOME/notes.txt"`、`python`、`bash deploy.sh`、`rm stale.lock`；
  - 问：`rm -rf`、强推、`reset --hard`、`clean -fd`、`find -delete`、`bash -c 'rm -rf …'`、写明的工作区外路径（含 `T='<外>'; cat "$T/file"`、`ls ~`）；
  - 其他：`.env` 不询问直接拒绝；完全放行全部放行。
- 改写了 5 条按旧行为写的用例，改成「全自动不再问，自动编辑仍问」：`pwshGate` 2 条、`permissionHost` 1 条、`bashGate` 2 条。`permissionsLibraryBoundaryStatic` 的来源注释检查放宽为也接受「New in dsh-rebase decision N」。
- 反向检查：去掉危险命令判断后 18 条失败；去掉「环境变量算参数」后 5 条失败；都已还原。
- 根 `pnpm typecheck` 与 `pnpm typecheck:dsh-host` 0 错。本机失败的都与本改动无关：
  - `src/shared/permissions` 3 条 `8dot3-*`（改动前同样失败）；
  - `src/dsh-host/permissions` 2 条（`workdir` 存在性检查、审批期间目标被换），改动前同样失败；
  - `src/dsh-host/bridge/__tests__/sessionGc.test.ts` 3 条，在本分支提交态单独跑同样失败。

## 5 待用户定（已由第 6 节裁决）

1. 文件工具（`read`、`write`、`edit`）在全自动下碰工作区外，是否也要问？现在不问，本次没改。
2. 单个文件的删除（`rm a.txt`、`Remove-Item a.txt`、`del a.txt`）要不要也算危险命令？
3. 危险命令被「本会话允许」后，同前缀的命令是否仍要每次问？现在沿用会话授权，不再问。
4. 「自动编辑」在工作区内跑 `rm -rf` 不问，「全自动」反而会问，两档不再严格由松到紧。是否让「自动编辑」也问危险命令？
5. 看不进去的程序工具（`run_code` 等）和插件或 DSH 自己的询问，在全自动下仍会问，要不要也放行？
6. 模型看到的权限说明（`promptText.ts` 里 auto 那一句）没改：这段文字在录制的 DSH 样本（`src/shared/__tests__/fixtures/dsh/log.*.json`）里，改了要重录。建议之后补一句「危险命令和写明工作区外路径的命令仍会询问」，让模型少碰这两类。
7. 卡片上还说不出「为什么全自动还在问」：危险命令和工作区外这两种原因没有对应的 `askReason`。可以另做。
8. 进一步向 Claude Code 的自动模式看齐，可以对剩下的询问加一道模型安全检查（Claude Code 的自动模式就这么做），代价是每次多一个经网关的请求。本次没做。

## 6 用户裁决（2026-10-17）与落地

用户逐条答复第 5 节：

| 第 5 节 | 用户原话 | 结果 |
|---|---|---|
| 1 文件工具碰工作区外 | "工作区外要询问" | 已做 |
| 2 单个文件的删除 | "任何删除都是危险动作，要问" | 已做 |
| 3 危险命令的会话授权 | "危险命令还是要问" | 已做 |
| 4 两档松紧 | "两档松紧的问题要修复" | 已做 |
| 5 看不进去的程序工具 | "能让宿主看到里面会做什么么？如果不行就照旧问" | 照旧问，理由见下 |
| 6 告诉模型的权限说明 | "可以做，需要什么，还是说留到最后我去linux开发机做？" | 留到 Linux 开发机；2026-10-18 在 Linux 开发机上已做，见 6.3 |
| 7 卡片上说明为什么问 | "可以简单标注一下，给我看看效果再决定加不加" | 已做；用户看过截图后定为保留（"卡片上的原因说明保留"） |
| 8 模型安全检查 | "这个后面做，可以调用一个便宜模型来做审核，同时还得改onboarding侧，再管理员设置模型页面就可以设置用什么模型做审核" | 记为后续任务，本次不做 |

### 6.1 改法（`src/shared/permissions/`）

1. **任何删除都是危险命令**（`dangerousCommands.ts`）：`rm`、`rmdir`、`del`、`erase`、`rd`、`ri`、`Remove-Item` 不论带不带递归开关都算，另加 `unlink`、`shred` 和 `git rm`（只带 `--cached`、只取消跟踪的不算）。`find -delete` 与转手执行的前缀照旧。
2. **危险命令在除完全放行外的所有档位都每次询问**（`gate.ts` 的 `evaluate`）：判定放在所有 deny 之后、档位之前，所以会话授权、配置的 allow 范围、「自动编辑」都放不过它。新导出的 `isDangerousShellRequest` 供门与卡片共用。
   - 会话授权：`granted` 对危险命令一律不认，`remember` 也不记。
   - 卡片：`cardEmitter.ts` 对危险命令只给「直接允许」和「直接拒绝」，不给「本会话内允许」；万一收到「本会话」的回答，按「允许一次」处理。
   - 「自动编辑」从此也问危险命令，四档重新严格由紧到松：每次询问 ⊇ 自动编辑 ⊇ 全自动 ⊇ 完全放行（就危险命令而言前三档一样，都问）。
3. **全自动下文件工具碰工作区外也问**（`autoStillAsks`）：`read`、`write`、`edit`、`glob`、`grep` 和插件的文件工具，路径在工作区外（任何一种写法，决策 134）就问。宿主自己产生的文件（`trustedPath`，溢出文件、附件）和设备路径不算。shell 命令的口径不变：写明了工作区外路径的才问，只经环境变量得到的不问。
4. **卡片上标出原因**（`askReason`）：新增两种取值，渲染层各配一句话（`questionCardModel.ts` 与 `i18n.ts`）：
   - `dangerous`：「这条命令会删除文件或丢弃改动，每次都要你确认，不能按本会话允许」，在每次询问、自动编辑、全自动三档都标；
   - `outside_workspace`：「这次调用涉及工作区外的路径，所以需要你确认」，只在全自动与自动编辑下标（这两档在工作区内本来不问，所以工作区外就是原因；每次询问档本来就问，不标）。
   - 原有的 `unresolved` 不变。DSH 自己的询问（`hostAsk`）不标。
5. **界面文案**（`ComposerPermissionTrigger.tsx`，`i18n.ts`）：「全自动」的说明与开启确认框改为「删除、强推等危险命令每次都会先问你，涉及工作区外路径的操作也会先问」；「自动编辑」的说明加上「删除、强推等危险命令……仍会询问」。

### 6.2 看不进去的程序工具：照旧问

`run_code`（以及 `workflow`）跑的是一整段 TypeScript 或 Python 程序，宿主看得到程序原文（卡片上就显示「程序」），但看不出它会做什么：

- 程序在一个独立的子进程里运行。产品里每个会话的 DSH 沙箱都是 `danger-full-access`（决策 044），这个子进程不受限制，可以直接用 Node 或 Python 的文件和网络接口删改文件，不必经过任何会被门检查的工具。
- 要静态判断一段任意程序碰哪些文件，需要分析动态拼出来的路径、`eval`、动态导入等，做不到可靠；漏判一次就是一次没问就执行的删除。
- 真要放行，可行的路是让程序在 DSH 自己的沙箱（`workspace-write` 一类模式、Windows 上的 ACL 沙箱）里跑，宿主只管沙箱边界。这是另一项较大的工作：要接 DSH 的沙箱模式、在 Windows 与 Linux 上分别验证沙箱确实拦得住，测试也要在两种系统上各跑一套。
- `plugin_manager` 会安装插件，同样照旧问。

结论：本次照旧问，不改。

### 6.3 告诉模型的权限说明：留到 Linux 开发机

要改的只有 `promptText.ts` 里 `auto` 那一句，建议改成：

> Permission gear: auto. Available tools may execute without ordinary approval. Dangerous commands (any delete, force pushes, hard resets and the like) and anything that names a path outside the workspace still ask every time. Explicit deny rules and the tool whitelist remain enforced.

这句话会进到录制的 DSH 样本里，Build 流水线的 Linux 门（`bridge-record.ts --check`）会比对，所以改文字必须同时重录样本：

- 受影响的样本只有 3 个：`perm-gear`、`plan-dismiss`、`plan-review`（`src/shared/__tests__/fixtures/dsh/log.*.json` 里含 `Permission gear: auto` 的只有这三个）。
- 在 Linux 开发机上改完这句后运行下面的命令，逐个看差异，只应有这一句话变：

  ```bash
  node src/dsh-host/tools/bridge-record.ts --update --only perm-gear,plan-dismiss,plan-review
  ```

- 这台 Windows 机器上录不了：
  - `bridge-record.ts` 原来在 Windows 上一启动宿主就报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（`--import` 收到的是 `F:\…` 这种路径而不是 URL），本次改成 `pathToFileURL(...)`，现在能跑了。
  - 但 Windows 上录出来的与 Linux 样本不同：路径分隔符是反斜杠，DSH 在 Windows 上没有 `bash` 工具（报 `unknown tool "bash"`）。样本按 Linux 录，所以重录只能在 Linux 上做。

**已做（2026-10-18，Linux 开发机，本地分支 `claude/claude-sdk-engine-mvp-162021`，基于远端 `62db8a14`）**：

- `promptText.ts` 的 `GEAR_TEXT.auto` 改成上面那句。没有单测写死旧句子，单测不用改。
- 用 `out-node-runtime/node`（24.18.0，与 `node-runtime-pin.mjs` 一致）运行上面的重录命令。`git diff` 只有这一句话变：`log.perm-gear.json`、`log.plan-dismiss.json` 各 1 处，`log.plan-review.json` 2 处（计划模式与批准后的执行模式各一条）。三个场景的 `stream.*`、`rpc.*` 都没变。
- 录制工具的 `--import` 改成 `pathToFileURL(...)` 后，Linux 上照样能跑。

### 6.4 已改的录制样本

`stream.perm-grants.json` 第三张卡（`echo perm-grant-c && rm -f perm-grant-missing.txt`）按新规则手改了 3 处，与重录应得的结果一致：

- `decisions` 从三项变成 `["allow", "deny"]`；
- 去掉 `sessionGrantScope`；
- 加上 `askReason: "dangerous"`。

这张卡在场景里本来就被拒绝，之后的事件不变。没在 Linux 上跑 `--check` 验证，下次在 Linux 开发机上跑一次确认。

**Linux 上已确认（2026-10-18）**：全量 `node src/dsh-host/tools/bridge-record.ts --check` 的 36 个场景全部一致（退出码 0），`perm-grants` 不用重录。样本里这张卡就是 `decisions: ["allow", "deny"]`、没有 `sessionGrantScope`、带 `askReason: "dangerous"`。`--artifacts` 留下的录制结果与样本目录逐字节比对，也一致。

### 6.5 后续任务：剩下的询问交给便宜模型审核

用户 2026-10-17 定为后面做：

- 全自动剩下的询问先交给一个便宜的模型做安全审核（Claude Code 的自动模式就是这样做的），审核通过就不打扰用户；
- 要同时改登录引导（onboarding）一侧，并在管理员的模型设置页面增加一项，指定审核用哪个模型；
- 代价是每次多一个经网关的请求。

### 6.6 验证

- 单测：
  - `dangerousCommands.test.ts`：单个文件的删除、`unlink`、`shred`、`git rm` 改进「要问」；`git rm --cached` 不问。
  - `autoGear.test.ts`：
    - 全自动下 `Remove-Item notes.txt`、`rm`、`del`、`git rm` 要问；
    - 危险命令「本会话允许」后仍每次问；
    - 五种文件工具与插件文件工具在工作区内放行、工作区外要问；宿主自己产生的文件不问；
    - 卡片原因是 `outside_workspace`；
    - 危险命令在每次询问、自动编辑、全自动都问，只有完全放行放行；
    - 自动编辑对普通的工作区命令照旧放行。
  - `pwshGate.test.ts`：
    - 删除命令永远不记会话授权；
    - 三档下删除的原因都是 `dangerous`；
    - 自动编辑下工作区外的原因是 `outside_workspace`；
    - 卡片对危险命令只给两个选项，「本会话」的回答按一次处理。
  - `bashGate.test.ts`：真实 bash 语法下 `rm stale.lock`、`rm -f "$TMPFILE"` 要问。
  - `questionCardModel.test.ts`：两种新原因的中英文案。
  - 按旧规则写的 4 条用例改了命令，不再用删除：`sessionGrants`、`pwshGate` 的别名授权、`workspaceSpellings` 的 `8dot3-grant`，以及 `pwshGate` 的原因用例。
- 根与宿主 tsc 0 错。`src/shared/permissions`、`src/dsh-host/permissions`、`src/dsh-host/bridge`、`src/renderer/components/chat` 的 vitest 只剩改动前就有的失败：
  - 建符号链接 EPERM 8 条；
  - `8dot3-*` 3 条；
  - `shellWorkdir` 存在性检查 1 条；
  - `sessionGc` 3 条。
  - `8dot3-*` 与 `shellWorkdir` 已在提交态核对过，同样失败。
- 开发版实测（本机假网关，全自动档，DSH 引擎）：
  - `Remove-Item notes.txt` 弹卡，只有「直接允许 / 直接拒绝」，带删除的说明一行（截图）。
  - 写工作区外的文件弹卡，带工作区外的说明一行（截图）。
  - 改前同一条 `Remove-Item notes.txt` 在全自动下不问就删了。
  - 两张截图里有本机用户目录的路径，没有入库，只留在开发机工作树的 `bugOutput/s6-cards/`（已被 .gitignore 忽略）。
  - 注意：宿主进程启动时加载权限代码，改代码后要重启宿主才生效。
- Linux 开发机（2026-10-18，改了提示词并重录之后；模型只用本机假网关）：
  - 三套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`、`pnpm typecheck:claude-sdk-host`）都是 0 错。两个宿主包按 CI 的方式装（`npm ci --ignore-scripts`，SDK 宿主另加 `--omit=optional`）。
  - `pnpm test` 全量：690 个文件通过、6 个跳过；11934 条通过、65 条跳过、0 条失败。
  - Windows 上因环境失败的几组，在 Linux 上都通过：建符号链接、`8dot3-*`、`sessionGc`、`shellWorkdir`、`legacyShellAbsence`、`dshHostScopes`。把相关的 16 个测试文件单独重跑核对：486 条通过、0 条失败，跳过的 2 条是只在 Windows 上跑的用例。
  - `bridge-record.ts --check`：36 个场景一致。`bridge-smoke.ts`：退出码 0，判定项全部为真。
