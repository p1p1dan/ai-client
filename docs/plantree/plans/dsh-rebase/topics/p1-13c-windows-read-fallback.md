Role: topic

# P1-13c Windows 读密文回退：派工说明（交 Windows 机执行）

上位：[roadmap P1-13](../roadmap.md)。建立：2026-09-28。依据：[决策 090](../decisions/090-user-rulings-2026-09-28.md) 的「Q009 的绕行办法」、[P1-13b 摘要](../evidence/p1-13b-encryption-matrix-2026-09-28.md)。

用户 2026-09-28 决定：P1-13c 交给 Windows 机上的会话执行，结果转回编排者合并。下面「提示词」一节原样交给 Windows 端。决策编号 091 预留给本任务。

## 提示词

# 任务：DSH P1-13c —— Windows 上读到加密文件时改用 PowerShell 5.1 回读

你在 Windows 机器上为 ai-client 仓库做 P1-13c。先读完这份说明再动手。回复用简体中文，代码注释用英文。

## 0. 背景（已有结论，不用重新调研）

- ai-client 正在分支 `feat/dsh-p0-probe` 上把聊天引擎整体换成 DeepSeek Harness（DSH，版本钉在 `0.1.7-rc.2`），宿主代码在 `src/dsh-host/`。
- 用户裁决（决策 090）：
  - 默认跟随 DSH 的做法；
  - 只做 Linux 与 Windows；
  - 公司加密策略造成的读取问题由产品自己绕开，办法就是本任务。
- P1-13b 在加密机上测得的结论（脱敏）：
  - 随包 node.exe 读已加密的 yml、rb、php、ps1、cmd、sql、scss、docx、pptx 这 9 类文件，拿到的是密文；Electron 以 node 模式运行时结果相同。
  - 其中 yml、php、ps1、cmd、sql、scss 这 6 类，用 Windows PowerShell 5.1 的 `[System.IO.File]::ReadAllBytes($path)` 能读出明文；rb、docx、pptx 用什么读都是密文。
  - 能不能解密与读文件的进程名无关。
  - md、java 等类型，node 读得出明文，PowerShell 反而读成密文。所以只在 node 读到密文时才回退。
  - 密文的特征：文件开头 16 字节是 ASCII 字符串 `%TSD-Header-###%`，十六进制为 `25 54 53 44 2d 48 65 61 64 65 72 2d 23 23 23 25`。
  - 同一个加密文件，不同进程 stat 到的大小不一样：有的是 8192，有的是明文长度。所以既不能凭大小判断是否加密，也不能用 stat 大小去限制回退读出的长度。
  - 策略生效有延迟：约 260 秒后再读，有些读者的结果会变。
- 写入维持 DSH 的做法（决策 090 推翻了决策 089 的硬链接修复），本任务不动写入路径。

## 1. 需求

1. 只在 `process.platform === 'win32'` 时生效。Linux 和 macOS 上的行为与性能不能有任何变化。
2. 回退要覆盖宿主 fs 服务的四个读入口：`readText`、`streamText`、`readBytes`、`readByteRange`。
   - 触发条件：node 读到的文件在偏移 0 处以 TSD 头开头（只比开头 16 字节，不要用 includes）。
   - 触发后，改由 Windows PowerShell 5.1 读出同一个文件的全部字节。
   - 读出的内容不以 TSD 头开头：当作文件内容，按原方法的语义交回。
     - `readText` / `streamText`：照原样拒绝二进制，严格按 UTF-8 解码；
     - `readBytes`：照原样执行 `maxBytes` 上限；
     - `readByteRange`：在明文上取窗口。
   - 读出的仍以 TSD 头开头，或者 PowerShell 失败、超时、超出上限：抛 `FsError`，让模型和用户都能看懂「此文件被加密策略保护，无法读取」。错误码和文案由你定，写进决策。**绝不能把密文交给模型。**
