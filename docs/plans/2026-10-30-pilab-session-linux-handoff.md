# PiLab 会话体验与输出展示优化：Linux 接续 Handoff

交接日期：2026-10-30
原始基线：`69f2e45511cd9ed2d5a7b19b2671671fb32bda93`
工作分支：`feat/pilab-session-experience-r0`
目标 ID：`1793287022307-9eadbf`

## 1. 当前进度结论

已完成 R0 第一段：全量复核台账、源码/测试入口、协议映射和 F01～F08 脱敏固定回放。R0 第二段：2026-10-30 下午 Linux 真实 Electron 已打通并完成 F01～F05 状态基线、F07 性能方法、能力矩阵和 #11/#10/R1 的真实复测（§10.9）；真实多窗口、真实远程、Windows/IME/DPI 和发布包性能仍未做。

**本阶段已完成 #11、#10 和 R1 第一阶段的产品行为整改及自动回归；Linux 真实 Electron 复测已覆盖其中的主要场景（§10.9），但多窗口、远程和 Windows 目标机仍缺。** 当前工作区是在 `51fe766a0dfb03a5f52fe0a3aff58c7e0661955a` 上的未提交改动，不能宣称任何相关 FR/AC 已全部通过，也不能宣称 R0 全部完成。最新阶段收尾、PRD 映射见 §10，真实 UI 基线结论与下一入口见 §10.9。

| 任务 | 状态 | 说明 |
|---|---|---|
| #1 R0 全量台账 | 已完成 | FR-01～14、沟通、非功能和 AC-01～45 已逐项建立记录 |
| #2 协议/回放/真实基线 | 进行中 | 协议映射、固定回放、Linux 真实 UI 状态基线、F07 方法、能力矩阵已完成（§10.9）；发布包性能与 Windows/IME/DPI 未做 |
| #11 消息与传输事件幂等 | 自动修复完成，Linux 真实 DSH 恢复复测通过 | 宿主空闲/流式中途被杀、应用重启均无丢失与重复（§10.9）；Claude SDK 引擎真实恢复未测 |
| #10 文件保存基线 | 自动修复完成，真实单窗口与 Diff 复测通过 | 真实窗口 A→B 不覆盖且有提示（§10.9、§10.10，DEF-007 已修）；真实多窗口、远程未测 |
| #3 R1 核心阅读 | 主要条目完成并经真实 UI 复测；7 项待用户裁定 | DEF-001～003（§10.9）+ DEF-008～014（§10.11）；裁定项与 Claude SDK 实机未测见 §10.11 |
| #4 R2 输入/用量/差异 | 待办 | 等 R1 |
| #5 R3 预览/桌面协作 | 待办 | 等 R2 |
| #6 三套视觉样张 | 待办，后置 | 全部以 open-claude-ui 为母版并遵守 v2 |
| #7 全量回归证据包 | 待办 | 小批串行测试、分阶段构建、真实 Electron |
| #8 用户统一评审 | 待办，最后交互 | 视觉选择及必须改变 PRD/权限的事项才提交 |
| #9 最终整合交付 | 待办 | 选定视觉、最终回归、遗留与回退 |

## 2. 必读材料

按顺序：

1. `D:/Projects/duibifenxi/PRD.md`
2. `D:/Projects/duibifenxi/analysis/development-plan.md`
3. `D:/Projects/duibifenxi/analysis/acceptance-checklist.md`
4. `D:/Projects/duibifenxi/analysis/pilab-source-audit.md`
5. 本仓 `docs/plans/2026-10-29-pilab-session-experience-review.md`
6. 本仓 `docs/plans/2026-10-29-pilab-session-protocol-map.md`
7. 本仓 `docs/design-system.md`（当前唯一生效 UI 规范 v2）

上述 `D:/Projects/duibifenxi` 是 Windows 路径；Linux 接续时需找到对应需求文件副本，不能凭空补写验收规则。

## 3. R0 初始提交文件（51fe766a）

| 文件 | 用途 |
|---|---|
| `docs/plans/2026-10-29-pilab-session-experience-review.md` | 全量 FR/AC 台账、缺陷、任务和初始证据 |
| `docs/plans/2026-10-29-pilab-session-protocol-map.md` | 引擎、身份、delta/history、工具/权限/重试/后台/usage 映射和证据边界 |
| `src/shared/__tests__/fixtures/pilabExperience.ts` | F01～F08 确定性脱敏构造夹具、F07 生成器和富文本安全样本 |
| `src/shared/__tests__/pilabExperienceFixtures.test.ts` | 夹具结构、身份、数量、双引擎旧历史检查 |
| `src/renderer/stores/__tests__/pilabExperienceReplay.test.ts` | 真实 renderer reducer 的暂停/恢复、待交互和旧历史回放 |
| `docs/plans/2026-10-30-pilab-session-linux-handoff.md` | 本交接说明 |

真实 DSH 录制继续复用 `src/shared/__tests__/fixtures/dsh/stream.*.json` 和 `rpc.*.json`，不要把构造夹具称为真实宿主录制。

## 4. 已验证证据

正确的小批命令：

