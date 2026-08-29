# Pi Backend Migration Phase 2 修复任务 Prompt

你需要修复 AiClient 的 Pi Backend Migration Phase 2 审计中发现的问题，并完成对应测试、文档和验收。项目技术栈为 Electron 39、React 19、TypeScript 5.9、Tailwind 4、Biome。请先阅读根目录 `AGENTS.md`、`docs/design-system.md` 以及：

- `docs/plantree/plans/pi-backend-migration/roadmap.md`
- `docs/plantree/plans/pi-backend-migration/implementation-status.md`
- `docs/plantree/plans/pi-backend-migration/evidence/phase2-extension-ui-permission.md`
- `docs/plantree/plans/pi-backend-migration/open-questions.md`

## 工作原则

1. 先复现、定位和补失败测试，再修改实现。
2. 按 P0 → P1 → P2 顺序处理，不要只修改文档掩盖代码问题。
3. 禁止使用 `as any`、`@ts-ignore` 等类型逃逸。
4. Runtime Event 必须使用强类型，避免继续以 `Record<string, unknown>` 绕过协议检查。
5. UI 优先使用项目已有的 `@coss/ui` 组件，并符合 `docs/design-system.md`。
6. 不要修改无关代码，不要覆盖工作树中原有的 `package-lock.json` 修改和未跟踪文件。
7. T08-c 仍被 Q9 阻塞，不要擅自决定默认 policy。
8. T09、T10 当前为 Deferred，本任务不要求实现完整的 notify/status/widget 或三级能力框架。
9. 如果某项审计发现被证明为误报，必须提供可复现证据、代码路径和测试证明，不能直接忽略。

# P0：必须修复的安全与隔离问题

## 1. 权限插件不可用时必须 fail-closed

相关文件：

- `src/agent-host/piRuntime.ts`
- `src/agent-host/permissionPlugin.ts`
- `src/renderer/components/chat/hostStatus.ts`
- `src/agent-host/__tests__/permissionPlugin.test.ts`

当前问题：

- 随包权限插件缺失时只发出 `fatal: false` 的 `host.error`，Runtime 仍继续启动，工具调用可能无审批执行。
- Renderer 会忽略非致命 `host.error`，用户通常看不到权限保护已失效。
- `permissionPluginConfiguredByUser()` 只检查包名，没有确认配置是否真正加载扩展。
- 以下配置目前会被错误识别为“用户已配置”，从而禁止注入随包版本：

```json
{
  "source": "npm:@gotgenes/pi-permission-system@27.0.1",
  "autoload": false,
  "extensions": []
}
```

修复要求：

- 只有在能够确认用户配置会实际加载权限扩展时，才允许跳过随包版本。
- 正确处理 `autoload: false`、`extensions` allowlist/空列表等 Pi PackageSource 配置。
- 权限插件缺失、加载失败或无法绑定审批 UI 时，不得继续允许工具调用。
- 失败必须是用户可见且可诊断的安全错误。
- 不允许仅通过日志或非致命、不可见事件报告。
- `bindExtensions()` 缺失或抛错时，也必须考虑权限扩展未正确绑定的情况，不能静默继续运行。
- 增加缺包、半拷贝包、禁用配置、过滤配置、加载失败和绑定失败测试。

## 2. 修复 Pi Runtime 的多 Session / 多 Worktree 隔离

相关文件：

- `src/agent-host/piRuntime.ts`
- `src/agent-host/piHost.ts`
- `src/main/services/agent-host/AgentHostManager.ts`

当前问题：

```ts
if (this.handle) return this.handle;
```

第一个会话创建的 Handle 会被后续不同 Worktree 会话复用。同时以下状态是全局单例：

- `handle`
- `turn`
- `abortController`
- `currentSessionId`
- `unsubscribe`

这可能导致：

- `/repo-b` 的工具在 `/repo-a` 中执行；
- 权限插件以错误工作区为根目录判断路径；
- 两个会话的事件、审批活动、输出互相串线；
- `stop(A)` 可能停止 B；
- 后一次 send 覆盖前一次 turn 和事件订阅。

修复要求：

