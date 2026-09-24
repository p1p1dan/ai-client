# Runtime 加固与收口

Role: plan-entrypoint。建立日期：2026-09-14。状态：In Progress（批次 A～D4、G 已落地；批次 H：T077～T087 + 提级的 T053 十项、以及下半场追加的 T088/T089，共分 17 个本地提交落地（未推送），本地点验两轮均已完成，T085 阻塞于 Q019 未开始，T087 推迟；Q021 已结案，且批次立项时「输出慢＝5 分钟缓存 TTL」的判断已被 2026-09-18 实测推翻，详见 [perf-2026-09-18.md](evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md)，待 Windows 第二轮上机做剩余观感类验证。批次 I（T091～T103，用户当日十条现场反馈）十三项已落地分 12 个本地提交（未推送）。批次 J（2026-09-19 建立，T104～T106，用户当日另提三条界面诉求）线 A/T104 已落地 `0bc99095`（未推送），线 B/T105 · T106 施工中）。

批次 K 当前：T107～T110 实现与定向验证完成、逐项提交，真实 GUI 与 T111 取证待补；见 [执行记录](evidence/batch-k-answer-visibility-2026-09-21/README.md)。

批次 M 当前（2026-09-24）：Ctrl+Enter 插话分支收口，T118～T123 已落地未推送，开发机点验与 Windows `1.0.3-test.1` 实测进行中；见 [roadmap 批次 M](roadmap.md) 与[证据](evidence/review-and-loop-incident-2026-09-24.md)。

最新展示规则：[决策 038：委派两层与完成后折叠](decisions/038-delegation-thinking-preview-and-completion-fold.md)，其中思考预览一条已被[决策 043：思考默认折叠，只有被打断的回合默认展开](decisions/043-thought-folded-and-interrupted-turns-open.md)替代。

## 范围

承接 [Runtime 自主化演进](../runtime-evolution/README.md)（P0～P6 + H/20）执行完成后的三类工作：

1. **修补**：2026-09-14 只读审计确认的 185 条缺陷（10 high、约 49 medium、约 126 low），按安全与数据完整性 → 功能正确性 → 退役清扫与文档回写的顺序修。
2. **补审**：审计没覆盖到的面（Main 进程侧、渲染层词汇表、12 类未认领节点、并发与容量、Windows/加密机静态面）。2026-09-15 已完成（批次 D），产出 121 条确认缺陷，修补分成上机前（批次 D2）与上机后（批次 F）。
3. **现场**：原第 11 批「加密 Windows 一次性全量验收」，合并审计里只有静态推断的 Windows 项。

不在范围内：新功能；ARD 决策变更（需要时回 ARD）；runtime-evolution 树的重写（它收口为参考与证据基线，见[决策 001](decisions/001-open-hardening-plan-root.md)）。

## 权威顺序

- 决策冲突以 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md) 为准。
- 任务身份、状态、顺序只看本计划的 [roadmap.md](roadmap.md)。
- 当前执行窗口、最近落地、阻塞只看根级[进度看板](../../进度看板.md)。
- 缺陷事实以[审计证据](../runtime-evolution/evidence/runtime-audit-2026-09-14/README.md)与[批次 D 补审证据](evidence/batch-d-audit-2026-09-15/README.md)为准；roadmap 里只引用发现编号，不复制描述。
- runtime-evolution 的节点状态表保持原样作为历史；审计对它的异议记录在审计证据第五节，修补落地后在本计划回写「已修」，不改旧树的 ✅。

## 文件

