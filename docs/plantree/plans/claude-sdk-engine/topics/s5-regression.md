# S-5 回归与证据（记录）

Role: topic（S-5，2026-10-16 起）。上位：[README](../README.md) §4 S-5。S-4（打包）在另一个会话里做；S-5 里不依赖打包、也不碰打包文件的部分先做（§1、§3），接 CI 的部分等 S-4 合入后再接。真实网关复跑 T1 前须先问用户。

## 0 范围

| 项 | README 的要求 | 本节做什么 |
|---|---|---|
| 回归集 | 探针场景进回归集 | 一条命令跑完全部探针场景（§3 R-1），本机与 CI 都能用 |
| 录制门禁 | 录制 SDK 事件序列做门禁 | 照 DSH 的 `bridge-record.ts` 录几个确定的场景，`--check` 比对（R-3） |
| 真实网关 | 复跑 T1 | **待用户**：用真实网关前先问 |
| GUI 清单 | GUI 点验清单 | 把 S-1～S-3 与开始页跳过权限确认做过的点验写成清单（R-4），打包后照它再走一遍 |
| 加固 | §9.2、§10.2 里标给 S-5 的 | #34、#35、#39 见 §1；#42 见 H-4 |

## 1 先做的加固（2026-10-16）

自主决定，待审阅：

| # | 发现（README） | 决定 | 理由与实测 |
|---|---|---|---|
| H-1 | §10.2 #39：`stop` 场景在机器负载高时误报"停之前 sleep 没在跑" | 探针等到两个 sleep 进程都出现再停，上限由 `PROBE_STOP_WAIT_S` 定（缺省 60 秒），超时仍算失败；并打印等了多久 | 实测：先只把固定 3 秒改为最多等 20 秒，全量 vitest 同时跑时仍两次失败；放宽到 150 秒测得命令约 30 秒才起来（不出卡、不进后台，就是起得慢），停后 3 秒内清零。缺省 60 秒在负载下通过（那次约 4.6 秒起来）。不是宿主的问题，是满载时 Git Bash 起进程慢 |
| H-2 | §9.2 #35：假网关的安全检查按整段对话里任何一处 `CC-CLS-*` 标记决定，`mode-auto` 只能放在最后跑 | 只看最新一条 `CC-RUN` 提示之后的标记（检查请求带着之前所有提示；本回合自己的调用里不会出现 `CC-RUN` 字样） | 对比：先跑 `mode-auto` 再跑 `repoenv`，旧网关下 `repoenv` 的自动模式检查继承了前面的"检查不可用"而失败（1/13），新网关 13/13；把 `mode-auto` 放在各档场景最前面跑，33/33 |
| H-3 | §9.2 #34：切档超时（8 秒）这条路径没有单测 | 补单测，不改代码：8 秒没回应时请求以 `WORKER_PERMISSION_MODE_REFUSED: timeout` 失败，PiLab 仍持原档；CLI 之后才真的切过去时，它报来的档位会把 PiLab 拉回一致（`engine` 原因的 `session.permissions`） | 变异检查 3 处都会让这条用例失败：超时改成 10 秒、`finally` 里不减在途计数、超时错误不带 `timeout` |

## 2 验证

- 宿主 tsc 无错；`sdkSessionRuntime` 单测全过；全量 vitest 与基线一致（两次）。
- 探针（新代码的假网关，单独端口）：flow 35（含 `stop`）、各档 33（`mode-auto` 在最前）、`mode-auto repoenv` 13；负载下 `stop` 两次（150 秒上限与缺省 60 秒）都过。

## 3 主体的决定（自主决定，待审阅）

