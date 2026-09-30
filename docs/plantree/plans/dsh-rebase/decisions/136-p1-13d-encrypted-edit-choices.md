# 决策 136：P1-13d 加密文件编辑——替换语义、版本守卫与开关的取舍

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [决策 135](135-user-ruling-encrypted-edit.md)（用户裁决）——方案与验证要求已定死，本决策只写实现方的取舍；
- [决策 091](091-p1-13c-windows-read-fallback.md)（P1-13c 读回退）——错误码、回退参数、范围边界的来源；
- [P1-13d 派工提示词](../topics/p1-13d-encrypted-edit.md)。

分支 `feat/dsh-p1-13d`，基线 `136fbd70`（`origin/feat/dsh-p0-probe` 头，已含 `f84f7bbd` 的 P1-13c 合并）。

## 落地了什么

- `src/dsh-host/encryptedRead/replaceSemantics.ts`（新，约 110 行）：LF 归一、行尾探测与还原、字面替换，全部是 `dsh-fs-local` 同名行为的纯函数重述。
- `src/dsh-host/encryptedRead/encryptedRead.ts`：`editText` 的 `FS_ENCRYPTED` 拒绝换成完整的加密编辑路径。
- `src/dsh-host/encryptedRead/plugin.ts` + `constants.ts`：`AICLIENT_RUNTIME_ENCRYPTED_READ=0` 紧急开关，照 `loopGuard` 的做法。
- `src/main/services/agent-host/dshHostEnvironment.ts`：把该变量加入 `FORWARDED_ENV`。
- 测试：`__tests__/encryptedEdit.test.ts`（新，语义矩阵）、`__tests__/encryptedEdit.win32.test.ts`（新，真机）、既有两个测试文件同步更新。
- 冒烟：`tools/encrypted-read-smoke.ts` 与 `tools/fake-gateway.mjs` 的 P0-FS 脚本各加一档加密编辑场景，两种模式都跑。

## 规则

### 替换语义（决策 135 第 1 条）

1. **照抄 `dsh-fs-local` 的四处实现，不发明语义**：`normalizeLineEndings`（CRLF→LF）、`detectLineEndings`（前 4096 字符里 CRLF 是否过半）、`restoreLineEndings`（CRLF 还原前先归一，避免 `\r\r\n`）、`applyLiteralEdit`（空 `old_string` → `FS_EDIT_NOT_FOUND`；零匹配 → 同码；多匹配且 `replace_all !== true` → `FS_AMBIGUOUS_EDIT`，文案逐字照抄，含 `matched N times` 里的计数）。
2. **匹配在 LF 归一后的内容上做，`old_string` / `new_string` 也各归一一次**，这样模型直接引用 Windows 文件里的 CRLF 文本仍能匹配；写回按原文件风格。
3. **二进制与 UTF-8 判定照 `readForEdit`，不照读路径**：`readForEdit` 扫**整个** buffer 找 NUL，而 `readWholeText` 只扫前 8192 字节。编辑走前者，所以本路径也扫全长——长文件里第 9000 字节的 NUL 必须拒绝（有单测）。
4. **BOM 保持 `TextDecoder` 的默认行为：丢弃。** `dsh-fs-local` 的 `readForEdit` 用的就是这个解码器，BOM 在解码时已被吃掉，所以编辑后的写回天然不含 BOM。这是与 DSH 一致，不是丢失数据；想保留 BOM 反而是偏离。

### 版本守卫与沙箱（决策 135 第 2、3 条）

5. **读基准换成回退读出的明文，其余全走 fs 服务自己的公开方法**：
   - 服务实例有 `checkedTarget` 时先 `service.checkedTarget(target, sandboxPolicy)` 过沙箱围栏，后面各步都用它返回的 target（见第 7 条）；
   - `service.stat(target, signal)` 取读前版本（`dev:ino:size:mtimeNs:ctimeNs`，与 `writeText` 内部 `probe` 同一算法，见下）；
   - 回退读取明文；
   - `service.writeText(target, content, { kind: 'replaceIfVersion', version }, signal, sandboxPolicy)` 写回。