```bash
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec vitest run \
  src/shared/__tests__/pilabExperienceFixtures.test.ts \
  src/renderer/stores/__tests__/pilabExperienceReplay.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

结果：2 个测试文件、9 个测试全部通过。

覆盖：F01～F08 确定性；F02 的 42 thinking/67 工具/8 正文块；F04 不同 seq 的合法相同 delta 与不同调用 ID；F07 的 10,000 事件/100 工具/1,000,000 字节输出；F08 双引擎旧历史；F01 每个暂停/恢复边界；F03 待处理退休。

注意：不要使用 `pnpm test -- <files>`。本仓 script 是 `vitest run`，额外 `--` 被传给 Vitest 后会导致文件筛选失效并误跑全量套件。使用上面的 `pnpm exec vitest run ...`。

## 5. 已确认缺陷与整改顺序

| 缺陷 | 等级 | 原始证据 | 当前状态 |
|---|---|---|---|
| DEF-001 运行/中间正文随过程折叠 | S1 | `turnProcessFold.ts`；`MessageTimeline.tsx` | 自动修复完成；真实运行/恢复 UI 待复测 |
| DEF-002 thinking 逐块成行且运行组默认展开 | S1 | `toolCard.ts`；`turnProcessFold.ts` | 每个过程组聚合一个思考入口，自动回归通过；真实流式 UI 待复测 |
| DEF-003 完成时过程展开偏好丢失 | S1 | `MessageTimeline.tsx` 旧 key 含 processSettled | 改为稳定 groupKey，happy-dom 回归通过；真实交互待复测 |
| DEF-004 保存无内容基线校验 | S0 | `main/ipc/files.ts`；`useEditor.ts`；`DiffViewer.tsx` | 5 个写入口和本地/远程权威校验完成；真实窗口/远程连接待复测 |
| DEF-005 重复 message.started 清空正文 | S0 | `chatSessions.ts`；旧 `chatSessionsCore.test.ts` | 按 messageId 保留 blocks、合并元数据，自动回归通过 |
| DEF-006 同一传输事件重放重复消费 | S0 | `chatSessions.ts`；Main `WorkerManager.ts` | 同 session/seq 幂等、新 resumed 请求分代，store/DSH/Main/SDK 回归通过 |

先做 #11 和 #10，再进入 #3。两个 S0 可分别实施，但低资源主机不得并行跑重测试或构建。

## 6. 固定回放与协议注意点

- `seq` 是 Main 当前进程分配的传输序号，不是跨重启、跨模型的全局 eventId。
- 上游事件再次 dispatch 会获得新 seq；完整 assistant 帧在 Host 内处理，不存在顶层 assistant snapshot RuntimeEvent。
- 恢复实际是 `session.resumed(requestId) → session.history(同 requestId) → session.status`，不是独立 restore 事件。
- 同一 `messageId` 可有多个正文块；合法相同 delta 不能按文本去重。
- 相同命令、不同 `toolCallId` 是两次真实执行；工具结果关联不能用命令文本。
- `tool.output.tail` 是有界尾部快照，不是增量；`omittedBytes/totalBytes` 必须保留截断事实。
- DSH 支持末轮重试；Claude SDK 返回 `WORKER_RETRY_UNAVAILABLE`，UI 不得统一假装支持。
- usage 的 `pending`、`unreported`、`context.tokens:null` 都不是零或免费；delegated/session/turn 不重复累计。

详细出处见协议映射文档。

## 7. Windows 环境记录与未完成验证

- 当前 Windows 环境全局设置了 `ELECTRON_RUN_AS_NODE=1`，首次启动把 Electron 当 Node 运行并失败；临时 `env -u ELECTRON_RUN_AS_NODE` 后可识别 Electron `v39.3.0`。
- 第二次启动完成 Main/Preload 构建，但 renderer 缺少锁文件已声明的 `rehype-katex@7.0.1`，所以未得到真实 UI 基线。
- 用户明确要求：**不要在当前 Windows 环境安装任何东西。** 依赖安装未执行。
- 两次开发实例均已停止；没有遗留的本次 dev/Vitest 重任务应继续运行。
- 隔离 profile 为 `~/.pilab/jyw-ai-client-pilab-prd-baseline`，仅在本机，不属于提交，也不要复制私人状态到 Linux。
- `release-artifacts/` 是原有未跟踪目录，始终未触碰、未提交。
- 未执行完整生产构建、全量 Vitest、真实 Electron 交互、IME/DPI、性能或文件写入实验。

## 8. Linux 接续步骤

1. 核对分支、HEAD 和工作区；保留用户已有改动，不覆盖或清理无关文件。
2. 阅读第 2 节材料，确认当前源码行号，不机械套用旧行号。
3. 检查依赖是否完整，尤其是 `rehype-katex` 和原生模块。**仅在 Linux 环境允许时**按锁文件安装/修复依赖，不改变版本。
4. 重跑第 4 节两组测试；按仓库资源约束小批串行，重任务前检查 RAM/磁盘和遗留进程。
5. 用隔离、无真实模型调用的方式完成当前 UI 基线：运行、结束、待答、失败、恢复、深浅主题、窄容器；不要提交私人截图或会话日志。
6. 完成预览/差异/窗口能力矩阵和 F07 性能测量方法，更新台账的当前 SHA、环境和证据。
7. 实施 #11：先补 F04/AC-04/10 的期望测试，再修 `message.started` 与 seq 幂等，跑相关 store、DSH 录制和 SDK Host 测试。
8. 实施 #10：盘点本地/远程、编辑器/Diff/自动保存/关闭保存全部写入口；Main 做权威基线校验，测试外部 A→B 和跨窗口冲突。
9. 再进入 R1：先让 F01/F02/F05 驱动正文分层和状态整改，不只做视觉折叠开关。
10. 每阶段更新 FR/AC 结论、测试/运行证据、性能、兼容、遗留和回退；无法验证的项目保留待验证。

## 9. 不可改变的协作边界

- 不用关键词删除“像思考”的正文，不用定时器伪造成功，不按文本相等去重。
- 待答、审批和未解决阻塞始终可达；授权/执行/取消/中断/未知分别表达。
- 用户回看时不抢滚动；恢复、多窗口和重试不重复执行或累计用量。
- 不改变既有权限和 PiLab 配置隔离语义，不为仿 CLI 改回 `~/.claude`。
- 保留预览隔离和只读边界，不静默覆盖外部修改。
- 优先复用合格实现，不照搬 open-claude-ui 的模拟执行、强制思考展开或未落地机制。
- UI/动效遵守 v2，open-claude-ui 是唯一视觉母版；三套 HTML 样张后置统一评审，选定前不做视觉试改。
- 不提交私人原始日志、`release-artifacts/`、临时预览、依赖目录或无关产物；除非用户另行要求，不推送远端。

## 10. 2026-10-30 Linux 阶段收尾（当前最新）

### 10.1 当前任务进行到哪里

- 工作树：`/home/pi/.qoder-cn/worktrees/app/b86862/ai-client-pilab-session-experience-r0`；分支：`feat/pilab-session-experience-r0`。
- 代码基线：`51fe766a0dfb03a5f52fe0a3aff58c7e0661955a`。远端分支目前只保证指向该基线；本阶段产品代码、测试和文档改动均仍在本地未提交工作区，没有提交或推送。
- 已完成：#11 消息与传输事件幂等、#10 文件保存基线、#3 R1 第一阶段 DEF-001～003，及相应自动化证据。
- 未完成：#2 真实 Electron UI、性能、预览/差异/窗口能力矩阵；#3 其余 R1 条目；R2/R3、视觉样张、全量验收和最终交付。
- 当前没有遗留的本次 dev/Electron/Vitest 进程。`node_modules/`、`out-dsh-host/`、`dist/remote-runtime/` 是本地准备产物，不应提交。

### 10.2 PRD 任务需求与本阶段完成映射

原始 `D:/Projects/duibifenxi` 四份材料在 Linux `/home/pi` 下未找到。下表只引用本仓台账已经登记的 PRD 条款，不新增或猜写验收规则；“自动完成”不等于整项 FR/AC 验收通过。

| PRD 需求 | 本阶段完成的行为 | 证据与未关闭边界 |
|---|---|---|
| FR-01.2、01.4；AC-01、03：运行/中间正文独立，工具前后正文按序保留 | `splitTurnWorkGroup` 只折叠 process，所有 answer 原位独立，不再只保留最终段 | F01/F02 视图模型和 `turnProcessFold` 自动回归通过；真实运行、恢复、滚动 UI 待验证 |
| FR-02.2；AC-02：思考不逐块新增主区行，保持单一工作入口 | 每个过程组只生成一个聚合思考入口，原文保留，后续块流式状态保留；工具仍逐调用、按序显示 | F02 的 42 个 thinking 聚合为 6 个入口，67 个工具行不变；请求次数和真实流式 UI 未测 |
| FR-02.3；AC-06：完成事件不覆盖用户展开/收起选择 | 偏好只按稳定 `groupKey` 保存，不再拼接 `processSettled`；显式展开和收起都跨完成保持 | happy-dom 完成交互及展开存储回归通过；完整页面重载后的持久化没有新增，真实交互待验证 |
| FR-07.10、14.5；AC-39：既有保存入口校验内容基线，外部 A→B 和跨窗口顺序写不得静默覆盖 | 5 个 `FILE_WRITE` 入口必填 `expectedContent`；本地 Main 校验，远程同一 RPC 校验；冲突返回 `FILE_CONTENT_CONFLICT` 且不写 | 本地 A→B、两个 stale writer、远程 helper 和基线推进自动测试通过；真实 BrowserWindow、真实远程连接、Diff 界面待复测 |
| FR-01、13；AC-04、10：重复开始事件和传输重放不得丢正文或重复消费 | `message.started` 按 messageId 保留 blocks 并合并新增元数据；`applyRuntimeEvents` 按 session/seq 幂等，新 resumed requestId 开启新序号代际 | F04、store、真实 DSH 录制、Main、Claude SDK 自动回归通过；真实断线/重启恢复待验证 |
| FR-05.1；AC-07、08 的相关身份边界 | 保留按 toolCallId 配对，结果先到或相同命令不同调用 ID 不合并 | F01/F04 自动证据通过；整项工具权限/状态需求没有因此签核 |

未在本阶段宣称完成：FR-03/04/06/08～12/14 的其余条款，FR-01/02/05/07/13 的其余条件，以及 AC-01～45 的全量验收。IME/DPI、深浅主题、窄容器、滚动保锚点、F07 性能、预览隔离、真实多窗口和发布证据包仍按台账待验证。

### 10.3 重要决定、原因与证据

1. **传输幂等使用 `sessionId + seq` 高水位，不按文本去重。** Main 的 seq 只在当前进程内单调且有序；F04 明确不同 seq 的“好”“好”都是合法正文，所以相同文本绝不能作为身份。
2. **用新 `session.resumed.requestId` 划分序号代际。** Main 重启后 seq 不是持久全局序号；恢复协议为 resumed → history → status。低 seq 在新 requestId 后必须可接收，同一 requestId 的旧重放则不能重复消费。
3. **重复 `message.started` 合并元数据但保留 blocks 和原角色。** 原因是开始事件可能晚于 delta 重放，清空 blocks 会直接丢正文；附件、origin、transcriptId 只在新事件实际携带时更新。
4. **文件基线使用读取时原文 `expectedContent`，不是当前 dirty content。** 当前编辑内容包含用户修改，拿它当基线会让校验失效。5 个写入口把第 4 参数设为必填，缺失基线失败关闭，避免未来调用点绕过 S0。
5. **本地 Main 解码当前磁盘文本后比较；远程在同一个 `fs:write` RPC 内比较并写。** 解码比较避免 BOM/编码表示差异造成假冲突；远程同一 RPC 避免 Main 两次 RPC 扩大竞态窗口。该方案仍不是跨外部进程的原子 CAS。
6. **只有磁盘重载、显式外部 Reload 和成功保存能推进 `baseContent`。** 用户编辑、失败保存、Diff 轮询都不能推进。成功保存以实际写入快照推进，保存期间的新编辑继续 dirty；Diff 使用进入编辑时的 `diff.modified`，防止轮询 A→B 后错误获得覆盖权。
7. **R1 只折叠 process，所有 answer 原位独立。** F01 的正文 A/B 后面仍有工具，旧逻辑即使 settled 也没有 finalAnswer，会把所有正文藏进过程组；因此不能只调整 finalAnswer 判定。
8. **思考按“过程组”聚合，而不是整个 turn 只留一行。** F02 有 8 段正文、9 个过程组；跨正文搬移思考会破坏顺序。聚合只影响视图行，原始步骤计数和 67 个工具行不变，时长只有全部块都有真实值才求和。
9. **展开偏好使用首个真实 process item 的稳定 `groupKey`。** `processSettled` 是状态不是身份，旧 key 在完成时变化导致用户选择丢失；没有新增 localStorage 或跨完整页面重载持久化。
10. **测试信封必须服从真实 Main 序号，不为旧夹具放宽生产规则。** DSH 模拟 Main 的重复 `seq: 0` 改为单调值；R1 单步骤交互夹具补第二个真实思考块，保留“单步骤不折叠”的既有阈值。

### 10.4 尝试过但失败的方案及原因

| 尝试 | 结果与原因 | 当前处理 |
|---|---|---|
| 直接 `pnpm install/test` | 当前 Linux 没有全局 `pnpm` | 改用仓库声明版本的 `corepack pnpm`，已解决 |
| 默认 node-gyp 编译 `node-pty` | 旧 node-gyp 8 在 Python 3.13 下缺少 `distutils`，首次安装失败 | 经用户许可使用现有 node-gyp 12.4 编译成功，未改依赖版本、未安装系统包 |
| 首次启动 Electron | `sqlite3` 绑定缺失 | `electron-builder install-app-deps` 按 Electron ABI 修复，已解决 |
| 修复原生模块后进入主界面 | 页面提示“没有找到随包的对话引擎” | 分阶段 `pnpm build:dsh-host` 成功，宿主产物已生成 |
| 通过既有 `enter/peek` 获取真实 UI 基线 | Electron 能启动且 CDP `/json/list` 有页面，但 composer 等待超时 | **已解决（§10.9）**：renderer 一直可求值；真正原因是缺 `out-node-runtime` 与 `src/dsh-host/node_modules`（引擎不可用）、欢迎页已隐藏本机入口、`enter` 盲等 300 s |
| 初次 DSH 录制回归 | 43 项失败，主要是模拟 Main 的 resumed/history/status 全用重复 `seq: 0`，被新幂等规则正确拒绝 | 修正测试信封后 305 项全过，生产规则未放宽 |
| 初次 R1 完成交互夹具 | 正文移出后只剩一个 process step，按既有规则不再生成 details | 夹具增加第二个真实思考块，未改变单步骤阈值 |
| 全量 `pnpm typecheck` | 仍失败于基线 `src/shared/__tests__/fixtures/pilabExperience.ts:25` 的 TS2352 | 本阶段新增类型错误已清零；该基线问题单列，未宣称全量类型检查通过 |
| 在 Linux 查找原始 PRD 四份材料 | `/home/pi` 下未找到 Windows `D:/Projects/duibifenxi` 对应副本 | 只使用仓库既有 FR/AC 台账，未凭空补写规则；需要原始材料时从 Windows 复制脱敏版本 |

### 10.5 本阶段修改的关键文件

| 范围 | 关键实现 | 关键测试/证据 |
|---|---|---|
| #11 消息与传输幂等 | `src/renderer/stores/chatSessions.ts` | `chatSessionsCore.test.ts`、`chatSessionsBatch.test.ts`、`pilabExperienceReplay.test.ts`、`dshStreamReplay.test.ts` |
| #10 权威写入协议 | `src/main/ipc/files.ts`、`src/preload/index.ts`、`src/shared/types/file.ts`、`RemoteRepositoryBackend.ts`、`RemoteServerSource.ts`（helper 版本 `0.4.1`） | `fileRenameGuard.test.ts`、`localFileWriteGuard.test.ts`、`remotePorcelainParse.test.ts` |
| #10 renderer 基线与 5 个入口 | `src/renderer/stores/editor.ts`、`hooks/useEditor.ts`、`components/files/EditorArea.tsx`、`components/source-control/DiffViewer.tsx`、`App/hooks/useAppLifecycle.ts`、`App/hooks/useWorktreeSelection.ts` | `editorWorkspacePreview.test.ts` 及关闭/切换/差异交互既有套件 |
| R1 正文、思考和偏好 | `src/renderer/components/chat/turnProcessFold.ts`、`toolCard.ts`、`MessageTimeline.tsx` | 同名测试、`messageTimelineWiring.test.ts`、`processCompletionInteraction.test.ts`、`reviewFindings.test.ts`、`pilabExperienceReplay.test.ts` |
| 台账与本交接 | `docs/plans/2026-10-29-pilab-session-experience-review.md`、`2026-10-29-pilab-session-protocol-map.md`、本文件 | §10～12 记录自动证据和未关闭边界 |

完整文件列表以当前 worktree 的 `git status --short` 为准；不要 reset、checkout 或 clean 掉这些未提交改动。

### 10.6 当前测试结果

以下均为小批串行、`NODE_OPTIONS=--max-old-space-size=1536`、`--maxWorkers=1 --no-file-parallelism`。不同批次存在文件重叠，**不要把数字相加冒充总测试数**。

| 范围 | 当前结果 |
|---|---|
| R0 两组固定回放 | 2 文件、9 项通过 |
| #11 `chatSessionsCore + pilabExperienceReplay` | 修复前新增 4 项失败，修复后 91 项通过 |
| #11 批处理/历史/归并 | 142 项通过 |
| #11 真实 DSH 录制 | 305 项通过 |
| #11 Main `WorkerManager` | 200 项通过 |
| #11 Claude SDK `sdkSessionRuntime` | 88 项通过、1 项既有跳过 |
| #10 本地/远程/编辑器基线最终批次 | 34 项通过 |
| #10 关闭、切换、差异交互 | 16 项通过 |
| R1 核心最终批次 | 191 项通过 |
| R1 时间线接线、ReviewFindings、turn-end | 82 项通过 |
| R1 思考流式、滚动跟随等 | 35 项通过 |
| R1 聚合计时、展开存储、接线守卫 | 210 项通过 |
| Biome | #11 的 5 个、#10 的 15 个、R1 的 9 个改动源码/测试文件检查通过 |
| `git diff --check` | 通过 |
| 全量 `pnpm typecheck` | **未通过：只剩基线夹具 TS2352** |

未执行全量 Vitest 或完整生产构建；只分阶段构建了 Main/Preload 开发产物和 `out-dsh-host`。没有可签核的真实 Electron 场景、截图、IME/DPI、F07 性能、真实多窗口或真实远程写入证据。

### 10.7 尚未解决的风险或问题

1. ~~真实 renderer CDP 无响应是首要阻塞。~~ 已解决（§10.9）。真实 UI 证据目前只有 Linux 开发构建；仍不能把它当成 Windows 目标机或发布包的签核。
2. **当前改动未提交。** 新会话若直接基于远端分支会漏掉全部本阶段整改；必须进入 §10.1 的 worktree 并先核对 dirty 状态。
3. **基线类型检查仍有 TS2352。** 虽不是本阶段新增，但发布门禁尚未全绿。
4. **真实多窗口和真实远程尚未复测**（单窗口编辑器与 Diff 保存已于 §10.9 复测）。 自动顺序写证明了权威基线语义，不等于真实窗口闭环；比较后写入仍非原子 CAS。
5. **原始 PRD 副本缺失。** 当前映射来自仓库台账；如需新增/改变验收规则，必须先取得原始材料，不可自行补写。
6. **F07 性能、预览/差异/窗口矩阵、IME/DPI、深浅主题和窄容器未完成。** R2/R3、视觉样张和发布签核不应提前开始。
7. **真实远程 helper 部署与运行时 ABI 未实测。** 本阶段将 `REMOTE_SERVER_VERSION` 升至 `0.4.1`，但真实远程连接、运行时包和 helper self-test 尚未运行。

### 10.8 上一会话给出的下一步（已于 2026-10-30 下午执行，结论见 §10.9）

**下一会话从 #2 的“真实 Electron renderer CDP 无响应”诊断开始，不要从 R2 或视觉样张开始。**

1. 进入 §10.1 worktree，先执行 `git status --short --branch`、`free -h`、`df -h . /tmp`，确认 31 个左右未提交文件仍在且没有遗留重进程；不要 reset/clean。
2. 复用已安装的依赖和 `out-dsh-host`，用隔离假网关启动，不接触真实模型或私人 profile：

   ```bash
   P17D_SCRATCH=/tmp/pilab-r0 node \
     docs/plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs setup
   P17D_SCRATCH=/tmp/pilab-r0 node \
     docs/plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs launch
   ```

   若 `procs` 显示旧实例，先用同一脚本的 `stop` 按精确进程树停止。不要再直接运行会盲等 5 分钟的 `enter`。
3. 用 `curl http://127.0.0.1:9222/json/list`、原始 CDP `Page.captureScreenshot`、renderer console/problem recorder 定位“页面存在但求值无响应”的根因；区分 GPU/合成器、renderer 卡死、认证/宿主入口和 CDP 客户端问题，并记录实际证据。
4. renderer 可求值后，复用 `/stores/chatSessions.ts` 的真实 store 注入 F01～F05，完成运行、结束、待答、失败、恢复、深浅主题和窄容器基线；再做 F07 性能方法及预览/差异/窗口矩阵，更新 #2。
5. 随后补 #11 的真实恢复、#10 的真实多窗口/远程/Diff 保存和 R1 的真实交互复测；只有这些证据补齐后，才把对应 FR/AC 从“部分通过”改为“通过”。之后再继续 R1 其余条目。