| # | 决定 | 理由 |
|---|---|---|
| R-1 | **回归命令 `src/claude-sdk-host/tools/probe-suite.ts`**：自己起一个本机假网关（空闲端口），每组场景一个新建的临时工作区与配置目录，依次跑：流程（text tools ask stop plan steer agent search compact history）、各档（keyiso mode-manual mode-edits mode-plan mode-bypass mode-switch mode-enterplan mode-auto）、mode-plan-refused、errors+repoenv、projcfg、projcfg-scratch、projcfg-home（替身主目录由它建）；汇总成 JSON（每组通过与失败的检查、耗时），有一条不过就以 1 退出。`--only` 选组，`--host-entry` 换成打包后的 `host.js`（与 S-4 的冒烟同一入口），`--keep` 保留临时目录 | 现在这些组靠手敲长命令、各用各的目录，换人就难复现；一条命令才算"进回归集"。只用假网关，不碰真实网关 |
| R-2 | **接 CI 等 S-4 合入后再做**：S-4 正在改 `build.yml`；回归要 CLI 二进制（平台包），CI 那一步装宿主依赖时不能省可选依赖 | 避免两个分支同改一个工作流文件 |
| R-3 | **录制门禁先做一个最小版**：只录确定性的场景（text、tools、ask、plan），把 `runtime.event` 序列规范化（合并同一条消息的增量、去掉 id/时间/用量数字/临时路径），存到 `src/shared/__tests__/fixtures/claude-sdk/`，`--check` 比对、`--update` 重写 | 照 DSH 的 `bridge-record.ts`；SDK 升级或宿主改动改变了界面收到的事件时第一时间看到。先做小，确定性站得住再加场景 |
| R-4 | **GUI 点验清单** `topics/gui-checklist.md`：把做过的点验（引擎选择、五档与中文名、回合中切档、审阅卡、DSH 菜单不变、项目 CLAUDE.md 与规则、开始页跳过权限确认）写成步骤，注明用 `gui-probe.mjs` 怎么走 | 打包后（S-6 前）照清单在安装目录上再走一遍 |
| H-4 | **#42：CLI 还没就绪时的切档**：宿主用 SDK 的 `initializationResult()` 判断 CLI 是否已初始化；没就绪时先把要切的档记下、立即应答，等 CLI 就绪后再发切档，被拒时照 S-2 A-6 按 CLI 报的档同步并说明原因 | Main 给一次切档的总时长是 10 秒，宿主无法为慢启动多等；就绪前 CLI 不会调工具，先记下不会让某个调用按错的档判断 |

## 4 主体的实现记录（第一批，2026-10-16）

- **R-1 回归命令**：`node src/claude-sdk-host/tools/probe-suite.ts`（在 `src/claude-sdk-host` 下跑）。一组一个临时目录，通过的组随即删掉，失败的组留下日志并打印路径；`--out` 写 JSON 汇总。判定只看探针自己的输出：退出码 0、有检查、全部通过、有"all passed"那一行才算过，崩溃、超时、零检查都算失败（单测 `probeSuite.test.ts`）。
- **第一次整跑就抓到一处脆弱**：`stop` 场景按命令行在全机数 `sleep 97`，另一个会话同时跑同一场景时会数进别人的进程（停后 2 秒清零、6～7 秒又冒出两个）。改为每次运行用自己的时长（`97 + 进程号 % 400` 秒），单独重跑 flow 35/35。
- **H-4（#42）**：宿主在启动 CLI 时订阅 `initializationResult()`；就绪前的切档立即应答、先记下（多次只发最后一次），就绪后发出；被拒时按 CLI 的档同步并带原因（`engine`、`refusedReason`）。就绪前 CLI 报来的起始档不当作它自己改了档。单测 2 条，变异检查 3 处都能抓到：去掉"就绪前先记下"、记下时不计入在途、被拒时不带原因。
- **R-4**：[GUI 点验清单](gui-checklist.md)，9 项，附 2026-10-16 开发版的结果；打包后照清单再走一遍。
- 整跑：H-4 落地后 `probe-suite.ts` 一次跑完 7 组全过（流程 35、各档 34、mode-plan-refused 3、errors+repoenv 33、projcfg 12、scratch 9、home 4，共 130 条，约 1.5 分钟）。
- R-2（接 CI）未做，等 S-4 合入。

## 5 录制门禁（R-3，2026-10-16）

