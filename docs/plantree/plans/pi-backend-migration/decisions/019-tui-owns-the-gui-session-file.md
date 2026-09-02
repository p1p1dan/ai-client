# D19 — TUI 接管 GUI 的同一份会话文件

**状态**：Active（2026-09-02 落地，关闭 [Q17](../open-questions.md)）
**取代**：T36 的临时语义「同 workspace/config 新开一个 TUI session」

## 决定

进入终端模式时，Pi TUI 以 `pi --session <file>` 打开 GUI 当前会话的那份 durable JSONL，
**继续同一段对话**，而不是另起一个新会话。交互所有权由一把进程级单一所有者的锁看守。

## 为什么

T36 当初选较弱的「新开 session」是因为同文件接管需要先证明四件事
（flush ACK、单写 authority、崩溃恢复、返回 GUI 重开），成本不明。

pix 已经把这条路跑通了（`apps/desktop/src/main/pi-tui-session.ts`），提供了现成蓝图，
成本大幅下降。同时「新开 session」对用户是个真实缺陷：切到终端看不到刚才在 GUI 里的上下文。

## 实现要点

| 环节 | 做法 | 依据 |
|---|---|---|
| 启动参数 | `buildPiTuiArgs(cliPath, sessionFile)` → `pi --session <file>`；无 file 时开新会话 | 等同用户在自己终端里敲的命令 |
| 单写保证 | `PiTuiExclusiveGuard`，**单一所有者**而非按会话分区 | `presentationMode` 是全局单值设置，GUI/TUI 本就互斥；按会话建模的是 UI 产生不出的状态 |
| GUI → TUI | `transferTo` 而非 `tryAcquire` | pix 的教训：只用 tryAcquire 时锁与控制器 key 一旦失步（macOS firmlink、挂起/取消竞态），陈旧 owner key 会拒绝之后**所有**开启请求 |
| TUI → GUI | `chat:send` 前 `releaseSessionForHostPrompt()`：按会话杀掉 TUI 再释放锁 | Pi CLI 没有交接握手，「停掉另一个写者」是唯一可得的保证 |
| 路径匹配 | `normalizeSessionKey`：macOS `/private` 折叠 + 大小写 + 尾斜杠 + 反斜杠 | 索引行与 realpath 会对同一文件给出不同写法；裸字符串比较会静默杀不掉，留下两个写者 |
| 所有权归还 | TUI 退出事件携带 `sessionFile`，Main 据此释放锁 | 否则用户 `/exit` 后该会话在本次运行内永久失去 GUI 发送能力 |

## 接受的边界

pix **没有** flush ACK 握手，崩溃恢复也未证明——它靠 pi CLI 自身的追加写语义兜底。
采用此方案即接受这一较粗的语义：Q17 原列的四项证明中，只有「单写 authority」被真正解决，
「返回 GUI 重开」靠硬杀 TUI 达成。若将来出现 JSONL 尾部损坏，应从这里开始查。

未绑定 runtime 的新会话（还没发过第一条消息）没有 `runtimeIdentity`，此时开终端仍是新会话——
它本来也没有可继续的对话。

## 证据

- `src/main/services/terminal/piTuiSession.ts` — 纯函数基座，10 条测试
- `src/main/services/terminal/__tests__/PiTuiPty.test.ts` — 会话绑定 5 条（含路径漂移与退出事件）
- 参考实现：`pix/apps/desktop/src/main/pi-tui-session.ts`、`index.ts` 的
  `pix:terminal:open` / `pix:agent:prompt`
