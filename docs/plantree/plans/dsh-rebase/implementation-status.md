# DSH 二开迁移：进度看板

Role: implementation-status。更新日期：2026-09-29。只放当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；任务身份与状态以 [roadmap](roadmap.md) 为准。

## 工作方式（2026-09-26 用户授权）

- 只在分支 `feat/dsh-p0-probe`（worktree `.claude/worktrees/agent-a84b7bf3214a2affd`）上活动，不动 main 与 v1.0.3；不推送，推送与发版前先确认。
- 按 roadmap 顺序推进 P1。一般问题调研后自行决定，每条决定单独写一份决策文件，标「自主决定，待用户审批」；难以解决的问题停下来与用户商讨。

## Current Phase

P1 分支内 DSH 替换。全部任务已出方案（[roadmap](roadmap.md)，决策 005～089 已于 2026-09-28 由用户裁决，见[决策 090](decisions/090-user-rulings-2026-09-28.md)）。
- **已落地**：P1-0、P1-1、P1-2 本机部分、P1-3a～d、P1-4a、P1-4b、P1-4c1、P1-4c2、P1-4d2、P1-4d3、P1-5a / 5b 与宿主侧接线、P1-4d1、P1-6a～d、P1-7a、P1-7b、P1-7c、P1-8、P1-9a～g、P1-10a（含收尾）、P1-10b、P1-10c、P1-10d、P1-11、P1-15、P1-16a、P1-16e，以及 P1-12 / P1-16 的前置搬迁。
- **现在分支上能做到**：用界面选的模型聊天，key 每次请求时从 Main 拉取；每次工具调用都经我方审批，「本会话允许」在宿主重启后仍有效，换档立即作用到闸门。
- **P1-13 加密机**：第一轮已回（[决策 084](decisions/084-p1-13-round1-reading.md)），`.txt` 全链路明文，不触发否决，但不能签收。P1-13b 上机包已就绪。
- **推送**：仓库是公开的。2026-09-28 按用户要求改写了分支历史，删掉加密机的原始现场报告，只留脱敏摘要，然后推送。

## Next Target（2026-09-29 晚更新：第三批已裁决，五项授权动作全部批准）

- **已裁决**：第三批决策 111～129 由用户裁决（[决策 130](decisions/130-user-rulings-2026-09-29-batch3.md)）：没点名的按建议批准；120 第 27 条与 123 分叉标题已由[决策 131](decisions/131-plugin-row-titles-and-fork-title-choices.md) 做完（`740a45b1`，第 7、15、17 条待审批）。
- **已授权，按顺序做**（决策 130 补充裁决，一次只做一件重活）：
  1. 推送分支，并推一份到 `ci/dsh-p1-6d-windows` 跑 S18 两路；手动触发 `build.yml` 在 CI 上整包构建并跑打包冒烟 L1（本机不跑整包构建）；
  2. CI 在跑时派代理做 P1-4e（录制门禁进 CI）；
  3. P1-7d GUI 点验与真实网关 R1～R10 一起做，期间不跑代理；R1～R10 要用户在开发版里登录公司账号，编排者不经手凭据；
  4. P1-12 删除自有 runtime，前提是 Windows CI 与 P1-7d 都通过。
- **2026-09-29 第一次 Windows CI 结果**（推送 `a8cce6f2`）：
  - S18 两路（admin / 标准用户）全部通过；`build.yml` 的 gate（四套 tsc、lint、全量单测、runtime 冒烟）、Linux 整包构建与 L1 通过；macOS 是已知的 hdiutil 问题（与本分支无关，决策 090 不做 macOS）。
  - **Windows 打包冒烟 L1 失败 3 项**（本分支第一次在 Windows 上跑打包宿主）：
    - `l1PilotWriteAskedReadRan`：工作区内的 read / grep / glob / pwsh 全都弹了审批。推断：闸门的 `cwd` 没有规范化，runner 的临时目录是 8.3 短名（`RUNNER~1`），目标路径经 `fs/promises` 的 `realpath` 展开成长名，于是判成「工作区外」；
    - `l1RipgrepFromArtifact`：宿主的 spawn 钩子在 Windows 上只记到一个 node.exe，pwsh 与 rg 都没记到，推断 DSH 在 Windows 上经 node 子进程派生工具；
    - `nativesPtyRan`：node-pty 的探针 `exitCode -1`、无输出，原因待查。
  - 下一步：P1-4e 代理交回后，派代理修这三项，另建只打包宿主的 Windows 冒烟工作流加快迭代。
- **在等**：Windows 端的 P1-13c（决策 091）。用户已让它从 `eda6c248` 开分支开工，合并冲突由编排者解决。
- 2026-09-29 收口复跑：四套 tsc 通过；全量单测按目录分批（渲染层 295 个文件、4824 例；Main、preload、共享库 193 个文件、3146 例；dsh-host 与 agent-host 与 scripts；runtime 70 个文件、1235 例；`src/__tests__`）全部通过，期间修掉一处漏网的构建库测试期望（`dsh-host-build-lib.test.mjs` 的 `ROW_INJECT` 缺 `llm`）；真宿主集成 35/35；bridge-smoke 65 项；`--check` 28 个场景无差异；宿主产物 82.6 MiB，L1 共 44 项。

以下为 2026-09-28 晚的原始 Next Target，保留作历史：

### 2026-09-28 晚在 Linux 开发机续做

交接文档：[handoff-2026-09-28.md](handoff-2026-09-28.md)。

用户在 2026-09-28 裁决了决策 005～089 与 Q003、Q007～Q010（[决策 090](decisions/090-user-rulings-2026-09-28.md)）。**总原则：默认跟随 DSH 的做法，不再为了与 1.0.x 一致而移植。** 只做 Linux 与 Windows，macOS 暂不做。

2026-09-28 晚用户决定：P1-13c 交 Windows 机上的会话做，其余在本机按泳道推进。续做前四套 tsc 复核通过；最后一次全套验证（P1-6b）晚于最后一次代码改动，不重跑。

**决策编号预留**：091 给 P1-13c（Windows 端），092 给 P1-6c 与 P1-6b 剩余的实现取舍，093 起给 P1-4 / P1-16 重划范围。

1. **P1-13c（Windows 端执行）**：Windows 上读到密文时，改用 Windows PowerShell 5.1 回读（可以覆盖 yml、php、ps1、cmd、sql、scss）；rb、docx、pptx 读不出时返回明确的错误。写入维持 DSH 的做法。派工说明见 [p1-13c-windows-read-fallback.md](topics/p1-13c-windows-read-fallback.md)；Windows 端在分支 `feat/dsh-p1-13c` 上交付，编排者验证后合入本分支。补充观察（决策 092 第 20 条）：权限策略文件由 bridge 用普通 node fs 读，不经 DSH fs 服务，加密机上若返回密文会报 `permission_policy_invalid`。
2. **第一波已完成**：P1-6c 与 P1-6b 收尾落地；P1-4 / P1-16 重划范围（决策 093～105）；P1-7 / P1-11 新原型。
3. **等用户**：
   - 决策 093 + 094（插话改 steer、Stop 保留收件箱）、097（文本附件改文件块）、102（不读用户层指令）、103（不支持提示词模板）需要拍板；其余 092、095、096、098～101、104、105 按「没点名即同意」；
   - P1-7 / P1-11 新原型（子窗口形态、终端位置等 12 个问题，见原型 README）。
