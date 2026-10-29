# 加密机上的内容搜索（2026-10-28，脱敏摘要）

起因：另一位用户反馈全局搜索的「内容」页搜某个编号没有结果。我们先怀疑是随包的 rg.exe 在加密机上只能读到密文，于是写了探针 `src/dsh-host/tools/encrypted-search-probe.mjs`，交给加密机上的 PiLab 去测。原始输出只留在那台机器上，不入库。

**结论：这个怀疑不成立。** 后来查明，那次反馈是误会：用户想找的是聊天记录，而这个搜索框只搜工作区里的文件。

## 环境

- 用户的加密测试机，应用装在非默认目录，随包 node v24.22.1。
- 应用主进程是高完整性级别（已提权）。测试用的 shell 也是管理员权限，和应用主进程处在同一种权限下。

## 实测

样本：工作区里 3 个加密的 `.md`，用 PowerShell 按字节读，文件头都是 `%TSD-Header-###%`；另外两个明文样本，一个 `.json`、一个 `.jsonl`（3.1 MB）。三个样本搜的是同一个真实存在的词。

| 方式 | 加密 `.md` | 明文 |
|---|---|---|
| node 一次读完 / 流式读 | 搜到 | 搜到 |
| node 启动 rg，单文件，打开或关掉内存映射 | 搜到 | 搜到 |
| node 启动 rg，扫整个目录（全局搜索的调用方式） | 搜到 | 搜到 |
| node 启动 rg，搜加密标记 `%TSD-Header-###%` | 搜不到，说明 rg 拿到的是明文 | 搜不到 |
| node 读出明文，交给 rg 从输入里搜 | 搜到 | 搜到 |
| cmd 启动 rg / PowerShell 启动 rg | 搜到 | 搜到 |
| git grep --no-index | 搜到 | 搜到 |
| findstr / PowerShell Select-String | **搜不到** | 搜到 |

另外用 `SearchService.searchContent` 的真实参数完整复现了一次：加密 `.md` 里的内容以明文出现在结果里，大小限制和 `.gitignore` 都没有挡掉这些文件。

## 判读

- 在这台机器上，rg.exe 读加密文件和 node.exe 一样拿到明文，与父进程是谁无关。
- [P1-13c](p1-13c-windows-read-fallback-2026-09-29.md) 记过「rg 对加密文件无匹配」，那次测的是 `.yml`。在 [P1-13b](p1-13b-encryption-matrix-2026-09-28.md) 里，`.yml` 连 node 也只能读到密文，所以那条记录不能推广成「rg 比 node 读不到的更多」。
- 内容搜索读不到的，是 node 也解不开的那几类文件（P1-13b 第一节：yml、rb、php、ps1、cmd、sql、scss、docx、pptx），以及 Office、PDF 这类压缩或二进制格式。
- 遗留：没有在非提权进程下复测。`runas /trustlevel` 被策略拒绝，现场没有绕过。
