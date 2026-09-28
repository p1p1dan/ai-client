# 决策 084：P1-13 加密机第一轮的判读

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：[证据目录](../evidence/p1-13-encrypted-2026-09-28/README.md)（现场三轮报告、人工观察、现场改过的脚本）。

## 结论

1. **不触发否决，但也不能签收。**
   - `.txt` 的全链路都读到明文：DSH read、grep、glob、edit、write 后回读，pwsh 工具，node-pty 终端，`%TEMP%` spill，会话日志解码与恢复，原生模块从加密区缓存加载。
   - 签收还差三件事：
     - 其他扩展名的覆盖情况不清楚。现场另有两处读到密文的旁证：PowerShell 把一个 `.ps1` 读成了 TSD 容器；Node 把 PowerShell 写进 `~/.dsh` 的 `cordis.patch.yml` 读成了 TSD 容器；
     - 两轮都在管理员高权限（EnableLUA=0）下跑，普通权限下的 ACL 沙箱没有验收；
     - 缓存、插件、spill 等产物没有逐个人工确认加密状态。
2. **node.exe 新建的文件不加密：是不是 DSH 引入的回退，还没定。**
   - 现象：DSH write 新建的文件、会话日志不加密，而 PowerShell、Git Bash、pwsh7 新建的文件都会加密。
   - 同样的结果在我方沙箱开、关两组和官方 DSH Desktop 对照组里都出现了。
   - 最初推断「v1.0.x 用的是同一个 node.exe，所以结果一样」。**2026-09-28 更正**：读代码发现两者的写法不同，这个推断没有依据。
     - DSH（`dsh-fs-local` 的 `writeFileAtomic`）新建文件时，先在隐藏目录 `.<名>.<pid>.<uuid>.tmpdir` 里以 `wx` 写一个 `.tmp` 文件，再用 `link()` 硬链接成目标文件名。目标文件名本身从来没有被打开写入过；
     - DSH 改已有文件时，在 Windows 上走 `ReplaceFileW`；
     - v1.0.x（`src/runtime/host/io.ts`）直接 `writeFile(path, bytes, {flag:'w'})`。
   - 加密驱动很可能只在「以目标名打开写入」时才加密，所以 DSH 的硬链接写法可能正是新文件不加密的原因。P1-13b 的 `W-node-create`（1.0.x 的写法）和 `W-node-dsh-create`（DSH 的写法）两列对比后再判：
     - 两列都不加密：是载体和策略本身的性质，不算回退，交给 [Q009](../open-questions.md)；
     - 只有 DSH 那列不加密：是 DSH 引入的回退，要在宿主里修（新文件改为直接写目标名），不能只当合规问题处理。
   - 在结果出来之前，产品里不做绕行。
3. **随包载体的文件名保持 `node.exe`，不改名。**
   - 依据：DSH Desktop 用的是它自带的另一个 node.exe（v24.9.0，路径不同），也能解密 `.txt`。据此推测策略按进程名匹配。
   - 这条推测由 P1-13b 的改名副本读者验证。验证之前，打包时不给载体改名、不换路径层级。
4. **Q002（DSH 沙箱能否兜底）暂不裁决。**
   - 沙箱开、关两组的读写结果一样，ACL 授权也写上了能力 SID 和完整性标签；
   - 但只测了管理员权限，[决策 044](044-dsh-sandbox-off-by-default-in-p1.md) 的「默认关」维持不变。
5. **上机包的四处缺陷改在仓库里**：
   - 吸收现场加的人工加密等待点（`-ManualEncryption`）、人工证据字段和管理员标记；
   - 「PowerShell 是非白名单观察者」这个假设不成立，改为「PowerShell 读取视图，可能被透明解密」；
   - 对照组的 DSH_HOME 应该是 `%APPDATA%\dsh-desktop\harness`，原脚本写到了 `~/.dsh`；
   - G-pnpm-install 检查随[决策 082](082-allowlist-implementation-choices.md) 一起改掉。
   - 已在 `fd8f2ac9` 修掉前三处。对照组的备份方式也改了：原来是复制到 `%TEMP%`、结束时再复制回来；现在改成在同一目录里改名为 `*.p0-4-backup-<时间>`，结束时改回。原因是用 PowerShell 复制回去可能把用户原有的配置加密，桌面端就读不了了（第一轮见过 Node 把 PowerShell 写的 `cordis.patch.yml` 读成密文）。

## 下一步

- **P1-13b 加密矩阵**：上机包已就绪（`fd8f2ac9` 构建，`/var/tmp/aiclient-p1-13b-kit/aiclient-p1-13b-kit.zip`，sha256 `4a5ea708e17f6511c334e777ff54cccb78f2376f7b076f58ea55ca9f6b33b652`，手册 [p1-13b-encryption-matrix-runbook.md](../topics/p1-13b-encryption-matrix-runbook.md)），请用户上机。它的 PowerShell 脚本在开发机上没法跑，第一次执行就在加密机上。内容：
  - 「扩展名 × 读者」：随包 node.exe、Electron 主程序以 node 模式运行、改名的 node 副本、PowerShell、certutil、Git Bash；
  - 「扩展名 × 写法」：直接新建（1.0.x 的写法）、DSH 的暂存再硬链接、先写临时文件再改名、先复制已加密文件再覆盖、原地改写、PowerShell 写；每种写法立即检查一次，延迟 60 秒后再检查一次；
  - 找出能看到原始字节的观察者，今后不必全靠人工确认。
- 第二轮完整上机要等 GUI、真实模型、MCP、插件、离线迁移都落地之后（合入前）。届时如果条件允许，用普通权限账户跑一次。
