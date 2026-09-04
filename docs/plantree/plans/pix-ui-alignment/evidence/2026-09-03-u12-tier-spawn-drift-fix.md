# Evidence — U12 权限档「显示 ≠ 实际」缺陷修复

**日期**：2026-09-03
**分支**：`feat/pi-primary-backend`
**归属**：U12（批次 2.5）的缺陷修复；在批次 4 收尾后回答用户提问「权限档改了之后是不是就不能再改了」时核查发现
**相关**：[evidence-u12](../topics/evidence-u12-session-permission-tier.md)、[U05 evidence](./2026-09-03-u05-u03b-unbound-chat.md)

## 一、先回答那个提问本身

**权限档可以反复改，没有任何一次性锁定。** 芯片是四选一单选组，四项一直可选；
`sessionTierAuthorizer` 的授权回调每次都重新读当前值（`const tier = currentTier`），所以改完下一次工具调用就生效。
UI 上只有三种临时不可点：回合运行中（刻意，tooltip 已说明）、输入框整体禁用、Host 未就绪。

**真正中途改不了的是项目信任**（`projectTrusted`）：worker bootstrap 时定死，要换只能重开会话。
它和档位是**两层**而非两种模式——档位决定单次调用的裁决，项目信任决定要不要加载/写入**项目级持久授权**。

## 二、核查中发现的两个真缺陷

两个都让**芯片显示的档位**与**worker 实际执行的档位**分叉，且**方向都是实际更宽松**。

### 缺陷 A — 首次发送前设的档位被静默丢弃

`WorkerManager.setPermissionTier` 只能推给已存在且 ready 的 worker：

```ts
const entry = this.entriesBySession.get(sessionId);
if (!entry?.slot || entry.state !== 'ready') return requestId;   // 静默 return
```

首次发送之前根本没有 entry（`createSession` 只在 `runSend` 里调）。渲染器那侧又是
`.catch(() => undefined)`，用户看不到任何异常。等发消息、worker 建起来，authorizer 用的是硬编码
`let currentTier = 'pragmatic'`。

结果：新建对话 → 先设「只读」→ 发消息 → 芯片写「只读」，运行时跑「务实」。
**「先设好安全档再让它跑」恰恰是这个控件最自然的用法**，所以这条不是边角。

### 缺陷 B — 崩溃重启后档位回落默认

`createSessionTierAuthorizer()` 在每次 `bootstrapInternal` 里重建。`restartEntry` → `spawnForEntry` →
新 `PiWorkerSession` → 新 authorizer，又从 `pragmatic` 起。没有任何地方把用户选的档位重推一遍。

### 共同根因

档位只在**用户点击那一刻**推送一次，从没在**worker 建好之后**重放过。

## 三、修法

**把档位变成 spawn 的一部分**，和 U05 的 `unbound` 走同一条路——这样连「bootstrap 完成到重推之间」的窗口都不存在，
第一次权限关卡就已经拿到正确值。

| 层 | 改动 |
|---|---|
| `sessionTierAuthorizer.ts` | `SessionTierAuthorizerOptions.initialTier`；`currentTier` 用它初始化 |
| `piWorkerSession.ts` | bootstrap 时把 `options.tier` 传给 authorizer |
| `workerRpc.ts` | `WorkerBootstrapPayload.tier?` + 校验（复用既有 `VALID_TIERS`） |
| `createPiWorkerSlot.ts` | 透传，仅在非默认时带上 |
| `WorkerManager.ts` | `ManagedSlot.tier`（可变）；create/resume 入参写入；`spawnForEntry` 带出；**`setPermissionTier` 在可达性检查之前先记到 entry 上**，于是「推不到」从静默丢弃变成延迟到下次 spawn |
| `chat.ts` | createSession/resumeSession 接受 `tier`，`spawnTier()` 校验 |
| `ChatComposer.tsx` | `readSessionTier(sessionId)` → 三个 dispatch 点（create + 两处 resume）带上 |
| `useResumeSession.ts` | 侧栏点开会话同样带上——它也会 spawn worker |

### 三处刻意的选择

1. **fork 不继承档位**（与 `unbound` 相反）。继承信任姿态是**安全方向**（scratch fork 保持不受信任）；
   继承 `fullopen` 是**不安全方向**，而且 fork 自己的（空）偏好会让芯片显示默认档——正好复刻要修的这个分叉。
2. **`tier` 不进 `sameBootstrap`**。`unbound` 进了，因为它是一次性定死的安全姿态；档位本来就设计成运行期可改，
   把它算进「是不是同一个会话」只会让合法的重复 bootstrap 失败，且换不来任何安全收益。
3. **非法档位丢弃而非报错**。这个值来自渲染器自己的 per-session 偏好存储；一条损坏的记录不该让会话根本起不来。
   丢弃也是安全方向——worker 回落默认档，默认档对一切都发问，所以坏值永远不可能放宽任何东西。

### 一处**没有**改的地方

Main **不**为「还没有 entry 的会话」保存档位。那份偏好的所有者是渲染器（它持久化在 per-session 存储里），
在 Main 再存一份就是第二个真值来源，还要自己解决淘汰问题。缺陷 A 因此在**渲染器→IPC** 这一层关闭：
首次发送时 `runSend` 从芯片写入的同一个存储读出来，随 `createSession` 一起下发。

## 四、验收与门禁

**新增/改动测试**：

- `sessionTierAuthorizer.test.ts` +3：按种子启动、无种子仍默认、`setTier` 可双向覆盖种子（证明「不是一次性锁定」）。
- `WorkerManager.test.ts` +7（含 fake slot 补上 `worker.setPermissionTier` 应答）：
  create/resume 带档位、未动过的会话不带、**崩溃重启用在用档位**、多次改用最新值、fork 不继承、
  无 worker 时调用是无害延迟而非抛错。
- `chatPiWorkerRouting.test.ts` +3：合法档位透传、缺省不带、坏值丢弃且不影响会话启动。
- `permissionTierWiring.test.ts`（新）+5：渲染器三个 dispatch 点都带、读的是芯片写的同一个存储、
  未设置时整个 key 不出现、侧栏 resume 同样带上。

**变异验证**（三处修复点各拆一次）：

| 变异 | 转红 |
|---|---|
| authorizer 的 `initialTier ?? 'pragmatic'` 退回 `'pragmatic'` | 1 条 |
| `spawnForEntry` 去掉 `...(entry.tier ? ...)` | 4 条 |
| `ChatComposer` 的 createSession 去掉 `...(spawnTier ? ...)` | 2 条 |

**门禁**：全仓 **261 files / 4049 tests pass**；`pnpm typecheck` + `pnpm typecheck:agent-host` pass；
biome 35 个改动文件干净；`git diff --check` clean。

## 五、欠项

- **GUI 点验未做**：与 U09/U12/U02/U03-a/U05 的待做点验合并一次出图。届时值得手验一次「新建对话 → 先设只读 → 发消息 → 确认写工具被拦」。
- `chat:setPermissionTier` 的渲染器侧仍是 `.catch(() => undefined)`。修复后「推不到 worker」已是正常情形（不再是错误），
  但真正的 RPC 失败同样被吞。影响有限（本地写入才是下次 spawn 的权威），未在本次改动。
