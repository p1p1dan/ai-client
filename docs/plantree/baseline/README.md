# Baseline — 项目全局事实

> 这里保存跨计划稳定事实、当前目标边界和 release gates；具体任务状态属于各 plan roadmap。2026-08-31 前的 Claude/Codex/standalone-host 基线完整快照见 [`../history/2026-08-31-pre-pi-only-baseline/`](../history/2026-08-31-pre-pi-only-baseline/)。

## 当前产品方向

- 产品收敛为 **Pi-only**；Claude/Codex conversation runtime 进入 replacement/removal 路线。
- 目标 runtime topology：Renderer → Preload → Main-owned WorkerManager → bounded WorkerSlot → utilityProcess Pi AgentSession。
- 当前代码仍处于过渡态，保留 singleton `PiHostProcess`、旧 multi-runtime 和 legacy dependencies；不能把目标基线误读为已完成实现。
- 方向、状态和任务权威见 [Pi-only plan](../plans/pi-backend-migration/README.md)、[D14](../plans/pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md)、[D15](../plans/pi-backend-migration/decisions/015-main-owned-worker-manager.md)。

## 文件

| 文件 | 内容 |
|---|---|
| [module-map.md](./module-map.md) | 稳定模块键、目标 ownership 与 legacy replacement inventory |
| [runtime-flows.md](./runtime-flows.md) | create/send/stop/resume/import/TUI 目标事件流与过渡差异 |
| [storage-and-state.md](./storage-and-state.md) | Pi session、managed config、pool/slot/import 状态归属 |
| [risk-hotspots.md](./risk-hotspots.md) | WorkerSlot、导入、权限、资源、TUI 与打包风险 |
| [test-and-release-gates.md](./test-and-release-gates.md) | 小批测试、typecheck、Biome、packaged/RC 与资源门禁 |

## 技术栈

Electron 39 + React 19 + TypeScript 5.9 + Tailwind 4 + Zustand + Vitest + Biome；Pi SDK 运行在 utilityProcess worker，Main 不直接加载 Pi SDK。UI 优先使用 `@coss/ui`，设计约束见 [`docs/design-system.md`](../../design-system.md)。
