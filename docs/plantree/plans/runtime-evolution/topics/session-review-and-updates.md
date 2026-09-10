# 当前对话审阅栏与软件更新提醒

Role: implementation-plan。日期：2026-09-10。依据：用户两张参考图、允许两种 diff 展示二选一，并明确授权改代码。

## 本轮决定

- 采用右侧审阅栏，展示当前对话中每次成功 Edit / Write 的修改记录；同一文件多次修改保留多条记录。中栏继续保留工具摘要，不新增双栏 diff。
- 审阅与文件编辑器共用右侧空间，可切换、关闭、调整宽度；不销毁未保存的编辑器状态，不自动抢占聊天。
- native 工具在授权后、同一路径锁内记录修改前后差异，随工具结果写入会话历史；重载与切换对话按当前历史重建，不读取当前 Git 工作区来冒充历史。
- 新建与覆盖写入分别标记；失败/拒绝/仍在运行的操作不算已记录修改。旧历史只有参数时明确显示预览；不能还原的修改前内容不编造。
- 差异计算与记录有字节/行数预算；二进制、超预算、无法读取旧内容时保留修改记录及原因。工具成功不因可选预览不可用而变成失败。
- 本轮只做显示，不引入截图中的回退文件操作；Bash/外部编辑器的任意文件修改归因仍另立范围。
- 更新检查与自动下载/退出安装分开；关闭自动更新仍可收到新版本提醒。下载完成点击稍后后，保留再次打开的入口。主进程提供当前状态，重挂载不丢状态，设置页与提醒共用状态。
- Linux deb/rpm 保持现有禁用 electron-updater 的平台边界，手动检查给出明确说明。

## 参考采用

- PI-Desktop `apps/desktop/src/lib/workspace-review.ts`、`components/workpanel/ReviewTab.tsx`、`crates/host-core/src/review.rs` 与 `test/chat-review-entry.test.mjs`：适配消息归属、按操作记录、受限差异与历史恢复语义；不直接移植 Rust 存储/回退链。
- pix `packages/agent-runtime/test/session-history.test.ts`：采用历史投影保留工具差异的验证要求；沿用本仓 `piSessionTimeline`，不换载体。
- pi-app：约定的 `/home/ai/code/pi-app` 与本机 `/home/pi/code/pi-app` 均不存在；本轮不涉及 WorkerManager/会话树架构移植，以上用户指定参考与本仓现有源码承担实现依据。

## 执行清单

- [x] 核对上一轮提交、源码与现有 diff 基线：3 文件 / 24 测试通过。
- [x] R1：native Edit / Write 差异记录、实时投影与历史恢复。
- [x] R2：右侧审阅列表、会话隔离、文件入口与布局交互。
- [x] U1：更新状态、后台提醒、稍后重新打开与设置反馈。
- [x] V1：小批自动化、类型/格式检查、可执行的 GUI 验证及验收边界记录。

## 验证案例

1. 创建 test.txt 为 pong，再追加 abc：两条独立记录，新增与修改区分，增删行正确；当前文件随后被外部修改也不改变旧记录。
2. 覆盖写入、重复写入、多个 edit、失败/拒绝、二进制和超预算；旧内容读取失败不制造新增记录。
3. 工具结果经实时事件和保存/重载投影得到同样的记录；切换会话不串记录，重复水合不重复，历史分页可继续加载。
4. 审阅展开/收起、关闭重开、点击文件、切到编辑器、窄窗口和键盘操作；聊天继续可用。
5. 自动下载关闭仍检查；available → downloading → downloaded；稍后重开、失败重试、组件重挂载与不支持的平台。

实现与自动化通过不等于 Windows 安装版/加密机已验收。实际结果另记 evidence，并回写核心任务树与进度看板。

## 本轮落地与限制

- 本机验证：[证据](../evidence/session-review-and-updates/README.md)。基线 `80b7e3ab`；实现提交为 `6be1d70a`（R1/R2）与 `b919b1aa`（U1），含提交前评审修复，未打包；上述勾选指实现与本机门禁，不含安装版现场签收。
- native 记录默认启用，可通过 `AICLIENT_SESSION_REVIEW=0` 在 worker 关闭；对应 `ToolsConfig.recordFileChanges` 已验证关闭仍可写文件。UI 使用持久化 `showSessionReview`，默认只提供入口，不自动打开面板；旧 `showToolDiff` 字段退役。
- 每侧文本最多 256 KiB、合计 4000 行、LCS 中段最多 100 万单元、patch 最多 64 KiB；超预算保留记录与说明，不返回伪 diff。
- 此次按对话记录 Edit/Write，未新增文件回退与 Bash/外部修改归因。旧历史与 legacy runtime 缺执行快照时保留明确预览。
