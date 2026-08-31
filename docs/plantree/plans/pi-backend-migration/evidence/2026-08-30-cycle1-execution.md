# Cycle 1 执行证据 — T14 / T15 / T08-c-Q10

> 执行时间：2026-08-30～2026-08-31
> 状态：**实现与自动门禁已完成；T14 真账号 GUI 点测、T15 完整 renderer/安装包 smoke 待高资源主机或 CI。**

## 1. T14 消息队列收口

### 修复

- idle 但已有 backlog 时继续入队，禁止 Stop→idle 后新消息越过旧队列（原可出现 C→A→B）。
- 新增相邻位置交换 reducer、Zustand action 与可访问的上移/下移按钮。
- `restoreHead` / `pauseSession` 对已被 Archive 或仓库移除 prune 的 bucket 做 no-op，迟到拒绝不得复活隐藏队列。
- 抽出 `releaseQueueHead` 事务：pop → run → admitted consume；skipped restore；rejected/throw restore + `send-rejected` pause。
- 明确并加钉子：队列只在 Zustand 内存中，不接 persist/localStorage；应用重启不恢复。

### 自动证据

- `queueReleaseTransaction.test.ts`：三条严格 FIFO、附件身份、拒绝/异常只恢复一次、in-flight prune 不复活、Archive/仓库移除只 prune 目标 session。
- `piQueueReleaseIntegration.test.ts`：首条 Pi 长 turn 挂起后，三条消息经真实 `PiAgentRuntime` + Pi SDK session stub 依序进入 prompt，附件文本保持，最终队列为空。
- `queueRelease.test.ts` / `messageQueue.test.ts`：Stop 后 idle backlog 仍 enqueue、暂停/恢复、按钮模型、移动边界、memory-only 口径。
- Cycle 1 T14 scoped：4 files / 171 tests 通过。

### 尚待人工

- 需要真账号 GUI 再点一次：真实长回合中连续排三条、编辑/删除/交换、Stop 解冻、切会话、Archive、移除仓库。自动层已覆盖状态与 PiRuntime 边界，但不把 SDK stub 冒充成真账号网络回合。

## 2. T15 工作区预览安全与恢复

### 修复

- `local-file://` 读授权从词法包含改为 realpath 物理包含；协议实际 fetch 授权后的 canonical path，workspace 内 symlink 指向外部会拒绝。
- `local-file` 在 `registerSchemesAsPrivileged()` 中提前注册，并加 64 MiB 协议资源上限。
- 文本预览先 stat + 512-byte sniff，8 MiB 以上在完整 Buffer/解码/IPC/Monaco 分配前返回显式 `tooLarge`。
- Markdown 图片拒绝 traversal、`file:`、`local-file:`、`blob:`、`javascript:` 与自定义 scheme；data URI 只允许受限 raster base64；Main realpath guard 是最终物理边界。
- PDF.js 5.4.624 改为固定本地依赖，worker 使用 `?worker&url` 交给 Vite 生成本地资产，删除 PDF CDN 动态 import。
- 图片新增 decode/error 状态与组件内 Retry，并限制 40 MP；PDF Retry 不再 `window.location.reload()`，canvas 限 16 MP。
- 多 tab 右键 Close Others/All/Left/Right 接回 `EditorColumn`；dirty tab 逐个确认，Cancel 或保存失败立即停止批量关闭。
- 增加 per-workspace tab order / active / dirty / too-large metadata 恢复测试。

### 自动证据

- real filesystem symlink escape、bounded read admission、Markdown scheme/traversal、image/PDF pixel budget、preview recovery wiring、workspace tab restore、batch dirty close 均有测试。
- Main/preload 单阶段产物在中断前已生成；built Main 含 canonical `local-file` guard 与 413 路径。
- `verify:preview-probe` 以低内存单入口 Vite probe 生成 `pdf.worker.min-*.js`（1,637,516 bytes），确认无 PDF.js CDN，且 Monaco 五类本地 worker import 均存在。
- `verify:preview-assets` 已接入 `dist:prereq`，完整 renderer build 后要求 Monaco 5 worker + PDF worker 非空、无 PDF CDN、built Main 含 local-file marker。

