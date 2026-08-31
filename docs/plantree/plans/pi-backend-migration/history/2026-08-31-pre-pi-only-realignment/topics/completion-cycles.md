# Topic — Pi 后端功能补齐与上线周期

> 状态：**已拍板；Cycle 1/2 已完成，下一目标 Cycle 3**。
> 拍板时间：2026-08-30。
> 目标：把现有 Partial / Pending / Deferred 全部排入连续周期，完成后 Phase 1～5 全部 Done，随后上线实测。

## 1. 总周期与并行方式

| 周期 | 预计工作日 | 主目标 | 出口 |
|---|---:|---|---|
| Cycle 1 | 3 | 关闭虚假 Deferred，收口权限策略 | T14/T15 Done；Q10 技术取证完成；T08-c Done |
| Cycle 2 | 4 | 内联审批、Extension UI、模型菜单 | T08-b/T09/T10/T17/T25 Done；Q11 关闭 |
| Cycle 3 | 5～6 | Pi 历史、真实恢复、fork/rewind | T13 剩余切片 Done |
| Cycle 4 | 3～4 | GUI/TUI 切换与模式持久化 | T16/T17/T18 Done |
| Cycle 5 | 2 | Release Candidate 与上线实测 | 全量门禁、真机矩阵和内部发布通过 |

- 多工作流并行：计划约 **15 个工作日**，乐观 12 日，风险上限 18 日。
- 完全串行：约 20～24 个工作日。
- Cycle 3 与 Cycle 4 后半段可并行；Cycle 5 必须等待所有功能周期完成。
- 每周期都必须独立通过 scoped tests、主仓/Agent Host typecheck、Biome 与 `git diff --check`；涉及 Agent Host、权限插件、打包资源时追加对应 build/smoke。

## 2. 已拍板产品边界

1. 全部 Partial / Pending / Deferred 纳入本轮，不再保留笼统“以后再做”。
2. T13 做历史浏览、真实 resume、fork/rewind；**不做永久删除**，不编辑或截断 Pi JSONL。
3. T16 首版为“同 workspace、同配置的新 Pi TUI 进程”，不宣称无损接管 GUI 内存会话。
4. 后台会话审批只在所属会话显示；左侧会话行显示待审批徽标，不用全局 modal 打断当前会话。
5. `~/.pilab/*` 产品语义从 deny 改为 ask；仍须先完成 Q10 根因取证，不能用策略改判掩盖错误匹配。
6. 模型允许多标签，首标签为主分组；其余标签用于搜索/筛选，菜单不重复显示同一模型。
7. 模型 effort 直接从 `reasoning` / `thinkingLevelMap` 派生；切模型后旧值非法时回到 Automatic/模型默认。

## 3. Cycle 1 — 快速收口与权限策略

### T14 消息队列（主体已有，验收收口）

- 真 Pi 长回合连续排入三条消息，验证严格 FIFO。
- 验证附件、队列消息编辑、删除和位置交换。
- Stop 后解冻；Host 拒绝时不循环重发、不丢消息。
- 切会话、Archive、仓库移除时验证暂停与 prune。
- 明确“仅内存、不跨应用重启”是首版产品口径。

### T15 工作区文件预览（主体已有，安全/打包收口）

- 补文本、Markdown、图片、PDF、二进制空态覆盖。
- 验证多 tab、工作区切换、行级定位、脏文件关闭确认。
- 验证 Markdown 相对图片不越 workspace，危险 scheme 被拒。
- 大文件、大图、PDF 的内存与失败恢复 smoke。
- 打包验证 `local-file://`、Monaco worker 与 PDF worker。

### T08-c / Q10 权限策略

- 采集仓库内相对/绝对 read、仓库外 read、`.env`、`.pilab` 的完整 activity。
- 核对 `surface/value/origin/matchedPattern`、cwd、symlink、配置加载与 gate 短路顺序。
- 给真实插件补 path → external_directory → tool 集成矩阵。
- 修复实际匹配、cwd 或配置加载问题。
- 将 `.pilab` 正式落为 ask；同步 D11、随包策略和设置页文案。
- 验证 dev 与打包产物策略一致。

### Cycle 1 执行快照（2026-08-30）

- **T08-c/Q10：Done。** 根因是上游 27.0.1 未把 extension-root config 的 `permission`
  送入 PermissionManager；已增加真实 `bundled` scope、fail-closed、activity surface 修正与
  `.pilab` ask，dev/真实 resolver/Agent Host 产物 smoke 通过。