3. `edit`，即 `editText` 内部的读：
   - 最低要求：遇到 TSD 文件，报与上一条同样明确的错误，不能再报现在这个误导人的 "binary file"。
   - 要不要让 edit 基于回退读出的明文完成编辑，由你决定并写进决策；但不要大段复制 DSH 的代码。
   - `writeText` 内部读 diff 基准用的 `readTextForDiff` 不用管：读不到时它本来就退回整文件 diff。
4. 安全：
   - 用绝对路径 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，不靠 PATH，也不用 pwsh 7。
   - 带 `-NoProfile -NonInteractive` 参数，脚本经 `-EncodedCommand` 传入。
   - 文件路径经环境变量传进去，不拼进脚本文本；不经 shell；设 `windowsHide: true`。
   - 设超时，跟随 abort signal，限制输出大小；任何一项触发，都用 `child.kill()` 结束子进程并报错。
   - 限制同时运行的回退 PowerShell 进程数。
   - 明文不落盘、不缓存。
   - 建议 stdout 用 base64 加前缀标记分帧，防止 PowerShell 往 stdout 混入别的文本；是否采用，实测后再定。
5. 静态守卫：DSH 升级时，fs 服务的这几个方法名或调用点变了，或者 `fs-sandbox` 这一行变了，测试要失败。
6. 读普通文件（不以 TSD 头开头）时，额外开销最多是读一次开头 16 字节，不能启动 PowerShell。

## 2. 代码位置（编排者在 Linux 上查过）

以下是 DSH 0.1.7-rc.2 的代码，在 `src/dsh-host/node_modules/@deepseek-ai/` 下。

- **fs 服务**：组合里的 fs 服务来自 `dsh-base` 的 `fs-sandbox` 行，也就是 `dsh-fs-sandbox` 导出的 `SandboxedFileSystem`，它继承 `dsh-fs-local` 的 `LocalFileSystem`。
  - 四个读方法都继承自 `LocalFileSystem`，在 `dsh-fs-local/lib/index.js` 约 825～845 行；
  - `writeText`、`editText` 先由 `SandboxedFileSystem` 做沙箱检查，再调父类；
  - `editText` 内部用模块私有的 `readForEdit` 读文件，`writeText` 内部用 `readTextForDiff` 读 diff 基准。
- **调用方**：
  - `dsh-tool-fs` 的 `read` 按文件大小选 `readText` 或 `streamText`，约第 348 行；
  - `dsh-tool-fs` 的 `read_image` 用 `readBytes`，约第 1009 行，只接受图片扩展名；
  - `dsh-tool-fs` 的 `edit` 用 `editText`；
  - `dsh-skill-filesystem` 用 `readText`；
  - `dsh-agent-instructions` 用 `streamText`。
- **我方宿主行**都照 `aiclient-loop-guard` 的写法：
  - 源码在 `src/dsh-host/loopGuard/`，shim 是 `src/dsh-host/bundle/lib/loop-guard.js`；
  - 要登记的地方：`src/dsh-host/bundle/package.json` 的 exports、`src/dsh-host/bundle/cordis.patch.yml` 的 insert、`src/dsh-host/lib/hostProfile.ts`；
  - 打包在 `scripts/build-dsh-host.mjs` 与 `scripts/dsh-host-build-lib.mjs`；
  - 静态测试在 `src/dsh-host/__tests__/hostStatic.test.ts`、`src/dsh-host/lib/__tests__/hostProfile.test.ts`、`scripts/__tests__/dsh-host-build-lib.test.mjs`；
  - Main 侧的 `src/main/services/agent-host/dshHostEnvironment.ts` 也引用了行名。
  - 动手前先跑 `git grep -n -E "loop-guard|loopGuard|LOOP_GUARD" -- src scripts`，把所有登记点看全。
- **不在本任务范围**，只记录观察，不实现：
  - `grep` / `glob` 调用随包的 ripgrep 子进程读文件；
  - bash 与 pwsh 工具在子进程里读文件；
  - Electron 主进程（文件树、编辑器）的读取；
  - DSH 直接用 node:fs 读的配置与会话文件。

## 3. 推荐做法

