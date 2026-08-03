# 第六轮点验反馈诊断（2026-08-03）

用户第六轮 GUI 点验反馈两条。本档记录诊断因果链、裁定与修复口径。

## 反馈原话

1. 「大部分修复正常，还有一个问题，在我点击 aaa 这个文件夹后，new 是灰色的，无法点击。文件夹下也没有显示 new chat。但是 openchamber 文件夹下是有显示 new chat 的」
2. 「第一次发送失败后，内容正常会退回到输入框，我重新发送后，又出现了双重发送的现象。详情可见图 "D:\Dan\vmshare\diance4\屏幕截图 2026-08-03 173300.png"」

---

## Bug A：aaa 文件夹 New 灰死 + 无 "+ new chat" 行

### 现场实证

- `aaa` 不是普通文件夹：`git worktree list`（在 openchamber 内）确认它是 openchamber 的 **linked worktree**——`/home/dan/JYWAI/workspaces/openchamber/aaa`，分支 `aaa`。
- 用户将该路径作为独立 repository 注册进应用，侧栏因此出现第三个文件夹。

### 根因（编排者实证，无需双轨）

因果链（全部在 `src/renderer/components/workspace-shell/deriveChatWorkspaceTree.ts`）：

1. 对 aaa 这个 repo 条目调用 `worktree.list(repo.path)`，git 返回的是**整个父仓库**的 worktree 清单：main 条目路径指向 `/home/dan/projects/openchamber`（父仓库根），另含 aaa 自身。
2. 推导逻辑取 `mainWt.path` 作为该项目 main workspace 路径 → 生成 ID `ws:main:<父仓库根路径>`，与先注册的 openchamber 项目的 main **完全同 ID**；`pushWorkspace` 的 `seenWorkspaceIds` 去重把后到者静默丢弃。
3. 兄弟 worktree 循环里 aaa 自身路径生成 `ws:worktree:<aaa路径>`，同样已被 openchamber 项目先占，再次被去重丢弃。
4. 结果：aaa 项目 **零 workspace** → `resolveNewSessionWorkspaceId` 返回 null → `SidebarFolder.newSessionWorkspaceId = null` → 头部 New 禁用（`canCreateSessionOnWorkspace` false）+ 文件夹内 "+ new chat" 行按设计隐藏。两个症状同一根因。
5. 附带缺陷：**谁先注册谁得 workspace**——纯由 repositories 数组顺序决定；若 aaa 先注册，被饿死的将是 openchamber。

### 裁定（round-6 D2）

**用户注册的文件夹本身就是该项目的主 workspace。** 非 remote repo 条目的 path 若与 worktree.list 结果中某个 linked（非 main）worktree 路径相同（normalizePath + toLowerCase，与 workspaceIdFor 同口径）：

- 只为该项目推入一个 workspace：`ws:main:<repo.path>`、kind `main`、path = repo.path、branch 取该 worktree 分支（剥 `refs/heads/`，detached 则不带键）、`gitEnabled: true`，随后 `continue`；
- 不吸附父仓库 main、不吸附兄弟 worktree（它们属于注册了仓库根的项目；吸附会重造跨项目 ID 碰撞）；
- 同一目录出现在两个项目下（openchamber 的 `ws:worktree:<aaa>` 与 aaa 项目的 `ws:main:<aaa>`）是**有意语义**：kind 参与 ID，天然不撞；会话按创建时所在 workspace 分组归属各自文件夹。
- 其余情形（repo.path 即 main worktree、清单为空/未返回、remote）行为一字不变。

弃选方案：
- ~~仓库级合并（把 aaa 并入 openchamber 文件夹）~~——违背用户「注册即独立文件夹」的直觉，且需动 Add Repository 语义；
- ~~workspace ID 加 projectId 作用域~~——改变 workspace 身份口径，波及会话绑定/composer target/持久化，代价远超收益。

### 修复与断言

- 施工：fast-worker（sonnet），只动 `deriveChatWorkspaceTree.ts` + 其测试；编排者逐行复核 diff 与规格吻合。
- 新增断言 T1~T5：单 workspace 不漏父根 / 两种注册顺序互不饿死且根项目保有 worktree 条目 / 普通仓库回归 / detached 无 branch 键 / `resolveNewSessionWorkspaceId` 两侧各解析到自己的 main。
- 验证：workspace-shell 目录 vitest 7 文件 136 例全绿；typecheck 干净；biome 干净。

### 遗留（backlog，不阻塞本轮）

