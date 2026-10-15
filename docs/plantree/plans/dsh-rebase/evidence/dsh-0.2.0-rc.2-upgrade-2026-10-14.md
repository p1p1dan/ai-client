# 证据：DSH 0.1.7-rc.2 → 0.2.0-rc.2 升级前后对照（2026-10-14，Windows 开发机）

[决策 189](../decisions/189-dsh-0-2-0-rc-2-upgrade.md) 的证据。

- **方法**：同一台机器、同一个 worktree，先在升级前（`main` 的 `79f81cdb`，DSH 0.1.7-rc.2）把每一项跑一遍；再在升级后的最终代码上（`f8aadf0a`，含决策第 6 节的技能隐藏）按同样的方式跑一遍。
- **不涉及真实模型或真实账号**：模型回复全部来自本地假网关 `src/dsh-host/tools/fake-gateway.mjs`，没有真实模型、没有 key。
- **原始输出不入库**：留在开发机的 `%TEMP%\dsh-upg\`；这里只记数字。复跑脚本在同名目录 [`dsh-0.2.0-rc.2-upgrade-2026-10-14/scripts/`](dsh-0.2.0-rc.2-upgrade-2026-10-14/scripts/)。

## 环境

| 项 | 值 |
|---|---|
| 系统 | Windows 10 Pro 19043，12 核，16 GB |
| Node | 系统 24.12.0（随包钉的是 24.18.0，本机没取） |
| 包管理 | npm 11.6.2、pnpm 10.26.2 |
| 根依赖 | `pnpm install --frozen-lockfile --ignore-scripts`（与 `dsh-bridge-gate.yml` 相同） |
| 宿主依赖 | 升级前 `npm ci --ignore-scripts --no-audit --no-fund`；升级后为重新生成的锁文件 |
| Linux | 本机没有 WSL，Linux 上的闸门没跑（见第 8 节） |

## 0 在 Windows 上跑源码探针

`src/dsh-host/tools/` 的探针是为 Linux 写的，在 Windows 上升级前就跑不起来：

- 启动宿主时传 `--import F:\…\probe-hooks.mjs`。Windows 上 Node 把盘符读成 URL scheme，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，宿主起不来。
- `waitQuiet()` 读 `/proc`，内存检查读 `/proc/meminfo`，`p0-6` 读 `/proc/<pid>/stat`、发 `SIGSTOP`、调 `flock`，都直接抛错。

**做法**：`scripts/win-shim.mjs` 在探针进程里打补丁，探针工具本身不改：

- `--import` 的盘符路径改成 `file://` URL；
- `/proc/meminfo` 用 `os.freemem()` 作答，读 `/proc` 目录得空表，`/proc/<pid>/stat|status` 读成 0；
- 跳过 `SIGSTOP` / `SIGCONT`；
- 环境变量 `SHIM_GATEWAY_MODEL_ID` 可以改假网关回复里的模型名（第 5 节）。

**在 Windows 上，以下这些两个版本一样，都与 DSH 版本无关**：

- DSH 只挂 `pwsh`，没有 `bash`。脚本里写死调用 `bash` 的场景得到 `unknown tool "bash"`，所以：
  - `job-notice`、`jobs-kill`、`steer-withdraw` 三个录制场景中途放弃；
  - `steer` 与前缀探针 S1 的「命令跑着时插话」变成竞态（第 3、4 节）。
- 进程树与 RSS 采样什么都看不到。
- `p0-6` 的「楔住的宿主」一步没有意义。
- 录制里出现本机真实 HOME 下的 5 个用户级 skill（`capabilities.skills: 5`）。

## 1 锁文件（`src/dsh-host/package-lock.json`）

- 条目 409 → 414。
- **DSH**：147 个 `@deepseek-ai/dsh-*` 全部变成 `0.2.0-rc.2`，新增 `@deepseek-ai/dsh-otel`，一个也没删。cordis `4.0.4`、`@deepseek-ai/schemastery 3.18.4`（顶层）不变。
- **非 DSH 新增 25 个**：
  - `got@14.6.6` 及其依赖：`cacheable-request`、`http2-wrapper`、`keyv` 等，都是 `dsh-otel` 带来的；
  - `proxy-agent-negotiate`；
  - `gaxios` 下嵌套的旧版 proxy agent 四个包。