4. **第二波已完成**：P1-4d1、P1-16a、P1-10b（见 Last Landed）。
5. **第二批决策已裁决**（[决策 109](decisions/109-user-rulings-p1-7-prototype-2026-09-28.md)、[110](decisions/110-user-rulings-2026-09-28-batch2.md)）。**下一步**（本机一次只派一个代理，见下方「本机限制」）：
   1. ~~P1-10b 跟进：打包态不读 home 层补丁；插件启用改为逐个覆盖（决策 110）~~ 已落地 `9454b838`；
   2. 泳道 ①：~~P1-4c1（steer、Stop 保留收件箱、失败后继续）~~ 已落地 `f9a89e51` → ~~P1-4c2~~ 已落地 `20285c58` → ~~P1-4d2~~ 已落地 `f8c7b2b5` → ~~P1-4d3（联网装 `dsh-tool-ask-user`）~~ 已落地 `4e003c1b` → P1-4e（进 CI 的 `build.yml`、`dsh-bridge-gate.yml` 改动先问用户，决策 100）；
   3. ~~P1-10d 试点插件（联网装 `dsh-office-tools`）~~ 已落地 `a5a925f9`；~~P1-16e 旧资产提示~~ 已落地 `6d2fc8a0`；~~P1-10c 插件页~~ 已落地 `0bd912f3`；
   4. ~~P1-7a~~ 已落地 `8492837c` → ~~P1-7b~~ 已落地 `ada0a024` → ~~P1-7c~~ 已落地 `a0aa76a7` → P1-7d（GUI 点验与真宿主实验；本机起 Electron 点验、推送与测试版都要先问用户）与 P1-11（原型场景 G 已由用户确认，[决策 126](decisions/126-user-rulings-p1-11-terminal-prototype-2026-09-29.md)；P1-15 之后开工）；之后 ~~P1-9c~~ 已落地 `01c57b52` → ~~P1-9d~~ 已落地 `7f6bef13` → ~~P1-9e~~ 已落地 `7c505ed9` → ~~P1-9f~~ 已落地 `f8532981` → ~~P1-15~~ 已落地 `75a54553` → ~~P1-11~~ 已落地（`4d530938` 去掉 pi TUI、`b14d2773` 右列终端）→ ~~P1-6d~~ 已落地 `7a11cbc4`（Windows CI 工作流 `376611a7` 未推送）。

**本机限制（2026-09-28 用户明令）**：不跑 `pnpm build`（整包 electron-vite 构建两次把系统弄崩）等庞大操作；验证只做四套 tsc、挑选的 vitest、宿主冒烟与 `bridge-record`，一次一个。**未验证项**：P1-10b 给 `DshHostProcess.ts` 加了静态导入，vite 拆块没有在本机检查，交 CI 或用户构建时看。

## Last Landed

- 2026-09-29 插件工具行用插件自带标题、分叉旧会话以新发的第一条消息命名 `740a45b1`（用户裁决 130 的 120 第 27 条与 123；取舍见[决策 131](decisions/131-plugin-row-titles-and-fork-title-choices.md)，待审批，**请重点看第 7、15、17 条**：标题整体替换「动词 + 参数」；过渡标题「原标题（1.0.x 分支）」按迁移当时的语言存成字符串；只看迁移后第一条消息，取不出标题就保留后缀）：
  - bridge 对非 DSH 自带工具问 `presentCall`，`tool.started` / `tool.updated` 带收窄后的 `presentation`；历史投影回放问同一个 presenter，直播与重开一致；插件关掉后重开的行退回词条。
  - `commitMigrated` 认出分叉时改名并记 `forkTitlePending`，任何改名都结束等待，手动改名优先。
  - 编排器复跑：四套 tsc 通过；bridge、`src/shared/dshHistory`、`src/shared/types`、`src/main/services/chat` 43 个文件、984 例；渲染层 chat 与 stores 175 个文件、3511 例；Static / Scan / Wiring 73 个文件、739 例；`src/shared/__tests__` 26 个文件、372 例；scripts 12 个文件、214 例；真宿主集成 35/35；bridge-smoke 66 项（新增 `pilotRowsTitled`）；`--check` 28 个场景无差异，不用重录；宿主产物 82.6 MiB，L1 44 项。
  - 遗留：子代理泳道里的插件行不带标题；GUI 样式与分叉过渡标题归 P1-7d 点验。
- 2026-09-29 P1-6d PowerShell 权限分析 `7a11cbc4`、Windows CI 工作流 `376611a7`（取舍见[决策 129](decisions/129-p1-6d-pwsh-analysis-choices.md)，待审批，**需用户重点拍板第 4、7、13、16 条**：含变量或执行字符串的 pwsh 命令不可授权，比 bash 严；`sc`、`curl`、`wget` 不归一；1.0.x 自有引擎的 bash 卡也会带原因句；活动行两个 shell 写法不对称）：
  - `pwshAnalysis` 保守词法分析，拿不准就问；别名与全名授权互通（P1-6d 之前按原始首词记的授权不再命中，多问一次）；闸门产出 `askReason`，审批卡显示原因句与 PowerShell 别名说明；活动行显示「已允许 PowerShell」。顺带更正决策 120：活动行此前写的是「已允许 pwsh」，不是「bash」。
  - S18 不进录制金样本（录制器只在 Linux），改用断言式探针 `perm-pwsh-probe`；Linux 下 bash 干跑 14/14。
  - Windows CI：`.github/workflows/dsh-p1-6d-windows.yml`，admin 与标准用户两路（标准用户路隐藏 PowerShell 7 以退回 5.1），推送 `ci/dsh-p1-6d-windows` 或手动触发；**未推送、未触发**。
  - 编排器复跑：四套 tsc 通过；权限纯库、dsh-host、runtime 权限相关、`src/shared/__tests__` 与全仓 Static / Scan / Wiring 共 133 个文件、2060 例，渲染层 chat 与 stores 174 个文件、3485 例，全部通过；真宿主集成 35/35；bridge-smoke 65 项；`--check` 28 个场景无差异；宿主产物 82.6 MiB，L1 共 44 项。
- 2026-09-29 P1-11 第二部分：右列普通 shell 终端 `b14d2773`（决策 109、126；取舍见[决策 128](decisions/128-p1-11-right-column-terminal-choices.md)，21 条，待审批，**请重点看第 3、7、11、13、17 条**）：
  - 会话栏「终端」按钮（未绑定目录置灰，后台仍有 shell 时加小圆点）；右列叠放「审阅 > 在前面的终端 > 文件」，关终端后文件标签原样恢复；复用通用终端栈。
  - 与原型不同的三处：默认列宽沿用编辑器列比例，1440×900 下 558 px、1280×720 下 520 px，不是原型占位的 460 px（第 7 条）；会话栏按容器宽度收成图标，不是原型的「止于中栏」（第 3 条）；远程工作区的终端可打开，沿用现有 `resolveTerminalWorkspace` 判定（第 4 条）。
  - 每个目录一个 shell，切走不结束（第 11～15 条）；worktree 初始化脚本仍在左栏终端里跑，改到右列并删左栏终端建议另开小任务由用户定（第 17 条）。
  - 编排器复跑：四套 tsc 通过；渲染层全部 295 个文件、4815 例，`src/main`、`src/shared/__tests__` 与全仓 Static / Scan / Wiring 共 220 个文件、2771 例，全部通过；真宿主集成 35/35。本项没改宿主与 bridge，没跑冒烟与录制。
  - GUI 点验要看：宽屏开右列时按钮只剩图标且不压右列标签栏、终端与编辑器标签栏对齐、置灰提示、后台小圆点、切回会话时终端抢焦点、终端显示时 Ctrl+F 打开终端搜索。