6. **错误顺序照宿主里实际生效的原生 edit（`SandboxedFileSystem.editText` 外层围栏 + `dsh-fs-local` 的 `editText`）**：先过沙箱围栏（第 7 条，拒绝即 `FS_SANDBOX_DENIED`）；然后文件不存在 → `FS_STALE_VERSION`；非普通文件 → `FS_NOT_REGULAR_FILE`；调用方 `expected` 不符 → `FS_STALE_VERSION`；然后才回退读、判二进制与 UTF-8、匹配、写。与原生的差别只有两处：最前面多一次 16 字节前缀读（决定走不走本路径，在围栏之前）；读与写之间不持锁，改由写回时的乐观版本守卫把关（第 8 条）。
7. **沙箱围栏不绕过，且与原生 edit 一样放在最前**：判定是 TSD 之后、`stat` 与 PowerShell 读之前，服务实例有 `checkedTarget` 就先调它（决策 135 第 2 条点名复用的公开方法），之后的 `stat`、回退读、写回都用它返回的 target——查的就是改的。于是沙箱会拒的 edit 直接得到沙箱自己的 `FS_SANDBOX_DENIED`，不会先报 `FS_EDIT_NOT_FOUND` 之类，也不会白拉一次 PowerShell。写回仍走 `writeText` 五参，宿主里是 `SandboxedFileSystem.writeText`，它在写的那一刻对最新 target 再查一次，重复无害。非沙箱的 `LocalFileSystem` 没有 `checkedTarget`，照旧直接走。与原生并非「完全同路径」：原生查一次，本路径查两次（开头一次、写回一次）。
8. **版本守卫比 DSH 原实现严格，是有意为之**：DSH 在 `withLock` 临界区内读改写，本行拿不到那把锁（复制它就等于复制 DSH 的临界区，决策 091 第 2 条禁止）。改用乐观守卫后，读之后任何外部写入都会让写回失败并报 `FS_STALE_VERSION`，而不是覆盖别人的改动。代价是理论上多一次可观察的失败，收益是不会静默丢改动。
9. **`expected` 语义照搬**：调用方（`dsh-tool-fs` 的 `edit`）传 `intent`，有它就核对 `expected.version` 与本次 `stat` 的版本；两者不符即拒。决策 135 要求「有 `expected` 时先核对版本」，本实现放在围栏与 `stat` 之后、回退读之前，与第 6 条的顺序一致。
10. **写回后不自己用 PowerShell 写**（决策 135 第 6 条）：写回走 fs 服务，于是沙箱、ACL 复制、原子发布都由 DSH 负责，本行只提供内容。

### 范围与开关（决策 135 第 5 条、第 7 条）

11. **范围**：
    - win32 + node 视角前 16 字节是 TSD 头 + 回退读出明文 → 走新路径；
    - 回退仍返回密文 → `FS_ENCRYPTED`，文案为 `cannot edit "<path>": the file is protected by a disk-encryption policy — the decryption fallback returned ciphertext too`：决策 091 里 edit 那句的主干接原因子句，与读路径的实际形态一样，带原因子句时不再有 `and cannot be read here`；回退失败为 `— the decryption fallback failed: <原因>`，超上限为 `— the decrypted file is larger than the 33554432-byte fallback limit`；回退途中中止为 `FS_ABORTED` 的 `edit aborted`，与 DSH 原生 edit 中止的文案一致。完整文案由 `encryptedEdit.test.ts` 钉住；
    - 非 win32，或前 16 字节不是 TSD 头 → 原样调用原 `editText`，零行为变化，额外开销仍只有读开头 16 字节。
12. **紧急开关用环境变量的理由是它只在启动时读一次**：`apply` 里判 `AICLIENT_RUNTIME_ENCRYPTED_READ === '0'`，为真时**不包装任何方法**，行为等同没有这一行。行仍然在 `hostProfile.ts` 的 `REQUIRED_ENABLED` 里（决策 135 明确不改），所以组成校验不会因为开关而失败。开关名字照 `AICLIENT_RUNTIME_LOOP_GUARD` 的形状。
13. **`apply` 里顺带把「非 win32」也归到同一个分支并记一行日志**：原来非 win32 是静默 return，现在两个原因都会 log 一行（`not on win32` / `disabled by …=0`）。理由：既然多了一个让这行不生效的开关，日志里区分「本来就不生效」和「被开关关掉」是有价值的，且只在启动时各一行。代价：非 win32（Linux、macOS）宿主每次启动都在 stderr 多一行 `[aiclient-encrypted-read] not on win32: nothing to wrap`；fs 行为不变（仍不包装任何方法），只是比决策 091 §2 说的「与没有此行完全一致」多这一行日志。`plugin.test.ts` 钉住了这两行日志与开关判定。