| 文件 | 角色 |
|---|---|
| [roadmap.md](roadmap.md) | 任务树 T001～T136，批次 A～D、D2、D3、D4、E、F、G、H、I、J、K、K 续、L、M，Done / In Progress / Next / Deferred |
| [evidence/review-and-loop-incident-2026-09-24.md](evidence/review-and-loop-incident-2026-09-24.md) | 批次 M（T118～T136）：分支 6 个收口提交、代码审查 15 条的处置、v1.0.2 子代理工具死循环事故分析（统计与模式）、收口验证数字 |
| [evidence/interject-branch-devbox-2026-09-24/](evidence/interject-branch-devbox-2026-09-24/) | 批次 M 开发机 GUI 点验（假网关；插话 / 分支栏 / 时间线 / 死循环防护）——**点验进行中**，结果由点验代理写入该目录 README |
| [history/2026-09-24-进度看板-旧阶段归档.md](history/2026-09-24-进度看板-旧阶段归档.md) | 进度看板 2026-09-24 瘦身时原文搬出的旧阶段条目、旧 Active TODO / Blocked By、2026-09-18 及更早的 Last Landed / Last Verified |
| [open-questions.md](open-questions.md) | 修补前要拍板的问题 |
| [evidence/batch-j-chat-typography-2026-09-19/](evidence/batch-j-chat-typography-2026-09-19/README.md) | 批次 J（T104～T106，用户当日另提三条界面诉求）证据目录：**目录已建、内容待补**——线 A/T104 已落地 `0bc99095`（未推送），线 B/T105 · T106 施工中；GUI 点验四张图 + 阅读栏字数实测 + 反向验证记录待线 B 收口后一次性取，待归档清单见该目录 README（**不得用设计值或推算值充数**） |
| [evidence/batch-h-field-fixes-2026-09-18/](evidence/batch-h-field-fixes-2026-09-18/README.md) | 批次 H（T077～T087 + 提级 T053，及下半场追加的 T088/T089）落地明细（17 个本地提交，未推送）、验证结果（429 文件 / 6641 条全绿）、两轮本地点验结果、待 T033 第二轮上机验证清单、当日其它发现登记；新增 Q022～Q026 均已结案，Q021 亦已结案（见同目录 [perf-2026-09-18.md](evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md)：性能重测推翻「输出慢＝缓存 TTL」旧判断） |
| [checklist-e.md](checklist-e.md) | 批次 E 正式上机检查单（T032 产出）：DEV / Windows / 加密机 / utility / 真实模型五组判据与取证方式 |
| [topics/answer-visibility-and-diff-open.md](topics/answer-visibility-and-diff-open.md) | 批次 K（T107～T111，用户当日三条界面诉求）topic 胶囊：K1～K5 已拍板结论、六条红线、逐文件改动点、测试影响面 |
| [topics/answer-visibility-and-diff-open-handoff.md](topics/answer-visibility-and-diff-open-handoff.md) | 批次 K 施工移交单：开工前硬前置（含「不得碰别人在途改动」）、逐任务交付物与证据要求、验证与报告格式、验收判据、已知的坑、任务记录栏 |
| [topics/workzone-at-turn-end-handoff.md](topics/workzone-at-turn-end-handoff.md) | 批次 K 续施工移交单（T112～T114）：单条不折叠、工作区行钉回合末尾两态、撤悬停条时间戳；含 dev 起停与取证步骤、要改写的 T12-b 旧裁定清单 |
| [topics/app-state-migration-gaps.md](topics/app-state-migration-gaps.md) | 批次 L：升级后项目与对话消失的三处迁移缺口（现场实测、逐条根因、leveldb 整目录陷阱、session-index 绝对路径改写、既有红线与真机验收方式） |
| [topics/t033-field-day-runbook.md](topics/t033-field-day-runbook.md) | T033 上机日执行单（topic capsule）：装机、上机前自检、执行顺序、34 条必做的编号映射、砍单顺序、远程协作与证据命名；逐项分片在 [topics/t033-field-day/](topics/t033-field-day/01-win.md) 七份（WIN / ENC / PKG / MODEL / 批次 D4 复验 / 收尾回填 / [2026-09-18 现场反馈与根因](topics/t033-field-day/07-findings.md)） |
| [evidence/batch-e-build-2026-09-18/](evidence/batch-e-build-2026-09-18/README.md) | T033 上机前补的那次打包构建（run 35295618831，源码 `13e6cdb7`）：产物与作业清单、三平台 worker-smoke JSON（WIN-19 据此已可标 ✅） |
| [evidence/batch-e-devbox-2026-09-17/tools/field-samples/](evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) | T033 上机日样本包：ENC-12 的编码与二进制样本及生成脚本、MODEL-49 的策略样例与三类 shell 命令、慢启动 stdio MCP 服务器、真实旧格式 Codex rollout 的查找路径 |
| [evidence/batch-d4-fixes-2026-09-17/](evidence/batch-d4-fixes-2026-09-17/README.md) | 批次 D4 九项修补（T060～T068）的落地、两轮审阅、两轮真机复验与「留给上机」的点 |
| [evidence/batch-e-devbox-2026-09-17/](evidence/batch-e-devbox-2026-09-17/README.md) | T032 开发机组 37 项实跑证据：七批正文、汇总节、缺陷 D1～D26、收口全量存档 |
| [evidence/batch-a-2026-09-14.md](evidence/batch-a-2026-09-14.md) | 批次 A 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-b-2026-09-14.md](evidence/batch-b-2026-09-14.md) | 批次 B 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-c-2026-09-15.md](evidence/batch-c-2026-09-15.md) | 批次 C 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-d-2026-09-15.md](evidence/batch-d-2026-09-15.md) | 批次 D 落地记录：方式、代理与额度、偏离、转移项 |
| [evidence/batch-d-audit-2026-09-15/](evidence/batch-d-audit-2026-09-15/README.md) | 批次 D 补审证据集：报告、129 条发现全文、接缝与批评者、上机检查单草案、结构化数据、18 份区域原文 |
| [decisions/](decisions/) | 001 开第二个计划根；002 修补顺序与取舍计数规则；003 allow-session 保持会话级（答 Q003）；004 技能目录找到仓库根（答 Q004）；005 子代理 usage 并入 usage.updated（答 Q007）；006 中段坏行跳过重写（答 Q008，新开 T034）；007 删 targetPath、指令按官方分级只认 CLAUDE.md / AGENTS.md（答 Q001，新开 T035）；008 settingSources 三值开关管全部分层来源并定义 local 层（修订 007）；009 managed 模式下 native 视项目为可信，只有项目级模型设置不读（答 Q009）；010 随包默认策略维持底层，不压顶用户 / 项目层（答 Q010）；011 managed 模式 TUI 只需保证公司渠道可用，不封其他渠道（答 Q011，结案）；012 extensionUi 整链退役、免代码插件扩展推后（答 Q012，新开 T036）；013 批次 D2 上机前修补全做、不压缩（答 Q013）；014 MCP 服务器每会话上限从固定 16 改为按内存分档 4/6/12（编排者裁定，T046 落地）；017 兼容根子代理定义按来源文件编辑 / 删除，结 D12（编排者采纳，T063 落地）；018 删除临时工作区前确认，删除后聊天转回未绑定分组继续显示，结 Q016（用户拍板，T069 落地，批次 F）；019 运行时错误统一改成带标题与下一步的引导卡片，结 Q017（用户拍板，T070 落地，批次 F）；020 临时工作区根目录固定加一层应用专属子目录，结 Q018（用户拍板，T071 落地，批次 F）；021 回合过程收进「工作组」并恢复「已工作 xx 秒」，推翻 2026-08-29 与 2026-09-10 两条旧裁定（用户拍板，T072 / T073 已落地，批次 G）；022 授权闸串行化 + 活卡收进输入框上方浮层单卡（用户三候选中选定，T074 已落地，批次 G）；023 新增第四档权限模式「完全放行」，全自动之上放行 bash 静态分析未解析路径，进入需二次确认且激活期间界面持续可见（用户拍板，T078，批次 H）；024 prompt cache TTL 主对话 1h / 子代理 5m 分离并暴露为设置项，对齐 Claude Code 的 promptCacheTtl / subagentPromptCacheTtl（用户拍板，T077，批次 H；待验证中转是否透传 ttl 1h，见 Q021）；025 搜索工具优先改自有实现，`@ff-labs/pi-fff` 仅作设计参考、替换成本低才整包采用（编排者裁定，无独立任务，指导 T083）；026 授权记忆的粒度——文件类只记批准的那一个文件（对齐 Claude Code），bash 类维持记命令前缀不变，存活期维持随会话持久化不跨会话（用户拍板，结 Q023，T081 落地，批次 H）；027 时间线审批行不补审计行（用户拍板，结 Q027，不做，批次 H 09-19 点验）；028 长思考块折叠头吸顶，定高不截断、不透明覆盖全宽（用户看过三方案演示页后选定，结 Q031，T096 落地，批次 I）；029 渠道超时与重试——首字节 / 流中空闲超时默认 120 秒可调可关、父循环补流中断恢复、活倒计时 + 立即放弃、次数与 3 / 10 / 30 秒梯子不变（用户拍板，结 Q030，T093 落地，批次 I）；030 查看历史会话走主进程只读回放，发送时才起 worker（用户拍板，结 Q029，档位 A，T102 落地，批次 I）；031 连续工具调用不分类型聚合成一条 + 工作组始终折叠，**推翻决策 021 的「运行中自动展开」那一半**（021 的结束后折叠、头部报时长、纯派生无 useEffect、未应答授权强制展开全部保留），理由记为「用户当下诉求」（用户拍板，T105 / T106，批次 J，施工中）；032 聊天区两档字号（正文 / 过程）运行时可变，新增 `--text-chat-body` / `--text-chat-process` 两个 token，**对「字号只能用固定 token」的有据偏离**，红线「绝不写 documentElement」仍然成立（用户拍板，T104 已落地，批次 J）；033～040（2026-09-22～23：过程组形制、zcode 对齐过程行、回合时钟、委派两层与思考预览、主会话轮次上限移除与恢复）见目录原文；041 插话不等后台子代理，子代理跨运行继续、报告下一次运行交付（用户拍板，T118，批次 M）；042 子代理工具防空转——单条回复流式掐断且零执行、跨回复空转拒绝与收尾、开关 `AICLIENT_RUNTIME_LOOP_GUARD`，推翻 `b3eee689`「不加循环检测」的前提（用户拍板，T122，批次 M）；043 思考块默认折叠、只有被插话或停止打断的回合默认展开且可收起，替代 038 的 200 字预览（用户拍板，T120，批次 M） |
| [../runtime-evolution/evidence/runtime-audit-2026-09-14/](../runtime-evolution/evidence/runtime-audit-2026-09-14/README.md) | 审计报告、235 条发现全文、区域总评、接缝与批评者、结构化数据 |
| [../../进度看板.md](../../进度看板.md) | 用户看板（implementation-status） |