### 10.9 2026-10-30 下午：Linux 真实 Electron 基线（当前最新）

完整证据、复现命令和表格：`docs/plans/evidence/2026-10-30-pilab-r0-real-ui/README.md`（截图 `shots/`、测量 `results/`、驱动 `tools/`）。全部在 `/tmp/pilab-r0` 隔离环境和本地假网关下完成，没有接触真实模型或私人 profile。

**根因结论**：renderer 从未卡死，带硬超时的探针显示求值 1 ms、截图 41 ms、rAF 约 60 帧/秒。上次「求值无响应」实际是三件事叠加：① 未打包模式的引擎布局要 `out-node-runtime/node` 和 `src/dsh-host/node_modules`，只构建 `out-dsh-host` 不够，页面一直停在「没有找到随包的对话引擎」；② 首页 2026-10-14 起隐藏了「使用本机已有配置」，`enter` 找不到入口且错误被吞；③ `enter` 盲等输入框 300 s，共享 CDP 客户端没有单次超时。处理：`node scripts/fetch-node-runtime.mjs` + `src/dsh-host` 里 `npm ci`（均为 gitignore 产物）；`p1-7d-gui.mjs enter` 找不到入口时改走同一处理函数 `auth.enterApp('local')`，等待上限降到 60 s；进入后需跑 `provider` 登记假服务。

