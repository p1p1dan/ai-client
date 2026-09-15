# 批次 D 区域原文报告 · 现场口径复核（P4-6 与 F1～F7）

Role: evidence（raw area report）。区域：field-nodes。任务：T030（批次 D，审计覆盖补全，只读）。
基线 HEAD：`ebc82f16`。日期：2026-09-15。对应批评者缺口 9 的现场半边（[cross-and-critic.md](../../../runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md) 第 72 行）。

## 总评

这个区域的**代码侧站得住，口径侧有窟窿**。

我把 P4-6 验收表的十一行、现场缺陷表的 F1～F7（含 F2-a/b/c、F7a～F7f）、以及 GUI 树的 A/4、A/10、B/5、C/8、F/13、F/15 逐条拿到当前 HEAD 上核了一遍。**凡是「已修」「已实现」的，代码在 HEAD 上都还在，并且和文档描述的形状一致**——F4 的 3s→10s→30s 阶梯、两条各记各的预算、抖动只给限流、`Retry-After` 优先且封顶 30 秒；F2-b 的启动 sweep 与退出 wipe 两个调用点；F2-a 的两处临时根读同一个设置口；F2-c 的 `WORKER_WORKSPACE_MISSING` 有真实生产者；F5 的 ask 工具整链（含 abort 与 drain 两条结算出口）；F7a/c 的倒计时从 `timeoutMs` 一路接到卡片；F7b 全仓只剩一处状态行；F7f 的八行上限；F1 的 Field 根上下文修复连同挂载用例；F/13 的轮询 hook 仍被 `LeftNav` 调用。这一轮**没有查到任何一条「文档说修了、代码其实没修」**。

问题全在另一面：**现场结论被写成了比证据更强的样子，而唯一一次上机就要按这些文字去排**。最要命的一条是「加密载体对照」——看板写「test.12 R2/R3 都读到明文……放行规则不再作为待查项」，而同一份现场记录白纸黑字写着「不签原定 R2/R3」「不能据此拍板放行按路径/签名/父进程」「D1/F3 仍待真实加密样本与有效无 Bash 探针」。R2/R3 恰恰是 F3（GUI 起的 git 子进程输出丢失）三个修法选项之间唯一的判别器。按现在的看板口径，最后一次上机不会再安排这条探针，F3 也就永远收不了口。与之配套的 D1 决策文档则停在另一个极端：状态仍是「待现场数据拍板」，R0～R4 的「现场结果」栏五个格子全是空的 ⬜，等于把现场已经跑过并且已经证明**方法本身无效**的 R4 原样留给下一个人再跑一遍。

其次是**证据与代码之间的时间差**。F2-b/F4/PERM-1 三份开发机取证停在 `8b75b646`（2026-09-11），到 HEAD 隔了 89 个提交；F3/F13 那份停在 `69be67a9`，隔 94 个；Windows 现场两份分别隔 157 和 172 个。其间 `plugins/agent-loop/` 被动过 11 次（T006/T007/T011/T014/T017/T020/T034/T035 等），权限链被动过 10 次（含 T023 把权限卡文案整体改成结构化标识 + 渲染层查词典——perm1 证据里那张整屏读回的中文卡，今天已经不是同一段代码产生的了）。证据陈旧本身按规矩不立发现，但它决定了节点判定：这几条现在只能判 complete-with-gaps，且必须进批次 E 的检查单。

最后，「精确缺口」那一栏我逐条核过，**P4-6 表第 137 行「特定编码与真实二进制样本无完整现场结果」到今天仍然准确**——test.12 现场记录第 816、817 行原话就是「具体编码识别准确性未执行专门测试」「真实二进制样本未执行」，而 `src/main/services/git/encoding.ts`、`src/main/utils/tsdSafeRead.ts`、`src/main/services/git/` 三处自 test.12 以来**一次提交都没有过**，所以那句缺口描述既没有过期，也没有被悄悄修掉。

## 优点

- **F4 是这一批里质量最高的一条。** 声称的每一个细节都能在 `src/runtime/plugins/agent-loop/providerRetry.ts` 上逐行对上：阶梯写成显式常量而不是指数公式、两条预算各自计数、抖动只加在限流那条、`Retry-After` 上限 30 秒、退避中的 `sleep` 能被取消打断。证据文档本身也做对了一件别人常做错的事——判据同时看 trace 的 `provider_retry` 备注**和**假网关实到的请求次数，所以「记了日志但请求没发出去」这种假通过被堵死了。
- **F2-b 的取证方法是可以当模板的。** 要求里写明「不能凭 UI 消失推断文件被物理删除」，探针就每个时点从索引文件和目录两侧各读一份；还自曝了两个会让人读出假缺陷的坑（归档要点确认框、侧栏可见性不能用整屏 `innerText` 判断）。四条结论里有三条是反直觉的（关闭什么都不删、归档当场删、重启连锅端），正是这类结论最值得写下来。
- **F5 不是补一个工具，是补一条纵切。** `ask` 工具、`question.requested` 事件、`worker.question.respond`、`chat:respondQuestion`、`PendingQuestionDock` 五段都在 HEAD 上接着，而且 `questionPrompt.ts` 把「一次结算」这件事做干净了：abort 监听、`drain`、重复 `settle` 守卫三处齐全，宿主没有显示位时干脆不注册这个工具。
- **PERM-1 的探针自己纠过一次判据错误**（「节点从 DOM 消失」量的是卸载，不是关闭），并且把假阳性的成因写进了记录；这类「探针踩的坑」段落让后来人不用再踩一次。
- **F3 开发机取证顺带挖出了 `useFolderDiffStats.ts` 里的裸 NUL 字节**——那是让 grep 静默失明、从而把一个活着的 hook 读成死代码的陷阱。这条已经进了长期记忆。