- Runtime Handle 和 turn 状态必须按 session/workspace 隔离。
- 每个 session 应拥有独立的 session handle、AbortController、事件订阅、turn 投影状态和 Extension UI 归属。
- 如果架构暂时不能支持并发，必须在 Host 边界明确拒绝第二个并发会话，而不是允许状态交叉；但产品是 Worktree 管理器，优先实现真正的多会话隔离。
- `stop(sessionId)` 只能停止指定 session。
- 权限活动和 Extension UI 请求必须带正确 sessionId。
- close/dispose 时只清理目标 session，不得破坏其他会话。
- 增加以下测试：
  - 两个不同 workspace 顺序发送；
  - 两个不同 workspace 并发发送；
  - A/B 同时运行时停止 A；
  - A/B 同时产生工具事件；
  - A/B 同时产生权限请求；
  - 关闭 A 后 B 继续工作。

# P1：必须修复的功能正确性问题

## 3. Stop 必须立即取消 pending Extension UI 请求

相关文件：

- `src/agent-host/piRuntime.ts`
- `src/agent-host/extensionUiBridge.ts`
- `src/renderer/stores/extensionUi.ts`

当前 `stop()` 只 abort Pi session，没有排空 Extension UI pending map。权限插件调用 `ui.select()` 时可能没有 timeout/AbortSignal，导致：

- 点击 Stop 后权限弹窗仍存在；
- extension Promise 一直 pending；
- `prompt()` 和 session 状态不能正常结束。

修复要求：

- Stop、session close、session replacement、runtime dispose 都必须立即取消对应 session 的 pending UI 请求。
- Host 应发出 `extensionUi.cancelled`，Renderer 必须移除对应弹窗。
- 取消必须 settle exactly once。
- 不得误取消其他 session 的弹窗。
- 增加“权限弹窗等待期间点击 Stop”的 Runtime 集成测试。
- 验证 Stop 后 session 正常进入 stopped/idle，而不是依赖超时。

## 4. 修复 Pi Runtime Event 契约漂移

相关文件：

- `src/agent-host/piRuntime.ts`
- `src/shared/types/runtimeEvents.ts`
- `src/renderer/stores/chatSessions.ts`
- `src/renderer/components/chat/contextSurfaceModel.ts`
- `src/renderer/components/chat/retryBanner.ts`

### `tool.completed`

共享契约要求：

```ts
{
  messageId: string;
  toolCallId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}
```

Pi Runtime 当前发出 `isError`，导致 Renderer 无法识别工具失败。

修复要求：

- 严格发出 `ok` 和 `error`。
- 失败工具必须显示错误文本并被标记为失败。
- 移除或正式纳入契约中的多余字段。
- 增加成功、失败、空输出等事件投影测试。

### `session.status.retry`

共享契约要求：

```ts
{
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus: string | null;
  error: string;
}
```

Pi Runtime 当前发出 `errorMessage`。

修复要求：

- 映射为契约中的 `error` 和 `errorStatus`。
- Retry Banner 和 Context Surface 必须能显示真实错误原因。
- 将 Pi emit 路径改成强类型 `RuntimeEvent` emitter，让不合法 payload 在编译期失败。

## 5. 补齐 Pi 的附件、effort 和 permissionPreference 语义

相关文件：

- `src/agent-host/piHost.ts`
- `src/agent-host/piRuntime.ts`
- `src/shared/types/agentHost.ts`

当前问题：

- `session.send` 强制要求非空 text，违反“有附件时 text 可为空”的协议。
- text + attachments 时附件被静默丢弃。
- `effort` 被协议接受但没有应用。
- `permissionPreference` 被协议接受但没有进入 Pi 权限路径。

修复要求：

- 附件必须正确传给 Pi SDK；若 Pi SDK 不支持某种附件，应返回明确的 unsupported/error，不得静默丢弃。
- attachment-only send 应符合共享协议。
- `effort` 和 `permissionPreference` 必须真正生效；如果 Pi SDK 没有对应能力，需要在契约或 capability 中明确声明不支持，不能静默忽略。
- 增加附件、attachment-only、effort 和 permissionPreference 测试。

## 6. 将 `permission.activity` 接入 Renderer Timeline

相关文件：

