# F3 / F4 / F5 决策论证 · test.11 现场交回的三个定性问题

> Role: decision-and-investigation。以下源码描述是 2026-09-09 定性时的快照；实时进度只见[核心任务树](../plantree/plans/runtime-evolution/README.md#现场缺陷与修复)。包后 native 权限已改为结构化 permission 事件，不能继续把下文旧 ui.select 路径当作当前实现。
> 来源：`Windows-P4-6-evidence/gui-a-e-findings.md`（2026-09-09 Windows 现场）
> 相关：ARD [D11 执行载体](2026-09-08-runtime-evolution-ard.md#d11--执行载体按进程身份区分不按实现语言推断) · [D1 bash 载体决策](2026-09-09-bash-carrier-decision.md) · [执行 TODO](../plantree/plans/runtime-evolution/TODO.md)

三条都被现场标成「需 Linux 侧决策」。核清源码后，三条的性质并不相同：
**F4 是漏搬的模块**，**F5 是从未存在的能力**，**F3 是与 D1 同一个未知量的载体问题**。

---

## F3 · GUI 起的 git 子进程输出丢失

### 现场事实

| 进程 | `git branch -a -v`（同一 worktree 仓库） | 结果 |
|---|---|---|
| Git Bash | 分支列表完整 | ✅ |
| PowerShell 调 git | 分支列表完整 | ✅ |
| GUI（Electron 主进程 `spawn('git')`） | 空 | ❌ |

补充两条已记录在 ARD §8、方向相反的事实：

- Main 派生 git 时 **stderr 能读回**（`fatal: not a git repository` 透传到渲染层）——管道机制本身没坏。
- Main 派生 PowerShell 再读 `.git\HEAD` 与跑 `git status` **正常**——同一 Main 血统下经白名单外壳就能拿到结果。

### 定性

**不是 `GitService` 的主线缺陷。** Q7 已经修掉了判据问题：健康仓库不再被误报
`no commits yet`，而是如实报 `output was lost`——错误信息正确，根因未解。
这些事实支持“启动载体或父进程相关”的调查方向，但尚不能唯一归因于加密驱动放行，也不能证明 git 读不到仓库元数据。
stderr 可见仅证明该输出通道可用；stdout 丢失的具体位置仍需对照真实 Main→Git 启动链。
worktree 的 `.git` 是指针文件，这也是待核对的输入之一。

### 与 D1 是同一个未知量

放行规则按**进程名 / 路径 / 签名 / 父进程**哪一种，决定了「把 git 包一层随包 node 再派生」是否有用：

- 若按**父进程 / 进程树**放行 → 用随包 `node.exe` 当中间层即可，`tsdSafeRead` 已有同款先例（`src/main/utils/tsdSafeRead.ts:44`）。
- 若按**进程名 / 映像路径**放行 → 包一层没有任何作用，只能改走白名单里的外壳（Git Bash），或接受 GUI 侧 git 面板在加密机不可用。

这正是 [D1 决策文档](2026-09-09-bash-carrier-decision.md) 第 6 节 R2 / R3 两条探针要测的东西。
**因此 F3 不单独设探针：R2/R3 的结果一到，F3 与 D1 一起拍板。**

### 选项与倾向

| 选项 | 代价 | 何时选 |
|---|---|---|
| **A. 维持现状 + 如实报错**（现状，Q7 已落地） | GUI git 面板在加密机不可用，但不误导 | 作为兜底始终成立 |
| **B. git 子进程改由随包 `node.exe` 派生** | 中：Main 侧需要一条与 `tsdSafeRead` 同款的 runner 链，`spawnGit` 是唯一收敛点（`src/main/services/git/runtime.ts:135`） | R2/R3 证明按父进程/进程树放行时。**倾向** |
| **C. git 子进程走系统 Git Bash** | 与 D1 选项 A 绑定：现场没装 Git for Windows 就没有 git 面板 | R2/R3 证明按进程名放行，且 D1 也收在 A 时 |

**建议：先按 A 收，等 R2/R3。** 不要在未知量确定前先写 B——那会引入第二条未验证载体，
与 ARD §6 拒绝引入 Rust 载体的理由相同。

---

## F4 · 503 不重试直接失败

### 定性：**缺陷，且是已知漏搬**

不是「503 属设计内不重试集合」——**native runtime 根本没有自有重试层**：

| 事实 | 出处 |
|---|---|
| 重试与遥测由 loop 负责、不在 adapter | `src/runtime/contracts.ts:122` 的接口注释 |
| `plugins/agent-loop/` 下没有任何重试实现（目录只有 `index.ts` / `attachments.ts`） | 源码核对 |
| 看板早已记「P4-4 之前要把 PI-Desktop 的 `provider-retry.ts` 搬过来」 | [看板](../plantree/plans/runtime-evolution/README.md) P0 段 |
| P0 在线冒烟实测：OpenAI SDK 自带阶梯很慢，一次失败耗时 110s | [live-smoke](../plantree/plans/runtime-evolution/evidence/p0/live-smoke.md) |

所以现在的行为是「pi-ai / OpenAI SDK 的默认重试」，不是我们选择的策略：
503 不重试是默认值的结果，而不是判断的结果。

### 处理（已落地，2026-09-09）

1. 已搬 `createProviderRetryStream` 与错误分类到 `src/runtime/plugins/agent-loop/`：429 单独一条预算
   （5 次，2s 起指数退避 + 正抖动，上限 30s），**503 / 529 / 502 / 网络断连 / 超时**共用另一条
   （4 次，1s→2s→4s→8s）；`retry-after-ms` / `Retry-After` 秒数 / HTTP-date 一律优先并封顶。
2. 内层流固定 `maxRetries: 0`——SDK 自带阶梯正是 P0 实测 110s 的来源，改由本层排程。
3. 只接管**流开始前**的失败；已 `start` 的流原样透传，中途换消息属 mid-stream 恢复，参考实现同样留在外面。
4. 30 项单测按错误类型钉住分类、预算、退避与 `Retry-After`，另有一项跑真实 Cordis 图的端到端用例；不依赖现场撞运气。
5. **F7d「GPT 渠道耗时极长」**若源于 SDK 阶梯，本次一并解决——待现场复测确认。

归属：P4 遗留项（本就是 P4-4 的前置），不是 P5。

---

## F5 · 无提问工具，QuestionCard / 扩展问答弹不出来

### 定性：**能力缺口，不是 native 回归**

两件事要分开：

| 通道 | 谁产生 | legacy | native |
|---|---|---|---|
| `extensionUi.request`（select / confirm / input / editor） | pi 扩展调用 `ui.*`，经 [`extensionUiBridge.ts`](../../src/agent-host/extensionUiBridge.ts) 转事件 | 有（pi 扩展在） | **只有权限审批在用**（`src/runtime/plugins/permissions/bridge.ts` 用 `ui.select` 做三选一），没有别的调用方 |
| `question.requested` → QuestionCard | —— | **全仓没有任何生产者** | 同左 |

`grep` 全仓 `question.requested`：只有渲染层消费方（`chatSessions.ts` / `sessionActivity.ts` /
`assistantProgress.ts`）与类型定义，**没有后端发过这个事件**。也就是说 QuestionCard 在
legacy 上同样弹不出来——清单 5c/5d/5f/5g/5i 从来就没有可被 native 破坏的基线。

native 缺的是「有东西发起提问」：扩展 UI 通道本身是通的（权限卡就是它渲染的），
只是 native 不装 pi 扩展，于是没有调用方。

### 处理

1. **不计入 P4-6 失败**。现场清单 5c/5d/5f/5g/5i 标注「无生产者，legacy/native 同」，不当回归。
2. 是否给 native 加 ask 工具是**产品决策**：加的话实现成本很低——复用
   `createRuntimeApprovalBridge` 同一条 `ui.select` 链注册一个工具即可；不加的话
   `question.requested` 与 QuestionCard 属于渲染层的待用契约，应在文档里写明「等生产者」。
3. **建议加**，但排在 P5-1（skills）一批里，不插队 P4-6：它是新增能力，不是修复。

---

## 三条的归属汇总

| 编号 | 定性 | 归属 | 阻塞 P4-6 签收？ |
|---|---|---|---|
| F3 | 载体问题，与 D1 同一未知量 | 等 D1 的 R2/R3 探针 | 是（现场清单需标注结果） |
| F4 | 漏搬 `provider-retry.ts` | P4 遗留项，**已落地** | 待现场复测 |
| F5 | 能力缺口，非回归 | P5-1 批 | 否 |
