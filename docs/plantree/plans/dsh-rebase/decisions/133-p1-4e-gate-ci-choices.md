# 决策 133：P1-4e 录制门禁收口——回放测试、CI 接入与点验清单的取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：

- [决策 100](100-p1-4e-gate-kept-scenarios-follow-rescope.md)（已批准）第 3、5、6 条；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §4.3 的 4e-2、4e-4、4e-5；[P1-4 分片 05](../topics/p1-4-bridge-parity/05-gate-and-changes.md) §2；
- [决策 130](130-user-rulings-2026-09-29-batch3.md) 补充裁决：P1-4e 可以改 CI。**推送仍要用户确认**，本项没有推送。

## 落地了什么

- `src/renderer/stores/__tests__/dshStreamReplay.test.ts`（新，224 例）：28 个录制场景逐个灌进真实的渲染层 reducer，断言用户最终看到的内容。
- `src/dsh-host/tools/bridge-record.ts`：新增 `--artifacts <dir>`，给 CI 失败时上传用；`perm-restart` 在 kill 前先落盘（第 23 条，测试专用 probe 包 `measure.js` 加了 `flush` 操作）。**归一化规则没改，金样本没重录**，`perm-restart` 一份待编排者重录。
- `.github/workflows/build.yml` 的 gate：取随包 node，加一步录制检查，失败时上传产物；超时 14 → 20 分钟。
- `.github/workflows/dsh-bridge-gate.yml`（新）：推送到 `feat/dsh-*`、`ci/dsh-bridge-gate` 或手动触发时跑。
- `scripts/__tests__/packaging-config.test.mjs`：加 7 例结构守卫，钉住上面两份工作流的接线。
- [P1-7d GUI 点验清单](../topics/p1-7d-gui-pointcheck.md)（新）。

## 规则

### 回放测试（4e-2）

1. **断言视图数据，不挂载整条时间线。** 测试走的是组件实际用的纯函数：
   - 回合：`groupMessagesIntoTurns` / `flattenTurnItems`；
   - 工具行：`pairToolBlocks` + `deriveToolRowView`，看动词、运行中 / 完成、结局；
   - 各类卡片：失败卡 `deriveSessionFailure`、提问卡 `deriveQuestionCardState`、授权说明 `derivePermissionGrantScopeNote` / `derivePermissionAutoNote`；
   - 通知行与自动回合头：`dshNoticeRowView`、`autoTurnHeadView`；
   - 后台任务窗 `deriveJobsWindowView`、子代理泳道 `reduceSubagentActivity`、用量 `reduceSessionRuntimeFacts`、「待送达」气泡 `usePendingUserMessagesStore`。

   理由：挂载整条时间线要桩 `electronAPI`、日志与主题，又慢又容易挂死（见挂载测试的已知坑）；这些纯函数就是组件画的内容。像素、焦点、布局交给 P1-7d 点验。
2. **结构照 `nativeStreamReplay.test.ts`**：重打 `seq` / `timestamp`，一次折叠等于 store 的批量 flush。原文件没动，它随 P1-12 处理。
3. **每个录制场景都必须有断言。**
   - 测试直接枚举 `fixtures/dsh/stream.*.json`；每个场景一个 `scenario()` 块，自动登记；
   - 最后一例比对「有录制的」和「有断言块的」两个集合：新增场景没写断言、或断言块没有录制，都会失败；
   - 已人为去掉一个块验证过，确实会失败。
4. **所有场景都跑五条通用不变式**：
   - 每条 delta / 思考 / 工具事件都落到已打开的消息上（这类丢失是静默的）；
   - 每条提示在时间线上恰好一次；
   - 用户打的提示都带发送时的 `attemptId`，引擎自开的回合不带；
   - 结束时没有待答的卡、没有转圈的行，输入框可以再发；
   - 用量芯片拿到最后一次已结算的用量，不是 pending 那一跳。
5. **逐场景断言**覆盖任务单列出的全部面：
   - 流式正文；
   - 工具行从运行中到完成；
   - 审批卡（排队、可答、结算后并入行；允许、拒绝、本会话允许、Stop 撤卡）；
   - 思考块；
   - 失败卡与「继续」（续跑没有回显，但有 running）；
   - 插话（并入当前回合，回合不中断，待送达气泡收回）；
   - 图片与文本附件 chip（直播与重开）；
   - 用量；
   - 崩溃恢复后的中断注记与「结果未知」行；
   - 回退与 fork；
   - 提问卡（停靠、回答、跳过）；
   - `/compact` 与命令回答；
   - 后台任务通知、后台任务窗的停止与移除、子代理续聊泳道。
