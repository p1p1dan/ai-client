# DSH 二开迁移：进度看板

Role: implementation-status。更新日期：2026-10-08。只放当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；任务身份与状态以 [roadmap](roadmap.md) 为准。

## 工作方式（2026-09-26 用户授权）

- 只在分支 `feat/dsh-p0-probe`（worktree `.claude/worktrees/agent-a84b7bf3214a2affd`）上活动，不动 main 与 v1.0.3；不推送，推送与发版前先确认。
- 按 roadmap 顺序推进 P1。一般问题调研后自行决定，每条决定单独写一份决策文件，标「自主决定，待用户审批」；难以解决的问题停下来与用户商讨。

## Current Phase

P1 分支内 DSH 替换，已到 **P1-14（收口、推送、Windows 测试版、合入 main 发版）之前**。2026-10-07 做完了 P1-14 之前本机能做的全部 (a) 类工作（[盘点](topics/pre-p1-14-remaining-2026-10-07.md)），用户决定暂不推送。

- **roadmap 状态**（2026-10-07）：
  - ✅ P1-0、P1-1、P1-2、P1-4、P1-6、P1-9、P1-10、P1-11、P1-12、P1-15、P1-16；
  - 🟡 P1-3（剩 L2 GUI 杀宿主与 Windows 杀宿主）、P1-5（剩 R8 完整回合与 R9）、P1-7（剩复点验与 Windows 实测）、P1-8（CI 工作流待首跑）、P1-13（剩第二轮上机）；
  - ⬜ P1-14。
- **现在分支上能做到**：
  - 聊天引擎只有 DSH 宿主（`src/dsh-host/`），所有会话共用一个宿主进程；自有 runtime 与 `src/agent-host` 已删（P1-12），只剩两套 tsc（根、`src/dsh-host`）；
  - 用界面选的模型聊天，key 每次请求时从 Main 拉取；管理员 key 存在保险库里，模型缓存文件不再含 key 原文；
  - 每次工具调用都经我方审批，「本会话允许」在宿主重启后仍有效；
  - 旧 pi 会话第一次继续时迁移成 DSH 格式，CC / Codex 导入直接产出 DSH 格式；
  - 白名单插件可以在设置里开关（试点 `dsh-office-tools` 默认关），插件审查有必拒三条和静态守卫；
  - 右列普通 shell 终端取代了内嵌 pi TUI。
- **推送**：仓库是公开的。最后一次推送是 2026-10-03 的 `1.1.0-dsh.4`（远端头 `f847f66d`），之后的提交都只在本地。2026-09-28 按用户要求改写过分支历史，删掉加密机的原始现场报告，只留脱敏摘要。

## Next Target

2026-10-07 更新。2026-09-29 与 2026-09-28 的旧 Next Target 已过期，原文移到文末「历史」一节。

**下一步是 P1-14**：推送、CI 首跑回看、GUI 复点验、Windows 测试版实测、回写 ARD、合入 main 发版。推送与发版都要先经用户同意。

1. **先等用户**：
   - 同意推送（用户 10-07 决定暂不推送）。推送前先单独一个 `chore` 提交，把版本升到 `1.1.0-dsh.5`（决策 132、149 第 1 条）。
   - 审批 [decision-review-4.md](decision-review-4.md)：131～156 中 23 份待审批决策，外加[决策 157](decisions/157-outbound-proxy.md)（出站代理，待拍板，推荐维持直连）。「没点名即同意」的惯例这次是否沿用，要用户确认。
2. **推送后看 CI**：
   - 手动触发整包 `build.yml`：P1-12 第 4 步（`3d679576`～`4db4376a`）及之后的全部改动，第一次经过整包构建、三平台打包验证与 L1 冒烟；vite 拆块也在这里看。
   - `dsh-bridge-gate.yml`（推 `feat/dsh-*` 时自动跑）新加的三步第一次跑：防空转冒烟（31 项硬门槛）、争用回归 LC-0～2（硬门槛决定结局，软门槛写进 job summary）、插件审查守卫。job 超时 40 分钟是估算，首跑后按实测重算（决策 154）。
   - LC-2 抖动：本机跑过一次「受害者 delta 间隔」硬门槛临界失败（249.6 ms，门槛 221.4 ms），单跑复跑通过。CI 首跑若也临界失败，先按 runner 噪声查，不急着改门槛（决策 154 §7）。
3. **GUI 复点验**（开发机；一次只做一件重活，不与全量测试同时跑）：
   - [决策 156](decisions/156-pre-merge-ui-fixes-choices.md) 末尾「建议在 P1-14 复点验的项目」11 项；
   - P1-7e e6（`5e29f08d`，[决策 145](decisions/145-p1-7e-e6-choices.md)）改过的项目；
   - P1-8：小上限提示条与「继续」、退化回复的失败卡；
   - P1-3e：空闲、流式、`sleep 30` 三个会话同时在场时杀宿主，再加一轮 SIGSTOP（[证据 §5](evidence/p1-3-shared-host-2026-10-07.md)）；阶梯 B 的界面在应用里触发不了（决策 151 第 6 条）；
   - P1-12 第 1 步留下的整包点验：打包版首屏、权限页随包那一行。
4. **Windows 测试版实测**（要先推送并出测试包）：
   - 点验清单 J 节 W1～W12，以及 PowerShell 审批卡的原因句与别名说明（[p1-7d-gui-pointcheck.md](topics/p1-7d-gui-pointcheck.md)）；
   - Windows 杀宿主，管理员、标准用户各一轮：Job 里的工具进程是否全部结束、命名信号量是否释放、ConPTY 下的 pwsh 有没有孤儿；
   - 覆盖安装后不残留 `agent-host` 目录；
   - E8 结论（决策 150 存疑 1）与决策 034 第 4 条（IPC 句柄不被工具继承）在 Windows 上是否同样成立。
5. **P1-13 第二轮上机**（用户在加密机上执行）：GUI、真实模型、插件子进程（开启试点插件后跑 `word_*` / `excel_*`）、迁移；P1-13d 的复核修复回加密机复测。上机手册待写。
6. **其他需要用户的**：
   - P1-5 R8：重新登录后跑通一次完整回合（GW-16、GW-17）；R9 等网关管理员答复；
   - P1-9 真实数据离线迁移测试：要用户指定机器与 profile 副本，由用户本人运行，或授权代理运行且只看报告。
7. **P1-14 自己的文档**：ARD 完整回写（提纲已在 ARD 末尾的「DSH 偏离」一节）；发版说明补「内嵌 pi 终端移除」（决策 127）等。

## Last Landed

