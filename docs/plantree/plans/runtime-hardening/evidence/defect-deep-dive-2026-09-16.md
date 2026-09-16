# 缺陷深查报告存证（2026-09-16，Windows 11 主机实测）

Role: evidence。全量归因（[vitest-attribution-2026-09-16.md](vitest-attribution-2026-09-16.md)）点名的 C 类缺陷经一名 opus 只读代理逐条实测核实（真实测试运行 + Windows 语义探针，探针已删、工作区无残留）。本文是拍板依据的存证；修复任务见 roadmap 批次 D3 的 T057。

## 汇总

| # | 缺陷 | 定性 | 置信度 | 建议 |
|---|---|---|---|---|
| 1 | shellPolicy：junction/symlink + `..` 越界（`plugins/tools/paths.ts:6-20`） | **真实安全缺陷（Windows 专属）** | 高（实测复现：命令读到工作区外文件、零审批） | 立即修（T057 主修方案） |
| 2 | `normalizeWorkerPath()` POSIX 分支用原生 `resolve`（`workerSessionKey.ts:29`） | 真实但防御性（生产无可达输入） | 高 | 顺手修（T057） |
| 3 | promptService 两条（UTF-8 截断 / 越界 symlink） | **测试假失败**（harness hermetic 泄漏），产品逻辑清白 | 高 | 断言修正（T057）；另生出 Q015 |
| 4 | `resolveAllowedLocalFileReadPath` 返回小写路径（`LocalFileAccess.ts:95,107`） | 真实但影响小 | 高 | 顺手修（T057） |
| +1 | `shellPolicy.test.ts:109` 缺引号 | 测试假失败（用例写法） | 高 | 随 T057 加引号 |

## 1. shellPolicy 越界（唯一的阻塞级）

- **机理**：守卫与执行者两套路径语义。守卫链 `checkShellPaths`（`plugins/tools/index.ts:243-256`）→ `canonicalPath()`（`plugins/tools/paths.ts:6-20`）→ Node/Win32 `realpath`——Win32 在文件系统看到路径**之前**按字符串折叠 `..`，`<ws>\link\..\secret` 被读成 `<ws>\secret`；执行者 Git Bash 是 POSIX 语义（先解析链接再应用 `..`），实际打开链接指向处外面的文件。`containsPath()`（`permissions/index.ts:452-455`）与 `pathPolicy()`（`:487-522`）被同一套错误 canonical 骗过。
- **升级点**：① junction（`mklink /J`）无需任何特权即可构造，pnpm `node_modules` 里天然大量存在；② 实测「指向工作区自身的 junction + `..`」构成 accept-edits 档下**零审批完整逃逸链**，经 `link/../../..` 可覆盖整个盘符；③ 内置不可覆盖 deny（`~/.ssh/*`、`~/.aws/credentials`）一并失效；④ 默认 ask 档卡仍弹但显示错误路径（知情同意被污染）。
- **边界**：仅 bash 通道（read/write/edit 用 canonical 做实际 IO，不逃逸）；POSIX 平台无此洞。
- **修法**（用户拍板主修方案）：`canonicalPath` 逐段规范化——`..` 作用在已 realpath 的前缀上；仅路径含 `..` 段才走新分支，热路径逐字节不变。残余风险（记录在案）：MSYS 挂载点、8.3 短名、NTFS 数据流等其它语义差异仍在，bash 通道的路径判断是尽力而为。

## 2. workerSessionKey

POSIX 分支 `path.resolve` 在 Windows 上把 `/tmp/...` 挂到当前盘符。key 是 worker 槽位主键（创建/复用/身份冲突/清扫删文件），但生产输入盘点确认无可达的 POSIX 风格输入（本机路径全走 Windows 分支）。修 `path.posix.normalize` + 入口绝对路径断言。

## 3. promptService（定性反转）

两条失败同因：Windows 上 `tmpdir()` 在 `C:\Users\<user>` 之下，指令加载器**按设计**向上爬祖先目录（`projectInstructions.ts:97-110`），读到开发机真实 `~/.claude/CLAUDE.md`。实测：`limitUtf8` 按码点截断生效、HostIo `stream` 解码 UTF-8 安全、越界 symlink 确实被跳过（readFile 只被调了一次且不是越界目标）——红的只是过严断言。`hermeticHome.ts` 只改 HOME/USERPROFILE，管不住「工作区路径本身位于真实 home 之内」。

**附带产品观察（已立 Q015）**：Windows 用户仓库多在 `C:\Users\<user>` 下，`~/.claude/CLAUDE.md` 会经 project 层爬入系统提示——不受 `settingSources` 的 user 层开关控制（决策 008 只管 user 层那份），且排最外层优先消耗 32 KiB 共享预算，可能挤掉工作区 AGENTS.md。

## 4. localFileReadGuard

`normalizePathForComparison()`（win32/darwin 整串 toLowerCase）的产物被当返回值交出（`LocalFileAccess.ts:107`）。唯一消费方是 `local-file://` 协议处理器（`main/index.ts:439-448`）：Windows 无害但路径展示失真；**macOS 大小写敏感卷上本地预览 404**。修「比较用小写、返回原始 realpath」。