6. **Main 的包装按 `WorkerManager` 的形状重建**，录制本身不带这一层：
   - 重开：`session.resumed` + `session.history` + `idle`；
   - 宿主崩溃：`disconnected` + `session.failed{dsh_host_crashed}`；
   - 回退后的 `branch` 回放。

   代价：Main 改了这层形状，本测试看不出来，那部分靠 `WorkerManager` 自己的测试。
7. **重开与直播要一致。** 每个场景都用 `rpc.history` 重开一次，时间线要与直播相同。例外逐条写明理由，并断言它们确实不同，这样理由过期时测试会提醒删掉。八个例外：
   - `compact`、`crash-resume`、`fork`、`rewind`：预期如此；
   - `fail`：重开显示「Response interrupted before any assistant content was saved.」，直播是失败卡；
   - `question`、`perm-subagent`：提问卡和子代理的审批卡只在直播里有；
   - `perm-restart`：见下面的发现。
8. **录制带不出来的，不断言**：
   - token 数被录成 0，用量环的算术不断言，只断言形状，并确认数字为 0 时环显示空白而不是 0%；
   - `<ms>` 按出现顺序换成固定数字。

### 录制脚本（4e-4 附带）

9. **新增 `--artifacts <dir>`**，任何模式都写：
   - `recorded/`：归一化后的录制，与金样本同名同格式，`diff -r` 可以直接比；
   - `summary.json`；
   - 失败时另写 `differences.txt` 与宿主 stderr 尾部。

   不写 `--raw` 的未归一化数据；模型 key 只有假网关的假值。没有另开一个比对模式，理由是 `--out-dir` 的语义（只写不比）有人在用。

### CI（4e-4）

10. **`build.yml` 的 gate**：
    - 在 `Install dsh-host dependencies` 之后，加「缓存随包 node」「取随包 node（`--platform linux-x64`）」两步，写法与缓存键和 build-linux 一致；
    - 录制检查放在 `Gate 6/8 — test` 之后，单独一步，步骤级超时 8 分钟：宿主卡住时这一步自己失败，不拖垮整个 job。排在单测之后，是为了先让读金样本的单测给出信号；
    - 步骤名不编号，避免把后面 7/8、8/8 全部改号；
    - 任何一步失败都上传 `$RUNNER_TEMP/bridge-record`（`if-no-files-found: ignore`，保留 14 天）。
11. **gate 超时 14 → 20**：
    - 新增约 1.5 分钟：录制在 2 核开发机上 51 秒；随包 node 首次下载约 30 MB，这一项是估算，之后走缓存；
    - 按文件头的规则乘 3 约 +4.5 分钟，向上取整到 10 的倍数；
    - 首次跑绿后按实测重算。
12. **`dsh-bridge-gate.yml`**：
    - 触发：`push` 到 `feat/dsh-*`、`ci/dsh-bridge-gate`，外加 `workflow_dispatch`；`permissions: contents: read`；同一分支新推送取消旧的一次；ubuntu；
    - 步骤依次：
      1. 根 `pnpm install --frozen-lockfile --ignore-scripts`；
      2. `src/dsh-host` 的 `npm ci --ignore-scripts`；
      3. 缓存并取随包 node；
      4. `pnpm typecheck:dsh-host`；
      5. 录制检查（带 `--artifacts`）；
      6. 回放与投影两套读金样本的单测；
      7. 失败时上传录制产物。
13. **为什么装根依赖、而且带 `--ignore-scripts`**：
    - 宿主经 `src/shared/sessionFileChange.ts` 解析根目录的 `zod`，只装 `src/dsh-host` 会在加载时报找不到模块。这是静态分析宿主与录制脚本的导入图得到的，唯一跨出 `src/dsh-host` 的裸依赖就是它；tsc 与 vitest 也来自根目录；
    - 不跑安装脚本，省掉 Electron 下载与 `electron-builder install-app-deps` 的原生件重编译，这里用不到；
    - 风险：esbuild 的 postinstall 不跑，靠 pnpm 装的平台包 `@esbuild/linux-x64` 解析二进制，本机无法复现这个环境。首次 CI 若 vitest 起不来，去掉这个参数即可。
14. **顺带跑 `tsc -p src/dsh-host`，而且是阻断的**：约半分钟，能最早发现 bridge 类型漂移。
15. **顺带跑回放与投影两套单测，也是阻断的**：它们读的是同一批金样本，分支上改金样本却忘了改渲染层时，在这里就能看到，不用等发版 gate 的全量单测。条件是随包 node 那一步成功；录制失败时照样跑，好多给一份信号。
16. **`bridge-smoke.ts` 不在推送时跑，只在手动触发、勾选 `smoke` 输入时跑，而且不阻断**。理由：
    - 它不管判定结果都以 0 退出，要另读报告，工作流里多了一步解析；
    - 它从没在 CI 的 Linux 上跑过，里面的锁、FD、环境变量等实验对环境敏感；
    - 它比录制更宽、更慢（宿主 A～J），推送时跑会让门禁变慢、变吵。

    手动跑时：步骤级超时 15 分钟、`continue-on-error`；下一步把失败项逐条打成 warning，并上传报告。连续几次 CI 跑绿之后，再让它失败即退出非 0、改成阻断，这一步另起决策。
