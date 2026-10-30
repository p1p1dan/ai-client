# PiLab 会话体验 R0：Linux 真实 Electron UI 基线（2026-10-30）

执行：Claude（Linux 接续会话）；平台：Debian 13 / X11（xfce）、2 核 / 5.8 GiB、DPR 1；代码：`51fe766a` 上的未提交工作区（#11、#10、R1 第一阶段改动均在内）。开发构建（Vite dev + 未压缩 React），**性能数字只作方法基线，不代表发布包**。没有调用任何真实模型：真实回合只走本地假网关 `src/dsh-host/tools/fake-gateway.mjs`（`dsh-p0-2`），HOME、userData、DSH_HOME 都在 `/tmp/pilab-r0`。

## 1. 「renderer CDP 求值无响应」的结论

**renderer 从来没有卡死，CDP 也一直可用。** 带硬超时的探针（每次调用 5 s 上限）：`Runtime.evaluate` 1 ms 返回，`Page.captureScreenshot` 41 ms，rAF 59～61 帧/秒，页面可见且有焦点。上次「enter 超时」是两个入口阻塞叠加，加上脚本本身的盲等：

| 层 | 实际原因 | 处理 |
|---|---|---|
| 宿主入口 | 未打包模式下引擎布局要求 `out-node-runtime/node`（或 `AICLIENT_DSH_NODE`）和 `src/dsh-host/node_modules`；上次只构建了 `out-dsh-host`（那是打包布局用的），所以 `pi:runtime:check` 回 `unavailable`，页面一直停在「没有找到随包的对话引擎」 | `node scripts/fetch-node-runtime.mjs`（锁定版本 v24.22.1）+ 在 `src/dsh-host` 里 `npm ci`（install scripts 被 npm 跳过；node-pty、tree-sitter-bash 自带 linux-x64 预编译，不影响）。两者都在 .gitignore 里 |
| 欢迎页入口 | 2026-10-14 起首页不再渲染「使用本机已有配置」（`LOCAL_SETUP_BUTTON_HIDDEN`，39530fe7），p1-7d 工具（09-30）找不到按钮，`ENTER_MAIN_SURFACE` 抛错被吞掉 | `p1-7d-gui.mjs enter` 改为：找不到入口时走同一个处理函数 `auth.enterApp('local')` 再 reload；等输入框的上限从 300 s 降到 60 s，超时信息里带上入口结果 |
| 模型 | local 模式自 P1-5 起只认「AI 服务」，不认 `~/.pi/agent/models.json` | 进入后跑 `p1-7d-gui.mjs provider`（与设置页同一条 `userProviders.upsert`） |
| CDP 客户端 | `scripts/h21-cdp.mjs` 的 `send` 没有单次超时，`waitFor` 的循环一直在正常求值，只是条件永远不成立，看起来像「无响应」 | 新工具都给单次调用加了 `timeout` 外壳；没有改共享客户端 |

GPU/合成器：日志里的 `vaInitialize failed` 只影响视频解码；`GPU process isn't usable` 只在上次 SIGTERM 关停时出现，与求值无关。

## 2. 复现步骤

```bash
export P17D_SCRATCH=/tmp/pilab-r0
GUI=docs/plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs
T=docs/plans/evidence/2026-10-30-pilab-r0-real-ui/tools
node scripts/fetch-node-runtime.mjs && (cd src/dsh-host && npm ci)   # 一次性
node $GUI setup && node $GUI launch     # 等 /json/list 出现 page
timeout 200 node $GUI enter && node $GUI provider
bash $T/baseline.sh light; bash $T/baseline.sh dark; bash $T/baseline.sh narrow
node $T/pilab-r0-ui.mjs perf F07; node $T/pilab-r0-ui.mjs perf F07 256
node $T/save-a2b.mjs r0-save-a2b-dirty.txt; node $T/diff-a2b.mjs
node $GUI stop
```

