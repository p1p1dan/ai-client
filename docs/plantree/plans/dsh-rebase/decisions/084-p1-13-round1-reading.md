# 决策 084：P1-13 加密机第一轮的判读

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：[证据目录](../evidence/p1-13-encrypted-2026-09-28/README.md)（现场三轮报告、人工观察、现场改过的脚本）。

## 结论

1. **不触发否决，但也不能签收。**
   - `.txt` 的全链路都读到明文：DSH read、grep、glob、edit、write 后回读，pwsh 工具，node-pty 终端，`%TEMP%` spill，会话日志解码与恢复，原生模块从加密区缓存加载。
   - 签收还差三件事：
     - 其他扩展名的覆盖情况不清楚。现场另有两处读到密文的旁证：PowerShell 把一个 `.ps1` 读成了 TSD 容器；Node 把 PowerShell 写进 `~/.dsh` 的 `cordis.patch.yml` 读成了 TSD 容器；
     - 两轮都在管理员高权限（EnableLUA=0）下跑，普通权限下的 ACL 沙箱没有验收；
     - 缓存、插件、spill 等产物没有逐个人工确认加密状态。
2. **node.exe 新建的文件不加密，不算 DSH 引入的回退。**
   - 现象：DSH write 新建的文件、会话日志不加密，而 PowerShell、Git Bash、pwsh7 新建的文件都会加密。
   - 同样的结果在我方沙箱开、关两组和官方 DSH Desktop 对照组里都出现了。
   - DSH 宿主和 v1.0.x 的 worker 用的是同一个 `resources/node-runtime/node.exe`、同一套 Node fs，所以按推断 v1.0.x 的写文件工具也一样。这一点将由 P1-13b 用裸 node.exe 直接验证。
   - 这是一个合规问题，不是功能故障，交给用户（[Q009](../open-questions.md)）。在用户拍板之前，产品里不做绕行，例如改由 PowerShell 代写新文件。
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

## 下一步

- **P1-13b 加密矩阵**：上机包做好后请用户上机，内容：
  - 「扩展名 × 读者」：随包 node.exe、Electron 主程序以 node 模式运行、改名的 node 副本、PowerShell、certutil、Git Bash；
  - 「扩展名 × 写法」：直接新建、先写临时文件再改名、先复制已加密文件再覆盖、原地改写、PowerShell 写；每种写法立即检查一次，延迟 60 秒后再检查一次；
  - 找出能看到原始字节的观察者，今后不必全靠人工确认。
- 第二轮完整上机要等 GUI、真实模型、MCP、插件、离线迁移都落地之后（合入前）。届时如果条件允许，用普通权限账户跑一次。