17. **超时**：job 30 分钟。推送路径估计冷启动约 5 分钟，乘 3 后取整到 20，再给手动 smoke 留余量，因此取 30；录制步骤 8 分钟、smoke 步骤 15 分钟。估计值，首次跑绿后重算。
18. **结构守卫**：`packaging-config.test.mjs` 新增 7 例，钉住：
    - 两份工作流里录制都是单独一步、带步骤级超时、跑在随包 node 上，而且排在 dsh-host 安装与取 node 之后；
    - 两份都没有 `--update` 或 `AICLIENT_UPDATE_FIXTURES`；
    - 两份都在失败时上传产物；
    - 分支工作流的触发条件、只读权限，且不引用任何 `secrets.`。

    原有的「随包 node 缓存键按 pin 文件」「按平台取 node」两例把 gate 也纳入了。

### 与本机不同的 CI 环境（4e-4）

19. **逐项查过 `--check` 依赖的环境**：
    - HOME、TMPDIR：宿主与假网关用沙箱内的；
    - 用户名：来自 `os.userInfo()`，只进宿主环境变量，不进样本；
    - locale：`LANG` 缺省为 `C.UTF-8`；时区：样本里的时间全是 `<ms>`；
    - `/proc/meminfo`：只用来判断内存下限；
    - scratch 根：固定在 `/var/tmp`，长度固定；
    - 端口：随机，不进样本；
    - 仓库路径：不进样本，已 grep 确认金样本里没有 `/home/`、`/tmp/`、`127.0.0.1`；
    - 沙箱：DSH 的 bwrap 与 landlock 只在收紧文件策略时起作用，全部场景都是 `danger-full-access`。
20. **本机模拟干净环境的结果**：
    - 用 `env -i` 只带 `PATH=/usr/local/bin:/usr/bin:/bin`、`/tmp` 下新建的 HOME 与 TMPDIR、`LANG=C.UTF-8`、`TZ=UTC`（PATH 里也没有 node），跑 `--check --artifacts`，28 个场景 0 差异，`recorded/` 与金样本逐字节相同；
    - 正常环境（`en_US.UTF-8`、EDT）同样 0 差异；
    - 归一化不需要改。

### GUI 点验清单（4e-5）

21. **清单放在 `topics/p1-7d-gui-pointcheck.md`**：
    - A 节是决策 100 第 6 条，外加分片 05 §3 的「侧栏只读预览不起 slot」；
    - B～I 节是只有挂载测试、没人在界面上看过的 P1-7a / b / c、P1-11、P1-9e 与决策 131、P1-10c、P1-16e、P1-6d；
    - Windows（W1～W12 与 pwsh 原因句、别名说明）、真实网关、SSH 与回装 1.0.x 单列一节；
    - 每项写明入口、操作、预期与决策号，文案按 `src/shared/i18n.ts` 的中文核对过。
22. **注明一个会踩的坑**：现成的点验脚本（`p0-3-gui.mjs`、`p1-1-gui.mjs`）指向归档的假网关，只有 P0 标记；本清单用到的 P1 标记只在 `src/dsh-host/tools/fake-gateway.mjs` 里，开工前要改指过去。

### 录制场景的时序依赖（编排者追加）

23. **`perm-restart` 在 SIGKILL 宿主之前，先经 DSH 自己的入口把日志落盘。**
    - 做法：
      - 测试专用的 probe 包（`tools/probe-bundle/lib/measure.js`，从不随产品发布）加一个操作 `flush { sessionId }`，调用 DSH 公开的 `sessions.flush(session)`，拿到 `sessions.get(id)` 的活会话；
      - 录制脚本在 kill 之前调用它；返回 `participated !== true` 时直接报错，免得悄悄退回有竞态的老样子。
    - 为什么选这条而不是「等文件大小稳定」：
      - `sessions.flush` 是 DSH 类型文档里点名的唯一落盘入口（「THE flush entry point」），DSH 自己也说回合边界不落盘、读存储的一方要自己 flush；bridge 在回退、fork、种子会话里用的也是它；
      - 等文件大小不变，只是在猜 200 ms 窗口，负载高时照样可能猜错；
      - 没有改 DSH 的包文件。
    - 语义不变：这个场景测的是「本会话允许」的授权跨一次硬崩溃仍然有效，kill 仍是 SIGKILL；只是不再顺带测 DSH 的批量落盘窗口。那种「中途被杀」由 `crash-resume` 专门测。
    - 金样本会变，**由编排者重录**：
      - stream 只有 id 编号平移（`dsh-user-N`、`toolu_id-N`），事件与内容不变；
      - log 从 59 条变 60 条：第一回合多了第 3 步的 `assistant/message`（「P1-PERM-SESSION finished.」），`turn/end` 的原因从 `interrupted` 变成 `completed`，其后各条 seq 加 1、内容不变；
      - rpc：第一回合的中断注记消失，换成那句回答，第 2 条助手消息不再标 `incomplete` / `interrupted`；leaf、树节点与 id 随之变化；授权 sidecar 与 `configure` 的结果不变。
    - 本机连续两次 `--only perm-restart --out-dir` 录到两个目录，`diff -r` 完全一致。
    - 重录后要删掉回放测试例外表里的 `perm-restart`：那时重开与直播一致，测试会提醒。
