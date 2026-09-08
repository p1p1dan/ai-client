# P1 本机实现与验证记录

日期：2026-09-08 · 本次探针基础 HEAD：`8db604f5` · **P1 代码尚未提交**。
[执行 TODO](../../TODO.md) · [看板](../../README.md) · [契约](../../topics/p1-0-host-contracts.md)

## 结论

P1-0 出口和 P0 迁移、六工具及审批桥接已实现；按 D14 返工了工具裁剪、权限核心、旧值映射
和提示词贡献。**P1 整体仍为进行中**：P1-6 renderer 两模式/三档、偏好迁移和两轴传递已实现，打包 GUI 尚未签收；
Bash AST/策略导入已实现，真实项目兼容及 P1-9/P2-8 配对待签收；P1-8 Windows 随包 Node 与企业加密机验收未执行。
旧 69 项是 D14 前的历史口径，本次 79 项结果仅覆盖当前已实现范围。

| 检查 | 结果 | 证据 |
|---|---|---|
| 类型检查 | 根工程、agent-host、runtime 均通过 | 根工程堆上限 1536 MiB，agent-host/runtime 768 MiB，三项串行执行 |
| P1-5 本轮 native 回归 | 9 文件、109 项通过（各文件取最后一次结果）；106 项分批日志 + 专项更新 26 项 | [policy-tests.txt](policy-tests.txt)、[shell-tests.txt](shell-tests.txt) |
| D14 上批回归 | 14 文件、259 项通过（各文件取最后一次结果，不重复计数） | [d14-tests.txt](d14-tests.txt) |
| P1 + P0 历史相关测试 | 7 文件、79 项通过（含 D14 核心） | [tests.txt](tests.txt) |
| P0 fauxProvider 离线冒烟 | 6 项断言通过 | [p0-smoke.txt](p0-smoke.txt)、[本次 trace](offline-trace.jsonl) |
| 独立 Node 工具探针 | Read/Edit/bash/Glob/Grep/trace 全通过 | [standalone.json](standalone.json)，Node 24.20.0，**不等同随包 Node** |
| 真 Electron utilityProcess | 同一组 6 项断言通过，worker 退出 0 | [electron-utility.txt](electron-utility.txt)，Linux Electron 39.2.7 / 内置 Node 22.21.1 |
| Windows 随包 Node | 未执行 | 本机没有 Windows 安装包及执行环境，提供 `p1-bundled-node.ts` 入口 |
| Windows 进程树/加密机 | 未执行 | 见下一节；不能用 Linux 或替身结果代签 |
| 远端 CI / P4 GUI 全链路 | 未执行 | CI 增加 `smoke:runtime-tools` 门禁，未推送或触发远端工作流 |

代码与探针来源哈希见 [sources.json](sources.json)。报告中的 git_commit 是基础提交，
**该次测试包含工作区的未提交代码**；来源哈希用于消除只看 HEAD 的歧义，不改写 P2-0 证据。

## 仍需完成的载体验收

1. `ExecPlugin` 已改为保留 Node runner 的进程树根身份，命令结果经独立 IPC 回报；
   父服务随后按 runner PID 请求清理整树。Linux 后代 heartbeat 停止测试通过。
   Windows 分支调用 `taskkill /PID /T /F` 并等待关闭，**尚未在 Windows 实测**，
   尤其要核对中间命令进程已退出时的后代发现；保留 runner 不能替代这项验收，必要时仍需 Job Object。
   P1-0/P1-3 与 P1-8 仍保持进行中，不能用 Linux 协议验证代签 Windows ownership。
2. 用实际 Windows 安装包中的 Node 和 bash 跑下方入口，保留 stdout、退出码和源哈希。
3. 企业加密机验证 Read 明文、Write/Edit 回读、bash stdout，以及退出后无残留。
   `host-adapter` 只提供接入契约，尚无非 pipe 实现；Q6 已确认不要求首批交付非 pipe。
4. D13 的 Main 读取改造由 P3-5/P4-5 处理，Q7 由主线处理；此次不改这些归属。

## 接口及兼容范围

