# D48 调查 02 — 权限模式管理面现状（读侧全链 + 写侧零存在）

> 2026-08-16，阶段 3（D48）调查轮第 2 篇。只读调查，行号为当前工作树实测（切片 4 `7f357c2` 后另有 7 个相关提交）。
> 设计权威沿革：S2 设计档 §1 C4/C10/C11 + §2 #6/#9/#10/#11；切片 4 规格（权限投影读侧）。

## 1. 类型形状与真实流动字段

- `src/shared/types/runtimeEvents.ts:506-511` `SessionPermissionMode`（**冻结**，Claude 专属五值：default/acceptEdits/dontAsk/bypassPermissions/plan）。
- :517 `CodexApprovalPolicy = 'untrusted'|'on-request'|'never'`；:520 `CodexSandboxMode = 'read-only'|'workspace-write'|'danger-full-access'`。
- :540-550 `SessionPermissionPolicy` 判别联合（判别位 `agent`）：claude-code 带 `permissionMode`；codex 带 `approvalPolicy + sandboxMode + networkAccess`。
- :551-567 `SessionCreatedEvent.payload` 同时携带历史字段 `permissionMode?`（:555）与新字段 `permissionPolicy?`（:567，"Absent = fall back to the permissionMode row"）。

**流动现状**：

- **Claude 轴全链已连通**：发 `claudeRuntime.ts:341`（create）/:391（resume）恒为常量；收 `contextSurfaceModel.ts:449-451`（守卫）+ :472-509（reduce 进 `sessionRuntimeFacts`）；展示 `ContextSurfaceView.tsx:106-107` → `contextSurfaceModel.ts:222-228`（"Permission policy" 行）。
- **Codex 轴只有 Host 发、渲染端零消费者**（切片 4 规格 §6 L3 缺口，本次核实成立）：发 `codexRuntime.ts:1584`（仅 session.created）；resume 刻意不发（:2952-2954，H9 由 config.toml 重派生 + 回声校验）；收侧不存在——`isSessionPermissionPolicy` 守卫全仓零命中，`chatSessions.ts` 对两字段零引用，`contextSurfaceModel.ts:16-20` import 块不含 `SessionPermissionPolicy`。
- **可观测后果**：Codex 会话 payload 无 `permissionMode` 键 → `reduceSessionRuntimeFacts` 判 false → `facts.permissionMode` 恒 undefined → `buildRuntimeRows`（:222）判假 → **Codex 会话 Context 面板"Permission policy"整行消失**（不是错值，是不出现）；Claude 会话恒显 "Default"。

## 2. Claude 轴 permissionMode 全链

- 默认值：`claudeRuntime.ts:215` `CHAT_PERMISSION_MODE = 'default'`（:204-214 自陈"单一真源"）；三处消费（:341/:391/:754 `query()` options）**全读同一常量，无参数化入口**。
- **`HostSession`（`sessionRegistry.ts`）无 permissionMode 字段**——对比 model（:12/:42/:53/:67/:79/:87）与 effort（:14/:43/:54/:68/:80/:88）都有「创建写入 + send 可覆盖回写」的既有模式，权限连"会话级可变值的存储位"都不存在。
- **SDK 支持会话中途改档，但仓内未接入**（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）：
  - :2073 SDK `PermissionMode` 有 **6 值**（多出 `'auto'`，仓内冻结类型缺）。
  - :2281 `Query.setPermissionMode(mode)`，文档 "Only available in streaming input mode"；:3791-3797 wire 落点 `set_permission_mode` 控制协议。
  - 仓内 `queryFn` 类型签名（`claudeRuntime.ts:32-34`）收窄成 `AsyncIterable & {close?}`，**类型上抹掉了 setPermissionMode/interrupt/setModel**；实际只用 asyncIterator（:801）与 close（:964）。
  - streaming-input 前提未必满足：prompt 只在有附件时才是 AsyncIterable（:706-708 三元），纯文本走字符串。

## 3. Codex 轴 sandbox/approval 全链