## 验证（决策 135 定的四类，全部做到）

14. **假读取器单测**（`encryptedEdit.test.ts`，Linux 可跑）：每个错误码、CRLF/LF、`replace_all`、多处匹配、零匹配、空 `old_string`、读后被改、文件被删、目录目标、回退失败/中止、写回调用形态（`replaceIfVersion` + `sandboxPolicy`）、非 win32 与普通文件不走新路径（计数断言）、BOM、以及 `replaceSemantics.ts` 的独立语义（4096 字符窗口、CRLF 不叠加、非重叠计数、字面替换不展开 `$&`）。复核后补：沙箱围栏先于一切（拒绝时先报沙箱错误、读取器零调用）、围栏返回的 target 贯穿 stat / 读 / 写、edit 路径三种 `FS_ENCRYPTED` 与 `edit aborted` 的完整文案；另有 `plugin.test.ts` 覆盖开关的纯函数判定与非 win32 的启动日志。
15. **win32 真机单测**（`encryptedEdit.win32.test.ts`，`skipIf` 非 win32）：真实 PowerShell 读取器的往返、真实写盘后的行尾、`FS_ENCRYPTED` 拒绝且文件字节不变、读后被改 → `FS_STALE_VERSION` 且外部写入者的字节完好。
16. **版本守卫的实测风险项**（决策 135 第 4 条要求实测）：
    - 同一 node 进程内连续 400 次 `stat` 同一文件（中间夹一次 PowerShell 读取）版本恒定；
    - 同目录写入另一个文件、外部读取者读该文件，都不改变它的版本；
    - 完整的 `stat → PowerShell 回退读（189 ms）→ 写回前再 stat` 序列里两次版本一致，守卫不会凭空报 `FS_STALE_VERSION`。
    - 结论：**不会凭空报错**，决策 135 第 4 条的风险项排除。数据见证据文档。
17. **真宿主冒烟两种模式**：fake 与 `--real` 都跑了加密编辑场景，判据见证据文档。向后兼容做到位：`editInMarker`、`refuseName` 两个新参数都是可选的，缺省时 P0-FS 的步骤序列与判据与 P1-13c 完全相同（`bridge-smoke` 与录制用的调用都没传它们）。

## 发现（重要，超出决策 135 的预期）

18. **「写回后被策略重新加密」在本机不成立——已实测并修订决策 135 第 5 条（用户 2026-09-30 批准）。**
    - 实测：PowerShell 5.1 写入 `.yml` 立即加密且保持加密；**node 写入（含 DSH `writeFileAtomic` 的 staging 目录 + rename 形状）写出的文件，4 分钟后 node 与 PowerShell 都仍读到明文**。
    - 所以本行编辑后的加密文件，在 node 视角下变成明文并**保持明文**——加密由「写入者是谁」决定，不是由扩展名或目录决定；策略只在它信任的写入者落盘时加密。
    - 产品含义：这是**可接受的**，而且是自洽的——编辑后文件为明文，读它走原生路径（不再需要 PowerShell），编辑可以继续；只有下次由 PowerShell/公司客户端侧写入时它才会重新加密，那时读又会自动走回退。回退闭环仍然成立。
    - **决策 135 第 5 条已按实测改写**，并写明用户补充的事实：加密机上 git 是放行的，受策略保护的文件经 git 上传到云端后云端内容也是明文。即「加密只在本机、且只对策略信任的读取者生效」是这套策略的既有语义，本行没有引入新的暴露面。
    - 冒烟里的处理：`markerReEncryptedAfterEdit` 降级为**记录项**（不参与 pass 判定），pass 判定改用「编辑后的明文确实落在盘上」（`markerOnDiskHasEdit`）+「复读带得到编辑」。