- Add Repository 时若检测到目标是已注册仓库的 linked worktree，可给一行提示（纯 UX，非缺陷）。
- aaa 文件夹内 Composer 分支下拉会列出父仓库全部 worktree（gitEnabled=true 的既有语义），切换后会话归属父项目文件夹——语义自洽但可观察性一般，观察用户是否困惑再定。

---

## Bug B：失败退回后重发双重发送

### 截图时间线（openchamber·Main，claude-sonnet-5）

1. 用户气泡「你好」
2. 标记气泡「[Request interrupted by user]」
3. 用户气泡「你好」
4. 用户气泡「你好」 ← 与 3 连续：一次重发产生两个用户气泡
5. 助手回复（Worked for 1s，单次）

### 双轨独立诊断（Opus deep-reasoner ∥ Codex，互不见对方）

两轨**独立收敛到同一根因**，交叉验证极强：

**共同结论**（要点合并）：
- 重发那次点击**只真正调用了一次 `chat.send`**——第四轮 cb2d8d7 的四条发送路径修复全部正确生效；「双发」是显示层复制。
- 缺陷点：`chatSessions.ts` 的 `session.history` 归约「只按 `h:` 前缀替换、无条件保留全部 runtime 消息」。失败退回 → 手动重发走 resume（fatalHostError 路径 `unbindHost()` 摘了绑定但 runtimeIdentity 仍在），resume 触发全量 JSONL 重放：首轮「你好」以 `h:*` 历史身份插入，其运行时回显 `user-*` 残留并存 → 同文两条，紧邻真正的重发回显，被读作双发。
- 铁证：`[Request interrupted by user]` 字面量全仓零命中，渲染端无任何生成路径——该气泡只能来自历史重放，即本次重发确实走了 resume + 重放。气泡顺序（历史块前置、runtime 块后置）与截图逐条吻合；单条助手回复排除两次真实 turn。
- 队列全程未参与（committed 不回队、不暂停；本次载荷走的是 Composer 本地 draft）。
- 这正是第四轮诊断编号 **A5**、白纸黑字「留待现场取证、不进最小修复」的链路——不是既有修复失效，是缓期项兑现。
- 修复归属必须是 store 的 history 对账（所有 resume 入口汇于此归约；视图层去重只治画面不治状态），动红线 chatSessions.ts 有充分且不可替代的理由。
- 两轨都独立否决**按文本集合去重**：用户合法连发同文（「继续」「y」）会被误折叠。

**分歧与裁定（round-6 D3）**：
- Codex 方案：`session.resumed` 时按 `sessionId+requestId` 快照 resume 前 live 消息 ID 水位，history 到达时删快照内 ID。身份对账、无文本启发；协议上 `session.history` 确带 requestId（前提成立）。
- Opus 方案：无状态纯函数叶模块 `mergeReplayedHistory`——对 (role, text) 做**单向双指针覆盖走查**，命中即弃、未中即留、指针只进不退（计数守恒）。
- **采 Opus，弃水位**，理由：①失败方向——水位方案在 JSONL 尾部落盘滞后/截断时「删光快照 ID 而历史并未覆盖」= **静默丢消息**；走查失配只退化为今天的重复显示（无损方向），符合「宁可重复不可丢失」；②红线增量——水位需在 store 新增跨事件状态并动两个归约分支，走查只换一次委托调用；③Codex 的 requestId 隔离/幂等/错误路径/同文连发断言全部并入测试清单（其中幂等与隔离在 store 层测试，其余为走查天然性质）。
- Opus 附带两项裁定一并采纳：**不收窄** `unbindHost()`（单独做会让失败回显与重发回显变成两条无分隔的同文气泡，更糟；须与失败态角标同批）；Host 侧跳过重放**不做**（红线 + 误伤首次打开会话）。

### 修复落地

- 新建 `src/renderer/stores/historyReplayMerge.ts`（零 store 依赖叶模块，规则与理由全在文件头注释）：前缀替换语义保留；读失败/空历史短路为旧行为逐字节一致；覆盖走查 role+text、空文本不参与（附件-only 永不误折叠）。
- 红线 `chatSessions.ts` 最小增量（编排者亲改）：+1 import，`session.history` 归约体三语句换 `mergeReplayedHistory(bucket, historyMessages, { historyReadFailed: payload.error != null })` 一次委托；协议三文件零改动；`HISTORY_MESSAGE_ID_PREFIX` 其余两处用法不动。
- 测试：`historyReplayMerge.test.ts` 11 例（现场复刻/对齐不破坏/计数守恒/落盘滞后保底/指针单向/失败与空短路/空文本/role 区分/text 块拼接/纯度）+ `chatSessionsHistory.test.ts` 扩写（覆盖恰一份+会话隔离/error 保留/旧用例改题避免把重复钉成契约/双施幂等）。