- 2026-10-08 `1.1.0-dsh.7` 测试包：推送 `a0320fe2`（用户同意），整包 `build.yml` run 37859947558 全部 job 通过（Windows、Linux、macOS 打包与远程运行时），`dsh-bridge-gate` run 37859914736 通过。Windows 安装包 artifact `windows-installer` 182 MB。交用户在加密机上复测 git（分支显示与切换、变更与 diff、提交历史、AI 提交信息与代码审查、放弃更改）与主题「跟随系统」。
- 2026-10-08 现场缺陷三条（未推送）：
  - **git（用户在 dsh.6 加密机上报）** `cc4f1f48`（[决策 161](decisions/161-git-read-fallback-shared.md)，待审批）：切分支「没反应」实为聊天栏当前分支来自没有回退的 `git worktree list`；「没有修改」是 `getFileChanges` 丢输出抛错后无回退；「暂无提交」是 `getLog` 把空输出当 0 条。新增共用 `gitReadFallback.ts`（每个读取声明 `lostWhen`，非零退出不算丢失，回退成功一次后本进程读取直接走 runner），log / file-changes / worktree list / diff / 提交详情 / blame 改走它，checkout 后读回 HEAD。独立审查 1 条中低（外部信号杀掉的 status 被当成丢输出、可在普通 Linux 上误开开关）已修。收尾批 `6626d618`（[决策 162](decisions/162-git-read-fallback-closeout.md)，待审批）：AI 提交信息 / 代码审查 diff、commit 读回 HEAD、合并与冲突、子模块、check-ignore 补回退；读失败时变更列表 / 提交历史 / 分支按钮显示错误行；大 diff 不再静默为空；远程端解析同修。第二次独立审查 6 条（discard 路径穿越、写后复用在飞的旧读、discard 受 5000 条上限影响等）全部已修。
  - **1.0.4 测试者报的外观与导入引导** `c373d02d`（[决策 160](decisions/160-field-fixes-theme-and-import-guide.md)）：主题「跟随系统」每次启动被 persist merge 里的 system→light 改回浅色（`4019fedf` 起，1.0.1～1.0.4 与本分支都有）；导入引导只看「本机有没有历史」不看导入状态。先在基于 1.0.4 的本地 worktree `fix-1.0.x-persist` 修好再移植。**用户裁决：只修在本分支，不发 1.0.5；本分支测试完毕后直接推为主线。** 加了设置写盘失败、settings.json 读回形状、导入计数的诊断日志。
  - 验证：git 目录 193 例（编排者复跑 git + ai + remote 221 例）、设置与导入 92 例、Static / Scan / Wiring 764 例、shared 446 例、根 `pnpm typecheck`、biome。没有起 Electron。用户同意随 `1.1.0-dsh.7` 推送并出测试包。
- 2026-10-08 `1.1.0-dsh.6` 测试包：推送 `386e3428`，整包 `build.yml` run 37737061023 全部 job 通过（Windows、Linux 打包验证，Windows L1 冒烟 44 项），`dsh-bridge-gate` run 37737027212 通过（含 LC-2 新门槛）。Windows 安装包 artifact `windows-installer` 191.8 MB。交用户在加密机上复测 git 回退与「在资源管理器中显示」。（同日从 Windows 触发的 run 37722594114 在 `acfe0a4e` 上因 TS2588 卡在 gate。）
- 2026-10-08 Windows 端提交 `acfe0a4e`（加密机上 git 输出丢失时经随包 node.exe 中转重跑 git，版本升 `1.1.0-dsh.6`）复核与修复 `a065c849`：审查工作流 61 个代理、27 条发现经两票对抗核实成立，其中三处会卡 CI（`const` 重赋值使回退成功即抛 TypeError 且 tsc 报错、原 Q7 测试串到真实 node 进程、biome 格式），回退的 `-s` 短格式解析把未暂存改动算成已暂存、中文与空格路径被转义、改名成「旧 -> 新」、中文 git 下 ahead/behind 恒 0、提交标题含 `->` 的分支消失；主路径原有的「路径含空格只取最后一个词、改名记旧路径」一并修。修法：回退改跑与主路径相同的 `status --porcelain=v2 --branch -z`，共用解析器 `porcelainV2Status.ts`；分支回退 `branch --no-color -a -v` 按 simple-git 规则解析；runner 抽到 `nodeGitRunner.ts`，用 `createGitEnv` 加 C locale，WSL 不走回退，非零退出、超时、超 32MB 都报错；丢输出改用 `GitOutputLostError`（`GIT_OUTPUT_LOST`）触发。6 组核实一轮全过；门禁：两套 tsc、lint、Static 764、shared 446、git 86、ipc 225、source-control 与侧栏 814。**加密机上需用户复测**（命令行变了）。核实中发现的原有问题（非本次引入，待定）：主路径按块解码 UTF-8 在大输出时可能弄坏中文路径；`getFileChanges` 路径含空格只取最后一个词、改名 path/originalPath 反了；主路径 simple-git 未固定 locale；加密机上回退每 5 s 写 2 行 warn。
- 2026-10-08 用户新需求：侧栏仓库行右键菜单加「在资源管理器中显示」（macOS 为「在 Finder 中显示」），点击用 `shell.openPath` 打开仓库目录本身，远程仓库不显示该项，失败弹 toast；`beeab1c7`，复用现有 preload API 与词条，`workspace-shell` 809 例、Static 764 例通过。第二次推送（`6c06b309`）的 `dsh-bridge-gate` run 37717728544 全部通过，LC-2 门槛修复（决策 158）在 CI 上验证。
- 2026-10-08 P1-14 第二次推送（用户同意，**不打包**、不升版本，仍是 `1.1.0-dsh.5`）：带上 LC-2 门槛修复与 GW-16 临时开关，`dsh-bridge-gate` 随推送复跑。用户随后转到 Windows 机上在本分支修其他问题；本机续做前先 `git fetch` 同步。
- 2026-10-08 GW-16 缓存断点临时开关 `a62319cd`、`84150e6a`、快照重录 `6dff4d96`（[决策 159](decisions/159-gw16-cache-control-temp-switch.md)，按决策 149 第 19 条实现，取舍待审批）：「设置 · 模型」页加「工具定义缓存断点（实验 · 临时）」开关，设置键 `experimentalCacheControlOnTools` 默认关；关时所有 anthropic-messages 路由 compat 写 `supportsCacheControlOnTools: false`（含行级覆盖），开时不写。改设置原本不会重建计划（决策 085 第 5 条），新增 `onRendererSettingsWrite` 监听，开关翻转即重建并在空闲时重启宿主，下一轮生效；main.log 记 `[dsh-plan] cache_control on tools: off|on`。真宿主 + 假网关实测：关 = 每请求 2 个（system 1、messages 1），开 = 3 个。编排者重录 `dshModelPlan.snapshot.json`（只多 compat 一项与 revision），`piModelConfig` 115 例通过。代理自测：两套 tsc、lint、Static 764 例、shared 与 `dshModelPlan` 508 例、设置页 227 例、`main/ipc` 225 例、`agent-host` 488 例、`src/dsh-host` 769 例、`--check` 0 差异。
- 2026-10-08 P1-14 第一次推送（用户 10-07 同意，决策 149 第 14 条）：`1.1.0-dsh.5`（`21a298e9`）。整包 `build.yml` run 37709948267 全部 job 通过，Windows、Linux 打包验证通过，Windows L1 冒烟 44 项，安装包大小与 dsh.4 相同。`dsh-bridge-gate` run 37709934981：插件审查守卫、录制 `--check`、回放与投影、loop-guard-smoke 全过，**争用回归 LC-2「受害者间隔 ≤ ELD + 150 ms」硬门槛失败**（184.9 ms，门槛 172.3 ms），其余硬门槛通过，软门槛告警 LC-1 RSS 中位 318.2 MB。根因是门槛的 150 就是受害者定速，对调度与 IPC 抖动零余量；`bddd9ebd`、`19b67ebf` 加 100 ms 显式抖动余量（[决策 158](decisions/158-lc2-victim-gap-jitter.md)，待审批），本机单跑 LC-2 通过，`src/dsh-host` 769 例、scripts 228 例。待下一次推送复跑。
- 2026-10-07 合入前界面小修 13 项：`5d495e01`（文案与原语）、`c568b989`（焦点）、`e81ea90c`（会话状态）、`d01e8db4`（时间线与标题），决策记录 `0b3eb7d6`（[决策 156](decisions/156-pre-merge-ui-fixes-choices.md)，待审批，第 5、6、12 节请重点看；按决策 149 第 3、10～12 条做）：
  - 文案与原语：残留的「Agent Host」文案、上下文面板「查看更多（N）」、10 px 中文改 14 px、读屏原语的标签走词条；回退标题在显示层改为「会话 xxxxxx」，侧栏归档按钮走词条。
  - 焦点：对话框打开时初始焦点避开滚动区；改名按 Esc 取消后焦点回到那一行。
  - 会话状态：恢复失败停在 error 的会话宣告 `released`，离开「正在活动」；容量回收时失败对话保留失败徽标与失败卡。
  - 时间线与标题：失败回合回放后只留一条失败注记，再发一轮后上一轮不再显示「完成于」；代码审查标题显示模型显示名（决策 146 第 13、22 条，145 第 17 条）。
  - 新增 29 例测试；没动 bridge、历史投影与金样本；没有 GUI 点验，复点验清单 11 项见决策 156 末尾。收口全量单测见 Last Verified（`0b3eb7d6`，9719 例全过）。
