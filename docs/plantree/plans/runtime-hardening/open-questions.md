# 未决问题 — Runtime 加固与收口

Role: open-questions；只维护尚需拍板的问题。答了就移到 decisions 或 roadmap 对应任务。

| ID | 问题 | 当前证据 | 关联任务 |
|---|---|---|---|
| Q002 | P2-7 前缀稳定性模块是接进 trace（每次请求记 systemPromptSha256）还是删掉？ | 全仓只有单测引用（context-prompt-09，D9 明写可选） | Deferred |
| Q019 | 子 agent 独立展示位的形态：侧边抽屉 / 独立浮窗 / 可钉住面板？ | T033 现场反馈用户期待独立展示位，现状是挂在工具行下可展开（[07-findings.md](topics/t033-field-day/07-findings.md) 现象 #9） | T085（H-9，阻塞于此） |
| Q020 | 用户在自己命令行工具上测试时用的 provider / 模型名，是否与本应用当时用的一致？ | 若不一致，「同一中转、性能可比」这个前提不成立，需要重新核对性能对比结论 | 影响[决策 024](decisions/024-prompt-cache-ttl-split.md)的适用范围 |
| Q021 | 中转是否把 `cache_control` 的 `ttl: '1h'` 参数原样透传给上游？ | T077 已提交（本地未推送）；开发机上 `runs.jsonl` 的 `cacheWrite1h` 分桶恒为 0，需 T033 第二轮上机用真实请求验证是应用没发对参数还是中转吞掉了 | T077（H-1） |

~~Q015~~ 已由[决策 016](decisions/016-home-tier-instruction-gating.md)结案（2026-09-16）：家目录从 project 链移除、改作独立的 **user 层 global**，全局规则对所有项目生效；全局层只取一份，顺序 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，找到即停；家目录之上的多用户共享目录不读；未信任项目仍整条 project 链不读的底线不动。落地任务 **T059**，排在 T032 之前。

~~Q016~~ 已由[决策 018](decisions/018-temp-workspace-removal-keeps-chats-visible.md)结案（2026-09-17）：删除临时工作区前先弹确认框，列出该目录下受影响的对话条数；删除后这些聊天转为未绑定会话，继续在侧栏未绑定分组下可见、可打开（复用 T040 已落地的未绑定会话语义）。落地任务 **T069**，排批次 F。

~~Q017~~ 已由[决策 019](decisions/019-runtime-errors-as-guided-cards.md)结案（2026-09-17）：运行时错误（重试预算耗尽、会话超预算等）统一改成带标题、一句话原因与下一步操作（重试 / 新开会话 / 去设置）的引导卡片，原始报错文字折叠进「详情」，复用 T062 `ModelMissingNotice` 的卡片骨架。落地任务 **T070**，排批次 F。

~~Q018~~ 已由[决策 020](decisions/020-temp-workspace-root-app-owned-subdir.md)结案（2026-09-17）：在「保存位置」设置的目录下固定加一层应用专属子目录，临时工作区只认领该层下的直接子目录，不再直接扫描保存位置根；默认值 `~/JYWAI/temporary` 本身即是专属目录，行为不变。落地任务 **T071**，排批次 F。

~~Q022~~ 已由[决策 023](decisions/023-bypass-permissions-tier.md)追加注记结案（2026-09-18）：完全放行档不加任何破坏性命令黑名单，保留的硬拒绝只剩 `allowedTools` 白名单之外的工具 / 用户自配 deny 规则 / 内置路径黑名单 / plan 模式裁剪 / deny scope 这五道系统性防线，不再新增 `rm` 类黑名单。落地任务 **T078**，已完成。

~~Q024~~ 已由[决策 024](decisions/024-prompt-cache-ttl-split.md)追加注记结案（2026-09-18）：缓存 TTL 由设置项控制、用户自行设定，默认值维持主对话 1 小时 / 子代理 5 分钟不变；一次性工具调用（`nativeUtility`）仍固定走 5 分钟档。落地任务 **T077**，已完成。

~~Q023~~ 已由[决策 026](decisions/026-permission-grant-granularity.md)结案（2026-09-18）：文件类授权记忆只记批准的那一个文件（对齐 Claude Code，不放大到父目录/工作区）；bash 类维持记命令前缀不变（多子命令工具取前两词，其余含 `rm`/`mv`/`dd` 取第一个词，不额外收紧）；存活期维持现状，随会话持久化、不跨会话。用户原话：「命令我觉得参考 claude 或者就 pi-desktop，文件参考 claude，不要放大，记多久保持现状」。落地任务 **T081**，已完成，提交 `6913c264`。

~~Q025~~ 已结案（2026-09-18，记入 [roadmap.md](roadmap.md) 批次 H T080 落地注记，未另立决策）：不区分「因放宽档位而放行」与用户主动点允许，wire 层新增的 `autoReason: 'gear_widened'` 已删除，统一按普通 `allow` 结算。用户原话：「不要区分」。落地任务 **T080**，已完成，提交 `0a4f6f61`。

~~Q026~~ 已结案（2026-09-18，记入 [roadmap.md](roadmap.md) 批次 H T086 落地注记，未另立决策）：用户期望是新会话出现在侧栏。核实 pi `/new` 写出的会话文件与本应用格式只差首行头，runtime 打开时已有自动转换（`legacy.ts` 的 `prepareSessionConfig` 会转成 `.native-v4.jsonl` 并 resume），此前「登记会变成点开报错」的判断有误，已更正。现在终端关闭时读取新会话文件头，登记进索引并广播刷新侧栏，登记失败才退回弹系统通知；同时在 spawn TUI 时显式传 `--session-dir dirname(sessionFile)`，堵住工作区 `.pi/settings.json` 可改落点的漏洞。「常驻不关闭的 TUI 不会触发」这一残留局限已不再是等待用户裁决的开放问题，直接记在 T086 落地注记里。落地任务 **T086**，已完成，提交 `b930b5b9` / `f3b658d4`。
