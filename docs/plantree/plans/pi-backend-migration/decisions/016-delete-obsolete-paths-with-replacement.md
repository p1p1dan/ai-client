# D16 — 替代即删除，不保留 legacy 兼容路径

**状态**：已拍板（2026-08-31）

**补充**：[D14 — Pi-only 产品范围与 legacy 会话导入](./014-pi-only-product-and-conversation-import.md)、[D15 — Main-owned WorkerManager](./015-main-owned-worker-manager.md)

## 决策

本项目仍处于未正式发布的开发阶段。Pi-only migration 不以“旧 runtime 继续可运行”作为兼容目标；一个旧执行路径、入口、产物、依赖、测试或产品分支一旦已有足够替代边界，就在同一切片或紧随其后的 cleanup gate 删除，不集中保留到迁移末期。

Git 历史和可回退提交是旧实现的恢复手段；工作树不承担源码博物馆或应用内 rollback 的职责。

## 执行规则

1. **替代行为，不保留旧实现**：先确认必须保留的产品/安全 invariant 已进入新 contract 和 focused tests，然后删除旧 source、exports、consumer branches、tests、fixtures、scripts、dependencies 和 generated artifact assertions。
2. **同切片删除**：`replace` 项不再默认等到 T35。其替代者通过当前切片验收后，该切片必须清除旧 authority；若仍有 consumer，consumer migration 是当前切片的工作，不是保留 fallback 的理由。
3. **纯 legacy 立即删除**：无 Pi-only 产品、迁移或证据角色的 Claude/Codex execution 代码与产物无需等待对应新功能一一复刻；确认无必要 invariant 后直接删除。
4. **产物只含活动入口**：worker artifact 不再构建或验证 transition-only `index.js`/`piHost.js`；依赖清单、budget、packaging smoke 只为实际 Pi worker/Pi CLI 负责。
5. **无运行时开关**：不增加 `ACTIVE_BACKEND`、legacy driver、兼容 alias、隐藏 fallback 或“暂时可切回”设置来延长旧路径寿命。
6. **保持可验证，不保持兼容**：每个删除批次结束时仍需 typecheck、focused tests、artifact/static import checks 通过；允许开发期间功能暂时未接 UI，但不接受长期编译失败或悬空 import。
7. **证据不是 production dependency**：旧调查结论保留在 plantree/git；无 importer 输入价值的 fixture/spike/test 可删除，不以“也许以后有用”为由留在活动源码树。

## 明确保留的例外

以下不是 legacy runtime 兼容，按各自产品角色保留：

- T34 所需的 Claude/Codex **只读 source adapters/fixtures**，但必须尽早移入独立 migration namespace，并通过 static import ban 证明无 execution 能力；
- Pi permission policy、managed/local agentDir/auth/models、RuntimeEvent/timeline/queue/Extension UI 等已确认 Pi-only 产品与安全行为；
- 通用 terminal、filesystem、redaction、atomic persistence 等无 legacy execution ownership 的基础设施；
- plantree evidence、Git 历史和依法必须分发的第三方 license notice。

## 对当前路线的直接影响

- **T29-c** 除完成 `newSession → send → stream → stop → dispose` 外，必须删除被新单-slot runtime 替代的 singleton Pi entry、router 和 transition artifacts；不得继续同时构建 `worker.js`、`piHost.js`、legacy `index.js`。
- **T30** 在 WorkerManager 接管 lifecycle 后立即删除 `AgentHostManager`、`AgentHostProcess`、legacy host env/router，不等 T35。
- **T31** 每重挂一组 Cycle 1/2 行为，就同步删除对应 old Host/agent/backend branches 和 tests。
- **T34** 先隔离真正需要的只读 readers；不需要 importer 的 Claude/Codex execution source 可更早删除。
- **T35** 从“大批量删除阶段”改为最终 Pi-only absence audit：清残留 import、dependency、IPC、文案、fixture、artifact 和 compatibility alias。

## 风险与控制

- 激进删除可能提前暴露尚未迁移的真实 consumer；这是有价值的依赖发现，不应通过恢复 fallback 掩盖。
- 删除前使用 T28 文件图和静态引用检查区分 execution、migration-only 与 runtime-neutral assets，避免按文件名误删。
- 删除批次保持小而可提交；出现问题优先用 Git 回退该批次，而不是把旧 runtime 重新接回产品。