- `src/agent-host/permissionActivity.ts`
- `src/agent-host/piRuntime.ts`
- `src/shared/types/runtimeEvents.ts`
- `src/renderer/stores/chatSessions.ts`
- 对应聊天时间线组件

当前 Host 已发出 `permission.activity`，但 Renderer 默认忽略，因此以下决定不可见：

- `policy_allow`
- `user_approved`
- `user_denied`
- 权限请求和最终 resolution

修复要求：

- 在正确 session 的 timeline 中显示权限活动。
- 用户关闭审批弹窗后，批准/拒绝结果仍应保留。
- policy 自动允许也应留下明确、不过度打扰的审计记录。
- 处理无 sessionId 或已经关闭 session 的事件。
- 不得渲染未转义 HTML。
- 增加 reducer/store/component 测试。

## 7. 修复 Extension UI 应答失败后的悬挂状态

相关文件：

- `src/renderer/stores/extensionUi.ts`
- `src/agent-host/extensionUiBridge.ts`

当前 Renderer 在 IPC 成功前就移除弹窗。如果 IPC 失败，只记录 `console.error`，Host pending 请求可能永久等待。

修复要求：

- 设计明确的失败恢复语义：恢复弹窗并允许重试，或者向 Host 显式发送取消并确保 Promise settle。
- 不允许出现“GUI 已消失、Host 仍永久 pending”的状态。
- 用户必须看到可理解的发送失败反馈。
- 保留防双击逻辑。
- 增加 IPC reject、Host 已退出、迟到应答和重复应答测试。

## 8. 为 Extension UI 增加窗口/会话所有权路由

相关文件：

- `src/main/ipc/chat.ts`
- `src/preload/index.ts`
- Renderer Extension UI store
- AgentHostManager/runtime event 路由

当前 Runtime Event 被广播到所有 `BrowserWindow`，多个窗口可能同时显示相同权限弹窗并竞争应答。

修复要求：

- 阻塞式 Extension UI 请求必须路由到拥有目标 session/workspace 的窗口。
- 不相关窗口不得显示权限弹窗。
- 如果仍需广播，则第一个应答成功后必须向其他窗口广播取消，但优先实现明确所有权路由。
- Host 仍需保留 runtimeId、sessionId、uiRequestId 三重校验。
- 增加双窗口模拟测试。

# P2：质量、打包和文档修复

## 9. 修复权限插件去重规则

相关文件：

- `src/agent-host/permissionPlugin.ts`
- `src/agent-host/__tests__/permissionPlugin.test.ts`

当前 Git 和部分本地路径匹配不到，例如：

```text
https://github.com/gotgenes/pi-permission-system.git
~/pi-extensions/pi-permission-system
```

修复要求：

- npm spec 应准确解析 scoped package 名。
- Git、本地目录和 PackageSource object 应尽可能通过实际 package metadata 确认包名。
- 避免 false positive 导致无权限插件，也避免 false negative 导致双弹窗。
- 增加 npm、Git、file、本地绝对路径、无 scope 路径、禁用过滤配置测试。

## 10. 修正 runtimeId 生命周期或协议文档

协议注释声称 runtimeId 会在 session replacement/reload/fork/switch 时变化，但当前 bridge 只在 `PiAgentRuntime` 构造时创建一次。

修复要求：

- 优先让 runtimeId 与实际 session runtime 生命周期一致，在 runtime/session replacement 时重建。
- 如果最终设计为进程级 runtimeId，则必须修改协议注释，并通过 sessionId + pending map 保证陈旧应答不会被接受。
- `extensionUi.cancelled` reducer 也应校验 runtimeId/sessionId，不能只按 uiRequestId 删除。
- 增加 session replacement 后拒绝旧应答的测试。

## 11. 完成打包运行时和 LICENSE 验证

相关文件：

- `scripts/agent-host-build-lib.mjs`
- `scripts/__tests__/agent-host-build-lib.test.mjs`
- `src/agent-host/spikes/t08a-permission-plugin-smoke.ts`

要求：

