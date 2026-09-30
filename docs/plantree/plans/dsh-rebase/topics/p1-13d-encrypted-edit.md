Role: topic

# P1-13d：Windows 上对加密文件完成 edit（派工提示词）

上位：[roadmap P1-13](../roadmap.md)。依据：[决策 135](../decisions/135-user-ruling-encrypted-edit.md)（用户推翻决策 091 §2 的「edit 不做明文编辑」）、[决策 091](../decisions/091-p1-13c-windows-read-fallback.md)。执行方：Windows 加密机上的会话。交回后由编排者验证合入。

## 提示词

```text
# 任务：DSH P1-13d —— Windows 上对加密文件完成 edit（扩展 aiclient-encrypted-read）

你在 Windows 加密机上为 ai-client 仓库做 P1-13d。先读完这份说明再动手。回复用简体中文，代码注释用英文。

## 0. 背景

- P1-13c 已合入 `feat/dsh-p0-probe`（提交 `f84f7bbd`，合的是 `feat/dsh-p1-13c` 的 `801cac53`）。那一版里 `editText` 碰到 TSD 文件只报 `FS_ENCRYPTED`，不做编辑。
- 用户推翻了这一条（决策 135，全文在 `docs/plantree/plans/dsh-rebase/decisions/135-user-ruling-encrypted-edit.md`，动手前必读）：改为要做，方案和验证要求都已定死，照做即可。
- 这两天合进来的其他改动你要知道：
  - 决策 134 改了权限闸门的路径规范化（Windows 上工作区与各根目录改用 `realpathSync.native`）；
  - 新增了只打包宿主的 Windows 冒烟工作流 `dsh-host-windows-smoke.yml`；
  - `.gitattributes` 已把 `.yml` / `.yaml` 固定为 LF，不再需要改 `core.autocrlf`。

## 1. 需求（决策 135 定的，不要改方案）

1. **只扩展 `aiclient-encrypted-read` 行**（`src/dsh-host/encryptedRead/`）：在 fs 服务实例上，把 `editText` 的读基准换成 PowerShell 回退读出的明文。不新增工具，不替换 `edit` 工具，不改任何 `@deepseek-ai/` 包文件。
2. **替换语义自己写**（约 60 行，放一个纯函数模块，便于单测）：
   - 支持 `old_string` / `new_string` / `replace_all`；按 LF 匹配，再按原文件的行尾风格（CRLF / LF）写回；
   - 错误码与文案和 `dsh-fs-local` 逐字对齐：`FS_STALE_VERSION`、`FS_NOT_REGULAR_FILE`、`FS_NOT_TEXT`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`。对照的源码在 `src/dsh-host/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js`：`readForEdit`（约 621 行）、替换逻辑（约 689～704 行）、`writeText`（约 864 行）、`editText`（约 883 行）。空 `old_string`、二进制、非法 UTF-8、BOM 等边界都照原实现。
3. **写回、版本守卫、沙箱围栏复用 fs 服务自己的公开方法**：`writeText(target, content, { kind: 'replaceIfVersion', version }, signal, sandboxPolicy)`、`stat`、`SandboxedFileSystem.checkedTarget`。不复制 DSH 的「读-匹配-写」临界区。
   - 调用方（`dsh-tool-fs` 的 `edit`）传进来的 `expected` 与 `sandboxPolicy` 照原语义处理：有 `expected` 时先核对版本；沙箱检查不能被绕过（经 `checkedTarget` 或 `writeText` 的五参形态）。
4. **并发语义用乐观版本守卫**：回退读之前用 node `stat` 记下版本，写回时用 `replaceIfVersion`；读之后文件被任何人改过就拒绝写回（`FS_STALE_VERSION`）。这比 DSH 原实现「锁内读改写」更严格，是有意为之，写进决策。
   - 要实测一个风险：P1-13b 发现不同进程 stat 到的大小可能不同，策略还有读者视图沉淀。确认同一个 node 进程里，「回退读之前的 stat」与「写回时的 stat」版本一致，不会凭空报 `FS_STALE_VERSION`；有问题就停下报告。
5. **范围**：
   - 已加密且 PowerShell 能解密的 6 类（yml、php、ps1、cmd、sql、scss）可以编辑；
   - 回退读出来仍是密文的文件（rb、docx、pptx 等），维持 `FS_ENCRYPTED` 明确拒绝，文案用决策 091 里 edit 的那句；
   - 非 win32、没有 TSD 头的普通文件：行为零变化，原样调用原 `editText`（锁内读改写），额外开销仍只有读开头 16 字节。
6. **写回后文件会被策略重新加密**，这是预期语义：下次读会自动走回退，形成闭环。写回走 fs 服务，不要自己用 PowerShell 写。
7. **可选的紧急开关**（用户说不强制，建议顺手做）：`AICLIENT_RUNTIME_ENCRYPTED_READ=0` 时，行不包装任何方法，行为等同没有这一行。
   - 行仍然组合在内（`hostProfile.ts` 的 `REQUIRED_ENABLED` 不改），只在 `apply` 里判环境变量，做法照 `src/dsh-host/loopGuard/`（`LOOP_GUARD_ENV`）；
   - Main 要把这个变量转发给宿主：`src/main/services/agent-host/dshHostEnvironment.ts` 的 `FORWARDED_ENV`，测试在 `src/main/services/agent-host/__tests__/DshHostProcess.test.ts`。

## 2. 验证（决策 135 定的）