- 2026-10-07 阶梯 B 先关其他在忙的会话 `4ebcfe5a`（[决策 155](decisions/155-ladder-b-dispose-others-first.md)，按决策 149 第 6 条实现，取舍待审批，第 2、3、5 条请重点看）：`restartHost` 在重启宿主前对卡死会话以外的在忙会话并发发 `worker.dispose`，总上限 3 s，超时或失败不挡重启；被主动关掉的通道按 `restarted` 记账，不扣会话预算。S5 实测：b2 已流出的正文（400 块中的 115 块）保留在历史里，不再只剩「引擎意外停止」注记；卡死会话的 10 s 收尾与旧宿主被杀时间不变。「重启引擎」卡片同样先关在忙的会话（第 3 条，比裁决字面宽）。验证：两套 tsc、lint、Static 759 例、`agent-host` 479 例、`src/dsh-host` 764 例、集成 35/35、`--check` 0 差异；编排者复跑 tsc 与 `agent-host` 479 例。
- 2026-10-07 P1-8c 防护回归接进 CI（只写工作流，未推送）`9748ddef`、`42dddf81`、`02482b26`（[决策 154](decisions/154-p1-8c-ci-wiring-choices.md)，待审批）：`dsh-bridge-gate.yml` 加 loop-guard-smoke（31 项全为硬门槛）与 contention-regression LC-0～2（脚本本来就只按硬门槛决定退出码，软门槛写进 job summary），失败上传报告；`42dddf81` 单独加插件审查守卫一步（决策 153 第 7 节待审批，便于撤回）；job 超时 30 → 40 分钟。本机实测：loop-guard-smoke 55.8 s 全过；contention-regression 69.5 s，**LC-2 受害者 delta 间隔硬门槛临界失败一次**（249.6 ms，门槛 221.4 ms），单跑 LC-2 复跑通过，判为 2 核开发机噪声；首跑 CI 要回看是否抖动。验证：两套 tsc、lint、scripts 228 例、`src/dsh-host` 764 例，YAML 解析通过。
- 2026-10-07 E8-A 插件审查守卫 `350aa1b1`、`b9f2a236`（[决策 153](decisions/153-e8-a-plugin-review-guard-choices.md)，待审批）：审查单 §6.2 加「必拒三条」（碰凭据服务、碰 IPC、猴子补丁）；静态守卫 `scripts/dsh-plugin-review-guard.mjs` 扫白名单与产品 bundle 挂载的非我方插件及其依赖闭包（由白名单、`cordis.patch.yml`、锁文件现算，不手抄包名），豁免只有我方五行的冻结列表。两个试点插件 `dsh-office-tools@1.0.4`、`dsh-tool-ask-user@0.1.7-rc.2` 零命中；E8 探针插件三条全中。守卫在 build.yml gate 的 `pnpm test` 里跑，`dsh-bridge-gate.yml` 不跑。验证：两套 tsc、lint、Static 759 例、shared 443 例、`src/dsh-host` 764 例、scripts 228 例；编排者复跑守卫 20 例。
- 2026-10-07 P1-5e 管理员 key 移入保险库 `4bd31a2c`（[决策 152](decisions/152-p1-5e-managed-key-vault-choices.md)，待审批；决策 038 补记）：`managed-models-source.json` 不再含 key 原文，key 存进保险库独立一组（有钥匙串加密，Linux 无钥匙串 `enc: none` 0600，与登录 key 同级，决策 149 第 2 条）；读回从保险库补全，缺 key 只剔除该服务；老明文缓存首次读取或下次同步时迁移；登出、换账号时清；managed 服务缺 key 时不再回退到登录 key（防止把登录 key 发到管理员给别的服务配的地址）。切到本地模式不清（与登录 key 同生命周期），待用户裁决。代理自测：两套 tsc、lint；Static 759 例、shared 443 例、`piModelConfig` 113 例、`agent-host` 474 例、集成 35/35 且 KEY-CANARY 零命中、auth 245 例、登录登出与 onboarding 等 86 例。编排者复跑 tsc、`piModelConfig` 与 auth 358 例。
- 2026-10-07 P1-3e 验收收尾 `4f461ece`、`16cd195e`（[决策 151](decisions/151-p1-3e-stuck-switch-choices.md)，待审批，第 4、5 条请重点看；汇总证据 [p1-3-shared-host-2026-10-07.md](evidence/p1-3-shared-host-2026-10-07.md)）：探针 bundle 新行 `aiclient-probe-stuck` 挂住工具执行且不理会 abort（三道门，只在测试里能打开，不进产品）；集成测试 S5 改用真实卡死：Stop 后 10.0 s 界面收尾、19.6 s 旧宿主被 SIGKILL、20.6 s 全部会话 idle。实测发现：①阶梯 B 遇到 DSH 内部卡死时，其他会话已流出的正文会丢（与决策 021 第 3 条不符）；②没有 systemd user bus 且工具在沙箱外时，宿主被杀后工具进程残留（与决策 075 第 2 条前提不符）；③S6 只有单测，真宿主没覆盖。验证：两套 tsc、lint、Static 759 例、`src/dsh-host` 764 例、集成 35/35、bridge-smoke 66 项、`--check` 0 差异、`agent-host` 474 例、scripts 208 例。GUI 三会话杀宿主专项、Windows 杀宿主归 P1-14。
- 2026-10-07 E8 插件与凭据隔离实验 `f08f0646`、`35af10ab`（[决策 150](decisions/150-e8-plugin-credential-isolation.md)，缓解方案待用户拍板；证据 [e8-plugin-credential-isolation-2026-10-07.md](evidence/e8-plugin-credential-isolation-2026-10-07.md)）：打包态宿主 + 假网关 + 一次性假 key，14 项判定全过。结论：同进程第三方插件与宿主凭据同权——能直接 `ctx.credentials.resolve` 拿到计划引用名对应的 key（引用名可从 loader 组合里读到）；凭据行能经 Cordis 认出调用方，但可经 `Symbol.for('cordis.original')` 或猴子补丁绕过；`process.on('message')` 能看到 Main 发来的全部凭据应答明文，读到 nonce 后伪造的凭据请求也被 Main 正常应答。决策 034 第 4 条只覆盖了工具子进程，需补。只在 Linux 跑过。
- 2026-10-07 P1-5d 协议收口 `031c10f9`（[决策 148](decisions/148-p1-5d-protocol-narrowing-choices.md)，待审批，请重点看末尾两处）：新建服务只能选 DSH 支持的三种协议并附说明；预设过滤掉 google、mistral；已有服务用了其他协议的，列表标「当前引擎不支持」，编辑时原值钉在选择框里、保存不丢。受支持协议常量 `SUPPORTED_USER_PROVIDER_APIS` 直接引用 `DSH_PROTOCOLS`，与模型菜单的过滤同源；存储类型 `USER_PROVIDER_APIS` 未删减。代理自测：两套 tsc、lint；Static 759 例、`src/shared/__tests__` 443 例、设置页 226 例、`dshModelPlan` 55 例、`piModelConfig` 102 例。编排者复跑两套 tsc、Static / Scan / Wiring 与设置页共 947 例。
- 2026-10-07 P1-12 第 4 步（[决策 147](decisions/147-p1-12-retire-runtime.md) 第二节「第 4 步」9 条，待审批），基线 `d915a2a5`：
  - `3d679576` 搬家并删除 `src/agent-host`：bridge 的 RPC 服务端与错误类型进 `src/dsh-host/bridge/`，`stderrRedaction` 与 `credentialSamples` 进 `src/shared/`，`codexItemMapper` 与 codex 夹具进 `src/main/services/legacyImport/`；删 `typecheck:agent-host`，只剩两套 tsc；build.yml gate 改为 x/5；`BRIDGE_ENTRIES`、`build-dsh-host` 脏检查、扫描测试的根、根 tsconfig 同步；`runtimeRetiredStatic` 新增 3 例。`e890aa7c` 补一处注释出处。
  - `d26f4e6b` 内部改名：`PiWorkerRpcServer` → `BridgeRpcServer`、`PiWorkerSessionError` → `BridgeSessionError`、`createPiWorkerSlot` → `createDshChatSlot`、`WorkerManager` 日志前缀 `[pi-worker:` → `[dsh-chat:` 等；线上协议、错误码与错误文案、环境变量、IPC 名、设置键、`agent: 'pi'`、Main 目录 `services/agent-host/` 都没改。
  - **请用户过目**：日志前缀改名后，查 1.0.x 日志仍要搜 `[pi-worker:`；AGENTS.md 模块表那一行按现状改写，超出了「只改开发命令」（原本留给 P1-14）。
  - 收口：编排者在最终代码上按目录分批跑全量单测，渲染层 321 个文件 5299 例、Main / preload / shared 202 个文件 3355 例（跳过 35）、dsh-host 与 scripts 52 个文件 968 例（跳过 11）、`src/__tests__` 2 例，全部通过。
  - 代理自测（最终代码）：两套 tsc、lint；Static 759 例、`src/shared/__tests__` 437 例、scripts 208 例、`src/dsh-host` 760 例、`src/main/services` 1485 例、改过的其他目录 321 例；bridge-smoke 66 项；`--check` 28 个场景 0 差异；集成 35/35；宿主产物 82.6 MiB、L1 44 项。lockfile 未变。编排者复跑两套 tsc、Static / Scan / Wiring 759 例、`src/shared/__tests__` 437 例。全量单测与打包交推送后的 CI。