- 2026-09-29 P1-11 第一部分：去掉内嵌 pi TUI `4d530938`（决策 109、126；取舍见[决策 127](decisions/127-p1-11-remove-pi-tui-choices.md)，20 条，待审批，**请重点看第 4、8、11 条**：pi CLI 插件管理提前删除（原定 P1-12）；旧 `auth.json` 要不要启动时一次性删除，默认不删；`presentationMode` 字段删除、旧值读入时丢弃）：
  - 删 pi TUI 服务、IPC、TUI 交接、`chat:reloadSession`、`/new` 会话登记，以及会话栏 GUI / TUI 开关与 TUI 视图；共 99 个文件、约 −8k 行。
  - `auth.json` 停写明文 key（决策 038 第 3 条的两个前提都已满足），key 只在内存；已有文件不删，登出照旧删。
  - 通用 shell 终端栈保留给右列终端：`PtyManager`、`SessionManager`、`session:*` IPC、`useXterm`、`ShellTerminal` 等；worktree 初始化脚本本就在左栏通用终端里跑，不依赖 TUI。
  - 新静态守卫 `piTuiRemovedStatic`：产品里不再拉起 pi CLI、没有开关、不写 `auth.json`、通用终端栈还在。
  - 编排器复跑：四套 tsc 通过；`src/main`、`src/shared/__tests__` 与全仓 Static / Scan / Wiring 共 220 个文件、2762 例，渲染层全部 292 个文件、4793 例，全部通过；真宿主集成 35/35；bridge-smoke 65 项；`--check` 28 个场景无差异。
  - **过渡状态**：右列终端上线之前，会话栏没有任何终端入口。留给 P1-12：`worker.reload` 协议四处、`src/agent-host` 里的 `@earendil-works/pi-coding-agent` 依赖、4 个手动探针脚本。发版说明要补「内嵌 pi 终端移除」。
- 2026-09-29 P1-15 一次性补全换引擎 `75a54553`（取舍见[决策 125](decisions/125-p1-15-one-shot-completions-choices.md)，待审批，**请重点看第 1、10、11、13、16 条**：没走决策 039 的通道 `utility.*` RPC，改为宿主控制消息；「自动」取计划里的第一个模型；档位按 completion 规则，不再退回读 `<agentDir>/settings.json` 的思考档位；宿主从 `failed` 也会被补全拉起；错误显示为「码: 句子」）：
  - 提交信息、分支名、代码评审经共享宿主 `ctx.llm.stream` 直调，不开会话、不写盘、没有工具；Main 新服务 `DshCompletionService` 保留容量 2、超时、取消、登出失效与退出清理。
  - 编排器复跑：四套 tsc 通过；`src/main`、`src/dsh-host`、`src/shared/types` 共 174 个文件、2544 例，`src/shared/__tests__`、全仓 Static / Scan / Wiring、`src/agent-host` 共 114 个文件、1348 例，全部通过；真宿主集成 35/35（新增补全阶段：三个真入口各生成一次、中途停止 2 s 内结束、超时后宿主照常、计划外模型与登出状态都没有请求到达网关）；bridge-smoke 65 项；`--check` 28 个场景无差异；宿主产物 82.6 MiB，L1 共 44 项。
  - 遗留：补全错误除 `timeout` 外未本地化；打包冒烟 L1 没覆盖补全；无会话时首次补全要冷启动宿主（实测 1.5～5.2 s）；真实网关验证 R7 需用户授权。`PiUtilityService` 等留到 P1-12 删除，清单见第 18 条。
- 2026-09-29 P1-9f 导入直接产出 DSH `f8532981`（取舍见[决策 124](decisions/124-p1-9f-imports-produce-dsh-choices.md)，20 条，待审批，**请重点看第 1、7、8、12、14、17 条**）：
  - `seedSession` 加 `imported-conversation` 一种 kind，与迁移共用写桩流程；Main 新增 `DshLegacyImportHost`，索引行写 `dsh`；去重认迁移对，`removeImported` 接受 dsh 行、拒绝带 `migratedFrom` 的行；导入清单认 `<id>.dsh.json`。
  - **更正方案**（第 4 条）：导入失败时只删桩，DSH 日志留盘，P1-3d 只删空会话，实际不会回收，与决策 121 的同类遗留一起观察。本构建从不删 1.0.x 的 pi 文件。
  - 留给 P1-12 删除的清单见第 19 条（`PiImportProcess`、`WorkerManager` 的三个导入方法、worker 侧 `nativeImport` 等；`scripts/gen-legacy-pi-fixtures.ts` 也用 `nativeImport`，删前确认语料不再重生成）。
  - 编排器复跑：四套 tsc 通过；`src/main` 全部 137 个文件、1822 例，转换器、协议、bridge、会话索引、设置页、`src/shared/__tests__` 与全仓 Static / Scan / Wiring 共约 220 个文件，全部通过；真宿主集成 32/32（新增导入阶段：导入 2 个会话后续聊，模型看得到原提示与回复，看不到只供展示的工具行）；bridge-smoke 61 项；`--check` 28 个场景无差异，金样本无需重录。
  - 遗留：回装 1.0.x 时它读导入清单会丢掉本构建的 `.dsh.json` 记录，写回后再升级回来，同一来源再导会多一份；加密机上 CC / Codex 源由 Main 读取可能读到密文（1.0.x 已有，归 P1-13）。
- 2026-09-29 P1-9e 旧会话迁移的渲染层 `7c505ed9`（取舍见[决策 123](decisions/123-p1-9e-migration-renderer-choices.md)，待审批，**请重点看第 2、6、8、13 条**：迁移中只在发起迁移的窗口显示；失败原因归 8 类；可重试的失败只留卡片上的「重试」；分叉徽标只写 `1.0.x`（10px 徽标不能放中文，完整说明在悬停提示））：
  - 三个恢复入口统一先迁移；迁移中时间线提示、输入框占位「正在迁移」；失败卡片按阶段显示原因与「错误码：阶段/码」；需要引擎的操作（会话树、回退、fork、`/compact`）遇到 `legacy_migration_required` 先恢复再重试。
  - 只读卡片与相关死翻译删除；偏好四键复制到旧会话键下、档位芯片同步。
  - 设置页三条说明都不加（决策 123 第 14 条）：子代理缓存 TTL 的入口已随 P1-16e 卸下；空闲超时 0 在 DSH 下映射为定时器上限，用户看不出区别；不受支持的协议已有模型菜单提示与决策 036。
  - 编排器复跑：四套 tsc 通过；渲染层 chat、stores、壳层、设置、ui，`src/main/ipc`、`src/shared/__tests__` 与全仓 Static / Scan / Wiring 共 351 个文件、5617 例通过。本项没改 Main 与 bridge，没跑集成与录制。
  - 待定小问题：分叉行继续后迁成 `<id>_pi` 的新会话，与原会话同名且徽标消失，要不要加标题后缀；同一会话开在两个窗口时，另一个窗口看不到迁移进度。GUI 点验（正常迁移、可重试失败、源文件被删、回装 1.0.x 后分叉）归 P1-7d 或收口。
