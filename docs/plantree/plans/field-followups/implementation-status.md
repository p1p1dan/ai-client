# Implementation Status — 现场反馈待办 6–11

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**批次一（F07 / F11 / F06）已实现，自动化门禁通过；GUI 点验未做，因此三项都还不是 Done。**
实现细节与执行过的命令见 [批次一证据](./evidence/batch1-f07-f11-f06.md)。
下一步进入批次二 F08。

## Active TODO（最多五项）

1. 批次一并入 UI 对齐计划的累计点验：冷启动模型名、矮窗口 `@` 弹层、流式 `↓`。
2. F08：`AICLIENT_PI_USER_AGENT` 注入 Worker/PTY 环境，`toPiModelsJson` 补 provider headers。
3. F09：先定铃铛放置位置（`WindowTitleBar` 在 macOS 上整体不渲染），再做 Main 服务与弹窗。
4. F10：usage 类型扩展与周限额显示；顺手把 `UserProfileCard` 的四处硬编码中文改走 `t()`。
5. F09 / F10 的联调段等 onboard 接口就绪，就绪前不标完成。

## Blocker

无代码层阻塞。两项外部依赖：

- F09 的公告接口与 F10 的周限额接口都由 onboard 提供，尚未部署。
  两项的**契约段**可以先做完，**联调段**在接口就绪前不能标完成。
- F09 的铃铛放置位置需先定：`WindowTitleBar` 在 macOS 上整体不渲染，
  只把铃铛塞进这条 bar 会让 macOS 没有公告入口。

## Last verified

**2026-09-07 · 批次一 F07 / F11 / F06：**

- `src/renderer/components/chat/__tests__` 78 个文件 / 1757 项通过（含本轮新增 25 项）。
- workspace-shell / App / hooks 三个目录 35 个文件 / 507 项通过。
- 整套 `tsc --noEmit` 通过，堆上限 1200 MiB。前一计划记录的 896 MiB 会 OOM，本轮据此上调；
  本机实际约 1.9 GiB RAM，检查串行执行。
- 全仓 `biome check` 983 个文件、0 error；保留既有 27 warning / 17 info。
- **未运行整套生产构建，未启动 Electron GUI。** 三项改的都是屏幕上的东西，
  自动化只能证明纯函数与措辞；未验证项逐条列在证据文件末尾。

## 与其他计划的关系

- GUI 点验并入 [pix/pi-app UI 对齐](../pix-ui-alignment/README.md) 的累计点验。
- 所有改动只落新壳；[设置清单整理](../settings-cleanup/README.md) 删掉的旧壳入口不复活。
- F08 不触碰 WorkerManager 的进程模型（Pi-only D15 边界）。