- **非 DSH 删除 21 个**：`@opentelemetry/exporter-logs-otlp-http`、`@aws-crypto/*` 四个、旧 koffi 的 5 个平台包、若干嵌套的旧 `@opentelemetry/*`、`@smithy/*` 等。
- **非 DSH 变版本 47 个**：
  - pi-ai 带来的：`@earendil-works/pi-ai`、`pi-telemetry` `0.85.1 → 0.87.1`，`@anthropic-ai/sdk 0.123.0 → 0.124.0`，`@google/genai 1.52.0 → 2.21.0`，aws-sdk / smithy 若干补丁版，`agent-base 7.1.4 → 9.0.0`，`http(s)-proxy-agent 7 → 9.1.0`（pi-ai 里只有 Bedrock 用），`typebox 1.3.7 → 1.3.27`；
  - `koffi` 与它的 15 个平台包 `3.3.1 → 3.1.1`：DSH 包改成精确依赖 3.1.1，`npm dedupe` 后只留顶层一份；
  - 其他：`@opentelemetry/resources 2.11.0 → 2.9.0`，`@types/node`、`@babel/runtime` 补丁版。
- **生成方式**：直接 `npm install` 报 `ERESOLVE`（旧条目里 `dsh-config-editor@0.1.7-rc.2` 的 peer 与新版 `dsh-app-boot` 冲突），于是：
  1. 删掉锁文件里全部 `@deepseek-ai/dsh-*` 与 `dsh-office-tools` 条目（149 条）；
  2. `npm install --ignore-scripts --no-audit --no-fund`；
  3. `npm dedupe`（把 5 份嵌套 koffi 合成 1 份，并去掉嵌套的 `@opentelemetry/*`）。
- 安装结束时 npm 报了 28 条 `ERESOLVE overriding peer dependency` 警告：DSH 各包之间互相写精确 peer，npm 提示得很啰嗦。升级前的 `npm ci` 有 1 条同类警告。
- 最终树里所有 DSH 包都在钉版本。用新锁文件跑 `npm ci --ignore-scripts --no-audit --no-fund`（构建脚本里那一步，与 CI 相同）一次装好 354 个包，构建预检的漂移检查也通过（第 7 节）。

## 2 静态检查与单测

| 检查 | 0.1.7-rc.2 | 0.2.0-rc.2（最终） |
|---|---|---|
| `pnpm typecheck:dsh-host` | 退出 0 | 退出 0 |
| `pnpm typecheck` | 退出 0 | 退出 0 |
| `vitest run src/dsh-host src/shared` | 3023 项：2995 过 / 15 挂 / 13 跳过 | 3028 项：3000 过 / 15 挂 / 13 跳过 |
| 挂的那 15 项 | Windows 环境：符号链接权限、8.3 短名、会话 GC 的文件锁（6 个文件） | **与升级前逐项相同**，新挂 0、新过 0 |
| `scripts/__tests__` 里 DSH 相关 7 个文件 | 升级前没跑 | 180 项：178 过 / 1 挂 / 1 跳过；挂的是 `verifyDshArtifact rejects a symbolic link`（Windows 建符号链接 `EPERM`，与 DSH 无关） |
| biome（32 个改动的源文件、证据脚本） | — | 无问题 |

新增的 5 项：

- `forkSeed` 两项。变异验证：旧复制在合成日志上与 0.2.0-rc.2 的 `buildForkSeed` 输出不同。
- 沙箱技能三项（`permissionHost.test.ts`），`[D2-CAPS]` 改为也覆盖「不可调用的不计数」。

跳过的 13 项：9 项真宿主集成测试只在 Linux 上跑（`process.platform === 'linux'`），其余是平台相关用例，升级前后相同。