## 弱点

- **同一个未知量在三份文档里有三种状态。** 看板 P4-6 表说放行规则已结案；看板现场缺陷表的 F3 行说根因与修法仍未拍板；D1 决策文档说「待现场数据拍板」且探针结果栏全空。三份都写着「按我做」。
- **现场表内部自相矛盾。** F7a/F7c 行的备注还写着「通用问答卡仍受 F5 限制」，而同一张表上面两行的 F5 已经是 🟢 已实现（2026-09-12）。
- **退役开关的清扫只做了文档与探针两处，上机日真正要执行的启动脚本没动。** `AICLIENT_RUNTIME_BACKEND` 在 `launch-native.ps1`、`launch-gui-a-e.ps1`、`gui-a-e-checklist.md`、`linux-side-punch-list.md` 四处还在，而且脚本会把自己刚设的值回显成 `backend=native`，长得像一条确认。
- **T032 的枚举比它自己的口号窄。** 口号是「合并旧树待现场项」，枚举只到 P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因；本区域十来条明写「未真机点验 / 未打包 / 加密机复测」的项一条都没进去。
- **PERM-1 探针的产物命名会覆盖历史。** T028 删掉 `PERM1_NATIVE` 之后，脚本只剩一套文件名，而那套名字正是证据 README 标为「legacy」的那五个文件。
- **F2-b 顺手记的一条用户可见异常（临时会话索引 `title` 为空）至今无人认领**：不在任何任务里，也没有用例。

## 节点判定

| 节点 | 判定 | 依据 |
|---|---|---|
| P4-6 | complete-with-gaps | 十一行验收项里，代码可核的部分在 HEAD 上都成立；第 137 行的精确缺口描述经核**仍然准确**（相关三处源码自 test.12 起零提交）。但第 136 行把被现场明确拒签的 R2/R3 写成了已得结论（field-01），配套的 D1 决策文档结果栏全空（field-02），现场启动口径还留着已删开关（field-04）。「包与载体」一行引用的 test.13 CI 停在 `c0ae2a34`，距 HEAD 144 个提交，其间打包门禁被 T009、T028 改过两次，那份绿灯已不覆盖当前门禁形状。 |
| F1 网络面板 | complete | `RemoteSettings.tsx` 四处 `<Field className="contents">` 仍在，`networkPanelMount.test.ts` 守卫仍在；现场 test.12 已通过。无残留。 |
| F2 临时会话恢复（含 F2-a/b/c） | complete-with-gaps | 代码三条全部成立：`ScratchWorkspaceService` 的启动 sweep（`src/main/ipc/index.ts:97`）与退出 wipe（`:147`）都有真实调用方；两处临时根读同一个 `readSettings()` 且键相同；`WORKER_WORKSPACE_MISSING` 有生产者并被渲染层映射成 `workspace_missing`。缺口是现场半边：F2-a/c 待新包复验、F2-b 自陈两条未测（第三个「删除」按钮真机、正常退出而非 kill 时的退出清理），外加无人认领的 `title` 为空。 |
| F3 GUI Git 输出丢失 | incomplete | 开发机三层取证「不复现」成立，确认为加密机专属；但根因与修法按设计仍未拍板，而拍板所依赖的 R2/R3 在两处被写成互相矛盾的状态（field-01、field-02）。兜底口径（选项 A：如实报 `output was lost`）在 `GitService.ts:48/348` 仍在。 |
| F4 重试 | complete-with-gaps | `providerRetry.ts` 与声称逐条对上（见「优点」）。缺口只在证据时效与现场：该证据停在 `8b75b646`，其后 `plugins/agent-loop/` 被改过 11 次；GUI 侧观感与加密机复测按设计未做。 |
| F5 通用问答 | complete-with-gaps | 整链在 HEAD 成立，`askQuestion.test.ts` 与 `pendingQuestionDock.test.ts` 两侧都有用例。缺口是「仅自动化测试，未真机点验」，且 F7a/c 行的备注还在替它说反话（field-03）。 |
| F6 对话修改审阅 | complete-with-gaps | `SessionReviewPanel.tsx` 与 `sessionReview.ts` 在 HEAD 接进 `WorkspaceShell`。缺口：只有本地真实应用验证、未打包；现场原诉求是左右双栏红绿对比，交付的是右侧审阅栏，属已记录的产品取舍而非未修。 |
| F7（a/b/c/d/e/f） | complete-with-gaps | F7b 全仓只剩 `ChatComposer.tsx:3063` 一处状态行；F7f 的 `max-h-48`（8 × 24px）与断言仍在 `middleColumnLayout.ts:611`；F7a/c 倒计时链完整（`chatSessions.ts:1159` 写 `permissionExpiresAt` → `QuestionCard.tsx:606` 读）。缺口：视觉口径未定、倒计时走到底只有单测、F7a/c 行的问答卡备注已过时（field-03）。 |
| GUI A/4 临时目录复用/创建/绑定 | complete-with-gaps | `chat.ts` 的 adopt / ensure / release 三条路与 scratch 服务对得上，`SCRATCH_ROOT_DIR = 'unbound-sessions'` 的「嵌一层以免两个功能互删」在 `tempWorkspaceRecovery.test.ts` 的 `rejects a nested grandchild` 有用例。缺口：加密机回归未做。 |
| GUI A/10 /new 继承 cwd | complete-with-gaps | 继承逻辑在 `chatSessionActions.ts:83-89`（找不到工作区时 `cwd` 为 null 而不是编一个）。缺口：原 TEMP /new 矩阵未完整补签，F2 恢复不等于 /new 全矩阵。 |
| GUI B/5 重试与异常恢复 | complete-with-gaps | 同 F4。 |
| GUI C/8 问答卡交互 | complete-with-gaps | 同 F5：渲染位与生产者都在，未真机点验、未打包。 |
| GUI F/13 目录行变更量 | complete-with-gaps | 接线在 HEAD：`useFolderDiffStats.ts` 的 `useFolderDiffStatsPolling` 由 `LeftNav.tsx:294` 调用（看板写的是 `:291`，已漂移 3 行，不单独立发现）。缺口：真实 busy 会话下数字出现并刷新的现场记录仍缺。 |
| GUI F/15 cwd 缺失与临时目录恢复 | complete-with-gaps | 同 F2：`workspace_missing` 链完整、`adoptTempWorkspace` 有用例。缺口：F2-a/c 待 test.13 之后的新包复验。 |

