# Evidence — 两个独立维护切片（淘汰后首发失败 · 代理下 dev 挂死）

- **日期**：2026-09-05
- **来源**：[T37-d release closure](./2026-09-03-t37d-release-closure.md) 第 132 行记的两个已知窄问题，
  以及 [T37-d session-brick fix](./2026-09-02-t37d-session-brick-fix.md) 的「未覆盖」两节
- **拍板**：用户 2026-09-05「现在就顺手修掉」（三选一里选「顺手修」，不单独立项）

## 一、未 materialize 会话被空闲淘汰后，第一次发送必然失败

### 原记录与实测的差异

原记录写的是「渲染层的 `hostBoundSessionIds` 只增不减」。**不准确**：
`runSend` 的外层 catch 里就有 `unbindHost()`，标记确实会被摘掉。
所以真实症状不是「永远发不出去」，而是**第一次发送必然报错、文本被退回，第二次才成功**——
第二次因为标记已摘，走的是 `create` 前置。

### 根因：错误码根本没过 IPC 边界

两件事叠加，都在这次才查清：

1. **Main 从来不发 `host.error` 运行时事件**。这个事件类型在 `runtimeEvents.ts` 里定义着，
   全仓搜索 `host.error` 的**生产者一个都没有**——只有类型定义和渲染层的消费者。
2. **Electron 的 `invoke` 拒绝只带 `error.message`**，`WorkerManagerError.code` 不过界。

于是 `ChatComposer` 里那个 `fatalHostErrorCode` 永远是 `null`，它守着的两条分支都是死代码：

- `preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found'` 的**淘汰恢复**（T32 就写了）；
- `shouldRetryBusySend` 的 **`session_busy` 有界重试**（T31-b 的设计）。

淘汰后的发送因此直接落到外层 catch，用户看到的是
`Error invoking remote method 'chat:send': WorkerManagerError: No ready Pi WorkerSlot exists for …`。

### 修法

- `src/main/ipc/chat.ts` 新增 `withWorkerErrorCode`：`chat:send` 捕获 `WorkerManagerError`，
  用本文件已有的 `<code>: <message>` 约定重抛（`pi_session_*` 那些错误一直是这个形状）。
  **只包 send**——其余通道没有对应的恢复分支，包了也没人读。
- `src/renderer/components/chat/sendDispatchError.ts`（新）：`parseSendDispatchErrorCode`。
  **白名单**只认 `session_not_found` / `session_busy` 两个码，不做通用 `^(\w+):` 解析——
  否则无关失败会被喂进为这两个码写的恢复路径。词边界守卫让
  `pi_session_not_found`（索引里根本没这一行，是另一回事）不会被读成 `session_not_found`。
- `ChatComposer.tsx` 的 `sendAndWait`：给 `chat.send` 挂 `.catch`，认得的码写进
  `fatalHostError`/`fatalHostErrorCode` 后返回，让下面既有的两条分支自己动；
  **认不出的错误原样抛出**，行为与今天完全一致。

### 顺带复活的东西（明示）

`session_busy` 的有界重试（≤8 次、每次 250ms、`sawUserEcho` 一真就停）**一并恢复**。
这不是新功能，是 T31-b 设计里一直写着、但因为同一个断链从未真正跑过的行为。
重试安全的理由：`WorkerManager.send` 的 busy 判定发生在写 `activeRequestId` **之前**，
被拒的那次没有任何副作用，不存在重发导致双发。

### 两处静态扫描断言的改写

格式化把 `chat.send(...)` 的成员链拆行后，两条**源码字符串**断言失配：

- `composerStopStatic.test.ts`：锚点去掉 `.send({` 尾巴（它守的是**顺序**不是排版）；
  「只有一个调用点」改断言 `.send({` 出现一次（该测试扫描前已剥注释，
  第 1331 行提到 `chat.send()` 的那句注释不会把计数灌水）。
- `sendExperienceWiring.test.ts`：`'attemptId,\n        text: trimmed'` 改为
  `/attemptId,\n\s+text: trimmed/`，缩进无关。守的事实没变：同一个 attemptId 与正文同行相邻。

## 二、带 `HTTP_PROXY` 时 `pnpm dev` 挂死

现场早有定论（T37-d session-brick evidence §「未覆盖」）：Chromium 会拿 `HTTP_PROXY`
去代理渲染进程加载 `http://localhost:5173` 的请求然后卡住，窗口不出现、调试端口收连接不回包；
**大写 `NO_PROXY` 不管用，Chromium 读的是小写 `no_proxy`**。当时只在探针里绕过了，
直接 `pnpm dev` 仍然挂且无任何提示。

### 修法

- `scripts/dev-proxy-bypass.mjs`（新）：`withLoopbackProxyBypass(env)` 纯函数。
  探到任一代理变量（`HTTP_PROXY`/`http_proxy`/`HTTPS_PROXY`/`https_proxy`/`ALL_PROXY`/`all_proxy`）
  就把 `localhost,127.0.0.1,::1` **补进**`no_proxy` 与 `NO_PROXY` 两个拼写。
  两个都写：小写给 Chromium，大写给 Node 自己的 fetch 栈，两者不一致本身就是坑。
  **只增不替**——开发者自己的绕过清单是他自己的。没设代理时原样返回，不动 env。
- `scripts/dev.js`：`buildChildEnv` 之后套一层 `resolveChildEnv`，命中时打一行日志。
  顺序是「先剥凭据、后补绕过」——后者只加 `no_proxy` 条目，不可能把刚剥掉的东西带回来。

## 验证

```text
pnpm exec vitest run（全量）        → 273 files / 4176 tests 全绿
  新增 src/renderer/components/chat/__tests__/sendDispatchError.test.ts   6 条
  新增 scripts/__tests__/dev-proxy-bypass.test.mjs                        6 条
  新增 src/main/ipc/__tests__/chatPiWorkerRouting.test.ts 两条（码前缀 / 普通 Error 不动）
pnpm typecheck                      → pass
pnpm typecheck:agent-host           → pass
pnpm exec biome check src/ scripts/ → 987 files 干净
git diff --check                    → pass
```

`chatPiWorkerRouting.test.ts` 的 WorkerManager mock 补了 `WorkerManagerError` 导出——
`chat.ts` 现在要 `instanceof` 它，mock 缺这个导出会让整份 mock 在拒绝路径上炸。
类写在 mock 工厂里（`vi.mock` 会被提升），测试再从被 mock 的模块导入同一个构造器。

## 欠项

- **两条都没在真机复现原始现场**。淘汰那条要等 15 分钟空闲 TTL；代理那条要一台配了代理的机器。
  证据是单测与代码路径判定，不是一次成功的手动复现。
- `session_busy` 重试复活后的真机表现未观察（连发两条消息、第二条撞上前一轮拆卸窗口）。
