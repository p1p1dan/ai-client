# Runtime 加固与收口

Role: plan-entrypoint。建立日期：2026-09-14。状态：In Progress（批次 A / B / C / D 已落地；批次 D2 补审修补待开工，Q013 待拍板）。

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
| [roadmap.md](roadmap.md) | 任务树 T001～T055，批次 A～D、D2、E、F，Done / In Progress / Next / Deferred |
| [open-questions.md](open-questions.md) | 修补前要拍板的问题 |
| [evidence/batch-a-2026-09-14.md](evidence/batch-a-2026-09-14.md) | 批次 A 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-b-2026-09-14.md](evidence/batch-b-2026-09-14.md) | 批次 B 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-c-2026-09-15.md](evidence/batch-c-2026-09-15.md) | 批次 C 落地记录：提交、偏离、转移项、逐波记录 |
| [evidence/batch-d-2026-09-15.md](evidence/batch-d-2026-09-15.md) | 批次 D 落地记录：方式、代理与额度、偏离、转移项 |
| [evidence/batch-d-audit-2026-09-15/](evidence/batch-d-audit-2026-09-15/README.md) | 批次 D 补审证据集：报告、129 条发现全文、接缝与批评者、上机检查单草案、结构化数据、18 份区域原文 |
| [decisions/](decisions/) | 001 开第二个计划根；002 修补顺序与取舍计数规则；003 allow-session 保持会话级（答 Q003）；004 技能目录找到仓库根（答 Q004）；005 子代理 usage 并入 usage.updated（答 Q007）；006 中段坏行跳过重写（答 Q008，新开 T034）；007 删 targetPath、指令按官方分级只认 CLAUDE.md / AGENTS.md（答 Q001，新开 T035）；008 settingSources 三值开关管全部分层来源并定义 local 层（修订 007）；009 managed 模式下 native 视项目为可信，只有项目级模型设置不读（答 Q009）；010 随包默认策略维持底层，不压顶用户 / 项目层（答 Q010）；011 managed 模式 TUI 只需保证公司渠道可用，不封其他渠道（答 Q011，结案）；012 extensionUi 整链退役、免代码插件扩展推后（答 Q012，新开 T036） |
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