## 发现

### [field-01] low docs | P4-6 | docs/plantree/plans/runtime-evolution/README.md:136 | 看板把现场明确拒签的 R2/R3 写成载体对照结论，并据此宣告放行规则结案

DESC：P4-6 验收表「加密载体对照」一行写的是「test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项」。字面上「读到明文」不假，但它来自的那份现场记录在同一段里三次否定了这个读数的证明力：目标文件的读取结果**没有 TSD 容器头**，因此分不清「这本来就是明文文件」和「白名单进程透明解密」，现场明写「不签原定 R2/R3」。用户 2026-09-10 的确认覆盖的是「哪两个程序在白名单里」，不是「驱动按进程名、映像路径、签名还是父进程放行」——而后者才是 F3 三个修法选项（A 维持现状 / B 用随包 node 包一层 / C 走 Git Bash）之间唯一的判别器，`docs/plans/2026-09-09-gui-defect-decisions.md` 已经写明「F3 不单独设探针：R2/R3 的结果一到，F3 与 D1 一起拍板」。看板这一行把一个仍然开着的判别器写成了已关闭事项。本条为静态推断（需加密 Windows 才能真正验证放行规则），`static_inference = true`。

EVIDENCE：

```
docs/plantree/plans/runtime-evolution/README.md:136
| 加密载体对照 | test.11 已有真实密文三读取者差分；test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项 |
```

```
Windows-P4-6-evidence/test12-reverify.md:786
…这不是原定 R2 的“GUI bash 工具→随包 Node”链路，且复制同时改变目录与文件名，不能隔离重命名因素；作为预检保留，不签原定 R2/R3。

Windows-P4-6-evidence/test12-reverify.md:806
限制：目标当前读取结果无 TSD 头，不能区分明文文件与透明解密；R2/R3 不能据此拍板放行按路径/签名/父进程。R3 只改变文件名并保留目录，仍需真实加密容器才能作决策。

Windows-P4-6-evidence/test12-reverify.md:808
…D1/F3 仍待真实加密样本与有效无 Bash 探针。
```

SCENARIO：批次 E 是计划里明写的**最后一次上机**（「全部做完后再去现场实测一次，不再分轮上机」）。上机清单按 P4-6 表逐行排，读到第 136 行判定「加密载体对照」已完、放行规则不必再查，于是不会在受策略目录里准备一份**已确认带 `%TSD-Header-###%` 容器头**的样本去重跑 R2/R3。上机结束后，F3 的根因仍然未知，三个修法选项无法收敛，而 F3 的用户可见后果是加密机上 GUI 的 Git 面板分支/状态为空（`git:branch:list` 报 `output was lost`）——这条缺陷因此被带过整个发布窗口。

FIX：把第 136 行改写为两段：其一保留 test.11 的三读取者差分（那一次有真实密文样本，结论成立）；其二把 test.12 的 R2/R3 降级为「预检，未签收」，并引用 `test12-reverify.md:806` 的限制原文；其三把用户 2026-09-10 的确认限定为「Node 与 Git 在白名单内」，明确它不覆盖放行维度。同时在 T032 里新增一行「R2/R3 用真实加密容器重跑」。

### [field-02] low docs | P4-6 | docs/plans/2026-09-09-bash-carrier-decision.md:3 | D1 决策文档的现场结果栏全空，等于把已被证明无效的 R4 方法原样留给下一次上机

DESC：这份文档是 D1（bash 载体）与 F3 共用的判据来源，第 6 节「现场判定探针（数据一来即可拍板）」用一张表列了 R0～R4，每行最后一列叫「现场结果」。2026-09-09/10 的 Windows 现场**已经跑过这五条**并把结果记进了 `test12-reverify.md` 第 575～808 行：R0 只拿到 shell 自报并经 cygpath 转换的路径、进程映像未取证；R1 写读成功但文件是否处于加密态未证；R2/R3 不签；**R4 结果无效**——隔离环境下命令仍然执行成功，说明 harness 根本没让 worker 的 shell resolver 进入 `shell_unconfigured`。但决策文档一个字都没回填：状态行仍是「待现场数据拍板」，五个「现场结果」格子全是 ⬜。本条为静态推断（R4 的有效性要在 Windows 上才能最终确认），`static_inference = true`。