- `node src/claude-sdk-host/tools/event-record.ts [--check | --update] [--only ...] [--out-dir ...]`：自起本机假网关，用探针录 `text`、`tools`、`ask`、`plan` 四个场景（探针的 `PROBE_RECORD_DIR` 把每个场景的原始事件写到本机临时目录，不入库），规范化后与 `src/shared/__tests__/fixtures/claude-sdk/stream.<场景>.json` 比对；`--update` 重写样本。
- 规范化（`event-normalize.ts`，纯函数，单测 5 条）：各类 id 按首次出现编号；工作区、配置目录、临时目录的 Windows、正斜杠与 Git Bash（`/tmp/...`）写法换成 `<ws>`、`<config>`、`<tmp>`，其后的路径一律正斜杠；`uname` 的系统名换成 `<os>`；同一块的增量合并；连续相同的状态与同一调用的多次更新只留最后一条；`usage.updated` 不进序列，只记它的字段名。
- 确定性：连录两遍，四个场景逐字节相同（113、296、189、193 行）。
- 能抓到改动：临时去掉宿主 `message.started` 的 `model` 字段，`--check` 报 `DIFF text`、指到第 58 行；还原后通过。
- 样本是在 Windows 上录的。Linux 上 Bash 的输出与路径应已被规范化覆盖，接 CI（R-2）时在 Linux 上跑一遍确认，不同就按平台分样本。

## 6 合入 S-4 后对安装目录复核（2026-10-16）

- 合并 S-4 分支（`8be0f815`）后在本分支重新打包：`dist:prereq` 的各步（`assert-no-webfonts` 除外，见 README §11.2 #49）→ `electron-builder --win --x64 --dir -c.win.signAndEditExecutable=false` → `verify-packaged-app.mjs` 通过（两个宿主的结构、体积、第三方声明，DSH 冒烟、SDK 冒烟 8 条）。SDK 宿主产物 262.2 MiB、19 个文件（CLI 258.3 MiB）。
- **回归命令对安装目录**：用随包的 node、随包的 `host.js` 与随包的 `claude.exe` 跑 `probe-suite.ts`，7 组 130 条全过。合并前 S-4 会话打的旧包（早于裁决 17～20）同样跑出 124/130，差的 6 条正是计划模式与插件市场那几条，说明回归命令能分辨新旧宿主。
- **录制门禁对安装目录与源码**：两边都与样本一致。
- **门禁自身的一处修正**：提交时 lint-staged 用 biome 重排了样本 JSON（短数组并成一行），按文本比对就报了只有排版不同的差异；改为解析后再比（`canonicalSample`），单测 1 条，去掉这一步时该用例失败。

## 7 接 CI（R-2，2026-10-16）

- `build.yml` 的 Windows 与 Linux 打包作业，在"Verify packaged app"之后用随包的 node、`host.js` 与 CLI 跑 `probe-suite.ts`（`--logs` 把失败组的日志放进 `dist/claude-sdk-probe-logs/`）与 `event-record.ts --check`（录下的放进 `dist/claude-sdk-recorded/`），三者随"Upload Claude SDK host evidence"上传。Windows 上两步都会挡住构建；Linux 上回归命令挡、录制门禁只报告（`continue-on-error`），因样本是在 Windows 上录的，等第一次 Linux 结果再定。macOS 作业不跑（Linux 与 Windows 之外暂不做，dsh-rebase 决策 090）。
- 超时：Windows 40 → 50 分钟、Linux 35 → 45 分钟，照工作流的规矩在第一次全绿后重算。
- `stop` 场景在 Linux 上也只数自己那个时长的 `sleep`（`pgrep -fc '^sleep N$'`），与 Windows 一致。
- 门禁测试 `packaging-config.test.mjs` 加 1 条：两个作业里这两步都在核验之后、用随包的 node 与宿主，回归命令不允许 `continue-on-error`，录制门禁 Windows 挡、Linux 只报告，证据路径都上传；去掉 Windows 的回归步骤、或把 Linux 的录制门禁改成挡，这条都失败。
- 本机照 Windows 作业那一步原样跑（PowerShell，对本分支重打的 `win-unpacked`）：130/130、四个样本一致、退出码 0。证据见 [evidence/s5-regression-2026-10-16.md](../evidence/s5-regression-2026-10-16.md)。
