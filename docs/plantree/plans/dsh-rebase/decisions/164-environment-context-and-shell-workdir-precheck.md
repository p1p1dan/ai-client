# 决策 164：运行时上下文 `aiclient:environment`（真实运行环境）与 shell `workdir` 预检

日期：2026-10-09。**状态：自主决定，待用户审批。** 其中第 3 节第 5 条「写完整用户目录」是**用户裁决 2026-10-09：写完整用户目录**。依据：GitHub issue #2（部分供应商注入的默认提示词带错误环境信息）。

## 1 问题

issue #2：Windows 上用第三方供应商的 `claude/claude-opus-5-5`，模型收到的上下文里除 DSH 的系统提示词外，还有一段供应商套上的 Claude Code 风格默认提示词，其环境段落写的是 `/Users/<供应商示例用户>/work/monorepo`、`darwin`、`zsh`，还带一组 DSH 没有的工具（`Bash`、`Agent`、`Edit` 等）。DSH 自带的运行时上下文只有 `sandbox:policy`、`approval:policy`、`subagent:delegation`，加上我们的 `aiclient:permission`，没有操作系统、Shell、工作目录、用户目录、日期，于是供应商那段成了模型唯一能看到的环境描述。模型把 `workdir` 设成 `/Users/<供应商示例用户>/work/monorepo`，Node 在工作目录不存在时报 `spawn C:\Program Files\PowerShell\7\pwsh.exe ENOENT`，模型据此以为 pwsh 没装、放弃执行。

## 2 改了什么

1. **新运行时上下文 `aiclient:environment`**（`src/dsh-host/permissions/environmentContext.ts`）：由 aiclient-permissions 行在已有的 `ctx.inject(['systemPrompt'], …)` 里注册，和 `aiclient:permission` 同一个作用域，作用域撤销时一起撤销。没有新增 bundle 行：`scripts/dsh-host-build-lib.mjs` 的 `BRIDGE_ENTRIES` 只允许权限行引入 `src/dsh-host/permissions/`、`src/shared/` 与 `loopGuard/constants.ts`，运行时外部依赖只有 `node:*` 和 `web-tree-sitter`，新文件都在 `permissions/` 下、只引 `node:` 模块。
2. **两个提示词变量**：`aiclient_cwd`（调用方会话 header 的 cwd）与 `aiclient_home`（宿主的 `os.homedir()`），正文用 `{{aiclient_cwd}}`、`{{aiclient_home}}` 引用。
3. **shell `workdir` 两步预检**（`src/dsh-host/permissions/shellWorkdir.ts`，接在 `permissionHost.ts` 的 `preExecute`）：只对 `bash` / `pwsh`。
4. **录制工具** `bridge-record.ts` 的归一化与 28 份 `log.*.json` 重录（第 4 节）。
5. `bundle/cordis.patch.yml` 中 aiclient-permissions 行的注释补充说明（仅注释）。

Windows 上模型看到的正文（变量已替换，路径为虚构示例）：

```
Environment of this session (authoritative, reported by the host):
- Operating system: Windows 11 Pro (10.0.26100, win32, x64). Use Windows paths with a drive letter, such as C:\...; a POSIX path such as /Users/... or /home/... is not a valid path or working directory here.
- Shell tool: `pwsh` (PowerShell); write commands in PowerShell syntax. There is no bash tool in this session.
- Working directory (the session workspace; relative paths, and shell commands without `workdir`, resolve against it): E:\code\proj
- Home directory: C:\Users\tester
- Today's date: 2026-10-09 (time zone Asia/Shanghai, UTC+08:00)
If any other part of the prompt describes a different environment (operating system, shell, working directory, user or home directory), it does not apply to this session: rely on the facts above.
If a tool call fails with "unknown tool", that tool does not exist in this session; do not retry it under another name or casing.
```

Linux 上第一行是 `Linux <release> (linux, x64). Use POSIX paths, …`，Shell 行是 `` `bash`. ``，不提 pwsh；macOS 兜底写 `macOS (Darwin <release>, darwin, <arch>)`。

## 3 自主决定