EVIDENCE：

```
docs/plans/2026-09-09-bash-carrier-decision.md:3
> 状态：**待现场数据拍板**（Linux 侧论证完成，判定探针已就绪）

docs/plans/2026-09-09-bash-carrier-decision.md:65-73
| R0 | 记录本次实际选中的 bash 路径… | 一个绝对路径 | 后续所有结论的前提；无此项则证据不成立 | ⬜ |
| R1 | 先用 GUI 的 write 工具写 `probe-a.txt`… | 明文 `hello-42` | **选 A 并锁定**，写入 ARD §8 | ⬜ |
| R2 | 在 bash 工具里调随包 node 读同一文件… | 明文 | 放行按**进程名/路径**、与父进程无关 → B 无效… | ⬜ |
| R3 | 把随包 `node.exe` 复制为 `bash-probe.exe` 后执行同一读操作 | 明文 | 按签名或按目录路径放行 → B 可行 | ⬜ |
| R4（可选，健壮性非决策项） | 临时把 Git 从 PATH 与默认目录移开后调用 bash 工具 | 报 `shell_unconfigured` 而非崩溃/挂起 | 确认无 bash 时的失败是干净的 | ⬜ |
```

```
Windows-P4-6-evidence/test12-reverify.md:808
R4 结果无效：隔离环境下命令仍执行成功，说明 harness 没有真正让 worker 的 shell resolver 进入 `shell_unconfigured`；不能据此签 R4。
```

SCENARIO：批次 E 的操作员打开这份文档准备上机项，看到五行全空，按表原样执行：R4 依旧用「临时把 Git 从 PATH 与默认目录移开」这一招，而这一招已经被证明在隔离 harness 下量不出东西（Git 仍能从默认安装目录被发现）；R0 被当成从没做过而重做，真正缺的那一半（bash 进程的 Windows 映像路径 / 父进程取证）没人补。结果是唯一一次上机把时间花在重复已知无效的方法上，D1 与 F3 仍然拍不了板。

FIX：回填五行的「现场结果」，逐行写清取到什么、为什么不作数；把 R4 的操作改成能真正逼出 `shell_unconfigured` 的做法（例如在受控环境里覆写 `resolveWorkerShell` 会查的全部候选路径，并对照 `src/runtime/host/shell.ts` 的查找顺序逐个排除），把 R2/R3 的前置条件补成「样本必须先用非白名单进程读出 `%TSD-Header-###%` 容器头才算受策略」，并把状态行从「待现场数据拍板」改成「部分回填，R2/R3/R4 待重跑」。

### [field-03] low docs | F5 / F7 / GUI C/8 | docs/plantree/plans/runtime-evolution/README.md:223 | 现场表 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾

DESC：现场缺陷表第 223 行 F7a/F7c（权限卡样式/尺寸）的「包 / 证据」列写着「不在 test.13；通用问答卡仍受 F5 限制」。这句话成立的时点是 2026-09-09——当时 `question.requested` 全仓没有生产者，问答卡弹不出来，所以它的样式/尺寸没法验。但同一张表第 221 行的 F5 已经是「🟢 已实现（2026-09-12，`4916a633`）」，`ask` 工具与 `PendingQuestionDock` 在 HEAD 上都在（`src/runtime/plugins/tools/index.ts:274`、`src/renderer/components/chat/ChatWorkspace.tsx:250`）。两行在同一张表上给出互斥的结论。

EVIDENCE：

```
docs/plantree/plans/runtime-evolution/README.md:221
| F5 通用问答缺生产者 | 🟢 已实现（2026-09-12，`4916a633`）。runtime `ask` 工具 → `question.requested` → … **仅自动化测试，未真机点验** |

docs/plantree/plans/runtime-evolution/README.md:223
| F7a/F7c 权限卡样式/尺寸 | 🟡 结构化权限链与重画本地真实应用可用；倒计时原未接通，已补 `baeff487` 并本地验证；视觉口径仍待定 | 不在 test.13；通用问答卡仍受 F5 限制 |
```

```
src/runtime/plugins/tools/index.ts:274
    if (this.config.ask) this.register(askTool(this.config.ask), 'read');

src/renderer/components/chat/ChatWorkspace.tsx:250
          <PendingQuestionDock sessionId={activeSessionId} />
```

SCENARIO：批次 E 排 F7a/F7c 的上机项时读到「通用问答卡仍受 F5 限制」，判定问答卡这一半没法验，只安排权限卡的样式复核。而 F5 行与 GUI C/8 行都写着「未真机点验」——问答卡的尺寸、字体、可作答交互因此在唯一一次上机中没有任何人负责，F7c 这条现场缺陷带着「一半未验」被签掉。

FIX：把第 223 行的该子句删掉，改为「问答卡已有生产者（F5，`4916a633`），F7c 的问答卡半边随 GUI C/8 一并在批次 E 点验」。

### [field-04] low docs | P4-6 | Windows-P4-6-evidence/launch-native.ps1:3 | 已删除的后端开关在现场启动脚本与清单里还剩四处，脚本还会把它回显成一条假确认

