# GUI A~E 验收结果 + 交回 Linux 侧缺陷清单（test.11 现场）

> 生成：2026-09-09 · 应用：`D:\Program Files\AiClient\AiClient.exe`（1.0.0-test.11，源码 `b6aa0844`）
> 后端：native（`native-trace2/runs.jsonl` 确认 `backend=native`, `carrier=bundled-node`, 随包 node v24.18.0）
> 目录本文件：`Windows-P4-6-evidence/gui-a-e-checklist.md`（逐项回填结果）
> **未修改产品/测试源码、package.json、锁文件、CI 工作流；未本地打包；未改用户会话数据。**
> 说明：只读 Read/Edit/Write 检查用了可丢弃临时文件（test123.txt/test321.txt 已在旧 worktree 侧，非用户工作文件）。

---

## 一、验收通过/不适用汇总

| 组 | 结果 | 备注 |
|---|---|---|
| 1 工作目录菜单/终端 | ✅ 通过；⚠️ 1 问题 | 见下 F1 点"网络"报错 |
| 2 文件打开 | ✅ 通过 | 2c 无现成多样路径可测 |
| 3 新会话/TEMP | ⚠️ 部分通过 | 见 F2（TEMP 删除/对话报错） |
| 4 长输出/重试 | ⚠️ 未触发 529 | 见 F4(503 不重试) |
| 5 权限/问答 | ⚠️ 部分通过 | QuestionCard/扩展问答当前会话无"提问工具"无法弹卡（F5） |
| 6 文件 diff | ⚠️ 部分通过 | 见 F6（无左右双栏 diff 对比模块，仅单栏） |
| 7 上下文详情 | ✅ 通过 | 7b 重启后发一句话才显示（预期内） |
| 8 输出跟随 | ✅ 通过 | 8b 输入框增高有限（见意见） |

**结论**：GUI A~E 核心功能在 native 后端下可用（文件/会话/权限/上下文/跟随全部正常），**但存在若干需 Linux 侧修复/优化的问题**，见下。

---

## 二、问题清单（按严重度）

### F1. 设置 → 终端里点"网络"某个子项报错 🔴
- **现象**：进入设置 → 终端正常，但点击"网络"那一项会报错。
- **证据**：用户现场反馈（`gui-a-e-checklist.md:20`）。
- **归属**：交 Linux 侧（需复现，拿到具体报错文案/截图；应是无网络配置的 Windows 环境下该子面板崩溃）。

### F2. TEMP 新建工作区：无法对话 + 删除报错 🔴（已定位根因）
- **现象**：
  1. 新建临时工作区后的会话发消息 → `WorkerSlotError: spawn ...node.exe ENOENT`。
  2. 该工作区无法删除，删除报错。
- **根因**（已用 session-index 实证）：会话索引里有会话的 `workspacePath` 指向**磁盘上已不存在的目录**——`C:\Users\JC\JYWAI\temporary\20260819-153654`（另 9 条同类：`20260430-092537`、`20260506-104237`、`E:\test1` 等）。`temporary` 根目录当前为空。
  - spawn 报 ENOENT 是因为 `cwd` 目录不存在（Node `spawn` 在 cwd 消失时报 ENOENT，`node.exe` 本体在磁盘上，已用 `ls` 验证 92MB 存在，是被误导性指到可执行文件）。
- **为什么索引里有死目录**：TEMP 目录（scratch / 用户可删的临时工作区）会被 app 启动/退出时 wipe（见 `ScratchWorkspaceService` 注释"整个根在 app 退出和下次启动时清理"），或被用户手动删除（用户反馈"五月目录删掉了"），但 **session-index 里的 `workspacePath` 没同步更新** → 旧条目残留在 GUI 目录列表 → 点开即崩。
- **建议修复（交 Linux 侧）**：
  1. `chat:createSession` / `resumeSession` 前校验 `workspacePath` 存在；不存在则报明确"目录已不存在/已被清理"而非裸 ENOENT。
  2. 启动时清理索引中指向已消失 TEMP 目录的条目，或打开时给"重建/归档"选项。
  3. 删除报错应与"会话/进程占用该目录"相关（`temp:workspace:remove` 在 `stopWatchers`/`killByWorkdir` 后仍失败）——需定位是否因该会话一直处于 error 态未释放。

### F2b. TEMP 删除失败（同上，属于 F2 一部分）🔴
- 与 F2 同源，删除逻辑走 `temp:workspace:remove` → `sessionManager.killByWorkdir` + `removeWithRetries`，无法删除疑似该会话 worker 未真正结束/目录被锁。归 Linux 一并修。

### F3. Git 工作区异常：分支列表/状态空（**仅 GUI**，独立 git 正常）🟠
- **现象**：GUI 文件工作区正常，git 工作区不正常。报错：
  ```
  Error invoking remote method 'git:branch:list'.
  Error: git branch -a -v returned no branches for a repository that has commits, its output was lost
  Error: git status exited 0 without emitting branch headers; its output was lost
  [workspace-tree] worktrees-absent { repoPath: 'E:\...\.worktrees\bmo-m1', neverQueried: false }
  ```
- **决定性 A/B 证据**：
  | 进程 | `git branch -a -v`（bmo-m1） | 结果 |
  |---|---|---|
  | Git Bash（白名单）| `* feature/bmo-vision-service-m1 … ` | ✅ 输出完整 |
  | PowerShell 调 git（独立进程）| `* feature/…` + status | ✅ 输出完整 |
  | GUI(Electron 起 git 子进程) | 空 | ❌ 丢输出 |
