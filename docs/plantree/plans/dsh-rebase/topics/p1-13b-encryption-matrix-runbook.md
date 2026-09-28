Role: topic

# P1-13b 加密矩阵上机步骤（文件类型 × 读者 × 写法）

建立：2026-09-28。上位：[roadmap P1-13](../roadmap.md)、[决策 084](../decisions/084-p1-13-round1-reading.md) 的「下一步」。结论回填 [Q009](../open-questions.md)，以及决策 084 第 2、3 条里「由 P1-13b 验证」的两处推测。

- 第一轮证据：[p1-13-encrypted-2026-09-28](../evidence/p1-13-encrypted-2026-09-28/)（`p1-13-field-summary.md` 与三个 `report-*` 目录的人工观察记录）。
- 第一轮上机步骤：[P1-13 runbook](p1-13-encrypted-machine-runbook.md)。本轮不起 DSH 宿主，与它互不依赖。
- 工具：`src/dsh-host/tools/p1-13b/`（`run-p1-13b.ps1`、`matrix-probe.mjs`、`build-kit.mjs`）；单测 `scripts/__tests__/p1-13b-matrix-probe.test.mjs`。

## 目的

回答三个问题：

1. **随包 node.exe 能解密哪些扩展名。** 第一轮只测了 `.txt`。另有两处旁证读到了密文：PowerShell 把一个 `.ps1` 读成 TSD 容器；node 把 PowerShell 写的 `cordis.patch.yml` 读成 TSD 容器。
2. **node.exe 新建的文件为什么不加密。** 第一轮三组（我方沙箱开、关，官方 DSH Desktop）里，DSH write 新建的 `.txt` 都没加密；PowerShell、Git Bash、pwsh7 新建的都加密；DSH edit 改过的已加密文件仍加密。
3. **策略是不是按进程名匹配。** 决策 084 据此不给随包载体改名，但没有直接证据。

纯本地文件读写：不起 DSH 宿主、不起网关、不联网、不调用任何模型。

## 背景：两条写路径不一样

读代码确认了一点，这是本轮拆出两个「新建」写者的原因：

- **DSH write 新建文件**（`dsh-fs-observation-policy` 判为 `createIfAbsent`）：`dsh-fs-local` 的 `writeFileAtomic` 先在同目录建隐藏暂存目录 `.<名>.<pid>.<uuid>.tmpdir`，在里面以 `wx` 写 `<名>.tmp` 并 `fsync`，再用 `link()` 硬链接成目标名，最后删掉暂存目录。**目标名从来没有被打开写入过**，文件是以 `.tmp` 的名字创建的。
- **DSH write / edit 改已有文件**：同样先写暂存的 `.tmp`，在 Windows 上用 `ReplaceFileW`（koffi 调 kernel32）替换目标。
- **1.0.x 的写文件与编辑工具**：`src/runtime/host/io.ts` 的 `writeFile(path, bytes, { flag: 'w' })`，直接以目标名打开写入。

所以第一轮「DSH write 新建不加密」不能直接外推到 1.0.x（[Q009](../open-questions.md) 的「范围」一条是按同一个 node.exe 推断的）。本轮用 `W-node-create`（1.0.x 的写法）与 `W-node-dsh-create`（DSH write 的写法）分开看。

## 矩阵

### 输入