注入方式：经 dev server 导入夹具模块和真实 `chatSessions` store，每个场景建一个 store 会话，用导出的 `applyRuntimeEvents` 在 `setState` 里折叠事件，即 `initRuntime` 的 16 ms flush 对 IPC 批次做的同一个调用。**不经过 Main、DSH 宿主和 IPC 时序**；这部分由 §4 的真实回合补。驱动自己构造的只有两处：进行中的切点前面加一条 seq 0 的 `session.status: running`（夹具没有，真实流程由 sendMessage/Main 设置）；`FAIL` 场景是 F01 进行中前缀加一条 `session.failed`（夹具没有失败场景）。

## 3. F01～F05 状态基线（`results/*.json`、`shots/*.png`）

宽 1400×900（浅色、深色各一套）、窄 720×760（浅色）。「可见」= 有布局盒子、且不在收起的 `<details>` 里；测量范围限定在对话栏（不含侧栏）。

| 场景/切点 | 状态 | 过程组（总/展开） | 关键事实 |
|---|---|---|---|
| F01 running | running | 1/1「✻ 思考中」 | 正文 A、B 都可见且在组外；`call-early` 先到结果后到调用也正确配对 |
| F01 ended | idle | 3/0「已工作」×3 | 正文 A、B 仍可见；思考原文、工具输出都在收起的组里 |
| F02 running（一半事件） | running | 4/4 | 阶段正文 1 可见；运行中的组默认展开 |
| F02 ended | idle | 9/0 | 抽查的阶段正文 1、8 可见（8 段全量由自动回归覆盖）；思考原文不在主区 DOM 里 |
| F03 pending | waiting_question | 1/1 | 权限卡停靠在输入框上方（高风险标记、直接拒绝/允许）；**同时待答的问题卡此时不在页面上**（store 里权限 1、问题 1） |
| F03 resolved | running | 1/1 | 权限行「已拒绝 · 自动：已超时」；问题卡变「提问已停止」。夹具没有结束事件，会话保持 running（夹具边界） |
| FAIL | failed | 3/3 | 失败回合的过程组**全部展开**（结束回合默认收起）；失败卡「这一轮停下了 / 本应用不认识这一轮的结束原因」+ 原话 + 继续 |
| F04 recovered | idle | 1/0 | 「好好」只出现一次（实时增量被 history refresh 替换，没有叠加）；两次同命令的工具调用保持为 2 次，不合并 |
| F05 stage | idle | 1/0 | 阶段回复可见，带「最终输出」分隔 |
| F05 late | idle | 1/0 | 新回合正文可见；迟到的旧后台结果**没有进入新回合** |

三种外观下都没有横向溢出；720 宽时侧栏保持 272 px、右栏收起，对话栏 448 px 内正文正常换行。

## 4. 真实恢复（#11，`results/recovery-fp-*.json`）

真实 DSH 宿主 + 假网关的会话，按「角色、块类型、文本、调用 ID」算指纹：

| 步骤 | 消息数 / 指纹 | 事件 |
|---|---|---|
| 两轮真实回合后 | 4 / 1974327085 | — |
| SIGKILL 宿主（空闲时） | 4 / 1974327085（不变） | disconnected → resumed → history → idle；新宿主 pid |
| 恢复后再发一轮 | 6，前 4 条不变 | 正常完成 |
| 优雅退出、重启应用、点侧栏行打开 | 6 / 同指纹 | 一条 `session.history`（宿主在下次发送时才绑定） |
| 重启后再发一轮 | 8，前 6 条不变 | resumed → history → status → … → completed |
| 流式中途 SIGKILL（`P0-PACED`，60×200 ms，第 15 段时杀） | 部分正文 154 字保留，没有重复片段 | session.failed（`dsh_host_crashed`）后两代 resumed/history 都没有叠加正文；回合标「失败」，卡片「对话引擎意外退出」+ 继续 |

驱动里第一次用 store 的 `selectSession` 直接切会话时页面显示「还没有消息」——那条路径不触发恢复，是驱动的问题；真实用户路径是侧栏点击（`handleSelectSession` → `useResumeSession`），结果如上表。

## 5. 文件保存（#10，`results/save-a2b-*.json`、`results/diff-a2b.json`）