- 2026-09-29 P1-9d 旧会话迁移的 Main 编排与索引 `7f6bef13`（取舍见[决策 122](decisions/122-p1-9d-migration-orchestration-choices.md)，待审批，**请重点看第 1、6、7、13、14 条**：`seedSession` 超时 120 s 是估算；错误码 `legacy_migration_failed:<阶段>/<码>` 只含阶段和码；宿主标可重试的失败自动再试两次；未给档位时沿用旧会话权限；需要引擎的操作对旧行改报 `legacy_migration_required`）：
  - 首次继续时 Main 先迁移再恢复（决策 050）；`commitMigrated` 原子写两行，旧 pi 行改键 `<逻辑 id>_pi`（`~` 做不了 DSH 会话 id）；侧栏隐藏已迁移的 pi 行，1.0.x 里续写过的标分叉；裁剪保护被引用的 pi 行。不做 TUI 交接。
  - **过渡状态**：Main 不再产出 `legacy_session_readonly`，渲染层的只读卡片、重试与迁移中显示要等 P1-9e 改写；分支未发布，中间态可接受。
  - 编排器复跑：四套 tsc 通过；`src/main`、`src/shared/types`、bridge、`src/shared/__tests__`、全仓 Static / Scan / Wiring 共 243 个文件、3245 例，渲染层 chat 与 stores 171 个文件、3444 例，全部通过；真宿主集成 31/31（新增迁移阶段：只读语料首次继续触发迁移、续聊成功、源文件不变、二次继续不再迁移）；bridge-smoke 60 项；`--check` 28 个场景无差异。
  - 遗留：P1-9f 之前，迁移过的导入会话再导一次会多出一份；实验 E3 仍未做，120 s 超时待复核。
- 2026-09-29 P1-9c 旧 pi 会话迁移的宿主执行 `01c57b52`（取舍见[决策 121](decisions/121-p1-9c-seed-session-choices.md)，第 1～5 条编排者裁定，第 6～20 条待审批）：
  - **开工实验 E1 推翻了方案假设**（[证据](evidence/p1-9c-seed-experiments-2026-09-28.md)）：含压缩的 8 份语料，种子写得进去、dispose 后冷读报 `compaction checkpoint has no matching compaction/start`，会话从此打不开。DSH 读盘要求检查点落在 `compaction/start` → `summary` → `end` 事务里，创建时不查；P1-9b 的 `checkSeed` 也没有这条。编排者裁定按 DSH 实时压缩的写法修转换器（版本 2），修后 27 份可转换语料全部通过，E2 成立。
  - `shadowedTokenCount` 用照搬的 `dsh-token-meter` 估算器（MIT，已登记 `THIRD_PARTY_NOTICES.md`，漂移测试逐条比对 DSH 原函数）；`provider` / `model` 取前一条回复的（pi 压缩条目不记）。
  - 会话 id 的「.」会让 DSH projection cache 写不进去（键规则 `[a-zA-Z0-9_-]`）：回退改 `_r<n>`、迁移用 `_m<n>`，编号兼容旧 `.r<n>`。
  - 宿主 `seedSession`：只读读源并比对 stat、图片走 `admitUserContent`、create / flush / dispose 后冷读核对（核对必须冷读）、sidecar、带 `origin` 的桩；幂等。
  - 编排器复跑：四套 tsc 通过；相关单测 168 个文件、2389 例 + 转换器 9 个文件、240 例通过（含全仓 Static / Scan / Wiring）；真宿主集成 30/30；bridge-smoke 60 项（新增迁移主机 J）；`legacy-pi-dsh` 金样本重生成并逐份分类核对（41 份只差版本号，16 份是含压缩文件多出事务事件），`rewind` 金样本只差 id 后缀，`--check` 28 个场景无差异。
  - 遗留给 P1-9d：Main 侧发送 `seedSession` 与超时、迁移服务与索引；替换未完成的迁移时旧日志留盘；实验 E3（2000 条消息与 32 MiB 的耗时与内存）没做。
- 2026-09-28 P1-7c 工具行与 Windows 文案 `a0aa76a7`（取舍见[决策 120](decisions/120-p1-7c-tool-rows-choices.md)，31 条，待审批，**待拍板：第 27 条插件行暂不接 `presentCall`（它依赖的 `presentation` 字段在 P1-4d 重划时漏掉了，bridge 没有产出）；第 28 条「规划」替换「已规划」，旧会话的 `TodoWrite` 行跟着变；第 3 条后台 job id 只在直播里有；第 18 条退出码用纯文字不用徽标**）：
  - DSH 全部工具与 `dsh-office-tools` 8 个工具的动词、图标、参数与结局；「后台 · bash-N」「已转后台 · bash-N」；`todo_write` 展开画清单；pwsh 去前缀、审批卡区分 Bash / PowerShell；失败卡按错误码细分。
  - 推迟到 P1-6d：审批卡上的 PowerShell 别名说明与「为什么要问」的原因句（前者依赖别名归一化，后者依赖 `askReason`）。范围外的新发现：`pwsh` 以 `policySurface: 'bash'` 过闸，Windows 上的授权活动行会写「已允许 bash」。
  - 编排器复跑：四套 tsc 通过；相关单测 332 个文件、5648 例通过（含全仓 Static / Scan / Wiring；`fontDomainScan` 因正则引号指数回溯的问题已修）；真宿主集成 30/30；bridge-smoke 55 项；金样本整套重录（`job-notice` 与前面场景共用宿主，job id 是进程级计数，不能单独 `--only`），只有 `job-notice`、`jobs-kill` 两份 stream 多 `backgroundJob` 字段，`--check` 28 个场景无差异。
- 2026-09-28 P1-7b 后台任务、实时输出、子代理 `ada0a024`（决策 069、109；取舍见[决策 119](decisions/119-p1-7b-jobs-subagents-choices.md)，31 条，待审批，**请重点看第 1、10、15～17、25 条**）：
  - 开工前与原型比对，与 109、110、069 无冲突。原型里子代理叫 `explore`、`review`（1.0.x 自定义子代理），按 090 改为「子代理 / 分叉 · 描述」；方案里的「第三条后台窄条」「运行面板清单」以 109 为准改成浮动子窗口。
  - 会话栏「后台任务 N」「子代理 N」按钮开关两个浮动子窗口；`jobs` 投影与 `worker.panels` 补水；`tool.output` 实时输出；所有工具打 `execStartedAt`；三个 RPC：`worker.job.kill`、`worker.job.read`、`worker.subagent.interrupt`。
  - 泳道只在引擎失联时扫成已取消（修掉父回合一结束就标「已取消」）；Stop 先打断可续子代理、停一次性后台子代理再取消父回合，后台命令不停；`tool-jobs` 设 `maxConsecutiveWakes: 3`。已知行为（第 17 条）：被 Stop 打断的子代理若在父回合结束后才结算，仍会唤醒会话一轮。
  - 编排器复跑：四套 tsc 通过；相关单测 421 个文件、6646 例通过（含全仓 Static / Scan / Wiring 72 个文件）；真宿主集成 30/30；bridge-smoke 55 项；宿主产物 82.4 MiB，L1 共 44 项。
  - 金样本：编排者先整套录到临时目录逐场景比对，既有 26 个场景的 log、rpc 不变，stream 去掉 `execStartedAt`、`jobs` 快照与子代理活动三类后与原样本一致；随后重录（16 个 stream 变化，新增 `jobs-kill`、`sub-cont`），`--check` 28 个场景无差异，读样本的测试 207 例通过。金样本测试加了窄的前缀比较规则（录制器把截断预览里的 UUID 换成更短的 `id-N`），见决策 119 第 29 条。
  - 遗留：历史里重建子代理泳道、子代理用量汇入父会话、「通知待交付」都没做；实验 E4～E6 与合成态点验归 P1-7d。
