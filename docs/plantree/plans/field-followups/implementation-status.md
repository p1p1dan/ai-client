# Implementation Status — 现场反馈待办 6–11

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**批次一（F07 / F11 / F06）、批次二（F08）与批次三（F09）已实现，自动化门禁通过；
GUI 点验、真实 HTTP 请求头与公告接口联调均未验证，因此五项都还不是 Done。**
证据见 [批次一](./evidence/batch1-f07-f11-f06.md) · [批次二](./evidence/batch2-f08.md) ·
[批次三](./evidence/batch3-f09.md)。下一步进入批次四 F10。

## Active TODO（最多五项）

1. 批次一并入 UI 对齐计划的累计点验：冷启动模型名、矮窗口 `@` 弹层、流式 `↓`。
2. F08 的联调段：捕获真实出站请求头，确认 `User-Agent: claude-cli-pilab/<版本>` 生效。
3. F09 的联调段：onboard 部署 `/api/v1/announcements` 后核对字段与真实启动弹窗。
4. F10：usage 类型扩展与周限额显示；顺手把 `UserProfileCard` 的四处硬编码中文改走 `t()`。
5. 全部实现完成后再做一次累计 GUI 点验，届时才谈 Done。

## Blocker

无代码层阻塞。外部依赖：

- F09 的公告接口与 F10 的周限额接口都由 onboard 提供，尚未部署。
  两项的**契约段**可以先做完，**联调段**在接口就绪前不能标完成。
- F09 的铃铛位置与接口鉴权已由用户 2026-09-07 裁定，不再是阻塞项；结论记在
  [roadmap](./roadmap.md) 的 F09 条目与[批次三证据](./evidence/batch3-f09.md)。

## Last verified

**2026-09-07 · 批次一 F07 / F11 / F06：**

- `src/renderer/components/chat/__tests__` 78 个文件 / 1757 项通过（含本轮新增 25 项）。
- workspace-shell / App / hooks 三个目录 35 个文件 / 507 项通过。
- 整套 `tsc --noEmit` 通过，堆上限 1200 MiB。前一计划记录的 896 MiB 会 OOM，本轮据此上调；
  本机实际约 1.9 GiB RAM，检查串行执行。
- 全仓 `biome check` 983 个文件、0 error；保留既有 27 warning / 17 info。
- **未运行整套生产构建，未启动 Electron GUI。** 三项改的都是屏幕上的东西，
  自动化只能证明纯函数与措辞；未验证项逐条列在证据文件末尾。

**2026-09-07 · 批次二 F08：**

- `piModelConfig` 两个测试文件 40 项通过（本轮新增 8 项）。
- agent-host / terminal / ipc 三个目录 27 文件 286 项通过；
  `PiTuiPty.test.ts` 因 `node-pty` 原生模块缺失而加载失败——与本改动无关，
  是设置清单计划已记录的四个环境相关失败之一。
- 整套 `tsc --noEmit` 通过；全仓 `biome check` 0 error。
- **未捕获真实出站 HTTP 请求头。** 本轮证明的是配置链路（`models.json` 有引用、环境有值），
  最终的头由 pi 自己拼装。

**2026-09-07 · 批次三 F09：**

- 新增三个测试文件共 31 项通过（shared 契约 14、Main 服务 10、renderer 接线与旧菜单缺席 7），
  另在登出序列测试补 1 项断言 ⑥b 的位置。
- workspace-shell / App / ipc / settings / shared 五个目录 59 文件 766 项通过；
  main / shared-types / stores 三个目录 32 文件 394 项通过。
- 整套 `tsc --noEmit` 通过；全仓 `biome check` 993 文件 0 error。
- **未跑真实 Electron，未接真实公告接口。** 本轮完成的是客户端契约段。

## 与其他计划的关系

- GUI 点验并入 [pix/pi-app UI 对齐](../pix-ui-alignment/README.md) 的累计点验。
- 所有改动只落新壳；[设置清单整理](../settings-cleanup/README.md) 删掉的旧壳入口不复活。
- F08 不触碰 WorkerManager 的进程模型（Pi-only D15 边界）。
