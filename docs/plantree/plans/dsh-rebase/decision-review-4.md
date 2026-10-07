# DSH 二开：第四批待审批决策与需授权动作（131～157）

Role: review-summary。生成日期：2026-10-07。前三批已裁决：005～089 见[决策 090](decisions/090-user-rulings-2026-09-28.md)（[decision-review.md](decision-review.md)），091～108 见[决策 109](decisions/109-user-rulings-p1-7-prototype-2026-09-28.md)、[110](decisions/110-user-rulings-2026-09-28-batch2.md)（[decision-review-2.md](decision-review-2.md)），111～129 见[决策 130](decisions/130-user-rulings-2026-09-29-batch3.md)（[decision-review-3.md](decision-review-3.md)）。

## 这是什么

2026-09-29 到 2026-10-07 之间新产生的决策（编号 131～156），逐个打开文件核对过状态，仍标「待审批」的共 **23 份**；另附一份待拍板的[决策 157](decisions/157-outbound-proxy.md)（出站代理）。

- 不在本表的：[130](decisions/130-user-rulings-2026-09-29-batch3.md)、[135](decisions/135-user-ruling-encrypted-edit.md)、[137](decisions/137-user-ruling-sidebar-active-and-folders.md)、[149](decisions/149-user-rulings-2026-10-07.md) 是用户裁决，不用再批。
- 已经当面裁决过的条目，表里注明「已裁决」，不再列为待审批：138 第 21 条；140 问题 31；143 第 16 条（问题 30）；147 第一节；150 第 2、3 节；151 第 5 节第 2、4 条与 S6；152 第 4 条；153 第 5 节第 1 条与第 7 节；154 守卫去留。后五份的出处都是[决策 149](decisions/149-user-rulings-2026-10-07.md)。

这份文件只做索引和摘要，不改决策原文。每条都附原文链接。

## 怎么回复

前三次的惯例是「**没有点名的条目按建议批准**」。**这一次是否沿用这条惯例，请你先确认。** 如果沿用，可以这样回复：

> 沿用惯例，全部同意，除了：154 改成 `--runs 3`；157 选 C。

---

## 一、要你做选择的（有备选）

| 决策 | 要选什么 | 我方建议 |
|---|---|---|
| [157](decisions/157-outbound-proxy.md) 出站代理 | 模型请求要不要走代理：A 维持直连（与 1.0.x 相同）；B 跟随 DSH，按 shell 环境的 `HTTPS_PROXY` 走代理；C 接设置 · 网络的代理开关；D Main 本地反代（长期） | **A**；确认有人必须经代理才能连网关时再做 C。另请告知公司网络里有没有这种用户，以及设置页「通过代理路由所有网络请求」要不要改成如实的说法 |
| [154](decisions/154-p1-8c-ci-wiring-choices.md) §4 | 争用回归在 CI 上跑 1 次（`--runs 1`）还是 3 次 | 先 1 次，首跑几次绿之后再看；改 3 次的话 job 超时要从 40 调到约 50 分钟 |
| [146](decisions/146-real-gateway-followups.md) 第 27 条 | GW-16 `cache_limit`：要不要给 claude 路由设 `compat.supportsCacheControlOnTools: false`，把 `cache_control` 从 3 个降到 2 个 | 先不改，连同 GW-17 问网关管理员阈值与计数口径（R9） |
| [136](decisions/136-p1-13d-encrypted-edit-choices.md) 第 12 条 | 加密读写行的紧急开关 `AICLIENT_RUNTIME_ENCRYPTED_READ=0` 留不留 | 保留（照 `loopGuard` 的做法，平时不起作用） |
| [134](decisions/134-windows-packaged-smoke-fixes.md) 规则 3 遗留 | 工作区在 8.3 短名或符号链接下时，审批卡显示规范的绝对路径，要不要改回用户的写法 | 先不改，只影响显示 |
| [132](decisions/132-dsh-branch-test-build-version.md) | 测试包版本号 `1.1.0-dsh.N`（已用到 dsh.4，下一次 dsh.5，决策 149 第 1 条已按此执行）；正式合入后的版本号 | 测试包就用它；正式版本号到 P1-14 发版前再定 |
| [151](decisions/151-p1-3e-stuck-switch-choices.md) 第 6 条 | 卡死开关在应用里故意打不开，GUI 上看不到阶梯 B 的界面；要不要另做一个开发专用的触发方式 | 不做；阶梯 B 的界面由集成测试的事件序列兜底，P1-14 的 GUI 专项只做杀宿主 |
| [156](decisions/156-pre-merge-ui-fixes-choices.md)「疑点」 | ① 宿主崩溃与 `engine_restarted` 仍会把失败对话改成断开、抹掉失败卡与徽标（与决策 149 第 10 条同一原则，但不在清单内）；② 改名按 Enter 提交后焦点落到页面上；③ 添加仓库对话框的清除按钮没有读屏名称 | ① 建议合入前顺手修，改动牵动崩溃恢复路径，要你点头；②③ 小，可随 P1-14 一起修 |
| 盘点 (c) 类 | [Q002 / Q005](open-questions.md) 能否关闭：决策 084 第 4 条在加密机上实测沙箱开、关两组读写结果一样，但只测了管理员；Q010 已裁决「管理员即可」。本地遗留：`.gitignore` 的 `out-agent-host/` 与 `biome.json` 对应的忽略、本机 132 MB 旧产物、根目录 npm 旧锁文件 `package-lock.json` | Q002 关闭并维持决策 044「默认关」，Q005 由决策 045 承接后关闭；本地遗留在合入前一次清掉 |