随已装 DSH 运行的漂移闸门都在 0.2.0-rc.2 上通过：

- `[179-H-01..09]`：摘要钩子与请求形状；
- `hostCompaction`：与 `resolveCompactSpec` 逐字对拍；
- `permissionsClassification`：已装 DSH 的工具全部已分类、没有多余的，白名单插件的工具也已分类；
- `dshModelPlan`：compat 合并；
- `forkSeed`：与 `buildForkSeed` 逐边界对拍。

## 3 `bridge-record`（Windows，逐场景单跑）

- 每个场景用 `--check --only <场景> --artifacts` 单独跑一次（`scripts/run-record.sh`），保留规范化录制。
- 金样本是在 Linux 上录的，Windows 上两个版本都与金样本有差异（`bash` 不存在、路径分隔符、本机 5 个用户 skill），所以 `--check` 在本机不作数。
- 本机比的是**升级前后的录制互相比**（`scripts/compare-recordings.mjs`）：

| 结果 | 场景 |
|---|---|
| 逐字相同（34 个） | 其余全部 |
| `file-attach`：4 处 | 都是 scratch 目录的随机名，出现在转义过的 Windows 路径字符串里，规范化没替换掉，每次运行都不同 |
| `steer`：157 处 | 插话进入收件箱与 `bash` 立即失败的先后顺序不同。本机 `bash` 不存在，命令瞬间失败，没有「命令跑着」的窗口。最终版又单跑 3 次，3 次都在场景自己的断言「模型没看到插话」处放弃，属于竞态 |
| 两版都中途放弃（3 个） | `job-notice`、`jobs-kill`、`steer-withdraw`（`bash` 不存在） |

- 升级前后与金样本的差异行数逐场景相同。
- 结论：升级在 Windows 上没有带来任何录制差异，**金样本没有重录**；Linux 上的 `--check` 待 CI（第 8 节）。
- 中途还有一版没有「技能数只数可调用的」的升级录制：每个场景只差 `capabilities.skills: 5 → 6`，就是被隐藏的那个技能，见第 6 节。

## 4 探针（`scripts/run-probes.sh`）

| 探针 | 0.1.7-rc.2 | 0.2.0-rc.2（最终） |
|---|---|---|
| `request-prefix-probe.ts`（S1～S4） | PASS 21/21 | 20/21：挂 `s1Evidence`（插话时回合已结束），复跑 2 次相同。原因与 `steer` 相同：S1 的链条调用 `bash`，本机瞬间失败，第 3 步的 `sleep 3` 不存在，插话落在回合结束之后。临时把 S1 换成 `pwsh` 链条（实验后已还原）在最终代码上连跑 2 次都是 **PASS 21/21**。其余 20 项（前缀只追加、user_id、前缀监视、缓存链、干净退出）两版都过 |
| `loop-guard-smoke.ts` | 33 项挂 2：`g5NoticesBounded`、`g5NoticesKept`（后台任务用 `bash`） | 相同的 2 项 |
| `bridge-smoke.ts` | 70 项判定，11 项不为真（Windows 环境相关：`bash` 不存在、`/proc`、文件时间与信号等） | **70 项判定与升级前逐项相同**；试点插件开启后加载、写入、读回都为真 |
| `goal-probe.ts` | 23 个工具；目标完成 / 阻塞 / 轮数上限都到达；被关的行 28 个 | 工具清单逐个相同；目标三种结局相同；被关的行相同（新增的 `otel` 行是开着的）；网关请求数 42 → 42 |
| `p0-6-probe.ts latency`（1、2、4 会话） | 退出 0 | 退出 0 |
| `p0-6-probe.ts crash` | 退出 0（`flock`、SIGSTOP 两步在 Windows 上不作数） | 退出 0 |

`request-prefix-probe` 的 `--only S1` 运行里，`s1Evidence` 也是时过时不过：升级前 1/2，升级后两次 A/B 共 1/4，都是这个竞态。

## 5 思考回放修复（上游 `6ed596f7`）