- 2026-10-04 P1-12 第 3 步整包 CI：`1.1.0-dsh.4` 第一次触发（run 37170010400，`d961c08d`）gate 失败，原因是 `runtimeRetiredStatic` 在 CI 满负载下全仓扫描超时，`f847f66d` 改为每个文件只解析一次后重触发；run 37170324111（`f847f66d`）全部 job 通过：gate、Windows / Linux / macOS 整包与打包验证、远程 runtime。Windows、Linux 的「Verify packaged app」都报「no native worker or runtime」（含 app.asar 反向检查），Windows 带空格路径 L1 冒烟 44 项通过；`dsh-bridge-gate` 的 `--frozen-lockfile` 通过。安装包继续变小（Actions artifact 压缩后大小，对比第 1 步的 run 36895051539）：Windows 安装包 197.8 → 191.7 MB，Windows 解包目录 288.1 → 279.2 MB，Linux 包 196.6 → 189.8 MB，macOS 包 435.9 → 417.1 MB。只作 Actions artifact，不建 Release。
- 2026-10-03 P1-12 第 3 步（[决策 147](decisions/147-p1-12-retire-runtime.md) 第二节「第 3 步」，待审批），基线 `36d1e02c`：
  - `fe4b9b7e` 删除 `src/runtime`（172 个文件）与 native worker（`worker.ts`、`piSessionTimeline / Tree / Preflight`、`permissionPlugin`、`codexHistoryReader`、`bundledPlugins` 等），worker 协议收窄（utility、`worker.import*`、`worker.reload`、bootstrap 的子代理与 TTL / 超时字段），bridge 去掉对应桩；渲染层删 native 回放测试与 5 份录制；`runtimeRetiredStatic` 补齐。
  - `ce47554c` 根依赖删 `@earendil-works/pi-agent-core`、`pi-coding-agent`，删 `src/agent-host` 的 `package.json` 与 lockfile；`pnpm-lock.yaml` 由 `--lockfile-only` 生成，985 → 878 个包，只删不增；共享 `node_modules` 未动。
  - `6b8e7d79` 随包策略表挪进 `src/shared/permissions/`（决策 041）；接手时修正了上个代理搬家留下的测试 import 路径错误。
  - `f874bc19` build.yml gate 去掉 runtime / agent-host 的安装、类型检查与冒烟，编号改为 x/6；`verify-packaged-app` 新增 app.asar 反向检查（自解析 asar 头，新模块 `scripts/asar-inspect.mjs`）与 `out/main/index.js` 无 runtime 标记。
  - `30245837` `THIRD_PARTY_NOTICES.md`：不再写随包 Pi SDK 与 CLI，保留 vendored 解码代码的 pi-agent-core 0.84.4 MIT 声明，权限库路径改为 `src/shared/permissions/`；两个校验脚本的必需字符串同步。用户 10-03 过目同意。
  - 代理自测（最终代码 `f874bc19`）：三套 tsc、lint；全量单测分四批 9621 例全过（跳过 46 例：未开环境变量的集成 35、win32 专用 11）；Static 756 例、`src/shared/__tests__` 402 例、scripts 208 例；bridge-smoke 66 项（R10 确认）；`--check` 28 个场景 0 差异；集成 35/35；宿主产物 82.6 MiB、L1 44 项。编排者复跑三套 tsc 与 Static / Scan / Wiring。打包产物检查与 `dsh-bridge-gate` 的 `--frozen-lockfile` 交 CI。