---

## 二、建议重点看的（决策自己标了「请重点审批」，已裁决的去掉）

| 决策 | 一句话 | 请重点看 |
|---|---|---|
| [131](decisions/131-plugin-row-titles-and-fork-title-choices.md) | 插件工具行用插件自带标题（`presentCall`）；分叉旧会话迁移后用新发的第一条消息命名（`740a45b1`） | 第 7 条：标题整体替换「动词 + 参数」，不是「动词 + 标题」；第 15 条：过渡标题「原标题（1.0.x 分支）」按迁移时的界面语言存成字符串；第 17 条：取标题只看迁移后第一条消息，取不出就保留过渡标题 |
| [133](decisions/133-p1-4e-gate-ci-choices.md) | P1-4e 录制门禁进 CI：渲染层回放测试覆盖 28 个场景，`build.yml` gate 加录制检查，新增 `dsh-bridge-gate.yml`，`perm-restart` 改为强杀前先落盘（`16e94be8`） | 第 13 条：根依赖用 `--ignore-scripts` 安装（CI 首跑已通过，担心的风险没有出现）；第 16 条：bridge-smoke 只在手动触发时跑，不阻断；第 17 条：超时取值是估算（job 超时已由决策 154 改为 40 分钟） |
| [143](decisions/143-p1-7e-e5-choices.md) | P1-7e e5：插件开关后宿主自己重启、插件页跟随推送、旧资产提示补项目级、图片边长上限 8192（`0f04c61c`）。第 16 条已裁决 | 第 3 条：宿主没在运行时切换插件，不为此起宿主，页面显示「待重启生效」；第 7 条：两个源码扫描测试随接口扩展更新 |
| [144](decisions/144-p1-7e-e4-choices.md) | P1-7e e4 文案与问答卡：侧栏徽标中文化、设置「Pi」改「模型」、输入框占位、Stop 与跳过分开、多选逐行（`6fc05ddb`） | 第 2 条：侧栏徽标放大到 14 px；第 7 条：占位改「输入消息…」；第 11 条：审阅面板说明改写；第 20 条：两处按钮加 `normal-case`（设计规范豁免）；第 24 条：发给模型的问答格式不改 |
| [145](decisions/145-p1-7e-e6-choices.md) | P1-7e e6：改名框 Esc、新断开原因 `released`、失败状态不被放手抹掉、末尾卡片自己进视野、「查看更多（N）」、界面原语中文标签（`5e29f08d`） | 第 4、5 条：`released` 与「失败对话只解绑」（已由决策 149 第 10 条、156 扩到容量回收）；第 9 条：任何断开都清零「在跑」记录；第 11 条：已存的「(fork)」标题不迁移；第 13 条：侧栏统一「查看更多（N）」；第 19 条：`normal-case` 豁免又多三处 |
| [146](decisions/146-real-gateway-followups.md) | 真实网关验证的顺手修：网关明确无上游的 503 不重试、`maxTokens` 超过窗口一半夹到 1/4、首字前 Stop 立即显示「已停止」、Git 面板重查、代码审查标题（`c0d06299`） | 第 2、3 条：只认网关自己说的「无上游」标记，普通 5xx 照旧重试；第 9 条：夹到窗口 1/4 的规则；第 15 条：Git 面板「不是 Git 仓库」时每 5 s 重查；第 19 条：首字前普通 Stop 也直接显示「这一轮已停止」 |
| [147](decisions/147-p1-12-retire-runtime.md) 第二节 | P1-12 退役自有 runtime 四步的实现取舍（`ca6cd1a9`～`4db4376a`）。第一节是用户裁决 | 第 4 步「请用户过目」两点：日志前缀 `[pi-worker:` 改为 `[dsh-chat:`（查 1.0.x 日志仍要搜旧前缀）；AGENTS.md 模块表那一行整行改写。另外：第 1 步第 1 条，开发机缺随包 node 时首屏直接显示「对话引擎不可用」 |
| [148](decisions/148-p1-5d-protocol-narrowing-choices.md) | P1-5d 协议收口：新建服务只能选 DSH 支持的三种协议，预设去掉 google、mistral（`031c10f9`） | 第 3 节：已有服务用了不支持的协议时，选择框里钉住原值并加「（当前引擎不支持）」；第 2 节：预设在界面一侧过滤，不删共享列表 |
| [151](decisions/151-p1-3e-stuck-switch-choices.md) | P1-3e 探针卡死开关，S5 改用真实卡死（`4f461ece`）。第 5 节第 2、4 条与 S6 已裁决 | 第 1 条：卡点放在「工具执行不理会 abort」，不是方案原文的「审批处理器」（后者做不出卡死）；第 4 条：不再单独保留「IPC 丢消息」的阶梯 B 用例 |
| [153](decisions/153-e8-a-plugin-review-guard-choices.md) | E8-A 插件审查必拒三条与静态守卫（`350aa1b1`）。第 5 节第 1 条与第 7 节已裁决 | 「待用户审批」第 3 条：守卫没有豁免机制，将来审过的插件可能因依赖库里真实的全局写被拒；第 4 条：「出现」按代码里的使用判，注释与字符串不算（`cordis.original` 例外） |
| [155](decisions/155-ladder-b-dispose-others-first.md) | 阶梯 B 重启宿主前先并发关闭其他在忙的会话，按决策 149 第 6 条实现（`4ebcfe5a`） | 第 2 条：只关在忙的会话，空闲的与正在回退 / 分叉的不关；第 3 条：「重启引擎」卡片也先关（超出裁决字面）；第 5 条：被提前关的会话照旧收到「引擎已重启」失败卡，「继续」可用 |
| [156](decisions/156-pre-merge-ui-fixes-choices.md) | 合入前界面小修 13 项（`5d495e01`、`c568b989`、`e81ea90c`、`d01e8db4`） | 第 5 节（第 15 条）：表单类对话框打开时焦点落在第一个字段上；第 6 节（第 17 条）：Main 放弃重开的会话宣告 `released`，离开「正在活动」；第 12 节：失败回合以回放注记为准，改在渲染层、不动金样本 |