- **首选 A**：新增宿主行，比如叫 `aiclient-encrypted-read`，目录放在 `src/dsh-host/encryptedRead/`。
  - 声明 `inject: ['fs']`，在 win32 上启动时包装 fs 服务实例的读方法。
  - 包装逻辑：先读文件开头 16 字节；不是 TSD 头就原样调用原方法，是就走回退。
  - 纯逻辑单独成模块，包括头判定、PowerShell 调用与分帧解析、按原语义还原结果。PowerShell 读取器通过注入传进来，这样 Linux 上也能单测。
- **退路 B**：如果 Cordis 的服务代理让包装不生效，或者服务重建后包装丢失，就改为继承 `SandboxedFileSystem`，另起一行替换 `fs-sandbox`，并相应调整 `hostProfile.ts` 里的 `REQUIRED_*`。
- 不论 A 还是 B，都要在真宿主里证明 `read` 工具确实走到了回退。**不改 DSH 包里的任何文件。**

## 4. 步骤与验证

1. **装依赖**，都在仓库根目录执行：
   - `pnpm install`；
   - 在 `src/dsh-host`、`src/runtime`、`src/agent-host` 下各执行一次 `npm ci`（它们是独立子包）；
   - `pnpm fetch:node-runtime`，准备随包 node。
2. **先问用户，这台机器是不是装了加密策略的加密机。** 用户也不确定时：用 PowerShell 5.1 新建一个 `.yml` 文件，再用 node 读它开头 16 字节，看是不是 TSD 头。
3. **改代码前先跑基线**，记下每条命令通过、失败、跳过各多少：

   ```
   npx tsc --noEmit
   npx tsc --noEmit -p src/agent-host
   npx tsc --noEmit -p src/runtime
   npx tsc --noEmit -p src/dsh-host/tsconfig.json
   npx vitest run src/dsh-host src/shared/permissions src/main/services/agent-host/__tests__ scripts/__tests__/dsh-host-build-lib.test.mjs
   （设环境变量 AICLIENT_DSH_INTEGRATION=1）npx vitest run src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts
   （在 src/dsh-host 下）<随包 node> tools/bridge-smoke.ts --out <临时目录>\bs.json
   （在 src/dsh-host 下）<随包 node> tools/loop-guard-smoke.ts --out <临时目录>\lg.json
   <随包 node> src/dsh-host/tools/bridge-record.ts --check
   node scripts/build-dsh-host.mjs
   node scripts/packaged-dsh-host-smoke.mjs --host-dir out-dsh-host --node <随包 node> --level 1 --report <临时目录>\l1.json
   ```

   - `<随包 node>` 是 `out-node-runtime` 下的 node.exe。
   - 这些命令是在 Linux 上写成的，里面有 `/tmp`、`/proc`、systemd scope 这类 Linux 专属写法。Windows 上失败或跳过的项照实记下，**不要为了让基线变绿去改它们**。
4. **单测**，放在相关目录的 `__tests__` 下。
   - **Linux 上也能跑的**：注入假读取器，逐个覆盖四个读入口，每个入口测回退成功、仍是密文、PowerShell 失败三种情况。另外还要测：
     - 非 win32 不包装；
     - 读普通文件不调用读取器（用计数 spy 断言）；
     - `readBytes` 的上限按明文计算；
     - `readByteRange` 的偏移窗口取自明文。
   - **只在 win32 上跑的**（用 `skipIf`）：
     - 用真的 powershell.exe 读伪造的 TSD 文件（`%TSD-Header-###%` 后面接随机字节），应得到明确的错误；
     - 路径里含空格、中文、`'`、`"`、`$`、反引号、`&`、`;` 时能正确传入，并且不会被当成命令执行；
     - 超时和 abort 都会杀掉子进程；
     - 输出超过上限时报错。
