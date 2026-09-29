# 决策 129：P1-6d pwsh 权限分析的实现取舍：保守词法分析的形态；「看不透的文本」不可授权；别名与大小写归一；闸门给出的原因 `askReason`；审批卡两句与授权活动行；S18 探针与 Windows CI

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 已批准的决策：[046](046-pwsh-conservative-lexical-analysis.md)（自写保守词法分析，看不懂的一律当「解析不出」，策略面沿用 `bash`，约 150 条表驱动，Windows CI 两路）、[047](047-tool-classification-and-plan-mode.md)、[079](079-permission-classification-details.md)、[088](088-permission-gate-wiring-choices.md)「留给后续」的 P1-6d 一项、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH；只做 Linux 与 Windows）；
- 待审批的前序决策：[120](120-p1-7c-tool-rows-choices.md) 第 21、24 条与「影响与遗留」（审批卡的别名说明与原因句推迟到 P1-6d；Windows 授权活动行的写法）；
- 方案：[P1-6 分片 03 §11](../topics/p1-6-permissions/03-design.md)（pwsh 分析）、[分片 04 §5](../topics/p1-6-permissions/04-regression-baseline.md) 的 S18、[分片 05](../topics/p1-6-permissions/05-changes.md) 的 P1-6d 节；[P1-7 分片 04 §6](../topics/p1-7-renderer/04-tool-rows-windows.md)（审批卡文案）。

改动留在工作区，由编排者复跑后提交；Windows CI 只写了 workflow 文件，没有推送、没有触发。**第 4、7、13、16 条请重点审批。**

## 规则

### 一、分析的形态

1. **两个新文件**：`src/shared/permissions/pwshAnalysis.ts`（词法分析 `analyzePwsh`）与 `pwshNames.ts`（名称表：别名、已知 cmdlet、不可授权的命令，零依赖）。
   - 拆开是因为 `grants.ts` 要用名称表，而 `grants.ts` 被 pi 会话迁移库（`legacyPiSession`）引用，那边的边界静态守卫不许碰 `node:os` 和随包策略表；分析本身两样都要用。
   - 输出沿用 `BashAnalysis` 的形状（`paths`、`commands`、`unresolvedPaths`、`exploration`），新增可选字段 `ungrantable`（`analyzeBash` 永远不设），经 `authorizeTarget` 透传到 `ToolPermissionRequest.ungrantable`。
