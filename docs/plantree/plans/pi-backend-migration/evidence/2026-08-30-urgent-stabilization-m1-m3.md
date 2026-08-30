# 2026-08-30 紧急稳定化批次 — M1 / M2 / M3

## 范围

- M1：T27-a → T12-e′ → T27-b（空仓库生命周期）
- M2：T24-a → T26 → T24-b（即时发送反馈、主动滚底、retry/fallback 去重）
- M3：T13 当前切片（Rename + Archive 右键菜单与确认）

明确未触碰：T08/Q10、T25/Q11、永久删除、fork/rewind、T09/T10/T14~T18。

## 落地

### M1 — 空仓库生命周期

- 空 workspace tree 不再提前 return，会清空 projects/workspaces/sessions、active/recent、
  Host binding、消息、历史错误、权限/问题残留。
- 被移除的 Host-bound runtime best-effort close；已持有 runtimeIdentity 的恢复会话不会被
  错绑到另一个仓库。
- 增加 run-scoped retirement tombstone，chatSessions 与相邻的 runtime facts、subagent、
  Extension UI listener 都拒绝已移除会话的迟到事件。
- 同步清理 message queue、pending user message、runtime facts、tool expansion、subagent 与
  Extension UI 的 session-scoped 状态。
- 欢迎卡提升到 ChatWorkspace；无真实 working directory 时不挂载 ChatComposer。
- Live session id 改用 collision-proof `uniqueId()`；添加→移除→重加不会沿用旧 session id。

### M2 — 发送体验

- send guard 通过后立即发布 display-only pending user bubble；不写入权威 transcript。
- pending 以 attempt id 管理，并按每个 session 的 FIFO 与 wire
  `message.started{role:'user'}` 的**确切 messageId** 一对一配对；重复 wire event 幂等，
  相同文本的连续发送不会互相吞并。
- 权威 message id 进入 chatSessions bucket 后清除 pending；rejected outcome 立即清除并沿
  原有 retry/draft authority 恢复。
- direct / retry / 明确 enqueue 触发一次 jump-to-bottom；自动 queue release 不强制滚动，
  仍尊重用户后来浏览历史的位置。

### M3 — 会话右键管理

- `SessionRow` 使用 Base UI Context Menu；右键只打开菜单，无状态副作用。
- 菜单只含 Rename + Archive；没有永久 Delete。
- 双击/菜单 Rename 共用当前标题重置与原有 guarded commit。
- 菜单 Archive 和 hover Archive 均先进入确认框；Cancel/Escape/backdrop 不归档。
- 保留 row Enter 选择、菜单 roving focus/Escape 和 focus-within hover actions。

## 提交

| Commit | 内容 |
|---|---|
| `8bd7f86b` | 空仓库与仓库移除状态同步 |
| `8e93c04b` | pending 发送反馈与主动滚动初版 |
| `ace66886` | 会话右键菜单与 Archive 确认 |
| `73ef8800` | 会话移除、pending 回显边界加固 |
| `17623597` | 已移除会话迟到事件过滤 |
| `dcf4b823` | retirement tombstone、显式 enqueue 滚底与 echo 幂等收口 |

## 对抗复核

- M1 初审发现：恢复会话跨仓库重绑、迟到事件复活、相邻 store 残留；均已修复并增加
  runtimeIdentity、empty tree、tombstone 与 prune 测试。
- M2 初审发现：baseline 丢失、一个 echo 清多 attempt、自动 release 强制滚动；改为确切
  messageId FIFO。复审又发现重复 echo 与显式 enqueue 不滚底；均已修复并加测试。
- M3 复核：无 blocker；确认 Base UI Context Menu 与现有 MenuPopup/MenuItem 兼容，
  Rename/Archive/Cancel/键盘路径符合当前 T13 切片。

## 验证

最终代码门禁：

- `pnpm test -- --testTimeout=15000`：**282 files / 5517 tests 全绿**。
  默认 5s 口径曾仅有 `chatShiki` 首次 grammar 装载超时；单文件复跑 2.64s，通过；提高全量
  testTimeout 后全仓全绿，不是功能失败。
- `pnpm typecheck`：通过。
- `pnpm typecheck:agent-host`：通过。
- `pnpm exec biome check src scripts`：**1066 files，0 error / 0 warning**。
- `git diff --check`：通过。
- dev 启动 smoke：Main / preload 构建成功，renderer dev server 与 Electron 均启动；启动日志
  包含 `[dev] permission policy: …/pi-permission-system/config.json`。

GUI/CDP 点验（真实 dev Electron）：

- 零仓库首屏只见 Add Repository/Choose working directory 引导，DOM 中无 textarea/chat composer。
- 注入真实 workspace/session 后 Composer 正常出现；点击发送后 **80ms 内**看到 user bubble +
  `Sending…`，5 秒后权威 echo 已接管且 pending 消失，真实 Pi turn 进入工具审批。
- 将聊天 timeline 注入 45 个长回合并滚到顶部，点击真实 Send 后 120ms 实测
  `scrollTop === scrollHeight - clientHeight`（5316），主动滚底成立。
- 真实右键打开菜单仅有 Rename/Archive；点 Archive 后行仍在且确认框出现；Cancel 关闭态下行
  保留；再次确认 Archive 后行消失。

真实系统文件选择器的“添加目录”点击、重新添加同一路径与跨平台菜单手感仍建议发布前人工
smoke；其状态转换和去重已有自动化覆盖，不再作为本批代码完成阻塞。
