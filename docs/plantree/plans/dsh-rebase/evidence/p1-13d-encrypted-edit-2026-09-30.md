# P1-13d 证据：Windows 加密机上对加密文件完成 edit（2026-09-30）

脱敏摘要。现场原始输出（报告 JSON、探针日志、临时文件）只留在开发机，不入库。分支 `feat/dsh-p1-13d`，基线 `136fbd70`（`origin/feat/dsh-p0-probe` 头，已含 `f84f7bbd` 的 P1-13c 合并）。

## 0. 环境

Windows 加密机（装了公司加密策略；仓库公开，机器与账号信息不记录）。DSH `0.1.7-rc.2`，随包 node v24.18.0 win-x64。模型侧只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`。本次会话的工作副本是仓库外的独立 worktree（`git worktree`），不碰既有检出。

依赖安装：根 `node_modules` 从既有工作副本整份复制（`package-lock.json` 与 `pnpm-lock.yaml` 逐字节相同），`src/dsh-host` 用 `npm ci`（该子包的 lock 因新增 `dsh-tool-ask-user`、`dsh-office-tools` 而不同），`src/runtime` 用 `npm ci`。安装后 `src/dsh-host/node_modules` 与既有副本逐文件相同，只多那两个新包。

## 1. 决策 135 里用户补充的实测数据（并入本证据）

- settled 复测（PowerShell 写入后等 5.5 分钟）：yml、php、ps1、cmd、sql、scss 写入后 1～4 ms 即被加密；PowerShell 写的 rb、docx、pptx 过了 5.5 分钟仍未加密。P1-13b 那三个加密样本是其他写入者产生的既有文件，不是机器差异。
- 「约 260 秒延迟」指读者视图的沉淀（例如 PowerShell 读 md、java，从明文变成密文），不是写入侧落盘的延迟。
- 六类文件的回退读取稳定在 143～189 ms。

本次实测与上述一致（见 §4 的回到 156～202 ms 区间）。

## 2. 基线（改动前，逐条）

命令与实际失败项（全为平台差异，P1-13c 已记过同类）：

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | 通过，0 错误 |
| 2 | `npx tsc --noEmit -p src/agent-host` | 通过，0 错误 |
| 3 | `npx tsc --noEmit -p src/runtime` | 通过，0 错误 |
| 4 | `npx tsc --noEmit -p src/dsh-host/tsconfig.json` | 通过，0 错误 |
| 5 | `vitest run src/dsh-host` | 614 过 / 3 败 / 2 跳（33 文件） |
| 5b | `vitest run src/shared/permissions src/main/services/agent-host/__tests__ scripts` | 1062 过 / 11 败 / 36 跳（49 文件） |
| 6 | `vitest run Static Scan Wiring src/shared/__tests__` | 1097 过 / 5 败（98 文件） |
| 7 | `bridge-record.ts --check`（随包 node） | 失败 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（裸 Windows 路径作 ESM 入口） |
| 8 | `node scripts/build-dsh-host.mjs` | 通过，85.1 MiB / 9769 文件 / 342 包 |
| 9 | `packaged-dsh-host-smoke --level 1` | 通过，44 项全过 |

失败项归因：3 败（命令 5）是 `sessionGc.test.ts` 期望 `/` 分隔符、Windows 产出 `\`；11 败（命令 5b）是 systemd scopes ×4（Linux 专属）、临时路径 ×2 与路径脱敏 ×1（绑定具体用户 profile）、8dot3 短名 ×3（夹具用 Linux 短路径）、`concurrency-06` ×1；5 败（命令 6）是 `workerEntryWiring.test.ts` 的 EPERM 改名。

命令 5 的基线数比 P1-13c 记的（951 过 / 9 败 / 22 跳）多，是因为本会话把它拆成两条跑（5 与 5b），且环境里多了两处新依赖；败因类别一致。

## 3. 改动后对比（逐条）

| # | 命令 | 基线 | 改动后 | 结论 |
|---|---|---|---|---|
| 1-4 | 四套 `tsc` | 4/4 通过 | 4/4 通过 | 零回归 |
| 5 | `vitest run src/dsh-host` | 614 过 / 3 败 / 2 跳 | **640 过 / 3 败 / 2 跳**（35 文件） | +26 例，失败逐条相同 |
| 5b | 其余一批 | 1062 过 / 11 败 / 36 跳 | **1063 过 / 11 败 / 36 跳** | +1 例（Main 转发），失败清单相同 |
| 6 | `Static Scan Wiring` + `src/shared/__tests__` | 1097 过 / 5 败 | 1097 过 / 5 败 | 失败清单经 diff 比对**逐条相同** |
| 7 | `bridge-record.ts --check` | 失败（同上 URL scheme） | 失败（同一原因） | 零回归 |
| 8 | `build-dsh-host.mjs` | 85.1 MiB / 9769 文件 | 85.1 MiB / 9769 文件 | 零差异 |
| 9 | `packaged-dsh-host-smoke --level 1` | 44 项全过 | **44 项全过** | 零回归 |

新增测试：2 个新文件（`encryptedEdit.test.ts` 21 例 + 语义 4 例、`encryptedEdit.win32.test.ts` 5 例），既有 2 个文件更新断言。

`biome check` 对改动树（`src/dsh-host`、`src/main/services/agent-host`）干净。

## 4. 加密机实测

### 4.1 六类可编辑扩展名，各一次真实编辑

方法：PowerShell 5.1 写入各扩展名文件（策略随即加密），node 确认前 16 字节是 TSD 头，然后走本行的真实编辑路径（真实安装器 + 真实 PowerShell 读取器 + 真实写盘 + 真实 `replaceIfVersion` 守卫），最后复读。

| 扩展名 | PowerShell 写入即加密 | 编辑耗时 | 编辑后 node 前缀 | 复读得到新内容 | 盘上内容 |
|---|---|---|---|---|---|
| yml | 是 | 159 ms | `alpha\nBETA\ngamma`（明文） | 是 | `alpha\nBETA\ngamma\n` |
| php | 是 | 159 ms | 同上 | 是 | 同上 |
| ps1 | 是 | 164 ms | 同上 | 是 | 同上 |
| cmd | 是 | 162 ms | 同上 | 是 | 同上 |
| sql | 是 | 156 ms | 同上 | 是 | 同上 |
| scss | 是 | 167 ms | 同上 | 是 | 同上 |

复读走的是 node 原生路径（因为编辑后文件已是明文），编辑结果正确。真实加密文件的回退读取耗时 189～202 ms，与决策 135 的 143～189 ms 同区间。

### 4.2 拒绝场景

- **回退解不出明文的加密文件**（TSD 头 + 二进制体，PowerShell 原样读回）：编辑被拒，`FS_ENCRYPTED`；**文件字节逐一不变**。文案：实测时的代码在 edit 路径把动词写死成 read，实际给出的是 `cannot read "…": the file is protected by a disk-encryption policy — the decryption fallback returned ciphertext too`（当时的断言只查子串 `returned ciphertext too`，没发现）。编排者复核后（2026-09-30）已改为决策 091 里 edit 那句的主干：`cannot edit "…": the file is protected by a disk-encryption policy — the decryption fallback returned ciphertext too`，由 Linux 单测钉住，未回加密机复测（见决策 136 修订记录）。
- **rb / docx / pptx**：本机 PowerShell 写入这三类**不加密**（与决策 135 的 settled 复测一致），所以 node 视角是普通明文文件，编辑按普通文件处理（未被本行包装），可正常编辑。若在其他机器上它们被加密且 PowerShell 读不出，则落入上面那条，明确拒绝。
- 结果：回退读不出明文的加密文件**明确拒绝、不写入**，符合决策 135 第 5 条。

### 4.3 写回后是否被重新加密（**与决策 135 预期不符，需裁决**）

对照实测（同一目录、同一初始加密状态，一份由 node 写、一份由 PowerShell 写；0/10/30/60/120/240 秒六次采样）：

| 写入者 | node 视角 | PowerShell 视角 | 240 秒后仍未变 |
|---|---|---|---|
| PowerShell 5.1 | 立即为 TSD 密文 | 明文 | 是（保持加密） |
| node（含 DSH `writeFileAtomic` 的 staging + rename 形状） | 明文 | 明文 | 是（**保持明文**） |

结论：**加密由「写入者是谁」决定，不由扩展名或目录决定**；策略只在它信任的写入者落盘时加密。所以本行编辑后的加密文件在 node 视角下变成明文并保持明文。

产品含义（可接受）：编辑后为明文 → 后续读走原生路径、编辑可继续；只有下次由 PowerShell/公司客户端侧写入时才重新加密，届时读又自动走回退。回退闭环仍然成立，只是「写回即重新加密」这一条不准确，实际是「写回后为明文，直到下次由策略信任的写入者重写」。

**决策 135 第 5 条已按本实测改写**（用户 2026-09-30 批准），修订记录写在决策 135 里。用户补充的事实：加密机上 git 是放行的——受策略保护的文件经 git 上传到云端后，云端内容也是明文。即「加密只在本机、且只对策略信任的读取者生效」是这套策略的既有语义，本行没有引入新的暴露面。

冒烟脚本据此把该检查从 pass 条件降级为记录项（`markerReEncryptedAfterEdit`），pass 改用「编辑后的明文确实落盘」。

### 4.4 stat 版本稳定性（决策 135 第 4 条要求实测的风险项）

| 检查 | 结果 |
|---|---|
| 同进程连续 400 次 `stat` 同一文件（中间夹一次 PowerShell 读取） | 版本集合大小 **1**（完全恒定） |
| 同目录写入无关文件 | 目标版本**不变** |
| 外部（PowerShell）读取目标文件 | 版本**不变** |
| 完整序列 `stat → PowerShell 回退读（189 ms）→ 写回前再 stat` | 两次版本**一致**，守卫不误报 |
| 版本字段 | `dev:ino:size:mtimeNs:ctimeNs`，ns 精度有值（非全 0） |

**结论：不会凭空报 `FS_STALE_VERSION`。** 决策 135 第 4 条的风险项排除。

### 4.5 紧急开关

`AICLIENT_RUNTIME_ENCRYPTED_READ` 的实测行为：值为 `0` → 不生效（false）；未设置 → 生效；其他值（如 `1`）→ 生效；非 win32 → 不生效。开关关闭时安装器返回 `{wrapped: false, entries: []}`，即不包装任何方法。

## 5. 真宿主冒烟（打包产物 + 随包 node + 假网关）

工具：`src/dsh-host/tools/encrypted-read-smoke.ts`，宿主为 `out-dsh-host`（85.1 MiB / 9769 文件），会话走与 Main 相同的 worker RPC。两种模式都补了加密编辑场景。

**fake 模式**（`marker.txt` = TSD 头 + 可读文本；`cipher-not-editable.txt` = TSD 头 + 二进制体）：

- `markerEditOk = true`、`markerEditMs = 25 ms`（编辑成功）；
- `markerRereadSeesEdit = true`（复读拿到 `ENC-EDITED-<token>`，该串只存在于编辑后的文件）；
- `uneditableRefused = true`、`uneditableRefusalMs = 198 ms`（解不出的文件被明确拒绝。这一项测的是 **read** 拒绝：`refuseName` 插入的是一次 `read`；读失败的文件再 edit 会先被观察策略以 `FS_NOT_OBSERVED` 拦下，所以「edit 仍是密文的文件被拒」只有单测覆盖，见决策 136 第 19 条）；
- `ciphertextNeverServed = true`（任何 read 的输出都不含密文体）；
- `powershellSpawns = 1`（探针日志确认只拉起一次 PowerShell）；
- `plaintextEditStillWorks = true`（明文文件的编辑未受影响）。

**`--real` 模式**（`marker.yml` 由 PowerShell 5.1 写、策略 0 ms 即加密）：

- `policyEncrypted = true`、`policyPolls = 1`；
- `markerReadAsPlaintext = true`、`readDurationMs = 199 ms`（完整回退链路在真实加密文件上成立）；
- `markerEditOk = true`、`markerEditMs = 189 ms`、`markerRereadSeesEdit = true`（真实加密文件上的真实编辑成功）；
- `markerOnDiskHasEdit = true`（编辑后的明文确实在盘上）；
- `markerReEncryptedAfterEdit = false`（记录项：写回后未被重新加密，见 §4.3）；
- `noReadRefused = true`、`powershellSpawns = 2`（读一次 + 编辑一次）。

**向后兼容**：`editInMarker`、`refuseName` 两个新参数都是可选的；缺省时 P0-FS 的步骤序列与判据与 P1-13c 完全相同。`bridge-smoke` 与录制链路的调用都没传它们，输出不变。

## 6. 开发环境观察（范围外）

- 本机 `pnpm` 不可用（corepack 缺 `pnpm.js`），改用 `npm`/`npx`；这与 P1-13c 记的 C 盘 corepack 目录问题可能同源，未深究。
- npm 11 的 install-scripts 策略同样拦了 `koffi` / `node-pty` / `tree-sitter-bash` / `protobufjs` 的安装脚本；本次与其后所有验证未受影响（与 P1-13c 的观察一致）。
- grep 类工具在个别文件上返回空结果（同一条命令用 node 读同名内容正常），排查时用了 node 复核；只影响排查手法，不影响结论。
- 临时目录里另有大量其他测试留下的 `aiclient-*` 目录，不在本任务范围，未清理。

## 7. 复核入口

```bash
# 类型与单测（在仓库根）
npx tsc --noEmit -p src/dsh-host/tsconfig.json
npx vitest run src/dsh-host/encryptedRead --maxWorkers=1 --no-file-parallelism

# 真宿主冒烟（两种模式）
node scripts/build-dsh-host.mjs
out-node-runtime/node src/dsh-host/tools/encrypted-read-smoke.ts --host-dir out-dsh-host --out <临时目录>\enc-fake.json
out-node-runtime/node src/dsh-host/tools/encrypted-read-smoke.ts --host-dir out-dsh-host --real --out <临时目录>\enc-real.json
```

`--real` 会写 `<用户目录>\enc-smoke-ws\` 下的临时文件（默认位置，可用 `--workspace` 覆盖），测试目录由脚本自己清理。