- 2026-09-28 P1-7a 目标条、待办卡、轮次头与通知行 `8492837c`（取舍见[决策 118](decisions/118-p1-7a-goal-todo-round-choices.md)，31 条，待审批，**请重点看第 1、9、13、24、26 条**）：
  - 开工前与原型逐条比对，与决策 109、110 无冲突；原型抄了旧的输入框占位句「Ctrl+Enter 在下一轮后插话」，与 093 不符，已改为「Ctrl+Enter 并入当前回合」。
  - 目标条 7 种状态、待办卡；`goalActivation` 从 P1-7b 提前到本项，以显示「已挂起」。轮次头替换决策 106 第 36 条的空气泡；DSH 通知画成一行；「待送达」气泡为虚线边框加时钟图标。
  - `worker.command` 带外执行 DSH 命令（不开回合、不发事件）；`worker.panels` 在会话恢复或首次显示时补水，解决决策 113 遗留的恢复后面板空白。
  - 编排器复跑：四套 tsc 通过；相关单测 423 个文件、7067 例通过（渲染层 chat 与 stores、dsh-host、shared、Main、agent-host、preload、壳层与 ui，含全仓 Static / Scan / Wiring）；真宿主集成 30/30；bridge-smoke 52 项；`--check` 26 个场景无差异，金样本未重录。
  - 遗留：实验 E3（`goal/activation-changed` 的触发顺序）没跑；真宿主上「有目标时的 activation 快照」无自动化覆盖；窄条展开状态只在内存；GUI 点验归 P1-7d。
- 2026-09-28 P1-10c 白名单插件设置页与 IPC `0bd912f3`（决策 108、110；取舍见[决策 117](decisions/117-p1-10c-plugin-settings-choices.md)，待审批，**请重点看第 2、6、10、13 条**：Main 另读一份白名单补来源与分类；每次切换只写这一个插件的覆盖、不提供恢复默认；说明文案我方自带；提示按「空闲时自动重启」的真实行为写）：
  - IPC 两条：`dshPlugins:list`、`dshPlugins:setEnabled`；「扩展」页插件一节列名称、版本、说明、来源、能力标签（写文件工具标 warning 色）、审查日期与结论、宿主状态，只有启用开关，没有 pi 字样。
  - 删掉只钉已无入口页面的 `piPluginsPermissionNoticeStatic.test.ts`，有用的断言并入新静态测试；`PiPluginsSettings.tsx` 留到 P1-12。
  - 编排器复跑：四套 tsc 通过；`src/main/ipc`、`dshPlugins`、`agent-host`、设置页、`src/shared/__tests__` 共 105 个文件、1340 例通过；全仓 Static / Scan / Wiring 71 个文件、719 例通过。
  - 遗留：`replaces` 改名继承在逐插件覆盖下失效（现在没有插件用，第一次改名时修）；已下架的覆盖一直留在设置里，没有清除入口；没有 GUI 点验。
- 2026-09-28 P1-16e 旧资产提示与「扩展」页收窄 `6d2fc8a0`（决策 102～105；取舍见[决策 116](decisions/116-p1-16e-legacy-asset-notice-choices.md)，待审批，**请重点看第 6、14、19 条**：用户层指令只列 1.0.x 实际读的那一个；弹窗任何方式关闭都算看过；「插件」页整页卸下不留占位）：
  - Main 只读检测六类 1.0.x 资产（子代理定义、模板、用户层指令、`mcp.json`、DSH 不会加载的技能、显式关过的委派开关），pi 扩展不列；首次启动有结果时弹一次，「扩展」页有常驻入口。
  - 删「子代理」页；「资源」页只留技能目录与规则；能力弹窗只留技能数。留给 P1-12 删除的无引用文件清单见决策 116。
  - 编排者复核补了两处漏网：能力弹窗改用 `DialogPanel` 并在 `dialogPopupPaddingStatic` 登记新弹窗；检测模块与 P1-4c2 的 `attachment-experiments.ts` 改用 `APP_STATE_DIR`（`defaultPaths.test.ts` 的全仓单一来源扫描自 `20285c58` 起一直失败，修在 `2af88a7e`）。**教训**：挑选测试时要加上全仓扫描类测试（`vitest run Static Scan Wiring` 与 `src/shared/__tests__`）。
  - 编排器复跑：四套 tsc 通过；相关单测 137 个文件、1698 例，外加 ui / 设置 / 壳层 80 个文件、1004 例；`src/shared/__tests__` 26 个文件；全仓 Static / Scan / Wiring 测试 71 个文件、717 例，全部通过。本项不动宿主与 bridge，没跑集成与录制。
  - 未验证：没有 GUI 点验；Main 新引入 shared 的 skills、mcp、subagent 纯库，vite 拆块交 CI 或用户构建时看。
- 2026-09-28 P1-10d 试点插件 `a5a925f9`（决策 060；取舍见[决策 115](decisions/115-p1-10d-pilot-plugin-choices.md)，待审批，**第 6 条三项接受的风险与第 10 条共享闸门加 `fileWrite` 请重点审批**）：
  - 联网装 `dsh-office-tools@1.0.4`（[证据](evidence/p1-10d-office-tools-install-2026-09-28.md)）：是 DSH bundle，只插一行；零运行期依赖、无安装脚本、无原生件。5 个 dsh peer 写的是预发布范围，npm 不匹配，按决策 082 第 3 条用 `overrides` 钉到 0.1.7-rc.2（第一次实际用上）。锁文件只新增这一条，已有条目 0 变化，integrity 三方一致。
  - [审查记录](../../../../src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md)：有条件通过。没有凭据、`process`、IPC、子进程、网络、eval、动态 import、钩子；目录标只读，实测 8 个工具中 5 个写文件，读写都由插件自己限制在工作区内。接受的风险：构造过的 Office 文件在共享宿主里同步解压，所有会话可能停顿、占几百 MiB；插件用了未声明的 `@deepseek-ai/schemastery`，靠宿主树顶层解析；Excel 会把 `=` 开头的字符串写成公式。
  - 白名单 `internal`、默认关；工具逐个分类（3 读 5 写）。写工具出卡；共享 `gate.ts` 加 `fileWrite`，accept-edits 档工作区内放行，与 `write` / `edit` 一致，不同意去掉这一处规则即可。
  - 编排器复跑：四套 tsc 通过；相关单测 63 个文件、1184 例通过；真宿主集成 30/30（新增 PLG-6）；bridge-smoke 50 项（新增宿主 I：默认关时工具表没有 office 工具，开启后读不出卡、写出卡并写出 docx）；宿主产物 82.4 MiB（+126 KB），L1 共 44 项（开启试点跑一回合 office，零外连）；`--check` 26 个场景无差异。
  - 遗留：Windows CI 冒烟要推送后看（L1 已带试点插件）；设置页开关归 P1-10c，目前只能经 Main 设置的 `dshPlugins.overrides` 打开；P1-13 检查单要补「开启试点后在加密机上跑 `word_*` / `excel_*`」，按 P1-13b 矩阵 docx、pptx 在加密机上读不出明文，插件会明确报错。