- 在 `EncDir\p113b-<时间>\in\` 下，由 **PowerShell** 按类型各建一份，共 51 个：
  - 46 个扩展名 `p113b.<ext>`：txt md json jsonl yml yaml toml ini cfg conf ts tsx js mjs cjs py java go rs c cpp h hpp cs kt rb php sh ps1 bat cmd sql xml html css scss vue csv log patch diff lock docx xlsx pptx pdf；
  - 无扩展名：`Makefile`、`Dockerfile`、`README`；
  - 产品真实会写的文件名：`.env`、`session.v4.jsonl.zstd`。
- 内容是一行 `P113B-MARKER-<nonce> <类型> plaintext line`。nonce 每轮随机生成。
- 加 `-ManualEncryption` 时脚本暂停，等用户用加密客户端把整个 `in` 目录加密并写确认文件。

### 读者（每个文件读前 64 字节）

| 读者 | 进程 | 读法 | 用来看什么 |
|---|---|---|---|
| R-node | `AppDir\resources\node-runtime\node.exe` | `fs.readSync` | 产品载体看到什么 |
| R-electron | AppDir 根目录的 Electron 主程序（`PiLabAi.exe`），`ELECTRON_RUN_AS_NODE=1` | 同一脚本 | 1.0.x 主进程读文件的载体；找不到或起不来就记「跳过」 |
| R-renamed | node.exe 的副本 `%TEMP%\p113b-<时间>\p113b-raw.exe` | 同一脚本 | 策略是否按进程名匹配；也是「原始字节观察者」候选 |
| R-ps51 | Windows PowerShell 5.1（脚本本身） | `[IO.File]::ReadAllBytes` | 第一轮已知会被透明解密 |
| R-pwsh7 | PowerShell 7（装了才测） | `[IO.File]::ReadAllBytes` | 另一个进程名 |
| R-certutil | `System32\certutil.exe` | `certutil -dump`，只输出到 stdout | 系统自带、未必在白名单里的观察者候选 |
| R-bash | Git Bash（找得到才测） | `head -c 64 \| od` | 实际读文件的是 `usr\bin\head.exe` |

分类：含本轮标记串 → **P**（明文）；含 `%TSD-Header-###%` → **C**（TSD 头）；其他 → **O**；另有 M（文件不存在）、E（读取出错）、-（该读者未测）。

**有效观察者**：对「人工确认已加密」的输入读到 C 的读者，才算这个类型的有效观察者。一个类型可以有多个，也可以一个都没有；一个都没有时，这个类型的输出是否加密只能靠人工确认。没加 `-ManualEncryption` 时，有效观察者一个都不算。

### 写者（每个类型各写一份到 `out-<写者>\`）

| 写者 | 进程 | 写法 | 对应的产品路径 |
|---|---|---|---|
| W-node-create | node.exe | `writeFileSync(目标, 内容)`（flag `w`） | 1.0.x 写文件工具 |
| W-node-dsh-create | node.exe | 暂存目录里 `wx` 写 `<名>.tmp` → `link()` 成目标名 → 删暂存目录 | DSH write 新建文件 |
| W-node-rename | node.exe | 同上，但用 `rename()` 发布 | DSH 非 createIfAbsent 的新建 |
| W-node-copy | node.exe | `copyFileSync` 同类型的已加密输入，不改内容 | 用来解读下面两项 |
| W-node-copy-then-write | node.exe | 先 `copyFileSync` 已加密输入，再 `writeFileSync` 覆盖 | Q009 选项 C 的绕行办法 |
| W-node-edit-existing | node.exe | 复制已加密输入，读出，替换 `plaintext line`，原路径 `writeFileSync` 写回；读出的内容里没有这段文字就不写 | 1.0.x 编辑工具 |
| W-electron-create | Electron（RUN_AS_NODE） | `writeFileSync` | 1.0.x 主进程写文件 |
| W-renamed-create | 改名副本 | `writeFileSync` | 按进程名匹配的对照 |
| W-ps51 | Windows PowerShell 5.1 | `Set-Content` | 第一轮已知会加密的一方 |

- 每个写者写完，**立即**让全部读者读一遍；全部写完后，等到离最后一次写入满 `-DelaySeconds`（默认 60）秒，再**延迟**读一遍。两次都记，报告里有每次复读距写完的秒数。第一轮开启组的用户原话是「暂时未加密」，延迟复读就是查这个。
- 输出矩阵每格是「立即/延迟」，按这个类型的有效观察者判定：C 都读到 TSD 头；P 都读到明文；X 观察者之间不一致；O 都读到其他内容；E 观察者都读不了；? 没有有效观察者；F 写入失败；- 写者或该次复读没跑。

## 步骤

### 0. 准备