DESC：`AICLIENT_RUNTIME_BACKEND` 随 P6-5（2026-09-13）与旧引擎一起删除，设它不再有任何效果。审计 core-host-16 抓的是这件事的两处半边——`evidence/p4-6/README.md` 的交接清单（T027 已改写）与 `scripts/run-perm1-probe.mjs` 的死分支（T028 已删）。但**上机日真正要执行的那几个文件没进这条线**：两个 PowerShell 启动脚本、GUI A～E 现场清单的启动命令、Linux 侧交回清单的「启动与载体」行，四处都还在设这个变量；更麻烦的是两个脚本紧接着 `Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND …"`，把自己刚设的值回显出来，读起来像一条「已在 native 上」的确认。本条为静态推断（需 Windows 现场执行才能观察实际误导效果），`static_inference = true`。

EVIDENCE：

```
Windows-P4-6-evidence/launch-native.ps1:1-7
# AiClient test.11 native 启动脚本 —— 确保 AICLIENT_RUNTIME_BACKEND 真正进入 worker
$env:AICLIENT_RUNTIME_BACKEND   = 'native'
…
Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND agent=$env:AICLIENT_RUNTIME_AGENT_DIR trace=$env:AICLIENT_RUNTIME_TRACE_DIR"
```

另外三处：`Windows-P4-6-evidence/launch-gui-a-e.ps1:17` 与 `:22`；`Windows-P4-6-evidence/gui-a-e-checklist.md:12`；`Windows-P4-6-evidence/linux-side-punch-list.md:73`。对照已改写的口径：

```
docs/plantree/plans/runtime-evolution/evidence/p4-6/README.md（Windows 交接范围）
…以 worker trace 证据确认实际后端（`stamp.backend` 现恒为 `native`——`AICLIENT_RUNTIME_BACKEND` 已随 P6-5〔2026-09-13〕连同旧引擎一起删除，设置它不再有任何效果…），不能只看能否聊天（审计 core-host-16，T027 改写此行）。
```

SCENARIO：批次 E 的操作员按现场习惯执行 `. .\Windows-P4-6-evidence\launch-native.ps1` 起应用，屏幕打印 `backend=native`，据此在记录里写下「已确认 native 后端」。这一行完全由脚本自己的赋值决定，与实际 worker 无关；如果这次运行的载体形态与预期不符（例如 `node_source` 落到 `explicit` 而不是产品路径推导出的 `bundled`，test.12 的 electron-utility 那次正是 `explicit`），这条回显不会暴露任何异常，而现场记录会留下一条看起来已经取证过的结论。

FIX：四处一起改：两个 `.ps1` 删掉 `AICLIENT_RUNTIME_BACKEND` 赋值与回显，改成启动后从 `$env:AICLIENT_RUNTIME_TRACE_DIR\runs.jsonl` 读 `stamp.backend` / `carrier` / `node_exec_path` 三个字段并打印；`gui-a-e-checklist.md:12` 与 `linux-side-punch-list.md:73` 的启动命令同步删掉该变量，措辞对齐 `evidence/p4-6/README.md` 已改写的那句。

### [field-05] low docs | P4-6 / PERM-1 | docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:6 | PERM-1 证据的复现命令已失真，而 T032 要求的复跑会就地覆盖被标为 legacy 的历史证据

DESC：perm1 证据 README 第 6 行给的复现方式是两条命令（默认 legacy、`PERM1_NATIVE=1` 走 native），第 39 行把产物分成「`perm1-report.json`（legacy）」与「`perm1-native-report.json`（native）」。T028 已经把 `PERM1_NATIVE` 变体删掉——脚本自己的注释写明「P6-5 退役了另一个引擎和 `AICLIENT_RUNTIME_BACKEND`，那次改写是自认的空操作，两套文件名描述的是同一次运行」。于是脚本现在只有一套输出名：`perm1-report.json` 与 `perm1-{popup,auto-confirm,approval-surface,after-allow}.png`——正是 README 标注为 legacy 那一趟的五个文件。而 roadmap T032 明确要求「T001 后的 PERM-1 探针复跑（`scripts/run-perm1-probe.mjs`，需真实模型回合）」。

EVIDENCE：

```
docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:6
`node scripts/run-perm1-probe.mjs`（legacy 后端）与 `PERM1_NATIVE=1 node scripts/run-perm1-probe.mjs`（native 后端）。

docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:39
原始输出：[perm1-report.json](perm1-report.json)（legacy）、[perm1-native-report.json](perm1-native-report.json)（native）。
```

```
scripts/run-perm1-probe.mjs:43-51
 * T028 deleted the `PERM1_NATIVE=1` variant. … The old command line still works,
 * it just files under the one name now.
 */
const REPORT_NAME = 'perm1-report.json';
const SHOT_PREFIX = 'perm1';

scripts/run-perm1-probe.mjs:138
  const file = path.join(outDir, `${SHOT_PREFIX}-${name}.png`);
```

SCENARIO：批次 E 执行 T032 的 PERM-1 复跑，探针把新一次 native 运行的报告与四张截图写进 `evidence/p4-6/perm1/`，覆盖 `perm1-report.json`、`perm1-popup.png`、`perm1-auto-confirm.png`、`perm1-approval-surface.png`、`perm1-after-allow.png`。此后 README 第 39 行的对应关系反了：被标为「legacy」的文件里装的是一次 native 运行，而被标为 native 的 `perm1-native-*` 反倒是 2026-09-11 的旧记录，两份记录谁新谁旧从文件名上看不出来，只能翻 git 历史。

