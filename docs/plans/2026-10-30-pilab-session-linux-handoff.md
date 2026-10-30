# PiLab 会话体验与输出展示优化：Linux 接续 Handoff

交接日期：2026-10-30
原始基线：`69f2e45511cd9ed2d5a7b19b2671671fb32bda93`
工作分支：`feat/pilab-session-experience-r0`
目标 ID：`1793287022307-9eadbf`

## 1. 当前进度结论

已完成 R0 第一段：全量复核台账、源码/测试入口、协议映射和 F01～F08 脱敏固定回放。R0 第二段仍在进行：真实 Electron UI、性能及预览/差异/窗口能力基线尚未完成。

**尚未开始产品行为整改。** 当前提交只包含文档和测试支持文件，不能宣称任何 FR/AC 已通过，也不能宣称 R0 全部完成。

| 任务 | 状态 | 说明 |
|---|---|---|
| #1 R0 全量台账 | 已完成 | FR-01～14、沟通、非功能和 AC-01～45 已逐项建立记录 |
| #2 协议/回放/真实基线 | 进行中 | 协议映射和固定回放已完成；真实 Electron/性能/能力矩阵未完成 |
| #11 消息与传输事件幂等 | 待办，S0 前置 | #2 后、R1 前执行 |
| #10 文件保存基线 | 待办，S0 前置 | #2 后、R1 前执行 |
| #3 R1 核心阅读 | 待办 | 等 #2、#10、#11 |
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

## 3. 本次提交文件

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

| 缺陷 | 等级 | 证据 | 下一步 |
|---|---|---|---|
| DEF-001 运行/中间正文随过程折叠 | S1 | `turnProcessFold.ts:140-190`；`MessageTimeline.tsx:2927-2956` | #3：正文与执行详情分离，不能只提取最终段 |
| DEF-002 thinking 逐块成行且运行组默认展开 | S1 | `toolCard.ts:1531-1566`；`turnProcessFold.ts:248-251` | #3：单一工作单元过程入口，思考默认收起 |
| DEF-003 完成时过程展开偏好丢失 | S1 | `MessageTimeline.tsx:2924-2926` 的 key 含 processSettled | #3：按稳定工作单元保存，不被完成事件覆盖 |
| DEF-004 保存无内容基线校验 | S0 | `main/ipc/files.ts:580-591`；`useEditor.ts:91-99`；`DiffViewer.tsx:876-909` | #10：所有既有写入口提交基线，Main 权威校验，A→B 冲突不覆盖 |
| DEF-005 重复 message.started 清空正文 | S0 | `chatSessions.ts:2056-2083`；旧测试 `chatSessionsCore.test.ts:63-99` | #11：按 messageId 幂等保留 blocks、合并合法元数据 |
| DEF-006 同一传输事件重放重复消费 | S0 | `chatSessions.ts:2592-2604`；Main seq 在 `WorkerManager.ts:5178-5185` | #11：同一 session/seq 重放幂等，不同 seq 的合法相同 delta 保留，明确 resumed 序号边界 |

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