| 入口 | 步骤 | 结果 |
|---|---|---|
| 普通编辑器（真实 Monaco 输入 + Ctrl+S） | 打开 A → 输入使其 dirty → 外部改成 B → 保存 | Main 拒绝（`FILE_CONTENT_CONFLICT`），磁盘仍是 B，编辑内容保留且仍 dirty。**界面没有任何提示**：`EditorColumn.handleSave` 是 `saveFile.mutate(path)`，没有 onError；外部改动也没有标出来（文件监听只在 `useFileTree` 挂载时启动，文件树没打开就收不到） |
| 普通编辑器（干净标签） | 打开 A → 外部改成 B → 保存 | 同样被拒绝、不写；标签也没有自动重载成 B（同上，没有监听） |
| Diff（工作区差异，进入编辑模式） | 修改右栏 → 外部改成 B → 等 4 s → 保存 | 轮询没有覆盖进行中的编辑；保存被拒绝，磁盘仍是 B；弹出错误提示「保存文件失败 … FILE_CONTENT_CONFLICT」 |

**2026-10-30 晚修复后复测**（`results/save-a2b-prompt-keep-mine.json`、`shots/save-a2b-conflict-prompt.png`）：同样的 A→B 保存现在弹出「保存失败：文件在打开后被外部修改过，本次没有写入……」，并出现「文件已被外部修改」横条（带磁盘上的 B）；点「保留本地」后再 Ctrl+S，磁盘写成用户版本 `edit-A`，标签变为已保存。见 handoff §10.10。

未完成：真实多窗口（第二个窗口只能由原生菜单快捷键 Ctrl+N 打开；CDP 注入的按键不触发 Electron 菜单快捷键，本机没有 xdotool，往共享的 X 显示直接注入按键可能落到别的窗口，所以没做）；真实远程连接（本机没有远程主机）。

## 6. R1 真实交互（DEF-003）

F01 进行中注入 → 点击过程组 `<summary>`（DOM click）→ 再折叠剩余事件到结束：

- 运行中手动**收起** → 结束后仍收起（`r1-def003-collapse-kept.png`）。
- 运行中手动**展开**（先收起再展开）→ 结束后该组**仍展开**，其他组按默认收起，3/1（`r1-def003-expand-kept.png`）。
- 偏好按稳定 `groupKey` 保存在内存里，同一会话 ID 重新注入时也沿用。没有测完整页面重载。

## 7. F07 性能方法（`results/perf-*.json`）

方法：把场景事件以「一次全部」或「每批 N 条、批间 16 ms」（N=256 对应 `RUNTIME_EVENT_MAX_QUEUE`）折叠进真实 store；记录每次折叠耗时、`longtask`（PerformanceObserver）、JS 堆、DOM 节点数、截图驱动下的帧率。

| 场景 | 批大小 | 折叠合计 | 单批 p50 / p95 / max | 长任务 次数 / 最大 / 合计 | 堆 前→后 | DOM |
|---|---|---|---|---|---|---|
| F07（1 万事件 / 100 工具 / 1 MB 输出） | 全部 | 22 ms | 21.8 | 2 / 134 / 248 ms | 116.6→126.3 MB | 1302 |
| F07 | 256 | 1599 ms（含批间等待） | 0.6 / 1.7 / 13.1 ms | 5 / 131 / 460 ms | 124.5→147.2 MB | 1302 |
| F02 | 全部 | 1 ms | 0.8 | 2 / 129 / 216 ms | — | 1359 |
| F02 | 16 | 794 ms（含批间等待） | 0.3 / 0.7 / 0.7 ms | 5 / 106 / 385 ms | — | 1359 |

读法：reducer 本身很便宜；长任务（约 100～134 ms）出现在 React 提交/布局，规模小的 F02 也有，说明里面包含切换会话时的整页挂载，尚未与流式增量的提交分开。截图驱动帧率约 15 帧/秒，受截图本身限制，不是合成器的真实帧率。要签核 AC-21 还缺：发布包、分离「切换挂载」与「增量提交」、滚动中的帧时间、Windows 目标机复测。

