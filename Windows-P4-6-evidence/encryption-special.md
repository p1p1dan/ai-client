# 企业加密专项 · 现场证据（test.11 / 本机 TEC OCular）

> 生成：2026-09-09 · 应用：`D:\Program Files\AiClient\AiClient.exe`（1.0.0-test.11，源码 b6aa0844）
> 整机在 TEC OCular 加密策略内（TsdEncrypt.sys / TsdEncryptMF.sys 均 RUNNING）。
> 重要前提（用户确认）：**新文件会被加密**；是否立即加密取决于写入者；**本地 node 与 git 因被广泛使用，大概率在白名单内**。
> 结论：白名单内进程（随包 node / 系统 Git Bash）透明读明文；非白名单进程（PowerShell 原生读）得到 `%TSD-Header-###%` 密文容器。

## 载体差分证据（同一真实密文文件）

测试目标：`C:\Users\JC\Desktop\compass_artifact_wf-..._text_markdown.md`（TEC 加密的存量文件，非白名单 PowerShell 读为密文容器 20480 字节）。

| 读取者 | 结果 | 判定 |
|---|---|---|
| 随包 `node.exe`（`resources\node-runtime\node.exe`，D11 worker 载体） | 明文 `# MTF测量方法深度技术对比...`，真实大小 15730 | 白名单 → 透明解密成立 |
| 系统 Git Bash（`C:\Program Files\Git\bin\bash.exe`，test.11 bash 载体） | 明文（bash 读解码 UTF-8 正常） | 白名单 → 无 `Bad file descriptor` |
| PowerShell 原生 `[IO.File]`（非白名单参考） | `%TSD-Header-###%` 密文，容器 20480 | 对照：非白名单得到密文 |

另一密文样本 `D9PTest.xlsx`（45056 容器）：非白名单读密文 `%TSD-Header-###%q.?`；Git Bash 读明文 ZIP 头 `PK 03 04`。同上判定。

## 关键结论：本项目加密加固项已验证正确

1. **D11 载体机制成立**：白名单（随包 node / Git Bash）透明解密密文，非白名单得到密文。同一文件三载体差分即为证据。
2. **D1 风险解除**：test.11 的 bash 载体（系统 Git Bash）在白名单内，不会重蹈 GUI 的句柄/密文问题。（此前担心的"bash 走系统路径不在白名单"被本机实测否定。）
3. **D13 链路必要且正确**：Main 侧（非白名单）读用户工作区文件必须走 `readFileTsdSafe`（`tsdSafeRead.ts`），否则拿到密文。`encoding.ts` 已接入：`detectBinaryFile` 先 `isFileTsdEncrypted` 探针 → 命中才解密后按内容判二进制（防止整片文本区被误判为二进制）；`readWorkingTreeFile` → `readFileTsdSafe`；GitService diff 工作区侧走 `readWorkingTreeFile`。
4. **测试覆盖**：`tsdWorkingTreeRead.test.ts` 6 项（含"真容器判二进制→探针""解密后按内容判""纯文本不触发派生"），用 stub 冒充白名单 node，逻辑全链验证。
5. **worker 产出明文**：test.11 native 会话写 `test123.txt`（49 字节 UTF-8 明文）落盘正确（非白名单侧读为明文——因写入者为白名单随包 node）。

## 未决/后续

- 本机工作区（E:）新写文件当前实测为明文（写入者白名单），Main 裸读不会遇密文；但**若用户在加密域（如 Desktop/经 IDE 或手动编辑）触发加密后，Main 读取即走 tsdSafeRead 解密**——该真实加密态下的 GUI 读/Edit 一致性仍需在加密域目录现场复验，非本机普通路径可代签。
- 加密域的 GUI 读明文 / Edit 后 TUI·编辑器一致 / 退出无残留：需在真实加密域目录做一次 GUI 实测（依赖用户交互或现场）。

## 临时探针（未保留，已清理）

本轮创建于 `Windows-P4-6-evidence/encryption-probe/` 的 carrier-probe.js/.cjs、read-tsd.cjs、probe-tsd-state.ps1、pwsh-write-test.ps1、diff-read.ps1、scan-tsd.ps1、scan-out.txt 及若干 `_tsd_probe_*.txt`，均为一次性载体差分探针，已删除，不留在工作区。
