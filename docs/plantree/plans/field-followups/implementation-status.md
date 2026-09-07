# Implementation Status — 现场反馈待办 6–11

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**六项（F06–F11）全部实现，自动化门禁通过；GUI 点验与三项联调均未验证，
因此没有一项是 Done。**
证据见 [批次一](./evidence/batch1-f07-f11-f06.md) · [批次二](./evidence/batch2-f08.md) ·
[批次三](./evidence/batch3-f09.md) · [批次四](./evidence/batch4-f10.md)。
下一步是收敛验证：一次累计 GUI 点验，加上三项联调。

## Active TODO（最多五项）

1. 累计 GUI 点验（并入 UI 对齐计划）：冷启动模型名、矮窗口 `@` 弹层、流式 `↓`、
   铃铛与启动弹窗、顶部「...」确已消失、周限额瓦片与超限配色。
2. F08 联调：捕获真实出站请求头，确认 `User-Agent: claude-cli-pilab/<版本>` 生效。
3. F09 联调：onboard 部署 `/api/v1/announcements` 后核对字段与真实启动弹窗。
4. F10 联调已完成（用真实 cch key 实测 `getMyQuota`，端到端到卡片文案）；
   剩 F09 的真实部署联调。
5. 上述完成后才逐项标 Done 并合入主分支。

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

**2026-09-07 · 批次四 F10：**

- 新增 15 项通过（shared 纯函数 11、真实渲染 4），UsageService 既有测试改 2 增 2 后 20 项通过。
- shared / usage / user / workspace-shell / settings / ipc 六个目录 60 文件 775 项通过。
- 整套 `tsc --noEmit` 通过；全仓 `biome check` 996 文件 0 error。
- **未接真实 `getMyWeeklyQuota`，未跑真实 Electron。**

**2026-09-07 · 全仓收敛回归（六项落地后）：**

| 范围 | 结果 |
|---|---|
| `src/renderer` | 179 文件 / 3091 项**全部通过** |
| `src/main/services` | 54 文件 / 662 项，**3 失败**：`PiTuiPty`（node-pty 原生模块缺失）与 `SessionManager` 两项 |
| `src/shared` · `src/preload` · `src/agent-host` · `src/main/__tests__` · `src/main/ipc` | 57 文件 / 643 项，**2 失败**：`permissionPolicyIntegration`、`permissionPatchScript` |
| 整套 `tsc --noEmit`（堆 1200 MiB） | 通过 |
| 全仓 `biome check` | 996 文件，**0 error**；保留既有 27 warning / 17 info |

五个失败文件全部是[设置清单计划已记录的四个环境相关失败](../settings-cleanup/implementation-status.md)
（未安装的独立 Agent Host 包与 node-pty 原生模块）。`SessionManager` 的两项已用 `git stash`
在不含本轮改动的工作区复跑确认同样失败，与本轮无关。

本轮唯一一处**由本轮引起**的测试失败已修复：`vaultIntegration.test.ts` 的 electron mock
缺 `app.getVersion`（F08 新读了它）。补上 mock 的同时，在这个「凭据不得进入 worker 环境」
的边界测试里补一条断言：新增的 `AICLIENT_PI_USER_AGENT` 只带版本号，不带任何凭据。

未运行整套生产构建，未启动 Electron GUI。

## 与其他计划的关系

- GUI 点验并入 [pix/pi-app UI 对齐](../pix-ui-alignment/README.md) 的累计点验。
- 所有改动只落新壳；[设置清单整理](../settings-cleanup/README.md) 删掉的旧壳入口不复活。
- F08 不触碰 WorkerManager 的进程模型（Pi-only D15 边界）。