- `runtimeHostIo`：异步、绝对路径、字节窗口、TSD 固定 helper、上限/取消、追加串行。
  默认不开 TSD 回落，遇密文明确失败；配置回落后只使用明确 Node 路径。
- `runtimeExec`：命令 argv、显式环境、Node PATH 前置、输出总预算、双流排空、超时/取消/dispose。
  不通过匹配错误文本自动重跑可能已产生副作用的命令。自定义 adapter 必须履行相同清理/时限契约。
- 注册工具：`read/write/edit/bash/glob/grep` 六个；TypeBox 固定 pin 到 SDK 已解析的 1.3.7，
  调用边界校验 schema。启用 `tools` 时默认多轮，最多 64 个 assistant turn；无工具时保留 P0 单轮。
- Read 的 `offset` 是 **1 起始行号**、`limit` 是行数，兼容 P2-0 的 `2101/3`；HostIo 偏移仍为字节。
  Read 输出 50 KiB、行扫描最多 64 MiB；单行超限会明确提示，不伪造完整行。
- Write/Edit 完整文件上限 8 MiB；Edit 的所有匹配先成功再写回，同路径进程内串行。
  不宣称跨进程事务或抵御其他进程恰好在路径检查后替换 symlink 的 OS 沙箱能力。
- Glob 支持 Node `matchesGlob`；Grep 首版明确为**字面文本搜索**，支持 include、大小写和结果上限，
  没有正则语义、gitignore 引擎或 spill 文件。搜索跳过 symlink、`.git`、`node_modules`、秘密文件和拒绝 scope；
  候选数 20,000、每文件 1 MiB、累计读取 32 MiB。模型可见描述与这些行为一致。
- D14 分离 `mode` 与 `gear`：plan 裁掉 Write/Edit 和默认写类插件；agent 提供完整工具集。
  ask 的写/改/所有 bash 请求审批；accept-edits 自动放行工作区写/改/bash，显式外部路径仍问；
  auto 也受秘密路径、工具白名单、deny scope 和 plan 工具限制约束。
  旧 readonly → plan + ask，pragmatic/handsoff/fullopen → agent + ask/accept-edits/auto。
  会话授权限到工具+规范路径+命令，`configure({ mode, gear })` 清空授权并使待审批请求失效。
- 原生 bash 现在使用 tree-sitter AST：解析引号拼接、简单变量赋值/展开、cd、重定向、嵌套 shell、
  命令替换；通配符展开和 symlink 路径经过 HostIo，所有操作数参与 scope/path deny 判定。
  授权后重新解析路径，路径变化不执行；会话授权键也包含规范路径集合。
  `symlink/../file` 先 realpath 再判断，避免词法归一化掩盖外逃。bash 不加载 profile/BASH_ENV/ENV。
  普通工作区命令和管道在 accept-edits 下无需审批；无法静态确定路径的分支、循环和解释器脚本仍需审批。
  **该检查不是 OS 沙箱，也不把任意程序内部的动态 IO 宣称为已完整解析**；真实项目兼容归 P4。
- 原生权限加载全局及 host 明确可信的项目配置，支持旧 JSONC 路径与新 config.json，复用共享的
  表合并语义；glob 映射旧 find，支持 deny-with-reason 的拒绝动作。坏配置明确阻止启动，避免丢掉 deny。
  projectTrusted 默认 false；策略采用启动快照，P4 须把设置更新接到 runtime 重载。
  旧 yoloMode 不覆盖 D14 gear，提示和 policy 哈希/来源进 stamp。按 agent 名称加载的子代理策略归 P5。
- 通过现有 `createPortableExtensionUiBridge` 发送 select 请求，复用响应/超时/取消。
  renderer 改为两模式/三档；新偏好键保存 `{ mode, gear }`，读取时兼容旧四档（不改写旧存储）。
  `chat.setPermissions` → Main → `worker.setPermissions` → session authorizer；创建、resume、
  复用已有 worker 和崩溃重启都传递两轴。UI 等 worker 成功确认后落盘，失败保留旧值并显示错误。
  旧 worker 通过扩展事件裁剪 plan 工具及拒绝写类调用；随包 bash 策略改为默认 ask，
  accept-edits 授权器放行工作区 bash，路径 deny/外部目录仍由原权限插件先检查。
  用户自带权限插件时继续显示现有降级提示，不提供无效档位选择。
  新原生后端的 worker bootstrap 与打包 GUI 全链路签收仍属 P4。