### 衍生立项（登记，不入本批）

- **失败回合 user 气泡无失败标识**：修完对账后本场景可读性靠 CLI 落盘的中断标记「借光」；CLI 不写标记或走 direct 不重放时，「失败回合 + 重发」仍像双发。建议给失败回合最后一条 user 气泡加显式失败态角标（Opus 提案 §3.3）。
- 现场取证判据（供后续复发排查）：两条 `user-*` 气泡 id 尾部毫秒戳相差数秒 = 两次独立点击（显示层复制模型）；相差 <1s 才需要重查发送路径双调用。

---

## 双轨终审与 D4 修复批（同日追记）

对首版修复的对抗性复核（Codex ∥ Opus deep-reasoner，同任务书独立执行）**同一 blocker 双轨独立命中**，另有互补 major。

### 复核发现（合并去重后）

- **BLOCKER（双轨一致）**：v1 纯文本覆盖走查无时间边界——①resume 后新发的同文消息在 history 晚到时被旧行吞掉（Codex 竞态反例；detached 重放 + Composer 只等 `session.resumed` 即发送，竞态真实）；②二次重放后游标从历史第 0 行起扫，把会话尾部（含重发回显）对到早期同文行整体吞掉（Opus P1/P2 实测探针）。**D3 裁定被证伪**：「走查失配只退化为重复显示」的前提（runtime 列表与历史同源同起点）在二次重放后破裂；水位与走查的正确关系是**合取而非二选一**——把两者当互斥选项是决策层根因，特此更正。
- **Major（Opus B2）**：折叠使 runtime 助手计数下降，放弃标记游标 `assistantCursor` 的单调性破坏——`1 > 1` 永假，陈旧红条 + Retry 可能永不清除（仅 `session.completed` 兜底）。
- **Major（Opus B4）**：Bug A 只修 linked-worktree 形态；**注册子目录**（及软链形态）同因饿死，泛化条件应为「listed 的 main 路径 ≠ repo.path」。
- **Major（Codex 3 / Opus M5）**：`normalizePath` 不裁尾斜杠——`/aaa/` 注册路径使自匹配静默失效、原 bug 复现；POSIX 无条件小写为 `workspaceIdFor` 既有全局约定（改动会改 ID 口径），入 backlog。
- **Major（Codex 4 / Opus M3+A2b）**：D2 的同路径双身份使 `resolvePreferredWorkspaceId` / `matchWorkspaceByPath` / `sessionIndexMerge` 三处 path-only 查找回到注册顺序 first-wins（或 last-write-wins）：选中 aaa 却把 seed 会话挂到父项目文件夹；持久化会话跨重启在两文件夹间随注册顺序漂移。
- **Major（Codex 2 / Opus M1/M2/M6）**：折叠命中时整条弃 runtime 会丢 history 协议无法重建的信息——附件元数据、未决 permission/question 卡（`pendingPermissions` 悬空）、`Worked for` 元数据（键控 runtime id）。
- **真值洞（Codex 5 / Opus B3/N2/N3）**：幂等用例的 fresh turn 故意异文=按构造为真；「attachment-only」用例 fixture 无 attachments 字段名实不符；T2 恒真断言零信号。第五次抓到此类洞。

### D4 裁定与落地

1. **走查 v2 三重护栏**（`historyReplayMerge.ts` 重写 + 红线两归约分支挂接）：
   - **resume 水位**：`session.resumed` 归约把当时桶内消息 ID 快照进叶模块注册表（`sessionId+requestId` 键，dismissedSessions 同款零依赖先例，不动 store 状态形状）；`session.history` 仅 requestId 全等才消费，一次性；无快照/错配 → 完全不折叠。
   - **命中才删**：候选未在历史中找到同 role 同文行则保留（封死落盘滞后/截断方向的丢失——对 Codex 纯水位方案的否决理由保留成立）。
   - **快照时刻尾锚**：游标起点 = 快照时刻桶内最后一条 `h:*` 在新历史中的位置之后（`h:<jsonl-uuid>` 跨重读稳定是协议契约）。锚必须随快照冻结——从当前桶取锚被实测证伪（惰性错配重放的前缀替换会把未折叠旧回显推到 h: 行之后、永久豁免）。
   - **折叠资格**：仅 user/assistant、无 attachments、块全为 text/thinking、覆盖文本非空。残余失败方向 = 重复显示，绝非丢失。