---

## 三、其余决策（没有单独标注，一句话结论）

| 决策 | 结论 |
|---|---|
| [132](decisions/132-dsh-branch-test-build-version.md) | 测试包版本号 `1.1.0-dsh.N`，见「一」 |
| [134](decisions/134-windows-packaged-smoke-fixes.md) | Windows 打包冒烟 L1 三项失败的修复：8.3 短名下工作区判定（产品缺陷，Linux 上同类缺陷一并修掉）、冒烟拆开 Job runner 派生链、node-pty 探针改用与宿主相同的启动方式（`6db5a949`、`4ba4992e`）；遗留一项见「一」 |
| [136](decisions/136-p1-13d-encrypted-edit-choices.md) | P1-13d 加密文件可以 edit：替换语义照 `dsh-fs-local`、加密路径先过沙箱围栏（`30893b28`、`70956bf7`）。编排者复核修复只在 Linux 验证，没有回加密机复测；开关去留见「一」 |
| [138](decisions/138-p1-7e-e1-sidebar-choices.md) | P1-7e e1 侧栏的实现细节（`47eb2d36`）。可感知的：所有分区的运行行改成转圈，行开始或结束运行时标题会左右移 6 px（第 2 条）；「最近」排序只按真实活动（第 7 条）。第 21 条已裁决（丙） |
| [139](decisions/139-p1-7e-e2a-timeline-sessions-choices.md) | P1-7e e2a（`e482d3ce`）：回退的提示递回输入框，已有草稿时接在后面空一行（第 2 条）；分叉打开时带上历史页；回合时钟按对话保存；草稿按对话保存、只在内存（第 17 条）；删除「缺 `piLeaf` 的旧行改成新会话」的修复路径，这类行改显示 `source_missing` 卡（第 23～25 条） |
| [140](decisions/140-p1-7e-e2b-choices.md) | P1-7e e2b（`e35bbee2`）：失败回合的历史行带原因、Stop 保留已输出的尾部、`/compact` 成功有提示；公司网关流闸门与「模型设置不兼容」两类错误有专门的卡且不自动重试（第 25 条），只认网关自己的标记，普通 5xx 照旧重试（第 27 条）。问题 31 已裁决 |
| [141](decisions/141-model-plan-adaptive-thinking-hardening.md) | 模型计划对只支持 adaptive 思考的 anthropic 模型不下发 `off`；没声明 `forceAdaptiveThinking` 的行记一条诊断（`1c3f9fc9`） |
| [142](decisions/142-p1-7e-e3-choices.md) | P1-7e e3（`0f04c61c`）：浮窗拖动不再跳、终端里 Ctrl+F 打开搜索、旧 worker 的后台任务行保留到用户移除（每个对话最多 8 条）、toast 寿命自己管（窗口失焦不再暂停计时）、回收提示按「有没有在跑」措辞、工具行图标与深色失败卡标题调深 |
| [150](decisions/150-e8-plugin-credential-isolation.md) | E8 结论：同进程插件与宿主凭据同权（第 1 节，实测事实）；第 2、3 节已由决策 149 第 4 条裁决（选 A，已落地）；剩第 5 节实验方法的取舍。决策 034 第 4 条的补记已在本次收口补上 |
| [152](decisions/152-p1-5e-managed-key-vault-choices.md) | P1-5e 管理员 key 移入保险库（`4bd31a2c`）：读回缺 key 只剔除该服务、绝不回退到登录 key、换账号时清、不升保险库 schema 版本。第 4 条已裁决（切本地模式不清） |
| [154](decisions/154-p1-8c-ci-wiring-choices.md) | P1-8c 接 CI（`9748ddef`、`42dddf81`）：两份回归脚本本来就按硬门槛决定退出码，没加开关；只改 `dsh-bridge-gate.yml`，不改 `build.yml`。守卫去留已裁决；`--runs` 与超时见「一」 |

