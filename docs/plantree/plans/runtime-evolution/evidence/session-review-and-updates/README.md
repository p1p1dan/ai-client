# 对话审阅栏与软件更新提醒验证

日期：2026-09-10。基线提交：`80b7e3ab`；实现已提交为 `6be1d70a`（R1/R2）与 `b919b1aa`（U1），包含下文评审修复。范围：[R1 / R2 / U1 / V1](../../topics/session-review-and-updates.md)。

## 实现结果

- 右侧审阅按当前对话的成功操作列出 Edit / Write 差异，同一文件可有多条记录；与编辑器互切、主动打开、可关闭/展开/拖宽度，保留未保存的编辑器状态。
- native 写入前后内容由工具授权后、路径锁内读取和记录；结果的 `details.review` 随 JSONL 持久化，经实时事件及 `piSessionTimeline` 恢复到 renderer。外部后续编辑不改历史记录。
- 新建/修改区分，真实行位置与末尾换行变化保留；超预算/二进制/读取失败保留记录和原因。旧历史只有参数时标记预览。每条身份包含消息 ID，避免提供方跨消息复用 toolCallId 时丢记录。
- 默认在标题栏提供审阅入口，中栏只保留工具摘要与结果；常规设置控制入口显示，关闭后重新水合仍保持关闭，旧 `showToolDiff` 清理。
- 自动更新关闭只关闭自动下载/退出安装，后台仍检查提醒；Main 保存状态，renderer 共享订阅与快照，迟到快照不会覆盖新事件。下载后的“稍后”保留重开入口，错误可重试。

## 自动化与类型

7 个串行小批，**24 文件 / 364 测试通过，0 失败**；见 [tests.json](tests.json)，列出每批文件及计数。命令统一为：

```bash
NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/vitest run <该批文件> --maxWorkers=1 --no-file-parallelism
```

覆盖真实 native tools、JSONL 保存/重载、真实 worker 事件、renderer 重放/历史水合、调用 ID 重用、预算、审阅 DOM、更新服务/弹窗、设置迁移、相邻工具行/时间线与布局不变量。

