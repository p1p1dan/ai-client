# 第 7 批 · skills / 模板 / 通用提问 / MCP bridge

Role: evidence。日期：2026-09-12。对应[执行顺序](../../README.md#执行顺序)第 7 批。
施工计划见 [topic](../../topics/p5-1-skills-templates-ask.md)。

## 结论

四块全部落地，四次提交：

| 块 | 内容 | 提交 |
|---|---|---|
| K1 | 技能加载、`skills` 提示词槽、`skill` 工具 | `4e0f1f3e` |
| K2 | 提示词模板、斜杠命令表、发送时展开 | `4e0f1f3e` |
| K3 | F5 通用提问整条纵切 | `4916a633` |
| K4 | MCP bridge 与 exec 长驻子进程能力 | `d4fcd600` |

门禁（最后一次全量）：`tsc --noEmit` 根与 `src/runtime` 均通过；
`vitest run` **382 文件 / 5394 测试**全绿（批前 381 / 5372）；
`biome check src/runtime` 干净。

## 各块的实际做法与关键取舍

### K1 · 技能

发现规则照搬 pi 的 `docs/skills.md`（即 agentskills.io 标准），路径换成本应用的统一
agent 目录：`<agentDir>/skills/`、`~/.agents/skills/`，以及仅在 `projectTrusted`
为真时才读的 `.pi/skills/` 与 `.agents/skills/`。

**没有调 pi-agent-core 现成的 `loadSkills()`**，尽管它就在依赖里。原因不是偏好：
那个函数要一个 `ExecutionEnv`，它的文件读取绕开我们的 `runtimeHostIo`，而 ARD D11
第 4 条点名「skills 加载」必须收敛到那个出口——加密机上绕过去读到的是密文。
`Skill` 的字段形状仍与 pi 保持一致，用户为 pi CLI 写的技能不用改。

**加了 `skill` 工具，而不是让模型 `read` 技能文件。** pi 让模型直接 `read`，因为
pi 没有逐路径权限门；我们有——`plugins/permissions/index.ts` 对工作区外的路径判
`ask`，而技能根**全部**在工作区外。照抄 pi 的做法会导致每加载一次技能弹一次权限卡。
工具只接受**名字**，从已扫到的目录里取，不接受任意路径，所以放行它不是开口子。
[测试](../../../../../src/runtime/__tests__/skills.test.ts)里有一条专门跑这个：
整个 runtime **不配置任何 approve 回调**，一旦走到 ask 分支权限内核就会抛
「approval UI is not connected」，所以那条用例通过本身就是「没弹卡」的证明。

`segments.ts` 里最后一条 `SlotDeferral` 随之删除，`deferredSlots()` 现在为空。

### K2 · 模板与斜杠命令

- `substituteArgs` / `parseCommandArgs` 从 pi 的 `harness/prompt-templates.js`
  逐字移植，保证同一份模板在两个后端展开结果一致。
- **展开发生在发送路径，展开后的文本就是会话里的用户消息。** 这不是随手决定：
  pi 的 `session.prompt()` 存的也是 `expandedText`，两个后端如果一个存原文一个存
  展开结果，同一条转录从哪边读会长得不一样。
- 渲染层**零改动**：`chat:getSlashCommands` → `worker.commands` 这条链早就在，
  `parseSlashLine` 的 `[^\s]+` 本来就能吃 `skill:pdf`，`resolveSlashAction` 对
  非 builtin 来源直接判 `runtime` 发给 worker。

一处与 pi 的差异，已在代码里注明：pi 的命令名解析只看第一个空格，本实现允许命令
独占一行、其后各行作为参数文本（`\s+` 而非 `[ \t]+`）。

### K3 · F5 通用提问

**不是修回归，是补一个从未存在的能力。** 2026-09-09 定性说得很清楚：`question.requested`
在 legacy 与 native 上都没有生产者。本轮补的是整条纵切，其中**最后一环此前全仓不存在**——
`QuestionCard` 的 `interactive` 变体没有任何渲染点，`MessageTimeline` 只渲染 `frozen`
与 `permission`。也就是说即使事件到了，屏幕上也不会出现任何东西。

- runtime `ask` 工具：一次最多四问，每问 2～4 选项。**工具自己给每一问分配 id**，
  因为 `QuestionResolvedEvent.answers` 在没有 id 时按问题原文做键，而一次调用里
  两问同字面就会撞键，且到渲染层时已经是 record，撞掉的那条找不回来。
- **不做权限门**：提问本身就是交互，在提问前再弹一张授权卡等于「请允许我问你」。
- 注册为 `read` 档，**plan 模式保留**——正是最该提问的时候。
- **宿主没有地方显示问题时根本不注册这个工具**。探针与 P2-0 基线采集因此不受影响，
  也不会出现「模型反复调用一个没人答的工具、回合挂死」。
- worker 侧 `questionPrompt.ts` 与 `permissionPrompt.ts` 同构，两点故意不同：
  **不设超时**（权限门要超时是因为被遗忘的对话框会静默卡住工具调用；问答卡就在
  用户眼前，自动作答等于替他做决定），以及**「跳过」是正常答案不是拒绝**。
- 卡片挂在**输入框上方**而不是时间线里：在时间线里它会随流式输出滚走，而会话正
  卡在 `waiting_question` 上等它。
- 收起由 worker 的 `question.resolved` 触发，不由点击触发，所以同一会话的其他窗口
  也会同步消失。

两处门禁测试按**已有先例**放行名字而非方言：`PendingQuestionDock.tsx` 与
`CHAT_RESPOND_QUESTION` 都曾属于 Claude 时代的 `canUseTool` 方言，T31 删掉的是那个
方言；2026-09-10 已经用同样的理由让 `CHAT_RESPOND_PERMISSION` 回来过。Claude 时代的
生产者 `questionBridge.ts` 仍在删除清单上，并**新增一条**：输入框不得成为第二个应答方。

### K4 · MCP bridge

**不引 `@modelcontextprotocol/sdk`。** 它的 `StdioClientTransport` 自己用
`node:child_process` 拉起服务器，而 D11 第 4 条点名 MCP stdio bridge 必须收敛到
runtime 的出口。绕过出口起的进程在加密机眼里是另一个身份，症状就是 D11 当初写的
那一组。于是传输层自己写，协议部分反而是小头。

配置沿用生态既有形状 `{"mcpServers": {...}}`（Claude Desktop / Cursor 等写的就是
这个文件），位置：

| 文件 | 何时读 |
|---|---|
| `<agentDir>/mcp.json` | 总是 |
| `<cwd>/.pi/mcp.json` | **仅当 `projectTrusted` 为真** |

项目文件那条是「连打开都不打开」，不是「读了但忽略」——一条 MCP 声明就是一个要被
执行的程序。测试里用记录读取路径的 source 正向验证了这一点。

工具命名 `mcp__<server>__<tool>`，**每次调用先过权限门**：MCP 工具能做它服务端能做
的一切，且本地无从静态判定（没有路径可查、没有命令可解析），所以默认档与
accept-edits 档都判 `ask`，只有 auto 档放行——不继承给编辑操作的信任。

### K4 顺带修掉的一个真缺陷

新增的 `exec.spawn()` 第一版有个 bug，**是测试先发现的**：走 runner 载体时
（`standaloneHost` 一律配 node，所以这是默认路径）leader 是 runner 而不是命令本身，
命令自己退出**不会**触发 leader 的 `close`。第一版只处理 `spawn-error` 那条 IPC 消息，
于是服务器中途挂掉时所有在途请求要一直挂到各自超时（默认 120 秒），调用方分不清
「死了」和「慢」。现在 runner 的 exit 消息即判定子进程已消失。
`host.test.ts` 的 `reports the command exiting on its own` 就是钉这条的。

## 取证方式

MCP 一块用的是**真的 stdio MCP 服务器**（`src/runtime/__tests__/fixtures/mcp-echo-server.mjs`），
经真实 `exec.spawn` 起进程、真实管道握手、真实 `tools/call` 往返。不打桩传输层：
D11 说兼容性是**进程**的属性，打桩只能证明客户端记账对，证明不了载体。
fixture 用 argv 切换五种行为（正常 / stdout 有非 JSON 噪声 / 分页 / 永不应答 / 调用中崩溃）。

变异检查（每处单独改坏、确认对应用例判红）：

| 变异 | 判红的用例 |
|---|---|
| 去掉 `.agents` 根的「根目录 .md 不算技能」分支 | 技能发现 |
| PromptPlugin 不拼接 skills 段 | 目录段进真实请求 |
| store 丢掉 `cancel` 标志 | 跳过被当成空答案 |
| ChatWorkspace 不挂 dock | 挂载位置 |
| `questionPrompt.drain` 空转 | dispose 不留悬挂 promise |
| 忽略 runner 的 exit 消息 | 命令自行退出的上报 |
| 去掉 MCP 项目信任门 | 未受信任时不读项目文件 |

## 本轮不能声称的事

- **没有真机点验**。全部是开发机上的自动化测试，没有打包、没有在真实 Electron
  窗口里点过问答卡，也没有接过真实的第三方 MCP 服务器（用的是本仓 fixture）。
  按 2026-09-11 的规矩，GUI 现场与加密机回归并入最后一次上机。
- **技能/模板/MCP 的安装与管理界面不在本批**。本批只做加载与使用；H/19 的插件面板
  管的是 pi 包，不是这三类资源。
- MCP 的 resources / prompts / sampling / roots / HTTP-SSE **未实现**，代码里明确写出。
- MCP 工具的参数校验用服务端自报的 JSON Schema 原样转发给 typebox 的 `Check`。
  常见形状没问题，但用了 typebox 读不准的关键字时会以 `invalid_tool_arguments` 失败，
  而不是静默放行——方向是安全的，但不是「任意 JSON Schema 都支持」。

## 复现

```bash
npx tsc --noEmit -p src/runtime/tsconfig.json
npx vitest run src/runtime/__tests__/skills.test.ts \
  src/runtime/__tests__/askQuestion.test.ts \
  src/runtime/__tests__/mcp.test.ts \
  src/runtime/__tests__/host.test.ts \
  src/renderer/components/chat/__tests__/pendingQuestionDock.test.ts
npx vitest run
```