2. **切段与命令名**：按 `;`、换行、`|`、`&&`、`||` 切段；每段首词做别名展开与大小写归一（第 7、8 条）；首词读不出（变量、引号串即表达式、数字、关键字、`&` / `.` 调用符）的段整段判为看不透的文本（第 4 条）。`cd` / `Set-Location` / `Push-Location` 改变后续段的目录（与 bash 的 `cd` 一样），`cd -`、`popd`、`cd $x` 之后的段一律看不透。
3. **操作数登记与 bash 一致：每个字面词都当候选路径**，经 `checkShellPaths` 展开通配、按黑名单字面判一次、canonical 后再判一次。
   - 偏离方案原文「位置参数中像路径的词」：`Get-Content .env` 这种不含斜杠的秘密文件名必须进黑名单判断；多登记的工作区内候选没有代价（与 bash 相同）。
   - 例外：`Select-String` 与 `grep` / `rg` / `findstr` 的模式（`-Pattern` 的值或第一个位置参数）；Windows 上原生程序的 `/开关`（`ipconfig /all`、`robocopy a b /MIR`；cmdlet 的参数照登记，`rmdir` 是 `Remove-Item` 的别名）；URL。
   - `$env:NAME`、`${env:NAME}`、`$HOME`、`$PWD` 按宿主环境展开（Windows 上不分大小写），`~` / `~\` 展开为用户目录；`\\?\` 前缀去掉；`\x` 这种根相对路径补上工作目录的盘符；不做 MSYS 的 `/c/…` 折叠（PowerShell 不认这种写法，折叠反而可能把工作区外的路径算成工作区内）。
4. **两类「解析不出」**，处置不同：
   - **看不透的文本 → `unresolvedPaths` 且 `ungrantable`**：`$env` / `$HOME` / `$PWD` 以外的变量（含 `$_`、`$args[0]`、`$x.Length`、`$global:x`）、`$( )`、`( )`、脚本块 `{ }`、`@( )`、`@{ }`、splatting、here-string、反引号、`&` 与 `.` 调用符、关键字（`if`、`function`、`foreach` 等）、以表达式开头的段、提供程序盘符（`HKCU:`、`Env:`、`Function:`、`Variable:`）、UNC、驱动器相对路径（`C:foo`、`D:`）、`~user`、`--%`、`<`、块注释、行尾的后台 `&`、弯引号与长短破折号、未闭合的引号；
   - **看不透的程序 → 只 `unresolvedPaths`**，仍按前缀授权：`python` / `python3` / `py` / `node` / `perl` / `ruby`、`Import-Module`、`Invoke-Item`。与 bash 对解释器的处理一致（`python build.py` 记两个词）；
   - **执行字符串或另一个 shell 的命令 → `unresolvedPaths` 且 `ungrantable`**：`Invoke-Expression`、`Invoke-Command`、`Invoke-History`、`Start-Process`、`Start-Job`、`Start-ThreadJob`、`Add-Type`、`Set-Alias`、`New-Alias`、`ForEach-Object`（`% Delete` 不用脚本块也能对每个对象调方法），以及 `pwsh`、`powershell`、`cmd`、`bash`、`sh`、`wsl`、`sudo`、`runas`、`wscript`、`cscript`、`mshta`、`rundll32`、`regsvr32`。
   - **与 bash 的差异（请审批）**：bash 下 `npm test $FLAGS`、`eval …` 仍可按前缀授权（1.0.x 为了不反复问而有意为之）；pwsh 下含变量、脚本块或执行字符串的命令一律不可授权——「本会话允许」退化为允许一次，卡片不写范围句。理由是宁可多问：PowerShell 的脚本块可以出现在任何「过滤」里（`Where-Object { Remove-Item …; $true }`），授权了 `Where-Object` 就等于授权了块里的一切。代价：这类命令在 ask / accept-edits / auto 下每次都问。
5. **黑名单的底线**：看不透的区域里的字面词（引号串、裸词）照样登记，执行字符串类命令的字符串参数按词拆开登记。所以 `Get-Content (Join-Path $HOME '.ssh\id_rsa')`、`iex "cat .env"`、`cmd /c type server.key` 在 bypass 下也会被拒。超过 64 KiB 的看不透区域（大段 here-string）不再扫字面词，仍判 unresolved。
6. **UNC 不做 canonical 解析**：`realpath` 一个 `\\server\share\…` 会在用户审批之前就连网（还可能把 NTLM 凭据交给对方）。UNC 判为看不透；字面就命中黑名单的才登记，由 `checkShellPaths` 在任何解析之前拒绝。
7. **别名表只收 Windows PowerShell 5.1 与 PowerShell 7（Windows 上）含义相同的别名**：`ls`/`dir`/`gci`、`cat`/`gc`/`type`、`rm`/`del`/`erase`/`rd`/`rmdir`/`ri`、`cp`/`copy`/`cpi`、`mv`/`move`/`mi`、`ren`、`ni`、`gi`、`ac`、`sls`、`select`、`sort`、`where`/`?`、`%`/`foreach`、`echo`/`write`、`tee`、`gcm`、`pwd`、`cd`、`pushd`、`popd`、`iex`、`start`/`saps`、`iwr`、`irm`、`md` 等。
   - **偏离方案（请审批）**：`sc`、`curl`、`wget` 不归一。5.1 里它们是 `Set-Content` / `Invoke-WebRequest` 的别名，7 里别名没有了，分别是 `sc.exe`（服务控制器）和原生程序。归一会让 `Set-Content` 的授权盖住 `sc stop <服务>`。它们各自保留原名作前缀。
   - 程序保留扩展名与路径：`sc.exe` 不是 `sc`，`where.exe` 不是 `Where-Object`，`git.exe status` 不是 `git status`（多问一次，不会错放）。
8. **大小写**：已知 cmdlet 用标准写法（`Get-ChildItem`），其余一律小写（PowerShell 与 Windows 解析命令名不分大小写）；子命令词保持原样（与 bash 一致）。多子命令程序表在 bash 的表上加 `py`、`winget`、`choco`、`scoop`。
9. **exploration（plan 模式可运行）**：方案的白名单（`Get-ChildItem`、`Get-Content`、`Select-String`、`Get-Location`、`Test-Path`、`Resolve-Path`、`Get-Item`、`Measure-Object`、`Select-Object`、`Sort-Object`、不带脚本块的 `Where-Object`）加 `Write-Output`、`Get-Command`（对应 bash 白名单里的 `echo`、`which`），外加与 bash 相同的只读 git 子命令与禁用参数。`2>$null`、`2>&1` 不破坏只读判定（bash 下任何重定向都算写，这里对「丢弃」放宽）；`cd x; ls` 与 bash 一样不算只读。
10. **上限**：词元超过 20 000 个判 `invalid_tool_arguments`（与 bash 的 AST 上限同义）。

### 二、闸门与授权（`gate.ts`、`grants.ts`）

11. **策略面**：shell 工具的默认策略面由闸门给出（`isShellTool` → `bash`，`defaultPolicySurface`），`requestBuilder` 不再在 pwsh 请求上写 `policySurface: 'bash'`。用户为 bash 写的规则（`"git push*": "deny"`）对 pwsh 同样生效；规则按原始命令与归一后的各段各匹配一次。
12. **授权前缀**：`commandPrefixes` 对 `pwsh` 请求改用 `pwshCommandPrefix`（第 7、8 条归一后的名字），别名与全名、不同大小写共用一条授权；`ungrantable` 的请求没有前缀（既不记也不命中）。P1-6d 之前 sidecar 里按原始首词记下的 pwsh 前缀不再命中，多问一次，不迁移。
13. **原因 `askReason`（请审批）**：闸门出卡时算一次「这条如果能读懂，当前档位会不会直接放行」；会，就带 `askReason: 'unresolved'`。
    - 经 `approve` 的第四个可选参数 `PermissionAskContext` 交给卡片发射器，写进 `permission.requested` 的 `askReason`；旧的两参、三参 approver 不受影响（没有原因时仍按三参调用）。
    - ask 档（本来就问）、工作区外的路径（accept-edits 本来就问）、宿主自发的询问（`hostAsk`）都不带，免得把「档位要问」说成「命令读不懂」。
    - 1.0.x 自有 runtime 共用这个闸门和发射器，auto / accept-edits 下读不懂的 bash 卡片也会带上原因；渲染层对 bash 有自己的措辞（第 15 条）。

### 三、渲染层

14. **别名说明**（120 第 24 条推迟的第一句）：`pwsh` 卡的「本会话允许」范围里有 cmdlet（`动词-名词`）时，范围句后接「PowerShell 别名（如 ls、dir、gci）按同一条命令记忆」；原生程序（`npm test`）、bash、文件授权不加。
15. **原因句**（120 第 24 条推迟的第二句）：卡片带 `askReason: 'unresolved'` 时，在详情之下、项目行之上加一行 `text-meta` 次要色：
    - `pwsh`：「这条命令含变量、脚本块或调用符，无法静态判断会碰哪些文件，所以需要你确认」（P1-7 分片 04 §6 原文）；
    - `bash`（及其他 exec 卡）：「这条命令含变量、命令替换或解释器，无法静态判断会碰哪些文件，所以需要你确认」；
    - 其余（`run_code`、`workflow`、未知工具）：「无法静态判断这次调用会碰哪些文件，所以需要你确认」。
    - 待答与排队中的卡都显示，结算后不显示。
16. **授权活动行（请审批）**：`pwsh` 显示 PowerShell（新函数 `permissionActivityToolLabel`），bash 仍显示小写 `bash`（1.0.x 的措辞，多处测试钉住）。两个 shell 在活动行上的写法因此不对称（卡片标题是 Bash / PowerShell）。
    - **纠正 120「影响与遗留」**：活动行用的是 `request.tool`，pwsh 过闸时一直写「已允许 pwsh」，从未写过「已允许 bash」；`policySurface` 不进活动行。现在改为「已允许 PowerShell」。

### 四、S18 与 Windows CI

17. **探针 `src/dsh-host/tools/perm-pwsh-probe.ts`**：真 DSH 宿主（源码检出）+ 产品 bridge + 本地假网关的新脚本 `P1-S18`，一个会话一个用例、各用自己的工作区：
    - `card`（S1，ask）：两条 `Set-Content`，第一张卡允许一次（文件写出）、第二张拒绝（文件不存在）；卡片是 `pwsh` / `exec` / `run_command`，不带原因；
    - `grants`（S3，ask）：`Write-Output` 选「本会话允许」，范围写 `Write-Output`；`echo`（别名）不出卡照常运行；`echo …; Remove-Item …` 出卡（`Remove-Item` 没授权过）；
    - `deny`（S4，bypass）：`.env` 与 `~\.ssh\id_rsa` 不出卡直接拒绝，`.env` 里的金丝雀不进任何工具结果；
    - `auto`（S7，auto）：`Write-Output $S18X > …` 出卡且带 `askReason: 'unresolved'`，`Write-Output s18 > …` 不出卡；
    - 四个工作区各自前后比较 ACL（Windows 用 `Get-Acl` 的 SDDL，沿用 P0-4 的 F-off-acl），加宿主就绪与正常退出，共 14 项检查；
    - `--shell bash` 用各用例的 bash 孪生命令做 Linux 干跑，断言完全相同（「与 Linux 结论相同」就是同一套断言在两边都过）。本机干跑 14/14 通过；
    - 输出一份 JSON 报告（`checks[]`、各用例的卡片与工具结果摘要），任一检查失败退出 1，搭不起来退出 2。
18. **workflow `.github/workflows/dsh-p1-6d-windows.yml`**：windows-2022，矩阵 `admin` / `standard`：
    - 从源码检出直接跑：`npm ci --ignore-scripts`（与 build.yml 的门禁相同）+ `fetch-node-runtime.mjs` 取随包 `node.exe`，不用 P0-4 的离线 kit（宿主从源码检出能跑，根目录的依赖一个也不需要，已用导入图核对）；
    - admin 路是 runner 自己的提权账户，DSH 的 pwsh 工具找得到 PowerShell 7；standard 路沿用 P0-4 的配方（新建只在 Users 组的本地账户、授予批处理登录权、计划任务运行），并用拒绝 ACE 隐藏 PowerShell 7，让工具退回 Windows PowerShell 5.1；探针读文件时兼容 5.1 的 UTF-16LE 输出；
    - 触发：推送到 `ci/dsh-p1-6d-windows` 分支或手动 `workflow_dispatch`。本任务没有推送、没有触发。
19. **S18 不进 `bridge-record` 金样本**：录制器用 `/var/tmp`、`/proc`，路径归一化也是 Linux 的，Windows 上的记录没法与金样本逐字节比较；S18 用断言式探针。

### 五、测试

20. 新增：`pwshAnalysis.test.ts`（表驱动 267 例：别名、保留原名与命名合法性 59，授权前缀 28，操作数 47，重定向 13，看不透的构造 78（含黑名单底线、UNC、上限 3 例），看不透的程序 7，exploration 33，POSIX 写法 2）、`pwshGate.test.ts`（13 例：别名互通、反向互通、大小写与扩展名、不可授权、工作区外、范围句、`bash` 策略面、`askReason` 四种档位与卡片载荷、活动行写 `pwsh`）。
21. 改：`permissionHost.test.ts`（「pwsh 每条都看不透」一例换成真实分析、`$env` 展开、pwsh 的黑名单三例）、`permissionsLibraryBoundaryStatic`（来源标签允许 `New in dsh-rebase P1-6a～e`）、`questionCardModel.test.ts`（别名说明与原因句 5 例）、`permissionActivityRow.test.ts`（PowerShell 活动行 2 例）、`questionCardWiring.test.ts`（卡片渲染原因行）、`chatSessionsCore.test.ts`（`askReason` 进块、不进队列）。

## 取舍

- 每个字面词都登记而不是只登记「像路径的词」：前者多出的都是工作区内的候选，没有代价；后者会漏掉 `Get-Content .env`。
- 看不透的文本不可授权：宁可多问（任务硬要求），也不让一次「本会话允许」盖住读不懂的代码；看不透的程序（解释器）仍可授权，与 bash 一致，避免 Windows 上的 Python 开发者在 auto 档下每次都被问。
- 原因放在闸门算，而不是渲染层猜：只有闸门知道档位与授权，渲染层看到的只是卡片。
- `askReason` 做成可选的第四参数而不是请求字段：原因是判定结果，不是请求的一部分，也不该进活动行与授权记忆。

## 影响

- **auto 档下 Windows 的卡片**：cmdlet 加字面参数的命令（绝大多数）不再出卡；余下的卡有原因句解释。决策 046 担心的「Windows 更常问」缩小到含变量、脚本块、调用符的命令。
- **1.0.x 自有 runtime**：auto / accept-edits 下读不懂的 bash 卡片多一行原因句；事件形状只多一个可选字段，`guiEventContract`、`nativeStreamReplay` 的样本不变。
- **金样本**：`bridge-record.ts --check` 28 个场景无差异，不需要重录（Linux 的 perm-* 场景都在 ask / bypass 档，或没有读不懂的命令）。
- **没有改**：`implementation-status.md`、`roadmap.md`、`package.json` 与锁文件、宿主的 bundle 补丁。

## 对既有决策的修订注记

- [决策 046](046-pwsh-conservative-lexical-analysis.md)：已按本决策落地；与原文的差异见第 3、4、7 条。
- [决策 120](120-p1-7c-tool-rows-choices.md) 第 24 条：两句已由本决策第 14、15 条补上；「影响与遗留」里「授权活动行因此写『已允许 bash』」不准确，实际写的是「已允许 pwsh」，现改为「已允许 PowerShell」（第 16 条）。
- [决策 088](088-permission-gate-wiring-choices.md)「留给后续」的「P1-6d：pwsh 目前一律按『解析不出』处理，每条都会出卡」：已由本决策解决。

## 待用户拍板

- **第 4 条**：pwsh 下含变量、脚本块、执行字符串的命令一律不可授权（比 bash 严）。
- **第 7 条**：`sc`、`curl`、`wget` 不归一（偏离方案原文）。
- **第 13 条**：原因句也出现在 1.0.x 的 bash 卡片上。
- **第 16 条**：活动行 pwsh 写 PowerShell、bash 仍写 `bash`。

## 遗留

- **Windows CI 未跑**：推送 `ci/dsh-p1-6d-windows`（或手动触发）之后看两路的「Gate on report」与上传的报告；预期 14/14。没在真 Windows 上跑过的点：DSH 的 pwsh 工具在 5.1 下对 `Set-Content`、`>` 的实际行为，`Get-Acl` 在标准用户下的读取，从源码检出起宿主的路径解析。
- **GUI 点验**（本机不启动 Electron）：PowerShell 卡的范围句与别名说明、原因行的位置与颜色、活动行「已允许 PowerShell」，深浅两套主题。
- **后续提升**（决策 046 第 4 条）：换成 tree-sitter-powershell 时接口不变；`sc` 等随版本变化的别名届时可按实际版本判断。