- **判断**：git 二进制、worktree、`.git` 指针文件都正常（磁盘 + 两个独立进程均可读）。**只有 GUI 的 Electron 主进程起 git 子进程时 stdout 丢失/为空**。这与《Windows加密环境GUI异常分析》(2026-09-08) 结论一致："GUI 与 TUI 进程载体不同，GUI 运行在 Electron 进程载体中"，即加密驱动按进程身份放行，Electron 及其子进程受限。
- **此为 Windows 加密机特有环境问题**，需 Windows 现场确认+Linux 侧决策：
  - 建议：git 子进程走 **white-listed 载体**（如随包 node.exe 或系统 Git Bash 路径），而非 Electron 直接 `spawn('git')`；或由 Linux 侧评估 git 子进程封装（复用 `tsdSafeRead` 同款"白名单解密节点"思路）。
- 说明：Q7 修复（`getBranches` 对"有 commit 但输出丢失"报 `output was lost`）**已正确生效**——它没把健康仓库误标 `no commits yet`，而是如实报"输出丢失"，证明修复有效，但**根因（GUI 进程丢 git 输出）未解决**。

### F4. 503 不重试，直接失败（仅 503，未测 529/429）🟡
- **现象**：长输出遇 503 不重试直接失败。
- **待确认**：清单要求测的是 **529/429** 可恢复错误。503 是网关错误，产品可能故意不重试。需 Linux 侧确认"503 是否在设计的不重试集合内"。若应该重试 → 缺陷；若 503 应直接失败 → 非缺陷，属预期。
- 需要一次能稳定触发 529/429 的对话才能收尾此项。

### F5. QuestionCard / 扩展问答无法弹卡（测试受限）🟡
- **现象**：当前 native 会话里**没有"提问工具"**，可用工具仅 `read/write/edit/bash/glob/grep/new_context`，因此无法弹出 QuestionCard 与扩展问答。5c/5d/5f/5g/5i 均为"没有提问工具"。
- **待确认**：这是**产品设计**（native 会话不挂提问工具）还是**缺陷**（应提供提问工具但缺失）？需要 Linux 侧判断 native 会话的工具集是否应含 ask/question。若应含 → 缺陷。

### F6. 文件修改 diff 非左右双栏红绿对比 🟡
- **现象**：
  - Edit 成功：历史里有 `文件xx 修改 +2 -0`，展开**只有单栏绿色新增**，没有想要的"左原文件(红删)/右修改(绿增)"双栏对比模块。
  - Write/Git diff 均无双栏对比。
- **判断**：当前实现是**单栏 PATCH diff 视图**，非 side-by-side 双栏。这是**产品形态/体验问题**，非功能缺陷。归 Linux 侧评估是否需要双栏对比组件（UI 优化）。
- **工作区**：开发必须遵循 `docs/design-system.md`（组件优先 @coss/ui）。

### F7. 补充问题：
- **F7a 授权详情样式丑/不协调**（`gui-a-e-checklist.md:57`）→ UI 优化，归 Linux 侧。无提问工具授权详情不可展开，待有提问会话再测。
- **F7b "正在输出 xx s" 重复显示**（agent 输出末尾一个 + 输入框左上角一个）→ 状态显示重复，归 Linux 侧修正（UI 状态归一）。
- **F7c 授权/问答卡片尺寸过大、字体不协调** → UI 优化，归 Linux 侧。
- **F7d GPT 渠道耗时极长** + **选 effort 无效，后台一直 `effort=none`** → 归 Linux 侧排查 GPT 渠道 effort 兼容性（glm-5.2 `reasoning_effort` 在 GPT 网关下可能不生效；耗时可能是网关/重试问题）。
- **F7e 上下文详情重启后发一句话才显示**（`gui-a-e-checklist.md:85`）→ 需判断是否预期（未发送前无 token 数据可显示，可能正常）。待 Linux 侧确认。
- **F7f 输入框增高有限**（`gui-a-e-checklist.md:97`）→ UI 优化，归 Linux 侧。

---

## 三、Windows 侧现场结论（仅记录，不动源码）

1. **native GUI A~E 大项通过**。
2. **Windows 现场不可修/需交 Linux** 的：F1/F2/F3/F5/F6 + F7a~F7f。
3. **仅 Windows 加密机可见（两独立进程无法复现）**：F3（GUI 起 git 丢输出）。它符合先前已确认的"GUI 在 Electron 载体中受限"模型。Linux 侧无企业驱动，无法复现；需在 Windows 侧随载体白名单方案一并解决。
4. 已删除临时诊断脚本；本次会话**未改动任何产品/测试源码、package.json、锁文件、CI，未本地打包**。

---

## 四、待办（需用户在 Windows 现场再补测 / Linux 侧决策项）

| # | 事项 | 需谁 | 状态 |
|---|---|---|---|
| 1 | 复现 F1 并抓取"点网络"报错完整文案 | 用户 | 未复现 |
| 2 | 触发一次真实 529/429，确认是否重试 | 用户+Linux | 未触发 |
| 3 | F5 判断 native 会话是否应含提问工具 | Linux | 待决策 |
| 4 | F3 判断 git 子进程是否走白名单载体 | Linux | 待决策 |
| 5 | F7d GPT 渠道 effort 兼容性 + 耗时 | Linux | 待排查 |
