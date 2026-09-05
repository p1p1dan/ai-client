# Evidence — U13 免绑定会话跨重启可见性（批次 5.5）

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**切片**：U13（单切片）
**执行计划**：[execution-plan §三 批次 5.5](../topics/execution-plan.md)
**边界**：[D04](../decisions/004-unbound-session-index-visibility.md)（解 [Q13](../open-questions.md)）

## 一、修的是什么

免绑定会话（U05 那种「没选目录就直接聊」的对话）在应用重启后**从侧栏消失**。
对话历史还在 pi 的 JSONL 里，但索引行的 `workspacePath` 指向隔离临时目录，
这个路径没有对应的 `ChatWorkspace`，于是渲染器的 `mergeSessionIndex` 把它判成 orphan 丢掉——
数据在磁盘上，用户却没有任何入口打开它。

D04 拍板的修法是「让它诚实可见」：索引行显式标记 `unbound`，侧栏合成一个临时分组。

## 二、落点

D04 写死三处，实际落了**五处**。多出的两处都不是范围扩张，而是「可见」和「能打开」之间的缺口——
只做前三处，用户会看见一行点不开的会话。

| # | 位置 | 改动 | 出处 |
|---|---|---|---|
| 1 | `shared/types/sessionIndex.ts` | `SessionIndexEntry` 加可选 `unbound?: boolean` | D04 |
| 2 | `main/services/chat/SessionIndexService.ts` | `recordCreated` 接受并保留该字段 | D04 |
| 3 | `renderer/.../sessionIndexMerge.ts` | 带标记的行在 orphan 分支**之前**拦下，materialize 成正常会话 | D04 |
| 4 | `main/ipc/chat.ts` 两个写入口 + `chat:ensureScratchWorkspace` | 由 `isScratchPath` 推出标记；重启后**认领**索引里记着的目录而不是新分配一个 | 见下 §三 |
| 5 | `sidebarTree.ts` / `LeftNav.tsx` / `resumeIntent.ts` | 合成「临时对话」分组、Recent 保留、点开时恢复历史 | D04 未锁死展示形态 |

### 字段的写入规则

`recordCreated` 是**逐字段重建**（`agent` 曾经栽在这上面），所以新字段带 `?? existing?.unbound`。
但只有 `??` 不够：一个免绑定对话后来绑到真实目录时，标记必须被清掉。
所以两个 IPC 入口都从**自己即将写入的那个路径**推出布尔值传进来——
显式 `false` 会清除（`??` 只对 `undefined` 回退），`undefined` 才保留旧值。
字段为假时**不写入**，所以已绑定的行不会因为这次改动长出一个新键。

## 三、D04 之外的两处，以及为什么

### `chat:ensureScratchWorkspace` 重启后必须认领旧目录

重启后 Main 的分配表是空的，而索引行还写着上次运行的那个目录。
原实现会**新分配一个 uuid 目录**并在下次 `recordCreated` 时改写索引路径——
而 `chat:resumeSession` 会拿 `row.workspacePath !== payload.workspacePath` 判为
`pi_session_workspace_mismatch` 直接抛错。也就是说：不修这里，会话「看得见但打不开」。

修法是在分配前先问索引：这个会话已经有一个属于我们的路径吗？有就 `adopt()` 原路径
（`adopt` 本来就拒绝 scratch 根目录以外的任何路径，篡改的索引行变不成任意目录创建器）。

### 渲染器要拿得到那个路径才能 resume

`shouldResumeSession` 原本第一道闸就是 `if (!workspace) return 'no-workspace'`，
而免绑定会话**按设计**没有 workspace。resume 又必须带一个精确的 `workspacePath`（Main 会拿索引核对）。
所以 `ChatSession` 增加一个可选字段 `unbound?: { workspacePath: string }`：
标记和路径合在一个对象里，结构上不可能只有标记没有路径。
它只由 `mergeSessionIndex` 从索引行写入，且**每次合并都重新推导**——
不从上一份 live 行继承，否则会话改绑真实目录后标记会永远粘着。