FIX：两件事。一是在 perm1/README 顶部加一段时点注记：legacy 后端与扩展 UI 审批弹窗已分别随 P6-5 与 T036 删除，本文第 16 行那张英文弹窗与第 104 行「是否接管它」的未决项都已失去对象，命令只剩一条。二是让探针按运行时间或提交短哈希落名（如 `perm1-report-<yyyymmdd>.json`），或把 2026-09-11 那两趟移进 `2026-09-11/` 子目录再复跑。

### [field-06] low contract-gap | P4-6 / F1～F7 | docs/plantree/plans/runtime-hardening/roadmap.md:107 | T032 声称合并旧树待现场项，枚举却漏掉本区域全部十余条

DESC：T032 的范围写的是「合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）」。括号里的枚举就是实际执行时会被照抄的清单，而本区域在看板上明写「未真机点验 / 未打包 / 加密机复测」的项，除了 F3 根因之外一条都不在其中：F4 的 GUI 观感与加密机复测、F5 与 GUI C/8 的问答卡真机、F6 的打包后回归、F7a/c 的视觉口径与倒计时走到底、F2-b 的第三个删除按钮与正常退出清理、GUI A/4 的加密机回归、GUI A/10 的 TEMP /new 矩阵、GUI F/13 的真实 busy 会话数字、GUI F/15 的 F2-a/c 新包复验、TUI-1 的真机点验。计划同时写明「全部做完后再去现场实测一次，不再分轮上机」，所以漏掉即等于不做。

EVIDENCE：

```
docs/plantree/plans/runtime-hardening/roadmap.md:107
| T032 | 上机检查单：合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）、T001 后的 PERM-1 探针复跑…与审计静态推断项… | 旧树第 11 批 + 审计 | 检查单每项有判据与取证方式 |
```

```
docs/plantree/plans/runtime-evolution/README.md:220（F4 行）
…**没在 GUI 里看一眼用户侧长什么样**…**没在加密 Windows 上复测**。

docs/plantree/plans/runtime-evolution/README.md:221（F5 行）
…**仅自动化测试，未真机点验**

docs/plantree/plans/runtime-evolution/README.md:194（GUI C/8 行）
…**未真机点验**，未打包。
```

SCENARIO：T032 的产出物是一张逐项带判据的检查单，写单子的人按 roadmap 的括号枚举展开。展开后这张单子里没有问答卡、没有 F4 的 GUI 观感、没有临时会话的第三个删除按钮。批次 E 按单子执行一遍并逐项取证入 evidence，上机结束、机器交还，而 P4-6 与 GUI 的 A/4、C/8、F/13、F/15 五行仍停在 🟡，没有任何一次现场能再补。

FIX：把本报告「上机检查单」一节的全部条目并入 T032 的范围列，并把 T032 的括号改成「见 batch-d-raw 各区域报告的检查单」，避免下一次再靠括号里的短枚举当唯一来源。

## 测试缺口

1. **正常退出（而非 kill）时的 scratch 退出清理没有端到端覆盖。** `ScratchWorkspaceService.test.ts` 直接调 `wipeAll()`，`agentHostCleanup.test.ts` 验的是 `cleanupWorkerManager` 内部的顺序（先 dispose worker 再 wipe），但「用户从界面正常退出 → `before-quit` → `cleanupWorkerManager` → 目录真的没了」这条链没有一条用例，也没有现场记录——F2-b 自陈那一轮用 `pkill` 停应用，只能证明「被杀掉时退出清理不跑」。
2. **临时会话索引 `title` 为空这条现场观察既无用例也无任务。** F2-b 记录里四条临时会话的索引行 `title` 全是 `""`；`SessionIndexService.ts:108` 建行时确实默认 `''`，自动标题走的是渲染层 `applyAutoSessionTitle` → `chat:renameSession` 这条独立路径。没有任何测试断言「临时会话发完第一句后索引行有标题」。
3. **权限卡倒计时走到底自动拒绝只有单测。** perm1 记录自陈「本轮在倒计时走完前就点了允许」，真实回合里 119 秒到点的那条路没有现场证据。
4. **F4 的真实 HTTP 四条路没有进 CI。** `providerRetry.test.ts` 钉的是分类与阶梯，真实 HTTP 那一趟是一次性探针（`scripts/run-f4-retry-probe.mjs`），其后 `plugins/agent-loop/` 改过 11 次，没有任何自动化回归会发现探针结论失效。
5. **F/13「真实 busy 会话下数字出现并刷新」无覆盖。** 轮询条件由 `folderDiffStats.test.ts` 的单测覆盖，但从 busy 会话到侧栏出现 `+N -M` 的那一段只在开发机手工驱动过一次，且当时工作区只有未跟踪文件，量到的是正确的 `null`。
6. **F3 的加密机行为没有任何可在普通机器上跑的替身。** `GitService` 的「输出丢失」兜底有 Q7 用例，但「Main 派生 git 拿到空 stdout」这一形态没有被 mock 成用例，导致这条路只能靠上机。

## 未经执行验证的声明

以下几条我只能静态判断，没有构造出触发路径，按规矩不立为发现：