### 尚待高资源构建/真机

- 当前 3.3 GiB 主机两次整套 `pnpm build` 在 renderer 阶段中断；依资源安全红线不再硬跑。旧 `out/renderer` 是修改前产物，因此当前直接执行 `verify:preview-assets` 会如实因“缺 PDF worker / 仍含旧 CDN”失败。
- 待 CI/高资源主机执行：`pnpm build` → `pnpm verify:preview-assets` → packaged Electron 中打开 Markdown 相对图、图片、PDF、Monaco TS/JSON/CSS/HTML worker，并验证 corrupt/oversize 的恢复 UI。

## 3. T08-c / Q10 根因与修复

### 根因

`@gotgenes/pi-permission-system@27.0.1` 的 `<extensionRoot>/config.json` 只进入 legacy runtime-knob loader；该 loader 规范化时丢弃 `permission`。真实 `PermissionManager.FilePolicyLoader` 原本只读 global/project/agent/project-agent，所以所谓“随包默认”根本没有进入执行 ruleset。

因此：

- 仓库 read 的询问来自 builtin ask（`origin=builtin`，无 matched pattern），不是 D11 的 `read: allow`。
- `~/.pilab/*: deny` 是死配置；观察到的 `.pilab` 询问来自其他 ask gate / fallback。
- cwd、`~` 展开、绝对/相对 alias、symlink canonicalization 与 gate 顺序本身正常。

### 修复

- 新增 version-guarded、幂等 `patch-pi-permission-system.mjs`，为 27.0.1 增加最低优先级 `bundled` scope、origin、cache stamp、resolved path 与 fail-closed；extension startup 把 `<extensionRoot>/config.json` 传给 `PermissionManager`。
- `src/agent-host/package.json` postinstall 自动应用补丁；fresh `npm ci --ignore-scripts` 后手动 postinstall、pristine npm tarball 首次 patch + 二次 idempotency 都已验证。
- `.pilab` 正式改为 path `ask`，并保持后置的 `*.env`/PEM/key deny；`external_directory` 对 `.pilab` 后置 allow，避免同一访问出现第二个审批，不能绕过 path ask。
- permission activity prompt 投影以 nested `request.surface` 为真实 gate surface，保留顶层为 `toolSurface`，并带 prompt matchedPattern。

### real resolver / packaged smoke

真实 patched `PermissionManager` 矩阵已覆盖：

- repo relative + absolute read：`allow / bundled / *`
- repo `.env`：`deny / bundled / *.env`
- external path：`ask / bundled / *`
- ordinary `.pilab`：`ask / bundled / ~/.pilab/*`
- `.pilab/.env`：`deny / bundled / *.env`
- symlink canonical alias / boundary value
- session allow 只在传入 session ruleset 时生效，不持久化
- global override 高于 bundled
- malformed global config：`ask / fail-closed`
- bundled config 缺失：builtin ask

Agent Host artifact：394.3 MiB（413,422,848 bytes）；`smoke:permission-plugin` 载入真实产物扩展、确认 `tool_call` handler、真实 WASM bash 解析，并对上述核心相对/绝对 read、repo env、external、`.pilab`、`.pilab/.env` 决策返回 `RESULT: PERMISSION GATE INTACT`。

## 4. 门禁与资源说明

- 所有测试按小批次、`--maxWorkers=1 --no-file-parallelism` 串行执行。
- 完整测试集合：**293 files / 5565 tests 通过**（其中一次 `defaultPaths` 静态扫描发现 smoke 重复 `.pilab` 字面量，修复后单文件复验通过）。
- Main typecheck：通过。
- Agent Host typecheck：通过。
- Biome：`scripts + shared + agent-host` 227 files、Main 225 files、preload + renderer 632 files，均 0 errors / 0 fixes。
- `git diff --check`：通过。
- Agent Host build + permission packaged smoke：通过。
- 完整 renderer/Electron build：**未在低资源主机硬跑成功，明确转交 CI/高资源主机**。

资源约束已写入仓库根 `AGENTS.md`：重任务前检查、测试小批单 worker、本机禁止整套生产构建、单阶段构建限制 Node 堆、批次后清理。