1. **假读取器单测**（Linux 也能跑）覆盖全部语义矩阵：
   - 每个错误码；
   - CRLF / LF 行尾；
   - 版本守卫：`expected` 不符、读后被改、文件被删；
   - `replace_all`、多处匹配、没匹配；
   - 写回的调用形态：断言调的是 `writeText` 带 `replaceIfVersion` 与 `sandboxPolicy`；
   - 非 win32 与普通文件不走新路径，用计数 spy 断言。
2. **win32 真机**（`skipIf` 非 win32 的测试，加上手工实测）：在真实加密的 `.yml` 上完成一次真实 edit，再复读验证：经回退读出的明文含新内容，node 视角开头仍是 TSD 头（被重新加密）。
3. **真宿主冒烟**：扩展 `src/dsh-host/tools/encrypted-read-smoke.ts` 与假网关 `src/dsh-host/tools/fake-gateway.mjs` 的 FS 脚本，加「对加密文件完成 edit」的场景，fake 与 `--real` 两种模式都要跑。保持向后兼容：旧参数、旧场景的行为与判据不变；bridge-smoke 和录制金样本用到的假网关脚本输出不能变。
4. **基线零回归**：改代码前先跑一遍，记下每条命令通过、失败、跳过各多少；改完再跑，逐条对比：
   npx tsc --noEmit
   npx tsc --noEmit -p src/agent-host
   npx tsc --noEmit -p src/runtime
   npx tsc --noEmit -p src/dsh-host/tsconfig.json
   npx vitest run src/dsh-host src/shared/permissions src/main/services/agent-host/__tests__ scripts
   npx vitest run Static Scan Wiring src/shared/__tests__
   <随包 node> src/dsh-host/tools/bridge-record.ts --check
   node scripts/build-dsh-host.mjs
   node scripts/packaged-dsh-host-smoke.mjs --host-dir out-dsh-host --node <随包 node> --level 1 --report <临时目录>\l1.json
   - `<随包 node>` 是 `out-node-runtime\node.exe`；
   - 冒烟类命令单独跑，命令行里不能出现 `vitest` 字样，也不要和 vitest 串在同一条 shell 命令里；
   - 这些命令里有 Linux 专属写法，Windows 上失败或跳过的项照实记下（P1-13c 的基线已记过几项），不要为了变绿去改它们。决策 134 修过 Windows 上的打包冒烟，现在 L1 在 Windows 上应该 44 项全过；不过的话照实报告。

## 3. 分支、提交与交付

- 从 `origin/feat/dsh-p0-probe` 的最新头开本地分支 `feat/dsh-p1-13d`，只在这个分支上提交。不动 main、`feat/dsh-p0-probe`、`feat/dsh-p1-13c`。
- 决策：新文件 `docs/plantree/plans/dsh-rebase/decisions/136-p1-13d-encrypted-edit-choices.md`，标「自主决定，待用户审批」。编号 136 已预留。
- 证据：新文件 `docs/plantree/plans/dsh-rebase/evidence/p1-13d-encrypted-edit-<YYYY-MM-DD>.md`，只写脱敏摘要。把决策 135 里用户补充的实测数据并进来（settled 复测、260 秒是读者视图沉淀、回退 143～189 ms）；P1-13c 的证据文档不改。
- 不要改：`roadmap.md`、`implementation-status.md`、`README.md`、`decision-review*.md`、`CLAUDE.md`、决策 091 与 135。编排者合并时会同步。
- 提交：用 Conventional Commits，描述写中文，末尾加上 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- 推送前先问用户；同意就推 `feat/dsh-p1-13d` 到 origin，不同意就做 bundle：`git bundle create p1-13d.bundle origin/feat/dsh-p0-probe..feat/dsh-p1-13d`。

## 4. 规则（必须遵守）

- 仓库是公开的。机器名、用户名、域账号、内网地址、真实文件路径、加密客户端的产品信息，一律不许入库，提交信息和测试夹具里也不行。现场原始输出只留在本机。
- 需要模型时只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`；禁止公司网关、vllmproxy、maxapi、cx2 以及任何私人渠道；假网关用不了就停下报告，不许自己换渠道。
- 不读、不打印真实凭据；不读真实用户数据（`~/.pilab/*`、`~/.pi`、已安装应用的用户数据目录）。
- 结束进程只能按确切 pid，或者用 `child.kill()`。禁止 `taskkill /IM`、按进程名杀、`kill(-1)`、负 pid；测试里 mock `process.kill`。
- 不跑全量 vitest，只跑相关的测试文件。
- 真机实测只动你自己新建的临时文件，不碰已有的真实加密文件。
- 需求有歧义，或者不改 DSH 包文件就做不成时，停下来问用户。

## 5. 交回报告

用中文写，脱敏；用户会转给编排者。包括：
1. 分支名、提交号列表、`git diff --stat origin/feat/dsh-p0-probe..feat/dsh-p1-13d`；推送了没有，或者 bundle 在哪里。
2. 实现：editText 新路径的流程；替换语义与 DSH 对齐的方式；版本守卫与沙箱检查怎么复用；紧急开关做了没有。
3. 决策 136 要点。
4. 验证：每条命令基线与改动后的通过、失败、跳过数；新增测试数；真宿主两种模式的结果。
5. 加密机实测：6 类可编辑类型各 edit 一次的结果与耗时，rb / docx / pptx（能造出加密样本的话）的拒绝结果，写回后重新加密的确认，stat 版本稳定性的实测。
6. 其他：超出范围的观察与遗留问题。
```