- **T14：自动收口完成。** FIFO 越队、交换、拒绝恢复、lifecycle prune 竞态已修；
  PiRuntime 长 turn + 三条队列 + 附件测试通过。真账号 GUI 复点仍需交互环境。
- **T15：实现/自动收口完成。** realpath 安全、bounded read、scheme policy、资源预算、
  恢复、本地 PDF worker 与多 tab/batch close 已落。完整 packaged renderer smoke 留给
  CI/高资源主机；当前 3.3 GiB 主机禁止继续硬跑整套 build。
- 证据与精确门禁见 [Cycle 1 执行证据](../../../evidence/2026-08-30-cycle1-execution.md)。

## 4. Cycle 2 — 权限 UI、扩展能力与模型体验

### T08-b 内联审批

- 从 `ExtensionUiDialog` 抽出容器无关的审批内容。
- 在时间线与 Composer 邻近区域新增内联 approval dock/card，移除窗口遮罩和 modal focus trap。
- 保持 Yes、session allow、No、带原因 No 的现有 bridge/store 协议。
- 请求按 session 展示；后台会话在左侧显示待处理徽标。
- 保留 FIFO、keyed remount、发送中禁用、失败重试、Stop/超时/销毁清理。
- 真机验证 read/edit/bash 的批准、拒绝与 activity 轨迹。

### T10 能力分层

- 建立 Portable / Semantic no-op / TUI-only 单一能力表。
- 将 fire-and-forget 状态与阻断 dialog FIFO 分开。
- `unsupported` 保存 method、session、runtime、首次时间与次数，并按 runtime 去重。
- Semantic no-op 不弹错误；未知未来 API 安全降级为 TUI-only。
- reload/dispose 与旧 runtime 事件不得污染新会话。

### T09 notify / setStatus / setWidget

- `notify`：活动窗口 toast；窗口失焦时 warning/error 可发 OS notification，避免重复提醒。
- `setStatus`：按 session+key 显示紧凑 chips，支持覆盖和删除。
- `setWidget`：仅接受纯文本 `string[]`，支持 Composer 上/下方，同 key 替换和删除。
- 增加数量、单行长度和总字节上限，防止刷屏与注入。
- 过滤插件 legacy config 路径的误导性迁移通知。

### T17 第一切片

- 消费 T10 unsupported，显示非阻断“GUI 不支持、可在 TUI 使用”提示。
- 同 method/runtime 聚合，跨会话隔离。
- Cycle 4 再接入真实“切换到 TUI”动作。

### T25 标签模型菜单与模型级 effort

- `models.json` schema 增加 `tags: string[]`，旧配置继续可读。
- `AgentModelOption` 透传 tags、reasoning、thinkingLevelMap。
- 首标签为主分组；其余标签用于搜索/筛选；无标签进入“其他模型”。
- 标签顺序优先采用云端/配置顺序，否则保持稳定首次出现顺序。
- 菜单改为标签分组子菜单，当前模型可定位。
- 仅显示模型声明支持的 effort；非法旧值回到 Automatic/模型默认。
- UI、session/template 与 wire 的最终值必须一致。

### Cycle 2 执行快照（2026-08-31）

- **T08-b：Done。** 窗口级 modal 退役为 session-local 内联 dock；后台会话仅显示待审批徽标；四种权限答案、FIFO、ACK/重试与 Stop/timeout/close 清理保持。
- **T10：Done。** shared 单一能力表、独立 display store、`extensionUi.reset` 与 Main blocking-only request 路由落地；未知 API 安全降级 TUI-only。
- **T09：Done。** notify toast/OS notification、status chips、Composer 上/下纯文本 widget，数量/长度/总 bytes 限额与 legacy permission 提醒过滤完成。
- **T17 第一切片：Done。** unsupported 按 session/runtime/method 聚合显示非阻断 TUI 提示；真实切换动作仍依赖 Cycle 4 T16。
- **T25：Done。** tags/reasoning/thinkingLevelMap 全链透传；首标签单归组、次标签搜索、无标签兜底；模型级 effort 过滤与非法旧值同步降级完成。
- 自动门禁、CDP 数字与截图见 [Cycle 2 执行证据](../../../evidence/2026-08-31-cycle2-execution.md)。