- 2026-10-01 P1-12 第 2 步（[决策 147](decisions/147-p1-12-retire-runtime.md) 第二节「第 2 步 A / B」，待审批），只加测试、不删文件：
  - `68f6fccd` 权限用例：原 runtime 的 126 例 A 类权限用例，108 例改为直接测纯权限库（shared 64 例，需要 bash 语法树的 44 例进 dsh-host），8 例由现有 bridge 测试与 perm-* 录制覆盖，10 例 N/A（`BASH_ENV`、委派定义声明的档位、runtime 自己的工具表裁剪 / trace / 预览截断、MCP）；迁移的期望值一条没改，纯库上全过，没有判定差异。逐条映射表见 [p1-12-permission-case-map.md](evidence/p1-12-permission-case-map.md)。拆图 / drain 两例与 skills 4 例没按派工示例判 N/A 而是照迁（DSH 下同样存在），编排者认可。
  - `9061fc26` 解码链与只读回放：`sessionCodec`、`piSessionTimeline`、`piSessionTree` 三份测试（22 / 15 / 6 例）搬进 `shared/legacyPiSession/__tests__/`，用例与期望未改；`sessionReplayReader.test` 改为逐份读 legacy-pi 语料并与金样本 `history` 对拍（39 例），不再依赖 runtime。shared 与原实现没有结果差异。
  - 编排者复跑：四套 tsc；`src/shared/permissions src/dsh-host/permissions` 538 例（1 例原有跳过）；`src/shared/legacyPiSession src/main/services/chat` 402 例；Static 769 例；提交后 `src/shared/__tests__` 396 例。代理自测 `src/runtime` 1235 例与三份原解码测试仍全绿。
- 2026-10-01 P1-12 第 1 步整包 CI：`1.1.0-dsh.3` 的 `build.yml`（run 36895051539，提交 `13bc19f5`）全部 job 通过，gate、Windows / Linux / macOS 整包与打包验证都绿。Windows、Linux 的「Verify packaged app」都报「no native worker」，L1 通过，Windows 带空格路径冒烟 44 项通过；Windows 宿主产物 85.1 MiB、Linux 82.6 MiB。安装包变小（Actions artifact 压缩后大小，对比 `1.1.0-dsh.2` 的 run 36651305647）：Windows 安装包 209.7 → 197.8 MB，Windows 解包目录 303.9 → 288.1 MB，Linux 包 204.8 → 196.6 MB，macOS 包 459.2 → 435.9 MB。只作 Actions artifact，不建 Release；自动更新 `allowPrerelease = false`，现有 1.0.x 用户收不到。
- 2026-10-01 P1-12 第 1 步 `ca6cd1a9`（[决策 147](decisions/147-p1-12-retire-runtime.md) 第二节 13 条，待审批）：产品与安装包不再依赖旧 native worker。首屏「对话引擎是否可用」改查 DSH 宿主产物（与宿主启动共用 `resolveDshHostLayout`，开发机缺随包 node 时会进「不可用」）；权限页随包层改由内存策略表生成（`bundledPolicyScope()`，宿主与 Main 共用），不再读 agent-host 产物的 `config.json`，该层不显示路径与打开按钮；删除 `PiWorkerProcess`、`PiUtilityService`、`PiImportProcess`、`NativeSessionIndexAdapter`、子 Agent 管理页及其 IPC、依赖旧 worker 的探针与打包脚本（98 个文件，删约 1.29 万行）；打包不再构建、拷贝 `resources/agent-host`，`verify-packaged-app` 新增「包里有 `resources/agent-host` 即失败」，`build.yml` 三个打包 job 去掉 agent-host / runtime 依赖安装与 worker 构建，Linux 验证去掉 `xvfb-run`；新增 `runtimeRetiredStatic` 静态测试。`src/runtime`、`src/agent-host` 源码与 gate 的 `typecheck:runtime` / `smoke:runtime` 留到第 3 步。编排器复跑：四套 tsc；Main / preload 1658 例、渲染层 5325 例、shared / dsh-host / scripts 2315 例、Static 769 例、集成 35/35、bridge-smoke 66 项、`--check` 28 个场景无差异、宿主产物 82.6 MiB、L1 44 项；提交后 `src/shared/__tests__` 396 例。整包 GUI 未跑：打包版首屏、权限页随包行、Windows 覆盖安装不残留 `agent-host` 目录，留到 P1-14 整包点验。
- 2026-09-30 真实网关验证的后续修复 `c0d06299`（[决策 146](decisions/146-real-gateway-followups.md)，待审批，重点第 2、3、9、15、19 条）：网关明确无上游的 503 不再自动重试（新码 `GATEWAY_NO_UPSTREAM`）；`maxTokens` 超过窗口一半时夹到 1/4（Grok 4.7 / 4.6 由 500000 改为 125000，重录 Main 计划快照）；首字前被停的一轮直播即显示「已停止」，重开不重复（GW-18）；Git 面板「不是 Git 仓库」时每 5 s 重查；代码审查标题自动模式显示「(自动)」。GW-16 `cache_limit`：我们的请求最多 3 个 `cache_control`，推断是网关自己的校验，随 R9 一并问网关管理员。用户裁决：GW-1 是网关上游问题，不改客户端；worktree 先留着。编排器复跑：四套 tsc；渲染层 5319 例、Main 1752 例、shared / dsh-host / scripts 2340 例、Static 762 例、集成 35/35、`--check` 无差异。
- 2026-09-30 P1-5 真实网关验证 R1～R10（Linux 开发机，用户亲自登录公司账号；证据 [p1-5-real-gateway-2026-09-30.md](evidence/p1-5-real-gateway-2026-09-30.md)，50 次请求，约 $1.44）：
  - R1 目录 13 个模型、4 个 provider、三种协议，菜单与计划一致；R3 工具回合、R4 档位（日志里 `reasoningEffort` 全部与所选一致）、R5 跨协议换模型、R6 读图、R7 三种一次性补全与评审中途停止都通过。
  - R2：China 组 GLM 5.3、DeepSeek V4 Flash / Pro 网关 503 `no_available_providers`（GW-1，待网关确认）。R8 只验了登出（宿主 318 ms 关停、凭据库清空），「在飞的回合被登出打断」待用户重新登录后补验。R9 说明已交用户转达。R10 按形状扫描，凭据库以外零命中。
  - 待定问题：503 被自动重试 3 次（GW-2）；GPT 间歇断连（GW-3）；Grok 4.7 的 `maxTokens` 等于上下文窗口，自动压缩算不出预算（GW-4）；UA 待网关答复（GW-5）；代码评审标题「代码审查()」空括号（GW-6）；「新建 worktree」对话框没挂在任何界面上，main 同样如此（GW-7）；`git init` 后 Git 面板不刷新（GW-8）。
  - 逐项 JSON 与请求台账含网关原始错误体，只留本地（主检出 `contextFX/`）。