5. **真宿主**：在集成测试或 bridge-smoke 里加一个场景，`read` 读伪造的 TSD 文件得到明确的错误，读普通文件一切照常。
6. **改完后复跑第 3 步整套**，逐条与基线对比。`bridge-record --check` 不应出现差异；如果出现，先报告，**不要用 `--update` 重录金样本**。
7. **加密机实测**：
   - **如果本机就是加密机**：用真实的加密文件实测。上面 9 类每类至少一个，再加 txt、md 作对照。
     - 经宿主的 `read` 读取；有已加密的图片的话，再试 `read_image`；挑一个 yml 试 `edit`。
     - 预期：yml、php、ps1、cmd、sql、scss 读出明文；rb、docx、pptx 报明确的错误；txt、md 直接读出，不启动 PowerShell。
     - 记录每次回退的耗时。过 5 分钟以上，再全部读一遍。
   - **如果本机不是加密机**：参照 `src/dsh-host/tools/p1-13b/`、`src/dsh-host/tools/p0-4/` 的做法，做一个 P1-13c 上机包和一份操作手册，交给用户到加密机上跑。上机包输出的结果要自带脱敏摘要。

## 5. 分支、提交与交付

- **分支**：从 `origin/feat/dsh-p0-probe`（`eda6c248`）开本地分支 `feat/dsh-p1-13c`，只在这个分支上提交。不动 main，也不动 `feat/dsh-p0-probe`。
- **决策**：写成新文件 `docs/plantree/plans/dsh-rebase/decisions/091-p1-13c-windows-read-fallback.md`，标明「自主决定，待用户审批」。编号 091 已预留给本任务。
- **证据**：写成新文件 `docs/plantree/plans/dsh-rebase/evidence/p1-13c-windows-read-fallback-<YYYY-MM-DD>.md`，只写脱敏摘要。
- **不要改**这几个文件：`roadmap.md`、`implementation-status.md`、`README.md`、`decision-review.md`、`CLAUDE.md`。编排者合并时会同步。
- **提交**：用 Conventional Commits，描述写中文，末尾加上 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- **推送前先问用户**。
  - 用户同意，就把 `feat/dsh-p1-13c` 推到 origin；
  - 不同意，就执行 `git bundle create p1-13c.bundle origin/feat/dsh-p0-probe..feat/dsh-p1-13c`，把生成的文件交给用户。

## 6. 规则（必须遵守）

- **仓库是公开的**。机器名、用户名、域账号、内网地址、真实文件路径、加密客户端的产品信息，一律不许入库，提交信息和测试夹具里也不行。现场的原始输出只留在本机。
- **需要模型时，只用本地假网关** `src/dsh-host/tools/fake-gateway.mjs`。
  - 禁止调用公司网关、vllmproxy、maxapi、cx2，以及任何私人渠道；
  - 假网关用不了，就停下来报告，不许自己换渠道。
- 不读、不打印真实凭据。不读真实用户数据：`~/.pilab/*`、`~/.pi`、已安装应用的用户数据目录。
- **结束进程**只能按确切的 pid，或者用 `child.kill()`。禁止 `taskkill /IM`、禁止按进程名杀、禁止 `kill(-1)`、禁止负 pid。测试里要 mock `process.kill`。
- 跑冒烟或宿主脚本时，命令行里不能出现 `vitest` 字样。
- 不跑全量 vitest，只跑相关的测试文件。
- 需求本身有歧义，或者不改 DSH 包文件就做不成时，停下来问用户。

## 7. 交回报告

用中文写，脱敏；用户会转给编排者。包括以下几项：

1. **分支与交付**：分支名、提交号列表、`git diff --stat origin/feat/dsh-p0-probe..feat/dsh-p1-13c` 的输出；推送了没有，或者 bundle 文件放在哪里。
2. **实现**：
   - 选了 A 还是 B，为什么；
   - 四个读入口和 edit 各自的行为；
   - 错误码与文案；
   - PowerShell 的调用方式、超时、输出上限、并发上限。
3. **决策 091**：要点逐条列出。
4. **验证**：
   - 每条命令在基线和改动后的通过、失败、跳过数；
   - 新增测试的数量；
   - 真宿主的结果。
5. **加密机实测**：
   - 上了加密机：按「文件类型 × 读入口」列表，每格填明文、明确报错或其他，附上每次回退的耗时；
   - 没上加密机：给出上机包的位置、sha256 和操作手册的位置。
6. **其他**：超出范围的观察（ripgrep、终端、编辑器等）和遗留问题。