**已得到的真实证据（Linux 开发构建，DPR 1）**

| 项 | 结论 |
|---|---|
| F01～F05 + 失败，浅色/深色/720 窄宽 | 34 张截图 + 逐项 DOM 测量。运行中/结束正文都在过程组外可见；F02 结束 9 组全收起、思考不进主区；F03 权限卡停靠；F04「好好」不叠加、同命令两次调用不合并；F05 迟到旧结果不进新回合；三种外观均无横向溢出 |
| #11 真实恢复（DSH） | 空闲时杀宿主、恢复后续聊、优雅重启应用并从侧栏打开、重启后续聊：转录指纹逐步保持，前缀不变；流式中途杀宿主：154 字部分正文保留、两代 history 重放无重复，回合标失败并给「继续」 |
| #10 真实保存 | 普通编辑器（真实 Monaco 输入 + Ctrl+S）和 Diff 编辑模式下，外部 A→B 后保存均被 Main 拒绝、磁盘保持 B、编辑不丢；Diff 有错误提示，普通编辑器**没有任何提示** |
| R1 DEF-003 真实交互 | 运行中手动收起/展开，结束事件到达后选择保持 |
| F07 性能方法 | reducer 折叠 1 万事件 22 ms；每批 256 时单批 p95 1.7 ms；React 提交出现 100～134 ms 长任务（含切换会话挂载，尚未分离）。开发构建，仅作方法基线 |
| 预览/差异/窗口能力矩阵 | 源码盘点完成，关键安全项已抽查（README §8） |

