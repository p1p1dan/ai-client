# D1 决策论证 · native worker 的 bash 载体

> 状态：**待现场数据拍板**（Linux 侧论证完成，判定探针已就绪）
> 提出：`Windows-P4-6-evidence/linux-side-punch-list.md` 的 D1 条
> 相关：ARD [D11 执行载体](2026-09-08-runtime-evolution-ard.md#d11--执行载体按进程身份区分不按实现语言推断) · ARD §8 加密机实测记录

## 1. 问题

test.11 的 native worker 用**系统安装的 Git for Windows** 的 `bash.exe` 作为 shell，
而 D11 的立论是「随包 `node.exe` 是现场已验证的白名单载体」。
bash 走系统路径，不在这条白名单论证的覆盖范围内——**它是包外的第三个载体**。

若企业加密驱动放行 `bash.exe`，现状即可签收；若不放行，加密机上的 bash 工具会重蹈
GUI 当初的密文/`Bad file descriptor` 问题，而普通 Windows 与 CI 全绿都不能代签（D11 第 6 条）。

## 2. 现状事实（已在 Linux 侧核对源码，非推测）

| 事实 | 出处 |
|---|---|
| native worker 把 shell 交给 `resolveWorkerShell(host.childEnv)` | `src/runtime/worker/nativeWorkerRuntime.ts:136` |
| 搜索序：`%ProgramFiles%`/`(x86)`/`%LOCALAPPDATA%\Programs` 下的 `Git\bin\bash.exe` → PATH 各项的 `bash.exe`（跳过 system32/sysnative 与相对项）→ PATH 里 `...\cmd` 同级的 `..\bin\bash.exe` | `src/runtime/host/shell.ts` |
| bash 工具固定以 `--noprofile --norc -c <command>` 调用，找不到 shell 则抛 `shell_unconfigured` | `src/runtime/plugins/tools/index.ts:307-314` |
| 实际进程树：随包 `node.exe`(worker) → 随包 `node.exe`(`exec-runner.mjs`) → `bash.exe` → coreutils（`cat.exe` 等） | `src/runtime/host/exec.ts:146-147`、`src/runtime/host/exec-runner.mjs:10` |
| 安装包**不含** git/bash：`extraResources` 只有 model-catalog 等，`afterPack.mjs` 只做 `copyAgentHost` + `copyNodeRuntime` | `electron-builder.yml:76`、`scripts/afterPack.mjs:20-21` |
| 现场旧包（test.9）安装目录确认无 `resources/git/bin/bash.exe`，本机 Git 为 2.45.2.windows.1 | `Windows-P4-6-evidence/environment.md` |

**读明文的是叶子进程**：`cat notes.txt` 由 `bash.exe` fork 出的 `cat.exe` 完成，
不是随包 `node.exe`。所以「worker 在白名单里」这个已验证事实**不覆盖 bash 工具**。

## 3. 为什么不能换成 cmd.exe / PowerShell

bash 不只是执行器，还是权限判定链的一环：`shellPolicy` 用 tree-sitter-bash 解析命令 AST
来拦截 `.env`/`~/.ssh` 一类操作数（26 项测试）。换 shell 等于同时换掉解析器与策略语义，
`--noprofile --norc -c` 也不是 cmd/PowerShell 的等价参数。**这不是替换一个二进制的成本，是重做一层权限。**

## 4. 决策卡在唯一一个未知量

加密驱动按**进程名 / 路径 / 签名 / 父进程**哪一种放行——ARD §6「不做的事」已明确记为未确认。
这个量决定了下面所有选项的排序，且**只能由现场测出**。

现有间接证据（按强度标注，都不足以拍板）：

| 证据 | 指向 | 强度 |
|---|---|---|
| D13 记「`git.exe` 写 `.git/HEAD` 出自白名单内进程」 | 同一 Git for Windows 安装的 `bash.exe` 可能同策略 | 中。且这条判断本身是推断，需现场确认 |
| ARD §8：PI-Desktop 的 Rust host-core 直接读写不可行，「仅能通过 bash/powershell 工具间接操作」 | 该机器上经 shell 的间接读写是可用路径 | 中。未记录用的是 bash 还是 powershell、是否真的看到明文 |
| D13：`.git` 元数据不在加密策略内 | **反向提醒**：git 命令正常不能反推 bash 能读明文 | — |
| CI Windows native 冒烟 `probe_bash` 通过 | 只证明非加密机可用 | 零（D11 第 6 条） |

## 5. 选项

| 选项 | 代价 | 何时选 |
|---|---|---|
| **A. 维持系统 Git Bash**（现状） | 0 体积；但依赖现场装有 Git for Windows，换机/未装即 `shell_unconfigured` | 探针 R1 得到明文时。首选 |
| **B. 随包 Git Bash（MinGit 一类）** | 数十 MB 体积 + 需要 fetch/PIN/afterPack 一整套（照抄 node-runtime 那条链）+ msys2 运行时依赖 | 仅当 R2 证明驱动**按路径或签名**放行。**注意：随包 ≠ 白名单**——白名单是驱动侧配置，不由我们控制，B 不自动更安全，这正是 ARD §6 拒绝引入 Rust 载体的同一条理由 |
| **C. Windows 不提供 bash 工具** | 能力大幅退化（grep/构建/git 操作全断） | 仅当 A、B 都被现场否掉，且作为临时降级 |
| **缓解（可与 A 并行）**：提示词层引导「读写文件内容用 file 工具、不要用 `cat`/`>` 重定向」 | 低；但只是概率性缓解，模型不保证遵守 | R1 失败且短期要交付时 |

## 6. 现场判定探针（数据一来即可拍板）

在**受加密策略的目录**下、用 test.11 安装版执行。每项填结果即可映射结论。

| 编号 | 步骤 | 观察 | 结论映射 | 现场结果 |
|---|---|---|---|---|
| R0 | 记录本次实际选中的 bash 路径（`Get-Process bash \| Select Path`，或看 worker 的子进程命令行） | 一个绝对路径 | 后续所有结论的前提；无此项则证据不成立 | ⬜ |
| R1 | 先用 GUI 的 write 工具写 `probe-a.txt`（内容 `hello-42`），再用 bash 工具 `cat probe-a.txt` | 明文 `hello-42` | **选 A 并锁定**，写入 ARD §8 | ⬜ |
| | | `%TSD-Header-###%` 开头的乱码 | `bash.exe` 不在白名单 → 进 R2 | |
| | | `Bad file descriptor` / 空输出 | 载体级失败（与 GUI 当初同类）→ 进 R2，并单独记一条 | |
| R2 | 在 bash 工具里调随包 node 读同一文件：`"/d/Program Files/AiClient/resources/node-runtime/node.exe" -e "console.log(require('fs').readFileSync('probe-a.txt','utf8'))"` | 明文 | 放行按**进程名/路径**、与父进程无关 → B 无效，走缓解或 C | ⬜ |
| | | 仍是密文 | 放行受父进程/进程树影响 → 值得评估 B | |
| R3 | 把随包 `node.exe` 复制为 `bash-probe.exe` 后执行同一读操作 | 明文 | 按签名或按目录路径放行 → B 可行 | ⬜ |
| | | 密文 | 按进程名放行 → B 不可行 | |
| R4（可选，健壮性非决策项） | 临时把 Git 从 PATH 与默认目录移开后调用 bash 工具 | 报 `shell_unconfigured` 而非崩溃/挂起 | 确认无 bash 时的失败是干净的 | ⬜ |

## 7. 建议

**按 A 收，用 R1 一票拍板。** 理由：A 的代价为零，且现有两条中等强度证据都指向该机器放行 shell 类进程；
B 的成本（体积 + 一整条打包链 + msys2 依赖）只有在 R2/R3 明确证明「按路径或签名放行」时才划算，
在那之前引入随包 bash 等于按 ARD §6 自己否掉的方式再加一份未验证载体。

## 8. 附：一个会削弱现场证据的缺口

`version_stamp` 记了 `carrier` / `node_source` / `node_exec_path`，**没有记 shell 路径**
（`src/runtime/bootstrap.ts:216-221`）。因此现场无法像确认随包 node 那样，
用 trace 直接自证「这次 bash 用的是哪一个 bash.exe」，只能靠 R0 手工抓进程。

补法很小（在 stamp 里加一条 `shell_path`），但 D1 尚未拍板、属计划期，
**未改源码**，留作决策落地时一并处理。
