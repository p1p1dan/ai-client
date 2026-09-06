# Evidence — R02-a / R02-b 命令目录（worker → Main）

**日期**：2026-09-06
**关闭**：roadmap R02-a、R02-b
**后续**：R02-c（补全浮层与发送前拦截）

## 一、一处取证更正

上一轮我说过「SDK 有 `getCommands()` 一个方法返回三类，比 pi-app 分三次取更省」。
**那个方法在扩展上下文上，不在 `AgentSession` 上**（`core/extensions/types.d.ts:984`）。

嵌入式宿主持有的是 session，所以只能像 pi 自己的 RPC 模式那样从三处取
（`modes/rpc/rpc-mode.js` 的 `case "get_commands"`）：

```js
session.extensionRunner.getRegisteredCommands()   → source: "extension"
session.promptTemplates                            → source: "prompt"
session.resourceLoader.getSkills().skills          → source: "skill"
```

三个访问器都是公开的（`get extensionRunner()`、`get promptTemplates()`、
`get resourceLoader()`）。**设计不变，实现细节变**：仍然是一次查询、一份列表。

## 二、R02-a worker 侧

新增 `src/agent-host/commandInventory.ts`，策略与 `extensionInventory.ts` 一致——
读的是跨版本边界的 SDK 形状，而命令列表是装饰品，**不可读的条目丢弃，绝不抛出**。

三处承重的细节：

1. **技能保留 pi 的 `skill:` 前缀**。`_expandSkillCommand` 就是靠这个前缀匹配的
   （`agent-session.js:957` `if (!text.startsWith("/skill:")) return text`），
   在这里"整理"成裸名会产出一条运行时静默不认识的命令。已有前缀不重复添加。
2. **每一类各自 try/catch**。一个插件在列自己的命令时抛异常，不该让用户失去技能和模板。
3. **上限 256**，比插件清单的 64 大——技能天然更多，一个包可以发布多个，
   而 `~/.agents/skills` 是全机共享的。

`PiWorkerSession.commands()` **刻意不调 `assertIdle`**：命令列表是只读的，
而需要它的时刻常常正在跑回合。

RPC 层：**未 bootstrap 的 worker 回空列表，不报错**。
这是起始屏的常态，不是故障；报错的话每个调用方都得把它翻译回「没有命令」。

## 三、R02-b Main 侧

`WorkerManager.getSlashCommands()` 与这个类上其他所有读取都不同，四点都是刻意的：

| 别人有 | 这里 | 为什么 |
|---|---|---|
| `requireReadySession` | 无 | 起始屏没有会话，那是常态 |
| `assertIdleEntry` | 无 | 只读，且常在回合中被问 |
| `claimEntry` | 无 | 读列表不是取得会话所有权 |
| 按 sessionId 定位 | 任意 ready worker 均可 | 见下 |

**任意 worker 都权威**，因为托管模式下命令集不随工作目录变：项目作用域被信任开关挡掉，
agentDir 与 `~/.agents` 都固定（R01 evidence §一/§二）。
`sessionId` 仍被优先采用，这样非托管模式下答案也精确——那边项目作用域是真的加载的。

**不缓存。** RPC 是进程内消息传递，菜单每次打开问一次；
而缓存会让用户刚装的技能一直藏着，直到某个东西让它失效。
需要缓存是以后的事，现在加是过早优化加一个失效 bug。

**行级 sanitize**：坏行丢弃，不让整个响应失败。与树或历史页不同，
下游没有任何东西会依据这些行去动作。

IPC `chat:getSlashCommands` 同样**不走 `requireIndexedPiSession` 和
`claimSessionForSender`**，与邻居们不同，理由同上。

## 四、门禁

| 项 | 结果 |
|---|---|
| `pnpm test`（全仓） | **282 files / 4278 tests pass** |
| `pnpm typecheck` | pass |
| `npx biome check src/` | 干净 |
| `git diff --check` | 干净 |

281/4262 → 282/4278：新增 16 条
（`commandInventory` 8、RPC 路由 3、`WorkerManager` 5）。**没有改写任何既有断言。**

**门禁顺序救了一次**：`WorkerManager` 新测试里给 `send()` 传了一个不存在的
`requestId` 字段，71 条测试全绿，`tsc` 判红。

## 五、变异验证

| 变异 | 结果 |
|---|---|
| 技能不加 `skill:` 前缀 | `3 failed \| 5 passed` |
| 未 bootstrap 时抛错而非回空列表 | `1 failed \| 17 passed` |
| 去掉「回落到任意 ready worker」 | `1 failed \| 70 passed` |
| 去掉行级 sanitize | `1 failed \| 70 passed` |
| 无 worker 时抛错 | `1 failed \| 70 passed` |

五处各自判红，恢复后全绿。

## 六、欠项

- **真机未验**。命令目录现在到得了渲染层，但没有消费者——R02-c 落地后一起验，
  同时补 R01 欠的那条（真实客户端里 `~/.pi/agent/skills` 的技能出现在目录里）。
- **`truncated` 无人显示**。字段是诚实的，但渲染层还没有地方说「列表被截断了」。
  R02-c 处理。