**仍然不能宣称通过的**：AC-39（缺真实多窗口、真实远程）、AC-04/10（缺 Claude SDK 引擎真实恢复、Windows）、AC-01/02/03/06（缺完整页面重载持久化、滚动、Windows 视觉）、AC-21（缺发布包与目标机）、IME/DPI 全部。台账状态保持「部分通过/待验证」，见台账 §13。

**待按原始 PRD 定性的观察**（只记事实，未补写规则）：普通编辑器保存冲突无提示；文件监听依赖文件树挂载；权限与问题同时待答时只露出权限卡；失败回合过程组全部展开；未识别失败统一显示「本应用不认识这一轮的结束原因」；中断的部分正文标为「最终输出」且中断提示排在其上方；只有正文的回合仍显示无箭头的「已工作」；能力矩阵里的安全项（无全局导航拦截、预览窗无打开窗口处理、主窗口 `sandbox:false`、Mermaid SVG 未净化、合并编辑器保存不校验基线）。

**本阶段改动的文件（均未提交）**：`docs/plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs`（`enter` 入口回退与 60 s 上限）、新目录 `docs/plans/evidence/2026-10-30-pilab-r0-real-ui/`、本文件、台账 §13。没有改产品代码。

**下一步行动**

1. ~~请用户定性普通编辑器保存冲突无提示~~ —— 已定为 AC-39 范围并修复，见 §10.10。
2. 真实多窗口：需要能发原生按键的手段（例如用户在本机按 Ctrl+N 打开第二个窗口后，再由脚本接管两个 page target），或在 Windows 目标机上做；远程写入等有远程主机时做。
3. 继续 R1 其余条目（状态、滚动保锚点、权限），每项用本目录的驱动补真实截图与测量；F07 在发布包上复测并把「切换挂载」与「增量提交」分开计时。
4. Windows 目标机：复用同一套驱动跑一遍 F01～F05、深浅/窄宽和 DPI 125%/150%。

