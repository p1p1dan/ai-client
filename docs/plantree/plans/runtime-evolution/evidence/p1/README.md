# P1 本机实现与验证记录

日期：2026-09-08 · 基础 HEAD：`ee125b1e` · **P1 代码尚未提交**。
[执行 TODO](../../TODO.md) · [看板](../../README.md) · [契约](../../topics/p1-0-host-contracts.md)

## 结论

P1-0 出口和 P0 迁移、P1-1～P1-7 的首版工具/权限/审批代码已落地，本机相关测试通过。
P1 整体仍为进行中：P1-8 的 Windows 随包 Node 与企业加密机验收未执行；
Windows 进程树清理还存在明确的实现边界，不能记作完成。

| 检查 | 结果 | 证据 |
|---|---|---|
| runtime 类型检查 | 通过 | `NODE_OPTIONS=--max-old-space-size=768 node_modules/.bin/tsc --noEmit -p src/runtime/tsconfig.json` |
| P1 + P0 相关测试 | 7 文件、69 项通过 | [tests.txt](tests.txt) |
| P0 fauxProvider 离线冒烟 | 6 项断言通过 | [p0-smoke.txt](p0-smoke.txt) |
| 独立 Node 工具探针 | Read/Edit/bash/Glob/Grep/trace 全通过 | [standalone.json](standalone.json)，Node 24.20.0，**不等同随包 Node** |
| 真 Electron utilityProcess | 同一组 6 项断言通过，worker 退出 0 | [electron-utility.log](electron-utility.log)，Linux Electron 39.2.7 / 内置 Node 22.21.1 |
| Windows 随包 Node | 未执行 | 本机没有 Windows 安装包及执行环境，提供 `p1-bundled-node.ts` 入口 |
| Windows 进程树/加密机 | 未执行 | 见下一节；不能用 Linux 或替身结果代签 |
| 远端 CI / P4 GUI 全链路 | 未执行 | CI 增加 `smoke:runtime-tools` 门禁，未推送或触发远端工作流 |

代码与探针来源哈希见 [sources.json](sources.json)。报告中的 git_commit 是基础提交，
**该次测试包含工作区的未提交代码**；来源哈希用于消除只看 HEAD 的歧义，不改写 P2-0 证据。

## 仍需完成的载体验收

1. Windows `ExecPlugin` 当前以 `taskkill /PID /T /F` 清理命令树，并等待 taskkill 关闭；
   **命令根进程先退出后，taskkill 无法再依靠原 PID 找到整个后代树**。
   该路径需在 Windows runner 上验证并补充保留根进程身份的 runner 或 Job Object ownership。
   这是已知实现缺口，P1-0/P1-3 与 P1-8 不因此标 Done；Linux 进程组清理不能证明 Windows 行为。
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
- 权限直接复用本仓四档 tier 的判定函数和默认秘密路径规则，scope/工具白名单、只读拒绝优先。
  会话授权限到工具+规范路径+命令，切 tier 清空；外部路径需要授权，fullopen 除显式 deny 外放行。
- bash 首版只自动放行无参数 `pwd`，其余 pragmatic/handsoff 命令请求审批；
  对显式字面路径执行秘密文件检查，**不把 shell 变量、动态脚本或 shell 的后续任意 IO 当作可完全检查的文件操作**。
  完整旧 bash parser/用户 policy 分层导入属于 P4 接入前的兼容核对，当前不得声称完全等价旧权限插件。
- 通过现有 `createPortableExtensionUiBridge` 发送 select 请求，复用响应/超时/取消；无 renderer 改动。
  worker RPC 实际路由仍属 P4；没有宣称 GUI 审批全链路已验收。
- trace 改异步 finish/flush，持久化失败单列；记录工具参数、结果、权限决定及逐轮原始 usage。
  run usage 汇总所有模型轮次，保留 D9 使用的原始数字，不把末轮当整轮。
- P1 提供 `toolSegments()` 与 `permissionTierSegment()`，供 P2-1 的固定槽位装配；
  当前仍由调用者提供 systemPrompt，不擅自改 P2 的段顺序和 bootstrap 注册。

## 参考与取舍

- pi-app：原 `/tmp/aiclient-b-reference-pi-app` 已消失，本轮重新只读参考
  `/tmp/aiclient-p1-reference-pi-app/src/main/wsl/wsl-exec.ts` 与对应测试。
  适配其输出上限测试思路，不搬 WSL 包装或仅 child.kill 即认为清理完成的断言。
- pix：已读 `pi-tui-session.ts` 和测试，不采用 TUI ownership 作为 exec 的生命周期；不迁入 PTY。
- PI-Desktop：已读 `permissions.rs` 实现与内嵌测试、`tools/mod.rs` 文件工具/输出截断段与测试、
  `tools/shell.rs`、ADR 0057/0100。适配外部路径审批与输出上限；不采用 plan/goal mode，
  使用本仓四档权限，不为 P1 引入 subagent 权限继承。
- 本仓：直接复用 `sessionTierAuthorizer.ts` 的纯判定和 `permissionPolicy.mjs` 的 path 规则，
  已读对应测试；直接复用 Extension UI bridge，已读其 request/respond 测试。
  TSD 头识别适配旧 `tsdSafeRead.ts`，实际 helper 使用固定参数与有界读取。

## 复跑

相关测试、类型检查按上表串行运行。根依赖缺失时临时借用相邻 checkout 的 node_modules，结束清理链接。

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
