# T37-b 资源 / 长稳门禁 — 2026-09-02

**Role**：evidence · **Status**：accepted
**Related**：[roadmap T37](../roadmap.md#t37--pi-only-release-gates--in-progress) · [D15](../decisions/015-main-owned-worker-manager.md) · [D17](../decisions/017-worker-pool-policy.md) · [D19](../decisions/019-tui-owns-the-gui-session-file.md)

## 结论

有界池、空闲回收、淘汰后重开、内存与 worker/PTY 孤儿进程，全部用**真进程**跑通并留下数字：
真 Electron main + 真 utilityProcess worker + 真 Pi CLI PTY，不是 fake slot。

期间发现并修掉一个真实缺陷：**worker 的 dispose 应答与它自己的退出赛跑，输了就把一次成功的关闭报成失败**（见下）。

## 新增工具

| 文件 | 作用 |
|---|---|
| `scripts/probes/t37b-longevity-probe.ts` | 在真 Electron main 内跑完整场景，输出 JSON 报告 |
| `scripts/run-t37b-longevity-probe.mjs` | esbuild 打包 → 起 Electron → 校验报告 → Electron 退出后做 PID 普查 |

```bash
pnpm build:agent-host                      # 需要 out-agent-host/worker.js
node scripts/run-t37b-longevity-probe.mjs  # 常规门禁：6 轮 churn
AICLIENT_T37B_CYCLES=20 node scripts/run-t37b-longevity-probe.mjs   # 长稳版
```

runner 把 `HOME`/`XDG_*` 指到临时目录，所以探针不会写用户真实的 `~/.pilab` 或 Pi CLI 配置。
探针进程内的 bundle 放在 `node_modules/` 下的临时目录——原生 `node-pty` 必须能被 require 到。

## 门禁与实测

| 门禁 | 做法 | 实测 |
|---|---|---|
| 有界池 | capacity=2，连开 3 个会话 | 池恒为 2；被淘汰的是最久未用的 `pool-a`，其进程随即消失 |
| 保护位 | 两个 slot 都被窗口 claim 后再开一个 | 抛 `worker_capacity_reached` 且 `retryable=true`；两个在用 worker 不受影响 |
| 空闲回收 | TTL 2000 ms / 扫描 200 ms，前台 claim 一个 | 后台 slot 在 **2010–2184 ms** 被后台扫描回收；前台 slot 熬过 4000 ms（2×TTL）不动 |
| 淘汰后重开 | 用被淘汰会话的 durable 文件 resume | `session.resumed → session.history → session.status`，hydrate 出 2 条历史，续发回合正常流式 |
| 内存 | 20 轮 create→send→close | Main RSS **187.5 → 189.8 MiB（+2.3）**，第 12 轮起基本持平，不是线性上涨 |
| worker 孤儿 | 每轮关闭后查进程表 + 退出后普查 | 关闭到进程表清空 **≤24 ms**；20 轮共 28 个 worker，Electron 退出后全部不存在 |
| PTY 上限 | 2 个真 Pi TUI 都活着时再开一个 | 抛 `Pi TUI capacity reached (2)`，两个在用终端不受影响 |
| 长挂起 + 淘汰 | 挂起一个再开新的；另一个挂起 3 s 后回到前台 | 被挂起的最久者进程真的被杀；3 s 后提升是复用而非重开（spawn 数停在 3） |
| PTY 孤儿 | 带活 worker + 活 PTY 触发 app quit | 关停后 worker 与 3 个 PTY 全部消失，runner 复查无残留 |

## 资源数字（本机）

主机 5361 MiB 内存 / 2 核 Linux，`resolveDefaultWorkerCapacity()` 判定为 **3**（D17 的 2/3/4 分档）。

| 进程 | RSS |
|---|---|
| Pi worker（utilityProcess） | **190–196 MiB** / 个（5 次运行 10 个样本） |
| Pi TUI（PTY 里的 CLI） | **120–124 MiB** / 个 |
| Electron main | ~188 MiB |

RSS 含共享映射，所以按个数相加是**上界**而非真实占用。按上界估：本机默认 3 个 worker + 2 个 TUI ≈ 830 MiB，
再加 main 与 renderer，仍在 5 GiB 主机的可用范围内——D17 的分档站得住。

## 修掉的缺陷：dispose 应答输给进程退出

**现象**：探针首次运行时，一次 `closeSession` 以 `WorkerSlotError: Worker exited (code=0 signal=null)` 失败。

**成因**：`src/agent-host/worker.ts` 在 `handleDispose` 里先 `postMessage` 应答，再 `setImmediate(() => process.exit(0))`。
消息投递是异步的，进程退出可能抢在投递之前。Main 侧 `WorkerSlot.disposeInternal` 于是拿到 `WORKER_EXITED`，
**即使 `finalizeDisposed()` 已经确认进程干净退出，仍然把整个 dispose 抛错**。

**影响**（都是"实际成功却报错"）：

1. `closeSession` 向渲染层报错，而会话其实已经关干净了。
2. 更糟的一条：容量满时 `createSession` 要先淘汰旧 slot，淘汰路径抛错会让**新会话创建失败**，用户必须重试。
3. 抛错跳过了 `ownedSlots.delete(slot)`，已释放的 slot 对象被永久留在集合里。

**修法**（`src/main/services/agent-host/WorkerSlot.ts`）：`finalizeDisposed()` 返回确认到的退出信息；
只有当错误是 `WORKER_EXITED` **且**退出是干净的（`code=0`、无信号）时，才把它当作"应答丢了但事情办成了"而放行。
其余情况——非零退出、被信号杀、应答内容非法、应答超时——依旧照常抛错。这与 T29-a 定的
"ACK + 进程退出确认"契约一致：进程退出是更强的证据，应答只是锦上添花。

**为什么不改 worker 侧**：让 worker 退出前多等一会属于计划里明确拒绝的"固定 disposal sleep"，
而且无法可靠知道消息何时送达。

**复现频率**：只在第一次运行触发过一次；之后 6 次完整运行（每次 14–28 次 dispose）未再出现，量级约百次 dispose 一次。
新增用例 `completes disposal when a clean exit outruns the dispose ACK` 把这条钉死——去掉修复它就红。

## 顺带记录的两条事实

- **进程表尾巴**：Electron 报 `exit` 事件之后，PID 还会在进程表里停留最多 24 ms 才消失。
  这是回收时序，不是泄漏；但意味着"淘汰旧 slot 立刻起新 slot"时，内存峰值会短暂超过 capacity×单 worker。
- **PTY 主动销毁不发 exit 事件**：`#disposeNow` 先摘掉 live 记录再 `kill()`，所以 `onExit` 回调被过滤掉，
  只发 `state: 'dead'`。探针报告里 `pty.exits` 为空是设计如此，不是漏事件。

## 验证

```text
node scripts/run-t37b-longevity-probe.mjs            → pass ×6（其中一次 AICLIENT_T37B_CYCLES=20）
node scripts/run-t37b-longevity-probe.mjs（修复后）  → pass
pnpm exec vitest run（全量）                          → 255 files / 3895 tests 全绿
pnpm exec vitest run <agent-host + terminal + ipc>   → 26 files / 198 tests 全绿
pnpm typecheck                                       → pass
pnpm typecheck:agent-host                            → pass
pnpm exec biome check <4 个改动文件>                  → pass
git diff --check                                     → pass
```

## 未覆盖（留给 T37-c/-d）

- packaged electron-builder 产物、真账号、真模型端点：探针用的是本地假 SSE 端点与临时 agent 目录。
- macOS / Windows 的进程与 PTY 行为：本次只在 Linux 上跑。
- 多窗口、多小时级 soak：本次最长 20 轮 churn，量级是分钟。
- crash → restart 预算在长稳条件下的表现：仍以 T30 的证据为准，本次未重测。
