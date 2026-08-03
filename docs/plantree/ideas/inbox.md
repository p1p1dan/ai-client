# Ideas Inbox（低承诺想法池）

> 想法不是承诺。成熟后 promote 到 roadmap / open-questions / decisions 并回链。

- 2026-07-24 长会话时间线虚拟化——是否需要以 C-12 压测数据为准（ARD 已列为后置项，此处仅存念）。
- 2026-07-24 显式 mock-resolver 注入容器：让 T-09「Node 缺失」场景可被真实触发（源自 T-09 验收未竟项）。
- 2026-07-29 死代码清理：`chatSessions.recentSessionIds` + `touchLiveUpdatedAt` + `recentSessionIdsFromIndex`——T-26 后最后读者已移除，仍在三处被维护（cap 还不一致 8 vs 20）。动红线 store，宜随 T-22/T-23 顺手清（源自 T-26 对抗复核 info 项）。
- 2026-07-29 `worktree.list` handler 的 `clearWorktrees()` 全局副作用（扇出时 auto-fetch 只剩最后一个仓库）——设计文档 §2 标注的既存 bug，T-27 分支下拉重度依赖该数据源，开工前宜先修（源自双盲设计取证）。
- **物化已有分支为 worktree**（2026-07-29，T-27 复核遗留）：分支下拉的「未物化分支」入口现走「新建同名分支+worktree」（CreateWorktreeDialog 仅支持建新分支），输入已存在的分支名会如实报 already exists。`worktree add <path> <branch>` 的 IPC 层已支持，补一个「从已有分支建 worktree」路径即可闭环；连带注意 `worktree.list` handler 的 `clearWorktrees()` 全局副作用（已在档，T-27 的 pending 1200ms 兜底失效广播会在异常路径放大它一次）。
- **附件选择「+」钮**（2026-07-29，T-28 A07 偏离入档）：A07 屏①②画了 Composer 卡内「+」图标钮，本仓无附件选择能力（T-18 仅粘贴通路），落死按钮违 A06 故 T-28 未实现。附件选择能力立项后补上即可对齐。
- **恢复态显式标记 restoredFromIndex**（2026-07-29，T-28 R1 残留）：无 runtimeIdentity 的老 session-index 条目恢复瞬间理论上闪一帧居中卡（现靠规则 2/5 同 tick 兜底，最多一帧）。给会话加恢复来源显式标记可根除，属红线 store 加字段，量级小但需签名同步。
- **assistant 正文 Markdown 解析**（2026-07-30，T-05 复核澄清）：`text-markdown` 只是字号档，assistant 文本从未有 md 解析（标题/列表/代码块/链接均按纯文本渲染）——既有能力缺口非 T-05 回归。若要做属新能力立项（渲染器选型 + 安全考量）。
- **工具行复合 arg 渲染**（2026-08-03，T-30 批2 对抗复核共识）：Grep/Glob 的 arg 是 `pattern in repo` 混合串，本批按良性降级整体 sans；正解=pattern 段 `<Ident>` mono + 散文段 sans 的复合渲染（需 ToolRowArg 接受复合结构）；连带修 Bash 无 description 与 default 分支的 argKind 不一致。Codex 判 ident / Opus 判 sans 的分歧仲裁记录见主线台账 2026-08-03 委派行。
- 2026-08-03 ⊕ 钮已以「Add file context (@)」语义落地（`9e2736b`，结清 T-28 A07 偏离①）；上方「附件选择+钮」条目中的**真附件选择**（renderer 读文件字节 IPC + 限额）仍待立项，两条通路并存不冲突。
- **⊕ 菜单第二条「Add file context (@)」**（2026-08-03，第五轮修复批 D4 裁定的备选方案②）：D4 已按方案①落地——⊕ 改为菜单触发器、唯一条目 `Attach files`，`insertMentionTrigger` 与 F-A12 一并退役。若后续希望在菜单里同时提供「插入 `@` 引用」，需复活该纯函数（git 历史可取）并补回用例；Cursor 参照图该菜单为 3 条，我们 2 条不违和。用户本轮只拍了「先一条」，故列为想法不列为承诺。
- 2026-08-03 `attachments.ts` `DEFAULT_CHIP_LABEL_LENGTH = 28` 系全等宽时代标定的死代码（CSS `max-w-56` 先兜住；若升宽会开始中段截断）——升宽时须按比例字体重标（源自 Opus 复核 note）。
- 2026-08-03 empty 态 statusLine wrapper 仍是 ChatComposer 内 JSX 字面量（session 态已下沉 `sessionStatusLineWrapperClass()` 可断言）——下批顺手下沉（源自 Opus 复核 note）。
- 2026-08-03 OnboardingView `installError`/`sendCodeError`/`verifyError` 多数分支是本地化文案、仅 catch 兜底为原始 Error.message，mono 处置与 `recheckError`（已 mono）不同——统一处理需先拆分支（源自 S5 存疑清单）。
- 2026-08-03 `data-font-domain="mono"` flag 还原度约 97%（`--font-heading` 的 7+1 处在 mono 档下仍为比例）——做 A/B 对比截图时须知；flag 保留一个版本周期后删除（D25 §2.5 原定）。
- **斜杠指令（slash command）支持**（2026-08-03，第五轮点验第 5 条，用户明示优先级不高）：对话框内输入 `/` 唤起指令面板；openchamber 有此能力可作参照（参照版本冻结 `a3519141`）。涉及输入层识别、指令目录来源（CLI 自定义命令?）与发送语义，成熟后立项。
- **FILE_COPY/RENAME/MOVE 无根校验加固**（2026-08-03，第五轮对抗复核 Opus 发现的既有暴露面）：这三条 IPC 接受任意源/目标路径，曾可被用于把任意文件覆盖到附件授权路径实施确定性读取绕过（该绕过已被 fd 快照校验封死），但通道本身仍是全盘写原语——宜比照 LocalFileAccess 根白名单收敛（安全加固批）。
- 2026-08-03 `session-${Date.now()}` 会话 ID 毫秒级碰撞（chatSessionActions.ts:34，既有）：同毫秒双击 New 会撞 ID；测试已显式绕开。改 crypto.randomUUID 或加计数器后缀，动红线 store 宜随下批顺手。