2. **B2**：清除效应内对 `marker.assistantCursor` 做下钳重基（折叠只会缩减 runtime 计数、h:* 不计入，iteration-4「重放不清标」规则保持）；**N1** 同批：`sendAndWait` 成功谓词改用 `countAssistantMessagesWithBlocks`（排除 h:*）。
3. **B4+M5**：新增 `canonicalPathKey`（shared/utils/path：normalize+裁尾斜杠+小写，仅作比较键）；自指短路泛化为「canon(mainWt.path) ≠ canon(repo.path)」，branch 取路径命中的 linked 条目（子目录无则不带键）。
4. **M3**：`workspacePathMatchRank`（main<remote<worktree<temp，跨界故意重复各一份）；`resolvePreferredWorkspaceId`/`matchWorkspaceByPath` 同路径多候选按 rank 消歧；`sessionIndexMerge` 改 canonical 键 + rank 优先。**根治（index 持久化 workspaceId 而非仅 path）入 backlog**；D2「会话按创建时 workspace 分组」的表述据 A2b 反例修正为：path-only 结合点消歧后成立，跨重启归属仍依赖 path 反查。
5. **测试**：纯函数 23 例（三护栏各有红→绿反例：水位竞态、P1/P2 锚定、锚消失回退、计数守恒、命中才删、附件/permission/角色资格）+ store 级序列化用例（resumed→raced echo→history 同文存活即 B3 红→绿钉、requestId 隔离、双 resume、错误路径、双施幂等）+ Bug A 侧（子目录/尾斜杠/preferred 消歧双顺序/treeSync seed/sessionIndexMerge 双身份/canonicalPathKey）。
6. **接受的残余（登记）**：折叠后 `Worked for` 行消失（与冷启动打开历史会话同语义）；M4 折叠后新 permission 合成气泡脱离原助手泡（呈现劣化，M2 资格守卫已排除存卡消息被折叠）；P3b 流式中折叠致 delta 丢失在水位下仅剩 Host 重启窗口可达（delta 缺 id 重建的加固入 backlog）。

### 终验轮（Codex 对 D4 批的验证性复核）与处置

Codex 二次复核再抓 1 blocker + 1 major + 2 minor + 1 nit，全部处置：

- **Blocker（锚消失回退第 0 行）**：历史读取的截断成功路径（>1000 条/8MB 预算从头部淘汰、`truncated: true` 无 error）会让快照尾锚从新历史中消失，此时回退 0 行扫描等价于重开 v1 丢消息。处置：**锚在快照中存在但重放中找不到 → 本次完全不折叠**（仅首轮快照无锚才允许 0 行起扫）；原「锚消失回退折叠」测试反转为「锚消失禁折、同文候选存活」的红→绿钉。
- **Major（N1 处置不彻底）**：`sendAndWait` 的 store 兜底谓词改排除 `h:*` 后仍是绝对计数——第二轮起发送时**上一轮的 runtime assistant** 立即满足谓词，等待零证据放行、监听器提前退订、迟到失败无法还原载荷（第二轮及以后的常态路径）。处置：发送派发前快照 runtime assistant ID 基线（`collectAssistantMessageIds`），谓词改「出现基线外新 ID」（`hasNewAssistantMessage`）——历史行与旧回复同时被排除；折叠删旧 ID 不伪造进展（基线只做负向排除）。
- **Minor（B2 状态机无钉测）**：下钳逻辑抽出纯函数 `resolveAbandonProgress`，四态钉测（缩减重基不清标 / 纯水合不清标 / 重基后新回复清标 / waiting 交互清标）；Codex 确认下钳本身无「水合自涨清标」可达序列。
- **Minor（B4 软链退化未钉测）**：软链注册（git 报 realpath ≠ 注册路径）退化为单 self workspace（无分支 chip、不吸附兄弟、不碰父根、会话不错绑）——Codex 确认为可接受的功能降级而非身份错误；补 T9 语义钉测防止后人「修回」碰撞路径。
- **Nit**：composerTarget 遗留未用 `normalizePath` import 清除。
- Codex 同时确认：三重护栏正常路径 12 项、折叠资格 7 项、红线挂接唯一性与依赖无环、canonical 消歧三处一致性、B2/N1 窄目标全部无问题。

### backlog 汇总（本轮新增）

- session index 持久化 workspaceId（根治跨重启归属漂移）
- POSIX 平台感知大小写策略（牵动 workspaceIdFor ID 口径，需迁移设计）
- `message.delta`/`thinking.delta`/`tool.*` 对缺失消息由丢弃改重建（把丢失兜底成重复）
- 失败回合 user 气泡失败态角标（Opus round-6 提案，原登记项保留）
- Add Repository 检测 linked-worktree/子目录注册时的 UX 提示（原登记项保留）
