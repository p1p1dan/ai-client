# Phase 2 Extension UI + 权限审批 — 落地与验证证据

**日期**：2026-08-28

## 落地范围

| 任务 | 证据 |
|---|---|
| T07 契约 | `runtimeEvents.ts` 新增 `extensionUi.request` / `extensionUi.cancelled` / `permission.activity` 三个事件与 14 个 portable 方法表；`agentHost.ts` 新增 `extensionUi.respond` 命令。两个边界守卫 `readExtensionUiDialogArgs` / `readExtensionUiResponse`。协议版本保持 1（开放 union 新成员） |
| T11 桥接 | `src/agent-host/extensionUiBridge.ts`（移植 pix）+ `piRuntime.ts` 的 `bindExtensions({ uiContext, mode:'rpc' })` + `piHost.ts` 的 `extensionUi.respond` 分支 + `chat:respondExtensionUi` IPC + `stores/extensionUi.ts` |
| T08 UI 原语 | `ExtensionUiDialog.tsx`：select / confirm / input / editor 四种，用 @coss/ui `AlertDialog`；挂载于 ChatWorkspace（不受 session 模式限制） |
| T08-a 插件随包 | `@gotgenes/pi-permission-system@27.0.1` pin 进 `src/agent-host/package.json`；`permissionPlugin.ts` 解析并去重；打包过滤特判 `.ts` 保留与 tree-sitter-bash 瘦身；`smoke:permission-plugin` 对产物实跑 |
| T08-b 审批闭环 | 多行标题拆分渲染（`splitExtensionUiDialogText`）+ `permissionActivity.ts` 内联扩展订阅 `permissions:ui_prompt` / `permissions:decision` |
| T08-c 默认策略 | **未施工**，Q9 待拍板。当前不带任何 policy 文件 |

## 关键事实（实测，非推断）

**插件在非 TUI 下确实走 `ui.select`**：`permission-prompt-component.ts:85` 按
`view.mode === "tui"` 分支，`mode` 取自 `ctx.mode`（`authorizer.ts:135`），
而 `ctx.mode` 正是 `bindExtensions({ mode })` 传入的值
（SDK `ExtensionMode = "tui" | "rpc" | "json" | "print"`）。非 TUI 走
`requestPermissionDecisionFromUi` → `ui.select` / `ui.input`。

**四个选项实跑捕获**（用记录型 `ui` 驱动插件自己的
`requestPermissionDecisionFromUi`，非抄文档）：

```
["Yes", "Yes, for this session", "No", "No, provide reason"]
```

**`ui.select` 的标题参数是多行的**：`permission-dialog.ts:129` 为
`ui.select(\`${title}\n${message}\`, ...)`，其中 `message` =
`renderPromptDialog(...).lines.join("\n")`，即工具、命令、涉及路径的整段渲染正文。
这段正文是用户判断是否批准的全部依据，故首行做标题、其余等宽预格式化显示。

**无配置时 fail-closed**：`rule.ts:112` 为 `defaultAction ?? "ask"`，另有
`rule.ts:86` 显式 `origin: "fail-closed"` 分支。因此不带 policy 文件时所有 surface
一律 ask —— 这是 T08-a/T08-b 不依赖 Q9 的原因。

**打包产物实跑加载**（`smoke:permission-plugin`）：

```text
./out-node-runtime/node --experimental-strip-types \
  src/agent-host/spikes/t08a-permission-plugin-smoke.ts out-agent-host
[t08a] extensions loaded: 1
  - out-agent-host/node_modules/@gotgenes/pi-permission-system/src/index.ts
[t08a] RESULT: LOADED
```

该 smoke 存在的理由：解析成功只证明文件在，不证明 pi 收得下这个路径。打包过滤对
其他包一律删 `.ts`，而该包运行入口正是 TypeScript（`pi.extensions:
["./src/index.ts"]`，`dist/` 只有 `.d.ts`），一次过滤回归就会发出一个没有入口的
权限插件——而「工具没被拦」和「没有工具需要审批」在界面上无法区分。