## 四、展示形态（D04 留给实施时定）

- **分组**：侧栏 Repositories 之后一个合成分组「临时对话」，可折叠，默认展开。
  它不是仓库：没有「移除仓库」按钮，也没有「+ 新建对话」（这分组没有 workspace 可建）。
- **行内标识**：复用 U05-b 已有的 `temporary` chip，不新造第二种标识。
- **Recent 也保留**：`deriveRecentRows` 原本按「workspace 存在」过滤，会连免绑定会话一起滤掉。
  改为只滤真正的 orphan。Recent 是用户最先看的地方，重启后回到临时对话最快的路径就是它。
- **空仓库状态下也显示**：一台还没添加任何仓库的机器会被「添加仓库」空态整块替换掉会话树，
  而那**恰好是每个对话都免绑定的机器**。所以临时分组在空态卡片下方照常渲染。

## 五、验收对照

| 验收 | 结果 |
|---|---|
| ① 重启后在侧栏可见且能打开 | ✅ `sessionIndexMerge.test.ts`「keeps a marked row as a session and carries its scratch path」+ `resumeIntent.test.ts`「resumes into the scratch directory recorded on the session」+ `chatPiWorkerRouting.test.ts`「re-takes the recorded directory instead of allocating a second one」 |
| ② 连续两次 `recordCreated` 后标记仍在 | ✅ `SessionIndexService.test.ts`「keeps the marker across a re-record that does not mention it」 |
| ③ 非免绑定 orphan 行为不变 | ✅ 「leaves an unmarked orphan exactly as before (removed folder)」——仍进 `orphaned`，不进会话列表 |
| ④ 老行不回填、不静默写迁移 | ✅ 「leaves a pre-U13 row (scratch path, no marker) dropped rather than guessed」+「never backfills a legacy row」（load 后该行仍无此字段） |
| ⑤ 索引文件仍是裸数组 | ✅ 「never writes the field on a bound row…」断言 `Array.isArray(parsed)` 且已绑定行不长出该键 |

## 六、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：切片相关 7 文件 188 tests pass；
   全仓 **264 files / 4130 tests pass**（含批次 6，两批一起跑的最终结果）。
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`：pass。
3. `pnpm typecheck:agent-host`：pass。
4. `pnpm exec biome check`：改动文件干净。
5. `git diff --check`：干净。

### 变异验证（证明新测试挡得住）

| 变异 | 结果 |
|---|---|
| `recordCreated` 去掉 `?? existing?.unbound` | 「keeps the marker across a re-record」转红 |
| `mergeSessionIndex` 的 `!workspaceId && unbound` 分支停用 | 「keeps a marked row as a session」转红 |
| `buildSidebarFolders` 去掉 `session.unbound` 跳过 | 「never renders an unbound chat twice」转红 |
| `ensureScratchWorkspace` 的 `pathFor` 前置判断停用 | 「re-takes the recorded directory」转红 |

## 七、顺手改了一条既有断言

`extensionUiInlineStatic.test.ts` 数 `LeftNav.tsx` 里 `pendingApprovalCount={` 出现几次，
原断言写死 2（Recent + 仓库分组）。临时分组是第三处渲染点，断言改为 3 并把用例名从
「both Recent and repository」改成「every session row list」——
一个看不到审批徽标的会话行，就是一个会静默卡住的回合，这里数的是渲染点而不是背两个名字。

## 八、欠项

- **GUI 点验未做**：与 U09 / U12 / U02 / U03-a / U05 的待做点验合并一次 CDP 出图。非取证型验收，不阻塞。
- **批次 4 之前创建的免绑定会话仍不可见**：D04 明确不回填老行，属已知残留。
- **真机重启未验**：跨重启路径由单测覆盖（索引读写 + 认领 + resume 参数），
  但没有用真实 pi CLI 走一遍「聊天 → 退出 → 重开 → 点开」。