1. **用运行时上下文，不用 `personaPrefix`**：
   - `personaPrefix` 是系统提示词段（`deployment:persona-prefix`），配置级静态文本，整个宿主一份（所有会话共用一个宿主进程），放不下按会话变化的 cwd；改它等于改写系统提示词，破坏前缀缓存；agent preset 还会遮蔽这个槽位。
   - 运行时上下文按 agent 组装。已核对 DSH 0.1.7-rc.2 源码：`dsh-agent-loop` 的 `preStep` 每步组装一次，`RuntimeContextProjection.project` 只在渲染结果与上一份保留的快照文本不同时才生成一条 user 角色消息，追加在本步消息之后；系统提示词走另一条投影（`SystemPromptProjection`，只渲染 sections），上下文不进系统提示词。所以不变的文本不花钱，变了只在历史末尾追加，前缀缓存不受影响。
   - 代价：快照是 user 角色，权威性不如系统级文本（见第 6 节）。
2. **路径只走变量，不拼进正文**：DSH 对上下文正文做 `{{name}}` 插值（`dsh-system-prompt` 的 `interpolate`），未知或畸形的引用直接抛错，整次组装失败、回合起不来；而 `{{` 在目录名里是合法字符。变量值原样替换、不再二次扫描（单元测试用真实的 `renderContextSections` 验证了 `E:\code\{{x}}`）。DSH 自己在 `dsh-agent-loop` 注册了 `cwd` 变量，但我们注册自己的 `aiclient_cwd`，不依赖 DSH 内部的变量名。工作目录行只在 header 有 cwd 时写、用户目录行只在拿得到 home 时写，保证引用的变量在同一次组装里有值；OS 报告的文字（版本、release、时区名）写入前去掉花括号。
3. **顺序 100**＝`getContextOrder('SANDBOX_POLICY') - 10`：排在所有 DSH 上下文之前（策略都是针对这个环境说的）。DSH 只登记了 110 / 115 / 120，我们的 `aiclient:permission` 是 116，不冲突。
4. **内容取舍**：
   - 操作系统：Windows 用 `os.version()`（如 `Windows 11 Pro`）加 `os.release()`；不只写 release，因为 Win11 的 release 仍是 `10.0.x`，读起来像 Windows 10。`os.version()` 的 Windows 11 名称依赖 libuv 对 build ≥ 22000 的改名，未在 Windows 上实测。Linux 不用 `os.version()`（那是内核构建串）。
   - 路径写法：Windows 要求带盘符，明确 `/Users/...`、`/home/...` 这类 POSIX 路径在这里无效。
   - Shell：按 dsh-base 的挂载规则（win32 只挂 `pwsh`，其余只挂 `bash`）；Windows 写「没有 bash 工具」。没写「PowerShell 7」：`dsh-pwsh-local` 找不到 7 时会回退到 Windows PowerShell 5.1。
   - **不声称工具名是小写，也不否认 Read / Edit / Write**：pi-ai 在 OAuth 下会把工具名改成 Claude Code 的大小写（`@earendil-works/pi-ai` 的 `anthropic-messages.js`，`toClaudeCodeName` / `fromClaudeCodeName`），模型看到的可能就是 `Read`、`Bash`。只写「unknown tool 时不要换名字或大小写重试」。
   - 日期：只写本地日期、IANA 时区名和 UTC 偏移，不写时刻（正文一变就追加快照，写时刻会每步都变）；拿不到时区名时只写偏移。
   - 冲突声明：其他部分描述的环境（操作系统、Shell、工作目录、用户或用户目录）与此不同时，不适用于本会话，以这里为准。