- 2026-09-30 P1-7e 点验问题修复五组全部落地（分组见 [topics/p1-7e-pointcheck-fixes.md](topics/p1-7e-pointcheck-fixes.md)；决策 138～144 待审批，其中 138 第 21 条用户选丙，140 的问题 31 与 143 的问题 30 用户按建议裁决）：
  - e1 侧栏 `47eb2d36`（决策 137、138）；e2a 时间线与会话 `e482d3ce`（139）；e2b 失败注记、Stop 保留输出、`/compact` 摘要、网关流闸门与参数不兼容错误卡 `e35bbee2`（140）；e3 浮窗、终端、toast、对比度与 e5 插件自动重启、旧资产提示、会话授权活动行、图片上限 `0f04c61c`（142、143）；e4 文案与问答卡 `6fc05ddb`（144）。
  - 另：P1-13d 复核修复 `70956bf7`；`encryptedRead/` 纳入宿主 tsc `51ed11de`；模型计划对只支持 adaptive 的模型不下发 off `1c3f9fc9`（141）；旧会话投影金样本补 `failure` `7ec5ba47`。
  - 编排器复跑（`6fc05ddb` 前后）：四套 tsc；渲染层全部 316 个文件、5275 例；Main 与 preload 1750 例；dsh-host、shared、scripts 2339 例；Static / Scan / Wiring 752 例；集成 35/35；bridge-smoke 66 项；`--check` 28 个场景无差异。
  - 下一步：只对改过的项目再点验一遍（GUI），然后与用户一起做真实网关 R1～R10。
- 2026-09-30 用户在 1.0.4 上遇到两个真实网关错误（Claude Opus 5.5），只读调查结论：
  - 压缩报 `"thinking.type.disabled" is not supported for this model`：1.0.4 的手动 `/compact` 不带思考档位，pi-ai 对 anthropic 行发 `thinking:{type:"disabled"}`，只支持 adaptive 的模型拒收。DSH 分支按现有模型计划不会触发；[决策 141](decisions/141-model-plan-adaptive-thinking-hardening.md)（`1c3f9fc9`）再把两种少见配置也堵上。1.0.x 不出修复版（用户没要），临时办法是 models.json 该行加 `"thinkingLevelMap": {"off": null}` 与 `"compat": {"forceAdaptiveThinking": true}`。
  - `stream_gate_precommit` / `prebuffer_overflow`：公司网关（luban）的流闸门，缓冲约 10 KiB 仍等不到可提交的帧就中断；Opus 开头是长思考，同一请求重试基本必然失败。给网关管理员的说明已交用户转发。客户端归类（不自动重试、专门卡片）并入 e2b（决策 140）。
- 2026-09-30 P1-7d GUI 点验三批做完（开发机 Linux，隔离 HOME、本地假网关、CDP 驱动；证据 [p1-7d-gui-2026-09-30.md](evidence/p1-7d-gui-2026-09-30.md)，提交 `bd1b9daf`、`9692c532`、`963bd44d`）：
  - 共 50 项：35 项符合，11 项有出入，3 项不符合，1 项只做了一部分。不符合的三项：A3 回退后提示没回到输入框；A4 新建分叉打开时时间线为空；E6 右列终端 Ctrl+F 打不开搜索。
  - 另记问题 1～35，按五组修，见 [topics/p1-7e-pointcheck-fixes.md](topics/p1-7e-pointcheck-fixes.md)（P1-7e）；侧栏改版（决策 137）并入第一组。
  - F4、F5 的分叉是在应用停着时往旧文件末尾追加一问一答模拟的，不是回装 1.0.x；要 Windows 或真实网关的项目（清单 J 节）没做。
- 2026-09-29 Windows 打包冒烟 L1 三项失败修复 `6db5a949`、`4ba4992e`（取舍见[决策 134](decisions/134-windows-packaged-smoke-fixes.md)，待审批）：
  - **产品缺陷**：Windows 上工作区内的 read / grep / glob / pwsh 全都弹审批。根因经 CI 诊断证实：`%TEMP%` 是 8.3 短名时，闸门的工作区用 JS 版 `realpathSync`（保留短名），目标用 `fs/promises` 的 `realpath`（libuv，展开成长名），两边对不上。工作区、spill 根、附件根改用 `realpathSync.native`；闸门新增 `cwdAliases`，会话打开时的写法也算工作区，经链接逃出工作区的仍按规范写法询问。Linux 上同类缺陷（accept-edits 下按链接写法写操作数的 shell 命令会弹卡）一并修掉。
  - **冒烟盲区**：DSH 在 Windows 上经 `dsh-subprocess-local` 的 Job runner（node.exe）拉起 rg 与 pwsh，冒烟改为拆开派生链再判 rg 来自产物。
  - **探针问题**：旧探针同时带 `--import` 与 `--input-type`，node-pty 的 worker 线程继承后直接退出；另外 Windows 上终端自然退出后要再 `kill()` 才释放输出 worker。宿主里目前没有调用 node-pty 的地方，产品不受影响；将来启用要先补「退出后释放」（决策 134 规则 15）。
  - 新增只打包宿主的 Windows 冒烟工作流 `dsh-host-windows-smoke.yml`（推到 `ci/dsh-host-windows-smoke` 触发）与诊断脚本；第二轮 Windows 44 项全过。
  - 编排器复跑：四套 tsc；permissions、dsh-host、scripts 50 个文件、1157 例；Static / Scan / Wiring 74 个文件、743 例；`src/shared/__tests__`；集成 35/35；bridge-smoke 66 项；`--check` 无差异；L1 44 项。
