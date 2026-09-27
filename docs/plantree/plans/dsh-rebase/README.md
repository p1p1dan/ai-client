# DSH 二开迁移（B 路线）

Role: plan-entrypoint。建立日期：2026-09-25。状态：P0 已完成（2026-09-26）；P1「分支内 DSH 替换」任务 P1-0～P1-14 已批准，下一步 P1-0（同步 main）。

用户 2026-09-24 定方向：整个产品向 DeepSeek Harness（DSH）看齐、兼容其生态，同时保留登录、额度等自有功能。2026-09-25 批准调研推荐的 **B 路线**：DSH 宿主做 worker 引擎，外壳与渲染层保留，先做 P0 探针（[决策 001](decisions/001-route-b-and-scope.md)）。2026-09-26 把加密机移出 P0 门槛，挪到 P2 前；P0 只看 Linux 与普通 Windows；进程拓扑定为共享宿主（[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)）。

## 范围

- 在现有 WorkerSlot 里用随包 `node.exe` 拉起「`dsh-base` + 我方 bundle」，由 bridge 插件把 DSH 会话事件翻成现有 RuntimeEvent；渲染层与 Main 基本不动。
- 兼容目标：L1（宿主插件能装能跑）+ L3（和官方 DSH 共用 profile 与会话格式）。L2（社区界面插件）不在本计划内，P2 之后再议。
- 分期 P0 探针 → P1 分支内 DSH 替换 → 合入 main 即切换（决策 004 取消了双引擎与 P2）；P3（L2）为可选，未立项。

不在范围内：1.0.x 的缺陷修复（继续在 [Runtime 加固与收口](../runtime-hardening/README.md) 做）；fork DSH 桌面端（A 路线）；在自有 runtime 里兼容加载 DSH 插件（C 路线）。

## 硬约束

1. **加密机**：读文件与执行工具必须跑在白名单载体（随包 `node.exe`）上，否则产品读到密文（ARD D11 / D13）。检验时点在 P2 默认切换之前（决策 002），不过就回到决策点。
2. **渐进（靠分支隔离）**：main 继续维护 1.0.x；DSH 在 `feat/dsh-p0-probe` 上整体替换引擎，不做双引擎，测试完毕后合入 main 即切换（[决策 004](decisions/004-branch-isolated-dsh-only.md)）。合入前必须做到无痛升级：已装用户的会话与设置能迁移，旧会话只复制不改。
3. 1.0.x 维护期内，自有 runtime 不再开大投入（D3 / D4 等已暂停，改由 DSH jobs 提供）。

## 文件地图

- [roadmap.md](roadmap.md)：分期与任务，任务身份、状态、顺序的唯一权威。
- [decisions/](decisions/)：[001 B 路线与六点拍板](decisions/001-route-b-and-scope.md)；[002 加密机移到 P2 前、共享宿主](decisions/002-defer-encrypted-machine-and-shared-host.md)；[003 进入 P1、钉版本、暂不加 Claude SDK](decisions/003-p0-closeout-enter-p1.md)；[004 分支内整体替换、不做双引擎](decisions/004-branch-isolated-dsh-only.md)。
- [open-questions.md](open-questions.md)：P0 实测后才能定的问题。
- [topics/](topics/)：上机检查单（[加密机](topics/p0-4-encrypted-machine-checklist.md)，P2 前使用）。
- 调研与依据：[DSH 二开可行性调研](../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)（生态、许可、功能落点、方案对比、goal 对照、差距表）。[Claude SDK 引擎调研](../../../plans/2026-09-26-claude-sdk-engine-study.md)（2026-09-26，对应 Q006）。

## 权威顺序

架构冲突以 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md) 为准，直到 P2 默认切换时回写 ARD；本计划的取舍以本目录决策为准；调研档是事实来源，DSH 处于 developer preview，引用前按调研档的取证方法重核。