## 5. Cycle 3 — T13 Pi 历史与分支

> **参考优先**：主体不是从零研发。先按 [参考仓库地图](reference-repositories.md) 移植 pi-app 的 `session-jsonl-timeline`、`timeline-incomplete`、迭代 session tree、leaf override、navigate/fork 和竞态测试，再适配本仓 Agent Host / RuntimeEvent / store 生命周期。正常估时由 5～6 日修正为 **4～5 日**；SDK/API 差异才使用原风险上限。

1. 用 Pi `SessionManager.list/open/getBranch` 实现 history reader。
2. 投影 session summary、message、thinking、tool/custom，并稳定保留 Pi `entryId`。
3. 修正真实 resume：按 `runtimeIdentity` 调用 `SessionManager.open()`，发射 `session.resumed → session.history → idle`。
4. 对不存在、损坏、跨 cwd 的会话给出可诊断错误，禁止覆盖原文件。
5. 新增 session tree 查询协议：parent/child、当前 leaf、可操作用户消息。
6. 提供只读历史树和分支浏览 UI。
7. rewind 仅允许 idle，调用 Pi 原生 tree navigation；旧分支仍可浏览和切回。
8. fork 创建独立 Pi session 文件、新应用会话行和 runtimeIdentity；源会话保持不变。
9. 消息操作条增加“从此处分叉”“回退到这里”；回退确认明确说明不会删除后续分支。
10. fork/rewind 时处理 Extension UI、queue、pending、runtime facts，禁止跨会话串流。
11. 覆盖重启、坏文件、重复点击、切会话竞态和跨 workspace。

**硬验收**：A→B→C，rewind 到 A 后发送 D，B/C 与 D 两分支同时保留且可切回；从 A fork 后源会话不变，新会话可独立继续。

## 6. Cycle 4 — GUI/TUI 切换

> **pix 是主参考，不是从零做**：优先移植/适配 `PiTuiPtyController`、`PiTuiExclusiveGuard`、`planPiTuiLaunch`、CLI 提取/asar 资源与 terminal E2E；renderer 保留本仓 xterm/AgentTerminal。精确路径见 [参考仓库地图](reference-repositories.md)。

### T16

- 增加 `presentationMode: gui | tui` 和切换入口。
- 使用随包 Node + Pi CLI 绝对路径启动，不依赖系统 PATH。
- 注入当前 cwd、登录模式 `PI_CODING_AGENT_DIR` 和模型配置。
- 复用 xterm/AgentTerminal，PTY metadata 明确标记 Pi TUI。
- GUI→TUI 启动同配置新进程；UI 明确说明不是当前 GUI 对话的无损接管。
- TUI→GUI 时安全终止或 detach PTY，禁止两个运行时并发写同一会话。
- 处理重复切换、PTY 崩溃、Stop、窗口关闭、仓库移除、登录失效。
- 验证 Windows/Linux/macOS 路径及打包资源。

### T17 第二切片

- unsupported 提示接入“切换到 TUI”。
- TUI 不可用时禁用按钮并显示真实原因。

### T18

- 持久化全局默认模式；首版不让历史会话启动时自动 spawn PTY。
- `settings.json` 为权威，localStorage mirror 防首帧闪烁。
- 非法/旧值回落 GUI。
- TUI 启动失败自动回 GUI，并显示可恢复原因。

## 7. Cycle 5 — Release Candidate

### 自动门禁

- 完整 Vitest；主仓和 Agent Host typecheck；Biome；`git diff --check`。
- Agent Host build、权限插件 smoke、可行平台 Electron build。
- roadmap/implementation-status/decision/open-question 与本文件链接一致性。

### 真机矩阵

1. 本地模式与登录模式。
2. 无仓库 → 添加 → 移除 → 重加。
3. read/edit/bash/`.env`/`.pilab`。
4. 活动会话与后台会话审批。
5. pending、queue、retry、Stop。
6. 标签模型菜单、切模型、effort 降级。
7. 文本、Markdown、图片、PDF 预览。
8. 三回合历史、重启恢复、rewind、fork。
9. GUI→TUI→GUI、PTY 崩溃和失败回退。
10. 亮/暗主题、鼠标和键盘。

### 上线

- 先发内部/测试版本，用真实账号和受管配置运行 1～2 天。
- 数据损坏、权限绕过、会话串流、启动失败为发布阻塞；阻塞问题修复并复验后再扩大范围。