- 2026-09-28 P1-4d3 提问卡 `4e003c1b`（决策 098；取舍见[决策 114](decisions/114-p1-4d3-ask-user-choices.md)，待审批，**第 15 条需用户拍板：提问工具始终开启，没有开关**）：
  - 联网装 `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2`（[证据](evidence/p1-4d3-ask-user-install-2026-09-28.md)）：等于 DSH 钉版本，公共 registry；锁文件只新增 1 条、已有条目 0 变化，带 integrity；包无依赖、无安装脚本，四个 peer 由钉住的树满足。
  - **偏离原方案**：该包不是 DSH bundle（没有 `dsh.bundle` 与 `cordis.patch.yml`），白名单只收 bundle，所以没进白名单，而是照 DSH 发行版的做法由产品 bundle 挂 `tool-ask-user` 行、列入 `HOST_DEPENDENCIES`。白名单仍为空，`dsh-office-tools` 仍是第一个条目。要开关的话：A 由 Main 经 overlay 关这一行（约 0.5 人日），B 给非 bundle 插件另开白名单通道（约 1～1.5 人日）。
  - bridge 挂 `user-questions/request` 应答方，只认领本会话根 agent 的请求；跳过时每题答空选择，不再像 1.0.x 提示模型「自选默认值」（跟随 DSH）。
  - 编排器复跑：四套 tsc 通过；相关单测 64 个文件、1161 例通过；真宿主集成 29/29（新增 QST-1、QST-2）；bridge-smoke 46 项；宿主产物 82.3 MiB（+42 KB、+1 个包），L1 共 41 项。
  - 金样本：新录 `question`，既有 25 个场景的 log 重录。编排者用脚本核对 25 个 log 的唯一变化是工具表多出 `ask_user_question`，rpc、stream 不变；`--check` 26 个场景无差异，读样本的测试 201 例通过。
- 2026-09-28 P1-4d2 命令与状态 `f8c7b2b5`（决策 099 第 9～12 条、101；取舍见[决策 113](decisions/113-p1-4d2-commands-and-projection-choices.md)，待审批，**第 18、19 条需用户拍板**：带附件的 `/goal …` 当提示词发出；命令和它的回答只在直播里出现，重开会话后看不到）：
  - 斜杠菜单列 DSH 命令（隐藏 `/plan`、`/permission`、`/feedback`）与用户可调技能；已知命令经 `ctx.commands.execute`，不开模型回合，未知 `/xxx` 照常当提示词。
  - `worker.compact` 执行 DSH 的 `/compact`，带附加说明时拒绝并在输入框保留原文。
  - `session.projection` 转发 `todos`、`goal`、`subagentCatalog`。首次快照推迟到第一个事件之前发出：Main 在 slot 就绪前会丢掉 slot 发来的事件，bootstrap 时发会永远到不了渲染层。
  - 能力清单只报技能数；弹窗去掉 MCP、模板、子代理三行归 P1-16e。
  - 编排器复跑：四套 tsc 通过；相关单测 272 个文件、4992 例通过；真宿主集成 27/27；bridge-smoke 46 项。
  - 金样本 25 个场景全部重录。重录前编排者把新录制与原样本逐场景比对：去掉投影快照、`capabilities` 与 compact 的命令回合后，stream、rpc、log 全部一致。重录后 `--check` 无差异，读样本的测试 219 例通过。
  - 遗留：崩溃重启、恢复会话后没有新事件时快照不发，渲染层补水靠 P1-7 的 `worker.panels`；命令不进历史，暖 resume 时这两行直播会被排到最后（P1-7a 把命令投进历史）。
- 2026-09-28 P1-4c2 发图、读图与文本附件 `20285c58`（决策 096、097；取舍见[决策 112](decisions/112-p1-4c2-attachment-choices.md)，待审批）：
  - 开工前实验（[证据](evidence/p1-4c2-attachment-experiment-2026-09-28.md)）：DSH 这一侧成立，文件块句柄路径 `read` 可直接读到。基线跑 18 项里有 2 项不过：我方权限闸对附件读取仍出卡，原因是 `isTrustedPath` 只认 spill，且 `gate.ts` 在读取的最后一步会把路径表 `~/.pilab/*: ask` 与 `external_directory: ask` 算回来。两处补上后 18/18。缺口在我方代码，编排者判定实验成立，不退回 1.0.x 做法。
  - 附件入库统一走 `bridge/attachments.ts`，发送与插话共用；拒绝在发任何事件之前抛 `WORKER_ATTACHMENT_REJECTED`。
  - 共享 `gate.ts` 的修正：可信路径只对读取和搜索类工具免路径表与工作区边界的 ask，所有 deny 照旧；顺带修好 spill 可信规则一直不起作用的潜在缺陷。1.0.x runtime 只有技能用 `trustedPath`，不受影响。
  - 用户看得见的差异：名字像密钥的文本附件（`*.env`、`*.key` 等）模型读不到；文本附件在历史里一律显示为 `text/plain`；附件永不自动删除。
  - 新增金样本 `image`、`file-attach`，场景清单 25 个。
  - 编排器复跑：四套 tsc 通过；相关单测 160 个文件、3491 例通过（bridge、权限库、runtime 权限、渲染层 chat、WorkerManager、i18n 覆盖）；读样本的测试 198 例通过；真宿主集成 27/27；bridge-smoke 42 项；`--check` 25 个场景无差异。
- 2026-09-28 P1-4c1 回合语义 `f9a89e51`（决策 093、094、095、106 第 43 条；取舍见[决策 111](decisions/111-p1-4c1-turn-semantics-choices.md)，待审批）：
  - 开工前实验 17 项判定全过（[证据](evidence/p1-4c1-steer-experiment-2026-09-28.md)）：等审批、最后一步结束、turn-stopping 期间 steer 都在下一个步边界被取走；Stop 带 keepInbox 后插话随下一回合送出；不带 keepInbox 会静默丢弃。
  - Ctrl+Enter 改 `agent.steer`，不再经过渲染层队列；取走前气泡标「待送达」（最小样式，最终随 P1-7）。Stop 改 `cancel({kind:'user'},{keepInbox:true})`。失败后「继续」按 028 受理，替换 P1-1 的安全桩。引擎报告的失败不再 `unbindHost()`。
  - 新增金样本 `steer`、`fail-retry`（编排者用 `--update --only` 录），场景清单 23 个。
  - 编排器复跑：四套 tsc 通过；相关单测分五批共 218 个文件、4412 例（bridge / 协议 / WorkerManager / 渲染层 chat 与 stores / i18n 覆盖 / 读样本的测试），金样本清单那一例在补录两个新场景后通过，其余全过；真宿主集成 27/27；bridge-smoke 42 项；`--check` 23 个场景无差异，既有 21 个不变。
  - 遗留：宿主重启后收件箱里的插话回显不带 `attemptId`，待送达气泡收不掉（建议归 P1-7 或 P1-3 收尾）；Stop 后收件箱有插话时 rewind / fork 的去向没有实测。
- 2026-09-28 P1-10b 跟进 `9454b838`（决策 110，修订[决策 108](decisions/108-p1-10b-host-plugin-loading-choices.md) 第 5、6、12 条与[决策 023](decisions/023-no-dotenv-private-cwd-home-patch-overlay.md) 第 3 条）：
  - 打包态自行拼接补丁列表，不读 `$DSH_HOME/cordis.patch.yml`，只告警一行；源码态照旧读。「home 层新增未声明行即拒绝启动」随之删除。
  - 插件设置改为 `{overrides:{包名:bool}}`，`AICLIENT_DSH_PLUGINS` 同步改为对象；没改过的插件跟随 `defaultEnabled`。
  - 编排者复核时补了一处：打包态拼接漏了 DSH 最后追加的遥测关闭补丁。该行本就被强制关闭，补上只为与原函数一致。
  - 编排器复跑：两套 tsc 通过；相关单测 7 个文件 123 例；真宿主集成 27/27（PLG-5 改写为 home 层写 `!!js` 与不可解析的新行，打包态照常就绪）；重建产物 82.2 MiB，L1 共 41 项。
  - `bridge-record --check` 用的是代理跑的结果：21 个场景无差异。编排者的改动只动打包态分支，录制走源码态，所以没有重跑。
