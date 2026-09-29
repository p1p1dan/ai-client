# P1-13c 证据：Windows 加密机上 PowerShell 5.1 读回退（2026-09-29）

脱敏摘要。现场原始输出（报告 JSON、探针日志）只留在开发机，不入库。分支 `feat/dsh-p1-13c`，基线 `eda6c248`（`origin/feat/dsh-p0-probe` 头，无更新）。

## 0. 环境

Windows 加密机（用户确认装了公司加密策略；仓库公开，机器与账号信息不记录）。DSH `0.1.7-rc.2`，随包 node v24.18.0 win-x64。模型侧只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`。

## 1. 本机加密策略补充测量（P1-13b 之外）

- **PowerShell 5.1 写入 `.yml` 即写即密**：写完 0 ms 内 node 视角的前 16 字节就是 TSD 头（两次独立实测，含真宿主冒烟的等待循环第 1 次轮询即命中）。P1-13b 的「约 260 秒延迟」在本机未出现于写入时点。
- PowerShell 5.1 写入 `.txt` / `.md` / `.json`：30 秒内三次复查均为明文（不在加密类型表内）。
- **`"` 无法出现在 Windows 文件名里**（文件系统保留字符，创建即失败）——任务要求测的特殊字符集合中该项物理不可能，其余（空格、中文、`'`、`$`、反引号、`&`、`;`）全部实测通过。
- 随包 ripgrep（grep 工具）对真实加密 `.yml` 无匹配（密文视角），与任务预告一致；范围外，不处理。

## 2. PowerShell 5.1 stdout 分帧实测（决策 091 采用依据）

以产品同款命令行（绝对路径 + `-NoProfile -NonInteractive -EncodedCommand`、路径走环境变量、`windowsHide`）实测六类用例：

| 用例 | 退出码 | stdout |
|---|---|---|
| 普通 ASCII 文件 | 0 | 纯净帧：`BEGIN\n<base64>\nEND\n`，无 BOM、无杂音 |
| 空文件 | 0 | `BEGIN\n\nEND\n`（空 base64 行） |
| 全 256 字节值 | 0 | 帧内 base64 往返逐字节一致 |
| 伪造 TSD 头文件 | 0 | 原样读回（PS 不解密普通文件） |
| 特殊字符路径（空格/中文/`'`/`$`/反引号/`&`/`;`） | 0 | 正确读回，路径经环境变量无注入面 |
| 不存在的文件 | 1 | stdout 空，stderr 带异常信息 |

结论：采用「前缀标记 + 单行 base64 + 结尾标记」的严格帧解析。

## 3. 单元与静态测试（全部通过）

- `src/dsh-host/encryptedRead/__tests__/encryptedRead.test.ts`（Linux 可跑，注入伪读取器）：非 win32 不包装；普通文件零回退（计数断言）；前缀读失败交回原方法；四入口 ×（回退成功 / 仍密文 / 读取器失败）；`readText` 二进制与非法 UTF-8 拒绝（与 DSH 同文案同码）；`streamText` 单 chunk；`readBytes` 上限按明文（含无上限分支）；`readByteRange` 窗口 / 空 / 越界；`editText` 拒绝与透传五参；明文超 32 MiB 拒绝；预中止委托；二次安装幂等；帧解析正反例；并发闸 FIFO。
- `src/dsh-host/encryptedRead/__tests__/encryptedRead.win32.test.ts`（`skipIf` 非 win32，真 powershell.exe）：伪造 TSD → `FS_ENCRYPTED`；特殊字符路径 → 「returned ciphertext too」（证明路径完整抵达且未被执行）；50 ms 短超时 → 杀进程 + `process.kill` 从未被调（spy 断言）；100 ms 中止 → `FS_ABORTED` + 同上；明文字节往返。
- `src/dsh-host/__tests__/encryptedReadSeam.test.ts`（DSH 接缝哨兵，内容见决策 091 §5）。
- 既有静态测试同步更新：`hostStatic.test.ts`（aiclient-* 行清单、exports 清单、`REQUIRED_ENABLED` 正则、新行组合）、`hostProfile.test.ts`、`scripts/__tests__/dsh-host-build-lib.test.mjs`（`ROW_INJECT['aiclient-encrypted-read'] = ['fs']`、`@deepseek-ai/dsh-fs` 外部 stub；逐行构建 + 导入检查自动覆盖新行）。

## 4. 真宿主验证（打包产物 + 随包 node + 假网关）

工具：`src/dsh-host/tools/encrypted-read-smoke.ts`（Windows 兼容：scratch 走系统临时目录、宿主与探针 hooks 经 `file://` 导入、不读 `/proc`）。宿主为 `out-dsh-host`（构建含新行，9760 文件），会话走与 Main 相同的 worker RPC，模型由假网关的 P0-FS 脚本驱动真实 `read` / `edit` / `write` / `grep` / `glob` / shell 工具。

### 4.1 类型 × 回退矩阵（本机，产品同款读取器）

PowerShell 5.1 在系统临时目录写入各类型文件后，用产品同款回退读取器（`createPowerShellReader()`）直读，重复三次取稳定值：

| 类型 | node 视角 TSD 头 | 回退结果 | 单次耗时 |
|---|---|---|---|
| yml / php / ps1 / cmd / sql / scss | 是（即写即密） | **明文**（逐字节等于写入内容） | 137–141 ms |
| rb / docx / pptx | 否（本机该写入者下未加密） | 不触发回退（文件本就是明文） | — |