产物运行时依赖解析全通过：`@gotgenes/pi-permission-system`、`zod`、
`web-tree-sitter`、`web-tree-sitter/web-tree-sitter.wasm`、
`tree-sitter-bash/tree-sitter-bash.wasm`。

## 施工中发现并修掉的缺陷

**打包过滤漏掉包目录本身**：`shouldCopy` 的 tree-sitter-bash 分支最初只回答
`parts.length === 2` 的文件，而 walker 会先问目录条目（`parts.length === 1`），
于是整个包被跳过、bash 语法解析没有语法文件。单元断言全绿、真实构建才暴露。
已补 `parts.length === 1 → true` 与对应断言。

**设计规范拦截**：正文最初用 `<pre className="font-mono text-xs">`，被
`fontDomainScan.test.ts`（D25 §6.3 A1/A6）拦下——`font-mono` 是闭合白名单、
`text-xs` 在 chat/ 下禁用。改用 `ui/ident.tsx` 的 `Ident` 原语
（`font-mono` + `text-code` + `tracking-normal`）。

## 自动验证

```text
pnpm typecheck                # 全绿
pnpm typecheck:agent-host     # 全绿
pnpm vitest run               # 257 files / 5173 tests 全绿
pnpm build:agent-host         # 成功，394.2MB (413,396,552 B)
biome check src/ scripts/     # 全绿
```

Phase 2 新增测试 **6 文件 / 120 用例**：

| 文件 | 覆盖 |
|---|---|
| `shared/types/__tests__/extensionUiContracts.test.ts` | 两个边界守卫；`ok` 非布尔拒绝；`value` 键存在性与 undefined 的区别 |
| `agent-host/__tests__/extensionUiBridge.test.ts` | 恰好 settle 一次；confirm fallback 为 false；跨实例/重复/超时/abort 应答；reload/dispose 排空与状态清理；未知方法降级 |
| `agent-host/__tests__/permissionPlugin.test.ts` | 去重（含 scope 与版本号解析）；半拷贝目录判为缺失；缺失上报不抛 |
| `agent-host/__tests__/permissionActivity.test.ts` | 两条广播投射；无 requestId 丢弃；未知 result 丢弃但 resolution 透传；不向插件抛异常 |
| `renderer/components/chat/__tests__/extensionUiModel.test.ts` | 队列/取消/去重；不可渲染的对话不弹窗也不代答；多行标题拆分 |
| `renderer/stores/__tests__/extensionUi.test.ts` | 应答/关闭语义；权限四选项原样回传；scope 追问与拒绝理由输入 |

体积增量 **+6.4MB**（未过滤 32MB；tree-sitter-bash 20M→1.4M）。

## 未验证 / 交由真机

- **真机端到端**：本轮未在真机上跑通「模型发起工具调用 → 插件拦截 → GUI 弹窗 →
  用户选择 → 工具执行/拒绝」。链路各段均有测试与实跑证据，但整条链的首次贯通需要
  真实模型调用，按项目惯例交由用户真机验收。
- **提示正文的实际排版**：`renderPromptDialog` 的完整 payload 形状未逆向到底
  （探针缺 `evidence`/`annotations` 的确切内部结构），故正文的具体行数与留白待真机
  观察；渲染方式（首行标题 + 等宽预格式化 + 滚动）不依赖该细节。
- **完整 `pnpm build`**：脚本固定 4GiB heap，当前 VM 3.3GiB，沿用 Phase 5 的处置，
  不重跑高内存门禁。

## 遗留

**第三方 LICENSE 聚合是全仓既存缺口**：`shouldCopy` 对整棵 node_modules 一律删
LICENSE，本轮只为权限系统相关的四个包（`@gotgenes/pi-permission-system`、
`tree-sitter-bash`、`web-tree-sitter`、`zod`）开了白名单。pi SDK、Cometix、codex
等仍被删除。这是既存问题，未在本任务内扩大处理范围。