- 2026-09-28 第二波收口：P1-10b `3bf5efca`（[决策 108](decisions/108-p1-10b-host-plugin-loading-choices.md)）、P1-4d1 `86a0b379`（[决策 106](decisions/106-p1-4d1-live-mapping-choices.md)）、金样本与 loop-guard-smoke 清理修复 `60fdd778`、P1-16a `a51f751f`（[决策 107](decisions/107-p1-16a-overlay-choices.md)）。编排器复跑：
  - 四套 tsc 通过；
  - 相关单测 270 个文件、5150 例通过，余下 20 例是金样本待重录，重录后读样本的测试 414 例通过；
  - 真宿主集成测试 27/27（新增 PLG-1～5）；
  - bridge-smoke 42 项（新增 INS-1、SKL-1）；loop-guard-smoke 全过（修掉假网关退出前删目录的 ENOTEMPTY）；
  - 金样本 21 个场景重录（18 个既有场景的 stream / rpc 随 P1-4d1 变化，log 不变；新增 think、usage、job-notice），`--check` 无差异；
  - 重建产物 82.2 MiB，打包冒烟 L1 共 41 项；
  - 整包 vite 构建没有做（见上方本机限制）。
- 2026-09-28 P1-7 / P1-11 新原型 `173cb892`（[p1-7-prototype-2026-09-28/](evidence/p1-7-prototype-2026-09-28/)）：25 张截图，子窗口浮动 / 底部嵌入 / 右侧停靠三种形态、终端左栏 / 整列两种位置，`shoot.cjs` 带遮挡与标题溢出两项失败判据。编排者看图后打回一次（标题行溢出、浮动遮挡没量），v3 已修。待用户确认。
- 2026-09-28 P1-6c 与 P1-6b 收尾 `58076972`，金样本重录 `7b8c16a0`（[决策 092](decisions/092-p1-6c-grants-and-setters-choices.md) 待审批）。编排器复跑：
  - 四套 tsc 通过；
  - 相关单测 62 个文件、1129 例通过（含 1.0.x 权限 A 类、RPC 服务器、渲染层权限、i18n 守卫）；
  - 真宿主集成测试 23/23，新增授权跨宿主重启仍生效；
  - bridge-smoke 41 项、loop-guard-smoke 全过；
  - 金样本 18 个场景重录（既有 9 个的 log 加 `aiclient:permission`，新增 9 个 `perm-*`），重录后 `--check` 无差异，读样本的测试 390 例通过（金样本测试的场景清单扩到 18 个，重开首页按当时消息数比对）；
  - 重建产物 82.2 MiB，打包冒烟 L1 共 41 项。
- 2026-09-28 P1-4 / P1-16 重划范围 `dd07a012`：[调研](topics/p1-4-p1-16-rescope.md) 41 项逐项给出保留 / 改用 DSH / 删除 / 推迟，决策 093～105 待审批；P1-4 剩余约 4 人周（没有因总原则变小），P1-16 剩余约 1 人周。
- 2026-09-28 P1-13c 派工说明 `44d66019`（交 Windows 端）；P1-11 终端调研订正 `eba1a9da`。
- 2026-09-28 P1-13b 结果已回（[摘要](evidence/p1-13b-encryption-matrix-2026-09-28.md)，[决策 089](decisions/089-p1-13b-reading-and-hardlink-fix.md)）：DSH 的硬链接写法让新文件 51 类全部不加密，1.0.x 的写法有 22 类加密，这是回退，已登记 P1-13c；node.exe 读不出 9 类文件，与 1.0.x 相同（Q009）；读取的解密与进程名无关。原始报告只留在本地，不入库。
- 2026-09-28 P1-6b 接线：`262a240c`（[决策 088](decisions/088-permission-gate-wiring-choices.md)）。编排器复跑：
  - dsh-host 与根两套 tsc 通过；
  - 相关单测 801 例通过；
  - 真宿主集成测试 21/21，新增批准、拒绝、Stop 收卡三项；
  - bridge-smoke 41 项，新增 `cat .env` 不出卡直接被拒、「本会话允许」后同类命令不再出卡、plan 模式拦写；
  - 金样本 27 份全部重录，重录后 `--check` 无差异，读样本的测试 31 例通过；
  - 重建产物 82.2 MiB，打包冒烟 L1 共 41 项。
- 2026-09-28 P1-12 前置：`e5d16e59` 子代理目录规则搬进 `src/shared/subagentCatalogRoots.ts`，MCP stdio 夹具移出 runtime（[决策 087](decisions/087-subagent-catalog-move-and-fixture-relocation.md)）。编排器复跑相关 22 个文件、357 例通过。
- 2026-09-28 P1-16 再前置：子代理目录规则（根、合并、内置、pin 解析）从 `plugins/subagent/catalog.ts` 搬进 `src/shared/subagentCatalogRoots.ts`，runtime 原位置改薄封装；MCP 真实 stdio 夹具 `mcp-echo-server.mjs` 移到 `src/shared/mcp/__tests__/fixtures/`（[决策 087](decisions/087-subagent-catalog-move-and-fixture-relocation.md)）。P1-16 方案里「删 runtime 前先搬」的三项（skills/模板、MCP、子代理目录规则）至此全部完成。子代理原测试文件（35 例，SA01+SA02）整份搬进 `src/shared/__tests__/subagentCatalogRoots.test.ts`，按用例全名比对零丢失；新增边界静态测试（5 例）与薄封装测试（2 例）。复跑：四套 tsc 通过（dsh-host 侧另一代理并行改动，未触及本次文件）；runtime 下 `subagent` 相关 20 个测试文件、314 例通过；`36df9ac9` 涉及 MCP/skills 的 9 个相关测试文件、138 例通过；biome 改动文件全过。
- 2026-09-28 P1-10a 收尾：`97a41728` plugin-manager 常闭，删掉宿主里的 pnpm 配置，上机包的插件检查改为不联网（[决策 082 实施补记](decisions/082-allowlist-implementation-choices.md)）。编排器复跑：dsh-host tsc 通过；相关单测 765 例通过；真宿主集成 18/18；`bridge-record --check` 9 个场景无差异；bridge-smoke 36 项；重建产物 82.1 MiB，打包冒烟 L1 共 40 项。代理另跑了上机包 Linux 预演：44 项里通过 40、失败 0。
- 2026-09-28 P1-16 前置：`36df9ac9` skills、模板与展开、MCP 的纯逻辑搬进 `src/shared`，runtime 改为薄封装（[决策 086](decisions/086-shared-skills-mcp-move-choices.md)）。编排器复跑：相关 20 个测试文件、480 例通过；根、runtime、agent-host 三套 tsc 通过。
- 2026-09-28 P1-13b 上机包：`c3eb0068` 加密矩阵工具，外加第一轮现场脚本修改的回收。Linux 预演（只跑 node 那半边）通过，单测 17 例通过；PowerShell 脚本还没实跑过。包在 `/var/tmp/aiclient-p1-13b-kit/`，sha256 `4a5ea708…b652`。读代码还有一个发现：DSH 新建文件是先写临时文件再硬链接成目标名，1.0.x 是直接写目标名，所以决策 084 与 Q009 里「与 1.0.x 相同」的推断已撤回。
- 2026-09-28 P1-5 宿主侧接线与 P1-5b：`fcaeb8bc`（[决策 085](decisions/085-model-plan-wiring-implementation-choices.md)）。编排器复跑：
  - 四套 tsc 通过；
  - 相关单测 86 个文件、1337 例通过；
  - 真宿主集成测试 18/18，含 KEY-CANARY；
  - bridge-smoke 36 项、loop-guard-smoke 31 项；
  - `bridge-record --check` 只有预期中的一处差异，已重录 `stream.fail.json`；
  - 重建产物 82.1 MiB，打包冒烟 L1 共 40 项全过。