### 10.10 2026-10-30 晚：DEF-007 保存被拒无提示（已修复，未提交）

- **用户裁决**：「保存被拒无提示」算 AC-39 范围，先修；横条上的「保留本地」= 用我的版本覆盖刚看到的外部修改（再次被外部改动仍会拦截）。后者取代 §10.3 第 6 条「只有磁盘重载、显式 Reload、成功保存推进基线」——现在显式「保留本地」也推进，推进到的是用户看到的那份外部内容。
- **改动**：新增 `src/renderer/lib/fileSaveFailure.ts`（识别 `FILE_CONTENT_CONFLICT`、可读说明、冲突时读磁盘并打开横条、横条在时不重复提示）；`EditorColumn.tsx`（Ctrl+S/自动保存加 onError、关标签提示改用 helper）；`EditorArea.tsx`（关标签自动保存失败时提示并保留标签；监听到的内容等于基线时不出横条）；`stores/editor.ts`（`dismissExternalChange` → `keepLocalOverExternalChange`）；`useWorktreeSelection.ts`、`useAppLifecycle.ts`、`DiffViewer.tsx`（说明文字统一）；`src/shared/i18n.ts` 两条文案；测试 `src/renderer/lib/__tests__/fileSaveFailure.test.ts`（新）与 `editorWorkspacePreview.test.ts`（更新）。
- **验证**：新/改测试 17 项；相关套件 21 文件 134 项；i18n 覆盖 2 项；Biome 通过；`pnpm typecheck` 仍只有基线 TS2352。真实 Electron（`tools/save-a2b.mjs <file> --keep-mine`）：A→B 后 Ctrl+S → 提示「保存失败：文件在打开后被外部修改过，本次没有写入……」+ 横条；点「保留本地」再保存 → 磁盘为用户版本。截图 `shots/save-a2b-conflict-prompt.png`。
- **仍未覆盖**：文件树未打开时，外部修改仍要等到保存那一刻才发现（监听只随文件树启动）；真实多窗口、远程。
- **下一步**：回到 §10.9 的第 2～4 项（多窗口手段、R1 其余条目、Windows 目标机）。

### 10.11 2026-10-30 晚：R1 其余条目（已修复部分，未提交）

完整表格与证据：`docs/plans/evidence/2026-10-30-pilab-r0-real-ui/README.md` §10。

- **方法**：三路只读源码审计（只用台账条款原文作规则）→ 抽查源码 → 真实 Electron 复现 → 修复 → 自动测试 + 真实复测。审计与真实结果冲突时以真实为准（宿主崩溃时 DSH 工具行 1.5 秒内变「结果未知」，审计所称「停在运行中」不成立）。
- **修复（DEF-008～014，均真实复测或单测覆盖）**：
  - DEF-008 11.1/AC-18：↑ 键、滚动条小幅上拖（< 40 px）被下一段流式内容拉回底部。`nextFollowState` 规则 0（高度不变而上移 = 用户离开）。
  - DEF-009 11.3/AC-19：回合结束自动收起上方过程组，阅读位置上跳 144 px。新增 `readingAnchor.ts` 手动锚定，复测位移 0。
  - DEF-010 13.6/AC-22：中断/停止/失败回合的半截正文标「最终输出」并可能带「完成于」。`splitTurnWorkGroup(…, endedAbnormally)` + `noFinalAnswer`。
  - DEF-011 05.5：审批卡看不到编辑的被替换内容与 `replace_all`、通用/MCP 工具参数，多行命令被截断。新增 `shared/permissions/approvalPreview.ts`，DSH 与 Claude 共用；命令完整换行显示。
  - DEF-012 05.8：审批回复送达失败时无提示。审批卡显示「无法发送你的回答，请重试。」
  - DEF-013 11.4：工具输出框滚动串到主时间线、框内上滚误停跟随。`overscroll-contain` + 滚轮只在滚动时间线时停止跟随。
  - DEF-014 02.6：减少动态效果偏好下箭头仍旋转、提示栏仍平滑滚动。
- **改动文件**：`messageTimelineScroll.ts`、`MessageTimeline.tsx`、`readingAnchor.ts`（新）、`turnProcessFold.ts`、`QuestionCard.tsx`、`ToolRows.tsx`、`LiveToolOutput.tsx`、`chatTimelineLayout.ts`、`PromptNavRail.tsx`、`src/shared/permissions/approvalPreview.ts`（新）、`src/dsh-host/permissions/requestBuilder.ts`、`src/claude-sdk-host/sdkSessionRuntime.ts`；测试 `readingAnchor.test.ts`（新）、`messageTimelineScroll.test.ts`、`turnProcessFold.test.ts`、`pendingPermissionDock.test.ts`、`toolRowArg.test.ts`（类名守卫跟随）、`permissionHost.test.ts`、`sdkSessionRuntime.test.ts`。驱动 `tools/scroll-r1.mjs`（新）。
- **验证**：`src/renderer/components/chat/__tests__` 全部 197 个文件分 5 批串行全部通过（修正 toolRowArg 守卫后）；DSH 权限/桥接 6 文件 163 项；SDK 90 项（1 项既有跳过）；`bridge-smoke` 72 项判定全部为真；`pnpm typecheck`（仅基线 TS2352）、`typecheck:dsh-host`、`typecheck:claude-sdk-host` 通过（后者先在 `src/claude-sdk-host` `npm ci`，gitignore 产物）。
- **待用户裁定**（不改代码）：① 切回会话时阅读位置与手动展开的过程组是否保留（11.6/AC-20）；② 「思考中」在工具后/首字节前是否改「工作中」（02.5，与 2026-10-17 决定冲突）；③ DSH bash 行用命令还是 description（05.2，与 2026-09-22 裁决冲突）；④ 工具输出的查看全部/复制/搜索/导出与 stdout/stderr 分开（05.3，新功能范围）；⑤ 宿主崩溃显示失败红卡还是待同步、恢复后是否标「已恢复」（05.9/13.4）；⑥ `session_busy` 自动重发是否算第二层重试（13.2）；⑦ 长消息折叠按估算行数约 223 px（01.5）。
- **未覆盖**：Claude SDK 引擎实机（重开会话会丢失中断标记，审计已确认，需 SDK 环境后再改）、触摸、IME/DPI、Windows。
- **下一步**：等用户对 ①～⑦ 裁定；有 Claude 引擎环境后补 SDK 中断历史；然后进入 R2。

