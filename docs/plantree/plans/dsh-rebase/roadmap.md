# DSH 二开迁移 roadmap

任务身份、状态、顺序的唯一权威。编号本计划内有效，前缀即阶段。分期依据见[调研 §5](../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)。

## P0 探针（进行中，平台门槛为 Linux + 普通 Windows）

原型性质：放在独立主题分支与独立子包里，不进默认构建、不改 1.0.x 行为；目的只是回答「能不能走」。2026-09-26 起加密机移出 P0 门槛，挪到 P2 前（[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)）。

| ID | 状态 | 内容 | 退出判据 |
|---|---|---|---|
| P0-1 | ✅ | 宿主骨架与资源探针（2026-09-25 落地：代码 `49d0fbd6`，分支 `feat/dsh-p0-probe`；证据 [p0-1-host-probe-2026-09-25.md](evidence/p0-1-host-probe-2026-09-25.md)；数据支持共享宿主，Q001 已由[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md) 定为共享宿主。更正：`webserver` / `frontend-static` 只在 `dsh-web-app` 里，`dsh-base` 本来没有；实际关掉的是遥测、`deepseek-account`、`llm-deepseek-account`、`hmr`）：独立子包（仿 `src/runtime/` 的独立 npm 子包形态）写 `@aiclient/dsh-app` bundle，叠在 `dsh-base` 上，关掉 `host/webserver`、`frontend-static`、`session-telemetry-otel`、`deepseek-account`，用 `dsh-app-boot` 启动；由 WorkerSlot 以随包 node 拉起。测单宿主空载常驻内存、每多一个会话的增量、冷 / 热启动时间，同机对比我方现有 worker | 宿主能起能停；三组数字落证据，供 Q001 裁决 |
| P0-2 | ✅ | （2026-09-25 退出判据已满足，代码 `2dde0430`；证据 [p0-2-goal-and-plugins-2026-09-25.md](evidence/p0-2-goal-and-plugins-2026-09-25.md)。三种终态都走到了：完成、阻塞（模型上报一次，轮数上限一次）、暂停后恢复；社区插件选 `dsh-office-tools@1.0.4`，经 plugin-manager 安装、重启激活、`word_create` / `word_read` 通过。模型只经 `llm-pi-ai` 打本地假网关，官方相关 9 行已关，含会上传会话日志的 `session-log-deepseek`。新发现：宿主启动目录和 `$DSH_HOME` 下的 `.env` 会进工具环境；DSH 只在申请越出沙箱时审批）原样挂 goal 四件套（`dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver`、`dsh-command-goal`）与 `dsh-tool-todo`、`dsh-tool-jobs`，再从社区目录挑一个纯宿主、无 `dsh.client` 的插件；模型经 `llm-pi-ai` 路由到我方网关 | goal 能自动续跑，并能走到完成、阻塞、暂停三种终态；社区插件能装能跑 |
| P0-3 | ✅ | （2026-09-25 退出判据已满足，代码 `a6f0795f`；证据 [p0-3-bridge-2026-09-25.md](evidence/p0-3-bridge-2026-09-25.md)，截图在 [p0-3-gui-2026-09-25/](evidence/p0-3-gui-2026-09-25/)。接缝选 (a)：开发开关 `AICLIENT_DEV_ENGINE=dsh` 打开且应用未打包时，`createPiWorkerSlot` 改为用随包 node 拉起 DSH 宿主，宿主里的 `aiclient-bridge` 行用原样的 `PiWorkerRpcServer` 加 `DshSessionRuntime` 讲 worker RPC；渲染层没改，`src/agent-host` / `src/shared` / `src/runtime` 也没改。GUI 里流式正文、bash 工具行从运行中到完成、审批卡允许和拒绝都走通了，另有无界面 `bridge-smoke.ts` 作回归。映射表和缺口写在证据里：历史 / 用量 / 权限档位 / goal·todo 事件留给 P1；逐次审批要挂 `tools/pre-execute`）最小 bridge：DSH 会话事件 → 现有 RuntimeEvent，走现有 worker RPC；文本、工具行、一张审批卡能来回走通；DSH 引擎只在开发开关后可见 | 开发机 GUI 里文本、工具行、审批卡往返无误 |
| P0-4 | 🔧 | 普通 Windows 实测（2026-09-26 按[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md) 改范围，原「加密机上机」挪到 P2 前）：在 GitHub Actions `windows-2022` runner 上跑现成的 P0-4 工具包与 `run-p0-4.ps1`（加密目录换成普通目录，不跑 `-ControlGroup`）。覆盖 read / write / edit / grep / glob、bash 与 pwsh、会话写入后回读与再次打开、`sandbox-windows-acl` 开关各一次、原检查单 ①～⑤ 里除「明文 / 密文」判断以外的部分：原生 DLL 加载（`NARB_DISABLE_NATIVE_CACHE` 开关各一次）、koffi 写锁、`conpty.node` 加载、spill 根目录权限、pnpm 装插件。工具包构建与 Linux 预演见 [evidence/p0-4-kit-2026-09-25.md](evidence/p0-4-kit-2026-09-25.md)。注意 runner 以管理员身份运行，与普通办公机的权限不同，证据里要注明 | CI 上一键脚本全部项通过，或每个失败项都有定位结论；报告与运行链接落 `evidence/` |
| P0-6 | ⬜ | 共享宿主补验（决策 002 第 3 条，Linux 开发机）：① 宿主被杀后自动重启，用 `agents.resume` 恢复会话，恢复后能继续回合；② 多会话同时跑回合时的事件循环延迟；③ 带历史（例如几百条消息）的会话的内存 | 三项数据落证据；① 不成立时回到决策 002 重议 |
| P0-5 | ⬜ | P0 收口：汇总 P0-1～P0-4 与 P0-6 的证据，裁决 Q004，给出进不进 P1 的结论，必要时回到[决策 001](decisions/001-route-b-and-scope.md) / [002](decisions/002-defer-encrypted-machine-and-shared-host.md) | 结论与证据落 `evidence/`，用户确认后进 P1 |

顺序：P0-1 → P0-2 → P0-3 已完成；P0-4 与 P0-6 可以并行，两项都完成后做 P0-5（编号不重排，P0-6 排在 P0-5 之前）。

## Next

- **P1 双引擎（6～8 人周）**：bridge 与 RuntimeEvent 完全对等（录制事件流做回归门禁）；权限移植（决策 001 第 3 条）；模型目录与凭据接缝；旧会话按需转换（只复制不改原文件）；渲染层补 goal 条、todo 卡、jobs 面板、子代理面板（吸收 runtime-hardening 的 D3 / D4 / D7 / D8 / T138）；防空转与 500 轮上限做成宿主插件。
- **P2 默认切换（3～4 人周 + 1 次上机）**：
  - **前置：加密机上机与适配**（[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)，原 P0-4 范围）：用现成的上机包与[检查单](topics/p0-4-encrypted-machine-checklist.md)，DSH 宿主经随包 `node.exe` 在加密目录里执行各工具，结果与明文标记比对；`sandbox-windows-acl` 开关各一次，结论回填 [Q002](open-questions.md)；另装官方 DSH Desktop 0.1.7 作对照组。有上机机会可以提前跑；不过就回到决策点。
  - 默认引擎改为 DSH；CC / Codex 导入改出 DSH 格式；定内嵌终端去留（[Q003](open-questions.md)）；原生 runtime 冻结并保留一个版本作回退；定 DSH 升级节奏；回写 ARD。

## Deferred

- **P3（L2，8～12 人周，未立项）**：聊天区换成 DSH Web 客户端。P2 之后按插件需求再议。