以下三套门禁全部通过，均使用 `NODE_OPTIONS=--max-old-space-size=1536` 串行执行：

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p src/runtime/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json
```

改动源码的 Biome 检查与 `git diff --check` 通过；fixture/evidence 按仓库配置排除格式扫描。源码指纹及类型门禁见 [source-manifest.json](source-manifest.json)。已核对原生 GUI fixture 的变化，仅为 write 结果保留文本 content 并增加 review 差异。

## 隔离 Electron 交互

使用本仓 Electron 与 Vite 加载真实 `WorkspaceShell`、`SessionBar`、`SessionReviewPanel`、`UpdateNotification` 及 stores；聊天正文、左导航、Monaco 宿主、无关 hooks 与 Electron IPC 使用明确 fixture/stub。使用 Chromium 鼠标及 Esc 输入事件。

**18 项通过**：[browser-checks.json](browser-checks.json)。覆盖：展开/收起、1000px 窗口完整布局、审阅与文件互切保留编辑器值及挂载实例、切换对话隔离、切换 worktree 不误关审阅、更新下载状态、稍后/重开/Esc、遮罩删除、聊天恢复焦点、无用户重启点击时不请求安装。

截图：[亮色审阅](review-light.png) · [暗色审阅](review-dark.png) · [1000px 窗口](review-narrow.png) · [更新就绪](update-ready.png)。截图的聊天正文为探针夹具，不是在线模型输出。

最终探针源码：[browser-probe.tar.gz](browser-probe.tar.gz)。仅含五个测试文件，不含用户配置/依赖/缓存；固定使用本机仓库路径。复验时解压到 `/tmp/aiclient-review-probe`，为其 `node_modules` 链接本仓依赖，先运行 `node server.mjs`，再用本仓 Electron 运行 `electron.cjs`。探针仅使用临时 profile 和模拟 updater，不连接真实发布源、不执行安装。验证完成后停止服务并清理临时目录。

## 评审修复

提交前代码评审发现 5 项，均已修复并补测试：

- 后台检查失败（离线/更新源不可达）不再在右下角常驻“更新失败”；与改动前一致只在设置页显示。提醒只对已发现的版本显示下载失败并可重试。
- 外壳改为浅比较订阅审阅记录，审阅派生按消息缓存；流式文本增量不再重渲整个外壳，关闭审阅入口时不做派生。
- 展开状态下关闭审阅会一并收起，不再把全屏遮罩留给下面的编辑器。
- 修改前内容超限或为二进制时仍记为“修改”（读取已证明文件存在）；只有读取失败才记“未知”。
- 补齐审阅栏“打开文件”的中文翻译。

修复后复跑 12 文件 / 169 测试通过（见 [tests.json](tests.json) 的 `reviewFixRerun`），根目录与 runtime 两套 tsc 通过；agent-host 的类型范围不含改动文件，未重跑。[source-manifest.json](source-manifest.json) 已更新为修复后指纹。隔离 Electron 探针未重跑，上文 18 项结果对应修复前版本。

## 本地真实应用验证

2026-09-10，Linux 本机 `electron-vite dev` 拉起完整应用：`AICLIENT_RUNTIME_BACKEND=native`，模型 Claude Sonnet 5（cch 网关），独立 profile、临时凭据副本与临时 git 仓库，界面为中文，权限档「执行 · 每次询问」。经 CDP 驱动真实鼠标/键盘事件。首次需为 Electron 编译 `node-pty` 与 `sqlite3`（N-API，Node 下同样可加载）。

通过：
- 审阅栏：Write 新建 test.txt（A，`+pong`）、Edit 追加（M，` pong` / `+abc`）、3000 行 big.txt 改第 1500 行显示真实 hunk `@@ -1497,7 +1497,7 @@`（验证 `1f45531f`）；[截图](local-review-panel.png)。
- 外部追加文件内容后旧记录不变；重载界面从历史恢复同样 3 条、无重复；切到空会话显示 0 条，切回恢复。
- 从审阅记录打开文件进入真实 Monaco，内容为磁盘当前值；展开审阅后关闭，编辑器回到并排而非全屏（评审修复第 3 项）。
- 拒绝的写入不生成文件、不进审阅记录；设置关闭审阅入口后标题栏入口消失，重开恢复计数。
- Linux 设置页显示用系统包管理器更新，检查按钮禁用。F7f 输入框 8 行（192px）后滚动。
- 权限卡倒计时（补 `baeff487` 后）：「若 N 秒内未响应将自动拒绝」逐秒递减，归零后卡片变为 Denied、文件未创建；[截图](local-permission-countdown.png)。进行中轮次的过程不再在两条消息之间提前折叠（`ca6aac0f`）。

发现并待定：
- F7b 仍复现：运行与等待确认时，时间线末尾与输入框上方各一份状态；[截图](local-f7b-duplicate.png)。用户选保留输入框上方，`225c325e` 修复后含授权等待在内全程 19 次采样均为单份。
- 「已处理」耗时取最后一条消息，多段折叠显示同一数值；历史轮次不折叠。用户定为只显示「已处理 N 个步骤」，`225c325e` 后重载的历史轮次同样折叠。
- 强制结束应用后 `.writer.lock` 残留，重开该会话报 `session_locked`、历史读不出；锁内记录的进程已不存在也不放行。已登记到任务树，待修。
- 中文界面下仍有英文：权限卡 Permission / allow / allow for session / deny / Content / Awaiting approval、时间线 Thought / Grepped / Ran / Edited / Read / Editing、输入框占位与排队提示、侧栏 new / branches、模型按钮 aria-label。
- 重载界面后启动公告再次弹出，并新开一个空会话（`--open-path` 启动参数所致，未单独排查）。
- trace 不记录推理强度，EFFORT-1 默认 medium 未能从本次运行核对，仍以单元测试为准。

## 安装版现场待验

- Windows 安装版与加密机的 native Edit/Write、覆盖写入与重启恢复；本机记录链验证不代替加密现场。
- 真正 Monaco 文件打开/保存、实际工作区切换与连续长对话；浏览器探针只验证壳保留编辑器宿主，不代签完整编辑器链。
- 真实发布源的版本发现、网络失败、下载进度与重启安装；IPC 模拟结果不等于真实安装成功。2026-09-10 用户决定暂缓此项验证。
- Linux deb/rpm 继续通过系统包管理器/新安装包更新；保持原有 updater 禁用边界。

未实施文件回退、Bash 或外部编辑的任意修改归因；旧历史不补造执行快照。未创建新版本、未推送、未运行本地完整生产构建或 CI 打包。
