# 左侧 Chat 栏对齐 PI-Desktop

Role: implementation-plan。日期：2026-09-10。依据：用户 2026-09-10 指定参考 `/home/ai/code/PI-Desktop`（v0.14.6，HEAD `ea6b9936`）的 `apps/desktop/src/components/Sidebar.tsx`。

## 参考实测（纠正一处口径）

用户表述为「会话（临时）的 tab，和项目文件夹 tab」。实际 PI-Desktop **不是两个可切换的 tab，是上下堆叠的两个分区**：上面 `sidebar-standalone-sessions`（独立/临时会话，`data-sidebar-session-section="temporary"`），下面 `nav.projects` 项目分组，同屏都可见。用户 2026-09-10 已确认按上下两分区做。

## 现状与缺口

本仓 `LeftNav.tsx` 已有：临时会话分组（`UNBOUND_FOLDER_ID`）、项目分组、会话行右键菜单（重命名/结束/归档）、每行状态字段（`busy`/`failed`/`status`，含运行中圆点）。`sidebarTree.ts` 的 `SessionRuntimeStatus` 有 9 态，比 PI-Desktop 侧栏的 5 态更细。

已确认**不需要新做**的两条：

- **多工作目录会话并行**本就支持（会话按 sessionId 分桶，并发权限卡不塌成单槽，`chatSessions.ts:250-262`）。
- **VSCode 式图标列**已存在（`LeftDock.tsx` 的常驻 44px rail），无需新建。

缺口：分区级右键菜单、项目行的右键菜单（现为「更多」按钮下拉，非右键唤出）、「有未读结果」的完成/失败徽标、收起按钮位置。

## 本轮决定

- 采用上下两分区，不做左右切换 tab。
- 收起按钮从面板标题行 `DockTitle`（`LeftDock.tsx:298-317`）移入常驻图标列。rail 是永久的，收起只隐藏面板不隐藏列，按钮放在 rail 上才与「收起后仍可一键切换」的现有设计自洽。
- 右键菜单动作以本仓已有能力为准，不照搬 PI-Desktop 全部 17 个动作。它有而我们没有对应能力的（pin、archive 显隐、fork、copy conversation id）本轮不新增能力，只在已有能力上补右键入口。
- 状态徽标沿用本仓 9 态枚举，不降级成 PI-Desktop 的 5 态。新增的只是「未读完成/失败」这一层展示。

## 执行清单

全部实现完成并已在真实应用点验（2026-09-10），[验证记录](../evidence/sidebar-pi-desktop-alignment/README.md)。未打包。

- [x] S1：分区级右键菜单。临时会话分区 → 新建临时会话；项目分区 → 打开项目。
- [x] S2：项目行右键菜单。把现有「更多」下拉的动作（仓库设置、移出）改为同时支持右键唤出，保留原按钮。
- [x] S3：未读完成/失败徽标。打开对话即视为已读，读后不再显示。
- [x] S4：收起按钮移入 rail，保留 Ctrl+B 快捷键与无障碍标签。
- [x] S5：自动化验证完成；本机真实应用点验未做。

### 落地时的两项调整

1. **S4 的按钮从「只关」改成「开关」**。计划只说移入 rail。但 rail 比面板活得久，只能关的按钮在面板已收起时就是死的——而那正是 rail 单独在屏幕上的时候。改后与 Ctrl+B 共用同一个 store action，图标与标签随状态切换。
2. **S3 的徽标复用会话行已有的 6px 标记槽**，不新开一个。行宽本来就紧张，多一个点会挤掉标题；三态按 `busy → unread → started` 排序，共享槽位不丢信息（跑着的会话不会同时握着未读结果，未读的会话必然是 started）。
3. **多修了一处 Esc**。点验发现：侧栏右键菜单开着时按 Esc，面板整个收起、菜单反而留着。验证案例 2 要求「Esc 关闭」，所以这属于本轮验收缺口。`shouldCloseOnEscape` 增加 `popupOpen` 判据，弹层开着时面板既不关也不 `stopPropagation`。详见[验证记录](../evidence/sidebar-pi-desktop-alignment/README.md#点验查出并修掉的缺陷esc-收走了整个面板)。

## 验证案例

1. 在两个分区的空白处和标题栏分别右键，各自弹出对应菜单；在会话行/项目行上右键弹的是行菜单而不是分区菜单。
2. 项目行右键与「更多」按钮给出同一组动作；键盘可达，Esc 关闭。
3. 一个会话在后台跑完/失败后出现徽标，点进去后徽标消失；切换工作目录不串。
4. 两个工作目录下的会话同时运行，各自的运行状态互不影响。
5. 收起按钮在 rail 上可点，收起后 rail 仍在、五个入口仍可一键切换；Ctrl+B 行为不变。

## 范围外

不引入 pin、归档显隐切换、fork 会话、复制会话 ID 等本仓尚无对应能力的动作。不改会话排序模型。