- **「重启会把整个 scratch 根连锅端」在当前 HEAD 是否仍与 F2-b 实测一致**：`sweepScratchWorkspacesOnStartup()` 在 `src/main/ipc/index.ts:97` 是 fire-and-forget，而 `ensure()` 可能在同一轮启动里被更早调用。两者的先后在代码上没有显式序，我无法在不起应用的情况下判断是否存在「刚建的 scratch 目录被启动 sweep 抹掉」的窗口。
- **加密机上 `%TSD-Header-###%` 容器与 `isFileTsdEncrypted` 探针的实际命中率**：`tsdSafeRead.ts` 与 `git/encoding.ts` 自 test.12 以来零提交，逻辑读起来成立，但真实策略文件从未被现行证据覆盖。
- **F3 根因方向（加密驱动按调用方放行）是否成立**：ARD §8 记的「Main→PowerShell→git 正常」是支持性证据，但不排他；本轮无法在 Linux 上复现任何一半。
- **PERM-1 探针在英文界面下是否仍能命中触发器**：探针的选择器写死了 `/(执行|规划)\s·\s(每次询问|自动接受编辑|全自动)/`，而 T023 之后这些标签是 `t()` 查词典的结果（`PERMISSION_GEAR_LABELS` 现在是英文键）。词典里 `Execute`/`Plan`/`Ask every time` 等条目齐全，所以中文界面下仍匹配；英文界面或 `getDefaultLocale()` 返回非 zh 的机器上会匹配不到。我没有执行，不确定上机机器的语言设置。
- **test.13 CI 绿灯对当前打包门禁的覆盖度**：`c0ae2a34` 之后 `scripts/verify-packaged-app.mjs` 被 T009、T028 改过，逻辑上那份绿灯已不覆盖当前形状，但我没有触发构建去确认现在是否仍绿。

## 上机检查单

格式：项 / 判据 / 取证方式 / 目标环境。

| # | 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|---|
| 1 | R2/R3 用真实加密容器重跑 | 样本先被非白名单进程读出 `%TSD-Header-###%` 头；随包 node 与改名副本各读一次，明文/密文两态可区分 | 在受策略目录准备样本，先用非白名单进程读出容器头存证，再走 GUI bash 工具 → 随包 node 的真实链路 | encrypted |
| 2 | R0 bash 进程映像取证 | 拿到 Windows 映像绝对路径与父进程链，而不是 shell 自报的 MSYS 路径 | `Get-Process bash \| Select Path` + `wmic process get ParentProcessId`，与 `resolveWorkerShell` 的候选顺序对照 | windows |
| 3 | R4 有效的无 Bash 探针 | worker 的 shell resolver 真正落到 `shell_unconfigured`，且应用不崩不挂 | 覆写 `src/runtime/host/shell.ts` 会查的全部候选路径后调 bash 工具；现场记录必须写明覆盖了哪几个候选 | windows |
| 4 | F3 根因拍板 | 由 1～3 的结果唯一映射到 A / B / C 三个选项之一 | 结果回填 `docs/plans/2026-09-09-bash-carrier-decision.md` 第 6 节表并写结论 | encrypted |
| 5 | F4 加密机复测 | 503×2 后成功、持续 503 四次尝试 43 秒耗尽、429 听 `Retry-After`、退避中取消立即结束 | 复跑 `scripts/run-f4-retry-probe.mjs`（需 Node 24），trace 的 `provider_retry` 与假网关计数两侧都看 | encrypted |
| 6 | F4 的 GUI 观感 | 重试期间时间线出现重试提示；预算耗尽后错误卡文案完整可读、带网关原文 | 起 Electron + 假网关，走真实会话触发 | dev-box |
| 7 | F5 / GUI C/8 问答卡真机一圈 | 模型调 `ask` → 输入框上方出现可作答卡 → 选项与 Skip 各走一次 → 模型收到对应文本 | 真实模型回合，CDP 读回整张卡并截图 | real-model |
| 8 | F7a/F7c 视觉口径 | 权限卡与问答卡的尺寸、字号、间距按 `docs/design-system.md` 的 Token 分档复核，并留截图 | 真实回合触发两张卡后逐项比对 | dev-box |
| 9 | 权限卡倒计时到底 | 119 秒不响应后自动拒绝，卡片状态变为已拒绝，工具调用按拒绝结算 | 真实回合触发审批卡后不响应，等满倒计时 | real-model |
| 10 | PERM-1 探针复跑（T001 之后） | 七条判据全通过；卡片文案经词典（非硬编码）；触发器选择器能命中 | `node scripts/run-perm1-probe.mjs`；复跑前先按 field-05 处理产物命名 | real-model |
| 11 | F2-b 正常退出的 scratch 清理 | 从界面正常退出（非 kill）后，退出当次目录即被删；对照 kill 那次的差异 | 三时点各读一次索引与目录，沿用 `scripts/run-f2b-probe.mjs` 的两侧读法 | dev-box |
| 12 | F2-b 临时行第三个「删除」按钮 | 走 `temp:workspace:remove` 只删临时基目录的直接子目录，删不到 `unbound-sessions/` 下的 scratch 目录 | 真机点按，两侧读目录 | dev-box |
| 13 | 临时会话索引 `title` | 发完第一句后索引行 `title` 非空，与侧栏显示一致 | 直接读 `session-index.json`，不看界面 | dev-box |
| 14 | GUI A/4 加密机回归 | 临时目录复用/创建/绑定三条路在受策略目录下与开发机结果一致 | 按 F2-b 的三时点法在加密目录重跑 | encrypted |
| 15 | GUI A/10 TEMP /new 矩阵 | 从普通目录、TEMP 会话、无工作区三种起点各开 /new，cwd 继承结果逐格记录 | 真机点按，逐格记 | dev-box |
| 16 | GUI F/13 真实 busy 会话数字 | busy 会话所在目录行出现 `+N -M` 并随改动刷新；非 busy 目录不轮询 | 起一个会真的改文件的会话，观察侧栏并抓 IPC 调用次数 | real-model |
| 17 | GUI F/15 的 F2-a/c 新包复验 | 临时根改设置后两处解析一致；用户目录缺失时给 `workspace_missing` 而非裸 ENOENT | 新包上按现场清单复验 | windows |
| 18 | TUI-1 / H/20 真机一圈 | GUI 跑一回合 → `pi --session` 打开 → 在 TUI 里续聊 → 回 GUI 接得上；右上角 GUI/TUI 开关那一下也点一次 | 内嵌终端真开，前后各读一次会话文件 | dev-box |
| 19 | 加密域 GUI 读 / Edit 后一致性 | 受策略目录里 Read 得明文、Edit/Write 后 GUI·TUI·外部编辑器三者内容一致 | 在加密域目录做一次完整读写，三处各读一次 | encrypted |
| 20 | 特定编码与真实二进制样本 | GBK/UTF-16/带 BOM 各一份、真实二进制一份，Main diff 与编码判定逐样本记结果 | 准备四份样本后逐个在 Git 面板与编辑器打开 | encrypted |
| 21 | Electron utility 载体现行探针 | `carrier=electron-utility` 且 `node_source` 由产品路径推导（不是 `explicit`），六项工具断言全通过 | 沿用 `src/runtime/smoke/p1-utility-worker.ts`，host 配置改走产品路径推导，结果与 HEAD 版本戳绑定 | utility |
| 22 | 打包门禁 native-only 后的三平台绿灯 | 三平台 Verify packaged Pi worker 步骤成功，`stamp.backend=native`、`carrier=bundled-node`、权限审计行存在 | 推一次构建，收三份 `worker-smoke-*.json` | windows |
| 23 | F6 打包后回归 | 右侧审阅栏在安装包里记录 Edit/Write 修改，上限行为与本地一致 | 新包上开一个会改文件的会话 | windows |