## 8. 预览 / 差异 / 窗口能力矩阵（源码盘点，关键项已抽查）

由只读源码盘点得出；带 ✔ 的已在本会话抽查源码确认。

**预览**

| 能力 | 有无 | 位置 | 隔离与限制 |
|---|---|---|---|
| 聊天 Markdown | 有 | `components/chat/ChatMarkdown.tsx` | 不用 rehype-raw，原始 HTML 不成 DOM；链接只放行 http(s)，经 `shell.openExternal` |
| 聊天图片 | 无（只有图标 + alt） | `ChatMarkdown.tsx` | — |
| 聊天数学公式 | 只支持 `$$` 块 | `ChatMarkdown.tsx` | KaTeX mathml 输出、无 trust |
| 聊天代码高亮 | 有 | `ChatCodeBlock.tsx`、`chatShiki.ts` | token 作为文本渲染，无 innerHTML |
| 聊天 Mermaid / HTML / SVG | 无（按代码或文本显示） | `ChatMarkdown.tsx` | — |
| 编辑器 Markdown 预览 | 有（关/分栏/全屏） | `files/MarkdownPreview.tsx` | 无原始 HTML；链接 `target=_blank` 不过滤协议，新窗口请求由主窗口 `setWindowOpenHandler` 统一拒绝、只把 http(s) 交给系统浏览器 |
| 编辑器预览里的 Mermaid | 有 | `ui/mermaid-renderer.tsx` ✔ | 运行时从 jsdelivr CDN 加载 `mermaid@11`，`securityLevel:'strict'`，SVG 用 `dangerouslySetInnerHTML` 注入、没有 DOMPurify |
| 图片 / PDF 文件预览 | 有 | `ImagePreview.tsx`、`PdfPreview.tsx` | `local-file://` 限允许根目录；4000 万像素 / 1600 万像素画布上限；pdf.js 本地 worker |
| HTML 文件预览 | 编辑器内无（按文本） | — | — |
| `browser_preview` 预览窗 | 有 | `main/services/preview/PreviewWindowManager.ts` ✔ | 独立窗口 `sandbox:true`、无 preload、`loadFile`；**没有 `setWindowOpenHandler`、没有导航拦截** |
| 主窗口 | — | `windows/MainWindow.ts` ✔ | `contextIsolation:true`、**`sandbox:false`**；CSP 允许 jsdelivr 脚本 |
| 全局导航拦截 | **无** ✔ | `src/main` 里没有 `will-navigate` / `will-redirect` / `web-contents-created` | — |
| Office 文档 | 无（只有「用系统查看器打开」） | — | — |

**差异**

| 能力 | 有无 | 位置 | 说明 |
|---|---|---|---|
| 源码管理 DiffViewer | 有，并排；编辑器内窄于 700 px 改行内 | `source-control/DiffViewer.tsx` | 可编辑保存，基线为进入编辑时的 `diff.modified`；失败有 toast（§5 实测） |
| 工具差异卡（Edit/Write） | 有，只读、统一视图 | `chat/toolDiff.ts`、`toolDiffView.ts` | 3 行上下文；旧×新行数超过 100 万时不做 LCS；运行中（参数流式）不算差异 |
| 会话「改动」面板 | 有，只读 | `workspace-shell/ReviewDiff.tsx` | 补丁 64 KB、新建文件 256 KB / 4000 行上限 |
| CRLF | 无显式处理 | `shared/textDiff.ts` | 聊天行差异只按 `\n` 切，`\r` 留在行内 |
| 文件末尾无换行 | 部分 | `shared/dshFileReview.ts` | 会话改动补丁里作为 meta 行；`toolDiff.ts` 丢弃该行 |
| 合并编辑器 | 有，三栏 | `worktree/MergeEditor.tsx` | 保存走 `WorktreeService.resolveConflict` ✔，**直接 `writeFile`、不带 expectedContent**（不在 #10 的 5 个入口里） |

**窗口**

