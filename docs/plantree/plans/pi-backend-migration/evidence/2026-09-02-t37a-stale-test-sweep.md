# T37-a stale test sweep — 2026-09-02

[T37 review-fix evidence](./2026-09-02-t37-post-t36-review-fixes.md) 记录的 20 条 pre-existing
失败在此关闭。逐条溯源后结论一致：**全部是 Pi-only 收敛留下的陈旧断言，零生产缺陷。**

## 溯源

三个收敛提交改了行为却没有同步这些测试：

| 提交 | 改了什么 | 拖红的测试 |
|---|---|---|
| `c954b3e1` 收窄聊天运行时为 Pi | `resolveAgentWireName` 不再把空 `agent` 当 legacy；renderer 不再上报 agent；`setSessionEffort` 去掉 agent 参数；Composer 移除 agent 变量 | `sessionIndexMerge`(12)、`chatSessionsSendGuard`(1)、`sidebarRowRemoval`(1)、`t25ModelPickerStatic`(1)、`piModelWiring`(1) |
| `8aafd450` 关闭 T35 旧运行时残留 | `permissionMode` 事实退出 `reduceSessionRuntimeFacts` | `sessionRuntimeFacts`(2) |
| T36 Pi TUI 收敛 | `SessionManager.create` 拒绝 `kind: 'agent'`；`ExtensionUiUnsupportedNotice` 新增 `onOpenTui` | `SessionManager`(1)、`extensionUiSurfacesStatic`(1) |

## 关键核实：空 `agent` 该不该隐藏

12 条里最需要判断的是 `mergeSessionIndex` 丢弃无 `agent` 行是否为回归。结论**不是**：

- 两条写入路径（`chat:createSession`、`chat:registerSession`）都显式 stamp `agent: PI_AGENT`，
  本版本写出的行必然带绑定；无绑定行只可能来自该字段存在之前的旧版本，那时它意味着 Claude。
- Main 侧 `assertPiCompatibleIndexRow` 对同样的行直接抛 `pi_session_agent_mismatch`。
  渲染层若把它显示出来，用户点开只会得到一个起不来的会话。
- 与 D14 一致：Claude/Codex 历史只经只读 import 回来，不靠索引行复活。

语义已由 `agentBindingMerge.test.ts` 完整覆盖（"hides a row written before the field existed"、
"rejects a pre-agent-field row instead of treating it as Pi"），故不新增重复用例，
只修复 `sessionIndexMerge.test.ts` 的 fixture（`entry()` 补 `agent: 'pi'`）。

同时修正 `sessionIndexMerge.ts` 顶部已失真的注释——它仍写着"这里是缺失 `agent` 变成绑定的唯一位置"，
而实现早已改为隐藏。注释与实现相反比没有注释更危险。

## 改动

- `sessionIndexMerge.test.ts`：fixture 补 `agent: 'pi'`。
- `sessionIndexMerge.ts`：重写 S2(b) 注释，说明"只有显式 pi 存活"并指向 Main 的同源拒绝。
- `SessionManager.test.ts`：persistOnDisconnect 用例改用 `kind: 'terminal'`（与兄弟用例一致）；
  agent-kind 禁令本身由 `t35FinalAbsence.test.ts` 静态断言守住，覆盖未丢失。
- `chatSessionsSendGuard.test.ts`：`createSession` 期望去掉 `agent`；另修好第一条后暴露的
  第二条陈旧断言——`send` 现在携带 `attemptId`，改为 `stringMatching(/^send-attempt-/)`。
- `sidebarRowRemoval.test.ts`：`registerSession` 期望去掉 `agent`。
- `sessionRuntimeFacts.test.ts`：折叠用例从已删除的 `permissionMode` 换成仍在的 `session.stderr`。
- `t25ModelPickerStatic.test.ts`：`setSessionEffort(sessionId, nextEffort)` 新签名。
- `piModelWiring.test.ts`：由 `toContain('const composerAgent = PI_AGENT')` 改为
  `not.toContain('composerAgent')`——收敛比当初写测试时更彻底，钉住"不存在"而非某个常量。
- `extensionUiSurfacesStatic.test.ts`：钉住 T36 新增的 `onOpenTui` prop，而不是把它从匹配里抹掉。

## 验证

- 全量 `vitest run` — **254 files / 3884 tests 全部通过，0 失败**。
- `pnpm typecheck` — pass。
- Scoped Biome（9 个改动文件）— pass。
- 未做：packaged Electron 构建与 GUI 点验，仍归 T37-c 高资源环境。

## note

修陈旧测试有把测试改成"复述当前实现"的风险。这里的取舍是：每条都先去生产代码确认
当前行为是**有意为之**（找到对应收敛提交 + 找到 Main 侧或姊妹测试的同源约束），
再改断言；`piModelWiring` 与 `extensionUiSurfacesStatic` 两条还顺势把断言改强。