### 10.12 2026-10-30 晚：用户对 R1 七项裁定的处理（未提交）

| # | 用户裁定 | 处理 |
|---|---|---|
| ① 切回会话保留阅读位置与展开 | 同意做 | 已改：每个会话在内存里记阅读位置与过程组展开（展开存进工具展开 store，键 `group:<groupKey>`）；真实复测 A→B→A 位置 706 与第 2 组展开均恢复。不跨重启 |
| ② 「思考中」 | 按 Claude Code 写法 | 不改，02.5 按用户裁定关闭 |
| ③ shell 行显示用途 | 有用途就显示用途 | 已改：DSH bash / pwsh 行优先显示 `description`，无则命令摘要；命令仍在展开体第一行。取代 09-22 裁定与决策 073 第 2 条。真实复测「终端 Run a long command」（`shots/r1-shell-row-description.png`） |
| ④ 工具输出的查看全部/复制/搜索/导出 | 按推荐 | 列入 R2：先做「复制全部」「查看全部」，搜索、导出、stdout/stderr 分开后置 |
| ⑤ 引擎崩溃的显示 | 按推荐：先出 HTML 预览 | 方案并入 `docs/design/2026-10-30-turn-display-claude-code-preview.html`「引擎中断」页，待用户确认 |
| ⑥ `session_busy` 自动重发 | 问由谁控制、常见做法 | 已查：渲染层控制，只在引擎拒收（上一轮未收尾）时 250 ms × 最多 8 次，见到引擎收下即停、可被停止打断、不会调用模型；建议保留 |
| ⑦ 长消息折叠 | 调整 | 已改：有排版时按文本框实际总高度判断，超过 340 px 折到 300 px（带回滞，防止滚动条出现/消失造成反复）；无排版时按估算行数兜底。真实复测 488 px 与 296 px 宽都折到 300 px（`shots/r1-prompt-fold-*.png`） |

改动文件：`toolCard.ts`、`chatTimelineLayout.ts`、`MessageTimeline.tsx`；测试 `dshToolVocabulary.test.ts`、`promptFold.test.ts`、`userBubbleFeaturesMount.test.ts`、`messageTimelineWiring.test.ts`（T12 不变量收窄为「不读滚动位置与元素位置」）。

### 10.13 2026-10-30 晚：用户指出主目标未达成——对话主区仍堆满思考与调用

- **用户原话**：「本次的主要目的怎么还是没什么改进，对话中还是显示一大堆思考、调用啥的，没有达到我希望的那种对话主题中尽量展示有效信息的感觉，就类似目前的 claude code cli，显示的信息都是有效的，至少用户知道目前在干嘛，做了什么，输出结果是什么。」
- **现状核对**（真实截图 `shots/f02-running-light.png`、`f02-ended-light.png`）：运行中每次读文件一行、每段思考一行，工具行没有结果；结束后变成一排「已工作 ›」，看不出做了什么、结果如何。R1 前面的修复（正文不被折、思考聚合、偏好保持）没有改变这个观感。
- **参考**：Claude Code 2.1.307 安装包核对：连续读/搜索合成「Searched for N patterns, read N files」（运行中「Reading…」），编辑带 +/− 行数，子代理「Done (N tool uses · tokens · time)」，思考不占行。
- **方案与预览**：`docs/design/2026-10-30-turn-display-claude-code-preview.html`（运行中 / 已完成 / 引擎中断三态，左当前右建议；完成后可切「保留每步摘要 / 收成一行」）。五条规则：读与搜索合一行；改文件、命令每次一行带一行结果；思考不占行，回合末尾留「思考 N 秒」可点开；正文直接可见；结束后保留摘要行不再收成「已工作 ›」。
- **下一步**：用户确认预览后，这项成为 R1 的最高优先级，先于 R2；实现要点：`toolCard.ts` 行模型增加结果摘要与读/搜索合并，`turnProcessFold.ts`/`MessageTimeline.tsx` 改为摘要行常驻、思考移到状态行与回合脚注，引擎中断按预览改为中性提示 +「已重新连接」。

### 10.14 2026-10-30 晚：对话主区按步骤显示（用户批准预览后实现，未提交）

- **用户裁定**：预览效果可以，按推荐做（保留每步摘要；引擎中断按预览）。随后补充：操作交叉时仍一行一个，希望优化；但「也没必要强行优化」。
- **实现**：
  - 新增 `src/renderer/components/chat/turnSteps.ts`：思考不进步骤列表；同一段工作（两段正文之间）里的读/搜索合成一行「搜索了 2 处，读取了 5 个文件」（运行中「正在…」），改文件合成一行「修改了 2 个文件 +2 −1」，各放在该类第一次出现的位置，点开是逐条明细；命令、失败、被拒绝、自动审批的各占一行。每步下面一行结果（命令最后一行输出与总行数、失败首行、结果未知警告）；`(no output)` 与临时文件路径不显示。说明：Claude Code 2.1.307 主界面只合并相邻的读/搜，按段累计的 `toolStats` 用于子代理汇总；这里多走一步，一个判断就能退回「只合并相邻」。
  - `MessageTimeline.tsx`：过程组不再折叠成「已工作 ›」（`STEPS_INLINE`），只有思考的组不画；运行中的状态行移到回合底部；结束后底部账单「✻ 完成于 · 用时 · N 次工具调用 · 思考 N 秒」，「思考」可点开原文（重开会话没有计时时显示「思考」）。取代决策 034/037 中「时长在第一行、尾栏不放时长」的裁定。
  - `ToolRows.tsx`：结果行、运行中命令的最后 3 行（折叠时）、改文件的 +/− 始终显示（含审阅栏记录的变更）、普通「已允许」不再显示、合并步骤的明细缩进。