## 读法

1. 先读审计报告的第一、三节，知道 10 条 high 是什么。
2. 读 roadmap 的批次 A，每个任务列了它覆盖的发现编号，去 `findings-high.md` / `findings-medium.md` 看原文与反驳者的复核。
3. 动工前看 open-questions，有的任务依赖一次拍板。
4. 落地后：roadmap 该任务改 Done 并挂提交号与证据；进度看板更新；发现编号在证据 README 第五节表里标「已修（Txxx）」。

## 与旧计划的关系

runtime-evolution 是「把 runtime 做出来」，本计划是「把它修到可发布并上机验收」。旧树的 topics、evidence、history 全部保留在原位，本计划只链接不复制。旧树的 [进度看板收口快照](../runtime-evolution/history/2026-09-14-进度看板-收口快照.md)是它最后一版看板。

## 验证路径（每个批次通用）

- 三套 tsc（根 / `src/runtime` / `src/agent-host`）+ 全量测试 + 改动文件 Biome。
- 每条修补至少一个反向验证（去掉修复该用例判红），沿用旧树「五处反向验证」的做法。
- 安全类（T001、T002）修完复跑 PERM-1 探针（`scripts/run-perm1-probe.mjs`）与 shellPolicy 全套。
- 开发机 2 核 / 3.3 GB：全量测试与 Electron 点验不同时跑。
- 现场项只在批次 E 一次上机；开发机能做的一律先做完。