- 2026-09-29 `.gitattributes` 把 `.yml` / `.yaml` 检出固定为 LF `6e5ccea0`（P1-13c 在 `core.autocrlf=true` 的 Windows 机器上发现 `cordis.patch.yml` 检出成 CRLF，宿主静态测试失败）。
- 2026-09-29 P1-13c Windows 加密文件读回退合入 `f84f7bbd`（Windows 端在加密机上开发，分支 `feat/dsh-p1-13c` 的 `801cac53`；取舍见[决策 091](decisions/091-p1-13c-windows-read-fallback.md)，待审批，**请重点看 §2 的 edit 不做明文编辑**）：
  - 新增宿主行 `aiclient-encrypted-read`，只在 Windows 上包装 fs 服务的四个读入口与 `editText`；读普通文件的额外开销只是读开头 16 字节。
  - 开头是 TSD 头时经 PowerShell 5.1 回读（绝对路径、`-EncodedCommand`、路径走环境变量、10 秒超时、并发 2、明文上限 32 MiB）；读出仍是密文或失败就报 `FS_ENCRYPTED`，密文不交给模型。
  - 加密机实测：真实加密的 `.yml` 经 `read` 174 ms 读回明文；六类可解密类型每次 137～141 ms。证据：[p1-13c-windows-read-fallback-2026-09-29.md](evidence/p1-13c-windows-read-fallback-2026-09-29.md)。
  - 合并冲突三处（行登记与静态测试），都保留两边；合并后 Linux 全套复跑通过（四套 tsc、相关单测与全仓扫描、集成 35/35、bridge-smoke 66 项、`--check` 无差异、L1 44 项）。
  - Windows 端的环境观察（范围外）：C 盘 corepack 缓存目录下 node 打不开 `.js`，pnpm 崩溃，用 `COREPACK_HOME` 绕开；策略会延迟加密 node 写入的 `.ts` / `.js`，对其他开发工具链可能有影响。
- 2026-09-29 P1-4e 录制门禁进 CI `16e94be8`（取舍见[决策 133](decisions/133-p1-4e-gate-ci-choices.md)，待审批，**请重点看第 13、16、17 条**：根依赖用 `--ignore-scripts` 安装、bridge-smoke 只在手动触发时跑且不阻断、超时取值是估算）：
  - `build.yml` 的 gate 加取随包 node 与 `bridge-record --check`；新增 `dsh-bridge-gate.yml`，push 到 `feat/dsh-*` 时跑宿主 tsc、录制检查、回放与投影测试。
  - 新增 `dshStreamReplay.test.ts`，28 个场景灌进真实 reducer 断言用户看到的内容；新增场景没写断言会失败。
  - `perm-restart` 原本依赖 DSH 200 ms 批量落盘的时序，改为强杀前调用 DSH 的 `sessions.flush`；编排者全量重录，只有这一场景三份金样本变化。
  - 新增 [p1-7d-gui-pointcheck.md](topics/p1-7d-gui-pointcheck.md) 点验清单。
  - 编排器复跑：四套 tsc；渲染层 stores 与投影 43 个文件、916 例；Static / Scan / Wiring、`src/shared/__tests__`、scripts、dsh-host 全过；集成 35/35；bridge-smoke 66 项；`--check` 无差异。
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

1. **等用户**：同意推送；审批 [decision-review-4.md](decision-review-4.md)，拍板[决策 157](decisions/157-outbound-proxy.md)。
2. **推送准备**（用户同意后）：先单独一个 `chore` 提交把版本升到 `1.1.0-dsh.5`，再推送，并手动触发 `build.yml`。
3. **CI 首跑回看**：整包 `build.yml`；`dsh-bridge-gate.yml` 的防空转冒烟、争用回归（看 LC-2 是否抖动）、插件审查守卫；超时按实测重算。
4. **GUI 复点验**：按 Next Target 第 3 项的清单，一次一批。
5. **Windows 测试版实测与 P1-13 第二轮上机**：等测试包；第二轮上机手册要先写。

本地遗留（用户决定）：`.gitignore` 的 `out-agent-host/` 与 `biome.json` 的对应忽略、本机 132 MB 的旧 `out-agent-host/` 产物；根目录 npm 旧锁文件 `package-lock.json` 仍列着 pi-coding-agent（pnpm 不读，只在发版时同步版本号）。

## Blocked By

- **推送**：用户 10-07 决定暂不推送。整包 CI、`dsh-bridge-gate.yml` 新三步的首跑、Windows 测试版，都等用户同意推送（推送前先升版本，决策 132、149 第 1 条）。
- **审批**：131～156 中 23 份决策待审批，157 待拍板（[decision-review-4.md](decision-review-4.md)）。
- **GUI 复点验**：本机 2 核 / 3.3 GB，起 Electron 不能与全量测试同时跑；本机不跑整包构建。
- **Windows**：W1～W12、Windows 杀宿主、覆盖安装，都要测试包和 Windows 机器。
- **P1-5**：R8 完整回合要用户在开发版里重新登录公司账号；R9 等网关管理员答复（GW-5、GW-16、GW-17）。
- **P1-9**：真实数据离线迁移测试要用户指定机器与 profile 副本，由用户本人运行，或授权代理运行且只看报告。
- **P1-13**：第二轮上机要用户在加密机上执行，上机手册待写。

## Last Verified

- 2026-10-07：各项都只跑了定向验证，结果写在 Last Landed 各条里。最近一次全量单测是 P1-12 第 4 步之后，编排者按目录分批跑，9624 例全过（跳过 46 例）。P1-5d 到界面小修这批改动的收口全量单测：编排者在 `0b3eb7d6`（之后只有文档提交）上按目录分批跑，渲染层 322 个文件 5336 例、Main / preload / shared 203 个文件 3389 例（跳过 35）、dsh-host 与 scripts 54 个文件 992 例（跳过 11）、`src/__tests__` 2 例，共 9719 例全过；Static / Scan / Wiring 75 个文件 764 例全过；两套 tsc 通过。
- 最近一次整包 CI：`1.1.0-dsh.4` 的 run 37170324111（`f847f66d`，2026-10-04），全部 job 通过。P1-12 第 4 步及之后的改动没有经过整包 CI。
- 最近一次 `dsh-bridge-gate.yml`：随 2026-10-03 的推送，`--frozen-lockfile` 通过。P1-8c 新加的三步还没在 CI 上跑过。

更早的记录（原文）：
- 2026-09-27 P1-1 GUI 点验（Linux 开发机，`100ebcf1`，临时 HOME、本地假网关，11 次请求都带假 key）：新建会话走 DSH ✅，恢复与崩溃重启 ✅，旧会话只读 ⚠️（草稿丢失），拒绝路径 ✅ / ⚠️（带图时草稿丢失），`session_locked` 未能取证。
- 2026-09-26 P1-1（Linux 开发机，内容同 `100ebcf1`）：四套 tsc 全部退出 0；相关单测 65 个文件、1043 例，加上渲染层 165 个文件、3201 例，全部通过；bridge-smoke 18 项判定全部为真。全量 Vitest 与 GUI 未跑，GUI 点验进行中。
- 2026-09-26 P1-0（Linux 开发机，`30a0c257`）：四套 tsc 全部退出 0；`src/main/services/agent-host/` 与 worker RPC 类型相关单测 19 个文件、314 例全过；`bridge-smoke.ts` 6 项判定全部为真。全量 Vitest 与 GUI 未跑。

## 历史：旧 Next Target 与 Active TODO（已过期，保留原文）

以下是 2026-09-29 晚、2026-09-28 晚的 Next Target，以及 2026-10-07 文档收口之前的 Active TODO 原文，只作历史；当前状态以上文为准。原文里已明显过期的说法就地加了注；原来的 Blocked By（「P1-7a 等原型」「P1-11 等 Q003」「P1-13b 等上机」等）都已解决，已删去，见 git 历史。

### 2026-09-29 晚的 Next Target（第三批已裁决，五项授权动作全部批准）