与 P1-13b 矩阵的差异：rb/docx/pptx 在本机未被加密（P1-13b 的机器上它们加密且所有读者都读不出）。若在其他机器上它们被加密且 PS 读不出，回退会给出明确的 `FS_ENCRYPTED` 拒绝，不会把密文交给模型。四个读入口共用同一读取器与判定（单测覆盖入口差异），矩阵按类型维度实测。

**伪造模式**（marker.txt = TSD 头 + 随机体，临时工作区）：

- `read` 返回 `ok=false`：`cannot read "…\marker.txt": the file is protected by a disk-encryption policy — the decryption fallback returned ciphertext too`（`FS_ENCRYPTED`）；
- 任何 read 的输出都不含密文体（`ciphertextNeverServed`）；
- 明文文件的读 / 编辑 / 写全部正常（`plaintextEditStillWorks`）；
- 探针 hook 日志恰好 1 条 `powershell.exe -NoProfile -NonInteractive -EncodedCommand …` spawn 记录；拒绝读的墙钟 171–176 ms；
- 回合 2.4 s 内正常结束，宿主 ready ~1 s。

**真机模式**（`--real`：由 PowerShell 5.1 在用户 profile 下临时目录写 `marker.yml`，等待策略加密——本机 0 ms 即密——再跑同一回合）：

- `read` 返回 `ok=true`，内容即写入的明文两行（含唯一标记串）——**完整回退链路在真实加密文件上成立**；
- 该 read 墙钟 **174 ms**，恰好 1 次 PowerShell 拉起（hook 日志）；
- 同回合 grep（ripgrep）对同一加密文件无匹配（密文视角，范围外观察）；
- 其余明文工具调用全部正常；测试目录事后清理。

## 5. 基线对比（改动前 → 后）

| 命令 | 基线 | 改动后 |
|---|---|---|
| `tsc --noEmit`（根 / agent-host / runtime / dsh-host） | 4/4 通过 | 4/4 通过 |
| `vitest run src/dsh-host src/shared/permissions src/main/services/agent-host/__tests__ scripts` | 951 过 / 9 败 / 22 跳（60 文件） | **983 过 / 9 败 / 22 跳（63 文件）**，失败清单逐条相同（systemd×4、临时路径×2、EPERM 改名×1、路径分隔符×1、路径脱敏×1，全为平台差异） |
| `vitest run Static Scan Wiring src/shared/__tests__` | 1030 过 / 5 败 | **1031 过 / 5 败**，同样 5 个 EPERM（workerEntryWiring） |
| `AICLIENT_DSH_INTEGRATION=1` 集成 | 21 跳过（代码限定 linux） | 21 跳过 |
| bridge-smoke / loop-guard-smoke / bridge-record --check | 3 败（`/proc`、`/proc/meminfo`、裸路径作 ESM 入口） | 同样 3 败，原因相同 |
| `node scripts/build-dsh-host.mjs` | 过（84.6 MiB，9759 文件） | 过（84.7 MiB，9760 文件） |
| `packaged-dsh-host-smoke --level 1` | 41 项中败 2（`l1RipgrepFromArtifact`、`nativesPtyRan`） | 同样败且仅此 2 项；L0 ready、L1 12 次工具调用、退出码均与基线一致 |

新增测试：3 个新文件共 31 例（单测 17、win32 真机 5、接缝哨兵 9），加上既有文件更新的断言，命令 5/6 的通过数合计 +33。

## 6. 开发环境观察（范围外，供后续任务与环境整理参考）

- **C 盘 corepack 缓存目录下 node 打不开 `.js`**：`%LOCALAPPDATA%\node\corepack\...\dist\worker.js` 在目录枚举里可见，但 node 的 `statSync/open` 返回 ENOENT（bash 与 PowerShell 可读；同目录 `.txt`/`.cjs` 正常；该目录新建 `.js` 秒拒；E 盘与 C 盘其他目录正常）。这使 `pnpm install` 的 tarball worker 崩溃（`Worker pnpm#N exited with code 1`）。**绕开**：`COREPACK_HOME` 指到 E 盘后 pnpm 10.26.2 正常。原因未深究（疑与安全软件/过滤驱动有关），建议环境侧跟进。
- **Git Bash 的 curl 对 npmjs/github 报错 43**，而 node fetch 直连与经本机代理（127.0.0.1:789x）均 200——排查连通性时勿被 curl 误导。
- **CRLF 检出**：本机 `core.autocrlf=true` 使未钉 eol 的 `.yml` 等检出为 CRLF，静态测试（`hostStatic`）5 例失配。已在该仓库 worktree 本地设 `core.autocrlf=false` 并重写工作区（写入的是共享 `.git/config`，会影响用户主检出，交付时说明）；仓库本身未改。
- npm 11 的 install-scripts 策略拦了子包里 koffi / node-pty / tree-sitter-bash / protobufjs 的安装脚本；本次基线与验证未受影响（未逐一复核其运行时后果）。

## 7. 上机包

本次开发机即加密机，`--real` 模式就是真机实测（§4）；无单独上机包。若需在其他加密机复跑：`node scripts/build-dsh-host.mjs` 后执行 `out-node-runtime\node.exe src/dsh-host/tools/encrypted-read-smoke.ts --host-dir out-dsh-host --real --out <报告路径>`（fake 模式去掉 `--real`）。