- **真实验证**（`shots/steps-*.png`）：F02 67 次调用 → 9 行；真实 DSH 回合 12 次调用 → 5 行（`steps-real-fs-turn-merged.png`）。
- **引擎中断（预览第 3 态，已做）**：`sessionFailure.ts` 新增 `isEngineInterruption`（`dsh_host_crashed` / `dsh_engine_restarted` / `claude_engine_exited`），卡片改中性样式（暂停图标），标题「这一轮没有完成」，正文「…上面的内容都已保留」，下面一行「正在重新连接…」→「已重新连接」（以 Main 重新绑定会话为准）；「继续」照旧；回合下不再出现红色「失败」；侧栏不标失败。真实验证：流式中途杀宿主 → 中性卡片 + 「已重新连接」（`shots/interrupt-reconnected.png`）。
- **测试改动**（按新设计改写或更新，未放宽生产规则）：`historyTurnClock`、`timelineClockRemount`、`turnEndReplayMount`、`turnEndOpenInteraction`、`processCompletionInteraction`、`timelineDisclosureFollow`（删 C3-FOLLOW-4，思考改由底部开关验证）、`interjectionDeliveryMount`、`messageTimelineWiring`（WG-WIRE-7/8、行高计数）、`sessionFailure`、`dshStreamReplay`（命令改从展开体读）；新增 `turnSteps.test.ts`。重开会话没有思考计时时底部仍显示可点开的「思考」（修复中发现的缺口）。

### 10.15 2026-10-30 晚：Claude 引擎重开会话的中断显示（R1 收尾，未提交）

- **背景**：此前以为本机跑不了 Claude 引擎；实际在 `src/claude-sdk-host` 里 `npm ci` 后，fake-1（Anthropic 协议）的新会话就走 Agent SDK 引擎，并能连本地假网关（`claude-sdk` 剧本）。实测记录见证据 README §11。
- **问题**（DEF-015～017）：`sdkSessionRuntime.ts` 的 `readTranscript` 把 CLI 的 `[Request interrupted by user…]` 当杂项丢掉，也没有从记录里取时间。重开后被停的回合像正常结束，工具行显示英文原句像失败，没回复就停的回合什么都不显示，所有回合没有「完成于 / 用时」；失败行露出 `<tool_use_error>` 标签（现场也有）。
- **修复**（只改 SDK 宿主读历史，渲染层未动）：
  - 中断标记 → 该回合最后一条回复标 `stopCause: user_stop`；没有回复时补一条空的未完成回复（`stopReason: aborted`），渲染为「这一轮已停止，没有保存任何回复」。与 DSH 历史投影的两种形状相同。
  - 紧挨着标记前的失败工具结果标 `stopped`（「已停止」）；本应用拒绝的（「The user declined this tool call.」）标 `refused`，停止时仍在审批的（「The turn was stopped.」）标 `notStarted`，CLI 自己的安全检查拒绝标 `refused`。
  - 「立刻发送」也写同一个标记，靠「标记前已有未出队的 enqueue」认出来，不标停止（现场也不标）。
  - 每行时间从记录文件取（SDK 的读取接口不给）；回合中插话按送达时刻（它的 `queued_command` 行记的是排队时刻，取它和上一行中较晚的）。
- **已知差异**：审批卡待答时停止，现场是「已拒绝 · 自动：已中止 · 未执行」，重开后是「已停止」——两种情况 CLI 写的记录完全相同，分不出来。
- **测试**：`sdkSessionRuntime.test.ts` 新增 `[PILAB-R1-CC-STOP]` 7 项（用实测记录的形状）；SDK 宿主 14 个文件 215 项通过（1 项既有跳过）；`typecheck:claude-sdk-host` 通过。真实界面：同一会话 11 轮，停止、拒绝、Esc、立刻发送、插话、读取合并、修改合并都在重启应用后与现场一致。
- **工具改动**：`p1-7d-gui.mjs` 支持 `P17D_GATEWAY_PLAN`；`fake-gateway.mjs` 的 `CC-TEXT` 支持 `chunkMs`。

### 10.16 2026-10-30 晚：R2 输入框（未提交）

- 第 2 步已提交为 `6f38997c`（本地，未推送）。
- **审计与复现**：两路只读审计后，用 `docs/plans/evidence/2026-10-30-pilab-r0-real-ui/tools/composer-r2.mjs` 在真实应用里复现（输入法事件、`@` 菜单按键）。详见台账 §16。
- **修复**：
  - `fileMention.ts`：`@` 词按 Claude Code 的规则读（行首或空白后；`@"带 空格/的路径"`）；选中时替换整个词；路径有空格自动加引号；标签认引号写法。
  - `ChatComposer.tsx`：`@` 菜单 Tab 选中；光标移动（`onSelect`）后菜单跟随；搜索把 `\` 当 `/`；只采用最新一次搜索结果；选中行滚进视野；离开对话时没点的「重试」把消息和附件放回该对话草稿。
  - `useComposerAttachments.ts`：附件记住在哪个对话开始读，切走后读完的交给原对话（`offerDraft`）；读取计数按对话分开。
  - `QuestionPrompt.tsx`：「其他」输入框用 `isImeComposing`。
- **注意**：「立刻在输入法上屏后紧跟普通回车」不算缺陷——Windows/Linux 上那就是用户再按一次回车，应当发送（探针第一次就因此真的发出了一条消息，已从默认探针移除）。
- **用户裁定**：见台账 §16。做四项：未知命令提示、找不到的引用、拖放附件、重启简短提示（预览 `docs/design/2026-10-30-composer-r2-preview.html`）；不做发送键偏好、中文后 `@`、菜单无障碍角色。

### 10.17 2026-10-30 晚：R2 输入框第二批（用户裁定的四项，未提交）

- 上一批已提交并推送：`84217862`（`origin/feat/pilab-session-experience-r0`）。
- 本批：未知命令提示、找不到的引用、拖放附件、重启简短提示。详见台账 §17。
- 关键文件：`ChatComposer.tsx`、`slashCommands.ts`（`unknownSlashCommand`）、`useMissingMentions.ts`（新）、`useComposerAttachments.ts`（`ingestDropped`）、`stores/composerDrafts.ts`（`lost`/`cut`、`takeDraftRestoreNote`）、`App/hooks/useFileDragDrop.ts` + `fileDragDrop.ts`（`data-file-drop-target`）、`styles/globals.css`（`drop-target`）、`shared/i18n.ts`。
- 注意：拖放不能走 ⊕ 的按路径读取——Main 的 `file:readAttachment` 只认自己对话框给出的路径（`PickedAttachmentAccess`），这是安全边界，不要放宽；拖放用 `File` 本身的内容。
- 本机测试工具：`tools/composer-r2.mjs r2b <文件>`（CDP `Input.dispatchDragEvent` 可带真实文件路径）。

