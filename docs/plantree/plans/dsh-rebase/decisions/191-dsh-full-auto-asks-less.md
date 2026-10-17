# 决策 191：DSH 全自动档少问人：解析不了的参数放行，只问危险命令和写明了工作区外路径的命令

日期：2026-10-17（UTC+8）。**状态：第 1 节是用户裁决（[路线 B README 裁决 27](../../claude-sdk-engine/README.md)，[S-6 反馈清单](../../claude-sdk-engine/topics/s6-feedback.md)第 11c 条，GitHub issue #19）；第 2 节起是按裁决落地时的自主决定，待用户审批，第 5 节列出要用户定的事。** 分支 `ccv/s6-parallel`。

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

## 5 待用户定

1. 文件工具（`read`、`write`、`edit`）在全自动下碰工作区外，是否也要问？现在不问，本次没改。
2. 单个文件的删除（`rm a.txt`、`Remove-Item a.txt`、`del a.txt`）要不要也算危险命令？
3. 危险命令被「本会话允许」后，同前缀的命令是否仍要每次问？现在沿用会话授权，不再问。
4. 「自动编辑」在工作区内跑 `rm -rf` 不问，「全自动」反而会问，两档不再严格由松到紧。是否让「自动编辑」也问危险命令？
5. 看不进去的程序工具（`run_code` 等）和插件或 DSH 自己的询问，在全自动下仍会问，要不要也放行？
6. 模型看到的权限说明（`promptText.ts` 里 auto 那一句）没改：这段文字在录制的 DSH 样本（`src/shared/__tests__/fixtures/dsh/log.*.json`）里，改了要重录。建议之后补一句「危险命令和写明工作区外路径的命令仍会询问」，让模型少碰这两类。
7. 卡片上还说不出「为什么全自动还在问」：危险命令和工作区外这两种原因没有对应的 `askReason`。可以另做。
8. 进一步向 Claude Code 的自动模式看齐，可以对剩下的询问加一道模型安全检查（Claude Code 的自动模式就这么做），代价是每次多一个经网关的请求。本次没做。