- **场景**：`scripts/run-thinking-ab.sh` 跑 `request-prefix-probe.ts --only S1 --keep`。S1 的 P1-CHAIN 每一步带一个思考块，第 i 步：
  - i%3==0：有文本、带签名；
  - i%3==1：空文本、带签名；
  - i%3==2：`redacted_thinking`。
- **两种回复**：假网关分别用请求的模型名 `fake-1` 和 `fake-1-20260929` 作答（后者模拟网关别名）。
- **计数**：`scripts/thinking-replay-check.mjs` 数之后每个请求里回放的这些块变成了什么。

| 版本 | 名字一致 | 名字不同 |
|---|---|---|
| 0.1.7-rc.2（第 2 回合子集，6 个请求、20 次回放） | 有文本带签名 9 → thinking，空签名 7 → thinking，redacted 4 → redacted | 有文本带签名 9 → **普通文本**，空签名 7 → **丢失**，redacted 4 → **丢失** |
| 0.2.0-rc.2（同一子集） | 9 / 7 / 4 全部原样 | 9 / 7 / 4 全部原样 |
| 0.2.0-rc.2（全量：19 个请求、122 次回放） | 50 / 43 / 29 全部原样 | 50 / 43 / 29 全部原样 |

升级前的抓包在算子集时已删除，所以升级前只有子集计数；子集的数法两版完全相同。

## 6 Windows：沙箱 ACL 技能

| 版本 | S1 抓到的 21 个请求里带 `diagnose-windows-sandbox-acl` 的 | 桥接报告的 `capabilities.skills` |
|---|---|---|
| 0.1.7-rc.2 | 0 | 5（本机用户 skill） |
| 0.2.0-rc.2，未隐藏 | 21（名字一致、不同两次各 21） | 6 |
| 0.2.0-rc.2，最终 | 0（两次各 0） | 5 |

这个技能出现在 DSH 注入的 skill 提示里（每个请求的 `<system-reminder>` 用户消息）。正文见上游 `packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/SKILL.md`。

## 7 整包构建与 Windows 打包冒烟（最终代码 `f8aadf0a`）

- **`node scripts/build-dsh-host.mjs`**：
  - 预检、白名单双钥、bundle 补丁审计、`auditInstalledPlugins`（`dsh-office-tools@1.0.6` 与 0.2.0-rc.2 兼容，敏感 API 扫描 0 命中）全部通过；
  - win32-x64 产物 **86.4 MiB（90,572,699 B）、9,275 个文件**、352 个包、12 个原生件；
  - 上限 100 MiB / 11,000 个文件，目标 92 MiB，都在内。
  - 参考：2026-09-27 记录的 0.1.7-rc.2 win32 产物是 88,692,319 B、9,758 个文件，之后别的提交也改过产物，不能全算到升级头上。
- **`node scripts/packaged-dsh-host-smoke.mjs --level 1`**（与 `dsh-host-windows-smoke.yml` 相同，node 用系统 24.12.0）：**PASS，44 项全真**。覆盖：
  - L0：组合审计、试点默认关；
  - L1：pwsh 文件回合 12 次工具调用、每次改动都出卡、审批往返、试点插件打开后加载且写入问卡读取不问卡；
  - 原生件：sharp 与 libvips 8.18.6、node-pty；
  - 其他：模块与原生件都从产物内加载、无外网、宿主目录未变、退出后无残留进程。

## 8 没跑的

- **Linux**：
  - `dsh-bridge-gate.yml`：`bridge-record --check` 对金样本、回放与投影套件、`loop-guard-smoke`、`request-prefix-probe`、`contention-regression`；
  - `build.yml` 的整包；
  - 真宿主集成测试（`AICLIENT_DSH_INTEGRATION=1`，限 Linux）。
  - 都要推送或手动触发 CI，待用户同意。
- **真实网关**：名字不同时的思考回放没有在真实网关上测。
- **Windows 现场**：Office 打开 1.0.6 生成的文件。
