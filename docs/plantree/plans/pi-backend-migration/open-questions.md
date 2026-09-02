# Open Questions — Pi-only Application Convergence

> 只保留会影响未来实现、尚未解决的问题。D1–D18 的当前状态见 [决策索引](./decisions/README.md)；历史已解决问题见 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/open-questions.md)。

## ~~Q7 — 首次运行空模型标识是否仍可复现~~ — **已关闭 2026-09-02**

早期 “Use my own setup” 首次发送曾出现 `Cannot read properties of undefined (reading 'startsWith')`。

**关闭依据**：产生该崩溃的 catalog 解析路径已随 Pi-only 收敛删除。当前链路为
`usePiModelCatalog` → `listPiModels`，`models.ts` 中**不存在任何 `startsWith` 调用**；
仓库其余 `startsWith` 全部作用于 MIME 类型、message id、diff 行与 Markdown，与模型标识无关。
无可复现路径，不再作为观察项。

## ~~Q17 — GUI/TUI mode switch 的 session continuity~~ — **已定 2026-09-02：采用 pix 同文件接管**

原问题：TUI 是接管 GUI 的同一 durable session file，还是另开一个新 session。

**决定**：照 pix 实现同文件接管。参考实现见 `pix/apps/desktop/src/main/pi-tui-session.ts`
与 `index.ts` 的 `pix:terminal:open` / `pix:agent:prompt`，关键点：

- TUI 以 `pi --session <path>` 打开 GUI 正在用的那份 JSONL，不新建会话。
- `PiTuiExclusiveGuard` 是会话级互斥锁，`assertHostPromptAllowed()` 在 GUI 发起回合前把关。
- GUI → TUI：**`transferTo` 而非 `tryAcquire`**。pix 的注释记录了教训——只用 tryAcquire 时，
  第一个会话之后锁与控制器的 key 会失步（macOS `/private/var` vs `/var`、挂起/取消竞态），
  界面再也开不出终端。
- TUI → GUI：GUI 发消息前先 `disposeSession(sessionFile)` 硬杀 TUI 再释放锁，不做协商。
- `normalizeSessionKey` 需处理 macOS firmlink、大小写与尾斜杠，否则 park/ownership 匹配不上。

**接受的语义边界**：pix **没有** flush ACK 握手，崩溃恢复也未证明；它靠 pi CLI 自身的追加写语义兜底。
采用此方案即接受这一较粗的语义，原 Q17 列出的四项证明中只有“单写 authority”被真正解决。

## Q18 — 远程仓库是否要有 Agent 终端

T36 之后 agent PTY 只走本地 `PiTuiPtyController`：`SessionManager.create` 对 `kind === 'agent'` 直接抛错，
远程 Pi 安装/供给链路也已随 `RemoteEnvironmentService` 一并删除。因此远程虚拟路径下的 Agent 终端**没有可用后端**。

**当前处理**（见 [T37 review-fix evidence](./evidence/2026-09-02-t37-post-t36-review-fixes.md)）：显式失败而非假装可用——
renderer 不启动终端并给出说明，Main 侧 `PI_TUI_OPEN` 对远程路径抛可读错误。普通 remote shell 终端不受影响。

**决定（2026-09-02）**：**不做，转 backlog**。T36 刚删除远程 Pi 供给链路，重建等于把拆掉的装回去，
且会拖住 T37 发布。保持现状的显式失败，不阻塞发布。

**若将来重启此项**，仍需先同时回答：远程主机上的 Pi CLI 由谁供给与固版；agent-kind 禁令开什么口子；
托管凭据是否允许离开本机。三者未定之前不实现。