- 默认档：`codexRuntime.ts:134-144` `CODEX_PERMISSION_DEFAULT = {agent:'codex', approvalPolicy:'on-request', sandboxMode:'workspace-write', networkAccess:false}`。
- **一个常量、两个载体（H9）**：① wire：`buildThreadStartParams`（:211-224）只发 approvalPolicy+sandbox，**networkAccess 不是请求字段**（:122-132，只出现在 thread/start **响应**回声里，`compareSandboxEcho` :594-665 校验）；② config.toml 投影：:1396-1401 `ensureCodexHome` → `codexHome.ts:149-152/:173-178/:412`——**resume 姿态从 config.toml 重派生**（生成文件头注释 :134-140）。
- **会话中途改档（in-memory）：不能**——`state.policy` 只在 :1503 初始化，全文件无第二处赋值。
- **协议层线索两条（都未实证）**：
  - `turn/start` schema 承认 approvalPolicy/sandboxPolicy/cwd 也是合法字段且 sticky（"本回合及后续回合"，:246-249 注释），仓内**故意不发**（:250 "thread/start stays the only place it is decided"）；测试只钉字段名（`codexRuntime.test.ts:2150-2160`）。
  - 方法契约快照（`codex-method-contract.json`，codex-cli 0.145.0，2026-08-09 捕获）clientRequest 121 项里有 **`thread/settings/update`**（:132；notification `thread/settings/updated` :211）——名字上唯一像"会话中途改设置"的方法，但**零实现、零 schema 样本、零调用**（`CODEX_METHOD` `codexWire.ts:85-96` 九方法不含它）；且 contract 头部自陈 L6 欠采（clientRequest 实际 126 vs 已录 121）。

## 4. 只读展示面形状

- `contextSurfaceModel.ts:75-99` `ContextRuntimeFacts`：权限唯一字段 `permissionMode: SessionPermissionMode | null | undefined`（:98；三态 :92-97——undefined 整行省略 / null 显 "not reported" / 具体值显映射文案）。**没有 permissionPolicy 字段，Codex 四维姿态无处安放。**
- 文案映射 :171-177 `PERMISSION_MODE_LABELS`（5 模式英文）+ :180-183 null 文案；行构建 :213-231（effort 行之后）。
- 渲染 `ContextSurfaceView.tsx`：纯只读 `<dt>/<dd>` 定义列表 + CopyRowButton，**无任何写入控件**。
- 易误认项：`PermissionQaCard`（`QuestionCard.tsx:498` 起）是**单次工具调用审批卡**（Allow/Deny/…），只解决当次请求，不是会话级管理入口。

## 5. 写入型权限控件：不存在

- IPC 仅两组权限相关 channel，均与会话级模式无关：`MCP_PERMISSION_REQUEST_HOOK_SET/_STATUS`（`ipc.ts:250-251`，IDE Bridge 通知钩子开关——同名不同轴，特此排除）；`CHAT_RESPOND_PERMISSION`（:375，切片 4 单次审批响应通道，preload `index.ts:1445-1454` → main `chat.ts:202-217` → `agent-host/index.ts:656-703`）。
- Settings store 唯一权限字段 `permissionRequestHookEnabled`（`types.ts:194`/`defaults.ts:163`），同为钩子开关。
- `setPermission|changePermission|setApproval|setSandbox` 等全仓除上述噪声零命中。

## 6. 仓内答不出的问题（须实证或设计裁定）

1. `Query.setPermissionMode()` 在纯文本 prompt（非 streaming input）场景的真实失败模式（抛异常/静默无效/自动切换）——仓内零探针。
2. `thread/settings/update` 的参数 schema、能否中途改 approvalPolicy/sandboxMode、对挂起 turn 的影响——零实测报文，疑似 contract 欠采样漏录。
3. `turn/start` sticky 覆盖与 `thread/settings/update` 是否同一底层机制、是否冲突——都只有 schema 层证据。
4. SDK `PermissionMode` 第 6 值 `'auto'` 在 `@anthropic-ai/claude-agent-sdk@0.3.218` 的实际行为、是否需额外开关（类比 bypassPermissions 需 `allowDangerouslySkipPermissions`）。
5. 管理面 UI 形态与持久化位置（`HostSession` 与 `contextSurfaceModel` 均无预留存储位）——设计问题，进规格轮。
