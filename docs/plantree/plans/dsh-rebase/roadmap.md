# DSH 二开迁移 roadmap

任务身份、状态、顺序的唯一权威。编号本计划内有效，前缀即阶段。分期依据见[调研 §5](../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)。

## P0 探针（待开工，约 1.5 人周 + 1 次上机）

原型性质：放在独立主题分支与独立子包里，不进默认构建、不改 1.0.x 行为；目的只是回答「能不能走」。

| ID | 状态 | 内容 | 退出判据 |
|---|---|---|---|
| P0-1 | ✅ | 宿主骨架与资源探针（2026-09-25 落地：代码 `49d0fbd6`，分支 `feat/dsh-p0-probe`；证据 [p0-1-host-probe-2026-09-25.md](evidence/p0-1-host-probe-2026-09-25.md)；数据支持共享宿主，Q001 在 P0-5 裁决。更正：`webserver` / `frontend-static` 只在 `dsh-web-app` 里，`dsh-base` 本来没有；实际关掉的是遥测、`deepseek-account`、`llm-deepseek-account`、`hmr`）：独立子包（仿 `src/runtime/` 的独立 npm 子包形态）写 `@aiclient/dsh-app` bundle，叠在 `dsh-base` 上，关掉 `host/webserver`、`frontend-static`、`session-telemetry-otel`、`deepseek-account`，用 `dsh-app-boot` 启动；由 WorkerSlot 以随包 node 拉起。测单宿主空载常驻内存、每多一个会话的增量、冷 / 热启动时间，同机对比我方现有 worker | 宿主能起能停；三组数字落证据，供 [Q001](open-questions.md) 裁决 |
| P0-2 | ⬜ | 原样挂 goal 四件套（`dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver`、`dsh-command-goal`）与 `dsh-tool-todo`、`dsh-tool-jobs`，再从社区目录挑一个纯宿主、无 `dsh.client` 的插件；模型经 `llm-pi-ai` 路由到我方网关 | goal 能自动续跑，并能走到完成、阻塞、暂停三种终态；社区插件能装能跑 |
| P0-3 | ⬜ | 最小 bridge：DSH 会话事件 → 现有 RuntimeEvent，走现有 worker RPC；文本、工具行、一张审批卡能来回走通；DSH 引擎只在开发开关后可见 | 开发机 GUI 里文本、工具行、审批卡往返无误 |
| P0-4 | ⬜ | 加密机上机包：DSH 宿主经 `node.exe` 执行 read / write / edit / grep / glob，bash 与 pwsh 各测，会话写入后回读；`sandbox-windows-acl` 开、关各一次；另装官方 DSH Desktop 0.1.7 作对照组。产出上机检查单与一键脚本，由用户上机执行 | 读写全部明文；沙箱结论回填 [Q002](open-questions.md) |
| P0-5 | ⬜ | P0 收口：汇总证据，裁决 Q001 / Q002 / Q004，给出进不进 P1 的结论，必要时回到[决策 001](decisions/001-route-b-and-scope.md) | 结论与证据落 `evidence/`，用户确认后进 P1 |

建议顺序：P0-1 → P0-2 → P0-3；P0-4 的检查单在 P0-1 后即可起草，上机放在 P0-3 之后一次做完。

## Next

- **P1 双引擎（6～8 人周）**：bridge 与 RuntimeEvent 完全对等（录制事件流做回归门禁）；权限移植（决策 001 第 3 条）；模型目录与凭据接缝；旧会话按需转换（只复制不改原文件）；渲染层补 goal 条、todo 卡、jobs 面板、子代理面板（吸收 runtime-hardening 的 D3 / D4 / D7 / D8 / T138）；防空转与 500 轮上限做成宿主插件。
- **P2 默认切换（3～4 人周 + 1 次上机）**：默认引擎改为 DSH；CC / Codex 导入改出 DSH 格式；定内嵌终端去留（[Q003](open-questions.md)）；原生 runtime 冻结并保留一个版本作回退；定 DSH 升级节奏；回写 ARD。

## Deferred

- **P3（L2，8～12 人周，未立项）**：聊天区换成 DSH Web 客户端。P2 之后按插件需求再议。