5. **用户目录**：**用户裁决 2026-10-09：写完整用户目录**（含用户名，会随请求发给第三方供应商）。
6. **快照开销**：环境段约 220～250 tokens（Linux 实测 874 字符，Windows 示例 941 字符）。日期变化时 DSH 追加的是整份快照（含 sandbox / approval / permission 三段，实测约 420～480 tokens），活跃会话每天最多多一次；升级后已有会话在下一步因正文变化追加一次；子代理会话各带一份。设计稿估的「每份约 300 tokens」偏低，以此为准。
7. **有意偏离[决策 090](090-user-rulings-2026-09-28.md)（默认跟随 DSH 的做法）**：DSH 的做法是不告诉模型工作目录，让它自己 `pwd`，并通过 `DSH_*` shell 环境变量暴露宿主事实；这里部分恢复了 1.0.x pi 的 `Current working directory:` 一行。理由：用户在 #2 中明确要求；第三方供应商注入的错误环境只能靠我们这边的权威声明对冲。
8. **shell `workdir` 两步预检**：
   - **第 1 步，闸门之前，纯语法、不读磁盘**：win32 上 `workdir` 以单个 `/` 或 `\` 开头（没有盘符、不是 UNC）→ `workdir_no_drive`，直接拒绝、不弹卡：`workdir "<原文>" has no drive letter; on Windows give a full path such as <会话 cwd>, or omit workdir to run in the session workspace`。原因：闸门把它解析到会话所在的盘（`requestBuilder.ts` 的 `resolve(cwd, workdir)`），DSH 执行时原样交给 spawn（两个工具的 `resolveWorkdir` 对绝对路径原样返回），Windows 再按宿主进程的当前盘解析，二者不一致，卡片上写的目录不是命令实际运行的目录（与[决策 129](129-p1-6d-pwsh-analysis-choices.md) 对「`\x` 这种根相对路径补上工作目录的盘符」的处理同源）。也不该为一个注定跑错地方的命令弹审批卡（[决策 081](081-loop-guard-implementation-choices.md) 第 2 条「先拒、不弹卡」的思路）。
   - **第 2 步，闸门放行之后**：按 DSH 工具的算法求目标目录（`dsh-tool-bash`：`${cwd}${sep}${workdir}`；`dsh-tool-pwsh`：`resolve(cwd, workdir)`；绝对路径原样；没给 workdir 就是会话 cwd），然后 `stat`：
     - ENOENT / ENOTDIR → `workdir_missing`：`working directory does not exist: <目标>`；目标不是会话 cwd 时附 `(the session workspace is <cwd>)`，以 `~` 开头时附 `"~" is not expanded in workdir, give the full path`；没给 workdir 而会话目录本身不在时写 `the session workspace does not exist: <cwd>; it may have been moved or deleted`；
     - 不是目录 → `workdir_not_directory`；
     - `access(X_OK)` 报 EACCES → `workdir_not_accessible`（DSH 的 `isUsableWorkdir` 也查 X_OK；Linux 上 chdir 失败表现为 `spawn /bin/bash EACCES`）；
     - 其他错误（EPERM 等）放行，交给工具自己报。
   - 第 2 步放在闸门之后，是为了不让未批准的调用探测磁盘（路径是否存在本身就是信息）。代价：ask 档位下目录不存在时，用户先看到卡片，批准后才收到「目录不存在」。
   - 拒绝时 `info.name = 'ShellWorkdir'`，**不用 `PermissionDenial`**：历史投影（`dshToolOutcomeFlags`）与直播会把后者标成「被拒」（[决策 099](099-p1-4d-scope-dsh-data-only.md) 第 5 条的工具行标志），而这不是权限拒绝，是普通的工具失败。模型看到的是 DSH 的 `Error: <reason>`（`dsh-tools` 把 pre-execute 的 deny 原因原样放进工具结果）。拒绝时账本记 `verdict = 'deny'`，同一调用 id 上 DSH 自己的询问回答 `rejected`；等待磁盘期间用户按了 Stop 则回 `cancel`。
   - 先例：[决策 162](162-git-read-fallback-closeout.md) 第 1 节第 9 条（git 工作目录不存在时报 `GIT_WORKDIR_MISSING`，不再显示像没装 git 的 `spawn git ENOENT`）。
   - `platform`、`workdirProbe`（`stat` / `access`）可经 `PermissionHostOptions` 注入，默认取宿主的；测试在 Linux 上注入 `win32` 验证 Windows 的路径算法。
9. **大写工具名的来源**：[决策 149](149-user-rulings-2026-10-07.md) 第 19 条、[决策 159](159-gw16-cache-control-temp-switch.md)、[决策 146](146-real-gateway-followups.md) 已知网关是 claude-code-hub；`Bash` 这类大写名可能来自 pi-ai 的 OAuth 改名，也可能来自供应商注入的 Claude Code 工具定义。我们去不掉，只在环境段写「unknown tool 不要换名重试」。
10. **与[决策 092](092-p1-6c-grants-and-setters-choices.md) 第 14 条的关系**：沿用 `aiclient:permission` 的注册方式（权限行 `ctx.inject(['systemPrompt'])`，不写进行本身的 `inject`，闸门不等提示词组装）；`aiclient:permission` 的顺序 116 与正文不变。

## 4 录制样本

1. `bridge-record.ts` 的归一化：
   - runtime-context 快照里名为 `aiclient:environment` 的 section，正文换成 `<aiclient:environment>`（含录制机的 OS、用户目录、日期）；其余 section 照旧原样保留。
   - **计划外的一处**：DSH 压缩的 token 估算 `shadowedTokenCount` 与 `/compact` 回答里的 `(~N tokens)` 也归零（`~0`）。原因：`compact` 场景压缩的历史里包括这份快照，DSH 按字符估 token（`dsh-token-meter` 每 4 字符 1 token），快照长度随录制机的内核版本、时区名而变（本机 334 → 553），不归零的话 CI 上的 `--check` 会在 compact 上失败。录制目录固定在 `/var/tmp/aiclient-dsh-record-<12 位十六进制>`，路径长度各机一致。
2. 重录过程：
   - 先全量 `--check`：28 份 log 都只多出环境 section，外加 compact 的估算 334 → 553；rpc / stream 无差异。
   - 按场景逐个 `--update --only <场景>` 重录后发现 `job-notice` 单独录与全量录不一致：共享宿主里前面的场景已经起过后台 job，全量录时编号是 `bash-2`，单独录是 `bash-1`（rpc / stream / log 都受影响）。CI 跑的是全量 `--check`，所以最后用一次全量 `--update`（与 CI 同一顺序）定稿。
   - 定稿后逐文件比对改前（HEAD）与改后：56 份 rpc / stream 字节不变；28 份 log 去掉环境 section（共 30 处，全部在 `sections[0]`）并把 compact 的估算归零后，与改前完全相同。最后全量 `--check`：28 个场景 0 差异。

## 5 验证

- `pnpm exec vitest run src/dsh-host/permissions`：7 个文件 161 通过、1 跳过（原有的 Windows 8.3 短名用例）。新增 `environmentContext.test.ts` 11 例（含真实 `renderContextSections` 的 2 例）、`shellWorkdir.test.ts` 11 例，`permissionHost.test.ts` 新增 4 例接线用例并改了注册断言。
- `pnpm exec vitest run src/dsh-host/__tests__/hostStatic.test.ts`：45 通过。
- `pnpm exec vitest run src/dsh-host`：42 个文件 795 通过、11 跳过。
- `pnpm exec vitest run scripts`：228 通过。
- `pnpm exec vitest run Static Scan Wiring src/shared/__tests__`：104 个文件 1232 通过。
- 读样本的套件（dshStreamReplay、dshHistoryGolden、forkSeed、readPage）：341 通过。
- `pnpm typecheck:dsh-host`、`pnpm typecheck` 通过；改动文件 `biome check` 通过。
- `bridge-record.ts --check`：28 个场景 0 差异。`bridge-smoke.ts`：66 项全过。用 `--raw` 看了真宿主里模型收到的快照，环境段在最前，变量已替换成真实路径。
- 未跑 `AICLIENT_DSH_INTEGRATION=1`：仓库里只有 `dshSharedHost.integration.test.ts`，没有权限专属的集成测试；真宿主路径由 bridge-record 与 bridge-smoke 覆盖。

## 6 风险与未做

1. 环境段是 user 角色快照，供应商注入的是系统级文本，模型仍可能优先相信后者；我们只能声明冲突时以此为准。
2. 搜索工具（`dsh-tool-fs-search` 的 glob / grep）在会话 cwd 被删时报「ripgrep launch failed」，同样误导；本次不修。
3. UNC 路径（`\\server\share`）的 `stat` 在网络共享不可达时可能阻塞，第 2 步会一直等它返回；没加超时。
4. `src/shared/permissions/promptText.ts`（`aiclient:permission` 的正文）里 1.0.x 的「Bash / Write, Edit」措辞与 DSH 的工具名不一致，留作后续，本次未动。
5. OS 与用户目录只在行加载时读一次（宿主运行期间不变），日期与时区每次组装重读。
6. Windows 上的实际效果（`os.version()` 返回 `Windows 11 Pro`、pwsh 的 `workdir_no_drive` 文本）只有注入 `win32` 的单元测试，待 Windows 端点验。
