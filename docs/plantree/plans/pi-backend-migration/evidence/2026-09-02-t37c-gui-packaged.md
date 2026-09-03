# T37-c GUI / 真账号点验 — 2026-09-02

**Role**：evidence · **Status**：accepted with a reported defect
**Related**：[roadmap T37](../roadmap.md#t37--pi-only-release-gates--in-progress) · [D17](../decisions/017-worker-pool-policy.md) · [D18](../decisions/018-t34-claude-import-semantics.md) · [D19](../decisions/019-tui-owns-the-gui-session-file.md) · [T37-b](./2026-09-02-t37b-resource-longevity.md)

## 结论

GUI 全流程在**真账号、真模型端点**上跑通并留了截图：多会话、队列、历史、Claude 导入、
GUI↔TUI 交接、权限审批四个选项、模型切换，以及三种崩溃恢复。

过程中挖出**四个真实缺陷，三个已修**：

1. `pnpm dev` 完全起不来（读一个已删除的文件）——已修。
2. dev 模式下 Pi worker 每次启动即死，任何会话都发不出消息——已修（两处）。
3. worker 的 stderr 被丢进空函数，崩溃原因无处可查——已修，正是靠它才定位到第 2 条。
4. worker 在会话文件落盘前死掉会让该会话**永久不可用**——**未修**，转 T37-d。

packaged 安装包按决定交给 CI（见文末）。

## 环境

| 项 | 值 |
|---|---|
| 主机 | Linux 5360 MiB / 2 核（与 T37-b 同一台） |
| agent 目录 | `~/.pilab/t37c-agent`，只放一份从 `~/.pi/agent` 复制的 `models.json` |
| 供应商 | `cx2`（gpt-5.6-sol / terra / luna，openai-responses）与 `maxapi`（grok-4.6，openai-completions），**真 key、真端点** |
| 导入素材 | `~/.claude/projects/-home-ai-code-ai-client/` 下 25 个真实 Claude 会话 |

`dev.env` 的 `PI_CODING_AGENT_DIR` 从已失效的 `/tmp/fresh-pi-agent`（2026-08-30 建的干净新用户目录，被系统清 `/tmp` 删掉了）改指到上面这个专用目录。
**`dev.env` 是 gitignored 的本机文件**，这条改动不进版本库——下一个接手的人若发现应用没有任何模型，先查这里。

## 新增工具

| 文件 | 作用 |
|---|---|
| `scripts/run-t37c-gui-probe.mjs` | CDP 驱动真实 dev 应用，逐步截图并输出 JSON 报告 |
| `src/agent-host/__tests__/workerStripOnlyCompat.test.ts` | 走一遍 worker 的真实 import 图，堵死缺陷 2 复发 |

```bash
node scripts/run-t37c-gui-probe.mjs                    # 全部 11 步
node scripts/run-t37c-gui-probe.mjs --only=entry,tui   # 挑步骤
node scripts/run-t37c-gui-probe.mjs --keep-open        # 跑完不关，便于手动接管
```

不同于 T37-b，这个探针**没有任何代码跑在 Electron 里**，所以是普通 `.mjs` 而不是 esbuild 打包的 probe entry。
它用 Node 内建的 `WebSocket` 接 CDP，不引入 `ws` 依赖。

写探针踩到的三个坑（都写进了代码注释）：

- **`Runtime.evaluate` 跑在页面全局作用域**，辅助函数用 `const` 声明会残留，下一次 evaluate 直接 `Identifier has already been declared`。所有注入代码改成自包含 IIFE。
- **窗口没显示出来时截图是纯背景色**。本机 `MainWindow` 的 `ready-to-show` 常常赶不上，靠 5 秒兜底才显示窗口，所以截图前必须等 `visibilityState === 'visible'` 且 `#root` 有内容——否则得到一目录空白图。
- **不能直接调 `store.sendMessage()`**：模型选择归 composer 所有，绕过它会用 Pi 自己的默认模型。第一次这么跑，UI 显示 “GPT-5.6 Terra” 而实际发给了 anthropic 端点并拿到 401。必须走 textarea + Send 按钮。

## 门禁与实测

报告：`evidence/t37c-screenshots/report.json`（2026-09-02T16:53:59Z → 16:56:26Z，11 步全过）。

| 门禁 | 做法 | 实测 |
|---|---|---|
| 入口 | 启动首屏点 `Use my own setup` | 进入本地凭据路径；截图 `01`/`02` |
| 模型目录 | `chat.listPiModels({force:true})` | `source: 'local'`，4 个真实模型（3×cx2 + 1×maxapi）；不是内置 seed 表 |
| 工作区 | `--open-path` 注册仓库 | `ws:main:/home/ai/code/ai-client`，路径非空 |
| 多会话 | 建 3 个会话各发一条真回合 | 三个各自拿到 `T37C-S1/S2/S3`，互不串台；三份**不同的** Pi JSONL |
| 队列 | 回合进行中连发 3 条 → 下移 → 删除 | 3 条入队；下移后首位由 “one” 变 “two”；删除后剩 2 条 |
| Stop | 清空队列后 Stop | Stop 按钮消失，composer 解冻 |
| 历史 | 切走再切回 | 转写不变，无 history error |
| 导入 | 扫描 → 选 1 条 → 导入 | 1 个项目 / 25 个会话；`status: imported`，落成新的 Pi JSONL |
| GUI↔TUI | 切到 TUI 再切回 | 顶栏 “Pi TUI continues this chat”；TUI 内 Pi CLI v0.84.4 接上同一份会话 |
| 权限审批 | 四个选项各走一遍 | 见下 |
| 模型切换 | cx2 → maxapi | 会话文件记录 `model_change` 到 `maxapi/grok-4.6`，后续回合走新供应商 |
| 杀 worker | 回合进行中 `kill -9` | 见下 |
| 杀 Pi TUI | `kill -9` PTY 里的 `pi` | 回落 GUI 并弹 “Pi TUI closed” |
| 强杀 app | `kill -9` Electron 主进程后重启 | 无孤儿；会话与 resume handle 完好 |

### 权限审批四个选项（人工点，截图 `13`–`18`）

策略来自随包的 `@gotgenes/pi-permission-system/config.json`：`bash` 默认 `ask`，`echo *`/`ls *`/`cat *` 等在白名单里。
所以要触发审批得用没被白名单覆盖的命令。

| 选项 | 触发 | 结果 |
|---|---|---|
| `Yes` | `uname -a` | 命令执行，真实输出回到时间线；行内标注 `Allowed bash uname -a · matched * · from bundled` |
| `Yes, allow bash "du *" for this session` | `du -sh docs` | 执行且标注 `user approved for session`；**接着** `du -sh scripts` **不再询问**，标注 `session approved · matched du * · from session` |
| `No` | `df -h` | 标红 `Denied bash df -h`；模型收到 `[pi-permission-system] The user denied this 'bash' call`，回答 “Command was not run: permission denied by the execution policy.” |
| `No, provide reason` | `whoami` | 弹出 `Reason shown back to the agent` 输入框，填写后 Submit；拒绝生效且理由原样回传给模型 |

四个选项都走的是 Extension UI 通道，`pendingPermissions` 始终为 0——审批不经过旧的 permission store。

### 崩溃恢复三项

| 场景 | 实测 |
|---|---|
| 杀 worker（回合进行中） | 杀掉 144108，池内另两个 worker 不受影响，新起 144130 接管；**resume handle 不变**，同一份 JSONL 继续；恢复用了 **2 次发送** |
| 杀 Pi TUI 的 PTY | 杀掉 144160 后回落 GUI 模式，弹出 “Pi TUI closed” |
| 强杀整个 app | 杀 main 143675 + 3 个 worker；重启后 **worker 与 PTY 均无残留**；58 个会话回来 59 个（多的一个是重启时新建的空会话），受检会话的 resume handle 与崩溃前**逐字节相同**，状态是 `idle` 而不是假装还在跑 |

**“恢复用了 2 次发送” 是契约，不是缺陷**：roadmap T30-c 写的就是 “active turn single failure”。
崩溃后第一次发送与异步重启赛跑，被 Main 以 `session_not_ready`（`retryable: true`）挡回一次，第二次成功。
探针据此按最多 3 次尝试来判定，并把实际次数记进报告。

## 修掉的三个缺陷

### 1. `pnpm dev` 读一个已删除的文件，直接 ENOENT 退出

`scripts/dev.js` 在 Electron 启动前要读 `REMOTE_SERVER_VERSION`，路径写的是
`src/main/services/remote/RemoteHelperSource.ts`——这个文件在 `8aafd450`（T35 旧运行时清理）里被删了，
常量搬到了 `RemoteServerSource.ts`。`build-remote-runtime-bundle.mjs` 当时同步更新了，**dev.js 和 CI 都漏了**。

后果：开发模式 100% 起不来，Electron 一次都没启动。
`.github/workflows/build.yml` 里发布资产校验步骤有同一处陈旧路径——同样会在打 tag 时炸，一并修掉。

### 2. dev 模式下 Pi worker 启动即死

打包后 worker 跑的是 esbuild 产物 `worker.js`；**dev 跑的是 TypeScript 源码**
（`PiWorkerProcess.resolvePiWorkerEntryPath` 在未打包时返回 `src/agent-host/worker.ts`，
配 `--experimental-strip-types`）。Node 的 strip-only 模式只做类型擦除，不做代码生成，也不做扩展名补全。
两条都踩了：

- `src/shared/types/workerRpc.ts` 里两个**值导入**没写扩展名 → `ERR_MODULE_NOT_FOUND`。
  `isWorkerImportConversationPayload` 只是转手 re-export，改由 `piWorkerRpcServer.ts` 直接从 `legacyImport.ts` 取；
  `PI_SESSION_TREE_BACKEND_LIMIT` 确实要用，改成 `./sessionHistory.ts` 并给根 `tsconfig.json` 打开
  `allowImportingTsExtensions`（`agent-host/tsconfig.json` 早就是这个约定，注释里写明了原因）。
- `piLegacyImport.ts` 与 `piWorkerErrors.ts` 用了**构造函数参数属性**（`constructor(private readonly x)`）
  → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。改成显式字段 + 赋值。

用 `node:module` 的 `stripTypeScriptTypes` 把 worker 依赖图 22 个文件全过了一遍，现在 0 个不可擦除。
这条从 T34 引入 `piLegacyImport.ts` 起就坏着，因为所有既有探针跑的都是打包产物，从没碰到过。

**加了回归护栏**：`workerStripOnlyCompat.test.ts` 从 `worker.ts` 出发走真实 import 图，
对每个文件跑一次 strip，并检查所有相对值导入都带扩展名。把修复去掉它就红（已实测：
重新加回一个构造函数参数属性，用例报 `TypeScript parameter property is not supported in strip-only mode`）。

### 3. worker 的 stderr 被丢进空函数

`WorkerManager.ts` 末尾构造生产单例时没有传 `log`，于是 `this.log` 是 `() => undefined`——
**worker 崩溃时它自己打印的原因被完整丢弃**，用户只看到 `Worker exited (code=1)`。
`hostStderr.ts` 这个模块本来就是为解决这件事写的（它的头注释点名 2026-07-28 那次 Linux 启动失败
“the Host's own diagnostics never reached any sink at all”），但只有它自己的测试在用，从未接进 `WorkerManager`。

改法：`WorkerManager` 的 stderr 回调走 `drainStderrLines` 拼成整行，进 `pushRecentStderr` 的有界缓冲；
worker 崩溃或启动失败时用 `console.error` 回放这段缓冲（electron-log 默认只保 error 级别）。
逐行仍走可选的 `log` sink（info 级，出厂配置下不落盘）。
同时给重启失败和预算耗尽各补一行日志——缺陷 4 就是靠这两行才看见的。

## 未修的缺陷（转 T37-d）：会话文件落盘前崩溃 → 该会话永久不可用

> **已在 T37-d 修复**，见 [T37-d evidence](./2026-09-02-t37d-session-brick-fix.md)。
> 那批同时查明本节对影响面的估计偏低：触发不需要崩溃，Stop、退出应用、模型报错同样会留下永久坏行。
> 下文保留当时的观察与推理原样。

**现象**：会话创建后约 1 秒内 worker 死掉，这个会话此后**任何操作都被拒绝**，重开应用才能恢复。

**复现**：新建会话 → 发送 → 在 Pi 写出 JSONL 之前 `kill -9` 该会话的 worker。

**日志**（本次实测）：

```text
[worker-manager] restart attempt 1/2 failed for session-…: WORKER_SESSION_FILE_NOT_FOUND:
  Pi session file does not exist: …/2026-09-02T16-29-17-231Z_01a062f4-….jsonl
[worker-manager] restart attempt 2/2 failed for session-…: WORKER_SESSION_FILE_NOT_FOUND: …
[worker-manager] session-…: Worker restart budget exhausted (2 attempts per 60000ms)
Error occurred in handler for 'chat:resumeSession': WorkerManagerError: Pi WorkerSlot for session-… is error
```

**成因**：Pi 先把会话文件**路径**交给 Main，稍后才真正写盘。Main 把这个路径当成 durable identity 存进 entry。
崩溃落在这个窗口里时，`restartEntry` 拿路径去 resume，worker 报文件不存在；两次重启都这样，预算耗尽后
`entry.state = 'error'`。而 `error` 状态**没有任何路径能清除**——`resumeSession` 见到非 `ready` 就抛
`session_not_ready`，会话就此报废到进程结束。已确认那个 JSONL 从头到尾没在磁盘上出现过。

**影响面**：需要崩溃正好落在约 1 秒的窗口里，概率不高；但在内存吃紧的机器上 OOM killer 是现实触发源，
而 D17 的池容量本来就是按内存分档的。后果是数据不丢（本来就没写出来）但会话变砖，用户必须重启应用。

**为什么这批不修**：修法要动 “文件不存在时把会话当作从未 materialize 并重建” 的语义，
牵涉 T30-a 的 identity/index 提交不变量（awaited SessionIndex commit 后才发布 created）。
改错会造出重复会话或孤儿 index 行，该走自己的切片和自己的测试，不该塞进门禁批次。
探针因此在杀 worker 前先等 JSONL 落盘，测的是**普通崩溃路径**；这条缺陷单独记在这里。

## 顺带修掉的文案漂移

`ChatWorkspace.tsx` 顶栏在 TUI 模式下一直写着 “Pi TUI starts a new session”，
而同文件的实现早已按 D19/Q17 把 GUI 当前会话的 JSONL 交给 TUI 接管。
改成按是否已绑定 runtime 分支：已绑定显示 “Pi TUI continues this chat”，未绑定（没有可继续的对话）保留原文案。
探针把这条断言钉死，截图 `08` 是实拍。

## 记录两条既定行为（不是缺陷，但会误导人）

- **切到别的会话再输入，消息会进队列而不是立即发送。** 一个会话在跑时，composer 的发送闩是组件级的，
  切到任何会话按钮都显示 “Queue message”。消息进的是**目标会话自己的**队列，等这个会话成为活动会话时自动释放
  （T-19 的 active-only 释放）。切走不回来，消息就一直停在那儿。探针因此改成挨个回访每个会话等它的答复。
- **展示模式（GUI/TUI）跨重启持久化**（T18）。上一轮停在 TUI，下次启动就没有 composer。
  而且 GUI/TUI 切换按钮要等工作区注册后才渲染，所以归一化只能放在工作区就绪之后。

## 验证

```text
node scripts/run-t37c-gui-probe.mjs        → 11/11 pass（2026-09-02T16:53:59Z 起，约 2.5 分钟）
pnpm exec vitest run（全量）                → 256 files / 3898 tests 全绿，0 失败（含新增 3 条护栏用例）
pnpm typecheck                              → pass
pnpm typecheck:agent-host                   → pass
pnpm exec biome check <8 个改动文件>         → pass
git diff --check                            → pass
```

收尾复查：探针退出后 `pi` 与 `electron` 进程数为 0。

## 未覆盖（留给 T37-d）

- **packaged 安装包**：按决定交给 CI。`.github/workflows/build.yml` 的 `build-windows` / `build-linux`
  两个 job 已经在跑 `electron-builder` + `verify-packaged-app.mjs` 并上传产物，触发方式是 `workflow_dispatch`。
  本机不跑（磁盘剩 6.7 GiB，`compression: maximum` 在 2 核上过慢）。
- **macOS**：`build.yml` 里没有 macos runner，`build:mac` 还要签名与公证凭据。整块欠着。
- **上面那条 `WORKER_SESSION_FILE_NOT_FOUND` 缺陷**：本批只报不修。
- **多窗口、多小时 soak**：本批最长一次连续运行约 2.5 分钟，进程级长稳以 T37-b 为准。