| 能力 | 有无 | 位置 | 说明 |
|---|---|---|---|
| 多个主窗口 | 有（菜单「新建窗口」Ctrl+N） | `main/index.ts`、`MenuBuilder.ts` | 每个窗口各自一套 renderer store |
| 聊天事件跨窗口 | 有 | `main/ipc/chat.ts` | 运行时事件广播给所有窗口 |
| 编辑器标签 / 未保存内容跨窗口同步 | **无** | — | 只能靠各自的文件监听 |
| 设置跨窗口 | 共享文件，无广播 | `main/ipc/settings.ts` | — |
| 单实例锁 | 有 | `main/index.ts` | 第二个实例只聚焦已有窗口 |
| 窗口位置记忆 | 有，最小化 | `MainWindow.ts` | 关闭时保存，多窗口时最后关的生效；不检查显示器是否还在 |
| 缩放 | 有，按 webContents，不持久 | `MenuBuilder.ts` | — |
| DPI | 无显式处理 | — | 没有 `scaleFactor` / `display-metrics-changed` |
| 会话子窗口 | 窗口内浮层 | `chat/SessionSubwindows.tsx` | 不是 BrowserWindow |

## 9. 观察到、尚需按原始 PRD 定性的事项

原始 PRD 材料不在 Linux 上，下面只记事实，不自行补写验收规则：

1. ~~普通编辑器保存冲突没有任何提示~~ —— 用户 2026-10-30 定为 AC-39 范围内，已修复（DEF-007，handoff §10.10）。
2. **文件监听依赖文件树**：文件树没挂载时，打开的标签收不到外部改动，干净标签不自动重载、dirty 标签不出冲突横幅。
3. **权限与问题同时待答时只露出权限卡**，问题卡不在页面上（F03 pending）。
4. **失败回合的过程组全部展开**，结束回合默认收起（FAIL vs F01 ended）。
5. **未识别的失败**一律显示「本应用不认识这一轮的结束原因」，即使有服务方原话。
6. **中途中断的部分正文标为「最终输出」**，「引擎意外停止」提示排在这段正文上方。
7. F05 第二回合只有正文时，仍显示一个没有展开箭头的「已工作」标签。
8. 能力矩阵中的安全相关项：无全局导航拦截、预览窗无打开窗口处理、主窗口 `sandbox:false`、Mermaid SVG 未净化、合并编辑器保存不校验基线。

## 10. R1 其余条目（2026-10-30 晚）

做法：三路只读源码审计（FR-05、FR-02/11、FR-01/13，规则只用台账条款原文）→ 关键结论抽查源码 → 真实 Electron 复现（`tools/scroll-r1.mjs follow|small|anchor|isolate`、真实宿主中途被杀）→ 修复 → 自动测试 + 真实复测。审计结论与真实结果不一致时以真实结果为准（例：审计称宿主崩溃后 DSH 工具行停在「运行中」，真实 1.5 秒内即变「结果未知」）。

**已修复（真实 Electron 复测通过）**