24. **其他会 SIGKILL 宿主的场景只有 `crash-resume`，它的中途被杀是刻意的，不改，时序是稳的**：
    - 原始录制显示，第一个宿主最后一次落盘在 `tool/call`（约 123 ms），批量窗口约 320 ms 时已排空；
    - kill 在工具开始后 2 s（不早于约 2118 ms），而这条命令要睡 10 s；
    - 两者之间只有不落盘的直播事件（`execStartedAt`、`tool.output`）；
    - 余量约 1.8 s，只有宿主卡顿超过这个时间才会变。
    - 其余场景都走 `stopHost`（先发 `shutdown`，关闭时 DSH 会排空落盘；20 s 后才退回 SIGKILL），而且都是先读完历史再停宿主，不受批量窗口影响。

## 发现

- **`perm-restart` 的第一回合，重开后丢了最后一句回答。**录制脚本里已按第 23 条修掉，等编排者重录金样本。
  - 现象：直播里用户看到了「P1-PERM-SESSION finished.」和回合完成；重开后这一回合只剩两条工具行和一条中断注记。
  - 原因：DSH 的 JSONL 持久化按 200 ms 窗口批量落盘（`dsh-session-persistence-jsonl` 的 `enqueueLive`），录制在回合 idle 后立刻 SIGKILL 宿主，窗口里的 `assistant/message` 没来得及写；新宿主恢复时补了 `turn/end{interrupted}`。
  - 测量：原始录制里最后一个落盘事件在 273 ms，回答 286～289 ms，idle 291 ms，离定时器触发还有约 180 ms。
  - 产品含义：引擎在回合结束后 200 ms 内崩溃，这一回合在历史里会显示成中断，这是 DSH 的设计。
  - **对门禁的影响**：金样本依赖「kill 落在窗口里」。更快的机器更稳；CI 机器若负载很高、kill 晚了约 180 ms 以上，就会录到回答，`--check` 报差异。
  - 处理：见第 23 条。
- `fail` 重开后显示「Response interrupted before any assistant content was saved.」，直播是失败卡。来源是渲染层已有的历史映射（`mapHistoryMessageToChatMessage` 给没有内容的 incomplete 消息补的兜底句），不是本项引入的。已写进点验清单 A5，供 P1-7d 判断要不要改文案。

## 取舍

- **不在 CI 里重录，也不做「自动接受差异」**：差异要人读（决策 100），CI 只上传产物。
- **没有给回放测试加 DOM 挂载**：成本与挂死风险见第 1 条；像素层面由 P1-7d 点验兜底。
- **没有把录制放进根 vitest**：DSH 包只装在 `src/dsh-host`，且要随包 node（分片 05 §1 的约束不变）。

## 影响

- 推送后 `feat/dsh-*` 每次推送多跑一个约 5 分钟（估计）的 job；发版 gate 多约 1.5 分钟。
- 金样本、`nativeStreamReplay.test.ts`、roadmap、看板都没动；看板与 roadmap 的回写由编排者做。

## 待用户确认

- 第 13 条根依赖 `--ignore-scripts`、第 16 条 smoke 只手动且不阻断、第 17 条超时取值。
- 第 23 条：`perm-restart` 改为 kill 前先落盘（编排者 2026-09-29 要求修掉），需要重录这一份金样本。

## 编排者落实（2026-09-29）

- 按第 23 条重录金样本：用全量 `--update`（不是 `--only`），28 个场景里只有 `perm-restart` 的 stream / log / rpc 三份变化，差异与代理报告一致；重录后 `--check` 0 差异。
- 已删掉回放测试 `REOPEN_DIFFERS` 里 `perm-restart` 的例外，复跑回放与投影测试通过。