- 保留权限插件、tree-sitter/WASM 和实际运行所需文件。
- 增加裁剪产物中的真实 bash 权限解析 smoke，而不只是检查扩展入口被加载。
- 验证权限插件能拦截真实工具调用。
- 补齐实际随包传递依赖的许可证，至少检查：
  - `node-addon-api`
  - `node-gyp-build`
- 产物中存在包时，对应许可证也必须存在。
- 尽可能将权限插件 smoke 纳入 CI/package verification，而不是只保留手动脚本。

## 12. 修复 Extension UI 可访问性和反馈

相关文件：

- `src/renderer/components/chat/ExtensionUiDialog.tsx`

要求：

- select 选项使用项目 UI 组件或补齐等价的可访问语义。
- 为互斥选项提供语义分组、标签和键盘导航。
- 避免空 `AlertDialogTitle` 导致弹窗无可访问名称。
- 可选：显示“当前为第 N/M 个待处理请求”。
- IPC 应答失败不能只写 console，必须提供用户可见反馈。

## 13. 清理 Biome 警告

当前警告：

```text
src/agent-host/permissionActivity.ts
lint/suspicious/noConfusingVoidType
```

修复 `(() => void) | void` 的类型表达，不要关闭规则。

# 文档状态修正

代码修复和验证完成后，更新：

- `roadmap.md`
- `implementation-status.md`
- `evidence/phase2-extension-ui-permission.md`
- 必要时更新 `open-questions.md`

要求：

1. 不要再写“Phase 2 除 T08-c 外全部完成”，因为 T09/T10 是 Deferred。
2. 区分“代码施工完成”和“真实 E2E 验收完成”。
3. T08-b 只有在真实工具调用审批 E2E 通过后才能维持 Done。
4. “所有 surface 一律 ask”应改为：未匹中特殊内建/基础设施规则的普通请求默认 ask。
5. T08-c 继续保持 Blocked，直到 Q9 有明确产品决策。
6. 将本次测试命令、测试数量、构建结果和真实 E2E 结果写入 evidence。

# 必须新增的验收场景

至少覆盖以下自动化或集成测试：

1. 权限插件正常随包加载。
2. 权限插件缺失时工具不能执行。
3. 用户配置 `autoload:false` 时仍有有效的随包权限闸。
4. 用户配置 extensions 空 allowlist 时仍有有效权限闸。
5. 权限插件加载或 bind 失败时 fail-closed。
6. 真实 bash/read/write 工具调用触发 GUI 权限请求。
7. 用户允许后工具执行。
8. 用户拒绝后工具不执行。
9. 用户关闭弹窗后按 fail-closed 处理。
10. 弹窗等待期间 Stop，pending 请求立即取消。
11. 两个 workspace 顺序使用时 cwd 正确。
12. 两个 session 并发时事件和 abort 不串线。
13. 工具失败在 Renderer 中正确显示为失败。
14. policy allow 和用户决定进入正确 session timeline。
15. IPC 应答失败不会留下永久 pending 请求。
16. 多窗口时只有目标窗口显示权限弹窗。
17. 打包产物中的 bash WASM 能真实执行权限解析。
18. 所有随包依赖的许可证检查通过。

# 最终验证命令

完成后至少执行：

```bash
pnpm typecheck
pnpm typecheck:agent-host
pnpm test
pnpm exec biome check src scripts
pnpm build:agent-host
pnpm smoke:permission-plugin
```

如环境允许，再执行：

```bash
pnpm build
pnpm lint
```

如果完整 Electron build 因机器内存限制无法运行，必须说明限制并提供：

- `build:agent-host` 结果
- packaged permission smoke 结果
- 手动 Electron E2E 验收步骤和结果

# 最终交付格式

完成后输出：

1. 修复摘要，按 P0/P1/P2 分类。
2. 修改文件清单。
3. 每个问题的根因和修复方案。
4. 新增测试清单。
5. 所有验证命令和结果。
6. 尚未解决的问题及原因。
7. T07、T11、T08、T08-a、T08-b、T08-c、T09、T10 的最终状态矩阵。
8. 明确说明是否已经满足 Phase 2 正式签收条件。

不要只做局部补丁。权限 fail-open、多会话 Worktree 隔离、Stop 生命周期、Runtime Event 契约和真实权限 E2E 是本次修复的正式验收门槛。