| 条款 | 问题（修复前真实现象） | 修复 | 真实复测 |
|---|---|---|---|
| 11.1 / AC-18 | ↑ 一次（40 px）或滚动条上拖 30 px 后，下一段流式内容把读者拉回底部；只有滚轮能脱离 | `nextFollowState` 增加规则 0：内容高度与视口高度都没变而 scrollTop 变小 = 用户上移，停止跟随（浏览器夹紧必伴随高度变化，不会误判） | ↑ / 30 px / 60 px / 滚轮 / PageUp / 滚动条 300 px 均保持位置，漂移 0；「滚动到底部」恢复跟随（`results/scroll-small.json`、`scroll-follow.json`） |
| 11.3 / AC-19 | 读者停在中段时，回合结束自动收起上方过程组，正在读的段落上移 144 px | 新增 `readingAnchor.ts`：不跟随时记录阅读线处元素及祖先位置，非用户触发的布局变化后按位移补偿 scrollTop（只改 scrollTop，不形成 F10 循环；跳过唯一的粘性组头） | 内容下方增长、点击上方组、回合结束收起：锚点位移均为 0（`scroll-anchor.json`） |
| 13.6 / AC-22 | 被停止/失败/中断/截断的回合，最后一段半截正文仍标「最终输出」，可能带「完成于」 | `splitTurnWorkGroup` 增加 `endedAbnormally`；`ChatTurn` 以 `noFinalAnswer`（无回复结束、失败请求、失败状态、liveTurnEnd、用户结束、incomplete）同时控制「最终输出」与「完成于」 | 流式第 12 段杀宿主：无「最终输出」、无「完成于」，半截正文保留（`shots/r1-interrupted-no-final-label.png`） |
| 05.5 | 审批卡：编辑只显示路径（DSH）或只显示 `new_string`（Claude），看不到被替换内容与 `replace_all`；MCP/通用工具不显示参数；多行命令被截成一行 | 新增 `shared/permissions/approvalPreview.ts`，两套引擎的编辑与通用工具都带「参数」正文（JSON，4000 字上限）；命令改为完整换行显示、超高内部滚动 | DSH 编辑审批卡显示 `old_string`/`new_string`（`shots/r1-permission-edit-arguments.png`）；Claude 路径由单测覆盖（本机无 Claude 引擎） |
| 05.8 | 回复审批失败（IPC 抛错或 `handled:false`）时只把按钮解锁，无任何提示 | 审批卡复用问题卡的「无法发送你的回答，请重试。」 | 单测覆盖两种失败；真实环境未能制造该失败 |
| 11.4 | 工具输出框滚到头后继续滚动主时间线；框内向上滚轮会让时间线停止跟随 | 内部输出框加 `overscroll-contain`；滚轮只在真正滚动时间线时停止跟随 | 源码守卫测试；真实滚轮未专测 |
| 02.6 | 系统「减少动态效果」下箭头仍旋转动画、提示栏跳转仍平滑滚动 | 箭头 `motion-reduce:transition-none`；跳转按偏好选 auto/smooth | 源码守卫测试；加载转圈保留（它本身就是状态信号） |

**真实验证通过、无需改动**：02.1/AC-05（运行中思考可展开/收起，展开显示该组全部思考原文）；02.4（结束默认收起、历史确定）；11.2（回到底部恢复跟随，按钮仅在距底部 > 140 px 出现）；01.6（无整页横滚，§3 已测）；05.10 DSH 侧（宿主崩溃时运行中工具与待批工具均 1.5 秒内标「结果未知」）；AC-20 泄漏一半（B 不继承 A 的滚动与展开）。

**需要用户裁定（规则原文有歧义或与既有决定冲突）**

1. 11.6 / AC-20：从 B 切回 A 时，A 的阅读位置回到底部、手动展开的过程组恢复默认收起（工具行/思考行的展开会保留）。「不泄漏」满足；「工作单元内保持用户选择」是否要求跨会话切换保留，需裁定。
2. 02.5：「思考中」在工具结束后、首字节前也显示（2026-10-17 用户决定按 Claude Code 风格这样写），条款要求「无可靠信息只显示处理中」。是否改为「工作中」需裁定。
3. 05.2：DSH 的 bash/pwsh 行显示命令摘要而不是 `description`（2026-09-22 裁决）。
4. 05.3：工具输出无「查看全部 / 复制 / 搜索 / 导出」，stdout/stderr 不分开，只有限高与截断提示。属新功能，需确认范围。
5. 05.9 / 13.4：宿主崩溃按失败显示红卡，恢复后无「已恢复」标记；崩溃是否算「断线」应显示待同步，需裁定。
6. 13.2：渲染层在 `session_busy` 时自动重发最多 8 次（入场重试，不是模型请求重试），是否算「第二层自动重试」。
7. 01.5：长用户消息按估算行数折叠（约 223 px，非 300 px），窄栏/放大时估算偏小可能不折叠。

**未覆盖**：Claude SDK 引擎的真实运行（重开会话丢失中断标记——审计确认 `readTranscript` 丢弃 `[Request interrupted by user` 行且不设 incomplete，未修，需要 SDK 环境验证后再改）；触摸输入；IME/DPI；Windows。

## 11. Claude 引擎：中断历史与步骤式显示（2026-10-30 晚）