- trace 改异步 finish/flush，持久化失败单列；记录工具参数、结果、权限决定及逐轮原始 usage。
  run usage 汇总所有模型轮次，保留 D9 使用的原始数字，不把末轮当整轮。
- P1 提供 `toolSegments()`、`modeSegment()` 与 `permissionGearSegment()`，供 P2-1 的固定槽位装配；
  当前仍由调用者提供 systemPrompt，不擅自改 P2 的段顺序和 bootstrap 注册。

## P1-9 与 P2-8 接口

`newContextTool({ family, request })` 只调用 P2 提供的 request 回调，回复按 `fresh_window/summary`
区分；工具自身没有 IO 或压缩副作用。P2 以 `runtimeTools.register(tool, 'read')` 注册后 plan 可见，
无需普通审批，显式工具白名单仍可拒绝。4 项测试覆盖两种回复、意图、参数校验及白名单。
**当前默认列表不含此工具**；等待 P2 在下一轮边界消费意图并与 P2-8 提醒一起启用，P1-9 未标 Done。

## 参考与取舍

- pi-app：原 `/tmp/aiclient-b-reference-pi-app` 已消失，本轮重新只读参考
  `/tmp/aiclient-p1-reference-pi-app/src/main/wsl/wsl-exec.ts` 与对应测试。
  适配其输出上限测试思路，不搬 WSL 包装或仅 child.kill 即认为清理完成的断言。
- pix：已读 `pi-tui-session.ts` 和测试，不采用 TUI ownership 作为 exec 的生命周期；不迁入 PTY。
- PI-Desktop：已读 `permissions.rs` 实现与内嵌测试、`tools/mod.rs` 文件工具/输出截断段与测试、
  `tools/shell.rs`、ADR 0057/0100。适配外部路径审批、输出上限与 mode/gear 分离；按本仓 D14 覆盖 accept-edits 的 bash 判定，
  不引入 goal 或 subagent 权限继承。另读 runtime.ts 的 new_context 定义、构造和对应测试，
  适配工具本身；不把只设置意图记成实际压缩完成。
- 本仓：已读 `sessionTierAuthorizer.ts` 及测试，D14 后不再复用旧四档判定；保留
  `permissionPolicy.mjs` 的 path 规则；直接复用 Extension UI bridge，已读其 request/respond 测试。
  TSD 头识别适配旧 `tsdSafeRead.ts`，实际 helper 使用固定参数与有界读取。

## 复跑

相关测试、类型检查按上表串行运行。runtime 依赖安装使用 `npm ci --omit=optional --ignore-scripts`，
只需两个 Bash WASM 资产，不运行其 Node native binding 构建。根依赖缺失时临时借用相邻 checkout 的 node_modules，结束清理链接。

```bash
corepack pnpm smoke:runtime
corepack pnpm smoke:runtime-tools
node_modules/electron/dist/electron --no-sandbox scripts/runtime-smoke/electron-carrier.cjs /usr/bin/node /bin/bash
```

Electron 探针只启动 Main 和一个 utilityProcess，不创建窗口、不构建应用；在有桌面会话的 Linux 主机执行。
`--no-sandbox` 仅用于此本地探针，不改应用生产设置。
Windows 在仓库根目录用 PowerShell 执行，替换成安装包实际绝对路径：

```powershell
& 'C:\install\resources\node-runtime\node.exe' src/runtime/smoke/p1-bundled-node.ts 'C:\install\resources\node-runtime\node.exe' 'C:\install\resources\git\bin\bash.exe'
```

独立/载体探针不连接线上网关；fauxProvider 只负责最小对话，文件工具和 bash 是真实调用。
GUI/worker 全链路用本地模型替身的打包验收依旧属于 P4-6。