| # | 事项 | 怎么做 | 判据 |
|---|---|---|---|
| 0.1 | 机器 | 第一轮那台加密机；系统自带的 Windows PowerShell 5.1 | — |
| 0.2 | 应用 | 已装 PiLab Ai（第一轮是 v1.0.2，装在 `D:\Program Files\AiClient\PiLabAi`） | 有 `resources\node-runtime\node.exe` 与 `PiLabAi.exe` |
| 0.3 | 账户 | 能用普通办公账户就用普通账户；只能用管理员也行 | 报告记下是否管理员与 EnableLUA |
| 0.4 | 拷包 | 交付目录的 `aiclient-p1-13b-kit.zip` 与 `SHA256SUMS` 拷到不受策略的短路径，如 `C:\p113b\`；`Get-FileHash C:\p113b\aiclient-p1-13b-kit.zip -Algorithm SHA256` | 与 `SHA256SUMS` 里 zip 一行一致 |
| 0.5 | 解压 | `tar -xf C:\p113b\aiclient-p1-13b-kit.zip -C C:\p113b` | 得到 `C:\p113b\aiclient-p1-13b-kit\` 下 4 个文件 |
| 0.6 | 加密目录 | 第一轮用过的 `C:\Users\JC\p1-13-encrypted-test` 作 `-EncDir` | 工具包目录不能在它里面，脚本会检查 |

PowerShell 可能被透明解密，所以「PowerShell 读工具包文件能看到明文」不能证明工具包目录没受策略。真正的检查是脚本第一步：随包 node.exe 能不能跑起 `matrix-probe.mjs`。跑不起来时脚本会停下并提示换目录。

### 1. 运行

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& 'C:\p113b\aiclient-p1-13b-kit\run-p1-13b.ps1' -EncDir 'C:\Users\JC\p1-13-encrypted-test' -AppDir 'D:\Program Files\AiClient\PiLabAi' -ManualEncryption
```

- 必须用 Windows PowerShell 5.1（`powershell.exe`）。用 PowerShell 7 运行时脚本会直接退出：5.1 本身就是读者 R-ps51 与写者 W-ps51。
- 参数：`-EncDir`（必填）、`-AppDir`、`-ManualEncryption`（正式上机必加）、`-DelaySeconds`（默认 60）、`-GitBash`、`-RemoveWork`（结束时删工作目录；默认保留）。`-KeepWork` 仍可写，效果就是默认行为。
- 脚本先探测读者：Electron 主程序、改名副本、PowerShell 7、certutil、Git Bash，缺哪个就在报告里记「跳过」。

### 2. 人工加密