- 2026-09-28 P1-13 第一轮（加密机，用户现场执行）：正式轮 45 项通过、3 项记录，DSH Desktop 对照组 14 项通过。`.txt` 的读取、编辑、搜索、shell、终端、spill、会话日志都是明文；node.exe 新建的文件不加密（三组一样，[Q009](open-questions.md)）；另有两处读到密文的旁证（`.ps1`、`.yml`），要做扩展名矩阵。证据在 [p1-13-encrypted-2026-09-28.md](evidence/p1-13-encrypted-2026-09-28.md)。
- 2026-09-28 P1-10a：`ad999a0f` 插件白名单与构建期审计，去掉随包 pnpm，产物从 97.9 MiB 降到 82.1 MiB（[决策 082](decisions/082-allowlist-implementation-choices.md)、[083](decisions/083-host-size-budget-reset-after-pnpm.md)）。编排器在只含 P1-10a 改动的临时 worktree 里复跑：相关 5 个测试文件、165 例全过，biome 通过。代理在同样的隔离环境里重建产物，打包冒烟 L1 共 37 项全过。
- 2026-09-27 P1-4b 与 P1-8：`36d4f84a` 回退、fork、跨 lineage 的树；`72330d1b` 防空转插件。合跑复跑：三套 tsc 通过；单测 65 + 4 个文件全过；真宿主集成 13/13；bridge-smoke 33 项、loop-guard-smoke 31 项、bridge-record 9 个场景；重建产物 97.9 MiB，打包冒烟 L1 通过。
- 2026-09-27 P1-4a（第二部分）：`d3a275ff` DSH 会话只读回放、`outcomeUnknown`、三条迁移投影规则。复跑：三套 tsc 通过；相关单测 92 个文件通过（修掉一处 `defaultPaths` 守卫的误报）；真宿主集成 11/11；bridge-smoke 33 项全真。
- 2026-09-27 P1-5a：`91761cbe` 模型计划纯函数与菜单过滤。复跑：根 tsc 通过，相关测试 31 个文件、497 例全过。
- 2026-09-27 P1-3d：`b3b58f2b` 共享宿主收尾。复跑：三套 tsc 通过；单测 61 个文件、838 例通过；真宿主集成 9/9；bridge-smoke 29 项全真。
- 2026-09-27 P1-4a（第一部分）：`d3f16eb2` DSH 历史投影与 bridge 历史缓存，P1-4e 录制门禁骨架。复跑：dsh-host tsc 通过；单测 11 个文件、192 例全过；bridge-smoke 29 项全真；`bridge-record --check` 7 个场景通过。
- 2026-09-27 P1-3c：`613d0568` 宿主级故障语义。复跑：根与 agent-host 两套 tsc 通过；单测 263 个文件、4579 例通过；真宿主集成 6/6、Stop 看门狗 5/5。
- 2026-09-27 P1-9a / P1-9g 语料：`6ce354c5` pi 解码链搬进 `src/shared/legacyPiSession` 纯库，vendor `buildSessionContext`（MIT），30 份 v4 语料与金样本。复跑：四套 tsc 通过，shared、runtime、agent-host、chat 共 118 个文件、1996 例全过；提交后金样本 22 个文件、358 例复跑通过。
- 2026-09-27 P1-3a：`1427a870` 共享宿主接线，所有聊天会话共用一个 DSH 宿主。复跑：三套 tsc 通过，单测 55 个文件、754 例通过，真宿主集成测试 4/4，bridge-smoke 27 项、打包冒烟 37 项全过。
- 2026-09-27 P1-6a：`16c8ef16` 权限逻辑抽成 `src/shared/permissions` 纯库，runtime 改为薄封装。复跑：三套 tsc 通过，runtime 与纯库相关 72 个文件、1291 例全过。
- 2026-09-27 P1-3b：`04ba4166` 共享宿主 Main 侧组件（未接线）。复跑：四套 tsc 通过，相关单测 49 个文件、656 例全过。
- 2026-09-27 P1-2：`2788952f` DSH 宿主转正并接入三平台打包（构建产物、干净安装与删除式裁剪、打包冒烟、CI 接入，未推送）。编排器复跑：dsh-host、agent-host 两套 tsc 通过；P1-2 单测 4 个文件、115 例全过；产物 L1 冒烟 31 项全过；bridge-smoke 18 项全为真。
- 2026-09-27 P1-1 收尾：`e3ce1691` 聊天会话不再向 DSH 宿主下发含明文 key 的模型目录；旧会话、附件被拒时草稿退回输入框。复跑：三套 tsc 通过，相关单测 203 个文件、3706 例全过。
- 2026-09-26 P1-1 代码：`100ebcf1` 聊天会话一律走 DSH 宿主，旧 pi 会话迁移前只读，新会话先落盘再写桩。证据见 [p1-1-engine-cutover-2026-09-26.md](evidence/p1-1-engine-cutover-2026-09-26.md)。
- 2026-09-26 P1-0：合并提交 `30a0c257`，把 main v1.0.3（`d23d72aa`）同步进本分支，零冲突。证据见 [p1-0-sync-main-2026-09-26.md](evidence/p1-0-sync-main-2026-09-26.md)。

## Active TODO

没有在跑的代理。下一步：推送与 Windows CI（见 Next Target）。

待用户处理：
1. 真实网关 R1～R10 已授权（决策 130），到时要用户在开发版里登录公司账号；真实数据离线迁移测试仍待授权。
2. P1-13c 做完后，上加密机验证读回退。

## Blocked By

- P1-2 在 Windows / macOS 上实跑必须推送分支，推送前要用户确认；本机只能验 Linux。
- P1-5 的真实网关验证 R1～R10（含 UA 实测）要用户授权：只用公司登录下发的网关，约 50 次小请求。
- P1-9 的真实数据离线迁移测试要用户指定机器与 profile 副本，由用户本人运行，或授权代理运行且只看报告。
- P1-7a 等用户确认布局原型（[Q008](open-questions.md)）。
- P1-11 等用户答复 [Q003](open-questions.md) 的两个问题：去不去掉 pi TUI、要不要换成普通终端入口。
- P1-13b 加密矩阵：上机包做好后，要用户在加密机上运行，并人工确认输入文件已加密。Q009（node.exe 新建文件不加密）等 P1-13b 结果出来后再裁决。Q010（能否用普通权限账户补测）要用户答复。
- P1-13 第二轮上机要等 GUI、真实模型、迁移落地；P1-11 内嵌终端去留要用户拍板；P1-14 推送与发版要用户确认。

## Last Verified

- 2026-09-27 P1-1 GUI 点验（Linux 开发机，`100ebcf1`，临时 HOME、本地假网关，11 次请求都带假 key）：新建会话走 DSH ✅，恢复与崩溃重启 ✅，旧会话只读 ⚠️（草稿丢失），拒绝路径 ✅ / ⚠️（带图时草稿丢失），`session_locked` 未能取证。
- 2026-09-26 P1-1（Linux 开发机，内容同 `100ebcf1`）：四套 tsc 全部退出 0；相关单测 65 个文件、1043 例，加上渲染层 165 个文件、3201 例，全部通过；bridge-smoke 18 项判定全部为真。全量 Vitest 与 GUI 未跑，GUI 点验进行中。
- 2026-09-26 P1-0（Linux 开发机，`30a0c257`）：四套 tsc 全部退出 0；`src/main/services/agent-host/` 与 worker RPC 类型相关单测 19 个文件、314 例全过；`bridge-smoke.ts` 6 项判定全部为真。全量 Vitest 与 GUI 未跑。