环境同上，另在 `src/claude-sdk-host` 里 `npm ci`（gitignore）；假网关换 `claude-sdk` 剧本：`P17D_GATEWAY_PLAN=claude-sdk node $GUI gateway-start`（p1-7d 工具新增的环境变量，默认仍是 `dsh-p0-2`）。fake-1 走 Anthropic 协议，新会话进 Agent SDK 引擎（日志 `new chat on the Claude Agent SDK engine`）。`CC-TEXT` 新增 `{"chunkMs":N}`，用来在回复流到一半时停止。

CLI 2.1.300 实测写入的记录（`~/.pilab/…/claude/projects/<cwd>/<id>.jsonl`）：

| 操作 | 记录 | 现场显示 |
|---|---|---|
| 命令运行中点停止 | 工具结果 `is_error`「The user doesn't want to proceed…」+ `[Request interrupted by user for tool use]` | 工具「已停止」，回合「这一轮已停止。」 |
| 审批卡待答时点停止 / 按 Esc | 同上 | 「已拒绝 · 自动：已中止 · 未执行」，「这一轮已停止。」 |
| 思考或回复中停止 | 只有 `[Request interrupted by user]` | 「这一轮已停止。」 |
| 审批卡「直接拒绝」 | 工具结果「The user declined this tool call.」，无标记，回合继续 | 「已拒绝」，正常完成 |
| 排队消息「立刻发送」 | 先 `queue-operation enqueue`，再 `[Request interrupted by user]`，再 dequeue 和用户消息 | 不标停止，正常完成 |
| 回合中插话（下一步送达） | `queued_command` 附件行（时间是排队时刻），无标记 | 插话开新回合，「用时 1 秒」 |

修复前重新打开：前两种的工具行显示英文原句像失败，没有「已停止」；停在思考中的那一轮什么都不显示；所有回合底部只有「N 次工具调用」，没有「完成于 / 用时」。修复后（`results/cc-reopen-after.txt`，修插话时间之前抓取；插话那一轮随后复测为「完成于 20:58 · 用时 1 秒」）与现场一致，例外见 handoff §10.15。

步骤式显示在 Claude 引擎上核对：三次读取合成「读取了 3 个文件」；两次写文件合成「修改了 2 个文件 +3 −0」；命令结果行「3 passed · 3 行」；失败首行可见。发现失败行露出 CLI 给模型看的 `<tool_use_error>` 标签，已去掉（现场和重开都去）。

## 12. R2 输入框（2026-10-30 晚）

工具 `tools/composer-r2.mjs`：`ime`（输入框、`/` 菜单、`@` 菜单里用输入法选词回车）、`mention`（`@` 菜单按键与路径）、`state`。按键与输入法事件都经 CDP `Input.*` 发出，由 Chromium 生成页面事件，与真实输入法一致到 isComposing / keyCode 229 / compositionend 这一层；真实微软拼音仍需 Windows。

修复前 `mention` 的结果（未存文件，原样记录）：Tab 后焦点离开、菜单仍开；Home 后回车无反应、菜单仍开；左移两格后回车得到 `see @src/main/entry.ts ry`；选 `My Docs/a-spaced.md` 得到 `@My Docs/a-spaced.md `；`@src\main` 无结果；`请看@中文`、`说明：@entry` 不触发；`mail a@entry` 不触发。修复后见 `results/r2-mention-after.json`：Tab 选中；Home 关闭菜单（随后的回车正常发送）；左移后选中替换整个词；空格路径写成 `@"My Docs/a-spaced.md"`；反斜杠能搜到。`results/r2-ime.json`：四处输入法回车均未发送、未选中菜单项。

R2 第二批（`results/r2b-unknown-cmd-refs.json`）：`r2b` 步骤依次测未知命令、三个引用（一个不存在）、CDP 真实拖放一个本地文件。第一次跑时拖放失败（「读取失败，已跳过」：Main 只读对话框给出的路径）且同时弹出「添加仓库」；两处修复后复测通过。重启提示用真实流程测：拖入附件、输入文字、退出并重启应用、打开同一对话。