19. **fake 模式原定的「编辑被拒」判据是错的。** 最初想让 marker.txt（TSD 头 + 含 NUL 的体）走编辑拒绝，但实测拒绝来自工具层观察策略（"file has not been read"）而非加密语义，且理由脆弱。改成：fake 模式放**两个**文件——`cipher-not-editable.txt`（回退解不出，必须拒绝）与 `marker.txt`（PowerShell 读得回明文，必须完成编辑），两半都测到。
    - 注意：冒烟的 `uneditableRefused` 实际测的是 **read** 拒绝——假网关 FS 脚本的 `refuseName` 插入的是一次 `read`；读失败的文件再 `edit`，会先被工具层观察策略以 `FS_NOT_OBSERVED` 拦下，到不了 fs 服务。所以「回退后仍是密文的文件 edit 被拒」（本行 `editText` 的 `FS_ENCRYPTED` 分支）**只有单测覆盖**：Linux 的假读取器单测（`encryptedEdit.test.ts`）与 win32 真机单测（`encryptedEdit.win32.test.ts` 中一例），真宿主冒烟没有覆盖。

## 取舍

- **没有整份复制 `dsh-fs-local` 的 `editText`**：只重述替换语义与二进制/UTF-8 判定这类不能复用的纯逻辑，读改写临界区、版本比较、沙箱、原子写全部复用服务。这正是决策 091 第 2 条与 135 第 2 条的要求。
- **没有新增工具、没有替换 `edit` 工具、没有改任何 `@deepseek-ai/` 包文件。**
- **`replaceSemantics.ts` 独立成模块**是为了能在 Linux 上单测语义矩阵（决策 135 的验证要求 1），不是为了将来复用。
- **`stat` 与 `writeText` 只加进 `dshTypes.ts` 的结构视图**，不 import DSH 类型，保持本行 bundle 不含 DSH 类型（照 091 的做法）。
- **开关做成「不包装任何方法」而不是「包装后在里面判」**：前者行为等同没有这一行，没有额外开销，也不会有半开状态。

## 影响

- 加密机上，6 类可编辑扩展名（yml/php/ps1/cmd/sql/scss）现在可以编辑，实测 156～172 ms 一次。
- 非 win32 与普通文件路径完全未变（已有计数断言守着）。
- 新增 2 个测试文件；既有 2 个测试文件按新行为更新。
- 决策 135 第 5 条按实测改写（见第 18 条），修订记录写在决策 135 里。

## 待用户确认

- 第 12 条的开关是否保留（决策 135 说可选）。

## 修订记录（2026-09-30，编排者复核后）

复核合入的 `30893b28` 时发现几处实现或表述与本决策不符。代码已修，表述按修复后的实际情况改写。加密机实测数据没有改；复核后的修复只在 Linux 开发机上验证（单测、`bridge-smoke`、打包冒烟 L1），没有回加密机复测。

- **第 5、6、7 条（沙箱围栏的位置）**：原文写「错误顺序照 dsh-fs-local」「沙箱检查发生在写的那一刻……与 DSH 原生 edit 完全同路径；本行不去直接调 `checkedTarget`」。实际上原生 `SandboxedFileSystem.editText` 是先 `checkedTarget` 再读、匹配；原实现要等 stat、PowerShell 读、匹配都做完，写回时才过围栏，于是沙箱会拒的 edit 先报 `FS_EDIT_NOT_FOUND` 等错误，还白拉一次 PowerShell。已改为在加密路径开头先调 `checkedTarget`（决策 135 第 2 条本来就点名复用它），第 5～7 条随之改写，第 9 条「放在最前」相应改为「围栏与 `stat` 之后、回退读之前」。
- **第 11 条（拒绝文案）**：原实现在 edit 路径把动词写死成 read，模型看到的是 `cannot read "…": … returned ciphertext too` 和 `read aborted`，与本条、证据 §4.2 写的 edit 文案不符。已改为 `cannot edit …` 与 `edit aborted`，完整文案由单测钉住；`encryptedRefusal` 里已没有调用方的无原因分支（P1-13c 时 edit 直接拒绝用的）一并删掉。
- **第 13 条**：补写非 win32 启动时 stderr 多一行，fs 行为不变。
- **第 14 条**：补列复核后新增的单测（`encryptedEdit.test.ts` +3 例，新文件 `plugin.test.ts` 5 例）。
- **第 19 条**：补写冒烟的 `uneditableRefused` 测的是 read 拒绝，「edit 仍是密文的文件被拒」只有单测覆盖。
- 另：`bundle/cordis.patch.yml` 里这一行的注释补上了 `editText`；`encryptedReadSeam.test.ts` 加钉 `SandboxedFileSystem.checkedTarget(target, sandboxPolicy)` 的签名（改名只会让围栏退回写回时才查，这里会提前发现）。