## 读过的文件

计划与证据：
- `docs/plantree/plans/runtime-evolution/README.md`
- `docs/plantree/plans/runtime-evolution/topics/field-followups.md`
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/f2b/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/f4-retry/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/p4-6/ci-34424337205/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/f3-dev-probe/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md`
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md`
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/area-assessments.md`（core-host-16 段）
- `docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-low.md`（core-host-16 条）
- `docs/plantree/plans/runtime-hardening/roadmap.md`
- `docs/plans/2026-09-09-gui-defect-decisions.md`
- `docs/plans/2026-09-09-bash-carrier-decision.md`
- `Windows-P4-6-evidence/test12-reverify.md`
- `Windows-P4-6-evidence/gui-a-e-findings.md`
- `Windows-P4-6-evidence/encryption-special.md`
- `Windows-P4-6-evidence/environment.md`
- `Windows-P4-6-evidence/linux-side-punch-list.md`
- `Windows-P4-6-evidence/gui-a-e-checklist.md`（启动命令行）
- `Windows-P4-6-evidence/launch-native.ps1`
- `Windows-P4-6-evidence/launch-gui-a-e.ps1`

源码与脚本：
- `src/runtime/plugins/agent-loop/providerRetry.ts`
- `src/runtime/plugins/tools/ask.ts`
- `src/runtime/plugins/tools/index.ts`
- `src/runtime/worker/questionPrompt.ts`
- `src/runtime/worker/permissionPrompt.ts`
- `src/runtime/plugins/session/codec.ts`
- `src/runtime/flags.ts`
- `src/main/ipc/workerManager.ts`
- `src/main/ipc/index.ts`
- `src/main/ipc/chat.ts`
- `src/main/ipc/tempWorkspace.ts`
- `src/main/ipc/piTui.ts`
- `src/main/services/agent-host/ScratchWorkspaceService.ts`
- `src/main/services/agent-host/TempWorkspaceService.ts`
- `src/main/services/agent-host/PiWorkerProcess.ts`
- `src/main/services/chat/SessionIndexService.ts`
- `src/main/services/git/runtime.ts`
- `src/main/services/git/GitService.ts`
- `src/main/services/git/encoding.ts`
- `src/main/utils/tsdSafeRead.ts`
- `src/main/services/terminal/piTuiSession.ts`
- `src/shared/types/runtimePermission.ts`
- `src/shared/i18n.ts`
- `src/renderer/stores/chatSessions.ts`
- `src/renderer/stores/chatSessionActions.ts`
- `src/renderer/components/chat/QuestionCard.tsx`
- `src/renderer/components/chat/questionCardModel.ts`
- `src/renderer/components/chat/PendingQuestionDock.tsx`
- `src/renderer/components/chat/ChatWorkspace.tsx`
- `src/renderer/components/chat/ChatComposer.tsx`
- `src/renderer/components/chat/ComposerPermissionTrigger.tsx`
- `src/renderer/components/chat/historyError.ts`
- `src/renderer/components/chat/middleColumnLayout.ts`
- `src/renderer/components/settings/RemoteSettings.tsx`
- `src/renderer/components/workspace-shell/useFolderDiffStats.ts`
- `src/renderer/components/workspace-shell/LeftNav.tsx`
- `src/main/ipc/__tests__/tempWorkspaceRecovery.test.ts`
- `scripts/run-perm1-probe.mjs`
