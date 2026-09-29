# 决策 091：P1-13c —— Windows 上读到加密文件时改用 PowerShell 5.1 回读（2026-09-29）

日期：2026-09-29。**状态：自主决定，待用户审批。** 依据：决策 090 的 Q009 裁决（「产品自己想办法绕开」）与 P1-13b 的实测矩阵。编号 091 已预留给本任务。

## 1. 方案：A（新增宿主行包装 fs 服务实例），未动用退路 B

新增产品束行 `aiclient-encrypted-read`（`src/dsh-host/encryptedRead/`），声明 `inject: ['fs']`，在 `apply` 里经 `ctx.get('fs')` 取**注册实例本身**（Cordis `reflect.get` 在无 tracker 时原样返回存储值），在实例上以自有属性覆盖五个方法。选它的根据：

- DSH 的全部消费方（`dsh-tool-fs` 的 read / read_image / edit、`dsh-skill-filesystem`、`dsh-agent-instructions`）都在**调用时**经 `ctx.fs.*` 访问服务，实例上的包装对它们全部可见；
- 不需要替换 `fs-sandbox` 行，`hostProfile.ts` 的组合审计照旧工作；
- 退路 B（继承 `SandboxedFileSystem` 另起一行）的前提「Cordis 服务代理让包装不生效」经真宿主验证不成立（见证据文档）：打包宿主里 `read` 工具确实走到了回退。

不改 `@deepseek-ai/` 包内任何文件。

## 2. 覆盖面与行为

- **仅 `process.platform === 'win32'` 生效**。行在所有平台的束里都在（`REQUIRED_ENABLED` 检查它），但 `apply` 在非 Windows 上立即返回：Linux / macOS 不包装任何方法，行为与没有此行完全一致。
- **包装前先读文件开头 16 字节**，与 `%TSD-Header-###%`（hex `25 54 53 44 2d 48 65 61 64 65 72 2d 23 23 23 25`）逐字节比较，只比开头、不做子串搜索。不是 TSD 头就原样调用原方法——普通文件的全部额外开销就是这次 16 字节读，不启动 PowerShell。
- 前缀读本身失败（文件不存在、无法打开、已中止）也交回原方法，由它给出规范错误；包装层不发明自己的错误。
- **四个读入口**（触发回退后，由 PowerShell 5.1 读同一文件的全部字节，读出内容不以 TSD 头开头才被采信）：
  - `readText` / `streamText`：在明文上照原语义执行——前 8192 字节 NUL 扫描拒绝二进制（`FS_NOT_TEXT`「binary file」）、严格 UTF-8 解码（`FS_NOT_TEXT`「invalid UTF-8 text」），文案与错误码和 dsh-fs-local 逐字一致；`streamText` 把整段文本作为单个 chunk 产出（下游不赋予 chunk 边界含义，单 chunk 是合法流）。
  - `readBytes`：`maxBytes` 按**明文长度**执行——超限抛 `FS_TOO_LARGE`（同原文案），不截断；未传上限则不设限，同原方法。
  - `readByteRange`：窗口取自明文（`subarray(offset, offset+length)`），`length` 为 0 或窗口越过结尾返回空，同原方法。加密判定先于参数校验：加密文件的任何参数组合都不会交回原方法。
- **`editText`**：只做最低要求——检测到 TSD 头即抛与读路径同样的明确错误（见 §3），不再出现误导性的 "binary file"。**不**基于回退明文完成编辑：`readForEdit` 是 dsh-fs-local 的模块私有函数，注入明文需要复制其编辑临界区（读-匹配-写）的实现，违背「不要大段复制 DSH 的代码」；且写回经 node 落盘后会按策略重新加密，语义上等于新建加密文件，收益存疑。留待后续任务裁决。
- `writeText` 内部的 `readTextForDiff` 不动（读不到时本来就退回整文件 diff，决策 090 已裁决写入路径维持 DSH 做法）。
- 安装幂等：重复安装是 no-op（实例上的标记符号）；服务重建会丢包装——产品组合里 `fs-sandbox` 一次性加载、`hmr` 行已禁用，本任务按一次性装载处理，真宿主已验证。

## 3. 错误码与文案

单一错误码 **`FS_ENCRYPTED`**，所有回退失败共用（仍密文、PowerShell 失败、超时、超上限），消费方只需路由一个失败类：

