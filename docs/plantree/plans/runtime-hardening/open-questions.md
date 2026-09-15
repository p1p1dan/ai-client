# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q012 | extensionUi 整链是否退役？ | cutover-06：`uiContext` 全仓唯一调用点被 `bootstrap.ts` 的 `?? approval?.approve` 永久遮蔽（nativeWorkerRuntime 恒传 `permissions.approve`）；T025 核实后转交 T026；T026 落地后侧栏能力面板已不依赖它（`capabilityEntryStatic.test.ts` 钉住 LeftDock 不再读 `useExtensionUiDisplayStore`）；约 3700 行渲染层专属代码（ExtensionUiDialog / ExtensionUiSurfaces / extensionUiModel / stores/extensionUi 等）+ Main/preload/IPC/shared 约 150 处触点；T023（两个提交前）刻意保留 `createRuntimeApprovalBridge` 与 `ExtensionUiRequest` 类型；当前只有 `extensionUiBridge.ts` 模块头注释说明「无调用方」。选项 A（编排者建议）：整链删除——native 从不加载 pi 扩展，已无任何生产者；删后 T023 的 approval bridge 需改为直接产出权限卡结构，或一并删除。选项 B：保留——若未来 GUI 会话重新加载 pi 扩展可复用。 | 新开 T036（待拍板后派） |