1. 脚本建好 `in` 目录后暂停，窗口列出 51 个文件名；`report-p113b-<时间>\manual-encryption-pending.json` 里也有清单。
2. 用户用加密客户端把整个 `in` 目录加密。
3. 在 `report-p113b-<时间>\` 下新建 `manual-encryption-confirmed.txt`：第一行 `CONFIRMED`，第二行起写备注，特别是客户端提示「不能加密」或「已跳过」的类型。第一行写 `ABORT` 则放弃本轮。脚本每 2 秒检查一次。

### 3. 等它跑完

- 51 个输入 × 7 个读者，9 个写者各两次复读。certutil 每个文件起一个进程，是最慢的一项。全程约 10～15 分钟，含 60 秒延迟。
- 结束时删掉改名副本和 `%TEMP%\p113b-<时间>\`，保留工作目录，窗口打印摘要前 80 行。

### 4. 人工查看输出

看 `summary.txt` 的「需要人工确认」一节：

- 列出的是**没有有效观察者**的类型。请用加密客户端查看工作目录 `out-*\` 下这些文件是否加密，按「目录 → 哪些文件未加密」记下。
- 逐个看不过来时，至少看摘要点名的几个类型：txt、md、json、yml、ts、py、docx、.env、session.v4.jsonl.zstd。其中 txt 可以和第一轮对照。

### 5. 发回什么

- 整个 `report-p113b-<时间>\` 目录：`matrix.json`（全部原始数据）、`summary.txt`（中文摘要）、`probe.log`、`manual-encryption-*`；
- 第 4 步的人工查看记录；
- 安全软件提示、应用界面意外弹出等情况的截图。

不要发回工作目录。报告里只有本轮随机标记串、本机路径和每个测试文件的前 64 字节。

## 需要用户人工确认的点

1. **输入确实加密了。** 在确认文件里写 `CONFIRMED` 之前，用加密客户端确认整个 `in` 目录已加密；客户端跳过的类型写进备注。有效观察者的判定完全建立在这一步上。
2. **没有有效观察者的类型的输出状态。** 见第 4 步。
3. **应用版本。** 报告里的应用版本取自 `PiLabAi.exe` 的文件版本，最好再报一下「关于」页的版本。
4. **异常现象。** 安全软件拦截改名副本或 certutil；运行 `PiLabAi.exe` 时弹出了应用界面（说明它没有按 node 模式运行，脚本会在 30 秒后按 pid 关掉它）。

## 怎么读结果

下面是判读方法，不是结论。

- **问题 1（node.exe 能解密哪些扩展名）**：看输入矩阵的 R-node 一列，只看有有效观察者的类型。R-node 是 P、观察者是 C：node.exe 读这个类型拿到明文。R-node 也是 C：拿不到明文。一个类型在所有读者眼里都是 P 时，既可能根本没加密，也可能所有读者都被透明解密，要结合用户备注与第 4 步的人工查看。
- **问题 2（新建文件为什么不加密）**：看输出矩阵，逐列对照。
  - `create` 与 `dshlink`、`rename` 对照：区分「node.exe 新建」与「以 `.tmp` 名字创建再发布」；
  - `copy`、`copy+w`、`edit`：已加密文件的副本被覆盖或改写后是否仍加密；
  - `ps51`：同一目录、同一类型下，PowerShell 新建的对照；
  - 每格「立即/延迟」不同，说明加密是延后发生的。
- **问题 3（是否按进程名匹配）**：
  - 看 R-node 与 R-renamed 两列（输入），以及 `create` 与 `r-create` 两列（输出）。摘要结论第 3 条直接列出了两者不一样的类型。
  - 改名副本同时换了文件名和目录（`%TEMP%`）。两者结果不一样时，单凭本轮分不清是名字还是目录导致的。
  - 第一轮里，DSH Desktop 自带的 `node.exe` 在另一个目录，也能解密 `.txt`。这是「同名、不同目录」的一个旁证。
  - R-electron 与 `e-create` 是第三个进程名，同时回答 1.0.x 主进程的读写情况。

## 已知限制

- **本机没有 PowerShell**：`run-p1-13b.ps1` 没有在开发机上执行过，第一次执行就在加密机上。`matrix-probe.mjs` 的读、写、报告三段已在 Linux 预演里跑通（见下文）。PowerShell 侧产出的记录格式由单测覆盖，包括 5.1 可能输出的 `{"value":[...],"Count":n}` 包装数组与 certutil 原始输出。
- **不复刻 `ReplaceFileW`**：纯 JS 调不了。`edit` 写者用的是 1.0.x 编辑工具的写法，不是 DSH edit 的写法。DSH edit 在第一轮已有现场结果：改后仍加密。
- **只测一个目录**：`-EncDir`。`~\.dsh`、`%APPDATA%`、`%TEMP%` 等目录的策略可能不同，本轮不覆盖。
- **certutil 输出格式**：按「偏移 + 16 组十六进制 + 三个以上空格 + ASCII」解析。解析不了的记「出错」，原始输出在 `matrix.json` 里。
- **Electron 读者**：依赖应用没有关掉 RunAsNode 熔丝。1.0.x 自己的内嵌终端就用这条路径（`PiTuiPty.ts`），所以应当可用；万一应用界面弹出，按上文处理。
- **管理员权限**：结论只代表运行时的账户权限，报告里写明。

## 构建与预演

- 构建：`node src/dsh-host/tools/p1-13b/build-kit.mjs`，输出到开发机 `/var/tmp/aiclient-p1-13b-kit/`：`aiclient-p1-13b-kit.zip`、`README.txt`、本手册、`SHA256SUMS`。
  - 包里没有 node，用应用自带的；`kit-manifest.json` 记录构建时间、源码提交与各文件 sha256。
  - 交付前以 `SHA256SUMS` 为准。
- Linux 预演：`node src/dsh-host/tools/p1-13b/matrix-probe.mjs --rehearsal`。
  - 在临时目录里跑完整的输入、写者、读者、报告流程。读者只有本机 node 与它的改名副本，写者只有 node 系列。
  - 4 个输入被换成伪造的 TSD 头文件，代替人工加密；另把一个输出在两次复读之间换成 TSD 头，检验「立即/延迟」对比。
  - 最后按预期逐项自检。
  - 摘要见 [linux-rehearsal-summary-2026-09-28.txt](p1-13b-encryption-matrix-runbook/linux-rehearsal-summary-2026-09-28.txt)。
- 单测：`npx vitest run scripts/__tests__/p1-13b-matrix-probe.test.mjs`。