---

## 四、需要你授权的动作（不是决策）

1. **推送分支**（用户 10-07 决定暂不推送）。推送前先把版本升到 `1.1.0-dsh.5`，单独一个 `chore` 提交。推送到 `feat/dsh-p0-probe` 会自动跑 `dsh-bridge-gate.yml`，第一次带上 P1-8c 的三步；`build.yml` 整包构建要手动触发，P1-12 第 4 步之后的改动第一次经过整包构建。风险：仓库是公开的，代码会在 GitHub Actions 上公开跑；不建 Release，已装的 1.0.x 收不到。
2. **GUI 复点验**（开发机起 Electron）：决策 156 的 11 项、P1-7e e6、P1-8、P1-3e 三会话杀宿主，清单见[看板 Next Target](implementation-status.md#next-target)。本机内存紧，不与全量测试同时跑。
3. **Windows 测试版实测**：点验清单 J 节 W1～W12、Windows 杀宿主、覆盖安装。要先推送并出测试包。
4. **P1-13 第二轮上机**：加密机上由你执行（GUI、真实模型、插件子进程、迁移），上机手册待写。
5. **真实网关补验**：R8 重新登录后跑通一次完整回合；R9 等网关管理员答复。
6. **真实数据离线迁移测试**（P1-9 的退出判据）：要你指定机器与 profile 副本，由你本人运行，或授权代理运行且只看报告。