- 读：`cannot read "<path>": the file is protected by a disk-encryption policy and cannot be read here`，按原因追加子句（`— the decryption fallback returned ciphertext too` / `— the decryption fallback failed: <原因>` / `— the decrypted file is larger than the 33554432-byte fallback limit`）；
- 编辑：`cannot edit "<path>": the file is protected by a disk-encryption policy and cannot be read here`；
- 回退途中调用方中止映射为 `FS_ABORTED`（`read aborted`），与 DSH 的中止语义一致。

英文文案与 DSH 的全部 `FsError` 措辞风格一致；`dsh-tool-fs` 的 `remediateFsError` 对未知码原样透传，模型与用户看到的都是这句明确的说明。**密文绝不作为内容交给模型。**

## 4. PowerShell 5.1 的调用方式（安全边界）

- 绝对路径 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（`SystemRoot` 缺失即报错），不查 PATH，不用 pwsh 7；
- 参数 `-NoProfile -NonInteractive`，脚本经 `-EncodedCommand`（UTF-16LE base64）传入；
- 文件路径经环境变量 `AICLIENT_FS_PATH` 传入，不拼进脚本文本、不经 shell；`windowsHide: true`；
- 脚本用 `[System.IO.File]::ReadAllBytes` 读全文件，`[Convert]::ToBase64String` 编码，stdout 输出 `AICLIENT-FS-B64-BEGIN\n<base64>\nAICLIENT-FS-B64-END\n`；错误走 stderr 并以非零码退出；
- **分帧：采用**。实测（加密机）stdout 除该帧外无任何杂音（无 BOM、无提示），但严格帧解析（首尾标记、单行 base64、字母表校验）保证 PowerShell 一旦混入别的文本就失败而不是污染内容；
- **超时 10 秒**（自进程 spawn 起算，排队不占预算）、**stdout 上限 48 MiB**、**明文上限 32 MiB**（另在包装层复核，注入的伪读取器也受约束）、**并发上限 2 个 PowerShell 进程**，超出的调用 FIFO 排队，排队中被中止的调用不再 spawn；
- 任一熔断（超时 / abort / 超限 / 非零退出 / 帧不合法）都以 `child.kill()` 结束子进程并抛 `FS_ENCRYPTED`——实现里没有任何 `process.kill`、不按 pid、不按进程名；
- 明文只存在于管道与内存，不落盘、不缓存。

## 5. 静态守卫（DSH 升级哨兵）

`src/dsh-host/__tests__/encryptedReadSeam.test.ts` 钉住 DSH 0.1.7-rc.2 的接缝，升级后任一变化即红：

- `dsh-base/cordis.patch.yml` 的 `fs-sandbox` 行（id 与 `@deepseek-ai/dsh-fs-sandbox` 名）；
- `dsh-fs` 以 Cordis `Service` 注册、服务名 `"fs"`（`super(ctx, "fs")`）；
- `LocalFileSystem` 四个读方法与 `editText` 的**确切签名**，及其委托的 whole-file helper 与二进制 / 超限文案；
- `SandboxedFileSystem` 只加写侧围栏（读全部继承），`editText` 的五参形态与 `super.editText(await this.checkedTarget(...))` 透传；
- `dsh-tool-fs` 的调用点：`ctx.fs.streamText/readText(target, exec.signal)`、`ctx.fs.readBytes(target, exec.signal, byteCap)`、`ctx.fs.editText(target, {…}, intent, exec.signal, sandboxPolicy)`；
- `dsh-skill-filesystem` 的 `fs.readText(target, signal)` 与 `dsh-agent-instructions` 的 `fileSystem.streamText(file.target, signal)`。

## 6. 刻意不做的事

- 不加环境开关（类比 `AICLIENT_RUNTIME_LOOP_GUARD=0` 的紧急关闭）：本行没有行为开关的需求方，加开关就多一条与产品语义无关的路径；如后续需要，加在 `apply` 的平台判定旁即可。
- 不动 grep / glob（随包 ripgrep 子进程）、bash / pwsh 工具、Electron 主进程（文件树、编辑器）、DSH 自身的配置与会话文件读取——均为范围外，观察记录在证据文档。
- 不做「明文编辑」（见 §2）。

## 7. 验证结论（摘要，细节见证据文档）

真宿主（打包产物 + 随包 node + 本地假网关）双模式通过：伪造 TSD 文件得到明确 `FS_ENCRYPTED` 拒绝且密文从未上送；加密机上真实加密的 `.yml` 经回退读出明文（工具层 174 ms，恰好一次 PowerShell 拉起，探针 hook 日志佐证）。单测 +32（Linux 可跑 22 + win32 真机 5 + 静态哨兵 9 中的新增部分），四条 typecheck、宿主构建、打包冒烟与基线零回归。
