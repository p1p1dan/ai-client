# DSH 二开迁移：进度看板

Role: implementation-status。更新日期：2026-09-28。只放当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；任务身份与状态以 [roadmap](roadmap.md) 为准。

## 工作方式（2026-09-26 用户授权）

- 只在分支 `feat/dsh-p0-probe`（worktree `.claude/worktrees/agent-a84b7bf3214a2affd`）上活动，不动 main 与 v1.0.3；不推送，推送与发版前先确认。
- 按 roadmap 顺序推进 P1。一般问题调研后自行决定，每条决定单独写一份决策文件，标「自主决定，待用户审批」；难以解决的问题停下来与用户商讨。

## Current Phase

P1 分支内 DSH 替换。全部任务已出方案（[roadmap](roadmap.md)，决策 005～087 自主决定、待用户审批）。已落地：P1-0、P1-1、P1-2 本机部分、P1-3a～d、P1-4a、P1-4b、P1-5a / 5b 与宿主侧接线、P1-6a、P1-6b 第一部分、P1-8、P1-9a / 9b / 9g、P1-10a。P1-13 加密机第一轮已回（[决策 084](decisions/084-p1-13-round1-reading.md)）：`.txt` 全链路明文，不触发否决，但不能签收。

## Next Target

P1-6 第二部分与 P1-6c（在跑：权限接进 bridge、卡片往返、授权记忆 sidecar）→ P1-4c / d → P1-4e → P1-9c。P1-13b 加密矩阵上机包已就绪，等用户上机。

## Last Landed

- 2026-09-28 P1-16 再前置：子代理目录规则（根、合并、内置、pin 解析）从 `plugins/subagent/catalog.ts` 搬进 `src/shared/subagentCatalogRoots.ts`，runtime 原位置改薄封装；MCP 真实 stdio 夹具 `mcp-echo-server.mjs` 移到 `src/shared/mcp/__tests__/fixtures/`（[决策 087](decisions/087-subagent-catalog-move-and-fixture-relocation.md)）。P1-16 方案里「删 runtime 前先搬」的三项（skills/模板、MCP、子代理目录规则）至此全部完成。子代理原测试文件（35 例，SA01+SA02）整份搬进 `src/shared/__tests__/subagentCatalogRoots.test.ts`，按用例全名比对零丢失；新增边界静态测试（5 例）与薄封装测试（2 例）。复跑：四套 tsc 通过（dsh-host 侧另一代理并行改动，未触及本次文件）；runtime 下 `subagent` 相关 20 个测试文件、314 例通过；`fe089adf` 涉及 MCP/skills 的 9 个相关测试文件、138 例通过；biome 改动文件全过。
- 2026-09-28 P1-10a 收尾：`fc6061c6` plugin-manager 常闭，删掉宿主里的 pnpm 配置，上机包的插件检查改为不联网（[决策 082 实施补记](decisions/082-allowlist-implementation-choices.md)）。编排器复跑：dsh-host tsc 通过；相关单测 765 例通过；真宿主集成 18/18；`bridge-record --check` 9 个场景无差异；bridge-smoke 36 项；重建产物 82.1 MiB，打包冒烟 L1 共 40 项。代理另跑了上机包 Linux 预演：44 项里通过 40、失败 0。
- 2026-09-28 P1-16 前置：`fe089adf` skills、模板与展开、MCP 的纯逻辑搬进 `src/shared`，runtime 改为薄封装（[决策 086](decisions/086-shared-skills-mcp-move-choices.md)）。编排器复跑：相关 20 个测试文件、480 例通过；根、runtime、agent-host 三套 tsc 通过。
- 2026-09-28 P1-13b 上机包：`fd8f2ac9` 加密矩阵工具，外加第一轮现场脚本修改的回收。Linux 预演（只跑 node 那半边）通过，单测 17 例通过；PowerShell 脚本还没实跑过。包在 `/var/tmp/aiclient-p1-13b-kit/`，sha256 `4a5ea708…b652`。读代码还有一个发现：DSH 新建文件是先写临时文件再硬链接成目标名，1.0.x 是直接写目标名，所以决策 084 与 Q009 里「与 1.0.x 相同」的推断已撤回。
- 2026-09-28 P1-5 宿主侧接线与 P1-5b：`c8bcdab1`（[决策 085](decisions/085-model-plan-wiring-implementation-choices.md)）。编排器复跑：
  - 四套 tsc 通过；
  - 相关单测 86 个文件、1337 例通过；
  - 真宿主集成测试 18/18，含 KEY-CANARY；
  - bridge-smoke 36 项、loop-guard-smoke 31 项；
  - `bridge-record --check` 只有预期中的一处差异，已重录 `stream.fail.json`；
  - 重建产物 82.1 MiB，打包冒烟 L1 共 40 项全过。
- 2026-09-28 P1-13 第一轮（加密机，用户现场执行）：正式轮 45 项通过、3 项记录，DSH Desktop 对照组 14 项通过。`.txt` 的读取、编辑、搜索、shell、终端、spill、会话日志都是明文；node.exe 新建的文件不加密（三组一样，[Q009](open-questions.md)）；另有两处读到密文的旁证（`.ps1`、`.yml`），要做扩展名矩阵。证据在 [p1-13-encrypted-2026-09-28/](evidence/p1-13-encrypted-2026-09-28/README.md)。
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

1. 在跑：P1-6 第二部分与 P1-6c（权限行默认启用、bridge 卡片往返、授权记忆 sidecar、setter、冒烟与探针自动应答）。
2. 之后：P1-4c / d（P1-4d 的失败码与模型 id 已随 P1-5 做掉一部分）、P1-4e、P1-9c～f、P1-15、P1-16a～d。
3. P1-5c～e，以及真实网关验证 R1～R10，后者要用户授权。
4. P1-2 三平台 CI 与 P1-6d 的 Windows CI 待用户确认推送。
5. 决策 005～087 与 Q003、Q007～Q010 等用户审批或答复。

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