- **已裁决**：第三批决策 111～129 由用户裁决（[决策 130](decisions/130-user-rulings-2026-09-29-batch3.md)）：没点名的按建议批准；120 第 27 条与 123 分叉标题已由[决策 131](decisions/131-plugin-row-titles-and-fork-title-choices.md) 做完（`740a45b1`，第 7、15、17 条待审批）。
- **已授权，按顺序做**（决策 130 补充裁决，一次只做一件重活）：
  1. 推送分支，并推一份到 `ci/dsh-p1-6d-windows` 跑 S18 两路；手动触发 `build.yml` 在 CI 上整包构建并跑打包冒烟 L1（本机不跑整包构建）；
  2. ✅ P1-4e 录制门禁进 CI（`16e94be8`，决策 133 待审批）；
  3. ✅ P1-7d GUI 点验三批做完（50 项）；✅ 修复五组（P1-7e）全部落地，下一步复点验改过的项目。真实网关 R1～R10 放到 P1-7e 之后，要用户在开发版里登录公司账号，编排者不经手凭据；
  4. P1-12 删除自有 runtime，前提是 Windows CI 与 P1-7d 都通过。2026-10-01 进行中：方案 [topics/p1-12-retire-runtime.md](topics/p1-12-retire-runtime.md)，用户裁决见[决策 147](decisions/147-p1-12-retire-runtime.md)（先做第 1～3 步，Windows 整包 CI 通过后再做第 4 步）；✅ 第 1 步 `ca6cd1a9`，`1.1.0-dsh.3` 整包 `build.yml`（run 36895051539）全部 job 通过；✅ 第 2 步 `68f6fccd`、`9061fc26`；✅ 第 3 步 `fe4b9b7e`～`30245837`（10-03，`1.1.0-dsh.4` 整包 CI run 37170324111 全部 job 通过）；✅ 第 4 步 `3d679576`～`4db4376a`（10-07，`src/agent-host` 删除、内部改名）。**P1-12 已于 10-07 收口**；用户决定不单独推送，第 4 步的整包 CI 随 P1-14 的下一次推送。
- **2026-09-29 第一次 Windows CI 结果**（推送 `a8cce6f2`）：
  - S18 两路（admin / 标准用户）全部通过；`build.yml` 的 gate（四套 tsc、lint、全量单测、runtime 冒烟）、Linux 整包构建与 L1 通过；macOS 是已知的 hdiutil 问题（与本分支无关，决策 090 不做 macOS）。
  - **Windows 打包冒烟 L1 失败 3 项**（本分支第一次在 Windows 上跑打包宿主）：
    - `l1PilotWriteAskedReadRan`：工作区内的 read / grep / glob / pwsh 全都弹了审批。推断：闸门的 `cwd` 没有规范化，runner 的临时目录是 8.3 短名（`RUNNER~1`），目标路径经 `fs/promises` 的 `realpath` 展开成长名，于是判成「工作区外」；
    - `l1RipgrepFromArtifact`：宿主的 spawn 钩子在 Windows 上只记到一个 node.exe，pwsh 与 rg 都没记到，推断 DSH 在 Windows 上经 node 子进程派生工具；
    - `nativesPtyRan`：node-pty 的探针 `exitCode -1`、无输出，原因待查。
  - P1-13c 的 Windows 端在真 Windows 桌面机上跑 L1 基线，也是 `l1RipgrepFromArtifact`、`nativesPtyRan` 两项失败（那时还没有 `l1PilotWriteAskedReadRan`），说明这两项不是 CI 环境特有。
  - ✅ 已修（决策 134，`6db5a949`、`4ba4992e`）：只打包宿主的 Windows 冒烟第二轮 44 项全过；版本升到 `1.1.0-dsh.2` 后整包 `build.yml`（run 36651305647，提交 `a3a25495`）全部 job 通过：gate（含全量单测与录制检查）、Windows / Linux / macOS 整包与打包冒烟、远程 runtime；产物只作 Actions artifact，不建 Release。
- 录制门禁 `dsh-bridge-gate.yml` 第一次在 CI 上跑就通过，整个 job 约 2 分钟，28 个场景 0 差异。
- ✅ P1-13c 已合入 `f84f7bbd`（Windows 端 `801cac53`）。用户裁决（[决策 135](decisions/135-user-ruling-encrypted-edit.md)）：091 其余批准，§2「edit 不做明文编辑」推翻。
- **在等**：P1-13d（加密文件要能 edit），交 Windows 加密机上的会话做，从推送后的 `feat/dsh-p0-probe` 最新头开 `feat/dsh-p1-13d`，提示词见 [topics/p1-13d-encrypted-edit.md](topics/p1-13d-encrypted-edit.md)，实现取舍记决策 136（预留）。（**已过期**：P1-13d 已于 2026-09-30 合入 `30893b28`、`70956bf7`，见 roadmap P1-13 行）
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

### 2026-10-07 文档收口之前的 Active TODO

P1-12 已收口（10-07）。用户 10-07 决定暂不推送打包，先做 P1-14 之前本机能做的剩余工作，清单与顺序见 [topics/pre-p1-14-remaining-2026-10-07.md](topics/pre-p1-14-remaining-2026-10-07.md)：P1-5d → P1-5e → E8 → P1-3e → P1-8c 工作流 → 界面小修 → 文档收口（用户裁决见[决策 149](decisions/149-user-rulings-2026-10-07.md)）。✅ P1-5d `031c10f9`。用户 10-07 问到「管理员 key」后，P1-5e 是否推到合入后待用户回复，✅ E8 `35af10ab`，缓解方案（决策 150 第 2 节 A～E）待用户拍板。用户裁决 E8 选 A、P1-5e 现在做（决策 149 第 4、5 条），顺序改为 P1-3e → P1-5e → E8-A → P1-8c → 界面小修 → 文档收口。✅ P1-3e `16cd195e`，实测发现两条待用户定。✅ P1-5e `4bd31a2c`。✅ E8-A `350aa1b1`。用户裁决决策 151 / 152 的四条（决策 149 第 6～9 条）。✅ P1-8c `9748ddef`（工作流随下一次推送生效）。用户裁决界面三条与决策 153（决策 149 第 10～13 条）。✅ 阶梯 B 甲方案 `4ebcfe5a`。10-07 派界面小修。下一次推送前先升版本到 `1.1.0-dsh.5`。

本地遗留（用户决定）：`.gitignore` 的 `out-agent-host/` 与 `biome.json` 的对应忽略、本机 132 MB 的旧 `out-agent-host/` 产物；根目录 npm 旧锁文件 `package-lock.json` 仍列着 pi-coding-agent（pnpm 不读，只在发版时同步版本号）。

待用户处理：
1. 真实网关 R1～R10 已授权（决策 130），到时要用户在开发版里登录公司账号；真实数据离线迁移测试仍待授权。（**已过期**：R1～R10 已于 2026-09-30 做完，剩 R8 完整回合与 R9）
2. P1-13c 做完后，上加密机验证读回退。（**已过期**：P1-13c 已在加密机上实测通过，见决策 091 与 P1-13c 证据）
